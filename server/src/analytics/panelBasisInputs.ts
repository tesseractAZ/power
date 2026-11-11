/**
 * v1.204.0 — the analytics worker's reads for the panel-measured solar basis (panelPvBasis.ts).
 *
 * Everything here reads durable rows only, and only rows before the start of the evening's own site day
 * E: the house panel's per-slot series (src{n}_pct, src{n}_w, src{n}_pv_w, src{n}_pv_hv_w,
 * src{n}_pv_lv_w), each slot's Core's own pv_total on the days the membership record puts it in the slot,
 * the energy bridge's booked windows (bridge_ledger) and its persisted field trust, the vendor's daily
 * solar (the vendor-energy sidecar the main thread writes), and the membership record. A closed day's
 * slot-hours are memoised (they cannot change while samples only grows; resetPanelBasisMemos clears them
 * when rows leave samples). The constants are fitted once per (slot, Core, the Core's last pv_total row,
 * capacity) and kept in the add-on's data directory with the days they were fitted on, so the rows
 * ageing out of the recorder's retention does not take them away.
 *
 * No owner option is read for any figure: the slot's capacity is the panel's own per-source fullCap.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Recorder } from '../recorder.js';
import type { DeviceSnapshot } from '../snapshot.js';
import type { Shp2Projection } from '../ecoflow/project.js';
import { config, option } from '../config.js';
import { atomicWriteFileSync } from '../atomicWrite.js';
import { findShp2, slotKey } from '../shp2Membership.js';
import { sunUp, bridgeSite, bridgePvSeenKey } from '../energyBridge.js';
import { siteCoordinates } from '../site.js';
import { curtailmentMembershipHistory } from '../curtailmentFreeze.js';
import type { MembershipHistory } from '../membershipHistory.js';
import { addDaysYmd, siteDayStartMs, siteYmd } from '../siteTime.js';
import {
  PLANNING_WINDOW_DAYS, INTEGRATE_MAX_GAP_MS, HOUR_COVER_MIN_S, CORE_DAYLIGHT_MIN_FRAC,
  assembleUcTable, bridgeVerified, buildSlotHours, chargeProofAt, fitPlantConstants, resolveSlotHour,
  siteHourStarts, slotMapOfDay, slotMapOfRecord, ucTableDays, upperCheck, admittedSlotDays,
  type BridgeWindowRow, type ConstantsFit, type HourSource, type Pt, type SlotHour, type UcTable, type UcVerdict,
} from '../panelPvBasis.js';

const H = 3_600_000;
/** The Cores' pv_total is read in 60-s buckets (≈ 1,440 rows a day instead of ≈ 4,000). */
const CORE_PV_BUCKET_SEC = 60;
/** A night charge run that crosses midnight is found in the next day's read. */
const PROOF_LOOKBACK_MS = H;

/* ─── test seams and inputs from outside the recorder ───────────────────────────────────────── */

let vendorOverride: ReadonlyMap<string, number> | null | undefined;
let membershipOverride: MembershipHistory | null | undefined;
let constantsPathOverride: string | null | undefined;
let sunOverride: ((ms: number) => boolean) | undefined;

/** Test seam: the vendor's daily solar by site day, Wh (undefined restores the sidecar). */
export function setPanelBasisVendorForTesting(v: ReadonlyMap<string, number> | null | undefined): void { vendorOverride = v; }
/** Test seam: the membership record (undefined restores curtailmentMembershipHistory). */
export function setPanelBasisMembershipForTesting(h: MembershipHistory | null | undefined): void { membershipOverride = h; }
/** Test seam: where the fitted constants are kept (null: nowhere; undefined restores the default). */
export function setPanelBasisConstantsPathForTesting(p: string | null | undefined): void { constantsPathOverride = p; }
/** Test seam: the sun test (undefined restores the site's). */
export function setPanelBasisSunForTesting(f: ((ms: number) => boolean) | undefined): void { sunOverride = f; }

const sunTest = (): ((ms: number) => boolean) => {
  if (sunOverride) return sunOverride;
  const site = bridgeSite(siteCoordinates());
  return (ms) => sunUp(ms, site);
};

