import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOENIX_SITE, physicsPmax } from '../src/physics/clearSky.js';
import {
  pvSite, pvConfigured, isLegacyPvSite, physicsAmbientC, curtailGhiCapWm2, maxNoonClearSkyGhiWm2,
  LEGACY_CURTAIL_GHI_CAP_WM2, LEGACY_PHYSICS_AMBIENT_C, resetSiteForTesting,
} from '../src/site.js';
import { config, DEFAULT_SITE_LAT, DEFAULT_SITE_LON } from '../src/config.js';
import {
  computeCurtailment, resetForecastCachesForTesting, setBayesianModelForTesting, BAYES_OBS_SIGMA2,
  type BayesianSolarModel, type CurtailmentReport,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, type WeatherForecast, type WeatherHour } from '../src/weather.js';
import { resetCurtailmentFreezeForTesting, setCurtailmentMembershipHistoryForTesting } from '../src/curtailmentFreeze.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.191.0 (S7, lane C) — the PV array and the site physics (plan 3.6 P1–P3).
 *
 * With no PV_* option set the PV site is the legacy site itself (PHOENIX_SITE: the reference
 * home's 16.8 kWp array at the placeholder coordinates), so golden G5 — the hourly clear-sky Pmax,
 * the Bayesian observation noise, the curtailment cap — is unchanged on an install that sets none.
 * Once any PV_* option is set the array takes those values and the site moves onto
 * FORECAST_LAT / FORECAST_LON; a 5 kWp test array then sizes the noise, the physics maximum and
 * the curtailment cap from its own nameplate and its own clear-sky noon.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const G5 = JSON.parse(readFileSync(resolve(HERE, 'golden/G5.json'), 'utf8')) as { value: { site: unknown; BAYES_OBS_SIGMA2: number } };

const SITE_KEYS = ['PV_ARRAY_KWP', 'PV_TILT_DEG', 'PV_AZIMUTH_DEG', 'PV_STRINGS', 'SITE_LOCATION_FROM_HA', 'FORECAST_LAT', 'FORECAST_LON'];
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  // FORECAST_LAT / FORECAST_LON are config.ts module values (read once at import, as in production):
  // the test sets them on the config object, the way recorderEnergyBridge.test.ts does.
  const savedCfg = [config.forecastLat, config.forecastLon];
  if (vars.FORECAST_LAT !== undefined) config.forecastLat = Number(vars.FORECAST_LAT);
  if (vars.FORECAST_LON !== undefined) config.forecastLon = Number(vars.FORECAST_LON);
  const saved = Object.fromEntries(SITE_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SITE_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  resetSiteForTesting();
  try {
    return await fn();
  } finally {
    [config.forecastLat, config.forecastLon] = savedCfg;
    for (const k of SITE_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetSiteForTesting();
  }
}

const HOUR = 3_600_000;
const hours2026 = (): number[] => {
  const out: number[] = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += HOUR) out.push(t);
  return out;
};

/* ── G5: unset is today ─────────────────────────────────────────────────────────────── */

test('★★★ G5 — with no PV_* option the PV site IS the legacy site (the same object, golden values)', async () => {
  await withEnv({}, () => {
    assert.equal(pvConfigured(), false);
    assert.equal(pvSite(), PHOENIX_SITE, 'not a copy: the legacy object itself');
    assert.equal(isLegacyPvSite(pvSite()), true);
    assert.deepEqual(pvSite(), G5.value.site);
    assert.deepEqual({ lat: PHOENIX_SITE.lat, lon: PHOENIX_SITE.lon }, { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON });
  });
});

test('★★★ G5 — FORECAST_LAT/LON alone do not move the legacy site (only a PV_* option does)', async () => {
  await withEnv({ FORECAST_LAT: '52.52', FORECAST_LON: '13.405' }, () => {
    assert.equal(pvSite(), PHOENIX_SITE);
    assert.equal(curtailGhiCapWm2(), LEGACY_CURTAIL_GHI_CAP_WM2);
  });
});

test('★★★ G5 — the observation noise, the curtailment cap and the ambient are today\'s', async () => {
  assert.equal(BAYES_OBS_SIGMA2, G5.value.BAYES_OBS_SIGMA2);
  assert.equal(BAYES_OBS_SIGMA2, (0.10 * 16_800) ** 2);
  await withEnv({}, () => {
    assert.equal(curtailGhiCapWm2(), 900);
    assert.equal(physicsAmbientC(Date.UTC(2026, 6, 1, 19), pvSite(), weatherAt(Date.UTC(2026, 6, 1, 19), 41)), LEGACY_PHYSICS_AMBIENT_C,
      'the legacy site keeps 30 °C even with weather in hand');
  });
});

test('★★★ G5 — /api/physics/pv-pmax\'s inputs give the golden hourly Pmax for every hour of 2026', async () => {
  await withEnv({}, () => {
    const site = pvSite();
    for (const t of hours2026()) {
      const now = physicsPmax(t, physicsAmbientC(t, site, null), site);
      const was = physicsPmax(t, 30, PHOENIX_SITE);
      assert.deepEqual(now, was, `hour ${new Date(t).toISOString()}`);
    }
  });
});

/* ── a configured array ─────────────────────────────────────────────────────────────── */

test('★★★ a 5 kWp array: nameplate from PV_ARRAY_KWP, the site on FORECAST_LAT/LON', async () => {
  await withEnv({ PV_ARRAY_KWP: '5', FORECAST_LAT: '45.52', FORECAST_LON: '-122.68' }, () => {
    const s = pvSite();
    assert.equal(pvConfigured(), true);
    assert.equal(isLegacyPvSite(s), false);
    assert.equal(s.pNamplate, 5000);
    assert.equal(s.lat, 45.52);
    assert.equal(s.lon, -122.68);
    // the rest of the reference array's parameters are kept
    assert.equal(s.tilt, 25); assert.equal(s.azimuth, 180); assert.equal(s.noct, 45);
    assert.equal(s.tempCoeff, -0.0035); assert.equal(s.derate, 0.85);
    assert.notEqual(PHOENIX_SITE.pNamplate, 5000, 'the legacy object is never mutated');
  });
});

test('★★ each PV_* option alone makes the site configured (tilt, azimuth, strings)', async () => {
  for (const [k, v] of [['PV_TILT_DEG', '10'], ['PV_AZIMUTH_DEG', '135'], ['PV_STRINGS', 'hv=8x450']] as const) {
    await withEnv({ [k]: v, FORECAST_LAT: '40', FORECAST_LON: '-105' }, () => {
      const s = pvSite();
      assert.equal(isLegacyPvSite(s), false, k);
      assert.equal(s.lat, 40, `${k}: the site moves onto FORECAST_LAT`);
      assert.equal(s.lon, -105, `${k}: the site moves onto FORECAST_LON`);
      assert.equal(s.pNamplate, 16_800, `${k}: without PV_ARRAY_KWP the reference nameplate stays`);
      if (k === 'PV_TILT_DEG') assert.equal(s.tilt, 10);
      if (k === 'PV_AZIMUTH_DEG') assert.equal(s.azimuth, 135);
    });
  }
});

test('the PV_* values are clamped to the schema range; a blank or garbage value is unset', async () => {
  await withEnv({ PV_ARRAY_KWP: '9999', PV_TILT_DEG: '-5', PV_AZIMUTH_DEG: 'west' }, () => {
    const s = pvSite();
    assert.equal(s.pNamplate, 500_000);
    assert.equal(s.tilt, 0);
    assert.equal(s.azimuth, 180, 'an unreadable azimuth keeps the reference one');
  });
  await withEnv({ PV_ARRAY_KWP: '', PV_TILT_DEG: '   ' }, () => {
    assert.equal(pvConfigured(), false, 'blank values are unset');
    assert.equal(pvSite(), PHOENIX_SITE);
  });
});

test('an unusable configured coordinate falls back to the placeholder, not NaN', async () => {
  await withEnv({ PV_ARRAY_KWP: '5', FORECAST_LAT: 'north', FORECAST_LON: '500' }, () => {
    const s = pvSite();
    assert.equal(s.lat, DEFAULT_SITE_LAT);
    assert.equal(s.lon, DEFAULT_SITE_LON);
  });
});

test('★★★ a 5 kWp array: the observation noise is 10 % of its nameplate (the module constant, fresh process)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pvsite-sigma-'));
  try {
    const out = await new Promise<string>((res, rej) => {
      execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "const a = await import('./src/analytics.ts'); process.stdout.write(JSON.stringify(a.BAYES_OBS_SIGMA2)); process.exit(0);"], {
        cwd: SERVER,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '', DB_PATH: join(tmp, 'x.db'), DATA_DIR: tmp, PV_ARRAY_KWP: '5' },
        encoding: 'utf8',
      }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stderr}`)) : res(stdout)));
    });
    assert.equal(JSON.parse(out), (0.10 * 5000) ** 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('★★ a 5 kWp array: the physics maximum scales with the nameplate', async () => {
  const noon = Date.UTC(2026, 5, 21, 19, 30);
  await withEnv({ PV_ARRAY_KWP: '5' }, () => {
    const small = physicsPmax(noon, 30, pvSite());
    const ref = physicsPmax(noon, 30, PHOENIX_SITE);
    assert.ok(small.pMaxW > 0);
    assert.ok(Math.abs(small.pMaxW / ref.pMaxW - 5000 / 16_800) < 1e-9, 'same sun, same site: Pmax is proportional to the nameplate');
  });
});

/* ── ambient (P2) ───────────────────────────────────────────────────────────────────── */

function weatherAt(ts: number, tempC: number): WeatherForecast {
  const h = Math.floor(ts / HOUR) * HOUR;
  return { fetchedAt: ts, lat: 0, lon: 0, hours: [{ ts: h, cloudCoverPct: 0, radiationWm2: 800, tempC, ensembleSources: 1 }] };
}

test('★★★ a configured site takes the weather cache\'s temperature for the hour; none in hand is 30 °C', async () => {
  const ts = Date.UTC(2026, 6, 1, 19, 40);
  await withEnv({ PV_ARRAY_KWP: '5' }, () => {
    const site = pvSite();
    assert.equal(physicsAmbientC(ts, site, weatherAt(ts, 41.5)), 41.5);
    assert.equal(physicsAmbientC(ts, site, weatherAt(ts - 2 * HOUR, 12)), 30, 'another hour\'s temperature is not this one');
    assert.equal(physicsAmbientC(ts, site, null), 30);
    // the ambient reaches the cell temperature
    const hot = physicsPmax(ts, physicsAmbientC(ts, site, weatherAt(ts, 45)), site);
    const cool = physicsPmax(ts, physicsAmbientC(ts, site, weatherAt(ts, 5)), site);
    assert.ok(hot.pMaxW < cool.pMaxW);
  });
});

/* ── curtailment cap (the heuristic hour) ───────────────────────────────────────────── */

test('★★★ the curtailment cap is the configured site\'s clear-sky noon ceiling, never above 900', async () => {
  assert.ok(maxNoonClearSkyGhiWm2(DEFAULT_SITE_LAT) > 1000, 'at the reference latitude the clear-sky noon peak is ~1 020 W/m²');
  await withEnv({ PV_ARRAY_KWP: '5', FORECAST_LAT: '60', FORECAST_LON: '10.75' }, () => {
    const cap = curtailGhiCapWm2();
    assert.equal(cap, Math.round(maxNoonClearSkyGhiWm2(60)));
    assert.ok(cap > 800 && cap < 850, `60° N: ${cap}`);
  });
  await withEnv({ PV_ARRAY_KWP: '5', FORECAST_LAT: '-33.87', FORECAST_LON: '151.21' }, () => {
    assert.equal(curtailGhiCapWm2(), 900, 'a southern site at the same latitude band keeps 900');
  });
  await withEnv({ PV_ARRAY_KWP: '5' }, () => {
    assert.equal(curtailGhiCapWm2(), 900, 'a configured array at the placeholder latitude keeps 900');
  });
});

/* The curtailment estimator's no-weather hour: one Core at SoC 99 making 2000 W into a 1800 W load
 * with μ = 10 W per W/m². With the hour's radiation missing the estimate is μ × the cap. */
const at = (day: number, hour = 0) => new Date(2026, 0, day, hour, 0, 0, 0).getTime();
const curtailRecorder: Recorder = makeRecorderStub({
  queryMulti: (_sn, metrics, since) => new Map(metrics.map((m) => {
    const h = new Date(since).getHours();
    if (!(new Date(since).getDate() === 20 && h === 11)) return [m, []];
    const v = m === 'soc' ? 99 : m === 'chg_max_soc' ? 100 : m === 'pv_total' ? 2000 : 0;
    return [m, [{ ts: since, value: v }]];
  })),
  query: (_sn, metric, since) => (metric === 'panel_load' && new Date(since).getDate() === 20 && new Date(since).getHours() === 11 ? [{ ts: since, value: 1800 }] : []),
});
function curtailDevices(): Record<string, DeviceSnapshot> {
  const dpu = {
    sn: 'DPU-HOME-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: { kind: 'dpu', soc: 99, pvTotalWatts: 2000, pvHighWatts: 2000, pvLowWatts: 0, chgMaxSoc: 100, packs: [] },
  } as unknown as DeviceSnapshot;
  const shp2 = {
    sn: 'SHP2-1', deviceName: 'SHP2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', backupBatPercent: 99, backupFullCapWh: 21_500, backupRemainWh: 21_000,
      circuits: [{ ch: 1, name: 'Test load', watts: 1800, breakerAmps: 20 }], pairedCircuits: [],
      sources: [{ slot: 1, sn: 'DPU-HOME-1', batteryPercentage: 99, emsBatTemp: 30, errorCodeNum: 0, isConnected: true }],
      sourceWatts: [],
    },
  } as unknown as DeviceSnapshot;
  return { [dpu.sn]: dpu, [shp2.sn]: shp2 };
}
function bayes(mu: number): BayesianSolarModel {
  return {
    generatedAt: Date.now(),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, posteriorMean: mu, posteriorStdev: 0.5, ci95Low: mu - 1, ci95High: mu + 1, samples: 10 })),
    totalSamples: 240, medianStdev: 0.5, agreementWithOls: 1,
  };
}
/** Weather for Jan 11..23 with the radiation of 11:00 on the 20th missing (the heuristic hour). */
function weatherMissingAt11(fetchedAt: number): WeatherForecast {
  const hours: WeatherHour[] = [];
  for (let ts = startOfLocalDayMs(new Date(2026, 0, 11, 12)); ts < startOfLocalDayMs(new Date(2026, 0, 24, 12)); ts += HOUR) {
    const missing = Math.floor(ts / HOUR) === Math.floor(at(20, 12) / HOUR); // labelled H+1 covers [H, H+1)
    const h = new Date(ts).getHours();
    hours.push({ ts, cloudCoverPct: 0, radiationWm2: missing ? 0 : (h >= 8 && h <= 16 ? 700 : 0), ...(missing ? { radiationMissing: true } : {}), tempC: 20, ensembleSources: 1 });
  }
  return { fetchedAt, lat: 0, lon: 0, hours };
}
async function curtailToday(): Promise<CurtailmentReport> {
  resetCurtailmentFreezeForTesting();
  setCurtailmentMembershipHistoryForTesting({ entries: [{ fp: 'DPU-HOME-1', atMs: 0 }] });
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(weatherMissingAt11(at(20, 12)));
  setBayesianModelForTesting(bayes(10));
  try {
    return await computeCurtailment(curtailDevices(), curtailRecorder, () => {}, at(20, 12));
  } finally {
    clearWeatherTestOverride();
  }
}

test('★★★ the no-weather curtailment hour: μ × 900 on the legacy site, μ × the site\'s cap on a configured one', async () => {
  delete process.env.CURTAILMENT_DAYS_PATH;
  delete process.env.SUPERVISOR_TOKEN;
  const legacy = await withEnv({}, curtailToday);
  // expected 10 × 900 = 9000 W against 2000 W made: a 7000 W surplus for the hour
  assert.equal(legacy.todayKwh, 7);
  const north = await withEnv({ PV_ARRAY_KWP: '5', FORECAST_LAT: '60', FORECAST_LON: '10.75' }, curtailToday);
  const cap = Math.round(maxNoonClearSkyGhiWm2(60));
  assert.equal(north.todayKwh, Math.round(((10 * cap - 2000) / 1000) * 100) / 100);
  assert.ok(north.todayKwh < legacy.todayKwh);
});

test('★★★ the physics and the energy bridge name the placeholder without importing config.ts (it reads the environment on import)', () => {
  // Test helpers import energyBridge.ts (helpers/recorderStub.ts) and clearSky.ts statically, before
  // the DB_PATH their app imports read is set; a config.ts import there freezes the wrong database.
  for (const f of ['physics/clearSky.ts', 'energyBridge.ts', 'siteDefaults.ts']) {
    const text = readFileSync(resolve(SERVER, 'src', f), 'utf8');
    assert.ok(!/from '(\.\.?\/)+config\.js'/.test(text), `${f} imports config.ts`);
  }
  assert.ok(!/^import /m.test(readFileSync(resolve(SERVER, 'src/siteDefaults.ts'), 'utf8')), 'siteDefaults.ts is a leaf');
});
