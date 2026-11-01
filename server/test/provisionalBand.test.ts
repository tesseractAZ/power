import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nca from '../src/nightChargeAdvisor.js';
import {
  buildNightChargeInputs, computeNightChargePlan, resolveCheapWindow, pessimisticPrePeakSurplus,
  eveningBasisDefers,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan, type NightChargeHour,
} from '../src/nightChargeAdvisor.js';
import { armFromPlan, emptyActuationState, decideActuation, clampReserveTarget } from '../src/nightChargeActuator.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { rateAt } from '../src/tariff.js';
import * as web from '../../web/src/cards/nightChargeText.js';
import { legacyIdentityCases, planDigest, MODEL, periodIdAt as apsPeriodIdAt } from './fixtures/legacyIdentityFixtures.js';

/**
 * v1.198.0 — A PROVISIONAL PLAN ON A WIDENED SOLAR BAND.
 *
 * The night-charge planner refused every plan until the PV band had 14 scored calibration days
 * (calScoredDays ≥ N_MIN). Since v1.196.0 a day on which a home Core had no readings is a coverage
 * gap and is not scored, so after a stretch of cloud-offline Cores the planner refused for about
 * two weeks after they reported again, and the backup pool sat at its reserve floor each night.
 *
 * From 4 scored days (a provisional minimum) the planner now plans on a deliberately WIDER solar
 * band: the P10 PV it sizes on is pushed below the published P10 by a Student-t predictive factor
 * k(n) (1.31 at 4 days, 1 at 14), and the beyond-24 h carry is widened by k × the band's own lower
 * half-width. Lower P10 PV only ever buys more. At 14 scored days nothing moves: every plan is
 * byte-identical to the planner before this change (legacyIdentity.golden.json).
 *
 * The coverage gate (≥ 78% of the scored days inside the band) is unchanged and is judged on the
 * published band, before the widening, so the widening never helps a plan pass.
 */

const H = 3_600_000;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;

/* ── the hand-worked night: Tuesday 2026-11-17 ─────────────────────────────
 * The Cores reported again on 11-12 (a coverage gap); 11-13..11-16 scored, so n = 4.
 * The band for the next 24 h carries P50 3,800 W and a published P10 2,190 W in each of the ten
 * daylight hours 08:00-17:00: ΣP50 38.0 kWh, ΣP10 21.9 kWh, so the band's lower half-width is
 * H = (38.0 − 21.9) / 38.0 = 0.423684. At n = 4, k = 1.3102:
 *   widened P10 = 3,800 − 1.3102 × 1,610 = 1,690.578 W an hour → 16.906 kWh over the day;
 *   the beyond-24 h carry widens by k·H = 0.555111 per √day.
 * The pool: 92.16 kWh at 16% (14.7456 kWh), a 16% floor, a 4 h × 2.62 kW × 1.25 / 0.94 = 13.936 kWh
 * islanded cushion, so the line is (14.7456 + 13.936) / 92.16 = 31.12%, asked as 32%. */
const NOW_1117 = phx(11, 17, 21, 30);
const WIN_START = phx(11, 17, 23);
const WIN_END = phx(11, 18, 5);
const NEXT_WINDOW = phx(11, 18, 23);
const SUN_P50_W = 3800;
const SUN_P10_W = 2190;
const H_BAND = (SUN_P50_W - SUN_P10_W) / SUN_P50_W; // 0.4236842105
const K4 = 1.3102;

function night1117(o: {
  nowMs?: number; n?: number; coverage?: number; provisionalMin?: number | null; over?: Partial<NightChargeInputDeps>;
} = {}): NightChargeInputDeps {
  const nowMs = o.nowMs ?? NOW_1117;
  const bandStart = Math.floor(nowMs / H) * H;
  const bandHours: NightForecastHour[] = [];
  for (let ts = bandStart; ts < bandStart + 24 * H; ts += H) {
    const sun = phxHour(ts) >= 8 && phxHour(ts) <= 17;
    bandHours.push({ ts, pvP10W: sun ? SUN_P10_W : 0, loadP90W: 3220, embeddedEvW: 0, loadP50W: 2500, pvP50W: sun ? SUN_P50_W : 0 });
  }
  const rollHours: Array<{ ts: number; pvW: number; loadW: number }> = [];
  for (let ts = phx(11, 18, 0); ts < phx(11, 19, 0); ts += H) {
    const sun = phxHour(ts) >= 8 && phxHour(ts) <= 17;
    rollHours.push({ ts, pvW: sun ? SUN_P50_W : 0, loadW: 2500 });
  }
  return {
    nowMs, fullKwh: 92.16, socNowPct: 16, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'resilience', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 14.4, gridInputCapKw: 17,
    periodIdAt: (ms) => (ms >= WIN_START && ms < WIN_END) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
    cheapPeriodId: 'overnight', windowScanHours: 30,
    // What index.ts passes below 14 scored days: the realized half-width is null there (`?? 0`).
    bandHours, dayRollups: [{ daysAhead: 1, hours: rollHours }], realizedDailyErrHalfFrac: 0, nextRechargeMs: NEXT_WINDOW,
    ev: { p90SessionKwh: null, chargeStartMs: null, sessionCount: 0 }, evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: o.n ?? 4, minCalScoredDays: 14,
    ...(o.provisionalMin === null ? {} : { provisionalMinCalScoredDays: o.provisionalMin ?? 4 }),
    bandCoverageFrac: o.coverage ?? 1,
    morningPvSurplusP90Kwh: null, morningPvSurplusP50Kwh: null, longGapAhead: false, minBuyKwh: 1,
    buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0, forceChargeEligible: false,
    ...o.over,
  } as NightChargeInputDeps;
}
const planOf = (d: NightChargeInputDeps): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(d));
const hourAt = (hours: ReadonlyArray<NightChargeHour>, ts: number): NightChargeHour => {
  const h = hours.find((x) => x.ts === ts);
  assert.ok(h, `no horizon hour at ${new Date(ts).toISOString()}`);
  return h!;
};

