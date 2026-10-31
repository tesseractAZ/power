/**
 * v1.197.1 — the PINNED house panel with no projection raises the house's reserve-alarm-blind.
 *
 * The house panel is pinned (house-panel.json; the store stamps `housePanel` on it), as on every
 * production plant. When the EcoFlow cloud does not return its body after a restart, the panel is
 * listed but has no projection. findShp2 resolves a flagged panel without a projection to nothing
 * (on purpose: no singleton path may stand another panel in for it) and secondaryPanels leaves the
 * house panel out, so the dark-panel alarm (darkPanelBlindSince, v1.187.4 / v1.195.0) reached only
 * the other panels: the house pool had NO reserve-blind alarm while it was dark. The only alert in
 * the reproduction was the grid-offgrid info. The pending rule kept the panel pending until it
 * reported, so no false all-clear followed, but nothing told the owner that the reserve alarm could
 * not see the house pool.
 *
 * Now the pinned dark house panel raises the house's own `reserve-alarm-blind` (the same id, words,
 * family, 15-minute debounce and 60-minute off-grid escalation) from darkPanelBlindSince: the
 * earlier of the onset the store would carry and the panel's first listing in this process, which
 * is also the cold-boot grace (RESERVE_BLIND_AFTER_MS from that listing). The pending rule counts it
 * as raised by the same comparison (darkPanelBlindRaised). Its first projection hands over to the
 * pool's own clock: a pool still unknown then keeps that onset (SnapshotStore), so the alarm is not
 * withdrawn (a "Resolved" push) and back 15 minutes later; a pool that reads ends it.
 *
 * Unchanged: a pinned panel MISSING from the account (the shp2-multi-panel critical stands; no
 * reserve-blind for it, and it stays pending), a plant with no pin (a dark panel is a secondary one
 * and raises its suffixed alarm), and a projected house panel.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ef-house-blind-'));
mkdirSync(join(tmp, 'db'));
process.env.DB_PATH = join(tmp, 'db', 'ecoflow.db'); // config.dbPath is read at import
delete process.env.SUPERVISOR_TOKEN;
delete process.env.POOL_UNKNOWN_PATH;
delete process.env.HOUSE_PANEL_PATH;
after(() => rmSync(tmp, { recursive: true, force: true }));

const { SnapshotStore, PANEL_ABSENT_LISTS } = await import('../src/snapshot.js');
const { computeAlerts, debouncedOnsetsPending, darkPanelBlindRaised } = await import('../src/alerts.js');
const { findShp2, allShp2s, shp2Panels } = await import('../src/shp2Membership.js');
const { familyOf } = await import('../src/alertOutcomes.js');
const { ENERGY_STATE_FAMILIES, isDeviceDerivedAlertId } = await import('../src/alertMonitor.js');

const SEC = 1_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = 1_800_000_000_000; // a fixed wall clock, far from the epoch
const PANEL = 'PANEXXX00XXX0001';
const OTHER = 'PANEXXX00XXX0002';
const CORE = 'COREXXX00XXX0001';
const UNKNOWN = { 'backupIncreInfo.backupFullCap': 61_440 }; // no pool %: published unknown
const READABLE = { 'backupIncreInfo.backupBatPer': 80, 'backupIncreInfo.backupFullCap': 61_440, 'backupIncreInfo.backupDischargeRmainBatCap': 49_152 };
const OFF_GRID = { present: false, backstopping: false };
const ON_GRID = { present: true, backstopping: true };
const LISTED = [
  { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
  { sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
];

type Store = InstanceType<typeof SnapshotStore>;
let seq = 0;

/** One process at `at`, its pool-unknown file `poolFile`. `pin`: house-panel.json names PANEL (as
 *  production's does); without it a lone panel is not pinned on the first list. One clock, as in
 *  production: the store's and the wall clock agree for every call into the store. */
