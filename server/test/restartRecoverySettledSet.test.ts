/**
 * v1.187.3 (review) — the post-restart recovery's SETTLED alert set, through the real alert monitor
 * (startAlertMonitor) and the real broadcast monitor (startBroadcastMonitor) on one real
 * SnapshotStore, wired as index.ts wires them, with Home Assistant mocked at the HTTP layer.
 *
 * The recovery (broadcast.isRestartRecovery) speaks an all-clear for a green under a level the house
 * heard before the restart. The first cut checked "settled" (the store hydrated, every feed warm)
 * only at the moment the green committed, and that check had two holes:
 *   • the dpu-err / shp2-src-err criticals (and the MPPT-error warnings) are withheld until their
 *     onset has stood 3 minutes, and the onset clock lives in this process's memory: after a
 *     restart a standing critical is absent for one window — as long as the green's dwell. A green
 *     that began on that set and stood its dwell was spoken seconds before the critical
 *     re-published: "All clear", then the klaxon;
 *   • a feed's warm() turns true when its fetch lands, but its alerts reach the published set only
 *     at that pass's publish, which can wait on another feed's budget.
 * The alert monitor now stamps the set it publishes (alertMonitor.alertSetTrusted →
 * AlertMonitor.alertSetSettledSince) and the green must stand its dwell on it.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitors' timers are unref'd; Node 22's runner would otherwise end the event loop mid-test.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

/* ── environment: set BEFORE any src module is loaded (sidecar paths are read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-settled-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '4000'; // a held feed keeps its pass waiting well past the assertions made meanwhile
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.NOTIFY_QUIET_HOURS = '';
process.env.IDLE_POOL_STATE_PATH = resolve(ROOT, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = resolve(ROOT, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = resolve(ROOT, 'latch.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.GRID_PRESENCE_ENTITY;
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

const { startAlertMonitor, alertSetTrusted, createLastGoodFeed } = await import('../src/alertMonitor.js');
const { debouncedOnsetsPending, BOOT_RESET_ONSET_DEBOUNCE_MS } = await import('../src/alerts.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const B = await import('../src/broadcast.js');
const H = await import('../src/broadcastHealth.js');
const { notePollOk } = await import('../src/telemetryBlind.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
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

const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-settled-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });

/* ── the plant: one panel, one Core on it ── */
const CORE = 'COREXXX00XXX0001';
const PANEL = 'PANEXXX00XXX0001';
type Store = InstanceType<typeof SnapshotStore>;

/** Core 1 at rest inside its EMS band. `spread` puts one pack 20 % below the others (dpu-imbalance,
 *  a warning: the boot transient); `sysErrCode` is the inverter/BMS error the store debounces. */
function core(o: { sysErrCode?: number; spread?: boolean } = {}): DeviceSnapshot {
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
      sysErrCode: o.sysErrCode ?? 0, emsParaVolMaxMv: 107_000, emsParaVolMinMv: 104_200, chgMaxSoc: 100, dsgMinSoc: 10,
    },
  } as unknown as DeviceSnapshot;
}
function panel(): DeviceSnapshot {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 80, backupReserveSoc: 15, pairedCircuits: [], sources: [{ slot: 1, sn: CORE, isConnected: true, hwConnect: true }] },
  } as unknown as DeviceSnapshot;
}
/** A booted store. `errAtBoot`: the Core reports an inverter error from its first quota, so the
 *  store's onset clock for it starts NOW (it restarts in every process). */