/* ── the Student-t predictive factor, recomputed numerically ───────────── */

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const ci of c) s += ci / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Student-t CDF and its quantile (bisection). */
const tCdf = (t: number, nu: number): number => {
  const p = 0.5 * ibeta(nu / 2, 0.5, nu / (nu + t * t));
  return t >= 0 ? 1 - p : p;
};
function tQuantile(p: number, nu: number): number {
  let lo = 0, hi = 50;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tCdf(m, nu) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

test('★★★ the widening factor k(n) is the Student-t predictive inflation, normalised to 1 at 14 days', () => {
  // The quantile routine itself, against published two-sided 80% t values.
  assert.ok(Math.abs(tQuantile(0.9, 3) - 1.6377) < 1e-4);
  assert.ok(Math.abs(tQuantile(0.9, 13) - 1.3502) < 1e-4);
  const ref = tQuantile(0.9, 13) * Math.sqrt(1 + 1 / 14);
  for (let n = 4; n <= 13; n++) {
    const k = (tQuantile(0.9, n - 1) * Math.sqrt(1 + 1 / n)) / ref;
    assert.ok(Math.abs(nca.provisionalBandWiden(n)! - k) < 1e-4, `k(${n}) = ${nca.provisionalBandWiden(n)} vs ${k}`);
    assert.equal(nca.PROVISIONAL_BAND_WIDEN[n], nca.provisionalBandWiden(n));
  }
  // The pins the design was reviewed on.
  assert.equal(nca.provisionalBandWiden(4), 1.3102);
  assert.equal(nca.provisionalBandWiden(5), 1.2018);
  assert.equal(nca.provisionalBandWiden(7), 1.1013);
  assert.equal(nca.provisionalBandWiden(13), 1.0071);
  // The full band from 14 on; nothing defined below 4 (a plan there is refused, never unwidened).
  assert.equal(nca.provisionalBandWiden(14), 1);
  assert.equal(nca.provisionalBandWiden(30), 1);
  for (const n of [-1, 0, 1, 2, 3, 4.5, Number.NaN]) assert.equal(nca.provisionalBandWiden(n), null, `n=${n}`);
  // Monotone non-increasing, never below 1.
  for (let n = 4; n < 14; n++) {
    const k = nca.provisionalBandWiden(n)!;
    assert.ok(k >= 1, `k(${n}) ≥ 1`);
    assert.ok(k >= nca.provisionalBandWiden(n + 1)!, `k(${n}) ≥ k(${n + 1})`);
  }
});

test('★★★ the widened P10: P50 − k·(P50 − P10), never above the published P10, 0 with no P50', () => {
  assert.equal(nca.provisionalP10W(SUN_P10_W, SUN_P50_W, K4), SUN_P50_W - K4 * (SUN_P50_W - SUN_P10_W)); // 1,690.578
  assert.ok(Math.abs(nca.provisionalP10W(SUN_P10_W, SUN_P50_W, K4) - 1690.578) < 1e-9);
  // Never below 0.
  assert.equal(nca.provisionalP10W(100, 4000, K4), 0);
  // A P10 above its P50 (a band inverted by a clamp) is kept, never raised.
  assert.equal(nca.provisionalP10W(3000, 2500, K4), 3000);
  // k = 1 returns the published P10.
  assert.equal(nca.provisionalP10W(SUN_P10_W, SUN_P50_W, 1), SUN_P10_W);
  // No P50: no credit for sun the band does not state.
  assert.equal(nca.provisionalP10W(SUN_P10_W, null, K4), 0);
  assert.equal(nca.provisionalP10W(SUN_P10_W, undefined, K4), 0);
  assert.equal(nca.provisionalP10W(SUN_P10_W, Number.NaN, K4), 0);
});

test('★★ the band lower half-width H: Σ(P50 − P10)/ΣP50, and 1 when the band holds under 0.5 kWh of P50', () => {
  const day = night1117();
  assert.ok(Math.abs(nca.bandLowerHalfFrac(day.bandHours) - H_BAND) < 1e-12);
  assert.equal(nca.bandLowerHalfFrac([]), 1);
  assert.equal(nca.bandLowerHalfFrac([{ ts: 0, pvP10W: 0, loadP90W: 0, pvP50W: 499 }]), 1);
  assert.equal(nca.bandLowerHalfFrac([{ ts: 0, pvP10W: 300, loadP90W: 0, pvP50W: 500 }]), 0.4);
  // The 0.5 kWh rail is on the P50 SUM, in Wh, and it decides alone: under it the band is 1 however
  // narrow its own figures read (300 W of P10 under 499 W of P50 would compute 0.399), whether the
  // 499 Wh sit in one hour or several; at 500 Wh the band's own width is used.
  assert.equal(nca.bandLowerHalfFrac([{ ts: 0, pvP10W: 300, loadP90W: 0, pvP50W: 499 }]), 1);
  assert.equal(nca.bandLowerHalfFrac([{ ts: 0, pvP10W: 100, loadP90W: 0, pvP50W: 249 }, { ts: H, pvP10W: 100, loadP90W: 0, pvP50W: 250 }]), 1);
  assert.equal(nca.bandLowerHalfFrac([{ ts: 0, pvP10W: 100, loadP90W: 0, pvP50W: 250 }, { ts: H, pvP10W: 100, loadP90W: 0, pvP50W: 250 }]), 0.6);
  // An hour without a P50 tells nothing about the band's width.
  assert.equal(nca.bandLowerHalfFrac([{ ts: 0, pvP10W: 300, loadP90W: 0, pvP50W: 500 }, { ts: H, pvP10W: 9000, loadP90W: 0, pvP50W: null }]), 0.4);
});

/* ── the basis gate ─────────────────────────────────────────────────────── */

test('★★★ the gate: 4 scored days plan on the widened band; 3 are refused and say "need 4"', () => {
  const at3 = buildNightChargeInputs(night1117({ n: 3 }));
  assert.equal(at3.basisComplete, false);
  assert.equal(at3.basisBlockedBy,
    'only 3 scored calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)');
  assert.equal(at3.basisTransient, false, '1-3 scored days are a persistent refusal, announced at 21:30');
  assert.equal(eveningBasisDefers(planOf(night1117({ n: 3 })), 21 * 60 + 30), false);
  assert.equal(buildNightChargeInputs(night1117({ n: 0 })).basisTransient, true, 'n = 0 still waits (a start-up)');

  const at4 = buildNightChargeInputs(night1117({ n: 4 }));
  assert.equal(at4.basisComplete, true);
  assert.equal(at4.basisBlockedBy, null);
  assert.equal(at4.pvBandWiden?.factor, K4);
  const p4 = computeNightChargePlan(at4);
  assert.equal(p4.basisComplete, true);
  assert.equal(p4.chargeTonight, true, 'a pool at its floor gets a charge plan');
  assert.equal(p4.setpointSocPct, 32, 'the islanded line 31.12%, asked to the whole percent above it');

  const at13 = buildNightChargeInputs(night1117({ n: 13 }));
  assert.equal(at13.basisComplete, true);
  assert.equal(at13.pvBandWiden?.factor, 1.0071);
  for (const n of [14, 30]) {
    const full = buildNightChargeInputs(night1117({ n }));
    assert.equal(full.basisComplete, true);
    assert.equal('pvBandWiden' in full, false, `n=${n}: no provisional field on the full basis`);
  }
});

test('★★★ without the provisional minimum (every fixture before it) the gate is exactly the old one', () => {
  for (const n of [3, 4, 9, 13]) {
    const i = buildNightChargeInputs(night1117({ n, provisionalMin: null }));
    assert.equal(i.basisComplete, false);
    assert.equal(i.basisBlockedBy, `only ${n} scored calibration day(s), need 14`);
    assert.equal('pvBandWiden' in i, false);
  }
  // A provisional minimum at or above the full one leaves no provisional range.
  const i = buildNightChargeInputs(night1117({ n: 9, provisionalMin: 14 }));
  assert.equal(i.basisComplete, false);
  assert.equal(i.basisBlockedBy, 'only 9 scored calibration day(s), need 14');
  // ... and one above it is the full minimum: 16 scored days plan on the band as published.
  const above = buildNightChargeInputs(night1117({ n: 16, provisionalMin: 20 }));
  assert.equal(above.basisComplete, true);
  assert.equal('pvBandWiden' in above, false);
  // A non-finite one falls back to the full minimum (fail closed).
  const nan = buildNightChargeInputs(night1117({ n: 9, provisionalMin: Number.NaN }));
  assert.equal(nan.basisComplete, false);
  assert.equal(nan.basisBlockedBy, 'only 9 scored calibration day(s), need 14');
  // A provisional minimum under the table's first entry refuses rather than plan unwidened.
  const low = buildNightChargeInputs(night1117({ n: 3, provisionalMin: 2 }));
  assert.equal(low.basisComplete, false);
  assert.equal(low.basisBlockedBy, 'no provisional band widening is defined for 3 scored calibration day(s)');
});

test('★★★ the coverage gate is unchanged and judged on the published band: unanimity at 4, two misses at 9', () => {
  // index.ts divides the analytics' rounded percent by 100.
  const cov = (inBand: number, n: number): number => Math.round((inBand / n) * 100) / 100;
  const three = buildNightChargeInputs(night1117({ n: 4, coverage: cov(3, 4) }));
  assert.equal(three.basisComplete, false);
  // The coverage branch prints the quantities that PASSED: on a provisional day count, the
  // provisional minimum it passed (never "4/14", which reads as a failed count), and that the band
  // would be the provisional one.
  assert.equal(three.basisBlockedBy,
    'PV band coverage 75% < 78% (forecast present, tier=forecast, calDays 4/4, provisional band below 14)');
  assert.equal(buildNightChargeInputs(night1117({ n: 5, coverage: cov(4, 5) })).basisComplete, true, '4 of 5');
  assert.equal(buildNightChargeInputs(night1117({ n: 9, coverage: cov(7, 9) })).basisComplete, true, '7/9 = 77.8% rounds to 78');
  const sixOfNine = buildNightChargeInputs(night1117({ n: 9, coverage: cov(6, 9) }));
  assert.equal(sixOfNine.basisComplete, false, '6 of 9');
  assert.equal(sixOfNine.basisBlockedBy,
    'PV band coverage 67% < 78% (forecast present, tier=forecast, calDays 9/4, provisional band below 14)');
  // From 14 days the full minimum passed: the text is the one before the provisional band, whether or
  // not a provisional minimum is passed.
  for (const provisionalMin of [4, null]) {
    for (const n of [14, 29]) {
      assert.equal(buildNightChargeInputs(night1117({ n, coverage: 0.72, provisionalMin })).basisBlockedBy,
        `PV band coverage 72% < 78% (forecast present, tier=forecast, calDays ${n}/14)`, `n=${n}, provisional minimum ${provisionalMin}`);
    }
  }
  // A coverage that is not a number is a coverage miss, named as one (as before).
  assert.ok(buildNightChargeInputs(night1117({ n: 4, coverage: Number.NaN })).basisBlockedBy!.startsWith('PV band coverage NaN% < 78%'));
  // The other gates still refuse first.
  assert.equal(buildNightChargeInputs(night1117({ n: 4, over: { forecastPresent: false } })).basisBlockedBy, 'no PV forecast available');
  assert.equal(buildNightChargeInputs(night1117({ n: 4, over: { confidenceTier: 'climatology' } })).basisComplete, false);
});

/* ── where the widening applies ─────────────────────────────────────────── */

test('★★★ hand-worked: the band hours carry the widened P10, the plan says how wide', () => {
  const inputs = buildNightChargeInputs(night1117());
  const noon = hourAt(inputs.horizon, phx(11, 18, 12));
  assert.ok(Math.abs(noon.pvP10W - 1690.578) < 1e-9, `${noon.pvP10W}`);
  assert.equal(noon.pvP50W, SUN_P50_W, 'P50 untouched');
  assert.equal(noon.loadP90W, 3220, 'band-hour load untouched');
  assert.equal(hourAt(inputs.horizon, phx(11, 18, 2)).pvP10W, 0, 'a night hour stays 0');
  const p = computeNightChargePlan(inputs);
  assert.deepEqual(p.pvBandWiden, {
    factor: 1.3102, calScoredDays: 4, fullCalScoredDays: 14,
    bandP10Kwh: 21.9, widenedP10Kwh: 16.91, rollupHalfFrac: 0.5551,
  });
});

test('★★★ the beyond-24 h carry widens by k·H·√daysAhead on a provisional plan (the latent `?? 0`)', () => {
  // Tuesday 13:00: the band ends Wednesday 12:00, so Wednesday's afternoon is rollup hours.
  const d = night1117({ nowMs: phx(11, 17, 13), over: { nextRechargeMs: null } });
  d.dayRollups = [
    ...d.dayRollups,
    { daysAhead: 2, hours: [{ ts: phx(11, 19, 12), pvW: 3000, loadW: 2000 }] },
  ];
  const inputs = buildNightChargeInputs(d);
  const kH = K4 * H_BAND; // 0.555111
  const wed14 = hourAt(inputs.horizon, phx(11, 18, 14));
  assert.ok(Math.abs(wed14.pvP10W - SUN_P50_W * (1 - kH)) < 1e-9, `${wed14.pvP10W}`);
  assert.ok(Math.abs(wed14.loadP90W - 2500 * (1 + kH)) < 1e-9, `${wed14.loadP90W}`);
  assert.equal(wed14.pvP50W, SUN_P50_W);
  assert.equal(wed14.loadP50W, 2500);
  const thu12 = hourAt(inputs.horizon, phx(11, 19, 12));
  assert.ok(Math.abs(thu12.pvP10W - 3000 * Math.max(0, 1 - kH * Math.SQRT2)) < 1e-9, `${thu12.pvP10W}`);
  assert.ok(Math.abs(thu12.loadP90W - 2000 * (1 + kH * Math.SQRT2)) < 1e-9, `${thu12.loadP90W}`);
  // At 14 scored days the realized half-width is the widening, exactly as before.
  const full = buildNightChargeInputs({ ...d, calScoredDays: 14, realizedDailyErrHalfFrac: 0.12 });
  assert.ok(Math.abs(hourAt(full.horizon, phx(11, 18, 14)).loadP90W - 2500 * 1.12) < 1e-9);
  assert.ok(Math.abs(hourAt(full.horizon, phx(11, 19, 12)).loadP90W - 2000 * (1 + 0.12 * Math.SQRT2)) < 1e-9);
  // ... and a provisional plan ignores a realized half-width (null in production below 14).
  const prov012 = buildNightChargeInputs({ ...d, realizedDailyErrHalfFrac: 0.12 });
  assert.ok(Math.abs(hourAt(prov012.horizon, phx(11, 18, 14)).loadP90W - 2500 * (1 + kH)) < 1e-9);
  // A band with under 0.5 kWh of P50 (no sun stated): H = 1.
  const dark = night1117({ nowMs: phx(11, 17, 13), over: { nextRechargeMs: null } });
  dark.bandHours = dark.bandHours.map((h) => ({ ...h, pvP10W: 0, pvP50W: 0 }));
  const darkIn = buildNightChargeInputs(dark);
  assert.ok(Math.abs(hourAt(darkIn.horizon, phx(11, 18, 14)).loadP90W - 2500 * (1 + K4)) < 1e-9);
  assert.equal(hourAt(darkIn.horizon, phx(11, 18, 14)).pvP10W, 0);
  assert.equal(darkIn.pvBandWiden?.rollupHalfFrac, K4, 'H = 1, so the carry widens by k itself');
  // A near-dark band (ten sun hours at P50 45 W / P10 27 W: ΣP50 0.45 kWh, its own width 0.4): under
  // the 0.5 kWh rail, so H = 1 and the carry widens by k, not by k × 0.4.
  const dim = night1117({ nowMs: phx(11, 17, 13), over: { nextRechargeMs: null } });
  dim.bandHours = dim.bandHours.map((h) => (h.pvP50W ? { ...h, pvP10W: 27, pvP50W: 45 } : h));
  assert.ok(Math.abs(nca.bandLowerHalfFrac(dim.bandHours) - 1) < 1e-12);
  const dimIn = buildNightChargeInputs(dim);
  assert.equal(dimIn.pvBandWiden?.rollupHalfFrac, K4);
  assert.ok(Math.abs(hourAt(dimIn.horizon, phx(11, 18, 14)).loadP90W - 2500 * (1 + K4)) < 1e-9);
  assert.equal(hourAt(dimIn.horizon, phx(11, 18, 14)).pvP10W, 0);
});

test('★★★ a band hour with no P50: the widened P10 is 0 and the P50 walks keep the published P10 they stood on', () => {
  const missingTs = phx(11, 17, 15);
  const mk = (n: number, nowMs = phx(11, 17, 13)): NightChargeInputDeps => {
    const d = night1117({ nowMs, n });
    d.bandHours = d.bandHours.map((h) => (h.ts === missingTs ? { ...h, pvP50W: null } : h));
    return d;
  };
  const prov = buildNightChargeInputs(mk(4));
  assert.equal(hourAt(prov.horizon, missingTs).pvP10W, 0);
  assert.equal(hourAt(prov.horizon, missingTs).pvP50W, SUN_P10_W, 'the stand-in the expected carry read');
  const full = buildNightChargeInputs(mk(14));
  assert.equal(hourAt(full.horizon, missingTs).pvP10W, SUN_P10_W, 'unchanged on the full basis');
  assert.equal(hourAt(full.horizon, missingTs).pvP50W, null);
  // The expected (P50) carry to the window open crosses that hour and does not move.
  const unwidened = computeNightChargePlan(buildNightChargeInputs({ ...mk(14), calScoredDays: 14 }));
  const provPlan = computeNightChargePlan(prov);
  assert.ok(provPlan.expectedStartSocPct != null);
  assert.equal(provPlan.expectedStartSocPct, unwidened.expectedStartSocPct);
});

/** The 11-17 night as a long gap (no full-length window for more than a day after it): the
 *  pre-peak P10 surplus from the window close (05:00) to the on-peak start (16:00). Five hours
 *  09:00-13:00 carry P50 5,000 W / P10 3,000 W against a 2,000 W load: published surplus
 *  5 × 1.0 = 5.00 kWh. At n = 6 (k = 1.1407) the P10 is 5,000 − 1.1407 × 2,000 = 2,718.6 W:
 *  5 × 0.7186 = 3.593 → 3.59 kWh. */
function longGapNight(n: number, withBasis = true): NightChargeInputDeps {
  const winEnd = WIN_END;
  const hours = [] as Array<{ ts: number; p10W: number; p50W: number | null; loadW: number }>;
  for (let ts = winEnd; ts < phx(11, 18, 20); ts += H) {
    const sun = phxHour(ts) >= 9 && phxHour(ts) <= 13;
    hours.push({ ts, p10W: sun ? 3000 : 0, p50W: sun ? 5000 : 0, loadW: 2000 });
  }
  const isOnPeakAt = (ts: number): boolean => phxHour(ts) >= 16 && phxHour(ts) < 19;
  const basis = { hours, windowEndMs: winEnd, isOnPeakAt };
  const d = night1117({
    n,
    over: {
      objectiveMode: 'cost', costMaxSocPct: 99, longGapAhead: true,
      prePeakPvSurplusP10Kwh: pessimisticPrePeakSurplus(basis).kwh,
      ...(withBasis ? { prePeakSurplusBasis: basis } : {}),
    },
  });
  return d;
}

test('★★★ hand-worked: a long-gap night keeps only the WIDENED pre-peak P10 surplus as headroom', () => {
  assert.equal(longGapNight(6).prePeakPvSurplusP10Kwh, 5, 'the published surplus index.ts computes');
  const prov = buildNightChargeInputs(longGapNight(6));
  assert.equal(prov.prePeakPvSurplusP10Kwh, 3.59);
  // Unwidened on the full basis — the published figure, verbatim.
  assert.equal(buildNightChargeInputs(longGapNight(14)).prePeakPvSurplusP10Kwh, 5);
  // The ceiling rises with the narrower headroom: (92.16 − 3.59) / 92.16 = 96.1% against 94.6%.
  const pProv = computeNightChargePlan(prov);
  const pFull = computeNightChargePlan(buildNightChargeInputs({ ...longGapNight(6), calScoredDays: 14 }));
  assert.equal(pProv.costCeilingSocPct, 96.1);
  assert.equal(pFull.costCeilingSocPct, 94.6);
  // A provisional plan with no hours to widen sets the headroom aside (the full long-gap buy).
  const bare = buildNightChargeInputs(longGapNight(6, false));
  assert.equal(bare.prePeakPvSurplusP10Kwh, null);
  assert.equal(computeNightChargePlan(bare).costCeilingSocPct, 99);
});

/* ── nothing moves at 14 ────────────────────────────────────────────────── */

const GOLDEN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/legacyIdentity.golden.json'), 'utf8')) as {
  digests: Record<string, string>;
};
const isOnPeakAps = (ts: number): boolean => rateAt(MODEL, ts).isOnPeak;
/** The pre-peak hours index.ts hands the planner, rebuilt from a legacy case's band. */
function withPrePeakBasis(d: NightChargeInputDeps): NightChargeInputDeps {
  // The 2026-10-12 nights (their own tariff stub) pass no pre-peak surplus: nothing to rebuild.
  if (d.prePeakPvSurplusP10Kwh === undefined) return d;
  const w = resolveCheapWindow(apsPeriodIdAt, d.nowMs, 'overnight', 30);
  if (!w) return d;
  const basis = {
    hours: d.bandHours.map((h) => ({ ts: h.ts, p10W: h.pvP10W, p50W: h.pvP50W ?? null, loadW: h.loadP50W! })),
    windowEndMs: w.endMs, isOnPeakAt: isOnPeakAps,
  };
  // The rebuild is the computation the fixture made.
  assert.equal(pessimisticPrePeakSurplus(basis).kwh, d.prePeakPvSurplusP10Kwh ?? null);
  return { ...d, prePeakSurplusBasis: basis } as NightChargeInputDeps;
}

