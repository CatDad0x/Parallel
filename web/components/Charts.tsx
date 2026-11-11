/** Small SVG charts for the panel layout (no chart library, so they stay crisp and light). */

export interface Pt {
  t: number;
  v: number;
}

function scale(pts: Pt[], w: number, h: number, pad: number, lo?: number, hi?: number) {
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const vs = pts.map((p) => p.v);
  const min = lo ?? Math.min(...vs);
  const max = hi ?? Math.max(...vs);
  const sp = max - min || 1;
  const ts = t1 - t0 || 1;
  return pts.map((p) => [((p.t - t0) / ts) * w, h - pad - ((p.v - min) / sp) * (h - pad * 2)] as const);
}

export function pathOf(pts: Pt[], w: number, h: number, pad = 0, lo?: number, hi?: number) {
  return scale(pts, w, h, pad, lo, hi)
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
}

/** Tiny trend line for table rows. */
export function Spark({ pts, width = 90, height = 26 }: { pts: Pt[]; width?: number; height?: number }) {
  if (pts.length < 2) return <span style={{ display: "inline-block", width }} />;
  const up = pts[pts.length - 1].v >= pts[0].v;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} style={{ width, height, display: "block" }}>
      <path d={pathOf(pts, width, height, 3)} fill="none" stroke={up ? "var(--pm-accent)" : "var(--pm-red)"} strokeWidth="1.4" />
    </svg>
  );
}

const fmtTime = (t: number, span: number) =>
  span > 2 * 86_400_000
    ? new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short" })
    : new Date(t).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });

/**
 * Line chart with a right-hand axis. `series[0]` is drawn solid with a soft fill and an end dot;
 * further series are drawn dashed grey (used for "without protection").
 */
export function PanelChart({
  series,
  height = 214,
  label,
  axis,
}: {
  series: Pt[][];
  height?: number;
  label: string;
  axis: (v: number) => string;
}) {
  const main = series[0];
  const all = series.flat();
  const lo = Math.min(...all.map((p) => p.v));
  const hi = Math.max(...all.map((p) => p.v));
  const pad = 12;
  const W = 600;
  const H = 200;
  const line = pathOf(main, W, H, pad, lo, hi);
  const last = scale(main, W, H, pad, lo, hi).pop()!;
  const ticks = [0, 1, 2, 3].map((i) => hi - ((hi - lo) * i) / 3);
  const span = main[main.length - 1].t - main[0].t;
  const xt = [0, 1, 2, 3, 4].map((i) => main[0].t + (span * i) / 4);
  return (
    <div style={{ position: "relative", padding: "10px 60px 6px 10px" }}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
        {[50, 100, 150].map((y) => (
          <line key={y} x1="0" y1={y} x2={W} y2={y} stroke="var(--pm-line2)" strokeDasharray="3 4" />
        ))}
        {series.slice(1).map((s, i) => (
          <path key={i} d={pathOf(s, W, H, pad, lo, hi)} fill="none" stroke="#9aa5b1" strokeWidth="1.4" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={`${line} L${W},${H} L0,${H} Z`} fill="var(--pm-accent)" opacity="0.07" />
        <path d={line} fill="none" stroke="var(--pm-accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--pm-accent)",
          boxShadow: "0 0 0 3px color-mix(in srgb, var(--pm-accent) 18%, transparent)",
          right: 57,
          top: `calc(10px + ${((last[1] / H) * height).toFixed(0)}px - 3px)`,
        }}
      />
      <div aria-hidden="true" style={{ position: "absolute", top: 10, right: 8, height, display: "flex", flexDirection: "column", justifyContent: "space-between", fontSize: 10, color: "var(--pm-faint)", fontFeatureSettings: '"tnum" 1' }}>
        {ticks.map((v, i) => (
          <span key={i}>{axis(v)}</span>
        ))}
      </div>
      <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", paddingTop: 4, fontSize: 10, color: "var(--pm-faint)" }}>
        {xt.map((t, i) => (
          <span key={i}>{fmtTime(t, span)}</span>
        ))}
      </div>
    </div>
  );
}

/** Keep only points inside the last `ms` milliseconds (all points when ms is 0). */
export function within(pts: Pt[], ms: number) {
  if (!ms || pts.length < 2) return pts;
  const cut = pts[pts.length - 1].t - ms;
  const out = pts.filter((p) => p.t >= cut);
  return out.length >= 2 ? out : pts.slice(-2);
}
