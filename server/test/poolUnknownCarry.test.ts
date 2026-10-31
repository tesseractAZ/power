/**
 * v1.187.4 — the backup pool's unknown onset survives a restart (pool-unknown.json).
 *
 * reserve-alarm-blind keys on how long the panel's published pool % has read unknown
 * (SnapshotStore.backupPoolUnknownSince): a warning after RESERVE_BLIND_AFTER_MS (15 min), a
 * CRITICAL after 60 min while the grid is not backstopping. The onset lived only in the process, so
 * a restart during a cloud wedge started it again at the first projection: an off-grid critical the
 * house had heard was ABSENT for 15 minutes after the boot (the alert set unsettled, a green possible
 * — see restartRecoveryAllClear) and came back as a WARNING until boot + 60.
 *
 * The store now writes each unknown pool's onset and when it was last seen unknown, and a panel
 * whose first projection in the next process reads unknown again carries the onset, when the add-on
 * was down at most POOL_UNKNOWN_CARRY_MAX_GAP_MS. Pure rules first, then the file through
 * SnapshotStore instances, then the alert those onsets drive (computeAlerts).
 *
 * v1.195.0 — the file believes an episode of up to a year (7 days before: a panel dark for longer
 * lost its onset at every restart); a dark panel is pending only until its own carried alarm is
 * raised (the house panel has none while dark); and a file in a directory this process cannot write
 * (a read-only /data) is not carried, keeps its panels pending, and is never written back.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ef-pool-unknown-'));
mkdirSync(join(tmp, 'db'));
process.env.DB_PATH = join(tmp, 'db', 'ecoflow.db'); // config.dbPath is read at import
delete process.env.SUPERVISOR_TOKEN;
delete process.env.POOL_UNKNOWN_PATH;
after(() => rmSync(tmp, { recursive: true, force: true }));

const {
  SnapshotStore, parsePoolUnknownOnsets, carriedPoolUnknownSince, POOL_UNKNOWN_CARRY_MAX_GAP_MS, POOL_UNKNOWN_PERSIST_EVERY_MS,
  POOL_UNKNOWN_MAX_EPISODE_MS, poolUnknownDirWritable,
} = await import('../src/snapshot.js');
const { computeAlerts, debouncedOnsetsPending, darkPanelBlindRaised } = await import('../src/alerts.js');

const SEC = 1_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = 1_800_000_000_000; // a fixed wall clock, far from the epoch
const PANEL = 'PANEXXX00XXX0001';
const CORE = 'COREXXX00XXX0001';
const UNKNOWN = { 'backupIncreInfo.backupFullCap': 61_440 }; // no pool %: published unknown
const READABLE = { 'backupIncreInfo.backupBatPer': 80, 'backupIncreInfo.backupFullCap': 61_440, 'backupIncreInfo.backupDischargeRmainBatCap': 49_152 };

/** One process: a store on its own clock, its log kept. */
function proc(at: number) {
  let now = at;
  const logs: string[] = [];
  const s = new SnapshotStore();
  s.setClock(() => now);
  s.setLogger((m) => logs.push(m));
  s.setDeviceList([
    { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
    { sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
  ] as any);
  return {
    s, logs,
    at: (ms: number) => { now = ms; },
    /** A panel projection reading the pool `how` at `ms`. */
    read: (ms: number, how: Record<string, number>) => { now = ms; s.setDeviceQuota(PANEL, how); },
    has: (x: string) => logs.some((l) => l.includes(x)),
  };
}
/** The reserve-alarm-blind alert this store's onset drives at `nowMs`, off-grid (no backstop). */
function blind(s: InstanceType<typeof SnapshotStore>, nowMs: number) {
  const realNow = Date.now;
  Date.now = () => nowMs; // computeAlerts reads the wall clock
  try {
    const conn = {
      lastDeviceListAttemptAt: nowMs, lastDeviceListSuccessAt: nowMs, perDevice: new Map(),
      backupPoolUnknownSinceMs: s.backupPoolUnknownSince(PANEL),
      backupPoolUnknownSinceBySn: new Map([[PANEL, s.backupPoolUnknownSince(PANEL)]]),
    };
    return computeAlerts(s.get().devices as any, conn as any, { present: false, backstopping: false })
      .find((a) => a.id === 'reserve-alarm-blind');
  } finally {
    Date.now = realNow;
  }
}
/** v1.187.4 (review) — the alarm of a panel with no projection (dark since the restart): as the
 *  alert monitor wires it, first listed in this process or the onset the store would carry. */
function blindDark(s: InstanceType<typeof SnapshotStore>, nowMs: number, firstListedMs: number) {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    const conn = {
      lastDeviceListAttemptAt: nowMs, lastDeviceListSuccessAt: nowMs, perDevice: new Map(),
      backupPoolUnknownSinceBySn: new Map(), panelFirstListedBySn: new Map([[PANEL, firstListedMs]]),
      poolUnknownCarriedSinceBySn: s.poolUnknownCarried(),
    };
    return computeAlerts(s.get().devices as any, conn as any, { present: false, backstopping: false })
      .find((a) => a.id.startsWith('reserve-alarm-blind'));
  } finally {
    Date.now = realNow;
  }
}
/** The first process: the pool reads unknown from T0, a projection every 10 min until `untilMs`. */
function blindUntil(untilMs: number) {
  const a = proc(T0);
  for (let t = T0; t <= untilMs; t += 10 * MIN) a.read(t, UNKNOWN);
  a.read(untilMs, UNKNOWN);
  assert.equal(a.s.backupPoolUnknownSince(PANEL), T0);
  return a;
}
function withPath<T>(name: string, fn: (path: string) => T): T {
  const path = join(tmp, name);
  process.env.POOL_UNKNOWN_PATH = path;
  try { return fn(path); } finally { delete process.env.POOL_UNKNOWN_PATH; }
}
/** v1.195.0 — the pending list as the alert monitor computes it: with the store's connectivity
 *  context for a panel dark since the restart, and the device map computeAlerts reads. */
function pendingAt(s: InstanceType<typeof SnapshotStore>, nowMs: number, firstListedMs: number) {
  return debouncedOnsetsPending({
    poolUnknownCarryPending: s.poolUnknownCarryPending(),
    poolUnknownCarriedSinceBySn: s.poolUnknownCarried(),
    panelFirstListedBySn: new Map([[PANEL, firstListedMs]]),
  }, nowMs, s.get().devices);
}
/** v1.195.0 — a process whose panel is the PINNED house panel (house-panel.json), as production's is. */
function pinnedProc(at: number) {
  process.env.HOUSE_PANEL_PATH = join(tmp, `house-panel-${at}.json`);
  writeFileSync(process.env.HOUSE_PANEL_PATH, JSON.stringify({ sn: PANEL, rosters: {} }));
  try { return proc(at); } finally { delete process.env.HOUSE_PANEL_PATH; }
}
const PENDING_LINE = `reserve-alarm-blind ${PANEL} (carried onset; the panel not projected yet)`;

/* ══ the restart ═══════════════════════════════════════════════════════════════════════════ */

test('★★★ an off-grid reserve-alarm-blind CRITICAL standing at a restart is critical on the first projection after it — not absent 15 min, then a warning until boot + 60', () => {
  withPath('restart.json', () => {
    const a = blindUntil(T0 + 70 * MIN);
    assert.equal(blind(a.s, T0 + 70 * MIN)?.severity, 'critical', 'before the restart: blind 70 min, off-grid');

    const boot = T0 + 72 * MIN; // a deploy: two minutes down
    const b = proc(boot);
    b.read(boot, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, '★ the onset of before the restart is carried');
    const after = blind(b.s, boot);
    assert.equal(after?.severity, 'critical', '★ still critical at once');
    assert.match(after!.detail, /unreadable for 72 min/);
    assert.ok(b.has('backup-pool: unknown since 72 min ago, before the restart (last seen unknown 120 s ago) — the reserve-blind clock carries it'), b.logs.join('\n'));
  });
});

test('★★★ …and the warning (blind 15-60 min) is present on the first projection after the restart, not withheld 15 min', () => {
  withPath('restart-warning.json', () => {
    blindUntil(T0 + 20 * MIN);
    const boot = T0 + 22 * MIN;
    const b = proc(boot);
    b.read(boot, UNKNOWN);
    assert.equal(blind(b.s, boot)?.severity, 'warning');
    assert.equal(blind(b.s, T0 + 60 * MIN)?.severity, 'critical', 'and critical at 60 min of the episode, not of the process');
  });
});

test('★★ the file\'s last-seen time is refreshed while the pool stays unknown, at most once a minute: a restart after a long episode is judged against it, not the onset', () => {
  withPath('refresh.json', (path) => {
    const a = proc(T0);
    a.read(T0, UNKNOWN);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { [PANEL]: { sinceMs: T0, lastSeenMs: T0 } }, 'written at the onset');
    a.read(T0 + 30 * SEC, UNKNOWN);
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].lastSeenMs, T0, 'not rewritten within the minute');
    a.read(T0 + POOL_UNKNOWN_PERSIST_EVERY_MS, UNKNOWN);
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].lastSeenMs, T0 + POOL_UNKNOWN_PERSIST_EVERY_MS, 'refreshed once it is due');
    for (let t = T0 + 2 * MIN; t <= T0 + 90 * MIN; t += MIN) a.read(t, UNKNOWN);
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].lastSeenMs, T0 + 90 * MIN);

    const b = proc(T0 + 93 * MIN); // 3 min down after 90 min blind: carried (the onset is 93 min old)
    b.read(T0 + 93 * MIN, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0);
  });
});

