"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CURRENCIES, type Currency } from "@parallel/shared";
import { useCurrency } from "@/lib/currency";
import { useMarketOpen } from "@/lib/hooks";
import { ConnectButton } from "./ConnectButton";

const NAV = [
  { href: "/try", label: "Try it" },
  { href: "/simulator", label: "Simulator" },
  { href: "/vaults", label: "Invest" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/borrow", label: "Borrow" },
  { href: "/lend", label: "Lend" },
  { href: "/admin", label: "Demo controls" },
];

export function Header() {
  const path = usePathname();
  const { currency, setCurrency } = useCurrency();
  const { open } = useMarketOpen();
  return (
    <header className="header">
      <div className="wrap header-row">
        <Link href="/" className="wordmark" aria-label="Parallel Markets home">
          <span className="wordmark-mark" aria-hidden />
          Parallel Markets
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="header-tools">
          <span className="small muted" title="US equity market status used by the protocol">
            <span className={`status-dot ${open === undefined ? "" : open ? "open" : "closed"}`} aria-hidden />
            <span className="market-label">{open === undefined ? "…" : open ? "US open" : "US closed"}</span>
          </span>
          <select
            aria-label="Home currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.code}
              </option>
            ))}
          </select>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
