"use client";

import Link from "next/link";
import { useState } from "react";
import { useCurrency } from "@/lib/currency";
import { Logo } from "@/components/Shell";
import { fmtMoney } from "@/lib/pm";

const NAMES: Record<string, string> = { AUD: "Australian dollars", EUR: "euros", INR: "rupees" };
const SHORT: Record<string, string> = { AUD: "A$", EUR: "euro", INR: "rupee" };

export default function Landing() {
  const { currency, meta } = useCurrency();
  const [rise, setRise] = useState(10);
  const start = 10_000;
  const without = start / (1 + rise / 100);
  return (
    <div className="pm-land">
      <div className="pm-land-nav">
        <span className="pm-brand" style={{ padding: 0 }}>
          <Logo size={28} />
          <span>parallel</span>
          <span className="pm-tag" style={{ marginLeft: 8 }}>Demo</span>
        </span>
        <Link href="/home" className="pm-btn sm">Try the demo</Link>
      </div>

      <section className="pm-hero" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <h1>US shares, held in {NAMES[currency]}.</h1>
        <p className="pm-lede" style={{ fontSize: 18 }}>
          Invest in the S&amp;P 500 or US tech with your own currency, protected from currency swings. Then borrow against
          what you hold, without selling.
        </p>
        <div className="pm-row">
          <Link href="/home" className="pm-btn">Try the demo</Link>
          <span className="pm-small pm-muted">Test money on a test network. Nothing here is real.</span>
        </div>
      </section>

      <section className="pm-card" style={{ padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
        <h2 style={{ fontSize: 22 }}>What a currency move does to your US shares</h2>
        <p className="pm-muted">
          If the {SHORT[currency]} rises against the US dollar, the same shares are worth less at home. Move the slider and
          assume share prices don&rsquo;t change.
        </p>
        <div className="pm-field">
          <label htmlFor="rise">The {meta.code} rises {rise}%</label>
          <input id="rise" className="pm-range" type="range" min={0} max={30} value={rise} onChange={(e) => setRise(Number(e.target.value))} />
        </div>
        <div className="pm-grid">
          <div className="pm-inner" style={{ padding: 16 }}>
            <span className="pm-muted pm-small">{fmtMoney(start, meta.symbol)} without protection</span>
            <strong className="num pm-neg" style={{ fontSize: 32, letterSpacing: -1 }}>{fmtMoney(without, meta.symbol)}</strong>
          </div>
          <div className="pm-inner" style={{ padding: 16 }}>
            <span className="pm-muted pm-small">{fmtMoney(start, meta.symbol)} with protection</span>
            <strong className="num pm-pos" style={{ fontSize: 32, letterSpacing: -1 }}>{fmtMoney(start, meta.symbol)}</strong>
          </div>
        </div>
        <p className="pm-small pm-muted">
          Before costs. Protection also gives up gains if the {SHORT[currency]} falls. Currency protection is simulated on
          test contracts.
        </p>
      </section>

      <section className="pm-steps">
        <div>
          <h3>Invest</h3>
          <p className="pm-muted">Pay in your own stablecoin. We buy US shares and protect you from currency swings.</p>
        </div>
        <div>
          <h3>Borrow</h3>
          <p className="pm-muted">Use your investment as security for a loan in your own currency.</p>
        </div>
        <div>
          <h3>Earn</h3>
          <p className="pm-muted">Lend your currency to borrowers and earn interest.</p>
        </div>
      </section>

      <p className="pm-small pm-muted">
        Share prices can fall. Costs, rates and currency protection are illustrative and simulated on test contracts. Not
        affiliated with any stablecoin issuer.
      </p>
    </div>
  );
}
