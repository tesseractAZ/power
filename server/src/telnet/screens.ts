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
import type { Alert } from '../alerts.js';
import { c, BOX, padEnd, padStart, truncate, center, lr, bar, visLen } from './ansi.js';
// v0.11.0 — derive the 4-tier ISA-18.2 / IEC 62682 alarm priority for display.
import { priorityOf, priorityMeta, comparePriority, type AlarmPriority } from '../alertPriority.js';
// v0.36.0 — the SHP2 is the grid interconnect; grid is a BACKSTOP tapped
// automatically when the pool hits its reserve floor (or for rebalancing). The
// resolver gives us three states to surface: ACTIVE (grid carrying the home now),
// AVAILABLE (present/declared but on standby), and OFF-GRID (islanded). homeGridWatts
// (SHP2 main) catches the backstop path that DPU ac_in import alone is blind to.
import { liveGridBackstop } from '../gridState.js';
import { isSourceDpuStale, shp2ConnectedDpuSns, aggregateFleetFlow } from '../shp2Membership.js';

// v0.15.15 — the CHARGER screen was removed with the web Charger tab: the EVSE
// is app-only (no API/MQTT telemetry) and its host DPU (Core 4) is an offline
// spare, so the screen could only ever render dead/absent data.
export const SCREENS = ['overview', 'devices', 'solar', 'battery', 'shp2', 'strategy', 'alerts', 'predictive'] as const;
export type ScreenId = (typeof SCREENS)[number];
const SCREEN_LABEL: Record<ScreenId, string> = {
  overview: 'OVERVIEW',
  devices: 'DEVICES',
  solar: 'SOLAR',
  battery: 'BATTERY',
  shp2: 'SHP2',
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

// Each pack is 32S1P (~104 V nominal; 32 series cells whose mV sum to packVoltageMv).
// fullCap is single-string mAh; Wh = mAh × (32 × 3.2 V) / 1000 = mAh × 0.1024.
const MAH_TO_WH = (32 * 3.2) / 1000;   // = 0.1024 Wh/mAh (was (51.2 * 2)/1000, same value)
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

/** v0.36.0 — classify the grid into the three operator-facing states using the
 *  GridBackstop resolver (homeGridWatts = SHP2 main grid into the home; importWatts
 *  = DPU ac_in). `active` carries the live carrying-power (the SHP2 main backstop
 *  preferred, falling back to DPU ac_in import) so the caller can render the flow. */
type GridState = 'active' | 'standby' | 'islanded';
interface GridStatus {
  state: GridState;
  /** Watts the grid is carrying into the home, when active (else 0). */
  watts: number;
  reason: string;
}
function gridStatus(snap: FleetSnapshot): GridStatus {
  const g = liveGridBackstop(snap.devices);
  if (!g.present) return { state: 'islanded', watts: 0, reason: g.reason };
  // Any measured flow on either path ⇒ the grid is carrying the home right now.
  const watts = g.homeGridWatts > 0 ? g.homeGridWatts : g.importWatts;
  if (watts > 0) return { state: 'active', watts, reason: g.reason };
  // Present/declared but no measured flow — the backstop is on standby.
  return { state: 'standby', watts: 0, reason: g.reason };
}

/** v0.46.0 — battery NET power for ONE OR MORE explicitly-passed DPUs, from per-pack
 *  cell flow, NOT DPU throughput. DPU `totalOut − totalIn` is throughput (PV+grid in /
 *  AC out) and overstates the rate; the true battery DC flow is Σ over every DPU pack of
 *  (outputWatts − inputWatts). Sign: POSITIVE = discharging, NEGATIVE = charging.
 *
 *  v0.96.0 — this is now the PER-DPU / raw-list primitive only (e.g. a single device
 *  row). FLEET-level callers must NOT pass a hand-filtered online list here: use
 *  `aggregateFleetFlow(devices).fleetBatteryNet` instead, which is the SAME value the
 *  authoritative `fleet_battery_net_watts` HA sensor emits (online AND SHP2-connected
 *  membership). The old fleet callers passed all online DPUs including the spare Cores,
 *  whose bench/PV pack flow (never on the home bus) leaked a phantom multi-kW term into
 *  the header while the sensor correctly excluded it. Collapse the method, keep one
 *  measurement. */
export function fleetBatteryNetWatts(onlineDpus: DpuDev[]): number {
  let net = 0;
  for (const d of onlineDpus) {
    for (const pk of d.projection!.packs) net += (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0);
  }
  return net;
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
    c.cyanB('POWER FLEET') + c.dim('  ·  ') + c.whiteB(SCREEN_LABEL[sv.screen]),
    c.white(clock()),
    w,
  );
}

