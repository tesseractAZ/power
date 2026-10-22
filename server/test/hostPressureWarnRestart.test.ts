/**
 * v1.187.20 (review) — a restart during a HEARD host-pressure yellow, through the real alert monitor
 * (startAlertMonitor) and the real broadcast monitor (startBroadcastMonitor) on a real SnapshotStore,
 * wired as index.ts wires them, with Home Assistant mocked at the HTTP layer. Vitals come from
 * selfVitals.tickAssess with reader overrides, at the production cadence after a boot (the first
 * assessment 60 s after it, then every 60 s).
 *
 * The defect. The warning's episode clock and audible latch lived only in memory. After a restart
 * the same warning was held again for its full 300 s dwell, so the audible condition read green for
 * about six minutes while the pressure went on. Another warning standing at the boot that cleared
 * early let the restart recovery (broadcast.isRestartRecovery) speak "All clear" once the green had
 * stood its dwell on a settled set, and the host-pressure yellow was then spoken again at its new
 * dwell: a false all-clear for a condition that never cleared, then a duplicate of the yellow the
 * house had already heard. Deterministic when the first assessment after the boot reads a load
 * between the clear and the raise lines (ok in a fresh process: no hysteresis yet) and the pressure
 * is back at the next one — the review's case C.
 *
 * Now the monitor writes the episode beside the DB (HOST_PRESSURE_STATE_PATH) after each evaluation,
 * and the next process carries it to its first assessment.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

// The monitors' timers are unref'd; Node 22's runner would otherwise end the event loop mid-test.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

/* ── environment: set BEFORE any src module is loaded (sidecar paths are read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-hp-restart-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '4000';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.NOTIFY_QUIET_HOURS = '';
process.env.IDLE_POOL_STATE_PATH = resolve(ROOT, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = resolve(ROOT, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = resolve(ROOT, 'latch.json');
process.env.HOST_PRESSURE_STATE_PATH = resolve(ROOT, 'host-pressure-under-test.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.GRID_PRESENCE_ENTITY;
delete process.env.HOST_PRESSURE_WARN_DWELL_S;
delete process.env.HOST_PRESSURE_CRIT_DWELL_S;
process.env.BROADCAST_RED_REPLAY_STATE_PATH = resolve(ROOT, 'red-replay.json');
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.POOL_UNKNOWN_PATH = '';
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

// v1.191.0 — imported after the environment is set: the stub's import chain now reaches config.ts
// (aggregator.ts → siteTime.ts), which reads DB_PATH once when it loads.
const { makeRecorderStub } = await import('./helpers/recorderStub.js');
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { BOOT_RESET_ONSET_DEBOUNCE_MS, HOST_PRESSURE_WARN_DWELL_MS, _resetHostPressureDwellForTest } = await import('../src/alerts.js');
const { ingestLagProbe, tickAssess, _resetVitalsForTest } = await import('../src/selfVitals.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const B = await import('../src/broadcast.js');
const H = await import('../src/broadcastHealth.js');
const { notePollOk } = await import('../src/telemetryBlind.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const HP_PATH = process.env.HOST_PRESSURE_STATE_PATH!;
const SEC = 1_000;
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
  }).delay(20).persist();

const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-hp-restart-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });

/* ── the plant: one panel, one Core on it ── */
const CORE = 'COREXXX00XXX0001';
const PANEL = 'PANEXXX00XXX0001';
type Store = InstanceType<typeof SnapshotStore>;
/** Core 1 at rest. `spread` puts one pack 20 % below the others: dpu-imbalance, a WARNING that
 *  stands at the boot and clears early (the review's "another warning"). */
