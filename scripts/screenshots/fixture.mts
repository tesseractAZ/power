/**
 * fixture.mts — the synthetic fleet the README screenshots are rendered from (v1.193.0).
 *
 * WHY. The five images in docs/screenshots/ were captured from a live installation with its serials
 * masked by SHAPE (16-character tokens) and its circuit names replaced. A device name EcoFlow assigns
 * by default ends in the last four digits of the unit's serial, which is not serial-shaped, so it
 * reached two of the images; everything else on them (device names, the accessory list, circuit
 * wiring, recurring charging sessions, pack warranty dates, energy totals) described one household
 * by design. A redaction pass cannot be relied on to know every field that identifies a home, so the
 * images are rendered from this fleet instead: every device, serial, figure and history point below
 * is made up, and nothing is read from an installation.
 *
 * WHAT. Seven devices (one Smart Home Panel 2 with three DELTA Pro Ultra Cores in slots 1-3, an EV
 * charger, a DELTA 3 Plus and an offline Smart Generator) at a FIXED clock, FIXTURE_NOW_MS (a clear
 * June noon in America/Phoenix, the add-on's default zone). One minute-step model drives everything
 * that changes with time — PV per Core (clear sky, clipped while the pool sits at its charge limit),
 * every circuit's load, the Cores' AC output and the pool's state of charge — so the dashboard's
 * cards, its charts and the analytics pages agree with each other. ROUTES holds one payload builder
 * per GET endpoint the web UI reads; serve.mts serves them, and capture.mts drives the real built UI
 * against it.
 *
 * Serials are placeholders (a 4-character made-up model code, then [X0]{10} and a two-digit index:
 * the shape scripts/check-no-secrets.py accepts), device names are product names, and circuits carry
 * the panel's own default names. PURE: every builder takes the clock from FIXTURE_NOW_MS or its
 * caller; nothing here reads the wall clock, the network or the disk.
 */
import type {
  Alert,
  AmbientThermalReport,
  ChargeCurveReport,
  CircuitHistory,
  ClearedHistoryPage,
  ClearedHistoryRow,
  ConfidenceSnapshot,
  CurtailmentReport,
  DayForecast,
  DeviceSnapshot,
  DeviceSolarModel,
  DpuPack,
  DpuProjection,
  EquipmentHealth,
  EvWindowPrediction,
  FleetDegradation,
  FleetSnapshot,
  FleetThermalEvents,
  ForecastSkillReport,
  GridBackstop,
  Incident,
  InternalResistanceReport,
  NwsAlert,
  PackDegradation,
  RoundTripEfficiency,
  RunwayProjection,
  SelfConsumption,
  ShadeReport,
  Shp2Circuit,
  Shp2PairedCircuit,
  Shp2Projection,
  Site,
  SoilingDecomposition,
  SolarResponseModel,
  StringMismatchReport,
} from '../../web/src/types.js';

/* ── clock and site ─────────────────────────────────────────────────────── */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Wed 17 Jun 2026 12:30 in America/Phoenix (UTC-7 all year: no daylight saving). */
export const FIXTURE_NOW_MS = Date.UTC(2026, 5, 17, 19, 30);
export const SITE_ZONE = 'America/Phoenix';
const UTC_OFFSET_H = -7;

/** The shipped FORECAST_LAT/LON default (a city centroid, allowlisted by check-no-secrets.py). */
const SITE_LAT = 33.4484;
const SITE_LON = -112.074;

const localHour = (t: number): number => ((((t / HOUR) + UTC_OFFSET_H) % 24) + 24) % 24;
const localDow = (t: number): number => new Date(t + UTC_OFFSET_H * HOUR).getUTCDay();
/** The site midnight that starts the day holding `t`. */
export const localDayStart = (t: number): number => Math.floor((t + UTC_OFFSET_H * HOUR) / DAY) * DAY - UTC_OFFSET_H * HOUR;
const localYmd = (t: number): string => new Date(t + UTC_OFFSET_H * HOUR).toISOString().slice(0, 10);

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Deterministic noise in [-1, 1] for (seed, i): an integer hash, no state. */
function hashNoise(seed: number, i: number): number {
  let x = Math.imul(seed | 0, 374761393) ^ Math.imul(i | 0, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}
/** Noise that drifts smoothly: hashNoise on a 10-minute grid, interpolated. */
function smoothNoise(seed: number, t: number): number {
  const u = t / (10 * MIN);
  const i = Math.floor(u);
  const f = u - i;
  return hashNoise(seed, i) * (1 - f) + hashNoise(seed, i + 1) * f;
}
/** Distance between two hours of the day on the 24 h circle. */
const hourDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 24;
  return d > 12 ? 24 - d : d;
};

/* ── identities ─────────────────────────────────────────────────────────── */

export interface Identity { sn: string; deviceName: string; productName: string; online: boolean }

export const PANEL_SN = 'PANEXXX00XXX0001';
export const CORE_SNS = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'] as const;
const EVSE_SN = 'EVSEXXX00XXX0001';
const DELTA_SN = 'DLT3XXX00XXX0001';
const GENERATOR_SN = 'GENRXXX00XXX0001';

/** The seven devices: the page header reads "7 devices · 6 online". The Cores keep the productName
 *  the web UI selects them by (App.tsx: 'delta pro ultra'). */
export const IDENTITIES: readonly Identity[] = [
  { sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true },
  { sn: CORE_SNS[0], deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true },
  { sn: CORE_SNS[1], deviceName: 'Core 2', productName: 'DELTA Pro Ultra', online: true },
  { sn: CORE_SNS[2], deviceName: 'Core 3', productName: 'DELTA Pro Ultra', online: true },
  { sn: EVSE_SN, deviceName: 'EV Charger', productName: 'EV Charger', online: true },
  { sn: DELTA_SN, deviceName: 'DELTA 3 Plus', productName: 'DELTA 3 Plus', online: true },
  { sn: GENERATOR_SN, deviceName: 'Smart Generator', productName: 'Smart Generator', online: false },
];

const PACKS_PER_CORE = 5;
export const packSn = (core: number, pack: number): string => `PACKXXX00XXX00${core}${pack}`;
/** Every serial the fixture renders: the seven devices and the fifteen packs. */
export const FIXTURE_SERIALS: readonly string[] = [
  ...IDENTITIES.map((d) => d.sn),
  ...[1, 2, 3].flatMap((c) => Array.from({ length: PACKS_PER_CORE }, (_, i) => packSn(c, i + 1))),
];
export const FIXTURE_NAMES: readonly string[] = IDENTITIES.map((d) => d.deviceName);

/* ── the plant model ────────────────────────────────────────────────────── */

/** 10 HV + 4 LV panels of 410 W on each Core: 42 panels, 17.2 kWp. The panel COUNT is the add-on's
 *  default layout because the Energy flow card captions its Solar node "42 panels" whatever the site
 *  sends (energyFlowModel.ts solarSubtitle); any other count would put two contradicting arrays on the
 *  README's images. The wattage is the fixture's own. */
const PV_STRINGS = { hv: { count: 10, watts: 410 }, lv: { count: 4, watts: 410 } };
/** Each Core's clear-sky peak (W), a little apart so the per-Core lines separate. */
const CORE_PV_PEAK_W = [4260, 4150, 4090];
const HV_SHARE = PV_STRINGS.hv.count / (PV_STRINGS.hv.count + PV_STRINGS.lv.count);
/** Pack nameplate (60 Ah x 102.4 V) and the pool the panel reports (15 packs). */
const PACK_DESIGN_MAH = 60_000;
const MAH_TO_WH = (32 * 3.2) / 1000;
const POOL_NAMEPLATE_WH = 3 * PACKS_PER_CORE * PACK_DESIGN_MAH * MAH_TO_WH;
/** The packs' measured full-charge capacity as a share of nameplate (the runway's basis). */
const CAPACITY_SCALE = 0.97;
const POOL_WH = POOL_NAMEPLATE_WH * CAPACITY_SCALE;
const RESERVE_PCT = 25;
const CHARGE_LIMIT_PCT = 90;
/** The packs' charge acceptance tapers over the last TAPER_PCT below the limit (the constant-voltage
 *  phase), so PV is clipped gradually as the pool fills. */
const TAPER_PCT = 15;
const MAX_CHARGE_W = 3 * 7200;
const CHARGE_EFF = 0.95;
const DISCHARGE_EFF = 0.94;
const OVERHEAD_W = 60;
/** Each Core's offset from the pool's state of charge, and its share of the house load. */
const CORE_SOC_OFFSET = [-0.6, 0.8, -0.2];
const CORE_LOAD_SHARE = [0.34, 0.33, 0.33];

function clearSky(h: number): number {
  const rise = 5.45;
  const set = 19.55;
  if (h <= rise || h >= set) return 0;
  return Math.pow(Math.sin((Math.PI * (h - rise)) / (set - rise)), 1.35);
}
/** Two short cloud passes on the afternoon before; every other minute is clear. */
function cloudFactor(t: number): number {
  const day = localDayStart(t);
  const yesterday = localDayStart(FIXTURE_NOW_MS) - DAY;
  if (day !== yesterday) return 1;
  const h = localHour(t);
  if (h >= 15.2 && h < 15.45) return 0.62;
  if (h >= 16.1 && h < 16.25) return 0.71;
  return 1;
}
/** One Core's available PV (W) before any clipping at the charge limit. */
function corePvPotentialW(core: number, t: number): number {
  const cs = clearSky(localHour(t));
  if (cs === 0) return 0;
  return CORE_PV_PEAK_W[core] * cs * cloudFactor(t) * (1 + 0.012 * smoothNoise(11 + core, t));
}

