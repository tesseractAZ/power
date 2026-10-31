import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.50.0 — the per-key emit high-water must survive a process restart so the
 * micro-dip clamp (v1.193.0: the publish guard, guardLifetimeEmit) keeps its baseline.
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
const { haTotalIncreasing } = await import('./helpers/haTotalIncreasing.js');

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
/** v1.193.0 — the guard's WARN line for a drop it rebases. */
const warnsOf = (lines: string[], key: string) => lines.filter((l) => l.includes(`WARN lifetime counter ${key}`));

// Each scenario uses a distinct snapshot-independent fleet watt key so the
// shared db/sidecar can't cross-contaminate assertions.
const KEY_HOLD = 'fleet_pv_wh';
const KEY_NOSIDE = 'fleet_load_wh';
// v1.188.1 — fleet_pv_wh and fleet_grid_import_wh (LIFETIME_HOLD_KEYS) hold a dip up to 5 kWh, so
// the >50 Wh reset scenario runs on Home Consumption (its floor is set explicitly at the start).
// v1.193.0 — every key holds a dip up to 5 kWh (LIFETIME_HOLD_DIP_WH); Home Consumption is the key
// the v1.188.1 hold did not cover.
const KEY_RESET = 'fleet_load_wh';
const KEY_BRIDGED = 'fleet_grid_import_wh';

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

// v1.193.0 — changed: this test asserted that a 538 Wh drop across a restart "passes through" as a
// genuine reset. Home Assistant books a drop of 10 % or more as a meter reset (the whole new reading
// again) and a smaller one as a negative hour; neither is a reset of the energy. Every key now holds
// a dip up to LIFETIME_HOLD_DIP_WH: never counted twice, and no basis shift.
test('v1.193.0 — a 538 Wh drop across a restart is HELD at the last published value on Home Consumption (no shift, no warning)', () => {
  {
    const rec = createRecorder(new SnapshotStore(), () => {});
    setPersistedFloor(KEY_RESET, LAST_EMITTED_WH);
    rec.getLifetimeTotals(); // high-water = LAST_EMITTED_WH
    rec.close();
  }
  setPersistedFloor(KEY_RESET, LAST_EMITTED_WH - 538);
  const lines: string[] = [];
  const rec2 = createRecorder(new SnapshotStore(), (m: string) => lines.push(m));
  const t = rec2.getLifetimeTotals();
  assert.equal(totalOf(t, KEY_RESET), LAST_EMITTED_WH, 'held at the last published value (was: the drop published)');
  assert.equal(t[KEY_RESET].shiftWh, 0, 'a held dip is no basis shift: the energy arrives later and is counted once');
  assert.equal(t[KEY_RESET].heldWh, 538, 'the guard holds the 538 Wh');
  assert.deepEqual(warnsOf(lines, KEY_RESET), [], 'no warning for a held dip');
  // The row catches up by 600 Wh: the published value rises by 62 Wh, not 600 (no double count).
  setPersistedFloor(KEY_RESET, LAST_EMITTED_WH + 62);
  const t2 = rec2.getLifetimeTotals();
  assert.equal(totalOf(t2, KEY_RESET), LAST_EMITTED_WH + 62);
  assert.equal(t2[KEY_RESET].heldWh, 0);
  rec2.close();
});

