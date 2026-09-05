import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outageCushionKwh, DEFAULT_OUTAGE_CUSHION_HOURS, DEFAULT_ISLANDED_LOAD_SAFETY,
} from '../src/nightChargeAdvisor.js';

/**
 * v1.125.0 — the outage cushion, re-scoped.
 *
 * MEASURED ON THIS PLANT (2026-09-05):
 *   pool 92.16 kWh
 *   panel_load_watts        1445 W   <- the SHP2's circuits: what runs islanded
 *   runway_recent_load_watts 4863 W  <- the whole house
 *   P90 daily load 156-185 kWh against a 92 kWh pool
 *
 * The old test asked whether a grid-blind simulation of the WHOLE HOUSE stayed
 * above floor+cushion for the entire remaining 25-49 h forecast. It could not:
 * the trough hit zero 1-8 h after window close on 7 of 7 nights, so
 * cushionShortfall was a constant, and being a constant it silently exempted
 * every night from three separate mechanisms.
 */

const POOL = 92.16;
const ISLANDED_KW = 1.445;     // measured
const DISCHARGE_EFF = 0.94;
const LEGACY = (POOL * 15) / 100;   // the old flat 15% band = 13.82 kWh

test('THE RE-SCOPE: the cushion is outage energy at ISLANDED load', () => {
  const r = outageCushionKwh({
    islandedLoadKw: ISLANDED_KW, outageHours: 8, safetyFactor: 1.5,
    dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY,
  });
  assert.equal(r.basis, 'islanded-outage');
  // 8h x 1.445kW x 1.5 / 0.94 = 18.45 kWh
  assert.ok(Math.abs(r.kwh - 18.45) < 0.1, `got ${r.kwh}`);
});

test('it is NOT a loosening — the magnitude is comparable to the old flat band', () => {
  const r = outageCushionKwh({
    islandedLoadKw: ISLANDED_KW, outageHours: DEFAULT_OUTAGE_CUSHION_HOURS,
    safetyFactor: DEFAULT_ISLANDED_LOAD_SAFETY, dischargeEff: DISCHARGE_EFF,
    legacyCushionKwh: LEGACY,
  });
  assert.ok(r.kwh > LEGACY, `the new cushion (${r.kwh}) should be STRICTER than the old ${LEGACY.toFixed(2)} kWh band`);
  assert.ok(r.kwh < LEGACY * 2, 'but of the same order — this is a re-scope, not a relaxation');
});

test('THE POINT: at these defaults the requirement DISCRIMINATES between nights', () => {
  // The whole failure was a constant flag. Recent targets at window close (%):
  const targets = [5.7, 36.2, 21.8, 8.6, 21.9, 9.2, 21.9];
  const floorPct = 16;
  const cushion = outageCushionKwh({
    islandedLoadKw: ISLANDED_KW, outageHours: 8, safetyFactor: 1.5,
    dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY,
  }).kwh;
  const need = (POOL * floorPct) / 100 + cushion;
  const met = targets.filter((t) => (POOL * t) / 100 >= need);
  assert.ok(met.length > 0, 'some nights must be able to MEET it, or it is unreachable again');
  assert.ok(met.length < targets.length, 'and some must MISS it, or it is not a test');
});

test('a longer outage demands more, a shorter one less — monotone in hours', () => {
  const at = (h: number) => outageCushionKwh({
    islandedLoadKw: ISLANDED_KW, outageHours: h, safetyFactor: 1.5,
    dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY,
  }).kwh;
  assert.ok(at(4) < at(8) && at(8) < at(24));
  assert.equal(at(0), LEGACY, 'zero hours falls back rather than yielding a zero cushion by accident');
});

test('the safety factor is monotone the STRICT way', () => {
  const at = (f: number) => outageCushionKwh({
    islandedLoadKw: ISLANDED_KW, outageHours: 8, safetyFactor: f,
    dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY,
  }).kwh;
  assert.ok(at(1.0) < at(1.5) && at(1.5) < at(2.0),
    'a higher factor must make the cushion HARDER to meet, never easier');
});

test('FAIL-CLOSED: no islanded measurement keeps the legacy band', () => {
  for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = outageCushionKwh({
      islandedLoadKw: bad as number | null, outageHours: 8, safetyFactor: 1.5,
      dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY,
    });
    assert.equal(r.basis, 'legacy-pct', `islandedLoadKw=${String(bad)} must not size a cushion`);
    assert.equal(r.kwh, LEGACY);
  }
});

test('a nonsense horizon or efficiency also fails closed', () => {
  const bad = (o: Partial<Parameters<typeof outageCushionKwh>[0]>) => outageCushionKwh({
    islandedLoadKw: ISLANDED_KW, outageHours: 8, safetyFactor: 1.5,
    dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY, ...o,
  }).basis;
  assert.equal(bad({ outageHours: Number.NaN }), 'legacy-pct');
  assert.equal(bad({ safetyFactor: 0 }), 'legacy-pct');
  assert.equal(bad({ dischargeEff: 0 }), 'legacy-pct');
});

