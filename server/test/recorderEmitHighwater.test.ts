import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.50.0 — the per-key emit high-water must survive a process restart so the
 * micro-dip clamp (clampLifetimeDip) keeps its baseline.
 *
 * Root cause being fixed: lifetimeEmitHighWater was an IN-MEMORY Map that reset
 * every restart. After a restart the FIRST emit had no high-water baseline, so
 * the live trapezoid could re-derive a value a few Wh BELOW what HA last
 * recorded pre-restart (e.g. circuit_8_energy 269.538 → 269.53), and HA's
 * total_increasing sensors logged "state is not strictly increasing". The fleet
 * battery floor survives restarts (it seeds from the persisted lifetime_totals
 * floor) — this emit high-water did not.
 *
 * Fix: persist lifetimeEmitHighWater to a `.emit-highwater.json` sidecar
 * (piggybacked on the 5-min rollup + on graceful close) and seed it on
 * construction. The sidecar is ADVISORY: missing/corrupt → empty map → exactly
 * the pre-v0.50.0 behavior (so it can only help, never regress).
 *
 * Hermetic: DB_PATH is fixed at module-load (config.ts captures it once), so all
 * recorders here share ONE db + ONE sidecar — exactly as a real restart over
 * /data shares both. Scenarios use a distinct key each and explicitly manage the
 * single sidecar file where the test needs it missing/corrupt.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-emithw-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const DB_PATH = process.env.DB_PATH!;
const SIDECAR = join(dirname(DB_PATH), '.emit-highwater.json');

// HA's pre-restart last-recorded value, in Wh (the bug's 269.538 kWh tile).
const LAST_EMITTED_WH = 269_538;

/** Force a key's persisted floor (prev.wh) + a past last_integrated_ts so the
 *  emit path uses it as `persisted` with watermark < now (pending integrates an
 *  empty series → 0). Mirrors the direct-INSERT technique in recorderLifetimeKeys. */
function setPersistedFloor(key: string, wh: number) {
  const raw = new DatabaseSync(DB_PATH);
  raw.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh, last_integrated_ts = excluded.last_integrated_ts`,
  ).run(key, wh, Date.now() - 60_000);
  raw.close();
}

const totalOf = (t: Record<string, { persistedWh: number; pendingWh: number }>, k: string) =>
  t[k].persistedWh + t[k].pendingWh;

// Each scenario uses a distinct snapshot-independent fleet watt key so the
// shared db/sidecar can't cross-contaminate assertions.
const KEY_HOLD = 'fleet_pv_wh';
const KEY_NOSIDE = 'fleet_load_wh';
const KEY_RESET = 'fleet_grid_import_wh';

test('WITHOUT a sidecar (missing) the same dip passes through — proves the sidecar is what fixes the bug', () => {
  rmSync(SIDECAR, { force: true }); // ensure no high-water baseline exists
  const rec = createRecorder(new SnapshotStore(), () => {});
  setPersistedFloor(KEY_NOSIDE, LAST_EMITTED_WH - 8);
  const t = rec.getLifetimeTotals();
  // No seeded baseline → clamp returns pending (0) → emits the lower value: the
  // exact "state is not strictly increasing" regression the sidecar prevents.
  assert.equal(totalOf(t, KEY_NOSIDE), LAST_EMITTED_WH - 8,
    'with no high-water baseline the first emit is unclamped (the bug) — confirming the sidecar is load-bearing');
  rec.close(); // now a sidecar exists
});

test('persisted emit high-water survives a restart: a ≤50 Wh would-be dip is clamped', () => {
  // Run 1: seed the persisted floor to HA's last value, emit once to set the
  // in-memory high-water, then close (persists .emit-highwater.json).
  {
    const rec = createRecorder(new SnapshotStore(), () => {});
    setPersistedFloor(KEY_HOLD, LAST_EMITTED_WH);
    const t1 = rec.getLifetimeTotals();
    assert.equal(totalOf(t1, KEY_HOLD), LAST_EMITTED_WH, 'run-1 emit equals the persisted floor (no samples → pending 0)');
    rec.close();
  }
  assert.ok(existsSync(SIDECAR), 'close() must persist the emit high-water sidecar next to the db');

  // Run 2 (restart over the SAME db + sidecar): simulate the live trapezoid
  // re-deriving 8 Wh LOWER (269.538 → 269.530). Without a restored high-water
  // the first emit would dip below HA's last value; the seeded high-water holds.
  setPersistedFloor(KEY_HOLD, LAST_EMITTED_WH - 8);
  const rec2 = createRecorder(new SnapshotStore(), () => {});
  const t2 = rec2.getLifetimeTotals();
  assert.equal(
    totalOf(t2, KEY_HOLD), LAST_EMITTED_WH,
    `≤50 Wh dip must be clamped to HA's last value via the restored high-water; got ${totalOf(t2, KEY_HOLD)}`,
  );
  rec2.close();
});

test('a genuine reset (>50 Wh drop) still passes through across a restart', () => {
  {
    const rec = createRecorder(new SnapshotStore(), () => {});
    setPersistedFloor(KEY_RESET, LAST_EMITTED_WH);
    rec.getLifetimeTotals(); // high-water = LAST_EMITTED_WH
    rec.close();
  }
  // 538 Wh drop (> maxDipWh 50) — a real re-zero / DB wipe must NOT be clamped.
  setPersistedFloor(KEY_RESET, LAST_EMITTED_WH - 538);
  const rec2 = createRecorder(new SnapshotStore(), () => {});
  const t = rec2.getLifetimeTotals();
  assert.equal(totalOf(t, KEY_RESET), LAST_EMITTED_WH - 538,
    'a >50 Wh drop is a genuine reset and must pass through unclamped even with a restored high-water');
  rec2.close();
});

test('a corrupt sidecar degrades to empty (no throw) → pre-v0.50.0 behavior', () => {
  writeFileSync(SIDECAR, '{ this is not valid json', 'utf8');
  // Construction must not throw; the high-water starts empty, so a fresh key
  // with a lower floor than its (nonexistent) baseline emits unclamped.
  let rec: ReturnType<typeof createRecorder> | undefined;
  assert.doesNotThrow(() => { rec = createRecorder(new SnapshotStore(), () => {}); },
    'a corrupt sidecar must never block startup');
  // Use a never-before-seen key so there is no prior high-water for it anywhere.
  const KEY_CORRUPT = 'fleet_grid_home_wh';
  setPersistedFloor(KEY_CORRUPT, LAST_EMITTED_WH - 8);
  const t = rec!.getLifetimeTotals();
  assert.equal(totalOf(t, KEY_CORRUPT), LAST_EMITTED_WH - 8,
    'corrupt sidecar → empty high-water → unclamped first emit (pre-v0.50.0 behavior)');
  rec!.close();
});
