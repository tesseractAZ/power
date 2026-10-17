/**
 * v1.188.1 — THE ENERGY BRIDGE: battery and solar energy measured at the Smart Home Panel 2's
 * source slots while a home Core's own telemetry is absent.
 *
 * WHY. Every lifetime battery and solar figure comes from the Cores themselves: battery in/out
 * from each pack's BMS coulomb registers (recorder.computeBmsBatteryDetail), solar from the
 * Cores' MPPT power (pv_total, integrated). On 2026-10-14 23:52 MST all five Cores went
 * cloud-offline while the panel stayed online. The packs' last values were held, so Home
 * Assistant's Energy dashboard read battery in/out 0/0 and solar 0.0 kWh for 10-15 and 10-16,
 * while the house ran ~48 kWh/day off those batteries; the vendor's own ledger for 10-15 reads
 * solar 48.8, battery out 49.0 kWh. The Now view read Power usage 0 W: Fleet PV and Battery Net
 * sum online Cores only, so they were withheld (unknown).
 *
 * WHAT THE PANEL MEASURES. Each source slot meters the AC exchange between its Core and the
 * panel (`sourceWatts[n-1]`, `backupInfo.chWatt`; negative = the Core supplies the panel). That
 * is NOT battery flow: PV that charges a Core's battery never crosses the slot, and the Cores'
 * own conversion and standby draw is invisible to it. The panel balance closes at AC (10-15:
 * grid 2.22 + slot out 45.60 kWh = 47.82 against a panel load of 47.95). So, for each DARK slot
 * (connected, its Core listed and cloud-offline — the exact complement of the Cores
 * aggregateFleetFlow sums), over each rollup window:
 *
 *     acOut = ∫ max(0, −chW),  acIn = ∫ max(0, chW)
 *     net   = acOut − acIn − pv        net ≥ 0 → battery out += net,  else battery in += −net
 *
 * which keeps grid + PV + battery out − battery in equal to the panel load, on the AC basis.
 * `pv` comes from one of three bases (BridgeBasis):
 *  - 'night'      the sun is down at both ends of the window (solar geometry, PHOENIX_SITE):
 *                 pv = 0. Physics, not a reading.
 *  - 'measured'   the panel's own per-source PV field (slotPvWatts), integrated — used only for a
 *                 slot whose field has read above 0 W with the sun up (persisted
 *                 `bridge_pvseen_<panel>_<slot>`). The field was unverified when this shipped:
 *                 it read 0 at night, and a 0 W reading from a field never seen working is not
 *                 "no PV".
 *  - 'inferred'   otherwise, in daylight: a monotone envelope of the slot's net AC output plus
 *                 the change in stored energy since the day's first daylight window,
 *                     cum(t) = max(prev, Σ(acOut − acIn) + (pct(t) − pct(anchor)) × capWh)
 *                 (capWh: the Core's measured full-charge capacity, the basis the panel's percent
 *                 is a fraction of). A LOWER BOUND: replayed on 8 recorded days it read 0.83-0.90
 *                 of the measured PV, short by a near-constant 4.7-6.1 kWh/day (the Cores' own
 *                 draw), and up to one SoC step (~290 Wh) per Core per anchor either way.
 *                 Energy-only: it has no instantaneous power, so the power sensors stay unknown.
 *  - 'unbridgeable' the panel reading is not fresh (shp2ReadbackFresh), or the inferred basis has
 *                 no SoC reading or a window the slot meter did not cover: nothing is booked.
 *                 Never PV that passed through a Core booked as battery out.
 *
 * PERSISTENCE AND HAND-OVER (recorder.ts). The bridged energy accumulates in its own rows
 * (`bridge_battery_charge_wh` / `_discharge_wh`, watermark = their ts), added to the emitted
 * battery totals on top of the BMS floors — never folded into the floors or the persisted
 * fleet_battery_* rows, whose v1.98.0 floor-gap check would read a bridged total above 50 kWh
 * as a floor for a pool that no longer exists and step Home Assistant DOWN (the phantom-kWh
 * failure). Bridged PV is added to `fleet_pv_wh` at each rollup (`bridge_pv_wh` keeps the
 * bridged share), and the dark Cores' own pv_total/ac_in contributors are skipped, so held
 * samples cannot double-count. For every held pack of a bridged Core a marker
 * `bridge_dark_<pack>` is written; when that Core reports again and its registers move, the
 * recorder re-baselines the pack so its BMS sum carries on from the held value: the counter jump
 * the dark days built is absorbed (the bridge already counted that energy), whatever its size.
 * Every term only grows, so nothing published steps down.
 *
 * LIMITS. AC basis at the panel (on the online days the inferred split kept battery in within
 * ~2 kWh/day of the DC counters and read battery out 5-8 kWh/day low); up to one rollup window
 * misattributed at each transition; nothing can be bridged while the panel itself is dark; and
 * there is no backfill — a bridge that starts mid-outage counts from its first window.
 *
 * Pure functions plus a small factory (createEnergyBridge) that the recorder hands its lifetime
 * table and sample queries.
 */
