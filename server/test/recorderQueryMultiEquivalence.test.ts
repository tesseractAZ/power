import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.24.3 — pins the exact invariant the curtailment N+1 batching relies on:
 * `recorder.queryMulti(sn, metrics, a, b, bucket).get(m)` is BYTE-IDENTICAL to
 * `recorder.query(sn, m, a, b, bucket)` for every metric, for both bucketed and
 * raw reads, across an inclusive hour boundary with sub-minute cadence and
 * same-60s-bucket averaging.
 *
 * computeCurtailment's sampleCurtailmentHour now batches each home DPU's three
 * per-hour metrics (soc / chg_max_soc / pv_total) through ONE queryMulti instead
 * of three query() calls. That swap is behaviour-preserving iff this invariant
 * holds — and queryMulti is already the batched-equivalent primitive at 9 other
 * analytics call sites, so this also guards those.
 */

// Throwaway DB, set BEFORE importing the recorder (→ config.ts reads DB_PATH at
// module load; node's per-file test isolation keeps this hermetic).
const tmp = mkdtempSync(join(tmpdir(), 'ef-qm-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000 - (1_700_000_000_000 % HOUR); // top of hour
const SN = 'DPU1';
const METRICS = ['soc', 'chg_max_soc', 'pv_total'];

// Sample rows [ts, sn, metric, value] chosen to exercise: multiple 60s buckets,
// TWO samples in the same bucket (AVG), a sample EXACTLY on the start boundary,
// one EXACTLY on the end boundary (inclusive-both-ends), and samples just
// outside the window on both sides. 'chg_max_soc' is intentionally sparse and
// 'pv_total' has the same-bucket pair; 'unused_metric' has no rows at all.
const rows: Array<[number, string, string, number]> = [
  [BASE - 30_000, SN, 'soc', 10], // before window — must be excluded
  [BASE + 0, SN, 'soc', 50], // exactly on start boundary
  [BASE + 20_000, SN, 'soc', 51], // same 60s bucket as the boundary sample → AVG
  [BASE + 90_000, SN, 'soc', 55],
  [BASE + 1_805_000, SN, 'soc', 70],
  [BASE + HOUR, SN, 'soc', 88], // exactly on end boundary → included (inclusive)
  [BASE + HOUR + 40_000, SN, 'soc', 99], // after window — must be excluded

  [BASE + 5_000, SN, 'chg_max_soc', 100],
  [BASE + 1_800_000, SN, 'chg_max_soc', 100],

  [BASE + 12_000, SN, 'pv_total', 2000],
  [BASE + 48_000, SN, 'pv_total', 2400], // same 60s bucket as 12s → AVG 2200
  [BASE + 600_000, SN, 'pv_total', 3100],
  [BASE + HOUR - 1, SN, 'pv_total', 2800],
];

// ONE recorder, seeded ONCE. createRecorder creates the `samples` schema; we
// then raw-insert via a second connection to the same file (WAL → the recorder's
// reads see the commits). Seeding per-test against the shared persistent DB would
// double-insert and create duplicate-ts rows whose SQLite secondary-sort tiebreak
// is undefined — an artifact, not a real query/queryMulti discrepancy.
const rec = createRecorder(new SnapshotStore(), () => {});
{
  const raw = new DatabaseSync(process.env.DB_PATH!);
  const ins = raw.prepare('INSERT INTO samples (ts,sn,metric,value) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(...r);
  raw.close();
}

// query() and queryMulti() build their row objects slightly differently (row
// prototype / column shape), but the {ts, value} DATA is what every consumer
// reads — meanInWindow uses only `.value`, the charts use ts+value. Normalize to
// plain {ts, value} so we assert the behaviour-relevant data, not sqlite's row
// representation. Equal ts+value sequences ⇒ identical means/integrals.
const data = (pts: Array<{ ts: number; value: number }>) => pts.map((p) => ({ ts: p.ts, value: p.value }));

test('queryMulti(...).get(m) ≡ query(...) data — bucketed (60s) over an inclusive hour', () => {
  const a = BASE, b = BASE + HOUR, bucket = 60;
  const multi = rec.queryMulti(SN, [...METRICS, 'unused_metric'], a, b, bucket);
  for (const m of METRICS) {
    assert.deepEqual(data(multi.get(m)!), data(rec.query(SN, m, a, b, bucket)), `bucketed mismatch for ${m}`);
  }
  // A no-data metric must be an empty array in BOTH (never undefined), so the
  // `?? query()` fallback in meanInWindow stays unreachable for batched metrics.
  assert.deepEqual(multi.get('unused_metric'), []);
  assert.deepEqual(rec.query(SN, 'unused_metric', a, b, bucket), []);
});

test('queryMulti(...).get(m) ≡ query(...) data — raw (unbucketed)', () => {
  const a = BASE, b = BASE + HOUR;
  const multi = rec.queryMulti(SN, METRICS, a, b);
  for (const m of METRICS) {
    assert.deepEqual(data(multi.get(m)!), data(rec.query(SN, m, a, b)), `raw mismatch for ${m}`);
  }
});

test('cleanup', () => {
  rec.close();
});
