/**
 * Control-room TUI screen renderers.
 *
 * Each `body*` function returns an array of content lines (no frame). The frame
 * — double-line border, title bar, live status strip, and the menu rail — is
 * added by renderScreen(). Layout targets an 80x24 terminal but adapts to
 * whatever size the client negotiates via NAWS.
 */

import type { FleetSnapshot, DeviceSnapshot } from '../snapshot.js';
import type { DpuProjection, DpuPack, Shp2Projection } from '../ecoflow/project.js';
import type { FleetEnergyTotals } from '../aggregator.js';
import type { DayForecast, FleetDegradation } from '../analytics.js';
import type { Alert, Severity } from '../alerts.js';
import { c, BOX, padEnd, padStart, truncate, center, lr, bar, visLen } from './ansi.js';

export const SCREENS = ['overview', 'devices', 'solar', 'battery', 'shp2', 'charger', 'strategy', 'alerts', 'predictive'] as const;
export type ScreenId = (typeof SCREENS)[number];
const SCREEN_LABEL: Record<ScreenId, string> = {
  overview: 'OVERVIEW',
  devices: 'DEVICES',
  solar: 'SOLAR',
  battery: 'BATTERY',
  shp2: 'SHP2',
  charger: 'CHARGER',
  strategy: 'STRATEGY',
  alerts: 'ALERTS',
  predictive: 'PREDICTIVE',
};
const SCREEN_SHORT: Record<ScreenId, string> = {
  overview: 'OVR',
  devices: 'DEV',
  solar: 'SOL',
  battery: 'BAT',
  shp2: 'SHP',
  charger: 'CHG',
  strategy: 'STR',
  alerts: 'ALR',
  predictive: 'PRD',
};

export interface SessionView {
  width: number;
  height: number;
  screen: ScreenId;
  battDpu: number;
  battPack: number;
  alertScroll: number;
}
export interface RenderData {
  snap: FleetSnapshot;
  totals: FleetEnergyTotals | null;
  forecast: DayForecast | null;
  degradation: FleetDegradation;
}

type DpuDev = DeviceSnapshot & { projection?: DpuProjection };
type Shp2Dev = DeviceSnapshot & { projection: Shp2Projection };
type ColorKey = 'red' | 'yellow' | 'green' | 'cyan' | 'grey' | 'white';

/* ───────────────────────── formatting ───────────────────────── */

const MAH_TO_WH = (51.2 * 2) / 1000;
const cToF = (x: number) => (x * 9) / 5 + 32;

function fmtTemp(x: number | null | undefined): string {
  return x == null ? '—' : `${Math.round(cToF(x))}°F`;
}
function fmtW(w: number | null | undefined): string {
  if (w == null) return '—';
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}
function fmtKwh(wh: number | null | undefined): string {
  return wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;
}
function fmtPct(p: number | null | undefined, d = 0): string {
  return p == null ? '—' : `${p.toFixed(d)}%`;
}
function fmtVolt(mv: number | null | undefined): string {
  if (mv == null) return '—';
  return mv > 10000 ? `${(mv / 1000).toFixed(1)} V` : `${(mv / 1000).toFixed(3)} V`;
}
function fmtMins(m: number | null | undefined): string {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  if (h < 24) return `${h}h ${mm}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function hhmm(minOfDay: number): string {
  const h = Math.floor(minOfDay / 60) % 24;
  const m = minOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function dayHour(ts: number): string {
  const d = new Date(ts);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  let h = d.getHours();
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${wd} ${h} ${ap}`;
}