test('the whole-house figure is why the old form never discriminated', () => {
  // Sizing against 4.863 kW for 8 h needs 62.1 kWh above the floor. Plus the 16%
  // floor that is 76.8 kWh — which DOES fit in the 92.16 kWh pool, but only from
  // 83% SoC at window close. Recent plans targeted 5.7-36.2%, so the requirement
  // would be missed every night: a constant again, just a different constant.
  const whole = outageCushionKwh({
    islandedLoadKw: 4.863, outageHours: 8, safetyFactor: 1.5,
    dischargeEff: DISCHARGE_EFF, legacyCushionKwh: LEGACY,
  }).kwh;
  const needPct = (((POOL * 16) / 100 + whole) / POOL) * 100;
  assert.ok(needPct > 80 && needPct < 100, `needs ${needPct.toFixed(0)}% SoC at window close`);
  const bestRecentTarget = 36.2;
  assert.ok(bestRecentTarget < needPct,
    'even the best recent night falls short, so whole-house load cannot be the basis');
});

/* ── end-to-end through planNightCharge ───────────────────────────────────── */

import { computeNightChargePlan, buildNightChargeInputs } from '../src/nightChargeAdvisor.js';

/**
 * The pure function above is only half the fix. The existing advisor suite does
 * NOT pass islandedLoadKw, so every one of those tests takes the legacy path —
 * which is exactly why they all still pass, and exactly why the new path needs
 * its own end-to-end coverage. Shipping an integration that no test exercises is
 * the trap this codebase has fallen into twice (v0.33, v1.124.0).
 */

const HOUR = 3_600_000;
const EVE = Date.UTC(2026, 8, 4, 4, 30); // 21:30 MST
const overnightPeriodIdAt = (ms: number): string | null => {
  const h = new Date(ms).getUTCHours();
  return h >= 6 && h < 12 ? 'overnight' : 'other';  // 23:00-05:00 MST
};
const mkHorizon = (from: number, hours: number, pvW: number, loadW: number) =>
  Array.from({ length: hours }, (_, i) => ({ ts: from + i * HOUR, pvP10W: pvW, loadP90W: loadW }));

function deps(over: Record<string, unknown> = {}) {
  return {
    gridInputCapKw: null, nowMs: EVE, fullKwh: 92.16, socNowPct: 30,
    reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2,
    periodIdAt: overnightPeriodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    // A heavy whole-house load: 4863 W, the live figure. Under the OLD test this
    // alone drives the trough to zero and pins cushionShortfall.
    bandHours: mkHorizon(EVE, 30, 0, 4863),
    dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null,
    ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
    calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9,
    morningPvSurplusP90Kwh: null, minBuyKwh: 0, buyDebiasFactor: 1,
    ...over,
  } as never;
}

test('THE PINNED FLAG: with no islanded measurement the old behaviour is unchanged', () => {
  const p = computeNightChargePlan(buildNightChargeInputs(deps()));
  // Legacy path: whole-house load drains the pack, trough hits zero, shortfall.
  assert.equal(p.cushionShortfall, true, 'this is the state that was constant');
});

test('THE FIX END-TO-END: with the islanded load supplied, the flag can go FALSE', () => {
  // Start well charged so an 8 h islanded outage is genuinely survivable.
  const p = computeNightChargePlan(buildNightChargeInputs(deps({
    socNowPct: 85, islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5,
  })));
  assert.equal(p.cushionShortfall, false,
    'a well-charged pack CAN carry the backup circuits for 8 h — the flag must be able to clear');
});

test('and it still goes TRUE when the pack genuinely cannot cover the outage', () => {
  const p = computeNightChargePlan(buildNightChargeInputs(deps({
    socNowPct: 18, islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5,
    chargeCapKw: 0.1,   // nothing can be bought tonight
  })));
  assert.equal(p.cushionShortfall, true, 'a nearly-empty pack with no buy must still fail');
});

test('a longer required outage flips a night that a shorter one clears', () => {
  const at = (h: number) => computeNightChargePlan(buildNightChargeInputs(deps({
    socNowPct: 85, islandedLoadKw: 1.445, outageCushionHours: h, islandedLoadSafety: 1.5,
  }))).cushionShortfall;
  assert.equal(at(8), false);
  assert.equal(at(60), true, 'demanding 60 h of islanded runtime must not silently pass');
});

test('the DISCLOSED whole-house trough survives the re-scope', () => {
  const p = computeNightChargePlan(buildNightChargeInputs(deps({
    socNowPct: 85, islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5,
  })));
  // The cushion no longer uses it, but "what if the whole house ran off the pack"
  // is still reported honestly rather than quietly replaced with a rosier number.
  assert.ok(p.minProjSocPct != null && p.minProjSocPct < 85,
    `whole-house trough should still be reported and low; got ${p.minProjSocPct}`);
});