/** EV sessions on the charger's circuit: the recurring Wednesday-evening one, and two others. */
interface EvSession { startMs: number; hours: number; watts: number }
const EV_PATTERN = { dayOfWeek: 3, startHour: 18, startMinute: 30, hours: 1.5, watts: 7700 };
function evSessions(): EvSession[] {
  const out: EvSession[] = [];
  const today = localDayStart(FIXTURE_NOW_MS);
  // The recurring session: every Wednesday 18:30 for 1.5 h, today's included (predicted).
  for (let w = 4; w >= 0; w--) {
    // Last week's ran long: the pool reached the reserve before sunrise and the grid took the house.
    const hours = w === 1 ? 3.2 : EV_PATTERN.hours;
    out.push({ startMs: today - w * 7 * DAY + (EV_PATTERN.startHour * 60 + EV_PATTERN.startMinute) * MIN, hours, watts: EV_PATTERN.watts });
  }
  // Two one-off sessions that do not recur.
  out.push({ startMs: today - 4 * DAY + 9.75 * HOUR, hours: 1.2, watts: 6200 });
  out.push({ startMs: today - 11 * DAY + 20.25 * HOUR, hours: 0.8, watts: 7300 });
  return out;
}
const EV_SESSIONS = evSessions();
function evW(t: number): number {
  for (const s of EV_SESSIONS) if (t >= s.startMs && t < s.startMs + s.hours * HOUR) return s.watts;
  return 0;
}

function acW(t: number): number {
  const d = hourDist(localHour(t), 16.5);
  return 1750 + 1600 * Math.exp(-((d / 5.5) ** 2)) + 90 * smoothNoise(21, t);
}
const cookingW = (t: number): number => 650 * Math.exp(-(((localHour(t) - 18.4) / 0.7) ** 2));
const morningW = (t: number): number => 380 * Math.exp(-(((localHour(t) - 6.9) / 0.6) ** 2));
function waterHeaterW(t: number): number {
  const h = localHour(t);
  return (h >= 6.15 && h < 6.6) || (h >= 19.3 && h < 19.75) ? 4500 : 0;
}
function officeW(t: number): number {
  const h = localHour(t);
  const dow = localDow(t);
  return dow >= 1 && dow <= 5 && h >= 8 && h < 17 ? 160 : 0;
}

/** A circuit group as the panel pairs it: split-phase pairs carry the primary channel's name. */
interface CircuitDef {
  primaryCh: number;
  secondaryCh: number | null;
  breakerAmps: number;
  loadPriority: number;
  loadIsEnable: boolean;
  watts: (t: number) => number;
}
export const CIRCUITS: readonly CircuitDef[] = [
  { primaryCh: 1, secondaryCh: 2, breakerAmps: 40, loadPriority: 9, loadIsEnable: true, watts: evW },
  { primaryCh: 3, secondaryCh: 4, breakerAmps: 30, loadPriority: 4, loadIsEnable: true, watts: acW },
  { primaryCh: 5, secondaryCh: null, breakerAmps: 20, loadPriority: 1, loadIsEnable: true, watts: (t) => 190 + cookingW(t) + morningW(t) + 12 * smoothNoise(31, t) },
  { primaryCh: 6, secondaryCh: null, breakerAmps: 20, loadPriority: 2, loadIsEnable: true, watts: (t) => 95 + 8 * smoothNoise(32, t) },
  { primaryCh: 7, secondaryCh: null, breakerAmps: 15, loadPriority: 3, loadIsEnable: true, watts: (t) => 60 + 5 * smoothNoise(33, t) },
  { primaryCh: 8, secondaryCh: null, breakerAmps: 20, loadPriority: 5, loadIsEnable: true, watts: (t) => 140 + officeW(t) + 10 * smoothNoise(34, t) },
  { primaryCh: 9, secondaryCh: 10, breakerAmps: 30, loadPriority: 8, loadIsEnable: true, watts: waterHeaterW },
  { primaryCh: 11, secondaryCh: null, breakerAmps: 15, loadPriority: 6, loadIsEnable: true, watts: (t) => 35 + 4 * smoothNoise(35, t) },
  { primaryCh: 12, secondaryCh: null, breakerAmps: 20, loadPriority: 7, loadIsEnable: false, watts: () => 0 },
];
const circuitName = (ch: number): string => `Circuit ${ch}`;
const houseLoadW = (t: number): number => CIRCUITS.reduce((s, c) => s + c.watts(t), 0);

/**
 * The minute-step simulation behind every time series: from SIM_START to the end of the forecast
 * horizon. While the pool sits at its charge limit the Cores clip their PV to what the house takes
 * (the curtailment the Solar page reports); while it sits at the reserve floor the grid carries the
 * house. `islanded` drops the floor (the runway's "if the grid went down") and `withEv` keeps the
 * predicted EV session in the load (the forecast does, the runway does not).
 */
interface Sim { start: number; soc: Float64Array; pv: Float64Array[]; out: Float64Array[]; load: Float64Array; grid: Float64Array }
const SIM_START = localDayStart(FIXTURE_NOW_MS) - 10 * DAY;
const SIM_END = FIXTURE_NOW_MS + 26 * HOUR;
const SIM_START_SOC = 62;

function simulate(from: number, to: number, soc0: number, opts: { islanded: boolean; withEv: boolean }): Sim {
  const n = Math.round((to - from) / MIN) + 1;
  const sim: Sim = {
    start: from,
    soc: new Float64Array(n),
    pv: [new Float64Array(n), new Float64Array(n), new Float64Array(n)],
    out: [new Float64Array(n), new Float64Array(n), new Float64Array(n)],
    load: new Float64Array(n),
    grid: new Float64Array(n),
  };
  let soc = soc0;
  for (let i = 0; i < n; i++) {
    const t = from + i * MIN;
    const ev = evW(t);
    const load = houseLoadW(t) - (opts.withEv || t <= FIXTURE_NOW_MS ? 0 : ev);
    const pot = [0, 1, 2].map((c) => corePvPotentialW(c, t));
    const potSum = pot[0] + pot[1] + pot[2];
    const draw = load / DISCHARGE_EFF + OVERHEAD_W;
    const accept = MAX_CHARGE_W * Math.min(1, Math.max(0, (CHARGE_LIMIT_PCT - soc) / TAPER_PCT));
    let pvScale = 1;
    let gridCarries = false;
    if (potSum * CHARGE_EFF > draw + accept) {
      pvScale = (draw + accept) / CHARGE_EFF / potSum; // clipped: PV meets the house and what the packs accept
    } else if (!opts.islanded && soc <= RESERVE_PCT && potSum * CHARGE_EFF < draw) {
      gridCarries = true; // the panel holds the reserve; the grid takes the house
    }
    let pvSum = 0;
    for (let c = 0; c < 3; c++) {
      const pv = pot[c] * pvScale;
      sim.pv[c][i] = pv;
      pvSum += pv;
      sim.out[c][i] = gridCarries ? 0 : load * CORE_LOAD_SHARE[c];
    }
    sim.load[i] = load;
    sim.grid[i] = gridCarries ? load : 0;
    sim.soc[i] = soc;
    if (!gridCarries) soc += ((pvSum * CHARGE_EFF - draw) / POOL_WH) * 100 / 60;
    soc = Math.min(CHARGE_LIMIT_PCT, Math.max(opts.islanded ? 0 : RESERVE_PCT, soc));
  }
  return sim;
}

let past: Sim | null = null;
let forward: Sim | null = null;
let islandedNoEv: Sim | null = null;
/** The recorded past (to FIXTURE_NOW_MS), then the forecast run and the islanded runway run from it. */
function sims(): { past: Sim; forward: Sim; islanded: Sim } {
  if (!past) {
    past = simulate(SIM_START, FIXTURE_NOW_MS, SIM_START_SOC, { islanded: false, withEv: true });
    const socNow = past.soc[past.soc.length - 1];
    forward = simulate(FIXTURE_NOW_MS, SIM_END, socNow, { islanded: false, withEv: true });
    islandedNoEv = simulate(FIXTURE_NOW_MS, SIM_END, socNow, { islanded: true, withEv: false });
  }
  return { past, forward: forward!, islanded: islandedNoEv! };
}
const at = (sim: Sim, t: number): number => Math.max(0, Math.min(sim.soc.length - 1, Math.round((t - sim.start) / MIN)));

/** The pool's state of charge at FIXTURE_NOW_MS. */
export const poolSocNow = (): number => { const { past: p } = sims(); return p.soc[p.soc.length - 1]; };
const coreSoc = (core: number, poolSoc: number): number => poolSoc + CORE_SOC_OFFSET[core];

/** Per-minute values of one recorded metric over [from, to] (inclusive), or null for an unmodelled one. */
function metricAt(sn: string, metric: string): ((i: number, sim: Sim) => number) | null {
  const core = (CORE_SNS as readonly string[]).indexOf(sn);
  if (core >= 0) {
    if (metric === 'pv_total') return (i, s) => s.pv[core][i];
    if (metric === 'total_out') return (i, s) => s.out[core][i];
    if (metric === 'soc') return (i, s) => coreSoc(core, s.soc[i]);
    return null;
  }
  if (sn !== PANEL_SN) return null;
  if (metric === 'panel_load') return (i, s) => s.load[i];
  if (metric === 'backup_pct') return (i, s) => s.soc[i];
  let m = /^src([123])_pct$/.exec(metric);
  if (m) { const c = Number(m[1]) - 1; return (i, s) => coreSoc(c, s.soc[i]); }
  m = /^src([123])_w$/.exec(metric);
  if (m) { const c = Number(m[1]) - 1; return (i, s) => s.out[c][i]; }
  m = /^(ch|pair)(\d+)_w$/.exec(metric);
  if (m) {
    const ch = Number(m[2]);
    const def = CIRCUITS.find((c) => c.primaryCh === ch || c.secondaryCh === ch);
    if (!def) return null;
    const split = def.secondaryCh != null;
    if (m[1] === 'pair' && (!split || def.primaryCh !== ch)) return null;
    // A split-phase pair's legs each carry half; `pair<N>_w` is the pair's total.
    const share = m[1] === 'pair' || !split ? 1 : 0.5;
    return (i, s) => def.watts(s.start + i * MIN) * share;
  }
  return null;
}