function sum<T>(arr: T[], f: (t: T) => number | null | undefined): number {
  return arr.reduce((s, x) => s + (f(x) ?? 0), 0);
}
function avg(vals: Array<number | null | undefined>): number | null {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function countSetBits(n: number): number {
  let count = 0;
  let x = n >>> 0;
  while (x) {
    count += x & 1;
    x >>>= 1;
  }
  return count;
}

function tempColor(cels: number | null | undefined): ColorKey {
  if (cels == null) return 'grey';
  const f = cToF(cels);
  if (f >= 131) return 'red';
  if (f >= 113) return 'yellow';
  if (f >= 95) return 'yellow';
  if (f >= 60) return 'green';
  return 'cyan';
}
function socColor(soc: number | null | undefined): ColorKey {
  if (soc == null) return 'grey';
  if (soc >= 50) return 'green';
  if (soc >= 25) return 'yellow';
  return 'red';
}
function paint(key: ColorKey, text: string): string {
  return c[key](text);
}

/* ───────────────────────── device helpers ───────────────────────── */

function dpuNumber(name: string): number {
  const m = name.match(/(\d+)/);
  return m ? Number(m[1]) : 999;
}
export function getDpus(snap: FleetSnapshot): DpuDev[] {
  return (Object.values(snap.devices) as DpuDev[])
    .filter((d) => (d.productName ?? '').toLowerCase().includes('delta pro ultra'))
    .sort((a, b) => dpuNumber(a.deviceName) - dpuNumber(b.deviceName));
}
function getShp2(snap: FleetSnapshot): Shp2Dev | undefined {
  return Object.values(snap.devices).find((d) => d.projection?.kind === 'shp2') as Shp2Dev | undefined;
}

/** House AC import — AC input on SHP2-bound DPUs only. A spare DPU self-charging
 *  off a wall outlet must not register as the house being grid-tied. */
function gridAcInWatts(snap: FleetSnapshot): number {
  const shp2 = getShp2(snap);
  const dpus = getDpus(snap).filter((d) => d.online && d.projection);
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const grid = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
  return sum(grid, (d) => d.projection!.acInWatts);
}
function sortedDevices(snap: FleetSnapshot): DeviceSnapshot[] {
  return Object.values(snap.devices).sort((a, b) => {
    const rank = (d: DeviceSnapshot) =>
      d.projection?.kind === 'shp2' ? 0 : (d.productName ?? '').toLowerCase().includes('delta pro ultra') ? 1 : 2;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return dpuNumber(a.deviceName) - dpuNumber(b.deviceName);
    return a.deviceName.localeCompare(b.deviceName);
  });
}

/** "LABEL      value" — grey fixed-width label then value. */
function field(label: string, value: string, labelW = 16): string {
  return c.grey(padEnd(label, labelW)) + value;
}

/** Fixed-width column cell — truncates so there is always ≥1 trailing space. */
function cell(content: string, w: number): string {
  return padEnd(truncate(content, Math.max(1, w - 1)), w);
}

/** Two label/value columns on one line; column 1 is a fixed 44-wide block. */
function twoCol(l1: string, v1: string, l2: string, v2: string): string {
  return '  ' + cell(c.grey(padEnd(l1, 17)) + v1, 44) + c.grey(padEnd(l2, 14)) + v2;
}

/* ───────────────────────── frame ───────────────────────── */

export function renderScreen(sv: SessionView, data: RenderData): string[] {
  const W = sv.width;
  const innerW = W - 2;
  const contentW = W - 4;
  const contentH = Math.max(3, sv.height - 7);
  const body = fit(renderBody(sv, data, contentW, contentH), contentH);

  const out: string[] = [];
  out.push(c.cyan(BOX.tl + BOX.h.repeat(innerW) + BOX.tr));
  out.push(framed(titleLine(sv, contentW), contentW));
  out.push(framed(statusLine(data, contentW), contentW));
  out.push(c.cyan(BOX.lJoint + BOX.h.repeat(innerW) + BOX.rJoint));
  for (const line of body) out.push(framed(line, contentW));
  out.push(c.cyan(BOX.lJoint + BOX.h.repeat(innerW) + BOX.rJoint));
  out.push(framed(menuLine(sv, contentW), contentW));
  out.push(c.cyan(BOX.bl + BOX.h.repeat(innerW) + BOX.br));
  return out;
}

function framed(content: string, contentW: number): string {
  return c.cyan(BOX.v) + ' ' + padEnd(content, contentW) + ' ' + c.cyan(BOX.v);
}
function fit(lines: string[], h: number): string[] {
  const out = lines.slice(0, h);
  while (out.length < h) out.push('');
  return out;
}
function rule(w: number): string {
  return c.grey(BOX.lh.repeat(w));
}

function titleLine(sv: SessionView, w: number): string {
  return lr(
    c.cyanB('ECOFLOW FLEET') + c.dim('  ·  ') + c.whiteB(SCREEN_LABEL[sv.screen]),
    c.white(clock()),
    w,
  );
}

function statusLine(data: RenderData, w: number): string {
  const { snap } = data;
  const dpus = getDpus(snap).filter((d) => d.online && d.projection);
  const shp2 = getShp2(snap);
  const acIn = gridAcInWatts(snap);
  const pv = sum(dpus, (d) => d.projection!.pvTotalWatts);
  const totIn = sum(dpus, (d) => d.projection!.totalInWatts);
  const totOut = sum(dpus, (d) => d.projection!.totalOutWatts);
  const batNet = totOut - totIn;
  const load = shp2 ? sum(shp2.projection.circuits, (cir) => cir.watts) : sum(dpus, (d) => d.projection!.acOutWatts);
  const backup = shp2?.projection.backupBatPercent ?? null;
  const offGrid = acIn < 5;
  const alerts = snap.alerts ?? [];
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;

  const seg: string[] = [];
  seg.push(offGrid ? c.yellowB('OFF-GRID') : c.greenB('GRID-TIED'));
  seg.push(c.grey('BACKUP ') + paint(socColor(backup), fmtPct(backup)));
  seg.push(c.grey('PV ') + c.yellow(fmtW(pv)));
  seg.push(c.grey('LOAD ') + c.white(fmtW(load)));
  const arrow = batNet > 5 ? c.yellow('▼ ') : batNet < -5 ? c.green('▲ ') : '';
  seg.push(c.grey('BATT ') + arrow + c.white(fmtW(Math.abs(batNet))));
  if (crit > 0) seg.push(c.redB(`${crit} CRIT`));
  if (warn > 0) seg.push(c.yellowB(`${warn} WARN`));
  if (crit === 0 && warn === 0) seg.push(c.green('NOMINAL'));

  return padEnd(seg.join(c.grey('  │  ')), w);
}

function menuLine(sv: SessionView, w: number): string {
  const build = (labels: Record<ScreenId, string>) =>
    SCREENS.map(
      (id, i) => c.cyanB(String(i + 1)) + ' ' + (id === sv.screen ? c.invert(labels[id]) : c.grey(labels[id])),
    ).join(' ');
  const quit = c.yellowB('Q') + ' ' + c.yellow('QUIT');
  const full = build(SCREEN_LABEL);
  // Eight screens won't fit a full-label rail at 80 cols — fall back to codes.
  const menu = visLen(full) + 1 + visLen(quit) <= w ? full : build(SCREEN_SHORT);
  return lr(menu, quit, w);
}

/* ───────────────────────── body dispatch ───────────────────────── */

function renderBody(sv: SessionView, data: RenderData, w: number, h: number): string[] {
  switch (sv.screen) {
    case 'overview':
      return bodyOverview(data);
    case 'devices':
      return bodyDevices(data);
    case 'solar':
      return bodySolar(data, w);
    case 'battery':
      return bodyBattery(sv, data, w);
    case 'shp2':
      return bodyShp2(sv, data, w, h);
    case 'charger':
      return bodyCharger(data, w);
    case 'strategy':
      return bodyStrategy(data);
    case 'alerts':
      return bodyAlerts(sv, data, w, h);
    case 'predictive':
      return bodyPredictive(sv, data, w, h);
  }
}

/* ───────────────────────── OVERVIEW ───────────────────────── */

function bodyOverview(data: RenderData): string[] {
  const { snap, totals, forecast } = data;
  const dpus = getDpus(snap).filter((d) => d.online && d.projection);
  const shp2 = getShp2(snap);
  const allDev = Object.values(snap.devices);
  const pv = sum(dpus, (d) => d.projection!.pvTotalWatts);
  const acIn = gridAcInWatts(snap);
  const totIn = sum(dpus, (d) => d.projection!.totalInWatts);
  const totOut = sum(dpus, (d) => d.projection!.totalOutWatts);
  const batNet = totOut - totIn;
  const soc = avg(dpus.map((d) => d.projection!.soc));
  const load = shp2 ? sum(shp2.projection.circuits, (cir) => cir.watts) : sum(dpus, (d) => d.projection!.acOutWatts);
  const activeCircuits = shp2 ? shp2.projection.circuits.filter((cir) => (cir.watts ?? 0) > 1).length : 0;
  const offGrid = acIn < 5;

  const L: string[] = [];
  L.push(c.cyanB('ENERGY FLOW'));
  L.push('  ' + field('Solar', bar(pv / 12000, 16, 'yellow') + ' ' + c.whiteB(fmtW(pv))));
  L.push(
    '  ' + field('Grid', offGrid ? c.grey('islanded — no import') : c.white(fmtW(acIn))),
  );
  const netLbl =
    batNet > 5 ? c.yellow(`▼ discharging ${fmtW(batNet)}`) : batNet < -5 ? c.green(`▲ charging ${fmtW(-batNet)}`) : c.grey('idle');
  L.push('  ' + field('Battery', bar((soc ?? 0) / 100, 16, socColor(soc) === 'red' ? 'red' : socColor(soc) === 'yellow' ? 'yellow' : 'green') + ' ' + paint(socColor(soc), fmtPct(soc, 0)) + '  ' + netLbl));
  L.push('  ' + field('Load', c.whiteB(fmtW(load)) + c.grey(`  ·  ${activeCircuits} active circuits`)));
  L.push('');

  const f = totals?.fleet;
  const cov = f ? `${Math.round(f.coverage * 100)}% measured` : 'no data';
  L.push(c.cyanB('TODAY') + c.dim(`   since local midnight · ${cov}`));
  if (f) {
    const netTag = f.batteryNetWh >= 0 ? 'discharged' : 'charged';
    L.push(twoCol('Solar produced', c.yellow(fmtKwh(f.pvWh)), 'AC output', c.white(fmtKwh(f.acOutWh))));
    L.push(
      twoCol(
        'Panel load',
        c.white(fmtKwh(f.panelLoadWh)),
        'Battery net',
        paint(f.batteryNetWh >= 0 ? 'yellow' : 'green', `${fmtKwh(Math.abs(f.batteryNetWh))} ${netTag}`),
      ),
    );
  } else {
    L.push('  ' + c.grey('energy totals not yet computed'));
  }
  L.push('');

  L.push(c.cyanB('24-HOUR FORECAST') + c.dim(forecast ? `   ${forecast.hasWeather ? 'cloud-aware' : 'typical-day'} · ${forecast.historyDays.toFixed(1)} d history` : ''));
  if (forecast) {
    const [label, col] = outlook(forecast);
    L.push(
      twoCol(
        'Solar next 24h',
        c.yellow(fmtKwh(forecast.forecastPvWhNext24)),
        'Typical/day',
        c.grey(fmtKwh(forecast.typicalPvWhPerDay)),
      ),
    );
    const lowSoc =
      forecast.minProjectedSoc != null
        ? paint(socColor(forecast.minProjectedSoc), fmtPct(forecast.minProjectedSoc)) +
          (forecast.minProjectedSocTs ? c.grey(` @ ${dayHour(forecast.minProjectedSocTs)}`) : '')
        : c.grey('—');
    L.push(twoCol('Projected low', lowSoc, 'Outlook', paint(col, label)));
  } else {
    L.push('  ' + c.grey('forecast computing…'));
  }
  L.push('');

  L.push(c.cyanB('FLEET'));
  const online = allDev.filter((d) => d.online).length;
  L.push(
    '  ' +
      field(
        'Inventory',
        c.white(`${allDev.length} devices`) + c.grey(' · ') + c.green(`${online} online`) + c.grey(' · ') + c.white(`${getDpus(snap).length} DPUs`),
        16,
      ),
  );
  if (shp2) {
    const p = shp2.projection;
    L.push(
      '  ' +
        field(
          'SHP2',
          paint(socColor(p.backupBatPercent), `backup ${fmtPct(p.backupBatPercent)}`) +
            c.grey(` · reserve ${fmtPct(p.backupReserveSoc)}`) +
            (p.chargeWattPower ? c.green(` · charging ${fmtW(p.chargeWattPower)}`) : ''),
          16,
        ),
    );
  }
  return L;
}

function outlook(fc: DayForecast): [string, ColorKey] {
  if (fc.minProjectedSoc == null) return ['UNKNOWN', 'grey'];
  const margin = fc.minProjectedSoc - fc.reserveSoc;
  if (margin <= 0) return ['CRITICAL', 'red'];
  if (margin < 10) return ['TIGHT', 'yellow'];
  if (margin < 25) return ['ADEQUATE', 'green'];
  return ['COMFORTABLE', 'green'];
}

/* ───────────────────────── DEVICES ───────────────────────── */

function bodyDevices(data: RenderData): string[] {
  const devs = sortedDevices(data.snap);
  const L: string[] = [];
  L.push(c.grey(cell('STATUS', 10) + cell('DEVICE', 21) + cell('SOC', 6) + cell('LIVE', 22) + 'SERIAL'));
  for (const d of devs) {
    const stat = d.online ? c.green('● ONLINE') : c.red('○ OFFLINE');
    let soc = '—';
    let live = '';
    const p = d.projection;
    if (p?.kind === 'dpu') {
      soc = paint(socColor(p.soc), fmtPct(p.soc));
      live = c.yellow('PV ' + fmtW(p.pvTotalWatts)) + c.grey(' · ') + c.white('out ' + fmtW(p.totalOutWatts));
    } else if (p?.kind === 'shp2') {
      soc = paint(socColor(p.backupBatPercent), fmtPct(p.backupBatPercent));
      live = c.white('load ' + fmtW(sum(p.circuits, (cir) => cir.watts)));
    } else if (p?.kind === 'generic') {
      soc = p.soc != null ? fmtPct(p.soc) : '—';
      live = p.soc != null || p.outWatts != null ? c.white(fmtW(p.outWatts)) : c.grey('app-only device');
    } else {
      live = c.grey(d.lastError ? 'error 1006 · app-only' : 'no telemetry');
    }
    L.push(
      cell(stat, 10) + cell(c.white(d.deviceName), 21) + cell(soc, 6) + cell(live, 22) + c.grey(d.sn),
    );
  }
  return L;
}

/* ───────────────────────── SOLAR ───────────────────────── */

function bodySolar(data: RenderData, w: number): string[] {
  const dpus = getDpus(data.snap);
  const online = dpus.filter((d) => d.online && d.projection);
  const pvTot = sum(online, (d) => d.projection!.pvTotalWatts);
  const hvTot = sum(online, (d) => d.projection!.pvHighWatts);
  const lvTot = sum(online, (d) => d.projection!.pvLowWatts);

  const L: string[] = [];
  L.push(
    c.cyanB('FLEET PV  ') +
      c.yellowB(fmtW(pvTot)) +
      c.grey('     HV strings ') +
      c.white(fmtW(hvTot)) +
      c.grey('  ·  LV strings ') +
      c.white(fmtW(lvTot)),
  );
  L.push(rule(w));
  for (const d of dpus) {
    const p = d.projection;
    if (!p) {
      L.push(c.white(padEnd(d.deviceName, 10)) + c.grey('  no telemetry'));
      L.push('');
      L.push('');
      continue;
    }
    L.push(
      c.whiteB(padEnd(d.deviceName, 10)) +
        c.grey('total ') +
        c.yellow(padEnd(fmtW(p.pvTotalWatts), 9)) +
        c.grey('MPPT  ') +
        paint(tempColor(p.mpptHvTemp), 'HV ' + fmtTemp(p.mpptHvTemp)) +
        c.grey(' · ') +
        paint(tempColor(p.mpptLvTemp), 'LV ' + fmtTemp(p.mpptLvTemp)),
    );
    L.push('  ' + pvString('HV', p.pvHighVolts, p.pvHighAmps, p.pvHighWatts, p.pvHighErrCode));
    L.push('  ' + pvString('LV', p.pvLowVolts, p.pvLowAmps, p.pvLowWatts, p.pvLowErrCode));
  }
  return L;
}

function pvString(
  tag: string,
  volts: number | null,
  amps: number | null,
  watts: number | null,
  err: number | null,
): string {
  const errTxt = err && err !== 0 ? c.red(`err ${err}`) : c.grey('err 0');
  return (
    c.cyan(padEnd(tag, 4)) +
    c.grey('V ') +
    c.white(padEnd(volts != null ? volts.toFixed(1) : '—', 8)) +
    c.grey('A ') +
    c.white(padEnd(amps != null ? amps.toFixed(2) : '—', 8)) +
    c.grey('W ') +
    c.yellow(padEnd(fmtW(watts), 9)) +
    errTxt
  );
}

/* ───────────────────────── BATTERY ───────────────────────── */

function bodyBattery(sv: SessionView, data: RenderData, w: number): string[] {
  const dpus = getDpus(data.snap);
  if (dpus.length === 0) return [c.grey('No Delta Pro Ultra units discovered.')];
  const di = Math.max(0, Math.min(sv.battDpu, dpus.length - 1));
  const dpu = dpus[di];
  const packs = dpu.projection?.packs ?? [];
  const pi = Math.max(0, Math.min(sv.battPack, 4));
  const selPack = packs.find((p) => p.num === pi + 1);

  const L: string[] = [];
  L.push(
    c.grey('DPU ') +
      c.cyanB('◄ ') +
      c.whiteB(padEnd(dpu.deviceName, 10)) +
      c.cyanB('► ') +
      c.grey('   PACK ') +
      c.cyanB('▲ ') +
      c.whiteB(String(pi + 1)) +
      c.cyanB(' ▼') +
      c.grey('      (arrows navigate)'),
  );
  // Pack table
  L.push(
    c.grey(
      '  ' +
        padEnd('PACK', 7) +
        padEnd('SOC', 7) +
        padEnd('SOH', 9) +
        padEnd('TEMP', 8) +
        padEnd('CELL↑', 8) +
        padEnd('CELL↓', 8) +
        padEnd('SPREAD', 9) +
        padEnd('CYC', 7) +
        'BAL',
    ),
  );
  for (let n = 1; n <= 5; n++) {
    const pk = packs.find((p) => p.num === n);
    const sel = n === pi + 1;
    const marker = sel ? c.cyanB('► ') : '  ';
    if (!pk) {
      L.push(marker + c.grey(padEnd(`P${n}`, 5) + 'absent'));
      continue;
    }
    const soh = pk.actSoh ?? pk.soh;
    const bal = (pk.balanceState ?? 0) !== 0 ? c.cyan(`↻ ${countSetBits(pk.balanceState!)}`) : c.grey('—');
    L.push(
      marker +
        padEnd(sel ? c.whiteB(`P${n}`) : c.white(`P${n}`), 7) +
        padEnd(paint(socColor(pk.soc), fmtPct(pk.soc)), 7) +
        padEnd(c.white(soh != null ? `${soh.toFixed(1)}%` : '—'), 9) +
        padEnd(paint(tempColor(pk.temp), fmtTemp(pk.temp)), 8) +
        padEnd(paint(tempColor(pk.maxCellTemp), fmtTemp(pk.maxCellTemp)), 8) +
        padEnd(paint(tempColor(pk.minCellTemp), fmtTemp(pk.minCellTemp)), 8) +
        padEnd(spreadCell(pk.maxVolDiffMv), 9) +
        padEnd(c.white(pk.cycles != null ? String(pk.cycles) : '—'), 7) +
        bal,
    );
  }
  L.push(rule(w));
  if (!selPack) {
    L.push(c.grey(`Pack ${pi + 1} is not reporting on ${dpu.deviceName}.`));
    return L;
  }
  L.push(...packDetail(selPack, dpu, w, data.degradation));
  return L;
}

function spreadCell(mv: number | null): string {
  if (mv == null) return c.grey('—');
  const txt = `${Math.round(mv)} mV`;
  if (mv > 50) return c.red(txt);
  if (mv > 20) return c.yellow(txt);
  return c.green(txt);
}

function packDetail(pk: DpuPack, dpu: DpuDev, w: number, degradation: FleetDegradation): string[] {
  const L: string[] = [];
  L.push(
    c.cyanB(`${dpu.deviceName.toUpperCase()} · PACK ${pk.num}`) + (pk.packSn ? c.grey(`   ${pk.packSn}`) : ''),
  );
  const cellV = pk.cellVoltagesMv;
  const meanMv = cellV.length ? cellV.reduce((s, v) => s + v, 0) / cellV.length : null;
  const soh = pk.actSoh ?? pk.soh;
  const fullKwh = pk.fullCapMah != null ? (pk.fullCapMah * MAH_TO_WH) / 1000 : null;
  const bal = (pk.balanceState ?? 0) !== 0 ? `${countSetBits(pk.balanceState!)} cell(s)` : 'none';

  const vitals: Array<[string, string]> = [
    ['SoC', pk.soc != null ? `${Math.round(pk.soc)}%` : '—'],
    ['Runtime', fmtMins(pk.remainTimeMin)],
    ['Input', fmtW(pk.inputWatts)],
    ['Output', fmtW(pk.outputWatts)],
    ['Rep temp', fmtTemp(pk.temp)],
    ['Cell max', fmtTemp(pk.maxCellTemp)],
    ['Cell min', fmtTemp(pk.minCellTemp)],
    ['Board', fmtTemp(pk.hwBoardTemp)],
    ['Shunt', fmtTemp(pk.curResTemp)],
    ['MOS max', fmtTemp(pk.maxMosTemp)],
    ['Pack volt', fmtVolt(pk.packVoltageMv)],
    ['Open-circ', fmtVolt(pk.ocvMv)],
    ['Cell mean', meanMv != null ? `${(meanMv / 1000).toFixed(3)} V` : '—'],
    ['Cell spread', pk.maxVolDiffMv != null ? `${pk.maxVolDiffMv} mV` : '—'],
    ['SoH', soh != null ? `${soh.toFixed(2)}%` : '—'],
    ['Cycles', pk.cycles != null ? String(pk.cycles) : '—'],
    ['Capacity', fullKwh != null ? `${fullKwh.toFixed(2)} kWh` : '—'],
    ['Balancing', bal],
  ];
  L.push(c.cyanB('VITALS'));
  L.push(...statGrid(vitals, w));

  // Capacity-fade → end-of-life projection — per-pack SoH regression.
  const deg = degradation.packs.find((p) => p.sn === dpu.sn && p.packNum === pk.num);
  if (deg) {
    L.push(c.cyanB('CAPACITY FADE · END-OF-LIFE'));
    if (deg.status === 'projecting') {
      // Headline carries the fade rate ±1σ and fit quality (free width — no
      // column truncation); the grid carries the dated projection.
      L.push(
        '  ' +
          c.grey('SoH fading ') +
          c.whiteB(
            `${deg.fadePctPerYear}${deg.fadeUncertaintyPct ? ` ±${deg.fadeUncertaintyPct}` : ''} %/yr`,
          ) +
          c.grey('   fit ') +
          c.white(`R² ${deg.r2 != null ? deg.r2.toFixed(2) : '—'}`) +
          c.grey(`   ${deg.dataSpanDays} d of data`),
      );
      const range =
        deg.yearsToEolLow != null
          ? deg.yearsToEolHigh != null
            ? `${deg.yearsToEolLow}–${deg.yearsToEolHigh}`
            : `≥ ${deg.yearsToEolLow}`
          : '—';
      L.push(
        ...statGrid(
          [
            ['Reaches 80%', deg.eolDate != null ? `~${new Date(deg.eolDate).getFullYear()}` : '—'],
            ['Service left', deg.yearsToEol != null ? `${deg.yearsToEol.toFixed(1)} years` : '—'],
            ['Service range', range],
            ['Usage', deg.cyclesPerYear != null ? `${deg.cyclesPerYear} cyc/yr` : '—'],
            ['Cycles now', deg.cycles != null ? String(deg.cycles) : '—'],
            ['Cycles at EOL', deg.projectedCyclesAtEol != null ? `~${deg.projectedCyclesAtEol}` : '—'],
          ],
          w,
        ),
      );
      if (deg.peerOutlier) {
        L.push(
          '  ' +
            c.redB('⚠ peer outlier') +
            c.grey(' — fading ') +
            c.red(`${deg.peerFadeRatio ?? '?'}×`) +
            c.grey(' the fleet-median rate'),
        );
      }
    } else {
      for (const ln of wrapText(deg.summary, w - 2)) L.push('  ' + c.grey(ln));
    }
  }

  L.push(c.cyanB(`CELL TEMPERATURES · ${pk.cellTemps.length}`));
  L.push(...sensorGrid(pk.cellTemps, 'C', w));
  L.push(c.cyanB(`MOSFET TEMPS · ${pk.mosTemps.length}`));
  L.push(...sensorGrid(pk.mosTemps, 'M', w));
  L.push(c.cyanB(`PTC HEATER TEMPS · ${pk.ptcTemps.length}`));
  L.push(...sensorGrid(pk.ptcTemps, 'P', w));
  if (cellV.length > 0 && meanMv != null) {
    L.push(c.cyanB(`CELL VOLTAGES · ${cellV.length}`) + c.grey(`   mean ${(meanMv / 1000).toFixed(3)} V · ±dev coloured`));
    const colW = 13;
    const cols = Math.max(1, Math.floor((w - 2) / colW));
    const vcells = cellV.map((mv, i) => {
      const dev = mv - meanMv;
      const a = Math.abs(dev);
      const col: ColorKey = a > 50 ? 'red' : a > 20 ? 'yellow' : a > 5 ? 'white' : 'green';
      return cell(c.grey(padStart(`C${i + 1}`, 3)) + ' ' + paint(col, (mv / 1000).toFixed(3)), colW);
    });
    for (let i = 0; i < vcells.length; i += cols) L.push('  ' + vcells.slice(i, i + cols).join(''));
  }
  return L;
}

/** Lay [label, value] pairs into aligned fixed-width columns. */
function statGrid(items: Array<[string, string]>, w: number): string[] {
  const colW = 25;
  const cols = Math.max(1, Math.floor((w - 2) / colW));
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += cols) {
    lines.push(
      '  ' +
        items
          .slice(i, i + cols)
          // label cell guarantees a gap; value cell keeps columns aligned
          .map(([l, v]) => c.grey(cell(l, 13)) + cell(c.white(v), 12))
          .join(''),
    );
  }
  return lines;
}

