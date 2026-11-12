//! The desk, the relay and the token on Sepolia, as the maker reads and calls them.

use alloy::{
    primitives::{Address, B256, Bytes},
    providers::Provider,
    rpc::types::{Filter, TransactionReceipt},
    sol,
    sol_types::SolEvent,
};
use anyhow::{Context, Result, anyhow, ensure};

use crate::decide::{DeskOrder, DeskStatus, Side};

sol! {
    #[sol(rpc)]
    interface IZecDesk {
        struct OrderView {
            uint8 side;
            uint8 status;
            uint8 makerCount;
            uint8 quoteCount;
            uint8 winnerSlot;
            address user;
            address winner;
            bytes32 paymentRef;
            bytes32 receiverCommitment;
            uint64 quoteEndBlock;
            uint64 fundDeadline;
            uint64 payDeadline;
            uint64 maskedAmount;
            bytes32 anchor;
            uint64 readyHeight;
            uint64 readyTime;
            bytes32 sizeHandle;
            bytes32 bestHandle;
            bytes32 escrowHandle;
            uint64 stepAt;
            uint64 proveDeadline;
        }

        event OrderOpened(bytes32 indexed orderId, uint8 side, address indexed user, bytes32 paymentRef, bytes32 receiverCommitment);

        function getOrder(bytes32 orderId) external view returns (OrderView memory v);
        function publicationHandles(bytes32 orderId) external view returns (bytes32 winner, bytes32 masked, bytes32 funded);
        function makerAt(bytes32 orderId, uint8 slot) external view returns (address);
        function isMaker(address maker) external view returns (bool);
        function RESOLVE_TIMEOUT() external view returns (uint32);
        function MIN_WORK() external view returns (uint256);
        function MAX_MAKERS() external view returns (uint8);
        function RELAY() external view returns (address);
        function TOKEN() external view returns (address);

        function quote(bytes32 orderId, bytes32 value, bytes inputProof) external;
        function resolve(bytes32 orderId) external;
        function publishBuyResolution(bytes32 orderId, bytes cleartexts, bytes decryptionProof) external;
        function publishSellResolution(bytes32 orderId, bytes cleartexts, bytes decryptionProof) external;
        function fund(bytes32 orderId, bytes32 receiverCommitment, bytes32 mask, bytes inputProof) external;
        function publishFunding(bytes32 orderId, bytes cleartexts, bytes decryptionProof) external;
        function proveSettlement(bytes32 orderId, bytes journal, bytes seal) external;
        function finalizeSettlement(bytes32 orderId) external;
        function dropSettlement(bytes32 orderId) external;
        function refund(bytes32 orderId) external;
    }

    #[sol(rpc)]
    interface IRelay {
        function bestChainTip() external view returns (bytes32 blockHash, uint256 height, uint256 chainWork);
        function isInBestChain(bytes32 blockHash) external view returns (bool);
        function bestBlockHashAt(uint256 height) external view returns (bytes32);
        function confirmationWork(bytes32 blockHash) external view returns (uint256);
    }

    #[sol(rpc)]
    interface IToken {
        function confidentialBalanceOf(address account) external view returns (bytes32);
        function isOperator(address holder, address spender) external view returns (bool);
        function setOperator(address operator, uint48 until) external;
    }
}

/// A new order, as its `OrderOpened` event tells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opened {
    pub order_id: B256,
    pub side: Side,
    pub user: Address,
    pub payment_ref: B256,
}

/// Handles the maker decrypts or has published.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Handles {
    pub size: B256,
    pub winner: B256,
    pub masked: B256,
    pub funded: B256,
}

pub struct Desk<P> {
    pub provider: P,
    pub desk: Address,
    pub relay: Address,
    pub token: Address,
    pub me: Address,
}

