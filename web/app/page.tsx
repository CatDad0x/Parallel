"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useEquityPrices, useFx } from "@/lib/hooks";
import "./landing.css";

function LogoMark({ size = 24, accent = "#0F6E62", ink = "#14222E" }: { size?: number; accent?: string; ink?: string }) {
  return (
    <svg width={size} height={size} viewBox="7 5 30 38" aria-hidden="true">
      <path d="M11 39 20 13" stroke={ink} strokeWidth="6.5" strokeLinecap="round" />
      <path d="M24 35 33 9" stroke={accent} strokeWidth="6.5" strokeLinecap="round" />
    </svg>
  );
}

const LINES = ["The S&P 500, in Aussie dollars", "One switch for currency protection", "Borrow without selling", "Fully onchain on Base"];

/** Engraved band of fine lines rising bottom-left to top-right, like the printing on a banknote. */
function useEngraving() {
  return useMemo(() => {
    const out: { d: string; o: string; dash: string }[] = [];
    const K = 70;
    const dashes = ["0.1 3.2", "2 2.6", "0.1 2.4", "5 2 0.1 2"];
    for (let k = 0; k < K; k++) {
      const pts: string[] = [];
      const off = (k - K / 2) * 7;
      for (let x = -20; x <= 1460; x += 16) {
        const base = 860 - x * 0.42 + 70 * Math.sin(x / 240) + 24 * Math.sin(x / 90 + k * 0.12);
        const y = base + off * (1 + 0.25 * Math.sin(x / 300 + k * 0.05));
        pts.push(`${x},${y.toFixed(1)}`);
      }
      out.push({ d: "M" + pts.join(" L"), o: (0.3 + 0.6 * Math.sin((Math.PI * (k + 0.5)) / K)).toFixed(2), dash: dashes[k % 4] });
    }
    return out;
  }, []);
}

