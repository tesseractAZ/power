/**
 * v1.208.0 — "Core out of the backup pool" through the REAL store and the REAL alert monitor, with Home Assistant
 * mocked at the HTTP layer and the push channel replaced by a recorder of what was sent.
 *
 * Sat 2026-11-14 23:35 MST the panel's pool capacity fell from 92.16 to 61.44 kWh and nothing was logged, alerted,
 * pushed or spoken, at the loss or at the return 44.5 hours later. These tests feed the two fixtures (the recorder's
 * 5-minute rows of those hours, each as five bodies a minute apart) through SnapshotStore.setDeviceQuota while the
 * monitor runs, and read what reaches the alert set and the phone.
 *
 * THE FIXTURE IS SYNTHETIC IN PART: the recorder stored neither the pool capacity nor any flag, error code or circuit
 * watt, so the builder (fixtures/poolOutFixtures.ts) adds the capacity of each minute, the flags of the one raw sample
 * on record, empty error lists and a MOVING twelve-circuit vector. Serials are placeholders.
 *
 * READING A RED TEST. Each scenario first asserts what is true without this release (every body new, the latch clear,
 * the projection at 61,440 Wh after the loss), then pairs "the alert is there at T" with "it is not there at T − 1"
 * (or the reverse for the return): absence alone, or presence alone, proves nothing.
 *
 * THE DELIVERY POLICY IS DECIDED: this alarm is pushed at once at any hour, with its whole detail. The tests below
 * state that outright (a push at 23:46, inside the quiet hours, and nothing in the digest queue), so a change of
 * poolOut.ts poolOutDelivery fails them rather than moving their expectation with it.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Body, TimedBody } from './fixtures/poolOutFixtures.js';

/* ── environment: set BEFORE any src module is loaded ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-pool-out-mon-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '300';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.SITE_TIMEZONE = 'America/Phoenix';
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.NOTIFY_DIGEST_HOUR = '7';
delete process.env.NOTIFY_CHANNEL;
delete process.env.NOTIFY_RESOLVED; // resolves are pushed (the default)
delete process.env.CRITICAL_BREAKS_QUIET_HOURS; // the default: a critical is held overnight like a warning
delete process.env.GRID_PRESENCE_ENTITY; // the grid verdict rests on the panel's own reading
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
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { resetAlertOnsetCacheForTests } = await import('../src/alertOnset.js');
const fx = await import('./fixtures/poolOutFixtures.js');
const { PANEL_SN, CORE_SNS, MIN, at, healthyBody, lostBody } = fx;

const LOSS = fx.loadPoolFixture('pool-loss-1114');
const RETURN = fx.loadPoolFixture('pool-return-1116');
const lossBodies = fx.bodiesFromRows(LOSS.rows, (t) => fx.capacityAt(LOSS.capacity, t));
const returnBodies = fx.bodiesFromRows(RETURN.rows, (t) => fx.capacityAt(RETURN.capacity, t));
const iso = (s: string): number => Date.parse(s);
const LISTED = [{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any[];
const OFFLINE = [{ ...LISTED[0], online: 0 }] as any[];

const RAISE_TITLE = 'Power · [High] Core out of the backup pool: slot 1 — Smart Home Panel 2';
const RAISE_DETAIL = [
  "The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots.",
  'It first read under the sum of its slots at 23:36; the last reading at 92.2 kWh before that was at 23:35.',
  'At 23:46 slot 1 delivered 0 W while slots 2 and 3 delivered 1,083 W and 1,030 W.',
  'Slot 1 is listed as connected and reads 72%.',
  "The panel's cloud data carries no error code for slot 1 and three empty error lists.",
  'Cause not established.',
  'Backup now: 39.0 kWh of 61.4 kWh counted (63.5%).',
  'The grid is present.',
].join(' ');
const RETURN_TITLE = 'Power · Resolved: Core back in the backup pool: slot 1 — Smart Home Panel 2';
const RETURN_BODY = [
  "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 20:09; it first read under that sum at Sat 23:36, 44 h 33 min earlier.",
  'At 20:09 slot 1 delivered 874 W and read 99%.',
  'The pool percent read 47% before and 64% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
  'Backup at 20:19: 59.0 kWh of 92.2 kWh counted (64%).',
].join(' ');

/* ── Home Assistant, mocked at the HTTP layer: nothing here may reach a real host ── */
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(200, '[]').persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/'), method: () => true }).reply(200, '{}').persist();

/* ── rigs ── */
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
/** A store with PANEL pinned as the house panel (as an installed add-on has it on file) and its own pool-out files. */
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
  // The store stamps each body with EXACTLY its own time (the wall clock flows on between bodies, and a dwell of
  // "ten minutes" must not turn on the milliseconds a test spent between two feeds).
  let dataMs = Date.now();
  store.setClock(() => dataMs);
  return {
    store, logs, poolFile,
    /** One poll: the device list, then the panel's quota, at the body's own time. Synchronous: no monitor pass sees half of it. */
    feed: (b) => { setNow(b.atMs); dataMs = b.atMs; store.setDeviceList(LISTED); store.setDeviceQuota(PANEL_SN, b.body); },
  };
}
function alertRig(store: Store, opts: { name?: string; quietHours?: string; send?: (msg: Push) => void } = {}) {
  const name = opts.name ?? `m${++seq}`;
  process.env.NOTIFY_STATE_PATH = join(ROOT, `${name}-notify-state.json`);
  process.env.DIGEST_STATE_PATH = join(ROOT, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(ROOT, `${name}-cleared.json`);
  process.env.NOTIFY_QUIET_HOURS = opts.quietHours ?? '22-06';
  const logs: string[] = [];
  const pushes: Push[] = [];
  /** Every send the monitor tried, delivered or not (`opts.send` may throw: Home Assistant unreachable). */
  const attempts: Push[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: async (_cfg: unknown, msg: Push) => {
      attempts.push({ title: msg.title, body: msg.body, severity: msg.severity });
      if (opts.send) opts.send(msg);
      pushes.push({ title: msg.title, body: msg.body, severity: msg.severity });
    },
  });
  stops.push(() => mon.stop());
  const passes = () => mon.stats().evalPasses;
  return {
    mon, logs, pushes, attempts, passes, name,
    /** Every push about the pool-out alarm, fire or resolve. */
    poolPushes: () => pushes.filter((p) => /backup pool/i.test(p.title)),
    morePasses: async (n: number) => { const from = passes(); await until(() => passes() >= from + n, `${n} more passes`, logs); },
  };
}
const poolAlerts = (store: Store) => (store.get().alerts ?? []).filter((a) => a.id.startsWith('shp2-pool-out'));
const panelOf = (store: Store) => store.get().devices[PANEL_SN] as any;

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

/** Feed the loss fixture up to and including `untilIso`, asserting on each body what holds without this release. */
function feedLoss(s: ReturnType<typeof storeWith>, fromIso: string, untilIso: string): void {
  for (const b of lossBodies) {
    if (b.atMs < iso(fromIso) || b.atMs > iso(untilIso)) continue;
    s.feed(b);
    const d = panelOf(s.store);
    assert.deepEqual([d.contentNewAtMs, d.lastQuotaAtMs], [b.atMs, b.atMs], `control ${new Date(b.atMs).toISOString()}: the body is new content, stamped with its own time`);
    assert.equal(d.contentStaleSinceMs ?? null, null, `control ${new Date(b.atMs).toISOString()}: the shadow latch is clear`);
    assert.equal(d.projection.backupFullCapWh, b.atMs >= iso(LOSS.capacity.shortFromIso) ? 61440 : 92160, `control ${new Date(b.atMs).toISOString()}: the projected capacity`);
  }
}

