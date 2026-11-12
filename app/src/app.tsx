/**
 * ZEC Desk in the browser (testnet): buy shielded ZEC with confidential cUSDC. Makers bid sealed; the best bid wins;
 * the ZEC goes to a fresh Ironwood address and is proven on Sepolia before the maker is paid. Sell runs from the CLI.
 * Chain logic is in desk.ts / fhe.ts / tx.ts; the address and mask maths in ua.ts / mask.ts.
 */
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { ethers } from "ethers";
import { DESK, MAKER_APIS, TOKEN_DECIMALS, TOKEN_SYMBOL, addrUrl, txUrl } from "./config";
import {
  LocalOrder,
  OrderView,
  desk,
  deskConfigured,
  deskIface,
  forgetLocal,
  loadLocal,
  myOrderIds,
  readOrder,
  readProvider,
  saveLocal,
  token,
  tokenIface,
} from "./desk";
import { encrypt, publicDecrypt } from "./fhe";
import { amountMask, bytesToHex, hexToBytes, newSalt, receiverCommitment, unmask } from "./mask";
import { sendTx, explainError } from "./tx";
import { orchardReceiver } from "./ua";
import { Wallet, connectWallet, hasWallet, watchWallet } from "./wallet";

const read = readProvider();
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const fmtZec = (zat: bigint) => ethers.formatUnits(zat, 8).replace(/\.?0+$/, "");
const U64_MAX = (1n << 64n) - 1n;
const OPERATOR_DAYS = 30n;

type Tab = "swap" | "orders" | "hidden";

function App() {
  const [w, setW] = useState<Wallet | null>(null);
  const [tab, setTab] = useState<Tab>("swap");
  const [err, setErr] = useState("");
  const connect = useCallback(async () => {
    setErr("");
    try {
      setW(await connectWallet());
      watchWallet();
    } catch (e) {
      setErr(explainError(e));
    }
  }, []);
  return (
    <div class="shell">
      <header class="top">
        <div class="brand">
          <span class="mark" aria-hidden="true">◈</span> ZEC Desk <span class="tag">testnet</span>
        </div>
        <nav class="tabs" role="tablist">
          {(["swap", "orders", "hidden"] as Tab[]).map((t) => (
            <button role="tab" aria-selected={tab === t} class={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "swap" ? "Swap" : t === "orders" ? "My orders" : "What stays hidden"}
            </button>
          ))}
        </nav>
        <div class="who">{w ? <a href={addrUrl(w.address)} target="_blank" rel="noreferrer">{short(w.address)}</a> : <button class="ghost" onClick={connect}>Connect wallet</button>}</div>
      </header>
      <main>
        {!deskConfigured() && <p class="note warn">No desk is configured yet: the app opens orders once the desk is deployed on Sepolia.</p>}
        {err && <p class="note warn">{err}</p>}
        {tab === "swap" && <Swap w={w} connect={connect} onOpened={() => setTab("orders")} />}
        {tab === "orders" && <Orders w={w} connect={connect} />}
        {tab === "hidden" && <Hidden />}
      </main>
      <footer class="foot">
        Sepolia and Zcash Testnet only. Test tokens, no value. Desk <a href={addrUrl(DESK)} target="_blank" rel="noreferrer">{short(DESK)}</a>
      </footer>
    </div>
  );
}

