/**
 * maintenanceWindow.ts — v1.197.0. A per-Core, time-boxed maintenance window: one Core's OWN
 * alerts are held (no push, no broadcast) for a set time; every house-wide alarm still sounds.
 *
 * WHY: a planned reconfiguration — a Core powered down, re-wired, a pack swapped, a setting
 * changed — reads to the alarm engine as a stream of real faults (offline, a telemetry gap, a
 * freshly woken BMS's cell spread and low SoC, roster flaps). The inferred mutes are built to fail
 * loud (off-panel re-arms on one sighting; the settle dwells debounce on persistence, which a woken
 * BMS satisfies), so none of them can absorb it. On 2026-08-20 the reconfiguration of two Cores
 * produced 42 pushes and 7 broadcasts, three of them red. The only runtime lever was the Alert
 * Settings per-priority switch, which applies to the whole plant — the battery-level ladder and the
 * runway included — and never expires.
 *
 * SCOPE — what a window holds, and what it never holds:
 *  - Only a Core (a DPU) can be shelved. The panel carries the pool alarms and is refused.
 *  - Only alerts that NAME the shelved Core (its serial as a whole id segment, or its `sourceSn`)
 *    AND belong to a family on MAINTENANCE_SHELVABLE_PREFIXES — a POSITIVE list of Core-scoped
 *    families. A family that is not classified here stays loud. Pool, panel and plant-level
 *    alarms (backup-soc, shp2-*, reserve-alarm-blind, forecast-runtime, telemetry blind, grid,
 *    host, storm) are on no list and so never held, even when the shelved Core causes them.
 *  - isNeverMutedAlert first: an overheating pack, a cell at the over-voltage line, a confirmed
 *    defective pack and the multi-panel guard page from a shelved Core as from anywhere.
 *
 * LIMITS: 15 min to 4 h (MAINT_MIN_MS, MAINT_MAX_MS), 2 h by default. A request outside them is
 * refused, never clamped. An extension is capped at the window's start + 4 h; a new window may
 * start once one is over. On a plant with more than one home Core, a window that would leave none
 * of them with its alarms is refused — judged against a home set that a Core being worked on does
 * not leave by dropping off the panel roster (guardHomeSet, MaintenanceWindow.homeAtStart).
 *
 * END: at its time; once the Core, having been seen abnormal in the window, has been back to
 * normal (reporting, and none of its own alerts standing at warning or above apart from those it
 * already carried when the window opened) for MAINT_RETURN_DWELL_MS; when ended from the card, the
 * API or Home Assistant; when the clock steps back before its start (the host has no RTC); when its
 * span exceeds the limit (a forged or corrupt record); or when the Core leaves the device map. An
 * alert still active then annunciates on the next tick: one push, and the broadcast counts it.
 *
 * FAIL CLOSED, every guard: no window, nothing shelved. The stamp checks expiry and the hard limit
 * itself (applyMaintenanceMute), so a step that never runs cannot stretch a window. An unreadable
 * file loads as no windows. A failed save refuses the start; an end that cannot be saved removes the
 * file, so a restart shelves nothing. A held alert is never boot-seeded as already pushed
 * (heldUnpushed): what a window held is pushed when it ends, across a restart too.
 *
 * PURE CORE: every function below `createMaintenanceController` takes its clock as an argument.
 * The controller holds the windows, persists them and does the side effects (push, write log, log)
 * through injected sinks. Main thread only.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { atomicWriteFileSync } from './atomicWrite.js';
import { isNeverMutedAlert, isDeviceGapAlertId, MUTE_REASON_MAINTENANCE, STALE_MS, type Alert, type Severity } from './alerts.js';
import { coreLabel, coreNumber, isDpuProduct, isShp2Product, slotOfDpu } from './topology.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { NotifyMessage } from './notify.js';
import type { SettingChange, SettingValue } from './settingsDrift.js';

/* ─── limits ─────────────────────────────────────────────────────────────────────────────── */

export const MAINT_MIN_MS = 15 * 60_000;
/** The hard limit of one window, counted from its start. Not an option: a longer job ends one
 *  window and starts another, each pushed and in the write log. */
export const MAINT_MAX_MS = 4 * 3_600_000;
export const MAINT_DEFAULT_MS = 2 * 3_600_000;
/** The durations the card offers. */
export const MAINT_CHOICES_MIN: readonly number[] = [30, 60, 120, 240];
/** Back to normal this long (after an abnormal tick) ends the window early. */
export const MAINT_RETURN_DWELL_MS = 15 * 60_000;
/** A tick this far before a window's start is a clock stepped back, not jitter. */
export const MAINT_CLOCK_BACK_TOL_MS = 60_000;
/** An ended window is kept this long: for the telemetry-gap absorption and the API's recent list.
 *  v1.197.0 (review) — counted from the later of its end and the last time a telemetry-gap alert it
 *  absorbs was on screen (gapSeenAtMs): a per-device gap is filed 6 h into the darkness and lives a
 *  day past that, always beyond a window's end + 24 h. */
export const MAINT_ENDED_KEEP_MS = 24 * 3_600_000;
/** How often an ended window's gapSeenAtMs is moved forward while an absorbed gap stands (each move
 *  is a save). */
export const MAINT_GAP_SEEN_REFRESH_MS = 3_600_000;
/** "Reporting": the Core's last reading is younger than the 'Telemetry stale' line. */
export const MAINT_REPORTING_MAX_AGE_MS = STALE_MS;
export const MAINT_HELD_CAP = 50;
export const MAINT_SETTINGS_CAP = 20;
export const MAINT_NOTE_MAX = 80;

/**
 * The Core-scoped alert families a window may hold. POSITIVE: a family missing here stays loud.
 * test/maintenanceWindow pins every computeAlerts stem built on a device serial to this list or to
 * the explicit loud set (cell-ovp-, pack-defective-).
 */
export const MAINTENANCE_SHELVABLE_PREFIXES: readonly string[] = [
  'offline-', 'stale-', 'msg-rate-floor-', 'system-outage-device-',
  'dpu-err-', 'dpu-pvh-err-', 'dpu-pvl-err-', 'dpu-imbalance-',
  'mppt-', 'ems-volt-', 'soh-', 'vdiff-', 'balancing-', 'temp-', 'soc-low-',
  'peer-', 'baseline-', 'forecast-soh-', 'forecast-imbalance-',
];

