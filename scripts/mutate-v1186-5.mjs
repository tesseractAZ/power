#!/usr/bin/env node
/**
 * mutate-v1186-5.mjs — committed harness for v1.186.5: the PV band calibration (forecast
 * skill + probabilistic band) is bound to the forecast it was scored against and never
 * built on a structurally incomplete one, and the evening night-charge job defers an
 * incomplete basis instead of latching "no plan" and cancelling a prior arm.
 *
 *   node scripts/mutate-v1186-5.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AN = resolve(SERVER, 'src/analytics.ts');
const NCA = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const IX = resolve(SERVER, 'src/index.ts');

const SUBSET = [
  'test/skillCacheForecastBound.test.ts',
  'test/realizedGhiStage2.test.ts',
  'test/nightPlanPanelFreshness.test.ts',
];

const MUTANTS = [
  {
    id: 'i. ★★★ the skill cache ignores which forecast it was scored on',
    file: AN,
    find: '      && (forecast == null || skillHit.forecastTs === forecast.generatedAt)) return skillHit.value;',
    to: '      /* MUTANT */) return skillHit.value;',
    why: 'A skill scored on a partial-map forecast is served for an hour; the 21:30 plan reads 7% coverage and cancels the night.',
  },
  {
    id: 'ii. ★★ the skill is scored on a structurally incomplete forecast',
    file: AN,
    find: '  if (forecast.structurallyIncomplete) return emptyVal();',
    to: '  /* MUTANT */',
    why: 'A start-up forecast fit on one Core scores every day at a third of actual.',
  },
  {
    id: 'iii. ★★ the band cache ignores which forecast it was built on',
    file: AN,
    find: '      && (forecast == null || probabilisticCache.forecastTs === forecast.generatedAt)) return probabilisticCache.value;',
    to: '      /* MUTANT */) return probabilisticCache.value;',
    why: 'The basis gate reads a band calibrated on an earlier forecast for 15 minutes.',
  },
  {
    id: 'iv. ★★ a band built on an incomplete forecast is cached',
    file: AN,
    find: '  if (!forecast.structurallyIncomplete) probabilisticCache = { ts: now, forecastTs: forecast.generatedAt, value };',
    to: '  probabilisticCache = { ts: now, forecastTs: forecast.generatedAt, value }; /* MUTANT */',
    why: 'A band with calScoredDays 0 would fail the gate after the forecast became complete (if its generatedAt were reused).',
  },
  {
    id: 'v. ★★ an incomplete basis defers past the deadline',
    file: NCA,
    find: '    && nowMin < NIGHT_PLAN_STALE_DEFER_UNTIL_MIN;',
    to: '    /* MUTANT */;',
    why: 'A genuinely incomplete night never decides: no notice, no cancel of a prior arm, until the 23:00 cutoff.',
  },
  {
    id: 'vi. ★★★ the evening job latches an incomplete basis at once',
    file: IX,
    find: '    if (eveningBasisDefers(fresh?.plan ?? null, nowMin)) {',
    to: '    if (false /* MUTANT */) {',
    why: 'A start-up transient at 21:30 latches "no plan" and cancels an armed charge (2026-09-27).',
  },
  {
    id: 'vii. ★★★ the skill scores a model fitted on other Cores than the actuals',
    file: AN,
    find: "  if (forecast.solarModelSns && forecast.solarModelSns.join(',') !== homeModelSns(devices).join(',')) {",
    to: '  if (false /* MUTANT */) {',
    why: 'A boot map with the SHP2 but one Core fits a third-size model the incompleteness flag misses; the plan reads 7% coverage.',
  },
  {
    id: 'viii. ★★★ the forecast does not record the Cores its model was fitted on',
    file: AN,
    find: '    solarModelSns: homeModelSns(devices),',
    to: '    /* MUTANT */',
    why: 'The Core-set check is inert on every real forecast.',
  },
  {
    id: 'ix. ★★ a persistent basis failure defers too',
    file: NCA,
    find: '  return (plan == null || (!plan.basisComplete && plan.basisTransient === true))',
    to: '  return (plan == null || !plan.basisComplete) /* MUTANT */',
    why: 'A genuine coverage miss is announced at 22:30 instead of 21:30 — an hour less for the owner to act.',
  },
  {
    id: 'x. ★★ zero scored calibration days is not treated as transient',
    file: NCA,
    find: '  const basisTransient = !basisComplete && (!forecastPresent || calScoredDays === 0);',
    to: '  const basisTransient = !basisComplete && !forecastPresent; /* MUTANT */',
    why: 'An empty skill after a restart (the partial-map case) is decided at 21:30 as "no plan" and cancels a prior arm.',
  },
  {
    id: 'xi. ★★★ a cached forecast fitted on other Cores is served for its TTL',
    file: AN,
    find: "  return sns == null || sns.join(',') === homeModelSns(devices).join(',');",
    to: '  return true; /* MUTANT */',
    why: 'A restart shortly before a 22:30 decision serves the partial forecast; the skill is empty and the night is cancelled.',
  },
  {
    id: 'xii. ★★ the model Core set includes projected Cores the panel does not list',
    file: AN,
    find: "  return Object.values(devices)\n    .filter((d) => d.projection?.kind === 'dpu' && isShp2Connected(d.sn, connected))",
    to: "  return Object.values(devices)\n    .filter((d) => d.projection?.kind === 'dpu') /* MUTANT */",
    why: 'A bench Core joins the model set: the fleet model and the scored actuals include PV that never reaches the house.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1186-5', mutants: MUTANTS, subset: SUBSET, root: REPO });
