"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { exchangeAbi, hedgeManagerAbi, stringToHexBytes32 } from "./helpers";
import { deployment, KEEPER_URL } from "@/lib/config";
import { useMarketOpen, useSteps } from "@/lib/hooks";
import { useDeviation, Notice, Slash } from "@/lib/pm";

const LEVELS = ["Normal (under 1%)", "Amber warning (1–3%)", "Red warning (3–10%)", "Paused (10% or more)"];

export default function Advanced() {
  const dev = useDeviation();
  const { open } = useMarketOpen();
  const steps = useSteps();
  const { address } = useAccount();
  const { data: adminRole } = useReadContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "DEFAULT_ADMIN_ROLE" });
  const { data: isAdmin } = useReadContract({
    address: deployment.exchange, abi: exchangeAbi, functionName: "hasRole", args: [adminRole as `0x${string}`, address!],
    query: { enabled: !!address && !!adminRole },
  });
  const [drift, setDrift] = useState(0);
  const [keeper, setKeeper] = useState<{ ok?: boolean; status?: Record<string, { lastOk?: string; lastError?: string }> } | null>(null);

  useEffect(() => setDrift(dev.driftBps), [dev.driftBps]);
  useEffect(() => {
    if (!KEEPER_URL) return;
    const load = () => fetch(KEEPER_URL).then((r) => r.json()).then(setKeeper).catch(() => setKeeper({ ok: false }));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const apply = (bps: number) =>
    steps.run(
      [{ label: "Moving the exchange price", address: deployment.exchange, abi: exchangeAbi, functionName: "setDrift", args: [BigInt(bps)] }],
      bps === 0 ? "Exchange price matches the market price again." : `Exchange price is now ${bps / 100}% ${bps < 0 ? "below" : "above"} the market price.`,
    );

  return (
    <div className="pm-pad" style={{ maxWidth: 880 }}>
      <div className="pm-head">
        <h1 className="pm-h1">Advanced</h1>
        <p className="pm-lede">For the stablecoin partner teams: demo controls, the hedge status and the technical tools. None of this is part of the normal user journey.</p>
      </div>

      <section className="pm-panel">
        <h2 style={{ fontSize: 18 }}><Slash /> Exchange price gap (demo)</h2>
        <p className="pm-muted">
          The vault values your shares at the market price. Selling happens on an exchange, whose price can differ. Slide this to
          see the warnings users get when the exchange price is below the market price.
        </p>
        <div className="pm-field">
          <label htmlFor="drift">Exchange price vs market price: {(drift / 100).toFixed(1)}%</label>
          <input id="drift" className="pm-range" type="range" min={-1500} max={500} step={50} value={drift} onChange={(e) => setDrift(Number(e.target.value))} />
        </div>
        <div className="pm-row">
          <button className="pm-btn sm" disabled={steps.running || !isAdmin} onClick={() => apply(drift)}>Apply</button>
          <button className="pm-btn sec sm" disabled={steps.running || !isAdmin} onClick={() => apply(0)}>Reset to 0%</button>
          <span className="pm-small pm-muted">Now: {(dev.driftBps / 100).toFixed(1)}% · {LEVELS[dev.level]}</span>
        </div>
        {address && isAdmin === false && <Notice tone="info">Only the admin account can move the exchange price. Sign in with the admin wallet to use this control.</Notice>}
        {steps.error && <Notice tone="red">{steps.error}</Notice>}
        {steps.done && <Notice tone="ok">{steps.done}</Notice>}
      </section>

      <HedgeStatus />

      <section className="pm-panel">
        <h2 style={{ fontSize: 18 }}><Slash /> System</h2>
        <div className="pm-inner">
          <div className="pm-line"><span className="pm-muted">US market</span><strong>{open === undefined ? "…" : open ? "Open" : "Closed"}</strong></div>
          <div className="pm-line"><span className="pm-muted">Keeper</span><strong>{!KEEPER_URL ? "Not configured" : keeper?.ok ? "Running" : keeper ? "Not reachable" : "…"}</strong></div>
        </div>
        <div className="pm-row">
          <Link href="/admin" className="pm-btn sec sm">Price shocks and market switch</Link>
          <Link href="/simulator" className="pm-btn sec sm">Currency simulator</Link>
        </div>
      </section>
    </div>
  );
}

function HedgeStatus() {
  const mgr = deployment.hedgeManager;
  const rows = (["AUD", "EUR", "INR"] as const).map((c) => ({ c, key: stringToHexBytes32(c) }));
  return (
    <section className="pm-panel">
      <h2 style={{ fontSize: 18 }}><Slash /> Currency protection (hedge)</h2>
      <p className="pm-muted">
        The vaults mark the hedge from live prices, so deposits and sales stay instant. A keeper mirrors the total on an outside
        venue (gTrade on Base). On this test network the venue is a mock.
      </p>
      {!mgr ? (
        <Notice tone="info">This deployment has no hedge mirror.</Notice>
      ) : (
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead><tr><th>Currency</th><th className="r">Target</th><th className="r">On the venue</th><th className="r">Gap</th><th>State</th></tr></thead>
            <tbody>{rows.map((r) => <HedgeRow key={r.c} mgr={mgr} c={r.c} k={r.key} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HedgeRow({ mgr, c, k }: { mgr: `0x${string}`; c: string; k: `0x${string}` }) {
  const { data } = useReadContract({ address: mgr, abi: hedgeManagerAbi, functionName: "status", args: [k], query: { refetchInterval: 8000 } });
  const s = data as { supported: boolean; pending: boolean; targetUsd: bigint; venueNotionalUsd: bigint; driftBps: bigint } | undefined;
  const usd = (v?: bigint) => (v === undefined ? "…" : `US$${(Number(v) / 1e18).toLocaleString("en-AU", { maximumFractionDigits: 0 })}`);
  return (
    <tr>
      <td><strong>{c}</strong></td>
      <td className="r num">{usd(s?.targetUsd)}</td>
      <td className="r num">{s?.supported ? usd(s?.venueNotionalUsd) : "—"}</td>
      <td className="r num">{s?.supported && s ? `${(Number(s.driftBps) / 100).toFixed(1)}%` : "—"}</td>
      <td className="pm-small pm-muted">{!s ? "…" : !s.supported ? "Simulated only (no pair)" : s.pending ? "Order in flight" : Math.abs(Number(s.driftBps)) > 300 ? "Waiting for the keeper to sync" : "In sync"}</td>
    </tr>
  );
}
