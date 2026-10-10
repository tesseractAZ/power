#!/usr/bin/env node
/**
 * mutate-audit-last-three.mjs — committed harness for v1.183.0: no projection is not
 * "Comfortable", a strategy-excluded circuit is not "turned off", the DPU countdown names its
 * direction, and chart axes carry distinct compact ticks with the unit on the axis label.
 *
 *   node scripts/mutate-audit-last-three.mjs
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
const TEXT = resolve(REPO, 'web/src/cards/cardText.ts');
const AXIS = resolve(REPO, 'web/src/charts/axisFormat.ts');
const TREND = resolve(REPO, 'web/src/charts/TrendChart.tsx');
const STRAT = resolve(REPO, 'web/src/pages/StrategyPanel.tsx');
const GEN = resolve(SERVER, 'src/telnet/plant/gen.ts');

const SUBSET = ['test/auditLastThree.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605 no projection reads "Comfortable" again',
    file: TEXT,
    find: "  if (minProjectedSoc == null) return { label: '—', tone: 'muted' };",
    to: "  if (minProjectedSoc == null) return { label: 'Comfortable', tone: 'ok' }; /* MUTANT */",
    why: 'The most reassuring word, in green, exactly when nothing has been projected.',
  },
  {
    id: 'ii. \u2605\u2605 a strategy-excluded circuit gets no note (the "turned off" reading returns by omission)',
    file: TEXT,
    find: '  if (loadIsEnable !== false) return null;',
    to: '  return null; /* MUTANT */',
    why: 'The tab no longer says the circuit is outside the SHP2\u2019s shed order.',
  },
  {
    id: 'iii. \u2605 a charging countdown reads as a runtime',
    file: TEXT,
    find: "  if (batAmp > 0.5) return 'to full';",
    to: '  /* MUTANT */',
    why: 'Time-to-full is labelled like time-to-empty.',
  },
  {
    id: 'iv. \u2605 compact ticks round to whole thousands again',
    file: AXIS,
    find: '  return Math.abs(v) >= 1000 ? `${trimDecimals(v / 1000, 2)}k` : trimDecimals(v);',
    to: '  return Math.abs(v) >= 1000 ? `${trimDecimals(v / 1000)}k` : trimDecimals(v); /* MUTANT */',
    why: 'Neighbouring ticks print the same label: an uneven-looking axis.',
  },
  {
    id: 'v. \u2605 the kW axis rounds to whole kW again',
    file: AXIS,
    find: '  return trimDecimals(watts / 1000, 2);',
    to: '  return trimDecimals(watts / 1000); /* MUTANT */',
    why: '1.5 and 2 kW both read "2".',
  },
  {
    id: 'vi. \u2605 the trend chart prints its unit on every tick again',
    file: TREND,
    find: '<YAxis yAxisId="left" tick={{ fill: CHART.axis, fontSize: 10 }} width={48} tickFormatter={compactTick} label={unit ?',
    to: '<YAxis yAxisId="left" tick={{ fill: CHART.axis, fontSize: 10 }} width={48} unit={unit ? ` ${unit}` : \'\'} /* MUTANT */ label={unit ?',
    why: '"10000 W" overflows the 48 px axis and the unit wraps onto a stray line.',
  },
  {
    id: 'vii. \u2605 a circuit outside the load strategy is ranked and tiered again',
    file: STRAT,
    find: '    .filter((c) => c.loadPriority != null && c.loadIsEnable !== false)',
    to: '    .filter((c) => c.loadPriority != null) /* MUTANT */',
    why: 'It reads "first to shed" beside "not in the SHP2\u2019s load strategy", and shifts every other tier.',
  },
  {
    id: 'viii. \u2605 the telnet console tags a charge countdown as runtime',
    file: GEN,
    find: "    tag: `GEN.${idx + 1}.${(p.batAmp ?? 0) > 0.5 ? 'TTF' : 'RUN'}.MIN`,",
    to: '    tag: `GEN.${idx + 1}.RUN.MIN`, /* MUTANT */',
    why: 'Time-to-full reads as remaining runtime on the operator console.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-audit-last-three', mutants: MUTANTS, subset: SUBSET, root: REPO });
