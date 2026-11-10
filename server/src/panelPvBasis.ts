/**
 * v1.204.0 — THE PANEL-MEASURED SOLAR BASIS: the night plan's solar from the panel's own per-slot
 * reading of each Core's chargers (`src{n}_pv_w`), judged by a 7-day full-day energy balance.
 *
 * WHY. With the house Cores dark on the vendor cloud, the Cores' own solar meter (`pv_total`) is
 * gone, so the published band has no scored days and v1.203.0 plans the night cushion-only. The
 * panel still measures each slot's solar. This module decides, from durable rows alone, when that
 * reading may stand in for the Cores' meter in the PLANNING model (the cost fill), and supplies the
 * per-slot hours the worker fits it on. The outage line never reads it (nightChargeAdvisor's line is
 * PV-independent), and the runway alarm never reads it (computeRunway reads hours[].forecastPvW).
 *
 * WHAT IT IS, in five parts (each pure; the worker reads the recorder and hands the rows in):
 *
 *  1. RESOLVER (resolveSlotHour). Per slot and site hour, one source, never two:
 *     - the slot's Core that day (one Core per slot-day, from the membership record) when its own
 *       pv_total covers at least HOUR_COVER_MIN_S of the hour (G1);
 *     - else the FIELD when it covers HOUR_COVER_MIN_S on the integrateWh rule (G2), the slot-day is
 *       bridge-verified for that day's Core (G3), the hour is not frozen (the freeze detector on
 *       src{n}_pv_hv_w / _lv_w) and is not an unproved daylight AC-charge hour (G11); for the planning
 *       model only, the slot-day must also be ADMITTED as of the evening E (part 5);
 *     - else a partial Core hour when the Core has any coverage;
 *     - else a GAP, never 0 W in daylight.
 *  2. CONSTANTS (fitPlantConstants). Per (slot, Core): (c_d, c_n, g, e_d, e_n) by least squares over
 *     every complete site day on which that Core sat in that slot (the record vouches) with its own
 *     pv_total in every hour; target per hour pv_total in daylight, 0 at night, minus the %-energy
 *     change ΔE = (pct_end − pct_start) × C / 100, C the panel's own per-source fullCap for the slot.
 *     At least CONSTANTS_MIN_DAYS days and CONSTANTS_MIN_CHARGE_HOURS night hours with
 *     CONSTANTS_CHARGE_HOUR_MIN_WH of AC in, else none. No owner option is read: the constants are
 *     measured against the Core's own solar meter.
 *  3. DAY RECORDS (buildSlotDay, buildUcDay). Per slot-day: completeness, field share of daylight,
 *     the resolved solar, the estimate est = ΔE + c·O − g·I + e (daylight and night apart), the
 *     largest night field hour, frozen hours, the overlap with the Core's own meter (G10). Per day:
 *     the slot→Core map of record and the vendor check (G6) over EVERY slot's field.
 *  4. UPPER CHECK (upperCheck). As of the evening E that owns the window (complete site days ≤ E−1):
 *     ≥ UC_WINDOW_DAYS field days in E−14..E−1, the newest ≥ E−2, no judged-bad day (G4 a night field
 *     hour above G4_NIGHT_FIELD_MAX_W, G6 a vendor mismatch) in E−14..E−1 and no G10 day in E−30..E−1,
 *     and every window ending on each of the last 7 field days at or below UC_THRESHOLD:
 *       R = Σ_s Σ_d truth / Σ_s [Σ_d est_day + min(0, Σ_d est_night)]
 *     (the nights, where the truth is 0 by physics, may only LOWER the estimate).
 *  5. ADMISSION (admittedSlotDays). A field slot-day reaches the planning fit, bias and skill only if
 *     at least one window holding it was judged, with that slot summed, and none of them failed.
 *     Today and day E never enter.
 *
 * TIME. Every answer is a function of E and the durable rows of the site days before it, so 21:30,
 * 22:30 and any recompute to the window's close read one verdict, and a restart reads the same. E is
 * passed in: the site day of the evening decision that owns the window (the plan date), never the
 * window's start day (a Saturday's window starts on Monday).
 *
 * Slot keys ('<panelSn>#<n>') and serials are never printed by this module; its reasons carry slot
 * numbers and days only.
 */
import { windowIntegrator } from './aggregator.js';
import { addDaysYmd, siteDayStartMs, siteYmd } from './siteTime.js';
import { membershipsDuring, type MembershipHistory } from './membershipHistory.js';

const H = 3_600_000;

/* ─── constants (measured or structural; none is an owner option) ──────────────────────────── */

/** The 7-day energy balance refuses above this (strict). Measured on the specified basis (nameplate
 *  fullCap, the record-vouched days): 0 of the 45 Core-era windows (in sample, 0.9900–1.0291) and 0 of
 *  the dark evenings 10-28..11-07 (0.9882–1.0285) above it; a code constant, not an option. */
export const UC_THRESHOLD = 1.04;
/** Field days in one balance window. */
export const UC_WINDOW_DAYS = 7;
/** A window's days lie within this many site days of its end (inclusive span e−13..e). */
export const UC_WINDOW_SPAN_DAYS = 14;
/** The verdict counts field days in E−14..E−1. */
export const UC_LOOKBACK_DAYS = 14;
/** The newest field day is at least E−2. */
export const UC_NEWEST_MAX_AGE_DAYS = 2;
/** Stateless hysteresis: every window ending on each of the last 7 field days must pass. */
export const UC_HYSTERESIS_WINDOWS = 7;
/** The planning model's window (the solar fit, the skill), site days before E. */
export const PLANNING_WINDOW_DAYS = 30;
/** Site days of day records the verdict and admission read (E−44..E−1). */
export const UC_TABLE_DAYS = PLANNING_WINDOW_DAYS + UC_WINDOW_SPAN_DAYS;
/** A source covers an hour with at least this many seconds of it (G1, G2, the slot meter). */
export const HOUR_COVER_MIN_S = 3500;
/** A slot percent at an hour boundary is the last row at or before it, at most this old. */
export const LEVEL_MAX_AGE_MS = 10 * 60_000;
/** The integrateWh rule's longest bridged gap (rows at most 10 min apart). */
export const INTEGRATE_MAX_GAP_MS = 10 * 60_000;
/** A slot takes the field on a day when the field resolves at least this share of its daylight hours. */
export const FIELD_DAYLIGHT_MIN_FRAC = 0.8;
/** A slot's Core covers a day when its own pv_total covers at least this share of its daylight hours. */
export const CORE_DAYLIGHT_MIN_FRAC = 0.8;
/** G3: the share of a slot-day's daylight bridge windows booked 'measured' for that day's Core. */
export const G3_MEASURED_MIN_FRAC = 0.8;
/** G4: a night hour whose field mean is above this is not a solar reading. */
export const G4_NIGHT_FIELD_MAX_W = 20;
/** G6: |Σ every slot's field − the vendor's daily solar| at most max(this, G6_TOLERANCE_FRAC × vendor). */
export const G6_TOLERANCE_WH = 500;
export const G6_TOLERANCE_FRAC = 0.02;
/** A judged-bad day (G4, G6) refuses the evenings after it for this many days. */
export const JUDGED_BAD_HOLD_DAYS = 14;
/** G10: on a day the field and the slot's Core both cover ≥ 80 % of daylight with ≥ 10 kWh, a field
 *  above the Core's own figure by more than 2 % refuses that slot's field for 30 days. */
