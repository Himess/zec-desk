//! The ZEC leg, through Seam's CLI: `seam commitment`, `pay`, `mined`, `witness` and `seal` as subprocesses. Seam
//! already keeps its secrets in files (salts, openings, txids, wallets, viewing keys) and never prints them, so the
//! maker passes paths, reads back only what the commands print for tools, and logs none of it. The one exception is
//! the receiver's unified address, which `seam pay` and `seam commitment` take as an argument: run the maker on a
//! machine nobody else uses.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use alloy::primitives::B256;
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::Deserialize;
use tokio::process::Command;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeamConfig {
    /// The `seam` binary: built with `zkvm` (and `cuda` where the maker proves).
    pub bin: PathBuf,
    /// The light wallet server, if not Seam's default.
    #[serde(default)]
    pub lwd: Option<String>,
    /// Where `seam witness` keeps public header files and block summaries.
    pub data_dir: PathBuf,
    /// The pinned amount-hidden guest (zkvm/pinned-image-ids.txt: payment-masked-test), which `seam seal` proves.
    pub masked_elf: PathBuf,
    /// The maker's disposable Testnet wallet (`seam pay --new-wallet`), which pays Buy orders.
    pub wallet: PathBuf,
    /// The wallet's unified address, which receives Sell payments, and its full viewing key, which finds them.
    pub address_file: PathBuf,
    pub ufvk_file: PathBuf,
}

/// What `seam mined` printed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Mined {
    pub mined: Option<u32>,
    pub tip: u32,
}

pub struct Seam {
    pub cfg: SeamConfig,
}

impl Seam {
    fn base(&self, sub: &str) -> Command {
        let mut c = Command::new(&self.cfg.bin);
        c.arg(sub).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        c
    }

    fn lwd(&self, c: &mut Command) {
        if let Some(url) = &self.cfg.lwd {
            c.arg("--lwd").arg(url);
        }
    }

    /// Runs a command and returns its standard output. A failure is reported by the command's name and exit status
    /// only: Seam's own messages stay on this machine's terminal, in the order's log, not in errors that travel.
    async fn run(&self, what: &str, mut c: Command) -> Result<String> {
        let out = c.output().await.with_context(|| format!("starting seam {what}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // Seam's messages never hold a secret, but they can be long: the last line says why.
            let why = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_owned();
            bail!("seam {what} failed ({}): {why}", out.status);
        }
        String::from_utf8(out.stdout).map_err(|_| anyhow!("seam {what}: output is not UTF-8"))
    }

    /// The maker's own receiver commitment for an order: a fresh salt file (which `--new-salt` creates and never
    /// replaces) and its wallet's address.
    pub async fn new_commitment(&self, salt_file: &Path) -> Result<B256> {
        let address = std::fs::read_to_string(&self.cfg.address_file)
            .with_context(|| format!("reading {}", self.cfg.address_file.display()))?;
        let mut c = self.base("commitment");
        c.arg("--address").arg(address.trim()).arg("--salt-file").arg(salt_file).arg("--new-salt");
        parse_b256(&self.run("commitment", c).await?)
    }

    /// The commitment of a user's address under the user's salt (a hand-off), to compare with the order's.
    pub async fn commitment(&self, address: &str, salt_file: &Path) -> Result<B256> {
        let mut c = self.base("commitment");
        c.arg("--address").arg(address).arg("--salt-file").arg(salt_file);
        parse_b256(&self.run("commitment", c).await?)
    }

    /// Pays `zat` to `to` with the memo of `payment_ref` from the maker's wallet. `seam pay` writes the opening and
    /// txid to `opening` before it broadcasts, and never replaces an existing file: a second call for the same order
    /// fails instead of paying twice.
    pub async fn pay(&self, to: &str, zat: u64, payment_ref: &B256, opening: &Path) -> Result<()> {
        let mut c = self.base("pay");
        c.arg("--wallet")
            .arg(&self.cfg.wallet)
            .arg("--to")
            .arg(to)
            .arg("--zat")
            .arg(zat.to_string())
            .arg("--ref")
            .arg(hex::encode(payment_ref))
            .arg("--opening")
            .arg(opening)
            .arg("--network")
            .arg("testnet");
        self.lwd(&mut c);
        self.run("pay", c).await.map(drop)
    }

    /// Whether the payment an opening (Buy) or a txid file (Sell) names is mined.
    pub async fn mined(&self, opening: Option<&Path>, txid_file: Option<&Path>) -> Result<Mined> {
        let mut c = self.base("mined");
        match (opening, txid_file) {
            (Some(o), None) => c.arg("--opening").arg(o),
            (None, Some(t)) => c.arg("--txid-file").arg(t),
            _ => bail!("seam mined: one of an opening and a txid file"),
        };
        self.lwd(&mut c);
        let out = self.run("mined", c).await?;
        serde_json::from_str(out.trim()).map_err(|_| anyhow!("seam mined: unexpected output"))
    }

    /// Builds the witness of an order's payment anchored at `anchor`: from the maker's opening (Buy, the maker paid)
    /// or from the user's txid and the maker's viewing key (Sell, the maker was paid).
    pub async fn witness(&self, w: &WitnessJob<'_>) -> Result<()> {
        let mut c = self.base("witness");
        match (w.opening, w.txid_file) {
            (Some(o), None) => c.arg("--opening").arg(o),
            (None, Some(t)) => c.arg("--txid-file").arg(t).arg("--ufvk-file").arg(&self.cfg.ufvk_file),
            _ => bail!("seam witness: one of an opening and a txid file"),
        };
        c.arg("--salt-file")
            .arg(w.salt_file)
            .arg("--anchor")
            .arg(w.anchor.to_string())
            .arg("--out")
            .arg(w.out)
            .arg("--payment-ref")
            .arg(hex::encode(w.payment_ref))
            .arg("--receiver-commitment")
            .arg(hex::encode(w.commitment))
            .arg("--network")
            .arg("testnet")
            .arg("--data-dir")
            .arg(&self.cfg.data_dir);
        self.lwd(&mut c);
        self.run("witness", c).await.map(drop)
    }

    /// Proves a witness with the pinned amount-hidden guest for the order's M and wraps it in Groth16: seal.json.
    pub async fn seal(&self, witness: &Path, masked_amount: u64, seal: &Path) -> Result<()> {
        let mut c = self.base("seal");
        c.env("SEAM_PAYMENT_MASKED_ELF", &self.cfg.masked_elf)
            .arg(witness)
            .arg(seal)
            .arg("--masked-amount")
            .arg(masked_amount.to_string());
        self.run("seal", c).await.map(drop)
    }
}

/// One witness to build.
pub struct WitnessJob<'a> {
    pub opening: Option<&'a Path>,
    pub txid_file: Option<&'a Path>,
    pub salt_file: &'a Path,
    pub anchor: u32,
    pub payment_ref: &'a B256,
    pub commitment: &'a B256,
    pub out: &'a Path,
}

