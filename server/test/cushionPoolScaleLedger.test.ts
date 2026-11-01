import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.199.0 — the night ledger records the measured capacity scale the cushion line was converted on
 * (cushion_pool_scale, cushion_pool_scale_basis): written on every plan row, null where no scale
 * applied, null on a row written before the column existed, and added to a deployed ledger.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-cushion-scale-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

test('★★★ cushion_pool_scale and its basis round-trip; an older row reads null; a re-issued plan replaces them', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'resilience_cushion', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 30, target_soc_pct: 33, buy_kwh: 10, required_extra_kwh: 10,
      reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 13.94, binding_cap: 'requirement', cushion_shortfall: 0,
      cushion_trough_soc_pct: 32.02, cushion_line_soc_pct: 32.02 });
    rec.recordNightPlan({ ...base('2026-11-02'), cushion_pool_scale: 0.944, cushion_pool_scale_basis: 'measured' } as never);
    rec.recordNightPlan(base('2026-10-30') as never); // written before the column
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.equal(at('2026-11-02').cushion_pool_scale, 0.944);
    assert.equal(at('2026-11-02').cushion_pool_scale_basis, 'measured');
    assert.ok('cushion_pool_scale' in at('2026-10-30') && 'cushion_pool_scale_basis' in at('2026-10-30'));
    assert.equal(at('2026-10-30').cushion_pool_scale, null, 'unknown on an older row, never fabricated');
    assert.equal(at('2026-10-30').cushion_pool_scale_basis, null);
    // A later plan of record with no scale (a legacy-pct cushion) leaves none of the earlier one's.
    rec.recordNightPlan({ ...base('2026-11-02'), issued_at_ms: 2, cushion_pool_scale: null, cushion_pool_scale_basis: null } as never);
    assert.equal(at('2026-11-02').cushion_pool_scale, null);
    assert.equal(at('2026-11-02').cushion_pool_scale_basis, null);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('★★ wiring (index.ts is not reachable from a unit test): recordNightPlanRow writes both columns, unconditionally, beside the line', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const fn = idx.slice(idx.indexOf('function recordNightPlanRow('), idx.indexOf('\n}\n', idx.indexOf('function recordNightPlanRow(')));
  assert.match(fn, /\n\s+cushion_line_soc_pct: plan\.cushionLineSocPct \?\? null,\n(\s+\/\/[^\n]*\n)*\s+\.\.\.cushionPoolScaleLedgerColumns\(plan\),\n/);
  assert.equal(fn.split('cushionPoolScaleLedgerColumns(').length - 1, 1);
  // The column add for a deployed ledger, and the allowlist the upsert reads, carry both.
  const rec = readFileSync(new URL('../src/recorder.ts', import.meta.url), 'utf8');
  assert.ok(rec.includes("    'cushion_pool_scale REAL', 'cushion_pool_scale_basis TEXT',\n"));
  assert.ok(rec.includes("  'cushion_pool_scale', 'cushion_pool_scale_basis',\n"));
});
