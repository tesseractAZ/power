/**
 * v1.187.20 (review) — the host-pressure warning's EPISODE across a restart (host-pressure-state.json).
 *
 * The warning's episode clock and its audible latch lived only in this process. A restart during a
 * yellow the house had heard held the same warning again for the first vitals assessment (~60 s
 * after the boot) plus the 300 s dwell, so the audible condition read green for about six minutes
 * while the pressure went on: another warning that cleared early in the boot let the restart
 * recovery speak "All clear", and the yellow was spoken again at the new dwell. Pressure spanning
 * restarts less than ~6 minutes apart was never announced.
 *
 * The episode is now written beside the DB after each evaluation and carried to the first vitals
 * assessment after a restart. Each tick here is the monitor's sequence: computeAlerts, then
 * persistHostPressureEpisode. A restart is the process losing its memory: the module's holders and
 * the vitals assessment are cleared, and restoreHostPressureEpisode reads the file, as
 * startAlertMonitor does before its first evaluation. Production cadences: an assessment every
 * 60 s (from 60 s after a boot), an evaluation every 20 s.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert, HostPressureEpisode } from '../src/alerts.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-hp-carry-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
delete process.env.HOST_PRESSURE_WARN_DWELL_S;
delete process.env.HOST_PRESSURE_CRIT_DWELL_S;
const PATH = join(tmp, 'host-pressure-state.json');

const {
  computeAlerts, restoreHostPressureEpisode, persistHostPressureEpisode, parseHostPressureEpisode,
  hostPressureCarryPendingHeldAt, debouncedOnsetsPending, _resetHostPressureDwellForTest,
  HOST_PRESSURE_WARN_DWELL_MS, HOST_PRESSURE_CARRY_MAX_GAP_MS, HOST_PRESSURE_PERSIST_EVERY_MS, HOST_PRESSURE_LATCH_CLEAR_MS,
} = await import('../src/alerts.js');
const { ingestLagProbe, tickAssess, _resetVitalsForTest } = await import('../src/selfVitals.js');
const { conditionFromAlerts, speakableAlerts } = await import('../src/broadcast.js');

const SEC = 1_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-12T09:00:00-07:00');
const realDateNow = Date.now;
let offsetMs = 0;
Date.now = () => T0 + offsetMs;
after(() => {
  Date.now = realDateNow;
  rmSync(tmp, { recursive: true, force: true });
});

let onDisk: HostPressureEpisode | null = null;
/** persistHostPressureEpisode returns a NEW record exactly when it wrote the file. */
let writes = 0;
const logs: string[] = [];
beforeEach(() => {
  offsetMs = 0;
  _resetVitalsForTest();
  _resetHostPressureDwellForTest();
  rmSync(PATH, { force: true });
  onDisk = null;
  writes = 0;
  logs.length = 0;
});

/** One vitals assessment now; load1 the only readable gauge. */
function assess(load1: number): void {
  const now = Date.now();
  ingestLagProbe(0, now);
  tickAssess(now, { load: () => ({ load1, load5: load1 }), memAvailableMb: () => null, dataDiskFreeMb: () => null });
}
interface Tick { s: number; hp: Alert | undefined; level: 'green' | 'yellow' | 'red' }
/** The monitor from `fromS` to `toS` (s since T0) inclusive: an assessment at every 60 s mark where
 *  `loadAt` gives a value (null: none yet, the first minute after a boot), an evaluation and the
 *  persist every 20 s. */
function run(fromS: number, toS: number, loadAt: (s: number) => number | null): Tick[] {
  const out: Tick[] = [];
  for (let s = fromS; s <= toS; s += 20) {
    offsetMs = s * SEC;
    const load = loadAt(s);
    if (s % 60 === 0 && load != null) assess(load);
    const hp = computeAlerts({}).find((a) => a.id.startsWith('host-pressure-'));
    const before = onDisk;
    onDisk = persistHostPressureEpisode(PATH, onDisk);
    if (onDisk !== before) writes++;
    out.push({ s, hp, level: conditionFromAlerts(speakableAlerts(hp ? [hp] : [], Date.now(), () => undefined)).level });
  }
  return out;
}
/** The process restarts at `atS`: its memory is gone; the start-up restore reads the file. */
function restart(atS: number): void {
  _resetHostPressureDwellForTest();
  _resetVitalsForTest();
  offsetMs = atS * SEC;
  logs.length = 0;
  onDisk = restoreHostPressureEpisode(PATH, Date.now(), (m) => logs.push(m));
}
const onFile = (): HostPressureEpisode | null => JSON.parse(readFileSync(PATH, 'utf8')).episode;
const pending = (): string[] => debouncedOnsetsPending({ hostPressureCarriedHeldAtMs: hostPressureCarryPendingHeldAt() }, Date.now());
const transitions = (ticks: Tick[], from = 'green'): string[] => {
  const out: string[] = [];
  let prev = from;
  for (const t of ticks) { if (t.level !== prev) out.push(`${prev}→${t.level}@${t.s}`); prev = t.level; }
  return out;
};