/** True when the fixture models this metric for this device (serve.mts reports any other). */
export const historyMetricKnown = (sn: string, metric: string): boolean => metricAt(sn, metric) != null;

/** GET /api/history: bucket means (or one point a minute) of a modelled metric, up to the clock. */
export function historySeries(sn: string, metric: string, sinceMs: number, untilMs: number, bucketSec?: number): Array<{ ts: number; value: number }> {
  const f = metricAt(sn, metric);
  if (!f) return [];
  const { past: p } = sims();
  const from = Math.max(sinceMs, p.start);
  const to = Math.min(untilMs, FIXTURE_NOW_MS);
  const step = Math.max(1, Math.round((bucketSec ?? 60) / 60));
  const pct = metric.includes('soc') || metric.endsWith('_pct');
  const out: Array<{ ts: number; value: number }> = [];
  const first = Math.ceil((from - p.start) / MIN);
  const last = Math.floor((to - p.start) / MIN);
  for (let i = first; i + step - 1 <= last; i += step) {
    let sum = 0;
    for (let k = 0; k < step; k++) sum += f(i + k, p);
    const v = sum / step;
    out.push({ ts: p.start + i * MIN, value: pct ? r1(v) : Math.round(v) });
  }
  return out;
}

/** Energy (Wh) of a per-minute series over [from, to). */
function energyWh(sim: Sim, series: (i: number) => number, from: number, to: number): number {
  let wh = 0;
  for (let i = at(sim, from); i < at(sim, to); i++) wh += series(i) / 60;
  return wh;
}

/* ── the snapshot (the /ws frame) ───────────────────────────────────────── */

/** Which pack balances, and the two packs with a wide cell spread (the alerts and the matrix agree). */
const BALANCING = { core: 1, pack: 3 };
const SPREAD_CRITICAL = { core: 3, pack: 2, mv: 58, cell: 17, deltaMv: -41 };
const SPREAD_WARNING = { core: 2, pack: 4, mv: 26 };

const PACK_SOH = [
  [98.4, 98.1, 97.9, 98.2, 97.6],
  [97.3, 96.8, 97.1, 96.1, 97.5],
  [96.6, 95.4, 96.2, 96.8, 95.9],
];
const PACK_CYCLES = [
  [186, 184, 189, 182, 190],
  [211, 208, 214, 205, 209],
  [247, 252, 244, 240, 249],
];
const PACK_SOC_OFFSET = [0.4, -0.3, 0.1, -0.5, 0.3];
const PACK_TEMP_C = [
  [31.2, 31.8, 32.4, 31.5, 30.9],
  [32.1, 32.6, 33.0, 33.4, 32.2],
  [31.6, 33.8, 32.5, 31.9, 32.0],
];

function cellVoltages(core: number, pack: number, soc: number): number[] {
  const base = 3312 + Math.round((soc - 70) * 1.4);
  const spread = core === SPREAD_CRITICAL.core && pack === SPREAD_CRITICAL.pack
    ? 17
    : core === SPREAD_WARNING.core && pack === SPREAD_WARNING.pack ? SPREAD_WARNING.mv : 6 + ((core * 5 + pack * 3) % 7);
  const cells = Array.from({ length: 32 }, (_, k) => base + Math.round(((hashNoise(core * 10 + pack, k) + 1) / 2) * spread));
  if (core === SPREAD_CRITICAL.core && pack === SPREAD_CRITICAL.pack) {
    // One deviant cell, low, as the critical alert names it.
    cells[SPREAD_CRITICAL.cell - 1] = Math.max(...cells) - SPREAD_CRITICAL.mv;
  } else if (core === SPREAD_WARNING.core && pack === SPREAD_WARNING.pack) {
    cells[3] = Math.min(...cells) + SPREAD_WARNING.mv;
  }
  return cells;
}

function buildPack(core: number, pack: number, coreSocPct: number, chargeW: number): DpuPack {
  const soc = r1(coreSocPct + PACK_SOC_OFFSET[pack - 1]);
  const soh = PACK_SOH[core - 1][pack - 1];
  const temp = PACK_TEMP_C[core - 1][pack - 1];
  const cells = cellVoltages(core, pack, soc);
  const min = Math.min(...cells);
  const max = Math.max(...cells);
  const full = Math.round(PACK_DESIGN_MAH * (soh / 100));
  const cycles = PACK_CYCLES[core - 1][pack - 1];
  const packMv = cells.reduce((s, v) => s + v, 0);
  return {
    num: pack,
    soc,
    soh: Math.round(soh),
    actSoh: soh,
    inputWatts: Math.round(chargeW / PACKS_PER_CORE + 6 * hashNoise(core, pack)),
    outputWatts: 0,
    temp,
    cycles,
    remainTimeMin: null,
    packSn: packSn(core, pack),
    designCapMah: PACK_DESIGN_MAH,
    fullCapMah: full,
    remainCapMah: Math.round(full * (soc / 100)),
    accuChgMah: Math.round(cycles * PACK_DESIGN_MAH * 1.03),
    accuDsgMah: Math.round(cycles * PACK_DESIGN_MAH * 0.98),
    cellTemps: Array.from({ length: 8 }, (_, k) => r1(temp - 0.6 + ((k * 3 + pack) % 5) * 0.35)),
    mosTemps: Array.from({ length: 4 }, (_, k) => r1(temp + 4.2 + k * 0.4)),
    ptcTemps: Array.from({ length: 4 }, (_, k) => r1(temp - 1.1 + k * 0.2)),
    hwBoardTemp: r1(temp + 6.3),
    curResTemp: r1(temp + 2.8),
    minCellTemp: r1(temp - 0.6),
    maxCellTemp: r1(temp + 0.8),
    minMosTemp: r1(temp + 4.2),
    maxMosTemp: r1(temp + 5.4),
    cellVoltagesMv: cells,
    minCellVoltageMv: min,
    maxCellVoltageMv: max,
    maxVolDiffMv: max - min,
    balanceState: core === BALANCING.core && pack === BALANCING.pack ? 1 : 0,
    packVoltageMv: packMv,
    adBatVoltageMv: packMv + 40,
    ocvMv: packMv - 380,
  };
}

function buildCore(core: number): DeviceSnapshot {
  const { past: p } = sims();
  const i = p.soc.length - 1;
  const soc = coreSoc(core, p.soc[i]);
  const pv = p.pv[core][i];
  const out = p.out[core][i];
  const hv = pv * HV_SHARE;
  const lv = pv - hv;
  const hvV = PV_STRINGS.hv.count * 40.8 + 2.2 * hashNoise(41, core);
  const lvV = PV_STRINGS.lv.count * 40.6 + 1.1 * hashNoise(42, core);
  const batV = 106.6 + 0.2 * core;
  const chargeW = pv * CHARGE_EFF - out / DISCHARGE_EFF;
  const projection: DpuProjection = {
    kind: 'dpu',
    soc: r1(soc),
    packCount: PACKS_PER_CORE,
    packs: Array.from({ length: PACKS_PER_CORE }, (_, k) => buildPack(core + 1, k + 1, soc, chargeW)),
    pvHighWatts: Math.round(hv),
    pvLowWatts: Math.round(lv),
    pvTotalWatts: Math.round(pv),
    pvHighVolts: r1(hvV),
    pvHighAmps: r2(hv / hvV),
    pvLowVolts: r1(lvV),
    pvLowAmps: r2(lv / lvV),
    pvHighErrCode: 0,
    pvLowErrCode: 0,
    acInWatts: 0,
    acOutWatts: Math.round(out),
    acOutFreq: 60,
    acOutVol: 240,
    batVol: r1(batV),
    batAmp: r2(chargeW / batV),
    totalInWatts: Math.round(pv),
    totalOutWatts: Math.round(out),
    // To the charge limit at the present net charge rate.
    remainTimeMin: Math.round((((CHARGE_LIMIT_PCT - soc) / 100) * (POOL_WH / 3)) / Math.max(1, chargeW) * 60),
    mpptHvTemp: 51.5 + core * 0.8,
    mpptLvTemp: 46.2 + core * 0.6,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0,
    emsParaVolMaxMv: 108_300,
    emsParaVolMinMv: 105_300,
    chgMaxSoc: CHARGE_LIMIT_PCT,
    dsgMinSoc: 5,
  };
  return {
    sn: CORE_SNS[core],
    deviceName: `Core ${core + 1}`,
    productName: 'DELTA Pro Ultra',
    online: true,
    lastUpdated: FIXTURE_NOW_MS - (9 + core * 4) * 1000,
    lastTelemetryAtMs: FIXTURE_NOW_MS - (9 + core * 4) * 1000,
    contentStaleSinceMs: null,
    projection,
  };
}

const GRID: GridBackstop = {
  present: true,
  backstopping: true,
  importLive: false,
  declared: true,
  importWatts: 0,
  homeGridWatts: 0,
  reason: 'panel reports grid present; no import while the batteries carry the house',
  panelFresh: true,
  vetoClearable: false,
};

