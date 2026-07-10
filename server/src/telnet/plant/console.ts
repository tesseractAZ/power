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
// v0.11.0 — the alarm banner is keyed on the 4-tier ISA-18.2 / IEC 62682
// priority (Critical/High/Medium/Low) instead of the raw severity.
import { priorityOf, comparePriority, type AlarmPriority } from '../../alertPriority.js';
// v0.36.0 — the SHP2 is the grid interconnect; the grid is a BACKSTOP tapped
// automatically when the pool hits its reserve floor. The resolver gives three
// states to surface: ACTIVE (grid carrying the home now, via homeGridWatts — the
// SHP2 main backstop path — or DPU ac_in import), AVAILABLE (present/declared but
// on standby), and OFF-GRID (islanded).
import { liveGridBackstop } from '../../gridState.js';
// v1.0.0 — the authoritative fleet aggregate + SHP2 membership, shared with the
// fleet_pv_watts / fleet_battery_net_watts HA sensors and the summary TUI.
import { aggregateFleetFlow, shp2ConnectedDpuSns, isShp2Connected } from '../../shp2Membership.js';

/** v0.36.0 — the three operator-facing grid states (see import note above). */
type GridState = 'active' | 'standby' | 'islanded';

export function renderConsole(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];

  const shp2 = getShp2(data);
  // v1.0.0 — the CONSOLE is the HOME-plant faceplate: every fleet figure on it must be
  // scoped to the SHP2-connected home Cores. A bench SPARE Core (online, self-charging on
  // its own panels) used to leak into PV, battery-net, bus voltage and device quality here.
  //   • PV + battery-net now read the SAME authoritative aggregate as the fleet_pv_watts /
  //     fleet_battery_net_watts HA sensors and the summary TUI (aggregateFleetFlow: online
  //     AND SHP2-connected; per-pack net where POSITIVE = discharging). This also retires
  //     the pre-v0.96.0 DPU-throughput formula (totalOut − totalIn), which is inverter
  //     throughput, not battery DC flow, and overstated the rate.
  //   • `dpus` (bus voltage, device quality, and the no-SHP2 fallbacks) is likewise gated.
  // Result: the SCADA console can no longer disagree with the HA sensors for one instant.
  const { fleetPv: pv, fleetBatteryNet: batNet } = aggregateFleetFlow(data.snap.devices);
  const connectedSns = shp2ConnectedDpuSns(data.snap.devices);
  const dpus = getDpus(data).filter((d) => d.online && isShp2Connected(d.sn, connectedSns));
  const acIn = gridAcInWatts(data);
  const soc = shp2?.projection.backupBatPercent ?? avg(dpus.map((d) => d.projection.soc));
  const load = shp2
    ? sum(shp2.projection.circuits, (cir) => cir.watts)
    : sum(dpus, (d) => d.projection.acOutWatts);
  // v0.36.0 — three grid states from the backstop resolver, not just off-grid vs
  // tied. `gridWatts` is what the grid carries into the home when active (the SHP2
  // main backstop path, falling back to the DPU ac_in import sum).
  const grid = liveGridBackstop(data.snap.devices);
  const gridState: GridState = !grid.present
    ? 'islanded'
    : grid.homeGridWatts > 0 || grid.importWatts > 0
      ? 'active'
      : 'standby';
  const gridWatts = grid.homeGridWatts > 0 ? grid.homeGridWatts : grid.importWatts;
  const offGrid = gridState === 'islanded';

  /* ── 1. status header ─────────────────────────────────────────────── */
  // MODE conveys all three states: ISLANDED / GRID BACKSTOP / GRID STANDBY.
  // Islanded reads as a normal operating posture (off-grid plant by design);
  // an active backstop is the noteworthy transfer; standby is nominal-manual.
  const modeText = gridState === 'islanded' ? 'ISLANDED' : gridState === 'active' ? 'GRID BACKSTOP' : 'GRID STANDBY';
  const modeState: AlarmState = gridState === 'islanded' ? 'normal' : gridState === 'active' ? 'warn' : 'manual';
  out.push(statusHeader({
    station: 'POWER · SITE 01 · OFF-GRID PLANT',
    mode: modeText,
    modeState,
    uptime: uptime(data.serverStartedAt),
    operator: 'eric@local',
  }, W));

  /* ── 2. alarm banner ──────────────────────────────────────────────── */
  // Alerts have no timestamp of their own — they're re-evaluated each
  // snapshot. We use snapshot.generatedAt as a proxy "as-of" stamp.
  const stamp = data.snap.generatedAt ?? Date.now();
  const alerts = (data.snap.alerts ?? []).slice();
  // v0.11.0 — bucket by the 4-tier ISA priority; the highest-priority alarm
  // (ties broken by list order) is the banner headline.
  const counts: Record<AlarmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of alerts) counts[priorityOf(a)]++;
  const newest = alerts
    .slice()
    .sort((a, b) => comparePriority(priorityOf(a), priorityOf(b)))[0] ?? null;
  out.push(alarmBanner({
    newest: newest
      ? {
          ts: stamp,
          text: newest.detail ? `${newest.title} — ${newest.detail}` : newest.title,
          priority: priorityOf(newest),
        }
      : null,
    counts,
    ackCount: 0,
  }, W));
  out.push('');

  /* ── 3. mimic-style power-flow diagram ────────────────────────────── */
  out.push(divider('MIMIC — POWER FLOW', W));
  out.push('');
  out.push(...renderMimic(pv, batNet, gridWatts, load, soc, gridState, W));
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
      // v0.9.33 — flags column is 8 chars wide; previous 'A/L/N · DCH' (11)
      // was silently truncated mid-word ('A/L/N · D'). Just show direction.
      flags: batNet > 5 ? 'DCH' : batNet < -5 ? 'CHG' : 'IDLE',
    }, W),
    // GRID.HOME.P — SHP2 main grid into the home (wattInfo.gridWatt): the
    // authoritative whole-home backstop path, previously invisible to the TUI.
    // GRID.AC.P below stays the DPU ac_in import path (grid charging the DPUs).
    renderTagRow({
      tag: 'GRID.HOME.P',
      ...fmtW(grid.homeGridWatts),
      state: gridState === 'islanded' ? 'oos' : gridState === 'active' ? 'normal' : 'comm',
      quality: shp2 ? deviceQuality(shp2) : 'bad',
      // 8-char flags column: BACKSTOP (8) / STANDBY (7) / ISLANDED (8) all fit.
      flags: gridState === 'islanded' ? 'ISLANDED' : gridState === 'active' ? 'BACKSTOP' : 'STANDBY',
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
  gridWatts: number,
  load: number,
  soc: number | null | undefined,
  gridState: GridState,
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
  // v0.9.33 — bus side-wall width was off-by-one. The walls (║) on rows 2
  // and 3 must land in the same visible column as the corner chars (╗/╝)
  // on rows 1 and 4, otherwise the box draws with a visible jog. Visible
  // layout of one side row: ║ + ' ' + label + padding + ║ — must total
  // colW chars. So padding = colW - 3 - label.length (was colW - 4 -
  // label.length, which produced colW-1 total).
  const arrowPv = c.yellow(MIMIC.arrowR + MIMIC.h.repeat(2));
  const busLeftLabel = 'MAIN BUS';
  const busLeft = c.cyanB(MIMIC.dv) + ' ' + c.whiteB(busLeftLabel) +
    ' '.repeat(Math.max(0, colW - 3 - busLeftLabel.length)) + c.cyanB(MIMIC.dv);
  const arrowBatt = batNet > 5 ? c.yellow(MIMIC.arrowL + MIMIC.h.repeat(2)) :
                    batNet < -5 ? c.green(MIMIC.arrowR + MIMIC.h.repeat(2)) :
                    c.grey('═══');
  out.push(padEnd('  ' + arrowPv + '─' + MIMIC.tDown, colW) + '  ' + busLeft + '  ' + arrowBatt + '─' + MIMIC.tDown);

  // ─ row 3: voltage / freq label ───────────────────────────────────
  const busMidLabel = '240V · 60.00 Hz';
  const busMid = c.cyanB(MIMIC.dv) + ' ' + c.green(busMidLabel) +
    ' '.repeat(Math.max(0, colW - 3 - busMidLabel.length)) + c.cyanB(MIMIC.dv);
  out.push(padEnd(' '.repeat(colW), colW) + '  ' + busMid + '  ' + padEnd(' '.repeat(colW), colW));

  // ─ row 4: GRID ←→ BUS → LOADS ───────────────────────────────────
  // Three states: ACTIVE backstop (carrying the home now) → power + feed arrow;
  // AVAILABLE → grey "standby"; ISLANDED → grey "islanded".
  const gridValue =
    gridState === 'islanded'
      ? c.grey('islanded')
      : gridState === 'active'
        ? c.whiteB(formatPower(gridWatts)) + c.green(' ' + MIMIC.arrowR)
        : c.cyan('standby');
  const gridLabel = `⌁ ${c.cyan('GRID')}  ` + gridValue;
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
