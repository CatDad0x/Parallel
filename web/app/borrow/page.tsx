"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { morphoAbi, routerAbi, tokenAbi, marketParams } from "@equora/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useSteps } from "@/lib/hooks";
import { useMarkets } from "@/lib/lending";
import { collateralName, loanCurrency, marketsFor, safetyOf } from "@/lib/names";
import { money, num, pct } from "@/lib/format";
import { Mark } from "@/components/Logo";
import { SafetyMeter, SafetyLabel } from "@/components/Safety";

const priceAbi = [{ type: "function", name: "price", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;

export default function Borrow() {
  const { address } = useAccount();
  const { currency } = useCurrency();
  const markets = marketsFor(currency);
  const { states, refetch } = useMarkets(markets);
  const [sel, setSel] = useState(0);
  const st = states[Math.min(sel, Math.max(0, states.length - 1))];
  const m = st?.m;
  const cur = m ? loanCurrency(m) : undefined;
  const sym = cur?.symbol ?? "";

  const { balances, refetch: refetchBal } = useBalances(markets.map((x) => x.collateralToken));
  const { data: oraclePrices } = useReadContract({ address: m?.oracle, abi: priceAbi, functionName: "price", query: { enabled: !!m } });
  const { data: allowColl } = useReadContract({
    address: m?.collateralToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address && !!m },
  });

  // Value of one collateral unit (18 dp) in the loan currency (6 dp), from the Morpho oracle.
  const unitValue = oraclePrices ? (Number(oraclePrices) / 1e36) * 1e12 : 0;
  const walletColl = balances[Math.min(sel, balances.length - 1)] ?? 0n;
  const postedValue = st ? (Number(st.user.collateral) / 1e18) * unitValue : 0;
  const walletValue = (Number(walletColl) / 1e18) * unitValue;
  const openLtv = m ? Number(BigInt(m.maxOpenLtv)) / 1e18 : 0;
  const lltv = m ? Number(BigInt(m.lltv)) / 1e18 : 0;
  const debt = st?.user.borrowAssets ?? 0;
  const liquidity = st ? Math.max(0, st.supplyAssets - st.borrowAssets) : 0;
  const max = Math.max(0, Math.min((postedValue + walletValue) * openLtv - debt, liquidity) * 0.999);
  const step = max > 2000 ? 50 : 10;
  const maxRounded = Math.floor(max / step) * step;

  const [amount, setAmount] = useState(0);
  useEffect(() => setAmount((a) => Math.min(a || Math.round(maxRounded * 0.3 / step) * step, maxRounded)), [maxRounded, step]);

  const newDebt = debt + amount;
  const newColl = postedValue + walletValue;
  const newHf = newDebt > 0 && newColl > 0 ? (newColl * lltv) / newDebt : Infinity;
  const steps = useSteps();
  const [done, setDone] = useState(false);
  const disabled = !address || amount <= 0 || steps.running || newDebt / Math.max(newColl, 1e-9) > openLtv;

  async function borrow() {
    if (!m || !st) return;
    const borrowAmt = parseUnits(String(amount), 6);
    const collAmt = walletColl; // all of this investment goes in as security
    const ok = await steps.run(
      [
        { label: "Allowing Parallel Markets to borrow for you", address: deployment.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [deployment.router, true], skip: st.user.authorized },
        { label: "Approving your investment as security", address: m.collateralToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, collAmt], skip: collAmt === 0n || ((allowColl as bigint | undefined) ?? 0n) >= collAmt },
        { label: "Borrowing", address: deployment.router, abi: routerAbi, functionName: "supplyCollateralAndBorrow", args: [marketParams(m), collAmt, borrowAmt] },
      ],
      `Borrowed ${money(amount, sym)}.`,
    );
    if (ok) {
      setDone(true);
      refetch();
      refetchBal();
    }
  }

  const hasLoan = debt > 0;
  const nothingToSecure = st && walletColl === 0n && st.user.collateral === 0n;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-top"><div style={{ display: "grid", gap: 4 }}>
        <h1>Borrow</h1>
        <p className="muted">Get cash without selling. Your investment stays invested and secures the loan.</p>
      </div></div>

      <div className="split">
        <div className="main">
          {hasLoan && st && (
            <section aria-label="Your loan" style={{ display: "grid", gap: 14, padding: "16px 18px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
              <h2 className="section-title" style={{ fontSize: 14 }}><Mark />Your loan</h2>
              <div className="cells" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
                <div><span className="label">Borrowed</span><strong style={{ fontSize: 22 }}>{money(debt, sym)}</strong></div>
                <div><span className="label">Interest</span><strong style={{ fontSize: 22 }}>{pct(st.borrowApr * 100, 1)}</strong></div>
                <div><span className="label">Safety</span><span style={{ fontSize: 18 }}><SafetyLabel hf={st.user.hf} /></span></div>
              </div>
              <div><Link href={`/borrow/manage?m=${st.m.id}`} className="btn ghost small"><Mark />Manage loan</Link></div>
            </section>
          )}

          <section aria-labelledby="pick-h" style={{ display: "grid", gap: 12, padding: "16px 18px" }}>
            <h2 id="pick-h" className="section-title" style={{ fontSize: 14 }}><Mark />Borrow against</h2>
            <div role="radiogroup" aria-labelledby="pick-h" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-m)", background: "var(--surface)", overflow: "hidden" }}>
              {states.map((s, i) => {
                const n = collateralName(s.m);
                const on = i === sel;
                const bal = balances[i] ?? 0n;
                return (
                  <button
                    key={s.m.id}
                    role="radio"
                    aria-checked={on}
                    onClick={() => { setSel(i); setDone(false); steps.reset(); }}
                    style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", minHeight: 68, padding: "0 18px", border: 0, borderTop: i ? "1px solid var(--line-2)" : 0, background: on ? "var(--paper)" : "var(--surface)", boxShadow: on ? "inset 3px 0 0 var(--accent)" : undefined, color: "var(--ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}
                  >
                    <span aria-hidden="true" style={{ flex: "none", width: 16, height: 16, boxSizing: "border-box", borderRadius: "50%", border: on ? "5px solid var(--accent)" : "1.5px solid var(--border)" }} />
                    <span style={{ display: "grid", gap: 2, flex: 1 }}>
                      <strong>{n.title}</strong>
                      <span className="small muted">{n.note} · {num(bal, 18).toLocaleString("en-AU", { maximumFractionDigits: 3 })} in your wallet{s.user.collateral > 0n ? ", some already securing a loan" : ""}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="small muted">Shares that secure a loan can&rsquo;t be sold until the loan is repaid.</span>
            {nothingToSecure && (
              <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span className="small muted">You don&rsquo;t own any of this yet, so there&rsquo;s nothing to borrow against.</span>
                <Link href="/invest" className="btn small">Invest first</Link>
              </div>
            )}
          </section>

          <p className="small" style={{ padding: "0 18px 18px", color: "var(--faint)", lineHeight: 1.5 }}>
            Limits are illustrative. The opening limit, and any pause on new borrowing while US markets are closed, are set by
            this app, not by the underlying lending protocol (Morpho Blue).
          </p>
        </div>

        <aside className="side" aria-label="Loan amount">
          <span className="section-title" style={{ fontSize: 16 }}><Mark />How much?</span>
          <div style={{ display: "grid", gap: 4 }}>
            <label htmlFor="borrow-amt" className="small muted">You borrow</label>
            <strong style={{ fontWeight: 650, fontSize: 34, letterSpacing: "-0.04em", lineHeight: 1, fontFeatureSettings: '"tnum" 1' }}>{money(amount, sym, 0)}</strong>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <input
              id="borrow-amt"
              type="range"
              min={0}
              max={Math.max(maxRounded, step)}
              step={step}
              value={amount}
              disabled={maxRounded <= 0}
              onChange={(e) => setAmount(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)", padding: 0, border: 0, background: "transparent" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between" }} className="small muted">
              <span>{money(0, sym, 0)}</span>
              <span>Max {money(maxRounded, sym, 0)}</span>
            </div>
          </div>

          <div style={{ display: "grid", gap: 8, padding: "14px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="small muted">Loan safety</span>
              <span style={{ color: safetyOf(newHf).color }}><SafetyLabel hf={newHf} /></span>
            </div>
            <SafetyMeter hf={newHf} />
          </div>

          <div className="rows">
            <div><span>Interest</span><span>{st ? `${pct(st.borrowApr * 100, 1)} a year, variable` : "—"}</span></div>
            <div><span>About</span><span>{st ? `${money((amount * st.borrowApr) / 12, sym)} a month` : "—"}</span></div>
          </div>
          <span className="small" style={{ color: "var(--faint)", marginTop: -8 }}>The rate goes up when more of the pool is borrowed.</span>

          <p className="caution">If your shares fall too far, some may be sold to repay the loan.</p>
          {steps.error && <p role="alert" className="notice error">{steps.error}</p>}
          {address ? (
            <button className="btn block" disabled={disabled} onClick={borrow}>
              {steps.running ? `${steps.label}…` : amount > 0 ? `Borrow ${money(amount, sym, 0)}` : "Choose an amount"}
            </button>
          ) : (
            <Link href="/start" className="btn block">Sign in to borrow</Link>
          )}
        </aside>
      </div>

      {done && st && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="b-done">
            <span className="section-title" style={{ fontSize: 14, color: "var(--accent-text)" }}><Mark />Done</span>
            <h2 id="b-done" className="big-line">{money(amount, sym, 0)} is now in your balance</h2>
            <p className="muted">Your investment stays invested and now secures the loan. Interest adds up every second until you repay.</p>
            <Link href={`/borrow/manage?m=${st.m.id}`} className="btn block">See your loan</Link>
            <button className="btn ghost" onClick={() => setDone(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
