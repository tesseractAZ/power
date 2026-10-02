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
const { LONGEST_RESTARTED_ONSET_MS } = await import('../src/alerts.js');

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
/** v1.187.4 — the Music Assistant speakers' state ('unavailable': the pre-flight defers), and the
 *  SIP cordless entity's (read by the probe after a timed-out SIP dispatch). */
let maState = 'idle';
let cordlessState = 'idle';
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply((o) => ({ statusCode: 200, data: JSON.stringify({ state: String(o.path).endsWith('media_player.cordless') ? cordlessState : maState, attributes: {} }) })).persist();
/** v1.187.4 — play_announcement "ok" in under 2 s: HA returned without playing. */
let tooFast = false;
ha.intercept({ path: '/core/api/services/music_assistant/play_announcement', method: 'POST' })
  .reply(() => {
    announces += 1;
    if (!tooFast) offset += 30_000; // play_announcement returns when playback ENDS — a real clip plays ~30 s
    return { statusCode: 200, data: '[]' };
  }).delay(80).persist();
/** v1.187.4 — the SIP cordless (BROADCAST_SIP_TARGETS), answering `sipStatus`, or losing the HTTP
 *  response (`sipTimeout`: the call may still have run — the entity state says). */
let sipPlays = 0;
let sipStatus = 200;
let sipTimeout = false;
const SIP_PLAY = '/core/api/services/media_player/play_media';
ha.intercept({ path: (p: string) => p === SIP_PLAY && sipTimeout, method: 'POST' })
  .replyWithError(new Error('Headers Timeout Error (test)')).persist();
ha.intercept({ path: (p: string) => p === SIP_PLAY && !sipTimeout, method: 'POST' })
  .reply(() => {
    sipPlays += 1;
    return { statusCode: sipStatus, data: sipStatus === 200 ? '[]' : 'error' };
  }).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-recovery-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
/** v1.187.4 — the spoken render fails (Piper down): the broadcast falls back to the tone alone. */
let ttsFails = false;
const renderTts = async () => (ttsFails
  ? { ok: false as const, error: 'wyoming socket: refused (test)' }
  : { ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;
/** BroadcastMonitorOpts.alertSetSettledSince — 0: settled since long before the restart's green. */
let settledSince: number | null = 0;

const WARN_K: Alert = { id: 'pack-temp-warn-DPU-A', severity: 'warning', category: 'Thermal', device: 'Core 1', title: 'Pack temperature high', detail: 'x' } as Alert;
const WARN_N: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Pack state of charge low', detail: 'x' } as Alert;
/** v1.187.4 — the backup pool unreadable 15 min: withheld for 15 min after every boot before v1.187.4. */
const WARN_RB: Alert = { id: 'reserve-alarm-blind', severity: 'warning', category: 'Connectivity', device: 'Smart Home Panel 2', title: 'Reserve alarm blind', detail: 'x' } as Alert;
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
/** v1.187.4 — the warm-up-end decision waits for a settled set or the restarted onset windows. */
const WAITS_PAST_WARMUP = 'on an alert set that is not settled — still held, until the set settles or at the latest 16 min after the boot';
/** …due this long after the boot when the set never settles (boot + 16 min). */
const DECISION_DUE = LONGEST_RESTARTED_ONSET_MS + B.RESTARTED_ONSET_HOLD_MARGIN_MS;
const RESTORED = 'sounded critical(s) of before the restart restored';
const GREEN_SPOKEN = 'condition transition → green';
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
  maState = 'idle';
  tooFast = false;
  ttsFails = false;
  sipPlays = 0;
  sipStatus = 200;
  sipTimeout = false;
  cordlessState = 'idle';
  process.env.BROADCAST_SIP_TARGETS = '';
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

test('★★★ the warm-up ends with the green still held on a set that never settles: adopted silently as a continuation once the restarted onset windows have run (fail-quiet)', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery');
  assert.ok(b.has('if the warm-up ends first it is adopted silently as a continuation once the set has settled, or at the latest 16 min after the boot'), 'the held line says what follows');
  offset += 8 * MIN; // past the 10-minute warm-up (boot + 11 min)
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'v1.187.4: still held past the warm-up');
  await sleep(80);
  assert.ok(!b.has(WARMUP_ENDED), 'not decided on an unsettled set before the restarted onset windows have run');
  assert.equal(b.mon.status().conditionLevel, 'yellow', 'nothing committed');
  assert.equal(b.count(WAITS_PAST_WARMUP), 1, 'said once');
  offset += 5 * MIN; // boot + 16 min: the bound
  await until(b, () => b.has(WARMUP_ENDED), 'adopted at the bound');
  assert.equal(b.count(WAITS_PAST_WARMUP), 1, 'said once for the whole wait');
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
    await until(c, () => c.has(WAITS_PAST_WARMUP), `v1.187.4: still held past the warm-up (${what})`);
    offset += 5 * MIN; // boot + 16 min
    await until(c, () => c.has(WARMUP_ENDED), `adopted silently once the restarted onset windows have run (${what})`);
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

test('★★★ log review (LOW): a green held by a restored sounded critical until past the warm-up, on a set that never settled, is adopted silently — not spoken as a late green', async () => {
  // The restored absent cell-spread critical holds the green SOUNDED_VDIFF_ABSENT_HOLD_MS (7 min)
  // from the boot, so the green's 3-min dwell ends exactly as the 10-min warm-up does. It took the
  // late-green path, an ordinary transition, and was spoken with the alert set never settled (a
  // backup pool unknown, NWS enabled and failing); the same restart without the record adopts it
  // silently. Its recovery is now decided past the warm-up: held from its first due tick for at
  // most one more dwell (the patience the warm-up gives), then adopted silently.
  await heardRed(CRIT_B);
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the warning adopted below the heard red');
  assert.ok(b.has(RESTORED));
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE), 'held by the restored critical, between readings');
  offset += ABSENT_HOLD + 5 * SEC; // released ~7 min after the boot: the green clock starts
  await sleep(60);
  assert.ok(!b.has(HELD_FOR_RECOVERY));
  offset += DWELL + 5 * SEC; // the dwell has passed — and the warm-up has ended
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery past the warm-up');
  assert.ok(b.has('A sounded critical held it inside the warm-up, which has ended'), 'the held line says how long it is waited for');
  await sleep(60);
  assert.ok(!b.has(WARMUP_ENDED), 'not adopted on the due tick: it has one more dwell to settle');
  assert.equal(played(b, 'green'), 0);
  offset += DWELL + 5 * SEC; // that dwell has passed too, and the set never settled (boot + 13 min)
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'v1.187.4: still held until the restarted onset windows have run');
  await sleep(60);
  assert.ok(!b.has(WARMUP_ENDED));
  offset += 3 * MIN; // boot + 16 min
  await until(b, () => b.has(WARMUP_ENDED), 'adopted silently as a continuation');
  await sleep(80);
  assert.equal(played(b, 'green'), 0, 'not spoken: the set never settled');
  assert.ok(!b.has('condition transition → green'));
  assert.equal(announces, 1);
  assert.equal(b.mon.status().conditionLevel, 'green');
  assert.equal(b.mon.status().conditionSpoken, true, 'as the continuation path records it');
  assert.equal(b.count(HELD_FOR_RECOVERY), 1);
});

