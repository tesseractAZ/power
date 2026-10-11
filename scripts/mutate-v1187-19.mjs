#!/usr/bin/env node
/**
 * mutate-v1187-19.mjs — v1.187.19: the runway on the packs' measured energy basis.
 *
 *   V-i      the runway drops the measured capacity scale (nameplate kWh again)
 *   V-ii     the day SoC trajectory drops the scale
 *   V-iii    the Cores' fixed overhead is removed
 *   V-iv     the max() guard is removed from the drain
 *   V-v      the scale may exceed nameplate (clamp ≤ 1 removed)
 *   V-vi     a Core not reporting falls back to nameplate instead of its held ratio
 *   V-vii    a never-measured Core takes nameplate although other ratios are known
 *   V-viii   membership from the online DPUs instead of the panel's connected sources
 *   V-ix     a source the panel lists as disconnected is counted
 *   V-x      an increase applies immediately (no 24 h hold)
 *   V-xi     the hold applies the latest figure, not the lowest seen while waiting
 *   V-xii    the band inverts the trajectory with the old drain
 *   V-xiii   the day trajectory drains without the overhead
 *   V-xiv    the multi-day trajectory drains without the overhead
 *   V-xv     the forecast stops carrying the overhead it was integrated with
 *   V-xvi    a secondary panel's drain runway ignores the scale
 *   V-xvii   a held ratio older than 30 days is still used
 *   V-xviii  an implausible pack (> 1.1 × design) is accepted
 *   V-xix    an offline Core's frozen packs count as a live measurement
 *   V-xx     a restart forgets the held ratios
 *   V-xxi    the 270 W pool floor is dropped (90 W × connected Cores only)
 *   V-xxii   the floor is never applied (the pool is never "reported")
 *   V-xxiii  a reading with no connected source falls to nameplate
 *   V-xxiv   the production (Supervisor) persistence path persists nothing
 *   V-xxv    a restart forgets the panels' applied scale and increase hold (load)
 *   V-xxvi   the panels' applied scale and hold are never written (save)
 *   V-xxvii  the increase hold is 9 h instead of 24 h
 *   V-xxviii a held ratio stays valid a year instead of 30 days
 *   V-xxix   the JIT force-charge sizes on the runway's measured capacity
 *   V-xxx    the reserve actuator reads the runway's measured capacity
 *   V-xxxi   the night-charge planner sizes on the runway's measured capacity
 *   V-xxxii  a secondary panel's runway is computed without its measured basis
 *   V-xxxiii a figure built on substitutes (a partial map) is recorded as the applied scale
 *   V-xxxiv  a figure built on substitutes may exceed the applied scale
 *   V-xxxv   the worker's basis reset wipes the measured basis
 *
 *   node scripts/mutate-v1187-19.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const POOL = resolve(REPO, 'server/src/poolEnergyBasis.ts');
const PANEL = resolve(REPO, 'server/src/panelRunway.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/poolEnergyBasis.test.ts',
  'test/runwayReplayBacktest.test.ts',
  'test/runwayBasisContracts.test.ts',
  'test/runwayPvBasisGuard.test.ts',
  'test/runwayDischargeEfficiency.test.ts',
];

const MUTANTS = [
  {
    id: 'V-i. ★★★ the runway drops the measured capacity scale',
    file: ANALYTICS,
    find: '  const backupRemainingKwh = (shp2.projection.backupRemainWh * basis.capacityScale) / 1000;\n  const backupFullKwh = (shp2.projection.backupFullCapWh * basis.capacityScale) / 1000;',
    to: '  const backupRemainingKwh = shp2.projection.backupRemainWh / 1000; /* MUTANT */\n  const backupFullKwh = shp2.projection.backupFullCapWh / 1000;',
    why: 'The runway counts nameplate kWh against a percent of the measured capacity: ~6 % long.',
  },
  {
    id: 'V-ii. ★★ the day SoC trajectory drops the scale',
    file: ANALYTICS,
    find: '  const fullWh = nameplateFullWh != null ? nameplateFullWh * poolBasis.capacityScale : null;\n  let socWh = nameplateRemainWh != null ? nameplateRemainWh * poolBasis.capacityScale : null;',
    to: '  const fullWh = nameplateFullWh; /* MUTANT */\n  let socWh = nameplateRemainWh;',
    why: 'projectedSocPct and the Projected Low SoC fall at the nameplate rate again.',
  },
  {
    id: 'V-iii. ★★★ the Cores\' fixed overhead is removed',
    file: ANALYTICS,
    find: '  return Math.max(poolReported ? RUNWAY_POOL_OVERHEAD_FLOOR_W : 0, RUNWAY_CORE_OVERHEAD_W * Math.max(0, Math.floor(connectedCores)));',
    to: '  return 0; /* MUTANT */',
    why: 'The ~270 W the Cores draw themselves never leaves the pool: the low-load nights read 10 % long.',
  },
  {
    id: 'V-iv. ★★★ the max() guard is removed from the drain',
    file: ANALYTICS,
    find: '  return Math.max(loadW / RUNWAY_DISCHARGE_EFFICIENCY, overheadW + loadW / etaM);',
    to: '  return overheadW + loadW / etaM; /* MUTANT */',
    why: 'A configured marginal η above 0.94 (or a negative overhead) lengthens the runway past the old one.',
  },
  {
    id: 'V-v. ★★ the scale may exceed nameplate',
    file: POOL,
    find: 'const clampScale = (x: number): number => Math.min(CAPACITY_SCALE_MAX, Math.max(CAPACITY_SCALE_MIN, x));',
    to: 'const clampScale = (x: number): number => Math.max(CAPACITY_SCALE_MIN, x); /* MUTANT */',
    why: 'Packs reading above design lengthen the runway beyond the panel\'s own nameplate.',
  },
  {
    id: 'V-vi. ★★★ a Core not reporting falls back to nameplate instead of its held ratio',
    file: POOL,
    find: "      perCore.push({ sn, ratio: h.ratio, basis: 'held', weight });",
    to: "      perCore.push({ sn, ratio: 1, basis: 'nameplate', weight }); /* MUTANT */",
    why: 'A cloud-offline Core silently returns the pool to the optimistic nameplate basis.',
  },
  {
    id: 'V-vii. ★★★ a never-measured Core takes nameplate although other ratios are known',
    file: POOL,
    find: "      if (minKnown != null) ratio = minKnown;\n      else { ratio = 1; b = 'nameplate'; }",
    to: "      { ratio = 1; b = 'nameplate'; } /* MUTANT */",
    why: 'Once measured data exists the basis must never return to nameplate.',
  },
  {
    id: 'V-viii. ★★★ membership from the online DPUs instead of the panel\'s connected sources',
    file: POOL,
    find: "  const connected = (panel.projection.sources ?? []).filter(\n    (s) => s?.isConnected === true && typeof s.sn === 'string' && s.sn.length > 0,\n  );",
    to: "  const connected = Object.values(devices).filter((d) => d.online === true && d.projection?.kind === 'dpu').map((d) => ({ sn: d.sn as string | null, isConnected: true, fullCap: 30_720 as number | null })); /* MUTANT */",
    why: 'Bench Cores with fresher packs inflate the pool\'s capacity.',
  },
  {
    id: 'V-ix. ★★ a source the panel lists as disconnected is counted',
    file: POOL,
    find: "    (s) => s?.isConnected === true && typeof s.sn === 'string' && s.sn.length > 0,",
    to: "    (s) => typeof s?.sn === 'string' && s.sn.length > 0, /* MUTANT */",
    why: 'An unplugged Core keeps weighing on the pool\'s scale.',
  },
  {
    id: 'V-x. ★★★ an increase applies immediately',
    file: POOL,
    find: '    if (!prev || cand.scale <= prev.scale) {',
    to: '    if (!prev || cand.scale <= prev.scale || prev.scale > 0) { /* MUTANT */',
    why: 'A BMS recalibration upward (or a better Core in a slot) lengthens the runway at once.',
  },
  {
    id: 'V-xi. ★★ the hold applies the latest figure, not the lowest seen while waiting',
    file: POOL,
    find: '      const pend = prev.pendingScale != null ? Math.min(prev.pendingScale, cand.scale) : cand.scale;',
    to: '      const pend = cand.scale; /* MUTANT */',
    why: 'A dip during the hold is forgotten when the increase lands.',
  },
  {
    id: 'V-xii. ★★★ the band inverts the trajectory with the old drain',
    file: ANALYTICS,
    find: '  const netKwh = (pvW: number, loadW: number): number => (pvW - runwayDrainW(loadW, bandOverheadW)) / 1000;',
    to: '  const netKwh = (pvW: number, loadW: number): number => (pvW - loadW / RUNWAY_DISCHARGE_EFFICIENCY) / 1000; /* MUTANT */',
    why: 'The inversion recovers a ~10 % smaller pool and the band widens for no reason.',
  },
  {
    id: 'V-xiii. ★★ the day trajectory drains without the overhead',
    file: ANALYTICS,
    find: 'socWh + (pvAlarm - runwayDrainW(load, poolBasis.overheadW))',
    to: 'socWh + (pvAlarm - load / RUNWAY_DISCHARGE_EFFICIENCY) /* MUTANT */',
    why: 'projectedSocPct falls slower than the runway it sits beside.',
  },
  {
    id: 'V-xiv. ★★ the multi-day trajectory drains without the overhead',
    file: ANALYTICS,
    find: 'socWh + (pv - runwayDrainW(load, poolBasis.overheadW))',
    to: 'socWh + (pv - load / RUNWAY_DISCHARGE_EFFICIENCY) /* MUTANT */',
    why: 'Day 0 of the multi-day view contradicts the day forecast.',
  },
  {
    id: 'V-xv. ★★ the forecast stops carrying the overhead it was integrated with',
    file: ANALYTICS,
    find: '    poolOverheadW: poolBasis.overheadW,',
    to: '    poolOverheadW: 0, /* MUTANT */',
    why: 'The band seeds and steps with a drain the trajectory did not use.',
  },
  {
    id: 'V-xvi. ★★ a secondary panel\'s drain runway ignores the scale',
    file: PANEL,
    find: '  const remainWh = remainWhPlate * scale;\n  const fullWh = fullWhPlate * scale;',
    to: '  const remainWh = remainWhPlate; /* MUTANT */\n  const fullWh = fullWhPlate;',
    why: 'A second panel\'s runway counts nameplate kWh.',
  },
  {
    id: 'V-xvii. ★★ a held ratio older than 30 days is still used',
    file: POOL,
    find: '    if (h && Number.isFinite(h.ratio) && h.ratio > 0 && nowMs - h.atMs <= maxHeldAgeMs) {',
    to: '    if (h && Number.isFinite(h.ratio) && h.ratio > 0) { /* MUTANT */',
    why: 'A months-old reading outranks the lowest one known.',
  },
  {
    id: 'V-xviii. ★★ an implausible pack (> 1.1 × design) is accepted',
    file: POOL,
    find: '    if (f <= 0 || dc <= 0 || f > PACK_FULL_CAP_MAX_OF_DESIGN * dc) return null;',
    to: '    if (f <= 0 || dc <= 0) return null; /* MUTANT */',
    why: 'A corrupt full-charge reading inflates the Core\'s ratio.',
  },
  {
    id: 'V-xix. ★★ an offline Core\'s frozen packs count as a live measurement',
    file: POOL,
    find: '  if (!d || d.online !== true) return null;',
    to: '  if (!d) return null; /* MUTANT */',
    why: 'A cloud-offline Core\'s last projection refreshes its held ratio\'s timestamp forever.',
  },
  {
    id: 'V-xx. ★★ a restart forgets the held ratios',
    file: POOL,
    find: '      if (!existsSync(this.path)) return;',
    to: '      if (!existsSync(this.path) || this.path.length > 0) return; /* MUTANT */',
    why: 'The first minutes after every restart run on nameplate while the Cores report in.',
  },
  {
    id: 'V-xxi. ★★★ the 270 W pool floor is dropped (90 W × connected Cores only)',
    file: ANALYTICS,
    find: '  return Math.max(poolReported ? RUNWAY_POOL_OVERHEAD_FLOOR_W : 0, RUNWAY_CORE_OVERHEAD_W * Math.max(0, Math.floor(connectedCores)));',
    to: '  return RUNWAY_CORE_OVERHEAD_W * Math.max(0, Math.floor(connectedCores)) + (poolReported ? 0 : 0); /* MUTANT */',
    why: 'A Core leaving sheds 90 W the remaining Cores still burn (most of the overhead sits on slot 3).',
  },
  {
    id: 'V-xxii. ★★★ the floor is never applied (the pool is never "reported")',
    file: ANALYTICS,
    find: '  const poolReported = panel != null && (panel.projection.backupFullCapWh ?? 0) > 0;',
    to: '  const poolReported = false; /* MUTANT */',
    why: 'A reading with no connected source drains at load/η alone while it reports min-known.',
  },
  {
    id: 'V-xxiii. ★★★ a reading with no connected source falls to nameplate',
    file: POOL,
    find: "      ? { scale: clampScale(minKnown), basis: 'min-known', connected: 0, live }",
    to: "      ? { scale: 1, basis: 'nameplate', connected: 0, live } /* MUTANT */",
    why: 'A partial /quota/all (no pd303_mc sources) returns the runway to nameplate kWh.',
  },
  {
    id: 'V-xxiv. ★★★ the production (Supervisor) persistence path persists nothing',
    file: POOL,
    find: "  return process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, '..', `${name}.json`) : null;",
    to: '  return null; /* MUTANT */',
    why: 'After a restart with a Core cloud-offline that Core has no held ratio: nameplate, ~6 % long.',
  },
  {
    id: 'V-xxv. ★★ a restart forgets the panels\' applied scale and increase hold (load)',
    file: POOL,
    find: '      for (const [sn, p] of Object.entries(raw?.panels ?? {})) {',
    to: '      for (const [sn, p] of Object.entries({} as Record<string, PanelHold>)) { /* MUTANT */',
    why: 'An increase waiting out its 24 h is applied at the first evaluation after a restart.',
  },
  {
    id: 'V-xxvi. ★★ the panels\' applied scale and hold are never written (save)',
    file: POOL,
    find: '    const out: PersistShape = { v: 1, cores: Object.fromEntries(this.cores), panels: Object.fromEntries(this.panels) };',
    to: '    const out: PersistShape = { v: 1, cores: Object.fromEntries(this.cores), panels: {} }; /* MUTANT */',
    why: 'Same as V-xxv, from the writing side.',
  },
  {
    id: 'V-xxvii. ★★ the increase hold is 9 h instead of 24 h',
    file: POOL,
    find: 'export const CAPACITY_INCREASE_HOLD_MS = 24 * 60 * 60 * 1000;',
    to: 'export const CAPACITY_INCREASE_HOLD_MS = 9 * 60 * 60 * 1000; /* MUTANT */',
    why: 'A brief upward BMS reading lengthens the runway after nine hours.',
  },
  {
    id: 'V-xxviii. ★★ a held ratio stays valid a year instead of 30 days',
    file: POOL,
    find: 'export const HELD_RATIO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;',
    to: 'export const HELD_RATIO_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; /* MUTANT */',
    why: 'A Core offline since an earlier, higher capacity regime keeps its old ratio.',
  },
  {
    id: 'V-xxix. ★★★ the JIT force-charge sizes on the runway\'s measured capacity',
    file: IDX,
    find: 'c.batteryPercentage : null]));\n  const fullWh: number | null = sp?.backupFullCapWh ?? null;',
    to: "c.batteryPercentage : null]));\n  const fullWh: number | null = sp?.backupFullCapWh != null ? sp.backupFullCapWh * (((await analytics.report('runway')) as { capacityScale?: number } | null)?.capacityScale ?? 1) : null; /* MUTANT */",
    why: 'Owner decision: the force-charge keeps the panel\'s own capacity.',
  },
  {
    id: 'V-xxx. ★★★ the reserve actuator reads the runway\'s measured capacity',
    file: IDX,
    find: '      ? shp2.projection\n      : null;\n  const fullWh: number | null = sp?.backupFullCapWh ?? null;',
    to: "      ? shp2.projection\n      : null;\n  const fullWh: number | null = sp?.backupFullCapWh != null ? sp.backupFullCapWh * (((await analytics.report('runway')) as { capacityScale?: number } | null)?.capacityScale ?? 1) : null; /* MUTANT */",
    why: 'Owner decision: the actuator keeps the panel\'s own capacity.',
  },
  {
    id: 'V-xxxi. ★★★ the night-charge planner sizes on the runway\'s measured capacity',
    file: IDX,
    find: '  const fullWh: number | null = sp.backupFullCapWh ?? null;',
    to: "  const fullWh: number | null = sp.backupFullCapWh != null ? sp.backupFullCapWh * (((await analytics.report('runway')) as { capacityScale?: number } | null)?.capacityScale ?? 1) : null; /* MUTANT */",
    why: 'Owner decision: the planner and its cushion keep the panel\'s own capacity.',
  },
  {
    id: 'V-xxxii. ★★ a secondary panel\'s runway is computed without its measured basis',
    file: IDX,
    find: '            const pr = panelDrainRunway(p, samples, nowMs, panelPoolBasisTracker.evaluate(devs, p, nowMs));',
    to: '            const pr = panelDrainRunway(p, samples, nowMs, panelPoolBasisTracker ? undefined : undefined); /* MUTANT */',
    why: 'A second panel\'s runway and alarm count nameplate kWh again.',
  },
  {
    id: 'V-xxxiii. ★★★ a figure built on substitutes (a partial map) is recorded as the applied scale',
    file: POOL,
    find: "    if (cand.basis !== 'measured') {",
    to: "    if (cand.basis !== 'measured' && cand.connected < 0) { /* MUTANT */",
    why: 'A boot map with one Core projected plants the lowest known ratio; the full map waits 24 h.',
  },
  {
    id: 'V-xxxiv. ★★★ a figure built on substitutes may exceed the applied scale',
    file: POOL,
    find: '        capacityScale: prev ? Math.min(prev.scale, cand.scale) : cand.scale,',
    to: '        capacityScale: cand.scale, /* MUTANT */',
    why: 'A cloud-offline Core\'s older, higher held ratio lengthens the runway past the measured one.',
  },
  {
    id: 'V-xxxv. ★★★ the worker\'s basis reset wipes the measured basis',
    file: ANALYTICS,
    find: '  multiDayCache = null;\n  bayesCache = null;\n}\n',
    to: '  multiDayCache = null;\n  bayesCache = null;\n  poolBasisTracker.reset(); /* MUTANT */\n}\n',
    why: 'Every boot-basis step forgets the held ratios: a Core still reporting in runs on the lowest known.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants; a kill must come from
// it, not from an unrelated full-suite failure under parallel load (a false kill).
await runMutantsParallel({ name: 'mutate-v1187-19', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
