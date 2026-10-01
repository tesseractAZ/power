/**
 * v1.187.1 — the boot holds say what they hold, and what became of it (general-4).
 *
 * 2026-09-30 06:32:58: "yellow standing at the first tick" and "yellow held for boot confirmation
 * (up to 120 s)" — and nothing after. The level fell back to green inside the hold and the yellow
 * was never spoken, but the log named no warning and the reset that dropped the hold wrote no line:
 * what the boot yellow was, and whether it was heard, could only be inferred from missing lines.
 * The one-tick red hold had the same gap. Now each hold line names the alerts held, and a hold that
 * ends below its level writes one line naming them; a hold that is adopted (spoken, or silenced by
 * a gate with its own line) ends silently. The real broadcast monitor, HA mocked at the HTTP layer,
 * a store that serves one alert set per tick.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';

/* ── environment: set BEFORE any src module is loaded ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-boothold-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.BROADCAST_ENABLED = 'true';
process.env.BROADCAST_TARGETS = 'media_player.alpha';
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
const H = await import('../src/broadcastHealth.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const MIN = 60_000;

// Monitor timers are unref'd; keep the event loop alive for the file.
const keepAlive = setInterval(() => {}, 1_000);

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
  .reply(() => { announces++; return { statusCode: 200, data: '[]' }; }).delay(20).persist();

const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-boothold-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });

/* ── the store: one alert set per tick from `script`, then the last one for good ── */
let script: Alert[][] = [];
let last: Alert[] = [];
const store = { get: () => ({ alerts: script.length > 0 ? (last = script.shift()!) : last }) } as any;
const serve = (...ticks: Alert[][]) => { script = ticks; };

const CRIT: Alert = { id: 'dpu-err-CORE1', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter fault', detail: 'x', fault: 'err7' } as Alert;
const WARN: Alert = { id: 'dpu-imbalance-CORE3', severity: 'warning', category: 'Battery', device: 'Core 3', title: 'Packs out of balance', detail: 'x' };
const WARN2: Alert = { id: 'pack-temp-warn-CORE1', severity: 'warning', category: 'Thermal', device: 'Core 1', title: 'Pack temperature high', detail: 'x' };

interface Rig { mon: ReturnType<typeof B.startBroadcastMonitor>; logs: string[]; has: (s: string) => boolean; count: (s: string) => number; stop: () => void }
const live: Rig[] = [];
function rig(): Rig {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-boothold-cache-'));
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
const line = (r: Rig, s: string) => r.logs.find((l) => l.includes(s)) ?? '';

beforeEach(() => {
  for (const r of live.splice(0)) r.stop();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  script = [];
  last = [];
  announces = 0;
  H.resetBroadcastHealth();
});
after(async () => {
  for (const r of live.splice(0)) r.stop();
  clearInterval(keepAlive);
  Date.now = realNow;
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ 09-30 06:32: a boot yellow that clears inside its hold is named when held, and its drop is logged once', async () => {
  // The first tick joins green; the warning stands two ticks, a second joins it, then all clear.
  serve([], [WARN], [WARN, WARN2], [WARN2], []);
  const r = rig();
  await until(r, () => r.has('boot yellow dropped'), 'the drop line');
  await sleep(100); // more green ticks: still one line
  const held = line(r, 'yellow held for boot confirmation');
  assert.match(held, /startup transients clear on their own \(dpu-imbalance-CORE3 \/ Packs out of balance\)$/, held);
  assert.equal(r.count('boot yellow dropped'), 1, 'one line per episode, not per tick');
  const dropped = line(r, 'boot yellow dropped');
  assert.match(dropped, /^broadcast: boot yellow dropped after \d+ s — cleared inside the hold, not spoken \(/);
  assert.ok(dropped.includes('dpu-imbalance-CORE3 / Packs out of balance'), 'what was first held');
  assert.ok(dropped.includes('pack-temp-warn-CORE1 / Pack temperature high'), 'and what joined it inside the hold');
  assert.equal(announces, 0, 'never spoken');
  assert.ok(!r.has('condition transition'));
});

test('★★★ a boot red held one tick names its critical, and its drop is logged once', async () => {
  serve([], [CRIT], []);
  const r = rig();
  await until(r, () => r.has('boot red dropped'), 'the red drop line');
  await sleep(100);
  assert.match(line(r, 'red held one tick'), /\(warm-up phantom guard\) \(dpu-err-CORE1 \/ Inverter fault \/ err7\)$/);
  assert.equal(r.count('boot red dropped'), 1);
  assert.equal(line(r, 'boot red dropped'), 'broadcast: boot red dropped — the level fell to green inside its one-tick confirmation; not spoken (dpu-err-CORE1 / Inverter fault / err7)');
  assert.equal(announces, 0);
});

test('★★ a held boot yellow that RISES to red is not "dropped": the red logs its own hold, and is spoken', async () => {
  serve([], [WARN], [WARN, CRIT]);
  const r = rig();
  await until(r, () => announces > 0 && r.has('condition transition → red'), 'the confirmed red');
  assert.ok(r.has('yellow held for boot confirmation'));
  assert.ok(r.has('red held one tick for boot confirmation'));
  assert.ok(!r.has('boot yellow dropped'), 'a rise to red is not a drop');
  assert.ok(!r.has('boot red dropped'));
  // The red clears later: an adopted hold is not reported as dropped.
  serve([]);
  await until(r, () => r.has('red → green held'), 'the de-escalation hold');
  offset += 4 * MIN; // past the de-escalation dwell
  await until(r, () => r.has('condition transition → green'), 'the green');
  await sleep(50);
  assert.ok(!r.has('boot red dropped'), 'a red that was spoken was not dropped');
  assert.ok(!r.has('boot yellow dropped'));
});

test('★★ a boot yellow confirmed and spoken is not reported as dropped when it later clears', async () => {
  serve([], [WARN]);
  const r = rig();
  await until(r, () => r.has('yellow held for boot confirmation'), 'the hold');
  offset += 2 * MIN + 5_000; // BOOT_YELLOW_CONFIRM_MS
  await until(r, () => announces > 0 && r.has('condition transition → yellow'), 'the confirmed yellow');
  serve([]);
  await until(r, () => r.has('yellow → green held'), 'the de-escalation hold');
  offset += 4 * MIN; // past the de-escalation dwell
  await until(r, () => r.has('condition transition → green'), 'the green');
  await sleep(50);
  assert.ok(!r.has('boot yellow dropped'), 'spoken, then cleared: not a drop');
});
