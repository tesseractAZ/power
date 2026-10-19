import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * R3 (v1.189.0) — the charge cycle's ledger columns (plan §6). The row stays keyed by plan_date and
 * its plan columns hold the cost leg; the cycle adds window_kind, next_recharge_ms, the backup leg's
 * backup_* columns, the morning refresh's refreshed_* columns, the force-charge stamps,
 * revert_deadline_paged_at_ms, chg_max_soc_pct and pack_accept_kw.
 *
 * Tested on a database created with the original (v1.38.0) table, as the other ledger migrations
 * are: the recorder's column-add pass must give it every new column with its declared type, an
 * existing row must read them as NULL, and a column missing from the allowlist or the ALTER would
 * drop writes SILENTLY — so both are built from one list (CHARGE_CYCLE_LEDGER_SCHEMA).
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-cycle-'));
const DB = join(tmp, 'ecoflow.db');
process.env.DB_PATH = DB;

{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE night_charge_ledger (
    plan_date TEXT PRIMARY KEY, issued_at_ms INTEGER, algo_version TEXT, posture TEXT, objective TEXT,
    rationale TEXT, confidence_tier TEXT, horizon_hours REAL, soc_now_pct REAL, soc_at_window_start_pct REAL,
    target_soc_pct REAL, buy_kwh REAL, required_extra_kwh REAL, reserve_floor_pct REAL, cushion_pct REAL,
    cushion_kwh REAL, binding_cap TEXT, pv_p10_kwh REAL, pv_p50_kwh REAL, pv_p90_kwh REAL, load_p10_kwh REAL,
    load_p50_kwh REAL, load_p90_kwh REAL, ev_p90_session_kwh REAL, ev_session_count INTEGER,
    min_proj_soc_pct REAL, min_proj_soc_ts_ms INTEGER, pool_full_kwh REAL, band_sigma_cal REAL,
    cal_scored_days INTEGER, forecast_basis TEXT, weather_covered INTEGER, tariff_snapshot TEXT,
    outcome_captured_at_ms INTEGER, actual_pv_kwh REAL, actual_load_kwh REAL, actual_window_import_kwh REAL,
    actual_grid_to_battery_kwh REAL, actual_onpeak_import_kwh REAL, onpeak_import_occurred INTEGER,
    actual_min_soc_pct REAL, actual_min_soc_ts_ms INTEGER, plan_traj_floor_breached INTEGER,
    cushion_breached INTEGER, grid_home_coverage_frac REAL, outage_during_day INTEGER, scored INTEGER,
    score_notes TEXT, pv_err_frac REAL, pv_in_band INTEGER, load_err_frac REAL, load_in_band INTEGER,
    buy_err_kwh REAL, soc_min_err_pct REAL, realized_cost_cents REAL, counterfactual_cost_cents REAL,
    realized_savings_cents REAL, demand_charge_savings_cents REAL, would_have_peak_imported INTEGER
  )`);
  db.prepare(`INSERT INTO night_charge_ledger (plan_date, issued_at_ms, buy_kwh) VALUES (?, ?, ?)`).run('2026-09-01', 1, 30.5);
  db.close();
}

const { createRecorder, CHARGE_CYCLE_LEDGER_SCHEMA } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { legLedgerFields, BACKUP_LEDGER_COLUMN } = await import('../src/chargeCycle.js');

test('★★★ an old-schema ledger gains every charge-cycle column with its type; the old row reads NULL; writes round-trip', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const info = new DatabaseSync(DB).prepare('PRAGMA table_info(night_charge_ledger)').all() as Array<{ name: string; type: string }>;
    const types = new Map(info.map((c) => [c.name, c.type]));
    assert.equal(CHARGE_CYCLE_LEDGER_SCHEMA.length, 26);
    for (const [c, t] of CHARGE_CYCLE_LEDGER_SCHEMA) assert.equal(types.get(c), t, `${c} ${t} added by the migration`);
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.equal(at('2026-09-01').buy_kwh, 30.5, 'kept as recorded');
    for (const [c] of CHARGE_CYCLE_LEDGER_SCHEMA) assert.equal(at('2026-09-01')[c], null, `${c} is null on an old row`);
    // Every column is writable through the allowlist (a value per declared type).
    const sample = (t: string, i: number) => (t === 'TEXT' ? `v${i}` : t === 'INTEGER' ? 1_000 + i : i + 0.5);
    const all = Object.fromEntries(CHARGE_CYCLE_LEDGER_SCHEMA.map(([c, t], i) => [c, sample(t, i)]));
    rec.recordNightOutcome('2026-11-15', all as never);
    for (const [c] of CHARGE_CYCLE_LEDGER_SCHEMA) assert.deepEqual(at('2026-11-15')[c], all[c], c);
    // A plan row's window kind, and a backup leg's stamps through its leg mapping, beside the cost leg's.
    rec.recordNightPlan({ plan_date: '2026-11-16', issued_at_ms: 2, buy_kwh: 34, window_kind: 'overnight' } as never);
    rec.recordNightOutcome('2026-11-16', legLedgerFields('backup', { actuated: 1, actuation_applied_at_ms: 10, actuation_reverted_at_ms: 20 }) as never);
    rec.recordNightOutcome('2026-11-16', legLedgerFields('cost', { actuated: 1, actuation_applied_at_ms: 30 }) as never);
    const r = at('2026-11-16');
    assert.deepEqual([r.window_kind, r.backup_actuated, r.backup_applied_at_ms, r.backup_reverted_at_ms, r.actuated, r.actuation_applied_at_ms, r.actuation_reverted_at_ms],
      ['overnight', 1, 10, 20, 1, 30, null], 'the legs do not overwrite each other');
    for (const c of Object.values(BACKUP_LEDGER_COLUMN)) assert.ok(types.has(c), `${c} exists`);
    // A two-leg cycle superseded by a later evening, and one stale-cancelled: the active backup leg's
    // disposition and the pending cost leg's keep their own columns (index.ts routes both stamps by
    // the leg, chargeCycle.legLedgerFields — a direct arm_disposition write would be overwritten).
    rec.recordNightPlan({ plan_date: '2026-11-21', issued_at_ms: 3, buy_kwh: 30, window_kind: 'super_off_peak' } as never);
    rec.recordNightOutcome('2026-11-21', legLedgerFields('backup', { arm_disposition: 'superseded by the 2026-11-22 plan — Sat/Sun share one Monday window, so only the later arm writes' }) as never);
    rec.recordNightOutcome('2026-11-21', legLedgerFields('cost', { arm_disposition: 'superseded by the 2026-11-22 plan' }) as never);
    const sup = at('2026-11-21');
    assert.match(String(sup.backup_arm_disposition), /^superseded by the 2026-11-22 plan — Sat\/Sun share/);
    assert.equal(sup.arm_disposition, 'superseded by the 2026-11-22 plan');
    rec.recordNightPlan({ plan_date: '2026-11-22', issued_at_ms: 4, buy_kwh: 30, window_kind: 'super_off_peak' } as never);
    rec.recordNightOutcome('2026-11-22', legLedgerFields('backup', { arm_disposition: 'cancelled by the 2026-11-23 plan — hold' }) as never);
    rec.recordNightOutcome('2026-11-22', legLedgerFields('cost', { arm_disposition: 'cancelled by the 2026-11-23 plan — hold' }) as never);
    const can = at('2026-11-22');
    assert.deepEqual([can.backup_arm_disposition, can.arm_disposition], ['cancelled by the 2026-11-23 plan — hold', 'cancelled by the 2026-11-23 plan — hold']);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('★★★ SOURCE PIN: the supersede and stale-cancel stamps of the active leg go through its leg mapping, with their own messages', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const stale = idx.slice(idx.indexOf('function cancelStalePriorArm('), idx.indexOf('async function runNightChargeEveningJobInner('));
  assert.ok(stale.includes('recorder.recordNightOutcome(stale, legLedgerFields(legRoleOf(s), {\n      arm_disposition: `cancelled by the ${today} plan — ${reason}`,\n    }) as Partial<NightLedgerRow>);'));
  assert.ok(stale.includes('app.log.warn(`night-charge: cancel stamp failed for ${stale} (${e?.message ?? e})`);'), 'its own message');
  assert.ok(idx.includes('recorder.recordNightOutcome(nightActuationMem.day, legLedgerFields(legRoleOf(nightActuationMem), {\n              arm_disposition: `superseded by the ${today} plan — Sat/Sun share one Monday window, so only the later arm writes`,\n            }) as Partial<NightLedgerRow>);'));
  assert.ok(idx.includes('app.log.warn(`night-charge: supersede stamp failed for ${nightActuationMem.day} (${e?.message ?? e})`);'));
  // No other arm_disposition is written to the recorder directly.
  assert.equal((idx.match(/recorder\.recordNightOutcome\([^)]*\{\s*arm_disposition/g) ?? []).length, 0);
});
