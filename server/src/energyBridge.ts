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
 * (connected, its Core listed and cloud-offline for at least BRIDGE_DWELL_MS — see below), over
 * each rollup window:
 *
 *     acOut = ∫ max(0, −chW),  acIn = ∫ max(0, chW)
 *     net   = acOut − acIn − pv        net ≥ 0 → battery out += net,  else battery in += −net
 *
 * which keeps grid + PV + battery out − battery in equal to the panel load, on the AC basis.
 * `pv` comes from one of three bases (BridgeBasis):
 *  - 'night'      the sun is down at both ends of the window (solar geometry at the configured
 *                 install site, FORECAST_LAT / FORECAST_LON: bridgeSite, which the recorder hands
 *                 in as deps.site): pv = 0. Physics, not a reading.
 *  - 'measured'   the panel's own per-source PV field (slotPvWatts), integrated — used only for a
 *                 slot whose field has been CHECKED against the inferred lower bound below
 *                 (persisted `bridge_pvseen_<panel>_<slot>`). The field was unverified when this
 *                 shipped (it read 0 at night), so one reading proves nothing: the inferred figure
 *                 runs alongside it in every daylight window of a dark slot, and once it has risen
 *                 BRIDGE_PV_EVIDENCE_STEPS SoC steps the field is trusted if it reads at least the
 *                 bound less one SoC step (pvFieldVerdict). Below that it is not trusted, and a
 *                 trusted field that falls below it is revoked — the check never stops. The bound
 *                 is a lower one, so a field reading HIGH is not caught.
 *  - 'inferred'   otherwise, in daylight: a monotone envelope of the slot's net AC output plus
 *                 the change in stored energy since the day's first daylight window,
 *                     cum(t) = max(prev, Σ(acOut − acIn) + (pct(t) − pct(anchor)) × capWh)
 *                 (capWh: the Core's measured full-charge capacity, the basis the panel's percent
 *                 is a fraction of). A LOWER BOUND: replayed on 8 recorded days it read 0.83-0.90
 *                 of the measured PV, short by a near-constant 4.7-6.1 kWh/day (the Cores' own
 *                 draw), and up to one SoC step (~290 Wh) per Core per anchor either way.
 *                 Energy-only: it has no instantaneous power, so the power sensors stay unknown.
 *  - 'unbridgeable' the panel reading is not fresh (shp2ReadbackFresh), or the inferred basis has
 *                 no SoC reading or a window the slot meter did not cover: nothing is booked. The
 *                 power sensors withhold both figures for such a slot on an ONLINE panel, and leave
 *                 a slot on a cloud-offline panel out of both (bridgeFleetFlow).
 *                 Never PV that passed through a Core booked as battery out.
 *
 * WHEN A CORE IS DARK. A /status flip lasts seconds (setDeviceOnline) and a /device/list blip
 * flagged three Cores offline for ~92 s on 2026-10-03: neither is an outage. A Core is bridged once
 * it has been cloud-offline for BRIDGE_DWELL_MS (its `onlineChangedAtMs`), or when it was offline
 * since before this process saw it (no transition time). The bridge takes it over at the instant it
 * went offline: its window starts at max(the rollup watermark, that instant), and the recorder
 * counts the Core's own pv_total / ac_in only up to it (offlineHomeCores, ownEnergyUntil) — on
 * every read at once, and in a rollup once the dwell has passed (a rollup inside the dwell still
 * counts the Core itself, and the bridge then starts at that rollup). So the read path never
 * drops energy it already showed, and no stretch is counted twice. A blip shorter than the dwell
 * writes no marker and no log line.
 *
 * PERSISTENCE AND HAND-OVER (recorder.ts). The bridged energy accumulates in its own rows
 * (`bridge_battery_charge_wh` / `_discharge_wh`, watermark = their ts), added to the emitted
 * battery totals on top of the BMS floors — never folded into the floors or the persisted
 * fleet_battery_* rows, whose v1.98.0 floor-gap check would read a bridged total above 50 kWh
 * as a floor for a pool that no longer exists and step Home Assistant DOWN (a negative hour while
 * the step is under 10 % of the counter, a meter reset — the phantom-kWh failure — at 10 % or
 * more). Bridged PV is added to `fleet_pv_wh` at each rollup (`bridge_pv_wh` keeps the
 * bridged share), and the dark Cores' own pv_total/ac_in count only up to the hand-off instant,
 * so held samples cannot double-count. For every held pack of a bridged Core a marker
 * `bridge_dark_<pack>` is written; when that Core reports again and its registers move, the
 * recorder re-baselines the pack so its BMS sum carries on from the held value: the counter jump
 * the dark days built is absorbed (the bridge already counted that energy), whatever its size.
 * The marker is spent only once the Core has REPORTED since it came back (reportsSinceReturn: its
 * content changed at or after its online flip). Register movement before that — MQTT data that
 * still arrives while the cloud lists the Core offline, or a frozen projection at an online flip
 * that lands before the first fresh reading — is absorbed as it is seen (re-baselined, the marker
 * kept), so the held value never trails the projection and the real jump cannot pass later.
 * Every term only grows, so nothing published steps down; as a backstop, the two counters whose
 * contributors change here (fleet_pv_wh, fleet_grid_import_wh) hold a dip between rollups up to
 * LIFETIME_HOLD_DIP_WH (recorder.ts). The per-Core rows
 * (`bridge_core_<sn>_*`, the figures the hand-over line and the "no longer bridged" line print)
 * are cleared by the bridge's own rollup once the Core has left the dark set and every marker of
 * it is handed over — never by the hand-over itself, which usually runs first (a read).
 *
 * LIMITS. AC basis at the panel (on the online days the inferred split kept battery in within
 * ~2 kWh/day of the DC counters and read battery out 5-8 kWh/day low); up to one rollup window
 * misattributed at the return, and the BMS energy from the online flip to the Core's first fresh
 * reading is absorbed (seconds for a Core streaming MQTT); at an outage start, the battery flow
 * from the Core's last register reading to the bridge's window start (the cloud's offline
 * detection, and a rollup that fell inside the dwell: at most BRIDGE_DWELL_MS) is absorbed
 * unbridged, while register data that MQTT still delivers before the bridge's first marker is
 * counted by the BMS and again by the bridge (at most one rollup window); nothing can be bridged
 * while the panel itself is dark; and there is no backfill — a bridge that starts mid-outage
 * counts from its first window.
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
const ABSORBED_PREFIX = 'bridge_absorbed_';
const PVSEEN_PREFIX = 'bridge_pvseen_';
const CORE_PREFIX = 'bridge_core_';
/** The hand-over marker for one held pack (its recorder cache key: `<sn>:<packSn>` or `<sn>|<num>`). */
export const bridgeDarkKey = (packCacheKey: string): string => `${DARK_PREFIX}${packCacheKey}`;
/** BMS energy of a marked pack absorbed before its hand-over (register movement while its Core had
 *  not reported since its return), for the hand-over line. Deleted with the marker. */
