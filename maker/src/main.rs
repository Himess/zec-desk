//! `zec-desk-maker check --config maker.toml`: reads the config, the key, the desk and the relay, and prints what it
//! found (no secret). `zec-desk-maker run --config maker.toml`: the maker, its loop and its hand-off API.

use std::{path::PathBuf, sync::Arc, time::Duration};

use alloy::{
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
};
use anyhow::{Context, Result, anyhow};
use clap::{Parser, Subcommand};
use tokio::sync::Mutex;
use tracing::info;
use zec_desk_maker::{
    book::{Book, private_dir},
    config::{MakerConfig, read_secret},
    desk::Desk,
    engine::{Engine, ProverSlot},
    handoff::{ApiState, router},
    seam::Seam,
};

#[derive(Parser)]
#[command(
    name = "zec-desk-maker",
    version,
    about = "ZEC Desk's market maker (Sepolia, Zcash Testnet)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Creates a new Sepolia key for the maker in a file only its owner reads (never replacing one), and prints only
    /// its address.
    NewKey {
        #[arg(long)]
        out: PathBuf,
    },
    /// Checks the config, the key, the desk and the relay, and prints what it found.
    Check {
        #[arg(long)]
        config: PathBuf,
    },
    /// Runs the maker.
    Run {
        #[arg(long)]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    match Cli::parse().command {
        Command::NewKey { out } => new_key(out),
        Command::Check { config } => check(config).await,
        Command::Run { config } => run(config).await,
    }
}

struct Setup {
    cfg: MakerConfig,
    signer: PrivateKeySigner,
    rpc_url: String,
    desk: Arc<Desk<alloy::providers::DynProvider>>,
}

async fn setup(config: PathBuf) -> Result<Setup> {
    let cfg = MakerConfig::load(&config)?;
    let signer: PrivateKeySigner = read_secret(&cfg.key_file)?
        .parse()
        .map_err(|_| anyhow!("{}: not a private key", cfg.key_file.display()))?;
    let rpc_url = read_secret(&cfg.rpc_url_file)?;
    let url = rpc_url.parse().map_err(|_| anyhow!("{}: not a URL", cfg.rpc_url_file.display()))?;
    let provider = ProviderBuilder::new().wallet(signer.clone()).connect_http(url).erased();
    let chain = provider.get_chain_id().await.context("reading the chain id")?;
    anyhow::ensure!(chain == 11_155_111, "the RPC is not Sepolia's (chain {chain}): the maker runs on Sepolia only");
    let desk = Arc::new(Desk::new(provider, cfg.desk, signer.address()).await?);
    Ok(Setup {
        cfg,
        signer,
        rpc_url,
        desk,
    })
}

fn new_key(out: PathBuf) -> Result<()> {
    anyhow::ensure!(!out.exists(), "{} exists: a key is never replaced", out.display());
    let signer = PrivateKeySigner::random();
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    use std::io::Write;
    let mut f = o.open(&out).with_context(|| format!("creating {}", out.display()))?;
    writeln!(f, "0x{}", hex::encode(signer.to_bytes()))?;
    f.sync_all()?;
    println!("{}", signer.address());
    Ok(())
}

async fn check(config: PathBuf) -> Result<()> {
    let s = setup(config).await?;
    let (block, _) = s.desk.latest().await?;
    println!("maker    {}", s.desk.me);
    println!("desk     {} (relay {}, token {})", s.desk.desk, s.desk.relay, s.desk.token);
    println!("block    {block}; relay tip {}", s.desk.relay_tip().await?);
    println!(
        "timeout  RESOLVE_TIMEOUT {} s; MIN_WORK {}",
        s.desk.resolve_timeout().await?,
        s.desk.min_work().await?
    );
    for p in [
        &s.cfg.seam.bin,
        &s.cfg.seam.masked_elf,
        &s.cfg.seam.wallet,
        &s.cfg.seam.address_file,
        &s.cfg.seam.ufvk_file,
    ] {
        anyhow::ensure!(p.exists(), "{} does not exist", p.display());
    }
    println!("seam     files present");
    Ok(())
}