import type { DeviceSnapshot, FleetSnapshot } from './snapshot.js';
import type { Shp2EnergySource } from './ecoflow/project.js';
import { allShp2s, shp2ReadbackFresh } from './shp2Membership.js';
import { integrateWh, INTEGRATE_HEAD_LOOKBACK_MS } from './aggregator.js';
import { solarPosition, PHOENIX_SITE } from './physics/clearSky.js';

export const BRIDGE_CHARGE_KEY = 'bridge_battery_charge_wh';
export const BRIDGE_DISCHARGE_KEY = 'bridge_battery_discharge_wh';
export const BRIDGE_PV_KEY = 'bridge_pv_wh';
export const BRIDGE_GRID_IMPORT_KEY = 'bridge_grid_import_wh';
const DARK_PREFIX = 'bridge_dark_';
const PVSEEN_PREFIX = 'bridge_pvseen_';
const CORE_PREFIX = 'bridge_core_';
/** The hand-over marker for one held pack (its recorder cache key: `<sn>:<packSn>` or `<sn>|<num>`). */
export const bridgeDarkKey = (packCacheKey: string): string => `${DARK_PREFIX}${packCacheKey}`;
/** The persisted "this slot's PV field has read above 0 W with the sun up" flag. */
export const bridgePvSeenKey = (panelSn: string, slot: number): string => `${PVSEEN_PREFIX}${panelSn}_${slot}`;
/** Per-Core bridged energy since that Core went dark, for the hand-over line. */
export const bridgeCoreKey = (sn: string, kind: 'chg' | 'dsg'): string => `${CORE_PREFIX}${sn}_${kind}`;

/** A rollup window is never longer than this. Normal windows are 5 min; the first rollup after a
 *  restart would otherwise span the downtime (no samples: nothing lost by clamping), and a long
 *  window's sun test would not describe the part the samples cover. */
export const BRIDGE_MAX_WINDOW_MS = 15 * 60 * 1000;
/** The inferred basis needs the slot meter to cover this share of the window. */
export const BRIDGE_MIN_COVERAGE = 0.8;
/** The capacity reading is refreshed this often (pack full-charge capacity moves over weeks). */
const CAPACITY_CACHE_MS = 6 * 60 * 60 * 1000;

