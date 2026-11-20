/**
 * v1.208.0 — "Core out of the backup pool" through the REAL store and the REAL alert monitor, in the two settings
 * test/poolOutMonitor.test.ts cannot have: the monitor's push debounce at its SHIPPED 60 seconds (that file runs it
 * at zero), and a restart INTO a cloud outage, where no device list arrives (that file's monitor waits 30 seconds of
 * real time for one; here the wait is half a second).
 *
 * Home Assistant is mocked at the HTTP layer and the push channel is a recorder of what was sent. The bodies are the
 * pool-out fixtures: rows of the recorder's 5-minute panel series for 2026-11-14 with the capacity, the flags and a
 * MOVING twelve-circuit vector ADDED by the builder (synthetic: none was recorded), and placeholder serials.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Body, TimedBody } from './fixtures/poolOutFixtures.js';

/* ── environment: set BEFORE any src module is loaded ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-pool-out-boot-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '300';
delete process.env.ALERT_DEBOUNCE_MS; // the shipped push debounce: 60 seconds
process.env.ALERT_BOOT_HYDRATION_MAX_MS = '500'; // the monitor evaluates without a device list after half a second
process.env.SITE_TIMEZONE = 'America/Phoenix';
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.NOTIFY_DIGEST_HOUR = '7';
delete process.env.NOTIFY_CHANNEL;
delete process.env.NOTIFY_RESOLVED;
delete process.env.CRITICAL_BREAKS_QUIET_HOURS;
delete process.env.GRID_PRESENCE_ENTITY;
delete process.env.GRID_AVAILABLE;
process.env.ALERT_ONSET_PATH = join(ROOT, 'alert-onset.json');
process.env.IDLE_POOL_STATE_PATH = join(ROOT, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = join(ROOT, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = join(ROOT, 'latch.json');
process.env.HOST_PRESSURE_STATE_PATH = join(ROOT, 'host-pressure.json');
process.env.SHADOW_WITNESS_PATH = join(ROOT, 'shadow-witness.json');

/* ── clock: real time flows from whatever instant `setNow` last named ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const setNow = (ms: number): void => { offset = ms - realNow(); };

const { makeRecorderStub } = await import('./helpers/recorderStub.js');
const { startAlertMonitor, DEBOUNCE_MS, BOOT_HYDRATION_MAX_MS } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { resetAlertOnsetCacheForTests } = await import('../src/alertOnset.js');
const fx = await import('./fixtures/poolOutFixtures.js');
const { PANEL_SN, MIN, at, healthyBody, lostBody } = fx;

const LOSS = fx.loadPoolFixture('pool-loss-1114');
const lossBodies = fx.bodiesFromRows(LOSS.rows, (t) => fx.capacityAt(LOSS.capacity, t));
const iso = (s: string): number => Date.parse(s);
const LISTED = [{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any[];
const RAISE_TITLE = 'Power · [High] Core out of the backup pool: slot 1 — Smart Home Panel 2';

const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(200, '[]').persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/'), method: () => true }).reply(200, '{}').persist();

type Store = InstanceType<typeof SnapshotStore>;
interface Push { title: string; body: string; severity: string }
const stops: Array<() => void> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, logs: string[] = [], ms = 10_000): Promise<void> {
  const start = realNow();
  while (!pred()) {
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}\n${logs.filter((l) => /pool|notify|orphan|alerts:/.test(l)).slice(-40).join('\n')}`);
    await sleep(5);
  }
}
let seq = 0;
function storeWith(name: string, opts: { poolFile?: string } = {}): { store: Store; logs: string[]; poolFile: string; feed: (b: TimedBody | { atMs: number; body: Body }) => void } {
  const n = ++seq;
  process.env.HOUSE_PANEL_PATH = join(ROOT, `${name}-${n}-house-panel.json`);
  writeFileSync(process.env.HOUSE_PANEL_PATH, JSON.stringify({ sn: PANEL_SN, rosters: {} }));
  process.env.POOL_UNKNOWN_PATH = join(ROOT, `${name}-${n}-pool-unknown.json`);
  process.env.GRID_READING_PATH = join(ROOT, `${name}-${n}-grid-reading.json`);
  const poolFile = opts.poolFile ?? join(ROOT, `${name}-${n}-pool-out.json`);
  let store: Store;
  try {
    store = new SnapshotStore({ poolOutPath: poolFile, poolEventsDir: join(ROOT, `${name}-${n}-events`) });
  } finally {
    delete process.env.HOUSE_PANEL_PATH; delete process.env.POOL_UNKNOWN_PATH; delete process.env.GRID_READING_PATH;
  }
  const logs: string[] = [];
  store.setLogger((m) => logs.push(m));
  store.setWarnLogger((m) => logs.push(m));
  let dataMs = Date.now();
  store.setClock(() => dataMs);
  return {
    store, logs, poolFile,
    feed: (b) => { setNow(b.atMs); dataMs = b.atMs; store.setDeviceList(LISTED); store.setDeviceQuota(PANEL_SN, b.body); },
  };
}
function alertRig(store: Store, opts: { name?: string; quietHours?: string } = {}) {
  const name = opts.name ?? `m${++seq}`;
  process.env.NOTIFY_STATE_PATH = join(ROOT, `${name}-notify-state.json`);
  process.env.DIGEST_STATE_PATH = join(ROOT, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(ROOT, `${name}-cleared.json`);
  process.env.NOTIFY_QUIET_HOURS = opts.quietHours ?? '22-06';
  const logs: string[] = [];
  const pushes: Push[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: async (_cfg: unknown, msg: Push) => { pushes.push({ title: msg.title, body: msg.body, severity: msg.severity }); },
  });
  stops.push(() => mon.stop());
  const passes = () => mon.stats().evalPasses;
  return {
    mon, logs, pushes, passes, name,
    poolPushes: () => pushes.filter((p) => /backup pool/i.test(p.title)),
    morePasses: async (n: number) => { const from = passes(); await until(() => passes() >= from + n, `${n} more passes`, logs); },
  };
}
const poolAlerts = (store: Store) => (store.get().alerts ?? []).filter((a) => a.id.startsWith('shp2-pool-out'));

beforeEach(() => {
  for (const s of stops.splice(0)) s();
  resetAlertOnsetCacheForTests();
  if (existsSync(process.env.ALERT_ONSET_PATH!)) unlinkSync(process.env.ALERT_ONSET_PATH!);
});
after(async () => {
  for (const s of stops.splice(0)) s();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
});

test('control: this file runs the monitor with its shipped 60-second push debounce and a half-second wait for the first device list', () => {
  assert.equal(DEBOUNCE_MS, 60_000);
  assert.equal(BOOT_HYDRATION_MAX_MS, 500);
});

test('★★★ the push debounce does not delay this alarm: it is pushed at the pass after its raise, while a source link issue that rose with it waits its sixty seconds', async () => {
  const s = storeWith('debounce');
  const linkDown = (seq: number) => lostBody(seq, { slots: [{ pct: 72, w: 0 }, { pct: 65, w: -1107, hwConnect: 0 }, { pct: 63, w: -1061 }] });
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { quietHours: '' }); // no quiet hours: the debounce is the only thing that can hold a push
  await r.morePasses(2);
  // Ten minutes of readings one Core short with slot 2's link healthy, then the raising body with the link down too:
  // both alerts rise at the same body.
  for (let m = 0; m < 10; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await r.morePasses(2);
  assert.deepEqual(poolAlerts(s.store), [], 'control: not raised at minute 9');
  s.feed({ atMs: at(10), body: linkDown(10) });
  await until(() => r.poolPushes().length === 1, 'the raise pushed with no time passing', r.logs);
  await r.morePasses(3);
  const linkPushes = () => r.pushes.filter((p) => /Source link issue/.test(p.title));
  assert.equal((s.store.get().alerts ?? []).some((a) => a.id.startsWith('shp2-src-hw')), true, 'control: the source link issue is in the set too');
  assert.deepEqual(linkPushes(), [], 'control: the debounce is in force: that warning is not pushed yet');
  assert.equal(r.poolPushes()[0].title, RAISE_TITLE, '★ this alarm is: the same pass as its raise, the clock still at 23:10');
  assert.equal(Date.now() - at(10) < 30_000, true, 'control: under thirty seconds have passed on the clock the monitor reads');
  // Sixty-one seconds on, the same state: the debounce lets the other warning through. Nothing more for this alarm.
  s.feed({ atMs: at(10) + 61_000, body: linkDown(11) });
  await until(() => linkPushes().length === 1, 'the debounced warning pushed', r.logs);
  assert.equal(r.poolPushes().length, 1);
});

test('★★★ a restart INTO a cloud outage (no device list arrives): the standing alarm is in the published set, under the id and the panel name it was raised with — and nothing is pushed, then or when the list arrives', async () => {
  // The first process: raised, pushed, on file.
  const a = storeWith('outage');
  for (const b of lossBodies) if (b.atMs === iso('2026-11-15T06:00:00Z')) a.feed(b);
  a.store.markFirstPollSettled();
  const ra = alertRig(a.store, { name: 'outage-mon', quietHours: '' });
  for (const b of lossBodies) if (b.atMs > iso('2026-11-15T06:00:00Z') && b.atMs <= iso('2026-11-15T06:50:00Z')) a.feed(b);
  await until(() => ra.poolPushes().length === 1, 'the raise pushed', ra.logs);
  await ra.morePasses(2);
  assert.deepEqual(JSON.parse(readFileSync(a.poolFile, 'utf8')).cards, { [PANEL_SN]: { id: 'shp2-pool-out', device: 'Smart Home Panel 2' } }, 'control: its id and name are on file');
  ra.mon.stop();

  // The second process, seven minutes later: the same files, and NO device list (the poll fails at the list).
  setNow(iso('2026-11-15T06:57:00Z'));
  const b = storeWith('outage-b', { poolFile: a.poolFile });
  const rb = alertRig(b.store, { name: 'outage-mon', quietHours: '' });
  await until(() => rb.passes() >= 3, 'three passes with no device list', rb.logs);
  assert.deepEqual(Object.keys(b.store.get().devices), [], 'control: no device is listed in this process');
  assert.deepEqual(poolAlerts(b.store).map((x) => [x.id, x.device, x.sourceSn, x.severity, x.title, x.fault]), [
    ['shp2-pool-out', 'Smart Home Panel 2', PANEL_SN, 'warning', 'Core out of the backup pool: slot 1', 'out:1;k=1'],
  ], '★ in the published set at the first passes: the dashboard, the alert counts and the broadcast have it');
  assert.match(poolAlerts(b.store)[0].detail, /No new panel reading since 23:50\.$/, 'and it says how old its newest reading is');
  assert.deepEqual(rb.poolPushes(), [], '★ not pushed again: its notification is on record');

  // The list arrives twenty minutes later: the same alert, nothing new.
  setNow(iso('2026-11-15T07:17:00Z'));
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  await rb.morePasses(3);
  assert.deepEqual(poolAlerts(b.store).map((x) => [x.id, x.device, x.title]), [['shp2-pool-out', 'Smart Home Panel 2', 'Core out of the backup pool: slot 1']]);
  assert.deepEqual(rb.poolPushes(), [], '★ no second push and no "Resolved" when the list arrives');
});
