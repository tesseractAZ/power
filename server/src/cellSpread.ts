/**
 * v1.187.0 — the cell-spread ("vdiff") critical lines and the top-of-charge predicate, in one
 * dependency-free module. Two rules read them: the per-pack static rule in alerts.ts and the
 * peer-outlier rule in analytics.ts. analytics.ts cannot import alerts.ts at runtime (it is also
 * loaded by the analytics worker, and alerts.ts pulls in the actuator, the TTS renderer and the
 * defective-pack latch), and a second copy of "top of charge" would drift from the first. On
 * 2026-09-29 the two rules already disagreed about the same physical event: the pack's own
 * warn-band spread was quiet at >= 95% SoC (v1.45.0) while its peer outlier spoke four yellows.
 *
 * Moved here verbatim from alerts.ts (values, env names and defaults unchanged).
 */

export const VOL_DIFF_CRIT_MV = 50;
// v0.58.0 — on the LFP top-of-charge plateau (high SoC) cell spread transiently
// balloons even with the BMS idle (balanceState=0), so the static 50 mV crit
// chimed an audible klaxon repeatedly at the top of charge (live: 14 red
// broadcasts in two top-of-charge bursts while the resting spread was a healthy
// 2-5 mV). Above the plateau SoC, relax the critical threshold and keep a benign
// excursion VISIBLE-but-silent (a debounced, auto-silenceable warning) — exactly
// as the balancing gate does. A genuinely large spread (>= the relaxed ceiling)
// still goes critical + audible. Env-tunable.
export const VOL_DIFF_PLATEAU_SOC_PCT = Number(process.env.VOL_DIFF_PLATEAU_SOC_PCT ?? 85);
// v1.45.0 — above this SoC, WARN-band spread (24-49 mV) is annunciate:false.
export const VOL_DIFF_PLATEAU_QUIET_SOC_PCT = Number(process.env.VOL_DIFF_PLATEAU_QUIET_SOC_PCT ?? 95);
export const VOL_DIFF_PLATEAU_CRIT_MV = Number(process.env.VOL_DIFF_PLATEAU_CRIT_MV ?? 90);

/** The critical cell-spread line for a pack at `packSoc`: the relaxed plateau line at or above
 *  VOL_DIFF_PLATEAU_SOC_PCT, else the standard line. An unknown SoC is OFF the plateau (the
 *  stricter line) — never relax on a reading that is not there. */
export function vdiffCritMvFor(packSoc: number | null | undefined): number {
  return packSoc != null && packSoc >= VOL_DIFF_PLATEAU_SOC_PCT ? VOL_DIFF_PLATEAU_CRIT_MV : VOL_DIFF_CRIT_MV;
}

/**
 * v1.187.0 — is this a top-of-charge spread BELOW the critical line? The v1.45.0 plateauQuietWarn
 * predicate, lifted out of alerts.ts so the peer-outlier rule reads the same definition. The
 * pack's OWN SoC and spread only: a sibling on the knee says nothing about this pack.
 *
 * At or above the critical line this is false, so a genuinely large spread is never quieted by
 * it (vdiff-crit owns that band, with its own bounded end-of-charge grace in alerts.ts).
 */
export function topOfChargeQuietSpread(packSoc: number | null | undefined, spreadMv: number): boolean {
  return packSoc != null && packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT && spreadMv < vdiffCritMvFor(packSoc);
}
