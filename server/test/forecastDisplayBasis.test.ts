/**
 * v1.195.0 — the forecast card's RESTORED (display) basis while the home Cores are dark, and its
 * isolation from every alarm input.
 *
 * With every home Core offline in the EcoFlow cloud the alarm-facing forecast (hours[].forecastPvW,
 * built from the Cores reporting live) is 0 W in every hour and its SoC walk drains toward 0%. v0.78.0
 * restored only the SUMS (forecastPvWhNext24Display, typicalPvWhPerDayDisplay) for Home Assistant; the
 * per-hour restored PV was discarded and no restored SoC walk existed, so the dashboard's forecast card
 * printed 0 kWh of solar, a 0% projected low and "Tight". The build now keeps the restored series per
 * hour (hoursDisplay) with a SoC walk on it (minProjectedSocDisplay), and the card shows it, labelled,
 * with the alarm basis beside it (web/src/cards/cardText.ts forecastView).
 *
 * The alarm is untouched by construction, and pinned here by behaviour and by source: computeRunway,
 * the forecast alerts, the multi-day and probabilistic forecasts, the dispatch plan and the
 * night-charge planner never read the display fields. Home Assistant's projected-low sensors and the
 * calendar's dip event stay on the alarm basis.
 *
 * Fixture (the runwayPvBasisGuard shape): the panel lists Cores A, B and C; pool 72 / 120 kWh, 15%
 * reserve; each Core recorded 1,000 W of PV in every hour, the house 1,500 W; 50% cloud with no GHI
 * pairing, so every hour takes the fallback curve: 1,000 W × (1 − 0.75 × 0.5) = 625 W per Core. The
 * measured basis is fixed at ×1 with a 270 W overhead, so each hour drains
 * runwayDrainW(1,500, 270) = max(1,500 / 0.94, 270 + 1,500 / 0.94) = 1,865.7 W.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDayForecast, computeRunway, computeForecastAlerts, forecastDayAlerts, runwayDrainW,
  resetForecastCachesForTesting, resetRunwayCache, setPoolBasisOverrideForTesting,
  type DayForecast,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, type WeatherForecast } from '../src/weather.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import { forecastView, restoredSolarBadge, alarmBasisLine } from '../../web/src/cards/cardText.js';

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 9, 30, 2, 0); // a fixed instant: every computation below sees one clock

function dpu(sn: string): DeviceSnapshot {
  return {
    sn, deviceName: `Core ${sn}`, online: true, lastSeenMs: NOW,
    projection: {
      kind: 'dpu', soc: 80,
      pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
      acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0, batVol: 0, batAmp: 0, mpptHvTemp: 0, mpptLvTemp: 0,
      packs: [{ num: 1, soc: 80, temp: 25, inputWatts: 0, outputWatts: 0, maxCellTemp: 25, minCellTemp: 25, soh: 100, cycles: 50 }],
    } as any,
  } as unknown as DeviceSnapshot;
}
/** The panel: lists A, B and C as connected sources whether or not each is in the device map. */
function panel(): DeviceSnapshot {
  return {
    sn: 'SHP2-DISPLAY', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: NOW,
    projection: {
      kind: 'shp2', area: null, backupBatPercent: 60, backupFullCapWh: 120_000, backupRemainWh: 72_000,
      backupChargeTimeMin: null, backupDischargeTimeMin: null, backupReserveSoc: 15, chargeWattPower: null,
      circuits: [], pairedCircuits: [],
      sources: ['A', 'B', 'C'].map((sn, i) => ({ slot: i + 1, sn, isConnected: true })),
      sourceWatts: [], strategy: {} as any,
    } as any,
  } as unknown as DeviceSnapshot;
}
const ALL = (): Record<string, DeviceSnapshot> => ({ 'SHP2-DISPLAY': panel(), A: dpu('A'), B: dpu('B'), C: dpu('C') });
const DARK = (): Record<string, DeviceSnapshot> => ({ 'SHP2-DISPLAY': panel() });

