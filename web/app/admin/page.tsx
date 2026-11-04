"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { oracleHubAbi, vaultAbi, CURRENCIES } from "@parallel/shared";
import { deployment, KEEPER_URL } from "@/lib/config";
import { useEquityPrices, useFx, useMarketOpen, useSteps, useVaultStats } from "@/lib/hooks";
import { useMarkets } from "@/lib/lending";
import { money, short } from "@/lib/format";

const MODES = ["Real schedule", "Force open", "Force closed"];

export default function Admin() {
  const { address } = useAccount();
  const { open, mode } = useMarketOpen();
  const prices = useEquityPrices();
  const fx = useFx();
  const steps = useSteps();
  const { stats } = useVaultStats(deployment.vaults);
  const { states } = useMarkets(deployment.markets);
  const [keeper, setKeeper] = useState<{ ok?: boolean; status?: Record<string, { lastOk?: string; lastError?: string }> } | null>(null);
  const { data: adminRole } = useReadContract({ address: deployment.oracleHub, abi: oracleHubAbi, functionName: "DEFAULT_ADMIN_ROLE" });
  const { data: isAdmin } = useReadContract({
    address: deployment.oracleHub, abi: oracleHubAbi, functionName: "hasRole", args: [adminRole as `0x${string}`, address!],
    query: { enabled: !!address && !!adminRole },
  });

  useEffect(() => {
    if (!KEEPER_URL) return;
    const load = () => fetch(KEEPER_URL).then((r) => r.json()).then(setKeeper).catch(() => setKeeper({ ok: false }));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const shock = (key: `0x${string}`, bps: number, label: string) =>
    steps.run([{ label, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "shock", args: [key, BigInt(bps), 3600n] }], `${label} applied for one hour.`);
  const clear = (key: `0x${string}`, label: string) =>
    steps.run([{ label, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "clearOverride", args: [key] }], `${label}.`);
  const setMode = (m: number) =>
    steps.run([{ label: `Setting market to ${MODES[m].toLowerCase()}`, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "setMarketMode", args: [m] }], `Market set to ${MODES[m].toLowerCase()}.`);
  const vaultCall = (fn: "rebalance" | "rollHedge" | "processQueue") =>
    steps.run(
      deployment.vaults.map((v) => ({
        label: `${fn} ${v.symbol}`,
        address: v.address,
        abi: vaultAbi,
        functionName: fn,
        args: fn === "processQueue" ? [50n] : [],
        skip: fn === "rollHedge" && !v.hedged,
      })),
      `${fn === "processQueue" ? "Queues settled" : fn === "rollHedge" ? "Hedges rolled" : "Vaults rebalanced"}.`,
    );

  const feeds = [
    ...prices.map((p) => ({ name: p.name, key: p.key, value: p.usd ? `US$${p.usd.toFixed(2)}` : "…", overridden: p.overridden })),
    ...(["AUD", "EUR", "INR"] as const).map((c) => {
      const f = deployment.feeds.find((x) => x.name === c)!;
      const r = fx[c];
      return { name: `${c}/USD`, key: f.key, value: r ? r.usdPerLocal.toFixed(c === "INR" ? 6 : 4) : "…", overridden: r?.overridden ?? false };
    }),
  ];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Demo controls</h1>
        <p className="lede">Stage market events for a live demo. Every change is an onchain transaction visible to all viewers.</p>
        {address && isAdmin === false && (
          <p className="notice">This wallet is not the demo admin ({short(deployment.admin)}), so these buttons will be rejected.</p>
        )}
        {!deployment.demoPyth ? null : (
          <p className="hint">Prices are simulated by the keeper around realistic levels, so the demo works at any hour.</p>
        )}
      </div>

      {steps.running && <p className="notice">{steps.label}…</p>}
      {steps.error && <p className="notice error">{steps.error}</p>}
      {steps.done && !steps.running && <p className="notice ok">{steps.done}</p>}

      <section className="stack">
        <h2>US market</h2>
        <div className="row">
          <span><span className={`status-dot ${open ? "open" : "closed"}`} />{open ? "Open" : "Closed"} ({MODES[mode ?? 0]})</span>
          <div className="seg" role="group" aria-label="Market mode">
            {MODES.map((m, i) => <button key={m} aria-pressed={mode === i} onClick={() => setMode(i)} disabled={steps.running}>{m}</button>)}
          </div>
        </div>
        <p className="hint">Closing the market queues deposits and withdrawals and pauses new borrowing in the app.</p>
      </section>

      <section className="stack">
        <h2>Price shocks</h2>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Feed</th><th className="num">Price</th><th className="num">Shock for one hour</th></tr></thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.key}>
                  <td>{f.name} {f.overridden && <span className="tag red">Shocked</span>}</td>
                  <td className="num">{f.value}</td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                      {[-2000, -1000, 1000].map((b) => (
                        <button key={b} className="btn small secondary" disabled={steps.running} onClick={() => shock(f.key, b, `${f.name} ${b > 0 ? "+" : "−"}${Math.abs(b) / 100}%`)}>
                          {b > 0 ? "+" : "−"}{Math.abs(b) / 100}%
                        </button>
                      ))}
                      {f.overridden && <button className="btn small" disabled={steps.running} onClick={() => clear(f.key, `${f.name} back to live`)}>Reset</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">The keeper liquidates unhealthy loans within about 20 seconds of a shock.</p>
      </section>

      <section className="stack">
        <h2>Vault operations</h2>
        <div className="row">
          <button className="btn secondary" disabled={steps.running} onClick={() => vaultCall("processQueue")}>Settle queued requests</button>
          <button className="btn secondary" disabled={steps.running} onClick={() => vaultCall("rebalance")}>Rebalance all vaults</button>
          <button className="btn secondary" disabled={steps.running} onClick={() => vaultCall("rollHedge")}>Roll all hedges</button>
        </div>
        <p className="hint">The keeper does these automatically. The buttons are for showing each step on demand.</p>
      </section>

      <section className="two-col">
        <div className="stack">
          <h2>Money in the protocol</h2>
          <table className="table">
            <thead><tr><th>Where</th><th className="num">AUD</th><th className="num">EUR</th><th className="num">INR</th></tr></thead>
            <tbody>
              <tr>
                <td>In vaults</td>
                {CURRENCIES.map((c) => (
                  <td key={c.code} className="num">{money(stats.filter((s) => s.info.currency === c.code).reduce((a, s) => a + (s.nav || 0), 0), c.symbol, 0)}</td>
                ))}
              </tr>
              <tr>
                <td>Supplied by lenders</td>
                {CURRENCIES.map((c) => {
                  const loan = deployment.tokens.find((t) => t.symbol === c.stables[0])!.address;
                  return <td key={c.code} className="num">{money(states.filter((s) => s.m.loanToken === loan).reduce((a, s) => a + s.supplyAssets, 0), c.symbol, 0)}</td>;
                })}
              </tr>
            </tbody>
          </table>
          <p className="hint">Vault shares posted as loan collateral are already counted in the vaults, so they are not added again.</p>
        </div>
        <div className="stack">
          <h2>Keeper</h2>
          {!KEEPER_URL ? (
            <p className="muted small">Set NEXT_PUBLIC_KEEPER_URL to show keeper health here.</p>
          ) : !keeper ? (
            <p className="muted small">Checking…</p>
          ) : keeper.ok === false ? (
            <p className="notice error">The keeper isn&rsquo;t responding. Prices and liquidations won&rsquo;t update until it&rsquo;s back.</p>
          ) : (
            <table className="table small">
              <tbody>
                {Object.entries(keeper.status ?? {}).filter(([k]) => !k.startsWith("rebalance:")).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className={`num ${v.lastError && (!v.lastOk || v.lastError > v.lastOk) ? "neg" : ""}`}>
                      {v.lastError && (!v.lastOk || v.lastError > v.lastOk) ? "Error" : v.lastOk ? new Date(v.lastOk).toLocaleTimeString("en-AU") : "Pending"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
