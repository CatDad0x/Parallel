"use client";

import { useAccount, useReadContracts } from "wagmi";
import { morphoAbi, routerAbi, marketParams, type MarketInfo } from "@parallel/shared";
import { deployment } from "./config";

const YEAR = 365 * 24 * 3600;

export interface MarketState {
  m: MarketInfo;
  supplyAssets: number;
  borrowAssets: number;
  utilisation: number;
  borrowApr: number;
  supplyApr: number;
  fee: number;
  user: {
    supplyAssets: number;
    borrowAssets: number;
    collateral: bigint;
    ltv: number;
    hf: number;
    maxBorrow: number;
    authorized: boolean;
  };
}

/** Morpho market + user position state for a list of markets (loan tokens are 6-dp stables). */
export function useMarkets(markets: MarketInfo[]) {
  const { address } = useAccount();
  const user = address ?? "0x0000000000000000000000000000000000000001";
  const per = 6;
  const { data, refetch } = useReadContracts({
    contracts: markets.flatMap((m) => {
      const mp = marketParams(m);
      return [
        { address: deployment.morpho, abi: morphoAbi, functionName: "market", args: [m.id] },
        { address: deployment.morpho, abi: morphoAbi, functionName: "position", args: [m.id, user] },
        { address: deployment.router, abi: routerAbi, functionName: "ltvOf", args: [mp, user] },
        { address: deployment.router, abi: routerAbi, functionName: "healthFactor", args: [mp, user] },
        { address: deployment.router, abi: routerAbi, functionName: "maxBorrow", args: [mp, user] },
        { address: deployment.morpho, abi: morphoAbi, functionName: "isAuthorized", args: [user, deployment.router] },
      ];
    }),
  });

  const states: MarketState[] = markets.map((m, i) => {
    const r = (j: number) => data?.[i * per + j]?.result;
    const mk = r(0) as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
    const pos = r(1) as readonly [bigint, bigint, bigint] | undefined;
    const supplyAssets = mk ? Number(mk[0]) / 1e6 : 0;
    const borrowAssets = mk ? Number(mk[2]) / 1e6 : 0;
    const utilisation = supplyAssets > 0 ? borrowAssets / supplyAssets : 0;
    const fee = mk ? Number(mk[5]) / 1e18 : 0;
    const borrowApr = kinkedApr(utilisation);
    const userSupply = mk && pos && mk[1] > 0n ? (Number(pos[0]) / Number(mk[1])) * supplyAssets : 0;
    const userBorrow = mk && pos && mk[3] > 0n ? (Number(pos[1]) / Number(mk[3])) * borrowAssets : 0;
    const hfRaw = r(3) as bigint | undefined;
    return {
      m,
      supplyAssets,
      borrowAssets,
      utilisation,
      borrowApr,
      supplyApr: borrowApr * utilisation * (1 - fee),
      fee,
      user: {
        supplyAssets: userSupply,
        borrowAssets: userBorrow,
        collateral: pos?.[2] ?? 0n,
        ltv: Number((r(2) as bigint | undefined) ?? 0n) / 1e18,
        hf: hfRaw === undefined || hfRaw > 10n ** 30n ? Infinity : Number(hfRaw) / 1e18,
        maxBorrow: Number((r(4) as bigint | undefined) ?? 0n) / 1e6,
        authorized: (r(5) as boolean | undefined) ?? false,
      },
    };
  });
  return { states, refetch, loading: !data };
}

/** Mirrors KinkedIrm defaults: 2% base, 8% at 80% utilisation, 60% at 100%. */
export function kinkedApr(u: number) {
  if (u <= 0.8) return 0.02 + 0.06 * (u / 0.8);
  return 0.08 + 0.52 * ((Math.min(u, 1) - 0.8) / 0.2);
}

export { YEAR };
