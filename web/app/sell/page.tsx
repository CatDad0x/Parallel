"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits, type Address } from "viem";
import { vaultAbi, routerAbi, tokenAbi, CURRENCIES } from "@equora/shared";
import { deployment } from "@/lib/config";
import { useBalances, useMarketOpen, useSteps, useVaultStats } from "@/lib/hooks";
import { usePositions, productName, productOf, protectionLabel } from "@/lib/positions";
import { money, num, pct } from "@/lib/format";
import { Mark } from "@/components/Logo";

export default function SellPage() {
  return (
    <Suspense fallback={null}>
      <Sell />
    </Suspense>
  );
}

function Sell() {
  const params = useSearchParams();
  const { address } = useAccount();
  const pos = usePositions();
  const { open } = useMarketOpen();
  const fromParam = deployment.vaults.find((v) => v.address.toLowerCase() === params.get("v")?.toLowerCase());
  const [vaultAddr, setVaultAddr] = useState<Address | undefined>(fromParam?.address);
  const vault = deployment.vaults.find((v) => v.address === vaultAddr) ?? pos.rows[0]?.s.info ?? fromParam;
  const cur = CURRENCIES.find((c) => c.code === (vault?.currency ?? "AUD"))!;
  const sym = cur.symbol;
  const group = deployment.tokens.filter((t) => t.kind === "stable" && t.currency === cur.code);
  const payout = group.find((t) => t.symbol === cur.stables[0])!;

  const { stats, refetch } = useVaultStats(vault ? [vault] : []);
  const st = stats[0];
  const { balances, refetch: refetchBal } = useBalances(vault ? [vault.address] : []);
  const walletShares = balances[0] ?? 0n;
  const nav = st?.navPerShare ?? 0;
  const holdValue = (Number(walletShares) / 1e18) * nav;
  const row = pos.rows.find((r) => r.s.info.address === vault?.address);
  const locked = row ? row.collateralShares : 0n;

  const [input, setInput] = useState("1000");
  const amt = Math.min(Number(input.replace(/[^0-9.]/g, "")) || 0, holdValue);
  const shares = useMemo(() => {
    if (!nav || amt <= 0) return 0n;
    if (amt >= holdValue * 0.9999) return walletShares;
    try { return parseUnits((amt / nav).toFixed(18), 18); } catch { return 0n; }
  }, [amt, nav, holdValue, walletShares]);

  const { data: preview } = useReadContract({ address: vault?.address, abi: vaultAbi, functionName: "previewRedeem", args: [shares], query: { enabled: !!vault && shares > 0n } });
  const { data: allowance } = useReadContract({ address: vault?.address, abi: tokenAbi, functionName: "allowance", args: [address!, deployment.router], query: { enabled: !!address && !!vault } });

  const got = preview !== undefined ? Number(preview as bigint) / 1e6 : 0;
  const gap = amt > 0 && got > 0 ? Math.max(0, 1 - got / amt) : 0;
  const tier = gap < 0.01 ? 0 : gap <= 0.03 ? 1 : 2;
  const [accepted, setAccepted] = useState(false);
  const steps = useSteps();
  const [done, setDone] = useState<"sold" | "queued" | null>(null);
  const blocked = !address || !vault || shares === 0n || preview === undefined || steps.running || (tier === 2 && !accepted);

  async function sell() {
    if (!vault || !address || preview === undefined) return;
    const minOut = ((preview as bigint) * 995n) / 1000n;
    const ok = await steps.run(
      [
        { label: "Approving", address: vault.address, abi: tokenAbi, functionName: "approve", args: [deployment.router, shares], skip: ((allowance as bigint | undefined) ?? 0n) >= shares },
        { label: "Selling", address: deployment.router, abi: routerAbi, functionName: "redeemTo", args: [vault.address, shares, payout.address, minOut] },
      ],
      "Sold.",
    );
    if (ok) { setDone("sold"); refetch(); refetchBal(); }
  }

  async function wait() {
    if (!vault || !address || preview === undefined) return;
    const minOut = ((preview as bigint) * 995n) / 1000n;
    const ok = await steps.run(
      [{ label: "Queuing your sale", address: vault.address, abi: vaultAbi, functionName: "requestRedeem", args: [shares, address, minOut] }],
      "Queued.",
    );
    if (ok) { setDone("queued"); refetchBal(); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-top"><div style={{ display: "grid", gap: 4 }}>
        <Link href="/portfolio" className="back">← Portfolio</Link>
        <h1>Sell</h1>
        <p className="muted">Turn your investment back into {cur.code === "AUD" ? "Australian dollars" : cur.code === "EUR" ? "euros" : "rupees"}.</p>
      </div></div>

      <div className="split">
        <div className="main">
          <section aria-labelledby="pick-h" style={{ display: "grid", gap: 12, padding: "16px 18px" }}>
            <h2 id="pick-h" className="section-title" style={{ fontSize: 14 }}><Mark />What to sell</h2>
            {pos.rows.length === 0 ? (
              <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span className="muted small">You don&rsquo;t own anything to sell yet.</span>
                <Link href="/invest" className="btn small">Invest</Link>
              </div>
            ) : (
              <div role="radiogroup" aria-labelledby="pick-h" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-m)", background: "var(--surface)", overflow: "hidden" }}>
                {pos.rows.map((r, i) => {
                  const on = r.s.info.address === vault?.address;
                  const isLocked = r.collateralShares > 0n && r.s.userShares === 0n;
                  return (
                    <button
                      key={r.s.info.address}
                      role="radio"
                      aria-checked={on}
                      disabled={isLocked}
                      onClick={() => { setVaultAddr(r.s.info.address); setAccepted(false); steps.reset(); }}
                      style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", minHeight: 68, padding: "0 18px", border: 0, borderTop: i ? "1px solid var(--line-2)" : 0, background: on ? "var(--paper)" : "var(--surface)", boxShadow: on ? "inset 3px 0 0 var(--accent)" : undefined, color: isLocked ? "var(--faint)" : "var(--ink)", font: "inherit", textAlign: "left", cursor: isLocked ? "not-allowed" : "pointer" }}
                    >
                      <span aria-hidden="true" style={{ flex: "none", width: 16, height: 16, boxSizing: "border-box", borderRadius: "50%", border: on ? "5px solid var(--accent)" : isLocked ? "1.5px dashed var(--border)" : "1.5px solid var(--border)" }} />
                      <span style={{ display: "grid", gap: 2, flex: 1 }}>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}><strong>{productName(r.s.info)}</strong><span className="small" style={{ color: "var(--faint)" }}>{r.s.info.symbol}</span></span>
                        <span className="small muted">{isLocked ? "Securing your loan. Repay the loan to sell it." : protectionLabel(r.s.info)}</span>
                      </span>
                      <strong style={{ fontFeatureSettings: '"tnum" 1' }}>{money(r.value, CURRENCIES.find((c) => c.code === r.s.info.currency)!.symbol, 0)}</strong>
                    </button>
                  );
                })}
              </div>
            )}
            {locked > 0n && (
              <span className="small muted">{num(locked, 18).toLocaleString("en-AU", { maximumFractionDigits: 4 })} shares are securing a loan and can&rsquo;t be sold until it&rsquo;s repaid.</span>
            )}
          </section>
          <section style={{ display: "grid", gap: 10, padding: "0 18px 18px" }}>
            <h2 className="section-title" style={{ fontSize: 14 }}><Mark />How the price works</h2>
            <p className="small muted" style={{ lineHeight: 1.6, maxWidth: "60ch" }}>
              You sell at today&rsquo;s price, minus the trading cost. We compare what you get with the full value of your
              shares so you can see the gap. If the gap is wide while US markets are closed, you can choose to wait.
            </p>
          </section>
        </div>

        <aside className="side" aria-label="Sell">
          <span className="section-title" style={{ fontSize: 16 }}><Mark />How much?</span>
          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="sell-amt" className="small muted">You sell</label>
            <div className="amount-box">
              <span className="sym">{sym}</span>
              <input id="sell-amt" inputMode="decimal" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))} />
            </div>
            <div className="chips">
              {[["25%", 0.25], ["50%", 0.5], ["75%", 0.75], ["All", 1]].map(([l, f]) => (
                <button key={l as string} onClick={() => setInput(String(Math.floor(holdValue * (f as number) * 100) / 100))}>{l}</button>
              ))}
            </div>
            <span className="small" style={{ color: "var(--faint)" }}>{money(holdValue, sym)} you can sell</span>
          </div>

          <div className="rows" style={{ padding: "10px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
            <div><span>Full value</span><span>{money(amt, sym)}</span></div>
            <div><span>Gap</span><strong style={{ color: ["var(--muted)", "var(--amber)", "var(--red)"][tier] }}>{amt > 0 && got > 0 ? `−${pct(gap * 100, 1)}` : "—"}</strong></div>
            <div style={{ alignItems: "baseline" }}><span>You get about</span><strong style={{ fontSize: 20 }}>{got > 0 ? money(got, sym) : "—"}</strong></div>
          </div>

          {tier === 1 && (
            <div role="status" className="caution">
              The price is <strong>{pct(gap * 100, 1)} below</strong> the full value. Sell now, or wait until US markets open and get closer to it.
            </div>
          )}
          {tier === 2 && (
            <div role="alert" style={{ display: "grid", gap: 10, padding: "12px 14px", borderRadius: "var(--radius-s)", background: "var(--red-soft)", color: "#7a2a20", fontSize: 13, lineHeight: 1.5 }}>
              <span>The price is <strong>{pct(gap * 100, 1)} below</strong> the full value. Selling now gets you about <strong>{money(amt - got, sym)} less</strong>. Waiting until US markets open is usually better.</span>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontWeight: 600, cursor: "pointer" }}>
                <input type="checkbox" checked={accepted} onChange={() => setAccepted((a) => !a)} style={{ width: 18, height: 18, margin: 0, padding: 0, accentColor: "var(--red)" }} />
                I understand I&rsquo;ll get about {pct(gap * 100, 1)} less
              </label>
            </div>
          )}

          {steps.error && <p role="alert" className="notice error">{steps.error}</p>}
          <button className="btn block" style={tier === 2 && !blocked ? { background: "var(--red)", borderColor: "var(--red)" } : undefined} disabled={blocked} onClick={sell}>
            {steps.running ? `${steps.label}…` : shares === 0n ? "Enter an amount" : `${["Sell for about ", "Sell now for about ", "Sell anyway for about "][tier]}${money(got, sym, 0)}`}
          </button>
          {open === false && (
            <button className="btn ghost block" style={{ minHeight: 48 }} disabled={shares === 0n || steps.running} onClick={wait}>
              <Mark />Wait for US markets to open
            </button>
          )}
          <span className="small" style={{ color: "var(--faint)", lineHeight: 1.5 }}>Prices are read from the test contracts and are illustrative.</span>
        </aside>
      </div>

      {done && vault && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="s-done">
            <span className="section-title" style={{ fontSize: 14, color: "var(--accent-text)" }}><Mark />{done === "queued" ? "Queued" : "Sold"}</span>
            <h2 id="s-done" className="big-line">
              {done === "queued" ? "Your sale will go through when US markets open" : `${money(got, sym, 0)} is now in your balance`}
            </h2>
            <p className="muted">
              {done === "queued" ? "You can cancel it from Portfolio any time before then." : `Your ${productOf(vault)} holding has been updated.`}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Link href="/portfolio" className="btn" style={{ flex: 1 }}>See portfolio</Link>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setDone(null); setAccepted(false); }}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
