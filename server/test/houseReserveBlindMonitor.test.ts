/**
 * v1.197.1 (review) — the dark house panel's reserve-alarm-blind through the REAL alert monitor: the
 * pushes it sends, on one real SnapshotStore, with Home Assistant mocked at the HTTP layer.
 *
 * (a) The context and computeAlerts read one state of the store. The monitor built its connectivity
 * context, then awaited the HA state refresh (a real fetch on about every other tick when a
 * grid-presence entity is configured), then ran computeAlerts on the store's LIVE map. A panel's
 * first quota landing during that await met a context built while it was dark (no pool onset for
 * it): the alarm read blind since that quota and was missing for one tick — "Resolved", then the
 * alarm again. The refresh now runs before the context is built.
 *
 * (b) A dark pinned house panel that leaves the account on a two-panel plant: the shp2-multi-panel
 * critical takes over and the house alarm leaves the set. It named no serial, so the falling edge
 * pushed "Resolved: Reserve alarm blind" while the pool was still unread; it names its panel now
 * (sourceSn) and the evidence gate holds the vanish.
 *
 * (c) A second restart while the house panel stays dark since a cold boot: the onset is on file, the
 * alarm stands at the first pass (re-tracked, not re-pushed) and the boot orphan sweep has nothing to
 * resolve. Before, it was absent for 15 minutes and the sweep pushed "Resolved … (condition cleared
 * while the add-on was restarting)".
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

/* ── environment: set BEFORE any src module is loaded (sidecar paths and the cache TTL are read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-house-blind-mon-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '300';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
delete process.env.NOTIFY_CHANNEL;
delete process.env.NOTIFY_RESOLVED; // resolves are pushed (the default)
process.env.SUPERVISOR_TOKEN = 'test-token';
process.env.GRID_PRESENCE_ENTITY = 'binary_sensor.grid_test'; // the monitor refreshes the HA state cache each pass
process.env.HA_STATE_CACHE_TTL_MS = '0'; // …with a fetch on every pass
process.env.ALERT_ONSET_PATH = join(ROOT, 'alert-onset.json');
process.env.IDLE_POOL_STATE_PATH = join(ROOT, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = join(ROOT, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = join(ROOT, 'latch.json');

const { makeRecorderStub } = await import('./helpers/recorderStub.js');
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore, PANEL_ABSENT_LISTS } = await import('../src/snapshot.js');

const MIN = 60_000;
const PANEL = 'PANEXXX00XXX0001';
const OTHER = 'PANEXXX00XXX0002';
const CORE = 'COREXXX00XXX0001';
const UNKNOWN = { 'backupIncreInfo.backupFullCap': 61_440 }; // no pool %: published unknown
const READABLE = { 'backupIncreInfo.backupBatPer': 80, 'backupIncreInfo.backupFullCap': 61_440, 'backupIncreInfo.backupDischargeRmainBatCap': 49_152 };
const LISTED = [
  { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
  { sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
] as any[];
const BOTH = [...LISTED, { sn: OTHER, deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 }] as any[];

/* ── clock: real time flows, `offset` jumps it ── */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

/* ── Home Assistant, mocked at the HTTP layer. `onStatesFetch` runs INSIDE the monitor's await, at the
 *  first states fetch that FOLLOWS a connectivity context (contextBuilt: watchContext below), so the
 *  check does not depend on how many fetches a pass makes or where they sit: in the shipped order that
 *  is the next pass's fetch, before its context; a fetch between a context and computeAlerts gets it. ── */
let onStatesFetch: (() => void) | null = null;
let contextBuilt = false;
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
const ha = agent.get('http://supervisor');
ha.intercept({ path: '/core/api/states', method: 'GET' }).reply(() => {
  const hook = contextBuilt ? onStatesFetch : null;
  contextBuilt = false;
  if (hook) { onStatesFetch = null; hook(); }
  return { statusCode: 200, data: '[]' };
}).persist();
ha.intercept({ path: (p: string) => p.startsWith('/core/api/'), method: () => true }).reply(200, '{}').persist();

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
/** A store pinning PANEL as the house panel, its pool-unknown file `poolFile`. */
function storeWith(poolFile: string): Store {
  process.env.HOUSE_PANEL_PATH = join(ROOT, `house-panel-${++seq}.json`);
  writeFileSync(process.env.HOUSE_PANEL_PATH, JSON.stringify({ sn: PANEL, rosters: {} }));
  process.env.POOL_UNKNOWN_PATH = join(ROOT, poolFile);
  try { return new SnapshotStore(); } finally { delete process.env.HOUSE_PANEL_PATH; delete process.env.POOL_UNKNOWN_PATH; }
}
/** Marks each connectivity context the monitor builds: it reads poolUnknownCarried once, there and
 *  nowhere else (alertMonitor.ts). */