/** Two days of hourly rows: pv_total per Core (`pvBySn`; absent ⇒ none), panel_load at `loadW`. */
function recorder(pvBySn: Record<string, number>, loadW: number): Recorder {
  const series = (v: number) => {
    const out: Array<{ ts: number; value: number }> = [];
    for (let t = NOW - 2 * 24 * HOUR_MS; t <= NOW; t += HOUR_MS) out.push({ ts: t, value: v });
    return out;
  };
  return makeRecorderStub({
    query: (sn, metric) => (metric === 'panel_load' ? series(loadW) : metric === 'pv_total' && sn in pvBySn ? series(pvBySn[sn]) : []),
    queryMulti: (sn, metrics) => new Map(metrics.map((k) => [k, k === 'pv_total' && sn in pvBySn ? series(pvBySn[sn]) : []])),
  });
}
function cloudy(): WeatherForecast {
  const start = Math.ceil(NOW / HOUR_MS) * HOUR_MS;
  return {
    fetchedAt: NOW, lat: 33.45, lon: -112.07,
    hours: Array.from({ length: 26 }, (_, h) => ({ ts: start + h * HOUR_MS, cloudCoverPct: 50, radiationWm2: 0, tempC: 25 })),
  };
}
const PV3 = { A: 1000, B: 1000, C: 1000 };

async function build(devices: Record<string, DeviceSnapshot>, rec: Recorder): Promise<DayForecast> {
  resetForecastCachesForTesting();
  return getDayForecast(devices, rec);
}

beforeEach(() => {
  mock.method(Date, 'now', () => NOW);
  setWeatherCacheForTesting(cloudy());
  setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 270 });
  resetForecastCachesForTesting();
  resetRunwayCache();
});
afterEach(() => {
  clearWeatherTestOverride();
  setPoolBasisOverrideForTesting(null);
  resetForecastCachesForTesting();
  resetRunwayCache();
  mock.restoreAll();
});

test('★★★ (a) every Core dark: the alarm basis is unchanged (0 W, low 22.7%); the restored series carries 45 kWh and a low of 60.0%', async () => {
  const fc = await build(DARK(), recorder(PV3, 1500));
  const drain = runwayDrainW(1500, 270);
  assert.ok(Math.abs(drain - 1865.7) < 0.1, `the hourly drain (${drain})`);
  // The alarm basis: no Core reporting → no PV; 72 kWh − 24 × 1,865.7 Wh = 27.22 kWh = 22.7%.
  assert.equal(fc.forecastPvWhNext24, 0);
  assert.ok(fc.hours.every((h) => h.forecastPvW === 0));
  assert.equal(fc.minProjectedSoc, 22.7);
  // The restored basis: 3 × 625 W in every hour = 45,000 Wh, per hour and in sum.
  assert.equal(fc.restoredCoreCount, 3);
  assert.equal(fc.hoursDisplay!.length, 24);
  assert.ok(fc.hoursDisplay!.every((h) => h.forecastPvW === 1875), JSON.stringify(fc.hoursDisplay!.slice(0, 2)));
  assert.equal(fc.hoursDisplay!.reduce((s, h) => s + h.forecastPvW, 0), 45_000);
  assert.equal(fc.forecastPvWhNext24Display, 45_000);
  // Its walk: + (1,875 − 1,865.7) = +9.3 Wh an hour from 72 kWh — the low is the first hour, 60.0%.
  assert.equal(fc.minProjectedSocDisplay, 60.0);
  assert.equal(fc.minProjectedSocTsDisplay, fc.hours[0].ts);
  assert.deepEqual(fc.hoursDisplay!.map((h) => h.ts), fc.hours.map((h) => h.ts), 'the same hours');
  assert.equal(fc.pvForecastUnavailable, false);
});