/* ─── the record ─────────────────────────────────────────────────────────────────────────── */

export type MaintenanceEndReason =
  | 'expired' | 'returned-to-normal' | 'ended-by-owner' | 'clock-stepped-back' | 'over-limit' | 'device-removed';
export type MaintenanceSource = 'web' | 'api' | 'ha';

export interface MaintenanceHeld {
  id: string;
  title: string;
  /** The most severe face seen while held. */
  severity: Severity;
  firstAtMs: number;
  /** Times it rose (absent → present) while held. */
  rises: number;
  /** Present on the last observed tick (so a restart does not count a standing one again). */
  present: boolean;
}

export interface MaintenanceSettingChange { key: string; from: SettingValue; to: SettingValue; atMs: number }

export interface MaintenanceWindow {
  sn: string;
  label: string;
  coreNum: number | null;
  startedAtMs: number;
  untilMs: number;
  endedAtMs?: number;
  endReason?: MaintenanceEndReason;
  source: MaintenanceSource;
  note: string | null;
  /** The Core's own warning-or-above alerts standing when the window opened (normal for it). */
  standingAtStart: string[];
  abnormalSeenAtMs: number | null;
  normalSinceMs: number | null;
  held: MaintenanceHeld[];
  /** Held alerts beyond MAINT_HELD_CAP, counted, not listed. */
  heldDropped: number;
  settingsChanged: MaintenanceSettingChange[];
  /** v1.197.0 (review) — a home Core when it opened: it counts toward the home-pool guard for its
   *  whole span, though a Core being re-wired drops off the panel's live roster. A record without it
   *  loads as true (the guard refuses more, never less). */
  homeAtStart: boolean;
  /** v1.197.0 (review) — the last tick (to the hour) a telemetry-gap alert this ended window absorbs
   *  was on screen; the window is kept MAINT_ENDED_KEEP_MS past the later of its end and this. */
  gapSeenAtMs: number | null;
}

/* ─── which alerts a window holds ────────────────────────────────────────────────────────── */

/** Does `a` name the device `sn`: its `sourceSn`, or `sn` as a WHOLE '-' segment of the id (a
 *  serial that is a prefix of another serial names only itself). */
export function alertNamesDevice(a: Pick<Alert, 'id' | 'sourceSn'>, sn: string): boolean {
  if (!sn) return false;
  if (a.sourceSn === sn) return true;
  return a.id.split('-').includes(sn);
}

/** May a window hold `a` at all: never a never-muted alert, and only a classified Core family. */
export function isShelvable(a: Pick<Alert, 'id' | 'severity' | 'category'>): boolean {
  if (isNeverMutedAlert(a)) return false;
  return MAINTENANCE_SHELVABLE_PREFIXES.some((p) => a.id.startsWith(p));
}

/** The window's span is within the hard limit (a forged or corrupt record is not). */
function withinLimit(w: Pick<MaintenanceWindow, 'startedAtMs' | 'untilMs'>): boolean {
  return w.untilMs - w.startedAtMs <= MAINT_MAX_MS;
}

/** A window holds at `now`: not ended, started (within the clock tolerance), not yet at its end,
 *  and within the hard limit. Checked at STAMP time, so a stalled step cannot stretch a window. */
export function windowInForce(w: MaintenanceWindow, now: number): boolean {
  return w.endedAtMs == null && now >= w.startedAtMs - MAINT_CLOCK_BACK_TOL_MS && now < w.untilMs && withinLimit(w);
}

/**
 * Why an open window is over at `now` by the clock alone, or null (exactly when windowInForce holds):
 * the clock stepped back before its start, its end reached, its span over the limit. The step's first
 * three ends, and v1.197.0 (review) the controller's before it acts on the list — a window lapsed in
 * the seconds since the last step is ended first, so a start then does not open a second window
 * beside it (and End now does not end the stale one while a new one holds).
 */
export function lapseReason(w: MaintenanceWindow, now: number): MaintenanceEndReason | null {
  if (now < w.startedAtMs - MAINT_CLOCK_BACK_TOL_MS) return 'clock-stepped-back';
  if (now >= w.untilMs) return 'expired';
  if (!withinLimit(w)) return 'over-limit';
  return null;
}

/** The window in force that holds `a` at `now`, or null. */
export function activeWindowFor(a: Alert, ws: readonly MaintenanceWindow[], now: number): MaintenanceWindow | null {
  if (!isShelvable(a)) return null;
  return ws.find((w) => windowInForce(w, now) && alertNamesDevice(a, w.sn)) ?? null;
}

/** The start of a per-device gap from its id (alerts.deviceGapAlertId), or null. */
export function deviceGapStartMs(id: string, sn: string): number | null {
  const prefix = `system-outage-device-${sn}-`;
  if (!id.startsWith(prefix)) return null;
  const head = id.slice(prefix.length).split('-')[0];
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isSafeInteger(n) ? n : null;
}

/** The per-device gap `a` began inside `w`'s span, for `w`'s device (a window over the limit absorbs
 *  nothing). */
function absorbsGap(w: MaintenanceWindow, a: Pick<Alert, 'id'>): boolean {
  if (!withinLimit(w)) return false;
  const start = deviceGapStartMs(a.id, w.sn);
  if (start == null) return false;
  const end = Math.min(w.endedAtMs ?? w.untilMs, w.untilMs);
  return start >= w.startedAtMs && start < end;
}

/**
 * A per-device telemetry gap that BEGAN inside a window for that device (in force, or ended and still
 * retained — MAINT_ENDED_KEEP_MS past the later of its end and the last sight of a gap it absorbs):
 * the Core was dark because it was being worked on. The gap alert is a retrospective event, filed
 * 6 h into the darkness, that lives a day and pushes once; without this it pushed when the window
 * ended. A gap that began outside every window is untouched.
 */
export function gapAbsorbedBy(a: Alert, ws: readonly MaintenanceWindow[]): MaintenanceWindow | null {
  if (!isDeviceGapAlertId(a.id) || !isShelvable(a)) return null;
  return ws.find((w) => absorbsGap(w, a)) ?? null;
}

