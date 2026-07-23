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
// v1.38.0 — big-digit headline band (pseudo-LCD block digits) + eighth-block
// backup-pool gauge. Both primitives emit plain strings (no ANSI), so their
// .length is the visible width; colour is applied here around whole segments.
import { bigText, bigTextWidth, BIG_ROWS } from '../bigfont.js';
import { hbar, fracLabel } from '../gauges.js';
import {
  getDpus, getShp2, gridAcInWatts, sum, avg, uptime,
  fmtW, fmtPct, fmtVolt, socState, deviceQuality, alarmLetter,
} from './data.js';
import type { PlantData, PlantView } from './types.js';
import type { AlarmState, Quality } from './scada.js';
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
import { aggregateFleetFlow, shp2ConnectedDpuSns, isShp2Connected, homeCoreCoverage } from '../../shp2Membership.js';

/** v0.36.0 — the three operator-facing grid states (see import note above). */
type GridState = 'active' | 'standby' | 'islanded';

export function renderConsole(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];
  // v-r18 — the CONSOLE's full layout (status/banner/mimic/tags/pool + inter-section
  // blank-line spacing) runs to ~25 rows. renderPlant's body budget is `height - 2`
  // (footer rule + legend) and SILENTLY CLIPS whatever renderConsole returns beyond
  // that (see plant/index.ts renderPlant: `cap = Math.min(body.length, bodyMaxH)`).
  // At the reference 80×24 terminal that budget is 22 rows, so the last-rendered
  // section — the BATTERY POOL gauge/reserve/runway lines — was the one silently
  // dropped every time, even though its own "BATTERY POOL" divider still printed
  // above the void. When the frame is tight we drop the five purely-cosmetic
  // inter-section blank lines so the pool block always survives; on a roomy
  // terminal the full spaced-out console-quality layout is unchanged.
  //
  // v1.38.0 — row accounting: the fully-spaced layout is 27 rows (25 classic +
  // the always-on POOL gauge line + one spacing blank), plus BIG_ROWS+1 more when
  // the big-digit headline band is up. The band itself only lights on a terminal
  // that can afford it (≥ 96 cols for three big figures, ≥ 32 rows so the compact
  // fallback still fits); below that the classic console renders unchanged.
  const showBand = W >= 96 && view.height >= 32;
  const fullRows = 27 + (showBand ? BIG_ROWS + 1 : 0);
  const compact = view.height - 2 < fullRows;

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
  if (!compact) out.push('');

  /* ── 2b. big-digit headline band + backup-pool gauge ──────────────── */
  // The band renders the three figures an operator glances at from across the
  // room — fleet SoC, PV production, panel load — five rows tall. Only when
  // the terminal is roomy (see showBand above); the gauge line below renders
  // at EVERY size.
  if (showBand) out.push(...renderHeadlineBand(soc, pv, load, W));
  out.push(renderPoolGauge(soc, W));
  if (!compact) out.push('');

  /* ── 3. mimic-style power-flow diagram ────────────────────────────── */
  out.push(divider('MIMIC — POWER FLOW', W));
  if (!compact) out.push('');
  out.push(...renderMimic(pv, batNet, gridWatts, load, soc, gridState, W));
  if (!compact) out.push('');

  /* ── 4. headline tag rows ─────────────────────────────────────────── */
  out.push(divider('PRIMARY TAGS', W));
  // BUS voltage and frequency are nominal values — EcoFlow doesn't expose a
  // measured bus voltage directly. We synthesize from out-AC voltage of the
  // first online DPU as an approximation; mark UNCERTAIN quality.
  const busV = avg(dpus.map((d) => d.projection.acOutVol));
  // v1.3.1 (audit rank 20/38) — PV.ARRAY.P / BATT.P.NET / GRID.AC.P / BUS.MAIN.V below each
  // sum or average EVERY SHP2-connected home Core, but used to report the quality of
  // `dpus[0]` alone — the first-sorted ONLINE Core. `dpus` is already `.online`-filtered, so
  // a cloud-wedged Core simply isn't in it: its silent zero contribution to the sum still
  // read 'good' off whichever Core happened to sort first. homeCoreCoverage() is the roster
  // check that catches that (SHP2-connected count vs. how many are actually reporting); an
  // incomplete roster forces 'bad' — the sum is missing a member, not just stale — same as
  // when no Core at all is online.
  const coverage = homeCoreCoverage(data.snap.devices);
  const dpuQual: Quality = !coverage.complete
    ? 'bad'
    : dpus.length
      ? dpus.reduce<Quality>((worst, d) => worseOf(worst, deviceQuality(d)), 'good')
      : 'bad';
  // BUS.MAIN.V is doubly derated: the coverage gate above, AND the synthesized-proxy caveat
  // in the comment above busV — it is never a true measured bus voltage, so 'good' was
  // always wrong when present.
  const busQual: Quality = !coverage.complete ? 'bad' : busV != null ? 'uncertain' : 'bad';

  const tagRows = [
    renderTagRow({
      tag: 'BUS.MAIN.V',
      value: busV != null ? busV.toFixed(1) : '—',
      unit: 'V',
      state: 'normal',
      quality: busQual,
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
      // Was a hardcoded 'N' regardless of state — a warn/alarm SOC glyph
      // could sit next to a flags column still claiming Normal. Derive the
      // letter from the SAME socState() band driving the glyph above.
      flags: `A/L/${alarmLetter(socState(soc))}`,
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
  if (!compact) out.push('');

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
    // Discharge / charge time projections. CHG is gated the same way as index.ts's
    // `backup_charge_minutes` (fleetBatteryNet > 50 W discharge, audit rank 16): SHP2's own
    // backupChargeTimeMin field can hold a stale / PV-forecast ETA while the pool is actively
    // discharging, which would show a charge-completion time during a real drawdown.
    const dchMin = p.backupDischargeTimeMin;
    const chMin = batNet > 50 ? null : p.backupChargeTimeMin;
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

/**
 * Quality ranking for the fleet-aggregate tag rows — WORST of the contributing home Cores
 * wins, never best-of. One comm-good Core must not paper over a comm-bad or entirely-missing
 * one; see the `dpuQual` / `busQual` computation above for the coverage half of this check.
 */
function worseOf(a: Quality, b: Quality): Quality {
  const rank: Record<Quality, number> = { good: 0, stale: 1, uncertain: 2, bad: 3 };
  return rank[b] > rank[a] ? b : a;
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  if (h < 24) return `${h}h ${String(mm).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/* ─── v1.38.0 — big-digit headline band + pool gauge ──────────────────── */

/** SoC → whole-segment colourizer, on the same red<20 / yellow<50 bands as
 *  socState(); null (no reading) renders grey. */
function socColor(soc: number | null | undefined): (s: string) => string {
  const st = socState(soc);
  return st === 'alarm' ? c.red : st === 'warn' ? c.yellow : st === 'comm' ? c.grey : c.green;
}

/** kW figure for the big font: one decimal below 10 kW, whole kW above —
 *  bounds the glyph run so three figures always fit a 96-col band. */
function fmtBigKw(w: number): string {
  const kw = w / 1000;
  return Math.abs(kw) < 10 ? `${kw.toFixed(1)}kW` : `${Math.round(kw)}kW`;
}

/**
 * Big-digit headline band: fleet battery SoC, PV kW and panel-load kW rendered
 * BIG_ROWS tall via bigfont.ts, laid out side by side with a small grey label
 * line above each figure. SoC is colorized by the shared SoC bands; PV is
 * always yellow (solar), LOAD cyan. bigText() output is plain, so segments are
 * measured with .length and colorized whole — never padded after styling.
 * Returns [] when the three figures cannot fit `width` (caller inserts
 * unconditionally and simply gets nothing).
 */
function renderHeadlineBand(
  soc: number | null | undefined,
  pvW: number,
  loadW: number,
  width: number,
): string[] {
  const groups = [
    { label: 'BATT SOC', text: soc != null ? `${Math.round(soc)}%` : '--', paint: socColor(soc) },
    { label: 'PV ARRAY', text: fmtBigKw(pvW), paint: c.yellow },
    { label: 'LOAD', text: fmtBigKw(loadW), paint: c.cyan },
  ];
  const widths = groups.map((g) => bigTextWidth(g.text));
  const sumW = widths.reduce((a, b) => a + b, 0);
  const indent = 2;
  // Spread the figures with up to 8 blank columns between them; if even
  // 1-column gaps cannot fit, degrade to no band at all.
  const gap = Math.min(8, Math.floor((width - indent - sumW) / (groups.length - 1)));
  if (gap < 1) return [];

  let labelRow = ' '.repeat(indent);
  const rows: string[] = Array.from({ length: BIG_ROWS }, () => ' '.repeat(indent));
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const big = bigText(g.text);
    const sep = i > 0 ? ' '.repeat(gap) : '';
    const lbl = g.label.slice(0, widths[i]);
    labelRow += sep + c.grey(lbl) + ' '.repeat(widths[i] - lbl.length);
    for (let r = 0; r < BIG_ROWS; r++) rows[r] += sep + g.paint(big[r]);
  }
  return [labelRow, ...rows];
}

/**
 * Full-width backup-pool gauge line: POOL label + eighth-block hbar spanning
 * the remaining columns + fixed 4-char percent readout. Bar colour follows
 * the shared SoC bands; a missing reading renders an empty grey bar with a
 * grey em-dash readout. Visible layout: 2 indent + 'POOL ' (5) + bar + 1
 * space + 4-char label = exactly `width`.
 */
function renderPoolGauge(soc: number | null | undefined, width: number): string {
  const barW = Math.max(4, width - 12);
  if (soc == null) {
    return '  ' + c.grey('POOL ') + c.grey(hbar(0, barW)) + ' ' + c.grey('   —');
  }
  const frac = soc / 100;
  return '  ' + c.grey('POOL ') + socColor(soc)(hbar(frac, barW)) + ' ' + c.whiteB(fracLabel(frac));
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
