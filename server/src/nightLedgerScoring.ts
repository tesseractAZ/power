/* ═══════════════════════════════════════════════════════════════════════════
 * nightLedgerScoring.ts — v1.187.0. The pure pieces of the night-charge outcome
 * scorer (index.ts `scoreNightRow`) that decide WHICH span a ledger column
 * measures, what it costs, and whether a recorded verdict is evidence at all.
 *
 * Everything here takes its clocks, tariff lookups and samples as arguments and
 * returns a value: no I/O, no globals. The scorer owns the queries and the write.
 *
 * WHY a separate module. Three ledger columns measured the wrong thing, durably:
 *  - `actual_onpeak_import_kwh` / `onpeak_import_occurred` integrated the PLAN DAY's
 *    own 16:00-19:00 (nightWindowBounds), which closes ~2.5 h before the 21:30 plan
 *    that is graded on it exists, with no weekday gate — Saturday and Sunday
 *    afternoons (off-peak under APS R-EV) were scored as "on-peak". On 2026-09-28 the
 *    house bought 4.27 kWh on-peak at 16:00-19:00; the code would have charged it to
 *    the 09-28 plan (issued 21:30:29, a clean night), while the on-peak that plan
 *    actually governed (Tue 09-29) imported 0 kWh.
 *  - the cost columns were declared and never written (DOCS §6: "no valid savings
 *    counterfactual pre-write, and rates default unconfirmed" — both reasons had
 *    expired: rates confirmed, 24 actuated nights).
 *  - a PV band built on a forecast fitted on one Core (the 2026-09-27 21:06 restart,
 *    v1.186.5) was graded against three Cores' actual PV and counted as covered.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { NightLedgerRow } from './recorder.js';
import type { Season, TariffModel } from './tariff.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection } from './ecoflow/project.js';
import { DELIVERED_BASIS } from './nightChargeAdvisor.js';
import { LEGACY_REVERT_LAG_MS } from './nightChargeActuator.js';

const HOUR_MS = 3_600_000;

function round2(n: number): number { return Math.round(n * 100) / 100; }

export interface TimeSpan { startMs: number; endMs: number }

type Sample = { ts: number; value: number };

/** Trapezoidal integral of a watts series (Wh) over [startMs, endMs], skipping
 *  gaps > 1 h. `positiveOnly` clamps each sample ≥ 0 (grid IMPORT accounting).
 *  v1.187.0 (review) — moved here from index.ts, unchanged, so the scorer's column
 *  assembly (assembleNightLedgerColumns) is a pure function a test can drive. */
export function integrateWh(pts: ReadonlyArray<Sample>, positiveOnly: boolean): number {
  let wh = 0;
  for (let i = 1; i < pts.length; i++) {
    const dtH = (pts[i].ts - pts[i - 1].ts) / HOUR_MS;
    if (dtH <= 0 || dtH > 1) continue; // gap — don't integrate across it
    const a = positiveOnly ? Math.max(0, pts[i - 1].value) : pts[i - 1].value;
    const b = positiveOnly ? Math.max(0, pts[i].value) : pts[i].value;
    wh += ((a + b) / 2) * dtH;
  }
  return wh;
}

/** Fraction of [startMs, endMs) covered by samples, by 5-min buckets present.
 *  v1.187.0 (review) — moved here from index.ts, unchanged (see integrateWh). */
export function coverageFrac(pts: ReadonlyArray<Sample>, startMs: number, endMs: number): number {
  const span = endMs - startMs;
  if (span <= 0) return 0;
  const bucketMs = 5 * 60_000;
  const total = Math.ceil(span / bucketMs);
  if (total <= 0) return 0;
  const seen = new Set<number>();
  for (const p of pts) {
    if (p.ts < startMs || p.ts >= endMs) continue;
    seen.add(Math.floor((p.ts - startMs) / bucketMs));
  }
  return Math.min(1, seen.size / total);
}

/** How far past a window close the on-peak search looks before giving up (a long
 *  weekend plus a holiday is ~3 days; the next cheap window always ends it sooner). */
export const ONPEAK_SPAN_SCAN_HOURS = 96;

/**
 * v1.187.0 — the ON-PEAK period a night's plan GOVERNS. PURE.
 *
 * A plan's buy lands in its charge window; the first on-peak period after that window
 * closes is the one the buy (or the decision not to buy) was made for. That is the
 * first contiguous run of on-peak hours at or after `windowEndMs` — PROVIDED it starts
 * before the next cheap charge window opens. Once the next window opens, the NEXT plan
 * governs what follows, so a Friday plan (window Fri 23:00-Sat 00:00) governs no
 * on-peak at all: Saturday and Sunday have none, and Monday's belongs to the plan whose
 * window opens Monday 00:00. The same holds for an observed holiday (all-day off-peak
 * in the tariff model).
 *
 * Returns null for "no on-peak period governed" — never a span that is scored as a
 * measured 0. `isOnPeakAt` / `isCheapAt` come from the ONE tariff model
 * (tariff.ts rateAt: `.isOnPeak`, `.periodId === 'overnight'`), so the weekday gate
 * and the holiday list are the tariff's own, not a second copy.
 */
