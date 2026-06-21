/**
 * v0.52.0 — HA payload formatting helpers shared by the REST `/api/ha-state`
 * handler (index.ts) and the MQTT-discovery `buildState` (mqttDiscovery.ts),
 * which carried BYTE-IDENTICAL copies of each. Bodies are moved VERBATIM so the
 * published HA sensor values are unchanged.
 */

import type { LifetimeTotals } from './recorder.js';
import type { Alert } from './alerts.js';
import type { FleetDegradation } from './analytics.js';

/** Round Wh → kWh to one decimal, null-safe (the SHP2 backup-pool fields). */
export const kwh1 = (wh: number | null | undefined): number | null =>
  wh == null ? null : Math.round(wh / 100) / 10;

/**
 * Lifetime-key → kWh (3-decimal, persisted+pending), null when the key is absent.
 * Preserves the EXACT `lifetime[k] ? ... : null` falsy-entry guard (NOT a
 * `!= null` check) so a missing OR zero/falsy entry maps to null as before.
 */
export function makeLifetimeKwh(
  lifetime: Record<string, LifetimeTotals>,
): (k: string) => number | null {
  return (k: string) =>
    lifetime[k] ? Math.round(((lifetime[k].persistedWh + lifetime[k].pendingWh) / 1000) * 1000) / 1000 : null;
}

/**
 * Alert counter split by engine source × severity. `threshold` matches every
 * non-`learned` source (the `a.source !== 'learned'` branch) — verbatim.
 */
export function makeAlertCounter(
  alerts: Alert[],
): (src: 'threshold' | 'learned', sev: 'critical' | 'warning' | 'info') => number {
  return (src, sev) =>
    alerts.filter(
      (a) => (src === 'learned' ? a.source === 'learned' : a.source !== 'learned') && a.severity === sev,
    ).length;
}

/**
 * The projecting packs and the soonest-EOL pack (fewest years left). Returns
 * both so callers keep `projecting.length` / peer-outlier counts. The reduce
 * uses the `?? 1e9` sentinel so a null `yearsToEol` sorts last — verbatim.
 */
export function soonestProjecting(packs: FleetDegradation['packs']): {
  projecting: FleetDegradation['packs'];
  soonest: FleetDegradation['packs'][number] | null;
} {
  const projecting = packs.filter((p) => p.status === 'projecting');
  type Pack = (typeof projecting)[number];
  const soonest = projecting.reduce<Pack | null>(
    (best, p) => (best == null || (p.yearsToEol ?? 1e9) < (best.yearsToEol ?? 1e9) ? p : best),
    null,
  );
  return { projecting, soonest };
}
