import { formatUnits } from "viem";

export const num = (v: bigint | undefined, decimals: number) => (v === undefined ? 0 : Number(formatUnits(v, decimals)));

export function money(value: number, symbol: string, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.5 / 10 ** digits) value = 0; // no "−A$0.00"
  const sign = value < 0 ? "−" : "";
  return `${sign}${symbol}${Math.abs(value).toLocaleString("en-AU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function signedMoney(value: number, symbol: string, digits = 2) {
  const shown = Math.abs(value) < 0.5 / 10 ** digits ? 0 : value;
  return `${shown > 0 ? "+" : ""}${money(shown, symbol, digits)}`;
}

export function pct(value: number, digits = 1, signed = false) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.5 / 10 ** digits) value = 0; // no "−0.0%"
  const s = `${Math.abs(value).toFixed(digits)}%`;
  if (value < 0) return `−${s}`;
  return signed && value > 0 ? `+${s}` : s;
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export const wadPct = (v: bigint | string | undefined) => (v === undefined ? 0 : (Number(BigInt(v)) / 1e18) * 100);
