/**
 * Zama FHEVM client for the browser: encryption with input proofs (TFHE WASM, embedded) and public decryption
 * through Zama's Sepolia relayer (no key needed). The encrypt client also carries the public-decryption action,
 * so the decryption WASM (TKMS) is never loaded.
 */
import type { ethers } from "ethers";
import { createFhevmEncryptClient, initFhevmEncryptRuntime, setFhevmRuntimeConfig } from "@fhevm/sdk/ethers";
import { sepolia } from "@fhevm/sdk/chains";

type Client = {
  ready: Promise<void>;
  encryptValues(p: { values: { type: string; value: bigint | boolean | string | number }[]; contractAddress: string; userAddress: string }): Promise<{
    encryptedValues: readonly string[];
    inputProof: string;
  }>;
  decryptPublicValuesWithSignatures(p: { encryptedValues: readonly string[] }): Promise<{
    clearValues: readonly any[];
    checkSignaturesArgs: { abiEncodedCleartexts: string; decryptionProof: string };
  }>;
};

let clientP: Promise<Client> | null = null;

export function fheClient(provider: ethers.Provider): Promise<Client> {
  if (!clientP) {
    clientP = (async () => {
      setFhevmRuntimeConfig({ wasmAssetLoadMode: "embedded-base64" });
      await initFhevmEncryptRuntime();
      const c = createFhevmEncryptClient({ provider, chain: sepolia }) as unknown as Client;
      await c.ready;
      return c;
    })();
    clientP.catch(() => (clientP = null)); // allow a retry after a failed start
  }
  return clientP;
}

export async function encrypt(
  provider: ethers.Provider,
  values: { type: "euint64" | "euint16" | "euint128" | "ebool" | "eaddress"; value: bigint | boolean | string | number }[],
  contractAddress: string,
  userAddress: string,
): Promise<{ handles: string[]; inputProof: string }> {
  const c = await fheClient(provider);
  const r = await c.encryptValues({ values, contractAddress, userAddress });
  return { handles: [...r.encryptedValues], inputProof: r.inputProof };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public decryption of result bits: retries until the KMS has the value (usually 10–40 s on Sepolia). */
export async function publicDecrypt(
  provider: ethers.Provider,
  handles: string[],
  onTick?: (elapsedS: number) => void,
  timeoutMs = 600_000,
): Promise<{ clear: unknown[]; cleartexts: string; proof: string }> {
  const c = await fheClient(provider);
  const t0 = Date.now();
  const tick = () => onTick?.(Math.round((Date.now() - t0) / 1000));
  tick();
  const timer = setInterval(tick, 1000); // the SDK waits internally; keep the elapsed time moving
  let last = "";
  try {
    for (;;) {
      try {
        const r = await c.decryptPublicValuesWithSignatures({ encryptedValues: handles });
        return {
          clear: r.clearValues.map((v: any) => (v && typeof v === "object" && "value" in v ? v.value : v)),
          cleartexts: r.checkSignaturesArgs.abiEncodedCleartexts,
          proof: r.checkSignaturesArgs.decryptionProof,
        };
      } catch (e: any) {
        last = String(e?.message ?? e).slice(0, 200);
        if (Date.now() - t0 > timeoutMs) throw new Error(`Decryption timed out: ${last}`);
        await sleep(2000);
      }
    }
  } finally {
    clearInterval(timer);
  }
}

export function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "1";
  return Boolean(v);
}