test('★★★ a year of plans with the provisional minimum passed: every 30-day plan is byte-identical; only 9-day plans move', () => {
  const cases = legacyIdentityCases();
  let moved = 0;
  let identical = 0;
  for (const c of cases) {
    const d = { ...withPrePeakBasis(c.deps), provisionalMinCalScoredDays: 4 } as NightChargeInputDeps;
    const p = planOf(d);
    const golden = GOLDEN.digests[c.label];
    const passesElse = c.deps.forecastPresent && c.deps.confidenceTier !== 'climatology' && c.deps.bandCoverageFrac >= 0.78;
    if (c.deps.calScoredDays >= 14 || !passesElse) {
      assert.equal(planDigest(p), golden, `${c.label}: moved`);
      identical++;
    } else {
      assert.equal(c.deps.calScoredDays, 9);
      assert.notEqual(planDigest(p), golden, `${c.label}: a 9-day plan with every other gate passing now plans`);
      assert.equal(p.basisComplete, true, c.label);
      if (p.requiredExtraKwh != null) assert.equal(p.pvBandWiden?.factor, 1.0535, c.label);
      else assert.equal('pvBandWiden' in p, false, `${c.label}: no window, nothing sized, nothing widened`);
      moved++;
    }
  }
  assert.ok(moved >= 10, `not vacuous: ${moved} provisional plans`);
  assert.ok(identical > 1000);
});