function Swap({ w, connect, onOpened }: { w: Wallet | null; connect: () => void; onOpened: () => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [minZec, setMinZec] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState("");
  const [hash, setHash] = useState<string | undefined>();
  const [err, setErr] = useState("");
  const status = (t: string, h?: string) => {
    setBusy(t);
    if (h) setHash(h);
  };

  let addrError = "";
  if (address.trim()) {
    try {
      orchardReceiver(address);
    } catch (e) {
      addrError = (e as Error).message;
    }
  }
  let usd = 0n;
  let floor = 0n;
  try {
    usd = amount ? ethers.parseUnits(amount, TOKEN_DECIMALS) : 0n;
    floor = minZec ? ethers.parseUnits(minZec, 8) : 0n;
  } catch {
    /* shown as invalid below */
  }
  const ready = usd > 0n && usd <= U64_MAX && floor > 0n && floor <= U64_MAX && address.trim() !== "" && !addrError;

  const mint = async () => {
    if (!w) return connect();
    setErr("");
    try {
      await sendTx(w, read, { to: token(read).target as string, data: tokenIface.encodeFunctionData("mint", [w.address, 100n * 10n ** 6n]) }, status);
      setBusy("100 test cUSDC minted to your wallet.");
    } catch (e) {
      setErr(explainError(e));
      setBusy("");
    }
  };

  const open = async () => {
    if (!w) return connect();
    setErr("");
    setHash(undefined);
    try {
      const receiver = orchardReceiver(address);
      const tok = token(read);
      if (!(await tok.isOperator(w.address, DESK))) {
        const until = BigInt(Math.floor(Date.now() / 1000)) + OPERATOR_DAYS * 86_400n;
        await sendTx(w, read, { to: tok.target as string, data: tokenIface.encodeFunctionData("setOperator", [DESK, until]) }, (t, h) =>
          status(`Allowing the desk to lock your cUSDC: ${t}`, h),
        );
      }
      status("Preparing the order…");
      const salt = newSalt();
      const c = receiverCommitment(salt, receiver);
      const d = desk(read);
      const nonce: bigint = await d.nonces(w.address);
      const [orderId, paymentRef] = await d.nextOrder(w.address);
      const r = amountMask(salt, paymentRef);
      // Kept before the order is sent: the salt opens the order's commitment and nothing can recover it.
      saveLocal(w.address, { id: orderId, paymentRef, salt: bytesToHex(salt), address: address.trim() });
      status("Encrypting the amount, your minimum and your mask (first time: up to a minute)…");
      const enc = await encrypt(
        read,
        [
          { type: "euint64", value: usd },
          { type: "euint64", value: floor },
          { type: "euint64", value: r },
        ],
        DESK,
        w.address,
      );
      const data = deskIface.encodeFunctionData("openBuy", [nonce, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof, c]);
      try {
        await sendTx(w, read, { to: DESK, data }, status);
      } catch (e) {
        forgetLocal(w.address, orderId);
        throw e;
      }
      setBusy("Order open. Makers are bidding now.");
      setAmount("");
      setMinZec("");
      setAddress("");
      onOpened();
    } catch (e) {
      setErr(e instanceof Error ? e.message : explainError(e));
      setBusy("");
    }
  };

  return (
    <section class="center">
      <h1>Swap privately</h1>
      <p class="sub">Makers bid sealed. Amounts stay encrypted on Sepolia, and the ZEC arrives shielded.</p>
      <div class="card">
        <div class="card-head">
          <span>{side === "buy" ? "Buy ZEC" : "Sell ZEC"}</span>
        </div>
        {side === "buy" ? (
          <>
            <div class="box">
              <label for="amt">You send</label>
              <div class="row">
                <input id="amt" inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
                <span class="pill">{TOKEN_SYMBOL}</span>
              </div>
              <div class="chips">
                <button class="chip" onClick={mint} disabled={!!busy && !busy.endsWith(".")}>Get 100 test {TOKEN_SYMBOL}</button>
              </div>
            </div>
            <button class="flip" aria-label="Sell ZEC instead" onClick={() => setSide("sell")}>⇅</button>
            <div class="box">
              <label for="min">You receive at least</label>
              <div class="row">
                <input id="min" inputMode="decimal" placeholder="0" value={minZec} onInput={(e) => setMinZec((e.target as HTMLInputElement).value)} />
                <span class="pill zec">ZEC · shielded</span>
              </div>
              <p class="hint">The best sealed bid wins if it gives you at least this much. Nobody sees your minimum.</p>
            </div>
            <div class="box">
              <label for="ua">Your new Zcash Testnet address</label>
              <input id="ua" class="mono" placeholder="utest1…" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
              <p class={addrError ? "hint bad" : "hint"}>
                {addrError || "Use a new address for each order: a reused one lets makers link your orders. Only the winning maker ever sees it."}
              </p>
            </div>
            <p class="lock">🔒 Your cUSDC stays locked until the ZEC payment is proven on Sepolia, or until you reclaim it after the deadline.</p>
            <button class="primary" disabled={!!w && (!ready || (!!busy && !busy.endsWith(".")) || !deskConfigured())} onClick={w ? open : connect}>
              {!w ? "Connect wallet" : busy && !busy.endsWith(".") ? busy : "Open sealed order"}
            </button>
          </>
        ) : (
          <>
            <button class="flip" aria-label="Buy ZEC instead" onClick={() => setSide("buy")}>⇅</button>
            <div class="box">
              <p>Selling ZEC runs from the command line in this testnet version: you pay from your own Zcash wallet and can prove the payment yourself.</p>
              <pre class="mono small">{`zec-desk sell --zat <amount> --min-usd <cUSDC>
seam mask --salt-file maker.salt --ref <paymentRef> --zat <amount> --masked <M>
seam pay --to <maker address> --zat <amount> --ref <paymentRef> --opening paid.json`}</pre>
              <p class="hint">The maker locks its cUSDC first; you pay only after checking the published M against your amount.</p>
            </div>
          </>
        )}
        {(busy || hash) && (
          <p class="status">
            {busy}
            {hash && (
              <>
                {" "}
                <a href={txUrl(hash)} target="_blank" rel="noreferrer">transaction</a>
              </>
            )}
          </p>
        )}
        {err && <p class="status bad">{err}</p>}
      </div>
    </section>
  );
}

function Orders({ w, connect }: { w: Wallet | null; connect: () => void }) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [block, setBlock] = useState({ n: 0n, t: 0n });
  const [err, setErr] = useState("");
  const refresh = useCallback(async () => {
    if (!w || !deskConfigured()) return;
    try {
      const ids = await myOrderIds(w.address);
      const [views, b] = await Promise.all([Promise.all(ids.map((id) => readOrder(read, id))), read.getBlock("latest")]);
      setOrders(views);
      setBlock({ n: BigInt(b?.number ?? 0), t: BigInt(b?.timestamp ?? 0) });
      setErr("");
    } catch (e) {
      setErr(explainError(e));
    }
  }, [w]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 12_000);
    return () => clearInterval(t);
  }, [refresh]);
  if (!w) {
    return (
      <section class="center">
        <button class="primary" onClick={connect}>Connect wallet to see your orders</button>
      </section>
    );
  }
  return (
    <section class="center wide">
      <h1>My orders</h1>
      {err && <p class="note warn">{err}</p>}
      {orders === null ? <p class="sub">Reading the desk…</p> : orders.length === 0 ? <p class="sub">No orders yet.</p> : null}
      {orders?.map((o) => <OrderCard key={o.id} o={o} w={w} block={block} onChange={refresh} />)}
    </section>
  );
}

