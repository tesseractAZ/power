import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.196.0 — THE REALIZED HALF OF THE STRIKE IS GRADED ON THE CLAIM THE PLAN MADE.
 *
 * On the islanded-outage basis (and a disabled cushion) the plan claims only that the pack AT
 * THE WINDOW CLOSE holds the reserve floor plus the cushion as applied (cushion_line_soc_pct).
 * The scorer graded the lowest pool over [close, close + 16 h) against the legacy flat band
 * (reserve_floor_pct + cushion_pct), after the reserve has reverted to the floor. The 50% write
 * masked it; v1.196.0 writes the line itself (⌈line⌉), so on the 2026-10-12 fixture a resilience
 * night writes 32% for a 31.13% line and its P50 morning low (~23.6%) is under 16 + 15 = 31: an
 * engine-fault strike every actuated night, and the gate BLOCKED for good. A 2.0 kW island's 28%
 * write is under 31% at the close with no drain at all.
 *
 * These tests pin:
 *   - the M5 rows reproduce the defect on the old rule and are clean on the new one, through the gate;
 *   - the detector still fires: a pool at the close under the line is a strike;
 *   - the 0.05 tolerance (half the 0.1 step the reading is persisted at), and no wider;
 *   - a row without the close reading: clean only where the low after the close holds the line,
 *     otherwise the stored flag (fail-closed); overruled flags are counted;
 *   - the legacy band, the mid-day two-leg row and a row without its line keep the legacy verdict;
 *   - the close reading (median, the last 15 minutes, a reconnect 0 cannot stand in), its note,
 *     the column's persistence and resets, and the scorer's wiring.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-realized-close-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const {
  computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd,
  realizedCushionBreach, cushionClaimAtClose, REALIZED_CLOSE_TOLERANCE_PCT,
} = await import('../src/nightChargeGate.js');
const {
  measuredWindowCloseSocPct, WINDOW_CLOSE_SOC_LEAD_MS, realizedCushionNote, forecastSpanResetColumns,
} = await import('../src/nightLedgerScoring.js');
const { computeNightChargePlan, buildNightChargeInputs } = await import('../src/nightChargeAdvisor.js');
const { clampReserveTarget } = await import('../src/nightChargeActuator.js');
const { goldenInputs } = await import('./fixtures/overnightTextCases.js');
const { legacyIdentityCases } = await import('./fixtures/legacyIdentityFixtures.js');
import type { NightLedgerRow } from '../src/recorder.js';

const H = 3_600_000;
const DAY = 86_400_000;

/** The pool on the plan's own P50 PV / load from `startPct` at the close for 16 h, the reserve
 *  back at the floor (it reverts at the close): the morning low the old rule graded. */
function lowAfterClose(inp: ReturnType<typeof goldenInputs>, startPct: number): number {
  const end = inp.window!.endMs;
  let pack = (startPct / 100) * inp.fullKwh;
  let low = pack;
  for (const h of inp.horizon) {
    if (h.ts < end || h.ts >= end + 16 * H) continue;
    const net = (h.pvP50W ?? 0) / 1000 - (h.loadP50W ?? 0) / 1000 / inp.dischargeEff;
    pack = net >= 0 ? Math.min(inp.fullKwh, pack + net * inp.legEff) : Math.max((inp.reserveFloorPct / 100) * inp.fullKwh, pack + net);
    low = Math.min(low, pack);
  }
  return Math.round((low / inp.fullKwh) * 1000) / 10;
}

/** The pre-v1.196.0 scorer's verdict (index.ts scoreNightRow). */
const oldRule = (r: { actual_min_soc_pct: number; reserve_floor_pct: number; cushion_pct: number }) =>
  (r.actual_min_soc_pct < r.reserve_floor_pct + r.cushion_pct ? 1 : 0);

const RES = { objectiveMode: 'resilience' as const, socNowPct: 30, forceChargeEligible: false };