export default function Landing() {
  const waves = useEngraving();
  const fx = useFx();
  const equities = useEquityPrices();
  const [move, setMove] = useState(10);

  const ticker = [
    fx.AUD && `A$1 = US$${fx.AUD.usdPerLocal.toFixed(4)}`,
    fx.EUR && `€1 = US$${fx.EUR.usdPerLocal.toFixed(4)}`,
    fx.INR && `₹1 = US$${fx.INR.usdPerLocal.toFixed(5)}`,
    ...equities.filter((e) => e.usd).map((e) => `${e.name === "SPY" ? "S&P 500" : e.name} US$${e.usd!.toFixed(2)}`),
  ].filter(Boolean) as string[];
  const loop = ticker.length ? [...ticker, ...ticker, ...ticker, ...ticker] : [];

  const unprotected = 10000 / (1 + move / 100);
  const fmt = (n: number) => "A$" + Math.round(n).toLocaleString("en-AU");

  return (
    <div className="landing">
      <section className="landing-hero">
        <svg className="engraving" aria-hidden="true" viewBox="0 0 1440 860" preserveAspectRatio="xMidYMid slice">
          {waves.map((w, i) => (
            <path key={i} d={w.d} fill="none" stroke="#95A4B3" strokeWidth="1" strokeLinecap="round" strokeDasharray={w.dash} strokeOpacity={w.o} />
          ))}
        </svg>
        <div className="fade" aria-hidden="true" />

        <div className="ticker" aria-label="Live prices">
          <div className="ticker-track">
            {loop.map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
        </div>

        <div className="landing-inner">
          <div className="landing-top">
            <Link href="/home" className="landing-btn outline" style={{ minHeight: 40, padding: "0 16px", fontSize: 14 }}>
              <span className="mark" style={{ color: "#0f6e62" }}>//</span>Try the demo
            </Link>
          </div>

          <div className="landing-grid">
            <div style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 36 }}>
              <h1 className="wordmark-hero">
                <LogoMark size={120} accent="#0F6E62" ink="#14222E" />
                <span>parallel</span>
              </h1>
              <ul className="hero-lines">
                {LINES.map((l) => (
                  <li key={l}>
                    <svg viewBox="0 0 12 20" aria-hidden="true">
                      <path d="M3 17 9 3" stroke="#0F6E62" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    {l}
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", paddingLeft: 26 }}>
                <Link href="/home" className="landing-btn primary">
                  <span className="mark" style={{ color: "#8FD8CB" }}>//</span>Try the demo
                </Link>
                <a href="https://github.com/CatDad0x/Parallel" className="landing-btn outline">
                  <span className="mark" style={{ color: "#0f6e62" }}>//</span>Docs
                </a>
              </div>
            </div>
            <div aria-hidden="true" style={{ flex: "0 1 380px", minWidth: 280, alignSelf: "center", background: "#fff", border: "1px solid #d6dee6", borderRadius: 14, boxShadow: "0 24px 60px -30px rgba(20,34,46,0.35)", padding: 18, display: "grid", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 15 }}>Invest</strong>
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#dceeea", color: "#0b5a50" }}>Protected</span>
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#56626e" }}>You invest</span>
                <span style={{ fontWeight: 500, fontSize: 34, letterSpacing: "-0.04em" }}>A$500</span>
              </div>
              <div style={{ display: "grid", gap: 8, borderTop: "1px solid #e6ebf0", paddingTop: 12, fontSize: 13 }}>
                {[["S&P 500", "A$500"], ["Currency protection", "Included"], ["You get", "about A$498"]].map(([l, v]) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#56626e" }}>{l}</span><strong>{v}</strong>
                  </div>
                ))}
              </div>
              <div style={{ background: "#0f6e62", color: "#fff", borderRadius: 8, textAlign: "center", padding: "11px 0", fontSize: 14, fontWeight: 600 }}>Confirm and invest A$500</div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section" id="currency">
        <div className="landing-inner" style={{ display: "flex", flexWrap: "wrap", gap: 64, alignItems: "center", padding: "110px 40px" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 22 }}>
            <span style={{ display: "flex", alignItems: "center", fontSize: 14, fontWeight: 700, color: "#2a3542" }}>
              <span className="mark" style={{ color: "#0f6e62" }}>//</span>The part people miss
            </span>
            <h2 style={{ margin: 0, fontWeight: 500, fontSize: 52, lineHeight: 1.02, letterSpacing: "-0.045em" }}>
              Your shares can stand still.
              <br />
              Your currency doesn&rsquo;t.
            </h2>
            <p style={{ maxWidth: 460, fontSize: 17, lineHeight: 1.6, color: "#3e4a56" }}>
              If the Aussie dollar gets stronger, the same US shares are worth fewer Australian dollars. Currency protection
              aims to cancel that out. It also gives up the gain when the Aussie dollar gets weaker.
            </p>
          </div>
          <div className="slider-card" style={{ flex: "1 1 420px", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 500 }}>A$10,000 invested</span>
              <span style={{ fontSize: 13, color: "#66737f" }}>US shares unchanged</span>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "#3e4a56" }}>
                <label htmlFor="fx">Aussie dollar gets stronger by</label>
                <strong style={{ color: "#14222e" }}>{move}%</strong>
              </div>
              <input id="fx" type="range" min={0} max={20} value={move} onChange={(e) => setMove(Number(e.target.value))} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", borderTop: "1px solid #d6dee6" }}>
              <div style={{ display: "grid", gap: 6, padding: "22px 20px 4px 0", borderRight: "1px solid #d6dee6" }}>
                <span style={{ fontSize: 13, color: "#56626e" }}>Without protection</span>
                <span style={{ fontWeight: 500, fontSize: 40, letterSpacing: "-0.045em", color: "#8e3b2e" }}>{fmt(unprotected)}</span>
                <span style={{ fontSize: 12, color: "#56626e" }}>{move > 0 ? `−${fmt(10000 - unprotected)} from the currency move` : "No currency move"}</span>
              </div>
              <div style={{ display: "grid", gap: 6, padding: "22px 0 4px 20px" }}>
                <span style={{ display: "flex", alignItems: "center", fontSize: 13 }}>
                  <span className="mark" style={{ color: "#0f6e62" }}>//</span>With protection
                </span>
                <span style={{ fontWeight: 500, fontSize: 40, letterSpacing: "-0.045em" }}>A$10,000</span>
                <span style={{ fontSize: 12, color: "#56626e" }}>Before costs and fees</span>
              </div>
            </div>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: "#56626e" }}>
              Simplified example. Real hedges have costs and won&rsquo;t cancel every swing. You can still lose money if share
              prices fall.
            </span>
          </div>
        </div>
      </section>

      <footer style={{ maxWidth: 1280, margin: "0 auto", padding: "36px 40px 48px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#56626e" }}>
        <span>Demo on Base Sepolia · test money only · currency protection is simulated · rates and costs are illustrative</span>
        <span>Not affiliated with any stablecoin issuer</span>
      </footer>
    </div>
  );
}
