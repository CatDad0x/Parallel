import type { PublicClient } from "viem";

/**
 * getLogs over [from, to]. Some RPCs cap the block range (and a local fork refuses ranges that
 * cross its fork point), so a refused range is split in half and each half tried, newest first.
 */
export async function getLogsSplit<T>(client: PublicClient, params: Record<string, unknown>, from: bigint, to: bigint): Promise<T[]> {
  try {
    return (await client.getLogs({ ...(params as object), fromBlock: from, toBlock: to } as never)) as T[];
  } catch {
    if (to - from < 100n) return [];
    const mid = (from + to) / 2n;
    return [...(await getLogsSplit<T>(client, params, mid + 1n, to)), ...(await getLogsSplit<T>(client, params, from, mid))];
  }
}