export const G10_HOLD_DAYS = 30;
export const G10_MAX_RATIO = 1.02;
export const G10_MIN_CORE_WH = 10_000;
/** The freeze detector: ≥ FREEZE_RUN_PAIRS consecutive daylight restatements (rows at least
 *  FREEZE_MIN_STEP_MS apart, unchanged within FREEZE_TOLERANCE_W, above FREEZE_MIN_W). The recorder
 *  restates an unchanged value every 300 s, so a frozen MPPT field is caught at its second restatement. */
export const FREEZE_MIN_STEP_MS = 290_000;
export const FREEZE_TOLERANCE_W = 0.5;
export const FREEZE_MIN_W = 50;
export const FREEZE_RUN_PAIRS = 2;
/** G11: a daylight hour in which the slot meter read AC into the Core above G11_AC_IN_W for more than
 *  G11_AC_IN_MIN_S is a gap until the slot is proved under charge: ≥ G11_PROOF_MIN_MS at ≥
 *  G11_PROOF_AC_IN_W of AC in, at night, with the field at most G11_PROOF_FIELD_MAX_W throughout. */
export const G11_AC_IN_W = 25;
export const G11_AC_IN_MIN_S = 60;
export const G11_PROOF_AC_IN_W = 1000;
export const G11_PROOF_MIN_MS = 30 * 60_000;
export const G11_PROOF_FIELD_MAX_W = 20;
/** The constants need this many complete days of the Core's own pv_total in the slot … */
export const CONSTANTS_MIN_DAYS = 21;
/** … and this many night hours with at least CONSTANTS_CHARGE_HOUR_MIN_WH of AC in (g is fitted on them). */
export const CONSTANTS_MIN_CHARGE_HOURS = 20;
export const CONSTANTS_CHARGE_HOUR_MIN_WH = 300;

export interface Pt { ts: number; value: number }

/* ─── point helpers ────────────────────────────────────────────────────────────────────────── */

/** Index of the last row with ts ≤ ms (−1 when none). `pts` sorted by ts. */
function lastAtOrBefore(pts: readonly Pt[], ms: number): number {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (pts[m].ts <= ms) lo = m + 1; else hi = m;
  }
  return lo - 1;
}

/** The level at `ms`: the last row at or before it, when at most `maxAgeMs` old; else null. */
export function levelAt(pts: readonly Pt[], ms: number, maxAgeMs: number = LEVEL_MAX_AGE_MS): number | null {
  const i = lastAtOrBefore(pts, ms);
  if (i < 0) return null;
  return ms - pts[i].ts <= maxAgeMs ? pts[i].value : null;
}

/** A series' rows mapped (the slot meter split into AC out / AC in), order kept. */
const mapPts = (pts: readonly Pt[], f: (v: number) => number): Pt[] => pts.map((p) => ({ ts: p.ts, value: f(p.value) }));

/**
 * The spans in which a field restates one value: FREEZE_RUN_PAIRS or more consecutive row pairs, both
 * rows in daylight, at least FREEZE_MIN_STEP_MS apart, unchanged within FREEZE_TOLERANCE_W and above
 * FREEZE_MIN_W. Each span runs from the first row of its run to the last. Pure.
 */
export function freezeSpans(pts: readonly Pt[], sun: (ms: number) => boolean): Array<{ fromMs: number; toMs: number }> {
  const out: Array<{ fromMs: number; toMs: number }> = [];
  let run = 0;
  let runFrom = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const restated = b.ts - a.ts >= FREEZE_MIN_STEP_MS
      && Math.abs(b.value - a.value) < FREEZE_TOLERANCE_W
      && a.value > FREEZE_MIN_W
      && sun(a.ts) && sun(b.ts);
    if (!restated) { run = 0; continue; }
    if (run === 0) runFrom = a.ts;
    run++;
    if (run === FREEZE_RUN_PAIRS) out.push({ fromMs: runFrom, toMs: b.ts });
    else if (run > FREEZE_RUN_PAIRS) out[out.length - 1].toMs = b.ts;
  }
  return out;
}

/**
 * G11's proof that a slot's field does not read AC charge as solar: the earliest instant at which the
 * slot meter (`src{n}_w`, positive = AC into the Core) has read ≥ G11_PROOF_AC_IN_W for
 * G11_PROOF_MIN_MS without a break, at night at both ends of every row pair, with the field present and
 * at most G11_PROOF_FIELD_MAX_W throughout; null when the rows hold none. Pure.
 */
export function chargeProofAt(srcW: readonly Pt[], field: readonly Pt[], sun: (ms: number) => boolean): number | null {
  let runFrom: number | null = null;
  for (let i = 1; i < srcW.length; i++) {
    const a = srcW[i - 1];
    const b = srcW[i];
    let ok = b.ts - a.ts <= INTEGRATE_MAX_GAP_MS && a.value >= G11_PROOF_AC_IN_W && !sun(a.ts) && !sun(b.ts);
    if (ok) {
      const f0 = levelAt(field, a.ts);
      if (f0 == null || f0 > G11_PROOF_FIELD_MAX_W) ok = false;
      else {
        for (let j = lastAtOrBefore(field, a.ts) + 1; j < field.length && field[j].ts <= b.ts; j++) {
          if (field[j].value > G11_PROOF_FIELD_MAX_W) { ok = false; break; }
        }
      }
    }
    if (!ok) { runFrom = null; continue; }
    if (runFrom == null) runFrom = a.ts;
    if (b.ts - runFrom >= G11_PROOF_MIN_MS) return b.ts;
  }
  return null;
}

/** Seconds of [fromMs, toMs) in which the slot meter read AC into the Core above G11_AC_IN_W (each row
 *  held until the next, when the next is at most INTEGRATE_MAX_GAP_MS later). Pure. */
export function acInSeconds(srcW: readonly Pt[], fromMs: number, toMs: number): number {
  let ms = 0;
  for (let i = Math.max(1, lastAtOrBefore(srcW, fromMs) + 1); i < srcW.length; i++) {
    const a = srcW[i - 1];
    const b = srcW[i];
    if (a.ts >= toMs) break;
    if (b.ts - a.ts > INTEGRATE_MAX_GAP_MS || !(a.value > G11_AC_IN_W)) continue;
    const s = Math.max(a.ts, fromMs);
    const e = Math.min(b.ts, toMs);
    if (e > s) ms += e - s;
  }
  return ms / 1000;
}

/* ─── slot-hours ───────────────────────────────────────────────────────────────────────────── */

/** One slot's panel series over a span, raw rows sorted by ts (each from at least 10 min before it). */
export interface SlotSeries {
  /** src{n}_pct, the slot's percent. */
  pct: readonly Pt[];
  /** src{n}_w, the slot meter (negative = the Core supplies the panel). */
  srcW: readonly Pt[];
  /** src{n}_pv_w, the panel's per-slot solar field. */
  field: readonly Pt[];
  /** src{n}_pv_hv_w and src{n}_pv_lv_w, the two MPPT fields (the freeze detector). */
  hv: readonly Pt[];
  lv: readonly Pt[];
}

/** One slot-hour's aggregates. Energies are the hour's (the integral over the covered part scaled to the
 *  hour), null below HOUR_COVER_MIN_S of coverage. */
export interface SlotHour {
  startMs: number;
  /** The sun is up at either end of the hour. */
  sun: boolean;
  pct0: number | null;
  pct1: number | null;
  /** ∫ max(0, −src_w): AC out of the Core into the panel, Wh. */
  outWh: number | null;
  /** ∫ max(0, src_w): AC into the Core, Wh. */
  inWh: number | null;
  /** Seconds of the hour with AC into the Core above G11_AC_IN_W. */
  acInS: number;
  /** The field's hour energy, Wh (null below HOUR_COVER_MIN_S). */
  fieldWh: number | null;
  fieldCovS: number;
  /** The freeze detector marked a span of this hour on src{n}_pv_hv_w or _lv_w. */
  frozen: boolean;
  /** The slot's Core of that day: its own pv_total over the covered part of the hour, Wh, and the
   *  seconds covered (0 / 0 with no Core or no rows). */
  coreRawWh: number;
  coreCovS: number;
}

