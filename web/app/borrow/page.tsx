"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { morphoAbi, routerAbi, tokenAbi, marketParams } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useBalances, useSteps } from "@/lib/hooks";
import { useMarkets } from "@/lib/lending";
import { PRODUCT_META, useLoans, useWallet, useDeviation, safety, lltvOf, openLtvOf, Slash, Notice, fmtMoney, PricesLoading, type Loan } from "@/lib/pm";

const oraclePriceAbi = [{ type: "function", name: "price", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;

export default function Borrow() {
  const { loans, refetch } = useLoans();
  const [selIdx, setSel] = useState(0);
  const loan = loans[Math.min(selIdx, loans.length - 1)];
  const dev = useDeviation();
  const { symbol } = useWallet();
  const total = loans.reduce((a, l) => a + l.borrowed, 0);

  return (
    <div className="pm-pad">
      <div className="pm-head">
        <h1 className="pm-h1">Borrow</h1>
        <p className="pm-lede">Get cash against your investments without selling. Your shares are the security, and the loan is in your own currency.</p>
      </div>
      {dev.level >= 3 && (
        <Notice tone="red">New borrowing is paused while the exchange price is far from the market price. You can still repay.</Notice>
      )}
      {dev.level === 1 || dev.level === 2 ? <Notice>The exchange price is {Math.abs(dev.driftBps) / 100}% off the market price. Borrowing still works, but loans are watched more closely.</Notice> : null}
      {total > 0 && <p className="pm-muted">You currently owe <strong className="num">{fmtMoney(total, symbol, 2)}</strong>.</p>}

      <div className="pm-seg" role="group" aria-label="Investment to borrow against">
        {loans.map((l, i) => (
          <button key={l.market.id} aria-pressed={i === selIdx} onClick={() => setSel(i)}>
            Borrow against {l.strategy ? PRODUCT_META[l.strategy].name : "shares"}
            {l.borrowed > 0 ? " · active" : ""}
          </button>
        ))}
      </div>

      {loan && <Desk loan={loan} paused={dev.level >= 3} onDone={refetch} />}

      <p className="pm-small pm-muted" style={{ maxWidth: "80ch" }}>
        Interest is variable and rises with how much is borrowed. If your shares fall too far, some are sold to repay part of
        the loan. Limits are illustrative and pending proper risk review. Lending runs on Morpho Blue test contracts.
      </p>
    </div>
  );
}

function Desk({ loan, paused, onDone }: { loan: Loan; paused: boolean; onDone: () => void }) {
  const { address } = useAccount();
  const { symbol } = useWallet();
  const m = loan.market;
  const mp = marketParams(m);
  const lltv = lltvOf(m);
  const openLtv = openLtvOf(m);
  const { states } = useMarkets([m]);
  const st = states[0];
  const { balances, refetch: refetchBal } = useBalances([m.collateralToken]);
  const walletShares = balances[0] ?? 0n;
  const steps = useSteps();
  const [amtStr, setAmt] = useState("");
  const [repayStr, setRepay] = useState("");
  const [wdStr, setWd] = useState("");

  const { data: price } = useReadContract({ address: m.oracle, abi: oraclePriceAbi, functionName: "price", query: { refetchInterval: 8000 } });
  const { data: allowColl } = useReadContract({ address: m.collateralToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address } });
  const { data: allowLoan } = useReadContract({ address: m.loanToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address } });

  // Value of one whole share in loan currency (Morpho oracle scale 1e36, shares 18dp, loan 6dp).
  const unit = price ? (Number(price) / 1e36) * 10 ** 12 : 0;
  const posted = (Number(loan.collateralShares) / 1e18) * unit;
  const spare = (Number(walletShares) / 1e18) * unit;
  const maxNew = Math.max(0, (posted + spare) * openLtv - loan.borrowed) * 0.995;
  const amt = Number(amtStr || 0);
  const newDebt = loan.borrowed + amt;
  const needColl = newDebt / openLtv;
  const extraValue = Math.max(0, needColl - posted);
  const extraShares = unit > 0 ? BigInt(Math.ceil((extraValue / unit) * 1e18 * 1.002)) : 0n;
  const collPost = extraShares > walletShares ? walletShares : extraShares;
  const newLtv = posted + Number(collPost) / 1e18 * unit > 0 ? newDebt / (posted + (Number(collPost) / 1e18) * unit) : 0;
  const dropToLiq = newLtv > 0 ? 1 - newLtv / lltv : 1;
  const sf = safety(loan.ltv, lltv);
  const previewSf = safety(newLtv, lltv);
  const apr = st?.borrowApr ?? 0;
  const available = st ? st.supplyAssets - st.borrowAssets : 0;
  const parse = (v: string, d: number) => { try { return v ? parseUnits(v, d) : 0n; } catch { return 0n; } };

  async function borrow() {
    const borrowAmt = parse(amtStr, 6);
    const ok = await steps.run(
      [
        { label: "Allowing Parallel to manage your loan", address: deployment.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [deployment.router, true], skip: loan.authorized },
        { label: "Approving your shares", address: m.collateralToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, collPost], skip: collPost === 0n || ((allowColl as bigint | undefined) ?? 0n) >= collPost },
        { label: "Borrowing", address: deployment.router, abi: routerAbi, functionName: "supplyCollateralAndBorrow", args: [mp, collPost, borrowAmt] },
      ],
      `Borrowed ${fmtMoney(amt, symbol, 2)}.`,
    );
    if (ok) { setAmt(""); refetchBal(); onDone(); }
  }

  async function repay(all: boolean) {
    const repayAmt = parse(repayStr, 6);
    const wd = parse(wdStr, 18);
    const need = all ? BigInt(Math.ceil(loan.borrowed * 1.001 * 1e6)) + 1_000n : repayAmt;
    const ok = await steps.run(
      [
        { label: "Allowing Parallel to manage your loan", address: deployment.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [deployment.router, true], skip: loan.authorized },
        { label: "Approving repayment", address: m.loanToken, abi: tokenAbi, functionName: "approve", args: [deployment.router, need], skip: need === 0n || ((allowLoan as bigint | undefined) ?? 0n) >= need },
        { label: all ? "Repaying in full" : "Repaying", address: deployment.router, abi: routerAbi, functionName: "repayAndWithdraw", args: [mp, all ? 0n : repayAmt, all, all ? loan.collateralShares : wd] },
      ],
      all ? "Loan repaid in full. Your shares are unlocked." : "Done.",
    );
    if (ok) { setRepay(""); setWd(""); refetchBal(); onDone(); }
  }

  const priceReady = !!price && Number(price) > 0;
  const bad = amt > maxNew || newLtv > openLtv + 1e-9;
  const meterVars = { ["--g" as string]: `${0.8 * lltv * 100}%`, ["--a" as string]: `${0.92 * lltv * 100}%` } as React.CSSProperties;
  const pos = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;

  return (
    <div className="pm-split">
      <div className="pm-panel" aria-busy={!priceReady}>
        {!priceReady && <PricesLoading />}
        <h2 style={{ fontSize: 18 }}>How much do you want to borrow?</h2>
        <div className="pm-amt"><span>{symbol}</span>
          <input aria-label="Amount to borrow" inputMode="decimal" placeholder="0" value={amtStr} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
        <input className="pm-range" type="range" min={0} max={Math.max(0, Math.floor(maxNew))} step={1} value={Math.min(amt, maxNew)} onChange={(e) => setAmt(e.target.value)} aria-label="Borrow amount slider" disabled={maxNew <= 0} />
        <div className="pm-row pm-spread pm-small pm-muted"><span>{fmtMoney(0, symbol)}</span><span>Up to {fmtMoney(maxNew, symbol)}</span></div>

        <div className="pm-inner">
          <div className="pm-line"><span className="pm-muted">Interest rate</span><strong>{(apr * 100).toFixed(1)}% a year, variable</strong></div>
          <div className="pm-line"><span className="pm-muted">Shares you&rsquo;ll lock as security</span><strong className="num">{collPost > 0n ? fmtMoney((Number(collPost) / 1e18) * unit, symbol) : "None extra"}</strong></div>
          <div className="pm-line"><span className="pm-muted">Available in the lending pool</span><span className="num">{fmtMoney(available, symbol)}</span></div>
        </div>

        <div className="pm-meter">
          <div className="pm-row pm-spread"><strong style={{ fontSize: 13 }}>Loan safety</strong><strong className={previewSf.level === 0 ? "pm-pos" : "pm-neg"}>{amt > 0 ? previewSf.label : sf.label}</strong></div>
          <div className="pm-track" style={meterVars} role="img" aria-label={`Loan safety: ${previewSf.label}`}>
            <span className="pm-fill" style={{ width: pos(amt > 0 ? newLtv : loan.ltv) }} />
            <span className="pm-mark" style={{ left: pos(lltv) }} />
          </div>
          <span className="pm-small pm-muted">Red line: where shares start being sold ({(lltv * 100).toFixed(0)}% of their value borrowed). You can open at up to {(openLtv * 100).toFixed(0)}%.</span>
        </div>

        {amt > 0 && (
          <p className="pm-small pm-muted">
            If your shares fell about {(Math.max(0, dropToLiq) * 100).toFixed(0)}%, some would be sold to repay part of the loan.
          </p>
        )}
        <button className="pm-btn wide" disabled={!address || steps.running || amt <= 0 || bad || paused || amt > available || !priceReady} onClick={borrow}>
          {steps.running ? `${steps.label}…` : !priceReady ? "Waiting for prices" : paused ? "Borrowing paused" : amt > maxNew ? "More than you can borrow" : amt > available ? "Not enough in the pool" : amt > 0 ? `Borrow ${fmtMoney(amt, symbol)}` : "Enter an amount"}
        </button>
        {maxNew <= 0 && loan.borrowed === 0 && (
          <Notice tone="info">You don&rsquo;t own any {loan.strategy ? PRODUCT_META[loan.strategy].name : "shares"} yet. <Link href="/invest" className="pm-link">Invest first</Link>.</Notice>
        )}
        {steps.error && <Notice tone="red">{steps.error}</Notice>}
        {steps.done && <Notice tone="ok">{steps.done}</Notice>}
      </div>

      <div className="pm-panel">
        <h2 style={{ fontSize: 18 }}>Your loan</h2>
        {loan.borrowed === 0 ? (
          <p className="pm-muted">No loan against {loan.strategy ? PRODUCT_META[loan.strategy].name : "these shares"} yet.</p>
        ) : (
          <>
            <div className="pm-stats">
              <div className="pm-stat"><span>Borrowed</span><strong className="num">{fmtMoney(loan.borrowed, symbol, 2)}</strong></div>
              <div className="pm-stat"><span>Security</span><strong className="num">{fmtMoney(posted, symbol)}</strong></div>
              <div className="pm-stat"><span>Safety</span><strong className={sf.level === 0 ? "pm-pos" : "pm-neg"}>{sf.label}</strong></div>
            </div>
            <div className="pm-field">
              <label htmlFor="rep">Repay</label>
              <div className="pm-input"><input id="rep" inputMode="decimal" placeholder="0" value={repayStr} onChange={(e) => setRepay(e.target.value.replace(/[^0-9.]/g, ""))} /><span>{symbol}</span></div>
            </div>
            <div className="pm-field">
              <label htmlFor="wd">Unlock shares (while the loan stays safe)</label>
              <div className="pm-input"><input id="wd" inputMode="decimal" placeholder="0" value={wdStr} onChange={(e) => setWd(e.target.value.replace(/[^0-9.]/g, ""))} /><span>shares</span></div>
              <span className="pm-small pm-muted">Locked: {(Number(loan.collateralShares) / 1e18).toLocaleString("en-AU", { maximumFractionDigits: 4 })} shares</span>
            </div>
            <div className="pm-row">
              <button className="pm-btn" disabled={steps.running || (parse(repayStr, 6) === 0n && parse(wdStr, 18) === 0n)} onClick={() => repay(false)}>Confirm</button>
              <button className="pm-btn sec" disabled={steps.running} onClick={() => repay(true)}>Repay in full</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
