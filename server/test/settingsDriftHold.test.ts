import './helpers/siteZoneIsHostZone.js'; // v1.191.0 — fixtures on the host clock: the site zone is the host's (first import)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractSettingsSurface, evaluateDrift, freshDriftState, loadConfirmedSurface, saveConfirmedSurface,
  type ActuatorContext, type SettingValue, type SurfaceDevice,
} from '../src/settingsDrift.js';
import {
  DriftHoldQueue, driftHeldPath, driftNotification, settleDriftTick,
  type DriftHoldOptions, type DriftPushMessage, type DriftTickOutcome, type HeldDriftChange,
} from '../src/settingsDriftHold.js';
import { atomicWriteFileSync } from '../src/atomicWrite.js';
import { parseQuietHours, inQuietWindow } from '../src/alertMonitor.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.20 — a settings-drift push held for the notify quiet window survives a
 * restart (settingsDriftHold.ts).
 *
 * 2026-10-10 23:02: "Smart Home Panel 2 · smartBackupMode 0 → 2" was confirmed
 * inside quiet hours (22-06) and held in an in-memory array; the same tick saved
 * the new value as the baseline. The 23:25 deploy restart dropped the array, the
 * baseline already held 2, and the 06:00 morning found nothing to say. These
 * tests re-enact that night against the real baseline persistence, the real
 * 2-observation debounce, the real quiet-window predicate and the tick's own
 * post-evaluate step (settleDriftTick — the code index.ts runs).
 * ═════════════════════════════════════════════════════════════════════════ */

const ROOT = mkdtempSync(join(tmpdir(), 'drift-hold-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = (): string => {
  const d = join(ROOT, `case-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const QUIET = parseQuietHours('22-06')!;
/** index.ts's predicate: `DRIFT_QUIET != null && inNotifyQuiet(now, DRIFT_QUIET)`. */
const isQuiet = (now: Date) => QUIET != null && inQuietWindow(now, QUIET);
/** Host-clock wall times on the night of 2026-10-10 → 10-11. inQuietWindow reads the site hour (siteHour),
 *  which this file sets to the host's zone (siteZoneIsHostZone, the first import). */
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
/** Epoch ms, minutes after 23:00 on 10-10. */
const T = (min: number) => at(10, 23, min).getTime();
/** A queue with test defaults; its construction-time clock is fixed (the 7-day expiry must not
 *  depend on the day the suite runs). */
const mk = (o: Partial<DriftHoldOptions> & { path: string }): DriftHoldQueue => new DriftHoldQueue({
  isQuiet: () => true, send: async () => {}, log: { info: () => {}, warn: () => {} }, nowMs: () => T(0), ...o,
});

const shp2 = (over: Record<string, unknown> = {}): SurfaceDevice => ({
  sn: 'SHP2-FIXTURE', label: 'Smart Home Panel 2', kind: 'shp2',
  raw: {
    ch1ForceCharge: 'FORCE_CHARGE_OFF', ch2ForceCharge: 'FORCE_CHARGE_OFF',
    ch3ForceCharge: 'FORCE_CHARGE_OFF', smartBackupMode: 0, backupReserveSoc: 20,
    chargeWattPower: 5600, foceChargeHight: 100, stormIsEnable: false,
    epsModeInfo: false, masterCur: 100, oilMaxOutputWatt: 3000,
    ...over,
  },
});
const MODE = 'Smart Home Panel 2 · smartBackupMode';
const FLOOR = 'Smart Home Panel 2 · backupReserveSoc';
const SLOT1 = 'Smart Home Panel 2 · ch1ForceCharge';
const SLOT2 = 'Smart Home Panel 2 · ch2ForceCharge';

/** No night in flight, no owner write, no force-charge: every change is external. */
const NO_OWN_WRITE: ActuatorContext = {
  targetPct: null, priorReservePct: null, nightActive: false, ownerFloorPct: null,
  forceChargeActive: false, forceChargeCommands: null,
};

interface Harness {
  queue: DriftHoldQueue;
  sends: DriftPushMessage[];
  logs: string[];
  /** One drift tick, as index.ts's runSettingsDriftTick runs it: evaluateDrift, then the SAME
   *  settleDriftTick. `context` is what index.ts's driftActuatorContext would return. */
  tick: (now: Date, surface: SurfaceDevice[], context?: ActuatorContext) => Promise<DriftTickOutcome>;
  state: ReturnType<typeof freshDriftState>;
}

/**
 * A process boot, as index.ts's module load does it: the baseline loaded from disk
 * (loadConfirmedSurface) and the held queue built (which rehydrates it), then ticks. `send`
 * defaults to a working channel.
 */
function boot(
  dir: string, send?: (m: DriftPushMessage) => Promise<unknown>, heldPath?: string,
  saveBaseline?: (surface: Record<string, SettingValue>) => void,
): Harness {
  process.env.SETTINGS_DRIFT_STATE_PATH = join(dir, 'settings-surface.json');
  if (heldPath != null) process.env.SETTINGS_DRIFT_HELD_PATH = heldPath;
  else delete process.env.SETTINGS_DRIFT_HELD_PATH;
  const sends: DriftPushMessage[] = [];
  const logs: string[] = [];
  const state = freshDriftState();
  state.confirmed = loadConfirmedSurface();
  const queue = new DriftHoldQueue({
    path: driftHeldPath(),
    isQuiet,
    send: send ?? (async (m) => { sends.push(m); }),
    log: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`) },
    nowMs: () => at(10, 18).getTime(),
  });
  const log = { info: (m: string) => logs.push(`INFO ${m}`), warn: (m: string) => logs.push(`WARN ${m}`) };
  const tick = (now: Date, surface: SurfaceDevice[], context: ActuatorContext = NO_OWN_WRITE): Promise<DriftTickOutcome> =>
    settleDriftTick({
      queue, state, evaluation: evaluateDrift(state, extractSettingsSurface(surface)), now,
      context: () => context, log, saveBaseline,
    });
  return { queue, sends, logs, tick, state };
}

