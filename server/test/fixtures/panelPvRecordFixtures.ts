/**
 * v1.204.0 — the recorded plant for the panel-measured solar basis (panelPvRecord.json): 2026-08-21..
 * 2026-11-06 (the published snapshot ends 2026-11-06 18:03:40 site time), reduced to what the basis reads.
 * Every slot-hour was built by panelPvBasis.buildSlotHours from the raw rows exactly as the worker reads
 * them (the panel's per-slot series raw from 1 h before the day, each Core's pv_total in 60-s buckets);
 * the energy bridge's windows, the vendor's daily solar, the trusted fields and the G11 proof days come
 * with it. Cores and the panel are aliases (C1..C3, P1); there is no serial.
 *
 * The membership record is the record's shape for this plant: an entry from the first recorded day with no
 * slot map, and the 2026-08-20 swap's entry, which carries one. So the record vouches each slot's Core from
 * 2026-08-21: the SPECIFIED basis's day set for the constants.
 *
 * recordSources() hands panelPvBasis.assembleUcTable the same callbacks the worker builds from the
 * recorder (analytics/panelBasisInputs.ts), with knobs for the planted faults: a field scale per slot from a
 * day on (the vendor scaled with it, as a panel-side scaling would be, so G6 is blind to it), the capacity
 * basis (the panel's nameplate fullCap, the held per-Core capacities, a lost pack), slots removed from the
 * record, a slot treated as reporting through its Core, and vendor or field edits per day.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitPlantConstants, slotMapOfDay, slotMapOfRecord, ucTableDays, PLANNING_WINDOW_DAYS,
  type BridgeWindowRow, type ConstantsFit, type SlotHour, type UcSources,
} from '../../src/panelPvBasis.js';
import type { MembershipHistory } from '../../src/membershipHistory.js';
import { addDaysYmd, siteDayStartMs, siteYmd } from '../../src/siteTime.js';

interface RecordFile {
  panel: string;
  cutoffMs: number;
  nameplateWh: number;
  heldWh: Record<string, number>;
  membership: MembershipHistory;
  trustedSlots: number[];
  vendorWh: Record<string, number>;
  bridge: Record<string, Array<[number, string, string, number]>>;
  proofDays: Record<string, string[]>;
  days: string[];
  hours: Record<string, Array<[number, number, number | null, number | null, number | null, number | null, number, number | null, number, number, number, number]>>;
}

export const RECORD: RecordFile = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'panelPvRecord.json'), 'utf8'));
export const PANEL = RECORD.panel;
export const SLOTS = [1, 2, 3] as const;

/** The record's slot-hours by slot and site day. */
const HOURS: Map<number, Map<string, SlotHour[]>> = (() => {
  const out = new Map<number, Map<string, SlotHour[]>>();
  for (const s of SLOTS) {
    const byDay = new Map<string, SlotHour[]>();
    for (const r of RECORD.hours[String(s)]) {
      const h: SlotHour = {
        startMs: r[0], sun: r[1] === 1, pct0: r[2], pct1: r[3], outWh: r[4], inWh: r[5], acInS: r[6],
        fieldWh: r[7], fieldCovS: r[8], frozen: r[9] === 1, coreRawWh: r[10], coreCovS: r[11],
      };
      const day = siteYmd(h.startMs);
      const list = byDay.get(day);
      if (list) list.push(h); else byDay.set(day, [h]);
    }
    out.set(s, byDay);
  }
  return out;
})();

/** A slot-day's recorded hours (an empty list outside the record). */
export const recordHours = (slot: number, day: string): readonly SlotHour[] => HOURS.get(slot)?.get(day) ?? [];

