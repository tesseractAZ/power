/**
 * v1.186.0 — boot sequencing. The alert monitor publishes its live alarms before any wait on
 * the analytics worker, so its FIRST evaluation ran ~0.4-0.6 s before the first poll settled:
 * boot seeding (firstRun), the boot re-track and the first publish all stood on a device map
 * with no projections, or no device list at all. And the broadcast's first tick silently joined
 * whatever non-green level that publish held, so a condition standing at boot — never heard
 * before the restart — was never spoken, and not pushed either (tick-1 alerts are seeded).
 *
 *  (a) the first evaluation waits for a HYDRATED store (SnapshotStore.firstPollSettledAt),
 *      bounded so a cloud outage at boot never holds the alarms back;
 *  (b) the broadcast's first tick routes a non-green level through the boot gates;
 *  (d) the onset prune and the orphan-sweep hold are scoped to the ids a cold feed owns;
 *  (e) the alarm-count readiness waits for a complete set (publishReadiness.test.ts).
 *
 * The combined tests run the real startAlertMonitor and the real startBroadcastMonitor on one
 * real SnapshotStore, in production order, with Home Assistant mocked at the HTTP layer.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Alert } from '../src/alerts.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

/* ── environment: set BEFORE any src module is loaded (sidecar paths are read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-bootseq-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '300';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
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

const { startAlertMonitor, alertFeedOwning, ALERT_FEED_ID_PREFIXES } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { restampAlertOnset, getAlertOnset } = await import('../src/alertOnset.js');
const B = await import('../src/broadcast.js');
const H = await import('../src/broadcastHealth.js');
const { generateAudioAssets } = await import('../src/audioAssets.js');
const { pcmToWav } = await import('../src/wyomingTts.js');

const STATUS_PATH = resolve(ROOT, 'broadcast-last.json');
const HOUR = 3_600_000;
const SRC = (f: string) => readFileSync(resolve(import.meta.dirname, '../src', f), 'utf8');

/* ── clock: real time flows, `offset` jumps it (the boot yellow hold) ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer ── */
let announces: Array<{ entity_id: string[] }> = [];
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
  .reply((opts) => {
    announces.push(JSON.parse(String(opts.body)));
    offset += 30_000; // play_announcement returns when playback ENDS (a verified delivery)
    return { statusCode: 200, data: '[]' };
  }).delay(20).persist();

const KLAXON = mkdtempSync(resolve(tmpdir(), 'ef-bootseq-klaxon-'));
await generateAudioAssets(KLAXON, () => {});
const renderTts = async () => ({ ok: true as const, wav: pcmToWav(Buffer.alloc(2 * 1100), 22050, 2, 1), durationMs: 1 });

