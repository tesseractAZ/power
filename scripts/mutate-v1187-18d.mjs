#!/usr/bin/env node
/**
 * mutate-v1187-18d.mjs — v1.187.18: no analytics report is served from a boot-time partial device map.
 *
 *  The worker's report chokepoint (reports.ts)
 *   B-i     no cache reset when an element arrives in the basis (the boot fill)
 *   B-ii    the basis is missing from the flight key (a full-map request joins a partial-map flight)
 *   B-iii   a superseded flight's cache writes are not dropped (the shared-weather-fetch race)
 *   B-iii-b a flight's generation is taken when it runs, not when it is asked
 *   B-iii-c every flight's cache writes are dropped (a current-basis flight loses its result)
 *   B-iv    a LEAVING element resets too (a flapping source thrashes every cache)
 *   B-v     no rate limit on a re-arrival
 *   B-vi    a deferred re-arrival reset is dropped when the key does not change again
 *   B-vii   a first sighting is rate-limited like a re-arrival (the boot fill's second step deferred)
 *   B-viii  the inner day-forecast flight is not keyed on the basis
 *   B-ix    reportBasisKey loses the panel-listed Cores
 *   B-x     a basis reset leaves the pending flag set (a reset every window, forever)
 *  The reset list (analytics.ts)
 *   C-i     the charge-curve cache is dropped from resetWorkerReportCaches
 *   C-ii    the forecast-skill memo is dropped from resetWorkerReportCaches
 *   C-iii   the runway cache write is not gated on the flight's generation
 *   C-iv    the forecast-alert cache write is not gated on the flight's generation
 *  The runway's carried load (analytics.ts)
 *   L-i     the carried load is read back from the result cache a basis reset nulls
 *   L-ii    the carried load is never recorded
 *  The degradation report's own basis (analytics.ts)
 *   D-i     the covers check is ignored
 *   D-ii    membership becoming known is ignored
 *   D-iii   equality instead of a superset (a Core or pack leaving forces a rescan)
 *   D-iv    basisPending is never computed
 *   D-v     a pending report is cached the full 30 min
 *   D-vi    an OFFLINE Core counts as pending
 *   D-vii   pending is not bounded by the worker's life
 *   D-viii  an empty device map is not pending
 *  Readiness (publishReadiness.ts, index.ts, mqttDiscovery.ts)
 *   R-i     the degradation flag ignores basisPending
 *   R-ii    /api/ha-state does not hand the report to the gate
 *   R-iii   the MQTT publisher does not hand the report to the gate
 *  Main-thread and forecast-derived caches (analytics.ts)
 *   M-i     the pack-risk cache is keyed on time alone
 *   M-vi    the pack-risk cache key drops the degradation report
 *   M-ii    the multi-day rollup is cached from an incomplete forecast
 *   M-iii   the multi-day rollup is not bound to its forecast
 *   M-iv    the dispatch plan is cached from an incomplete forecast
 *   M-v     the dispatch plan is not bound to its forecast
 *  The worker (analyticsWorker.ts)
 *   W-i     the warm pass runs on the bare device list
 *
 *   node scripts/mutate-v1187-18d.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AN = resolve(REPO, 'server/src/analytics.ts');
const REP = resolve(REPO, 'server/src/reports.ts');
const FLEET = resolve(REPO, 'server/src/analytics/fleet.ts');
const PR = resolve(REPO, 'server/src/publishReadiness.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const MQ = resolve(REPO, 'server/src/mqttDiscovery.ts');
const WK = resolve(REPO, 'server/src/analyticsWorker.ts');
const FB = resolve(REPO, 'server/src/analytics/flightBasis.ts');
const SUBSET = [
  'test/bootPartialBasis.test.ts',
  'test/degradationBootBasis.test.ts',
  'test/workerCacheInventory.test.ts',
  'test/mainThreadDerivedCaches.test.ts',
];

const MUTANTS = [
  // ── the chokepoint ─────────────────────────────────────────────────────────────────────────
  {
    id: 'B-i. ★★★ no cache reset when an element arrives in the basis',
    file: REP,
    find: '  if (firstSight) {\n    resetBasisCaches();',
    to: '  if (firstSight) { /* MUTANT */',
    why: 'Every report built on the boot map is served on the full map for its TTL (2026-10-11 12:23).',
  },
  {
    id: 'B-ii. ★★★ the basis is missing from the flight key',
    file: REP,
    find: 'reportFlights.run(`${buildFlightKey(name, args)} @${key}`,',
    to: 'reportFlights.run(buildFlightKey(name, args) /* MUTANT */,',
    why: 'A request on the full map joins a flight that started on the partial one (4/4/4 packs).',
  },
  {
    id: 'B-iii. ★★★ a superseded flight\'s cache writes are not dropped',
    file: FB,
    find: '  return g === undefined || g === generation;',
    to: '  return true; /* MUTANT */',
    why: 'Flights on two bases resume from one weather fetch: the full-map runway is answered with the dip map\'s.',
  },
  {
    id: 'B-iii-b. ★★ a flight\'s generation is taken when it runs, not when it is asked',
    file: REP,
    find: '() => runInBasisGeneration(gen, () => b(ctx, args))',
    to: '() => runInBasisGeneration(basisGeneration(), () => b(ctx, args)) /* MUTANT */',
    why: 'A flight asked on the partial map but started after the reset writes its partial result as current.',
  },
  {
    id: 'B-iii-c. ★★ every flight\'s cache writes are dropped',
    file: FB,
    find: '  return g === undefined || g === generation;',
    to: '  return g === undefined; /* MUTANT */',
    why: 'Every report recomputes on every request: a cold pass per HA publish.',
  },
  {
    id: 'B-iv. ★★ a leaving element resets too',
    file: REP,
    find: '  const arrived = parts.filter((e) => !basis.parts.has(e));',
    to: '  const arrived = parts.filter((e) => !basis.parts.has(e)).concat([...basis.parts].filter((e) => !parts.includes(e))); /* MUTANT */',
    why: 'A flapping panel source resets every cache on the way out as well as on the way back.',
  },
  {
    id: 'B-v. ★★ no rate limit on a re-arrival',
    file: REP,
    find: '    if (nowMs - basis.lastRearrivalResetMs >= BASIS_REARRIVAL_RESET_MIN_MS) {',
    to: '    if (true) { /* MUTANT */',
    why: 'A source flickering every poll forces a cold pass of every report every poll.',
  },
  {
    id: 'B-vi. ★★ a deferred re-arrival reset is dropped',
    file: REP,
    find: '  if (key === basis.key && !basis.pending) return basisGeneration();',
    to: '  if (key === basis.key) return basisGeneration(); /* MUTANT */',
    why: 'What was built during a dip is served for the full TTL once the source settles back.',
  },
  {
    id: 'B-vii. ★★★ a first sighting is rate-limited like a re-arrival',
    file: REP,
    find: '  const firstSight = arrived.some((e) => !basis.seen.has(e));',
    to: '  const firstSight = false; /* MUTANT */',
    why: 'The boot fill is two arrivals seconds apart; the second (the full map) would be deferred five minutes.',
  },
  {
    id: 'B-viii. ★★ the inner day-forecast flight is not keyed on the basis',
    file: AN,
    find: '  const basis = reportBasisKey(devices);\n  const flying = dayForecastFlights.get(basis);',
    to: "  const basis = 'MUTANT';\n  const flying = dayForecastFlights.get(basis);",
    why: 'A runway request on the full map is handed the forecast the partial map\'s flight computes.',
  },
  {
    id: 'B-ix. ★ reportBasisKey loses the panel-listed Cores',
    file: FLEET,
    find: "  return `${dpus.join(',')}|${panels.join(',')}|${home.join(',')}`;",
    to: "  return `${dpus.join(',')}|${panels.join(',')}|`; /* MUTANT */",
    why: 'A Core joining the panel\'s source list would not reset the home-scoped reports.',
  },
  {
    id: 'B-x. ★★ a basis reset leaves the pending flag set',
    file: REP,
    find: '  basis.pending = false;\n  resetWorkerReportCaches();',
    to: '  resetWorkerReportCaches(); /* MUTANT */',
    why: 'After one double flicker every worker cache is nulled every 5 min for the life of the process.',
  },
  // ── the reset list ─────────────────────────────────────────────────────────────────────────
  {
    id: 'C-i. ★★★ the charge-curve cache is dropped from resetWorkerReportCaches',
    file: AN,
    find: '  chargeCurveCache = null;\n  irCache = null;',
    to: '  irCache = null; /* MUTANT */',
    why: 'The charge-curve report keeps the boot map\'s 4 packs for its TTL.',
  },
  {
    id: 'C-ii. ★★ the forecast-skill memo is dropped from resetWorkerReportCaches',
    file: AN,
    find: '  forecastSkillCache.clear();\n  ambientThermalCache = null;',
    to: '  ambientThermalCache = null; /* MUTANT */',
    why: 'A cache in neither list: the inventory guard must name it.',
  },
  {
    id: 'C-iii. ★★★ the runway cache write is not gated on the flight\'s generation',
    file: AN,
    find: '  if (!basisPending && cacheWritable()) runwayCache = { ts: now, value };',
    to: '  if (!basisPending) runwayCache = { ts: now, value }; /* MUTANT */',
    why: 'A dip-map runway written after the reset answers the full-map request (one alarm pass on another basis).',
  },
  {
    id: 'C-iv. ★★ the forecast-alert cache write is not gated on the flight\'s generation',
    file: AN,
    find: '  if (Object.values(devices).some((d) => d.projection) && cacheWritable()) forecastCache = {',
    to: '  if (Object.values(devices).some((d) => d.projection)) /* MUTANT */ forecastCache = {',
    why: 'The forecast alerts computed on the old basis answer the new one.',
  },
  // ── the runway's carried load ──────────────────────────────────────────────────────────────
  {
    id: 'L-i. ★★★ the carried load is read back from the result cache',
    file: AN,
    find: ': carryOk && (runwayCarriedLoadW ?? 0) > 0 ? runwayCarriedLoadW!',
    to: ': carryOk && (runwayCache?.value.recentLoadWatts ?? 0) > 0 ? runwayCache!.value.recentLoadWatts /* MUTANT */',
    why: 'A basis reset during a panel-load gap makes the runway unavailable and an active runway alarm re-arms.',
  },
  {
    id: 'L-ii. ★★ the carried load is never recorded',
    file: AN,
    find: '  runwayCarriedLoadW = value.recentLoadWatts;',
    to: '  /* MUTANT */',
    why: 'A silent panel makes the runway unavailable at once instead of carrying the last load for 2 h.',
  },
  // ── degradation ────────────────────────────────────────────────────────────────────────────
  {
    id: 'D-i. ★★★ the degradation covers check is ignored',
    file: AN,
    find: '    && degradationCacheCovers(degradationCache.basis, basis)) {',
    to: '    ) { /* MUTANT */',
    why: 'The 12:23 report (4 packs) is served on the full map until its TTL.',
  },
  {
    id: 'D-ii. ★★★ membership becoming known is ignored',
    file: AN,
    find: '  if (current.membershipKnown && !cached.membershipKnown) return false;',
    to: '  /* MUTANT */',
    why: 'Panel late: every pack stays tagged home after the panel projects.',
  },
  {
    id: 'D-iii. ★★ equality instead of a superset',
    file: AN,
    find: '  return current.pairs.every((k) => have.has(k));',
    to: '  return current.pairs.length === cached.pairs.length && current.pairs.every((k) => have.has(k)); /* MUTANT */',
    why: 'A Core or pack leaving the map forces a rescan of every pack.',
  },
  {
    id: 'D-iv. ★★★ basisPending is never computed',
    file: AN,
    find: '  const basisPending = degradationBasisPending(devices, now);',
    to: '  const basisPending = false; /* MUTANT */',
    why: 'The boot report caches 30 min and its six HA fields publish 4 / 0 / unknown.',
  },
  {
    id: 'D-v. ★★ a pending report is cached the full 30 min',
    file: AN,
    find: '(degradationCache.value.basisPending ? DEGRADE_PENDING_TTL_MS : DEGRADE_REPORT_TTL_MS)',
    to: 'DEGRADE_REPORT_TTL_MS /* MUTANT */',
    why: 'An online Core whose quota keeps failing holds the partial report for 30 min.',
  },
  {
    id: 'D-vi. ★★ an OFFLINE Core counts as pending',
    file: AN,
    find: "    if (d?.online !== true) continue;\n    const p = (d.productName ?? '').toLowerCase();",
    to: "    const p = (d.productName ?? '').toLowerCase(); /* MUTANT */",
    why: 'A cloud-wedged Core holds the six degradation fields null for ten minutes after every restart.',
  },
  {
    id: 'D-vii. ★★ pending is not bounded by the worker\'s life',
    file: AN,
    find: '  if (nowMs - sinceMs > HOME_BASIS_PENDING_MAX_MS) return false; // the homeBasisPending bound\n  const list = Object.values(devices);',
    to: '  const list = Object.values(devices); /* MUTANT */',
    why: 'A Core whose quota never lands holds the degradation fields unknown for the life of the process.',
  },
  {
    id: 'D-viii. ★ an empty device map is not pending',
    file: AN,
    find: '  if (list.length === 0) return true;',
    to: '  /* MUTANT */',
    why: 'A report on a worker with no device list publishes "0 packs" for a cycle.',
  },
  // ── readiness ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'R-i. ★★★ the degradation flag ignores basisPending',
    file: PR,
    find: '    degradation: !!i.degradation && i.degradation.basisPending !== true,',
    to: '    degradation: !!i.degradation, /* MUTANT */',
    why: 'HA reads degradation_packs_total 4, projecting 0 at a restart.',
  },
  {
    id: 'R-ii. ★★ /api/ha-state does not hand the report to the gate',
    file: IDX,
    find: '    degradation: deg, // v1.187.18',
    to: '    /* MUTANT */',
    why: 'The REST twin publishes the six fields null forever (or, with a default, ungated).',
  },
  {
    id: 'R-iii. ★★ the MQTT publisher does not hand the report to the gate',
    file: MQ,
    find: '      degradation: deg as { basisPending?: boolean } | null, // v1.187.18',
    to: '      /* MUTANT */',
    why: 'The MQTT sensors publish the six fields null forever (or, with a default, ungated).',
  },
  // ── main-thread and forecast-derived caches ────────────────────────────────────────────────
  {
    id: 'M-i. ★★★ the pack-risk cache is keyed on time alone',
    file: AN,
    find: '  if (riskCache && riskCache.inputs === inputs && Date.now() - riskCache.ts < RISK_TTL_MS) return riskCache.value;',
    to: '  if (riskCache && Date.now() - riskCache.ts < RISK_TTL_MS) return riskCache.value; /* MUTANT */',
    why: 'The boot pack-risk scores stand 30 min after the degradation report is rebuilt (12:57:43).',
  },
  {
    id: 'M-vi. ★★ the pack-risk cache key drops the degradation report',
    file: AN,
    find: 'const inputs = `${degradation.generatedAt}|${thermalEvents.generatedAt}|',
    to: 'const inputs = `|${thermalEvents.generatedAt}|',
    why: 'A degradation report rebuilt alone (pending expiry, a pack arriving) is not rescored for 30 min.',
  },
  {
    id: 'M-ii. ★★ the multi-day rollup is cached from an incomplete forecast',
    file: AN,
    find: '  if (!forecast.structurallyIncomplete && cacheWritable()) multiDayCache = { ts: now, horizonDays, forecastTs: forecast.generatedAt, value };',
    to: '  if (cacheWritable()) multiDayCache = { ts: now, horizonDays, forecastTs: forecast.generatedAt, value }; /* MUTANT */',
    why: 'A rollup on the boot forecast is served for 30 min.',
  },
  {
    id: 'M-iii. ★★ the multi-day rollup is not bound to its forecast',
    file: AN,
    find: '    (forecast == null || multiDayCache.forecastTs === forecast.generatedAt)\n  )',
    to: '    true /* MUTANT */\n  )',
    why: 'A rollup stands 30 min after the forecast it was built on is rebuilt.',
  },
  {
    id: 'M-iv. ★★ the dispatch plan is cached from an incomplete forecast',
    file: AN,
    find: '  if (!forecast.structurallyIncomplete) dispatchCache = { ts: now, forecastTs: forecast.generatedAt, value };',
    to: '  dispatchCache = { ts: now, forecastTs: forecast.generatedAt, value }; /* MUTANT */',
    why: 'A plan on the boot forecast is served for 30 min.',
  },
  {
    id: 'M-v. ★★ the dispatch plan is not bound to its forecast',
    file: AN,
    find: '      && (forecast == null || dispatchCache.forecastTs === forecast.generatedAt)) return dispatchCache.value;',
    to: '      ) return dispatchCache.value; /* MUTANT */',
    why: 'A plan stands 30 min after the forecast it was planned on is rebuilt.',
  },
  // ── the worker ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'W-i. ★ the warm pass runs on the bare device list',
    file: WK,
    find: 'const hasProjections = () => Object.values(snapshot.devices).some((d) => d?.projection != null);',
    to: 'const hasProjections = () => Object.keys(snapshot.devices).length > 0; /* MUTANT */',
    why: 'The first warm pass scans every report over a map with no projection.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill is never a
// load flake elsewhere in the suite.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-18d', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false });
