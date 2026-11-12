//! The maker's configuration: one TOML file of paths and parameters. Secrets are never in it, only the paths of the
//! files that hold them (the EVM key, the RPC URL, the relayer key, the Zcash wallet and viewing key).

use std::path::{Path, PathBuf};

use alloy::primitives::Address;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;

use crate::{decide::Timing, pricing::Pricing, seam::SeamConfig};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MakerConfig {
    /// A file holding the Sepolia RPC URL (it may carry an API key).
    pub rpc_url_file: PathBuf,
    /// A file holding the maker's EVM private key, hex. Sepolia only, a key made for the maker.
    pub key_file: PathBuf,
    /// The desk's address.
    pub desk: Address,
    /// The first Sepolia block to read orders from (the desk's deployment block).
    pub start_block: u64,
    /// The maker's private working directory (0700): the book and each order's files.
    pub work_dir: PathBuf,
    /// Seconds between passes.
    #[serde(default = "default_poll")]
    pub poll_secs: u64,
    /// Buy: the most seconds the maker waits, at random, between a hand-off and its payment.
    #[serde(default)]
    pub privacy_delay_max_secs: u64,
    /// Buy: the zatoshi the maker offers in total across open orders. Its wallet must hold at least this much.
    pub zec_inventory_zat: u64,
    /// How long the desk stays the maker's ERC-7984 operator when the maker sets it.
    #[serde(default = "default_operator_days")]
    pub operator_days: u64,
    /// Whether this host proves payments (`seam seal`). A host without a GPU sets false: a CPU proof takes hours.
    #[serde(default = "default_prove")]
    pub prove: bool,
    pub api: ApiConfig,
    pub fhe: FheConfig,
    pub pricing: Pricing,
    pub timing: Timing,
    pub seam: SeamConfig,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiConfig {
    /// Where the hand-off API listens (behind a TLS proxy when it faces the Internet).
    pub listen: String,
    /// The app origins a browser may call the API from.
    #[serde(default)]
    pub origins: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FheConfig {
    /// The Zama SDK daemon's Unix socket.
    pub socket: PathBuf,
    /// A file holding a Zama relayer API key, if the relayer asks for one.
    #[serde(default)]
    pub relayer_api_key_file: Option<PathBuf>,
}

fn default_poll() -> u64 {
    12
}

fn default_prove() -> bool {
    true
}

fn default_operator_days() -> u64 {
    30
}

impl MakerConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        // toml's message quotes the offending line; the config holds no secret, so it may.
        let cfg: MakerConfig =
            toml::from_str(&text).with_context(|| format!("{} is not a maker config", path.display()))?;
        cfg.pricing.validate()?;
        ensure!(cfg.poll_secs > 0, "poll_secs must be positive");
        ensure!(cfg.timing.anchor_depth > 0, "timing.anchor_depth must be positive");
        Ok(cfg)
    }

    pub fn book_path(&self) -> PathBuf {
        self.work_dir.join("book.json")
    }

    pub fn orders_dir(&self) -> PathBuf {
        self.work_dir.join("orders")
    }
}

/// The trimmed text of a file that holds a secret. Errors name the path, never the contents.
pub fn read_secret(path: &Path) -> Result<String> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const EXAMPLE: &str = include_str!("../maker.example.toml");

    #[test]
    fn the_example_config_parses_and_validates() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("maker.toml");
        std::fs::write(&p, EXAMPLE).unwrap();
        let c = MakerConfig::load(&p).unwrap();
        assert_eq!(c.poll_secs, 12);
        assert_eq!(c.timing.anchor_depth, 2);
        assert!(c.book_path().ends_with("book.json"));
    }

    #[test]
    fn unknown_keys_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("maker.toml");
        std::fs::write(&p, format!("{EXAMPLE}\nprivate_key = \"0x00\"\n")).unwrap();
        assert!(MakerConfig::load(&p).is_err());
    }
}
