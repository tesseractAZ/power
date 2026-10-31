import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDayForecast,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeDispatchPlan,
  resetForecastCachesForTesting,
  resetRunwayCache,
  resetPoolEnergyBasisForTesting,
  setPoolBasisOverrideForTesting,
  runwayDrainW,
  RUNWAY_DISCHARGE_EFFICIENCY,
  RUNWAY_CHARGE_EFFICIENCY,
  DISPATCH_ROUND_TRIP_EFFICIENCY,
  type DayForecast,
  type ForecastHour,
  type ProbabilisticForecast,
  type MultiDayForecast,
} from '../src/analytics.js';
import {
  buildNightChargeInputs,
  computeNightChargePlan,
  resolveCheapWindow,
  DEFAULT_OUTAGE_CUSHION_HOURS,
  DEFAULT_ISLANDED_LOAD_SAFETY,
  DEFAULT_COST_MAX_SOC_PCT,
  type NightChargeInputDeps,
  type NightForecastHour,
  type NightDayRollup,
} from '../src/nightChargeAdvisor.js';
import { apsREvModelFromEnv, rateAt } from '../src/tariff.js';
import { setWeatherCacheForTesting, type WeatherForecast } from '../src/weather.js';
import { resetOwnerReserveFloorPct } from '../src/nightChargeActuator.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import { chargeLegStep } from '../src/physics/chargeLeg.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.19 — contracts around the measured runway basis.
 *
 * (1) SCOPE — the measured basis is scoped to the runway and its alarms: the night-charge
 *     planner, its cushion, the JIT force-charge and the MPC/dispatch recommendations are
 *     UNCHANGED. The day forecast,
 *     the probabilistic band and the multi-day forecast now carry a measured SoC trajectory;
 *     everything the planner and the MPC read from them must be byte-identical between the
 *     pre-v1.187.19 basis (the legacy override: nameplate kWh, load/η) and the measured one,
 *     and the planner run on each must produce the identical plan.
 * (2) The band's trajectory inversion, hour-0 seed and per-hour steps use the SAME drain as
 *     the forward integrator that built the trajectory (a reference band near the empty rail).
 *     v1.194.0 — and the same charge leg (chargeLegStep at RUNWAY_CHARGE_EFFICIENCY) on a surplus
 *     hour (a reference band across a sunny stretch to the full rail).
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3_600_000;
const CORES = ['CORE-A', 'CORE-B', 'CORE-C'];

function core(sn: string, ratio: number): DeviceSnapshot {
  return {
    sn, deviceName: sn, online: true, lastSeenMs: Date.now(),
    projection: {
      kind: 'dpu', soc: 70, packCount: 5,
      pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
      packs: [1, 2, 3, 4, 5].map((num) => ({ num, soc: 70, temp: 25, inputWatts: 0, outputWatts: 0, designCapMah: 60_000, fullCapMah: Math.round(ratio * 60_000) })),
    },
  } as unknown as DeviceSnapshot;
}
function fleet(): Record<string, DeviceSnapshot> {
  const panel = {
    sn: 'PANEL', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
    projection: {
      kind: 'shp2', area: null, backupBatPercent: 70, backupFullCapWh: 92_160, backupRemainWh: 0.7 * 92_160,
      backupChargeTimeMin: null, backupDischargeTimeMin: null, backupReserveSoc: 16, chargeWattPower: null,
      circuits: [], pairedCircuits: [], sourceWatts: [], strategy: {},
      sources: CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, hwConnect: true, fullCap: 30_720 })),
    },
  } as unknown as DeviceSnapshot;
  const out: Record<string, DeviceSnapshot> = { PANEL: panel };
  for (const sn of CORES) out[sn] = core(sn, 0.944);
  return out;
}
/** A diurnal history: PV by hour of day, a house load with an evening peak. */
function recorder() {
  const now = Date.now();
  const start = now - 6 * 24 * HOUR;
  const series = (f: (h: number) => number) => {
    const out: Array<{ ts: number; value: number }> = [];
    for (let t = start; t <= now; t += 15 * 60_000) out.push({ ts: t, value: f(new Date(t).getHours()) });
    return out;
  };
  const pv = (h: number) => (h >= 7 && h <= 17 ? 2_200 * Math.sin(((h - 6) / 12) * Math.PI) : 0);
  const load = (h: number) => (h >= 17 && h <= 22 ? 4_200 : h >= 23 || h <= 5 ? 1_900 : 2_600);
  return makeRecorderStub({
    query: (_sn, metric) => (metric === 'panel_load' ? series(load) : metric === 'pv_total' ? series(pv) : []),
    queryMulti: (_sn, metrics) => new Map(metrics.map((m) => [m, m === 'pv_total' ? series(pv) : []])),
  });
}
function weather(): WeatherForecast {
  const now = Date.now();
  const startHour = Math.ceil(now / HOUR) * HOUR;
  return {
    fetchedAt: now, lat: 33.45, lon: -112.07,
    hours: Array.from({ length: 4 * 24 + 2 }, (_, h) => {
      const hod = new Date(startHour + h * HOUR).getHours();
      return { ts: startHour + h * HOUR, cloudCoverPct: 20, radiationWm2: hod >= 7 && hod <= 17 ? 700 : 0, tempC: 28 };
    }),
  };
}

