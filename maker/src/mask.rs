//! The amount mask and the receiver commitment, as Seam's statement defines them (crates/seam-payment/src/masked.rs
//! and docs/PAYMENTS.md there): `R = u64_be(keccak256("seam/amount-mask/v1" || salt32 || paymentRef32)[0..8])`,
//! `M = Z + R mod 2^64`, `C = keccak256(salt32 || receiver43)`.
//!
//! The side that pays ZEC checks a published M against its own amount Z before paying (`check_masked`): a wrong mask
//! from the receiving side can then only make it refuse, never underpay.

use alloy::primitives::{B256, keccak256};

/// The mask's domain separator.
pub const MASK_DOMAIN: &[u8; 19] = b"seam/amount-mask/v1";

/// R for a salt and a paymentRef.
pub fn amount_mask(salt: &[u8; 32], payment_ref: &B256) -> u64 {
    let mut pre = Vec::with_capacity(19 + 64);
    pre.extend_from_slice(MASK_DOMAIN);
    pre.extend_from_slice(salt);
    pre.extend_from_slice(payment_ref.as_slice());
    let h = keccak256(&pre);
    u64::from_be_bytes(h[..8].try_into().expect("8 bytes"))
}

/// M = Z + R (mod 2^64): what the receiving side encrypts as its mask's effect, and what the desk publishes.
pub fn masked_amount(amount: u64, salt: &[u8; 32], payment_ref: &B256) -> u64 {
    amount.wrapping_add(amount_mask(salt, payment_ref))
}

/// Whether a published M is exactly `amount` masked with this salt and paymentRef. The payer pays only if it is.
pub fn check_masked(masked: u64, amount: u64, salt: &[u8; 32], payment_ref: &B256) -> bool {
    masked.wrapping_sub(amount) == amount_mask(salt, payment_ref)
}

/// C = keccak256(salt32 || receiver43).
pub fn receiver_commitment(salt: &[u8; 32], receiver: &[u8; 43]) -> B256 {
    let mut pre = [0u8; 75];
    pre[..32].copy_from_slice(salt);
    pre[32..].copy_from_slice(receiver);
    keccak256(pre)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vectors Seam's Rust statement, its Solidity test and the TypeScript tooling all check.
    #[test]
    fn mask_matches_the_statements_vectors() {
        assert_eq!(amount_mask(&[0u8; 32], &B256::ZERO), 0x0cd0_4af7_2b7b_9602);
        assert_eq!(amount_mask(&[0xffu8; 32], &B256::ZERO), 0xdfa0_8b7c_9f65_6d57);
    }

    #[test]
    fn masking_inverts_across_the_wrap() {
        let salt = [7u8; 32];
        let r = B256::repeat_byte(9);
        for z in [0u64, 1, 1_000_000, u64::MAX - 1, u64::MAX] {
            let m = masked_amount(z, &salt, &r);
            assert!(check_masked(m, z, &salt, &r));
            assert!(!check_masked(m, z.wrapping_add(1), &salt, &r));
            assert!(!check_masked(m.wrapping_add(1), z, &salt, &r));
        }
    }

    #[test]
    fn another_salt_or_reference_changes_the_mask() {
        let r = B256::repeat_byte(1);
        assert_ne!(amount_mask(&[1u8; 32], &r), amount_mask(&[2u8; 32], &r));
        assert_ne!(amount_mask(&[1u8; 32], &r), amount_mask(&[1u8; 32], &B256::repeat_byte(2)));
        assert_ne!(receiver_commitment(&[1u8; 32], &[3u8; 43]), receiver_commitment(&[2u8; 32], &[3u8; 43]));
    }
}