export const bridgeAbsorbedKey = (packCacheKey: string, kind: 'chg' | 'dsg'): string => `${ABSORBED_PREFIX}${packCacheKey}_${kind}`;
/** The persisted "this slot's PV field passed its check against the inferred lower bound" flag
 *  (deleted when a later check finds the field below the bound). */
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
/** A Core is bridged once it has been cloud-offline this long. Longer than a /status flip (6 s)
 *  and the 2026-10-03 /device/list blip (~92 s); short against an outage. */
export const BRIDGE_DWELL_MS = 3 * 60 * 1000;
/** The panel PV field is judged once the inferred lower bound has risen this many SoC steps
 *  (~1.1 kWh on a 28.7 kWh Core). The bound is good to one step, so a field reading a fraction r of
 *  the solar passes the first verdict only when r ≥ 1 − 1/steps (0.75 here), and is revoked once
 *  the shortfall exceeds a step. */
export const BRIDGE_PV_EVIDENCE_STEPS = 4;

export type BridgeBasis = 'night' | 'measured' | 'inferred' | 'unbridgeable';

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Where the bridge's day/night test is judged. */
export interface BridgeSite { lat: number; lon: number }

/** The site the bridge's day/night test is judged at, from the configured install location
 *  (`config.forecastLat` / `forecastLon`: FORECAST_LAT / FORECAST_LON, the solar forecast's); the
 *  options' default (Phoenix) when it is not a usable coordinate. The recorder reads it at each
 *  use (deps.site). This module does not import config itself: test helpers import it statically,
 *  before the env their app imports read. */
