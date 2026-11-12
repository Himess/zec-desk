/**
 * The user's side of a scripted desk run on Sepolia, against the maker on Contabo (its hand-off API reached through an
 * SSH tunnel on 127.0.0.1:18797). Prints each step and its gas; never prints a key, a salt or an address of Zcash.
 *
 *   E2E=buy  npx hardhat run scripts/e2e.ts --network sepolia   # 10 cUSDC for at least 0.2 ZEC, hand-off to the winner
 *   E2E=sell npx hardhat run scripts/e2e.ts --network sepolia   # 0.25 ZEC for at least 9 cUSDC, the maker's receiver
 *
 * Settings: DESK_RECORD (deployments/<name>.json, default the no-proof test desk), MAKER_API, SEAM_BIN, WALLET_DIR
 * (the test user's Zcash wallet and its per-order secrets, outside any repository).
 */
import { ethers, network } from "hardhat";
import type { ContractTransactionResponse } from "ethers";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { key, readEnvSepolia, ROOT } from "./lib/env";
import { makeFhevmClient } from "./lib/fhevm";

const RECORD = process.env.DESK_RECORD ?? path.join(ROOT, "deployments", "zec-desk-sepolia-noproof-1.json");
const MAKER_API = process.env.MAKER_API ?? "http://127.0.0.1:18797";
const SEAM_BIN = process.env.SEAM_BIN ?? "C:\\Users\\USER\\seam-work\\seam\\target\\debug\\seam.exe";
const WALLET_DIR = process.env.WALLET_DIR ?? "C:\\Users\\USER\\seam-work\\zec-desk-test-wallets";
const STATUS = ["None", "Open", "Resolving", "Matched", "Funding", "Funded", "Proven", "Settled", "Refunded", "NoMatch", "Void"];
const DESK_ABI = [
  "function nonces(address) view returns (uint64)",
  "function nextOrder(address user) view returns (bytes32 orderId, bytes32 paymentRef)",
  "function openBuy(uint64 expectedNonce, bytes32 amount, bytes32 floorZat, bytes32 mask, bytes inputProof, bytes32 receiverCommitment) returns (bytes32)",
  "function openSell(uint64 expectedNonce, bytes32 zat, bytes32 floorUsd, bytes inputProof) returns (bytes32)",
  "function getOrder(bytes32 orderId) view returns (tuple(uint8 side, uint8 status, uint8 makerCount, uint8 quoteCount, uint8 winnerSlot, address user, address winner, bytes32 paymentRef, bytes32 receiverCommitment, uint64 quoteEndBlock, uint64 fundDeadline, uint64 payDeadline, uint64 maskedAmount, bytes32 anchor, uint64 readyHeight, uint64 readyTime, bytes32 sizeHandle, bytes32 bestHandle, bytes32 escrowHandle, uint64 stepAt, uint64 proveDeadline))",
  "function publicationHandles(bytes32 orderId) view returns (bytes32 winner, bytes32 masked, bytes32 funded)",
  "function resolve(bytes32 orderId)",
  "function publishBuyResolution(bytes32 orderId, bytes cleartexts, bytes decryptionProof)",
  "function publishSellResolution(bytes32 orderId, bytes cleartexts, bytes decryptionProof)",
];
const TOKEN_ABI = ["function setOperator(address operator, uint48 until)", "function isOperator(address holder, address spender) view returns (bool)"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gasRows: { step: string; gas: string; tx: string }[] = [];

function amountMask(salt: Uint8Array, paymentRef: string): bigint {
  const h = ethers.keccak256(ethers.concat([ethers.toUtf8Bytes("seam/amount-mask/v1"), salt, paymentRef]));
  return BigInt("0x" + h.slice(2, 18));
}

async function send(step: string, p: Promise<ContractTransactionResponse>) {
  const r = await (await p).wait();
  gasRows.push({ step, gas: r!.gasUsed.toString(), tx: r!.hash });
  console.log(`  ${step}: ${r!.gasUsed} gas (${r!.hash})`);
  return r!;
}

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const which = process.env.E2E;
  if (which === "handoff") return handoffOnly();
  if (which !== "buy" && which !== "sell") throw new Error("set E2E=buy, sell or handoff");
  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  const provider = ethers.provider;
  const user = new ethers.Wallet(key(readEnvSepolia(), "ZEC_DESK_USER_KEY"), provider);
  const desk = new ethers.Contract(rec.ZecDesk, DESK_ABI, user);
  const token = new ethers.Contract(rec.token, TOKEN_ABI, user);
  console.log(`${which}: desk ${rec.ZecDesk}, user ${user.address}`);

  if (!(await token.isOperator(user.address, rec.ZecDesk))) {
    const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
    await send("setOperator", token.setOperator(rec.ZecDesk, until));
  }
  const fhe = await makeFhevmClient(provider);
  const nonce: bigint = await desk.nonces(user.address);
  const [orderId, paymentRef] = await desk.nextOrder(user.address);
  const orderDir = path.join(WALLET_DIR, "orders", orderId.slice(2, 18));
  fs.mkdirSync(orderDir, { recursive: true });
  console.log(`order ${orderId}`);

  let salt: Uint8Array | null = null;
  let address = "";
  if (which === "buy") {
    address = fs.readFileSync(path.join(WALLET_DIR, "user-address"), "utf8").trim();
    salt = randomBytes(32);
    const saltFile = path.join(orderDir, "salt");
    fs.writeFileSync(saltFile, Buffer.from(salt).toString("hex"), { mode: 0o600 });
    const c = execFileSync(SEAM_BIN, ["commitment", "--address", address, "--salt-file", saltFile], { encoding: "utf8" }).trim();
    const r = amountMask(salt, paymentRef);
    const t0 = Date.now();
    const enc = await fhe.encryptValues({
      values: [
        { type: "euint64", value: 10_000_000n }, // 10 cUSDC
        { type: "euint64", value: 20_000_000n }, // at least 0.2 ZEC
        { type: "euint64", value: r },
      ],
      contractAddress: rec.ZecDesk,
      userAddress: user.address,
    });
    console.log(`  encrypted 3 values in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const [a, f, m] = enc.encryptedValues;
    await send("openBuy", desk.openBuy(nonce, a, f, m, enc.inputProof, c));
  } else {
    const t0 = Date.now();
    const enc = await fhe.encryptValues({
      values: [
        { type: "euint64", value: 25_000_000n }, // 0.25 ZEC
        { type: "euint64", value: 9_000_000n }, // at least 9 cUSDC
      ],
      contractAddress: rec.ZecDesk,
      userAddress: user.address,
    });
    console.log(`  encrypted 2 values in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const [z, f] = enc.encryptedValues;
    await send("openSell", desk.openSell(nonce, z, f, enc.inputProof));
  }

  // Follow the order; resolve or publish ourselves only if the maker hasn't after a while.
  let last = "";
  const started = Date.now();
  let since = Date.now();
  let handedOff = false;
  while (Date.now() - started < 25 * 60_000) {
    const o = await desk.getOrder(orderId);
    const st = STATUS[Number(o.status)];
    const block = await provider.getBlockNumber();
    if (st !== last) {
      console.log(`[${Math.round((Date.now() - started) / 1000)} s] ${st}${st === "Open" ? ` (${o.quoteCount}/${o.makerCount} quotes, window to block ${o.quoteEndBlock})` : ""}`);
      last = st;
      since = Date.now();
    }
    if (st === "Open" && BigInt(block) > o.quoteEndBlock + 3n && Date.now() - since > 60_000) {
      console.log("  the maker hasn't resolved: resolving");
      await send("resolve (user)", desk.resolve(orderId));
    }
    if (st === "Resolving" && Date.now() - since > 120_000) {
      console.log("  the maker hasn't published: publishing");
      const h = await desk.publicationHandles(orderId);
      const hs = which === "buy" ? [h.winner, h.masked] : [h.winner];
      const p = await fhe.decryptPublicValuesWithSignatures({ encryptedValues: hs });
      const fn = which === "buy" ? desk.publishBuyResolution : desk.publishSellResolution;
      await send("publish (user)", fn(orderId, p.checkSignaturesArgs.abiEncodedCleartexts, p.checkSignaturesArgs.decryptionProof));
    }
    if (st === "NoMatch" || st === "Void" || st === "Refunded" || st === "Settled") break;
    if (which === "buy" && st === "Matched" && !handedOff) {
      const best = (BigInt(o.maskedAmount) - amountMask(salt!, paymentRef)) & ((1n << 64n) - 1n);
      console.log(`  winner ${o.winner}; the best sealed quote (M - R) is ${ethers.formatUnits(best, 8)} ZEC`);
      const res = await fetch(`${MAKER_API}/v1/orders/${orderId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, salt: Buffer.from(salt!).toString("hex") }),
      });
      console.log(`  hand-off: ${res.status} ${(await res.text()).slice(0, 200)}`);
      handedOff = true;
      break;
    }
    if (which === "sell" && st === "Funded") {
      const chainId = (await provider.getNetwork()).chainId;
      const msg = `ZEC Desk receiver\nchain: ${chainId}\ndesk: ${ethers.getAddress(rec.ZecDesk)}\norder: ${orderId}`;
      const signature = await user.signMessage(msg);
      const res = await fetch(`${MAKER_API}/v1/orders/${orderId}/receiver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`receiver: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      const makerSalt = ethers.getBytes(body.salt);
      const ok = ((BigInt(o.maskedAmount) - 25_000_000n) & ((1n << 64n) - 1n)) === amountMask(makerSalt, paymentRef);
      fs.writeFileSync(path.join(orderDir, "maker-salt"), Buffer.from(makerSalt).toString("hex"), { mode: 0o600 });
      fs.writeFileSync(path.join(orderDir, "maker-address"), String(body.address), { mode: 0o600 });
      console.log(`  the maker's receiver and salt received; the payer's check M - Z == R: ${ok ? "holds, safe to pay" : "FAILS, do not pay"}`);
      break;
    }
    await sleep(12_000);
  }
  const out = path.join(ROOT, "results", `e2e-${which}-${orderId.slice(2, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ desk: rec.ZecDesk, order: orderId, side: which, final: last, gas: gasRows }, null, 2) + "\n");
  console.log(`record: ${path.relative(ROOT, out)}`);
}

/** E2E=handoff ORDER=<id>: the Buy hand-off again, from the salt this script kept for the order. */
async function handoffOnly() {
  const orderId = process.env.ORDER ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) throw new Error("set ORDER to the Buy order's id");
  const orderDir = path.join(WALLET_DIR, "orders", orderId.slice(2, 18));
  const salt = fs.readFileSync(path.join(orderDir, "salt"), "utf8").trim();
  const address = fs.readFileSync(path.join(WALLET_DIR, "user-address"), "utf8").trim();
  const res = await fetch(`${MAKER_API}/v1/orders/${orderId}/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, salt }),
  });
  console.log(`hand-off: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
