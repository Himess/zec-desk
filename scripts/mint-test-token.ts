/**
 * Mints the MOCK test token (tcUSD, public mint, no value) to a test address of this setup, from the deployer.
 *
 *   TO=<address> AMOUNT=<tcUSD, whole units> npx hardhat run scripts/mint-test-token.ts --network sepolia
 */
import { ethers, network } from "hardhat";

const TEST_TOKEN = "0xE552Beed2265a8666d25307079fad9eDA2D70172";

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const to = ethers.getAddress(process.env.TO ?? "");
  const amount = ethers.parseUnits(process.env.AMOUNT ?? "", 6);
  if (amount <= 0n || amount > 1_000_000n * 10n ** 6n) throw new Error("AMOUNT: more than 0 and at most 1,000,000");
  const token = await ethers.getContractAt(["function mint(address to, uint64 amount)"], TEST_TOKEN);
  const r = await (await token.mint(to, amount)).wait();
  console.log(`minted ${process.env.AMOUNT} tcUSD (MOCK) to ${to}: ${r!.gasUsed} gas (${r!.hash})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
