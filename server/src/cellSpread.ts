/**
 * v1.187.0 — the cell-spread ("vdiff") critical lines and the plateau predicates, in one
 * dependency-free module. Moved here verbatim from alerts.ts (values, env names and defaults
 * unchanged) so the peer-outlier rule in analytics.ts could read the same top-of-charge line:
 * analytics.ts cannot import alerts.ts at runtime (it is also loaded by the analytics worker, and
 * alerts.ts pulls in the actuator, the TTS renderer and the defective-pack latch). On 2026-09-29
 * the two rules disagreed about the same physical event: the pack's own warn-band spread was quiet
 * at >= 95% SoC (v1.45.0) while its peer outlier spoke four yellows.
 *
 * v1.187.21 — the peer outlier no longer reads this module: a cell-spread peer warning is never
 * audible, at any SoC, so its top-of-charge gate (topOfChargeQuietSpread) was removed. The per-pack
 * rule in alerts.ts is the one reader; the lines stay here, in one place.
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
// v1.45.0 — the top-of-charge line. The WARN-band spread's push quieted from here until v1.187.14
// (since then from VOL_DIFF_PLATEAU_SOC_PCT: plateauQuietWarnSpread), and the peer cell-spread
// outlier's audible was gated on it until v1.187.21. It bounds the vdiff-crit end-of-charge and
// charging graces (alerts.ts: vdiffCritMute, advanceVdiffKnee).
export const VOL_DIFF_PLATEAU_QUIET_SOC_PCT = Number(process.env.VOL_DIFF_PLATEAU_QUIET_SOC_PCT ?? 95);
export const VOL_DIFF_PLATEAU_CRIT_MV = Number(process.env.VOL_DIFF_PLATEAU_CRIT_MV ?? 90);

/** The critical cell-spread line for a pack at `packSoc`: the relaxed plateau line at or above
 *  VOL_DIFF_PLATEAU_SOC_PCT, else the standard line. An unknown SoC is OFF the plateau (the
 *  stricter line) — never relax on a reading that is not there. */
export function vdiffCritMvFor(packSoc: number | null | undefined): number {
  return packSoc != null && packSoc >= VOL_DIFF_PLATEAU_SOC_PCT ? VOL_DIFF_PLATEAU_CRIT_MV : VOL_DIFF_CRIT_MV;
}

/** v1.187.14 — the WARNING-level spread's push quiets on the plateau (>= VOL_DIFF_PLATEAU_SOC_PCT,
 *  85%), not only at the top of charge (95%). A charge toward full puts every pack through the LFP
 *  plateau, and on 2026-10-10 a manual top-up pushed nine warn-band spreads across three Cores
 *  within 30 min while the packs climbed through 85-95%. The warning stays visible (and has not
 *  been voiced since v1.187.12); the critical line is untouched and still pushes and sounds.
 *  Below the plateau (the morning reversal on the same two packs) the warning still pushes. */
export function plateauQuietWarnSpread(packSoc: number | null | undefined, spreadMv: number): boolean {
  return packSoc != null && packSoc >= VOL_DIFF_PLATEAU_SOC_PCT && spreadMv < vdiffCritMvFor(packSoc);
}
