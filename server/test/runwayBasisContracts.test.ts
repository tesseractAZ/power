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
 *     UNCHANGED, with TWO exceptions. (v1.199.0) The cushion LINE's kWh → percent conversion
 *     takes the house pool's measured capacity scale, so the reserve written at the line holds
 *     the whole cushion on the packs' measured capacity (nightChargeAdvisor.ts cushionLineKwh).
 *     It enters through one door, pinned below: index.ts measuredCushionScale, evaluated on the
 *     main thread's own tracker from the planner's own snapshot. (v1.201.0) The islanded-outage
 *     cushion counts the Cores' standby draw for its hours: the runway's overhead figure for the
 *     connected Cores that tracker counted — one number, through a second door pinned below
 *     (index.ts cushionStandbyOverheadW), read once in the advisor (plausibleStandbyW). The day forecast,
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
  // v1.201.0 — the second exception, the same way: the standby figure passed to both (with and without the
  // scale) gives identical plans, and it is real — 12.77 + 4 h × 0.27 kW = 13.85 kWh of cushion.
  const standbyL = planFrom(legacy, nowMs, { ...sized, cushionStandbyW: 270 });
  const standbyM = planFrom(measured, nowMs, { ...sized, cushionStandbyW: 270 });
  assert.deepEqual(standbyM, standbyL);
  const bothL = planFrom(legacy, nowMs, { ...sized, cushionPoolScale: SCALE, cushionStandbyW: 270 });
  const bothM = planFrom(measured, nowMs, { ...sized, cushionPoolScale: SCALE, cushionStandbyW: 270 });
  assert.deepEqual(bothM, bothL);
  assert.deepEqual([sizedM.cushionKwh, standbyM.cushionKwh], [12.77, 13.85]);
  assert.deepEqual([standbyM.cushionLineSocPct, bothM.cushionLineSocPct], [31.03, 31.92]);
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

