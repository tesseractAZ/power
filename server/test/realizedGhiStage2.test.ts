import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  preferRealizedGhiRows,
  buildRealizedGhiByEpoch,
  buildGhiByEpoch,
  dayHasGhiCoverage,
  computeForecastSkill,
  computeSoilingDecomposition,
  getDayForecast,
  resetForecastCachesForTesting,
  type DayForecast,
  type HourResponse,
  type SolarResponseModel,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, type WeatherHour } from '../src/weather.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

/**
 * v1.173.0 — GHI stage 2: the model/display consumers of stored irradiance switch to the
 * REALIZED series (`weather/ghi_wm2_realized`, captured since stage 1) where it exists, and
 * keep the first-write `ghi_wm2` hour by hour where it does not. The PV band calibrator does
 * NOT switch: its basis moves the night-charge basis gate and the multi-day P10/P90 widening
 * that sizes a buy, so that is an owner decision. These tests pin both halves — what moved,
 * and that the calibrator (and the default) did not.
 */

const H = 3_600_000;
const DAY = 24 * H;
type Row = { ts: number; value: number };
const row = (epoch: number, value: number): Row => ({ ts: epoch * H, value });
const wh = (epoch: number, radiationWm2: number): WeatherHour =>
  ({ ts: epoch * H, radiationWm2, cloudCoverPct: 0, tempC: 25 });

beforeEach(() => { resetForecastCachesForTesting(); });
afterEach(() => { clearWeatherTestOverride(); });

/* ── T1: preferRealizedGhiRows (pure) ─────────────────────────────────── */

test('preferRealizedGhiRows — a realized reading replaces the first-write forecast at the same hour', () => {
  const e = 500_000;
  assert.deepEqual(preferRealizedGhiRows([row(e, 300)], [row(e, 600)]), [row(e, 600)]);
});

test('preferRealizedGhiRows — first-write rows pass through where no realized row exists (pre-capture AND future hours)', () => {
  const e = Math.floor(Date.now() / H) - 48;
  const preCapture = row(e - 200, 410);           // before capture began: past_days cannot backfill it
  const future = row(e + 53, 777);                // a forecast hour (now + 5 h): nothing can be realized yet
  const out = preferRealizedGhiRows([preCapture, row(e, 300), future], [row(e, 600)]);
  assert.deepEqual(out, [preCapture, row(e, 600), future], 'no consumer loses coverage it had');
});

test('preferRealizedGhiRows — a realized 0 is an explicit dark hour and replaces a non-zero forecast', () => {
  const e = 500_000;
  assert.deepEqual(preferRealizedGhiRows([row(e, 250)], [row(e, 0)]), [row(e, 0)]);
});

test('preferRealizedGhiRows — NaN, Infinity and negative realized values are ignored', () => {
  const e = 500_000;
  const out = preferRealizedGhiRows(
    [row(e, 300), row(e + 1, 310), row(e + 2, 320)],
    [row(e, Number.NaN), row(e + 1, Number.POSITIVE_INFINITY), row(e + 2, -5)],
  );
  assert.deepEqual(out, [row(e, 300), row(e + 1, 310), row(e + 2, 320)]);
});

test('preferRealizedGhiRows — one row per hour, ascending by ts, whatever the input order', () => {
  const e = 500_000;
  const out = preferRealizedGhiRows(
    [row(e + 3, 30), row(e, 1), row(e + 1, 10)],
    [row(e + 2, 22), row(e + 1, 11), row(e + 4, 44)],
  );
  assert.deepEqual(out.map((r) => [r.ts / H - e, r.value]), [[0, 1], [1, 11], [2, 22], [3, 30], [4, 44]]);
});

/* ── T2 / T8: buildRealizedGhiByEpoch (pure) ─────────────────────────── */

test('buildRealizedGhiByEpoch — precedence realized > live cache > first-write', () => {
  const e = 600_000;
  const m = buildRealizedGhiByEpoch([row(e, 300), row(e + 1, 300), row(e + 2, 300)], [row(e, 600)], [wh(e, 450), wh(e + 1, 450)]);
  assert.equal(m.get(e), 600, 'all three sources → the realized reading');
  assert.equal(m.get(e + 1), 450, 'no realized row → the cache (the provider\'s past-hour estimate), NOT the forecast');
  assert.equal(m.get(e + 2), 300, 'only a first-write row → it still counts');
});

