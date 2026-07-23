import { readdirSync, readFileSync } from 'node:fs';

/* ═══════════════════════════════════════════════════════════════════════════
 * hostThermal.ts — alarm-host SoC temperature monitor (v1.42.0).
 *
 * The add-on watches the machine it runs on: the host's SoC temperature is
 * read from the kernel thermal zones (`/sys/class/thermal/thermal_zone*&#8203;/temp`,
 * mounted read-only into the container by default) and surfaced as an HA
 * sensor plus warning/critical alerts. Rationale: the Pi 5 throttles at
 * ~85 °C, and the failure coupling is adverse — extreme ambient heat raises
 * host temperature exactly when the off-grid alarm pipeline matters most, so
 * the operator needs an actionable tripwire (airflow/relocation) BEFORE the
 * throttle band.
 *
 * Design:
 *  - Read-only, null-honest: when no thermal zone is readable (non-Linux host,
 *    unusual container runtime), every surface reads null and no alert fires.
 *  - Trend history comes free from Home Assistant's recorder via the MQTT
 *    sensor — no add-on DB schema is involved.
 *  - Alerting uses rise/clear hysteresis (fire ≥ threshold, clear below
 *    threshold − 3 °C) so a reading oscillating on the line cannot churn.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Fire thresholds (°C) with env overrides; clear = fire − HYST. Defaults per
 *  the heat-event review: 78 °C = act-now tripwire, 84 °C = pre-throttle. */
const num = (name: string, dflt: number, lo: number, hi: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
};
export const HOST_TEMP_WARN_C = num('HOST_TEMP_WARN_C', 78, 40, 100);
export const HOST_TEMP_CRIT_C = num('HOST_TEMP_CRIT_C', 84, 40, 110);
export const HOST_TEMP_HYST_C = 3;

/** Freshness bound: a sample older than this reads as unknown (sampler dead). */
export const HOST_TEMP_MAX_AGE_MS = 5 * 60 * 1000;

export interface HostTempSample {
  tempC: number;
  ts: number;
}

let last: HostTempSample | null = null;

/** Read the hottest valid thermal zone, milli-°C → °C. Injectable reader for
 *  tests. Returns null (and leaves the holder untouched) when nothing valid is
 *  readable — null over fabrication. */
export function sampleHostTemp(
  now: number = Date.now(),
  readZones: () => number[] = readSysThermalZones,
): number | null {
  let temps: number[];
  try {
    temps = readZones();
  } catch {
    return null;
  }
  const valid = temps.filter((t) => Number.isFinite(t) && t > 5 && t < 130);
  if (valid.length === 0) return null;
  const tempC = Math.max(...valid);
  last = { tempC, ts: now };
  return tempC;
}

function readSysThermalZones(): number[] {
  const base = '/sys/class/thermal';
  const zones = readdirSync(base).filter((d) => d.startsWith('thermal_zone'));
  return zones.map((z) => {
    try {
      return Number(readFileSync(`${base}/${z}/temp`, 'utf8').trim()) / 1000;
    } catch {
      return NaN;
    }
  });
}

/** The freshest sample, or null when absent/stale. */
export function liveHostTemp(now: number = Date.now()): HostTempSample | null {
  if (!last || now - last.ts > HOST_TEMP_MAX_AGE_MS) return null;
  return last;
}

/** test-only — reset the holder between cases. */
export function _resetHostTempForTest(): void {
  last = null;
}

/** Pure rise/clear hysteresis: `held` is the previous level; returns the new
 *  level. Fires at ≥ threshold; clears only below threshold − HOST_TEMP_HYST_C.
 *  Escalation is immediate; de-escalation steps through the bands. */
export type HostTempLevel = 'ok' | 'warn' | 'crit';
export function hostTempLevel(tempC: number, held: HostTempLevel): HostTempLevel {
  if (tempC >= HOST_TEMP_CRIT_C) return 'crit';
  if (held === 'crit' && tempC >= HOST_TEMP_CRIT_C - HOST_TEMP_HYST_C) return 'crit';
  if (tempC >= HOST_TEMP_WARN_C) return 'warn';
  if (held !== 'ok' && tempC >= HOST_TEMP_WARN_C - HOST_TEMP_HYST_C) return 'warn';
  return 'ok';
}
