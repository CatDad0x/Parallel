"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract, useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { parseAbiItem, type Address, type Abi } from "viem";
import { vaultAbi, oracleHubAbi, tokenAbi, type VaultInfo } from "@parallel/shared";
import { deployment } from "./config";

export function useMarketOpen() {
  const { data } = useReadContract({ address: deployment.oracleHub, abi: oracleHubAbi, functionName: "isMarketOpen" });
  const { data: mode } = useReadContract({ address: deployment.oracleHub, abi: oracleHubAbi, functionName: "marketMode" });
  return { open: data as boolean | undefined, mode: mode as number | undefined };
}

export function useFx() {
  const keys = ["AUD", "EUR", "INR"] as const;
  const { data } = useReadContracts({
    contracts: keys.map((k) => ({
      address: deployment.oracleHub,
      abi: oracleHubAbi,
      functionName: "priceStatus",
      args: [deployment.feeds.find((f) => f.name === k)!.key],
    })),
  });
  const out: Record<string, { usdPerLocal: number; overridden: boolean }> = {};
  keys.forEach((k, i) => {
    const r = data?.[i]?.result as readonly [bigint, bigint, boolean, boolean] | undefined;
    if (r) out[k] = { usdPerLocal: Number(r[0]) / 1e18, overridden: r[3] };
  });
  return out;
}

export function useEquityPrices() {
  const eqFeeds = deployment.feeds.filter((f) => !["AUD", "EUR", "INR"].includes(f.name));
  const { data } = useReadContracts({
    contracts: eqFeeds.map((f) => ({
      address: deployment.oracleHub,
      abi: oracleHubAbi,
      functionName: "priceStatus",
      args: [f.key],
    })),
  });
  return eqFeeds.map((f, i) => {
    const r = data?.[i]?.result as readonly [bigint, bigint, boolean, boolean] | undefined;
    return { name: f.name, key: f.key, usd: r ? Number(r[0]) / 1e18 : undefined, overridden: r?.[3] ?? false };
  });
}

export interface VaultStats {
  info: VaultInfo;
  nav: number;
  navPerShare: number;
  equityValue: number;
  cash: number;
  hedgeMtm: number;
  supply: number;
  userShares: bigint;
  userValue: number;
}

const VAULT_FIELDS = ["totalAssets", "navPerShare", "equityValue", "cash", "hedgeMtm", "totalSupply"] as const;

export function useVaultStats(vaults: VaultInfo[]) {
  const { address } = useAccount();
  const { data, refetch } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: vaults.flatMap((v): any[] => [
      ...VAULT_FIELDS.map((fn) => ({ address: v.address, abi: vaultAbi, functionName: fn })),
      {
        address: v.address,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [address ?? "0x0000000000000000000000000000000000000000"],
      },
    ]),
  });
  const per = VAULT_FIELDS.length + 1;
  const stats: VaultStats[] = vaults.map((info, i) => {
    const r = (j: number) => data?.[i * per + j]?.result as bigint | undefined;
    const n = (v: bigint | undefined, dec = 6) => (v === undefined ? NaN : Number(v) / 10 ** dec);
    const navPerShare = n(r(1));
    const userShares = r(6) ?? 0n;
    return {
      info,
      nav: n(r(0)),
      navPerShare,
      equityValue: n(r(2)),
      cash: n(r(3)),
      hedgeMtm: n(r(4)),
      supply: n(r(5), 18),
      userShares,
      userValue: (Number(userShares) / 1e18) * navPerShare,
    };
  });
  return { stats, loading: !data, refetch };
}

export function useBalances(tokens: Address[]) {
  const { address } = useAccount();
  const { data, refetch } = useReadContracts({
    contracts: tokens.map((t) => ({ address: t, abi: tokenAbi, functionName: "balanceOf", args: [address!] })),
    query: { enabled: !!address },
  });
  return { balances: tokens.map((_, i) => (data?.[i]?.result as bigint | undefined) ?? 0n), refetch };
}

const navEvent = parseAbiItem(
  "event NavSnapshot(uint256 nav, uint256 navPerShare, uint256 equityValue, int256 hedgeMtm, uint256 cash, uint256 usdPerLocal, uint256 timestamp)",
);

export interface NavPoint {
  t: number;
  navPerShare: number;
  usdPerLocal: number;
  hedgeMtm: number;
  equityValue: number;
}

/** NAV history from onchain NavSnapshot events (last ~40k blocks, chunked for public RPC limits). */
export function useNavHistory(vault?: Address) {
  const client = usePublicClient();
  const [points, setPoints] = useState<NavPoint[]>([]);
  useEffect(() => {
    if (!client || !vault) return;
    let cancelled = false;
    (async () => {
      const latest = await client.getBlockNumber();
      const span = 40_000n;
      const start = latest > span ? latest - span : 0n;
      const all: NavPoint[] = [];
      for (let from = start; from <= latest; from += 9_000n) {
        const to = from + 8_999n > latest ? latest : from + 8_999n;
        const logs = await client.getLogs({ address: vault, event: navEvent, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const a = l.args;
          all.push({
            t: Number(a.timestamp) * 1000,
            navPerShare: Number(a.navPerShare) / 1e6,
            usdPerLocal: Number(a.usdPerLocal) / 1e18,
            hedgeMtm: Number(a.hedgeMtm) / 1e6,
            equityValue: Number(a.equityValue) / 1e6,
          });
        }
      }
      if (!cancelled) setPoints(all);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, vault]);
  return points;
}

export interface Step {
  label: string;
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  skip?: boolean;
}

/** Runs a sequence of contract writes (e.g. approve, then deposit), waiting for each receipt. */
export function useSteps() {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<{ running: boolean; label?: string; error?: string; done?: string }>({
    running: false,
  });
  const run = async (steps: Step[], doneMessage: string) => {
    setState({ running: true });
    try {
      for (const s of steps.filter((x) => !x.skip)) {
        setState({ running: true, label: s.label });
        const hash = await writeContractAsync({
          address: s.address,
          abi: s.abi as Abi,
          functionName: s.functionName,
          args: s.args as unknown[],
        });
        const r = await waitForTransactionReceipt(config, { hash });
        if (r.status !== "success") throw new Error(`${s.label} failed onchain`);
      }
      setState({ running: false, done: doneMessage });
      return true;
    } catch (e) {
      setState({ running: false, error: readableError(e) });
      return false;
    }
  };
  return { ...state, run, reset: () => setState({ running: false }) };
}

export function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const known: [RegExp, string][] = [
    [/User rejected|denied/i, "You cancelled the transaction in your wallet."],
    [/MarketClosed/, "US markets are closed. Queue the request instead, or try again at the next open."],
    [/OpeningLtvExceeded/, "That borrow is above the opening limit for this market. Borrow less or add collateral."],
    [/BorrowingDisabled/, "Borrowing through Parallel Markets is not enabled for this market."],
    [/CoolingDown/, "Test funds were already claimed in the last 24 hours."],
    [/StalePrice/, "Prices are updating. Try again in a minute."],
    [/insufficient|exceeds balance|InsufficientBalance/i, "Your balance is too low for this amount."],
    [/Slippage/, "The price moved past your limit. Try again."],
  ];
  for (const [re, text] of known) if (re.test(msg)) return text;
  return msg.split("\n")[0].slice(0, 160);
}

export function useMemoVaults(currency: string) {
  return useMemo(() => deployment.vaults.filter((v) => v.currency === currency), [currency]);
}
