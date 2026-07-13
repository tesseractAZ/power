/**
 * v1.12.0 — engine-review fixes F9 (lifetime rollup head-segment loss) + F19
 * (cleared-log noise eviction).
 *
 * F9: rollupLifetime queried `ts >= watermark`, so integrateWh never received the
 * pre-window boundary sample and its value-hold couldn't fill the head segment
 * [watermark → first sample] — every lifetime counter under-counted 13-18%. This
 * pins the SEMANTIC the fix relies on: supplying the pre-window sample (which the
 * corrected `since - lookback` fetch now does) recovers exactly the lost head Wh.
 *
 * F19: a plain FIFO cleared-alert log evicted every significant event under noise
 * churn (0 criticals survived). pruneOldestNonSignificant retains warning/critical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrateWh } from '../src/aggregator.js';
import { pruneOldestNonSignificant, type ClearedAlert } from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';

const HOUR = 3_600_000;

/* ── F9: the head segment is recovered when the pre-window sample is present ── */

test('integrateWh — a pre-window boundary sample recovers the dropped head segment', () => {
  const since = 10 * HOUR;
  const until = since + HOUR;
  // Steady 1000 W, sampled every 5 min. The first IN-WINDOW sample lands 7 min
  // into the window; a boundary sample sits 2 min before `since` (the one the OLD
  // `ts >= since` query never fetched). The REAL inter-sample gap (boundary →
  // first in-window) is 9 min ≤ the 10-min maxGap, so the head-hold legitimately
  // bridges it (v1.14.0 conditions the hold on this real gap, not the window edge).
  const inWindow: Array<{ ts: number; value: number }> = [];
  for (let t = since + 7 * 60_000; t <= until; t += 5 * 60_000) inWindow.push({ ts: t, value: 1000 });
  const withBoundary = [{ ts: since - 2 * 60_000, value: 1000 }, ...inWindow];
  const withoutBoundary = inWindow.slice(); // what the buggy query returned

  const full = integrateWh(withBoundary, since, until).wh;
  const truncated = integrateWh(withoutBoundary, since, until).wh;

  // With the boundary sample, the value is held from `since`, so the whole hour
  // integrates to ~1000 Wh. Without it, the head [since → since+7min] is lost →
  // ~1000 × (53/60) ≈ 883 Wh. The head recovered per window compounds across
  // thousands of 5-min rollups into the observed 13-18% under-count.
  assert.ok(Math.abs(full - 1000) < 1, `full-window integral ≈ 1000 Wh (got ${full.toFixed(1)})`);
  assert.ok(truncated < 900 && truncated > 865, `head-dropped integral is short by the 7-min head (got ${truncated.toFixed(1)})`);
  assert.ok(full - truncated > 100, `the recovered head segment (Δ=${(full - truncated).toFixed(1)} Wh) is real, non-zero energy`);
});

test('integrateWh — a pre-window sample OLDER than maxGap is NOT held (a real gap stays a gap)', () => {
  const since = 10 * HOUR;
  const until = since + HOUR;
  // Boundary sample sits 20 min before `since` — beyond the 10-min maxGap, so it
  // must NOT be value-held (that would fabricate energy across a real outage).
  const pts = [
    { ts: since - 20 * 60_000, value: 1000 },
    { ts: since + 30 * 60_000, value: 1000 },
    { ts: until, value: 1000 },
  ];
  const wh = integrateWh(pts, since, until).wh;
  // Only [first in-window sample → until] = 30 min counts ≈ 500 Wh; the head is
  // correctly NOT fabricated.
  assert.ok(wh < 700, `stale boundary is not held across a real gap (got ${wh.toFixed(1)})`);
});

/* ── F19: cleared-log eviction protects significant entries ─────────────── */

function cleared(severity: Alert['severity'], clearedAt: number): ClearedAlert {
  return {
    alert: { id: `x-${clearedAt}`, severity, category: 'Battery', device: 'Core 1', title: 't' } as Alert,
    raisedAt: clearedAt - 1000, clearedAt, durationMs: 1000,
  };
}

test('pruneOldestNonSignificant — drops the oldest INFO entry, never the criticals', () => {
  // newest-first: [warn(newest), info, critical, info(oldest)]
  const log: ClearedAlert[] = [cleared('warning', 40), cleared('info', 30), cleared('critical', 20), cleared('info', 10)];
  pruneOldestNonSignificant(log);
  // The oldest INFO (clearedAt=10) is evicted; the critical and warning stay.
  assert.deepEqual(log.map((c) => c.alert.severity), ['warning', 'info', 'critical']);
  assert.ok(!log.some((c) => c.clearedAt === 10));
});

test('pruneOldestNonSignificant — evicts the NEWER info before an OLDER critical', () => {
  const log: ClearedAlert[] = [cleared('info', 30), cleared('critical', 10)]; // info newer, critical older
  pruneOldestNonSignificant(log);
  assert.deepEqual(log.map((c) => c.alert.severity), ['critical'], 'the info is dropped even though it is newer than the critical');
});

test('pruneOldestNonSignificant — v1.14.0 tiering: a warning evicts before ANY critical', () => {
  // v1.12.0 dropped the oldest overall here (the critical@10) — the review showed
  // that under warning-severity churn this degraded back to FIFO and amputated
  // criticals. The tiered eviction takes the warning first.
  const log: ClearedAlert[] = [cleared('critical', 30), cleared('warning', 20), cleared('critical', 10)];
  pruneOldestNonSignificant(log);
  assert.equal(log.length, 2);
  assert.ok(!log.some((c) => c.alert.severity === 'warning'), 'the warning is evicted, both criticals survive');
  assert.ok(log.some((c) => c.clearedAt === 10), 'the oldest critical is protected');
});

test('pruneOldestNonSignificant — 90/day noise never evicts a lone critical', () => {
  const log: ClearedAlert[] = [cleared('critical', 999)];
  for (let i = 0; i < 500; i++) log.unshift(cleared('info', 1000 + i)); // 500 noise clears arrive
  // Simulate the cap trimming 400 times: the critical must survive every eviction.
  for (let i = 0; i < 400; i++) pruneOldestNonSignificant(log);
  assert.ok(log.some((c) => c.alert.severity === 'critical'), 'the critical is never amputated by noise');
});
