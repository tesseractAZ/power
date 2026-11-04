import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.201.0 — the night ledger records the Cores' standby the islanded-outage cushion counted
 * (cushion_standby_w, cushion_standby_basis, cushion_standby_kwh): written on every plan row, null where none
 * applied, null on a row written before the columns existed, and added to a deployed ledger. With them a row's
 * line step across the release is explained from its own columns: cushion_kwh − cushion_standby_kwh is the
 * cushion without the standby, to its rounding.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-cushion-standby-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

test('★★★ S10 cushion_standby_w, _basis and _kwh round-trip; an older row reads null; a re-issued plan replaces them', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'resilience_cushion', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 30, target_soc_pct: 33.3, buy_kwh: 26.22, required_extra_kwh: 24.3,
      reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 15.02, binding_cap: 'requirement', cushion_shortfall: 0,
      cushion_trough_soc_pct: 33.26, cushion_line_soc_pct: 33.26, cushion_pool_scale: 0.944, cushion_pool_scale_basis: 'measured' });
    rec.recordNightPlan({ ...base('2026-11-04'), cushion_standby_w: 270, cushion_standby_basis: 'runway-overhead', cushion_standby_kwh: 1.08 } as never);
    rec.recordNightPlan(base('2026-11-02') as never); // written before the columns
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.deepEqual([at('2026-11-04').cushion_standby_w, at('2026-11-04').cushion_standby_basis, at('2026-11-04').cushion_standby_kwh], [270, 'runway-overhead', 1.08]);
    for (const c of ['cushion_standby_w', 'cushion_standby_basis', 'cushion_standby_kwh']) {
      assert.ok(c in at('2026-11-02'), c);
      assert.equal(at('2026-11-02')[c], null, `${c}: unknown on an older row, never fabricated`);
    }
    // The row explains its own line: 15.02 − 1.08 = 13.94, the cushion without the standby.
    const r = at('2026-11-04');
    assert.ok(Math.abs((r.cushion_kwh as number) - (r.cushion_standby_kwh as number) - 13.94) < 1e-9);
    // A later plan of record with none (a legacy-pct cushion) leaves none of the earlier one's.
    rec.recordNightPlan({ ...base('2026-11-04'), issued_at_ms: 2, cushion_standby_w: null, cushion_standby_basis: null, cushion_standby_kwh: null } as never);
    assert.deepEqual([at('2026-11-04').cushion_standby_w, at('2026-11-04').cushion_standby_basis, at('2026-11-04').cushion_standby_kwh], [null, null, null]);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('★★ S10 wiring (index.ts is not reachable from a unit test): recordNightPlanRow writes the three columns, unconditionally, beside the scale', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const fn = idx.slice(idx.indexOf('function recordNightPlanRow('), idx.indexOf('\n}\n', idx.indexOf('function recordNightPlanRow(')));
  assert.match(fn, /\n\s+\.\.\.cushionPoolScaleLedgerColumns\(plan\),\n(\s+\/\/[^\n]*\n)*\s+\.\.\.cushionStandbyLedgerColumns\(plan\),\n/);
  assert.equal(fn.split('cushionStandbyLedgerColumns(').length - 1, 1);
  const rec = readFileSync(new URL('../src/recorder.ts', import.meta.url), 'utf8');
  assert.ok(rec.includes("    'cushion_standby_w REAL', 'cushion_standby_basis TEXT', 'cushion_standby_kwh REAL',\n"), 'the column add for a deployed ledger');
  assert.ok(rec.includes("  'cushion_standby_w', 'cushion_standby_basis', 'cushion_standby_kwh',\n"), 'the allowlist the upsert reads');
});
