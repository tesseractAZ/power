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
