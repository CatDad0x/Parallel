"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { deployment } from "./config";

const ev = {
  invested: parseAbiItem("event DepositedWith(address indexed user, address indexed vault, address token, uint256 amount, uint256 shares)"),
  sold: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"),
  // Morpho Blue events (EventsLib).
  borrow: parseAbiItem("event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)"),
  repay: parseAbiItem("event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"),
  supply: parseAbiItem("event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"),
  withdraw: parseAbiItem("event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)"),
};

export type ActivityKind = "Invest" | "Sell" | "Borrow" | "Repay" | "Lend" | "Withdraw";

export interface Activity {
  kind: ActivityKind;
  /** Vault or market the action touched. */
  vault?: Address;
  marketId?: string;
  /** Amount in the stablecoin's own currency (6 dp tokens). */
  amount: number;
  currency: string;
  block: bigint;
  t?: number;
}

const currencyOfToken = (token?: string) => deployment.tokens.find((t) => t.address.toLowerCase() === token?.toLowerCase())?.currency ?? "AUD";
const currencyOfVault = (v: string) => deployment.vaults.find((x) => x.address.toLowerCase() === v.toLowerCase())?.currency ?? "AUD";
const currencyOfMarket = (id: string) => currencyOfToken(deployment.markets.find((m) => m.id.toLowerCase() === id.toLowerCase())?.loanToken);

/** The user's most recent investing, selling, borrowing and lending actions, read from onchain events. */
export function useActivity(user?: Address, limit = 5) {
  const client = usePublicClient();
  const [items, setItems] = useState<Activity[] | undefined>(undefined);
  useEffect(() => {
    if (!client || !user) return;
    let cancelled = false;
    (async () => {
      const latest = await client.getBlockNumber();
      const start = latest > 60_000n ? latest - 60_000n : 0n;
      const vaults = deployment.vaults.map((v) => v.address);
      const out: Activity[] = [];
      for (let f = start; f <= latest; f += 9_000n) {
        const to = f + 8_999n > latest ? latest : f + 8_999n;
        const range = { fromBlock: f, toBlock: to };
        const [inv, sold, br, rp, sp, wd] = await Promise.all([
          client.getLogs({ address: deployment.router, event: ev.invested, args: { user }, ...range }),
          client.getLogs({ address: vaults, event: ev.sold, args: { owner: user }, ...range }),
          client.getLogs({ address: deployment.morpho, event: ev.borrow, args: { onBehalf: user }, ...range }),
          client.getLogs({ address: deployment.morpho, event: ev.repay, args: { onBehalf: user }, ...range }),
          client.getLogs({ address: deployment.morpho, event: ev.supply, args: { onBehalf: user }, ...range }),
          client.getLogs({ address: deployment.morpho, event: ev.withdraw, args: { onBehalf: user }, ...range }),
        ]);
        inv.forEach((l) => out.push({ kind: "Invest", vault: l.args.vault, amount: Number(l.args.amount) / 1e6, currency: currencyOfToken(l.args.token), block: l.blockNumber }));
        sold.forEach((l) => out.push({ kind: "Sell", vault: l.address, amount: Number(l.args.assets) / 1e6, currency: currencyOfVault(l.address), block: l.blockNumber }));
        br.forEach((l) => out.push({ kind: "Borrow", marketId: l.args.id, amount: Number(l.args.assets) / 1e6, currency: currencyOfMarket(l.args.id!), block: l.blockNumber }));
        rp.forEach((l) => out.push({ kind: "Repay", marketId: l.args.id, amount: Number(l.args.assets) / 1e6, currency: currencyOfMarket(l.args.id!), block: l.blockNumber }));
        // Router collateral moves don't emit Supply/Withdraw (those are SupplyCollateral/WithdrawCollateral), so these are lending.
        sp.forEach((l) => out.push({ kind: "Lend", marketId: l.args.id, amount: Number(l.args.assets) / 1e6, currency: currencyOfMarket(l.args.id!), block: l.blockNumber }));
        wd.forEach((l) => out.push({ kind: "Withdraw", marketId: l.args.id, amount: Number(l.args.assets) / 1e6, currency: currencyOfMarket(l.args.id!), block: l.blockNumber }));
      }
      out.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
      const top = out.slice(0, limit);
      await Promise.all(
        top.map(async (a) => {
          const b = await client.getBlock({ blockNumber: a.block });
          a.t = Number(b.timestamp) * 1000;
        }),
      );
      if (!cancelled) setItems(top);
    })().catch(() => {
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [client, user, limit]);
  return items;
}
