import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePvBiasCorrection,
  PV_BIAS_CLAMP_LO,
  PV_BIAS_CLAMP_HI,
  PV_BIAS_MIN_MATURE_DAYS,
  type SolarResponseModel,
} from '../src/analytics.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * runwayPvBiasCorrection — the v0.93.0 (audit #3) ALARM-SAFETY contract.
 *
 * The GHI→PV solar model over-predicts on cloudy days (field biasFactor ≈0.62).
 * Before v0.93.0 that factor fed the confidence report ONLY; the alarm-facing
 * forecast.hours[].forecastPvW series (consumed by computeRunway,
 * computeMultiDayForecast, and computeProbabilistic) used the RAW model PV, so
 * over-predicted PV shrank the runway deficit → latent islanding UNDER-alarm.
 *
 * computePvBiasCorrection re-derives the bias factor from the same solar model +
 * GHI + actual PV the forecast builder holds, and returns a CLAMPED, GUARDED
 * scalar that the builder multiplies forecast PV by BEFORE those consumers see it.
 * This file pins its safety contract:
 *   (1) null / < 3 mature weather-covered days ⇒ 1.0 (unchanged behaviour).
 *   (2) a mature over-predicting model ⇒ PV scaled DOWN (factor < 1) toward the
 *       actual/predicted ratio — the CONSERVATIVE (shorter-runway) direction.
 *   (3) the clamp bounds [0.5, 1.2] are enforced against extreme hindcast ratios.
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A fixed local-day anchor (midnight) so hour-of-day indexing is deterministic. */
const TODAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

/** Solar model with a constant coeff at every hour (W of PV per W/m² of GHI). */
function modelWithCoeff(coeff: number): SolarResponseModel {
  return {
    hourly: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      coeff,
      r2: 0.95,
      samples: 100,
      observedMaxPvW: 10_000,
    })),
    peakCoeff: coeff,
    pairCount: 240,
    historyDays: 30,
  };
}

/**
 * Build a GHI-by-hour-epoch map + a per-SN actual-PV series over the last
 * `days` covered days. Each covered day gets GHI at daytime hours 9..15 (7 hrs).
 * `actualWPerHour` is the constant actual PV each of those daytime hours reports.
 * predWh per covered day = coeff·ghi · 7 hours; actWh = actualWPerHour · 7 hours.
 */
function fixtures(opts: {
  days: number;
  ghiWm2: number;
  actualWPerHour: number;
}): { ghiByEpoch: Map<number, number>; pvBySn: Map<string, Array<{ ts: number; value: number }>> } {
  const ghiByEpoch = new Map<number, number>();
  const pv: Array<{ ts: number; value: number }> = [];
  // Oldest day first so the pv series is ts-ASCENDING — the recorder always returns
  // ascending points and sliceByTsInclusive (binary-searched) requires that ordering.
  for (let i = opts.days; i >= 1; i--) {
    const dayStart = TODAY_START - i * DAY_MS;
    for (let h = 9; h <= 15; h++) {
      const hourStart = dayStart + h * HOUR_MS;
      ghiByEpoch.set(Math.floor(hourStart / HOUR_MS), opts.ghiWm2);
      // Two samples inside the hour → their mean is the constant actual W.
      pv.push({ ts: hourStart + 10 * 60_000, value: opts.actualWPerHour });
      pv.push({ ts: hourStart + 40 * 60_000, value: opts.actualWPerHour });
    }
  }
  return { ghiByEpoch, pvBySn: new Map([['A', pv]]) };
}

/* ─── (1) insufficient / null data ⇒ no-op 1.0 ─────────────────────────── */

test('computePvBiasCorrection — NO covered days ⇒ factor 1.0 (no-op, PV unchanged)', () => {
  const f = computePvBiasCorrection(
    modelWithCoeff(2),
    new Map(),                                  // no GHI at all
    new Map([['A', []]]),                       // no actual PV
    TODAY_START,
  );
  assert.equal(f, 1.0, 'empty hindcast must fall back to 1.0');
});

test('computePvBiasCorrection — fewer than 3 mature days ⇒ factor 1.0 (guard blocks premature activation)', () => {
  // Only 2 covered/mature days present → below PV_BIAS_MIN_MATURE_DAYS → no-op.
  assert.equal(PV_BIAS_MIN_MATURE_DAYS, 3, 'the maturity gate is 3 days');
  const { ghiByEpoch, pvBySn } = fixtures({ days: 2, ghiWm2: 500, actualWPerHour: 620 });
  const f = computePvBiasCorrection(modelWithCoeff(2), ghiByEpoch, pvBySn, TODAY_START);
  assert.equal(f, 1.0, '2 mature days is below the 3-day gate ⇒ 1.0');
});

