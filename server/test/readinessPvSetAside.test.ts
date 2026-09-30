/**
 * v1.187.0 — a PV verdict graded against another fleet's actual PV is not forecast-skill
 * evidence, and the readiness gate leaves it out of its PV statistics — counted, not silent.
 *
 * The 2026-09-27 row: the add-on restarted at 21:06 on a partial device map, the day
 * forecast's solar model was fitted on ONE Core (v1.186.5), and the 21:30 plan's PV band
 * (0 / 15.82 / 36.46 kWh) came from it. The plan was refused ("PV band coverage 7% < 78%")
 * and the row was graded against 9.6 kWh from three Cores: pv_in_band 1 — a probable false
 * hit, counted in pvBandCoverage 33/36.
 *
 * ★ Narrow on purpose (the review's binding correction): an incomplete-basis night is NOT
 * dropped for that alone. A plan refused for a LASTING forecast failure (2026-09-11, "PV band
 * coverage 72% < 78%") is exactly what the gate must see; dropping those nights would bias
 * PV coverage upward in the gate that unlocks AUTO writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } from '../src/nightChargeGate.js';
import { pvVerdictSetAside, knownFleetMismatchReason, KNOWN_FLEET_MISMATCH_PV_ROWS } from '../src/nightLedgerScoring.js';
import type { NightLedgerRow } from '../src/recorder.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 4, 30);
const SNS = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'];

/** 36 captured forecast nights: 33 PV-in-band, 23 load-in-band (the live readiness). */
function liveLike(): NightLedgerRow[] {
  const rows: NightLedgerRow[] = [];
  for (let i = 0; i < 36; i++) {
    const daysAgo = 37 - i;
    rows.push({
      plan_date: phoenixYmd(NOW - daysAgo * DAY),
      algo_version: String(CURRENT_ALGO_VERSION),
      issued_at_ms: NOW - daysAgo * DAY,
      confidence_tier: 'forecast',
      outcome_captured_at_ms: NOW - (daysAgo - 1) * DAY,
      scored: 1, actuated: 0, cushion_shortfall: 1,
      pv_err_frac: i < 33 ? 0.05 : -0.5,
      pv_in_band: i < 33 ? 1 : 0,
      load_err_frac: i < 23 ? 0.05 : -0.3,
      load_in_band: i < 23 ? 1 : 0,
    } as unknown as NightLedgerRow);
  }
  return rows;
}
const metrics = (rows: NightLedgerRow[]) => computeNightChargeReadiness(rows, NOW).metrics;

test('the pure check: same Cores ⇒ the verdict stands; another fleet ⇒ set aside, with the counts', () => {
  assert.equal(pvVerdictSetAside(SNS.join(','), [...SNS].reverse()), null, 'order-insensitive');
  const r = pvVerdictSetAside(SNS[0], SNS);
  assert.match(r!, /different set of Cores \(1\) than the actual PV sums \(3\)/);
  assert.ok(!r!.includes('COREXXX'), 'the reason names counts, never serials');
  assert.equal(pvVerdictSetAside(null, SNS), null, 'unknown (a pre-v1.187.0 row): the verdict stands');
  assert.equal(pvVerdictSetAside('', SNS), null);
  assert.ok(pvVerdictSetAside(`${SNS[0]},${SNS[1]},COREXXX00XXX0009`, SNS), 'a swapped Core is another fleet too');
});

test('★★★ THE 09-27 ROW: set aside, PV coverage and the sample size exclude it, and it is counted', () => {
  const rows = liveLike();
  const before = metrics(rows);
  assert.equal(before.pvBandCoverage, 0.917); // 33/36, as served live
  assert.equal(before.coverageNights, 36);
  const i = 0; // an in-band night, as 09-27 was
  (rows[i] as any).pv_verdict_set_aside = 'band built on another fleet';
  const after = metrics(rows);
  assert.equal(after.pvBandCoverage, 0.914, '32/35');
  assert.equal(after.coverageNights, 35, 'a set-aside PV verdict is not a verdict');
  assert.equal(after.pvVerdictsSetAside, 1, 'never dropped silently');
  assert.equal(after.loadBandCoverage, before.loadBandCoverage, 'the load band is the panel\'s own history — untouched');
});

test('★★★ an incomplete-basis night is NOT set aside for that alone — the lasting failures stay evidence', () => {
  const rows = liveLike();
  // Three refused nights (no trajectory) whose PV fell OUTSIDE the band: the 09-11 era shape.
  for (const j of [33, 34, 35]) {
    (rows[j] as any).min_proj_soc_pct = null;
    (rows[j] as any).scored = 0;
  }
  const m = metrics(rows);
  assert.equal(m.pvBandCoverage, 0.917, 'they still count against the band');
  assert.equal(m.pvVerdictsSetAside, 0);
});

test('the PV accuracy figures read the same pool', () => {
  const rows = liveLike();
  const before = metrics(rows).pvMae!;
  (rows[35] as any).pv_verdict_set_aside = 'x'; // an out-of-band night, |err| 0.5
  assert.ok(metrics(rows).pvMae! < before);
});

test('★★ the known row is matched by its exact identity only', () => {
  assert.equal(KNOWN_FLEET_MISMATCH_PV_ROWS.length, 1);
  const k = KNOWN_FLEET_MISMATCH_PV_ROWS[0];
  assert.equal(k.planDate, '2026-09-27');
  assert.match(knownFleetMismatchReason({ plan_date: '2026-09-27', issued_at_ms: 1790569855336 })!, /partial-map/);
  assert.equal(knownFleetMismatchReason({ plan_date: '2026-09-27', issued_at_ms: 1790569855337 }), null, 'another ledger\'s 09-27 is untouched');
  assert.equal(knownFleetMismatchReason({ plan_date: '2026-09-26', issued_at_ms: 1790569855336 }), null);
});

/* ══ integration pins ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('★★ the plan records the band\'s Cores, and the scorer checks them against the actuals\' Cores', () => {
  assert.ok(fnBody('function recordNightPlanRow(').includes('pv_model_sns: extras.pvModelSns ?? null,'));
  assert.ok(INDEX.includes('pvModelSns: Array.isArray(prob?.solarModelSns) && prob!.solarModelSns.length > 0'));
  // v1.187.0 (review) — the comparison itself runs in assembleNightLedgerColumns (tested in
  // ledgerScorerAssembly.test.ts); the scorer hands it the Cores the actuals are summed over.
  const b = fnBody('function scoreNightRow(');
  assert.ok(b.includes('  const homeSns = shp2ConnectedDpuSns(store.get().devices);'));
  assert.ok(b.includes('    homeSns: [...homeSns],'));
  assert.ok(b.includes('pv_verdict_set_aside: cols.pvSetAside,'));
});

test('★ the boot pass TAGS the known row (never rewrites its verdict) before readiness reads the ledger', () => {
  const b = fnBody('function tagKnownFleetMismatchPvRows(');
  assert.ok(b.includes('recorder.recordNightOutcome(String(y.plan_date), { pv_verdict_set_aside: reason });'));
  assert.ok(!b.includes('pv_in_band:') && !b.includes('pv_err_frac:'), 'the recorded verdict stays as captured');
  const warm = INDEX.indexOf('tagKnownFleetMismatchPvRows(); // v1.187.0');
  assert.ok(warm > 0 && warm < INDEX.indexOf('setLatestReadiness(computeNightChargeReadiness(recorder.readNightLedger(400)', warm));
});
