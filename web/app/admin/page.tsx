"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { oracleHubAbi, vaultAbi, CURRENCIES } from "@equora/shared";
import { deployment, KEEPER_URL } from "@/lib/config";
import { useEquityPrices, useFx, useMarketOpen, useSteps, useVaultStats } from "@/lib/hooks";
import { useMarkets } from "@/lib/lending";
import { money, short } from "@/lib/format";
import { Simulator } from "@/components/Simulator";
import { Mark } from "@/components/Logo";

const MODES = ["Real schedule", "Force open", "Force closed"];

export default function Admin() {
  const { address } = useAccount();
  const { open, mode } = useMarketOpen();
  const prices = useEquityPrices();
  const fx = useFx();
  const steps = useSteps();
  const { stats } = useVaultStats(deployment.vaults);
  const { states } = useMarkets(deployment.markets);
  const [log, setLog] = useState<{ t: string; text: string }[]>([]);
  const note = (text: string) => setLog((l) => [{ t: new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }), text }, ...l].slice(0, 8));
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

  const shock = async (key: `0x${string}`, bps: number, label: string) => {
    if (await steps.run([{ label, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "shock", args: [key, BigInt(bps), 3600n] }], `${label} applied for one hour.`)) note(`${label} for one hour`);
  };
  const clear = async (key: `0x${string}`, label: string) => {
    if (await steps.run([{ label, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "clearOverride", args: [key] }], `${label}.`)) note(label);
  };
  const setMode = async (m: number) => {
    if (await steps.run([{ label: `Setting market to ${MODES[m].toLowerCase()}`, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "setMarketMode", args: [m] }], `Market set to ${MODES[m].toLowerCase()}.`)) note(`US market: ${MODES[m].toLowerCase()}`);
  };
  const resetAll = async () => {
    const shocked = feedsList().filter((f) => f.overridden);
    if (!shocked.length) return;
    const ok = await steps.run(
      shocked.map((f) => ({ label: `${f.name} back to live`, address: deployment.oracleHub, abi: oracleHubAbi, functionName: "clearOverride", args: [f.key] })),
      "All prices back to live.",
    );
    if (ok) note("Demo reset: all prices back to live");
  };
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

  const feedsList = () => [
    ...prices.map((p) => ({ name: p.name, key: p.key, value: p.usd ? `US$${p.usd.toFixed(2)}` : "…", overridden: p.overridden })),
    ...(["AUD", "EUR", "INR"] as const).map((c) => {
      const f = deployment.feeds.find((x) => x.name === c)!;
      const r = fx[c];
      return { name: `${c}/USD`, key: f.key, value: r ? r.usdPerLocal.toFixed(c === "INR" ? 6 : 4) : "…", overridden: r?.overridden ?? false };
    }),
  ];

  const feeds = feedsList();
  const runVault = async (fn: "rebalance" | "rollHedge" | "processQueue") => {
    if (await vaultCall(fn)) note(fn === "processQueue" ? "Settled queued requests" : fn === "rollHedge" ? "Rolled all hedges" : "Rebalanced all vaults");
  };
  const contracts: [string, string][] = [
    ["Oracle hub", deployment.oracleHub],
    ["Exchange", deployment.exchange],
    ["Hedge book", deployment.hedgeBook],
    ["Router", deployment.router],
    ["Lending (Morpho Blue)", deployment.morpho],
    ["Faucet", deployment.faucet],
    ...deployment.vaults.slice(0, 4).map((v) => [v.symbol, v.address] as [string, string]),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-top"><div style={{ display: "grid", gap: 4 }}>
        <h1>Advanced</h1>
        <p className="muted">For partner teams reviewing the demo. Everyday users never need this page.</p>
        {address && isAdmin === false && (
          <p className="notice">This wallet isn&rsquo;t the demo admin ({short(deployment.admin)}), so the demo controls will be rejected.</p>
        )}
        </div>
      </div>

      <section aria-labelledby="fx-h" className="pnl" style={{ display: "grid", gap: 14, padding: "16px", marginBottom: 8 }}>
        <h2 id="fx-h" className="section-title"><Mark />Currency explorer</h2>
        <Simulator compact />
      </section>

      <section aria-labelledby="ctl-h" className="pnl" style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ flex: "2 1 460px", minWidth: 0, display: "grid", gap: 18, alignContent: "start", padding: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h2 id="ctl-h" className="section-title"><Mark />Demo controls</h2>
            <span className="tag" style={{ background: "var(--amber-soft)", color: "#6b3d12" }}>Admin · affects everyone</span>
          </div>
          {steps.running && <p className="notice">{steps.label}…</p>}
          {steps.error && <p className="notice error">{steps.error}</p>}

          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-m)", background: "var(--surface)", overflow: "hidden" }}>
            <div className="small" style={{ padding: "12px 16px 4px", fontWeight: 700, color: "var(--muted)" }}>Shock share prices and currency rates (for one hour)</div>
            {feeds.map((f, i) => (
              <div key={f.key} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, minHeight: 56, padding: "0 16px", borderTop: i ? "1px solid var(--line-2)" : undefined }}>
                <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 140 }}>
                  <strong>{f.name === "SPY" ? "S&P 500" : f.name}{f.overridden && <span className="tag red" style={{ marginLeft: 8 }}>Shocked</span>}</strong>
                  <span className="small muted" style={{ fontFeatureSettings: '"tnum" 1' }}>{f.value}</span>
                </span>
                <span style={{ display: "flex", gap: 6 }}>
                  {[-2000, -1000, 1000].map((b) => (
                    <button key={b} className="btn ghost small" style={{ minWidth: 56, color: b < 0 ? "var(--red)" : "var(--accent-text)" }} disabled={steps.running} onClick={() => shock(f.key, b, `${f.name === "SPY" ? "S&P 500" : f.name} ${b > 0 ? "+" : "−"}${Math.abs(b) / 100}%`)}>
                      {b > 0 ? "+" : "−"}{Math.abs(b) / 100}%
                    </button>
                  ))}
                  {f.overridden && <button className="btn small" disabled={steps.running} onClick={() => clear(f.key, `${f.name} back to live`)}>Reset</button>}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, minHeight: 60, padding: "0 16px", borderTop: "1px solid var(--line-2)" }}>
              <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 140 }}>
                <strong>US market</strong>
                <span className="small muted">{open === undefined ? "…" : open ? "Open" : "Closed"} ({MODES[mode ?? 0].toLowerCase()})</span>
              </span>
              <div className="currency-seg" role="group" aria-label="Market mode">
                {MODES.map((label, i) => (
                  <button key={label} aria-pressed={mode === i} onClick={() => setMode(i)} disabled={steps.running} style={{ padding: "0 10px" }}>{label}</button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn ghost small" disabled={steps.running} onClick={() => runVault("processQueue")}>Settle queued requests</button>
              <button className="btn ghost small" disabled={steps.running} onClick={() => runVault("rebalance")}>Rebalance vaults</button>
              <button className="btn ghost small" disabled={steps.running} onClick={() => runVault("rollHedge")}>Roll hedges</button>
            </div>
            <button className="btn ghost small" disabled={steps.running || !feeds.some((f) => f.overridden)} onClick={resetAll}><Mark />Reset demo prices</button>
          </div>
          <p className="small" style={{ color: "var(--faint)" }}>The keeper liquidates unhealthy loans within about 20 seconds of a shock, and does the vault operations automatically.</p>
        </div>

        <div style={{ flex: "1 1 280px", minWidth: 0, display: "grid", gap: 16, alignContent: "start", padding: "16px", borderLeft: "1px solid var(--line)", background: "var(--surface)" }}>
          <div style={{ display: "grid", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Activity</span>
            {log.length === 0 ? (
              <span className="small muted">Changes you make here appear in this list.</span>
            ) : (
              log.map((l, i) => (
                <div key={i} className="small" style={{ display: "flex", gap: 10 }}>
                  <span style={{ flex: "none", width: 44, color: "var(--faint)", fontFeatureSettings: '"tnum" 1' }}>{l.t}</span>
                  <span>{l.text}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ display: "grid", gap: 8, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Keeper</span>
            {!KEEPER_URL ? (
              <span className="small muted">Set NEXT_PUBLIC_KEEPER_URL to show keeper health here.</span>
            ) : !keeper ? (
              <span className="small muted">Checking…</span>
            ) : keeper.ok === false ? (
              <span className="small" style={{ color: "var(--red)" }}>The keeper isn&rsquo;t responding. Prices and liquidations won&rsquo;t update until it&rsquo;s back.</span>
            ) : (
              Object.entries(keeper.status ?? {})
                .filter(([k]) => !k.startsWith("rebalance:"))
                .map(([k, v]) => {
                  const err = v.lastError && (!v.lastOk || v.lastError > v.lastOk);
                  return (
                    <div key={k} className="small" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span className="muted">{k}</span>
                      <span style={{ color: err ? "var(--red)" : undefined }}>{err ? "Error" : v.lastOk ? new Date(v.lastOk).toLocaleTimeString("en-AU") : "Pending"}</span>
                    </div>
                  );
                })
            )}
          </div>
        </div>
      </section>

      <section className="pnl" style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ flex: "2 1 460px", minWidth: 0, display: "grid", gap: 12, alignContent: "start", padding: "16px" }}>
          <h2 className="section-title"><Mark />How this demo works</h2>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, lineHeight: 1.55 }}>
            <li>All tokens are mock tokens on Base Sepolia. There is no real money.</li>
            <li>Investing converts the stablecoin, buys tokenized equity, sizes an FX hedge and mints vault shares. The hedge is a simulation marked against live FX, not a live FX position.</li>
            <li>Loans run on unmodified Morpho Blue against vault shares or mock S&amp;P 500 tokens. At the liquidation limit, the keeper sells part of the collateral to repay part of the loan, with a small bonus.</li>
            <li>Market-hours borrowing limits and the opening loan limit are enforced by this app and router only, not by the lending protocol.</li>
            <li>Rates, limits and costs are illustrative and read from the test contracts.</li>
            <li>Not affiliated with, or endorsed by, any stablecoin issuer.</li>
          </ul>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 8 }}>
            {CURRENCIES.map((c) => (
              <div key={c.code} className="panel" style={{ padding: 14, display: "grid", gap: 4 }}>
                <span className="small muted">{c.code} in vaults · lent</span>
                <strong className="small">
                  {money(stats.filter((s) => s.info.currency === c.code).reduce((a, s) => a + (s.nav || 0), 0), c.symbol, 0)} ·{" "}
                  {money(states.filter((s) => s.m.loanToken === deployment.tokens.find((t) => t.symbol === c.stables[0])!.address).reduce((a, s) => a + s.supplyAssets, 0), c.symbol, 0)}
                </strong>
              </div>
            ))}
          </div>
        </div>
        <div style={{ flex: "1 1 280px", minWidth: 0, display: "grid", gap: 8, alignContent: "start", padding: "16px", borderLeft: "1px solid var(--line)" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Contracts</span>
          {contracts.map(([n, a]) => (
            <div key={a} className="small" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span className="muted">{n}</span>
              <span style={{ color: "var(--faint)", fontFamily: "ui-monospace, Menlo, monospace" }} title={a}>{short(a)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
