/**
 * Submits a Seam amount-hidden payment proof (seal.json from `seam seal` / scripts/gpu-day.sh) for a desk order, from
 * the deployer: anyone may. Checks the seal is for the desk's pinned guest first, and prints the pending settlement.
 *
 *   ORDER=<orderId> SEAL=<seal.json> [DESK_RECORD=deployments/<name>.json] \
 *     npx hardhat run scripts/submit-proof.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ROOT } from "./lib/env";

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const order = process.env.ORDER ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(order)) throw new Error("set ORDER");
  const rec = JSON.parse(fs.readFileSync(process.env.DESK_RECORD ?? path.join(ROOT, "deployments", "zec-desk-sepolia-1.json"), "utf8"));
  const seal = JSON.parse(fs.readFileSync(process.env.SEAL ?? "", "utf8"));
  if (seal.imageId.toLowerCase() !== String(rec.verifierImageId).toLowerCase()) {
    throw new Error(`the seal is for guest ${seal.imageId}, the desk's verifier pins ${rec.verifierImageId}`);
  }
  if (!String(seal.seal).toLowerCase().startsWith(String(rec.verifierSelector).toLowerCase())) {
    throw new Error(`the seal's selector is not the verifier's ${rec.verifierSelector}`);
  }
  const desk = await ethers.getContractAt(
    [
      "function proveSettlement(bytes32 orderId, bytes journal, bytes seal)",
      "event SettlementPending(bytes32 indexed orderId, bytes32 anchor, uint64 readyHeight, uint64 readyTime)",
    ],
    rec.ZecDesk,
  );
  const r = await (await desk.proveSettlement(order, seal.journal, seal.seal)).wait();
  const ev: any = r!.logs.map((l: any) => desk.interface.parseLog(l)).find((e: any) => e?.name === "SettlementPending");
  console.log(`proveSettlement: ${r!.gasUsed} gas (${r!.hash})`);
  if (ev) console.log(`pending: ready at relay height ${ev.args.readyHeight} and time ${ev.args.readyTime}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