function statusLine(data: RenderData, w: number): string {
  const { snap } = data;
  const dpus = getDpus(snap).filter((d) => d.online && d.projection);
  const shp2 = getShp2(snap);
  const pv = sum(dpus, (d) => d.projection!.pvTotalWatts);
  // v0.96.0 — read the SAME fleet battery-net the `fleet_battery_net_watts` HA sensor
  // emits (aggregateFleetFlow = online AND SHP2-connected), not a local sum over all
  // online DPUs — the latter leaked spare-Core bench/PV pack flow into the header.
  const batNet = aggregateFleetFlow(snap.devices).fleetBatteryNet;
  const load = shp2 ? sum(shp2.projection.circuits, (cir) => cir.watts) : sum(dpus, (d) => d.projection!.acOutWatts);
  const backup = shp2?.projection.backupBatPercent ?? null;
  // v0.36.0 — three grid states from the backstop resolver, not just off-grid vs tied.
  const grid = gridStatus(snap);
  const alerts = snap.alerts ?? [];
  // v0.11.0 — count by the 4-tier ISA priority instead of raw severity.
  const pc = prioCounts(alerts);

  const seg: string[] = [];
  seg.push(
    grid.state === 'islanded'
      ? c.yellowB('OFF-GRID')
      : grid.state === 'active'
        ? c.greenB('GRID ' + fmtW(grid.watts) + ' →')
        : c.cyan('GRID standby'),
  );
  seg.push(c.grey('BACKUP ') + paint(socColor(backup), fmtPct(backup)));
  seg.push(c.grey('PV ') + c.yellow(fmtW(pv)));
  seg.push(c.grey('LOAD ') + c.white(fmtW(load)));
  const arrow = batNet > 5 ? c.yellow('▼ ') : batNet < -5 ? c.green('▲ ') : '';
  seg.push(c.grey('BATT ') + arrow + c.white(fmtW(Math.abs(batNet))));
  if (pc.critical > 0) seg.push(prioColor('critical')(`${pc.critical} CRIT`));
  if (pc.high > 0) seg.push(prioColor('high')(`${pc.high} HIGH`));
  if (pc.medium > 0) seg.push(prioColor('medium')(`${pc.medium} MED`));
  if (pc.low > 0) seg.push(prioColor('low')(`${pc.low} LOW`));
  if (pc.critical === 0 && pc.high === 0 && pc.medium === 0 && pc.low === 0) seg.push(c.green('NOMINAL'));

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
  // v0.46.0 — battery net = Σ per-pack (outputWatts − inputWatts); +discharge/−charge.
  // DPU throughput (totalOut − totalIn) overstated the rate and is no longer used.
  // v0.96.0 — sourced from aggregateFleetFlow (online AND SHP2-connected), the exact
  // basis of the `fleet_battery_net_watts` HA sensor, so the header can no longer show
  // a spare Core's bench/PV pack flow as a phantom fleet discharge.
  const batNet = aggregateFleetFlow(snap.devices).fleetBatteryNet;
  const soc = avg(dpus.map((d) => d.projection!.soc));
  const load = shp2 ? sum(shp2.projection.circuits, (cir) => cir.watts) : sum(dpus, (d) => d.projection!.acOutWatts);
  const activeCircuits = shp2 ? shp2.projection.circuits.filter((cir) => (cir.watts ?? 0) > 1).length : 0;
  // v0.36.0 — the SHP2 is the grid interconnect; grid backstops the home (active),
  // sits available on standby, or is islanded. Surface all three, not just off-grid.
  const grid = gridStatus(snap);

  const L: string[] = [];
  L.push(c.cyanB('ENERGY FLOW'));
  L.push('  ' + field('Solar', bar(pv / 12000, 16, 'yellow') + ' ' + c.whiteB(fmtW(pv))));
  const gridVal =
    grid.state === 'islanded'
      ? c.grey('off-grid — islanded')
      : grid.state === 'active'
        ? c.green('▲ backstop ') + c.whiteB(fmtW(grid.watts)) + c.grey(' → home')
        : c.cyan('available') + c.grey('  (standby/backstop)');
  L.push('  ' + field('Grid', gridVal));
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
    const [label, col] = outlook(forecast, liveGridBackstop(snap.devices).backstopping);
    L.push(
      twoCol(
        'Solar next 24h',
        // v0.95.0 (re-audit #7) — match the HA sensor + web tiles (restored full-fleet
        // display basis), not the alarm-conservative reporting-only raw sum. The runway
        // alarm path is untouched (it reads hours[].forecastPvW, not this display field).
        c.yellow(fmtKwh(forecast.forecastPvWhNext24Display ?? forecast.forecastPvWhNext24)),
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
            // v0.95.0 (re-audit #4) — chargeWattPower is the CONFIGURED AC charge-rate
            // LIMIT (== strategy.timeTask.chargeWatts), NOT live charge power — it reads
            // 7.2 kW even while the SHP2 is idle/backstopping. Label it as a limit (matching
            // bus.ts "CHG PWR LIMIT") so a static setpoint is never shown as live charging.
            (p.chargeWattPower ? c.grey(` · chg limit ${fmtW(p.chargeWattPower)}`) : ''),
          16,
        ),
    );
  }
  return L;
}

