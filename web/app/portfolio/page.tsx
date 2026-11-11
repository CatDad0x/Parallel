"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useCurrency } from "@/lib/currency";
import { deployment } from "@/lib/config";
import { useNavHistories } from "@/lib/hooks";
import { usePositions, productName, symbolOf } from "@/lib/positions";
import { useLendingTotals } from "@/lib/lendingTotals";
import { collateralName, safetyOf } from "@/lib/names";
import { pctSeries } from "@/lib/series";
import { money, pct, signedMoney } from "@/lib/format";
import { PanelChart, within } from "@/components/Charts";
import { PendingRequests } from "@/components/PendingRequests";
import { Mark } from "@/components/Logo";

const RANGES = [
  { k: "1H", ms: 3_600_000 },
  { k: "6H", ms: 21_600_000 },
  { k: "All", ms: 0 },
];

export default function Portfolio() {
  const { address } = useAccount();
  const { currency, meta } = useCurrency();
  const pos = usePositions();
  const { states, earning } = useLendingTotals();
  const sym = meta.symbol;
  const [range, setRange] = useState(2);

  // Chart: the biggest holding, with and without currency protection (its twin vault).
  const top = [...pos.rows].sort((a, b) => pos.toHome(b.value, b.s.info.currency) - pos.toHome(a.value, a.s.info.currency))[0]?.s.info;
  const pair = top
    ? [true, false].map((h) => deployment.vaults.find((v) => v.currency === top.currency && v.strategy === top.strategy && v.hedged === h))
    : [];
  const hist = useNavHistories(pair.filter((v): v is NonNullable<typeof v> => !!v).map((v) => v.address));
  const lines = pair.map((v) => (v ? within(pctSeries(hist[v.address.toLowerCase()] ?? []), RANGES[range].ms) : []));
  const rebase = lines.map((s) => (s.length > 1 ? s.map((p) => ({ t: p.t, v: p.v - s[0].v })) : s));
  const chartReady = rebase.length === 2 && rebase[0].length > 1 && rebase[1].length > 1;
  const end = (s: { v: number }[]) => (s.length ? s[s.length - 1].v : NaN);

  if (!address)
    return (
      <div className="pnl">
        <div className="pnl-head"><h1><Mark />Portfolio</h1></div>
        <div className="empty">
          <span>Sign in to see what you own.</span>
          <Link href="/start" className="btn sm">Sign in</Link>
        </div>
      </div>
    );

  const parts = [
    { label: "Share performance", value: pos.equityEffect, tip: "How the US shares moved, including fees and trading costs" },
    { label: "Currency effect", value: pos.fxEffect, tip: `What the ${currency}/US$ move did to the shares' value` },
    { label: "Hedge result", value: pos.hedge, tip: "What currency protection paid or cost (simulated)" },
  ];
  const maxAbs = Math.max(1, ...parts.map((p) => Math.abs(p.value || 0)));
  const loans = states.filter((s) => s.user.borrowAssets > 0);
  const lending = states.filter((s) => s.user.supplyAssets > 0);
  const loanSym = (token: string) => symbolOf(deployment.tokens.find((t) => t.address === token)?.currency ?? currency);
  const protectedValue = pos.rows.filter((r) => r.s.info.hedged).reduce((a, r) => a + (pos.toHome(r.value, r.s.info.currency) || 0), 0);
  const exposed = Math.max(0, pos.total - protectedValue);
  const protPct = pos.total > 0 ? (protectedValue / pos.total) * 100 : 0;

  return (
    <div className="grid12">
      {/* Summary */}
      <section aria-labelledby="p-sum" className="pnl s4">
        <div className="pnl-head">
          <h1 id="p-sum"><Mark />Your investments</h1>
          <span className="aside">{pos.rows.length} {pos.rows.length === 1 ? "holding" : "holdings"}</span>
        </div>
        <div className="pnl-body" style={{ gap: 4, paddingTop: 16 }}>
          <strong className="kpi">{money(pos.total, sym)}</strong>
          {pos.rows.length > 0 && Number.isFinite(pos.pnl) && (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              <strong className={pos.pnl >= 0 ? "pos" : "neg"}>
                {signedMoney(pos.pnl, sym)}
                {Number.isFinite(pos.invested) && pos.invested > 0 ? ` (${pct((pos.pnl / pos.invested) * 100, 1, true)})` : ""}
              </strong>
              {Number.isFinite(pos.invested) && pos.invested > 0 ? ` · you put in ${money(pos.invested, sym, 0)}` : ""}
            </span>
          )}
        </div>
        {pos.rows.length > 0 && (
          <>
            <span style={{ padding: "8px 14px 2px", fontSize: 11, fontWeight: 700, color: "var(--muted)" }}>Where the gain came from</span>
            <div style={{ padding: "0 14px 8px" }}>
              {parts.map((p) => {
                const v = p.value || 0;
                const w = ((Math.abs(v) / maxAbs) * 50).toFixed(1);
                return (
                  <div key={p.label} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 70px 72px", gap: 8, alignItems: "center", minHeight: 28, borderTop: "1px solid #f0f3f6" }}>
                    <span className="hint muted" title={p.tip}>{p.label}</span>
                    <span aria-hidden="true" style={{ position: "relative", height: 8 }}>
                      <span style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: "var(--border)" }} />
                      <span style={{ position: "absolute", top: 0, height: 8, borderRadius: 2, width: `${w}%`, ...(v >= 0 ? { left: "50%", background: "var(--accent)" } : { right: "50%", background: "#c98a7e" }) }} />
                    </span>
                    <span className={v >= 0 ? "pos" : "neg"} style={{ textAlign: "right", fontWeight: 600, fontFeatureSettings: '"tnum" 1' }}>{signedMoney(v, sym, 0)}</span>
                  </div>
                );
              })}
            </div>
            <span className="pnl-note">An estimate. Fees and trading costs are inside share performance; the hedge offsets most of the currency effect.</span>
          </>
        )}
      </section>

      {/* With vs without protection */}
      <section aria-labelledby="p-perf" className="pnl s8">
        <div className="pnl-head">
          <h2 id="p-perf"><Mark />{top ? `${productName(top)} with and without protection` : "With and without protection"}</h2>
          <span className="mini-seg" role="group" aria-label="Time range">
            {RANGES.map((r, i) => (
              <button key={r.k} aria-pressed={range === i} onClick={() => setRange(i)}>{r.k}</button>
            ))}
          </span>
        </div>
        {chartReady ? (
          <>
            <div style={{ display: "flex", gap: 18, padding: "10px 14px 0", fontSize: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden="true" style={{ width: 14, height: 2, background: "var(--accent)" }} />
                With protection <strong className={end(rebase[0]) >= 0 ? "pos" : "neg"}>{pct(end(rebase[0]), 2, true)}</strong>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden="true" style={{ width: 14, borderTop: "2px dashed #9aa5b1" }} />
                Without protection <strong className="muted">{pct(end(rebase[1]), 2, true)}</strong>
              </span>
            </div>
            <PanelChart
              series={rebase}
              height={226}
              label={`${productName(top!)} share price change with protection ${pct(end(rebase[0]), 2, true)}, without ${pct(end(rebase[1]), 2, true)}`}
              axis={(v) => pct(v, 2, true)}
            />
            <span className="pnl-note">Same shares, same period. The gap is the {currency} moving against the US$. Protection is simulated.</span>
          </>
        ) : (
          <div role="status" className="muted" style={{ minHeight: 260, display: "grid", placeItems: "center", padding: 16, textAlign: "center" }}>
            {pos.rows.length === 0 ? "Invest to compare protected and unprotected performance." : "The comparison fills in as new prices are recorded."}
          </div>
        )}
      </section>

      {/* Holdings */}
      <section aria-labelledby="p-hold" className="pnl s12">
        <div className="pnl-head">
          <h2 id="p-hold"><Mark />Holdings</h2>
          <Link href="/invest" className="aside">Invest more →</Link>
        </div>
        {pos.rows.length === 0 ? (
          <div className="empty">
            <span>{pos.loading ? "Loading your investments…" : "You don’t own any investments yet."}</span>
            <Link href="/invest" className="btn sm">Invest</Link>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="ptable">
              <thead>
                <tr>
                  <th>Investment</th>
                  <th>Protection</th>
                  <th className="r">Shares</th>
                  <th className="r">Price</th>
                  <th className="r">Value</th>
                  <th className="r">Gain</th>
                  <th style={{ width: "16%" }}>Of portfolio</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pos.rows.map((r) => {
                  const s = symbolOf(r.s.info.currency);
                  const locked = r.collateralShares > 0n;
                  const change = r.b?.net ? (r.pnl / r.b.net) * 100 : NaN;
                  const share = pos.total > 0 ? ((pos.toHome(r.value, r.s.info.currency) || 0) / pos.total) * 100 : 0;
                  return (
                    <tr key={r.s.info.address}>
                      <td>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <strong>{productName(r.s.info)}</strong>
                          <span style={{ fontSize: 11, color: "var(--faint)" }}>{r.s.info.symbol}</span>
                        </span>
                      </td>
                      <td>
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                          {r.s.info.hedged ? "Protected" : "No protection"}
                          {locked && <span className="chip" style={{ background: "var(--amber-soft)", color: "#6b3d12" }}>Securing loan</span>}
                        </span>
                      </td>
                      <td className="r muted">{r.shares.toLocaleString("en-AU", { maximumFractionDigits: 4 })}</td>
                      <td className="r muted">{money(r.s.navPerShare, s, 4)}</td>
                      <td className="r"><strong>{money(r.value, s)}</strong></td>
                      <td className={`r ${Math.abs(change) < 0.05 ? "muted" : change > 0 ? "pos" : "neg"}`} style={{ fontWeight: 600 }}>{Number.isFinite(change) ? pct(change, 1, true) : "—"}</td>
                      <td>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span aria-hidden="true" style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--canvas)" }}>
                            <span style={{ display: "block", height: 4, borderRadius: 2, width: `${share.toFixed(1)}%`, background: "var(--accent)" }} />
                          </span>
                          <span style={{ width: 34, textAlign: "right", fontSize: 12, color: "var(--muted)" }}>{pct(share, 0)}</span>
                        </span>
                      </td>
                      <td className="r" style={{ whiteSpace: "nowrap" }}>
                        <Link href={`/sell?v=${r.s.info.address}`} className="btn ghost sm" style={{ marginRight: 6 }}>Sell</Link>
                        <Link href="/invest" className="btn ghost sm">Buy</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td><td /><td /><td />
                  <td className="r">{money(pos.total, sym)}</td>
                  <td className={`r ${!(pos.invested > 0) || Math.abs((pos.pnl / pos.invested) * 100) < 0.05 ? "muted" : pos.pnl > 0 ? "pos" : "neg"}`}>
                    {Number.isFinite(pos.invested) && pos.invested > 0 ? pct((pos.pnl / pos.invested) * 100, 1, true) : "—"}
                  </td>
                  <td /><td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* Loans */}
      {loans.map((l) => {
        const sf = safetyOf(l.user.hf);
        const s = loanSym(l.m.loanToken);
        const fall = Number.isFinite(l.user.hf) ? Math.max(0, (1 - 1 / l.user.hf) * 100) : 100;
        const marker = Math.min(100, (fall / 50) * 100);
        return (
          <section key={l.m.id} aria-label="Your loan" className="pnl s6">
            <div className="pnl-head">
              <h2><Mark />Your loan</h2>
              <Link href={`/borrow/manage?m=${l.m.id}`} className="btn ghost sm" style={{ minHeight: 26 }}>Manage loan</Link>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, padding: "14px 14px 6px" }}>
              <div style={{ display: "grid", gap: 3 }}><span style={{ fontSize: 11, color: "var(--faint)" }}>Borrowed</span><strong className="kpi m" style={{ fontSize: 20 }}>{money(l.user.borrowAssets, s)}</strong></div>
              <div style={{ display: "grid", gap: 3 }}><span style={{ fontSize: 11, color: "var(--faint)" }}>Interest</span><strong className="kpi m" style={{ fontSize: 20 }}>{pct(l.borrowApr * 100, 1)}</strong><span style={{ fontSize: 11, color: "var(--faint)" }}>a year, variable</span></div>
              <div style={{ display: "grid", gap: 3 }}><span style={{ fontSize: 11, color: "var(--faint)" }}>Secured by</span><strong style={{ fontSize: 14 }}>{collateralName(l.m).title}</strong></div>
            </div>
            <div style={{ display: "grid", gap: 6, padding: "10px 14px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <span className="hint muted" title="If prices fall this far, some of what secures the loan is sold to repay part of it">Loan safety</span>
                <strong style={{ color: sf.color }}>{sf.label} · prices can fall about {pct(fall, 0)}</strong>
              </div>
              <span aria-hidden="true" style={{ position: "relative", display: "block", height: 6, borderRadius: 3, background: "linear-gradient(90deg, var(--accent) 0%, var(--accent) 60%, #c98a3e 80%, #8e3b2e 100%)", opacity: 0.85 }}>
                <span style={{ position: "absolute", left: `${(100 - marker).toFixed(0)}%`, top: -4, width: 2, height: 14, background: "var(--ink)", borderRadius: 1 }} />
              </span>
              <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--faint)" }}>
                <span>Comfortable</span><span>Getting close</span><span>Limit</span>
              </div>
            </div>
          </section>
        );
      })}

      {/* Earning */}
      {lending.length > 0 && (
        <section aria-labelledby="p-earn" className="pnl s3">
          <div className="pnl-head"><h2 id="p-earn"><Mark />Earning</h2></div>
          <div className="pnl-body">
            <strong className="kpi m" style={{ fontSize: 20 }}>{money(earning, sym)}</strong>
            <div>
              {lending.map((l) => (
                <div key={l.m.id} className="prow"><span>{collateralName(l.m).title.split(" · ")[0]} pool</span><span>{pct(l.supplyApr * 100, 1)} a year</span></div>
              ))}
            </div>
            <Link href="/lend" className="btn ghost sm" style={{ alignSelf: "flex-start" }}>Withdraw</Link>
          </div>
        </section>
      )}

      {/* Currency exposure */}
      {pos.rows.length > 0 && (
        <section aria-labelledby="p-fx" className="pnl s3">
          <div className="pnl-head"><h2 id="p-fx"><Mark />Currency exposure</h2></div>
          <div className="pnl-body">
            <span aria-hidden="true" style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--border)" }}>
              <span style={{ width: `${protPct.toFixed(1)}%`, background: "var(--accent)" }} />
            </span>
            <div className="prow" style={{ borderTop: 0 }}><span>Protected</span><strong>{money(protectedValue, sym, 0)} · {pct(protPct, 0)}</strong></div>
            <div className="prow"><span>Exposed to US$</span><strong>{money(exposed, sym, 0)} · {pct(100 - protPct, 0)}</strong></div>
            <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--faint)" }}>How much of what you own moves with the {currency}/US$ rate.</span>
          </div>
        </section>
      )}

      <div className="s12" style={{ display: "grid", gap: 8, maxWidth: 460 }}>
        {deployment.vaults.map((v) => <PendingRequests key={v.address} vault={v.address} />)}
      </div>

      <p className="s12" style={{ margin: "4px 6px 0", fontSize: 11, color: "var(--faint)" }}>
        Values in {currency}. Positions in other currencies are converted at today&rsquo;s rate. Share prices can fall; currency protection is simulated and figures are illustrative.
      </p>
    </div>
  );
}
