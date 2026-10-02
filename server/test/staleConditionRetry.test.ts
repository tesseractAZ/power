/**
 * v1.187.4 — a deferred retry of a CONDITION broadcast replays its level only while the condition is
 * still committed there. Driven through the REAL broadcast monitor (startBroadcastMonitor) with Home
 * Assistant mocked at the HTTP layer, the Wyoming renderer injected, a controllable clock, and the
 * retry delays shortened through the test seam (BroadcastMonitorOpts.retryDelaysMs).
 *
 * THE DEFECT. A condition broadcast that finds no usable speaker (Music Assistant restarting) arms a
 * deferred retry (scheduleBroadcastRetry: 30, 90, 180 s) that replays the level and text it was armed
 * with. Nothing re-checked the condition when it fired:
 *   • a red whose critical cleared, and whose green had been committed and spoken while the retry
 *     waited, was spoken AFTER the all-clear — the last words in the house a critical that had
 *     cleared;
 *   • a green committed while the speakers were still away deferred too, and was "kept pending" in
 *     favour of the red retry (retrySlotDecision: a lower level never supersedes a higher one): the
 *     green was never retried.
 * Now (broadcast.conditionRetryStale) a condition retry runs only while the committed level is the
 * one it was armed for — checked when it RUNS, since it can wait in the single-flight chain — and a
 * stale one never holds the slot against a newer deferral. A held de-escalation does not move the
 * committed level, so a red retried while its clearing stands the dwell still plays (fail-loud). A
 * dedicated announcement (SoC ladder, runway, notices) is not the condition and is unchanged.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-stale-retry-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha,media_player.beta';
process.env.BROADCAST_SIP_TARGETS = '';
process.env.BROADCAST_ANNOUNCE_VOLUME = 'standing';
process.env.BROADCAST_MIN_SEVERITY = 'warning';
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

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;
const SEC = 1_000;
const DWELL = B.CONDITION_CLEAR_DWELL_MS;

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer: the speakers' state is switchable, and a SLOW play
 *    (1.5 s real) holds the single-flight chain while a retry fires behind it. ── */
let speakerState = 'idle';
let slowPlay = false;
const PLAY = '/core/api/services/music_assistant/play_announcement';
const playReply = () => {
  offset += 30_000; // play_announcement returns when playback ENDS — a real clip plays ~30 s
  return { statusCode: 200, data: '[]' };
};
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/services', method: 'GET' })
  .reply(200, JSON.stringify([{ domain: 'music_assistant', services: { play_announcement: {} } }])).persist();
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(200, '[]').persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply(() => ({ statusCode: 200, data: JSON.stringify({ state: speakerState, attributes: {} }) })).persist();
ha.intercept({ path: (p: string) => p === PLAY && slowPlay, method: 'POST' }).reply(playReply).delay(1500).persist();
ha.intercept({ path: (p: string) => p === PLAY && !slowPlay, method: 'POST' }).reply(playReply).delay(60).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-stale-retry-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;

/** A critical released the tick it clears (not a cell-spread critical, which is held after it clears). */
const CRIT: Alert = { id: 'cell-ovp-COREXXX00XXX0001-1', severity: 'critical', category: 'Battery', device: 'Core 1', coreNum: 1, packNum: 1, title: 'Cell overvoltage', detail: 'highest cell at 3.612 V' } as Alert;

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  count: (s: string) => number;
  stop: () => void;
}
const live: Rig[] = [];
/** A monitor past its boot warm-up, its deferred retries `retryMs` apart (real time). */
async function started(retryMs: number): Promise<Rig> {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-stale-retry-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    retryDelaysMs: [retryMs, retryMs, retryMs],
  });
  const r: Rig = {
    mon, logs,
    has: (s) => logs.some((l) => l.includes(s)),
    count: (s) => logs.filter((l) => l.includes(s)).length,
    stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); },
  };
  live.push(r);
  await sleep(80); // the first tick joins green
  offset += 11 * MIN; // past the boot warm-up window
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
/** A completed broadcast of `level` (a condition, or a dedicated announcement at that level). */
const played = (r: Rig, level: string) => r.count(`broadcast: ${level} → ok in`);
const DROPPED = 'deferred red retry dropped — the condition is green now';