test('★★ n = 14 and n = 30 give the same plan, byte for byte (calScoredDays never reaches the plan past the gate)', () => {
  for (const nowMs of [NOW_1117, phx(11, 17, 13)]) {
    assert.equal(JSON.stringify(planOf(night1117({ nowMs, n: 14 }))), JSON.stringify(planOf(night1117({ nowMs, n: 30 }))));
  }
});

/* ── the safe direction, over a year of live-shaped nights ─────────────── */

test('★★★ the widening only ever moves the plan toward buying more (n = 4..13 against the same night unwidened)', () => {
  const cases = legacyIdentityCases().filter((c) => c.deps.forecastPresent && c.deps.confidenceTier !== 'climatology');
  let compared = 0, armedBoth = 0, outsideBand = 0, longGap = 0, turnedShort = 0;
  let requirementFell = 0, expectedRose = 0, expectedFell = 0;
  cases.forEach((c, i) => {
    const n = 4 + (i % 10);
    const base = { ...withPrePeakBasis(c.deps), provisionalMinCalScoredDays: 4, bandCoverageFrac: 0.85 } as NightChargeInputDeps;
    // The same night with no widening at all: the full basis, with no realized half-width.
    const flatIn = buildNightChargeInputs({ ...base, calScoredDays: 14, realizedDailyErrHalfFrac: 0 });
    const provIn = buildNightChargeInputs({ ...base, calScoredDays: n });
    assert.equal(provIn.basisComplete, true, c.label);
    assert.equal(provIn.pvBandWiden?.factor, nca.provisionalBandWiden(n), c.label);
    // Every hour: no more PV, no less load; the medians untouched.
    assert.deepEqual(provIn.horizon.map((h) => h.ts), flatIn.horizon.map((h) => h.ts), c.label);
    provIn.horizon.forEach((h, j) => {
      const f = flatIn.horizon[j];
      assert.ok(h.pvP10W <= f.pvP10W + 1e-9, `${c.label} @${j}: P10 ${h.pvP10W} > ${f.pvP10W}`);
      assert.ok(h.loadP90W >= f.loadP90W - 1e-9, `${c.label} @${j}: load ${h.loadP90W} < ${f.loadP90W}`);
      assert.equal(h.pvP50W, f.pvP50W, c.label);
      assert.equal(h.loadP50W, f.loadP50W, c.label);
    });
    if (provIn.longGapAhead && flatIn.prePeakPvSurplusP10Kwh != null) {
      longGap++;
      assert.ok(provIn.prePeakPvSurplusP10Kwh == null || provIn.prePeakPvSurplusP10Kwh <= flatIn.prePeakPvSurplusP10Kwh + 1e-9, c.label);
    }
    const prov = computeNightChargePlan(provIn);
    const flat = computeNightChargePlan(flatIn);
    compared++;
    // The P50 disclosures the widening must not touch, and the morning surplus (P90 PV).
    assert.equal(prov.expectedStartSocPct, flat.expectedStartSocPct, `${c.label}: expected start`);
    assert.equal(provIn.morningPvSurplusP90Kwh, flatIn.morningPvSurplusP90Kwh, `${c.label}: morning surplus`);
    // The figures computed FROM what is written move only with it: the expected buy and the
    // just-in-time start read the written level (and move either way with it — a higher stop starts
    // the force-charge earlier, so the pool drains less before it and less is bought back), and the
    // over-buy flag reads the requirement and the lift.
    const writeMoved = prov.chargeTonight !== flat.chargeTonight || prov.setpointSocPct !== flat.setpointSocPct
      || prov.costCeilingSocPct !== flat.costCeilingSocPct;
    if ((prov.expectedBuyKwh ?? null) !== (flat.expectedBuyKwh ?? null)) {
      assert.ok(writeMoved, `${c.label}: the expected buy moved (${flat.expectedBuyKwh} → ${prov.expectedBuyKwh}) under the same write`);
      if ((prov.expectedBuyKwh ?? 0) > (flat.expectedBuyKwh ?? 0)) expectedRose++;
      else expectedFell++;
    }
    if ((prov.expectedForceChargeStartMs ?? null) !== (flat.expectedForceChargeStartMs ?? null)) {
      assert.ok(writeMoved, `${c.label}: the just-in-time start moved under the same write`);
    }
    if ((prov.bindingCap === 'overBuy') !== (flat.bindingCap === 'overBuy')) {
      assert.ok(writeMoved || prov.requiredExtraKwh !== flat.requiredExtraKwh || prov.buyKwh !== flat.buyKwh
        || prov.cushionShortfall !== flat.cushionShortfall, `${c.label}: the over-buy flag moved under the same requirement and write`);
    }
    // The requirement falls only where the widening turns a meetable night unmeetable: the planner then
    // states the pool-headroom placeholder, which can sit under the meetable requirement.
    if (flat.requiredExtraKwh != null && prov.requiredExtraKwh != null && prov.requiredExtraKwh < flat.requiredExtraKwh - 1e-6) {
      requirementFell++;
      assert.ok(!flat.cushionShortfall && prov.cushionShortfall, `${c.label}: requirement ${flat.requiredExtraKwh} → ${prov.requiredExtraKwh}`);
      assert.equal(prov.bindingCap, 'poolHeadroom', `${c.label}: the placeholder`);
    }
    // The cost ceiling (the force-charge stop) never falls.
    if (flat.costCeilingSocPct != null) {
      assert.ok(prov.costCeilingSocPct != null && prov.costCeilingSocPct >= flat.costCeilingSocPct - 1e-9,
        `${c.label}: ceiling ${prov.costCeilingSocPct} < ${flat.costCeilingSocPct}`);
    }
    // What is written: the armed reserve and force-charge ceiling never fall.
    const armF = armFromPlan(emptyActuationState(), '2026-01-01', flat, c.deps.nowMs, 16);
    const armP = armFromPlan(emptyActuationState(), '2026-01-01', prov, c.deps.nowMs, 16);
    if (armF && armP) {
      armedBoth++;
      assert.ok(prov.setpointSocPct! >= flat.setpointSocPct! - 1e-9, `${c.label}: setpoint ${prov.setpointSocPct} < ${flat.setpointSocPct}`);
      assert.ok(armP.targetPct! >= armF.targetPct!, `${c.label}: written reserve`);
      assert.ok((armP.forceChargeCeilingPct ?? -1) >= (armF.forceChargeCeilingPct ?? -1), `${c.label}: written ceiling`);
    }
    // The requirement never falls on a night both plans can meet.
    if (!prov.cushionShortfall && !flat.cushionShortfall && flat.requiredExtraKwh != null) {
      assert.ok(prov.requiredExtraKwh! >= flat.requiredExtraKwh - 1e-6, `${c.label}: requirement ${prov.requiredExtraKwh} < ${flat.requiredExtraKwh}`);
    }
    // Where the window lies inside the 24 h band (its load is unchanged), the decision never falls,
    // and on a night both plans can meet neither does the modelled buy. Beyond the band the widened
    // load can derate the window's charge rate. buyKwh is the modelled lift, not the write: when the
    // widening turns a meetable night unmeetable the planner states the legacy full-pack proxy
    // (requiredExtraKwh = the pool headroom), which can sit under the meetable requirement — the
    // write above (setpoint, reserve, force-charge ceiling) still does not fall. targetSocPct is the
    // islanded arrival, not an ask: with less P10 sun before the window the carry opens it lower, and
    // where the charge rate binds the arrival is lower by as much (2026-10-13 13:00: 57.2 → 52.2%,
    // the same buy and the same 62.4% setpoint), so it is not asserted.
    const lastBand = Math.max(...base.bandHours.map((h) => h.ts)) + H;
    if (flat.window && flat.window.endMs <= lastBand) {
      if (flat.chargeTonight) assert.equal(prov.chargeTonight, true, `${c.label}: a charge night stays one`);
      if (armF) assert.ok(armP, `${c.label}: an armed night stays armed`);
      if (!prov.cushionShortfall && !flat.cushionShortfall) {
        assert.ok((prov.buyKwh ?? 0) >= (flat.buyKwh ?? 0) - 1e-6, `${c.label}: buy ${prov.buyKwh} < ${flat.buyKwh}`);
      } else if (prov.cushionShortfall && !flat.cushionShortfall) {
        turnedShort++;
      }
    } else if (flat.window) {
      outsideBand++;
    }
  });
  assert.ok(compared > 1000, `${compared}`);
  assert.ok(armedBoth > 300, `armed nights compared: ${armedBoth}`);
  assert.ok(outsideBand > 0, 'a window beyond the band (a Saturday plan for Monday) is in the year');
  assert.ok(longGap > 20, `long-gap nights with a P10 headroom: ${longGap}`);
  // 1,035 nights compared, 609 armed both ways, 99 windows beyond the band,
  // 159 long gaps with a P10 headroom, 22 nights the widening turned unmeetable (the write held).
  assert.ok(turnedShort > 0, 'a night the widening turns unmeetable is in the year (its write is held above)');
  // The disclosures the CHANGELOG and chapter 15 part 1 name as moving do move, in the year:
  // the requirement falls on a night turned unmeetable, and the expected buy moves both ways
  // (here 2 requirement falls, the expected buy 20 up and 3 down; over every n = 4..13 of the
  // 1,035 nights, 25, 209 and 21 of 10,350).
  assert.ok(requirementFell > 0, `the requirement falls on a night turned unmeetable: ${requirementFell}`);
  assert.ok(expectedRose > 0 && expectedFell > 0, `the expected buy moves both ways: +${expectedRose} / −${expectedFell}`);
});

