/**
 * Integrate watt samples into Wh totals over a time range.
 * Uses trapezoidal integration between consecutive samples; values outside
 * the requested window are clipped at the boundary using the nearest sample.
 */

import { Recorder } from './recorder.js';
import type { BridgeLedger } from './energyBridge.js';
import { SnapshotStore } from './snapshot.js';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership.js';
import { siteDayStartOf, siteShiftDaysMs, siteYmd } from './siteTime.js';

export interface EnergyTotals {
  sn: string;
  deviceName: string;
  productName: string;
  metrics: Record<string, IntegrationResult>;
}

export interface FleetEnergyTotals {
  sinceMs: number;
  untilMs: number;
  /**
   * v1.103.0 — the SHP2 pool membership this rollup was computed against,
   * resolved from the LIVE snapshot and applied across the whole window.
   *
   * Declared rather than assumed: for a window that spans a reconfiguration
   * this basis is wrong, and the roster for a past window cannot be
   * reconstructed (nothing recorded it before v1.103.0). Consumers that need a
   * trustworthy per-window figure — notably the pack-DC RTE — check
   * `membershipHistory.membershipVerdict` and refuse anything not `stable`.
   */
  membershipBasis: string;
  devices: EnergyTotals[];
  fleet: {
    pvWh: number;
    acOutWh: number;
    panelLoadWh: number;
    batteryNetWh: number; // positive = net discharged
    /** v1.89.0 — GROSS pack-side flows (SHP2-connected DPUs, per-pack in/out
     *  integrals). dischargeWh/chargeWh is the pack-DC round-trip ratio — NOT
     *  the AC dispatch RTE (conversion losses excluded on both legs). */
    batteryChargeWh: number;
    batteryDischargeWh: number;
    coverage: number;     // 0..1 fraction of window covered (averaged across active metrics)
    pvCoverage: number;   // 0..1 fraction of window covered, PV metric (`pv_total`) ONLY — for the Solar-page "% measured" tile
    /** v1.182.0 — 0..1, the devices behind the Today figures ONLY — home Cores (SHP2-connected,
     *  a dark one counting 0) and the panel — averaged PER DEVICE (each its own series' mean), so
     *  a dark Core weighs as one of the home's devices rather than one series against ~14.
     *  `coverage` averages every series on every device — bench Cores were 38% of them — so the
     *  Today card read "100% measured". */
    homeCoverage: number;
    /** v1.182.0 — 0..1 coverage of the panels' `panel_load` (the lowest across panels); null with
     *  no panel. At 0 the Today card's Panel load tile reads "not measured" instead of 0 Wh. */
    panelLoadCoverage: number | null;
    /** v1.190.2 — with TotalsOptions.bridged, when the energy bridge metered a home Core in the
     *  window: its booked share, already included in pvWh / acOutWh / batteryNetWh and the two gross
     *  flows (which then carry that AC-basis share beside the pack-DC one), and folded into
     *  pvCoverage / homeCoverage (the slot meter's coverage of the spans it metered). Absent
     *  otherwise, so the payload is the one it was before v1.190.2. */
    bridged?: BridgedTotals;
  };
}

/**
 * Trapezoidal integration with gap awareness.
 * Skips integration across gaps larger than maxGapMs (default 10 min) — the recorder
 * heartbeats every 5 min, so anything > 10 min implies we lost coverage and shouldn't
 * extrapolate. Also returns coverage stats so callers can show "X% measured".
 */
export interface IntegrationResult {
  wh: number;
  coverageMs: number;     // total ms of window where we integrated
  totalMs: number;        // (untilMs - sinceMs)
  gapMs: number;          // total ms skipped due to gaps
  samples: number;        // sample points used
}

/** v1.14.0 (review F9 sibling) — fetch lower-bound widening so integrateWh
 *  receives the pre-window boundary sample and its (real-gap-conditioned)
 *  head-hold can recover the head segment. == integrateWh's default maxGapMs. */
export const INTEGRATE_HEAD_LOOKBACK_MS = 10 * 60 * 1000;

