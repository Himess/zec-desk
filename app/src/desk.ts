/**
 * The desk and the token as the app reads and calls them, and the user's own records of its orders: the salt and the
 * address of each Buy, kept in this browser only, until the order is over.
 */
import { ethers } from "ethers";
import { DESK, DESK_DEPLOY_BLOCK, LOG_RPC_URLS, RPC_URL, TOKEN } from "./config";

export const DESK_ABI = [
  "function nonces(address) view returns (uint64)",
  "function nextOrder(address user) view returns (bytes32 orderId, bytes32 paymentRef)",
  "function openBuy(uint64 expectedNonce, bytes32 amount, bytes32 floorZat, bytes32 mask, bytes inputProof, bytes32 receiverCommitment) returns (bytes32)",
  "function getOrder(bytes32 orderId) view returns (tuple(uint8 side, uint8 status, uint8 makerCount, uint8 quoteCount, uint8 winnerSlot, address user, address winner, bytes32 paymentRef, bytes32 receiverCommitment, uint64 quoteEndBlock, uint64 fundDeadline, uint64 payDeadline, uint64 maskedAmount, bytes32 anchor, uint64 readyHeight, uint64 readyTime, bytes32 sizeHandle, bytes32 bestHandle, bytes32 escrowHandle, uint64 stepAt, uint64 proveDeadline))",
  "function publicationHandles(bytes32 orderId) view returns (bytes32 winner, bytes32 masked, bytes32 funded)",
  "function resolve(bytes32 orderId)",
  "function publishBuyResolution(bytes32 orderId, bytes cleartexts, bytes decryptionProof)",
  "function refund(bytes32 orderId)",
  "function makers() view returns (address[])",
  "function paused() view returns (bool)",
  "function MAX_USD() view returns (uint64)",
  "function RESOLVE_TIMEOUT() view returns (uint32)",
  "event OrderOpened(bytes32 indexed orderId, uint8 side, address indexed user, bytes32 paymentRef, bytes32 receiverCommitment)",
  "error Paused()",
  "error NonceMismatch()",
  "error ZeroCommitment()",
  "error NoMakers()",
  "error BadStatus()",
  "error QuoteWindowOpen()",
  "error TooSoon()",
  "error TooManyMakers()",
];

export const TOKEN_ABI = [
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function mint(address to, uint64 amount)",
];

export const STATUS = ["None", "Open", "Resolving", "Matched", "Funding", "Funded", "Proven", "Settled", "Refunded", "NoMatch", "Void"] as const;
export type StatusName = (typeof STATUS)[number];

export type OrderView = {
  id: string;
  side: "Buy" | "Sell";
  status: StatusName;
  makerCount: number;
  quoteCount: number;
  user: string;
  winner: string;
  paymentRef: string;
  receiverCommitment: string;
  quoteEndBlock: bigint;
  payDeadline: bigint;
  maskedAmount: bigint;
  readyHeight: bigint;
  readyTime: bigint;
  stepAt: bigint;
  proveDeadline: bigint;
};

export const deskConfigured = () => DESK !== ethers.ZeroAddress;

export const readProvider = () => new ethers.JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true });
export const desk = (runner: ethers.ContractRunner) => new ethers.Contract(DESK, DESK_ABI, runner);
export const token = (runner: ethers.ContractRunner) => new ethers.Contract(TOKEN, TOKEN_ABI, runner);
export const deskIface = new ethers.Interface(DESK_ABI);
export const tokenIface = new ethers.Interface(TOKEN_ABI);

export async function readOrder(read: ethers.Provider, id: string): Promise<OrderView> {
  const v = await desk(read).getOrder(id);
  return {
    id,
    side: Number(v.side) === 0 ? "Buy" : "Sell",
    status: STATUS[Number(v.status)] ?? "None",
    makerCount: Number(v.makerCount),
    quoteCount: Number(v.quoteCount),
    user: v.user,
    winner: v.winner,
    paymentRef: v.paymentRef,
    receiverCommitment: v.receiverCommitment,
    quoteEndBlock: v.quoteEndBlock,
    payDeadline: v.payDeadline,
    maskedAmount: v.maskedAmount,
    readyHeight: v.readyHeight,
    readyTime: v.readyTime,
    stepAt: v.stepAt,
    proveDeadline: v.proveDeadline,
  };
}

/** The ids of the orders `user` opened, newest first, from the desk's OrderOpened events. */
export async function myOrderIds(user: string): Promise<string[]> {
  const topic = deskIface.getEvent("OrderOpened")!.topicHash;
  const filter = { address: DESK, topics: [topic, null, ethers.zeroPadValue(user, 32)], fromBlock: DESK_DEPLOY_BLOCK, toBlock: "latest" };
  for (const url of [...LOG_RPC_URLS, RPC_URL]) {
    try {
      const p = new ethers.JsonRpcProvider(url, 11155111, { staticNetwork: true });
      const logs = await p.getLogs(filter);
      return logs.map((l) => l.topics[1]).reverse();
    } catch {
      /* the next provider */
    }
  }
  throw new Error("Cannot read the desk's orders from any RPC.");
}

/** What the browser keeps about one of its Buy orders. The salt is a secret: it opens the order's commitment. */
export type LocalOrder = { id: string; paymentRef: string; salt: string; address: string; handedOff?: boolean };

const KEY = (user: string) => `zec-desk:orders:${DESK.toLowerCase()}:${user.toLowerCase()}`;

export function loadLocal(user: string): Record<string, LocalOrder> {
  try {
    return JSON.parse(localStorage.getItem(KEY(user)) ?? "{}");
  } catch {
    return {};
  }
}

export function saveLocal(user: string, o: LocalOrder) {
  const all = loadLocal(user);
  all[o.id] = o;
  localStorage.setItem(KEY(user), JSON.stringify(all));
}

export function forgetLocal(user: string, id: string) {
  try {
    const all = loadLocal(user);
    delete all[id];
    localStorage.setItem(KEY(user), JSON.stringify(all));
  } catch {
    /* nothing kept */
  }
}
