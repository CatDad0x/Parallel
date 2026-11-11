import type { NavPoint } from "./hooks";
import type { PositionRow } from "./positions";
import type { Pt } from "@/components/Charts";

/**
 * What the user's current holdings were worth over time: today's shares at each past share price,
 * converted to the home currency at today's rate. An approximation, labelled as such in the UI.
 */
export function holdingsSeries(rows: PositionRow[], hist: Record<string, NavPoint[]>, toHome: (v: number, from: string) => number): Pt[] {
  const per = rows
    .map((r) => ({ r, pts: hist[r.s.info.address.toLowerCase()] ?? [] }))
    .filter((x) => x.pts.length > 0);
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
      if (p.t > t) {
        ok = false;
        return;
      }
      v += toHome(x.r.shares * p.navPerShare, x.r.s.info.currency);
    });
    if (ok && Number.isFinite(v)) out.push({ t, v });
  }
  return out;
}

/** Share price history as % change from the first point. */
export function pctSeries(pts: NavPoint[]): Pt[] {
  if (pts.length < 2) return [];
  const base = pts[0].navPerShare;
  return pts.map((p) => ({ t: p.t, v: (p.navPerShare / base - 1) * 100 }));
}

export function navSeries(pts: NavPoint[]): Pt[] {
  return pts.map((p) => ({ t: p.t, v: p.navPerShare }));
}