test('★★★ (b) every Core reporting: the display series IS the alarm series, hour by hour (the v0.78.0 equality, per hour)', async () => {
  const fc = await build(ALL(), recorder(PV3, 1500));
  assert.equal(fc.restoredCoreCount, 0);
  assert.deepEqual(fc.hoursDisplay, fc.hours.map((h) => ({ ts: h.ts, forecastPvW: h.forecastPvW, projectedSocPct: h.projectedSocPct, modelled: h.modelled })));
  assert.equal(fc.minProjectedSocDisplay, fc.minProjectedSoc);
  assert.equal(fc.minProjectedSocTsDisplay, fc.minProjectedSocTs);
  assert.equal(fc.forecastPvWhNext24Display, fc.forecastPvWhNext24);
  assert.equal(fc.minProjectedSoc, 60.0, 'the same 1,875 W an hour, now on the alarm basis');
  // One Core dark: its own recorded PV is restored on top of the two reporting.
  const one = await build({ 'SHP2-DISPLAY': panel(), A: dpu('A'), B: dpu('B') }, recorder(PV3, 1500));
  assert.equal(one.restoredCoreCount, 1);
  assert.ok(one.hours.every((h) => h.forecastPvW === 1250), 'the alarm series: the two reporting Cores');
  assert.ok(one.hoursDisplay!.every((h) => h.forecastPvW === 1875), 'the display series: all three');
  // Two Cores dark, only one of them with a recorded PV history: one Core is restored from records,
  // and that is the count — the other adds nothing and is not "restored from its records".
  const part = await build({ 'SHP2-DISPLAY': panel(), A: dpu('A') }, recorder({ A: 1000, B: 1000 }, 1500));
  assert.equal(part.restoredCoreCount, 1);
  assert.ok(part.hoursDisplay!.every((h) => h.forecastPvW === 1250), 'A reporting, B restored, C nothing');
});

test('★★★ (c) isolation: the runway and every forecast alert are identical whatever the display fields say', async () => {
  const rec = recorder(PV3, 3000);
  const fc = await build(DARK(), rec);
  const forged: DayForecast = {
    ...fc,
    hoursDisplay: fc.hours.map((h) => ({ ts: h.ts, forecastPvW: 1_000_000, projectedSocPct: 100, modelled: true })),
    minProjectedSocDisplay: 100,
    minProjectedSocTsDisplay: fc.hours[0].ts,
    restoredCoreCount: 99,
  };
  resetRunwayCache();
  const real = computeRunway(DARK(), rec, fc);
  resetRunwayCache();
  const withForged = computeRunway(DARK(), rec, forged);
  assert.ok(real.hoursToReserve != null && real.hoursToReserve > 15 && real.hoursToReserve < 16.5, `a crossing inside the horizon (${real.hoursToReserve})`);
  assert.deepEqual(withForged, real, 'computeRunway reads hours[].forecastPvW alone');
  assert.equal(real.forecastPvUsedKwh, 0, 'no PV on the alarm basis');
  assert.deepEqual(forecastDayAlerts(forged), forecastDayAlerts(fc));
  assert.ok(forecastDayAlerts(fc).some((a) => a.id.startsWith('forecast-soc-dip')), 'the dip alert stands on the alarm basis');
  resetRunwayCache();
  const alertsReal = computeForecastAlerts(DARK(), rec, fc);
  resetRunwayCache();
  assert.deepEqual(computeForecastAlerts(DARK(), rec, forged), alertsReal);
});

test('★★ (d) no PV history for any connected Core: the restored low is null (no forecast to walk on), and no Core counts as restored', async () => {
  const fc = await build(DARK(), recorder({}, 1500));
  assert.equal(fc.pvForecastUnavailable, true);
  assert.equal(fc.minProjectedSocDisplay, null);
  assert.equal(fc.minProjectedSocTsDisplay, null);
  assert.equal(fc.restoredCoreCount, 0, 'three Cores offline, none with records to restore from');
  assert.ok(fc.minProjectedSoc != null, 'the alarm walk still runs (0 PV is its conservative basis)');
});