/**
 * The slot-hours of `hourStarts` (each hour [h, h + 1 h)). `corePts(h)` is the pv_total series of the
 * Core the membership record puts in the slot on that hour's site day (null: no Core the record can
 * vouch for). `sun(ms)` is the site's sun test (energyBridge sunUp). Pure.
 */
export function buildSlotHours(
  hourStarts: readonly number[],
  series: SlotSeries,
  corePts: (hourStartMs: number) => readonly Pt[] | null,
  sun: (ms: number) => boolean,
): SlotHour[] {
  const out = windowIntegrator(mapPts(series.srcW, (v) => Math.max(0, -v)));
  const inn = windowIntegrator(mapPts(series.srcW, (v) => Math.max(0, v)));
  const fld = windowIntegrator(series.field as Pt[]);
  const frozen = [...freezeSpans(series.hv, sun), ...freezeSpans(series.lv, sun)];
  const coreInts = new Map<readonly Pt[], ReturnType<typeof windowIntegrator>>();
  const hourWh = (r: { wh: number; coverageMs: number }): number | null =>
    r.coverageMs / 1000 >= HOUR_COVER_MIN_S ? (r.wh * H) / r.coverageMs : null;
  return hourStarts.map((h) => {
    const e = h + H;
    const o = out(h, e);
    const i = inn(h, e);
    const f = fld(h, e);
    const cp = corePts(h);
    let coreRawWh = 0;
    let coreCovS = 0;
    if (cp != null && cp.length > 0) {
      let integ = coreInts.get(cp);
      if (!integ) coreInts.set(cp, (integ = windowIntegrator(cp as Pt[])));
      const c = integ(h, e);
      coreRawWh = c.wh;
      coreCovS = c.coverageMs / 1000;
    }
    return {
      startMs: h,
      sun: sun(h) || sun(e),
      pct0: levelAt(series.pct, h),
      pct1: levelAt(series.pct, e),
      outWh: hourWh(o),
      inWh: hourWh(i),
      acInS: acInSeconds(series.srcW, h, e),
      fieldWh: hourWh(f),
      fieldCovS: f.coverageMs / 1000,
      frozen: frozen.some((sp) => sp.toMs >= h && sp.fromMs < e),
      coreRawWh,
      coreCovS,
    };
  });
}

/* ─── resolver ─────────────────────────────────────────────────────────────────────────────── */

export type HourSource = 'core' | 'field' | 'core-partial' | 'gap';

/** Why a field hour is not taken. */
export type FieldRefusal = 'coverage' | 'bridge' | 'frozen' | 'ac-charge';

/** Does the field stand for the hour (G2, G3, the freeze detector, G11)? null = it does, else why not. */
export function fieldHourRefusal(h: SlotHour, g3: boolean, provedUnderCharge: boolean): FieldRefusal | null {
  if (h.fieldWh == null) return 'coverage';
  if (!g3) return 'bridge';
  if (h.sun && h.frozen) return 'frozen';
  if (h.sun && h.acInS > G11_AC_IN_MIN_S && !provedUnderCharge) return 'ac-charge';
  return null;
}

/**
 * One source per slot-hour: the Core with ≥ HOUR_COVER_MIN_S of its own pv_total (G1); else the field
 * (fieldHourRefusal null, and `admitted` — the planning model's admission; the upper check passes true);
 * else a partial Core hour; else a gap. `w` is the hour's mean power, W (null for a gap). Pure.
 */
export function resolveSlotHour(
  h: SlotHour,
  ctx: { g3: boolean; provedUnderCharge: boolean; admitted: boolean },
): { source: HourSource; w: number | null } {
  if (h.coreCovS >= HOUR_COVER_MIN_S) return { source: 'core', w: (h.coreRawWh * 3600) / h.coreCovS };
  if (ctx.admitted && fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: h.fieldWh as number };
  if (h.coreCovS > 0) return { source: 'core-partial', w: (h.coreRawWh * 3600) / h.coreCovS };
  return { source: 'gap', w: null };
}

/* ─── constants ────────────────────────────────────────────────────────────────────────────── */

export interface PlantConstants {
  /** AC-out coefficient in daylight / at night. */
  cd: number;
  cn: number;
  /** AC-in (grid charge) efficiency. */
  g: number;
  /** Standing terms, W, in daylight / at night. */
  ed: number;
  en: number;
  /** Complete days fitted, and their first and last. */
  days: number;
  firstDay: string;
  lastDay: string;
  /** Night hours with ≥ CONSTANTS_CHARGE_HOUR_MIN_WH of AC in. */
  chargeHours: number;
  /** The capacity basis the constants were fitted on (the panel's per-source fullCap), Wh. */
  capacityWh: number;
}

/** What a fit found, constants or not (the refusal names the counts). */
export interface ConstantsFit {
  constants: PlantConstants | null;
  days: number;
  chargeHours: number;
  dayList: string[];
}

/** A day usable by the fit: every hour has the slot percent at both ends, the slot meter both ways and
 *  the Core's own pv_total, each with HOUR_COVER_MIN_S of coverage. */
export function fitDayUsable(hours: readonly SlotHour[]): boolean {
  return hours.length > 0 && hours.every((h) =>
    h.pct0 != null && h.pct1 != null && h.outWh != null && h.inWh != null && h.coreCovS >= HOUR_COVER_MIN_S);
}

/** Solve the normal equations AᵀA x = Aᵀy by Gaussian elimination with partial pivoting; null when
 *  singular. Deterministic. */
