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
  if (lastBefore && sinceMs - lastBefore.ts <= maxGapMs) {
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
    const pts = recorder.query(sn, seriesMetric, dayStart, dayEnd);
    const integ = integrateWh(pts, dayStart, dayEnd);
    let peakW = 0;
    let peakAtMs: number | null = null;
    for (const p of pts) {
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
  const fleet = { pvWh: 0, acOutWh: 0, panelLoadWh: 0, batteryNetWh: 0, coverage: 0 };
  const coverageAccum: number[] = [];

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
      const pts = recorder.query(d.sn, metric, sinceMs, untilMs);
      const r = integrateWh(pts, sinceMs, untilMs);
      metrics[metric] = r;
      if (r.totalMs > 0) coverageAccum.push(r.coverageMs / r.totalMs);
      return r.wh;
    };

    if (p.kind === 'dpu') {
      // Always populate per-device metrics (used by the per-device list).
      const pvWh = ingest('pv_total');
      const acOutWh = ingest('ac_out');
      ingest('total_in');
      ingest('total_out');
      const totalOut = metrics['total_out']?.wh ?? 0;
      const totalIn = metrics['total_in']?.wh ?? 0;
      // Only home-connected DPUs contribute to the fleet rollup.
      if (isShp2Connected(d.sn, connected)) {
        fleet.pvWh += pvWh;
        fleet.acOutWh += acOutWh;
        fleet.batteryNetWh += totalOut - totalIn;
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
  return { sinceMs, untilMs, devices, fleet };
}
