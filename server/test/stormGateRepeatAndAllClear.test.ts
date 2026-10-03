/**
 * v1.187.0 — the storm gate, driven through the REAL broadcast monitor (startBroadcastMonitor)
 * with Home Assistant mocked at the HTTP layer (undici MockAgent), the Wyoming renderer
 * injected, and a controllable clock.
 *
 * (1) REPEAT WARNINGS. The identical-message gate compares the whole spoken text, and a
 *     warning's text carries its live reading, so the same Core 1 pack 1 warning was freshly
 *     rendered and spoken at 15:16, 15:21 and 15:26 on 2026-09-29. A repeat is now recognised by
 *     a stable identity — but never after an all-clear was SPOKEN (the review's correction:
 *     that would leave "All clear" as the last word while the warning stands).
 *
 * (2) THE DROPPED ALL-CLEAR. At 15:41:10 the green after the 15:38 red was refused by the
 *     same-level gap 67 s after the red ended and never retried; the last words in the house
 *     were a critical that had cleared. A storm-gated de-escalation is now re-presented once.
 *     Review: the deferral WAITS while a lower level stands its dwell (dropping it there lost a
 *     new warning whose return the dwell then absorbed), and a same-level refusal of something
 *     NEW (a new warning, a different critical) is re-presented too, while it is still counted.
 *
 * (3) THE STATUS RECORD. That refusal became /api/broadcast/status's last broadcast, green,
 *     outcome 'partial', while lastSpokenMessage was the red. Suppressions are recorded apart.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-storm-'));
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
const { restampAlertOnset } = await import('../src/alertOnset.js');
const { ALL_CLEAR_MESSAGE } = await import('../src/alertPriority.js');
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

/* ── Home Assistant, mocked at the HTTP layer. A SLOW play (1.5 s real) lets a test move the
 *    condition, and the clock, while a clip is still playing — the 15:38-15:41 shape. ── */
