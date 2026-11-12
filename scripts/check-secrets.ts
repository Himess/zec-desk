/**
 * Before publishing: are ZEC Desk's Sepolia keys absent from every file git would commit, from the git history and
 * from Claude's session logs? Reads the keys from `.env.sepolia` in this process and never prints one: only the paths
 * of files that contain a key are reported. Also flags generic secret patterns in the files to be committed.
 *
 *   npx hardhat run scripts/check-secrets.ts
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ENV_SEPOLIA, KEY_NAMES, ROOT, isKey, readEnvSepolia } from "./lib/env";

const GENERIC = [
  /PRIVATE_KEY\s*[=:]\s*["']?0x[0-9a-fA-F]{64}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"crypto"\s*:\s*\{\s*"cipher"/,
  /\bmnemonic\b\s*[=:]/i,
];

function main() {
  const env = readEnvSepolia();
  const hexes = KEY_NAMES.map((k) => env[k]).filter(isKey).map((k) => k.toLowerCase().slice(2));
  if (hexes.length === 0) throw new Error("no key in .env.sepolia to look for");

  // EXTRA_REPOS (paths separated by ';'): other repositories these keys touched, such as Seam's deployments.
  const repos = [ROOT, ...(process.env.EXTRA_REPOS ?? "").split(";").filter(Boolean)];
  const files = repos.flatMap((repo) =>
    execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard"]).toString().split("\n").filter(Boolean).map((rel) => path.join(repo, rel)),
  );
  const keyHits: string[] = [];
  const genericHits: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    // Submodules are listed as directories; their own files are their projects', not ours.
    if (path.resolve(f) === path.resolve(ENV_SEPOLIA) || !fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    const content = fs.readFileSync(f, "latin1");
    if (hexes.some((h) => content.toLowerCase().includes(h))) keyHits.push(rel);
    if (GENERIC.some((re) => re.test(content))) genericHits.push(rel);
  }

  let history = "no commits yet";
  try {
    const log = execFileSync("git", ["-C", ROOT, "log", "--all", "-p", "--no-color"], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] })
      .toString("latin1")
      .toLowerCase();
    history = hexes.some((h) => log.includes(h)) ? "WARNING: a key is in the git history" : "no key in the git history";
  } catch {
    // no commits yet
  }

  // Session logs grow to hundreds of megabytes: read them in chunks that overlap by more than a key's length.
  const containsKey = (f: string) => {
    const fd = fs.openSync(f, "r");
    const chunk = Buffer.alloc(8 << 20);
    let carry = "";
    try {
      for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
        const text = carry + chunk.toString("latin1", 0, n).toLowerCase();
        if (hexes.some((h) => text.includes(h))) return true;
        carry = text.slice(-80);
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  };
  const logs = path.join(os.homedir(), ".claude", "projects", "C--Users-USER-Desktop-zamapin");
  const logHits: string[] = [];
  if (fs.existsSync(logs)) {
    for (const name of fs.readdirSync(logs)) {
      const f = path.join(logs, name);
      if (fs.statSync(f).isFile() && containsKey(f)) logHits.push(name);
    }
  }

  console.log(`files git would commit: ${files.length}; keys looked for: ${hexes.length}`);
  console.log(keyHits.length ? `WARNING: a key is in ${keyHits.join(", ")}` : "no key in the files to be committed");
  console.log(genericHits.length ? `check by hand (secret-like patterns): ${genericHits.join(", ")}` : "no secret-like patterns");
  console.log(history);
  console.log(logHits.length ? `WARNING: a key is in session logs ${logHits.join(", ")}` : "no key in Claude's session logs");
  if (keyHits.length || logHits.length || history.startsWith("WARNING")) process.exitCode = 1;
}

main();