test('★★ …and on a settled set that green is a recovery, decided once past the warm-up: spoken, and the continuation baseline ends', async () => {
  await heardRed(CRIT_B);
  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  offset += ABSENT_HOLD + 5 * SEC;
  await sleep(60);
  offset += DWELL + 5 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(b.has(`${RECOVERY} red`), 'a recovery, not a late ordinary transition');
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(announces, 2);
});

test('★★ …but a sounded critical that holds a green only after the warm-up is no restart decision: the green is an ordinary transition, on an unsettled set too', async () => {
  await heard('yellow');
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  offset += 11 * MIN; // past the warm-up
  alerts = [WARN_K, CRIT_B];
  await until(b, () => played(b, 'red') === 1, 'the red');
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE), 'held between readings');
  offset += ABSENT_HOLD + 5 * SEC;
  await sleep(60);
  offset += DWELL + 5 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(!b.has(HELD_FOR_RECOVERY));
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(announces, 3);
});

/* ── seam review: only a critical of BEFORE the restart makes a green a restart question ── */

test('★★★ seam review (MEDIUM): a cell-spread red the house heard AFTER the restart, cleared inside the warm-up, gets its all-clear on its due tick past it, on an unsettled set too', async () => {
  // The hold was marked for ANY sounded critical holding it inside the warm-up, so this green was
  // decided on one tick past the warm-up and, the set unsettled, adopted in silence: the red heard
  // after the restart stayed the last words. A critical that first sounded after the boot is the
  // house's own news; its green is an ordinary transition.
  await heard('yellow');
  alerts = [];
  settledSince = null;
  const b = rig();
  await sleep(80); // the boot green
  alerts = [CRIT_B];
  await until(b, () => played(b, 'red') === 1, 'the red, an escalation over the heard yellow');
  assert.ok(!b.has(RESTORED), 'nothing of before the restart');
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE), 'held between readings, inside the warm-up');
  offset += ABSENT_HOLD + 5 * SEC; // released: the green clock starts
  await sleep(60);
  offset += DWELL + 5 * SEC; // its dwell ends past the warm-up
  await until(b, () => played(b, 'green') === 1, 'the all-clear on its due tick');
  assert.ok(!b.has(HELD_FOR_RECOVERY), 'never held for a recovery');
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(b.mon.status().lastLevel, 'green', 'the last words are not the cleared red');
  assert.equal(announces, 3);
});