/** An M5 resilience night on the fixture, as the ledger records it: the plan columns
 *  recordNightPlanRow writes, the pool the hold left at the close (the written reserve) and the
 *  P50 low after it. */
function m5Night(over: Record<string, unknown> = {}) {
  const inp = goldenInputs({ ...RES, ...over });
  const p = computeNightChargePlan(inp);
  const written = clampReserveTarget(p.setpointSocPct!);
  const low = lowAfterClose(inp, written);
  const cols = {
    reserve_floor_pct: p.reserveFloorPct, cushion_pct: p.cushionPct,
    cushion_line_soc_pct: p.cushionLineSocPct ?? null, cushion_trough_soc_pct: p.cushionTroughSocPct ?? null,
    cushion_shortfall: p.cushionShortfall ? 1 : 0, window_kind: 'overnight',
    window_close_soc_pct: written, actual_min_soc_pct: low,
  };
  return { p, written, low, cols };
}

// ── The gate's ledger ───────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 31, 4, 30); // 21:30 MST, 2026-10-30
const ago = (d: number) => phoenixYmd(NOW - d * DAY);
function row(daysAgo: number, f: Record<string, unknown> = {}): NightLedgerRow {
  return {
    plan_date: ago(daysAgo), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - daysAgo * DAY, outcome_captured_at_ms: NOW - (daysAgo - 1) * DAY,
    scored: 1, actuated: 1, cushion_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 0,
    buy_err_kwh: 0.5, pv_err_frac: daysAgo % 2 ? 0.05 : -0.05, load_err_frac: daysAgo % 2 ? -0.05 : 0.05,
    pv_in_band: daysAgo % 20 < 17 ? 1 : 0, load_in_band: daysAgo % 20 < 17 ? 1 : 0, grid_home_coverage_frac: 0.95,
    ...f,
  } as unknown as NightLedgerRow;
}
const nights = (n: number, f: Record<string, unknown>) => Array.from({ length: n }, (_, i) => row(n - i, f));

// ── The defect, and the fix, on the plan's own rows ────────────────────────────────────

test('★★★ an M5 resilience night (written 32%, P50 morning low ~23.6%) is no strike; the old rule made it one', () => {
  const { p, written, low, cols } = m5Night();
  assert.equal(p.cushionBasis, 'islanded-outage');
  assert.equal(p.chargeTonight, true);
  assert.equal(p.cushionShortfall, false, 'the plan claims the cushion holds');
  assert.equal(p.cushionLineSocPct, 31.13);
  assert.equal(written, 32, 'M5 writes the line, rounded up');
  assert.ok(low > 16 && low < 31, `the P50 low after the close ${low}% is under 16 + 15`);
  assert.ok(Math.abs(low - 23.6) < 0.3, `~23.6%: ${low}`);
  assert.equal(oldRule(cols), 1, 'precondition: the pre-v1.196.0 scorer stores a realized breach');
  assert.equal(cushionClaimAtClose(cols), true);
  assert.equal(realizedCushionBreach(cols), 0, '★ graded on the claim: the pool at the close held 31.13%');

  // Through the gate: twenty such actuated nights, scored by this release's scorer.
  const fixed = computeNightChargeReadiness(nights(20, { ...cols, cushion_breached: realizedCushionBreach(cols) }), NOW);
  assert.equal(fixed.metrics.activeStrikes, 0);
  assert.notEqual(fixed.state, 'BLOCKED');
  assert.equal(fixed.state, 'LEARNING', 'fail-closed on the other criteria (21 nights), never READY on this alone');
  assert.ok(!fixed.blocking.some((b) => b.includes('engine-fault')), fixed.blocking.join(' | '));
  // The same nights as the old scorer stored them: the stored flags are overruled, and counted.
  const stored = computeNightChargeReadiness(nights(20, { ...cols, cushion_breached: oldRule(cols) }), NOW);
  assert.equal(stored.metrics.activeStrikes, 0, 'the close reading overrules the legacy-band flag');
  assert.equal(stored.metrics.realizedStrikesSetAside, 20, 'set aside, and SAID so — never dropped silently');
  assert.equal(fixed.metrics.realizedStrikesSetAside, 0);
});