/** Temperature readings laid into an aligned grid. */
function sensorGrid(values: number[], prefix: string, w: number): string[] {
  if (values.length === 0) return ['  ' + c.grey('no data')];
  const colW = 12;
  const cols = Math.max(1, Math.floor((w - 2) / colW));
  const cells = values.map((v, i) => cell(c.grey(`${prefix}${i + 1}`) + ' ' + paint(tempColor(v), fmtTemp(v)), colW));
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += cols) lines.push('  ' + cells.slice(i, i + cols).join(''));
  return lines;
}

/* ───────────────────────── SHP2 ───────────────────────── */

function bodyShp2(sv: SessionView, data: RenderData, w: number, h: number): string[] {
  const shp2 = getShp2(data.snap);
  if (!shp2) return [c.grey('Smart Home Panel 2 not discovered on this account.')];
  const p = shp2.projection;
  const dpus = getDpus(data.snap);
  const nameFor = (sn: string | null) => (sn ? (dpus.find((d) => d.sn === sn)?.deviceName ?? sn) : '—');

  const body: string[] = [];

  body.push(c.cyanB('BACKUP POOL'));
  body.push(
    ...statGrid(
      [
        ['Backup', p.backupBatPercent != null ? `${p.backupBatPercent}%` : '—'],
        ['Reserve', p.backupReserveSoc != null ? `${p.backupReserveSoc}%` : '—'],
        ['Capacity', p.backupFullCapWh != null ? `${(p.backupFullCapWh / 1000).toFixed(2)} kWh` : '—'],
        ['Remaining', p.backupRemainWh != null ? `${(p.backupRemainWh / 1000).toFixed(2)} kWh` : '—'],
        ['Charge W', fmtW(p.chargeWattPower)],
        ['To full', fmtMins(p.backupChargeTimeMin)],
        ['Runtime', fmtMins(p.backupDischargeTimeMin)],
      ],
      w,
    ),
  );

  body.push(c.cyanB('ENERGY SOURCES'));
  body.push(
    c.grey(
      '  ' +
        cell('SLOT', 8) +
        cell('DEVICE', 13) +
        cell('BATTERY', 10) +
        cell('LINK', 13) +
        cell('AC OUT', 9) +
        cell('RATED', 10) +
        'EMS TEMP',
    ),
  );
  for (const s of p.sources) {
    const link = !s.isConnected ? c.grey('empty') : s.hwConnect ? c.green('linked') : c.yellow('no hw link');
    body.push(
      '  ' +
        cell(c.white(`Slot ${s.slot}`), 8) +
        cell(c.white(nameFor(s.sn)), 13) +
        cell(
          s.batteryPercentage != null ? paint(socColor(s.batteryPercentage), `${s.batteryPercentage}%`) : c.grey('—'),
          10,
        ) +
        cell(link, 13) +
        cell(s.isAcOpen ? c.green('open') : c.grey('closed'), 9) +
        cell(c.white(s.ratePower != null ? `${s.ratePower} W` : '—'), 10) +
        paint(tempColor(s.emsBatTemp), fmtTemp(s.emsBatTemp)),
    );
  }

  body.push(c.cyanB(`CIRCUITS · ${p.pairedCircuits.length}`));
  body.push(
    c.grey('  ' + cell('CIRCUIT', 30) + cell('LOAD', 11) + cell('BREAKER', 10) + cell('PHASE', 8) + 'STATE'),
  );
  for (const cir of p.pairedCircuits) {
    const ch = cir.secondaryCh != null ? `ch${cir.primaryCh}+${cir.secondaryCh}` : `ch${cir.primaryCh}`;
    body.push(
      '  ' +
        cell(c.white(cir.name) + c.grey(' ' + ch), 30) +
        cell(c.whiteB(fmtW(cir.watts)), 11) +
        cell(c.white(cir.breakerAmps != null ? `${cir.breakerAmps} A` : '—'), 10) +
        cell(cir.isSplitPhase ? c.cyan('240 V') : c.grey('120 V'), 8) +
        (cir.loadIsEnable === false ? c.red('shed') : c.green('on')),
    );
  }

  const head = [c.cyanB('SMART HOME PANEL 2') + c.grey('   ' + shp2.sn), rule(w)];
  return head.concat(paginate(body.map((l) => [l]), sv.alertScroll, Math.max(2, h - 2)));
}

