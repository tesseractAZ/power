import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  type CushionPoolScale,
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
 *     UNCHANGED, with ONE exception (v1.199.0): the cushion LINE's kWh → percent conversion
 *     takes the house pool's measured capacity scale, so the reserve written at the line holds
 *     the whole cushion on the packs' measured capacity (nightChargeAdvisor.ts cushionLineKwh).
 *     It enters through one door, pinned below: index.ts measuredCushionScale, evaluated on the
 *     main thread's own tracker from the planner's own snapshot. The day forecast,
 *     the probabilistic band and the multi-day forecast now carry a measured SoC trajectory;
 *     everything the planner and the MPC read from them must be byte-identical between the
 *     pre-v1.187.19 basis (the legacy override: nameplate kWh, load/η) and the measured one,
 *     and the planner run on each must produce the identical plan — with the one measured
 *     input passed to both, too.
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

/** The planner's input assembly, field for field as recomputeNightChargePlan builds it. `over`:
 *  v1.199.0 — the one measured input (cushionPoolScale), and a scored calibration history so the
 *  plan is sized (the fixture's band has none, so its plan is the refused one). */
function planFrom(r: Reports, nowMs: number, over: Partial<NightChargeInputDeps> = {}) {
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
    ...over,
  };
  return computeNightChargePlan(buildNightChargeInputs(deps));
}

beforeEach(() => { resetOwnerReserveFloorPct(); setWeatherCacheForTesting(weather()); });
afterEach(() => { setWeatherCacheForTesting(null); setPoolBasisOverrideForTesting(null); resetPoolEnergyBasisForTesting(); resetForecastCachesForTesting(); });

/** v1.200.1 — the SCOPE test's own clock. Whether the fixture's evening plan sizes an islanded-outage line depends on where "now" falls
 *  against tonight's window, so on the wall clock it passed only from about 20:10 to 00:10 MST and failed at every other hour, on main
 *  too. Fixed at 20:30 MST on 2026-11-06, inside that span; Date alone is mocked, so timers and I/O run as they do. */
const SCOPE_NOW_MS = Date.UTC(2026, 10, 7, 3, 30);
test('★★★ SCOPE — the planner and MPC inputs are byte-identical on the legacy and the measured basis; the planner\'s plan is identical', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: SCOPE_NOW_MS });
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
  // v1.199.0 — the same on a plan that is SIZED (the band given a scored history), and with the one
  // measured input passed to both: the reports' measured trajectory still never reaches the plan.
  const SCALE: CushionPoolScale = { scale: 0.944, basis: 'measured' };
  const sized = { calScoredDays: 30, bandCoverageFrac: 0.9 };
  const sizedL = planFrom(legacy, nowMs, sized);
  const sizedM = planFrom(measured, nowMs, sized);
  assert.equal(sizedL.basisComplete, true, sizedL.rationale);
  assert.ok(sizedL.cushionBasis === 'islanded-outage' && sizedL.cushionLineSocPct != null, 'the fixture sizes an islanded-outage line');
  assert.deepEqual(sizedM, sizedL);
  const scaledL = planFrom(legacy, nowMs, { ...sized, cushionPoolScale: SCALE });
  const scaledM = planFrom(measured, nowMs, { ...sized, cushionPoolScale: SCALE });
  assert.deepEqual(scaledM, scaledL);
  // …and the exception is real, not vacuous: the scale moves the line (16% + 12.77 kWh on 92.16 × 0.944).
  assert.deepEqual(scaledM.cushionPoolScale, SCALE);
  assert.deepEqual([sizedM.cushionLineSocPct, scaledM.cushionLineSocPct], [29.86, 30.68]);
  // The recommend-only dispatch plan reads the panel's own figures and the PV/load series.
  resetForecastCachesForTesting();
  const dL = computeDispatchPlan(fleet(), legacy.fc);
  resetForecastCachesForTesting();
  const dM = computeDispatchPlan(fleet(), measured.fc);
  assert.deepEqual({ ...dM, generatedAt: 0 }, { ...dL, generatedAt: 0 });
});

/** v1.199.0 — every top-level function and const arrow of a module, by name: from its declaration to
 *  its closing brace at column 0 (or the next top-level declaration, whichever is first). */
