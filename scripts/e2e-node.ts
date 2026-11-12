/**
 * The user's side of a desk run on Sepolia, without Hardhat: plain ethers and Zama's `@fhevm/sdk`, for a machine with
 * the memory TFHE needs. The test user's key is read from a file made on that machine (never passed or printed).
 * Prints each step and its gas; never prints a key, a salt or a Zcash address.
 *
 *   E2E=buy|sell|handoff node e2e-node.mjs
 *   env: USER_KEY_FILE, DESK, TOKEN, MAKER_API, SEAM_BIN, WALLET_DIR (the user's Zcash wallet and per-order secrets),
 *        RPC_URL (default publicnode), ORDER (handoff only), BUY_USD_UNITS / BUY_FLOOR_ZAT (a Buy's size and minimum)
 */
import { ethers } from "ethers";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`set ${k}`);
  return v;
};
const RPC_URL = env("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
const DESK = ethers.getAddress(env("DESK"));
const TOKEN = ethers.getAddress(env("TOKEN", "0xE552Beed2265a8666d25307079fad9eDA2D70172"));
const MAKER_API = env("MAKER_API", "http://127.0.0.1:18797");
const SEAM_BIN = env("SEAM_BIN", "seam");
const WALLET_DIR = env("WALLET_DIR");
const STATUS = ["None", "Open", "Resolving", "Matched", "Funding", "Funded", "Proven", "Settled", "Refunded", "NoMatch", "Void"];
const U64 = (1n << 64n) - 1n;
const DESK_ABI = [
  "function nonces(address) view returns (uint64)",
  "function nextOrder(address user) view returns (bytes32 orderId, bytes32 paymentRef)",
  "function openBuy(uint64 expectedNonce, bytes32 amount, bytes32 floorZat, bytes32 mask, bytes inputProof, bytes32 receiverCommitment) returns (bytes32)",
  "function openSell(uint64 expectedNonce, bytes32 zat, bytes32 floorUsd, bytes inputProof) returns (bytes32)",
  "function getOrder(bytes32 orderId) view returns (tuple(uint8 side, uint8 status, uint8 makerCount, uint8 quoteCount, uint8 winnerSlot, address user, address winner, bytes32 paymentRef, bytes32 receiverCommitment, uint64 quoteEndBlock, uint64 fundDeadline, uint64 payDeadline, uint64 maskedAmount, bytes32 anchor, uint64 readyHeight, uint64 readyTime, bytes32 sizeHandle, bytes32 bestHandle, bytes32 escrowHandle, uint64 stepAt, uint64 proveDeadline))",
  "function resolve(bytes32 orderId)",
];
const TOKEN_ABI = ["function setOperator(address operator, uint48 until)", "function isOperator(address holder, address spender) view returns (bool)"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const gasRows: { step: string; gas: string; tx: string }[] = [];

function amountMask(salt: Uint8Array, paymentRef: string): bigint {
  const h = ethers.keccak256(ethers.concat([ethers.toUtf8Bytes("seam/amount-mask/v1"), salt, paymentRef]));
  return BigInt("0x" + h.slice(2, 18));
}

async function send(step: string, p: Promise<ethers.ContractTransactionResponse>) {
  const r = await (await p).wait();
  gasRows.push({ step, gas: r!.gasUsed.toString(), tx: r!.hash });
  log(`${step}: ${r!.gasUsed} gas (${r!.hash})`);
  return r!;
}

async function fhevm(provider: ethers.Provider): Promise<any> {
  const sdk: any = require("@fhevm/sdk/ethers");
  const { sepolia } = require("@fhevm/sdk/chains");
  if (!sdk.hasFhevmRuntimeConfig()) sdk.setFhevmRuntimeConfig({});
  await sdk.initFhevmRuntime();
  const client = sdk.createFhevmClient({ provider, chain: sepolia });
  await client.ready;
  return client;
}

async function main() {
  const which = env("E2E");
  const provider = new ethers.JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true });
  const user = new ethers.Wallet(fs.readFileSync(env("USER_KEY_FILE"), "utf8").trim(), provider);
  const desk = new ethers.Contract(DESK, DESK_ABI, user);
  log(`${which}: desk ${DESK}, user ${user.address}`);

  if (which === "handoff") {
    const orderId = env("ORDER");
    const dir = path.join(WALLET_DIR, "orders", orderId.slice(2, 18));
    const res = await fetch(`${MAKER_API}/v1/orders/${orderId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: fs.readFileSync(path.join(WALLET_DIR, "address"), "utf8").trim(), salt: fs.readFileSync(path.join(dir, "salt"), "utf8").trim() }),
    });
    log(`hand-off: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (which !== "buy" && which !== "sell") throw new Error("E2E: buy, sell or handoff");

  const token = new ethers.Contract(TOKEN, TOKEN_ABI, user);
  if (!(await token.isOperator(user.address, DESK))) {
    await send("setOperator", token.setOperator(DESK, BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400)));
  }
  let t0 = Date.now();
  const fhe = await fhevm(provider);
  log(`FHE client ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const nonce: bigint = await desk.nonces(user.address);
  const [orderId, paymentRef] = await desk.nextOrder(user.address);
  const dir = path.join(WALLET_DIR, "orders", orderId.slice(2, 18));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  log(`order ${orderId}`);

  let salt: Uint8Array | null = null;
  let address = "";
  t0 = Date.now();
  if (which === "buy") {
    address = fs.readFileSync(path.join(WALLET_DIR, "address"), "utf8").trim();
    salt = randomBytes(32);
    const saltFile = path.join(dir, "salt");
    fs.writeFileSync(saltFile, Buffer.from(salt).toString("hex"), { mode: 0o600 });
    const c = execFileSync(SEAM_BIN, ["commitment", "--address", address, "--salt-file", saltFile], { encoding: "utf8" }).trim();
    const enc = await fhe.encryptValues({
      values: [
        { type: "euint64", value: BigInt(env("BUY_USD_UNITS", "10000000")) },
        { type: "euint64", value: BigInt(env("BUY_FLOOR_ZAT", "20000000")) },
        { type: "euint64", value: amountMask(salt, paymentRef) },
      ],
      contractAddress: DESK,
      userAddress: user.address,
    });
    log(`encrypted amount, minimum and mask in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const [a, f, m] = enc.encryptedValues;
    await send("openBuy", desk.openBuy(nonce, a, f, m, enc.inputProof, c));
  } else {
    const enc = await fhe.encryptValues({
      values: [
        { type: "euint64", value: 25_000_000n },
        { type: "euint64", value: 9_000_000n },
      ],
      contractAddress: DESK,
      userAddress: user.address,
    });
    log(`encrypted amount and minimum in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const [z, f] = enc.encryptedValues;
    await send("openSell", desk.openSell(nonce, z, f, enc.inputProof));
  }

  let last = "";
  const started = Date.now();
  let since = Date.now();
  while (Date.now() - started < 20 * 60_000) {
    const o = await desk.getOrder(orderId);
    const st = STATUS[Number(o.status)];
    if (st !== last) {
      log(`${st}${st === "Open" ? ` (${o.quoteCount}/${o.makerCount} quotes; window to block ${o.quoteEndBlock})` : ""}`);
      last = st;
      since = Date.now();
    }
    if (st === "Open" && BigInt(await provider.getBlockNumber()) > o.quoteEndBlock + 4n && Date.now() - since > 90_000) {
      log("the maker hasn't resolved: resolving");
      await send("resolve (user)", desk.resolve(orderId)).catch((e) => log(`resolve: ${String(e?.shortMessage ?? e).slice(0, 120)}`));
    }
    if (["NoMatch", "Void", "Refunded", "Settled"].includes(st)) break;
    if (which === "buy" && st === "Matched") {
      const best = (BigInt(o.maskedAmount) - amountMask(salt!, paymentRef)) & U64;
      log(`winner ${o.winner}; the best sealed quote (M - R) is ${ethers.formatUnits(best, 8)} ZEC`);
      const res = await fetch(`${MAKER_API}/v1/orders/${orderId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, salt: Buffer.from(salt!).toString("hex") }),
      });
      log(`hand-off: ${res.status} ${(await res.text()).slice(0, 200)}`);
      break;
    }
    if (which === "sell" && st === "Funded") {
      const msg = `ZEC Desk receiver\nchain: 11155111\ndesk: ${DESK}\norder: ${orderId}`;
      const res = await fetch(`${MAKER_API}/v1/orders/${orderId}/receiver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: await user.signMessage(msg) }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`receiver: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      const makerSalt = ethers.getBytes(body.salt);
      fs.writeFileSync(path.join(dir, "maker-salt"), Buffer.from(makerSalt).toString("hex"), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "maker-address"), String(body.address), { mode: 0o600 });
      const ok = ((BigInt(o.maskedAmount) - 25_000_000n) & U64) === amountMask(makerSalt, paymentRef);
      log(`maker's receiver and salt received; the payer's check M - Z == R ${ok ? "holds: safe to pay" : "FAILS: do not pay"}`);
      break;
    }
    await sleep(12_000);
  }
  const out = path.join(WALLET_DIR, `e2e-${which}-${orderId.slice(2, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify({ desk: DESK, order: orderId, side: which, final: last, gas: gasRows }, null, 2) + "\n");
  log(`record: ${out}`);
  process.exit(0); // the FHE runtime's workers keep the event loop alive
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
