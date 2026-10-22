#!/usr/bin/env node
/**
 * mutate-v1191-s9.mjs — v1.191.0 S9 (lane E): the plant limits bridged as add-on options.
 *
 * The defect class this guards is the one this repository has shipped three times: an option
 * declared, translated, exported and parsed, and then ignored by the one line that reads it (the
 * suite stays green because every test sets the value it reads). One mutant per key puts today's
 * literal back where the consumer reads the option; the tests that set the option must notice.
 *
 *   S9-ev-max      EV_MAX_LOAD_W set is ignored (analytics.ts, the per-charger ceiling)
 *   S9-ev-count    EV_CHARGER_COUNT set is ignored (evLoadByHour's default)
 *   S9-ev-sum      EV_CHARGER_COUNT ≥ 2 still combines overlapping sessions with MAX
 *   S9-ev-none     EV_CHARGER_COUNT 0 still scans the circuits
 *   S9-ev-plateau  EV_PLATEAU_MIN_W set is ignored
 *   S9-ev-mined    EV_CIRCUITS no longer restricts the mined scan
 *   S9-ev-live     EV_CIRCUITS no longer restricts the live-session scan
 *   S9-ev-leg      EV_CIRCUITS matches only a pair's first leg
 *   S9-kw-core     FORCE_CHARGE_KW_PER_CORE set is ignored (planner cap and live-rate bound)
 *   S9-kw-start    FORCE_CHARGE_KW_PER_CORE set is ignored by the fallback start rate (H2)
 *   S9-kw-slots    the fallback start rate is computed without the slot count (back to the fixed 10 kW)
 *   S9-floor       RUNWAY_POOL_OVERHEAD_FLOOR_W set is ignored
 *   S9-percore     RUNWAY_CORE_OVERHEAD_W set is ignored
 *   S9-reseed      BMS_RESEED_MIN_GAP_WH set is ignored (recorder.ts)
 *   S9-scale       CAPACITY_SCALE_MIN set is ignored
 *   S9-night-a/b   FORECAST_NIGHT_START_HOUR / _END_HOUR set is ignored
 *   S9-co2         GRID_CO2_INTENSITY_LB_PER_MWH set is ignored
 *   S9-wear        CYCLING_BASE_WEAR_USD_PER_KWH set is ignored (index.ts, the MPC cycling cost)
 *   S9-ev-index    index.ts parses EV_MAX_LOAD_W a second time again (the unclamped copy)
 *   S9-loads       OPPORTUNISTIC_LOADS set is ignored (the report keeps the built-in list)
 *   S9-loads-live  the live curtailment report keeps the built-in list
 *   S9-loads-cat   the OPPORTUNISTIC_LOADS parse drops the category (every load reads as other)
 *   S9-ladder      BATTERY_SOC_LADDER set is ignored
 *   S9-ladder-tier the ladder parse loses its tiers (every rung reads as critical)
 *   S9-bridge      a lane E key is no longer exported by the run script (the inert option)
 *   S9-s3-eff      a moved environment-only reader keeps a stale local default (RUNWAY_DISCHARGE_EFFICIENCY)
 *   S9-s3-drop     a moved environment-only reader keeps a stale local default (BATTERY_SOC_MAX_DROP_PCT)
 *   S9-s3-retain   the degradation window ignores RECORDER_RETENTION_DAYS (config.retentionDays)
 *   S9-s3-digest   alertMonitor's digest hour stops reading its row (NOTIFY_DIGEST_HOUR)
 *
 *   cd server && TSX_DISABLE_CACHE=1 MUTATE_CONCURRENCY=4 node ../scripts/mutate-v1191-s9.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const LIMITS = resolve(REPO, 'server/src/limits.ts');
const FORCE = resolve(REPO, 'server/src/nightForceCharge.ts');
const RECORDER = resolve(REPO, 'server/src/recorder.ts');
const POOL = resolve(REPO, 'server/src/poolEnergyBasis.ts');
const SOC = resolve(REPO, 'server/src/batterySocAlarm.ts');
const MONITOR = resolve(REPO, 'server/src/alertMonitor.ts');
const RUN = resolve(REPO, 'rootfs/etc/services.d/ecoflow-panel/run');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/limits.test.ts',
  'test/processEnvRatchet.test.ts',
  'test/evCharger.test.ts',
  'test/opportunisticLoads.test.ts',
  'test/socLadder.test.ts',
  'test/golden.test.ts',
  'test/recorderFloorGapInvariant.test.ts',
  'test/degradationWindow.test.ts',
  'test/optionsEnvBridge.test.ts',
  'test/evPredictorRebuild.test.ts',
  'test/poolEnergyBasis.test.ts',
  'test/nightForceCharge.test.ts',
];

const MUTANTS = [
  {
    id: 'S9-ev-max. ★★★ EV_MAX_LOAD_W set is ignored',
    file: ANALYTICS,
    find: 'const EV_MAX_LOAD_W = limits.evMaxLoadW;',
    to: 'const EV_MAX_LOAD_W = 11520; /* MUTANT */',
    why: 'A home with a 32 A charger is forecast at 11.5 kW per session: the overnight runway projects a drain the charger cannot draw.',
  },
  {
    id: 'S9-ev-count. ★★★ EV_CHARGER_COUNT set is ignored',
    file: ANALYTICS,
    find: 'const EV_CHARGER_COUNT = limits.evChargerCount;',
    to: 'const EV_CHARGER_COUNT = 1; /* MUTANT */',
    why: 'A two-charger home keeps the one-charger MAX: two cars charging at once are forecast as one, and the runway is optimistic by a whole charger.',
  },
  {
    id: 'S9-ev-sum. ★★★ EV_CHARGER_COUNT ≥ 2 still uses MAX',
    file: ANALYTICS,
    find: '  const sum = Number.isInteger(chargers) && chargers >= 2;',
    to: '  const sum = false; /* MUTANT */',
    why: 'The option is accepted and changes nothing: overlapping sessions on two chargers never add up.',
  },
  {
    id: 'S9-ev-none. ★★ EV_CHARGER_COUNT 0 still scans the circuits',
    file: ANALYTICS,
    find: '  return limits.evChargerCount !== 0 && evCircuitScanned(pc, circuits);',
    to: '  return evCircuitScanned(pc, circuits); /* MUTANT */',
    why: 'A home with no charger still has its largest sustained load (a pool heater, a welder) forecast as EV sessions.',
  },
  {
    id: 'S9-ev-plateau. ★★★ EV_PLATEAU_MIN_W set is ignored',
    file: ANALYTICS,
    find: 'const EV_PLATEAU_MIN_W = limits.evPlateauMinW;',
    to: 'const EV_PLATEAU_MIN_W = 6000; /* MUTANT */',
    why: 'A 5 kW charger is never detected: its sessions go unforecast, the largest load surprise an islanded runway can face.',
  },
  {
    id: 'S9-ev-mined. ★★ EV_CIRCUITS no longer restricts the mined scan',
    file: ANALYTICS,
    find: '      if (!evScanned(pc, circuits)) continue;\n      const pts = recorder.query(shp2.sn, `pair${pc.primaryCh}_w`, since, now);',
    to: '      const pts = recorder.query(shp2.sn, `pair${pc.primaryCh}_w`, since, now); /* MUTANT */',
    why: 'The air conditioner the owner excluded is mined as an EV again: phantom charging sessions lift the forecast load.',
  },
  {
    id: 'S9-ev-live. ★★ EV_CIRCUITS no longer restricts the live-session scan',
    file: ANALYTICS,
    find: '    if (!evScanned(pc, circuits)) continue;\n    const pts = recorder.query(shp2.sn, `pair${pc.primaryCh}_w`, nowMs - EV_LIVE_LOOKBACK_MS, nowMs) ?? [];',
    to: '    const pts = recorder.query(shp2.sn, `pair${pc.primaryCh}_w`, nowMs - EV_LIVE_LOOKBACK_MS, nowMs) ?? []; /* MUTANT */',
    why: 'An excluded circuit drawing above the plateau becomes a "live EV session" with hours of projected remaining draw.',
  },
  {
    id: 'S9-ev-leg. ★ EV_CIRCUITS matches only a pair\'s first leg',
    file: LIMITS,
    find: '  return circuits.has(pc.primaryCh) || (pc.secondaryCh != null && circuits.has(pc.secondaryCh));',
    to: '  return circuits.has(pc.primaryCh); /* MUTANT */',
    why: 'Listing the 240 V charger by its higher channel (as the panel app shows it) silently excludes the charger.',
  },
  {
    id: 'S9-kw-core. ★★★ FORCE_CHARGE_KW_PER_CORE set is ignored',
    file: FORCE,
    find: '  return limits.forceChargeKwPerCore ?? FORCE_CHARGE_PROVEN_KW_PER_SLOT;',
    to: '  return FORCE_CHARGE_PROVEN_KW_PER_SLOT; /* MUTANT */',
    why: 'A plant whose Cores take 3 kW each is planned and timed at 5.5: the just-in-time start comes too late and the night ends short of its target.',
  },
  {
    id: 'S9-kw-start. ★★ FORCE_CHARGE_KW_PER_CORE set is ignored by the fallback start rate',
    file: FORCE,
    find: '  const perCore = limits.forceChargeKwPerCore;',
    to: '  const perCore = null as number | null; /* MUTANT */',
    why: 'With no live house load the start is timed at the fixed 10 kW whatever the configured per-Core rate: late on a slow plant.',
  },
  {
    id: 'S9-kw-slots. ★★ the fallback start rate is computed without the slot count',
    file: FORCE,
    find: '    ? Math.max(FORCE_CHARGE_MIN_RATE_KW, rateKw) : planRateFallbackKw(slotCount);',
    to: '    ? Math.max(FORCE_CHARGE_MIN_RATE_KW, rateKw) : FORCE_CHARGE_PLAN_RATE_KW; /* MUTANT */',
    why: 'H2 is wired to nothing: the fallback ignores both the key and the connected Cores.',
  },
  {
    id: 'S9-floor. ★★★ RUNWAY_POOL_OVERHEAD_FLOOR_W set is ignored',
    file: ANALYTICS,
    find: 'export const RUNWAY_POOL_OVERHEAD_FLOOR_W = limits.runwayPoolOverheadFloorW;',
    to: 'export const RUNWAY_POOL_OVERHEAD_FLOOR_W = 270; /* MUTANT */',
    why: 'A one-Core home keeps the three-Core 270 W floor: its runway drains ~180 W too fast, every hour, forever.',
  },
  {
    id: 'S9-percore. ★★ RUNWAY_CORE_OVERHEAD_W set is ignored',
    file: ANALYTICS,
    find: 'export const RUNWAY_CORE_OVERHEAD_W = limits.runwayCoreOverheadW;',
    to: 'export const RUNWAY_CORE_OVERHEAD_W = 90; /* MUTANT */',
    why: 'A pool of four Cores with a measured 120 W each is under-drained by 120 W: a runway that counts down too slowly.',
  },
  {
    id: 'S9-reseed. ★★ BMS_RESEED_MIN_GAP_WH set is ignored',
    file: RECORDER,
    find: '  const RESEED_MIN_GAP_WH = limits.bmsReseedMinGapWh;',
    to: '  const RESEED_MIN_GAP_WH = 50_000; /* MUTANT */',
    why: 'A one-Core home (~29 kWh) can never reach the 50 kWh gap: a lifetime floor seeded against other batteries freezes HA Energy forever.',
  },
  {
    id: 'S9-scale. ★★★ CAPACITY_SCALE_MIN set is ignored',
    file: POOL,
    find: 'export const CAPACITY_SCALE_MIN = limits.capacityScaleMin;',
    to: 'export const CAPACITY_SCALE_MIN = 0.8; /* MUTANT */',
    why: 'An aged pool at 0.7 of nameplate is floored at 0.8: every kWh and hour of runway is overstated by ~14 %.',
  },
  {
    id: 'S9-night-a. ★★ FORECAST_NIGHT_START_HOUR set is ignored',
    file: ANALYTICS,
    find: 'const FORECAST_NIGHT_START_HOUR = limits.forecastNightStartHour;',
    to: 'const FORECAST_NIGHT_START_HOUR = 21; /* MUTANT */',
    why: 'The night trim runs into a site\'s evening peak: the forecast load is cut where it is real.',
  },
  {
    id: 'S9-night-b. ★★ FORECAST_NIGHT_END_HOUR set is ignored',
    file: ANALYTICS,
    find: 'const FORECAST_NIGHT_END_HOUR = limits.forecastNightEndHour;',
    to: 'const FORECAST_NIGHT_END_HOUR = 5; /* MUTANT */',
    why: 'The night band ends at 05:00 wherever the site\'s mornings start.',
  },
  {
    id: 'S9-co2. ★★ GRID_CO2_INTENSITY_LB_PER_MWH set is ignored',
    file: ANALYTICS,
    find: 'const DEFAULT_GRID_CO2_LB_PER_MWH = limits.gridCo2LbPerMwh;',
    to: 'const DEFAULT_GRID_CO2_LB_PER_MWH = 1100; /* MUTANT */',
    why: 'Every home reports the reference grid\'s carbon savings as its own.',
  },
  {
    id: 'S9-wear. ★★ CYCLING_BASE_WEAR_USD_PER_KWH set is ignored',
    file: IDX,
    find: '      const baseWear = limits.cyclingBaseWearUsdPerKwh;',
    to: '      const baseWear = 0.015; /* MUTANT */',
    why: 'The MPC prices every home\'s battery wear at the reference plant\'s figure: a costlier battery is cycled as if it were free.',
  },
  {
    id: 'S9-ev-index. ★★ index.ts parses EV_MAX_LOAD_W a second time again',
    file: IDX,
    find: '  const evMaxLoadW = limits.evMaxLoadW;',
    to: '  const evMaxLoadW = Number(process.env.EV_MAX_LOAD_W ?? 11520); /* MUTANT */',
    why: 'The planner and the forecast read the ceiling with different rules again (one clamped, one not); the ratchet is the gate that stops it.',
  },
  {
    id: 'S9-loads. ★★ OPPORTUNISTIC_LOADS set is ignored',
    file: ANALYTICS,
    find: '  limits.opportunisticLoads ?? DEFAULT_OPPORTUNISTIC_LOADS;',
    to: '  DEFAULT_OPPORTUNISTIC_LOADS; /* MUTANT */',
    why: 'A home with no pool is told to run its pool pump on high.',
  },
  {
    id: 'S9-loads-live. ★★ the live curtailment report keeps the built-in list',
    file: ANALYTICS,
    find: '  const opportunisticLoads: OpportunisticLoad[] = OPPORTUNISTIC_LOADS.map((o) => ({',
    to: '  const opportunisticLoads: OpportunisticLoad[] = DEFAULT_OPPORTUNISTIC_LOADS.map((o) => ({ /* MUTANT */',
    why: 'The configured loads show only while nothing is being curtailed — exactly when they are useless.',
  },
  {
    id: 'S9-loads-cat. ★★ the OPPORTUNISTIC_LOADS parse drops the category',
    file: LIMITS,
    find: '    const category: OpportunisticCategory = (OPPORTUNISTIC_CATEGORIES as readonly string[]).includes(catText)',
    to: '    const category: OpportunisticCategory = (false as boolean) && (OPPORTUNISTIC_CATEGORIES as readonly string[]).includes(catText) /* MUTANT */',
    why: 'Every configured load reads as "other": a future automation keyed on the category (the EV charger, the water heater) never matches.',
  },
  {
    id: 'S9-ladder. ★★★ BATTERY_SOC_LADDER set is ignored',
    file: SOC,
    find: 'export const BATTERY_SOC_THRESHOLDS: readonly SocThreshold[] = limits.batterySocLadder ?? DEFAULT_BATTERY_SOC_THRESHOLDS;',
    to: 'export const BATTERY_SOC_THRESHOLDS: readonly SocThreshold[] = DEFAULT_BATTERY_SOC_THRESHOLDS; /* MUTANT */',
    why: 'A home with a 30 % reserve keeps announcing 20 % and 15 % as if they were above the floor; its own rungs never sound.',
  },
  {
    id: 'S9-ladder-tier. ★★★ the ladder parse loses its tiers',
    file: LIMITS,
    find: '    out.push({ pct, priority });',
    to: "    out.push({ pct, priority: 'critical' }); /* MUTANT */",
    why: 'Every configured rung announces as critical: a 50 % low-priority notice wakes the house as an emergency.',
  },
  {
    id: 'S9-bridge. ★★★ a lane E key is no longer exported by the run script',
    file: RUN,
    find: 'if bashio::config.has_value \'CAPACITY_SCALE_MIN\'; then export CAPACITY_SCALE_MIN="$(bashio::config \'CAPACITY_SCALE_MIN\')"; fi\n',
    to: '# MUTANT\n',
    why: 'The option is shown, stored and saved, and the server never sees it: the inert option, shipped twice before the bridge test existed.',
  },
  {
    id: 'S9-s3-eff. ★★ a moved environment-only reader keeps a stale local default',
    file: ANALYTICS,
    find: 'export const RUNWAY_DISCHARGE_EFFICIENCY = limits.runwayDischargeEfficiency;',
    to: 'export const RUNWAY_DISCHARGE_EFFICIENCY = 0.94; /* MUTANT */',
    why: 'RUNWAY_DISCHARGE_EFFICIENCY set by hand stops taking effect after the move (golden G8 captured it taking effect).',
  },
  {
    id: 'S9-s3-drop. ★★ a moved environment-only reader keeps a stale local default (SoC slew guard)',
    file: SOC,
    find: 'const MAX_PLAUSIBLE_DROP_PCT = limits.batterySocMaxDropPct;',
    to: 'const MAX_PLAUSIBLE_DROP_PCT = 25; /* MUTANT */',
    why: 'BATTERY_SOC_MAX_DROP_PCT set by hand stops taking effect after the move (golden G8 captured it taking effect).',
  },
  {
    id: 'S9-s3-retain. ★★ the degradation window ignores RECORDER_RETENTION_DAYS',
    file: ANALYTICS,
    find: '  const windowDays = degradationWindowDays(config.retentionDays);',
    to: '  const windowDays = degradationWindowDays(30); /* MUTANT */',
    why: 'A year of retained samples still regresses pack SoH over 30 days: the v1.187.10 fix undone by the move.',
  },
  {
    id: 'S9-s3-digest. ★★ alertMonitor\'s digest hour stops reading its row',
    file: MONITOR,
    find: "  const DIGEST_HOUR = option<number>('NOTIFY_DIGEST_HOUR');",
    to: '  const DIGEST_HOUR = 7; /* MUTANT */',
    why: 'NOTIFY_DIGEST_HOUR is ignored: the morning digest arrives at 07:00 whatever the owner chose.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants; a kill must come from
// it, not from an unrelated full-suite failure under parallel load (a false kill).
await runMutantsParallel({ name: 'mutate-v1191-s9', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