export function bridgeSite(cfg: { forecastLat: number; forecastLon: number }): BridgeSite {
  const lat = cfg.forecastLat;
  const lon = cfg.forecastLon;
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  return { lat: PHOENIX_SITE.lat, lon: PHOENIX_SITE.lon };
}

/** Is the sun above the horizon at the site? (Spencer solar geometry, the PV model's own.) */
export function sunUp(ms: number, site: BridgeSite): boolean {
  return solarPosition(new Date(ms), site.lat, site.lon).elevation > 0;
}

/**
 * Has Core `d` reported since it last came back online? It is online, and its content
 * (dpuContentWitness, v1.181.0) changed at or after its online flip — or, online since before this
 * process saw it (no transition time), changed at all (the store's first body after a restart only
 * seeds the witness: it may be a replay). A frozen projection, MQTT data that arrived while the
 * cloud listed the Core offline, and a REST body replaying a cached one do not count. The
 * hand-over (recorder.computeBmsBatteryDetail) waits for it.
 */
export function reportsSinceReturn(d: Pick<DeviceSnapshot, 'online' | 'onlineChangedAtMs' | 'contentChangedAtMs'>): boolean {
  if (d.online !== true) return false;
  const c = finite(d.contentChangedAtMs);
  if (c == null) return false;
  const o = finite(d.onlineChangedAtMs);
  return o == null || c >= o;
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
  /** When the Core went offline (`onlineChangedAtMs`): the bridge's window never starts before it.
   *  null = offline since before this process saw it. */
  darkSinceMs: number | null;
  source: Shp2EnergySource;
  /** The slot meter now, W (negative = the Core supplies the panel). */
  chW: number | null;
  /** slotPvWatts(source) now. */
  pvW: number | null;
  /** The panel reading is a reading (shp2ReadbackFresh). */
  panelFresh: boolean;
  /** The panel itself is listed online. A slot on a cloud-offline panel (a second panel that dropped
   *  off the cloud with its Cores) cannot be read at all, so the power sensors leave it out of their
   *  sums, as an offline Core always was, rather than withholding the whole plant's figures. */
  panelOnline: boolean;
}

/** A home Core the panel lists connected that is listed on the account and cloud-offline. */
export interface OfflineHomeCore {
  /** When it went offline (`onlineChangedAtMs`, capped at now); null = offline since before this
   *  process saw it (the device list's first sight carries no transition). */
  offlineSinceMs: number | null;
  /** The bridge has taken it over: offline for BRIDGE_DWELL_MS, or since before this process. */
  bridged: boolean;
}

/** A slot's Core is offline when the panel lists the slot connected, names its Core, and that Core
 *  is listed on the account and cloud-offline. Bridged (dark) once the dwell has passed: with the
 *  online Cores that is the complement of aggregateFleetFlow's members (onlineDpus ∩ connected)
 *  less the Cores inside the dwell. An online Core whose projection has not loaded yet (boot) is
 *  neither, so it keeps the v1.178.0 boot rule; a Core missing from the device list entirely is
 *  not bridged. */
function offlineState(src: Shp2EnergySource, devices: Record<string, DeviceSnapshot>, nowMs: number): OfflineHomeCore | null {
  if (!src.isConnected || !src.sn) return null;
  const dpu = devices[src.sn];
  if (dpu == null || dpu.online !== false) return null;
  const t = finite(dpu.onlineChangedAtMs);
  const offlineSinceMs = t == null ? null : Math.min(t, nowMs);
  return { offlineSinceMs, bridged: offlineSinceMs == null || nowMs - offlineSinceMs >= BRIDGE_DWELL_MS };
}

