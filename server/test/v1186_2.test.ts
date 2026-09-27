/**
 * v1.186.2 — four fixes.
 *
 * 1. Battery net at a handover to the grid: the cloud REST poll (every 60 s) replays each pack's
 *    last NON-ZERO in/out, the MQTT stream carries the zeros, so the published figure alternated
 *    2671 → 21 → 1436 → 11 W while the grid carried the house. Display prefers the stream's value
 *    within STREAM_FLOW_WINDOW_MS; the alarm path's raw sum is unchanged.
 * 2. Curtailment pairs the hour [H, H+1) with the radiation value labelled H+1 (Open-Meteo's
 *    shortwave_radiation is the average of the PRECEDING hour); the solar fit pairs the same way.
 * 3. A measured GHI below the daylight floor is a dark/cloudy hour, not curtailment; μ × 900 is
 *    only for an hour with no weather at all.
 * 4. A day freezes only when the membership the walk used is sound; old-schema frozen days are
 *    dropped once so fixes 2 and 3 reach them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore, STREAM_FLOW_WINDOW_MS } from '../src/snapshot.js';
import { aggregateFleetFlow } from '../src/shp2Membership.js';
import {
  computeCurtailment, resetForecastCachesForTesting, setBayesianModelForTesting,
  type BayesianSolarModel, type CurtailmentReport,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, coveringRadiationEpoch, type WeatherForecast, type WeatherHour } from '../src/weather.js';
import {
  curtailmentDaySettled, curtailmentMembershipSound, frozenCurtailmentDaysForTesting,
  resetCurtailmentFreezeForTesting, setCurtailmentMembershipHistoryForTesting, CURTAIL_FREEZE_SCHEMA,
} from '../src/curtailmentFreeze.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const HOUR = 3_600_000;
const CORE = 'COREXXX00XXX0001';
const CORE2 = 'COREXXX00XXX0002';
const PANEL = 'PANELXXX00XXX01';
const P1 = 'hs_yj751_bms_slave_addr.1.';

/* ── 1. battery net at the handover ─────────────────────────────────────────────────── */

function coreStore() {
  const s = new SnapshotStore();
  let t = 1_000_000;
  s.setClock(() => t);
  s.setDeviceList([{ sn: CORE, deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: 1 } as never]);
  const rest = (outW: number) => s.setDeviceQuota(CORE, { [`${P1}soc`]: 16, [`${P1}outputWatts`]: outW, [`${P1}inputWatts`]: 0 });
  const mqtt = (outW: number) => s.mergeDeviceQuota(CORE, { [`${P1}outputWatts`]: outW, [`${P1}inputWatts`]: 0 }, 'mqtt');
  const flow = () => aggregateFleetFlow(s.get().devices);
  return { s, rest, mqtt, flow, advance: (ms: number) => { t += ms; } };
}

test('★★★ (1) a REST replay of the pre-handover discharge does not reach the displayed battery net', () => {
  const c = coreStore();
  c.rest(350);
  assert.equal(c.flow().fleetBatteryNetDisplay, 350, 'no stream yet: the polled value shows, as before');
  c.advance(20_000);
  c.mqtt(0); // the stream: the packs went idle at the handover
  assert.equal(c.flow().fleetBatteryNetDisplay, 0);
  c.advance(40_000);
  c.rest(350); // the :22 poll replays the last non-zero value
  assert.equal(c.flow().fleetBatteryNetDisplay, 0, 'the display keeps the stream value');
  assert.equal(c.flow().fleetBatteryNet, 350, 'the RAW sum (alarm evidence) still carries the polled value');
});

test('★★★ (1) a real discharge from the stream shows at once; a silent stream hands back to the poll', () => {
  const c = coreStore();
  c.rest(350);
  c.advance(10_000);
  c.mqtt(0);
  c.advance(10_000);
  c.mqtt(900); // a real discharge
  assert.equal(c.flow().fleetBatteryNetDisplay, 900, 'shown on the delta that carried it');
  c.advance(STREAM_FLOW_WINDOW_MS - 10_000);
  c.rest(350);
  assert.equal(c.flow().fleetBatteryNetDisplay, 900, 'inside the window the stream still outranks the poll');
  c.advance(20_000);
  c.rest(420);
  assert.equal(c.flow().fleetBatteryNetDisplay, 420, 'stream silent past the window: the poll shows again');
});

