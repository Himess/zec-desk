/**
 * `@fhevm/sdk` client for Sepolia (real relayer + Gateway). Independent of the Hardhat plugin:
 * the SDK is used directly so that bugs in the plugin's alpha release do not affect the live measurements.
 *
 * Note: `require` is used because the TS types of the "@fhevm/sdk/ethers" subpath are not published in `typesVersions`.
 */
import type { ethers } from "ethers";

export type FhevmLiveClient = {
  ready: Promise<void>;
  encryptValues(p: {
    values: ReadonlyArray<{ type: string; value: boolean | bigint | number | string }>;
    contractAddress: string;
    userAddress: string;
    options?: any;
  }): Promise<{ encryptedValues: readonly string[]; inputProof: string }>;
  decryptPublicValuesWithSignatures(p: { encryptedValues: readonly string[]; options?: any }): Promise<{
    clearValues: readonly any[];
    checkSignaturesArgs: { handlesList: readonly string[]; abiEncodedCleartexts: string; decryptionProof: string };
  }>;
  canDecryptPublicValues?(p: { encryptedValues: readonly string[] }): Promise<readonly boolean[]>;
  [k: string]: any;
};

let cached: FhevmLiveClient | undefined;

export async function makeFhevmClient(provider: ethers.Provider): Promise<FhevmLiveClient> {
  if (cached) return cached;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk: any = require("@fhevm/sdk/ethers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sepolia } = require("@fhevm/sdk/chains");
  if (!sdk.hasFhevmRuntimeConfig()) sdk.setFhevmRuntimeConfig({});
  await sdk.initFhevmRuntime();
  const client: FhevmLiveClient = sdk.createFhevmClient({ provider, chain: sepolia });
  await client.ready;
  cached = client;
  return client;
}

export function sepoliaFhevmChain(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@fhevm/sdk/chains").sepolia;
}
