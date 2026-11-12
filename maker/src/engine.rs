//! The maker's loop: each pass reads the new orders that snapshotted it, then, for every order in play, reads the
//! facts, decides ([`decide`]) and does that one step. A proof runs in a task of its own, one at a time, so a pass
//! never waits for it. Every step that sends something writes its record first.

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use alloy::{
    primitives::{Address, B256},
    providers::DynProvider,
};
use anyhow::{Context, Result, anyhow};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::{
    book::{Book, MakerStatus, OrderRecord, private_dir},
    decide::{DeskOrder, Facts, ProverState, Side, Step, Timing, decide},
    desk::{Desk, Handles},
    fhe::Fhe,
    handoff::order_dir,
    mask::amount_mask,
    pricing::Pricing,
    seam::{SealFile, Seam, WitnessJob},
};

/// The prover: which order it proves now, and how each finished proof ended (true: a seal is written).
#[derive(Default)]
pub struct ProverSlot {
    pub running: Option<B256>,
    pub finished: HashMap<B256, bool>,
}

pub struct Engine<F> {
    pub desk: Arc<Desk<DynProvider>>,
    pub fhe: Arc<F>,
    pub seam: Arc<Seam>,
    pub book: Arc<Mutex<Book>>,
    pub book_path: PathBuf,
    pub orders_dir: PathBuf,
    pub pricing: Pricing,
    pub timing: Timing,
    pub zec_inventory_zat: u64,
    pub operator_days: u64,
    /// Whether this host proves (`seam seal`); without it the maker does everything else and leaves the proof to the
    /// user or to a host with a GPU.
    pub prove: bool,
    pub resolve_timeout: u64,
    /// The desk's MIN_WORK: the Zcash work a proof's anchor must carry.
    pub min_work: alloy::primitives::U256,
    pub poll: Duration,
    pub prover: Arc<Mutex<ProverSlot>>,
}

/// Reading logs over a wide range at once is refused by many RPC providers.
const LOG_CHUNK: u64 = 2_000;
/// Blocks behind the head that new orders are read up to.
const LOG_LAG: u64 = 4;
/// Seconds before a payment that failed to build is tried again.
const PAY_RETRY_SECS: u64 = 120;