function leastSquares(X: readonly number[][], y: readonly number[]): number[] | null {
  const n = X[0]?.length ?? 0;
  if (n === 0 || X.length < n) return null;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let r = 0; r < X.length; r++) {
    const x = X[r];
    for (let i = 0; i < n; i++) {
      b[i] += x[i] * y[r];
      for (let j = 0; j < n; j++) A[i][j] += x[i] * x[j];
    }
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!(Math.abs(A[p][c]) > 1e-9)) return null;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k];
    x[i] = s / A[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Fit (c_d, c_n, g, e_d, e_n) for one (slot, Core) on `days` (each the slot-hours of one site day the
 * record vouches the Core sat in the slot; days fitDayUsable rejects are skipped). The coefficients on
 * the %-energy gain and loss are both 1 (structural). Null constants below CONSTANTS_MIN_DAYS usable
 * days or CONSTANTS_MIN_CHARGE_HOURS charge hours, or without a capacity. Pure and deterministic.
 */
export function fitPlantConstants(
  days: ReadonlyArray<{ day: string; hours: readonly SlotHour[] }>,
  capacityWh: number | null,
): ConstantsFit {
  const used = days.filter((d) => fitDayUsable(d.hours)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const dayList = used.map((d) => d.day);
  let chargeHours = 0;
  for (const d of used) for (const h of d.hours) if (!h.sun && (h.inWh as number) >= CONSTANTS_CHARGE_HOUR_MIN_WH) chargeHours++;
  const none: ConstantsFit = { constants: null, days: used.length, chargeHours, dayList };
  if (capacityWh == null || !(capacityWh > 0)) return none;
  if (used.length < CONSTANTS_MIN_DAYS || chargeHours < CONSTANTS_MIN_CHARGE_HOURS) return none;
  const X: number[][] = [];
  const y: number[] = [];
  for (const d of used) {
    for (const h of d.hours) {
      const sun = h.sun ? 1 : 0;
      const dE = ((h.pct1 as number) - (h.pct0 as number)) * capacityWh / 100;
      const pv = h.sun ? (h.coreRawWh * 3600) / h.coreCovS : 0;
      X.push([(h.outWh as number) * sun, (h.outWh as number) * (1 - sun), h.inWh as number, sun, 1 - sun]);
      y.push(pv - dE);
    }
  }
  const c = leastSquares(X, y);
  if (c == null) return none;
  return {
    constants: { cd: c[0], cn: c[1], g: -c[2], ed: c[3], en: c[4], days: used.length, firstDay: dayList[0], lastDay: dayList[dayList.length - 1], chargeHours, capacityWh },
    days: used.length,
    chargeHours,
    dayList,
  };
}

/** The balance estimate of one slot-hour, Wh: ΔE + c·O − g·I + e. Null without the slot data. */
export function hourEstimateWh(h: SlotHour, k: PlantConstants, capacityWh: number): number | null {
  if (h.pct0 == null || h.pct1 == null || h.outWh == null || h.inWh == null) return null;
  const dE = ((h.pct1 - h.pct0) * capacityWh) / 100;
  return dE + (h.sun ? k.cd : k.cn) * h.outWh - k.g * h.inWh + (h.sun ? k.ed : k.en);
}

/* ─── day records ──────────────────────────────────────────────────────────────────────────── */

export type IncompleteCause = 'no-hours' | 'pct' | 'meter' | FieldRefusal;

/** One slot's site day. */
export interface SlotDay {
  slot: number;
  day: string;
  /** The slot's Core that day in the membership record (null: it changed or the record cannot say). */
  core: string | null;
  hours: number;
  daylightHours: number;
  /** G3 for that day's Core. */
  g3: boolean;
  /** Every hour has the slot percent at both ends, the slot meter both ways, and resolves (the Core
   *  with G1, or a field hour that passes G2, G3, the freeze detector and G11). */
  complete: boolean;
  /** The first cause, in hour order, when not complete. */
  incomplete: { startMs: number; cause: IncompleteCause } | null;
  /** Daylight hours resolved to the field / covered by the Core's own pv_total (G1). */
  fieldDaylightHours: number;
  coreDaylightHours: number;
  /** The resolved solar over the day, Wh (the upper check's truth: the field as read, the Core's own
   *  figure in its hours), and its daylight part. */
  truthWh: number;
  truthDaylightWh: number;
  /** The balance estimate, daylight and night apart, Wh (null without constants or a complete day). */
  estDayWh: number | null;
  estNightWh: number | null;
  /** The largest night hour the field resolved, with the slot's AC in that hour (G4). */
  nightMax: { w: number; startMs: number; acInWh: number } | null;
  frozenHours: number;
  /** Daylight hours with AC in, and those the proof does not cover (G11 gaps). */
  acChargeHours: number;
  unprovedAcChargeHours: number;
  /** The panel's field over every hour, Wh, whatever the resolver chose (G6); null when an hour lacks
   *  HOUR_COVER_MIN_S. */
  fieldAllWh: number | null;
  /** G10: the daylight hours both the field and the Core's own pv_total cover, and their energies. */
  overlap: { hours: number; fieldWh: number; coreWh: number };
}

/** One energy-bridge window of the day (bridge_ledger), for G3. */
export interface BridgeWindowRow { sn: string; panelSn: string; slot: number; basis: string }

/**
 * G3 for one slot-day: the bridge trusts the slot's field now (its persisted 'consistent' verdict) and
 * booked ≥ G3_MEASURED_MIN_FRAC of the day's daylight windows of that slot 'measured' FOR THAT DAY'S
 * CORE (a window booked for another Core counts against it: a swap is visible). Pure.
 */
export function bridgeVerified(
  rows: readonly BridgeWindowRow[],
  panelSn: string,
  slot: number,
  core: string | null,
  trusted: boolean,
): { g3: boolean; measured: number; windows: number } {
  let measured = 0;
  let windows = 0;
  for (const r of rows) {
    if (r.panelSn !== panelSn || r.slot !== slot || r.basis === 'night') continue;
    windows++;
    if (r.basis === 'measured' && core != null && r.sn === core) measured++;
  }
  return { g3: trusted && core != null && windows > 0 && measured >= G3_MEASURED_MIN_FRAC * windows, measured, windows };
}

/** The site hours of `day` (a DST day has 23 or 25). */
export function siteHourStarts(day: string): number[] {
  const s = siteDayStartMs(day);
  const e = siteDayStartMs(addDaysYmd(day, 1));
  const out: number[] = [];
  for (let h = s; h < e; h += H) out.push(h);
  return out;
}

/** One slot-day from its slot-hours. `constants` is that day's Core's (null: none). Pure. */
export function buildSlotDay(
  slot: number,
  day: string,
  hours: readonly SlotHour[],
  ctx: { core: string | null; g3: boolean; provedUnderCharge: boolean; constants: PlantConstants | null; capacityWh: number | null },
): SlotDay {
  let daylightHours = 0;
  let fieldDaylightHours = 0;
  let coreDaylightHours = 0;
  let truthWh = 0;
  let truthDaylightWh = 0;
  let estDay = 0;
  let estNight = 0;
  let estOk = ctx.constants != null && ctx.capacityWh != null;
  let incomplete: SlotDay['incomplete'] = hours.length === 0 ? { startMs: siteDayStartMs(day), cause: 'no-hours' } : null;
  let nightMax: SlotDay['nightMax'] = null;
  let frozenHours = 0;
  let acChargeHours = 0;
  let unprovedAcChargeHours = 0;
  let fieldAll: number | null = 0;
  const overlap = { hours: 0, fieldWh: 0, coreWh: 0 };
  for (const h of hours) {
    if (h.sun) daylightHours++;
    if (h.sun && h.frozen) frozenHours++;
    if (h.sun && h.acInS > G11_AC_IN_MIN_S) {
      acChargeHours++;
      if (!ctx.provedUnderCharge) unprovedAcChargeHours++;
    }
    if (fieldAll != null) fieldAll = h.fieldWh == null ? null : fieldAll + h.fieldWh;
    const coreW = h.coreCovS >= HOUR_COVER_MIN_S ? (h.coreRawWh * 3600) / h.coreCovS : null;
    if (h.sun && coreW != null) {
      coreDaylightHours++;
      if (h.fieldWh != null) { overlap.hours++; overlap.fieldWh += h.fieldWh; overlap.coreWh += coreW; }
    }
    const r = resolveSlotHour(h, { g3: ctx.g3, provedUnderCharge: ctx.provedUnderCharge, admitted: true });
    if (incomplete == null) {
      if (h.pct0 == null || h.pct1 == null) incomplete = { startMs: h.startMs, cause: 'pct' };
      else if (h.outWh == null || h.inWh == null) incomplete = { startMs: h.startMs, cause: 'meter' };
      else if (r.source !== 'core' && r.source !== 'field') {
        incomplete = { startMs: h.startMs, cause: fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) ?? 'coverage' };
      }
    }
    if (r.source === 'core' || r.source === 'field') {
      const wh = r.w as number;
      truthWh += wh;
      if (h.sun) truthDaylightWh += wh;
      if (r.source === 'field') {
        if (h.sun) fieldDaylightHours++;
        else if (nightMax == null || wh > nightMax.w) nightMax = { w: wh, startMs: h.startMs, acInWh: h.inWh ?? 0 };
      }
    }
    if (estOk) {
      const e = hourEstimateWh(h, ctx.constants as PlantConstants, ctx.capacityWh as number);
      if (e == null) estOk = false;
      else if (h.sun) estDay += e;
      else estNight += e;
    }
  }
  const complete = incomplete == null;
  return {
    slot, day, core: ctx.core, hours: hours.length, daylightHours, g3: ctx.g3,
    complete, incomplete,
    fieldDaylightHours, coreDaylightHours,
    truthWh, truthDaylightWh,
    estDayWh: estOk && complete ? estDay : null,
    estNightWh: estOk && complete ? estNight : null,
    nightMax, frozenHours, acChargeHours, unprovedAcChargeHours,
    fieldAllWh: fieldAll,
    overlap,
  };
}

/** The source of a slot's daylight on a day: its Core (G1 on ≥ CORE_DAYLIGHT_MIN_FRAC of daylight),
 *  the panel's field (≥ FIELD_DAYLIGHT_MIN_FRAC), or neither. */
export type SlotSource = 'core' | 'panel' | 'none';
export function slotDaySource(x: SlotDay | undefined): SlotSource {
  if (!x || x.daylightHours <= 0) return 'none';
  if (x.coreDaylightHours >= CORE_DAYLIGHT_MIN_FRAC * x.daylightHours) return 'core';
  if (x.fieldDaylightHours >= FIELD_DAYLIGHT_MIN_FRAC * x.daylightHours) return 'panel';
  return 'none';
}

/** The slot→Core map for a whole site day from the membership record: the house panel's slots of every
 *  entry in force that day (flickers folded), when they agree; null when the day starts before the
 *  record, an entry carries no slot map, or the Cores changed during the day. Pure. */
export function slotMapOfDay(h: MembershipHistory | null, panelSn: string, day: string): Record<number, string> | null {
  if (h == null) return null;
  const entries = membershipsDuring(h, siteDayStartMs(day), siteDayStartMs(addDaysYmd(day, 1)));
  return agreedSlotMap(entries, panelSn);
}

/** The map of record as of the evening E: the house panel's slots of the entry in force at the end of
 *  day E−1 (flickers folded), or null. Pure. */
export function slotMapOfRecord(h: MembershipHistory | null, panelSn: string, asOfDay: string): Record<number, string> | null {
  if (h == null) return null;
  const t = siteDayStartMs(asOfDay) - 1;
  return agreedSlotMap(membershipsDuring(h, t, t + 1), panelSn);
}

function agreedSlotMap(entries: ReturnType<typeof membershipsDuring>, panelSn: string): Record<number, string> | null {
  if (entries == null || entries.length === 0) return null;
  let map: Record<number, string> | null = null;
  const prefix = `${panelSn}:`;
  for (const e of entries) {
    if (e.slots == null) return null;
    const m: Record<number, string> = {};
    for (const [k, sn] of Object.entries(e.slots)) {
      if (!k.startsWith(prefix)) continue;
      const n = Number(k.slice(prefix.length));
      if (Number.isInteger(n)) m[n] = sn;
    }
    if (map != null && !sameMap(map, m)) return null;
    map = m;
  }
  return map;
}

export function sameMap(a: Readonly<Record<number, string>>, b: Readonly<Record<number, string>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k as unknown as number] === b[k as unknown as number]);
}