function proc(at: number, poolFile: string, o: { pin?: string | null; list?: typeof LISTED } = {}) {
  let now = at;
  const onClock = <T>(fn: () => T): T => {
    const realNow = Date.now;
    Date.now = () => now;
    try { return fn(); } finally { Date.now = realNow; }
  };
  process.env.POOL_UNKNOWN_PATH = join(tmp, poolFile);
  const pin = o.pin === undefined ? PANEL : o.pin;
  if (pin != null) {
    process.env.HOUSE_PANEL_PATH = join(tmp, `house-panel-${++seq}.json`);
    writeFileSync(process.env.HOUSE_PANEL_PATH, JSON.stringify({ sn: pin, rosters: {} }));
  }
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
function alertsAt(s: Store, nowMs: number, grid = OFF_GRID) {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    return computeAlerts(s.get().devices as any, connOf(s, nowMs) as any, grid);
  } finally {
    Date.now = realNow;
  }
}
const blinds = (s: Store, nowMs: number, grid = OFF_GRID) => alertsAt(s, nowMs, grid).filter((a) => a.id.startsWith('reserve-alarm-blind'));
const houseBlind = (s: Store, nowMs: number, grid = OFF_GRID) => blinds(s, nowMs, grid).find((a) => a.id === 'reserve-alarm-blind');
/** The pending list as the alert monitor computes it (with the device map computeAlerts reads). */
const pendingAt = (s: Store, nowMs: number) => debouncedOnsetsPending(connOf(s, nowMs) as any, nowMs, s.get().devices);
const CARRIED_LINE = `reserve-alarm-blind ${PANEL} (carried onset; the panel not projected yet)`;

/** The first process: the house pool unknown from T0, then the panel goes dark; the poll loop keeps
 *  the file's entry current until `untilMs`. */
function darkUntil(poolFile: string, untilMs: number) {
  const a = proc(T0, poolFile);
  a.read(T0, UNKNOWN);
  for (let t = T0 + MIN; t <= untilMs; t += MIN) a.poll(t);
  return a;
}

/* ══ the defect ═══════════════════════════════════════════════════════════════════════════════ */

test('★★★ the PINNED house panel dark across a restart raises the house reserve-alarm-blind — critical at once off-grid, from the carried onset (it raised nothing: grid-offgrid info only)', () => {
  darkUntil('repro.json', T0 + 70 * MIN);
  const boot = T0 + 72 * MIN;
  const b = proc(boot, 'repro.json'); // listed, never projected: the cloud never returned its body
  const devices = b.s.get().devices;
  assert.equal(devices[PANEL].housePanel, true, 'the pinned house panel');
  assert.equal(devices[PANEL].projection, undefined, 'with no projection');
  assert.equal(findShp2(devices), undefined, '(findShp2 resolves it to nothing, by design)');
  assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL]);

  const all = blinds(b.s, boot + 3 * MIN);
  assert.deepEqual(all.map((a) => `${a.id} ${a.severity}`), ['reserve-alarm-blind critical'],
    '★ exactly one reserve-blind alarm: the house panel\'s own id, never a suffixed secondary one');
  const a = all[0];
  assert.equal(a.title, 'Reserve alarm blind — off-grid');
  assert.equal(a.category, 'Connectivity');
  assert.equal(a.device, 'Smart Home Panel 2');
  assert.match(a.detail, /^SHP2 backup-pool telemetry has been unreadable for 75 min — the reserve\/runway alarms cannot see the pool\./,
    'blind since the carried onset (T0), not since the boot');
  assert.deepEqual(a.facts?.find((f) => f.label === 'Blind for'), { label: 'Blind for', value: '75 min' });
});

test('★★★ the family, and so the audible and push rules, are the house alarm\'s own: the same id the projected panel raises', () => {
  darkUntil('family.json', T0 + 30 * MIN);
  const b = proc(T0 + 32 * MIN, 'family.json');
  const a = houseBlind(b.s, T0 + 33 * MIN)!;
  assert.ok(a, 'raised');
  assert.equal(familyOf(a.id), 'reserve-alarm-blind');
  assert.ok(ENERGY_STATE_FAMILIES.has(familyOf(a.id)), 'the auto-silencer can never eat it');
  assert.ok(isDeviceDerivedAlertId(a.id), 'device-derived: the boot re-track and onset warm-up conventions apply');
  assert.equal(a.annunciate, undefined, 'annunciates (no mute stamped)');
});

/* ══ the cold boot: the existing grace, from its first listing ════════════════════════════════════ */

test('★★ cold boot (nothing carried): absent for RESERVE_BLIND_AFTER_MS from its first listing, then a warning; critical at 60 min off-grid; a warning on grid', () => {
  const boot = T0;
  const b = proc(boot, 'cold.json');
  assert.deepEqual(b.s.poolUnknownCarryPending(), [], 'no file entry');
  assert.deepEqual(blinds(b.s, boot + 15 * MIN - 1), [], 'inside the 15-minute grace: the first projection may legitimately take a while');
  assert.equal(houseBlind(b.s, boot + 15 * MIN)?.severity, 'warning', '★ at 15 min of its first listing (inclusive)');
  assert.equal(houseBlind(b.s, boot + 15 * MIN)?.title, 'Reserve alarm blind');
  assert.equal(houseBlind(b.s, boot + 60 * MIN - 1)?.severity, 'warning');
  assert.equal(houseBlind(b.s, boot + 60 * MIN)?.severity, 'critical', 'off-grid: critical at 60 min');
  const onGrid = houseBlind(b.s, boot + 90 * MIN, ON_GRID)!;
  assert.equal(onGrid.severity, 'warning', 'the grid backstopping: stays a warning');
  assert.match(onGrid.detail, /The grid is available as backup/);
  assert.deepEqual(onGrid.facts?.find((f) => f.label === 'Escalates'), { label: 'Escalates', value: 'suppressed while the grid is available as backup' });
});

