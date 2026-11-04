"use client";

import { useMemo, useState } from "react";
import { runScenario } from "@parallel/shared";
import { useCurrency } from "@/lib/currency";
import { money, pct, signedMoney } from "@/lib/format";

/** Illustrative annual hedge carry per currency (bps, + = cost). Matches the testnet deployment. */
const CARRY: Record<string, number> = { AUD: 50, EUR: 150, INR: -250 };
const NAMES: Record<string, string> = { AUD: "Australian dollar", EUR: "Euro", INR: "Indian rupee" };
const DEFAULT_AMOUNT: Record<string, number> = { AUD: 10_000, EUR: 10_000, INR: 800_000 };

export function Simulator({ compact = false }: { compact?: boolean }) {
  const { currency, meta } = useCurrency();
  const [amountOverride, setAmount] = useState<number | null>(null);
  const amount = amountOverride ?? DEFAULT_AMOUNT[currency];
  const [fx, setFx] = useState(10);
  const [eq, setEq] = useState(0);
  const [rebalanced, setRebalanced] = useState(true);
  const [years, setYears] = useState(1);

  const r = useMemo(
    () =>
      runScenario({
        amount,
        equityMovePct: eq,
        fxMovePct: fx,
        years,
        carryBpsPerYear: CARRY[currency],
        feeBpsPerYear: 50,
        cashBufferPct: 3,
        spreadBps: 10,
        rebalanced,
      }),
    [amount, eq, fx, years, currency, rebalanced],
  );

  const s = meta.symbol;
  const fxWord = fx === 0 ? "stays flat" : fx > 0 ? `strengthens ${fx}%` : `weakens ${Math.abs(fx)}%`;
  const eqWord = eq === 0 ? "flat" : eq > 0 ? `up ${eq}%` : `down ${Math.abs(eq)}%`;

  return (
    <section className="sim" aria-label="Hedging simulator">
      <div className="sim-controls">
        <div className="field">
          <label htmlFor="sim-amount">You invest</label>
          <div className="amount">
            <input
              id="sim-amount"
              inputMode="decimal"
              value={amount.toLocaleString("en-AU")}
              onChange={(e) => {
                const v = Number(e.target.value.replace(/[^0-9.]/g, ""));
                if (Number.isFinite(v)) setAmount(v);
              }}
            />
            <span className="unit">{currency}</span>
          </div>
        </div>

        <Slider
          id="sim-fx"
          label={`The ${NAMES[currency]} ${fxWord} against the US dollar`}
          value={fx}
          min={-25}
          max={25}
          onChange={setFx}
          tone="gold"
        />
        <Slider
          id="sim-eq"
          label={`US shares are ${eqWord} in US dollars`}
          value={eq}
          min={-40}
          max={40}
          onChange={setEq}
          tone="green"
        />

        {!compact && (
          <div className="row">
            <div className="seg" role="group" aria-label="Hedge style">
              <button aria-pressed={rebalanced} onClick={() => setRebalanced(true)}>
                Hedge kept in line
              </button>
              <button aria-pressed={!rebalanced} onClick={() => setRebalanced(false)}>
                Hedge set once
              </button>
            </div>
            <div className="seg" role="group" aria-label="Time horizon">
              {[1, 3, 5].map((y) => (
                <button key={y} aria-pressed={years === y} onClick={() => setYears(y)}>
                  {y} yr
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="sim-results">
        <Ledger
          title="Unhedged"
          caption="You keep the currency swing"
          start={amount}
          end={r.unhedged}
          symbol={s}
          tone="gold"
          lines={[
            ["US share move", r.equityEffect],
            ["Currency move", r.fxEffectUnhedged],
            ["Fees and spread", -r.costs],
          ]}
        />
        <Ledger
          title="Hedged"
          caption="The currency swing is offset"
          start={amount}
          end={r.hedged}
          symbol={s}
          tone="ink"
          lines={[
            ["US share move", r.equityEffect],
            ["Currency move", r.fxEffectUnhedged],
            ["Hedge result", r.hedgePnl],
            ["Fees and spread", -r.costs],
          ]}
        />
      </div>

      <p className="hint sim-note">
        Simulated outcome over {years} {years === 1 ? "year" : "years"}, including a 3% cash buffer, 0.10% trading spread
        each way, 0.50% yearly fee and an illustrative hedging {CARRY[currency] >= 0 ? "cost" : "benefit"} of{" "}
        {Math.abs(CARRY[currency]) / 100}% a year. Hedging reduces currency risk; share prices can still fall.
      </p>

      <style>{`
        .sim { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.3fr); gap: 32px; align-items: start; }
        .sim-controls { display: grid; gap: 22px; }
        .sim-results { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .sim-note { grid-column: 1 / -1; max-width: 80ch; }
        @media (max-width: 900px) { .sim { grid-template-columns: 1fr; } }
        @media (max-width: 520px) { .sim-results { grid-template-columns: 1fr; } }
        .ledger { border-radius: var(--radius-m); padding: 20px; display: grid; gap: 14px; border: 1px solid var(--line); }
        .ledger.gold { background: var(--gold-soft); border-color: transparent; }
        .ledger.ink { background: var(--ink); color: var(--paper); border-color: transparent; }
        .ledger.ink .muted { color: color-mix(in srgb, var(--paper) 70%, transparent); }
        .ledger-end { font-size: clamp(2rem, 4vw, 2.8rem); font-weight: 850; letter-spacing: -0.035em; line-height: 1; }
        .ledger-lines { display: grid; gap: 6px; font-size: 0.92rem; margin: 0; }
        .ledger-lines div { display: flex; justify-content: space-between; gap: 8px; }
        .ledger-lines dd { margin: 0; font-weight: 650; }
        .ledger-bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 15%, transparent); overflow: hidden; }
        .ledger-bar span { display: block; height: 100%; background: currentColor; }
        .slider { display: grid; gap: 8px; }
        .slider label { font-weight: 650; }
        .slider-row { display: flex; align-items: center; gap: 12px; }
        .slider input[type=range] { flex: 1; accent-color: var(--ink); padding: 0; border: 0; }
        .slider.gold input[type=range] { accent-color: var(--gold); }
        .slider.green input[type=range] { accent-color: var(--green); }
        .slider-val { min-width: 4.5ch; text-align: right; font-weight: 750; }
      `}</style>
    </section>
  );
}

function Slider(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  tone: "gold" | "green";
}) {
  return (
    <div className={`slider ${props.tone}`}>
      <label htmlFor={props.id}>{props.label}</label>
      <div className="slider-row">
        <input
          id={props.id}
          type="range"
          min={props.min}
          max={props.max}
          step={1}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
        <span className="slider-val">{pct(props.value, 0, true)}</span>
      </div>
    </div>
  );
}

function Ledger(props: {
  title: string;
  caption: string;
  start: number;
  end: number;
  symbol: string;
  tone: "gold" | "ink";
  lines: [string, number][];
}) {
  const change = props.start ? ((props.end - props.start) / props.start) * 100 : 0;
  const width = Math.max(0, Math.min(100, (props.end / (props.start * 1.5)) * 100));
  return (
    <div className={`ledger ${props.tone}`} aria-live="polite">
      <div>
        <h3>{props.title}</h3>
        <p className="small muted">{props.caption}</p>
      </div>
      <div>
        <div className="ledger-end">{money(props.end, props.symbol, 0)}</div>
        <div className="small" style={{ marginTop: 6, fontWeight: 650 }}>
          {pct(change, 1, true)} on {money(props.start, props.symbol, 0)}
        </div>
      </div>
      <div className="ledger-bar" aria-hidden>
        <span style={{ width: `${width}%` }} />
      </div>
      <dl className="ledger-lines">
        {props.lines.map(([k, v]) => (
          <div key={k}>
            <dt className="muted">{k}</dt>
            <dd>{signedMoney(v, props.symbol, 0)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
