"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useTestMoney } from "@/lib/onboard";
import { useFx, useEquityPrices, useNavHistories } from "@/lib/hooks";
import { usePositions, productName, symbolOf } from "@/lib/positions";
import { useLendingTotals } from "@/lib/lendingTotals";
import { useActivity, type ActivityKind } from "@/lib/activity";
import { holdingsSeries, navSeries } from "@/lib/series";
import { collateralName, safetyOf } from "@/lib/names";
import { money, pct, signedMoney } from "@/lib/format";
import { PanelChart, Spark, within } from "@/components/Charts";
import { SafetyMeter } from "@/components/Safety";
import { Mark } from "@/components/Logo";

const RANGES = [
  { k: "1H", ms: 3_600_000 },
  { k: "6H", ms: 21_600_000 },
  { k: "All", ms: 0 },
];

const TAG: Record<ActivityKind, [string, string]> = {
  Invest: ["var(--accent-soft)", "var(--accent-text)"],
  Sell: ["#eef1f5", "#4d5966"],
  Borrow: ["#e3eaf7", "#22457f"],
  Repay: ["#e3eaf7", "#22457f"],
  Lend: ["#fbf1e4", "#6b3d12"],
  Withdraw: ["#fbf1e4", "#6b3d12"],
};

const TECH = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];
const when = (t?: number) =>
  t ? new Date(t).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "…";

