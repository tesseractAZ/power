/**
 * v1.197.1 (review) — the dark house panel's reserve-alarm-blind across a SECOND restart, and on a
 * one-panel plant whose panel drops off the device lists.
 *
 * (1) The onset of a panel dark since a COLD boot is saved. Such a panel's alarm counts from its first
 * listing in that process (darkPanelBlindSince), but nothing was written to pool-unknown.json: the
 * store wrote only pools read unknown in the process and entries carried from the file. A second
 * restart while the panel stayed dark carried nothing, so the critical was absent for 15 minutes
 * (the boot orphan sweep pushed "Resolved"), then a warning until 60 minutes after the new listing,
 * and the alert set read settled. The store now saves every panel it has listed and never projected,
 * blind since that listing, and rewrites the file at its first projection (a pool that reads retires
 * it there and then).
 *
 * (2) A one-panel plant keeps its pin. A pinned panel left out of PANEL_ABSENT_LISTS lists in a row
 * empties the census, and the resolver kept the pin with no panel flagged: a projected panel was
 * still found by findShp2's lowest-serial fallback, but a DARK one became a secondary panel, so its
 * alarm moved from `reserve-alarm-blind` to `reserve-alarm-blind-<serial>` and back when it was
 * listed again (a "Resolved" push and a new critical at each move). It stays the house panel now
 * when it is the only panel in the device map.
 *
 * (3) The house alarm names its panel (sourceSn), so the monitor's falling-edge evidence gate holds a
 * vanish while that panel has no fresh data: a dark pinned panel that leaves the account on a
 * two-panel plant (the shp2-multi-panel critical takes over) no longer pushes "Resolved".
 *
 * The monitor-level checks (the pushes) are in houseReserveBlindMonitor.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ef-house-blind-carry-'));
mkdirSync(join(tmp, 'db'));
process.env.DB_PATH = join(tmp, 'db', 'ecoflow.db'); // config.dbPath is read at import
delete process.env.SUPERVISOR_TOKEN;
delete process.env.POOL_UNKNOWN_PATH;
delete process.env.HOUSE_PANEL_PATH;
after(() => rmSync(tmp, { recursive: true, force: true }));

const { SnapshotStore, PANEL_ABSENT_LISTS } = await import('../src/snapshot.js');
const { computeAlerts, debouncedOnsetsPending, darkPanelBlindRaised } = await import('../src/alerts.js');
const { findShp2, allShp2s, shp2Panels, resolveHousePanel } = await import('../src/shp2Membership.js');
const { fallingEdgeFrozenByEvidence } = await import('../src/alertMonitor.js');

const MIN = 60_000;
const T0 = 1_800_000_000_000; // a fixed wall clock, far from the epoch
const PANEL = 'PANEXXX00XXX0001';
const OTHER = 'PANEXXX00XXX0002';
const CORE = 'COREXXX00XXX0001';
const UNKNOWN = { 'backupIncreInfo.backupFullCap': 61_440 }; // no pool %: published unknown
const READABLE = { 'backupIncreInfo.backupBatPer': 80, 'backupIncreInfo.backupFullCap': 61_440, 'backupIncreInfo.backupDischargeRmainBatCap': 49_152 };
const OFF_GRID = { present: false, backstopping: false };
const LISTED = [
  { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
  { sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
];
const BOTH = [...LISTED, { sn: OTHER, deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 }];
const WITHOUT_PANEL = LISTED.filter((d) => d.sn !== PANEL);

type Store = InstanceType<typeof SnapshotStore>;
let seq = 0;

/** One process at `at`, its pool-unknown file `poolFile`, house-panel.json pinning PANEL (as
 *  production's does). One clock, as in production: the store's and the wall clock agree for every
 *  call into the store. */