const readHeld = (dir: string): HeldDriftChange[] =>
  JSON.parse(readFileSync(join(dir, 'settings-drift-held.json'), 'utf8')).held;

test('★★★ THE 10-10 NIGHT: external change at 23:00 → restart at 23:30 → exactly ONE push at 06:00, with the change', async () => {
  const dir = freshDir();
  // Evening: the baseline is adopted (mode 0).
  const p1 = boot(dir);
  assert.equal(await p1.tick(at(10, 18), [shp2()]), 'adopted');
  assert.equal(loadConfirmedSurface()![MODE], 0, 'the adoption tick saves the first baseline');
  // 23:00 — the vendor app moves the mode 0 → 2; confirmed on the second observation, in quiet hours.
  assert.equal(await p1.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]), 'empty', 'first sighting is a transient');
  assert.equal(await p1.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(p1.sends.length, 0, 'quiet hours: nothing pushed at 23:01');
  // The baseline on disk already holds the NEW value — exactly the trap: nothing can re-detect it.
  assert.equal(loadConfirmedSurface()![MODE], 2);
  assert.ok(!p1.logs.some((l) => l.includes('deferred baseline saved')), 'a save that lands at its own commit is no recovery');

  // 23:30 — the deploy restart. p1 (and its memory) is gone.
  const p2 = boot(dir);
  assert.deepEqual(p2.queue.held().map((e) => [e.key, e.from, e.to]), [[MODE, 0, 2]], 'rehydrated at construction');
  assert.ok(p2.logs.some((l) => l.includes('rehydrated 1 held change(s)')));
  assert.equal(await p2.tick(at(10, 23, 30), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(await p2.tick(at(11, 3, 0), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(await p2.tick(at(11, 5, 59), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(p2.sends.length, 0, 'still quiet at 05:59');

  // 06:00 — the window ends: one push, naming the change.
  assert.equal(await p2.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2 })]), 'sent');
  assert.equal(p2.sends.length, 1);
  assert.equal(p2.sends[0].dedupId, 'settings_drift');
  assert.equal(p2.sends[0].title, `Setting changed: ${MODE}`);
  assert.ok(p2.sends[0].body.includes(`${MODE}: 0 → 2`), p2.sends[0].body);
  assert.ok(p2.logs.some((l) => l.startsWith('INFO settings-drift: push sent — Setting changed:')));
  // ...and never again: not on later ticks, not after another restart.
  assert.equal(await p2.tick(at(11, 6, 1), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.equal(await p2.tick(at(11, 7, 0), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.deepEqual(readHeld(dir), [], 'the sidecar is cleared once the push resolved');
  const p3 = boot(dir);
  assert.equal(await p3.tick(at(11, 6, 5), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.equal(p2.sends.length + p3.sends.length, 1, 'exactly one push in total');
});

test('the sidecar lives beside settings-surface.json (one directory, one filesystem: the atomic rename holds)', () => {
  const dir = freshDir();
  process.env.SETTINGS_DRIFT_STATE_PATH = join(dir, 'settings-surface.json');
  delete process.env.SETTINGS_DRIFT_HELD_PATH;
  assert.equal(driftHeldPath(), join(dir, 'settings-drift-held.json'));
});

test('outside quiet hours the push goes out on the tick that confirms it (unchanged), and only once', async () => {
  const dir = freshDir();
  const p = boot(dir);
  await p.tick(at(10, 14, 0), [shp2()]);
  await p.tick(at(10, 14, 1), [shp2({ smartBackupMode: 1 })]);
  assert.equal(await p.tick(at(10, 14, 2), [shp2({ smartBackupMode: 1 })]), 'sent');
  assert.equal(await p.tick(at(10, 14, 3), [shp2({ smartBackupMode: 1 })]), 'empty');
  assert.equal(p.sends.length, 1);
});

test('★★★ a FAILED push keeps the change — on disk and in memory — and the next tick (or the next boot) delivers it', async () => {
  const dir = freshDir();
  let fail = true;
  const sends: DriftPushMessage[] = [];
  const send = async (m: DriftPushMessage) => {
    if (fail) throw new Error('HA persistent_notification.create returned HTTP 502');
    sends.push(m);
  };
  const p1 = boot(dir, send);
  await p1.tick(at(10, 18), [shp2()]);
  await p1.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]);
  await p1.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p1.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2 })]), 'failed');
  assert.ok(p1.logs.some((l) => l.startsWith('WARN settings-drift: push failed (HA persistent_notification.create returned HTTP 502)')));
  assert.deepEqual(readHeld(dir).map((e) => [e.key, e.from, e.to]), [[MODE, 0, 2]], 'a failed push must not clear the sidecar');
  assert.equal(p1.queue.held().length, 1, 'nor the memory');
  // A restart before the retry (the case that lost it before): the next boot delivers it.
  fail = false;
  const p2 = boot(dir, send);
  assert.equal(await p2.tick(at(11, 6, 1), [shp2({ smartBackupMode: 2 })]), 'sent');
  assert.equal(sends.length, 1);
  assert.ok(sends[0].body.includes(`${MODE}: 0 → 2`));
  assert.equal(await p2.tick(at(11, 6, 2), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.equal(sends.length, 1);
});

test('a failed push retries on the next tick in the same process', async () => {
  const dir = freshDir();
  let calls = 0;
  const q = mk({
    path: join(dir, 'held.json'), isQuiet: () => false,
    send: async () => { if (++calls === 1) throw new Error('timeout'); },
    log: { info: () => {}, warn: () => {} },
  });
  q.hold([{ key: MODE, from: 0, to: 2 }], at(10, 9).getTime());
  assert.equal(await q.flush(at(10, 9, 0)), 'failed');
  assert.equal(await q.flush(at(10, 9, 1)), 'sent');
  assert.equal(await q.flush(at(10, 9, 2)), 'empty');
  assert.equal(calls, 2);
});

test('★★ repeated changes of one key COLLAPSE into one entry: first unannounced from, latest to, a count', async () => {
  const dir = freshDir();
  const p = boot(dir);
  await p.tick(at(10, 18), [shp2()]);
  for (const [h, v] of [[23, 2], [1, 1], [2, 2]] as const) {
    const day = h >= 22 ? 10 : 11;
    await p.tick(at(day, h, 0), [shp2({ smartBackupMode: v })]);
    await p.tick(at(day, h, 1), [shp2({ smartBackupMode: v })]);
  }
  const held = p.queue.held();
  assert.equal(held.length, 1, 'one entry per key — the sidecar cannot grow with flapping');
  assert.deepEqual([held[0].key, held[0].from, held[0].to, held[0].changes], [MODE, 0, 2, 3]);
  assert.equal(readHeld(dir).length, 1);
  await p.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(p.sends.length, 1);
  assert.ok(p.sends[0].body.includes(`${MODE}: 0 → 2 (3 changes while held)`), p.sends[0].body);
});

test('a change and its revert while held still announce (never silently dropped)', () => {
  const q = mk({
    path: join(freshDir(), 'held.json'), isQuiet: () => true, send: async () => {}, log: { info: () => {}, warn: () => {} },
  });
  q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
  q.hold([{ key: MODE, from: 2, to: 0 }], T(2));
  const [e] = q.held();
  assert.deepEqual([e.from, e.to, e.changes], [0, 0, 2]);
  assert.ok(driftNotification(q.held()).body.includes(`${MODE}: 0 → 0 (changed 2 times while held, back to where it started)`));
});

test('the SAME movement confirmed again (a restart between the sidecar write and the baseline save) is not a second change', () => {
  const dir = freshDir();
  const q = mk({
    path: join(dir, 'held.json'), isQuiet: () => true, send: async () => {}, log: { info: () => {}, warn: () => {} },
  });
  q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
  q.hold([{ key: MODE, from: 0, to: 2 }], T(2));
  assert.deepEqual(q.held().map((e) => [e.from, e.to, e.changes, e.lastAtMs]), [[0, 2, 1, T(1)]]);
});

test('★★★ ORDER: the held change is on disk BEFORE the baseline is saved — a crash inside the baseline save loses nothing', () => {
  const dir = freshDir();
  const path = join(dir, 'held.json');
  const q = mk({ path });
  // The save throws (a crash mid-save, simulated): commit does not throw into the tick, and reports it unsaved.
  assert.equal(q.commit([{ key: MODE, from: 0, to: 2 }], T(1), () => { throw new Error('power cut mid-save'); }), false);
  const reboot = mk({ path });
  assert.deepEqual(reboot.held().map((e) => [e.key, e.from, e.to]), [[MODE, 0, 2]]);
});

test('★★ a held change that could NOT reach disk keeps the OLD baseline on disk — a restart re-detects it instead of losing it', async () => {
  const dir = freshDir();
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, 'x'); // a FILE where the sidecar's directory should be: every sidecar write fails
  const p1 = boot(dir, undefined, join(blocker, 'settings-drift-held.json'));
  await p1.tick(at(10, 18), [shp2()]);
  await p1.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p1.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held', 'still held in memory for the push');
  assert.ok(p1.logs.some((l) => l.startsWith('WARN settings-drift: could not write')));
  assert.ok(p1.logs.some((l) => l.startsWith('WARN settings-drift: baseline NOT saved')));
  assert.equal(loadConfirmedSurface()![MODE], 0, 'the baseline must not run ahead of the record of the change it hides');
  // A later commit with no new external change retries the sidecar write before any baseline save.
  let saved = 0;
  assert.equal(p1.queue.commit([], T(5), () => { saved++; }), false);
  assert.equal(saved, 0);
  // Restart (the sidecar writable again): the old baseline lets the change be re-detected and pushed.
  const p2 = boot(dir);
  assert.deepEqual(p2.queue.held(), []);
  await p2.tick(at(10, 23, 30), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p2.tick(at(10, 23, 31), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(loadConfirmedSurface()![MODE], 2, 'now on disk, so the baseline follows');
  assert.equal(await p2.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2 })]), 'sent');
  assert.ok(p2.sends[0].body.includes(`${MODE}: 0 → 2`));
});

