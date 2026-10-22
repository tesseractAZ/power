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
 * (connected, its Core listed on the account with no reading of its own for at least
 * BRIDGE_DWELL_MS — see below), over each rollup window:
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
 *                 BRIDGE_PV_EVIDENCE_STEPS SoC steps the field is consistent if it reads at least
 *                 the bound less a tolerance of max(BRIDGE_PV_TOLERANCE_STEPS SoC steps,
 *                 BRIDGE_PV_TOLERANCE_FRACTION of the bound), else below (pvFieldVerdict). A
 *                 verdict takes effect once it has held for BRIDGE_PV_VERDICT_HOLD_MS of daylight
 *                 windows, or at once when the field differs from the bound by
 *                 BRIDGE_PV_GENUINE_WH in its direction (pvVerdictHolds): consistent trusts the
 *                 field, below leaves it untrusted or revokes it — the check never stops. The
 *                 bound is a lower one, so a field reading HIGH is not caught. The bound carries
 *                 one SoC step of quantization at each end and the capacity error: on 2026-10-18
 *                 an honest field read 0.90-0.97 of it over the day, and the one-step rule this
 *                 shipped with revoked all three slots by 0.29-0.32 kWh (the constants' comments).
 *                 Until a revocation acts, a trusted field found short is still booked on this
 *                 basis: the shortfall must first exceed the tolerance, then hold the hour or reach
 *                 BRIDGE_PV_GENUINE_WH — up to about max(the tolerance, 2 kWh) of solar short of
 *                 the bound per slot (plus a window's rise and a step), the battery split off by the
 *                 same amount, an hour or more after a freeze (longer at a large bound or a slow
 *                 charge; a field within the tolerance is never revoked). It is not booked back:
 *                 the inferred basis resumes from the envelope, which rose through the held
 *                 windows, so nothing steps down and the day's counters keep the shortfall.
 *  - 'unchecked'  the power sensors only (slotPowerBasis): the field is present in daylight, not
 *                 trusted and not found below today. Fleet PV and Battery Net publish it: the two
 *                 sum to the slot meter (−chW) whatever the field reads, so the house consumption
 *                 the Energy dashboard derives is the measured one and only the solar/battery
 *                 split carries the field's error, while unknown loses all three (2026-10-18
 *                 13:30-17:45, after the quantized check had revoked the field). The rollup books
 *                 such a window on the inferred basis: nothing booked changes. A field found
 *                 below (a genuine shortfall) or absent withholds both sensors.
 *  - 'inferred'   otherwise, in daylight: a monotone envelope of the slot's net AC output plus
 *                 the change in stored energy since the day's first daylight window,
 *                     cum(t) = max(prev, Σ(acOut − acIn) + (pct(t) − pct(anchor)) × capWh)
 *                 (capWh: the Core's measured full-charge capacity, the basis the panel's percent
 *                 is a fraction of). A LOWER BOUND: replayed on 8 recorded days it read 0.83-0.90
 *                 of the measured PV, short by a near-constant 4.7-6.1 kWh/day (the Cores' own
 *                 draw), and up to one SoC step (~290 Wh) per Core per anchor either way.
 *                 Energy-only: it has no instantaneous power; the power sensors read the field
 *                 unchecked (above), and withhold when it is absent or found below.
 *  - 'unbridgeable' no slot row in the window (the recorder writes none while the panel's reading
 *                 is not fresh), or the inferred basis has no SoC reading or a window the slot meter
 *                 did not cover: nothing is booked at the slot. The power sensors withhold both
 *                 figures for a slot on an ONLINE panel whose reading is not fresh NOW
 *                 (shp2ReadbackFresh), and leave a slot on a cloud-offline panel out of both
 *                 (bridgeFleetFlow). Never PV that passed through a Core booked as battery out.
 *
 * WHICH ROWS (v1.188.1 review). A window books the slot rows that exist, whatever the panel's
 * reading is at the rollup instant: the recorder writes a panel row only while the panel's reading
 * is fresh, so each row is a reading (judging the whole window on the instant dropped the minutes
 * that had rows whenever a rollup landed in a cloud shadow or a quota stall). A dark slot with no
 * row in the window while its last row is under INTEGRATE_HEAD_LOOKBACK_MS old HOLDS the window:
 * nothing is booked or written, the watermark stays, and the next window integrates across the gap
 * from the rows on both sides (integrateWh bridges up to 10 min), as the recorder's panel counters
 * do; the recorder holds fleet_pv_wh and fleet_grid_import_wh with it. v1.188.1 — a longer gap that
 * the gate explains (the panel watched through it and held, not absent: heldSamples.ts
 * createHeldGapLog) holds the window too while it is within HELD_ENERGY_BRIDGE_MAX_MS (30 min), and
 * once it ends the panel's held reading is restated across it every 5 min (deps.query, the
 * recorder's energyPoints), as v1.188.0's rows were; the 15-min clamp below waits for it as well. A
 * gap past that bound, or one the gate does not explain, is not bridged.
 * A Core listed connected by two panels (one panel's source list stale) is metered once, at the
 * listing on an online, fresh panel, then the house panel (shp2Membership connectedSourceListings,
 * the listing the backup timers' bound reads).
 *
 * WHEN A CORE IS DARK. v1.188.1 (review) — when it delivers no reading of its OWN, whatever the
 * cloud's online flag says (coreReports): the recorder writes exactly the Cores that do (its
 * freshness gate, heldSamples.projectionRecordable: content landed within 3 min and, for a Core,
 * CHANGED within SHP2_READBACK_STALE_MS), the bridge meters every other connected home Core, and
 * the power sensors sum each Core at one or the other — one notion, so no span is booked twice or
 * by nobody. Dark: cloud-offline with no data since the flip; listed online on a frozen meter (a
 * quota that keeps failing, a REST 200 replaying a cached body — the state the Energy flow card
 * and the backup timers already read from the slot, isSourceDpuFrozen); listed online with no
 * projection yet or a first body after a restart (it only seeds the witness). Not dark: a Core the
 * cloud lists offline whose MQTT data still arrives and changes after the flip (its measured
 * pv_total and BMS registers count). A Core the bridge has booked (it holds hand-over markers)
 * stays dark until it hands back (handsBack: reported since its return AND a reading of its own
 * now), the same test that spends its markers, so an online flip before the first fresh body, or a
 * quota that keeps failing after it, is still metered at the slot.
 *
 * A /status flip lasts seconds (setDeviceOnline) and a /device/list blip flagged three Cores offline
 * for ~92 s on 2026-10-03 while their MQTT data kept arriving: neither is an outage (the second is
 * not even dark). A dark Core is bridged once its own reading has been absent for BRIDGE_DWELL_MS
 * from the instant it stopped (ownReadingStoppedAt: listed offline, the later of its flip and its
 * last content change; listed online, its last content change), or at once when no run of the
 * add-on saw it stop (offline at the device list's first sight, none persisted) or when it is
 * marked. An online Core with no instant known (a restart's first body) starts its dwell at this
 * process's first sight of it, so a live Core reporting seconds after a restart is never bridged.
 * The bridge takes it over at that instant: its window starts at max(the rollup watermark, the
 * instant), and the recorder counts the Core's own pv_total / ac_in only up to it (offlineHomeCores,
 * ownEnergyUntil) — on every read at once, and in a rollup once the dwell has passed (a rollup
 * inside the dwell still counts the Core itself, and the bridge then starts at that rollup). So the
 * read path never drops energy it already showed, and no stretch is counted twice. Inside the dwell
 * a Core is in neither power figure, so both are withheld (unknown, never a partial sum). A blip
 * shorter than the dwell writes no marker and no log line. The instant is persisted
 * (`bridge_offline_<sn>`, written when the Core goes dark, kept through an online flip while it is
 * marked, deleted once it is no longer dark): after a restart the store has no clocks for it, and
 * the persisted instant stands in. A crash runs no final rollup, so the watermark can be up to a
 * rollup window old; without the instant the first publish after it dropped the PV / AC input shown
 * since the flip, and the bridge booked again the battery energy the BMS counted before it. The
 * recorder applies the same cut to a Core with no projection (none is fetched for a device listed
 * offline), so a crash restart publishes what the uninterrupted process would have. Where the
 * bridge can book nothing for a dark slot in a window (no slot reading inside it), a marked Core
 * whose own readings arrive again counts them for that window instead: the recorder its pv_total /
 * ac_in, the bridge its own pack meters (Σ ∫ pack<N>_in / _out, BridgeSlotWindow.own) for battery
 * in and out (v1.188.1 review: its PV counted and its battery energy was booked by nobody).
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
 * v1.188.1 (review) — only the packs the Core's projection carries are marked (a row a pack left
 * when it moved or was replaced can never move again; heldPackKeysOf), and a Core that hands back
 * with its whole pack list spends the marker of any pack it no longer reports (a Core dark since a
 * restart has no projection to choose from), so no marker outlives the dark span.
 * The marker is spent only once the Core hands back (handsBack: it has REPORTED since it came back —
 * reportsSinceReturn, its content changed at or after its online flip — and delivers a reading of
 * its own now), the instant the bridge stops metering it. Register movement before that — MQTT
 * data that still arrives while the cloud lists the Core offline, or a frozen projection at an
 * online flip that lands before the first fresh reading — is absorbed as it is seen (re-baselined,
 * the marker kept), so the held value never trails the projection and the real jump cannot pass
 * later.
 * Every term only grows, so nothing published steps down; as a backstop, the two counters whose
 * contributors change here (fleet_pv_wh, fleet_grid_import_wh) hold a dip between rollups up to
 * LIFETIME_HOLD_DIP_WH (recorder.ts). The per-Core rows
 * (`bridge_core_<sn>_*`, the figures the hand-over line and the "no longer bridged" line print)
 * are cleared by the bridge's own rollup once the Core has left the dark set and every marker of
 * it is handed over — never by the hand-over itself, which usually runs first (a read).
 *
 * LIMITS. AC basis at the panel (on the online days the inferred split kept battery in within
 * ~2 kWh/day of the DC counters and read battery out 5-8 kWh/day low); at the return, the span from
 * the bridge's last rollup to the Core's hand-back (at most one rollup window) is booked by neither
 * (the hand-over absorbs it), however long the Core stays listed online without a reading of its
 * own before that; a slot row gap over 10 min is not bridged (the integrator's rule) unless the gate
 * explains it and it is within HELD_ENERGY_BRIDGE_MAX_MS (above); at an outage
 * start, the battery flow from the Core's last register reading to
 * the bridge's window start (the cloud's offline detection or the content window, and a rollup that
 * fell inside the dwell) is absorbed unbridged; a Core whose flip no run saw (it went offline while
 * the add-on was down, or within one publish before a crash) is cut at the watermark — harmless
 * after a graceful stop (its final rollup leaves nothing pending), but after a crash while it
 * reported, the first publish drops the PV / AC input pending since the last rollup until the
 * bridge's first window books that span back (the window starts at the watermark when slot rows
 * were recorded after it, however long the downtime), and the BMS and the bridge both count that
 * span's battery energy (at most one rollup window); nothing can be bridged while the panel itself
 * is dark, beyond a gap the gate explains of up to HELD_ENERGY_BRIDGE_MAX_MS (its held reading
 * restated); and there is no backfill — a bridge that starts mid-outage counts from its first window.
 *
 * Pure functions plus a small factory (createEnergyBridge) that the recorder hands its lifetime
 * table and sample queries.
 */
import type { DeviceSnapshot, FleetSnapshot } from './snapshot.js';
import type { Shp2EnergySource } from './ecoflow/project.js';
import { allShp2s, shp2ReadbackFresh, connectedSourceListings, slotKey, type BridgeVerdicts } from './shp2Membership.js';
import { projectionRecordable } from './heldSamples.js';
import { integrateWh, INTEGRATE_HEAD_LOOKBACK_MS } from './aggregator.js';
import { solarPosition } from './physics/clearSky.js';
import { DEFAULT_SITE_LAT, DEFAULT_SITE_LON } from './siteDefaults.js';

export const BRIDGE_CHARGE_KEY = 'bridge_battery_charge_wh';
export const BRIDGE_DISCHARGE_KEY = 'bridge_battery_discharge_wh';
export const BRIDGE_PV_KEY = 'bridge_pv_wh';
export const BRIDGE_GRID_IMPORT_KEY = 'bridge_grid_import_wh';
const DARK_PREFIX = 'bridge_dark_';
const ABSORBED_PREFIX = 'bridge_absorbed_';
const PVSEEN_PREFIX = 'bridge_pvseen_';
const CORE_PREFIX = 'bridge_core_';
const OFFLINE_PREFIX = 'bridge_offline_';
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
/** The instant a home Core went cloud-offline (the row's ts), as this process saw it: a restart
 *  (a crash too) reads it back for a Core the store then sees offline with no transition time.
 *  Deleted once the Core is listed online again. */
export const bridgeOfflineKey = (sn: string): string => `${OFFLINE_PREFIX}${sn}`;

/** The hand-off instant recorded for a Core (createEnergyBridge: persisted, or this process's first
 *  sight of an online Core with no reading yet), or null when none is known. */
export type KnownOfflineSince = (sn: string) => number | null;
/** Does the Core still hold a hand-over marker (the bridge booked it and it has not handed over)? */
export type MarkedCore = (sn: string) => boolean;

/** A rollup window is never longer than this, unless slot rows were recorded after the watermark.
 *  Normal windows are 5 min; the first rollup after a restart would otherwise span the downtime, and
 *  a long window's sun test would not describe the part the samples cover. After a graceful stop
 *  (a final rollup) the downtime holds no rows, so clamping loses nothing. After a crash the span
 *  from the last rollup to the crash has rows, and the window keeps it (v1.188.1 review). */
export const BRIDGE_MAX_WINDOW_MS = 15 * 60 * 1000;
/** The inferred basis needs the slot meter to cover this share of the window. */
export const BRIDGE_MIN_COVERAGE = 0.8;
/** The capacity reading is refreshed this often (pack full-charge capacity moves over weeks). */
const CAPACITY_CACHE_MS = 6 * 60 * 60 * 1000;
/** A Core is bridged once it has been cloud-offline this long. Longer than a /status flip (6 s)
 *  and the 2026-10-03 /device/list blip (~92 s); short against an outage. */
export const BRIDGE_DWELL_MS = 3 * 60 * 1000;
/** The panel PV field is judged once the inferred lower bound has risen this many SoC steps
 *  (~2.3 kWh on a 28.9 kWh Core; one step = 1 % of capWh, 0.28-0.30 kWh on the three live Cores).
 *  With the two-step tolerance below, a field reading a fraction r of the solar passes the first
 *  verdict only when r ≥ 1 − 2/steps (0.75 here, as with one step at 4). */
export const BRIDGE_PV_EVIDENCE_STEPS = 8;
/**
 * pvFieldVerdict's tolerance: the field may read below the bound by up to
 * max(BRIDGE_PV_TOLERANCE_STEPS × one SoC step, BRIDGE_PV_TOLERANCE_FRACTION × the bound).
 *
 * MEASURED 2026-10-18 (one panel ..0432, slots 1/2/3 = Cores ..0314/..0482/..0090, every Core
 * cloud-dark; the field replayed from the recorded per-slot series against the bound, which
 * reproduced the add-on log's six verdicts to the minute). Field / bound: 1.13 / 1.37 / 0.89 at a
 * bound of 1 kWh, 1.05 / 1.16 / 0.91 at 2 kWh, 0.99 / 1.07 / 0.93 at 5 kWh, 0.93 / — / 0.94 at
 * 10 kWh, and 0.92 / 0.97 / 0.90 at the end of the day (28.1 vs 30.3 kWh over the three slots);
 * the shortfall by dusk 2.7 / 1.2 / 3.4 steps (7.7 / 3.5 / 9.6 % of the bound), one window at
 * 10.4 %. The bound carries up to one step of SoC quantization at EACH end (two steps) plus the
 * capacity error, so the one-step rule as shipped revoked all three honest fields, each by
 * 0.29-0.32 kWh (2.67 vs 2.99, 7.37 vs 7.66, 9.25 vs 9.54 kWh), and the Energy dashboard's Now
 * view lost solar, battery and consumption from 11:15 to dusk. Two steps cover the quantization
 * while the bound is small; 15 % covers the measured 9.6 % with a margin while it is large. A
 * field reading only the battery-charging share (about half the solar while the house runs on
 * the Cores) is still refused at the first verdict: 0.5 × 8 steps against 8 − 2 steps.
 */
export const BRIDGE_PV_TOLERANCE_STEPS = 2;
export const BRIDGE_PV_TOLERANCE_FRACTION = 0.15;
/**
 * A verdict takes effect once it has held for one full hour of daylight check windows, or at once
 * when the field differs from the bound by BRIDGE_PV_GENUINE_WH or more in the verdict's direction
 * (pvVerdictHolds): a shortfall of 2 kWh is about seven steps, which no quantization explains.
 * The same rule for trust and for revocation. A field that lags the slot meter by ten minutes
 * across a 5 kW ramp reads ~0.8 kWh short for the half hour the 15 % takes to grow past it; the
 * hour absorbs that, and it absorbs the 10.4 % window above.
 */
export const BRIDGE_PV_VERDICT_HOLD_MS = 60 * 60 * 1000;
export const BRIDGE_PV_GENUINE_WH = 2000;

/** `unchecked`: the power sensors only — the field is present and neither trusted nor found below. */
export type BridgeBasis = 'night' | 'measured' | 'unchecked' | 'inferred' | 'unbridgeable';
/** A slot's PV field for the power sensors: true = trusted (the 'measured' basis), false = present
 *  but not checked yet today ('unchecked'), 'below' = found short of the bound today (withheld). */
export type FieldTrust = boolean | 'below';

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Where the bridge's day/night test is judged. */
export interface BridgeSite { lat: number; lon: number }

/** The site the bridge's day/night test is judged at, from the configured install location
 *  (`config.forecastLat` / `forecastLon`: FORECAST_LAT / FORECAST_LON, the solar forecast's); the
 *  options' default (siteDefaults.ts DEFAULT_SITE_LAT / DEFAULT_SITE_LON, the placeholder) when it is not a
 *  usable coordinate. The recorder reads it at each use (deps.site: site.ts siteCoordinates(), which
 *  is FORECAST_LAT / FORECAST_LON unless SITE_LOCATION_FROM_HA is on). This module reads no option
 *  itself and does not import config.ts: test helpers import it statically, before the env their app
 *  imports read. */
export function bridgeSite(cfg: { forecastLat: number; forecastLon: number }): BridgeSite {
  const lat = cfg.forecastLat;
  const lon = cfg.forecastLon;
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  return { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON };
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
 * hand-over (recorder.computeBmsBatteryDetail) waits for it, and for coreReports (handsBack).
 */
export function reportsSinceReturn(d: Pick<DeviceSnapshot, 'online' | 'onlineChangedAtMs' | 'contentChangedAtMs'>): boolean {
  if (d.online !== true) return false;
  const c = finite(d.contentChangedAtMs);
  if (c == null) return false;
  const o = finite(d.onlineChangedAtMs);
  return o == null || c >= o;
}

/** The fields of a Core the bridge judges its own reading on. */
type ReadingFields = Pick<DeviceSnapshot, 'projection' | 'online' | 'onlineChangedAtMs' | 'contentChangedAtMs' | 'lastTelemetryAtMs' | 'contentStaleSinceMs'>;

/**
 * v1.188.1 (review) — does Core `d` deliver a reading of its OWN now? Its projection is one the
 * recorder writes (heldSamples.projectionRecordable: content arrived within RECORD_FRESH_MS and its
 * readings CHANGED within SHP2_READBACK_STALE_MS, the content clock the Energy flow card and the
 * backup timers read); and, while the cloud lists it offline, that change came after the offline
 * flip (MQTT data still arriving from a Core the cloud lists offline is its reading; its last
 * report before the cloud declared it offline is not a reading after it). Not a reading: no
 * projection yet (an online flip after a restart, before the first quota), a quota that keeps
 * failing, a REST 200 replaying a cached body, a first body after a restart (it only seeds the
 * witness). The bridge meters every connected home Core that does not report (darkHomeSlots), and
 * the recorder writes exactly the Cores that do: one notion, so no span is counted twice or by
 * nobody.
 */
export function coreReports(d: ReadingFields | undefined, nowMs: number): boolean {
  if (d?.projection?.kind !== 'dpu' || !projectionRecordable(d, nowMs)) return false;
  if (d.online !== false) return true;
  const o = finite(d.onlineChangedAtMs);
  const c = finite(d.contentChangedAtMs);
  return o == null || (c != null && c > o);
}

/**
 * v1.188.1 (review) — the bridge hands a MARKED Core back (the hand-over spends its markers) exactly
 * when it stops metering it: the Core has reported since its return (reportsSinceReturn) and
 * delivers a reading of its own now (coreReports). The bridge keeps a marked Core dark until then,
 * so the bridge and the hand-over cannot leave a span between them.
 */
export function handsBack(d: ReadingFields, nowMs: number): boolean {
  return reportsSinceReturn(d) && coreReports(d, nowMs);
}

/** When Core `d` stopped delivering a reading of its own, from the store's clocks alone: listed
 *  offline, the later of its offline flip and its last content change; listed online, its last
 *  content change. null when neither is known (offline since before this process saw it, or online
 *  with no change seen since a restart). */
export function ownReadingStoppedAt(d: ReadingFields): number | null {
  const c = finite(d.contentChangedAtMs);
  if (d.online !== false) return c;
  const o = finite(d.onlineChangedAtMs);
  if (o == null) return c;
  return c == null ? o : Math.max(o, c);
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
  /** When its own reading stopped (OfflineHomeCore.offlineSinceMs): the bridge's window never
   *  starts before it. null = offline since before this process saw it. */
  darkSinceMs: number | null;
  /** The Core is listed online (a frozen meter, no reading yet, or not reported since its return). */
  listedOnline: boolean;
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

/** A home Core the panel lists connected, listed on the account, with no reading of its own
 *  (coreReports is false: cloud-offline, or listed online on a frozen meter or with no reading
 *  yet), or a marked Core that has not handed back (handsBack). The bridge's "offline" Core. */
export interface OfflineHomeCore {
  /** When its own reading stopped (capped at now): a marked Core's dark span keeps the instant
   *  recorded when it began (persisted, `bridge_offline_<sn>`); otherwise ownReadingStoppedAt, else
   *  the recorded instant (after a restart, a crash too, the one the previous process persisted;
   *  for an online Core with no reading yet, this process's first sight of it). null = no process
   *  saw it stop (offline at the device list's first sight, none persisted). */
  offlineSinceMs: number | null;
  /** The bridge has taken it over: dark for BRIDGE_DWELL_MS, or marked, or listed offline with no
   *  instant known (null). An online Core with no instant is not taken over: its first sight starts
   *  the dwell (createEnergyBridge), so a restart's first body, which only seeds the witness, does
   *  not hand a live Core to the bridge. */
  bridged: boolean;
}

/** A slot's Core is offline (dark) when the panel lists the slot connected, names its Core, that
 *  Core is listed on the account, and it delivers no reading of its own (coreReports) — or it is
 *  marked and has not handed back (handsBack). Bridged once the dwell has passed. Every connected
 *  home Core is therefore either a reading of its own (the recorder writes it, the power sensors sum
 *  it), bridged (metered at its slot), or inside the dwell; a Core missing from the device list
 *  entirely is none of them (not part of the fleet). */
function offlineState(
  src: Shp2EnergySource, devices: Record<string, DeviceSnapshot>, nowMs: number, known?: KnownOfflineSince, marked?: MarkedCore,
): OfflineHomeCore | null {
  if (!src.isConnected || !src.sn) return null;
  const dpu = devices[src.sn];
  if (dpu == null) return null;
  const isMarked = marked?.(src.sn) === true;
  if (isMarked ? handsBack(dpu, nowMs) : coreReports(dpu, nowMs)) return null;
  // A marked Core is one dark span from the instant it began (recorded, or null: offline since
  // before any run saw it), whatever its flag and content did since: the bridge has booked it from
  // there, and its hand-over absorbs the whole jump. Otherwise the store's clocks say when its own
  // reading stopped; after a restart (a crash too) the store has none, and the recorded instant
  // stands in.
  const rec = known ? finite(known(src.sn)) : null;
  const t = isMarked ? rec : ownReadingStoppedAt(dpu) ?? rec;
  const offlineSinceMs = t == null ? null : Math.min(t, nowMs);
  const bridged = offlineSinceMs == null ? (isMarked || dpu.online === false) : nowMs - offlineSinceMs >= BRIDGE_DWELL_MS;
  return { offlineSinceMs, bridged };
}

/** Every offline (dark) home Core, by SN (the recorder's contributor cut, ownEnergyUntil). */
export function offlineHomeCores(devices: Record<string, DeviceSnapshot>, nowMs: number, known?: KnownOfflineSince, marked?: MarkedCore): Map<string, OfflineHomeCore> {
  const out = new Map<string, OfflineHomeCore>();
  for (const panel of allShp2s(devices)) {
    for (const src of panel.projection.sources ?? []) {
      const o = offlineState(src, devices, nowMs, known, marked);
      if (o) out.set(src.sn as string, o);
    }
  }
  return out;
}

/**
 * How far a home Core's OWN pv_total / ac_in count in a lifetime integral (recorder
 * buildContributors): undefined = no limit (it reports, or a rollup inside the dwell); a number =
 * up to that instant, the one the bridge's window starts from (the store's transition time, or
 * after a restart the one persisted for it); null = not at all (no process saw it go offline: it
 * was offline at the first device list after a stop, and the bridge starts at its watermark).
 * `read` applies the cut at once: a read must never show energy the next rollup will not keep.
 * The same cut applies to a Core with no projection (a restart while it is dark), so a crash
 * restart reads what the crashed process read.
 */
export function ownEnergyUntil(o: OfflineHomeCore | undefined, phase: 'read' | 'rollup'): number | null | undefined {
  if (!o) return undefined;
  if (phase === 'rollup' && !o.bridged) return undefined;
  return o.offlineSinceMs;
}

/** The bridged dark slots, one per Core. v1.188.1 (review) — a Core listed connected by two panels
 *  (one panel's source list stale) is metered once, at the listing connectedSourceListings picks
 *  (an online, fresh panel first; then the house panel), as the backup timers' bound reads it: two
 *  listings had added both slots to Battery Net and booked both windows into the lifetime rows. */
export function darkHomeSlots(devices: Record<string, DeviceSnapshot>, nowMs: number, known?: KnownOfflineSince, marked?: MarkedCore): DarkSlot[] {
  const out: DarkSlot[] = [];
  for (const { panel, src } of connectedSourceListings(devices, nowMs)) {
    const o = offlineState(src, devices, nowMs, known, marked);
    if (!o?.bridged) continue;
    out.push({
      panelSn: panel.sn,
      slot: src.slot,
      sn: src.sn as string,
      darkSinceMs: o.offlineSinceMs,
      listedOnline: devices[src.sn as string]?.online === true,
      source: src,
      chW: finite((panel.projection.sourceWatts ?? [])[src.slot - 1]),
      pvW: slotPvWatts(src),
      panelFresh: shp2ReadbackFresh(panel, nowMs),
      panelOnline: panel.online === true,
    });
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

/** The time of the last sample strictly before `t`, or null. */
export function lastTsBefore(pts: ReadonlyArray<{ ts: number }>, t: number): number | null {
  let v: number | null = null;
  for (const p of pts) {
    if (p.ts < t) v = p.ts;
    else break;
  }
  return v;
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
 * the capacity: the percent is an integer, so the bound carries a step of quantization at each
 * end). 'pending' until the bound has risen BRIDGE_PV_EVIDENCE_STEPS steps; then 'consistent' when
 * the field reads at least the bound less pvFieldTolerance, else 'below' (it reads less PV than
 * the Core demonstrably took in, by more than the bound's own error). A field reading high is not
 * caught: the bound is a lower one.
 */
export function pvFieldVerdict(fieldWh: number, inferredWh: number, stepWh: number): 'pending' | 'consistent' | 'below' {
  if (!(stepWh > 0) || inferredWh < BRIDGE_PV_EVIDENCE_STEPS * stepWh) return 'pending';
  return fieldWh >= inferredWh - pvFieldTolerance(inferredWh, stepWh) ? 'consistent' : 'below';
}

/** How far below the bound an honest field may read: two SoC steps or 15 % of the bound, whichever
 *  is larger (the measurements are at the constants). */
export function pvFieldTolerance(inferredWh: number, stepWh: number): number {
  return Math.max(BRIDGE_PV_TOLERANCE_STEPS * stepWh, BRIDGE_PV_TOLERANCE_FRACTION * inferredWh);
}

/**
 * Does a verdict that first appeared at `sinceMs` take effect at `nowMs`? Once it has held for
 * BRIDGE_PV_VERDICT_HOLD_MS, or at once when the field differs from the bound by
 * BRIDGE_PV_GENUINE_WH or more in the verdict's direction (short by that much for 'below', above
 * the bound by that much for 'consistent'). The same rule both ways, so a transient the growing
 * tolerance absorbs within the hour neither trusts nor revokes.
 */
export function pvVerdictHolds(verdict: 'consistent' | 'below', sinceMs: number, nowMs: number, fieldWh: number, inferredWh: number): boolean {
  if (nowMs - sinceMs >= BRIDGE_PV_VERDICT_HOLD_MS) return true;
  const margin = fieldWh - inferredWh;
  return verdict === 'below' ? margin <= -BRIDGE_PV_GENUINE_WH : margin >= BRIDGE_PV_GENUINE_WH;
}

/** The power-sensor basis for one dark slot NOW (the inferred basis has no power figure). In
 *  daylight the field is read when it is present and not found below: 'measured' once trusted,
 *  'unchecked' before (the sensors publish both; see the module comment). Absent, or found below
 *  today, the slot is unbridgeable and withholds both sensors. */
export function slotPowerBasis(s: DarkSlot, nowMs: number, trust: FieldTrust, site: BridgeSite): BridgeBasis {
  if (!s.panelFresh || s.chW == null) return 'unbridgeable';
  if (!sunUp(nowMs, site)) return 'night';
  if (s.pvW == null || trust === 'below') return 'unbridgeable';
  return trust === true ? 'measured' : 'unchecked';
}

export interface BridgedFleetFlow {
  /** Fleet PV, W: the reporting Cores' own figures plus the dark slots' PV (the panel field,
   *  trusted or unchecked; 0 at night); null while a home Core is neither (inside the dwell) or a
   *  dark slot cannot be bridged (no fresh meter; in daylight the field absent or found below). */
  fleetPv: number | null;
  /** Battery Net, W (positive = discharging): the reporting Cores' own pack net plus Σ(−chW − pv)
   *  over the dark slots; null as fleetPv. */
  fleetBatteryNet: number | null;
  /** Dark slots counted into the two figures. */
  bridgedSlots: number;
  /** Connected home Cores counted at their own reading (coreReports). */
  ownCores: number;
  /** v1.188.1 (review) — which Cores those are (the card's and the timers' own-meter set). */
  ownSns: string[];
  /** v1.188.1 (review) — the `flow` sensors on the same notion (AC Import, Fleet Total In / Out):
   *  each connected home Core at its own reading or, dark, at its slot's AC exchange (in: max(0,
   *  chW); out: max(0, −chW); Fleet Total In adds the slot's PV on the 'night' / 'measured' basis).
   *  A frozen projection listed online is taken out of the online sums, as for the two power
   *  sensors. null when that input was not given, or while a Core is inside the dwell or a dark
   *  slot on an online panel has no fresh meter (Fleet Total In also while its PV is unknown). */
  acIn: number | null;
  fleetIn: number | null;
  fleetOut: number | null;
  /** false while a connected home Core on an online panel is neither a reading of its own nor
   *  bridged (inside the dwell), or a dark slot on an online panel cannot be bridged right now
   *  (publishReadiness `flowBridged`). */
  ready: boolean;
  /** Connected home Cores on an online panel inside the dwell: no reading of their own, not bridged
   *  yet. Each withholds both figures. */
  pending: string[];
  /** `leftOut`: the slot's panel is cloud-offline, so the slot is in neither figure and withholds
   *  neither (its basis reads 'unbridgeable'). */
  slots: Array<{ panelSn: string; slot: number; sn: string; basis: BridgeBasis; chW: number | null; pvW: number | null; leftOut: boolean }>;
}

/** A Core's own contribution to aggregateFleetFlow's fleetPv / fleetBatteryNetDisplay, and to its
 *  acIn / fleetIn / fleetOut. */
function ownFlow(d: DeviceSnapshot): { pv: number; net: number; acIn: number; fleetIn: number; fleetOut: number } {
  if (d.projection?.kind !== 'dpu') return { pv: 0, net: 0, acIn: 0, fleetIn: 0, fleetOut: 0 };
  let net = 0;
  for (const pk of d.projection.packs ?? []) {
    const f = pk.liveFlow ?? pk;
    net += (f.outputWatts ?? 0) - (f.inputWatts ?? 0);
  }
  const p = d.projection;
  return { pv: p.pvTotalWatts ?? 0, net, acIn: p.acInWatts ?? 0, fleetIn: p.totalInWatts ?? 0, fleetOut: p.totalOutWatts ?? 0 };
}

/** The online sums bridgeFleetFlow starts from (aggregateFleetFlow's; the last three optional). */
export interface OnlineFlow {
  fleetPv: number;
  fleetBatteryNet: number;
  acIn?: number;
  fleetIn?: number;
  fleetOut?: number;
}

/**
 * The two power sensors the Energy dashboard's Now view rates on (Fleet PV, Battery Net). `online`
 * is aggregateFleetFlow's sums over the online Cores (fleetPv and the display battery net). Each
 * connected home Core is counted once, by what it delivers now:
 *  - a reading of its own (coreReports): its own figures (a Core the cloud lists offline whose MQTT
 *    data still arrives is added; it is not in `online`);
 *  - dark (no reading of its own, bridged): metered at its slot, battery = −chW − pv, pv from the
 *    panel field ('measured' once trusted, 'unchecked' before — the two figures sum to −chW
 *    whatever the field reads, so the consumption the dashboard derives is the slot meter's) or 0
 *    ('night'); a frozen projection listed online is taken OUT of `online` first, so its held
 *    figures are never published as live;
 *  - inside the dwell: neither, so both figures are withheld (unknown, never a partial sum).
 * A dark slot on an online panel that cannot be bridged right now (no fresh meter; in daylight no
 * PV field, or one found below the inferred bound today) withholds both figures; one on a
 * cloud-offline panel is left out of both, as an offline Core was before the bridge: nothing of it
 * can be read until that panel returns, and on a two-panel plant it must not blank the other
 * panel's Cores. Pure.
 */
export function bridgeFleetFlow(
  online: OnlineFlow,
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
  isTrusted: (panelSn: string, slot: number) => FieldTrust,
  site: BridgeSite,
  known?: KnownOfflineSince,
  marked?: MarkedCore,
): BridgedFleetFlow {
  let pv = online.fleetPv;
  let net = online.fleetBatteryNet;
  let acIn = online.acIn ?? 0;
  let fleetIn = online.fleetIn ?? 0;
  let fleetOut = online.fleetOut ?? 0;
  let ready = true;
  /** v1.188.1 (review) — the AC exchange is known (acIn, fleetOut): no Core inside the dwell, and
   *  every dark slot on an online panel has a fresh meter. The PV terms need `ready` as well. */
  let meterReady = true;
  let bridgedSlots = 0;
  let ownCores = 0;
  const ownSns: string[] = [];
  const pending: string[] = [];
  const slots: BridgedFleetFlow['slots'] = [];
  // v1.188.1 (review) — each connected Core once, at the listing darkHomeSlots meters it at.
  for (const { panel, src } of connectedSourceListings(devices, nowMs)) {
    const d = devices[src.sn as string];
    if (d == null) continue;
    // In aggregateFleetFlow's sums (online, a Core projection, a connected source).
    const summed = !!d.online && d.projection?.kind === 'dpu';
    const o = offlineState(src, devices, nowMs, known, marked);
    if (o == null) {
      ownCores += 1;
      ownSns.push(src.sn as string);
      if (!summed) { const f = ownFlow(d); pv += f.pv; net += f.net; acIn += f.acIn; fleetIn += f.fleetIn; fleetOut += f.fleetOut; }
      continue;
    }
    if (summed) { const f = ownFlow(d); pv -= f.pv; net -= f.net; acIn -= f.acIn; fleetIn -= f.fleetIn; fleetOut -= f.fleetOut; }
    if (!o.bridged && panel.online === true) { pending.push(src.sn as string); ready = false; meterReady = false; }
  }
  for (const s of darkHomeSlots(devices, nowMs, known, marked)) {
    if (!s.panelOnline) {
      slots.push({ panelSn: s.panelSn, slot: s.slot, sn: s.sn, basis: 'unbridgeable', chW: s.chW, pvW: s.pvW, leftOut: true });
      continue;
    }
    const basis = slotPowerBasis(s, nowMs, isTrusted(s.panelSn, s.slot), site);
    slots.push({ panelSn: s.panelSn, slot: s.slot, sn: s.sn, basis, chW: s.chW, pvW: s.pvW, leftOut: false });
    if (s.panelFresh && s.chW != null) {
      acIn += Math.max(0, s.chW);
      fleetIn += Math.max(0, s.chW);
      fleetOut += Math.max(0, -s.chW);
    } else {
      meterReady = false;
    }
    if (basis === 'unbridgeable') { ready = false; continue; }
    const p = basis === 'measured' || basis === 'unchecked' ? (s.pvW as number) : 0;
    pv += p;
    fleetIn += p;
    net += -(s.chW as number) - p;
    bridgedSlots += 1;
  }
  const given = (v: number | undefined, ok: boolean, x: number): number | null => (v == null || !ok ? null : x);
  return {
    fleetPv: ready ? pv : null, fleetBatteryNet: ready ? net : null, bridgedSlots, ownCores, ownSns, ready, pending, slots,
    acIn: given(online.acIn, meterReady, acIn),
    fleetIn: given(online.fleetIn, meterReady && ready, fleetIn),
    fleetOut: given(online.fleetOut, meterReady, fleetOut),
  };
}

/** v1.188.1 (review) — the verdicts the backup timers' bound and the dashboard card take from the
 *  same computation the two power sensors publish (shp2Membership.ts BridgeVerdicts): a slot's PV
 *  wherever the sensors read the field, trusted or unchecked, so the card and the timers agree with
 *  them (a field reading low makes the timers' bound more conservative, never less). */
export function slotVerdicts(flow: Pick<BridgedFleetFlow, 'ownSns' | 'slots'>): BridgeVerdicts {
  const measuredPvW = new Map<string, number>();
  for (const s of flow.slots) if ((s.basis === 'measured' || s.basis === 'unchecked') && s.pvW != null) measuredPvW.set(slotKey(s.panelSn, s.slot), s.pvW);
  return { own: new Set(flow.ownSns), measuredPvW };
}

/** A pack's cache key, as the recorder builds it (recorder.ts packCacheKey): `<sn>:<packSn>`, or
 *  `<sn>|<num>` while the pack has not reported its serial. */
export function packKeyOf(sn: string, pk: { packSn?: string | null; num: number }): string {
  return pk.packSn ? `${sn}:${pk.packSn}` : `${sn}|${pk.num}`;
}

/** The pack cache keys of the packs Core `d`'s projection carries now; null without a projection. */
export function projectedPackKeys(d: DeviceSnapshot | undefined): Set<string> | null {
  if (d?.projection?.kind !== 'dpu') return null;
  return new Set((d.projection.packs ?? []).map((pk) => packKeyOf(d.sn, pk)));
}

/**
 * The pack cache keys (recorder packCacheKey) of every held pack row of Core `sn`.
 *
 * v1.188.1 (review) — with `devices`, only the packs whose registers can come back: the packs the
 * Core's projection carries, when it has one; without one (a restart while it is dark), every held
 * row except a pack seen in ANOTHER chassis now (the v1.96.0 orphan guard: the row is stale). A row
 * left by a pack that was moved or replaced, or by a phantom slot the store hides, had been marked
 * too, and its marker was never spent (only a present pack whose registers move spends one): the
 * Core stayed "marked" for good, bridged at once on any later dark moment with no dwell, its whole
 * rollup window booked at the slot beside what the BMS had counted.
 */
export function heldPackKeysOf(sn: string, lifetimeKeys: readonly string[], devices?: Record<string, DeviceSnapshot>): string[] {
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
  if (!devices) return out;
  const present = projectedPackKeys(devices[sn]);
  if (present) return out.filter((k) => present.has(k));
  // No projection: drop a pack another chassis carries now.
  const elsewhere = new Set<string>();
  for (const d of Object.values(devices)) {
    if (d.sn === sn || d.projection?.kind !== 'dpu') continue;
    for (const pk of d.projection.packs ?? []) if (pk.packSn) elsewhere.add(pk.packSn);
  }
  return out.filter((k) => {
    const c = k.lastIndexOf(':');
    return c < 0 || !elsewhere.has(k.slice(c + 1));
  });
}

/** v1.188.1 (review) — a Core's projection lists every pack it has (its pack count is known and
 *  met), so a marker for a pack it does not carry is for a pack that is gone. */
export function projectionPacksComplete(d: DeviceSnapshot | undefined): boolean {
  if (d?.projection?.kind !== 'dpu') return false;
  const n = d.projection.packCount;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && (d.projection.packs ?? []).length >= n;
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
  /** v1.188.1 (review) — nothing was booked at the slot and the Core delivers a reading of its own:
   *  its own pack meters are booked for the window (inWh / outWh), and the recorder counts its own
   *  pv_total / ac_in rows (ownInstead). */
  own?: boolean;
  acOutWh: number;
  acInWh: number;
  pvWh: number;
  outWh: number;
  inWh: number;
  /** v1.190.2 — the slot meter's coverage of the window (ms), once it was integrated (the
   *  bridge_ledger row's `covered_ms` for a booked window: the Today card's "% measured"). */
  coverageMs?: number;
}

/**
 * v1.190.2 — one window of one bridged Core as the recorder's `bridge_ledger` table keeps it: what
 * the rollup at `untilMs` booked for that Core over [sinceMs, untilMs] — the same figures it added
 * to the lifetime counters (PV to fleet_pv_wh, AC input to fleet_grid_import_wh, battery in / out to
 * the bridge rows) — plus the slot's AC output, which no lifetime counter keeps. The Today card
 * (aggregator.computeTotals with `bridged`) adds these for each bridged Core in place of its own
 * absent samples, and leaves out the Core's own samples inside [sinceMs, untilMs]: the windows are
 * the bridge's own hand-off instants, so no span is counted twice.
 */
export interface BridgeLedgerRow {
  sn: string;
  panelSn: string;
  slot: number;
  sinceMs: number;
  untilMs: number;
  basis: BridgeBasis;
  pvWh: number;
  acOutWh: number;
  acInWh: number;
  chargeWh: number;
  dischargeWh: number;
  /** The slot meter's coverage of the window (ms) when the window was booked; 0 when it was not. */
  coveredMs: number;
}

/** v1.190.2 — the ledger rows of the bridge's booked windows, the bridge_ledger table and the
 *  watermark (the bridge's rollup instant, `bridge_battery_charge_wh`'s ts) at the time of the read. */
export interface BridgeLedger {
  rows: BridgeLedgerRow[];
  watermarkMs: number;
}

/** v1.190.2 — the bridge_ledger windows overlapping (since, until) — bound in that order — oldest
 *  first: the one read both recorders run (recorder.ts, readRecorder.ts). */
export const BRIDGE_LEDGER_SELECT_SQL =
  'SELECT sn, until_ts, since_ts, panel_sn, slot, basis, pv_wh, ac_out_wh, ac_in_wh, charge_wh, discharge_wh, covered_ms ' +
  'FROM bridge_ledger WHERE until_ts > ? AND since_ts < ? ORDER BY until_ts ASC, sn ASC';

/** A bridge_ledger row as SQLite returns it. */
export interface BridgeLedgerSqlRow {
  sn: string; until_ts: number; since_ts: number; panel_sn: string; slot: number; basis: string;
  pv_wh: number; ac_out_wh: number; ac_in_wh: number; charge_wh: number; discharge_wh: number; covered_ms: number;
}

export const bridgeLedgerRowOf = (r: BridgeLedgerSqlRow): BridgeLedgerRow => ({
  sn: r.sn, panelSn: r.panel_sn, slot: r.slot, sinceMs: r.since_ts, untilMs: r.until_ts, basis: r.basis as BridgeBasis,
  pvWh: r.pv_wh, acOutWh: r.ac_out_wh, acInWh: r.ac_in_wh, chargeWh: r.charge_wh, dischargeWh: r.discharge_wh, coveredMs: r.covered_ms,
});

/**
 * v1.190.2 — the bridge_ledger rows of one rollup: every window of a dark slot that the bridge
 * metered at the slot, booked or not (a window that booked nothing still takes the Core's own
 * samples out: the lifetime counters cut them there too). A held rollup books and writes nothing,
 * and a window where the Core's own meters counted instead (BridgeSlotWindow.own: its pv_total /
 * ac_in and its pack meters) is not a bridged window: the card reads that Core's own samples there.
 * A window the bridge did not book carries zeros, its AC figures included (computed, not booked).
 */
export function bridgeLedgerRows(r: BridgeRollupResult): BridgeLedgerRow[] {
  if (r.held === true) return [];
  const out: BridgeLedgerRow[] = [];
  for (const w of r.slots) {
    if (w.own === true || !(w.sinceMs < r.untilMs)) continue;
    const booked = w.basis !== 'unbridgeable';
    out.push({
      sn: w.sn, panelSn: w.panelSn, slot: w.slot, sinceMs: w.sinceMs, untilMs: r.untilMs, basis: w.basis,
      pvWh: booked ? w.pvWh : 0,
      acOutWh: booked ? w.acOutWh : 0,
      acInWh: booked ? w.acInWh : 0,
      chargeWh: booked ? w.inWh : 0,
      dischargeWh: booked ? w.outWh : 0,
      coveredMs: booked ? Math.max(0, w.coverageMs ?? 0) : 0,
    });
  }
  return out;
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
  /** v1.188.1 (review) — the window was HELD: a dark slot's rows stopped inside a gap the next
   *  window can still bridge, so nothing was booked or written and the watermark stays. The
   *  recorder holds the two counters the bridge adds to with it. */
  held?: boolean;
}

export interface EnergyBridgeDeps {
  readLifetime: (key: string) => { wh: number; ts: number };
  writeLifetime: (key: string, wh: number, ts: number) => void;
  deleteLifetime: (key: string) => void;
  listLifetimeKeys: () => string[];
  /** Samples, ascending: the recorder's energy series (recorder.ts energyPoints — the rows, and a held
   *  panel's reading restated across a gap the gate explains). */
  query: (sn: string, metric: string, sinceMs: number, untilMs: number) => Array<{ ts: number; value: number }>;
  /** v1.188.1 — the gate explains `sn`'s row gap since `fromMs` so far and it is still within the
   *  held-reading bound (heldSamples.ts createHeldGapLog open). Optional: without it a gap is held
   *  only while it is under the integrator's 10 min. */
  heldOpen?: (sn: string, fromMs: number, nowMs: number) => boolean;
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
  /** The running check of each dark slot's PV field against the inferred lower bound (Wh):
   *  `verdict` is the one in force (acted on), `candidate` a verdict not yet held long enough
   *  (pvVerdictHolds) and when it first appeared. */
  pvChecks: Array<{ slot: string; sinceMs: number; fieldWh: number; inferredWh: number; stepWh: number; toleranceWh: number; verdict: 'pending' | 'consistent' | 'below'; candidate: 'consistent' | 'below' | null; candidateSinceMs: number | null }>;
  /** Per-Core energy bridged since it went dark. */
  cores: Record<string, { chargeWh: number; dischargeWh: number }>;
  /** The persisted hand-off instant of each home Core listed offline (bridgeOfflineKey). */
  offlineSince: Array<{ sn: string; sinceMs: number }>;
  /** The dark slots now, with the power basis the two power sensors use. */
  slots: BridgedFleetFlow['slots'];
  /** Home Cores with no reading of their own inside the dwell (both power figures withheld). */
  pending: string[];
  lastRollup: BridgeRollupResult | null;
}

export interface EnergyBridge {
  rollup(snap: FleetSnapshot, nowMs: number): BridgeRollupResult;
  /** offlineHomeCores with the persisted hand-off instants, after persisting each new one (the
   *  store's transition time of a Core listed offline) and deleting those of Cores listed online.
   *  Writes; the recorder's contributor cut calls it on every read and rollup. */
  offlineHomeCores(devices: Record<string, DeviceSnapshot>, nowMs: number): Map<string, OfflineHomeCore>;
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
  flow(online: OnlineFlow, devices: Record<string, DeviceSnapshot>, nowMs: number): BridgedFleetFlow;
  debug(devices: Record<string, DeviceSnapshot>, nowMs: number): EnergyBridgeDebug;
}

/** The debug block at its empty identity (the read-only worker recorder, test stubs). */
export function emptyBridgeDebug(): EnergyBridgeDebug {
  return { chargeWh: 0, dischargeWh: 0, pvWh: 0, gridImportWh: 0, watermarkMs: 0, markers: [], absorbed: [], trustedSlots: [], pvChecks: [], cores: {}, offlineSince: [], slots: [], pending: [], lastRollup: null };
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
  /** The verdict in force: acted on (trusted, revoked, or left untrusted and logged). */
  verdict: 'pending' | 'consistent' | 'below';
  /** A verdict that differs from the one in force, and when it first appeared: acted on once
   *  pvVerdictHolds (one hour, or a genuine margin); dropped when the windows read otherwise. */
  candidate?: { verdict: 'consistent' | 'below'; sinceMs: number };
}

const kWh = (wh: number): string => (wh / 1000).toFixed(2);

export function createEnergyBridge(deps: EnergyBridgeDeps): EnergyBridge {
  const keys = deps.listLifetimeKeys();
  const markers = new Set<string>(keys.filter((k) => k.startsWith(DARK_PREFIX)).map((k) => k.slice(DARK_PREFIX.length)));
  const trusted = new Set<string>(keys.filter((k) => k.startsWith(PVSEEN_PREFIX)));
  /** The hand-off instants persisted by this process or an earlier one (bridgeOfflineKey). */
  const offlineAt = new Map<string, number>();
  for (const k of keys) {
    if (!k.startsWith(OFFLINE_PREFIX)) continue;
    const ts = deps.readLifetime(k).ts;
    if (ts > 0) offlineAt.set(k.slice(OFFLINE_PREFIX.length), ts);
  }
  /** v1.188.1 (review) — an online home Core with no reading of its own and no instant known (a
   *  restart's first body only seeds the witness; an online flip with no projection yet): this
   *  process's first sight of it, which starts its dwell. In memory only: a live Core reports
   *  within seconds of a restart, and the next process sees it afresh. */
  const firstSight = new Map<string, number>();
  const known: KnownOfflineSince = (sn) => offlineAt.get(sn) ?? firstSight.get(sn) ?? null;
  const isMarked: MarkedCore = (sn) => {
    for (const k of markers) if (markerSn(k) === sn) return true;
    return false;
  };
  /**
   * Record the instant each connected home Core stopped delivering a reading of its own
   * (ownReadingStoppedAt), once, when it becomes dark, and persist it: a restart, a crash included,
   * then hands the Core to the bridge at that same instant instead of at the rollup watermark, so
   * its reads keep what the crashed process showed and the bridge does not book again what the BMS
   * counted before it. A marked Core keeps the instant its dark span began, through an online flip
   * and MQTT data, until it hands back. Deleted once the Core is no longer dark. Writes only when a
   * Core goes dark or comes back.
   */
  const observe = (devices: Record<string, DeviceSnapshot>, nowMs: number): void => {
    const dark = new Set<string>();
    for (const panel of allShp2s(devices)) {
      for (const src of panel.projection.sources ?? []) {
        if (!src.isConnected || !src.sn || dark.has(src.sn)) continue;
        const d = devices[src.sn];
        if (d == null) continue;
        const marked = isMarked(src.sn);
        if (marked ? handsBack(d, nowMs) : coreReports(d, nowMs)) continue;
        dark.add(src.sn);
        if (offlineAt.has(src.sn) || marked) continue;
        // Kept as stamped (offlineState caps it at now where it is used), so a stamp ahead of the
        // clock is written once, not on every read until the clock passes it.
        const t = ownReadingStoppedAt(d);
        if (t != null) {
          offlineAt.set(src.sn, t);
          deps.writeLifetime(bridgeOfflineKey(src.sn), 1, t);
        } else if (d.online !== false && !firstSight.has(src.sn)) {
          firstSight.set(src.sn, nowMs);
        }
      }
    }
    for (const sn of [...offlineAt.keys()]) {
      if (dark.has(sn) || devices[sn] == null) continue;
      offlineAt.delete(sn);
      deps.deleteLifetime(bridgeOfflineKey(sn));
    }
    for (const sn of [...firstSight.keys()]) if (!dark.has(sn)) firstSight.delete(sn);
  };
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
  /** The power sensors' view of a slot's field (FieldTrust): trusted; else 'below' while today's
   *  check has found it short (the verdict in force, not a candidate); else unchecked. */
  const fieldTrust = (panelSn: string, slot: number): FieldTrust => {
    if (isTrusted(panelSn, slot)) return true;
    const prefix = `${panelSn}#${slot}#`;
    for (const [k, c] of checks) if (k.startsWith(prefix) && c.verdict === 'below') return 'below';
    return false;
  };

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
   * night. A verdict is acted on only once it has held (pvVerdictHolds: one hour of windows, or a
   * genuine margin) — a transient the growing tolerance absorbs within the hour changes nothing. A
   * 'below' verdict in force holds for the rest of the check: no trust/revoke churn within a day.
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
    if (v === 'pending' || v === c.verdict) { c.candidate = undefined; return; }
    // A verdict that differs from the one in force must hold before it acts: one hour of daylight
    // windows, or a genuine margin at once. The bound rises in whole SoC steps while the field
    // integrates smoothly, so a window can read short by more than the tolerance and the next
    // read within it again (2026-10-18 13:26, one window at 10.4 % against a 15 % tolerance that
    // the 2-step floor had not yet reached).
    if (c.candidate?.verdict !== v) c.candidate = { verdict: v, sinceMs: nowMs };
    if (!pvVerdictHolds(v, c.candidate.sinceMs, nowMs, c.fieldWh, c.inferredWh)) return;
    const heldSince = c.candidate.sinceMs;
    c.verdict = v;
    c.candidate = undefined;
    const tk = bridgePvSeenKey(s.panelSn, s.slot);
    const figures = `PV field read ${kWh(c.fieldWh)} kWh since ${new Date(c.sinceMs).toISOString()} against the inferred lower bound ${kWh(c.inferredWh)} kWh (one SoC step ${kWh(c.stepWh)} kWh, tolerance ${kWh(pvFieldTolerance(c.inferredWh, c.stepWh))} kWh)`;
    const held = `since ${new Date(heldSince).toISOString()}`;
    if (v === 'consistent') {
      if (trusted.has(tk)) return;
      trusted.add(tk);
      deps.writeLifetime(tk, c.fieldWh, nowMs);
      deps.log(`energy bridge: panel ${s.panelSn} slot ${s.slot} ${figures} — within the tolerance ${held}: the field is trusted from now on (the 'measured' basis)`);
      return;
    }
    if (trusted.delete(tk)) {
      deps.deleteLifetime(tk);
      deps.log(`energy bridge: panel ${s.panelSn} slot ${s.slot} ${figures} — below it by more than the tolerance ${held}: the field is no longer trusted (back to the inferred basis) — the power sensors withhold the slot`);
    } else {
      deps.log(`energy bridge: panel ${s.panelSn} slot ${s.slot} ${figures} — below it by more than the tolerance ${held}: the field is not trusted (the inferred basis stays) — the power sensors withhold the slot`);
    }
  };

  const rollup = (snap: FleetSnapshot, nowMs: number): BridgeRollupResult => {
    const own = deps.readLifetime(BRIDGE_CHARGE_KEY);
    const pvWm = deps.readLifetime('fleet_pv_wh');
    let since = own.ts > 0 ? own.ts : pvWm.ts > 0 ? pvWm.ts : nowMs - 60_000;
    // `known` holds the instants the recorder's contributor cut recorded (offlineHomeCores, which
    // rollupLifetime runs before this): in this process the store's clocks are read directly;
    // after a restart they stand in for the ones the store no longer has, and a marked Core keeps
    // the instant its dark span began.
    const dark = darkHomeSlots(snap.devices, nowMs, known, isMarked);
    // v1.188.1 (review) — the 15-min clamp applies only where nothing was recorded after the
    // watermark: after a graceful stop (its final rollup leaves nothing pending) the downtime holds no
    // slot rows. After a CRASH the rows from the last rollup to the crash are in samples (at most one
    // rollup window past the watermark), and clamping past them lost every dark Core's battery and
    // solar energy over that span while Panel Load and the grid counters booked the same minutes. The
    // window then starts at the watermark; the downtime itself has no rows, and integrateWh never
    // integrates across a gap over 10 min.
    // v1.188.1 — nor while a dark slot's panel is held by the gate since the watermark (a gap the
    // held-reading bound can still bridge, deps.heldOpen): the window is being held for it (below).
    const cutoff = nowMs - BRIDGE_MAX_WINDOW_MS;
    const recordedAfter = (s: DarkSlot): boolean => deps.query(s.panelSn, `src${s.slot}_w`, since + 1, Math.min(nowMs, since + BRIDGE_MAX_WINDOW_MS)).length > 0;
    const heldSince = (s: DarkSlot): boolean => deps.heldOpen?.(s.panelSn, since, nowMs) === true;
    if (since < cutoff && !dark.some(recordedAfter) && !dark.some(heldSince)) since = cutoff;
    const result: BridgeRollupResult = { sinceMs: since, untilMs: nowMs, pvWh: 0, gridImportWh: 0, chargeWh: 0, dischargeWh: 0, slots: [] };
    if (since >= nowMs) return result;
    // v1.188.1 (review) — a dark slot whose rows stopped inside a gap the integrator can still bridge
    // (no row in the window, the last one less than INTEGRATE_HEAD_LOOKBACK_MS old: a panel cloud
    // shadow, a short quota stall; the recorder writes no row while the panel's reading is held) HOLDS
    // the window: nothing is booked or written and the watermark stays, so the next window integrates
    // across the gap from the rows on both sides (integrateWh bridges up to 10 min), as the recorder's
    // panel counters do. The recorder holds fleet_pv_wh and fleet_grid_import_wh with it and counts
    // no Core's own readings instead (`held`). Before, every shadow episode lost the windows inside it.
    // v1.188.1 — and so does a longer gap the gate explains while it is within the held-reading bound
    // (deps.heldOpen): once it ends, the panel's held reading is restated across it (deps.query).
    // Past the bound it is not held, and the window books nothing for the slot.
    const slotPts = new Map<DarkSlot, Array<{ ts: number; value: number }>>();
    /** The Core delivers a reading of its own (a marked Core the cloud still lists offline, its MQTT
     *  data back): where its slot has no reading inside the window, its own meters count instead
     *  (bookOwn) — no hold, and no slot value held across the window. */
    const ownReading = (s: DarkSlot): boolean => {
      const d = snap.devices[s.sn];
      return d?.projection?.kind === 'dpu' && coreReports(d, nowMs);
    };
    for (const s of dark) {
      const start = Math.max(since, s.darkSinceMs ?? since);
      if (start >= nowMs) continue;
      const pts = deps.query(s.panelSn, `src${s.slot}_w`, start - INTEGRATE_HEAD_LOOKBACK_MS, nowMs);
      slotPts.set(s, pts);
      const last = lastTsBefore(pts, start);
      if (!pts.some((p) => p.ts >= start) && !ownReading(s) && last != null && (nowMs - last < INTEGRATE_HEAD_LOOKBACK_MS || deps.heldOpen?.(s.panelSn, last, nowMs) === true)) {
        result.held = true;
        result.slots.push({ panelSn: s.panelSn, slot: s.slot, sn: s.sn, sinceMs: start, basis: 'unbridgeable', reason: 'held: no slot row yet in a gap the next window can bridge', acOutWh: 0, acInWh: 0, pvWh: 0, outWh: 0, inWh: 0 });
      }
    }
    if (result.held) {
      lastRollup = result;
      return result;
    }
    const lifetimeKeys = deps.listLifetimeKeys();
    const nowBridging = new Map<string, DarkSlot>();
    /** The inferred / check state still in use: a slot not dark in daylight now keeps none. */
    const live = new Set<string>();
    const coreAdd = new Map<string, { chg: number; dsg: number }>();
    const site = deps.site();
    /** v1.188.1 (review) — where the bridge books nothing for a dark slot and its Core delivers a
     *  reading of its own (a marked Core the cloud still lists offline, its MQTT data back), that
     *  Core's own pack meters count for the window: Σ ∫ pack<N>_in / pack<N>_out, the rows the
     *  recorder's gate wrote as readings, the basis the Battery Net sensor reads. The recorder
     *  counts its own pv_total / ac_in for the same window (ownInstead). Its BMS movement is still
     *  absorbed (the marker kept): before, its PV counted and its battery energy was booked by
     *  nobody, for as long as the condition held. */
    const bookOwn = (s: DarkSlot, win: BridgeSlotWindow, start: number): void => {
      const d = snap.devices[s.sn];
      if (d?.projection?.kind !== 'dpu' || !ownReading(s)) return;
      win.own = true;
      if (start >= nowMs) return;
      let inWh = 0;
      let outWh = 0;
      for (const pk of d.projection.packs ?? []) {
        inWh += Math.max(0, integrateWh(deps.query(s.sn, `pack${pk.num}_in`, start - INTEGRATE_HEAD_LOOKBACK_MS, nowMs), start, nowMs).wh);
        outWh += Math.max(0, integrateWh(deps.query(s.sn, `pack${pk.num}_out`, start - INTEGRATE_HEAD_LOOKBACK_MS, nowMs), start, nowMs).wh);
      }
      win.inWh = inWh;
      win.outWh = outWh;
      result.chargeWh += inWh;
      result.dischargeWh += outWh;
      const c = coreAdd.get(s.sn) ?? { chg: 0, dsg: 0 };
      c.chg += inWh;
      c.dsg += outWh;
      coreAdd.set(s.sn, c);
    };
    for (const s of dark) {
      nowBridging.set(s.sn, s);
      const inferKey = `${s.panelSn}#${s.slot}#${s.sn}`;
      // The bridge takes the Core over at the instant it went offline: before it the Core's own
      // figures count (the recorder cuts them there), so this window never books them twice.
      const start = Math.max(since, s.darkSinceMs ?? since);
      const win: BridgeSlotWindow = { panelSn: s.panelSn, slot: s.slot, sn: s.sn, sinceMs: start, basis: 'unbridgeable', acOutWh: 0, acInWh: 0, pvWh: 0, outWh: 0, inWh: 0 };
      result.slots.push(win);
      const book = (): void => {
        if (start >= nowMs) {
          win.reason = 'no time in the window since the Core went offline';
          return;
        }
        // v1.188.1 (review) — the slot rows that exist are booked, whatever the panel's reading is at
        // this instant: the recorder writes a panel row only while the panel's reading is fresh
        // (heldSamples.projectionRecordable), so each row is a reading. Judging the whole window on
        // the instant dropped the minutes that had rows whenever a rollup landed in a shadow or a stall.
        const wPts = slotPts.get(s) ?? [];
        if (ownReading(s) && !wPts.some((p) => p.ts > start)) {
          // No slot reading inside the window, and the Core's own readings arrive: they count
          // (bookOwn), rather than the slot's last value held across the window.
          win.reason = s.panelFresh ? 'no slot reading in the window' : 'the panel reading is not fresh';
          return;
        }
        const ac = slotAcEnergy(wPts, start, nowMs);
        win.acOutWh = ac.acOutWh;
        win.acInWh = ac.acInWh;
        win.coverageMs = ac.coverageMs;
        if (ac.coverageMs <= 0) {
          // No slot reading in the window: nothing measured, and a PV figure alone would book as charge.
          win.reason = s.panelFresh ? 'no slot reading in the window' : 'the panel reading is not fresh';
          return;
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
        if (pvWh == null) return;
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
        for (const pk of heldPackKeysOf(s.sn, lifetimeKeys, snap.devices)) {
          if (markers.has(pk)) continue;
          markers.add(pk);
          deps.writeLifetime(bridgeDarkKey(pk), 1, nowMs);
        }
      };
      book();
      if (win.basis === 'unbridgeable') bookOwn(s, win, start);
    }
    // A slot that is not dark in daylight now keeps no inferred state and no field check, so a
    // later dark span starts both afresh (a stale anchor would land the whole SoC change since).
    for (const k of [...infer.keys()]) if (!live.has(k)) infer.delete(k);
    for (const k of [...checks.keys()]) if (!live.has(k)) checks.delete(k);
    // The transitions, logged before the per-Core rows below can be cleared.
    for (const [sn, s] of nowBridging) {
      if (bridging.has(sn)) continue;
      const at = s.darkSinceMs != null ? ` since ${new Date(s.darkSinceMs).toISOString()}` : '';
      const d = snap.devices[sn];
      const why = !s.listedOnline
        ? 'is cloud-offline'
        : d?.projection?.kind !== 'dpu'
          ? 'is listed online with no reading of its own yet'
          : 'is listed online but its own readings are not fresh';
      deps.log(`energy bridge: Core ${sn} ${why}${at} — metering its battery and solar at panel ${s.panelSn} slot ${s.slot} until it reports again`);
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
    offlineHomeCores: (devices, nowMs) => {
      observe(devices, nowMs);
      return offlineHomeCores(devices, nowMs, known, isMarked);
    },
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
    flow: (online, devices, nowMs) => {
      observe(devices, nowMs);
      return bridgeFleetFlow(online, devices, nowMs, fieldTrust, deps.site(), known, isMarked);
    },
    debug: (devices, nowMs) => {
      const t = totals();
      const now = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devices, nowMs, fieldTrust, deps.site(), known, isMarked);
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
          return {
            slot: `${panelSn}_${slot}`, sinceMs: c.sinceMs, fieldWh: c.fieldWh, inferredWh: c.inferredWh, stepWh: c.stepWh,
            toleranceWh: pvFieldTolerance(c.inferredWh, c.stepWh), verdict: c.verdict,
            candidate: c.candidate?.verdict ?? null, candidateSinceMs: c.candidate?.sinceMs ?? null,
          };
        }).sort((a, b) => a.slot.localeCompare(b.slot)),
        cores,
        offlineSince: [...offlineAt.entries()].map(([sn, sinceMs]) => ({ sn, sinceMs })).sort((a, b) => a.sn.localeCompare(b.sn)),
        slots: now.slots,
        pending: now.pending,
        lastRollup,
      };
    },
  };
}