function proc(at: number, poolFile: string, o: { list?: typeof LISTED } = {}) {
  let now = at;
  const onClock = <T>(fn: () => T): T => {
    const realNow = Date.now;
    Date.now = () => now;
    try { return fn(); } finally { Date.now = realNow; }
  };
  process.env.POOL_UNKNOWN_PATH = join(tmp, poolFile);
  process.env.HOUSE_PANEL_PATH = join(tmp, `house-panel-${++seq}.json`);
  writeFileSync(process.env.HOUSE_PANEL_PATH, JSON.stringify({ sn: PANEL, rosters: {} }));
  try {
    const s = onClock(() => new SnapshotStore());
    s.setClock(() => now);
    s.setLogger(() => {});
    onClock(() => s.setDeviceList((o.list ?? LISTED) as any));
    return {
      s,
      at: (ms: number) => { now = ms; },
      /** The poll loop's device-list attempt (it refreshes the pool-unknown file). */
      poll: (ms: number) => { now = ms; onClock(() => s.markDeviceListAttempt()); },
      /** Every minute from `fromMs` to `toMs`, inclusive. */
      pollEach: (fromMs: number, toMs: number) => {
        for (let t = fromMs; t <= toMs; t += MIN) { now = t; onClock(() => s.markDeviceListAttempt()); }
      },
      list: (ms: number, list: typeof LISTED) => { now = ms; onClock(() => s.setDeviceList(list as any)); },
      read: (ms: number, how: Record<string, number>, sn = PANEL) => { now = ms; onClock(() => s.setDeviceQuota(sn, how)); },
    };
  } finally {
    delete process.env.POOL_UNKNOWN_PATH;
    delete process.env.HOUSE_PANEL_PATH;
  }
}
/** The connectivity context exactly as the alert monitor builds it from the store (alertMonitor.ts). */
function connOf(s: Store, nowMs: number) {
  const devices = s.get().devices;
  const shp2Sn = findShp2(devices)?.sn;
  return {
    lastDeviceListAttemptAt: nowMs, lastDeviceListSuccessAt: nowMs, perDevice: new Map(),
    backupPoolUnknownSinceMs: shp2Sn ? s.backupPoolUnknownSince(shp2Sn) : null,
    backupPoolUnknownSinceBySn: new Map(allShp2s(devices).map((p) => [p.sn, s.backupPoolUnknownSince(p.sn)] as const)),
    poolUnknownCarryPending: s.poolUnknownCarryPending(),
    poolUnknownCarriedSinceBySn: s.poolUnknownCarried(),
    panelFirstListedBySn: new Map(shp2Panels(devices).sns.map((sn) => [sn, s.firstListedAt(sn)] as const)),
  };
}
/** Every alert computeAlerts raises at `nowMs` (it reads the wall clock). */
function alertsAt(s: Store, nowMs: number) {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    return computeAlerts(s.get().devices as any, connOf(s, nowMs) as any, OFF_GRID);
  } finally {
    Date.now = realNow;
  }
}
const blinds = (s: Store, nowMs: number) => alertsAt(s, nowMs).filter((a) => a.id.startsWith('reserve-alarm-blind'));
const houseBlind = (s: Store, nowMs: number) => blinds(s, nowMs).find((a) => a.id === 'reserve-alarm-blind');
/** The pending list as the alert monitor computes it (with the device map computeAlerts reads). */
const pendingAt = (s: Store, nowMs: number) => debouncedOnsetsPending(connOf(s, nowMs) as any, nowMs, s.get().devices);
const onFile = (poolFile: string) => JSON.parse(readFileSync(join(tmp, poolFile), 'utf8'));
const CARRIED_LINE = `reserve-alarm-blind ${PANEL} (carried onset; the panel not projected yet)`;

/* ══ (1) the onset of a panel dark since a cold boot is saved ══════════════════════════════════════ */

test('★★★ dark since a COLD boot, critical, then a second restart while still dark: critical at once — the onset its alarm showed is carried (it was absent 15 min, then a warning until 60 min after the new listing)', () => {
  const a = proc(T0, 'twice.json'); // a cold boot: no file, nothing carried
  a.pollEach(T0 + MIN, T0 + 69 * MIN);
  assert.equal(houseBlind(a.s, T0 + 69 * MIN)?.severity, 'critical', 'dark 69 min off-grid');
  assert.deepEqual(onFile('twice.json'), { [PANEL]: { sinceMs: T0, lastSeenMs: T0 + 69 * MIN } },
    '★ saved: blind since its first listing, last seen at the last poll (nothing was written)');

  const b = proc(T0 + 72 * MIN, 'twice.json'); // the panel still dark after the restart
  assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], 'its entry is carriable');
  const now = T0 + 72 * MIN;
  const alarm = houseBlind(b.s, now)!;
  assert.equal(alarm?.severity, 'critical', '★ critical at once, from the onset the alarm showed (T0)');
  assert.match(alarm.detail, /unreadable for 72 min/);
  assert.deepEqual(pendingAt(b.s, now), [], '★ the alarm stands: the alert set is settled on it, with the critical in it');

  b.pollEach(now + MIN, T0 + 80 * MIN);
  assert.deepEqual(onFile('twice.json')[PANEL], { sinceMs: T0, lastSeenMs: T0 + 80 * MIN }, 'the carried entry, held by this process');
  const c = proc(T0 + 82 * MIN, 'twice.json'); // a third restart, still dark
  assert.match(houseBlind(c.s, T0 + 82 * MIN)!.detail, /unreadable for 82 min/, 'any number of restarts');
});