test('★★ a CORRUPT sidecar is logged and ignored — boot never throws — and the next hold rewrites it', () => {
  const cases: Array<[string, string]> = [
    ['{not json', 'is corrupt'],
    ['[]', 'has no held list'],
    ['null', 'has no held list'],
    ['{"v":1,"held":5}', 'has no held list'],
  ];
  for (const [text, why] of cases) {
    const path = join(freshDir(), 'held.json');
    const logs: string[] = [];
    writeFileSync(path, text);
    let q!: DriftHoldQueue;
    assert.doesNotThrow(() => {
      q = mk({ path, log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) } });
    }, text);
    assert.deepEqual(q.held(), [], text);
    assert.ok(logs.some((l) => l.startsWith('WARN') && l.includes(why) && l.includes('ignored')), `${text}: ${logs.join(' | ')}`);
    q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).held.map((e: HeldDriftChange) => e.key), [MODE]);
  }
});

test('malformed entries are skipped (counted in the log); the valid ones survive', () => {
  const path = join(freshDir(), 'held.json');
  const now = at(10, 23).getTime();
  writeFileSync(path, JSON.stringify({ v: 1, held: [
    { key: MODE, from: 0, to: 2, changes: 1, firstAtMs: now, lastAtMs: now },
    { key: FLOOR, from: { x: 1 }, to: 40, lastAtMs: now },
    'garbage',
    { key: MODE, from: 5, to: 6, lastAtMs: now }, // duplicate key
  ] }));
  const logs: string[] = [];
  const q = mk({ path, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, nowMs: () => now });
  assert.deepEqual(q.held().map((e) => [e.key, e.from, e.to]), [[MODE, 0, 2]]);
  assert.ok(logs.some((l) => l.includes('skipped 3 malformed held-change entries')), logs.join(' | '));
});