export function governedOnPeakSpan(
  windowEndMs: number,
  isOnPeakAt: (tsMs: number) => boolean,
  isCheapAt: (tsMs: number) => boolean,
  maxScanHours = ONPEAK_SPAN_SCAN_HOURS,
): TimeSpan | null {
  if (!Number.isFinite(windowEndMs)) return null;
  // Tariff periods are whole local hours; a window end off the hour (never produced by
  // resolveCheapWindow) is rounded UP so a partial hour is never counted as on-peak.
  const from = Math.ceil(windowEndMs / HOUR_MS) * HOUR_MS;
  for (let i = 0; i < maxScanHours; i++) {
    const t = from + i * HOUR_MS;
    if (isOnPeakAt(t)) {
      let end = t + HOUR_MS;
      for (let j = 0; j < maxScanHours && isOnPeakAt(end); j++) end += HOUR_MS;
      return { startMs: t, endMs: end };
    }
    // The next plan's window opened first: it, not this plan, governs what follows.
    if (isCheapAt(t)) return null;
  }
  return null;
}

/**
 * v1.187.0 — the LATER plan that owns this row's charge window, if any. PURE.
 *
 * A Saturday plan has no window of its own and arms for Monday 00:00-05:00; Sunday's
 * plan resolves the SAME window and supersedes it (re-arm, or cancelStalePriorArm).
 * Both rows would otherwise claim Monday's on-peak — and Monday's cost — and a sum over
 * the ledger would count them twice. The latest plan_date carrying the identical window
 * is the plan of record; null when this row is it.
 */
export function supersedingPlanDate(
  row: Pick<NightLedgerRow, 'plan_date' | 'window_start_ms' | 'window_end_ms'>,
  rows: ReadonlyArray<Pick<NightLedgerRow, 'plan_date' | 'window_start_ms' | 'window_end_ms'>>,
): string | null {
  if (typeof row.window_start_ms !== 'number' || typeof row.window_end_ms !== 'number') return null;
  const own = String(row.plan_date);
  let latest: string | null = null;
  for (const o of rows) {
    const d = String(o.plan_date);
    if (d <= own) continue;
    if (o.window_start_ms !== row.window_start_ms || o.window_end_ms !== row.window_end_ms) continue;
    if (latest == null || d > latest) latest = d;
  }
  return latest;
}

/** A measured on-peak import above this counts as "on-peak import occurred" (unchanged). */
export const ONPEAK_IMPORT_OCCURRED_KWH = 0.05;
/** Coverage the on-peak span and the cost span need before a total is written. The
 *  `GRID_HOME_MIN_COVERAGE` / overnight-window precedent (0.9): a total over a span
 *  that was only partly measured is a deflated number, and these columns are durable. */
export const LEDGER_SPAN_MIN_COVERAGE = 0.9;

/** `onpeak_basis`: 'governed' = measured over `onpeak_start_ms`-`onpeak_end_ms`; 'none' =
 *  the plan governed no on-peak period (Friday, a holiday, or no charge window at all);
 *  'superseded' = a later plan owns this row's window and carries its on-peak. NULL = not
 *  measured on the governed basis: a row captured before v1.187.0 (whose on-peak columns
 *  measured the plan day's own 16:00-19:00), or a pre-v1.39.0 row with no recorded window
 *  (windowlessLedgerColumns). */
export type OnPeakBasis = 'governed' | 'none' | 'superseded';

export interface OnPeakOutcome {
  basis: OnPeakBasis;
  span: TimeSpan | null;
  importKwh: number | null;
  occurred: 0 | 1 | null;
  /** A clause for score_notes, always present so a null says WHY. */
  note: string;
}

/**
 * v1.187.0 — the on-peak outcome columns for one row. PURE. `importKwh` / `coverage`
 * are measured over `span` by the caller (null when there were no samples).
 */
export function nightOnPeakOutcome(i: {
  span: TimeSpan | null;
  supersededBy: string | null;
  importKwh: number | null;
  coverage: number | null;
}): OnPeakOutcome {
  if (i.supersededBy != null) {
    return {
      basis: 'superseded', span: null, importKwh: null, occurred: null,
      note: `On-peak: carried by the ${i.supersededBy} plan, which owns this window`,
    };
  }
  if (i.span == null) {
    return {
      basis: 'none', span: null, importKwh: null, occurred: null,
      note: 'On-peak: none governed (the next charge window opens first)',
    };
  }
  if (i.importKwh == null || i.coverage == null || !(i.coverage >= LEDGER_SPAN_MIN_COVERAGE)) {
    return {
      basis: 'governed', span: i.span, importKwh: null, occurred: null,
      note: `On-peak: unmeasured (grid_home_w coverage ${i.coverage == null ? 'none' : `${Math.round(i.coverage * 100)}%`} < ${LEDGER_SPAN_MIN_COVERAGE * 100}%)`,
    };
  }
  const kwh = round2(i.importKwh);
  return {
    basis: 'governed', span: i.span, importKwh: kwh,
    occurred: kwh > ONPEAK_IMPORT_OCCURRED_KWH ? 1 : 0,
    note: `On-peak: ${kwh} kWh imported`,
  };
}