/** The vendor's daily solar (Wh) by site day, from the sidecar the main thread's daily job writes
 *  (energyHistory.ts, VENDOR_ENERGY_STATE_PATH or vendor-energy-daily.json). Read here rather than
 *  through energyHistory.ts, which brings the vendor REST client into the worker. */
function vendorSolarByDay(): ReadonlyMap<string, number> {
  if (vendorOverride !== undefined) return vendorOverride ?? new Map();
  const out = new Map<string, number>();
  try {
    const path = option<string | undefined>('VENDOR_ENERGY_STATE_PATH') ?? config.dataFile('vendor-energy-daily.json');
    if (!existsSync(path)) return out;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { days?: Record<string, { solarWh?: unknown }> };
    for (const [day, rec] of Object.entries(raw?.days ?? {})) {
      const v = rec?.solarWh;
      if (typeof v === 'number' && Number.isFinite(v)) out.set(day, v);
    }
  } catch { /* unreadable: no vendor rows, so no day is a field day (absence is never a pass) */ }
  return out;
}

const membership = (): MembershipHistory | null =>
  membershipOverride !== undefined ? membershipOverride : curtailmentMembershipHistory();

/* ─── memos (closed days) ───────────────────────────────────────────────────────────────────── */

/** A closed slot-day's hours, by `${panel}|${slot}|${day}|${core}`. */
const slotHourMemo = new Map<string, SlotHour[]>();
/** A closed slot-day's G11 proof instant (null: none), by `${panel}|${slot}|${day}`. */
const proofMemo = new Map<string, number | null>();
/** A closed day's bridge windows, by day. */
const bridgeMemo = new Map<string, BridgeWindowRow[]>();
/** Fits by `${panel}|${slot}|${core}|${lastPvTs}|${capacityWh}`. */
const fitMemo = new Map<string, ConstantsFit>();
const MEMO_MAX = 20_000;

/** Clear the closed-day memos and the fits (rows left samples, or came back). */
export function resetPanelBasisMemos(): void {
  slotHourMemo.clear();
  proofMemo.clear();
  bridgeMemo.clear();
  fitMemo.clear();
}

function memoSet<V>(m: Map<string, V>, k: string, v: V): void {
  if (m.size >= MEMO_MAX) m.clear();
  m.set(k, v);
}

/* ─── reads ─────────────────────────────────────────────────────────────────────────────────── */

function slotSeries(recorder: Recorder, panelSn: string, slot: number, fromMs: number, toMs: number) {
  const m = recorder.queryMulti(panelSn, [`src${slot}_pct`, `src${slot}_w`, `src${slot}_pv_w`, `src${slot}_pv_hv_w`, `src${slot}_pv_lv_w`], fromMs, toMs);
  return {
    pct: m.get(`src${slot}_pct`) ?? [],
    srcW: m.get(`src${slot}_w`) ?? [],
    field: m.get(`src${slot}_pv_w`) ?? [],
    hv: m.get(`src${slot}_pv_hv_w`) ?? [],
    lv: m.get(`src${slot}_pv_lv_w`) ?? [],
  };
}

/** One closed slot-day's hours (memoised) and its G11 proof instant. */
function slotDayHours(
  recorder: Recorder, panelSn: string, slot: number, day: string, core: string | null, sun: (ms: number) => boolean,
): { hours: SlotHour[]; proofAt: number | null } {
  const hk = `${panelSn}|${slot}|${day}|${core ?? '-'}`;
  const pk = `${panelSn}|${slot}|${day}`;
  const memoHours = slotHourMemo.get(hk);
  if (memoHours && proofMemo.has(pk)) return { hours: memoHours, proofAt: proofMemo.get(pk) ?? null };
  const start = siteDayStartMs(day);
  const end = siteDayStartMs(addDaysYmd(day, 1));
  const s = slotSeries(recorder, panelSn, slot, start - Math.max(PROOF_LOOKBACK_MS, INTEGRATE_MAX_GAP_MS), end);
  const corePts: Pt[] | null = core == null ? null : recorder.query(core, 'pv_total', start - INTEGRATE_MAX_GAP_MS, end, CORE_PV_BUCKET_SEC);
  const hours = buildSlotHours(siteHourStarts(day), s, () => corePts, sun);
  const proofAt = chargeProofAt(s.srcW, s.field, sun);
  memoSet(slotHourMemo, hk, hours);
  memoSet(proofMemo, pk, proofAt);
  return { hours, proofAt };
}

