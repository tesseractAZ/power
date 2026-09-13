import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.150.0 — the dark-core cluster.
 *
 * THE EPISODE. Core 2 (Y711ZAB59GBC0482) recorded ZERO samples of EVERY metric
 * from 2026-08-11 to 2026-08-19 — nine days, a third of the wired fleet. Nothing
 * alerted, nothing logged, and no telemetry-gap record was written, because the
 * fleet gap detector sets `sawHomeInsert` on ANY non-bench home SN: Cores 1 and 3
 * kept writing, so the fleet clock was reset on every batch and a single-core
 * blackout was invisible to it BY CONSTRUCTION.
 *
 * The silence surfaced six weeks later, from a forecast table, only because it
 * had corrupted the night-charge basis gate: sums taken over the fleet during
 * that window returned ~32% of true production, and the resulting phantom
 * "forecast misses" saturated the PV band calibrator and closed the gate.
 *
 * These tests pin the three guards that episode showed were missing. They are
 * deliberately about the DARK case, not the healthy one — the healthy case
 * already passed throughout.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-darkcore-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { coreCoverageByDay } = await import('../src/analytics.js');

const DAY = 86_400_000;
const HOUR = 3_600_000;

/* ── 1. a day on which EVERY core was skipped is NOT "covered" ─────── */

test('v1.150.0 — a day where every core is skipped reports covered:FALSE, not true', () => {
  // The REAL shape of this case, not a guessed one. On 2026-08-12 the roster's
  // cores each had their first in-window sample on 08-20, so every one of them
  // was skipped by skipBeforeJoin on that day — while still being present in
  // the map, because they DID report later in the window.
  //
  // Previously `covered` stayed at its `true` initialiser: the only write to
  // false lives inside the loop body the skip bypasses. So a day with full
  // daylight and NOT ONE evaluated core was published as covered, with
  // worstSn/worstFrac null so the row carried no hint either.
  const todayStart = 1_789_110_000_000;            // window is [todayStart-30d, todayStart-1d]
  const dayStart = todayStart - 30 * DAY;          // the earliest day in the window
  const hourIdx = (ms: number) => Math.floor(ms / HOUR);

  const ghiByEpoch = new Map<number, number>();
  for (let h = 7; h <= 17; h++) ghiByEpoch.set(hourIdx(dayStart + h * HOUR), 600);

  // Both cores report ONLY later in the window — in-window (so they survive the
  // `first == null` drop and land in presentBySn) but after dayStart's end.
  const joinTs = todayStart - 5 * DAY + 9 * HOUR;
  const pvBySn = new Map<string, Array<{ ts: number; value: number }>>([
    ['CORE_A', [{ ts: joinTs, value: 3000 }]],
    ['CORE_B', [{ ts: joinTs, value: 3000 }]],
  ]);

  const out = coreCoverageByDay(ghiByEpoch, pvBySn, todayStart, 30, 0.8, true);
  const day = out.get(dayStart);
  assert.ok(day, 'the day must be present in the map');
  assert.equal(day!.daylightHours, 11, 'precondition: the day has full daylight');
  assert.equal(day!.covered, false, 'a day nobody measured is not a covered day');
});

test('v1.150.0 — the all-skipped guard does NOT fire when at least one core is evaluated', () => {
  // Regression bound: the new `evaluated === 0` clause must not turn a day with
  // one healthy reporting core into a gap. Only the all-skipped case changes.
  const todayStart = 1_789_110_000_000;
  const dayStart = todayStart - 30 * DAY;
  const hourIdx = (ms: number) => Math.floor(ms / HOUR);

  const ghiByEpoch = new Map<number, number>();
  for (let h = 7; h <= 17; h++) ghiByEpoch.set(hourIdx(dayStart + h * HOUR), 600);

  // CORE_A joined BEFORE this day and reports every daylight hour of it.
  const aPts: Array<{ ts: number; value: number }> = [];
  for (let h = 7; h <= 17; h++) aPts.push({ ts: dayStart + h * HOUR, value: 3000 });
  const pvBySn = new Map<string, Array<{ ts: number; value: number }>>([
    ['CORE_A', aPts],
    ['CORE_B', [{ ts: todayStart - 5 * DAY + 9 * HOUR, value: 3000 }]],   // skipped on this day
  ]);

  const out = coreCoverageByDay(ghiByEpoch, pvBySn, todayStart, 30, 0.8, true);
  assert.equal(out.get(dayStart)!.covered, true);
});

