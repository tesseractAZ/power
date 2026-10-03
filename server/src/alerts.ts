import { existsSync, readFileSync } from 'node:fs';
import type { DeviceSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import { atomicWriteFileSync } from './atomicWrite.js';
import { activeSocBandWithHysteresis, socAlertSeverity } from './batterySocAlarm.js';

/* v1.17.0 (engine-review F15) — held-band state for the on-screen backup-soc
 * alert's re-arm hysteresis. computeAlerts has exactly one production call site
 * (alertMonitor's snapshot loop), so a module singleton is safe; tests reset it. */
let heldSocBandPct: number | null = null;
/* v1.185.0 — the same held band for each SECONDARY panel, keyed by serial. */
const heldSocBandBySn = new Map<string, number | null>();

/**
 * v1.186.3 — the grid clause of a grid-downgraded pool alert. `backstopping` means the grid
 * would take over at the reserve floor, not that it is supplying the house: "drawing from grid
 * power" needs measured grid import (GridBackstop.importLive); otherwise the grid is present
 * as backup and solar or the batteries are carrying the house.
 */
export function gridBackupClause(grid: { importLive?: boolean } | undefined): string {
  return grid?.importLive === true ? 'drawing from grid power' : 'the grid is available as backup';
}

export function resetOnScreenSocBandForTesting(): void {
  heldSocBandPct = null;
  heldSocBandBySn.clear();
}
/* v1.21.0 (engine-review F28) — packs currently HELD in the vdiff warning by the
 * rise-side hysteresis (fired at >= VOL_DIFF_WARN_RISE_MV, holding while still
 * >= VOL_DIFF_WARN_MV). Keyed `${sn}-${packNum}`. Same single-call-site module
 * singleton as the SoC band above; pruned each cycle so a pack that goes
 * missing (device offline, vdiff reading null) must re-earn the rise. */
// v1.173.0 — value = the packSn that EARNED the hold (null when unknown). A hold is a fact
// about a pack, not a slot: a different pack in the slot must earn its own rise.
const heldVdiffWarnKeys = new Map<string, string | null>();
export function resetVdiffWarnHoldForTesting(): void {
  heldVdiffWarnKeys.clear();
  vdiffKneeByKey.clear(); // v1.187.0 — the end-of-charge knee state is per-pack vdiff state too
}
import { VOL_DIFF_CRIT_MV, VOL_DIFF_PLATEAU_SOC_PCT, VOL_DIFF_PLATEAU_QUIET_SOC_PCT, vdiffCritMvFor, topOfChargeQuietSpread } from './cellSpread.js';
import { shp2ConnectedDpuSns, isExpectedOfflineSpare as isExpectedOfflineSpareShared, housePoolFallbackSoc, shp2Panels, findShp2, secondaryPanels, panelMeanSoc } from './shp2Membership.js';
import { liveHostPower } from './hostPower.js';
import { mpptProducing } from './mppt.js';
import { getReserveArbitrageRaised } from './nightChargeActuator.js';
import { confirmDefectivePack, markPackPresent, getConfirmedRecord, retireAbsentPacks, isoOrRaw } from './defectivePackLatch.js';
import { liveHostTemp, hostTempLevel, HOST_TEMP_WARN_C, HOST_TEMP_CRIT_C, type HostTempLevel } from './hostThermal.js';
import { getAlertOnset } from './alertOnset.js';
import { currentAssessment } from './selfVitals.js';
import { ttsRenderHealth } from './audioRenderer.js';

// v1.42.0 — host-temp hysteresis level held across builds (module singleton,
// same lifetime pattern as the vdiff warning hold set).
let heldHostTempLevel: HostTempLevel = 'ok';
import {
  classifyDeviceLink,
  getDeviceReachability,
  deviceReachabilityEntities,
} from './deviceLink.js';

/**
 * System-wide alerts engine — the single source of truth. The web UI renders
 * snapshot.alerts (computed here); the alert monitor uses the same output to
 * decide what to push as a notification.
 */

export type Severity = 'critical' | 'warning' | 'info';

/** One labelled number in a learned alert's statistical breakdown. */
export interface AlertFact {
  label: string;
  value: string;
}


/* ── v1.41.0 — pack cell forensics ─────────────────────────────────────────
 * A battery fault alert should carry detection → isolation → root cause with
 * supporting ranges: WHICH cell deviates, by how much, against the pack median
 * and against sibling packs — the exact dossier an after-sales ticket needs.
 * Both helpers are PURE and emit null when the underlying per-cell / per-pack
 * telemetry is absent (null over fabrication). */

export interface PackCellForensics {
  cellCount: number;
  /** 1-based index of the cell farthest from the pack median. */
  deviantCell: number;
  deviantMv: number;
  medianMv: number;
  /** Signed deviation (deviant − median): negative = weak/low cell. */
  deltaMv: number;
  spreadMv: number;
  /** Other packs' spreads (mV) on the same unit, for contrast. */
  siblingSpreadsMv: number[];
}

/** Isolate the deviant cell in pack `packNum` of a DPU's pack set. */
export function packCellForensics(
  packs: ReadonlyArray<{ num: number; cellVoltagesMv: number[] }>,
  packNum: number,
): PackCellForensics | null {
  const pk = packs.find((p) => p.num === packNum);
  const cells = pk?.cellVoltagesMv ?? [];
  if (cells.length < 4 || cells.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  const sorted = [...cells].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianMv = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let deviantIdx = 0;
  for (let i = 1; i < cells.length; i++) {
    if (Math.abs(cells[i] - medianMv) > Math.abs(cells[deviantIdx] - medianMv)) deviantIdx = i;
  }
  const siblingSpreadsMv = packs
    .filter((p) => p.num !== packNum && (p.cellVoltagesMv?.length ?? 0) >= 4)
    .map((p) => Math.max(...p.cellVoltagesMv) - Math.min(...p.cellVoltagesMv))
    .filter((s) => Number.isFinite(s));
  return {
    cellCount: cells.length,
    deviantCell: deviantIdx + 1,
    deviantMv: cells[deviantIdx],
    medianMv: Math.round(medianMv),
    deltaMv: Math.round(cells[deviantIdx] - medianMv),
    spreadMv: Math.max(...cells) - Math.min(...cells),
    siblingSpreadsMv,
  };
}

export interface PackLatchSignature {
  socPct: number;
  siblingMedianSocPct: number;
  /** Net pack power (charge − discharge), W — ~0 on a latched pack. */
  packAbsW: number;
  siblingMedianAbsW: number;
}

/** BMS protection-latch signature: the pack is SoC-stranded from its siblings
 *  (≥ 20 pts below the sibling median) while exchanging ~no power (< 25 W)
 *  during active sibling flow (sibling median ≥ 100 W). All three legs must
 *  hold — a pack idling alongside idle siblings is NOT latched. */
/**
 * v1.101.0 — alerts that must annunciate regardless of where the hardware is
 * wired. Shared by the bench-spare stamp (alerts.ts) and the off-panel demotion
 * (alertMonitor.ts) so the two can never drift apart.
 *
 *  - a CRITICAL Thermal alert: an overheating pack must page from anywhere.
 *  - `cell-ovp-*` (v1.187.0): a cell at the overvoltage line, likewise.
 *  - `pack-defective-*`: a confirmed BMS protection latch with an identified
 *    deviant cell. Muting this is how the defective warranty pack went silent
 *    while its healthy replacement pushed [High] to the operator's phone.
 */
/** v1.101.0 — how far the deviant cell must sit from the pack median before the
 *  standing defective-pack alert will fire. Matches the cell-imbalance critical
 *  threshold: below this the "deviant" cell is just the most-deviant of a
 *  healthy set. */
export const DEFECTIVE_PACK_MIN_DEVIANT_MV = 50;

/** v1.173.0 — characters of a pack serial shown to the operator. MEASURED 2026-09-21: two
 *  Core 4 packs share their last 4 characters; 5 is the minimum unique across the 24-pack
 *  fleet; 6 keeps a margin. */
export const PACK_SN_TAIL_CHARS = 6;
export function packSnTail(packSn: string): string {
  return `…${packSn.slice(-PACK_SN_TAIL_CHARS)}`;
}

export function isNeverMutedAlert(
  a: Pick<Alert, 'id' | 'severity' | 'category'>,
): boolean {
  if (a.severity === 'critical' && a.category === 'Thermal') return true;
  // v1.129.0 — the multi-panel guard exists to say the monitoring model is
  // unsound. Anything that could mute it is, by construction, one of the
  // mechanisms it is warning about.
  if (a.id === 'shp2-multi-panel') return true;
  // v1.187.0 — a cell at the overvoltage line pages from anywhere, like an overheating pack:
  // a bench chassis on a charger is exactly where nothing else is watching it.
  if (a.id.startsWith('cell-ovp-')) return true;
  return a.id.startsWith('pack-defective-');
}

export function packLatchSignature(
  packs: ReadonlyArray<{ num: number; soc: number | null; inputWatts: number | null; outputWatts: number | null }>,
  packNum: number,
): PackLatchSignature | null {
  const absW = (p: { inputWatts: number | null; outputWatts: number | null }): number | null =>
    p.inputWatts == null && p.outputWatts == null ? null : Math.abs(p.inputWatts ?? 0) + Math.abs(p.outputWatts ?? 0);
  const pk = packs.find((p) => p.num === packNum);
  if (!pk || pk.soc == null) return null;
  const packW = absW(pk);
  if (packW == null) return null;
  const sibs = packs.filter((p) => p.num !== packNum);
  const sibSocs = sibs.map((p) => p.soc).filter((s): s is number => s != null).sort((a, b) => a - b);
  const sibWs = sibs.map(absW).filter((w): w is number => w != null).sort((a, b) => a - b);
  if (sibSocs.length < 2 || sibWs.length < 2) return null;
  const medSoc = sibSocs[sibSocs.length >> 1];
  const medW = sibWs[sibWs.length >> 1];
  if (medSoc - pk.soc >= 20 && packW < 25 && medW >= 100) {
    return { socPct: pk.soc, siblingMedianSocPct: medSoc, packAbsW: Math.round(packW), siblingMedianAbsW: Math.round(medW) };
  }
  return null;
}

/** Facts rows shared by the cell-fault alert family (null-safe assembly). */
function cellFaultFacts(f: PackCellForensics | null, latch: PackLatchSignature | null): AlertFact[] {
  const rows: AlertFact[] = [];
  if (f) {
    rows.push(
      { label: 'Deviant cell', value: `#${f.deviantCell} of ${f.cellCount} at ${(f.deviantMv / 1000).toFixed(3)} V` },
      { label: 'Pack median cell', value: `${(f.medianMv / 1000).toFixed(3)} V` },
      { label: 'Deviation', value: `${f.deltaMv > 0 ? '+' : ''}${f.deltaMv} mV (${f.deltaMv < 0 ? 'weak/low' : 'high'} cell)` },
      { label: 'This pack spread', value: `${f.spreadMv} mV` },
    );
    if (f.siblingSpreadsMv.length) {
      const lo = Math.min(...f.siblingSpreadsMv), hi = Math.max(...f.siblingSpreadsMv);
      rows.push({ label: 'Sibling pack spreads', value: lo === hi ? `${lo} mV` : `${lo}–${hi} mV` });
    }
  }
  if (latch) {
    rows.push(
      { label: 'Pack charge/discharge', value: `${latch.packAbsW} W (SoC ${latch.socPct}%)` },
      { label: 'Sibling packs', value: `~${latch.siblingMedianAbsW} W median (SoC ~${latch.siblingMedianSocPct}%)` },
      { label: 'Assessment', value: 'BMS protection latch — pack excluded from parallel operation' },
    );
  }
  return rows;
}

export interface Alert {
  id: string;
  severity: Severity;
  category: 'Battery' | 'Solar' | 'Thermal' | 'SHP2' | 'Grid' | 'Connectivity';
  device: string;
  title: string;
  detail: string;
  /** 'threshold' = static rule (default); 'learned' = anomaly/forecast engine. */
  source?: 'threshold' | 'learned';
  /**
   * v0.44.0 — explicit ISA priority/tier. When present, priorityOf() reads this
   * FIRST and skips the severity+source heuristic. Lets a REAL measured
   * threshold crossing reach ISA Medium without faking source='learned' (which
   * would route it onto the Predictive page and mislabel it in cleared history).
   * Omit it and the legacy severity+source derivation still applies.
   */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Subject identity — Core (DPU) number, then pack number, when scoped to one. */
  coreNum?: number | null;
  packNum?: number | null;
  /** Structured statistical breakdown — populated for learned alerts. */
  facts?: AlertFact[];
  /**
   * ★★★ v1.64.0 — SUB-IDENTITY. A short, STABLE, machine-readable discriminator
   * for WHICH fault this is, when the `id` is deliberately reused across
   * materially different faults on the same source.
   *
   * WHY IT EXISTS: `dpu-err-<sn>` is emitted for EVERY value of `sysErrCode` —
   * the id is held constant on purpose so a standing fault does not re-raise as a
   * "new" alert on upgrade (v1.41.0). `shp2-src-err-<slot>` has the same property.
   * That makes the bare id an unsafe identity for anything that must ask "is this
   * the SAME fault I already announced?": a standing code clearing and a
   * different, real code appearing on the same device produce the identical id.
   * `redReplayGate.alertFingerprint` folds this field in, so a code change is a
   * DIFFERENT fault and always announces.
   *
   * ★ MUST be stable for a genuinely unchanged fault. Put the error CODE (or an
   * equally discrete state token) here — NEVER a live measurement (watts, mV,
   * percent, temperature) or a timestamp: a value that drifts every tick would
   * make every fingerprint unique and silently turn the replay gate into a no-op.
   * Omit it entirely when the id already identifies exactly one fault.
   */
  fault?: string;
  /**
   * v1.78.0 — the SERIAL of the device whose telemetry PROVES this condition,
   * for alerts whose `id` does not embed it. The falling-edge evidence gate
   * (alertMonitor.fallingEdgeFrozenByEvidence) resolves an alert's source
   * device to decide whether a disappearance is a recovery or mere blindness;
   * before this field it could only search the id string for a serial, which
   * silently skipped every SN-less id — `shp2-src-err-<slot>` let a 7-second
   * SHP2 /status blip push a false "Resolved: Energy source error" at 04:17 on
   * 2026-08-12, the precise incident the gate was built for. Set it wherever
   * the constructor has the device in hand; omission falls back to id search.
   */
  sourceSn?: string;
  /**
   * v1.102.0 — the PHYSICAL pack this alert is about, when it is pack-scoped.
   *
   * `packNum` is a SLOT number, so `(sourceSn, packNum)` names a position, not a
   * battery. When packs are physically moved between chassis that distinction
   * stops being academic: the same alert id silently follows the slot onto
   * different hardware. Carrying the BMS-reported serial lets the monitor close
   * one episode and open another (see alertMonitor's pack-residency check), and
   * lets the warranty export follow a pack across chassis instead of splitting
   * its history at the swap.
   */
  sourcePackSn?: string;
  /**
   * v0.16.4 — annunciation gate. `false` = this condition stays VISIBLE in
   * snapshot.alerts (the UI still renders it) but must never produce an audible
   * broadcast, a push notification, or raise the broadcast condition level.
   * `undefined`/`true` = annunciate normally. Used for expected-steady-state
   * conditions like a designated bench spare reporting offline. Mirrors the
   * "never hide an active alarm, only mute it" pattern (v0.11.0). The two
   * annunciation channels honour it: broadcast.conditionFromAlerts (audible) and
   * alertMonitor's rising-edge router (push, above the quiet-hours digest queue).
   */
  annunciate?: boolean;
  /**
   * v1.187.0 — audible-only gate. `false` = the alert stays on the card AND still pushes, but
   * never raises or voices the broadcast condition (broadcast.conditionFromAlerts and the
   * broadcast tick's speech filter). Narrower than `annunciate:false`, which drops the push too.
   * Used for a peer cell-spread outlier at top of charge (analytics.computeLearnedAlerts), and
   * for one whose pack's vdiff-crit is held by a bounded cell-spread mute
   * (alertMonitor.quietPeerSpreadUnderHeldCritical).
   */
  audible?: boolean;
  /**
   * v1.187.0 — which bounded cell-spread mute holds a `vdiff-crit-*` non-annunciating this tick.
   * alertMonitor names it in the "held non-annunciating" log line, which blamed every silent
   * critical on a bench spare or off-panel Core (2026-09-29: all three were the balancing mute
   * on home Cores), and quiets the same pack's peer cell-spread outlier while it is set.
   * v1.187.1 — it names the mute IN FORCE: a policy stamp that takes precedence (bench spare,
   * off-panel roster) clears it, so a policy-muted critical holds nothing (soundedCriticalHeld).
   */
  mutedBy?: VdiffCritMuteReason;
  /**
   * v1.187.0 — WHY `annunciate` is false, in words, stamped at the site that muted it
   * (MUTE_REASON_* below, the self-baseline's own reasons, the monitor's spare/off-panel gate).
   * DIAGNOSTIC ONLY: it names the policy in the silent-critical log line. Nothing may read it to
   * decide a mute — `annunciate` alone is the gate (test/muteReasonLog pins that).
   */
  muteReason?: string;
}

/** v1.187.0 — muteReason wordings shared by the alert producers and the monitor. */
export const MUTE_REASON_BALANCING = 'the BMS is balancing the cells';
export const MUTE_REASON_PLATEAU = 'expected top-of-charge cell spread';
export const MUTE_REASON_BENCH_SPARE = 'bench spare';
export const MUTE_REASON_OFF_PANEL = 'off-panel Core — not on the panel roster';
/** v1.187.0 review — the telemetry-blind alert held while its remediation runs (blindRemediation.ts). */
export const MUTE_REASON_REMEDIATION = 'held for remediation (remediate-first)';

const cToF = (c: number) => c * 1.8 + 32;

/**
 * v1.174.0 — is this string's error code still inside its debounce window? True while the
 * SAME code has been standing-and-producing for less than MPPT_ERR_DEBOUNCE_MS, i.e. the
 * alarm must wait. An absent onset map (older callers, unit tests) returns false: fire
 * now, exactly as before this guard existed. An absent ENTRY also returns false — the
 * store only drops the entry when the code clears or the string stops producing, so
 * "no entry while the alert condition holds" means the clock has not been fed yet this
 * tick, and a real standing fault must not wait on bookkeeping.
 */
function mpptErrDebounced(
  connectivity: ConnectivityContext | undefined,
  sn: string,
  channel: 'hv' | 'lv',
  code: number,
  now: number,
): boolean {
  const onset = connectivity?.mpptErrOnsetByKey?.get(`${sn}:${channel}`);
  return onset != null && onset.code === code && (now - onset.sinceMs) < MPPT_ERR_DEBOUNCE_MS;
}


/*
 * The MPPT idle/shed guard (v0.9.80 → v1.0.1) now lives in mppt.ts, shared with the
 * snapshot store's debounce clock so both read one definition. v1.174.0 — a producing
 * string is necessary but no longer sufficient: the code must also STAND. See the
 * dpu-pvh-err / dpu-pvl-err pushes below and MPPT_ERR_DEBOUNCE_MS.
 */

/*
 * Thresholds. EcoFlow's API does NOT expose cell-imbalance or temperature alarm
 * limits, so these are our own (general LFP best practice). Where EcoFlow exposes
 * an operating limit (emsParaVol window) we use its numbers directly.
 *
 * v-r14 — exported so the telnet TUI (plant/gen.ts) can colour live
 * temperature readouts against the SAME bands this engine alarms on, instead of
 * maintaining separate, drifted copies. One band per physically-distinct sensor:
 * a hot MPPT or MOSFET is normal where a hot LFP cell is not.
 */
export type TempBand = { infoF: number; warnF: number; critF?: number };
export const CELL_TEMP: TempBand = { infoF: 104, warnF: 113, critF: 131 };
export const MOS_TEMP: TempBand = { infoF: 104, warnF: 131, critF: 149 };
export const BOARD_TEMP: TempBand = { infoF: 113, warnF: 140, critF: 158 };
export const SHUNT_TEMP: TempBand = { infoF: 113, warnF: 140 };
export const MPPT_TEMP: TempBand = { infoF: 131, warnF: 149, critF: 167 };
export const CELL_TEMP_COLD_F = 41;

const VOL_DIFF_WARN_MV = 20;
// v1.21.0 (engine-review F28) — rise-side margin for the vdiff warning. The
// 20 mV line had ZERO rise hysteresis, so threshold-kissing 19-22 mV spreads
// fired `vdiff-warn` on every touch (30-day ground truth: 73-100% of rises
// cleared within minutes; the v0.77 resolve dwell only holds the RESOLVE push
// — it cannot stop the dashboard re-fire churn on the next kiss). Fire only at
// >= 24 mV (clear of the observed 20-23 mV kissing band); once fired, HOLD the
// warning while the spread is still >= the original 20 mV, so a real episode
// doesn't flap on the way down. The critical threshold is untouched — a 50 mV
// (90 mV on-plateau) spread is instantaneous by design (v0.29 handles its
// transients via the balancing/plateau annunciate gates).
const VOL_DIFF_WARN_RISE_MV = 24;
// VOL_DIFF_CRIT_MV and the v0.58.0 / v1.45.0 plateau lines (VOL_DIFF_PLATEAU_*) live in
// cellSpread.ts since v1.187.0, so the peer-outlier rule reads the same definitions.

/*
 * v1.187.0 — THE END-OF-CHARGE KNEE. On 2026-09-29 two healthy packs at 100% sounded the
 * 72-second critical klaxon and pushed [Critical] (Core 5 pack 3 at 104 mV, Core 1 pack 1 at
 * 93 mV). At or above the plateau critical line the only mute was the INSTANTANEOUS balancing
 * flag, and the BMS stops balancing about a minute after the pack stops charging — while the
 * spread is still at its peak. It then fell below 90 mV within 2-3 minutes (104 → 67, 93 → 67)
 * and to 3-4 mV at rest. The v0.29.0 premise, "a genuine sustained imbalance persists past
 * balancing", fails at the end of charge: balancing stops BECAUSE charging stopped.
 *
 * The grace below is bounded on every side, because the same shape with a slow relaxation is
 * a real fault class (2026-08-22/23, Core 3 packs 1, 2 and 4: 110-138 mV that fell only 3-9%
 * in the first 3 minutes after charge and stood at or above 90 mV for 9-51 minutes):
 *  - evidence: it opens only on top-of-charge ACTIVITY seen on a pack at
 *    >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT whose spread had reached VOL_DIFF_WARN_MV — never on
 *    the max cell alone (a runaway-high cell on a mid-SoC pack is the signature of a
 *    low-capacity cell, and stays immediate). The two kinds of activity are NOT equal:
 *      · BALANCING is the observed benign mechanism (every benign reading at or above 90 mV
 *        in the recorder — 07-28 and 09-29 ×3 — had balancing on), so the relaxation window
 *        runs VDIFF_KNEE_RELAX_MS from the last balancing tick;
 *      · CHARGE INPUT alone has no benign precedent at the line (charge-only peaks: 84 mV on
 *        09-25 at 551 W, 77 mV on 07-23; the one charge-only reading at or above 90 mV in
 *        history is the 08-22/23 Core 3 pack 4 fault). It holds a critical for at most
 *        VDIFF_KNEE_RELAX_MS measured from the FIRST crossing of the session (graceFromMs),
 *        never from the last charge tick — a steady trickle must not keep refreshing its own
 *        mute — and it counts only as the stream delivered it (vdiffKneeChargeW), never the
 *        REST replay;
 *  - session (v1.187.0 log review): both graces are measured from the first critical-line
 *    crossing of the SESSION (graceFromMs; v1.187.2 — on the plateau, at the top of charge until
 *    then) — the charge grace for at most VDIFF_KNEE_RELAX_MS, the end-of-charge grace for at most
 *    VDIFF_KNEE_MAX_MUTE_MS — not of the current crossing. The critical-line clock (critSinceMs) restarted whenever the spread
 *    fell under 50 mV (until v1.187.1: it now ends only after an unbroken VDIFF_KNEE_RELAX_MS
 *    under the line), so a spread that follows the charge current on isolated BMS readings
 *    (95 / 45 mV every ~180 s) earned a fresh grace on every crossing and was never announced
 *    for the whole afternoon; the session still bounds one whose dips are long enough to end it.
 *    The session ends when the pack reads below the plateau (v1.187.2; below the top of charge
 *    until then), or once it has RESTED there — an unbroken VDIFF_KNEE_MAX_MUTE_MS under 50 mV —
 *    so a benign pack's next knee earns the graces again, while a second knee in the same session
 *    without a rest annunciates (fail loud);
 *  - fail-to-relax: VDIFF_KNEE_RELAX_MS after the last balancing tick, a spread still at or
 *    above the critical line annunciates;
 *  - duration: VDIFF_KNEE_MAX_MUTE_MS after the spread first reached the critical line, it
 *    annunciates even while the BMS is still balancing (the balancing mute was unbounded); on
 *    the plateau that bound is also counted from the session's first crossing, so dips under the
 *    line long enough to end the episode do not restart it (v1.187.2 — at the top of charge only
 *    until then: between 85% and 95% the episode clock alone bounded it, and 95 / 45 / 45 mV
 *    restarted it on every crossing). Every state the process writes has graceFromMs <=
 *    critSinceMs, so the session bound comes due first; the episode's own bound still holds a
 *    knee-session file that inverts them;
 *  - ceiling: VOL_DIFF_KNEE_HARD_MV annunciates at once, at any SoC, balancing or not;
 *  - and the direct hazard — a cell running toward overvoltage — has its own never-muted
 *    critical (CELL_OVP_CRIT_MV).
 * Deliberately NOT env-tunable: these bound a mute, and a mistyped bound would widen it.
 */
/** Unconditional ceiling for every cell-spread mute (balancing, plateau, end-of-charge).
 *  Benign top-of-charge peaks in the recorder (every pack, 2026-07-02 → 09-29): 86-90 mV on
 *  07-23, 07-28, 09-18 and 09-25; 104 mV on 09-29. A leading cell at the highest observed max
 *  (3.533 V) over the lowest top-of-charge min (~3.38 V) bounds a benign spread near 150. */
export const VOL_DIFF_KNEE_HARD_MV = 150;
/** How long a plateau-critical spread may stay silent after the last BALANCING tick, and the
 *  longest charge input alone may hold it from its first crossing. The BMS publishes cell
 *  voltages every ~180 s, so this window always holds a reading taken at least 2 minutes after
 *  balancing stopped. Every benign spread at or above 90 mV (07-28, 09-29 ×3) was back under
 *  it within 2.7 minutes of the last balancing (104 → 67, 93 → 67, 101 → 86 → 60, 90 → 30);
 *  the slow Core 3 packs of 08-22/23 still read 110-134 mV then. */
export const VDIFF_KNEE_RELAX_MS = 5 * 60_000;
/** The longest a plateau-critical spread may stay silent at all, measured from the tick it
 *  first reached the critical line — and the longest the end-of-charge grace and (on the
 *  plateau, v1.187.2) the balancing mute last in one session (graceFromMs). Also the rest under
 *  50 mV that ends a session (quietSinceMs). Longest benign run at or above 90 mV:
 *  9 minutes (Core 1 pack 1, 2026-09-29 15:31:57 → 15:40:58); twice that. */
export const VDIFF_KNEE_MAX_MUTE_MS = 20 * 60_000;
/** Pack charge input that counts as top-of-charge activity. Observed knee charging: 101-1301 W. */
export const VDIFF_KNEE_CHARGE_W = 50;
/** How old a stream-delivered charge reading may be and still count as knee evidence. Its own
 *  constant, deliberately NOT snapshot.ts's STREAM_FLOW_WINDOW_MS: that one is a DISPLAY window
 *  (liveFlow), and widening it for the card must not widen this mute. 150 s spans two missed
 *  ~60 s full pack bursts; a stopped pack's 0 W arrives as a per-change delta well inside it. */
export const VDIFF_KNEE_STREAM_FRESH_MS = 150_000;
/** How long a pack's critical-line clock (critSinceMs) and session grace clock (graceFromMs) are
 *  carried across a reading gap (the device offline, a missed poll). Carrying it is the fail-LOUD direction — the duration bound
 *  keeps counting — so the cap only keeps a long-gone episode from greeting a returning pack.
 *  The activity evidence is never carried (see computeAlerts' prune). Also the oldest persisted
 *  onset that seeds the session clock after a restart (vdiffKneeSeed), and (v1.187.1) the longest
 *  outage a persisted knee session survives (restoreVdiffKneeSessions). */
export const VDIFF_KNEE_GAP_CARRY_MS = 60 * 60_000;

/** v1.187.0 — one pack's end-of-charge knee bookkeeping (see advanceVdiffKnee). */
export interface VdiffKneeState {
  /** The pack serial that earned this state (null when unknown). */
  packSn: string | null;
  /** Last top-of-charge tick with the BMS balancing, on a spread that had reached VOL_DIFF_WARN_MV. */
  lastBalancingMs: number | null;
  /** Last top-of-charge tick with stream-delivered charge input above VDIFF_KNEE_CHARGE_W, on a
   *  spread that had reached VOL_DIFF_WARN_MV. Never refreshes the balancing window. */
  lastChargeMs: number | null;
  /** Tick the spread first reached the plateau critical line. Cleared when the pack leaves the
   *  plateau, or once the spread has stayed below the plateau critical line — under
   *  VOL_DIFF_CRIT_MV included (v1.187.1 log review) — for VDIFF_KNEE_RELAX_MS without a break
   *  (belowCritSinceMs), so a spread hovering on the line or alternating across 50 mV cannot
   *  restart the clock, and a relaxed one does not carry it. A clock seeded from an onset and not
   *  yet confirmed (critSeeded) is still cleared by a reading under VOL_DIFF_CRIT_MV. */
  critSinceMs: number | null;
  /** First tick of the current unbroken run under the plateau critical line (v1.187.1: under
   *  VOL_DIFF_CRIT_MV too) while critSinceMs stands on the plateau. */
  belowCritSinceMs: number | null;
  /** v1.187.0 (log review) — the SESSION's grace clock: the first critical-line crossing (the
   *  critSinceMs of the episode then running) seen while the pack is on the plateau (v1.187.2:
   *  at or above VOL_DIFF_PLATEAU_SOC_PCT; until then VOL_DIFF_PLATEAU_QUIET_SOC_PCT). Unlike
   *  critSinceMs it survives the spread falling under the line, and is cleared only by a reading
   *  below the plateau (a missing SoC does not clear it) or once the pack has rested there
   *  (quietSinceMs). Carried across a reading gap like critSinceMs. Bounds the balancing mute at
   *  any SoC it stands at, and at the top of charge both graces. */
  graceFromMs: number | null;
  /** v1.187.0 (log review) — first tick of the current unbroken run of readings under
   *  VOL_DIFF_CRIT_MV on the plateau (v1.187.2; until then at the top of charge only). A pack that
   *  has RESTED this long — VDIFF_KNEE_MAX_MUTE_MS — ends its session (graceFromMs), so its next
   *  knee earns the graces again. Not carried across a reading gap (a rest must be seen).
   *  v1.187.1 (review) — persisted, and restored across a restart only when the outage is short
   *  (restoreVdiffKneeSessions). */
  quietSinceMs: number | null;
  /** Last tick this pack produced a reading (the VDIFF_KNEE_GAP_CARRY_MS cap). */
  lastSeenMs: number | null;
  /** v1.187.2 — critSinceMs came from vdiffKneeSeed (a persisted onset, perhaps a day old, never
   *  seen in a process) and no reading at the critical line has confirmed it yet. While set, a
   *  reading under VOL_DIFF_CRIT_MV ends the episode at once. Cleared by a reading at or above
   *  vdiffCritMvFor(packSoc) and whenever critSinceMs is cleared. Written to the knee-session file
   *  with the clock and restored with it (persistVdiffKneeSessions / restoreVdiffKneeSessions). */
  critSeeded: boolean;
}
export interface VdiffKneeObservation {
  packSn: string | null;
  packSoc: number | null;
  spreadMv: number;
  balancing: boolean;
  /** Pack charge input, W, as the MQTT stream itself delivered it, or null (see vdiffKneeChargeW). */
  chargeW: number | null;
}
/** Which bounded cell-spread mute holds a vdiff-crit (also Alert.mutedBy). */
export type VdiffCritMuteReason = 'balancing' | 'end-of-charge' | 'charging';
/** v1.187.0 — the operator-facing name of each bounded cell-spread mute, stamped on the muted
 *  vdiff-crit as its muteReason (balancing shares the vdiff-warn wording). On 2026-09-29 all
 *  three "held non-annunciating" lines were this mute on home Cores, and the line blamed a bench
 *  spare or an off-panel Core. */
export const CELL_SPREAD_MUTE_TEXT: Record<VdiffCritMuteReason, string> = {
  'balancing': MUTE_REASON_BALANCING,
  'end-of-charge': 'end-of-charge cell-spread relaxation window',
  'charging': `top-of-charge cell spread while charging, at most ${Math.round(VDIFF_KNEE_RELAX_MS / 60_000)} minutes`,
};

/** v1.187.0 — the charge input the knee reads: the pack's inputWatts as the MQTT stream ITSELF
 *  delivered it (DpuPack.streamInputW), at most VDIFF_KNEE_STREAM_FRESH_MS old — else null, no
 *  charge evidence, and the critical keeps only the balancing evidence (fail loud). NEVER the
 *  polled value: the cloud REST poll returns each pack's last NON-ZERO inputWatts (v1.186.2,
 *  snapshot.ts), and on 2026-07-28 (Core 2 pack 2) the recorded input alternated 0 / 564 W for
 *  two minutes after the stream said the pack had stopped charging. Nor liveFlow, which falls
 *  back per field to that polled value when only the output was stream-fresh. */
export function vdiffKneeChargeW(pk: Pick<DpuProjection['packs'][number], 'streamInputW'>, nowMs: number): number | null {
  const s = pk.streamInputW;
  if (s == null || !Number.isFinite(s.w) || !Number.isFinite(s.atMs)) return null;
  return nowMs - s.atMs <= VDIFF_KNEE_STREAM_FRESH_MS ? s.w : null;
}

/** v1.187.0 — advance one pack's knee state by one tick. Pure; the caller owns the map. */
export function advanceVdiffKnee(
  prev: VdiffKneeState | undefined,
  obs: VdiffKneeObservation,
  nowMs: number,
): VdiffKneeState {
  // A state earned by a DIFFERENT pack (swap / renumber) is dropped, as for the warn hold. A
  // missing serial is never evidence of a change.
  const sameHw = prev != null && !(prev.packSn != null && obs.packSn != null && prev.packSn !== obs.packSn);
  const s: VdiffKneeState = sameHw
    ? { ...prev, packSn: obs.packSn ?? prev.packSn, lastSeenMs: nowMs }
    : { packSn: obs.packSn, lastBalancingMs: null, lastChargeMs: null, critSinceMs: null, belowCritSinceMs: null, graceFromMs: null, quietSinceMs: null, lastSeenMs: nowMs, critSeeded: false };
  const topOfCharge = obs.packSoc != null && obs.packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT;
  const onPlateau = obs.packSoc != null && obs.packSoc >= VOL_DIFF_PLATEAU_SOC_PCT;
  const kneeSpread = obs.spreadMv >= VOL_DIFF_WARN_MV;
  if (!topOfCharge) {
    s.lastBalancingMs = null;
    s.lastChargeMs = null;
  } else if (kneeSpread) {
    if (obs.balancing) s.lastBalancingMs = nowMs;
    if ((obs.chargeW ?? 0) > VDIFF_KNEE_CHARGE_W) s.lastChargeMs = nowMs;
  }
  if (!onPlateau) {
    s.critSinceMs = null;
    s.belowCritSinceMs = null;
    s.critSeeded = false;
  } else if (obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) {
    s.critSinceMs ??= nowMs;
    s.belowCritSinceMs = null;
    s.critSeeded = false;
  } else if (s.critSinceMs != null) {
    // Under the plateau line: the episode ends only after an unbroken VDIFF_KNEE_RELAX_MS here, so
    // one sub-line reading cannot reset it. v1.187.1 (log review) — under 50 mV too: a reading
    // under VOL_DIFF_CRIT_MV used to end the episode at once, so a balancing spread alternating
    // 95 / 45 mV restarted the duration bound on every low reading. A clock SEEDED from a persisted
    // onset still ends at once on a reading under 50 mV, as in v1.187.0 — the onset says only that
    // a critical stood before the restart, perhaps a day earlier, and kept for five more minutes it
    // made the next day's benign knee annunciate. v1.187.2 — on ANY reading under 50 mV until a
    // reading at the line confirms it (critSeeded), not only on the first after the restart: a
    // first reading at 50-89 mV kept a day-old onset through the readings under 50 mV after it.
    s.belowCritSinceMs ??= nowMs;
    if ((s.critSeeded && obs.spreadMv < VOL_DIFF_CRIT_MV) || nowMs - s.belowCritSinceMs >= VDIFF_KNEE_RELAX_MS) {
      s.critSinceMs = null;
      s.belowCritSinceMs = null;
      s.critSeeded = false;
    }
  }
  // v1.187.0 (log review) — the session's grace clock (graceFromMs). Started by the first crossing
  // on the plateau and untouched by the critSinceMs resets above. A pack READ below the plateau
  // ends the session: an unknown SoC is not evidence it left (fail loud).
  // …and so does a pack that has RESTED on the plateau: an unbroken VDIFF_KNEE_MAX_MUTE_MS of
  // readings under VOL_DIFF_CRIT_MV (quietSinceMs). A benign pack relaxes to 3-30 mV and can then
  // sit at the top for hours; without the rest, a second benign knee in that stay had no grace
  // and sounded the 09-29 klaxon again. A spread that follows the charge current (95 / 45 mV, or
  // 100 / 45 mV while balancing) is never under 50 mV for 20 minutes, so it keeps its session and
  // its bounds. An unknown SoC neither starts the rest nor ends one it did not break.
  // v1.187.2 — the session runs across the whole plateau (VOL_DIFF_PLATEAU_SOC_PCT), no longer from
  // the top of charge (VOL_DIFF_PLATEAU_QUIET_SOC_PCT) only. Between 85% and 95% the episode clock
  // was the balancing mute's only bound, and dips under the line of VDIFF_KNEE_RELAX_MS or more
  // restart it: a balancing spread at 95 / 45 / 45 mV (a ~180 s BMS cadence), 95 / 45 mV with one
  // reading missed, or 95 / 70 / 70 mV restarted the 20-minute bound on every crossing and was never
  // announced. The session bounds them there as at the top of charge, from the first crossing.
  if (obs.packSoc != null && obs.packSoc < VOL_DIFF_PLATEAU_SOC_PCT) {
    s.graceFromMs = null;
    s.quietSinceMs = null;
  } else {
    if (obs.spreadMv >= VOL_DIFF_CRIT_MV) s.quietSinceMs = null;
    else if (onPlateau) s.quietSinceMs ??= nowMs;
    if (s.quietSinceMs != null && nowMs - s.quietSinceMs >= VDIFF_KNEE_MAX_MUTE_MS) s.graceFromMs = null;
    if (onPlateau && obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) s.graceFromMs ??= s.critSinceMs ?? nowMs;
  }
  return s;
}

/**
 * v1.187.0 (log review) — the knee state a pack STARTS from when it has none (a restart: the state
 * is in memory). The persisted onset of its `vdiff-crit-<sn>-<pk>` (alertOnset.ts), when present,
 * seeds both clocks — critSinceMs and the session's graceFromMs — so an auto-update restart
 * cannot restart the 20-minute bound or re-grant a grace to a critical that was already standing
 * (a restart at minute 21 bought up to 20 more minutes of balancing silence). An onset is at or
 * before the true first crossing, so the bound can only come due sooner (fail loud); advanceVdiffKnee
 * then clears either clock the current reading contradicts. The activity evidence (balancing,
 * charge input) is never seeded: a mute is re-earned from fresh readings. No onset → undefined
 * (a fresh state). An onset ahead of the clock is clamped to now.
 *
 * The SESSION clock is seeded only from an onset at most VDIFF_KNEE_GAP_CARRY_MS old — the cap on
 * carrying it across a reading gap in the process. An onset persisted before a long outage (the
 * add-on down from inside one afternoon's knee to the next morning, the pack discharged and
 * recharged unseen) is not the current session: seeded, it was never ended — no reading below 95%
 * is seen — and the next benign knee had no grace. critSinceMs is still seeded from any onset, so a
 * critical STILL standing starts its session from it on its first reading at the line
 * (graceFromMs ??= critSinceMs) and still fails loud.
 *
 * v1.187.1 — the FALLBACK only: a pack whose session the knee-session file holds starts from that
 * (restoreVdiffKneeSessions — judged by the outage, not by the onset's age, which let a
 * charge-following fault open a new session across a restart). This seed applies to a pack with
 * no persisted entry: a missing, unreadable or malformed file, or an outage longer than the carry.
 *
 * v1.187.2 — the seeded critical-line clock is marked (critSeeded) until a reading at the critical
 * line confirms it, and every reading under 50 mV before that ends it (advanceVdiffKnee). The mark
 * was the first reading after the restart (lastSeenMs null), so a first reading at 50-89 mV on the
 * plateau carried a day-old onset through the readings under 50 mV after it for VDIFF_KNEE_RELAX_MS,
 * and a benign crossing in that window annunciated at once. The seeded SESSION clock is unchanged:
 * like any session it ends below the plateau or after a rest.
 */
export function vdiffKneeSeed(onsetMs: number | undefined, packSn: string | null, nowMs: number): VdiffKneeState | undefined {
  if (onsetMs == null || !Number.isFinite(onsetMs)) return undefined;
  const at = Math.min(onsetMs, nowMs);
  return {
    packSn, lastBalancingMs: null, lastChargeMs: null, critSinceMs: at, belowCritSinceMs: null,
    graceFromMs: nowMs - at <= VDIFF_KNEE_GAP_CARRY_MS ? at : null, quietSinceMs: null, lastSeenMs: null,
    critSeeded: true,
  };
}

/**
 * v1.187.0 — why a vdiff-crit is held non-annunciating this tick, or null when it must
 * annunciate. Order matters: the ceiling and the duration bound come FIRST, so neither the
 * balancing mute nor the end-of-charge grace can outlast them. Off the plateau only the
 * balancing mute (v0.29.0) applies, now under the ceiling.
 */
export function vdiffCritMute(
  s: VdiffKneeState,
  obs: VdiffKneeObservation,
  nowMs: number,
): VdiffCritMuteReason | null {
  if (obs.spreadMv >= VOL_DIFF_KNEE_HARD_MV) return null;
  if (s.critSinceMs != null && nowMs - s.critSinceMs >= VDIFF_KNEE_MAX_MUTE_MS) return null;
  // v1.187.0 (log review) — while a SESSION runs (graceFromMs) the BALANCING mute is bounded by it
  // as well: critSinceMs restarted whenever a reading dipped under 50 mV, so a balancing spread that
  // alternates 95 / 45 mV was held for hours (v1.187.1: critSinceMs now survives such dips, and the
  // session still bounds dips long enough to end the episode). v1.187.2 — the session runs across
  // the whole plateau, so this bound holds between 85% and 95% too, where the episode clock alone
  // let 95 / 45 / 45 mV go unannounced. A reading below the plateau ends the session; a reading
  // with no SoC does not (fail loud).
  if (obs.balancing) {
    return s.graceFromMs != null && nowMs - s.graceFromMs >= VDIFF_KNEE_MAX_MUTE_MS ? null : 'balancing';
  }
  const topOfCharge = obs.packSoc != null && obs.packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT;
  if (!topOfCharge) return null;
  // v1.187.0 (log review) — both graces are bounded by the SESSION (graceFromMs), not by the
  // current crossing: a spread whose dips between readings end the episode restarts critSinceMs,
  // and each crossing used to earn a fresh grace. v1.187.2 — a session that began lower on the
  // plateau bounds them from that first crossing (fail loud).
  if (s.graceFromMs == null) return null;
  if (s.lastBalancingMs != null && nowMs - s.lastBalancingMs < VDIFF_KNEE_RELAX_MS
    && nowMs - s.graceFromMs < VDIFF_KNEE_MAX_MUTE_MS) return 'end-of-charge';
  // Charge input alone: recent, AND inside VDIFF_KNEE_RELAX_MS of the session's first crossing
  // (never later than the current episode's: graceFromMs <= critSinceMs).
  if (s.lastChargeMs != null && nowMs - s.lastChargeMs < VDIFF_KNEE_RELAX_MS
    && nowMs - s.graceFromMs < VDIFF_KNEE_RELAX_MS) return 'charging';
  return null;
}

/* v1.187.0 — knee state per `${sn}-${packNum}`: the same single-call-site module singleton as
 * heldVdiffWarnKeys. A pack with no reading this cycle loses its activity evidence (re-earned
 * from fresh readings) but keeps its critical-line clock for VDIFF_KNEE_GAP_CARRY_MS. */
const vdiffKneeByKey = new Map<string, VdiffKneeState>();

/*
 * v1.187.1 — THE KNEE SESSION ACROSS A RESTART. vdiffKneeSeed restores the session clock from the
 * standing critical's persisted onset, judged by the ONSET's age, and that onset is retired with
 * the tracked alert VDIFF_RESOLVE_DWELL_MS after the critical leaves the set. A fault that follows
 * the charge current crosses the line on isolated readings, so a restart on one of its sub-line
 * readings found either an onset held through the dwell for more than VDIFF_KNEE_GAP_CARRY_MS
 * (95 / 45 mV alternating for over an hour: no session seeded) or none at all (hi / lo / lo: two
 * low readings outlast the dwell), and the next crossing opened a NEW top-of-charge session — up to
 * VDIFF_KNEE_MAX_MUTE_MS more silence after every restart.
 *
 * The clocks are now persisted per pack (`${sn}-${pk}`) in `vdiff-knee-state.json` beside the
 * database (the monitor writes it each tick a persisted value changed; VDIFF_KNEE_STATE_PATH
 * overrides) and restored at start-up by the IN-PROCESS gap rule (computeAlerts' prune): carried
 * while the pack's last reading is at most VDIFF_KNEE_GAP_CARRY_MS old — the outage, never the
 * onset's age — and dropped after it. Persisted: the pack serial, critSinceMs, graceFromMs, the rest
 * (quietSinceMs), the last reading time and (v1.187.2) whether critSinceMs is an unconfirmed seed
 * (critSeeded). Deliberately NOT persisted, exactly as they are not
 * carried across a reading gap in the process: the activity evidence (lastBalancingMs, lastChargeMs
 * — a mute is re-earned from fresh readings) and the under-the-line run (belowCritSinceMs). Each
 * restarts from fresh readings, which can only keep a bound counting (fail loud). Only a pack the
 * file holds no entry for falls back to the onset seed.
 *
 * v1.187.1 (review) — THE REST is persisted too, and restored only across a SHORT outage. Not
 * restored at all, a restart during the rest after a benign knee restarted the rest at the restart,
 * so the restored session stood up to 20 minutes longer than the process would have kept it, and a
 * second benign knee inside that window — two knees of the 09-29 Core 1 pack 1 shape 30 minutes
 * apart, the add-on restarted 12-25 minutes after the first — had no grace and sounded the red
 * klaxon (v1.187.0, whose onset was retired by then, started that pack fresh and stayed silent).
 * The in-process rule ("a rest must be seen unbroken") ends a rest on any unseen tick, but a
 * restart is never seen, so that rule ended EVERY rest across a restart. The rest is restored when
 * the file's last reading — at or before the true one, so its age bounds the outage from above — is
 * at most VDIFF_KNEE_SEEN_PERSIST_MS + VDIFF_KNEE_RELAX_MS old (10 min: at most three ~180 s BMS
 * readings fall inside it, and the last of them is still current at the restart), and cleared
 * otherwise. A fault keeps its bounds: a spread that follows the charge current (95 / 45 mV,
 * hi / lo / lo) breaks its rest on every crossing and never builds 20 minutes under 50 mV, before
 * the restart or after it — even with a crossing hidden inside the outage (the rest then spans at
 * most the low run before it and the low run after it: 2 × 6 + 3 = 15 minutes for hi / lo / lo).
 * The residual: a spread crossing the line on one reading in four or fewer (about every 12 minutes
 * or longer) can have its session ended by a crossing hidden inside a restart's outage — which
 * takes the add-on down for at least one whole ~180 s reading — and its next crossing earns one
 * more session's graces (probe: with 0-120 s down no restart offset left any critical tick quieter
 * than the process; with 4-9 minutes down some offsets left 3-6 minutes of that sparse spread's
 * critical ticks silent). A spread with 20 minutes under 50 mV between crossings ends its session
 * in the process alike.
 */
/** v1.187.1 — the part of a pack's knee state that survives a restart (the clocks, never the evidence). */
export interface VdiffKneeSession {
  packSn: string | null;
  critSinceMs: number | null;
  graceFromMs: number | null;
  /** v1.187.1 (review) — the rest at the top of charge (restored only across a short outage). */
  quietSinceMs: number | null;
  /** v1.187.2 — present (true) only while critSinceMs is an unconfirmed seed (VdiffKneeState.critSeeded). */
  critSeeded?: true;
  /** The pack's last reading, floored to VDIFF_KNEE_SEEN_PERSIST_MS: the true one lies in
   *  [this, this + VDIFF_KNEE_SEEN_PERSIST_MS). */
  lastSeenMs: number;
}
/** v1.187.1 — the persisted sessions, keyed `${sn}-${pk}`, as they stand on disk. */
export type VdiffKneeSessions = Record<string, VdiffKneeSession>;
/** v1.187.1 — the grain of the persisted last-reading time. It moves on every reading, and a write
 *  per reading would be a write per tick, so it is persisted FLOORED to this grain: it changes once
 *  per grain, and (v1.187.1 review) on the same tick for every pack seen — one write per grain
 *  however many packs hold a session, where a per-pack "moved more than the grain" rule let the
 *  packs drift out of phase (N packs, up to N writes per grain). The restore reads it as the latest
 *  the true reading can have been (onDisk + this − 1 ms, capped at now): an entry the process would
 *  still have carried is never dropped early, and that bound floors back to the same value, so
 *  restarts that see no reading cannot walk it forward. */
export const VDIFF_KNEE_SEEN_PERSIST_MS = 5 * 60_000;

const isClock = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
/** One persisted entry, or null when it is not a session (wrong types, or no clock to carry). A
 *  missing rest reads as none (it is restored only when present: fail loud). */
function parseVdiffKneeSession(v: unknown): VdiffKneeSession | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!(o.packSn === null || typeof o.packSn === 'string')) return null;
  if (!isClock(o.critSinceMs) || !isClock(o.graceFromMs)) return null;
  const quietSinceMs = o.quietSinceMs === undefined ? null : o.quietSinceMs;
  if (!isClock(quietSinceMs)) return null;
  if (typeof o.lastSeenMs !== 'number' || !Number.isFinite(o.lastSeenMs)) return null;
  if (o.critSinceMs == null && o.graceFromMs == null) return null;
  if (!(o.critSeeded === undefined || typeof o.critSeeded === 'boolean')) return null;
  return {
    packSn: o.packSn, critSinceMs: o.critSinceMs, graceFromMs: o.graceFromMs, quietSinceMs, lastSeenMs: o.lastSeenMs,
    ...(o.critSeeded === true ? { critSeeded: true as const } : {}),
  };
}