test('★★ an outage longer than POOL_UNKNOWN_CARRY_MAX_GAP_MS is a new observation: the clock starts at the first projection, as before', () => {
  withPath('long-outage.json', () => {
    blindUntil(T0 + 30 * MIN);
    const late = T0 + 30 * MIN + POOL_UNKNOWN_CARRY_MAX_GAP_MS + SEC;
    const b = proc(late);
    b.read(late, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), late);
    assert.equal(blind(b.s, late), undefined, 'withheld for its own 15 minutes');
    assert.ok(!b.has('the reserve-blind clock carries it'));
  });
  withPath('long-outage-edge.json', () => {
    blindUntil(T0 + 30 * MIN);
    const edge = T0 + 30 * MIN + POOL_UNKNOWN_CARRY_MAX_GAP_MS;
    const b = proc(edge);
    b.read(edge, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, 'exactly the bound: carried');
  });
});

test('★★ a pool that reads after the restart retires the entry: the next unknown episode is new', () => {
  withPath('retire.json', (path) => {
    blindUntil(T0 + 20 * MIN);
    const b = proc(T0 + 22 * MIN);
    b.read(T0 + 22 * MIN, READABLE);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), null);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {}, 'the entry left the file');

    const c = proc(T0 + 25 * MIN);
    c.read(T0 + 25 * MIN, UNKNOWN);
    assert.equal(c.s.backupPoolUnknownSince(PANEL), T0 + 25 * MIN, 'a new episode: nothing carried');
  });
});