function buildPanel(): DeviceSnapshot {
  const { past: p } = sims();
  const i = p.soc.length - 1;
  const t = FIXTURE_NOW_MS;
  const pool = p.soc[i];
  const channel = (ch: number): Shp2Circuit => {
    const def = CIRCUITS.find((c) => c.primaryCh === ch || c.secondaryCh === ch)!;
    const split = def.secondaryCh != null;
    return {
      ch,
      name: circuitName(ch),
      watts: Math.round(def.watts(t) * (split ? 0.5 : 1)),
      setAmp: def.breakerAmps,
      linkCh: split ? (ch === def.primaryCh ? def.secondaryCh : def.primaryCh) : null,
      linkMark: split,
      loadPriority: def.loadPriority,
      loadIsEnable: def.loadIsEnable,
    };
  };
  const circuits = Array.from({ length: 12 }, (_, k) => channel(k + 1));
  const pairedCircuits: Shp2PairedCircuit[] = CIRCUITS.map((c) => ({
    primaryCh: c.primaryCh,
    secondaryCh: c.secondaryCh,
    name: circuitName(c.primaryCh),
    watts: Math.round(c.watts(t)),
    breakerAmps: c.breakerAmps,
    loadPriority: c.loadPriority,
    loadIsEnable: c.loadIsEnable,
    isSplitPhase: c.secondaryCh != null,
  }));
  const remainWh = (pool / 100) * POOL_NAMEPLATE_WH;
  const netChargeW = p.pv.reduce((s, a) => s + a[i], 0) * CHARGE_EFF - (p.load[i] / DISCHARGE_EFF + OVERHEAD_W);
  const projection: Shp2Projection = {
    kind: 'shp2',
    area: null,
    backupBatPercent: r1(pool),
    backupFullCapWh: Math.round(POOL_NAMEPLATE_WH),
    backupRemainWh: Math.round(remainWh),
    backupChargeTimeMin: Math.round(((CHARGE_LIMIT_PCT - pool) / 100) * POOL_NAMEPLATE_WH / Math.max(1, netChargeW) * 60),
    backupDischargeTimeMin: null,
    backupReserveSoc: RESERVE_PCT,
    chargeWattPower: 3600,
    gridWatt: 0,
    circuits,
    pairedCircuits,
    sources: CORE_SNS.map((sn, c) => ({
      slot: c + 1,
      sn,
      batteryPercentage: Math.round(coreSoc(c, pool)),
      isConnected: true,
      isAcOpen: true,
      fullCap: Math.round(POOL_NAMEPLATE_WH / 3),
      ratePower: 7200,
      emsBatTemp: r1(31.4 + c * 0.7),
      hwConnect: true,
      errorCodeNum: 0,
      dpuStale: false,
      dpuFrozen: false,
      ownReading: true,
      pvMeasuredW: null,
    })),
    // The panel's sign: negative while a source delivers to it.
    sourceWatts: [0, 1, 2].map((c) => -Math.round(p.out[c][i])),
    strategy: {
      loadShedEnabled: true,
      loadShedConfigured: true,
      midPriorityDischargeFloorSoc: 40,
      backupMode: 1,
      overloadMode: 0,
      smartBackupMode: 2,
      backupReserveSoc: RESERVE_PCT,
      backupReserveEnabled: true,
      solarBackupReserveSoc: 60,
      timeTask: {
        type: 'TIME_TASK_TYPE_CHARGE',
        // Configured for the winter's mid-day rate and switched off for the summer.
        isEnabled: false,
        rangeEnabled: true,
        timeMode: 'TIME_MODE_EVERY_DAY',
        chargeWatts: 3600,
        chargeCeilingSoc: CHARGE_LIMIT_PCT,
        chargeFloorSoc: RESERVE_PCT,
        windows: [{ startMinute: 10 * 60, endMinute: 14 * 60 }],
        slotMinutes: 15,
      },
    },
  };
  return {
    sn: PANEL_SN,
    deviceName: 'Smart Home Panel 2',
    productName: 'Smart Home Panel 2',
    online: true,
    housePanel: true,
    lastRoster: [...CORE_SNS],
    lastUpdated: FIXTURE_NOW_MS - 6_000,
    lastTelemetryAtMs: FIXTURE_NOW_MS - 6_000,
    contentStaleSinceMs: null,
    grid: GRID,
    off_grid: false,
    readbackFresh: true,
    backupTimers: { charge: true, discharge: false },
    projection,
  };
}

/** The accessory devices: app-only on the Open API (no projection), the generator offline. */
function buildAccessory(id: Identity): DeviceSnapshot {
  return {
    sn: id.sn,
    deviceName: id.deviceName,
    productName: id.productName,
    online: id.online,
    lastUpdated: id.online ? FIXTURE_NOW_MS - 40_000 : FIXTURE_NOW_MS - 3 * DAY,
  };
}

/* ── alerts ─────────────────────────────────────────────────────────────── */

const ALERT_IDS = {
  spreadCritical: `vdiff-crit-${CORE_SNS[2]}-2`,
  spreadWarning: `vdiff-warn-${CORE_SNS[1]}-4`,
  balancing: `balancing-${CORE_SNS[0]}-3`,
  generatorOffline: `offline-${GENERATOR_SN}`,
  peerSpread: `peer-voldiff-${CORE_SNS[2]}-2`,
  spreadTrend: `forecast-imbalance-${CORE_SNS[1]}-4`,
  sohTrend: `forecast-soh-${CORE_SNS[2]}-2`,
};

/** The standing alerts: every severity, threshold and learned, each consistent with the snapshot. */
export function fixtureAlerts(): Alert[] {
  return [
    {
      id: ALERT_IDS.spreadCritical, severity: 'critical', category: 'Battery', device: 'Core 3', source: 'threshold',
      coreNum: 3, packNum: 2, title: 'Cell imbalance',
      detail: `Core 3 Pack 2 cell spread ${SPREAD_CRITICAL.mv} mV (critical ≥ 50 mV). Deviant cell #${SPREAD_CRITICAL.cell} (${SPREAD_CRITICAL.deltaMv} mV vs pack median).`,
    },
    {
      id: ALERT_IDS.spreadWarning, severity: 'warning', category: 'Battery', device: 'Core 2', source: 'threshold',
      coreNum: 2, packNum: 4, title: 'Cell imbalance',
      detail: `Core 2 Pack 4 cell spread ${SPREAD_WARNING.mv} mV (warning fires ≥ 24 mV, holds ≥ 20 mV).`,
    },
    {
      id: ALERT_IDS.balancing, severity: 'info', category: 'Battery', device: 'Core 1', source: 'threshold',
      coreNum: 1, packNum: 3, title: 'Pack balancing cells',
      detail: 'Core 1 Pack 3 BMS is actively balancing — normal housekeeping, no action needed.',
    },
    {
      id: ALERT_IDS.generatorOffline, severity: 'info', priority: 'low', category: 'Connectivity', device: 'Smart Generator',
      source: 'threshold', coreNum: null, title: 'Device offline (per EcoFlow Cloud)',
      detail: "Smart Generator is flagged offline by EcoFlow's /device/list. EcoFlow Cloud has listed it offline since the add-on's first device list (3 d ago); how long before that, and why, is not known here. If the device is meant to be on, check its power and its Wi-Fi.",
    },
    {
      id: ALERT_IDS.peerSpread, severity: 'warning', category: 'Battery', device: 'Core 3', source: 'learned',
      coreNum: 3, packNum: 2, title: 'Cell spread — peer outlier',
      detail: `Core 3 Pack 2 cell spread is ${SPREAD_CRITICAL.mv} mV, 46 mV above the sibling-pack median of 12 mV (peer z-score 6.4). Cell-spread warnings are pushed, not announced; a cell imbalance at the critical line is announced.`,
      facts: [
        { label: 'This pack', value: `${SPREAD_CRITICAL.mv} mV` },
        { label: 'Sibling median', value: '12 mV' },
        { label: 'Deviation', value: '+46 mV' },
        { label: 'Peer z-score', value: '6.4' },
        { label: 'Flag threshold', value: 'info z≥2.5 · warning z≥3.5' },
      ],
    },
    {
      id: ALERT_IDS.spreadTrend, severity: 'warning', category: 'Battery', device: 'Core 2', source: 'learned',
      coreNum: 2, packNum: 4, title: 'Cell imbalance trending up',
      detail: `Core 2 Pack 4 cell spread ${SPREAD_WARNING.mv} mV rising ~1.4 mV/week — projected to reach 50 mV in about 17 week(s). (R² 0.81, 41 days of data.)`,
      facts: [
        { label: 'Cell spread now', value: `${SPREAD_WARNING.mv} mV` },
        { label: 'Rise rate', value: '1.4 mV/week' },
        { label: 'Projected to 50 mV', value: '~17 week(s)' },
        { label: 'Fit quality (R²)', value: '0.81' },
        { label: 'Data span', value: '41 days' },
      ],
    },
    {
      id: ALERT_IDS.sohTrend, severity: 'info', category: 'Battery', device: 'Core 3', source: 'learned',
      coreNum: 3, packNum: 2, title: 'State of health declining',
      detail: 'Core 3 Pack 2 state of health 95.4% falling ~2.6%/yr — projected to reach the 70% end-of-life mark in about 9.8 years. (R² 0.74, 214 days of data.)',
      facts: [
        { label: 'SoH now', value: '95.4%' },
        { label: 'Fade rate', value: '2.6 %/yr' },
        { label: 'Years to 70%', value: '~9.8' },
        { label: 'Fit quality (R²)', value: '0.74' },
      ],
    },
  ];
}

/** GET /api/incidents: the two pack clusters, then the system-scoped offline accessory. */
function incidents(): Incident[] {
  const a = fixtureAlerts();
  const byId = new Map(a.map((x) => [x.id, x]));
  const gen = byId.get(ALERT_IDS.generatorOffline)!;
  return [
    {
      id: `inc-${CORE_SNS[2]}-2`, severity: 'critical', scope: 'pack', coreNum: 3, packNum: 2, category: 'Battery',
      title: '3 concurrent alerts on Core 3 · Pack 2', device: 'Core 3', alertCount: 3,
      alertIds: [ALERT_IDS.spreadCritical, ALERT_IDS.peerSpread, ALERT_IDS.sohTrend], topAlertTitle: 'Cell imbalance',
      detail: 'Lead alert: Cell imbalance. 2 other simultaneous conditions on the same pack — Cell spread — peer outlier; State of health declining.',
    },
    {
      id: `inc-${CORE_SNS[1]}-4`, severity: 'warning', scope: 'pack', coreNum: 2, packNum: 4, category: 'Battery',
      title: '2 concurrent alerts on Core 2 · Pack 4', device: 'Core 2', alertCount: 2,
      alertIds: [ALERT_IDS.spreadWarning, ALERT_IDS.spreadTrend], topAlertTitle: 'Cell imbalance',
      detail: 'Lead alert: Cell imbalance. 1 other simultaneous condition on the same pack — Cell imbalance trending up.',
    },
    {
      id: `inc-system-${gen.id}`, severity: 'info', scope: 'system', coreNum: null, packNum: null, category: gen.category,
      title: gen.title, device: gen.device, alertCount: 1, alertIds: [gen.id], topAlertTitle: gen.title, detail: gen.detail,
    },
  ];
}