/* ───────────────────────── CHARGER ───────────────────────── */

function bodyCharger(data: RenderData, w: number): string[] {
  const dpus = getDpus(data.snap);
  const core4 = dpus.find((d) => dpuNumber(d.deviceName) === 4);
  const shp2 = getShp2(data.snap);
  const L: string[] = [];
  L.push(c.cyanB('EV CHARGER') + c.dim('   monitored via Core 4 AC output — the EVSE itself is app-only'));
  L.push(rule(w));

  const acOut = core4?.projection?.acOutWatts ?? null;
  const charging = acOut != null && acOut > 500;
  L.push(
    '  ' +
      field('Status', charging ? c.greenB(`CHARGING  ${fmtW(acOut)}`) : c.grey('IDLE — no charge draw detected')),
  );
  if (core4 && core4.projection) {
    const p = core4.projection;
    L.push(
      '  ' +
        field('Core 4 AC out', c.whiteB(fmtW(p.acOutWatts))) +
        c.grey('   ') +
        c.white(padEnd(p.acOutVol != null ? `${p.acOutVol.toFixed(1)} V` : '—', 10)) +
        c.white(p.acOutFreq != null ? `${p.acOutFreq.toFixed(1)} Hz` : '—'),
    );
    L.push(
      '  ' +
        field('Core 4 host', paint(socColor(p.soc), `SoC ${fmtPct(p.soc)}`) + c.grey(`   out ${fmtW(p.totalOutWatts)}  ·  in ${fmtW(p.totalInWatts)}`)),
    );
  } else {
    L.push('  ' + c.grey('Core 4 telemetry unavailable.'));
  }
  L.push('');
  L.push(c.cyanB('SHP2 GARAGE CIRCUITS') + c.dim('   the EVSE feeds the garage subpanel'));
  if (shp2) {
    for (const ch of [5, 7]) {
      const cir = shp2.projection.circuits.find((x) => x.ch === ch);
      if (!cir) continue;
      L.push(
        '  ' +
          c.grey(`ch${ch}  `) +
          cell(c.white(cir.name), 24) +
          cell(c.whiteB(fmtW(cir.watts)), 11) +
          c.grey(cir.setAmp != null ? `${cir.setAmp} A breaker` : ''),
      );
    }
  } else {
    L.push('  ' + c.grey('SHP2 not available.'));
  }
  return L;
}

