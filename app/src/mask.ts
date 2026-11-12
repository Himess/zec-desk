/**
 * The receiver commitment and the amount mask, as Seam's statement defines them (crates/seam-payment there):
 *   C = keccak256(salt32 || receiver43)
 *   R = u64_be(keccak256("seam/amount-mask/v1" || salt32 || paymentRef32)[0..8]),  M = Z + R mod 2^64
 * The app draws the salt, keeps it in this browser, and gives it only to the order's winning maker.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

const DOMAIN = new TextEncoder().encode("seam/amount-mask/v1");
const U64 = (1n << 64n) - 1n;

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}

export function newSalt(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

export function receiverCommitment(salt: Uint8Array, receiver: Uint8Array): string {
  if (salt.length !== 32 || receiver.length !== 43) throw new Error("salt 32 bytes, receiver 43 bytes");
  const pre = new Uint8Array(75);
  pre.set(salt, 0);
  pre.set(receiver, 32);
  return bytesToHex(keccak_256(pre));
}

export function amountMask(salt: Uint8Array, paymentRef: string): bigint {
  const ref = hexToBytes(paymentRef);
  if (salt.length !== 32 || ref.length !== 32) throw new Error("salt and paymentRef are 32 bytes");
  const pre = new Uint8Array(DOMAIN.length + 64);
  pre.set(DOMAIN, 0);
  pre.set(salt, DOMAIN.length);
  pre.set(ref, DOMAIN.length + 32);
  const h = keccak_256(pre);
  let r = 0n;
  for (let i = 0; i < 8; i++) r = (r << 8n) | BigInt(h[i]);
  return r;
}

/** M = Z + R mod 2^64. */
export function maskedAmount(z: bigint, salt: Uint8Array, paymentRef: string): bigint {
  return (z + amountMask(salt, paymentRef)) & U64;
}

/** Z = M − R mod 2^64: what a published M says to whoever knows the salt (the user, on a Buy: its best quote). */
export function unmask(m: bigint, salt: Uint8Array, paymentRef: string): bigint {
  return (m - amountMask(salt, paymentRef)) & U64;
}