interface Reports { fc: DayForecast; prob: ProbabilisticForecast; multi: MultiDayForecast }
async function reports(basis: 'legacy' | 'measured'): Promise<Reports> {
  resetForecastCachesForTesting();
  resetRunwayCache();
  resetPoolEnergyBasisForTesting();
  if (basis === 'legacy') setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 0 });
  try {
    const devs = fleet();
    const rec = recorder();
    const fc = await getDayForecast(devs, rec);
    const prob = await computeProbabilisticForecast(fc, null);
    const multi = await computeMultiDayForecast(devs, rec, fc, 4);
    return { fc, prob, multi };
  } finally {
    setPoolBasisOverrideForTesting(null);
  }
}

/** Everything recomputeNightChargePlan (index.ts) and /api/dispatch/recommend read from the reports. */
function plannerView({ fc, prob, multi }: Reports) {
  return {
    dayAhead: {
      hasWeather: fc.hasWeather,
      forecastPvWhNext24: fc.forecastPvWhNext24,
      hours: fc.hours.map((h) => ({ ts: h.ts, forecastPvW: h.forecastPvW, forecastLoadW: h.forecastLoadW, predictedEvLoadW: h.predictedEvLoadW })),
    },
    prob: {
      hours: prob.hours.map((h) => ({ ts: h.ts, p10W: h.p10W, p50W: h.p50W, p90W: h.p90W })),
      realizedDailyErrHalfFrac: prob.realizedDailyErrHalfFrac, calScoredDays: prob.calScoredDays,
      bandRealizedCoveragePct: prob.bandRealizedCoveragePct, bandSigmaCal: prob.bandSigmaCal, solarModelSns: prob.solarModelSns,
    },
    multi: multi.days.map((d) => d.hours.map((h) => ({ ts: h.ts, pvW: h.pvW, loadW: h.loadW }))),
  };
}