test('buildRealizedGhiByEpoch — a realized 0 removes the hour; zeros never register as coverage', () => {
  const e = 600_000;
  const m = buildRealizedGhiByEpoch([row(e, 80)], [row(e, 0)], [wh(e, 50)]);
  assert.equal(m.has(e), false, 'an explicit realized dark hour beats a cache/forecast value below it');

  const dayStart = startOfLocalDayMs() - 3 * DAY;
  const d0 = Math.floor(dayStart / H);
  const zeros = Array.from({ length: 24 }, (_, h) => row(d0 + h, 0));
  const all0 = buildRealizedGhiByEpoch(zeros, zeros, zeros.map((r) => wh(r.ts / H, 0)));
  assert.equal(all0.size, 0);
  assert.equal(dayHasGhiCoverage(all0, dayStart), false, 'an all-zero day is uncovered, as with buildGhiByEpoch');
});

test('★ restart gap: hours the capture has not reached yet come from the live cache, never the first-write forecast', () => {
  // ghiPersistTick first runs at boot+45 min and captures only up to the cache's fetch time,
  // so after a restart the newest realized row trails the clock. Those hours must be scored on
  // the cache's past-hour estimate — a restart IS an input change, and this bounds it.
  const now = 700_000;
  const firstWrite = [1, 2, 3, 4, 5, 6].map((k) => row(now - k, 100 + k));
  const realized = [4, 5, 6].map((k) => row(now - k, 500 + k));
  const cache = [1, 2, 3, 4, 5, 6].map((k) => wh(now - k, 300 + k));
  const m = buildRealizedGhiByEpoch(firstWrite, realized, cache);
  assert.deepEqual([6, 5, 4].map((k) => m.get(now - k)), [506, 505, 504], 'captured hours: realized wins over the cache');
  assert.deepEqual([3, 2, 1].map((k) => m.get(now - k)), [303, 302, 301], 'uncaptured hours: the cache, not 103/102/101');
});

test('buildGhiByEpoch is unchanged: first-write still beats the cache (the calibrator basis)', () => {
  const e = 600_000;
  assert.equal(buildGhiByEpoch([row(e, 300)], [wh(e, 450)]).get(e), 300);
});

/* ── T3: computeForecastSkill end-to-end ──────────────────────────────── */

const SKILL_SN = 'DPU-STAGE2';
const skillDevices: Record<string, DeviceSnapshot> = {
  [SKILL_SN]: { sn: SKILL_SN, deviceName: 'Core 1', online: true, projection: { kind: 'dpu', soc: 80, packs: [] } } as unknown as DeviceSnapshot,
};

function solarModelAt(hod: number, coeff: number): SolarResponseModel {
  const hourly: HourResponse[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h, coeff: h === hod ? coeff : null, r2: 0, samples: 0, observedMaxPvW: 0,
  }));
  return { hourly, peakCoeff: coeff, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 30 };
}

function skillForecast(model: SolarResponseModel): DayForecast {
  return {
    generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 15, hours: [],
    forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null,
    homeDpusConnected: 0, homeDpusReporting: 0, homeDpusCoveragePartial: false,
    forecastPvWhNext24Display: 0, typicalPvWhPerDayDisplay: 0,
    solarModel: model, restoredSolarModel: model, deviceModels: [], soiling: null,
  };
}

/** Yesterday local noon, computed exactly as the hindcast loop does. */
const skillHourStart = (): number => startOfLocalDayMs() - DAY + 12 * H;

function skillRecorder(opts: { firstWrite: number; realized: number | null }): Recorder {
  const hs = skillHourStart();
  return makeRecorderStub({
    query: (sn, metric) => {
      if (sn === 'weather' && metric === 'ghi_wm2') return [{ ts: hs, value: opts.firstWrite }];
      if (sn === 'weather' && metric === 'ghi_wm2_realized') return opts.realized == null ? [] : [{ ts: hs, value: opts.realized }];
      if (sn === SKILL_SN && metric === 'pv_total') return [{ ts: hs + 30 * 60_000, value: 6000 }];
      return [];
    },
  });
}

function setSkillWeather(cacheGhiAtHour: number | null): void {
  const hs = skillHourStart();
  const hours: WeatherHour[] = [{ ts: hs + 6 * H, radiationWm2: 0, cloudCoverPct: 0, tempC: 20 }];
  if (cacheGhiAtHour != null) hours.push({ ts: hs, radiationWm2: cacheGhiAtHour, cloudCoverPct: 0, tempC: 20 });
  setWeatherCacheForTesting({ fetchedAt: Date.now(), lat: 0, lon: 0, hours });
}