function bootStore(o: { errAtBoot?: number; spread?: boolean } = {}): Store {
  const store = new SnapshotStore();
  store.setDeviceList([
    { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
    { sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
  ] as any);
  if (o.errAtBoot) store.setDeviceQuota(CORE, { 'hs_yj751_pd_appshow_addr.sysErrCode': o.errAtBoot });
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = panel();
  devices[CORE] = core({ sysErrCode: o.errAtBoot, spread: o.spread });
  store.markFirstPollSettled();
  notePollOk(Date.now()); // the poll loop's health (telemetry-blind)
  return store;
}
/** Telemetry keeps arriving across a clock jump (no stale-telemetry warning). */
function fresh(store: Store): void {
  for (const d of Object.values(store.get().devices)) (d as DeviceSnapshot).lastUpdated = Date.now();
  notePollOk(Date.now());
}

/* ── the alert monitor's worker/NWS feeds, each holdable ── */
interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let r!: (v: T) => void;
  const promise = new Promise<T>((res) => { r = res; });
  return { promise, resolve: r };
}
const held = new Map<string, Deferred<any>>();
const calls = new Map<string, number>();
const values = new Map<string, any>();
function feed(name: string): Promise<any> {
  calls.set(name, (calls.get(name) ?? 0) + 1);
  const h = held.get(name);
  if (h) return h.promise;
  return Promise.resolve(values.get(name) ?? (name === 'forecast' ? null : []));
}
function hold(name: string): Deferred<any> {
  const d = deferred<any>();
  held.set(name, d);
  return d;
}
function release(name: string, value: any): void {
  const d = held.get(name);
  held.delete(name);
  d?.resolve(value);
}

/* ── rigs ── */
const stops: Array<() => void> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, logs: string[] = [], ms = 20_000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${logs.slice(-60).join('\n')}`);
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
    analytics: { report: (n: string) => feed(n) } as any,
    stormPrep: () => feed('storm-prep'),
    captureLrFeatures: (async () => null) as any,
    send: async () => {},
  });
  stops.push(() => mon.stop());
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-settled-cache-'));
  // Production order and wiring (index.ts): the alert monitor first, the broadcast reads its stamp.
  const bc = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
    alertSetSettledSince: () => mon.alertSetSettledSince(),
  });
  stops.push(() => { bc.stop(); rmSync(cacheDir, { recursive: true, force: true }); });
  return {
    mon, bc, logs,
    has: (s: string) => logs.some((l) => l.includes(s)),
    count: (s: string) => logs.filter((l) => l.includes(s)).length,
    ids: () => ((store.get().alerts ?? []) as Alert[]).map((a) => a.id),
  };
}
const CONTINUATION = 'matches pre-restart advisory';
const RECOVERY = 'a recovery, not a continuation of the pre-restart';
const HELD_FOR_RECOVERY = 'but is held, not adopted';
const GREEN_SPOKEN = 'condition transition → green';

/** A broadcast monitor that has run past its warm-up and spoken `alerts` (the restart baseline). */
async function heard(alerts: Alert[], level: 'yellow' | 'red'): Promise<void> {
  let shown: Alert[] = [];
  const fake = { get: () => ({ alerts: shown }) } as any;
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-settled-cache-'));
  const a = B.startBroadcastMonitor(fake, (m) => logs.push(m), { klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10 });
  await sleep(60); // the first tick joins green
  offset += 11 * MIN; // past the warm-up
  shown = alerts;
  await until(() => a.status().conditionSpoken === true && a.status().conditionLevel === level, `a heard ${level}`, logs);
  a.stop();
  rmSync(cacheDir, { recursive: true, force: true });
  offset += 2 * MIN; // the deploy
}
const HEARD_CRIT: Alert = { id: `dpu-err-${CORE}`, severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter error code', detail: 'x' } as Alert;
const HEARD_WARN: Alert = { id: `dpu-imbalance-${CORE}`, severity: 'warning', category: 'Battery', device: 'Core 1', title: 'Packs out of balance', detail: 'x' } as Alert;

beforeEach(() => {
  for (const s of stops.splice(0)) s();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  rmSync(process.env.ALERT_ONSET_PATH!, { force: true });
  for (const n of [...held.keys()]) release(n, n === 'forecast' ? null : []);
  calls.clear();
  values.clear();
  announces = 0;
  H.resetBroadcastHealth();
});
after(async () => {
  for (const s of stops.splice(0)) s();
  for (const n of [...held.keys()]) release(n, []);
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

/* ══ through both real monitors ══════════════════════════════════════════════════════════ */

test('★★★ the recovery through both monitors: settled after the boot debounces, the green stands its dwell on it, and is spoken once', { timeout: 60_000 }, async () => {
  await heard([HEARD_WARN], 'yellow');
  const store = bootStore({ spread: true }); // the heard warning still stands at the boot
  const p = plant(store);
  await until(() => p.has(CONTINUATION), 'the standing yellow adopted as a continuation', p.logs);
  await until(() => p.mon.stats().evalPasses >= 2, 'two passes', p.logs);
  assert.equal(p.mon.alertSetSettledSince(), null, '★ not settled inside the boot debounce window, though every feed is warm and nothing is pending');
  (store.get().devices as Record<string, DeviceSnapshot>)[CORE] = core(); // the packs rebalance
  await until(() => p.has('yellow → green held'), 'the dwell', p.logs);
  offset += BOOT_RESET_ONSET_DEBOUNCE_MS + SEC; // the boot debounces have run
  fresh(store);
  await until(() => p.mon.alertSetSettledSince() != null, 'the settled stamp', p.logs);
  assert.ok(p.has('alert-monitor: the alert set is settled'), 'said once, at the first settled set');
  await sleep(60);
  assert.equal(p.count(GREEN_SPOKEN), 0, 'the green began before the set settled: its dwell runs from the stamp');
  assert.ok(p.has(HELD_FOR_RECOVERY), 'held past its own dwell for its recovery');
  const stampedAt = p.mon.alertSetSettledSince()!;
  const at = p.mon.stats().evalPasses;
  await until(() => p.mon.stats().evalPasses >= at + 3, 'three more settled passes', p.logs);
  assert.equal(p.mon.alertSetSettledSince(), stampedAt, '★ the stamp marks the START of the settled run: a later settled pass keeps it');
  offset += DWELL + SEC;
  fresh(store);
  await until(() => p.count(GREEN_SPOKEN) === 1, 'the all-clear', p.logs);
  assert.ok(p.has(`${RECOVERY} yellow`));
  assert.equal(p.mon.alertSetSettledSince(), stampedAt, 'the stamp is kept while every set is settled');
  await sleep(80);
  assert.equal(p.count(GREEN_SPOKEN), 1, 'once');
});

test('★★★ review replay: a critical withheld by its restarted debounce re-publishes after the green has stood its dwell — no "All clear" before it', { timeout: 60_000 }, async () => {
  await heard([HEARD_CRIT], 'red');
  assert.equal(announces, 1);
  const store = bootStore({ errAtBoot: 7, spread: true }); // dpu-err standing; its onset clock restarts now
  const p = plant(store);
  await until(() => p.has(CONTINUATION), 'the boot-transient yellow adopted below the heard red', p.logs);
  assert.ok(!p.ids().includes(`dpu-err-${CORE}`), 'the critical is withheld by its debounce');
  (store.get().devices as Record<string, DeviceSnapshot>)[CORE] = core({ sysErrCode: 7 }); // the transient clears
  await until(() => p.has('yellow → green held'), 'the dwell', p.logs);
  // A pass is in flight on a slow feed (the evaluating latch skips the passes behind it): its first
  // publish was computed before the jump, with the critical withheld.
  const passes = p.mon.stats().evalPasses;
  hold('baselineAlerts');
  const asked = calls.get('baselineAlerts') ?? 0;
  await until(() => (calls.get('baselineAlerts') ?? 0) > asked, 'a pass waiting on the held feed', p.logs);
  offset += DWELL + 5 * SEC; // the green has stood its dwell, and the critical's window has run
  fresh(store);
  await sleep(300);
  assert.equal(p.mon.stats().evalPasses, passes, 'the critical has not been re-published yet (the pass is still waiting)');
  assert.equal(p.count(GREEN_SPOKEN), 0, '★ no all-clear on a set with a withheld critical');
  assert.ok(p.has(HELD_FOR_RECOVERY));
  release('baselineAlerts', []);
  await until(() => p.ids().includes(`dpu-err-${CORE}`), 'the critical re-published', p.logs);
  await until(() => p.bc.status().conditionLevel === 'red', 'the red committed', p.logs);
  assert.equal(p.count(GREEN_SPOKEN), 0, 'no all-clear before (or after) it');
});

test('★★★ a feed that lands after the green began: its warning reaches the set before any all-clear', { timeout: 60_000 }, async () => {
  await heard([HEARD_WARN], 'yellow');
  hold('curtailmentAlerts'); // a worker feed that has not delivered since boot
  const store = bootStore({ spread: true });
  const p = plant(store);
  await until(() => p.has(CONTINUATION), 'the continuation', p.logs);
  (store.get().devices as Record<string, DeviceSnapshot>)[CORE] = core();
  await until(() => p.has('yellow → green held'), 'the dwell', p.logs);
  offset += BOOT_RESET_ONSET_DEBOUNCE_MS + DWELL + SEC;
  fresh(store);
  await until(() => p.has(HELD_FOR_RECOVERY), 'held: a feed is cold', p.logs);
  assert.equal(p.mon.alertSetSettledSince(), null);
  // The cold feed lands while the same pass still waits on another feed's budget: warm() turns
  // true at once, its alerts join the set only at that pass's publish.
  hold('baselineAlerts');
  const asked = calls.get('baselineAlerts') ?? 0;
  await until(() => (calls.get('baselineAlerts') ?? 0) > asked, 'a pass waiting on both feeds', p.logs);
  const WARN_FEED: Alert = { id: 'soc-curtailment-pool', severity: 'warning', category: 'Solar', device: 'Fleet', title: 'Solar curtailed at full charge', detail: 'x' } as Alert;
  release('curtailmentAlerts', [WARN_FEED]);
  await until(() => p.mon.stats().alertFeeds.every((f) => f.warm), 'every feed warm', p.logs);
  await sleep(300);
  assert.ok(!p.ids().includes(WARN_FEED.id), 'its warning is not in the set yet');
  assert.equal(p.mon.alertSetSettledSince(), null, '★ warm is not settled: the set does not carry the feed yet');
  assert.equal(p.count(GREEN_SPOKEN), 0, '★ no all-clear');
  release('baselineAlerts', []);
  await until(() => p.ids().includes(WARN_FEED.id), 'the warning in the set', p.logs);
  await sleep(100);
  assert.equal(p.count(GREEN_SPOKEN), 0);
  assert.ok(!p.has(RECOVERY));
});

test('★★★ a fault that starts while the green stands on a settled set clears the stamp before its first publish', { timeout: 60_000 }, async () => {
  await heard([HEARD_WARN], 'yellow');
  const store = bootStore({ spread: true });
  const p = plant(store);
  await until(() => p.has(CONTINUATION), 'the continuation', p.logs);
  offset += BOOT_RESET_ONSET_DEBOUNCE_MS + SEC;
  fresh(store);
  await until(() => p.mon.alertSetSettledSince() != null, 'settled', p.logs);
  (store.get().devices as Record<string, DeviceSnapshot>)[CORE] = core();
  await until(() => p.has('yellow → green held'), 'the dwell', p.logs);
  // 20 s before the green has stood its dwell, the Core reports an inverter error. The pass that
  // first sees it waits on a slow feed; its first publish (the error withheld) is already out.
  offset += DWELL - 20 * SEC;
  fresh(store);
  await sleep(150);
  assert.equal(p.count(GREEN_SPOKEN), 0);
  hold('baselineAlerts');
  store.setDeviceQuota(CORE, { 'hs_yj751_pd_appshow_addr.sysErrCode': 9 });
  (store.get().devices as Record<string, DeviceSnapshot>)[CORE] = core({ sysErrCode: 9 });
  const asked = calls.get('baselineAlerts') ?? 0;
  await until(() => (calls.get('baselineAlerts') ?? 0) > asked, 'the pass that sees the error', p.logs);
  assert.equal(p.mon.alertSetSettledSince(), null, '★ cleared before that pass published');
  offset += 25 * SEC; // the green has now stood its dwell
  fresh(store);
  await sleep(300);
  assert.equal(p.count(GREEN_SPOKEN), 0, '★ no all-clear while the error stands its debounce');
  release('baselineAlerts', []);
  offset += 3 * MIN;
  fresh(store);
  await until(() => p.bc.status().conditionLevel === 'red', 'the error raised and committed', p.logs);
  assert.equal(p.count(GREEN_SPOKEN), 0);
});

/* ══ the alert monitor's stamp ═══════════════════════════════════════════════════════════ */

test('★★★ the stamp waits out a backup pool that reads unknown (reserve-alarm-blind is withheld 15 min), then settles once it reads', { timeout: 60_000 }, async () => {
  const store = bootStore();
  store.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 }); // the pool unreadable: its onset clock starts
  const unknownSince = store.backupPoolUnknownSince(PANEL);
  assert.ok(unknownSince != null, 'the store records the pool-unknown onset');
  (store.get().devices as Record<string, DeviceSnapshot>)[PANEL] = { ...panel(), projection: { ...(panel().projection as any), backupBatPercent: null } } as DeviceSnapshot;
  const p = plant(store);
  await until(() => p.mon.stats().evalPasses >= 2, 'two passes', p.logs);
  offset += BOOT_RESET_ONSET_DEBOUNCE_MS + SEC;
  fresh(store);
  const at = p.mon.stats().evalPasses;
  await until(() => p.mon.stats().evalPasses >= at + 3, 'three passes past the boot debounces', p.logs);
  assert.equal(p.mon.alertSetSettledSince(), null, '★ a pool unknown for under 15 min withholds reserve-alarm-blind');
  assert.ok(!p.ids().some((id) => id.startsWith('reserve-alarm-blind')), 'withheld indeed');
  store.setDeviceQuota(PANEL, { 'backupIncreInfo.backupBatPer': 80, 'backupIncreInfo.backupFullCap': 61_440, 'backupIncreInfo.backupDischargeRmainBatCap': 49_152 });
  (store.get().devices as Record<string, DeviceSnapshot>)[PANEL] = panel();
  assert.equal(store.backupPoolUnknownSince(PANEL), null, 'the pool reads again');
  await until(() => p.mon.alertSetSettledSince() != null, 'settled once nothing is withheld', p.logs);
});

test('★★★ v1.187.4: a pool unknown across the restart carries its onset — reserve-alarm-blind is in the first sets, critical off-grid, and nothing is withheld (the set settles)', { timeout: 60_000 }, async () => {
  const path = join(ROOT, 'pool-unknown-carried.json');
  process.env.POOL_UNKNOWN_PATH = path;
  try {
    const before = bootStore();
    before.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 }); // unreadable from now
    const since = before.backupPoolUnknownSince(PANEL);
    assert.ok(since != null);
    for (let i = 0; i < 7; i++) { offset += 10 * MIN; before.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 }); }
    offset += 2 * MIN; // the deploy, 72 min into the blind episode

    const store = bootStore();
    store.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 }); // still unreadable
    assert.equal(store.backupPoolUnknownSince(PANEL), since, 'carried across the restart');
    (store.get().devices as Record<string, DeviceSnapshot>)[PANEL] = { ...panel(), projection: { ...(panel().projection as any), backupBatPercent: null } } as DeviceSnapshot;
    const p = plant(store);
    await until(() => p.ids().includes('reserve-alarm-blind'), 'the alert in the first sets', p.logs);
    const a = ((store.get().alerts ?? []) as Alert[]).find((x) => x.id === 'reserve-alarm-blind');
    assert.equal(a?.severity, 'critical', '★ critical, not a warning until boot + 60');
    offset += BOOT_RESET_ONSET_DEBOUNCE_MS + SEC;
    fresh(store);
    await until(() => p.mon.alertSetSettledSince() != null, '★ settled: no onset clock withholds a fault', p.logs);
  } finally {
    delete process.env.POOL_UNKNOWN_PATH;
  }
});

test('★★ v1.187.4 (review): a listed panel not projected yet with an onset on file keeps the set unsettled until its first projection — then the carried critical is in the set', { timeout: 60_000 }, async () => {
  const path = join(ROOT, 'pool-unknown-pending.json');
  process.env.POOL_UNKNOWN_PATH = path;
  try {
    const before = bootStore();
    before.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 });
    const since = before.backupPoolUnknownSince(PANEL);
    for (let i = 0; i < 7; i++) { offset += 10 * MIN; before.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 }); }
    offset += 2 * MIN; // the deploy

    const store = bootStore(); // the panel listed, its file entry not consumed (no projection through the store yet)
    assert.deepEqual(store.poolUnknownCarryPending(), [PANEL]);
    const p = plant(store);
    await until(() => p.mon.stats().evalPasses >= 2, 'two passes', p.logs);
    offset += BOOT_RESET_ONSET_DEBOUNCE_MS + SEC;
    fresh(store);
    const at = p.mon.stats().evalPasses;
    await until(() => p.mon.stats().evalPasses >= at + 3, 'three passes past the boot debounces', p.logs);
    assert.equal(p.mon.alertSetSettledSince(), null, '★ not settled: the panel\'s first projection may raise the carried alarm');
    store.setDeviceQuota(PANEL, { 'backupIncreInfo.backupFullCap': 61_440 }); // its first projection: still unreadable
    assert.equal(store.backupPoolUnknownSince(PANEL), since, 'carried');
    (store.get().devices as Record<string, DeviceSnapshot>)[PANEL] = { ...panel(), projection: { ...(panel().projection as any), backupBatPercent: null } } as DeviceSnapshot;
    fresh(store);
    await until(() => p.ids().includes('reserve-alarm-blind'), 'the carried alarm in the set', p.logs);
    assert.equal(((store.get().alerts ?? []) as Alert[]).find((x) => x.id === 'reserve-alarm-blind')?.severity, 'critical');
    await until(() => p.mon.alertSetSettledSince() != null, 'settled once nothing is withheld', p.logs);
  } finally {
    delete process.env.POOL_UNKNOWN_PATH;
  }
});

/* ══ the pure parts ══════════════════════════════════════════════════════════════════════ */

test('alertSetTrusted — hydrated, every feed in the set, the boot debounces run, nothing pending (each alone is not enough)', () => {
  const first = 1_000_000;
  const ok = { firstPollSettledAt: first, feedsInSet: [true, true, true, true, true], liveAtMs: first + BOOT_RESET_ONSET_DEBOUNCE_MS, pendingOnsets: [] as string[] };
  assert.equal(alertSetTrusted(ok), true, 'all warm, the window run (inclusive), nothing pending');
  assert.equal(alertSetTrusted({ ...ok, firstPollSettledAt: 0 }), false, 'the store has not hydrated');
  assert.equal(alertSetTrusted({ ...ok, feedsInSet: [true, true, false, true, true] }), false, 'one feed not in the set');
  assert.equal(alertSetTrusted({ ...ok, feedsInSet: [] }), false, '★ no feeds is a wiring fault, never settled');
  assert.equal(alertSetTrusted({ ...ok, liveAtMs: ok.liveAtMs - 1 }), false, 'the boot debounces have 1 ms to run');
  assert.equal(alertSetTrusted({ ...ok, pendingOnsets: [`dpu-err ${CORE}`] }), false, 'an onset clock withholds a fault');
  assert.equal(alertSetTrusted({ ...ok, liveAtMs: first + 10, bootDebounceMs: 10 }), true, 'the window is a parameter');
  assert.equal(BOOT_RESET_ONSET_DEBOUNCE_MS, 3 * MIN, 'the dpu-err / shp2-src-err / MPPT window');
});

test('debouncedOnsetsPending — each in-memory onset clock, listed while inside its window (the rules\' own comparison)', () => {
  const now = 50_000_000;
  const none = debouncedOnsetsPending({}, now);
  assert.deepEqual(none, []);
  assert.deepEqual(debouncedOnsetsPending(undefined, now), []);
  const at = (ms: number) => ({ code: 7, count: 1, sinceMs: now - ms });
  assert.deepEqual(debouncedOnsetsPending({ dpuErrOnsetBySn: new Map([[CORE, at(3 * MIN - 1)]]) }, now), [`dpu-err ${CORE}`]);
  assert.deepEqual(debouncedOnsetsPending({ dpuErrOnsetBySn: new Map([[CORE, at(3 * MIN)]]) }, now), [], 'stood its window: published, not withheld');
  assert.deepEqual(debouncedOnsetsPending({ shp2SrcErrOnsetBySlot: new Map([[`${PANEL}:3`, at(3 * MIN - 1)]]) }, now), [`shp2-src-err ${PANEL}:3`]);
  assert.deepEqual(debouncedOnsetsPending({ shp2SrcErrOnsetBySlot: new Map([[`${PANEL}:3`, at(3 * MIN)]]) }, now), []);
  assert.deepEqual(debouncedOnsetsPending({ mpptErrOnsetByKey: new Map([[`${CORE}:hv`, at(3 * MIN - 1)]]) }, now), [`mppt-err ${CORE}:hv`]);
  assert.deepEqual(debouncedOnsetsPending({ mpptErrOnsetByKey: new Map([[`${CORE}:hv`, at(3 * MIN)]]) }, now), []);
  assert.deepEqual(debouncedOnsetsPending({ backupPoolUnknownSinceBySn: new Map([[PANEL, now - 15 * MIN + 1]]) }, now), [`reserve-alarm-blind ${PANEL}`]);
  assert.deepEqual(debouncedOnsetsPending({ backupPoolUnknownSinceBySn: new Map([[PANEL, now - 15 * MIN]]) }, now), [], 'reserve-alarm-blind is raised at 15 min');
  assert.deepEqual(debouncedOnsetsPending({ backupPoolUnknownSinceBySn: new Map([[PANEL, null]]) }, now), [], 'a readable pool');
  assert.deepEqual(debouncedOnsetsPending({ backupPoolUnknownSinceMs: now - MIN }, now), ['reserve-alarm-blind house panel'], 'a caller with only the house panel\'s onset');
  assert.deepEqual(debouncedOnsetsPending({ dpuErrOnsetBySn: new Map([[CORE, { code: 7, sinceMs: Number.NaN }]]) }, now), [], 'a corrupt onset is not a clock');
});

test('AlertFeedRead.warm — read with the value: a fetch that lands after its read returned is not in that read', async () => {
  const f = createLastGoodFeed<string[]>('t');
  const d = deferred<string[]>();
  const r1 = await f.read(() => d.promise, 20);
  assert.equal(r1.value, null);
  assert.equal(r1.warm, false, 'cut at the budget: nothing delivered');
  d.resolve(['x']);
  await sleep(5);
  assert.equal(f.warm(), true, 'the feed is warm the moment the fetch lands…');
  assert.equal(r1.warm, false, '…but the read that was cut before it is not');
  const r2 = await f.read(() => Promise.resolve(['y']), 20);
  assert.equal(r2.warm, true);
  const r3 = await f.read(() => new Promise<string[]>(() => {}), 20);
  assert.equal(r3.warm, true, 'a carried value stays a delivery');
  assert.deepEqual(r3.value, ['y']);
});