/** One site day of the upper check. */
export interface UcDay {
  day: string;
  /** The slot→Core map of record for the whole day (slotMapOfDay). */
  map: Readonly<Record<number, string>> | null;
  slots: ReadonlyMap<number, SlotDay>;
  /** The vendor's daily solar, Wh (null: no row). */
  vendorWh: number | null;
  /** Σ every connected slot's field (each slot of the day's map), Wh; null when one lacks it. */
  fieldAllWh: number | null;
  /** fieldAllWh − vendorWh, and G6 (null: not evaluable — no vendor row, or a field incomplete). */
  vendorDiffWh: number | null;
  vendorOk: boolean | null;
}

/** One site day from its slot-days and the vendor's daily solar (M4: G6 sums every connected slot's
 *  field, whatever source the resolver chose). Pure. */
export function buildUcDay(
  day: string,
  map: Readonly<Record<number, string>> | null,
  slots: ReadonlyMap<number, SlotDay>,
  vendorWh: number | null,
): UcDay {
  let fieldAllWh: number | null = null;
  if (map != null) {
    fieldAllWh = 0;
    for (const k of Object.keys(map)) {
      const x = slots.get(Number(k));
      if (!x || x.fieldAllWh == null) { fieldAllWh = null; break; }
      fieldAllWh += x.fieldAllWh;
    }
  }
  const vendorDiffWh = fieldAllWh != null && vendorWh != null ? fieldAllWh - vendorWh : null;
  const vendorOk = vendorDiffWh == null
    ? null
    : Math.abs(vendorDiffWh) <= Math.max(G6_TOLERANCE_WH, G6_TOLERANCE_FRAC * (vendorWh as number));
  return { day, map, slots, vendorWh, fieldAllWh, vendorDiffWh, vendorOk };
}

/* ─── the upper check ──────────────────────────────────────────────────────────────────────── */

/** The days the check reads, and the map of record and constants per evening. */
export interface UcTable {
  /** Site days E−44..E−1 at least (missing days are not field days). */
  days: ReadonlyMap<string, UcDay>;
  /** The map of record as of an evening (slotMapOfRecord). */
  mapAsOf: (asOfDay: string) => Readonly<Record<number, string>> | null;
  /** The constants of a (slot, Core), as the fit found them. */
  constantsOf: (slot: number, core: string) => ConstantsFit | null;
  /** Each connected slot's capacity basis is known (the panel's fullCap). */
  capacityKnown: (slot: number) => boolean;
  /** The threshold (UC_THRESHOLD; a test may pass another). */
  threshold?: number;
}

/** Why a day did not count, for the count reason. */
export type UncountedCause =
  | { cause: 'no-record' }
  | { cause: 'map' }
  | { cause: 'no-vendor-row' }
  | { cause: 'vendor-mismatch'; diffWh: number }
  | { cause: 'night-reading'; slot: number; w: number }
  | { cause: 'core-day'; slot: number }
  | { cause: 'field-share'; slot: number; frac: number }
  | { cause: 'slot-incomplete'; slot: number; what: IncompleteCause; frozenHours: number }
  | { cause: 'no-estimate'; slot: number };

/** One machine reason per refusing clause, in a fixed precedence. The words are the caller's. */
export type UcReason =
  | { code: 'no-membership-record' }
  | { code: 'no-capacity'; slot: number }
  | { code: 'no-constants'; slot: number; days: number; chargeHours: number; needDays: number; needChargeHours: number }
  | { code: 'overlap-hold'; slot: number; day: string; ratio: number; lastHeldDay: string }
  | { code: 'night-reading'; slot: number; day: string; hourStartMs: number; w: number; acInWh: number; lastHeldDay: string }
  | { code: 'vendor-mismatch'; day: string; fieldKwh: number; vendorKwh: number; diffKwh: number; lastHeldDay: string }
  | { code: 'restart'; slot: number | null; day: string; kind: 'core-changed' | 'slot-set-changed' }
  | { code: 'too-few-field-days'; n: number; need: number; firstFieldDay: string | null; uncounted: Array<{ day: string } & UncountedCause> }
  | { code: 'stale'; newest: string; minNewest: string }
  | { code: 'balance'; windowEnd: string; ratio: number; daylightRatio: number | null; nightResidualKwhPerNight: number; threshold: number };

