"use client";

import Link from "next/link";
import { Simulator } from "@/components/Simulator";
import { useCurrency } from "@/lib/currency";

const NAMES: Record<string, string> = { AUD: "Australian dollars", EUR: "euros", INR: "rupees" };

export default function Home() {
  const { currency } = useCurrency();
  return (
    <div className="page" style={{ gap: 56 }}>
      <section className="stack" style={{ gap: 16, paddingTop: 24 }}>
        <h1 style={{ maxWidth: "18ch" }}>US shares, held in {NAMES[currency]}.</h1>
        <p className="lede">
          Deposit a local stablecoin, invest in the S&amp;P 500 or a US tech basket, and choose whether the currency
          swing is yours to keep or hedged away. Then borrow against what you hold.
        </p>
        <div className="row">
          <Link href="/try" className="btn">
            Try the demo
          </Link>
          <Link href="/vaults" className="btn secondary">
            See the vaults
          </Link>
        </div>
      </section>

      <section className="stack" style={{ gap: 20 }}>
        <div className="page-head">
          <h2>What a currency move does to your US shares</h2>
          <p className="muted" style={{ maxWidth: "70ch" }}>
            When your currency strengthens, the same US shares are worth less at home. Move the sliders to compare an
            unhedged position with a hedged one.
          </p>
        </div>
        <Simulator compact />
        <Link href="/simulator" className="small">
          Open the full simulator with time horizons and hedge styles
        </Link>
      </section>

      <section className="how">
        <div>
          <h3>Deposit in your currency</h3>
          <p className="muted">AUDD, AUDM, EURC or INR stablecoins go in. Everything is valued in your currency.</p>
        </div>
        <div>
          <h3>Pick hedged or unhedged</h3>
          <p className="muted">
            Each strategy comes both ways. The hedged version offsets moves in your currency against the US dollar.
          </p>
        </div>
        <div>
          <h3>Borrow without selling</h3>
          <p className="muted">
            Post your vault shares as collateral and borrow your own currency. Hedged shares can support a larger loan.
          </p>
        </div>
        <style>{`
          .how { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; border-top: 1px solid var(--line); padding-top: 32px; }
          .how > div { display: grid; gap: 6px; align-content: start; }
          @media (max-width: 760px) { .how { grid-template-columns: 1fr; gap: 20px; } }
        `}</style>
      </section>
    </div>
  );
}