/** The planner's input assembly, field for field as recomputeNightChargePlan builds it. */
function planFrom(r: Reports, nowMs: number) {
  const tariff = apsREvModelFromEnv();
  const periodIdAt = (ts: number) => rateAt(tariff, ts).periodId;
  const byEpoch = new Map<number, ForecastHour>(r.fc.hours.map((h) => [Math.floor(h.ts / HOUR), h]));
  const loadP90Factor = 1.15;
  const bandHours: NightForecastHour[] = [];
  for (const pb of r.prob.hours) {
    const fh = byEpoch.get(Math.floor(pb.ts / HOUR));
    if (!fh) continue;
    bandHours.push({ ts: pb.ts, pvP10W: pb.p10W, loadP90W: fh.forecastLoadW * loadP90Factor, embeddedEvW: (fh.predictedEvLoadW ?? 0) * loadP90Factor });
  }
  const dayRollups: NightDayRollup[] = r.multi.days.map((d, idx) => ({ daysAhead: idx, hours: d.hours.map((h) => ({ ts: h.ts, pvW: h.pvW, loadW: h.loadW })) }));
  const window = resolveCheapWindow(periodIdAt, nowMs, 'overnight', 30);
  const windowEndMs = window?.endMs ?? nowMs;
  const nextWindow = resolveCheapWindow(periodIdAt, windowEndMs + HOUR, 'overnight', 96);
  let morning = 0;
  let morningHas = false;
  for (const pb of r.prob.hours) {
    if (!window || pb.ts < windowEndMs || pb.ts >= windowEndMs + 14 * HOUR) continue;
    const fh = byEpoch.get(Math.floor(pb.ts / HOUR));
    if (!fh) continue;
    morningHas = true;
    morning += Math.max(0, pb.p90W - fh.forecastLoadW) / 1000;
  }
  const deps: NightChargeInputDeps = {
    nowMs, fullKwh: 92.16, socNowPct: 70, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.4, outageCushionHours: DEFAULT_OUTAGE_CUSHION_HOURS, islandedLoadSafety: DEFAULT_ISLANDED_LOAD_SAFETY,
    objectiveMode: 'resilience', costMaxSocPct: DEFAULT_COST_MAX_SOC_PCT,
    legEff: Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY), dischargeEff: RUNWAY_DISCHARGE_EFFICIENCY, chargeCapKw: 9, gridInputCapKw: 17,
    periodIdAt, cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours, dayRollups, realizedDailyErrHalfFrac: r.prob.realizedDailyErrHalfFrac ?? 0, nextRechargeMs: nextWindow?.startMs ?? null,
    ev: null, evMaxLoadW: 11_520,
    confidenceTier: 'forecast', forecastPresent: bandHours.length > 0, calScoredDays: r.prob.calScoredDays ?? 0, minCalScoredDays: 14,
    bandCoverageFrac: (r.prob.bandRealizedCoveragePct ?? 0) / 100,
    morningPvSurplusP90Kwh: morningHas ? Math.round(morning * 100) / 100 : null, minBuyKwh: 1,
  };
  return computeNightChargePlan(buildNightChargeInputs(deps));
}

beforeEach(() => { resetOwnerReserveFloorPct(); setWeatherCacheForTesting(weather()); });
afterEach(() => { setWeatherCacheForTesting(null); setPoolBasisOverrideForTesting(null); resetPoolEnergyBasisForTesting(); resetForecastCachesForTesting(); });

test('★★★ SCOPE — the planner and MPC inputs are byte-identical on the legacy and the measured basis; the planner\'s plan is identical', async () => {
  let legacy = await reports('legacy');
  let measured = await reports('measured');
  if (legacy.fc.hours[0].ts !== measured.fc.hours[0].ts) { // an hour boundary between the two builds
    legacy = await reports('legacy');
    measured = await reports('measured');
  }
  // The change is real: the trajectory, the band's SoC and the multi-day SoC moved.
  assert.equal(legacy.fc.poolFullWh, 92_160);
  assert.ok(Math.abs(measured.fc.poolFullWh! - 92_160 * 0.944) < 1e-6, `${measured.fc.poolFullWh}`);
  assert.equal(measured.fc.poolCapacityBasis, 'measured');
  assert.equal(measured.fc.poolOverheadW, 270);
  assert.ok(measured.fc.minProjectedSoc! < legacy.fc.minProjectedSoc!, `${measured.fc.minProjectedSoc} vs ${legacy.fc.minProjectedSoc}`);
  assert.notDeepEqual(measured.prob.hours.map((h) => h.p10SocPct), legacy.prob.hours.map((h) => h.p10SocPct));
  assert.notDeepEqual(measured.multi.days.map((d) => d.minProjectedSoc), legacy.multi.days.map((d) => d.minProjectedSoc));
  // …and nothing the planner or the MPC reads did.
  assert.deepEqual(plannerView(measured), plannerView(legacy));
  assert.ok(measured.prob.hours.length > 0 && measured.multi.days.length > 0, 'the fixture exercises every report');
  const nowMs = Date.now();
  const planL = planFrom(legacy, nowMs);
  const planM = planFrom(measured, nowMs);
  assert.deepEqual(planM, planL);
  // The recommend-only dispatch plan reads the panel's own figures and the PV/load series.
  resetForecastCachesForTesting();
  const dL = computeDispatchPlan(fleet(), legacy.fc);
  resetForecastCachesForTesting();
  const dM = computeDispatchPlan(fleet(), measured.fc);
  assert.deepEqual({ ...dM, generatedAt: 0 }, { ...dL, generatedAt: 0 });
});