/* ───────────────────────── STRATEGY ───────────────────────── */

function bodyStrategy(data: RenderData): string[] {
  const shp2 = getShp2(data.snap);
  if (!shp2) return [c.grey('SHP2 not available — strategy data comes from the Smart Home Panel.')];
  const s = shp2.projection.strategy;
  const L: string[] = [];

  L.push(c.cyanB('LOAD MANAGEMENT'));
  L.push(
    '  ' +
      cell(c.grey(padEnd('Load shedding', 18)) + (s.loadShedEnabled ? c.green('ENABLED') : c.grey('disabled')), 30) +
      c.grey(s.loadShedConfigured ? '(configured)' : '(not configured)'),
  );
  L.push(
    '  ' +
      cell(
        c.grey(padEnd('Backup reserve', 18)) + paint(socColor(s.backupReserveSoc), fmtPct(s.backupReserveSoc)),
        30,
      ) +
      c.grey(s.backupReserveEnabled ? 'enabled' : 'disabled') +
      (s.solarBackupReserveSoc != null ? c.grey(`   solar reserve ${fmtPct(s.solarBackupReserveSoc)}`) : ''),
  );
  L.push(
    '  ' +
      field('Modes', c.white(`backup ${s.backupMode ?? '—'}  ·  overload ${s.overloadMode ?? '—'}  ·  smart ${s.smartBackupMode ?? '—'}`), 18),
  );
  if (s.midPriorityDischargeFloorSoc != null) {
    L.push('  ' + field('Mid-prio floor', paint(socColor(s.midPriorityDischargeFloorSoc), fmtPct(s.midPriorityDischargeFloorSoc)), 18));
  }
  L.push('');

  L.push(c.cyanB('CIRCUIT PRIORITIES'));
  const circuits = shp2.projection.pairedCircuits;
  L.push(c.grey('  ' + cell('CIRCUIT', 32) + cell('BREAKER', 11) + cell('PRIORITY', 12) + 'STATE'));
  for (const cir of circuits.slice(0, 8)) {
    const tag = cir.isSplitPhase ? c.grey(' (240V)') : '';
    L.push(
      '  ' +
        cell(c.white(cir.name) + tag, 32) +
        cell(c.white(cir.breakerAmps != null ? `${cir.breakerAmps} A` : '—'), 11) +
        cell(c.white(cir.loadPriority != null ? `level ${cir.loadPriority}` : '—'), 12) +
        (cir.loadIsEnable === false ? c.red('disabled') : c.green('enabled')),
    );
  }
  L.push('');

  L.push(c.cyanB('CHARGE SCHEDULE') + c.dim('   time-of-use'));
  const t = s.timeTask;
  if (t) {
    L.push(
      '  ' +
        field('Task', (t.isEnabled ? c.green('ENABLED') : c.grey('disabled')) + c.grey(`  ${t.type ?? ''}  ${t.timeMode ?? ''}`), 14),
    );
    L.push(
      '  ' +
        field('Charge', c.white(`${fmtW(t.chargeWatts)}  ·  ceiling ${fmtPct(t.chargeCeilingSoc)}  ·  floor ${fmtPct(t.chargeFloorSoc)}`), 14),
    );
    const winText =
      t.windows.length > 0
        ? t.windows.map((tw) => `${hhmm(tw.startMinute)}–${hhmm(tw.endMinute)}`).join(', ')
        : 'none';
    L.push('  ' + field('Windows', c.cyan(winText), 14));
  } else {
    L.push('  ' + c.grey('No charge schedule configured.'));
  }
  return L;
}

