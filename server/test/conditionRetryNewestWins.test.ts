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
 * dedicated announcements are unchanged. Under production timing a newer warning's retry that
 * runs just after the kept red's retry has played is refused by the same-level gap that delivery
 * armed; v1.187.11 — it is re-presented once when the gap expires (before, the warning was spoken
 * only when the condition committed down to it). What a retry SAYS when it runs is pinned in
 * conditionRetryWords.test.ts.
 *
 * v1.195.0 — a lower condition deferral KEPT behind a higher retry (keep-pending) is re-presented
 * once that retry is done (keptDeferralRepresent); and audibility is tracked per critical named
 * (audibleCritFps), so a critical that took a heard one's place undelivered is spoken when it
 * returns inside the dwell.
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
/** Speech stalled (a Wyoming timeout): every spoken render fails and the broadcast falls back to the
 *  chime-only render — played, but with errors, so it arms no storm gate. */
let ttsFails = false;
const renderTts = async () => (ttsFails
  ? { ok: false as const, error: 'wyoming render timeout (test)' }
  : { ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
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
/** A monitor past its boot warm-up, its deferred retries `retryMs` apart (real time).
 *  v1.195.0 — `pastWarmup` false: left inside its warm-up (a restart's boot gates apply). */
async function started(retryMs: number, pastWarmup = true): Promise<Rig> {
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
  if (!pastWarmup) return r;
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
  ttsFails = false;
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

test('★★★ a red retry waiting behind a NEWER warning spoken under the kept red still plays (a lower announcement takes no red\'s place) — and its delivery does not cancel the newer warning\'s retry, which the same-level gap the red armed then refuses; the warning is re-presented once when the gap expires', async () => {
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
  // Production timing: the warning's retry fires inside the 120 s same-level gap the red's delivery
  // armed. It runs (nothing cancelled it) and the gap refuses it; a refused retry is not re-armed.
  await until(r, () => r.has('yellow suppressed — last red condition broadcast played'), '★★ the newer warning\'s retry runs — the older red\'s delivery did not cancel it — and the gap refuses it');
  await sleep(300);
  assert.equal(heard(urlWarn), 0, 'refused, not played');
  assert.ok(!r.has('the pending yellow retry is cancelled'));
  assert.ok(!r.has('retry dropped'));
  assert.ok(!r.has('deferred retry 2/3'), 'a refused retry is not re-armed');
  // v1.187.11 — it is re-presented once when the gap expires (deferredCondition), under the kept red.
  // Before, it waited for the condition to commit down to it, once the held critical had cleared
  // (SOUNDED_VDIFF_ABSENT_HOLD_MS) and the lower level had stood its dwell.
  assert.ok(r.has('the refused yellow retry will be re-presented'));
  offset += 2 * MIN;
  await until(r, () => heard(urlWarn) === 1, '★ the warning, re-presented when the gap expires');
  assert.ok(r.has('re-presenting the yellow the storm gate refused'));
  assert.equal(r.count('condition transition → yellow'), 1, 'a re-present, not a transition: the red stays committed');
  // v1.187.11 (review) — the red's hold stands: a re-present below the committed level does not end it.
  await sleep(200);
  assert.ok(!r.has('again — the storm-gated condition is re-presented'), '★ the hold is not ended by a re-present below the committed red');
  assert.equal(r.count('red → yellow held'), 1, 'and is not begun again');
});

test('★★★ a red retry that reaches the speakers TONE-ONLY (speech stalled) arms no same-level gap — and its delivery does not cancel the newer warning\'s retry, which then plays', async () => {
  ttsFails = true; // every play is the chime-only fallback: played, with errors
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
  await until(r, () => heard(urlB) === 1, '★ the red retry, older but higher, plays tone-only');
  // The tone-only delivery is audible but unverified: no same-level gap, so only the generation
  // keeps the older red from cancelling the newer warning's retry.
  await until(r, () => heard(urlWarn) === 1, '★★★ the newer warning\'s retry plays — the older red\'s delivery did not cancel it');
  assert.ok(!r.has('the pending yellow retry is cancelled'));
  assert.ok(!r.has('deferred red retry dropped') && !r.has('deferred yellow retry dropped'), 'no deferred retry is dropped');
});

test('★★ a newer red that reaches the speakers while the older red\'s timer is armed frees the slot: a warning failing under the kept red arms its own retry, and is heard', async () => {
  const r = await started(3000);
  plan.push({ status: 500 }); // red A
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing, its retry armed 3 s out');
  alerts = [CRIT_B]; // A clears and the cell-spread critical B appears: announced, and heard
  await until(r, () => heard(plays[1]?.url) === 1, 'B reaching the speakers');
  alerts = [HELD_B]; // held by the balancing mute: the red stays committed
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN; // past the same-level storm gap
  plan.push({ status: 500 }); // the warning fails
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('condition transition → yellow (new warning) spoken; the committed condition stays red'), 'the warning under the kept red');
  await until(r, () => r.count(ARMED) === 2, '★ the slot is free: the warning arms its own retry');
  const urlWarn = plays[2].url;
  assert.ok(!r.has('keeping the pending red retry'), '★ A\'s moot timer holds nothing');
  await until(r, () => heard(urlWarn) === 1, '★★ the warning\'s retry reaches the speakers');
  assert.equal(heard(plays[0].url), 0, 'the cleared A is never spoken');
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
  assert.ok(r.has('; the yellow is re-presented once that retry is done, if the condition has not moved'), 'v1.195.0: and the line says what follows');
  const urlWarn = plays[1].url;
  await until(r, () => r.count('broadcast: red → ok in') === 1, '★ the red retry plays');
  assert.equal(heard(plays[0].url), 1, 'the red nobody heard is the retry that played');
  assert.ok(!r.has('superseding the pending red retry'), 'the lower announcement took nothing');
  // v1.195.0 (P6) — the kept warning was never spoken while it stood: nothing remembered it, and its
  // transition was already committed. It is re-presented once the red retry is done, after the gap
  // that retry's delivery armed (presented inside it, the gap would refuse it for good).
  await until(r, () => r.has('the yellow kept behind a higher retry will be re-presented in 1'), '★ the re-present armed for when the gap expires');
  await sleep(100);
  assert.equal(heard(urlWarn), 0, 'not inside the gap');
  offset += 2 * MIN + 5_000;
  await until(r, () => heard(urlWarn) === 1, '★★★ the kept warning reaches the speakers');
  assert.ok(r.has('re-presenting the yellow kept behind a higher retry — that retry is done and the condition is still yellow'));
  assert.equal(r.count('condition transition → yellow'), 1, 'a re-present, not a second transition');
  await sleep(100);
  assert.equal(r.count('red → yellow held'), 1, 'the held red stays held: the re-present below it ends nothing');
  assert.ok(!r.has('the condition kept behind a higher retry is re-presented'));
  assert.ok(!r.has('yellow suppressed — last red condition broadcast played'), 'never refused by the gap');
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

/* ══ v1.195.0 (P6): a lower condition deferral kept behind a higher retry is re-presented ═══════ */

test('★★★ v1.195.0 (P6): a condition warning kept behind a DEDICATED critical\'s retry is spoken once that retry has played — no gap (a dedicated play arms none)', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // the dedicated alarm fails: its red retry armed
  const first = await r.mon.announce('critical', RESERVE, null);
  assert.equal(first.ok, false);
  plan.push({ status: 500 }); // the condition warning fails too
  alerts = [WARN_N];
  await until(r, () => r.has('keeping the pending red retry — a yellow deferral does not supersede it'), 'the warning kept behind the dedicated retry');
  const urlWarn = plays[1].url;
  await until(r, () => heard(plays[0].url) === 1, 'the dedicated alarm\'s retry plays');
  await until(r, () => heard(urlWarn) === 1, '★★★ then the warning (it was never spoken while it stood)');
  assert.ok(r.has('the yellow kept behind a higher retry will be re-presented in 0 s'));
  assert.equal(r.count('condition transition → yellow'), 1);
  assert.match(String(r.mon.status().lastSpokenMessage), /state of charge/i, 'the last words are the standing warning');
});

test('★★ v1.195.0 (P6): an ALL-CLEAR kept behind a dedicated warning\'s retry is spoken once that retry has played', async () => {
  const r = await started(2 * RETRY_MS);
  alerts = [CRIT_A];
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'red A heard');
  offset += 3 * MIN; // past the same-level gap
  plan.push({ status: 500 }); // a dedicated warning fails: its yellow retry armed
  const notice = await r.mon.announce('medium', NOTICE, null);
  assert.equal(notice.ok, false);
  plan.push({ status: 500 }); // the all-clear fails behind it
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  offset += B.CONDITION_CLEAR_DWELL_MS + 1_000;
  await until(r, () => r.has('keeping the pending yellow retry — a green deferral does not supersede it'), '★ the all-clear kept behind the dedicated retry');
  const urlGreen = plays[2].url;
  await until(r, () => heard(plays[1].url) === 1, 'the dedicated warning\'s retry plays');
  await until(r, () => heard(urlGreen) === 1, '★★★ then the all-clear: the cleared red is not the last word');
  assert.ok(r.has('re-presenting the green kept behind a higher retry'));
  assert.equal(r.mon.status().lastLevel, 'green');
});

test('★★ v1.195.0 (P6): a kept warning whose condition has since been committed at another level is not re-presented', async () => {
  const r = await started(3000); // the dedicated retry fires 3 s out: the green commits first
  plan.push({ status: 500 });
  await r.mon.announce('critical', RESERVE, null);
  plan.push({ status: 500 });
  alerts = [WARN_N];
  await until(r, () => r.has('keeping the pending red retry — a yellow deferral does not supersede it'), 'the warning kept');
  const urlWarn = plays[1].url;
  alerts = []; // the warning clears: the green commits after its dwell, and is spoken
  await until(r, () => r.has('yellow → green held'), 'the dwell');
  offset += B.CONDITION_CLEAR_DWELL_MS + 1_000;
  await until(r, () => r.count('broadcast: green → ok in') === 1, 'the all-clear, while the dedicated retry is still armed');
  await until(r, () => heard(plays[0].url) === 1, 'the dedicated retry plays');
  await until(r, () => r.has('the yellow kept behind a higher retry is not re-presented — the condition has been committed at another level since'), '★ dropped');
  await sleep(100);
  assert.equal(heard(urlWarn), 0, 'the cleared warning is never spoken');
  assert.ok(!r.has('kept behind a higher retry will be re-presented'));
});

test('★★ v1.195.0 (P6): when the higher retry GIVES UP, the kept warning is re-presented at once (nothing was played, so no gap)', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // red B
  alerts = [CRIT_B];
  await until(r, () => r.has(ARMED), 'the cell-spread red failing, its retry armed');
  alerts = [HELD_B]; // held by the balancing mute: the red stays committed
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN;
  plan.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }); // the warning, then every red retry
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('keeping the pending red retry — a yellow deferral does not supersede it'), 'the warning kept');
  const urlWarn = plays[1].url;
  await until(r, () => r.has('giving up after 3 deferred red retries'), 'the red retry gives up', 15_000);
  await until(r, () => heard(urlWarn) === 1, '★★ the warning, re-presented once the slot is free');
  assert.ok(r.has('the yellow kept behind a higher retry will be re-presented in 0 s'));
});