export default function HomePage() {
  const { address, isConnected } = useAccount();
  const { currency, meta } = useCurrency();
  const sym = meta.symbol;
  const tm = useTestMoney();
  const pos = usePositions();
  const { earning, borrowed, states } = useLendingTotals();
  const fx = useFx();
  const prices = useEquityPrices();
  const activity = useActivity(address);
  const hist = useNavHistories(pos.rows.map((r) => r.s.info.address));
  const [range, setRange] = useState(2);

  const total = pos.total + tm.balance + earning - borrowed;
  const series = within(holdingsSeries(pos.rows, hist, pos.toHome), RANGES[range].ms);
  const move = series.length > 1 ? series[series.length - 1].v - series[0].v : NaN;
  const loan = states.find((s) => s.user.borrowAssets > 0);
  const lent = states.filter((s) => s.user.supplyAssets > 0);
  const lentRate = lent.length ? lent.reduce((a, s) => a + s.supplyApr * s.user.supplyAssets, 0) / lent.reduce((a, s) => a + s.user.supplyAssets, 0) : 0;
  const loanSym = (token: string) => symbolOf(deployment.tokens.find((t) => t.address === token)?.currency ?? currency);
  const usd = (n?: number, d = 2) => (n === undefined ? "—" : `US$${n.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d })}`);

  return (
    <div className="grid12">
      {/* Total */}
      <section aria-labelledby="p-total" className="pnl s4">
        <div className="pnl-head">
          <h1 id="p-total"><Mark />Your total</h1>
          <span className="aside">{currency}</span>
        </div>
        <div className="pnl-body" style={{ gap: 4, paddingTop: 16 }}>
          <strong className="kpi">{isConnected ? money(total, sym) : "—"}</strong>
          {isConnected && Number.isFinite(pos.pnl) && pos.rows.length > 0 ? (
            <span className={pos.pnl >= 0 ? "pos" : "neg"} style={{ fontSize: 12, fontWeight: 600 }}>
              {signedMoney(pos.pnl, sym)} on your investments
            </span>
          ) : null}
        </div>
        {isConnected ? (
          <div style={{ padding: "4px 14px 12px" }}>
            <div className="prow"><span className="hint" title="What your investments are worth now">Invested</span><span>{money(pos.total, sym)}</span></div>
            <div className="prow"><span className="hint" title="Stablecoins in your wallet">Test money</span><span>{money(tm.balance, sym)}</span></div>
            <div className="prow"><span className="hint" title="Lent to borrowers, including interest">Earning</span><span>{money(earning, sym)}</span></div>
            <div className="prow"><span className="hint" title="Your loans including interest">Borrowed</span><span className={borrowed > 0 ? "neg" : undefined}>{borrowed > 0 ? "−" : ""}{money(borrowed, sym)}</span></div>
          </div>
        ) : (
          <div className="pnl-body">
            <span className="muted">Sign in to get test money and start investing.</span>
            <Link href="/start" className="btn" style={{ justifySelf: "start", alignSelf: "flex-start" }}>Sign in</Link>
          </div>
        )}
      </section>

      {/* Chart */}
      <section aria-labelledby="p-chart" className="pnl s8">
        <div className="pnl-head">
          <h2 id="p-chart"><Mark />Your investments over time</h2>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {Number.isFinite(move) && <span className={move >= 0 ? "pos" : "neg"} style={{ fontSize: 12, fontWeight: 600 }}>{signedMoney(move, sym)}</span>}
            <span className="mini-seg" role="group" aria-label="Time range">
              {RANGES.map((r, i) => (
                <button key={r.k} aria-pressed={range === i} onClick={() => setRange(i)}>{r.k}</button>
              ))}
            </span>
            <span className="live">LIVE</span>
          </span>
        </div>
        {series.length > 1 ? (
          <>
            <PanelChart series={[series]} label="What your investments were worth over time" axis={(v) => money(v, sym, 0)} />
            <span className="pnl-note">Today&rsquo;s holdings at past share prices, converted at today&rsquo;s rate.</span>
          </>
        ) : (
          <div role="status" className="muted" style={{ minHeight: 240, display: "grid", placeItems: "center", padding: 16, textAlign: "center" }}>
            {!isConnected ? "Your chart appears here once you invest." : pos.rows.length === 0 ? "Invest to see how your money moves." : "The chart fills in as new prices are recorded."}
          </div>
        )}
      </section>

      {/* Investments */}
      <section aria-labelledby="p-inv" className="pnl s6">
        <div className="pnl-head">
          <h2 id="p-inv"><Mark />Your investments</h2>
          <Link href="/portfolio" className="aside">Portfolio →</Link>
        </div>
        {pos.rows.length === 0 ? (
          <div className="empty">
            <span>{pos.loading && isConnected ? "Loading your investments…" : "You don’t own any investments yet."}</span>
            <Link href="/invest" className="btn sm">Invest</Link>
          </div>
        ) : (
          <table className="ptable">
            <thead>
              <tr><th>Investment</th><th>Recent</th><th className="r">Value</th><th className="r">Gain</th></tr>
            </thead>
            <tbody>
              {pos.rows.map((r) => {
                const s = symbolOf(r.s.info.currency);
                const change = r.b?.net ? (r.pnl / r.b.net) * 100 : NaN;
                return (
                  <tr key={r.s.info.address}>
                    <td>
                      <strong style={{ display: "block" }}>{productName(r.s.info)}</strong>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>
                        {r.s.info.hedged ? "Protected" : "No protection"}
                        {r.collateralShares > 0n ? " · securing loan" : ""}
                      </span>
                    </td>
                    <td><Spark pts={navSeries(hist[r.s.info.address.toLowerCase()] ?? [])} /></td>
                    <td className="r"><strong>{money(r.value, s)}</strong></td>
                    <td className={`r ${Math.abs(change) < 0.05 ? "muted" : change > 0 ? "pos" : "neg"}`} style={{ fontWeight: 600 }}>{Number.isFinite(change) ? pct(change, 1, true) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Rates */}
      <section aria-labelledby="p-rates" className="pnl s3">
        <div className="pnl-head">
          <h2 id="p-rates"><Mark />Rates</h2>
          <span className="live">LIVE</span>
        </div>
        <div style={{ padding: "2px 14px 10px" }}>
          {(["AUD", "EUR", "INR"] as const).map((c) => (
            <div key={c} className="prow">
              <span>{symbolOf(c)}1 in US$</span>
              <strong>{fx[c] ? fx[c].usdPerLocal.toFixed(c === "INR" ? 5 : 4) : "—"}</strong>
            </div>
          ))}
          <div className="prow"><span>S&amp;P 500</span><strong>{usd(prices.find((p) => p.name === "SPY")?.usd)}</strong></div>
          {TECH.map((n) => (
            <div key={n} className="prow"><span>{n}</span><span>{usd(prices.find((p) => p.name === n)?.usd)}</span></div>
          ))}
        </div>
      </section>

      {/* Loan */}
      <section aria-labelledby="p-loan" className="pnl s3">
        <div className="pnl-head">
          <h2 id="p-loan"><Mark />Your loan</h2>
          {loan && <span className="aside">{collateralName(loan.m).title.split(" · ")[0]}</span>}
        </div>
        {loan ? (
          <div className="pnl-body">
            <strong className="kpi m">{money(loan.user.borrowAssets, loanSym(loan.m.loanToken))}</strong>
            <div>
              <div className="prow"><span>Interest</span><span>{pct(loan.borrowApr * 100, 1)} variable</span></div>
              <div className="prow">
                <span className="hint" title="How far prices can fall before some of what secures the loan is sold">Loan safety</span>
                <strong style={{ color: safetyOf(loan.user.hf).color }}>{safetyOf(loan.user.hf).label}</strong>
              </div>
            </div>
            <SafetyMeter hf={loan.user.hf} size={4} />
            <Link href={`/borrow/manage?m=${loan.m.id}`} className="btn ghost sm">Manage loan</Link>
          </div>
        ) : (
          <div className="pnl-body">
            <span className="muted">No loan. You can borrow against your investments without selling them.</span>
            <Link href="/borrow" className="btn ghost sm" style={{ alignSelf: "flex-start" }}>See how much</Link>
          </div>
        )}
      </section>

      {/* Actions */}
      <section aria-labelledby="p-do" className="pnl s4">
        <div className="pnl-head"><h2 id="p-do"><Mark />Do something</h2></div>
        <div className="pnl-body" style={{ padding: 14 }}>
          <Link href="/invest" className="btn" style={{ minHeight: 40 }}>Invest</Link>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
            <Link href="/borrow" className="btn ghost sm" style={{ minHeight: 34 }}>Borrow</Link>
            <Link href="/lend" className="btn ghost sm" style={{ minHeight: 34 }}>Earn</Link>
          </div>
          <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--faint)" }}>
            Invest in US shares in {sym}, borrow against them, or lend to earn interest.
          </span>
        </div>
      </section>

      {/* Earning */}
      <section aria-labelledby="p-earn" className="pnl s3">
        <div className="pnl-head">
          <h2 id="p-earn"><Mark />Earning</h2>
          {lent.length > 0 && <span className="aside">{pct(lentRate * 100, 1)} a year</span>}
        </div>
        {lent.length > 0 ? (
          <div className="pnl-body">
            <strong className="kpi m">{money(earning, sym)}</strong>
            <div>
              {lent.map((l) => (
                <div key={l.m.id} className="prow">
                  <span>{collateralName(l.m).title.split(" · ")[0]} pool</span>
                  <span>{pct(l.utilisation * 100, 0)} lent out</span>
                </div>
              ))}
            </div>
            <Link href="/lend" className="btn ghost sm" style={{ alignSelf: "flex-start" }}>Withdraw</Link>
          </div>
        ) : (
          <div className="pnl-body">
            <span className="muted">Lend your {sym} to borrowers and earn interest.</span>
            <Link href="/lend" className="btn ghost sm" style={{ alignSelf: "flex-start" }}>See rates</Link>
          </div>
        )}
      </section>

      {/* Activity */}
      <section aria-labelledby="p-log" className="pnl s5">
        <div className="pnl-head">
          <h2 id="p-log"><Mark />Activity</h2>
          <span className="aside">Latest 5</span>
        </div>
        {!isConnected ? (
          <div className="empty">Your actions show here.</div>
        ) : activity === undefined ? (
          <div className="empty" role="status">Loading activity…</div>
        ) : activity.length === 0 ? (
          <div className="empty">Nothing yet. Your investments, loans and lending show here.</div>
        ) : (
          <table className="ptable" style={{ fontSize: 12 }}>
            <tbody>
              {activity.map((a, i) => {
                const v = a.vault && deployment.vaults.find((x) => x.address.toLowerCase() === a.vault!.toLowerCase());
                const m = a.marketId && deployment.markets.find((x) => x.id.toLowerCase() === a.marketId!.toLowerCase());
                const what = v ? `${productName(v)} · ${v.hedged ? "protected" : "no protection"}` : m ? collateralName(m).title.split(" · ")[0] : "";
                return (
                  <tr key={i}>
                    <td style={{ color: "var(--faint)", whiteSpace: "nowrap", padding: "8px 0 8px 14px" }}>{when(a.t)}</td>
                    <td style={{ padding: "8px 6px" }}><span className="chip" style={{ background: TAG[a.kind][0], color: TAG[a.kind][1] }}>{a.kind}</span></td>
                    <td style={{ color: "var(--muted)", padding: "8px 6px" }}>{what}</td>
                    <td className="r" style={{ fontWeight: 700 }}>{money(a.amount, symbolOf(a.currency))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="s12" style={{ margin: "4px 6px 0", fontSize: 11, color: "var(--faint)" }}>
        Share prices can fall. Test money only; currency protection is simulated and figures are illustrative.
      </p>
    </div>
  );
}