test('★★★ a 2.0 kW island: the 28% write is under 16 + 15 at the close itself, and holds its 27.55% line', () => {
  const { p, written, cols } = m5Night({ islandedLoadKw: 2.0 });
  assert.equal(p.cushionShortfall, false);
  assert.equal(p.cushionLineSocPct, 27.55);
  assert.equal(written, 28);
  assert.equal(oldRule({ ...cols, actual_min_soc_pct: written }), 1, 'precondition: under 31% with no drain at all');
  assert.equal(realizedCushionBreach(cols), 0);
  // A row captured before the close reading existed: its low after the close bounds the pool there.
  assert.equal(realizedCushionBreach({ ...cols, window_close_soc_pct: null, actual_min_soc_pct: 28 }), 0);
});

test('★★★ the detector still fires: a pool at the close under the line is an engine-fault strike', () => {
  const { cols } = m5Night();
  const short = { ...cols, window_close_soc_pct: 29, actual_min_soc_pct: 24 };
  assert.equal(realizedCushionBreach(short), 1);
  const r = computeNightChargeReadiness([row(1, { ...short, cushion_breached: realizedCushionBreach(short) })], NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.metrics.activeStrikes, 1);
  assert.ok(r.blocking.some((b) => b.includes('engine-fault')));
  // Derived from the columns, never the stored flag: a row stamped clean by a reverted scorer still strikes.
  assert.equal(computeNightChargeReadiness([row(1, { ...short, cushion_breached: 0 })], NOW).metrics.activeStrikes, 1);
  // A disclosed shortfall stays physics, not fault; an advisory night has no realized judgement.
  assert.equal(computeNightChargeReadiness([row(1, { ...short, cushion_breached: 1, cushion_shortfall: 1 })], NOW).metrics.activeStrikes, 0);
  assert.equal(computeNightChargeReadiness([row(1, { ...short, cushion_breached: 1, actuated: 0, scored: 0 })], NOW).metrics.activeStrikes, 0);
});

test('★★ a line above the panel\'s 50% maximum with no force-charge riding: the claim fails at the close, and strikes', () => {
  // The year fixture's 2026-10-29 evening: a 63.94% line, written at the 50% envelope, no
  // force-charge, cushionShortfall false (it does not count the envelope). The pool the hold leaves
  // is 50%, under the line the plan claimed. The old rule (the low after the close against the 30%
  // floor + 15) passed it; on the claim it is a strike — 4 of the year's 199 islanded evening
  // charges with no disclosed shortfall.
  const c = legacyIdentityCases().find((x) => x.label === '2026-10-29 21:30')!;
  const inp = buildNightChargeInputs(c.deps);
  const p = computeNightChargePlan(inp);
  assert.equal(p.chargeTonight, true);
  assert.equal(p.cushionShortfall, false);
  assert.equal(p.cushionBasis, 'islanded-outage');
  assert.ok(p.cushionLineSocPct! > 50, `line ${p.cushionLineSocPct}`);
  const written = clampReserveTarget(p.setpointSocPct!);
  assert.equal(written, 50);
  assert.equal(p.expectedWriteLevelPct, 50, 'no force-charge carries the pool past the reserve');
  const low = lowAfterClose(inp, written); // ~46.8%, over the 30% floor + 15
  const r = { reserve_floor_pct: p.reserveFloorPct, cushion_pct: p.cushionPct, cushion_line_soc_pct: p.cushionLineSocPct!, window_kind: 'overnight', window_close_soc_pct: written, actual_min_soc_pct: low };
  assert.equal(oldRule(r), 0, `the old rule never saw it (low ${low}% against ${p.reserveFloorPct} + ${p.cushionPct})`);
  assert.equal(realizedCushionBreach(r), 1);
});