test('★★ the same for a dark SECONDARY panel: its suffixed alarm is carried across a second restart', () => {
  const id = `reserve-alarm-blind-${OTHER}`;
  const a = proc(T0, 'twice-secondary.json', { list: BOTH });
  a.read(T0, READABLE); // the house panel reports
  for (let t = T0 + MIN; t <= T0 + 69 * MIN; t += MIN) { a.read(t, READABLE); a.poll(t); }
  assert.equal(blinds(a.s, T0 + 69 * MIN).find((x) => x.id === id)?.severity, 'critical');
  assert.deepEqual(onFile('twice-secondary.json'), { [OTHER]: { sinceMs: T0, lastSeenMs: T0 + 69 * MIN } }, 'the readable house pool is not on file');

  const b = proc(T0 + 72 * MIN, 'twice-secondary.json', { list: BOTH });
  b.read(T0 + 72 * MIN, READABLE);
  const alarm = blinds(b.s, T0 + 72 * MIN).find((x) => x.id === id);
  assert.equal(alarm?.severity, 'critical', '★ critical at once (it was absent 15 min, then a warning)');
  assert.match(alarm!.detail, /unreadable for 72 min/);
});

test('★★ a restart inside the cold-boot grace: the next process waits out the same 15 minutes from the first listing, and is pending until then', () => {
  const a = proc(T0, 'grace.json');
  a.pollEach(T0 + MIN, T0 + 5 * MIN);
  const b = proc(T0 + 7 * MIN, 'grace.json');
  assert.deepEqual(pendingAt(b.s, T0 + 7 * MIN), [CARRIED_LINE], 'pending: its alarm may stand before its own 15 minutes');
  assert.equal(houseBlind(b.s, T0 + 15 * MIN - 1), undefined, 'inside the grace');
  assert.equal(houseBlind(b.s, T0 + 15 * MIN)?.severity, 'warning', '★ at 15 min of the FIRST process\'s listing, not this one\'s');
  assert.deepEqual(pendingAt(b.s, T0 + 15 * MIN), [], 'raised: not pending');
});

test('★★★ a first projection that reads the pool retires the saved onset at once — a restart after it starts the clock again, never "blind since" the old listing', () => {
  const a = proc(T0, 'retire.json');
  a.pollEach(T0 + MIN, T0 + 5 * MIN);
  assert.deepEqual(Object.keys(onFile('retire.json')), [PANEL], 'saved while dark');
  a.read(T0 + 6 * MIN, READABLE); // the first quota: the pool reads
  assert.deepEqual(onFile('retire.json'), {}, '★ rewritten at that projection (nothing else would have rewritten it)');

  const b = proc(T0 + 30 * MIN, 'retire.json'); // dark again after a restart
  assert.deepEqual(b.s.poolUnknownCarryPending(), [], 'nothing carried');
  assert.equal(houseBlind(b.s, T0 + 45 * MIN - 1), undefined, '★ its own grace from this listing (it was "blind since T0", critical at T0 + 60)');
  assert.equal(houseBlind(b.s, T0 + 45 * MIN)?.severity, 'warning');
});

test('★★ a first projection that reads the pool UNKNOWN keeps the saved onset (the hand-over), on file too', () => {
  const a = proc(T0, 'handover.json');
  a.pollEach(T0 + MIN, T0 + 20 * MIN);
  a.read(T0 + 21 * MIN, UNKNOWN);
  assert.equal(a.s.backupPoolUnknownSince(PANEL), T0);
  assert.deepEqual(onFile('handover.json')[PANEL], { sinceMs: T0, lastSeenMs: T0 + 21 * MIN }, 'the pool\'s own onset now, the same instant');
  const b = proc(T0 + 30 * MIN, 'handover.json');
  b.read(T0 + 30 * MIN, UNKNOWN);
  assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, 'carried');
});