/** GET /api/alerts/history: alerts that fired and cleared over the last week, newest first. */
function clearedHistory(q: URLSearchParams): ClearedHistoryPage {
  const day = localDayStart(FIXTURE_NOW_MS);
  const row = (o: Omit<ClearedHistoryRow, 'durationMs'>): ClearedHistoryRow => ({ ...o, durationMs: o.clearedAt - o.raisedAt });
  const rows: ClearedHistoryRow[] = [
    row({ id: 'grid-offgrid', title: 'Running off-grid', detail: 'No grid connection detected — home running on solar + batteries.', severity: 'info', category: 'Grid', device: 'System', coreNum: null, packNum: null, raisedAt: day - 2 * DAY + 14.2 * HOUR, clearedAt: day - 2 * DAY + 14.55 * HOUR, pushed: true }),
    row({ id: `vdiff-warn-${CORE_SNS[2]}-2`, title: 'Cell imbalance', detail: 'Core 3 Pack 2 cell spread 31 mV (warning fires ≥ 24 mV, holds ≥ 20 mV).', severity: 'warning', source: 'threshold', category: 'Battery', device: 'Core 3', coreNum: 3, packNum: 2, raisedAt: day - DAY + 9.1 * HOUR, clearedAt: day - DAY + 10.4 * HOUR, closedAs: { title: 'Cell imbalance', severity: 'critical' }, pushed: true }),
    row({ id: 'forecast-soc-dip', title: 'Projected battery dip below reserve', detail: 'The day-ahead projection dips below the 25% reserve floor before sunrise — the grid is present and carries the house there.', severity: 'info', source: 'learned', category: 'Battery', device: 'SHP2 backup pool', coreNum: null, packNum: null, raisedAt: day - 3 * DAY + 20.5 * HOUR, clearedAt: day - 2 * DAY + 7.25 * HOUR }),
    row({ id: `offline-${CORE_SNS[1]}`, title: 'Device offline (per EcoFlow Cloud)', detail: "Core 2 is flagged offline by EcoFlow's /device/list. Last data 4 min ago via MQTT. Just dropped — likely a brief blip. Will re-evaluate.", severity: 'warning', priority: 'medium', category: 'Connectivity', device: 'Core 2', coreNum: 2, packNum: null, raisedAt: day - 4 * DAY + 3.3 * HOUR, clearedAt: day - 4 * DAY + 3.45 * HOUR, pushed: false }),
    row({ id: `balancing-${CORE_SNS[0]}-1`, title: 'Pack balancing cells', detail: 'Core 1 Pack 1 BMS is actively balancing — normal housekeeping, no action needed.', severity: 'info', source: 'threshold', category: 'Battery', device: 'Core 1', coreNum: 1, packNum: 1, raisedAt: day - 5 * DAY + 15.6 * HOUR, clearedAt: day - 5 * DAY + 16.2 * HOUR }),
    row({ id: 'circuit-overload-3', title: 'Circuit near breaker limit', detail: 'Circuit 3 drawing 6612 W — over 90% of its 30 A breaker.', severity: 'warning', source: 'threshold', category: 'SHP2', device: 'Smart Home Panel 2', coreNum: null, packNum: null, raisedAt: day - 6 * DAY + 17.0 * HOUR, clearedAt: day - 6 * DAY + 17.1 * HOUR, pushed: true }),
  ].sort((a, b) => b.clearedAt - a.clearedAt);
  const all = q.get('all') === '1';
  const days = Number(q.get('days') ?? 7) || 7;
  const since = all ? null : FIXTURE_NOW_MS - days * DAY;
  const cleared = since == null ? rows : rows.filter((r) => r.clearedAt >= since);
  return { cleared, total: rows.length, shown: cleared.length, windowDays: all ? null : days, since };
}

/** The /ws snapshot. Its clock is FIXTURE_NOW_MS; every reading is seconds old. */
export function fixtureSnapshot(): FleetSnapshot {
  const devices: Record<string, DeviceSnapshot> = {};
  const panel = buildPanel();
  devices[panel.sn] = panel;
  for (let c = 0; c < 3; c++) devices[CORE_SNS[c]] = buildCore(c);
  for (const id of IDENTITIES.slice(4)) devices[id.sn] = buildAccessory(id);
  return {
    generatedAt: FIXTURE_NOW_MS,
    devices,
    alerts: fixtureAlerts(),
    grid: GRID,
    off_grid: false,
    housePanel: { sn: PANEL_SN, state: 'pinned', ambiguous: false, missing: null, panels: [{ sn: PANEL_SN, name: 'Smart Home Panel 2' }] },
  };
}

/* ── the forecast, the runway and the energy reports ────────────────────── */

const pvSum = (s: Sim, i: number): number => s.pv[0][i] + s.pv[1][i] + s.pv[2][i];
const outSum = (s: Sim, i: number): number => s.out[0][i] + s.out[1][i] + s.out[2][i];
const nextHour = (t: number): number => Math.ceil(t / HOUR) * HOUR;

/** The learned GHI→PV response: W of PV per W/m², per hour of the day. */
function responseModel(scale: number, samplesBase: number): SolarResponseModel {
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const cs = clearSky(hour + 0.5);
    const daylight = cs > 0.02;
    // Highest around solar noon, a little lower in the hot afternoon, none in the dark.
    const coeff = daylight ? r2(scale * (0.8 + 0.2 * Math.sqrt(cs)) * (1 - 0.012 * Math.max(0, hour - 13))) : null;
    return {
      hour,
      coeff,
      r2: daylight ? r2(0.86 + 0.08 * cs) : 0,
      samples: daylight ? samplesBase + (hour % 5) : 0,
      observedMaxPvW: daylight ? Math.round(scale * 1000 * cs) : 0,
      meanGhiWm2: daylight ? Math.round(1010 * cs) : 0,
    };
  });
  const peak = Math.max(...hourly.map((h) => h.coeff ?? 0));
  return { hourly, peakCoeff: peak, peakGateMinGhiWm2: 300, pairCount: samplesBase * 14 + 37, historyDays: 64.2 };
}

function forecast(): DayForecast {
  const { forward: f } = sims();
  const start = nextHour(FIXTURE_NOW_MS);
  const hours = Array.from({ length: 24 }, (_, k) => {
    const ts = start + k * HOUR;
    let pv = 0, load = 0, ev = 0;
    for (let m = 0; m < 60; m++) {
      const i = at(f, ts + m * MIN);
      pv += corePvPotentialW(0, ts + m * MIN) + corePvPotentialW(1, ts + m * MIN) + corePvPotentialW(2, ts + m * MIN);
      load += f.load[i];
      ev += evW(ts + m * MIN);
    }
    const cs = clearSky(localHour(ts + 30 * MIN));
    return {
      ts,
      forecastPvW: Math.round(pv / 60),
      forecastLoadW: Math.round(load / 60),
      cloudCoverPct: cs > 0 ? Math.round(3 + 4 * ((hashNoise(51, k) + 1) / 2)) : 2,
      ghiWm2: cs > 0 ? Math.round(1010 * cs) : 0,
      projectedSocPct: r1(f.soc[at(f, ts)]),
      modelled: true,
      ...(ev > 0 ? { predictedEvLoadW: Math.round(ev / 60) } : {}),
    };
  });
  let min = Infinity, minTs: number | null = null;
  for (const h of hours) if (h.projectedSocPct != null && h.projectedSocPct < min) { min = h.projectedSocPct; minTs = h.ts; }
  const deviceModels: DeviceSolarModel[] = CORE_SNS.map((sn, c) => ({
    sn,
    device: `Core ${c + 1}`,
    model: responseModel(CORE_PV_PEAK_W[c] / 1000 * 1.02, 20 + c),
    hv: responseModel((CORE_PV_PEAK_W[c] / 1000) * HV_SHARE * 1.02, 20 + c),
    lv: responseModel((CORE_PV_PEAK_W[c] / 1000) * (1 - HV_SHARE) * 1.02, 19 + c),
  }));
  return {
    generatedAt: FIXTURE_NOW_MS - 7 * MIN,
    hasWeather: true,
    historyDays: 64.2,
    reserveSoc: RESERVE_PCT,
    hours,
    forecastPvWhNext24: Math.round(hours.reduce((s, h) => s + h.forecastPvW, 0)),
    typicalPvWhPerDay: 96_400,
    minProjectedSoc: Number.isFinite(min) ? Math.round(min) : null,
    minProjectedSocTs: minTs,
    solarModel: responseModel(CORE_PV_PEAK_W.reduce((s, w) => s + w, 0) / 1000 * 1.02, 22),
    deviceModels,
    soiling: { dropPct: 7, baselineCoeff: 13.6, recentCoeff: 12.6, cleanDays: 38 },
    homeDpusConnected: 3,
    homeDpusReporting: 3,
    homeDpusCoveragePartial: false,
    siteTimeZone: SITE_ZONE,
  };
}

