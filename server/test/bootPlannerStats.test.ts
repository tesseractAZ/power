import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.156.0 — planner statistics at boot, DRIVEN against a real node:sqlite database.
 *
 * v1.153.0 bounded the boot `ANALYZE samples` with `PRAGMA analysis_limit=400`, and a
 * source-order test pinned the bound. The pragma was applied, and it bounded the wrong
 * cost: ANALYZE takes an exact count of each index first, which reads every page, so the
 * next boot after an image pull still spent 10,785 ms in it — with no HTTP listener,
 * MQTT ingest, poll or alarm evaluation for all of it. The stats it wrote were truncated
 * too. The boot now runs only the ANALYZE that `PRAGMA optimize=0x03` lists (a table
 * with an index that has NO statistics) and logs what ran.
 *
 * Hermetic: a fresh DB_PATH captured at import (config.ts reads it once). The tests run
 * in file order against one database, as restarts share /data/ecoflow.db.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-stats-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = join(tmp, 'ecoflow.db');
const __dir = dirname(fileURLToPath(import.meta.url));

const { createRecorder, SEED_SQL } = await import('../src/recorder.js');

const ROWS = 5_000;
const SNS = ['CORE_A', 'CORE_B'];
const METRICS = ['soc', 'pv_w', 'load_w', 'grid_w', 'temp_c', 'volt_v', 'amp_a'];
const COMPOSITE = 'idx_samples_sn_metric_ts';
const TS_INDEX = 'idx_samples_ts';

function makeStore() {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: 0, devices: {} };
  ee.get = () => ee.snap;
  return ee;
}
function boot(): string[] {
  const lines: string[] = [];
  const rec = createRecorder(makeStore() as any, (m: string) => lines.push(m));
  rec.close();
  return lines;
}
function statsLine(lines: string[]): string {
  const found = lines.filter((l) => l.startsWith('recorder: planner stats — '));
  assert.equal(found.length, 1, `exactly one planner-stats line per boot, got: ${found.join(' | ') || '(none)'}`);
  return found[0];
}
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
/** idx → stat for `samples`; null while sqlite_stat1 does not exist. */
function samplesStats(): Record<string, string> | null {
  return withDb((db) => {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).get()) return null;
    const rows = db.prepare(`SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'samples'`).all() as Array<{ idx: string; stat: string }>;
    return Object.fromEntries(rows.map((r) => [r.idx, r.stat]));
  });
}
function setSamplesStats(stats: Record<string, string> | null) {
  withDb((db) => {
    db.exec(`DELETE FROM sqlite_stat1 WHERE tbl = 'samples'`);
    if (!stats) return;
    const ins = db.prepare(`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('samples', ?, ?)`);
    for (const [idx, stat] of Object.entries(stats)) ins.run(idx, stat);
  });
}

/* ── the boot decision ──────────────────────────────────────────────── */

test('a first boot on an empty database plans no ANALYZE and creates no statistics', () => {
  const line = statsLine(boot());
  assert.match(line, /, PRAGMA optimize planned no ANALYZE$/, line);
  // SQLite leaves empty tables out of sqlite_stat1, so there is nothing to refresh yet.
  assert.equal(samplesStats(), null, 'no ANALYZE ran, so sqlite_stat1 does not exist');
});