test('★★★ (1) the at-floor discharge guard keeps reading the RAW sum; the sensor and card read the display sum', () => {
  assert.match(src('gridState.ts'), /const poolDischargingObserved = aggregateFleetFlow\(input\.devices\)\.fleetBatteryNet > POOL_DISCHARGE_WATTS;/);
  assert.match(src('index.ts'), /fleetBatteryNetDisplay: fleetBatteryNet, panelLoad \} = aggregateFleetFlow\(snap\.devices\)/);
  assert.match(src('mqttDiscovery.ts'), /fleetBatteryNetDisplay: fleetBatteryNet, panelLoad \} = aggregateFleetFlow\(snap\.devices\)/);
  const web = readFileSync(new URL('../../web/src/cards/energyFlowModel.ts', import.meta.url), 'utf8');
  assert.match(web, /const f = pk\.liveFlow \?\? pk;/);
});

/* ── 2–4. curtailment fixture (January 2026, local time) ───────────────────────────── */

const at = (day: number, hour = 0) => new Date(2026, 0, day, hour, 0, 0, 0).getTime();
const dayStart = (day: number) => startOfLocalDayMs(new Date(2026, 0, day, 12));

function bayes(mu: number): BayesianSolarModel {
  return {
    generatedAt: Date.now(),
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour, posteriorMean: mu, posteriorStdev: 0.5, ci95Low: mu - 1, ci95High: mu + 1, samples: 10,
    })),
    totalSamples: 240, medianStdev: 0.5, agreementWithOls: 1,
  };
}

/** Labels Jan 11 .. Jan 23; `ghi(labelMs)` = W/m², null = sent as missing, undefined = not sent. */
function weather(fetchedAt: number, ghi: (labelMs: number) => number | null | undefined): WeatherForecast {
  const hours: WeatherHour[] = [];
  for (let ts = dayStart(11); ts < dayStart(24); ts += HOUR) {
    const v = ghi(ts);
    if (v === undefined) continue;
    hours.push({ ts, cloudCoverPct: 0, radiationWm2: v ?? 0, ...(v === null ? { radiationMissing: true } : {}), tempC: 20, ensembleSources: 1 });
  }
  return { fetchedAt, lat: 33.45, lon: -112.07, hours };
}
const daylight = (labelMs: number) => { const h = new Date(labelMs).getHours(); return h >= 8 && h <= 16 ? 700 : 0; };

/** Every day the Core is full and throttled to the load in the hour 11:00–12:00 only. */
const isCurtailing = (since: number) => new Date(since).getHours() === 11;
const recorder: Recorder = makeRecorderStub({
  queryMulti: (_sn, metrics, since) => new Map(metrics.map((m) => {
    if (!isCurtailing(since)) return [m, []];
    const v = m === 'soc' ? 99 : m === 'chg_max_soc' ? 100 : m === 'pv_total' ? 2000 : 0;
    return [m, [{ ts: since, value: v }]];
  })),
  query: (_sn, metric, since) => (metric === 'panel_load' && isCurtailing(since) ? [{ ts: since, value: 1800 }] : []),
});

function devices(): Record<string, DeviceSnapshot> {
  const dpu = {
    sn: CORE, deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 99, pvTotalWatts: 2000, pvHighWatts: 2000, pvLowWatts: 0,
      pvHighVolts: 200, pvHighAmps: 10, pvLowVolts: 0, pvLowAmps: 0,
      acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0, batVol: 53, batAmp: 0,
      mpptHvTemp: 30, mpptLvTemp: 30, sysErrCode: 0, pvHighErrCode: 0, pvLowErrCode: 0,
      emsParaVolMinMv: 47_500, emsParaVolMaxMv: 56_000, chgMaxSoc: 100, dsgMinSoc: null, packs: [],
    },
  } as unknown as DeviceSnapshot;
  const shp2 = {
    sn: PANEL, deviceName: 'SHP2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', backupBatPercent: 99, backupFullCapWh: 21_500, backupRemainWh: 21_000,
      backupChargeTimeMin: null, backupDischargeTimeMin: null,
      circuits: [{ ch: 1, name: 'Load', watts: 1800, breakerAmps: 20 }], pairedCircuits: [],
      sources: [{ slot: 1, sn: CORE, batteryPercentage: 99, emsBatTemp: 30, errorCodeNum: 0, isConnected: true }],
      sourceWatts: [],
    },
  } as unknown as DeviceSnapshot;
  return { [CORE]: dpu, [PANEL]: shp2 };
}