test('★★★ (e) source pins: no alarm input reads the display fields', () => {
  const src = (p: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src', p), 'utf8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const DISPLAY = /\b(hoursDisplay|minProjectedSocDisplay|minProjectedSocTsDisplay|restoredCoreCount)\b/;
  const analytics = src('analytics.ts');
  /** An exported top-level function's text, from its declaration to the next top-level declaration. */
  const fnBody = (text: string, name: string): string => {
    const m = new RegExp(`\\n(export )?(async )?function ${name}\\(`).exec(text);
    assert.ok(m, `${name} not found`);
    const rest = text.slice(m!.index + 1);
    const end = rest.slice(1).search(/\n(export |async function |function |const |let |\/\*\*)/);
    const body = rest.slice(0, end < 0 ? undefined : end + 1);
    assert.ok(body.length > 500, `${name}: the slice is too short to be the function (${body.length} chars)`);
    return strip(body);
  };
  for (const name of ['computeRunway', 'computeForecastAlerts', 'forecastDayAlerts', 'computeMultiDayForecast', 'computeProbabilisticForecast', 'computeDispatchPlan']) {
    const body = fnBody(analytics, name);
    assert.ok(!DISPLAY.test(body), `${name} reads ${body.match(DISPLAY)?.[0]}`);
  }
  // The builder writes them; nothing else in analytics.ts reads them.
  const uses = strip(analytics).split('\n').filter((l) => DISPLAY.test(l));
  const builder = fnBody(analytics, 'computeDayForecastUncached');
  for (const l of uses) assert.ok(builder.includes(l.trim()) || /^\s*(hoursDisplay|minProjectedSocDisplay|minProjectedSocTsDisplay|restoredCoreCount)\?:/.test(l), `outside the builder: ${l.trim()}`);
  // The night-charge planner, the HA/MQTT publishers, the calendar and the alarms: never.
  for (const f of ['nightChargeAdvisor.ts', 'index.ts', 'mqttDiscovery.ts', 'calendar.ts', 'alerts.ts', 'runwayAlarm.ts', 'loadShedAdvisor.ts']) {
    const s = strip(src(f));
    assert.ok(!DISPLAY.test(s), `${f} reads ${s.match(DISPLAY)?.[0]}`);
  }
});

test('★★★ (f) the cards: the restored view while Cores are dark, the alarm basis beside it; an older payload is the alarm basis', async () => {
  const fc = await build(DARK(), recorder(PV3, 1500));
  const v = forecastView(fc);
  assert.equal(v.restored, true);
  assert.equal(v.restoredCores, 3);
  assert.equal(v.pending, false, 'every Core is absent from the map: offline, no first reading pending');
  assert.equal(v.pvWh, 45_000);
  assert.equal(v.typicalWh, fc.typicalPvWhPerDayDisplay);
  assert.ok(v.typicalWh! > fc.typicalPvWhPerDay, `the restored typical day (${v.typicalWh}), not the alarm's (${fc.typicalPvWhPerDay})`);
  assert.equal(v.minSoc, 60.0);
  assert.equal(v.minSocTs, fc.minProjectedSocTsDisplay);
  assert.deepEqual(v.alarm, { pvWh: 0, minSoc: 22.7, minSocTs: fc.minProjectedSocTs });
  assert.ok(v.hours.every((h) => h.forecastPvW === 1875 && h.alarmPvW === 0), 'the chart draws the restored solar');
  assert.deepEqual(v.hours.map((h) => h.alarmSocPct), fc.hours.map((h) => h.projectedSocPct), 'and the alarm SoC path beside it');
  assert.deepEqual(v.hours.map((h) => h.forecastLoadW), fc.hours.map((h) => h.forecastLoadW), 'load from the forecast');
  assert.equal(restoredSolarBadge(3, false), "Solar restored from 3 offline Cores' records");
  assert.equal(restoredSolarBadge(1, false), "Solar restored from 1 offline Core's records");
  assert.equal(alarmBasisLine(v.alarm), 'Runway alarm basis (reporting Cores only): 0.0 kWh solar, low 23%');

  // A payload from an older server (none of the v1.195.0 fields): exactly the alarm basis.
  const { hoursDisplay: _h, minProjectedSocDisplay: _m, minProjectedSocTsDisplay: _t, restoredCoreCount: _c, ...old } = fc;
  const o = forecastView(old);
  assert.equal(o.restored, false);
  assert.equal(o.pvWh, 0);
  assert.equal(o.minSoc, 22.7);
  assert.ok(o.hours.every((h) => h.alarmSocPct === null), 'no dashed line');
  assert.deepEqual(o.hours.map((h) => h.projectedSocPct), fc.hours.map((h) => h.projectedSocPct));

  // Every Core reporting: the restored view is not shown (the two bases are equal anyway).
  const all = forecastView(await build(ALL(), recorder(PV3, 1500)));
  assert.equal(all.restored, false);
  assert.equal(all.pvWh, 45_000);

  // No PV history: no solar figure — the server's 0 there is not a forecast — and nothing restored, so
  // no "restored from records" badge: the view is the alarm basis, the low its 0 W walk.
  const noneFc = await build(DARK(), recorder({}, 1500));
  const none = forecastView(noneFc);
  assert.equal(none.restored, false);
  assert.equal(none.pvWh, null);
  assert.equal(none.typicalWh, null);
  assert.equal(none.minSoc, noneFc.minProjectedSoc);
  assert.ok(none.hours.every((h) => h.alarmSocPct === null), 'no dashed line');
});

test('★★ (g) the hour rows\' source badge names the model that made the figure shown: the restored one, fitted on the dark Cores\' records', async () => {
  // Ten days of GHI (600 W/m² from 07:00 to 16:00 Phoenix) and of pv_total = 2 × GHI on each dark
  // Core, a clear sky ahead: the restored model is fitted (3 × 2 = 6 W per W/m²), while the alarm
  // model, fitted on no Core, reads the typical-day fallback in every hour.
  const ghi = (t: number) => { const h = new Date(t).getUTCHours(); return h >= 14 && h <= 23 ? 600 : 0; };
  const series = (v: (t: number) => number) => {
    const out: Array<{ ts: number; value: number }> = [];
    for (let t = NOW - 10 * 24 * HOUR_MS; t <= NOW; t += HOUR_MS) out.push({ ts: t, value: v(t) });
    return out;
  };
  const pv = (sn: string) => (['A', 'B', 'C'].includes(sn) ? series((t) => 2 * ghi(t)) : []);
  const rec = makeRecorderStub({
    query: (sn, metric) => (metric === 'panel_load' ? series(() => 1500) : metric === 'pv_total' ? pv(sn) : metric === 'ghi_wm2' ? series(ghi) : []),
    queryMulti: (sn, metrics) => new Map(metrics.map((k) => [k, k === 'pv_total' ? pv(sn) : []])),
  });
  const start = Math.ceil(NOW / HOUR_MS) * HOUR_MS;
  setWeatherCacheForTesting({
    fetchedAt: NOW, lat: 33.45, lon: -112.07,
    hours: Array.from({ length: 26 }, (_, h) => ({ ts: start + h * HOUR_MS, cloudCoverPct: 0, radiationWm2: ghi(start + h * HOUR_MS), tempC: 25 })),
  });
  const fc = await build(DARK(), rec);
  assert.equal(fc.restoredCoreCount, 3);
  assert.ok(fc.hours.every((h) => h.modelled === false), 'the alarm model has no Core to fit on');
  const fitted = fc.hoursDisplay!.filter((h) => h.modelled);
  assert.ok(fitted.length >= 8, `the restored model is fitted in the daylight hours (${fitted.length})`);
  assert.ok(fitted.every((h) => h.forecastPvW === 3600), JSON.stringify(fitted.slice(0, 2)));
  const v = forecastView(fc);
  assert.deepEqual(v.hours.map((h) => h.modelled), fc.hoursDisplay!.map((h) => h.modelled), 'v1.195.0 first cut: "typical" beside every 3,600 W row');
});

test('★★ (h) source pins (a last resort: no React render here): every figure on both cards comes through forecastView', () => {
  // SOURCE-SCANNING, labelled as such. forecastView itself is pinned by behaviour in (f) and (g); these
  // pin that the cards read it and nothing else — a tile, the chart or a hour row reading the alarm
  // basis directly brings back the 0 kWh / 0% card on a dark fleet with every test above still green.
  const web = (p: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src/cards', p), 'utf8');
  const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const DIRECT = /\bfc!?\.(forecastPvWhNext24|typicalPvWhPerDay|minProjectedSoc|minProjectedSocTs|hoursDisplay|restoredCoreCount)\w*/;
  const card = strip(web('ForecastCard.tsx'));
  const detail = strip(web('ForecastDetail.tsx'));
  for (const [name, src] of [['ForecastCard', card], ['ForecastDetail', detail]] as const) {
    assert.ok(!DIRECT.test(src), `${name} reads ${src.match(DIRECT)?.[0]} directly, not through forecastView`);
    assert.match(src, /restoredSolarBadge\(view!?\.restoredCores, view!?\.pending\)/, `${name}: the restored badge, worded for a first reading pending (j)`);
    assert.match(src, /alarmBasisLine\(view!?\.alarm\)/, `${name}: the alarm-basis line`);
  }
  // The card: its tiles and its chart.
  assert.match(card, /const view = fc \? forecastView\(fc\) : null;/);
  assert.match(card, /value=\{view!\.pvWh != null \?/, 'the solar tile');
  assert.match(card, /sub=\{view!\.typicalWh != null \?/, 'its typical-day line');
  assert.match(card, /value=\{view!\.minSoc != null \? fmtPct\(view!\.minSoc, 0\)/, 'the projected-low tile');
  assert.match(card, /<ComposedChart data=\{view!\.hours\}/, 'the chart draws the view\'s hours');
  assert.match(card, /\{view!\.restored && \(\s*<Line yAxisId="soc" type="monotone" dataKey="alarmSocPct"/, 'the dashed alarm-basis line, on the restored basis only');
  // The detail card: its tiles, the runtime note and the hour rows.
  assert.match(detail, /const view = forecastView\(fc\);/);
  assert.match(detail, /const pvText = view\.pvWh != null \?/, 'the solar tile');
  assert.match(detail, /value=\{view\.typicalWh != null \?/, 'the typical-day tile');
  assert.match(detail, /value=\{view\.minSoc != null \?/, 'the projected-low tile');
  assert.match(detail, /const runtimeNote =\s*view\.minSoc == null/, 'the runtime note');
  assert.match(detail, /\{view\.hours\.map\(\(h\) => \(\s*<HourRow key=\{h\.ts\} h=\{h\} zone=\{zone\} alarmSocPct=\{view\.restored \? h\.alarmSocPct : undefined\} \/>/, 'the hour rows');
});

test('★★★ (i) v1.195.0 — the restored walk stores a surplus through the charge leg (v1.194.0), as the alarm walk does', async () => {
  // Each Core recorded at 2,000 W: the fallback gives 2,000 × 0.625 = 1,250 W a Core, 3,750 W restored
  // in every hour against the 1,865.7 W drain — a surplus of 1,884.3 Wh an hour, stored at
  // RUNWAY_CHARGE_EFFICIENCY = √0.86 = 0.92736: +1,747.4 Wh an hour (+1,884.3 at unity, before the
  // charge leg reached this walk through the shared step, stepSocWh).
  //   first hour: 72,000 + 1,747.4 = 73,747.4 Wh = 61.46 % → 61.5 (unity 73,884.3 = 61.57 → 61.6)
  //   last hour:  72,000 + 24 × 1,747.39 = 113,937.4 Wh = 94.95 % → 94.9 (unity 117,222.1 = 97.69 → 97.7)
  const PV6 = { A: 2000, B: 2000, C: 2000 };
  const fc = await build(DARK(), recorder(PV6, 1500));
  assert.ok(fc.hoursDisplay!.every((h) => h.forecastPvW === 3750), JSON.stringify(fc.hoursDisplay!.slice(0, 2)));
  assert.equal(fc.hoursDisplay![0].projectedSocPct, 61.5);
  assert.equal(fc.hoursDisplay![23].projectedSocPct, 94.9);
  assert.equal(fc.minProjectedSocDisplay, 61.5);
  // The alarm basis on the same fleet: no Core reporting, every hour a deficit — the leg does not apply.
  assert.equal(fc.minProjectedSoc, 22.7);
  // Every Core reporting: the alarm walk now carries the same surplus, and the two walks are one.
  const all = await build(ALL(), recorder(PV6, 1500));
  assert.equal(all.hours[23].projectedSocPct, 94.9);
  assert.deepEqual(all.hoursDisplay!.map((h) => h.projectedSocPct), all.hours.map((h) => h.projectedSocPct));
});

test('★★ (j) v1.195.0 (review) — the boot race: home Cores listed ONLINE with no first reading are restored from their records, and the badge does not call them offline', async () => {
  // At a restart the panel lists A, B and C and the device list reports each one online, but no quota
  // of theirs has landed yet (homeBasisPending: at most HOME_BASIS_PENDING_MAX_MS after the analytics
  // module loads; that load is the real clock, after NOW, so the bound has not passed). The build
  // restores them from their records as it does a dark Core (restoredCoreCount counts every connected,
  // unprojected Core with a PV history), and the badge read "Solar restored from 3 offline Cores'
  // records" at every restart, while Home Assistant withheld the same figures as a boot artefact.
  const listedOnline = (sn: string) => ({ sn, deviceName: `Core ${sn}`, online: true, lastSeenMs: NOW, projection: null } as unknown as DeviceSnapshot);
  const fc = await build({ 'SHP2-DISPLAY': panel(), A: listedOnline('A'), B: listedOnline('B'), C: listedOnline('C') }, recorder(PV3, 1500));
  assert.equal(fc.homeBasisPending, true, 'the boot race (the module load must be within 10 minutes of NOW, or after it)');
  assert.equal(fc.restoredCoreCount, 3);
  const v = forecastView(fc);
  assert.equal(v.restored, true, 'the restored figures are still shown: the alarm basis reads 0 kWh and "Tight" here');
  assert.equal(v.pending, true);
  assert.equal(v.pvWh, 45_000);
  assert.equal(v.minSoc, 60.0);
  assert.equal(restoredSolarBadge(v.restoredCores, v.pending), "Solar from 3 Cores' records (first reading pending)");
  assert.equal(restoredSolarBadge(1, true), "Solar from 1 Core's records (first reading pending)");
  // One Core listed online beside two absent: a first reading is pending, so no Core is called offline.
  const mixed = forecastView(await build({ 'SHP2-DISPLAY': panel(), A: listedOnline('A') }, recorder(PV3, 1500)));
  assert.equal(mixed.restoredCores, 3);
  assert.equal(mixed.pending, true);
  // The cloud lists the Cores offline (a wedge, not the boot race): the offline wording.
  const listedOffline = (sn: string) => ({ ...listedOnline(sn), online: false } as unknown as DeviceSnapshot);
  const wedged = forecastView(await build({ 'SHP2-DISPLAY': panel(), A: listedOffline('A'), B: listedOffline('B'), C: listedOffline('C') }, recorder(PV3, 1500)));
  assert.equal(wedged.restored, true);
  assert.equal(wedged.pending, false);
  assert.equal(restoredSolarBadge(wedged.restoredCores, wedged.pending), "Solar restored from 3 offline Cores' records");
  // Nothing restored: no badge, so nothing pending to word, whatever the payload says.
  const all = await build(ALL(), recorder(PV3, 1500));
  assert.equal(forecastView({ ...all, homeBasisPending: true }).pending, false);
});