/**
 * v1.187.0 — metered grid import priced by the tariff, cents. PURE.
 *
 * Trapezoidal over consecutive samples (positive-clamped: an export is not a credit on
 * this plan), gaps over 1 h skipped — the scorer's `integrateWh(..., true)` exactly, with
 * each segment priced at the rate in effect at its start. A segment straddling a period
 * boundary is at most one sample interval (~1 min), so the rounding is a few tenths of
 * a cent a night.
 *
 * NULL when any segment's rate is unknown — unconfirmed rates (every rate null by design)
 * or a confirmed table with a missing season rate. Null over a fabricated number: a
 * total priced with a guessed rate for some hours reads exactly like a correct one.
 */
export function pricedImportCents(
  pts: ReadonlyArray<{ ts: number; value: number }>,
  centsAt: (tsMs: number) => number | null,
): number | null {
  return pricedImport(pts, (t) => ({ centsPerKwh: centsAt(t) })).cents;
}

/** What a rate lookup must say for pricing, and for naming why a total was not priced
 *  (tariff.ts RateSlice satisfies it). */
export interface RateLike {
  centsPerKwh: number | null;
  periodLabel?: string;
  season?: string;
  ratesConfirmed?: boolean;
}

/**
 * v1.187.0 (review) — pricedImportCents, returning the first slice that had no rate when
 * the total is withheld, so the ledger can say WHY a cost is null ("rates unconfirmed" vs
 * "no winter rate for Super Off-Peak") instead of leaving a silent NULL. PURE.
 * `cents` null with `unpriced` null ⇒ fewer than two samples (nothing measured).
 */
export function pricedImport(
  pts: ReadonlyArray<Sample>,
  rateAt: (tsMs: number) => RateLike,
): { cents: number | null; unpriced: RateLike | null } {
  if (pts.length < 2) return { cents: null, unpriced: null };
  let cents = 0;
  for (let i = 1; i < pts.length; i++) {
    const dtH = (pts[i].ts - pts[i - 1].ts) / HOUR_MS;
    if (dtH <= 0 || dtH > 1) continue; // gap — not integrated, as the kWh columns
    const slice = rateAt(pts[i - 1].ts);
    const rate = slice.centsPerKwh;
    if (rate == null || !Number.isFinite(rate)) return { cents: null, unpriced: slice };
    const kwh = ((Math.max(0, pts[i - 1].value) + Math.max(0, pts[i].value)) / 2) * dtH / 1000;
    cents += kwh * rate;
  }
  return { cents: round2(cents), unpriced: null };
}

/**
 * v1.187.0 — should this row's PV verdict (`pv_in_band`, `pv_err_frac`) be set aside
 * from the readiness gate's forecast statistics? PURE. Returns the reason, or null when
 * the verdict stands.
 *
 * The verdict grades the plan's PV band against the actual PV summed over the home Cores
 * at scoring time. That is evidence of forecast skill only when the band was built for
 * the SAME Cores. `modelSns` is the forecast's `solarModelSns` recorded at plan time
 * (`pv_model_sns`); a different set means the band describes another fleet — the
 * 2026-09-27 21:30 plan's band came from a model fitted on one Core (restart on a partial
 * map, v1.186.5) and was graded against three.
 *
 * ★ Deliberately NOT "every incomplete-basis row". A row whose plan was refused for a
 * LASTING forecast failure (2026-09-11: "PV band coverage 72% < 78%") is exactly the
 * evidence the gate exists to see; dropping those nights would bias band coverage
 * upward — survivorship in a gate that unlocks AUTO writes. Only a fleet mismatch,
 * which says nothing about forecast skill, is set aside, and every set-aside is counted
 * (`pvVerdictsSetAside`), never dropped silently.
 *
 * Unknown `modelSns` (a row planned before v1.187.0, or no probabilistic forecast) ⇒
 * null: the verdict stands, as it always has.
 */
export function pvVerdictSetAside(modelSns: string | null | undefined, actualSns: readonly string[]): string | null {
  if (modelSns == null || modelSns === '') return null;
  const actual = [...actualSns].sort().join(',');
  if (modelSns === actual) return null;
  const nModel = modelSns.split(',').filter((s) => s.length > 0).length;
  return `PV verdict set aside — the band was built on a solar model fitted on a different set of Cores `
    + `(${nModel}) than the actual PV sums (${actualSns.length}); it says nothing about forecast skill`;
}

/**
 * v1.187.0 — rows recorded BEFORE `pv_model_sns` existed whose PV band is established
 * to come from a model fitted on other Cores than the actuals. Identified by the exact
 * plan identity (`plan_date` AND `issued_at_ms`), so no other ledger can ever match.
 *
 * One entry: the 2026-09-27 plan. The add-on restarted at 21:06 and built its day
 * forecast on a partial device map (the solar model fitted on one Core); before v1.186.5
 * that forecast stood for its 30-minute TTL with no Core-set check, so every band built
 * until 21:36 — including the 21:30 plan's (P50 15.82 kWh against a full-model hindcast
 * of 26.55) — came from it. The plan was refused ("PV band coverage 7% < 78%") and the
 * row was graded against 9.6 kWh from three Cores: `pv_in_band` 1, a probable false hit.
 *
 * The row is TAGGED (`pv_verdict_set_aside`), not rewritten: its recorded `pv_in_band`
 * and `pv_err_frac` stay as captured, the gate reads the tag, and the boot pass logs it.
 */
