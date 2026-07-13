/**
 * Integrate watt samples into Wh totals over a time range.
 * Uses trapezoidal integration between consecutive samples; values outside
 * the requested window are clipped at the boundary using the nearest sample.
 */

import { Recorder } from './recorder.js';
import { SnapshotStore } from './snapshot.js';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership.js';

export interface EnergyTotals {
  sn: string;
  deviceName: string;
  productName: string;
  metrics: Record<string, IntegrationResult>;
}

export interface FleetEnergyTotals {
  sinceMs: number;
  untilMs: number;
  devices: EnergyTotals[];
  fleet: {
    pvWh: number;
    acOutWh: number;
    panelLoadWh: number;
    batteryNetWh: number; // positive = net discharged
    coverage: number;     // 0..1 fraction of window covered (averaged across active metrics)
    pvCoverage: number;   // 0..1 fraction of window covered, PV metric (`pv_total`) ONLY — for the Solar-page "% measured" tile
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

export function startOfLocalDayMs(d: Date = new Date()): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
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

const localDateStr = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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
  const ONE_DAY = 86_400_000;
  const seriesMetric = metric ?? `ch${ch}_w`;

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = todayStart - i * ONE_DAY;
    const dayEndFull = dayStart + ONE_DAY;
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

export function computeTotals(
  store: SnapshotStore,
  recorder: Recorder,
  sinceMs: number,
  untilMs: number,
): FleetEnergyTotals {
  const snap = store.get();
  const devices: EnergyTotals[] = [];
  const fleet = { pvWh: 0, acOutWh: 0, panelLoadWh: 0, batteryNetWh: 0, coverage: 0, pvCoverage: 0 };
  const coverageAccum: number[] = [];
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
  const connected = shp2ConnectedDpuSns(snap.devices);

  for (const d of Object.values(snap.devices)) {
    const p = d.projection;
    if (!p) continue;
    const metrics: Record<string, IntegrationResult> = {};

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
      return r.wh;
    };

    if (p.kind === 'dpu') {
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
      for (const pk of p.packs) {
        packChargeWh += ingest(`pack${pk.num}_in`);
        packDischargeWh += ingest(`pack${pk.num}_out`);
      }
      // Only home-connected DPUs contribute to the fleet rollup.
      if (isShp2Connected(d.sn, connected)) {
        fleet.pvWh += pvWh;
        fleet.acOutWh += acOutWh;
        fleet.batteryNetWh += packDischargeWh - packChargeWh;
        // v0.44.0 — PV coverage tracks the SAME membership as fleet.pvWh: only
        // SHP2-connected DPUs. A bench spare (no array, possibly 0 pv_total
        // samples) must not dilute the Solar "% measured" tile that annotates
        // the connected-only PV energy.
        const pvR = metrics['pv_total'];
        if (pvR && pvR.totalMs > 0) pvCoverageAccum.push(pvR.coverageMs / pvR.totalMs);
      }
    } else if (p.kind === 'shp2') {
      fleet.panelLoadWh += ingest('panel_load');
    } else {
      ingest('out_watts');
      ingest('in_watts');
      ingest('pv_watts');
    }

    devices.push({
      sn: d.sn,
      deviceName: d.deviceName,
      productName: d.productName,
      metrics,
    });
  }

  fleet.coverage = coverageAccum.length === 0 ? 0 : coverageAccum.reduce((s, v) => s + v, 0) / coverageAccum.length;
  // No PV metric / no expected PV samples → fall back to the all-metric coverage
  // (itself 0 in the fully-degenerate empty-window case) rather than emitting NaN.
  fleet.pvCoverage = pvCoverageAccum.length === 0
    ? fleet.coverage
    : pvCoverageAccum.reduce((s, v) => s + v, 0) / pvCoverageAccum.length;
  return { sinceMs, untilMs, devices, fleet };
}
