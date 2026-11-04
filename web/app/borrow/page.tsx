"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { morphoAbi, routerAbi, tokenAbi, marketParams, CURRENCIES } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useMarketOpen, useSteps } from "@/lib/hooks";
import { useMarkets, type MarketState } from "@/lib/lending";
import { money, num, pct } from "@/lib/format";

export default function Borrow() {
  const { currency } = useCurrency();
  const markets = useMemo(() => {
    const loan = deployment.tokens.find((t) => t.symbol === CURRENCIES.find((c) => c.code === currency)!.stables[0])!;
    return deployment.markets.filter((m) => m.loanToken === loan.address);
  }, [currency]);
  const { states, refetch } = useMarkets(markets);
  const [sel, setSel] = useState(0);
  const st = states[Math.min(sel, states.length - 1)];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Borrow {currency}</h1>
        <p className="lede">
          Post mock S&amp;P 500 tokens or your vault shares as collateral and borrow {currency} without selling.
        </p>
      </div>

      <div className="seg" role="group" aria-label="Collateral">
        {states.map((s, i) => (
          <button key={s.m.id} aria-pressed={i === sel} onClick={() => setSel(i)}>
            {collateralName(s)}
          </button>
        ))}
      </div>

      {st && <MarketPanel st={st} onDone={refetch} />}

      <p className="notice small" style={{ maxWidth: "80ch" }}>
        Limits are illustrative, pending proper risk calibration. Parallel Markets&rsquo;s app pauses new borrowing while US
        markets are closed and caps the opening loan below the liquidation level. These are app-level controls: the
        underlying Morpho Blue market does not enforce them.
      </p>
    </div>
  );
}

function collateralName(s: MarketState) {
  const v = deployment.vaults.find((x) => x.address === s.m.collateralToken);
  if (v) return `${v.name.replace("Parallel ", "")} shares`;
  return "Mock S&P 500 tokens";
}