impl<P: Provider + Clone> Desk<P> {
    pub async fn new(provider: P, desk: Address, me: Address) -> Result<Self> {
        let d = IZecDesk::new(desk, provider.clone());
        let relay = d.RELAY().call().await.context("reading the desk's relay")?;
        let token = d.TOKEN().call().await.context("reading the desk's token")?;
        Ok(Self {
            provider,
            desk,
            relay,
            token,
            me,
        })
    }

    fn d(&self) -> IZecDesk::IZecDeskInstance<P> {
        IZecDesk::new(self.desk, self.provider.clone())
    }

    pub async fn chain_id(&self) -> Result<u64> {
        Ok(self.provider.get_chain_id().await?)
    }

    pub async fn latest(&self) -> Result<(u64, u64)> {
        let n = self.provider.get_block_number().await?;
        let b = self.provider.get_block_by_number(n.into()).await?.ok_or_else(|| anyhow!("block {n} not found"))?;
        Ok((n, b.header.timestamp))
    }

    /// The orders opened in blocks `from..=to` that snapshotted this maker.
    pub async fn opened(&self, from: u64, to: u64) -> Result<Vec<Opened>> {
        let filter = Filter::new()
            .address(self.desk)
            .event_signature(IZecDesk::OrderOpened::SIGNATURE_HASH)
            .from_block(from)
            .to_block(to);
        let mut out = Vec::new();
        for log in self.provider.get_logs(&filter).await? {
            let e = log.log_decode::<IZecDesk::OrderOpened>()?.inner.data;
            let side = Side::from_u8(e.side).ok_or_else(|| anyhow!("unknown side {}", e.side))?;
            if self.my_slot(e.orderId).await?.is_some() {
                out.push(Opened {
                    order_id: e.orderId,
                    side,
                    user: e.user,
                    payment_ref: e.paymentRef,
                });
            }
        }
        Ok(out)
    }

    /// The maker's slot on an order, if the order snapshotted it.
    pub async fn my_slot(&self, order_id: B256) -> Result<Option<u8>> {
        let d = self.d();
        let max = d.MAX_MAKERS().call().await?;
        for slot in 0..max {
            let m = d.makerAt(order_id, slot).call().await?;
            if m == Address::ZERO {
                return Ok(None);
            }
            if m == self.me {
                return Ok(Some(slot));
            }
        }
        Ok(None)
    }

    pub async fn order(&self, order_id: B256) -> Result<(DeskOrder, Handles)> {
        let d = self.d();
        let v = d.getOrder(order_id).call().await.context("getOrder")?;
        let p = d.publicationHandles(order_id).call().await.context("publicationHandles")?;
        let order = DeskOrder {
            side: Side::from_u8(v.side).ok_or_else(|| anyhow!("unknown side"))?,
            status: DeskStatus::from_u8(v.status).ok_or_else(|| anyhow!("unknown status"))?,
            user: v.user,
            winner: v.winner,
            payment_ref: v.paymentRef,
            receiver_commitment: v.receiverCommitment,
            quote_end_block: v.quoteEndBlock,
            fund_deadline: v.fundDeadline,
            pay_deadline: v.payDeadline,
            masked_amount: v.maskedAmount,
            ready_height: v.readyHeight,
            ready_time: v.readyTime,
            step_at: v.stepAt,
            prove_deadline: v.proveDeadline,
        };
        Ok((
            order,
            Handles {
                size: v.sizeHandle,
                winner: p.winner,
                masked: p.masked,
                funded: p.funded,
            },
        ))
    }

    pub async fn resolve_timeout(&self) -> Result<u64> {
        Ok(u64::from(self.d().RESOLVE_TIMEOUT().call().await?))
    }

    pub async fn min_work(&self) -> Result<alloy::primitives::U256> {
        Ok(self.d().MIN_WORK().call().await?)
    }

    /// The work on top of the relay's best-chain header at `height`, or None while the relay doesn't hold it.
    pub async fn work_on_top(&self, height: u64) -> Result<Option<alloy::primitives::U256>> {
        let r = IRelay::new(self.relay, self.provider.clone());
        let hash = r.bestBlockHashAt(alloy::primitives::U256::from(height)).call().await?;
        if hash == B256::ZERO {
            return Ok(None);
        }
        Ok(Some(r.confirmationWork(hash).call().await?))
    }