test('★★★ SCOPE — source pins: the planner, JIT force-charge and MPC never read the measured basis', () => {
  const src = (p: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src', p), 'utf8');
  const index = src('index.ts');
  /** A top-level function's text: from its declaration to the next top-level function. */
  const fnBody = (name: string): string => {
    const start = index.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} not found in index.ts`);
    const ends = [index.indexOf('\nasync function ', start + 10), index.indexOf('\nfunction ', start + 10)].filter((i) => i > start);
    const body = index.slice(start, Math.min(...ends));
    assert.ok(body.length > 2_000, `${name}: the slice is too short to be the function (${body.length} chars)`);
    return body;
  };
  const forbidden = /\b(projectedSocPct|minProjectedSoc|minProjectedSocTs|p10SocPct|p50SocPct|p90SocPct|pAboveReservePct|pFullCharge|socPct|poolFullWh|poolCapacityScale|poolCapacityBasis|poolOverheadW|runwayDrainW|runwayEnergyBasis|capacityScale|computeRunway|panelPoolBasisTracker|PoolEnergyBasisTracker)\b|report\('runway'\)|report<[^>]*>\('runway'\)/;
  // The planner's inputs, the JIT force-charge tick's (fullWh / poolSocPct / chargeRateKw) and the
  // reserve actuator's (fullWh / socCoherent): all from the panel's own figures.
  for (const name of ['recomputeNightChargePlan', 'runForceChargeTick', 'runNightActuationTickInner']) {
    const body = fnBody(name);
    assert.ok(body.includes('backupFullCapWh'), `${name} must read the panel's own pool capacity`);
    assert.ok(!forbidden.test(body), `${name} reads ${body.match(forbidden)?.[0]}`);
  }
  const recommend = index.slice(index.indexOf("app.get('/api/dispatch/recommend'"), index.indexOf("app.get('/api/backtest/forecast'"));
  assert.ok(recommend.length > 100 && !forbidden.test(recommend), `MPC reads ${recommend.match(forbidden)?.[0]}`);
  for (const f of ['nightChargeAdvisor.ts', 'nightForceCharge.ts', 'nightChargeActuator.ts', 'dispatch/mpc.ts']) {
    const s = src(f);
    assert.ok(!/poolEnergyBasis|runwayDrainW|runwayEnergyBasis|RUNWAY_CORE_OVERHEAD_W/.test(s), `${f} must not read the runway basis`);
  }
  assert.equal(RUNWAY_DISCHARGE_EFFICIENCY, 0.94, "the planner's discharge leg is unchanged");
});

test('★★ wiring — a secondary panel\'s drain runway gets the main thread\'s own measured basis', () => {
  const index = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  assert.ok(
    index.includes("const panelPoolBasisTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-panels') });"),
    'the main thread owns its own tracker and file',
  );
  const loop = index.slice(index.indexOf('for (const p of secondaryShp2s(devs)) {'), index.indexOf("runway-alarm: secondary panels skipped"));
  assert.ok(loop.length > 100, 'the secondary-panel loop is where it was');
  assert.ok(loop.includes('const pr = panelDrainRunway(p, samples, nowMs, panelPoolBasisTracker.evaluate(devs, p, nowMs));'),
    'each secondary panel\'s runway is computed on its own measured basis, from the same device map and instant');
  assert.equal(index.split('panelDrainRunway(').length - 1, 1, 'one production call site');
});