/* ── rigs ── */
type Store = InstanceType<typeof SnapshotStore>;
const stops: Array<() => void> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, logs: string[] = [], ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${logs.join('\n')}`);
    await sleep(5);
  }
}

let seq = 0;
const never = <T>() => new Promise<T>(() => {});
function alertRig(store: Store, opts: {
  bootHydrationMaxMs?: number;
  report?: (n: string) => Promise<any>;
  notifyState?: Record<string, unknown>;
} = {}) {
  const name = `m${++seq}`;
  process.env.NOTIFY_STATE_PATH = join(ROOT, `${name}-notify-state.json`);
  if (opts.notifyState) writeFileSync(process.env.NOTIFY_STATE_PATH, JSON.stringify(opts.notifyState));
  process.env.DIGEST_STATE_PATH = join(ROOT, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(ROOT, `${name}-cleared.json`);
  const logs: string[] = [];
  const pushes: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: opts.report ?? (async (n: string) => (n === 'forecast' ? null : [])) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: async (_cfg: unknown, msg: { title: string }) => { pushes.push(msg.title); },
    ...(opts.bootHydrationMaxMs != null ? { bootHydrationMaxMs: opts.bootHydrationMaxMs } : {}),
  });
  stops.push(() => mon.stop());
  return { mon, logs, pushes, has: (s: string) => logs.some((l) => l.includes(s)) };
}
function broadcastRig(store: Store) {
  const logs: string[] = [];
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-bootseq-cache-'));
  const mon = B.startBroadcastMonitor(store, (m) => logs.push(m), {
    klaxonDir: KLAXON, cacheDir, cacheUrlPath: '/audio-render', renderTts, tickMs: 10,
  });
  stops.push(() => { mon.stop(); rmSync(cacheDir, { recursive: true, force: true }); });
  return { mon, logs, has: (s: string) => logs.some((l) => l.includes(s)) };
}

const core = (sn: string, name: string, online: 0 | 1) => ({ sn, deviceName: name, productName: 'DELTA Pro Ultra', online }) as any;

beforeEach(() => {
  for (const s of stops.splice(0)) s();
  rmSync(STATUS_PATH, { force: true });
  rmSync(process.env.BROADCAST_RED_REPLAY_STATE_PATH!, { force: true });
  announces = [];
  offset = 0;
  H.resetBroadcastHealth();
});
after(async () => {
  for (const s of stops.splice(0)) s();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(KLAXON, { recursive: true, force: true });
});

/* ══ (a) the boot gate ═══════════════════════════════════════════════════════════════════ */

test('★★★ nothing is published or seeded before the first poll settles; tick 1 then re-tracks a standing alarm', async () => {
  const sn = 'COREXXX00XXX0012';
  const id = `offline-${sn}`;
  restampAlertOnset(id, Date.now() - 3 * HOUR); // the Core went dark before the restart
  const store = new SnapshotStore();
  store.markDeviceListAttempt(); // the first /device/list is in flight
  const a = alertRig(store, { bootHydrationMaxMs: 60_000 });
  await sleep(350); // three eval intervals
  assert.equal(store.get().alerts, undefined, '★ no pre-hydration set is published (no phantom "cloud session stale")');
  assert.equal(a.mon.stats().evalPasses, 0, '★ no firstRun pass on an unhydrated store');
  assert.equal(getAlertOnset(id) != null, true, 'the pre-restart onset is untouched');

  store.setDeviceList([core(sn, 'Core 2', 0)]);
  store.markFirstPollSettled(); // refreshAll: every listed-online device asked
  await until(() => a.mon.stats().evalPasses >= 1, 'the first pass', a.logs);
  const ids = (store.get().alerts ?? []).map((x) => x.id);
  assert.ok(ids.includes(id), `the standing alarm is in the first set: ${ids.join(', ')}`);
  assert.ok(!ids.includes('cloud-session-stale'), 'the list landed before tick 1');
  assert.ok(a.has('first evaluation on a hydrated store'));
  assert.ok(a.has(`"${id}" re-tracked across a restart`), '★ tick 1 re-tracks it: not a rise');
  await until(() => a.mon.stats().evalPasses >= 3, 'two more passes', a.logs);
  assert.equal(a.mon.telemetry().some((t) => t.familyKey === 'offline' && t.riseCount > 0), false, '★ no phantom rise');
  assert.equal(a.pushes.length, 0, 'seeded at boot: no re-push');
});

test('★★★ a cloud outage at boot does not hold the alarms: past the bound the monitor evaluates on what exists', async () => {
  const lateSn = 'COREXXX00XXX0013';
  const lateId = `offline-${lateSn}`;
  restampAlertOnset(lateId, Date.now() - 2 * HOUR);
  const store = new SnapshotStore();
  store.setDeviceList([core('COREXXX00XXX0011', 'Core 1', 0)]); // a list, but the poll never settles
  const t0 = realNow();
  const a = alertRig(store, { bootHydrationMaxMs: 200 });
  await until(() => (store.get().alerts ?? []).some((x) => x.id === 'offline-COREXXX00XXX0011'), 'the offline alarm', a.logs);
  assert.ok(realNow() - t0 >= 150, 'it waited for the bound, not longer');
  assert.ok(a.has('no complete poll within'), 'the fallback says so, loudly');

  // The cloud comes back: the first hydrated pass re-tracks what it brings in (not a rise).
  store.setDeviceList([core('COREXXX00XXX0011', 'Core 1', 0), core(lateSn, 'Core 3', 0)]);
  store.markFirstPollSettled();
  await until(() => a.mon.activeAlertIds().includes(lateId), 'the late device', a.logs);
  assert.ok(a.has(`"${lateId}" re-tracked across a restart`), '★ the late-hydration pass re-tracks a pre-restart condition');
  assert.equal(a.mon.telemetry().some((t) => t.alertId === lateId && t.riseCount > 0), false, 'no phantom rise');
});

test('★★ the alarm counts wait for a complete set: hydrated, every feed delivered', async () => {
  const store = new SnapshotStore();
  store.setDeviceList([core('COREXXX00XXX0011', 'Core 1', 0)]);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const a = alertRig(store, {
    bootHydrationMaxMs: 60_000,
    // The curtailment feed is cold until released (a worker still warming up).
    report: async (n) => { if (n === 'curtailmentAlerts') { await gate; return []; } return n === 'forecast' ? null : []; },
  });
  await sleep(250);
  assert.equal(store.get().alertsComplete, undefined, 'not before the first pass');
  store.markFirstPollSettled();
  await until(() => a.mon.stats().evalPasses >= 2, 'two passes on a cold feed', a.logs);
  assert.ok((store.get().alerts ?? []).length > 0, 'the live alarms are published');
  assert.equal(store.get().alertsComplete, undefined, '★ but the set is not complete while a feed is cold');
  release();
  await until(() => store.get().alertsComplete === true, 'the completeness latch', a.logs);
});

test('★★ the boot orphan sweep holds only what a cold feed owns: a live-snapshot orphan is resolved', async () => {
  const sn = 'COREXXX00XXX0011';
  const id = `offline-${sn}`; // the offline family is exempt from the source-evidence gate
  const store = new SnapshotStore();
  store.setDeviceList([core(sn, 'Core 1', 1)]); // back online: the pushed offline alarm cleared across the restart
  store.markFirstPollSettled();
  const a = alertRig(store, {
    report: (n) => (n === 'curtailmentAlerts' ? never() : Promise.resolve(n === 'forecast' ? null : [])), // one feed never delivers
    notifyState: {
      [id]: { ts: Date.now() - HOUR, sent: true, sev: 'warning', title: 'Core 1 offline', sourceSn: sn },
      'pv-curtailment-active': { ts: Date.now() - HOUR, sent: true, sev: 'warning', title: 'Curtailment', sourceSn: 'SYSTEM' },
    },
  });
  await until(() => a.mon.stats().evalPasses >= 1, 'the first pass', a.logs);
  offset += 11 * 60_000; // past LEARNED_RESOLVE_GRACE_MS: the sweep runs
  await until(() => a.has('boot reconcile'), 'the boot reconcile', a.logs);
  assert.ok(!a.has(`HELD — "Core 1 offline"`), '★ a live-snapshot orphan is not held on a cold feed');
  assert.ok(a.has('HELD — "Curtailment" (alert feeds not yet delivered'), 'the cold feed\'s own id is held');
  assert.ok(a.logs.some((l) => /boot reconcile — .*held 1\b/.test(l)), a.logs.filter((l) => l.includes('reconcile')).join('\n'));
});

test('★ BRIDGE: refreshAll marks the store hydrated only after every listed-online quota was asked', () => {
  // SOURCE PIN, deliberately: refreshAll calls the EcoFlow cloud, which no test reaches.
  const s = SRC('snapshot.ts');
  const body = s.slice(s.indexOf('export async function refreshAll('), s.indexOf('/** Flatten nested object'));
  const all = body.indexOf('await Promise.all(');
  const mark = body.indexOf('store.markFirstPollSettled();');
  assert.ok(all > 0 && mark > all, 'after the quota fan-out settles');
  assert.ok(body.indexOf('store.setDeviceList(list);') < all, 'and after the list landed');
});

/* ══ (d) the cold-feed holds are scoped to the ids that feed owns ════════════════════════ */

test('★★ every id a feed producer emits is owned by that feed; no live-snapshot id is', () => {
  const a = SRC('analytics.ts');
  const producers: Array<[string, string]> = [
    ['baselineAlerts', 'export function computeBaselineAlerts('],
    ['forecastAlerts', 'export function computeForecastAlerts('],
    ['forecast', 'export function forecastDayAlerts('],
    ['storm-prep', 'export async function stormPrepAlerts('],
    ['curtailmentAlerts', 'export async function computeCurtailmentAlerts('],
  ];
  const owned = new Set<string>();
  for (const [feed, sig] of producers) {
    const at = a.indexOf(sig);
    assert.ok(at > 0, `${sig} located`);
    const end = a.indexOf('\nexport ', at + sig.length);
    const body = a.slice(at, end > 0 ? end : undefined);
    const ids = [...body.matchAll(/\bid: [`'"]([^`'"$]*)/g)].map((m) => m[1]);
    assert.ok(ids.length > 0, `${feed}: ids found`);
    for (const stem of ids) {
      assert.equal(alertFeedOwning(`${stem}X`), feed, `${feed} emits "${stem}…"`);
      owned.add(stem);
    }
  }
  assert.ok(Object.keys(ALERT_FEED_ID_PREFIXES).length === producers.length);
  // Live-snapshot ids never fall in a feed's families (their absence is evidence).
  for (const id of ['offline-CORE1', 'stale-CORE1', 'cloud-session-stale', 'telemetry-blind', 'vdiff-warn-CORE1-1', 'soc-low-CORE1', 'shp2-below-reserve-SHP2']) {
    assert.equal(alertFeedOwning(id), null, id);
  }
});