/**
 * The stamp, on the monitor's one chokepoint (alertMonitor assemble, after applyRosterMute): a held
 * alert is `annunciate:false` (no push, not counted by the broadcast), says why (muteReason,
 * diagnostic only) and carries `shelvedUntilMs`, which the all-clear gate reads: shelved is held,
 * not cleared. The window is now the mute in force, so a bounded cell-spread `mutedBy` is dropped.
 * MUTATES `a`; returns the holding window, or null (and `a` untouched).
 */
export function applyMaintenanceMute(a: Alert, ws: readonly MaintenanceWindow[], now: number): MaintenanceWindow | null {
  const w = activeWindowFor(a, ws, now) ?? gapAbsorbedBy(a, ws);
  if (!w) return null;
  a.annunciate = false;
  a.muteReason = MUTE_REASON_MAINTENANCE;
  a.shelvedUntilMs = w.endedAtMs ?? w.untilMs;
  delete a.mutedBy;
  return w;
}

/**
 * v1.197.0 (review) — was `a` held by a window, and so never pushed for it? Stamped on this tick
 * (shelvedUntilMs), on a retained window's held list, or a shelvable alert naming the Core of a
 * window found ended at start-up (`bootEndedSns`: it may have risen while the add-on was down, inside
 * the window). The monitor's boot seed (alertMonitor.bootSeedNotified) marks a warning standing at
 * the first tick as already pushed; a held one was not, so it is seeded only on a delivery record —
 * otherwise a window spanning one of the host's daily restarts swallowed every warning it held, and
 * the end push's "pushed and announced from now on" was false. PURE.
 */
export function heldUnpushed(
  a: Pick<Alert, 'id' | 'severity' | 'category' | 'sourceSn' | 'shelvedUntilMs'>,
  ws: readonly MaintenanceWindow[],
  bootEndedSns: ReadonlySet<string>,
): boolean {
  if (a.shelvedUntilMs != null) return true;
  if (!isShelvable(a)) return false;
  return ws.some((w) => alertNamesDevice(a, w.sn) && (bootEndedSns.has(w.sn) || w.held.some((h) => h.id === a.id)));
}

/* ─── starting (and extending) a window ──────────────────────────────────────────────────── */

export interface StartRequest {
  sn: string;
  durationMs: number;
  note?: unknown;
  nowMs: number;
  source: MaintenanceSource;
  devices: Readonly<Record<string, DeviceSnapshot>>;
  windows: readonly MaintenanceWindow[];
  /** The Cores wired to the house pool (guardHomeSet). The Cores of windows in force that were home
   *  when they opened are added here, whatever the roster reads now. */
  homePoolSns: ReadonlySet<string>;
  /** The alerts on screen now: the Core's own warning-or-above ones are its normal. */
  alerts: readonly Alert[];
}

export type StartResult =
  | { ok: true; window: MaintenanceWindow; extended: boolean }
  | { ok: false; code: 400 | 404 | 409; error: string };

/** A note: control characters (C0, DEL, C1 — ANSI escapes) removed, trimmed, at most 80 chars. */
export function cleanNote(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAINT_NOTE_MAX).trim();
  return s.length > 0 ? s : null;
}

const fmtMin = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/** A Core (a DPU): its projection says so, or, before it has one, its product name — never a panel. */
export function isCoreDevice(d: Pick<DeviceSnapshot, 'productName' | 'projection'> | undefined): boolean {
  if (d == null || isShp2Product(d.productName)) return false;
  return d.projection?.kind === 'dpu' || (d.projection == null && isDpuProduct(d.productName));
}

/**
 * The windows the stamp may apply: those whose device is a Core in the live map. The API refuses
 * anything else; this makes a window naming any other device (a forged or corrupt record) inert in
 * the stamp too — a panel's own offline or stale alert is pool evidence and is never held.
 */
export function windowsOnCores(ws: readonly MaintenanceWindow[], devices: Readonly<Record<string, DeviceSnapshot>>): MaintenanceWindow[] {
  return ws.filter((w) => isCoreDevice(devices[w.sn]));
}

/**
 * v1.197.0 (review) — the home Cores the start guard counts: the panel's live roster, its last-known
 * value, and every Core a panel lists on a slot, connected or not. The live roster alone let a Core
 * being re-wired (off the roster for minutes) stop counting: with Core 3 shelved and unplugged, the
 * last home Core could be shelved too, and a target momentarily off the roster skipped the guard. A
 * wider set refuses more starts, never fewer. PURE.
 */
export function guardHomeSet(
  devices: Readonly<Record<string, DeviceSnapshot>>,
  liveRoster: ReadonlySet<string>,
  lastKnownRoster: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>([...liveRoster, ...lastKnownRoster]);
  for (const [sn, d] of Object.entries(devices)) if (isCoreDevice(d) && slotOfDpu(devices, sn) != null) out.add(sn);
  return out;
}