/**
 * v1.187.1 (log review) — whether a persisted rest is one the process could have been in: an
 * UNFINISHED rest inside a running session. A crossing breaks a rest, so it began after
 * the session's first crossing (graceFromMs) and, when an episode still stands, after that episode's
 * first crossing (critSinceMs: the episode outlives the first VDIFF_KNEE_RELAX_MS of a rest); and it
 * began less than VDIFF_KNEE_MAX_MUTE_MS before the last reading (a rest that long had already ended
 * the session). Anything else came from a corrupt file — 0, a negative clock, a rest before the
 * session — and is not restored (fail loud: the rest starts over from fresh readings). Restored, a
 * rest dated far enough back ended a running session on the first reading under 50 mV and granted
 * the next crossing fresh graces.
 */
function vdiffKneeRestCoherent(s: VdiffKneeSession): boolean {
  const q = s.quietSinceMs;
  return q != null && s.graceFromMs != null && q > s.graceFromMs
    && (s.critSinceMs == null || q > s.critSinceMs)
    && s.lastSeenMs - q < VDIFF_KNEE_MAX_MUTE_MS;
}

/**
 * v1.187.1 — read `path` and restore its sessions into the knee map (start-up, before the first
 * computeAlerts). Logs exactly one line. A missing, unreadable or malformed file restores nothing:
 * every pack then starts from vdiffKneeSeed, as in v1.187.0 (fail loud for a standing critical); a
 * malformed ENTRY is skipped and counted. An entry whose pack's last reading is more than
 * VDIFF_KNEE_GAP_CARRY_MS old (read as the latest it can have been, within the grain) is dropped —
 * the outage outlasted the carry, as for a pack unseen that long in the process. The rest is
 * restored only when the file's last reading is at most VDIFF_KNEE_SEEN_PERSIST_MS +
 * VDIFF_KNEE_RELAX_MS old (see above), and (log review) only when it is coherent
 * (vdiffKneeRestCoherent). A clock ahead of now (a clock step) is clamped to now. A key
 * already in memory is left alone. Returns the sessions as they stand on disk: the baseline
 * persistVdiffKneeSessions compares against.
 */