/** Every offline home Core, by SN (the recorder's contributor cut, ownEnergyUntil). */
export function offlineHomeCores(devices: Record<string, DeviceSnapshot>, nowMs: number): Map<string, OfflineHomeCore> {
  const out = new Map<string, OfflineHomeCore>();
  for (const panel of allShp2s(devices)) {
    for (const src of panel.projection.sources ?? []) {
      const o = offlineState(src, devices, nowMs);
      if (o) out.set(src.sn as string, o);
    }
  }
  return out;
}

/**
 * How far a home Core's OWN pv_total / ac_in count in a lifetime integral (recorder
 * buildContributors): undefined = no limit (it reports, or a rollup inside the dwell); a number =
 * up to that instant, the one the bridge's window starts from; null = not at all (offline since
 * before this process saw it: nothing of it is pending, and the bridge starts at its watermark).
 * `read` applies the cut at once: a read must never show energy the next rollup will not keep.
 */
export function ownEnergyUntil(o: OfflineHomeCore | undefined, phase: 'read' | 'rollup'): number | null | undefined {
  if (!o) return undefined;
  if (phase === 'rollup' && !o.bridged) return undefined;
  return o.offlineSinceMs;
}

export function darkHomeSlots(devices: Record<string, DeviceSnapshot>, nowMs: number): DarkSlot[] {
  const out: DarkSlot[] = [];
  for (const panel of allShp2s(devices)) {
    const fresh = shp2ReadbackFresh(panel, nowMs);
    const watts = panel.projection.sourceWatts ?? [];
    for (const src of panel.projection.sources ?? []) {
      const o = offlineState(src, devices, nowMs);
      if (!o?.bridged) continue;
      out.push({
        panelSn: panel.sn,
        slot: src.slot,
        sn: src.sn as string,
        darkSinceMs: o.offlineSinceMs,
        source: src,
        chW: finite(watts[src.slot - 1]),
        pvW: slotPvWatts(src),
        panelFresh: fresh,
        panelOnline: panel.online === true,
      });
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

/**
 * Does the panel's PV field agree with the inferred lower bound over the same windows? `fieldWh`
 * is the field's integral, `inferredWh` the inferred envelope's rise, `stepWh` one SoC step (1 % of
 * the capacity: the percent is an integer, so the bound is good to one step). 'pending' until the
 * bound has risen BRIDGE_PV_EVIDENCE_STEPS steps; then 'consistent' when the field reads at least
 * the bound less one step, else 'below' (it reads less PV than the Core demonstrably took in). A
 * field reading high is not caught: the bound is a lower one.
 */
export function pvFieldVerdict(fieldWh: number, inferredWh: number, stepWh: number): 'pending' | 'consistent' | 'below' {
  if (!(stepWh > 0) || inferredWh < BRIDGE_PV_EVIDENCE_STEPS * stepWh) return 'pending';
  return fieldWh >= inferredWh - stepWh ? 'consistent' : 'below';
}

/** The power-sensor basis for one dark slot NOW (the inferred basis has no power figure). */
export function slotPowerBasis(s: DarkSlot, nowMs: number, trusted: boolean, site: BridgeSite): BridgeBasis {
  if (!s.panelFresh || s.chW == null) return 'unbridgeable';
  if (!sunUp(nowMs, site)) return 'night';
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
  /** false while any dark slot on an online panel cannot be bridged right now (publishReadiness
   *  `flowBridged`). */
  ready: boolean;
  /** `leftOut`: the slot's panel is cloud-offline, so the slot is in neither figure and withholds
   *  neither (its basis reads 'unbridgeable'). */
  slots: Array<{ panelSn: string; slot: number; sn: string; basis: BridgeBasis; chW: number | null; pvW: number | null; leftOut: boolean }>;
}

/**
 * The two power sensors the Energy dashboard's Now view rates on (Fleet PV, Battery Net), with
 * the dark slots metered at the panel: battery = −chW − pv per dark slot, pv from the panel field
 * ('measured') or 0 ('night'). `online` is aggregateFleetFlow's sums over the online Cores
 * (fleetPv and the display battery net). A dark slot on an online panel that cannot be bridged
 * right now withholds both figures (unknown, never a partial sum); one on a cloud-offline panel is
 * left out of both, as an offline Core was before the bridge: nothing of it can be read until that
 * panel returns, and on a two-panel plant it must not blank the other panel's Cores. Pure.
 */
export function bridgeFleetFlow(
  online: { fleetPv: number; fleetBatteryNet: number },
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
  isTrusted: (panelSn: string, slot: number) => boolean,
  site: BridgeSite,
): BridgedFleetFlow {
  let pv = online.fleetPv;
  let net = online.fleetBatteryNet;
  let ready = true;
  let bridgedSlots = 0;
  const slots: BridgedFleetFlow['slots'] = [];
  for (const s of darkHomeSlots(devices, nowMs)) {
    if (!s.panelOnline) {
      slots.push({ panelSn: s.panelSn, slot: s.slot, sn: s.sn, basis: 'unbridgeable', chW: s.chW, pvW: s.pvW, leftOut: true });
      continue;
    }
    const basis = slotPowerBasis(s, nowMs, isTrusted(s.panelSn, s.slot), site);
    slots.push({ panelSn: s.panelSn, slot: s.slot, sn: s.sn, basis, chW: s.chW, pvW: s.pvW, leftOut: false });
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
  /** This slot's window start: max(the rollup's sinceMs, the instant its Core went offline). */
  sinceMs: number;
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
  /** The install site for the day/night test (bridgeSite of the configured location), read at each use. */
  site: () => BridgeSite;
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
  /** BMS energy of marked packs already absorbed before their hand-over (register movement while
   *  the Core had not reported since its return), per pack. */
  absorbed: Array<{ pack: string; chargeWh: number; dischargeWh: number }>;
  /** Slots whose PV field passed its check against the inferred lower bound (the 'measured' basis). */
  trustedSlots: string[];
  /** The running check of each dark slot's PV field against the inferred lower bound (Wh). */
  pvChecks: Array<{ slot: string; sinceMs: number; fieldWh: number; inferredWh: number; stepWh: number; verdict: 'pending' | 'consistent' | 'below' }>;
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
  /** Register movement of a marked pack before its hand-over: absorbed (the caller re-baselines),
   *  the marker kept, the energy kept for the hand-over line. */
  absorb(packCacheKey: string, chgWh: number, dsgWh: number): void;
  /** The hand-over: deletes the marker and returns the energy absorbed before it (deleted too). */
  clearMarker(packCacheKey: string): { chgWh: number; dsgWh: number };
  markersOf(sn: string): string[];
  coreBridged(sn: string): { chargeWh: number; dischargeWh: number };
  clearCore(sn: string): void;
  flow(online: { fleetPv: number; fleetBatteryNet: number }, devices: Record<string, DeviceSnapshot>, nowMs: number): BridgedFleetFlow;
  debug(devices: Record<string, DeviceSnapshot>, nowMs: number): EnergyBridgeDebug;
}

/** The debug block at its empty identity (the read-only worker recorder, test stubs). */
export function emptyBridgeDebug(): EnergyBridgeDebug {
  return { chargeWh: 0, dischargeWh: 0, pvWh: 0, gridImportWh: 0, watermarkMs: 0, markers: [], absorbed: [], trustedSlots: [], pvChecks: [], cores: {}, slots: [], lastRollup: null };
}

const markerSn = (packCacheKey: string): string => {
  const c = packCacheKey.lastIndexOf(':');
  const p = packCacheKey.lastIndexOf('|');
  return packCacheKey.slice(0, Math.max(c, p));
};

/** One dark slot's running check of its PV field against the inferred lower bound. */
interface FieldCheck {
  sinceMs: number;
  /** The inferred envelope when the check started. */
  envBaseWh: number;
  fieldWh: number;
  inferredWh: number;
  stepWh: number;
  verdict: 'pending' | 'consistent' | 'below';
}

const kWh = (wh: number): string => (wh / 1000).toFixed(2);

export function createEnergyBridge(deps: EnergyBridgeDeps): EnergyBridge {
  const keys = deps.listLifetimeKeys();
  const markers = new Set<string>(keys.filter((k) => k.startsWith(DARK_PREFIX)).map((k) => k.slice(DARK_PREFIX.length)));
  const trusted = new Set<string>(keys.filter((k) => k.startsWith(PVSEEN_PREFIX)));
  const infer = new Map<string, InferState>();
  const checks = new Map<string, FieldCheck>();
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

  const markersOf = (sn: string): string[] => [...markers].filter((k) => markerSn(k) === sn);

  const coreBridged = (sn: string) => ({
    chargeWh: deps.readLifetime(bridgeCoreKey(sn, 'chg')).wh,
    dischargeWh: deps.readLifetime(bridgeCoreKey(sn, 'dsg')).wh,
  });

  const clearCore = (sn: string) => {
    deps.deleteLifetime(bridgeCoreKey(sn, 'chg'));
    deps.deleteLifetime(bridgeCoreKey(sn, 'dsg'));
  };

  /**
   * One daylight window of a dark slot's PV-field check (pvFieldVerdict): the field's integral and
   * the inferred envelope's rise accumulate from the check's start; the check restarts whenever
   * either cannot be read for a window (the field uncovered, the inferred basis re-anchored), and at
   * night. A 'below' verdict holds for the rest of the check: no trust/revoke churn within a day.
   */
  const checkField = (
    s: DarkSlot, key: string, prevEnvWh: number, step: { state: InferState | undefined; pvWh: number | null },
    fieldWh: number | null, capWh: number | null, startMs: number, nowMs: number,
  ): void => {
    if (step.pvWh == null || !step.state || capWh == null || !(capWh > 0) || fieldWh == null) {
      checks.delete(key);
      return;
    }
    let c = checks.get(key);
    if (!c) {
      c = { sinceMs: startMs, envBaseWh: prevEnvWh, fieldWh: 0, inferredWh: 0, stepWh: capWh / 100, verdict: 'pending' };
      checks.set(key, c);
    }
    c.fieldWh += fieldWh;
    c.inferredWh = step.state.envWh - c.envBaseWh;
    c.stepWh = capWh / 100;
    if (c.verdict === 'below') return;
    const v = pvFieldVerdict(c.fieldWh, c.inferredWh, c.stepWh);
    if (v === 'pending' || v === c.verdict) return;
    c.verdict = v;
    const tk = bridgePvSeenKey(s.panelSn, s.slot);
    const figures = `PV field read ${kWh(c.fieldWh)} kWh since ${new Date(c.sinceMs).toISOString()} against the inferred lower bound ${kWh(c.inferredWh)} kWh (one SoC step ${kWh(c.stepWh)} kWh)`;
    if (v === 'consistent') {
      if (trusted.has(tk)) return;
      trusted.add(tk);
      deps.writeLifetime(tk, c.fieldWh, nowMs);
      deps.log(`energy bridge: panel ${s.panelSn} slot ${s.slot} ${figures} — the field is trusted from now on (the 'measured' basis)`);
      return;
    }
    if (trusted.delete(tk)) {
      deps.deleteLifetime(tk);
      deps.log(`energy bridge: panel ${s.panelSn} slot ${s.slot} ${figures} — below it by more than one SoC step: the field is no longer trusted (back to the inferred basis)`);
    } else {
      deps.log(`energy bridge: panel ${s.panelSn} slot ${s.slot} ${figures} — below it by more than one SoC step: the field is not trusted (the inferred basis stays)`);
    }
  };

  const rollup = (snap: FleetSnapshot, nowMs: number): BridgeRollupResult => {
    const own = deps.readLifetime(BRIDGE_CHARGE_KEY);
    const pvWm = deps.readLifetime('fleet_pv_wh');
    let since = own.ts > 0 ? own.ts : pvWm.ts > 0 ? pvWm.ts : nowMs - 60_000;
    since = Math.max(since, nowMs - BRIDGE_MAX_WINDOW_MS);
    const result: BridgeRollupResult = { sinceMs: since, untilMs: nowMs, pvWh: 0, gridImportWh: 0, chargeWh: 0, dischargeWh: 0, slots: [] };
    if (since >= nowMs) return result;
    const lifetimeKeys = deps.listLifetimeKeys();
    const nowBridging = new Map<string, DarkSlot>();
    /** The inferred / check state still in use: a slot not dark in daylight now keeps none. */
    const live = new Set<string>();
    const coreAdd = new Map<string, { chg: number; dsg: number }>();
    const site = deps.site();
    for (const s of darkHomeSlots(snap.devices, nowMs)) {
      nowBridging.set(s.sn, s);
      const inferKey = `${s.panelSn}#${s.slot}#${s.sn}`;
      // The bridge takes the Core over at the instant it went offline: before it the Core's own
      // figures count (the recorder cuts them there), so this window never books them twice.
      const start = Math.max(since, s.darkSinceMs ?? since);
      const win: BridgeSlotWindow = { panelSn: s.panelSn, slot: s.slot, sn: s.sn, sinceMs: start, basis: 'unbridgeable', acOutWh: 0, acInWh: 0, pvWh: 0, outWh: 0, inWh: 0 };
      result.slots.push(win);
      if (start >= nowMs) {
        win.reason = 'no time in the window since the Core went offline';
        continue;
      }
      if (!s.panelFresh) {
        win.reason = 'the panel reading is not fresh';
        continue;
      }
      const wPts = deps.query(s.panelSn, `src${s.slot}_w`, start - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
      const ac = slotAcEnergy(wPts, start, nowMs);
      win.acOutWh = ac.acOutWh;
      win.acInWh = ac.acInWh;
      if (ac.coverageMs <= 0) {
        // No slot reading in the window: nothing measured, and a PV figure alone would book as charge.
        win.reason = 'no slot reading in the window';
        continue;
      }
      let pvWh: number | null = null;
      if (!sunUp(start, site) && !sunUp(nowMs, site)) {
        win.basis = 'night';
        pvWh = 0;
      } else {
        live.add(inferKey);
        // The inferred lower bound runs in every daylight window, whatever the basis: it is the
        // basis when the field is not trusted, and the check on the field when it is.
        const pctPts = deps.query(s.panelSn, `src${s.slot}_pct`, start - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
        const capWh = capacityWh(s, nowMs);
        const prior = infer.get(inferKey);
        const step = inferPvStep(prior, {
          pctStart: valueAt(pctPts, start),
          pctEnd: valueAt(pctPts, nowMs),
          acNetWh: ac.acOutWh - ac.acInWh,
          capWh: capWh ?? 0,
          covered: ac.coverageMs >= BRIDGE_MIN_COVERAGE * (nowMs - start),
        });
        if (step.state) infer.set(inferKey, step.state);
        else infer.delete(inferKey);
        const pvPts = deps.query(s.panelSn, `src${s.slot}_pv_w`, start - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
        const field = integrateWh(pvPts, start, nowMs);
        const fieldWh = field.coverageMs >= BRIDGE_MIN_COVERAGE * Math.max(1, ac.coverageMs) ? Math.max(0, field.wh) : null;
        checkField(s, inferKey, prior?.envWh ?? 0, step, fieldWh, capWh, start, nowMs);
        if (fieldWh != null && isTrusted(s.panelSn, s.slot)) {
          win.basis = 'measured';
          pvWh = fieldWh;
        } else if (step.pvWh != null) {
          win.basis = 'inferred';
          pvWh = step.pvWh;
        } else {
          win.reason = capWh == null ? 'no capacity for the slot' : 'the window cannot be inferred (re-anchored)';
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
      for (const pk of heldPackKeysOf(s.sn, lifetimeKeys)) {
        if (markers.has(pk)) continue;
        markers.add(pk);
        deps.writeLifetime(bridgeDarkKey(pk), 1, nowMs);
      }
    }
    // A slot that is not dark in daylight now keeps no inferred state and no field check, so a
    // later dark span starts both afresh (a stale anchor would land the whole SoC change since).
    for (const k of [...infer.keys()]) if (!live.has(k)) infer.delete(k);
    for (const k of [...checks.keys()]) if (!live.has(k)) checks.delete(k);
    // The transitions, logged before the per-Core rows below can be cleared.
    for (const [sn, s] of nowBridging) {
      if (bridging.has(sn)) continue;
      const at = s.darkSinceMs != null ? ` since ${new Date(s.darkSinceMs).toISOString()}` : '';
      deps.log(`energy bridge: Core ${sn} is cloud-offline${at} — metering its battery and solar at panel ${s.panelSn} slot ${s.slot} until it reports again`);
    }
    for (const sn of bridging) {
      if (nowBridging.has(sn)) continue;
      const b = coreBridged(sn);
      deps.log(`energy bridge: Core ${sn} is no longer bridged (it reports again, or its slot is no longer connected) — bridged ${kWh(b.chargeWh)} kWh in / ${kWh(b.dischargeWh)} kWh out while dark`);
    }
    bridging = new Set(nowBridging.keys());
    // A Core's bridged figures are kept until it has left the dark set and every marker of it has
    // been handed over (the hand-over line reads them), then cleared here.
    for (const k of lifetimeKeys) {
      const m = /^bridge_core_(.+)_chg$/.exec(k);
      if (m && !bridging.has(m[1]) && markersOf(m[1]).length === 0) clearCore(m[1]);
    }
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

  return {
    rollup,
    isTrusted,
    totals,
    hasMarker: (k) => markers.has(k),
    absorb: (k, chgWh, dsgWh) => {
      if (!markers.has(k)) return;
      if (chgWh > 0) add(bridgeAbsorbedKey(k, 'chg'), chgWh, Date.now());
      if (dsgWh > 0) add(bridgeAbsorbedKey(k, 'dsg'), dsgWh, Date.now());
    },
    clearMarker: (k) => {
      const absorbed = { chgWh: deps.readLifetime(bridgeAbsorbedKey(k, 'chg')).wh, dsgWh: deps.readLifetime(bridgeAbsorbedKey(k, 'dsg')).wh };
      if (!markers.delete(k)) return { chgWh: 0, dsgWh: 0 };
      deps.deleteLifetime(bridgeDarkKey(k));
      deps.deleteLifetime(bridgeAbsorbedKey(k, 'chg'));
      deps.deleteLifetime(bridgeAbsorbedKey(k, 'dsg'));
      return absorbed;
    },
    markersOf,
    coreBridged,
    clearCore,
    flow: (online, devices, nowMs) => bridgeFleetFlow(online, devices, nowMs, isTrusted, deps.site()),
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
        absorbed: [...markers].sort().map((k) => ({
          pack: k,
          chargeWh: deps.readLifetime(bridgeAbsorbedKey(k, 'chg')).wh,
          dischargeWh: deps.readLifetime(bridgeAbsorbedKey(k, 'dsg')).wh,
        })).filter((a) => a.chargeWh > 0 || a.dischargeWh > 0),
        trustedSlots: [...trusted].map((k) => k.slice(PVSEEN_PREFIX.length)).sort(),
        pvChecks: [...checks.entries()].map(([k, c]) => {
          const [panelSn, slot] = k.split('#');
          return { slot: `${panelSn}_${slot}`, sinceMs: c.sinceMs, fieldWh: c.fieldWh, inferredWh: c.inferredWh, stepWh: c.stepWh, verdict: c.verdict };
        }).sort((a, b) => a.slot.localeCompare(b.slot)),
        cores,
        slots: bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devices, nowMs, isTrusted, deps.site()).slots,
        lastRollup,
      };
    },
  };
}