test('★★★ one basis — the day trajectory, the multi-day trajectory and the band all integrate runwayDrainW on poolFullWh', async () => {
  const { fc, multi } = await reports('measured');
  const full = fc.poolFullWh!;
  let soc = 0.7 * 92_160 * 0.944; // the panel's 70 % on the measured capacity
  // v1.194.0 — a surplus hour charges through the charge leg (chargeLegStep at
  // RUNWAY_CHARGE_EFFICIENCY); the fixture's sunny hours carry one, so the unity sum is caught here.
  let surplusHours = 0;
  for (const h of fc.hours) {
    const net = h.forecastPvW - runwayDrainW(h.forecastLoadW, fc.poolOverheadW!);
    if (net > 0) surplusHours += 1;
    soc = Math.max(0, Math.min(full, soc + chargeLegStep(net, RUNWAY_CHARGE_EFFICIENCY)));
    assert.ok(Math.abs((soc / full) * 100 - h.projectedSocPct!) < 0.06, `${new Date(h.ts).toISOString()}: ${h.projectedSocPct} vs ${((soc / full) * 100).toFixed(2)}`);
  }
  const fcByTs = new Map(fc.hours.map((h) => [h.ts, h.projectedSocPct]));
  let compared = 0;
  for (const d of multi.days) {
    for (const h of d.hours) {
      const p = fcByTs.get(h.ts);
      if (p == null || h.socPct == null) continue;
      compared += 1;
      assert.ok(Math.abs(p - h.socPct) < 0.15, `multi-day ${new Date(h.ts).toISOString()}: ${h.socPct} vs day ${p}`);
    }
  }
  assert.ok(compared >= 12, `${compared} shared hours`);
  assert.ok(surplusHours >= 3, `${surplusHours} surplus hours: the fixture exercises the charge leg`);
});

/* ─── (2) the band inverts with the drain that built the trajectory ───── */

function integrated(overheadW: number, fullWh: number): ForecastHour[] {
  const startTs = Math.ceil(Date.now() / HOUR) * HOUR + 48 * HOUR;
  let soc = 0.75 * fullWh;
  return Array.from({ length: 12 }, (_, h) => {
    const loadW = 1_800 + 400 * (h % 3);
    soc = Math.max(0, Math.min(fullWh, soc - runwayDrainW(loadW, overheadW)));
    return { ts: startTs + h * HOUR, forecastPvW: 0, forecastLoadW: loadW, cloudCoverPct: null, ghiWm2: null, projectedSocPct: (soc / fullWh) * 100, modelled: false }; // unrounded: an exact inversion
  });
}
function bareForecast(hours: ForecastHour[], extra: Partial<DayForecast>): DayForecast {
  return {
    generatedAt: hours[0].ts + Math.round(Math.random() * 1e6), hasWeather: false, historyDays: 30, reserveSoc: 16, hours,
    forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null, deviceModels: [],
    solarModel: { hourly: [], peakCoeff: 0, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 0 },
    ...extra,
  } as unknown as DayForecast;
}
const width = (r: ProbabilisticForecast, i: number) => (r.hours[i].p90SocPct ?? 0) - (r.hours[i].p10SocPct ?? 0);

test('★★★ band — the inversion recovers the measured capacity only with the trajectory\'s own drain (poolOverheadW)', async () => {
  setWeatherCacheForTesting(null);
  const fullWh = 92_160 * 0.944;
  const hours = integrated(270, fullWh);
  resetForecastCachesForTesting();
  const known = await computeProbabilisticForecast(bareForecast(hours, { poolFullWh: fullWh, poolOverheadW: 270 }), null);
  resetForecastCachesForTesting();
  const inverted = await computeProbabilisticForecast(bareForecast(hours, { poolOverheadW: 270 }), null);
  resetForecastCachesForTesting();
  const oldDrain = await computeProbabilisticForecast(bareForecast(hours, {}), null);
  for (let i = 1; i < hours.length; i++) {
    assert.ok(Math.abs(width(inverted, i) - width(known, i)) < 0.15, `hour ${i}: inverted ${width(inverted, i)} vs known ${width(known, i)}`);
  }
  // Read with the pre-v1.187.19 drain the same trajectory implies a ~13 % smaller pool: a visibly wider band.
  assert.ok(width(oldDrain, 11) > width(known, 11) * 1.06, `old drain ${width(oldDrain, 11)} vs ${width(known, 11)}`);
});

