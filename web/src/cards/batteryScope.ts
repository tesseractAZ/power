/**
 * v1.182.0 — Battery-page figures scoped to HOME packs (a Core wired to the panel), not every
 * pack the add-on can see. "Fleet capacity" summed all 24 packs — 147 kWh with 9 of them on bench
 * spares that cannot power the house — the near-new SoH range was set by bench packs, and bench
 * packs dominated the charge-curve drift and thermal top-8 lists. `home` comes from the server
 * (tagHomePacks); a payload from an older server has none, and then every pack counts as before.
 * Pure (run by server/test/batteryScope.test.ts).
 */

export interface ScopedPack { home?: boolean }

export function homePacks<T extends ScopedPack>(packs: T[]): { home: T[]; benchCount: number } {
  const home = packs.filter((p) => p.home !== false);
  return { home, benchCount: packs.length - home.length };
}

/** "N bench pack(s) excluded", or null when there are none. */
export function benchNote(benchCount: number): string | null {
  return benchCount > 0 ? `${benchCount} bench pack${benchCount === 1 ? '' : 's'} excluded` : null;
}