test('★ BOUNDED: an entry untouched for over 7 days is dropped at boot with a log line, and the sidecar rewritten', () => {
  const path = join(freshDir(), 'held.json');
  const now = at(10, 23).getTime();
  const old = now - 8 * 86_400_000;
  writeFileSync(path, JSON.stringify({ v: 1, held: [
    { key: FLOOR, from: 20, to: 40, changes: 1, firstAtMs: old, lastAtMs: old },
    { key: MODE, from: 0, to: 2, changes: 1, firstAtMs: now - 60_000, lastAtMs: now - 60_000 },
  ] }));
  const logs: string[] = [];
  const q = mk({ path, log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) }, nowMs: () => now });
  assert.deepEqual(q.held().map((e) => e.key), [MODE]);
  assert.ok(logs.some((l) => l.startsWith('WARN settings-drift: dropped 1 held change(s) never pushed in 168 h') && l.includes(`${FLOOR} 20 → 40`)), logs.join(' | '));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).held.map((e: HeldDriftChange) => e.key), [MODE]);
});

test('★ BOUNDED: beyond the cap the least recently changed keys are dropped, with a log line', () => {
  const logs: string[] = [];
  const q = mk({
    path: join(freshDir(), 'held.json'), isQuiet: () => true, send: async () => {}, maxEntries: 3,
    log: { info: () => {}, warn: (m) => logs.push(m) },
  });
  for (let i = 0; i < 5; i++) q.hold([{ key: `Core ${i} · sysBackupSoc`, from: 10, to: 20 + i }], T(1) + i);
  assert.deepEqual(q.held().map((e) => e.key), ['Core 2 · sysBackupSoc', 'Core 3 · sysBackupSoc', 'Core 4 · sysBackupSoc']);
  assert.ok(logs.some((l) => l.includes('over the cap of 3') && l.includes('Core 0 · sysBackupSoc 10 → 20')), logs.join(' | '));
});

test('★★ readiness across the await: one send in flight at a time; a change arriving mid-send stays held, rebased', { timeout: 10_000 }, async () => {
  const dir = freshDir();
  const waiting: Array<() => void> = [];
  const release = () => { for (const r of waiting.splice(0)) r(); };
  const sends: DriftPushMessage[] = [];
  const q = mk({
    path: join(dir, 'held.json'), isQuiet: () => false,
    send: (m) => { sends.push(m); return new Promise<void>((r) => { waiting.push(r); }); },
    log: { info: () => {}, warn: () => {} },
  });
  q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
  const first = q.flush(at(11, 6, 0));
  // Raced against a short timer: a second send would leave this flush pending (never a hang).
  const pendingTooLong = new Promise<string>((r) => { setTimeout(() => r('second flush still pending'), 250); });
  assert.equal(await Promise.race([q.flush(at(11, 6, 1)), pendingTooLong]), 'in-flight', 'no second send while the first is unresolved');
  assert.equal(sends.length, 1);
  q.hold([{ key: MODE, from: 2, to: 1 }], T(2)); // moved again while the push was on the wire
  release();
  assert.equal(await first, 'sent');
  assert.deepEqual(q.held().map((e) => [e.key, e.from, e.to, e.changes]), [[MODE, 2, 1, 1]],
    'what was announced (0 → 2) is gone; the unannounced 2 → 1 remains');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'held.json'), 'utf8')).held.map((e: HeldDriftChange) => e.to), [1]);
  const second = q.flush(at(11, 6, 2));
  release();
  assert.equal(await second, 'sent');
  assert.equal(sends.length, 2);
  assert.ok(sends[1].body.includes(`${MODE}: 2 → 1`), sends[1].body);
});

