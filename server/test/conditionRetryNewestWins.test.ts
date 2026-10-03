/**
 * v1.187.5 — a deferred retry of a CONDITION broadcast replays only the NEWEST announcement of the
 * condition at its level. Driven through the REAL broadcast monitor (startBroadcastMonitor) with Home
 * Assistant mocked at the HTTP layer: every music_assistant.play_announcement takes the next step of
 * a plan (its HTTP status, and optionally a gate that holds the play until the test opens it), and
 * every play is recorded with the audio URL it carried — one rendered file per spoken text, so the
 * URL says which announcement reached the speakers. Retry delays are shortened through the test seam
 * (BroadcastMonitorOpts.retryDelaysMs); the Wyoming renderer is injected.
 *
 * THE DEFECT (v1.187.4 final review, LOW). Red A fails to play (Music Assistant 500s) and a retry is
 * armed. On one tick A clears and critical C appears, so C is announced; C's play is slow and fails.
 * A's retry fires while C is still playing and queues behind it; C's failure arms C's own retry.
 * Then A's queued retry runs. The retry's run-time check read the condition episode only (red → red
 * is one episode), "outranked" was `message !== retryMessage`, and any same-episode red delivery
 * cancelled the pending retry:
 *   • played, A's retry cancelled C's retry — the house heard the cleared A and C was never named;
 *   • failed, its re-arm read as a different announcement, "outranked" C, took the slot with a
 *     fresh 1/3 budget, and later played the cleared A.
 * The red level was right; the named subject was wrong.
 *
 * Now every broadcast takes a GENERATION when it runs (a retry keeps its announcement's); a newer
 * condition announcement at the same or a higher level that takes the slot or reaches the speakers
 * supersedes every older retry, which is dropped when it runs (conditionRetrySuperseded); only a
 * newer announcement outranks (a retry's own re-arm keeps its budget); and only a delivery at least
 * as new as the pending retry cancels it. A lower announcement never supersedes a higher retry, and
 * dedicated announcements are unchanged.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-newest-retry-'));
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

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/* ── Home Assistant, mocked at the HTTP layer. Each play_announcement takes the next plan step
 *    (default: 200 at once). A 200 advances the clock 30 s — the call returns when playback ENDS,
 *    and a sub-2 s "ok" is treated as unverified and re-dispatched. ── */
interface PlayStep { status?: number; gate?: Promise<void> }
interface Play { url: string; status: number; done: boolean }
let plan: PlayStep[] = [];
let plays: Play[] = [];
let openGates: Array<() => void> = [];
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => { open = res; });
  openGates.push(open);
  return { promise, open };
}
const PLAY = '/core/api/services/music_assistant/play_announcement';
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
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-newest-retry-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;

