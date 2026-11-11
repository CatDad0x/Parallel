"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount, useConnect, useReadContract, useReadContracts } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { CURRENCIES, exchangeAbi, faucetAbi, morphoAbi, oracleHubAbi, routerAbi, marketParams, type MarketInfo, type VaultInfo } from "@parallel/shared";
import { deployment, USE_MOCK_WALLET, PRIVY_APP_ID } from "./config";
import { useCurrency } from "./currency";
import { useBalances, useFx, useSteps, useVaultStats, type VaultStats } from "./hooks";

export type Strategy = "index" | "basket";

export const PRODUCT_META: Record<Strategy, { code: string; name: string; sub: string; long: string }> = {
  index: { code: "500", name: "S&P 500", sub: "500 of the largest US companies in one investment", long: "the S&P 500" },
  basket: { code: "TECH", name: "US tech", sub: "Apple, Microsoft, NVIDIA, Amazon and Alphabet", long: "US tech" },
};

/** Currency context: symbol, stablecoin used for deposits, balance. */
export function useWallet() {
  const { address, isConnected } = useAccount();
  const { currency, meta } = useCurrency();
  const asset = deployment.tokens.find((t) => t.symbol === meta.stables[0])!;
  const { balances, refetch } = useBalances([asset.address]);
  const balance = Number(balances[0] ?? 0n) / 1e6;
  return { address, isConnected, currency, symbol: meta.symbol, asset, balance, refetchBalance: refetch };
}

/** The hedged vault for each product in the user's currency, with live stats. */
export function useProducts() {
  const { currency } = useCurrency();
  const vaults = useMemo(
    () =>
      (["index", "basket"] as Strategy[])
        .map((k) => deployment.vaults.find((v) => v.currency === currency && v.strategy === k && v.hedged))
        .filter(Boolean) as VaultInfo[],
    [currency],
  );
  const { stats, refetch } = useVaultStats(vaults);
  return { vaults, stats, refetch };
}

export interface Loan {
  market: MarketInfo;
  vault?: VaultInfo;
  strategy?: Strategy;
  borrowed: number;
  collateralShares: bigint;
  ltv: number;
  hf: number;
  authorized: boolean;
  maxBorrow: number;
}

export function lltvOf(m: MarketInfo) {
  return Number(BigInt(m.lltv)) / 1e18;
}
export function openLtvOf(m: MarketInfo) {
  return Number(BigInt(m.maxOpenLtv)) / 1e18;
}

/** Safety meter: green below 80% of liquidation LTV, amber 80-92%, red above. */
export function safety(ltv: number, lltv: number): { label: string; level: 0 | 1 | 2; filled: number } {
  const r = lltv > 0 ? ltv / lltv : 0;
  if (r < 0.8) return { label: "Comfortable", level: 0, filled: 1 };
  if (r < 0.92) return { label: "Getting close", level: 1, filled: 2 };
  return { label: "At risk", level: 2, filled: 3 };
}

/** The user's loans (same-currency Morpho markets), positions read from Morpho + router. */
export function useLoans() {
  const { address } = useAccount();
  const { currency, meta } = useCurrency();
  const loanToken = deployment.tokens.find((t) => t.symbol === meta.stables[0])!;
  const markets = useMemo(() => deployment.markets.filter((m) => m.loanToken === loanToken.address), [loanToken.address]);
  const user = address ?? "0x0000000000000000000000000000000000000001";
  const { data, refetch } = useReadContracts({
    contracts: markets.flatMap((m) => [
      { address: deployment.morpho, abi: morphoAbi, functionName: "market", args: [m.id] },
      { address: deployment.morpho, abi: morphoAbi, functionName: "position", args: [m.id, user] },
      { address: deployment.router, abi: routerAbi, functionName: "ltvOf", args: [marketParams(m), user] },
      { address: deployment.router, abi: routerAbi, functionName: "healthFactor", args: [marketParams(m), user] },
      { address: deployment.router, abi: routerAbi, functionName: "maxBorrow", args: [marketParams(m), user] },
      { address: deployment.morpho, abi: morphoAbi, functionName: "isAuthorized", args: [user, deployment.router] },
    ]),
  });
  const loans: Loan[] = markets.map((m, i) => {
    const r = (j: number) => data?.[i * 6 + j]?.result;
    const mk = r(0) as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
    const pos = r(1) as readonly [bigint, bigint, bigint] | undefined;
    const borrowAssets = mk ? Number(mk[2]) / 1e6 : 0;
    const borrowed = mk && pos && mk[3] > 0n ? (Number(pos[1]) / Number(mk[3])) * borrowAssets : 0;
    const hfRaw = r(3) as bigint | undefined;
    const vault = deployment.vaults.find((v) => v.address === m.collateralToken);
    return {
      market: m,
      vault,
      strategy: vault?.strategy,
      borrowed,
      collateralShares: pos?.[2] ?? 0n,
      ltv: Number((r(2) as bigint | undefined) ?? 0n) / 1e18,
      hf: hfRaw === undefined || hfRaw > 10n ** 30n ? Infinity : Number(hfRaw) / 1e18,
      authorized: (r(5) as boolean | undefined) ?? false,
      maxBorrow: Number((r(4) as bigint | undefined) ?? 0n) / 1e6,
    };
  });
  return { loans, refetch, markets, loading: !data };
}