/* ══ the loss ═══════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the 2026-11-14 loss: nothing at the 06:45Z body; at the 06:46Z body `shp2-pool-out` is published — a warning naming slot 1 — and pushed at 23:46, inside the quiet hours, word for word', async () => {
  const s = storeWith('loss');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  const r = alertRig(s.store); // quiet hours 22-06 at the site: 23:46 is inside them
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T06:45:00Z');
  await r.morePasses(3);
  // T − 1: ten minutes after the capacity fell, the streak is one reading short — and nothing is said.
  assert.equal(panelOf(s.store).projection.backupFullCapWh, 61440, 'control: the pool has read one Core short since 06:36Z');
  assert.deepEqual(poolAlerts(s.store), [], '★ not there at the 06:45Z body');
  assert.deepEqual(r.poolPushes(), []);

  feedLoss(s, '2026-11-15T06:46:00Z', '2026-11-15T06:46:00Z');
  await until(() => poolAlerts(s.store).length === 1, 'the alert in the published set', r.logs);
  const [a] = poolAlerts(s.store);
  assert.deepEqual([a.id, a.severity, a.category, a.device, a.sourceSn, a.title, a.fault], [
    'shp2-pool-out', 'warning', 'SHP2', 'Smart Home Panel 2', PANEL_SN, 'Core out of the backup pool: slot 1', 'out:1;k=1',
  ]);
  assert.equal(a.detail, RAISE_DETAIL, '★ the detail, with the grid sentence from the monitor\'s own grid verdict');

  const queued = () => r.logs.some((l) => l.startsWith('notify: queued for morning digest — "Core out of the backup pool: slot 1"'));
  await until(() => r.poolPushes().length > 0 || queued(), 'the push or the digest queue', r.logs);
  await r.morePasses(2);
  assert.deepEqual(r.poolPushes(), [{ title: RAISE_TITLE, body: RAISE_DETAIL, severity: 'warning' }], '★ pushed at 23:46, inside the quiet hours, with the full detail');
  assert.equal(queued(), false, '★ and not held for the morning digest');
  // No incident names a Core: the alarm is the panel's.
  for (const sn of CORE_SNS) assert.equal(JSON.stringify(poolAlerts(s.store)).includes(sn), false);
  // And the store said so in the log, at warn.
  assert.equal(s.logs.some((l) => l.startsWith('pool-out: RAISED (strong) — Core out of the backup pool: slot 1; first fault reading 2026-11-15T06:36:00.000Z')), true);
});

test('★★★ the quiet hours ARE in force for every other warning: a source link issue rising beside the alarm is queued for the digest, while this alarm is pushed', async () => {
  const s = storeWith('quiet');
  const linkDown = (seq: number, lost: boolean) => (lost ? lostBody : healthyBody)(seq, lost
    ? { slots: [{ pct: 72, w: 0 }, { pct: 65, w: -1107, hwConnect: 0 }, { pct: 63, w: -1061 }] }
    : { slots: [{ pct: 72, w: -710 }, { pct: 66, w: -637, hwConnect: 0 }, { pct: 63, w: -601 }] });
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  const r = alertRig(s.store);
  await r.morePasses(2);
  for (let m = 0; m <= 10; m++) s.feed({ atMs: at(m), body: linkDown(m, true) }); // 23:00–23:10 at the site
  const linkQueued = () => r.logs.some((l) => l.startsWith('notify: queued for morning digest — "Source link issue"'));
  const poolQueued = () => r.logs.some((l) => l.startsWith('notify: queued for morning digest — "Core out of the backup pool: slot 1"'));
  await until(() => linkQueued() && (r.poolPushes().length > 0 || poolQueued()), 'both alerts routed', r.logs);
  await r.morePasses(2);
  assert.equal(linkQueued(), true, 'control: a warning at 23:10 is held for the morning digest');
  assert.deepEqual(r.pushes.filter((p) => /Source link issue/.test(p.title)), [], 'control: and not pushed');
  assert.equal(r.poolPushes().length, 1, '★ pushed at 23:10, inside the same quiet hours');
  assert.equal(poolQueued(), false, '★ and not queued');
});

/* ══ the return ═════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the 2026-11-16 return: the alert stands at the 03:18Z body and leaves at the 03:19Z body; the resolve push is the return notice, word for word', async () => {
  const s = storeWith('return');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { quietHours: '' }); // the raise is not this test's subject
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T07:14:00Z');
  await until(() => r.poolPushes().length === 1, 'the raise pushed', r.logs);
  assert.equal(r.poolPushes()[0].title, RAISE_TITLE);

  // 43 hours later: the first 49 bodies of the return fixture, to 03:18Z. The capacity has read 92,160 Wh since 03:09Z.
  for (const b of returnBodies) if (b.atMs <= iso('2026-11-17T03:18:00Z')) s.feed(b);
  await r.morePasses(3);
  assert.equal(panelOf(s.store).projection.backupFullCapWh, 92160, 'control: the pool reads all three Cores again');
  assert.deepEqual(poolAlerts(s.store).map((a) => [a.id, a.title, a.severity]), [['shp2-pool-out', 'Core out of the backup pool: slot 1', 'warning']], '★ still standing at the 03:18Z body');
  assert.equal(poolAlerts(s.store)[0].detail.startsWith("The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 20:09; it first read under that sum at Sat 23:36, 44 h 33 min earlier."), true,
    'and its lead is the present reading, not the shortfall');
  assert.equal(r.poolPushes().length, 1, 'no resolve yet');

  for (const b of returnBodies) if (b.atMs === iso('2026-11-17T03:19:00Z')) s.feed(b);
  await until(() => r.poolPushes().length === 2, 'the return notice', r.logs);
  assert.deepEqual(poolAlerts(s.store), [], '★ gone at the 03:19Z body');
  assert.deepEqual(r.poolPushes()[1], { title: RETURN_TITLE, body: RETURN_BODY, severity: 'resolved' }, '★ the return notice, not the stale detail with "(condition cleared)"');
  assert.equal(r.poolPushes()[1].body.includes('(condition cleared)'), false);
  // Nothing more: the rest of the fixture adds no push and no new alert.
  for (const b of returnBodies) if (b.atMs > iso('2026-11-17T03:19:00Z')) s.feed(b);
  await r.morePasses(3);
  assert.equal(r.poolPushes().length, 2);
  assert.deepEqual(poolAlerts(s.store), []);
});

test('★★★ the return is not announced while the panel has gone dark: the vanish is held (the alert names its panel), and the notice follows the panel\'s next fresh reading', async () => {
  const s = storeWith('frozen');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { quietHours: '' });
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T07:14:00Z');
  await until(() => r.poolPushes().length === 1, 'the raise pushed', r.logs);
  for (const b of returnBodies) if (b.atMs <= iso('2026-11-17T03:18:00Z')) s.feed(b);
  await r.morePasses(2);
  assert.equal(poolAlerts(s.store).length, 1, 'standing at 03:18Z');
  // The clearing body, and in the same instant the cloud lists the panel offline: no monitor pass sees one without the other.
  const clearing = returnBodies.find((b) => b.atMs === iso('2026-11-17T03:19:00Z'))!;
  s.feed(clearing);
  s.store.setDeviceList(OFFLINE);
  await r.morePasses(5);
  assert.deepEqual(poolAlerts(s.store), [], 'control: the tracker ended the episode (the alert left the set)');
  assert.equal(r.poolPushes().length, 1, '★ no return notice while the panel is offline: its absence is not evidence');
  // The panel is back with a fresh reading: the falling edge proceeds, and the notice is sent.
  s.feed(returnBodies.find((b) => b.atMs === iso('2026-11-17T03:20:00Z'))!);
  await until(() => r.poolPushes().length === 2, 'the return notice', r.logs);
  assert.equal(r.poolPushes()[1].title, RETURN_TITLE);
});

/* ══ severity ═══════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ the grid: two panel readings of "no grid" hold the warning; the third makes it critical and re-pushes; three readings of "grid OK" bring it back to a warning', async () => {
  const s = storeWith('grid');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { quietHours: '' });
  for (let m = 0; m <= 10; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the warning pushed', r.logs);
  assert.equal(poolAlerts(s.store)[0].severity, 'warning');

  for (let m = 11; m <= 12; m++) s.feed({ atMs: at(m), body: lostBody(m, { gridSta: 0 }) });
  await r.morePasses(3);
  assert.equal(poolAlerts(s.store)[0].severity, 'warning', '★ two readings: still a warning');
  assert.equal(r.poolPushes().length, 1);

  s.feed({ atMs: at(13), body: lostBody(13, { gridSta: 0 }) });
  await until(() => r.poolPushes().length === 2, 'the escalation pushed', r.logs);
  const [a] = poolAlerts(s.store);
  assert.deepEqual([a.id, a.severity, a.title, a.fault], ['shp2-pool-out', 'critical', 'Core out of the backup pool: slot 1', 'out:1;k=1'], '★ the same alert, escalated: same id, title and fault');
  assert.equal(r.poolPushes()[1].title, 'Power · [Critical] Core out of the backup pool: slot 1 — Smart Home Panel 2');
  assert.equal(r.poolPushes()[1].severity, 'critical');
  assert.match(r.poolPushes()[1].body, /^The panel's backup capacity reads 61\.4 kWh: 30\.7 kWh, the capacity of 1 slot, under the 92\.2 kWh of its 3 slots\. The panel reported no grid at 23:13\. /);

  for (let m = 14; m <= 16; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => poolAlerts(s.store)[0]?.severity === 'warning', 'back to a warning', r.logs);
  await r.morePasses(3);
  assert.equal(r.poolPushes().length, 2, 'a de-escalation is not a new push');
  assert.equal(r.pushes.some((p) => /Resolved: Core/.test(p.title)), false, 'and not a "Resolved"');
});

/* ══ a push that fails ══════════════════════════════════════════════════════════════════════════════ */