/** The check's figures, on every verdict. */
export interface UcChecks {
  asOfDay: string;
  threshold: number;
  /** The window ending on the newest field day: the balance, its daylight-only form, and the window's
   *  night residual per night (kWh; < 0 = the plant drew more than its constants). Null without one. */
  ratio: number | null;
  balanceDaylightRatio: number | null;
  nightResidualKwhPerNight: number | null;
  /** The largest of the last 7 windows. */
  max7: number | null;
  /** The disclosed blind band: a sustained over-read below this percent is not caught. */
  blindBandPct: number | null;
  fieldDays: number;
  newestFieldDay: string | null;
  fieldSlots: number[];
  constants: Record<number, { days: number; chargeHours: number }>;
  vendorDaysPresent: number;
  vendorMaxDiffKwh: number | null;
  nightMaxW: number | null;
  frozenHours: number;
}

export interface UcVerdict {
  asOfDay: string;
  /** pass: the field may stand; refused: it may not; not-needed: every connected slot's Core covered
   *  E−1's daylight by its own meter (no slot takes the field). */
  state: 'pass' | 'refused' | 'not-needed';
  ok: boolean;
  reason: UcReason | null;
  /** Each connected slot's source: that of its E−1 daylight (L7). */
  sources: Array<{ slot: number; source: SlotSource }>;
  basis: 'cores' | 'mixed' | 'panel';
  checks: UcChecks;
}

/** The slots that take the field as of an evening: the map's slots whose E−1 daylight was not their
 *  Core's. */
export function fieldSlotsAsOf(table: UcTable, asOfDay: string, map: Readonly<Record<number, string>>): number[] {
  const prev = table.days.get(addDaysYmd(asOfDay, -1));
  return Object.keys(map).map(Number).sort((a, b) => a - b).filter((s) => slotDaySource(prev?.slots.get(s)) !== 'core');
}

/** A slot-day the field may count on (its own checks, before the map and the day's vendor check). */
function slotFieldOk(x: SlotDay | undefined): boolean {
  return x != null && x.complete && x.daylightHours > 0
    && x.fieldDaylightHours >= FIELD_DAYLIGHT_MIN_FRAC * x.daylightHours
    && x.estDayWh != null && x.estNightWh != null
    && (x.nightMax == null || x.nightMax.w <= G4_NIGHT_FIELD_MAX_W);
}

/** The judged-bad pre-check on one slot-day (M5, kept per slot outside the map test, L9): complete in
 *  every hour and the field on ≥ FIELD_DAYLIGHT_MIN_FRAC of daylight. */
function slotPreChecked(x: SlotDay | undefined): boolean {
  return x != null && x.complete && x.daylightHours > 0 && x.fieldDaylightHours >= FIELD_DAYLIGHT_MIN_FRAC * x.daylightHours;
}

/** A field day for the slot set `F` under the map `M`. */
export function isFieldDay(d: UcDay | undefined, F: readonly number[], M: Readonly<Record<number, string>>): boolean {
  if (!d || d.map == null || !sameMap(d.map, M) || d.vendorOk !== true || F.length === 0) return false;
  return F.every((s) => slotFieldOk(d.slots.get(s)));
}

function uncountedCause(d: UcDay | undefined, F: readonly number[], M: Readonly<Record<number, string>>): UncountedCause {
  if (!d) return { cause: 'no-record' };
  if (d.map == null || !sameMap(d.map, M)) return { cause: 'map' };
  for (const s of F) {
    const x = d.slots.get(s);
    if (!x) return { cause: 'slot-incomplete', slot: s, what: 'no-hours', frozenHours: 0 };
    if (!x.complete && x.incomplete) return { cause: 'slot-incomplete', slot: s, what: x.incomplete.cause, frozenHours: x.frozenHours };
    if (slotDaySource(x) === 'core') return { cause: 'core-day', slot: s };
    if (x.daylightHours <= 0 || x.fieldDaylightHours < FIELD_DAYLIGHT_MIN_FRAC * x.daylightHours) {
      return { cause: 'field-share', slot: s, frac: x.daylightHours > 0 ? x.fieldDaylightHours / x.daylightHours : 0 };
    }
    if (x.nightMax != null && x.nightMax.w > G4_NIGHT_FIELD_MAX_W) return { cause: 'night-reading', slot: s, w: x.nightMax.w };
    if (x.estDayWh == null) return { cause: 'no-estimate', slot: s };
  }
  if (d.vendorOk == null) return { cause: 'no-vendor-row' };
  if (d.vendorOk === false) return { cause: 'vendor-mismatch', diffWh: d.vendorDiffWh as number };
  return { cause: 'no-record' };
}

/** The window ending on `end`: the UC_WINDOW_DAYS most recent field days in end−13..end, when full. */
function windowEnding(table: UcTable, end: string, F: readonly number[], M: Readonly<Record<number, string>>): string[] | null {
  const w: string[] = [];
  for (let k = 0; k < UC_WINDOW_SPAN_DAYS && w.length < UC_WINDOW_DAYS; k++) {
    const d = addDaysYmd(end, -k);
    if (isFieldDay(table.days.get(d), F, M)) w.push(d);
  }
  return w.length === UC_WINDOW_DAYS ? w.reverse() : null;
}

/** A window's balance on the slots `F`: R, its daylight-only form, and the night residual per night. */
export function windowBalance(table: UcTable, days: readonly string[], F: readonly number[]): { ratio: number; daylightRatio: number | null; nightResidualKwhPerNight: number } {
  let truth = 0;
  let truthDay = 0;
  let estDay = 0;
  let est = 0;
  let nightAll = 0;
  for (const s of F) {
    let eDay = 0;
    let eNight = 0;
    for (const d of days) {
      const x = table.days.get(d)?.slots.get(s) as SlotDay;
      truth += x.truthWh;
      truthDay += x.truthDaylightWh;
      eDay += x.estDayWh as number;
      eNight += x.estNightWh as number;
    }
    estDay += eDay;
    nightAll += eNight;
    est += eDay + Math.min(0, eNight);
  }
  return {
    ratio: est > 0 ? truth / est : Infinity,
    daylightRatio: estDay > 0 ? truthDay / estDay : null,
    nightResidualKwhPerNight: nightAll / days.length / 1000,
  };
}

/** The judged-bad days of a slot in [from, to] (inclusive): G4 on the slot, G6 on the day (M5, L9). */
function judgedBad(table: UcTable, slot: number, from: string, to: string): Array<{ day: string; kind: 'night' | 'vendor'; d: UcDay; x: SlotDay }> {
  const out: Array<{ day: string; kind: 'night' | 'vendor'; d: UcDay; x: SlotDay }> = [];
  for (let day = from; day <= to; day = addDaysYmd(day, 1)) {
    const d = table.days.get(day);
    const x = d?.slots.get(slot);
    if (!d || !x || !slotPreChecked(x)) continue;
    if (x.nightMax != null && x.nightMax.w > G4_NIGHT_FIELD_MAX_W) out.push({ day, kind: 'night', d, x });
    else if (d.vendorOk === false) out.push({ day, kind: 'vendor', d, x });
  }
  return out;
}