test('★ a normal boot (projected at its first listing) writes nothing: no file', () => {
  const a = proc(T0, 'normal.json');
  a.read(T0, READABLE);
  for (let t = T0 + MIN; t <= T0 + 10 * MIN; t += MIN) { a.read(t, READABLE); a.poll(t); }
  assert.equal(existsSync(join(tmp, 'normal.json')), false);
});

/* ══ (2) a one-panel plant keeps its pin while its panel is off the device lists ═══════════════════ */

test('★★★ one-panel plant: a dark pinned house panel left out of PANEL_ABSENT_LISTS lists stays the house panel — the same reserve-alarm-blind throughout, never a suffixed one (a "Resolved" push and a new critical at each move)', () => {
  const b = proc(T0, 'onepanel-dark.json');
  b.pollEach(T0 + MIN, T0 + 70 * MIN);
  const ids = (nowMs: number) => alertsAt(b.s, nowMs)
    .filter((x) => x.id.startsWith('reserve-alarm-blind') || x.id === 'shp2-multi-panel').map((x) => `${x.id} ${x.severity}`);
  assert.deepEqual(ids(T0 + 70 * MIN), ['reserve-alarm-blind critical'], 'listed, dark');
  for (let i = 1; i <= PANEL_ABSENT_LISTS; i++) b.list(T0 + (70 + i) * MIN, WITHOUT_PANEL);
  const devices = b.s.get().devices;
  assert.equal(devices[PANEL].housePanel, true, '★ still the house panel');
  assert.equal(devices[PANEL].housePanelMissing, undefined, 'not "missing": a one-panel plant raises no "House panel not on the account" (unchanged)');
  assert.deepEqual(b.s.housePanelState(), { sn: PANEL, state: 'none', ambiguous: false, missing: null, panels: [] }, 'no panel on the account; the pin kept');
  assert.equal(findShp2(devices), undefined, 'dark: findShp2 still resolves it to nothing');
  assert.deepEqual(ids(T0 + 74 * MIN), ['reserve-alarm-blind critical'], '★ the house id, not reserve-alarm-blind-<serial>');
  assert.deepEqual([...darkPanelBlindRaised(devices, connOf(b.s, T0 + 74 * MIN), T0 + 74 * MIN)], [PANEL], 'the pending rule agrees');
  b.list(T0 + 75 * MIN, LISTED);
  assert.deepEqual(ids(T0 + 75 * MIN), ['reserve-alarm-blind critical'], 'listed again: the same');
  assert.equal(b.s.housePanelState().state, 'pinned');
});

test('★ one-panel plant, projected: unchanged — findShp2 returns the panel while it is off the lists (the lowest-serial fallback did too)', () => {
  const b = proc(T0, 'onepanel-projected.json');
  b.read(T0, READABLE);
  for (let i = 1; i <= PANEL_ABSENT_LISTS; i++) b.list(T0 + i * MIN, WITHOUT_PANEL);
  assert.equal(findShp2(b.s.get().devices)?.sn, PANEL);
  assert.deepEqual(blinds(b.s, T0 + 10 * MIN), []);
});

test('★★ two panels in the device map and none on the account: nothing is flagged, as before (the pin keeps the house role only where no other panel could stand in)', () => {
  const b = proc(T0, 'two-off.json', { list: BOTH });
  b.read(T0, READABLE);
  b.read(T0, READABLE, OTHER);
  for (let i = 1; i <= PANEL_ABSENT_LISTS; i++) b.list(T0 + i * MIN, WITHOUT_PANEL.filter((d) => d.sn === CORE));
  const devices = b.s.get().devices;
  assert.equal(devices[PANEL].housePanel, undefined);
  assert.equal(devices[OTHER].housePanel, undefined);
  assert.deepEqual(b.s.housePanelState(), { sn: null, state: 'none', ambiguous: false, missing: null, panels: [] });
});