/** Validate a start or an extension. PURE: the caller persists the returned window. */
export function validateStart(p: StartRequest): StartResult {
  const d = p.devices[p.sn];
  if (!d) return { ok: false, code: 404, error: 'unknown device' };
  if (!isCoreDevice(d)) {
    return { ok: false, code: 400, error: 'only a Core can be shelved; the panel carries the pool alarms' };
  }
  if (!Number.isFinite(p.durationMs) || p.durationMs < MAINT_MIN_MS) {
    return { ok: false, code: 400, error: `a window is at least ${fmtMin(MAINT_MIN_MS)}` };
  }
  if (p.durationMs > MAINT_MAX_MS) {
    return { ok: false, code: 400, error: `a window is at most ${fmtMin(MAINT_MAX_MS)}` };
  }
  const note = cleanNote(p.note);
  const inForce = p.windows.filter((w) => windowInForce(w, p.nowMs));
  const current = inForce.find((w) => w.sn === p.sn);
  if (current) {
    // An extension: never past the window's start + the hard limit.
    const limitMs = current.startedAtMs + MAINT_MAX_MS;
    const untilMs = Math.min(p.nowMs + p.durationMs, limitMs);
    if (untilMs <= current.untilMs) {
      // v1.197.0 (review) — two refusals: at the limit, or a request that would not move the end
      // (an extension never shortens a window; End now does).
      return current.untilMs >= limitMs
        ? { ok: false, code: 409, error: `already shelved to its limit (${fmtMin(MAINT_MAX_MS)} from its start); end it and start a new window` }
        : { ok: false, code: 409, error: 'already shelved for longer than that; an extension only moves the end later (end it to finish sooner)' };
    }
    return { ok: true, extended: true, window: { ...current, untilMs, ...(note != null ? { note } : {}) } };
  }
  // v1.197.0 (review) — the home set: the caller's (guardHomeSet) plus every Core shelved now that was
  // home when its window opened — off the live roster while it is worked on, still a home Core.
  const home = new Set([...p.homePoolSns, ...inForce.filter((w) => w.homeAtStart).map((w) => w.sn)]);
  if (home.has(p.sn)) {
    const others = [...home].filter((sn) => sn !== p.sn);
    const shelved = new Set(inForce.map((w) => w.sn));
    if (others.length > 0 && others.every((sn) => shelved.has(sn))) {
      return { ok: false, code: 409, error: 'every other home Core is shelved; at least one keeps its alarms' };
    }
  }
  const coreNum = coreNumber(d, p.devices);
  const standingAtStart = p.alerts
    .filter((a) => a.severity !== 'info' && alertNamesDevice(a, p.sn) && !isDeviceGapAlertId(a.id))
    .map((a) => a.id);
  return {
    ok: true,
    extended: false,
    window: {
      sn: p.sn, label: coreLabel(coreNum, d.deviceName), coreNum,
      startedAtMs: p.nowMs, untilMs: p.nowMs + p.durationMs,
      source: p.source, note, standingAtStart: [...new Set(standingAtStart)],
      abnormalSeenAtMs: null, normalSinceMs: null,
      held: [], heldDropped: 0, settingsChanged: [],
      homeAtStart: home.has(p.sn), gapSeenAtMs: null,
    },
  };
}

/* ─── the step ───────────────────────────────────────────────────────────────────────────── */

/** What one alert tick saw of a device. */
export interface DeviceObs { online?: boolean; lastUpdated?: number | null }

export interface MaintenanceObservation {
  /** The tick's alert set, AFTER the stamp (a held alert carries shelvedUntilMs). */
  alerts: readonly Alert[];
  /** The device map, or null before it has hydrated (a Core is never "removed" by an empty map). */
  devices: Readonly<Record<string, DeviceObs>> | null;
}

