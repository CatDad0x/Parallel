"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { decodeEventLog, parseAbiItem, type Address, type Hex } from "viem";
import { morphoAbi, routerAbi, marketParams, CURRENCIES, type VaultInfo } from "@parallel/shared";
import { deployment } from "@/lib/config";
import { useCurrency } from "@/lib/currency";
import { useFx, useVaultStats } from "@/lib/hooks";
import { money, pct, signedMoney } from "@/lib/format";
import { PendingRequests } from "@/components/PendingRequests";

const ev = {
  deposit: parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)"),
  withdraw: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"),
  settledD: parseAbiItem("event DepositSettled(uint256 indexed id, address indexed receiver, uint256 assets, uint256 shares)"),
  settledR: parseAbiItem("event RedeemSettled(uint256 indexed id, address indexed receiver, uint256 shares, uint256 assets)"),
  routed: parseAbiItem("event DepositedWith(address indexed user, address indexed vault, address token, uint256 amount, uint256 shares)"),
  nav: parseAbiItem("event NavSnapshot(uint256 nav, uint256 navPerShare, uint256 equityValue, int256 hedgeMtm, uint256 cash, uint256 usdPerLocal, uint256 timestamp)"),
};

interface Basis {
  net: number; // local currency deposited minus withdrawn
  fx0?: number; // usdPerLocal at first deposit
}

