#!/usr/bin/env node
/**
 * mutate-v1187-c.mjs — committed harness for v1.187.0 group C (alert engine): the MPPT
 * self-baseline warns only for an unexplained hot excursion (cooler-than-typical and
 * load-explained readings are on-screen only and feed no rollup), the MPPT families' old
 * telemetry is not replayed, an owed resolve is never gated by the auto-tune rules, a one-pass
 * alert-feed carry is not logged while failures, multi-pass and stuck carries are, and the
 * silent-critical line names the subject and the stamped mute reason.
 *
 * Review round: "load-explained" is bounded by the MPPT's own settled loaded temperature and its
 * cool-down (mpptLoadCeiling), an alert muted after its push still owes its resolve, the roster
 * mute's reason outranks a condition's, the silent-critical edge is keyed on (id, reason), and
 * the wiring (the monitor stamp, the spare split, the alerts.ts spare stamps, the blind-hold stamp,
 * the stuck-feed warn sink) is pinned end to end.
 *
 *   node scripts/mutate-v1187-c.mjs
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
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const AL = resolve(SERVER, 'src/alerts.ts');
const AT = resolve(SERVER, 'src/alertTelemetry.ts');

const SUBSET = [
  'test/mpptBaselineLoadGate.test.ts',
  'test/mpptFamilyTelemetryRebase.test.ts',
  'test/autoTuneOwedResolve.test.ts',
  'test/alertFeedCarryLogging.test.ts',
  'test/muteReasonLog.test.ts',
  'test/alertMonitorScopeAndFeeds.test.ts',
  'test/mpptLoadCeiling.test.ts',
  'test/owedResolveAfterMute.test.ts',
  'test/muteReasonWiring.test.ts',
  'test/notifyHygiene.test.ts',
];

const MUTANTS = [
  {
    id: 'i. ★★★ a cooler-than-typical MPPT is judged like a hot one',
    file: AN,
    find: "  if (p.dirSign < 0) return 'cooler';",
    to: '  /* MUTANT */',
    why: 'An idle Core at the reserve warns "32 °F below its typical" again: pushes, a yellow condition, and Rule 3 latched on the family (09-28).',
  },
  {
    id: 'ii. ★★★ missing load evidence reads as "explained"',
    file: AN,
    find: "  if (p.typicalActivityW == null || p.loadAgoMs == null) return 'anomalous';",
    to: "  if (p.typicalActivityW == null || p.loadAgoMs == null) return 'load-explained'; /* MUTANT */",
    why: 'A recorder gap or a null reading silences a hot MPPT that may be a cooling fault.',
  },
  {
    id: 'iii. ★★ any load at or above the typical is a load step (no margin)',
    file: AN,
    find: '    const step = typicalW + MPPT_LOAD_EXPLAINS_MIN_W;',
    to: '    const step = typicalW; /* MUTANT */',
    why: 'A hot MPPT at the SAME load as usual — the cooling-fault signature — goes on-screen only.',
  },
  {
    id: 'iv. ★★★ the plateau cap is dropped (more load on an already-loaded hour explains anything)',
    file: AN,
    find: "  if (p.typicalActivityW >= MPPT_LOAD_PLATEAU_W) return 'anomalous';",
    to: '  /* MUTANT */',
    why: 'A hot MPPT on an hour whose typical load is already on the plateau is read against a load step that explains nothing.',
  },
  {
    id: 'v. ★★ a load step from any time in 14 days still explains current heat (no lookback)',
    file: AN,
    find: "  if (p.loadAgoMs > MPPT_LOAD_RECENT_MS) return 'anomalous';",
    to: '  /* MUTANT */',
    why: 'Any past charge night keeps a residual allowance over every later hot MPPT: the mute has no evidence-based end.',
  },
  {
    id: 'vi. ★ a typical load from a handful of buckets',
    file: AN,
    find: '  const typicalW = hourly.length >= BASELINE_MIN_SAMPLES ? median(hourly) : null;',
    to: '  const typicalW = hourly.length > 0 ? median(hourly) : null; /* MUTANT */',
    why: 'Two idle buckets make a "typical 0 W" that explains away heat on thin history.',
  },
  {
    id: 'vii. ★★★ a quiet MPPT verdict keeps its warning severity',
    file: AN,
    find: "    const severity = t.sustained || mpptQuiet ? 'info' : (z >= Z_WARN ? 'warning' : 'info');",
    to: "    const severity = t.sustained ? 'info' : (z >= Z_WARN ? 'warning' : 'info'); /* MUTANT */",
    why: 'The idle-Core warnings return at warning tier on screen and in the digest.',
  },
  {
    id: 'viii. ★★★ a quiet MPPT verdict still annunciates',
    file: AN,
    find: '      ...(regime || mpptQuiet ? { annunciate: false } : {}),',
    to: '      ...(regime ? { annunciate: false } : {}), /* MUTANT */',
    why: 'Benign MPPT episodes feed the auto-tune rollups again and re-latch Rule 3 over the hot side.',
  },
  {
    id: 'ix. ★★ pack cell temperature becomes load-gated too',
    file: AN,
    find: "packNum: pk.num, packSn: pk.packSn, live: pk.temp == null ? null : cToF(pk.temp), floor: 9, transform: cToF, fmt: tempFmt });",
    to: "packNum: pk.num, packSn: pk.packSn, live: pk.temp == null ? null : cToF(pk.temp), floor: 9, transform: cToF, fmt: tempFmt, loadCoupled: true /* MUTANT */ });",
    why: 'A pack warming while electrically idle — the internal-fault signature — would be read as explained or benign.',
  },
  {
    id: 'x. ★★ a failed load read reads as a huge recent load',
    file: AN,
    find: '        a = { typicalW: null, recentMaxW: null, loadAgoMs: null, loadedRaw: new Map() };',
    to: '        a = { typicalW: 0, recentMaxW: 1e9, loadAgoMs: 0, loadedRaw: new Map() }; /* MUTANT */',
    why: 'A locked database silences every hot MPPT for the pass.',
  },
  {
    id: 'xi. ★ the load history is read for every MPPT deviation',
    file: AN,
    find: '    const activity = t.loadCoupled && t.live > med ? activityFor(t.sn, t.liveActivityW ?? null) : null;',
    to: '    const activity = t.loadCoupled ? activityFor(t.sn, t.liveActivityW ?? null) : null; /* MUTANT */',
    why: 'A 14-day bucketed read on every idle night for evidence the cool side never uses (the worker already misses its budget).',
  },
  {
    id: 'xii. ★★★ the pre-v1.187.0 MPPT telemetry is replayed',
    file: AM,
    find: '    if (basis != null && e.basis !== basis && opts.includeLegacy !== true) {',
    to: '    if (false /* MUTANT */) {',
    why: 'The idle-Core latch (10 rises, 6 long-active) keeps a hot-side LV-MPPT push silenced for 30 days.',
  },
  {
    id: 'xii-b. ★ the reset is silent at boot',
    file: AM,
    find: '    if (r.rebasedSkipped > 0) {',
    to: '    if (false /* MUTANT */) {',
    why: 'A lifted chronic-noise silence cannot be verified from the log (the v1.143.0 lesson: a guard indistinguishable from its absence).',
  },
  {
    id: 'xiii. ★★★ the write chokepoint does not stamp the basis',
    file: AT,
    find: "    appendFileSync(PATH, JSON.stringify(basis != null ? { ...entry, basis } : entry) + '\\n');",
    to: "    appendFileSync(PATH, JSON.stringify(entry) + '\\n'); /* MUTANT */",
    why: 'Every new MPPT event is discarded at the next boot: a genuinely chronic hot side can never re-earn its verdict.',
  },
  {
    id: 'xiv. ★★★ an owed resolve is gated by the family latch again',
    file: AM,
    find: "  if (kind === 'resolved') return pass; // v1.187.0 — an owed resolve carries the card's dismissal",
    to: '  /* MUTANT */',
    why: 'The 09-29 05:00:10 tick: the third same-family resolve is dropped and its pushed card stands.',
  },
  {
    id: 'xv. ★★ every one-pass budget carry is logged',
    file: AM,
    find: "        if (!carryLogged && (outcome === 'failed' || carriedPasses >= ALERT_FEED_CARRY_LOG_PASSES)) {",
    to: '        if (!carryLogged) { /* MUTANT */',
    why: 'The 630 routine carry/fresh pairs return (54% of the add-on log).',
  },
  {
    id: 'xvi. ★★★ a failed read waits for a second pass to be logged',
    file: AM,
    find: "        if (!carryLogged && (outcome === 'failed' || carriedPasses >= ALERT_FEED_CARRY_LOG_PASSES)) {",
    to: '        if (!carryLogged && carriedPasses >= ALERT_FEED_CARRY_LOG_PASSES) { /* MUTANT */',
    why: 'A worker that throws once and recovers leaves no trace at all.',
  },
  {
    id: 'xvii. ★★★ a stuck feed is never called out',
    file: AM,
    find: '        if (!carryWarned && carriedPasses >= ALERT_FEED_STUCK_WARN_PASSES) {',
    to: '        if (false /* MUTANT */) {',
    why: 'A wedged worker holds five alert families at a stale age with one info line and nothing louder.',
  },
  {
    id: 'xviii. ★ "fresh again" for a carry nobody was told about',
    file: AM,
    find: "        if (carryLogged) log(`alert-feed: ${name} fresh again after ${carriedPasses} pass(es) on its last good value`);",
    to: "        log(`alert-feed: ${name} fresh again after ${carriedPasses} pass(es) on its last good value`); /* MUTANT */",
    why: 'Half of every routine pair comes back: 315 orphan "fresh again" lines per 42 h.',
  },
  {
    id: 'xix. ★★ the silent-critical line blames a fixed policy',
    file: AM,
    find: "  const reason = a.muteReason ?? (a.mutedBy != null ? CELL_SPREAD_MUTE_TEXT[a.mutedBy] : 'by policy — reason not recorded');",
    to: "  const reason = 'bench spare or off-panel Core'; /* MUTANT */",
    why: 'The 09-29 15:29 lines again blame a spare for a home pack muted while balancing.',
  },
  {
    id: 'xx. ★★ the silent-critical line names no device or pack',
    file: AM,
    find: '  const subject = notifyLocator(a);',
    to: "  const subject = ''; /* MUTANT */",
    why: 'Three critical lines in five minutes cannot be told apart.',
  },
  {
    id: 'xxi. ★ the monitor gate calls every mute off-panel',
    file: AM,
    find: '  return mutedSpareSns.some((sn) => alert.id.includes(sn)) ? MUTE_REASON_BENCH_SPARE : MUTE_REASON_OFF_PANEL;',
    to: '  return MUTE_REASON_OFF_PANEL; /* MUTANT */',
    why: 'A bench spare is reported as a home Core missing from the panel roster.',
  },
  {
    id: 'xxii. ★★ the balancing mute carries no reason',
    file: AL,
    find: '          ? { annunciate: false, muteReason: balancing ? MUTE_REASON_BALANCING : MUTE_REASON_PLATEAU }',
    to: '          ? { annunciate: false } /* MUTANT */',
    why: 'The silent-critical line for a balancing home pack reads "reason not recorded".',
  },
  /* ── review round ─────────────────────────────────────────────────────── */
  {
    id: 'xxiii. ★★★ "load-explained" has no temperature ceiling',
    file: AN,
    find: "  return p.live <= ceiling ? 'load-explained' : 'anomalous';",
    to: "  return 'load-explained'; /* MUTANT */",
    why: 'An outage-night MPPT cooling failure at 144 °F during a 5 kW charge on an idle-typical hour is info and silent.',
  },
  {
    id: 'xxiv. ★★★ the allowance never cools down after the load stops',
    file: AN,
    find: '  return p.typical + span * Math.exp(-Math.max(0, p.loadAgoMs) / MPPT_COOL_TAU_MS) + p.floor;',
    to: '  return p.typical + span + p.floor; /* MUTANT */',
    why: 'Up to 6 h after a charge, an idle Core\'s MPPT may run at its full loaded temperature + floor with no warning.',
  },
  {
    id: 'xxv. ★★ a past load step reads as a load running now',
    file: AN,
    find: '      if (lastTs != null) loadAgoMs = Math.max(0, nowMs - (lastTs + bucketMs));',
    to: '      if (lastTs != null) loadAgoMs = 0; /* MUTANT */',
    why: 'The cool-down envelope never starts: the full loaded allowance stands for the whole lookback.',
  },
  {
    id: 'xxvi. ★★ the loaded reference is the hottest settled bucket, not the upper quartile',
    file: AN,
    find: '  return s[Math.floor(0.75 * (s.length - 1))];',
    to: '  return s[s.length - 1]; /* MUTANT */',
    why: 'One hot session (or a fault\'s own buckets) lifts the ceiling for the whole 14-day window.',
  },
  {
    id: 'xxvii. ★★ the default reference is raised',
    file: AN,
    find: 'export const MPPT_LOADED_REF_FALLBACK_F = 122;',
    to: 'export const MPPT_LOADED_REF_FALLBACK_F = 140; /* MUTANT */',
    why: 'A Core with thin loaded history quiets a 144 °F MPPT under load.',
  },
  {
    id: 'xxviii. ★★★ a mute after the push strands the card again',
    file: AM,
    find: '    t.pushSent === true &&\n    notifyResolved &&',
    to: '    t.pushSent === true &&\n    (t.alert as { annunciate?: boolean }).annunciate !== false && /* MUTANT */\n    notifyResolved &&',
    why: 'A pushed MPPT warning re-tracked as a cooler reading at the deploy (or turned load-explained) never gets its "Resolved:".',
  },
  {
    id: 'xxix. ★★ a condition mute\'s reason outranks the roster\'s',
    file: AM,
    find: '  } else if (a.annunciate === false && !isNeverMutedAlert(a) && mutedSns.some((sn) => a.id.includes(sn))) {',
    to: '  } else if (false /* MUTANT */) {',
    why: 'An off-panel Core\'s pack critical raised while balancing is logged as balancing — and never re-logged once only the roster mutes it.',
  },
  {
    id: 'xxx. ★★ the silent-critical edge is keyed on the id alone',
    file: AM,
    find: "  const keyOf = (a: T): string => `${a.id}|${a.muteReason ?? ''}`;",
    to: '  const keyOf = (a: T): string => a.id; /* MUTANT */',
    why: 'A critical whose muting policy changes mid-episode goes on being described by the first one.',
  },
  {
    id: 'xxxi. ★★ the monitor\'s roster demotion stamps no reason',
    file: AM,
    find: '    a.annunciate = false;\n    a.muteReason = monitorMuteReason(a, mutedSpareSns);',
    to: '    a.annunciate = false; /* MUTANT */',
    why: 'Every off-panel and bench-spare critical is logged "by policy — reason not recorded".',
  },
  {
    id: 'xxxii. ★★ the monitor loses track of which muted serials are spares',
    file: AM,
    find: '      mutedSpareSns = multiPanel ? [] : mutedSpares;',
    to: '      mutedSpareSns = []; /* MUTANT */',
    why: 'A bench spare is reported as a home Core missing from the panel roster.',
  },
  {
    id: 'xxxiii. ★ the telemetry-blind hold stamps no reason',
    file: AM,
    find: '        if (remediation.hold) for (const a of blindAlerts) a.muteReason = MUTE_REASON_REMEDIATION;',
    to: '        /* MUTANT */',
    why: 'The one annunciate:false site left without a reason; DOCS says every site names its mute.',
  },
  {
    id: 'xxxiv. ★★ the offline bench-spare stamp names no reason',
    file: AL,
    find: '        ...(spare ? { annunciate: false, muteReason: MUTE_REASON_BENCH_SPARE } : {}),\n        ...(onsetHeld ? {',
    to: '        ...(spare ? { annunciate: false } : {}), /* MUTANT */\n        ...(onsetHeld ? {',
    why: 'An offline spare\'s mute is unnamed.',
  },
  {
    id: 'xxxv. ★★ the stale bench-spare stamp names no reason',
    file: AL,
    find: "        ...(spare ? { annunciate: false, muteReason: MUTE_REASON_BENCH_SPARE } : {}),\n      });\n    }\n  }\n\n  for (const d of dpus) {",
    to: "        ...(spare ? { annunciate: false } : {}), /* MUTANT */\n      });\n    }\n  }\n\n  for (const d of dpus) {",
    why: 'A stale spare\'s mute is unnamed.',
  },
  {
    id: 'xxxvi. ★★ the online bench-spare stamp leaves a balancing reason in place',
    file: AL,
    find: '        out[i].muteReason = MUTE_REASON_BENCH_SPARE;',
    to: '        /* MUTANT */',
    why: 'A spare pack critical muted by policy for good is logged as "the BMS is balancing the cells".',
  },
  {
    id: 'xxxvii-a. ★★ the forecast feed\'s stuck WARNING goes to the info log',
    file: AM,
    find: "  const feedForecast = createLastGoodFeed<DayForecast>('forecast', log, undefined, workerHydrated, warn);",
    to: "  const feedForecast = createLastGoodFeed<DayForecast>('forecast', log, undefined, workerHydrated); /* MUTANT */",
    why: 'A wedged worker is reported at info level, where a WARNING filter never sees it.',
  },
  {
    id: 'xxxvii-b. ★★ the curtailmentAlerts feed\'s stuck WARNING goes to the info log',
    file: AM,
    find: "  const feedCurtailment = createLastGoodFeed<Alert[]>('curtailmentAlerts', log, undefined, workerHydrated, warn);",
    to: "  const feedCurtailment = createLastGoodFeed<Alert[]>('curtailmentAlerts', log, undefined, workerHydrated); /* MUTANT */",
    why: 'A wedged worker is reported at info level, where a WARNING filter never sees it.',
  },
  {
    id: 'xxxvii-c. ★★ the baselineAlerts feed\'s stuck WARNING goes to the info log',
    file: AM,
    find: "  const feedBaseline = createLastGoodFeed<Alert[]>('baselineAlerts', log, undefined, workerHydrated, warn);",
    to: "  const feedBaseline = createLastGoodFeed<Alert[]>('baselineAlerts', log, undefined, workerHydrated); /* MUTANT */",
    why: 'A wedged worker is reported at info level, where a WARNING filter never sees it.',
  },
  {
    id: 'xxxvii-d. ★★ the forecastAlerts feed\'s stuck WARNING goes to the info log',
    file: AM,
    find: "  const feedForecastAlerts = createLastGoodFeed<Alert[]>('forecastAlerts', log, undefined, workerHydrated, warn);",
    to: "  const feedForecastAlerts = createLastGoodFeed<Alert[]>('forecastAlerts', log, undefined, workerHydrated); /* MUTANT */",
    why: 'A wedged worker is reported at info level, where a WARNING filter never sees it.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-c', mutants: MUTANTS, subset: SUBSET, root: REPO });