function topLevelFunctions(text: string): Map<string, string> {
  const decl = /^(?:export )?(?:async )?function\*? (\w+)\s*[(<]|^(?:export )?const (\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=\n]+?)?=>/gm;
  const starts: Array<{ name: string; at: number }> = [];
  for (const m of text.matchAll(decl)) starts.push({ name: m[1] ?? m[2], at: m.index! });
  const out = new Map<string, string>();
  starts.forEach((d, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].at : text.length;
    const close = text.indexOf('\n}', d.at);
    out.set(d.name, text.slice(d.at, close >= 0 ? Math.min(close + 2, next) : next));
  });
  return out;
}

test('★★★ SCOPE — source pins: the planner, JIT force-charge and MPC never read the measured basis — except the cushion line, through ONE door', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  const src = (p: string) => readFileSync(resolve(SRC, p), 'utf8');
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
  // v1.199.0 — the door's own names are forbidden too: anywhere but the door, they are a second door.
  // So is every other way to the scale that does not spell `cushionPoolScale` itself: the ledger
  // helper that returns it (cushionPoolScale\w+: cushionPoolScaleLedgerColumns), the ledger's columns
  // (cushion_pool_scale, _basis) and the tracker's file (defaultPoolEnergyBasisPath, pool-energy-basis*).
  const forbidden = /\b(projectedSocPct|minProjectedSoc|minProjectedSocTs|p10SocPct|p50SocPct|p90SocPct|pAboveReservePct|pFullCharge|socPct|poolFullWh|poolCapacityScale|poolCapacityBasis|poolOverheadW|runwayDrainW|runwayEnergyBasis|capacityScale|computeRunway|panelPoolBasisTracker|PoolEnergyBasisTracker|cushionPoolBasisTracker|measuredCushionScale|cushionPoolScale\w+|cushion_pool_scale\w*|defaultPoolEnergyBasisPath|pool-energy-basis)\b|report\('runway'\)|report<[^>]*>\('runway'\)/;
  /** Every spelling of the scale itself: the plan's field, the ledger helper and the ledger's columns. */
  const SCALE = /\bcushionPoolScale\w*|\bcushion_pool_scale\w*/;

  // ── (b) THE DOOR, pinned exactly ─────────────────────────────────────────────────────────────
  // The house panel's own main-thread tracker and file, and the helper that reads it: the scale and
  // its basis, nothing else of the basis, null when it throws.
  assert.ok(index.includes("const cushionPoolBasisTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-cushion') });"));
  const DOOR = [
    'function measuredCushionScale(',
    "  devs: FleetSnapshot['devices'], panel: NonNullable<ReturnType<typeof findShp2>>, nowMs: number,",
    '): (CushionPoolScale & { connectedCores: number }) | null {',
    '  try {',
    '    const b = cushionPoolBasisTracker.evaluate(devs, panel, nowMs);',
    "    const basis: CushionScaleBasis = b.capacityBasis; // tsc fails here if the tracker's basis gains a member",
    '    return { scale: b.capacityScale, basis, connectedCores: b.connectedCores };',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
  ].join('\n');
  const tops = topLevelFunctions(index);
  assert.equal(tops.get('measuredCushionScale'), DOOR, 'the door, character for character');
  const count = (s: string, needle: string) => s.split(needle).length - 1;
  assert.equal(count(index, 'cushionPoolBasisTracker'), 2, 'declared, and read by the door alone');
  assert.equal(count(index, 'measuredCushionScale('), 2, 'defined, and called once');
  assert.equal(count(index, 'PoolEnergyBasisTracker('), 2, "the main thread's two trackers: the secondary panels' and the cushion's");
  assert.equal(count(index, 'panelPoolBasisTracker.evaluate('), 1, "the secondary panels' tracker, in their loop only");
  // The tracker's file is named once, where the tracker is built: nothing else opens it.
  assert.equal(count(index, 'defaultPoolEnergyBasisPath('), 2, "the two trackers' files, and no third reader");
  assert.equal(count(index, 'pool-energy-basis-cushion'), 1, "the cushion tracker's file, on its construction line alone");
  // The ledger helper returns the scale, so it is a door too: called once, by the ledger writer,
  // whose line writes it to the row (write-only — no consumer below may reach recordNightPlanRow).
  const LEDGER = '    ...cushionPoolScaleLedgerColumns(plan),\n';
  assert.equal(count(index, 'cushionPoolScaleLedgerColumns('), 1, 'the ledger helper, called once');
  assert.equal(count(tops.get('recordNightPlanRow') ?? '', LEDGER), 1, 'by recordNightPlanRow, into the row');
  // In the planner: the device map read once, the door called once from it, BEFORE the first await
  // (the scale and fullWh from one snapshot), its result logged on a live leg and passed as an input.
  const plan = fnBody('recomputeNightChargePlan');
  const CALL = '  const cushionPoolScale = measuredCushionScale(devs, shp2, nowMs);\n';
  assert.ok(plan.includes('  const devs = store.get().devices;\n  const shp2 = findShp2(devs);\n'));
  assert.equal(count(plan, CALL), 1);
  assert.equal(count(plan, 'store.get('), 1, 'one snapshot');
  assert.ok(plan.indexOf(CALL) < plan.indexOf('await '), 'the scale is taken before the first await');
  assert.ok(plan.indexOf('  const fullKwh = fullWh / 1000;\n') < plan.indexOf(CALL), 'beside the pool it converts on');
  assert.ok(plan.includes(`${CALL}  if (!shadowLeg) {\n`), 'a shadow leg evaluates the tracker (and writes its file) but never logs');
  assert.ok(plan.includes('    // v1.199.0 — the cushion line\'s measured capacity scale (null: the nameplate line).\n    cushionPoolScale,\n'), 'passed as the input');

  // ── (a) + (d) the planner, the JIT force-charge, the reserve actuator, the MPC: no forbidden token —
  // the planner's body with EXACTLY the one pinned call line removed first, the others with none.
  for (const name of ['recomputeNightChargePlan', 'runForceChargeTick', 'runNightActuationTickInner']) {
    const body = name === 'recomputeNightChargePlan' ? plan.replace(CALL, '') : fnBody(name);
    assert.ok(body.includes('backupFullCapWh'), `${name} must read the panel's own pool capacity`);
    assert.ok(!forbidden.test(body), `${name} reads ${body.match(forbidden)?.[0]}`);
    if (name !== 'recomputeNightChargePlan') assert.ok(!SCALE.test(body), `${name} takes the cushion scale (${body.match(SCALE)?.[0]})`);
  }
  const recommend = index.slice(index.indexOf("app.get('/api/dispatch/recommend'"), index.indexOf("app.get('/api/backtest/forecast'"));
  assert.ok(recommend.length > 100 && !forbidden.test(recommend), `MPC reads ${recommend.match(forbidden)?.[0]}`);
  assert.ok(!SCALE.test(recommend), `MPC takes the cushion scale (${recommend.match(SCALE)?.[0]})`);

  // ── (c) NO LAUNDERING through a helper. The token check above reads only the consumer's own text,
  // so a helper holding the tokens would pass it. Every top-level function of index.ts the consumers
  // reach, by name, at any depth, must hold no forbidden token — except the one allowlisted pair
  // (recomputeNightChargePlan → measuredCushionScale), which is not descended into.
  assert.ok(tops.size >= 85, `${tops.size} top-level functions: the walk must see the module`);
  for (const n of ['recomputeNightChargePlan', 'runForceChargeTick', 'runNightActuationTickInner', 'measuredCushionScale', 'reconnectObsDevices']) {
    assert.ok(tops.has(n), `the walk sees ${n}`);
  }
  const tainted = [...tops].filter(([, b]) => forbidden.test(b)).map(([n]) => n);
  assert.ok(tainted.includes('reconnectObsDevices') && tainted.includes('measuredCushionScale'), `the walk sees a tainted function (${tainted.join(', ')})`);
  assert.ok(tainted.includes('recordNightPlanRow'), 'the walk sees the ledger writer, which holds the scale, as tainted');
  const refs = (body: string, self: string): string[] =>
    [...new Set([...body.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => m[1]))].filter((n) => n !== self && tops.has(n));
  const roots: Array<[string, string]> = [
    ['recomputeNightChargePlan', plan], ['runForceChargeTick', fnBody('runForceChargeTick')],
    ['runNightActuationTickInner', fnBody('runNightActuationTickInner')], ['/api/dispatch/recommend', recommend],
  ];
  for (const [root, body] of roots) {
    const seen = new Set<string>();
    const queue = refs(body, root).map((n) => [root, n] as const);
    while (queue.length) {
      const [from, n] = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (from === 'recomputeNightChargePlan' && n === 'measuredCushionScale') continue; // THE door
      const b = tops.get(n)!;
      assert.ok(!forbidden.test(b), `${root} reaches ${n} (from ${from}), which reads ${b.match(forbidden)?.[0]}`);
      assert.ok(!SCALE.test(b), `${root} reaches ${n} (from ${from}), which takes the cushion scale (${b.match(SCALE)?.[0]})`);
      for (const m of refs(b, n)) queue.push([n, m]);
    }
    if (root !== 'recomputeNightChargePlan') assert.ok(!seen.has('measuredCushionScale'), `${root} reaches the door`);
  }

  // ── (e) THE ADVISOR: nothing of the runway's basis; the scale read once, into the one line ────────
  const advisor = src('nightChargeAdvisor.ts');
  assert.ok(!/poolEnergyBasis|runwayDrainW|runwayEnergyBasis|RUNWAY_CORE_OVERHEAD_W/.test(advisor), 'nightChargeAdvisor.ts must not read the runway basis');
  // Its imports are the ones it had: no module reaches the planner that is not named here. Every module
  // specifier in the file counts — a static import, a re-export, a dynamic import(), wherever it sits.
  const advisorImports = [...new Set([...advisor.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(advisorImports, ['./chargeTaper.js', './chargeWindows.js', './nightChargeActuator.js', './nightForceCharge.js', './physics/chargeLeg.js', './siteTime.js']);
  const sizing = advisor.slice(advisor.indexOf('function sizeNightChargePlan('), advisor.indexOf('\nexport const MIDDAY_REENTRY_MARGIN_PCT'));
  assert.ok(sizing.length > 20_000, `sizeNightChargePlan: ${sizing.length} chars`);
  const LINE = '  const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh, cushionBasis, poolScale: inputs.cushionPoolScale });\n  const targetFloorKwh = cushionLine.kwh;\n';
  assert.equal(count(sizing, LINE), 1, 'the scale is read once, into the one line every reader below reads');
  assert.equal(count(sizing, 'inputs.cushionPoolScale'), 1);
  assert.equal(count(sizing, 'targetFloorKwh ='), 1, 'no second line');
  assert.ok(!sizing.includes('reserveKwh + cushionKwh'), 'no parallel nameplate line');
  assert.equal(count(advisor, 'cushionLineKwh('), 2, 'defined, and called once');
  // Every use of the line object: its kWh once (above), its applied scale only in the two plan fields
  // and the rationale's clause (whose percent is the line's own, with no second division by the scale).
  const uses = [...sizing.matchAll(/^.*\bcushionLine\b.*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(uses, [
    'const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh, cushionBasis, poolScale: inputs.cushionPoolScale });',
    'const targetFloorKwh = cushionLine.kwh;',
    'const measuredCushionNote = cushionLine.applied != null && cushionLine.applied.scale < 1',
    "? `, ${round1(((targetFloorKwh - reserveKwh) / fullKwh) * 100)}% of the packs' measured capacity at ×${cushionLine.applied.scale.toFixed(3)} of nameplate`",
    '...(cushionLine.applied != null ? { cushionPoolScale: cushionLine.applied } : {}),',
    '...(cushionLine.applied != null ? { cushionPoolScale: cushionLine.applied } : {}),',
  ]);
  assert.equal(count(advisor, 'cushionLine.'), count(sizing, 'cushionLine.'), 'nowhere outside the sizing');

  // ── (f) EVERY place the scale may appear, across src (code lines; comment lines aside) ───────────
  // Every spelling (SCALE): the plan's field, the ledger helper that returns it and the ledger's
  // columns — a ledger-row read or a helper call is the scale as much as the field is. A comment line
  // is one that starts a comment and carries no code after a closing `*/`.
  const ALLOWED = new Map<string, string[]>([
    ['nightChargeAdvisor.ts', [ // in file order
      'cushionPoolScale?: CushionPoolScale | null;', // NightChargeInputs
      "cushionPoolScale?: { scale: number; basis: CushionScaleBasis | 'implausible' };", // NightChargePlan
      'const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh, cushionBasis, poolScale: inputs.cushionPoolScale });',
      '...(cushionLine.applied != null ? { cushionPoolScale: cushionLine.applied } : {}),', // the hold plan
      '...(cushionLine.applied != null ? { cushionPoolScale: cushionLine.applied } : {}),', // the charge plan
      'cushionPoolScale?: CushionPoolScale | null;', // NightChargeInputDeps
      'cushionPoolScale,', // buildNightChargeInputs' destructure
      '...(cushionPoolScale !== undefined ? { cushionPoolScale } : {}),', // and its pass-through
      'export function cushionPoolScaleLedgerColumns(', // the ledger helper: the plan's scale, to the row
      "plan: Pick<NightChargePlan, 'cushionPoolScale'>,",
      '): { cushion_pool_scale: number | null; cushion_pool_scale_basis: string | null } {',
      'cushion_pool_scale: plan.cushionPoolScale?.scale ?? null,',
      'cushion_pool_scale_basis: plan.cushionPoolScale?.basis ?? null,',
    ]],
    ['index.ts', [ // in file order
      'cushionPoolScaleLedgerColumns, cushionScaleLogText, type CushionPoolScale, type CushionScaleBasis,', // the import
      'const cushionPoolScale = measuredCushionScale(devs, shp2, nowMs);',
      "const scaleKey = cushionPoolScale == null ? 'unavailable'",
      ': `${cushionPoolScale.basis}:${cushionPoolScale.scale.toFixed(4)}:${cushionPoolScale.connectedCores}`;',
      'app.log.info(cushionScaleLogText(cushionPoolScale));',
      'cushionPoolScale,', // deps
      '...cushionPoolScaleLedgerColumns(plan),', // recordNightPlanRow: written, never read back
    ]],
    ['recorder.ts', [ // in file order: the row's two fields, the allowlist and the schema migration
      'cushion_pool_scale: number | null;',
      'cushion_pool_scale_basis: string | null;',
      "'cushion_pool_scale', 'cushion_pool_scale_basis',",
      "'cushion_pool_scale REAL', 'cushion_pool_scale_basis TEXT',",
    ]],
  ]);
  const isComment = (l: string): boolean => /^\/\//.test(l) || (/^(\*|\/\*)/.test(l) && !/\*\/\s*\S/.test(l));
  assert.ok(isComment('/** v1.199.0 — x. */') && isComment('* cushion_pool_scale') && !isComment('/* x */ const s = 1;'), 'the comment rule');
  const walk = (dir: string, rel = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(dir, e.name), `${rel}${e.name}/`) : e.name.endsWith('.ts') ? [`${rel}${e.name}`] : []);
  const files = walk(SRC);
  assert.ok(files.length > 100 && files.includes('index.ts') && files.includes('dispatch/mpc.ts'), `${files.length} source files`);
  for (const f of files) {
    const code = src(f).split('\n').map((l) => l.trim()).filter((l) => SCALE.test(l) && !isComment(l));
    assert.deepEqual(code, ALLOWED.get(f) ?? [], `${f}: the cushion scale appears where no pin allows it`);
  }

  // ── (g) NO LAUNDERING through another module ───────────────────────────────────────────────────
  // The runway's basis module is imported where it was, and by index.ts only for its two trackers'
  // constructor and path; no other module constructs a tracker or computes a scale.
  const importers = files.filter((f) => /from '(?:\.\.?\/)+poolEnergyBasis(?:\.js)?'|import\(\s*'(?:\.\.?\/)+poolEnergyBasis/.test(src(f))).sort();
  assert.deepEqual(importers, ['alertMonitor.ts', 'analytics.ts', 'index.ts', 'panelRunway.ts']);
  assert.deepEqual([...index.matchAll(/^import [^;]*? from '\.\/poolEnergyBasis\.js';$/gm)].map((m) => m[0]),
    ["import { PoolEnergyBasisTracker, defaultPoolEnergyBasisPath } from './poolEnergyBasis.js';"]);
  const constructs = Object.fromEntries(files.map((f): [string, number] => [f, count(src(f), 'new PoolEnergyBasisTracker(')]).filter(([, n]) => n > 0));
  assert.deepEqual(constructs, { 'analytics.ts': 1, 'index.ts': 2 });
  for (const fn of ['candidatePoolScale(', 'coreCapacityRatio(']) {
    const callers = files.filter((f) => f !== 'poolEnergyBasis.ts' && src(f).includes(fn));
    assert.deepEqual(callers, [], `${fn} is called outside poolEnergyBasis.ts`);
  }

  for (const f of ['nightForceCharge.ts', 'nightChargeActuator.ts', 'dispatch/mpc.ts']) {
    const s = src(f);
    assert.ok(!/poolEnergyBasis|runwayDrainW|runwayEnergyBasis|RUNWAY_CORE_OVERHEAD_W/.test(s), `${f} must not read the runway basis`);
    assert.ok(!SCALE.test(s) && !/cushionLineKwh|defaultPoolEnergyBasisPath|pool-energy-basis/.test(s), `${f} must not read the cushion scale`);
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
