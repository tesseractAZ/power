/**
 * v1.108.0 — persistent LATCH for confirmed-defective packs.
 *
 * MOTIVATING INCIDENT (2026-08-24). The v1.101.0 `pack-defective-*` standing
 * alert is gated on a live three-leg signature whose third leg — sibling median
 * ≥ 100 W — tracks the charger's duty cycle. The day the TOU window first let
 * the bank charge, the warranty pack's alert fired and resolved THREE times
 * (09:06→09:11, 12:07→12:11, 15:05→15:09), one [High] push plus one Resolved
 * push per burst. "This battery is broken" is a DIAGNOSIS: it does not become
 * untrue because charging paused, and a cry-wolf cadence on the one alert that
 * is exempt from every mute path trains the operator to ignore exactly the
 * alert that must never be ignored.
 *
 * THE LATCH. The first time the full signature is observed for a pack, the
 * confirmation is recorded here — keyed by the pack's PHYSICAL serial number,
 * not its (chassis, slot), because the 08-20 swap proved faults travel with
 * the pack. From then on the standing alert is emitted whenever that pack is
 * present in the fleet, legs or no legs. It clears two ways only:
 *   - the pack leaves the fleet (RMA'd out): emission stops as soon as it is
 *     absent, and the record itself retires after 48 h of absence so a
 *     repaired/replaced unit with the same SN does not inherit the verdict;
 *   - an explicit operator clear (POST /api/defective-packs/clear) for the
 *     false-positive case.
 *
 * PERSISTENCE. Confirmations survive restarts (a deploy must not un-confirm a
 * diagnosis). Presence tracking is deliberately in-memory only: a restart
 * resets each record's absence clock to "seen just now", which merely delays
 * retirement — harmless against a 48 h threshold, and it keeps this file from
 * being rewritten every poll tick.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

export interface DefectivePackRecord {
  packSn: string;
  deviceSn: string;
  deviceName: string;
  packNum: number;
  confirmedAtMs: number;
  /** Evidence captured at FIRST confirmation — the RMA-relevant snapshot. */
  socPct: number;
  siblingMedianSocPct: number;
  packAbsW: number;
  siblingMedianAbsW: number;
  deviantCell: number;
  deltaMv: number;
}

/** Absence horizon after which a confirmation retires (pack left the fleet). */
export const DEFECTIVE_PACK_ABSENT_RETIRE_MS = 48 * 60 * 60 * 1000;

const defaultPath = (): string =>
  process.env.DEFECTIVE_PACK_LATCH_PATH ?? resolve(process.cwd(), config.dbPath, '..', 'defective-pack-latch.json');

let statePath: string | null = null;
let records: Map<string, DefectivePackRecord> | null = null;
/** In-memory only — see PERSISTENCE note above. */
const lastPresentMs = new Map<string, number>();

function ensureLoaded(): Map<string, DefectivePackRecord> {
  if (records) return records;
  statePath = defaultPath();
  records = new Map();
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (r && typeof r.packSn === 'string' && typeof r.confirmedAtMs === 'number') {
          records.set(r.packSn, r as DefectivePackRecord);
        }
      }
    }
  } catch {
    // Missing or corrupt file ⇒ start empty (fail toward v1.101.0 behavior:
    // legs-only emission — never toward inventing a confirmation).
  }
  return records;
}

function save(): void {
  if (!records || !statePath) return;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify([...records.values()], null, 2));
  } catch {
    // A failed save costs latch persistence across the NEXT restart, nothing
    // live — never let sidecar I/O break alert evaluation.
  }
}

/** Record a live full-signature confirmation. First confirmation wins (its
 *  evidence is the RMA snapshot); later sightings only refresh presence. */
export function confirmDefectivePack(rec: Omit<DefectivePackRecord, 'confirmedAtMs'>, nowMs: number): void {
  const m = ensureLoaded();
  lastPresentMs.set(rec.packSn, nowMs);
  if (m.has(rec.packSn)) return;
  m.set(rec.packSn, { ...rec, confirmedAtMs: nowMs });
  save();
}

/** Refresh the absence clock for a CONFIRMED pack seen in the fleet. No-op for
 *  unconfirmed SNs, so the map cannot grow with ordinary healthy hardware. */
export function markPackPresent(packSn: string, nowMs: number): void {
  if (ensureLoaded().has(packSn)) lastPresentMs.set(packSn, nowMs);
}

export function getConfirmedRecord(packSn: string): DefectivePackRecord | null {
  return ensureLoaded().get(packSn) ?? null;
}

export function listConfirmedRecords(): DefectivePackRecord[] {
  return [...ensureLoaded().values()];
}

/** Retire confirmations whose pack has been absent past the horizon. */
export function retireAbsentPacks(nowMs: number): void {
  const m = ensureLoaded();
  let changed = false;
  for (const [sn, rec] of m) {
    const seen = lastPresentMs.get(sn);
    if (seen == null) { lastPresentMs.set(sn, nowMs); continue; } // first sighting of the record this process: arm the clock
    if (nowMs - seen > DEFECTIVE_PACK_ABSENT_RETIRE_MS) {
      m.delete(sn);
      lastPresentMs.delete(sn);
      changed = true;
      void rec;
    }
  }
  if (changed) save();
}

/** Operator clear for the false-positive case. Returns true if a record existed. */
export function clearConfirmedPack(packSn: string): boolean {
  const m = ensureLoaded();
  const had = m.delete(packSn);
  lastPresentMs.delete(packSn);
  if (had) save();
  return had;
}

/** Test hook: point at a fresh path and drop all in-memory state. */
export function _resetDefectivePackLatchForTests(path?: string): void {
  records = null;
  statePath = null;
  lastPresentMs.clear();
  if (path) process.env.DEFECTIVE_PACK_LATCH_PATH = path;
}
