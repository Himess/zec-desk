//! FHE for the maker: encrypting its quotes and masks for its own transactions, decrypting the order sizes it was
//! allowed to read, and fetching public decryptions with their KMS proof for the desk's publish functions.
//!
//! On Linux and macOS this is Zama's Rust client (`zama_sdk`) talking to Zama's SDK daemon over a Unix socket: the
//! client covers all three operations, so the maker runs no FHE sidecar of its own.

#![allow(async_fn_in_trait)]

use alloy::primitives::{Address, B256};
use anyhow::Result;

pub trait Fhe {
    /// Encrypts `values` as euint64 inputs for `contract`, bound to `user` (the sender of the transaction that will
    /// carry them): one handle per value and the input proof.
    async fn encrypt_u64(&self, contract: Address, user: Address, values: &[u64]) -> Result<(Vec<B256>, Vec<u8>)>;
    /// Decrypts a euint64 handle the maker's account may read.
    async fn decrypt_u64(&self, contract: Address, handle: B256) -> Result<u64>;
    /// The public decryption of `handles`: the ABI-encoded clear values and the KMS decryption proof, as
    /// `FHE.checkSignatures` takes them.
    async fn public_decrypt(&self, handles: &[B256]) -> Result<(Vec<u8>, Vec<u8>)>;
}

#[cfg(unix)]
pub mod daemon {
    use std::path::Path;

    use alloy::{
        primitives::{Address, B256},
        providers::ProviderBuilder,
        signers::local::PrivateKeySigner,
    };
    use anyhow::{Context, Result, anyhow};
    use zama_sdk::{
        ApplicationStorage, BigInt, ChainConfig, ClearValue, Client, EncryptInput, EncryptOptions, EncryptParams,
        EncryptedInput, MemoryStorage, RelayerAuth, Sdk, SdkConfig, Storage, WalletAccount, alloy::AlloySigner,
    };

    use super::Fhe;

    pub const SEPOLIA: u64 = 11_155_111;

    pub struct DaemonFhe {
        sdk: Sdk,
    }

    impl DaemonFhe {
        /// Connects to the daemon's socket with the maker's account. The RPC URL and the relayer key, which may be
        /// secrets, go to the daemon only; neither is logged.
        pub async fn connect(
            socket: &Path,
            rpc_url: &str,
            signer: PrivateKeySigner,
            relayer_api_key: Option<String>,
        ) -> Result<Self> {
            let account = WalletAccount {
                address: signer.address(),
                chain_id: SEPOLIA,
            };
            let mut chain = ChainConfig::new(SEPOLIA, rpc_url);
            if let Some(key) = relayer_api_key.filter(|k| !k.is_empty()) {
                chain = chain.with_auth(RelayerAuth::api_key(key));
            }
            let config = SdkConfig::from_chains(SEPOLIA, vec![chain]);
            // The daemon signs the user-decryption permits with the maker's key; it sends no transaction for it.
            let provider = ProviderBuilder::new()
                .disable_recommended_fillers()
                .with_gas_estimation()
                .with_simple_nonce_management()
                .fetch_chain_id()
                .wallet(signer.clone())
                .connect_http(rpc_url.parse().map_err(|_| anyhow!("the RPC URL is not a URL"))?);
            let wallet = AlloySigner::new(signer).with_transactions(provider);
            // Permits live in this process's memory: a restart signs a new one.
            let storage: Storage = ApplicationStorage::new(MemoryStorage::default()).into();
            let sdk = Client::connect(socket)
                .await
                .with_context(|| format!("connecting to the Zama SDK daemon at {}", socket.display()))?
                .sdk(config)
                .signer(Some(account), wallet)
                .storage(storage)
                .build()
                .await
                .context("starting a Zama SDK session")?;
            Ok(Self { sdk })
        }

        pub async fn close(&self) -> Result<()> {
            self.sdk.close().await.map_err(Into::into)
        }
    }

    impl Fhe for DaemonFhe {
        async fn encrypt_u64(&self, contract: Address, user: Address, values: &[u64]) -> Result<(Vec<B256>, Vec<u8>)> {
            let inputs: Vec<EncryptInput> = values.iter().map(|v| EncryptInput::Uint64(BigInt::from(*v))).collect();
            let r = self
                .sdk
                .encrypt(
                    EncryptParams {
                        values: &inputs,
                        contract_address: contract,
                        user_address: user,
                    },
                    EncryptOptions::default(),
                )
                .await
                .context("encrypting")?;
            Ok((r.encrypted_values, r.input_proof))
        }

        async fn decrypt_u64(&self, contract: Address, handle: B256) -> Result<u64> {
            let values = self
                .sdk
                .decryption()
                .decrypt_values(
                    &[EncryptedInput {
                        encrypted_value: handle,
                        contract_address: contract,
                    }],
                    None,
                )
                .await
                .context("user decryption")?;
            match values.get(&handle) {
                Some(ClearValue::BigInt(v)) => u64::try_from(v).map_err(|_| anyhow!("decrypted value is not a u64")),
                Some(ClearValue::Number(v)) => Ok(u64::from(*v)),
                _ => Err(anyhow!("the decryption returned no number for the handle")),
            }
        }

        async fn public_decrypt(&self, handles: &[B256]) -> Result<(Vec<u8>, Vec<u8>)> {
            let p = self.sdk.decryption().decrypt_public_values(handles, None).await.context("public decryption")?;
            Ok((p.abi_encoded_clear_values, p.decryption_proof))
        }
    }
}

/// A MOCK for tests: "encrypts" a value as its own big-endian bytes and decrypts it back. Never on a network.
#[cfg(test)]
pub mod mock {
    use std::{collections::HashMap, sync::Mutex};

    use alloy::primitives::{Address, B256, U256};
    use anyhow::{Result, anyhow};

    use super::Fhe;

    #[derive(Default)]
    pub struct MockFhe {
        pub clear: Mutex<HashMap<B256, u64>>,
    }

    impl Fhe for MockFhe {
        async fn encrypt_u64(&self, _: Address, _: Address, values: &[u64]) -> Result<(Vec<B256>, Vec<u8>)> {
            let hs: Vec<B256> = values.iter().map(|v| B256::from(U256::from(*v))).collect();
            let mut c = self.clear.lock().unwrap();
            for (h, v) in hs.iter().zip(values) {
                c.insert(*h, *v);
            }
            Ok((hs, b"MOCK proof".to_vec()))
        }

        async fn decrypt_u64(&self, _: Address, handle: B256) -> Result<u64> {
            self.clear.lock().unwrap().get(&handle).copied().ok_or_else(|| anyhow!("MOCK: unknown handle"))
        }

        async fn public_decrypt(&self, handles: &[B256]) -> Result<(Vec<u8>, Vec<u8>)> {
            let c = self.clear.lock().unwrap();
            let mut abi = Vec::new();
            for h in handles {
                let v = c.get(h).ok_or_else(|| anyhow!("MOCK: unknown handle"))?;
                abi.extend_from_slice(B256::from(U256::from(*v)).as_slice());
            }
            Ok((abi, b"MOCK kms proof".to_vec()))
        }
    }
}
