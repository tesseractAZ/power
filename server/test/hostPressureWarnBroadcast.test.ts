/**
 * v1.187.20 — the host-pressure warning dwell, end to end: selfVitals (reader overrides) →
 * computeAlerts → the REAL broadcast monitor (startBroadcastMonitor), with Home Assistant mocked
 * at the HTTP layer (undici MockAgent), the Wyoming renderer injected, and a controllable clock.
 *
 * 2026-10-10 22:33: a Home Assistant Core update held the load over the warning line for 59 s.
 * The warning counted toward the audible condition on its first assessment, and a yellow was
 * spoken on the speakers and the cordless phone. Pinned here: that blip speaks nothing; pressure
 * that stands 6 minutes speaks ONE yellow, at the 5-minute dwell, and its clear is the ordinary
 * de-escalation (the 3-minute clear dwell, then the all-clear); a critical is still red after its
 * own 180 s dwell.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded (config.dbPath is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-hp-bc-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha';
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
delete process.env.HOST_PRESSURE_WARN_DWELL_S;
delete process.env.HOST_PRESSURE_CRIT_DWELL_S;

const B = await import('../src/broadcast.js');
const { computeAlerts, _resetHostPressureDwellForTest, HOST_PRESSURE_WARN_DWELL_MS } = await import('../src/alerts.js');
const { ingestLagProbe, tickAssess, _resetVitalsForTest } = await import('../src/selfVitals.js');
const { ALL_CLEAR_MESSAGE } = await import('../src/alertPriority.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;
const SEC = 1_000;

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
const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-hp-bc-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });
/** The store computes the live alert set on every read, as the alert monitor would: the
 *  host-pressure alert and its dwell come from computeAlerts over the current assessment. */
const store = {
  get: () => ({ alerts: computeAlerts({}).filter((a: Alert) => a.id.startsWith('host-pressure-')) }),
} as any;

/** One vitals assessment now, load1 the only readable gauge (lag 0 ms, memory/disk null). */
function assess(load1: number): void {
  const now = Date.now();
  ingestLagProbe(0, now);
  tickAssess(now, { load: () => ({ load1, load5: load1 }), memAvailableMb: () => null, dataDiskFreeMb: () => null });
}

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
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-hp-bc-cache-'));
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
/** A completed condition broadcast of `level`. */
const played = (r: Rig, level: string) => r.count(`broadcast: ${level} → ok in`);
async function started(): Promise<Rig> {
  const r = rig();
  await sleep(80); // the first tick joins green
  offset += 11 * MIN; // past the boot warm-up window
  await sleep(40);
  return r;
}
/** Hold `load1` from now for `seconds`, re-assessed every 60 s, letting the monitor tick at
 *  every 20 s step (the alert monitor's cadence). */
async function hold(load1: number, seconds: number): Promise<void> {
  for (let s = 0; s < seconds; s += 20) {
    if (s % 60 === 0) assess(load1);
    await sleep(40);
    offset += 20 * SEC;
  }
}

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  announces = 0;
  _resetVitalsForTest();
  _resetHostPressureDwellForTest();
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ 10-10 replay: a 59 s host-load blip is never broadcast', async () => {
  const r = await started();
  await hold(4.2, 60); // assessed warn at +0 s; the alert ticks at +0, +20, +40 s see it
  assess(0.8); // +60 s: the ok assessment that cleared it (22:34:02.7)
  await sleep(60);
  offset += 4 * MIN;
  await sleep(80);
  assert.equal(announces, 0, '★ nothing was played');
  assert.ok(!r.has('condition transition'), `no condition transition at all\n${r.logs.join('\n')}`);
  assert.equal(r.mon.status().conditionLevel, 'green');
});

test('★★★ pressure that stands 6 min speaks ONE yellow after the 5-min dwell; its clear is the normal all-clear', async () => {
  assert.equal(HOST_PRESSURE_WARN_DWELL_MS, 5 * MIN);
  const r = await started();
  await hold(4.2, 300); // ticks at +0 … +280 s; the clock now reads +300 s
  assert.equal(announces, 0, '★ silent inside the dwell');
  assert.ok(!r.has('condition transition'), `nothing raised before the dwell\n${r.logs.join('\n')}`);
  await until(r, () => played(r, 'yellow') === 1, 'the yellow at the dwell (+300 s)');
  await hold(4.2, 60); // +360 s: still standing
  await sleep(60);
  assert.equal(r.count('condition transition → yellow'), 1, '★ raised once, no flapping at the boundary');
  assert.equal(announces, 1);
  // Recovery: an ok assessment. The ordinary de-escalation: held for the clear dwell, then spoken.
  assess(0.8);
  await until(r, () => r.has('yellow → green held'), 'the clear-dwell hold');
  offset += B.CONDITION_CLEAR_DWELL_MS - 10 * SEC;
  await sleep(60);
  assert.equal(played(r, 'green'), 0, 'no all-clear before the clear dwell');
  offset += 11 * SEC;
  await until(r, () => played(r, 'green') === 1, 'the all-clear');
  assert.equal(r.mon.status().lastSpokenMessage, ALL_CLEAR_MESSAGE);
  assert.equal(announces, 2, 'one yellow, one all-clear');
});

test('★★★ the critical is unchanged: crit pressure is red after its 180 s dwell, with no yellow first', async () => {
  const r = await started();
  await hold(7.0, 180); // ticks at +0 … +160 s, inside the crit dwell (the held warning); clock +180 s
  assert.equal(announces, 0, 'nothing inside the crit dwell');
  assert.ok(!r.has('condition transition'), `nothing raised before the crit dwell\n${r.logs.join('\n')}`);
  await until(r, () => played(r, 'red') === 1, 'the red at the crit dwell (+180 s)');
  assert.equal(played(r, 'yellow'), 0, '★ no yellow was spoken before the red');
  assert.equal(r.count('condition transition → red'), 1);
});
