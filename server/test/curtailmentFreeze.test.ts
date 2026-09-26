import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCurtailment,
  resetForecastCachesForTesting,
  setBayesianModelForTesting,
  type BayesianSolarModel,
  type CurtailmentReport,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, type WeatherForecast, type WeatherHour } from '../src/weather.js';
import {
  CURTAIL_SETTLE_LAG_MS,
  curtailmentDaySettled,
  frozenCurtailmentDaysForTesting,
  resetCurtailmentFreezeForTesting,
} from '../src/curtailmentFreeze.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* v1.186.1 — "PV Curtailed 7d" re-estimated all 168 past hours on every refresh against the
 * CURRENT posterior and weather cache, so seven finished days moved within one day
 * (2026-09-25: 12.6 → 10.5 → 16.09 kWh). A finished day is now frozen once it SETTLES: the weather
 * in hand was fetched ≥ CURTAIL_SETTLE_LAG_MS after the day ended (no forecast values, the
 * provider's revisions done), every hour of it is covered, and a posterior exists.
 *
 * Fixture: January 2026 in local time (no DST transition in any common zone). On day-of-month n
 * the Cores curtail from 11:00 for k = 1 + (n mod 3) hours: SoC 99, PV 2000 W, load 1800 W. With
 * GHI 700 and μ = 10 the expected PV is 7000 W, a 5000 W surplus = 5 kWh per hour. Jan 13..19
 * have k = 2,3,1,2,3,1,2 = 14 hours = 70 kWh. μ = 12 makes it 6.4 kWh per hour. */

const HOUR = 3_600_000;
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 0, day, hour, minute, 0, 0).getTime();
const dayStart = (day: number) => startOfLocalDayMs(new Date(2026, 0, day, 12));
const curtailedHours = (day: number) => 1 + (day % 3);

/** A posterior with support in every hour of the day. */
function bayes(mu: number, hours = 24): BayesianSolarModel {
  return {
    generatedAt: Date.now(),
    hourly: Array.from({ length: hours }, (_, hour) => ({
      hour, posteriorMean: mu, posteriorStdev: 0.5, ci95Low: mu - 1, ci95High: mu + 1, samples: 10,
    })),
    totalSamples: 10 * hours,
    medianStdev: 0.5,
    agreementWithOls: 1,
  };
}

/** Hourly weather from Jan 11 to Jan 23 local: `ghi` from 08:00 to 16:59, 0 otherwise. */
function weather(fetchedAt: number, opts: { ghi?: number; firstMs?: number; missingAt?: number } = {}): WeatherForecast {
  const hours: WeatherHour[] = [];
  const first = opts.firstMs ?? dayStart(11);
  for (let ts = first; ts < dayStart(24); ts += HOUR) {
    const h = new Date(ts).getHours();
    const missing = opts.missingAt != null && Math.floor(ts / HOUR) === Math.floor(opts.missingAt / HOUR);
    hours.push({
      ts,
      cloudCoverPct: 0,
      radiationWm2: missing ? 0 : (h >= 8 && h <= 16 ? (opts.ghi ?? 700) : 0),
      ...(missing ? { radiationMissing: true } : {}),
      tempC: 20,
      ensembleSources: 1,
    });
  }
  return { fetchedAt, lat: 33.45, lon: -112.07, hours };
}

const isCurtailing = (hourStartMs: number) => {
  const d = new Date(hourStartMs);
  const h = d.getHours();
  return h >= 11 && h < 11 + curtailedHours(d.getDate());
};

const recorder: Recorder = makeRecorderStub({
  queryMulti: (_sn, metrics, since) => new Map(metrics.map((m) => {
    if (!isCurtailing(since)) return [m, []];
    const v = m === 'soc' ? 99 : m === 'chg_max_soc' ? 100 : m === 'pv_total' ? 2000 : 0;
    return [m, [{ ts: since, value: v }]];
  })),
  query: (_sn, metric, since) => (metric === 'panel_load' && isCurtailing(since) ? [{ ts: since, value: 1800 }] : []),
});

