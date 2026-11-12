#!/usr/bin/env bash
# ZEC Desk's one GPU session: proves the desk's Buy payment once and writes seal.json. Runs ON a rented x86 machine with
# an NVIDIA GPU and Docker (a CUDA devel image), in a directory holding:
#   seam-src.tgz               Seam's source at the masked-payments work (no .env, no keys)
#   payment-masked-test.bin    the pinned amount-hidden guest (zkvm/pinned-image-ids.txt: payment-masked-test)
#   witness.json               the payment's witness (a disposable Testnet wallet's: it holds the receiver and the salt)
# Then: copy out/seal.json back, submit it (zec-desk/scripts/submit-proof.ts), and destroy the machine.
#
#   bash gpu-day.sh <masked amount M of the order>
set -euo pipefail

M="${1:?the published masked amount M of the order}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED_ID=0x482f76d7fcb1a66943e01e7e68eb00215b66d342f7a77cfe49ba499538e1bc7f
PINNED_ELF_SHA256=6eb1b7a1faa624d742929b8c352723bd386c114cd31d5694bf0531f6ad94ef6d

cd "$HERE"
echo "$PINNED_ELF_SHA256  payment-masked-test.bin" | sha256sum -c -
[[ -f witness.json ]] || { echo "witness.json missing" >&2; exit 1; }
mkdir -p seam && tar xzf seam-src.tgz -C seam --strip-components=1
cd seam

# CUDA 12.8 if the image has 13, Rust, rzup (r0vm 3.1.0, risc0-groth16 0.2.0), seam with `cuda` (no guest build).
scripts/gpu-prove.sh setup
# setup installs rustup and rzup here; this shell didn't have them on its PATH.
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$PATH"
# The Groth16 wrap runs in Docker through a seam built without `cuda`; the pinned ELF is given, so no guest is built.
RISC0_SKIP_BUILD=1 CARGO_PROFILE_RELEASE_LTO=false CARGO_TARGET_DIR="$PWD/target/guests-test" \
  cargo build --release --locked -p seam-cli --features zkvm

export SEAM_PAYMENT_MASKED_ELF="$HERE/payment-masked-test.bin"
id=$(target/release/seam image-id --masked)
[[ "$id" == "$PINNED_ID" ]] || { echo "image id $id is not the pinned $PINNED_ID" >&2; exit 1; }

SEAM_MASKED_AMOUNT="$M" scripts/gpu-prove.sh prove "$HERE/witness.json" "$HERE/out"
scripts/gpu-prove.sh wipe "$HERE/witness.json" "$HERE/out"
echo "done: $HERE/out/seal.json (and out/timings.txt); now destroy this machine"
