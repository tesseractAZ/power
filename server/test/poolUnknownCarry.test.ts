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
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
} = await import('../src/snapshot.js');
const { computeAlerts } = await import('../src/alerts.js');

const SEC = 1_000;
const MIN = 60_000;
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
