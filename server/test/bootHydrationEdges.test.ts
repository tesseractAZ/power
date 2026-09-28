/**
 * v1.186.3 — two boot edges past the alert monitor's hydration bound (a cloud outage at boot, or
 * a slow first poll).
 *
 * (a) A worker-served feed answered from an EMPTY map (the analytics client lets a request
 *     through after its first-snapshot wait) and that empty answer counted as the feed's one
 *     first delivery: the onset prune then deleted the pre-restart onsets of its standing alarms,
 *     and when the alarm came back on a later pass it counted as a NEW rise. The re-track now
 *     keys on the id's first appearance since boot, a feed is warm only once a value computed
 *     on a hydrated snapshot lands, and the warm-up prune bound runs from hydration.
 * (b) With the cloud unreachable for more than the warm-up window, the boot orphan sweep pushed
 *     "Resolved: … offline" for a live-snapshot id (offline-* is exempt from the device-evidence
 *     gate) while the store was still empty. Such orphans are now held until hydration.
 * (c) Both apply only to ids DERIVED FROM DEVICE DATA (isDeviceDerivedAlertId). storm-* (NWS)
 *     and the alarm-host self-alerts are computed without the device list: during the same
 *     outage they resolve, prune and push exactly as on v1.186.2.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { makeRecorderStub } from './helpers/recorderStub.js';

const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-boothyd-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '300';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
delete process.env.NOTIFY_CHANNEL;
delete process.env.GRID_PRESENCE_ENTITY;

const { startAlertMonitor, createLastGoodFeed, isDeviceDerivedAlertId, ALERT_FEED_ID_PREFIXES } = await import('../src/alertMonitor.js');
const { noteTtsRenderFailure, noteTtsRenderSuccess } = await import('../src/audioRenderer.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { restampAlertOnset, getAlertOnset } = await import('../src/alertOnset.js');
const { createAnalyticsClient } = await import('../src/analyticsClient.js');

const HOUR = 3_600_000;
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, logs: string[] = [], ms = 8000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${logs.join('\n')}`);
    await sleep(5);
  }
}
const stops: Array<() => void> = [];
beforeEach(() => { for (const s of stops.splice(0)) s(); offset = 0; });
after(() => { for (const s of stops.splice(0)) s(); rmSync(ROOT, { recursive: true, force: true }); });

const core = (sn: string, name: string) => ({ sn, deviceName: name, productName: 'DELTA Pro Ultra', online: 1 }) as any;
const baseline = (sn: string) => ({
  id: `baseline-${sn}-acOut`, severity: 'warning', category: 'Anomaly', device: 'Core 1',
  title: 'Core 1 load unusual for the hour', detail: 'x', sourceSn: sn,
}) as any;

let seq = 0;
function rig(store: InstanceType<typeof SnapshotStore>, analytics: unknown, notifyState?: Record<string, unknown>, stormPrep: () => Promise<any[]> = async () => []) {
  const name = `h${++seq}`;
  process.env.NOTIFY_STATE_PATH = join(ROOT, `${name}-notify-state.json`);
  if (notifyState) writeFileSync(process.env.NOTIFY_STATE_PATH, JSON.stringify(notifyState));
  process.env.DIGEST_STATE_PATH = join(ROOT, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(ROOT, `${name}-cleared.json`);
  const logs: string[] = [];
  const pushes: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: analytics as any,
    stormPrep,
    captureLrFeatures: (async () => null) as any,
    send: async (_c: unknown, msg: { title: string }) => { pushes.push(msg.title); },
    bootHydrationMaxMs: 200,
  });
  stops.push(() => mon.stop());
  return { mon, logs, pushes, has: (s: string) => logs.some((l) => l.includes(s)) };
}

/** A standing worker-served alarm, pushed before the restart, onset 3 h ago. */
function standing(id: string, sn: string): Record<string, unknown> {
  restampAlertOnset(id, Date.now() - 3 * HOUR);
  return { [id]: { ts: Date.now() - HOUR, sent: true, sev: 'warning', title: 'Core 1 load unusual for the hour', sourceSn: sn } };
}

async function assertRetracked(a: ReturnType<typeof rig>, id: string): Promise<void> {
  await until(() => a.mon.activeAlertIds().includes(id), 'the alarm after hydration', a.logs);
  const passes = a.mon.stats().evalPasses;
  await until(() => a.mon.stats().evalPasses >= passes + 2, 'two more passes', a.logs);
  assert.ok(a.has(`"${id}" re-tracked across a restart`), '★ re-tracked, not a rise');
  assert.equal(a.mon.telemetry().some((t) => t.alertId === id && t.riseCount > 0), false, '★ no phantom rise');
  assert.equal(a.pushes.filter((p) => p.includes('load unusual')).length, 0, 'no re-push');
}