/** G10 days of a slot in [from, to]: the field above the Core's own figure on a day both cover. */
function overlapDays(table: UcTable, slot: number, from: string, to: string): Array<{ day: string; ratio: number }> {
  const out: Array<{ day: string; ratio: number }> = [];
  for (let day = from; day <= to; day = addDaysYmd(day, 1)) {
    const x = table.days.get(day)?.slots.get(slot);
    if (!x || x.daylightHours <= 0) continue;
    if (x.overlap.hours < CORE_DAYLIGHT_MIN_FRAC * x.daylightHours || x.overlap.coreWh < G10_MIN_CORE_WH) continue;
    const ratio = x.overlap.fieldWh / x.overlap.coreWh;
    if (ratio > G10_MAX_RATIO) out.push({ day, ratio });
  }
  return out;
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** What assembleUcTable reads, as callbacks over the recorder (the worker) or a fixture (the tests). */
export interface UcSources {
  panelSn: string;
  /** The site days to record, ascending (E−UC_TABLE_DAYS..E−1). */
  days: readonly string[];
  /** Every slot to record: the connected slots and every slot a day's map names. */
  slots: readonly number[];
  mapOfDay: (day: string) => Readonly<Record<number, string>> | null;
  mapAsOf: (asOfDay: string) => Readonly<Record<number, string>> | null;
  /** The slot-hours of one slot-day, with that day's Core's pv_total (null: none). */
  hoursOf: (slot: number, day: string, core: string | null) => readonly SlotHour[];
  bridgeRowsOf: (day: string) => readonly BridgeWindowRow[];
  /** The bridge trusts the slot's field now (its persisted 'consistent' verdict). */
  trusted: (slot: number) => boolean;
  /** G11's proof inside the planning window. */
  provedUnderCharge: (slot: number) => boolean;
  /** The panel's per-source fullCap of the slot, Wh (null: unknown). */
  capacityOf: (slot: number) => number | null;
  /** The constants of (slot, Core); called only for the Core the map of record as of E names. */
  fitOf: (slot: number, core: string) => ConstantsFit | null;
  vendorOf: (day: string) => number | null;
  threshold?: number;
}

/** The upper check's table from its sources, with each slot-day's G3. Pure (given pure callbacks). */
export function assembleUcTable(src: UcSources, asOfDay: string): { table: UcTable; g3: Map<string, boolean> } {
  const mapE = src.mapAsOf(asOfDay);
  const fitOf = (slot: number, core: string): ConstantsFit | null => (mapE?.[slot] === core ? src.fitOf(slot, core) : null);
  const days = new Map<string, UcDay>();
  const g3 = new Map<string, boolean>();
  for (const day of src.days) {
    const map = src.mapOfDay(day);
    const rows = src.bridgeRowsOf(day);
    const slotDays = new Map<number, SlotDay>();
    for (const s of src.slots) {
      const core = map?.[s] ?? null;
      const v = bridgeVerified(rows, src.panelSn, s, core, src.trusted(s)).g3;
      g3.set(`${s}|${day}`, v);
      const fit = core != null ? fitOf(s, core) : null;
      slotDays.set(s, buildSlotDay(s, day, src.hoursOf(s, day, core), {
        core, g3: v, provedUnderCharge: src.provedUnderCharge(s), constants: fit?.constants ?? null, capacityWh: src.capacityOf(s),
      }));
    }
    days.set(day, buildUcDay(day, map, slotDays, src.vendorOf(day)));
  }
  return {
    table: { days, mapAsOf: src.mapAsOf, constantsOf: fitOf, capacityKnown: (s) => src.capacityOf(s) != null, threshold: src.threshold },
    g3,
  };
}

/** The UC_TABLE_DAYS site days before E, ascending. */
export function ucTableDays(asOfDay: string): string[] {
  const out: string[] = [];
  for (let k = UC_TABLE_DAYS; k >= 1; k--) out.push(addDaysYmd(asOfDay, -k));
  return out;
}

/**
 * The upper check as of the evening `asOfDay` (E). Reads only the table's days ≤ E−1. Precedence of the
 * refusing clauses: the record, the capacity, the constants, the holds (G10, G4, G6), a restart, the
 * count, staleness, the balance. Pure.
 */
export function upperCheck(table: UcTable, asOfDay: string): UcVerdict {
  const T = table.threshold ?? UC_THRESHOLD;
  const E = asOfDay;
  const last = addDaysYmd(E, -1);
  const lo = addDaysYmd(E, -UC_LOOKBACK_DAYS);
  const checks: UcChecks = {
    asOfDay: E, threshold: T, ratio: null, balanceDaylightRatio: null, nightResidualKwhPerNight: null, max7: null,
    blindBandPct: null, fieldDays: 0, newestFieldDay: null, fieldSlots: [], constants: {}, vendorDaysPresent: 0,
    vendorMaxDiffKwh: null, nightMaxW: null, frozenHours: 0,
  };
  const M = table.mapAsOf(E);
  const verdict = (state: UcVerdict['state'], reason: UcReason | null, sources: UcVerdict['sources'] = []): UcVerdict => {
    const panel = sources.filter((s) => s.source !== 'core').length;
    const basis: UcVerdict['basis'] = panel === 0 ? 'cores' : panel === sources.length ? 'panel' : 'mixed';
    return { asOfDay: E, state, ok: state !== 'refused', reason, sources, basis, checks };
  };
  if (M == null || Object.keys(M).length === 0) return verdict('refused', { code: 'no-membership-record' });
  const prev = table.days.get(last);
  const sources = Object.keys(M).map(Number).sort((a, b) => a - b).map((slot) => ({ slot, source: slotDaySource(prev?.slots.get(slot)) }));
  const F = sources.filter((s) => s.source !== 'core').map((s) => s.slot);
  checks.fieldSlots = F;
  if (F.length === 0) return verdict('not-needed', null, sources);
  // Figures over the lookback (disclosure; they decide nothing).
  for (let day = lo; day <= last; day = addDaysYmd(day, 1)) {
    const d = table.days.get(day);
    if (!d) continue;
    if (d.vendorWh != null) checks.vendorDaysPresent++;
    if (d.vendorDiffWh != null) {
      const v = Math.abs(d.vendorDiffWh) / 1000;
      if (checks.vendorMaxDiffKwh == null || v > checks.vendorMaxDiffKwh) checks.vendorMaxDiffKwh = r4(v);
    }
    for (const s of F) {
      const x = d.slots.get(s);
      if (!x) continue;
      checks.frozenHours += x.frozenHours;
      if (x.nightMax != null && (checks.nightMaxW == null || x.nightMax.w > checks.nightMaxW)) checks.nightMaxW = Math.round(x.nightMax.w * 10) / 10;
    }
  }
  for (const s of F) {
    if (!table.capacityKnown(s)) return verdict('refused', { code: 'no-capacity', slot: s }, sources);
  }
  for (const s of F) {
    const fit = table.constantsOf(s, M[s]);
    checks.constants[s] = { days: fit?.days ?? 0, chargeHours: fit?.chargeHours ?? 0 };
    if (fit?.constants == null) {
      return verdict('refused', {
        code: 'no-constants', slot: s, days: fit?.days ?? 0, chargeHours: fit?.chargeHours ?? 0,
        needDays: CONSTANTS_MIN_DAYS, needChargeHours: CONSTANTS_MIN_CHARGE_HOURS,
      }, sources);
    }
  }
  // Holds, per slot (kept outside the map test, so a restart does not clear one).
  for (const s of F) {
    const g10 = overlapDays(table, s, addDaysYmd(E, -G10_HOLD_DAYS), last);
    if (g10.length > 0) {
      const b = g10[g10.length - 1];
      return verdict('refused', { code: 'overlap-hold', slot: s, day: b.day, ratio: r4(b.ratio), lastHeldDay: addDaysYmd(b.day, G10_HOLD_DAYS) }, sources);
    }
  }
  const bad = F.flatMap((s) => judgedBad(table, s, lo, last).map((b) => ({ ...b, slot: s })))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.slot - b.slot));
  if (bad.length > 0) {
    const b = bad[0];
    const lastHeldDay = addDaysYmd(b.day, JUDGED_BAD_HOLD_DAYS);
    if (b.kind === 'night') {
      const nm = b.x.nightMax as NonNullable<SlotDay['nightMax']>;
      return verdict('refused', { code: 'night-reading', slot: b.slot, day: b.day, hourStartMs: nm.startMs, w: Math.round(nm.w * 10) / 10, acInWh: Math.round(nm.acInWh), lastHeldDay }, sources);
    }
    return verdict('refused', {
      code: 'vendor-mismatch', day: b.day, fieldKwh: r4((b.d.fieldAllWh as number) / 1000), vendorKwh: r4((b.d.vendorWh as number) / 1000),
      diffKwh: r4((b.d.vendorDiffWh as number) / 1000), lastHeldDay,
    }, sources);
  }
  const fd: string[] = [];
  for (let day = lo; day <= last; day = addDaysYmd(day, 1)) if (isFieldDay(table.days.get(day), F, M)) fd.push(day);
  checks.fieldDays = fd.length;
  checks.newestFieldDay = fd.length > 0 ? fd[fd.length - 1] : null;
  if (fd.length < UC_WINDOW_DAYS) {
    // A restart: the newest lookback day the record puts under another slot→Core map (a Core swapped in a
    // slot, a slot added or removed); whole days count again from the day after it. A slot whose Core
    // stopped (or started) covering its daylight is not a restart: its days are counted from the first
    // field day, and the count's reason names that day.
    // A day whose Cores changed during it (its map null while a record exists for the days around it) is
    // the change day itself; the kind is read from the newest earlier day the record maps.
    let restart: UcReason | null = null;
    for (let day = last; day >= lo && restart == null; day = addDaysYmd(day, -1)) {
      const d = table.days.get(day);
      if (!d || (d.map != null && sameMap(d.map, M))) continue;
      let before: Readonly<Record<number, string>> | null = d.map;
      for (let k = addDaysYmd(day, -1); before == null && k >= addDaysYmd(lo, -UC_WINDOW_SPAN_DAYS); k = addDaysYmd(k, -1)) before = table.days.get(k)?.map ?? null;
      if (d.map == null && before == null) continue;
      const prior = before as Readonly<Record<number, string>>;
      if (d.map == null && sameMap(prior, M)) continue;
      const setChanged = Object.keys(prior).length !== Object.keys(M).length || Object.keys(M).some((k) => !Object.hasOwn(prior, k));
      const changed = F.find((s) => prior[s] !== M[s]);
      restart = setChanged
        ? { code: 'restart', slot: null, day: addDaysYmd(day, 1), kind: 'slot-set-changed' }
        : { code: 'restart', slot: changed ?? null, day: addDaysYmd(day, 1), kind: 'core-changed' };
    }
    if (restart != null) return verdict('refused', restart, sources);
    const uncounted: Array<{ day: string } & UncountedCause> = [];
    for (let day = lo; day <= last; day = addDaysYmd(day, 1)) {
      if (!fd.includes(day)) uncounted.push({ day, ...uncountedCause(table.days.get(day), F, M) });
    }
    return verdict('refused', { code: 'too-few-field-days', n: fd.length, need: UC_WINDOW_DAYS, firstFieldDay: fd[0] ?? null, uncounted }, sources);
  }
  const newest = fd[fd.length - 1];
  const minNewest = addDaysYmd(E, -UC_NEWEST_MAX_AGE_DAYS);
  if (newest < minNewest) return verdict('refused', { code: 'stale', newest, minNewest }, sources);
  const ends = fd.slice(-UC_HYSTERESIS_WINDOWS);
  let worst: { end: string; b: ReturnType<typeof windowBalance> } | null = null;
  for (const end of ends) {
    const w = windowEnding(table, end, F, M);
    if (w == null) continue;
    const b = windowBalance(table, w, F);
    if (end === newest) {
      checks.ratio = r4(b.ratio);
      checks.balanceDaylightRatio = b.daylightRatio == null ? null : r4(b.daylightRatio);
      checks.nightResidualKwhPerNight = Math.round(b.nightResidualKwhPerNight * 100) / 100;
      checks.blindBandPct = Math.round((T / b.ratio - 1) * 1000) / 10;
    }
    if (worst == null || b.ratio > worst.b.ratio) worst = { end, b };
  }
  if (worst == null) return verdict('refused', { code: 'too-few-field-days', n: fd.length, need: UC_WINDOW_DAYS, firstFieldDay: fd[0], uncounted: [] }, sources);
  checks.max7 = r4(worst.b.ratio);
  if (worst.b.ratio > T) {
    return verdict('refused', {
      code: 'balance', windowEnd: worst.end, ratio: r4(worst.b.ratio),
      daylightRatio: worst.b.daylightRatio == null ? null : r4(worst.b.daylightRatio),
      nightResidualKwhPerNight: Math.round(worst.b.nightResidualKwhPerNight * 100) / 100, threshold: T,
    }, sources);
  }
  return verdict('pass', null, sources);
}