test('★★ seam review (MEDIUM): …and one knee-muted across the end of the warm-up, then cleared, gets its all-clear on its due tick too', async () => {
  // The verifier's Probe A: the hold is by a muted critical (mutedBy), not one between readings.
  // It begins inside the warm-up and is first released long after it.
  await heard('yellow');
  alerts = [];
  settledSince = null;
  const b = rig();
  await sleep(80);
  alerts = [CRIT_B];
  await until(b, () => played(b, 'red') === 1, 'the red');
  alerts = [HELD_B]; // the knee mute, inside the warm-up
  await until(b, () => b.has('red → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE), 'held by the muted critical');
  offset += 11 * MIN; // still muted past the warm-up
  await sleep(60);
  alerts = []; // cleared for good
  await sleep(60);
  offset += ABSENT_HOLD + 5 * SEC; // released: the green clock starts
  await sleep(60);
  offset += DWELL + 5 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear on its due tick');
  assert.ok(!b.has(HELD_FOR_RECOVERY), 'never held for a recovery');
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(b.mon.status().lastLevel, 'green');
  assert.equal(announces, 3);
});

test('★★ seam review: a restored critical released and back loud after the restart is a new episode — its replayed red, cleared, gets its all-clear past the warm-up', async () => {
  // The red-replay gate mutes the re-raised critical (the same standing fault, announced before
  // the restart), so nothing has been spoken since the boot. Released at boot+7 min, the critical
  // is no longer one of the boot's: the hold its return opens inside the warm-up is not a restart
  // question, and its green is an ordinary transition.
  await heardRed(CRIT_B);
  alerts = [WARN_K]; // the critical is between two readings at the first tick
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the warning adopted below the heard red');
  assert.ok(b.has(RESTORED));
  offset += ABSENT_HOLD + 5 * SEC; // gone the absent hold since the boot: released
  await sleep(60);
  alerts = [WARN_K, CRIT_B]; // back, loud
  await until(b, () => b.has('red suppressed — this standing fault was already announced'), 'the replay muted');
  assert.equal(played(b, 'red'), 0);
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the hold, inside the warm-up');
  assert.ok(b.has(HOLD_LINE), 'held between readings');
  offset += ABSENT_HOLD + 5 * SEC;
  await sleep(60);
  offset += DWELL + 5 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear on its due tick');
  assert.ok(!b.has(HELD_FOR_RECOVERY), 'never held for a recovery');
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(announces, 2);
});

test('★ seam review: a restored critical still on record that holds nothing (a policy mute) does not make a hold another critical holds a restart question', async () => {
  const CRIT_B3: Alert = { ...CRIT_B, id: 'vdiff-crit-DPU-B-3' } as Alert;
  const BENCH_B: Alert = { ...CRIT_B, annunciate: false, muteReason: 'an expected-offline bench spare' } as Alert; // no mutedBy
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [CRIT_B3, CRIT_B]; // B3 is the one named aloud
  await until(a, () => a.mon.status().conditionSpoken === true && a.mon.status().conditionLevel === 'red', 'a heard red');
  a.stop();
  offset += 2 * MIN;

  alerts = [WARN_K, BENCH_B]; // B stands on under a policy mute (on record, holding nothing); B3 is between readings
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  assert.ok(b.has(`2 ${RESTORED}`));
  offset += ABSENT_HOLD + 5 * SEC; // B3 released; B still on record
  await sleep(60);
  alerts = [WARN_K, BENCH_B, CRIT_B3]; // B3 back, loud: the replay is muted
  await until(b, () => b.has('red suppressed — this standing fault was already announced'), 'the replay muted');
  alerts = [BENCH_B];
  await until(b, () => b.has('red → green held'), 'the hold, inside the warm-up');
  assert.ok(b.has(HOLD_LINE), 'held by B3, between readings');
  offset += ABSENT_HOLD + 5 * SEC;
  await sleep(60);
  offset += DWELL + 5 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear on its due tick');
  assert.ok(!b.has(HELD_FOR_RECOVERY));
  assert.ok(!b.has(WARMUP_ENDED));
});

test('★★ seam review: a restored critical that holds a green only after the warm-up is no restart decision either: the green is an ordinary transition', async () => {
  await heardRed(CRIT_B);
  alerts = [CRIT_B]; // still loud at the boot: the replay gate mutes it
  settledSince = null;
  const b = rig();
  await until(b, () => b.has('red suppressed — this standing fault was already announced'), 'the replay muted');
  assert.ok(b.has(RESTORED));
  offset += 11 * MIN; // past the warm-up, still loud
  await sleep(60);
  alerts = [HELD_B]; // the knee mute: the hold begins after the warm-up
  await until(b, () => b.has('red → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE));
  alerts = [];
  await sleep(60);
  offset += ABSENT_HOLD + 5 * SEC;
  await sleep(60);
  offset += DWELL + 5 * SEC;
  await until(b, () => played(b, 'green') === 1, 'the all-clear on its due tick');
  assert.ok(!b.has(HELD_FOR_RECOVERY));
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(announces, 2);
});

test('★★ seam review: past the warm-up that green has the patience the warm-up gives — a settled stamp reset just before its due tick is waited for, up to one more dwell', async () => {
  await heardRed(CRIT_B);
  alerts = [WARN_K];
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  offset += ABSENT_HOLD + 5 * SEC; // released ~7 min after the boot: the green clock starts
  await sleep(60);
  offset += DWELL - 30 * SEC;
  await sleep(60);
  settledSince = Date.now(); // a transient onset (dpu-err, mppt-err, reserve-alarm-blind) resets the stamp
  offset += 35 * SEC; // the due tick, past the warm-up: settled only 35 s
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery');
  assert.ok(b.has('the alert set has been settled only'));
  await sleep(60);
  assert.ok(!b.has(WARMUP_ENDED), 'not adopted on the due tick');
  assert.equal(played(b, 'green'), 0);
  offset += DWELL - 30 * SEC; // it has now stood the dwell on the settled set
  await until(b, () => played(b, 'green') === 1, 'the all-clear, a recovery');
  assert.ok(b.has(`${RECOVERY} red`));
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(announces, 2);
});

test('★★ seam review (LOW): a red spoken after the restart whose green is still held for a recovery when the warm-up ends is announced then, not adopted silently', async () => {
  // An inverter-error critical holds nothing once cleared, so its green stood the dwell inside the
  // warm-up and was held there for a recovery on a set that never settled. Adopted silently when
  // the warm-up ended, the red the house heard after the restart stayed the last words.
  await heard('yellow');
  alerts = [];
  settledSince = null;
  const b = rig();
  await sleep(80);
  alerts = [CRIT_A];
  await until(b, () => played(b, 'red') === 1, 'the red');
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the hold');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery: the set is not settled');
  assert.ok(b.has('if the warm-up ends first it is announced as a transition (a red condition was audible after the restart) once the set has settled, or at the latest 16 min after the boot'), 'the held line says what follows');
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'not inside the warm-up');
  offset += 8 * MIN; // past the warm-up
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'v1.187.4: held while the set is not settled');
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'not on an unsettled set before the restarted onset windows have run');
  offset += 5 * MIN; // boot + 16 min
  await until(b, () => played(b, 'green') === 1, 'the all-clear once the restarted onset windows have run');
  assert.ok(b.has('condition was audible after the restart'));
  assert.ok(!b.has(WARMUP_ENDED));
  assert.equal(b.mon.status().lastLevel, 'green', 'the last words are not the cleared red');
  assert.equal(announces, 3);
});