// v0.95.0 (re-audit #5) — grid-aware, mirroring the forecast-soc-dip narrative and
// runwayAlarm.classifyRunway: while the grid is backstopping the home, a projected dip
// to/through the reserve floor is islanded-only (the SHP2 transfers to mains at the
// floor), so the headline reads amber "CRIT if islanded" instead of a red CRITICAL that
// misreads as an active emergency on a healthy grid-tied home. Off-grid → unchanged red.
function outlook(fc: DayForecast, backstopping = false): [string, ColorKey] {
  if (fc.minProjectedSoc == null) return ['UNKNOWN', 'grey'];
  const margin = fc.minProjectedSoc - fc.reserveSoc;
  if (margin <= 0) return backstopping ? ['CRIT if islanded', 'yellow'] : ['CRITICAL', 'red'];
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
    // v0.49.0 — a core/panel that EcoFlow Cloud reports offline kept its
    // last-known projection in the snapshot store, so showing PV/out/load here
    // would imply live telemetry from a device we can't currently reach. Frame
    // it honestly as cloud-offline (last-known SoC stays useful) rather than as
    // a live reading — the old "zombie" framing is gone fleet-wide.
    if (p && !d.online) {
      if (p.kind === 'dpu') soc = paint(socColor(p.soc), fmtPct(p.soc));
      else if (p.kind === 'shp2') soc = paint(socColor(p.backupBatPercent), fmtPct(p.backupBatPercent));
      else if (p.kind === 'generic' && p.soc != null) soc = fmtPct(p.soc);
      // Fits the 22-wide LIVE cell (must stay ≤21 visible chars).
      live = c.grey('cloud-offline (held)');
    } else if (p?.kind === 'dpu') {
      soc = paint(socColor(p.soc), fmtPct(p.soc));
      // Per-pack battery flow (+discharge/−charge) alongside PV — the battery
      // direction the throughput "out" number alone never conveyed. `d` is a DPU
      // device in this branch (p.kind narrowed to 'dpu').
      const bat = fleetBatteryNetWatts([d as DpuDev]);
      const batTag = bat > 5 ? c.yellow('▼ ' + fmtW(bat)) : bat < -5 ? c.green('▲ ' + fmtW(-bat)) : c.grey('idle');
      live = c.yellow('PV ' + fmtW(p.pvTotalWatts)) + c.grey(' · bat ') + batTag;
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
  // v0.44.0 — today's PV produced, with the "% measured" reading PV-ONLY coverage
  // (fleet.pvCoverage, gated on the SHP2-connected PV membership), not the
  // all-metric mean — a PV-specific data-completeness number for a PV readout.
  const f = data.totals?.fleet;
  if (f) {
    L.push(
      c.grey('TODAY  ') +
        c.yellow(fmtKwh(f.pvWh)) +
        c.grey(' produced  ·  ') +
        c.white(`${Math.round((f.pvCoverage ?? f.coverage) * 100)}% measured`) +
        c.dim(' (PV coverage)'),
    );
  }
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
  let di = Math.max(0, Math.min(sv.battDpu, dpus.length - 1));
  // v0.51.0 — if the selected DPU has no packs reporting (the default index 0 is
  // Core 1, which is cloud-offline), open the per-pack grid on the first DPU that
  // IS reporting so the screen shows real data instead of an all-"absent" grid.
  // The offline core is still surfaced in the FLEET BATT / offline-freeze header.
  if ((dpus[di].projection?.packs?.length ?? 0) === 0) {
    const firstLive = dpus.findIndex((d) => (d.projection?.packs?.length ?? 0) > 0);
    if (firstLive >= 0) di = firstLive;
  }
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

  // v0.46.0 — fleet battery NET from per-pack flow (+discharge/−charge). v0.45.0 —
  // surface the offline-FREEZE state: an SHP2-connected core that's cloud-offline
  // keeps its last-known lifetime contribution HELD (so one offline core no longer
  // stalls the whole fleet's battery counters). Name the held cores so the operator
  // can see who's contributing live vs. carried-across-offline.
  // v0.96.0 — fleetNet from aggregateFleetFlow (online AND SHP2-connected), matching the
  // `fleet_battery_net_watts` HA sensor exactly; the held-cores line below names the
  // SHP2-connected cores that are cloud-offline (carried, not summed live).
  const fleetNet = aggregateFleetFlow(data.snap.devices).fleetBatteryNet;
  const connectedSns = shp2ConnectedDpuSns(data.snap.devices);
  const heldCores = dpus.filter((d) => connectedSns.has(d.sn) && !d.online).map((d) => d.deviceName);
  const netTag =
    fleetNet > 5 ? c.yellow(`▼ discharging ${fmtW(fleetNet)}`)
      : fleetNet < -5 ? c.green(`▲ charging ${fmtW(-fleetNet)}`)
        : c.grey('idle');
  L.push(
    c.grey('FLEET BATT ') + netTag +
      c.grey('   ') +
      (heldCores.length > 0
        ? c.yellow(`⚠ ${heldCores.length} core${heldCores.length > 1 ? 's' : ''} cloud-offline · held from last-known: `) + c.grey(heldCores.join(', '))
        : c.grey('all connected cores live')),
  );
  if (dpu.online === false) {
    L.push('  ' + c.yellow('● This core is cloud-offline — values are last-known, not live.'));
  }
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
    // Display-only clamp: a couple near-new packs report fullCap > designCap so
    // actSoh lands at ~100.4%. The degradation engine/recorder keep the raw value.
    const soh0 = pk.actSoh ?? pk.soh;
    const soh = soh0 == null ? null : Math.min(100, soh0);
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
  // Display-only clamp (see matrix above): raw fullCap > designCap pushes actSoh
  // slightly over 100% on near-new packs; the analytics engine keeps the raw value.
  const soh0 = pk.actSoh ?? pk.soh;
  const soh = soh0 == null ? null : Math.min(100, soh0);
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

  // v0.45.0 — lifetime charge & discharge are INDEPENDENT coulomb counters
  // (accuChgCap / accuDsgCap). The old `discharge ≤ charge` clamp was a category
  // error and was removed: over a window that ends at a lower SoC than the
  // baseline, cumulative DISCHARGE legitimately EXCEEDS charge. Show both honestly
  // (Wh = mAh × 0.1024) — never imply they should be equal or that this is an RTE.
  const chgKwh = pk.accuChgMah != null ? (pk.accuChgMah * MAH_TO_WH) / 1000 : null;
  const dsgKwh = pk.accuDsgMah != null ? (pk.accuDsgMah * MAH_TO_WH) / 1000 : null;
  if (chgKwh != null || dsgKwh != null) {
    L.push(c.cyanB('LIFETIME ENERGY') + c.dim('   independent coulomb counters · discharge>charge is normal'));
    L.push(
      ...statGrid(
        [
          ['Charged', chgKwh != null ? `${chgKwh.toFixed(1)} kWh` : '—'],
          ['Discharged', dsgKwh != null ? `${dsgKwh.toFixed(1)} kWh` : '—'],
          ['Cycles', pk.cycles != null ? String(pk.cycles) : '—'],
        ],
        w,
      ),
    );
  }

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

  // v0.36.0 — the SHP2 is the grid interconnect; the grid is a BACKSTOP tapped
  // automatically when the pool hits its reserve floor (or for rebalancing).
  // Surface the three states (active backstop / available standby / islanded)
  // from the resolver, then the underlying measured watts on both grid paths.
  const grid = liveGridBackstop(data.snap.devices);
  const state: GridState = !grid.present
    ? 'islanded'
    : grid.homeGridWatts > 0 || grid.importWatts > 0
      ? 'active'
      : 'standby';
  body.push(c.cyanB('GRID SUPPLY') + c.grey('   SHP2 is the grid interconnect'));
  const statusVal =
    state === 'islanded'
      ? c.yellowB('OFF-GRID — islanded')
      : state === 'active'
        ? c.greenB('▲ BACKSTOPPING') +
          c.grey(' — grid carrying ') +
          c.whiteB(fmtW(grid.homeGridWatts > 0 ? grid.homeGridWatts : grid.importWatts)) +
          c.grey(' → home')
        : c.cyan('AVAILABLE') + c.grey(' — standby (battery/PV covering)');
  body.push('  ' + field('Status', statusVal, 14));
  // v0.44.0 — "Home grid" is the SHP2-main meter (wattInfo.gridWatt): the
  // authoritative WHOLE-HOME grid power. "DPU charge" is DPU ac_in — only grid
  // that charges the batteries, NOT whole-home load — kept as a sub-reading so
  // the two scopes are never conflated (the v0.44.0 grid-import correction).
  body.push(
    ...statGrid(
      [
        ['Home grid', `${fmtW(p.gridWatt ?? grid.homeGridWatts)}`],
        ['DPU charge', `${fmtW(grid.importWatts)}`],
        ['Present', grid.present ? (grid.importLive ? 'live' : grid.declared ? 'declared' : 'yes') : 'no'],
      ],
      w,
    ),
  );

  body.push(c.cyanB('BACKUP POOL'));
  body.push(
    ...statGrid(
      [
        ['Backup', p.backupBatPercent != null ? `${p.backupBatPercent}%` : '—'],
        ['Reserve', p.backupReserveSoc != null ? `${p.backupReserveSoc}%` : '—'],
        ['Capacity', p.backupFullCapWh != null ? `${(p.backupFullCapWh / 1000).toFixed(2)} kWh` : '—'],
        ['Remaining', p.backupRemainWh != null ? `${(p.backupRemainWh / 1000).toFixed(2)} kWh` : '—'],
        // v0.95.0 (re-audit #4) — chargeWattPower is the configured charge-rate LIMIT,
        // not live charge power (reads 7.2 kW while idle). Label accordingly, matching
        // bus.ts "CHG PWR LIMIT".
        ['Charge limit', fmtW(p.chargeWattPower)],
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
    // v0.40.1 — the SHP2 still counts this slot's battery, but its DPU is itself
    // cloud-offline (stale telemetry). Observability note only; capacity unchanged.
    const dpuStale = isSourceDpuStale(s, data.snap.devices);
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
        paint(tempColor(s.emsBatTemp), fmtTemp(s.emsBatTemp)) +
        (dpuStale ? c.yellow('  ⚠ DPU telemetry stale (battery still counted)') : ''),
    );
  }

  body.push(c.cyanB(`CIRCUITS · ${p.pairedCircuits.length}`));
  body.push(
    c.grey('  ' + cell('CIRCUIT', 30) + cell('LOAD', 11) + cell('BREAKER', 10) + cell('PHASE', 8) + 'STATE'),
  );
  for (const cir of p.pairedCircuits) {
    const ch = cir.secondaryCh != null ? `ch${cir.primaryCh}+${cir.secondaryCh}` : `ch${cir.primaryCh}`;
    // v0.47.0 — loadIsEnable=false means the circuit is DISABLED (turned off in
    // the SHP2, e.g. Pool Pump), NOT actively shed. Mark it as such; don't imply
    // an automatic load-shed event.
    const stateCell =
      cir.loadIsEnable === false ? c.grey('disabled') : c.green('enabled');
    body.push(
      '  ' +
        cell((cir.loadIsEnable === false ? c.grey(cir.name) : c.white(cir.name)) + c.grey(' ' + ch), 30) +
        cell(c.whiteB(fmtW(cir.watts)), 11) +
        cell(c.white(cir.breakerAmps != null ? `${cir.breakerAmps} A` : '—'), 10) +
        cell(cir.isSplitPhase ? c.cyan('240 V') : c.grey('120 V'), 8) +
        stateCell,
    );
  }

  const head = [c.cyanB('SMART HOME PANEL 2') + c.grey('   ' + shp2.sn), rule(w)];
  return head.concat(paginate(body.map((l) => [l]), sv.alertScroll, Math.max(2, h - 2)));
}

/* ───────────────────────── STRATEGY ───────────────────────── */

function bodyStrategy(data: RenderData): string[] {
  const shp2 = getShp2(data.snap);
  // v0.47.0 — the gate is online-aware: a cloud-offline SHP2's strategy config is
  // stale, not authoritative. Require online before presenting it as live config.
  if (!shp2 || !shp2.online) {
    return [c.grey('SHP2 not online — strategy data comes from the Smart Home Panel.')];
  }
  const proj = shp2.projection;
  const s = proj.strategy;
  const L: string[] = [];

  L.push(c.cyanB('LOAD MANAGEMENT'));
  L.push(
    '  ' +
      cell(c.grey(padEnd('Load shedding', 18)) + (s.loadShedEnabled ? c.green('ENABLED') : c.grey('disabled')), 30) +
      c.grey(s.loadShedConfigured ? '(configured)' : '(not configured)'),
  );
  // v0.47.0 — read the CANONICAL projection.backupReserveSoc (the flat field the
  // grid-aware floor alarm, grid-backstop, and the HA backup_reserve_percent
  // sensor all act on), NOT strategy.backupReserveSoc (pd303_mc-preferred decode).
  // They agree today but could silently diverge; the displayed reserve must never
  // disagree with the reserve defending the home.
  L.push(
    '  ' +
      cell(
        c.grey(padEnd('Backup reserve', 18)) + paint(socColor(proj.backupReserveSoc), fmtPct(proj.backupReserveSoc)),
        30,
      ) +
      c.grey(s.backupReserveEnabled ? 'enabled' : 'disabled') +
      (s.solarBackupReserveSoc != null ? c.grey(`   solar reserve ${fmtPct(s.solarBackupReserveSoc)}`) : ''),
  );
  // v0.47.0 — smart/backup/overload are RAW SHP2 enum codes (live 2/0/0); the repo
  // carries no authoritative EcoFlow enum semantics, so show the codes honestly
  // and label them as codes rather than fabricating "smart"/"backup" meanings.
  L.push(
    '  ' +
      field('Mode codes', c.white(`smart ${s.smartBackupMode ?? '—'}  ·  backup ${s.backupMode ?? '—'}  ·  overload ${s.overloadMode ?? '—'}`), 18) +
      c.dim('  (raw SHP2 codes)'),
  );
  if (s.midPriorityDischargeFloorSoc != null) {
    L.push('  ' + field('Mid-prio floor', paint(socColor(s.midPriorityDischargeFloorSoc), fmtPct(s.midPriorityDischargeFloorSoc)), 18));
  }
  L.push('');

  // v0.47.0 — shed order. The SHP2's NATIVE loadPriority convention (verified live
  // against the running SHP2: Pool Pump=25=highest=shed-FIRST, a subpanel=1=shed-
  // LAST) is the OPPOSITE polarity of the internal loadShedRegistry ("1 = shed
  // first"). Different priority systems — do NOT unify. Sort ASCENDING so the
  // most-protected (kept longest) sort to the top, and caption the direction
  // correctly. Disabled circuits (loadIsEnable=false) are pinned to the bottom and
  // clearly marked rather than ranked as active shed participants.
  L.push(c.cyanB('CIRCUIT SHED ORDER') + c.dim('   ascending = most-protected (shed LAST) · higher # sheds FIRST'));
  const prio = (cir: { loadPriority: number | null }) => cir.loadPriority ?? Number.POSITIVE_INFINITY;
  const ranked = [...proj.pairedCircuits].sort((a, b) => {
    const ea = a.loadIsEnable === false ? 1 : 0;
    const eb = b.loadIsEnable === false ? 1 : 0;
    if (ea !== eb) return ea - eb; // enabled circuits first, disabled pinned last
    return prio(a) - prio(b);      // then most-protected (low #) → shed-first (high #)
  });
  L.push(c.grey('  ' + cell('CIRCUIT', 32) + cell('BREAKER', 11) + cell('PRIORITY', 12) + 'STATE'));
  for (const cir of ranked.slice(0, 8)) {
    const disabled = cir.loadIsEnable === false;
    const tag = cir.isSplitPhase ? c.grey(' (240V)') : '';
    const nameCol = disabled ? c.grey(cir.name) + tag : c.white(cir.name) + tag;
    const prioCol = cir.loadPriority != null ? `#${cir.loadPriority}` : '—';
    L.push(
      '  ' +
        cell(nameCol, 32) +
        cell(c.white(cir.breakerAmps != null ? `${cir.breakerAmps} A` : '—'), 11) +
        cell(disabled ? c.grey(prioCol) : c.white(prioCol), 12) +
        (disabled ? c.grey('disabled · off in SHP2') : c.green('enabled')),
    );
  }
  L.push('');

  L.push(c.cyanB('CHARGE SCHEDULE') + c.dim('   time-of-use'));
  const t = s.timeTask;
  if (t) {
    // v0.47.0 — the windows are only operative when BOTH the task is enabled AND
    // the time-range gate (rangeEnabled) is on. When either is off the timeline is
    // configured-but-inactive — label it "Configured" (not "Active") and note the
    // gate so a disabled schedule isn't read as a live charge window.
    const gated = t.isEnabled && t.rangeEnabled;
    const taskState = t.isEnabled ? c.green('ENABLED') : c.grey('disabled');
    L.push(
      '  ' +
        field('Task', taskState + c.grey(`  ${t.type ?? ''}  ${t.timeMode ?? ''}`), 14),
    );
    L.push(
      '  ' +
        field('Charge', c.white(`${fmtW(t.chargeWatts)}  ·  ceiling ${fmtPct(t.chargeCeilingSoc)}  ·  floor ${fmtPct(t.chargeFloorSoc)}`), 14),
    );
    const winText =
      t.windows.length > 0
        ? t.windows.map((tw) => `${hhmm(tw.startMinute)}–${hhmm(tw.endMinute)}`).join(', ')
        : 'none';
    const winLabel = gated ? 'Windows' : 'Windows (cfg)';
    const winNote = gated
      ? ''
      : c.grey(`   ${!t.isEnabled ? 'task disabled' : 'time-range gate disabled'} — not active`);
    L.push('  ' + field(winLabel, (gated ? c.cyan(winText) : c.grey(winText)) + winNote, 14));
  } else {
    L.push('  ' + c.grey('No charge schedule configured.'));
  }
  return L;
}

/* ───────────────────────── ALERTS + PREDICTIVE ───────────────────────── */

/** "1 alert" / "3 alerts" — count with a correctly pluralized noun. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
/** ANSI colourizer for an ISA priority. No orange in the 16-colour TUI palette,
 *  so High shares Critical's bright-red; Medium = bright-yellow; Low = cyan. */
function prioColor(p: AlarmPriority): (s: string) => string {
  return p === 'critical' ? c.redB : p === 'high' ? c.redB : p === 'medium' ? c.yellowB : c.cyan;
}
/** Priority tag (CRIT/HIGH/MED/LOW) coloured for the alarm rows. */
function prioTag(a: Alert): string {
  const p = priorityOf(a);
  return prioColor(p)(priorityMeta(p).tag);
}
/** Tally a list of alerts into the four ISA priority buckets. */
function prioCounts(alerts: Alert[]): Record<AlarmPriority, number> {
  const out: Record<AlarmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of alerts) out[priorityOf(a)]++;
  return out;
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
    .sort((a, b) => comparePriority(priorityOf(a), priorityOf(b)));
  const pc = prioCounts(alerts);

  const L: string[] = [];
  L.push(
    c.cyanB(plural(alerts.length, 'THRESHOLD ALERT', 'THRESHOLD ALERTS')) +
      c.grey('     ') +
      prioColor('critical')(`${pc.critical} critical`) +
      c.grey(' · ') +
      prioColor('high')(`${pc.high} high`) +
      c.grey(' · ') +
      prioColor('medium')(`${pc.medium} medium`) +
      c.grey(' · ') +
      prioColor('low')(`${pc.low} low`),
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
      c1 + ' ' + prioTag(a) + ' ' + lr(c.whiteB(a.title), c.grey(a.category), w - 15),
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
    .sort((a, b) => comparePriority(priorityOf(a), priorityOf(b)));
  const forecasts = learned
    .filter((a) => a.id.startsWith('forecast-'))
    .sort((a, b) => comparePriority(priorityOf(a), priorityOf(b)));

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
      c1 + ' ' + prioTag(a) + ' ' + lr(c.whiteB(a.title), c.grey(a.category), w - 15),
      c2 + '      ' + c.grey(detail[0] ?? ''),
    ];
    for (const extra of detail.slice(1)) block.push(' '.repeat(15) + c.grey(extra));
    for (const fl of wrapFacts(a.facts ?? [], w - 15)) block.push(' '.repeat(15) + fl);
    return block;
  });
  return L.concat(paginate(blocks, sv.alertScroll, Math.max(3, h - 2)));
}