/** Red A: a critical released the tick it clears. */
const CRIT_A: Alert = { id: 'cell-ovp-COREXXX00XXX0001-1', severity: 'critical', category: 'Battery', device: 'Core 1', coreNum: 1, packNum: 1, title: 'Cell overvoltage', detail: 'highest cell at 3.612 V' } as Alert;
/** Critical C, on another Core. */
const CRIT_C: Alert = { id: 'dpu-err-DPU-C', severity: 'critical', category: 'Battery', device: 'Core 3', title: 'Inverter error code', detail: 'x', fault: 'err3' } as Alert;
/** A cell-spread critical, loud, and on a later reading held by the balancing mute (as alerts.ts stamps it). */
const CRIT_B: Alert = { id: 'vdiff-crit-DPU-B-2', severity: 'critical', category: 'Battery', device: 'Core 2', title: 'Cell imbalance', detail: 'spread 101 mV' } as Alert;
const HELD_B: Alert = { ...CRIT_B, annunciate: false, mutedBy: 'balancing', muteReason: 'the BMS is balancing the cells', detail: 'spread 95 mV BMS is actively balancing the cells.' } as Alert;
const WARN_N: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Pack state of charge low', detail: 'x' } as Alert;
const NOTICE = 'A dedicated notice is playing.';
const RESERVE = 'Backup reserve at ten percent.';

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
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-newest-retry-cache-'));
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
  offset += 20 * MIN; // past the boot warm-up window (and any restart question)
  return r;
}
async function until(r: Rig, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\nplays: ${JSON.stringify(plays)}\n${r.logs.join('\n')}`);
    await sleep(5);
  }
}
/** The retry delay: wide enough that every step a test takes before a retry fires (a tick, a play
 *  starting, an announcement queued) lands first, even on a loaded machine. */
const RETRY_MS = 800;
const SUPERSEDED = 'deferred red retry dropped — a newer announcement of the condition has taken its place since';
const ARMED = 'deferred retry 1/3';

/**
 * The scenario up to A's queued retry: red A fails (its retry armed), A clears and critical C is
 * announced on one tick, C's play is held while A's retry fires and queues behind it, then C fails
 * and arms its own retry. `next` is what Music Assistant answers from then on.
 */
async function scenario(r: Rig, next: PlayStep[]): Promise<{ urlA: string; urlC: string }> {
  plan.push({ status: 500 }); // A
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing, its retry armed');
  const c = gate();
  plan.push({ status: 500, gate: c.promise }); // C: slow, then fails
  alerts = [CRIT_C]; // A clears and C appears on the same tick: red stays red (one episode)
  await until(r, () => plays.length === 2, 'C playing');
  await sleep(RETRY_MS + 300); // A's retry fires meanwhile and queues behind C
  plan.push(...next);
  c.open();
  await until(r, () => r.count(ARMED) === 2, 'C failing, its own retry armed');
  return { urlA: plays[0].url, urlC: plays[1].url };
}

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  for (const open of openGates.splice(0)) open();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  alerts = [];
  plan = [];
  plays = [];
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  for (const open of openGates.splice(0)) open();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ THE DEFECT, Music Assistant back by A\'s turn: A\'s queued retry is dropped — never played, never cancelling C\'s retry, which names C', async () => {
  const r = await started(RETRY_MS);
  const { urlA, urlC } = await scenario(r, []); // every later play succeeds
  assert.notEqual(urlA, urlC, 'two texts, two rendered files');
  await until(r, () => r.has(SUPERSEDED), 'A\'s retry dropped at its turn');
  await until(r, () => heard(urlC) === 1, '★ C\'s own retry reaching the speakers');
  await sleep(300);
  assert.equal(heard(urlA), 0, '★★★ the cleared A is never spoken');
  assert.ok(!r.has('the pending red retry is cancelled'), 'C\'s retry is never cancelled');
  assert.equal(heard(urlC), 1);
  assert.match(String(r.mon.status().lastSpokenMessage), /Inverter/, 'the last words name the standing critical C');
});

test('★★★ THE DEFECT, Music Assistant still failing at A\'s turn: A takes nothing — C keeps the slot and counts its own budget (1/3, 2/3), then names C', async () => {
  const r = await started(RETRY_MS);
  const { urlA, urlC } = await scenario(r, [{ status: 500 }]); // one more failure, then success
  await until(r, () => r.has(SUPERSEDED), 'A\'s retry dropped at its turn');
  await until(r, () => r.has('deferred retry 2/3'), 'C\'s own retry failing too, counted on C\'s budget');
  await until(r, () => heard(urlC) === 1, '★ C\'s second retry reaching the speakers');
  await sleep(300);
  assert.equal(r.count(ARMED), 2, '★★ no fresh 1/3 budget after C took the slot (only A\'s first and C\'s first)');
  assert.ok(!r.has('superseding the pending red retry'), '★★ nothing takes C\'s slot');
  assert.equal(heard(urlA), 0, '★★★ the cleared A is never spoken');
  assert.match(String(r.mon.status().lastSpokenMessage), /Inverter/);
});

test('★★★ a NEWER announcement that reached the speakers drops an older retry still waiting in the chain — the armed timer is not the only place it waits', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 }); // A
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing');
  const c = gate();
  plan.push({ status: 200, gate: c.promise }); // C: slow, heard
  alerts = [CRIT_C];
  await until(r, () => plays.length === 2, 'C playing');
  const n = gate();
  plan.push({ status: 200, gate: n.promise });
  // queued behind C, ahead of A's retry; past the storm gates (a consent notice) so it holds the chain
  const notice = r.mon.announce('medium', NOTICE, null, { consentNotice: true });
  await sleep(RETRY_MS + 300); // A's retry fires and queues behind the notice
  c.open();
  await until(r, () => plays.length === 3, 'C heard, the notice playing');
  assert.equal(heard(plays[1].url), 1, 'C reached the speakers');
  offset += 3 * MIN; // the notice plays on past the same-level storm gap
  n.open();
  await notice;
  await until(r, () => r.has(SUPERSEDED), '★ A\'s retry dropped at its turn: C, newer, was heard');
  await sleep(300);
  assert.equal(heard(plays[0].url), 0, '★★★ the cleared A is not spoken after C');
});

test('★★★ a red retry waiting behind a NEWER warning spoken under the kept red still plays (a lower announcement takes no red\'s place) — and its delivery does not cancel the newer warning\'s retry', async () => {
  const r = await started(2 * RETRY_MS);
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
  await sleep(Math.max(0, armedAt + 2 * RETRY_MS + 300 - realNow())); // the red retry fires and queues behind the warning
  x.open();
  await notice;
  await until(r, () => r.count(ARMED) === 2, 'the warning failing; the slot was free, so it arms its own retry');
  const urlB = plays[0].url;
  const urlWarn = plays[2].url;
  await until(r, () => r.count('broadcast: red → ok in') === 1, '★ the red retry, older but higher, plays');
  assert.equal(heard(urlB), 1);
  offset += 3 * MIN; // past the same-level storm gap before the warning's retry fires
  await until(r, () => heard(urlWarn) === 1, '★★ the newer warning\'s retry plays: the older red\'s delivery did not cancel it');
  assert.ok(!r.has('the pending yellow retry is cancelled'));
  assert.ok(!r.has('retry dropped'));
});

test('★★ a NEWER warning that fails while the red\'s retry is armed waits behind it — newer is not enough to take a higher retry\'s slot', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // red B
  alerts = [CRIT_B];
  await until(r, () => r.has(ARMED), 'the cell-spread red failing, its retry armed');
  alerts = [HELD_B];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN;
  plan.push({ status: 500 }); // the warning fails while the red's timer is still armed
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('keeping the pending red retry — a yellow deferral does not supersede it'), '★ the newer warning kept pending');
  await until(r, () => r.count('broadcast: red → ok in') === 1, '★ the red retry plays');
  assert.equal(heard(plays[0].url), 1, 'the red nobody heard is the retry that played');
  assert.ok(!r.has('superseding the pending red retry'), 'the lower announcement took nothing');
});

test('★★ dedicated retries are unchanged: one waiting behind a newer CONDITION announcement that took the slot still plays', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 });
  const first = await r.mon.announce('critical', RESERVE, null);
  assert.equal(first.ok, false, 'the dedicated alarm failed; its retry is armed');
  const c = gate();
  plan.push({ status: 500, gate: c.promise }); // condition C: slow, fails, takes the slot
  alerts = [CRIT_C];
  await until(r, () => plays.length === 2, 'C playing');
  await sleep(RETRY_MS + 300); // the dedicated retry fires and queues behind C
  c.open();
  await until(r, () => r.count('deferred retry 2/3') === 1, 'C taking the shared slot');
  await until(r, () => heard(plays[0].url) === 1, '★ the dedicated alarm\'s retry plays');
  await until(r, () => heard(plays[1].url) === 1, 'and C\'s own retry still names C');
  assert.ok(!r.has('retry dropped'));
});

test('★★ a still-standing red\'s own retry plays behind a DEDICATED announcement that deferred and took the slot — a dedicated arm takes no condition retry\'s place', async () => {
  const r = await started(RETRY_MS);
  plan.push({ status: 500 }); // A, still standing throughout
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing');
  const d = gate();
  plan.push({ status: 500, gate: d.promise }); // a dedicated alarm: slow, fails
  const reserve = r.mon.announce('critical', RESERVE, null);
  await until(r, () => plays.length === 2, 'the dedicated alarm playing');
  await sleep(RETRY_MS + 300); // A's retry fires and queues behind it
  d.open();
  await reserve;
  await until(r, () => heard(plays[0].url) === 1, '★ A, still standing, retried');
  assert.equal(plays[2].url, plays[0].url, 'the retry replays the same rendered announcement');
  assert.ok(!r.has('retry dropped'));
});

test('conditionRetrySuperseded — a newer condition announcement at the same or a higher level; never a lower one, never the retry\'s own, never a dedicated retry', () => {
  const none = { green: 0, yellow: 0, red: 0 };
  assert.equal(B.conditionRetrySuperseded('condition', 'red', 3, none), false);
  assert.equal(B.conditionRetrySuperseded('condition', 'red', 3, { ...none, red: 3 }), false, 'its own arm');
  assert.equal(B.conditionRetrySuperseded('condition', 'red', 3, { ...none, red: 4 }), true, 'a newer red');
  assert.equal(B.conditionRetrySuperseded('condition', 'red', 3, { ...none, yellow: 9, green: 9 }), false, 'newer but lower');
  assert.equal(B.conditionRetrySuperseded('condition', 'yellow', 3, { ...none, red: 4 }), true, 'a newer red over a yellow');
  assert.equal(B.conditionRetrySuperseded('condition', 'yellow', 3, { ...none, red: 2, yellow: 3 }), false, 'an older red');
  assert.equal(B.conditionRetrySuperseded('condition', 'green', 1, { ...none, green: 2 }), true);
  assert.equal(B.conditionRetrySuperseded('dedicated', 'red', 3, { ...none, red: 9 }), false);
  assert.equal(B.conditionRetrySuperseded('test', 'red', 3, { ...none, red: 9 }), false);
});