/* ══ v1.187.4: the warm-up-end decision waits for a settled set (or the restarted onset windows) ══ */

/** v1.187.4 — after the boot a red reaches the house by `deliver`, clears, and its green stands the
 *  dwell on a set that is not settled: held for a recovery inside the warm-up. */
async function heldGreenAfterRed(b: Rig, deliver: () => Promise<void>): Promise<void> {
  await sleep(80); // the boot green
  alerts = [CRIT_A];
  await deliver();
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the hold');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery: the set is not settled');
}
const redPlayed = (b: Rig) => () => until(b, () => played(b, 'red') === 1, 'the red');

test('★★★ 10-02 lead: a green held past the warm-up is not announced before the restarted reserve-blind clock has run — the warning it hid returns with no "All clear" before it', async () => {
  // The heard yellow is the reserve-blind warning; after the restart the pool still reads unknown,
  // and its 15-min onset clock restarted at the boot, so the warning is withheld until boot + 15 and
  // the set is not settled. Before v1.187.4 the green was announced at the end of the warm-up
  // ("All clear", boot + ~11) because a red had been heard after the restart, and the warning the
  // house had heard before it was spoken again at boot + 15.
  await heard('yellow');
  settledSince = null;
  const b = rig();
  await heldGreenAfterRed(b, redPlayed(b));
  offset += 8 * MIN; // the warm-up has ended
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'still held past the warm-up');
  await sleep(80);
  assert.equal(played(b, 'green'), 0, '★ no "All clear" at the end of the warm-up');
  assert.equal(b.mon.status().conditionLevel, 'red', 'nothing committed');
  offset += 3 * MIN + 30 * SEC; // boot + 15: the clock has run and the warning is published again
  alerts = [WARN_RB];
  await until(b, () => played(b, 'yellow') === 1, 'the warning, new below the cleared red');
  await sleep(80);
  assert.equal(b.count(GREEN_SPOKEN), 0, 'no all-clear before it, nor after it');
  assert.equal(announces, 3, 'the pre-restart yellow, the red, the warning');
  assert.equal(b.mon.status().lastLevel, 'yellow', 'the last words are the warning that stands');
});

