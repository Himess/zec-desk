//! Every decision the maker takes about an order is this pure function of its record and the facts read for it in
//! one pass ([`decide`]). The engine reads the facts, decides, and does the one step; the next pass reads again. A step
//! that sends something (a quote, a payment, a proof) is decided again on fresh facts right before it is sent.

use alloy::primitives::{Address, B256};
use serde::{Deserialize, Serialize};

use crate::book::{MakerStatus, OrderRecord};
use crate::mask::check_masked;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Side::Buy),
            1 => Some(Side::Sell),
            _ => None,
        }
    }
}

/// ZecDesk.Status, in its order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeskStatus {
    None,
    Open,
    Resolving,
    Matched,
    Funding,
    Funded,
    Proven,
    Settled,
    Refunded,
    NoMatch,
    Void,
}

impl DeskStatus {
    pub fn from_u8(v: u8) -> Option<Self> {
        use DeskStatus::*;
        [
            None, Open, Resolving, Matched, Funding, Funded, Proven, Settled, Refunded, NoMatch, Void,
        ]
        .get(v as usize)
        .copied()
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, DeskStatus::Settled | DeskStatus::Refunded | DeskStatus::NoMatch | DeskStatus::Void)
    }
}

/// The order as `ZecDesk.getOrder` shows it, without its handles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeskOrder {
    pub side: Side,
    pub status: DeskStatus,
    pub user: Address,
    pub winner: Address,
    pub payment_ref: B256,
    pub receiver_commitment: B256,
    pub quote_end_block: u64,
    pub fund_deadline: u64,
    pub pay_deadline: u64,
    pub masked_amount: u64,
    pub ready_height: u64,
    pub ready_time: u64,
    pub step_at: u64,
    pub prove_deadline: u64,
}

/// What a proof task of this order is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ProverState {
    #[default]
    Idle,
    Running,
    /// A seal is written for the order.
    Done,
    Failed,
}

/// The facts read for one order in one pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    pub me: Address,
    pub desk: DeskOrder,
    /// Sepolia's latest block and its timestamp.
    pub block: u64,
    pub now: u64,
    /// The relay's best height.
    pub relay_tip: u64,
    /// The relay holds the anchor a proof of the order's payment would use (the block after the payment's), with at
    /// least the desk's minimum work and `anchor_depth` headers on top.
    pub anchor_ready: bool,
    /// The desk's RESOLVE_TIMEOUT: how long a requested publication may take before the order can be refunded.
    pub resolve_timeout: u64,
    /// Proven: whether the pending settlement's anchor is still on the relay's best chain.
    pub anchor_in_best_chain: bool,
    /// The height the order's Zcash payment was mined at, once it is (Buy: the maker's; Sell: the user's, once the
    /// user told its txid).
    pub payment_height: Option<u32>,
    /// Another of the maker's payments is broadcast and not mined: one at a time, so no two pick the same notes.
    pub other_payment_unmined: bool,
    /// The order's proof task, and whether the prover is busy with another order (one proof at a time).
    pub prover: ProverState,
    pub prover_busy: bool,
}

/// The maker's own timing rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timing {
    /// Buy: the least time left before the pay deadline for the maker to start a payment. A payment started later may
    /// be mined too late to prove, and the user's cUSDC would wait for its refund for nothing.
    pub min_pay_lead_secs: u64,
    /// Relay headers on top of the anchor before the witness is built, on top of the desk's minimum work (which the
    /// engine checks): a margin, so the work still holds when the proof lands.
    pub anchor_depth: u64,
    /// How many times a failed proof is retried before the order is given up.
    pub max_proof_attempts: u32,
}

/// The one thing to do next for an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing until the facts change.
    Wait,
    /// Decrypt the size, price it, and send an encrypted quote (or decline).
    Quote,
    /// The quote window is over: ask the desk to resolve.
    Resolve,
    /// Publish the winner (and on a Buy, M) with the KMS proof.
    PublishResolution,
    /// Sell, won: lock the quote and give a fresh receiver commitment and its mask.
    Fund,
    /// Sell: publish `funded` and M.
    PublishFunding,
    /// Buy, won, hand-off checked: pay the user's receiver.
    Pay,
    /// Build the witness on this anchor height and start the proof.
    Prove {
        anchor_height: u32,
    },
    /// Send the finished seal to the desk.
    SubmitProof,
    Finalize,
    Drop,
    Refund,
    /// Buy: the maker will not pay (a wrong M, or too late). The user's refund follows the deadline.
    Abandon,
    /// The order is over for the maker: erase its secrets.
    Forget,
}

