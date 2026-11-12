/**
 * ZEC Desk's Sepolia keys and RPC URL, read ONLY from the gitignored `.env.sepolia` at the repository's root, inside
 * the process that needs them. Keys never appear on a command line, in logs, script output, records or commits. Only
 * Sepolia: these are keys made for this testnet work, never a real one.
 *
 *   ZEC_DESK_DEPLOYER_KEY   deploys the desk and is its admin (allowlists makers)
 *   ZEC_DESK_USER_KEY       a test user that opens orders in the scripted runs
 *   SEPOLIA_RPC_URL         optional; a public endpoint by default
 *
 * The maker's key is not here: it is made on the machine the maker runs on, and stays there.
 */
import * as fs from "fs";
import * as path from "path";

export const ROOT = path.resolve(__dirname, "..", "..");
export const ENV_SEPOLIA = path.join(ROOT, ".env.sepolia");
export const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const KEY_NAMES = ["ZEC_DESK_DEPLOYER_KEY", "ZEC_DESK_USER_KEY"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** The file's KEY=VALUE lines. Values are never printed; a malformed line is reported by its number only. */
export function readEnvSepolia(): Record<string, string> {
  if (!fs.existsSync(ENV_SEPOLIA)) return {};
  const out: Record<string, string> = {};
  fs.readFileSync(ENV_SEPOLIA, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const at = t.indexOf("=");
      if (at <= 0) throw new Error(`.env.sepolia: line ${i + 1} is not KEY=VALUE`);
      out[t.slice(0, at).trim()] = t.slice(at + 1).trim();
    });
  return out;
}

export function isKey(v: string | undefined): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}

export function key(env: Record<string, string>, name: KeyName): string {
  const v = env[name];
  if (!isKey(v)) throw new Error(`.env.sepolia has no ${name}: run scripts/keys.ts first`);
  return v;
}

export function rpcUrl(env: Record<string, string>): string {
  return env.SEPOLIA_RPC_URL || PUBLIC_RPC;
}

/** The patterns that keep `.env.sepolia` out of git must be in .gitignore before a key is written. */
export function gitignoreCovers(): boolean {
  const gi = path.join(ROOT, ".gitignore");
  if (!fs.existsSync(gi)) return false;
  const lines = fs.readFileSync(gi, "utf8").split(/\r?\n/).map((l) => l.trim());
  return lines.includes(".env.*") || lines.includes(".env.sepolia");
}
