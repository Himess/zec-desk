/**
 * Sending transactions (from Encrypted Account's app): our own gas estimate on the public RPC (+25%), a low explicit
 * fee, and the receipt read from the public RPC. Reverts are decoded with the desk's custom errors.
 */
import { ethers } from "ethers";
import { DESK_ABI } from "./desk";
import type { Wallet } from "./wallet";

const ERR_IFACE = new ethers.Interface(DESK_ABI);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HINTS: Record<string, string> = {
  Paused: "The desk takes no new orders right now.",
  NonceMismatch: "Another order was opened from this wallet meanwhile (another tab?). Start again.",
  NoMakers: "No maker is allowlisted on the desk yet.",
  BadStatus: "The order is not at that step any more; the page will refresh.",
  QuoteWindowOpen: "Makers are still quoting.",
  TooSoon: "Too early: the deadline has not passed yet.",
};

function revertData(e: any): string | null {
  const cands = [e?.data, e?.error?.data, e?.info?.error?.data, e?.error?.error?.data, e?.revert?.data];
  for (const c of cands) {
    if (typeof c === "string" && /^0x[0-9a-fA-F]{8,}$/.test(c)) return c;
    if (c && typeof c === "object" && typeof c.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(c.data)) return c.data;
  }
  const m = String(e?.message ?? "").match(/data="(0x[0-9a-fA-F]{8,})"/);
  return m ? m[1] : null;
}

export function explainError(e: any): string {
  const msg = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  if (e?.code === 4001 || e?.code === "ACTION_REJECTED" || /user (rejected|denied)/i.test(msg)) return "You rejected the request in your wallet.";
  const data = revertData(e);
  if (data) {
    try {
      const d = ERR_IFACE.parseError(data);
      if (d) return HINTS[d.name] ? `${HINTS[d.name]} (${d.name})` : `The desk refused: ${d.name}`;
    } catch {
      /* not one of ours */
    }
  }
  if (/insufficient funds/i.test(msg)) return "Your wallet does not have enough Sepolia ETH for gas.";
  return msg.slice(0, 300);
}

export type Status = (text: string, hash?: string) => void;

export async function sendTx(w: Wallet, read: ethers.JsonRpcProvider, req: ethers.TransactionRequest, status: Status): Promise<ethers.TransactionReceipt> {
  status("Preparing…");
  const [block, tipHex] = await Promise.all([read.getBlock("latest"), read.send("eth_maxPriorityFeePerGas", []).catch(() => "0x0")]);
  const base = block?.baseFeePerGas ?? 1_000_000n;
  let tip = BigInt(tipHex) * 2n;
  if (tip < 1_000_000n) tip = 1_000_000n;
  const maxFeePerGas = base * 3n + tip;
  let gas = 0n;
  let lastErr: any = null;
  for (let i = 0; i < 4 && gas === 0n; i++) {
    try {
      gas = await read.estimateGas({ ...req, from: w.address });
    } catch (e) {
      lastErr = e;
      await sleep(2500);
    }
  }
  if (gas === 0n) throw new Error(explainError(lastErr));
  status("Confirm in your wallet…");
  let resp: ethers.TransactionResponse;
  try {
    resp = await w.signer.sendTransaction({ ...req, gasLimit: (gas * 125n) / 100n, maxFeePerGas, maxPriorityFeePerGas: tip, type: 2 });
  } catch (e) {
    throw new Error(explainError(e));
  }
  status("Waiting for the block…", resp.hash);
  const receipt = await read.waitForTransaction(resp.hash, 1, 600_000);
  if (!receipt) throw new Error("Timed out waiting for the transaction.");
  if (receipt.status !== 1) throw new Error(`The transaction reverted (${resp.hash.slice(0, 10)}…).`);
  return receipt;
}