pub fn decide(r: &OrderRecord, f: &Facts, t: &Timing) -> Step {
    use DeskStatus as D;
    use MakerStatus as M;
    let d = &f.desk;
    if r.status == M::Done {
        return Step::Wait;
    }
    if d.status.is_terminal() {
        return Step::Forget;
    }
    let mine = d.winner == f.me;
    match d.status {
        D::None => Step::Wait,
        D::Open => match r.status {
            M::Open if f.block <= d.quote_end_block => Step::Quote,
            M::Open | M::Declined => {
                if f.block > d.quote_end_block {
                    Step::Forget
                } else {
                    Step::Wait
                }
            }
            // One block of margin: a load-balanced RPC may still answer from a node at the window's last block.
            M::Quoted if f.block > d.quote_end_block + 1 => Step::Resolve,
            _ => Step::Wait,
        },
        D::Resolving => {
            if r.status != M::Quoted {
                Step::Forget
            } else if f.now > d.step_at.saturating_add(f.resolve_timeout) {
                Step::Refund // the publication never came: the Buy escrow goes back to the user
            } else {
                Step::PublishResolution
            }
        }
        D::Matched if !mine => Step::Forget,
        D::Matched => match d.side {
            Side::Buy => buy_matched(r, f, t),
            Side::Sell => {
                if f.now > d.fund_deadline {
                    Step::Refund // voids the order; the maker locked nothing
                } else if r.status == M::Quoted {
                    Step::Fund
                } else {
                    Step::Wait
                }
            }
        },
        D::Funding if !mine => Step::Forget,
        D::Funding => {
            if f.now > d.step_at.saturating_add(f.resolve_timeout) {
                Step::Refund // the publication never came: the maker's lock comes back
            } else {
                Step::PublishFunding
            }
        }
        D::Funded if !mine => Step::Forget,
        D::Funded => prove_or_refund(r, f, t),
        D::Proven => {
            if !f.anchor_in_best_chain {
                Step::Drop
            } else if f.relay_tip >= d.ready_height && f.now >= d.ready_time {
                Step::Finalize
            } else {
                Step::Wait
            }
        }
        D::Settled | D::Refunded | D::NoMatch | D::Void => Step::Forget,
    }
}

/// Buy, won by this maker.
fn buy_matched(r: &OrderRecord, f: &Facts, t: &Timing) -> Step {
    use MakerStatus as M;
    let d = &f.desk;
    match r.status {
        // Waiting for the user's hand-off; past the deadline the user's refund is all that is left.
        M::Quoted => {
            if f.now > d.prove_deadline {
                Step::Refund
            } else {
                Step::Wait
            }
        }
        M::Handoff => {
            let (Some(quote), Some(salt)) = (r.quote, r.salt_bytes()) else {
                return Step::Abandon;
            };
            // The payer's check: the published M must be its own quote masked with the user's salt. A wrong mask can
            // then only make the maker refuse, never underpay.
            if !check_masked(d.masked_amount, quote, &salt, &d.payment_ref) {
                return Step::Abandon;
            }
            if f.now.saturating_add(t.min_pay_lead_secs) > d.pay_deadline {
                return Step::Abandon;
            }
            if f.now < r.pay_after.unwrap_or(0) || f.other_payment_unmined {
                return Step::Wait;
            }
            Step::Pay
        }
        M::Paid | M::Proving => prove_or_refund(r, f, t),
        M::Abandoned => {
            if f.now > d.prove_deadline {
                Step::Refund
            } else {
                Step::Wait
            }
        }
        _ => Step::Wait,
    }
}

