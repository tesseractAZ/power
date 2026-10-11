#!/usr/bin/env node
/**
 * mutate-v1187-18f.mjs — v1.187.18: nothing assumes the fleet's shape.
 *
 *   F-i     the probabilistic band ignores the forecast's own pool (poolFullWh)
 *   F-ii    the last-resort estimate counts every DPU again, bench Cores included
 *   F-iii   the production forecast stops carrying the SHP2 pool
 *   F-iv    the optimizer's pool basis accepts a missing SoC
 *   F-v     the optimizer's pool basis accepts a missing capacity
 *   F-vi    /api/dispatch/recommend substitutes a 60 kWh pool again
 *   F-vii   an unknown pack count becomes five tiles
 *   F-viii  the Core's own pack count (bpNum) is ignored
 *   F-ix    an out-of-range pack count is trusted
 *   F-x     the DPU card falls back to five tiles
 *   F-xi    pack tiles match packs by array index, not number
 *
 *   node scripts/mutate-v1187-18f.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const MPC = resolve(REPO, 'server/src/dispatch/mpc.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const CARD_TEXT = resolve(REPO, 'web/src/cards/cardText.ts');
const DPU_CARD = resolve(REPO, 'web/src/cards/DpuCard.tsx');
const SUBSET = ['test/fleetShape.test.ts', 'test/forecast.test.ts', 'test/displayPvContract.test.ts'];

const MUTANTS = [
  {
    id: 'F-i. ★★ the probabilistic band ignores the forecast\'s own pool',
    file: ANALYTICS,
    find: '    forecast.poolFullWh != null && forecast.poolFullWh > 0 ? forecast.poolFullWh / 1000 : null;',
    to: '    null; /* MUTANT */',
    why: 'A day pinned at full falls back to a guessed fleet size.',
  },
  {
    id: 'F-ii. ★★ the last-resort estimate counts every DPU again',
    file: ANALYTICS,
    find: '    const homeCores = Math.max(1, forecast.solarModelSns?.length ?? forecast.deviceModels.length);',
    to: '    const homeCores = Math.max(1, forecast.deviceModels.length);',
    why: 'Bench Cores inflate the pool to 153.6 kWh and shrink the SoC band.',
  },
  {
    id: 'F-iii. ★★ the production forecast stops carrying the SHP2 pool',
    file: ANALYTICS,
    find: '    poolFullWh: fullWh,\n',
    to: '    poolFullWh: null,\n',
    why: 'The band is guessed again on every real forecast.',
  },
  {
    id: 'F-iv. ★★★ the optimizer\'s pool basis accepts a missing SoC',
    file: MPC,
    find: '  if (soc == null || !Number.isFinite(soc) || soc < 0 || soc > 100) return null;',
    to: '  if (soc != null && (!Number.isFinite(soc) || soc < 0 || soc > 100)) return null;',
    why: 'A plan is built on an unknown state of charge.',
  },
  {
    id: 'F-v. ★★★ the optimizer\'s pool basis accepts a missing capacity',
    file: MPC,
    find: '  if (fullWh == null || !Number.isFinite(fullWh) || fullWh <= 0) return null;',
    to: '  if (fullWh != null && (!Number.isFinite(fullWh) || fullWh <= 0)) return null;',
    why: 'A plan is built on an unknown pool size.',
  },
  {
    id: 'F-vi. ★★ /api/dispatch/recommend substitutes a 60 kWh pool again',
    file: IDX,
    find: '    capacityKwh: pool.capacityKwh,',
    to: '    capacityKwh: (sp.backupFullCapWh ?? 60_000) / 1000,',
    why: 'An untrusted pool is planned as 60 kWh and served with a 200.',
  },
  {
    id: 'F-vii. ★★★ an unknown pack count becomes five tiles',
    file: CARD_TEXT,
    find: '  return nums.size > 0 ? [...nums].sort((a, b) => a - b) : null;',
    to: '  return nums.size > 0 ? [...nums].sort((a, b) => a - b) : [1, 2, 3, 4, 5];',
    why: 'A dark Core shows five packs whatever it holds.',
  },
  {
    id: 'F-viii. ★★ the Core\'s own pack count is ignored',
    file: CARD_TEXT,
    find: '  if (bp != null && Number.isInteger(bp) && bp >= 1 && bp <= DPU_MAX_PACKS) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A pack missing from the readings loses its tile.',
  },
  {
    id: 'F-ix. ★ an out-of-range pack count is trusted',
    file: CARD_TEXT,
    find: '  if (bp != null && Number.isInteger(bp) && bp >= 1 && bp <= DPU_MAX_PACKS) {',
    to: '  if (bp != null && Number.isInteger(bp) && bp >= 1) {',
    why: 'A corrupt count draws more tiles than a Core can hold.',
  },
  {
    id: 'F-x. ★★ the DPU card falls back to five tiles',
    file: DPU_CARD,
    find: '  const packSlots = dpuPackSlots(p);',
    to: '  const packSlots = dpuPackSlots(p) ?? [1, 2, 3, 4, 5];',
    why: 'The phantom fifth tile returns through the card.',
  },
  {
    id: 'F-xi. ★ pack tiles match packs by array index, not number',
    file: DPU_CARD,
    find: '              const pk = p?.packs.find((x) => x.num === num);',
    to: '              const pk = p?.packs[num - 1];',
    why: 'With a pack missing mid-list, readings shift onto the wrong tile.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-18f', mutants: MUTANTS, subset: SUBSET, root: REPO });