/** DEX deviation: level 0 normal, 1 amber, 2 red, 3 paused. */
export function useDeviation() {
  const { data: level } = useReadContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "deviationLevel" });
  const { data: drift } = useReadContract({ address: deployment.exchange, abi: exchangeAbi, functionName: "driftBps" });
  return { level: Number(level ?? 0), driftBps: Number(drift ?? 0n) };
}

export function userSharesValue(s: VaultStats, collateral: bigint) {
  return (Number(s.userShares + collateral) / 1e18) * s.navPerShare;
}

// ------------------------------------------------------------------ sign-in + test money

export function SignInButton({ label = "Sign in", className = "pm-btn" }: { label?: string; className?: string }) {
  return PRIVY_APP_ID ? <PrivySignIn label={label} className={className} /> : <WagmiSignIn label={label} className={className} />;
}

function PrivySignIn({ label, className }: { label: string; className: string }) {
  const { ready, login } = usePrivy();
  return (
    <button className={className} disabled={!ready} onClick={login}>
      {label}
    </button>
  );
}

function WagmiSignIn({ label, className }: { label: string; className: string }) {
  const { connectors, connect, isPending } = useConnect();
  const pick = USE_MOCK_WALLET
    ? connectors.find((c) => c.id === "mock")
    : (connectors.find((c) => c.id === "coinbaseWalletSDK") ?? connectors[0]);
  return (
    <button className={className} disabled={!pick || isPending} onClick={() => pick && connect({ connector: pick })}>
      {isPending ? "Connecting…" : label}
    </button>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type Setup = "idle" | "running" | "done" | "error";

/** Claims test money once after sign-in (sponsored via /api/onboard, or directly from the faucet). */
export function useOnboarding() {
  const { address, isConnected } = useAccount();
  const steps = useSteps();
  const [setup, setSetup] = useState<Setup>("idle");
  const fundedFor = useRef<string | undefined>(undefined);
  const { refetchBalance } = useWallet();
  const { data: next } = useReadContract({
    address: deployment.faucet,
    abi: faucetAbi,
    functionName: "nextClaimAt",
    args: [address!],
    query: { enabled: !!address },
  });

  const start = () => {
    if (!address) return;
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
        const ok = await steps.run([{ label: "Adding test money", address: deployment.faucet, abi: faucetAbi, functionName: "claim" }], "");
        setSetup(ok ? "done" : "error");
      } else setSetup(r === "ok" ? "done" : "error");
      refetchBalance();
    });
  };

  useEffect(() => {
    if (!isConnected || !address || fundedFor.current === address) return;
    // Only auto-claim when the faucet is available to this address; otherwise they already have funds.
    if (next === undefined) return;
    const ready = Number(next as bigint) * 1000 <= Date.now();
    fundedFor.current = address;
    if (ready) start();
    else setSetup("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, next]);

  return {
    setup,
    error: steps.error,
    busy: steps.running,
    retry: () => {
      fundedFor.current = undefined;
      start();
    },
    addMore: () => start(),
  };
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "red" | "ok" | "info"; children: ReactNode }) {
  return (
    <div className={`pm-note ${tone === "warn" ? "" : tone}`} role={tone === "red" ? "alert" : "status"}>
      <span>{children}</span>
    </div>
  );
}

export function Slash() {
  return (
    <span aria-hidden="true" className="pm-slash">
      //
    </span>
  );
}

export const fmtMoney = (n: number, sym: string, d = 0) =>
  `${n < 0 ? "−" : ""}${sym}${Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const fmtSigned = (n: number, sym: string, d = 0) => (n >= 0 ? "+" : "") + fmtMoney(n, sym, d);

export { CURRENCIES, useFx };

// ------------------------------------------------------------------ edge states

/** Lets any screen ask for more test money (the shell owns the one onboarding instance). */
export const TestMoneyCtx = createContext<{ add: () => void; busy: boolean; failed: boolean; error?: string; retry: () => void }>({
  add: () => {},
  busy: false,
  failed: false,
  retry: () => {},
});
export const useTestMoney = () => useContext(TestMoneyCtx);

/** True once every vault reports a usable price. A stale or missing oracle makes these reads fail, so we wait. */
export function usePricesReady(stats: VaultStats[]) {
  return stats.length > 0 && stats.every((s) => Number.isFinite(s.navPerShare) && s.navPerShare > 0);
}

/** Next US market open as local text, from the oracle's own schedule (weekends only, holidays not modelled). */
export function useNextOpen() {
  const { data } = useReadContracts({
    contracts: [
      { address: deployment.oracleHub, abi: oracleHubAbi, functionName: "etOffset" },
      { address: deployment.oracleHub, abi: oracleHubAbi, functionName: "sessionOpen" },
    ],
  });
  const off = data?.[0]?.result as bigint | undefined;
  const open = data?.[1]?.result as bigint | undefined;
  return useMemo(() => {
    if (off === undefined || open === undefined) return undefined;
    const now = Math.floor(Date.now() / 1000);
    for (let d = 0; d < 8; d++) {
      const et = now + Number(off);
      const day = Math.floor(et / 86400) + d;
      const dow = (day + 4) % 7;
      if (dow === 0 || dow === 6) continue;
      const startUtc = day * 86400 + Number(open) - Number(off);
      if (startUtc <= now) continue;
      return new Date(startUtc * 1000).toLocaleString("en-AU", { weekday: "long", hour: "numeric", minute: "2-digit" }).replace(",", "");
    }
    return undefined;
  }, [off, open]);
}

export function PricesLoading() {
  return (
    <div className="pm-status" role="status">
      <svg className="pm-spin" aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--pm-accent)" strokeWidth="2" strokeLinecap="round">
        <path d="M16 9a7 7 0 1 1-7-7" />
      </svg>
      Getting the latest prices…
    </div>
  );
}

export function MarketClosedNotice({ what }: { what: string }) {
  const next = useNextOpen();
  return (
    <Notice tone="info">
      US markets are closed. {what}
      {next ? ` The next open is ${next} (your time).` : ""}
    </Notice>
  );
}

export function TestMoneyCard() {
  const t = useTestMoney();
  return (
    <section className="pm-money-card" aria-label="Get test money">
      <span aria-hidden="true" className="pm-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="6" width="18" height="13" rx="3" />
          <path d="M3 10h18M16 14.5h2" />
        </svg>
      </span>
      <div style={{ display: "grid", gap: 4 }}>
        <strong style={{ fontSize: 18, letterSpacing: -0.4 }}>Start with test money</strong>
        <span className="pm-muted">Get some pretend money to try investing and borrowing. It has no real value.</span>
      </div>
      {t.failed && (
        <div className="pm-note red" role="alert" style={{ alignSelf: "stretch" }}>
          <div style={{ display: "grid", gap: 2 }}>
            <strong>We couldn&rsquo;t add your test money</strong>
            <span>{t.error ?? "The test network is busy. Nothing was charged. Try again in a minute."}</span>
          </div>
        </div>
      )}
      <button className="pm-btn" onClick={t.failed ? t.retry : t.add} disabled={t.busy}>
        {t.busy ? "Adding…" : t.failed ? "Try again" : "Add test money"}
      </button>
      <span className="pm-small pm-muted">You can still look around. Investing needs test money first.</span>
    </section>
  );
}