test('★★ the tolerance is the 0.1 reading\'s half step, and no wider', () => {
  assert.equal(REALIZED_CLOSE_TOLERANCE_PCT, 0.05);
  const { cols } = m5Night(); // line 31.13
  assert.equal(realizedCushionBreach({ ...cols, window_close_soc_pct: 31.1 }), 0, '0.03 under: rounding');
  assert.equal(realizedCushionBreach({ ...cols, window_close_soc_pct: 31.0 }), 1, '0.13 under: a breach');
  assert.equal(realizedCushionBreach({ ...cols, window_close_soc_pct: null, actual_min_soc_pct: 31.1 }), 0);
  assert.equal(realizedCushionBreach({ ...cols, window_close_soc_pct: null, actual_min_soc_pct: 31.0 }), null);
});

test('★★★ no close reading: clean only where the low after the close holds the line; otherwise the stored flag, fail-closed', () => {
  const { cols } = m5Night();
  const noClose = { ...cols, window_close_soc_pct: null };
  assert.equal(realizedCushionBreach({ ...noClose, actual_min_soc_pct: 23.6 }), null, 'a morning low under the line says nothing about the close');
  assert.equal(realizedCushionBreach({ ...noClose, actual_min_soc_pct: null }), null);
  assert.equal(realizedCushionBreach({ ...noClose, actual_min_soc_pct: 41.6 }), 0, 'v1.195.0\'s 50% write: the low after the close held the line');
  // Unknown keeps the stored flag: an old row graded on the legacy band still strikes …
  const old = computeNightChargeReadiness([row(1, { ...noClose, actual_min_soc_pct: 23.6, cushion_breached: 1 })], NOW);
  assert.equal(old.metrics.activeStrikes, 1, 'fail-closed: nothing on the row shows the claim held');
  assert.equal(old.metrics.realizedStrikesSetAside, 0);
  // … and this release's scorer stores the unknown as unknown.
  assert.equal(computeNightChargeReadiness([row(1, { ...noClose, actual_min_soc_pct: 23.6, cushion_breached: null })], NOW).metrics.activeStrikes, 0);
  // A legacy-band flag the low after the close overrules is set aside, and counted.
  const overruled = computeNightChargeReadiness([row(1, { ...noClose, actual_min_soc_pct: 28, cushion_line_soc_pct: 27.55, cushion_breached: 1 })], NOW);
  assert.equal(overruled.metrics.activeStrikes, 0);
  assert.equal(overruled.metrics.realizedStrikesSetAside, 1);
});

test('★★ the set-aside count covers the strike window, claimed-hold actuated rows only', () => {
  const { cols } = m5Night();
  const flagged = { ...cols, cushion_breached: 1 }; // the close reading (32%) overrules it
  const r = computeNightChargeReadiness([
    row(60, flagged), // outside the 45-day window
    row(3, { ...flagged, cushion_shortfall: 1 }), // a disclosed shortfall: never a strike to set aside
    row(2, { ...flagged, actuated: 0 }), // advisory: no realized judgement
    row(1, flagged),
  ], NOW);
  assert.equal(r.metrics.realizedStrikesSetAside, 1);
  assert.equal(r.metrics.activeStrikes, 0);
});

// ── The rows that keep the legacy verdict ───────────────────────────────────────────

test('★★★ the legacy band keeps its verdict: the lowest pool after the close against floor + cushion_pct', () => {
  const legacy = { reserve_floor_pct: 16, cushion_pct: 15, cushion_line_soc_pct: 31, window_kind: 'overnight', window_close_soc_pct: 45, actual_min_soc_pct: 25 };
  assert.equal(cushionClaimAtClose(legacy), false, 'the line IS the legacy band');
  assert.equal(realizedCushionBreach(legacy), 1, 'the close reading does not rescue the whole-house trough');
  assert.equal(realizedCushionBreach({ ...legacy, actual_min_soc_pct: 31 }), 0);
  assert.equal(realizedCushionBreach({ ...legacy, actual_min_soc_pct: null }), null);
  // The gate reads its stored flag, as before.
  assert.equal(computeNightChargeReadiness([row(1, { ...legacy, cushion_breached: 1 })], NOW).metrics.activeStrikes, 1);
  assert.equal(computeNightChargeReadiness([row(1, { ...legacy, cushion_breached: 0, actual_min_soc_pct: 20 })], NOW).metrics.activeStrikes, 0);
});