/** A red that finds every speaker unavailable (its retry armed), then clears: the green held. */
async function deferredRedThenCleared(r: Rig): Promise<void> {
  speakerState = 'unavailable';
  alerts = [CRIT];
  await until(r, () => r.has('broadcast: red deferred') && r.has('deferred retry 1/3'), 'the red deferring');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
}

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  alerts = [];
  speakerState = 'idle';
  slowPlay = false;
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ a red retry still pending when its green has been committed and spoken is dropped — never spoken after the all-clear', async () => {
  const r = await started(1500);
  await deferredRedThenCleared(r);
  speakerState = 'idle'; // the speakers are back
  offset += DWELL + SEC;
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
  await until(r, () => r.has(DROPPED), 'the stale retry dropped when it fires');
  await sleep(100);
  assert.equal(played(r, 'red'), 0, '★ the cleared red is not spoken after its all-clear');
  assert.equal(r.mon.status().lastLevel, 'green', 'the last words are the all-clear');
});

test('★★★ a green that defers while a stale red retry is pending takes the slot — it is retried, the red is not', async () => {
  const r = await started(1000);
  await deferredRedThenCleared(r);
  offset += DWELL + SEC; // the green commits; the speakers are still away, so it defers too
  await until(r, () => r.has('superseding the pending red retry with green (stale: the condition is green now)'), 'the green superseding the stale red');
  assert.ok(!r.has('keeping the pending red retry'), 'never kept in favour of a red that has cleared');
  speakerState = 'idle';
  await until(r, () => played(r, 'green') === 1, 'the green retry reaching the speakers');
  await sleep(100);
  assert.equal(played(r, 'red'), 0);
  assert.equal(r.mon.status().lastLevel, 'green');
});

test('★★★ a red retry that fires while its clearing still stands the dwell plays: the red is still the committed condition (fail-loud)', async () => {
  const r = await started(300);
  await deferredRedThenCleared(r);
  speakerState = 'idle';
  await until(r, () => played(r, 'red') === 1, 'the red retry, nobody having heard the red');
  assert.ok(!r.has('retry dropped'));
  assert.equal(r.mon.status().lastLevel, 'red');
});

test('★★ checked when the retry RUNS: one that fired behind a broadcast in flight, and found the green committed by its turn, is dropped', async () => {
  const r = await started(300);
  await deferredRedThenCleared(r);
  speakerState = 'idle';
  slowPlay = true;
  const notice = r.mon.announce('medium', 'A dedicated notice is playing.', null); // holds the chain 1.5 s
  await sleep(450); // the red retry fires meanwhile: committed red then, queued behind the notice
  offset += DWELL + SEC; // the green commits while the retry waits its turn
  await until(r, () => r.has('condition transition → green'), 'the green committing, its broadcast queued behind the retry');
  assert.equal(played(r, 'yellow'), 0, 'the notice is still playing');
  await notice;
  slowPlay = false;
  await until(r, () => r.has(DROPPED), 'the retry dropped at its turn');
  await until(r, () => played(r, 'green') === 1, 'the all-clear after it');
  assert.equal(played(r, 'red'), 0, '★ not played: by its turn the condition was green');
});

test('★★ a DEDICATED announcement\'s retry is not a condition retry: it plays whatever the condition', async () => {
  const r = await started(300);
  speakerState = 'unavailable';
  const first = await r.mon.announce('critical', 'Backup reserve at ten percent.', null);
  assert.equal(first.ok, false, 'deferred: no usable speaker');
  speakerState = 'idle';
  await until(r, () => played(r, 'red') === 1, 'its retry, with the condition green');
  assert.ok(!r.has('retry dropped'));
});

test('conditionRetryStale — a condition retry whose level is not the committed one; never a dedicated or test broadcast', () => {
  assert.equal(B.conditionRetryStale('condition', 'red', 'green'), true);
  assert.equal(B.conditionRetryStale('condition', 'red', 'yellow'), true);
  assert.equal(B.conditionRetryStale('condition', 'yellow', 'red'), true, 'a rise is spoken by its own transition');
  assert.equal(B.conditionRetryStale('condition', 'red', 'red'), false);
  assert.equal(B.conditionRetryStale('condition', 'green', null), true, 'nothing committed');
  assert.equal(B.conditionRetryStale('dedicated', 'red', 'green'), false);
  assert.equal(B.conditionRetryStale('test', 'red', 'green'), false);
});