test('★★ in one process a readable pool clears the file too; a later unknown starts a new onset there (after the grace hold)', () => {
  withPath('one-process.json', (path) => {
    const a = proc(T0);
    a.read(T0, UNKNOWN);
    a.read(T0 + MIN, READABLE);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
    a.read(T0 + 2 * MIN, UNKNOWN); // the grace hold publishes the last good value for 3 min
    assert.equal(a.s.backupPoolUnknownSince(PANEL), null);
    a.read(T0 + 6 * MIN, UNKNOWN);
    assert.equal(a.s.backupPoolUnknownSince(PANEL), T0 + 6 * MIN);
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].sinceMs, T0 + 6 * MIN);
  });
});

test('★★ a second restart before the panel is projected again keeps the file\'s entry (still carriable)', () => {
  withPath('two-restarts.json', (path) => {
    blindUntil(T0 + 20 * MIN);
    const b = proc(T0 + 22 * MIN);
    b.s.setDeviceQuota(CORE, {}); // something else is projected and nothing touches the pool
    const c = proc(T0 + 24 * MIN);
    c.read(T0 + 24 * MIN, UNKNOWN);
    assert.equal(c.s.backupPoolUnknownSince(PANEL), T0);
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].sinceMs, T0);
  });
});

test('★ another panel\'s entry is kept while carriable and dropped once it no longer is', () => {
  withPath('other-panel.json', (path) => {
    const OTHER = 'PANEXXX00XXX0002';
    writeFileSync(path, JSON.stringify({
      [OTHER]: { sinceMs: T0 - 10 * MIN, lastSeenMs: T0 - MIN },
      PANEXXX00XXX0003: { sinceMs: T0 - 300 * MIN, lastSeenMs: T0 - 200 * MIN },
    }));
    const a = proc(T0);
    a.read(T0, UNKNOWN);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(onDisk[OTHER], { sinceMs: T0 - 10 * MIN, lastSeenMs: T0 - MIN });
    assert.equal(onDisk.PANEXXX00XXX0003, undefined, 'not carriable any more: dropped');
    assert.deepEqual(onDisk[PANEL], { sinceMs: T0, lastSeenMs: T0 });
  });
});