test('★★★ band — near the empty rail the hour-0 seed and every step drain through runwayDrainW with the forecast\'s overhead', async () => {
  // A night that empties the pool inside the window: the median path must reach the rail exactly
  // when the deterministic trajectory does, so the published P10/P90 equal a reference band built
  // with the same drain. Seeded or stepped with load/η alone, the raw paths lag the anchor by the
  // overhead and the published band moves at the rail.
  setWeatherCacheForTesting(null);
  const fullWh = 92_160 * 0.944;
  const fullKwh = fullWh / 1000;
  const startTs = Math.ceil(Date.now() / HOUR) * HOUR + 48 * HOUR;
  let socWh = 0.12 * fullWh;
  const hours: ForecastHour[] = Array.from({ length: 10 }, (_, h) => {
    const loadW = 3_000 + 300 * (h % 2);
    socWh = Math.max(0, Math.min(fullWh, socWh - runwayDrainW(loadW, 270)));
    return { ts: startTs + h * HOUR, forecastPvW: 0, forecastLoadW: loadW, cloudCoverPct: null, ghiWm2: null, projectedSocPct: Math.round((socWh / fullWh) * 1000) / 10, modelled: false };
  });
  assert.ok(hours.some((h) => h.projectedSocPct === 0) && hours[0].projectedSocPct! > 5, 'the trajectory reaches the rail inside the window');
  resetForecastCachesForTesting();
  const band = await computeProbabilisticForecast(bareForecast(hours, { poolFullWh: fullWh, poolOverheadW: 270 }), null);
  // The reference: night hours carry no PV sigma, so each path steps by (net ± z·σ_load)/full.
  const Z = 1.282, SIGMA_LOAD_FRAC = 0.15;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const net = (loadW: number) => -runwayDrainW(loadW, 270) / 1000;
  const start = clamp(hours[0].projectedSocPct! - (net(hours[0].forecastLoadW) / fullKwh) * 100);
  let low = start, mid = start, high = start;
  let railHours = 0;
  hours.forEach((h, i) => {
    const sigma = (SIGMA_LOAD_FRAC * h.forecastLoadW) / 1000;
    low = clamp(low + ((net(h.forecastLoadW) - Z * sigma) / fullKwh) * 100);
    mid = clamp(mid + (net(h.forecastLoadW) / fullKwh) * 100);
    high = clamp(high + ((net(h.forecastLoadW) + Z * sigma) / fullKwh) * 100);
    const anchor = h.projectedSocPct!;
    const p10 = clamp(anchor + low - mid), p90 = clamp(anchor + high - mid);
    if (anchor === 0) railHours += 1;
    assert.ok(Math.abs(band.hours[i].p10SocPct! - p10) <= 0.05 + 1e-6, `hour ${i}: P10 ${band.hours[i].p10SocPct} vs reference ${p10.toFixed(3)}`);
    assert.ok(Math.abs(band.hours[i].p90SocPct! - p90) <= 0.05 + 1e-6, `hour ${i}: P90 ${band.hours[i].p90SocPct} vs reference ${p90.toFixed(3)}`);
  });
  assert.ok(railHours >= 3, `${railHours} hours on the rail`);
});

