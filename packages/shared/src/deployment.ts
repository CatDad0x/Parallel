import type { Address, Hex } from "viem";
import local from "../deployments/31337.json";

export type Currency = "AUD" | "EUR" | "INR";

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: "stable" | "equity";
  currency: Currency | "USD";
}

export interface FeedInfo {
  name: string; // SPY, AAPL, ..., AUD, EUR, INR
  key: Hex; // OracleHub key
  pythId: Hex;
}

export interface VaultInfo {
  address: Address;
  name: string;
  symbol: string;
  currency: Currency;
  strategy: "index" | "basket";
  hedged: boolean;
}

export interface MarketInfo {
  id: Hex;
  label: string;
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: string; // WAD, decimal string
  maxOpenLtv: string; // WAD, decimal string
}

export interface Deployment {
  chainId: number;
  demoPyth: boolean;
  admin: Address;
  keeper: Address;
  pyth: Address;
  oracleHub: Address;
  exchange: Address;
  hedgeBook: Address;
  /** Mirror hedge (optional: absent in older deployments). */
  hedgeUsdc?: Address;
  gtrade?: Address;
  hedgeVenue?: Address;
  hedgeManager?: Address;
  faucet: Address;
  factory: Address;
  morpho: Address;
  irm: Address;
  router: Address;
  tokens: TokenInfo[];
  feeds: FeedInfo[];
  vaults: VaultInfo[];
  markets: MarketInfo[];
}

/** Known deployments by chain id. Base Sepolia (84532) is added after the first deploy. */
export const deployments: Record<number, Deployment> = {
  31337: local as Deployment,
};

export function getDeployment(chainId: number): Deployment {
  const d = deployments[chainId];
  if (!d) throw new Error(`No Parallel Markets deployment for chain ${chainId}`);
  return d;
}

export const CURRENCIES: { code: Currency; symbol: string; flag: string; stables: string[] }[] = [
  { code: "AUD", symbol: "A$", flag: "🇦🇺", stables: ["mAUDD", "mAUDM", "mAUDC"] },
  { code: "EUR", symbol: "€", flag: "🇪🇺", stables: ["mEURC"] },
  { code: "INR", symbol: "₹", flag: "🇮🇳", stables: ["mINR"] },
];

export function marketParams(m: MarketInfo) {
  return {
    loanToken: m.loanToken,
    collateralToken: m.collateralToken,
    oracle: m.oracle,
    irm: m.irm,
    lltv: BigInt(m.lltv),
  } as const;
}