test('★★ a HUNG send blocks the next attempt only until its deadline; its late resolution never releases the newer guard', { timeout: 10_000 }, async () => {
  const dir = freshDir();
  const waiting: Array<() => void> = [];
  const sends: DriftPushMessage[] = [];
  const logs: string[] = [];
  const q = mk({
    path: join(dir, 'held.json'), isQuiet: () => false, sendDeadlineMs: 10 * 60_000,
    send: (m) => { sends.push(m); return new Promise<void>((r) => { waiting.push(r); }); },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const race = (p: Promise<string>) =>
    Promise.race([p, new Promise<string>((r) => { setTimeout(() => r('still pending'), 250); })]);
  q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
  const first = q.flush(at(11, 6, 0)); // never resolves on its own
  assert.equal(await race(q.flush(at(11, 6, 9))), 'in-flight', '9 min: inside the deadline, still guarded');
  assert.equal(sends.length, 1);
  const second = q.flush(at(11, 6, 11)); // 11 min: past the deadline — sent again
  assert.equal(sends.length, 2, 'a hung send must not hold every later push');
  assert.ok(logs.some((l) => l.includes('never resolved — sending again')), logs.join(' | '));
  waiting[0](); // the hung first send resolves late
  assert.equal(await first, 'sent');
  q.hold([{ key: MODE, from: 2, to: 1 }], T(2));
  assert.equal(await race(q.flush(at(11, 6, 12))), 'in-flight', "the first send's late finish must not release the second's guard");
  assert.equal(sends.length, 2);
  waiting[1]();
  assert.equal(await second, 'sent');
  assert.deepEqual(q.held().map((e) => [e.key, e.from, e.to]), [[MODE, 2, 1]], 'the 2 → 1 that arrived later is still held');
});

test('the "held" line logs once per held state, not every tick', async () => {
  const logs: string[] = [];
  const q = mk({
    path: join(freshDir(), 'held.json'), isQuiet: () => true, send: async () => {},
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
  await q.flush(at(10, 23, 0));
  await q.flush(at(10, 23, 1));
  await q.flush(at(10, 23, 2));
  assert.equal(logs.filter((l) => l.includes('held for the notify quiet window')).length, 1);
  q.hold([{ key: FLOOR, from: 20, to: 40 }], T(2));
  await q.flush(at(10, 23, 3));
  assert.equal(logs.filter((l) => l.includes('held for the notify quiet window')).length, 2, 'a new held change logs again');
});

test('★★ v1.119.0 preserved: a held reserve-floor change keeps its own dedupId and names the floor', () => {
  const floor: HeldDriftChange = { key: FLOOR, from: 20, to: 40, changes: 1, firstAtMs: 1, lastAtMs: 1 };
  const mode: HeldDriftChange = { key: MODE, from: 0, to: 2, changes: 1, firstAtMs: 1, lastAtMs: 1 };
  const m = driftNotification([mode, floor]);
  assert.equal(m.dedupId, 'settings_drift_reserve_floor');
  assert.equal(m.severity, 'warning');
  assert.equal(m.title, 'Reserve floor changed externally: 20% → 40%');
  assert.ok(m.body.includes('This is the floor the backup-pool alarm defends'));
  assert.ok(m.body.includes(`${MODE}: 0 → 2`));
  const plain = driftNotification([mode]);
  assert.deepEqual([plain.dedupId, plain.title], ['settings_drift', `Setting changed: ${MODE}`]);
  const back = driftNotification([{ ...floor, to: 20, changes: 2 }]);
  assert.equal(back.title, 'Reserve floor changed externally and back to 20%');
});

test('★★ a Storm Guard floor raise at 01:00 survives a 02:00 restart and is pushed at 06:00 under its own dedupId', async () => {
  const dir = freshDir();
  const p1 = boot(dir);
  await p1.tick(at(10, 18), [shp2()]);
  await p1.tick(at(11, 1, 0), [shp2({ backupReserveSoc: 40 })]);
  assert.equal(await p1.tick(at(11, 1, 1), [shp2({ backupReserveSoc: 40 })]), 'held');
  const p2 = boot(dir);
  assert.equal(await p2.tick(at(11, 6, 0), [shp2({ backupReserveSoc: 40 })]), 'sent');
  assert.equal(p2.sends.length, 1);
  assert.equal(p2.sends[0].dedupId, 'settings_drift_reserve_floor');
  assert.equal(p2.sends[0].title, 'Reserve floor changed externally: 20% → 40%');
});

/* ══ the tick's post-evaluate step: classify → commit → flush (settleDriftTick) ══ */

test('★★★ CLASSIFY → COMMIT: in one tick an external change is held and the owner\'s own write is not; the baseline takes both', async () => {
  const dir = freshDir();
  const p = boot(dir);
  await p.tick(at(10, 14), [shp2()]);
  // The owner set the floor 20 → 30 through /api/reserve-floor (index.ts: ownerFloorWrite), and the
  // vendor app moved the mode 0 → 2: both confirmed on the same tick, inside quiet hours.
  const owner: ActuatorContext = { ...NO_OWN_WRITE, ownerFloorPct: 30 };
  const both = [shp2({ smartBackupMode: 2, backupReserveSoc: 30 })];
  await p.tick(at(10, 23, 0), both, owner);
  assert.equal(await p.tick(at(10, 23, 1), both, owner), 'held');
  assert.deepEqual(p.queue.held().map((e) => [e.key, e.from, e.to]), [[MODE, 0, 2]], 'only the external change is held');
  assert.deepEqual(readHeld(dir).map((e) => e.key), [MODE]);
  assert.ok(p.logs.includes(`WARN settings-drift: EXTERNAL change — ${MODE} 0 → 2`), p.logs.join(' | '));
  assert.ok(p.logs.includes(`INFO settings-drift: ${FLOOR} 20 → 30 (this add-on's night-charge write — not announced)`), p.logs.join(' | '));
  const base = loadConfirmedSurface()!;
  assert.deepEqual([base[MODE], base[FLOOR]], [2, 30], 'the baseline is saved once the held change is on disk');
  assert.equal(await p.tick(at(11, 6, 0), both), 'sent');
  assert.equal(p.sends.length, 1);
  assert.equal(p.sends[0].dedupId, 'settings_drift', "the owner's own floor write is not announced");
  assert.ok(!p.sends[0].body.includes(FLOOR), p.sends[0].body);
});

test('★★★ an ALL-own-write tick still saves the baseline — a restart does not push the owner\'s own floor write as external', async () => {
  const dir = freshDir();
  const p1 = boot(dir);
  await p1.tick(at(10, 14), [shp2()]);
  const owner: ActuatorContext = { ...NO_OWN_WRITE, ownerFloorPct: 30 };
  await p1.tick(at(10, 14, 1), [shp2({ backupReserveSoc: 30 })], owner);
  assert.equal(await p1.tick(at(10, 14, 2), [shp2({ backupReserveSoc: 30 })], owner), 'empty');
  assert.deepEqual(p1.queue.held(), []);
  assert.equal(loadConfirmedSurface()![FLOOR], 30, 'nothing was held, and the baseline is saved anyway');
  // The deploy restart: index.ts's owner-write memory is gone, so the same movement would now be external.
  const p2 = boot(dir);
  for (let m = 3; m < 8; m++) assert.equal(await p2.tick(at(10, 14, m), [shp2({ backupReserveSoc: 30 })]), 'empty');
  assert.equal(p1.sends.length + p2.sends.length, 0, 'no "Reserve floor changed externally: 20% → 30%" for our own write');
});

test('★★★ FLUSH ON EVERY TICK: a held change goes out on a morning tick that confirms nothing (only a first sighting)', async () => {
  const dir = freshDir();
  const p = boot(dir);
  await p.tick(at(10, 18), [shp2()]);
  await p.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held');
  // 06:00 — another key is seen changed for the FIRST time (not confirmed yet): this tick confirms nothing.
  assert.equal(await p.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2, chargeWattPower: 3000 })]), 'sent');
  assert.equal(p.sends.length, 1);
  assert.ok(p.sends[0].body.includes(`${MODE}: 0 → 2`), p.sends[0].body);
});