/* ══ (a) worker-served standing alarms across a bound-opened boot ═══════════════════════════ */

for (const variant of ['fast', 'slow'] as const) {
  test(`★★★ (a/${variant}) an empty pre-hydration answer is not the feed's first delivery: the onset is kept and the alarm re-tracks`, async () => {
    const sn = variant === 'fast' ? 'COREXXX00XXX0021' : 'COREXXX00XXX0022';
    const id = `baseline-${sn}-acOut`;
    const notifyState = standing(id, sn);
    const store = new SnapshotStore();
    store.markDeviceListAttempt(); // the cloud is unreachable: the list never lands
    let hydratedCalls = 0;
    const a = rig(store, {
      report: async (n: string) => {
        if (n === 'forecast') return null;
        if (n !== 'baselineAlerts') return [];
        if (store.firstPollSettledAt === 0) return []; // the worker on an empty map
        hydratedCalls++;
        // slow: a cold worker over its budget on the first hydrated report (a later pass delivers)
        if (variant === 'slow' && hydratedCalls === 1) await sleep(600);
        return [baseline(sn)];
      },
    }, notifyState);
    await until(() => a.mon.stats().evalPasses >= 3, 'passes on the unhydrated store', a.logs);
    assert.ok(a.has('no complete poll within'), 'the bound opened the gate');
    assert.ok(a.has('baselineAlerts answered before the store was hydrated'), 'the provisional answer is named');
    assert.equal(getAlertOnset(id) != null, true, '★ the pre-restart onset survives the empty answers');
    if (variant === 'fast') {
      // The outage outlasts the warm-up window: the bound runs from hydration, not from boot.
      offset += 11 * 60_000;
      const passes = a.mon.stats().evalPasses;
      await until(() => a.mon.stats().evalPasses >= passes + 2, 'passes past the warm-up window', a.logs);
      assert.equal(getAlertOnset(id) != null, true, '★ the onset survives a cloud outage past the warm-up window');
    }

    store.setDeviceList([core(sn, 'Core 1')]);
    store.markFirstPollSettled(); // the cloud is back
    await assertRetracked(a, id);
  });
}

test('★★★ (a/real client) a report computed before the worker holds the hydrated map does not warm the feed', async () => {
  const sn = 'COREXXX00XXX0023';
  const id = `baseline-${sn}-acOut`;
  const notifyState = standing(id, sn);
  const store = new SnapshotStore();
  store.markDeviceListAttempt();
  const logs: string[] = [];
  // A fake worker thread behind the REAL analyticsClient: it computes on whatever map it holds.
  let workerSnap: any = { devices: {} };
  const listeners: Record<string, Array<(m: any) => void>> = {};
  const fakeWorker = {
    on(ev: string, l: (m: any) => void) { (listeners[ev] ??= []).push(l); },
    postMessage(msg: any) {
      if (msg.kind === 'snapshot') { workerSnap = structuredClone(msg.snapshot); return; }
      if (msg.kind !== 'report') return;
      const has = Object.keys(workerSnap.devices ?? {}).length > 0;
      const result = msg.name === 'forecast' ? null : (msg.name === 'baselineAlerts' && has ? [baseline(sn)] : []);
      setTimeout(() => listeners.message?.forEach((l) => l({ kind: 'result', id: msg.id, ok: true, result })), 5);
    },
    terminate() {},
  };
  const client = createAnalyticsClient('/nonexistent', (m: string) => logs.push(m), { spawnWorker: () => fakeWorker as any, firstSnapshotWaitMs: 100 });
  stops.push(() => client.stop());
  store.on('change', (s: any) => client.pushSnapshot(s));
  store.on('hydrated', () => client.flushSnapshot());
  const a = rig(store, client, notifyState);
  await until(() => a.mon.stats().evalPasses >= 3, 'passes on the unhydrated store', a.logs);
  assert.equal(getAlertOnset(id) != null, true, 'the onset survives');
  assert.equal(client.snapshotHydrated!(), false, 'the worker has not been handed a hydrated map');

  store.setDeviceList([core(sn, 'Core 1')]); // list-only: not flushed at once, posted by the throttle
  store.markFirstPollSettled();
  await until(() => client.snapshotHydrated!(), 'the worker holding the hydrated map', a.logs);
  await assertRetracked(a, id);
});

