/**
 * v1.197.0 (integration) — a critical a maintenance window holds also blocks the all-clear a restart
 * OWES (v1.195.0, restoredHeldDeescalation), through the REAL broadcast monitor.
 *
 * The two lanes meet here. v1.195.0 resumes, after a restart, the held de-escalation of a level that
 * was audible, and announces its green as a recovery once it has stood its dwell on a settled set:
 * before, that all-clear was never said. v1.197.0 holds one Core's own alerts in a maintenance window
 * (annunciate:false with Alert.shelvedUntilMs), and a shelved critical blocks a spoken "All clear"
 * (allClearSpeechBlocked: shelved is held, not cleared). A critical the window starts holding while its
 * red is clearing reads green to the condition, so the resumed hold's recovery would say "All clear.
 * All stations report normal." over a fault that still stands, unless the recovery passes the same
 * gate. It does: the green is adopted silently, and the critical is announced when the window ends.
 * The control run (no shelved critical) speaks the owed all-clear, so the gate is what holds it.
 *
 * The rig is restartRecoveryAllClear.test.ts's, cut to what these cases use: Home Assistant mocked at
 * the HTTP layer (undici MockAgent), the Wyoming renderer injected, and a controllable clock.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-maint-allclear-'));
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
const { MUTE_REASON_MAINTENANCE } = await import('../src/alerts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;
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
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-maint-allclear-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;
/** BroadcastMonitorOpts.alertSetSettledSince — 0: settled since long before the restart's green. */
const settledSince = 0;

/** A Core's own critical (an inverter error code: a family a maintenance window holds). */
const CRIT_A: Alert = { id: 'dpu-err-DPU-A', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter error code', detail: 'x', fault: 'err7' } as Alert;
/** …the same critical as the alert monitor publishes it while that Core's window holds it
 *  (maintenanceWindow.applyMaintenanceMute). */
const shelved = (untilMs: number): Alert => ({ ...CRIT_A, annunciate: false, muteReason: MUTE_REASON_MAINTENANCE, shelvedUntilMs: untilMs } as Alert);

interface Rig { mon: ReturnType<typeof B.startBroadcastMonitor>; logs: string[]; has: (s: string) => boolean; count: (s: string) => number; stop: () => void }
const live: Rig[] = [];
function rig(): Rig {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-maint-allclear-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => { logs.push(m); }, {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    alertSetSettledSince: () => settledSince,
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
const statusFile = (): Record<string, unknown> => JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
const OWED = 'its all-clear is owed: the green is held';
const GATED = 'green adopted silently — a critical alert is still active (all-clear speech gated)';
const GREEN_SPOKEN = 'condition transition → green';

/** A monitor past its warm-up that has announced the red for CRIT_A, stopped while that red's
 *  clearing stands the dwell (`clearingAs`: what the store shows as it clears): the deploy lands
 *  inside the hold, which the record keeps (conditionHeldFrom). */
async function heardRedThenClearing(clearingAs: Alert[]): Promise<void> {
  const a = rig();
  await sleep(80); // the first tick joins green
  offset += 11 * MIN; // past the boot warm-up window
  alerts = [CRIT_A];
  await until(a, () => played(a, 'red') === 1, 'the red announced');
  await sleep(40);
  alerts = clearingAs;
  await until(a, () => a.has('red → green held'), 'the hold');
  await sleep(40);
  assert.equal(statusFile().conditionHeldFrom, 'red', 'the hold is on record');
  a.stop();
  offset += 2 * MIN; // the deploy, inside the dwell
}

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  announces = 0;
  alerts = [];
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ control: a restart inside the dwell of a heard red whose critical has CLEARED speaks the all-clear it owes', async () => {
  await heardRedThenClearing([]);
  assert.equal(announces, 1);
  const b = rig();
  await until(b, () => b.has(OWED), 'the hold resumed');
  offset += DWELL + MIN;
  await until(b, () => played(b, 'green') === 1, 'the owed all-clear');
  assert.equal(b.count(GREEN_SPOKEN), 1);
  assert.ok(!b.has(GATED));
  assert.equal(announces, 2);
});

test('★★★ a restart inside the dwell of a red whose critical a maintenance window now HOLDS: no "All clear" over it — adopted silently, and the critical is the klaxon when the window ends', async () => {
  // The window starts while the red stands: the critical reads green to the condition (annunciate
  // false), so the red's clearing begins its dwell with the fault still on the card.
  const untilMs = Date.now() + 11 * MIN + 2 * 60 * MIN;
  await heardRedThenClearing([shelved(untilMs)]);
  assert.equal(announces, 1);
  const b = rig();
  // The store populates after the restart with the critical still held by the window (the window
  // file outlives the restart).
  await until(b, () => b.has(OWED), 'the hold resumed');
  alerts = [shelved(untilMs)];
  offset += DWELL + MIN;
  await until(b, () => b.has(GATED), '★ the owed all-clear is gated by the shelved critical');
  await sleep(60);
  assert.equal(played(b, 'green'), 0, 'no "All clear" spoken');
  assert.equal(b.count(GREEN_SPOKEN), 0);
  assert.equal(announces, 1, 'nothing announced over the shelved critical');
  assert.equal(b.mon.status().conditionLevel, 'green', 'the level is adopted, silently');
  assert.equal(statusFile().conditionHeldFrom, null, 'nothing owed any more: the green committed');
  // The window ends with the critical still standing: it annunciates again and is announced.
  alerts = [CRIT_A];
  await until(b, () => played(b, 'red') === 1, '★ the critical announced at the window\'s end');
  assert.equal(b.count(GREEN_SPOKEN), 0, 'still no all-clear before it');
  assert.equal(announces, 2);
});
