/**
 * v1.69.0 — server-clock offset, so a wrong local clock cannot blind the alarm.
 *
 * EcoFlow signs every request with `timestamp=<local ms>`. On 2026-08-04 the house
 * was powered down to reset the SHP2; the Pi has no battery-backed RTC and DNS was
 * still coming up, so systemd-timesyncd could not sync and the clock sat 170 s behind.
 * Every poll came back `8521: signature is wrong` and the add-on held ZERO telemetry
 * for 22 minutes while /api/health said ok. It recovered only when NTP caught up.
 *
 * Restarting the client does NOT fix this — the signature is computed fresh per
 * request from the same wrong clock, so a rebuild re-signs identically and fails
 * identically. The fix has to be to stop trusting the local clock for signing.
 *
 * Every HTTP response carries a `Date` header, and critically that includes the 8521
 * REJECTION itself. So the very first rejected request tells us exactly how far off we
 * are, and the next request can sign against corrected time — recovery within one poll
 * cycle instead of waiting on NTP.
 *
 * Deliberate constraints:
 *  - This offset is used ONLY for request signing. It never touches recorder
 *    timestamps, alert onsets, night-charge windows or anything the operator sees;
 *    those must stay on the system clock or history would silently shift under them.
 *  - Bounded. An absurd delta means a broken/proxied header, not a skewed Pi, and
 *    adopting it would break signing that currently works.
 *  - Deadband. Sub-threshold jitter is normal network latency, not skew; adopting it
 *    would rewrite the offset on every request for no benefit.
 */

/** Ignore deltas below this — that is round-trip latency, not clock skew. */
export const OFFSET_DEADBAND_MS = 2_000;
/** Refuse deltas beyond this — a header that far out is not credible. */
export const OFFSET_SANITY_LIMIT_MS = 24 * 60 * 60 * 1000;

let offsetMs = 0;
let adoptedAtMs: number | null = null;

export interface OffsetUpdate {
  /** True when this response changed the offset we sign with. */
  adopted: boolean;
  /** The offset now in force (ms to ADD to the local clock). */
  offsetMs: number;
  /** The raw measured delta for this response, null when unusable. */
  measuredMs: number | null;
  /** Why a measurement was rejected, for the log. */
  rejected: 'no-header' | 'unparseable' | 'implausible' | 'within-deadband' | null;
}

/**
 * Feed the `Date` header from any EcoFlow response. Pure w.r.t. its inputs — the
 * local time is injected so this unit-tests without a clock.
 */
export function noteServerDate(header: string | null | undefined, localNowMs: number): OffsetUpdate {
  if (!header) return { adopted: false, offsetMs, measuredMs: null, rejected: 'no-header' };
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) {
    return { adopted: false, offsetMs, measuredMs: null, rejected: 'unparseable' };
  }
  // The header is the moment the server generated the response, so it trails our
  // send by roughly half the round trip. At the scale that matters here (seconds to
  // minutes of skew) that bias is negligible, and the deadband absorbs it.
  const measured = serverMs - localNowMs;
  if (Math.abs(measured) > OFFSET_SANITY_LIMIT_MS) {
    return { adopted: false, offsetMs, measuredMs: measured, rejected: 'implausible' };
  }
  if (Math.abs(measured - offsetMs) < OFFSET_DEADBAND_MS) {
    return { adopted: false, offsetMs, measuredMs: measured, rejected: 'within-deadband' };
  }
  offsetMs = measured;
  adoptedAtMs = localNowMs;
  return { adopted: true, offsetMs, measuredMs: measured, rejected: null };
}

/** The timestamp to SIGN with. Never use this for anything the operator sees. */
export function signingNowMs(localNowMs: number = Date.now()): number {
  return localNowMs + offsetMs;
}

export function currentOffsetMs(): number {
  return offsetMs;
}
export function offsetAdoptedAtMs(): number | null {
  return adoptedAtMs;
}
/** Test seam. */
export function resetClockOffset(): void {
  offsetMs = 0;
  adoptedAtMs = null;
}