export interface StepResult {
  windows: MaintenanceWindow[];
  ended: MaintenanceWindow[];
  changed: boolean;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function endWindow(w: MaintenanceWindow, reason: MaintenanceEndReason, now: number): MaintenanceWindow {
  return { ...w, endedAtMs: now, endReason: reason };
}

/** Fold the tick's held alerts into the window's list (copy-on-write). Returns whether it moved. */
function foldHeld(w: MaintenanceWindow, held: readonly Alert[], now: number): boolean {
  let changed = false;
  const ids = new Set(held.map((a) => a.id));
  for (const h of w.held) {
    if (h.present && !ids.has(h.id)) { h.present = false; changed = true; }
  }
  for (const a of held) {
    const h = w.held.find((x) => x.id === a.id);
    if (h) {
      if (!h.present) { h.present = true; h.rises++; changed = true; }
      if (SEV_RANK[a.severity] < SEV_RANK[h.severity]) { h.severity = a.severity; changed = true; }
      continue;
    }
    if (w.held.length >= MAINT_HELD_CAP) { w.heldDropped++; changed = true; continue; }
    w.held.push({ id: a.id, title: a.title, severity: a.severity, firstAtMs: now, rises: 1, present: true });
    changed = true;
  }
  return changed;
}

/**
 * One alert tick. PURE (returns new window objects). Per window still open, in order: the clock
 * stepped back before its start → 'clock-stepped-back'; at or past its end → 'expired'; a span
 * over the limit → 'over-limit'; the Core gone from a hydrated device map → 'device-removed'.
 * Otherwise the held list is updated and the Core judged: ABNORMAL when it is not reporting
 * (offline, or its last reading older than the stale line) or one of its own alerts stands at
 * warning or above that it did not carry when the window opened (a telemetry-gap event aside).
 * After an abnormal tick, `returnDwellMs` (MAINT_RETURN_DWELL_MS; shorter only in tests) of normal
 * ends it ('returned-to-normal'). An ended window is pruned MAINT_ENDED_KEEP_MS after the later of
 * its end and the last sight of a telemetry-gap alert it absorbs (gapSeenAtMs, moved at most hourly).
 */
export function stepMaintenance(
  ws: readonly MaintenanceWindow[],
  obs: MaintenanceObservation,
  now: number,
  returnDwellMs: number = MAINT_RETURN_DWELL_MS,
): StepResult {
  const out: MaintenanceWindow[] = [];
  const ended: MaintenanceWindow[] = [];
  let changed = false;
  for (const w0 of ws) {
    if (w0.endedAtMs != null) {
      // v1.197.0 (review) — kept while a gap it absorbs stands: pruned at its end + 24 h, the gap
      // (filed 6 h into the darkness, alive a day after that) annunciated a day late.
      if (obs.alerts.some((a) => isDeviceGapAlertId(a.id) && absorbsGap(w0, a))
        && (w0.gapSeenAtMs == null || now - w0.gapSeenAtMs >= MAINT_GAP_SEEN_REFRESH_MS)) {
        out.push({ ...w0, gapSeenAtMs: now });
        changed = true;
        continue;
      }
      if (now - Math.max(w0.endedAtMs, w0.gapSeenAtMs ?? 0) > MAINT_ENDED_KEEP_MS) { changed = true; continue; }
      out.push(w0);
      continue;
    }
    const w: MaintenanceWindow = { ...w0, held: w0.held.map((h) => ({ ...h })) };
    let reason: MaintenanceEndReason | null = lapseReason(w, now);
    if (reason == null && obs.devices != null && !(w.sn in obs.devices)) reason = 'device-removed';
    if (reason == null) {
      const held = obs.alerts.filter((a) => a.shelvedUntilMs != null && alertNamesDevice(a, w.sn));
      if (foldHeld(w, held, now)) changed = true;
      if (obs.devices != null) {
        const d = obs.devices[w.sn];
        const reporting = d.online === true && d.lastUpdated != null && now - d.lastUpdated < MAINT_REPORTING_MAX_AGE_MS;
        const standing = new Set(w.standingAtStart);
        const ownAbnormal = obs.alerts.some((a) =>
          a.severity !== 'info' && alertNamesDevice(a, w.sn) && !isDeviceGapAlertId(a.id) && !standing.has(a.id));
        if (!reporting || ownAbnormal) {
          if (w.abnormalSeenAtMs == null) { w.abnormalSeenAtMs = now; changed = true; }
          if (w.normalSinceMs != null) { w.normalSinceMs = null; changed = true; }
        } else if (w.normalSinceMs == null) {
          w.normalSinceMs = now;
          changed = true;
        }
        if (w.abnormalSeenAtMs != null && w.normalSinceMs != null && now - w.normalSinceMs >= returnDwellMs) {
          reason = 'returned-to-normal';
        }
      }
    }
    if (reason != null) {
      const e = endWindow(w, reason, now);
      out.push(e);
      ended.push(e);
      changed = true;
    } else {
      out.push(w);
    }
  }
  return { windows: out, ended, changed };
}

/* ─── persistence ────────────────────────────────────────────────────────────────────────── */

export interface LoadResult {
  windows: MaintenanceWindow[];
  /** Windows that ended while the add-on was down (or load as ended): their end push is owed. */
  endedAtBoot: MaintenanceWindow[];
  /** The file was unreadable: nothing is shelved (the loud direction). */
  corrupt: boolean;
}

const SN_RE = /^[A-Za-z0-9]{4,64}$/;
const SOURCES: readonly MaintenanceSource[] = ['web', 'api', 'ha'];
const REASONS: readonly MaintenanceEndReason[] = ['expired', 'returned-to-normal', 'ended-by-owner', 'clock-stepped-back', 'over-limit', 'device-removed'];
const SEVS: readonly Severity[] = ['critical', 'warning', 'info'];
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const isSettingValue = (v: unknown): v is SettingValue => typeof v === 'string' || typeof v === 'boolean' || fin(v);

/** One record from disk, sanitized; null when it is not a window. */
function parseWindow(x: unknown): MaintenanceWindow | null {
  if (x == null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.sn !== 'string' || !SN_RE.test(o.sn) || !fin(o.startedAtMs) || !fin(o.untilMs)) return null;
  if (o.untilMs <= o.startedAtMs) return null;
  const held: MaintenanceHeld[] = [];
  for (const h of Array.isArray(o.held) ? o.held.slice(0, MAINT_HELD_CAP) : []) {
    const r = h as Record<string, unknown>;
    if (r == null || typeof r !== 'object' || typeof r.id !== 'string' || !fin(r.firstAtMs) || !fin(r.rises)) continue;
    held.push({
      id: r.id.slice(0, 256), title: str(r.title, 256) ?? r.id.slice(0, 256),
      severity: SEVS.includes(r.severity as Severity) ? (r.severity as Severity) : 'warning',
      firstAtMs: r.firstAtMs, rises: Math.max(1, Math.round(r.rises)), present: r.present === true,
    });
  }
  const settingsChanged: MaintenanceSettingChange[] = [];
  for (const s of Array.isArray(o.settingsChanged) ? o.settingsChanged.slice(0, MAINT_SETTINGS_CAP) : []) {
    const r = s as Record<string, unknown>;
    if (r == null || typeof r !== 'object' || typeof r.key !== 'string' || !isSettingValue(r.from) || !isSettingValue(r.to) || !fin(r.atMs)) continue;
    settingsChanged.push({ key: r.key.slice(0, 256), from: r.from, to: r.to, atMs: r.atMs });
  }
  return {
    sn: o.sn,
    label: cleanNote(o.label) ?? 'Core',
    coreNum: fin(o.coreNum) ? o.coreNum : null,
    startedAtMs: o.startedAtMs,
    untilMs: o.untilMs,
    ...(fin(o.endedAtMs) ? { endedAtMs: o.endedAtMs, endReason: REASONS.includes(o.endReason as MaintenanceEndReason) ? (o.endReason as MaintenanceEndReason) : 'expired' } : {}),
    source: SOURCES.includes(o.source as MaintenanceSource) ? (o.source as MaintenanceSource) : 'api',
    note: cleanNote(o.note),
    standingAtStart: Array.isArray(o.standingAtStart) ? o.standingAtStart.filter((s): s is string => typeof s === 'string').slice(0, 200) : [],
    abnormalSeenAtMs: fin(o.abnormalSeenAtMs) ? o.abnormalSeenAtMs : null,
    normalSinceMs: fin(o.normalSinceMs) ? o.normalSinceMs : null,
    held,
    heldDropped: fin(o.heldDropped) ? Math.max(0, Math.round(o.heldDropped)) : 0,
    settingsChanged,
    // Unknown is home: the start guard then refuses more, never less.
    homeAtStart: o.homeAtStart !== false,
    gapSeenAtMs: fin(o.gapSeenAtMs) ? o.gapSeenAtMs : null,
  };
}

/**
 * Read the windows. A missing file is no windows; an unreadable one is no windows and `corrupt`.
 * An open window whose span is over the limit loads ended 'over-limit', one that starts in the
 * future (the clock stepped back while the add-on was down) 'clock-stepped-back', and one whose
 * end passed while the add-on was down 'expired' — each in `endedAtBoot`, so its end push goes out.
 */
export function loadMaintenance(path: string, now: number): LoadResult {
  if (!existsSync(path)) return { windows: [], endedAtBoot: [], corrupt: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { windows: [], endedAtBoot: [], corrupt: true };
  }
  const list = (raw as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(list)) return { windows: [], endedAtBoot: [], corrupt: true };
  const windows: MaintenanceWindow[] = [];
  const endedAtBoot: MaintenanceWindow[] = [];
  for (const x of list) {
    const w = parseWindow(x);
    if (w == null) continue;
    if (w.endedAtMs != null) {
      // Retained as the step retains it (from the later of its end and the last absorbed gap seen).
      if (now - Math.max(w.endedAtMs, w.gapSeenAtMs ?? 0) <= MAINT_ENDED_KEEP_MS && w.endedAtMs <= now + MAINT_CLOCK_BACK_TOL_MS) windows.push(w);
      continue;
    }
    // At most one open window per Core: a second is a forged or corrupt record.
    const reason: MaintenanceEndReason | null = !withinLimit(w) ? 'over-limit'
      : w.startedAtMs > now + MAINT_CLOCK_BACK_TOL_MS ? 'clock-stepped-back'
        : now >= w.untilMs ? 'expired'
          : windows.some((o) => o.sn === w.sn && o.endedAtMs == null) ? 'over-limit'
            : null;
    if (reason == null) { windows.push(w); continue; }
    const e = endWindow(w, reason, reason === 'expired' ? w.untilMs : now);
    if (now - (e.endedAtMs ?? now) <= MAINT_ENDED_KEEP_MS) windows.push(e);
    endedAtBoot.push(e);
  }
  return { windows, endedAtBoot, corrupt: false };
}

/** Write the windows (atomic). THROWS on failure: the start path refuses on it. */
export function saveMaintenance(path: string, ws: readonly MaintenanceWindow[]): void {
  atomicWriteFileSync(path, JSON.stringify({ version: 1, windows: ws }));
}

/* ─── the pushes ─────────────────────────────────────────────────────────────────────────── */

/** What still sounds while a Core is shelved (the start push and the card's list). */
export const STILL_SOUNDS: readonly string[] = [
  'the reserve floor and near-reserve alarms',
  'the runway',
  'the battery-level ladder',
  'the reserve-alarm and telemetry blind alarms',
  'grid loss and every other plant-level alarm',
  "an overheating pack, a cell at the over-voltage line or a confirmed-defective pack on this Core",
];

const REASON_TEXT: Record<MaintenanceEndReason, string> = {
  'expired': 'its time is up',
  'returned-to-normal': `the Core has been back to normal for ${MAINT_RETURN_DWELL_MS / 60_000} minutes`,
  'ended-by-owner': 'it was ended by hand',
  'clock-stepped-back': 'the clock stepped back before its start',
  'over-limit': `its span was over the ${MAINT_MAX_MS / 3_600_000} h limit`,
  'device-removed': 'the Core is no longer on the account',
};

export function maintenanceDedupId(sn: string): string {
  return `maintenance_${sn}`;
}

/** The start (or extension) push. No serial in any text. PURE. */
export function renderStartPush(w: MaintenanceWindow, extended: boolean, fmtClock: (ms: number) => string): NotifyMessage {
  const until = fmtClock(w.untilMs);
  return {
    severity: 'warning',
    dedupId: maintenanceDedupId(w.sn),
    title: `Power · Maintenance: ${w.label} alarms ${extended ? 'shelved, now' : 'shelved'} until ${until}`,
    body: `${w.label}'s own alerts stay on screen but are neither pushed nor announced until ${until}`
      + ` (or once it has been back to normal for ${MAINT_RETURN_DWELL_MS / 60_000} minutes).${w.note ? ` Note: ${w.note}.` : ''}\n\n`
      + `Still sounds: ${STILL_SOUNDS.join('; ')}.\n\nWhatever is still active when the window ends is pushed and announced then.`,
  };
}

export interface EndSummary {
  /** The Core's own alerts still active at the end (they annunciate from the next tick); null when
   *  not known (a window found ended at start-up whose first alert check ran on an unhydrated map). */
  stillActive: Array<Pick<Alert, 'id' | 'title' | 'severity'>> | null;
}

/** The Core's own warning-or-above alerts in `alerts` (the end push's "still active"). */
export function stillActiveFor(w: MaintenanceWindow, alerts: readonly Alert[]): NonNullable<EndSummary['stillActive']> {
  return alerts
    .filter((a) => a.severity !== 'info' && alertNamesDevice(a, w.sn) && !isDeviceGapAlertId(a.id))
    .map((a) => ({ id: a.id, title: a.title, severity: a.severity }));
}

/** The end push: why it ended, everything it held, what is still active and the settings changed.
 *  'warning' when anything is still active, otherwise 'info'. No serial in any text. PURE. */
export function renderEndPush(w: MaintenanceWindow, s: EndSummary, fmtClock: (ms: number) => string): NotifyMessage {
  const crit = w.held.filter((h) => h.severity === 'critical').length;
  const heldLines = w.held.map((h) => `- ${h.title} (${h.severity}${h.rises > 1 ? `, ${h.rises} times` : ''}, first at ${fmtClock(h.firstAtMs)})`);
  if (w.heldDropped > 0) heldLines.push(`- and ${w.heldDropped} more`);
  const parts = [
    `${w.label}'s maintenance window (${fmtClock(w.startedAtMs)}–${fmtClock(w.endedAtMs ?? w.untilMs)}) ended: ${REASON_TEXT[w.endReason ?? 'expired']}.`,
    w.held.length + w.heldDropped === 0
      ? 'Nothing was held.'
      : `Held: ${w.held.length + w.heldDropped} alert${w.held.length + w.heldDropped === 1 ? '' : 's'}${crit > 0 ? ` (${crit} critical)` : ''}:\n${heldLines.join('\n')}`,
    s.stillActive == null
      ? 'It ended while the add-on was down, before the device data was in: whatever is still active is pushed and announced as an ordinary alert.'
      : s.stillActive.length === 0
        ? 'Nothing is still active.'
        : `Still active, and pushed and announced from now on:\n${s.stillActive.map((a) => `- ${a.title} (${a.severity})`).join('\n')}`,
  ];
  if (w.settingsChanged.length > 0) {
    parts.push(`Settings changed on this Core:\n${w.settingsChanged.map((c) => `- ${c.key}: ${String(c.from)} → ${String(c.to)}`).join('\n')}`);
  }
  const n = s.stillActive?.length ?? 0;
  return {
    // Unknown is not "nothing": the loud tier.
    severity: s.stillActive == null || n > 0 ? 'warning' : 'info',
    dedupId: maintenanceDedupId(w.sn),
    title: `Power · Maintenance over: ${w.label} alarms are live again${n > 0 ? ` (${n} still active)` : ''}`,
    body: parts.join('\n\n'),
  };
}

/* ─── the controller ─────────────────────────────────────────────────────────────────────── */

export interface MaintenanceAuditEntry {
  action: 'maintenance-start' | 'maintenance-extend' | 'maintenance-end';
  sn: string;
  params: Record<string, unknown>;
  source: { ip?: string; ua?: string };
}

export interface MaintenanceControllerDeps {
  path: string;
  now: () => number;
  /** The push channel. A failed send is logged; it never fails the start or the end. */
  send: (msg: NotifyMessage) => Promise<void>;
  log: { info(m: string): void; warn(m: string): void };
  /** The write log (appendWriteLog). */
  audit: (e: MaintenanceAuditEntry) => void;
  /** Site-local "HH:MM". */
  fmtClock: (ms: number) => string;
  /** Persists the windows (saveMaintenance; injectable for tests). Throws on failure. */
  save?: (path: string, ws: readonly MaintenanceWindow[]) => void;
  /** v1.197.0 (review) — removes the file when an end cannot be saved (injectable for tests). */
  remove?: (path: string) => void;
  /** v1.197.0 (review) — the return-to-normal dwell; tests only (production: MAINT_RETURN_DWELL_MS). */
  returnDwellMs?: number;
}

export interface StartInput {
  sn: string;
  minutes: unknown;
  note?: unknown;
  source: MaintenanceSource;
  devices: Readonly<Record<string, DeviceSnapshot>>;
  homePoolSns: ReadonlySet<string>;
  alerts: readonly Alert[];
  requester?: { ip?: string; ua?: string };
}

export type ControllerStartResult = StartResult | { ok: false; code: 500; error: string };

export interface MaintenanceController {
  /** Every retained window (open, and ended within MAINT_ENDED_KEEP_MS): the stamp's input. */
  windows(): readonly MaintenanceWindow[];
  /** The windows in force at `now`. */
  active(now: number): MaintenanceWindow[];
  start(req: StartInput): ControllerStartResult;
  /** End `sn`'s window by hand; false when none is open. */
  end(sn: string, source: MaintenanceSource, alerts: readonly Alert[], requester?: { ip?: string; ua?: string }): boolean;
  /** End every open window by hand; returns how many ended. */
  endAll(source: MaintenanceSource, alerts: readonly Alert[]): number;
  /** The alert tick, after the final publish: step every window and end what is due. */
  observe(alerts: readonly Alert[], devices: Readonly<Record<string, DeviceObs>> | null, now: number): MaintenanceWindow[];
  /** A confirmed settings change on a shelved Core (settings drift): listed in the end push. */
  noteSettingsChange(sn: string, c: SettingChange, atMs: number): void;
  /** v1.197.0 (review) — the boot seed's question (heldUnpushed): was `a` held, and so never pushed? */
  heldUnpushed(a: Pick<Alert, 'id' | 'severity' | 'category' | 'sourceSn' | 'shelvedUntilMs'>): boolean;
}

export function createMaintenanceController(deps: MaintenanceControllerDeps): MaintenanceController {
  const save = deps.save ?? saveMaintenance;
  const remove = deps.remove ?? ((path: string) => rmSync(path, { force: true }));
  const returnDwellMs = deps.returnDwellMs ?? MAINT_RETURN_DWELL_MS;
  const boot = loadMaintenance(deps.path, deps.now());
  let ws: MaintenanceWindow[] = boot.windows;
  let dirty = false;
  /** v1.197.0 (review) — an end is in memory but not on disk (persist failed after it). */
  let endUnsaved = false;
  if (boot.corrupt) deps.log.warn(`maintenance: ${deps.path} is unreadable — no Core is shelved (the loud direction)`);
  const open = ws.filter((w) => w.endedAtMs == null);
  if (open.length > 0) {
    deps.log.info(`maintenance: restored ${open.map((w) => `${w.label} until ${deps.fmtClock(w.untilMs)}`).join(', ')}`);
  }
  /** v1.197.0 (review) — the Cores whose window was found ended at start-up (heldUnpushed). */
  const bootEndedSns = new Set(boot.endedAtBoot.map((w) => w.sn));
  /** v1.197.0 (review) — their end pushes, owed on the first alert check (observe), when what is still
   *  active is known; saved then too, so a crash before it re-owes them rather than losing them. */
  let bootOwed: MaintenanceWindow[] = boot.endedAtBoot;
  if (bootOwed.length > 0) {
    dirty = true;
    deps.log.info(`maintenance: ${bootOwed.map((w) => `${w.label} (${w.endReason})`).join(', ')} ended while the add-on was down — the end push follows the first alert check`);
  }

  /**
   * Save the windows. `ending`: the list carries an end not yet on disk. v1.197.0 (review) — when such
   * a save fails, the file is REMOVED: it still holds the window open, and a restart would shelve the
   * Core again after its end push said its alarms are live. With no file a restart shelves nothing
   * (the loud direction); the next successful save (retried every tick) writes the file back.
   */
  const persist = (next: MaintenanceWindow[], ending = false): boolean => {
    if (ending) endUnsaved = true;
    try {
      save(deps.path, next);
      dirty = false;
      endUnsaved = false;
      return true;
    } catch (e: any) {
      dirty = true;
      deps.log.warn(`maintenance: could not save ${deps.path} (${e?.message ?? e})${endUnsaved ? ' — a window\'s end is not on disk' : ''}`);
      if (endUnsaved && existsSync(deps.path)) {
        try {
          remove(deps.path);
          deps.log.warn(`maintenance: removed ${deps.path} — an end that is not saved must not be undone by a restart; until a save succeeds, a restart shelves no Core`);
        } catch (e2: any) {
          deps.log.warn(`maintenance: could not remove ${deps.path} (${e2?.message ?? e2}) — a restart would restore an ended window until its own end`);
        }
      }
      return false;
    }
  };
  const push = (msg: NotifyMessage): void => {
    void deps.send(msg).then(
      () => deps.log.info(`maintenance: push sent "${msg.title}"`),
      (e: any) => deps.log.warn(`maintenance: push failed "${msg.title}" (${e?.message ?? e})`),
    );
  };
  const onEnded = (w: MaintenanceWindow, alerts: readonly Alert[] | null, source: { ip?: string; ua?: string } = {}): void => {
    const stillActive = alerts == null ? null : stillActiveFor(w, alerts);
    const crit = w.held.filter((h) => h.severity === 'critical').length;
    deps.audit({
      action: 'maintenance-end', sn: w.sn, source,
      params: {
        reason: w.endReason, startedAtMs: w.startedAtMs, untilMs: w.untilMs, endedAtMs: w.endedAtMs,
        held: w.held.length + w.heldDropped, heldCritical: crit, stillActive: stillActive?.length ?? null,
        settingsChanged: w.settingsChanged.length,
      },
    });
    deps.log.warn(`maintenance: ${w.label} window ended (${w.endReason}) — held ${w.held.length + w.heldDropped} alert(s), ${crit} critical; `
      + (stillActive == null ? 'what is still active annunciates as an ordinary alert' : `${stillActive.length} still active and annunciating from the next tick`));
    push(renderEndPush(w, { stillActive }, deps.fmtClock));
  };

  /**
   * v1.197.0 (review) — end every open window lapsed since the last step (lapseReason), with its end
   * push, before acting on the list. Without it, a start in the seconds between a window's end and the
   * next tick appended a second open window for the Core, and End now ended the stale one while the
   * new one went on holding. Returns the windows it ended.
   */
  const settleLapsed = (now: number, alerts: readonly Alert[] | null): MaintenanceWindow[] => {
    const ended: MaintenanceWindow[] = [];
    const next = ws.map((w) => {
      if (w.endedAtMs != null) return w;
      const reason = lapseReason(w, now);
      if (reason == null) return w;
      const e = endWindow(w, reason, now);
      ended.push(e);
      return e;
    });
    if (ended.length === 0) return ended;
    ws = next;
    persist(ws, true);
    for (const e of ended) onEnded(e, alerts);
    return ended;
  };

  const endOpen = (sn: string, reason: MaintenanceEndReason, now: number): MaintenanceWindow | null => {
    const i = ws.findIndex((w) => w.sn === sn && w.endedAtMs == null);
    if (i < 0) return null;
    const e = endWindow(ws[i], reason, now);
    const next = [...ws];
    next[i] = e;
    ws = next;
    // Ending is the loud direction: it takes effect in memory even when the save fails (retried
    // on the next tick; the file is removed meanwhile — persist).
    persist(ws, true);
    return e;
  };

  const end = (sn: string, source: MaintenanceSource, alerts: readonly Alert[], requester?: { ip?: string; ua?: string }): boolean => {
    const now = deps.now();
    // A window that lapsed since the last step is over already: ended (and pushed) as the step would.
    if (settleLapsed(now, alerts).some((e) => e.sn === sn)) return true;
    const e = endOpen(sn, 'ended-by-owner', now);
    if (!e) return false;
    deps.log.info(`maintenance: ${e.label} ended by hand (${source})`);
    onEnded(e, alerts, requester);
    return true;
  };

  return {
    windows: () => ws,
    active: (now) => ws.filter((w) => windowInForce(w, now)),
    start(req) {
      const now = deps.now();
      settleLapsed(now, req.alerts);
      const minutes = typeof req.minutes === 'number' ? req.minutes : typeof req.minutes === 'string' && req.minutes.trim() !== '' ? Number(req.minutes) : NaN;
      const r = validateStart({
        sn: req.sn, durationMs: minutes * 60_000, note: req.note, nowMs: now, source: req.source,
        devices: req.devices, windows: ws, homePoolSns: req.homePoolSns, alerts: req.alerts,
      });
      if (!r.ok) return r;
      // An extension replaces its own window (the one in force, by its start), never another.
      const next = r.extended
        ? ws.map((w) => (w.sn === r.window.sn && w.startedAtMs === r.window.startedAtMs && w.endedAtMs == null ? r.window : w))
        : [...ws, r.window];
      // Saved BEFORE it is in force: a window that is not on disk would not survive a restart.
      try {
        save(deps.path, next);
      } catch (e: any) {
        deps.log.warn(`maintenance: ${r.window.label} NOT shelved — could not save ${deps.path} (${e?.message ?? e})`);
        return { ok: false, code: 500, error: 'could not save the window; nothing is shelved' };
      }
      ws = next;
      dirty = false;
      endUnsaved = false;
      const w = r.window;
      deps.audit({
        action: r.extended ? 'maintenance-extend' : 'maintenance-start', sn: w.sn, source: req.requester ?? {},
        params: { startedAtMs: w.startedAtMs, untilMs: w.untilMs, minutes, note: w.note, source: w.source },
      });
      deps.log.warn(`maintenance: ${w.label} ${r.extended ? 'extended' : 'shelved'} until ${deps.fmtClock(w.untilMs)} (${w.source}) — `
        + 'its own alerts on screen only; pool and plant alarms unaffected');
      push(renderStartPush(w, r.extended, deps.fmtClock));
      return r;
    },
    end,
    endAll(source, alerts) {
      let n = settleLapsed(deps.now(), alerts).length;
      for (const sn of ws.filter((w) => w.endedAtMs == null).map((w) => w.sn)) if (end(sn, source, alerts)) n++;
      return n;
    },
    observe(alerts, devices, now) {
      const r = stepMaintenance(ws, { alerts, devices }, now, returnDwellMs);
      // v1.197.0 (review) — the end pushes of windows found ended at start-up, on the first alert check:
      // what is still active is read from this set (unknown on an unhydrated map).
      const owed = bootOwed;
      bootOwed = [];
      if (r.changed || dirty) {
        ws = r.windows;
        persist(ws, r.ended.length > 0 || owed.length > 0);
      }
      for (const e of owed) onEnded(e, devices != null ? alerts : null);
      for (const e of r.ended) onEnded(e, alerts);
      return r.ended;
    },
    noteSettingsChange(sn, c, atMs) {
      const i = ws.findIndex((w) => w.sn === sn && windowInForce(w, atMs));
      if (i < 0) return;
      const w = ws[i];
      if (w.settingsChanged.length >= MAINT_SETTINGS_CAP) return;
      const next = [...ws];
      next[i] = { ...w, settingsChanged: [...w.settingsChanged, { key: c.key, from: c.from, to: c.to, atMs }] };
      ws = next;
      persist(ws);
    },
    heldUnpushed: (a) => heldUnpushed(a, ws, bootEndedSns),
  };
}