test('★★ v1.195.0 (P6): a red retry already FIRED and queued behind the warning plays first — the kept warning is re-presented only once it has played, after its gap', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // red B
  alerts = [CRIT_B];
  await until(r, () => r.has(ARMED), 'the cell-spread red failing, its retry armed');
  const armedAt = realNow();
  alerts = [HELD_B];
  await until(r, () => r.has('red → green held'), 'the hold');
  offset += 3 * MIN;
  const w = gate();
  plan.push({ status: 500, gate: w.promise }); // the warning: slow, then fails
  alerts = [HELD_B, WARN_N];
  await until(r, () => plays.length === 2, 'the warning playing');
  await sleep(Math.max(0, armedAt + 2 * RETRY_MS + 300 - realNow())); // the red retry fires and queues behind it
  const g = gate();
  plan.push({ status: 200, gate: g.promise }); // the red retry, held while the test looks
  w.open();
  await until(r, () => r.has('keeping the pending red retry — a yellow deferral does not supersede it'), 'the warning kept behind the fired retry');
  const urlWarn = plays[1].url;
  await until(r, () => plays.length === 3, 'the red retry playing');
  await sleep(150); // ticks run while it plays: the slot reads free (released when the warning ended)
  assert.ok(!r.has('kept behind a higher retry will be re-presented'), '★ not while a retry is still in the chain');
  g.open();
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'the red retry heard');
  await until(r, () => r.has('the yellow kept behind a higher retry will be re-presented in 1'), 'then armed, for when its gap expires');
  await sleep(100);
  assert.equal(heard(urlWarn), 0, 'not inside the gap the red armed');
  offset += 2 * MIN + 5_000;
  await until(r, () => heard(urlWarn) === 1, '★★ the warning, once the gap has expired');
  assert.ok(!r.has('yellow suppressed — last red condition broadcast played'), 'never refused by the gap');
});