test('★★ inside our force-charge: a slot the panel turned OFF is logged panel-side and our own OFF is own-write — neither is held', async () => {
  const dir = freshDir();
  const p = boot(dir);
  const on = { ch1ForceCharge: 'FORCE_CHARGE_ON', ch2ForceCharge: 'FORCE_CHARGE_ON' };
  await p.tick(at(11, 4, 0), [shp2(on)]);
  // 04:24 — the panel's ceiling stop turns slot 2 OFF before the add-on issued its OFF.
  const before: ActuatorContext = { ...NO_OWN_WRITE, forceChargeActive: true, forceChargeCommands: { onSlots: [1, 2], offIssued: false, ceilingPcts: [] } };
  await p.tick(at(11, 4, 24), [shp2({ ...on, ch2ForceCharge: 'FORCE_CHARGE_OFF' })], before);
  assert.equal(await p.tick(at(11, 4, 25), [shp2({ ...on, ch2ForceCharge: 'FORCE_CHARGE_OFF' })], before), 'empty');
  assert.ok(p.logs.includes(`INFO settings-drift: ${SLOT2} FORCE_CHARGE_ON → FORCE_CHARGE_OFF (changed on the panel during this add-on's night force-charge, not by it — the panel's own ceiling stop or a manual Charge Now; not announced)`), p.logs.join(' | '));
  // 04:29 — the add-on's own OFF reaches slot 1.
  const after: ActuatorContext = { ...before, forceChargeCommands: { onSlots: [1, 2], offIssued: true, ceilingPcts: [] } };
  const off = [shp2({ ch1ForceCharge: 'FORCE_CHARGE_OFF', ch2ForceCharge: 'FORCE_CHARGE_OFF' })];
  await p.tick(at(11, 4, 29), off, after);
  assert.equal(await p.tick(at(11, 4, 30), off, after), 'empty');
  assert.ok(p.logs.includes(`INFO settings-drift: ${SLOT1} FORCE_CHARGE_ON → FORCE_CHARGE_OFF (this add-on's night-charge write — not announced)`), p.logs.join(' | '));
  assert.deepEqual(p.queue.held(), []);
  assert.ok(!p.logs.some((l) => l.includes('EXTERNAL change')), p.logs.join(' | '));
  assert.equal(loadConfirmedSurface()![SLOT1], 'FORCE_CHARGE_OFF');
});

/* ══ a deferred baseline save is retried ══ */