test('★★★ a mid-day two-leg row keeps the legacy verdict over its backup and post spans', () => {
  const { cols } = m5Night();
  const midday = { ...cols, window_kind: 'super_off_peak', window_close_soc_pct: 40, actual_min_soc_pct: 22 };
  assert.equal(cushionClaimAtClose(midday), false);
  assert.equal(realizedCushionBreach(midday), 1, 'the 07:00 low on its backup span');
  assert.equal(computeNightChargeReadiness([row(1, { ...midday, cushion_breached: 1 })], NOW).metrics.activeStrikes, 1);
  // A NULL window kind is an overnight row (every row before the charge cycle record).
  assert.equal(cushionClaimAtClose({ ...cols, window_kind: null }), true);
  assert.equal(cushionClaimAtClose({ ...cols, window_kind: undefined }), true);
});

test('★★ a row without its sizing line (before v1.186.0) keeps the stored flag; a disabled cushion is a claim at the close', () => {
  const pre = { reserve_floor_pct: 16, cushion_pct: 15, cushion_line_soc_pct: null, window_close_soc_pct: 45, actual_min_soc_pct: 25 };
  assert.equal(cushionClaimAtClose(pre), false);
  assert.equal(realizedCushionBreach(pre), 1);
  assert.equal(computeNightChargeReadiness([row(1, { ...pre, cushion_breached: 1 })], NOW).metrics.activeStrikes, 1);
  // Disabled: the line is the floor alone.
  const disabled = { reserve_floor_pct: 16, cushion_pct: 15, cushion_line_soc_pct: 16, window_close_soc_pct: 17, actual_min_soc_pct: 16 };
  assert.equal(cushionClaimAtClose(disabled), true);
  assert.equal(realizedCushionBreach(disabled), 0);
  assert.equal(realizedCushionBreach({ ...disabled, window_close_soc_pct: 15 }), 1);
  // An islanded line within 0.01 of the band is graded on the band (the stricter side).
  assert.equal(cushionClaimAtClose({ ...disabled, cushion_line_soc_pct: 31.005 }), false);
  assert.equal(cushionClaimAtClose({ ...disabled, cushion_line_soc_pct: 31.02 }), true);
});

// ── The close reading, its note, the column ─────────────────────────────────────────

test('★★ measuredWindowCloseSocPct: the median over the window\'s last 15 minutes — a reconnect 0 cannot stand in', () => {
  const WE = Date.UTC(2026, 9, 13, 12); // 05:00 MST
  assert.equal(WINDOW_CLOSE_SOC_LEAD_MS, 15 * 60_000);
  const before = [{ ts: WE - WINDOW_CLOSE_SOC_LEAD_MS - 1, value: 10 }, { ts: WE - WINDOW_CLOSE_SOC_LEAD_MS - 60_000, value: 10 }];
  const after = [{ ts: WE + 30_000, value: 20 }, { ts: WE + 60_000, value: 20 }]; // the pool after the revert
  const pts = [
    ...before,
    { ts: WE - 14 * 60_000, value: 32 },
    { ts: WE - 9 * 60_000, value: 0 }, // the reconnect artifact
    { ts: WE - 4 * 60_000, value: 32 },
    { ts: WE, value: 32.04 },
    ...after,
  ];
  assert.equal(measuredWindowCloseSocPct(pts, WE), 32, 'median of 32, 0, 32, 32.04 — nothing before the lead-in, nothing after the close');
  assert.equal(measuredWindowCloseSocPct([...before, ...after], WE), null, 'nothing in the lead-in');
  assert.equal(measuredWindowCloseSocPct([], WE), null);
  assert.equal(measuredWindowCloseSocPct([{ ts: WE - 60_000, value: Number.NaN }, { ts: WE - WINDOW_CLOSE_SOC_LEAD_MS, value: 31.96 }], WE), 32);
});

