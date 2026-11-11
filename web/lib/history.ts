"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { deployment, DEPLOY_BLOCK } from "./config";
import { getLogsSplit } from "./logs";
import type { Pt } from "@/components/Charts";

const navEvent = parseAbiItem("event NavSnapshot(uint256 nav, uint256 navPerShare, uint256 equityValue, int256 hedgeMtm, uint256 cash, uint256 usdPerLocal, uint256 timestamp)");

export interface NavPoint {
  t: number;
  navPerShare: number;
}

/** Share-price history per vault (lower-case address) from NavSnapshot events, last ~40k blocks. */
export function useNavHistories(vaults: Address[]) {
  const client = usePublicClient();
  const key = vaults.map((v) => v.toLowerCase()).sort().join(",");
  const [out, setOut] = useState<Record<string, NavPoint[]>>({});
  useEffect(() => {
    if (!client || !key) return;
    const list = key.split(",") as Address[];
    let dead = false;
    (async () => {
      const latest = await client.getBlockNumber();
      const start = (latest > 40_000n ? latest - 40_000n : 0n) > DEPLOY_BLOCK ? (latest > 40_000n ? latest - 40_000n : 0n) : DEPLOY_BLOCK;
      const acc: Record<string, NavPoint[]> = {};
      for (let from = start; from <= latest; from += 9_000n) {
        const to = from + 8_999n > latest ? latest : from + 8_999n;
        const logs = await getLogsSplit<{ address: string; args: { navPerShare: bigint; timestamp: bigint } }>(client, { address: list, event: navEvent }, from, to);
        for (const l of logs) (acc[l.address.toLowerCase()] ??= []).push({ t: Number(l.args.timestamp) * 1000, navPerShare: Number(l.args.navPerShare) / 1e6 });
      }
      for (const k of Object.keys(acc)) acc[k].sort((a, b) => a.t - b.t);
      if (!dead) setOut(acc);
    })().catch(() => {});
    return () => { dead = true; };
  }, [client, key]);
  return out;
}

/**
 * What today's holdings would have been worth over time: today's shares at each past share price.
 * An approximation, labelled as such in the UI. Products are in the user's own currency, so no FX step.
 */
export function holdingsSeries(rows: { address: string; shares: number }[], hist: Record<string, NavPoint[]>): Pt[] {
  const per = rows.map((r) => ({ r, pts: hist[r.address.toLowerCase()] ?? [] })).filter((x) => x.r.shares > 0 && x.pts.length > 0);
  if (!per.length) return [];
  const times = Array.from(new Set(per.flatMap((x) => x.pts.map((p) => p.t)))).sort((a, b) => a - b);
  const idx = per.map(() => 0);
  const out: Pt[] = [];
  for (const t of times) {
    let v = 0;
    let ok = true;
    per.forEach((x, i) => {
      while (idx[i] + 1 < x.pts.length && x.pts[idx[i] + 1].t <= t) idx[i]++;
      const p = x.pts[idx[i]];
      if (p.t > t) { ok = false; return; }
      v += x.r.shares * p.navPerShare;
    });
    if (ok && Number.isFinite(v)) out.push({ t, v });
  }
  return out;
}

export const pctSeries = (pts: NavPoint[]): Pt[] => (pts.length < 2 ? [] : pts.map((p) => ({ t: p.t, v: (p.navPerShare / pts[0].navPerShare - 1) * 100 })));

// ------------------------------------------------------------------ activity log

const ev = {
  invested: parseAbiItem("event DepositedWith(address indexed user, address indexed vault, address token, uint256 amount, uint256 shares)"),
  sold: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"),
  borrow: parseAbiItem("event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)"),
  repay: parseAbiItem("event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"),
  supply: parseAbiItem("event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"),
  withdraw: parseAbiItem("event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)"),
};

export type ActivityKind = "Invest" | "Sell" | "Borrow" | "Repay" | "Lend" | "Withdraw";
export interface Activity {
  kind: ActivityKind;
  amount: number; // 6-dp stablecoin units
  block: bigint;
  t?: number;
}

type L = { blockNumber: bigint; args: Record<string, bigint> };

/** The user's latest investing, selling, borrowing and lending actions, read from onchain events. */
export function useActivity(user?: Address, limit = 6) {
  const client = usePublicClient();
  const [items, setItems] = useState<Activity[]>();
  useEffect(() => {
    if (!client || !user) return;
    let dead = false;
    (async () => {
      const latest = await client.getBlockNumber();
      const start = (latest > 60_000n ? latest - 60_000n : 0n) > DEPLOY_BLOCK ? (latest > 60_000n ? latest - 60_000n : 0n) : DEPLOY_BLOCK;
      const vaults = deployment.vaults.map((v) => v.address);
      const out: Activity[] = [];
      for (let f = start; f <= latest; f += 9_000n) {
        const to = f + 8_999n > latest ? latest : f + 8_999n;
        const g = (p: Record<string, unknown>) => getLogsSplit<L>(client, p, f, to);
        const [inv, sold, br, rp, sp, wd] = await Promise.all([
          g({ address: deployment.router, event: ev.invested, args: { user } }),
          g({ address: vaults, event: ev.sold, args: { owner: user } }),
          g({ address: deployment.morpho, event: ev.borrow, args: { onBehalf: user } }),
          g({ address: deployment.morpho, event: ev.repay, args: { onBehalf: user } }),
          g({ address: deployment.morpho, event: ev.supply, args: { onBehalf: user } }),
          g({ address: deployment.morpho, event: ev.withdraw, args: { onBehalf: user } }),
        ]);
        const add = (kind: ActivityKind, ls: L[], f: string) => ls.forEach((l) => out.push({ kind, amount: Number(l.args[f]) / 1e6, block: l.blockNumber }));
        add("Invest", inv, "amount"); add("Sell", sold, "assets"); add("Borrow", br, "assets");
        add("Repay", rp, "assets"); add("Lend", sp, "assets"); add("Withdraw", wd, "assets");
      }
      out.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
      const top = out.slice(0, limit);
      await Promise.all(top.map(async (a) => { a.t = Number((await client.getBlock({ blockNumber: a.block })).timestamp) * 1000; }));
      if (!dead) setItems(top);
    })().catch(() => { if (!dead) setItems([]); });
    return () => { dead = true; };
  }, [client, user, limit]);
  return items;
}