test('★★★ v1.195.0 (review): the OTHER ordering — a condition warning\'s retry armed, then a dedicated critical that fails and takes the slot: the warning is kept, and spoken once that retry has played', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // the condition warning fails first: its yellow retry armed
  alerts = [WARN_N];
  await until(r, () => r.has(ARMED), 'the warning failing, its retry armed');
  const urlWarn = plays[0].url;
  plan.push({ status: 500 }); // the dedicated critical fails while the yellow retry is armed
  const first = await r.mon.announce('critical', RESERVE, null);
  assert.equal(first.ok, false);
  assert.ok(r.has('superseding the pending yellow retry with red; the yellow is re-presented once that retry is done, if the condition has not moved'), r.logs.join('\n'));
  await until(r, () => heard(plays[1].url) === 1, 'the dedicated alarm\'s retry plays');
  await until(r, () => heard(urlWarn) === 1, '★★★ then the warning (cleared off the slot, it was never spoken while it stood)');
  assert.ok(r.has('the yellow kept behind a higher retry will be re-presented in 0 s'));
  assert.equal(r.count('condition transition → yellow'), 1, 'a re-present, not a second transition');
  assert.match(String(r.mon.status().lastSpokenMessage), /state of charge/i, 'the last words are the standing warning');
});

test('★★ v1.195.0 (review): …and an ALL-CLEAR whose retry a dedicated warning took the slot from is spoken once that retry has played', async () => {
  const r = await started(2 * RETRY_MS);
  alerts = [CRIT_A];
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'red A heard');
  offset += 3 * MIN; // past the same-level gap
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  plan.push({ status: 500 }); // the all-clear fails: its green retry armed
  offset += B.CONDITION_CLEAR_DWELL_MS + 1_000;
  await until(r, () => r.has(ARMED), 'the all-clear failing, its retry armed');
  const urlGreen = plays[1].url;
  plan.push({ status: 500 }); // a dedicated warning fails while the green retry is armed
  const notice = await r.mon.announce('medium', NOTICE, null);
  assert.equal(notice.ok, false);
  assert.ok(r.has('superseding the pending green retry with yellow; the green is re-presented once that retry is done'), r.logs.join('\n'));
  await until(r, () => heard(plays[2].url) === 1, 'the dedicated warning\'s retry plays');
  await until(r, () => heard(urlGreen) === 1, '★★★ then the all-clear: the cleared red is not the last word');
  assert.ok(r.has('re-presenting the green kept behind a higher retry'));
  assert.equal(r.mon.status().lastLevel, 'green');
});