test('★★ BRIDGE: the onset prune waits only for the cold feed owning an id; a live id waits for hydration', () => {
  // SOURCE PIN, deliberately: the prune runs inside the tick closure.
  const s = SRC('alertMonitor.ts');
  assert.ok(s.includes('syncAlertOnsets(new Set(tracked.keys()), now, { prune: now - bootMs >= LEARNED_RESOLVE_GRACE_MS ? true : onsetPrunable });'));
  assert.ok(s.includes('alertFeedOwning(id) != null ? !coldFeedOwns(id) : storeHydrated();'));
});

/* ══ (b) + combined: a condition standing at boot ════════════════════════════════════════ */

async function bootWithStandingOfflineCore(): Promise<{ a: ReturnType<typeof alertRig>; b: ReturnType<typeof broadcastRig> }> {
  const store = new SnapshotStore();
  // The device list (a home Core listed offline) and the poll settle before the monitor starts,
  // as on 4 of 7 09-23 boots: tick 1 publishes the yellow before the broadcast's first tick.
  store.setDeviceList([core('COREXXX00XXX0012', 'Core 2', 0)]);
  store.markFirstPollSettled();
  const a = alertRig(store); // production order: alert monitor, then broadcast
  assert.ok((store.get().alerts ?? []).some((x) => x.severity === 'warning'), 'precondition: the yellow is published at once');
  const b = broadcastRig(store);
  return { a, b };
}