export function integrateWh(
  points: Array<{ ts: number; value: number }>,
  sinceMs: number,
  untilMs: number,
  maxGapMs = 10 * 60 * 1000,
): IntegrationResult {
  const totalMs = Math.max(0, untilMs - sinceMs);
  if (points.length === 0) return { wh: 0, coverageMs: 0, totalMs, gapMs: totalMs, samples: 0 };

  // Clip points to window. Include one sample just before sinceMs if it's within maxGapMs
  // so we have a starting value (effectively assuming the value held until sinceMs).
  const inWindow = points.filter((p) => p.ts >= sinceMs && p.ts <= untilMs);
  const lastBefore = points.filter((p) => p.ts < sinceMs).pop();
  const series: Array<{ ts: number; value: number }> = [];
  // v1.14.0 (review of F9) — the head-hold must be conditioned on the REAL
  // inter-sample gap (first in-window sample − boundary sample), not on the
  // distance to the window edge. The old `sinceMs - lastBefore.ts <= maxGapMs`
  // check let a caller whose window boundaries chop a real >maxGap coverage loss
  // into <=maxGap pieces (the 5-min lifetime-rollup watermark does exactly this)
  // integrate ENTIRE windows at held power during a telemetry stall: with no
  // in-window samples the head-hold + tail-hold synthesized both endpoints and
  // the per-segment gap check below never saw the true gap — fabricating
  // ~10 min × last-known W into total_increasing counters per stall, and
  // bridging >maxGap gaps that straddle a window boundary. Requiring a real
  // in-window sample within maxGap of the boundary restores the documented
  // contract exactly: an empty window contributes 0 (as it did before the
  // boundary sample was fetched at all), and a real gap > maxGap is never
  // extrapolated no matter where a window boundary lands inside it. When the
  // condition holds, `sinceMs - lastBefore.ts <= maxGapMs` is implied.
  if (lastBefore && inWindow.length > 0 && inWindow[0].ts - lastBefore.ts <= maxGapMs) {
    series.push({ ts: sinceMs, value: lastBefore.value });
  }
  for (const p of inWindow) series.push(p);
  // Hold the last value to untilMs only if it's recent enough.
  if (series.length > 0) {
    const tail = series[series.length - 1];
    if (untilMs - tail.ts <= maxGapMs) {
      series.push({ ts: untilMs, value: tail.value });
    }
  }

  let wh = 0;
  let coverageMs = 0;
  for (let i = 1; i < series.length; i++) {
    const dtMs = series[i].ts - series[i - 1].ts;
    if (dtMs <= 0 || dtMs > maxGapMs) continue; // gap → skip
    const avg = (series[i].value + series[i - 1].value) / 2;
    wh += (avg * dtMs) / 3_600_000;
    coverageMs += dtMs;
  }
  return {
    wh,
    coverageMs,
    totalMs,
    gapMs: Math.max(0, totalMs - coverageMs),
    samples: inWindow.length,
  };
}

/**
 * v1.191.3 — integrateWh over many windows of ONE series, each window handed only the points
 * integrateWh reads: the last sample before `sinceMs` and every sample in [sinceMs, untilMs]. On a
 * series sorted by ts those are one contiguous run (from the first ts >= sinceMs, less one, to the
 * last ts <= untilMs), found by binary search, so each call is identical to
 * integrateWh(points, sinceMs, untilMs) on the whole series without filtering it twice.
 * computeTariffReport prices a week hour by hour, 168 windows a tally over each 7-day series.
 *
 * Any other series (out of order, or a NaN or non-numeric ts, for which every comparison is false)
 * is integrated whole, so the result is identical for every input. The recorder's reads come back
 * ORDER BY ts (bucket_ts) ascending, so production takes the sliced path.
 */
export function windowIntegrator(
  points: Array<{ ts: number; value: number }>,
): (sinceMs: number, untilMs: number) => IntegrationResult {
  for (let i = 1; i < points.length; i++) {
    if (!(points[i].ts >= points[i - 1].ts)) return (sinceMs, untilMs) => integrateWh(points, sinceMs, untilMs);
  }
  const firstAtOrAfter = (x: number): number => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (points[m].ts < x) lo = m + 1; else hi = m; }
    return lo;
  };
  const firstAfter = (x: number): number => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (points[m].ts <= x) lo = m + 1; else hi = m; }
    return lo;
  };
  return (sinceMs, untilMs) =>
    integrateWh(points.slice(Math.max(0, firstAtOrAfter(sinceMs) - 1), firstAfter(untilMs)), sinceMs, untilMs);
}