/* ══ the review's restart: a heard yellow ══════════════════════════════════════════════════ */

test('★★★ an audible episode is resumed by the first assessment after a restart: audible at once, onset kept', () => {
  // Process A: pressure from 0 s, audible at 300 s, the house hears the yellow; on until 420 s.
  const a = run(0, 420, () => 4.2);
  assert.deepEqual(transitions(a), ['green→yellow@300']);
  assert.deepEqual(onFile(), { sinceMs: T0, heldAtMs: T0 + 420 * SEC, latched: true }, 'on file, audible');
  // The deploy: back 60 s later; no assessment for the first minute.
  restart(480);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^host pressure: an episode of before the restart is carried \(onset 480 s ago, audible, last held 60 s ago\)/);
  const boot = run(480, 520, () => null);
  assert.ok(boot.every((t) => t.hp == null && t.level === 'green'), 'no assessment yet: no host-pressure alert');
  assert.deepEqual(pending(), ['host-pressure (carried episode; not assessed since the restart)'],
    '★ the carry is pending: the alert set is not settled on this green');
  assert.deepEqual(onFile(), { sinceMs: T0, heldAtMs: T0 + 420 * SEC, latched: true }, 'written back unchanged while not resumed');
  // The first assessment: pressure still stands.
  const b = run(540, 600, () => 4.2);
  assert.equal(b[0].hp?.id, 'host-pressure-warn');
  assert.notEqual(b[0].hp?.audible, false, '★ audible at once: the yellow the house heard, not a new held warning');
  assert.ok(!b[0].hp?.detail.includes('Not announced'));
  assert.ok(b.every((t) => t.level === 'yellow'));
  assert.deepEqual(pending(), [], 'resumed: nothing pending');
  assert.deepEqual(onFile(), { sinceMs: T0, heldAtMs: T0 + 600 * SEC, latched: true }, 'its onset kept');
});

test('★★★ the first assessment after a restart reads ok (a fresh process has no vitals hysteresis): an audible episode opens its clear window, and pressure at the next assessment is audible at once', () => {
  // The review's case C: the old process held the warning down to the 3.0 clear line; the new one
  // reads 3.4 (under the 3.5 raise line) as ok, then 4.2 from its second assessment.
  run(0, 420, (s) => (s < 360 ? 4.2 : 3.4));
  assert.equal(onFile()?.latched, true, 'the old process held it at 3.4 (hysteresis), audible');
  restart(480);
  const t = run(480, 720, (s) => (s < 540 ? null : s === 540 ? 3.4 : 4.2));
  assert.equal(t.find((x) => x.s === 540)?.hp, undefined, 'the fresh process reads 3.4 as ok');
  assert.deepEqual(pending(), []);
  for (const x of t.filter((y) => y.s >= 600)) {
    assert.equal(x.hp?.id, 'host-pressure-warn');
    assert.notEqual(x.hp?.audible, false, `★ audible at once at +${x.s} s (60 s into the clear window)`);
  }
  // A recovery that stands the window still ends it after the restart.
  _resetHostPressureDwellForTest();
  _resetVitalsForTest();
  rmSync(PATH, { force: true });
  onDisk = null;
  run(0, 420, () => 4.2);
  restart(480);
  const r = run(480, 960, (s) => (s < 540 ? null : s < 780 ? 0.8 : 4.2));
  assert.equal(r.find((x) => x.s === 780)?.hp?.audible, false, 'ok from 540 to 720 s (the window): the episode ended; 780 s is a new one');
});

/* ══ the second half of the finding: pressure across repeated restarts ════════════════════ */

