/**
 * v1.182.0 — Battery-page figures scoped to HOME packs (a Core wired to the panel), not every
 * pack the add-on can see. "Fleet capacity" summed all 24 packs — 147 kWh with 9 of them on bench
 * spares that cannot power the house — the near-new SoH range was set by bench packs, and bench
 * packs dominated the charge-curve drift and thermal top-8 lists. `home` comes from the server
 * (tagHomePacks); a payload from an older server has none, and then every pack counts as before.
 * Pure (run by server/test/dashboardAuditFour.test.ts).
 */

export interface ScopedPack { home?: boolean }

export function homePacks<T extends ScopedPack>(packs: T[]): { home: T[]; benchCount: number } {
  const home = packs.filter((p) => p.home !== false);
  return { home, benchCount: packs.length - home.length };
}

/** "N bench pack(s) excluded", or null when there are none. v1.191.0 — `offPanelCount` of them are
 *  on a Core the server says is not a spare but is on no panel (plan 3.8 S3): "… not on a panel". */
export function benchNote(benchCount: number, offPanelCount = 0): string | null {
  const off = Math.min(Math.max(0, offPanelCount), benchCount);
  const bench = benchCount - off;
  const parts: string[] = [];
  if (bench > 0) parts.push(`${bench} bench pack${bench === 1 ? '' : 's'}`);
  if (off > 0) parts.push(`${off} pack${off === 1 ? '' : 's'} not on a panel`);
  return parts.length > 0 ? `${parts.join(' and ')} excluded` : null;
}

/**
 * v1.191.0 (plan 3.8 S3) — of the packs left out (`home === false`), how many sit on a DPU the server
 * says is not a bench spare (GET /api/site `perDpu`, sent only while BENCH_SPARE_SNS is set). With no
 * flag, none: every excluded pack stays a bench pack, as before.
 */
export function offPanelPackCount<T extends ScopedPack & { sn: string }>(packs: T[], benchSpare: (sn: string) => boolean | undefined): number {
  return packs.filter((p) => p.home === false && benchSpare(p.sn) === false).length;
}