let announces = 0;
let slowPlay = false;
const PLAY = '/core/api/services/music_assistant/play_announcement';
const playReply = () => {
  announces += 1;
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
let speakerState = 'idle';
ha.intercept({ path: (p: string) => p.startsWith('/core/api/states/'), method: 'GET' })
  .reply(() => ({ statusCode: 200, data: JSON.stringify({ state: speakerState, attributes: {} }) })).persist();
ha.intercept({ path: (p: string) => p === PLAY && slowPlay, method: 'POST' }).reply(playReply).delay(1500).persist();
ha.intercept({ path: (p: string) => p === PLAY && !slowPlay, method: 'POST' }).reply(playReply).delay(80).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-storm-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;

const PEER_ID = 'peer-voldiff-COREXXX00XXX0001-1';
/** The 09-29 warning: its spoken detail carries the live mV and z. */
const peer = (mv: number): Alert => ({
  id: PEER_ID, severity: 'warning', category: 'Battery', source: 'learned', device: 'Core 1', coreNum: 1, packNum: 1,
  title: 'Cell voltage spread — peer outlier',
  detail: `Core 1 Pack 1 cell-voltage spread is ${mv} mV, ${mv - 20} mV higher than the sibling-pack median of 20 mV (peer z-score ${(mv / 7).toFixed(1)}).`,
} as Alert);
/** A second warning that sorts AFTER the peer outlier (Thermal < Battery), so the peer is still
 *  the alert named aloud when both stand. */
const WARN_T: Alert = { id: 'pack-temp-warn-DPU-A', severity: 'warning', category: 'Thermal', device: 'Core 1', coreNum: 1, title: 'Pack temperature high', detail: 'x' } as Alert;
/** A different warning that would be named aloud on its own. */
const WARN_S: Alert = { id: 'soc-low-DPU-C-3', severity: 'warning', category: 'Battery', device: 'Core 3', coreNum: 3, packNum: 3, title: 'Pack state of charge low', detail: 'x' } as Alert;
/** A critical released the tick it clears. Not a cell-spread critical: one of those that sounded is
 *  held for SOUNDED_VDIFF_ABSENT_HOLD_MS after it clears (it may be between two BMS readings —
 *  conditionDeescalationDwell.test.ts), so its all-clear never falls inside the storm gap. */
const CRIT: Alert = { id: 'cell-ovp-COREXXX00XXX0001-1', severity: 'critical', category: 'Battery', device: 'Core 1', coreNum: 1, packNum: 1, title: 'Cell overvoltage', detail: 'highest cell at 3.612 V' } as Alert;
/** A DIFFERENT critical, on another device. */
const CRIT_2: Alert = { id: 'dpu-err-DPU-B', severity: 'critical', category: 'Battery', device: 'Core 2', coreNum: 2, title: 'Inverter error code', detail: 'x', fault: 'err7' } as Alert;
/** Excluded from the condition count (the runway alarm owns it) but a critical, so a green
 *  commits while the all-clear SPEECH gate holds: a silent green. */
const RESERVE: Alert = { id: 'shp2-below-reserve-SHP2-P', severity: 'critical', category: 'SHP2', device: 'SHP2', title: 'At reserve', detail: 'x' } as Alert;

interface Rig {
  mon: ReturnType<typeof B.startBroadcastMonitor>;
  logs: string[];
  has: (s: string) => boolean;
  count: (s: string) => number;
  stop: () => void;
}
const live: Rig[] = [];
function rig(): Rig {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-storm-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
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
const played = (r: Rig, level: string) => r.count(`broadcast: ${level} → ok in`);
async function started(): Promise<Rig> {
  const r = rig();
  await sleep(80); // the first tick joins green
  // Past the boot warm-up window — v1.187.4: and past the restart question (boot + 16, or 19 on a
  // settled set): a second monitor boots on the first one's heard level.
  offset += 20 * MIN;
  return r;
}
/** Speak the peer warning, then commit a green SILENTLY (the all-clear speech gate holds it). */
async function yellowThenSilentGreen(r: Rig): Promise<void> {
  alerts = [peer(58)];
  await until(r, () => played(r, 'yellow') === 1, 'the peer yellow');
  alerts = [RESERVE];
  await until(r, () => r.has('yellow → green held'), 'the de-escalation dwell');
  offset += DWELL + SEC;
  await until(r, () => r.has('green adopted silently'), 'the silent green');
}

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  announces = 0;
  slowPlay = false;
  speakerState = 'idle';
  alerts = [];
  process.env.BROADCAST_QUIET_HOURS = '';
  delete process.env.CRITICAL_BREAKS_QUIET_HOURS;
  restampAlertOnset(PEER_ID, Date.now() - 11 * MIN); // past the imbalance speak hold
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

/* ══ (1) the repeat-warning gate ═══════════════════════════════════════════════════════════ */

test('★★★ the same warning with a new reading is not re-spoken after an UNSPOKEN green (identity, not text)', async () => {
  const r = await started();
  await yellowThenSilentGreen(r);
  alerts = [peer(61), RESERVE]; // same alert, new live numbers; >2 min since the yellow played
  await until(r, () => r.has('yellow suppressed — the same warning'), 'the repeat to be recognised');
  assert.equal(announces, 1, 'spoken once');
  const s = r.mon.status();
  assert.equal(s.stormSuppressedCount, 1);
  assert.equal(s.lastSuppressedLevel, 'yellow');
  assert.equal(s.lastSuppressedReason, 'same warning already voiced');
  assert.equal(s.lastSuppressedKind, 'condition');
  assert.equal(s.lastLevel, 'yellow', 'the last BROADCAST is still the yellow that played');
  assert.equal(s.lastOutcome, 'success');
});

test('★★★ after an all-clear was SPOKEN, the same warning returning IS spoken', async () => {
  const r = await started();
  alerts = [peer(58)];
  await until(r, () => played(r, 'yellow') === 1, 'the yellow');
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(r, () => played(r, 'green') === 1, 'the spoken all-clear');
  alerts = [peer(61)];
  await until(r, () => played(r, 'yellow') === 2 || r.has('same warning'), 'the returning warning');
  assert.equal(played(r, 'yellow'), 2, '"All clear" must not be the last word while the warning stands');
  assert.ok(!r.has('same warning'));
});

test('★★ a green refused by the storm gate does not count as heard: the repeat is still recognised', async () => {
  // A green that never reached the speakers leaves the warning the last thing heard.
  const r = await started();
  await yellowThenSilentGreen(r);
  alerts = [peer(64), RESERVE];
  await until(r, () => r.has('same warning'), 'the repeat');
  assert.equal(announces, 1);
});

test('★★ a DIFFERENT warning is spoken; so is the same one with a NEW warning beside it', async () => {
  const r = await started();
  await yellowThenSilentGreen(r);
  alerts = [peer(61), WARN_T, RESERVE]; // named alert unchanged, but WARN_T nobody has heard
  await until(r, () => played(r, 'yellow') === 2 || r.has('same warning'), 'the peer + a new warning');
  assert.equal(played(r, 'yellow'), 2, 'a warning nobody has heard is never swallowed behind one they have');
  r.stop(); // one monitor at a time: they share the alert store and the clock
  alerts = [];

  const r2 = await started();
  await yellowThenSilentGreen(r2);
  alerts = [WARN_S, RESERVE];
  await until(r2, () => played(r2, 'yellow') === 2 || r2.has('same warning'), 'a different warning');
  assert.equal(played(r2, 'yellow'), 2);
});

test('★★ a yellow that never reached the speakers is not remembered: its repeat is spoken', async () => {
  const r = await started();
  speakerState = 'unavailable';
  alerts = [peer(58)];
  await until(r, () => r.has('deferred retry 1/3'), 'the yellow deferring (no usable speaker)');
  speakerState = 'idle';
  alerts = [RESERVE];
  await until(r, () => r.has('yellow → green held'), 'the dwell');
  offset += DWELL + SEC;
  await until(r, () => r.has('green adopted silently'), 'the silent green');
  alerts = [peer(61), RESERVE];
  await until(r, () => played(r, 'yellow') === 1 || r.has('same warning'), 'the warning again');
  assert.equal(played(r, 'yellow'), 1, 'a warning nobody heard is not a repeat');
});

test('★ the gate lapses: the same warning is spoken again after SAME_WARNING_REPEAT_GAP_MS', async () => {
  const r = await started();
  await yellowThenSilentGreen(r);
  offset += B.SAME_WARNING_REPEAT_GAP_MS;
  alerts = [peer(61), RESERVE];
  await until(r, () => played(r, 'yellow') === 2 || r.has('same warning'), 'the reminder');
  assert.equal(played(r, 'yellow'), 2);
});

test('★★ a red spoken in between ends the memory: the warning after it is spoken', async () => {
  const r = await started();
  await yellowThenSilentGreen(r);
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  offset += 3 * MIN; // past the storm gap
  alerts = [peer(70)]; // a critical that clears to its warning: new to the audible → spoken at once
  await until(r, () => played(r, 'yellow') === 2 || r.has('same warning') || r.has('(storm gate)'), 'the warning after the red');
  assert.equal(played(r, 'yellow'), 2, 'the last words must not stay a cleared critical');
});

/* ══ (2) the dropped all-clear ═════════════════════════════════════════════════════════════ */

/** The 15:38-15:41 shape: a red plays; its critical clears WHILE the clip is still playing, so
 *  the green has stood the dwell less than 2 min after the red ENDED — the storm gate refuses it. */
async function redThenGatedGreen(r: Rig): Promise<void> {
  slowPlay = true;
  const before = announces;
  alerts = [CRIT];
  await until(r, () => announces === before + 1, 'the red reaching the speakers');
  alerts = [];
  await until(r, () => r.has('red → green held'), 'the green observed mid-clip');
  offset += 90 * SEC; // the clip is long; the green keeps standing
  await until(r, () => played(r, 'red') === 1, 'the red to end');
  slowPlay = false;
  offset += DWELL - 90 * SEC + SEC; // green has stood the dwell; the red ended ~91 s ago
  await until(r, () => r.has('green suppressed — last red condition broadcast played'), 'the storm gate refusing the green');
}

test('★★★ 09-29 15:41: the all-clear the storm gate refused is re-presented once the gap expires', async () => {
  const r = await started();
  await redThenGatedGreen(r);
  assert.ok(r.has('green will be re-presented once the storm gate'));
  assert.equal(announces, 1);
  offset += 20 * SEC;
  await sleep(60);
  assert.equal(announces, 1, 'not inside the gap');
  offset += 15 * SEC;
  await until(r, () => played(r, 'green') === 1, 'the re-presented all-clear');
  assert.ok(r.has('re-presenting the green the storm gate refused'));
  assert.equal(r.mon.status().lastSpokenMessage, ALL_CLEAR_MESSAGE, 'the last words are the all-clear, not the cleared critical');
  offset += 10 * MIN;
  await sleep(80);
  assert.equal(announces, 2, 'once');
});

test('★★ the re-present is dropped when the condition moved, and a rise supersedes it', async () => {
  const r = await started();
  await redThenGatedGreen(r);
  alerts = [WARN_S]; // a rise to yellow — a fresh transition supersedes the held green
  await until(r, () => r.has('condition transition → yellow'), 'the yellow');
  offset += 5 * MIN;
  await sleep(80);
  assert.ok(!r.has('re-presenting the green'), 'the superseded all-clear is never spoken');
});

test('★★ a newer commit supersedes the held all-clear even when the condition is green again at expiry', async () => {
  const r = await started();
  await redThenGatedGreen(r);
  alerts = [CRIT]; // the same critical is back: a transition to red, refused (heard 91 s ago)
  await until(r, () => r.count('(storm gate)') === 2, 'the red refused');
  alerts = [];
  await until(r, () => r.count('red → green held') === 2, 'the second hold');
  offset += 40 * SEC; // the first all-clear's gap has expired; this green has not stood the dwell
  await sleep(80);
  assert.ok(!r.has('re-presenting the green'), 'a superseded all-clear is never spoken mid-hold');
  assert.equal(announces, 1);
  offset += DWELL;
  await until(r, () => played(r, 'green') === 1, 'the all-clear once this green has stood');
});

test('★★ the re-present honours the all-clear speech gate and quiet hours', async () => {
  const r = await started();
  await redThenGatedGreen(r);
  alerts = [RESERVE]; // still green, but a critical is active
  offset += 2 * MIN;
  await until(r, () => r.has('storm-gated green is not re-presented — a critical alert is still active'), 'the speech gate');
  assert.equal(announces, 1);
  r.stop(); // one monitor at a time: they share the alert store and the clock
  alerts = [];

  const r2 = await started();
  await redThenGatedGreen(r2);
  const h = new Date().getHours(); // inQuiet reads the wall clock, not Date.now
  process.env.BROADCAST_QUIET_HOURS = `${h}-${(h + 2) % 24}`;
  offset += 2 * MIN;
  await until(r2, () => r2.has('storm-gated green is not re-presented — quiet hours'), 'quiet hours');
  assert.equal(announces, 2, 'only the second rig\'s red played');
});

test('★★ a yellow after a cleared red that the gap refused is re-presented (the red is not the last word)', async () => {
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  alerts = [WARN_S]; // the critical clears; a NEW warning → committed at once, inside the gap
  await until(r, () => r.has('yellow suppressed — last red condition broadcast played'), 'the gap refusing the yellow');
  assert.ok(r.has('yellow will be re-presented'));
  offset += 2 * MIN;
  await until(r, () => played(r, 'yellow') === 1, 'the re-presented yellow');
  assert.match(r.mon.status().lastSpokenMessage ?? '', /state of charge low/i);
});

test('★★ …while the condition stands BELOW it the deferral waits, and the lower level\'s commit supersedes it', async () => {
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  alerts = [WARN_S];
  await until(r, () => r.has('yellow will be re-presented'), 'the refused yellow');
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the hold');
  offset += 2 * MIN;
  await until(r, () => r.has('storm-gated yellow waits — the condition is green now'), 'the wait');
  assert.equal(announces, 1, 'a yellow is never spoken over a green');
  offset += DWELL;
  await until(r, () => played(r, 'green') === 1, 'the all-clear, once the green has stood');
  assert.equal(played(r, 'yellow'), 0, 'the green commit superseded the deferred yellow');
  offset += 10 * MIN;
  await sleep(80);
  assert.equal(announces, 2);
});

test('★★★ review: a refused NEW warning is not lost when the condition is green at the due tick and the warning returns', async () => {
  // The peer z-score sat on the warning/info line: info when the red commits, warning when the
  // red clears, flickering at the due tick. Dropping the deferral there left the warning in
  // prevWarnFps, so its return was a flicker the dwell absorbs — never spoken while it stood.
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  alerts = [WARN_S]; // the critical clears; a NEW warning → committed at once, refused by the gap
  await until(r, () => r.has('yellow will be re-presented'), 'the refused yellow');
  alerts = [{ ...WARN_S, severity: 'info' } as Alert]; // it dips to info: green, held by the dwell
  await until(r, () => r.has('yellow → green held'), 'the hold');
  offset += 2 * MIN; // due — but the condition is green
  await until(r, () => r.has('storm-gated yellow waits'), 'the deferral waiting');
  assert.equal(announces, 1);
  alerts = [WARN_S]; // back: a flicker the dwell absorbs, so only the re-present can speak it
  await until(r, () => played(r, 'yellow') === 1, 'the warning, re-presented');
  assert.match(r.mon.status().lastSpokenMessage ?? '', /state of charge low/i, 'the last words are not the cleared critical');
  assert.ok(r.has('again — the storm-gated condition is re-presented'), 'the held green is over');
  offset += 20 * MIN;
  await sleep(80);
  assert.equal(announces, 2, 'once');
  assert.ok(!r.has('storm-gated yellow is not re-presented'));
});

test('★★ review: a NEW warning the SAME-level gap refused is re-presented once the gap expires', async () => {
  // Inside a held yellow→green a different warning commits at once (newWarn), but a yellow was
  // spoken moments ago: the same-level gap refuses it. Recorded in prevWarnFps, each later
  // flicker of it was absorbed by the dwell — it was never voiced.
  const r = await started();
  alerts = [peer(58)];
  await until(r, () => played(r, 'yellow') === 1, 'the peer yellow');
  alerts = [];
  await until(r, () => r.has('yellow → green held'), 'the hold');
  alerts = [WARN_S];
  await until(r, () => r.has('yellow will be re-presented'), 'the new warning refused by the gap');
  assert.ok(r.has('condition transition → yellow (new warning)'));
  assert.ok(r.has('yellow suppressed — last yellow condition broadcast played'));
  offset += 2 * MIN;
  await until(r, () => played(r, 'yellow') === 2, 'the re-presented warning');
  assert.match(r.mon.status().lastSpokenMessage ?? '', /state of charge low/i);
  offset += 20 * MIN;
  await sleep(80);
  assert.equal(announces, 2, 'once');
});

test('★★ review: a DIFFERENT critical the same-level gap refused is re-presented when the gap expires', async () => {
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  alerts = [CRIT_2]; // the critical is replaced at the same count, inside the gap
  await until(r, () => r.has('red will be re-presented'), 'the replacement refused by the gap');
  assert.ok(r.has('condition transition → red (new crit)'));
  offset += 2 * MIN;
  await until(r, () => played(r, 'red') === 2, 'the replacement, re-presented');
  assert.match(r.mon.status().lastSpokenMessage ?? '', /inverter error code/i);
  offset += 20 * MIN;
  await sleep(80);
  assert.equal(announces, 2, 'once');
});

test('★★ review: a refused critical is re-presented in quiet hours when criticals break through (as the tick\'s own red)', async () => {
  const h = new Date().getHours(); // inQuiet reads the wall clock, not Date.now
  process.env.BROADCAST_QUIET_HOURS = `${h}-${(h + 2) % 24}`;
  process.env.CRITICAL_BREAKS_QUIET_HOURS = 'true';
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red, breaking through');
  alerts = [CRIT_2];
  await until(r, () => r.has('red will be re-presented'), 'the replacement refused by the gap');
  offset += 2 * MIN;
  await until(r, () => played(r, 'red') === 2 || r.has('is not re-presented'), 'the re-present');
  assert.equal(played(r, 'red'), 2);
});

test('★★ a rise AT the due tick drops the re-present: the all-clear is never spoken over it', async () => {
  const r = await started();
  await redThenGatedGreen(r);
  offset += 2 * MIN; // due — and on the same tick the condition rises
  alerts = [WARN_S];
  await until(r, () => played(r, 'yellow') === 1, 'the yellow');
  assert.ok(r.has('storm-gated green is not re-presented — the condition is yellow now'));
  assert.equal(played(r, 'green'), 0, '"All clear" is never spoken over a standing warning');
});

test('★★ review: …but not once what was new has gone (the critical still standing was the one just heard)', async () => {
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1, 'the red');
  alerts = [CRIT_2];
  await until(r, () => r.has('red will be re-presented'), 'the replacement refused by the gap');
  alerts = [{ ...CRIT, detail: 'highest cell at 3.618 V' } as Alert]; // the first returns (new text), the replacement gone
  offset += 2 * MIN;
  await until(r, () => r.has('storm-gated red is not re-presented — what was new to it is no longer counted'), 'the drop');
  await sleep(60);
  assert.equal(announces, 1, 'the critical heard 2 min ago is not repeated for a replacement that has cleared');
});

/* ══ (3) the status record ═════════════════════════════════════════════════════════════════ */

test('★★ /api/broadcast/status: a storm-gated green is a SUPPRESSION, not the last broadcast (outcome partial)', async () => {
  const r = await started();
  await redThenGatedGreen(r);
  const s = r.mon.status();
  assert.equal(s.lastLevel, 'red', 'the last broadcast is the red that played');
  assert.equal(s.lastOutcome, 'success', 'never "partial" for something that was not attempted');
  assert.ok(!s.lastErrors.some((e) => e.startsWith('suppressed:')));
  assert.equal(s.lastSuppressedLevel, 'green');
  assert.equal(s.lastSuppressedKind, 'condition');
  assert.equal(s.lastSuppressedReason, 'same-or-lower level within gap');
  assert.ok(s.lastSuppressedAt != null && s.lastBroadcastAt != null && s.lastSuppressedAt > s.lastBroadcastAt);
  assert.equal(s.stormSuppressedCount, 1);
  const disk = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  assert.equal(disk.lastLevel, 'red');
  assert.equal(disk.lastSuppressedLevel, 'green');
});

test('★★ …and a storm-gated dedicated announcement likewise', async () => {
  const r = await started();
  alerts = [CRIT];
  await until(r, () => played(r, 'red') === 1 && r.mon.status().lastBroadcastKind === 'condition', 'the red');
  const a = await r.mon.announce('high', 'Warning. Backup pool at 20 percent.', null);
  assert.equal(a.ok, false);
  assert.match(a.error ?? '', /same-or-lower level within gap/);
  const s = r.mon.status();
  assert.equal(s.lastBroadcastKind, 'condition');
  assert.equal(s.lastLevel, 'red');
  assert.equal(s.lastOutcome, 'success');
  assert.equal(s.lastSuppressedKind, 'dedicated');
});

/* ── pure pieces ─────────────────────────────────────────────────────────────────────────── */

test('isStormSuppression — only a result made entirely of suppressions', () => {
  assert.equal(B.isStormSuppression({ errors: ['suppressed: same-or-lower level within gap'] }), true);
  assert.equal(B.isStormSuppression({ errors: ['suppressed: identical message within gap'] }), true);
  assert.equal(B.isStormSuppression({ errors: [] }), false, 'a success');
  assert.equal(B.isStormSuppression({ errors: ['all broadcast targets unavailable (HA/MA restarting?)'] }), false);
  assert.equal(B.isStormSuppression({ errors: ['render: x', 'fallback: chime-only (spoken render failed)'] }), false);
});

test('sameWarningRepeat — same named alert, same rung, no new warning, inside the gap', () => {
  const t = 50_000_000;
  const last = { voicedFp: 'F', rung: 'medium' as const, warnFps: ['F', 'H'], atMs: t - MIN };
  const cur = { voicedFp: 'F', rung: 'medium' as const, warnFps: ['F'] };
  assert.equal(B.SAME_WARNING_REPEAT_GAP_MS, 30 * MIN);
  assert.equal(B.sameWarningRepeat(cur, last, t), true);
  assert.equal(B.sameWarningRepeat({ ...cur, warnFps: ['F', 'H'] }, last, t), true, 'the same set');
  assert.equal(B.sameWarningRepeat({ ...cur, warnFps: ['F', 'G'] }, last, t), false, 'a warning not counted then');
  assert.equal(B.sameWarningRepeat({ ...cur, voicedFp: 'H' }, last, t), false, 'a different alert named aloud');
  assert.equal(B.sameWarningRepeat({ ...cur, rung: 'high' }, last, t), false, 'a different tone');
  assert.equal(B.sameWarningRepeat({ ...cur, voicedFp: null }, last, t), false, 'nothing to name ⇒ cannot prove sameness');
  assert.equal(B.sameWarningRepeat(cur, null, t), false, 'nothing voiced (or a green/red since)');
  assert.equal(B.sameWarningRepeat(cur, { ...last, atMs: t - 30 * MIN }, t), false, 'the gap lapsed');
  assert.equal(B.sameWarningRepeat(cur, { ...last, atMs: t + SEC }, t), false, 'a future stamp is not evidence');
});