test('★★ v1.195.0 (review): one deferral is kept at a time — a warning failing behind the dedicated alarm does not displace the more severe condition red kept before it; the red is named once its critical reads loud again', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // the cell-spread red fails: its condition retry armed
  alerts = [CRIT_B];
  await until(r, () => r.has(ARMED), 'the red failing, its retry armed');
  const urlRed = plays[0].url;
  alerts = [HELD_B]; // held by the balancing mute: the red stays committed
  await until(r, () => r.has('red → green held'), 'the hold');
  plan.push({ status: 500 }); // a dedicated critical fails and takes the slot
  await r.mon.announce('critical', RESERVE, null);
  assert.ok(r.has('superseding the pending red retry with red; the red is re-presented once that retry is done'), r.logs.join('\n'));
  plan.push({ status: 500 }); // the warning under the kept red fails behind the dedicated retry
  alerts = [HELD_B, WARN_N];
  await until(r, () => r.has('keeping the pending red retry — a yellow deferral does not supersede it'), 'the warning behind the dedicated retry');
  assert.ok(r.has('; the more severe red kept before it is re-presented instead'), '★ the kept red is not displaced');
  await until(r, () => heard(plays[1].url) === 1, 'the dedicated retry plays');
  await until(r, () => r.has('the red kept behind a higher retry waits — the condition is yellow now'), 'it waits while its critical is muted');
  assert.equal(heard(urlRed), 0);
  alerts = [CRIT_B, WARN_N]; // the critical reads loud again
  await until(r, () => heard(urlRed) === 1, '★★ the critical named at last');
  assert.ok(r.has('re-presenting the red kept behind a higher retry'));
});