/* ══ the hand-over at its first projection ════════════════════════════════════════════════════════ */

test('★★★ the first projection reading the pool still unknown keeps the onset — the alarm is not withdrawn (a "Resolved" push) and back 15 minutes later as a warning', () => {
  const boot = T0;
  const b = proc(boot, 'handover.json');
  b.at(boot + 70 * MIN);
  const dark = houseBlind(b.s, boot + 70 * MIN)!;
  assert.equal(dark.severity, 'critical', 'dark 70 min, off-grid');
  b.read(boot + 70 * MIN, UNKNOWN); // the cloud returns the body at last: the pool unknown
  assert.notEqual(findShp2(b.s.get().devices), undefined, 'projected now: the house panel\'s own clock decides');
  assert.equal(b.s.backupPoolUnknownSince(PANEL), boot, '★ the onset is its first listing, not this projection');
  const projected = houseBlind(b.s, boot + 70 * MIN)!;
  assert.deepEqual(projected, dark, '★ the same alarm, field for field, across the hand-over');
  assert.equal(houseBlind(b.s, boot + 90 * MIN)?.severity, 'critical');
});

test('★★ …and from a carried onset too; a pool that reads at the first projection ends the alarm', () => {
  darkUntil('handover-carried.json', T0 + 20 * MIN);
  const boot = T0 + 22 * MIN;
  const b = proc(boot, 'handover-carried.json');
  assert.equal(houseBlind(b.s, boot)?.severity, 'warning', 'dark: blind since T0');
  b.read(boot + 50 * MIN, UNKNOWN);
  assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, 'carried');
  assert.equal(houseBlind(b.s, boot + 50 * MIN)?.severity, 'critical', 'blind 72 min');

  const c = proc(boot, 'cold-read.json');
  assert.equal(houseBlind(c.s, boot + 20 * MIN)?.severity, 'warning');
  c.read(boot + 20 * MIN, READABLE);
  assert.deepEqual(blinds(c.s, boot + 20 * MIN), [], '★ the panel reports a pool: the alarm ends');
  assert.equal(c.s.backupPoolUnknownSince(PANEL), null);
});

test('★★ the hand-over holds for a dark SECONDARY panel too: its suffixed alarm is not withdrawn at a first projection that reads the pool unknown', () => {
  const both = [...LISTED, { sn: OTHER, deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 }];
  const b = proc(T0, 'secondary-handover.json', { list: both });
  b.read(T0, READABLE); // the house panel reports
  const id = `reserve-alarm-blind-${OTHER}`;
  b.at(T0 + 20 * MIN);
  assert.equal(blinds(b.s, T0 + 20 * MIN).find((a) => a.id === id)?.severity, 'warning', 'the garage panel, dark 20 min');
  b.read(T0 + 20 * MIN, UNKNOWN, OTHER); // its first body: the pool unknown
  assert.equal(b.s.backupPoolUnknownSince(OTHER), T0, '★ its first listing');
  const projected = blinds(b.s, T0 + 20 * MIN).find((a) => a.id === id);
  assert.equal(projected?.severity, 'warning', '★ still raised (it was withdrawn: the clock restarted at this projection)');
  assert.match(projected!.detail, /unreadable for 20 min/);
});

test('★★ the hand-over is the FIRST projection\'s only: a pool that goes unknown later in the process starts its own clock (after the grace hold)', () => {
  const b = proc(T0, 'later.json');
  b.read(T0 + 5 * MIN, READABLE);
  b.read(T0 + 58 * MIN, READABLE);
  b.read(T0 + 60 * MIN, UNKNOWN); // the grace hold publishes the last good value for 3 min
  assert.equal(b.s.backupPoolUnknownSince(PANEL), null, 'held');
  b.read(T0 + 64 * MIN, UNKNOWN);
  assert.equal(b.s.backupPoolUnknownSince(PANEL), T0 + 64 * MIN, 'not its first listing (T0)');
  assert.deepEqual(blinds(b.s, T0 + 64 * MIN), [], 'withheld for its own 15 minutes');
});

