"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { formatUnits, parseAbiItem, parseUnits, type Address } from "viem";
import { vaultAbi, routerAbi, tokenAbi, exchangeAbi, CURRENCIES } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useBalances, useEquityPrices, useFx, useMarketOpen, useNavHistory, useSteps, useVaultStats } from "@/lib/hooks";
import { money, num, pct, signedMoney } from "@/lib/format";
import { NavChart } from "@/components/NavChart";
import { PendingRequests } from "@/components/PendingRequests";

export default function VaultPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: vaultAddr } = use(params);
  const info = deployment.vaults.find((v) => v.address.toLowerCase() === vaultAddr.toLowerCase());
  if (!info) return <div className="page"><p className="notice error">That vault does not exist on this network.</p></div>;
  return <Vault vault={info.address} />;
}

function Vault({ vault }: { vault: Address }) {
  const info = deployment.vaults.find((v) => v.address === vault)!;
  const cur = CURRENCIES.find((c) => c.code === info.currency)!;
  const s = cur.symbol;
  const { stats, refetch } = useVaultStats([info]);
  const st = stats[0];
  const points = useNavHistory(vault);
  const prices = useEquityPrices();
  const fx = useFx()[info.currency];
  const { open } = useMarketOpen();

  const { data: eqData } = useReadContracts({
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "equities" },
      { address: vault, abi: vaultAbi, functionName: "weights" },
    ],
  });
  const equities = (eqData?.[0]?.result as Address[] | undefined) ?? [];
  const weights = (eqData?.[1]?.result as number[] | undefined) ?? [];
  const { data: heldRaw } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: equities.map((e): any => ({ address: vault, abi: vaultAbi, functionName: "held", args: [e] })),
  });
  const heldData = heldRaw as { result?: unknown }[] | undefined;
  const { data: notional } = useReadContract({
    address: deployment.hedgeBook,
    abi: [parseAbiItem("function notionalOf(address) view returns (uint256)")],
    functionName: "notionalOf",
    args: [vault],
  });

  const hedgeRatio = st && st.equityValue > 0 && fx ? (Number(notional ?? 0n) / 1e18 / fx.usdPerLocal / st.equityValue) * 100 : 0;
  const first = points[0];
  const sinceLaunch = first && st ? ((st.navPerShare - first.navPerShare) / first.navPerShare) * 100 : undefined;

  return (
    <div className="page">
      <div className="page-head">
        <Link href="/vaults" className="small muted">
          All {info.currency} vaults
        </Link>
        <div className="row">
          <h1 style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)" }}>{info.name}</h1>
          {info.hedged ? <span className="tag">Hedged</span> : <span className="tag gold">Unhedged</span>}
        </div>
        <p className="muted">
          {info.strategy === "index" ? "Tracks the S&P 500 through one holding." : "Five US tech stocks at 20% each, rebalanced when any drifts 5 points."}{" "}
          {info.hedged
            ? `Moves in ${info.currency} against the US dollar are offset by a currency hedge.`
            : `Moves in ${info.currency} against the US dollar flow through to your returns.`}
        </p>
      </div>

      <div className="two-col">
        <div className="stack" style={{ gap: 24 }}>
          <div className="row" style={{ gap: 40 }}>
            <div>
              <div className="small muted">Share price</div>
              <div className="big">{st ? money(st.navPerShare, s, 4) : "…"}</div>
            </div>
            <div>
              <div className="small muted">Since launch</div>
              <div className="big" style={{ fontSize: "1.6rem" }}>
                <span className={sinceLaunch === undefined ? "" : sinceLaunch >= 0 ? "pos" : "neg"}>
                  {sinceLaunch === undefined ? "—" : pct(sinceLaunch, 2, true)}
                </span>
              </div>
            </div>
            <div>
              <div className="small muted">Vault size</div>
              <div className="big" style={{ fontSize: "1.6rem" }}>{st ? money(st.nav, s, 0) : "…"}</div>
            </div>
          </div>

          <NavChart points={points} symbol={s} tone={info.hedged ? "ink" : "gold"} />

          <section className="stack">
            <h2>What the vault holds</h2>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Holding</th>
                    <th className="num">Target</th>
                    <th className="num">Price (US$)</th>
                    <th className="num">Value ({info.currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {equities.map((e, i) => {
                    const tok = deployment.tokens.find((t) => t.address === e);
                    const p = prices.find((x) => x.name === tok?.symbol.slice(1));
                    const qty = num(heldData?.[i]?.result as bigint | undefined, 18);
                    const local = p?.usd && fx ? (qty * p.usd) / fx.usdPerLocal : 0;
                    return (
                      <tr key={e}>
                        <td>
                          {tok?.name.replace(" (testnet)", "")}
                          {p?.overridden && <span className="tag red" style={{ marginLeft: 8 }}>Shocked</span>}
                        </td>
                        <td className="num">{pct((weights[i] ?? 0) / 100, 0)}</td>
                        <td className="num">{p?.usd ? p.usd.toFixed(2) : "…"}</td>
                        <td className="num">{money(local, s, 0)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td>Cash buffer ({info.currency})</td>
                    <td className="num">3%</td>
                    <td className="num" />
                    <td className="num">{st ? money(st.cash, s, 0) : "…"}</td>
                  </tr>
                  {info.hedged && (
                    <tr>
                      <td>Currency hedge, unrealised</td>
                      <td className="num" />
                      <td className="num" />
                      <td className={`num ${st && st.hedgeMtm >= 0 ? "pos" : "neg"}`}>{st ? signedMoney(st.hedgeMtm, s, 0) : "…"}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {info.hedged && (
            <section className="panel quiet stack small">
              <h3>The hedge</h3>
              <dl className="kv">
                <dt>Size (short US$)</dt>
                <dd>US${(Number(notional ?? 0n) / 1e18).toLocaleString("en-AU", { maximumFractionDigits: 0 })}</dd>
                <dt>Share of equities hedged</dt>
                <dd>{pct(hedgeRatio, 1)}</dd>
                <dt>{info.currency}/USD now</dt>
                <dd>{fx ? fx.usdPerLocal.toFixed(info.currency === "INR" ? 6 : 4) : "…"}</dd>
              </dl>
              <p className="muted">
                Simulated onchain against live FX with an illustrative carry. The keeper resizes it when it drifts more
                than 3% from the equities. In production this would be an FX forward with an institutional counterparty.
              </p>
            </section>
          )}
        </div>

        <Trade vault={vault} open={open} onDone={refetch} navPerShare={st?.navPerShare} />
      </div>
    </div>
  );
}

function Trade({ vault, open, onDone, navPerShare }: { vault: Address; open?: boolean; onDone: () => void; navPerShare?: number }) {
  const info = deployment.vaults.find((v) => v.address === vault)!;
  const cur = CURRENCIES.find((c) => c.code === info.currency)!;
  const { address } = useAccount();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const group = deployment.tokens.filter((t) => t.kind === "stable" && t.currency === info.currency);
  const [tokenAddr, setTokenAddr] = useState<Address>(group[0].address);
  const [amount, setAmount] = useState("");
  const { balances, refetch: refetchBal } = useBalances([...group.map((t) => t.address), vault]);
  const steps = useSteps();
  const assetAddr = group.find((t) => t.symbol === cur.stables[0])!.address;

  const tokenBal = balances[group.findIndex((t) => t.address === tokenAddr)] ?? 0n;
  const shareBal = balances[group.length] ?? 0n;
  const parsed = useMemo(() => {
    try {
      return amount ? parseUnits(amount, mode === "deposit" ? 6 : 18) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, mode]);

  const { data: preview } = useReadContract({
    address: vault,
    abi: vaultAbi,
    functionName: mode === "deposit" ? "previewDeposit" : "previewRedeem",
    args: [parsed],
    query: { enabled: parsed > 0n },
  });

  const allowanceTarget = open ? deployment.router : vault;
  const { data: allowance } = useReadContract({
    address: mode === "deposit" ? (open ? tokenAddr : assetAddr) : vault,
    abi: tokenAbi,
    functionName: "allowance",
    args: [address!, mode === "deposit" ? allowanceTarget : deployment.router],
    query: { enabled: !!address },
  });

  const minOut = preview ? ((preview as bigint) * 995n) / 1000n : 0n;
  const tooMuch = parsed > (mode === "deposit" ? tokenBal : shareBal);

  async function submit() {
    if (!address) return;
    let ok = false;
    if (mode === "deposit" && open) {
      ok = await steps.run(
        [
          { label: "Approving", address: tokenAddr, abi: tokenAbi, functionName: "approve", args: [deployment.router, parsed], skip: (allowance as bigint | undefined ?? 0n) >= parsed },
          { label: "Depositing", address: deployment.router, abi: routerAbi, functionName: "depositWith", args: [vault, tokenAddr, parsed, minOut] },
        ],
        "Deposited. Your shares are in your portfolio.",
      );
    } else if (mode === "deposit") {
      ok = await steps.run(
        [
          { label: `Converting to ${cur.stables[0]}`, address: deployment.exchange, abi: exchangeAbi, functionName: "swapStable", args: [tokenAddr, assetAddr, parsed, address], skip: tokenAddr === assetAddr },
          { label: "Approving", address: assetAddr, abi: tokenAbi, functionName: "approve", args: [vault, parsed], skip: (allowance as bigint | undefined ?? 0n) >= parsed },
          { label: "Queuing deposit", address: vault, abi: vaultAbi, functionName: "requestDeposit", args: [parsed, address, minOut] },
        ],
        "Deposit queued. It executes at the next US market open.",
      );
    } else if (open) {
      ok = await steps.run(
        [
          { label: "Approving shares", address: vault, abi: tokenAbi, functionName: "approve", args: [deployment.router, parsed], skip: (allowance as bigint | undefined ?? 0n) >= parsed },
          { label: "Withdrawing", address: deployment.router, abi: routerAbi, functionName: "redeemTo", args: [vault, parsed, tokenAddr, minOut] },
        ],
        "Withdrawn to your wallet.",
      );
    } else {
      ok = await steps.run(
        [{ label: "Queuing withdrawal", address: vault, abi: vaultAbi, functionName: "requestRedeem", args: [parsed, address, minOut] }],
        `Withdrawal queued. It pays out in ${cur.stables[0]} at the next US market open.`,
      );
    }
    if (ok) {
      setAmount("");
      refetchBal();
      onDone();
    }
  }

  const sharesOut = mode === "deposit" && preview ? Number(preview as bigint) / 1e18 : 0;
  const assetsOut = mode === "withdraw" && preview ? Number(preview as bigint) / 1e6 : 0;
  const gross = mode === "deposit" ? Number(parsed) / 1e6 : (Number(parsed) / 1e18) * (navPerShare ?? 0);
  const cost = mode === "deposit" ? gross - sharesOut * (navPerShare ?? 0) : gross - assetsOut;

  return (
    <aside className="panel stack" style={{ position: "sticky", top: 88 }}>
      <div className="seg" role="group" aria-label="Deposit or withdraw" style={{ width: "100%" }}>
        {(["deposit", "withdraw"] as const).map((m) => (
          <button key={m} style={{ flex: 1 }} aria-pressed={mode === m} onClick={() => { setMode(m); setAmount(""); steps.reset(); }}>
            {m === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>

      {open === false && (
        <p className="notice">
          US markets are closed. {mode === "deposit" ? "Your deposit" : "Your withdrawal"} will be queued and executed
          at the next open price. You can cancel it here or from your portfolio until then.
        </p>
      )}

      <div className="field">
        <label htmlFor="amt">{mode === "deposit" ? "Amount" : "Shares to withdraw"}</label>
        <div className="amount">
          <input id="amt" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          {mode === "deposit" ? (
            <select aria-label="Pay with" value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value as Address)}>
              {group.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
            </select>
          ) : (
            <span className="unit">shares</span>
          )}
        </div>
        <div className="row spread hint">
          <span>
            Balance:{" "}
            {mode === "deposit"
              ? `${num(tokenBal, 6).toLocaleString("en-AU")} ${group.find((t) => t.address === tokenAddr)?.symbol}`
              : `${num(shareBal, 18).toLocaleString("en-AU", { maximumFractionDigits: 4 })} shares`}
          </span>
          <button className="link-btn" onClick={() => setAmount(formatUnits(mode === "deposit" ? tokenBal : shareBal, mode === "deposit" ? 6 : 18))}>
            Use max
          </button>
        </div>
      </div>

      {mode === "withdraw" && (
        <div className="field">
          <label htmlFor="out">Receive</label>
          <select id="out" value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value as Address)} disabled={!open}>
            {group.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
          </select>
        </div>
      )}

      {parsed > 0n && preview !== undefined && (
        <dl className="kv small">
          <dt>{mode === "deposit" ? "You receive" : "You receive"}</dt>
          <dd>
            {mode === "deposit"
              ? `${sharesOut.toLocaleString("en-AU", { maximumFractionDigits: 4 })} shares`
              : money(assetsOut, cur.symbol)}
          </dd>
          <dt>Trading spread</dt>
          <dd>{money(Math.max(0, cost), cur.symbol)}</dd>
          <dt>Price protection</dt>
          <dd>0.5%</dd>
        </dl>
      )}

      <button className="btn" disabled={!address || parsed === 0n || tooMuch || steps.running} onClick={submit}>
        {steps.running
          ? steps.label
          : !address
            ? "Sign in to continue"
            : tooMuch
              ? "Not enough balance"
              : mode === "deposit"
                ? open === false ? "Queue deposit" : "Deposit"
                : open === false ? "Queue withdrawal" : "Withdraw"}
      </button>
      {steps.error && <p className="notice error">{steps.error}</p>}
      {steps.done && <p className="notice ok">{steps.done}</p>}
      <PendingRequests vault={vault} />
    </aside>
  );
}

