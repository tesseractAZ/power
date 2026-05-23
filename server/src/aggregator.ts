/**
 * Integrate watt samples into Wh totals over a time range.
 * Uses trapezoidal integration between consecutive samples; values outside
 * the requested window are clipped at the boundary using the nearest sample.
 */

import { Recorder } from './recorder.js';
import { SnapshotStore } from './snapshot.js';

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
      fleet.pvWh += ingest('pv_total');
      fleet.acOutWh += ingest('ac_out');
      ingest('total_in');
      ingest('total_out');
      const totalOut = metrics['total_out']?.wh ?? 0;
      const totalIn = metrics['total_in']?.wh ?? 0;
      fleet.batteryNetWh += totalOut - totalIn;
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
