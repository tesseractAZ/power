import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tariffModelFromEnv, cheapPeriodIdOf, rateAt, type TariffModel } from '../src/tariff.js';
import { chooseChargeCycle, nextChargeableOpenMs, OVERNIGHT_CYCLE } from '../src/chargeWindows.js';
import { buildNightChargeInputs, computeNightChargePlan, OVERNIGHT_WINDOW_SPEC, type NightChargeInputDeps } from '../src/nightChargeAdvisor.js';
import { ledgerCheapPeriodIds, governedOnPeakSpan } from '../src/nightLedgerScoring.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';

/**
 * v1.191.0 (W1, plan 3.4) — THE NIGHT CHARGE PLANS IN THE TARIFF'S OWN CHEAP PERIOD.
 *
 * Until this fix every planner path named the APS id 'overnight': the window index.ts resolves, the
 * horizon end (nextChargeableOpenMs), the cycle chooser, the long-gap scan and the scorer's on-peak
 * attribution. A custom plan whose cheap period has another name had no window at all (the nightly
 * notice read "hold (no charge window)"), a plan with a dearer period called `overnight` was planned
 * in it, and NIGHT_CHARGE_CHEAP_PERIOD changed only a model field nothing read. The model's own
 * cheap period (tariff.ts cheapPeriodIdOf) is now what every path resolves; on the APS preset it is
 * 'overnight', so the reference install is unchanged (legacyIdentity.test.ts, the goldens).
 *
 * The plans run on the site clock of the test process (America/Phoenix, fixed UTC−7).
 */