test('★ v1.195.0 (P6): a DEDICATED announcement kept behind a condition retry is not the condition — nothing is re-presented for it', async () => {
  const r = await started(2 * RETRY_MS);
  plan.push({ status: 500 }); // red A
  alerts = [CRIT_A];
  await until(r, () => r.has(ARMED), 'red A failing, its retry armed');
  plan.push({ status: 500 });
  const notice = await r.mon.announce('medium', NOTICE, null);
  assert.equal(notice.ok, false);
  assert.ok(r.has('keeping the pending red retry — a yellow deferral does not supersede it'));
  assert.ok(!r.has('the yellow is re-presented once that retry is done'), 'the line promises nothing for it');
  await until(r, () => heard(plays[0].url) === 1, 'the red retry plays');
  await sleep(150);
  assert.ok(!r.has('kept behind a higher retry'), '★ no condition re-present is armed for a dedicated notice');
});

test('keptDeferralRepresent — the kept deferral of the current episode: due at once, or after the same-level gap of the last condition played when it is not below it', () => {
  const t = 70_000_000;
  const gap = 120_000;
  const K = (level: 'green' | 'yellow' | 'red', named: string | null = 'N', episode = 4) => ({ level, episode, named });
  assert.equal(B.keptDeferralRepresent(null, 4, { level: 'red', atMs: t }, gap, t), null);
  assert.deepEqual(B.keptDeferralRepresent(K('yellow'), 5, { level: 'red', atMs: t }, gap, t), { drop: 'the condition has been committed at another level since' });
  assert.deepEqual(B.keptDeferralRepresent(K('yellow'), 4, { level: 'red', atMs: t }, gap, t + 10_000), { level: 'yellow', dueAtMs: t + gap, fresh: null },
    'below the red played 10 s ago: after its gap; the level itself is the news');
  assert.deepEqual(B.keptDeferralRepresent(K('yellow'), 4, { level: 'red', atMs: t }, gap, t + 5 * 60_000), { level: 'yellow', dueAtMs: t + 5 * 60_000, fresh: null }, 'the gap long expired: now');
  assert.deepEqual(B.keptDeferralRepresent(K('yellow'), 4, { level: null, atMs: 0 }, gap, t), { level: 'yellow', dueAtMs: t, fresh: ['N'] }, 'no condition played: now');
  assert.deepEqual(B.keptDeferralRepresent(K('yellow'), 4, { level: 'green', atMs: t }, gap, t + 1), { level: 'yellow', dueAtMs: t + 1, fresh: ['N'] }, 'an escalation: no gap');
  assert.deepEqual(B.keptDeferralRepresent(K('yellow'), 4, { level: 'yellow', atMs: t }, gap, t + 1), { level: 'yellow', dueAtMs: t + gap, fresh: ['N'] },
    'the same level: after the gap, while what it named is counted');
  assert.deepEqual(B.keptDeferralRepresent(K('green', null), 4, { level: 'red', atMs: t }, gap, t + 1), { level: 'green', dueAtMs: t + gap, fresh: null }, 'an all-clear');
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

/* ══ v1.195.0 (N8): audibility per critical, not per red episode ═══════════════════════════════ */

test('★★★ v1.195.0 (N8): a critical that took a heard one\'s place and was never delivered is SPOKEN when it returns inside the dwell — not absorbed as a flicker of the heard red', async () => {
  const r = await started(RETRY_MS);
  alerts = [CRIT_A];
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'A heard');
  offset += 3 * MIN; // past the same-level gap
  plan.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }); // C and its three retries fail
  alerts = [CRIT_C]; // A clears and C appears on one tick: one red episode
  await until(r, () => r.has('giving up after 3 deferred red retries'), 'C never delivered', 15_000);
  const urlC = plays[1].url;
  assert.notEqual(urlC, plays[0].url);
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  await sleep(40);
  alerts = [CRIT_C]; // C returns alone inside the dwell
  await until(r, () => heard(urlC) === 1, '★★★ C named at last');
  assert.ok(r.has('and the critical it names (dpu-err-DPU-C'), r.logs.join('\n'));
  assert.ok(r.has('was never audible in this episode — presented again as a transition'));
  assert.ok(!r.has('again (flicker absorbed, nothing spoken)'));
});