function restart(path?: string, history: Array<{ fp: string; atMs: number }> = [{ fp: CORE, atMs: 0 }]) {
  if (path) process.env.CURTAILMENT_DAYS_PATH = path;
  else delete process.env.CURTAILMENT_DAYS_PATH;
  delete process.env.SUPERVISOR_TOKEN;
  resetCurtailmentFreezeForTesting();
  setCurtailmentMembershipHistoryForTesting({ entries: history });
}
async function refresh(nowMs: number, w: WeatherForecast): Promise<CurtailmentReport> {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting(w);
  setBayesianModelForTesting(bayes(10));
  return computeCurtailment(devices(), recorder, () => {}, nowMs);
}
const hour11 = (r: CurtailmentReport) => r.todayHours.find((x) => x.hour === 11);

test('★★★ (2) the hour 11:00–12:00 is paired with the value labelled 12:00, not the preceding hour\'s', async () => {
  restart();
  // Label 11:00 (sunlight of 10:00–11:00) dark, label 12:00 (11:00–12:00) clear, label 15:00 distinct.
  const w = weather(at(20, 14), (ts) => {
    const h = new Date(ts).getHours();
    return h === 11 ? 0 : h === 15 ? 650 : daylight(ts);
  });
  const r = await refresh(at(20, 14), w);
  const s = hour11(r);
  assert.ok(s, 'the hour is scored');
  assert.equal(s.weatherVerified, true);
  assert.equal(s.pvExpectedW, 7000, 'μ 10 × 700 W/m² — the covering value');
  assert.equal(r.current.ghiWm2, 650, 'the live hour 14:00–15:00 reads the value labelled 15:00');
  assert.equal(coveringRadiationEpoch(100), 101);
});

test('★★★ (2) the solar fit pairs PV hours with the covering radiation value too', () => {
  assert.match(src('analytics.ts'), /wxByHourEpoch\.set\(Math\.floor\(wh\.ts \/ 3_600_000\) - RADIATION_LABEL_LAG_HOURS, wh\);/);
});

test('(2) a day settles only when the labels 01:00 .. next midnight were sent', () => {
  const w = weather(at(22, 12), (ts) => (ts === dayStart(20) ? undefined : daylight(ts)));
  assert.equal(curtailmentDaySettled(w, true, dayStart(19)), false, 'label Jan 20 00:00 covers Jan 19 23:00–24:00');
  assert.equal(curtailmentDaySettled(w, true, dayStart(20)), true, 'label Jan 20 00:00 belongs to the day before');
});

test('★★★ (3) a measured cloudy hour is not curtailment; μ × 900 is only for an hour with no weather', async () => {
  restart();
  const cloudy = await refresh(at(20, 14), weather(at(20, 14), (ts) => (new Date(ts).getHours() === 12 ? 50 : daylight(ts))));
  assert.equal(hour11(cloudy), undefined, 'GHI 50 W/m² measured: a cloudy hour, nothing lost');
  const unsent = await refresh(at(20, 14), weather(at(20, 14), (ts) => (new Date(ts).getHours() === 12 ? undefined : daylight(ts))));
  assert.equal(hour11(unsent)?.weatherVerified, false, 'no weather for the hour: the heuristic still applies');
  assert.equal(hour11(unsent)?.pvExpectedW, 9000);
  const missing = await refresh(at(20, 14), weather(at(20, 14), (ts) => (new Date(ts).getHours() === 12 ? null : daylight(ts))));
  assert.equal(hour11(missing)?.pvExpectedW, 9000, 'a value the provider flagged missing is not a measurement');
  const clear = await refresh(at(20, 14), weather(at(20, 14), daylight));
  assert.equal(hour11(clear)?.curtailedKwh, 5, 'a genuine clear-sky curtailment is still detected');
});

