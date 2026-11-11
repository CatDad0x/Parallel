"use client";

import Link from "next/link";
import { useMarkets } from "@/lib/lending";
import { useLoans, useProducts, useWallet, userSharesValue, PRODUCT_META, Slash, Notice, fmtMoney, useDeviation } from "@/lib/pm";

export default function Home() {
  const { symbol, balance } = useWallet();
  const { stats } = useProducts();
  const { loans } = useLoans();
  const { states } = useMarkets(loans.map((l) => l.market));
  const dev = useDeviation();

  const rows = stats.map((s) => {
    const col = loans.find((l) => l.market.collateralToken === s.info.address)?.collateralShares ?? 0n;
    const locked = loans.some((l) => l.market.collateralToken === s.info.address && l.borrowed > 0);
    return { s, value: userSharesValue(s, col), locked };
  });
  const invested = rows.reduce((a, r) => a + (Number.isFinite(r.value) ? r.value : 0), 0);
  const borrowed = loans.reduce((a, l) => a + l.borrowed, 0);
  const earning = states.reduce((a, s) => a + s.user.supplyAssets, 0);
  const total = invested + balance + earning - borrowed;

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
                  <strong className="num" style={{ fontSize: 15 }}>{fmtMoney(r.value, symbol)}</strong>
                </div>
              ))
          )}
        </div>
        <p className="pm-small pm-muted">All values in your currency. Share prices can fall. Currency protection is simulated; figures are illustrative.</p>
      </section>
    </>
  );
}