test('★★ …a set that settles past the warm-up decides the held green then: the red heard after the restart gets its all-clear at once, not at the bound', async () => {
  await heard('yellow');
  settledSince = null;
  const boot = Date.now();
  const b = rig();
  await heldGreenAfterRed(b, redPlayed(b));
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'still held past the warm-up');
  settledSince = Date.now(); // the pool reads again: nothing is withheld
  await until(b, () => played(b, 'green') === 1, 'the all-clear on the settled set');
  assert.ok(Date.now() - boot < DECISION_DUE, 'before the bound');
  assert.ok(b.has('a red condition was audible after the restart — announced as a transition'));
  assert.equal(b.mon.status().lastLevel, 'green');
});

test('★★ the bound is the restarted onset window plus a margin: still held 30 s past boot + 15 min (the warning reaches the set only at the next alert pass), decided at boot + 16', async () => {
  await heard('yellow');
  settledSince = null;
  const boot = Date.now();
  const b = rig();
  await heldGreenAfterRed(b, redPlayed(b));
  offset += boot + LONGEST_RESTARTED_ONSET_MS + 30 * SEC - Date.now();
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held');
  await sleep(100);
  assert.equal(played(b, 'green'), 0, '★ not at the window itself');
  offset += boot + DECISION_DUE + SEC - Date.now();
  await until(b, () => played(b, 'green') === 1, 'decided at the bound: a set that never settles cannot hold the green for good');
  assert.equal(B.RESTARTED_ONSET_HOLD_MARGIN_MS, MIN);
  assert.equal(LONGEST_RESTARTED_ONSET_MS, 15 * MIN, 'the backup pool\'s reserve-blind window');
});

test('★★ nothing audible since the boot: the held green waits too, and the heard warning that returns at boot + 15 is a flicker the hold absorbs — not said again', async () => {
  await heard('yellow');
  alerts = [WARN_RB];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held for its recovery');
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'still held past the warm-up');
  offset += 3 * MIN + 30 * SEC;
  alerts = [WARN_RB]; // published again once the restarted clock has run
  await until(b, () => b.has('again (flicker absorbed, nothing spoken)'), 'absorbed by the hold');
  await sleep(80);
  assert.equal(announces, 1, 'the warning heard before the restart is not repeated');
  assert.equal(b.mon.status().conditionLevel, 'yellow');
  assert.equal(b.mon.status().conditionSpoken, true, 'heard: the hold had only demoted it');
  assert.ok(!b.has(WARMUP_ENDED));
});

/* ══ v1.187.4: "audible since the boot", not "played without an error" ═══════════════════ */

test('★★★ a red heard as the tone alone (its spoken render failed) was audible after the restart: its held green is announced, not adopted silently', async () => {
  await heard('yellow');
  settledSince = null;
  const b = rig();
  ttsFails = true;
  await heldGreenAfterRed(b, () => until(b, () => b.has('falling back to chime-only so the red condition still sounds') && b.has('broadcast: red → 2 error(s)'), 'the red, the tone alone'));
  ttsFails = false;
  assert.ok(b.has('announced as a transition (a red condition was audible after the restart)'), 'the held line says so');
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held past the warm-up');
  settledSince = Date.now();
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(!b.has(WARMUP_ENDED), 'not adopted in silence after the klaxon');
});