export function restoreVdiffKneeSessions(path: string, nowMs: number, log: (m: string) => void): VdiffKneeSessions {
  const fallback = 'each pack starts from its standing critical\'s persisted onset';
  let raw: unknown;
  try {
    if (!existsSync(path)) {
      log(`cell spread: no knee-session state at ${path} — ${fallback}`);
      return {};
    }
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    log(`cell spread: knee-session state at ${path} is unreadable (${e instanceof Error ? e.message : String(e)}) — ignored; ${fallback}`);
    return {};
  }
  const body = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { sessions?: unknown }).sessions : undefined;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    log(`cell spread: knee-session state at ${path} is malformed (no sessions record) — ignored; ${fallback}`);
    return {};
  }
  const onDisk: VdiffKneeSessions = {};
  let restored = 0, outlasted = 0, malformed = 0;
  for (const [key, v] of Object.entries(body)) {
    const s = parseVdiffKneeSession(v);
    if (s == null) { malformed++; continue; }
    onDisk[key] = s;
    if (vdiffKneeByKey.has(key)) continue;
    const seenMs = Math.min(nowMs, s.lastSeenMs + VDIFF_KNEE_SEEN_PERSIST_MS - 1);
    if (nowMs - seenMs > VDIFF_KNEE_GAP_CARRY_MS) { outlasted++; continue; }
    // v1.187.1 (review) — the rest survives only an outage too short to have hidden more than a
    // reading or two; judged by the file's own last reading (an upper bound on the outage).
    const restCarried = s.quietSinceMs != null && nowMs - s.lastSeenMs <= VDIFF_KNEE_SEEN_PERSIST_MS + VDIFF_KNEE_RELAX_MS;
    // v1.187.1 (log review) — …and only when it is a rest the process could have been in.
    const restCoherent = vdiffKneeRestCoherent(s);
    vdiffKneeByKey.set(key, {
      packSn: s.packSn, lastBalancingMs: null, lastChargeMs: null,
      critSinceMs: s.critSinceMs == null ? null : Math.min(s.critSinceMs, nowMs), belowCritSinceMs: null,
      graceFromMs: s.graceFromMs == null ? null : Math.min(s.graceFromMs, nowMs),
      quietSinceMs: restCarried && restCoherent ? Math.min(s.quietSinceMs!, nowMs) : null,
      lastSeenMs: seenMs,
      // v1.187.2 (review) — an unconfirmed seed stays one across a restart (see persistVdiffKneeSessions).
      critSeeded: s.critSinceMs != null && s.critSeeded === true,
    });
    restored++;
  }
  log(`cell spread: restored ${restored} knee session(s) from ${path}`
    + (outlasted ? `; ${outlasted} dropped (last reading more than ${Math.round(VDIFF_KNEE_GAP_CARRY_MS / 60_000)} minutes before the restart)` : '')
    + (malformed ? `; ${malformed} malformed entr${malformed === 1 ? 'y' : 'ies'} ignored` : ''));
  return onDisk;
}

/**
 * v1.187.1 — write the knee sessions to `path` when a persisted value differs from `onDisk` (the
 * value last written): a pack serial, a clock or the rest, an entry gained or lost, or the last
 * reading entering a new VDIFF_KNEE_SEEN_PERSIST_MS grain. Nothing changed → no write. Only packs
 * holding a clock are written (the rest carry nothing — computeAlerts' prune drops them too).
 * Returns what is now on disk: `onDisk` again when nothing changed or the write failed (retried on
 * the next tick). Best-effort — never throws into the alarm loop. Main thread only, like the map.
 *
 * v1.187.2 — a critical-line clock still SEEDED (critSeeded: from an onset, not yet confirmed by a
 * reading at the line) is written with its mark, and the restore keeps the mark. Without it the
 * restore read every clock on file as one a process had seen: a day-old onset written there and
 * restored by a second restart was no longer ended by a reading under 50 mV, and a benign crossing
 * annunciated at once. Written as none instead (the review of this release), the second restart lost
 * the clock: the onset is pruned on the first post-restart tick (the critical is absent while the
 * seed is unconfirmed), so a fault the onset still named started a fresh 20-minute mute.
 */
export function persistVdiffKneeSessions(path: string, onDisk: VdiffKneeSessions): VdiffKneeSessions {
  const next: VdiffKneeSessions = {};
  let changed = false;
  for (const [key, st] of vdiffKneeByKey) {
    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null) continue;
    const d = onDisk[key];
    const lastSeenMs = Math.floor(st.lastSeenMs / VDIFF_KNEE_SEEN_PERSIST_MS) * VDIFF_KNEE_SEEN_PERSIST_MS;
    next[key] = {
      packSn: st.packSn, critSinceMs: st.critSinceMs, graceFromMs: st.graceFromMs, quietSinceMs: st.quietSinceMs, lastSeenMs,
      ...(st.critSeeded ? { critSeeded: true as const } : {}),
    };
    if ((d?.critSeeded === true) !== st.critSeeded) changed = true;
    if (d == null || d.packSn !== st.packSn || d.critSinceMs !== st.critSinceMs || d.graceFromMs !== st.graceFromMs
      || d.quietSinceMs !== st.quietSinceMs || d.lastSeenMs !== lastSeenMs) changed = true;
  }
  if (!changed && Object.keys(onDisk).every((key) => key in next)) return onDisk;
  try {
    atomicWriteFileSync(path, JSON.stringify({ sessions: next }));
    return next;
  } catch {
    return onDisk;
  }
}

/*
 * v1.187.0 — CELL OVERVOLTAGE. Nothing alarmed on the one top-of-charge hazard that matters:
 * a cell running toward its overvoltage limit (no alert read maxCellVoltageMv). LFP cells are
 * rated to ~3.65 V; the highest cell this fleet has reported is 3.533 V (Core 2 pack 5,
 * 2026-09-18), and 3.532 V before that (2026-07-23), across every pack since 2026-07-02.
 * 3.600 V sits 67 mV above the observed maximum and 50 mV below the rated limit. A reading at
 * or above CELL_OVP_IMPLAUSIBLE_MV is not a measurement (65535 is the BMS's uint16 "unknown"
 * sentinel; none was ever recorded) and raises nothing — null over fabrication.
 */
export const CELL_OVP_CRIT_MV = 3600;
export const CELL_OVP_IMPLAUSIBLE_MV = 5000;
const SOH_WARN_PCT = 85;
const SOH_CRIT_PCT = 75;
const PACK_SOC_LOW_PCT = 10;
const PACK_IMBALANCE_WARN_PCT = 15;
const STALE_MS = 3 * 60 * 1000;
const CIRCUIT_BREAKER_WARN_FRAC = 0.9;

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function classifyTemp(tempC: number, band: TempBand): Severity | null {
  const f = cToF(tempC);
  if (band.critF != null && f >= band.critF) return 'critical';
  if (f >= band.warnF) return 'warning';
  if (f >= band.infoF) return 'info';
  return null;
}

function tempAlert(opts: {
  idBase: string;
  device: string;
  label: string;
  tempC: number | null | undefined;
  band: TempBand;
}): Alert | null {
  if (opts.tempC == null) return null;
  const sev = classifyTemp(opts.tempC, opts.band);
  if (!sev) return null;
  const f = Math.round(cToF(opts.tempC));
  const verb = sev === 'critical' ? 'overheating' : sev === 'warning' ? 'running hot' : 'getting warm';
  const limit = sev === 'critical' ? opts.band.critF : sev === 'warning' ? opts.band.warnF : opts.band.infoF;
  return {
    id: `${opts.idBase}-${sev}`,
    severity: sev,
    category: 'Thermal',
    device: opts.device,
    title: `${opts.label} ${verb}`,
    detail: `${opts.label} at ${f}°F (${sev} ≥ ${limit}°F).`,
  };
}