test('computePvBiasCorrection — an UNFIT model (coeff null) never produces a prediction ⇒ factor 1.0', () => {
  // coeff null ⇒ predWh stays 0 for every hour ⇒ no mature day ⇒ no-op. A model that
  // cannot predict must never bias the alarm PV.
  const unfit: SolarResponseModel = {
    hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, coeff: null, r2: 0, samples: 0, observedMaxPvW: 0 })),
    peakCoeff: 0, pairCount: 0, historyDays: 30,
  };
  const { ghiByEpoch, pvBySn } = fixtures({ days: 5, ghiWm2: 500, actualWPerHour: 620 });
  const f = computePvBiasCorrection(unfit, ghiByEpoch, pvBySn, TODAY_START);
  assert.equal(f, 1.0, 'unfit model ⇒ no prediction ⇒ 1.0');
});

/* ─── (2) mature over-prediction ⇒ PV scaled DOWN (conservative) ────────── */

test('computePvBiasCorrection — mature OVER-predicting model ⇒ factor ≈ actual/predicted < 1 (shortens runway)', () => {
  // coeff 2 × GHI 500 = 1000 W predicted/hour; actual 620 W/hour ⇒ ratio 0.62.
  // 5 covered days, each 7 daytime hours: predKwh/day = 1000·7/1000 = 7 kWh,
  // actKwh/day = 620·7/1000 = 4.34 kWh — both mature (pred > 0.5, act > 0.5,
  // pred ≥ 0.25·act). Sum ratio = 4.34/7 = 0.62.
  const { ghiByEpoch, pvBySn } = fixtures({ days: 5, ghiWm2: 500, actualWPerHour: 620 });
  const f = computePvBiasCorrection(modelWithCoeff(2), ghiByEpoch, pvBySn, TODAY_START);
  assert.ok(f < 1.0, `over-prediction must scale PV down (got ${f})`);
  assert.ok(Math.abs(f - 0.62) < 1e-6, `factor must equal the actual/predicted ratio 0.62 (got ${f})`);
  assert.ok(f >= PV_BIAS_CLAMP_LO && f <= PV_BIAS_CLAMP_HI, 'in-clamp ratio passes through unclamped');
});

test('computePvBiasCorrection — an accurate model (actual ≈ predicted) ⇒ factor ≈ 1.0 (near no-op)', () => {
  // coeff 2 × GHI 500 = 1000 W predicted; actual 1000 W ⇒ ratio 1.0.
  const { ghiByEpoch, pvBySn } = fixtures({ days: 5, ghiWm2: 500, actualWPerHour: 1000 });
  const f = computePvBiasCorrection(modelWithCoeff(2), ghiByEpoch, pvBySn, TODAY_START);
  assert.ok(Math.abs(f - 1.0) < 1e-6, `accurate model ⇒ ≈1.0 (got ${f})`);
});

/* ─── (3) clamp bounds enforced against extreme hindcast ratios ─────────── */

test('computePvBiasCorrection — a GROSS over-predict clamps at the 0.5 floor (never shortens runway to an untrusted extreme)', () => {
  // coeff 2 × GHI 500 = 1000 W predicted; actual 200 W ⇒ raw ratio 0.20, below floor.
  // (pred 7 kWh ≥ 0.25·act 1.4 kWh ⇒ still counts as mature.) Must clamp to 0.5.
  const { ghiByEpoch, pvBySn } = fixtures({ days: 5, ghiWm2: 500, actualWPerHour: 200 });
  const f = computePvBiasCorrection(modelWithCoeff(2), ghiByEpoch, pvBySn, TODAY_START);
  assert.equal(f, PV_BIAS_CLAMP_LO, `raw 0.20 must clamp to the ${PV_BIAS_CLAMP_LO} floor (got ${f})`);
});

test('computePvBiasCorrection — an UNDER-predicting model clamps at the 1.2 ceiling (bounded runway-lengthening)', () => {
  // coeff 2 × GHI 500 = 1000 W predicted; actual 2000 W ⇒ raw ratio 2.0, above ceiling.
  // A correction > 1 LENGTHENS runway, so it is capped hard at 1.2 — never trust an
  // unclamped upward hindcast scalar to erode the alarm margin.
  const { ghiByEpoch, pvBySn } = fixtures({ days: 5, ghiWm2: 500, actualWPerHour: 2000 });
  const f = computePvBiasCorrection(modelWithCoeff(2), ghiByEpoch, pvBySn, TODAY_START);
  assert.equal(f, PV_BIAS_CLAMP_HI, `raw 2.0 must clamp to the ${PV_BIAS_CLAMP_HI} ceiling (got ${f})`);
});

test('computePvBiasCorrection — factor is ALWAYS within [0.5, 1.2] across a sweep of actual/predicted ratios', () => {
  for (const actualW of [50, 200, 400, 620, 800, 1000, 1400, 2000, 5000]) {
    const { ghiByEpoch, pvBySn } = fixtures({ days: 5, ghiWm2: 500, actualWPerHour: actualW });
    const f = computePvBiasCorrection(modelWithCoeff(2), ghiByEpoch, pvBySn, TODAY_START);
    assert.ok(
      f >= PV_BIAS_CLAMP_LO - 1e-9 && f <= PV_BIAS_CLAMP_HI + 1e-9,
      `factor ${f} for actual=${actualW}W must stay in the clamp [${PV_BIAS_CLAMP_LO}, ${PV_BIAS_CLAMP_HI}]`,
    );
  }
});
