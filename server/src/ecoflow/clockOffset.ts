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
/** v1.81.0 — RTT gate: a sample from a slow request is latency, not clock.
 *  Adoptions in the 08-05 audit coincided with 4.7s/3.8s polls against a ~0.5s
 *  baseline (the ±3s adopt-then-revise sawtooth); a 15.6s poll after the 08-15
 *  reboot inflated one adoption by ~half its RTT. Once >= RTT_MEDIAN_MIN_SAMPLES
 *  are seen, reject samples whose RTT exceeds max(2x median, RTT_GATE_FLOOR_MS);
 *  before that, only an absolute ceiling applies (never block the 8521-recovery
 *  path, whose rejections arrive at normal RTT). */
export const RTT_GATE_FLOOR_MS = 3_000;
export const RTT_GATE_COLD_MS = 8_000;
export const RTT_MEDIAN_MIN_SAMPLES = 5;
const RTT_WINDOW = 15;
/** Refuse deltas beyond this — a header that far out is not credible. */
export const OFFSET_SANITY_LIMIT_MS = 24 * 60 * 60 * 1000;

let offsetMs = 0;
let adoptedAtMs: number | null = null;
let rttWindow: number[] = [];


function rttMedian(): number | null {
  if (rttWindow.length < RTT_MEDIAN_MIN_SAMPLES) return null;
  const sorted = [...rttWindow].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface OffsetUpdate {
  /** True when this response changed the offset we sign with. */
  adopted: boolean;
  /** The offset now in force (ms to ADD to the local clock). */
  offsetMs: number;
  /** The raw measured delta for this response, null when unusable. */
  measuredMs: number | null;
  /** Why a measurement was rejected, for the log. */
  rejected: 'no-header' | 'unparseable' | 'implausible' | 'within-deadband' | 'rtt-inflated' | null;
}

/**
 * Feed the `Date` header from any EcoFlow response. Pure w.r.t. its inputs — the
 * local time is injected so this unit-tests without a clock.
 */
export function noteServerDate(header: string | null | undefined, localNowMs: number, rttMs?: number): OffsetUpdate {
  if (!header) return { adopted: false, offsetMs, measuredMs: null, rejected: 'no-header' };
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) {
    return { adopted: false, offsetMs, measuredMs: null, rejected: 'unparseable' };
  }
  // v1.81.0 — RTT gate BEFORE the window learns from this sample: a
  // latency-inflated response must neither adopt nor drag the median up.
  if (rttMs != null && Number.isFinite(rttMs) && rttMs >= 0) {
    const med = rttMedian();
    const gate = med == null ? RTT_GATE_COLD_MS : Math.max(2 * med, RTT_GATE_FLOOR_MS);
    if (rttMs > gate) {
      return { adopted: false, offsetMs, measuredMs: null, rejected: 'rtt-inflated' };
    }
    rttWindow.push(rttMs);
    if (rttWindow.length > RTT_WINDOW) rttWindow.shift();
  }
  // The header is the moment the server generated the response, which trails our
  // send by roughly half the round trip; localNowMs is taken at RECEIVE. When the
  // RTT is known, compensate the return leg instead of leaving it as bias — at a
  // 0.5s poll it is noise inside the deadband, at a gated-borderline poll it is
  // seconds. (v1.69.0 accepted the bias; v1.81.0 removes it where measurable.)
  const measured = serverMs - localNowMs + (rttMs != null && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs / 2 : 0);
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

/**
 * v1.109.0 — timestamp-class REJECTION feed (8521 signature-wrong / 8524
 * timestamp-invalid). On 2026-08-25 02:46 a marginal −2.1 s adoption crossed the
 * vendor's (evidently tight) timestamp tolerance and every poll failed 8524 for
 * SIX MINUTES: each rejection's Date header measured the true offset (~−0.1 s),
 * but the correction differed from the bad offset by ~2.0 s — just inside
 * OFFSET_DEADBAND_MS — so "within-deadband" blocked the very evidence that
 * would have fixed signing. The deadband exists to stop latency jitter from
 * rewriting a WORKING offset; when the vendor has just REJECTED our timestamp,
 * the offset is proven non-working and the deadband's premise is void.
 *
 * Differences from noteServerDate, each deliberate:
 *  - No deadband: any finite, plausible measurement is adopted.
 *  - RTT gate uses only the absolute cold ceiling (RTT_GATE_COLD_MS): the
 *    vendor's degraded window produces uniformly slow responses, and a
 *    2×-median gate could starve the recovery path exactly when it is needed
 *    (the v1.69.0 origin story — recovery MUST work from the rejection itself).
 *  - The sample is NOT pushed into the RTT window: the regular per-response
 *    noteServerDate call already recorded this response's RTT.
 */
export function noteTimestampRejection(
  header: string | null | undefined,
  localNowMs: number,
  rttMs?: number,
): OffsetUpdate {
  if (!header) return { adopted: false, offsetMs, measuredMs: null, rejected: 'no-header' };
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) {
    return { adopted: false, offsetMs, measuredMs: null, rejected: 'unparseable' };
  }
  const rttOk = rttMs != null && Number.isFinite(rttMs) && rttMs >= 0;
  if (rttOk && rttMs! > RTT_GATE_COLD_MS) {
    return { adopted: false, offsetMs, measuredMs: null, rejected: 'rtt-inflated' };
  }
  const measured = serverMs - localNowMs + (rttOk ? rttMs! / 2 : 0);
  if (Math.abs(measured) > OFFSET_SANITY_LIMIT_MS) {
    return { adopted: false, offsetMs, measuredMs: measured, rejected: 'implausible' };
  }
  if (measured === offsetMs) {
    return { adopted: false, offsetMs, measuredMs: measured, rejected: null };
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
/** Test seam. */
export function resetClockOffset(): void {
  offsetMs = 0;
  adoptedAtMs = null;
  rttWindow = []; // v1.81.0
}
