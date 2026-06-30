import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socGridCrossDecision, reEscalateGridDrop } from '../src/socGridDispatch.js';
import type { AlarmPriority } from '../src/alertPriority.js';

/* v0.76.0 — direct unit tests for the SoC grid-dispatch helpers extracted from
 * index.ts. The end-to-end regression (batterySocAlarm.test.ts) drives these too;
 * here we pin the pure contracts in isolation. */

/* ── socGridCrossDecision ─────────────────────────────────────────────── */

test('socGridCrossDecision — backstopping collapses high/critical to a low advisory (onGrid)', () => {
  assert.deepEqual(socGridCrossDecision({ priority: 'critical' }, true), { priority: 'low', onGrid: true });
  assert.deepEqual(socGridCrossDecision({ priority: 'high' }, true), { priority: 'low', onGrid: true });
});

test('socGridCrossDecision — backstopping leaves medium/low intact (not downgraded)', () => {
  assert.deepEqual(socGridCrossDecision({ priority: 'medium' }, true), { priority: 'medium', onGrid: false });
  assert.deepEqual(socGridCrossDecision({ priority: 'low' }, true), { priority: 'low', onGrid: false });
});

test('socGridCrossDecision — off-grid keeps the original priority (the safe default)', () => {
  assert.deepEqual(socGridCrossDecision({ priority: 'critical' }, false), { priority: 'critical', onGrid: false });
  assert.deepEqual(socGridCrossDecision({ priority: 'high' }, false), { priority: 'high', onGrid: false });
});

/* ── reEscalateGridDrop ───────────────────────────────────────────────── */

const allEnabled = () => true;

test('reEscalateGridDrop — empty map or null SoC announces nothing', () => {
  assert.deepEqual(reEscalateGridDrop(new Map(), 5, false, allEnabled), []);
  assert.deepEqual(reEscalateGridDrop(new Map([[10, 'high']]), null, false, allEnabled), []);
});

test('reEscalateGridDrop — while grid is up, only prunes bands SoC climbed above; announces nothing', () => {
  const m = new Map<number, AlarmPriority>([[10, 'high'], [8, 'high'], [4, 'critical']]);
  const out = reEscalateGridDrop(m, 9, true, allEnabled); // 9 > 8 and > 4 → prune those; 9 ≤ 10 stays
  assert.deepEqual(out, []);
  assert.deepEqual([...m.keys()].sort((a, b) => b - a), [10]);
});

test('reEscalateGridDrop — grid drop re-announces every still-active downgraded band at its true priority', () => {
  const m = new Map<number, AlarmPriority>([[10, 'high'], [8, 'high'], [4, 'critical']]);
  const out = reEscalateGridDrop(m, 5, false, allEnabled); // 5 climbs out of 4; 5 ≤ 8 and ≤ 10 re-escalate
  assert.deepEqual(out, [{ pct: 10, priority: 'high' }, { pct: 8, priority: 'high' }]);
  assert.equal(m.size, 0, 're-escalated + climbed-out bands are all cleared');
});

test('reEscalateGridDrop — a priority disabled in Alert Settings is pruned but NOT announced', () => {
  const m = new Map<number, AlarmPriority>([[10, 'high'], [4, 'critical']]);
  const onlyCritical = (p: AlarmPriority) => p === 'critical';
  const out = reEscalateGridDrop(m, 3, false, onlyCritical); // both ≤ soc; high filtered, critical kept
  assert.deepEqual(out, [{ pct: 4, priority: 'critical' }]);
  assert.equal(m.size, 0, 'both bands cleared even though only one announced');
});
