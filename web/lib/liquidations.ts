"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { deployment, DEPLOY_BLOCK } from "./config";

const liquidate = parseAbiItem(
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
);

export interface Liquidation {
  block: bigint;
  repaid: number; // loan currency repaid
  marketId: string;
}

const key = (a: string) => `pm-liq-seen-${a.toLowerCase()}`;

/** The user's most recent liquidation (last ~60k blocks) that they have not dismissed yet. */
export function useLiquidation() {
  const { address } = useAccount();
  const client = usePublicClient();
  const [last, setLast] = useState<Liquidation>();
  const [seen, setSeen] = useState<bigint>(0n);

  useEffect(() => {
    if (!address) return;
    try {
      setSeen(BigInt(localStorage.getItem(key(address)) ?? "0"));
    } catch {}
  }, [address]);

  useEffect(() => {
    if (!client || !address) return;
    let dead = false;
    (async () => {
      const latest = await client.getBlockNumber();
      const start = (latest > 60_000n ? latest - 60_000n : 0n) > DEPLOY_BLOCK ? (latest > 60_000n ? latest - 60_000n : 0n) : DEPLOY_BLOCK;
      // Newest first. If an RPC refuses a range (a cap, or a local fork crossing its fork point), split it and try each half.
      const scan = async (from: bigint, to: bigint): Promise<Liquidation | undefined> => {
        try {
          const logs = await client.getLogs({ address: deployment.morpho, event: liquidate, args: { borrower: address }, fromBlock: from, toBlock: to });
          const l = logs[logs.length - 1];
          return l ? { block: l.blockNumber, repaid: Number(l.args.repaidAssets) / 1e6, marketId: l.args.id as string } : undefined;
        } catch {
          if (to - from < 100n) return undefined;
          const mid = (from + to) / 2n;
          return (await scan(mid + 1n, to)) ?? (await scan(from, mid));
        }
      };
      let found: Liquidation | undefined;
      for (let to = latest; to >= start && !found; to -= 9_000n) found = await scan(to - 8_999n < start ? start : to - 8_999n, to);
      if (!dead) setLast(found);
    })().catch(() => {});
    return () => { dead = true; };
  }, [client, address]);

  const dismiss = useCallback(() => {
    if (!address || !last) return;
    setSeen(last.block);
    try { localStorage.setItem(key(address), last.block.toString()); } catch {}
  }, [address, last]);

  return { liquidation: last && last.block > seen ? last : undefined, dismiss };
}