function bridgeRowsOf(recorder: Recorder, day: string): BridgeWindowRow[] {
  const hit = bridgeMemo.get(day);
  if (hit) return hit;
  const start = siteDayStartMs(day);
  const end = siteDayStartMs(addDaysYmd(day, 1));
  let rows: BridgeWindowRow[] = [];
  try {
    rows = recorder.bridgeLedger(start, end).rows
      .filter((r) => r.untilMs >= start && r.untilMs < end)
      .map((r) => ({ sn: r.sn, panelSn: r.panelSn, slot: r.slot, basis: r.basis }));
  } catch { rows = []; }
  memoSet(bridgeMemo, day, rows);
  return rows;
}

/* ─── the constants, fitted and kept ────────────────────────────────────────────────────────── */

interface KeptFit { lastPvTs: number; capacityWh: number; fit: ConstantsFit }

function constantsPath(): string | null {
  if (constantsPathOverride !== undefined) return constantsPathOverride;
  return config.isAddon ? config.dataFile('panel-pv-constants.json') : null;
}

function loadKept(): Record<string, KeptFit> {
  const p = constantsPath();
  if (!p) return {};
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' && raw.fits && typeof raw.fits === 'object' ? raw.fits as Record<string, KeptFit> : {};
  } catch { return {}; }
}

function saveKept(fits: Record<string, KeptFit>): void {
  const p = constantsPath();
  if (!p) return;
  try { atomicWriteFileSync(p, JSON.stringify({ v: 1, fits })); } catch { /* best effort: the next fit retries */ }
}

const validKept = (k: KeptFit | undefined): k is KeptFit =>
  k != null && Number.isFinite(k.lastPvTs) && Number.isFinite(k.capacityWh) && k.fit != null
  && Array.isArray(k.fit.dayList) && Number.isFinite(k.fit.days) && Number.isFinite(k.fit.chargeHours);

/**
 * The constants of (slot, Core): from the record kept with them when it was fitted on this Core's same
 * last pv_total row and the same capacity, else fitted from the rows (every day the membership record
 * vouches the Core sat in the slot, before E) and kept when they exist.
 */
function constantsFor(
  recorder: Recorder, panelSn: string, slot: number, core: string, capacityWh: number, beforeMs: number,
  history: MembershipHistory | null, sun: (ms: number) => boolean,
): ConstantsFit {
  const firstLast = recorder.queryFirstLast?.(core, 'pv_total', 0, beforeMs - 1) ?? [];
  const lastPvTs = firstLast.length > 0 ? firstLast[firstLast.length - 1].ts : 0;
  const mk = `${panelSn}|${slot}|${core}|${lastPvTs}|${capacityWh}`;
  const hit = fitMemo.get(mk);
  if (hit) return hit;
  const keptKey = `${panelSn}#${slot}|${core}`;
  const kept = loadKept();
  const k = kept[keptKey];
  if (validKept(k) && k.lastPvTs === lastPvTs && k.capacityWh === capacityWh) {
    memoSet(fitMemo, mk, k.fit);
    return k.fit;
  }
  const empty: ConstantsFit = { constants: null, days: 0, chargeHours: 0, dayList: [] };
  if (lastPvTs <= 0) { memoSet(fitMemo, mk, empty); return empty; }
  const firstPanel = recorder.queryFirstLast?.(panelSn, `src${slot}_pct`, 0, beforeMs - 1) ?? [];
  if (firstPanel.length === 0) { memoSet(fitMemo, mk, empty); return empty; }
  const days: Array<{ day: string; hours: SlotHour[] }> = [];
  const lastDay = siteYmd(Math.min(lastPvTs, beforeMs - 1));
  for (let day = siteYmd(firstPanel[0].ts); day <= lastDay; day = addDaysYmd(day, 1)) {
    if (slotMapOfDay(history, panelSn, day)?.[slot] !== core) continue;
    days.push({ day, hours: slotDayHours(recorder, panelSn, slot, day, core, sun).hours });
  }
  const fit = fitPlantConstants(days, capacityWh);
  memoSet(fitMemo, mk, fit);
  if (fit.constants != null) {
    kept[keptKey] = { lastPvTs, capacityWh, fit };
    saveKept(kept);
  }
  return fit;
}