test('resolveHousePanel — an empty census keeps the pin (state none); its panel stays the house panel only when it is the only panel in the device map', () => {
  assert.deepEqual(resolveHousePanel([], 'ZHOUSE', true, ['ZHOUSE']), { sn: 'ZHOUSE', pin: 'ZHOUSE', state: 'none' }, '★ the one-panel plant');
  assert.deepEqual(resolveHousePanel([], 'ZHOUSE', true, ['AGARAGE', 'ZHOUSE']), { sn: null, pin: 'ZHOUSE', state: 'none' }, 'another panel mapped: nothing flagged');
  assert.deepEqual(resolveHousePanel([], 'ZHOUSE', true, ['AGARAGE']), { sn: null, pin: 'ZHOUSE', state: 'none' }, 'the pinned panel never mapped');
  assert.deepEqual(resolveHousePanel([], 'ZHOUSE'), { sn: null, pin: 'ZHOUSE', state: 'none' }, 'no map passed: as before');
  assert.deepEqual(resolveHousePanel([], null, true, ['ZHOUSE']), { sn: null, pin: null, state: 'none' }, 'no pin');
  assert.deepEqual(resolveHousePanel(['ZHOUSE'], 'ZHOUSE', true, ['ZHOUSE']), { sn: 'ZHOUSE', pin: 'ZHOUSE', state: 'pinned' }, 'on the account: pinned');
});

/* ══ (3) the house alarm names its panel ═══════════════════════════════════════════════════════════ */

test('★★ the house alarm names its panel (sourceSn): a dark pinned panel leaving the account on a two-panel plant — its vanish is held by the falling-edge evidence gate while the panel has no fresh data (no "Resolved" push), and resolves once it reports', () => {
  const b = proc(T0, 'missing-held.json', { list: BOTH });
  b.read(T0, READABLE, OTHER); // the garage panel reports; the house panel stays dark
  const alarm = houseBlind(b.s, T0 + 20 * MIN)!;
  assert.equal(alarm?.severity, 'warning');
  assert.equal(alarm.sourceSn, PANEL, '★ its own panel');
  for (let i = 1; i <= PANEL_ABSENT_LISTS; i++) b.list(T0 + (20 + i) * MIN, BOTH.filter((d) => d.sn !== PANEL));
  const now = T0 + 24 * MIN;
  const all = alertsAt(b.s, now);
  assert.equal(all.find((x) => x.id === 'shp2-multi-panel')?.title, 'House panel not on the account', 'the critical that names the cause');
  assert.equal(all.find((x) => x.id === 'reserve-alarm-blind'), undefined, 'the house alarm vanishes from the set (unchanged)');
  const gate = (nowMs: number) => fallingEdgeFrozenByEvidence({
    id: alarm.id, deviceSns: Object.keys(b.s.get().devices), devices: b.s.get().devices, nowMs, sourceSn: alarm.sourceSn,
  });
  assert.equal(gate(now), true, '★ held: the panel has no fresh data, so the vanish is not a recovery');
  assert.equal(fallingEdgeFrozenByEvidence({ id: alarm.id, deviceSns: Object.keys(b.s.get().devices), devices: b.s.get().devices, nowMs: now }), false,
    '(without the serial the id names nothing, and the vanish pushed "Resolved")');
  b.list(T0 + 30 * MIN, BOTH);
  b.read(T0 + 30 * MIN, READABLE);
  assert.equal(houseBlind(b.s, T0 + 30 * MIN), undefined, 'it reports a pool');
  assert.equal(gate(T0 + 30 * MIN), false, 'fresh data: a vanish is a recovery');
});

test('★ the house alarm carries the same serial on every path: projected with the pool unknown, and frozen offline', () => {
  const b = proc(T0, 'source-paths.json');
  b.read(T0, UNKNOWN);
  assert.equal(houseBlind(b.s, T0 + 15 * MIN)?.sourceSn, PANEL, 'the pool unknown');
  const c = proc(T0, 'source-paths-offline.json');
  c.read(T0, READABLE);
  c.list(T0 + MIN, LISTED.map((d) => (d.sn === PANEL ? { ...d, online: 0 } : d)));
  assert.equal(houseBlind(c.s, T0 + 20 * MIN)?.sourceSn, PANEL, 'listed offline: blind since its last fresh data');
});