test('★★★ pressure spanning restarts less than 6 minutes apart is announced: the carried onset counts toward the dwell', () => {
  // Pressure from 0 s; restarts at 150 s and at 270 s, each back within a minute. Each process
  // alone sees less than the dwell; under the old in-memory clock it was never audible.
  const a = run(0, 140, () => 4.2);
  assert.ok(a.every((t) => t.hp?.audible === false));
  restart(150);
  const b = run(160, 260, (s) => (s < 210 ? null : 4.2));
  assert.ok(b.filter((t) => t.hp).every((t) => t.hp!.audible === false), 'still inside the dwell');
  assert.equal(onFile()?.sinceMs, T0, 'the first process\'s onset kept');
  restart(270);
  const c = run(280, 420, (s) => (s < 300 ? null : 4.2));
  assert.equal(c.find((t) => t.s === 280)?.hp, undefined, 'no assessment yet');
  assert.equal(firstAudible(c), 300, '★ audible 300 s after the onset of before the restarts');
  assert.deepEqual(transitions(c), ['green→yellow@300']);
});
function firstAudible(ticks: Tick[]): number | undefined {
  return ticks.find((t) => t.hp != null && t.hp.audible !== false)?.s;
}

test('★★ the outage counts toward the dwell (fail loud): a held episode resumed after a 4-minute restart is audible at once', () => {
  run(0, 120, () => 4.2);
  restart(240);
  const t = run(300, 360, () => 4.2);
  assert.notEqual(t[0].hp?.audible, false, 'onset 300 s ago: the dwell has run');
});

test('★★ an episode that was not audible ends on an ok first assessment: the next warning waits its full dwell', () => {
  run(0, 120, () => 4.2);
  assert.equal(onFile()?.latched, false);
  restart(180);
  const t = run(180, 620, (s) => (s < 240 ? null : s === 240 ? 0.8 : 4.2));
  assert.equal(t.find((x) => x.s === 240)?.hp, undefined);
  assert.equal(t.find((x) => x.s === 580)?.hp?.audible, false);
  assert.equal(firstAudible(t), 600, '★ the new episode from 300 s waits its own dwell, to 600 s');
  assert.equal(onFile()?.sinceMs, T0 + 300 * SEC, 'a new onset');
});

/* ══ the carry window ════════════════════════════════════════════════════════════════════ */

test('★★ last held more than HOST_PRESSURE_CARRY_MAX_GAP_MS before the restart: not carried, not pending, and the file is cleared', () => {
  assert.equal(HOST_PRESSURE_CARRY_MAX_GAP_MS, 10 * MIN);
  run(0, 420, () => 4.2);
  const heldAt = 420;
  restart(heldAt + HOST_PRESSURE_CARRY_MAX_GAP_MS / SEC + 1);
  assert.match(logs[0], /^host pressure: the episode on file was last held 601 s before the restart, more than 10 min — not carried$/);
  assert.equal(hostPressureCarryPendingHeldAt(), null);
  assert.deepEqual(pending(), []);
  const start = heldAt + HOST_PRESSURE_CARRY_MAX_GAP_MS / SEC + 1;
  const t = run(start + 59, start + 59, () => null);
  assert.equal(t[0].hp, undefined);
  assert.equal(onFile(), null, 'the stale episode is cleared on the first evaluation');
});

test('★★ carried at the start-up but the first assessment comes after the window: the gap is judged at the assessment, and the carry stops being pending at the window', () => {
  run(0, 420, () => 4.2);
  restart(480); // last held 60 s ago: carried
  assert.equal(hostPressureCarryPendingHeldAt(), T0 + 420 * SEC);
  offsetMs = (420 * SEC) + HOST_PRESSURE_CARRY_MAX_GAP_MS - 1;
  assert.equal(pending().length, 1, 'inside the window: pending');
  offsetMs = (420 * SEC) + HOST_PRESSURE_CARRY_MAX_GAP_MS;
  assert.deepEqual(pending(), [], '★ the window has run: no longer pending (a set that never assesses still settles)');
  // The first assessment arrives 1 s past the window (a host stalled since the boot).
  const s = 420 + HOST_PRESSURE_CARRY_MAX_GAP_MS / SEC + 1;
  offsetMs = s * SEC;
  assess(4.2);
  const hp = computeAlerts({}).find((a) => a.id.startsWith('host-pressure-'));
  assert.equal(hp?.audible, false, '★ not resumed: a new episode, held for its own dwell');
});

/* ══ the file ═══════════════════════════════════════════════════════════════════════════ */