const yesterdayPredicted = async (rec: Recorder, basis?: 'first-write' | 'realized'): Promise<number> => {
  const fc = skillForecast(solarModelAt(new Date(skillHourStart()).getHours(), 10));
  const r = basis == null
    ? await computeForecastSkill(skillDevices, rec, fc, 7)
    : await computeForecastSkill(skillDevices, rec, fc, 7, basis);
  assert.equal(r.days.length, 7);
  return r.days[r.days.length - 1].predictedKwh;
};

test('★★ computeForecastSkill — the DEFAULT and explicit first-write basis are byte-identical to before; only an opt-in scores realized', async () => {
  setSkillWeather(null);
  const rec = skillRecorder({ firstWrite: 300, realized: 600 });
  assert.equal(await yesterdayPredicted(rec), 3.0, 'default basis: coeff 10 × first-write 300 W/m² = 3.0 kWh');
  resetForecastCachesForTesting();
  assert.equal(await yesterdayPredicted(rec, 'first-write'), 3.0, "'first-write' — the calibrator basis — is unchanged");
  resetForecastCachesForTesting();
  assert.equal(await yesterdayPredicted(rec, 'realized'), 6.0, "'realized' scores against the realized 600 W/m²");
});

test("computeForecastSkill — 'realized' falls back to the live cache (not the forecast) where no realized row exists", async () => {
  setSkillWeather(450);
  const rec = skillRecorder({ firstWrite: 300, realized: null });
  assert.equal(await yesterdayPredicted(rec, 'realized'), 4.5);
  resetForecastCachesForTesting();
  assert.equal(await yesterdayPredicted(rec, 'first-write'), 3.0, 'first-write keeps its old order: the recorder row beats the cache');
});

test('★★ the skill cache is keyed by basis — a realized report is never served to the calibrator (or vice versa)', async () => {
  // /api/confidence ('realized', 30 d) and the band calibrator ('first-write', 30 d) share a
  // window. A window-only key served whichever computed first to the other for the 1 h TTL.
  setSkillWeather(null);
  const rec = skillRecorder({ firstWrite: 300, realized: 600 });
  const realized = await yesterdayPredicted(rec, 'realized');
  const firstWrite = await yesterdayPredicted(rec, 'first-write'); // NO cache reset in between
  assert.deepEqual([realized, firstWrite], [6.0, 3.0]);
  const again = await computeForecastSkill(skillDevices, rec, skillForecast(solarModelAt(new Date(skillHourStart()).getHours(), 10)), 7);
  assert.equal(again.ghiBasis, 'first-write', 'the default reads the first-write slot');
  assert.equal(again.days[again.days.length - 1].predictedKwh, 3.0);
});

/* ── T4: the two report builders pass their basis explicitly ─────────── */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function builderSkillBasis(builder: string): string[] {
  const file = join(SRC, 'reports.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let prop: ts.PropertyAssignment | null = null;
  const findBuilders = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'BUILDERS'
      && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      for (const p of n.initializer.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === builder) prop = p;
      }
    } else ts.forEachChild(n, findBuilders);
  };
  findBuilders(sf);
  assert.ok(prop, `BUILDERS.${builder} must exist`);
  const bases: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'computeForecastSkill') {
      const a = n.arguments[4];
      bases.push(a && ts.isStringLiteral(a) ? a.text : `<${a ? a.getText(sf) : 'omitted'}>`);
    }
    ts.forEachChild(n, visit);
  };
  visit(prop!);
  return bases;
}

test("★★★ v1.173.1 — the band calibrator's skill is passed 'realized' EXPLICITLY (owner decision 2026-09-21)", () => {
  // It sets skillFrac, bandSigmaCal, bandRealizedCoveragePct (the night-charge basis gate)
  // and realizedDailyErrHalfFrac (the multi-day widening that sizes the buy). The owner chose
  // "the more accurate data"; a silent revert to first-write must fail here.
  assert.deepEqual(builderSkillBasis('probabilisticForecast'), ['realized']);
});

test("the display skill report (/api/forecast-skill, /api/confidence, the repair card) scores 'realized'", () => {
  assert.deepEqual(builderSkillBasis('forecastSkill'), ['realized']);
});

/* ── T6: soiling decomposition ────────────────────────────────────────── */

function soilDevice(sn: string): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: `DELTA-PRO-ULTRA-${sn}`, productName: 'Delta Pro Ultra',
      online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs: [] },
    } as unknown as DeviceSnapshot,
  };
}

