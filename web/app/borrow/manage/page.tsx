"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { morphoAbi, routerAbi, tokenAbi, marketParams } from "@equora/shared";
import { deployment } from "@/lib/config";
import { useBalances, useSteps } from "@/lib/hooks";
import { useMarkets } from "@/lib/lending";
import { collateralName, loanCurrency, safetyOf } from "@/lib/names";
import { money, num, pct } from "@/lib/format";
import { Mark } from "@/components/Logo";
import { SafetyLabel } from "@/components/Safety";

const priceAbi = [{ type: "function", name: "price", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;
type Tab = "repay" | "add" | "withdraw";

export default function ManageLoanPage() {
  return (
    <Suspense fallback={null}>
      <ManageLoan />
    </Suspense>
  );
}

function ManageLoan() {
  const params = useSearchParams();
  const { address } = useAccount();
  const m = deployment.markets.find((x) => x.id === params.get("m")) ?? deployment.markets[0];
  const { states, refetch } = useMarkets(useMemo(() => [m], [m]));
  const st = states[0];
  const cur = loanCurrency(m);
  const sym = cur.symbol;
  const name = collateralName(m);

  const { balances, refetch: refetchBal } = useBalances([m.collateralToken, m.loanToken]);
  const { data: price } = useReadContract({ address: m.oracle, abi: priceAbi, functionName: "price" });
  const { data: allowColl } = useReadContract({ address: m.collateralToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address } });
  const { data: allowLoan } = useReadContract({ address: m.loanToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address } });

  const unitValue = price ? (Number(price) / 1e36) * 1e12 : 0;
  const lltv = Number(BigInt(m.lltv)) / 1e18;
  const openLtv = Number(BigInt(m.maxOpenLtv)) / 1e18;
  const debt = st?.user.borrowAssets ?? 0;
  const collUnits = st ? Number(st.user.collateral) / 1e18 : 0;
  const collValue = collUnits * unitValue;
  const hf = st?.user.hf ?? Infinity;
  const level = safetyOf(hf).level;
  const fill = collValue > 0 ? Math.min(100, (debt / collValue / lltv) * 100) : 0;
  const drop = collValue > 0 && debt > 0 ? Math.max(0, 1 - debt / (lltv * collValue)) : 1;

  const [tab, setTab] = useState<Tab>("repay");
  const [input, setInput] = useState("");
  const steps = useSteps();
  const [done, setDone] = useState<string | null>(null);

  const amt = Number(input.replace(/[^0-9.]/g, "")) || 0;
  const walletLoan = num(balances[1], 6);
  const walletCollValue = (Number(balances[0] ?? 0n) / 1e18) * unitValue;
  // Withdraw up to the amount that keeps the loan at or below the opening limit.
  const maxWithdrawValue = Math.max(0, collValue - (debt > 0 ? debt / openLtv : 0));
  const limits: Record<Tab, number> = { repay: Math.min(debt, walletLoan), add: walletCollValue, withdraw: maxWithdrawValue };
  const a = Math.min(amt, limits[tab]);
  const nDebt = tab === "repay" ? debt - a : debt;
  const nColl = tab === "add" ? collValue + a : tab === "withdraw" ? collValue - a : collValue;
  const nHf = nDebt > 0 && nColl > 0 ? (nColl * lltv) / nDebt : Infinity;
  const unitsFor = (value: number) => (unitValue > 0 ? parseUnits((value / unitValue).toFixed(18), 18) : 0n);

  async function apply() {
    const mp = marketParams(m);
    let ok = false;
    if (tab === "repay") {
      const all = a >= debt * 0.9999;
      const need = all ? BigInt(Math.ceil(debt * 1.001 * 1e6)) + 1_000n : parseUnits(a.toFixed(6), 6);
      ok = await steps.run(
        [
          { label: "Approving repayment", address: m.loanToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, need], skip: ((allowLoan as bigint | undefined) ?? 0n) >= need },
          { label: all ? "Repaying in full" : "Repaying", address: deployment.router, abi: routerAbi, functionName: "repayAndWithdraw", args: [mp, all ? 0n : need, all, 0n] },
        ],
        all ? "Loan repaid." : "Repaid.",
      );
      if (ok) setDone(all ? `Loan repaid. Your ${name.title} is unlocked.` : `You now owe ${money(debt - a, sym)}`);
    } else if (tab === "add") {
      const units = a >= walletCollValue * 0.9999 ? (balances[0] ?? 0n) : unitsFor(a);
      ok = await steps.run(
        [
          { label: "Approving", address: m.collateralToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, units], skip: ((allowColl as bigint | undefined) ?? 0n) >= units },
          { label: "Adding to your loan's security", address: deployment.router, abi: routerAbi, functionName: "supplyCollateralAndBorrow", args: [mp, units, 0n] },
        ],
        "Added.",
      );
      if (ok) setDone(`Your loan is now ${safetyOf(nHf).label.toLowerCase()}`);
    } else {
      const units = unitsFor(a);
      ok = await steps.run(
        [
          { label: "Allowing Parallel Markets to manage your loan", address: deployment.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [deployment.router, true], skip: st?.user.authorized },
          { label: "Withdrawing", address: deployment.router, abi: routerAbi, functionName: "repayAndWithdraw", args: [mp, 0n, false, units] },
        ],
        "Withdrawn.",
      );
      if (ok) setDone(`${name.title} returned to you`);
    }
    if (ok) {
      setInput("");
      refetch();
      refetchBal();
    }
  }

  const TABS: { id: Tab; label: string; help: string; field: string; note: string }[] = [
    { id: "repay", label: "Repay", help: "Pay back part or all of the loan.", field: "Repay", note: `You owe ${money(debt, sym)} · ${money(walletLoan, sym, 0)} in your wallet` },
    { id: "add", label: "Add", help: `Add more ${name.title} to make the loan safer.`, field: "Add worth", note: `${money(walletCollValue, sym, 0)} available in your wallet` },
    { id: "withdraw", label: "Withdraw", help: "Take some back while the loan stays within the opening limit.", field: "Withdraw worth", note: `Up to ${money(maxWithdrawValue, sym, 0)}` },
  ];
  const t = TABS.find((x) => x.id === tab)!;
  const disabled = !address || a <= 0 || steps.running || (nDebt > 0 && nColl > 0 && nDebt / nColl > lltv);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {level > 0 && debt > 0 && (
        <div role="alert" style={{ margin: "0 0 8px", padding: "12px 16px", borderRadius: 6, fontSize: 13, lineHeight: 1.5, ...(level === 2 ? { background: "var(--red-soft)", color: "#7a2a20", borderBottom: "1px solid #f0cfca" } : { background: "var(--amber-soft)", color: "#6b3d12", borderBottom: "1px solid #eed9bc" }) }}>
          <strong>{level === 2 ? "Your loan is near the limit." : "Your loan is getting close to the limit."}</strong>{" "}
          {level === 2 ? "If prices fall a little more, some of your investment will be sold to repay part of the loan. Repay some or add more now." : "Repay a little or add more to keep it comfortable."}
        </div>
      )}

      <div className="page-top"><div style={{ display: "grid", gap: 4 }}>
        <Link href="/borrow" className="back">← Borrow</Link>
        <h1>Your loan</h1>
        <p className="muted">Repay any time. Interest adds up every second until you do.</p>
      </div></div>

      <div className="split">
        <div className="main">
          <section className="cells" aria-label="Loan summary" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", border: 0, borderBottom: "1px solid var(--line)", borderRadius: 0 }}>
            <div style={{ padding: "14px 18px" }}><span className="label">You owe</span><strong style={{ fontSize: 22 }}>{money(debt, sym)}</strong></div>
            <div style={{ padding: "14px 18px" }}><span className="label">Secured by</span><strong style={{ fontSize: 22 }}>{money(collValue, sym, 0)}</strong><span className="small" style={{ color: "var(--faint)" }}>{name.title}</span></div>
            <div style={{ padding: "14px 18px" }}><span className="label">Interest</span><strong style={{ fontSize: 22 }}>{st ? pct(st.borrowApr * 100, 1) : "—"}</strong><span className="small" style={{ color: "var(--faint)" }}>a year, variable</span></div>
          </section>

          <section aria-labelledby="safety-h" style={{ display: "grid", gap: 14, padding: "16px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 id="safety-h" className="section-title" style={{ fontSize: 14 }}><Mark />Loan safety</h2>
              {debt > 0 ? <SafetyLabel hf={hf} /> : <strong className="pos">No loan</strong>}
            </div>
            <div aria-hidden="true" style={{ position: "relative", height: 12, borderRadius: 6, background: `linear-gradient(90deg, var(--accent-soft) 0 ${(openLtv / lltv) * 100}%, #f3ddbf ${(openLtv / lltv) * 100}% 92%, #f0cfca 92% 100%)` }}>
              {debt > 0 && <span style={{ position: "absolute", top: -5, width: 4, height: 22, borderRadius: 2, background: "var(--ink)", left: `calc(${fill.toFixed(1)}% - 2px)` }} />}
            </div>
            <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between" }} className="small"><span style={{ color: "var(--faint)" }}>Comfortable</span><span style={{ color: "var(--faint)" }}>Getting close</span><span style={{ color: "var(--faint)" }}>Limit</span></div>
            {debt > 0 && (
              <p className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
                If {name.title} falls about <strong style={{ color: "var(--ink)" }}>{pct(drop * 100, 0)}</strong> from today, the loan reaches its limit. Then the keeper sells part of it to repay part of the loan, plus a small fee. You keep the rest.
              </p>
            )}
          </section>
        </div>

        <aside className="side" aria-label="Change your loan">
          <div role="tablist" aria-label="What do you want to do?" className="currency-seg">
            {TABS.map((x) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={tab === x.id}
                aria-pressed={tab === x.id}
                onClick={() => { setTab(x.id); setInput(""); steps.reset(); }}
                style={{ minHeight: 36, fontSize: 14, ...(tab === x.id ? { background: "var(--paper-2)", color: "var(--ink)", boxShadow: "inset 0 -2px 0 var(--accent)" } : {}) }}
              >
                {x.label}
              </button>
            ))}
          </div>
          <span className="small muted" style={{ lineHeight: 1.5 }}>{t.help}</span>
          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="loan-amt" className="small muted">{t.field}</label>
            <div className="amount-box">
              <span className="sym">{sym}</span>
              <input id="loan-amt" inputMode="decimal" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }} className="small">
              <span style={{ color: "var(--faint)" }}>{t.note}</span>
              <button className="text-btn" style={{ fontSize: 12 }} onClick={() => setInput(String(Math.floor(limits[tab] * 100) / 100))}>Max</button>
            </div>
          </div>
          <div className="rows lined" style={{ borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
            <div><span>You&rsquo;ll owe</span><span>{money(nDebt, sym)}</span></div>
            <div><span>Secured by</span><span>{money(nColl, sym, 0)}</span></div>
            <div><span>Safety after</span>{nDebt <= 0 ? <strong className="pos">No loan</strong> : <SafetyLabel hf={nHf} />}</div>
          </div>
          {steps.error && <p role="alert" className="notice error">{steps.error}</p>}
          <button className="btn block" disabled={disabled} onClick={apply}>
            {steps.running ? `${steps.label}…` : a > 0 ? `${t.label} ${money(a, sym, 0)}` : "Enter an amount"}
          </button>
        </aside>
      </div>

      {done && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="l-done">
            <span className="section-title" style={{ fontSize: 14, color: "var(--accent-text)" }}><Mark />Done</span>
            <h2 id="l-done" className="big-line">{done}</h2>
            <button className="btn block" onClick={() => setDone(null)}>Back to your loan</button>
          </div>
        </div>
      )}
    </div>
  );
}