/** The start of the local day containing `d`. v1.191.0 (lane A, T15) — the SITE day (siteTime.ts),
 *  not the host's `setHours(0, 0, 0, 0)`: every "today" the totals, the Today card and the reports
 *  compute now shares one clock with the tariff. Identical on a host whose zone is the site zone. */
export function startOfLocalDayMs(d: Date = new Date()): number {
  return siteDayStartOf(d.getTime());
}

/* ─── Per-circuit kWh history ──────────────────────────────────────────── */

export interface CircuitDayTotal {
  /** Local YYYY-MM-DD (avoid UTC-shift surprises). */
  date: string;
  dayStartMs: number;
  /** Next local midnight, or `now` for the in-progress day. */
  dayEndMs: number;
  isToday: boolean;
  kwh: number;
  peakW: number;
  /** epoch ms of the peak, or null if no samples. */
  peakAtMs: number | null;
  /** ms of the day where we actually had data (vs gap). */
  coverageMs: number;
}

export interface CircuitHistory {
  sn: string;
  ch: number;
  days: CircuitDayTotal[]; // oldest → newest
  summary: {
    daysWithData: number;
    totalKwh: number;
    avgKwh: number;
    peakDay: CircuitDayTotal | null;
    minDay: CircuitDayTotal | null;
  };
}

const localDateStr = (ms: number): string => siteYmd(ms);

/**
 * Per-day kWh totals (trapezoidal, gap-aware) for one SHP2 circuit over the
 * last `days` calendar days, including the in-progress today as a partial /
 * running-total entry. Capped server-side; callers in `index.ts` clamp `days`.
 *
 * v0.9.8 — accepts an optional `metric` override so paired (split-phase)
 * circuits can integrate the combined `pair${primaryCh}_w` series instead
 * of just one leg's `ch${ch}_w`. The `ch` field in the response is still
 * the primary leg for stable URL semantics.
 */
export function circuitHistoryByDay(
  recorder: Recorder,
  sn: string,
  ch: number,
  days: number,
  metric?: string,
): CircuitHistory {
  const out: CircuitDayTotal[] = [];
  const now = Date.now();
  const todayStart = startOfLocalDayMs();
  const seriesMetric = metric ?? `ch${ch}_w`;

  for (let i = days - 1; i >= 0; i--) {
    // CA26 — calendar days in the site zone (a DST day is 23 or 25 h long).
    const dayStart = siteShiftDaysMs(todayStart, -i);
    const dayEndFull = siteShiftDaysMs(dayStart, 1);
    const dayEnd = i === 0 ? now : dayEndFull;
    // v1.14.0 (F9 sibling) — include the pre-window boundary sample so the day's
    // head segment isn't dropped (integrateWh clips to [dayStart, dayEnd]).
    const pts = recorder.query(sn, seriesMetric, dayStart - INTEGRATE_HEAD_LOOKBACK_MS, dayEnd);
    const integ = integrateWh(pts, dayStart, dayEnd);
    let peakW = 0;
    let peakAtMs: number | null = null;
    for (const p of pts) {
      if (p.ts < dayStart) continue; // pre-window boundary sample belongs to yesterday's peak
      if (p.value > peakW) {
        peakW = p.value;
        peakAtMs = p.ts;
      }
    }
    out.push({
      date: localDateStr(dayStart),
      dayStartMs: dayStart,
      dayEndMs: dayEnd,
      isToday: i === 0,
      kwh: Math.round((integ.wh / 1000) * 1000) / 1000,
      peakW: Math.round(peakW),
      peakAtMs,
      coverageMs: integ.coverageMs,
    });
  }

  const withData = out.filter((d) => d.coverageMs > 0);
  const peakDay = withData.reduce<CircuitDayTotal | null>(
    (b, d) => (b == null || d.kwh > b.kwh ? d : b),
    null,
  );
  const minDay = withData.reduce<CircuitDayTotal | null>(
    (b, d) => (b == null || d.kwh < b.kwh ? d : b),
    null,
  );
  const totalKwh = withData.reduce((s, d) => s + d.kwh, 0);

  return {
    sn,
    ch,
    days: out,
    summary: {
      daysWithData: withData.length,
      totalKwh: Math.round(totalKwh * 1000) / 1000,
      avgKwh:
        withData.length === 0
          ? 0
          : Math.round((totalKwh / withData.length) * 1000) / 1000,
      peakDay,
      minDay,
    },
  };
}

