/**
 * v1.187.3 — a green that has stood its dwell on a SETTLED alert set after a restart is a
 * recovery, not a restart continuation. Driven through the REAL broadcast monitor
 * (startBroadcastMonitor) with Home Assistant mocked at the HTTP layer (undici MockAgent), the
 * Wyoming renderer injected, and a controllable clock — the conditionDeescalationDwell rig.
 *
 * THE DEFECT (2026-10-01, after the 19:20 deploy). The yellow the household had heard before the
 * restart was still standing at the first tick and was adopted as a restart continuation
 * (19:20:27). The level fell to green, the de-escalation dwell held it (19:20:47), and when it had
 * stood the dwell (19:23:47) isRestartContinuation filed the green, too, as "matching the
 * pre-restart advisory": adopted in silence. The last words in the house stayed a warning that had
 * cleared.
 *
 * KEPT: a yellow at or below the heard baseline is still a continuation, and a boot green is still
 * joined silently (an unpopulated store reads green).
 *
 * v1.187.3 (review) — the green must stand its dwell ON the settled set: measured from the later of
 * the green and the alert monitor's settled stamp (BroadcastMonitorOpts.alertSetSettledSince). A
 * critical still inside its restarted debounce (dpu-err: 3 min, as long as the dwell) could re-publish
 * seconds after a green that began on an unsettled set had been spoken. Until the green has stood
 * its dwell on a settled set it is HELD; if the warm-up ends first it is adopted silently, as before.
 * The stamp itself (alertMonitor.alertSetTrusted) is pinned through the real alert monitor in
 * restartRecoverySettledSet.test.ts.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-recovery-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha,media_player.beta';
process.env.BROADCAST_SIP_TARGETS = '';
process.env.BROADCAST_ANNOUNCE_VOLUME = 'standing';
process.env.BROADCAST_MIN_SEVERITY = 'warning'; // a yellow condition is spoken
process.env.BROADCAST_QUIET_HOURS = '';
process.env.BROADCAST_BILINGUAL = 'false';
process.env.BROADCAST_END_OF_MESSAGE = 'false';
process.env.BROADCAST_REPEAT = '1';
process.env.BROADCAST_LEAD_SILENCE_MS = '0';
process.env.BROADCAST_ANNOUNCE_RETRIES = '0';
process.env.BROADCAST_HEALTH_PROBE_MS = '3600000';

const B = await import('../src/broadcast.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');
const { alertFingerprint } = await import('../src/redReplayGate.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;
const SEC = 1_000;
const DWELL = B.CONDITION_CLEAR_DWELL_MS;

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer ── */
let announces = 0;
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/services', method: 'GET' })
  .reply(200, JSON.stringify([{ domain: 'music_assistant', services: { play_announcement: {} } }])).persist();
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(200, '[]').persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply(200, JSON.stringify({ state: 'idle', attributes: {} })).persist();
ha.intercept({ path: '/core/api/services/music_assistant/play_announcement', method: 'POST' })
  .reply(() => {
    announces += 1;
    offset += 30_000; // play_announcement returns when playback ENDS — a real clip plays ~30 s
    return { statusCode: 200, data: '[]' };
  }).delay(80).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-recovery-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;
/** BroadcastMonitorOpts.alertSetSettledSince — 0: settled since long before the restart's green. */
let settledSince: number | null = 0;

