"use client";

import Link from "next/link";
import { deployment } from "@/lib/config";
import { useMarkets } from "@/lib/lending";
import { useAccount } from "wagmi";
import { useState } from "react";
import { useLiquidation } from "@/lib/liquidations";
import { useNavHistories, holdingsSeries, useActivity, pctSeries, type NavPoint } from "@/lib/history";
import { PanelChart, Spark, within } from "@/components/Charts";
import { useLoans, useProducts, useWallet, userSharesValue, PRODUCT_META, Slash, Notice, fmtMoney, useDeviation } from "@/lib/pm";

export default function Home() {
  const { symbol, balance } = useWallet();
  const { stats } = useProducts();
  const { loans } = useLoans();
  const { states } = useMarkets(loans.map((l) => l.market));
  const dev = useDeviation();
  const { liquidation, dismiss } = useLiquidation();
  const { address } = useAccount();
  const hist = useNavHistories(stats.map((s) => s.info.address));
  const activity = useActivity(address);
  const [range, setRange] = useState(0); // ms, 0 = all
  const liqStrategy = deployment.vaults.find((v) => v.address === deployment.markets.find((m) => m.id === liquidation?.marketId)?.collateralToken)?.strategy;
  const liqName = liqStrategy ? PRODUCT_META[liqStrategy].name : "investment";

  const rows = stats.map((s) => {
    const col = loans.find((l) => l.market.collateralToken === s.info.address)?.collateralShares ?? 0n;
    const locked = loans.some((l) => l.market.collateralToken === s.info.address && l.borrowed > 0);
    return { s, value: userSharesValue(s, col), locked };
  });
  const invested = rows.reduce((a, r) => a + (Number.isFinite(r.value) ? r.value : 0), 0);
  const borrowed = loans.reduce((a, l) => a + l.borrowed, 0);
  const earning = states.reduce((a, s) => a + s.user.supplyAssets, 0);
  const total = invested + balance + earning - borrowed;

  const series = within(
    holdingsSeries(
      stats.map((s) => ({ address: s.info.address, shares: Number(s.userShares + (loans.find((l) => l.market.collateralToken === s.info.address)?.collateralShares ?? 0n)) / 1e18 })),
      hist,
    ),
    range,
  );
  const ago = (t?: number) => {
    if (!t) return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const verb: Record<string, string> = { Invest: "Invested", Sell: "Sold", Borrow: "Borrowed", Repay: "Repaid", Lend: "Lent", Withdraw: "Withdrew" };

  const parts: [string, string][] = [
    ["Invested", fmtMoney(invested, symbol)],
    ["Test money", fmtMoney(balance, symbol)],
    ["Earning", fmtMoney(earning, symbol)],
    ["Borrowed", borrowed > 0 ? "−" + fmtMoney(borrowed, symbol) : fmtMoney(0, symbol)],
  ];
  const tiles = [
    { href: "/invest", title: "Invest", sub: "US shares in your own currency, with currency protection.", cta: "Start investing" },
    { href: "/borrow", title: "Borrow", sub: "Get cash against your investments without selling.", cta: "See how much" },
    { href: "/earn", title: "Earn", sub: "Lend your currency and earn interest.", cta: "See rates" },
  ];

  return (
    <>
      {liquidation && (
        <Notice tone="warn">
          <strong>Some of your {liqName} was sold to repay part of your loan.</strong>{" "}
          Your shares lost value and your loan got too big for them, so about {fmtMoney(liquidation.repaid, symbol)} of the loan was repaid automatically.
          The rest of your loan and shares are unchanged.{" "}
          <Link href="/borrow" className="pm-link">See your loan</Link>{" "}
          <button className="pm-link" onClick={dismiss}>Dismiss</button>
        </Notice>
      )}
      {dev.level >= 1 && (
        <Notice tone={dev.level >= 2 ? "red" : "warn"}>
          <strong>The share price on the exchange is {Math.abs(dev.driftBps) / 100}% away from the market price.</strong>{" "}
          {dev.level >= 3
            ? "New borrowing is paused until it settles."
            : "You can still use the app. Selling right now may give you less than usual."}
        </Notice>
      )}
      <section aria-label="Your total" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 24, padding: "40px 32px 32px", borderBottom: "1px solid var(--pm-line)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="pm-eyebrow"><Slash />Your total</span>
          <strong className="pm-big num">{fmtMoney(total, symbol)}</strong>
        </div>
        <div className="pm-stats" style={{ minWidth: 420 }}>
          {parts.map(([l, v]) => (
            <div className="pm-stat" key={l}>
              <span>{l}</span>
              <strong className="num">{v}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="pm-tiles">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="pm-tile">
            <h3><Slash />{t.title}</h3>
            <p>{t.sub}</p>
            <b>{t.cta} →</b>
          </Link>
        ))}
      </div>

      <section className="pm-pad pm-sec" style={{ paddingTop: 28 }}>
        <div className="pm-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", alignItems: "start" }}>
          <div className="pm-card">
            <div className="pm-row pm-spread" style={{ padding: "14px 18px", borderBottom: "1px solid var(--pm-line2)" }}>
              <h2 style={{ fontSize: 14 }}><Slash />Your investments over time</h2>
              <div className="pm-row" style={{ gap: 6 }}>
                {([["1H", 3_600_000], ["6H", 21_600_000], ["All", 0]] as const).map(([l, ms]) => (
                  <button key={l} className="pm-chip" aria-pressed={range === ms} onClick={() => setRange(ms)}>{l}</button>
                ))}
              </div>
            </div>
            {series.length >= 2 ? (
              <PanelChart series={[series]} label="Value of your current investments over time" axis={(v) => fmtMoney(v, symbol)} />
            ) : (
              <p className="pm-muted" style={{ padding: 24 }}>{invested > 0 ? "Loading your price history…" : "Invest to see how your money grows."}</p>
            )}
            <p className="pm-small pm-muted" style={{ padding: "0 18px 14px" }}>Today&rsquo;s holdings at past share prices. An estimate: it ignores when you bought.</p>
          </div>
          <div className="pm-card">
            <div className="pm-row pm-spread" style={{ padding: "14px 18px", borderBottom: "1px solid var(--pm-line2)" }}>
              <h2 style={{ fontSize: 14 }}><Slash />Recent activity</h2>
            </div>
            {activity === undefined ? (
              <p className="pm-muted" style={{ padding: 24 }}>Loading…</p>
            ) : activity.length === 0 ? (
              <p className="pm-muted" style={{ padding: 24 }}>Nothing yet. Your actions will show up here.</p>
            ) : (
              activity.map((a, i) => (
                <div key={i} className="pm-row pm-spread" style={{ minHeight: 48, padding: "0 18px", borderTop: i ? "1px solid var(--pm-line2)" : undefined }}>
                  <span><strong>{verb[a.kind]}</strong> <span className="num">{fmtMoney(a.amount, symbol)}</span></span>
                  <span className="pm-small pm-muted">{ago(a.t)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="pm-pad pm-sec" style={{ paddingTop: 0 }}>
        <div className="pm-row pm-spread">
          <h2><Slash />Your investments</h2>
          <Link href="/portfolio" className="pm-link">See portfolio</Link>
        </div>
        <div className="pm-card">
          {rows.every((r) => !(r.value > 0)) ? (
            <div style={{ padding: 24, display: "grid", gap: 12 }}>
              <p className="pm-muted">You don&rsquo;t own any investments yet.</p>
              <div><Link href="/invest" className="pm-btn sm">Start investing</Link></div>
            </div>
          ) : (
            rows
              .filter((r) => r.value > 0)
              .map((r, i) => (
                <div key={r.s.info.address} className="pm-row" style={{ minHeight: 64, padding: "0 18px", borderTop: i ? "1px solid var(--pm-line2)" : undefined }}>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span><strong style={{ fontSize: 15 }}>{PRODUCT_META[r.s.info.strategy].name}</strong>{" "}
                      <span className="pm-small" style={{ color: "var(--pm-faint)" }}>{r.s.info.symbol}</span></span>
                    <span className="pm-small pm-muted">Currency protected{r.locked ? " · securing your loan" : ""}</span>
                  </div>
                  <Spark pts={pctSeries(hist[r.s.info.address.toLowerCase()] ?? [] as NavPoint[])} />
                  <strong className="num" style={{ fontSize: 15, minWidth: 90, textAlign: "right" }}>{fmtMoney(r.value, symbol)}</strong>
                </div>
              ))
          )}
        </div>
        <p className="pm-small pm-muted">All values in your currency. Share prices can fall. Currency protection is simulated; figures are illustrative.</p>
      </section>
    </>
  );
}