const digests = (r: ReturnType<typeof alertRig>) => r.pushes.filter((p) => /Morning digest/.test(p.title));
const digestFile = (r: ReturnType<typeof alertRig>): { queue: Array<{ id: string }> } => JSON.parse(readFileSync(join(ROOT, `${r.name}-digest.json`), 'utf8'));
const notifyRecord = (name: string): any => JSON.parse(readFileSync(join(ROOT, `${name}-notify-state.json`), 'utf8'))['shp2-pool-out'];

test('★★★ the push of the raise FAILS twice (Home Assistant unreachable at 23:46): it is tried again after 20 s and then after 40 s, and arrives with its whole detail — not at 07:00 as a title in the digest', async () => {
  const s = storeWith('fail');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  let failures = 0;
  const r = alertRig(s.store, { send: (msg) => { if (/Core out of the backup pool/.test(msg.title) && failures < 2) { failures += 1; throw new Error('HA unreachable (test)'); } } });
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T06:46:00Z');
  const tries = () => r.attempts.filter((p) => /Core out of the backup pool/.test(p.title));
  await until(() => tries().length >= 1, 'the first attempt', r.logs);
  const firstAt = Date.now();
  assert.equal(r.logs.some((l) => l === 'notify: WARNING — send failed for "[High] Core out of the backup pool: slot 1 — Smart Home Panel 2" — HA unreachable (test); it will be tried again, after 20 s and then at doubling waits up to 10 min'), true,
    'control: the first send failed, and the line says what follows');
  // No new body: the same standing alarm, the next passes of the monitor. Inside the wait nothing more is sent.
  await r.morePasses(5);
  assert.equal(tries().length, 1, '★ not tried again at every pass');
  assert.deepEqual(digestFile(r).queue.map((q) => q.id), ['shp2-pool-out'], 'control: held for the digest meanwhile (the condition may clear before a retry)');
  // Twenty seconds after the failure: the second try. It fails too, and the next wait is forty seconds.
  setNow(firstAt + 20_000);
  await until(() => tries().length === 2, 'the second attempt', r.logs);
  const secondAt = Date.now();
  await r.morePasses(3);
  setNow(secondAt + 30_000);
  await r.morePasses(3);
  assert.equal(tries().length, 2, '★ 30 s after the second failure: still waiting');
  setNow(secondAt + 40_000);
  await until(() => r.poolPushes().length === 1, 'the third try delivered', r.logs);
  assert.equal(tries().length, 3, '★ tried a third time, and delivered');
  assert.deepEqual(r.poolPushes(), [{ title: RAISE_TITLE, body: RAISE_DETAIL, severity: 'warning' }], '★ the full detail reached the phone, inside the quiet hours');
  await r.morePasses(3);
  assert.equal(tries().length, 3, 'and it is not sent a fourth time');
  assert.equal(r.logs.filter((l) => l.startsWith('notify: held "Core out of the backup pool: slot 1" for the morning digest')).length, 1, '★ the hold for the digest is said once, not at each failed try');
  // Delivered: it is no longer owed to the digest, in memory or on file.
  assert.equal(r.mon.stats().quietQueued, 0, '★ out of the digest queue');
  assert.deepEqual(digestFile(r).queue, [], '★ and out of the file a restart would restore it from');
  assert.deepEqual([notifyRecord(r.name).sent, notifyRecord(r.name).sourceSn], [true, PANEL_SN]);
  // 07:00 at the site, the alarm still standing: whatever the digest sends, it does not list this alarm again.
  s.feed({ atMs: iso('2026-11-15T14:00:30Z'), body: lostBody(6000) });
  await until(() => r.logs.some((l) => /morning digest/.test(l) && !/held "|queued for/.test(l)), 'the digest hour handled', r.logs);
  await r.morePasses(2);
  assert.deepEqual(r.pushes.filter((p) => /digest/i.test(p.title) && /Core out of the backup pool/.test(p.body)), [], '★ the digest does not carry it: it was delivered');
  assert.equal(r.poolPushes().length, 1);
});

test('★★★ a push that failed once and was then delivered is not in the 07:00 digest AFTER A RESTART either, and the record of it keeps its panel', async () => {
  const s = storeWith('once');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  let failures = 0;
  const r = alertRig(s.store, { name: 'once-mon', send: (msg) => { if (/Core out of the backup pool/.test(msg.title) && failures < 1) { failures += 1; throw new Error('HA unreachable (test)'); } } });
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T06:46:00Z');
  await until(() => r.attempts.some((p) => /Core out of the backup pool/.test(p.title)), 'the first attempt', r.logs);
  // The next poll, a minute later: the retry is due and is delivered.
  s.feed({ atMs: iso('2026-11-15T06:47:00Z'), body: lostBody(5001) });
  await until(() => r.poolPushes().length === 1, 'the retry delivered', r.logs);
  await r.morePasses(2);
  assert.deepEqual(digestFile(r).queue, [], '★ the file a restart restores the digest queue from no longer lists it');
  r.mon.stop();

  // A restart at 02:00 (a deploy at any hour), the same files; the Core is still out.
  setNow(iso('2026-11-15T09:00:00Z'));
  const b = storeWith('once-b', { poolFile: s.poolFile });
  b.feed({ atMs: iso('2026-11-15T09:00:00Z'), body: lostBody(7000) });
  b.store.markFirstPollSettled();
  const rb = alertRig(b.store, { name: 'once-mon' });
  for (let m = 1; m <= 12; m++) { b.feed({ atMs: iso('2026-11-15T09:00:00Z') + m * MIN, body: lostBody(7000 + m) }); if (m % 4 === 0) await rb.morePasses(1); }
  await rb.morePasses(2);
  assert.equal(poolAlerts(b.store).length, 1, 'control: the alarm stands in the second process');
  assert.deepEqual(rb.poolPushes(), [], 'control: and is not pushed again');
  // 07:00: the digest hour.
  b.feed({ atMs: iso('2026-11-15T14:00:30Z'), body: lostBody(8000) });
  await until(() => rb.logs.some((l) => l.startsWith('notify: morning digest')), 'the digest hour handled', rb.logs);
  await rb.morePasses(2);
  assert.deepEqual(digests(rb), [], '★ no digest lists it as "held overnight": it was delivered at 23:47');
  assert.equal(rb.logs.some((l) => l === 'notify: morning digest — queue empty, nothing held overnight; no digest sent'), true);
  assert.deepEqual([notifyRecord('once-mon').sent, notifyRecord('once-mon').sourceSn], [true, PANEL_SN], '★ the record still names its panel (the boot sweep asks that panel\'s tracker)');
});

test('★★★ the push channel is DOWN for half an hour from the raise: a handful of tries at doubling waits — not one at every pass — and one delivery when it is back', async () => {
  const s = storeWith('down');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  let down = true;
  const r = alertRig(s.store, { send: (msg) => { if (down && /Core out of the backup pool/.test(msg.title)) throw new Error('HA unreachable (test)'); } });
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T06:46:00Z');
  const tries = () => r.attempts.filter((p) => /Core out of the backup pool/.test(p.title));
  await until(() => tries().length >= 1, 'the first attempt', r.logs);
  const p0 = r.passes();
  // Thirty polls a minute apart, the channel down throughout, three or more passes of the monitor at each.
  for (let m = 1; m <= 30; m++) { s.feed({ atMs: iso('2026-11-15T06:46:00Z') + m * MIN, body: lostBody(5000 + m) }); await r.morePasses(3); }
  const passes = r.passes() - p0;
  assert.equal(passes >= 90, true, `control: ${passes} passes`);
  // The waits are 20 s, 40 s, 80 s, 160 s, 320 s and then 10 min: tries at about minutes 0, 1, 2, 4, 7, 13 and 23.
  assert.equal(tries().length >= 6 && tries().length <= 8, true, `★ ${tries().length} tries in ${passes} passes (one a pass was ${passes + 1})`);
  assert.equal(r.logs.filter((l) => /send failed for .*Core out of the backup pool/.test(l)).length, tries().length, 'one failure line a try');
  assert.equal(r.logs.filter((l) => l.startsWith('notify: held "Core out of the backup pool: slot 1" for the morning digest')).length, 1);
  assert.deepEqual(r.poolPushes(), [], 'control: nothing delivered yet');
  // The channel is back; the next try is at most ten minutes away.
  down = false;
  const before = tries().length;
  s.feed({ atMs: iso('2026-11-15T06:46:00Z') + 41 * MIN, body: lostBody(5041) });
  await until(() => r.poolPushes().length === 1, 'the delivery once the channel is back', r.logs);
  assert.equal(tries().length, before + 1, '★ delivered at the first try after it');
  assert.equal(r.poolPushes()[0].body.includes('Backup now:'), true, 'with its whole detail');
  for (let m = 42; m <= 46; m++) { s.feed({ atMs: iso('2026-11-15T06:46:00Z') + m * MIN, body: lostBody(5000 + m) }); await r.morePasses(2); }
  assert.equal(tries().length, before + 1, 'and once');
});

test('★★★ the 07:00 digest goes out while this alarm\'s own push is still failing: the digest names it, and the push it is owed — the whole detail — follows at the next pass, not after the rest of its wait', async () => {
  const s = storeWith('owed');
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  // Home Assistant refuses this alarm's push all night; the digest's own send goes through, and from then on so does everything.
  let down = true;
  const r = alertRig(s.store, { send: (msg) => { if (/Morning digest/.test(msg.title)) { down = false; return; } if (down && /Core out of the backup pool/.test(msg.title)) throw new Error('HA unreachable (test)'); } });
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T06:46:00Z');
  await until(() => r.attempts.some((p) => /Core out of the backup pool/.test(p.title)), 'the first attempt', r.logs);
  assert.deepEqual(r.poolPushes(), [], 'control: not delivered');
  // 07:00 at the site, the alarm still standing.
  s.feed({ atMs: iso('2026-11-15T14:00:30Z'), body: lostBody(6000) });
  await until(() => digests(r).length === 1, 'the digest', r.logs);
  assert.match(digests(r)[0].body, /Held during overnight quiet hours:\n\n• \[High\] Core out of the backup pool: slot 1 \(Smart Home Panel 2\)/, 'control: the digest lists it, a title and nothing else');
  // The digest line does not stand in for the push: it follows at once.
  await until(() => r.poolPushes().length === 1, 'the push it was owed', r.logs, 5_000);
  assert.equal(r.poolPushes()[0].title, RAISE_TITLE);
  assert.equal(r.poolPushes()[0].body.startsWith("The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots."), true, '★ with its detail');
  await r.morePasses(3);
  assert.equal(r.poolPushes().length, 1, 'once');
  assert.deepEqual([notifyRecord(r.name).sent, notifyRecord(r.name).sourceSn], [true, PANEL_SN], '★ and the record of it names its panel');
});

test('★★ an ESCALATION whose push fails waits too: the critical is tried again after 20 s, not at every pass, and is delivered', async () => {
  const s = storeWith('esc');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  let down = false;
  const r = alertRig(s.store, { quietHours: '', send: (msg) => { if (down && /Core out of the backup pool/.test(msg.title)) throw new Error('HA unreachable (test)'); } });
  for (let m = 0; m <= 10; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the warning pushed', r.logs);
  // The grid goes, and Home Assistant with it: three readings of "no grid" make the alarm critical.
  down = true;
  for (let m = 11; m <= 13; m++) s.feed({ atMs: at(m), body: lostBody(m, { gridSta: 0 }) });
  const crit = () => r.attempts.filter((p) => /\[Critical\] Core out of the backup pool/.test(p.title));
  await until(() => crit().length >= 1, 'the escalation tried', r.logs);
  const firstAt = Date.now();
  assert.equal(poolAlerts(s.store)[0].severity, 'critical', 'control');
  await r.morePasses(6);
  assert.equal(crit().length, 1, '★ not tried again at every pass');
  down = false;
  await r.morePasses(3);
  assert.equal(crit().length, 1, 'still inside its wait, though the channel is back');
  setNow(firstAt + 20_000);
  await until(() => r.poolPushes().length === 2, 'the critical delivered', r.logs);
  assert.deepEqual([crit().length, r.poolPushes()[1].title, r.poolPushes()[1].severity], [2, 'Power · [Critical] Core out of the backup pool: slot 1 — Smart Home Panel 2', 'critical']);
  await r.morePasses(3);
  assert.equal(crit().length, 2, 'once');
});

/* ══ a second loss ══════════════════════════════════════════════════════════════════════════════════ */

/** Slot 2 out, the shape of slot 1's loss: one Core's capacity short, slot 2 at 0 W, the pool the mean of slots 1 and 3. */
const slot2Out = (seq: number): Body => fx.synthBody({ seq, capWh: 2 * fx.SLOT_WH, slots: [{ pct: 70, w: -1100 }, { pct: 66, w: 0 }, { pct: 61, w: -1050 }], poolPct: 65.5 });

test('★★★ a SECOND loss in one night: slot 1 out at 23:10 and back at 23:23 (its notice waiting for the quiet hours), slot 2 out at 01:00 — the second alarm is pushed, at night, as a new one', async () => {
  const s = storeWith('again');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { name: 'again-mon' }); // quiet hours 22-06
  for (let m = 0; m <= 12; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the first raise pushed', r.logs);
  for (let m = 13; m <= 26; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  await until(() => poolAlerts(s.store).length === 0, 'the first alarm ended', r.logs);
  await r.morePasses(3);
  assert.deepEqual(r.poolPushes().map((p) => p.title), [RAISE_TITLE], 'control: inside the quiet hours the return notice is not sent yet');
  assert.equal(notifyRecord('again-mon').title, 'Core out of the backup pool: slot 1', 'control: and the record of the first push stands');

  // 01:00: slot 2 goes out. Ten minutes of readings later the tracker raises a new alarm.
  for (let m = 120; m <= 131; m++) { s.feed({ atMs: at(m), body: slot2Out(m) }); if (m % 4 === 0) await r.morePasses(1); }
  await until(() => poolAlerts(s.store).length === 1, 'the second alarm in the set', r.logs);
  assert.deepEqual(poolAlerts(s.store).map((a) => [a.id, a.title]), [['shp2-pool-out', 'Core out of the backup pool: slot 2']], 'control');
  await until(() => r.poolPushes().length === 2, 'the second alarm pushed', r.logs);
  assert.equal(r.poolPushes()[1].title, 'Power · [High] Core out of the backup pool: slot 2 — Smart Home Panel 2', '★ pushed at 01:10, naming slot 2');
  assert.match(r.poolPushes()[1].body, /^The panel's backup capacity reads 61\.4 kWh: .* It first read under the sum of its slots at 01:00; the last reading at 92\.2 kWh before that was at Sat 23:26\. At 01:10 slot 2 delivered 0 W while slots 1 and 3 delivered 1,100 W and 1,050 W\./);
  assert.equal(r.logs.some((l) => l === `notify: "Core out of the backup pool: slot 2" is a new alarm — the one on record ended at ${new Date(at(23)).toISOString()} (its notice was still waiting); this one is pushed`), true, r.logs.filter((l) => /new alarm/.test(l)).join('\n'));
  await r.morePasses(3);
  assert.equal(r.poolPushes().length, 2, 'once');
  assert.equal(notifyRecord('again-mon').title, 'Core out of the backup pool: slot 2', 'the record is the second push\'s');
  // 06:01: the quiet hours are over and the second alarm stands. No "Resolved" is sent for the first.
  for (let m = 421; m <= 425; m++) { s.feed({ atMs: at(m), body: slot2Out(m) }); await r.morePasses(2); }
  assert.deepEqual(r.poolPushes().map((p) => p.severity), ['warning', 'warning'], '★ nothing resolved while a Core is out');
  // Slot 2 returns: its card is owed its dismissal, and gets the return notice.
  for (let m = 426; m <= 437; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  await until(() => r.poolPushes().length === 3, 'the return notice of the second alarm', r.logs);
  assert.deepEqual([r.poolPushes()[2].title, r.poolPushes()[2].severity], ['Power · Resolved: Core back in the backup pool: slot 2 — Smart Home Panel 2', 'resolved']);
});

test('★★★ the same across a RESTART: the first alarm ended before it (its notice waiting), the second is raised after it — the record of the first push does not keep the second from being pushed', async () => {
  const s = storeWith('again2');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { name: 'again2-mon' }); // quiet hours 22-06
  for (let m = 0; m <= 12; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the first raise pushed', r.logs);
  for (let m = 13; m <= 26; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  await until(() => poolAlerts(s.store).length === 0, 'the first alarm ended', r.logs);
  await r.morePasses(2);
  r.mon.stop();

  // A restart at 00:30, the same files. The pool is whole until 01:00, when slot 2 goes out.
  setNow(at(90));
  const b = storeWith('again2-b', { poolFile: s.poolFile });
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const rb = alertRig(b.store, { name: 'again2-mon' });
  for (let m = 91; m <= 119; m++) { b.feed({ atMs: at(m), body: healthyBody(m) }); if (m % 7 === 0) await rb.morePasses(1); }
  await rb.morePasses(2);
  assert.deepEqual(rb.poolPushes(), [], 'control: nothing is sent in the quiet hours (the boot sweep waits for them to end)');
  assert.equal(notifyRecord('again2-mon').title, 'Core out of the backup pool: slot 1', 'control: the record of the first push is on file');
  for (let m = 120; m <= 131; m++) { b.feed({ atMs: at(m), body: slot2Out(m) }); if (m % 4 === 0) await rb.morePasses(1); }
  await until(() => poolAlerts(b.store).length === 1, 'the second alarm in the set', rb.logs);
  await until(() => rb.poolPushes().length === 1, 'the second alarm pushed', rb.logs);
  assert.equal(rb.poolPushes()[0].title, 'Power · [High] Core out of the backup pool: slot 2 — Smart Home Panel 2', '★ pushed by the process that did not see the first one end');
  assert.equal(rb.logs.some((l) => /already has a notification on record/.test(l) && /backup pool/.test(l)), false);
  await rb.morePasses(3);
  assert.equal(rb.poolPushes().length, 1, 'once');
  // 06:01 with the second alarm standing: the boot sweep finds no orphan to resolve.
  for (let m = 421; m <= 425; m++) { b.feed({ atMs: at(m), body: slot2Out(m) }); await rb.morePasses(2); }
  assert.equal(rb.pushes.some((p) => /Resolved/.test(p.title)), false, '★ no "Resolved" while a Core is out');
});

test('★★ the second alarm\'s own push never goes out (Home Assistant is down) and it ends: the card the FIRST alarm put on the phone is still owed its dismissal, and gets it', async () => {
  const s = storeWith('card');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  let down = false;
  const r = alertRig(s.store, { name: 'card-mon', send: (msg) => { if (down && /Core out of the backup pool/.test(msg.title)) throw new Error('HA unreachable (test)'); } }); // quiet hours 22-06
  for (let m = 0; m <= 12; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the first raise pushed', r.logs);
  for (let m = 13; m <= 26; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  await until(() => poolAlerts(s.store).length === 0, 'the first alarm ended', r.logs);
  await r.morePasses(2);
  // 01:00: slot 2 out, and Home Assistant refuses the push of it.
  down = true;
  for (let m = 120; m <= 131; m++) { s.feed({ atMs: at(m), body: slot2Out(m) }); if (m % 4 === 0) await r.morePasses(1); }
  await until(() => r.attempts.some((p) => /slot 2/.test(p.title)), 'the second alarm tried', r.logs);
  // 01:12: slot 2 is back; ten minutes later the second alarm ends, never delivered.
  for (let m = 132; m <= 146; m++) { s.feed({ atMs: at(m), body: healthyBody(m) }); if (m % 4 === 0) await r.morePasses(1); }
  await until(() => poolAlerts(s.store).length === 0, 'the second alarm ended', r.logs);
  await r.morePasses(2);
  assert.deepEqual(r.poolPushes().map((p) => p.title), [RAISE_TITLE], 'control: the only thing on the phone is the first alarm\'s card');
  down = false;
  // 06:01: the quiet hours are over.
  for (let m = 421; m <= 425; m++) { s.feed({ atMs: at(m), body: healthyBody(m) }); await r.morePasses(2); }
  await until(() => r.poolPushes().length === 2, 'the dismissal of the card', r.logs);
  assert.deepEqual([r.poolPushes()[1].title, r.poolPushes()[1].severity], ['Power · Resolved: Core back in the backup pool: slot 2 — Smart Home Panel 2', 'resolved'], '★ resolved, with the return notice of the newest end');
});

/* ══ restarts ═══════════════════════════════════════════════════════════════════════════════════════ */

/** The first process: the loss raised and pushed, its state, notify record and onset on file. */
async function firstProcess(name: string) {
  const s = storeWith(name);
  feedLoss(s, '2026-11-15T06:00:00Z', '2026-11-15T06:00:00Z');
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { name: `${name}-mon`, quietHours: '' });
  feedLoss(s, '2026-11-15T06:01:00Z', '2026-11-15T06:50:00Z');
  await until(() => r.poolPushes().length === 1, 'the raise pushed', r.logs);
  await r.morePasses(2);
  const record = JSON.parse(readFileSync(join(ROOT, `${name}-mon-notify-state.json`), 'utf8'))['shp2-pool-out'];
  assert.deepEqual([record.sent, record.sev, record.title, record.sourceSn], [true, 'warning', 'Core out of the backup pool: slot 1', PANEL_SN], 'control: the push is on record, with its panel');
  r.mon.stop();
  return { s, r };
}

test('★★★ a restart: the standing alarm is in the set at the FIRST pass, before any body arrives — no second push, and the boot sweep sends no "Resolved"', async () => {
  const first = await firstProcess('restart');
  const stoodAt = iso('2026-11-15T06:50:00Z');

  // The second process, seven minutes later: the same files; the panel listed, no body yet.
  setNow(stoodAt + 7 * MIN);
  const b = storeWith('restart-b', { poolFile: first.s.poolFile });
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  assert.equal(panelOf(b.store).projection, undefined, 'control: no body has arrived in this process');
  const r = alertRig(b.store, { name: 'restart-mon', quietHours: '' });
  await until(() => r.passes() >= 1, 'the first pass', r.logs);
  assert.deepEqual(poolAlerts(b.store).map((a) => [a.id, a.severity, a.title, a.fault, a.sourceSn]), [['shp2-pool-out', 'warning', 'Core out of the backup pool: slot 1', 'out:1;k=1', PANEL_SN]],
    '★ present at the first pass: restored, not re-detected');
  assert.match(poolAlerts(b.store)[0].detail, /^The panel's backup capacity reads 61\.4 kWh: .* No new panel reading since 23:50\.$/, 'and it says its newest reading is from before the restart');
  assert.equal(r.logs.some((l) => l === 'alerts: "shp2-pool-out" re-tracked across a restart — not counting a rise (condition predates this process)'), true);

  // The polls resume; eleven minutes after the restart the boot sweep runs.
  for (let m = 8; m <= 19; m++) b.feed({ atMs: stoodAt + m * MIN, body: lostBody(7000 + m) });
  await until(() => r.logs.some((l) => l.includes('boot reconcile')), 'the boot reconcile', r.logs);
  await r.morePasses(2);
  assert.deepEqual(r.poolPushes(), [], '★ no new push for the same episode, and no "Resolved"');
  assert.equal(poolAlerts(b.store).length, 1, 'still standing');
  assert.equal(b.logs.some((l) => /RAISED|streak started/.test(l)), false, 'the tracker did not raise again: it never stopped');
});

test('★★★ a restart between the raise and its push: the restored alarm has no notification on record, so it is pushed — once, at night too — and not taken as already announced', async () => {
  // The first process raised at the 06:46Z body and saved the episode at once; it stopped before any monitor pass sent
  // the push (the monitor waits out its debounce first). So: the episode on file, and no notify record.
  const a = storeWith('unpushed');
  feedLoss(a, '2026-11-15T06:00:00Z', '2026-11-15T06:46:00Z');
  assert.equal(a.store.poolOutAlerts(iso('2026-11-15T06:46:00Z')).get(PANEL_SN)?.title, 'Core out of the backup pool: slot 1', 'control: raised in the first process');
  assert.equal(JSON.parse(readFileSync(a.poolFile, 'utf8')).panels[PANEL_SN].episode.raisedAtMs, iso('2026-11-15T06:46:00Z'), 'control: and on file');

  // The second process, one minute later (23:47 at the site, inside the quiet hours): the same state file, a notify
  // state with nothing in it, the panel listed and no body yet.
  setNow(iso('2026-11-15T06:47:00Z'));
  const b = storeWith('unpushed-b', { poolFile: a.poolFile });
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const r = alertRig(b.store, { name: 'unpushed-mon' });
  assert.equal(existsSync(join(ROOT, 'unpushed-mon-notify-state.json')), false, 'control: no notification is on record');
  await until(() => r.passes() >= 1, 'the first pass', r.logs);
  assert.deepEqual(poolAlerts(b.store).map((x) => [x.id, x.title]), [['shp2-pool-out', 'Core out of the backup pool: slot 1']], 'control: restored, in the set at the first pass');

  const queued = () => r.logs.some((l) => l.startsWith('notify: queued for morning digest — "Core out of the backup pool: slot 1"'));
  await until(() => r.poolPushes().length > 0 || queued(), 'the push it is owed (or its place in the digest queue)', r.logs);
  assert.deepEqual(r.poolPushes().map((p) => [p.title, p.severity]), [[RAISE_TITLE, 'warning']], '★ pushed by the process that restored it, at 23:47');
  assert.equal(r.poolPushes()[0].body.startsWith("The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots."), true, 'with its detail');
  assert.equal(queued(), false);
  // Once: the polls resume, the alarm stands, and nothing more is sent.
  for (let m = 2; m <= 6; m++) b.feed({ atMs: iso('2026-11-15T06:46:00Z') + m * MIN, body: lostBody(9000 + m) });
  await r.morePasses(4);
  assert.equal(r.poolPushes().length, 1, '★ and only once');
  assert.equal(poolAlerts(b.store).length, 1, 'still standing');
});

test('★★★ a restart with the state file LOST while the Core is still out: the boot sweep holds its "Resolved" (the tracker has neither raised nor seen a clean dwell), the alarm returns after its dwell, and nothing is pushed twice', async () => {
  await firstProcess('lost');
  const stoodAt = iso('2026-11-15T06:50:00Z');

  setNow(stoodAt + 2 * MIN);
  const bootAt = stoodAt + 2 * MIN;
  const b = storeWith('lost-b'); // a fresh state file: the first process's is gone
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const r = alertRig(b.store, { name: 'lost-mon', quietHours: '' });
  await until(() => r.passes() >= 2, 'two passes', r.logs);
  assert.deepEqual(poolAlerts(b.store), [], 'control: with no state on file the alarm is absent after the restart');

  // Minutes 9, 10 and 11 after the restart: three readings one Core short. The panel is FRESH; the tracker has three of
  // the six readings and two of the ten minutes it needs. The boot sweep runs here (ten minutes after boot).
  for (const m of [9, 10, 11]) b.feed({ atMs: bootAt + m * MIN, body: lostBody(8000 + m) });
  await until(() => r.logs.some((l) => l.includes('boot reconcile')), 'the boot reconcile', r.logs);
  await r.morePasses(2);
  assert.deepEqual(poolAlerts(b.store), [], 'control: still absent at the sweep');
  assert.equal(panelOf(b.store).online && Date.now() - panelOf(b.store).lastUpdated < 2 * MIN, true, 'control: the panel is online with fresh data, so the evidence gate alone would let the sweep resolve');
  assert.deepEqual(r.poolPushes(), [], '★ no "Resolved: Core out of the backup pool" on a lost file');
  assert.equal(r.logs.some((l) => l === 'notify: orphan resolve HELD — "Core out of the backup pool: slot 1" (the pool-out tracker has neither raised nor seen a full dwell of healthy capacity across every slot since the restart, and holds no end of this alarm on file; not a recovery)'), true,
    r.logs.filter((l) => l.includes('orphan')).join('\n'));

  // The dwell completes: six readings over ten minutes. The alarm is back, under the same id, and its card stands.
  for (let m = 12; m <= 19; m++) b.feed({ atMs: bootAt + m * MIN, body: lostBody(8000 + m) });
  await until(() => poolAlerts(b.store).length === 1, 'the alarm raised again', r.logs);
  await r.morePasses(3);
  assert.deepEqual(poolAlerts(b.store).map((a) => [a.id, a.title]), [['shp2-pool-out', 'Core out of the backup pool: slot 1']]);
  assert.deepEqual(r.poolPushes(), [], '★ not pushed a second time (its notification is on record), and never resolved');
  assert.equal(b.logs.some((l) => l.startsWith('pool-out: RAISED (strong)')), true, 'control: this process raised it');
});

test('★★ a restart with the state file lost after the Core has RETURNED: the hold ends once thirty minutes of healthy capacity are seen, and the stale card is resolved', async () => {
  await firstProcess('healed');
  const stoodAt = iso('2026-11-15T06:50:00Z');
  setNow(stoodAt + 2 * MIN);
  const bootAt = stoodAt + 2 * MIN;
  const b = storeWith('healed-b');
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const r = alertRig(b.store, { name: 'healed-mon', quietHours: '' });
  // Healthy readings from the first minute. At the sweep (minute 11) the tracker has seen eleven of the thirty minutes.
  for (let m = 1; m <= 11; m++) b.feed({ atMs: bootAt + m * MIN, body: healthyBody(8500 + m) });
  await until(() => r.logs.some((l) => l.includes('orphan resolve HELD')), 'the hold', r.logs);
  assert.deepEqual(r.poolPushes(), [], 'held at minute 11');
  for (let m = 12; m <= 31; m++) b.feed({ atMs: bootAt + m * MIN, body: healthyBody(8500 + m) });
  await until(() => r.poolPushes().length === 1, 'the stale card resolved', r.logs);
  assert.deepEqual(r.poolPushes(), [{ title: 'Power · Resolved: Core out of the backup pool: slot 1', body: 'Core out of the backup pool: slot 1\n\n(condition cleared while the add-on was restarting)', severity: 'resolved' }],
    '★ resolved on evidence seen in this process: thirty minutes and eighteen readings at the full capacity');
  assert.deepEqual(poolAlerts(b.store), []);
});

test('★★★ a restart while the return notice waits for the quiet hours to end: what is sent afterwards is the RETURN NOTICE, from the end record on file — not "cleared while the add-on was restarting"', async () => {
  const s = storeWith('ret');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) }); // 22:45–22:59 at the site
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { name: 'ret-mon' }); // quiet hours 22-06
  for (let m = 0; m <= 12; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the raise pushed (at night)', r.logs);
  // The Core is back at 23:13; ten minutes of readings with slot 1 carrying its share end the alarm at 23:23.
  for (let m = 13; m <= 26; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  await until(() => poolAlerts(s.store).length === 0, 'the alarm ended', r.logs);
  await r.morePasses(3);
  assert.equal(r.poolPushes().length, 1, 'control: inside the quiet hours the resolve is not sent yet');
  assert.deepEqual(JSON.parse(readFileSync(s.poolFile, 'utf8')).panels[PANEL_SN].ends.map((e: any) => [e.kind, e.atMs]), [['returned', at(23)]], 'control: the end is on file');
  r.mon.stop();

  // A restart at 02:00 (a deploy at any hour), the same files; the pool stays whole.
  setNow(at(180));
  const b = storeWith('ret-b', { poolFile: s.poolFile });
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const rb = alertRig(b.store, { name: 'ret-mon' });
  for (let m = 181; m <= 225; m++) { b.feed({ atMs: at(m), body: healthyBody(m) }); if (m % 5 === 0) await rb.morePasses(1); }
  await rb.morePasses(3);
  assert.deepEqual(rb.poolPushes(), [], 'control: 45 minutes after the restart, still inside the quiet hours, nothing is sent');
  // 06:01 at the site: the quiet hours are over, and the boot sweep resolves the card.
  for (let m = 421; m <= 425; m++) { b.feed({ atMs: at(m), body: healthyBody(m) }); await rb.morePasses(2); }
  await until(() => rb.poolPushes().length === 1, 'the resolve after the quiet hours', rb.logs);
  assert.deepEqual(rb.poolPushes(), [{
    title: 'Power · Resolved: Core back in the backup pool: slot 1',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since Sat 23:13; it first read under that sum at Sat 23:00, 13 min earlier.",
      'At Sat 23:13 slot 1 delivered 710 W and read 72%.',
      'The pool percent read 64% before and 67% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
      'Backup at Sat 23:23: 61.7 kWh of 92.2 kWh counted (67%).',
    ].join(' '),
    severity: 'resolved',
  }], '★ the return notice, every figure with its day');
  assert.equal(rb.poolPushes()[0].body.includes('while the add-on was restarting'), false);
});

test('★★★ a panel with an EMPTY slot (two Cores in three), a restart while the return notice waits: its roster can never earn the clean dwell, and the end on file releases the hold — the return notice is sent, not dropped after six hours', async () => {
  const twoCores = (seq: number): Body => fx.synthBody({ seq, capWh: 2 * fx.SLOT_WH, poolPct: 60, slots: [{ pct: 62, w: -800 }, { pct: 58, w: -760 }, { isConnect: 0, hwConnect: 0, fullCap: 0, pct: 0, w: 0 }] });
  const oneOfTwo = (seq: number): Body => fx.synthBody({ seq, capWh: fx.SLOT_WH, poolPct: 58, slots: [{ pct: 62, w: 0 }, { pct: 58, w: -1560 }, { isConnect: 0, hwConnect: 0, fullCap: 0, pct: 0, w: 0 }] });
  const s = storeWith('two');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: twoCores(m) }); // 22:45–22:59 at the site
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { name: 'two-mon' }); // quiet hours 22-06
  for (let m = 0; m <= 12; m++) s.feed({ atMs: at(m), body: oneOfTwo(m) });
  await until(() => r.poolPushes().length === 1, 'the raise pushed (at night)', r.logs);
  assert.equal(r.poolPushes()[0].title, RAISE_TITLE);
  assert.equal(s.logs.some((l) => l === 'pool-out: reference adopted — slots 1 and 2, 61.4 kWh.'), true, 'control: a reference of two slots');
  for (let m = 13; m <= 26; m++) s.feed({ atMs: at(m), body: twoCores(m) });
  await until(() => poolAlerts(s.store).length === 0, 'the alarm ended', r.logs);
  await r.morePasses(3);
  assert.equal(r.poolPushes().length, 1, 'control: inside the quiet hours the resolve is not sent yet');
  r.mon.stop();

  // A restart at 02:00, the state file INTACT; the pool stays whole on its two Cores.
  setNow(at(180));
  const b = storeWith('two-b', { poolFile: s.poolFile });
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const rb = alertRig(b.store, { name: 'two-mon' });
  for (let m = 181; m <= 225; m++) { b.feed({ atMs: at(m), body: twoCores(m) }); if (m % 5 === 0) await rb.morePasses(1); }
  await rb.morePasses(3);
  assert.deepEqual(rb.poolPushes(), [], 'control: still inside the quiet hours');
  assert.equal(b.store.poolOutOrphanReleased(PANEL_SN), false, 'control: forty-five minutes of whole capacity on two slots of three earn no clean dwell');
  // 06:01 at the site: the quiet hours are over, and the boot sweep resolves the card with the return notice.
  for (let m = 421; m <= 425; m++) { b.feed({ atMs: at(m), body: twoCores(m) }); await rb.morePasses(2); }
  await until(() => rb.poolPushes().length === 1, 'the resolve after the quiet hours', rb.logs);
  assert.deepEqual(rb.poolPushes(), [{
    title: 'Power · Resolved: Core back in the backup pool: slot 1',
    body: [
      "The panel's backup capacity has read 61.4 kWh, the sum of its 2 slots, since Sat 23:13; it first read under that sum at Sat 23:00, 13 min earlier.",
      'At Sat 23:13 slot 1 delivered 800 W and read 62%.',
      'The pool percent read 58% at Sat 23:12 and 60% at Sat 23:13.',
      'Backup at Sat 23:23: 36.9 kWh of 61.4 kWh counted (60%).',
    ].join(' '),
    severity: 'resolved',
  }], '★ the return notice, from the end on file');
  assert.equal(rb.logs.some((l) => /orphan resolve DROPPED/.test(l)), false);
});

test('★★ an end on file that is OLDER than the push being resolved is another episode\'s: the boot sweep holds for the clean dwell and then sends its own text, not that end\'s return notice', async () => {
  const s = storeWith('older');
  for (let m = -15; m < 0; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  s.store.markFirstPollSettled();
  const r = alertRig(s.store, { name: 'older-mon' }); // quiet hours 22-06
  for (let m = 0; m <= 12; m++) s.feed({ atMs: at(m), body: lostBody(m) });
  await until(() => r.poolPushes().length === 1, 'the raise pushed', r.logs);
  for (let m = 13; m <= 26; m++) s.feed({ atMs: at(m), body: healthyBody(m) });
  await until(() => poolAlerts(s.store).length === 0, 'the alarm ended', r.logs);
  await r.morePasses(2);
  r.mon.stop();
  // The record on file is of a LATER push (23:40) than the end the tracker holds (23:23): the state file is older
  // than the notify state — it was put back from a copy, and the alarm pushed at 23:40 is not in it.
  const statePath = join(ROOT, 'older-mon-notify-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(JSON.parse(readFileSync(s.poolFile, 'utf8')).panels[PANEL_SN].ends[0].atMs, at(23), 'control');
  state['shp2-pool-out'].ts = at(40);
  writeFileSync(statePath, JSON.stringify(state));

  setNow(at(60));
  const bootAt = at(60);
  const b = storeWith('older-b', { poolFile: s.poolFile });
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const rb = alertRig(b.store, { name: 'older-mon', quietHours: '' });
  for (let m = 1; m <= 11; m++) b.feed({ atMs: bootAt + m * MIN, body: healthyBody(9100 + m) });
  await until(() => rb.logs.some((l) => l.includes('orphan resolve HELD')), 'the hold', rb.logs);
  assert.deepEqual(rb.poolPushes(), [], '★ held: the end on file does not answer for a push made after it');
  for (let m = 12; m <= 31; m++) b.feed({ atMs: bootAt + m * MIN, body: healthyBody(9100 + m) });
  await until(() => rb.poolPushes().length === 1, 'the stale card resolved', rb.logs);
  assert.deepEqual(rb.poolPushes(), [{ title: 'Power · Resolved: Core out of the backup pool: slot 1', body: 'Core out of the backup pool: slot 1\n\n(condition cleared while the add-on was restarting)', severity: 'resolved' }],
    '★ resolved on the clean dwell seen in this process, with the sweep\'s own text');
});

test('★★★ a restart with the state file LOST while the Core is UNPLUGGED (its slot no longer listed as connected): slots 2 and 3 read healthy against themselves, and the boot sweep still sends no "Resolved"', async () => {
  await firstProcess('unplugged');
  const stoodAt = iso('2026-11-15T06:50:00Z');
  setNow(stoodAt + 2 * MIN);
  const bootAt = stoodAt + 2 * MIN;
  const b = storeWith('unplugged-b'); // a fresh state file: the first process's is gone
  b.store.setDeviceList(LISTED);
  b.store.markFirstPollSettled();
  const r = alertRig(b.store, { name: 'unplugged-mon', quietHours: '' });
  // Slot 1 reads not connected, with no capacity and no percent: the capacity (61.4 kWh) equals slots 2 and 3.
  const unplugged = (seq: number): Body => lostBody(seq, { slots: [{ pct: 0, w: 0, isConnect: 0, hwConnect: 0, fullCap: 0 }, { pct: 65, w: -1107 }, { pct: 63, w: -1061 }] });
  // Forty minutes of such readings: more than the thirty that would have released the hold.
  for (let m = 1; m <= 40; m++) { b.feed({ atMs: bootAt + m * MIN, body: unplugged(8700 + m) }); if (m % 8 === 0) await r.morePasses(1); }
  await until(() => r.logs.some((l) => l.includes('orphan resolve HELD')), 'the hold', r.logs);
  await r.morePasses(3);
  assert.equal(panelOf(b.store).projection.backupFullCapWh, 61440, 'control: the pool still reads one Core short');
  assert.deepEqual(poolAlerts(b.store), [], 'control: with no reference on file the alarm is not raised again in this shape');
  assert.equal(b.logs.some((l) => l === 'pool-out: reference adopted — slots 2 and 3, 61.4 kWh.'), true, 'control: the smaller reference was adopted');
  assert.equal(b.logs.some((l) => l.startsWith('pool-out: this reference has none on record before it and leaves out slot 1, which the panel does not list as connected')), true, '★ and said so at warn');
  assert.equal(b.store.poolOutOrphanReleased(PANEL_SN), false, '★ the hold is not released: healthy against two slots says nothing about the third');
  assert.deepEqual(r.poolPushes(), [], '★ no "Resolved: Core out of the backup pool" while the Core is still out');
});
