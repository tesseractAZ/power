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
 * v1.197.0 (review) — and the all-clear a shelved critical holds back is OWED, not dropped
 * (broadcast.shelvedAllClearStep). Dropped, the all-clear of a red the house heard was never said once
 * the shelved critical cleared inside its window (heard, its Core shelved, the fault fixed), nor that of
 * a red that cleared while another Core's critical was shelved: the last words stayed a red that had
 * cleared. It is said once no shelved critical stands and the gate has been open the dwell (a flicker of
 * the held critical restarts it), across a restart only on a settled set, and dropped as before when the
 * gate is held by a critical whose all-clear it always drops (the reserve floor). Any commit cancels it.
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
const { MAINT_MAX_MS } = await import('../src/maintenanceWindow.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;
const DWELL = B.CONDITION_CLEAR_DWELL_MS;

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer. `failNext`: that many plays answer 500 (a deferred
 *    retry is armed); `holdPlay`: a play started while it is set ends only once it resolves (a long clip). ── */
let announces = 0;
let failNext = 0;
let holdPlay: Promise<void> | null = null;
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
    if (failNext > 0) {
      failNext -= 1;
      return { statusCode: 500, data: '{"message":"Server got itself in trouble"}' };
    }
    offset += 30_000; // play_announcement returns when playback ENDS — a real clip plays ~30 s
    const held = holdPlay;
    return { statusCode: 200, data: () => (held ?? Promise.resolve()).then(() => sleep(80)).then(() => '[]') };
  }).persist();