test('★ no file in development (no SUPERVISOR_TOKEN, no POOL_UNKNOWN_PATH); a save failure is logged once and nothing throws', () => {
  const a = proc(T0);
  a.read(T0, UNKNOWN);
  assert.ok(!existsSync(join(tmp, 'pool-unknown.json')));
  assert.ok(!existsSync(join(tmp, 'db', 'pool-unknown.json')));
  withPath(join('missing-dir', 'x.json'), () => {
    const b = proc(T0);
    b.read(T0, UNKNOWN);
    b.read(T0 + 2 * MIN, UNKNOWN);
    b.read(T0 + 4 * MIN, UNKNOWN);
    assert.equal(b.logs.filter((l) => l.includes('could not save the pool-unknown onset')).length, 1);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, 'the onset itself is unaffected');
  });
});

test('★★★ review: a panel gone dark keeps its onset across a restart — the poll loop refreshes the file whatever the panel reports', () => {
  withPath('dark.json', (path) => {
    const a = proc(T0);
    a.read(T0, UNKNOWN);
    a.read(T0 + 10 * MIN, UNKNOWN); // its last projection: the panel then goes dark
    for (let t = T0 + 11 * MIN; t <= T0 + 80 * MIN; t += MIN) { a.at(t); a.s.markDeviceListAttempt(); }
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].lastSeenMs, T0 + 80 * MIN, 'last seen when this process last held the onset');
    assert.equal(blind(a.s, T0 + 80 * MIN)?.severity, 'critical', 'in the process the alarm stood');
    const b = proc(T0 + 82 * MIN);
    b.read(T0 + 82 * MIN, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, '★ carried: the restart behaves as the process did');
    assert.equal(blind(b.s, T0 + 82 * MIN)?.severity, 'critical');
  });
});

test('★★ review: a listed panel not projected yet with a carriable onset on file is PENDING — the alert set is not settled before its first projection', () => {
  withPath('pending.json', (path) => {
    blindUntil(T0 + 70 * MIN);
    writeFileSync(path, JSON.stringify({
      ...JSON.parse(readFileSync(path, 'utf8')),
      PANEXXX00XXX0009: { sinceMs: T0, lastSeenMs: T0 + 70 * MIN }, // not on this account's list
    }));
    const b = proc(T0 + 72 * MIN);
    assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], 'listed, unprojected, carriable — the unlisted one is not');
    assert.deepEqual(debouncedOnsetsPending({ poolUnknownCarryPending: b.s.poolUnknownCarryPending() }, T0 + 72 * MIN),
      [`reserve-alarm-blind ${PANEL} (carried onset; the panel not projected yet)`]);
    b.read(T0 + 72 * MIN, UNKNOWN);
    assert.deepEqual(b.s.poolUnknownCarryPending(), [], 'consumed by its first projection');
    assert.equal(blind(b.s, T0 + 72 * MIN)?.severity, 'critical');
    const c = proc(T0 + 70 * MIN + POOL_UNKNOWN_CARRY_MAX_GAP_MS + 2 * MIN + SEC);
    assert.deepEqual(c.s.poolUnknownCarryPending(), [], 'no longer carriable: not pending');
  });
});

test('★★ review: a failed save removes the file — a pool that reads again is never carried as unknown after a restart', () => {
  withPath('fail.json', (path) => {
    blindUntil(T0 + 70 * MIN);
    mkdirSync(`${path}.tmp`); // the save's temporary file cannot be written: the save fails
    const b = proc(T0 + 72 * MIN);
    b.read(T0 + 72 * MIN, READABLE); // the entry is retired, but the save fails
    assert.ok(!existsSync(path), '★ the stale entry is removed with the file');
    assert.ok(b.has('could not save the pool-unknown onset'));
    assert.ok(b.has('the file is removed, so a restart starts the reserve-blind clock again'), 'the line says what was done');
    rmSync(`${path}.tmp`, { recursive: true, force: true });
    const c = proc(T0 + 73 * MIN);
    c.read(T0 + 73 * MIN, UNKNOWN);
    assert.equal(c.s.backupPoolUnknownSince(PANEL), T0 + 73 * MIN, 'a new episode: nothing stale carried');
  });
});