/// seal.json as `seam seal` writes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealFile {
    pub image_id: String,
    pub journal: String,
    pub seal: String,
}

impl SealFile {
    pub fn read(path: &Path) -> Result<(Vec<u8>, Vec<u8>, B256)> {
        let f: SealFile = serde_json::from_slice(&std::fs::read(path)?).context("seal.json")?;
        let journal = hex::decode(f.journal.trim_start_matches("0x")).context("seal.json journal")?;
        let seal = hex::decode(f.seal.trim_start_matches("0x")).context("seal.json seal")?;
        let image_id = parse_b256(&f.image_id)?;
        ensure!(journal.len() == 192, "seal.json: a journal of {} bytes, not 192", journal.len());
        ensure!(journal[31] == 2, "seal.json: not an amount-hidden (version 2) journal");
        Ok((journal, seal, image_id))
    }
}

fn parse_b256(text: &str) -> Result<B256> {
    let t = text.trim();
    t.parse::<B256>().map_err(|_| anyhow!("expected 32 bytes in hex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mined_parses_both_answers() {
        let m: Mined = serde_json::from_str("{\"mined\":123,\"tip\":130}").unwrap();
        assert_eq!(
            m,
            Mined {
                mined: Some(123),
                tip: 130
            }
        );
        let u: Mined = serde_json::from_str("{\"mined\":null,\"tip\":130}").unwrap();
        assert_eq!(u.mined, None);
    }

    #[test]
    fn a_seal_file_must_hold_a_version_2_journal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("seal.json");
        let mut journal = vec![0u8; 192];
        journal[31] = 2;
        let id = format!("0x{}", "ab".repeat(32));
        std::fs::write(
            &p,
            serde_json::json!({"imageId": id, "journal": format!("0x{}", hex::encode(&journal)), "seal": "0x73c457ba"})
                .to_string(),
        )
        .unwrap();
        let (j, s, i) = SealFile::read(&p).unwrap();
        assert_eq!(j, journal);
        assert_eq!(s, vec![0x73, 0xc4, 0x57, 0xba]);
        assert_eq!(i, B256::repeat_byte(0xab));
        journal[31] = 1;
        std::fs::write(
            &p,
            serde_json::json!({"imageId": id, "journal": format!("0x{}", hex::encode(&journal)), "seal": "0x"})
                .to_string(),
        )
        .unwrap();
        assert!(SealFile::read(&p).is_err());
    }
}
