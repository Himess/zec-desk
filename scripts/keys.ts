/**
 * Creates the missing Sepolia test keys of `.env.sepolia` (deployer/admin, test user) and prints only their addresses
 * and balances. A key already there is never replaced, so a funded wallet is never lost.
 *
 *   npx hardhat run scripts/keys.ts
 */
import { randomBytes } from "crypto";
import { ethers } from "ethers";
import * as fs from "fs";
import { ENV_SEPOLIA, KEY_NAMES, gitignoreCovers, isKey, readEnvSepolia, rpcUrl } from "./lib/env";

async function main() {
  if (!gitignoreCovers()) throw new Error(".gitignore does not cover .env.sepolia: refusing to write a key");
  const env = readEnvSepolia();
  const missing = KEY_NAMES.filter((n) => !isKey(env[n]));
  if (missing.length) {
    const lines = missing.map((n) => `${n}=0x${randomBytes(32).toString("hex")}`);
    const prefix = fs.existsSync(ENV_SEPOLIA) && !fs.readFileSync(ENV_SEPOLIA, "utf8").endsWith("\n") ? "\n" : "";
    fs.appendFileSync(ENV_SEPOLIA, prefix + lines.join("\n") + "\n", { mode: 0o600 });
    console.log(`created ${missing.join(", ")} in .env.sepolia (keys not shown)`);
  }
  const now = readEnvSepolia();
  const provider = new ethers.JsonRpcProvider(rpcUrl(now), 11155111, { staticNetwork: true });
  for (const n of KEY_NAMES) {
    const a = new ethers.Wallet(now[n]).address;
    const bal = await provider.getBalance(a).catch(() => null);
    console.log(`${n.replace("ZEC_DESK_", "").replace("_KEY", "").toLowerCase().padEnd(8)} ${a}  ${bal === null ? "?" : ethers.formatEther(bal)} Sepolia ETH`);
  }
  provider.destroy();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
