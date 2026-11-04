"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "viem";
import { morphoAbi, tokenAbi, marketParams, CURRENCIES } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useSteps } from "@/lib/hooks";
import { useMarkets, type MarketState } from "@/lib/lending";
import { money, num, pct } from "@/lib/format";

export default function Lend() {
  const { currency } = useCurrency();
  const markets = useMemo(() => {
    const loan = deployment.tokens.find((t) => t.symbol === CURRENCIES.find((c) => c.code === currency)!.stables[0])!;
    return deployment.markets.filter((m) => m.loanToken === loan.address);
  }, [currency]);
  const { states, refetch } = useMarkets(markets);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Lend {currency}</h1>
        <p className="lede">
          Supply {currency} to a market and earn the interest borrowers pay. Each market accepts one kind of collateral,
          so you choose the risk you lend against.
        </p>
      </div>
      <div className="stack" style={{ gap: 20 }}>
        {states.map((s) => <LendRow key={s.m.id} st={s} onDone={refetch} />)}
      </div>
      <p className="hint" style={{ maxWidth: "80ch" }}>
        If collateral loses value faster than it can be liquidated, lenders in that market absorb the loss. Rates follow
        utilisation: 2% when idle, 8% at 80% borrowed, rising steeply above that. All parameters are illustrative.
      </p>
    </div>
  );
}

function LendRow({ st, onDone }: { st: MarketState; onDone: () => void }) {
  const { address } = useAccount();
  const cur = CURRENCIES.find((c) => c.stables[0] === deployment.tokens.find((t) => t.address === st.m.loanToken)?.symbol)!;
  const [amt, setAmt] = useState("");
  const [mode, setMode] = useState<"supply" | "withdraw">("supply");
  const steps = useSteps();
  const { balances, refetch: refetchBal } = useBalances([st.m.loanToken]);
  const { data: allowance } = useReadContract({
    address: st.m.loanToken, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.morpho], query: { enabled: !!address },
  });
  const v = (() => { try { return amt ? parseUnits(amt, 6) : 0n; } catch { return 0n; } })();
  const mp = marketParams(st.m);
  const vault = deployment.vaults.find((x) => x.address === st.m.collateralToken);

  async function go() {
    const ok =
      mode === "supply"
        ? await steps.run(
            [
              { label: "Approving", address: st.m.loanToken, abi: tokenAbi, functionName: "approve", args: [deployment.morpho, v], skip: ((allowance as bigint | undefined) ?? 0n) >= v },
              { label: "Supplying", address: deployment.morpho, abi: morphoAbi, functionName: "supply", args: [mp, v, 0n, address, "0x"] },
            ],
            "Supplied.",
          )
        : await steps.run(
            [{ label: "Withdrawing", address: deployment.morpho, abi: morphoAbi, functionName: "withdraw", args: [mp, v, 0n, address, address] }],
            "Withdrawn.",
          );
    if (ok) { setAmt(""); refetchBal(); onDone(); }
  }

  return (
    <div className="panel lend-row">
      <div className="stack" style={{ gap: 6 }}>
        <h3>Lend against {vault ? `${vault.name.replace("Parallel ", "")} shares` : "mock S&P 500 tokens"}</h3>
        <dl className="kv small" style={{ maxWidth: 420 }}>
          <dt>Supply rate</dt><dd className="pos">{pct(st.supplyApr * 100, 2)} a year</dd>
          <dt>Borrowed</dt><dd>{pct(st.utilisation * 100, 1)} of {money(st.supplyAssets, cur.symbol, 0)}</dd>
          <dt>Liquidation loan-to-value</dt><dd>{pct((Number(BigInt(st.m.lltv)) / 1e18) * 100, 1)}</dd>
          <dt>You supplied</dt><dd>{money(st.user.supplyAssets, cur.symbol)}</dd>
        </dl>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <div className="seg" role="group" aria-label="Supply or withdraw">
          <button aria-pressed={mode === "supply"} onClick={() => setMode("supply")}>Supply</button>
          <button aria-pressed={mode === "withdraw"} onClick={() => setMode("withdraw")}>Withdraw</button>
        </div>
        <div className="amount">
          <input aria-label="Amount" inputMode="decimal" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="unit">{cur.code}</span>
        </div>
        <span className="hint">
          {mode === "supply" ? `Wallet: ${num(balances[0], 6).toLocaleString("en-AU")}` : `Supplied: ${st.user.supplyAssets.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`}
        </span>
        <button className="btn" disabled={!address || v === 0n || steps.running} onClick={go}>
          {steps.running ? steps.label : mode === "supply" ? "Supply" : "Withdraw"}
        </button>
        {steps.error && <p className="notice error">{steps.error}</p>}
        {steps.done && <p className="notice ok">{steps.done}</p>}
      </div>
      <style>{`
        .lend-row { display: grid; grid-template-columns: 1.3fr 1fr; gap: 24px; align-items: start; }
        @media (max-width: 760px) { .lend-row { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