test('★★★ (4) membership soundness: known roster, stable all day, equal to the roster, every Core reported', () => {
  const base = {
    rosterSns: new Set([CORE, CORE2]), walkedSns: [CORE, CORE2], contributedSns: new Set([CORE, CORE2]),
    history: { entries: [{ fp: `${CORE},${CORE2}`, atMs: 0 }] }, dayStartMs: dayStart(19),
  };
  assert.equal(curtailmentMembershipSound(base), true);
  assert.equal(curtailmentMembershipSound({ ...base, rosterSns: new Set() }), false, 'no roster: every DPU counted as home');
  assert.equal(curtailmentMembershipSound({ ...base, history: null }), false, 'no record');
  assert.equal(curtailmentMembershipSound({ ...base, rosterSns: new Set([CORE]), walkedSns: [CORE], contributedSns: new Set([CORE]) }), false,
    'a Core momentarily missing from the roster: the day was a two-Core day');
  assert.equal(curtailmentMembershipSound({ ...base, contributedSns: new Set([CORE]) }), false, 'a roster Core that reported nothing');
  assert.equal(curtailmentMembershipSound({ ...base, walkedSns: [CORE] }), false, 'a roster Core the walk did not include');
  assert.equal(curtailmentMembershipSound({ ...base, history: { entries: [
    { fp: `${CORE},${CORE2}`, atMs: 0 }, { fp: CORE, atMs: dayStart(19) + 5 * HOUR }, { fp: `${CORE},${CORE2}`, atMs: dayStart(19) + 6 * HOUR },
  ] } }), false, 'membership changed during the day');
  assert.equal(curtailmentMembershipSound({ ...base, history: { entries: [{ fp: `${CORE},${CORE2}`, atMs: dayStart(19) + HOUR }] } }), false,
    'the record starts after the day began: unknown');
});

test('★★★ (4) an unsound day is walked again instead of frozen', async () => {
  restart(undefined, [{ fp: CORE, atMs: 0 }, { fp: '', atMs: dayStart(18) + 3 * HOUR }, { fp: CORE, atMs: dayStart(18) + 4 * HOUR }]);
  const r = await refresh(at(22, 12), weather(at(22, 12), daylight));
  assert.equal(r.recent7dKwh, 35);
  assert.deepEqual(frozenCurtailmentDaysForTesting().map((d) => d.dayStartMs), [15, 16, 17, 19, 20, 21].map(dayStart));
  restart(undefined, [{ fp: 'COREXXX00XXX0009', atMs: 0 }]);
  await refresh(at(22, 12), weather(at(22, 12), daylight));
  assert.deepEqual(frozenCurtailmentDaysForTesting(), [], 'the record disagrees with the roster: nothing freezes');
});

test('★★★ (4) frozen days from the old schema are dropped once and re-estimated', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ef-v1186-2-')), 'curtailment-days.json');
  writeFileSync(path, JSON.stringify({ v: 1, days: [{ dayStartMs: dayStart(21), kwh: 999, hours: [], frozenAtMs: 1, weatherFetchedAtMs: 1 }] }));
  restart(path);
  const r = await refresh(at(22, 12), weather(at(22, 12), daylight));
  assert.equal(r.recent7dKwh, 35, 'the 999 kWh day was re-walked: 7 days × 5 kWh');
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { v: number; days: Array<{ kwh: number }> };
  assert.equal(onDisk.v, CURTAIL_FREEZE_SCHEMA);
  assert.equal(onDisk.days.some((d) => d.kwh === 999), false);
});

test('cleanup — clear test seams', () => {
  restart();
  resetCurtailmentFreezeForTesting();
  clearWeatherTestOverride();
  resetForecastCachesForTesting();
});
