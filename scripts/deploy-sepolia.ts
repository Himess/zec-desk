/**
 * Deploys ZecDesk on Sepolia with the testnet parameters of the design (§ 4.8): its two libraries (ZecDeskMatch,
 * ZecDeskSettle), then the desk linked to them; allowlists the makers given; writes deployments/<DEPLOYMENT_NAME>.json
 * with every transaction's gas. A name whose record exists is refused.
 *
 *   DEPLOYMENT_NAME=<name> DESK_VERIFIER=<ZcashMaskedPaymentVerifier> [DESK_MAKERS=<a,b>] [DESK_TOKEN=<ERC-7984>] \
 *     npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 *
 *   DEPLOYMENT_NAME=<name> DESK_NO_PROOF=1 ...   a throwaway desk on the MOCK NoProofRelay / NoProofVerifier: everything
 *                                                but proofs, every order ending in a refund.
 *
 * The relay is the verifier's own. The token defaults to the MOCK test token (tcUSD, anyone may mint). The deployer,
 * from `.env.sepolia`, is the desk's admin. Sepolia prices code at about 1,560 gas a byte since Glamsterdam, which is
 * why the desk is three contracts: each must fit in the 2^24 gas one transaction may use.
 */
import { ethers, network } from "hardhat";
import type { ContractTransactionReceipt, TransactionReceipt } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { ROOT } from "./lib/env";

/** MOCK: the worthless test ERC-7984 token Encrypted Account's demo deployed (tcUSD, 6 decimals, public mint). */
const TEST_TOKEN = "0xE552Beed2265a8666d25307079fad9eDA2D70172";

/** Testnet parameters (MIN_WORK as Zecured's testnet tier, about 10 Testnet blocks). */
export const TESTNET_PARAMS = {
  quoteWindowBlocks: 10, // ~2 minutes of Sepolia blocks
  resolveTimeout: 3_600,
  fundWindow: 600,
  payWindow: 1_800, // seconds of Zcash time after the match (Buy) or the funding (Sell)
  proveGrace: 43_200,
  finalizeDepth: 6,
  finalizeDelay: 150,
  sellCooldownBlocks: 25,
  maxMakers: 8,
  feeShift: 0, // no fee on testnet
  maxUsd: 100_000_000n, // 100 cUSDC
  maxZat: 500_000_000n, // 5 TAZ
  minWork: 3_500_000n,
};

type GasRow = { what: string; tx: string; gasUsed: string };

async function main() {
  if (network.name !== "sepolia") throw new Error("run with --network sepolia");
  const name = process.env.DEPLOYMENT_NAME ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("set DEPLOYMENT_NAME (lower case, digits, dashes)");
  const record = path.join(ROOT, "deployments", `${name}.json`);
  if (fs.existsSync(record)) throw new Error(`${path.relative(ROOT, record)} exists: choose another DEPLOYMENT_NAME`);
  const noProof = process.env.DESK_NO_PROOF === "1";
  if (!noProof && !process.env.DESK_VERIFIER) throw new Error("set DESK_VERIFIER, or DESK_NO_PROOF=1 for a throwaway desk");
  const tokenAddr = ethers.getAddress(process.env.DESK_TOKEN ?? TEST_TOKEN);
  const makers = (process.env.DESK_MAKERS ?? "").split(",").filter(Boolean).map((m) => ethers.getAddress(m.trim()));
  const [deployer] = await ethers.getSigners();
  const gas: GasRow[] = [];
  const note = (what: string, r: TransactionReceipt | ContractTransactionReceipt | null) => {
    if (!r) throw new Error(`${what}: no receipt`);
    gas.push({ what, tx: r.hash, gasUsed: r.gasUsed.toString() });
    console.log(`${what}: ${r.gasUsed} gas (${r.hash})`);
  };

  let verifierAddr: string;
  if (noProof) {
    const relayStub = await (await ethers.getContractFactory("NoProofRelay")).deploy();
    note("NoProofRelay (MOCK)", await relayStub.deploymentTransaction()!.wait());
    const verifierStub = await (await ethers.getContractFactory("NoProofVerifier")).deploy(await relayStub.getAddress());
    note("NoProofVerifier (MOCK)", await verifierStub.deploymentTransaction()!.wait());
    verifierAddr = await verifierStub.getAddress();
  } else {
    verifierAddr = ethers.getAddress(process.env.DESK_VERIFIER!);
  }
  const verifier = await ethers.getContractAt(
    ["function relay() view returns (address)", "function imageId() view returns (bytes32)", "function selector() view returns (bytes4)", "function JOURNAL_VERSION() view returns (uint256)"],
    verifierAddr,
  );
  if ((await verifier.JOURNAL_VERSION()) !== 2n) throw new Error("the verifier is not an amount-hidden (journal version 2) verifier");
  const relay = await verifier.relay();
  console.log(`deployer ${deployer.address}; verifier ${verifierAddr} (relay ${relay}); token ${tokenAddr}`);

  const match = await (await ethers.getContractFactory("ZecDeskMatch")).deploy();
  note("ZecDeskMatch", await match.deploymentTransaction()!.wait());
  const settle = await (await ethers.getContractFactory("ZecDeskSettle")).deploy();
  note("ZecDeskSettle", await settle.deploymentTransaction()!.wait());
  const libraries = { ZecDeskMatch: await match.getAddress(), ZecDeskSettle: await settle.getAddress() };
  const Desk = await ethers.getContractFactory("ZecDesk", { libraries });
  // DESK_PROVE_GRACE (seconds) widens the proving window, e.g. for a one-off GPU proof days after the payment.
  const params = { ...TESTNET_PARAMS, proveGrace: Number(process.env.DESK_PROVE_GRACE ?? TESTNET_PARAMS.proveGrace) };
  if (!Number.isInteger(params.proveGrace) || params.proveGrace < 3_600 || params.proveGrace > 30 * 86_400) {
    throw new Error("DESK_PROVE_GRACE: 1 hour to 30 days, in seconds");
  }
  const desk = await Desk.deploy(tokenAddr, verifierAddr, relay, params, ethers.ZeroAddress, deployer.address);
  const receipt = await desk.deploymentTransaction()!.wait();
  note("ZecDesk", receipt);
  const address = await desk.getAddress();
  for (const m of makers) note(`setMaker ${m}`, await (await (desk as any).setMaker(m, true)).wait());

  fs.mkdirSync(path.dirname(record), { recursive: true });
  const out = {
    ZecDesk: address,
    libraries,
    chainId: 11155111,
    deployBlock: receipt!.blockNumber,
    admin: deployer.address,
    token: tokenAddr,
    tokenIsMock: tokenAddr === TEST_TOKEN,
    verifier: verifierAddr,
    relay,
    noProofMocks: noProof,
    verifierImageId: await verifier.imageId(),
    verifierSelector: await verifier.selector(),
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    makers,
    gas,
  };
  fs.writeFileSync(record, JSON.stringify(out, null, 2) + "\n");
  console.log(`ZecDesk ${address}; record: ${path.relative(ROOT, record)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
