import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outageAlerts, outageTracking, isOutageEventFamily, outageAlertId, type Alert } from '../src/alerts.js';
import { shouldSendResolve, bootSeedNotified } from '../src/alertMonitor.js';
import { conditionFromAlerts } from '../src/broadcast.js';

/**
 * v0.83.0 — SYSTEM DATA-GAP / UNPLANNED-OUTAGE ALERTING.
 * The recorder detects + persists telemetry blackouts; these turn each recent one
 * into an operator push WARNING (fire-once, resolve-exempt event) and a 24 h
 * tracking rollup. Tests pin: recency/duration gating, restart-vs-stall wording,
 * stable dedup id, disabled toggle, the resolve exemption, and the rollup math.
 */

const MIN = 60_000;
const H = 3_600_000;
const now = 1_800_000_000_000;
const gap = (over: Partial<{ startMs: number; endMs: number; durationMs: number; detectedAt: number; restartSpanning?: boolean }>) => ({
  startMs: now - 100 * MIN,
  endMs: now - 10 * MIN,
  durationMs: 90 * MIN,
  detectedAt: now - 10 * MIN,
  ...over,
});
const OPTS = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN };

test('outageAlerts — a recent restart-spanning gap fires ONE warning with the alarm-was-dark wording', () => {
  const a = outageAlerts([gap({ restartSpanning: true })], now, OPTS);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.equal(a[0].category, 'Connectivity');
  assert.equal(a[0].priority, 'medium');
  assert.equal(a[0].id, outageAlertId(now - 100 * MIN));
  assert.match(a[0].title, /alarm was dark 90 min/);
  assert.match(a[0].detail, /spanning a restart|OFFLINE|unrecoverable/);
  assert.ok(a[0].facts?.some((f) => f.value.includes('restart-spanning')));
});

test('outageAlerts — an in-process (MQTT-stall) gap uses the writes-resumed wording, not "alarm dark"', () => {
  const a = outageAlerts([gap({ restartSpanning: false })], now, OPTS);
  assert.equal(a.length, 1);
  assert.match(a[0].title, /Telemetry gap — no data for 90 min/);
  assert.match(a[0].detail, /MQTT.*stall|writes have since resumed|process stayed up/);
  assert.doesNotMatch(a[0].detail, /OFFLINE/);
});

test('outageAlerts — a gap DETECTED longer ago than the recent window is dropped (ages off, no resolve)', () => {
  const old = gap({ detectedAt: now - 25 * H, endMs: now - 25 * H });
  assert.equal(outageAlerts([old], now, OPTS).length, 0);
});

test('outageAlerts — a gap shorter than minDuration is ignored (below the operator floor)', () => {
  const brief = gap({ durationMs: 8 * MIN });
  assert.equal(outageAlerts([brief], now, OPTS).length, 0);
});

test('outageAlerts — disabled toggle yields nothing even with a qualifying gap', () => {
  assert.equal(outageAlerts([gap({})], now, { ...OPTS, enabled: false }).length, 0);
});

test('outageAlerts — the id is stable per gap startMs (same gap never re-alerts) and newest sorts first', () => {
  const g1 = gap({ startMs: now - 300 * MIN, endMs: now - 250 * MIN, durationMs: 50 * MIN, detectedAt: now - 250 * MIN });
  const g2 = gap({ startMs: now - 120 * MIN, endMs: now - 90 * MIN, durationMs: 30 * MIN, detectedAt: now - 90 * MIN });
  const a = outageAlerts([g1, g2], now, OPTS);
  assert.equal(a.length, 2);
  // Same startMs → identical id across calls (dedup key for notify-once).
  assert.equal(outageAlerts([g1], now, OPTS)[0].id, a.find((x) => x.id.endsWith(String(g1.startMs)))!.id);
  // Newest gap (larger startMs) sorts first.
  assert.equal(a[0].id, outageAlertId(g2.startMs));
});

test('outageAlerts — non-finite/garbage gaps are skipped, never crash', () => {
  const bad = gap({ startMs: NaN, durationMs: NaN });
  assert.equal(outageAlerts([bad], now, OPTS).length, 0);
});

test('isOutageEventFamily — matches only system-outage ids', () => {
  assert.equal(isOutageEventFamily({ id: outageAlertId(123) }), true);
  assert.equal(isOutageEventFamily({ id: 'soc-low-XYZ' }), false);
  assert.equal(isOutageEventFamily({ id: 'backup-soc-20' }), false);
});