test('★★★ a red that reached only the SIP cordless (every speaker unavailable) was audible after the restart: its held green is announced', async () => {
  await heard('yellow');
  process.env.BROADCAST_SIP_TARGETS = 'media_player.cordless';
  settledSince = null;
  const b = rig();
  maState = 'unavailable';
  await heldGreenAfterRed(b, () => until(b, () => b.has('broadcast: red deferred') && b.has('SIP announce → 1 target(s)'), 'the red, on the cordless only'));
  maState = 'idle';
  assert.ok(b.has('announced as a transition (a red condition was audible after the restart)'));
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held past the warm-up');
  settledSince = Date.now();
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  assert.ok(!b.has(WARMUP_ENDED));
});

test('★★ …but a red the cordless refused while every speaker was unavailable was not audible: adopted silently', async () => {
  await heard('yellow');
  process.env.BROADCAST_SIP_TARGETS = 'media_player.cordless';
  sipStatus = 500;
  settledSince = null;
  const b = rig();
  maState = 'unavailable';
  await heldGreenAfterRed(b, () => until(b, () => b.has('broadcast: red deferred') && b.has('SIP play_media failed for 1/1'), 'the red, heard nowhere'));
  maState = 'idle';
  assert.ok(b.has('adopted silently as a continuation once the set has settled'));
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held past the warm-up');
  settledSince = Date.now();
  await until(b, () => b.has(WARMUP_ENDED), 'adopted silently');
  assert.equal(played(b, 'green'), 0);
});

test('★★ a red the cordless played though its HTTP response was lost (the entity state confirms it, 8 s on) was audible: announced', { timeout: 60_000 }, async () => {
  await heard('yellow');
  process.env.BROADCAST_SIP_TARGETS = 'media_player.cordless';
  sipTimeout = true;
  cordlessState = 'playing'; // the announce call is ringing through
  settledSince = null;
  const b = rig();
  maState = 'unavailable';
  await heldGreenAfterRed(b, () => until(b, () => b.has('SIP delivery confirmed via entity state after an HTTP timeout'), 'the probe confirming the cordless played', 20_000));
  maState = 'idle';
  assert.ok(b.has('announced as a transition (a red condition was audible after the restart)'));
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held past the warm-up');
  settledSince = Date.now();
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
});

test('★★ a red Music Assistant returned in under 2 s was not audible (HA answered without playing): adopted silently', async () => {
  await heard('yellow');
  settledSince = null;
  const b = rig();
  tooFast = true;
  await heldGreenAfterRed(b, () => until(b, () => b.has('too fast for real playback'), 'the red, unverified'));
  tooFast = false;
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held past the warm-up');
  settledSince = Date.now();
  await until(b, () => b.has(WARMUP_ENDED), 'adopted silently');
  assert.equal(played(b, 'green'), 0);
});