test('★ the score note states the reading against the line, or why the verdict rests elsewhere', () => {
  const base = { claimAtClose: true, linePct: 31.13, actualMinSocPct: 23.6 };
  assert.equal(realizedCushionNote({ ...base, windowCloseSocPct: 32, breached: 0 }),
    ' Realized cushion: the pool read 32% at the window close against the 31.13% line the plan was sized on.');
  assert.match(realizedCushionNote({ ...base, windowCloseSocPct: 29, breached: 1 }), / — under it\.$/);
  assert.match(realizedCushionNote({ ...base, windowCloseSocPct: null, breached: null }), /^ Realized cushion: unknown — no reading in the window's last 15 minutes, and the lowest pool after the close \(23\.6%\)/);
  assert.match(realizedCushionNote({ ...base, windowCloseSocPct: null, actualMinSocPct: 41.6, breached: 0 }), /\(41\.6%\) held the 31\.13% line/);
  assert.match(realizedCushionNote({ ...base, windowCloseSocPct: null, actualMinSocPct: null, breached: null }), /\(unmeasured\)/);
  assert.equal(realizedCushionNote({ ...base, claimAtClose: false, windowCloseSocPct: 32, breached: 0 }), '');
});

test('★★★ window_close_soc_pct round-trips, is null on an older row, and every reset clears it', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'resilience_cushion', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 30, target_soc_pct: 32, buy_kwh: 10, required_extra_kwh: 10,
      reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 13.93, binding_cap: 'requirement', cushion_shortfall: 0,
      cushion_trough_soc_pct: 31.13, cushion_line_soc_pct: 31.13 });
    rec.recordNightPlan(base('2026-10-29') as never);
    rec.recordNightPlan(base('2026-10-20') as never); // captured before the column
    rec.recordNightOutcome('2026-10-29', { window_close_soc_pct: 32, cushion_breached: 0 } as never);
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.equal(at('2026-10-29').window_close_soc_pct, 32);
    assert.ok('window_close_soc_pct' in at('2026-10-20'));
    assert.equal(at('2026-10-20').window_close_soc_pct, null, 'unknown on an older row, never fabricated');
    rec.recordNightOutcome('2026-10-29', forecastSpanResetColumns(3 * H) as never);
    assert.equal(at('2026-10-29').window_close_soc_pct, null, 'a reset row keeps no reading the gate would derive a verdict from');
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const prem = idx.slice(idx.indexOf('function repairPrematureNightOutcomes'), idx.indexOf('function repairPrematureNightOutcomes') + 2500);
  assert.match(prem, /\n\s+cushion_breached: null,\n\s+window_close_soc_pct: null,/, 'the premature-capture repair clears it too');
});

test('★★★ wiring (index.ts is not reachable from a unit test): the scorer reads the close and writes the verdict on it', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /const windowCloseSocPct = measuredWindowCloseSocPct\(\n\s+recorder\.query\(shp2Sn, 'backup_pct', windowEnd - WINDOW_CLOSE_SOC_LEAD_MS, windowEnd\), windowEnd\);/);
  assert.match(idx, /const realizedCols = \{ \.\.\.y, actual_min_soc_pct: actualMinSocPct, window_close_soc_pct: windowCloseSocPct \};\n\s+const cushionBreached = realizedCushionBreach\(realizedCols\);/);
  assert.match(idx, /\n\s+cushion_breached: cushionBreached,\n\s+window_close_soc_pct: windowCloseSocPct,\n/);
  assert.match(idx, /scoreNotes \+= realizedCushionNote\(\{\n\s+claimAtClose: cushionClaimAtClose\(realizedCols\),/);
  // The old inline rule is gone.
  assert.doesNotMatch(idx, /actualMinSocPct < y\.reserve_floor_pct \+ y\.cushion_pct/);
});