test('★★ createLastGoodFeed: a value fetched before hydration is carried but is neither warm nor a first delivery', async () => {
  let hydrated = false;
  const logs: string[] = [];
  const f = createLastGoodFeed<number[]>('probe', (m) => logs.push(m), undefined, () => hydrated);
  const r1 = await f.read(async () => [], 50);
  assert.deepEqual(r1.value, [], 'what exists is returned');
  assert.equal(r1.firstDelivery, false, '★ not the first delivery');
  assert.equal(f.warm(), false, '★ not warm');
  hydrated = true;
  const r2 = await f.read(async () => [1], 50);
  assert.equal(r2.firstDelivery, true, 'the first value computed on a hydrated store');
  assert.equal(f.warm(), true);
  assert.equal((await f.read(async () => [1], 50)).firstDelivery, false, 'once');
  assert.ok(logs.some((l) => l.includes('answered before the store was hydrated')));
  assert.ok(logs.some((l) => l.includes('delivered its first value')));
});

test('★★ analyticsClient: a report cached before the hydrated map is not served after it', async () => {
  const posted: any[] = [];
  const listeners: Record<string, Array<(m: any) => void>> = {};
  let answer: unknown = [];
  const fw = {
    on(ev: string, l: (m: any) => void) { (listeners[ev] ??= []).push(l); },
    postMessage(msg: any) {
      posted.push(msg);
      if (msg.kind === 'report') {
        const result = answer;
        setTimeout(() => listeners.message?.forEach((l) => l({ kind: 'result', id: msg.id, ok: true, result })), 1);
      }
    },
    terminate() {},
  };
  const c = createAnalyticsClient('/nonexistent', () => {}, { spawnWorker: () => fw as any, firstSnapshotWaitMs: 10 });
  // The client's first-snapshot timer is unref'd (it must not hold a process open); with no
  // other handle alive, Node 22 would end the test file while the report waits on it.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await c.report('forecastAlerts'), [], 'computed on no map at all');
    c.pushSnapshot({ generatedAt: 0, devices: { COREXXX00XXX0024: { sn: 'COREXXX00XXX0024', projection: { kind: 'dpu' } } } } as any);
    answer = ['computed on the hydrated map'];
    c.flushSnapshot();
    assert.equal(c.snapshotHydrated!(), true);
    assert.deepEqual(await c.report('forecastAlerts'), ['computed on the hydrated map'], '★ the pre-hydration cache entry is gone');
  } finally {
    clearInterval(keepAlive);
    c.stop();
  }
});

test('★★ analyticsClient: a report IN FLIGHT when the worker gets the hydrated map is returned but not cached', async () => {
  const listeners: Record<string, Array<(m: any) => void>> = {};
  let answer: unknown = [];
  const fw = {
    on(ev: string, l: (m: any) => void) { (listeners[ev] ??= []).push(l); },
    postMessage(msg: any) {
      if (msg.kind === 'report') {
        const result = answer; // what the worker holds when it computes
        setTimeout(() => listeners.message?.forEach((l) => l({ kind: 'result', id: msg.id, ok: true, result })), 40);
      }
    },
    terminate() {},
  };
  const c = createAnalyticsClient('/nonexistent', () => {}, { spawnWorker: () => fw as any, firstSnapshotWaitMs: 10 });
  const keepAlive = setInterval(() => {}, 1000); // see the test above
  try {
    const early = c.report('baselineAlerts');
    await sleep(25); // the first-snapshot wait has lapsed; the request is computing on no map
    c.pushSnapshot({ generatedAt: 0, devices: { COREXXX00XXX0026: { sn: 'COREXXX00XXX0026', projection: { kind: 'dpu' } } } } as any);
    answer = ['computed on the hydrated map'];
    c.flushSnapshot();
    assert.deepEqual(await early, [], 'the in-flight caller gets what was computed');
    assert.deepEqual(await c.report('baselineAlerts'), ['computed on the hydrated map'], '★ the stale value was not cached');
  } finally {
    clearInterval(keepAlive);
    c.stop();
  }
});

/* ══ (b) the boot orphan sweep on an unhydrated store ═════════════════════════════════════════ */