export const KNOWN_FLEET_MISMATCH_PV_ROWS: ReadonlyArray<{ planDate: string; issuedAtMs: number; reason: string }> = [
  {
    planDate: '2026-09-27',
    issuedAtMs: 1790569855336,
    reason: 'PV verdict set aside (v1.187.0) — the plan\'s PV band was built on the 21:06 restart\'s partial-map '
      + 'forecast (solar model fitted on one Core, v1.186.5) and graded against three Cores\' actual PV; '
      + 'the recorded pv_in_band / pv_err_frac are kept as captured',
  },
];

/** v1.187.0 — the tag a KNOWN_FLEET_MISMATCH_PV_ROWS entry owes this row, or null. PURE. */
export function knownFleetMismatchReason(
  row: Pick<NightLedgerRow, 'plan_date' | 'issued_at_ms'>,
): string | null {
  const hit = KNOWN_FLEET_MISMATCH_PV_ROWS.find(
    (k) => k.planDate === String(row.plan_date) && k.issuedAtMs === row.issued_at_ms,
  );
  return hit ? hit.reason : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.0 (review) — THE SCORER'S ASSEMBLY, PURE.
 *
 * index.ts `scoreNightRow` used to assemble these columns inline — which spans are
 * queried, what a superseded row skips, the cost span and its coverage gate, the
 * delivered-energy span — and the only guard on that wiring was a source pin: change a
 * span bound and every test still passed. Everything that decides WHAT is measured now
 * lives here behind a `query(metric, start, end)` seam; the scorer only runs the queries
 * against the recorder and writes the result.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The plan-trajectory score span runs this far past the REAL window close (mirrors the
 *  canonical 05:00 → 21:00 trough span). */
export const SCORE_SPAN_AFTER_CLOSE_MS = 16 * HOUR_MS;

export interface LedgerWindowSpans {
  /** The governed on-peak period, or null (Friday, a holiday). */
  onpeak: TimeSpan | null;
  scoreSpanEndMs: number;
  /** A row may be captured only at or after this instant. */
  completeMs: number;
}

/**
 * v1.187.0 — the clock spans of a row whose window is known. PURE.
 * ★ The night completes only once its governed on-peak has CLOSED as well as the 16 h
 * score span. Under R-EV the governed on-peak (16:00-19:00 after a 05:00 close) always
 * ends inside the span, so no capture moves; the max() keeps any other calendar honest —
 * a capture before the on-peak closes would freeze a partial on-peak import for good.
 */
export function ledgerSpansForWindow(
  windowEndMs: number,
  isOnPeakAt: (tsMs: number) => boolean,
  isCheapAt: (tsMs: number) => boolean,
): LedgerWindowSpans {
  const scoreSpanEndMs = windowEndMs + SCORE_SPAN_AFTER_CLOSE_MS;
  const onpeak = governedOnPeakSpan(windowEndMs, isOnPeakAt, isCheapAt);
  return { onpeak, scoreSpanEndMs, completeMs: Math.max(scoreSpanEndMs, onpeak?.endMs ?? 0) };
}

/** The actuator's tick (index.ts `nightActuationTick`): a restore due at the close lands
 *  on the first tick after it. */
export const ACTUATOR_TICK_MS = 60_000;
/** How long the panel keeps charging after the restore (and force-charge's OFF) is
 *  written: seconds — on 2026-09-28 the Cores were drawing ~5.2 kW each 14 s after a
 *  reserve write — so one minute covers the device and the write's own round trip. */
export const HOLD_DEVICE_SETTLE_MS = 60_000;
/** The furthest past the close a LATE restore (cloud rejections, retries) extends the
 *  span. The hold is real while the reserve stays raised, but after the close the span
 *  also integrates the morning, where solar carries the load and import − load turns
 *  negative; past half an hour that bias outweighs the charging tail it recovers.
 *  v1.187.3 — delivered energy is now measured into the Cores (deliveredIntoCores), which
 *  a solar morning does not drive negative; the bound is kept unchanged as the limit on
 *  how much of a late restore's charging is credited to the night. */
export const HOLD_TAIL_MAX_MS = 30 * 60_000;

/** Which evidence ended the delivered-energy span. */
export type HoldSpanBasis = 'revert-stamp' | 'legacy-schedule' | 'close-plus-tick';

/**
 * v1.187.0 (review) — the span `delivered_kwh` integrates on an actuated night. PURE.
 *
 * v1.115.0: integrate the span the write was actually HELD, not the nominal window. With
 * APPLY_LEAD_MS / REVERT_LAG_MS at 0 the first cut of v1.187.0 ended the span exactly at
 * the close — but the restore lands on the first actuator tick AFTER the close, and the
 * panel stops charging seconds later, so a night still charging at 05:00 lost ~30-90 s
 * at 16-19 kW (0.1-0.5 kWh) from a column that trains the buy de-bias calibrator, always
 * toward under-delivery (the v1.115.0 defect class). Now:
 *  - `revert-stamp`: the restore's own time (`actuation_reverted_at_ms`, stamped by the
 *    actuator from v1.187.0), never earlier than the close (a cancel or a grid-loss
 *    abort keeps the window, as before) and never later than HOLD_TAIL_MAX_MS past it,
 *    plus HOLD_DEVICE_SETTLE_MS;
 *  - `legacy-schedule`: no stamp, applied BEFORE its window — the pre-v1.187.0 schedule
 *    (5 min lead, 5 min lag), so the close + LEGACY_REVERT_LAG_MS it always used;
 *  - `close-plus-tick`: no stamp on the current schedule — the close + one actuator tick
 *    + the device settle, the latest a restore at the close lands.
 * The start is the write (or the window open, whichever is earlier), as before.
 */
export function deliveredHoldSpan(i: {
  windowStartMs: number;
  windowEndMs: number;
  appliedAtMs: number | null | undefined;
  revertedAtMs: number | null | undefined;
}): TimeSpan & { basis: HoldSpanBasis } {
  const applied = typeof i.appliedAtMs === 'number' && Number.isFinite(i.appliedAtMs) ? i.appliedAtMs : i.windowStartMs;
  const startMs = Math.min(applied, i.windowStartMs);
  if (typeof i.revertedAtMs === 'number' && Number.isFinite(i.revertedAtMs)) {
    const restoreAt = Math.min(Math.max(i.revertedAtMs, i.windowEndMs), i.windowEndMs + HOLD_TAIL_MAX_MS);
    return { startMs, endMs: restoreAt + HOLD_DEVICE_SETTLE_MS, basis: 'revert-stamp' };
  }
  if (applied < i.windowStartMs) {
    return { startMs, endMs: i.windowEndMs + LEGACY_REVERT_LAG_MS, basis: 'legacy-schedule' };
  }
  return { startMs, endMs: i.windowEndMs + ACTUATOR_TICK_MS + HOLD_DEVICE_SETTLE_MS, basis: 'close-plus-tick' };
}

export interface RealizedCostOutcome {
  cents: number | null;
  /** A clause for score_notes, always present so a null cost says WHY. */
  note: string;
}

/**
 * v1.187.0 (review) — `realized_cost_cents` for one row over `span`, and the reason when
 * it is null. PURE. `pts` are `grid_home_w` samples over the span (ignored when the row
 * is superseded — the later row carries the cost, and two rows would count it twice).
 *
 * ★ Not a bill. Each row prices [window open, close + 16 h): consecutive rows overlap on
 * no hour but do not TILE time either — on a weekday 21:00-23:00 falls in no row, and a
 * Friday row stops at Saturday 16:00, leaving Saturday 16:00 → Monday 00:00 in none — and
 * the spans differ in length (a Friday row covers 17 h, a Monday-window row 21 h). Summed
 * over a month the column is not what the nights cost; the HA Grid Cost Today sensor is
 * the daily total.
 */
export function realizedCostOutcome(i: {
  span: TimeSpan;
  supersededBy: string | null;
  pts: ReadonlyArray<Sample>;
  rateAt: (tsMs: number) => RateLike;
}): RealizedCostOutcome {
  if (i.supersededBy != null) {
    return { cents: null, note: `Cost: carried by the ${i.supersededBy} plan, which owns this window` };
  }
  const cov = coverageFrac(i.pts, i.span.startMs, i.span.endMs);
  if (!(cov >= LEDGER_SPAN_MIN_COVERAGE)) {
    return { cents: null, note: `Cost: unmeasured (grid_home_w coverage ${Math.round(cov * 100)}% < ${LEDGER_SPAN_MIN_COVERAGE * 100}%)` };
  }
  const p = pricedImport(i.pts, i.rateAt);
  if (p.cents != null) {
    return { cents: p.cents, note: `Cost: ${p.cents}¢ of metered import, window open to close + 16 h (energy only; rows do not tile, so not a bill)` };
  }
  if (p.unpriced == null) return { cents: null, note: 'Cost: unmeasured (no grid_home_w samples)' };
  if (p.unpriced.ratesConfirmed === false) {
    return { cents: null, note: 'Cost: not priced (tariff rates unconfirmed — TARIFF_APS_RATES_CONFIRMED)' };
  }
  return {
    cents: null,
    note: `Cost: not priced (no ${p.unpriced.season ?? 'season'} rate configured for ${p.unpriced.periodLabel ?? 'a period in the span'})`,
  };
}

/** v1.187.3 — the house panel's per-Core source channel (recorder.ts `src{n}_w`, from
 *  `backupInfo.chWatt`): positive = the panel charging that Core, negative = the Core
 *  carrying the house. */
export type SourceChannelMetric = `src${number}_w`;
/** The recorder series the assembly reads. */
export type LedgerMetric = 'grid_home_w' | 'panel_load' | SourceChannelMetric;
export type LedgerQuery = (metric: LedgerMetric, startMs: number, endMs: number) => ReadonlyArray<Sample>;

/** v1.187.3 (review) — the SHP2's source slots (Energy1Info..Energy3Info; project.ts), and
 *  so the `src{n}_w` channels deliveredIntoCores reads over every hold. */
export const SOURCE_CHANNEL_SLOTS: readonly number[] = [1, 2, 3];

/** v1.187.3 — a panel's connected source slots (Energy{n}Info slot n), sorted: connected AND
 *  carrying a serial, the live rule of shp2Membership.panelRoster WITHOUT its persisted
 *  lastRoster fallback (a roster is serials, not slots). PURE. */
export function connectedSourceSlots(
  sources: ReadonlyArray<{ slot: number; sn: string | null; isConnected: boolean }> | null | undefined,
): number[] {
  const out = new Set<number>();
  for (const s of sources ?? []) {
    if (s.isConnected && s.sn && Number.isInteger(s.slot) && s.slot >= 1) out.add(s.slot);
  }
  return [...out].sort((a, b) => a - b);
}

/** v1.187.3 (review) — the HOUSE panel's connected source slots in a live device map, keyed
 *  by the house panel's own serial (the scorer's shp2Sn), never another panel's; [] while it
 *  has no SHP2 projection. PURE. */
export function houseConnectedSlots(
  devices: Readonly<Record<string, Pick<DeviceSnapshot, 'projection'> | undefined>>,
  shp2Sn: string,
): number[] {
  const p = devices[shp2Sn]?.projection;
  return p?.kind === 'shp2' ? connectedSourceSlots((p as Shp2Projection).sources) : [];
}

/** v1.187.3 — measured energy into the Cores may exceed the metered grid import over the
 *  same span by this much (5% + 0.5 kWh: two series sampled on different clocks) before
 *  it is withheld as implausible. Overnight the grid is the only source that can charge
 *  them, so more than that is a channel read with the wrong sign or meaning. */
export const DELIVERED_IMPORT_SLACK_FRAC = 0.05;
export const DELIVERED_IMPORT_SLACK_KWH = 0.5;

export interface DeliveredOutcome {
  kwh: number | null;
  /** DELIVERED_BASIS exactly when `kwh` is a number; null otherwise. */
  basis: string | null;
  /** A clause for score_notes, always present so a null says WHY. */
  note: string;
}

/**
 * v1.187.3 — `delivered_kwh` on an actuated night: the energy INTO the home Cores over the
 * hold span, the charging part of the house panel's source channels (`src{n}_w` > 0),
 * summed. PURE (all I/O is `query`).
 *
 * WHY NOT IMPORT − LOAD. That estimate assumed the house ran on the grid for the whole
 * hold; when the SHP2 carries the house from the pack (above its reserve, before a
 * just-in-time force-charge and after its OFF) the house load it subtracts was never
 * imported. 2026-09-30: import 23.38 − load 18.67 = 4.71 kWh recorded; the source channels
 * read 20.34 kWh into the Cores (the Cores' own AC input 20.25, the pool 55→76%). A channel
 * carrying the house reads negative and adds nothing, so the hours on the pack cost nothing
 * here and the hours on the grid count only what reached the Cores.
 *
 * WHICH CHANNELS (v1.187.3 review). Every SOURCE_CHANNEL_SLOTS channel the recorder wrote
 * at least one sample for inside the hold, plus every slot `connectedSlots` names. The
 * hold's own samples decide, not the panel's membership at capture, which runs ~16 h after
 * the close: a Core unplugged by then, or a /quota/all that came back without the pd303_mc
 * sources subtree that minute, would otherwise drop a channel that charged all night (or
 * all of them) from a column that is written once. The recorder writes `src{n}_w` for every
 * `chWatt` entry whether or not the slot is connected, so an empty slot reads zeros and adds
 * nothing, and the slot ↔ chWatt index mapping does not matter. A slot connected at capture
 * whose channel recorded nothing in the hold is still read: it is a dark channel, and the
 * coverage gate below withholds the night rather than summing the others.
 *
 * NULL, with the reason in the note, when:
 *  - no channel recorded anything over the hold and no connected Core is known;
 *  - any channel's coverage of the span is under LEDGER_SPAN_MIN_COVERAGE — the MINIMUM over
 *    channels, as actual_pv_kwh's per-core gate: one dark channel in three averages to a
 *    healthy 0.67 while the total is a third short, and this column is durable;
 *  - the total exceeds the metered import over the span (grid_home_w, when that is itself
 *    covered) by more than DELIVERED_IMPORT_SLACK_*: impossible overnight, so a channel
 *    read wrong — a discharge counted as charge would otherwise inflate the learner.
 */
export function deliveredIntoCores(i: {
  hold: TimeSpan;
  /** houseConnectedSlots at capture: added to the channels the hold recorded. */
  connectedSlots: readonly number[];
  query: LedgerQuery;
}): DeliveredOutcome {
  const connected = new Set(i.connectedSlots);
  const read: Array<{ ch: number; pts: ReadonlyArray<Sample> }> = [];
  for (const ch of [...new Set([...SOURCE_CHANNEL_SLOTS, ...i.connectedSlots])].sort((a, b) => a - b)) {
    const pts = i.query(`src${ch}_w`, i.hold.startMs, i.hold.endMs);
    if (pts.length > 0 || connected.has(ch)) read.push({ ch, pts });
  }
  if (read.length === 0) {
    return {
      kwh: null, basis: null,
      note: 'Delivered: unmeasured (no source channel recorded over the hold and no connected Core known on the house panel)',
    };
  }
  let wh = 0;
  let worst: { ch: number; cov: number } | null = null;
  for (const { ch, pts } of read) {
    const cov = coverageFrac(pts, i.hold.startMs, i.hold.endMs);
    if (worst == null || cov < worst.cov) worst = { ch, cov };
    wh += integrateWh(pts, true);
  }
  if (worst == null || !(worst.cov >= LEDGER_SPAN_MIN_COVERAGE)) {
    return {
      kwh: null, basis: null,
      note: `Delivered: unmeasured (source channel ${worst?.ch ?? '?'} coverage ${Math.round((worst?.cov ?? 0) * 100)}% < ${LEDGER_SPAN_MIN_COVERAGE * 100}%)`,
    };
  }
  const kwh = round2(wh / 1000);
  const imp = i.query('grid_home_w', i.hold.startMs, i.hold.endMs);
  if (coverageFrac(imp, i.hold.startMs, i.hold.endMs) >= LEDGER_SPAN_MIN_COVERAGE) {
    const impKwh = round2(integrateWh(imp, true) / 1000);
    if (kwh > impKwh * (1 + DELIVERED_IMPORT_SLACK_FRAC) + DELIVERED_IMPORT_SLACK_KWH) {
      return {
        kwh: null, basis: null,
        note: `Delivered: withheld (${kwh} kWh into the Cores exceeds the ${impKwh} kWh metered import over the hold; overnight the grid is their only source)`,
      };
    }
  }
  return {
    kwh, basis: DELIVERED_BASIS,
    note: `Delivered: ${kwh} kWh into the Cores (charging part of source channel${read.length > 1 ? 's' : ''} ${read.map((r) => r.ch).join('/')} over the hold)`,
  };
}

/** v1.187.3 (review) — the ledger fields the scorer writes for delivered energy, as ONE
 *  patch: `delivered_basis` is written exactly when `delivered_kwh` is a number, so a NULL
 *  value can never carry the current basis and a value can never be written without it
 *  (the learner would set it aside as captured before v1.187.3). PURE. */
export function deliveredLedgerFields(
  cols: Pick<NightLedgerColumns, 'deliveredKwh' | 'deliveredBasis'>,
): Pick<NightLedgerRow, 'delivered_kwh' | 'delivered_basis'> {
  return {
    delivered_kwh: cols.deliveredKwh,
    delivered_basis: cols.deliveredKwh == null ? null : cols.deliveredBasis,
  };
}

export interface NightLedgerColumnsInput {
  row: Pick<NightLedgerRow,
    'plan_date' | 'issued_at_ms' | 'actuation_applied_at_ms' | 'actuation_reverted_at_ms' | 'pv_model_sns'>;
  /** The actuator stamped this night `actuated=1`. */
  actuated: boolean;
  windowStartMs: number;
  windowEndMs: number;
  scoreSpanEndMs: number;
  /** The governed on-peak (ledgerSpansForWindow), or null. */
  onpeak: TimeSpan | null;
  /** The later plan_date that owns this row's window (supersedingPlanDate), or null. */
  supersededBy: string | null;
  /** The house panel's recorded series (the scorer passes recorder.query on the SHP2). */
  query: LedgerQuery;
  /** The tariff's rate at an instant (rateAt(apsREvModelFromEnv(), t)). */
  rateAt: (tsMs: number) => RateLike;
  /** The Cores whose actual PV the verdict sums. */
  homeSns: readonly string[];
  /** v1.187.3 — the house panel's connected source slots at capture (houseConnectedSlots):
   *  added to the channels the hold recorded (deliveredIntoCores). */
  houseConnectedSlots: readonly number[];
}

export interface NightLedgerColumns {
  onpeak: OnPeakOutcome;
  cost: RealizedCostOutcome;
  /** The span realized cost is priced over (whether or not it was priced). */
  costSpan: TimeSpan;
  /** Actuated nights only: the span delivered_kwh integrates. */
  hold: (TimeSpan & { basis: HoldSpanBasis }) | null;
  deliveredKwh: number | null;
  /** v1.187.3 — `delivered_basis`: DELIVERED_BASIS exactly when deliveredKwh is a number. */
  deliveredBasis: string | null;
  pvSetAside: string | null;
  /** The clauses appended to score_notes: on-peak, cost, delivered (actuated nights), and
   *  the set-aside when present. */
  notes: string;
}

/**
 * v1.187.0 (review) — the on-peak, cost, delivered-energy and PV-evidence columns of one
 * captured row with a known window. PURE (all I/O is `query`).
 *  - On-peak: queried over the governed span only when this row is the plan of record.
 *  - Cost: [min(write, window open), close + 16 h), only for the plan of record, only at
 *    ≥ LEDGER_SPAN_MIN_COVERAGE, only when every interval has a rate.
 *  - Delivered: actuated nights only, over deliveredHoldSpan, into the Cores
 *    (deliveredIntoCores, v1.187.3).
 *  - PV set-aside: the band's Cores against the actuals' Cores, else the known-row list.
 */
export function assembleNightLedgerColumns(i: NightLedgerColumnsInput): NightLedgerColumns {
  const ofRecord = i.supersededBy == null;

  const onpeakSpan = ofRecord ? i.onpeak : null;
  const gridPeak = onpeakSpan ? i.query('grid_home_w', onpeakSpan.startMs, onpeakSpan.endMs) : [];
  const onpeak = nightOnPeakOutcome({
    span: i.onpeak,
    supersededBy: i.supersededBy,
    importKwh: gridPeak.length ? integrateWh(gridPeak, true) / 1000 : null,
    coverage: onpeakSpan ? coverageFrac(gridPeak, onpeakSpan.startMs, onpeakSpan.endMs) : null,
  });

  // From the window open — or the reserve write, when an older schedule applied it
  // earlier — to the close + 16 h: the overnight buy, the day's off-peak import and the
  // governed on-peak.
  const costSpan: TimeSpan = {
    startMs: Math.min(i.row.actuation_applied_at_ms ?? i.windowStartMs, i.windowStartMs),
    endMs: i.scoreSpanEndMs,
  };
  const cost = realizedCostOutcome({
    span: costSpan,
    supersededBy: i.supersededBy,
    pts: ofRecord ? i.query('grid_home_w', costSpan.startMs, costSpan.endMs) : [],
    rateAt: i.rateAt,
  });

  let hold: (TimeSpan & { basis: HoldSpanBasis }) | null = null;
  let delivered: DeliveredOutcome | null = null;
  if (i.actuated) {
    hold = deliveredHoldSpan({
      windowStartMs: i.windowStartMs,
      windowEndMs: i.windowEndMs,
      appliedAtMs: i.row.actuation_applied_at_ms,
      revertedAtMs: i.row.actuation_reverted_at_ms,
    });
    // v1.187.3 — measured into the Cores, not import − house load (deliveredIntoCores).
    delivered = deliveredIntoCores({ hold, connectedSlots: i.houseConnectedSlots, query: i.query });
  }

  // Is the PV verdict forecast-skill evidence at all? Only when the band was built for
  // the Cores whose actual PV it is graded against (pv_model_sns, recorded at plan time).
  const pvSetAside = pvVerdictSetAside(i.row.pv_model_sns, i.homeSns) ?? knownFleetMismatchReason(i.row);

  return {
    onpeak, cost, costSpan, hold,
    deliveredKwh: delivered?.kwh ?? null,
    deliveredBasis: delivered?.basis ?? null,
    pvSetAside,
    notes: `${onpeak.note}. ${cost.note}.${delivered ? ` ${delivered.note}.` : ''}${pvSetAside ? ` ${pvSetAside}.` : ''}`,
  };
}

/**
 * v1.187.0 (review) — the on-peak and cost columns of a row captured with NO known window.
 * PURE. A plan that resolved no window by design buys nothing and governs no on-peak:
 * `onpeak_basis` 'none', said in the note. A pre-v1.39.0 row whose window was never
 * recorded cannot be paired to anything: its basis stays NULL — NULL means "not measured
 * on the governed basis" (captured before v1.187.0, or unpairable), never "none governed".
 */
export function windowlessLedgerColumns(noWindowByDesign: boolean): {
  onpeakBasis: OnPeakBasis | null;
  notes: string;
} {
  return noWindowByDesign
    ? { onpeakBasis: 'none', notes: 'On-peak: none governed (no charge window). Cost: none recorded (no charge window).' }
    : { onpeakBasis: null, notes: 'On-peak and cost: not recorded (no window to pair them to).' };
}

/**
 * v1.187.0 (review) — the periods a CONFIRMED rate table leaves without a rate, as
 * "<label> (<season>)". PURE. Any one of them nulls every realized_cost_cents whose span
 * crosses it (pricedImport never half-prices a span): with the winter super-off-peak
 * option at its default "", every row whose span holds a winter weekday 10:00-15:00 —
 * most of them, from November — would record NULL. The boot says so once, rather than
 * leaving the owner to find the NULLs. Empty on an unconfirmed table (every rate is null
 * there by design, and each row's note says so).
 */
export function unpricedTariffPeriods(model: TariffModel): string[] {
  if (!model.ratesConfirmed) return [];
  const all: Season[] = ['summer', 'winter'];
  const out: string[] = [];
  for (const p of model.periods) {
    for (const season of p.seasons ?? all) {
      if (p.centsBySeason[season] == null) out.push(`${p.label} (${season})`);
    }
  }
  for (const season of all) {
    if (model.offPeak.centsBySeason[season] == null) out.push(`${model.offPeak.label} (${season})`);
  }
  return out;
}