/* ─── the basis as of an evening ────────────────────────────────────────────────────────────── */

export interface PanelBasisInputs {
  asOfDay: string;
  panelSn: string;
  /** The house panel's connected slots now (the planning keys), ascending. */
  slots: number[];
  /** slotKey(panelSn, n) for each — internal, never printed. */
  keys: string[];
  /** The Core in each connected slot: the map of record as of E, else the panel's own listing now. */
  coreOfSlot: Map<number, string | null>;
  verdict: UcVerdict;
  /** slot → the site days admitted to the planning model as of E. */
  admitted: Map<number, Set<string>>;
  /** slot → proved under charge (G11) inside the planning window. */
  provedUnderCharge: Map<number, boolean>;
  /** slot key → hour epoch → mean W, the resolver over E−30..E−1 with admission (the planning maps). */
  slotMaps: Map<string, Map<number, number>>;
  /** The resolver's choices over the planning window, with admission. */
  hourSources: Record<HourSource, number>;
  /** Field hours the resolver would take WITHOUT admission (the identity test: none means the planning
   *  model is the alarm model's data). */
  fieldHoursUnadmitted: number;
  table: UcTable;
}

/**
 * The panel basis as of the evening `asOfDay` (E), or null with no house panel. E after today is
 * refused by the caller; this reads only days ≤ E−1.
 */