    pub async fn relay_tip(&self) -> Result<u64> {
        let tip = IRelay::new(self.relay, self.provider.clone()).bestChainTip().call().await?;
        u64::try_from(tip.height).map_err(|_| anyhow!("relay height out of range"))
    }

    pub async fn in_best_chain(&self, hash: B256) -> Result<bool> {
        Ok(IRelay::new(self.relay, self.provider.clone()).isInBestChain(hash).call().await?)
    }

    pub async fn anchor_of(&self, order_id: B256) -> Result<B256> {
        Ok(self.d().getOrder(order_id).call().await?.anchor)
    }

    /// The maker's encrypted cUSDC balance handle.
    pub async fn balance_handle(&self) -> Result<B256> {
        Ok(IToken::new(self.token, self.provider.clone()).confidentialBalanceOf(self.me).call().await?)
    }

    /// Makes the desk the maker's operator on the token (Sell funding pulls the quote), if it isn't already.
    pub async fn ensure_operator(&self, until: u64) -> Result<()> {
        let t = IToken::new(self.token, self.provider.clone());
        if t.isOperator(self.me, self.desk).call().await? {
            return Ok(());
        }
        let until = alloy::primitives::Uint::<48, 1>::from(until);
        mined(t.setOperator(self.desk, until).send().await?.get_receipt().await?)
    }

    pub async fn quote(&self, order_id: B256, handle: B256, proof: Vec<u8>) -> Result<()> {
        mined(self.d().quote(order_id, handle, Bytes::from(proof)).send().await?.get_receipt().await?)
    }

    pub async fn resolve(&self, order_id: B256) -> Result<()> {
        mined(self.d().resolve(order_id).send().await?.get_receipt().await?)
    }

    pub async fn publish_resolution(&self, side: Side, order_id: B256, clear: Vec<u8>, proof: Vec<u8>) -> Result<()> {
        let d = self.d();
        let (c, p) = (Bytes::from(clear), Bytes::from(proof));
        let pending = match side {
            Side::Buy => d.publishBuyResolution(order_id, c, p).send().await?,
            Side::Sell => d.publishSellResolution(order_id, c, p).send().await?,
        };
        mined(pending.get_receipt().await?)
    }

    pub async fn fund(&self, order_id: B256, commitment: B256, mask: B256, proof: Vec<u8>) -> Result<()> {
        mined(self.d().fund(order_id, commitment, mask, Bytes::from(proof)).send().await?.get_receipt().await?)
    }

    pub async fn publish_funding(&self, order_id: B256, clear: Vec<u8>, proof: Vec<u8>) -> Result<()> {
        mined(
            self.d()
                .publishFunding(order_id, Bytes::from(clear), Bytes::from(proof))
                .send()
                .await?
                .get_receipt()
                .await?,
        )
    }

    pub async fn prove(&self, order_id: B256, journal: Vec<u8>, seal: Vec<u8>) -> Result<()> {
        mined(
            self.d()
                .proveSettlement(order_id, Bytes::from(journal), Bytes::from(seal))
                .send()
                .await?
                .get_receipt()
                .await?,
        )
    }

    pub async fn finalize(&self, order_id: B256) -> Result<()> {
        mined(self.d().finalizeSettlement(order_id).send().await?.get_receipt().await?)
    }

    pub async fn drop_settlement(&self, order_id: B256) -> Result<()> {
        mined(self.d().dropSettlement(order_id).send().await?.get_receipt().await?)
    }

    pub async fn refund(&self, order_id: B256) -> Result<()> {
        mined(self.d().refund(order_id).send().await?.get_receipt().await?)
    }
}

fn mined(r: TransactionReceipt) -> Result<()> {
    ensure!(r.status(), "transaction {} reverted", r.transaction_hash);
    Ok(())
}
