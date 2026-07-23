/**
 * TRD screen — trend strips for the headline tags.
 *
 * Each tag gets a row: tag name, latest value, then a braille sparkline
 * spanning every remaining column (2 samples per cell × 4 vertical levels —
 * see gauges.ts) built from the last hour of recorder samples (one bucket
 * per minute). Designed to look like the strip-recorder chart on an old
 * SCADA HMI.
 */

import { c, padEnd, padStart, truncate, BOX } from '../ansi.js';
import { divider, stateGlyph } from './scada.js';
// v1.38.0 — full-width braille sparklines replace the fixed-width block-glyph
// mini strips. braille() output is plain (no ANSI); colorized whole below.
import { braille } from '../gauges.js';
import {
  getDpus, getShp2, fmtW, fmtPct, fmtVolt,
  socState, deviceQuality, sum, generatorNumber,
} from './data.js';
import type { PlantData, PlantView } from './types.js';
import type { Recorder } from '../../recorder.js';

// The render dispatcher will inject the recorder. Keeping the read at call-site
// would tightly couple this file to the server; instead the dispatcher wraps
// the recorder and passes it via a renderer arg in `index.ts`.
export interface TrdContext {
  recorder: Recorder;
}

export function renderTrd(view: PlantView, data: PlantData, ctx: TrdContext): string[] {
  const W = view.width;
  const out: string[] = [];
  // v1.38.0 — the sparkline takes EVERY column after the fixed prefix (2
  // indent + 16 tag + 1 + 13 value/unit + 3), instead of the old capped
  // 20–80-char strip. Prefix + sparkW = exactly W.
  const sparkW = Math.max(8, W - 35);
  const sinceMs = Date.now() - 60 * 60 * 1000;          // last 60 min

  out.push(divider('TRENDS — last 60 minutes (1-min buckets)', W));
  out.push(c.grey('  most recent value on the right; auto-scaled per tag'));
  out.push('');

  const tags: Array<{ tag: string; metricSn: string; metric: string; unit: string }> = [];
  const shp2 = getShp2(data);
  if (shp2) {
    tags.push({ tag: 'BATT.SOC',     metricSn: shp2.sn, metric: 'backup_pct',  unit: '%' });
    tags.push({ tag: 'LD.PANEL.P',   metricSn: shp2.sn, metric: 'panel_load',  unit: 'W' });
  }
  const dpus = getDpus(data).filter((d) => d.online);
  for (let i = 0; i < dpus.length; i++) {
    const d = dpus[i];
    // v1.0.1 — label by the PHYSICAL generator number (see data.ts), not the position
    // in this ONLINE-filtered array: when a home Core is cloud-wedged, filtering drops
    // it and shifts every tag below it onto the wrong Core — exactly the moment an
    // operator is reading trends to diagnose which unit is actually faulted.
    const gen = generatorNumber(d.deviceName, i);
    tags.push({ tag: `GEN.${gen}.PV.P`,  metricSn: d.sn, metric: 'pv_total', unit: 'W' });
    // v1.0.2 — GEN.<n>.P.OUT must mean the same thing here as it does on the GEN
    // detail screen (gen.ts), which reports p.totalOutWatts (wattsOutSum — the
    // DPU's total output across AC + DC/USB ports), not just the AC leg. Using
    // 'ac_out' (outAc5p8Pwr only) under-reported output whenever a DC port drew
    // power, and made the identical instrument tag disagree between screens.
    // The recorder already captures wattsOutSum under 'total_out' — no new
    // plumbing needed.
    tags.push({ tag: `GEN.${gen}.P.OUT`, metricSn: d.sn, metric: 'total_out', unit: 'W' });
  }

  // v-batch — group tags by device SN and fetch each device's tags in ONE
  // queryMulti() call instead of one query() per tag. TRD previously issued
  // one synchronous SQLite statement per row (~12/redraw across a typical
  // fleet: 2 SHP2 tags + 2 tags x N online DPUs). queryMulti() already exists
  // on the recorder (used by equipment-health / self-consumption) and pulls
  // every requested metric for one sn via a single cached prepared statement,
  // so this collapses per-redraw SQLite calls to one per DISTINCT device SN
  // (typically 4-6) with byte-identical output — same window, same buckets,
  // same per-tag math below.
  const metricsBySn = new Map<string, Set<string>>();
  for (const t of tags) {
    let s = metricsBySn.get(t.metricSn);
    if (!s) { s = new Set(); metricsBySn.set(t.metricSn, s); }
    s.add(t.metric);
  }
  const nowMs = Date.now();
  const seriesBySn = new Map<string, Map<string, Array<{ ts: number; value: number }>>>();
  for (const [sn, metrics] of metricsBySn) {
    seriesBySn.set(sn, ctx.recorder.queryMulti(sn, [...metrics], sinceMs, nowMs, 60));
  }

  for (const t of tags) {
    const pts = seriesBySn.get(t.metricSn)?.get(t.metric) ?? [];
    const series = pts.map((p) => p.value);
    const latest = series.length > 0 ? series[series.length - 1] : null;
    const lo = series.length ? Math.min(...series) : 0;
    const hi = series.length ? Math.max(...series) : 0;

    const tagStr = c.whiteB(padEnd(t.tag, 16));
    // Both branches render exactly 13 visible chars (9 value + 1 + 3 unit) so
    // the sparkline column starts in the same place on every row.
    const latestStr = latest == null
      ? c.grey(padStart('—', 9)) + ' '.repeat(4)
      : c.whiteB(padStart(formatVal(latest, t.unit), 9)) + c.grey(' ' + padEnd(t.unit, 3));
    const rangeStr = series.length
      ? c.grey(`[${formatVal(lo, t.unit)}…${formatVal(hi, t.unit)} ${t.unit}]`)
      : c.grey('[no data]');
    // Braille bounds pinned to the SAME raw lo/hi shown in the range label, so
    // the strip and its caption can never disagree about the scale. A flat
    // series (lo == hi) renders mid-height; an empty one, blank cells.
    const trendStyled = c.cyan(braille(series, sparkW, lo, hi));

    out.push(`  ${tagStr} ${latestStr}   ${trendStyled}`);
    out.push(`  ${c.grey(' '.repeat(16))} ${rangeStr}`);
  }

  if (tags.length === 0) {
    out.push(c.grey('  No tags available — waiting for first telemetry.'));
  }

  return out;
}

function formatVal(v: number, unit: string): string {
  if (unit === 'W') {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)}k`;
    return `${Math.round(v)}`;
  }
  if (unit === '%') return v.toFixed(1);
  if (unit === 'V') return v.toFixed(1);
  return v.toFixed(2);
}