test('★★ v1.195.0 (N8): …and such a return the same-level gap refuses is re-presented once the gap expires — the critical it names is new to the speakers', async () => {
  const r = await started(RETRY_MS);
  alerts = [CRIT_A];
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'A heard');
  alerts = [CRIT_C]; // C takes A's place inside the gap A's delivery armed: refused
  await until(r, () => r.has('red suppressed — last red condition broadcast played'), 'C refused by the gap');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  await sleep(40);
  alerts = [CRIT_C]; // C returns inside the dwell, still inside the gap
  await until(r, () => r.has('was never audible in this episode — presented again as a transition'), 'the return presented');
  await until(r, () => r.count('red suppressed — last red condition broadcast played') === 2, 'refused by the gap again');
  await until(r, () => r.count('red will be re-presented once the storm gate') === 2, '★ the return re-presented when the gap expires');
  offset += 2 * MIN;
  await until(r, () => plays.length === 2 && heard(plays[1].url) === 1, '★★ C named');
  assert.match(String(r.mon.status().lastSpokenMessage), /Inverter/);
});

test('★★ v1.195.0 (N8): a heard critical that returns inside the dwell is still the flicker it was — absorbed, nothing spoken', async () => {
  const r = await started(RETRY_MS);
  alerts = [CRIT_A];
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'A heard');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  alerts = [CRIT_A];
  await until(r, () => r.has('again (flicker absorbed, nothing spoken)'), 'absorbed');
  await sleep(60);
  assert.equal(plays.length, 1);
});

