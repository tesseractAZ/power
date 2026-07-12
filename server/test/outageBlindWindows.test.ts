/**
 * v1.13.0 — engine-review fixes F10 (outage ledger missed sub-15-min &
 * restart-erased & clock-skewed blackouts) + F22 (any blackout < 15 min was
 * structurally invisible to the operator outage tiles).
 *
 * Ground truth from the recorder DB: 2 of 6 real ≥15-min blackouts were missed
 * (incl. the LONGEST, 94.5 min) and an 11.1-min deploy blackout left all three
 * 24h outage counters at ZERO — because the restart-spanning boot check used the
 * 15-min in-process threshold and silently dropped a clock-skewed (negative-delta)
 * boot. The fix gives the RESTART path a tighter 5-min floor and DEFERS a
 * clock-skewed boot to the first post-NTP insert instead of dropping it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

// DB_PATH must be set BEFORE any app module is imported — config.ts reads it once
// at import, and alerts.js transitively pulls config in — so the schema lands in
// this temp dir (not the default /data path). Every app import below is dynamic.
const tmp = mkdtempSync(join(tmpdir(), 'ef-blind-window-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { classifyRestartGap, createRecorder } = await import('../src/recorder.js');
const { outageAlerts, outageTracking } = await import('../src/alerts.js');

const MIN = 60_000;
const RESTART_FLOOR = 5 * MIN; // recorder RESTART_GAP_FLOOR_MS (one heartbeat interval)

/* ── F10/F22: the pure boot-gap classifier (record / defer / none) ───────── */

test('classifyRestartGap — a gap ≥ the restart floor records (even when < the old 15-min threshold)', () => {
  const maxTs = 1_000_000_000_000;
  const boot = maxTs + 8 * MIN; // 8 min: below 15 (old miss) but above the 5-min restart floor
  const d = classifyRestartGap(maxTs, boot, RESTART_FLOOR);
  assert.deepEqual(d, { kind: 'record', startMs: maxTs, endMs: boot });
});

test('classifyRestartGap — a quick clean restart (< floor) records nothing (routine deploy)', () => {
  const maxTs = 1_000_000_000_000;
  assert.deepEqual(classifyRestartGap(maxTs, maxTs + 2 * MIN, RESTART_FLOOR), { kind: 'none' });
  assert.deepEqual(classifyRestartGap(maxTs, maxTs + RESTART_FLOOR - 1, RESTART_FLOOR), { kind: 'none' });
});

test('classifyRestartGap — F10b: boot clock BEHIND the last sample DEFERS (never silently dropped)', () => {
  const maxTs = 1_000_000_000_000;
  // RTC-less Pi pre-NTP: boot clock is 3 min behind the newest persisted sample.
  const d = classifyRestartGap(maxTs, maxTs - 3 * MIN, RESTART_FLOOR);
  assert.deepEqual(d, { kind: 'defer', anchorMs: maxTs }, 'a negative delta must defer to the first post-NTP insert, not vanish');
});

test('classifyRestartGap — no prior sample (fresh/empty DB) is a no-op', () => {
  assert.deepEqual(classifyRestartGap(null, Date.now(), RESTART_FLOOR), { kind: 'none' });
  assert.deepEqual(classifyRestartGap(Number.NaN, Date.now(), RESTART_FLOOR), { kind: 'none' });
});

test('classifyRestartGap — exactly at the floor records (inclusive boundary)', () => {
  const maxTs = 1_000_000_000_000;
  assert.deepEqual(classifyRestartGap(maxTs, maxTs + RESTART_FLOOR, RESTART_FLOOR), {
    kind: 'record', startMs: maxTs, endMs: maxTs + RESTART_FLOOR,
  });
});

/* ── F22: a sub-15-min restart blackout is now ledgered end-to-end ───────── */

const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');

function makeStore() {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: Date.now(), devices: {} };
  ee.get = () => ee.snap;
  return ee;
}
function makeRecorder() {
  const lines: string[] = [];
  const rec = createRecorder(makeStore() as any, (m: string) => lines.push(m));
  return { rec, lines };
}
function withRawDb(fn: (db: InstanceType<typeof DatabaseSync>) => void) {
  const db = new DatabaseSync(DB_PATH);
  try { fn(db); } finally { db.close(); }
}

// createRecorder creates the `samples` table on first boot; run one throwaway
// recorder against the empty DB (records nothing) so the raw surgery below has a
// schema to write to — mirrors how a real restart shares an existing /data DB.
makeRecorder().rec.close();

