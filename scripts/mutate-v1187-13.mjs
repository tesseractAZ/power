#!/usr/bin/env node
/**
 * mutate-v1187-13.mjs — v1.187.13: the APS R-EV off-peak holidays.
 *
 *   H-i    the APS model has no holidays again (holidays default [])
 *   H-ii   a fixed-date holiday on a weekend is not observed on the adjacent weekday
 *   H-iii  Christmas Eve / New Year's Eve are not off-peak
 *
 *   node scripts/mutate-v1187-13.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TF = resolve(REPO, 'server/src/tariff.ts');
const SUBSET = ['test/tariffHolidays.test.ts', 'test/tariffBillingSeason.test.ts'];

const MUTANTS = [
  {
    id: 'H-i. ★★★ the APS model has no holidays again',
    file: TF,
    find: '    holidays: rates.holidays ?? [...APS_OFF_PEAK_HOLIDAYS],',
    to: '    holidays: rates.holidays ?? [], /* MUTANT */',
    why: 'On an APS off-peak holiday the add-on prices 4-7 pm as on-peak and 11 pm-5 am as overnight: the night charge buys for an on-peak that does not exist and at a rate it is not billed.',
  },
  {
    id: 'H-ii. ★★ a weekend fixed-date holiday is not observed',
    file: TF,
    find: '    return dow === 6 ? t - DAY : dow === 0 ? t + DAY : t;',
    to: '    return t; /* MUTANT */',
    why: 'Independence Day on a Saturday leaves Friday Jul 3 priced with its on-peak hours.',
  },
  {
    id: "H-iii. ★★ Christmas Eve and New Year's Eve are not off-peak",
    file: TF,
    find: '    day(12, 24), day(12, 31),',
    to: '    /* MUTANT */',
    why: "A weekday Dec 24 or Dec 31 is priced with on-peak and overnight hours.",
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-13', mutants: MUTANTS, subset: SUBSET, root: REPO });
