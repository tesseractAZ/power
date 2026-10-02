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
 * Now (broadcast.conditionRetryStale) a condition retry runs only while the CONDITION EPISODE it was
 * requested in is current — advanced by every commit that changes the level — checked when it RUNS,
 * since it can wait in the single-flight chain; a stale one never holds the slot against a newer
 * deferral. Not the level (review): a warning spoken while the committed level stays red (a held
 * sounded cell-spread critical, keepRed) belongs to the red's episode and is retried, and a red →
 * green → red sequence makes the first red's retry stale. A held de-escalation commits nothing, so a
 * red retried while its clearing stands the dwell still plays (fail-loud). A dedicated announcement
 * (SoC ladder, runway, notices) is not the condition and is unchanged.
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
/** A different critical, on another Core. */
const CRIT_C: Alert = { id: 'dpu-err-DPU-C', severity: 'critical', category: 'Battery', device: 'Core 3', title: 'Inverter error code', detail: 'x', fault: 'err3' } as Alert;
/** A cell-spread critical, loud, and on a later reading held by the balancing mute (as alerts.ts stamps it). */
const CRIT_B: Alert = { id: 'vdiff-crit-DPU-B-2', severity: 'critical', category: 'Battery', device: 'Core 2', title: 'Cell imbalance', detail: 'spread 101 mV' } as Alert;
const HELD_B: Alert = { ...CRIT_B, annunciate: false, mutedBy: 'balancing', muteReason: 'the BMS is balancing the cells', detail: 'spread 95 mV BMS is actively balancing the cells.' } as Alert;
const WARN_N: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Pack state of charge low', detail: 'x' } as Alert;
/** Excluded from the condition count but a critical: a green commits while the all-clear speech gate holds it (silent). */
const RESERVE: Alert = { id: 'shp2-below-reserve-SHP2-P', severity: 'critical', category: 'SHP2', device: 'SHP2', title: 'At reserve', detail: 'x' } as Alert;

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  count: (s: string) => number;
  stop: () => void;
}
const live: Rig[] = [];
/** A monitor past its boot warm-up, its deferred retries `retryMs` apart (real time). */
async function started(retryMs: number | number[], pastWarmup = true): Promise<Rig> {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-stale-retry-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    retryDelaysMs: Array.isArray(retryMs) ? retryMs : [retryMs, retryMs, retryMs],
  });
  const r: Rig = {
    mon, logs,
    has: (s) => logs.some((l) => l.includes(s)),
    count: (s) => logs.filter((l) => l.includes(s)).length,
    stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); },
  };
  live.push(r);
  await sleep(80); // the first tick joins green
  if (pastWarmup) offset += 20 * MIN; // past the boot warm-up window (and any restart question)
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
const DROPPED = 'deferred red retry dropped — a newer condition (green) has been committed since';

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
  await until(r, () => r.has('superseding the pending red retry with green (stale: a newer condition, green, has been committed since)'), 'the green superseding the stale red');
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

test('★★★ review: a NEW warning spoken while the committed level stays red (a held sounded critical) is retried — it belongs to the red\'s episode', async () => {
  const r = await started(300);
  alerts = [CRIT_B];
  await until(r, () => played(r, 'red') === 1, 'the cell-spread red');
  alerts = [HELD_B]; // held by the balancing mute: held, not cleared
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN;
  speakerState = 'unavailable';
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('condition transition → yellow (new warning) spoken; the committed condition stays red'), 'the new warning (keepRed)');
  await until(r, () => r.has('broadcast: yellow deferred') && r.has('deferred retry 1/3'), 'it defers');
  speakerState = 'idle';
  await until(r, () => played(r, 'yellow') === 1, '★ the warning, still standing, reaches the speakers');
  assert.ok(!r.has('retry dropped'));
});

test('★★★ review: red → green (committed in silence) → a different red: the first red\'s retry is stale — the second gets its own retries, and the first\'s text is never replayed', async () => {
  const r = await started(150);
  speakerState = 'unavailable';
  alerts = [CRIT];
  await until(r, () => r.has('deferred retry 2/3'), 'the first red retrying');
  alerts = [RESERVE];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += DWELL + SEC;
  await until(r, () => r.has('green adopted silently — a critical alert is still active'), 'the green committed in silence');
  alerts = [RESERVE, CRIT_C];
  await until(r, () => r.has('condition transition → red'), 'the second red, a new episode');
  speakerState = 'idle';
  await until(r, () => played(r, 'red') === 1, 'a red reaching the speakers');
  await sleep(500);
  assert.ok(!r.has('giving up after 3 deferred red retries'), 'never "given up" with no attempt of its own');
  assert.equal(played(r, 'red'), 1);
  assert.match(String(r.mon.status().lastSpokenMessage), /Inverter/, '★ the standing critical is what was spoken, not the cleared one');
});

test('★★★ review (A1): a red never audible that returns while its clearing stands the dwell is spoken — not absorbed as a flicker', async () => {
  const r = await started(20);
  speakerState = 'unavailable';
  alerts = [CRIT];
  await until(r, () => r.has('giving up after 3 deferred red retries'), 'the red, never delivered');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  speakerState = 'idle';
  alerts = [CRIT]; // back inside the dwell
  await until(r, () => played(r, 'red') === 1, '★ the red, never heard, spoken now');
  assert.ok(r.has('never audible in this episode — presented again as a transition'));
});