test('★ a panel projected at its first listing (every normal boot) is unchanged: a pool unknown then starts the clock at that moment', () => {
  const b = proc(T0, 'normal.json');
  b.read(T0, UNKNOWN);
  assert.equal(b.s.backupPoolUnknownSince(PANEL), T0);
  assert.deepEqual(blinds(b.s, T0 + 15 * MIN - 1), []);
  assert.equal(houseBlind(b.s, T0 + 15 * MIN)?.severity, 'warning');
});

/* ══ the pending rule ═════════════════════════════════════════════════════════════════════════════ */

test('★★ the pinned dark house panel is pending until its own alarm stands, then not — a week on too (it stayed pending until it reported)', () => {
  const a = proc(T0, 'pending.json');
  a.read(T0, UNKNOWN);
  for (let t = T0 + MIN; t <= T0 + 8 * MIN; t += MIN) a.poll(t);
  const boot = T0 + 10 * MIN; // the onset is 10 min old at the boot: its alarm is not raised yet
  const b = proc(boot, 'pending.json');
  assert.deepEqual(pendingAt(b.s, boot), [CARRIED_LINE], 'pending: its alarm is not raised yet');
  assert.equal(houseBlind(b.s, boot), undefined);
  assert.deepEqual(pendingAt(b.s, T0 + 15 * MIN - 1), [CARRIED_LINE], 'one millisecond short of 15 min: still pending');
  assert.deepEqual(pendingAt(b.s, T0 + 15 * MIN), [], '★ at 15 min of the carried onset its alarm is raised: not pending (inclusive)');
  assert.equal(houseBlind(b.s, T0 + 15 * MIN)?.severity, 'warning', 'the alarm the set now holds');
  assert.deepEqual([...darkPanelBlindRaised(b.s.get().devices, connOf(b.s, T0 + 15 * MIN), T0 + 15 * MIN)], [PANEL]);
  for (let t = boot + 30 * MIN; t <= T0 + 8 * DAY; t += 30 * MIN) b.poll(t);
  assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], 'a week on, the store still holds its carried onset (it has not reported)');
  assert.deepEqual(pendingAt(b.s, T0 + 8 * DAY), [], '★ …and the alert set is settled: the alarm it would raise stands');
  const week = houseBlind(b.s, T0 + 8 * DAY)!;
  assert.equal(week.severity, 'critical');
  assert.match(week.detail, /unreadable for 8 d/, 'from the carried onset');
});

/* ══ what is unchanged ════════════════════════════════════════════════════════════════════════════ */

test('★★ a pinned house panel MISSING from the account raises no reserve-blind (the shp2-multi-panel critical stands) and stays pending', () => {
  darkUntil('missing.json', T0 + 30 * MIN);
  const boot = T0 + 32 * MIN;
  const both = [...LISTED, { sn: OTHER, deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 }];
  const b = proc(boot, 'missing.json', { list: both });
  assert.equal(b.s.get().devices[PANEL].housePanel, true, 'listed: pinned');
  const without = both.filter((d) => d.sn !== PANEL);
  for (let i = 1; i <= PANEL_ABSENT_LISTS; i++) b.list(boot + i * MIN, without);
  const devices = b.s.get().devices;
  assert.equal(devices[PANEL].housePanel, undefined, 'off the account: no panel is flagged');
  assert.equal(devices[OTHER].housePanelMissing, PANEL);
  const now = boot + 20 * MIN;
  const all = alertsAt(b.s, now);
  assert.equal(all.find((a) => a.id === 'shp2-multi-panel')?.title, 'House panel not on the account');
  assert.equal(all.find((a) => a.id === 'reserve-alarm-blind'), undefined, 'no house reserve-blind: the critical names the cause');
  assert.equal(all.find((a) => a.id === `reserve-alarm-blind-${PANEL}`), undefined, 'nor a suffixed one for the missing pin');
  assert.equal(darkPanelBlindRaised(devices, connOf(b.s, now), now).has(PANEL), false);
  assert.ok(pendingAt(b.s, now).includes(CARRIED_LINE), 'pending until it reports');
});

test('★ no pin: a lone dark panel not pinned yet is a secondary one and raises its suffixed alarm, as before; the house id is not raised', () => {
  darkUntil('nopin.json', T0 + 30 * MIN);
  const b = proc(T0 + 32 * MIN, 'nopin.json', { pin: null });
  assert.equal(b.s.get().devices[PANEL].housePanel, undefined, 'one list: not pinned yet');
  assert.deepEqual(blinds(b.s, T0 + 33 * MIN).map((a) => a.id), [`reserve-alarm-blind-${PANEL}`]);
});