/** Net contributions per vault from onchain events, plus the FX rate at the user's first deposit. */
function useBasis(user?: Address) {
  const client = usePublicClient();
  const [basis, setBasis] = useState<Record<string, Basis>>({});
  useEffect(() => {
    if (!client || !user) return;
    (async () => {
      const latest = await client.getBlockNumber();
      const start = latest > 60_000n ? latest - 60_000n : 0n;
      const out: Record<string, Basis & { firstTx?: Hex; firstBlock?: bigint }> = {};
      const add = (v: string, amt: number, tx?: Hex, block?: bigint) => {
        const b = (out[v.toLowerCase()] ??= { net: 0 });
        b.net += amt;
        if (amt > 0 && tx && (b.firstBlock === undefined || (block ?? 0n) < b.firstBlock)) {
          b.firstTx = tx;
          b.firstBlock = block;
        }
      };
      const vaults = deployment.vaults.map((v) => v.address);
      for (let f = start; f <= latest; f += 9_000n) {
        const to = f + 8_999n > latest ? latest : f + 8_999n;
        const [d, w, sd, sr, r] = await Promise.all([
          client.getLogs({ address: vaults, event: ev.deposit, args: { owner: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vaults, event: ev.withdraw, args: { owner: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vaults, event: ev.settledD, args: { receiver: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vaults, event: ev.settledR, args: { receiver: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: deployment.router, event: ev.routed, args: { user }, fromBlock: f, toBlock: to }),
        ]);
        // Router deposits emit Deposit(owner=user) and DepositedWith; count router flows once via DepositedWith.
        d.filter((l) => l.args.sender!.toLowerCase() !== deployment.router.toLowerCase()).forEach((l) =>
          add(l.address, Number(l.args.assets) / 1e6, l.transactionHash, l.blockNumber),
        );
        r.forEach((l) => add(l.args.vault!, Number(l.args.amount) / 1e6, l.transactionHash, l.blockNumber));
        sd.forEach((l) => add(l.address, Number(l.args.assets) / 1e6, l.transactionHash, l.blockNumber));
        w.forEach((l) => add(l.address, -Number(l.args.assets) / 1e6));
        sr.forEach((l) => add(l.address, -Number(l.args.assets) / 1e6));
      }
      // FX at first deposit = the NavSnapshot emitted in that transaction.
      await Promise.all(
        Object.entries(out).map(async ([v, b]) => {
          if (!b.firstTx) return;
          const rc = await client.getTransactionReceipt({ hash: b.firstTx });
          for (const lg of rc.logs) {
            if (lg.address.toLowerCase() !== v) continue;
            try {
              const dec = decodeEventLog({ abi: [ev.nav], data: lg.data, topics: lg.topics });
              b.fx0 = Number(dec.args.usdPerLocal) / 1e18;
            } catch {}
          }
        }),
      );
      setBasis(out);
    })().catch(() => {});
  }, [client, user]);
  return basis;
}

export default function Portfolio() {
  const { address } = useAccount();
  const { currency, meta } = useCurrency();
  const fx = useFx();
  const { stats } = useVaultStats(deployment.vaults);
  const basis = useBasis(address);

  // Vault shares posted as Morpho collateral still belong to the user.
  const vaultMarkets = deployment.markets.filter((m) => deployment.vaults.some((v) => v.address === m.collateralToken));
  const allMarkets = deployment.markets;
  const { data: posData } = useReadContracts({
    contracts: allMarkets.flatMap((m) => [
      { address: deployment.morpho, abi: morphoAbi, functionName: "position", args: [m.id, address!] },
      { address: deployment.router, abi: routerAbi, functionName: "healthFactor", args: [marketParams(m), address!] },
    ]),
    query: { enabled: !!address },
  });
  const posOf = (i: number) => posData?.[i * 2]?.result as readonly [bigint, bigint, bigint] | undefined;

  const toHome = (v: number, from: string) => {
    if (from === currency) return v;
    const a = fx[from]?.usdPerLocal;
    const b = fx[currency]?.usdPerLocal;
    return a && b ? (v * a) / b : NaN;
  };

  const rows = stats
    .map((s) => {
      const mIdx = allMarkets.findIndex((m) => m.collateralToken === s.info.address);
      const collateralShares = mIdx >= 0 ? posOf(mIdx)?.[2] ?? 0n : 0n;
      const shares = Number(s.userShares + collateralShares) / 1e18;
      const value = shares * s.navPerShare;
      const b = basis[s.info.address.toLowerCase()];
      const pnl = b ? value - b.net : NaN;
      // Estimated attribution: equity sleeve (user's share) re-valued at the starting FX rate.
      const userEq = s.supply > 0 ? (shares / s.supply) * s.equityValue : 0;
      const fxNow = fx[s.info.currency]?.usdPerLocal;
      const fxEffect = b?.fx0 && fxNow ? userEq * (1 - fxNow / b.fx0) : 0;
      const hedge = s.info.hedged && s.supply > 0 ? (shares / s.supply) * s.hedgeMtm : 0;
      const equityEffect = Number.isFinite(pnl) ? pnl - fxEffect - hedge : NaN;
      return { s, shares, value, pnl, fxEffect, hedge, equityEffect, collateralShares, b };
    })
    .filter((r) => r.shares > 0);

  const totalHome = rows.reduce((a, r) => a + toHome(r.value, r.s.info.currency), 0);
  const pnlHome = rows.reduce((a, r) => a + (Number.isFinite(r.pnl) ? toHome(r.pnl, r.s.info.currency) : 0), 0);
  const debts = allMarkets
    .map((m, i) => ({ m, pos: posOf(i), hf: posData?.[i * 2 + 1]?.result as bigint | undefined }))
    .filter((x) => x.pos && x.pos[1] > 0n);

  if (!address)
    return (
      <div className="page">
        <h1>Portfolio</h1>
        <p className="notice">Sign in to see your positions.</p>
      </div>
    );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Portfolio</h1>
        <p className="muted">Everything shown in {currency}. Positions in other currencies are converted at today&rsquo;s rate.</p>
      </div>

      <div className="row" style={{ gap: 48 }}>
        <div>
          <div className="small muted">Total value</div>
          <div className="big">{money(totalHome, meta.symbol)}</div>
        </div>
        <div>
          <div className="small muted">Gain or loss</div>
          <div className={`big ${pnlHome >= 0 ? "pos" : "neg"}`} style={{ fontSize: "1.6rem" }}>
            {signedMoney(pnlHome, meta.symbol)}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel quiet stack">
          <p>You don&rsquo;t hold any vault shares yet.</p>
          <div>
            <Link href="/vaults" className="btn">Choose a vault</Link>
          </div>
        </div>
      ) : (
        <section className="stack">
          <h2>Investments</h2>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Vault</th>
                  <th className="num">Value</th>
                  <th className="num">Gain or loss</th>
                  <th className="num">From shares</th>
                  <th className="num">From currency</th>
                  <th className="num">From hedge</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const sym = CURRENCIES.find((c) => c.code === r.s.info.currency)!.symbol;
                  return (
                    <tr key={r.s.info.address}>
                      <td>
                        <Link href={`/vaults/${r.s.info.address}`}>{r.s.info.name}</Link>
                        {r.collateralShares > 0n && <div className="hint">Includes shares posted as loan collateral</div>}
                      </td>
                      <td className="num">{money(r.value, sym)}</td>
                      <td className={`num ${r.pnl >= 0 ? "pos" : "neg"}`}>
                        {signedMoney(r.pnl, sym)}
                        <div className="hint">{r.b?.net ? pct((r.pnl / r.b.net) * 100, 2, true) : ""}</div>
                      </td>
                      <td className="num">{signedMoney(r.equityEffect, sym)}</td>
                      <td className="num">{signedMoney(r.fxEffect, sym)}</td>
                      <td className="num">{r.s.info.hedged ? signedMoney(r.hedge, sym) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="hint">
            The split is an estimate. &ldquo;From currency&rdquo; re-values your share of the equities at the exchange
            rate on your first deposit. &ldquo;From hedge&rdquo; is the unrealised hedge result; realised hedge gains or
            losses already sit in the vault&rsquo;s cash. &ldquo;From shares&rdquo; is the remainder, including fees and
            spread.
          </p>
        </section>
      )}

      {debts.length > 0 && (
        <section className="stack">
          <h2>Loans</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Health</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {debts.map((d) => {
                const hf = d.hf ? Number(d.hf) / 1e18 : NaN;
                return (
                  <tr key={d.m.id}>
                    <td>{d.m.label}</td>
                    <td className={`num ${hf < 1.1 ? "neg" : ""}`}>{Number.isFinite(hf) ? hf.toFixed(2) : "…"}</td>
                    <td className="num"><Link href="/borrow">Manage</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {stats.length > 0 && (
        <section className="stack" style={{ maxWidth: 460 }}>
          {deployment.vaults.map((v: VaultInfo) => <PendingRequests key={v.address} vault={v.address} />)}
        </section>
      )}
      {vaultMarkets.length === 0 && null}
    </div>
  );
}
