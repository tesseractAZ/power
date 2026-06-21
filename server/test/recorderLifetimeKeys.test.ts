import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.40.3 — `Recorder.listLifetimeKeys()` must return the persisted lifetime keys from the
 * `lifetime_totals` table INDEPENDENT of the current snapshot. This is the fix for the
 * startup-race Copilot flagged on the v0.40.2 PR: the per-circuit MQTT state payload was
 * sourcing keys from `getLifetimeTotals()`, whose key set is snapshot-gated (via
 * `allLifetimeKeys` → no `circuit_<ch>_wh` keys until an SHP2 projection is fetched). Before
 * the first poll, that emitted no per-circuit keys, re-triggering the HA template warning
 * for the prior run's retained sensors. listLifetimeKeys reads the table directly, so the
 * keys are available immediately on boot.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-lifekeys-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { createReadRecorder } = await import('../src/readRecorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

test('listLifetimeKeys returns persisted circuit keys even with an EMPTY snapshot (the startup case)', () => {
  const dbPath = process.env.DB_PATH!;
  // 1) Build the schema via a real recorder over an empty store (no SHP2/circuits).
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});

  // 2) Persist a per-circuit lifetime row directly (simulating a prior run that accumulated
  //    circuit 10's energy) via a second connection — exactly the cross-restart state.
  const raw = new DatabaseSync(dbPath);
  raw.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh`,
  ).run('circuit_10_wh', 42_700, Date.now());
  raw.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh`,
  ).run('fleet_pv_wh', 1_000_000, Date.now());
  raw.close();

  // 3) The snapshot is still EMPTY (devices: {}), as at startup before the first poll.
  const keys = rec.listLifetimeKeys();
  assert.ok(keys.includes('circuit_10_wh'), `listLifetimeKeys must include the persisted circuit key, got ${keys.join(',')}`);

  // 4) The bug being fixed: getLifetimeTotals() is snapshot-gated → does NOT surface the
  //    per-circuit key when the snapshot has no SHP2 circuits. (This is why the v0.40.2 fix,
  //    which sourced from getLifetimeTotals keys, did not cover startup.)
  const totalsKeys = Object.keys(rec.getLifetimeTotals());
  assert.ok(!totalsKeys.includes('circuit_10_wh'), 'getLifetimeTotals is snapshot-gated and omits per-circuit keys at startup — the exact gap listLifetimeKeys closes');

  // 5) The read-only worker recorder must agree (it reads the same table).
  const readRec = createReadRecorder(dbPath);
  assert.ok(readRec.listLifetimeKeys().includes('circuit_10_wh'), 'read recorder also lists persisted circuit keys');
  readRec.close();
  rec.close();
});