test('★★★ band — across a sunny stretch to the full rail the inversion, the hour-0 seed and every step charge through the trajectory\'s charge leg', async () => {
  // v1.194.0. 8-9 kW of PV under a 2 kW load from 60 %: every hour a surplus of ≈ 5.6-6.6 kWh, stored
  // at η_c = √0.86 = 0.927 by the forward walk, so the pool reaches the 100 % rail inside the window.
  // The reference band steps each path by chargeLegStep(net + z·σ, η_c) — the charge leg applied
  // AFTER the spread, per path — seeded one stepped hour behind the anchor. With no weather and no
  // skill report σ is deterministic: PV σ = p50 × √(0.25² + 0.15²) × √(1 + h/24) / 1000 (P10 above
  // 0 throughout), load σ = 0.15 × load / 1000. Read with the stepped net, the inversion recovers
  // the pool the trajectory was built on; read at unity it recovers poolFull / η_c (8 % larger),
  // and the band narrows by η_c.
  setWeatherCacheForTesting(null);
  const fullWh = 92_160 * 0.944;
  const fullKwh = fullWh / 1000;
  const eta = RUNWAY_CHARGE_EFFICIENCY;
  const startTs = Math.ceil(Date.now() / HOUR) * HOUR + 48 * HOUR;
  const pvOf = (h: number) => 8_000 + 500 * (h % 3);
  const loadOf = (h: number) => 2_000 + 200 * (h % 2);
  let socWh = 0.6 * fullWh;
  const hours: ForecastHour[] = Array.from({ length: 10 }, (_, h) => {
    socWh = Math.max(0, Math.min(fullWh, socWh + chargeLegStep(pvOf(h) - runwayDrainW(loadOf(h), 270), eta)));
    return { ts: startTs + h * HOUR, forecastPvW: pvOf(h), forecastLoadW: loadOf(h), cloudCoverPct: null, ghiWm2: null, projectedSocPct: (socWh / fullWh) * 100, modelled: false }; // unrounded: an exact inversion
  });
  assert.ok(hours.filter((h) => h.projectedSocPct === 100).length >= 3 && hours[0].projectedSocPct! < 70, 'the trajectory reaches the full rail inside the window');
  const Z = 1.282, SIGMA_LOAD_FRAC = 0.15, SF0 = Math.sqrt(0.25 ** 2 + 0.15 ** 2);
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const raw = (h: number) => (pvOf(h) - runwayDrainW(loadOf(h), 270)) / 1000;
  const reference = (): Array<{ p10: number; p90: number }> => {
    const start = clamp(hours[0].projectedSocPct! - (chargeLegStep(raw(0), eta) / fullKwh) * 100);
    let low = start, mid = start, high = start;
    return hours.map((h, i) => {
      const sigmaPv = (pvOf(i) * SF0 * Math.sqrt(1 + i / 24)) / 1000;
      const sigmaLoad = (SIGMA_LOAD_FRAC * loadOf(i)) / 1000;
      const sigma = Math.sqrt(sigmaPv * sigmaPv + sigmaLoad * sigmaLoad);
      const step = (z: number) => (chargeLegStep(raw(i) + z * sigma, eta) / fullKwh) * 100;
      low = clamp(low + step(-Z));
      mid = clamp(mid + step(0));
      high = clamp(high + step(Z));
      const anchor = h.projectedSocPct!;
      return { p10: clamp(anchor + low - mid), p90: clamp(anchor + high - mid) };
    });
  };
  const ref = reference();
  resetForecastCachesForTesting();
  const known = await computeProbabilisticForecast(bareForecast(hours, { poolFullWh: fullWh, poolOverheadW: 270 }), null);
  resetForecastCachesForTesting();
  const inverted = await computeProbabilisticForecast(bareForecast(hours, { poolOverheadW: 270 }), null);
  for (const [name, band] of [['known', known], ['inverted', inverted]] as const) {
    hours.forEach((_, i) => {
      assert.ok(Math.abs(band.hours[i].p10SocPct! - ref[i].p10) <= 0.05 + 1e-6, `${name} hour ${i}: P10 ${band.hours[i].p10SocPct} vs reference ${ref[i].p10.toFixed(3)}`);
      assert.ok(Math.abs(band.hours[i].p90SocPct! - ref[i].p90) <= 0.05 + 1e-6, `${name} hour ${i}: P90 ${band.hours[i].p90SocPct} vs reference ${ref[i].p90.toFixed(3)}`);
    });
  }
  // The mid-range offset is η_c × z·σ, not z·σ: the spread itself is stored through the charge leg.
  const s1 = Math.sqrt(((pvOf(1) * SF0 * Math.sqrt(1 + 1 / 24)) / 1000) ** 2 + ((SIGMA_LOAD_FRAC * loadOf(1)) / 1000) ** 2);
  const s0 = Math.sqrt(((pvOf(0) * SF0) / 1000) ** 2 + ((SIGMA_LOAD_FRAC * loadOf(0)) / 1000) ** 2);
  assert.ok(Math.abs((ref[1].p90 - hours[1].projectedSocPct!) - (eta * Z * (s0 + s1) / fullKwh) * 100) < 1e-9, 'the reference itself: two stepped hours of spread');
});

test('★★ band — a hand-built forecast with no poolOverheadW is read with the drain it was built with (load/η)', async () => {
  setWeatherCacheForTesting(null);
  const hours = integrated(0, 92_160);
  resetForecastCachesForTesting();
  const known = await computeProbabilisticForecast(bareForecast(hours, { poolFullWh: 92_160 }), null);
  resetForecastCachesForTesting();
  const inverted = await computeProbabilisticForecast(bareForecast(hours, {}), null);
  for (let i = 1; i < hours.length; i++) assert.ok(Math.abs(width(inverted, i) - width(known, i)) < 0.03, `hour ${i}`);
});
