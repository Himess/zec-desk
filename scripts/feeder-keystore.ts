/**
 * Creates a Sepolia key for feeding Seam's relay as an encrypted keystore (and a random password file) that
 * `scripts/relay-feed.sh` takes through RELAYER_KEYSTORE / RELAYER_PASSWORD_FILE, so the key never reaches a command
 * line. Prints only the address. Never replaces an existing keystore.
 *
 *   OUT_DIR=<private directory outside any repository> npx hardhat run scripts/feeder-keystore.ts
 */
import { ethers } from "ethers";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const dir = process.env.OUT_DIR ?? "";
  if (!dir) throw new Error("set OUT_DIR");
  const ks = path.join(dir, "feeder.keystore.json");
  const pw = path.join(dir, "feeder.password");
  if (fs.existsSync(ks)) throw new Error(`${ks} exists: a key is never replaced`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  const wallet = ethers.Wallet.createRandom();
  fs.writeFileSync(pw, password, { mode: 0o600 });
  fs.writeFileSync(ks, await wallet.encrypt(password), { mode: 0o600 });
  console.log(wallet.address);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