/* ── what is published, what is recorded ───────────────────────────────── */

test('★★★ the plan names its provisional band: the field, the rationale, the card and the push say the same thing', () => {
  const p = planOf(night1117());
  const clause = ' PROVISIONAL SOLAR BAND: 4 of 14 calibration days scored, so the P10 PV this plan is sized on is widened ×1.31'
    + ' (the next 24 h: ~21.9 → ~16.9 kWh) and the multi-day carry by ±56% per √day; the full band returns at 14 scored days.';
  assert.equal(nca.provisionalBandText(p.pvBandWiden), clause);
  assert.ok(p.rationale.endsWith(clause), p.rationale);
  // The card mirrors it, word for word, after the sizing line.
  assert.equal(web.provisionalBandText(p.pvBandWiden), clause);
  assert.ok(web.sizingLine(p)!.endsWith(`kWh.${clause}`), web.sizingLine(p)!);
  // The push states it after the confidence tier, before the write it arms.
  const m = buildNightChargeMessage(p, 'charge', { cancelDeadlineText: 'Until 22:45,', targetPct: 32 });
  assert.ok(m.body.includes(`Confidence: forecast.${clause} SUPERVISED: Until 22:45,`), m.body);
  const heldPush = buildNightChargeMessage({ ...p, expectedBuyKwh: 0 }, 'charge', { cancelDeadlineText: 'Until 22:45,', targetPct: 32 });
  assert.ok(heldPush.title.includes('no charge expected'), heldPush.title);
  assert.ok(heldPush.body.includes(`${clause} SUPERVISED: Until 22:45,`), heldPush.body);
  // A hold on the provisional basis carries it too; a full-basis plan carries nothing.
  const hold = planOf(night1117({ over: { socNowPct: 90 } }));
  assert.equal(hold.chargeTonight, false);
  assert.equal(hold.basisComplete, true);
  assert.deepEqual(hold.pvBandWiden, p.pvBandWiden);
  assert.ok(hold.rationale.endsWith(clause));
  // ... and the hold push and the card's hold summary close with it: every hold shape that was SIZED
  // (the cushion holds, the need under the minimum buy, the window that cannot cover the cushion).
  // The sentence is the only thing the provisional band adds to them.
  const unprovisional = (q: NightChargePlan): NightChargePlan => ({ ...q, pvBandWiden: undefined });
  const holds: Array<[string, NightChargePlan, string, string]> = [
    ['no charge needed', hold, 'Night-charge: hold (no charge needed)', 'No overnight charge needed.'],
    ['under the minimum buy', { ...hold, requiredExtraKwh: 0.63 }, 'Night-charge: hold (the need is under the minimum buy)', 'No overnight charge tonight.'],
    ['the window cannot cover the cushion', { ...hold, requiredExtraKwh: 3, cushionShortfall: true },
      'Night-charge: no charge tonight (the window cannot cover the cushion)', 'No overnight charge tonight — the window cannot cover the cushion.'],
  ];
  for (const [name, h, title, headline] of holds) {
    const push = buildNightChargeMessage(h, 'hold');
    assert.equal(push.title, title, name);
    assert.ok(push.body.endsWith(clause), `${name}: ${push.body}`);
    assert.equal(push.body, buildNightChargeMessage(unprovisional(h), 'hold').body + clause, name);
    const card = web.holdSummary(h);
    assert.equal(card.headline, headline, name);
    assert.ok(card.detail.endsWith(clause), `${name}: ${card.detail}`);
    assert.equal(card.detail, web.holdSummary(unprovisional(h)).detail + clause, name);
    // Beside a write that stands, the sentence stays with the hold it describes, before the note.
    assert.equal(web.holdSummary(h, { writeStands: true }).detail,
      `${web.holdSummary(unprovisional(h), { writeStands: true }).detail.replace(` ${web.WRITE_STANDS_NOTE}`, '')}${clause} ${web.WRITE_STANDS_NOTE}`, name);
  }
  // A hold with no window was sized on nothing: it says nothing of the band (the plan carries no field).
  const noWindow = { ...hold, requiredExtraKwh: null };
  assert.ok(!buildNightChargeMessage(noWindow, 'hold').body.includes('PROVISIONAL'));
  assert.ok(!web.holdSummary(noWindow).detail.includes('PROVISIONAL'));
  // A full-basis hold says nothing either.
  const fullHold = planOf(night1117({ n: 14, over: { socNowPct: 90 } }));
  assert.equal(fullHold.chargeTonight, false);
  assert.equal('pvBandWiden' in fullHold, false);
  assert.ok(!buildNightChargeMessage(fullHold, 'hold').body.includes('PROVISIONAL'));
  assert.ok(!web.holdSummary(fullHold).detail.includes('PROVISIONAL'));
  const full = planOf(night1117({ n: 14 }));
  assert.equal('pvBandWiden' in full, false);
  assert.equal(nca.provisionalBandText(full.pvBandWiden), '');
  assert.equal(web.provisionalBandText(full.pvBandWiden), '');
  assert.ok(!full.rationale.includes('PROVISIONAL'));
  assert.ok(!buildNightChargeMessage(full, 'charge', { cancelDeadlineText: 'Until 22:45,', targetPct: 32 }).body.includes('PROVISIONAL'));
  // A refused plan carries no provisional field either.
  assert.equal('pvBandWiden' in planOf(night1117({ n: 3 })), false);
});