/**
 * The field slot-days admitted to the planning model as of E (L8, per slot-day): for each end day e in
 * E−30..E−1, the window that closed on it as judged on evening e+1 (that evening's field slots and map
 * of record). A slot-day is admitted when at least one such window holding it was judged with that slot
 * summed and none of them failed, its own checks pass, its day passed G6, and its Core is the slot's
 * Core in the map of record as of E. Day E and later never enter. Returns slot → admitted days. Pure.
 *
 * Each window is re-judged as of E, on the constants, capacities, trust and rows known then, and no failed
 * set is kept durably: an evening that can no longer be re-judged (a field slot of it with no constants or
 * no capacity as of E, its trust revoked, the slot removed from the map, or its end day no longer a field
 * day) is skipped. So in a mixed state a window that failed is not remembered once one of its field slots
 * cannot be re-judged, and the days it held of its other slots can be admitted through later passing
 * windows: the planning fit, bias and skill and the ledger (the cost fill), never the outage line.
 */
export function admittedSlotDays(table: UcTable, asOfDay: string): Map<number, Set<string>> {
  const T = table.threshold ?? UC_THRESHOLD;
  const E = asOfDay;
  const judged = new Set<string>();
  const failed = new Set<string>();
  const key = (s: number, d: string): string => `${s}|${d}`;
  for (let k = PLANNING_WINDOW_DAYS; k >= 1; k--) {
    const end = addDaysYmd(E, -k);
    const evening = addDaysYmd(end, 1);
    const Me = table.mapAsOf(evening);
    if (Me == null) continue;
    const Fe = fieldSlotsAsOf(table, evening, Me);
    if (Fe.length === 0 || Fe.some((s) => table.constantsOf(s, Me[s])?.constants == null)) continue;
    if (!isFieldDay(table.days.get(end), Fe, Me)) continue;
    const w = windowEnding(table, end, Fe, Me);
    if (w == null) continue;
    const bad = windowBalance(table, w, Fe).ratio > T;
    for (const s of Fe) for (const d of w) (bad ? failed : judged).add(key(s, d));
  }
  const M = table.mapAsOf(E);
  const out = new Map<number, Set<string>>();
  if (M == null) return out;
  for (const sKey of Object.keys(M)) {
    const s = Number(sKey);
    const set = new Set<string>();
    for (let k = PLANNING_WINDOW_DAYS; k >= 1; k--) {
      const d = addDaysYmd(E, -k);
      const day = table.days.get(d);
      const x = day?.slots.get(s);
      if (!day || !x || x.core !== M[s] || day.vendorOk !== true || !slotFieldOk(x)) continue;
      if (judged.has(key(s, d)) && !failed.has(key(s, d))) set.add(d);
    }
    out.set(s, set);
  }
  return out;
}

/** The site day of an instant (the evening's own day, for a caller that holds only a time). */
export const siteDayOf = (ms: number): string => siteYmd(ms);