/** v1.190.2 — options of computeTotals. */
export interface TotalsOptions {
  /**
   * The home's figures as the lifetime counters book them (the Today card, the Solar tab's Today
   * tile: /api/summary/today). Each Core the energy bridge metered at its panel slot during the
   * window (Recorder.bridgeLedger) counts the energy the bridge booked for those windows — Solar, AC
   * output, battery in / out — in place of its own samples there, which the recorder does not write
   * while the Core is dark; outside them its own samples count, as the lifetime rollup counts them
   * (the bridge's windows are its hand-off instants, so no span is counted twice). A connected home
   * Core with no projection keeps its recorded series (buildContributors does the same). Without it —
   * the vendor-ledger comparison and the pack-DC round trip (energy-history), the reconnect report's
   * PV coverage — the totals are the Cores' own meters only, exactly as before v1.190.2.
   */
  bridged?: boolean;
}

/** v1.190.2 — the energy bridge's share of a window's figures (computeTotals with `bridged`),
 *  present only when the bridge metered a Core in the window. */
export interface BridgedTotals {
  /** Booked in the window, Wh: a bridge window counts at its rollup instant (its end), the instant
   *  the lifetime counters stepped by it — one that straddles the window's start counts whole, one
   *  still open at its end not yet. Already included in the fleet figures. */
  pvWh: number;
  /** The slots' AC output (∫ max(0, −chW)). */
  acOutWh: number;
  /** The slots' AC input (∫ max(0, chW)): fleet_grid_import_wh's bridged share. */
  acInWh: number;
  chargeWh: number;
  dischargeWh: number;
  /** The share of pvWh booked on the inferred basis: a lower bound (energyBridge.ts). */
  pvInferredWh: number;
  /** The bridge's windows booked in the window, by basis ('unbridgeable': metered at the slot,
   *  nothing booked — the Core's own samples are left out there all the same). */
  windows: { night: number; measured: number; inferred: number; unbridgeable: number };
  /** The Cores the bridge metered, sorted. */
  cores: string[];
}

/** v1.190.2 — integrateWh over [sinceMs, untilMs] outside `cut` (sorted, disjoint spans inside the
 *  window): a Core's own samples where the energy bridge did not meter it. Each piece is integrated
 *  under integrateWh's own rules (its head and tail holds, its 10-min gap). */
export function integrateWhOutside(
  points: Array<{ ts: number; value: number }>,
  sinceMs: number,
  untilMs: number,
  cut: ReadonlyArray<readonly [number, number]>,
): { wh: number; coverageMs: number } {
  let wh = 0;
  let coverageMs = 0;
  let a = sinceMs;
  const piece = (b: number): void => {
    if (b <= a) return;
    const r = integrateWh(points, a, b);
    wh += r.wh;
    coverageMs += r.coverageMs;
  };
  for (const [s, e] of cut) {
    if (a >= untilMs) break;
    piece(Math.min(s, untilMs));
    a = Math.max(a, e);
  }
  piece(untilMs);
  return { wh, coverageMs };
}

/** v1.190.2 — what the energy bridge's ledger says about [sinceMs, untilMs]. */
export interface BridgedView {
  /** Per Core, the spans the bridge metered it (its windows clipped to the window, merged; sorted). */
  cuts: Map<string, Array<[number, number]>>;
  /** Per Core, the slot meter's coverage of those spans, ms (each window's share by overlap). */
  coveredMs: Map<string, number>;
  totals: BridgedTotals;
}

/**
 * v1.190.2 — the bridge's windows of [sinceMs, untilMs] (Recorder.bridgeLedger), per Core: the spans
 * to take its own samples out of, the slot meter's coverage there, and the energy booked. A Core
 * whose last window ends at the bridge's watermark is still metered (the next rollup books the span
 * since; the lifetime read path cuts its own readings at once too): its span runs on to untilMs.
 * null when no window falls in the range.
 */