/* ── the monitor's other inputs ── */
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-maint-allclear-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
/** The speech service: stalled while `ttsDown` (every render fails, as Wyoming does under load). */
let ttsDown = false;
const renderTts = async () => (ttsDown
  ? { ok: false as const, error: 'wyoming render timeout' }
  : { ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
let alerts: Alert[] = [];
const store = { get: () => ({ alerts }) } as any;
/** BroadcastMonitorOpts.alertSetSettledSince — 0: settled since long before the restart's green; null:
 *  not settled (a boot store not yet populated). */
let settledSince: number | null = 0;

/** A Core's own critical (an inverter error code: a family a maintenance window holds). */
const CRIT_A: Alert = { id: 'dpu-err-DPU-A', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter error code', detail: 'x', fault: 'err7' } as Alert;
/** …the same critical as the alert monitor publishes it while that Core's window holds it
 *  (maintenanceWindow.applyMaintenanceMute). */
const shelved = (untilMs: number): Alert => ({ ...CRIT_A, annunciate: false, muteReason: MUTE_REASON_MAINTENANCE, shelvedUntilMs: untilMs } as Alert);
/** Another Core's critical, held by that Core's window. */
const shelvedB = (untilMs: number): Alert => ({ ...CRIT_A, id: 'dpu-err-DPU-B', device: 'Core 2', fault: 'err9', annunciate: false, muteReason: MUTE_REASON_MAINTENANCE, shelvedUntilMs: untilMs } as Alert);
/** The reserve floor: a critical the condition does not count (the runway alarm owns its audible) and
 *  whose all-clear the gate drops — never shelved. */
const RESERVE: Alert = { id: 'shp2-below-reserve-PANEL', severity: 'critical', category: 'Battery', device: 'Panel', title: 'Backup below reserve', detail: 'x' } as Alert;

interface Rig { mon: ReturnType<typeof B.startBroadcastMonitor>; logs: string[]; has: (s: string) => boolean; count: (s: string) => number; stop: () => void }
const live: Rig[] = [];
function rig(): Rig {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-maint-allclear-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => { logs.push(m); }, {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    alertSetSettledSince: () => settledSince,
    retryDelaysMs: [800, 800, 800],
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
const OWED_NOW = 'the all-clear is owed, not dropped: a critical a maintenance window holds is among those that gate it';
const OWED_SAID = 'the all-clear it held back (owed for';
const OWED_DROPPED = 'the all-clear a shelved critical held back is dropped';
const OWED_RESTORED = 'an all-clear a shelved critical held back was owed when the add-on stopped';
const owedAt = (): unknown => statusFile().shelvedAllClearOwedAt;

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
  settledSince = 0;
  ttsDown = false;
  failNext = 0;
  holdPlay = null;
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
  assert.equal(statusFile().conditionHeldFrom, null, 'the held de-escalation is over: the green committed');
  // v1.197.0 (review) — the all-clear the shelved critical holds back is owed, not dropped.
  assert.ok(b.has(OWED_NOW), '★ the all-clear is owed');
  assert.equal(typeof owedAt(), 'number', '★ …and on record');
  assert.equal(b.mon.status().shelvedAllClearOwedAt, owedAt());
  // The window ends with the critical still standing: it annunciates again and is announced.
  alerts = [CRIT_A];
  await until(b, () => played(b, 'red') === 1, '★ the critical announced at the window\'s end');
  assert.equal(b.count(GREEN_SPOKEN), 0, 'still no all-clear before it');
  assert.equal(announces, 2);
  assert.equal(owedAt(), null, '★★ the red\'s commit cancels the owed all-clear: its own clearing owes the next one');
  // The critical then clears: its green is the ordinary transition, said once.
  alerts = [];
  await until(b, () => b.has('red → green held'), 'the red\'s clearing held');
  offset += DWELL + MIN;
  await until(b, () => played(b, 'green') === 1, 'the all-clear');
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(played(b, 'green'), 1, '★ said once');
  assert.ok(!b.has(OWED_SAID));
});

/* ── v1.197.0 (review): the all-clear a shelved critical holds back is owed, not dropped ── */

/** A monitor past its warm-up that has announced the red for CRIT_A. */
async function heardRed(): Promise<Rig> {
  const a = rig();
  await sleep(80); // the first tick joins green
  offset += 11 * MIN; // past the boot warm-up window
  alerts = [CRIT_A];
  await until(a, () => played(a, 'red') === 1, 'the red announced');
  await sleep(40);
  return a;
}

/** …then its Core shelved with the critical standing: the red's clearing holds, and its green is
 *  adopted silently with the all-clear owed. */
async function heardRedThenShelved(): Promise<{ a: Rig; untilMs: number }> {
  const a = await heardRed();
  const untilMs = Date.now() + 2 * 60 * MIN;
  alerts = [shelved(untilMs)];
  await until(a, () => a.has('red → green held'), 'the hold');
  offset += DWELL + MIN;
  await until(a, () => a.has(OWED_NOW), 'the all-clear owed');
  assert.ok(a.has(GATED), 'the green adopted silently');
  assert.equal(announces, 1);
  assert.equal(typeof owedAt(), 'number', 'the owed all-clear on record');
  return { a, untilMs };
}

test('★★★ a heard red, its Core shelved, the fault then FIXED inside the window: the all-clear it held back is said — once the gate has been open the dwell, and a flicker of the held critical restarts it', async () => {
  const { a, untilMs } = await heardRedThenShelved();
  // The fault is fixed: the critical clears inside the window.
  alerts = [];
  await sleep(60);
  offset += DWELL - MIN; // not yet the dwell
  await sleep(60);
  // The held critical is back for one publish (a flicker): the gate closes, and its clock restarts.
  alerts = [shelved(untilMs)];
  await sleep(60);
  alerts = [];
  await sleep(60);
  offset += 2 * MIN; // 4 min since the gate first opened, 2 since it opened again
  await sleep(80);
  assert.equal(announces, 1, '★★ not yet: the gate has not stood open the dwell since the held critical was last seen');
  offset += 2 * MIN;
  await until(a, () => played(a, 'green') === 1, '★★★ the all-clear it held back');
  assert.ok(a.has(OWED_SAID));
  assert.equal(announces, 2);
  assert.equal(owedAt(), null, 'said: nothing owed');
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(announces, 2, 'said once');
});

test('★★★ a heard red on Core 1 that CLEARS while Core 2\'s critical is shelved: its all-clear is said once Core 2\'s is fixed', async () => {
  const a = await heardRed();
  const untilMs = Date.now() + 2 * 60 * MIN;
  alerts = [shelvedB(untilMs)]; // Core 1's fault clears; Core 2, being worked on, carries a held critical
  await until(a, () => a.has('red → green held'), 'the hold');
  offset += DWELL + MIN;
  await until(a, () => a.has(OWED_NOW), '★ owed, gated by Core 2\'s shelved critical');
  assert.equal(announces, 1);
  offset += 30 * MIN; // Core 2 is still being worked on
  await sleep(80);
  assert.equal(announces, 1, 'nothing over the shelved critical');
  alerts = []; // Core 2's fault is fixed inside its window
  await sleep(60);
  offset += DWELL + MIN;
  await until(a, () => played(a, 'green') === 1, '★★★ Core 1\'s all-clear');
  assert.equal(announces, 2);
});

test('★★★ the shelved critical clears while the reserve floor stands: no "All clear" over the floor — dropped, as that gate drops it', async () => {
  const { a } = await heardRedThenShelved();
  alerts = [RESERVE]; // the shelved critical fixed; the runway alarm's reserve floor stands
  await until(a, () => a.has(OWED_DROPPED), '★ dropped');
  assert.equal(owedAt(), null);
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(announces, 1, '★★★ no "All clear" while the reserve-floor critical stands');
  alerts = [];
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(announces, 1, 'the reserve floor\'s own clearing owes nothing (as before v1.197.0)');
});

test('★★★ a restart inside the window with the all-clear owed: kept on record, never said on an unsettled set, said once the shelved critical clears', async () => {
  const { a, untilMs } = await heardRedThenShelved();
  a.stop();
  offset += MIN; // the host's restart, inside the window
  // The boot store is not yet populated: it reads green with no shelved critical in it.
  settledSince = null;
  alerts = [];
  const b = rig();
  await until(b, () => b.has(OWED_RESTORED), '★★ the owed all-clear resumed');
  await sleep(60);
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(announces, 1, '★★★ never on an unsettled set: the empty store is no all-clear');
  // The store populates: the critical is still shelved (the window file outlives the restart).
  alerts = [shelved(untilMs)];
  settledSince = Date.now();
  await sleep(60);
  offset += DWELL + MIN;
  await sleep(80);
  assert.equal(announces, 1, 'nothing over the shelved critical');
  assert.equal(typeof owedAt(), 'number', 'still owed, on record');
  // The fault is fixed inside the window.
  alerts = [];
  await sleep(60);
  offset += DWELL + MIN;
  await until(b, () => played(b, 'green') === 1, '★★★ the all-clear owed from before the restart');
  assert.equal(announces, 2);
  assert.equal(owedAt(), null);
});

test('★★ the all-clear\'s spoken retry gated by a shelved critical: its words are owed, and said once the critical clears', async () => {
  const a = await heardRed();
  ttsDown = true; // the all-clear's words cannot be rendered: the tone alone
  alerts = [];
  await until(a, () => a.has('red → green held'), 'the hold');
  offset += DWELL + MIN;
  await until(a, () => a.has('spoken render failed — one retry scheduled in 90s'), 'the spoken retry scheduled');
  ttsDown = false;
  const untilMs = Date.now() + 2 * 60 * MIN;
  alerts = [shelved(untilMs)]; // the Core faults again and is shelved before the retry
  await sleep(40);
  offset += 2 * MIN;
  await until(a, () => a.has('spoken retry dropped'), 'the spoken retry gated');
  assert.ok(a.has(OWED_NOW), '★ owed');
  const before = announces;
  alerts = [];
  await sleep(60);
  offset += DWELL + MIN;
  await until(a, () => a.has(OWED_SAID), '★★ the all-clear\'s words');
  await until(a, () => announces === before + 1, 'played');
});

test('★★ a storm-gated all-clear\'s re-present held back by a shelved critical: owed, not dropped — said once the critical clears', async () => {
  const a = rig();
  await sleep(80);
  offset += 11 * MIN;
  // The 09-29 shape (stormGateRepeatAndAllClear.test.ts): the red's critical clears while its clip is
  // still playing, so its green stands the dwell less than 2 min after the red ENDS — the storm gate
  // refuses it and holds one re-present.
  let endClip!: () => void;
  holdPlay = new Promise<void>((res) => { endClip = res; });
  alerts = [CRIT_A];
  await until(a, () => announces === 1, 'the red reaching the speakers');
  alerts = [];
  await until(a, () => a.has('red → green held'), 'the green observed mid-clip');
  offset += 90_000;
  holdPlay = null;
  endClip();
  await until(a, () => played(a, 'red') === 1, 'the red to end');
  offset += DWELL - 90_000 + 1000;
  await until(a, () => a.has('green will be re-presented once the storm gate'), 'the storm gate refusing the green');
  // Another Core faults, and its window holds the critical, before the re-present.
  alerts = [shelvedB(Date.now() + 2 * 60 * MIN)];
  offset += 2 * MIN;
  await until(a, () => a.has('storm-gated green is not re-presented — a critical alert is still active'), 'the re-present gated');
  assert.ok(a.has('the storm-gated green gated — the all-clear is owed, not dropped'), '★ owed');
  assert.equal(announces, 1);
  alerts = []; // fixed inside the window
  await sleep(60);
  offset += DWELL + MIN;
  await until(a, () => played(a, 'green') === 1, '★★ the all-clear the re-present owed');
  assert.equal(announces, 2);
});

test('★★ an all-clear whose deferred retry a shelved critical holds back: owed, not dropped — said once the critical clears', async () => {
  const a = await heardRed();
  alerts = [];
  await until(a, () => a.has('red → green held'), 'the hold');
  failNext = 1; // the all-clear fails at the speakers: its retry is armed
  offset += DWELL + MIN;
  await until(a, () => a.has('deferred retry 1/3'), 'the all-clear failing, its retry armed');
  // The Core faults again before the retry, and its window holds the critical.
  alerts = [shelved(Date.now() + 2 * 60 * MIN)];
  await until(a, () => a.has('deferred green retry dropped — a critical alert is still active'), 'the retry gated');
  assert.ok(a.has('the all-clear\'s deferred retry gated — the all-clear is owed, not dropped'), '★ owed');
  assert.equal(played(a, 'green'), 0);
  alerts = []; // fixed inside the window
  await sleep(60);
  offset += DWELL + MIN;
  await until(a, () => played(a, 'green') === 1, '★★ the all-clear the retry owed');
});

/* ── the pure parts ── */

test('shelvedCriticalStands: a critical carrying shelvedUntilMs, nothing else', () => {
  assert.equal(B.shelvedCriticalStands([shelved(1)]), true);
  assert.equal(B.shelvedCriticalStands([{ ...shelved(1), severity: 'warning' } as Alert]), false, 'a shelved warning gates nothing');
  assert.equal(B.shelvedCriticalStands([CRIT_A, RESERVE]), false);
  assert.equal(B.shelvedCriticalStands([]), false);
});

test('shelvedAllClearStep: wait while not green or shelved; drop behind another gating critical; speak once open the dwell (restored: on a settled set)', () => {
  const T = 1_000_000;
  const base = { level: 'green' as const, blocked: false, shelved: false, openSinceMs: null, restored: false, settledSinceMs: null, nowMs: T };
  assert.deepEqual(B.shelvedAllClearStep({ ...base, level: 'red', openSinceMs: T - DWELL }), { action: 'wait', openSinceMs: null });
  assert.deepEqual(B.shelvedAllClearStep({ ...base, blocked: true, shelved: true, openSinceMs: T - DWELL }), { action: 'wait', openSinceMs: null }, 'a shelved critical restarts the clock');
  assert.equal(B.shelvedAllClearStep({ ...base, blocked: true }).action, 'drop');
  assert.deepEqual(B.shelvedAllClearStep(base), { action: 'wait', openSinceMs: T }, 'the gate opens now');
  assert.deepEqual(B.shelvedAllClearStep({ ...base, openSinceMs: T - DWELL + 1 }), { action: 'wait', openSinceMs: T - DWELL + 1 });
  assert.deepEqual(B.shelvedAllClearStep({ ...base, openSinceMs: T - DWELL }), { action: 'speak' }, 'the dwell is inclusive');
  // restored after a restart: never unsettled; from the later of the open clock and the settled stamp
  assert.deepEqual(B.shelvedAllClearStep({ ...base, restored: true, openSinceMs: T - 10 * DWELL }), { action: 'wait', openSinceMs: T - 10 * DWELL });
  assert.equal(B.shelvedAllClearStep({ ...base, restored: true, openSinceMs: T - 10 * DWELL, settledSinceMs: T - DWELL + 1 }).action, 'wait');
  assert.equal(B.shelvedAllClearStep({ ...base, restored: true, openSinceMs: T - 10 * DWELL, settledSinceMs: T - DWELL }).action, 'speak');
  assert.equal(B.shelvedAllClearStep({ ...base, restored: true, openSinceMs: T - DWELL + 1, settledSinceMs: 0 }).action, 'wait');
});

test('restoredShelvedAllClear: a finite time on a committed green, within the window limit, never later than the boot', () => {
  const boot = 50 * 3_600_000;
  assert.equal(B.SHELVED_ALLCLEAR_RESTORE_MAX_AGE_MS, MAINT_MAX_MS);
  const rec = (at: unknown, level: unknown = 'green') => ({ conditionLevel: level, conditionSpoken: false, shelvedAllClearOwedAt: at });
  assert.equal(B.restoredShelvedAllClear(rec(boot - MIN), boot), boot - MIN);
  assert.equal(B.restoredShelvedAllClear(rec(boot - MAINT_MAX_MS), boot), boot - MAINT_MAX_MS, 'inclusive');
  assert.equal(B.restoredShelvedAllClear(rec(boot - MAINT_MAX_MS - 1), boot), null);
  assert.equal(B.restoredShelvedAllClear(rec(boot + MIN), boot), boot, 'a clock stepped back does not renew it');
  assert.equal(B.restoredShelvedAllClear(rec(boot - MIN, 'red'), boot), null, 'a later commit rewrote the record');
  assert.equal(B.restoredShelvedAllClear(rec(null), boot), null);
  assert.equal(B.restoredShelvedAllClear(rec('1'), boot), null);
  assert.equal(B.restoredShelvedAllClear(rec(Number.NaN), boot), null);
  assert.equal(B.restoredShelvedAllClear(null, boot), null);
  assert.equal(B.restoredShelvedAllClear({ conditionLevel: 'green' }, boot), null, 'a record written before v1.197.0');
});