test('★★★ a TRANSIENT sidecar failure: once the disk recovers the held change reaches disk and the deferred baseline is saved — one push, none after a restart', async () => {
  const dir = freshDir();
  const blocker = join(dir, 'held-dir');
  writeFileSync(blocker, 'x'); // a FILE where the sidecar's directory should be: sidecar writes fail
  const heldPath = join(blocker, 'settings-drift-held.json');
  const p1 = boot(dir, undefined, heldPath);
  await p1.tick(at(10, 18), [shp2()]);
  await p1.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p1.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(loadConfirmedSurface()![MODE], 0, 'deferred: the change is in memory only');
  assert.equal(await p1.tick(at(10, 23, 2), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(loadConfirmedSurface()![MODE], 0, 'still deferred while the write keeps failing');
  // 23:05 — the disk recovers. The next tick (which confirms nothing) writes the held change, then the baseline.
  rmSync(blocker);
  assert.equal(await p1.tick(at(10, 23, 5), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.deepEqual(JSON.parse(readFileSync(heldPath, 'utf8')).held.map((e: HeldDriftChange) => [e.key, e.from, e.to]), [[MODE, 0, 2]]);
  assert.equal(loadConfirmedSurface()![MODE], 2, 'the deferred baseline is saved once the held change is on disk');
  assert.ok(p1.logs.some((l) => l.startsWith('INFO settings-drift: deferred baseline saved')), p1.logs.join(' | '));
  assert.equal(p1.logs.filter((l) => l.startsWith('WARN settings-drift: could not write')).length, 1,
    'the failure is logged when it starts, not on every retry');
  // 06:00 one push; quiet ticks until noon; a restart at 12:00 finds nothing to announce again.
  assert.equal(await p1.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2 })]), 'sent');
  for (const h of [7, 9, 11]) assert.equal(await p1.tick(at(11, h, 0), [shp2({ smartBackupMode: 2 })]), 'empty');
  const p2 = boot(dir, undefined, heldPath);
  await p2.tick(at(11, 12, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p2.tick(at(11, 12, 1), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.equal(p1.sends.length + p2.sends.length, 1, 'exactly one push');
});

test('★★★ the sidecar stays down THROUGH the 06:00 push and recovers at 06:30: the deferred baseline is saved with nothing left to hold — one push, none after a 12:00 restart', async () => {
  const dir = freshDir();
  const blocker = join(dir, 'held-dir');
  writeFileSync(blocker, 'x'); // a FILE where the sidecar's directory should be: sidecar writes fail
  const heldPath = join(blocker, 'settings-drift-held.json');
  const p1 = boot(dir, undefined, heldPath);
  await p1.tick(at(10, 18), [shp2()]);
  await p1.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p1.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(loadConfirmedSurface()![MODE], 0, 'deferred: the change is in memory only');
  // 06:00 — the window ends with the disk still down: the push goes out, its clear cannot be written.
  assert.equal(await p1.tick(at(11, 6, 0), [shp2({ smartBackupMode: 2 })]), 'sent');
  assert.deepEqual(p1.queue.held(), []);
  assert.equal(await p1.tick(at(11, 6, 15), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.equal(loadConfirmedSurface()![MODE], 0, 'still deferred: the held set never reached disk');
  // 06:30 — the disk recovers. Nothing is held any more, and the deferred baseline must still land.
  rmSync(blocker);
  assert.equal(await p1.tick(at(11, 6, 30), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.deepEqual(JSON.parse(readFileSync(heldPath, 'utf8')).held, [], 'the (empty) held set is on disk');
  assert.equal(loadConfirmedSurface()![MODE], 2, 'the deferred baseline is saved although nothing is held');
  assert.deepEqual(p1.logs.filter((l) => l.includes('deferred baseline saved')),
    ['INFO settings-drift: deferred baseline saved (0 held change(s) on disk)'], p1.logs.join(' | '));
  // 12:00 — the restart finds the new baseline and an empty sidecar: nothing to announce again.
  const p2 = boot(dir, undefined, heldPath);
  await p2.tick(at(11, 12, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p2.tick(at(11, 12, 1), [shp2({ smartBackupMode: 2 })]), 'empty');
  assert.equal(p1.sends.length + p2.sends.length, 1, 'exactly one push in total');
});

test('★★ a baseline save that THROWS stays pending and is retried every tick until it lands (logged once) — here inside commit(), on a tick that confirms another change', async () => {
  const dir = freshDir();
  let failSaves = 0;
  const p = boot(dir, undefined, undefined, (surface) => {
    if (failSaves > 0) { failSaves--; throw new Error('ENOSPC: no space left on device'); }
    saveConfirmedSurface(surface);
  });
  await p.tick(at(10, 14), [shp2()]);
  failSaves = 3; // the commit's save, then the same tick's retry, then 23:02's retry
  await p.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]);
  assert.equal(await p.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(loadConfirmedSurface()![MODE], 0);
  // 23:02 — the floor moves 20 → 40 (a first sighting: nothing confirmed); the retry fails again.
  const both = [shp2({ smartBackupMode: 2, backupReserveSoc: 40 })];
  assert.equal(await p.tick(at(10, 23, 2), both), 'held');
  assert.equal(loadConfirmedSurface()![MODE], 0);
  assert.equal(failSaves, 0, 'the save was retried on every tick');
  // 23:03 — the floor is confirmed: commit() holds it, and its own save is the first that lands.
  assert.equal(await p.tick(at(10, 23, 3), both), 'held');
  const base = loadConfirmedSurface()!;
  assert.deepEqual([base[MODE], base[FLOOR]], [2, 40], 'saved on the first attempt that succeeds');
  assert.equal(p.logs.filter((l) => l.startsWith('WARN settings-drift: baseline save failed (ENOSPC')).length, 1, p.logs.join(' | '));
  assert.deepEqual(p.logs.filter((l) => l.includes('deferred baseline saved')),
    ['INFO settings-drift: deferred baseline saved (2 held change(s) on disk)'], 'the recovery inside commit() is logged, once');
});

test('★ a sidecar write that fails AFTER the push (the clear) is retried on the next tick — a later restart does not send it again', async () => {
  const path = join(freshDir(), 'held.json');
  let failWrites = false;
  const writeFile = (p: string, text: string): void => {
    if (failWrites) throw new Error('EIO: i/o error');
    atomicWriteFileSync(p, text);
  };
  const sends: DriftPushMessage[] = [];
  const q = mk({ path, isQuiet: () => false, send: async (m) => { sends.push(m); }, writeFile });
  q.hold([{ key: MODE, from: 0, to: 2 }], T(1));
  failWrites = true;
  assert.equal(await q.flush(at(11, 6, 0)), 'sent');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).held.map((e: HeldDriftChange) => e.key), [MODE], 'the clear did not reach disk');
  failWrites = false;
  assert.equal(await q.flush(at(11, 6, 1)), 'empty');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).held, [], 'rewritten on the next tick, with nothing new to hold');
  const reboot = mk({ path, isQuiet: () => false, send: async (m) => { sends.push(m); } });
  assert.equal(await reboot.flush(at(11, 12, 0)), 'empty');
  assert.equal(sends.length, 1);
});

/* ══ expiry in a process that never restarts ══ */

test('★ BOUNDED while running: a merge refreshes the age; a flush drops an entry untouched for 7 days, logs it, rewrites the sidecar — never pushed as news', async () => {
  const path = join(freshDir(), 'held.json');
  const DAY = 86_400_000;
  const logs: string[] = [];
  const sends: DriftPushMessage[] = [];
  let channelDown = true;
  const q = mk({
    path, isQuiet: () => false,
    send: async (m) => { if (channelDown) throw new Error('SUPERVISOR_TOKEN missing'); sends.push(m); },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  });
  const t0 = T(1);
  q.hold([{ key: MODE, from: 0, to: 2 }], t0);
  q.hold([{ key: MODE, from: 2, to: 1 }], t0 + 6 * DAY); // moved again on day 6
  assert.equal(await q.flush(new Date(t0 + 8 * DAY)), 'failed', 'day 8: last moved 2 days ago — kept, and the push retried');
  assert.deepEqual(q.held().map((e) => [e.key, e.from, e.to, e.changes, e.lastAtMs]), [[MODE, 0, 1, 2, t0 + 6 * DAY]]);
  assert.ok(!logs.some((l) => l.includes('never pushed in')), logs.join(' | '));
  // Day 13.1: untouched for 7.1 days. The channel is back, but the change is a week stale.
  channelDown = false;
  assert.equal(await q.flush(new Date(t0 + 13.1 * DAY)), 'empty');
  assert.deepEqual(q.held(), []);
  assert.ok(logs.some((l) => l.startsWith('WARN settings-drift: dropped 1 held change(s) never pushed in 168 h') && l.includes(`${MODE} 0 → 1`)), logs.join(' | '));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).held, []);
  assert.equal(sends.length, 0);
});

test('★★ v1.197.0 a shelved Core\'s setting is not held or pushed: the baseline is saved, the window is told once, a panel change still holds', async () => {
  const dir = freshDir();
  const saved: Array<Record<string, SettingValue>> = [];
  const h = boot(dir, undefined, undefined, (surface) => { saved.push({ ...surface }); });
  const core3 = (chgMaxSoc: number): SurfaceDevice => ({
    sn: 'COREXXX00XXX0003', label: 'Core 3', kind: 'dpu', raw: { 'hs_yj751_pd_app_set_info_addr.chgMaxSoc': chgMaxSoc },
  });
  const noted: Array<{ key: string; from: SettingValue; to: SettingValue; nowMs: number }> = [];
  const ctx: ActuatorContext = { ...NO_OWN_WRITE, shelvedLabels: ['Core 3'] };
  const tick = (now: Date, surface: SurfaceDevice[]) => settleDriftTick({
    queue: h.queue, state: h.state, evaluation: evaluateDrift(h.state, extractSettingsSurface(surface)), now,
    context: () => ctx, log: { info: (m) => h.logs.push(`INFO ${m}`), warn: (m) => h.logs.push(`WARN ${m}`) },
    saveBaseline: (surface) => { saved.push({ ...surface }); },
    onMaintenanceChange: (c, nowMs) => { noted.push({ key: c.key, from: c.from, to: c.to, nowMs }); },
  });
  await tick(at(11, 10, 0), [shp2(), core3(50)]);   // adopt
  await tick(at(11, 10, 1), [shp2(), core3(100)]);  // first sight
  await tick(at(11, 10, 2), [shp2(), core3(100)]);  // confirmed: 50 → 100 on the shelved Core
  assert.deepEqual(noted, [{ key: 'Core 3 · chgMaxSoc', from: 50, to: 100, nowMs: at(11, 10, 2).getTime() }], '★ the window is told, once');
  assert.equal(h.queue.held().length, 0, '★ nothing held for a push');
  assert.equal(h.sends.length, 0, 'nothing pushed');
  assert.equal(saved.at(-1)?.['Core 3 · chgMaxSoc'], 100, '★ the baseline holds the new value: nothing re-pushes it after the window');
  assert.ok(h.logs.some((l) => l.includes("INFO settings-drift: Core 3 · chgMaxSoc 50 → 100 (on a Core in maintenance — listed in the window's end push)")));
  // The panel's reserve floor, in the same window: external, as always.
  await tick(at(11, 10, 3), [shp2({ backupReserveSoc: 40 }), core3(100)]);
  await tick(at(11, 10, 4), [shp2({ backupReserveSoc: 40 }), core3(100)]);
  assert.equal(noted.length, 1, 'the floor is not a maintenance change');
  assert.deepEqual(h.sends.map((m) => m.title), ['Reserve floor changed externally: 20% → 40%'], '★ the floor change is pushed as before (10:04, outside the quiet window)');
});

/* ══ wiring pin (index.ts has no seam a unit test can drive) — a SOURCE PIN, labelled ══ */
test('★★ SOURCE PIN: index.ts builds the held queue at module load and hands EVERY tick, ungated, to settleDriftTick', () => {
  const idx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  const built = idx.indexOf('const driftHold = new DriftHoldQueue({');
  const timer = idx.indexOf('setInterval(() => { runSettingsDriftTick(); }');
  assert.ok(built > 0 && timer > built, 'the queue (and its rehydration) exists before the first tick can run');
  assert.ok(idx.includes('  path: driftHeldPath(),'));
  assert.ok(idx.includes('  isQuiet: (now) => DRIFT_QUIET != null && inNotifyQuiet(now, DRIFT_QUIET),'));
  assert.ok(idx.includes('  send: (msg) => sendNotification(loadNotifyConfig(), msg),'));
  // The WHOLE tick, comment lines aside. A guard around the call (the review's
  // `if (evaln.confirmedChanges.length > 0)`), a direct baseline save or a stand-in context
  // changes this text; the behaviour after the call is tested above through settleDriftTick.
  const start = idx.indexOf('function runSettingsDriftTick(');
  const body = idx.slice(start, idx.indexOf('\n}\n', start)).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.equal(body, [
    'function runSettingsDriftTick(): void {',
    '  try {',
    '    const surface = extractSettingsSurface(settingsSurfaceDevices());',
    '    const evaln = evaluateDrift(settingsDriftState, surface);',
    '    void settleDriftTick({',
    '      queue: driftHold, state: settingsDriftState, evaluation: evaln, now: new Date(), log: driftHoldLog,',
    '      context: driftActuatorContext,',
    // v1.197.0 — the tick also hands a shelved Core's own setting to its maintenance window (listed in
    // the window's end push). An addition, not a guard: the call is still made on every tick.
    '      onMaintenanceChange: noteMaintenanceSettingChange,',
    '    }).catch((e: any) => app.log.warn(`settings-drift: tick failed (${e?.message ?? e})`));',
    '  } catch (e: any) {',
    '    app.log.warn(`settings-drift: tick failed (${e?.message ?? e})`);',
    '  }',
  ].join('\n'));
  assert.ok(!/\bsaveConfirmedSurface\(/.test(idx), 'only settleDriftTick saves the baseline');
  assert.ok(!idx.includes('driftPendingPush'), 'no in-memory-only hold remains');
});