function watchContext(store: Store): void {
  const read = store.poolUnknownCarried.bind(store);
  store.poolUnknownCarried = () => { contextBuilt = true; return read(); };
}
function alertRig(store: Store, opts: { notifyState?: Record<string, unknown> } = {}) {
  const name = `m${++seq}`;
  process.env.NOTIFY_STATE_PATH = join(ROOT, `${name}-notify-state.json`);
  if (opts.notifyState) writeFileSync(process.env.NOTIFY_STATE_PATH, JSON.stringify(opts.notifyState));
  process.env.DIGEST_STATE_PATH = join(ROOT, `${name}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(ROOT, `${name}-cleared.json`);
  const logs: string[] = [];
  const pushes: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: async (_cfg: unknown, msg: { title: string }) => { pushes.push(msg.title); },
  });
  stops.push(() => mon.stop());
  const passes = () => mon.stats().evalPasses;
  return {
    mon, logs, pushes, passes,
    blindPushes: () => pushes.filter((p) => /Reserve alarm blind/.test(p)),
    resolves: () => pushes.filter((p) => /Resolved: Reserve alarm blind/.test(p)),
    /** Wait for `n` more full passes. */
    morePasses: async (n: number) => { const at = passes(); await until(() => passes() >= at + n, `${n} more passes`, logs); },
  };
}
const houseIds = (store: Store) => (store.get().alerts ?? []).filter((a) => a.id.startsWith('reserve-alarm-blind')).map((a) => `${a.id} ${a.severity}`);

beforeEach(() => {
  for (const s of stops.splice(0)) s();
  offset = 0;
  onStatesFetch = null;
  contextBuilt = false;
});
after(async () => {
  for (const s of stops.splice(0)) s();
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
});

/* ══ (a) the context and computeAlerts read one state of the store ═══════════════════════════════════ */

test('★★★ the house panel\'s first quota landing DURING the monitor\'s HA refresh keeps its standing alarm — no "Resolved" push and no second rise (the context was built before the await)', async () => {
  const store = storeWith('race.json');
  watchContext(store);
  store.setDeviceList(LISTED); // listed, never projected: the cloud has not returned its body
  store.markFirstPollSettled();
  const listedAt = store.firstListedAt(PANEL)!;
  const r = alertRig(store);
  await until(() => r.passes() >= 2, 'two passes', r.logs);
  assert.deepEqual(houseIds(store), [], 'inside the 15-minute grace');

  offset += 16 * MIN;
  store.setDeviceList(LISTED);
  await until(() => r.blindPushes().length === 1, 'the warning pushed', r.logs);
  assert.deepEqual(houseIds(store), ['reserve-alarm-blind warning']);

  let fired = false;
  onStatesFetch = () => { store.setDeviceQuota(PANEL, UNKNOWN); fired = true; }; // the first body: the pool unknown
  await until(() => fired, 'the quota inside the HA refresh', r.logs);
  await r.morePasses(3);
  assert.equal(store.backupPoolUnknownSince(PANEL), listedAt, 'the store handed the onset over (its first listing)');
  assert.deepEqual(r.resolves(), [], '★ no "Resolved: Reserve alarm blind" (the alarm read blind since that quota for one pass)');
  assert.equal(r.blindPushes().length, 1, '★ and no second rise: one push for one episode');
  assert.deepEqual(houseIds(store), ['reserve-alarm-blind warning'], 'standing, projected now');
});

test('★ SOURCE PIN (the order the test above depends on): the HA refresh is awaited before the connectivity context, and nothing is awaited from the context to computeAlerts', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/alertMonitor.ts'), 'utf8');
  const body = src.slice(src.indexOf('  const evaluateInner = async () => {'));
  const refresh = body.indexOf('        await haStateCache.refreshIfStale();');
  const context = body.indexOf('    const connectivity = {');
  const compute = body.indexOf('      ...computeAlerts(snap.devices, connectivity, grid,');
  assert.ok(refresh > 0 && context > refresh && compute > context, `refresh ${refresh} < context ${context} < computeAlerts ${compute}`);
  const between = body.slice(context, compute).split('\n').filter((l) => !/^\s*\/\//.test(l));
  assert.deepEqual(between.filter((l) => /\bawait\b/.test(l)), [], 'no await between the context and computeAlerts');
});

/* ══ (b) a dark pinned panel leaving the account: its vanish is held ════════════════════════════════════ */

test('★★ two panels: the dark pinned house panel leaving the account raises "House panel not on the account" and pushes no "Resolved: Reserve alarm blind"; listed again, the alarm goes on without a new push', async () => {
  const store = storeWith('missing.json');
  store.setDeviceList(BOTH);
  store.setDeviceQuota(OTHER, READABLE); // the garage panel reports; the house panel stays dark
  store.markFirstPollSettled();
  const r = alertRig(store);
  await until(() => r.passes() >= 2, 'two passes', r.logs);
  offset += 16 * MIN;
  store.setDeviceList(BOTH);
  store.setDeviceQuota(OTHER, READABLE);
  await until(() => r.blindPushes().length === 1, 'the warning pushed', r.logs);

  for (let i = 1; i <= PANEL_ABSENT_LISTS; i++) store.setDeviceList(BOTH.filter((d) => d.sn !== PANEL));
  store.setDeviceQuota(OTHER, READABLE);
  await until(() => r.pushes.some((p) => /House panel not on the account/.test(p)), 'the missing-pin critical', r.logs);
  await r.morePasses(3);
  assert.deepEqual(houseIds(store), [], 'the house alarm leaves the set (the critical names the cause)');
  assert.deepEqual(r.resolves(), [], '★ held by the evidence gate: the pool is still unread');

  store.setDeviceList(BOTH);
  store.setDeviceQuota(OTHER, READABLE);
  await r.morePasses(3);
  assert.deepEqual(houseIds(store), ['reserve-alarm-blind warning'], 'listed again, still dark');
  assert.equal(r.blindPushes().length, 1, 'the same episode: no new push');
  assert.deepEqual(r.resolves(), []);
});

/* ══ (c) a second restart while dark since a cold boot ═════════════════════════════════════════════════ */

test('★★★ a second restart while the house panel stays dark since a COLD boot: the critical stands at the first pass (re-tracked) and the boot orphan sweep pushes no "Resolved"', async () => {
  // The first process: a cold boot (no file), the panel dark for 90 min; the poll loop saves the onset.
  const a = storeWith('second-restart.json');
  a.setDeviceList(LISTED);
  const listedAt = a.firstListedAt(PANEL)!;
  offset += 90 * MIN;
  a.markDeviceListAttempt();
  const file = join(ROOT, 'second-restart.json');
  const savedSince = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[PANEL]?.sinceMs : undefined;

  // The restart: the panel still dark. Its critical had been pushed (as the release before saved it: no serial).
  offset += 2 * MIN;
  const b = storeWith('second-restart.json');
  b.setDeviceList(LISTED);
  b.markFirstPollSettled();
  const r = alertRig(b, {
    notifyState: { 'reserve-alarm-blind': { ts: Date.now() - 30 * MIN, sent: true, sev: 'critical', title: 'Reserve alarm blind — off-grid' } },
  });
  await until(() => r.passes() >= 2, 'two passes', r.logs);
  const firstPass = houseIds(b);
  offset += 11 * MIN; // past LEARNED_RESOLVE_GRACE_MS: the boot orphan sweep runs
  b.setDeviceList(LISTED);
  await until(() => r.logs.some((l) => l.includes('boot reconcile')), 'the boot reconcile', r.logs);
  await r.morePasses(2);
  assert.deepEqual(r.resolves(), [], '★ no "Resolved … (condition cleared while the add-on was restarting)"');
  assert.deepEqual(firstPass, ['reserve-alarm-blind critical'], '★ critical at the first pass (it was absent 15 min)');
  assert.deepEqual(r.blindPushes(), [], 're-tracked across the restart: not pushed again');
  assert.equal(savedSince, listedAt, 'the onset its alarm showed was on file');
});