/* ───────────────────────── ALERTS + PREDICTIVE ───────────────────────── */

function sevRank(s: Severity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}
/** "1 alert" / "3 alerts" — count with a correctly pluralized noun. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
/** Fixed 4-column severity tag. */
function sevTag(s: Severity): string {
  return s === 'critical' ? c.redB('CRIT') : s === 'warning' ? c.yellowB('WARN') : c.cyan('INFO');
}

/** Two stacked subject cells — Core then Pack — as 9-wide inverse-video boxes. */
function subjectCells(a: Alert): [string, string] {
  if (a.coreNum != null) {
    return [
      c.invert(center(`CORE ${a.coreNum}`, 9)),
      c.invert(center(`PACK ${a.packNum ?? '-'}`, 9)),
    ];
  }
  const tag =
    a.device === 'System'
      ? 'SYSTEM'
      : a.category === 'SHP2'
        ? 'SHP2'
        : a.category === 'Grid'
          ? 'GRID'
          : a.category === 'Connectivity'
            ? 'LINK'
            : a.category.toUpperCase();
  return [c.invert(center(tag, 9)), c.invert(center('', 9))];
}

/** Slice blocks — each possibly a different height — to fit `avail` lines.
 *  Scrolling advances a whole block at a time, so no block is ever split and
 *  no wrapped detail text is clipped mid-sentence. */
