"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount, useBalance, useBlock, useReadContract } from "wagmi";
import { CURRENCIES, faucetAbi } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useSteps } from "@/lib/hooks";
import { ConnectButton } from "@/components/ConnectButton";
import { num } from "@/lib/format";

export default function Start() {
  const { address, isConnected } = useAccount();
  const { currency, setCurrency } = useCurrency();
  const stables = deployment.tokens.filter((t) => t.kind === "stable");
  const { balances, refetch } = useBalances(stables.map((t) => t.address));
  const { data: eth } = useBalance({ address });
  const { data: nextClaim } = useReadContract({
    address: deployment.faucet,
    abi: faucetAbi,
    functionName: "nextClaimAt",
    args: [address!],
    query: { enabled: !!address },
  });
  const { data: block } = useBlock({ watch: true });
  const steps = useSteps();
  const [sponsor, setSponsor] = useState<{ busy: boolean; error?: string; ok?: boolean }>({ busy: false });

  // Compare against chain time, not the browser clock.
  const now = block?.timestamp ?? BigInt(Math.floor(Date.now() / 1000));
  const claimed = nextClaim !== undefined && (nextClaim as bigint) > now;
  const hasGas = (eth?.value ?? 0n) > 10n ** 14n;

  async function claim() {
    setSponsor({ busy: true });
    const res = await fetch("/api/onboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    }).catch(() => null);
    if (res?.ok) {
      setSponsor({ busy: false, ok: true });
      refetch();
      return;
    }
    // Sponsorship unavailable: claim directly (needs a little test ETH for gas).
    if (res && res.status !== 501) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setSponsor({ busy: false, error: body.error ?? "Could not send test funds." });
      return;
    }
    setSponsor({ busy: false });
    const ok = await steps.run(
      [{ label: "Claiming test funds", address: deployment.faucet, abi: faucetAbi, functionName: "claim" }],
      "Test funds added to your wallet.",
    );
    if (ok) refetch();
  }

  const mine = stables.filter((t) => t.currency === currency);

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <h1>Get started</h1>
        <p className="lede">Three steps, about a minute. Everything here uses test tokens with no real value.</p>
      </div>

      <ol className="steps">
        <li>
          <h3>Sign in</h3>
          <p className="muted">Use email, a passkey or an existing wallet.</p>
          <div>{isConnected ? <span className="tag green">Signed in</span> : <ConnectButton />}</div>
        </li>

        <li>
          <h3>Choose your home currency</h3>
          <p className="muted">Every balance and result is shown in this currency. You can change it any time.</p>
          <div className="seg" role="group" aria-label="Home currency">
            {CURRENCIES.map((c) => (
              <button key={c.code} aria-pressed={currency === c.code} onClick={() => setCurrency(c.code)}>
                {c.flag} {c.code}
              </button>
            ))}
          </div>
        </li>

        <li>
          <h3>Add test funds</h3>
          <p className="muted">
            You get mock stablecoins in every supported currency, plus a little mock S&amp;P 500 for the borrowing demo.
          </p>
          <div className="row">
            <button className="btn" disabled={!isConnected || claimed || sponsor.busy || steps.running} onClick={claim}>
              {sponsor.busy || steps.running ? "Adding test funds" : claimed ? "Test funds added today" : "Add test funds"}
            </button>
            {!hasGas && isConnected && (
              <span className="hint">If gas sponsorship is off, you need a little Base Sepolia ETH from a public faucet.</span>
            )}
          </div>
          {sponsor.error && <p className="notice error">{sponsor.error}</p>}
          {steps.error && <p className="notice error">{steps.error}</p>}
          {(sponsor.ok || steps.done) && <p className="notice ok">Test funds added to your wallet.</p>}
          {isConnected && (
            <table className="table small" style={{ maxWidth: 360 }}>
              <tbody>
                {mine.map((t) => (
                  <tr key={t.address}>
                    <td>{t.symbol}</td>
                    <td className="num">{num(balances[stables.indexOf(t)], t.decimals).toLocaleString("en-AU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </li>
      </ol>

      <div className="row">
        <Link href="/vaults" className="btn">
          Choose a vault
        </Link>
        <Link href="/simulator" className="btn secondary">
          Try the simulator first
        </Link>
      </div>

      <style>{`
        .steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 0; counter-reset: s; }
        .steps li { counter-increment: s; display: grid; gap: 8px; padding: 20px 0 20px 52px; border-top: 1px solid var(--line); position: relative; }
        .steps li::before { content: counter(s); position: absolute; left: 0; top: 18px; width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid var(--ink); display: grid; place-items: center; font-weight: 750; }
      `}</style>
    </div>
  );
}
