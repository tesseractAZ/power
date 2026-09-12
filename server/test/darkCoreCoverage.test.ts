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
  const sweep = src.slice(i, i + 700);
  assert.match(sweep, /if \(isBenchSpareSn\(sn\)\) continue;/, 'a bench spare is dark by design and must be exempt');
  assert.match(sweep, /detectTelemetryGap\(lastMs, now, PER_DEVICE_GAP_THRESHOLD_MS\)/);
  assert.match(sweep, /recordTelemetryGap\(lastMs, now, \{ sn \}\)/, 'the record must name the silent SN');
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