function MarketPanel({ st, onDone }: { st: MarketState; onDone: () => void }) {
  const { address } = useAccount();
  const { open } = useMarketOpen();
  const cur = CURRENCIES.find((c) => c.stables[0] === deployment.tokens.find((t) => t.address === st.m.loanToken)?.symbol)!;
  const s = cur.symbol;
  const collToken = st.m.collateralToken;
  const vault = deployment.vaults.find((v) => v.address === collToken);
  const collDecimals = 18;
  const { balances, refetch: refetchBal } = useBalances([collToken, st.m.loanToken]);
  const [collIn, setCollIn] = useState("");
  const [borrowIn, setBorrowIn] = useState("");
  const [repayIn, setRepayIn] = useState("");
  const [withdrawIn, setWithdrawIn] = useState("");
  const steps = useSteps();
  const mp = marketParams(st.m);

  const { data: oraclePrice } = useReadContract({
    address: st.m.oracle,
    abi: [{ type: "function", name: "price", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
    functionName: "price",
  });
  const { data: allowColl } = useReadContract({
    address: collToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address },
  });
  const { data: allowLoan } = useReadContract({
    address: st.m.loanToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address },
  });

  const p = (v: string, d: number) => { try { return v ? parseUnits(v, d) : 0n; } catch { return 0n; } };
  const collAmt = p(collIn, collDecimals);
  const borrowAmt = p(borrowIn, 6);
  const repayAmt = p(repayIn, 6);
  const withdrawAmt = p(withdrawIn, collDecimals);

  // Value of 1 whole collateral unit in loan currency (Morpho scale 1e36 * 10^(dLoan - dColl)).
  const unitValue = oraclePrice ? Number(oraclePrice) / 1e36 * 10 ** (collDecimals - 6) : 0;
  const postedValue = (Number(st.user.collateral) / 1e18) * unitValue;
  const lltv = Number(BigInt(st.m.lltv)) / 1e18;
  const openLtv = Number(BigInt(st.m.maxOpenLtv)) / 1e18;
  const newColl = postedValue + (Number(collAmt) / 1e18) * unitValue;
  const newDebt = st.user.borrowAssets + Number(borrowAmt) / 1e6;
  const newLtv = newColl > 0 ? newDebt / newColl : 0;
  const maxNew = Math.max(0, newColl * openLtv - st.user.borrowAssets);
  const dropToLiq = newLtv > 0 ? 1 - newLtv / lltv : 1;

  async function borrow() {
    const ok = await steps.run(
      [
        { label: "Allowing Parallel Markets to borrow for you", address: deployment.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [deployment.router, true], skip: st.user.authorized || borrowAmt === 0n },
        { label: "Approving collateral", address: collToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, collAmt], skip: collAmt === 0n || ((allowColl as bigint | undefined) ?? 0n) >= collAmt },
        { label: borrowAmt > 0n ? "Borrowing" : "Adding collateral", address: deployment.router, abi: routerAbi, functionName: "supplyCollateralAndBorrow", args: [mp, collAmt, borrowAmt] },
      ],
      borrowAmt > 0n ? `Borrowed ${money(Number(borrowAmt) / 1e6, s)}.` : "Collateral added.",
    );
    if (ok) { setCollIn(""); setBorrowIn(""); refetchBal(); onDone(); }
  }

  async function repay(all: boolean) {
    const need = all ? BigInt(Math.ceil(st.user.borrowAssets * 1.001 * 1e6)) + 1_000n : repayAmt;
    const ok = await steps.run(
      [
        { label: "Allowing Parallel Markets to manage your loan", address: deployment.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [deployment.router, true], skip: st.user.authorized || withdrawAmt === 0n },
        { label: "Approving repayment", address: st.m.loanToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, need], skip: need === 0n || ((allowLoan as bigint | undefined) ?? 0n) >= need },
        { label: all ? "Repaying in full" : "Repaying", address: deployment.router, abi: routerAbi, functionName: "repayAndWithdraw", args: [mp, all ? 0n : repayAmt, all, withdrawAmt] },
      ],
      all ? "Loan repaid in full." : "Done.",
    );
    if (ok) { setRepayIn(""); setWithdrawIn(""); refetchBal(); onDone(); }
  }

  const hf = st.user.hf;
  return (
    <div className="two-col">
      <div className="stack" style={{ gap: 24 }}>
        <div className="row" style={{ gap: 40 }}>
          <Stat label="Your loan" value={money(st.user.borrowAssets, s)} />
          <Stat label="Collateral value" value={money(postedValue, s)} />
          <Stat
            label="Health"
            value={hf === Infinity ? "No loan" : hf.toFixed(2)}
            tone={hf < 1.1 ? "neg" : hf < 1.3 ? "" : "pos"}
            hint="Below 1.00 the loan can be liquidated."
          />
        </div>

        <LtvBar ltv={st.user.ltv} openLtv={openLtv} lltv={lltv} preview={borrowAmt > 0n || collAmt > 0n ? newLtv : undefined} />

        <dl className="kv" style={{ maxWidth: 520 }}>
          <dt>Max opening loan-to-value</dt>
          <dd>{pct(openLtv * 100, 0)}</dd>
          <dt>Liquidation loan-to-value</dt>
          <dd>{pct(lltv * 100, 1)}</dd>
          <dt>Borrow rate now</dt>
          <dd>{pct(st.borrowApr * 100, 2)} a year</dd>
          <dt>Available to borrow in this market</dt>
          <dd>{money(st.supplyAssets - st.borrowAssets, s, 0)}</dd>
          {vault && (
            <>
              <dt>Collateral priced at</dt>
              <dd>Withdrawal value per share</dd>
            </>
          )}
        </dl>

        {vault ? (
          <p className="muted small" style={{ maxWidth: "70ch" }}>
            {vault.hedged
              ? "Hedged shares move less when your currency moves, which is why this market allows a higher loan. The hedge adds its own costs and dependencies."
              : "Unhedged shares move with both US shares and your currency."}{" "}
            If liquidated, the liquidator redeems the shares from the vault, or queues the redemption when US markets are
            closed. Don&rsquo;t hold shares yet? <Link href={`/vaults/${vault.address}`}>Deposit first</Link>.
          </p>
        ) : (
          <p className="muted small" style={{ maxWidth: "70ch" }}>
            You received mock S&amp;P 500 tokens with your test funds. If liquidated, the liquidator sells them, or holds
            them until US markets reopen.
          </p>
        )}
      </div>

      <aside className="panel stack" style={{ position: "sticky", top: 88 }}>
        <h3>Add collateral and borrow</h3>
        {open === false && <p className="notice">US markets are closed. You can add collateral and repay, but new borrowing waits for the open.</p>}
        <div className="field">
          <label htmlFor="coll">Add collateral</label>
          <div className="amount">
            <input id="coll" inputMode="decimal" placeholder="0" value={collIn} onChange={(e) => setCollIn(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="unit">{vault ? "shares" : "mSPY"}</span>
          </div>
          <div className="row spread hint">
            <span>Wallet: {num(balances[0], 18).toLocaleString("en-AU", { maximumFractionDigits: 4 })}</span>
            <button className="link-btn" onClick={() => setCollIn(formatUnits(balances[0], 18))}>Use max</button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="bor">Borrow</label>
          <div className="amount">
            <input id="bor" inputMode="decimal" placeholder="0" value={borrowIn} onChange={(e) => setBorrowIn(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="unit">{cur.code}</span>
          </div>
          <div className="row spread hint">
            <span>Up to {money(maxNew * 0.999, s)}</span>
            <button className="link-btn" onClick={() => setBorrowIn((Math.floor(maxNew * 0.999 * 100) / 100).toString())}>Use max</button>
          </div>
        </div>
        {borrowAmt > 0n && (
          <p className="small muted">
            After this, a fall of {pct(Math.max(0, dropToLiq) * 100, 1)} in the collateral&rsquo;s value in {cur.code} would
            make the loan liquidatable.
          </p>
        )}
        <button
          className="btn"
          disabled={!address || steps.running || (collAmt === 0n && borrowAmt === 0n) || newLtv > openLtv || (borrowAmt > 0n && open === false) || collAmt > balances[0]}
          onClick={borrow}
        >
          {steps.running ? steps.label : newLtv > openLtv ? "Above the opening limit" : borrowAmt > 0n ? "Borrow" : "Add collateral"}
        </button>

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%" }} />

        <h3>Repay and withdraw</h3>
        <div className="field">
          <label htmlFor="rep">Repay</label>
          <div className="amount">
            <input id="rep" inputMode="decimal" placeholder="0" value={repayIn} onChange={(e) => setRepayIn(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="unit">{cur.code}</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="wd">Withdraw collateral</label>
          <div className="amount">
            <input id="wd" inputMode="decimal" placeholder="0" value={withdrawIn} onChange={(e) => setWithdrawIn(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="unit">{vault ? "shares" : "mSPY"}</span>
          </div>
          <span className="hint">Posted: {num(st.user.collateral, 18).toLocaleString("en-AU", { maximumFractionDigits: 4 })}</span>
        </div>
        <div className="row">
          <button className="btn secondary" disabled={!address || steps.running || (repayAmt === 0n && withdrawAmt === 0n)} onClick={() => repay(false)}>
            Confirm
          </button>
          <button className="btn secondary" disabled={!address || steps.running || st.user.borrowAssets === 0} onClick={() => repay(true)}>
            Repay in full
          </button>
        </div>
        {steps.error && <p className="notice error">{steps.error}</p>}
        {steps.done && <p className="notice ok">{steps.done}</p>}
      </aside>
    </div>
  );
}

function Stat({ label, value, tone = "", hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="small muted">{label}</div>
      <div className={`big ${tone}`} style={{ fontSize: "1.6rem" }}>{value}</div>
    </div>
  );
}

/** Loan-to-value on a track: safe zone, opening limit, liquidation line. */
function LtvBar({ ltv, openLtv, lltv, preview }: { ltv: number; openLtv: number; lltv: number; preview?: number }) {
  const w = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;
  return (
    <div className="ltv" role="img" aria-label={`Loan-to-value ${pct(ltv * 100)}; opening limit ${pct(openLtv * 100, 0)}; liquidation at ${pct(lltv * 100, 1)}`}>
      <div className="ltv-track">
        <span className="ltv-fill" style={{ width: w(ltv) }} />
        {preview !== undefined && <span className="ltv-preview" style={{ left: w(preview) }} />}
        <span className="ltv-mark" style={{ left: w(openLtv) }} />
        <span className="ltv-mark liq" style={{ left: w(lltv) }} />
      </div>
      <div className="ltv-labels small">
        <span>Loan-to-value {pct(ltv * 100)}{preview !== undefined ? ` → ${pct(preview * 100)}` : ""}</span>
        <span className="muted">Opening limit {pct(openLtv * 100, 0)}, liquidation at {pct(lltv * 100, 1)}</span>
      </div>
      <style>{`
        .ltv { display: grid; gap: 8px; max-width: 560px; }
        .ltv-track { position: relative; height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--green-soft) 0 ${openLtv * 100}%, var(--gold-soft) ${openLtv * 100}% ${lltv * 100}%, var(--red-soft) ${lltv * 100}%); }
        .ltv-fill { position: absolute; inset: 0 auto 0 0; border-radius: 6px; background: var(--ink); opacity: .85; }
        .ltv-preview { position: absolute; top: -4px; width: 3px; height: 20px; background: var(--ink); border-radius: 2px; }
        .ltv-mark { position: absolute; top: -3px; width: 2px; height: 18px; background: var(--muted); }
        .ltv-mark.liq { background: var(--red); }
        .ltv-labels { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
      `}</style>
    </div>
  );
}
