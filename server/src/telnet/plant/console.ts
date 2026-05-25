/**
 * CONSOLE screen — the operator's bridge view.
 *
 * This is what the operator stares at all day. It packs:
 *
 *   - Status header (timestamp, uptime, mode, alarm count)
 *   - Alarm banner (newest unack'd + counts)
 *   - Mimic-style power-flow diagram: PV → BATTERY ─┐
 *                                                   ├── BUS ── LOADS
 *                                          GRID  ───┘
 *     Each "block" shows live numeric value + state glyph.
 *   - Headline tag rows: BUS.MAIN.V/HZ, PV.ARRAY.P, BATT.SOC, LD.PANEL.P,
 *     EVSE.P, GRID.AC.P — the small set you'd put on a 6-inch dedicated
 *     overview faceplate.
 *
 * Designed to be readable at 80×24 but uses extra height/width when the
 * client gives it.
 */

import { c, padEnd, BOX, visLen } from '../ansi.js';
import {
  alarmBanner, statusHeader, divider, renderTagRow, bandedGauge,
  busBarSegment, MIMIC, stateGlyph, deviationDisplay,
} from './scada.js';
import {
  getDpus, getShp2, gridAcInWatts, sum, avg, uptime,
  fmtW, fmtPct, fmtVolt, socState, deviceQuality,
} from './data.js';
import type { PlantData, PlantView } from './types.js';
import type { AlarmState } from './scada.js';