test('★★ the file: one write per change, the last-held time at most once a minute, the end written; a carry not resumed survives a second restart', () => {
  run(0, 0, () => 4.2);
  assert.equal(writes, 1, 'the episode started');
  run(20, 40, () => 4.2);
  assert.equal(writes, 1, 'inside the persist grain: no write');
  run(60, 60, () => 4.2);
  assert.equal(writes, 2, `the last-held time a minute on (HOST_PRESSURE_PERSIST_EVERY_MS ${HOST_PRESSURE_PERSIST_EVERY_MS} ms)`);
  run(80, 280, () => 4.2);
  assert.equal(writes, 5, 'once a minute: 120, 180, 240 s');
  run(300, 300, () => 4.2);
  assert.equal(writes, 6, 'became audible: written at once');
  assert.equal(onFile()?.latched, true);
  run(320, 340, () => 4.2);
  assert.equal(writes, 6);
  // Recovery: the clear window keeps the episode on file; its end clears it.
  run(360, 360 + HOST_PRESSURE_LATCH_CLEAR_MS / SEC - 20, () => 0.8);
  assert.equal(onFile()?.latched, true, 'inside the clear window the episode stands');
  assert.equal(onFile()?.heldAtMs, T0 + 480 * SEC,
    'and its last-held time keeps moving (once a minute): a restart inside the window is judged from it');
  run(360 + HOST_PRESSURE_LATCH_CLEAR_MS / SEC, 360 + HOST_PRESSURE_LATCH_CLEAR_MS / SEC, () => 0.8);
  assert.equal(onFile(), null, 'the end is written');
  const ended = writes;
  run(560, 600, () => 0.8);
  assert.equal(writes, ended, 'nothing more while ok');
  // A carry not resumed yet is written back as it was, so a second restart before the first
  // assessment still carries it (and it still expires with its own gap).
  _resetHostPressureDwellForTest();
  _resetVitalsForTest();
  rmSync(PATH, { force: true });
  onDisk = null;
  run(960, 1020, () => 4.2);
  restart(1080);
  run(1080, 1120, () => null);
  restart(1140);
  assert.match(logs[0], /^host pressure: an episode of before the restart is carried \(onset 180 s ago, not yet audible, last held 120 s ago\)/);
  assert.deepEqual(onFile(), { sinceMs: T0 + 960 * SEC, heldAtMs: T0 + 1020 * SEC, latched: false });
});

test('★ a missing, malformed or unreadable file carries nothing; parseHostPressureEpisode rejects anything not an episode', () => {
  assert.equal(restoreHostPressureEpisode(PATH, Date.now(), (m) => logs.push(m)), null);
  assert.equal(logs.length, 0, 'no file: nothing to say');
  writeFileSync(PATH, JSON.stringify({ episode: null }));
  assert.equal(restoreHostPressureEpisode(PATH, Date.now(), (m) => logs.push(m)), null);
  assert.equal(logs.length, 0, 'no episode on file: nothing to say');
  writeFileSync(PATH, '{ not json');
  assert.equal(restoreHostPressureEpisode(PATH, Date.now(), (m) => logs.push(m)), null);
  assert.match(logs.pop()!, /^host pressure: episode state at .* is unreadable \(.*\) — ignored; a host-pressure warning after the restart waits its full dwell$/);
  writeFileSync(PATH, JSON.stringify({ episode: { sinceMs: T0, heldAtMs: T0 - 1, latched: true } }));
  assert.equal(restoreHostPressureEpisode(PATH, Date.now(), (m) => logs.push(m)), null);
  assert.match(logs.pop()!, /is malformed — ignored/);
  assert.equal(hostPressureCarryPendingHeldAt(), null);
  const ok = { sinceMs: T0, heldAtMs: T0, latched: false };
  assert.deepEqual(parseHostPressureEpisode(ok), ok);
  for (const bad of [null, [], 'x', {}, { ...ok, sinceMs: 0 }, { ...ok, sinceMs: NaN }, { ...ok, heldAtMs: '1' },
    { ...ok, heldAtMs: T0 - 1 }, { ...ok, latched: 'true' }, { sinceMs: T0, heldAtMs: T0 }]) {
    assert.equal(parseHostPressureEpisode(bad), null, JSON.stringify(bad));
  }
  assert.ok(!existsSync(join(tmp, 'host-pressure-state.json.tmp')));
});

test('★ HOST_PRESSURE_WARN_DWELL_MS is the default the carry tests assume', () => {
  assert.equal(HOST_PRESSURE_WARN_DWELL_MS, 5 * MIN);
});
