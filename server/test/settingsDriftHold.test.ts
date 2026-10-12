import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractSettingsSurface, evaluateDrift, freshDriftState, loadConfirmedSurface, saveConfirmedSurface,
  type SurfaceDevice,
} from '../src/settingsDrift.js';
import {
  DriftHoldQueue, driftHeldPath, driftNotification, type DriftHoldOptions, type DriftPushMessage, type HeldDriftChange,
} from '../src/settingsDriftHold.js';
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
 * 2-observation debounce and the real quiet-window predicate.
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
/** Local wall-clock times on the night of 2026-10-10 → 10-11 (inQuietWindow reads getHours). */
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

interface Harness {
  queue: DriftHoldQueue;
  sends: DriftPushMessage[];
  logs: string[];
  /** One drift tick, as index.ts's runSettingsDriftTick runs it (every change here is external). */
  tick: (now: Date, surface: SurfaceDevice[]) => Promise<string>;
  state: ReturnType<typeof freshDriftState>;
}

/**
 * A process boot, as index.ts's module load does it: the baseline loaded from disk
 * (loadConfirmedSurface) and the held queue built (which rehydrates it), then ticks. `send`
 * defaults to a working channel.
 */
function boot(dir: string, send?: (m: DriftPushMessage) => Promise<unknown>, heldPath?: string): Harness {
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
  const tick = async (now: Date, surface: SurfaceDevice[]): Promise<string> => {
    const evaln = evaluateDrift(state, extractSettingsSurface(surface));
    if (evaln.adoptedBaseline) { saveConfirmedSurface(state.confirmed!); return 'adopted'; }
    if (evaln.confirmedChanges.length > 0) {
      queue.commit(evaln.confirmedChanges, now.getTime(), () => saveConfirmedSurface(state.confirmed!));
    }
    return queue.flush(now);
  };
  return { queue, sends, logs, tick, state };
}

const readHeld = (dir: string): HeldDriftChange[] =>
  JSON.parse(readFileSync(join(dir, 'settings-drift-held.json'), 'utf8')).held;

test('★★★ THE 10-10 NIGHT: external change at 23:00 → restart at 23:30 → exactly ONE push at 06:00, with the change', async () => {
  const dir = freshDir();
  // Evening: the baseline is adopted (mode 0).
  const p1 = boot(dir);
  assert.equal(await p1.tick(at(10, 18), [shp2()]), 'adopted');
  // 23:00 — the vendor app moves the mode 0 → 2; confirmed on the second observation, in quiet hours.
  assert.equal(await p1.tick(at(10, 23, 0), [shp2({ smartBackupMode: 2 })]), 'empty', 'first sighting is a transient');
  assert.equal(await p1.tick(at(10, 23, 1), [shp2({ smartBackupMode: 2 })]), 'held');
  assert.equal(p1.sends.length, 0, 'quiet hours: nothing pushed at 23:01');
  // The baseline on disk already holds the NEW value — exactly the trap: nothing can re-detect it.
  assert.equal(loadConfirmedSurface()![MODE], 2);

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
  assert.throws(() => q.commit([{ key: MODE, from: 0, to: 2 }], T(1), () => { throw new Error('power cut mid-save'); }));
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

/* ══ wiring pin (index.ts has no seam a unit test can drive) — a SOURCE PIN, labelled ══ */
test('★★ SOURCE PIN: index.ts builds the held queue at module load (before the tick timer), commits through it, flushes it', () => {
  const idx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  const built = idx.indexOf('const driftHold = new DriftHoldQueue({');
  const timer = idx.indexOf('setInterval(() => { runSettingsDriftTick(); }');
  assert.ok(built > 0 && timer > built, 'the queue (and its rehydration) exists before the first tick can run');
  assert.ok(idx.includes('  path: driftHeldPath(),'));
  assert.ok(idx.includes('  isQuiet: (now) => DRIFT_QUIET != null && inNotifyQuiet(now, DRIFT_QUIET),'));
  assert.ok(idx.includes('  send: (msg) => sendNotification(loadNotifyConfig(), msg),'));
  const start = idx.indexOf('function runSettingsDriftTick(');
  const body = idx.slice(start, idx.indexOf('\n}\n', start));
  assert.ok(body.includes('driftHold.commit(external, nowMs, () => saveConfirmedSurface(settingsDriftState.confirmed!));'),
    'the baseline is saved THROUGH the commit, after the held changes reach disk');
  assert.equal(body.split('saveConfirmedSurface(').length - 1, 2, 'only the first-boot adoption saves the baseline directly');
  assert.ok(body.includes('void driftHold.flush(new Date())'), 'every tick offers the held batch for delivery');
  assert.ok(!idx.includes('driftPendingPush'), 'no in-memory-only hold remains');
});
