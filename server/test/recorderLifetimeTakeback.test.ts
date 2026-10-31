import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.193.0 — the publish guard's take-back at the recorder (guardLifetimeEmit; the pure rule is in
 * lifetimeEmitGuard.test.ts, the 2026-06-08 shape on a watt counter in recorderEmitHighwater.test.ts).
 * An unexplained drop the guard continued from stays owed (lifetime_basis.owed_wh, owed_ts) until
 * the counter climbs back, or until LIFETIME_OWED_WINDOW_MS after the drop. Here:
 *   - Battery Energy In, whose shift and owed are written only in the floors' transaction;
 *   - the published split on a take-back read (persistedWh carries the shift, nothing held);
 *   - a drop that never comes back (a replaced database) expires, so a later drop that returns
 *     is still taken back;
 *   - the high-water file never runs ahead of a basis that is not committed yet.
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-takeback-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder, LIFETIME_OWED_WINDOW_MS } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { haTotalIncreasing } = await import('./helpers/haTotalIncreasing.js');

const DB_PATH = process.env.DB_PATH!;
const SIDECAR = join(dirname(DB_PATH), '.emit-highwater.json');

function sql(text: string) {
  const raw = new DatabaseSync(DB_PATH);
  try { raw.exec(text); } finally { raw.close(); }
}
function setRow(key: string, wh: number) {
  const raw = new DatabaseSync(DB_PATH);
  raw.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh, last_integrated_ts = excluded.last_integrated_ts`,
  ).run(key, wh, Date.now() - 60_000);
  raw.close();
}
function basisRow(key: string) {
  const raw = new DatabaseSync(DB_PATH);
  const r = raw.prepare(`SELECT shift_wh, owed_wh, reason FROM lifetime_basis WHERE metric_key = ?`).get(key) as { shift_wh: number; owed_wh: number; reason: string } | undefined;
  raw.close();
  return r && { ...r };
}
const totalOf = (t: Record<string, { persistedWh: number; pendingWh: number }>, k: string) => t[k].persistedWh + t[k].pendingWh;
const sidecar = () => JSON.parse(readFileSync(SIDECAR, 'utf8')) as Record<string, number>;

// The schema, before any test writes a row.
createRecorder(new SnapshotStore(), () => {}).close();

test('★★★ Battery Energy In: a drop before a restart that comes back after it is taken back; the owed amount commits with the floors', () => {
  const KEY = 'fleet_battery_charge_wh';
  const H = 20_000;
  setRow(KEY, H);
  let rec = createRecorder(new SnapshotStore(), () => {});
  const pub = [totalOf(rec.getLifetimeTotals(), KEY)];
  rec.close();
  setRow(KEY, 0);
  rec = createRecorder(new SnapshotStore(), () => {});
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  assert.equal(basisRow(KEY), undefined, 'a battery shift waits for the floors\' transaction');
  rec.rollupLifetime();
  assert.deepEqual(basisRow(KEY), { shift_wh: H, owed_wh: H, reason: 'unexplained drop' }, 'the shift and the amount owed commit with the floors');
  rec.close();
  setRow(KEY, H + 100);
  rec = createRecorder(new SnapshotStore(), () => {});
  const t = rec.getLifetimeTotals();
  pub.push(totalOf(t, KEY));
  assert.equal(totalOf(t, KEY), H + 100, 'taken back after the restart: H + 100 Wh, not 2H + 100 Wh');
  assert.equal(t[KEY].shiftWh, 0);
  // The split on the take-back read: the shift is in persistedWh, nothing is held.
  assert.equal(t[KEY].heldWh, 0);
  assert.equal(t[KEY].pendingWh, 0);
  assert.equal(t[KEY].persistedWh, H + 100);
  rec.rollupLifetime();
  assert.deepEqual(basisRow(KEY), { shift_wh: 0, owed_wh: 0, reason: 'unexplained drop returned' });
  rec.close();
  assert.deepEqual(haTotalIncreasing(pub), { sum: 100, resets: 0, phantomWh: 0, dips: 0, negativeWh: 0 });
});

test('★★ the take-back read publishes the shift in persistedWh and holds nothing (a watt counter)', () => {
  const KEY = 'fleet_pv_wh';
  const H = 400_000;
  const rec = createRecorder(new SnapshotStore(), () => {});
  setRow(KEY, H);
  rec.getLifetimeTotals();
  setRow(KEY, 0);
  rec.getLifetimeTotals();
  setRow(KEY, H + 50);
  const t = rec.getLifetimeTotals();
  assert.equal(totalOf(t, KEY), H + 50);
  assert.equal(t[KEY].shiftWh, 0);
  assert.equal(t[KEY].heldWh, 0);
  assert.equal(t[KEY].pendingWh, 0);
  assert.equal(t[KEY].persistedWh, H + 50);
  rec.close();
});

test('★★★ a drop that never comes back (a replaced database) expires after LIFETIME_OWED_WINDOW_MS, so a later drop that does is still taken back', () => {
  const KEY = 'fleet_load_wh';
  const L = 1_000_000;
  assert.equal(LIFETIME_OWED_WINDOW_MS, 24 * 3_600_000);
  setRow(KEY, L);
  let rec = createRecorder(new SnapshotStore(), () => {});
  const pub = [totalOf(rec.getLifetimeTotals(), KEY)];
  rec.close();
  // The database is replaced (the row near 0, the high-water file intact): continued for good.
  setRow(KEY, 100);
  rec = createRecorder(new SnapshotStore(), () => {});
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  rec.close();
  assert.deepEqual(basisRow(KEY), { shift_wh: L - 100, owed_wh: L - 100, reason: 'unexplained drop' });
  // A day and an hour later it has not come back.
  sql(`UPDATE lifetime_basis SET owed_ts = ${Date.now() - LIFETIME_OWED_WINDOW_MS - 3_600_000} WHERE metric_key = '${KEY}'`);
  const lines: string[] = [];
  rec = createRecorder(new SnapshotStore(), (m: string) => lines.push(m));
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  assert.deepEqual(basisRow(KEY), { shift_wh: L - 100, owed_wh: 0, reason: 'unexplained drop kept' }, 'kept in the shift for good, owed no more');
  assert.ok(lines.some((l) => l.includes(`lifetime counter ${KEY}: 999.900 kWh of an unexplained drop did not come back within 24 h`)), 'the expiry is logged');
  // The new database counts 200 kWh, then reads 0 for an hour and comes back with 50 Wh more.
  setRow(KEY, 200_100);
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  setRow(KEY, 0);
  pub.push(totalOf(rec.getLifetimeTotals(), KEY));
  setRow(KEY, 200_150);
  const t = rec.getLifetimeTotals();
  pub.push(totalOf(t, KEY));
  rec.close();
  assert.equal(totalOf(t, KEY), L + 200_050, 'taken back: the leftover of the replacement no longer hides it (was 1,400,150 Wh, the 200.1 kWh booked twice)');
  assert.equal(t[KEY].shiftWh, L - 100);
  assert.deepEqual(haTotalIncreasing(pub), { sum: 200_050, resets: 0, phantomWh: 0, dips: 0, negativeWh: 0 }, 'HA books the new database\'s 200,050 Wh and nothing else');
});

test('★★ the high-water file never runs ahead of a basis shift that is not committed: a key still dirty keeps the value the file held', () => {
  const KEY = 'fleet_grid_import_wh';
  const H = 300_000;
  const rec = createRecorder(new SnapshotStore(), () => {});
  setRow(KEY, H);
  rec.getLifetimeTotals();
  rec.rollupLifetime();
  assert.equal(sidecar()[KEY], H);
  sql(`CREATE TRIGGER basis_fail_ins BEFORE INSERT ON lifetime_basis BEGIN SELECT RAISE(ABORT, 'injected basis write failure'); END;
    CREATE TRIGGER basis_fail_upd BEFORE UPDATE ON lifetime_basis BEGIN SELECT RAISE(ABORT, 'injected basis write failure'); END;`);
  try {
    // The drop's shift cannot be written; the counter climbs back past it by 3 kWh.
    setRow(KEY, 0);
    rec.getLifetimeTotals();
    setRow(KEY, H + 3_000);
    assert.equal(totalOf(rec.getLifetimeTotals(), KEY), H + 3_000);
    rec.rollupLifetime();
    assert.equal(sidecar()[KEY], H, 'the file keeps H while the basis is uncommitted (was H + 3,000 Wh)');
    assert.equal(basisRow(KEY), undefined, 'nothing committed');
  } finally {
    sql(`DROP TRIGGER basis_fail_ins; DROP TRIGGER basis_fail_upd;`);
  }
  // The next write commits the basis; the file then catches up.
  rec.rollupLifetime();
  assert.equal(basisRow(KEY)?.shift_wh, 0);
  assert.equal(sidecar()[KEY], H + 3_000);
  rec.close();
});