/// Buy after its payment, or Sell once funded: prove the payment when it is deep enough, submit the seal, or refund
/// once the proving window has closed with nothing pending.
fn prove_or_refund(r: &OrderRecord, f: &Facts, t: &Timing) -> Step {
    let d = &f.desk;
    if f.now > d.prove_deadline {
        return Step::Refund;
    }
    match f.prover {
        ProverState::Done => return Step::SubmitProof,
        ProverState::Running => return Step::Wait,
        ProverState::Failed if r.proof_attempts >= t.max_proof_attempts => return Step::Wait,
        ProverState::Failed | ProverState::Idle => {}
    }
    let Some(paid_at) = f.payment_height else {
        return Step::Wait;
    };
    // The anchor is the block right after the payment's: its history commits to the payment's block, and its time is
    // as close to the payment as an anchor can be, well before the deadline.
    let anchor_height = paid_at.saturating_add(1);
    if f.prover_busy || !f.anchor_ready {
        return Step::Wait;
    }
    Step::Prove { anchor_height }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::OrderRecord;
    use crate::mask::masked_amount;

    const ME: Address = Address::repeat_byte(0xaa);
    const OTHER: Address = Address::repeat_byte(0xbb);
    const T: Timing = Timing {
        min_pay_lead_secs: 600,
        anchor_depth: 6,
        max_proof_attempts: 2,
    };

    fn desk(side: Side, status: DeskStatus) -> DeskOrder {
        DeskOrder {
            side,
            status,
            user: Address::repeat_byte(0x11),
            winner: Address::ZERO,
            payment_ref: B256::repeat_byte(0x22),
            receiver_commitment: B256::repeat_byte(0x33),
            quote_end_block: 100,
            fund_deadline: 0,
            pay_deadline: 0,
            masked_amount: 0,
            ready_height: 0,
            ready_time: 0,
            step_at: 0,
            prove_deadline: 0,
        }
    }

    fn facts(d: DeskOrder) -> Facts {
        Facts {
            me: ME,
            desk: d,
            block: 90,
            now: 1_000,
            relay_tip: 0,
            anchor_ready: false,
            resolve_timeout: 3_600,
            anchor_in_best_chain: true,
            payment_height: None,
            other_payment_unmined: false,
            prover: ProverState::Idle,
            prover_busy: false,
        }
    }

    fn rec(side: Side, status: MakerStatus) -> OrderRecord {
        let mut r = OrderRecord::new(B256::repeat_byte(1), side, Address::repeat_byte(0x11), B256::repeat_byte(0x22));
        r.status = status;
        r
    }

    #[test]
    fn quotes_inside_the_window_and_resolves_after_it() {
        let mut f = facts(desk(Side::Buy, DeskStatus::Open));
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Open), &f, &T), Step::Quote);
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Quoted), &f, &T), Step::Wait);
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Declined), &f, &T), Step::Wait);
        f.block = 101;
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Open), &f, &T), Step::Forget);
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Quoted), &f, &T), Step::Wait);
        f.block = 102;
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Quoted), &f, &T), Step::Resolve);
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Declined), &f, &T), Step::Forget);
    }

    #[test]
    fn publishes_when_it_quoted_and_forgets_orders_it_lost() {
        let mut f = facts(desk(Side::Sell, DeskStatus::Resolving));
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Quoted), &f, &T), Step::PublishResolution);
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Declined), &f, &T), Step::Forget);
        f.now = 3_601;
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Quoted), &f, &T), Step::Refund);
        let mut d = desk(Side::Buy, DeskStatus::Matched);
        d.winner = OTHER;
        assert_eq!(decide(&rec(Side::Buy, MakerStatus::Quoted), &facts(d), &T), Step::Forget);
        for s in [
            DeskStatus::Settled,
            DeskStatus::Refunded,
            DeskStatus::NoMatch,
            DeskStatus::Void,
        ] {
            assert_eq!(decide(&rec(Side::Buy, MakerStatus::Paid), &facts(desk(Side::Buy, s)), &T), Step::Forget);
        }
    }

    fn won_buy(quote: u64, salt: [u8; 32]) -> (OrderRecord, Facts) {
        let mut d = desk(Side::Buy, DeskStatus::Matched);
        d.winner = ME;
        d.pay_deadline = 1_000 + 1_800;
        d.prove_deadline = d.pay_deadline + 43_200;
        d.masked_amount = masked_amount(quote, &salt, &d.payment_ref);
        let mut r = rec(Side::Buy, MakerStatus::Handoff);
        r.quote = Some(quote);
        r.salt = Some(hex::encode(salt));
        r.pay_after = Some(1_000);
        (r, facts(d))
    }

    #[test]
    fn buy_pays_only_a_correct_mask_in_time_and_one_payment_at_a_time() {
        let (r, f) = won_buy(24_875_000, [5u8; 32]);
        assert_eq!(decide(&r, &f, &T), Step::Pay);
        // M masked with another salt, or for another amount: the maker refuses.
        let (mut wrong, f2) = won_buy(24_875_000, [5u8; 32]);
        wrong.salt = Some(hex::encode([6u8; 32]));
        assert_eq!(decide(&wrong, &f2, &T), Step::Abandon);
        let (mut more, f3) = won_buy(24_875_000, [5u8; 32]);
        more.quote = Some(24_875_001);
        assert_eq!(decide(&more, &f3, &T), Step::Abandon);
        // The privacy delay, another unmined payment, and too little time left.
        let (mut later, f4) = won_buy(1, [5u8; 32]);
        later.pay_after = Some(1_001);
        assert_eq!(decide(&later, &f4, &T), Step::Wait);
        let (r5, mut f5) = won_buy(1, [5u8; 32]);
        f5.other_payment_unmined = true;
        assert_eq!(decide(&r5, &f5, &T), Step::Wait);
        let (r6, mut f6) = won_buy(1, [5u8; 32]);
        f6.now = f6.desk.pay_deadline - 599;
        assert_eq!(decide(&r6, &f6, &T), Step::Abandon);
    }

    #[test]
    fn buy_proves_on_the_block_after_the_payment_once_deep_enough() {
        let (mut r, mut f) = won_buy(1, [5u8; 32]);
        r.status = MakerStatus::Paid;
        assert_eq!(decide(&r, &f, &T), Step::Wait); // not mined yet
        f.payment_height = Some(1_000);
        assert_eq!(decide(&r, &f, &T), Step::Wait); // anchor 1001 not deep enough in the relay yet
        f.anchor_ready = true;
        assert_eq!(decide(&r, &f, &T), Step::Prove { anchor_height: 1_001 });
        f.prover_busy = true;
        assert_eq!(decide(&r, &f, &T), Step::Wait);
        f.prover_busy = false;
        f.prover = ProverState::Running;
        assert_eq!(decide(&r, &f, &T), Step::Wait);
        f.prover = ProverState::Done;
        assert_eq!(decide(&r, &f, &T), Step::SubmitProof);
        f.prover = ProverState::Failed;
        assert_eq!(decide(&r, &f, &T), Step::Prove { anchor_height: 1_001 });
        r.proof_attempts = 2;
        assert_eq!(decide(&r, &f, &T), Step::Wait);
        f.now = f.desk.prove_deadline + 1;
        assert_eq!(decide(&r, &f, &T), Step::Refund);
    }

    #[test]
    fn buy_without_a_handoff_waits_for_the_refund() {
        let (mut r, mut f) = won_buy(1, [5u8; 32]);
        r.status = MakerStatus::Quoted;
        assert_eq!(decide(&r, &f, &T), Step::Wait);
        f.now = f.desk.prove_deadline + 1;
        assert_eq!(decide(&r, &f, &T), Step::Refund);
        r.status = MakerStatus::Abandoned;
        assert_eq!(decide(&r, &f, &T), Step::Refund);
    }

    #[test]
    fn sell_funds_in_time_publishes_proves_and_refunds_itself() {
        let mut d = desk(Side::Sell, DeskStatus::Matched);
        d.winner = ME;
        d.fund_deadline = 1_600;
        let mut f = facts(d);
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Quoted), &f, &T), Step::Fund);
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Funding), &f, &T), Step::Wait);
        f.now = 1_601;
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Quoted), &f, &T), Step::Refund);
        let mut d = desk(Side::Sell, DeskStatus::Funding);
        d.winner = ME;
        d.step_at = 900;
        let mut f = facts(d);
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Funding), &f, &T), Step::PublishFunding);
        f.now = 4_501;
        assert_eq!(decide(&rec(Side::Sell, MakerStatus::Funding), &f, &T), Step::Refund);
        let mut d = desk(Side::Sell, DeskStatus::Funded);
        d.winner = ME;
        d.pay_deadline = 3_000;
        d.prove_deadline = 46_200;
        let mut f = facts(d);
        let r = rec(Side::Sell, MakerStatus::Funding);
        assert_eq!(decide(&r, &f, &T), Step::Wait); // the user hasn't paid (or told its txid)
        f.payment_height = Some(2_000);
        f.anchor_ready = true;
        assert_eq!(decide(&r, &f, &T), Step::Prove { anchor_height: 2_001 });
        f.now = 46_201;
        assert_eq!(decide(&r, &f, &T), Step::Refund);
    }

    #[test]
    fn a_pending_settlement_is_finalized_when_ready_or_dropped_off_chain() {
        let mut d = desk(Side::Buy, DeskStatus::Proven);
        d.winner = ME;
        d.ready_height = 50;
        d.ready_time = 2_000;
        let mut f = facts(d);
        let r = rec(Side::Buy, MakerStatus::Proving);
        f.relay_tip = 49;
        assert_eq!(decide(&r, &f, &T), Step::Wait);
        f.relay_tip = 50;
        assert_eq!(decide(&r, &f, &T), Step::Wait);
        f.now = 2_000;
        assert_eq!(decide(&r, &f, &T), Step::Finalize);
        f.anchor_in_best_chain = false;
        assert_eq!(decide(&r, &f, &T), Step::Drop);
    }

    #[test]
    fn statuses_decode_in_the_contracts_order() {
        assert_eq!(DeskStatus::from_u8(0), Some(DeskStatus::None));
        assert_eq!(DeskStatus::from_u8(6), Some(DeskStatus::Proven));
        assert_eq!(DeskStatus::from_u8(10), Some(DeskStatus::Void));
        assert_eq!(DeskStatus::from_u8(11), None);
        assert_eq!(Side::from_u8(1), Some(Side::Sell));
        assert_eq!(Side::from_u8(2), None);
    }
}