function runway(): RunwayProjection {
  const { islanded: s, past: p } = sims();
  const horizon = 24;
  const end = at(s, FIXTURE_NOW_MS + horizon * HOUR);
  let trough = Infinity, troughI = 0;
  for (let i = 0; i <= end; i++) if (s.soc[i] < trough) { trough = s.soc[i]; troughI = i; }
  const kwh = (pct: number): number => r1((pct / 100) * POOL_WH / 1000);
  let pvWh = 0, loadWh = 0;
  for (let i = 0; i < end; i++) { pvWh += pvSum(s, i) / 60; loadWh += s.load[i] / 60; }
  let recent = 0;
  for (let i = p.load.length - 60; i < p.load.length; i++) recent += p.load[i] / 60;
  return {
    generatedAt: FIXTURE_NOW_MS - 40_000,
    backupRemainingKwh: kwh(s.soc[0]),
    backupReserveKwh: kwh(RESERVE_PCT),
    backupFullKwh: r1(POOL_WH / 1000),
    recentLoadWatts: Math.round(recent),
    hoursToReserve: null,
    hoursToEmpty: null,
    reserveAtMs: null,
    emptyAtMs: null,
    forecastPvUsedKwh: r1(pvWh / 1000),
    loadHorizonKwh: r1(loadWh / 1000),
    horizonHours: horizon,
    unavailable: null,
    loadModelDegraded: false,
    belowReserveFloor: false,
    grid: { present: true, backstopping: true, importLive: false },
    troughKwh: kwh(trough),
    troughAtMs: s.start + troughI * MIN,
    endKwh: kwh(s.soc[end]),
    recentLoadBasis: 'hour-mean',
    capacityScale: CAPACITY_SCALE,
    capacityBasis: 'measured',
    overheadW: OVERHEAD_W,
  };
}

function summaryToday(): object {
  const { past: p } = sims();
  const since = localDayStart(FIXTURE_NOW_MS);
  const pvWh = energyWh(p, (i) => pvSum(p, i), since, FIXTURE_NOW_MS);
  const outWh = energyWh(p, (i) => outSum(p, i), since, FIXTURE_NOW_MS);
  const loadWh = energyWh(p, (i) => p.load[i], since, FIXTURE_NOW_MS);
  return {
    sinceMs: since,
    untilMs: FIXTURE_NOW_MS,
    dayEndMs: since + DAY,
    siteTimeZone: SITE_ZONE,
    fleet: {
      pvWh: Math.round(pvWh),
      acOutWh: Math.round(outWh),
      panelLoadWh: Math.round(loadWh),
      // Positive = discharged: what left the packs less what PV put in.
      batteryNetWh: Math.round(outWh / DISCHARGE_EFF - pvWh * CHARGE_EFF),
      coverage: 0.99,
      homeCoverage: 0.99,
      panelLoadCoverage: 0.99,
      pvCoverage: 0.99,
    },
  };
}

function selfConsumption(): SelfConsumption {
  const { past: p } = sims();
  const to = localDayStart(FIXTURE_NOW_MS);
  const from = to - 7 * DAY;
  const pvKwh = energyWh(p, (i) => pvSum(p, i), from, to) / 1000;
  const loadKwh = energyWh(p, (i) => p.load[i], from, to) / 1000;
  const directKwh = energyWh(p, (i) => Math.min(pvSum(p, i), p.load[i]), from, to) / 1000;
  const gridKwh = energyWh(p, (i) => p.grid[i], from, to) / 1000;
  return {
    generatedAt: FIXTURE_NOW_MS - 3 * MIN,
    windowDays: 7,
    pvKwh: r1(pvKwh),
    loadKwh: r1(loadKwh),
    batteryChargeKwh: r1((pvKwh - directKwh) * CHARGE_EFF),
    batteryDischargeKwh: r1(loadKwh - directKwh - gridKwh),
    gridImportKwh: 0,
    gridToHomeKwh: r1(gridKwh),
    gridForKpiKwh: r1(gridKwh),
    gridHomeCoverageFrac: 0.98,
    pvToLoadKwh: r1(directKwh),
    pvToBatteryKwh: r1(pvKwh - directKwh),
    solarFractionOfLoadPct: Math.round(((loadKwh - gridKwh) / loadKwh) * 100),
    directUseRatioPct: Math.round((directKwh / pvKwh) * 100),
  };
}

function nightChargeStatus(): object {
  const today = localDayStart(FIXTURE_NOW_MS);
  const window = { startMs: today + 23 * HOUR, endMs: today + DAY + 5 * HOUR };
  return {
    reserveWriteMaxPct: 50,
    enabled: true,
    mode: 'advisory',
    window,
    reserveFloorPercent: RESERVE_PCT,
    confidence: 'forecast',
    notify: { hour: 20, minute: 0, lastNotifyDay: localYmd(FIXTURE_NOW_MS - DAY) },
    plan: {
      generatedAt: FIXTURE_NOW_MS - 18 * MIN,
      basisComplete: true,
      objective: 'resilience',
      chargeTonight: true,
      buyKwh: 11.6,
      buyKwhDebiased: 12.4,
      buyDebiasFactor: 1.07,
      expectedBuyKwh: 7.4,
      expectedWriteLevelPct: 44,
      expectedDeliverableBound: false,
      expectedForceChargeStartMs: window.startMs,
      targetSocPct: 41,
      setpointSocPct: 41,
      requiredExtraKwh: 11.6,
      bindingCap: 'requirement',
      cushionShortfall: false,
      evContention: { basis: 'predicted', windowEvKwh: 0, peakEvKw: 0, minChargeRateKw: 10.8, derateKwh: 0 },
      minProjSocPct: 33,
      minProjSocTsMs: today + DAY + 6.5 * HOUR,
      baselineMinSocPct: 21,
      cushionTroughSocPct: 33,
      cushionLineSocPct: 30,
      cushionBasis: 'islanded P10 PV / P90 load',
      confidenceTier: 'forecast',
      window,
      reserveFloorPct: RESERVE_PCT,
      cushionPct: 5,
      rationale: 'The predicted evening EV session and a hot night take the islanded worst case below the floor plus cushion before sunrise; an overnight buy restores it.',
    },
    armRefusal: null,
    readiness: { state: 'LEARNING', writeReady: false, blocking: ['scored nights 21 of 28'], scoredDays: 21, effectiveN: 14 },
    actuation: null,
    middayShadow: null,
    middayShadowPreview: null,
    siteTimeZone: SITE_ZONE,
  };
}

function degradation(): FleetDegradation {
  const projecting = new Set(['3-2', '2-4', '3-5']);
  const packs: PackDegradation[] = [];
  for (let c = 1; c <= 3; c++) {
    for (let k = 1; k <= PACKS_PER_CORE; k++) {
      const soh = PACK_SOH[c - 1][k - 1];
      const design = (PACK_DESIGN_MAH * MAH_TO_WH) / 1000;
      const now = r2(design * (soh / 100));
      const cycles = PACK_CYCLES[c - 1][k - 1];
      const proj = projecting.has(`${c}-${k}`);
      const fade = proj ? (c === 3 && k === 2 ? 2.6 : c === 2 ? 1.7 : 1.5) : null;
      const years = fade != null ? r1((soh - 70) / fade) : null;
      packs.push({
        home: true,
        sn: CORE_SNS[c - 1],
        device: `Core ${c}`,
        coreNum: c,
        packNum: k,
        status: proj ? 'projecting' : 'stable',
        currentSoh: soh,
        currentCapacityKwh: now,
        designCapacityKwh: r2(design),
        capacityFadeKwh: r2(design - now),
        cycles,
        lifetimeThroughputKwh: Math.round(cycles * design * 0.98),
        fadePctPerYear: fade,
        fadeUncertaintyPct: fade != null ? 0.4 : null,
        cyclesPerYear: proj ? 212 + c * 9 : null,
        fadePctPer100Cycles: fade != null ? r2((fade / (212 + c * 9)) * 100) : null,
        r2: proj ? (c === 3 && k === 2 ? 0.74 : 0.69) : null,
        dataSpanDays: 214,
        samples: proj ? 196 : 142,
        yearsToEol: years,
        yearsToEolLow: years != null ? r1((soh - 70) / (fade! + 0.4)) : null,
        yearsToEolHigh: years != null ? r1((soh - 70) / Math.max(0.1, fade! - 0.4)) : null,
        eolDate: years != null ? FIXTURE_NOW_MS + years * 365.25 * DAY : null,
        projectedCyclesAtEol: years != null ? Math.round(cycles + years * (212 + c * 9)) : null,
        peerFadeRatio: proj ? r1(fade! / 1.6) : null,
        peerOutlier: c === 3 && k === 2,
        avgPackTempC: r1(PACK_TEMP_C[c - 1][k - 1] - 3.1),
        arrheniusFactor: proj ? 1.38 : null,
        fadePctPerYearAt25C: fade != null ? r1(fade / 1.38) : null,
        coolingBenefitYears: years != null ? r1(years * 0.31) : null,
        coulombicEffPct: 99.2 + k * 0.08,
        summary: proj
          ? `SoH ${soh.toFixed(1)}% and falling ~${fade!.toFixed(1)}%/yr; projected to reach 70% in ~${years} years.`
          : `SoH ${soh.toFixed(1)}%, flat within its fit noise over 214 days — no fade trend to project yet.`,
      });
    }
  }
  return { generatedAt: FIXTURE_NOW_MS - 11 * MIN, eolSoh: 70, packs };
}

function roundTrip(): RoundTripEfficiency {
  const days = Array.from({ length: 14 }, (_, k) => {
    const d = localDayStart(FIXTURE_NOW_MS) - (14 - k) * DAY;
    const charged = r1(38 + 6 * ((hashNoise(61, k) + 1) / 2));
    const eff = 93.4 + 1.6 * ((hashNoise(62, k) + 1) / 2);
    return { date: localYmd(d), chargedKwh: charged, dischargedKwh: r1((charged * eff) / 100), efficiencyPct: r1(eff) };
  });
  const c = days.reduce((s, d) => s + d.chargedKwh, 0);
  const dch = days.reduce((s, d) => s + d.dischargedKwh, 0);
  return { generatedAt: FIXTURE_NOW_MS - 11 * MIN, windowDays: 14, daysWithData: 14, totalChargedKwh: r1(c), totalDischargedKwh: r1(dch), efficiencyPct: r1((dch / c) * 100), perDay: days };
}

