"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { morphoAbi, tokenAbi, marketParams } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useSteps } from "@/lib/hooks";
import { useMarkets, type MarketState } from "@/lib/lending";
import { useLoans, useWallet, PRODUCT_META, Notice, fmtMoney, Slash } from "@/lib/pm";

const KIND = { index: { label: "Safer", sub: "Lent against the S&P 500 investment" }, basket: { label: "Higher yield", sub: "Lent against the US tech investment" } } as const;

export default function Earn() {
  const { markets } = useLoans();
  const { states, refetch } = useMarkets(markets);
  const { symbol, balance, refetchBalance } = useWallet();
  const [sel, setSel] = useState(0);
  const st = states[Math.min(sel, states.length - 1)];
  const earning = states.reduce((a, s) => a + s.user.supplyAssets, 0);

  return (
    <div className="pm-pad">
      <div className="pm-head">
        <h1 className="pm-h1">Earn</h1>
        <p className="pm-lede">Lend your money to people borrowing against their investments, and earn interest. The rate moves with how much is borrowed.</p>
      </div>
      <div className="pm-stats" style={{ maxWidth: 420 }}>
        <div className="pm-stat"><span>You&rsquo;re earning on</span><strong className="num">{fmtMoney(earning, symbol, 2)}</strong></div>
        <div className="pm-stat"><span>Test money</span><strong className="num">{fmtMoney(balance, symbol)}</strong></div>
      </div>

      <div className="pm-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        {states.map((s, i) => {
          const v = deployment.vaults.find((x) => x.address === s.m.collateralToken);
          const k = KIND[v?.strategy ?? "index"];
          return (
            <button key={s.m.id} onClick={() => setSel(i)} aria-pressed={i === sel} className="pm-panel" style={{ textAlign: "left", cursor: "pointer", borderColor: i === sel ? "var(--pm-ink)" : undefined, borderWidth: i === sel ? 2 : 1 }}>
              <div className="pm-row pm-spread"><strong style={{ fontSize: 18 }}>{k.label}</strong><strong className="pm-pos num" style={{ fontSize: 22 }}>{(s.supplyApr * 100).toFixed(1)}%<span className="pm-small pm-muted" style={{ fontWeight: 400 }}> a year</span></strong></div>
              <span className="pm-muted pm-small">{k.sub}</span>
              <span className="pm-small pm-muted">{(s.utilisation * 100).toFixed(0)}% of {fmtMoney(s.supplyAssets, symbol)} is currently lent out</span>
              <span className="pm-small">Your balance: <strong className="num">{fmtMoney(s.user.supplyAssets, symbol, 2)}</strong></span>
            </button>
          );
        })}
      </div>

      {st && <Panel st={st} onDone={() => { refetch(); refetchBalance(); }} />}

      <p className="pm-small pm-muted" style={{ maxWidth: "80ch" }}>
        Your earnings come from borrower interest. You can withdraw any time up to what is currently available, and if lots of
        people are borrowing you may have to wait. In an extreme market fall, lenders can lose money.
      </p>
    </div>
  );
}

function Panel({ st, onDone }: { st: MarketState; onDone: () => void }) {
  const { address } = useAccount();
  const { symbol, balance } = useWallet();
  const steps = useSteps();
  const [mode, setMode] = useState<"supply" | "withdraw">("supply");
  const [amt, setAmt] = useState("");
  const mp = marketParams(st.m);
  const v = (() => { try { return amt ? parseUnits(amt, 6) : 0n; } catch { return 0n; } })();
  const { data: allowance } = useReadContract({ address: st.m.loanToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.morpho], query: { enabled: !!address } });
  const available = st.supplyAssets - st.borrowAssets;
  const max = mode === "supply" ? balance : Math.min(st.user.supplyAssets, available);
  const over = Number(amt || 0) > max + 1e-6;

  async function go() {
    if (!address) return;
    const ok = await steps.run(
      mode === "supply"
        ? [
            { label: "Approving", address: st.m.loanToken, abi: tokenAbi, functionName: "approve", args: [deployment.morpho, v], skip: ((allowance as bigint | undefined) ?? 0n) >= v },
            { label: "Lending", address: deployment.morpho, abi: morphoAbi, functionName: "supply", args: [mp, v, 0n, address, "0x"] },
          ]
        : [{ label: "Withdrawing", address: deployment.morpho, abi: morphoAbi, functionName: "withdraw", args: [mp, v, 0n, address, address] }],
      mode === "supply" ? "Done. Your money is now earning interest." : "Done. The money is back in your balance.",
    );
    if (ok) { setAmt(""); onDone(); }
  }

  return (
    <div className="pm-panel" style={{ maxWidth: 520 }}>
      <h2 style={{ fontSize: 18 }}><Slash /> {mode === "supply" ? "Lend" : "Withdraw"}</h2>
      <div className="pm-seg" role="group" aria-label="Lend or withdraw">
        <button aria-pressed={mode === "supply"} onClick={() => setMode("supply")}>Lend</button>
        <button aria-pressed={mode === "withdraw"} onClick={() => setMode("withdraw")}>Withdraw</button>
      </div>
      <div className="pm-field">
        <label htmlFor="earn-amt">Amount</label>
        <div className="pm-input"><input id="earn-amt" inputMode="decimal" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} /><span>{symbol}</span></div>
        <div className="pm-row pm-spread pm-small pm-muted">
          <span>{mode === "supply" ? `You have ${fmtMoney(balance, symbol, 2)}` : `Available to withdraw ${fmtMoney(max, symbol, 2)}`}</span>
          <button className="pm-link" onClick={() => setAmt((Math.floor(max * 100) / 100).toString())}>Use max</button>
        </div>
      </div>
      <button className="pm-btn wide" disabled={!address || steps.running || v === 0n || over} onClick={go}>
        {steps.running ? `${steps.label}…` : over ? "More than available" : mode === "supply" ? "Lend" : "Withdraw"}
      </button>
      {steps.error && <Notice tone="red">{steps.error}</Notice>}
      {steps.done && <Notice tone="ok">{steps.done}</Notice>}
      <span className="pm-small pm-muted">Product: {PRODUCT_META[deployment.vaults.find((x) => x.address === st.m.collateralToken)?.strategy ?? "index"].name}</span>
    </div>
  );
}
