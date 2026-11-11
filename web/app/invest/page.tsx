"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { routerAbi, tokenAbi, vaultAbi } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useMarketOpen, useSteps } from "@/lib/hooks";
import { PRODUCT_META, useProducts, useWallet, Notice, fmtMoney, useDeviation, usePricesReady, PricesLoading, MarketClosedNotice, useTestMoney, type Strategy } from "@/lib/pm";

type Step = "pick" | "confirm" | "done";

export default function Invest() {
  const { address } = useAccount();
  const { symbol, asset, balance, currency, refetchBalance } = useWallet();
  const { vaults, stats, refetch } = useProducts();
  const { open } = useMarketOpen();
  const dev = useDeviation();
  const steps = useSteps();
  const ready = usePricesReady(stats);
  const testMoney = useTestMoney();

  const [step, setStep] = useState<Step>("pick");
  const [sel, setSel] = useState<Strategy>("index");
  const [amounts, setAmounts] = useState<Record<Strategy, string>>({ index: "500", basket: "500" });
  const [showRisks, setShowRisks] = useState(false);
  const [result, setResult] = useState<{ worth: number; queued: boolean }>();

  const vault = vaults.find((v) => v.strategy === sel);
  const amtStr = amounts[sel];
  const parsed = useMemo(() => {
    try {
      return amtStr ? parseUnits(amtStr, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amtStr]);
  const gross = Number(parsed) / 1e6;

  const { data: preview } = useReadContract({
    address: vault?.address, abi: vaultAbi, functionName: "previewDeposit", args: [parsed],
    query: { enabled: !!vault && parsed > 0n },
  });
  const nav = stats.find((s) => s.info.strategy === sel)?.navPerShare ?? NaN;
  const shares = (preview as bigint | undefined) ?? 0n;
  const worth = Number.isFinite(nav) ? (Number(shares) / 1e18) * nav : gross;
  const cost = Math.max(0, gross - worth);
  const minOut = (shares * 995n) / 1000n;

  const { data: allowance } = useReadContract({
    address: asset.address, abi: tokenAbi, functionName: "allowance",
    args: [address!, open ? deployment.router : vault?.address ?? deployment.router],
    query: { enabled: !!address && !!vault },
  });

  const tooMuch = (s: Strategy) => Number(amounts[s] || 0) > balance;

  async function confirm() {
    if (!vault || !address) return;
    const enough = ((allowance as bigint | undefined) ?? 0n) >= parsed;
    const ok = open
      ? await steps.run(
          [
            { label: "Approving", address: asset.address, abi: tokenAbi, functionName: "approve", args: [deployment.router, parsed], skip: enough },
            { label: "Investing", address: deployment.router, abi: routerAbi, functionName: "depositWith", args: [vault.address, asset.address, parsed, minOut] },
          ],
          "",
        )
      : await steps.run(
          [
            { label: "Approving", address: asset.address, abi: tokenAbi, functionName: "approve", args: [vault.address, parsed], skip: enough },
            { label: "Placing order", address: vault.address, abi: vaultAbi, functionName: "requestDeposit", args: [parsed, address, minOut] },
          ],
          "",
        );
    if (ok) {
      setResult({ worth, queued: !open });
      setStep("done");
      refetchBalance();
      refetch();
    }
  }

  if (step === "done")
    return (
      <div className="pm-pad" style={{ maxWidth: 560, alignItems: "center", textAlign: "center", paddingTop: 72 }}>
        <span aria-hidden="true" className="pm-icon" style={{ width: 76, height: 76, background: "var(--pm-accent-soft)", fontSize: 30 }}>✓</span>
        <h1 style={{ fontSize: 28, letterSpacing: -1, lineHeight: 1.2 }}>
          {result?.queued
            ? `Order placed. It goes through when US markets open.`
            : `You now own about ${fmtMoney(result?.worth ?? 0, symbol)} of ${PRODUCT_META[sel].long}, protected from currency swings.`}
        </h1>
        <p className="pm-muted">It can take a few seconds to show in your portfolio.</p>
        <div style={{ display: "grid", gap: 10, alignSelf: "stretch", marginTop: 12 }}>
          <Link href="/borrow" className="pm-btn wide">Borrow against it</Link>
          <Link href="/portfolio" className="pm-btn sec wide">See portfolio</Link>
          <button className="pm-link" style={{ minHeight: 40, fontSize: 15 }} onClick={() => { setStep("pick"); steps.reset(); }}>Invest more</button>
        </div>
      </div>
    );

  if (step === "confirm")
    return (
      <div className="pm-pad" style={{ maxWidth: 560 }}>
        <button className="pm-btn sec sm" style={{ alignSelf: "flex-start" }} onClick={() => setStep("pick")}>← Back</button>
        <h1 className="pm-h1" style={{ fontSize: 30 }}>Check and confirm</h1>
        <div className="pm-card" style={{ padding: "6px 18px", borderRadius: 24, background: "#f1f1ec", border: 0 }}>
          <div className="pm-row" style={{ padding: "14px 0", borderBottom: "1px solid #e2e2dc" }}>
            <span className="pm-icon">{PRODUCT_META[sel].code}</span>
            <div style={{ display: "grid", gap: 2 }}>
              <strong style={{ fontSize: 16 }}>{PRODUCT_META[sel].name}</strong>
              <span className="pm-small pm-muted">Currency protection on</span>
            </div>
          </div>
          {[
            ["You pay", fmtMoney(gross, symbol, 2)],
            ["Estimated cost", fmtMoney(cost, symbol, 2)],
          ].map(([l, v]) => (
            <div key={l} className="pm-row pm-spread" style={{ padding: "14px 0", borderBottom: "1px solid #e2e2dc" }}>
              <span className="pm-muted">{l}</span><span className="num">{v}</span>
            </div>
          ))}
          <div className="pm-row pm-spread" style={{ padding: "14px 0" }}>
            <span className="pm-muted">You get</span>
            <strong className="num" style={{ fontSize: 18 }}>about {fmtMoney(worth, symbol)}</strong>
          </div>
        </div>
        <Notice>Share prices can fall, so you could get back less than you pay. Currency protection doesn&rsquo;t change that.</Notice>
        {open === false && <MarketClosedNotice what="Your order waits and goes through at the next opening price." />}
        <button className="pm-link" style={{ alignSelf: "flex-start" }} onClick={() => setShowRisks((v) => !v)} aria-expanded={showRisks}>
          {showRisks ? "Hide details" : "Learn more about the risks"}
        </button>
        {showRisks && (
          <ul className="pm-small pm-muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
            <li>This is test money on a test network. Nothing here is a real investment.</li>
            <li>Currency protection is simulated. A real hedge has costs and won&rsquo;t cancel every swing.</li>
            <li>Prices, costs and rates come from the test contracts and are illustrative.</li>
          </ul>
        )}
        <button className="pm-btn wide" disabled={steps.running || !vault || parsed === 0n} onClick={confirm}>
          {steps.running ? `${steps.label}…` : open === false ? `Place ${fmtMoney(gross, symbol)} order` : `Confirm and invest ${fmtMoney(gross, symbol)}`}
        </button>
        {steps.error && <Notice tone="red">{steps.error}</Notice>}
      </div>
    );

  return (
    <div className="pm-pad">
      <div className="pm-head">
        <h1 className="pm-h1">Invest</h1>
        <p className="pm-lede">US shares, paid and shown in {currency === "AUD" ? "Australian dollars" : currency === "EUR" ? "euros" : "Indian rupees"}. Currency protection is included.</p>
      </div>
      {!ready && <PricesLoading />}
      {open === false && <MarketClosedNotice what="Orders wait and go through at the next opening price." />}
      {dev.level >= 2 && <Notice tone="red">The exchange price is {Math.abs(dev.driftBps) / 100}% off the market price, so costs may be higher right now.</Notice>}
      <div className="pm-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        {(["index", "basket"] as Strategy[]).map((k) => {
          const amt = Number(amounts[k] || 0);
          const bad = amt > balance;
          const disabled = amt <= 0 || bad || !ready;
          return (
            <section key={k} className="pm-product" aria-label={PRODUCT_META[k].name} aria-busy={!ready}>
              <div className="pm-row">
                <span className="pm-icon" aria-hidden="true">{PRODUCT_META[k].code}</span>
                <div style={{ display: "grid", gap: 2 }}>
                  <h2 style={{ fontSize: 19, letterSpacing: -0.6, fontWeight: 800 }}>{PRODUCT_META[k].name}</h2>
                  <span className="pm-small pm-muted">{PRODUCT_META[k].sub}</span>
                </div>
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                <label htmlFor={`amt-${k}`} className="pm-small pm-muted" style={{ fontWeight: 600 }}>You invest</label>
                <div className="pm-amt">
                  <span style={{ color: amt > 0 ? undefined : "#8a9396" }}>{symbol}</span>
                  <input id={`amt-${k}`} inputMode="decimal" autoComplete="off" value={amounts[k]} aria-invalid={bad}
                    onChange={(e) => setAmounts((a) => ({ ...a, [k]: e.target.value.replace(/[^0-9.]/g, "") }))} />
                </div>
                {bad && <span role="alert" className="pm-small pm-neg">You have {fmtMoney(balance, symbol)} of test money.</span>}
              </div>
              <div className="pm-row" style={{ flexWrap: "nowrap" }}>
                {[100, 500, 1000].map((v) => (
                  <button key={v} className="pm-chip" aria-pressed={Number(amounts[k]) === v} onClick={() => setAmounts((a) => ({ ...a, [k]: String(v) }))}>{fmtMoney(v, symbol)}</button>
                ))}
              </div>
              <div className="pm-inner">
                <span className="pm-small pm-muted" style={{ padding: "10px 0 2px" }}>If the {currency} rises 10% and share prices don&rsquo;t move</span>
                <div className="pm-line"><span>Without protection</span>{ready ? <strong className="num pm-neg">{fmtMoney(amt / 1.1, symbol)}</strong> : <span className="pm-skel" />}</div>
                <div className="pm-line"><span>With protection <span className="pm-small" style={{ marginLeft: 6, padding: "2px 8px", borderRadius: 999, background: "var(--pm-accent-soft)", color: "var(--pm-accent-text)" }}>Included</span></span>{ready ? <strong className="num pm-pos">{fmtMoney(amt, symbol)}</strong> : <span className="pm-skel" />}</div>
                <span className="pm-small pm-muted" style={{ padding: "4px 0 10px" }}>Before costs. Protection also gives up gains if the {currency} falls.</span>
              </div>
              {bad && (
                <div className="pm-row" style={{ flexWrap: "nowrap" }}>
                  <button className="pm-chip" style={{ background: "#fff" }} disabled={balance <= 0} onClick={() => setAmounts((a) => ({ ...a, [k]: String(Math.floor(balance * 100) / 100) }))}>Use {fmtMoney(balance, symbol)}</button>
                  <button className="pm-chip" style={{ background: "#fff" }} disabled={testMoney.busy} onClick={testMoney.add}>{testMoney.busy ? "Adding…" : "Add test money"}</button>
                </div>
              )}
              <button className="pm-btn wide" disabled={disabled} onClick={() => { setSel(k); setStep("confirm"); steps.reset(); }}>
                {!ready ? "Waiting for prices" : tooMuch(k) ? "More than you have" : amt > 0 ? `Invest ${fmtMoney(amt, symbol)}` : "Enter an amount"}
              </button>
            </section>
          );
        })}
      </div>
      <p className="pm-small pm-muted">Share prices can fall. Costs, rates and currency protection are illustrative and simulated on test contracts. Not affiliated with any stablecoin issuer.</p>
    </div>
  );
}
