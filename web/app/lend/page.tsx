"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { morphoAbi, tokenAbi, marketParams, CURRENCIES } from "@equora/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useSteps } from "@/lib/hooks";
import { useMarkets } from "@/lib/lending";
import { collateralName, marketsFor } from "@/lib/names";
import { money, num, pct } from "@/lib/format";
import { Mark } from "@/components/Logo";

const NAMES: Record<string, string> = { AUD: "Australian dollars", EUR: "euros", INR: "rupees" };

export default function Earn() {
  const { address } = useAccount();
  const { currency, setCurrency, meta } = useCurrency();
  const markets = marketsFor(currency);
  const { states, refetch } = useMarkets(markets);
  const [sel, setSel] = useState(0);
  const st = states[Math.min(sel, Math.max(0, states.length - 1))];
  const m = st?.m;
  const sym = meta.symbol;

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [input, setInput] = useState("1000");
  const { balances, refetch: refetchBal } = useBalances(m ? [m.loanToken] : []);
  const { data: allowance } = useReadContract({ address: m?.loanToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.morpho], query: { enabled: !!address && !!m } });
  const steps = useSteps();
  const [done, setDone] = useState<string | null>(null);

  const wallet = num(balances[0], 6);
  const lent = st?.user.supplyAssets ?? 0;
  const liquidity = st ? Math.max(0, st.supplyAssets - st.borrowAssets) : 0;
  const canWithdraw = Math.min(lent, liquidity);
  const limited = tab === "withdraw" && lent > liquidity + 0.01;
  const max = tab === "deposit" ? wallet : canWithdraw;
  const amt = Math.min(Number(input.replace(/[^0-9.]/g, "")) || 0, max);
  const totalLent = states.reduce((a, s) => a + s.user.supplyAssets, 0);

  async function go() {
    if (!m || !address) return;
    const v = parseUnits(amt.toFixed(6), 6);
    const mp = marketParams(m);
    const ok =
      tab === "deposit"
        ? await steps.run(
            [
              { label: "Approving", address: m.loanToken, abi: tokenAbi, functionName: "approve", args: [deployment.morpho, v], skip: ((allowance as bigint | undefined) ?? 0n) >= v },
              { label: "Lending", address: deployment.morpho, abi: morphoAbi, functionName: "supply", args: [mp, v, 0n, address, "0x"] },
            ],
            "Lent.",
          )
        : await steps.run([{ label: "Withdrawing", address: deployment.morpho, abi: morphoAbi, functionName: "withdraw", args: [mp, v, 0n, address, address] }], "Withdrawn.");
    if (ok) {
      setDone(tab === "deposit" ? `You're now earning ${pct((st?.supplyApr ?? 0) * 100, 1)} a year` : "Withdrawn to your balance");
      setInput("");
      refetch();
      refetchBal();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-top">
        <div style={{ display: "grid", gap: 4 }}>
          <h1>Earn</h1>
          <p className="muted">Lend your {NAMES[currency]} to people borrowing against their investments.</p>
        </div>
        <div className="currency-seg" role="group" aria-label="Currency to lend">
          {CURRENCIES.map((c) => (
            <button key={c.code} aria-pressed={currency === c.code} onClick={() => { setCurrency(c.code); setSel(0); }}>{c.symbol}</button>
          ))}
        </div>
      </div>

      <div className="split">
        <div className="main">
          {totalLent > 0 && (
            <section aria-label="Your lending" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16, padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "grid", gap: 6 }}>
                <span className="section-title" style={{ fontSize: 14 }}><Mark />You&rsquo;re lending</span>
                <strong style={{ fontWeight: 600, fontSize: 32, letterSpacing: "-0.05em", lineHeight: 1, fontFeatureSettings: '"tnum" 1' }}>{money(totalLent, sym)}</strong>
                <span className="small muted">Interest adds up every second and is included above.</span>
              </div>
            </section>
          )}

          <section aria-labelledby="opt-h" style={{ display: "grid", gap: 12, padding: "16px 18px" }}>
            <h2 id="opt-h" className="section-title" style={{ fontSize: 14 }}><Mark />Choose how to lend</h2>
            <div role="radiogroup" aria-labelledby="opt-h" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {states.map((s, i) => {
                const n = collateralName(s.m);
                const on = i === sel;
                return (
                  <button
                    key={s.m.id}
                    role="radio"
                    aria-checked={on}
                    onClick={() => { setSel(i); steps.reset(); }}
                    style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, padding: 18, borderRadius: "var(--radius-m)", background: "var(--surface)", border: on ? "2px solid var(--accent)" : "1px solid var(--line)", color: "var(--ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}
                  >
                    <span style={{ fontSize: 13, color: "var(--muted)" }}>Lent against</span>
                    <strong style={{ fontSize: 17 }}>{n.title}</strong>
                    <span style={{ fontWeight: 650, fontSize: 28, letterSpacing: "-0.04em", lineHeight: 1, color: "var(--accent-text)" }}>{pct(s.supplyApr * 100, 1)}</span>
                    <span className="small muted">a year, variable · {pct(s.utilisation * 100, 0)} lent out</span>
                    {s.user.supplyAssets > 0 && <span className="small" style={{ fontWeight: 600 }}>You lend {money(s.user.supplyAssets, sym)}</span>}
                  </button>
                );
              })}
            </div>
            <span className="small" style={{ color: "var(--faint)" }}>The rate goes up when more of the pool is borrowed, and down when less is.</span>
          </section>
        </div>

        <aside className="side" aria-label="Deposit or withdraw">
          <div role="tablist" aria-label="Deposit or withdraw" className="currency-seg">
            {(["deposit", "withdraw"] as const).map((x) => (
              <button
                key={x}
                role="tab"
                aria-selected={tab === x}
                aria-pressed={tab === x}
                onClick={() => { setTab(x); setInput(""); steps.reset(); }}
                style={{ minHeight: 36, fontSize: 14, ...(tab === x ? { background: "var(--paper-2)", color: "var(--ink)", boxShadow: "inset 0 -2px 0 var(--accent)" } : {}) }}
              >
                {x === "deposit" ? "Deposit" : "Withdraw"}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="earn-amt" className="small muted">{tab === "deposit" ? "You lend" : "You withdraw"}</label>
            <div className="amount-box">
              <span className="sym">{sym}</span>
              <input id="earn-amt" inputMode="decimal" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }} className="small">
              <span style={{ color: "var(--faint)" }}>{tab === "deposit" ? `${money(wallet, sym, 0)} available` : lent > 0 ? `${money(canWithdraw, sym)} can be withdrawn now` : "Nothing lent here yet"}</span>
              <button className="text-btn" style={{ fontSize: 12 }} onClick={() => setInput(String(Math.floor(max * 100) / 100))}>Max</button>
            </div>
          </div>
          {tab === "deposit" && st && (
            <div className="rows" style={{ padding: "10px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
              <div><span>You&rsquo;d earn about</span><strong>{money(amt * st.supplyApr, sym, 0)} a year</strong></div>
            </div>
          )}
          {limited && (
            <div role="status" className="caution">
              Most of this pool is lent out right now, so only <strong>{money(canWithdraw, sym)}</strong> can be withdrawn. The rest becomes available as borrowers repay.
            </div>
          )}
          <p style={{ margin: 0, padding: "12px 14px", borderRadius: "var(--radius-s)", background: "var(--paper)", border: "1px solid var(--line)", fontSize: 13, lineHeight: 1.5, color: "var(--muted)" }}>
            You earn from borrowers&rsquo; interest. Withdrawals depend on funds available, and in extreme market falls lenders can lose money.
          </p>
          {steps.error && <p role="alert" className="notice error">{steps.error}</p>}
          {address ? (
            <button className="btn block" disabled={amt <= 0 || steps.running || !m} onClick={go}>
              {steps.running ? `${steps.label}…` : amt > 0 ? `${tab === "deposit" ? "Lend" : "Withdraw"} ${money(amt, sym, 0)}` : "Enter an amount"}
            </button>
          ) : (
            <Link href="/start" className="btn block">Sign in to earn</Link>
          )}
        </aside>
      </div>

      {done && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="e-done">
            <span className="section-title" style={{ fontSize: 14, color: "var(--accent-text)" }}><Mark />Done</span>
            <h2 id="e-done" className="big-line">{done}</h2>
            <p className="muted">You can withdraw any time, up to the funds available.</p>
            <button className="btn block" onClick={() => setDone(null)}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}
