/**
 * v1.187.9 — a deferred retry of a CONDITION broadcast decides what it says when it RUNS, by the
 * IDENTITY of the alert its words name (broadcast.conditionRetryWords), not by their text. Driven
 * through the REAL broadcast monitor (startBroadcastMonitor) with Home Assistant mocked at the HTTP
 * layer, as in conditionRetryNewestWins.test.ts, plus the SIP cordless (every play_media is recorded
 * with the audio URL it carried) and a speech service that can be stalled (`ttsDown`). One rendered
 * file per tone and text, so a URL says what was played.
 *
 * THE DEFECT (v1.187.5 known limit). A retry replayed the words it was armed with whether or not the
 * alert they name still stood: a red naming A (C standing too) failed and armed; A cleared while C
 * kept the red (C was counted, so nothing new was announced); the retry spoke the cleared A, and C
 * was never named. A retry already waiting in the chain when A cleared and C appeared ran ahead of
 * C's own announcement and spoke A. A first fix rebuilt the words whenever their TEXT differed (a
 * reading that moved missed the rendered file, so with the speech service stalled the retry played
 * the tone alone) and left the cordless skipped (it never heard C). Withdrawn in v1.187.5.
 *
 * Now: the same alert replays the armed words (a cache hit) and skips the cordless as armed; a
 * different alert gets the words AND the tone the tick would build now, re-fires the cordless, and
 * passes the tick's identity gates first (repeat warning, red replay); a retry yields to an
 * announcement naming that alert already waiting behind it; an armed alert the tick's speech gates
 * now drop is not replayed; a throw replays the armed words; a failed spoken render earns the tick's
 * spoken retry; a refusal by the same-level gap is re-presented once, never over a waiting one.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-retry-words-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha,media_player.beta';
process.env.BROADCAST_SIP_TARGETS = 'media_player.cordless';
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
const { restampAlertOnset, resetAlertOnsetCacheForTests } = await import('../src/alertOnset.js');
const { buildAlertMessage, buildAlertMessageEs } = await import('../src/ttsService.js');
const { alertFingerprint } = await import('../src/redReplayGate.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const REPLAY_PATH = process.env.BROADCAST_RED_REPLAY_STATE_PATH;
const MIN = 60_000;

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/* ── Home Assistant, mocked at the HTTP layer. Each play_announcement takes the next plan step
 *    (default: 200 at once); a 200 advances the clock 30 s (the call returns when playback ENDS).
 *    Every SIP play_media is recorded and answered 200. ── */