test('★★★ (b) a cloud outage past the warm-up window: a live-snapshot orphan is HELD, not resolved, then judged on evidence', async () => {
  const sn = 'COREXXX00XXX0025';
  const store = new SnapshotStore();
  store.markDeviceListAttempt();
  const a = rig(store, { report: async (n: string) => (n === 'forecast' ? null : []) }, {
    [`offline-${sn}`]: { ts: Date.now() - HOUR, sent: true, sev: 'warning', title: 'Core 2 offline', sourceSn: sn },
  });
  await until(() => a.mon.stats().evalPasses >= 1, 'the bound-opened first pass', a.logs);
  offset += 11 * 60_000; // past LEARNED_RESOLVE_GRACE_MS: the sweep runs, the store still empty
  await until(() => a.has('boot reconcile'), 'the boot reconcile', a.logs);
  assert.equal(a.pushes.filter((p) => p.includes('Resolved')).length, 0, `★ no "Resolved:" from an empty store: ${a.pushes.join(' | ')}`);
  assert.ok(a.has('HELD — "Core 2 offline" (no complete poll yet'), 'the hold names its reason');

  // The cloud comes back with the Core online: now the absence is evidence.
  store.setDeviceList([core(sn, 'Core 2')]);
  store.markFirstPollSettled();
  await until(() => a.pushes.some((p) => p.includes('Resolved: Core 2 offline')), 'the evidence-based resolve', a.logs);
});

/* ══ (c) only DEVICE-derived ids wait for hydration ═══════════════════════════════════════════ */

const noReports = { report: async (n: string) => (n === 'forecast' ? null : []) };

test('★★★ (c) storm-prep reads only NWS: during an unhydrated outage an ended storm resolves and a NEW one pushes', async () => {
  const id = 'storm-Severe_Thunderstorm_Warning';
  const title = 'Severe Thunderstorm Warning — pre-charge recommended';
  restampAlertOnset(id, Date.now() - 3 * HOUR);
  let storms: any[] = []; // NWS reachable: the pre-restart storm has ended
  const store = new SnapshotStore();
  store.markDeviceListAttempt(); // the EcoFlow list never lands in this test
  const a = rig(store, noReports, { [id]: { ts: Date.now() - HOUR, sent: true, sev: 'warning', title } },
    async () => storms.map((x) => ({ ...x })));
  await until(() => a.mon.stats().evalPasses >= 3, 'passes on the unhydrated store', a.logs);
  assert.equal(getAlertOnset(id), undefined, '★ the NWS answer is evidence: the ended storm\'s onset is pruned');
  offset += 11 * 60_000;
  await until(() => a.has('boot reconcile'), 'the boot reconcile', a.logs);
  assert.ok(a.pushes.includes(`EcoFlow · Resolved: ${title}`), `★ the ended storm resolves at the sweep: ${a.pushes.join(' | ')}`);

  offset += HOUR; // a NEW warning of the same event type
  storms = [{ id, severity: 'warning', category: 'Grid', source: 'learned', device: 'System', title, detail: 'in effect now' }];
  await until(() => a.pushes.some((p) => p.includes(title) && !p.includes('Resolved')), 'the new storm push', a.logs);
  assert.equal(a.has(`"${id}" re-tracked across a restart`), false, '★ a new storm is a rise, not a re-track');
});

test('★★ (c) a storm standing across the restart, NWS slow on the first pass: its feed\'s first delivery re-tracks it', async () => {
  const id = 'storm-Tornado_Warning';
  const title = 'Tornado Warning — pre-charge recommended';
  restampAlertOnset(id, Date.now() - 3 * HOUR);
  let calls = 0;
  const store = new SnapshotStore();
  store.markDeviceListAttempt();
  const a = rig(store, noReports, undefined, async () => {
    if (++calls === 1) await sleep(600); // past ALERT_FEED_BUDGET_MS: the first pass carries nothing
    return [{ id, severity: 'warning', category: 'Grid', source: 'learned', device: 'System', title, detail: 'in effect now' }];
  });
  await until(() => a.mon.activeAlertIds().includes(id), 'the storm on its first delivery', a.logs);
  const passes = a.mon.stats().evalPasses;
  await until(() => a.mon.stats().evalPasses >= passes + 2, 'two more passes', a.logs);
  assert.ok(a.has(`"${id}" re-tracked across a restart`), '★ the first delivery is the storm feed\'s first run');
  assert.equal(a.pushes.filter((p) => p.includes('Tornado Warning')).length, 0, 'no re-push');
});