export function renderConsole(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];

  const shp2 = getShp2(data);
  const dpus = getDpus(data).filter((d) => d.online);
  const pv = sum(dpus, (d) => d.projection.pvTotalWatts);
  const acIn = gridAcInWatts(data);
  const totIn = sum(dpus, (d) => d.projection.totalInWatts);
  const totOut = sum(dpus, (d) => d.projection.totalOutWatts);
  const batNet = totOut - totIn;        // positive = discharging
  const soc = shp2?.projection.backupBatPercent ?? avg(dpus.map((d) => d.projection.soc));
  const load = shp2
    ? sum(shp2.projection.circuits, (cir) => cir.watts)
    : sum(dpus, (d) => d.projection.acOutWatts);
  const offGrid = acIn < 5;

  /* ── 1. status header ─────────────────────────────────────────────── */
  out.push(statusHeader({
    station: 'ECOFLOW · SITE 01 · OFF-GRID PLANT',
    mode: offGrid ? 'ISLANDED' : 'GRID-TIED',
    modeState: offGrid ? 'normal' : 'manual',
    uptime: uptime(data.serverStartedAt),
    operator: 'eric@local',
  }, W));

  /* ── 2. alarm banner ──────────────────────────────────────────────── */
  // Alerts have no timestamp of their own — they're re-evaluated each
  // snapshot. We use snapshot.generatedAt as a proxy "as-of" stamp.
  const stamp = data.snap.generatedAt ?? Date.now();
  const alerts = (data.snap.alerts ?? []).slice();
  const crit = alerts.filter((a) => a.severity === 'critical');
  const warn = alerts.filter((a) => a.severity === 'warning');
  const info = alerts.filter((a) => a.severity === 'info');
  const newest = crit[0] ?? warn[0] ?? info[0] ?? null;
  out.push(alarmBanner({
    newest: newest
      ? {
          ts: stamp,
          text: newest.detail ? `${newest.title} — ${newest.detail}` : newest.title,
          severity: newest.severity as 'critical' | 'warning' | 'info',
        }
      : null,
    counts: { critical: crit.length, warning: warn.length, info: info.length },
    ackCount: 0,
  }, W));
  out.push('');

  /* ── 3. mimic-style power-flow diagram ────────────────────────────── */
  out.push(divider('MIMIC — POWER FLOW', W));
  out.push('');
  out.push(...renderMimic(pv, batNet, acIn, load, soc, offGrid, W));
  out.push('');

  /* ── 4. headline tag rows ─────────────────────────────────────────── */
  out.push(divider('PRIMARY TAGS', W));
  // BUS voltage and frequency are nominal values — EcoFlow doesn't expose a
  // measured bus voltage directly. We synthesize from out-AC voltage of the
  // first online DPU as an approximation; mark UNCERTAIN quality.
  const busV = avg(dpus.map((d) => d.projection.acOutVol));
  const dpuQual = dpus[0] ? deviceQuality(dpus[0]) : 'bad';

  const tagRows = [
    renderTagRow({
      tag: 'BUS.MAIN.V',
      value: busV != null ? busV.toFixed(1) : '—',
      unit: 'V',
      state: 'normal',
      quality: busV != null ? 'good' : 'bad',
      flags: 'A/L/N',
    }, W),
    renderTagRow({
      tag: 'BUS.MAIN.HZ',
      value: '60.00',
      unit: 'Hz',
      state: 'normal',
      quality: 'uncertain',                        // not actually measured
      flags: 'A/L/N',
    }, W),
    renderTagRow({
      tag: 'PV.ARRAY.P',
      ...fmtW(pv),
      state: pv > 100 ? 'normal' : 'oos',
      quality: dpuQual,
      flags: pv > 100 ? 'A/L/N' : 'A/L/N',
    }, W),
    renderTagRow({
      tag: 'BATT.SOC',
      ...fmtPct(soc, 1),
      state: socState(soc),
      quality: shp2 ? deviceQuality(shp2) : dpuQual,
      flags: 'A/L/N',
    }, W),
    renderTagRow({
      tag: 'BATT.P.NET',
      ...fmtW(Math.abs(batNet)),
      state: 'normal',
      quality: dpuQual,
      flags: batNet > 5 ? 'A/L/N · DCH' : batNet < -5 ? 'A/L/N · CHG' : 'A/L/N · IDL',
    }, W),
    renderTagRow({
      tag: 'GRID.AC.P',
      ...fmtW(acIn),
      state: offGrid ? 'oos' : 'normal',
      quality: dpuQual,
      flags: offGrid ? 'ISLANDED' : 'CLOSED',
    }, W),
    renderTagRow({
      tag: 'LD.PANEL.P',
      ...fmtW(load),
      state: 'normal',
      quality: shp2 ? deviceQuality(shp2) : 'bad',
      flags: 'A/L/N',
    }, W),
  ];
  for (const r of tagRows) out.push(r);
  out.push('');

  /* ── 5. battery pool gauge ────────────────────────────────────────── */
  out.push(divider('BATTERY POOL', W));
  if (shp2) {
    const p = shp2.projection;
    const gaugeW = Math.max(20, Math.min(60, W - 30));
    const reserveLine = padEnd(
      '  ' + c.grey('SOC ') + bandedGauge(p.backupBatPercent ?? 0, { red: 20, yellow: 50 }, gaugeW, false) +
      '  ' + c.whiteB(`${(p.backupBatPercent ?? 0).toFixed(1)}%`),
      W,
    );
    out.push(reserveLine);
    const reserveSetpoint = p.backupReserveSoc ?? 0;
    out.push(padEnd(
      '  ' + c.grey('RES ') + c.cyan('▲ setpoint  ') + c.whiteB(`${reserveSetpoint}%`) +
      c.grey('  remaining ') + c.white(`${((p.backupRemainWh ?? 0) / 1000).toFixed(2)} kWh`) +
      c.grey('  full ') + c.white(`${((p.backupFullCapWh ?? 0) / 1000).toFixed(2)} kWh`),
      W,
    ));
    // Discharge / charge time projections.
    const dchMin = p.backupDischargeTimeMin;
    const chMin = p.backupChargeTimeMin;
    out.push(padEnd(
      '  ' + c.grey('RUN ') + (dchMin != null
        ? c.yellow(`▼ DCH ${fmtMinutes(dchMin)}`)
        : c.grey('▼ DCH —')) +
      c.grey('   ') + (chMin != null
        ? c.green(`▲ CHG ${fmtMinutes(chMin)}`)
        : c.grey('▲ CHG —')),
      W,
    ));
  } else {
    out.push(c.grey('  No SHP2 detected.'));
  }

  return out;
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  if (h < 24) return `${h}h ${String(mm).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Render the mimic-style power flow diagram. Three columns: sources on left
 * (PV + GRID), the BUS in the middle, BATTERY + LOADS on the right.
 *
 *     PV         ╔══════════╗        LOADS
 *     ☀ +5.4 kW ─►║   BUS    ║─►  + 3.1 kW
 *                 ║  ── ── ──║
 *     GRID       ║          ║        BATT
 *     ⌁ idle  ─►║          ║◄─►  87%  ▲ chg
 *                 ╚══════════╝
 */
function renderMimic(
  pv: number,
  batNet: number,
  acIn: number,
  load: number,
  soc: number | null | undefined,
  offGrid: boolean,
  width: number,
): string[] {
  const out: string[] = [];
  const colW = Math.max(18, Math.floor((width - 6) / 3));
  // ─ row 1: PV ─────────────────────────────────────────────────────
  const pvLabel = `${MIMIC.solar} ${c.yellow('PV')}  ${c.whiteB(formatPower(pv))}`;
  const busTop = c.cyanB(MIMIC.dtl + MIMIC.dh.repeat(colW - 2) + MIMIC.dtr);
  const battLabel =
    `${MIMIC.battery} ${c.cyan('BATT')}  ${c.whiteB(((soc ?? 0)).toFixed(0) + '%')}  ` +
    (batNet > 5 ? c.yellow('▼ DCH') : batNet < -5 ? c.green('▲ CHG') : c.grey('idle'));
  out.push(padEnd(pvLabel, colW) + '  ' + busTop + '  ' + battLabel);

  // ─ row 2: flow arrow → BUS ← flow arrow ──────────────────────────
  const arrowPv = c.yellow(MIMIC.arrowR + MIMIC.h.repeat(2));
  const busLeft = c.cyanB(MIMIC.dv) + ' ' + c.whiteB('MAIN BUS') + ' '.repeat(Math.max(0, colW - 4 - 'MAIN BUS'.length)) + c.cyanB(MIMIC.dv);
  const arrowBatt = batNet > 5 ? c.yellow(MIMIC.arrowL + MIMIC.h.repeat(2)) :
                    batNet < -5 ? c.green(MIMIC.arrowR + MIMIC.h.repeat(2)) :
                    c.grey('═══');
  out.push(padEnd('  ' + arrowPv + '─' + MIMIC.tDown, colW) + '  ' + busLeft + '  ' + arrowBatt + '─' + MIMIC.tDown);

  // ─ row 3: voltage / freq label ───────────────────────────────────
  const busMid = c.cyanB(MIMIC.dv) + ' ' + c.green('240V · 60.00 Hz') + ' '.repeat(Math.max(0, colW - 4 - '240V · 60.00 Hz'.length)) + c.cyanB(MIMIC.dv);
  out.push(padEnd(' '.repeat(colW), colW) + '  ' + busMid + '  ' + padEnd(' '.repeat(colW), colW));

  // ─ row 4: GRID ←→ BUS → LOADS ───────────────────────────────────
  const gridLabel = `⌁ ${c.cyan('GRID')}  ` + (offGrid ? c.grey('islanded') : c.whiteB(formatPower(acIn)));
  const busBot = c.cyanB(MIMIC.dbl + MIMIC.dh.repeat(colW - 2) + MIMIC.dbr);
  const loadLabel = `${MIMIC.meter} ${c.cyan('LD')}  ` + c.whiteB(formatPower(load)) + c.grey('  feeders');
  out.push(padEnd(gridLabel, colW) + '  ' + busBot + '  ' + loadLabel);

  // ─ row 5: tiny labels under the columns ──────────────────────────
  const sub = c.grey;
  out.push(padEnd('  ' + sub('PV → BUS'), colW) + '  ' + padEnd(c.cyanB(' MAIN PANEL '), colW) + '  ' + padEnd('  ' + sub('STORAGE'), colW));

  return out;
}

function formatPower(w: number): string {
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}
