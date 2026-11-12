import { FhevmType } from "@fhevm/hardhat-plugin";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";

const ethers = hre.ethers;
const coder = E.AbiCoder.defaultAbiCoder();

const NU7 = 0x77190ad9;
const NONE = 255;
const HCU_TX_LIMIT = 20_000_000;
const HCU_DEPTH_LIMIT = 5_000_000;
const RECORD = process.env.WRITE_RESULTS === "1";

const Status = { None: 0, Open: 1, Resolving: 2, Matched: 3, Funding: 4, Funded: 5, Proven: 6, Settled: 7, Refunded: 8, NoMatch: 9, Void: 10 } as const;

const PARAMS = {
  quoteWindowBlocks: 5,
  resolveTimeout: 3600,
  fundWindow: 600,
  payWindow: 1800,
  proveGrace: 12 * 3600,
  finalizeDepth: 6,
  finalizeDelay: 150,
  sellCooldownBlocks: 0,
  maxMakers: 8,
  feeShift: 0,
  maxUsd: 100_000_000n, // 100 tcUSD
  maxZat: 500_000_000n, // 5 TAZ
  minWork: 1000n,
};

// ── helpers for the receiving side's secrets (never sent to the chain in clear)
const MASK_DOMAIN = E.toUtf8Bytes("seam/amount-mask/v1");
/** R = first 8 bytes of keccak256("seam/amount-mask/v1" || salt32 || paymentRef32), as Seam's masked statement. */
const maskOf = (salt: string, paymentRef: string): bigint => BigInt(E.dataSlice(E.keccak256(E.concat([MASK_DOMAIN, salt, paymentRef])), 0, 8));
const commitmentOf = (salt: string, receiver43: string): string => E.keccak256(E.concat([salt, receiver43]));
const newReceiver = () => {
  const salt = E.hexlify(E.randomBytes(32));
  const receiver = E.hexlify(E.randomBytes(43)); // stands in for an Ironwood receiver
  return { salt, receiver, commitment: commitmentOf(salt, receiver) };
};
const U64 = 1n << 64n;
const addMod64 = (a: bigint, b: bigint) => (a + b) % U64;
const journalV2 = (anchor: string, paymentRef: string, receiverCommitment: string, masked: bigint) =>
  coder.encode(["uint8", "uint32", "bytes32", "bytes32", "bytes32", "uint64"], [2, NU7, anchor, paymentRef, receiverCommitment, masked]);
const GOOD_SEAL = "0x01";

