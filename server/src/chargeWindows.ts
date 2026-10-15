/**
 * chargeWindows.ts — where a charge leg sits against the tariff's on-peak period. PURE.
 *
 * A supervised charge leg raises the panel's backup reserve and, in cost mode, switches its
 * force-charge on. Either one left standing into the on-peak period buys grid power at the
 * day's highest rate: the panel holds the raised reserve as its floor and refills to it from
 * the grid. The leg therefore carries the start of the on-peak period that follows its window
 * (`nextOnPeakStartMs`, stamped when the leg is armed), and every raise stops, and every
 * restore falls due, an hour before it (nightChargeActuator.ts `writeWindowEndMs`).
 *
 * The overnight window (23:00–05:00) ends eleven hours before the next 16:00 on-peak, so for
 * it the stamp changes nothing on a night that goes to plan. It bounds the failure paths: a
 * restore that does not take, a force-charge OFF that cannot be confirmed, a readback that
 * goes dark.
 */
import { rateAt, type TariffModel } from './tariff.js';

const HOUR_MS = 3_600_000;

/** How far ahead the on-peak scan looks: a weekend plus the longest run of R-EV holidays
 *  (Christmas Eve and Christmas Day on a Thursday and Friday put the next on-peak period
 *  about five days out) fits inside eight days. */
export const ON_PEAK_SCAN_HOURS = 8 * 24;

/**
 * The start of the first on-peak period at or after `fromMs` under `model`, or null when the
 * model has none within `scanHours` (a flat tariff has no on-peak period at all). An instant
 * already inside an on-peak period returns the start of that period (at most 24 h back), so a
 * leg armed inside one is guarded from the start. The tariff's periods are whole local hours,
 * so the scan steps hour by hour, as the cheap-window resolver does (resolveCheapWindow).
 */
export function nextOnPeakStartMs(model: TariffModel, fromMs: number, scanHours = ON_PEAK_SCAN_HOURS): number | null {
  if (!Number.isFinite(fromMs)) return null;
  const onPeak = (t: number): boolean => rateAt(model, t).isOnPeak;
  const h0 = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  if (onPeak(h0)) {
    let start = h0;
    for (let i = 1; i <= 24 && onPeak(h0 - i * HOUR_MS); i++) start = h0 - i * HOUR_MS;
    return start;
  }
  for (let i = 1; i <= scanHours; i++) {
    const t = h0 + i * HOUR_MS;
    if (onPeak(t)) return t;
  }
  return null;
}
