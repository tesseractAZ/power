/**
 * GEN screen — generator (DPU) detail console.
 *
 * Each Delta Pro Ultra is a 7.2 kWh generator with up to 5 packs. This
 * screen shows the operator everything an engine-room watchstander would
 * want about one machine: I/O power, SOC, per-pack SOC/temp/voltage,
 * MPPT inputs, error codes, cumulative kWh.
 *
 * ←/→ rotate the selected DPU; ↑/↓ rotate the highlighted pack.
 */

import { c, padEnd, padStart, truncate, visLen, BOX } from '../ansi.js';
import {
  divider, renderTagRow, gauge, bandedGauge, stateGlyph,
} from './scada.js';
import {
  getDpus, fmtW, fmtPct, fmtTempF, fmtWh,
  socState, tempState, deviceQuality, dpuFlags,
} from './data.js';
import type { PlantData, PlantView } from './types.js';
import { CELL_TEMP } from '../../alerts.js';

export function renderGen(view: PlantView, data: PlantData): string[] {
  const dpus = getDpus(data);
  const out: string[] = [];
  if (dpus.length === 0) {
    out.push(c.grey('  No Delta Pro Ultras online.'));
    return out;
  }
  const idx = Math.max(0, Math.min(dpus.length - 1, view.genSel));
  const dpu = dpus[idx];
  const p = dpu.projection;
  const W = view.width;

  /* ── generator selector strip ──────────────────────────────────── */
  out.push(divider(`GEN ${idx + 1}/${dpus.length} — ${dpu.deviceName}  ·  ${dpu.sn}`, W));
  const tabs = dpus.map((d, i) => {
    const sev = (d.projection.sysErrCode ?? 0) > 0 ? c.redB :
                (d.projection.soc != null && d.projection.soc < 20) ? c.yellow : c.green;
    const lbl = ` GEN ${i + 1} `;
    return i === idx ? c.invert(c.whiteB(lbl)) : sev(lbl);
  }).join(' ');
  out.push('  ' + tabs);
  out.push('');

  /* ── nameplate / status rows ───────────────────────────────────── */
  const qual = deviceQuality(dpu);
  const flags = dpuFlags(dpu);
  out.push(divider('NAMEPLATE & STATUS', W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.SOC`,
    ...fmtPct(p.soc, 1),
    state: socState(p.soc),
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.P.IN`,
    ...fmtW(p.totalInWatts),
    state: (p.totalInWatts ?? 0) > 100 ? 'normal' : 'oos',
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.P.OUT`,
    ...fmtW(p.totalOutWatts),
    state: (p.totalOutWatts ?? 0) > 5 ? 'normal' : 'oos',
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.AC.OUT.V`,
    // acOutVol is already in volts (~240.3), so display it directly — do NOT
    // run it through fmtVolt(), which is a millivolt formatter (÷1000).
    value: p.acOutVol != null ? p.acOutVol.toFixed(1) : '—',
    unit: 'V',
    state: p.acOutVol == null ? 'comm' : (Math.abs(p.acOutVol - 240) > 10 ? 'warn' : 'normal'),
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.AC.OUT.F`,
    value: p.acOutFreq != null ? p.acOutFreq.toFixed(2) : '—',
    unit: 'Hz',
    state: p.acOutFreq == null ? 'comm' : (Math.abs(p.acOutFreq - 60) > 0.5 ? 'warn' : 'normal'),
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.PV.HV.P`,
    ...fmtW(p.pvHighWatts),
    state: (p.pvHighWatts ?? 0) > 50 ? 'normal' : 'oos',
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.PV.LV.P`,
    ...fmtW(p.pvLowWatts),
    state: (p.pvLowWatts ?? 0) > 50 ? 'normal' : 'oos',
    quality: qual,
    flags,
  }, W));
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.RUN.MIN`,
    value: p.remainTimeMin != null ? String(Math.round(p.remainTimeMin)) : '—',
    unit: 'min',
    state: 'normal',
    quality: qual,
    flags,
  }, W));
  // System error bitfield — surface it if non-zero.
  out.push(renderTagRow({
    tag: `GEN.${idx + 1}.SYS.ERR`,
    value: (p.sysErrCode ?? 0).toString(16).toUpperCase(),
    unit: 'h',
    state: (p.sysErrCode ?? 0) > 0 ? 'alarm' : 'normal',
    quality: qual,
    flags,
  }, W));
  out.push('');

  /* ── per-pack table ────────────────────────────────────────────── */
  // v0.9.33 — was `p.packs.length || 5`, which lied about the count when no
  // pack data had been received yet (showed "1/5" on a freshly-discovered
  // DPU whose first BMS payload hadn't landed). Show the true count, and
  // if it's zero, emit a "no pack data yet" line in place of the table.
  const packCount = p.packs.length;
  out.push(divider(`PACKS — ↑/↓ select  ·  Pack ${packCount > 0 ? view.genPack + 1 : 0}/${packCount}`, W));
  if (packCount === 0) {
    out.push(c.grey('  No pack data received yet — waiting for first BMS payload.'));
    return out;
  }
  // Compact tabular pack rows:  # SOC  TEMP   V       CYC   CAP%   STATE
  const headers = ['PK', 'SOC', 'TEMP', 'V.PACK', 'CYC', 'SOH%', 'STATE'];
  out.push('  ' + c.grey([
    padEnd(headers[0], 4), padStart(headers[1], 7), padStart(headers[2], 7),
    padStart(headers[3], 10), padStart(headers[4], 6), padStart(headers[5], 7),
    '  ' + padEnd(headers[6], 8),
  ].join(' ')));
  // r27 — a DPU can report up to 5 packs: 1 row each, plus 2 more rows of
  // SOC/TEMP gauge under whichever pack is SELECTED. plant/index.ts clips the
  // whole frame to `view.height - 2` and silently drops whatever line lands
  // last — at 80x24 that budget has room for all 5 pack rows but NOT for 5
  // rows + a 2-row gauge, so the old always-draw-the-gauge code let the clip
  // eat a pack row (often the 5th) depending on which pack was selected.
  // Compute the real remaining budget and drop the GAUGE, never a pack row,
  // when both don't fit — every pack stays visible/reachable at 80x24.
  const bodyBudget = view.height - 2; // mirrors plant/index.ts's footerLines reservation
  const rowsAvailable = Math.max(0, bodyBudget - out.length);
  const showGauge = rowsAvailable >= packCount + 2;
  for (let i = 0; i < (p.packs.length || 0); i++) {
    const pk = p.packs[i];
    const sel = i === view.genPack;
    const tempCol = tempState(pk.temp ?? null);
    const socCol = socState(pk.soc ?? null);
    const cyc = pk.cycles != null ? String(pk.cycles) : '—';
    // Display-only clamp: raw fullCap > designCap pushes actSoh slightly over 100%
    // on near-new packs; the degradation engine/recorder keep the raw value.
    const sohN0 = pk.actSoh ?? pk.soh;
    const sohN = sohN0 == null ? null : Math.min(100, sohN0);
    const soh = sohN != null ? `${sohN.toFixed(1)}` : '—';
    // DPU packs don't expose a per-pack error code in the projection — we
    // surface overall fleet/MPPT errors on the system row instead. For a
    // per-pack state inference, hot OR very low SOC = WARN, otherwise NORMAL.
    const tooHot = pk.temp != null && (pk.temp * 9 / 5 + 32) >= 122;
    const tooCold = pk.minCellTemp != null && (pk.minCellTemp * 9 / 5 + 32) <= 41;
    const lowSoc = pk.soc != null && pk.soc < 20;
    const faulted = tooHot || lowSoc || tooCold;
    const stateName = faulted ? 'WARN' : 'NORMAL';
    const stateCol = faulted ? c.yellow : c.green;
    const row = '  ' + [
      padEnd((sel ? c.invert(c.whiteB(` ${i + 1} `)) : ` ${i + 1} `), 4),
      padStart(fmtPctRaw(pk.soc), 7),
      padStart(fmtTempRaw(pk.temp), 7),
      padStart(fmtVoltRaw(pk.packVoltageMv ?? pk.adBatVoltageMv ?? null), 10),
      padStart(cyc, 6),
      padStart(soh, 7),
      '  ' + padEnd(stateCol(stateName), 8),
    ].join(' ');
    out.push(row);
    // For the selected pack, drop a gauge underneath — only if it fits without
    // pushing a pack row past the frame's clip boundary (r27; see budget calc
    // above the loop).
    if (sel && showGauge) {
      const gw = Math.max(20, Math.min(60, W - 30));
      out.push('    ' + c.grey('  SOC  ') + bandedGauge(pk.soc ?? 0, { red: 20, yellow: 50 }, gw, false) +
        '  ' + c.whiteB(`${(pk.soc ?? 0).toFixed(0)}%`));
      // Gauge is a 0–60 °C scale; align the red/yellow breakpoints with the real
      // CELL_TEMP alarm band (crit 131°F / warn 113°F ≈ 55 °C / 45 °C) instead of
      // the previous hardcoded 70/50 % pair (42 °C / 30 °C), which matched no
      // actual alarm threshold and disagreed with fmtTempRaw() above.
      out.push('    ' + c.grey('  TEMP ') + bandedGauge(Math.min(100, ((pk.temp ?? 0) / 60) * 100), { red: 8.3, yellow: 25 }, gw, true) +
        '  ' + (pk.temp != null ? c.whiteB(`${((pk.temp * 9) / 5 + 32).toFixed(0)}°F`) : c.grey('—')));
    }
  }

  return out;
}

function fmtPctRaw(p: number | null | undefined): string {
  if (p == null) return '—';
  const col = p < 20 ? c.red : p < 50 ? c.yellow : c.green;
  return col(`${p.toFixed(0)}%`);
}
function fmtTempRaw(tC: number | null | undefined): string {
  if (tC == null) return c.grey('—');
  const f = (tC * 9) / 5 + 32;
  // v-r14 — aligned with alerts.ts CELL_TEMP (the live thermal-alarm engine):
  // was a locally-invented 104/122°F pair that disagreed with the alarm
  // engine's own warn/crit crossings (113/131°F).
  const col = f >= CELL_TEMP.critF! ? c.red : f >= CELL_TEMP.infoF ? c.yellow : c.green;
  return col(`${f.toFixed(0)}°F`);
}
function fmtVoltRaw(mv: number | null | undefined): string {
  if (mv == null) return c.grey('—');
  return c.white(`${(mv / 1000).toFixed(1)} V`);
}