test('shouldSendResolve — an outage EVENT never emits a "Resolved:" push (even when otherwise qualified)', () => {
  const t = { pushSent: true, notifiedSeverity: 'warning' as const, alert: { id: outageAlertId(123), severity: 'warning' as const, annunciate: undefined } };
  assert.equal(shouldSendResolve(t, true, 'info'), false); // exempt
  // A normal warning with the same fields DOES resolve — proves the exemption is what changed it.
  const normal = { ...t, alert: { ...t.alert, id: 'backup-soc-20' } };
  assert.equal(shouldSendResolve(normal, true, 'info'), true);
});

test('outageTracking — rolls up count / total minutes / last ended+duration over the window', () => {
  const gaps = [
    gap({ startMs: now - 300 * MIN, endMs: now - 250 * MIN, durationMs: 50 * MIN }),
    gap({ startMs: now - 120 * MIN, endMs: now - 90 * MIN, durationMs: 30 * MIN }),
    gap({ startMs: now - 40 * H, endMs: now - 39 * H, durationMs: 60 * MIN }), // outside 24 h
  ];
  const t = outageTracking(gaps, now, 24 * H);
  assert.equal(t.count, 2);                    // the 40 h-old one excluded
  assert.equal(t.totalMinutes, 80);            // 50 + 30
  assert.equal(t.lastEndedMs, now - 90 * MIN); // most recently ended
  assert.equal(t.lastDurationMinutes, 30);
});

test('outageTracking — a clean 24 h reads zeros / null', () => {
  const t = outageTracking([], now, 24 * H);
  assert.deepEqual(t, { count: 0, totalMinutes: 0, lastEndedMs: null, lastDurationMinutes: null });
});

/* ── v0.83.0 REGRESSION — the adversarial review caught the flagship case broken:
 * a restart-spanning outage is recorded BEFORE the monitor starts, so it is present
 * on evaluate()'s firstRun tick and was boot-seeded notified → never pushed. These
 * pin the fix (bootSeedNotified exempts the outage family) + the broadcast exclusion. */

test('bootSeedNotified — a restart-spanning outage present on firstRun is NOT seeded → it dispatches', () => {
  // The exact failure: the Pi lost power, the gap was recorded pre-monitor-start, so
  // it is present on tick 1 with firstRun=true and no persisted record yet.
  assert.equal(bootSeedNotified({ alert: { id: outageAlertId(123) }, firstRun: true, alreadyNotified: false }), false);
});

test('bootSeedNotified — an outage already in the notify-state record STAYS suppressed (dedup across reboots)', () => {
  assert.equal(bootSeedNotified({ alert: { id: outageAlertId(123) }, firstRun: true, alreadyNotified: true }), true);
});

test('bootSeedNotified — a NORMAL alert present on firstRun IS still boot-seeded (unchanged behaviour)', () => {
  // A sustained condition (a still-low battery) must NOT re-announce on every restart.
  assert.equal(bootSeedNotified({ alert: { id: 'backup-soc-20' }, firstRun: true, alreadyNotified: false }), true);
  // Off first-run, a brand-new normal alert is not seeded (normal rising-edge dispatch).
  assert.equal(bootSeedNotified({ alert: { id: 'backup-soc-20' }, firstRun: false, alreadyNotified: false }), false);
  // An outage mid-run (not firstRun) also dispatches — same as a normal alert there.
  assert.equal(bootSeedNotified({ alert: { id: outageAlertId(9) }, firstRun: false, alreadyNotified: false }), false);
});

test('conditionFromAlerts — a system-outage does NOT raise the audible condition (event, not standing)', () => {
  const outage: Alert = { id: outageAlertId(1), severity: 'warning', category: 'Connectivity', device: 'System', title: 'x', detail: 'y' };
  assert.equal(conditionFromAlerts([outage]).level, 'green');       // excluded → stays green
  assert.equal(conditionFromAlerts([outage]).warn, 0);
  // A normal warning DOES raise it to yellow — proves the exclusion is what changed it.
  const normal: Alert = { ...outage, id: 'vdiff-warn-x' };
  assert.equal(conditionFromAlerts([normal]).level, 'yellow');
});
