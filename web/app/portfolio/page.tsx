"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { vaultAbi } from "@parallel/shared";
import { useBasis } from "@/lib/basis";
import { useFx, useSteps, type VaultStats } from "@/lib/hooks";
import { PricesLoading, PRODUCT_META, useLoans, useProducts, useWallet, userSharesValue, safety, lltvOf, Slash, Notice, fmtMoney, fmtSigned } from "@/lib/pm";
import { useNavHistories, pctSeries } from "@/lib/history";
import { PanelChart, Spark, within } from "@/components/Charts";
import { PendingRequests } from "@/components/PendingRequests";

export default function Portfolio() {
  const { address } = useAccount();
  const { symbol, refetchBalance } = useWallet();
  const { stats, refetch } = useProducts();
  const { loans } = useLoans();
  const basis = useBasis(address);
  const fx = useFx();
  const [selling, setSelling] = useState<VaultStats | undefined>();
  const [range, setRange] = useState(0);

  const rows = stats
    .map((s) => {
      const collateral = loans.find((l) => l.market.collateralToken === s.info.address)?.collateralShares ?? 0n;
      const locked = loans.some((l) => l.market.collateralToken === s.info.address && l.borrowed > 0);
      const shares = Number(s.userShares + collateral) / 1e18;
      const value = userSharesValue(s, collateral);
      const b = basis[s.info.address.toLowerCase()];
      const pnl = b ? value - b.net : NaN;
      const userEq = s.supply > 0 ? (shares / s.supply) * s.equityValue : 0;
      const fxNow = fx[s.info.currency]?.usdPerLocal;
      const fxEffect = b?.fx0 && fxNow ? userEq * (1 - fxNow / b.fx0) : 0;
      const hedge = s.supply > 0 ? (shares / s.supply) * s.hedgeMtm : 0;
      const shareEffect = Number.isFinite(pnl) ? pnl - fxEffect - hedge : NaN;
      return { s, shares, value, locked, collateral, pnl, fxEffect, hedge, shareEffect, put: b?.net ?? NaN };
    })
    .filter((r) => r.shares > 0);

  const hist = useNavHistories(stats.map((s) => s.info.address));
  const top = [...rows].sort((a, b) => b.value - a.value)[0];
  const topPts = top ? hist[top.s.info.address.toLowerCase()] ?? [] : [];
  const topLine = within(pctSeries(topPts), range);
  const total = rows.reduce((a, r) => a + r.value, 0);
  const gain = rows.reduce((a, r) => a + (Number.isFinite(r.pnl) ? r.pnl : 0), 0);
  const put = rows.reduce((a, r) => a + (Number.isFinite(r.put) ? r.put : 0), 0);
  const parts: [string, number][] = [
    ["Share performance", rows.reduce((a, r) => a + (Number.isFinite(r.shareEffect) ? r.shareEffect : 0), 0)],
    ["Currency effect", rows.reduce((a, r) => a + r.fxEffect, 0)],
    ["Hedge result", rows.reduce((a, r) => a + r.hedge, 0)],
  ];
  const maxAbs = Math.max(1, ...parts.map((p) => Math.abs(p[1])));
  const activeLoans = loans.filter((l) => l.borrowed > 0);

  return (
    <>
      <section aria-label="Investment value" style={{ display: "flex", flexWrap: "wrap", borderBottom: "1px solid var(--pm-line)" }}>
        <div style={{ flex: "1 1 320px", display: "grid", gap: 10, padding: "36px 32px 30px", alignContent: "start" }}>
          <span className="pm-eyebrow"><Slash />Your investments are worth</span>
          <strong className="pm-big num">{fmtMoney(total, symbol)}</strong>
          <span className="pm-muted">
            <strong className={gain >= 0 ? "pm-pos" : "pm-neg"}>{fmtSigned(gain, symbol)}</strong> since you started · you put in {fmtMoney(put, symbol)}
          </span>
        </div>
        <div style={{ flex: "1 1 380px", display: "grid", gap: 4, padding: "30px 32px", borderLeft: "1px solid var(--pm-line)", background: "#fff", alignContent: "start" }}>
          <span style={{ fontSize: 13, fontWeight: 700, paddingBottom: 6 }}>Where the {fmtSigned(gain, symbol)} came from</span>
          {parts.map(([l, v]) => (
            <div key={l} style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 76px", alignItems: "center", gap: 12, minHeight: 34 }}>
              <span className="pm-muted" style={{ fontSize: 13 }}>{l}</span>
              <div className="pm-bar" aria-hidden="true">
                <i style={{ width: `${(Math.abs(v) / maxAbs) * 50}%`, ...(v >= 0 ? { left: "50%", background: "var(--pm-accent)" } : { right: "50%", background: "#c98a7e" }) }} />
              </div>
              <strong className={`num ${v >= 0 ? "pm-pos" : "pm-neg"}`} style={{ textAlign: "right", fontSize: 13 }}>{fmtSigned(v, symbol)}</strong>
            </div>
          ))}
          <span className="pm-small" style={{ color: "var(--pm-faint)", paddingTop: 8 }}>
            This is an estimate. The hedge result offsets most of the currency effect. That&rsquo;s currency protection doing its job.
          </span>
        </div>
      </section>

      {top && (
        <section className="pm-pad pm-sec" style={{ paddingBottom: 8 }}>
          <div className="pm-card">
            <div className="pm-row pm-spread" style={{ padding: "14px 18px", borderBottom: "1px solid var(--pm-line2)" }}>
              <h2 style={{ fontSize: 14 }}><Slash />{PRODUCT_META[top.s.info.strategy].name} share price</h2>
              <div className="pm-row" style={{ gap: 6 }}>
                {([["1H", 3_600_000], ["6H", 21_600_000], ["All", 0]] as const).map(([l, ms]) => (
                  <button key={l} className="pm-chip" aria-pressed={range === ms} onClick={() => setRange(ms)}>{l}</button>
                ))}
              </div>
            </div>
            {topLine.length >= 2 ? (
              <PanelChart series={[topLine]} label={`${PRODUCT_META[top.s.info.strategy].name} share price change over time`} axis={(v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`} />
            ) : (
              <p className="pm-muted" style={{ padding: 24 }}>Loading price history…</p>
            )}
            <p className="pm-small pm-muted" style={{ padding: "0 18px 14px" }}>Change in the share price since the start of the chart, in {symbol}. Currency protection is included.</p>
          </div>
        </section>
      )}

      <section className="pm-pad pm-sec" style={{ paddingBottom: 8 }}>
        <h2><Slash />What you own</h2>
        <div className="pm-card pm-table-wrap">
          {rows.length === 0 ? (
            <div style={{ padding: 24, display: "grid", gap: 12 }}>
              <p className="pm-muted">You don&rsquo;t own any investments yet.</p>
              <div><Link href="/invest" className="pm-btn sm">Start investing</Link></div>
            </div>
          ) : (
            <table className="pm-table">
              <thead><tr><th>Investment</th><th>Protection</th><th className="r">Price</th><th className="r">Share</th><th className="r">Value</th><th className="r">Gain</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.s.info.address}>
                    <td>
                      <strong style={{ fontSize: 15 }}>{PRODUCT_META[r.s.info.strategy].name}</strong>{" "}
                      <span className="pm-small" style={{ color: "var(--pm-faint)" }}>{r.s.info.symbol}</span>
                      <div className="pm-small pm-muted num">{r.shares.toLocaleString("en-AU", { maximumFractionDigits: 2 })} units</div>
                    </td>
                    <td>
                      Currency protected
                      {r.locked && <div className="pm-small" style={{ marginTop: 4, padding: "1px 7px", borderRadius: 4, background: "var(--pm-warn-bg)", color: "var(--pm-warn-text)", display: "inline-block", marginLeft: 6 }}>Securing your loan</div>}
                    </td>
                    <td className="r num">{fmtMoney(r.s.navPerShare, symbol, 2)}<div><Spark pts={pctSeries(hist[r.s.info.address.toLowerCase()] ?? [])} width={70} height={22} /></div></td>
                    <td className="r num">{total > 0 ? `${((r.value / total) * 100).toFixed(0)}%` : "—"}</td>
                    <td className="r num"><strong>{fmtMoney(r.value, symbol)}</strong></td>
                    <td className={`r num ${r.pnl >= 0 ? "pm-pos" : "pm-neg"}`}>{Number.isFinite(r.pnl) && r.put ? `${r.pnl >= 0 ? "+" : "−"}${Math.abs((r.pnl / r.put) * 100).toFixed(1)}%` : "—"}</td>
                    <td className="r">
                      {r.s.userShares === 0n && r.locked && (
                        <div className="pm-small pm-muted" style={{ marginBottom: 6 }}>Securing your loan. <Link href="/borrow" className="pm-link">Repay to unlock</Link></div>
                      )}
                      <span className="pm-row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        <button className="pm-btn sec sm" disabled={r.s.userShares === 0n} onClick={() => setSelling(r.s)}>
                          {r.s.userShares === 0n ? "Locked" : "Sell"}
                        </button>
                        <Link href="/invest" className="pm-btn sec sm">Buy</Link>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {selling && (
        <SellPanel
          s={selling}
          symbol={symbol}
          onClose={() => setSelling(undefined)}
          onDone={() => {
            refetch();
            refetchBalance();
          }}
        />
      )}

      <div className="pm-pad pm-grid" style={{ paddingTop: 16 }}>
        <section className="pm-panel" aria-labelledby="h-loan">
          <div className="pm-row pm-spread"><h2 id="h-loan" style={{ fontSize: 16 }}><Slash /> Your loan</h2></div>
          {activeLoans.length === 0 ? (
            <p className="pm-muted">You haven&rsquo;t borrowed anything. <Link href="/borrow" className="pm-link">See how much you could borrow</Link></p>
          ) : (
            activeLoans.map((l) => {
              const sf = safety(l.ltv, lltvOf(l.market));
              return (
                <div key={l.market.id} style={{ display: "grid", gap: 10 }}>
                  <div className="pm-row pm-spread">
                    <div style={{ display: "grid" }}><span className="pm-small pm-muted">Borrowed</span><strong className="num" style={{ fontSize: 20 }}>{fmtMoney(l.borrowed, symbol, 2)}</strong></div>
                    <div style={{ display: "grid" }}><span className="pm-small pm-muted">Safety</span><strong className={sf.level === 0 ? "pm-pos" : "pm-neg"}>{sf.label}</strong><span className="pm-small pm-muted">prices can fall about {Math.max(0, Math.round((1 - l.ltv / lltvOf(l.market)) * 100))}%</span></div>
                    <Link href="/borrow" className="pm-btn sec sm">Manage loan</Link>
                  </div>
                  <span className="pm-small pm-muted">Secured by {l.strategy ? PRODUCT_META[l.strategy].name : "your shares"}</span>
                </div>
              );
            })
          )}
        </section>
        <section className="pm-panel">
          <h2 style={{ fontSize: 16 }}><Slash /> Waiting for the market to open</h2>
          {stats.length > 0 ? stats.map((s) => <PendingRequests key={s.info.address} vault={s.info.address} />) : null}
          <p className="pm-small pm-muted">Orders placed while US markets are closed appear here until they go through.</p>
        </section>
      </div>
      <p className="pm-small pm-muted pm-pad" style={{ paddingTop: 0 }}>
        All values in your currency. Share prices can fall. Currency protection is simulated; figures are illustrative.
      </p>
    </>
  );
}

const LEVELS = ["", "amber", "red", "red"] as const;

function SellPanel({ s, symbol, onClose, onDone }: { s: VaultStats; symbol: string; onClose: () => void; onDone: () => void }) {
  const { address } = useAccount();
  const steps = useSteps();
  const [pctSel, setPctSel] = useState(100);
  const [ack, setAck] = useState(false);
  const shares = (s.userShares * BigInt(pctSel)) / 100n;
  const { data: quote } = useReadContract({
    address: s.info.address, abi: vaultAbi, functionName: "redeemQuote", args: [shares],
    query: { enabled: shares > 0n },
  });
  const q = quote as readonly [bigint, bigint, bigint, number] | undefined;
  const atDex = q ? Number(q[0]) / 1e6 : 0;
  const atIndex = q ? Number(q[1]) / 1e6 : 0;
  const gap = q ? Number(q[2]) / 100 : 0;
  const level = q ? Number(q[3]) : 0;
  const minOut = q ? (q[0] * 995n) / 1000n : 0n;

  const sellNow = async () => {
    if (!address) return;
    const ok = await steps.run(
      [{ label: "Selling", address: s.info.address, abi: vaultAbi, functionName: "redeem", args: [shares, address, address] }],
      `Sold. ${fmtMoney(atDex, symbol, 2)} is on its way to your balance.`,
    );
    if (ok) onDone();
  };
  const wait = async () => {
    if (!address) return;
    const ok = await steps.run(
      [{ label: "Placing order", address: s.info.address, abi: vaultAbi, functionName: "requestRedeem", args: [shares, address, minOut] }],
      "Order placed. It goes through when US markets open.",
    );
    if (ok) onDone();
  };

  return (
    <section className="pm-pad" aria-label="Sell" style={{ paddingTop: 8 }}>
      <div className="pm-panel" style={{ maxWidth: 560 }}>
        <div className="pm-row pm-spread">
          <h2 style={{ fontSize: 18 }}>Sell {PRODUCT_META[s.info.strategy].name}</h2>
          <button className="pm-link" onClick={onClose}>Close</button>
        </div>
        <div className="pm-row" style={{ flexWrap: "nowrap" }}>
          {[25, 50, 100].map((p) => (
            <button key={p} className="pm-chip" style={pctSel === p ? undefined : { background: "#eef2f6" }} aria-pressed={pctSel === p} onClick={() => { setPctSel(p); setAck(false); }}>{p === 100 ? "All" : `${p}%`}</button>
          ))}
        </div>
        {shares > 0n && !q && <PricesLoading />}
        <div className="pm-inner">
          <div className="pm-line"><span className="pm-muted">You receive</span><strong className="num" style={{ fontSize: 18 }}>{fmtMoney(atDex, symbol, 2)}</strong></div>
          <div className="pm-line"><span className="pm-muted">At the market price</span><span className="num">{fmtMoney(atIndex, symbol, 2)}</span></div>
          <div className="pm-line"><span className="pm-muted">Gap</span><span className={`num ${level >= 1 ? "pm-neg" : ""}`}>{gap.toFixed(2)}%</span></div>
        </div>
        {LEVELS[level] === "amber" && (
          <Notice>The exchange price is {gap.toFixed(1)}% below the market price. You can sell now, or wait until US markets open.</Notice>
        )}
        {LEVELS[level] === "red" && (
          <>
            <Notice tone="red">The exchange price is {gap.toFixed(1)}% below the market price. If you sell now you&rsquo;ll receive about {gap.toFixed(1)}% less than usual.</Notice>
            <label className="pm-row" style={{ gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I accept receiving about {gap.toFixed(1)}% less
            </label>
          </>
        )}
        <div className="pm-row">
          <button className="pm-btn" disabled={steps.running || shares === 0n || !q || (level >= 2 && !ack)} onClick={sellNow}>{steps.running ? `${steps.label}…` : "Sell now"}</button>
          {level >= 1 && <button className="pm-btn sec" disabled={steps.running} onClick={wait}>Wait for the market to open</button>}
        </div>
        {steps.error && <Notice tone="red">{steps.error}</Notice>}
        {steps.done && <Notice tone="ok">{steps.done}</Notice>}
      </div>
    </section>
  );
}