test('★★ review (N6): a panel still dark after the restart is blind since the onset it would carry — critical at once off-grid, not a warning from its first listing', () => {
  withPath('dark-after.json', () => {
    blindUntil(T0 + 70 * MIN);
    const boot = T0 + 72 * MIN;
    const b = proc(boot); // listed, never projected
    const a = blindDark(b.s, boot + 3 * MIN, boot);
    assert.equal(a?.severity, 'critical', '★ blind since the carried onset (75 min)');
    assert.match(a!.detail, /unreadable for 75 min/);
    assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL]);
  });
});

test('★★ review (N1): a listed panel dark across the restart and for over an hour after it keeps its onset — the new process refreshes the entry it holds', () => {
  withPath('dark-long.json', (path) => {
    blindUntil(T0 + 30 * MIN);
    const boot = T0 + 32 * MIN;
    const b = proc(boot);
    for (let t = boot; t <= boot + 90 * MIN; t += MIN) { b.at(t); b.s.markDeviceListAttempt(); }
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[PANEL].lastSeenMs, boot + 90 * MIN, 'held by this process: last seen now');
    assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], 'still pending: the panel has not reported');
    b.read(boot + 91 * MIN, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, '★ carried at its first projection, two hours on');
  });
});

/* ══ v1.195.0: a panel dark for more than a week ═══════════════════════════════════════════════ */

test('★★★ v1.195.0: a panel dark for more than 7 days keeps its onset across a restart — critical at once off-grid, "unreadable for 7 d", carried at its first projection', () => {
  withPath('dark-week.json', (path) => {
    const a = proc(T0);
    a.read(T0, UNKNOWN); // the pool unknown, then the panel goes dark
    const last = T0 + 7 * DAY + 60 * MIN;
    for (let t = T0 + 60 * MIN; t <= last; t += 60 * MIN) { a.at(t); a.s.markDeviceListAttempt(); }
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8'))[PANEL], { sinceMs: T0, lastSeenMs: last }, 'a 169 h span on file');
    assert.equal(blind(a.s, last)?.severity, 'critical', 'in the process the alarm stood');

    const boot = last + 2 * MIN; // a deploy
    const b = proc(boot);
    assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], '★ the entry is believed (7 d: dropped at the parse, nothing pending)');
    const dark = blindDark(b.s, boot + 3 * MIN, boot);
    assert.equal(dark?.severity, 'critical', '★ still critical, at once (7 d: absent, then a warning until boot + 60)');
    assert.match(dark!.detail, /unreadable for 7 d/);
    b.read(boot + 4 * MIN, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0, '★ carried at its first projection (7 d: boot + 4 min)');
    assert.equal(blind(b.s, boot + 4 * MIN)?.severity, 'critical');
  });
});

test('★★ v1.195.0: a dark panel whose carried alarm is raised is no longer pending — the alert set has it; one younger than 15 min is, until it is raised', () => {
  withPath('dark-raised.json', () => {
    const a = proc(T0);
    a.read(T0, UNKNOWN);
    for (let t = T0 + MIN; t <= T0 + 8 * MIN; t += MIN) { a.at(t); a.s.markDeviceListAttempt(); }
    const boot = T0 + 10 * MIN; // the onset is 10 min old at the boot: its alarm is not raised yet
    const b = proc(boot);
    assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], 'the store lists it');
    assert.deepEqual(pendingAt(b.s, boot, boot), [PENDING_LINE], 'pending: its first projection may raise the alarm');
    assert.equal(blindDark(b.s, boot, boot), undefined, 'not raised yet');
    assert.deepEqual(pendingAt(b.s, T0 + 15 * MIN - 1, boot), [PENDING_LINE], 'one millisecond short of 15 min: still pending');
    assert.deepEqual(pendingAt(b.s, T0 + 15 * MIN, boot), [], '★ at 15 min of the carried onset its alarm is raised: not pending (inclusive)');
    assert.equal(blindDark(b.s, T0 + 15 * MIN, boot)?.severity, 'warning', 'the alarm the set now holds');
    assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], 'the store still lists it: the rule is the alert set\'s');
    assert.deepEqual(debouncedOnsetsPending({ poolUnknownCarryPending: b.s.poolUnknownCarryPending() }, T0 + 15 * MIN), [PENDING_LINE],
      'a caller without the device map keeps every carried onset pending');
  });
});

