#!/usr/bin/env node
/**
 * mutate-v1191-3.mjs — v1.191.3: self-consumption is cached while every home Core is known dark,
 * keyed on the basis it was built on, and the tariff integrates each hour from that hour's samples.
 *
 *   V3-i     the known-dark clause is removed (the dark fleet rebuilds on every read again)
 *   V3-ii    known dark ignores a pending Core (the warm-up's pending map latches)
 *   V3-iii   known dark ignores an empty source list (a panel listing no Core latches)
 *   V3-iv    the panel requirement is dropped (the v0.15.13 boot-partial latches again)
 *   V3-v     the key drops the restored Cores (a dark Core leaving or returning is not seen)
 *   V3-vi    the key drops the projected Cores (a projected Core leaving the list is not seen)
 *   V3-x     the key drops the house panel (a re-pinned house panel is not seen)
 *   V3-vii   the slice starts at the window (the sample before an hour is lost)
 *   V3-viii  the slice ends before a sample exactly at the window's end
 *   V3-ix    the whole-series fallback is removed (an out-of-order series is sliced)
 *   V3-xi    the order check reverts to `<` (a NaN timestamp hides the disorder)
 *   V3-xii   the slice start is not clamped at the series head (a window before the first sample)
 *   V3-xiii  carbon caches without a projected DPU (the dark fleet's carbon latches)
 *   V3-xiv   carbon caches without the projected panel (the v0.15.13 boot-partial latches)
 *   V3-xv    tariff caches without a projected DPU (the dark fleet's tariff latches)
 *   V3-xvi   tariff caches without the projected panel (the v0.15.13 boot-partial latches)
 *
 * 2026-10-22 investigation: with every home Core cloud-dark after a restart, the self-consumption,
 * carbon and tariff reports were each rebuilt about 2.2 times a minute (self-consumption about 4.4
 * counting carbon's copy), about 1 % of the reference Pi's core after v1.191.2. V3-v, V3-vi and V3-x
 * are each killed by a case written for them (A7/A8 on the dark fleet, A9, A12). On v1.191.2, which
 * cached under the key 'd7', the F-spare halves of A7 and A8 are red, and both halves of A12 (v1.191.2
 * never caches the dark map, which A12's same-pin step serves from the cache). V3-vii, V3-viii and
 * V3-xii are killed by integrateWhSorted.test.ts and by the energy identity capture against v1.191.2's
 * figures (its two instants put an hour boundary on a sample and between two).
 *
 * V3-xiii to V3-xvi hold the carbon and tariff caches to v0.15.13 ("an incomplete snapshot may be
 * returned, but never latched"), unchanged by this release: each half of each gate is reverted alone.
 * Without the DPU half, A2's dark fleet latches; without the panel half, A6's boot-partial does.
 *
 * Deliberately absent: reverting the tariff's tally to whole-series integrateWh is a pure performance
 * revert that no output can observe; its evidence is the replay in docs/PERFORMANCE.md §4e.
 *
 * Check the BASELINE is green first: the harness aborts on a red subset.
 *
 *   cd server && node ../scripts/mutate-v1191-3.mjs      (or from the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const AGGREGATOR = resolve(REPO, 'server/src/aggregator.ts');
const SUBSET = [
  'test/darkFleetSelfConsumptionCache.test.ts',
  'test/analyticsHealthFixes.test.ts',
  'test/darkFleetEnergyIdentity.test.ts',
  'test/integrateWhSorted.test.ts',
];

const MUTANTS = [
  {
    id: 'V3-i. ★★★ the known-dark clause is removed',
    file: ANALYTICS,
    find: '  if ((dpus.length > 0 || knownDark) && shp2 != null && cacheWritable()) selfConsumptionCache = { ts: now, key, value };',
    to: '  if ((dpus.length > 0) && shp2 != null && cacheWritable()) selfConsumptionCache = { ts: now, key, value }; /* MUTANT */',
    why: 'With every home Core cloud-dark, self-consumption is rebuilt on every read and once more inside every carbon build.',
  },
  {
    id: 'V3-ii. ★★★ known dark ignores a pending Core',
    file: ANALYTICS,
    find: '  const knownDark = restoredSns.length > 0 && !homeBasisPending(devices, now);',
    to: '  const knownDark = restoredSns.length > 0; /* MUTANT */',
    why: 'In the first 10 min after a restart, a map with a Core listed online before its first quota is latched for the TTL.',
  },
  {
    id: 'V3-iii. ★★★ known dark ignores an empty source list',
    file: ANALYTICS,
    find: '  const knownDark = restoredSns.length > 0 && !homeBasisPending(devices, now);',
    to: '  const knownDark = !homeBasisPending(devices, now); /* MUTANT */',
    why: 'A panel that lists no Core (its quota not yet carrying the sources) is latched with no Core\'s energy in it.',
  },
  {
    id: 'V3-iv. ★★★ the panel requirement is dropped',
    file: ANALYTICS,
    find: '  if ((dpus.length > 0 || knownDark) && shp2 != null && cacheWritable()) selfConsumptionCache = { ts: now, key, value };',
    to: '  if ((dpus.length > 0 || knownDark) && cacheWritable()) selfConsumptionCache = { ts: now, key, value }; /* MUTANT */',
    why: 'The v0.15.13 boot-partial (one polled DPU, no panel yet: loadKwh 0) is served for the full TTL again.',
  },
  {
    id: 'V3-v. ★★★ the key drops the restored Cores',
    file: ANALYTICS,
    find: "  const key = `d${windowDays}|${shp2?.sn ?? ''}|${modelSns.join(',')}|${restoredSns.join(',')}`;",
    to: "  const key = `d${windowDays}|${shp2?.sn ?? ''}|${modelSns.join(',')}`; /* MUTANT */",
    why: 'A dark Core leaving the source list keeps its energy in the figures, and one returning inside the deferred re-arrival window is served the dip\'s entry, for 15 min.',
  },
  {
    id: 'V3-vi. ★★ the key drops the projected Cores',
    file: ANALYTICS,
    find: "  const key = `d${windowDays}|${shp2?.sn ?? ''}|${modelSns.join(',')}|${restoredSns.join(',')}`;",
    to: "  const key = `d${windowDays}|${shp2?.sn ?? ''}|${restoredSns.join(',')}`; /* MUTANT */",
    why: 'A projected Core that leaves the source list beside dark ones keeps its PV in the figures for 15 min.',
  },
  {
    id: 'V3-x. ★★ the key drops the house panel',
    file: ANALYTICS,
    find: "  const key = `d${windowDays}|${shp2?.sn ?? ''}|${modelSns.join(',')}|${restoredSns.join(',')}`;",
    to: "  const key = `d${windowDays}|${modelSns.join(',')}|${restoredSns.join(',')}`; /* MUTANT */",
    why: 'After a re-pin of the house panel, the load and grid of the previous panel are served for 15 min (and fed to the outage cushion).',
  },
  {
    id: 'V3-vii. ★★ the slice starts at the window',
    file: AGGREGATOR,
    find: '    integrateWh(points.slice(Math.max(0, firstAtOrAfter(sinceMs) - 1), firstAfter(untilMs)), sinceMs, untilMs);',
    to: '    integrateWh(points.slice(firstAtOrAfter(sinceMs), firstAfter(untilMs)), sinceMs, untilMs); /* MUTANT */',
    why: 'Every tariff hour loses its head segment (from the hour to its first sample): the cost and value fall.',
  },
  {
    id: 'V3-viii. ★★ the slice ends before a sample at the window\'s end',
    file: AGGREGATOR,
    find: '    integrateWh(points.slice(Math.max(0, firstAtOrAfter(sinceMs) - 1), firstAfter(untilMs)), sinceMs, untilMs);',
    to: '    integrateWh(points.slice(Math.max(0, firstAtOrAfter(sinceMs) - 1), firstAtOrAfter(untilMs)), sinceMs, untilMs); /* MUTANT */',
    why: 'A sample exactly on an hour\'s end is held from the one before it: the hour\'s energy moves.',
  },
  {
    id: 'V3-ix. ★★ the whole-series fallback is removed',
    file: AGGREGATOR,
    find: '    if (!(points[i].ts >= points[i - 1].ts)) return (sinceMs, untilMs) => integrateWh(points, sinceMs, untilMs);',
    to: '    /* MUTANT */',
    why: 'An out-of-order series is binary-searched as if sorted: in-window samples are left out of the integral.',
  },
  {
    id: 'V3-xi. ★★ the order check reverts to `<`',
    file: AGGREGATOR,
    find: '    if (!(points[i].ts >= points[i - 1].ts)) return (sinceMs, untilMs) => integrateWh(points, sinceMs, untilMs);',
    to: '    if (points[i].ts < points[i - 1].ts) return (sinceMs, untilMs) => integrateWh(points, sinceMs, untilMs); /* MUTANT */',
    why: 'A NaN timestamp between two out-of-order points compares false both ways, the series is sliced, and a sample is lost.',
  },
  {
    id: 'V3-xii. ★★ the slice start is not clamped at the series head',
    file: AGGREGATOR,
    find: '    integrateWh(points.slice(Math.max(0, firstAtOrAfter(sinceMs) - 1), firstAfter(untilMs)), sinceMs, untilMs);',
    to: '    integrateWh(points.slice(firstAtOrAfter(sinceMs) - 1, firstAfter(untilMs)), sinceMs, untilMs); /* MUTANT */',
    why: 'A window that starts at or before the first sample slices from -1: it gets the last point alone, or nothing.',
  },
  {
    id: 'V3-xiii. ★★★ carbon caches without a projected DPU',
    file: ANALYTICS,
    find: '  if (fleetComplete && cacheWritable()) carbonCache = { ts: Date.now(), value };',
    to: "  if (deviceList.some((d) => d.projection?.kind === 'shp2') && cacheWritable()) carbonCache = { ts: Date.now(), value }; /* MUTANT */",
    why: 'With every home Core dark, the carbon figure built with no Core projected is latched for the TTL.',
  },
  {
    id: 'V3-xiv. ★★★ carbon caches without the projected panel',
    file: ANALYTICS,
    find: '  if (fleetComplete && cacheWritable()) carbonCache = { ts: Date.now(), value };',
    to: "  if (deviceList.some((d) => d.projection?.kind === 'dpu') && cacheWritable()) carbonCache = { ts: Date.now(), value }; /* MUTANT */",
    why: 'The v0.15.13 boot-partial (one polled DPU, the panel not yet projected) latches a partial-fleet carbon figure for the TTL.',
  },
  {
    id: 'V3-xv. ★★★ tariff caches without a projected DPU',
    file: ANALYTICS,
    find: '  if (dpus.length > 0 && shp2 != null && cacheWritable()) tariffCache = { ts: now, value };',
    to: '  if (shp2 != null && cacheWritable()) tariffCache = { ts: now, value }; /* MUTANT */',
    why: 'With every home Core dark, the tariff built with no Core projected is latched for the TTL.',
  },
  {
    id: 'V3-xvi. ★★★ tariff caches without the projected panel',
    file: ANALYTICS,
    find: '  if (dpus.length > 0 && shp2 != null && cacheWritable()) tariffCache = { ts: now, value };',
    to: '  if (dpus.length > 0 && cacheWritable()) tariffCache = { ts: now, value }; /* MUTANT */',
    why: 'The v0.15.13 boot-partial (grid-import cost with no solar value, negative net savings) is latched for the TTL.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1191-3', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