export interface RecordOptions {
  /** Capacity basis per slot: the panel's nameplate fullCap (the specified basis), the held per-Core
   *  capacities, or explicit values. */
  capacity?: 'nameplate' | 'held' | Record<number, number>;
  /** Evaluate (not fit) on these capacities instead, per slot (a lost pack: the estimator's ΔE scaled). */
  evalCapacity?: Record<number, number>;
  /** A field step fault: slot (or all) × scale from the day on (to the day, when given); the vendor is
   *  scaled with it. */
  fault?: { scale: number; fromDay: string; toDay?: string; slots?: number[] };
  /** Slots out of the record from 1 ms into this day (the day itself is the change day; the membership
   *  entry without them). */
  removed?: { slots: number[]; fromDay: string };
  /** Slots whose Core is treated as reporting on these days: its own pv_total the field ÷ `fieldOverCore`
   *  (1 when omitted). */
  coreSourced?: { slots: number[]; fromDay: string; toDay: string; fieldOverCore?: number };
  /** Membership entries appended (each from the start of its day, so that day is the new map's whole first
   *  day), with the house panel's full map. */
  entries?: Array<{ fromDay: string; slots: Record<number, string> }>;
  /** No membership record at all. */
  noMembership?: boolean;
  /** Per-day edits: the vendor row's Wh (null: no row), a night field hour (W) on a slot. */
  vendor?: Record<string, number | null>;
  nightReading?: { slot: number; day: string; w: number };
  /** A different threshold (tests of the constant). */
  threshold?: number;
  /** Cut what is "known": rows after this instant are absent (a day not yet over, its vendor row not yet
   *  fetched: the vendor row for day d arrives 06:35-09:00 on d+1, taken here as 09:00). */
  knownAtMs?: number;
}

const memberships = (o: RecordOptions): MembershipHistory | null => {
  if (o.noMembership) return null;
  const entries = RECORD.membership.entries.map((e) => ({ ...e, slots: e.slots ? { ...e.slots } : undefined }));
  for (const x of o.entries ?? []) {
    const slots = Object.fromEntries(Object.entries(x.slots).map(([k, v]) => [`${PANEL}:${k}`, v]));
    entries.push({ fp: Object.values(slots).sort().join(','), atMs: siteDayStartMs(x.fromDay), slots, confirmedMs: RECORD.cutoffMs });
  }
  if (o.removed) {
    const last = entries[entries.length - 1];
    const slots: Record<string, string> = { ...(last.slots ?? {}) };
    for (const s of o.removed.slots) delete slots[`${PANEL}:${s}`];
    entries.push({ fp: Object.values(slots).sort().join(','), atMs: siteDayStartMs(o.removed.fromDay) + 1, slots, confirmedMs: RECORD.cutoffMs });
  }
  entries.sort((a, b) => a.atMs - b.atMs);
  return { entries: entries.map((e) => (e.slots ? e : { fp: e.fp, atMs: e.atMs })) as MembershipHistory['entries'] };
};

function capacities(o: RecordOptions): Record<number, number> {
  if (o.capacity === 'held') return { 1: RECORD.heldWh['1'], 2: RECORD.heldWh['2'], 3: RECORD.heldWh['3'] };
  if (o.capacity && typeof o.capacity === 'object') return o.capacity;
  return { 1: RECORD.nameplateWh, 2: RECORD.nameplateWh, 3: RECORD.nameplateWh };
}

/** The hours as the options shape them (the fault, a Core-sourced slot, a night reading, the known cut). */
function shapedHours(o: RecordOptions, slot: number, day: string): SlotHour[] {
  const base = recordHours(slot, day);
  return base.map((h0) => {
    let h = h0;
    if (o.knownAtMs != null && h.startMs + 3_600_000 > o.knownAtMs) {
      return { ...h, pct0: null, pct1: null, outWh: null, inWh: null, fieldWh: null, fieldCovS: 0, coreRawWh: 0, coreCovS: 0, acInS: 0 };
    }
    if (o.fault && day >= o.fault.fromDay && (o.fault.toDay == null || day <= o.fault.toDay) && (o.fault.slots == null || o.fault.slots.includes(slot)) && h.fieldWh != null) {
      h = { ...h, fieldWh: h.fieldWh * o.fault.scale };
    }
    if (o.coreSourced && o.coreSourced.slots.includes(slot) && day >= o.coreSourced.fromDay && day <= o.coreSourced.toDay && h.fieldWh != null) {
      h = { ...h, coreRawWh: h.fieldWh / (o.coreSourced.fieldOverCore ?? 1), coreCovS: 3600 };
    }
    if (o.nightReading && o.nightReading.slot === slot && o.nightReading.day === day && !h.sun && h.fieldWh != null) {
      const first = base.find((x) => !x.sun);
      if (first && first.startMs === h.startMs) h = { ...h, fieldWh: o.nightReading.w };
    }
    return h;
  });
}

