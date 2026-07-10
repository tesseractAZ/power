/**
 * v0.52.0 — shared math/format helpers extracted VERBATIM from analytics.ts.
 *
 * These were 10 module-private helpers (+ the LinFit return type) used at 200+
 * call-sites throughout analytics.ts. Moved here unchanged — same bodies, same
 * JSDoc — so analytics outputs stay byte-identical; analytics.ts now imports
 * them by their original names (no call-site edits).
 *
 * NOTE: this is intentionally a narrow move of the analytics.ts copies only.
 * The independent copies in alerts.ts / broadcast.ts / ml.ts / telnet/* are a
 * separate, higher-risk dedup and are NOT consolidated here.
 */

export const cToF = (c: number) => c * 1.8 + 32;

/** Extract the Core (DPU) number from a device name like "Core 3". */
export function dpuNum(name: string): number | null {
  const m = name.match(/core\s*(\d+)/i) ?? name.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
/** Capitalize the first letter. */
export function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export function mad(xs: number[], med: number): number {
  return median(xs.map((x) => Math.abs(x - med)));
}

/** The standard modified-z constant (0.6745 = Φ⁻¹(0.75), so MAD ≈ σ for normal data). */
export const MODIFIED_Z_K = 0.6745;

/**
 * v1.1.0 — modified z-score with a VARIANCE FLOOR.
 *
 * `z = 0.6745·|x − med| / MAD` is unbounded as MAD → 0, and real telemetry hits that
 * constantly: any metric that sits on one steady value across its whole comparison
 * window has a near-zero MAD (an AC circuit idling at 135 W overnight). A genuine
 * excursion then scores in the hundreds. Observed live, in an operator-facing HA
 * notification: `z 610.4`.
 *
 * Two things break:
 *   1. The number is meaningless to read.
 *   2. The severity gate COLLAPSES. Once MAD ≈ 0, every deviation past the absolute
 *      floor lands astronomically above Z_WARN, so the z-test stops discriminating and
 *      only `floor` does any work — a bare floor-cross is indistinguishable from a 10×
 *      excursion, and both emit a warning.
 *
 * Callers already declare the smallest deviation worth flagging (`floor`). We floor MAD
 * at the value that makes a deviation of exactly `floor`, with zero observed variance,
 * score exactly `zAtFloor`. That turns the previous ad-hoc `MAD === 0 → constant`
 * fallbacks into the continuous limit of one rule, and keeps z interpretable: under
 * degenerate variance `z === zAtFloor · (absDev / floor)` — literally "how many floors
 * from typical". When the data has real scatter (MAD above that floor) the true modified
 * z-score is returned unchanged, so well-behaved metrics are unaffected.
 */
export function robustZ(value: number, med: number, madValue: number, floor: number, zAtFloor: number): number {
  const absDev = Math.abs(value - med);
  if (!(floor > 0) || !(zAtFloor > 0)) {
    // No usable floor — fall back to the raw statistic, guarding the MAD===0 singularity.
    return madValue > 0 ? Math.abs((MODIFIED_Z_K * absDev) / madValue) : zAtFloor;
  }
  const madFloor = (MODIFIED_Z_K * floor) / zAtFloor;
  return Math.abs((MODIFIED_Z_K * absDev) / Math.max(madValue, madFloor));
}

export interface LinFit {
  slopePerMs: number;
  intercept: number;        // fitted y at x = pts[0].ts
  r2: number;
  n: number;
  slopeStdErrPerMs: number; // standard error of the slope — drives projection confidence bands
}

/** Ordinary least-squares fit; x is ms epoch (normalized internally). */
export function linregress(pts: Array<{ ts: number; value: number }>): LinFit | null {
  const n = pts.length;
  if (n < 8) return null;
  const x0 = pts[0].ts;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const x = p.ts - x0;
    const y = p.value;
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  const sxxCentered = sxx - (sx * sx) / n;
  const r2 = ssTot > 0 ? Math.min(1, (slope * slope * sxxCentered) / ssTot) : 0;
  // Standard error of the slope: √( residual variance ÷ Sxx ). A noisy or thin
  // trend yields a large SE — which the EOL projection turns into a wide range
  // rather than a falsely-precise date.
  const ssRes = Math.max(0, ssTot - slope * slope * sxxCentered);
  const slopeStdErrPerMs =
    n > 2 && sxxCentered > 0 ? Math.sqrt(ssRes / (n - 2) / sxxCentered) : 0;
  return { slopePerMs: slope, intercept, r2, n, slopeStdErrPerMs };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const round1 = (x: number) => Math.round(x * 10) / 10;
export const round2 = (x: number) => Math.round(x * 100) / 100;

/** Clamp x into [0, 1]. */
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
