/**
 * v1.190.1 — the Smart Home Panel card's charge-limit and backup-timer wording. Pure (run by
 * server/test/shp2ChargeLabel.test.ts).
 *
 * `chargeWattPower` is the panel's configured AC charge-rate LIMIT for EACH connected battery
 * (the Delta Pro Ultra's AC input ceiling, 7,200 W; it equals every source slot's `ratePower` and
 * the charge time-task's `chargeWatts`), not a live power and not the pool's. Measured on the
 * night of 2026-10-13/14: each Core's own `ac_in` pinned at ~7.2 kW (7,223 / 6,033 / 7,218 W), the
 * three together took 18.1 kW and the panel's main read 19,253 W. The card had labelled the field
 * "Charge power 7.20 kW", which read as the rate the whole pool charges at.
 */
import type { Shp2EnergySource } from '../types';
import { fmtMins, fmtW } from '../format';

export const CHARGE_LIMIT_LABEL = 'Charge limit (per battery)';

export interface ChargeLimitView {
  label: string;
  /** The per-battery limit, fmtW ("7.20 kW"), or "—" when the panel does not report it. */
  value: string;
  /** The fleet envelope, "× 3 connected = 21.60 kW", or null without a limit or a connected slot. */
  envelope: string | null;
  /** The tooltip: what the figure is and is not. */
  title: string;
}

/** The connected source slots: the same rule as shp2ConnectedDpuSns (`isConnected && sn`). */
export function connectedSlotCount(sources: ReadonlyArray<Pick<Shp2EnergySource, 'isConnected' | 'sn'>> | null | undefined): number {
  let n = 0;
  for (const s of sources ?? []) if (s.isConnected && s.sn) n++;
  return n;
}

export function chargeLimitView(limitW: number | null | undefined, connectedSlots: number): ChargeLimitView {
  const known = limitW != null && Number.isFinite(limitW);
  const slots = Number.isInteger(connectedSlots) && connectedSlots > 0 ? connectedSlots : 0;
  const envelope = known && slots > 0 ? `× ${slots} connected = ${fmtW(limitW * slots)}` : null;
  const title = known
    ? `The panel's configured AC charge-rate limit for each connected battery (chargeWattPower), not live charge power.` +
      (slots > 0 ? ` ${slots} connected ${slots === 1 ? 'battery' : 'batteries'} can take up to ${fmtW(limitW * slots)} together.` : '')
    : 'The panel has not reported its per-battery charge-rate limit.';
  return { label: CHARGE_LIMIT_LABEL, value: known ? fmtW(limitW) : '—', envelope, title };
}

/**
 * The panel reports both backup timers regardless of direction. The server's `backupTimers`
 * verdict (shp2Membership.ts backupTimerGate, the gate /api/ha-state publishes
 * backup_charge_minutes / backup_discharge_minutes through) says which applies; without it the
 * timer is not shown. `chargeWattPower` is a configured limit and says nothing about direction:
 * the card had gated the charge time on it and showed "38 min" to full during a drain.
 */
export function backupTimerText(
  minutes: number | null | undefined,
  applicable: boolean | undefined,
): string {
  return applicable === true ? fmtMins(minutes) : '—';
}