/** Extract the Core (DPU) number from a device name like "Core 3". */
function dpuNum(name: string): number | null {
  const m = name.match(/core\s*(\d+)/i) ?? name.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Connectivity context for the alerts engine (v0.7.7) — lets the offline-
 * device alert tell you when we last actually heard from EcoFlow Cloud about
 * a device, and lets us surface a "cloud session stale" alert when the REST
 * `/device/list` poll itself has stopped succeeding (in that case the per-
 * device `online` flags can't be trusted).
 */
export interface ConnectivityContext {
  lastDeviceListAttemptAt: number;   // 0 = never attempted
  lastDeviceListSuccessAt: number;   // 0 = never succeeded
  perDevice: Map<string, {
    lastMqttAt?: number; lastSource?: 'rest' | 'mqtt'; mqttCount: number;
    /** v1.187.1 — when this process first saw the device in /device/list (SnapshotStore.firstListedAt). */
    firstListedAtMs?: number | null;
  }>;
  /** v1.8.0 (review F3) — ms epoch when the SHP2's published backup-pool % went
   *  null (post-grace-hold; SnapshotStore.backupPoolUnknownSince), or null while
   *  readable. Drives the reserve-alarm-blind compensating alert. */
  backupPoolUnknownSinceMs?: number | null;
  /** v1.185.0 — the same onset for EVERY panel, keyed by serial (a secondary panel's own
   *  reserve-alarm-blind alert reads its entry). */
  backupPoolUnknownSinceBySn?: Map<string, number | null>;
  /** v1.185.0 — when each panel was first listed in this process (SnapshotStore.firstListedAt): a
   *  panel with no projection since then has had an unreadable pool at least that long. */
  panelFirstListedBySn?: Map<string, number | null>;
  /** v1.11.0 (review F8) — per-DPU inverter-error onset (SnapshotStore.dpuErrOnset),
   *  keyed by SN. The `dpu-err` CRITICAL is held until the SAME nonzero code has
   *  stood for DPU_ERR_DEBOUNCE_MS, so a cloud-reconnect blip (nonzero for
   *  20-160s, then clears) never reaches HA's critical_alerts sensor. */
  dpuErrOnsetBySn?: Map<string, { code: number; sinceMs: number }>;
  /** v1.14.0 (live 05:35 flap) — per-SHP2-slot source-error onset, keyed
   *  `<sn>:<slot>` (SnapshotStore.shp2SrcErrOnsets). The `shp2-src-err-<slot>`
   *  CRITICAL is held until the SAME nonzero error count has stood for the
   *  shared 3-min debounce — a 60-s transient device-reported error fired a
   *  full audible red broadcast + HA critical push at 05:35 on 2026-07-12. */
  shp2SrcErrOnsetBySlot?: Map<string, { count: number; sinceMs: number }>;
  /** v1.174.0 (live 06:58 + 07:33 sunrise blips) — per-DPU MPPT string error onset,
   *  keyed `<sn>:hv` / `<sn>:lv` (SnapshotStore.mpptErrOnsets). The dpu-pvh-err /
   *  dpu-pvl-err WARNING is held until the SAME non-zero code has stood, while the
   *  string was producing, for MPPT_ERR_DEBOUNCE_MS. The sunrise ramp reports a
   *  benign standby code on a string that IS producing (407 W / 1.38 A), which the
   *  producing test alone cannot reject — it was derived from sunset, where a
   *  shedding string makes no watts. */
  mpptErrOnsetByKey?: Map<string, { code: number; sinceMs: number }>;
}

/** Format an age in ms as the most natural short human string. */
function fmtAge(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '∞';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

// `/device/list` polls every 60 s by default; if we haven't had a successful
// poll in 5 min the session is genuinely stale and any "online: 0" we're
// showing is unreliable.
const CLOUD_SESSION_STALE_MS = 5 * 60 * 1000;
// v1.8.0 (review F3) — reserve-alarm-blind debounce + escalation windows. 15 min
// of sustained pool-unreadability (well past the 3-min grace hold) before the
// warning fires; 60 min blind while NOT grid-backstopped escalates to critical
// (the escalation re-triggers the push channel via the alert monitor).
const RESERVE_BLIND_AFTER_MS = 15 * 60 * 1000;
const RESERVE_BLIND_CRITICAL_MS = 60 * 60 * 1000;
// v1.11.0 (review F8) — an inverter error must stand this long before the CRITICAL
// fires. The observed reconnect blips cleared within 20-160s; 3 min clears them all
// with margin while a genuine fault (which persists indefinitely) is delayed only
// one alarm-eval cycle past the window.
const DPU_ERR_DEBOUNCE_MS = 3 * 60 * 1000;
/** v1.174.0 — the same 3-minute window for the MPPT string error codes (dpu-pvh-err /
 *  dpu-pvl-err). Both observed sunrise false alarms lasted ~60 s, as did the 2026-08-30
 *  one; a string genuinely faulting while producing still reports its code three minutes
 *  later, so the warning is delayed, never lost. Shares the DPU window deliberately —
 *  one debounce period for device-reported error codes, not a second tunable. */
const MPPT_ERR_DEBOUNCE_MS = DPU_ERR_DEBOUNCE_MS;

/* v1.45.0 — host-pressure crit dwell. The vitals assessment escalates
 * instantly (correct for QoS), but the RED ANNUNCIATION requires the crit to
 * sustain: 1-3-minute load spikes from the nightly backup / boot / store
 * refresh are real pressure yet not red-klaxon events. Pure over (level, now)
 * with a module holder, mirroring heldHostTempLevel. */
export const HOST_PRESSURE_CRIT_DWELL_MS = (() => {
  const v = Number(process.env.HOST_PRESSURE_CRIT_DWELL_S);
  return Number.isFinite(v) && v >= 0 && v <= 900 ? v * 1000 : 180_000;
})();
let hostPressureCritSinceMs: number | null = null;
export function hostPressureCritSustained(level: 'ok' | 'warn' | 'crit', now: number): boolean {
  if (level !== 'crit') { hostPressureCritSinceMs = null; return false; }
  hostPressureCritSinceMs ??= now;
  return now - hostPressureCritSinceMs >= HOST_PRESSURE_CRIT_DWELL_MS;
}
export function _resetHostPressureDwellForTest(): void { hostPressureCritSinceMs = null; }

/**
 * v1.140.0 — is this DPU evaluable this tick? Shared by the pack loop and the
 * defective-pack retirement set so the two cannot drift: retirement reads a
 * collection built by this filter, and if it disagreed with the loop gate the
 * fix would reintroduce the defect it closes.
 */
function isDpuEvaluable(d: DeviceSnapshot): boolean {
  return !!d.online && !!d.projection;
}

export function computeAlerts(
  devices: Record<string, DeviceSnapshot>,
  connectivity?: ConnectivityContext,
  /** v0.23.0 — when the grid is backstopping the home, a backup pool at/below
   *  the reserve floor merely transfers to mains, so the reserve alerts are
   *  downgraded from critical to an on-screen advisory. Omitted ⇒ treat as
   *  off-grid (reserve alerts stay critical — the safe default).
   *  v0.43.0 — also carries `present` (the GridBackstop resolver's grid-availability
   *  signal) so the off-grid alert can use the same source of truth as
   *  binary_sensor.off_grid / /api/ha-state instead of the obsolete acIn<5 heuristic. */
  grid?: { present?: boolean; backstopping: boolean; reason?: string; importLive?: boolean },
  /** v1.185.0 — each pool's own grid verdict (gridState.livePoolGridBackstop), supplied only on a
   *  multi-panel plant; the pool alarms read it instead of the plant verdict. */
  poolGrid?: (panelSn: string) => { present?: boolean; backstopping: boolean; reason?: string; importLive?: boolean },
): Alert[] {
  const out: Alert[] = [];
  // v1.21.0 (F28) — vdiff keys observed (non-null reading) this cycle; held
  // rise-hysteresis state for any key NOT seen is pruned at the end of the
  // device loop, so a data gap or offline device resets the episode.
  const seenVdiffKeys = new Set<string>();
  const list = Object.values(devices);
  const now = Date.now();

  // v0.7.7 — cloud-session-stale check. If we haven't had a successful
  // /device/list response in CLOUD_SESSION_STALE_MS, the per-device online
  // flags we're displaying are last-known values, not current state. Tell
  // the user we don't actually know whether anything is offline right now
  // — that's the actual diagnosis, not "your panel is offline".
  if (connectivity) {
    const successAt = connectivity.lastDeviceListSuccessAt;
    const attemptAt = connectivity.lastDeviceListAttemptAt;
    if (attemptAt > 0 && (successAt === 0 || now - successAt > CLOUD_SESSION_STALE_MS)) {
      const sinceSuccess = successAt === 0 ? '∞' : fmtAge(now - successAt);
      out.push({
        id: 'cloud-session-stale',
        severity: 'warning',
        category: 'Connectivity',
        device: 'EcoFlow Cloud',
        title: 'EcoFlow Cloud session stale',
        detail: `Haven't received a fresh /device/list response in ${sinceSuccess}. Per-device online/offline indicators below reflect the last successful poll, NOT current state. Most likely an EcoFlow Cloud or network blip; usually self-recovers within a few minutes.`,
        facts: [
          { label: 'Last successful poll', value: sinceSuccess + ' ago' },
          { label: 'Last attempt', value: attemptAt > 0 ? fmtAge(now - attemptAt) + ' ago' : 'never' },
          { label: 'Threshold', value: fmtAge(CLOUD_SESSION_STALE_MS) },
        ],
      });
    }
  }

  // v1.129.0 — MULTI-PANEL GUARD. Everything below this line resolves ONE SHP2
  // and reports its pool, reserve floor, runway and grid numbers as if they were
  // the plant's. That is true for one panel and silently false for two, and the
  // silence is the dangerous part: Cores wired to a second panel are absent from
  // the primary panel's sources[], so they read as off-panel hardware and their
  // alerts are demoted to annunciate:false — no chime, no speech, no push — for
  // every fault class except overheating.
  //
  // This does not try to make the numbers right. It says LOUDLY that they
  // describe one panel, and (see alertMonitor + the write interlock) withdraws
  // the app's licence to mute the other panel's hardware or write to a panel it
  // cannot identify. Detected on STATE, so it fires whenever the second panel
  // appears rather than needing anyone to be watching; and detected on product
  // identity as well as projection, so it is already standing during the
  // pre-hydration window in which the demotion streaks are accumulating.
  // v1.185.0 — a second panel is SUPPORTED now (each panel carries its own reserve, SoC and
  // runway alarms; night charge writes only to the pinned house panel). What remains unsafe is a
  // plant with two panels and NO house panel pinned, so this stands only in that state.
  const panels = shp2Panels(devices);
  // v1.185.0 (review) — and while the PINNED house panel is missing from the account: nothing is
  // retargeted, so night charge is paused and the operator must say which panel is the house.
  const missingPin = list.find((d) => d.housePanelMissing != null)?.housePanelMissing;
  if (missingPin || (panels.sns.length > 1 && !list.some((d) => d.housePanel === true))) {
    const primary = panels.primarySn;
    const primaryPanel = primary ? devices[primary] : undefined;
    const primarySources = new Set(
      ((primaryPanel?.projection?.kind === 'shp2'
        ? (primaryPanel.projection as Shp2Projection).sources
        : undefined) ?? []
      ).map((s) => s.sn).filter((sn): sn is string => !!sn),
    );
    const strandedDpus = list
      .filter((d) => d.projection?.kind === 'dpu' && !primarySources.has(d.sn))
      .map((d) => d.sn);
    out.push({
      id: 'shp2-multi-panel',
      severity: 'critical',
      category: 'SHP2',
      priority: 'critical',
      device: 'System',
      sourceSn: primary,
      title: missingPin ? 'House panel not on the account' : 'Two smart panels, house panel not identified',
      detail: missingPin
        ? 'The smart panel pinned as the house panel has not been in the device list for several ' +
          'polls. Nothing is retargeted: night charge is paused until it returns or another panel ' +
          'is pinned as the house panel. Every panel present still carries its own backup pool, ' +
          'reserve and runway alarms.'
        : 'Two Smart Home Panels are present on this account and none is pinned as the ' +
          'house panel. Night charge writes only to the house panel, so its supervised ' +
          'writes are refused until one is pinned. Each panel still carries its own ' +
          'backup pool, reserve and runway alarms.',
      facts: [
        // Serials live in facts, never in the spoken title/detail — verbalizeForTts
        // should never have to read one aloud.
        { label: 'Panels', value: panels.sns.join(', ') },
        ...(missingPin ? [{ label: 'Pinned house panel (missing)', value: missingPin }] : []),
        { label: 'Dashboard shows', value: primary ?? 'unknown' },
        { label: 'Cores not on that panel', value: strandedDpus.length ? strandedDpus.join(', ') : 'none' },
        { label: 'Hydrated projections', value: `${panels.projectedCount} of ${panels.sns.length}` },
        { label: 'To resolve', value: 'pin the house panel on the dashboard (POST /api/house-panel)' },
        {
          label: 'While this stands',
          value: 'supervised reserve / Charge-Now writes are blocked (revert still allowed)',
        },
      ],
    });
  }

  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const shp2 = findShp2(devices) as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;

  // Grid-tied = AC input on an SHP2-bound DPU (the house's grid path). A spare
  // DPU plugged into a wall to self-charge must NOT register as grid power.
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  // Only SHP2-bound cores count as grid import. When the source set is unknown
  // (no SHP2 observed yet) count NONE — a wall-charging spare must never suppress
  // the off-grid advisory, and acIn=0 keeps the safe "off-grid" default (v0.43.0,
  // Copilot review). Note this `acIn` path is the FALLBACK only — when the grid
  // resolver is supplied (always, in production) the off-grid decision uses
  // `grid.present` and never reaches here.
  const acIn = dpus
    .filter((d) => d.online && sourceSns.has(d.sn))
    .reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  // v0.43.0 — off-grid detection now uses the grid-presence RESOLVER (the same
  // `present` signal driving binary_sensor.off_grid and /api/ha-state since v0.40.0),
  // not the obsolete DPU acIn<5 sum. acIn reads 0 whenever PV/battery covers DPU
  // charging EVEN WHILE the grid carries home load directly through the SHP2 main, so
  // the old heuristic fired "Running off-grid" 24/7 on a grid-tied home (a live false
  // alert). When `present` is supplied we trust it; when grid is omitted entirely we
  // fall back to acIn<5 (and the safe default stays "off-grid" → alert visible).
  const offGrid = grid?.present === true ? false : grid?.present === false ? true : acIn < 5;
  if (offGrid) {
    out.push({ id: 'grid-offgrid', severity: 'info', category: 'Grid', device: 'System', title: 'Running off-grid', detail: 'No grid connection detected — home running on solar + batteries.' });
  }

  // v1.6.0 — host power self-monitor. The Pi running this alarm is the whole
  // monitor's single point of failure: if it browns out, every channel goes
  // dark at once. HOST_POWER_ENTITY (HA's RPi Power Supply Checker, a
  // device_class=problem binary_sensor) trips on kernel under-voltage BEFORE
  // the Pi dies, so surface it as an early warning to fix the supply/circuit
  // while the alarm is still up. Dormant unless the entity is configured.
  const hostPower = liveHostPower();
  if (hostPower.underVoltage === true) {
    out.push({
      id: 'host-power-undervoltage',
      severity: 'warning',
      category: 'Connectivity',
      device: 'System',
      title: 'Alarm host power — under-voltage',
      detail: `The Raspberry Pi running this monitor reported under-voltage (${hostPower.entityId}). A marginal or failing power supply — or a sagging power circuit — can brown the host out and take the whole alarm dark. Check the Pi's supply and the circuit it's on before that happens.`,
    });
  }

  // v1.42.0 — alarm-host SoC temperature (heat-event tripwire). Fires from the
  // kernel thermal zones via hostThermal.ts with rise/clear hysteresis; silent
  // (no alert, no fabricated reading) when no zone is readable. The critical
  // sits just below the Pi's ~85 °C throttle point because throttling degrades
  // the alarm pipeline exactly when extreme ambient heat makes it matter most.
  const hostTemp = liveHostTemp(now);
  if (hostTemp) {
    heldHostTempLevel = hostTempLevel(hostTemp.tempC, heldHostTempLevel);
    if (heldHostTempLevel !== 'ok') {
      const crit = heldHostTempLevel === 'crit';
      out.push({
        id: crit ? 'host-temp-crit' : 'host-temp-warn',
        severity: crit ? 'critical' : 'warning',
        category: 'Connectivity',
        device: 'System',
        title: crit ? 'Alarm host overheating' : 'Alarm host running hot',
        detail: `The host running this monitor reads ${hostTemp.tempC.toFixed(0)}°C at the SoC — ${crit ? `at the pre-throttle line (≥ ${HOST_TEMP_CRIT_C}°C; throttling begins ~85°C and slows the alarm pipeline)` : `above the ${HOST_TEMP_WARN_C}°C action threshold`}. Improve airflow around the host or relocate it somewhere cooler.`,
        facts: [
          { label: 'SoC temperature', value: `${hostTemp.tempC.toFixed(1)}°C` },
          { label: 'Warning / critical', value: `${HOST_TEMP_WARN_C}°C / ${HOST_TEMP_CRIT_C}°C (throttle ~85°C)` },
        ],
      });
    }
  }

  // v1.43.0 — co-tenant degradation (host pressure). One ROLLED alert (not a
  // family per dimension): the assessment's reasons already name each pressured
  // dimension with its value, and a starved host is one operator situation, not
  // four. Hysteresis lives in assessVitals; absence of vitals (unreadable
  // /proc) produces no alert — null over fabrication.
  const vitals = currentAssessment();
  if (vitals && vitals.level !== 'ok') {
    // v1.45.0 — the CRITICAL must SUSTAIN before it annunciates red. Ground
    // truth (2026-07-23): four crit episodes in 9.5 h, each 1-3 min — boot
    // load, a store refresh, and the nightly backup's docker exports; the
    // 05:00:50 episode triggered a red broadcast about the backup itself.
    // Transient spikes now surface immediately as the WARNING; the critical
    // (and its red broadcast) fires only once crit pressure has stood for the
    // dwell. QoS/degraded-mode is driven by the assessment level directly and
    // still engages instantly — only the annunciation waits.
    const crit = vitals.level === 'crit' && hostPressureCritSustained(vitals.level, now);
    out.push({
      id: crit ? 'host-pressure-crit' : 'host-pressure-warn',
      severity: crit ? 'critical' : 'warning',
      category: 'Connectivity',
      device: 'System',
      title: crit ? 'Alarm host under critical pressure' : 'Alarm host under pressure',
      detail: `The host running this monitor shows resource pressure — ${vitals.reasons.join('; ')}. Another add-on is likely consuming the host; check the Home Assistant add-on pages for the top CPU/memory consumer. Alert delivery may be delayed while pressure persists${crit ? ' (discretionary analytics are paused to protect the alarm path)' : ''}.`,
      facts: vitals.reasons.map((r, i) => ({ label: `Signal ${i + 1}`, value: r })),
    });
  } else {
    hostPressureCritSustained('ok', now); // clears the dwell holder between episodes
  }

  // v1.44.0 — dead-voice self-alert. A wedged TTS engine hides behind the
  // audio cache (identical messages keep playing from disk), so render health
  // is tracked per FRESH render request: ≥ 2 consecutive failures means the
  // alarm's VOICE is degraded even though chimes still deliver. Auto-resolves
  // when a fresh render succeeds.
  const tts = ttsRenderHealth();
  if (tts.consecutiveFailures >= 2) {
    out.push({
      id: 'tts-render-degraded',
      severity: 'warning',
      category: 'Connectivity',
      device: 'System',
      title: 'Alarm voice degraded — TTS renders failing',
      detail: `Spoken announcements are failing to render (${tts.consecutiveFailures} consecutive failures; last: ${tts.lastFailureReason ?? 'unknown'}). Critical chimes still deliver, but alerts play WITHOUT speech. Known cause: a Home Assistant Core update can wedge the Piper add-on's Wyoming socket — restart the Piper add-on, then any changed alert message will re-render.`,
      facts: [
        { label: 'Consecutive render failures', value: String(tts.consecutiveFailures) },
        { label: 'Last error', value: tts.lastFailureReason ?? '—' },
        { label: 'Remedy', value: 'Restart the Piper add-on (core_piper)' },
      ],
    });
  }

  // v0.16.4 — designated bench spares (Core 4/5) are intentionally kept powered
  // down and are NOT wired into the SHP2, so their EcoFlow-offline / stale state
  // is an EXPECTED steady state, not an event. Such a DPU's connectivity alert
  // is emitted non-annunciating (visible in the UI, but no chime/push/condition
  // raise — see the offline/stale branches below). The SPARE_DPU_SNS allowlist
  // is the safety FLOOR: a real home core (1/2/3) is never in it, so even a
  // faulted/unplugged home core — which drops out of the SHP2's connected
  // sources — still annunciates its genuine offline alarm. The positive
  // connected-source check re-arms a spare the moment it's wired into an SHP2.
  // v0.52.0 — compute the connected-source Set ONCE, then delegate each
  // membership check to the shared shp2Membership.isExpectedOfflineSpare,
  // passing the Set so no per-call rescan of `devices` happens at the hot
  // sites below. Behavior is identical to the former local closure
  // (`SPARE_DPU_SNS.has(sn) && !shp2Connected.has(sn)`).
  const shp2Connected = shp2ConnectedDpuSns(devices);
  const isExpectedOfflineSpare = (sn: string): boolean =>
    isExpectedOfflineSpareShared(sn, shp2Connected);

  for (const d of list) {
    const isCore = d.productName.toLowerCase().includes('delta pro ultra');
    const spare = isCore && isExpectedOfflineSpare(d.sn);
    const coreNum = isCore ? dpuNum(d.deviceName) : null;
    if (!d.online) {
      const isPanel = d.productName.toLowerCase().includes('smart home panel');
      // v0.7.7 — enrich the offline alert with WHEN we last actually heard
      // from the device and via which channel. A 47-min gap with last data
      // via MQTT looks very different from "never connected since boot".
      const conn = connectivity?.perDevice.get(d.sn);
      // v1.187.1 (review) — "reported this session" is decided from DATA, not from `lastUpdated`:
      // setDeviceOnline bumps that on a bare /status flip (deliberately, for the stale alarm), so a
      // device that had sent nothing but one online→offline flip read "Last data 0s ago via REST.
      // Just dropped" — and 30 minutes on, the "lost its cloud connection … power-cycle" hint. The
      // data setters (setDeviceQuota, mergeDeviceQuota, setMqttMessage) are the only writers of a
      // last source, an MQTT time or the telemetry clocks.
      const hasData = conn?.lastSource != null || conn?.lastMqttAt != null
        || (d.lastTelemetryAtMs ?? 0) > 0 || (d.lastQuotaAtMs ?? 0) > 0;
      const lastDataAt = hasData ? (conn?.lastMqttAt ?? d.lastUpdated ?? 0) : 0;
      const lastSource = conn?.lastSource ?? 'rest';
      const facts: Array<{ label: string; value: string }> = [
        { label: 'Reported by', value: 'EcoFlow Cloud /device/list' },
        // v1.143.0 — WHICH input observed the transition, and when. Two paths
        // write `online` (the cloud list poll and the MQTT /status topic) and
        // they can disagree by tens of seconds, which shifts the dispatch dwell
        // and decides whether this alert ever reaches a phone. On 2026-09-09 two
        // home Cores went offline in the same cloud-list poll and only one paged
        // — correctly, on a 59-vs-60-second margin — and nothing in the alert
        // said why. Now it does.
        ...(d.onlineChangedAtMs
          ? [{
              label: 'Observed offline via',
              value: `${d.onlineChangedVia === 'status' ? 'MQTT /status' : 'EcoFlow Cloud /device/list'} — ${fmtAge(now - d.onlineChangedAtMs)} ago`,
            }]
          : []),
        { label: 'Last data', value: lastDataAt > 0 ? `${fmtAge(now - lastDataAt)} ago (${lastSource.toUpperCase()})` : 'no data this session' },
        { label: 'MQTT msg count', value: conn?.mqttCount != null ? String(conn.mqttCount) : '—' },
      ];
      // Append a one-line action hint matched to the most likely cause.
      // v1.187.1 — NO DATA THIS SESSION IS NOT A MEASURED GAP. lastDataAt = 0 means nothing has
      // arrived since the add-on started, so neither a duration nor a cause is known here. It read as
      // Infinity and took the "over 30 minutes — lost its EcoFlow cloud connection … usually recovers
      // … power-cycle" branch three seconds after start-up (2026-09-30: three peripherals offline since
      // before the 82-day ledger began), and would say the same on a pushed warning for a
      // home Core that dropped a minute before a restart. What is known is said instead: for how long
      // EcoFlow has reported it offline in this session (a transition seen here), or that it has been
      // listed offline since the first device list; the cause is left open.
      const listedAt = conn?.firstListedAtMs ?? null;
      const ageMin = (now - lastDataAt) / 60_000;
      let hint = !(lastDataAt > 0)
        ? (d.onlineChangedAtMs
          ? ` EcoFlow has reported it offline for the last ${fmtAge(now - d.onlineChangedAtMs)}; why is not known here.`
          : ` EcoFlow Cloud has listed it offline since the add-on's first device list${listedAt != null ? ` (${fmtAge(now - listedAt)} ago)` : ''}; how long before that, and why, is not known here.`)
          + ' If the device is meant to be on, check its power and its Wi-Fi.'
        : ageMin > 30
          ? ' No telemetry for over 30 minutes — the device has lost its EcoFlow cloud (enhanced) connection. It usually recovers once the cloud session re-establishes; if it stays offline, a power-cycle forces a clean reconnect.'
          : ageMin > 5
            ? ' Data is stale but recent — the cloud session may catch up on its own. Wait a few minutes; if it persists, power-cycle.'
            : ' Just dropped — likely a brief blip. Will re-evaluate.';
      // Cloud-wedge vs real-outage classification. EcoFlow's cloud says OFFLINE
      // but gives no IP, so LAN reachability comes from an operator-configured HA
      // ping binary_sensor (ECOFLOW_DEVICE_REACHABILITY → setDeviceReachability,
      // populated by the main loop). PURELY additive: this only adds a fact and
      // refines the hint text — it never changes the alert's id, severity,
      // whether it fires, or the spare-gating. Dormant when unconfigured: the
      // fact is omitted entirely (no 'unknown' noise) and the hint is unchanged.
      const reachabilityConfigured = d.sn in deviceReachabilityEntities();
      if (reachabilityConfigured) {
        const link = classifyDeviceLink(false, getDeviceReachability(d.sn));
        if (link === 'cloud_wedge') {
          facts.push({ label: 'LAN reachability', value: 'Reachable (cloud session wedged)' });
          hint =
            ' The device IS reachable on the LAN, so this is an EcoFlow cloud-session wedge — its cloud/MQTT pipe stalled while the device itself is alive and on the network. Telemetry will resume when the cloud session re-establishes; do NOT power-cycle reflexively (it just interrupts a healthy unit and masks the cloud-side stall).';
        } else if (link === 'real_outage') {
          facts.push({ label: 'LAN reachability', value: 'Unreachable (no LAN ping)' });
          hint =
            ' The device is NOT reachable on the LAN, so this is likely a genuine power or network outage rather than a cloud wedge — check the device power, its breaker, and WiFi/router.';
        } else {
          // 'unknown' — entity configured but state unavailable. Surface the
          // ambiguity as a fact but leave the existing age-based hint unchanged.
          facts.push({ label: 'LAN reachability', value: 'Unknown (ping sensor unavailable)' });
        }
      }
      out.push({
        // v1.8.0 (review F2) — spares get their OWN alert family. familyOf()
        // collapses `offline-<SN>` to one 'offline' family for every device, so
        // daily bench-spare churn (the spares' circuit power-cycles) tripped the
        // auto-silencer's high-volume rule on 06-04 and the latch then silently
        // dropped 134 real home-Core/SHP2 offline warnings. `offline-spare-<SN>`
        // rolls up under 'offline-spare' instead, so spare churn can never poison
        // the home-device family's dispatch stats.
        id: spare ? `offline-spare-${d.sn}` : `offline-${d.sn}`,
        // A designated bench spare offline is expected, not a warning, and is
        // marked non-annunciating so it never chimes/pushes/raises the condition.
        severity: spare ? 'info' : isCore || isPanel ? 'warning' : 'info',
        // v0.76.0 — explicit ISA priority so a connectivity wedge no longer maps to
        // High/P2 ("a protective hardware limit has been crossed"), which inflated a
        // known, non-actionable cloud-offline to the same tier as a real hardware
        // breach and masked genuine P2s. The SHP2/Panel offline stays High (it is the
        // alarm DATA SOURCE — losing it degrades the floor/SoC alarm inputs); a home
        // Core offline is Medium/P3 (the SHP2 aggregate still covers the backup pool —
        // it needs attention, e.g. a network power-cycle, but isn't an emergency); a
        // peripheral offline is Low/P4. Spares stay non-annunciating regardless.
        priority: spare ? 'low' : isPanel ? 'high' : isCore ? 'medium' : 'low',
        category: 'Connectivity',
        device: d.deviceName,
        title: spare ? 'Bench spare offline (expected)' : 'Device offline (per EcoFlow Cloud)',
        detail: spare
          ? `${d.deviceName} is a designated bench spare — kept powered down and not wired into the SHP2 — so EcoFlow Cloud reporting it offline is expected and not actionable. It will alarm normally once it's connected to an SHP2.`
          : `${d.deviceName} is flagged offline by EcoFlow's /device/list. ${conn?.mqttCount && conn.mqttCount > 0
            ? `We previously received ${conn.mqttCount} MQTT message(s) this session; last data ${fmtAge(now - lastDataAt)} ago via ${lastSource.toUpperCase()}.`
            // v1.187.1 — REST data this session is not "no telemetry"; none at all is said plainly.
            : lastDataAt > 0 ? `Last data ${fmtAge(now - lastDataAt)} ago via ${lastSource.toUpperCase()}.` : 'It has not reported since the add-on started.'}${hint}`,
        coreNum,
        facts,
        ...(spare ? { annunciate: false, muteReason: MUTE_REASON_BENCH_SPARE } : {}),
      });
    } else if (d.projection && d.lastUpdated && now - d.lastUpdated > STALE_MS) {
      const conn = connectivity?.perDevice.get(d.sn);
      out.push({
        // v1.8.0 (review F2) — same spare-family split as `offline-` above: a
        // bench spare's expected idle telemetry must not pollute the home
        // devices' 'stale' family stats.
        id: spare ? `stale-spare-${d.sn}` : `stale-${d.sn}`,
        severity: spare ? 'info' : 'warning',
        category: 'Connectivity',
        device: d.deviceName,
        title: spare ? 'Bench spare telemetry idle (expected)' : 'Telemetry stale',
        detail: spare
          ? `${d.deviceName} is a designated bench spare not wired into the SHP2; intermittent or absent telemetry is expected. It will alarm normally once it's connected to an SHP2.`
          : `${d.deviceName} is flagged online by EcoFlow but no fresh telemetry for ${fmtAge(now - d.lastUpdated)}. ${conn?.lastMqttAt ? `Last MQTT msg ${fmtAge(now - conn.lastMqttAt)} ago.` : ''}`,
        coreNum,
        facts: [
          { label: 'Last telemetry', value: `${fmtAge(now - d.lastUpdated)} ago` },
          { label: 'Last source', value: conn?.lastSource?.toUpperCase() ?? 'unknown' },
          { label: 'MQTT msg count', value: conn?.mqttCount != null ? String(conn.mqttCount) : '—' },
        ],
        ...(spare ? { annunciate: false, muteReason: MUTE_REASON_BENCH_SPARE } : {}),
      });
    }
  }

  for (const d of dpus) {
    if (!isDpuEvaluable(d)) continue;
    const p = d.projection;
    const coreNum = dpuNum(d.deviceName);
    const dpuStart = out.length;

    if ((p.sysErrCode ?? 0) !== 0) {
      // v1.11.0 (review F8) — debounce the CRITICAL: an SHP2/DPU cloud reconnect
      // blips sysErrCode nonzero for 20-160s then clears (07-02 fired two false
      // CRITICAL "Inverter error code" alerts → HA critical_alerts stepped to 2 →
      // any operator automation keyed on criticals>0 would have fired). A REAL
      // inverter fault persists. Suppress until the SAME code has stood for
      // DPU_ERR_DEBOUNCE_MS. Onset is tracked in the store (re-baselined on a
      // code change / clear). When the context is absent (older callers/tests),
      // the guard is skipped and the alert fires immediately — the pre-v1.11.0
      // behaviour, so no path silently loses a real fault.
      const onset = connectivity?.dpuErrOnsetBySn?.get(d.sn);
      const debounced = onset != null && onset.code === (p.sysErrCode ?? 0) && (now - onset.sinceMs) < DPU_ERR_DEBOUNCE_MS;
      if (!debounced) {
        // v1.41.0 — code-band-aware title: the 5xx band is battery/BMS
        // protection in EcoFlow's error list, and the old blanket "Inverter
        // error code" title mis-pointed triage at the wrong subsystem. The id
        // is deliberately UNCHANGED so a standing fault does not re-raise as a
        // new alert on upgrade. When a pack shows the BMS protection-latch
        // signature (SoC-stranded + zero flow during sibling activity), the
        // alert names the probable source pack and carries the cell dossier.
        const code = p.sysErrCode ?? 0;
        const batteryBand = code >= 500 && code < 600;
        let srcPack: number | null = null;
        let srcLatch: PackLatchSignature | null = null;
        for (const cand of p.packs) {
          const l = packLatchSignature(p.packs, cand.num);
          if (l) { srcPack = cand.num; srcLatch = l; break; }
        }
        const srcFx = srcPack != null ? packCellForensics(p.packs, srcPack) : null;
        const srcNote = srcPack != null ? ` Probable source: Pack ${srcPack} — BMS protection latch.` : '';
        const errFacts = cellFaultFacts(srcFx, srcLatch);
        out.push({
          id: `dpu-err-${d.sn}`, severity: 'critical', category: 'Battery', device: d.deviceName,
          title: batteryBand ? 'Battery protection fault' : 'Inverter error code',
          // ★ v1.64.0 — the id above is CONSTANT across every error code; the code
          // is the only thing that says WHICH fault this is. Carry it explicitly
          // (see Alert.fault) so redReplayGate can tell "the same standing fault"
          // from "a different fault on the same device". sysErrCode is a discrete
          // device-reported code, already debounced above — stable, not drifting.
          fault: `err${code}`,
          detail: `${d.deviceName} reports system error code ${code}${batteryBand ? ' (battery/BMS protection band)' : ''}.${srcNote}`,
          ...(errFacts.length ? { facts: [{ label: 'Error code', value: String(code) }, ...errFacts] } : {}),
        });
      }
    }
    // v0.9.80 — only flag an MPPT error code when that string is actually
    // PRODUCING. During curtailment the DPU sheds the LV string (and
    // throttles HV): the input shows open-circuit voltage but ~0 A / 0 W,
    // and EcoFlow reports a non-zero *standby* status in hvPvErrCode /
    // lvPvErrCode that is NOT a fault. The 42h log queued "HV/LV MPPT error
    // code" 17× while live codes read 0 — the classic shed signature.
    // Mirror the UI's channelState thresholds (web SolarPanel.tsx): a code
    // is only a real error if the string is drawing current.
    // v1.0.1 — `mpptProducing` now needs BOTH watts and current (see its docstring): a
    // dusk ramp-down reports real-looking watts with ~0 A, which is standby, not a fault.
    // v1.174.0 — …and it must have STOOD. The onset clock (snapshot.ts) only runs while
    // the code is non-zero AND the string is producing, so it is re-baselined by the
    // sunset/standby path rather than accumulating overnight; a code that appears at the
    // sunrise ramp and clears one tick later never reaches the window. No context (older
    // callers/tests) fires immediately — the pre-v1.174.0 behaviour, so no real fault is
    // silently lost by a missing map.
    if ((p.pvHighErrCode ?? 0) !== 0 && mpptProducing(p.pvHighWatts, p.pvHighAmps)
        && !mpptErrDebounced(connectivity, d.sn, 'hv', p.pvHighErrCode ?? 0, now)) {
      out.push({ id: `dpu-pvh-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'HV MPPT error code', detail: `${d.deviceName} HV solar input reports error code ${p.pvHighErrCode} while producing ${p.pvHighWatts?.toFixed(0)} W (${p.pvHighVolts?.toFixed(0)} V, ${p.pvHighAmps?.toFixed(2)} A).` });
    }
    if ((p.pvLowErrCode ?? 0) !== 0 && mpptProducing(p.pvLowWatts, p.pvLowAmps)
        && !mpptErrDebounced(connectivity, d.sn, 'lv', p.pvLowErrCode ?? 0, now)) {
      out.push({ id: `dpu-pvl-err-${d.sn}`, severity: 'warning', category: 'Solar', device: d.deviceName, title: 'LV MPPT error code', detail: `${d.deviceName} LV solar input reports error code ${p.pvLowErrCode} while producing ${p.pvLowWatts?.toFixed(0)} W (${p.pvLowVolts?.toFixed(0)} V, ${p.pvLowAmps?.toFixed(2)} A).` });
    }

    for (const [label, slug, c] of [
      ['HV MPPT', 'hv', p.mpptHvTemp],
      ['LV MPPT', 'lv', p.mpptLvTemp],
    ] as const) {
      // v0.26.0 — channel slug ('hv'/'lv') BEFORE the SN and lowercase, so
      // familyOf() (which stops at the first uppercase token = the SN) yields
      // per-channel families `mppt-hv-temp` / `mppt-lv-temp` instead of collapsing
      // every device+string+severity into one bare `mppt` rollup — which had
      // pooled a spare's info-MPPT noise against a home core's warning/critical
      // for the auto-silence decision. Human label unchanged ('HV/LV MPPT').
      const a = tempAlert({ idBase: `mppt-${slug}-temp-${d.sn}`, device: d.deviceName, label: `${d.deviceName} ${label}`, tempC: c, band: MPPT_TEMP });
      if (a) out.push(a);
    }

    if (p.batVol != null && p.emsParaVolMinMv != null && p.emsParaVolMaxMv != null) {
      const batMv = p.batVol * 1000;
      if (batMv < p.emsParaVolMinMv || batMv > p.emsParaVolMaxMv) {
        out.push({ id: `ems-volt-${d.sn}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Pack voltage outside EMS window', detail: `${d.deviceName} at ${p.batVol.toFixed(1)} V — outside EcoFlow's ${(p.emsParaVolMinMv / 1000).toFixed(1)}–${(p.emsParaVolMaxMv / 1000).toFixed(1)} V parallel-operation window.` });
      }
    }

    const packSocs = p.packs.map((pk) => pk.soc).filter((s): s is number => s != null);
    if (packSocs.length > 1) {
      const spread = Math.max(...packSocs) - Math.min(...packSocs);
      if (spread >= PACK_IMBALANCE_WARN_PCT) {
        // v1.41.0 — name the outlier pack; if it also shows the protection-latch
        // signature, say so (a stranded pack is a fault; drifted balance is not).
        const minSoc = Math.min(...packSocs);
        const outlier = p.packs.find((x) => x.soc === minSoc);
        const outLatch = outlier ? packLatchSignature(p.packs, outlier.num) : null;
        const outNote = outlier
          ? (outLatch
            ? ` Pack ${outlier.num} is stranded at ${minSoc}% with ~${outLatch.packAbsW} W flow while siblings run ~${outLatch.siblingMedianAbsW} W — BMS protection latch signature.`
            : ` Lowest: Pack ${outlier.num} at ${minSoc}%.`)
          : '';
        out.push({ id: `dpu-imbalance-${d.sn}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Packs out of balance', detail: `${spread.toFixed(0)}% SoC spread across ${d.deviceName}'s packs (≥ ${PACK_IMBALANCE_WARN_PCT}%).${outNote}`, ...(outLatch ? { facts: cellFaultFacts(outlier ? packCellForensics(p.packs, outlier.num) : null, outLatch) } : {}) });
      }
    }

    for (const pk of p.packs) {
      const tag = `${d.deviceName} Pack ${pk.num}`;
      const packStart = out.length;
      const soh = pk.actSoh ?? pk.soh;
      if (soh != null && soh < SOH_CRIT_PCT) {
        out.push({ id: `soh-crit-${d.sn}-${pk.num}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Pack health critical', detail: `${tag} SoH ${soh.toFixed(1)}% (critical < ${SOH_CRIT_PCT}%).` });
      } else if (soh != null && soh < SOH_WARN_PCT) {
        out.push({ id: `soh-warn-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Pack health degraded', detail: `${tag} SoH ${soh.toFixed(1)}% (warning < ${SOH_WARN_PCT}%).` });
      }

      const balancing = pk.balanceState != null && pk.balanceState !== 0;
      if (pk.maxVolDiffMv != null) {
        const balanceNote = balancing ? ' BMS is actively balancing the cells.' : '';
        // v0.29.0 — the static vdiff-crit threshold is INSTANTANEOUS with no
        // hysteresis, and critical alerts get 0 ms debounce + are exempt from all
        // auto-silencing — so a 50 mV transient pushed a CRITICAL chime on every
        // rise (live: 67 rises, 69% cleared < 10 min, 3-min median, coinciding
        // with benign BMS cell-balancing). A brief spread excursion WHILE the BMS
        // is actively balancing is expected housekeeping, not a fault: keep the
        // alert VISIBLE (dashboard still shows it, with the balancing note) but mark
        // it annunciate:false so it never chimes/pushes during balancing. A genuine
        // sustained imbalance persists past balancing and re-fires annunciating.
        // v0.58.0 — relaxed critical ceiling on the high-SoC LFP plateau (see
        // VOL_DIFF_PLATEAU_* constants). packSoc prefers the pack reading and falls
        // back to the device-projection SoC (pack soc is often null in DPU telemetry).
        const packSoc = pk.soc ?? p.soc;
        const onPlateau = packSoc != null && packSoc >= VOL_DIFF_PLATEAU_SOC_PCT;
        const critMv = vdiffCritMvFor(packSoc);
        // A benign top-of-charge plateau excursion — a spread that WOULD have been
        // critical off-plateau (>= VOL_DIFF_CRIT_MV) but sits under the relaxed
        // plateau ceiling, with the BMS idle — stays VISIBLE but never chimes/pushes
        // (same treatment as the balancing case). Normal warn-range spread
        // (20..49 mV) keeps its usual annunciation; only the demoted-from-critical
        // band is silenced, so the operator isn't klaxoned by expected LFP plateau
        // spread. The silence is BOUNDED: as soon as SoC drops below the plateau
        // (any discharge below VOL_DIFF_PLATEAU_SOC_PCT), the standard 50 mV critical
        // re-arms — so a genuinely diverging pack still alarms audibly each cycle,
        // and it stays visible as a warning meanwhile (SoH/degradation engines also
        // track it independently).
        const plateauBenign = onPlateau && !balancing && pk.maxVolDiffMv >= VOL_DIFF_CRIT_MV && pk.maxVolDiffMv < critMv;
        // v1.45.0 — quiet the WARN band at top-of-charge too. Ground truth
        // (2026-07-23): the fleet's first full grid top-up in weeks put every
        // pack >= 95% under morning curtailment and 14 of 15 packs fired
        // 24-49 mV warn-band spreads within two hours — all self-cleared in
        // minutes. That is the plateau signature, not degradation: a genuinely
        // diverging pack rides its spread DOWN off the plateau (the 50 mV crit
        // re-arms below 85%) and the peer/SoH engines track it independently.
        // Warn-band spread on a >= 95% pack stays VISIBLE but does not push.
        // v1.187.0 — the same predicate (cellSpread.ts) now gates the peer outlier's audible.
        const plateauQuietWarn = topOfChargeQuietSpread(packSoc, pk.maxVolDiffMv);
        const plateauNote = (plateauBenign || plateauQuietWarn) ? ' Expected top-of-charge cell spread.' : '';
        // v1.187.0 — the mute carries its reason; balancing names first (the only one a critical can have).
        const annun = (balancing || plateauBenign || plateauQuietWarn)
          ? { annunciate: false, muteReason: balancing ? MUTE_REASON_BALANCING : MUTE_REASON_PLATEAU }
          : {};
        // v1.21.0 (engine-review F28) — rise-side hysteresis: fire the warning
        // only at >= VOL_DIFF_WARN_RISE_MV; once fired, hold it while the spread
        // is still >= VOL_DIFF_WARN_MV. A spread descending OUT of critical
        // (always >= the rise line) marks the hold too, so it keeps its warning
        // through the 20-49 mV band instead of vanishing. Threshold-kissing
        // 19-23 mV spreads — 73-100% of this family's 30-day rises, all
        // short-clearing — no longer fire at all.
        const vdiffKey = `${d.sn}-${pk.num}`;
        seenVdiffKeys.add(vdiffKey);
        // v1.173.0 — drop a hold earned by a DIFFERENT pack (swap / 2026-09-20 renumber). A
        // missing serial is never evidence of a change.
        const heldBy = heldVdiffWarnKeys.get(vdiffKey);
        if (heldBy != null && pk.packSn && heldBy !== pk.packSn) heldVdiffWarnKeys.delete(vdiffKey);
        const warnActive =
          pk.maxVolDiffMv >= VOL_DIFF_WARN_RISE_MV ||
          (heldVdiffWarnKeys.has(vdiffKey) && pk.maxVolDiffMv >= VOL_DIFF_WARN_MV);
        if (warnActive) heldVdiffWarnKeys.set(vdiffKey, pk.packSn ?? heldVdiffWarnKeys.get(vdiffKey) ?? null);
        else heldVdiffWarnKeys.delete(vdiffKey);
        // v1.187.0 — the end-of-charge knee (VDIFF_KNEE_* above). Advanced on EVERY reading, not
        // only critical ones: the activity evidence is usually earned while the spread is still
        // in the warn band (the BMS reports cell voltages every ~180 s, so the reading that first
        // crosses the critical line can land after charging has already stopped).
        const kneeObs: VdiffKneeObservation = {
          packSn: pk.packSn ?? null,
          packSoc: packSoc ?? null,
          spreadMv: pk.maxVolDiffMv,
          balancing,
          chargeW: vdiffKneeChargeW(pk, now),
        };
        // v1.187.0 (log review) — a pack with no state (after a restart) starts from its standing
        // critical's persisted onset (vdiffKneeSeed), never from a clean clock.
        // v1.187.1 — after a restart the map already holds the pack's persisted session when the
        // knee-session file had one (restoreVdiffKneeSessions, run by the monitor at start-up);
        // the onset seed is the fallback for a pack it had no entry for.
        const kneePrev = vdiffKneeByKey.get(vdiffKey) ?? vdiffKneeSeed(getAlertOnset(`vdiff-crit-${vdiffKey}`), pk.packSn ?? null, now);
        const knee = advanceVdiffKnee(kneePrev, kneeObs, now);
        vdiffKneeByKey.set(vdiffKey, knee);
        // v1.41.0 — cell forensics: the alert carries WHICH cell deviates and by
        // how much vs the pack median and sibling packs (facts), and the critical's
        // spoken detail names the isolated cell — detection → isolation → root
        // cause in the alert itself, ready for an after-sales ticket.
        const fx = packCellForensics(p.packs, pk.num);
        const latch = packLatchSignature(p.packs, pk.num);
        const cellNote = fx ? ` Deviant cell #${fx.deviantCell} (${fx.deltaMv > 0 ? '+' : ''}${fx.deltaMv} mV vs pack median).` : '';
        const factRows = cellFaultFacts(fx, latch);
        const facts = factRows.length ? { facts: factRows } : {};
        if (pk.maxVolDiffMv >= critMv) {
          // v1.187.0 — the critical's mute is vdiffCritMute's alone: the v0.29.0 balancing mute
          // now sits under the VOL_DIFF_KNEE_HARD_MV ceiling and (on the plateau) the
          // VDIFF_KNEE_MAX_MUTE_MS bound, and the end-of-charge grace joins it. The notes say
          // which bound let it speak, so the operator hears why a top-of-charge spread matters.
          const critMute = vdiffCritMute(knee, kneeObs, now);
          const underCeiling = pk.maxVolDiffMv < VOL_DIFF_KNEE_HARD_MV;
          const critAgeMs = knee.critSinceMs != null ? now - knee.critSinceMs : null;
          const sustained = underCeiling && critAgeMs != null && critAgeMs >= VDIFF_KNEE_MAX_MUTE_MS;
          // The evidence is non-null only at top of charge, and inside its window it mutes — so
          // with no mute, not balancing, under both bounds and with top-of-charge activity inside
          // the duration bound, the end-of-charge grace has lapsed.
          const lastKneeActivityMs = Math.max(knee.lastBalancingMs ?? -Infinity, knee.lastChargeMs ?? -Infinity);
          const failedToRelax = critMute == null && underCeiling && !sustained && !balancing
            && now - lastKneeActivityMs < VDIFF_KNEE_MAX_MUTE_MS;
          // v1.187.0 (log review) — balancing, under both bounds and still annunciating: only the
          // SESSION bound speaks there (vdiffCritMute), measured from the session's first crossing —
          // the episode clock may have restarted after a dip under the line. v1.187.2 — the session
          // runs across the plateau, so below the top of charge the note names the plateau line.
          const sessionAgeMs = knee.graceFromMs != null ? now - knee.graceFromMs : null;
          const sessionSustained = critMute == null && underCeiling && !sustained && balancing && sessionAgeMs != null;
          const sessionWhere = packSoc != null && packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT
            ? 'at this top of charge' : `above ${VOL_DIFF_PLATEAU_SOC_PCT}% charge`;
          // "first reached", not "sustained": the clock survives dips under the line shorter than
          // VDIFF_KNEE_RELAX_MS, so the minutes are the age of the episode, not time on the line.
          const kneeNote = critMute === 'end-of-charge' ? ' End-of-charge cell spread, relaxing.'
            : critMute === 'charging' ? ' Top-of-charge cell spread while charging.'
            : sustained ? ` First reached the critical line ${Math.round(critAgeMs! / 60_000)} minutes ago.`
            : sessionSustained ? ` First reached the critical line ${sessionWhere} ${Math.round(sessionAgeMs! / 60_000)} minutes ago.`
            : failedToRelax ? ' Did not relax at the top of charge.'
            : '';
          out.push({
            id: `vdiff-crit-${d.sn}-${pk.num}`, severity: 'critical', category: 'Battery', device: d.deviceName, title: 'Cell imbalance',
            detail: `${tag} cell spread ${pk.maxVolDiffMv} mV (critical ≥ ${critMv} mV).${cellNote}${kneeNote}${balanceNote}`,
            ...facts,
            ...(critMute ? { annunciate: false, mutedBy: critMute, muteReason: CELL_SPREAD_MUTE_TEXT[critMute] } : {}),
          });
        } else if (warnActive) {
          out.push({ id: `vdiff-warn-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Cell imbalance', detail: `${tag} cell spread ${pk.maxVolDiffMv} mV (warning fires ≥ ${VOL_DIFF_WARN_RISE_MV} mV, holds ≥ ${VOL_DIFF_WARN_MV} mV).${cellNote}${balanceNote}${plateauNote}`, ...facts, ...annun });
        }
      }
      // v1.187.0 — CELL OVERVOLTAGE (CELL_OVP_CRIT_MV). Computed independently of the spread
      // rule and read by none of its gates: a cell at the overvoltage line is a hazard whether
      // or not the BMS is balancing, the pack is at top of charge, or the Core is on the panel.
      // isNeverMutedAlert exempts it from the bench-spare stamp below and the off-panel
      // demotion, as it does a critical Thermal alert.
      const maxCellMv = pk.maxCellVoltageMv;
      if (maxCellMv != null && Number.isFinite(maxCellMv) && maxCellMv >= CELL_OVP_CRIT_MV && maxCellMv < CELL_OVP_IMPLAUSIBLE_MV) {
        const ovpFx = packCellForensics(p.packs, pk.num);
        const ovpSoc = pk.soc ?? p.soc;
        out.push({
          id: `cell-ovp-${d.sn}-${pk.num}`, severity: 'critical', category: 'Battery', device: d.deviceName,
          title: 'Cell overvoltage',
          detail: `${tag} highest cell at ${(maxCellMv / 1000).toFixed(3)} V (critical ≥ ${(CELL_OVP_CRIT_MV / 1000).toFixed(2)} V; LFP cells are rated to about 3.65 V).`,
          facts: [
            { label: 'Highest cell', value: `${(maxCellMv / 1000).toFixed(3)} V` },
            ...(pk.minCellVoltageMv != null ? [{ label: 'Lowest cell', value: `${(pk.minCellVoltageMv / 1000).toFixed(3)} V` }] : []),
            { label: 'Critical line', value: `${(CELL_OVP_CRIT_MV / 1000).toFixed(3)} V` },
            ...(ovpSoc != null ? [{ label: 'Pack SoC', value: `${ovpSoc}%` }] : []),
            ...cellFaultFacts(ovpFx, null),
          ],
        });
      }
      // v1.101.0 — STANDING "confirmed defective pack" alert.
      //
      // The 2026-08-20 pack swap produced a severity inversion: the genuinely
      // defective warranty pack moved onto a bench chassis, where every alert it
      // raises is demoted to annunciate:false, while its healthy replacement on a
      // panel-wired chassis pushed [High] cell-imbalance to the operator. The
      // system's loudness became inversely correlated with physical severity, and
      // the one pack that is actually broken went silent — leaving the RMA's only
      // evidence trail on a dashboard nobody is paged to look at.
      //
      // This is deliberately NOT the per-tick vdiff family. It fires only on an
      // unambiguous two-leg signature — a BMS protection latch (SoC >= 20 pts
      // below the sibling median while exchanging < 25 W during active sibling
      // flow) AND an identified deviant cell — and it is exempt from both the
      // bench-spare stamp below and the v1.95.0 off-panel demotion, because
      // "this battery is broken" is true wherever the hardware happens to be
      // wired. One standing alert per (device, pack); the notify layer dedups it
      // to a single push that resolves when the pack is replaced.
      // Computed independently of the vdiff branch above: a latched pack must be
      // reported whether or not its spread happens to clear a vdiff threshold.
      const dLatch = packLatchSignature(p.packs, pk.num);
      const dFx = packCellForensics(p.packs, pk.num);
      // packCellForensics always names its most-deviant cell, even on a perfectly
      // matched pack, so the second leg must require a MEANINGFUL deviation —
      // otherwise the leg is vacuous and the detail would read "0 mV from the
      // pack median". DEFECTIVE_PACK_MIN_DEVIANT_MV matches the cell-imbalance
      // critical threshold.
      const defectiveLegsLive = dLatch != null && dFx != null && Math.abs(dFx.deltaMv) >= DEFECTIVE_PACK_MIN_DEVIANT_MV;
      // v1.108.0 — LATCH THE DIAGNOSIS. On 2026-08-24, the first day the TOU
      // window let the bench bank charge, this alert fired and resolved three
      // times in one day: leg 3 of the signature (sibling median >= 100 W)
      // tracks the charger's burst duty cycle, so the alert cleared every time
      // a burst ended. "Confirmed defective" is a diagnosis, not a live
      // condition — once the full signature has been observed for a PHYSICAL
      // pack (keyed by packSn; the 08-20 swap proved faults travel with the
      // pack), the standing alert holds as long as that pack is present in the
      // fleet. It clears when the pack leaves (RMA) or via the operator's
      // explicit /api/defective-packs/clear. Without a packSn the legs-only
      // v1.101.0 behavior stands — never latch on a slot alone.
      if (pk.packSn) {
        markPackPresent(pk.packSn, now, d.sn);
        if (defectiveLegsLive) {
          confirmDefectivePack({
            packSn: pk.packSn, deviceSn: d.sn, deviceName: d.deviceName, packNum: pk.num,
            socPct: dLatch.socPct, siblingMedianSocPct: dLatch.siblingMedianSocPct,
            packAbsW: dLatch.packAbsW, siblingMedianAbsW: dLatch.siblingMedianAbsW,
            deviantCell: dFx.deviantCell, deltaMv: dFx.deltaMv,
          }, now);
        }
      }
      const dConfirmed = pk.packSn ? getConfirmedRecord(pk.packSn) : null;
      // v1.173.0 — the latched diagnosis names the PHYSICAL pack on the web card too. Appended
      // LAST: the TTS reads only the first ~200 chars (shortenDetail), so it is never spoken.
      const snNote = pk.packSn ? ` Pack serial ${packSnTail(pk.packSn)}.` : '';
      if (defectiveLegsLive) {
        const dl = dLatch; const dfx = dFx;
        out.push({
          id: `pack-defective-${d.sn}-${pk.num}`,
          severity: 'warning',
          category: 'Battery',
          device: d.deviceName,
          title: 'Pack confirmed defective — service required',
          detail:
            `${tag} is latched out by its own BMS: ${dl.socPct}% SoC against a sibling median of ${dl.siblingMedianSocPct}%, `
            + `exchanging ${dl.packAbsW} W while its siblings move ${dl.siblingMedianAbsW} W. Deviant cell #${dfx.deviantCell} `
            + `sits ${dfx.deltaMv > 0 ? '+' : ''}${dfx.deltaMv} mV from the pack median. The pack cannot recover on its own — `
            + `it is below the parallel-operation window, so it accepts no charge, so it cannot climb back into the window. `
            + `Capture evidence with /api/warranty-export.${snNote}`,
          annunciate: true,
        });
      } else if (dConfirmed) {
        // Quiescent latch: the legs are not currently observable (typically the
        // bank is idle, so leg 3 cannot hold), but the diagnosis stands.
        // Date below is Phoenix-local (fixed UTC−7, AZ has no DST — and never
        // Intl on the Pi): the 08-24 23:01 MST confirmation rendered as "08-25"
        // with a bare toISOString.
        // v1.187.1 (review) — through isoOrRaw: a corrupt confirmedAtMs threw a RangeError here on
        // every tick the pack was present, and computeAlerts has no catch.
        out.push({
          id: `pack-defective-${d.sn}-${pk.num}`,
          severity: 'warning',
          category: 'Battery',
          device: d.deviceName,
          title: 'Pack confirmed defective — service required',
          detail:
            `${tag} was confirmed defective on ${isoOrRaw(dConfirmed.confirmedAtMs - 7 * 3_600_000).slice(0, 10)}: `
            + `${dConfirmed.socPct}% SoC against a sibling median of ${dConfirmed.siblingMedianSocPct}%, exchanging `
            + `${dConfirmed.packAbsW} W while its siblings moved ${dConfirmed.siblingMedianAbsW} W; deviant cell `
            + `#${dConfirmed.deviantCell} at ${dConfirmed.deltaMv > 0 ? '+' : ''}${dConfirmed.deltaMv} mV from the pack median. `
            + `The bank is currently quiescent, so the live signature cannot re-verify — the diagnosis is latched until the `
            + `pack is removed or explicitly cleared (POST /api/defective-packs/clear). Capture evidence with /api/warranty-export.${snNote}`,
          annunciate: true,
        });
      }
      if (balancing) {
        out.push({ id: `balancing-${d.sn}-${pk.num}`, severity: 'info', category: 'Battery', device: d.deviceName, title: 'Pack balancing cells', detail: `${tag} BMS is actively balancing — normal housekeeping, no action needed.` });
      }

      const cellA = tempAlert({ idBase: `temp-cell-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} cells`, tempC: pk.maxCellTemp ?? pk.temp, band: CELL_TEMP });
      if (cellA) out.push(cellA);
      const mosA = tempAlert({ idBase: `temp-mos-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} MOSFETs`, tempC: pk.maxMosTemp, band: MOS_TEMP });
      if (mosA) out.push(mosA);
      const boardA = tempAlert({ idBase: `temp-board-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} BMS board`, tempC: pk.hwBoardTemp, band: BOARD_TEMP });
      if (boardA) out.push(boardA);
      const shuntA = tempAlert({ idBase: `temp-shunt-${d.sn}-${pk.num}`, device: d.deviceName, label: `${tag} current shunt`, tempC: pk.curResTemp, band: SHUNT_TEMP });
      if (shuntA) out.push(shuntA);

      const coldC = pk.minCellTemp ?? pk.temp;
      if (coldC != null && cToF(coldC) <= CELL_TEMP_COLD_F) {
        out.push({ id: `temp-cold-${d.sn}-${pk.num}`, severity: 'warning', category: 'Thermal', device: d.deviceName, title: `${tag} cold`, detail: `${tag} at ${Math.round(cToF(coldC))}°F — charging derates near freezing.` });
      }

      if (pk.soc != null && pk.soc <= PACK_SOC_LOW_PCT) {
        out.push({ id: `soc-low-${d.sn}-${pk.num}`, severity: 'warning', category: 'Battery', device: d.deviceName, title: 'Pack nearly empty', detail: `${tag} at ${pk.soc}% state of charge.` });
      }
      for (let i = packStart; i < out.length; i++) {
        out[i].packNum = pk.num;
        // v1.102.0 — stamp the PHYSICAL pack identity alongside the slot number.
        // Alert ids are keyed (chassis, slot), which is stable and cheap right
        // up until the thing in that slot is replaced: on 2026-08-20 a pack swap
        // silently re-pointed `vdiff-crit-<sn>-1` at a different battery with no
        // resolve and no re-raise — its detail changed from "Deviant cell #31
        // (-105 mV)" to "cell #32 (-84 mV)" mid-episode, merging two physical
        // packs into one cleared-alert record and one live alert. The BMS
        // reports packSn on every read; carrying it makes identity follow the
        // hardware, which is what the RMA evidence trail needs.
        if (pk.packSn) out[i].sourcePackSn = pk.packSn;
      }
    }
    for (let i = dpuStart; i < out.length; i++) out[i].coreNum = coreNum;
    // v1.140.0 — stamp the source device on EVERY alert this DPU emitted, the
    // same way coreNum is stamped one line up. The boot orphan sweep persists
    // this and asks whether the device is evaluable before treating the alert's
    // disappearance as a recovery; without it, fallingEdgeFrozenByEvidence falls
    // back to scanning the id, which resolves nothing for dpu-err-* / vdiff-* on
    // a restart. Set only where absent so a more specific stamp above wins.
    for (let i = dpuStart; i < out.length; i++) if (!out[i].sourceSn) out[i].sourceSn = d.sn;
    // v0.26.0 — a bench spare (in SPARE_DPU_SNS, not wired into the SHP2) stays
    // online for diagnostics but must NEVER chime/push. The v0.16.4 gate only
    // covered the offline/stale branches; stamp annunciate:false on everything
    // this online spare just emitted (dpu-err, mppt-*, vdiff-*, soh-*, soc-low,
    // temp-*, ems-volt, imbalance). Stays visible on-screen; auto-re-arms once
    // it's wired into an SHP2 (shp2ConnectedDpuSns then includes it).
    if (isExpectedOfflineSpare(d.sn)) {
      for (let i = dpuStart; i < out.length; i++) {
        // v1.101.0 — a confirmed-defective pack is exempt. "This battery is
        // broken" is true wherever the hardware happens to be wired, and muting
        // it is exactly how the 2026-08-20 severity inversion arose.
        if (isNeverMutedAlert(out[i])) continue;
        // v1.187.0 — the spare stamp names itself, over a balancing/plateau reason: those mutes
        // end with the condition, the spare's does not, and the log names an episode once.
        out[i].annunciate = false;
        out[i].muteReason = MUTE_REASON_BENCH_SPARE;
        // v1.187.1 — and the bounded cell-spread mute is no longer the one holding it: mutedBy names
        // the mute in force (soundedCriticalHeld holds a sounded critical red on it, and
        // quietPeerSpreadUnderHeldCritical quiets the pack's outlier on it). Left set under the
        // spare stamp, a sounded vdiff-crit muted by policy held the level red and delayed the
        // all-clear while the knee mute lasted — "a policy mute holds nothing".
        delete out[i].mutedBy;
      }
    }
  }

  // v1.21.0 (F28) — a held vdiff-warn key whose pack produced no reading this
  // cycle (device offline / vdiff null) loses its hold: the episode must
  // re-earn the >= VOL_DIFF_WARN_RISE_MV rise when data returns, mirroring the
  // peer-hit prune philosophy (a lapsed condition re-earns its gate).
  for (const k of [...heldVdiffWarnKeys.keys()]) {
    if (!seenVdiffKeys.has(k)) heldVdiffWarnKeys.delete(k);
  }
  // v1.187.0 — and its knee state. The activity EVIDENCE must be re-earned from fresh readings
  // after a gap (a mute is never carried across blindness). The critical-line CLOCK is carried,
  // bound to the pack serial by advanceVdiffKnee, for VDIFF_KNEE_GAP_CARRY_MS from the last
  // reading: dropping it would restart the duration bound, so an offline blip or a restart
  // every few minutes could keep a balancing-muted fault under VDIFF_KNEE_MAX_MUTE_MS forever.
  // v1.187.0 (log review) — the session's grace clock (graceFromMs) is carried the same way, even
  // while no critical-line episode runs: a gap during a sub-line reading must not re-grant a
  // grace. The rest that would end the session (quietSinceMs) is NOT carried: a rest must be seen
  // unbroken. A process restart loses the state (in memory), and vdiffKneeSeed restores both clocks
  // from the standing critical's persisted onset.
  // v1.187.1 — a restart is now one more reading gap under this same rule: the clocks are persisted
  // (persistVdiffKneeSessions) and restored at start-up while the pack's last reading is at most
  // VDIFF_KNEE_GAP_CARRY_MS old (restoreVdiffKneeSessions), with the evidence and the under-the-line
  // run left cleared. vdiffKneeSeed is only the fallback for a pack with no persisted entry.
  // v1.187.1 (review) — the one exception is the rest: a restart is never seen, so clearing it as
  // this prune does ended every rest across a restart and a benign second knee sounded. It is
  // restored across an outage of at most VDIFF_KNEE_SEEN_PERSIST_MS + VDIFF_KNEE_RELAX_MS by the
  // file's own last reading (restoreVdiffKneeSessions), and cleared after a longer one; a pack
  // unseen on a tick after the restart still loses it here.
  for (const [k, st] of [...vdiffKneeByKey]) {
    if (seenVdiffKeys.has(k)) continue;
    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k);
    else vdiffKneeByKey.set(k, { ...st, lastBalancingMs: null, lastChargeMs: null, belowCritSinceMs: null, quietSinceMs: null });
  }
  // v1.108.0 — retire defective-pack confirmations whose pack has left the fleet.
  // v1.140.0 — but only where its absence is EVIDENCE. The evaluable set is
  // built from the SAME predicate that gates the pack loop above; if the two
  // drifted, this would be a filtered collection given meaning for the whole
  // fleet, which is the exact shape being fixed.
  for (const rec of retireAbsentPacks({
    nowMs: now,
    evaluableDeviceSns: new Set(dpus.filter(isDpuEvaluable).map((d) => d.sn)),
  })) {
    void rec; // already logged with its full evidence snapshot by the latch (v1.187.1: the monitor's warn sink)
  }

  // v1.185.0 (review) — the HOUSE pool's alarms read the house panel's own grid verdict when a
  // second panel exists (poolGrid; the plant verdict is `grid`). Shadowed into each house-pool block
  // below so the plant-level uses of `grid` (the off-grid advisory) are untouched.
  const housePoolGrid = shp2 && poolGrid ? poolGrid(shp2.sn) : grid;
  if (shp2?.online && shp2.projection) {
    // v1.185.0 — this pool's OWN grid verdict (its panel alone) on a multi-panel plant; one panel: `grid`.
    const grid = housePoolGrid;
    const sp = shp2.projection;
    const reserve = sp.backupReserveSoc ?? 15;
    // v1.113.0 — true only while OUR night-charge write is holding the reserve
    // up (applied, not yet reverted); persisted across restarts by the actuator.
    const arbitrageRaised = getReserveArbitrageRaised();
    if (sp.backupBatPercent != null) {
      // v1.17.0 (engine-review F14) — INCLUSIVE floor comparison, matching
      // runwayAlarm.belowReserveFloor's `<=`. The pool pins at EXACTLY the
      // integer reserve value for hours every night (7.9h/8.8h stretches in the
      // 30-day cleared-alert ledger); with strict `<` that steady state
      // classified as merely "approaching reserve" (warning off-grid), so a
      // real overnight outage with the pool holding the floor would never show
      // the at-the-floor critical — only the instantaneous crossing tick would.
      if (sp.backupBatPercent <= reserve) {
        // v0.23.0 — when the grid is backstopping the home, the pool sitting at
        // its reserve floor just transfers to mains; downgrade critical → info
        // (still visible) so it doesn't push/chime as an emergency.
        const onGrid = grid?.backstopping === true;
        out.push({
          id: 'shp2-below-reserve',
          // v1.81.0 (08-05 queue #3) — the ON-GRID floor touch was 'info', so the
          // deepest crossing of the record (10%, 2026-08-16 21:16:54) produced no
          // push while the shallower 20% band pushed [Medium]. At the TRUE floor
          // (reserve <= 15) this is now a warning: it pushes once per episode
          // (with normal quiet-hours queueing) without chiming as an emergency.
          // When the reserve is ARBITRAGE-RAISED (night-charge writes 50), pool <
          // reserve is the charge window's normal filling state — that stays
          // info, preserving the F14 "floor-riding must not page" contract.
          // v1.113.0 — the discriminator is the actuator's POSTURE, not the
          // reserve's magnitude. `reserve <= 15` worked only while the owner's
          // floor sat below 15; raising the floor to 20 for MORE buffer would
          // have silently reclassified a genuine breach as arbitrage filling
          // and dropped the push. See isReserveArbitrageRaised.
          severity: onGrid ? (arbitrageRaised ? 'info' : 'warning') : 'critical',
          ...(onGrid && !arbitrageRaised ? { priority: 'medium' as const } : {}),
          category: 'SHP2',
          device: shp2.deviceName,
          sourceSn: shp2.sn,
          // v1.17.0 review — "at or below", never "at/below": these strings
          // reach Piper on the critical audible path and verbalizeForTts has
          // no generic slash rule (espeak speaks '/' literally).
          // v1.144.0 — SAY WHY IT IS LIT. When our own night-charge write is
          // holding the reserve up, "at or under the 50% reserve floor" is the
          // charge window's normal filling state, not a fault — and it stays lit
          // for hours: measured median 7.4 h, longest 11.3 h across 45 rises.
          // The severity discriminator (v1.113.0, above) already keeps it off
          // the phone; the TEXT still read like a problem to anyone glancing at
          // the panel. An operator should not have to know the actuator's
          // posture to interpret the alert it caused.
          title: arbitrageRaised && onGrid
            ? 'Backup filling to arbitrage reserve'
            : onGrid ? 'Backup at reserve — on grid' : 'Backup at or below reserve',
          detail: arbitrageRaised && onGrid
            ? `Backup pool ${sp.backupBatPercent}% is under the ${reserve}% floor because the night-charge plan raised it — this is the charge window filling, not a shortfall. It clears when the plan reverts the floor.`
            : onGrid
              // v1.186.3 — "drawing from grid power" only while grid import is measured.
              ? `Backup pool ${sp.backupBatPercent}% is at or under the ${reserve}% reserve floor — ${gridBackupClause(grid)}, no action needed (${grid?.reason ?? 'grid present'}).`
              : `Backup pool ${sp.backupBatPercent}% is at or under the ${reserve}% reserve floor.`,
        });
      } else if (sp.backupBatPercent < reserve + 10) {
        // v0.43.0 — grid-aware, mirroring shp2-below-reserve above: while the grid
        // backstops the home, approaching the reserve floor merely transfers to mains,
        // so downgrade warning → info (still visible, no chime/push). A real outage
        // (grid absent ⇒ backstopping false) keeps it 'warning'.
        const onGrid = grid?.backstopping === true;
        out.push({
          id: 'shp2-near-reserve',
          severity: onGrid ? 'info' : 'warning',
          category: 'SHP2',
          device: shp2.deviceName,
          sourceSn: shp2.sn,
          title: 'Backup approaching reserve',
          detail: onGrid
            ? `Backup pool ${sp.backupBatPercent}% is close to the ${reserve}% reserve floor — ${gridBackupClause(grid)}, no action needed (${grid?.reason ?? 'grid present'}).`
            : `Backup pool ${sp.backupBatPercent}% is close to the ${reserve}% reserve floor.`,
        });
      }
    }
    for (const s of sp.sources) {
      const tag = `SHP2 slot ${s.slot}`;
      if ((s.errorCodeNum ?? 0) !== 0) {
        // v1.45.0 — errorCodeNum carries the source device's ERROR CODE, not a
        // count (the v1.2.0 reading). Proven live 2026-07-23: slot 3 read 533,
        // byte-identical to Core 3's own sysErrCode 533 (battery/BMS protection
        // band); the 2026-07-12 episode's "461" was likewise a code. The old
        // count phrasing produced "SHP2 slot 3 reports 533 errors" — wrong and
        // alarming — and TTS spoke it. Name it as a code, with the same 5xx
        // band note the dpu-err alert uses.
        const n = s.errorCodeNum!;
        // v1.14.0 — debounce, mirroring the dpu-err pattern (same 3-min window):
        // a transient device-reported error (fired 05:35:01, cleared 05:36:01 on
        // 2026-07-12) woke the house with a 64-s audible red + critical push. The
        // CRITICAL is held until the SAME count has stood for the window; no
        // onset context (older callers) fires immediately — a real fault is
        // never silently lost, it just waits one debounce.
        const srcOnset = connectivity?.shp2SrcErrOnsetBySlot?.get(`${shp2.sn}:${s.slot}`);
        const srcDebounced = srcOnset != null && srcOnset.count === n && (now - srcOnset.sinceMs) < DPU_ERR_DEBOUNCE_MS;
        if (!srcDebounced) {
          // ★ v1.64.0 — `fault` carries the error CODE: this id is constant per
          // slot across every code, and the TITLE never varies here at all, so the
          // code is the ONLY discriminator between two different faults on the
          // same slot. Same rule as dpu-err above (see Alert.fault).
          out.push({ id: `shp2-src-err-${s.slot}`, severity: 'critical', category: 'SHP2', device: shp2.deviceName, sourceSn: shp2.sn, title: 'Energy source error', fault: `err${n}`, detail: `${tag} reports error code ${n}${n >= 500 && n < 600 ? ' (battery/BMS protection band)' : ''}.` });
        }
      }
      if (s.isConnected && !s.hwConnect) {
        out.push({ id: `shp2-src-hw-${s.slot}`, severity: 'warning', category: 'SHP2', device: shp2.deviceName, sourceSn: shp2.sn, title: 'Source link issue', detail: `${tag} shows connected but no hardware link.` });
      }
    }
    for (const pc of sp.pairedCircuits) {
      if (pc.watts == null || pc.breakerAmps == null) continue;
      const v = pc.isSplitPhase ? 240 : 120;
      const capacity = pc.breakerAmps * v;
      if (pc.watts >= capacity * CIRCUIT_BREAKER_WARN_FRAC) {
        out.push({ id: `circuit-overload-${pc.primaryCh}`, severity: 'warning', category: 'SHP2', device: shp2.deviceName, title: 'Circuit near breaker limit', detail: `${pc.name} drawing ${Math.round(pc.watts)} W — over ${Math.round(CIRCUIT_BREAKER_WARN_FRAC * 100)}% of its ${pc.breakerAmps} A breaker.` });
      }
    }
  }

  // v1.8.0 (review F3) — reserve-alarm-blind compensating alert. The entire
  // reserve chain (SoC ladder, near/below-reserve pair, runway) keys off the
  // SHP2's backup-pool %; the 30-day engine review found two cloud wedges (42.2h,
  // 25.8h) in which that value read null while the pool physically crossed
  // 50/40/30/20% — every reserve classifier sat dark for 17.8-20.8h with only a
  // generic connectivity warning. This alert says the RESERVE-specific thing:
  // "your reserve alarm is blind right now". Debounced to a sustained blind
  // window (the grace hold already absorbs reconnect blips; we additionally wait
  // RESERVE_BLIND_AFTER_MS) so routine flaps never fire it. Escalates to critical
  // after RESERVE_BLIND_CRITICAL_MS when the grid is NOT backstopping (off-grid,
  // a blind reserve alarm is genuinely dangerous) — the severity escalation
  // re-triggers the push channel via the alert monitor's escalation path. Listed
  // in ENERGY_STATE_FAMILIES so the auto-silencer can never eat it.
  if (shp2) {
    // v1.185.0 — this pool's OWN grid verdict (its panel alone) on a multi-panel plant; one panel: `grid`.
    const grid = housePoolGrid;
    const sp2 = shp2.projection?.kind === 'shp2' ? (shp2.projection as Shp2Projection) : null;
    const poolNull = sp2 == null || sp2.backupBatPercent == null;
    let blindSinceMs: number | null = null;
    if (poolNull) {
      // Pool published as unknown — onset tracked by the snapshot store
      // (post-grace-hold). Fallback to lastUpdated when the context is absent.
      blindSinceMs = connectivity?.backupPoolUnknownSinceMs ?? shp2.lastUpdated ?? null;
    } else if (!shp2.online) {
      // Cloud says the SHP2 is offline: the projection (incl. the pool %) is a
      // FROZEN last-known value, not live truth. Blind since the last fresh data.
      blindSinceMs = shp2.lastUpdated ?? null;
    }
    const blindMs = blindSinceMs != null ? now - blindSinceMs : 0;
    if (blindSinceMs != null && blindMs >= RESERVE_BLIND_AFTER_MS) {
      const offGrid = grid?.backstopping !== true;
      const critical = offGrid && blindMs >= RESERVE_BLIND_CRITICAL_MS;
      const fallbackSoc = housePoolFallbackSoc(devices); // v1.185.0 — this pool's own Cores on a two-panel plant
      const fallbackTxt = fallbackSoc != null
        ? `The SoC alarm ladder is running on the Core-fleet fallback (mean ${fallbackSoc.toFixed(0)}% across reporting Cores).`
        : 'No home Core is reporting either — the SoC alarm ladder is fully dark.';
      out.push({
        id: 'reserve-alarm-blind',
        severity: critical ? 'critical' : 'warning',
        category: 'Connectivity',
        device: shp2.deviceName,
        title: critical ? 'Reserve alarm blind — off-grid' : 'Reserve alarm blind',
        detail: `SHP2 backup-pool telemetry has been unreadable for ${fmtAge(blindMs)} — the reserve/runway alarms cannot see the pool. ${fallbackTxt}${offGrid ? '' : ' The grid is available as backup, so a low pool would transfer to mains.'} If this persists, power-cycle the SHP2 network connection.`,
        facts: [
          { label: 'Blind for', value: fmtAge(blindMs) },
          { label: 'Fallback ladder', value: fallbackSoc != null ? `${fallbackSoc.toFixed(0)}% (Core-fleet mean)` : 'unavailable' },
          { label: 'Escalates', value: offGrid ? `critical after ${fmtAge(RESERVE_BLIND_CRITICAL_MS)} blind` : 'suppressed while the grid is available as backup' },
        ],
      });
    }
  }

  // v0.12.0 — backup-pool SoC band alert. One on-screen alert for the lowest
  // SoC threshold the backup pool is currently at/below (50/40/30/20/15/10/8/4/2 %),
  // its severity/source chosen by socAlertSeverity so priorityOf() derives the
  // matching ISA tier (Low→Critical). The audible escalating alarm is fired
  // separately via broadcast.announce (batterySocAlarm + index.ts); the id MUST
  // start with 'backup-soc' so broadcast.ts excludes it from its own chime and
  // the dedicated announce stays the sole SoC audible.
  // v1.185.0 — the HOUSE panel (first-in-map before); every other panel: secondaryPanelAlerts.
  const socShp2 = shp2;
  const soc = socShp2?.projection.backupBatPercent ?? null;
  // v1.17.0 (engine-review F15) — hysteresis: track the held band across calls
  // so SoC chattering on a boundary (40↔41 every sample) doesn't toggle the
  // alert; it clears only once SoC climbs past band + 2 (the audible ladder's
  // own re-arm margin). State updates on EVERY call — including snapshots
  // where the shp2 pair suppresses the emission below — because the held band
  // describes the SoC, not whether this producer emitted.
  const band = activeSocBandWithHysteresis(soc, heldSocBandPct);
  heldSocBandPct = band?.pct ?? null;
  // v0.44.0 — dedup: the shp2-near-reserve / shp2-below-reserve pair above
  // (grid-aware) already owns the soc < reserve+10 window. Suppress the
  // backup-soc band push inside that window so the reserve story has ONE
  // on-screen producer; only emit the band alert ABOVE it. The shp2 pair fully
  // covers the suppressed window (near = (reserve, reserve+10), below = ≤reserve — v1.17.0 F14 inclusive),
  // so no reserve condition is dropped. Use the SAME reserve default as that
  // block (sp.backupReserveSoc ?? 15). The audible SoC alarm ladder is
  // untouched — this only gates the on-screen mirror.
  const socReserve = socShp2?.projection.backupReserveSoc ?? 15;
  // v0.44.0 — only treat the window as "covered" when the shp2-near/below pair is
  // actually ELIGIBLE to emit, i.e. the SHP2 is ONLINE (that pair is gated on
  // `shp2?.online` at line ~430). When the SHP2 is cloud-offline its projection —
  // hence `soc` — is still preserved by the snapshot store, but the pair does NOT
  // fire; suppressing the band too would drop the low-SoC reserve alert entirely.
  // Gating here keeps the band as the fallback on a faulted/offline SHP2.
  const coveredByShp2Pair = socShp2?.online === true && soc != null && soc < socReserve + 10;
  if (band !== null && soc != null && !coveredByShp2Pair) {
    // v1.185.0 — this pool's OWN grid verdict (its panel alone) on a multi-panel plant; one panel: `grid`.
    const grid = housePoolGrid;
    // v0.23.0 — grid backstopping ⇒ a low pool is a non-event; collapse the
    // emergency tiers (high/critical) to a low advisory so this on-screen alert
    // tracks the (also-downgraded) audible SoC alarm in lockstep.
    const onGridEmergency =
      grid?.backstopping === true && (band.priority === 'critical' || band.priority === 'high');
    // v0.44.0 — source is always 'threshold' now; the explicit ISA `priority`
    // (spread below) is what reaches Medium, so reserve bands show on the
    // operational Alerts page and read correctly in cleared history.
    const { severity, source, priority } = socAlertSeverity(onGridEmergency ? 'low' : band.priority);
    // v1.17.0 (F15) — inside the re-arm margin the SoC can sit 1-2 pts ABOVE
    // the held band; say so instead of the (then-false) "at or below". Compare
    // the ROUNDED value the operator sees (a 40.4% reading displays as 40 —
    // "near the 40% threshold" beside "at 40%" would read self-contradictory).
    const heldAbove = Math.round(soc) > band.pct;
    const heldNote = heldAbove ? ` (holding the ${band.pct}% band until above ${band.pct + 2}%)` : '';
    out.push({
      id: `backup-soc-${band.pct}`,
      severity,
      source,
      priority,
      category: 'Battery',
      device: 'SHP2 backup pool',
      // v1.78.0 — the band reads the SHP2's pool telemetry; without this the
      // SN-less id bypassed the falling-edge evidence gate entirely.
      ...(socShp2 ? { sourceSn: socShp2.sn } : {}),
      title: `Backup pool low — ${Math.round(soc)}%`,
      detail: onGridEmergency
        ? `Backup reserve at ${Math.round(soc)}%, ${heldAbove ? 'near' : 'at or below'} the ${band.pct}% threshold — ${gridBackupClause(grid)}, no action needed.${heldNote}`
        : `Backup reserve at ${Math.round(soc)}%, ${heldAbove ? 'near' : 'at or below'} the ${band.pct}% ${band.priority}-priority threshold.${heldNote}`,
    });
  }

  for (const panel of secondaryPanels(devices)) secondaryPanelAlerts(out, panel, devices, connectivity, poolGrid ? poolGrid(panel.sn) : grid, now);

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.category.localeCompare(b.category));
}

/**
 * v1.185.0 — a SECONDARY panel's own pool alerts: the house panel's reserve pair, source and
 * circuit faults, reserve-blind and SoC band (computeAlerts above), for one more panel. Ids take a
 * `-<serial>` suffix — familyOf() stops at the serial, so every family, never-muted and
 * energy-state rule applies unchanged — and titles lead with the panel's name so two pools can
 * be told apart on screen and in a push. The house panel's code above is deliberately left as it
 * was: one panel stays byte-identical.
 *
 * Differences from the house panel, both deliberate: no arbitrage posture (night charge never
 * writes a secondary panel's reserve, so under-reserve here is never "the plan filling"), and the
 * blind fallback is this pool's own Cores (panelMeanSoc), not the plant.
 */
function secondaryPanelAlerts(
  out: Alert[],
  panel: DeviceSnapshot,
  devices: Record<string, DeviceSnapshot>,
  connectivity: ConnectivityContext | undefined,
  grid: { present?: boolean; backstopping: boolean; reason?: string; importLive?: boolean } | undefined,
  now: number,
): void {
  const sfx = `-${panel.sn}`;
  const name = panel.deviceName;
  // v1.185.0 (review) — a panel with NO projection (dark since a restart) still has a pool: its
  // reserve alarm is blind from the moment it was first listed, and says so.
  if (panel.projection?.kind !== 'shp2') {
    const since = connectivity?.panelFirstListedBySn?.get(panel.sn) ?? null;
    pushReserveBlind(out, panel, devices, grid, since, now, sfx);
    return;
  }
  const sp = panel.projection as Shp2Projection;
  const onGrid = grid?.backstopping === true;
  const reserve = sp.backupReserveSoc ?? 15;
  if (panel.online && sp.backupBatPercent != null) {
    if (sp.backupBatPercent <= reserve) {
      out.push({
        id: `shp2-below-reserve${sfx}`,
        severity: onGrid ? 'warning' : 'critical',
        ...(onGrid ? { priority: 'medium' as const } : {}),
        category: 'SHP2', device: name, sourceSn: panel.sn,
        title: onGrid ? `${name}: backup at reserve — on grid` : `${name}: backup at or below reserve`,
        detail: onGrid
          ? `${name} backup pool ${sp.backupBatPercent}% is at or under its ${reserve}% reserve floor — ${gridBackupClause(grid)}, no action needed (${grid?.reason ?? 'grid present'}).`
          : `${name} backup pool ${sp.backupBatPercent}% is at or under its ${reserve}% reserve floor.`,
      });
    } else if (sp.backupBatPercent < reserve + 10) {
      out.push({
        id: `shp2-near-reserve${sfx}`,
        severity: onGrid ? 'info' : 'warning',
        category: 'SHP2', device: name, sourceSn: panel.sn,
        title: `${name}: backup approaching reserve`,
        detail: onGrid
          ? `${name} backup pool ${sp.backupBatPercent}% is close to its ${reserve}% reserve floor — ${gridBackupClause(grid)}, no action needed (${grid?.reason ?? 'grid present'}).`
          : `${name} backup pool ${sp.backupBatPercent}% is close to its ${reserve}% reserve floor.`,
      });
    }
  }
  if (panel.online) {
    for (const s of sp.sources ?? []) {
      const tag = `${name} slot ${s.slot}`;
      if ((s.errorCodeNum ?? 0) !== 0) {
        const n = s.errorCodeNum!;
        const onset = connectivity?.shp2SrcErrOnsetBySlot?.get(`${panel.sn}:${s.slot}`);
        const debounced = onset != null && onset.count === n && (now - onset.sinceMs) < DPU_ERR_DEBOUNCE_MS;
        if (!debounced) {
          out.push({ id: `shp2-src-err-${s.slot}${sfx}`, severity: 'critical', category: 'SHP2', device: name, sourceSn: panel.sn, title: 'Energy source error', fault: `err${n}`, detail: `${tag} reports error code ${n}${n >= 500 && n < 600 ? ' (battery/BMS protection band)' : ''}.` });
        }
      }
      if (s.isConnected && !s.hwConnect) {
        out.push({ id: `shp2-src-hw-${s.slot}${sfx}`, severity: 'warning', category: 'SHP2', device: name, sourceSn: panel.sn, title: 'Source link issue', detail: `${tag} shows connected but no hardware link.` });
      }
    }
    for (const pc of sp.pairedCircuits ?? []) {
      if (pc.watts == null || pc.breakerAmps == null) continue;
      const capacity = pc.breakerAmps * (pc.isSplitPhase ? 240 : 120);
      if (pc.watts >= capacity * CIRCUIT_BREAKER_WARN_FRAC) {
        out.push({ id: `circuit-overload-${pc.primaryCh}${sfx}`, severity: 'warning', category: 'SHP2', device: name, title: 'Circuit near breaker limit', detail: `${name}: ${pc.name} drawing ${Math.round(pc.watts)} W — over ${Math.round(CIRCUIT_BREAKER_WARN_FRAC * 100)}% of its ${pc.breakerAmps} A breaker.` });
      }
    }
  }
  // Reserve-alarm-blind, for this pool.
  const poolNull = sp.backupBatPercent == null;
  const blindSinceMs = poolNull
    ? connectivity?.backupPoolUnknownSinceBySn?.get(panel.sn) ?? panel.lastUpdated ?? null
    : !panel.online ? panel.lastUpdated ?? null : null;
  pushReserveBlind(out, panel, devices, grid, blindSinceMs, now, sfx);
  // SoC band, with the same hysteresis and the same hand-off to the reserve pair.
  const soc = sp.backupBatPercent ?? null;
  const band = activeSocBandWithHysteresis(soc, heldSocBandBySn.get(panel.sn) ?? null);
  heldSocBandBySn.set(panel.sn, band?.pct ?? null);
  const covered = panel.online === true && soc != null && soc < reserve + 10;
  if (band !== null && soc != null && !covered) {
    const onGridEmergency = onGrid && (band.priority === 'critical' || band.priority === 'high');
    const { severity, source, priority } = socAlertSeverity(onGridEmergency ? 'low' : band.priority);
    const heldAbove = Math.round(soc) > band.pct;
    const heldNote = heldAbove ? ` (holding the ${band.pct}% band until above ${band.pct + 2}%)` : '';
    out.push({
      id: `backup-soc-${band.pct}${sfx}`,
      severity, source, priority,
      category: 'Battery', device: `${name} backup pool`, sourceSn: panel.sn,
      title: `${name}: backup pool low — ${Math.round(soc)}%`,
      detail: onGridEmergency
        ? `${name} backup reserve at ${Math.round(soc)}%, ${heldAbove ? 'near' : 'at or below'} the ${band.pct}% threshold — ${gridBackupClause(grid)}, no action needed.${heldNote}`
        : `${name} backup reserve at ${Math.round(soc)}%, ${heldAbove ? 'near' : 'at or below'} the ${band.pct}% ${band.priority}-priority threshold.${heldNote}`,
    });
  }
}

/* ── v0.83.0 — SYSTEM DATA-GAP / UNPLANNED-OUTAGE ALERTING ──────────────────
 * The recorder already DETECTS + persists telemetry blackouts (a stretch with no
 * home-device samples > GAP_THRESHOLD_MS, incl. the restart-spanning variant that
 * catches a host power loss / add-on stop) into its gaps sidecar — but nothing
 * surfaced them to the operator. This turns each recent recorded gap into a
 * push-worthy alert so the operator is FLAGGED when the alarm system went dark
 * (e.g. the ~daily Pi power cut), and can tell whether a hardware fix — a UPS
 * firmware update, moving the Pi to an always-on circuit — actually stopped them.
 *
 * It is an EVENT, not a sustained condition: the outage is already over by the
 * time we detect it (writes resumed / the process rebooted). So it FIRES ONCE per
 * distinct gap (stable id `system-outage-<startMs>`), stays visible in the alert
 * list for a recent window, then ages off — and it is exempt from "Resolved:"
 * pushes (isOutageEventFamily), since an event doesn't "recover". Severity is
 * WARNING (routes to the push channel, operator-actionable) but NOT critical —
 * there is nothing to do in the moment; it's a retrospective flag. */

/** v1.14.0 (review of F10b) — duration tier for the outage alert id. A
 *  restart-spanning blackout that is EXTENDED in place (consecutive boots inside
 *  one outage share a startMs) kept the same alert id forever, so the operator's
 *  only push reported the first short segment ("dark 6 min") while the same gap
 *  grew to hours. Crossing a tier changes the id, which fires a fresh alert with
 *  the true magnitude; the old tier's alert ages off silently (outage events are
 *  exempt from resolve pushes). Tier 0 keeps the bare legacy id. */
export function outageDurationTier(durationMs: number): number {
  if (durationMs >= 6 * 3_600_000) return 3;  // ≥ 6 h
  if (durationMs >= 3_600_000) return 2;      // ≥ 1 h
  if (durationMs >= 15 * 60_000) return 1;    // ≥ 15 min
  return 0;
}

/** Stable id so the same gap never re-alerts (per tier) and the resolve path can
 *  exempt it. Keyed on the gap's startMs (immutable per gap, survives restarts
 *  via the sidecar) plus the duration tier (see outageDurationTier). The tier
 *  suffix is pure digits so familyOf() still rolls every variant up under the
 *  `system-outage` family. */
export function outageAlertId(startMs: number, durationMs = 0): string {
  const tier = outageDurationTier(durationMs);
  return tier === 0 ? `system-outage-${startMs}` : `system-outage-${startMs}-${tier}`;
}

/** An outage EVENT alert never sends a "Resolved:" push — it ages off silently. */
export function isOutageEventFamily(alert: Pick<Alert, 'id'>): boolean {
  return alert.id.startsWith('system-outage-');
}

/** v1.155.0 — a gap-ledger record as the alert layer reads it (recorder.ts
 *  `TelemetryGap`). `sn` is set only on a PER-DEVICE gap (v1.150.0): one device silent
 *  while the rest of the fleet kept writing. Every other record is a FLEET gap. */
export type TelemetryGapRecord = {
  startMs: number;
  endMs: number;
  durationMs: number;
  detectedAt: number;
  restartSpanning?: boolean;
  graceful?: boolean;
  sn?: string;
};

/** v1.155.0 — id for a PER-DEVICE gap alert. It stays inside the `system-outage-`
 *  prefix so the event lifecycle is the fleet one (no "Resolved:" push, not
 *  boot-seeded, never audible), and it carries the SN because the fleet id cannot
 *  tell these apart: devices written in the same batch share a startMs with each other
 *  AND with the fleet clock, so `system-outage-<startMs>` would collide and one alert
 *  would silently stand in for another. familyOf() stops at the SN's first uppercase
 *  token, so every variant rolls up as `system-outage-device`. */
export function deviceGapAlertId(sn: string, startMs: number, durationMs = 0): string {
  const tier = outageDurationTier(durationMs);
  return tier === 0 ? `system-outage-device-${sn}-${startMs}` : `system-outage-device-${sn}-${startMs}-${tier}`;
}

/** v1.155.0 — true for a per-device gap alert id (see deviceGapAlertId). */
export function isDeviceGapAlertId(id: string): boolean {
  return id.startsWith('system-outage-device-');
}

export interface OutageAlertOptions {
  /** Only surface gaps DETECTED within this window; older ones have aged off. */
  recentWindowMs: number;
  /** Ignore IN-PROCESS gaps shorter than this (a cloud/MQTT stall while the process stayed up). */
  minDurationMs: number;
  /**
   * v1.13.0 (review F10) — separate, typically LOWER floor for `restartSpanning`
   * gaps. A restart means the alarm was genuinely DOWN, so even a sub-15-min dark
   * window is operator-relevant (an 11-min deploy blackout previously produced no
   * "alarm was dark" alert at all). Optional + omittable: when absent, restart
   * gaps fall back to `minDurationMs` (exact pre-v1.13.0 behavior).
   */
  restartMinDurationMs?: number;
  /** Feature toggle. */
  enabled: boolean;
}

/** v1.14.0 — NaN-safe env number parse. `Math.max(50, Number('1,500'))` is NaN
 *  (Math.max propagates NaN), which downstream disabled the cleared-log trim AND
 *  made the save path persist an empty array — one bad env var atomically wiped
 *  the forensic sidecar. Non-finite input falls back to the default. */
export function envNum(raw: string | undefined, def: number, min: number): number {
  if (raw == null || raw.trim() === '') return def; // unset/empty ≠ zero
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, n) : def;
}

/** v1.14.0 (review — restart-floor wiring was untested) — single, testable source
 *  for the outage-alert options. Dropping `restartMinDurationMs` here (the exact
 *  mutation the review flagged as a maximally silent regression, since omitting
 *  it falls back to the 15-min floor by design) now fails a unit test. */
export function resolveOutageAlertOptions(env: Record<string, string | undefined>): OutageAlertOptions {
  return {
    enabled: (env.SYSTEM_OUTAGE_ALERT_ENABLED ?? 'true') !== 'false',
    recentWindowMs: envNum(env.SYSTEM_OUTAGE_RECENT_WINDOW_H, 24, 0) * 3_600_000,
    minDurationMs: envNum(env.SYSTEM_OUTAGE_MIN_MINUTES, 15, 0) * 60_000,
    restartMinDurationMs: envNum(env.SYSTEM_OUTAGE_RESTART_MIN_MINUTES, 5, 0) * 60_000,
  };
}

const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** v1.155.0 — the alert for a PER-DEVICE gap record. `device` carries the name, as on
 *  every device-scoped alert: notifyLocator appends it to the push title and the alerts
 *  panel shows it beside the title, so the title does not repeat it. */
function deviceGapAlert(g: TelemetryGapRecord, sn: string, mins: number, name: string | null | undefined): Alert {
  const label = name != null && name.trim() !== '' ? name : sn;
  const who = label === sn ? sn : `${label} (${sn})`;
  return {
    id: deviceGapAlertId(sn, g.startMs, g.durationMs),
    severity: 'warning',
    category: 'Connectivity',
    device: label,
    priority: 'medium',
    title: `Device telemetry gap — no data for ${mins} min`,
    detail: `${who} wrote no samples for ${mins} min (${fmtClock(g.startMs)} → ${fmtClock(g.endMs)}) while other home devices kept reporting — one device went dark, not the whole feed. The gap is measured to when it was detected, so the device may still be silent. Anything summed across the fleet in that window (production, load, forecast inputs) under-counts.`,
    facts: [
      { label: 'Device', value: who },
      { label: 'Duration', value: `${mins} min` },
      { label: 'Started', value: fmtClock(g.startMs) },
      { label: 'Detected', value: fmtClock(g.endMs) },
      { label: 'Type', value: 'per-device (other home devices kept reporting)' },
    ],
  };
}

/**
 * Build operator alerts from the recorder's recorded telemetry gaps. Pure +
 * exported so the recency / duration / dedup / restart-vs-stall wording is
 * unit-testable. One Alert per qualifying gap, newest first.
 */
export function outageAlerts(
  gaps: TelemetryGapRecord[],
  nowMs: number,
  opts: OutageAlertOptions,
  /** v1.155.0 — display name for a per-device gap's SN (the store's device map).
   *  Omitted or unresolved, the alert names the device by its serial. */
  deviceName?: (sn: string) => string | null | undefined,
): Alert[] {
  if (!opts.enabled) return [];
  const out: Alert[] = [];
  const startOf = new Map<string, number>();
  for (const g of gaps) {
    if (!Number.isFinite(g.startMs) || !Number.isFinite(g.durationMs)) continue;
    // v1.13.0 (F10) — a restart-spanning gap (the alarm was genuinely DOWN) clears
    // a lower floor than an in-process cloud stall; falls back to minDurationMs when
    // restartMinDurationMs is omitted (pre-v1.13.0 behavior).
    const floorMs = g.restartSpanning === true && opts.restartMinDurationMs != null
      ? opts.restartMinDurationMs
      : opts.minDurationMs;
    if (g.durationMs < floorMs) continue;                           // too short to bother the operator
    if (nowMs - g.detectedAt > opts.recentWindowMs) continue;        // aged out → drops from the list (no resolve push)
    const mins = Math.max(1, Math.round(g.durationMs / 60_000));
    // v1.155.0 — a PER-DEVICE gap (the record names an SN) is ONE device silent while
    // the rest of the fleet kept writing. It used to fall through to the fleet
    // in-process text below — "No home-device samples reached the recorder … an
    // MQTT/broker stall; writes have since resumed" — false on every clause: other
    // devices were writing, the broker was fine, and the record is written at
    // DETECTION, while the device is still dark.
    if (g.sn) {
      const alert = deviceGapAlert(g, g.sn, mins, deviceName?.(g.sn));
      startOf.set(alert.id, g.startMs);
      out.push(alert);
      continue;
    }
    const restart = g.restartSpanning === true;
    // v1.14.0 — a restart gap whose pre-boot anchor matched the clean-shutdown
    // marker was a DELIBERATE stop (deploy/update/restart). Still worth a record
    // (the alarm WAS dark), but at low priority and without the misleading
    // "get a UPS" remediation — at this project's release cadence that push
    // would otherwise fire on every deploy and poison the power-outage trend.
    const graceful = restart && g.graceful === true;
    const fleetId = outageAlertId(g.startMs, g.durationMs);
    startOf.set(fleetId, g.startMs);
    out.push({
      // v1.14.0 (F10b) — id carries the duration TIER so an in-place-extended
      // blackout re-notifies with its true magnitude instead of the operator's
      // last word staying "dark 6 min" on a 3-hour outage.
      id: fleetId,
      severity: 'warning',
      category: 'Connectivity',
      device: 'System',
      // Explicit ISA Medium (P3): operator-relevant, but retrospective — not an
      // immediate hardware danger, so it must not read as a High protective limit.
      priority: graceful ? 'low' : 'medium',
      title: graceful
        ? `Add-on restart — alarm was dark ${mins} min`
        : restart
          ? `System outage — alarm was dark ${mins} min`
          : `Telemetry gap — no data for ${mins} min`,
      detail: graceful
        ? `The add-on was deliberately stopped/updated (deploy or restart) and telemetry was dark for ${mins} min (${fmtClock(g.startMs)} → ${fmtClock(g.endMs)}). Expected downtime for a deploy; history in that window is unrecoverable.`
        : restart
          ? `No home telemetry was recorded for ${mins} min (${fmtClock(g.startMs)} → ${fmtClock(g.endMs)}), spanning a restart — the Pi lost power or the add-on stopped, so the alarm system was OFFLINE for that stretch and this window of history is unrecoverable. If this recurs, the Pi needs an always-on power source (UPS / dedicated circuit).`
          : `No home-device samples reached the recorder for ${mins} min (${fmtClock(g.startMs)} → ${fmtClock(g.endMs)}) — an MQTT/broker stall; writes have since resumed. History in that window is missing but the process stayed up.`,
      facts: [
        { label: 'Duration', value: `${mins} min` },
        { label: 'Started', value: fmtClock(g.startMs) },
        { label: 'Ended', value: fmtClock(g.endMs) },
        { label: 'Type', value: graceful ? 'deliberate stop (deploy/update)' : restart ? 'restart-spanning (power/host)' : 'in-process (MQTT stall)' },
      ],
    });
  }
  // Newest gap first so the most recent outage sorts to the top of its severity band.
  // v1.155.0 — by the gap's START, not the id string: every `system-outage-device-`
  // id sorts above every digit-led fleet id, so ordering by id put a day-old device
  // gap above a fresh power outage.
  return out.sort((a, b) => (startOf.get(b.id) ?? 0) - (startOf.get(a.id) ?? 0) || b.id.localeCompare(a.id));
}

/**
 * Compact operator-facing rollup of recorded outages over a window — feeds the
 * ha-state tiles / MQTT sensors so the operator can TRACK the trend (did the UPS
 * firmware fix reduce the count?) at a glance, independent of the transient alerts.
 */
export function outageTracking(
  gaps: TelemetryGapRecord[],
  nowMs: number,
  windowMs: number,
): { count: number; powerOutageCount: number; gracefulRestartCount: number; telemetryGapCount: number; totalMinutes: number; lastEndedMs: number | null; lastDurationMinutes: number | null } {
  // v1.155.0 — FLEET records only. A per-device gap (`sn` set) is one device silent
  // while the others kept writing: the feed and the alarm path were up. Counted here,
  // one dark Core added its whole silence (hours, by construction) to the outage
  // minutes, counted as a telemetry gap and turned system_outage_active_24h on. It is
  // counted apart, in deviceGapCount.
  const recent = gaps.filter((g) => !g.sn && Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs);
  const totalMs = recent.reduce((s, g) => s + Math.max(0, g.durationMs), 0);
  const last = recent.reduce<null | { endMs: number; durationMs: number }>(
    (acc, g) => (acc == null || g.endMs > acc.endMs ? { endMs: g.endMs, durationMs: g.durationMs } : acc),
    null,
  );
  // v1.4.1 (daytime-review #4) — split the total by cause. A `restartSpanning` gap means the
  // add-on/host itself was DOWN across the gap (a power / reboot event); a non-spanning gap is
  // a cloud/telemetry stall while the process kept running (the DNS/MQTT blips this fleet rides
  // out — see [[project_wifi_loss_root_cause]]). Mixing them made a benign cloud blip read as a
  // "system outage". `count` stays the total (unchanged for existing consumers); the split
  // counters let the operator answer "was that power, or just the cloud?" at a glance.
  // v1.14.0 — a graceful (deliberate stop/deploy) restart is NOT a power outage:
  // counting deploys as power events poisoned the trend the operator uses to
  // judge whether the daily-power-loss fix worked. Still in `count`/minutes.
  const restarts = recent.filter((g) => g.restartSpanning === true);
  const gracefulRestartCount = restarts.filter((g) => g.graceful === true).length;
  return {
    count: recent.length,
    powerOutageCount: restarts.length - gracefulRestartCount,
    gracefulRestartCount,
    telemetryGapCount: recent.length - restarts.length,
    totalMinutes: Math.round(totalMs / 60_000),
    lastEndedMs: last?.endMs ?? null,
    lastDurationMinutes: last != null ? Math.max(1, Math.round(last.durationMs / 60_000)) : null,
  };
}

/** v1.155.0 — per-device gaps in the window, counted APART from fleet outages (see
 *  outageTracking). A per-device record ends at DETECTION, so this counts blackouts
 *  noticed in the window, not devices that are dark right now. */
export function deviceGapCount(gaps: TelemetryGapRecord[], nowMs: number, windowMs: number): number {
  return gaps.filter((g) => !!g.sn && Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs).length;
}

/** v1.155.0 — the rollups /api/telemetry-gaps serves beside the raw ledger, split by
 *  kind. `count` is every record (both kinds, so it matches the array it sits beside).
 *  `longest_gap_min` is FLEET records only: it is read as the size of the worst
 *  blackout, and a multi-day single-Core record folded into it read as a multi-day
 *  fleet outage. Per-device records get their own count and longest. */
export function telemetryGapLedgerSummary(gaps: TelemetryGapRecord[]): {
  count: number; fleet_gap_count: number; longest_gap_min: number; device_gap_count: number; longest_device_gap_min: number;
} {
  const longestMin = (records: TelemetryGapRecord[]): number =>
    Math.round(records.reduce((m, g) => Math.max(m, g.durationMs), 0) / 60_000);
  const fleet = gaps.filter((g) => !g.sn);
  const device = gaps.filter((g) => !!g.sn);
  return {
    count: gaps.length,
    fleet_gap_count: fleet.length,
    longest_gap_min: longestMin(fleet),
    device_gap_count: device.length,
    longest_device_gap_min: longestMin(device),
  };
}

/** v1.14.0 (review — the recorder→tracking→HA payload hop was untested, and
 *  index.ts + mqttDiscovery.ts each hand-rolled the same field mapping) — the
 *  single source for the `system_outage_*` fields served at /api/ha-state and
 *  published to the MQTT state topic. */
export function systemOutageFields(
  gaps: TelemetryGapRecord[],
  nowMs: number,
): Record<string, number | boolean | null> {
  const t = outageTracking(gaps, nowMs, 24 * 3_600_000);
  return {
    // `system_outage_active_24h` is a 24 h OR-of-past-events flag ("a gap occurred
    // in the last 24 h"), NOT "a gap is happening right now" — `..._last_ended`
    // is the field to read for recency. `count`/`total` stay the mixed total for
    // backward compatibility.
    system_outage_active_24h: t.count > 0,
    system_outage_count_24h: t.count,
    // Split by cause so a benign cloud/telemetry stall (or a deliberate deploy)
    // isn't mistaken for a power event.
    system_power_outage_count_24h: t.powerOutageCount,     // add-on/host DOWN, NOT deliberate
    system_graceful_restart_count_24h: t.gracefulRestartCount, // deliberate stop/update (deploys)
    system_telemetry_gap_count_24h: t.telemetryGapCount,   // cloud/MQTT stall, process stayed up
    system_outage_total_minutes_24h: t.totalMinutes,
    system_outage_last_ended: t.lastEndedMs, // epoch ms, null if none in 24 h
    system_outage_last_duration_minutes: t.lastDurationMinutes,
    // v1.155.0 — one device silent while the others kept reporting. Not an outage, so
    // it is in none of the fields above; published so a single-device blackout shows
    // up in HA at all.
    system_device_gap_count_24h: deviceGapCount(gaps, nowMs, 24 * 3_600_000),
  };
}

/** v1.185.0 — a secondary pool's reserve-alarm-blind alert (the house panel's, for one more pool). */
function pushReserveBlind(
  out: Alert[],
  panel: DeviceSnapshot,
  devices: Record<string, DeviceSnapshot>,
  grid: { present?: boolean; backstopping: boolean; reason?: string; importLive?: boolean } | undefined,
  blindSinceMs: number | null,
  now: number,
  sfx: string,
): void {
  const name = panel.deviceName;
  const onGrid = grid?.backstopping === true;
  const blindMs = blindSinceMs != null ? now - blindSinceMs : 0;
  if (blindSinceMs != null && blindMs >= RESERVE_BLIND_AFTER_MS) {
    const critical = !onGrid && blindMs >= RESERVE_BLIND_CRITICAL_MS;
    const fallbackSoc = panelMeanSoc(devices, panel);
    out.push({
      id: `reserve-alarm-blind${sfx}`,
      severity: critical ? 'critical' : 'warning',
      category: 'Connectivity', device: name, sourceSn: panel.sn,
      title: critical ? `${name}: reserve alarm blind — off-grid` : `${name}: reserve alarm blind`,
      detail: `${name} backup-pool telemetry has been unreadable for ${fmtAge(blindMs)} — its reserve and runway alarms cannot see the pool. ${fallbackSoc != null ? `Its SoC alarm ladder is running on its own Cores (mean ${fallbackSoc.toFixed(0)}%).` : 'None of its Cores is reporting either — its SoC alarm ladder is dark.'}${onGrid ? ' The grid is available as backup, so a low pool would transfer to mains.' : ''} If this persists, power-cycle the panel's network connection.`,
      facts: [
        { label: 'Blind for', value: fmtAge(blindMs) },
        { label: 'Fallback ladder', value: fallbackSoc != null ? `${fallbackSoc.toFixed(0)}% (this panel's Cores)` : 'unavailable' },
        { label: 'Escalates', value: onGrid ? 'suppressed while the grid is available as backup' : `critical after ${fmtAge(RESERVE_BLIND_CRITICAL_MS)} blind` },
      ],
    });
  }
}