function devices(): Record<string, DeviceSnapshot> {
  const dpuSn = 'DPU-HOME-1';
  const dpu = {
    sn: dpuSn, deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 99, pvTotalWatts: 2000, pvHighWatts: 2000, pvLowWatts: 0,
      pvHighVolts: 200, pvHighAmps: 10, pvLowVolts: 0, pvLowAmps: 0,
      acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0, batVol: 53, batAmp: 0,
      mpptHvTemp: 30, mpptLvTemp: 30, sysErrCode: 0, pvHighErrCode: 0, pvLowErrCode: 0,
      emsParaVolMinMv: 47_500, emsParaVolMaxMv: 56_000, chgMaxSoc: 100, dsgMinSoc: null, packs: [],
    },
  } as unknown as DeviceSnapshot;
  const shp2 = {
    sn: 'SHP2-1', deviceName: 'SHP2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', backupBatPercent: 99, backupFullCapWh: 21_500, backupRemainWh: 21_000,
      backupChargeTimeMin: null, backupDischargeTimeMin: null,
      circuits: [{ ch: 1, name: 'Test load', watts: 1800, breakerAmps: 20 }], pairedCircuits: [],
      sources: [{ slot: 1, sn: dpuSn, batteryPercentage: 99, emsBatTemp: 30, errorCodeNum: 0, isConnected: true }],
      sourceWatts: [],
    },
  } as unknown as DeviceSnapshot;
  return { [dpuSn]: dpu, [shp2.sn]: shp2 };
}

/** One refresh: cold report cache, the given posterior and weather, at `nowMs`. */
async function refresh(nowMs: number, mu: number, w: WeatherForecast | null = weather(nowMs)): Promise<CurtailmentReport> {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(w);
  setBayesianModelForTesting(mu > 0 ? bayes(mu) : { generatedAt: Date.now(), hourly: [], totalSamples: 0, medianStdev: 0, agreementWithOls: 0 });
  return computeCurtailment(devices(), recorder, () => {}, nowMs);
}

/** A fresh process: memory forgotten, persistence at `path` (or disabled when omitted). */
function restart(path?: string): void {
  if (path) process.env.CURTAILMENT_DAYS_PATH = path;
  else delete process.env.CURTAILMENT_DAYS_PATH;
  delete process.env.SUPERVISOR_TOKEN; // outside the add-on: memory only unless a path is given
  resetCurtailmentFreezeForTesting();
}

const frozenKeys = () => frozenCurtailmentDaysForTesting().map((d) => d.dayStartMs);
const tmpStore = () => join(mkdtempSync(join(tmpdir(), 'ef-curtail-')), 'curtailment-days.json');

test('fixture — seven settled days at μ=10 are 70 kWh over 14 hours, and today is walked too', async () => {
  restart();
  const r = await refresh(at(20, 12), 10);
  assert.equal(r.basisComplete, true);
  assert.equal(r.recent7dKwh, 70);
  assert.equal(r.recent7dHoursCount, 14);
  assert.equal(r.recent7dSettledDays, 0, 'the first refresh walks every day live, then freezes them');
  assert.equal(r.todayKwh, 5, 'today: hour 11 is over at 12:00');
  assert.deepEqual(frozenKeys(), [13, 14, 15, 16, 17, 18, 19].map(dayStart));
});