interface PlayStep { status?: number; gate?: Promise<void> }
interface Play { url: string; status: number; done: boolean }
let plan: PlayStep[] = [];
let plays: Play[] = [];
let sips: string[] = [];
let openGates: Array<() => void> = [];
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => { open = res; });
  openGates.push(open);
  return { promise, open };
}
const PLAY = '/core/api/services/music_assistant/play_announcement';
const SIP_PLAY = '/core/api/services/media_player/play_media';
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
ha.intercept({ path: SIP_PLAY, method: 'POST' }).reply((opts) => {
  sips.push(String(JSON.parse(String(opts.body)).media_content_id));
  return { statusCode: 200, data: '[]' };
}).persist();
ha.intercept({ path: PLAY, method: 'POST' }).reply((opts) => {
  const step = plan.shift() ?? {};
  const status = step.status ?? 200;
  const play: Play = { url: String(JSON.parse(String(opts.body)).url), status, done: false };
  plays.push(play);
  return {
    statusCode: status,
    data: () => (step.gate ?? Promise.resolve()).then(() => sleep(60)).then(() => {
      play.done = true;
      if (status === 200) offset += 30_000;
      return status === 200 ? '[]' : '{"message":"Server got itself in trouble"}';
    }),
  };
}).persist();
/** How many plays of `url` reached the speakers (answered 200). */
const heard = (url: string | undefined) => plays.filter((p) => p.url === url && p.status === 200 && p.done).length;

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-retry-words-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
/** The speech service: stalled while `ttsDown` (every render fails, as Wyoming does under load). */
let ttsDown = false;
const renderTts = async () => (ttsDown
  ? { ok: false as const, error: 'wyoming render timeout' }
  : { ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
let storeThrows = false;
const store = {
  get: () => {
    if (storeThrows) throw new Error('snapshot unavailable');
    return { alerts };
  },
} as any;

/** Red A: located, so it is the critical a red names while it stands. */
const CRIT_A: Alert = { id: 'cell-ovp-COREXXX00XXX0001-1', severity: 'critical', category: 'Battery', device: 'Core 1', coreNum: 1, packNum: 1, title: 'Cell overvoltage', detail: 'highest cell at 3.612 V' } as Alert;
/** Critical C, on another Core (no location: named only once A has cleared). */
const CRIT_C: Alert = { id: 'dpu-err-DPU-C', severity: 'critical', category: 'Battery', device: 'Core 3', title: 'Inverter error code', detail: 'code 3 reported' } as Alert;
/** C at ISA High: the tone of a red that names only it is High, not Critical. */
const CRIT_C_HIGH: Alert = { ...CRIT_C, priority: 'high' } as Alert;
/** Critical D, a third one. */
const CRIT_D: Alert = { id: 'dpu-err-DPU-D', severity: 'critical', category: 'Battery', device: 'Core 4', title: 'Battery protection fault', detail: 'code 9 reported', fault: 'err9' } as Alert;
/** A cell-spread critical, and the same alert held by the balancing mute (as alerts.ts stamps it). */
const CRIT_B: Alert = { id: 'vdiff-crit-DPU-B-2', severity: 'critical', category: 'Battery', device: 'Core 2', title: 'Cell imbalance', detail: 'spread 101 mV' } as Alert;
const HELD_B: Alert = { ...CRIT_B, annunciate: false, mutedBy: 'balancing', muteReason: 'the BMS is balancing the cells', detail: 'spread 95 mV BMS is actively balancing the cells.' } as Alert;
const WARN_N: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Pack state of charge low', detail: 'x' } as Alert;
/** A located warning: the one a yellow names while it stands. */
const WARN_L: Alert = { id: 'soc-low-DPU-D-2', severity: 'warning', category: 'Battery', device: 'Core 4', coreNum: 4, packNum: 2, title: 'Pack state of charge low', detail: 'pack at 9 percent' } as Alert;
/** A cell-imbalance warning (located). Inside its speak hold unless an old onset is recorded. */
const IMBALANCE: Alert = { id: 'vdiff-warn-DPU-E-1', severity: 'warning', category: 'Battery', device: 'Core 5', coreNum: 5, packNum: 1, title: 'Cell imbalance', detail: 'spread 60 mV' } as Alert;
const RESERVE = 'Backup reserve at ten percent.';
const NOTICE = 'A dedicated notice is playing.';

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  count: (s: string) => number;
  stop: () => void;
}
const live: Rig[] = [];
/** A monitor, its deferred retries `retryMs` apart (real time); `warm` puts it past the boot warm-up. */
async function started(retryMs: number, warm = true): Promise<Rig> {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-retry-words-cache-'));
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
  if (warm) offset += 20 * MIN; // past the boot warm-up window (and any restart question)
  return r;
}
async function until(r: Rig, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\nplays: ${JSON.stringify(plays)}\nsips: ${JSON.stringify(sips)}\n${r.logs.join('\n')}`);
    await sleep(5);
  }
}
const RETRY_MS = 800;
const ARMED = 'deferred retry 1/3';
const lastWords = (r: Rig) => String(r.mon.status().lastSpokenMessage);

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  for (const open of openGates.splice(0)) open();
  rmSync(STATUS_PATH, { force: true });
  rmSync(REPLAY_PATH!, { force: true });
  rmSync(process.env.ALERT_ONSET_PATH!, { force: true });
  resetAlertOnsetCacheForTests();
  alerts = [];
  plan = [];
  plays = [];
  sips = [];
  ttsDown = false;
  storeThrows = false;
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  for (const open of openGates.splice(0)) open();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ THE DEFECT: the alert a red retry names clears while another critical keeps the red — the retry names the critical that stands, and the cordless hears it', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 }); // the red naming A
  alerts = [CRIT_A, CRIT_C];
  await until(r, () => r.has(ARMED), 'the red naming A failing, its retry armed');
  const urlA = plays[0].url;
  await until(r, () => sips.length === 1, 'the cordless taking the first dispatch');
  assert.equal(sips[0], urlA);
  alerts = [CRIT_C]; // A clears; C, counted with A, keeps the red: nothing new to announce
  await until(r, () => plays.length === 2 && plays[1].done, 'the retry playing');
  await sleep(300);
  assert.equal(r.count('condition transition → red'), 1, 'nothing new was announced: C was counted with A');
  assert.equal(heard(urlA), 0, '★★★ the cleared A is never spoken');
  assert.notEqual(plays[1].url, urlA);
  assert.equal(heard(plays[1].url), 1);
  assert.match(lastWords(r), /Inverter/, '★★★ it names the standing critical C');
  assert.ok(r.has('deferred red retry names dpu-err-DPU-C / Inverter error code'));
  assert.deepEqual(sips, [urlA, plays[1].url], '★★ the cordless, which heard A, hears C');
});

test('★★★ a reading that moves is not a different alarm: with speech stalled, the retry plays the armed words from the rendered file — spoken, not the tone alone — and the cordless is not repeated', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [CRIT_B]; // spread 101 mV
  await until(r, () => r.has(ARMED), 'the red failing, its retry armed');
  const urlB = plays[0].url;
  await until(r, () => sips.length === 1, 'the cordless taking the first dispatch');
  alerts = [{ ...CRIT_B, detail: 'spread 104 mV' } as Alert]; // the same alert; its reading moved
  ttsDown = true; // the speech service stalls
  await until(r, () => heard(urlB) === 1, '★ the retry reaching the speakers');
  await sleep(300);
  assert.equal(plays.length, 2);
  assert.equal(plays[1].url, urlB, '★★★ the armed words, from the rendered file');
  assert.ok(!r.has('falling back to chime-only'), '★★★ spoken, not the tone alone');
  assert.ok(!r.has('deferred red retry names'));
  assert.equal(lastWords(r), buildAlertMessage('red', [CRIT_B]));
  assert.equal(sips.length, 1, '★★ the cordless took these words on the first dispatch: not repeated');
});

test('★★ the tone agrees with the words: a retry that names C plays C\'s tone (High), not the tone of the set it was armed with (Critical)', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [CRIT_A, CRIT_C_HIGH]; // the set's tone is Critical (A); the words name A
  await until(r, () => r.has(ARMED), 'the red naming A failing');
  alerts = [CRIT_C_HIGH];
  await until(r, () => heard(plays[1]?.url) === 1, 'the retry naming C');
  const retryUrl = plays[1].url;
  const wordsC = buildAlertMessage('red', [CRIT_C_HIGH]);
  assert.equal(lastWords(r), wordsC);
  // The same words rendered at each tone (one file per tone and text): the retry's is C's own.
  assert.equal((await r.mon.announce('critical', wordsC, null, { consentNotice: true })).ok, true);
  assert.notEqual(plays[2].url, retryUrl, 'Critical is a different file');
  assert.equal((await r.mon.announce('high', wordsC, null, { consentNotice: true })).ok, true);
  assert.equal(plays[3].url, retryUrl, '★★ the retry played C\'s words at C\'s tone');
});

test('★★★ a retry waiting ahead of the announcement of the alert it would name yields to it: the new critical is told once, even when its reading moves in between', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 }); // A
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing');
  const urlA = plays[0].url;
  const d = gate();
  plan.push({ status: 200, gate: d.promise }); // a dedicated alarm: slow, heard
  const reserve = r.mon.announce('critical', RESERVE, null);
  await until(r, () => plays.length === 2, 'the dedicated alarm playing');
  const urlReserve = plays[1].url;
  await sleep(RETRY_MS + 300); // A's retry fires and queues behind it
  alerts = [CRIT_C]; // A clears and C appears: C's announcement queues behind A's retry
  await until(r, () => r.count('condition transition → red') === 2, 'C requested');
  alerts = [{ ...CRIT_C, detail: 'code 3 reported again' } as Alert]; // the same alert; its text moved
  d.open();
  await reserve;
  await until(r, () => r.has('deferred red retry dropped — the red names dpu-err-DPU-C / Inverter error code now, and the announcement naming it is waiting behind this retry'), '★ A\'s retry yields');
  await until(r, () => plays.length === 3 && plays[2].done, 'C\'s own announcement');
  assert.equal(heard(plays[2].url), 1);
  assert.match(lastWords(r), /Inverter/);
  // Past the same-level gap, the reading moved once more: nothing re-presents C.
  alerts = [{ ...CRIT_C, detail: 'code 3 reported a third time' } as Alert];
  offset += 3 * MIN;
  await sleep(300);
  const told = plays.filter((p) => p.status === 200 && p.done && p.url !== urlReserve).length;
  assert.equal(told, 1, '★★★ C is told once');
  assert.equal(heard(urlA), 0, '★★★ the cleared A is never spoken');
  assert.ok(!r.has('red will be re-presented'));
});

test('★★ only an announcement still WAITING holds a retry back: one that has already run does not', async () => {
  const r = await started(RETRY_MS);
  alerts = [CRIT_C];
  await until(r, () => heard(plays[0]?.url) === 1, 'C announced and heard (its announcement has run)');
  offset += 3 * MIN; // past the same-level gap
  plan.push({ status: 500 });
  alerts = [CRIT_C, CRIT_A]; // a NEW critical, located: the red names A, and fails
  await until(r, () => r.has(ARMED), 'the red naming A failing');
  alerts = [{ ...CRIT_C, detail: 'code 3 reported again' } as Alert]; // A clears; C's reading moved
  await until(r, () => plays.length === 3 && plays[2].done, '★ the retry, naming C');
  assert.equal(heard(plays[2].url), 1);
  assert.ok(!r.has('retry dropped'), '★★ C\'s announcement ran long ago: nothing is waiting behind the retry');
  assert.match(lastWords(r), /code 3 reported again/i);
});

test('★★ a spoken retry the speakers miss is retried for the alert it named: the cordless, which took it, is not repeated', async () => {
  const r = await started(RETRY_MS);
  ttsDown = true;
  alerts = [CRIT_A]; // speech stalled: the tone alone, and the one spoken retry scheduled
  await until(r, () => r.has('one retry scheduled in 90s'), 'the spoken retry scheduled');
  ttsDown = false;
  plan.push({ status: 500 }); // the spoken retry reaches the cordless, not the speakers
  offset += 2 * MIN;
  await until(r, () => r.has(ARMED), 'the spoken retry failing at the speakers, its deferred retry armed');
  const urlSpoken = plays[1].url;
  await until(r, () => heard(urlSpoken) === 1, '★ the deferred retry: the spoken words');
  await sleep(300);
  assert.deepEqual(sips, [plays[0].url, urlSpoken], '★★ the cordless took the tone, then the words — once each');
  assert.ok(!r.has('deferred red retry names'));
});

test('★★ a retry already waiting in the chain when its alert clears names the critical that stands — nothing else will name it', async () => {
  // C was counted with A, so it is not announced anew: with nothing queued, the retry is the telling.
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [CRIT_A, CRIT_C];
  await until(r, () => r.has(ARMED), 'red naming A failing');
  const d = gate();
  plan.push({ status: 200, gate: d.promise });
  const reserve = r.mon.announce('critical', RESERVE, null);
  await until(r, () => plays.length === 2, 'the dedicated alarm playing');
  await sleep(RETRY_MS + 300); // A's retry queues behind it
  alerts = [CRIT_C];
  d.open();
  await reserve;
  await until(r, () => heard(plays[2]?.url) === 1, 'the retry');
  assert.match(lastWords(r), /Inverter/, '★★ names C');
  assert.ok(!r.has('retry dropped'));
});

test('★★★ the speech gates are rechecked: an armed cell-imbalance warning back inside its speak hold is not replayed', async () => {
  const r = await started(RETRY_MS);
  restampAlertOnset(IMBALANCE.id, Date.now() - 20 * MIN); // stood its hold: voiced
  plan.push({ status: 500 });
  alerts = [IMBALANCE];
  await until(r, () => r.has(ARMED), 'the imbalance warning failing, its retry armed');
  const urlI = plays[0].url;
  restampAlertOnset(IMBALANCE.id, Date.now()); // a new episode: inside its speak hold again
  await until(r, () => r.has('deferred yellow retry dropped — the alert it names (vdiff-warn-DPU-E-1 / Cell imbalance) is not voiced now'), '★ the retry dropped');
  await sleep(300);
  assert.equal(heard(urlI), 0, '★★★ the tick would not voice it, so neither does the retry');
  assert.equal(plays.length, 1);
});

test('★★ the speech gates are rechecked: a retry never names a cell-imbalance warning still inside its speak hold', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [WARN_N];
  await until(r, () => r.has(ARMED), 'the warning failing, its retry armed');
  const urlWarn = plays[0].url;
  alerts = [WARN_N, IMBALANCE]; // located, so it would be named — but it is not voiced yet
  await until(r, () => heard(urlWarn) === 1, '★ the retry names the warning the tick voices');
  await sleep(300);
  assert.equal(plays.length, 2);
  assert.doesNotMatch(lastWords(r), /imbalance/i, '★★ the held imbalance warning is not voiced through the retry');
});

test('★★ the repeat-warning gate: a yellow retry that would now name the warning voiced minutes ago is dropped', async () => {
  const r = await started(RETRY_MS);
  alerts = [WARN_N];
  await until(r, () => heard(plays[0]?.url) === 1, 'the warning voiced');
  offset += 3 * MIN; // past the same-level gap
  alerts = []; // clear: held for its dwell
  await until(r, () => r.has('yellow → green held'), 'the hold');
  plan.push({ status: 500 });
  alerts = [WARN_N, WARN_L]; // a NEW warning inside the hold: spoken at once, naming WARN_L (located)
  await until(r, () => r.has(ARMED), 'the new warning failing, its retry armed');
  const urlL = plays[1].url;
  alerts = [WARN_N]; // WARN_L clears: the yellow names the warning voiced 3 minutes ago
  await until(r, () => r.has('deferred yellow retry dropped — the warning the yellow names now (soc-low-DPU-C-3 / Pack state of charge low) was voiced moments ago'), '★ dropped');
  await sleep(300);
  assert.equal(plays.length, 2, '★★ the warning voiced minutes ago is not repeated by the retry');
  assert.equal(heard(urlL), 0);
});

test('★★ the red replay gate: inside the warm-up, a red retry that would now name the critical announced before the restart, unchanged, is dropped', async () => {
  writeFileSync(REPLAY_PATH!, JSON.stringify({
    lastRedAnnouncedAtMs: Date.now() - 5 * MIN,
    voicedFingerprint: alertFingerprint(CRIT_C),
    activeFingerprints: [alertFingerprint(CRIT_C)],
    lastPlayedLevel: 'red',
  }));
  const r = await started(RETRY_MS, false);
  plan.push({ status: 500 });
  alerts = [CRIT_A, CRIT_C]; // A is new since the restart: the red naming A is announced
  await until(r, () => r.has(ARMED), 'the red naming A failing');
  alerts = [CRIT_C];
  await until(r, () => r.has('deferred red retry dropped — the critical the red names now (dpu-err-DPU-C / Inverter error code) was announced before the restart'), '★ dropped');
  await sleep(300);
  assert.equal(plays.length, 1, '★★ C, heard before the restart and unchanged, is not announced again');
});

test('★★★ a throw while reading the condition replays the armed words, and says so', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing');
  const urlA = plays[0].url;
  storeThrows = true; // the snapshot cannot be read when the retry runs
  await until(r, () => heard(urlA) === 1, '★★★ the armed words, replayed');
  storeThrows = false;
  assert.ok(r.has('deferred red retry could not read the condition as it stands (snapshot unavailable) — the words it was armed with are replayed'));
});

test('★★★ a retry whose new words cannot be spoken (speech stalled) sounds the tone and earns the one spoken retry, which names the critical that stands', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [CRIT_A, CRIT_C];
  await until(r, () => r.has(ARMED), 'the red naming A failing');
  ttsDown = true;
  alerts = [CRIT_C]; // the retry names C: words never rendered, and speech is stalled
  await until(r, () => r.has('spoken render failed — one retry scheduled in 90s'), '★★ the spoken retry scheduled');
  assert.ok(r.has('falling back to chime-only'), 'the tone sounded');
  ttsDown = false;
  offset += 2 * MIN;
  await until(r, () => r.has('spoken retry after render failure → red'), 'the spoken retry');
  await until(r, () => lastWords(r) === buildAlertMessage('red', [CRIT_C]), '★★★ C, spoken');
});

test('★★ the spoken retry\'s tone is the tick\'s now, as its words are', async () => {
  const r = await started(RETRY_MS);
  ttsDown = true;
  alerts = [CRIT_A, CRIT_C_HIGH]; // the red naming A at the set's tone (Critical): speech stalled
  await until(r, () => r.has('one retry scheduled in 90s'), 'the spoken retry scheduled');
  ttsDown = false;
  alerts = [CRIT_C_HIGH]; // A clears; C (High) keeps the red
  offset += 2 * MIN;
  await until(r, () => r.has('spoken retry after render failure → red'), 'the spoken retry');
  const wordsC = buildAlertMessage('red', [CRIT_C_HIGH]);
  await until(r, () => lastWords(r) === wordsC, 'C, spoken');
  const spokenUrl = plays[plays.length - 1].url;
  assert.equal((await r.mon.announce('high', wordsC, null, { consentNotice: true })).ok, true);
  assert.equal(plays[plays.length - 1].url, spokenUrl, '★★ C\'s words at C\'s tone (High)');
});

/**
 * The v1.187.5 keepRed timeline: red B fails; B is held by its mute (the red stays committed); a new
 * warning under it is queued behind a dedicated notice while B's retry fires and queues behind the
 * warning; the warning fails (the slot was released when the notice ended) and arms its own retry;
 * B's retry, older but higher, plays — arming the same-level gap for the warning's retry.
 */
async function keptRedWithWarningRetry(r: Rig): Promise<{ urlB: string; urlWarn: string }> {
  plan.push({ status: 500 }); // red B
  alerts = [CRIT_B];
  await until(r, () => r.has(ARMED), 'the cell-spread red failing, its retry armed');
  const armedAt = realNow();
  alerts = [HELD_B]; // held by the balancing mute: the red stays committed
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN;
  const x = gate();
  plan.push({ status: 200, gate: x.promise });
  const notice = r.mon.announce('medium', NOTICE, null);
  await until(r, () => plays.length === 2, 'a dedicated notice playing');
  plan.push({ status: 500 }); // the warning fails
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('condition transition → yellow (new warning) spoken; the committed condition stays red'), 'the new warning, queued behind the notice');
  await sleep(Math.max(0, armedAt + 2 * RETRY_MS + 300 - realNow())); // B's retry fires and queues behind the warning
  x.open();
  await notice;
  await until(r, () => r.count(ARMED) === 2, 'the warning failing; the slot was free, so it arms its own retry');
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'B\'s retry, older but higher, plays');
  return { urlB: plays[0].url, urlWarn: plays[2].url };
}

test('★★ a refused retry never displaces a re-present already waiting: a new critical refused by the same gap is still re-presented', async () => {
  const r = await started(2 * RETRY_MS);
  await keptRedWithWarningRetry(r);
  alerts = [HELD_B, WARN_N, CRIT_D]; // a NEW critical inside the gap B's delivery armed
  await until(r, () => r.has('red will be re-presented'), 'the new critical refused by the gap, waiting');
  await until(r, () => r.has('yellow suppressed — last red condition broadcast played'), 'the warning\'s retry refused by the gap');
  assert.ok(r.has('the refused yellow retry is not re-presented — the storm-gated red is already waiting to be'), '★ not displaced');
  offset += 2 * MIN;
  await until(r, () => /Battery protection fault/.test(lastWords(r)), '★★ the new critical, re-presented');
});

/* ── v1.187.9 (review) ─────────────────────────────────────────────────────────────────────────── */

/** A yellow raised by an unlocated Grid warning. */
const WARN_GRID: Alert = { id: 'grid-voltage-SHP2-1', severity: 'warning', category: 'Grid', device: 'Smart panel', title: 'Grid voltage high', detail: 'x' } as Alert;
/** A backup-SoC band: its title carries the live reading; the SoC ladder announces it, the condition does not count it. */
const backupSoc = (soc: number): Alert => ({ id: 'backup-soc-30', severity: 'warning', priority: 'medium', category: 'Battery', device: 'SHP2 backup pool', title: `Backup pool low — ${soc}%`, detail: `Backup reserve at ${soc}%.` } as Alert);

test('★★★ (review) a condition announcement names only an alert it counts: never a backup-SoC band (its own announcer\'s, its title a live reading) — so a retry of it is the same alarm when that reading moves', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [WARN_GRID, backupSoc(28)]; // the band ranks first (Battery) but raises nothing
  await until(r, () => r.has(ARMED), 'the yellow failing, its retry armed');
  const urlY = plays[0].url;
  await until(r, () => sips.length === 1, 'the cordless taking the first dispatch');
  alerts = [WARN_GRID, backupSoc(27)]; // the band's reading moves
  ttsDown = true;
  await until(r, () => heard(urlY) === 1, '★ the retry: the armed words, from the rendered file');
  await sleep(300);
  assert.equal(lastWords(r), buildAlertMessage('yellow', [WARN_GRID]), '★★★ the words name the warning that raised the yellow');
  assert.doesNotMatch(lastWords(r), /backup pool/i);
  assert.ok(!r.has('falling back to chime-only'), 'spoken, not the tone alone');
  assert.ok(!r.has('deferred yellow retry names'));
  assert.equal(sips.length, 1, 'the cordless is not called again');
});

test('★★★ (review) a warning named through a rebuilt retry is remembered by the repeat-warning gate: its flicker back is not told again', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [WARN_L]; // the yellow names WARN_L and fails
  await until(r, () => r.has(ARMED), 'the yellow failing, its retry armed');
  alerts = [WARN_L, WARN_N]; // WARN_N joins the yellow (no transition)
  await sleep(50);
  alerts = [WARN_N]; // WARN_L clears: the retry names WARN_N
  await until(r, () => heard(plays[1]?.url) === 1, 'the retry naming WARN_N');
  assert.ok(r.has('deferred yellow retry names soc-low-DPU-C-3 / Pack state of charge low'));
  offset += 3 * MIN; // past the same-level gap
  alerts = []; // a flicker: green, held for its dwell
  await until(r, () => r.has('yellow → green held'), 'the hold');
  alerts = [backupSoc(28), WARN_N]; // back inside the hold (new to the last commit: a transition), a band beside it
  await until(r, () => r.has('condition transition → yellow (new warning)'), 'the flicker back');
  await until(r, () => r.has('yellow suppressed — the same warning (soc-low-DPU-C-3 / Pack state of charge low) was voiced'), '★★★ the repeat-warning gate');
  offset += 3 * MIN;
  await sleep(300);
  assert.equal(plays.length, 2, '★★ WARN_N is told once');
});

test('★★ (review) a retry\'s failed spoken render never replaces a dedicated alarm\'s spoken retry already pending', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [CRIT_A, CRIT_C];
  await until(r, () => r.has(ARMED), 'the red naming A failing');
  ttsDown = true;
  assert.equal((await r.mon.announce('critical', RESERVE, null)).ok, false, 'the dedicated alarm: the tone alone');
  await until(r, () => r.count('one retry scheduled in 90s') === 1, 'its spoken retry pending');
  alerts = [CRIT_C]; // the retry names C: words never rendered, speech still stalled
  await until(r, () => r.has('spoken render of the deferred red retry failed — the red spoken retry already pending is kept'), '★ kept');
  ttsDown = false;
  offset += 2 * MIN;
  await until(r, () => r.has('spoken retry after render failure → red (dedicated-path message replay)'), '★★ the dedicated alarm\'s speech, delivered');
  await until(r, () => lastWords(r) === RESERVE, 'its words');
});

test('★★ (review) a warning deferred under a kept red waits while the held critical reads loud again — not dropped — and is re-presented when it is muted again', async () => {
  const r = await started(2 * RETRY_MS);
  const { urlWarn } = await keptRedWithWarningRetry(r);
  await until(r, () => r.has('the refused yellow retry will be re-presented'), 'the refused warning retry, deferred');
  alerts = [CRIT_B, WARN_N]; // the held critical reads loud again: red, the committed level
  offset += 2 * MIN; // the re-present is due
  await until(r, () => r.has('the storm-gated yellow waits — the committed red reads loud again'), '★★ it waits');
  assert.ok(!r.has('the storm-gated yellow is not re-presented'), 'not dropped');
  alerts = [HELD_B, WARN_N]; // muted again: the warning stands under the kept red
  await until(r, () => heard(urlWarn) === 1, '★ the warning, re-presented');
  await sleep(200);
  assert.equal(r.count('re-presenting the yellow the storm gate refused'), 1, 'once');
});

test('★★ (review) the red replay gate compares the critical the words name: a backup band beside a critical announced before the restart does not make it new', async () => {
  writeFileSync(REPLAY_PATH!, JSON.stringify({
    lastRedAnnouncedAtMs: Date.now() - 5 * MIN,
    voicedFingerprint: alertFingerprint(CRIT_C),
    activeFingerprints: [alertFingerprint(CRIT_C)],
    lastPlayedLevel: 'red',
  }));
  const band = { ...backupSoc(9), severity: 'critical', priority: 'critical', coreNum: 1 } as Alert; // located: ranked first
  const r = await started(RETRY_MS, false);
  alerts = [CRIT_C, band]; // the band would be named (located) but is not counted
  await until(r, () => r.has('red suppressed — this standing fault was already announced'), '★★ C, unchanged since the restart');
  await sleep(200);
  assert.equal(plays.length, 0, 'nothing is announced');
});

test('★★ (review) a REPLAYED yellow retry is remembered too: the same warning back after an all-clear the speech gate kept silent is not told again', async () => {
  const blind = { id: 'shp2-below-reserve-X', severity: 'critical', category: 'SHP2', title: 'Below reserve', detail: 'x' } as Alert;
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  alerts = [WARN_N, blind]; // the critical is not counted, but it gates any all-clear
  await until(r, () => r.has(ARMED), 'the warning failing, its retry armed');
  await until(r, () => heard(plays[1]?.url) === 1, 'the retry: the same warning, replayed and heard');
  alerts = [blind];
  await until(r, () => r.has('yellow → green held'), 'the hold');
  offset += 4 * MIN;
  await until(r, () => r.has('green adopted silently — a critical alert is still active'), 'green committed, not spoken');
  alerts = [WARN_N, blind];
  await until(r, () => r.has('yellow suppressed — the same warning (soc-low-DPU-C-3 / Pack state of charge low) was voiced'), '★★ the repeat-warning gate');
  await sleep(200);
  assert.equal(plays.length, 2, 'told once by the retry');
});

test('★★ (review) the spoken retry of an all-clear is not spoken while a critical the condition does not count is active', async () => {
  const blind = { id: 'shp2-below-reserve-X', severity: 'critical', category: 'SHP2', title: 'Below reserve', detail: 'x' } as Alert;
  const r = await started(RETRY_MS);
  alerts = [CRIT_C];
  await until(r, () => heard(plays[0]?.url) === 1, 'the red heard');
  ttsDown = true;
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 4 * MIN; // the green commits; its speech stalls: the tone alone, and the one spoken retry
  await until(r, () => r.has('one retry scheduled in 90s'), 'the all-clear\'s spoken retry scheduled');
  ttsDown = false;
  alerts = [blind]; // the reserve-floor critical: not counted (the level stays green), but active
  offset += 2 * MIN;
  await until(r, () => r.has('spoken retry dropped — level moved green → green or gated'), '★★ gated');
  await sleep(200);
  assert.doesNotMatch(lastWords(r), /all clear/i, 'never "All clear" while a critical is active');
});

test('★★ (review) a retry\'s failed spoken render replaces a CONDITION spoken retry pending at another level, which would be dropped at its fire', async () => {
  const r = await started(RETRY_MS);
  ttsDown = true;
  alerts = [CRIT_B]; // the red: the tone alone, its spoken retry pending (the condition's, at red)
  await until(r, () => r.has('one retry scheduled in 90s'), 'the red\'s spoken retry pending');
  ttsDown = false;
  alerts = [HELD_B]; // held by its mute: the red stays committed
  await until(r, () => r.has('red → green held'), 'the hold');
  plan.push({ status: 500 });
  alerts = [HELD_B, WARN_L, WARN_N]; // a warning under the kept red, naming WARN_L: it fails
  await until(r, () => r.has(ARMED), 'the warning failing, its retry armed');
  alerts = [HELD_B, WARN_N]; // WARN_L clears: the retry names WARN_N, never rendered
  ttsDown = true;
  await until(r, () => r.count('one retry scheduled in 90s') === 2, '★ the warning\'s spoken retry takes the slot');
  assert.ok(!r.has('spoken retry already pending is kept'));
  ttsDown = false;
  offset += 2 * MIN;
  await until(r, () => r.has('spoken retry after render failure → yellow'), '★★ the warning\'s speech, delivered');
  await until(r, () => lastWords(r) === buildAlertMessage('yellow', [WARN_N]), 'WARN_N, spoken');
});

test('★★ (review) a warning the 90 s spoken retry put on the speakers is remembered by the repeat-warning gate', async () => {
  const r = await started(RETRY_MS);
  ttsDown = true;
  alerts = [WARN_N]; // the yellow: the tone alone, its spoken retry pending
  await until(r, () => r.has('one retry scheduled in 90s'), 'the spoken retry scheduled');
  ttsDown = false;
  alerts = [WARN_N, WARN_L]; // WARN_L joins (no transition): the spoken retry will name it
  offset += 2 * MIN;
  await until(r, () => r.has('spoken retry after render failure → yellow'), 'the spoken retry');
  await until(r, () => lastWords(r) === buildAlertMessage('yellow', [WARN_L]), 'WARN_L, spoken');
  const told = plays.length;
  offset += 3 * MIN;
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the hold');
  alerts = [WARN_N, WARN_L]; // back: WARN_L is new to the last commit, so a transition
  await until(r, () => r.has('yellow suppressed — the same warning (soc-low-DPU-D-2 / Pack state of charge low) was voiced'), '★★ the repeat-warning gate');
  await sleep(200);
  assert.equal(plays.length, told, 'WARN_L is not told again');
});

test('★★ (review) the Spanish words name from the same pool as the English', async () => {
  const texts: Array<{ text: string; voice?: string }> = [];
  const prev = { bi: process.env.BROADCAST_BILINGUAL, es: process.env.BROADCAST_WYOMING_VOICE_ES };
  process.env.BROADCAST_BILINGUAL = 'true';
  process.env.BROADCAST_WYOMING_VOICE_ES = 'es_MX-test';
  try {
    const logs: string[] = [];
    const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-retry-words-cache-es-'));
    const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
      klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', tickMs: 10, retryDelaysMs: [RETRY_MS, RETRY_MS, RETRY_MS],
      renderTts: async (o: { text: string; voice?: string }) => {
        texts.push({ text: o.text, voice: o.voice });
        return { ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 };
      },
    } as any);
    live.push({ mon, logs, has: (x) => logs.some((l) => l.includes(x)), count: () => 0, stop: () => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); } });
    await sleep(80);
    offset += 20 * MIN;
    alerts = [WARN_GRID, backupSoc(28)];
    const start = realNow();
    while (!texts.some((t) => t.voice === 'es_MX-test') && realNow() - start < 8000) await sleep(5);
    const es = texts.find((t) => t.voice === 'es_MX-test');
    assert.ok(es != null, 'a Spanish pass was rendered');
    assert.equal(es.text, buildAlertMessageEs('yellow', [WARN_GRID]), '★★ the Spanish names the warning that raised the yellow, not the band');
  } finally {
    process.env.BROADCAST_BILINGUAL = prev.bi;
    process.env.BROADCAST_WYOMING_VOICE_ES = prev.es;
  }
});

test('refusedRetryRepresent — only a refusal by the same-level gap; below the played level the level is the news; at it, only what the retry named', () => {
  const GAP = 120_000;
  const GATED = ['suppressed: same-or-lower level within gap'];
  const fpN = alertFingerprint(WARN_N);
  const fpC = alertFingerprint(CRIT_C);
  assert.deepEqual(B.refusedRetryRepresent('yellow', fpN, GATED, { level: 'red', atMs: 1000 }, GAP),
    { level: 'yellow', dueAtMs: 1000 + GAP, fresh: null }, 'below the red that armed the gap');
  assert.deepEqual(B.refusedRetryRepresent('red', fpC, GATED, { level: 'red', atMs: 5 }, GAP),
    { level: 'red', dueAtMs: 5 + GAP, fresh: [fpC] }, 'same level: while what it named is counted');
  assert.equal(B.refusedRetryRepresent('green', null, GATED, { level: 'green', atMs: 5 }, GAP), null, 'same level, nothing named');
  assert.equal(B.refusedRetryRepresent('yellow', fpN, ['suppressed: identical message within gap'], { level: 'red', atMs: 5 }, GAP), null, 'these words were heard');
  assert.equal(B.refusedRetryRepresent('yellow', fpN, ['music_assistant.play_announcement: HTTP 500'], { level: 'red', atMs: 5 }, GAP), null, 'a failure is the retry ladder\'s');
  assert.equal(B.refusedRetryRepresent('yellow', fpN, GATED, { level: null, atMs: 0 }, GAP), null);
});

test('conditionNamedFingerprint — the alert the words name (pickPrimaryAlert), none for green', () => {
  assert.equal(B.conditionNamedFingerprint('red', [CRIT_C, CRIT_A]), alertFingerprint(CRIT_A), 'located first');
  assert.equal(B.conditionNamedFingerprint('red', [HELD_B, CRIT_C]), alertFingerprint(CRIT_C), 'never a muted alert');
  assert.equal(B.conditionNamedFingerprint('yellow', [WARN_N, CRIT_C]), alertFingerprint(WARN_N));
  assert.equal(B.conditionNamedFingerprint('green', [WARN_N]), null);
  assert.equal(B.conditionNamedFingerprint('red', []), null);
});

test('conditionRetryWords — replay the same alert (a reading that moved too); re-derive words and tone for a different one; drop what the tick would not say', () => {
  const fpA = alertFingerprint(CRIT_A);
  const fpB = alertFingerprint(CRIT_B);
  const fpN = alertFingerprint(WARN_N);
  const moved = { ...CRIT_B, detail: 'spread 104 mV' } as Alert;
  assert.deepEqual(B.conditionRetryWords('red', fpB, [moved], [moved]), { action: 'replay' }, 'the same alert, its reading moved');
  const c = B.conditionRetryWords('red', fpA, [CRIT_C_HIGH], [CRIT_C_HIGH]);
  assert.equal(c.action, 'rederive');
  if (c.action === 'rederive') {
    assert.equal(c.namedFp, alertFingerprint(CRIT_C_HIGH));
    assert.equal(c.message, buildAlertMessage('red', [CRIT_C_HIGH]));
    assert.ok(c.messageEs.length > 0, 'the Spanish words beside the English');
    assert.equal(c.rung, 'high', 'the tone of the set as it stands');
    assert.deepEqual(c.criticalFingerprints, [alertFingerprint(CRIT_C_HIGH)]);
  }
  assert.equal(B.conditionRetryWords('red', fpA, [CRIT_C, CRIT_A], [CRIT_C, CRIT_A]).action, 'replay', 'A still the one named');
  assert.deepEqual(B.conditionRetryWords('red', fpB, [HELD_B, WARN_N], [HELD_B, WARN_N]), { action: 'replay' }, 'a kept red: the muted critical is held, not cleared');
  assert.deepEqual(B.conditionRetryWords('red', fpA, [], []), { action: 'replay' }, 'a held de-escalation: the armed words (fail-loud)');
  assert.deepEqual(B.conditionRetryWords('yellow', fpN, [CRIT_C, WARN_N], [CRIT_C, WARN_N]), { action: 'replay' }, 'above: a transition is in hand');
  const quiet = { ...WARN_N, audible: false } as Alert;
  assert.equal(B.conditionRetryWords('yellow', fpN, [quiet], []).action, 'drop', 'card and push only now');
  assert.equal(B.conditionRetryWords('yellow', alertFingerprint(IMBALANCE), [IMBALANCE], []).action, 'drop', 'inside its speak hold');
  assert.deepEqual(B.conditionRetryWords('green', null, [], []), { action: 'replay' });
  const blind = { id: 'shp2-below-reserve-X', severity: 'critical', category: 'SHP2', title: 'Below reserve', detail: 'x' } as Alert;
  assert.equal(B.conditionRetryWords('green', null, [blind], [blind]).action, 'drop', 'never "All clear" while a critical is active');
  // v1.187.9 (review)
  assert.equal(B.conditionRetryWords('green', null, [CRIT_C], [CRIT_C]).action, 'drop', 'nor while a counted critical has raised the level, before the tick commits it');
  const spare = { ...WARN_N, annunciate: false } as Alert;
  assert.equal(B.conditionRetryWords('yellow', fpN, [spare], [spare]).action, 'drop', 'a policy mute (no bounded mute behind it): the tick never names it');
  const knee = { ...CRIT_C, annunciate: false, mutedBy: 'balancing' } as Alert;
  assert.equal(B.conditionRetryWords('red', alertFingerprint(CRIT_C), [knee], [knee]).action, 'replay', 'a critical held by a bounded mute: held, not cleared');
  const rebuilt = B.conditionRetryWords('yellow', alertFingerprint(WARN_L), [backupSoc(28), WARN_GRID], [backupSoc(28), WARN_GRID]);
  assert.equal(rebuilt.action === 'rederive' ? rebuilt.message : null, buildAlertMessage('yellow', [WARN_GRID]), 'rebuilt words name the warning that raised the yellow, not the band');
  const band27 = backupSoc(27);
  const y = B.conditionRetryWords('yellow', alertFingerprint(WARN_GRID), [WARN_GRID, band27], [WARN_GRID, band27]);
  assert.deepEqual(y, { action: 'replay' }, 'a band\'s reading moving is no different alert: the band is never the one named');
});

test('conditionNamePool — what the condition counts: never an alert another announcer owns or that is push-only', () => {
  const runway = { id: 'forecast-runtime-SHP2-1', severity: 'critical', category: 'SHP2', title: 'Projected runtime ≈ 1h 5m to reserve', detail: 'x' } as Alert;
  const gap = { id: 'system-outage-device-X-1', severity: 'warning', category: 'Connectivity', coreNum: 2, title: 'Device telemetry gap — no data for 7 min', detail: 'x' } as Alert;
  assert.deepEqual(B.conditionNamePool([backupSoc(28), runway, gap, WARN_GRID, CRIT_C]).map((a) => a.id), [WARN_GRID.id, CRIT_C.id]);
  assert.equal(B.conditionNamedFingerprint('yellow', [backupSoc(28), gap, WARN_GRID]), alertFingerprint(WARN_GRID), 'not the band (Battery) nor the located gap');
  const runwayLocated = { ...runway, coreNum: 1 } as Alert; // located: ranked first by pickPrimaryAlert alone
  assert.equal(B.conditionNamedFingerprint('red', [CRIT_C, runwayLocated]), alertFingerprint(CRIT_C), 'not the runway projection');
});