test('★ a projected house panel is unchanged: a readable pool online raises nothing; offline, blind since its last fresh data', () => {
  const b = proc(T0, 'projected.json');
  b.read(T0, READABLE);
  assert.deepEqual(blinds(b.s, T0 + 30 * MIN), []);
  b.list(T0 + MIN, LISTED.map((d) => (d.sn === PANEL ? { ...d, online: 0 } : d)));
  assert.equal(b.s.get().devices[PANEL].lastUpdated, T0);
  assert.deepEqual(blinds(b.s, T0 + 15 * MIN - 1), []);
  const a = houseBlind(b.s, T0 + 20 * MIN)!;
  assert.equal(a.severity, 'warning', 'the frozen-value path, as before');
  assert.match(a.detail, /unreadable for 20 min/);
});

/* ══ two panels ═══════════════════════════════════════════════════════════════════════════════════ */

test('★★ two panels: the dark house panel reads its OWN pool\'s grid verdict and its own Cores\' fallback, not the plant\'s', () => {
  const NOW = T0;
  const devices: any = {
    [PANEL]: { sn: PANEL, deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: 0, housePanel: true, lastRoster: ['C1'] },
    [OTHER]: {
      sn: OTHER, deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW,
      projection: { kind: 'shp2', backupBatPercent: 50, backupReserveSoc: 15, sources: [{ slot: 1, sn: 'C2', isConnected: true, hwConnect: true, errorCodeNum: 0 }], circuits: [], pairedCircuits: [] },
    },
    C1: { sn: 'C1', deviceName: 'C1', productName: 'Delta Pro Ultra', online: true, lastUpdated: NOW, projection: { kind: 'dpu', soc: 70, packs: [] } },
    C2: { sn: 'C2', deviceName: 'C2', productName: 'Delta Pro Ultra', online: true, lastUpdated: NOW, projection: { kind: 'dpu', soc: 30, packs: [] } },
  };
  const conn: any = { lastDeviceListAttemptAt: NOW, lastDeviceListSuccessAt: NOW, perDevice: new Map(), panelFirstListedBySn: new Map([[PANEL, NOW - 70 * MIN], [OTHER, NOW - 70 * MIN]]) };
  const at = (poolGrid: (sn: string) => typeof ON_GRID) => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try { return computeAlerts(devices, conn, ON_GRID, poolGrid).filter((a) => a.id.startsWith('reserve-alarm-blind')); } finally { Date.now = realNow; }
  };
  const houseOffGrid = at((sn) => (sn === PANEL ? OFF_GRID : ON_GRID));
  assert.deepEqual(houseOffGrid.map((a) => `${a.id} ${a.severity}`), ['reserve-alarm-blind critical'],
    '★ the house pool is not backstopped though the plant verdict says the grid is: critical');
  assert.match(houseOffGrid[0].detail, /mean 70%/, 'the house panel\'s own Cores (its persisted roster), never the union');
  assert.equal(houseOffGrid[0].device, 'House Panel');
  assert.equal(at(() => ON_GRID)[0].severity, 'warning', 'its own pool backstopped: a warning');
  assert.deepEqual([...darkPanelBlindRaised(devices, conn, NOW)], [PANEL], 'the projected garage panel is not dark');
});

/* ══ boundaries ══════════════════════════════════════════════════════════════════════════════════ */

test('★ the hand-over never puts the onset later than now (a clock stepped back between the listing and the projection)', () => {
  const b = proc(T0, 'bounds.json');
  b.read(T0 - 5 * SEC, UNKNOWN); // a clock stepped back between the listing and the projection
  assert.equal(b.s.backupPoolUnknownSince(PANEL), T0 - 5 * SEC, 'never later than now');
});

/* ══ production wiring ═══════════════════════════════════════════════════════════════════════════ */

test('★ production wiring (a source scan, the last resort: the monitor\'s evaluation is a closure no test can call) — the first listings are keyed by panel IDENTITY, so the dark house panel has one', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'alertMonitor.ts'), 'utf8');
  // allShp2s (projected panels only) would leave the dark house panel without a listing: no alarm
  // on a cold boot, nothing carried to compare against.
  assert.match(src, /^ {6}panelFirstListedBySn: new Map\(shp2Panels\(snap\.devices\)\.sns\.map\(\(sn\) => \[sn, store\.firstListedAt\(sn\)\] as const\)\),$/m);
  assert.match(src, /^ {6}poolUnknownCarriedSinceBySn: store\.poolUnknownCarried\(\),$/m);
  assert.match(src, /^ {4}const pendingOnsets = debouncedOnsetsPending\(connectivity, liveAtMs, snap\.devices\);$/m);
});
