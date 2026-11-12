/**
 * Deploys a constructor-less contract or library from a Foundry artifact on Sepolia, with the gas the node itself
 * estimates (Foundry's local simulation doesn't know Sepolia's Glamsterdam prices). Used for Seam's ZcashEquihash
 * library before `forge script script/DeployRelay.s.sol --libraries ...`.
 *
 *   ARTIFACT=<path to out/<File>.sol/<Name>.json> npx hardhat run scripts/deploy-forge-artifact.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const path = process.env.ARTIFACT ?? "";
  const a = JSON.parse(fs.readFileSync(path, "utf8"));
  const bytecode: string = a.bytecode?.object ?? a.bytecode;
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) throw new Error("the artifact's bytecode is unlinked or missing");
  const [deployer] = await ethers.getSigners();
  const gas = await ethers.provider.estimateGas({ from: deployer.address, data: bytecode });
  const tx = await deployer.sendTransaction({ data: bytecode, gasLimit: (gas * 110n) / 100n });
  const r = await tx.wait();
  console.log(`deployed ${path.split(/[\\/]/).pop()} at ${r!.contractAddress}: ${r!.gasUsed} gas (estimate ${gas}) in ${r!.hash}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
