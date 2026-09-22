/**
 * v1.174.0 — the MPPT "is this string actually producing?" rule, extracted from
 * alerts.ts so BOTH consumers read the same definition:
 *
 *   alerts.ts   — decides whether a non-zero hvPvErrCode / lvPvErrCode is a real
 *                 fault worth alarming on.
 *   snapshot.ts — runs the debounce clock for that alarm (trackMpptErrOnsets), and
 *                 the clock must advance on EXACTLY the condition the alarm fires on.
 *
 * It lives in its own module rather than being exported from alerts.ts because
 * snapshot.ts must not take a runtime dependency on the alarm engine (alerts.ts
 * imports snapshot.ts for types today, and a value import back would close the
 * cycle). A shared leaf module keeps one definition with no import graph risk.
 *
 * MPPT idle/shed guard (v0.9.80, watt-based since v0.9.81). During
 * curtailment AND at sunset the DPU sheds/winds-down a string: the input
 * shows voltage but ~0 W, and EcoFlow reports a non-zero *standby* status
 * in hvPvErrCode / lvPvErrCode that is NOT a fault. Live proof: at sunset
 * ALL cores reported HV err=457 / LV err=177 simultaneously (a real fault
 * can't be identical across independent units), with strings at 0 W — one
 * HV string drew a 0.275 A shutdown trickle (above the old 0.1 A floor) and
 * slipped through. A string is only meaningfully "producing" — so a code is
 * a real error worth flagging — when it's making real WATTS. Below the floor
 * it's idle/shedding/shutting-down and any code is benign standby.
 */

/** W — below this the string isn't meaningfully producing. */
export const MPPT_WATT_FLOOR = 20;
/** A — just above the 0.275 A sunset shutdown trickle observed on Core 2 (v0.9.81 note). */
export const MPPT_AMP_FLOOR = 0.3;

/**
 * v1.0.1 — a string counts as PRODUCING only when it makes real watts AND actually
 * draws current. The two documented false-positive modes are complementary, and each
 * single-signal guard let the other through:
 *
 *   v0.9.80 amp floor  → a 0 W / 0.275 A sunset shutdown trickle slipped past it.
 *   v0.9.81 watt floor → a dusk HV reading of 55 W while amps read 0.0 A slips past it.
 *                        (Observed live: Core 3, code 457, 294 V, 0.0 A, 55 W — the alert
 *                        text literally read "producing 55 W (294 V, 0.0 A)". EcoFlow's
 *                        watt and amp fields disagree during the ramp-down, so neither
 *                        alone is trustworthy.) All three home Cores reported the SAME
 *                        code 457 at that instant — and a real fault cannot be identical
 *                        across independent units, confirming benign standby.
 *
 * Requiring BOTH signals rejects both modes. `amps == null` (device doesn't report
 * current) falls back to the watt test alone rather than silently suppressing.
 *
 * ★ v1.174.0 — this test alone is NOT sufficient, and the SUNRISE ramp is why. The
 * guard was derived entirely from SUNSET observations, where a shedding string makes
 * no real watts; at sunrise the same benign standby code rides a string that IS
 * producing. Live 2026-09-22: one Core reported HV code 457 at 407 W / 301 V / 1.38 A
 * for ~1 minute at 06:58 and again at 07:33 — both above these floors, both spoken as
 * audible warnings, both gone by the next tick (an identical 60 s blip on 2026-08-30 at
 * 06:43). Alerts.ts therefore also requires the SAME code to stand for
 * MPPT_ERR_DEBOUNCE_MS while producing; see trackMpptErrOnsets in snapshot.ts.
 */
export const mpptProducing = (watts: number | null, amps: number | null): boolean => {
  if (watts == null || watts <= MPPT_WATT_FLOOR) return false;
  if (amps == null) return true;
  return amps > MPPT_AMP_FLOOR;
};