test('★★★ (a) the 7-day total does not move when the posterior and weather change for settled days', async () => {
  restart();
  const first = await refresh(at(20, 12), 10);
  // The posterior re-learns and a new weather fetch revises the irradiance — both are what moved
  // the live figure 12.6 → 10.5 → 16.09 kWh on 2026-09-25.
  const later = await refresh(at(20, 12), 12, weather(at(20, 12), { ghi: 900 }));
  assert.equal(later.recent7dKwh, 70, 'finished, settled days are frozen');
  assert.equal(later.recent7dHoursCount, 14);
  assert.equal(later.recent7dSettledDays, 7);
  for (const hour of [12, 13]) {
    assert.deepEqual(later.hourlyHistogram[hour], first.hourlyHistogram[hour], `histogram hour ${hour} reads the frozen hours`);
  }
  // Today stays live: hour 11 re-estimated at μ=12 × GHI 900 = 10800 W → 8.8 kWh.
  assert.equal(later.todayKwh, 8.8, "today's figure is still live");
  // A third input change, still inside the same day: nothing moves.
  const again = await refresh(at(20, 16), 8, weather(at(20, 16), { ghi: 500 }));
  assert.equal(again.recent7dKwh, 70);
});

test('★★★ (b) a day not yet settled is still re-estimated; it freezes once the lag has passed', async () => {
  restart();
  // 06:00: yesterday ended 6 h ago — inside the settle lag, its irradiance may still be revised.
  assert.ok(6 * HOUR < CURTAIL_SETTLE_LAG_MS && CURTAIL_SETTLE_LAG_MS <= 12 * HOUR);
  const early = await refresh(at(20, 6), 10);
  assert.equal(early.recent7dKwh, 70);
  assert.equal(frozenKeys().includes(dayStart(19)), false, 'yesterday is not frozen inside the lag');
  const relearned = await refresh(at(20, 7), 12);
  // Jan 19 (2 hours) re-estimated at 6.4 kWh/h = 12.8; the other six stay frozen at 60.
  assert.equal(relearned.recent7dKwh, 72.8);
  assert.equal(relearned.recent7dSettledDays, 6);
  // Once the weather in hand was fetched ≥ the lag after midnight, yesterday settles and freezes
  // at the value that walk produced.
  const settled = await refresh(at(20, 12), 12);
  assert.equal(settled.recent7dKwh, 72.8);
  assert.equal(frozenKeys().includes(dayStart(19)), true);
  const after = await refresh(at(20, 13), 10);
  assert.equal(after.recent7dKwh, 72.8, 'and from then on it no longer moves');
  assert.equal(after.recent7dSettledDays, 7);
});

test('★★★ (b) a stale weather cache is not settled: its hours of the finished day were FORECASTS', async () => {
  restart();
  // 18:00, but every fetch since yesterday 20:00 failed and getWeather() serves that stale cache:
  // at fetch time yesterday's evening was still in the future. The wall clock is well past the lag.
  const stale = weather(at(19, 20));
  await refresh(at(20, 18), 10, stale);
  assert.equal(frozenKeys().includes(dayStart(19)), false, 'a day whose weather was a forecast at fetch time never freezes');
  assert.equal(frozenKeys().includes(dayStart(18)), true, 'the day before ended 20 h before that fetch — settled');
  const r = await refresh(at(20, 19), 12, stale);
  assert.equal(r.recent7dKwh, 72.8, 'Jan 19 still re-estimates');
});

test('(b) a day with an hour the provider did not send, or outside the cache, does not freeze', async () => {
  restart();
  // Jan 16 13:00 arrived as a stand-in 0 (radiationMissing); the cache starts at Jan 13 06:00, so
  // Jan 13's first six hours are outside it (the past_days edge counts UTC days).
  await refresh(at(20, 12), 10, weather(at(20, 12), { missingAt: at(16, 13), firstMs: at(13, 6) }));
  assert.deepEqual(frozenKeys(), [14, 15, 17, 18, 19].map(dayStart));
  assert.equal(curtailmentDaySettled(weather(at(20, 12)), true, dayStart(16)), true, '(the same day settles with the hour present)');
});

test('(b) without a posterior nothing freezes — a model-less walk is all nulls, not a week of zeros', async () => {
  restart();
  const cold = await refresh(at(20, 12), 0);
  assert.equal(cold.basisComplete, false);
  assert.equal(cold.recent7dKwh, 0);
  assert.deepEqual(frozenKeys(), []);
  const warm = await refresh(at(20, 13), 10);
  assert.equal(warm.recent7dKwh, 70, 'the days are estimated (and frozen) once a posterior exists');
  assert.equal(curtailmentDaySettled(null, true, dayStart(19)), false, 'no weather: not settled');
});