export function bridgedView(ledger: BridgeLedger, sinceMs: number, untilMs: number): BridgedView | null {
  const rows = ledger.rows.filter((r) => r.untilMs > r.sinceMs && r.untilMs > sinceMs && r.sinceMs < untilMs);
  if (rows.length === 0) return null;
  const totals: BridgedTotals = {
    pvWh: 0, acOutWh: 0, acInWh: 0, chargeWh: 0, dischargeWh: 0, pvInferredWh: 0,
    windows: { night: 0, measured: 0, inferred: 0, unbridgeable: 0 }, cores: [],
  };
  const spans = new Map<string, Array<[number, number]>>();
  const coveredMs = new Map<string, number>();
  const lastEnd = new Map<string, number>();
  for (const r of rows) {
    const s = Math.max(r.sinceMs, sinceMs);
    const e = Math.min(r.untilMs, untilMs);
    const list = spans.get(r.sn) ?? [];
    list.push([s, e]);
    spans.set(r.sn, list);
    lastEnd.set(r.sn, Math.max(lastEnd.get(r.sn) ?? -Infinity, r.untilMs));
    coveredMs.set(r.sn, (coveredMs.get(r.sn) ?? 0) + Math.max(0, r.coveredMs) * ((e - s) / (r.untilMs - r.sinceMs)));
    if (r.untilMs > untilMs) continue; // booked after the window's end
    totals.pvWh += r.pvWh;
    totals.acOutWh += r.acOutWh;
    totals.acInWh += r.acInWh;
    totals.chargeWh += r.chargeWh;
    totals.dischargeWh += r.dischargeWh;
    if (r.basis === 'inferred') totals.pvInferredWh += r.pvWh;
    const b = r.basis === 'night' || r.basis === 'measured' || r.basis === 'inferred' ? r.basis : 'unbridgeable';
    totals.windows[b] += 1;
  }
  const cuts = new Map<string, Array<[number, number]>>();
  for (const [sn, list] of spans) {
    const end = lastEnd.get(sn) as number;
    if (ledger.watermarkMs > 0 && end === ledger.watermarkMs && untilMs > end) list.push([Math.max(end, sinceMs), untilMs]);
    list.sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of list) {
      const prev = merged[merged.length - 1];
      if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
      else merged.push([s, e]);
    }
    cuts.set(sn, merged);
  }
  totals.cores = [...cuts.keys()].sort();
  return { cuts, coveredMs, totals };
}

/** The pack numbers a Core with no projection recorded power for in the window (pack<N>_in / _out,
 *  N = 1..15 as the recorder's capacity read probes them). */
function recordedPackNums(recorder: Recorder, sn: string, fromMs: number, untilMs: number): number[] {
  const out: number[] = [];
  const has = (metric: string): boolean =>
    (recorder.queryFirstLast ? recorder.queryFirstLast(sn, metric, fromMs, untilMs) : recorder.query(sn, metric, fromMs, untilMs)).length > 0;
  for (let k = 1; k <= 15; k++) if (has(`pack${k}_in`) || has(`pack${k}_out`)) out.push(k);
  return out;
}