test('★★★ combined boot: a standing condition NEVER HEARD before the restart is announced exactly once', async () => {
  const { a, b } = await bootWithStandingOfflineCore();
  await until(() => b.has('yellow held for boot confirmation'), 'the boot yellow hold', [...a.logs, ...b.logs]);
  assert.ok(b.has('yellow standing at the first tick — routed through the boot gates'), '★ not joined silently');
  assert.equal(announces.length, 0, 'held, not yet spoken');
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5_000;
  await until(() => announces.length >= 1, 'the confirmed yellow', b.logs);
  await until(() => b.mon.status().conditionSpoken === true, 'the delivery to be recorded as heard', b.logs);
  await sleep(200); // many more ticks
  assert.equal(announces.length, 1, '★ spoken exactly once');
  assert.ok(b.has('condition transition → yellow'));
  assert.equal(b.mon.status().conditionLevel, 'yellow', 'recorded as heard, so the next boot does not repeat it');
});

test('★★★ combined boot: a standing condition HEARD before the restart is not re-spoken', async () => {
  writeFileSync(STATUS_PATH, JSON.stringify({ conditionLevel: 'yellow', conditionSpoken: true, conditionAt: Date.now() - HOUR }));
  const { a, b } = await bootWithStandingOfflineCore();
  await until(() => b.has('matches pre-restart advisory'), 'the restart continuation', [...a.logs, ...b.logs]);
  offset += B.BOOT_YELLOW_CONFIRM_MS + 5_000;
  await sleep(200);
  assert.equal(announces.length, 0, '★ heard before the restart: suppressed');
  assert.ok(!b.has('condition transition → yellow'));
});

test('★★★ a critical standing at the first tick goes through holdBootRed and is spoken', async () => {
  const store = new SnapshotStore();
  const crit: Alert = { id: 'dpu-err-COREXXX00XXX0011', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Inverter fault', detail: 'x', fault: 'err7' } as Alert;
  store.setAlerts([crit]);
  const b = broadcastRig(store);
  await until(() => announces.length >= 1, 'the red', b.logs);
  assert.ok(b.has('red standing at the first tick'));
  assert.ok(b.has('red held one tick for boot confirmation'), 'the phantom guard still applies');
  assert.ok(b.has('condition transition → red'));
  await sleep(150);
  assert.equal(announces.length, 1);
});

test('a green first tick still joins silently (an unpopulated store is not an all-clear)', async () => {
  const store = new SnapshotStore();
  const b = broadcastRig(store);
  await sleep(100);
  assert.equal(announces.length, 0);
  assert.ok(!b.has('standing at the first tick'));
  assert.ok(!b.has('condition transition'));
});