const STEPS = ["Open", "Resolving", "Matched", "Proven", "Settled"] as const;

function OrderCard({ o, w, block, onChange }: { o: OrderView; w: Wallet; block: { n: bigint; t: bigint }; onChange: () => void }) {
  const local: LocalOrder | undefined = loadLocal(w.address)[o.id];
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const status = (t: string) => setBusy(t);
  const run = (f: () => Promise<void>) => async () => {
    setErr("");
    try {
      await f();
      setBusy("");
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : explainError(e));
      setBusy("");
    }
  };
  const best = local && o.maskedAmount > 0n ? unmask(o.maskedAmount, hexToBytes(local.salt), o.paymentRef) : null;
  const api = MAKER_APIS[o.winner.toLowerCase()] ?? MAKER_APIS[o.winner];
  const at = STEPS.indexOf(o.status as (typeof STEPS)[number]);
  const done = o.status === "Settled" || o.status === "Refunded" || o.status === "NoMatch" || o.status === "Void";

  useEffect(() => {
    if (done && local) forgetLocal(w.address, o.id); // the secret is no longer needed
  }, [done]);

  const handOff = run(async () => {
    if (!local || !api) throw new Error("No hand-off address for this maker.");
    status("Sending your address and salt to the winning maker…");
    const res = await fetch(`${api}/v1/orders/${o.id}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: local.address, salt: local.salt }),
    });
    if (!res.ok) throw new Error(`The maker refused the hand-off: ${(await res.text()).slice(0, 200)}`);
    saveLocal(w.address, { ...local, handedOff: true });
  });
  const resolve = run(async () => {
    await sendTx(w, read, { to: DESK, data: deskIface.encodeFunctionData("resolve", [o.id]) }, status);
  });
  const publish = run(async () => {
    const h = await desk(read).publicationHandles(o.id);
    status("Asking Zama's KMS for the result…");
    const p = await publicDecrypt(read, [h.winner, h.masked], (s) => status(`Asking Zama's KMS for the result… ${s} s`));
    await sendTx(w, read, { to: DESK, data: deskIface.encodeFunctionData("publishBuyResolution", [o.id, p.cleartexts, p.proof]) }, status);
  });
  const refund = run(async () => {
    await sendTx(w, read, { to: DESK, data: deskIface.encodeFunctionData("refund", [o.id]) }, status);
  });

  const canResolve = o.status === "Open" && block.n > o.quoteEndBlock;
  const canPublish = o.status === "Resolving" && block.t > o.stepAt + 60n;
  const canRefund =
    o.status === "NoMatch" || (o.status === "Matched" && o.proveDeadline > 0n && block.t > o.proveDeadline);

  return (
    <article class="order">
      <div class="order-head">
        <span>
          {o.side} · <span class="mono">{short(o.id)}</span>
        </span>
        <span class={`chip-status s-${o.status.toLowerCase()}`}>{o.status === "NoMatch" ? "No match" : o.status}</span>
      </div>
      {!done && (
        <ol class="steps">
          {STEPS.map((s, i) => (
            <li class={i < at ? "past" : i === at ? "now" : ""}>{s}</li>
          ))}
        </ol>
      )}
      <div class="order-body">
        {o.status === "Open" && <p>{o.quoteCount} of {o.makerCount} makers have bid. Bidding closes at block {o.quoteEndBlock.toString()}.</p>}
        {o.status === "Resolving" && <p>Comparing the best bid with your minimum, under encryption.</p>}
        {best !== null && o.status !== "NoMatch" && (
          <p>
            You receive <b>{fmtZec(best)} ZEC</b>, the best sealed bid, from maker{" "}
            <a href={addrUrl(o.winner)} target="_blank" rel="noreferrer" class="mono">{short(o.winner)}</a>.
          </p>
        )}
        {o.status === "Matched" && local && !local.handedOff && (
          <p>The winning maker needs your Zcash address to pay. Only this maker receives it, with the salt that proves it is the order's.</p>
        )}
        {o.status === "Matched" && local?.handedOff && <p>The maker is paying. The payment is proven on Sepolia before your cUSDC is released to it.</p>}
        {o.status === "Proven" && <p>The payment is proven. The desk releases your cUSDC to the maker after a few more Zcash blocks.</p>}
        {o.status === "Settled" && <p>Done: the ZEC is in your Zcash wallet.</p>}
        {o.status === "NoMatch" && <p>No bid met your minimum. Your cUSDC can come back to you.</p>}
        {o.status === "Refunded" && <p>Your cUSDC came back to you.</p>}
        {!local && !done && o.side === "Buy" && <p class="hint bad">This browser does not hold this order's salt (another device?). The hand-off has to come from where the order was opened.</p>}
      </div>
      <div class="actions">
        {o.status === "Matched" && local && !local.handedOff && (
          <button class="primary small" onClick={handOff} disabled={!!busy || !api}>{api ? "Send my address to the maker" : "This maker has no hand-off address"}</button>
        )}
        {canResolve && <button class="ghost" onClick={resolve} disabled={!!busy}>Close the bidding</button>}
        {canPublish && <button class="ghost" onClick={publish} disabled={!!busy}>Publish the result</button>}
        {canRefund && <button class="ghost" onClick={refund} disabled={!!busy}>Get my cUSDC back</button>}
      </div>
      {busy && <p class="status">{busy}</p>}
      {err && <p class="status bad">{err}</p>}
    </article>
  );
}

function Row({ k, children }: { k: string; children: ComponentChildren }) {
  return (
    <tr>
      <th scope="row">{k}</th>
      <td>{children}</td>
    </tr>
  );
}

function Hidden() {
  return (
    <section class="center wide">
      <h1>What stays hidden</h1>
      <p class="sub">What each party and each observer can learn from a Buy order, in this testnet version.</p>
      <table class="facts">
        <tbody>
          <Row k="Your cUSDC amount">Encrypted on Sepolia. The makers allowed on the order can decrypt it to price their bids.</Row>
          <Row k="Your minimum">Encrypted. Only the desk compares it, under FHE.</Row>
          <Row k="The bids">Encrypted. Losing bids are never revealed; the winning bid only to you.</Row>
          <Row k="The ZEC amount">Not on Sepolia: the desk publishes M = Z + R, where R comes from your secret salt. M looks random to everyone else.</Row>
          <Row k="Your Zcash address">Never on Sepolia: only a salted commitment. The winning maker receives it off chain.</Row>
          <Row k="The Zcash payment">Shielded (Ironwood). Its txid, note and address never reach Sepolia; the proof shows it paid at least the amount.</Row>
          <Row k="Public">That you opened a Buy order, when, from which EVM address, which maker won, and the timing of each step.</Row>
        </tbody>
      </table>
      <p class="hint">Who you trust: Zcash proof of work through the Seam relay, RISC Zero's proof system, Zama's key holders and coprocessors, and the desk's admin for the maker list. No custodian, no bridge.</p>
    </section>
  );
}

if (!hasWallet()) console.info("No browser wallet: the app can still be read.");
render(<App />, document.getElementById("app")!);