// v1.193.0 — changed: "a re-zero passes through" became a continuation. A replaced database restarts
// the row near 0 while the sidecar keeps the last published value: the counter continues from it,
// the difference carried as a basis shift (lifetime_basis) that survives the next restart.
test('v1.188.1 — Grid to Battery Charge (an energy-bridge counter) holds a dip up to 5 kWh across a restart; v1.193.0 — a re-zero continues from the last value', () => {
  {
    const rec = createRecorder(new SnapshotStore(), () => {});
    setPersistedFloor(KEY_BRIDGED, LAST_EMITTED_WH);
    rec.getLifetimeTotals();
    rec.close();
  }
  setPersistedFloor(KEY_BRIDGED, LAST_EMITTED_WH - 538);
  let rec2 = createRecorder(new SnapshotStore(), () => {});
  assert.equal(totalOf(rec2.getLifetimeTotals(), KEY_BRIDGED), LAST_EMITTED_WH, 'a 538 Wh dip is held');
  rec2.close();
  setPersistedFloor(KEY_BRIDGED, 100); // a replaced database
  const lines: string[] = [];
  rec2 = createRecorder(new SnapshotStore(), (m: string) => lines.push(m));
  const t = rec2.getLifetimeTotals();
  assert.equal(totalOf(t, KEY_BRIDGED), LAST_EMITTED_WH, 'the re-zero continues from the last published value (was: 100 Wh published, a meter reset)');
  assert.equal(t[KEY_BRIDGED].shiftWh, LAST_EMITTED_WH - 100, 'the drop is the basis shift');
  {
    // Written at once, not left for the next rollup: a crash before it would lose the shift.
    const raw = new DatabaseSync(DB_PATH);
    const r = raw.prepare(`SELECT shift_wh, reason FROM lifetime_basis WHERE metric_key = ?`).get(KEY_BRIDGED) as { shift_wh: number; reason: string } | undefined;
    raw.close();
    assert.deepEqual(r && { ...r }, { shift_wh: LAST_EMITTED_WH - 100, reason: 'unexplained drop' });
  }
  assert.equal(t[KEY_BRIDGED].heldWh, 0);
  assert.equal(warnsOf(lines, KEY_BRIDGED).length, 1, 'one warning names the counter');
  assert.match(warnsOf(lines, KEY_BRIDGED)[0], /269\.438 kWh below the 269\.538 kWh last published/);
  rec2.getLifetimeTotals();
  assert.equal(warnsOf(lines, KEY_BRIDGED).length, 1, 'once: the next read continues without a new drop');
  rec2.close();
  // The shift survives a restart; the row's growth is published on top of it.
  setPersistedFloor(KEY_BRIDGED, 150);
  rec2 = createRecorder(new SnapshotStore(), () => {});
  assert.equal(totalOf(rec2.getLifetimeTotals(), KEY_BRIDGED), LAST_EMITTED_WH + 50, 'the row\'s +50 Wh on top of the persisted shift');
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

test('v1.193.0 — the sidecar is written to a .tmp and renamed: a failed write leaves the previous file whole', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  setPersistedFloor(KEY_HOLD, LAST_EMITTED_WH);
  rec.getLifetimeTotals();
  rec.close();
  const before = readFileSync(SIDECAR, 'utf8');
  assert.equal(JSON.parse(before)[KEY_HOLD], LAST_EMITTED_WH);
  assert.equal(existsSync(`${SIDECAR}.tmp`), false, 'no .tmp left behind');
  // The .tmp path is blocked (a directory): the write fails before the rename.
  mkdirSync(`${SIDECAR}.tmp`);
  const lines: string[] = [];
  const rec2 = createRecorder(new SnapshotStore(), (m: string) => lines.push(m));
  try {
    setPersistedFloor(KEY_HOLD, LAST_EMITTED_WH + 1_000);
    rec2.getLifetimeTotals();
    rec2.rollupLifetime(); // persists the high-water
    assert.ok(lines.some((l) => l.includes('failed to persist emit high-water')), 'the failure is logged');
    assert.equal(readFileSync(SIDECAR, 'utf8'), before, 'the previous file is untouched, never truncated');
  } finally {
    rmSync(`${SIDECAR}.tmp`, { recursive: true, force: true });
    rec2.close();
  }
  assert.ok(JSON.parse(readFileSync(SIDECAR, 'utf8'))[KEY_HOLD] >= LAST_EMITTED_WH + 1_000, 'the next write lands');
  assert.equal(existsSync(`${SIDECAR}.tmp`), false);
});

// v1.193.0 — the 2026-06-08 shape: every counter read 0 for an hour, then its old value, and Home
// Assistant booked each one twice. The drop the guard continued from is owed (lifetime_basis.owed_wh)
// and taken back when the counter climbs back, in the same process or after a restart.
test('v1.193.0 — a counter that reads 0 and then its old value is published continuously: the drop is taken back, never booked twice (also across a restart)', () => {
  // Last in the file: the corrupt-sidecar test needs this key never seen before it.
  const KEY = 'fleet_grid_home_wh';
  const H = 812_345;
  const basisRow = () => {
    const raw = new DatabaseSync(DB_PATH);
    const r = raw.prepare(`SELECT shift_wh, owed_wh, reason FROM lifetime_basis WHERE metric_key = ?`).get(KEY) as { shift_wh: number; owed_wh: number; reason: string } | undefined;
    raw.close();
    return r && { ...r };
  };
  const lines: string[] = [];
  const pub: number[] = [];
  let rec = createRecorder(new SnapshotStore(), (m: string) => lines.push(m));
  setPersistedFloor(KEY, H);
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  setPersistedFloor(KEY, 0); // the hour it read 0
  let t = rec.getLifetimeTotals();
  pub.push(totalOf(t, KEY));
  assert.equal(totalOf(t, KEY), H);
  assert.equal(t[KEY].shiftWh, H, 'continued from the last value');
  assert.deepEqual(basisRow(), { shift_wh: H, owed_wh: H, reason: 'unexplained drop' }, 'the drop is owed, written at once');
  setPersistedFloor(KEY, H + 50); // back, plus 50 Wh of new energy
  t = rec.getLifetimeTotals();
  pub.push(totalOf(t, KEY));
  assert.equal(totalOf(t, KEY), H + 50, 'the return is not energy: H + 50 Wh, not 2H + 50 Wh');
  assert.equal(t[KEY].shiftWh, 0, 'the shift is taken back');
  assert.deepEqual(basisRow(), { shift_wh: 0, owed_wh: 0, reason: 'unexplained drop returned' });
  assert.ok(lines.some((l) => l.includes(`lifetime counter ${KEY} climbed back 812.345 kWh of an unexplained drop`)), 'the take-back is logged');
  // Across a restart: the drop before it, the return after it.
  setPersistedFloor(KEY, 0);
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  rec.close();
  setPersistedFloor(KEY, H + 120);
  rec = createRecorder(new SnapshotStore(), () => {});
  t = rec.getLifetimeTotals();
  pub.push(totalOf(t, KEY));
  assert.equal(totalOf(t, KEY), H + 120, 'the owed drop survives the restart and is taken back');
  assert.equal(t[KEY].shiftWh, 0);
  rec.close();
  assert.deepEqual(haTotalIncreasing(pub), { sum: 120, resets: 0, phantomWh: 0, dips: 0, negativeWh: 0 }, 'HA books the 120 Wh of new energy and nothing else');
});