test('recorder boot — an 8-min restart blackout (F22 deploy case) is now ledgered restart-spanning', () => {
  if (existsSync(GAPS_PATH)) unlinkSync(GAPS_PATH);
  const staleMs = 8 * MIN; // the exact structural blind spot: 5 ≤ 8 < 15
  const staleTs = Date.now() - staleMs;
  withRawDb((db) => {
    db.exec('DELETE FROM samples');
    db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)').run(staleTs, 'DPU_HOME', 'soc', 50);
  });

  const { rec, lines } = makeRecorder(); // the "restart"
  const gaps = rec.telemetryGaps();
  assert.equal(gaps.length, 1, `an 8-min restart gap must now be recorded (was ZERO pre-fix); got ${gaps.length}`);
  assert.equal(gaps[0].restartSpanning, true, 'marked restart-spanning (the alarm was DOWN)');
  assert.equal(gaps[0].startMs, staleTs, 'gap starts at the last pre-restart home sample');
  assert.ok(gaps[0].durationMs >= staleMs, `duration ≈ ${staleMs}ms; got ${gaps[0].durationMs}`);
  assert.ok(lines.some((l) => /TELEMETRY GAP/.test(l) && /spanning a restart/.test(l)), 'logs the restart-spanning gap line');
  rec.close();
});

test('recorder boot — a 2-min quick restart stays silent (routine deploy, no false outage)', () => {
  if (existsSync(GAPS_PATH)) unlinkSync(GAPS_PATH);
  withRawDb((db) => {
    db.exec('DELETE FROM samples');
    db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)').run(Date.now() - 2 * MIN, 'DPU_HOME', 'soc', 51);
  });
  const { rec, lines } = makeRecorder();
  assert.deepEqual(rec.telemetryGaps(), [], 'a sub-floor restart must not ledger a gap');
  assert.equal(lines.filter((l) => /TELEMETRY GAP/.test(l)).length, 0, 'no gap line for a routine quick restart');
  assert.equal(existsSync(GAPS_PATH), false, 'sidecar not created for a non-gap');
  rec.close();
});

/* ── F10: the sub-15-min restart gap now ALERTS; in-process noise still filtered ── */

const now = Date.now();
const H = 3_600_000;
const gap = (over: Partial<{ startMs: number; endMs: number; durationMs: number; detectedAt: number; restartSpanning?: boolean }>) => ({
  startMs: now - 100 * MIN, endMs: now - 10 * MIN, durationMs: 90 * MIN, detectedAt: now - 10 * MIN, ...over,
});
const OPTS = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN };

test('outageAlerts — an 8-min RESTART gap fires the "alarm was dark" alert (F10)', () => {
  const a = outageAlerts([gap({ durationMs: 8 * MIN, restartSpanning: true })], now, OPTS);
  assert.equal(a.length, 1, 'a restart gap above the 5-min restart floor must alert');
  assert.match(a[0].title, /alarm was dark 8 min/);
  assert.equal(a[0].severity, 'warning');
});

test('outageAlerts — an 8-min IN-PROCESS gap stays below the 15-min floor (no cloud-blip noise)', () => {
  const a = outageAlerts([gap({ durationMs: 8 * MIN, restartSpanning: false })], now, OPTS);
  assert.equal(a.length, 0, 'an in-process stall keeps the higher 15-min floor');
});

test('outageAlerts — restartMinDurationMs omitted → restart gaps fall back to minDurationMs (backward compatible)', () => {
  const legacy = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN };
  const a = outageAlerts([gap({ durationMs: 8 * MIN, restartSpanning: true })], now, legacy);
  assert.equal(a.length, 0, 'without the new option, pre-v1.13.0 behavior (15-min floor for all) is preserved');
});

/* ── F22: the 24h counters now confess sub-15-min restart downtime ───────── */

test('outageTracking — an 11-min restart blackout counts toward the 24h outage tiles (F22)', () => {
  const t = outageTracking([gap({ startMs: now - 20 * MIN, endMs: now - 9 * MIN, durationMs: 11 * MIN, detectedAt: now - 9 * MIN, restartSpanning: true })], now, 24 * H);
  assert.equal(t.count, 1, 'the 11-min blackout is counted (tiles no longer read zero)');
  assert.equal(t.powerOutageCount, 1, 'classified as a power/restart outage');
  assert.equal(t.totalMinutes, 11, 'its minutes contribute to System Outage Minutes 24h');
});
