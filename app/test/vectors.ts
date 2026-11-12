// The app's address, commitment and mask code against Seam's own values (crates/seam-cli/src/commitment.rs and
// crates/seam-payment/src/masked.rs there).   node test/run.mjs
import { f4jumble, f4jumbleInv, orchardReceiver } from "../src/ua";
import { amountMask, bytesToHex, hexToBytes, maskedAmount, receiverCommitment, unmask } from "../src/mask";

let failures = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${String(got)}, want ${String(want)}`}`);
}
function throws(name: string, f: () => unknown, needle: string) {
  try {
    f();
    failures++;
    console.log(`FAIL ${name}: did not throw`);
  } catch (e) {
    const ok = String((e as Error).message).includes(needle);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${String((e as Error).message)}`}`);
  }
}

// Seam's fixture receiver as a Testnet unified address (Orchard receiver only), with its salt and commitment.
const ADDRESS =
  "utest1j6uf5arygvvnypvh7n9pgcmt70xapzx70t3nemk2yy6646ekn2d296wyc355pvjtwnftcaukuqv687wnecvs47h9w82z4v498c58d6w8";
const RECEIVER = "0x4559029c0b5dbf941c5ad181a5fe8f45b34630f29d0c8dd8dc1cc3573386f416cb324133156d723df5e62d";
const SALT = hexToBytes("5a".repeat(32));
const COMMITMENT = "0xe8f6943c9b68fe1b382e7acb1788da4f1aa308ce514d83ba44372f31ef93b404";

eq("the address's Orchard receiver is Seam's", bytesToHex(orchardReceiver(ADDRESS)), RECEIVER);
eq("the commitment is Seam's", receiverCommitment(SALT, orchardReceiver(ADDRESS)), COMMITMENT);
eq("upper case reads the same", bytesToHex(orchardReceiver(ADDRESS.toUpperCase().replace("UTEST1", "utest1").toLowerCase())), RECEIVER);
throws("a broken checksum is refused", () => orchardReceiver(ADDRESS.slice(0, -1) + (ADDRESS.endsWith("8") ? "9" : "8")), "checksum");
throws("a Mainnet address is refused", () => orchardReceiver("u1" + ADDRESS.slice(6)), "Testnet");

// F4Jumble round trips at the lengths that matter (one block, the 64-byte cap, several G blocks).
for (const n of [48, 83, 128, 129, 300]) {
  const m = new Uint8Array(n).map((_, i) => (i * 7 + n) & 0xff);
  eq(`F4Jumble⁻¹(F4Jumble(m)) at ${n} bytes`, bytesToHex(f4jumbleInv(f4jumble(m))), bytesToHex(m));
}

// The mask vectors every Seam implementation checks.
eq("R(0, 0)", amountMask(new Uint8Array(32), "0x" + "00".repeat(32)), 0x0cd04af72b7b9602n);
eq("R(ff.., 0)", amountMask(new Uint8Array(32).fill(0xff), "0x" + "00".repeat(32)), 0xdfa08b7c9f656d57n);
const ref = "0x" + "22".repeat(32);
for (const z of [0n, 1n, 24_875_000n, (1n << 64n) - 1n]) {
  eq(`unmask(mask(${z}))`, unmask(maskedAmount(z, SALT, ref), SALT, ref), z);
}

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