function paginate(blocks: string[][], scroll: number, avail: number): string[] {
  if (blocks.length === 0) return [];
  const total = blocks.reduce((acc, b) => acc + b.length, 0);
  const overflow = total > avail;
  const budget = overflow ? avail - 1 : avail; // reserve a row for the scroll hint

  // Furthest start index from which every remaining block still fits the budget.
  let maxScroll = 0;
  if (overflow) {
    maxScroll = blocks.length - 1;
    for (let i = blocks.length - 1, used = 0; i >= 0; i--) {
      used += blocks[i].length;
      if (used <= budget) maxScroll = i;
      else break;
    }
  }
  const s = Math.max(0, Math.min(scroll, maxScroll));

  const out: string[] = [];
  let used = 0;
  let shown = 0;
  for (let i = s; i < blocks.length; i++) {
    const bh = blocks[i].length;
    if (shown > 0 && used + bh > budget) break;
    out.push(...blocks[i]);
    used += bh;
    shown++;
  }
  if (overflow) {
    out.push(c.grey(`  ▲▼ scroll — ${s + 1}-${s + shown} of ${blocks.length}`));
  }
  return out;
}

/** Word-wrap a plain (un-coloured) string to lines no wider than `width`. */
function wrapText(s: string, width: number): string[] {
  const w = Math.max(8, width);
  const lines: string[] = [];
  let cur = '';
  for (let word of s.split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      // Hard-break a word that cannot fit on a line by itself.
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Pack "label value" fact chips greedily onto lines no wider than `width`. */
function wrapFacts(facts: Array<{ label: string; value: string }>, width: number): string[] {
  const sep = '  ·  ';
  const lines: string[] = [];
  let parts: string[] = [];
  let plainLen = 0;
  const flush = () => {
    if (parts.length) lines.push(parts.join(c.grey(sep)));
    parts = [];
    plainLen = 0;
  };
  for (const f of facts) {
    const plain = `${f.label} ${f.value}`;
    const chip = c.grey(f.label + ' ') + c.white(f.value);
    if (plain.length > width) {
      // A single fact wider than the line — give it its own truncated row.
      flush();
      lines.push(truncate(chip, width));
      continue;
    }
    if (parts.length && plainLen + sep.length + plain.length > width) flush();
    plainLen += (parts.length ? sep.length : 0) + plain.length;
    parts.push(chip);
  }
  flush();
  return lines;
}

function bodyAlerts(sv: SessionView, data: RenderData, w: number, h: number): string[] {
  const alerts = (data.snap.alerts ?? [])
    .filter((a) => a.source !== 'learned')
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const info = alerts.filter((a) => a.severity === 'info').length;

  const L: string[] = [];
  L.push(
    c.cyanB(plural(alerts.length, 'THRESHOLD ALERT', 'THRESHOLD ALERTS')) +
      c.grey('     ') +
      c.red(`${crit} critical`) +
      c.grey(' · ') +
      c.yellow(`${warn} warning`) +
      c.grey(' · ') +
      c.white(`${info} info`),
  );
  L.push(rule(w));
  if (alerts.length === 0) {
    L.push('');
    L.push('  ' + c.green('● All systems nominal — no threshold alerts.'));
    return L;
  }
  const blocks = alerts.map((a) => {
    const [c1, c2] = subjectCells(a);
    const detail = wrapText(a.detail, w - 15);
    const block = [
      c1 + ' ' + sevTag(a.severity) + ' ' + lr(c.whiteB(a.title), c.grey(a.category), w - 15),
      c2 + '      ' + c.grey(detail[0] ?? ''),
    ];
    for (const extra of detail.slice(1)) block.push(' '.repeat(15) + c.grey(extra));
    return block;
  });
  return L.concat(paginate(blocks, sv.alertScroll, Math.max(2, h - 2)));
}

function bodyPredictive(sv: SessionView, data: RenderData, w: number, h: number): string[] {
  const learned = (data.snap.alerts ?? []).filter((a) => a.source === 'learned');
  const anomalies = learned
    .filter((a) => !a.id.startsWith('forecast-'))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const forecasts = learned
    .filter((a) => a.id.startsWith('forecast-'))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity));

  const L: string[] = [];
  L.push(
    c.cyanB(plural(learned.length, 'LEARNED SIGNAL', 'LEARNED SIGNALS')) +
      c.grey('     ') +
      c.white(plural(anomalies.length, 'anomaly', 'anomalies')) +
      c.grey(' · ') +
      c.white(plural(forecasts.length, 'forecast', 'forecasts')) +
      c.grey('     peer comparison · self-baseline · trend projection'),
  );
  L.push(rule(w));
  if (learned.length === 0) {
    L.push('');
    L.push('  ' + c.green('● Learned engine sees nothing unusual — no anomalies or forecasts.'));
    return L;
  }
  const blocks = [...anomalies, ...forecasts].map((a) => {
    const [c1, c2] = subjectCells(a);
    const detail = wrapText(a.detail, w - 15);
    const block = [
      c1 + ' ' + sevTag(a.severity) + ' ' + lr(c.whiteB(a.title), c.grey(a.category), w - 15),
      c2 + '      ' + c.grey(detail[0] ?? ''),
    ];
    for (const extra of detail.slice(1)) block.push(' '.repeat(15) + c.grey(extra));
    for (const fl of wrapFacts(a.facts ?? [], w - 15)) block.push(' '.repeat(15) + fl);
    return block;
  });
  return L.concat(paginate(blocks, sv.alertScroll, Math.max(3, h - 2)));
}
