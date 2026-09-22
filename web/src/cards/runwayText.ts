import type { RunwayProjection } from '../types';

/**
 * v1.177.0 — the Runway card's wording, as pure functions of the projection, so the server
 * suite runs them (server/test/runwayCardText.test.ts) the same way it runs the Energy flow
 * model. The card only lays these strings out.
 */

/**
 * v1.177.0 — the label under "reserve holds N h". It used to read "forecast PV keeps up with
 * load" whenever the reserve floor was not crossed, which is a different claim: live, the
 * pool was projected to fall 78 → 26 kWh inside the same 24 h, PV covering 57% of the load.
 * Only a pool that never falls below where it is now is being kept up with.
 */
export function holdsLabel(r: Pick<RunwayProjection, 'troughKwh' | 'troughAtMs' | 'backupRemainingKwh' | 'backupReserveKwh'>): string {
  if (r.troughKwh == null || r.backupRemainingKwh == null) return 'the reserve floor is not reached within the projection horizon';
  if (r.troughKwh >= r.backupRemainingKwh - 0.05) return 'forecast PV keeps up with the load — the pool does not fall below its current level';
  const above = r.backupReserveKwh != null ? `, ${(r.troughKwh - r.backupReserveKwh).toFixed(1)} kWh above the reserve floor` : '';
  return `lowest ≈ ${r.troughKwh.toFixed(1)} kWh${r.troughAtMs != null ? ` around ${fmtClock(r.troughAtMs)}` : ''}${above}`;
}

/** v1.177.0 — a trough within 15% of full above the reserve floor is shown amber, not green:
 *  the floor holds, but only just, and a heavier evening than modelled would cross it. */
export const TROUGH_TIGHT_FRAC = 0.15;
export function troughTight(r: Pick<RunwayProjection, 'troughKwh' | 'backupReserveKwh' | 'backupFullKwh'>): boolean {
  if (r.troughKwh == null || r.backupReserveKwh == null || r.backupFullKwh == null || r.backupFullKwh <= 0) return false;
  return r.troughKwh - r.backupReserveKwh < TROUGH_TIGHT_FRAC * r.backupFullKwh;
}

/** v1.177.0 — caption the recent load by what it actually is. Every fallback used to be
 *  labelled "1-hour average", including an instantaneous reading and a value carried
 *  forward from an earlier compute. */
export function recentLoadCaption(basis: RunwayProjection['recentLoadBasis']): string {
  switch (basis) {
    case 'live': return 'live reading';
    case 'single-sample': return 'one recent reading';
    case 'carried': return 'last known — panel quiet';
    default: return '1-hour average';
  }
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${wd} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
