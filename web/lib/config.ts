import { http, type Transport } from "wagmi";
import type { Chain } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import { getDeployment } from "@parallel/shared";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "31337");
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === 84532 ? "https://sepolia.base.org" : "http://127.0.0.1:8545");
const base: Chain = CHAIN_ID === 84532 ? baseSepolia : foundry;
/** The chain definition always points at the configured RPC (the local test wallet sends transactions to the chain's default URL, which matters on a fork). */
export const chain: Chain = { ...base, rpcUrls: { default: { http: [RPC_URL] } } };
export const transports: Record<number, Transport> = { [chain.id]: http(RPC_URL) };
export const deployment = getDeployment(CHAIN_ID);
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const KEEPER_URL = process.env.NEXT_PUBLIC_KEEPER_URL ?? "";
export const IS_LOCAL = CHAIN_ID === 31337;
/** Local test accounts: always on for the local chain, and opt-in (rehearsals on a fork) with NEXT_PUBLIC_MOCK_WALLET=1. */
export const USE_MOCK_WALLET = IS_LOCAL || process.env.NEXT_PUBLIC_MOCK_WALLET === "1";