function curtailment(): CurtailmentReport {
  const { past: p } = sims();
  const i = p.soc.length - 1;
  // What the taper clipped: each Core's available PV less what it delivered, per minute.
  const clippedW = (k: number): number => [0, 1, 2].reduce((s, c) => s + Math.max(0, corePvPotentialW(c, p.start + k * MIN) - p.pv[c][k]), 0);
  const today = localDayStart(FIXTURE_NOW_MS);
  const byHour = Array.from({ length: 24 }, () => ({ sumW: 0, minutes: 0, days: new Set<number>() }));
  let weekWh = 0;
  const hours = new Set<string>();
  for (let k = at(p, today - 7 * DAY); k < at(p, today); k++) {
    const w = clippedW(k);
    if (w < 50) continue;
    const t = p.start + k * MIN;
    const h = Math.floor(localHour(t));
    weekWh += w / 60;
    byHour[h].sumW += w;
    byHour[h].minutes++;
    byHour[h].days.add(localDayStart(t));
    hours.add(`${localDayStart(t)}-${h}`);
  }
  let todayWh = 0;
  for (let k = at(p, today); k < i; k++) todayWh += clippedW(k) / 60;
  return {
    generatedAt: FIXTURE_NOW_MS - 50_000,
    active: false,
    currentSurplusW: 0,
    current: {
      socAvg: Math.round(p.soc[i]),
      pvActualW: Math.round(pvSum(p, i)),
      pvExpectedW: Math.round(pvSum(p, i) * 1.02),
      loadW: Math.round(p.load[i]),
      ghiWm2: Math.round(1010 * clearSky(localHour(FIXTURE_NOW_MS))),
      bayesianSamples: 41,
      chargeCeilingPct: CHARGE_LIMIT_PCT,
      saturationThresholdPct: CHARGE_LIMIT_PCT - 2,
    },
    inactiveReason: 'soc-too-low',
    todayKwh: r2(todayWh / 1000),
    todayHours: [],
    recent7dKwh: r2(weekWh / 1000),
    recent7dHoursCount: hours.size,
    hourlyHistogram: byHour.map((b, hour) => ({ hour, avgSurplusW: b.minutes ? Math.round(b.sumW / b.minutes) : 0, samples: b.days.size })),
    opportunisticLoads: [],
  };
}

function circuitHistory(q: URLSearchParams): CircuitHistory | null {
  const sn = q.get('sn') ?? '';
  const ch = Number(q.get('pair') ?? q.get('ch'));
  const def = CIRCUITS.find((c) => c.primaryCh === ch || c.secondaryCh === ch);
  if (sn !== PANEL_SN || !def) return null;
  const share = q.get('pair') != null || def.secondaryCh == null ? 1 : 0.5;
  const nDays = Math.max(1, Math.min(30, Number(q.get('days') ?? 7) || 7));
  const today = localDayStart(FIXTURE_NOW_MS);
  const days = Array.from({ length: nDays }, (_, k) => {
    const start = today - (nDays - 1 - k) * DAY;
    const end = Math.min(start + DAY, FIXTURE_NOW_MS);
    let wh = 0, peak = 0, peakAt: number | null = null;
    for (let t = start; t < end; t += MIN) {
      const w = def.watts(t) * share;
      wh += w / 60;
      if (w > peak) { peak = w; peakAt = t; }
    }
    return { date: localYmd(start), dayStartMs: start, dayEndMs: start + DAY, isToday: start === today, kwh: r2(wh / 1000), peakW: Math.round(peak), peakAtMs: peakAt, coverageMs: end - start };
  });
  const full = days.filter((d) => !d.isToday);
  const total = days.reduce((s, d) => s + d.kwh, 0);
  const pick = (cmp: (a: number, b: number) => boolean) => full.reduce<typeof days[number] | null>((b, d) => (b == null || cmp(d.kwh, b.kwh) ? d : b), null);
  return {
    sn, ch,
    days,
    summary: { daysWithData: days.length, totalKwh: r2(total), avgKwh: r2(full.reduce((s, d) => s + d.kwh, 0) / Math.max(1, full.length)), peakDay: pick((a, b) => a > b), minDay: pick((a, b) => a < b) },
  };
}

/* ── the analytics sections (AdvancedInsightsCard) ──────────────────────── */

const corePacks = <T,>(f: (c: number, k: number) => T): T[] => [1, 2, 3].flatMap((c) => Array.from({ length: PACKS_PER_CORE }, (_, k) => f(c, k + 1)));

function thermalEvents(): FleetThermalEvents {
  return {
    generatedAt: FIXTURE_NOW_MS - 9 * MIN,
    packs: corePacks((c, k) => {
      // The pack the alerts concern runs warmest; the rest a few warm afternoons each.
      const hot = c === 3 && k === 2 ? 2 : 0;
      const warm = hot ? 15 : 3 + ((c * 7 + k * 3) % 9);
      return { home: true, sn: CORE_SNS[c - 1], device: `Core ${c}`, coreNum: c, packNum: k, warmEvents: warm, hotEvents: hot, overheatEvents: 0, warmHours: warm * 2 + k, hotHours: hot * 2, overheatHours: 0, dataSpanDays: 214, hardLifeScore: r1(warm * 3.1 + hot * 9) };
    }),
  };
}

function equipmentHealth(): EquipmentHealth {
  return {
    generatedAt: FIXTURE_NOW_MS - 9 * MIN,
    mpptStrings: CORE_SNS.flatMap((sn, c) => (['HV', 'LV'] as const).map((s, j) => {
      const base = s === 'HV' ? 97.6 : 96.9;
      const drift = r1(-0.2 - 0.3 * c - 0.2 * j);
      return { sn, device: `Core ${c + 1}`, coreNum: c + 1, string: s, recentEffPct: r1(base + drift), baselineEffPct: base, driftPctPts: drift, samples: 320 + c * 11, spanDays: 61 };
    })),
    inverterStandby: CORE_SNS.map((sn, c) => ({ sn, device: `Core ${c + 1}`, coreNum: c + 1, idleWatts: null, baselineIdleWatts: null, trendWattsPerWeek: null, samples: 0, blockedReason: 'ac-output-stage-idle' as const })),
  };
}

const shadeReport = (): ShadeReport => ({
  generatedAt: FIXTURE_NOW_MS - 9 * MIN,
  hours: [
    { hour: 7, observedW: 2310, expectedW: 2680, shortfallPct: 14, clearDays: 31 },
    { hour: 18, observedW: 1620, expectedW: 1910, shortfallPct: 15, clearDays: 29 },
  ],
  estTotalKwhPerYear: 96,
});

const soilingDecomposition = (): SoilingDecomposition => ({
  generatedAt: FIXTURE_NOW_MS - 9 * MIN,
  perDevice: CORE_SNS.map((sn, c) => ({ sn, device: `Core ${c + 1}`, coreNum: c + 1, dropPct: [6, 8, 7][c], cleanDays: 38 - c, recentCoeff: r2(4.2 - c * 0.09), baselineCoeff: r2(4.5 - c * 0.06) })),
  perHour: Array.from({ length: 12 }, (_, k) => ({ hour: k + 7, dropPct: k === 0 || k === 11 ? 11 : 6 + (k % 3), samples: 30 + k })),
});

const stringMismatch = (): StringMismatchReport => ({
  generatedAt: FIXTURE_NOW_MS - 9 * MIN,
  devices: CORE_SNS.map((sn, c) => {
    const w = [3260, 3175, 3122][c];
    return { sn, device: `Core ${c + 1}`, coreNum: c + 1, recentMedianW: w, fleetMedianW: 3175, ratio: r2(w / 3175), modifiedZ: r2((w - 3175) / 60), outlier: false, samples: 410 };
  }),
});

function evWindow(): EvWindowPrediction {
  const today = localDayStart(FIXTURE_NOW_MS);
  return {
    generatedAt: FIXTURE_NOW_MS - 9 * MIN,
    sessionsObserved: 6,
    patterns: [{
      sn: PANEL_SN,
      circuit: 1,
      dayOfWeek: EV_PATTERN.dayOfWeek,
      startHour: EV_PATTERN.startHour,
      typicalDurationHours: EV_PATTERN.hours,
      typicalWatts: EV_PATTERN.watts,
      recurrences: 4,
      energyKwh: r1((EV_PATTERN.watts * EV_PATTERN.hours) / 1000),
    }],
    upcomingNext24h: [{ ts: today + (EV_PATTERN.startHour * 60 + EV_PATTERN.startMinute) * MIN, durationHours: EV_PATTERN.hours, watts: EV_PATTERN.watts, dayOfWeek: EV_PATTERN.dayOfWeek }],
  };
}

function chargeCurve(): ChargeCurveReport {
  return {
    generatedAt: FIXTURE_NOW_MS - 9 * MIN,
    packs: corePacks((c, k) => {
      const tracked = (c === 3 && k === 2) || (c === 2 && k === 4) || (c === 1 && k === 1);
      const drift = c === 3 && k === 2 ? 9 : c === 2 ? 6 : 3;
      return {
        home: true, sn: CORE_SNS[c - 1], device: `Core ${c}`, coreNum: c, packNum: k,
        checkpoints: [30, 50, 70, 90].map((soc, j) => ({ soc, baselineV: r2(103.6 + soc * 0.025), recentV: r2(103.6 + soc * 0.025 + (tracked ? (drift * (j + 1)) / 4000 : 0)), driftMv: tracked ? Math.round((drift * (j + 1)) / 4) : null, baselineSamples: 18, recentSamples: tracked ? 6 : 0 })),
        meanDriftMv: tracked ? drift : null,
        status: tracked ? 'tracking' as const : 'baseline' as const,
      };
    }),
  };
}