describe("ZecDesk (FHEVM mock)", function () {
  this.timeout(1_200_000);

  let admin: any, user: any, m1: any, m2: any, m3: any, other: any, feeTo: any;
  let token: any, relay: any, verifier: any, desk: any, deskAddr: string;
  const hcuRows: { op: string; hcu: number; depth: number; gas: number }[] = [];

  const note = (op: string, rc: any) => {
    if (hcuRows.some((r) => r.op === op)) return;
    const h = hre.fhevm.computeTransactionHCU(rc);
    hcuRows.push({ op, hcu: Number(h.globalHCU), depth: Number(h.maxHCUDepth), gas: Number(rc.gasUsed) });
  };

  after(() => {
    if (!hcuRows.length) return;
    console.table(hcuRows);
    for (const r of hcuRows) {
      if (r.hcu > HCU_TX_LIMIT || r.depth > HCU_DEPTH_LIMIT) throw new Error(`HCU limit exceeded by ${r.op}`);
    }
    if (RECORD) {
      fs.mkdirSync(path.join(process.cwd(), "results"), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), "results", "desk-hcu-mock.json"), JSON.stringify({ limits: { tx: HCU_TX_LIMIT, depth: HCU_DEPTH_LIMIT }, rows: hcuRows }, null, 2));
    }
  });

  /** The desk's two libraries (ZecDeskMatch, ZecDeskSettle), deployed once and linked into every desk. */
  let libs: Record<string, string> | undefined;
  async function deskLibraries(): Promise<Record<string, string>> {
    if (!libs) {
      const m = await (await ethers.getContractFactory("ZecDeskMatch")).deploy();
      const s = await (await ethers.getContractFactory("ZecDeskSettle")).deploy();
      await Promise.all([m.waitForDeployment(), s.waitForDeployment()]);
      libs = { ZecDeskMatch: await m.getAddress(), ZecDeskSettle: await s.getAddress() };
    }
    return libs;
  }

  async function deployDesk(params: any = PARAMS) {
    const d = await (await ethers.getContractFactory("ZecDesk", { libraries: await deskLibraries() })).deploy(
      await token.getAddress(),
      await verifier.getAddress(),
      await relay.getAddress(),
      params,
      feeTo.address,
      admin.address,
    );
    await d.waitForDeployment();
    const addr = await d.getAddress();
    for (const m of [m1, m2, m3]) await (await (d.connect(admin) as any).setMaker(m.address, true)).wait();
    const until = 2n ** 40n;
    for (const s of [user, m1, m2, m3, other]) await (await token.connect(s).setOperator(addr, until)).wait();
    return { d, addr };
  }

  beforeEach(async () => {
    [admin, user, m1, m2, m3, other, feeTo] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("TestConfidentialUSD")).deploy();
    relay = await (await ethers.getContractFactory("MockRelay")).deploy();
    verifier = await (await ethers.getContractFactory("MockMaskedVerifier")).deploy(await relay.getAddress());
    for (const s of [user, m1, m2, m3, other]) await (await token.mint(s.address, 1_000_000_000n)).wait(); // 1,000 tcUSD each
    ({ d: desk, addr: deskAddr } = await deployDesk());
  });

  // ── encryption and decryption helpers
  async function enc(signer: any, values: bigint[]) {
    const inp = hre.fhevm.createEncryptedInput(deskAddr, signer.address);
    for (const v of values) inp.add64(v);
    return await inp.encrypt();
  }
  async function balanceOf(addr: string): Promise<bigint> {
    const h = await token.confidentialBalanceOf(addr);
    if (h === E.ZeroHash) return 0n;
    return await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, h);
  }
  async function decrypt64(handle: string): Promise<bigint> {
    if (handle === E.ZeroHash) return 0n;
    return await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  // ── order helpers
  async function openBuy(amount: bigint, floorZat: bigint, from: any = user) {
    const nonce = await desk.nonces(from.address);
    const [orderId, paymentRef] = await desk.nextOrder(from.address);
    const rcv = newReceiver();
    const R = maskOf(rcv.salt, paymentRef);
    const e = await enc(from, [amount, floorZat, R]);
    const rc = await (await desk.connect(from).openBuy(nonce, e.handles[0], e.handles[1], e.handles[2], e.inputProof, rcv.commitment)).wait();
    return { orderId, paymentRef, rcv, R, rc };
  }
  async function openSell(zat: bigint, floorUsd: bigint, from: any = user) {
    const nonce = await desk.nonces(from.address);
    const [orderId, paymentRef] = await desk.nextOrder(from.address);
    const e = await enc(from, [zat, floorUsd]);
    const rc = await (await desk.connect(from).openSell(nonce, e.handles[0], e.handles[1], e.inputProof)).wait();
    return { orderId, paymentRef, rc };
  }
  async function quote(orderId: string, maker: any, value: bigint) {
    const e = await enc(maker, [value]);
    return await (await desk.connect(maker).quote(orderId, e.handles[0], e.inputProof)).wait();
  }
  async function resolve(orderId: string) {
    await mine(PARAMS.quoteWindowBlocks + 1);
    return await (await desk.resolve(orderId)).wait();
  }
  async function publishBuy(orderId: string) {
    const [w, m] = await desk.publicationHandles(orderId);
    const res = await hre.fhevm.publicDecrypt([w, m]);
    return await (await desk.publishBuyResolution(orderId, res.abiEncodedClearValues, res.decryptionProof)).wait();
  }
  async function publishSell(orderId: string) {
    const [w] = await desk.publicationHandles(orderId);
    const res = await hre.fhevm.publicDecrypt([w]);
    return await (await desk.publishSellResolution(orderId, res.abiEncodedClearValues, res.decryptionProof)).wait();
  }
  async function fund(orderId: string, paymentRef: string, maker: any) {
    const rcv = newReceiver();
    const R = maskOf(rcv.salt, paymentRef);
    const e = await enc(maker, [R]);
    const rc = await (await desk.connect(maker).fund(orderId, rcv.commitment, e.handles[0], e.inputProof)).wait();
    return { rcv, R, rc };
  }
  async function publishFunding(orderId: string) {
    const [, m, f] = await desk.publicationHandles(orderId);
    const res = await hre.fhevm.publicDecrypt([f, m]);
    return await (await desk.publishFunding(orderId, res.abiEncodedClearValues, res.decryptionProof)).wait();
  }
  /** A Zcash header for a payment's anchor: on the best chain, at Zcash time `t`, with `workOnTop` above it. */
  async function anchorAt(t: number, workOnTop: bigint = PARAMS.minWork, height = 1000n) {
    const anchor = E.hexlify(E.randomBytes(32));
    await (await relay.setHeader(anchor, height, t, 0, true)).wait();
    await (await relay.setTip(height + 10n, workOnTop)).wait();
    return anchor;
  }
  async function makeFinal(o: any) {
    await (await relay.setTip(BigInt(o.readyHeight), PARAMS.minWork * 2n)).wait();
    await time.increaseTo(Number(o.readyTime) + 1);
  }

  // ───────────────────────────── Buy ─────────────────────────────

  it("Buy: the best quote at or above the floor wins, M = Z + R, and a proof settles the cUSDC to the winner", async () => {
    const userBefore = await balanceOf(user.address);
    const { orderId, paymentRef, rcv, R, rc } = await openBuy(50_000_000n, 100_000_000n);
    note("openBuy", rc);
    expect(await balanceOf(deskAddr)).to.eq(50_000_000n);

    // makers can decrypt the size they price from
    const o0 = await desk.getOrder(orderId);
    expect(await decrypt64(o0.sizeHandle)).to.eq(50_000_000n);

    note("quote (first)", await quote(orderId, m1, 120_000_000n));
    note("quote (better)", await quote(orderId, m2, 150_000_000n));
    await quote(orderId, m3, 130_000_000n);
    note("resolve (Buy)", await resolve(orderId));
    note("publishBuyResolution", await publishBuy(orderId));

    let o = await desk.getOrder(orderId);
    expect(o.status).to.eq(Status.Matched);
    expect(o.winner).to.eq(m2.address);
    const Z = 150_000_000n;
    expect(o.maskedAmount).to.eq(addMod64(Z, R));
    // the winner's pre-payment check: M - Z equals the R it derives from the salt the user handed over
    expect((BigInt(o.maskedAmount) - Z + U64) % U64).to.eq(maskOf(rcv.salt, paymentRef));
    // the user can read the winning quote
    expect(await decrypt64(o.bestHandle)).to.eq(Z);

    const anchor = await anchorAt(Number(o.payDeadline) - 60);
    note("proveSettlement", await (await desk.proveSettlement(orderId, journalV2(anchor, paymentRef, rcv.commitment, o.maskedAmount), GOOD_SEAL)).wait());
    o = await desk.getOrder(orderId);
    expect(o.status).to.eq(Status.Proven);
    await expect(desk.finalizeSettlement(orderId)).to.be.revertedWithCustomError(desk, "NotFinal");

    await makeFinal(o);
    const makerBefore = await balanceOf(m2.address);
    note("finalizeSettlement (no fee)", await (await desk.finalizeSettlement(orderId)).wait());
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Settled);
    expect((await balanceOf(m2.address)) - makerBefore).to.eq(50_000_000n);
    expect(await balanceOf(deskAddr)).to.eq(0n);
    expect(await balanceOf(user.address)).to.eq(userBefore - 50_000_000n);
  });

  it("Buy: ties keep the earlier quote; a quote below the floor can't win", async () => {
    const a = await openBuy(10_000_000n, 100n);
    await quote(a.orderId, m1, 500n);
    await quote(a.orderId, m2, 500n);
    await resolve(a.orderId);
    await publishBuy(a.orderId);
    expect((await desk.getOrder(a.orderId)).winner).to.eq(m1.address);

    const b = await openBuy(10_000_000n, 1_000n);
    await quote(b.orderId, m1, 999n);
    await resolve(b.orderId);
    await publishBuy(b.orderId);
    expect((await desk.getOrder(b.orderId)).status).to.eq(Status.NoMatch);
  });

  it("Buy: no quote, or none at the floor, ends in NoMatch and refunds the user", async () => {
    const before = await balanceOf(user.address);
    const a = await openBuy(20_000_000n, 1n);
    await mine(PARAMS.quoteWindowBlocks + 1);
    await (await desk.resolve(a.orderId)).wait();
    expect((await desk.getOrder(a.orderId)).status).to.eq(Status.NoMatch);
    note("refund (NoMatch Buy)", await (await desk.connect(other).refund(a.orderId)).wait());
    expect((await desk.getOrder(a.orderId)).status).to.eq(Status.Refunded);
    expect(await balanceOf(user.address)).to.eq(before);
  });

  it("Buy: the winner doesn't pay → the user takes its cUSDC back after the deadline and the grace", async () => {
    const before = await balanceOf(user.address);
    const { orderId } = await openBuy(30_000_000n, 1n);
    await quote(orderId, m1, 10n);
    await resolve(orderId);
    await publishBuy(orderId);
    const o = await desk.getOrder(orderId);
    await expect(desk.refund(orderId)).to.be.revertedWithCustomError(desk, "TooSoon");
    await time.increaseTo(Number(o.payDeadline) + PARAMS.proveGrace + 1);
    await (await desk.refund(orderId)).wait();
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Refunded);
    expect(await balanceOf(user.address)).to.eq(before);
  });

  it("Buy: a short balance moves 0; amounts above the cap are clamped", async () => {
    const big = await openBuy(500_000_000n, 1n); // 500 > cap of 100
    expect(await decrypt64((await desk.getOrder(big.orderId)).escrowHandle)).to.eq(PARAMS.maxUsd);

    const poor = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await admin.sendTransaction({ to: poor.address, value: E.parseEther("1") })).wait();
    await (await token.connect(poor).setOperator(deskAddr, 2n ** 40n)).wait();
    const z = await openBuy(10_000_000n, 1n, poor);
    expect(await decrypt64((await desk.getOrder(z.orderId)).escrowHandle)).to.eq(0n);
  });

  // ───────────────────────────── Sell ─────────────────────────────

  it("Sell: the winner funds its quote, M = Z + R', and the user's proof settles the cUSDC to the user", async () => {
    const userBefore = await balanceOf(user.address);
    const Z = 200_000_000n;
    const { orderId, paymentRef, rc } = await openSell(Z, 80_000_000n);
    note("openSell", rc);
    await quote(orderId, m1, 90_000_000n);
    await quote(orderId, m2, 95_000_000n);
    note("resolve (Sell)", await resolve(orderId));
    note("publishSellResolution", await publishSell(orderId));
    let o = await desk.getOrder(orderId);
    expect(o.status).to.eq(Status.Matched);
    expect(o.winner).to.eq(m2.address);

    const makerBefore = await balanceOf(m2.address);
    const f = await fund(orderId, paymentRef, m2);
    note("fund", f.rc);
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Funding);
    note("publishFunding", await publishFunding(orderId));
    o = await desk.getOrder(orderId);
    expect(o.status).to.eq(Status.Funded);
    expect(o.maskedAmount).to.eq(addMod64(Z, f.R));
    expect(await balanceOf(m2.address)).to.eq(makerBefore - 95_000_000n);
    // the user's pre-payment check, with the salt the maker handed over
    expect((BigInt(o.maskedAmount) - Z + U64) % U64).to.eq(maskOf(f.rcv.salt, paymentRef));

    const anchor = await anchorAt(Number(o.payDeadline) - 30);
    await (await desk.connect(other).proveSettlement(orderId, journalV2(anchor, paymentRef, f.rcv.commitment, o.maskedAmount), GOOD_SEAL)).wait();
    await makeFinal(await desk.getOrder(orderId));
    await (await desk.finalizeSettlement(orderId)).wait();
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Settled);
    expect((await balanceOf(user.address)) - userBefore).to.eq(95_000_000n);
    expect(await balanceOf(deskAddr)).to.eq(0n);
  });

  it("Sell: a winner that never funds is voided after the fund window", async () => {
    const { orderId } = await openSell(100_000_000n, 1n);
    await quote(orderId, m1, 5n);
    await resolve(orderId);
    await publishSell(orderId);
    await expect(desk.refund(orderId)).to.be.revertedWithCustomError(desk, "TooSoon");
    await time.increase(PARAMS.fundWindow + 1);
    await (await desk.refund(orderId)).wait();
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Void);
  });

  it("Sell: a short funding moves 0, publishes funded = false and voids the order", async () => {
    const { orderId, paymentRef } = await openSell(100_000_000n, 1n);
    await quote(orderId, m1, 2_000_000_000n); // more than m1's 1,000 tcUSD
    await resolve(orderId);
    await publishSell(orderId);
    const before = await balanceOf(m1.address);
    await fund(orderId, paymentRef, m1);
    await publishFunding(orderId);
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Void);
    expect(await balanceOf(m1.address)).to.eq(before);
    expect(await balanceOf(deskAddr)).to.eq(0n);
  });

  it("Sell: the user doesn't pay → the maker takes its cUSDC back after the deadline and the grace", async () => {
    const { orderId, paymentRef } = await openSell(100_000_000n, 1n);
    await quote(orderId, m3, 7_000_000n);
    await resolve(orderId);
    await publishSell(orderId);
    const before = await balanceOf(m3.address);
    await fund(orderId, paymentRef, m3);
    await publishFunding(orderId);
    const o = await desk.getOrder(orderId);
    await expect(desk.refund(orderId)).to.be.revertedWithCustomError(desk, "TooSoon");
    await time.increaseTo(Number(o.payDeadline) + PARAMS.proveGrace + 1);
    note("refund (unpaid Sell)", await (await desk.refund(orderId)).wait());
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Refunded);
    expect(await balanceOf(m3.address)).to.eq(before);
  });

  // ───────────────────────────── proofs ─────────────────────────────

  async function matchedBuy() {
    const b = await openBuy(40_000_000n, 1n);
    await quote(b.orderId, m1, 77_000_000n);
    await resolve(b.orderId);
    await publishBuy(b.orderId);
    return { ...b, o: await desk.getOrder(b.orderId) };
  }

  it("proofs: wrong reference, receiver, masked amount, late anchor, little work or a bad seal are refused", async () => {
    const { orderId, paymentRef, rcv, o } = await matchedBuy();
    const M = BigInt(o.maskedAmount);
    const good = await anchorAt(Number(o.payDeadline) - 10);
    const other32 = E.hexlify(E.randomBytes(32));
    await expect(desk.proveSettlement(orderId, journalV2(good, other32, rcv.commitment, M), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "WrongPaymentRef");
    await expect(desk.proveSettlement(orderId, journalV2(good, paymentRef, other32, M), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "WrongReceiver");
    await expect(desk.proveSettlement(orderId, journalV2(good, paymentRef, rcv.commitment, M + 1n), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "WrongMaskedAmount");
    const late = await anchorAt(Number(o.payDeadline) + 1);
    await expect(desk.proveSettlement(orderId, journalV2(late, paymentRef, rcv.commitment, M), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "PaidLate");
    const thin = await anchorAt(Number(o.payDeadline) - 10, PARAMS.minWork - 1n);
    await expect(desk.proveSettlement(orderId, journalV2(thin, paymentRef, rcv.commitment, M), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "NotEnoughWork");
    await anchorAt(Number(o.payDeadline) - 10); // restores work on top
    await expect(desk.proveSettlement(orderId, journalV2(good, paymentRef, rcv.commitment, M), "0x02")).to.be.revertedWith("MOCK: bad seal");
    await (await desk.proveSettlement(orderId, journalV2(good, paymentRef, rcv.commitment, M), GOOD_SEAL)).wait();
    await expect(desk.proveSettlement(orderId, journalV2(good, paymentRef, rcv.commitment, M), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "BadStatus");
  });

  it("proofs: a proof arriving after the deadline is accepted within the grace if the payment was in time", async () => {
    const { orderId, paymentRef, rcv, o } = await matchedBuy();
    const anchor = await anchorAt(Number(o.payDeadline) - 5);
    await time.increaseTo(Number(o.payDeadline) + 3600);
    await (await desk.proveSettlement(orderId, journalV2(anchor, paymentRef, rcv.commitment, o.maskedAmount), GOOD_SEAL)).wait();
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Proven);

    const b = await matchedBuy();
    const a2 = await anchorAt(Number(b.o.payDeadline) - 5);
    await time.increaseTo(Number(b.o.payDeadline) + PARAMS.proveGrace + 1);
    await expect(desk.proveSettlement(b.orderId, journalV2(a2, b.paymentRef, b.rcv.commitment, b.o.maskedAmount), GOOD_SEAL)).to.be.revertedWithCustomError(desk, "ProveWindowClosed");
  });

  it("proofs: an anchor that leaves the best chain is dropped and the payment proven again", async () => {
    const { orderId, paymentRef, rcv, o } = await matchedBuy();
    const a1 = await anchorAt(Number(o.payDeadline) - 20);
    await (await desk.proveSettlement(orderId, journalV2(a1, paymentRef, rcv.commitment, o.maskedAmount), GOOD_SEAL)).wait();
    await expect(desk.dropSettlement(orderId)).to.be.revertedWithCustomError(desk, "AnchorStillInBestChain");
    await (await relay.setBest(a1, false)).wait();
    await makeFinal(await desk.getOrder(orderId));
    await expect(desk.finalizeSettlement(orderId)).to.be.revertedWithCustomError(desk, "AnchorLeftBestChain");
    await (await desk.dropSettlement(orderId)).wait();
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Matched);
    const a2 = await anchorAt(Number(o.payDeadline) - 10, PARAMS.minWork, 2000n);
    await (await desk.proveSettlement(orderId, journalV2(a2, paymentRef, rcv.commitment, o.maskedAmount), GOOD_SEAL)).wait();
    await makeFinal(await desk.getOrder(orderId));
    await (await desk.finalizeSettlement(orderId)).wait();
    expect((await desk.getOrder(orderId)).status).to.eq(Status.Settled);
  });

  // ───────────────────────────── guards ─────────────────────────────

  it("guards: nonce, makers, double quotes, windows, replayed publications, a publication that never comes", async () => {
    const e = await enc(user, [1n, 1n, 1n]);
    await expect(desk.connect(user).openBuy(5, e.handles[0], e.handles[1], e.handles[2], e.inputProof, E.hexlify(E.randomBytes(32)))).to.be.revertedWithCustomError(desk, "NonceMismatch");

    const { orderId } = await openBuy(10_000_000n, 1n);
    const q = await enc(other, [1n]);
    await expect(desk.connect(other).quote(orderId, q.handles[0], q.inputProof)).to.be.revertedWithCustomError(desk, "NotAMaker");
    await quote(orderId, m1, 1n);
    const q1 = await enc(m1, [2n]);
    await expect(desk.connect(m1).quote(orderId, q1.handles[0], q1.inputProof)).to.be.revertedWithCustomError(desk, "AlreadyQuoted");
    await expect(desk.resolve(orderId)).to.be.revertedWithCustomError(desk, "QuoteWindowOpen");
    await mine(PARAMS.quoteWindowBlocks + 1);
    const q2 = await enc(m2, [3n]);
    await expect(desk.connect(m2).quote(orderId, q2.handles[0], q2.inputProof)).to.be.revertedWithCustomError(desk, "QuoteWindowClosed");
    await (await desk.resolve(orderId)).wait();
    await publishBuy(orderId);
    await expect(publishBuy(orderId)).to.be.revertedWithCustomError(desk, "BadStatus");

    // a resolution that is never published: refundable after RESOLVE_TIMEOUT
    const before = await balanceOf(user.address);
    const s = await openBuy(15_000_000n, 1n);
    await quote(s.orderId, m1, 1n);
    await resolve(s.orderId);
    await expect(desk.refund(s.orderId)).to.be.revertedWithCustomError(desk, "TooSoon");
    await time.increase(PARAMS.resolveTimeout + 1);
    await (await desk.refund(s.orderId)).wait();
    expect(await balanceOf(user.address)).to.eq(before);
  });

  it("guards: only the admin manages makers and pauses; pausing stops new orders only", async () => {
    await expect(desk.connect(user).setMaker(other.address, true)).to.be.revertedWithCustomError(desk, "OwnableUnauthorizedAccount");
    const { orderId } = await openBuy(10_000_000n, 1n);
    await (await desk.connect(admin).setPaused(true)).wait();
    const nonce = await desk.nonces(user.address);
    const e = await enc(user, [1n, 1n, 1n]);
    await expect(desk.connect(user).openBuy(nonce, e.handles[0], e.handles[1], e.handles[2], e.inputProof, E.hexlify(E.randomBytes(32)))).to.be.revertedWithCustomError(desk, "Paused");
    await quote(orderId, m1, 1n); // the open order runs on
    await (await desk.connect(admin).setMaker(m1.address, false)).wait();
    await quote(orderId, m2, 2n); // makers snapshotted at open keep quoting
  });

  it("events carry no amounts and no Zcash identifiers", async () => {
    const opened = desk.interface.getEvent("OrderOpened");
    expect(opened.inputs.map((i: any) => i.type)).to.deep.eq(["bytes32", "uint8", "address", "bytes32", "bytes32"]);
    for (const name of ["Quoted", "ResolutionRequested", "NoMatch", "Voided", "SettlementDropped", "Settled", "Refunded"]) {
      const ev = desk.interface.getEvent(name);
      expect(ev.inputs.every((i: any) => i.type !== "uint64" && i.type !== "uint256")).to.eq(true, name);
    }
  });

  // ───────────────────────────── fee ─────────────────────────────

  it("fee: with feeShift = 9 the winner receives E - (E >> 9) and the fee recipient E >> 9", async () => {
    ({ d: desk, addr: deskAddr } = await deployDesk({ ...PARAMS, feeShift: 9 }));
    const E0 = 51_200_000n;
    const { orderId, paymentRef, rcv } = await openBuy(E0, 1n);
    await quote(orderId, m1, 9n);
    await resolve(orderId);
    await publishBuy(orderId);
    const o = await desk.getOrder(orderId);
    const anchor = await anchorAt(Number(o.payDeadline) - 10);
    await (await desk.proveSettlement(orderId, journalV2(anchor, paymentRef, rcv.commitment, o.maskedAmount), GOOD_SEAL)).wait();
    await makeFinal(await desk.getOrder(orderId));
    const mBefore = await balanceOf(m1.address);
    const fBefore = await balanceOf(feeTo.address);
    note("finalizeSettlement (fee)", await (await desk.finalizeSettlement(orderId)).wait());
    expect((await balanceOf(m1.address)) - mBefore).to.eq(E0 - (E0 >> 9n));
    expect((await balanceOf(feeTo.address)) - fBefore).to.eq(E0 >> 9n);
  });
});
