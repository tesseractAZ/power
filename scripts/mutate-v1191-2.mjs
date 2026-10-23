#!/usr/bin/env node
/**
 * mutate-v1191-2.mjs — v1.191.2: the day forecast is cached on the house panel while every home Core is
 * cloud-dark, served only on the dark-Core basis it was built on, and each restored Core's 30-day PV is
 * read once per build.
 *
 *   V2-i     the panel clause is removed (a dark fleet's forecast is rebuilt by every caller again)
 *   V2-ii    a fleet with no projection at all is cached (the boot device list latches)
 *   V2-iii   the restored-basis comparison is dropped (a dark Core leaving or returning is not seen)
 *   V2-iv    the pending check is dropped (a dark Core listed online before its first quota is not seen)
 *   V2-v     the entry records no restored Cores (every dark-fleet entry is rejected: caching inert)
 *   V2-vi    the entry is never flagged pending (a pending boot map is rebuilt by every caller)
 *   V2-vii   the restored fleet model reads the series again (the single read undone)
 *   V2-viii  the restored display curve reads the series again (the other half of it)
 *   V2-ix    the read series is not kept (the restored fleet model is fitted on nothing)
 *
 * 2026-10-22: a process started while every home Core was listed offline in the EcoFlow cloud had no
 * projected DPU, so computeDayForecastUncached never cached its complete forecast and every
 * forecast-dependent report rebuilt it (about 1.6 s each on the Pi, a third of a core). V2-iii and
 * V2-iv are the transitions the solarModelSns check cannot see on such a fleet (empty on both sides);
 * each is killed by a case that v1.191.1 also passed (it rebuilt on every call). V2-vii to V2-ix are
 * killed by the byte-identity capture against v1.191.1's forecast on the same fixture.
 *
 * Check the BASELINE is green first: the harness aborts on a red subset.
 *
 *   cd server && node ../scripts/mutate-v1191-2.mjs      (or from the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const SUBSET = [
  'test/darkFleetForecastCache.test.ts',
  'test/darkFleetForecastSingleRead.test.ts',
];

const MUTANTS = [
  {
    id: 'V2-i. ★★★ the panel clause is removed',
    file: ANALYTICS,
    find: '  if ((dpus.length > 0 || shp2 != null) && cacheWritable()) dayForecastCache = { ts: now, value, incomplete: structurallyIncomplete, restoredSns: homeRestoredSns(devices), basisPending };',
    to: '  if ((dpus.length > 0) && cacheWritable()) dayForecastCache = { ts: now, value, incomplete: structurallyIncomplete, restoredSns: homeRestoredSns(devices), basisPending }; /* MUTANT */',
    why: 'With every home Core cloud-dark the complete forecast is rebuilt by every caller: about 1.6 s each on the Pi, a third of a core.',
  },
  {
    id: 'V2-ii. ★★★ a fleet with no projection at all is cached',
    file: ANALYTICS,
    find: '  if ((dpus.length > 0 || shp2 != null) && cacheWritable()) dayForecastCache = { ts: now, value, incomplete: structurallyIncomplete, restoredSns: homeRestoredSns(devices), basisPending };',
    to: '  if ((dpus.length > 0 || shp2 != null || (true as boolean)) && cacheWritable()) dayForecastCache = { ts: now, value, incomplete: structurallyIncomplete, restoredSns: homeRestoredSns(devices), basisPending }; /* MUTANT */',
    why: 'The forecast built on the boot device list (no panel, no Core) latches with nothing to anchor it to.',
  },
  {
    id: 'V2-iii. ★★★ the restored-basis comparison is dropped',
    file: ANALYTICS,
    find: "  if (dayForecastCache.restoredSns.join(',') !== homeRestoredSns(devices).join(',')) return false;",
    to: "  if ((false as boolean) && dayForecastCache.restoredSns.join(',') !== homeRestoredSns(devices).join(',')) return false; /* MUTANT */",
    why: 'A dark Core that leaves the source list keeps its PV in the display figures, and one returning inside the deferred re-arrival window is served the dip\'s forecast, for the 30-min TTL.',
  },
  {
    id: 'V2-iv. ★★★ the pending check is dropped',
    file: ANALYTICS,
    find: '  if (!dayForecastCache.basisPending && homeBasisPending(devices, now)) return false;',
    to: '  if ((false as boolean) && !dayForecastCache.basisPending && homeBasisPending(devices, now)) return false; /* MUTANT */',
    why: 'A dark Core listed online before its first quota is served a complete forecast the publishers would have withheld.',
  },
  {
    id: 'V2-v. ★★ the entry records no restored Cores',
    file: ANALYTICS,
    find: 'restoredSns: homeRestoredSns(devices), basisPending };',
    to: 'restoredSns: [] as string[], basisPending }; /* MUTANT */',
    why: 'Every dark-fleet entry fails its own basis check: the panel clause caches and nothing is ever served from it.',
  },
  {
    id: 'V2-vi. ★★ the entry is never flagged pending',
    file: ANALYTICS,
    find: 'restoredSns: homeRestoredSns(devices), basisPending };',
    to: 'restoredSns: homeRestoredSns(devices), basisPending: false }; /* MUTANT */',
    why: 'At a restart with every Core listed online before its first quota, the pending forecast is rebuilt by every caller for up to 10 min.',
  },
  {
    id: 'V2-vii. ★★ the restored fleet model reads the series again',
    file: ANALYTICS,
    find: '    const pvE = pvHourlyFromPts(restoredPvPts.get(sn) ?? []); // v1.191.2 — the series read above',
    to: "    const pvE = pvHourlyByEpoch(recorder, sn, 'pv_total', since, now); /* MUTANT */",
    why: 'Each connected-but-unprojected Core\'s 30-day pv_total is scanned twice per build again.',
  },
  {
    id: 'V2-viii. ★ the restored display curve reads the series again',
    file: ANALYTICS,
    find: '    const { curve, spanMs } = hourCurveFromPts(pts);',
    to: "    const { curve, spanMs } = hourCurve(recorder, sn, 'pv_total', since, now); /* MUTANT */",
    why: 'The curve issues its own read beside the one kept for the model: two scans per Core again.',
  },
  {
    id: 'V2-ix. ★★ the read series is not kept',
    file: ANALYTICS,
    find: '    restoredPvPts.set(sn, pts);',
    to: '    /* MUTANT */',
    why: 'The restored fleet model is fitted without the dark Cores\' PV: the clipping and array-peak tiles collapse to the reporting Cores.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1191-2', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