const internalResistance = (): InternalResistanceReport => ({
  generatedAt: FIXTURE_NOW_MS - 9 * MIN,
  devices: CORE_SNS.map((sn, c) => ({ sn, device: `Core ${c + 1}`, coreNum: c + 1, recentMilliohms: [21.4, 22.9, 24.1][c], baselineMilliohms: [20.9, 22.1, 22.8][c], trendMilliohmsPerMonth: [0.1, 0.2, 0.6][c], trendR2: [0.42, 0.51, 0.66][c], samples: 188 + c * 7, status: 'tracking' as const })),
});

function forecastSkill(): ForecastSkillReport {
  // The actuals are the simulated days' PV; the day-ahead predictions miss them by a few percent.
  const { past: p } = sims();
  const days = Array.from({ length: 7 }, (_, k) => {
    const d = localDayStart(FIXTURE_NOW_MS) - (7 - k) * DAY;
    const actual = r1(energyWh(p, (i) => pvSum(p, i), d, d + DAY) / 1000);
    const pred = r1(actual * (1 + 0.035 * hashNoise(72, k)));
    return { date: localYmd(d), predictedKwh: pred, actualKwh: actual, errorKwh: r1(pred - actual), errorPct: r1(((pred - actual) / actual) * 100) };
  });
  const mae = days.reduce((s, d) => s + Math.abs(d.errorKwh), 0) / days.length;
  const meanActual = days.reduce((s, d) => s + d.actualKwh, 0) / days.length;
  const bias = days.reduce((s, d) => s + d.predictedKwh, 0) / days.reduce((s, d) => s + d.actualKwh, 0);
  return { generatedAt: FIXTURE_NOW_MS - 9 * MIN, days, meanAbsErrorKwh: r1(mae), meanAbsErrorPct: r1((mae / meanActual) * 100), biasFactor: r2(bias), windowDays: 7 };
}

function ambientThermal(): AmbientThermalReport {
  const today = localDayStart(FIXTURE_NOW_MS);
  return {
    generatedAt: FIXTURE_NOW_MS - 9 * MIN,
    packs: corePacks((c, k) => ({
      sn: CORE_SNS[c - 1], device: `Core ${c}`, coreNum: c, packNum: k,
      ambientCoeff: 0.21, loadCoeff: 0.0011, intercept: 18.2, r2: r2(0.58 + ((c + k) % 4) * 0.05), samples: 1400 + c * 31,
      predictedPeak24hC: r1(PACK_TEMP_C[c - 1][k - 1] + 2.6), predictedPeakAtMs: today + 17 * HOUR,
    })),
  };
}

const confidence = (): ConfidenceSnapshot => ({ generatedAt: FIXTURE_NOW_MS - 9 * MIN, degradationMedianR2: 0.71, forecastDayR2: 0.91, thermalMedianR2: 0.64, forecastSkillBiasFactor: 1.01, forecastSkillMaePct: 2.1 });

function nwsAlerts(): { alerts: NwsAlert[] } {
  const today = localDayStart(FIXTURE_NOW_MS);
  const iso = (t: number): string => new Date(t).toISOString();
  return {
    alerts: [{
      id: 'urn:oid:2.49.0.1.840.0.fixture.1',
      event: 'Extreme Heat Warning',
      severity: 'Severe',
      certainty: 'Likely',
      urgency: 'Expected',
      onset: iso(today + 10 * HOUR),
      effective: iso(today + 3 * HOUR),
      ends: iso(today + DAY + 20 * HOUR),
      expires: iso(today + 15 * HOUR),
      headline: 'Extreme Heat Warning in effect until Thursday evening — afternoon highs 112 to 116.',
      description: 'Dangerously hot conditions.',
      instruction: 'Limit time outdoors during the afternoon.',
      areaDesc: 'Greater Phoenix Area',
    }],
  };
}

/* ── GET routes ─────────────────────────────────────────────────────────── */

const site = (): Site => ({
  siteTimeZone: SITE_ZONE,
  source: 'SITE_TIMEZONE',
  lat: SITE_LAT,
  lon: SITE_LON,
  currency: 'USD',
  pvStrings: PV_STRINGS,
  locationSource: 'FORECAST_LAT/LON',
  pvStringsSource: 'PV_STRINGS',
  pv: { source: 'configured', nameplateW: 3 * (PV_STRINGS.hv.count + PV_STRINGS.lv.count) * PV_STRINGS.hv.watts, tiltDeg: 18, azimuthDeg: 185 },
  solar: { legacy: false, hemisphere: 'north', solarNoonHour: 12.48, daylightHours: [5, 20] },
  mainsV: { line: 120, split: 240 },
  perDpu: {},
});

/** A payload builder per GET path the web UI reads (path without the leading slash, no query). */
export type RouteBuilder = (q: URLSearchParams) => unknown;
export const ROUTES: Readonly<Record<string, RouteBuilder>> = {
  'api/site': () => site(),
  'api/runway': () => runway(),
  'api/summary/today': () => summaryToday(),
  'api/forecast': () => forecast(),
  'api/curtailment': () => curtailment(),
  'api/degradation': () => degradation(),
  'api/round-trip-efficiency': () => roundTrip(),
  'api/night-charge/status': () => nightChargeStatus(),
  'api/history': (q) => {
    const sn = q.get('sn') ?? '';
    const metric = q.get('metric') ?? '';
    const sinceMs = Number(q.get('since') ?? FIXTURE_NOW_MS - HOUR);
    const untilMs = Number(q.get('until') ?? FIXTURE_NOW_MS);
    const bucketSec = q.get('bucket') != null ? Number(q.get('bucket')) : undefined;
    return { sn, metric, sinceMs, untilMs, bucketSec, points: historySeries(sn, metric, sinceMs, untilMs, bucketSec) };
  },
  'api/circuit/history': (q) => circuitHistory(q),
  'api/alerts/history': (q) => clearedHistory(q),
  'api/device/refresh-cloud-cooldown': () => ({ remainingMs: 0, cooldownMs: 600_000 }),
  'api/db-export': () => ({ ok: true, exists: true, path: '/share/ecoflow-panel/ecoflow.db', bytes: 412_380_160, modifiedAt: new Date(FIXTURE_NOW_MS - 3 * HOUR - 12 * MIN).toISOString(), inProgress: false }),
  'api/self-consumption': () => selfConsumption(),
  'api/thermal-events': () => thermalEvents(),
  'api/equipment-health': () => equipmentHealth(),
  'api/shade-report': () => shadeReport(),
  'api/soiling-decomposition': () => soilingDecomposition(),
  'api/string-mismatch': () => stringMismatch(),
  'api/ev-window-prediction': () => evWindow(),
  'api/charge-curve': () => chargeCurve(),
  'api/internal-resistance': () => internalResistance(),
  'api/forecast-skill': () => forecastSkill(),
  'api/ambient-thermal-forecast': () => ambientThermal(),
  'api/confidence': () => confidence(),
  'api/nws-alerts': () => nwsAlerts(),
  'api/incidents': () => ({ incidents: incidents() }),
  'api/weather/ensemble': () => ({ sourcesCount: 2, avgDisagreementPct: 4.2, enrichedHourCount: 22, hourCount: 24 }),
  'api/alert-settings': () => ({
    priorities: (['critical', 'high', 'medium', 'low'] as const).map((id, rank) => ({
      id, label: id[0].toUpperCase() + id.slice(1), isa: `P${rank + 1}`, rank, tag: id.toUpperCase().slice(0, 4),
      colorToken: ['bad', 'high', 'warn', 'info'][rank], description: '', response: '', enabled: true,
    })),
    updatedAt: FIXTURE_NOW_MS - 30 * DAY,
  }),
  'api/broadcast/config': () => ({ enabled: true, volume: 0.6, announceVolume: null, announceVolumePinned: false, source: 'options', updatedAt: FIXTURE_NOW_MS - 30 * DAY, override: { enabled: null }, envBaseline: { enabled: true } }),
  'api/chimes': () => ({
    ok: true,
    levels: ['critical', 'high', 'medium', 'low', 'clear'],
    levelLabels: { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', clear: 'All clear' },
    assignments: { critical: { kind: 'builtin' }, high: { kind: 'builtin' }, medium: { kind: 'builtin' }, low: { kind: 'builtin' }, clear: { kind: 'builtin' } },
    chimes: [],
    builtinTones: [],
    updatedAt: FIXTURE_NOW_MS - 30 * DAY,
    maxUploadBytes: 2_000_000,
  }),
};

/**
 * Paths the web UI only ever WRITES to (POST/DELETE), each with the component that does. The fixture
 * serves none of them: a capture must never act, and serve.mts answers 405 to any write.
 */
export const WRITE_ONLY: Readonly<Record<string, string>> = {
  'api/alert-preview': 'AlertConsolePanel: speak or play a level (POST)',
  'api/alerts/outcome': 'AlertOutcomeButtons: real / false / failed (POST)',
  'api/chime-config': 'AlertConsolePanel: assign a tone to a level (POST)',
  'api/grid-veto/clear': 'GridVetoClear: clear a stale no-grid reading (POST)',
  'api/house-panel': 'HousePanelPin: pin the house panel (POST)',
  'api/night-charge/cancel': 'NightChargeCard: cancel tonight (POST)',
  'api/device/refresh-cloud': 'RefreshCloudButton: refresh a device cloud session (POST)',
  // v1.197.0 — the Core card's maintenance window (MaintenanceControl reads the snapshot's `maintenance`).
  'api/maintenance': "MaintenanceControl: shelve a Core's alarms for a set time (POST)",
  'api/maintenance/end': "MaintenanceControl: end a Core's maintenance window (POST)",
};

/** Paths that appear in web/src only inside comments (no request is made to them). */
export const COMMENT_ONLY: Readonly<Record<string, string>> = {
  'api/ha-state': 'types.ts and shp2ChargeText.ts name the Home Assistant feed in comments',
  'api/hassio_ingress': 'api.ts describes the Ingress mount point in comments',
  'api/snapshot': 'api.ts uses it as its example path; the snapshot arrives on /ws',
};
