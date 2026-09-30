/**
 * v1.187.0 (review) — the ledger records when the reserve restore landed
 * (`actuation_reverted_at_ms`), so `delivered_kwh` ends where the hold did.
 *
 * recordNightOutcome IGNORES a column missing from its allowlist rather than throwing, so a
 * stamp dropped from NIGHT_LEDGER_COLUMNS (or from the ALTER migration) would vanish without
 * an error and every night would fall back to the unstamped span. This proves the round trip
 * on a real database, and that the stamp never disturbs the frozen plan columns.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the recorder at a throwaway DB BEFORE it (→ config.ts) is imported.
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-revert-stamp-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { deliveredHoldSpan } = await import('../src/nightLedgerScoring.js');

const PLAN_DATE = '2026-10-05';
const WS = Date.UTC(2026, 9, 6, 6); // Mon 23:00 MST
const WE = Date.UTC(2026, 9, 6, 12); // Tue 05:00 MST

test('★★ actuation_reverted_at_ms round-trips beside the apply stamp, and feeds the hold span', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightPlan({
      plan_date: PLAN_DATE, issued_at_ms: WS - 90 * 60_000, algo_version: 'nc-v1', posture: 'supervised',
      objective: 'cost_arbitrage', confidence_tier: 'forecast', reserve_floor_pct: 16, cushion_pct: 10,
      window_start_ms: WS, window_end_ms: WE,
    } as any);
    // The actuator's two stamps, as index.ts writes them.
    rec.recordNightOutcome(PLAN_DATE, { actuated: 1, actuation_applied_at_ms: WS + 28_000 });
    rec.recordNightOutcome(PLAN_DATE, { actuation_reverted_at_ms: WE + 28_000 });

    const [row] = rec.readNightLedger(100_000).filter((r) => r.plan_date === PLAN_DATE);
    assert.ok(row);
    assert.equal(row.actuation_reverted_at_ms, WE + 28_000, 'the restore stamp is persisted');
    assert.equal(row.actuation_applied_at_ms, WS + 28_000);
    assert.equal(row.window_end_ms, WE, 'the plan columns are untouched');
    assert.equal(row.outcome_captured_at_ms, null, 'a stamp is not an outcome capture');

    const hold = deliveredHoldSpan({
      windowStartMs: row.window_start_ms!, windowEndMs: row.window_end_ms!,
      appliedAtMs: row.actuation_applied_at_ms, revertedAtMs: row.actuation_reverted_at_ms,
    });
    assert.deepEqual(hold, { startMs: WS, endMs: WE + 28_000 + 60_000, basis: 'revert-stamp' });
  } finally {
    rec.close();
  }
});