async fn run(config: PathBuf) -> Result<()> {
    let s = setup(config).await?;
    let cfg = &s.cfg;
    private_dir(&cfg.work_dir)?;
    private_dir(&cfg.orders_dir())?;
    let book = Arc::new(Mutex::new(Book::load(&cfg.book_path(), cfg.start_block.saturating_sub(1))?));
    let seam = Arc::new(Seam { cfg: cfg.seam.clone() });
    let fhe = Arc::new(connect_fhe(cfg, &s.rpc_url, s.signer.clone()).await?);
    let engine = Arc::new(Engine {
        desk: s.desk.clone(),
        fhe,
        seam: seam.clone(),
        book: book.clone(),
        book_path: cfg.book_path(),
        orders_dir: cfg.orders_dir(),
        pricing: cfg.pricing.clone(),
        timing: cfg.timing,
        zec_inventory_zat: cfg.zec_inventory_zat,
        operator_days: cfg.operator_days,
        prove: cfg.prove,
        resolve_timeout: s.desk.resolve_timeout().await?,
        min_work: s.desk.min_work().await?,
        poll: Duration::from_secs(cfg.poll_secs),
        prover: Arc::new(Mutex::new(ProverSlot::default())),
    });
    let api = Arc::new(ApiState {
        book,
        book_path: cfg.book_path(),
        orders_dir: cfg.orders_dir(),
        desk: s.desk.clone(),
        seam,
        privacy_delay_max_secs: cfg.privacy_delay_max_secs,
    });
    let listener = tokio::net::TcpListener::bind(&cfg.api.listen)
        .await
        .with_context(|| format!("listening on {}", cfg.api.listen))?;
    info!(maker = %s.desk.me, desk = %s.desk.desk, listen = %cfg.api.listen, "maker started");
    let app = router(api, &cfg.api.origins);
    tokio::select! {
        r = engine.run() => r,
        r = axum::serve(listener, app) => r.context("the hand-off API stopped"),
        _ = tokio::signal::ctrl_c() => { info!("stopping"); Ok(()) }
    }
}

#[cfg(unix)]
async fn connect_fhe(
    cfg: &MakerConfig,
    rpc_url: &str,
    signer: PrivateKeySigner,
) -> Result<zec_desk_maker::fhe::daemon::DaemonFhe> {
    let key = cfg.fhe.relayer_api_key_file.as_deref().map(read_secret).transpose()?;
    zec_desk_maker::fhe::daemon::DaemonFhe::connect(&cfg.fhe.socket, rpc_url, signer, key).await
}

#[cfg(not(unix))]
async fn connect_fhe(_: &MakerConfig, _: &str, _: PrivateKeySigner) -> Result<NoFhe> {
    Err(anyhow!("the maker's FHE runs through Zama's SDK daemon, on Linux or macOS only"))
}

/// Stands in for the daemon client where there is none, so the binary still builds (and `check` runs) on Windows.
#[cfg(not(unix))]
struct NoFhe;

#[cfg(not(unix))]
impl zec_desk_maker::fhe::Fhe for NoFhe {
    async fn encrypt_u64(
        &self,
        _: alloy::primitives::Address,
        _: alloy::primitives::Address,
        _: &[u64],
    ) -> Result<(Vec<alloy::primitives::B256>, Vec<u8>)> {
        Err(anyhow!("no FHE on this platform"))
    }
    async fn decrypt_u64(&self, _: alloy::primitives::Address, _: alloy::primitives::B256) -> Result<u64> {
        Err(anyhow!("no FHE on this platform"))
    }
    async fn public_decrypt(&self, _: &[alloy::primitives::B256]) -> Result<(Vec<u8>, Vec<u8>)> {
        Err(anyhow!("no FHE on this platform"))
    }
}