test('★★ v1.195.0 (N8): two criticals returning together whose words name the HEARD one are a flicker — the other was not named at the commit either', async () => {
  const r = await started(RETRY_MS);
  alerts = [CRIT_A, CRIT_C]; // the words name A
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'the red heard, naming A');
  assert.match(String(r.mon.status().lastSpokenMessage), /overvoltage/i);
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  alerts = [CRIT_A, CRIT_C];
  await until(r, () => r.has('again (flicker absorbed, nothing spoken)'), '★ absorbed');
  await sleep(60);
  assert.equal(plays.length, 1, 'nothing more spoken');
});

test('★★ v1.195.0 (N8): what was named audible is reset with every new red episode — C heard in an earlier red, then never delivered in this one, is spoken when it returns', async () => {
  const r = await started(RETRY_MS);
  alerts = [CRIT_C];
  await until(r, () => r.count('broadcast: red → ok in') === 1, 'C heard (episode 1)');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  offset += B.CONDITION_CLEAR_DWELL_MS + 1_000;
  await until(r, () => r.count('broadcast: green → ok in') === 1, 'the green committed and spoken');
  offset += 3 * MIN;
  alerts = [CRIT_A];
  await until(r, () => r.count('broadcast: red → ok in') === 2, 'A heard (episode 2)');
  offset += 3 * MIN;
  plan.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
  alerts = [CRIT_C]; // C takes A's place, never delivered in this episode
  await until(r, () => r.has('giving up after 3 deferred red retries'), 'C never delivered', 15_000);
  const urlC = plays[0].url;
  const before = heard(urlC);
  alerts = [];
  await until(r, () => r.count('red → green held') === 2, 'the dwell');
  await sleep(40);
  alerts = [CRIT_C];
  await until(r, () => heard(urlC) === before + 1, '★★ C spoken again: heard in episode 1 is not heard in episode 2');
});

test('★★ v1.195.0 (N8): a red adopted at a restart as already announced (the red replay gate) counts its critical as named — its flicker inside the dwell is absorbed', async () => {
  const a = await started(RETRY_MS);
  alerts = [CRIT_A];
  await until(a, () => a.count('broadcast: red → ok in') === 1, 'A heard before the restart');
  a.stop();
  offset += 2 * MIN; // the deploy
  const r = await started(RETRY_MS, false); // A still standing at the first tick: inside the warm-up
  await until(r, () => r.has('red suppressed — this standing fault was already announced'), 'adopted by the red replay gate');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  alerts = [CRIT_A];
  await until(r, () => r.has('again (flicker absorbed, nothing spoken)'), '★ absorbed: A was the critical announced');
  await sleep(60);
  assert.equal(plays.length, 1, 'A once, before the restart');
});

test('★★ v1.195.0 (review): …but only the critical it NAMED — one counted beside it, never named, that returns alone after the restart is spoken, as in one process', async () => {
  const a = await started(RETRY_MS);
  alerts = [CRIT_A, CRIT_C]; // the words name A; C is counted beside it
  await until(a, () => a.count('broadcast: red → ok in') === 1, 'the red heard before the restart, naming A');
  assert.match(String(a.mon.status().lastSpokenMessage), /overvoltage/i);
  a.stop();
  offset += 2 * MIN; // the deploy
  const r = await started(RETRY_MS, false); // both still standing at the first tick
  await until(r, () => r.has('red suppressed — this standing fault was already announced'), 'adopted by the red replay gate');
  offset += 3 * MIN; // past the same-level gap
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the dwell');
  alerts = [CRIT_C]; // C returns alone inside the dwell
  await until(r, () => plays.length === 2 && heard(plays[1].url) === 1, '★★ C named at last');
  assert.ok(r.has('and the critical it names (dpu-err-DPU-C'), r.logs.join('\n'));
  assert.ok(!r.has('again (flicker absorbed, nothing spoken)'));
});
