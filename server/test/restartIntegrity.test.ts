import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isBootRetrack } from '../src/alertMonitor.js';

/**
 * v1.130.0 — what 15 restarts in one afternoon did to the alarm telemetry.
 *
 * The 2026-09-04 release run shipped 13 versions. Each restart was individually
 * cheap (~7.5 s of downtime) but collectively they corrupted the counters the
 * auto-silencer reasons over, and voided a night's held alerts.
 */

const BOOT = 1_788_576_000_000;

/* ── a restart is not a rising edge ───────────────────────────────────────── */

test('THE MEASURED DEFECT: an alert standing before this process is not a new rise', () => {
  // Replay counter went 3862 -> 4031 across 15 restarts: +169 rises in 3.5 h
  // against +32 in the preceding 18 h, purely from restarting.
  assert.equal(isBootRetrack({ firstRun: true, priorOnsetMs: BOOT - 3_600_000, bootMs: BOOT }), true);
});

test('a genuinely NEW alert on the first tick still counts as a rise', () => {
  // No persisted onset => the condition began now, restart or not.
  assert.equal(isBootRetrack({ firstRun: true, priorOnsetMs: undefined, bootMs: BOOT }), false);
});

test('an onset stamped AFTER boot is this process\'s own — still a rise', () => {
  assert.equal(isBootRetrack({ firstRun: true, priorOnsetMs: BOOT + 5_000, bootMs: BOOT }), false);
});

test('after the first tick, every rise counts — the exemption is boot-only', () => {
  assert.equal(isBootRetrack({ firstRun: false, priorOnsetMs: BOOT - 3_600_000, bootMs: BOOT }), false);
  assert.equal(isBootRetrack({ firstRun: false, priorOnsetMs: undefined, bootMs: BOOT }), false);
});

test('★ the exemption can only ever SUPPRESS a phantom, never a real rise', () => {
  // A rise is skipped only when firstRun AND a pre-boot onset exists. Any other
  // combination must record. Exhaustive over the input space.
  for (const firstRun of [true, false]) {
    for (const onset of [undefined, BOOT - 1, BOOT, BOOT + 1]) {
      const skip = isBootRetrack({ firstRun, priorOnsetMs: onset, bootMs: BOOT });
      if (skip) {
        assert.equal(firstRun, true, 'only ever on the first tick');
        assert.ok(onset != null && onset < BOOT, 'only ever for a pre-boot onset');
      }
    }
  }
});

/* ── structural guards for the wiring (no seam through evaluate()) ────────── */

const AM = readFileSync(resolve(import.meta.dirname, '../src/alertMonitor.ts'), 'utf8');

test('recordRise is actually gated on the predicate', () => {
  assert.match(AM, /if \(isBootRetrack\(\{ firstRun, priorOnsetMs: getAlertOnset\(a\.id\), bootMs \}\)\) \{/);
  assert.match(AM, /re-tracked across a restart — not counting a rise/);
});

test('THE 52x TRUNCATION: duration comes from the durable onset, not in-memory firstSeen', () => {
  // A backup-soc-40 episode true from 17:55:07 was filed as 128 s because a
  // restart landed 12 s before the clear and re-stamped firstSeen.
  assert.match(AM, /const trueFirstSeen = getAlertOnset\(id\) \?\? t\.firstSeen;/);
  assert.match(AM, /const duration = nowMs - trueFirstSeen;/);
  assert.match(AM, /raisedAt: trueFirstSeen,/);
  assert.match(AM, /overnightResolved\.set\(id, \{ raisedAt: trueFirstSeen/);
  assert.ok(!/const duration = nowMs - t\.firstSeen;/.test(AM), 'the in-memory source must be gone');
});

test('THE VOIDED NIGHT: a rehydrated hold still reaches the 06:00 digest', () => {
  // With CRITICAL_BREAKS_QUIET_HOURS off the digest is the ONLY delivery for a
  // 23:00-05:00 fire, criticals included.
  assert.match(AM, /t\.queued === true \|\| t\.queuedRehydrated === true/);
  assert.match(AM, /rehydratedHolds\.add\(a\.id\)/, 'rehydration must mark the id');
  assert.match(AM, /queuedRehydrated: rehydratedHolds\.has\(a\.id\) \|\| undefined,/,
    'and the re-tracked entry must carry it');
});

test('a rehydrated id that is no longer active does NOT re-enter pending', () => {
  // It belongs to the resolved list; re-queuing it would double-report.
  const filter = AM.slice(AM.indexOf('const pending = quietQueue.filter'));
  assert.match(filter.slice(0, 400), /if \(!t\) return false;/);
});

test('THE 16 STALE RECORDS: overnightResolved is cleared BEFORE it is persisted', () => {
  // Every one of 17 boots logged "16 resolved-overnight record(s)", including
  // boots after a digest had been sent, because persist ran before clear.
  const branches = [...AM.matchAll(/overnightResolved\.clear\(\);\s*\n\s*persistDigestState\(\)/g)];
  assert.equal(branches.length, 3, `all three digest exit branches must clear-then-persist; found ${branches.length}`);
  assert.ok(!/persistDigestState\(\); \/\/ v1\.86\.0\s*\n\s*overnightResolved\.clear\(\);/.test(AM),
    'no branch may persist before clearing');
});

/* ── the boot banner ──────────────────────────────────────────────────────── */

test('the add-on names its own build at boot', () => {
  const IDX = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.match(IDX, /ecoflow-panel v\$\{process\.env\.BUILD_VERSION \|\| 'dev'\}/,
    'a log that cannot identify its own build cannot answer "did that fix take?"');
  assert.match(IDX, /BUILD_REF/);
});