function vendorOf(o: RecordOptions, day: string): number | null {
  if (o.vendor && Object.hasOwn(o.vendor, day)) return o.vendor[day];
  let v = RECORD.vendorWh[day];
  if (v == null) return null;
  // The panel's own daily solar counts the slots connected to it: a removed slot's array leaves it.
  if (o.removed && day >= o.removed.fromDay) {
    for (const s of o.removed.slots) for (const h of recordHours(s, day)) if (h.fieldWh != null) v -= h.fieldWh;
  }
  if (o.knownAtMs != null && siteDayStartMs(addDaysYmd(day, 1)) + 9 * 3_600_000 > o.knownAtMs) return null;
  if (!o.fault || day < o.fault.fromDay || (o.fault.toDay != null && day > o.fault.toDay)) return v;
  // A panel-side scaling scales the panel's own daily total too: the faulted slots' added field.
  let extra = 0;
  for (const s of SLOTS) {
    if (o.fault.slots != null && !o.fault.slots.includes(s)) continue;
    for (const h of recordHours(s, day)) if (h.fieldWh != null) extra += h.fieldWh * (o.fault.scale - 1);
  }
  return v + extra;
}

function bridgeRows(day: string): BridgeWindowRow[] {
  const out: BridgeWindowRow[] = [];
  for (const [slot, core, basis, n] of RECORD.bridge[day] ?? []) {
    for (let i = 0; i < n; i++) out.push({ sn: core, panelSn: PANEL, slot, basis });
  }
  return out;
}

/** The constants of one (slot, Core) fitted on the record's vouched days before `beforeDay`. */
export function recordFit(slot: number, core: string, o: RecordOptions = {}, beforeDay = '2026-11-07'): ConstantsFit {
  const h = memberships(o);
  const cap = capacities(o)[slot];
  const days: Array<{ day: string; hours: readonly SlotHour[] }> = [];
  for (const day of RECORD.days) {
    if (day >= beforeDay) break;
    if (slotMapOfDay(h, PANEL, day)?.[slot] !== core) continue;
    days.push({ day, hours: recordHours(slot, day) });
  }
  return fitPlantConstants(days, cap);
}

/** The callbacks assembleUcTable reads, on the record as the options shape it, as of the evening E. */
export function recordSources(asOfDay: string, o: RecordOptions = {}): UcSources {
  const h = memberships(o);
  const cap = capacities(o);
  const evalCap = o.evalCapacity ?? cap;
  const fits = new Map<string, ConstantsFit>();
  const planningFrom = addDaysYmd(asOfDay, -PLANNING_WINDOW_DAYS);
  return {
    panelSn: PANEL,
    days: ucTableDays(asOfDay),
    slots: [...SLOTS],
    mapOfDay: (day) => slotMapOfDay(h, PANEL, day),
    mapAsOf: (e) => slotMapOfRecord(h, PANEL, e),
    hoursOf: (slot, day) => shapedHours(o, slot, day),
    bridgeRowsOf: (day) => bridgeRows(day),
    trusted: (slot) => RECORD.trustedSlots.includes(slot),
    provedUnderCharge: (slot) => (RECORD.proofDays[String(slot)] ?? []).some((d) => d >= planningFrom && d < asOfDay),
    capacityOf: (slot) => evalCap[slot] ?? null,
    fitOf: (slot, core) => {
      const k = `${slot}|${core}`;
      let f = fits.get(k);
      if (!f) fits.set(k, (f = recordFit(slot, core, o)));
      return f;
    },
    vendorOf: (day) => vendorOf(o, day),
    threshold: o.threshold,
  };
}

/** The recorded evenings the replay pins (the dark era's first evening through the snapshot's last). */
export const EVENINGS: string[] = (() => {
  const out: string[] = [];
  for (let d = '2026-10-16'; d <= '2026-11-07'; d = addDaysYmd(d, 1)) out.push(d);
  return out;
})();

/** An evening's 21:30, 22:30 and the night's 00:30 (site time). */
export function eveningTimes(asOfDay: string): { t2130: number; t2230: number; t0030: number; nextDay0930: number } {
  const s = siteDayStartMs(asOfDay);
  const n = siteDayStartMs(addDaysYmd(asOfDay, 1));
  return { t2130: s + 21.5 * 3_600_000, t2230: s + 22.5 * 3_600_000, t0030: n + 0.5 * 3_600_000, nextDay0930: n + 9.5 * 3_600_000 };
}