test('★★ the 21:30 "no plan tonight" push names the provisional minimum', () => {
  const m = buildNightChargeMessage(planOf(night1117({ n: 2 })), 'insufficient_basis');
  assert.equal(m.body,
    'No overnight charge plan tonight — the forecast/telemetry basis is incomplete: only 2 scored calibration day(s), need 4 '
    + '(a provisional plan on a widened solar band from 4; the full band from 14), so nothing will be charged. '
    + '(This confirms the evening job ran; the reserve floor is unchanged.)');
  // The likeliest refusal after a return: 4 days scored, one of them outside the band. The day count
  // passed, and the push says so rather than "calDays 4/14".
  const cov = buildNightChargeMessage(planOf(night1117({ n: 4, coverage: 0.75 })), 'insufficient_basis');
  assert.equal(cov.body,
    'No overnight charge plan tonight — the forecast/telemetry basis is incomplete: PV band coverage 75% < 78% '
    + '(forecast present, tier=forecast, calDays 4/4, provisional band below 14), so nothing will be charged. '
    + '(This confirms the evening job ran; the reserve floor is unchanged.)');
});

test('★★★ the write path: a provisional plan arms and, in auto mode with readiness not graduated, is written', () => {
  const p = planOf(night1117());
  const armed = armFromPlan(emptyActuationState(), '2026-11-17', p, NOW_1117, 16);
  assert.ok(armed, 'the provisional plan arms');
  assert.equal(armed!.targetPct, 32);
  // Readiness BLOCKED/LEARNING: writeReady false demotes auto to supervised — the same write.
  const act = decideActuation(armed!, WIN_START, {
    mode: 'auto', writeReady: false, currentReservePct: 16, socCoherent: true, vitalsRed: false, gridPresent: true,
  });
  assert.deepEqual(act, { kind: 'apply', targetPct: clampReserveTarget(32) });
});

