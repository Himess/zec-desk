//! The maker's order book: every order it was snapshotted on, how far it is, and what it must remember to finish it,
//! persisted atomically in a file only its owner reads, so a restart neither pays twice nor forgets a proof. Secrets
//! (the user's receiver and salt on a Buy, the maker's salt on a Sell, the user's txid, the amounts) are kept only
//! until the order is over, then erased (`forget`).

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use alloy::primitives::{Address, B256};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::decide::Side;

/// Where an order is, from the maker's side.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MakerStatus {
    /// Snapshotted; no quote decided yet.
    Open,
    /// The maker chose not to quote.
    Declined,
    /// Its encrypted quote is on chain.
    Quoted,
    /// Buy, won: the user's hand-off opened the commitment. The payment waits for its privacy delay.
    Handoff,
    /// Buy: the payment is built and sent (its opening was written first).
    Paid,
    /// Sell, won: the funding is sent; then the user pays.
    Funding,
    /// A proof task ran or runs for the order.
    Proving,
    /// Buy: the maker will not pay; the user's refund follows the deadline.
    Abandoned,
    /// Over for the maker; secrets erased.
    Done,
}

/// One order of this maker.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderRecord {
    pub order_id: B256,
    pub side: Side,
    pub user: Address,
    pub payment_ref: B256,
    pub status: MakerStatus,
    /// The order's size as the maker decrypted it (Buy: cUSDC units; Sell: zatoshi). Private.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// The maker's quote (Buy: zatoshi; Sell: cUSDC units). Private.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<u64>,
    /// Buy: the user's unified address (the hand-off). Private.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
    /// Buy: the user's salt; Sell: the maker's own, hex. Private.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    /// Sell: the maker's receiver commitment for this order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commitment: Option<B256>,
    /// Buy: Sepolia time from which the maker may pay (the privacy delay).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pay_after: Option<u64>,
    /// Sell: the user told the maker its payment's txid (kept in the order's directory, never here).
    #[serde(default)]
    pub user_paid: bool,
    /// The height the order's payment was mined at, once `seam mined` saw it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment_height: Option<u32>,
    #[serde(default)]
    pub proof_attempts: u32,
}

impl OrderRecord {
    pub fn new(order_id: B256, side: Side, user: Address, payment_ref: B256) -> Self {
        Self {
            order_id,
            side,
            user,
            payment_ref,
            status: MakerStatus::Open,
            size: None,
            quote: None,
            receiver: None,
            salt: None,
            commitment: None,
            pay_after: None,
            user_paid: false,
            payment_height: None,
            proof_attempts: 0,
        }
    }

    pub fn salt_bytes(&self) -> Option<[u8; 32]> {
        let bytes = hex::decode(self.salt.as_deref()?.trim_start_matches("0x")).ok()?;
        bytes.try_into().ok()
    }

    /// Erases what the order needed and nobody needs any more.
    pub fn forget(&mut self) {
        self.status = MakerStatus::Done;
        self.size = None;
        self.quote = None;
        self.receiver = None;
        self.salt = None;
        self.pay_after = None;
    }
}

/// The book, and the last Sepolia block whose desk events it has read.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Book {
    pub last_block: u64,
    pub orders: BTreeMap<B256, OrderRecord>,
}

impl Book {
    /// Loads the book, or starts an empty one from `start_block` if the file doesn't exist yet.
    pub fn load(path: &Path, start_block: u64) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{}: not a book", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Book {
                last_block: start_block,
                ..Default::default()
            }),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Writes the book to a temporary file only the owner can read, then renames it over the old one: a crash leaves
    /// either the old book or the new, never half of one.
    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self)?;
        let mut f = private_file(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
        Ok(())
    }

    /// The orders still in play, in id order.
    pub fn active(&self) -> impl Iterator<Item = &OrderRecord> {
        self.orders.values().filter(|r| r.status != MakerStatus::Done)
    }
}

/// Creates (or truncates) a file only its owner may read and write (0600 on Unix).
pub fn private_file(path: &Path) -> Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path).with_context(|| format!("opening {}", path.display()))
}

/// Creates a directory only its owner may enter (0700 on Unix), with its parents.
pub fn private_dir(path: &Path) -> Result<PathBuf> {
    fs::create_dir_all(path).with_context(|| format!("creating {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_book_round_trips_and_a_missing_one_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.json");
        let empty = Book::load(&path, 42).unwrap();
        assert_eq!(empty.last_block, 42);
        assert!(empty.orders.is_empty());

        let mut b = Book {
            last_block: 7,
            ..Default::default()
        };
        let mut r = OrderRecord::new(B256::repeat_byte(1), Side::Sell, Address::repeat_byte(2), B256::repeat_byte(3));
        r.status = MakerStatus::Funding;
        r.salt = Some(hex::encode([9u8; 32]));
        r.quote = Some(9_950_000);
        b.orders.insert(r.order_id, r.clone());
        b.save(&path).unwrap();
        let back = Book::load(&path, 0).unwrap();
        assert_eq!(back.last_block, 7);
        assert_eq!(back.orders.get(&r.order_id), Some(&r));
        assert_eq!(back.active().count(), 1);
        assert!(!dir.path().join("book.json.tmp").exists());
    }

    #[test]
    fn forgetting_erases_the_secrets() {
        let mut r = OrderRecord::new(B256::repeat_byte(1), Side::Buy, Address::repeat_byte(2), B256::repeat_byte(3));
        r.receiver = Some("utest1...".into());
        r.salt = Some(hex::encode([9u8; 32]));
        r.quote = Some(1);
        r.size = Some(2);
        r.forget();
        assert_eq!(r.status, MakerStatus::Done);
        assert!(r.receiver.is_none() && r.salt.is_none() && r.quote.is_none() && r.size.is_none());
        let text = serde_json::to_string(&r).unwrap();
        assert!(!text.contains("receiver") && !text.contains("salt"));
    }

    #[test]
    fn salts_decode_with_or_without_a_prefix() {
        let mut r = OrderRecord::new(B256::ZERO, Side::Buy, Address::ZERO, B256::ZERO);
        r.salt = Some(format!("0x{}", hex::encode([4u8; 32])));
        assert_eq!(r.salt_bytes(), Some([4u8; 32]));
        r.salt = Some("abcd".into());
        assert_eq!(r.salt_bytes(), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_book_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.json");
        Book::default().save(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
