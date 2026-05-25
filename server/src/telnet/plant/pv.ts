/**
 * PV screen — solar array instrumentation per DPU.
 *
 * Like a generation-side mimic on a renewables HMI: per-MPPT V/I/P,
 * realized vs. expected (forecast), today's kWh, peak watts.
 */

import { c, padEnd, padStart, BOX } from '../ansi.js';
import { divider, gauge, stateGlyph } from './scada.js';
import { getDpus, fmtW, fmtPct, deviceQuality, sum } from './data.js';
import type { PlantData, PlantView } from './types.js';

export function renderPv(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];
  const dpus = getDpus(data).filter((d) => d.online);
  if (dpus.length === 0) {
    out.push(c.grey('  No DPUs online — no PV array data.'));
    return out;
  }

  const totalPv = sum(dpus, (d) => d.projection.pvTotalWatts);
  const totalHv = sum(dpus, (d) => d.projection.pvHighWatts);
  const totalLv = sum(dpus, (d) => d.projection.pvLowWatts);

  /* ── array summary ────────────────────────────────────────────── */
  out.push(divider('PV ARRAY — FLEET TOTAL', W));
  const peakHv = 12000; // 10 HV strings × 1200W theoretical headroom — used for gauge scaling
  const peakLv = 4000;  // 4 LV strings × 1000W theoretical headroom
  const peakTot = peakHv + peakLv;
  out.push(padEnd('  ' + c.grey('TOTAL PV ') + c.whiteB(fmtKw(totalPv)) + '  ' +
    gauge((totalPv / peakTot) * 100, Math.max(20, Math.min(48, W - 36)), 'yellow') +
    `  ${((totalPv / peakTot) * 100).toFixed(0).padStart(3)}%`, W));
  out.push(padEnd('  ' + c.grey('   HV ARR ') + c.white(fmtKw(totalHv)) + '  ' +
    gauge((totalHv / peakHv) * 100, Math.max(20, Math.min(48, W - 36)), 'yellow') +
    `  ${((totalHv / peakHv) * 100).toFixed(0).padStart(3)}%`, W));
  out.push(padEnd('  ' + c.grey('   LV ARR ') + c.white(fmtKw(totalLv)) + '  ' +
    gauge((totalLv / peakLv) * 100, Math.max(20, Math.min(48, W - 36)), 'yellow') +
    `  ${((totalLv / peakLv) * 100).toFixed(0).padStart(3)}%`, W));
  out.push('');

  /* ── per-DPU MPPT table ───────────────────────────────────────── */
  out.push(divider('MPPT INPUTS — per generator', W));
  const headers = ['GEN', 'HV.V', 'HV.A', 'HV.P', 'HV.ERR', 'LV.V', 'LV.A', 'LV.P', 'LV.ERR'];
  out.push('  ' + c.grey([
    padEnd(headers[0], 8),
    padStart(headers[1], 7), padStart(headers[2], 7),
    padStart(headers[3], 9), padStart(headers[4], 6),
    '  ' + padStart(headers[5], 7), padStart(headers[6], 7),
    padStart(headers[7], 9), padStart(headers[8], 6),
  ].join(' ')));
  for (let i = 0; i < dpus.length; i++) {
    const d = dpus[i];
    const p = d.projection;
    const hvErr = (p.pvHighErrCode ?? 0) > 0;
    const lvErr = (p.pvLowErrCode ?? 0) > 0;
    out.push('  ' + [
      padEnd(c.whiteB(`GEN ${i + 1}`), 8),
      padStart(fmtVStr(p.pvHighVolts), 7),
      padStart(fmtAStr(p.pvHighAmps), 7),
      padStart(fmtKw(p.pvHighWatts ?? 0), 9),
      padStart(hvErr ? c.red(((p.pvHighErrCode ?? 0).toString(16)).toUpperCase()) : c.green('OK'), 6),
      '  ' + padStart(fmtVStr(p.pvLowVolts), 7),
      padStart(fmtAStr(p.pvLowAmps), 7),
      padStart(fmtKw(p.pvLowWatts ?? 0), 9),
      padStart(lvErr ? c.red(((p.pvLowErrCode ?? 0).toString(16)).toUpperCase()) : c.green('OK'), 6),
    ].join(' '));
  }
  out.push('');

  /* ── forecast vs. realized — if forecast available ────────────── */
  if (data.forecast) {
    out.push(divider('FORECAST vs. REALIZED — next 24 h', W));
    const fc = data.forecast;
    out.push(padEnd(
      '  ' + c.grey('FORECAST PV NEXT 24 h ') + c.yellow(`${(fc.forecastPvWhNext24 / 1000).toFixed(2)} kWh`) +
      c.grey('   TYPICAL ') + c.white(`${(fc.typicalPvWhPerDay / 1000).toFixed(2)} kWh/day`) +
      c.grey('   HISTORY ') + c.white(`${fc.historyDays.toFixed(1)} d`),
      W,
    ));
    if (fc.soiling) {
      const drop = fc.soiling.dropPct ?? 0;
      const col = drop >= 15 ? c.red : drop >= 8 ? c.yellow : c.green;
      out.push(padEnd(
        '  ' + c.grey('SOILING DETECTED ') + col(`${drop.toFixed(1)}% PV efficiency drop`) +
        c.grey(`   ${fc.soiling.cleanDays} clean days observed`),
        W,
      ));
    }
  }

  return out;
}

function fmtKw(w: number): string {
  if (w == null) return '—';
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}
function fmtVStr(v: number | null | undefined): string {
  if (v == null) return c.grey('—');
  return c.white(`${v.toFixed(1)}V`);
}
function fmtAStr(a: number | null | undefined): string {
  if (a == null) return c.grey('—');
  return c.white(`${a.toFixed(1)}A`);
}