export function computeTotals(
  store: SnapshotStore,
  recorder: Recorder,
  sinceMs: number,
  untilMs: number,
  opts: TotalsOptions = {},
): FleetEnergyTotals {
  const snap = store.get();
  const devices: EnergyTotals[] = [];
  const fleet: FleetEnergyTotals['fleet'] = { pvWh: 0, acOutWh: 0, panelLoadWh: 0, batteryNetWh: 0, batteryChargeWh: 0, batteryDischargeWh: 0, coverage: 0, pvCoverage: 0, homeCoverage: 0, panelLoadCoverage: null as number | null };
  const coverageAccum: number[] = [];
  const homeCoverageAccum: number[] = []; // v1.182.0
  // v0.44.0 — PV-only coverage for the Solar-page "% measured" tile. The fleet
  // PV rollup is keyed on the per-DPU `pv_total` series of SHP2-CONNECTED DPUs
  // only (see the isShp2Connected block below), so this accumulates pv_total
  // coverage under that same membership — NOT grid/load/battery/temps (which
  // would dilute a PV-specific number), and NOT bench spares (no array).
  const pvCoverageAccum: number[] = [];

  // v0.9.76 — only SHP2-connected DPUs contribute to fleet.pvWh /
  // .acOutWh / .batteryNetWh, matching the /api/ha-state + MQTT
  // Discovery filter. Spare cores' samples are still recorded into
  // `devices[]` for per-device diagnostics but skipped from the fleet
  // rollup — mirrors v0.9.74's recorder.ts contributor filter so
  // `/api/summary/today` (which powers the HA Today card) agrees with
  // the lifetime counters.
  // v1.103.0 — membership is resolved ONCE from the LIVE snapshot and then
  // applied across [sinceMs, untilMs]. That is correct for a window inside a
  // single membership and WRONG for one that spans a reconfiguration: the 08-20
  // swap made this attribute one fleet's energy under another's roster. The
  // roster itself cannot be reconstructed for a past window — nothing recorded
  // it before v1.103.0 — so rather than pretend, the result now DECLARES what
  // basis it used, and callers that care (the pack-DC RTE) refuse the day.
  const connected = shp2ConnectedDpuSns(snap.devices);
  // v1.87.0 — SNs that actually entered the PV accumulation. A CONNECTED but
  // PROJECTION-LESS Core (Core 2 through its 2026-08 cloud outage) was skipped
  // by the `!p` guard below before ever reaching pvCoverageAccum, so the Solar
  // "% measured" tile read 100% while the vendor ledger proved ~20 kWh/day
  // (~1/3 of plant PV) invisible. Honest coverage counts that member as ZERO.
  const pvAccumulatedSns = new Set<string>();
  // v1.190.2 — the energy bridge's windows in the range (TotalsOptions.bridged): per Core, the spans
  // it was metered at its slot (its own samples are left out there) and the energy booked for them.
  const bridged = opts.bridged === true ? bridgedView(recorder.bridgeLedger(sinceMs, untilMs), sinceMs, untilMs) : null;

  for (const d of Object.values(snap.devices)) {
    const p = d.projection;
    // v1.190.2 — with `bridged`, a connected home Core with no projection (dark since a restart: no
    // quota is fetched for a device listed offline) keeps its recorded series, as the lifetime
    // rollup counts them (recorder buildContributors), up to the bridge's spans.
    const unprojectedHome = opts.bridged === true && !p && connected.has(d.sn);
    if (!p && !unprojectedHome) continue;
    const metrics: Record<string, IntegrationResult> = {};
    /** v1.190.2 — the spans the energy bridge metered this Core (none: it counts whole). */
    const cut = bridged?.cuts.get(d.sn);
    /** v1.190.2 — per metric, the own samples' coverage outside `cut`, ms. */
    const ownCoverageMs: Record<string, number> = {};

    const ingest = (metric: string) => {
      // v1.14.0 (F9 sibling) — widen the fetch so the head segment is recovered;
      // integrateWh still integrates only [sinceMs, untilMs].
      const pts = recorder.query(d.sn, metric, sinceMs - INTEGRATE_HEAD_LOOKBACK_MS, untilMs);
      const r = integrateWh(pts, sinceMs, untilMs);
      metrics[metric] = r;
      if (r.totalMs > 0) {
        coverageAccum.push(r.coverageMs / r.totalMs);
        // NOTE: PV coverage is NOT accumulated here — it's gated on SHP2
        // membership below (mirroring fleet.pvWh), so a bench spare's pv_total
        // can't dilute the Solar "% measured" tile.
      }
      if (!cut) return r.wh;
      // v1.190.2 — the fleet figures take this Core's own samples only where the bridge did not
      // meter it; the per-device metrics above stay the whole window's.
      const own = integrateWhOutside(pts, sinceMs, untilMs, cut);
      ownCoverageMs[metric] = own.coverageMs;
      return own.wh;
    };
    /** v1.190.2 — a home device's coverage of one metric: its own samples, plus the slot meter's
     *  coverage of the spans the bridge metered it. */
    const homeCoverageOf = (metric: string, r: IntegrationResult): number =>
      cut ? Math.min(1, ((ownCoverageMs[metric] ?? 0) + (bridged?.coveredMs.get(d.sn) ?? 0)) / r.totalMs) : r.coverageMs / r.totalMs;

    if (unprojectedHome || p?.kind === 'dpu') {
      // Always populate per-device metrics (used by the per-device list).
      const pvWh = ingest('pv_total');
      const acOutWh = ingest('ac_out');
      ingest('total_in');
      ingest('total_out');
      // v0.10.4 — battery net from PER-PACK in/out (true battery flow), not
      // total_in/out (= DPU throughput = PV+grid in / AC out). The latter
      // overstated the home battery net ~1.7× on the "Today" card and made it
      // disagree with the live per-pack sensor. Pack in=charge, out=discharge.
      let packChargeWh = 0, packDischargeWh = 0;
      const packNums = p?.kind === 'dpu' ? p.packs.map((pk) => pk.num) : recordedPackNums(recorder, d.sn, sinceMs - INTEGRATE_HEAD_LOOKBACK_MS, untilMs);
      for (const num of packNums) {
        packChargeWh += ingest(`pack${num}_in`);
        packDischargeWh += ingest(`pack${num}_out`);
      }
      // Only home-connected DPUs contribute to the fleet rollup.
      if (isShp2Connected(d.sn, connected)) {
        fleet.pvWh += pvWh;
        fleet.acOutWh += acOutWh;
        fleet.batteryNetWh += packDischargeWh - packChargeWh;
        fleet.batteryChargeWh += packChargeWh;       // v1.89.0
        fleet.batteryDischargeWh += packDischargeWh; // v1.89.0
        // v0.44.0 — PV coverage tracks the SAME membership as fleet.pvWh: only
        // SHP2-connected DPUs. A bench spare (no array, possibly 0 pv_total
        // samples) must not dilute the Solar "% measured" tile that annotates
        // the connected-only PV energy.
        const pvR = metrics['pv_total'];
        if (pvR && pvR.totalMs > 0) pvCoverageAccum.push(homeCoverageOf('pv_total', pvR));
        pvAccumulatedSns.add(d.sn); // v1.87.0 — membership actually measured
      }
    } else if (p?.kind === 'shp2') {
      fleet.panelLoadWh += ingest('panel_load');
      const pl = metrics['panel_load'];
      const plCov = pl && pl.totalMs > 0 ? pl.coverageMs / pl.totalMs : 0; // v1.182.0
      fleet.panelLoadCoverage = fleet.panelLoadCoverage == null ? plCov : Math.min(fleet.panelLoadCoverage, plCov);
    } else {
      ingest('out_watts');
      ingest('in_watts');
      ingest('pv_watts');
    }

    // v1.182.0 — home coverage: only the devices behind the Today figures.
    if (p?.kind === 'shp2' || ((unprojectedHome || p?.kind === 'dpu') && isShp2Connected(d.sn, connected))) {
      const own = Object.entries(metrics).filter(([, r]) => r.totalMs > 0).map(([m, r]) => homeCoverageOf(m, r));
      if (own.length > 0) homeCoverageAccum.push(own.reduce((s, v) => s + v, 0) / own.length); // one value per device
    }
    devices.push({
      sn: d.sn,
      deviceName: d.deviceName,
      productName: d.productName,
      metrics,
    });
  }

  // v1.87.0 — every SHP2-connected DPU that never entered the PV accumulation

  // (cloud-dark: no projection, or zero recorded samples) is UNMEASURED

  // CAPACITY, not a non-member. Count it as zero coverage — with one of

  // three home Cores dark, the honest tile reads ~67%, not 100%.

  for (const sn of connected) {

    if (!pvAccumulatedSns.has(sn)) {

      pvCoverageAccum.push(0);
      homeCoverageAccum.push(0); // v1.182.0 — a dark home Core is unmeasured home capacity

      coverageAccum.push(0);

    }

  }
  // v1.190.2 — the bridged dark Cores' booked share (TotalsOptions.bridged), on the AC basis at the
  // slot, as the lifetime counters add it (fleet_pv_wh; battery in / out on top of the BMS floors).
  if (bridged) {
    const b = bridged.totals;
    fleet.pvWh += b.pvWh;
    fleet.acOutWh += b.acOutWh;
    fleet.batteryNetWh += b.dischargeWh - b.chargeWh;
    fleet.batteryChargeWh += b.chargeWh;
    fleet.batteryDischargeWh += b.dischargeWh;
  }
  fleet.coverage = coverageAccum.length === 0 ? 0 : coverageAccum.reduce((s, v) => s + v, 0) / coverageAccum.length;
  // No PV metric / no expected PV samples → fall back to the all-metric coverage
  // (itself 0 in the fully-degenerate empty-window case) rather than emitting NaN.
  fleet.pvCoverage = pvCoverageAccum.length === 0
    ? fleet.coverage
    : pvCoverageAccum.reduce((s, v) => s + v, 0) / pvCoverageAccum.length;
  fleet.homeCoverage = homeCoverageAccum.length === 0 ? 0 : homeCoverageAccum.reduce((s, v) => s + v, 0) / homeCoverageAccum.length;
  if (bridged) fleet.bridged = bridged.totals;
  return { sinceMs, untilMs, membershipBasis: [...connected].sort().join(','), devices, fleet };
}