function core(o: { spread?: boolean } = {}): DeviceSnapshot {
  return {
    sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 80,
      packs: [1, 2, 3, 4, 5].map((num) => ({
        num, soc: o.spread && num === 5 ? 60 : 80, packSn: `PACKXXX00XXX000${num}`, inputWatts: 0, outputWatts: 0,
        temp: 30, maxCellTemp: 30, soh: 100, actSoh: 100, maxVolDiffMv: 10, minCellVoltageMv: 3300,
        maxCellVoltageMv: 3310, balanceState: 0, cellVoltagesMv: [],
      })),
      pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
      pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
      batVol: 105.6, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
      sysErrCode: 0, emsParaVolMaxMv: 107_000, emsParaVolMinMv: 104_200, chgMaxSoc: 100, dsgMinSoc: 10,
    },
  } as unknown as DeviceSnapshot;
}
function panel(): DeviceSnapshot {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 80, backupReserveSoc: 15, pairedCircuits: [], sources: [{ slot: 1, sn: CORE, isConnected: true, hwConnect: true }] },
  } as unknown as DeviceSnapshot;
}
function bootStore(o: { spread?: boolean } = {}): Store {
  const store = new SnapshotStore();
  store.setDeviceList([
    { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
    { sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
  ] as any);
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = panel();
  devices[CORE] = core({ spread: o.spread });
  store.markFirstPollSettled();
  notePollOk(Date.now());
  return store;
}
/** Telemetry keeps arriving across a clock jump (no stale-telemetry warning). */
function fresh(store: Store): void {
  for (const d of Object.values(store.get().devices)) (d as DeviceSnapshot).lastUpdated = Date.now();
  notePollOk(Date.now());
}
/** One vitals assessment now, load1 the only readable gauge (index.ts's 60 s tick). */
function assess(load1: number): void {
  const now = Date.now();
  ingestLagProbe(0, now);
  tickAssess(now, { load: () => ({ load1, load5: load1 }), memAvailableMb: () => null, dataDiskFreeMb: () => null });
}

/* ── rigs ── */
const stops: Array<() => void> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, logs: string[] = [], ms = 20_000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${logs.slice(-80).join('\n')}`);
    await sleep(5);
  }
}
let seq = 0;
function plant(store: Store) {
  const name = `m${++seq}`;
  process.env.NOTIFY_STATE_PATH = join(ROOT, `${name}-notify-state.json`);
  process.env.DIGEST_STATE_PATH = join(ROOT, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(ROOT, `${name}-cleared.json`);
  const logs: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(`[alert] ${m}`), (m) => logs.push(`[alert] ${m}`), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: async () => {},
  });
  stops.push(() => mon.stop());
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-hp-restart-cache-'));
  // Production order and wiring (index.ts): the alert monitor first, the broadcast reads its stamp.
  const bc = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    alertSetSettledSince: () => mon.alertSetSettledSince(),
  });
  stops.push(() => { bc.stop(); rmSync(cacheDir, { recursive: true, force: true }); });
  const hp = (): Alert | undefined => ((store.get().alerts ?? []) as Alert[]).find((a) => a.id.startsWith('host-pressure-'));
  return {
    mon, bc, logs, hp,
    has: (s: string) => logs.some((l) => l.includes(s)),
    count: (s: string) => logs.filter((l) => l.includes(s)).length,
    ids: () => ((store.get().alerts ?? []) as Alert[]).map((a) => a.id),
  };
}
const onFile = () => {
  try { return JSON.parse(readFileSync(HP_PATH, 'utf8')).episode; } catch { return undefined; }
};
const CONTINUATION = 'matches pre-restart advisory';
const GREEN_SPOKEN = 'condition transition → green';
const YELLOW_SPOKEN = 'condition transition → yellow';

/** Process A: past its warm-up, host pressure stands its dwell and the house HEARS the yellow; the
 *  monitor has written the audible episode to HOST_PRESSURE_STATE_PATH. Then the deploy: both
 *  monitors stop, the process's memory goes (the module holders, the vitals assessment), and the
 *  clock moves on two minutes. */
async function heardHostPressureThenRestart(): Promise<void> {
  const store = bootStore();
  const a = plant(store);
  await until(() => a.mon.stats().evalPasses >= 2, 'A: two passes', a.logs);
  await sleep(40); // the first broadcast tick joins green
  offset += 11 * MIN; // past the warm-up
  fresh(store);
  assess(4.2);
  await until(() => a.hp()?.audible === false, 'A: the warning on the card, held', a.logs);
  assert.equal(a.count(YELLOW_SPOKEN), 0, 'A: held inside the dwell');
  offset += HOST_PRESSURE_WARN_DWELL_MS + SEC;
  fresh(store);
  assess(4.2);
  await until(() => a.has('broadcast: yellow → ok in'), 'A: the host-pressure yellow played', a.logs);
  await until(() => a.bc.status().conditionSpoken === true && a.bc.status().conditionLevel === 'yellow', 'A: heard', a.logs);
  await until(() => onFile()?.latched === true, 'A: the audible episode written where the next process reads it', a.logs);
  for (const s of stops.splice(0)) s();
  await sleep(50);
  // ── the deploy ──
  _resetHostPressureDwellForTest();
  _resetVitalsForTest();
  offset += 2 * MIN;
  announces = 0;
}

beforeEach(() => {
  for (const s of stops.splice(0)) s();
  rmSync(STATUS_PATH, { force: true });
  rmSync(HP_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  rmSync(process.env.ALERT_ONSET_PATH!, { force: true });
  _resetHostPressureDwellForTest();
  _resetVitalsForTest();
  announces = 0;
  H.resetBroadcastHealth();
});
after(async () => {
  for (const s of stops.splice(0)) s();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

test('★★★ review replay: a restart during a heard host-pressure yellow speaks no "All clear" and no second yellow', { timeout: 60_000 }, async () => {
  await heardHostPressureThenRestart();
  // Process B: another warning stands at the boot (the review's X), and clears early.
  const store = bootStore({ spread: true });
  const b = plant(store);
  await until(() => b.has('host pressure: an episode of before the restart is carried'), 'B: the episode carried at start-up', b.logs);
  await until(() => b.has(CONTINUATION), 'B: the standing yellow adopted as a continuation', b.logs);
  (store.get().devices as Record<string, DeviceSnapshot>)[CORE] = core(); // X clears
  await until(() => b.has('yellow → green held'), 'B: the dwell on the green', b.logs);
  // +60 s: the first assessment. A fresh process has no hysteresis: 3.4 (under the 3.5 raise line,
  // over the 3.0 clear line the old process held the warning to) reads ok.
  offset += 60 * SEC;
  fresh(store);
  assess(3.4);
  await sleep(300);
  assert.equal(b.hp(), undefined, 'B: the first assessment reads ok');
  // +120 s: the pressure is back at the next assessment.
  offset += 60 * SEC;
  fresh(store);
  assess(4.2);
  await until(() => b.hp() != null, 'B: the warning back on the card', b.logs);
  assert.notEqual(b.hp()?.audible, false, '★ audible at once: the yellow the house heard before the restart');
  // +181 s: the boot debounces have run — the set settles.
  offset += BOOT_RESET_ONSET_DEBOUNCE_MS - 120 * SEC + SEC;
  fresh(store);
  assess(4.2);
  await until(() => b.mon.alertSetSettledSince() != null, 'B: the settled stamp', b.logs);
  // +362 s: where the green would have stood its dwell on the settled set (the old code's
  // "All clear"), and +430 s / +560 s, where the re-held warning reached its new dwell and its boot
  // confirmation (the old code's second yellow).
  offset += DWELL + SEC;
  fresh(store);
  assess(4.2);
  await sleep(400);
  offset += 70 * SEC;
  fresh(store);
  assess(4.2);
  await sleep(400);
  offset += 130 * SEC;
  fresh(store);
  assess(4.2);
  await sleep(400);
  assert.equal(b.count(GREEN_SPOKEN), 0, `★ no "All clear": the pressure never cleared\n${b.logs.join('\n')}`);
  assert.equal(b.count(YELLOW_SPOKEN), 0, '★ no second yellow: the house heard it before the restart');
  assert.equal(announces, 0, '★ nothing was played after the restart');
  assert.equal(b.bc.status().conditionLevel, 'yellow');
  assert.equal(onFile()?.latched, true, 'the episode goes on, audible, on file');
});

test('★★ the wiring: the carried episode keeps the alert set unsettled until an assessment resumes it, then the warning is audible at once', { timeout: 60_000 }, async () => {
  await heardHostPressureThenRestart();
  const store = bootStore();
  const b = plant(store);
  await until(() => b.has('host pressure: an episode of before the restart is carried'), 'B: the episode carried at start-up', b.logs);
  assert.ok(b.logs.some((l) => /^\[alert\] host pressure: an episode of before the restart is carried \(onset \d+ s ago, audible, last held \d+ s ago\)/.test(l)), b.logs.join('\n'));
  // No assessment past the boot debounces (a stalled vitals tick): every other condition for a
  // settled set holds, but the carried episode is pending.
  offset += BOOT_RESET_ONSET_DEBOUNCE_MS + SEC;
  fresh(store);
  const at = b.mon.stats().evalPasses;
  await until(() => b.mon.stats().evalPasses >= at + 3, 'B: three passes past the boot debounces', b.logs);
  assert.equal(b.hp(), undefined, 'no assessment, no host-pressure alert');
  assert.equal(b.mon.alertSetSettledSince(), null, '★ not settled while the carried episode waits for its assessment');
  assert.deepEqual(onFile()?.latched, true, 'the carry is kept on file meanwhile');
  assess(4.2);
  await until(() => b.hp() != null, 'B: the first assessment', b.logs);
  assert.notEqual(b.hp()?.audible, false, '★ resumed audible');
  await until(() => b.mon.alertSetSettledSince() != null, 'B: settled once resumed', b.logs);
  await sleep(100);
  assert.equal(b.count(YELLOW_SPOKEN), 0, 'a continuation of the heard yellow, not a new one');
  assert.equal(announces, 0);
});