test('the planner-stats line names the SQLite this process actually linked', () => {
  // The add-on's node links Alpine's system SQLite, not a bundled one. The version is
  // what decides which PRAGMA optimize masks exist, so the boot log has to say it.
  const line = statsLine(boot());
  const linked = withDb((db) => (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
  assert.ok(line.startsWith(`recorder: planner stats — SQLite ${linked}, `), `${line} (linked: ${linked})`);
});

test('★ an index with NO statistics is analyzed at boot — in full, not under a sampling bound', () => {
  withDb((db) => {
    const now = Date.now();
    const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < ROWS; i++) ins.run(now - (ROWS - i) * 1000, SNS[i % SNS.length], METRICS[i % METRICS.length], i);
    db.exec('COMMIT');
  });
  const line = statsLine(boot());
  assert.match(line, /ran (\d+)\/\1: .*ANALYZE "main"\."samples"/, `the refresh must run, and say so: ${line}`);
  const stats = samplesStats();
  assert.ok(stats?.[COMPOSITE] && stats?.[TS_INDEX], `both samples indexes analyzed: ${JSON.stringify(stats)}`);
  // 5,000 rows over 2 SNs: 2,500 per SN. Under analysis_limit=400 SQLite writes
  // "5000 401 …" — the truncated stats every boot from v1.153.0 to v1.155.0 wrote.
  assert.deepEqual(stats[COMPOSITE].split(' ').slice(0, 2), [String(ROWS), String(ROWS / SNS.length)], stats[COMPOSITE]);
  assert.equal(stats[TS_INDEX].split(' ')[0], String(ROWS), stats[TS_INDEX]);
});

test('★★ indexes that already have statistics are NOT re-analyzed at boot — even 100× stale', () => {
  // Stats claiming 50 rows against 5,000. SQLite's own 10× size rule (PRAGMA optimize
  // mask 0x10000) would refresh these, and on the live table that rule fires as a full
  // ANALYZE — every index page read — on the alarm path, for plans the stats do not
  // change (see the plan test below).
  const stale = { [COMPOSITE]: '50 25 4 1', [TS_INDEX]: '50 1' };
  setSamplesStats(stale);
  const line = statsLine(boot());
  assert.doesNotMatch(line, /"samples"/, `samples must not be re-analyzed: ${line}`);
  assert.deepEqual(samplesStats(), stale, 'the boot must leave existing samples statistics exactly as it found them');
});

/** Boot while another connection holds the write lock, as a stray writer would. */
function bootWithWriteLockHeld(): string[] {
  const holder = new DatabaseSync(DB_PATH);
  holder.exec('BEGIN IMMEDIATE');
  let lines: string[] = [];
  try {
    // A refresh that fails must cost the planner its statistics, never the add-on its boot.
    assert.doesNotThrow(() => { lines = boot(); }, 'a planner-stats failure must not take the boot down');
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  return lines;
}

test('★ an ANALYZE that cannot take the write lock is reported, claims nothing, and the boot completes', () => {
  // Give every OTHER index statistics, so samples is the only table to refresh. SQLite
  // then lists it read-only, and the ANALYZE itself meets the lock.
  withDb((db) => {
    db.exec(`DELETE FROM sqlite_stat1 WHERE tbl = 'samples'`);
    const bare = db.prepare(
      `SELECT tbl_name AS tbl, name AS idx FROM sqlite_master
        WHERE type = 'index' AND tbl_name <> 'samples'
          AND name NOT IN (SELECT idx FROM sqlite_stat1 WHERE idx IS NOT NULL)`,
    ).all() as Array<{ tbl: string; idx: string }>;
    const ins = db.prepare(`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, '1 1')`);
    for (const b of bare) ins.run(b.tbl, b.idx);
  });
  const line = statsLine(bootWithWriteLockHeld());
  assert.match(line, /, refresh FAILED while running \(.+\), ran 0\/1$/,
    `the failure is reported with its step, and no ANALYZE is named as run: ${line}`);
  assert.equal(Object.keys(samplesStats() ?? {}).length, 0, 'and nothing was written');
});

test('★ a refresh that fails while LISTING is a failure — never "planned no ANALYZE"', () => {
  // With two or more tables to check, PRAGMA optimize opens a write transaction just to
  // list them (pragma.c, nCheck==2). The first draft of this code caught that error with
  // nothing planned, and its boot line read "PRAGMA optimize planned no ANALYZE".
  withDb((db) => db.exec(`DELETE FROM sqlite_stat1`));
  const line = statsLine(bootWithWriteLockHeld());
  assert.match(line, /, refresh FAILED while (planning|running) \(.+\), ran 0\/\d+$/, line);
  assert.doesNotMatch(line, /planned no ANALYZE/, `a failure must not read as a decision: ${line}`);
});

/* ── why stale statistics are left alone ─────────────────────────────── */

const R = 'recorder.ts';
const RR = 'readRecorder.ts';
const RANGE = 'WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ?';
const MULTI = 'WHERE sn = ? AND metric IN (${placeholders}) AND ts >= ? AND ts <= ?';
type Shape = { name: string; sql: string; params: Array<string | number>; sites: Array<[file: string, fragment: string]> };
const T0 = 1_700_000_000_000;
const T1 = T0 + 86_400_000;

// Every statement that READS `samples` (each `FROM samples`), with the source text it was
// copied from. The fragments are checked against the source and the sites are counted, so a
// new query of samples fails this test until its plan has been checked here. Writes need no
// entry: the INSERT has no plan to choose, and an UPDATE by rowid has exactly one.
const SHAPES: Shape[] = [
  { name: 'restart probe', sql: 'SELECT MAX(ts) AS maxTs FROM samples WHERE sn NOT IN (?, ?, ?, ?)',
    params: ['WEATHER', 'FORECAST', 'NIGHT_CHARGE', 'SPARE'], sites: [[R, 'SELECT MAX(ts) AS maxTs FROM samples WHERE sn NOT IN (']] },
  { name: 'retention prune', sql: 'DELETE FROM samples WHERE ts < ?', params: [T0], sites: [[R, '`DELETE FROM samples WHERE ts < ?`']] },
  { name: 'query', sql: `SELECT ts, value FROM samples ${RANGE} ORDER BY ts ASC`, params: ['CORE_A', 'soc', T0, T1],
    sites: [[R, `SELECT ts, value FROM samples ${RANGE} ORDER BY ts ASC\``], [RR, `SELECT ts, value FROM samples ${RANGE} ORDER BY ts ASC\``]] },
  { name: 'queryFirst', sql: `SELECT ts, value FROM samples ${RANGE} ORDER BY ts ASC LIMIT 1`, params: ['CORE_A', 'soc', T0, T1],
    sites: [[R, `${RANGE} ORDER BY ts ASC LIMIT 1\``], [RR, `${RANGE} ORDER BY ts ASC LIMIT 1\``]] },
  { name: 'queryLast', sql: `SELECT ts, value FROM samples ${RANGE} ORDER BY ts DESC LIMIT 1`, params: ['CORE_A', 'soc', T0, T1],
    sites: [[R, `${RANGE} ORDER BY ts DESC LIMIT 1\``], [RR, `${RANGE} ORDER BY ts DESC LIMIT 1\``]] },
  { name: 'queryBucketed', sql: `SELECT CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value FROM samples ${RANGE} GROUP BY bucket_ts ORDER BY bucket_ts ASC`,
    params: [300_000, 300_000, 'CORE_A', 'soc', T0, T1],
    sites: [[R, `FROM samples ${RANGE} GROUP BY bucket_ts ORDER BY bucket_ts ASC\``], [RR, `FROM samples ${RANGE} GROUP BY bucket_ts ORDER BY bucket_ts ASC\``]] },
  { name: 'metrics', sql: 'SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC', params: ['CORE_A'],
    sites: [[R, '`SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC`'], [RR, '`SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC`']] },
  { name: 'queryMulti (bucketed)',
    sql: 'SELECT metric, CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value FROM samples WHERE sn = ? AND metric IN (?, ?, ?) AND ts >= ? AND ts <= ? GROUP BY metric, bucket_ts ORDER BY metric ASC, bucket_ts ASC',
    params: [300_000, 300_000, 'CORE_A', 'soc', 'pv_w', 'load_w', T0, T1],
    sites: [[R, `FROM samples ${MULTI} GROUP BY metric, bucket_ts ORDER BY metric ASC, bucket_ts ASC\``], [RR, `FROM samples ${MULTI} GROUP BY metric, bucket_ts ORDER BY metric ASC, bucket_ts ASC\``]] },
  { name: 'queryMulti (raw)',
    sql: 'SELECT metric, ts, value FROM samples WHERE sn = ? AND metric IN (?, ?, ?) AND ts >= ? AND ts <= ? ORDER BY metric ASC, ts ASC',
    params: ['CORE_A', 'soc', 'pv_w', 'load_w', T0, T1],
    sites: [[R, `SELECT metric, ts, value FROM samples ${MULTI} ORDER BY metric ASC, ts ASC\``], [RR, `SELECT metric, ts, value FROM samples ${MULTI} ORDER BY metric ASC, ts ASC\``]] },
  { name: 'weather sample exists', sql: 'SELECT 1 FROM samples WHERE sn = ? AND metric = ? AND ts = ? LIMIT 1', params: ['WEATHER', 'ghi_wm2', T0],
    sites: [[R, '`SELECT 1 FROM samples WHERE sn = ? AND metric = ? AND ts = ? LIMIT 1`']] },
  { name: 'weather previous value', sql: 'SELECT value FROM samples WHERE sn = ? AND metric = ? AND ts < ? ORDER BY ts DESC LIMIT 1', params: ['WEATHER', 'ghi_wm2', T0],
    sites: [[R, '`SELECT value FROM samples WHERE sn = ? AND metric = ? AND ts < ? ORDER BY ts DESC LIMIT 1`']] },
  ...Object.entries(SEED_SQL).map(([name, sql]): Shape => ({
    name: `seed ${name}`, sql, params: (sql.match(/\?/g) ?? []).map(() => 'x'), sites: [[R, `'${sql}'`]],
  })),
];

const squash = (s: string) => s.replace(/\s+/g, ' ');
const source = (file: string) => readFileSync(resolve(__dir, '../src', file), 'utf8');

test('the plan test below covers every statement that reads samples', () => {
  for (const file of [R, RR]) {
    const code = source(file).split('\n').filter((l) => !/^\s*(\/\/|\*|--)/.test(l)).join('\n');
    const inCode = code.split('FROM samples').length - 1;
    const listed = SHAPES.flatMap((s) => s.sites).filter(([f]) => f === file);
    assert.equal(inCode, listed.length,
      `${file} has ${inCode} statements reading samples (FROM samples) and this test lists ${listed.length}: add the new one to SHAPES and check its plan does not depend on statistics`);
    const flat = squash(source(file));
    for (const [, fragment] of listed) {
      assert.equal(flat.split(squash(fragment)).length - 1, 1, `${file} must contain, exactly once: ${fragment}`);
    }
  }
});

test('★ every statement that reads samples plans the same with no, full or truncated statistics', () => {
  // This is why the boot leaves existing statistics alone. Each statement has equality on
  // (sn, metric), a range on ts alone, or an INDEXED BY, so there is no choice for the
  // statistics to make. The production-size rows are the live database's own: full from a
  // 2026-09-07 snapshot (15.8 M rows), truncated as read back after the v1.155.0 boot.
  const plans = () => withDb((db) => Object.fromEntries(SHAPES.map((s) => [s.name,
    (db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.params) as Array<{ detail: string }>).map((r) => r.detail)])));
  const variants: Array<[label: string, apply: () => void]> = [
    ['full ANALYZE', () => withDb((db) => db.exec('PRAGMA analysis_limit=0; ANALYZE samples;'))],
    ['analysis_limit=400', () => withDb((db) => db.exec('PRAGMA analysis_limit=400; ANALYZE samples;'))],
    ['production-size, full', () => setSamplesStats({ [COMPOSITE]: '15787390 1973424 27649 1', [TS_INDEX]: '15787390 5' })],
    ['production-size, truncated', () => setSamplesStats({ [COMPOSITE]: '17548271 401 401 1', [TS_INDEX]: '17548271 7' })],
  ];

  setSamplesStats(null);
  const baseline = plans();
  const seen: string[] = [];
  for (const [label, apply] of variants) {
    apply();
    seen.push(JSON.stringify(samplesStats()));
    const got = plans();
    for (const s of SHAPES) {
      for (const detail of got[s.name]) assert.doesNotMatch(detail, /^SCAN samples\b/, `${s.name} under ${label}: ${detail}`);
      assert.deepEqual(got[s.name], baseline[s.name], `${s.name} changed plan under ${label}`);
    }
  }
  // A variant that did not change the statistics would prove nothing.
  assert.equal(new Set(seen).size, variants.length, `each variant must install different statistics: ${seen.join(' | ')}`);
});

/* ── position ───────────────────────────────────────────────────────── */

test('position pin — the refresh is timed by the analyze phase, and it is the only ANALYZE', () => {
  // A SOURCE assertion, labelled as one. The phases are chained from one clock, so no
  // behavioural check can tell which phase a statement landed in; position is the
  // property. Comment lines are stripped so the history in them cannot satisfy it.
  const code = source(R).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const schema = code.indexOf("const tSchema = phase('schema+migrations');");
  const optimize = code.indexOf('PRAGMA optimize=');
  const analyze = code.indexOf("const tAnalyze = phase('analyze');");
  assert.ok(schema > 0 && schema < optimize && optimize < analyze,
    `schema+migrations (${schema}) < PRAGMA optimize (${optimize}) < analyze (${analyze})`);
  assert.equal(code.split('PRAGMA optimize=').length - 1, 1, 'exactly one PRAGMA optimize');
  assert.doesNotMatch(code, /db\.exec\(`\s*ANALYZE/, 'no hand-written ANALYZE — the boot runs only what PRAGMA optimize lists');
});