const WARN_K: Alert = { id: 'pack-temp-warn-DPU-A', severity: 'warning', category: 'Thermal', device: 'Core 1', title: 'Pack temperature high', detail: 'x' } as Alert;
const WARN_N: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Pack state of charge low', detail: 'x' } as Alert;
const CRIT_A: Alert = { id: 'dpu-err-DPU-A', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter error code', detail: 'x', fault: 'err7' } as Alert;
/** A cell-spread critical, loud, and on a later reading held by the balancing mute (as alerts.ts stamps it). */
const CRIT_B: Alert = { id: 'vdiff-crit-DPU-B-2', severity: 'critical', category: 'Battery', device: 'Core 2', title: 'Cell imbalance', detail: 'spread 101 mV' } as Alert;
const HELD_B: Alert = {
  ...CRIT_B, annunciate: false, mutedBy: 'balancing', muteReason: 'the BMS is balancing the cells',
  detail: 'spread 95 mV BMS is actively balancing the cells.',
} as Alert;

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  count: (s: string) => number;
  stop: () => void;
}
const live: Rig[] = [];
function rig(wired = true): Rig {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-recovery-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    ...(wired ? { alertSetSettledSince: () => settledSince } : {}),
  });
  const r: Rig = {
    mon, logs,
    has: (s) => logs.some((l) => l.includes(s)),
    count: (s) => logs.filter((l) => l.includes(s)).length,
    stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); },
  };
  live.push(r);
  return r;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(r: Rig, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${r.logs.join('\n')}`);
    await sleep(5);
  }
}
/** A completed condition broadcast of `level`. */
const played = (r: Rig, level: string) => r.count(`broadcast: ${level} → ok in`);
const RECOVERY = 'a recovery, not a continuation of the pre-restart';
const CONTINUATION = 'matches pre-restart advisory';
const HELD_FOR_RECOVERY = 'but is held, not adopted';
const WARMUP_ENDED = 'the warm-up ended before the green had stood';
const RESTORED = 'sounded critical(s) of before the restart restored';
const HOLD_LINE = 'A cell-spread critical that sounded is held, not cleared';
const ABSENT_HOLD = B.SOUNDED_VDIFF_ABSENT_HOLD_MS;

/** A monitor that has run past its warm-up and spoken `level` (heard: the restart baseline). */
async function heard(level: 'yellow' | 'red'): Promise<void> {
  const a = rig();
  await sleep(80); // the first tick joins green
  offset += 11 * MIN; // past the boot warm-up window
  alerts = level === 'red' ? [CRIT_A] : [WARN_K];
  await until(a, () => a.mon.status().conditionSpoken === true && a.mon.status().conditionLevel === level, `a heard ${level}`);
  a.stop();
  offset += 2 * MIN; // the deploy
}

/** A monitor that has run past its warm-up and spoken a red for `crit` (heard), kept loud `loudMs`
 *  more before the deploy. */
async function heardRed(crit: Alert, loudMs = 0): Promise<void> {
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [crit];
  await until(a, () => a.mon.status().conditionSpoken === true && a.mon.status().conditionLevel === 'red', 'a heard red');
  for (let left = loudMs; left > 0; left -= 10 * MIN) {
    offset += Math.min(10 * MIN, left);
    await sleep(40);
  }
  a.stop();
  offset += 2 * MIN; // the deploy
}
const statusFile = (): Record<string, unknown> => JSON.parse(readFileSync(STATUS_PATH, 'utf8'));

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  announces = 0;
  alerts = [];
  settledSince = 0;
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

/* ══ the 10-01 restart ═══════════════════════════════════════════════════════════════════ */

test('★★★ 10-01 replay: a heard yellow standing at the restart is a silent continuation; its clear, after the dwell, is spoken ONCE', async () => {
  await heard('yellow');
  assert.equal(announces, 1);
  const b = rig(); // the warning still stands at the first tick (19:20:27)
  await until(b, () => b.has(CONTINUATION), 'the standing yellow adopted as a continuation');
  assert.equal(b.mon.status().bootBaselineLevel, 'yellow');
  assert.equal(announces, 1, 'the continuation itself is not re-spoken');

  alerts = []; // 19:20:47 — the warning clears
  await until(b, () => b.has('yellow → green held'), 'the de-escalation dwell');
  await sleep(40);
  assert.equal(announces, 1, 'nothing is spoken inside the dwell');
  offset += DWELL + SEC; // 19:23:47 — the green has stood the dwell
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(b.has(`${RECOVERY} yellow`), 'logged as a recovery');
  assert.equal(b.count(CONTINUATION), 1, 'the green was not filed as a continuation');
  assert.equal(b.mon.status().conditionLevel, 'green');
  assert.equal(b.mon.status().conditionSpoken, true, 'the household heard it: the next baseline is green');
  assert.equal(b.mon.status().lastLevel, 'green', 'the last words are the all-clear');
  await sleep(80);
  assert.equal(announces, 2, 'spoken once');
  assert.equal(b.count(RECOVERY), 1);
});

test('★★★ after the recovery, a NEW warning inside the warm-up is news — spoken, not filed as a continuation', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  alerts = [WARN_N];
  await until(b, () => b.has('yellow held for boot confirmation') || b.count(CONTINUATION) > 1, 'the new yellow');
  assert.equal(b.count(CONTINUATION), 1, 'the baseline ended with the recovery');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(b, () => played(b, 'yellow') === 1, 'the new yellow spoken');
});

test('★★★ an alert set that has not SETTLED holds the green: nothing is spoken and nothing is adopted (the boot false-green)', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null; // a feed that owns the warning has not delivered since boot
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'the green held past its dwell for its recovery');
  assert.ok(b.has('the alert set is not settled'), 'the line says why');
  await sleep(80);
  assert.equal(announces, 1, 'no all-clear');
  assert.equal(b.count(CONTINUATION), 1, 'not adopted as a continuation either: it may still become a recovery');
  assert.equal(b.mon.status().conditionLevel, 'yellow', 'nothing committed');
  assert.equal(b.count(HELD_FOR_RECOVERY), 1, 'said once');
  assert.ok(!b.has(RECOVERY));
});

test('★★★ the dwell runs from the SETTLED stamp, not from the green: a set that settles after the green began needs the full dwell after it', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery');
  settledSince = Date.now(); // the alert monitor stamps a settled set now
  offset += DWELL - 20 * SEC;
  await sleep(80);
  assert.equal(announces, 1, 'the green has stood only 160 s on the settled set');
  assert.ok(!b.has(RECOVERY));
  offset += 21 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear once it has stood the dwell on the settled set');
  assert.ok(b.has(`${RECOVERY} yellow`));
  assert.equal(announces, 2);
});

test('★★★ review replay: a heard red, a boot-transient yellow, a green on an unsettled set, then the critical re-publishes — no "All clear" before the klaxon', async () => {
  // dpu-err is critical with a 3-minute onset debounce whose clock restarts in every process: after
  // the boot it is withheld for one window, as long as the de-escalation dwell. Before the review
  // fix the green that began on the unsettled set was spoken the moment it had stood the dwell, and
  // the same critical sounded seconds later.
  await heard('red');
  assert.equal(announces, 1);
  alerts = [WARN_K]; // a boot transient (off-panel mute lag, stale-until-first-read)
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the transient yellow adopted below the heard red');
  alerts = []; // it clears within seconds
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held: the set is not settled');
  await sleep(60);
  assert.ok(!b.has('condition transition → green'), 'no all-clear');
  alerts = [CRIT_A]; // the debounce has run: the critical is published again
  await until(b, () => played(b, 'red') === 1, 'the critical re-announced');
  assert.equal(b.count('condition transition → green'), 0, 'no all-clear before (or after) it');
  assert.equal(announces, 2, 'the pre-restart red and the critical — no all-clear between them');
});

test('★★★ the warm-up ends with the green still held: adopted silently as a continuation, as before v1.187.3 (fail-quiet)', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery');
  offset += 8 * MIN; // past the 10-minute warm-up
  await until(b, () => b.has(WARMUP_ENDED), 'adopted at the end of the warm-up');
  await sleep(80);
  assert.equal(announces, 1, 'not announced: the set never settled');
  assert.ok(!b.has('condition transition → green'));
  assert.equal(b.mon.status().conditionLevel, 'green');
  assert.equal(b.mon.status().conditionSpoken, true, 'the continuation of a heard level, as the continuation path records it');
  settledSince = 0;
  offset += DWELL;
  await sleep(80);
  assert.equal(announces, 1, 'and nothing later: the green is committed');
});

test('★★ a green that begins late in the warm-up and stands its plain dwell past it is an ordinary transition, as before', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  offset += 9 * MIN; // inside the warm-up
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC; // stood its dwell only after the warm-up ended: never held for a recovery
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(!b.has(HELD_FOR_RECOVERY));
  assert.ok(!b.has(WARMUP_ENDED));
});

test('★★ a green held for its recovery that flickers back to yellow is a new green: begun late and stood past the warm-up, it is an ordinary transition', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery');
  alerts = [WARN_K]; // the warning comes back: the held green is over
  await until(b, () => b.has('flicker absorbed'), 'the hold abandoned');
  offset += 6 * MIN; // ~9 min after the boot
  alerts = [];
  await until(b, () => b.count('yellow → green held') === 2, 'a new green, held for its own dwell');
  offset += DWELL + SEC; // it stands its dwell only past the warm-up
  await until(b, () => played(b, 'green') === 1, 'the all-clear, as any green after the warm-up');
  assert.ok(!b.has(WARMUP_ENDED), 'not the held green of before');
});

test('★★★ the recovery waits for the de-escalation dwell: nothing is spoken before the green has stood it', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL - 20 * SEC;
  await sleep(80);
  assert.equal(announces, 1, 'still inside the dwell');
  assert.ok(!b.has(RECOVERY));
  offset += 21 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear once the dwell has passed');
});

test('★★ a monitor not told the alert set is settled (the option absent, throwing, or not a finite time) never takes a recovery', async () => {
  const bad: Array<[string, (() => number | null) | undefined]> = [
    ['absent', undefined],
    ['throwing', () => { throw new Error('feeds unreadable (test)'); }],
    ['NaN', () => Number.NaN],
    ['-Infinity', () => Number.NEGATIVE_INFINITY],
  ];
  let spoken = 0;
  for (const [what, reader] of bad) {
    await heard('yellow');
    spoken += 1;
    alerts = [WARN_K];
    const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-recovery-cache-'));
    const logs: string[] = [];
    const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
      klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
      ...(reader ? { alertSetSettledSince: reader } : {}),
    });
    const c: Rig = { mon, logs, has: (x) => logs.some((l) => l.includes(x)), count: (x) => logs.filter((l) => l.includes(x)).length, stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); } };
    live.push(c);
    await until(c, () => c.has(CONTINUATION), `the continuation (${what})`);
    alerts = [];
    await until(c, () => c.has('yellow → green held'), `the dwell (${what})`);
    offset += DWELL + SEC;
    await until(c, () => c.has(HELD_FOR_RECOVERY), `held (${what})`);
    offset += 8 * MIN;
    await until(c, () => c.has(WARMUP_ENDED), `adopted silently at the end of the warm-up (${what})`);
    assert.equal(announces, spoken, `${what}: only the pre-restart yellows were spoken`);
    assert.ok(!c.has(RECOVERY), what);
    c.stop();
  }
});

test('★★ the boot green is still joined silently: a condition that cleared while the add-on was down gets no all-clear', async () => {
  await heard('yellow');
  alerts = []; // the store reads green at the first tick (cleared while down, or not yet populated)
  const b = rig();
  await sleep(80);
  assert.equal(b.mon.status().bootBaselineLevel, 'yellow');
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(announces, 1, 'nothing spoken');
  assert.ok(!b.has(RECOVERY));
  assert.ok(!b.has('condition transition → green'));
});

test('★★ yellow → yellow stays a continuation, on a settled alert set too', async () => {
  await heard('yellow');
  alerts = [WARN_K, WARN_N];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  offset += 3 * MIN;
  await sleep(80);
  assert.equal(announces, 1);
  assert.equal(b.mon.status().conditionLevel, 'yellow');
  assert.ok(!b.has(RECOVERY));
});

test('★★ a heard RED baseline: the yellow below it is a continuation, the green after it a recovery', async () => {
  await heard('red');
  assert.equal(announces, 1);
  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the yellow below the heard red');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(b.has(`${RECOVERY} red`));
  assert.equal(announces, 2);
});

test('★★ a red spoken after the restart, then cleared inside the warm-up: its all-clear is spoken (it was a silent continuation before)', async () => {
  await heard('yellow');
  alerts = [];
  const b = rig();
  await sleep(80); // the boot green
  alerts = [CRIT_A];
  await until(b, () => played(b, 'red') === 1, 'the red, an escalation over the heard yellow');
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.equal(announces, 3);
  assert.equal(b.mon.status().lastLevel, 'green', 'the last words are not the cleared red');
});

test('★★ a heard GREEN baseline: a yellow spoken after the restart, then cleared, gets its all-clear', async () => {
  // The house was green before the restart; a warning raised after it was spoken. Its clear inside
  // the warm-up was "at or below the green baseline", a continuation, so the warning stayed the
  // last words. A green transition only ever follows a level committed since boot.
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [WARN_K];
  await until(a, () => played(a, 'yellow') === 1, 'a yellow');
  alerts = [];
  await until(a, () => a.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(a, () => played(a, 'green') === 1 && a.mon.status().conditionSpoken === true, 'a heard green');
  a.stop();
  offset += 2 * MIN;

  const b = rig();
  await sleep(80);
  assert.equal(b.mon.status().bootBaselineLevel, 'green');
  alerts = [WARN_N];
  await until(b, () => b.has('yellow held for boot confirmation'), 'the boot yellow hold');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(b, () => played(b, 'yellow') === 1, 'the new yellow');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(b.has(`${RECOVERY} green`));
});

test('★ past the warm-up nothing changes: the green is an ordinary transition', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  offset += 11 * MIN;
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(!b.has(RECOVERY), 'not a restart decision at all');
});

/* ══ log review 10-01: a critical that SOUNDED before the restart is still held after it ══════ */

test('★★★ log review: a cell-spread critical that sounded before the restart and is muted again after it holds the green — no "All clear" with its card open', async () => {
  // soundedCriticalHeld's record lived only in memory: after the restart a vdiff-crit held by its
  // knee mute read as one that never sounded, and the recovery spoke the all-clear (then the klaxon
  // when the mute lapsed). The record survives the restart in the status file.
  await heardRed(CRIT_B);
  assert.equal(announces, 1);
  assert.deepEqual(Object.keys(statusFile().soundedCrit as object), [alertFingerprint(CRIT_B)], 'the sounded record is on disk');
  alerts = [WARN_K, HELD_B]; // the knee mute is back after the restart; a boot-transient warning stands
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the warning adopted below the heard red');
  assert.ok(b.has(RESTORED), 'the sounded critical restored before the first tick');
  alerts = [HELD_B]; // the warning clears; the critical is still muted
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE), 'held as a sounded critical, as in one process');
  offset += DWELL + 30 * SEC; // the set is settled (since 0) and the dwell has passed
  await sleep(60);
  offset += 4 * MIN; // still inside the warm-up
  await sleep(60);
  assert.ok(!b.has('condition transition → green'), 'no all-clear while the critical that sounded is muted');
  assert.ok(!b.has(RECOVERY));
  assert.ok(!b.has(HELD_FOR_RECOVERY), 'the green clock never started');
  assert.equal(announces, 1);
  // The critical genuinely clears: the all-clear follows the absent hold and the dwell.
  alerts = [];
  await sleep(60);
  offset += ABSENT_HOLD - 5 * SEC;
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'held between readings');
  offset += 6 * SEC; // released: the dwell starts
  await sleep(60);
  offset += DWELL - 5 * SEC;
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'not before the clear has also stood the dwell');
  offset += 6 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear once the critical has cleared');
  assert.equal(announces, 2);
});

test('★★★ …and one ABSENT between two readings after the restart is held the absent hold, counted from the boot', async () => {
  await heardRed(CRIT_B);
  alerts = [WARN_K]; // the critical is between two readings at the first tick
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE));
  offset += ABSENT_HOLD - 10 * SEC; // the set settled long ago: a recovery would have been spoken by now
  await sleep(60);
  assert.ok(!b.has('condition transition → green'), 'held: gone less than the absent hold since the boot');
  offset += 11 * SEC; // released: the green's dwell starts now
  await sleep(60);
  offset += DWELL - 10 * SEC;
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'the outage is not counted as absence: released the absent hold after the boot');
  offset += 11 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.equal(announces, 2);
});

test('★★★ a sounded critical already muted at the restart is restored too — the hold had demoted the heard flag and cleared the red-replay evidence', async () => {
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [CRIT_B];
  await until(a, () => played(a, 'red') === 1, 'red');
  alerts = [HELD_B];
  await until(a, () => a.has('red-replay evidence is cleared now'), 'the hold, the evidence cleared');
  assert.ok(a.has(HOLD_LINE));
  assert.equal(a.mon.status().conditionSpoken, false, 'the hold demoted the heard flag');
  a.stop();
  offset += 2 * MIN;

  alerts = [WARN_K, HELD_B];
  const b = rig();
  await until(b, () => b.has('yellow held for boot confirmation'), 'the boot yellow hold');
  assert.equal(b.mon.status().bootBaselineLevel, null, 'no heard baseline');
  assert.ok(b.has(RESTORED), 'restored whatever the condition record says');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(b, () => played(b, 'yellow') === 1, 'the warning');
  alerts = [HELD_B];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE));
  offset += DWELL + 10 * MIN;
  await sleep(60);
  assert.ok(!b.has('condition transition → green'), 'no all-clear with its card open');
  assert.equal(announces, 2);
});

test('★★ the record on disk stays fresh while the critical stands: one loud longer than the restore bound before the restart is restored', async () => {
  await heardRed(CRIT_B, B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS + 10 * MIN);
  const at = (statusFile().soundedCrit as Record<string, number>)[alertFingerprint(CRIT_B)];
  assert.ok(Date.now() - at <= 2 * MIN + 10 * MIN, 'refreshed on disk while it stood');
  alerts = [WARN_K, HELD_B];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  assert.ok(b.has(RESTORED));
  alerts = [HELD_B];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE));
  offset += DWELL + SEC;
  await sleep(80);
  assert.ok(!b.has('condition transition → green'));
});

test('★★ a sounded record older than SOUNDED_CRIT_RESTORE_MAX_AGE_MS is not restored: after a long outage the muted critical is a new episode', async () => {
  await heardRed(CRIT_B);
  offset += B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS; // with the deploy's 2 min: past the bound
  alerts = [WARN_K, HELD_B];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  assert.ok(!b.has(RESTORED));
  alerts = [HELD_B];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(!b.has(HOLD_LINE));
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the recovery, as for a muted critical that never sounded');
  assert.ok(b.has(`${RECOVERY} red`));
});

test('★★ a sounded critical RELEASED before the restart is not restored: its muted return after it holds nothing', async () => {
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [CRIT_B];
  await until(a, () => played(a, 'red') === 1, 'red');
  alerts = []; // it clears
  await until(a, () => a.has('red → green held'), 'the hold');
  offset += ABSENT_HOLD + 10 * SEC; // gone the absent hold: released (the green's dwell runs)
  await sleep(60);
  assert.deepEqual(statusFile().soundedCrit, {}, 'the release is written at once');
  a.stop(); // restarted inside the green's dwell
  offset += MIN;

  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has('yellow held for boot confirmation'), 'the boot yellow hold');
  assert.ok(!b.has(RESTORED));
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(b, () => played(b, 'yellow') === 1, 'the warning');
  alerts = [HELD_B]; // back, muted from its first reading in this episode
  await until(b, () => b.has('yellow → green held'), 'the hold');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(!b.has(HOLD_LINE));
});

test('★★ a status file written before v1.187.3 (no sounded record) under a heard red: the criticals of the red announcement on record are seeded', async () => {
  await heardRed(CRIT_B);
  const s = statusFile();
  delete s.soundedCrit;
  writeFileSync(STATUS_PATH, JSON.stringify(s));
  alerts = [WARN_K, HELD_B];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  assert.ok(b.has(`${RESTORED} from the red announcement on record`));
  alerts = [HELD_B];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE));
  offset += DWELL + 4 * MIN;
  await sleep(80);
  assert.ok(!b.has('condition transition → green'));
});

test('★★ …but not without a heard red: a red announcement on record below a heard yellow seeds nothing', async () => {
  // The red's critical cleared and the yellow below it was committed and spoken: in one process
  // that critical had been released. The red-replay evidence outlives it (only a green clears it).
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [CRIT_B, WARN_K];
  await until(a, () => played(a, 'red') === 1, 'red');
  alerts = [WARN_K];
  await until(a, () => a.has('red → yellow held'), 'the hold');
  offset += ABSENT_HOLD + 10 * SEC;
  await sleep(60);
  offset += DWELL + SEC;
  await until(a, () => played(a, 'yellow') === 1 && a.mon.status().conditionSpoken === true, 'a heard yellow');
  a.stop();
  offset += 2 * MIN;
  const evidence = JSON.parse(readFileSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, 'utf8'));
  assert.deepEqual(evidence.activeFingerprints, [alertFingerprint(CRIT_B)], 'the red announcement is still on record');
  const s = statusFile();
  delete s.soundedCrit;
  writeFileSync(STATUS_PATH, JSON.stringify(s));

  alerts = [WARN_K, HELD_B];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  assert.equal(b.mon.status().bootBaselineLevel, 'yellow');
  assert.ok(!b.has(RESTORED));
  alerts = [HELD_B];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  offset += DWELL + SEC;
  await until(b, () => played(b, 'green') === 1, 'the recovery');
});

test('restoreSoundedCriticals — a record object only; well-formed fingerprints with a finite last-present time at most the bound old, each stamped at the boot', () => {
  const boot = 90_000_000;
  const fp = alertFingerprint(CRIT_B);
  const fpA = alertFingerprint(CRIT_A);
  const max = B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS;
  assert.equal(B.restoreSoundedCriticals(undefined, boot), null, 'a status file written before v1.187.3');
  assert.equal(B.restoreSoundedCriticals(null, boot), null);
  assert.equal(B.restoreSoundedCriticals('x', boot), null);
  assert.equal(B.restoreSoundedCriticals([[fp, boot]], boot), null, 'an array is not the record');
  assert.deepEqual([...B.restoreSoundedCriticals({}, boot)!], [], 'a v1.187.3 record with nothing sounded');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: boot - max, [fpA]: boot - 5 * MIN }, boot)!], [[fp, boot], [fpA, boot]], 'inclusive bound; stamped at the boot');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: boot - max - 1 }, boot)!], [], 'one ms past the bound');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: boot + 5 * MIN }, boot)!], [[fp, boot]], 'a future stamp (the clock stepped back) is restored at the boot, not in the future');
  assert.deepEqual([...B.restoreSoundedCriticals({ 'vdiff-crit-DPU-B-2': boot }, boot)!], [], 'a bare id is not a fingerprint');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: '123' }, boot)!], [], 'not a number');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: Infinity }, boot)!], [], 'not finite');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: -Infinity }, boot)!], [], 'not finite');
  assert.equal(B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS, 60 * MIN, 'VDIFF_KNEE_GAP_CARRY_MS: the longest outage a knee session survives');
  assert.equal(B.SOUNDED_CRIT_PERSIST_EVERY_MS, MIN);
});

/* ── the pure predicate ──────────────────────────────────────────────────────────────────── */

test('isRestartRecovery — green only, a heard baseline, the dwell stood (inclusive) on a settled set: from the later of the green and the stamp', () => {
  const t = 50_000_000;
  const stood = t - DWELL;
  assert.equal(B.isRestartRecovery('yellow', 'green', stood, t, 0), true);
  assert.equal(B.isRestartRecovery('red', 'green', stood, t, 0), true);
  assert.equal(B.isRestartRecovery('green', 'green', stood, t, 0), true, 'a green transition follows a level committed since boot');
  assert.equal(B.isRestartRecovery('yellow', 'green', stood + 1, t, 0), false, 'one ms short of the dwell');
  assert.equal(B.isRestartRecovery('yellow', 'green', null, t, 0), false, 'green not observed');
  assert.equal(B.isRestartRecovery('yellow', 'green', stood, t, null), false, 'not settled');
  assert.equal(B.isRestartRecovery(null, 'green', stood, t, 0), false, 'no heard baseline');
  assert.equal(B.isRestartRecovery('red', 'yellow', stood, t, 0), false, 'a yellow is never a recovery');
  assert.equal(B.isRestartRecovery('yellow', 'yellow', stood, t, 0), false);
  assert.equal(B.isRestartRecovery('yellow', 'red', stood, t, 0), false);
  // ★ the review: a green that has stood the dwell, on a set settled only since later, has not.
  assert.equal(B.isRestartRecovery('yellow', 'green', t - 10 * MIN, t, t - DWELL + 1), false, 'settled 1 ms short of the dwell');
  assert.equal(B.isRestartRecovery('yellow', 'green', t - 10 * MIN, t, t - DWELL), true, 'settled exactly the dwell');
  assert.equal(B.isRestartRecovery('yellow', 'green', t - DWELL + 1, t, t - 10 * MIN), false, 'settled long ago, the green 1 ms short');
  assert.equal(B.isRestartRecovery('yellow', 'green', t - 10, t, t - 10, 10), true, 'the dwell is a parameter');
  // The continuation predicate itself is unchanged: the recovery is decided before it.
  assert.equal(B.isRestartContinuation('yellow', 'green', 90_000, 10 * MIN), true);
});

test('★★★ production wiring: the broadcast reads the alert monitor\'s settled stamp (alertMonitor.alertSetTrusted, pinned behaviourally in restartRecoverySettledSet)', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  const at = src.indexOf('const broadcast = startBroadcastMonitor(');
  assert.ok(at > 0);
  const call = src.slice(at, src.indexOf('});', at));
  assert.match(call, /alertSetSettledSince: \(\) => monitor\.alertSetSettledSince\(\),/);
  assert.ok(src.indexOf('const monitor = startAlertMonitor(') < at, 'the alert monitor exists before the broadcast monitor reads it');
});