test('★★ v1.195.0: the PINNED house panel dark since the restart has no reserve-blind alarm, so its carried onset stays pending until it reports — a week on too', () => {
  withPath('dark-house.json', () => {
    const a = proc(T0);
    a.read(T0, UNKNOWN);
    const last = T0 + 8 * DAY;
    for (let t = T0 + 60 * MIN; t <= last; t += 60 * MIN) { a.at(t); a.s.markDeviceListAttempt(); }
    const boot = last + 2 * MIN;
    const b = pinnedProc(boot);
    assert.equal(b.s.get().devices[PANEL].housePanel, true, 'the house panel');
    assert.equal(blindDark(b.s, boot + 3 * MIN, boot), undefined, 'no alarm describes its pool while it has no projection');
    assert.deepEqual(pendingAt(b.s, boot + 3 * MIN, boot), [PENDING_LINE], '★ so it stays pending: a green read now is not an all-clear');
    assert.deepEqual([...darkPanelBlindRaised(b.s.get().devices, { poolUnknownCarriedSinceBySn: b.s.poolUnknownCarried() }, boot + 3 * MIN)], []);
    b.read(boot + 4 * MIN, UNKNOWN);
    assert.deepEqual(b.s.poolUnknownCarryPending(), [], 'consumed by its first projection');
    assert.equal(blind(b.s, boot + 4 * MIN)?.severity, 'critical', 'which carries the 8-day onset');
  });
});

test('darkPanelBlindRaised — panels other than the house panel with no projection, once the earlier of the carried onset and the first listing has stood 15 min (inclusive)', () => {
  const OTHER = 'PANEXXX00XXX0002';
  const panel = (sn: string, extra: Record<string, unknown> = {}) => ({ sn, deviceName: sn, productName: 'Smart Home Panel 2', online: true, lastUpdated: 0, ...extra });
  const devices = { [PANEL]: panel(PANEL), [OTHER]: panel(OTHER) } as any;
  const now = T0;
  const raised = (conn: Record<string, unknown>, d = devices) => [...darkPanelBlindRaised(d, conn as any, now)].sort();
  assert.deepEqual(raised({ poolUnknownCarriedSinceBySn: new Map([[PANEL, now - 15 * MIN]]) }), [PANEL], 'carried: raised at 15 min');
  assert.deepEqual(raised({ poolUnknownCarriedSinceBySn: new Map([[PANEL, now - 15 * MIN + 1]]) }), []);
  assert.deepEqual(raised({ panelFirstListedBySn: new Map([[OTHER, now - 20 * MIN]]) }), [OTHER], 'no carried onset: from its first listing');
  assert.deepEqual(raised({ poolUnknownCarriedSinceBySn: new Map([[PANEL, now - MIN]]), panelFirstListedBySn: new Map([[PANEL, now - 20 * MIN]]) }), [PANEL],
    'the earlier of the two, as the alarm reads it');
  assert.deepEqual(raised({ poolUnknownCarriedSinceBySn: new Map([[PANEL, now - 60 * MIN]]) }, { ...devices, [PANEL]: panel(PANEL, { housePanel: true }) }), [],
    'the house panel: no alarm while dark');
  assert.deepEqual(raised({ poolUnknownCarriedSinceBySn: new Map([[PANEL, now - 60 * MIN]]) }, { [PANEL]: panel(PANEL, { projection: { kind: 'shp2' } }) }), [],
    'a projected panel is not dark: its own pool clock decides');
  assert.deepEqual(raised({}), [], 'no onset at all');
});

test('★★ v1.195.0: production wiring — the alert monitor hands debouncedOnsetsPending the device map computeAlerts reads', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'alertMonitor.ts'), 'utf8');
  assert.match(src, /debouncedOnsetsPending\(connectivity, liveAtMs, snap\.devices\)/);
  assert.match(src, /poolUnknownCarriedSinceBySn: store\.poolUnknownCarried\(\),/);
  assert.match(src, /panelFirstListedBySn: new Map\(/);
});

/* ══ v1.195.0: a pool-unknown file this process cannot keep current ════════════════════════════ */

/** v1.195.0 (review) — whether `dir` refuses a write, asked by WRITING, not by the unit under test
 *  (poolUnknownDirWritable): skipped on that function's word, a regression making it answer
 *  "writable" turned these tests into passing skips. Only a runner that can write a 0555 directory
 *  (root) makes them moot. */
function refusesWrites(dir: string): boolean {
  const probe = join(dir, '.write-probe');
  try {
    writeFileSync(probe, '');
  } catch {
    return true;
  }
  rmSync(probe, { force: true });
  return false;
}