impl<F: Fhe + Send + Sync + 'static> Engine<F> {
    pub async fn run(self: Arc<Self>) -> Result<()> {
        loop {
            if let Err(e) = self.pass().await {
                warn!("pass failed: {e:#}");
            }
            tokio::time::sleep(self.poll).await;
        }
    }

    async fn save(&self, book: &Book) -> Result<()> {
        book.save(&self.book_path)
    }

    pub async fn pass(&self) -> Result<()> {
        let (block, now) = self.desk.latest().await?;
        // New orders are read a few blocks behind the head: a load-balanced RPC answers logs from nodes that can lag
        // the one that told the head. A failed read is retried next pass; the orders in play still move on.
        if let Err(e) = self.read_new_orders(block.saturating_sub(LOG_LAG)).await {
            warn!("reading new orders failed: {e:#}");
        }
        let relay_tip = self.desk.relay_tip().await?;
        let ids: Vec<B256> = self.book.lock().await.active().map(|r| r.order_id).collect();
        for id in ids {
            if let Err(e) = self.step(id, block, now, relay_tip).await {
                warn!(order = %id, "step failed: {e:#}");
            }
        }
        Ok(())
    }

    async fn read_new_orders(&self, head: u64) -> Result<()> {
        let mut from = self.book.lock().await.last_block + 1;
        while from <= head {
            let to = head.min(from + LOG_CHUNK - 1);
            let opened = self.desk.opened(from, to).await?;
            let mut book = self.book.lock().await;
            for o in opened {
                book.orders.entry(o.order_id).or_insert_with(|| {
                    info!(order = %o.order_id, side = ?o.side, "new order");
                    OrderRecord::new(o.order_id, o.side, o.user, o.payment_ref)
                });
            }
            book.last_block = to;
            self.save(&book).await?;
            from = to + 1;
        }
        Ok(())
    }

    async fn step(&self, id: B256, block: u64, now: u64, relay_tip: u64) -> Result<()> {
        let (d, handles) = self.desk.order(id).await?;
        let mut r = self.record(id).await?;
        // The payment's height, read until it is known.
        if r.payment_height.is_none() && self.awaits_mining(&r) {
            let dir = order_dir(&self.orders_dir, &id);
            let seen = match r.side {
                Side::Buy => self.seam.mined(Some(&dir.join("opening.json")), None).await,
                Side::Sell => self.seam.mined(None, Some(&dir.join("txid"))).await,
            };
            // A failed query is no answer: the next pass asks again.
            if let Ok(m) = seen
                && let Some(h) = m.mined
            {
                r.payment_height = Some(h);
                self.update(id, |x| x.payment_height = Some(h)).await?;
                info!(order = %id, "payment mined");
            }
        }
        let (prover, prover_busy) = {
            let slot = self.prover.lock().await;
            let state = match (slot.running, slot.finished.get(&id)) {
                (Some(x), _) if x == id => ProverState::Running,
                (_, Some(true)) => ProverState::Done,
                (_, Some(false)) => ProverState::Failed,
                _ => ProverState::Idle,
            };
            (state, slot.running.is_some_and(|x| x != id))
        };
        let anchor_in_best_chain = if d.status == crate::decide::DeskStatus::Proven {
            let anchor = self.desk.anchor_of(id).await?;
            self.desk.in_best_chain(anchor).await?
        } else {
            true
        };
        let other_payment_unmined = {
            let book = self.book.lock().await;
            book.active().any(|x| {
                x.order_id != id && x.side == Side::Buy && x.status == MakerStatus::Paid && x.payment_height.is_none()
            })
        };
        // The anchor a proof would use, the block after the payment's: deep enough in the relay, with the desk's work.
        let anchor_ready = match r.payment_height {
            Some(h) if relay_tip >= u64::from(h) + 1 + self.timing.anchor_depth => {
                matches!(self.desk.work_on_top(u64::from(h) + 1).await?, Some(w) if w >= self.min_work)
            }
            _ => false,
        };
        let facts = Facts {
            me: self.desk.me,
            desk: d,
            block,
            now,
            relay_tip,
            anchor_ready,
            resolve_timeout: self.resolve_timeout,
            anchor_in_best_chain,
            payment_height: r.payment_height,
            other_payment_unmined,
            prover,
            prover_busy,
        };
        let step = decide(&r, &facts, &self.timing);
        if step != Step::Wait {
            info!(order = %id, step = ?step, "step");
        }
        self.execute(step, &r, &d, &handles, now).await
    }

    fn awaits_mining(&self, r: &OrderRecord) -> bool {
        match r.side {
            Side::Buy => matches!(r.status, MakerStatus::Paid | MakerStatus::Proving),
            Side::Sell => r.user_paid && matches!(r.status, MakerStatus::Funding | MakerStatus::Proving),
        }
    }

    async fn record(&self, id: B256) -> Result<OrderRecord> {
        self.book.lock().await.orders.get(&id).cloned().ok_or_else(|| anyhow!("order left the book"))
    }

    async fn update(&self, id: B256, f: impl FnOnce(&mut OrderRecord)) -> Result<()> {
        let mut book = self.book.lock().await;
        let r = book.orders.get_mut(&id).ok_or_else(|| anyhow!("order left the book"))?;
        f(r);
        self.save(&book).await
    }

    async fn execute(&self, step: Step, r: &OrderRecord, d: &DeskOrder, h: &Handles, now: u64) -> Result<()> {
        let id = r.order_id;
        match step {
            Step::Wait => Ok(()),
            Step::Quote => self.quote(r, h).await,
            Step::Resolve => self.desk.resolve(id).await,
            Step::PublishResolution => {
                let hs: Vec<B256> = match r.side {
                    Side::Buy => vec![h.winner, h.masked],
                    Side::Sell => vec![h.winner],
                };
                let (clear, proof) = self.fhe.public_decrypt(&hs).await?;
                self.desk.publish_resolution(r.side, id, clear, proof).await
            }
            Step::Fund => self.fund(r, now).await,
            Step::PublishFunding => {
                let (clear, proof) = self.fhe.public_decrypt(&[h.funded, h.masked]).await?;
                self.desk.publish_funding(id, clear, proof).await
            }
            Step::Pay => self.pay(r).await,
            Step::Prove { anchor_height } if self.prove => self.start_proof(r, d, anchor_height).await,
            Step::Prove { .. } => {
                tracing::debug!(order = %id, "a proof is due; this host does not prove");
                Ok(())
            }
            Step::SubmitProof => self.submit(r).await,
            Step::Finalize => self.desk.finalize(id).await,
            Step::Drop => {
                self.desk.drop_settlement(id).await?;
                self.prover.lock().await.finished.remove(&id);
                self.update(id, |x| x.payment_height = None).await
            }
            Step::Refund => self.desk.refund(id).await,
            Step::Abandon => {
                warn!(order = %id, "the maker will not pay this order; the user's refund follows the deadline");
                self.update(id, |x| x.status = MakerStatus::Abandoned).await
            }
            Step::Forget => {
                let dir = order_dir(&self.orders_dir, &id);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
                }
                self.prover.lock().await.finished.remove(&id);
                self.update(id, OrderRecord::forget).await
            }
        }
    }

    /// The ZEC (Buy) or cUSDC (Sell) the maker has promised to orders still in play.
    async fn reserved(&self, side: Side) -> u64 {
        let book = self.book.lock().await;
        book.active()
            .filter(|x| x.side == side)
            .filter(|x| match side {
                Side::Buy => matches!(
                    x.status,
                    MakerStatus::Quoted | MakerStatus::Handoff | MakerStatus::Paid | MakerStatus::Proving
                ),
                // A funded quote has left the balance already.
                Side::Sell => x.status == MakerStatus::Quoted,
            })
            .filter_map(|x| x.quote)
            .fold(0u64, |a, q| a.saturating_add(q))
    }

    async fn quote(&self, r: &OrderRecord, h: &Handles) -> Result<()> {
        let id = r.order_id;
        let size = self.fhe.decrypt_u64(self.desk.desk, h.size).await.context("decrypting the order's size")?;
        let priced = match r.side {
            Side::Buy => {
                let free = self.zec_inventory_zat.saturating_sub(self.reserved(Side::Buy).await);
                self.pricing.quote_buy(size, free)
            }
            Side::Sell => {
                let handle = self.desk.balance_handle().await?;
                let balance = if handle == B256::ZERO {
                    0
                } else {
                    self.fhe.decrypt_u64(self.desk.token, handle).await.context("decrypting the maker's balance")?
                };
                let free = balance.saturating_sub(self.reserved(Side::Sell).await);
                self.pricing.quote_sell(size, free)
            }
        };
        let q = match priced {
            Ok(q) => q,
            Err(why) => {
                info!(order = %id, reason = ?why, "declined");
                return self
                    .update(id, |x| {
                        x.size = Some(size);
                        x.status = MakerStatus::Declined;
                    })
                    .await;
            }
        };
        let (handles, proof) = self.fhe.encrypt_u64(self.desk.desk, self.desk.me, &[q]).await?;
        let handle = *handles.first().ok_or_else(|| anyhow!("no handle for the quote"))?;
        // Recorded before it is sent: a crash between the two leaves a quote the maker would honour, never an
        // honoured quote it forgot.
        self.update(id, |x| {
            x.size = Some(size);
            x.quote = Some(q);
            x.status = MakerStatus::Quoted;
        })
        .await?;
        self.desk.quote(id, handle, proof).await?;
        info!(order = %id, "quoted");
        Ok(())
    }

    async fn fund(&self, r: &OrderRecord, now: u64) -> Result<()> {
        let id = r.order_id;
        let dir = private_dir(&order_dir(&self.orders_dir, &id))?;
        let salt_file = dir.join("salt");
        // A fresh salt per order, made once: a retry reuses it, so the commitment and the mask stay the ones sent.
        let commitment = if salt_file.exists() {
            let address = std::fs::read_to_string(&self.seam.cfg.address_file)?;
            self.seam.commitment(address.trim(), &salt_file).await?
        } else {
            self.seam.new_commitment(&salt_file).await?
        };
        let salt = read_salt(&salt_file)?;
        let mask = amount_mask(&salt, &r.payment_ref);
        let (handles, proof) = self.fhe.encrypt_u64(self.desk.desk, self.desk.me, &[mask]).await?;
        let handle = *handles.first().ok_or_else(|| anyhow!("no handle for the mask"))?;
        self.desk.ensure_operator(now + self.operator_days * 86_400).await?;
        self.update(id, |x| {
            x.salt = Some(hex::encode(salt));
            x.commitment = Some(commitment);
            x.status = MakerStatus::Funding;
        })
        .await?;
        self.desk.fund(id, commitment, handle, proof).await?;
        info!(order = %id, "funded");
        Ok(())
    }

    async fn pay(&self, r: &OrderRecord) -> Result<()> {
        let id = r.order_id;
        let dir = private_dir(&order_dir(&self.orders_dir, &id))?;
        let opening = dir.join("opening.json");
        if !opening.exists() {
            let to = r.receiver.as_deref().ok_or_else(|| anyhow!("no receiver"))?;
            let zat = r.quote.ok_or_else(|| anyhow!("no quote"))?;
            // `seam pay` writes the opening before it broadcasts and never replaces it: once the file exists, this
            // order is never paid again, whatever happens next.
            if let Err(e) = self.seam.pay(to, zat, &r.payment_ref, &opening).await {
                // Nothing was sent (no opening): try again after a pause rather than every pass. The pay deadline
                // still decides when the maker gives up.
                let (_, now) = self.desk.latest().await?;
                self.update(id, |x| x.pay_after = Some(now + PAY_RETRY_SECS)).await?;
                return Err(e);
            }
        }
        info!(order = %id, "paid");
        self.update(id, |x| x.status = MakerStatus::Paid).await
    }

    async fn start_proof(&self, r: &OrderRecord, d: &DeskOrder, anchor: u32) -> Result<()> {
        let id = r.order_id;
        {
            let mut slot = self.prover.lock().await;
            if slot.running.is_some() {
                return Ok(());
            }
            slot.running = Some(id);
            slot.finished.remove(&id);
        }
        self.update(id, |x| {
            x.status = MakerStatus::Proving;
            x.proof_attempts += 1;
        })
        .await?;
        let dir = order_dir(&self.orders_dir, &id);
        let (seam, prover) = (self.seam.clone(), self.prover.clone());
        let (side, payment_ref, masked) = (r.side, r.payment_ref, d.masked_amount);
        let commitment = match side {
            Side::Buy => d.receiver_commitment,
            Side::Sell => r.commitment.unwrap_or(d.receiver_commitment),
        };
        tokio::spawn(async move {
            let witness = dir.join("witness.json");
            let seal = dir.join("seal.json");
            let _ = std::fs::remove_file(&witness);
            let _ = std::fs::remove_file(&seal);
            let opening = dir.join("opening.json");
            let txid = dir.join("txid");
            let salt = dir.join("salt");
            let job = WitnessJob {
                opening: (side == Side::Buy).then_some(opening.as_path()),
                txid_file: (side == Side::Sell).then_some(txid.as_path()),
                salt_file: &salt,
                anchor,
                payment_ref: &payment_ref,
                commitment: &commitment,
                out: &witness,
            };
            let result = async {
                seam.witness(&job).await?;
                seam.seal(&witness, masked, &seal).await
            }
            .await;
            // The witness holds the receiver and the salt: it goes as soon as the proof is made or failed.
            let _ = std::fs::remove_file(&witness);
            let ok = match result {
                Ok(()) => {
                    info!(order = %id, "proof ready");
                    true
                }
                Err(e) => {
                    warn!(order = %id, "proof failed: {e:#}");
                    false
                }
            };
            let mut slot = prover.lock().await;
            slot.running = None;
            slot.finished.insert(id, ok);
        });
        Ok(())
    }

    async fn submit(&self, r: &OrderRecord) -> Result<()> {
        let id = r.order_id;
        let seal_path = order_dir(&self.orders_dir, &id).join("seal.json");
        let (journal, seal, _image) = SealFile::read(&seal_path)?;
        let sent = self.desk.prove(id, journal, seal).await;
        // Sent or refused, this seal is done with. A refused one counts as a failed attempt: it is proven again
        // while attempts are left, then given up.
        {
            let mut slot = self.prover.lock().await;
            match &sent {
                Ok(()) => slot.finished.remove(&id),
                Err(_) => slot.finished.insert(id, false),
            };
        }
        let _ = std::fs::remove_file(&seal_path);
        sent?;
        info!(order = %id, "proof submitted");
        Ok(())
    }
}

fn read_salt(path: &std::path::Path) -> Result<[u8; 32]> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let bytes = hex::decode(text.trim().trim_start_matches("0x")).map_err(|_| anyhow!("the salt file is not hex"))?;
    bytes.try_into().map_err(|_| anyhow!("the salt file is not 32 bytes"))
}

/// The maker's address, from its signer.
pub fn maker_address(signer: &alloy::signers::local::PrivateKeySigner) -> Address {
    signer.address()
}