test('★★★ (c) the frozen days survive a restart (JSON sidecar, atomic, next to the store path)', async () => {
  const path = tmpStore();
  restart(path);
  await refresh(at(20, 12), 10);
  assert.equal(existsSync(path), true);
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { v: number; days: Array<{ dayStartMs: number; kwh: number; hours: unknown[] }> };
  assert.equal(onDisk.v, 1);
  assert.deepEqual(onDisk.days.map((d) => d.dayStartMs), [13, 14, 15, 16, 17, 18, 19].map(dayStart));
  assert.deepEqual(onDisk.days.map((d) => d.kwh), [10, 15, 5, 10, 15, 5, 10]);
  assert.deepEqual(onDisk.days.map((d) => d.hours.length), [2, 3, 1, 2, 3, 1, 2]);

  restart(path); // the worker restarts: memory gone, the posterior has re-learned
  const r = await refresh(at(20, 13), 12);
  assert.equal(r.recent7dKwh, 70, 'reloaded from disk, not re-estimated at μ=12 (which reads 89.6)');
  assert.equal(r.recent7dSettledDays, 7);
  assert.equal(r.recent7dHoursCount, 14);
});

test('(c) a corrupt sidecar starts cold and is rewritten; without a configured path nothing persists', async () => {
  const path = tmpStore();
  writeFileSync(path, '{ not json');
  restart(path);
  const r = await refresh(at(20, 12), 10);
  assert.equal(r.recent7dKwh, 70);
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { days: unknown[] }).days.length, 7);

  restart(); // no CURTAILMENT_DAYS_PATH and no SUPERVISOR_TOKEN: memory only
  await refresh(at(20, 12), 10);
  restart();
  const again = await refresh(at(20, 13), 12);
  assert.equal(again.recent7dKwh, 89.6, 'memory-only: a restart re-estimates');
});

test('★★★ (d) the window slides at local midnight: the oldest day drops, the new yesterday is live until settled', async () => {
  const path = tmpStore();
  restart(path);
  const noon = await refresh(at(20, 12), 10);
  assert.equal(noon.recent7dKwh, 70);
  const lateEvening = await refresh(at(20, 23, 59), 11);
  assert.equal(lateEvening.recent7dKwh, 70, 'no change between midnights');

  // 00:01 Jan 21: Jan 13 (10 kWh) leaves the window; Jan 20 (3 hours) joins it, unsettled → live.
  const midnight = await refresh(at(21, 0, 1), 10);
  assert.equal(midnight.recent7dKwh, 75, '70 − 10 (Jan 13) + 15 (Jan 20)');
  assert.equal(midnight.recent7dSettledDays, 6);
  const persisted = (JSON.parse(readFileSync(path, 'utf8')) as { days: Array<{ dayStartMs: number }> }).days.map((d) => d.dayStartMs);
  assert.equal(persisted.includes(dayStart(13)), false, 'the day that left the window is pruned from the sidecar');
  assert.equal(persisted.includes(dayStart(20)), false, 'the new yesterday is not frozen yet');

  const relearn = await refresh(at(21, 0, 30), 12);
  assert.equal(relearn.recent7dKwh, 79.2, 'only the unsettled day moves: 60 frozen + 3 × 6.4');

  const settled = await refresh(at(21, 12), 12);
  assert.equal(settled.recent7dKwh, 79.2);
  assert.deepEqual(frozenKeys(), [14, 15, 16, 17, 18, 19, 20].map(dayStart));
});

test('cleanup — clear test seams', () => {
  restart();
  clearWeatherTestOverride();
  setBayesianModelForTesting(null);
  resetForecastCachesForTesting();
});