test('★★ an operator TEST red after the restart, on the speakers and the cordless, is no condition heard: the held green is adopted silently', async () => {
  await heard('yellow');
  process.env.BROADCAST_SIP_TARGETS = 'media_player.cordless';
  alerts = [WARN_K];
  settledSince = null;
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  const t = await b.mon.test('red');
  assert.ok(t.ok, 'the test played');
  await until(b, () => sipPlays >= 1, 'and reached the cordless');
  alerts = [];
  await until(b, () => b.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(b, () => b.has(HELD_FOR_RECOVERY), 'held');
  assert.ok(b.has('adopted silently as a continuation once the set has settled'));
  offset += 8 * MIN;
  await until(b, () => b.has(WAITS_PAST_WARMUP), 'held past the warm-up');
  settledSince = Date.now();
  await until(b, () => b.has(WARMUP_ENDED), 'adopted silently');
  assert.equal(played(b, 'green'), 0);
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

test('★★ a status file written before v1.187.3 (no sounded record) under a committed red: the criticals of the red announcement on record are seeded', async () => {
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

test('★★ …but not below a committed yellow: a red announcement on record below a heard yellow seeds nothing', async () => {
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

test('★★ log review (LOW): the upgrade restart inside a hold — a status file written before v1.187.3 under a committed red the hold had made unheard still seeds the red announcement\'s criticals', async () => {
  // The hold demotes the heard flag exactly while a sounded critical is muted, so a fallback keyed on
  // a HEARD red seeded nothing when the upgrade restart landed inside such a hold: the warning
  // standing beside the muted critical was spoken, it cleared, and "All clear" followed with the
  // knee-muted critical's card open.
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [CRIT_B, WARN_K];
  await until(a, () => played(a, 'red') === 1 && a.mon.status().conditionSpoken === true, 'a heard red');
  alerts = [HELD_B, WARN_K]; // the knee mute is back; the warning was counted at the red
  await until(a, () => a.has('red → yellow held'), 'the hold');
  assert.ok(a.has(HOLD_LINE));
  assert.equal(a.mon.status().conditionLevel, 'red');
  assert.equal(a.mon.status().conditionSpoken, false, 'the hold demoted the heard flag');
  a.stop();
  offset += 2 * MIN;
  const evidence = JSON.parse(readFileSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, 'utf8'));
  assert.deepEqual(evidence.activeFingerprints, [alertFingerprint(CRIT_B)], 'no green observed: the red announcement is still on record');
  const s = statusFile();
  delete s.soundedCrit; // as v1.187.2 wrote it
  writeFileSync(STATUS_PATH, JSON.stringify(s));

  alerts = [WARN_K, HELD_B];
  const b = rig();
  await until(b, () => b.has('yellow held for boot confirmation'), 'the boot yellow hold');
  assert.equal(b.mon.status().bootBaselineLevel, null, 'no heard baseline');
  assert.ok(b.has(`${RESTORED} from the red announcement on record`));
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5 * SEC;
  await until(b, () => played(b, 'yellow') === 1, 'the warning');
  alerts = [HELD_B];
  await until(b, () => b.has('yellow → green held'), 'the hold');
  assert.ok(b.has(HOLD_LINE), 'held as in one process');
  offset += DWELL + 10 * MIN;
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'no all-clear with the muted critical\'s card open');
  assert.equal(announces, 2);
});

test('★★ log review (LOW): a status file written before v1.187.3 under a committed red seeds only cell-spread criticals (no other critical can hold after a restart)', async () => {
  await heard('red'); // CRIT_A, an inverter error code
  const s = statusFile();
  delete s.soundedCrit;
  writeFileSync(STATUS_PATH, JSON.stringify(s));
  const evidence = JSON.parse(readFileSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, 'utf8'));
  assert.deepEqual(evidence.activeFingerprints, [alertFingerprint(CRIT_A)]);
  const b = rig();
  await sleep(80);
  assert.equal(b.mon.status().bootBaselineLevel, 'red');
  assert.ok(!b.has(RESTORED), 'nothing seeded: the boot line would name a critical that holds nothing');
});

test('★★ log review (LOW): restarts less than the absent hold apart do not renew an absent critical\'s record — the restore bound counts from when it was last present', async () => {
  // Each boot stamps a restored entry at the boot (the outage is not absence), and that stamp was
  // written back at the first tick: restarted every 5 minutes, an absent cell-spread critical stayed
  // restorable for ever and held each green behind it.
  await heardRed(CRIT_B);
  const fp = alertFingerprint(CRIT_B);
  const lastPresent = (statusFile().soundedCrit as Record<string, number>)[fp];
  alerts = []; // gone for good
  let restarts = 0;
  while (Date.now() + 5 * MIN - lastPresent <= B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS) {
    const r = rig();
    await until(r, () => r.has(RESTORED), `restore ${restarts + 1}`);
    await sleep(60); // the first ticks (and their write) have run
    assert.equal((statusFile().soundedCrit as Record<string, number>)[fp], lastPresent, `restart ${restarts + 1}: the disk keeps when it was last present, not the boot`);
    r.stop();
    restarts += 1;
    offset += 5 * MIN;
  }
  assert.ok(restarts >= 11, `${restarts} restarts`);
  offset += 5 * MIN; // past the bound from when it was last present
  const z = rig();
  await sleep(80);
  assert.ok(!z.has(RESTORED), 'not restored: last present more than the bound ago');
});

test('★★ …a restored critical present again carries its new last-present time to disk', async () => {
  await heardRed(CRIT_B);
  const fp = alertFingerprint(CRIT_B);
  const before = (statusFile().soundedCrit as Record<string, number>)[fp];
  alerts = [WARN_K, HELD_B]; // present again, muted by its knee mute
  const b = rig();
  await until(b, () => b.has(CONTINUATION), 'the continuation');
  offset += 2 * MIN; // past the refresh cadence
  await sleep(80);
  const after = (statusFile().soundedCrit as Record<string, number>)[fp];
  assert.ok(after >= before + 4 * MIN, `refreshed by the observation after the restart (${Math.round((after - before) / 1000)} s later)`);
});

test('★ …and a last-present time from the future (the clock stepped back) is written back no later than the boot', async () => {
  await heardRed(CRIT_B);
  const fp = alertFingerprint(CRIT_B);
  const s = statusFile();
  s.soundedCrit = { [fp]: Date.now() + 30 * MIN };
  writeFileSync(STATUS_PATH, JSON.stringify(s));
  alerts = []; // not observed since (an observation would write its own time)
  const boot = Date.now();
  const b = rig();
  await until(b, () => b.has(RESTORED), 'restored');
  await sleep(60);
  const onDisk = (statusFile().soundedCrit as Record<string, number>)[fp];
  assert.ok(onDisk >= boot && onDisk <= Date.now(), 'the boot, not 30 minutes ahead');
});

test('★★ log review (LOW): only cell-spread criticals are written — a standing critical whose fault code flips no longer rewrites the status file on every flip, nor every minute', async () => {
  const CRIT_A8: Alert = { ...CRIT_A, fault: 'err8' } as Alert;
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  alerts = [CRIT_A];
  await until(a, () => played(a, 'red') === 1, 'red (err7)');
  assert.deepEqual(statusFile().soundedCrit, {}, 'a sounded inverter error is not written');
  offset += 11 * MIN; // past the identical-message gap (the spoken text does not carry the code)
  alerts = [CRIT_A8];
  await until(a, () => played(a, 'red') === 2, 'the other fault code, announced once');
  offset += 3 * MIN;
  alerts = [CRIT_A];
  await sleep(60);
  assert.equal(played(a, 'red'), 2, 'each code announced once per episode');
  const s = statusFile();
  s.sentinel = 'untouched';
  writeFileSync(STATUS_PATH, JSON.stringify(s));
  for (let i = 0; i < 4; i += 1) {
    alerts = [CRIT_A8];
    await sleep(40);
    alerts = [CRIT_A];
    await sleep(40);
  }
  assert.equal(statusFile().sentinel, 'untouched', 'no write on a flip');
  offset += 2 * MIN; // past the refresh cadence, the critical standing
  await sleep(60);
  assert.equal(statusFile().sentinel, 'untouched', 'no minute refresh for a critical that cannot hold after a restart');
  assert.equal(played(a, 'red'), 2);
});

test('restoreSoundedCriticals — a record object only; well-formed cell-spread fingerprints with a finite last-present time at most the bound old, each stamped at the boot', () => {
  const boot = 90_000_000;
  const fp = alertFingerprint(CRIT_B);
  const fpA = alertFingerprint(CRIT_A);
  const fpB3 = alertFingerprint({ ...CRIT_B, id: 'vdiff-crit-DPU-B-3' });
  const max = B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS;
  assert.equal(B.restoreSoundedCriticals(undefined, boot), null, 'a status file written before v1.187.3');
  assert.equal(B.restoreSoundedCriticals(null, boot), null);
  assert.equal(B.restoreSoundedCriticals('x', boot), null);
  assert.equal(B.restoreSoundedCriticals([[fp, boot]], boot), null, 'an array is not the record');
  assert.deepEqual([...B.restoreSoundedCriticals({}, boot)!], [], 'a v1.187.3 record with nothing sounded');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: boot - max, [fpB3]: boot - 5 * MIN }, boot)!], [[fp, boot], [fpB3, boot]], 'inclusive bound; stamped at the boot');
  // log review (LOW): only a cell-spread critical can hold after a restart (soundedCritPersists).
  assert.deepEqual([...B.restoreSoundedCriticals({ [fpA]: boot - 5 * MIN, [fp]: boot }, boot)!], [[fp, boot]], 'a critical that is not a cell-spread critical is not restored');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: boot - max - 1 }, boot)!], [], 'one ms past the bound');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: boot + 5 * MIN }, boot)!], [[fp, boot]], 'a future stamp (the clock stepped back) is restored at the boot, not in the future');
  assert.deepEqual([...B.restoreSoundedCriticals({ 'vdiff-crit-DPU-B-2': boot }, boot)!], [], 'a bare id is not a fingerprint');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: '123' }, boot)!], [], 'not a number');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: Infinity }, boot)!], [], 'not finite');
  assert.deepEqual([...B.restoreSoundedCriticals({ [fp]: -Infinity }, boot)!], [], 'not finite');
  assert.equal(B.SOUNDED_CRIT_RESTORE_MAX_AGE_MS, 60 * MIN, 'VDIFF_KNEE_GAP_CARRY_MS: the longest outage a knee session survives');
  assert.equal(B.SOUNDED_CRIT_PERSIST_EVERY_MS, MIN);
});

test('soundedCritPersists — the cell-spread criticals only (the only ones that can hold after a restart)', () => {
  assert.equal(B.soundedCritPersists(alertFingerprint(CRIT_B)), true);
  assert.equal(B.soundedCritPersists(alertFingerprint(CRIT_A)), false, 'an inverter error code');
  assert.equal(B.soundedCritPersists(alertFingerprint({ id: 'vdiff-warn-DPU-B-2', title: 'Cell imbalance' })), false, 'the warning of the same family');
  assert.equal(B.soundedCritPersists(alertFingerprint({ id: 'shp2-src-err-X-1', title: 'Source error', fault: 'e3' })), false);
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