export function panelBasisInputs(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  asOfDay: string,
): PanelBasisInputs | null {
  const shp2 = findShp2(devices) as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;
  if (!shp2) return null;
  const panelSn = shp2.sn;
  const sources = shp2.projection.sources ?? [];
  const connected = sources.filter((s) => s.isConnected && !!s.sn && Number.isInteger(s.slot)).map((s) => s.slot).sort((a, b) => a - b);
  const capacityOf = (slot: number): number | null => {
    const c = sources.find((s) => s.slot === slot)?.fullCap;
    return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : null;
  };
  const sun = sunTest();
  const history = membership();
  const startE = siteDayStartMs(asOfDay);
  const vendor = vendorSolarByDay();
  let lifetimeKeys: string[] = [];
  try { lifetimeKeys = recorder.listLifetimeKeys(); } catch { lifetimeKeys = []; }
  const trusted = (slot: number): boolean => lifetimeKeys.includes(bridgePvSeenKey(panelSn, slot));
  const mapE = slotMapOfRecord(history, panelSn, asOfDay);
  const coreOfSlot = new Map<number, string | null>();
  for (const s of connected) coreOfSlot.set(s, mapE?.[s] ?? sources.find((x) => x.slot === s)?.sn ?? null);

  // The constants of every (slot, Core) the map of record names now (the only Cores a field day can have).
  const fits = new Map<string, ConstantsFit>();
  const needsFit = new Set<number>();
  const fitOf = (slot: number, core: string): ConstantsFit | null => {
    const cap = capacityOf(slot);
    if (cap == null || !needsFit.has(slot)) return null;
    const k = `${slot}|${core}`;
    let f = fits.get(k);
    if (!f) fits.set(k, (f = constantsFor(recorder, panelSn, slot, core, cap, startE, history, sun)));
    return f;
  };
  const days = ucTableDays(asOfDay);
  const planningFrom = addDaysYmd(asOfDay, -PLANNING_WINDOW_DAYS);
  const mapByDay = new Map<string, Record<number, string> | null>();
  const allSlots = new Set<number>(connected);
  for (const day of days) {
    const m = slotMapOfDay(history, panelSn, day);
    mapByDay.set(day, m);
    if (m) for (const k of Object.keys(m)) allSlots.add(Number(k));
  }
  // G11's proof inside the planning window, from each slot-day's rows (memoised with its hours).
  const proved = new Map<number, boolean>();
  for (const s of allSlots) {
    let p = false;
    for (const day of days) {
      if (day < planningFrom) continue;
      if (slotDayHours(recorder, panelSn, s, day, mapByDay.get(day)?.[s] ?? null, sun).proofAt != null) { p = true; break; }
    }
    proved.set(s, p);
  }
  // The constants are fitted only for a slot that can need them: one whose Core did not cover E−1's
  // daylight (it takes the field tonight), or whose field stood for an hour in the table's days (its past
  // field days are judged). A plant whose Cores all report never fits (it would refit once a day).
  const prevDay = addDaysYmd(asOfDay, -1);
  for (const s of allSlots) {
    const prevHours = slotDayHours(recorder, panelSn, s, prevDay, mapByDay.get(prevDay)?.[s] ?? null, sun).hours;
    const daylight = prevHours.filter((h) => h.sun);
    const covered = daylight.filter((h) => h.coreCovS >= HOUR_COVER_MIN_S).length;
    if (daylight.length === 0 || covered < CORE_DAYLIGHT_MIN_FRAC * daylight.length) { needsFit.add(s); continue; }
    for (const day of days) {
      const core = mapByDay.get(day)?.[s] ?? null;
      const g3 = bridgeVerified(bridgeRowsOf(recorder, day), panelSn, s, core, trusted(s)).g3;
      if (!g3) continue;
      const hs = slotDayHours(recorder, panelSn, s, day, core, sun).hours;
      if (hs.some((h) => resolveSlotHour(h, { g3, provedUnderCharge: proved.get(s) ?? false, admitted: true }).source === 'field')) { needsFit.add(s); break; }
    }
  }
  const { table, g3: g3Of } = assembleUcTable({
    panelSn,
    days,
    slots: [...allSlots].sort((a, b) => a - b),
    mapOfDay: (day) => mapByDay.get(day) ?? null,
    mapAsOf: (e) => slotMapOfRecord(history, panelSn, e),
    hoursOf: (slot, day, core) => slotDayHours(recorder, panelSn, slot, day, core, sun).hours,
    bridgeRowsOf: (day) => bridgeRowsOf(recorder, day),
    trusted,
    provedUnderCharge: (slot) => proved.get(slot) ?? false,
    capacityOf,
    fitOf,
    vendorOf: (day) => vendor.get(day) ?? null,
  }, asOfDay);
  const hoursOf = (slot: number, day: string): SlotHour[] => slotDayHours(recorder, panelSn, slot, day, mapByDay.get(day)?.[slot] ?? null, sun).hours;
  const verdict = upperCheck(table, asOfDay);
  const admitted = admittedSlotDays(table, asOfDay);

  const slotMaps = new Map<string, Map<number, number>>();
  const hourSources: Record<HourSource, number> = { core: 0, field: 0, 'core-partial': 0, gap: 0 };
  let fieldHoursUnadmitted = 0;
  for (const s of connected) {
    const map = new Map<number, number>();
    const adm = admitted.get(s) ?? new Set<string>();
    for (const day of days) {
      if (day < planningFrom) continue;
      for (const h of hoursOf(s, day)) {
        const ctx = { g3: g3Of.get(`${s}|${day}`) ?? false, provedUnderCharge: proved.get(s) ?? false };
        if (resolveSlotHour(h, { ...ctx, admitted: true }).source === 'field') fieldHoursUnadmitted++;
        const r = resolveSlotHour(h, { ...ctx, admitted: adm.has(day) });
        hourSources[r.source]++;
        if (r.w != null) map.set(Math.floor(h.startMs / H), r.w);
      }
    }
    slotMaps.set(slotKey(panelSn, s), map);
  }
  return {
    asOfDay, panelSn, slots: connected, keys: connected.map((s) => slotKey(panelSn, s)), coreOfSlot,
    verdict, admitted, provedUnderCharge: proved, slotMaps, hourSources, fieldHoursUnadmitted, table,
  };
}

/** A slot map as hour-mean points (one per hour, mid-hour, so an inclusive hour slice holds one), for the
 *  hindcast functions that read recorder-shaped series (computePvBiasCorrection, coreCoverageByDay). */
export function slotMapPoints(map: ReadonlyMap<number, number>, fromMs: number, toMs: number): Pt[] {
  const out: Pt[] = [];
  for (const [he, w] of map) {
    const ts = he * H + H / 2;
    if (ts >= fromMs && ts < toMs) out.push({ ts, value: w });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
