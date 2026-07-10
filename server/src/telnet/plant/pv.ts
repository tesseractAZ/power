/**
 * PV screen — solar array instrumentation per DPU.
 *
 * Like a generation-side mimic on a renewables HMI: per-MPPT V/I/P,
 * realized vs. expected (forecast), today's kWh, peak watts.
 */

import { c, padEnd, padStart, BOX } from '../ansi.js';
import { divider, gauge, stateGlyph } from './scada.js';
import { getDpus, fmtW, fmtPct, deviceQuality, sum, generatorNumber } from './data.js';
import type { PlantData, PlantView } from './types.js';
import { shp2ConnectedDpuSns, isShp2Connected } from '../../shp2Membership.js';

// v1.0.1 — generatorNumber() promoted to data.ts (trd.ts's TRENDS screen needs the
// same physical-vs-index fix). See data.ts for the constraint it enforces.
export function renderPv(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];
  // v1.0.0 — the PV screen is the HOME array. A bench SPARE Core with its own panels is
  // not part of it: it used to inflate FLEET TOTAL / HV / LV and add a phantom GEN row.
  // Scope to online AND SHP2-connected Cores, matching the fleet_pv_watts HA sensor.
  const connectedSns = shp2ConnectedDpuSns(data.snap.devices);
  const dpus = getDpus(data).filter((d) => d.online && isShp2Connected(d.sn, connectedSns));
  if (dpus.length === 0) {
    out.push(c.grey('  No home Cores online — no PV array data.'));
    return out;
  }

  const totalPv = sum(dpus, (d) => d.projection.pvTotalWatts);
  const totalHv = sum(dpus, (d) => d.projection.pvHighWatts);
  const totalLv = sum(dpus, (d) => d.projection.pvLowWatts);

  /* ── array summary ────────────────────────────────────────────── */
  out.push(divider('PV ARRAY — FLEET TOTAL', W));
  // v0.9.33 — was hard-coded 12000 / 4000 (assumed a 10-HV+4-LV string
  // fleet). Scale by the actual number of online DPUs so the gauge is
  // meaningful regardless of fleet size. Fall back to safe minimums.
  // audit g10-pv-peaks — the per-DPU numbers were themselves wrong. EcoFlow's own
  // Delta Pro Ultra datasheet rates HV-PV at 4000 W (80-450V/15A) and LV-PV at
  // 1600 W (30-150V/15A) — 5.6 kW/unit, matching EcoFlow's published 16.8kW/
  // 3-inverter fleet figure. The old 1600/1000 guess sat BELOW the real HV cap,
  // so a string running near its true hardware ceiling read as "over 100%" in
  // the % text (the bar itself clamps at 100% — see gauge() in scada.ts — but
  // the numeric label does not). Use the device's OWN hardware limit, not a
  // historical-observed-peak proxy: unlike an observed max, the datasheet
  // rating can never be exceeded by an actual reading.
  const PER_DPU_HV_W = 4000;
  const PER_DPU_LV_W = 1600;
  const peakHv = Math.max(PER_DPU_HV_W, dpus.length * PER_DPU_HV_W);
  const peakLv = Math.max(PER_DPU_LV_W, dpus.length * PER_DPU_LV_W);
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
    out.push('  ' + [
      // v1.0.0 — label by the PHYSICAL generator number, not the array index: with any
      // home Core offline, index-labelling shifted every row below it onto the wrong unit.
      padEnd(c.whiteB(`GEN ${generatorNumber(d.deviceName, i)}`), 8),
      padStart(fmtVStr(p.pvHighVolts), 7),
      padStart(fmtAStr(p.pvHighAmps), 7),
      padStart(fmtKw(p.pvHighWatts ?? 0), 9),
      padStart(errCell(p.pvHighErrCode, p.pvHighWatts, p.pvHighAmps), 6),
      '  ' + padStart(fmtVStr(p.pvLowVolts), 7),
      padStart(fmtAStr(p.pvLowAmps), 7),
      padStart(fmtKw(p.pvLowWatts ?? 0), 9),
      padStart(errCell(p.pvLowErrCode, p.pvLowWatts, p.pvLowAmps), 6),
    ].join(' '));
  }
  out.push('');

  /* ── forecast vs. realized — if forecast available ────────────── */
  if (data.forecast) {
    out.push(divider('FORECAST vs. REALIZED — next 24 h', W));
    const fc = data.forecast;
    out.push(padEnd(
      // v0.95.0 (re-audit #7) — display basis (restored full-fleet), matching the HA
      // sensor + web tiles; the runway alarm reads hours[].forecastPvW, not this field.
      '  ' + c.grey('FORECAST PV NEXT 24 h ') + c.yellow(`${((fc.forecastPvWhNext24Display ?? fc.forecastPvWhNext24) / 1000).toFixed(2)} kWh`) +
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
/** v1.0.1 — an MPPT error code is only a FAULT while the string is actually producing
 *  (real watts AND real current). At dusk / during curtailment EcoFlow reports a non-zero
 *  *standby* code on an idle string — every home Core shows the identical code at once —
 *  and painting that red made all three generators look faulted every evening. Mirrors
 *  `mpptProducing()` in alerts.ts so the screen and the alarm engine agree: red only when
 *  the alarm engine would raise it, grey "stby" when it is benign idle. */
function errCell(code: number | null | undefined, watts: number | null | undefined, amps: number | null | undefined): string {
  if ((code ?? 0) === 0) return c.green('OK');
  const hex = (code ?? 0).toString(16).toUpperCase();
  const producing = watts != null && watts > 20 && (amps == null || amps > 0.3);
  return producing ? c.red(hex) : c.grey('stby');
}

function fmtVStr(v: number | null | undefined): string {
  if (v == null) return c.grey('—');
  return c.white(`${v.toFixed(1)}V`);
}
function fmtAStr(a: number | null | undefined): string {
  if (a == null) return c.grey('—');
  return c.white(`${a.toFixed(1)}A`);
}
