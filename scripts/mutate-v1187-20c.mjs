#!/usr/bin/env node
/**
 * mutate-v1187-20c.mjs — v1.187.20: the charge-curve report is served while it is rebuilt.
 *
 *   C-i     a basis reset leaves the charge-curve value behind (stale served across a reset)
 *   C-ii    refresh-ahead removed at the use site (rebuild only after expiry, as before)
 *   C-iii   refresh-ahead window set to zero
 *   C-iv    an expired value is not served: the request rebuilds in the foreground again
 *   C-v     no stale bound: a value of any age is served while rebuilds keep failing
 *   C-vi    two concurrent rebuilds (the single-flight check removed)
 *   C-vii   a superseded generation's rebuild blocks the current basis's refresh
 *   C-viii  the rebuild's cache write is not gated on its basis generation
 *   C-ix    the background rebuild runs outside any basis generation
 *   C-x     a superseded flight starts a rebuild on its old map
 *   C-xi    the rebuild slot never frees (one rebuild per generation, ever)
 *   C-xii   a failed background rebuild is not logged
 *   C-xiii  the worker log is not wired to the charge-curve builder
 *   C-xiv   the chargeCurve budget back to 30 s
 *   C-xv    report() ignores the per-report budget (every report 30 s again)
 *   C-xvi   the retry attempt gets the 30 s default instead of the per-report budget
 *
 *   node scripts/mutate-v1187-20c.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const REPORTS = resolve(REPO, 'server/src/reports.ts');
const CLIENT = resolve(REPO, 'server/src/analyticsClient.ts');
const SUBSET = ['test/chargeCurveRevalidate.test.ts', 'test/reportBudget.test.ts'];

const MUTANTS = [
  {
    id: 'C-i. ★★★ a basis reset leaves the charge-curve value behind',
    file: ANALYTICS,
    find: '  evWindowCache = null;\n  chargeCurveCache = null;\n  irCache = null;\n',
    to: '  evWindowCache = null;\n  /* MUTANT */\n  irCache = null;\n',
    why: 'An expired value built on the boot-time partial map is served on the full map while it rebuilds.',
  },
  {
    id: 'C-ii. ★★★ refresh-ahead removed at the use site',
    file: ANALYTICS,
    find: '      if (age >= CHARGE_CURVE_TTL_MS - CHARGE_CURVE_REFRESH_AHEAD_MS) refreshChargeCurve(devices, recorder, opts);',
    to: '      if (age >= CHARGE_CURVE_TTL_MS) refreshChargeCurve(devices, recorder, opts); /* MUTANT */',
    why: 'The warm pass rebuilds only after expiry again: every hour a request meets an expired value.',
  },
  {
    id: 'C-iii. ★★ refresh-ahead window set to zero',
    file: ANALYTICS,
    find: 'export const CHARGE_CURVE_REFRESH_AHEAD_MS = 2 * WARM_INTERVAL_MS;',
    to: 'export const CHARGE_CURVE_REFRESH_AHEAD_MS = 0 * WARM_INTERVAL_MS; /* MUTANT */',
    why: 'The same gap through the constant.',
  },
  {
    id: 'C-iv. ★★★ an expired value is not served: the request rebuilds in the foreground',
    file: ANALYTICS,
    find: '    if (age < CHARGE_CURVE_TTL_MS + CHARGE_CURVE_STALE_MAX_MS) {',
    to: '    if (age < CHARGE_CURVE_TTL_MS) { /* MUTANT */',
    why: 'The 10-12 10:09:39 request waits 37 s for the scan again.',
  },
  {
    id: 'C-v. ★★ no stale bound',
    file: ANALYTICS,
    find: '    if (age < CHARGE_CURVE_TTL_MS + CHARGE_CURVE_STALE_MAX_MS) {',
    to: '    if (age >= 0) { /* MUTANT */',
    why: 'A rebuild that keeps failing leaves a value that silently stops moving, served forever.',
  },
  {
    id: 'C-vi. ★★★ two concurrent rebuilds',
    file: ANALYTICS,
    find: '  if (chargeCurveRefresh && chargeCurveRefresh.gen === gen) return; // one rebuild at a time',
    to: '  /* MUTANT */',
    why: 'Every request and warm pass during a rebuild starts another 200-day scan on the one worker.',
  },
  {
    id: 'C-vii. ★★ a superseded generation\'s rebuild blocks the current basis\'s refresh',
    file: ANALYTICS,
    find: '  if (chargeCurveRefresh && chargeCurveRefresh.gen === gen) return; // one rebuild at a time',
    to: '  if (chargeCurveRefresh) return; /* MUTANT */',
    why: 'A rebuild whose write will be dropped stands in for the one that would write.',
  },
  {
    id: 'C-viii. ★★★ the rebuild\'s cache write is not gated on its basis generation',
    file: ANALYTICS,
    find: '  if (dpus.length > 0 && cacheWritable()) chargeCurveCache = { ts: now, value };',
    to: '  if (dpus.length > 0) chargeCurveCache = { ts: now, value }; /* MUTANT */',
    why: 'A rebuild on the partial map that finishes after the reset is served on the full map.',
  },
  {
    id: 'C-ix. ★★ the background rebuild runs outside any basis generation',
    file: ANALYTICS,
    find: '  slot.done = runInBasisGeneration(gen, () => buildChargeCurveFingerprint(devices, recorder, opts))',
    to: '  slot.done = buildChargeCurveFingerprint(devices, recorder, opts) /* MUTANT */',
    why: 'A rebuild started outside a flight writes after a reset.',
  },
  {
    id: 'C-x. ★★ a superseded flight starts a rebuild on its old map',
    file: ANALYTICS,
    find: '  // A superseded flight (asked before a basis reset) could write nothing, and its map is the old one.\n  if (!cacheWritable()) return;\n',
    to: '  /* MUTANT */\n',
    why: 'The rebuild runs in the CURRENT generation on the superseded map and its write lands.',
  },
  {
    id: 'C-xi. ★★ the rebuild slot never frees',
    file: ANALYTICS,
    find: '    .finally(() => { if (chargeCurveRefresh === slot) chargeCurveRefresh = null; });',
    to: '    .finally(() => { /* MUTANT */ });',
    why: 'After one rebuild no other starts on this basis: the value ages until the stale bound.',
  },
  {
    id: 'C-xii. ★ a failed background rebuild is not logged',
    file: ANALYTICS,
    find: "      (e: any) => { opts.log?.(`analytics: chargeCurve background rebuild failed (the previous value is still served): ${e?.message ?? e}`); },",
    to: '      (_e: any) => { /* MUTANT */ },',
    why: 'A rebuild that keeps failing is invisible until the stale bound.',
  },
  {
    id: 'C-xiii. ★ the worker log is not wired to the charge-curve builder',
    file: REPORTS,
    find: '  chargeCurve: (ctx) => computeChargeCurveFingerprint(devicesOf(ctx), ctx.recorder, { log: ctx.log }),',
    to: '  chargeCurve: (ctx) => computeChargeCurveFingerprint(devicesOf(ctx), ctx.recorder, {}), /* MUTANT */',
    why: 'The failure log exists but production never reaches it.',
  },
  {
    id: 'C-xiv. ★★★ the chargeCurve budget back to 30 s',
    file: CLIENT,
    find: '  chargeCurve: 90_000,\n',
    to: '  chargeCurve: 30_000, /* MUTANT */\n',
    why: 'Every first build after a start is logged as a timeout and retried again.',
  },
  {
    id: 'C-xv. ★★★ report() ignores the per-report budget',
    file: CLIENT,
    find: "requestWithRetry<T>({ kind: 'report', name, args: a }, reportTimeoutMs(name, requestTimeoutMs))",
    to: "requestWithRetry<T>({ kind: 'report', name, args: a } /* MUTANT */)",
    why: 'The override table exists but the request path never reads it.',
  },
  {
    id: 'C-xvi. ★★ the retry attempt gets the 30 s default instead of the per-report budget',
    file: CLIENT,
    find: '        }, timeoutMs);',
    to: '        }, retry ? requestTimeoutMs : timeoutMs); /* MUTANT */',
    why: 'An unanswered chargeCurve is rejected at 120 s instead of 180 s: a cold build that finishes between the two (beside the boot warm pass) fails instead of being answered.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants; a kill must come from
// it, not from an unrelated full-suite failure under parallel load (a false kill).
await runMutantsParallel({ name: 'mutate-v1187-20c', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