test('★★ …while a red the house HEARD that returns inside the dwell is still a flicker — nothing re-spoken', async () => {
  const r = await started(300);
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  alerts = [CRIT];
  await until(r, () => r.has('again (flicker absorbed, nothing spoken)'), 'absorbed');
  await sleep(100);
  assert.equal(played(r, 'red'), 1);
});

test('★★ a heard yellow, then a red nobody heard: the red\'s audibility is its own — when it clears and returns inside the dwell it is spoken', async () => {
  const r = await started(20);
  alerts = [WARN_N];
  await until(r, () => played(r, 'yellow') === 1, 'the heard yellow');
  speakerState = 'unavailable';
  alerts = [CRIT, WARN_N];
  await until(r, () => r.has('giving up after 3 deferred red retries'), 'the red, never delivered');
  alerts = [WARN_N]; // the red clears to the yellow the house heard
  await until(r, () => r.has('red → yellow held'), 'the hold');
  speakerState = 'idle';
  alerts = [CRIT]; // the red is back inside the dwell
  await until(r, () => played(r, 'red') === 1, '★ the red, never heard, spoken now');
});

test('★★ a red retry survives a warning spoken while the committed level stays red — the same episode (a level change starts a new one, a same-level commit does not)', async () => {
  const r = await started(1200);
  speakerState = 'unavailable';
  alerts = [CRIT_B];
  await until(r, () => r.has('broadcast: red deferred') && r.has('deferred retry 1/3'), 'the cell-spread red deferring');
  alerts = [HELD_B]; // held by the balancing mute
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN;
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('condition transition → yellow (new warning) spoken; the committed condition stays red'), 'the warning under the kept red');
  speakerState = 'idle';
  await until(r, () => played(r, 'red') === 1, '★ the red nobody heard, retried: still the committed condition');
  assert.ok(!r.has('red retry dropped'));
});

test('★★★ review: red A → red C on one tick (one episode): C takes the slot with its own retries — no "giving up" with no attempt, and A\'s cleared text is never spoken', async () => {
  const r = await started(150);
  speakerState = 'unavailable';
  alerts = [CRIT];
  await until(r, () => r.has('deferred retry 3/3'), 'red A at its third retry');
  alerts = [CRIT_C]; // A clears and C appears on the same tick: red stays red
  await until(r, () => r.count('condition transition → red') >= 2, 'red C, a new critical');
  await until(r, () => r.has('superseding the pending red retry with red (a newer announcement of the condition)'), '★ C takes the slot');
  speakerState = 'idle';
  await until(r, () => played(r, 'red') === 1, 'a red reaching the speakers');
  await sleep(300);
  assert.ok(!r.has('giving up after 3 deferred red retries'));
  assert.equal(played(r, 'red'), 1);
  assert.match(String(r.mon.status().lastSpokenMessage), /Inverter/, 'the standing critical C');
});

test('★★★ review: …and when C reaches the speakers, A\'s retry still armed is cancelled — it does not replay the cleared critical once the same-level gap has passed', async () => {
  const r = await started([150, 150, 2500]);
  speakerState = 'unavailable';
  alerts = [CRIT];
  await until(r, () => r.has('deferred retry 3/3'), 'red A, its third retry 2.5 s away');
  speakerState = 'idle';
  alerts = [CRIT_C];
  await until(r, () => played(r, 'red') === 1, 'red C played');
  assert.ok(r.has('the pending red retry is cancelled — this red announcement of the condition reached the speakers'), '★ the old retry is cancelled');
  offset += 2 * MIN + 30 * SEC; // past the same-level storm gap
  await sleep(3000); // A's third retry would have fired by now
  assert.equal(played(r, 'red'), 1);
  assert.match(String(r.mon.status().lastSpokenMessage), /Inverter/, '★ the last words name the standing critical, not the cleared one');
});

test('★★★ review (P8): an unheard red that returns inside the warm-up is held one tick for its boot confirmation — and then spoken, not lost', async () => {
  const r = await started(100, false);
  speakerState = 'unavailable';
  alerts = [CRIT];
  await until(r, () => r.has('giving up after 3 deferred red retries'), 'the red unheard, its retries spent');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  speakerState = 'idle';
  alerts = [CRIT];
  await until(r, () => r.has('never audible in this episode — presented again'), 'the unheard return');
  await until(r, () => played(r, 'red') === 1, '★ spoken after its boot confirmation');
  assert.equal(r.count('never audible in this episode'), 1, 'said once');
});

test('conditionRetryStale — a condition retry of an episode that is no longer current; never a dedicated or test broadcast', () => {
  assert.equal(B.conditionRetryStale('condition', 3, 4), true);
  assert.equal(B.conditionRetryStale('condition', 3, 3), false);
  assert.equal(B.conditionRetryStale('dedicated', 3, 4), false);
  assert.equal(B.conditionRetryStale('test', 3, 4), false);
});
