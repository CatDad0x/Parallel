"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { CURRENCIES, type Currency } from "@parallel/shared";
import { useCurrency } from "@/lib/currency";
import { useMarketOpen } from "@/lib/hooks";
import { SignInButton, Slash, useOnboarding, useWallet, fmtMoney, Notice, TestMoneyCtx, TestMoneyCard } from "@/lib/pm";
import { short } from "@/lib/format";

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/invest", label: "Invest" },
  { href: "/borrow", label: "Borrow" },
  { href: "/earn", label: "Earn" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="7 5 30 38" aria-hidden="true">
      <path d="M11 39 20 13" stroke="#14222E" strokeWidth="6.5" strokeLinecap="round" />
      <path d="M24 35 33 9" stroke="var(--pm-accent)" strokeWidth="6.5" strokeLinecap="round" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { currency, setCurrency } = useCurrency();
  const onboarding = useOnboarding();
  const bare = path === "/";
  if (bare) return <div className="pm-app" data-cur={currency}>{children}</div>;
  return (
    <TestMoneyCtx.Provider value={{ add: onboarding.addMore, busy: onboarding.busy || onboarding.setup === "running", failed: onboarding.setup === "error", error: onboarding.error, retry: onboarding.retry }}>
      <div className="pm-app" data-cur={currency}>
        <Sidebar path={path} currency={currency} setCurrency={setCurrency} onboarding={onboarding} />
        <main className="pm-main">
          <Gate onboarding={onboarding}>{children}</Gate>
        </main>
      </div>
    </TestMoneyCtx.Provider>
  );
}

type Onboarding = ReturnType<typeof useOnboarding>;

function Sidebar({ path, currency, setCurrency, onboarding }: { path: string; currency: Currency; setCurrency: (c: Currency) => void; onboarding: Onboarding }) {
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const { balance, symbol } = useWallet();
  const { open } = useMarketOpen();
  return (
    <aside className="pm-side">
      <Link href="/" className="pm-brand" aria-label="Parallel home">
        <Logo />
        <span>parallel</span>
        <span className="pm-tag">Demo</span>
      </Link>
      <nav className="pm-nav" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? "page" : undefined}>
            {path.startsWith(n.href) && <Slash />}
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="pm-foot">
        <label className="pm-money" style={{ gap: 6 }}>
          <span>Currency</span>
          <select className="pm-select" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="Home currency">
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.code}
              </option>
            ))}
          </select>
        </label>
        {isConnected ? (
          <>
            <div className="pm-money">
              <span>Test money</span>
              <strong className="num">{fmtMoney(balance, symbol)}</strong>
            </div>
            <button className="pm-btn sec sm" onClick={onboarding.addMore} disabled={onboarding.busy || onboarding.setup === "running"}>
              <Slash /> Add test money
            </button>
            <button className="pm-link" style={{ alignSelf: "flex-start", fontWeight: 500 }} onClick={() => disconnect()}>
              {short(address)} · Sign out
            </button>
          </>
        ) : (
          <SignInButton label="Sign in" className="pm-btn sm" />
        )}
        <span className="pm-mkt">
          <span className={`pm-dot ${open === undefined ? "" : open ? "open" : "closed"}`} />
          {open === undefined ? "Checking US market…" : open ? "US market open" : "US market closed"}
        </span>
        <Link href="/advanced" style={{ fontSize: 12, color: "var(--pm-muted)", textDecoration: "none" }}>
          Advanced (for partner teams)
        </Link>
        <small>Base Sepolia test network. Not affiliated with any stablecoin issuer.</small>
      </div>
    </aside>
  );
}

/** Screens that need a signed-in user show this instead of empty data. */
function Gate({ children, onboarding }: { children: ReactNode; onboarding: Onboarding }) {
  const path = usePathname();
  const { isConnected } = useAccount();
  const { balance } = useWallet();
  const open = path.startsWith("/advanced") || path.startsWith("/admin") || path.startsWith("/simulator");
  if (!isConnected && !open) {
    return (
      <div className="pm-pad" style={{ maxWidth: 560, paddingTop: 80 }}>
        <h1 className="pm-h1">Sign in to try it</h1>
        <p className="pm-lede">It takes one tap, and we add test money to your account. Nothing here is real money.</p>
        <div>
          <SignInButton label="Sign in and get test money" className="pm-btn" />
        </div>
      </div>
    );
  }
  return (
    <>
      {isConnected && onboarding.setup === "running" && (
        <Notice tone="info">Setting up your test account and adding test money. This takes a few seconds.</Notice>
      )}
      {isConnected && onboarding.setup === "error" && balance === 0 && (
        <div className="pm-pad" style={{ paddingBottom: 0 }}>
          <TestMoneyCard />
        </div>
      )}
      {children}
    </>
  );
}