/* ── 2. the DURABLE ledger PV sum is coverage-gated ────────────────── */

test('★ SOURCE PIN: the night-charge ledger PV sum is gated on WORST per-core coverage', () => {
  // This sum is assembled inside a long closure over module singletons in
  // index.ts with no injection seam, so this follows the repo's convention for
  // un-reachable call sites (cf. the refreshAll pin in
  // pollHealthAttribution.test.ts).
  //
  // It matters because the column is DURABLE. `actual_pv_kwh` is written into
  // the never-pruned night-charge ledger and feeds `pv_err_frac` / `pv_in_band`
  // (readiness band coverage) and, via `buy_err_kwh`, the HARD under-buy safety
  // criterion. A skill-report error ages out of a 30-day window; a bad ledger
  // row is durable safety evidence and does not.
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/index.ts'), 'utf8');

  assert.match(
    src,
    /export const PV_LEDGER_MIN_CORE_COVERAGE = 0\.9;/,
    'the ledger coverage floor must be a NAMED constant, not an anonymous literal',
  );
  // Bound the search on the block itself rather than a fixed character window —
  // a window wide enough today stops reaching the code as the comment above it
  // grows (the failure mode that hid an earlier source assertion).
  const i = src.indexOf('let actualPvKwh: number | null = null;');
  assert.ok(i > 0, 'the ledger PV assembly must still be findable');
  const block = src.slice(i, i + 1400);
  assert.match(
    block,
    /worstCov = Math\.min\(worstCov, coverageFrac\(/,
    'coverage must be reduced with MIN across cores — a mean lets one dark core in three read as a healthy 0.67',
  );
  assert.match(
    block,
    /actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE \? round2\(pvWh \/ 1000\) : null;/,
    'below the floor the ledger must record NULL, never a deflated fleet sum',
  );
});

/* ── 3. the recorder detects a PER-DEVICE blackout ─────────────────── */

test('★ SOURCE PIN: the recorder sweeps for per-device silence, not just fleet silence', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/recorder.ts'), 'utf8');

  assert.match(src, /const PER_DEVICE_GAP_THRESHOLD_MS = /, 'a per-device threshold must exist');
  assert.match(src, /const lastInsertBySn = new Map<string, number>\(\);/, 'per-SN clocks must exist');

  // The sweep must be driven by ANY home write, not by the dark SN's own writes
  // — a dark core writes nothing, so an insert-triggered check on its own
  // inserts could never fire. That is precisely why the fleet clock is useless
  // here and this loop is necessary.
  const i = src.indexOf('for (const [sn, lastMs] of lastInsertBySn)');
  assert.ok(i > 0, 'the per-device staleness sweep must be present');
  const sweep = src.slice(i, i + 1400);
  assert.match(sweep, /if \(isBenchSpareSn\(sn\)\) continue;/, 'a bench spare is dark by design and must be exempt');
  // v1.154.0 — the threshold applies to darkMs, which leaves out the add-on's own
  // downtime for a device still on its seeded clock (driven in seedAndBootPhases.test.ts).
  assert.match(sweep, /if \(darkMs > PER_DEVICE_GAP_THRESHOLD_MS\)/);
  assert.match(sweep, /recordTelemetryGap\(lastMs, Math\.max\(now, lastMs \+ darkMs\), \{ sn \}\)/, 'the record must name the silent SN');
  assert.match(sweep, /perDeviceGapOpen\.add\(sn\)/, 'one blackout must yield ONE record, not one per batch');

  // And the gap record must carry the SN, or a per-device gap is
  // indistinguishable from a fleet one in the sidecar.
  assert.match(src, /sn\?: string;/, 'TelemetryGap must carry the optional sn');
  assert.match(src, /DEVICE TELEMETRY GAP/, 'the per-device log line must not reuse the fleet stem');
});

test('v1.150.0 — the per-device threshold is far above a routine reconnect and far below the episode', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/recorder.ts'), 'utf8');
  const m = src.match(/const PER_DEVICE_GAP_THRESHOLD_MS = ([^;]+);/);
  assert.ok(m, 'threshold must be findable');
  // eslint-disable-next-line no-eval -- a literal arithmetic expression from our own source
  const ms = eval(m![1]) as number;
  const hours = ms / 3_600_000;
  // A single core drops its cloud session and returns routinely (the documented
  // WiFi-loss / MQTT-wedge behaviour), so a fleet-style 15-minute bar would be
  // pure noise. The episode this exists to catch was NINE DAYS.
  assert.ok(hours >= 1, `per-device threshold ${hours}h must be well above a routine reconnect`);
  assert.ok(hours <= 24, `per-device threshold ${hours}h must be well below the 9-day blackout it exists to catch`);
});

