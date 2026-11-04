"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnect, useReadContract } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { formatUnits, parseUnits } from "viem";
import { CURRENCIES, exchangeAbi, faucetAbi, routerAbi, tokenAbi, vaultAbi } from "@parallel/shared";
import { deployment, IS_LOCAL, PRIVY_APP_ID } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useBalances, useMarketOpen, useSteps } from "@/lib/hooks";
import { money, num } from "@/lib/format";

const NAMES: Record<string, string> = { AUD: "Australian dollar", EUR: "euro", INR: "rupee" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Strategy = "index" | "basket";
type Setup = "idle" | "running" | "done" | "error";
type Stage = "pick" | "protect" | "amount" | "done";

/** One sign-in button that picks the simplest method available. */
function SignInButton({ label }: { label: string }) {
  return PRIVY_APP_ID ? <PrivySignIn label={label} /> : <WagmiSignIn label={label} />;
}

function PrivySignIn({ label }: { label: string }) {
  const { ready, login } = usePrivy();
  return (
    <button className="btn cta" disabled={!ready} onClick={login}>
      {label}
    </button>
  );
}

function WagmiSignIn({ label }: { label: string }) {
  const { connectors, connect, isPending } = useConnect();
  const pick = IS_LOCAL
    ? connectors.find((c) => c.id === "mock")
    : (connectors.find((c) => c.id === "coinbaseWalletSDK") ?? connectors[0]);
  return (
    <button className="btn cta" disabled={!pick || isPending} onClick={() => pick && connect({ connector: pick })}>
      {isPending ? "Connecting…" : label}
    </button>
  );
}

export default function Try() {
  const { address, isConnected } = useAccount();
  const { currency } = useCurrency();
  const cur = CURRENCIES.find((c) => c.code === currency)!;
  const { open } = useMarketOpen();
  const steps = useSteps();

  const group = deployment.tokens.filter((t) => t.kind === "stable" && t.currency === currency);
  const asset = group.find((t) => t.symbol === cur.stables[0])!;
  const { balances, refetch: refetchBal } = useBalances([asset.address]);
  const balance = balances[0] ?? 0n;

  // Test funds are claimed automatically after sign-in so there is no separate "add funds" step.
  const [setup, setSetup] = useState<Setup>("idle");
  const fundedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isConnected || !address || fundedFor.current === address) return;
    fundedFor.current = address;
    setSetup("running");
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch("/api/onboard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        }).catch(() => null);
        if (res?.ok || res?.status === 429) return "ok";
        if (res?.status === 501) return "direct";
        await sleep(1500);
      }
      return "fail";
    })().then(async (r) => {
      if (r === "direct") {
        const ok = await steps.run(
          [{ label: "Adding test money", address: deployment.faucet, abi: faucetAbi, functionName: "claim" }],
          "",
        );
        setSetup(ok ? "done" : "error");
      } else setSetup(r === "ok" ? "done" : "error");
      refetchBal();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  const [stage, setStage] = useState<Stage>("pick");
  const [strategy, setStrategy] = useState<Strategy>("index");
  const [hedged, setHedged] = useState(true);
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<{ value: number; queued: boolean }>();

  const vault = deployment.vaults.find((v) => v.currency === currency && v.strategy === strategy && v.hedged === hedged);
  const parsed = useMemo(() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  const { data: preview } = useReadContract({
    address: vault?.address,
    abi: vaultAbi,
    functionName: "previewDeposit",
    args: [parsed],
    query: { enabled: !!vault && parsed > 0n },
  });
  const { data: nav } = useReadContract({
    address: vault?.address,
    abi: vaultAbi,
    functionName: "navPerShare",
    query: { enabled: !!vault },
  });
  const { data: allowance } = useReadContract({
    address: asset.address,
    abi: tokenAbi,
    functionName: "allowance",
    args: [address!, open ? deployment.router : vault!.address],
    query: { enabled: !!address && !!vault },
  });

  const have = num(balance, 6);
  const tooMuch = parsed > balance;
  const shares = preview ? (preview as bigint) : 0n;
  const worth = nav ? (Number(shares) / 1e18) * (Number(nav as bigint) / 1e6) : 0;
  const gross = Number(parsed) / 1e6;
  const cost = Math.max(0, gross - worth);
  const minOut = (shares * 995n) / 1000n;

  async function invest() {
    if (!vault || !address) return;
    const enough = ((allowance as bigint | undefined) ?? 0n) >= parsed;
    const ok = open
      ? await steps.run(
          [
            { label: "Approving", address: asset.address, abi: tokenAbi, functionName: "approve", args: [deployment.router, parsed], skip: enough },
            { label: "Investing", address: deployment.router, abi: routerAbi, functionName: "depositWith", args: [vault.address, asset.address, parsed, minOut] },
          ],
          "",
        )
      : await steps.run(
          [
            { label: "Approving", address: asset.address, abi: tokenAbi, functionName: "approve", args: [vault.address, parsed], skip: enough },
            { label: "Placing order", address: vault.address, abi: vaultAbi, functionName: "requestDeposit", args: [parsed, address, minOut] },
          ],
          "",
        );
    if (ok) {
      setResult({ value: worth || gross, queued: !open });
      setStage("done");
      refetchBal();
    }
  }

  const stepNo = stage === "pick" ? 1 : stage === "protect" ? 2 : 3;
  const chips = [100, 500, 1000].filter((v) => v <= have);

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      {!isConnected ? (
        <section className="stack" style={{ gap: 20, paddingTop: 24 }}>
          <h1>Try it with test money.</h1>
          <p className="lede">
            Invest in US shares using {NAMES[currency]}s, in under a minute. Nothing here is real money.
          </p>
          <div>
            <SignInButton label="Start" />
          </div>
        </section>
      ) : setup === "running" || setup === "idle" ? (
        <section className="stack" style={{ gap: 12, paddingTop: 24 }}>
          <h1>Setting up your test account…</h1>
          <p className="lede">{steps.running ? steps.label : "Adding some test money. This takes a few seconds."}</p>
        </section>
      ) : setup === "error" ? (
        <section className="stack" style={{ gap: 12, paddingTop: 24 }}>
          <h1>Couldn&rsquo;t add test money.</h1>
          <p className="notice error">{steps.error ?? "The test-money service didn't respond. Please try again."}</p>
          <div>
            <button
              className="btn"
              onClick={() => {
                fundedFor.current = undefined;
                setSetup("idle");
              }}
            >
              Try again
            </button>
          </div>
        </section>
      ) : stage === "done" ? (
        <section className="stack" style={{ gap: 16, paddingTop: 24 }}>
          <h1>{result?.queued ? "Order placed." : "You’re invested."}</h1>
          <p className="lede">
            {result?.queued
              ? `US markets are closed, so your ${money(gross, cur.symbol, 0)} order goes through at the next opening price.`
              : `You now own about ${money(result?.value ?? 0, cur.symbol)} of ${strategy === "index" ? "the S&P 500" : "US tech stocks"}${hedged ? ", protected from currency swings" : ""}.`}
          </p>
          <div className="row">
            <Link href="/borrow" className="btn">
              Borrow against it
            </Link>
            <Link href="/portfolio" className="btn secondary">
              See my portfolio
            </Link>
            <button
              className="btn secondary"
              onClick={() => {
                setStage("pick");
                setAmount("");
                steps.reset();
              }}
            >
              Invest more
            </button>
          </div>
        </section>
      ) : (
        <section className="stack" style={{ gap: 20, paddingTop: 24 }}>
          <div className="row spread small muted">
            <span>Step {stepNo} of 3</span>
            {stage !== "pick" && (
              <button className="link-btn" onClick={() => setStage(stage === "amount" ? "protect" : "pick")}>
                Back
              </button>
            )}
          </div>

          {stage === "pick" && (
            <>
              <h1>What do you want to own?</h1>
              <div className="choices">
                <button
                  className="choice"
                  onClick={() => {
                    setStrategy("index");
                    setStage("protect");
                  }}
                >
                  <strong>The S&amp;P 500</strong>
                  <span>The 500 largest US companies in one go.</span>
                </button>
                <button
                  className="choice"
                  onClick={() => {
                    setStrategy("basket");
                    setStage("protect");
                  }}
                >
                  <strong>US tech</strong>
                  <span>Apple, Microsoft, NVIDIA, Amazon and Alphabet.</span>
                </button>
              </div>
            </>
          )}

          {stage === "protect" && (
            <>
              <h1>What if the {NAMES[currency]} goes up?</h1>
              <p className="muted">
                US shares are priced in US dollars. If the {NAMES[currency]} rises against the US dollar, your shares are
                worth less back home, even if the shares themselves haven&rsquo;t moved.
              </p>
              <div className="choices">
                <button
                  className="choice"
                  onClick={() => {
                    setHedged(true);
                    setStage("amount");
                  }}
                >
                  <strong>Protect me</strong>
                  <span>Cancels out most currency swings, up or down.</span>
                </button>
                <button
                  className="choice"
                  onClick={() => {
                    setHedged(false);
                    setStage("amount");
                  }}
                >
                  <strong>Let it ride</strong>
                  <span>You keep the currency swings, good and bad.</span>
                </button>
              </div>
            </>
          )}

          {stage === "amount" && (
            <>
              <h1>How much do you want to invest?</h1>
              <div className="field">
                <div className="amount">
                  <span className="unit" style={{ padding: "0 0 0 14px", alignSelf: "center", fontWeight: 650 }}>
                    {cur.symbol}
                  </span>
                  <input
                    aria-label="Amount to invest"
                    inputMode="decimal"
                    placeholder="0"
                    autoFocus
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  />
                </div>
                <div className="row spread hint">
                  <span>You have {money(have, cur.symbol, 0)} of test money.</span>
                  <button className="link-btn" onClick={() => setAmount(formatUnits(balance, 6))}>
                    Use all
                  </button>
                </div>
                {chips.length > 0 && (
                  <div className="row">
                    {chips.map((v) => (
                      <button key={v} className="btn secondary small" onClick={() => setAmount(String(v))}>
                        {money(v, cur.symbol, 0)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {open === false && (
                <p className="notice">
                  US markets are closed right now. Your order will go through at the next opening price.
                </p>
              )}
              {parsed > 0n && !tooMuch && preview !== undefined && (
                <p className="muted small">
                  You&rsquo;ll own about {money(worth, cur.symbol)}. Trading costs: {money(cost, cur.symbol)}.
                </p>
              )}

              <div>
                <button className="btn cta" disabled={parsed === 0n || tooMuch || steps.running || !vault} onClick={invest}>
                  {steps.running
                    ? `${steps.label}…`
                    : tooMuch
                      ? "More than you have"
                      : parsed > 0n
                        ? open === false
                          ? `Place ${money(gross, cur.symbol, 0)} order`
                          : `Invest ${money(gross, cur.symbol, 0)}`
                        : "Enter an amount"}
                </button>
              </div>
              {steps.error && <p className="notice error">{steps.error}</p>}
            </>
          )}
        </section>
      )}

      <p className="small muted" style={{ marginTop: 32 }}>
        Test money on a demo network. <Link href="/vaults">See all options</Link>
      </p>

      <style>{`
        .btn.cta { padding: 14px 28px; font-size: 1.1rem; }
        .choices { display: grid; gap: 12px; }
        .choice { font: inherit; text-align: left; display: grid; gap: 4px; padding: 20px; border: 1.5px solid var(--line); border-radius: var(--radius-m); background: var(--paper); color: var(--ink); cursor: pointer; }
        .choice strong { font-size: 1.25rem; }
        .choice span { color: var(--muted); }
        .choice:hover, .choice:focus-visible { border-color: var(--ink); }
      `}</style>
    </div>
  );
}
