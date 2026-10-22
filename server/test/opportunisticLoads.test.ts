import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOpportunisticLoads, formatOpportunisticLoads } from '../src/limits.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, type WeatherForecast } from '../src/weather.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import { withEnv } from './golden/support/env.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.191.0 (S9, Q1 with CA22) — OPPORTUNISTIC_LOADS: `id:watts:category[:label]`, comma-separated;
 * the category defaults to `other`, `none` lists nothing, and unset keeps the reference plant's
 * built-in list verbatim (its 7200 W EV entry and the Fahrenheit pre-cool label included — golden G8).
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const BUILT_IN_IDS = ['pool_pump_high', 'dehumidifier', 'ac_precool', 'water_heater', 'ev_charge_full'];

test('★ a full entry parses to its id, watts, category and label', () => {
  assert.deepEqual(parseOpportunisticLoads('pool_pump:1800:pool:Pool pump (max speed)'), [
    { id: 'pool_pump', name: 'Pool pump (max speed)', estimatedW: 1800, category: 'pool', description: '' },
  ]);
});

test('★ the category defaults to other when it is left out, blank or not one of the five', () => {
  const loads = parseOpportunisticLoads('kiln:3000, sauna:6000::Sauna, bitcoin:900:mining:Miner, ev:7400:EV');
  assert.deepEqual(loads?.map((l) => [l.id, l.category, l.name]), [
    ['kiln', 'other', 'kiln'], ['sauna', 'other', 'Sauna'], ['bitcoin', 'other', 'Miner'], ['ev', 'ev', 'ev'],
  ]);
  for (const c of ['pool', 'ev', 'water', 'hvac', 'other']) assert.equal(parseOpportunisticLoads(`x:1:${c}`)?.[0].category, c);
});

test('★ `none` is an empty list; unset, blank or nothing valid keeps the built-in list (null)', () => {
  assert.deepEqual(parseOpportunisticLoads('none'), []);
  assert.deepEqual(parseOpportunisticLoads('  NONE '), []);
  assert.equal(parseOpportunisticLoads(undefined), null);
  assert.equal(parseOpportunisticLoads(''), null);
  assert.equal(parseOpportunisticLoads('   '), null);
  assert.equal(parseOpportunisticLoads('garbage, :100:pool, x:0:pool, y:-5, z:abc, bad id:100'), null);
});

test('entries that do not parse are skipped; a repeated id keeps its first entry; a label may hold colons', () => {
  const loads = parseOpportunisticLoads('Heater:2000:water:Tank 1: upstairs, heater:9999:water, x:0, dryer:5600.5:other');
  assert.deepEqual(loads?.map((l) => [l.id, l.estimatedW, l.name]), [['heater', 2000, 'Tank 1: upstairs'], ['dryer', 5600.5, 'dryer']]);
});

test('★ round trip: a canonical list formats back to the same string', () => {
  for (const s of ['pool_pump:1800:pool:Pool pump,water_heater:4500:water', 'a:1:other', 'none', 'ev_full:7200:ev:EV charge (full rate)']) {
    const parsed = parseOpportunisticLoads(s);
    assert.ok(parsed, s);
    assert.equal(formatOpportunisticLoads(parsed), s);
    assert.deepEqual(parseOpportunisticLoads(formatOpportunisticLoads(parsed)), parsed);
  }
});

/* ── the curtailment report reads the option ───────────────────────────────────────────────── */

let seq = 0;
async function freshAnalytics(raw: string | undefined): Promise<typeof import('../src/analytics.js')> {
  seq += 1;
  return withEnv({ OPPORTUNISTIC_LOADS: raw }, async () => (await import(`${pathToFileURL(resolve(SRC, 'analytics.ts')).href}?loads=${seq}`)) as typeof import('../src/analytics.js'));
}
function weatherNow(radiationWm2: number): WeatherForecast {
  const now = Date.now();
  const hourEpoch = Math.floor(now / 3_600_000);
  return { fetchedAt: now, lat: 33.45, lon: -112.07, hours: [{ ts: (hourEpoch + 1) * 3_600_000, cloudCoverPct: 20, radiationWm2, tempC: 30, ensembleSources: 1 }] };
}
/** A saturated home Core with ~5 kW of curtailed surplus (curtailment.test.ts's fixture). */
function saturatedHome(): Record<string, DeviceSnapshot> {
  const dpu = {
    sn: 'DPU-HOME-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 99, pvTotalWatts: 2000, pvHighWatts: 2000, pvLowWatts: 0, pvHighVolts: 200, pvHighAmps: 10, pvLowVolts: 0, pvLowAmps: 0,
      acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0, batVol: 53, batAmp: 0, mpptHvTemp: 30, mpptLvTemp: 30,
      sysErrCode: 0, pvHighErrCode: 0, pvLowErrCode: 0, emsParaVolMinMv: 47_500, emsParaVolMaxMv: 56_000, chgMaxSoc: null, dsgMinSoc: null, packs: [],
    },
  };
  const shp2 = {
    sn: 'SHP2-1', deviceName: 'SHP2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', backupBatPercent: 99, backupFullCapWh: 21_500, backupRemainWh: 21_285, backupChargeTimeMin: null, backupDischargeTimeMin: null,
      circuits: [{ ch: 1, name: 'Test load', watts: 1800, breakerAmps: 20 }], pairedCircuits: [],
      sources: [{ slot: 1, sn: 'DPU-HOME-1', batteryPercentage: 99, emsBatTemp: 30, errorCodeNum: 0, isConnected: true }], sourceWatts: [],
    },
  };
  return { [dpu.sn]: dpu, [shp2.sn]: shp2 } as never;
}
function bayes(wattsPerGhi: number) {
  const hour = new Date().getHours();
  return { generatedAt: Date.now(), hourly: [{ hour, posteriorMean: wattsPerGhi, posteriorStdev: 0.5, ci95Low: wattsPerGhi - 1, ci95High: wattsPerGhi + 1, samples: 10 }], totalSamples: 10, medianStdev: 0.5, agreementWithOls: 1 };
}

test('★ unset: the report suggests the built-in list; set: the configured loads, sized against the surplus', async () => {
  const today = await freshAnalytics(undefined);
  assert.deepEqual((await today.computeCurtailment({}, makeRecorderStub())).opportunisticLoads.map((o) => o.id), BUILT_IN_IDS);

  const set = await freshAnalytics('kiln:3000:other:Kiln,ev2:9000:ev');
  const empty = await set.computeCurtailment({}, makeRecorderStub());
  assert.deepEqual(empty.opportunisticLoads.map((o) => [o.id, o.fitsInSurplus]), [['kiln', false], ['ev2', false]], 'the no-Core report lists them');

  clearWeatherTestOverride();
  setWeatherCacheForTesting(weatherNow(700));
  set.resetForecastCachesForTesting();
  set.setBayesianModelForTesting(bayes(10) as never);
  const live = await set.computeCurtailment(saturatedHome(), makeRecorderStub());
  assert.ok(live.currentSurplusW >= 3000 && live.currentSurplusW < 9000, `fixture surplus ${live.currentSurplusW}`);
  assert.deepEqual(live.opportunisticLoads.map((o) => [o.id, o.name, o.category, o.fitsInSurplus]),
    [['kiln', 'Kiln', 'other', true], ['ev2', 'ev2', 'ev', false]], 'the live report sizes the configured loads');
  clearWeatherTestOverride();

  const none = await freshAnalytics('none');
  assert.deepEqual((await none.computeCurtailment({}, makeRecorderStub())).opportunisticLoads, []);
});
