/**
 * Sends Sepolia test ETH from the deployer (`.env.sepolia`) to another test address of this setup, such as the
 * maker's. Sepolia only; prints the transaction and both balances, never the key.
 *
 *   TO=<address> AMOUNT=<ETH> npx hardhat run scripts/send-eth.ts --network sepolia
 */
import { ethers, network } from "hardhat";

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const to = ethers.getAddress(process.env.TO ?? "");
  const amount = ethers.parseEther(process.env.AMOUNT ?? "");
  if (amount <= 0n || amount > ethers.parseEther("0.2")) throw new Error("AMOUNT: more than 0 and at most 0.2 ETH");
  const [from] = await ethers.getSigners();
  const tx = await from.sendTransaction({ to, value: amount });
  const r = await tx.wait();
  console.log(`sent ${ethers.formatEther(amount)} ETH ${from.address} -> ${to} in ${r!.hash} (block ${r!.blockNumber})`);
  for (const a of [from.address, to]) console.log(`${a}  ${ethers.formatEther(await ethers.provider.getBalance(a))} ETH`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