test('★★★ SCOPE — source pins: the planner, JIT force-charge and MPC never read the measured basis — except the cushion line and its standby, through TWO doors', () => {
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
  // v1.201.0 — and the runway's overhead in every spelling: its rule (runwayPoolOverheadW — the old
  // \bpoolOverheadW\b never matched it), its options (analytics.ts's constants AND the limits.ts getters they are
  // built from, which index.ts can reach through the `limits` it imports), its marginal efficiency (both spellings),
  // the second door and the standby's ledger helper and columns.
  const forbidden = /\b(projectedSocPct|minProjectedSoc|minProjectedSocTs|p10SocPct|p50SocPct|p90SocPct|pAboveReservePct|pFullCharge|socPct|poolFullWh|poolCapacityScale|poolCapacityBasis|poolOverheadW|runwayDrainW|runwayEnergyBasis|capacityScale|computeRunway|panelPoolBasisTracker|PoolEnergyBasisTracker|cushionPoolBasisTracker|measuredCushionScale|cushionPoolScale\w+|cushion_pool_scale\w*|defaultPoolEnergyBasisPath|pool-energy-basis|runwayPoolOverheadW|RUNWAY_POOL_OVERHEAD_FLOOR_W|RUNWAY_CORE_OVERHEAD_W|RUNWAY_DRAIN_MARGINAL_EFFICIENCY|runwayPoolOverheadFloorW|runwayCoreOverheadW|runwayDrainMarginalEfficiency|cushionStandbyOverheadW|cushionStandbyLedgerColumns|cushion_standby\w*)\b|report\('runway'\)|report<[^>]*>\('runway'\)/;
  assert.ok(forbidden.test('runwayPoolOverheadW(3, true)') && forbidden.test('cushion_standby_w'), 'the hole is closed');
  assert.ok(['limits.runwayPoolOverheadFloorW', 'limits.runwayCoreOverheadW', "limits['runwayDrainMarginalEfficiency']",
    "option<number>('RUNWAY_CORE_OVERHEAD_W')"].every((t) => forbidden.test(t)), "the options' own getters and names too");
  /** Every spelling of the scale itself: the plan's field, the ledger helper and the ledger's columns. */
  const SCALE = /\bcushionPoolScale\w*|\bcushion_pool_scale\w*/;
  /** v1.201.0 — every spelling of the standby: the inputs' and the plan's fields, the helpers, the ledger's columns. */
  const STANDBY = /\bcushionStandby\w*|\bcushion_standby\w*/;

  // ── (b) THE DOOR, pinned exactly ─────────────────────────────────────────────────────────────
  // The house panel's own main-thread tracker and file, and the helper that reads it: the scale and
  // its basis, nothing else of the basis, null when it throws.
  // v1.203.0 — seeded, read-only, from the worker's file while it has no ratio of its own (poolEnergyBasis.ts seedPath): the one new
  // reader of 'pool-energy-basis', on this line alone (below).
  assert.ok(index.includes("const cushionPoolBasisTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-cushion'), seedPath: defaultPoolEnergyBasisPath('pool-energy-basis') });"));
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
  // v1.203.0 — and the cushion tracker's seed, the worker's file, read on the same line: the third call, and no fourth reader.
  assert.equal(count(index, 'defaultPoolEnergyBasisPath('), 3, "the two trackers' files and the cushion tracker's seed, and no fourth reader");
  assert.equal(count(index, 'pool-energy-basis-cushion'), 1, "the cushion tracker's file, on its construction line alone");
  assert.equal(count(index, "defaultPoolEnergyBasisPath('pool-energy-basis')"), 1, "the worker's file, as the cushion tracker's seed alone");
  assert.equal(count(index, 'seedPath:'), 1, 'one seeded tracker');
  // v1.203.0 — the capacity floor a cushion-only plan counts its pool on with no ratio known: the scale's own floor (an option),
  // imported and passed to the planner on one line, never a measurement.
  assert.equal(count(index, 'CAPACITY_SCALE_MIN'), 2, 'imported, and passed once');
  assert.equal(count(index, '    cushionOnlyFloorScale: CAPACITY_SCALE_MIN,\n'), 1);
  // The ledger helper returns the scale, so it is a door too: called once, by the ledger writer,
  // whose line writes it to the row (write-only — no consumer below may reach recordNightPlanRow).
  const LEDGER = '    ...cushionPoolScaleLedgerColumns(plan),\n';
  assert.equal(count(index, 'cushionPoolScaleLedgerColumns('), 1, 'the ledger helper, called once');
  assert.equal(count(tops.get('recordNightPlanRow') ?? '', LEDGER), 1, 'by recordNightPlanRow, into the row');

  // ── (b2) v1.201.0 — THE SECOND DOOR, pinned exactly ─────────────────────────────────────────────
  // The runway's own overhead rule for the Cores the cushion tracker counted (the scale door's result), the
  // panel reporting a pool: one number, W. A tracker that threw (null) counts no Core — the runway's floor.
  const DOOR_B = [
    'function cushionStandbyOverheadW(poolScale: { connectedCores: number } | null, poolReported: boolean): number {',
    '  return runwayPoolOverheadW(poolScale?.connectedCores ?? 0, poolReported);',
    '}',
  ].join('\n');
  assert.equal(tops.get('cushionStandbyOverheadW'), DOOR_B, 'the second door, character for character');
  assert.equal(count(index, 'cushionStandbyOverheadW('), 2, 'defined, and called once');
  assert.equal(count(index, 'runwayPoolOverheadW('), 1, 'the runway rule, called by the door alone');
  assert.equal(count(index, 'runwayPoolOverheadW'), 2, 'imported, and read by the door alone');
  const analyticsImport = index.slice(0, index.indexOf("} from './analytics.js';"));
  assert.ok(analyticsImport.slice(analyticsImport.lastIndexOf('import {')).includes('\n  runwayPoolOverheadW,\n'), 'imported from analytics.ts');
  // The standby's ledger helper returns the figure: called once, by the ledger writer, into the row.
  const LEDGER_B = '    ...cushionStandbyLedgerColumns(plan),\n';
  assert.equal(count(index, 'cushionStandbyLedgerColumns('), 1, 'the standby ledger helper, called once');
  assert.equal(count(tops.get('recordNightPlanRow') ?? '', LEDGER_B), 1, 'by recordNightPlanRow, into the row');
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
  assert.ok(plan.includes('    // v1.199.0 — the cushion line\'s measured capacity scale (null: the nameplate line). v1.202.0 — the plan\'s pool\'s too.\n    cushionPoolScale,\n'), 'passed as the input');
  // v1.201.0 — the second door: called once, from the scale door's result and the pool fullWh came from, after
  // the scale's log block and before the first await; logged on a live leg only; passed as an input once.
  const CALL_B = '  const cushionStandbyW = cushionStandbyOverheadW(cushionPoolScale, fullWh > 0);\n';
  assert.equal(count(plan, CALL_B), 1);
  assert.equal(count(plan, 'cushionStandbyOverheadW('), 1);
  assert.ok(plan.indexOf(CALL) < plan.indexOf(CALL_B) && plan.indexOf(CALL_B) < plan.indexOf('await '), 'beside the scale, before the first await');
  assert.ok(plan.indexOf('  const fullKwh = fullWh / 1000;\n') < plan.indexOf(CALL_B));
  assert.ok(plan.includes(`      app.log.info(cushionScaleLogText(cushionPoolScale));\n    }\n  }\n${'  // '}`), 'the scale\'s log block closes before the second door');
  // Logged on change of the figure or the Core count it names (one key), a shadow leg never.
  const LOG_B = "  const cushionStandbyLogKey = `${cushionStandbyW}:${cushionPoolScale?.connectedCores ?? 0}`;\n"
    + '  if (!shadowLeg && cushionStandbyLogKey !== lastLoggedCushionStandbyKey) {\n';
  assert.ok(plan.includes(`${CALL_B}${LOG_B}`), 'a shadow leg never logs the standby');
  const PASS_B = "    // v1.201.0 — the Cores' standby draw the islanded-outage cushion counts (W; the runway's figure). v1.202.0 — and the walks drain.\n    cushionStandbyW,\n";
  assert.equal(count(plan, PASS_B), 1, 'passed as the input');
  assert.equal(count(plan, '\n    cushionStandbyW,\n'), 1, 'one deps line');

  // ── (a) + (d) the planner, the JIT force-charge, the reserve actuator, the MPC: no forbidden token —
  // the planner's body with EXACTLY the one pinned call line removed first, the others with none.
  for (const name of ['recomputeNightChargePlan', 'runForceChargeTick', 'runNightActuationTickInner']) {
    const body = name === 'recomputeNightChargePlan' ? plan.replace(CALL, '').replace(CALL_B, '') : fnBody(name);
    assert.ok(body.includes('backupFullCapWh'), `${name} must read the panel's own pool capacity`);
    assert.ok(!forbidden.test(body), `${name} reads ${body.match(forbidden)?.[0]}`);
    if (name !== 'recomputeNightChargePlan') {
      assert.ok(!SCALE.test(body), `${name} takes the cushion scale (${body.match(SCALE)?.[0]})`);
      assert.ok(!STANDBY.test(body) && !/\bcushionStandbyW\b/.test(body), `${name} takes the cushion standby (${body.match(STANDBY)?.[0]})`);
    }
  }
  const recommend = index.slice(index.indexOf("app.get('/api/dispatch/recommend'"), index.indexOf("app.get('/api/backtest/forecast'"));
  assert.ok(recommend.length > 100 && !forbidden.test(recommend), `MPC reads ${recommend.match(forbidden)?.[0]}`);
  assert.ok(!SCALE.test(recommend), `MPC takes the cushion scale (${recommend.match(SCALE)?.[0]})`);
  assert.ok(!STANDBY.test(recommend), `MPC takes the cushion standby (${recommend.match(STANDBY)?.[0]})`);

  // ── (c) NO LAUNDERING through a helper. The token check above reads only the consumer's own text,
  // so a helper holding the tokens would pass it. Every top-level function of index.ts the consumers
  // reach, by name, at any depth, must hold no forbidden token — except the two allowlisted pairs
  // (recomputeNightChargePlan → measuredCushionScale, and v1.201.0 recomputeNightChargePlan →
  // cushionStandbyOverheadW), which are not descended into.
  assert.ok(tops.size >= 85, `${tops.size} top-level functions: the walk must see the module`);
  for (const n of ['recomputeNightChargePlan', 'runForceChargeTick', 'runNightActuationTickInner', 'measuredCushionScale', 'cushionStandbyOverheadW', 'reconnectObsDevices']) {
    assert.ok(tops.has(n), `the walk sees ${n}`);
  }
  const tainted = [...tops].filter(([, b]) => forbidden.test(b)).map(([n]) => n);
  assert.ok(tainted.includes('reconnectObsDevices') && tainted.includes('measuredCushionScale') && tainted.includes('cushionStandbyOverheadW'), `the walk sees a tainted function (${tainted.join(', ')})`);
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
      if (from === 'recomputeNightChargePlan' && (n === 'measuredCushionScale' || n === 'cushionStandbyOverheadW')) continue; // THE doors
      const b = tops.get(n)!;
      assert.ok(!forbidden.test(b), `${root} reaches ${n} (from ${from}), which reads ${b.match(forbidden)?.[0]}`);
      assert.ok(!SCALE.test(b), `${root} reaches ${n} (from ${from}), which takes the cushion scale (${b.match(SCALE)?.[0]})`);
      assert.ok(!STANDBY.test(b), `${root} reaches ${n} (from ${from}), which takes the cushion standby (${b.match(STANDBY)?.[0]})`);
      for (const m of refs(b, n)) queue.push([n, m]);
    }
    if (root !== 'recomputeNightChargePlan') {
      assert.ok(!seen.has('measuredCushionScale'), `${root} reaches the door`);
      assert.ok(!seen.has('cushionStandbyOverheadW'), `${root} reaches the second door`);
    }
  }

  // v1.202.0 (F5) — the planning pool is counted in the planner alone: index.ts never re-derives it, and the mid-day
  // shadow's held-import walk reads the pool and the standby the plan's own walks counted (NightChargePlan.planPool).
  assert.equal(count(index, 'plannerPoolKwh('), 0, 'index.ts counts no pool of its own');
  assert.ok(!/import [^;]*\bplannerPoolKwh\b/.test(index), 'nor imports the helper');
  assert.equal(count(index, 'fullKwh: plan.planPool?.kwh ?? fullKwh, standbyW: plan.planPool?.standbyW ?? 0,'), 1, "the shadow's held import on the plan's pool");
  assert.deepEqual(index.split('\n').map((l) => l.trim()).filter((l) => /\bplanPool/.test(l) && !/^(\/\/|\*)/.test(l)), [
    'planPoolLedgerColumns,',
    'floorPct: plan.reserveFloorPct, fullKwh: plan.planPool?.kwh ?? fullKwh, standbyW: plan.planPool?.standbyW ?? 0, dischargeEff, legEff,',
    '...planPoolLedgerColumns(plan, extras.fullKwh),',
  ], 'read there alone, and written to the row by its ledger helper');

  // ── (e) THE ADVISOR: nothing of the runway's basis; the scale read once, into the one line ────────
  // v1.201.0 — nor the runway's overhead rule, its options or its marginal efficiency, comments included: the
  // advisor names the runway's options in words only, and takes the figure as one number (cushionStandbyW).
  const advisor = src('nightChargeAdvisor.ts');
  const RUNWAY_IN_ADVISOR = /poolEnergyBasis|runwayDrainW|runwayEnergyBasis|RUNWAY_CORE_OVERHEAD_W|runwayPoolOverheadW|RUNWAY_POOL_OVERHEAD_FLOOR_W|RUNWAY_DRAIN_MARGINAL_EFFICIENCY|runwayPoolOverheadFloorW|runwayCoreOverheadW|runwayDrainMarginalEfficiency|\boverheadW\b/;
  assert.ok(!RUNWAY_IN_ADVISOR.test(advisor), `nightChargeAdvisor.ts must not read the runway basis (${advisor.match(RUNWAY_IN_ADVISOR)?.[0]})`);
  // Its imports are the ones it had: no module reaches the planner that is not named here. Every module
  // specifier in the file counts — a static import, a re-export, a dynamic import(), wherever it sits.
  const advisorImports = [...new Set([...advisor.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(advisorImports, ['./chargeTaper.js', './chargeWindows.js', './nightChargeActuator.js', './nightForceCharge.js', './physics/chargeLeg.js', './siteTime.js']);
  const sizing = advisor.slice(advisor.indexOf('function sizeNightChargePlan('), advisor.indexOf('\nexport const MIDDAY_REENTRY_MARGIN_PCT'));
  assert.ok(sizing.length > 20_000, `sizeNightChargePlan: ${sizing.length} chars`);
  // v1.202.0 — THE SEAM: the scale is read ONCE, at the top of the sizing, into the planning pool (plannerPoolKwh), after
  // the last refusal and before the first walk; every walk follows from `fullKwh`, and the line is plain reserve + cushion
  // on that pool (the scale the line is handed is the pool's lineScale: null where the pool carries it).
  const SEAM = '  const pool = plannerPoolKwh(panelFullKwh, inputs.cushionPoolScale);\n  const fullKwh = pool.kwh;\n';
  assert.equal(count(sizing, SEAM), 1, 'the scale is read once, into the one planning pool');
  assert.ok(sizing.lastIndexOf('return refuse(') < sizing.indexOf(SEAM), 'after the last refusal (the capacity gate reads the panel figure)');
  assert.ok(sizing.indexOf(SEAM) < sizing.indexOf('simulate('), 'before the first walk');
  assert.equal(count(sizing, 'inputs.cushionPoolScale'), 1);
  assert.equal(count(sizing, 'const fullKwh ='), 1, 'one planning pool');
  assert.equal(count(advisor, 'plannerPoolKwh('), 2, 'defined, and called once');
  // The panel's own figure, by name: the destructure, the capacity gate, the seam, the plan's record, the cost room, the
  // de-bias bound and the tick's mirror — no walk.
  const panelUses = [...sizing.matchAll(/^.*\bpanelFullKwh\b.*$/gm)].map((m) => m[0].trim()).filter((l) => !/^(\/\/|\*)/.test(l));
  assert.deepEqual(panelUses, [
    'nowMs, fullKwh: panelFullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,',
    "if (!Number.isFinite(panelFullKwh) || panelFullKwh <= 0) return refuse('pool capacity unavailable', true);",
    'const pool = plannerPoolKwh(panelFullKwh, inputs.cushionPoolScale);',
    'const planPoolField: { planPool?: { kwh: number; standbyW: number } } = fullKwh !== panelFullKwh || walkStandbyW > 0',
    'const costRoomScale = fullKwh / panelFullKwh;',
    'fullKwh: panelFullKwh,',
    'forceChargeLine, lineForceChargeEligible: inputs.lineForceChargeEligible === true, noReOn: lineNoReOn != null, runOn: lineRunOn, tickPoolKwh: panelFullKwh,',
  ]);
  const LINE = '  const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh, cushionBasis, poolScale: pool.lineScale });\n  const targetFloorKwh = cushionLine.kwh;\n';
  assert.equal(count(sizing, LINE), 1, 'one line every reader below reads, on the planning pool');
  assert.equal(count(sizing, 'targetFloorKwh ='), 1, 'no second line');
  assert.ok(!sizing.includes('reserveKwh + cushionKwh'), 'no parallel line');
  assert.equal(count(advisor, 'cushionLineKwh('), 2, 'defined, and called once');
  // Every use of the line object: its kWh once (above), its applied scale only in the plan's scale (beside the pool's)
  // — which the two plan fields and the rationale's clause read.
  const uses = [...sizing.matchAll(/^.*\bcushionLine\b.*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(uses, [
    'const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh, cushionBasis, poolScale: pool.lineScale });',
    'const targetFloorKwh = cushionLine.kwh;',
    'const planScale = pool.applied ?? cushionLine.applied;',
  ]);
  assert.equal(count(advisor, 'cushionLine.'), count(sizing, 'cushionLine.'), 'nowhere outside the sizing');
  const planScaleUses = [...sizing.matchAll(/^.*\bplanScale\b.*$/gm)].map((m) => m[0].trim()).filter((l) => !/^(\/\/|\*)/.test(l));
  assert.deepEqual(planScaleUses, [
    'const planScale = pool.applied ?? cushionLine.applied;',
    'const measuredCushionNote = planScale != null && planScale.scale < 1',
    // v1.203.0 — the capacity floor a cushion-only plan counts its pool on, named as what it is (no measurement).
    "? planScale.basis === 'floor'",
    '? `, ${round1(((targetFloorKwh - reserveKwh) / fullKwh) * 100)}% of the pool counted on the capacity floor, ×${planScale.scale.toFixed(3)} of nameplate`',
    ": `, ${round1(((targetFloorKwh - reserveKwh) / fullKwh) * 100)}% of the packs' measured capacity at ×${planScale.scale.toFixed(3)} of nameplate`",
    '...(planScale != null ? { cushionPoolScale: planScale } : {}),',
    '...(planScale != null ? { cushionPoolScale: planScale } : {}),',
  ]);
  // v1.201.0 — the standby: read ONCE (plausibleStandbyW, the validated figure every later reader takes), turned
  // into the cushion's energy once, and added to the load leg once — before the one line, which divides the
  // whole cushion by the scale.
  const STANDBY_LINES = [
    '  const standbyW = plausibleStandbyW(inputs.cushionStandbyW);',
    '  const standby = cushionStandbyKwh({ cushionBasis: cushion.basis, outageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS, standby: standbyW });',
    "  const cushionKwh = standby?.basis === 'runway-overhead' ? round2(cushion.kwh + standby.kwh) : cushion.kwh;",
    '  const cushionBasis = cushion.basis;',
    '',
  ].join('\n');
  assert.equal(count(sizing, STANDBY_LINES), 1, 'the standby read once, added once, into the one cushion');
  assert.ok(sizing.indexOf(STANDBY_LINES) < sizing.indexOf(LINE), 'before the line divides the cushion by the scale');
  assert.equal(count(sizing, 'inputs.cushionStandbyW'), 1);
  assert.equal(count(sizing, 'const cushionKwh ='), 1, 'one cushion');
  assert.equal(count(advisor, 'plausibleStandbyW('), 2, 'THE ONE READ: defined, and called once');
  assert.equal(count(advisor, 'cushionStandbyKwh('), 2, 'defined, and called once');
  // Every code use of the validated figure and its energy in the sizing (comment lines aside): the three lines,
  // the rationale's clause, and the two plan spreads.
  const isCode = (l: string): boolean => !/^(\/\/|\*|\/\*)/.test(l);
  const standbyUses = [...sizing.matchAll(/^.*\b(?:standby|standbyW)\b.*$/gm)].map((m) => m[0].trim()).filter(isCode);
  assert.deepEqual(standbyUses, [
    'const standbyW = plausibleStandbyW(inputs.cushionStandbyW);',
    'const standby = cushionStandbyKwh({ cushionBasis: cushion.basis, outageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS, standby: standbyW });',
    "const cushionKwh = standby?.basis === 'runway-overhead' ? round2(cushion.kwh + standby.kwh) : cushion.kwh;",
    // v1.202.0 — the walks' standby: the same validated figure, 0 W with none; the plan's record of it.
    'const walkStandbyW = standbyW?.w ?? 0;',
    'const planPoolField: { planPool?: { kwh: number; standbyW: number } } = fullKwh !== panelFullKwh || walkStandbyW > 0',
    '? { planPool: { kwh: Math.round(fullKwh * 1000) / 1000, standbyW: walkStandbyW } } : {};',
    'standbyW: walkStandbyW,', // the expected carry
    "const standbyNote = standby != null && standby.basis === 'runway-overhead' && standby.w > 0",
    "? `, ${round1(standby.kwh)} kWh of it the runway's ${Math.round(standby.w)} W standby figure`",
    '...(standby != null ? { cushionStandby: standby } : {}),',
    "const standbyCounted = standby?.basis === 'runway-overhead' && standby.kwh > 0;",
    'window: { hours: horizon, fromMs: effChargeStartMs, windowEndMs: windowEnd, dischargeEff, chargeCapKw, envelopeKw, acceptKw, standbyW: walkStandbyW },', // the expected walks
    // v1.203.0 — a cushion-only plan's expected basis: the median load (and the Cores' standby), no solar credited.
    '? `${walkStandbyW > 0 ? "median load and the Cores\' standby" : \'median load\'}, no solar credited`',
    ': walkStandbyW > 0 ? "median load, PV and the Cores\' standby" : \'median load and PV\'}, never below the ${round1(reserveFloorPct)}% reserve)`}${expectedWriteNote(expectedStartSocPct, expected.levelPct)}.`',
    '...(standby != null ? { cushionStandby: standby } : {}),',
  ]);
  // v1.201.0 (review) — the one sizing use of the gate: an unmeetable line is sized at the window's full effort
  // where the standby is counted (I-B2 across the pool's 100%); the legacy proxy otherwise.
  assert.equal(count(sizing, 'standbyCounted'), 2, 'defined, and read once');
  // v1.202.0 — extended to the walks' standby: where the walks drain a figure above 0 W, the window's full effort too.
  assert.equal(count(sizing, '    requiredExtraKwh = standbyCounted || walkStandbyW > 0 ? hiLift : poolHeadroomLiftKwh;\n'), 1);
  assert.equal(count(advisor, 'walkStandbyW'), count(sizing, 'walkStandbyW'), 'the walks\' standby lives in the sizing alone');

  // ── (f) EVERY place the scale may appear, across src (code lines; comment lines aside) ───────────
  // Every spelling (SCALE): the plan's field, the ledger helper that returns it and the ledger's
  // columns — a ledger-row read or a helper call is the scale as much as the field is. A comment line
  // is one that starts a comment and carries no code after a closing `*/`.
  const ALLOWED = new Map<string, string[]>([
    ['nightChargeAdvisor.ts', [ // in file order
      'cushionPoolScale?: CushionPoolScale | null;', // NightChargeInputs
      "cushionPoolScale?: { scale: number; basis: CushionScaleBasis | 'implausible' };", // NightChargePlan
      'const pool = plannerPoolKwh(panelFullKwh, inputs.cushionPoolScale);', // v1.202.0 — THE SEAM: the one read
      '...(planScale != null ? { cushionPoolScale: planScale } : {}),', // the hold plan
      '...(planScale != null ? { cushionPoolScale: planScale } : {}),', // the charge plan
      'cushionPoolScale?: CushionPoolScale | null;', // NightChargeInputDeps
      'cushionPoolScale,', // buildNightChargeInputs' destructure
      // v1.203.0 — a cushion-only plan with no ratio known passes the capacity floor in the scale's place (buildNightChargeInputs).
      'const coPoolFloor = cushionOnly != null && !ratioKnown(cushionPoolScale) && floorOk ? cushionOnlyFloorScale! : null;',
      'const coPoolMissing = cushionOnly != null && !ratioKnown(cushionPoolScale) && !floorOk;',
      "const planPoolScale: CushionPoolScale | null | undefined = coPoolFloor != null ? { scale: coPoolFloor, basis: 'floor' } : cushionPoolScale;",
      '...(planPoolScale !== undefined ? { cushionPoolScale: planPoolScale } : {}),', // and its pass-through
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
      // v1.201.0 — the second door's call reads the first door's result (its Core count), and so does its log.
      'const cushionStandbyW = cushionStandbyOverheadW(cushionPoolScale, fullWh > 0);',
      'const cushionStandbyLogKey = `${cushionStandbyW}:${cushionPoolScale?.connectedCores ?? 0}`;',
      'app.log.info(cushionStandbyLogText(cushionStandbyW, cushionPoolScale?.connectedCores ?? 0));',
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
  // v1.201.0 — the same inventory for the standby (STANDBY): every code line, in file order.
  const ALLOWED_STANDBY = new Map<string, string[]>([
    ['nightChargeAdvisor.ts', [
      'cushionStandbyW?: number | null;', // NightChargeInputs
      'cushionStandby?: CushionStandby;', // NightChargePlan
      'const standbyW = plausibleStandbyW(inputs.cushionStandbyW);', // THE ONE READ
      'const standby = cushionStandbyKwh({ cushionBasis: cushion.basis, outageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS, standby: standbyW });',
      '...(standby != null ? { cushionStandby: standby } : {}),', // the hold plan
      '...(standby != null ? { cushionStandby: standby } : {}),', // the charge plan
      'cushionStandbyW?: number | null;', // NightChargeInputDeps
      'cushionStandbyW,', // buildNightChargeInputs' destructure
      '...(cushionStandbyW !== undefined ? { cushionStandbyW } : {}),', // and its pass-through
      'export function cushionStandbyKwh(o: {', // the energy over the cushion's hours
      'export function cushionStandbyLedgerColumns(', // the ledger helper: the plan's standby, to the row
      "plan: Pick<NightChargePlan, 'cushionStandby'>,",
      '): { cushion_standby_w: number | null; cushion_standby_basis: string | null; cushion_standby_kwh: number | null } {',
      'cushion_standby_w: plan.cushionStandby?.w ?? null,',
      'cushion_standby_basis: plan.cushionStandby?.basis ?? null,',
      'cushion_standby_kwh: plan.cushionStandby?.kwh ?? null,',
      'export function cushionStandbyLogText(w: number, connectedCores: number): string {', // the log line
    ]],
    ['index.ts', [
      'cushionStandbyLedgerColumns, cushionStandbyLogText,', // the import
      'function cushionStandbyOverheadW(poolScale: { connectedCores: number } | null, poolReported: boolean): number {', // THE second door
      'const cushionStandbyW = cushionStandbyOverheadW(cushionPoolScale, fullWh > 0);',
      'const cushionStandbyLogKey = `${cushionStandbyW}:${cushionPoolScale?.connectedCores ?? 0}`;',
      'if (!shadowLeg && cushionStandbyLogKey !== lastLoggedCushionStandbyKey) {',
      'lastLoggedCushionStandbyKey = cushionStandbyLogKey;',
      'app.log.info(cushionStandbyLogText(cushionStandbyW, cushionPoolScale?.connectedCores ?? 0));',
      'cushionStandbyW,', // deps
      '...cushionStandbyLedgerColumns(plan),', // recordNightPlanRow: written, never read back
    ]],
    ['recorder.ts', [
      'cushion_standby_w: number | null;',
      'cushion_standby_basis: string | null;',
      'cushion_standby_kwh: number | null;',
      "'cushion_standby_w', 'cushion_standby_basis', 'cushion_standby_kwh',",
      "'cushion_standby_w REAL', 'cushion_standby_basis TEXT', 'cushion_standby_kwh REAL',",
    ]],
  ]);
  for (const f of files) {
    const code = src(f).split('\n').map((l) => l.trim()).filter((l) => STANDBY.test(l) && !isComment(l));
    assert.deepEqual(code, ALLOWED_STANDBY.get(f) ?? [], `${f}: the cushion standby appears where no pin allows it`);
  }

  // ── (g) NO LAUNDERING through another module ───────────────────────────────────────────────────
  // The runway's basis module is imported where it was, and by index.ts only for its two trackers'
  // constructor and path; no other module constructs a tracker or computes a scale.
  const importers = files.filter((f) => /from '(?:\.\.?\/)+poolEnergyBasis(?:\.js)?'|import\(\s*'(?:\.\.?\/)+poolEnergyBasis/.test(src(f))).sort();
  assert.deepEqual(importers, ['alertMonitor.ts', 'analytics.ts', 'index.ts', 'panelRunway.ts']);
  assert.deepEqual([...index.matchAll(/^import [^;]*? from '\.\/poolEnergyBasis\.js';$/gm)].map((m) => m[0]),
    ["import { PoolEnergyBasisTracker, defaultPoolEnergyBasisPath, CAPACITY_SCALE_MIN } from './poolEnergyBasis.js';"]);
  const constructs = Object.fromEntries(files.map((f): [string, number] => [f, count(src(f), 'new PoolEnergyBasisTracker(')]).filter(([, n]) => n > 0));
  assert.deepEqual(constructs, { 'analytics.ts': 1, 'index.ts': 2 });
  for (const fn of ['candidatePoolScale(', 'coreCapacityRatio(']) {
    const callers = files.filter((f) => f !== 'poolEnergyBasis.ts' && src(f).includes(fn));
    assert.deepEqual(callers, [], `${fn} is called outside poolEnergyBasis.ts`);
  }
  // v1.201.0 — the runway's overhead rule is called where the runway computes it and by the second door only.
  assert.deepEqual(files.filter((f) => src(f).includes('runwayPoolOverheadW(')).sort(), ['analytics.ts', 'index.ts']);
  // v1.201.0 (review) — and the overhead options are read where they are defined and by the runway only, in either
  // spelling: the limits.ts getters by analytics.ts (its constants), the option names by config.ts (the rows),
  // limits.ts (the getters) and analytics.ts. No other module reaches the options around the two doors.
  assert.deepEqual(files.filter((f) => /\b(runwayPoolOverheadFloorW|runwayCoreOverheadW|runwayDrainMarginalEfficiency)\b/.test(src(f))).sort(),
    ['analytics.ts', 'limits.ts'], "the overhead options' getters");
  assert.deepEqual(files.filter((f) => /\b(RUNWAY_POOL_OVERHEAD_FLOOR_W|RUNWAY_CORE_OVERHEAD_W|RUNWAY_DRAIN_MARGINAL_EFFICIENCY)\b/.test(src(f))).sort(),
    ['analytics.ts', 'config.ts', 'limits.ts'], "the overhead options' names");

  for (const f of ['nightForceCharge.ts', 'nightChargeActuator.ts', 'dispatch/mpc.ts']) {
    const s = src(f);
    assert.ok(!/poolEnergyBasis|runwayDrainW|runwayEnergyBasis|RUNWAY_CORE_OVERHEAD_W|RUNWAY_DRAIN_MARGINAL_EFFICIENCY|runwayPoolOverheadFloorW|runwayCoreOverheadW|runwayDrainMarginalEfficiency/.test(s), `${f} must not read the runway basis`);
    assert.ok(!SCALE.test(s) && !/cushionLineKwh|plannerPoolKwh|defaultPoolEnergyBasisPath|pool-energy-basis/.test(s), `${f} must not read the cushion scale`);
    assert.ok(!STANDBY.test(s) && !/runwayPoolOverheadW|cushionStandbyOverheadW|plausibleStandbyW|RUNWAY_POOL_OVERHEAD_FLOOR_W/.test(s), `${f} must not read the cushion standby`);
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
