/**
 * Unified addresses (ZIP 316): the 43-byte Orchard-protocol receiver an Ironwood payment pays, read from a Zcash
 * Testnet unified address. Bech32m without the 90-character limit, then F4Jumble⁻¹, then the HRP padding and the
 * typecode/length/value list. Everything here runs in the browser; the address never leaves it except in the
 * hand-off to the order's maker.
 */
import { bech32m } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";

const ORCHARD_TYPECODE = 0x03;
const enc = new TextEncoder();

function personal(tag: string, i: number, j: number | null): Uint8Array {
  const p = new Uint8Array(16);
  p.set(enc.encode(tag), 0); // 13 bytes
  p[13] = i;
  if (j !== null) {
    p[14] = j & 0xff;
    p[15] = (j >> 8) & 0xff;
  }
  return p;
}

function hRound(i: number, u: Uint8Array, outLen: number): Uint8Array {
  return blake2b(u, { dkLen: outLen, personalization: personal("UA_F4Jumble_H", i, 0) });
}

function gRound(i: number, u: Uint8Array, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  for (let j = 0, at = 0; at < outLen; j++, at += 64) {
    const block = blake2b(u, { dkLen: 64, personalization: personal("UA_F4Jumble_G", i, j) });
    out.set(block.subarray(0, Math.min(64, outLen - at)), at);
  }
  return out;
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] ^ b[k];
  return out;
}

/** F4Jumble⁻¹ (ZIP 316): recovers M from F4Jumble(M). */
export function f4jumbleInv(m: Uint8Array): Uint8Array {
  if (m.length < 48 || m.length > 4194368) throw new Error("F4Jumble: length out of range");
  const lL = Math.min(64, Math.floor(m.length / 2));
  const c = m.subarray(0, lL);
  const d = m.subarray(lL);
  const y = xor(c, hRound(1, d, lL));
  const x = xor(d, gRound(1, y, d.length));
  const a = xor(y, hRound(0, x, lL));
  const b = xor(x, gRound(0, a, x.length));
  const out = new Uint8Array(m.length);
  out.set(a, 0);
  out.set(b, lL);
  return out;
}

/** F4Jumble (ZIP 316), for tests: the inverse of f4jumbleInv. */
export function f4jumble(m: Uint8Array): Uint8Array {
  const lL = Math.min(64, Math.floor(m.length / 2));
  const a = m.subarray(0, lL);
  const b = m.subarray(lL);
  const x = xor(b, gRound(0, a, b.length));
  const y = xor(a, hRound(0, x, lL));
  const d = xor(x, gRound(1, y, x.length));
  const c = xor(y, hRound(1, d, lL));
  const out = new Uint8Array(m.length);
  out.set(c, 0);
  out.set(d, lL);
  return out;
}

function compactSize(buf: Uint8Array, at: number): [number, number] {
  const first = buf[at];
  if (first === undefined) throw new Error("unified address: truncated");
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd) return [buf[at + 1] | (buf[at + 2] << 8), at + 3];
  throw new Error("unified address: an item too large");
}

/**
 * The Orchard-protocol receiver (43 bytes) of a Zcash Testnet unified address, which an Ironwood payment pays. Throws
 * on anything else: another network, a broken checksum, no such receiver.
 */
export function orchardReceiver(address: string, hrp = "utest"): Uint8Array {
  const text = address.trim();
  if (!text.toLowerCase().startsWith(hrp + "1")) throw new Error(`not a ${hrp === "utest" ? "Testnet" : hrp} unified address`);
  let decoded;
  try {
    decoded = bech32m.decode(text as `${string}1${string}`, false);
  } catch {
    throw new Error("not a unified address (checksum)");
  }
  if (decoded.prefix !== hrp) throw new Error("not a unified address of this network");
  const raw = f4jumbleInv(Uint8Array.from(bech32m.fromWords(decoded.words)));
  const pad = raw.subarray(raw.length - 16);
  const expected = new Uint8Array(16);
  expected.set(enc.encode(hrp));
  if (!pad.every((v, k) => v === expected[k])) throw new Error("not a unified address (padding)");
  const items = raw.subarray(0, raw.length - 16);
  let at = 0;
  let found: Uint8Array | null = null;
  while (at < items.length) {
    const [typecode, a1] = compactSize(items, at);
    const [len, a2] = compactSize(items, a1);
    if (a2 + len > items.length) throw new Error("unified address: truncated item");
    if (typecode === ORCHARD_TYPECODE) {
      if (len !== 43) throw new Error("unified address: an Orchard receiver is 43 bytes");
      found = items.slice(a2, a2 + len);
    }
    at = a2 + len;
  }
  if (!found) throw new Error("the address has no Ironwood (Orchard-protocol) receiver");
  return found;
}