const H = 3_600_000;
const phx = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h + 7, min);
const TARIFF_KEYS = [
  'TARIFF_PLAN', 'TARIFF_PERIODS', 'TARIFF_RATES', 'TARIFF_RATES_CONFIRMED', 'NIGHT_CHARGE_CHEAP_PERIOD',
  'TARIFF_ON_PEAK_HOURS', 'TARIFF_ON_PEAK_DAYS', 'TARIFF_ON_PEAK_CENTS', 'TARIFF_OFF_PEAK_CENTS',
  'TARIFF_FLAT_CENTS_PER_KWH', 'TARIFF_SUMMER_MONTHS', 'TARIFF_HOLIDAYS',
];
function modelWith(patch: Record<string, string>): TariffModel {
  const saved = new Map(TARIFF_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TARIFF_KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try { return tariffModelFromEnv(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A custom plan whose cheap period is called `night` (the finding's New York shape). */
const NIGHT = modelWith({
  TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'peak 14-19 mon-fri all onpeak; night 00-07 all all cheap',
  TARIFF_RATES: 'peak=34; night=9.5; off_peak=15', TARIFF_RATES_CONFIRMED: 'true',
});
/** A dearer period called `overnight` and a cheaper one flagged `cheap`. */
const MISNAMED = modelWith({
  TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'overnight 21-24 all all; super 00-06 all all cheap',
  TARIFF_RATES: 'overnight=20; super=8; off_peak=15', TARIFF_RATES_CONFIRMED: 'true',
});
/** A two-tier plan whose off-peak is named the night-charge period. */
const TWO_TIER_OFF = modelWith({
  TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '14-19', TARIFF_ON_PEAK_DAYS: '1-5',
  TARIFF_ON_PEAK_CENTS: '30', TARIFF_OFF_PEAK_CENTS: '12', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak',
});
const APS = modelWith({});
const pidOf = (m: TariffModel) => (t: number): string => rateAt(m, t).periodId;

// Tuesday 2026-11-03 19:30 site time: the evening before the night under test.
const EVE = phx(2026, 11, 3, 19, 30);

test('precondition: each model names its cheap period', () => {
  assert.equal(cheapPeriodIdOf(NIGHT), 'night');
  assert.equal(cheapPeriodIdOf(MISNAMED), 'super');
  assert.equal(cheapPeriodIdOf(TWO_TIER_OFF), 'off_peak');
  assert.equal(cheapPeriodIdOf(APS), 'overnight');
});

test('★★★ the cycle chooser and the horizon end follow the cheap period, whatever it is called', () => {
  const night = chooseChargeCycle(NIGHT, EVE, OVERNIGHT_CYCLE).cost;
  assert.deepEqual(night && { start: night.startMs, end: night.endMs }, { start: phx(2026, 11, 4, 0), end: phx(2026, 11, 4, 7) },
    'the custom `night` period is the charge window (it had none)');
  assert.equal(night!.kind, 'overnight', 'the leg keeps its kind');
  assert.equal(nextChargeableOpenMs(NIGHT, night!.endMs + H), phx(2026, 11, 5, 0), 'the horizon ends at the next night');

  const mis = chooseChargeCycle(MISNAMED, EVE, OVERNIGHT_CYCLE).cost!;
  assert.deepEqual({ start: mis.startMs, end: mis.endMs }, { start: phx(2026, 11, 4, 0), end: phx(2026, 11, 4, 6) },
    'the flagged cheap period, not the dearer one called overnight (Tue 21:00-24:00)');
  assert.equal(nextChargeableOpenMs(MISNAMED, EVE), phx(2026, 11, 4, 0));

  // Two-tier, off-peak named: the whole off-peak span after the on-peak, at 18:30 (S6 moves the evening job there).
  const tt = chooseChargeCycle(TWO_TIER_OFF, phx(2026, 11, 3, 18, 30), OVERNIGHT_CYCLE).cost!;
  assert.deepEqual({ start: tt.startMs, end: tt.endMs }, { start: phx(2026, 11, 3, 19), end: phx(2026, 11, 4, 14) });

  // The APS preset: the overnight window, as always.
  const aps = chooseChargeCycle(APS, EVE, OVERNIGHT_CYCLE).cost!;
  assert.deepEqual({ start: aps.startMs, end: aps.endMs }, { start: phx(2026, 11, 3, 23), end: phx(2026, 11, 4, 5) });
});

test('★★★ a plan with no cheap period has no cycle and no horizon end (the planner holds)', () => {
  const flat = modelWith({ TARIFF_PLAN: 'flat', TARIFF_FLAT_CENTS_PER_KWH: '14' });
  assert.equal(cheapPeriodIdOf(flat), null);
  const c = chooseChargeCycle(flat, EVE, OVERNIGHT_CYCLE);
  assert.equal(c.cost, null);
  assert.deepEqual(c.legs, []);
  assert.equal(nextChargeableOpenMs(flat, EVE), null);
});

/** The '2026-10-12 cost' fixture night (index.ts's inputs on a Monday 21:30), re-timed to `m`. */
const FIXTURE_NIGHT = legacyIdentityCases().find((x) => x.label === '2026-10-12 cost')!.deps;
function depsFor(m: TariffModel, cheapPeriodId: string | null): NightChargeInputDeps {
  return { ...FIXTURE_NIGHT, periodIdAt: pidOf(m), cheapPeriodId, windowSpec: OVERNIGHT_WINDOW_SPEC };
}

test('★★★ the planner: a custom `night` period is planned and sized; the APS id finds no window there', () => {
  const live = computeNightChargePlan(buildNightChargeInputs(depsFor(NIGHT, cheapPeriodIdOf(NIGHT))));
  assert.deepEqual(live.window, { startMs: phx(2026, 10, 13, 0), endMs: phx(2026, 10, 13, 7) });
  assert.equal(live.basisComplete, true);
  assert.ok(live.buyKwh != null && live.buyKwh > 0, `a buy is sized in the window (got ${live.buyKwh})`);
  assert.equal(live.chargeTonight, true);

  // What index.ts computed before the fix: the APS id on this plan — no window, a hold.
  const before = computeNightChargePlan(buildNightChargeInputs(depsFor(NIGHT, 'overnight')));
  assert.equal(before.window, null);
  assert.equal(before.chargeTonight, false);

  // No cheap period: no window, whatever the resolver would say — even on a plan that has a period
  // called `overnight` (it is not the night-charge period unless the plan says so).
  for (const m of [NIGHT, MISNAMED]) {
    const none = computeNightChargePlan(buildNightChargeInputs(depsFor(m, null)));
    assert.equal(none.window, null);
    assert.equal(none.chargeTonight, false);
  }
});

test('★★ the planner on the misnamed plan sizes the flagged cheap window, never the dearer `overnight`', () => {
  const p = computeNightChargePlan(buildNightChargeInputs(depsFor(MISNAMED, cheapPeriodIdOf(MISNAMED))));
  assert.deepEqual(p.window, { startMs: phx(2026, 10, 13, 0), endMs: phx(2026, 10, 13, 6) });
});

test('★★ the scorer: the next plan\'s window is a run of the cheap period (on-peak attribution)', () => {
  const ids = ledgerCheapPeriodIds('overnight', cheapPeriodIdOf(NIGHT));
  const onPeak = (t: number) => rateAt(NIGHT, t).isOnPeak;
  const cheap = (t: number) => ids.includes(rateAt(NIGHT, t).periodId);
  // Window Tue 00:00-07:00 → Tuesday's 14:00-19:00 on-peak is the one this plan governs.
  assert.deepEqual(governedOnPeakSpan(phx(2026, 11, 4, 7), onPeak, cheap), { startMs: phx(2026, 11, 4, 14), endMs: phx(2026, 11, 4, 19) });
  // Friday's window (Sat 00:00-07:00): the weekend has no on-peak, and Sunday's night opens first.
  assert.equal(governedOnPeakSpan(phx(2026, 11, 7, 7), onPeak, cheap), null);
  // With the APS id the scan would never meet the next window and would claim Monday's on-peak.
  const apsIds = ledgerCheapPeriodIds('overnight');
  assert.deepEqual(governedOnPeakSpan(phx(2026, 11, 7, 7), onPeak, (t) => apsIds.includes(rateAt(NIGHT, t).periodId)),
    { startMs: phx(2026, 11, 9, 14), endMs: phx(2026, 11, 9, 19) });
});

test('★★ wiring: index.ts resolves the cheap period at each evaluation and passes it to every path', () => {
  const idx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  assert.ok(!idx.includes('NIGHT_CHEAP_PERIOD_ID'), 'no constant cheap period left');
  assert.ok(idx.includes('  const cheapPeriodId = cheapPeriodIdOf(tariffModel);'));
  // v1.191.0 (review) — one night of it at a time (nightWindowPerNight.test.ts).
  assert.ok(idx.includes('  const cheapNight = cheapNightOf(tariffModel);'));
  assert.ok(idx.includes(': cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, 30, cheapNight);'));
  assert.ok(idx.includes('nextFullCheapWindow(periodIdAt, window.endMs, cheapPeriodId, 120, nightSched.fullWindowMinMs, cheapNight)'));
  assert.ok(idx.includes('    periodIdAt, cheapPeriodId, cheapNight, windowScanHours: 30,'));
  assert.ok(idx.includes('const cheapIds = ledgerCheapPeriodIds(y.window_kind, cheapId);'));
  assert.ok(idx.includes('(t) => cheapId != null && rateAt(tariff, t).periodId === cheapId,'));
  const cw = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/chargeWindows.ts'), 'utf8');
  assert.ok(!/resolveCheapWindow\([^)]*APS_PERIOD\.OVERNIGHT/.test(cw), 'chargeWindows.ts scans the model\'s cheap period');
});