/* ── integration pins (index.ts has no seam a unit test can drive) ─────── */

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★★★ index.ts passes the provisional minimum (4) beside the full one (14), and the pre-peak hours with their P50', () => {
  assert.ok(INDEX.includes('const NIGHT_MIN_CAL_DAYS = 14;'), 'the full band still needs 14');
  assert.ok(INDEX.includes('const NIGHT_PROVISIONAL_MIN_CAL_DAYS = 4;'));
  assert.ok(INDEX.includes('minCalScoredDays: NIGHT_MIN_CAL_DAYS, provisionalMinCalScoredDays: NIGHT_PROVISIONAL_MIN_CAL_DAYS,'));
  assert.ok(INDEX.includes('prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p10W, p50W: pb.p50W, loadW: fh.forecastLoadW });'));
  assert.ok(INDEX.includes('const prePeakPvSurplusP10Kwh = prePeakSurplusBasis ? pessimisticPrePeakSurplus(prePeakSurplusBasis).kwh : null;'),
    'the published pre-peak surplus and the provisional one are summed over the same hours, bounds and on-peak test');
  assert.match(INDEX, /prePeakPvSurplusP10Kwh,\n\s*costSurplusLoad,\n\s*prePeakSurplusBasis,\n/,
    'computed AND passed — an input computed and never passed is the v1.125.0 trap');
});

test('★★ the ledger records the PUBLISHED band: pv_p10_kwh sums the probabilistic P10, never the widened one (source pin)', () => {
  // The readiness gate grades pv_in_band on pv_p10_kwh/pv_p90_kwh; recording the widened P10 would
  // read the band as over-wide and change a scored column's meaning (CURRENT_ALGO_VERSION 3 holds).
  assert.ok(INDEX.includes('    pvP10 += pb.p10W / 1000;'));
  assert.ok(INDEX.includes('pvP10Kwh: round2(pvP10), pvP50Kwh: round2(pvP50), pvP90Kwh: round2(pvP90),'));
});
