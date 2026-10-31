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
 *  - the cost columns were declared and never written (the manual's chapter 15 section 6,
 *    now docs/reference/15-1-night-charge-planning.md “6. The learning ledger”: "no valid savings
 *    counterfactual pre-write, and rates default unconfirmed" — both reasons had
 *    expired: rates confirmed, 24 actuated nights).
 *  - a PV band built on a forecast fitted on one Core (the 2026-09-27 21:06 restart,
 *    v1.186.5) was graded against three Cores' actual PV and counted as covered.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { NightLedgerRow } from './recorder.js';
import { tariffRatesConfirmation, type Season, type TariffModel } from './tariff.js';
import { fmtMinor } from './money.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection } from './ecoflow/project.js';
import { DELIVERED_BASIS, medianFilter3 } from './nightChargeAdvisor.js';
import { saturationThresholdPct, meanChargeCeilingPct } from './chargeTaper.js';
import { LEGACY_REVERT_LAG_MS } from './nightChargeActuator.js';
import { SHP2_SOURCE_SLOTS } from './hwSpec.js';

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
 * (tariff.ts rateAt: `.isOnPeak`, `.periodId` equal to the plan's cheap period — cheapPeriodIdOf,
 * 'overnight' on the APS preset), so the weekday gate
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
  rows: ReadonlyArray<Pick<NightLedgerRow, 'plan_date' | 'window_start_ms' | 'window_end_ms'>
    & Partial<Pick<NightLedgerRow, 'backup_window_start_ms' | 'backup_window_end_ms'>>>,
): string | null {
  if (typeof row.window_start_ms !== 'number' || typeof row.window_end_ms !== 'number') return null;
  const own = String(row.plan_date);
  let latest: string | null = null;
  for (const o of rows) {
    const d = String(o.plan_date);
    if (d <= own) continue;
    // R4 (v1.189.0) — or a later mid-day cycle whose outage BACKUP leg takes this row's window:
    // Sunday's two-leg plan holds Monday 00:00-05:00 as its backup, and Saturday's overnight arm for
    // that window is superseded by it as by Sunday's overnight plan before the switch.
    const sameWindow = o.window_start_ms === row.window_start_ms && o.window_end_ms === row.window_end_ms;
    const asBackup = o.backup_window_start_ms === row.window_start_ms && o.backup_window_end_ms === row.window_end_ms;
    if (!sameWindow && !asBackup) continue;
    if (latest == null || d > latest) latest = d;
  }
  return latest;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * R4 (v1.189.0) — A TWO-LEG ROW (plan §6 "Spans"). A winter mid-day cycle is one row keyed by its
 * plan date whose plan columns hold the mid-day cost leg (`window_kind` 'super_off_peak'); its
 * overnight backup leg has the backup_* columns. Such a row scores three spans, whether or not the
 * backup armed: the backup span [overnight open, cost open), the window itself, and the post span
 * [window close, min(close + 16 h, next chargeable open)) — 15:00 to 23:00 on a weekday. The rows
 * then tile end to end, so the 05:00-10:00 low always falls inside one; a plain close + 16 h would
 * end at 07:00 the next morning, inside the next row's backup span. The realized trough
 * (`actual_min_soc_pct`, `cushion_breached`) covers the backup and post spans, so a 07:00 breach on
 * an actuated cycle is a strike, armed backup or not (nightChargeGate.ts keeps its rule). Every
 * other row — every row before the mid-day switch — keeps the close + 16 h span (ledgerSpansForWindow).
 * ═════════════════════════════════════════════════════════════════════════ */

/** The tariff periods a row's cycle buys in, for the on-peak attribution (governedOnPeakSpan's
 *  isCheapAt: the next plan's window opening first ends this plan's claim). A mid-day row buys in
 *  the super off-peak window behind an overnight backup; every other row in the overnight window
 *  alone, as before. v1.191.0 (W1) — the overnight window is a run of the tariff's cheap period
 *  (`cheapPeriodId`, tariff.ts cheapPeriodIdOf: 'overnight' on the APS preset, the default); null —
 *  a plan with no cheap period — names none. PURE. */
export function ledgerCheapPeriodIds(
  windowKind: string | null | undefined, cheapPeriodId: string | null = 'overnight',
): readonly string[] {
  const own = cheapPeriodId == null ? [] : [cheapPeriodId];
  return windowKind === 'super_off_peak' ? [...own, 'super_off_peak'] : own;
}

export interface CycleLedgerSpans extends LedgerWindowSpans {
  /** The spans the realized trough is taken over: the backup span (when its open is on the row)
   *  and the post span. */
  troughSpans: TimeSpan[];
}

/** The three spans of a two-leg row; null for any other row (ledgerSpansForWindow then applies).
 *  The backup span needs the row's backup window open (`backup_window_start_ms`, written with the
 *  plan whether or not the backup armed); a row without it scores the post span alone — no span is
 *  invented. The post span ends at the next chargeable open (`next_recharge_ms`), at most 16 h past
 *  the close. The row completes once that span and its governed on-peak have both closed. PURE. */
export function cycleLedgerSpans(
  row: Pick<NightLedgerRow, 'window_kind' | 'window_start_ms' | 'window_end_ms'>
    & Partial<Pick<NightLedgerRow, 'backup_window_start_ms' | 'next_recharge_ms'>>,
  isOnPeakAt: (tsMs: number) => boolean,
  isCheapAt: (tsMs: number) => boolean,
): CycleLedgerSpans | null {
  if (row.window_kind !== 'super_off_peak') return null;
  const ws = row.window_start_ms;
  const we = row.window_end_ms;
  if (typeof ws !== 'number' || typeof we !== 'number' || !(we > ws)) return null;
  const capEnd = we + SCORE_SPAN_AFTER_CLOSE_MS;
  const next = row.next_recharge_ms;
  const postEnd = typeof next === 'number' && Number.isFinite(next) && next > we ? Math.min(capEnd, next) : capEnd;
  const troughSpans: TimeSpan[] = [];
  const bs = row.backup_window_start_ms;
  if (typeof bs === 'number' && Number.isFinite(bs) && bs < ws) troughSpans.push({ startMs: bs, endMs: ws });
  troughSpans.push({ startMs: we, endMs: postEnd });
  const onpeak = governedOnPeakSpan(we, isOnPeakAt, isCheapAt);
  return { onpeak, scoreSpanEndMs: postEnd, completeMs: Math.max(postEnd, onpeak?.endMs ?? 0), troughSpans };
}

/** The lowest value over several spans of one series, after the scorer's median-of-3 spike filter
 *  per span (a reconnect's single 0 sample never decides it). null with no sample. PURE. */
export function minOverSpans(
  spans: ReadonlyArray<TimeSpan>,
  query: (startMs: number, endMs: number) => ReadonlyArray<Sample>,
  filter: (pts: ReadonlyArray<Sample>) => ReadonlyArray<Sample>,
): { value: number; ts: number } | null {
  let best: { value: number; ts: number } | null = null;
  for (const sp of spans) {
    for (const p of filter(query(sp.startMs, sp.endMs))) {
      if (best == null || p.value < best.value) best = { value: p.value, ts: p.ts };
    }
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * R4 (v1.189.0) — THE MID-DAY SHADOW, GRADED. The shadow (middayShadow.ts) records the PV and
 * load its mid-day leg was planned on over its window (P50, `shadow_window_*_p50_kwh`); the row's
 * capture measures the same window. The pair is forecast skill for the hours a mid-day charge
 * would run in, the evidence the switch waits on — not a validation of the sizing model.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The measured PV (the home Cores' pv_total, each at least LEDGER_SPAN_MIN_COVERAGE covered —
 *  the ledger's per-Core rule) and house load (the panel's panel_load, the same coverage) over the
 *  shadow's mid-day window, kWh; null for a figure the coverage does not support. null altogether
 *  when the row has no shadow window or it has not closed. PURE.
 *
 *  v1.189.0 on v1.188.1 — and null for a side HELD over the window (`held`: the recorder's held
 *  spans and the house panel): a home Core held for HELD_LEDGER_MIN_OVERLAP_MS or more of it leaves
 *  the PV empty, the panel held that long the load — heldLedgerVerdict over the window itself, the
 *  rule the row's own PV/load actuals are withheld by over [issue, +24 h]. The recorder keeps held
 *  readings out of `samples`, so the 90% coverage of a 5 h window already refuses such an hour;
 *  the verdict states the refusal on the rule the scorer uses, not on the window's length.
 *
 *  v1.189.0 (review) — and the PV null on a row whose PV verdict is set aside (`pvSetAside`: the
 *  row's own pvVerdictSetAside / knownFleetMismatchReason, NightLedgerColumns.pvSetAside). The
 *  shadow's window P50 comes from the same evening band as the row's, so a band built on a solar
 *  model fitted on other Cores than the actuals says nothing about forecast skill over the window
 *  either: the measured PV would be graded against it. The load is not a Core-set figure and is
 *  kept. */
export function shadowWindowActuals(i: {
  row: Partial<Pick<NightLedgerRow, 'shadow_cost_window_start_ms' | 'shadow_cost_window_end_ms'>>;
  nowMs: number;
  homeSns: readonly string[];
  queryPv: (sn: string, startMs: number, endMs: number) => ReadonlyArray<Sample>;
  queryLoad: (startMs: number, endMs: number) => ReadonlyArray<Sample>;
  /** The held spans over [startMs, endMs] (recorder.heldSpans) and the house panel. Absent: no
   *  side is held. */
  held?: { spans: (startMs: number, endMs: number) => ReadonlyArray<LedgerHeldSpan>; panelSn: string };
  /** The row's PV set-aside reason (NightLedgerColumns.pvSetAside); null or absent: the band is
   *  evidence and the PV is measured. */
  pvSetAside?: string | null;
}): { pvKwh: number | null; loadKwh: number | null } | null {
  const a = i.row.shadow_cost_window_start_ms;
  const b = i.row.shadow_cost_window_end_ms;
  if (typeof a !== 'number' || typeof b !== 'number' || !(b > a) || i.nowMs < b) return null;
  const held = i.held == null ? { pv: false, load: false } : heldSides(heldLedgerVerdict({
    spans: i.held.spans(a, b), coreSns: i.homeSns, panelSn: i.held.panelSn, span: { startMs: a, endMs: b },
  }));
  let pvKwh: number | null = null;
  if (i.homeSns.length > 0) {
    let pvEnergyWh = 0;
    let worst = 1;
    for (const sn of i.homeSns) {
      const pts = i.queryPv(sn, a, b);
      pvEnergyWh += integrateWh(pts, true);
      worst = Math.min(worst, coverageFrac(pts, a, b));
    }
    pvKwh = worst >= LEDGER_SPAN_MIN_COVERAGE ? round2(pvEnergyWh / 1000) : null;
    if (held.pv) pvKwh = null;
  }
  if (i.pvSetAside != null) pvKwh = null;
  const load = i.queryLoad(a, b);
  const loadKwh = !held.load && load.length > 0 && coverageFrac(load, a, b) >= LEDGER_SPAN_MIN_COVERAGE
    ? round2(integrateWh(load, false) / 1000) : null;
  return { pvKwh, loadKwh };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * R4 (v1.189.0) — plan §4 item 9, the accounting part: the hours a mid-day charge of OURS held the
 * pool are not evidence about the arrays. A grid charge beside the sun takes acceptance the PV would
 * have had, so the MPPTs back off; a soiling estimate, the Bayesian solar posterior or the PV bias
 * hindcast that read those hours would learn a dirty or under-producing array that is neither.
 * Overnight rows contribute nothing (no sun: excluding them changes no figure), so every hour these
 * learners read today is read as before.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The hour epochs (floor(ts / 1 h)) of every mid-day charge of ours on the ledger: a row whose
 *  cost leg charged in the super off-peak window and wrote (actuated, or a write or force-charge
 *  stamp), from its window open to one hour past its close (the restore and its readback). PURE. */
export function middayChargeHourEpochs(
  rows: ReadonlyArray<Partial<Pick<NightLedgerRow, 'window_kind' | 'window_start_ms' | 'window_end_ms' | 'actuated'
    | 'actuation_applied_at_ms' | 'force_charge_on_at_ms'>>>,
): Set<number> {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.window_kind !== 'super_off_peak') continue;
    const wrote = r.actuated === 1 || (r.actuated as unknown) === true
      || typeof r.actuation_applied_at_ms === 'number' || typeof r.force_charge_on_at_ms === 'number';
    if (!wrote) continue;
    const a = r.window_start_ms;
    const b = r.window_end_ms;
    if (typeof a !== 'number' || typeof b !== 'number' || !(b > a)) continue;
    const last = Math.ceil(b / HOUR_MS);
    for (let he = Math.floor(a / HOUR_MS); he <= last && he - Math.floor(a / HOUR_MS) < 48; he++) out.add(he);
  }
  return out;
}

/** `map` without the hour epochs in `drop`; the same map when there is nothing to drop. PURE. */
export function withoutHourEpochs<V>(map: Map<number, V>, drop: ReadonlySet<number>): Map<number, V> {
  if (drop.size === 0) return map;
  const out = new Map<number, V>();
  for (const [he, v] of map) if (!drop.has(he)) out.set(he, v);
  return out;
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

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.10 — THE FORECAST SPAN.
 *
 * `pv_err_frac`, `load_err_frac` and (through the planner-sizing basis) `buy_err_kwh`
 * compare the realized PV/load with the plan's P50, which sums the 24 hourly slots of the
 * day-ahead forecast issued with the plan. The actuals are integrated over
 * [issued_at, issued_at + 24 h] — clipped to the capture instant. The capture itself was
 * gated only on `completeMs` (window close + 16 h): on a weekday that is ~21:00, within
 * half an hour of issue + 24 h, but a Friday 1 h window closes Saturday 00:00 and completes
 * Saturday 16:00, ~5.4 h before issue + 24 h. The 2026-10-02 row was captured at
 * 16:08:08 on 18.6 h of load (39.62 kWh) against an 81.8 kWh 24 h forecast: load_err
 * −0.52 and buy_err +51.09 kWh frozen into the never-pruned ledger, where buy_err is the
 * readiness gate's HARD under-buy evidence (a positive skew masks a real under-buy).
 *
 * `completeMs` is left as it is — repairPrematureNightOutcomes resets any row captured
 * before it, across a 60-day sweep that can reach past the raw-telemetry retention — and
 * the scorer gates on ledgerCaptureDueMs instead.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The span of the plan's P50 PV/load forecast, from its issue. */
export const FORECAST_SPAN_MS = 24 * HOUR_MS;

/** v1.187.10 — the span the PV/load actuals are integrated over: [issued_at,
 *  issued_at + 24 h], clipped to `nowMs`. PURE. */
export function forecastActualsSpan(issuedAtMs: number, nowMs: number): TimeSpan {
  return { startMs: issuedAtMs, endMs: Math.min(nowMs, issuedAtMs + FORECAST_SPAN_MS) };
}

/** v1.187.10 — the instant a row may be outcome-captured: its night complete AND its
 *  forecast span elapsed, so the actuals cover the same 24 h the forecast did. A row
 *  with no usable issue time keeps the night's own boundary. PURE. */
export function ledgerCaptureDueMs(completeMs: number, issuedAtMs: number | null | undefined): number {
  if (typeof issuedAtMs !== 'number' || !Number.isFinite(issuedAtMs)) return completeMs;
  return Math.max(completeMs, issuedAtMs + FORECAST_SPAN_MS);
}

/** v1.187.10 — the uncaptured rows the backfill sweep captures now, each with its spans
 *  (index.ts `scoreCompletedNights`). A row is skipped while already captured
 *  (idempotent), when its spans cannot be derived (malformed plan_date), and until
 *  ledgerCaptureDueMs. PURE. */
export function ledgerRowsDueForCapture<
  R extends Pick<NightLedgerRow, 'outcome_captured_at_ms' | 'issued_at_ms'>,
  S extends { completeMs: number },
>(rows: readonly R[], nowMs: number, spansFor: (row: R) => S | null): Array<{ row: R; spans: S }> {
  const due: Array<{ row: R; spans: S }> = [];
  for (const row of rows) {
    if (row.outcome_captured_at_ms != null) continue; // already captured — idempotent
    const spans = spansFor(row);
    if (!spans) continue; // malformed plan_date — leave for manual inspection
    if (nowMs < ledgerCaptureDueMs(spans.completeMs, row.issued_at_ms)) continue; // still in flight
    due.push({ row, spans });
  }
  return due;
}

/** How far short of the forecast span a captured row's actuals must fall before the
 *  one-time repair acts on it. Weekday rows captured before v1.187.10 stop 0.1–0.5 h
 *  short (completion ~21:00 against issue ~21:30) and are left as captured: a re-capture
 *  re-scores EVERY outcome column on the current scorer (delivered-energy basis, governed
 *  on-peak, PV coverage gate, the connected Cores at capture), so it is spent only where
 *  the PV/load/buy columns are materially wrong — a Friday 1 h window (~5.4 h) or an
 *  evening job delayed past ~22:00. */
export const FORECAST_SPAN_REPAIR_MIN_SHORT_MS = HOUR_MS;
/** Kept inside both the raw-sample retention and the backfill sweep's 60 days, so a reset
 *  row still has its telemetry and is still swept when the sweep re-captures it. */
export const FORECAST_SPAN_RECAPTURE_MARGIN_DAYS = 2;
/** The marker of the tag on a row past the re-capture horizon; its presence makes the tag
 *  idempotent. */
export const FORECAST_SPAN_TAG_MARKER = 'Forecast span:';

/** v1.187.10 — how far back a short row can still be re-captured. PURE. */
export function forecastSpanRecaptureHorizonMs(retentionDays: number, sweepDays: number): number {
  return Math.max(0, Math.min(retentionDays, sweepDays) - FORECAST_SPAN_RECAPTURE_MARGIN_DAYS) * 24 * HOUR_MS;
}

export interface ForecastSpanRepair {
  /** 'recapture' — reset for the sweep to re-capture over the full span; 'tag' — past the
   *  horizon, so only `score_notes` gains a clause saying the errors under-count. */
  action: 'recapture' | 'tag';
  /** How far the captured actuals fell short of issued_at + 24 h. */
  shortMs: number;
}

/**
 * v1.187.10 (review) — whether a short row inside the horizon may be RE-CAPTURED rather than
 * tagged. A re-capture scores the row on today's devices: actual PV is summed over today's
 * panel-connected Cores, and delivered_kwh is recomputed on the v1.187.3 source-charge basis.
 *  - No `pv_model_sns` (rows planned before v1.187.0, or with no recorded model set):
 *    pvVerdictSetAside cannot see a roster change, so a row from before one (2026-08-20)
 *    would be graded against another fleet's PV with nothing to set the verdict aside.
 *  - A `delivered_kwh` with no `delivered_basis` (rows captured before v1.187.3): the
 *    buy de-bias learner reads those as legacy and never rewrites them.
 * Either one: the row is tagged instead. PURE.
 */
export function forecastSpanRecapturable(
  row: Partial<Pick<NightLedgerRow, 'pv_model_sns' | 'delivered_kwh' | 'delivered_basis'>>,
): boolean {
  if (typeof row.pv_model_sns !== 'string' || row.pv_model_sns.trim() === '') return false;
  if (typeof row.delivered_kwh === 'number' && row.delivered_basis == null) return false;
  return true;
}

/**
 * v1.187.10 — the one-time repair a captured row owes, or null. PURE.
 * Only rows with a stored window (the rows the scorer measures actuals for) whose capture
 * preceded issued_at + 24 h by at least FORECAST_SPAN_REPAIR_MIN_SHORT_MS. Idempotent: a
 * re-captured row is captured after issue + 24 h (the scorer's gate), a reset row has no
 * capture, and a tagged row carries FORECAST_SPAN_TAG_MARKER.
 */
export function forecastSpanRepair(
  row: Pick<NightLedgerRow, 'outcome_captured_at_ms' | 'issued_at_ms' | 'window_start_ms' | 'window_end_ms' | 'score_notes'>
    & Partial<Pick<NightLedgerRow, 'pv_model_sns' | 'delivered_kwh' | 'delivered_basis'>>,
  nowMs: number,
  recaptureHorizonMs: number,
): ForecastSpanRepair | null {
  const cap = row.outcome_captured_at_ms;
  const issued = row.issued_at_ms;
  if (typeof cap !== 'number' || typeof issued !== 'number' || !Number.isFinite(issued)) return null;
  const ws = row.window_start_ms;
  const we = row.window_end_ms;
  if (typeof ws !== 'number' || typeof we !== 'number' || !(we > ws)) return null; // no actuals measured
  const shortMs = issued + FORECAST_SPAN_MS - cap;
  if (shortMs < FORECAST_SPAN_REPAIR_MIN_SHORT_MS) return null;
  if (nowMs - issued <= recaptureHorizonMs && forecastSpanRecapturable(row)) return { action: 'recapture', shortMs };
  if (String(row.score_notes ?? '').includes(FORECAST_SPAN_TAG_MARKER)) return null; // already tagged
  return { action: 'tag', shortMs };
}

/** v1.187.10 — the columns a forecast-span re-capture resets: the outcome columns
 *  repairPrematureNightOutcomes resets (the capture stamp first — it is what lets the sweep
 *  capture the row again), `scored` 0 and a note saying why. The re-capture rewrites all
 *  of them. PURE.
 *  v1.189.0 on v1.188.1 — and the mid-day shadow's measured window (`shadow_window_pv_kwh` /
 *  `_load_kwh`), which the capture writes beside the outcome (shadowWindowActuals): a row reset
 *  for held telemetry (heldResetColumns) keeps no figure measured on the readings the reset is
 *  for. The shadow's own columns, what the evening computed, are not outcome columns and stay. */
export function forecastSpanResetColumns(shortMs: number): Partial<NightLedgerRow> {
  const shortH = (shortMs / HOUR_MS).toFixed(1);
  return {
    outcome_captured_at_ms: null,
    actual_pv_kwh: null,
    actual_load_kwh: null,
    actual_window_import_kwh: null,
    actual_onpeak_import_kwh: null,
    onpeak_import_occurred: null,
    onpeak_start_ms: null,
    onpeak_end_ms: null,
    onpeak_basis: null,
    realized_cost_cents: null,
    actual_min_soc_pct: null,
    actual_min_soc_ts_ms: null,
    // v1.196.0 — measured over the same span as the PV actual it qualifies.
    actual_max_soc_pct: null,
    pv_saturated: null,
    plan_traj_floor_breached: null,
    cushion_breached: null,
    grid_home_coverage_frac: null,
    scored: 0,
    score_notes:
      `reset — the PV/load actuals had been captured ${shortH} h before issue + 24 h (before v1.187.10 a Friday `
      + 'or late-issued row completed before its forecast span ended); re-captured by the backfill sweep over the full 24 h.',
    pv_err_frac: null,
    pv_in_band: null,
    pv_verdict_set_aside: null,
    load_err_frac: null,
    load_in_band: null,
    buy_err_kwh: null,
    soc_min_err_pct: null,
    shadow_window_pv_kwh: null,
    shadow_window_load_kwh: null,
  };
}

/**
 * v1.196.0 — the saturation that censors a row's PV (NightLedgerRow.pv_saturated): the highest pool
 * SoC over the forecast span [issue, +24 h] — the span actual_pv_kwh is summed over —, after the
 * 3-sample median filter the trough uses (a lone reconnect sample is not a level the pool held),
 * against the charge taper of the home Cores' mean chgMaxSoc (chargeTaper.saturationThresholdPct;
 * 90 when none reports one). A pool that reached it sat where the Cores shed PV, so that day's
 * actual PV measures the curtailment, and the cost ceiling's PV factor leaves the row out
 * (costSurplusPvFactor). Both null with no reading. PURE.
 */
export function pvSaturationColumns(o: {
  socPts: ReadonlyArray<{ ts: number; value: number }>;
  chgMaxSocPcts: ReadonlyArray<number | null | undefined>;
}): { actual_max_soc_pct: number | null; pv_saturated: number | null } {
  let max: number | null = null;
  for (const p of medianFilter3(o.socPts)) {
    if (Number.isFinite(p.value) && (max == null || p.value > max)) max = p.value;
  }
  if (max == null) return { actual_max_soc_pct: null, pv_saturated: null };
  const taperPct = saturationThresholdPct(meanChargeCeilingPct(o.chgMaxSocPcts));
  return { actual_max_soc_pct: Math.round(max * 10) / 10, pv_saturated: max >= taperPct ? 1 : 0 };
}

/** v1.187.10 — the clause the tag appends to `score_notes`. PURE. */
export function forecastSpanTagNote(shortMs: number): string {
  const covered = Math.round((FORECAST_SPAN_MS - shortMs) / HOUR_MS * 10) / 10;
  return `${FORECAST_SPAN_TAG_MARKER} the PV/load actuals cover ${covered} h of the 24 h the P50 forecast covered `
    + '(captured before issue + 24 h, before v1.187.10), so actual_load_kwh/actual_pv_kwh under-count and '
    + 'load_err_frac reads low and buy_err_kwh high; the raw telemetry is past the re-capture horizon, so the row is kept as captured.';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.188.1 — HELD TELEMETRY.
 *
 * After the 2026-10-14 internet outage every Core stayed offline in the EcoFlow cloud for
 * about 20 h and the recorder restated each one's last reading every 5 minutes (heldSamples.ts):
 * PV 0 W all day while the pool charged to ~96 % on solar. The PV coverage gate counted those
 * rows as coverage, so a row whose 24 h span lay inside the hold would have been SCORED on an
 * actual PV of ~0 kWh: pv_err_frac near −1, pv_in_band 0 and, through the planner-sizing basis,
 * a buy_err_kwh the readiness gate reads as its HARD under-buy evidence.
 *
 * The recorder no longer writes held readings and moves the ones it had written out of
 * `samples`, and it logs each hold of an hour or more (`held_spans`). A row whose PV/load span
 * overlaps a hold of a home Core or the house panel by HELD_LEDGER_MIN_OVERLAP_MS or more is
 * not scored, with the reason: its PV (a Core held) or load (the panel held) actual is left
 * empty — never integrated from held readings, and never from a span with a held hour cut out
 * of it, which the trapezoid would drop and under-count. A row captured on held readings
 * before this release is reset and re-captured while its telemetry is retained (the
 * forecast-span repair's horizon and roster rules), else tagged.
 * ═════════════════════════════════════════════════════════════════════════ */

/** A hold this long inside the span is refused: the trapezoid (integrateWh above) bridges a gap
 *  of up to an hour between two real readings and drops a longer one. */
export const HELD_LEDGER_MIN_OVERLAP_MS = HOUR_MS;
/** In `score_notes` of a row whose verdict already accounts for held telemetry (lower-cased
 *  match): it makes the repair idempotent. */
export const HELD_TELEMETRY_MARKER = 'telemetry held';

/** A held span as the ledger reads it (heldSamples.ts HeldSpan). */
export interface LedgerHeldSpan { sn: string; startMs: number; endMs: number }

export interface HeldLedgerVerdict {
  /** Home Cores held for HELD_LEDGER_MIN_OVERLAP_MS or more inside the span: no PV actual. */
  pv: Array<{ sn: string; heldMs: number }>;
  /** The house panel held for that long: no load actual. */
  load: Array<{ sn: string; heldMs: number }>;
}

/** Length of the UNION of `sn`'s held spans, clipped to [fromMs, toMs] (a gate span and a moved
 *  stretch can overlap). PURE. */
export function heldMsWithin(spans: ReadonlyArray<LedgerHeldSpan>, sn: string, fromMs: number, toMs: number): number {
  const parts = spans
    .filter((s) => s.sn === sn)
    .map((s) => [Math.max(fromMs, s.startMs), Math.min(toMs, s.endMs)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = 0;
  let curB = Number.NEGATIVE_INFINITY;
  for (const [a, b] of parts) {
    if (a > curB) {
      if (curB > Number.NEGATIVE_INFINITY) total += curB - curA;
      curA = a;
      curB = b;
    } else if (b > curB) {
      curB = b;
    }
  }
  if (curB > Number.NEGATIVE_INFINITY) total += curB - curA;
  return total;
}

/** v1.188.1 — which of a row's PV/load actuals were held, over `span` (the [issue, +24 h] the
 *  actuals are integrated over). Null when neither was. PURE. */
export function heldLedgerVerdict(i: {
  spans: ReadonlyArray<LedgerHeldSpan>;
  coreSns: readonly string[];
  panelSn: string;
  span: TimeSpan;
  minMs?: number;
}): HeldLedgerVerdict | null {
  const min = i.minMs ?? HELD_LEDGER_MIN_OVERLAP_MS;
  const pv: HeldLedgerVerdict['pv'] = [];
  for (const sn of [...i.coreSns].sort()) {
    const heldMs = heldMsWithin(i.spans, sn, i.span.startMs, i.span.endMs);
    if (heldMs >= min) pv.push({ sn, heldMs });
  }
  const load: HeldLedgerVerdict['load'] = [];
  const panelHeld = heldMsWithin(i.spans, i.panelSn, i.span.startMs, i.span.endMs);
  if (panelHeld >= min) load.push({ sn: i.panelSn, heldMs: panelHeld });
  return pv.length === 0 && load.length === 0 ? null : { pv, load };
}

/** v1.188.1 (review 5) — which actuals a held verdict withholds: PV over a held home Core, load
 *  over the held house panel. The scorer withholds each on its own side only (index.ts
 *  scoreNightRow), and the repair compares these with the sides a row's notes state. PURE. */
export interface HeldSides { pv: boolean; load: boolean }
export function heldSides(v: HeldLedgerVerdict | null): HeldSides {
  return { pv: v != null && v.pv.length > 0, load: v != null && v.load.length > 0 };
}

/** v1.188.1 (review 5) — the sides a row's notes already state as held: the parts of every held
 *  clause in them (heldLedgerNote, basisIncompleteNote and heldTagNote all write `telemetry held:
 *  <parts> of the 24 h span`, each part `PV — <device> N h` or `load — <device> N h`). PURE. */
export function heldSidesNoted(notes: string | null | undefined): HeldSides {
  const s = String(notes ?? '');
  const lower = s.toLowerCase();
  const head = `${HELD_TELEMETRY_MARKER}: `;
  const out: HeldSides = { pv: false, load: false };
  for (let i = lower.indexOf(head); i >= 0; i = lower.indexOf(head, i + head.length)) {
    const from = i + head.length;
    const end = s.indexOf(' of the 24 h span', from);
    for (const part of s.slice(from, end < 0 ? undefined : end).split(', ')) {
      if (part.startsWith('PV — ')) out.pv = true;
      if (part.startsWith('load — ')) out.load = true;
    }
  }
  return out;
}

/** Length of a span inside another. PURE. */
const overlapOf = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
/** The verdict with only the sides named. PURE. */
const verdictOf = (v: HeldLedgerVerdict, sides: ReadonlyArray<'PV' | 'load'>): HeldLedgerVerdict =>
  ({ pv: sides.includes('PV') ? v.pv : [], load: sides.includes('load') ? v.load : [] });
const sidesWhere = (pv: boolean, load: boolean): Array<'PV' | 'load'> => [...(pv ? ['PV' as const] : []), ...(load ? ['load' as const] : [])];

const heldParts = (v: HeldLedgerVerdict, name: (sn: string) => string): string => [
  ...v.pv.map((p) => `PV — ${name(p.sn)} ${(p.heldMs / HOUR_MS).toFixed(1)} h`),
  ...v.load.map((p) => `load — ${name(p.sn)} ${(p.heldMs / HOUR_MS).toFixed(1)} h`),
].join(', ');

/** v1.188.1 — the score note of a row not scored for held telemetry. PURE. */
export function heldLedgerNote(v: HeldLedgerVerdict, name: (sn: string) => string): string {
  return `not scored — ${HELD_TELEMETRY_MARKER}: ${heldParts(v, name)} of the 24 h span had no fresh readings `
    + '(the EcoFlow cloud listed the device offline or replayed its last reading); the '
    + `${v.pv.length > 0 && v.load.length > 0 ? 'PV and load actuals are' : v.pv.length > 0 ? 'PV actual is' : 'load actual is'} left empty rather than integrated from held readings.`;
}

/** The scorer's note for a row whose plan basis was incomplete (no trajectory to score). */
export const BASIS_INCOMPLETE_NOTE = 'not scored — plan basis was incomplete (no trajectory to score).';

/**
 * v1.188.1 (review) — the note of a row the scorer leaves unscored because its plan basis was
 * incomplete, with the held verdict when there is one. PURE.
 *
 * The basis reason comes first (the row could not be scored on any telemetry), but its PV/load
 * actuals are still captured, so a hold over its span is stated too, with the marker. Without the
 * marker heldLedgerRepair, whose only idempotence test is the marker, found the re-captured row
 * owing a repair again: every sweep (the 30-min tick, the evening job, the boot warm-up) reset it
 * and the same sweep re-captured it, for the whole 28-day horizon. Incomplete-basis plans and
 * held telemetry coincide by nature: an internet or cloud outage at plan time causes both.
 */
export function basisIncompleteNote(v: HeldLedgerVerdict | null, name: (sn: string) => string): string {
  if (v == null) return BASIS_INCOMPLETE_NOTE;
  return `${BASIS_INCOMPLETE_NOTE} Also ${HELD_TELEMETRY_MARKER}: ${heldParts(v, name)} of the 24 h span had no fresh readings; the `
    + `${v.pv.length > 0 && v.load.length > 0 ? 'PV and load actuals are' : v.pv.length > 0 ? 'PV actual is' : 'load actual is'} left empty rather than integrated from held readings.`;
}

/** v1.188.1 — the clause appended to a row past the re-capture horizon. Carries the marker. PURE.
 *  v1.188.1 (dry run) — it does not say the actuals were integrated from held readings: a hold
 *  can cover hours with no rows at all (a device silent for days, then held), which the actuals
 *  did not integrate, and the raw telemetry to tell the two apart is gone. */
export function heldTagNote(v: HeldLedgerVerdict, name: (sn: string) => string): string {
  return `Telemetry held: ${heldParts(v, name)} of the 24 h span had no fresh readings (held or missing); `
    + 'the raw telemetry is past the re-capture horizon, so the row is kept as captured.';
}

/** v1.188.1 (review 3) — per side, whether a held row (`held_samples`) of a held device lies
 *  inside the span the row was captured over: PV — `pv_total` of a held Core, load — `panel_load`
 *  of the panel (recorder.heldRowsWithin). Absent (or a side absent), the side is taken as having
 *  them: the reading before this check. */
export interface HeldRowsInSpan { pv?: boolean; load?: boolean }

/** v1.188.1 (dry run) — the actuals of a CAPTURED row that were integrated over held telemetry:
 *  an actual is named only when its side was held (PV — a home Core; load — the panel) and it was
 *  captured non-null. A null actual was never integrated, and an unheld side was not held. PURE.
 *  v1.188.1 (review 3) — and only when a held row lies inside its span (`heldRows`): a frozen span
 *  runs from the last change before a silence of more than an hour, so a row whose span overlaps
 *  only that silence (an hour or more of it, no rows at all) is held by the verdict and had
 *  integrated no held reading. */
export function heldIntegratedActuals(
  v: HeldLedgerVerdict,
  captured: { actual_pv_kwh?: number | null; actual_load_kwh?: number | null },
  heldRows: HeldRowsInSpan = {},
): Array<'PV' | 'load'> {
  const out: Array<'PV' | 'load'> = [];
  if (v.pv.length > 0 && captured.actual_pv_kwh != null && heldRows.pv !== false) out.push('PV');
  if (v.load.length > 0 && captured.actual_load_kwh != null && heldRows.load !== false) out.push('load');
  return out;
}

/** v1.188.1 (dry run) — what a held-telemetry reset says about the actuals as captured. PURE.
 *  v1.188.1 (review 3) — an actual captured non-null with no held row inside its span is said to
 *  have been integrated over hours with no readings, not from held readings. */
export function heldCapturedClause(
  v: HeldLedgerVerdict,
  captured: { actual_pv_kwh?: number | null; actual_load_kwh?: number | null },
  heldRows: HeldRowsInSpan = {},
): string {
  const actuals = (xs: string[]) => `${xs.join(' and ')} actual${xs.length > 1 ? 's' : ''}`;
  const named = heldIntegratedActuals(v, captured, heldRows);
  const across: string[] = [];
  if (v.pv.length > 0 && captured.actual_pv_kwh != null && heldRows.pv === false) across.push('PV');
  if (v.load.length > 0 && captured.actual_load_kwh != null && heldRows.load === false) across.push('load');
  const clauses: string[] = [];
  if (named.length > 0) clauses.push(`the ${actuals(named)} had been integrated from held readings`);
  if (across.length > 0) clauses.push(`the ${actuals(across)} had been integrated over hours with no readings at all, and no held reading lay inside ${across.length > 1 ? 'their' : 'its'} span`);
  if (clauses.length > 0) return clauses.join('; ');
  // Nothing integrated: every held side was captured empty.
  const sides = [...(v.pv.length > 0 ? ['PV'] : []), ...(v.load.length > 0 ? ['load'] : [])];
  return `the held ${actuals(sides)} had been captured empty, so nothing had been integrated from held readings`;
}

export interface HeldLedgerRepair {
  action: 'recapture' | 'tag';
  /** The held verdict over the span as captured; (review 5) null when no side is held any more. */
  verdict: HeldLedgerVerdict | null;
  /** v1.188.1 (review 3) — the PV/load span as captured, the one the verdict measured: where the
   *  reset looks for held rows (HeldRowsInSpan). */
  span: TimeSpan;
  /** v1.188.1 (review 5) — the held sides the notes do not state: found after the capture. */
  added: Array<'PV' | 'load'>;
  /** v1.188.1 (review 5) — the sides the notes state as held that no span holds any more: their
   *  span was restored (restoreHeldSamples, or the SQL of architecture 4.4). */
  restored: Array<'PV' | 'load'>;
}

/**
 * v1.188.1 — the repair a CAPTURED row owes for held telemetry, or null. PURE.
 * A row with a stored window whose PV/load span — [issue, min(capture, issue + 24 h)], the
 * span its actuals were integrated over — overlaps a hold (heldLedgerVerdict), and whose notes
 * do not already account for it. Inside the forecast-span repair's horizon, and re-capturable
 * on today's devices (forecastSpanRecapturable), it is re-captured; otherwise tagged.
 * Idempotent: a re-capture writes heldLedgerNote (the marker) and a tag carries it.
 *
 * v1.188.1 (review 5) — per side, not per row: the notes' sides (heldSidesNoted) are compared
 * with the verdict's (heldSides). A side held but not stated (the hourly scan found a replayed
 * Core's rows after the capture, which had stated only the panel) is re-captured, or tagged past
 * the horizon; with one marker for the whole row, its PV actual stayed integrated from the replay.
 * A side stated but no longer held, with a restored span of its devices inside the span
 * (`restored`), is re-captured from the readings moved back, and kept as captured past the
 * horizon; before, the row stayed `not scored — telemetry held` with that actual empty for good.
 * Each side changes at most twice (a span only grows, and a restored span is never held again), so
 * a row is reset at most a few times.
 */
export function heldLedgerRepair(
  row: Pick<NightLedgerRow, 'outcome_captured_at_ms' | 'issued_at_ms' | 'window_start_ms' | 'window_end_ms' | 'score_notes'>
    & Partial<Pick<NightLedgerRow, 'pv_model_sns' | 'delivered_kwh' | 'delivered_basis'>>,
  i: {
    spans: ReadonlyArray<LedgerHeldSpan>; coreSns: readonly string[]; panelSn: string; nowMs: number; horizonMs: number;
    /** v1.188.1 (review 5) — the restored spans over the same days (recorder.restoredHeldSpans). */
    restored?: ReadonlyArray<LedgerHeldSpan>;
  },
): HeldLedgerRepair | null {
  const cap = row.outcome_captured_at_ms;
  const issued = row.issued_at_ms;
  if (typeof cap !== 'number' || typeof issued !== 'number' || !Number.isFinite(issued)) return null;
  const ws = row.window_start_ms;
  const we = row.window_end_ms;
  if (typeof ws !== 'number' || typeof we !== 'number' || !(we > ws)) return null; // no window: nothing was integrated
  const span = { startMs: issued, endMs: Math.min(cap, issued + FORECAST_SPAN_MS) };
  const verdict = heldLedgerVerdict({ spans: i.spans, coreSns: i.coreSns, panelSn: i.panelSn, span });
  const held = heldSides(verdict);
  const noted = heldSidesNoted(row.score_notes);
  const added = sidesWhere(held.pv && !noted.pv, held.load && !noted.load);
  // A side stated but no longer held counts as restored only when a restored span of one of its
  // devices lies in the span: a Core no longer on the panel is not held by today's roster either.
  const restoredIn = (sns: readonly string[]) => (i.restored ?? []).some((r) => sns.includes(r.sn) && overlapOf(r, span) > 0);
  const restored = sidesWhere(noted.pv && !held.pv && restoredIn(i.coreSns), noted.load && !held.load && restoredIn([i.panelSn]));
  if (added.length === 0 && restored.length === 0) return null;
  const inside = i.nowMs - issued <= i.horizonMs && forecastSpanRecapturable(row);
  if (inside) return { action: 'recapture', verdict, span, added, restored };
  // Past the horizon a restored side is kept as captured: there is nothing to re-capture it from.
  return added.length === 0 ? null : { action: 'tag', verdict, span, added, restored: [] };
}

/** v1.188.1 (review 5) — what a repair's reset says about the row as captured: the actuals left
 *  empty for a hold whose span has since been restored, and (heldCapturedClause) the actuals of
 *  the sides found held after the capture. PURE. */
export function heldRepairClause(
  r: HeldLedgerRepair,
  captured: { actual_pv_kwh?: number | null; actual_load_kwh?: number | null },
  heldRows: HeldRowsInSpan = {},
): string {
  const parts: string[] = [];
  if (r.restored.length > 0) {
    parts.push(`the ${r.restored.join(' and ')} actual${r.restored.length > 1 ? 's' : ''} had been left empty for a hold whose readings were since restored to the history`);
  }
  if (r.verdict != null && r.added.length > 0) parts.push(heldCapturedClause(verdictOf(r.verdict, r.added), captured, heldRows));
  return parts.join('; ');
}

/** v1.188.1 (review 5) — the columns the sweep writes for a repair. A tag keeps the notes as
 *  captured and appends the clause for the sides found held (heldTagNote); a re-capture resets the
 *  outcome columns (forecastSpanResetColumns) with a note that says why. PURE. */
export function heldRepairColumns(
  row: { score_notes?: string | null; actual_pv_kwh?: number | null; actual_load_kwh?: number | null },
  r: HeldLedgerRepair,
  name: (sn: string) => string,
  heldRows: HeldRowsInSpan = {},
): Partial<NightLedgerRow> {
  const found = r.verdict != null && r.added.length > 0 ? verdictOf(r.verdict, r.added) : null;
  // A tag, and a reset with no restored side, always have a side found held (heldLedgerRepair).
  if (r.action === 'tag') return { score_notes: `${row.score_notes ?? ''} ${heldTagNote(found!, name)}`.trim() };
  if (r.restored.length === 0) return heldResetColumns(found!, name, row, heldRows);
  return {
    ...forecastSpanResetColumns(0),
    score_notes: `reset — ${heldRepairClause(r, row, heldRows)}${found == null ? '' : ` (${heldParts(found, name)} with no fresh readings, found after it was captured)`}; re-captured by the backfill sweep.`,
  };
}

/** v1.188.1 — the columns a held-telemetry re-capture resets: exactly the forecast-span reset's
 *  columns, with its own note (no marker: the re-capture writes the verdict). PURE.
 *  v1.188.1 (dry run) — the note names only the actuals that were integrated over the hold
 *  (heldIntegratedActuals): the 10-15 row's PV had been captured empty and its load came from
 *  fresh panel rows, and the note said both had been integrated from held readings. */
export function heldResetColumns(
  v: HeldLedgerVerdict,
  name: (sn: string) => string,
  captured: { actual_pv_kwh?: number | null; actual_load_kwh?: number | null },
  heldRows: HeldRowsInSpan = {},
): Partial<NightLedgerRow> {
  return {
    ...forecastSpanResetColumns(0),
    score_notes: `reset — ${heldCapturedClause(v, captured, heldRows)} (${heldParts(v, name)} with no fresh `
      + 'readings, found after it was captured); re-captured by the backfill sweep.',
  };
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
    // v1.191.0 (CA14) — in hundredths of TARIFF_CURRENCY (¢ when unset: the persisted note is unchanged).
    return { cents: p.cents, note: `Cost: ${fmtMinor(p.cents)} of metered import, window open to close + 16 h (energy only; rows do not tile, so not a bill)` };
  }
  if (p.unpriced == null) return { cents: null, note: 'Cost: unmeasured (no grid_home_w samples)' };
  if (p.unpriced.ratesConfirmed === false) {
    // v1.191.0 (CA14) — names the confirmation option in effect (TARIFF_APS_RATES_CONFIRMED while TARIFF_RATES_CONFIRMED is unset).
    return { cents: null, note: `Cost: not priced (tariff rates unconfirmed — ${tariffRatesConfirmation().key})` };
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
export const SOURCE_CHANNEL_SLOTS: readonly number[] = Array.from({ length: SHP2_SOURCE_SLOTS }, (_, i) => i + 1); // v1.191.0 — hwSpec (1, 2, 3)

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

/** v1.187.22 — how far before the window open measuredWindowOpenSocPct looks. The reserve
 *  write fires AT the window open (APPLY_LEAD_MS = 0), so these readings precede any charge. */
export const WINDOW_OPEN_SOC_LEAD_MS = 15 * 60_000;

/**
 * v1.187.22 — PURE. The pool SoC measured as the charge window opened: the MEDIAN of the
 * backup_pct readings in [windowStart − WINDOW_OPEN_SOC_LEAD_MS, windowStart], to 0.1 — a median,
 * so the SHP2's single-sample reconnect 0 cannot stand in for the pool. The ledger had no such
 * figure: on 2026-10-12 the plan sized from 16.9% at the window open and the pool was at ~46%,
 * which only a live read showed. null when no finite reading falls in the lead-in.
 */
export function measuredWindowOpenSocPct(pts: ReadonlyArray<Sample>, windowStartMs: number): number | null {
  const vals = pts
    .filter((p) => p.ts >= windowStartMs - WINDOW_OPEN_SOC_LEAD_MS && p.ts <= windowStartMs && Number.isFinite(p.value))
    .map((p) => p.value)
    .sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return Math.round(median * 10) / 10;
}

/**
 * v1.187.22 — PURE. The score_notes clause that grades a plan's EXPECTED figures: the expected
 * buy against the energy delivered into the Cores (actuated nights), and the expected window-open
 * SoC against the measured one, with the islanded sizing start beside it. '' on a row with no
 * expected figure (written before v1.187.22, or no P50 basis). Notes only: buy_err_kwh, the
 * de-bias learner and the readiness gate read none of it.
 */
export function expectedBuyScoreNote(i: {
  expectedBuyKwh: number | null;
  expectedStartSocPct: number | null;
  /** soc_at_window_start_pct: the islanded worst-case start the buy was sized from. */
  sizingStartSocPct: number | null;
  windowOpenSocPct: number | null;
  actuated: boolean;
  deliveredKwh: number | null;
}): string {
  if (i.expectedBuyKwh == null && i.expectedStartSocPct == null) return '';
  const buy = i.expectedBuyKwh == null ? 'Expected buy: none stated'
    : `Expected buy ~${i.expectedBuyKwh} kWh${!i.actuated ? ' (not actuated — nothing delivered to compare)'
      : i.deliveredKwh == null ? ', delivered unmeasured'
        : `, delivered ${i.deliveredKwh} kWh${i.expectedBuyKwh > 0 ? ` (${round2(i.deliveredKwh / i.expectedBuyKwh)}× expected)` : ''}`}`;
  const start = i.expectedStartSocPct == null ? '' : `; window-open SoC expected ~${i.expectedStartSocPct}%, `
    + `measured ${i.windowOpenSocPct == null ? 'unavailable' : `${i.windowOpenSocPct}%`}`
    + `${i.sizingStartSocPct == null ? '' : ` (the islanded sizing start was ${i.sizingStartSocPct}%)`}`;
  return ` ${buy}${start}.`;
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
