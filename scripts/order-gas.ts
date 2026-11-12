/**
 * The gas of every transaction of one order, found from the desk's events (each step emits one with the order id as
 * its first topic): who sent it, which step, the gas used and the price paid. Public chain data only.
 *
 *   ORDER=<orderId> [DESK_RECORD=deployments/<name>.json] npx hardhat run scripts/order-gas.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ROOT } from "./lib/env";

const EVENTS = [
  "event OrderOpened(bytes32 indexed orderId, uint8 side, address indexed user, bytes32 paymentRef, bytes32 receiverCommitment)",
  "event Quoted(bytes32 indexed orderId, address indexed maker)",
  "event ResolutionRequested(bytes32 indexed orderId)",
  "event Matched(bytes32 indexed orderId, address indexed winner, uint64 maskedAmount, uint64 deadline)",
  "event NoMatch(bytes32 indexed orderId)",
  "event FundingSubmitted(bytes32 indexed orderId, bytes32 receiverCommitment)",
  "event Funded(bytes32 indexed orderId, uint64 maskedAmount, uint64 payDeadline)",
  "event Voided(bytes32 indexed orderId)",
  "event SettlementPending(bytes32 indexed orderId, bytes32 anchor, uint64 readyHeight, uint64 readyTime)",
  "event SettlementDropped(bytes32 indexed orderId)",
  "event Settled(bytes32 indexed orderId)",
  "event Refunded(bytes32 indexed orderId)",
];

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const order = process.env.ORDER ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(order)) throw new Error("set ORDER to an order id");
  const rec = JSON.parse(fs.readFileSync(process.env.DESK_RECORD ?? path.join(ROOT, "deployments", "zec-desk-sepolia-noproof-1.json"), "utf8"));
  const iface = new ethers.Interface(EVENTS);
  const logs = await ethers.provider.getLogs({ address: rec.ZecDesk, topics: [null, order], fromBlock: rec.deployBlock, toBlock: "latest" });
  const rows = [];
  for (const l of logs) {
    const ev = iface.parseLog(l);
    const r = await ethers.provider.getTransactionReceipt(l.transactionHash);
    const t = await ethers.provider.getTransaction(l.transactionHash);
    rows.push({ step: ev?.name ?? "?", from: t!.from, gasUsed: r!.gasUsed.toString(), gwei: ethers.formatUnits(r!.gasPrice ?? 0n, "gwei"), tx: l.transactionHash });
  }
  for (const x of rows) console.log(`${x.step.padEnd(20)} ${x.gasUsed.padStart(9)} gas  from ${x.from}  ${x.tx}`);
  const out = path.join(ROOT, "results", `order-gas-${order.slice(2, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ desk: rec.ZecDesk, order, rows }, null, 2) + "\n");
  console.log(`record: ${path.relative(ROOT, out)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
