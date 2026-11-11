"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits, type Address } from "viem";
import { vaultAbi, routerAbi, tokenAbi } from "@equora/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useFx, useNavHistory, useSteps, useVaultStats } from "@/lib/hooks";
import { money, num, pct } from "@/lib/format";
import { Mark } from "@/components/Logo";

type Strategy = "index" | "basket";
const PRODUCTS: { strategy: Strategy; name: string; of: string; sub: string }[] = [
  { strategy: "index", name: "S&P 500", of: "the S&P 500", sub: "500 of the largest US companies in one investment" },
  { strategy: "basket", name: "US Tech", of: "US Tech", sub: "Apple, Microsoft, NVIDIA, Amazon and Alphabet" },
];
const SHORT: Record<string, string> = { AUD: "A$", EUR: "euro", INR: "rupee" };

export default function InvestPage() {
  const { address } = useAccount();
  const { currency, meta } = useCurrency();
  const fx = useFx()[currency];
  const [strategy, setStrategy] = useState<Strategy>("index");
  const [protect, setProtect] = useState<Record<Strategy, boolean>>({ index: true, basket: true });
  const [amount, setAmount] = useState("500");
  const [tip, setTip] = useState(false);
  const [step, setStep] = useState<"pick" | "confirm" | "done">("pick");
  const [more, setMore] = useState(false);

  const product = PRODUCTS.find((p) => p.strategy === strategy)!;
  const on = protect[strategy];
  const vault = deployment.vaults.find((v) => v.currency === currency && v.strategy === strategy && v.hedged === on);
  const { stats, refetch } = useVaultStats(vault ? [vault] : []);
  const st = stats[0];
  const points = useNavHistory(vault?.address);

  // Pay with whichever stablecoin of this currency the user holds most of (the router converts at par).
  const group = deployment.tokens.filter((t) => t.kind === "stable" && t.currency === currency);
  const { balances, refetch: refetchBal } = useBalances(group.map((t) => t.address));
  const best = group.reduce((bi, _, i) => ((balances[i] ?? 0n) > (balances[bi] ?? 0n) ? i : bi), 0);
  const token = group[best];
  const tokenBal = num(balances[best], 6);

  const amt = Number(amount.replace(/[^0-9.]/g, "")) || 0;
  const parsed = useMemo(() => {
    try {
      return amt > 0 ? parseUnits(String(amt), 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amt]);

  const { data: preview } = useReadContract({
    address: vault?.address,
    abi: vaultAbi,
    functionName: "previewDeposit",
    args: [parsed],
    query: { enabled: !!vault && parsed > 0n },
  });
  const { data: feeBps } = useReadContract({ address: vault?.address, abi: vaultAbi, functionName: "mgmtFeeBps", query: { enabled: !!vault } });
  const { data: allowance } = useReadContract({
    address: token?.address,
    abi: tokenAbi,
    functionName: "allowance",
    args: [address!, deployment.router],
    query: { enabled: !!address && !!token },
  });

  const steps = useSteps();
  const pricesReady = !!st && Number.isFinite(st.navPerShare) && st.navPerShare > 0;
  const shares = preview !== undefined ? Number(preview as bigint) / 1e18 : 0;
  const own = pricesReady ? shares * st.navPerShare : 0;
  const cost = Math.max(0, amt - own);
  const fee = feeBps !== undefined ? Number(feeBps) / 100 : undefined;
  const tooMuch = !!address && amt > tokenBal;
  const disabled = !address || !vault || amt <= 0 || tooMuch || !pricesReady || steps.running;

  // Chart: share price history from onchain NAV snapshots.
  const chart = useMemo(() => {
    if (points.length < 2) return null;
    const ys = points.map((p) => p.navPerShare);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const span = max - min || 1;
    const line = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * 600).toFixed(1)},${(200 - ((p.navPerShare - min) / span) * 180).toFixed(1)}`).join(" ");
    const change = ((ys[ys.length - 1] - ys[0]) / ys[0]) * 100;
    return { line, area: `${line} L600,220 L0,220 Z`, min, max, change };
  }, [points]);

  async function confirm() {
    if (!vault || !token || !address || preview === undefined) return;
    const minOut = ((preview as bigint) * 995n) / 1000n; // 0.5% price protection
    const ok = await steps.run(
      [
        { label: "Approving", address: token.address as Address, abi: tokenAbi, functionName: "approve", args: [deployment.router, parsed], skip: ((allowance as bigint | undefined) ?? 0n) >= parsed },
        { label: "Investing", address: deployment.router, abi: routerAbi, functionName: "depositWith", args: [vault.address, token.address, parsed, minOut] },
      ],
      "Invested.",
    );
    if (ok) {
      setStep("done");
      refetch();
      refetchBal();
    }
  }

  const sym = meta.symbol;
  const short = SHORT[currency];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-top" style={{ justifyContent: "flex-start", gap: "12px 28px" }}>
        <div role="tablist" aria-label="Choose an investment" className="currency-seg" style={{ flex: "none" }}>
          {PRODUCTS.map((p) => (
            <button
              key={p.strategy}
              role="tab"
              aria-selected={strategy === p.strategy}
              aria-pressed={strategy === p.strategy}
              onClick={() => { setStrategy(p.strategy); setTip(false); }}
              style={{ minHeight: 36, padding: "0 18px", fontSize: 14, ...(strategy === p.strategy ? { background: "var(--paper-2)", color: "var(--ink)", boxShadow: "inset 0 -2px 0 var(--accent)" } : {}) }}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <strong style={{ fontSize: 22, letterSpacing: "-0.6px", fontFeatureSettings: '"tnum" 1' }}>
              {pricesReady ? money(st.navPerShare, sym, 4) : "…"}
            </strong>
            <span className="small muted">per share</span>
            {chart && <span className={`small ${chart.change >= 0 ? "pos" : "neg"}`} style={{ fontWeight: 600 }}>{pct(chart.change, 2, true)} recently</span>}
          </span>
          <span className="small muted">{product.sub}</span>
        </div>
        {fx && (
          <span className="small muted" style={{ marginLeft: "auto", fontFeatureSettings: '"tnum" 1' }}>
            {sym}1 = US${fx.usdPerLocal.toFixed(currency === "INR" ? 5 : 4)} today
          </span>
        )}
      </div>

      <div className="split">
        <div className="main">
          <div style={{ position: "relative", padding: "16px 18px 10px", borderBottom: "1px solid var(--line)" }}>
            {chart ? (
              <svg role="img" aria-label={`${product.name} share price history`} viewBox="0 0 600 220" preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 240 }}>
                {[55, 110, 165].map((y) => <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="var(--line-2)" strokeDasharray="3 4" />)}
                <path d={chart.area} fill="var(--accent)" opacity="0.08" />
                <path d={chart.line} fill="none" stroke="var(--accent)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : (
              <div role="status" className="muted small" style={{ height: 240, display: "grid", placeItems: "center" }}>
                {pricesReady ? "Price history appears after the first few price updates." : "Getting the latest prices…"}
              </div>
            )}
          </div>

          <section aria-label="What currency protection does" style={{ display: "grid", gap: 14, padding: "16px 18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <span className="section-title" style={{ fontSize: 14 }}>
                <Mark />
                If the {short} rises 10% and shares don&rsquo;t move
              </span>
              <span className="small muted">On {money(amt, sym, 0)}, before costs</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", border: "1px solid var(--line)", borderRadius: "var(--radius-s)", overflow: "hidden" }}>
              <div style={{ display: "grid", gap: 6, padding: "16px 18px", borderRight: "1px solid var(--line)", background: on ? "transparent" : "var(--surface)" }}>
                <span className="small muted">Without protection</span>
                <span style={{ fontWeight: 600, fontSize: 28, letterSpacing: "-0.04em", color: "var(--red)" }}>{money(amt / 1.1, sym, 0)}</span>
              </div>
              <div style={{ display: "grid", gap: 6, padding: "16px 18px", background: on ? "var(--surface)" : "transparent", boxShadow: on ? "inset 0 -3px 0 var(--accent)" : undefined }}>
                <span className="small" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  With protection
                  {on && <span style={{ padding: "1px 7px", borderRadius: 4, background: "var(--accent-soft)", color: "var(--accent-text)", fontSize: 11, fontWeight: 600 }}>Your pick</span>}
                </span>
                <span style={{ fontWeight: 600, fontSize: 28, letterSpacing: "-0.04em", color: "var(--accent-text)" }}>{money(amt, sym, 0)}</span>
              </div>
            </div>
            <span className="small muted">Protection also gives up gains if the {short} falls. Share prices can still fall either way.</span>
          </section>
        </div>

        <aside className="side" aria-label="Order">
          <span className="section-title" style={{ fontSize: 16 }}>
            <Mark />
            Invest in {product.of}
          </span>

          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="amt" className="small muted">You pay</label>
            <div className={`amount-box${tooMuch ? " invalid" : ""}`}>
              <span className="sym">{sym}</span>
              <input id="amt" inputMode="decimal" autoComplete="off" value={amount} aria-invalid={tooMuch} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="chips">
              {[100, 500, 1000].map((v) => (
                <button key={v} onClick={() => setAmount(String(v))}>{money(v, sym, 0)}</button>
              ))}
            </div>
            {tooMuch && (
              <span role="alert" className="small" style={{ color: "var(--red)" }}>
                You have {money(tokenBal, sym, 0)} of test money. Lower the amount or add more from the sidebar.
              </span>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "grid", gap: 3 }}>
              <span style={{ fontWeight: 600 }}>Currency protection</span>
              <button className="text-btn" style={{ fontSize: 12 }} aria-expanded={tip} onClick={() => setTip((t) => !t)}>What&rsquo;s this?</button>
            </div>
            <button className="switch" role="switch" aria-checked={on} aria-label="Currency protection" onClick={() => setProtect((p) => ({ ...p, [strategy]: !p[strategy] }))}>
              <span />
            </button>
          </div>
          {tip && (
            <p className="small muted" style={{ marginTop: -8, lineHeight: 1.5 }}>
              It cancels out most swings between the {short} and the US dollar. It has a small cost, and it doesn&rsquo;t stop share prices falling.
            </p>
          )}

          <div className="rows">
            <div><span>You&rsquo;ll own about</span><strong>{pricesReady && amt > 0 ? money(Math.floor(own), sym, 0) : "—"}</strong></div>
            <div><span>Trading cost</span><span>{amt > 0 && preview !== undefined ? money(cost, sym) : "—"}</span></div>
            <div><span>Annual fee</span><span>{fee !== undefined ? pct(fee, 2) : "—"}</span></div>
          </div>

          {address ? (
            <button className="btn block" disabled={disabled} onClick={() => { steps.reset(); setMore(false); setStep("confirm"); }}>
              {!pricesReady ? "Waiting for prices" : amt > 0 ? `Invest ${money(amt, sym, 0)}` : "Enter an amount"}
            </button>
          ) : (
            <Link href="/start" className="btn block">Sign in to invest</Link>
          )}
          <span className="small muted" style={{ lineHeight: 1.5 }}>Share prices can fall. Currency protection is simulated; costs and rates are illustrative.</span>
        </aside>
      </div>

      {step !== "pick" && vault && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
            {step === "confirm" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 id="dlg-title" className="section-title" style={{ fontSize: 20 }}><Mark />Check and confirm</h2>
                  <button className="btn ghost small" aria-label="Close" onClick={() => setStep("pick")} disabled={steps.running}>✕</button>
                </div>
                <div className="rows lined" style={{ fontSize: 14, borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                  <div><span>Investment</span><span>{product.name} · {on ? "protected" : "no protection"}</span></div>
                  <div><span>You pay</span><strong>{money(amt, sym)}</strong></div>
                  <div><span>Trading cost</span><span>{money(cost, sym)}</span></div>
                  <div><span>Annual fee</span><span>{fee !== undefined ? `${pct(fee, 2)} a year` : "—"}</span></div>
                  <div style={{ alignItems: "flex-start" }}>
                    <span>You receive</span>
                    <span style={{ display: "grid", justifyItems: "end", gap: 2 }}>
                      <strong style={{ fontSize: 17 }}>about {money(Math.floor(own), sym, 0)} of {product.of}</strong>
                      <span className="small" style={{ color: "var(--faint)" }}>≈ {shares.toLocaleString("en-AU", { maximumFractionDigits: 4 })} {vault.symbol}</span>
                    </span>
                  </div>
                </div>
                <p className="caution">Share prices can fall, so you could get back less than you pay. Currency protection doesn&rsquo;t change that.</p>
                <button className="text-btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>{more ? "Hide details" : "Learn more about the risks"}</button>
                {more && (
                  <ul className="small muted" style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 6, lineHeight: 1.5 }}>
                    <li>This is test money on a test network. Nothing here is a real investment.</li>
                    <li>Currency protection is simulated. A real hedge has costs and won&rsquo;t cancel every swing.</li>
                    <li>Prices, costs and rates come from the test contracts and are illustrative.</li>
                    <li>You&rsquo;re protected from the price moving more than 0.5% before your order goes through.</li>
                  </ul>
                )}
                {steps.error && <p role="alert" className="notice error">{steps.error}</p>}
                <button className="btn block" onClick={confirm} disabled={steps.running}>
                  {steps.running ? `${steps.label}…` : `Confirm and invest ${money(amt, sym, 0)}`}
                </button>
              </>
            ) : (
              <>
                <span className="section-title" style={{ fontSize: 14, color: "var(--accent-text)" }}><Mark />Done</span>
                <h2 id="dlg-title" className="big-line">
                  You now own about {money(Math.floor(own), sym, 0)} of {product.of}
                  {on ? ", protected from currency swings." : ", without currency protection."}
                </h2>
                <p className="muted">It can take a few seconds to show in your portfolio.</p>
                <Link href="/borrow" className="btn block">Borrow against it</Link>
                <div style={{ display: "flex", gap: 8 }}>
                  <Link href="/portfolio" className="btn ghost" style={{ flex: 1 }}><Mark />See portfolio</Link>
                  <button className="btn ghost" style={{ flex: 1 }} onClick={() => setStep("pick")}><Mark />Invest more</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
