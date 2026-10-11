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
 *
 *   node scripts/mutate-v1187-19.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const POOL = resolve(REPO, 'server/src/poolEnergyBasis.ts');
const PANEL = resolve(REPO, 'server/src/panelRunway.ts');
const SUBSET = [
  'test/poolEnergyBasis.test.ts',
  'test/runwayReplayBacktest.test.ts',
  'test/runwayBasisContracts.test.ts',
  'test/runwayPvBasisGuard.test.ts',
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
    find: '  return RUNWAY_CORE_OVERHEAD_W * Math.max(0, Math.floor(connectedCores));',
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-19', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true });