test('★★★ (c) the alarm-host self-alerts are not held for hydration; offline-* still is', async () => {
  const sn = 'COREXXX00XXX0027';
  const hp = 'host-power-undervoltage';
  const tts = 'tts-render-degraded';
  const off = `offline-${sn}`;
  for (const id of [hp, tts, off]) restampAlertOnset(id, Date.now() - 3 * HOUR);
  noteTtsRenderSuccess();
  const store = new SnapshotStore();
  store.markDeviceListAttempt();
  const a = rig(store, noReports, {
    [hp]: { ts: Date.now() - HOUR, sent: true, sev: 'warning', title: 'Alarm host power — under-voltage' },
    [off]: { ts: Date.now() - HOUR, sent: true, sev: 'warning', title: 'Core 2 offline', sourceSn: sn },
  });
  try {
    await until(() => a.mon.stats().evalPasses >= 3, 'passes on the unhydrated store', a.logs);
    // Five minutes in, still unhydrated: the voice degrades. Its pre-restart onset is still on
    // file (inside the warm-up window), yet it is a new episode: pushed, as on v1.186.2.
    offset += 5 * 60_000;
    noteTtsRenderFailure('probe');
    noteTtsRenderFailure('probe');
    await until(() => a.pushes.some((p) => p.includes('Alarm voice degraded')), 'the TTS push', a.logs);
    assert.equal(a.has(`"${tts}" re-tracked across a restart`), false, '★ not re-tracked on a later first appearance');

    offset += 6 * 60_000; // past the warm-up window, still unhydrated
    await until(() => a.has('boot reconcile'), 'the boot reconcile', a.logs);
    assert.ok(a.pushes.includes('EcoFlow · Resolved: Alarm host power — under-voltage'), `★ the host alert resolves: ${a.pushes.join(' | ')}`);
    assert.equal(getAlertOnset(hp), undefined, '★ its onset is pruned at the window counted from boot');
    assert.equal(a.pushes.some((p) => p.includes('Resolved: Core 2 offline')), false, 'the device id is still held');
    assert.ok(a.has('HELD — "Core 2 offline" (no complete poll yet'));
    assert.notEqual(getAlertOnset(off), undefined, 'and its onset kept until the window counted from hydration');
  } finally {
    noteTtsRenderSuccess();
  }
});

test('★★ isDeviceDerivedAlertId: every id stem the live producers emit is on the right side', async () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/alerts.ts'), 'utf8');
  const at = src.indexOf('export function computeAlerts(');
  const body = src.slice(at, src.indexOf('\nexport ', at + 10));
  const stems = new Set<string>();
  for (const m of body.matchAll(/\b(?:id|idBase): (?:[\w.!]+ \? )?[`'"]([^`'"$]*)[^`'"]*[`'"](?: : [`'"]([^`'"$]*))?/g)) {
    stems.add(m[1]);
    if (m[2] != null) stems.add(m[2]);
  }
  assert.ok(stems.size >= 35, `computeAlerts stems found: ${[...stems].join(', ')}`);
  const system = new Set(['cloud-session-stale', 'grid-offgrid', 'host-power-undervoltage', 'host-temp-crit', 'host-temp-warn',
    'host-pressure-crit', 'host-pressure-warn', 'tts-render-degraded']);
  for (const stem of stems) {
    assert.equal(isDeviceDerivedAlertId(`${stem}X`), !system.has(stem), `computeAlerts emits "${stem}…"`);
  }
  for (const s of system) assert.ok(stems.has(s), `${s} still emitted by computeAlerts`);
  const { PEAK_GRID_DRAW_ALERT_ID } = await import('../src/peakGridDraw.js');
  const { rateFloorAlertId } = await import('../src/messageRateFloorAlert.js');
  const { TELEMETRY_BLIND_ALERT_ID } = await import('../src/telemetryBlind.js');
  const { AUDIBLE_DEGRADED_ALERT_ID, AUDIBLE_UNREACHABLE_ALERT_ID } = await import('../src/broadcastHealth.js');
  const { deviceGapAlertId } = await import('../src/alerts.js');
  for (const id of ['peer-cellV-COREXXX00XXX0027-1', PEAK_GRID_DRAW_ALERT_ID, rateFloorAlertId('COREXXX00XXX0027')]) {
    assert.equal(isDeviceDerivedAlertId(id), true, id);
  }
  for (const id of [TELEMETRY_BLIND_ALERT_ID, AUDIBLE_DEGRADED_ALERT_ID, AUDIBLE_UNREACHABLE_ALERT_ID, 'system-outage-1700000000000',
    deviceGapAlertId('COREXXX00XXX0027', 1_700_000_000_000), 'storm-Tornado_Warning']) {
    assert.equal(isDeviceDerivedAlertId(id), false, id);
  }
  // The worker-served families are computed on the worker's device map; storm-prep on NWS alone.
  for (const [feed, prefixes] of Object.entries(ALERT_FEED_ID_PREFIXES)) {
    for (const p of prefixes) assert.equal(isDeviceDerivedAlertId(`${p}X`), feed !== 'storm-prep', `${feed}: ${p}`);
  }
});