/* ── v1.152.0 — what the log audit found in v1.150.0 itself ──────────── */

test('★ v1.152.0 — per-device gap clocks are SEEDED from persisted samples at boot', () => {
  // THE DEFECT THE AUDIT FOUND IN v1.150.0. `lastInsertBySn` was created empty on
  // every start and written only by an in-process insert from that SN. A device
  // that is ALREADY DARK when the process starts never writes, so it never entered
  // the Map the sweep iterates — and the sweep was therefore blind to exactly the
  // case it was built for.
  //
  // This is not a corner case: the nine-day Core 2 blackout spans restarts by
  // definition, and the add-on booted ELEVEN times in the 48 h window the audit
  // examined. Unseeded, the detector covered only a blackout that both begins
  // mid-run AND persists 6 h inside that same process.
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/recorder.ts'), 'utf8');

  // v1.154.0 — what this test used to pin (a GROUP BY scan whose query excluded bench
  // spares) was itself three defects: 5.8 s of unmeasured boot, Core 5 excluded by a
  // stale literal, and a false gap for every device after a >6 h outage. The BEHAVIOUR
  // is now driven end to end in seedAndBootPhases.test.ts. What stays here is what a
  // behavioural test cannot reach without a seam: the scan shape, and a loud failure.
  const i = src.indexOf("const tSetup = phase('setup');");
  const j = src.indexOf("const tSeed = phase('seed');", i);
  assert.ok(i > 0 && j > i, 'the seed must sit between its own phase marks');
  const block = src.slice(i, j);
  assert.doesNotMatch(block, /GROUP BY/, 'a GROUP BY over samples visits every index entry — 5.8 s per boot on the live Pi');
  // v1.154.0 review — the statements live in SEED_SQL, whose query PLANS
  // seedAndBootPhases.test.ts asserts. Here: the seed prepares those five and nothing else.
  assert.equal((block.match(/db\.prepare\(SEED_SQL\.\w+\)/g) ?? []).length, 5, 'the seed must prepare the five SEED_SQL statements');
  assert.equal((block.match(/db\.prepare\(/g) ?? []).length, 5, 'and no other statement');
  // A silent seeding failure would restore v1.150.0 blindness with no trace. Pin
  // the log CALL, not the message text — a mutant that keeps the string but never
  // emits it satisfies a bare text match while being exactly as silent.
  assert.match(block, /\blog\(`recorder: per-device gap clock seeding FAILED/,
    'a failed seed must SAY so — an unseeded sweep looks identical to a working one');
});

test('★ v1.152.0 — the inert boot pre-warm is GONE, not merely gated', () => {
  // v1.151.0 fired analytics.report('equipmentHealth') right after listen. The
  // audit measured it completing in 578 ms and 694 ms against its own comment
  // claiming a 9,007 ms cold scan: the request was posted before the store's first
  // 'change', so the worker still held `devices: {}`, allDpus({}) returned [], and
  // `if (dpus.length > 0)` declined to cache. It warmed nothing and logged success.
  //
  // Deleted rather than repaired because the machinery already existed and was not
  // checked for — `equipmentHealth` is in WARM_REPORTS and the worker's firstWarm
  // polls until hasDevices() is true. A second warmer here would duplicate it and
  // reintroduce the same race.
  const __dir = dirname(fileURLToPath(import.meta.url));
  const idx = readFileSync(resolve(__dir, '../src/index.ts'), 'utf8');
  assert.doesNotMatch(idx, /void analytics\.report\('equipmentHealth'\)/,
    'the boot pre-warm call must be gone');
  assert.doesNotMatch(idx, /log\.info\(`analytics: equipment-health pre-warmed/,
    'and with it the unconditional success line');

  // The machinery it duplicated must still be there, or removing it regresses warmth.
  const reports = readFileSync(resolve(__dir, '../src/reports.ts'), 'utf8');
  assert.match(reports, /'equipmentHealth',/, 'equipmentHealth must remain in WARM_REPORTS');
  const worker = readFileSync(resolve(__dir, '../src/analyticsWorker.ts'), 'utf8');
  assert.match(worker, /if \(hasDevices\(\)\) \{ clearInterval\(firstWarm\); void warm\(\); \}/,
    'the worker firstWarm must still gate on a NON-EMPTY snapshot — the thing the pre-warm got wrong');
});

test('★ v1.152.0 — the boot window is instrumented per phase', () => {
  // The audit measured 9.3–30.2 s of fully blocked boot (no HTTP, MQTT, poll or
  // alarm evaluation) with NOTHING logged inside it. ANALYZE is the leading
  // suspect — its justifying comment is stale on both counts ("a single index";
  // "single-digit ms") — but that is a hypothesis, so measure before deleting a
  // query that keeps the planner honest on a 1.72 GB table.
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/recorder.ts'), 'utf8');
  assert.match(src, /recorder: boot phases — \$\{tOpen\}, \$\{tSchema\}, \$\{tAnalyze\}/,
    'all three phases must be reported, or the measurement cannot attribute the cost');
  // The phases must be captured at the right places to be attributable at all.
  assert.match(src, /const db = new DatabaseSync\(dbPath\);\s*\n\s*const tOpen = phase\('open'\);/,
    'open must be timed around the DatabaseSync constructor');
  assert.match(src, /const tAnalyze = phase\('analyze'\);/,
    'analyze must be timed separately from schema+migrations');
});

test('★ v1.153.0, CORRECTED in v1.156.0 — no sampling bound and no unconditional ANALYZE on the boot path', () => {
  // v1.152.0's instrumentation measured the boot window on the live Pi:
  //   "recorder: boot phases — open 0ms, schema+migrations 1ms, analyze 9725ms"
  // v1.154.0 CORRECTION: that line was emitted before a 5,807 ms seed, so ANALYZE was
  // 62.6% of the blocked boot — not the 99.99% first written here. Still the largest
  // phase of a window with no HTTP listener, no MQTT ingest, no poll and no alarm
  // evaluation.
  // v1.156.0 CORRECTION: this test used to pin `PRAGMA analysis_limit=400` ahead of
  // `ANALYZE samples`, on the strength of "ANALYZE took 3,415 ms on the next boot". That
  // was a restart 13 min after another. The next boot after an image pull measured
  // `analyze 10785ms` with the bound in place: ANALYZE takes an exact count of each
  // index before the bounded scan, and the count reads every page. The bound cut the
  // CPU, not the page reads, and it truncated the stats. The replacement is DRIVEN in
  // bootPlannerStats.test.ts; this keeps the retired mechanism from returning.
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/recorder.ts'), 'utf8');

  // SOURCE assertions, labelled as such. They match the call construct, not the words,
  // so the comment that records this history cannot trip them.
  assert.doesNotMatch(src, /db\.exec\(`\s*PRAGMA analysis_limit/,
    'the sampling bound must not return — it bounds CPU, not the page reads, and truncates the stats');
  assert.doesNotMatch(src, /db\.exec\(`\s*ANALYZE samples/,
    'no unconditional ANALYZE on the boot path — it reads every samples index page on every boot');

  // The instrumentation that produced the measurement must survive, or the next
  // regression is invisible again.
  assert.match(src, /recorder: boot phases — \$\{tOpen\}, \$\{tSchema\}, \$\{tAnalyze\}/,
    'keep the per-phase timing — it is how this was found and how a regression would be');
});