test('★★★ v1.195.0: on a read-only /data a stale onset is not carried — no false off-grid critical "unreadable for 2 h" for a pool that read 29 min before the restart; the panel stays pending until it reports or its own alarm, timed from its first listing, stands', (t) => {
  const dir = join(tmp, 'rodata');
  mkdirSync(dir);
  withPath(join('rodata', 'pool-unknown.json'), (path) => {
    const a = blindUntil(T0 + 70 * MIN); // on file: since T0, last seen T0 + 70
    chmodSync(dir, 0o555); // /data read-only (EROFS's stand-in: no write, no unlink, reads work)
    try {
      if (!refusesWrites(dir)) { t.skip('the directory is still writable (running as root)'); return; }
      assert.equal(poolUnknownDirWritable(path), false, 'the store\'s own check sees it');
      a.read(T0 + 71 * MIN, READABLE); // the pool reads again: retired in memory, the save fails
      for (let t2 = T0 + 72 * MIN; t2 <= T0 + 99 * MIN; t2 += MIN) { a.read(t2, READABLE); a.s.markDeviceListAttempt(); }
      assert.ok(a.has('could not be removed either'), a.logs.join('\n'));
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8'))[PANEL], { sinceMs: T0, lastSeenMs: T0 + 70 * MIN }, 'the file still holds the retired onset');

      const boot = T0 + 100 * MIN;
      const b = proc(boot);
      assert.ok(b.has(`backup-pool: 1 pool-unknown onset(s) on file are not carried — ${dir} cannot be written (read-only?)`), b.logs.join('\n'));
      assert.equal(b.logs.filter((l) => l.includes('are not carried')).length, 1, 'said once');
      assert.deepEqual(b.s.poolUnknownCarryPending(), [PANEL], '★ still pending in the store (the alert set lets it go once its own alarm stands)');
      assert.equal(b.s.poolUnknownCarried().size, 0, 'but nothing carried');
      assert.equal(blindDark(b.s, boot, boot), undefined, 'dark: blind since its first listing, not since T0');
      assert.deepEqual(pendingAt(b.s, boot + 14 * MIN, boot), [PENDING_LINE], 'pending until its own alarm could stand');
      b.read(boot, UNKNOWN); // a partial delta: the pool unknown, no grace hold yet
      assert.equal(b.s.backupPoolUnknownSince(PANEL), boot, '★ the clock starts at its first projection (it carried T0)');
      assert.ok(!b.has('the reserve-blind clock carries it'));
      assert.equal(blind(b.s, boot), undefined, '★ no alarm at once (it was a critical "unreadable for 2 h")');
      b.read(boot + 15 * MIN, UNKNOWN);
      assert.equal(blind(b.s, boot + 15 * MIN)?.severity, 'warning', 'its own 15 minutes, then a warning');
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

test('★★ v1.195.0: an untrusted file\'s entries are never written back — once the directory can be written again, a restart carries nothing stale', (t) => {
  const dir = join(tmp, 'rodata-later');
  mkdirSync(dir);
  withPath(join('rodata-later', 'pool-unknown.json'), (path) => {
    blindUntil(T0 + 70 * MIN);
    chmodSync(dir, 0o555);
    let b: ReturnType<typeof proc>;
    try {
      if (!refusesWrites(dir)) { t.skip('the directory is still writable (running as root)'); return; }
      b = proc(T0 + 72 * MIN); // untrusted at construction
    } finally {
      chmodSync(dir, 0o755); // writable again (a remount) while the process runs
    }
    for (let t2 = T0 + 73 * MIN; t2 <= T0 + 80 * MIN; t2 += MIN) { b!.at(t2); b!.s.markDeviceListAttempt(); }
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {}, '★ the stale onset is not laundered into a fresh-looking entry');
    assert.deepEqual(b!.s.poolUnknownCarryPending(), [PANEL], 'still pending in this process until the panel reports');
    const c = proc(T0 + 82 * MIN);
    c.read(T0 + 82 * MIN, UNKNOWN);
    assert.equal(c.s.backupPoolUnknownSince(PANEL), T0 + 82 * MIN, 'a restart after it carries nothing stale');
  });
});

test('★ v1.195.0: a file in a writable directory is believed as before (the control)', () => {
  withPath('writable.json', (path) => {
    blindUntil(T0 + 70 * MIN);
    assert.equal(poolUnknownDirWritable(path), true);
    const b = proc(T0 + 72 * MIN);
    assert.ok(!b.has('are not carried'));
    b.read(T0 + 72 * MIN, UNKNOWN);
    assert.equal(b.s.backupPoolUnknownSince(PANEL), T0);
  });
});

test('poolUnknownDirWritable — the file\'s DIRECTORY, asked for write access; any refusal (EROFS, EACCES) is false', () => {
  const asked: Array<[string, number]> = [];
  assert.equal(poolUnknownDirWritable('/data/pool-unknown.json', (p, m) => { asked.push([p, m]); }), true);
  assert.deepEqual(asked, [['/data', 2]], 'W_OK on the directory');
  const refuse = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(poolUnknownDirWritable('/data/pool-unknown.json', refuse('EROFS')), false);
  assert.equal(poolUnknownDirWritable('/data/pool-unknown.json', refuse('EACCES')), false);
});

/* ══ the pure rules ════════════════════════════════════════════════════════════════════════ */

test('parsePoolUnknownOnsets — finite since ≤ last seen, per serial; anything else skipped', () => {
  assert.deepEqual([...parsePoolUnknownOnsets({ A: { sinceMs: 1, lastSeenMs: 2 } })], [['A', { sinceMs: 1, lastSeenMs: 2 }]]);
  assert.deepEqual([...parsePoolUnknownOnsets({ A: { sinceMs: 2, lastSeenMs: 2 } })], [['A', { sinceMs: 2, lastSeenMs: 2 }]], 'equal: one sighting');
  for (const bad of [null, 7, 'x', [], [{ sinceMs: 1, lastSeenMs: 2 }]]) assert.equal(parsePoolUnknownOnsets(bad).size, 0, JSON.stringify(bad));
  const m = parsePoolUnknownOnsets({
    ok: { sinceMs: 1, lastSeenMs: 2 },
    later: { sinceMs: 3, lastSeenMs: 2 },
    nan: { sinceMs: Number.NaN, lastSeenMs: 2 },
    str: { sinceMs: '1', lastSeenMs: 2 },
    noSeen: { sinceMs: 1 },
    nul: null,
    num: 5,
  });
  assert.deepEqual([...m.keys()], ['ok']);
  assert.equal(parsePoolUnknownOnsets({ A: { sinceMs: 0, lastSeenMs: POOL_UNKNOWN_MAX_EPISODE_MS } }).size, 1, 'an episode of exactly the bound');
  assert.equal(parsePoolUnknownOnsets({ A: { sinceMs: 0, lastSeenMs: POOL_UNKNOWN_MAX_EPISODE_MS + 1 } }).size, 0, '★ review: a longer one is not believed (corrupt or hand-edited)');
  // v1.195.0 — the bound is a year, not 7 days: a panel dark for weeks keeps its onset on file.
  assert.equal(POOL_UNKNOWN_MAX_EPISODE_MS, 366 * DAY);
  assert.equal(parsePoolUnknownOnsets({ A: { sinceMs: T0, lastSeenMs: T0 + 8 * DAY } }).size, 1, '★ v1.195.0: 8 days dark is believed (7 d: dropped)');
  assert.equal(parsePoolUnknownOnsets({ A: { sinceMs: 0, lastSeenMs: T0 } }).size, 0, 'an onset stamped by an unset clock (1970) is not');
});

test('carriedPoolUnknownSince — the onset when last seen at most the bound ago (inclusive), never later than now; else null', () => {
  const now = T0;
  assert.equal(carriedPoolUnknownSince(undefined, now), null);
  assert.equal(carriedPoolUnknownSince({ sinceMs: now - 90 * MIN, lastSeenMs: now - 2 * MIN }, now), now - 90 * MIN);
  assert.equal(carriedPoolUnknownSince({ sinceMs: now - 90 * MIN, lastSeenMs: now - POOL_UNKNOWN_CARRY_MAX_GAP_MS }, now), now - 90 * MIN, 'inclusive');
  assert.equal(carriedPoolUnknownSince({ sinceMs: now - 90 * MIN, lastSeenMs: now - POOL_UNKNOWN_CARRY_MAX_GAP_MS - 1 }, now), null);
  assert.equal(carriedPoolUnknownSince({ sinceMs: now + 5 * MIN, lastSeenMs: now + 6 * MIN }, now), now, 'a clock stepped back: never in the future');
  assert.equal(carriedPoolUnknownSince({ sinceMs: now - 10 * MIN, lastSeenMs: now - 3 * MIN }, now, 2 * MIN), null, 'the bound is a parameter');
  assert.equal(POOL_UNKNOWN_CARRY_MAX_GAP_MS, 60 * MIN);
  assert.equal(POOL_UNKNOWN_PERSIST_EVERY_MS, MIN);
});