export type BridgeBasis = 'night' | 'measured' | 'inferred' | 'unbridgeable';

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Is the sun above the horizon at the site? (Spencer solar geometry, the PV model's own.) */
export function sunUp(ms: number): boolean {
  return solarPosition(new Date(ms), PHOENIX_SITE.lat, PHOENIX_SITE.lon).elevation > 0;
}

/** The panel's PV figure for one source slot, W: the two MPPT fields when either is reported
 *  (the Cores' own pv_total is pvHigh + pvLow), else pvChargeWatts. One function, so the choice
 *  can be changed in one place once the fields have been checked in daylight. */
export function slotPvWatts(src: Pick<Shp2EnergySource, 'pvWatts' | 'pvHighWatts' | 'pvLowWatts'>): number | null {
  const hv = finite(src.pvHighWatts);
  const lv = finite(src.pvLowWatts);
  if (hv != null || lv != null) return Math.max(0, hv ?? 0) + Math.max(0, lv ?? 0);
  const pv = finite(src.pvWatts);
  return pv == null ? null : Math.max(0, pv);
}

export interface DarkSlot {
  panelSn: string;
  /** 1-based, as the panel numbers its sources (`src<slot>_*` series, sourceWatts[slot − 1]). */
  slot: number;
  /** The dark Core. */
  sn: string;
  source: Shp2EnergySource;
  /** The slot meter now, W (negative = the Core supplies the panel). */
  chW: number | null;
  /** slotPvWatts(source) now. */
  pvW: number | null;
  /** The panel reading is a reading (shp2ReadbackFresh). */
  panelFresh: boolean;
}

/** A slot is dark when the panel lists it connected, names its Core, and that Core is listed on
 *  the account and cloud-offline. That is the exact complement of aggregateFleetFlow's members
 *  (onlineDpus ∩ connected): an online Core whose projection has not loaded yet (boot) is
 *  neither, so it keeps the v1.178.0 boot rule; a Core missing from the device list entirely is
 *  not bridged. */
function isDarkSource(src: Shp2EnergySource, devices: Record<string, DeviceSnapshot>): boolean {
  if (!src.isConnected || !src.sn) return false;
  const dpu = devices[src.sn];
  return dpu != null && dpu.online === false;
}

export function darkHomeSlots(devices: Record<string, DeviceSnapshot>, nowMs: number): DarkSlot[] {
  const out: DarkSlot[] = [];
  for (const panel of allShp2s(devices)) {
    const fresh = shp2ReadbackFresh(panel, nowMs);
    const watts = panel.projection.sourceWatts ?? [];
    for (const src of panel.projection.sources ?? []) {
      if (!isDarkSource(src, devices)) continue;
      out.push({
        panelSn: panel.sn,
        slot: src.slot,
        sn: src.sn as string,
        source: src,
        chW: finite(watts[src.slot - 1]),
        pvW: slotPvWatts(src),
        panelFresh: fresh,
      });
    }
  }
  return out;
}

/** The SNs of the dark Cores: their own pv_total / ac_in contributors are skipped by the
 *  lifetime rollup (the bridge meters them at the panel instead; a held sample is not a reading). */
export function darkCoreSns(devices: Record<string, DeviceSnapshot>): Set<string> {
  const out = new Set<string>();
  for (const panel of allShp2s(devices)) {
    for (const src of panel.projection.sources ?? []) {
      if (isDarkSource(src, devices)) out.add(src.sn as string);
    }
  }
  return out;
}

/** One window's battery split on the AC basis (see the module comment). Every output ≥ 0. */
export function windowSplit(acOutWh: number, acInWh: number, pvWh: number): { outWh: number; inWh: number } {
  const net = acOutWh - acInWh - pvWh;
  return net >= 0 ? { outWh: net, inWh: 0 } : { outWh: 0, inWh: -net };
}

/** The slot meter's two directions over [sinceMs, untilMs], Wh, with integrateWh's gap rules. */
export function slotAcEnergy(
  pts: ReadonlyArray<{ ts: number; value: number }>,
  sinceMs: number,
  untilMs: number,
): { acOutWh: number; acInWh: number; coverageMs: number } {
  const out = integrateWh(pts.map((p) => ({ ts: p.ts, value: Math.max(0, -p.value) })), sinceMs, untilMs);
  const inn = integrateWh(pts.map((p) => ({ ts: p.ts, value: Math.max(0, p.value) })), sinceMs, untilMs);
  return { acOutWh: Math.max(0, out.wh), acInWh: Math.max(0, inn.wh), coverageMs: out.coverageMs };
}

/** The value in force at `t`: the last sample at or before it. */
export function valueAt(pts: ReadonlyArray<{ ts: number; value: number }>, t: number): number | null {
  let v: number | null = null;
  for (const p of pts) {
    if (p.ts <= t) v = p.value;
    else break;
  }
  return v;
}

/** The inferred basis's per-slot state, held in memory from the day's first daylight window. */
export interface InferState {
  anchorPct: number;
  cumAcNetWh: number;
  envWh: number;
}

/**
 * One window of the inferred basis. `pctStart` / `pctEnd` are the slot's SoC (%) at the window's
 * edges, `capWh` the energy one hundred percent is. Returns the window's PV (Wh ≥ 0) and the next
 * state, or pvWh null when the window cannot be inferred (re-anchored at `pctEnd`): a window the
 * slot meter did not cover (a restart, a panel gap) must not land the SoC change it spans in one
 * step.
 */
export function inferPvStep(
  state: InferState | undefined,
  input: { pctStart: number | null; pctEnd: number | null; acNetWh: number; capWh: number; covered: boolean },
): { state: InferState | undefined; pvWh: number | null } {
  const { pctStart, pctEnd, acNetWh, capWh, covered } = input;
  if (pctEnd == null) return { state: undefined, pvWh: null };
  if (!covered || !(capWh > 0)) return { state: { anchorPct: pctEnd, cumAcNetWh: 0, envWh: 0 }, pvWh: null };
  let st = state;
  if (!st) {
    if (pctStart == null) return { state: { anchorPct: pctEnd, cumAcNetWh: 0, envWh: 0 }, pvWh: null };
    st = { anchorPct: pctStart, cumAcNetWh: 0, envWh: 0 };
  }
  const cum = st.cumAcNetWh + acNetWh;
  const f = cum + ((pctEnd - st.anchorPct) / 100) * capWh;
  const env = Math.max(st.envWh, f, 0);
  return { state: { anchorPct: st.anchorPct, cumAcNetWh: cum, envWh: env }, pvWh: env - st.envWh };
}

/** The power-sensor basis for one dark slot NOW (the inferred basis has no power figure). */
export function slotPowerBasis(s: DarkSlot, nowMs: number, trusted: boolean): BridgeBasis {
  if (!s.panelFresh || s.chW == null) return 'unbridgeable';
  if (!sunUp(nowMs)) return 'night';
  if (trusted && s.pvW != null) return 'measured';
  return 'unbridgeable';
}

export interface BridgedFleetFlow {
  /** Fleet PV, W: the online Cores' sum plus the dark slots' PV; null while a dark slot cannot be bridged. */
  fleetPv: number | null;
  /** Battery Net, W (positive = discharging): the online Cores' sum plus Σ(−chW − pv) over the dark slots. */
  fleetBatteryNet: number | null;
  /** Dark slots counted into the two figures. */
  bridgedSlots: number;
  /** false while any dark slot cannot be bridged right now (publishReadiness `flowBridged`). */
  ready: boolean;
  slots: Array<{ panelSn: string; slot: number; sn: string; basis: BridgeBasis; chW: number | null; pvW: number | null }>;
}

/**
 * The two power sensors the Energy dashboard's Now view rates on (Fleet PV, Battery Net), with
 * the dark slots metered at the panel: battery = −chW − pv per dark slot, pv from the panel field
 * ('measured') or 0 ('night'). `online` is aggregateFleetFlow's sums over the online Cores
 * (fleetPv and the display battery net). Pure.
 */
export function bridgeFleetFlow(
  online: { fleetPv: number; fleetBatteryNet: number },
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
  isTrusted: (panelSn: string, slot: number) => boolean,
): BridgedFleetFlow {
  let pv = online.fleetPv;
  let net = online.fleetBatteryNet;
  let ready = true;
  let bridgedSlots = 0;
  const slots: BridgedFleetFlow['slots'] = [];
  for (const s of darkHomeSlots(devices, nowMs)) {
    const basis = slotPowerBasis(s, nowMs, isTrusted(s.panelSn, s.slot));
    slots.push({ panelSn: s.panelSn, slot: s.slot, sn: s.sn, basis, chW: s.chW, pvW: s.pvW });
    if (basis === 'unbridgeable') { ready = false; continue; }
    const p = basis === 'measured' ? (s.pvW as number) : 0;
    pv += p;
    net += -(s.chW as number) - p;
    bridgedSlots += 1;
  }
  return { fleetPv: ready ? pv : null, fleetBatteryNet: ready ? net : null, bridgedSlots, ready, slots };
}

/** The pack cache keys (recorder packCacheKey) of every held pack row of Core `sn`. */
export function heldPackKeysOf(sn: string, lifetimeKeys: readonly string[]): string[] {
  const out: string[] = [];
  const stable = `pack_lastwhid_${sn}:`;
  const legacy = `pack_lastwh_${sn}_`;
  for (const k of lifetimeKeys) {
    if (!k.endsWith('_chg')) continue;
    if (k.startsWith(stable)) {
      out.push(k.slice('pack_lastwhid_'.length, -'_chg'.length));
    } else if (k.startsWith(legacy)) {
      const num = k.slice(legacy.length, -'_chg'.length);
      if (/^\d+$/.test(num)) out.push(`${sn}|${Number(num)}`);
    }
  }
  return out;
}

export interface BridgeSlotWindow {
  panelSn: string;
  slot: number;
  sn: string;
  basis: BridgeBasis;
  /** Why a window was not booked. */
  reason?: string;
  acOutWh: number;
  acInWh: number;
  pvWh: number;
  outWh: number;
  inWh: number;
}

export interface BridgeRollupResult {
  sinceMs: number;
  untilMs: number;
  /** Added to fleet_pv_wh by the caller. */
  pvWh: number;
  /** The dark Cores' AC input from the panel, added to fleet_grid_import_wh (their own ac_in is gone). */
  gridImportWh: number;
  chargeWh: number;
  dischargeWh: number;
  slots: BridgeSlotWindow[];
}

export interface EnergyBridgeDeps {
  readLifetime: (key: string) => { wh: number; ts: number };
  writeLifetime: (key: string, wh: number, ts: number) => void;
  deleteLifetime: (key: string) => void;
  listLifetimeKeys: () => string[];
  /** Raw samples, ascending. */
  query: (sn: string, metric: string, sinceMs: number, untilMs: number) => Array<{ ts: number; value: number }>;
  /** A Core's measured full-charge capacity (Σ its packs' fullCapMah × 0.1024 Wh/mAh), or null. */
  coreCapacityWh: (sn: string, nowMs: number) => number | null;
  log: (m: string) => void;
}

export interface EnergyBridgeDebug {
  chargeWh: number;
  dischargeWh: number;
  pvWh: number;
  gridImportWh: number;
  watermarkMs: number;
  /** Packs whose BMS jump will be absorbed when their Core reports again. */
  markers: string[];
  /** Slots whose PV field has read above 0 W with the sun up (the 'measured' basis). */
  trustedSlots: string[];
  /** Per-Core energy bridged since it went dark. */
  cores: Record<string, { chargeWh: number; dischargeWh: number }>;
  /** The dark slots now, with the power basis the two power sensors use. */
  slots: BridgedFleetFlow['slots'];
  lastRollup: BridgeRollupResult | null;
}

export interface EnergyBridge {
  rollup(snap: FleetSnapshot, nowMs: number): BridgeRollupResult;
  isTrusted(panelSn: string, slot: number): boolean;
  totals(): { chargeWh: number; dischargeWh: number; pvWh: number; gridImportWh: number };
  hasMarker(packCacheKey: string): boolean;
  clearMarker(packCacheKey: string): void;
  markersOf(sn: string): string[];
  coreBridged(sn: string): { chargeWh: number; dischargeWh: number };
  clearCore(sn: string): void;
  flow(online: { fleetPv: number; fleetBatteryNet: number }, devices: Record<string, DeviceSnapshot>, nowMs: number): BridgedFleetFlow;
  debug(devices: Record<string, DeviceSnapshot>, nowMs: number): EnergyBridgeDebug;
}

/** The debug block at its empty identity (the read-only worker recorder, test stubs). */
export function emptyBridgeDebug(): EnergyBridgeDebug {
  return { chargeWh: 0, dischargeWh: 0, pvWh: 0, gridImportWh: 0, watermarkMs: 0, markers: [], trustedSlots: [], cores: {}, slots: [], lastRollup: null };
}

const markerSn = (packCacheKey: string): string => {
  const c = packCacheKey.lastIndexOf(':');
  const p = packCacheKey.lastIndexOf('|');
  return packCacheKey.slice(0, Math.max(c, p));
};

export function createEnergyBridge(deps: EnergyBridgeDeps): EnergyBridge {
  const keys = deps.listLifetimeKeys();
  const markers = new Set<string>(keys.filter((k) => k.startsWith(DARK_PREFIX)).map((k) => k.slice(DARK_PREFIX.length)));
  const trusted = new Set<string>(keys.filter((k) => k.startsWith(PVSEEN_PREFIX)));
  const infer = new Map<string, InferState>();
  const capCache = new Map<string, { atMs: number; wh: number | null }>();
  let bridging = new Set<string>();
  let lastRollup: BridgeRollupResult | null = null;

  const capacityWh = (s: DarkSlot, nowMs: number): number | null => {
    const nameplate = finite(s.source.fullCap);
    let c = capCache.get(s.sn);
    if (!c || nowMs - c.atMs > CAPACITY_CACHE_MS) {
      c = { atMs: nowMs, wh: deps.coreCapacityWh(s.sn, nowMs) };
      capCache.set(s.sn, c);
    }
    const measured = c.wh != null && c.wh > 0 ? c.wh : null;
    if (measured != null && nameplate != null && nameplate > 0) return Math.min(measured, nameplate);
    return measured ?? (nameplate != null && nameplate > 0 ? nameplate : null);
  };

  const isTrusted = (panelSn: string, slot: number): boolean => trusted.has(bridgePvSeenKey(panelSn, slot));

  const add = (key: string, wh: number, ts: number) => {
    const prev = deps.readLifetime(key);
    deps.writeLifetime(key, prev.wh + Math.max(0, wh), ts);
  };

  const updateTrust = (devices: Record<string, DeviceSnapshot>, sinceMs: number, nowMs: number) => {
    for (const panel of allShp2s(devices)) {
      for (const src of panel.projection.sources ?? []) {
        const key = bridgePvSeenKey(panel.sn, src.slot);
        if (trusted.has(key)) continue;
        const pts = deps.query(panel.sn, `src${src.slot}_pv_w`, sinceMs, nowMs);
        const seen = pts.find((p) => p.value > 0 && sunUp(p.ts));
        if (!seen) continue;
        trusted.add(key);
        deps.writeLifetime(key, seen.value, seen.ts);
        deps.log(`energy bridge: panel ${panel.sn} slot ${src.slot} read ${Math.round(seen.value)} W of PV with the sun up — its PV field is trusted from now on (the 'measured' basis)`);
      }
    }
  };

  const rollup = (snap: FleetSnapshot, nowMs: number): BridgeRollupResult => {
    const own = deps.readLifetime(BRIDGE_CHARGE_KEY);
    const pvWm = deps.readLifetime('fleet_pv_wh');
    let since = own.ts > 0 ? own.ts : pvWm.ts > 0 ? pvWm.ts : nowMs - 60_000;
    since = Math.max(since, nowMs - BRIDGE_MAX_WINDOW_MS);
    const result: BridgeRollupResult = { sinceMs: since, untilMs: nowMs, pvWh: 0, gridImportWh: 0, chargeWh: 0, dischargeWh: 0, slots: [] };
    if (since >= nowMs) return result;
    updateTrust(snap.devices, since, nowMs);
    const night = !sunUp(since) && !sunUp(nowMs);
    const lifetimeKeys = deps.listLifetimeKeys();
    const nowBridging = new Set<string>();
    const coreAdd = new Map<string, { chg: number; dsg: number }>();
    for (const s of darkHomeSlots(snap.devices, nowMs)) {
      const inferKey = `${s.panelSn}#${s.slot}#${s.sn}`;
      const win: BridgeSlotWindow = { panelSn: s.panelSn, slot: s.slot, sn: s.sn, basis: 'unbridgeable', acOutWh: 0, acInWh: 0, pvWh: 0, outWh: 0, inWh: 0 };
      result.slots.push(win);
      if (!s.panelFresh) {
        win.reason = 'the panel reading is not fresh';
        infer.delete(inferKey);
        continue;
      }
      const wPts = deps.query(s.panelSn, `src${s.slot}_w`, since - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
      const ac = slotAcEnergy(wPts, since, nowMs);
      win.acOutWh = ac.acOutWh;
      win.acInWh = ac.acInWh;
      if (ac.coverageMs <= 0) {
        // No slot reading in the window: nothing measured, and a PV figure alone would book as charge.
        win.reason = 'no slot reading in the window';
        infer.delete(inferKey);
        continue;
      }
      let pvWh: number | null = null;
      if (night) {
        win.basis = 'night';
        pvWh = 0;
        infer.delete(inferKey);
      } else {
        if (isTrusted(s.panelSn, s.slot)) {
          const pvPts = deps.query(s.panelSn, `src${s.slot}_pv_w`, since - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
          const r = integrateWh(pvPts, since, nowMs);
          if (r.coverageMs >= BRIDGE_MIN_COVERAGE * Math.max(1, ac.coverageMs)) {
            win.basis = 'measured';
            pvWh = Math.max(0, r.wh);
            infer.delete(inferKey);
          }
        }
        if (pvWh == null) {
          const pctPts = deps.query(s.panelSn, `src${s.slot}_pct`, since - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
          const capWh = capacityWh(s, nowMs);
          const step = inferPvStep(infer.get(inferKey), {
            pctStart: valueAt(pctPts, since),
            pctEnd: valueAt(pctPts, nowMs),
            acNetWh: ac.acOutWh - ac.acInWh,
            capWh: capWh ?? 0,
            covered: ac.coverageMs >= BRIDGE_MIN_COVERAGE * (nowMs - since),
          });
          if (step.state) infer.set(inferKey, step.state);
          else infer.delete(inferKey);
          if (step.pvWh != null) {
            win.basis = 'inferred';
            pvWh = step.pvWh;
          } else {
            win.reason = capWh == null ? 'no capacity for the slot' : 'the window cannot be inferred (re-anchored)';
          }
        }
      }
      if (pvWh == null) continue;
      const split = windowSplit(ac.acOutWh, ac.acInWh, pvWh);
      win.pvWh = pvWh;
      win.outWh = split.outWh;
      win.inWh = split.inWh;
      result.pvWh += pvWh;
      result.gridImportWh += ac.acInWh;
      result.chargeWh += split.inWh;
      result.dischargeWh += split.outWh;
      const c = coreAdd.get(s.sn) ?? { chg: 0, dsg: 0 };
      c.chg += split.inWh;
      c.dsg += split.outWh;
      coreAdd.set(s.sn, c);
      nowBridging.add(s.sn);
      for (const pk of heldPackKeysOf(s.sn, lifetimeKeys)) {
        if (markers.has(pk)) continue;
        markers.add(pk);
        deps.writeLifetime(bridgeDarkKey(pk), 1, nowMs);
      }
    }
    for (const sn of nowBridging) {
      if (!bridging.has(sn)) deps.log(`energy bridge: Core ${sn} is cloud-offline — metering its battery and solar at the panel slot until it reports again`);
    }
    for (const sn of bridging) {
      if (!nowBridging.has(sn)) {
        const b = coreBridged(sn);
        deps.log(`energy bridge: Core ${sn} is no longer bridged (it reports again, or its slot cannot be bridged) — bridged so far ${(b.chargeWh / 1000).toFixed(2)} kWh in / ${(b.dischargeWh / 1000).toFixed(2)} kWh out`);
      }
    }
    bridging = nowBridging;
    for (const [sn, c] of coreAdd) {
      add(bridgeCoreKey(sn, 'chg'), c.chg, nowMs);
      add(bridgeCoreKey(sn, 'dsg'), c.dsg, nowMs);
    }
    // The four rows advance together; BRIDGE_CHARGE_KEY's ts is the bridge's watermark.
    add(BRIDGE_CHARGE_KEY, result.chargeWh, nowMs);
    add(BRIDGE_DISCHARGE_KEY, result.dischargeWh, nowMs);
    add(BRIDGE_PV_KEY, result.pvWh, nowMs);
    add(BRIDGE_GRID_IMPORT_KEY, result.gridImportWh, nowMs);
    lastRollup = result;
    return result;
  };

  const totals = () => ({
    chargeWh: deps.readLifetime(BRIDGE_CHARGE_KEY).wh,
    dischargeWh: deps.readLifetime(BRIDGE_DISCHARGE_KEY).wh,
    pvWh: deps.readLifetime(BRIDGE_PV_KEY).wh,
    gridImportWh: deps.readLifetime(BRIDGE_GRID_IMPORT_KEY).wh,
  });

  const coreBridged = (sn: string) => ({
    chargeWh: deps.readLifetime(bridgeCoreKey(sn, 'chg')).wh,
    dischargeWh: deps.readLifetime(bridgeCoreKey(sn, 'dsg')).wh,
  });

  return {
    rollup,
    isTrusted,
    totals,
    hasMarker: (k) => markers.has(k),
    clearMarker: (k) => {
      if (!markers.delete(k)) return;
      deps.deleteLifetime(bridgeDarkKey(k));
    },
    markersOf: (sn) => [...markers].filter((k) => markerSn(k) === sn),
    coreBridged,
    clearCore: (sn) => {
      deps.deleteLifetime(bridgeCoreKey(sn, 'chg'));
      deps.deleteLifetime(bridgeCoreKey(sn, 'dsg'));
    },
    flow: (online, devices, nowMs) => bridgeFleetFlow(online, devices, nowMs, isTrusted),
    debug: (devices, nowMs) => {
      const t = totals();
      const cores: Record<string, { chargeWh: number; dischargeWh: number }> = {};
      for (const k of deps.listLifetimeKeys()) {
        const m = /^bridge_core_(.+)_chg$/.exec(k);
        if (m) cores[m[1]] = coreBridged(m[1]);
      }
      return {
        ...t,
        watermarkMs: deps.readLifetime(BRIDGE_CHARGE_KEY).ts,
        markers: [...markers].sort(),
        trustedSlots: [...trusted].map((k) => k.slice(PVSEEN_PREFIX.length)).sort(),
        cores,
        slots: bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devices, nowMs, isTrusted).slots,
        lastRollup,
      };
    },
  };
}