/** 20 clear days, true coefficient 9 on EVERY day (no soiling). On three older days the
 *  first-write forecast was 0.6 × what the sun did, so pv/ghi_fw reads 15 there — a phantom
 *  clean baseline the p90 picks up. */
function soilRecorder(sn: string, withRealized: boolean): Recorder {
  const now = Date.now();
  const firstWrite: Row[] = [];
  const realized: Row[] = [];
  const pv: Row[] = [];
  const RAD = [820, 900, 810];
  for (let d = 20; d >= 1; d--) {
    const tooDark = d >= 13 && d <= 15;
    for (let k = 0; k < 3; k++) {
      const at = new Date(now - d * DAY); at.setHours(10 + k, 0, 0, 0);
      const ts = at.getTime();
      realized.push({ ts, value: RAD[k] });
      firstWrite.push({ ts, value: tooDark ? 0.6 * RAD[k] : RAD[k] });
      pv.push({ ts, value: 9 * RAD[k] });
    }
  }
  return makeRecorderStub({
    query: (qsn, metric) => {
      if (qsn === 'weather' && metric === 'ghi_wm2') return firstWrite;
      if (qsn === 'weather' && metric === 'ghi_wm2_realized') return withRealized ? realized : [];
      if (qsn === 'weather' && metric === 'cloud_pct') return firstWrite.map((g) => ({ ts: g.ts, value: 0 }));
      if (qsn === sn && metric === 'pv_total') return pv;
      return [];
    },
  });
}

test('★ soiling decomposition pairs PV with realized irradiance — a too-dark forecast day no longer fakes a clean baseline', async () => {
  setWeatherCacheForTesting(null);
  const sn = 'SN-SOIL-STAGE2';
  const control = await computeSoilingDecomposition(soilDevice(sn), soilRecorder(sn, false));
  assert.ok((control.perDevice[0]?.dropPct ?? 0) > 20,
    `positive control: on first-write GHI alone the fixture shows the phantom drop (got ${control.perDevice[0]?.dropPct}%)`);
  resetForecastCachesForTesting();
  const r = await computeSoilingDecomposition(soilDevice(sn), soilRecorder(sn, true));
  const dev = r.perDevice[0];
  assert.ok(dev && dev.dropPct != null, 'a per-device row is produced');
  assert.ok(Math.abs(dev.dropPct!) < 2, `realized basis: no soiling where none exists (got ${dev.dropPct}%)`);
  assert.equal(dev.baselineCoeff, 9);
});

/* ── T7: solar-model training (getDayForecast) ────────────────────────── */

test('★ solar-model training pairs PV with realized irradiance on days the live cache no longer holds', async () => {
  setWeatherCacheForTesting(null); // only the recorder feeds GHI
  const sn = 'DPU-TRAIN-STAGE2';
  const now = Date.now();
  const ghiFw: Row[] = [];
  const ghiR: Row[] = [];
  const pv: Row[] = [];
  for (let d = 8; d <= 20; d++) {
    const at = new Date(now - d * DAY); at.setHours(12, 0, 0, 0);
    ghiFw.push({ ts: at.getTime(), value: 300 });
    ghiR.push({ ts: at.getTime(), value: 600 });
    pv.push({ ts: at.getTime(), value: 6000 });
  }
  const rec = makeRecorderStub({
    query: (qsn, metric) => {
      if (qsn === 'weather' && metric === 'ghi_wm2') return ghiFw;
      if (qsn === 'weather' && metric === 'ghi_wm2_realized') return ghiR;
      if (qsn === sn && metric === 'pv_total') return pv;
      return [];
    },
    queryMulti: (qsn, metrics) =>
      new Map(metrics.map((m) => [m, qsn === sn && m === 'pv_total' ? pv : []])),
  });
  const devices: Record<string, DeviceSnapshot> = {
    [sn]: { sn, deviceName: 'Core 1', online: true, projection: { kind: 'dpu', soc: 80, packs: [] } } as unknown as DeviceSnapshot,
  };
  const fc = await getDayForecast(devices, rec, () => {});
  const noon = fc.solarModel.hourly[12];
  assert.equal(noon.samples, 13, 'every training day paired');
  assert.ok(noon.coeff != null && Math.abs(noon.coeff - 10) < 1e-9,
    `coeff = 6000 W / 600 W/m² realized = 10, not 6000 / 300 forecast = 20 (got ${noon.coeff})`);
});
