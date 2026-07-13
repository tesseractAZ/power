/**
 * v1.14.0 — adversarial-review fixes for the v1.12.0/v1.13.0 releases.
 *
 * The 42-agent review CONFIRMED (3-lens panels, 0 refuted) that:
 *  - F9's lookback made the 5-min windowed rollup FABRICATE energy during
 *    telemetry stalls (empty windows integrated at held power; >maxGap gaps
 *    straddling a watermark bridged nearly in full) — integrateWh's head-hold
 *    checked distance to the WINDOW edge, not the real inter-sample gap.
 *  - F10's defer resolved on the skewed clock DRIFTING past the anchor
 *    (seconds), so the 5-15-min blackout class it shipped to fix was silently
 *    discarded whenever an insert beat the NTP step.
 *  - F10b: an in-place-EXTENDED blackout never re-notified (id keyed on startMs
 *    only), so "dark 6 min" stayed the operator's last word on a 3-hour outage.
 *  - F19's eviction keyed on source severity, so warning-churn bypassed it and
 *    the log degraded back to FIFO; a NaN CLEARED_LOG_MAX wiped the sidecar.
 *  - classifyRestartGap dropped the old ts>0 guard (56-year gap on a corrupt row).
 *  - A transient SHP2 source error (60-s flap at 05:35 on 2026-07-12) fired a
 *    full audible red + critical push with no debounce.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { Alert } from '../src/alerts.js';
import type { ClearedAlert } from '../src/alertMonitor.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const MIN = 60_000;
const H = 3_600_000;

// DB_PATH must be set BEFORE any app module loads — static imports hoist, and
// alertMonitor.ts transitively evaluates config.ts (which reads DB_PATH once),
// so EVERY app import below is dynamic. Type-only imports above are erased.
const tmp = mkdtempSync(join(tmpdir(), 'ef-v114-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { classifyRestartGap, resolveDeferredRestartGap, createRecorder } = await import('../src/recorder.js');
const { integrateWh } = await import('../src/aggregator.js');
const {
  computeAlerts, outageAlerts, outageAlertId, outageDurationTier,
  outageTracking, systemOutageFields, resolveOutageAlertOptions, envNum,
} = await import('../src/alerts.js');
const { pruneOldestNonSignificant } = await import('../src/alertMonitor.js');
const { familyOf } = await import('../src/alertOutcomes.js');

/* ══ F9 fabrication — integrateWh head-hold conditioned on the REAL gap ═══ */

test('integrateWh — a window ENTIRELY inside a telemetry gap contributes 0 (no held-power fabrication)', () => {
  // Boundary 2 min before the window, NO in-window samples: the old head-hold +
  // tail-hold synthesized both endpoints and integrated the full 5-min window at
  // held power. The review's live probe: each stall fabricated ~10 min × last W.
  const since = 100 * H;
  const r = integrateWh([{ ts: since - 2 * MIN, value: 8000 }], since, since + 5 * MIN);
  assert.equal(r.wh, 0, `empty in-gap window must contribute 0 Wh, got ${r.wh.toFixed(1)}`);
  assert.equal(r.coverageMs, 0);
});

test('integrateWh — a >maxGap real gap straddling the window boundary is NOT bridged', () => {
  // Boundary 2 min before `since`, first in-window sample 10 min into the window:
  // real inter-sample gap = 12 min > maxGap. The old check (since − boundary ≤
  // maxGap) bridged [since → first] at held power; the contract says skip.
  const since = 100 * H;
  const until = since + 15 * MIN;
  const pts = [
    { ts: since - 2 * MIN, value: 8000 },
    { ts: since + 10 * MIN, value: 8000 },
    { ts: until, value: 8000 },
  ];
  const r = integrateWh(pts, since, until);
  // Only [first sample → until] = 5 min integrates ≈ 666.7 Wh; the 10-min head
  // (part of a 12-min real gap) is correctly dropped.
  assert.ok(Math.abs(r.wh - 8000 * (5 / 60)) < 1, `only the post-gap tail integrates (got ${r.wh.toFixed(1)})`);
});

test('integrateWh — legitimate head recovery (real gap ≤ maxGap) is preserved', () => {
  const since = 100 * H;
  const until = since + 10 * MIN;
  const pts = [
    { ts: since - 2 * MIN, value: 6000 },  // boundary
    { ts: since + 4 * MIN, value: 6000 },  // real gap 6 min ≤ 10 → hold engages
    { ts: until, value: 6000 },
  ];
  const r = integrateWh(pts, since, until);
  assert.ok(Math.abs(r.wh - 6000 * (10 / 60)) < 1, `full window recovered via the held boundary (got ${r.wh.toFixed(1)})`);
});

test('integrateWh — windowed 5-min chain over a 45-min stall matches the continuous integral (the review probe)', () => {
  // Steady 8000 W every 4 min up to t=28 min, silence to t=73 min, resume to 89.
  // Chop into 5-min watermark windows exactly like rollupLifetime and compare
  // against the single-shot continuous integral: fabrication (v1.12.0 code) adds
  // ~1000 Wh of stall windows; the fix keeps the chain within hold-slack.
  const T0 = 200 * H;
  const pts: Array<{ ts: number; value: number }> = [];
  for (let m = 0; m <= 28; m += 4) pts.push({ ts: T0 + m * MIN, value: 8000 });
  for (let m = 73; m <= 89; m += 4) pts.push({ ts: T0 + m * MIN, value: 8000 });

  const continuous = integrateWh(pts, T0, T0 + 91 * MIN).wh; // ground truth: ≈ 2800 + 1600 + tail-holds

  let windowed = 0;
  for (let w = 0; w < 91; w += 5) {
    const since = T0 + w * MIN;
    const until = Math.min(T0 + (w + 5) * MIN, T0 + 91 * MIN);
    const fetched = pts.filter((p) => p.ts >= since - 10 * MIN && p.ts <= until); // the rollup's lookback fetch
    windowed += integrateWh(fetched, since, until).wh;
  }
  // Continuous ≈ 4400 + boundary holds; windowed adds only bounded tail-hold
  // slack at the stall onset (≤ one window) — NEVER whole fabricated windows.
  assert.ok(windowed - continuous < 600, `windowed chain must not fabricate stall energy (windowed=${windowed.toFixed(0)}, continuous=${continuous.toFixed(0)})`);
  assert.ok(continuous - windowed < 600, `windowed chain must not lose real coverage either (windowed=${windowed.toFixed(0)}, continuous=${continuous.toFixed(0)})`);
});

/* ══ F9 rollup-level mutation-killer — drives the REAL recorder ══════════ */

function makeStore(devices: Record<string, unknown> = {}) {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: 0, devices };
  ee.get = () => ee.snap;
  return ee;
}

test('rollupLifetime — recovers ≤maxGap window heads AND fabricates nothing across a 45-min stall', () => {
  // The v1.12.0 tests only pinned integrateWh semantics — a live mutation revert
  // of the recorder's lookback fetch passed 1325/1325. This drives the REAL
  // rollup across a synthetic stall: reverting the recorder.ts lookback loses
  // ~1900 Wh of window heads (→ ~3000); reverting the aggregator head-hold fix
  // fabricates ~1000 Wh of stall windows (→ ~5900). Both die here.
  const store = makeStore({ 'DPU-T': { sn: 'DPU-T', projection: { kind: 'dpu', packs: [] } } });
  const T0 = Date.now() - 6 * H; // recent past so nothing ages oddly
  const realNow = Date.now;
  let rec: ReturnType<typeof createRecorder>;
  try {
    // Stub the clock BEFORE construction: the first-run counter resets stamp
    // last_integrated_ts with Date.now(), and a watermark in the (stub-relative)
    // future would make every rollup skip via `since >= now`.
    (Date as any).now = () => T0;
    rec = createRecorder(store, () => {});
    const db = new DatabaseSync(process.env.DB_PATH!);
    const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    for (let m = 0; m <= 28; m += 4) ins.run(T0 + m * MIN, 'DPU-T', 'pv_total', 8000);
    for (let m = 73; m <= 89; m += 4) ins.run(T0 + m * MIN, 'DPU-T', 'pv_total', 8000);
    db.close();
    // 5-min cadence across the whole fixture, exactly like production.
    for (let m = 1; m <= 91; m += 5) {
      (Date as any).now = () => T0 + m * MIN;
      rec.rollupLifetime();
    }
    (Date as any).now = () => T0 + 91 * MIN;
    rec.rollupLifetime();
  } finally {
    (Date as any).now = realNow;
  }

  const db2 = new DatabaseSync(process.env.DB_PATH!);
  const row = db2.prepare(`SELECT wh FROM lifetime_totals WHERE metric_key = 'fleet_pv_wh'`).get() as { wh: number } | undefined;
  db2.close();
  rec.close();
  assert.ok(row, 'fleet_pv_wh accumulated');
  // Expected ≈ 6533 Wh (pre-stall windows + bounded tail-holds + post-stall).
  // Reverting the recorder lookback loses ~2000 Wh of window heads (→ ~4533);
  // reverting the aggregator head-hold fix fabricates ~1333 Wh of stall windows
  // (→ ~7866). Both mutations die decisively here.
  assert.ok(row!.wh > 6300, `window heads recovered — lookback revert loses ~2000 Wh (got ${row!.wh.toFixed(0)})`);
  assert.ok(row!.wh < 6800, `no stall fabrication — head-hold revert adds ~1333 Wh (got ${row!.wh.toFixed(0)})`);
});

/* ══ F10 — classifyRestartGap guard + monotonic defer resolution ══════════ */

test('classifyRestartGap — a corrupt ts=0/negative row never ledgers a multi-decade gap', () => {
  assert.deepEqual(classifyRestartGap(0, Date.now(), 5 * MIN), { kind: 'none' });
  assert.deepEqual(classifyRestartGap(-5, Date.now(), 5 * MIN), { kind: 'none' });
});

test('resolveDeferredRestartGap — skewed clock DRIFTING past the anchor HOLDS (the v1.13.0 silent-discard bug)', () => {
  // Boot clock 30 s behind the anchor; 40 s of uptime later the skewed clock has
  // drifted past the anchor. estBootWall = anchor+10s−40s = anchor−30s → darkMs
  // ≈ −30s → HOLD, not the old "delta ≈ 10s → conclude no gap and disarm".
  const anchor = 500 * H;
  const r = resolveDeferredRestartGap({
    anchorMs: anchor, nowWallMs: anchor + 10_000, monoElapsedMs: 40_000,
    floorMs: 5 * MIN, settleMs: 10 * MIN,
  });
  assert.deepEqual(r, { action: 'hold' });
});

test('resolveDeferredRestartGap — NTP step reveals the true dark time and RECORDS it', () => {
  // 11-min real blackout: NTP steps 3 min into uptime; estBootWall−anchor = 11 min.
  const anchor = 500 * H;
  const r = resolveDeferredRestartGap({
    anchorMs: anchor, nowWallMs: anchor + 11 * MIN + 3 * MIN, monoElapsedMs: 3 * MIN,
    floorMs: 5 * MIN, settleMs: 10 * MIN,
  });
  assert.deepEqual(r, { action: 'record', startMs: anchor, endMs: anchor + 11 * MIN });
});

test('resolveDeferredRestartGap — no material skew disarms at the settle budget, silent before it', () => {
  const anchor = 500 * H;
  const base = { anchorMs: anchor, floorMs: 5 * MIN, settleMs: 10 * MIN };
  // 9 min of uptime, clock consistent (darkMs ≈ 30s): still holding.
  assert.deepEqual(resolveDeferredRestartGap({ ...base, nowWallMs: anchor + 9 * MIN + 30_000, monoElapsedMs: 9 * MIN }), { action: 'hold' });
  // 10 min of uptime: NTP never stepped meaningfully → disarm, nothing recorded.
  assert.deepEqual(resolveDeferredRestartGap({ ...base, nowWallMs: anchor + 10 * MIN + 30_000, monoElapsedMs: 10 * MIN }), { action: 'disarm' });
});

/* ══ F10b — duration-tier re-notify + graceful restarts ══════════════════ */

test('outageAlertId — crossing a duration tier changes the id; the family stays system-outage', () => {
  const t0 = 1_783_859_721_370;
  assert.equal(outageAlertId(t0, 6 * MIN), `system-outage-${t0}`);            // tier 0 = legacy id
  assert.notEqual(outageAlertId(t0, 6 * MIN), outageAlertId(t0, 40 * MIN));   // 6 min → 40 min re-fires
  assert.notEqual(outageAlertId(t0, 40 * MIN), outageAlertId(t0, 3 * H));     // → 3 h re-fires again
  assert.equal(outageDurationTier(186 * MIN), 2);
  for (const d of [0, 20 * MIN, 2 * H, 7 * H]) {
    assert.equal(familyOf(outageAlertId(t0, d)), 'system-outage', `tier id for ${d}ms keeps the family`);
  }
});

test('outageAlerts — an extended blackout fires a FRESH alert with the true magnitude', () => {
  const now = Date.now();
  const opts = resolveOutageAlertOptions({});
  const g = (durationMs: number) => [{ startMs: now - 200 * MIN, endMs: now - 200 * MIN + durationMs, durationMs, detectedAt: now - MIN, restartSpanning: true }];
  const first = outageAlerts(g(6 * MIN), now, opts);
  const extended = outageAlerts(g(186 * MIN), now, opts);
  assert.equal(first.length, 1);
  assert.equal(extended.length, 1);
  assert.notEqual(first[0].id, extended[0].id, 'the extended gap must carry a NEW id so it re-dispatches');
  assert.match(extended[0].title, /alarm was dark 186 min/);
});

test('outageAlerts — a graceful (deploy) restart reports honestly at low priority, no UPS advice', () => {
  const now = Date.now();
  const opts = resolveOutageAlertOptions({});
  const a = outageAlerts(
    [{ startMs: now - 20 * MIN, endMs: now - 9 * MIN, durationMs: 11 * MIN, detectedAt: now - 9 * MIN, restartSpanning: true, graceful: true }],
    now, opts,
  );
  assert.equal(a.length, 1);
  assert.equal(a[0].priority, 'low');
  assert.match(a[0].title, /Add-on restart — alarm was dark 11 min/);
  assert.ok(!/UPS/.test(a[0].detail), 'a deliberate deploy must not recommend a UPS');
});

test('outageTracking — graceful restarts are NOT power outages (deploys must not poison the trend)', () => {
  const now = Date.now();
  const t = outageTracking([
    { startMs: now - 100 * MIN, endMs: now - 90 * MIN, durationMs: 10 * MIN, detectedAt: now - 90 * MIN, restartSpanning: true, graceful: true },  // deploy
    { startMs: now - 60 * MIN, endMs: now - 40 * MIN, durationMs: 20 * MIN, detectedAt: now - 40 * MIN, restartSpanning: true },                   // power loss
    { startMs: now - 30 * MIN, endMs: now - 10 * MIN, durationMs: 20 * MIN, detectedAt: now - 10 * MIN },                                          // MQTT stall
  ], now, 24 * H);
  assert.equal(t.count, 3);
  assert.equal(t.powerOutageCount, 1, 'only the non-graceful restart counts as a power outage');
  assert.equal(t.gracefulRestartCount, 1);
  assert.equal(t.telemetryGapCount, 1);
  assert.equal(t.totalMinutes, 50);
});

/* ══ f5 — the HA/MQTT payload hop, now single-sourced + tested ════════════ */

test('systemOutageFields — exact field names + values served to /api/ha-state and MQTT', () => {
  const now = Date.now();
  const f = systemOutageFields(
    [{ startMs: now - 20 * MIN, endMs: now - 9 * MIN, durationMs: 11 * MIN, detectedAt: now - 9 * MIN, restartSpanning: true }],
    now,
  );
  assert.deepEqual(f, {
    system_outage_active_24h: true,
    system_outage_count_24h: 1,
    system_power_outage_count_24h: 1,
    system_graceful_restart_count_24h: 0,
    system_telemetry_gap_count_24h: 0,
    system_outage_total_minutes_24h: 11,
    system_outage_last_ended: now - 9 * MIN,
    system_outage_last_duration_minutes: 11,
  });
  const clean = systemOutageFields([], now);
  assert.equal(clean.system_outage_active_24h, false);
  assert.equal(clean.system_outage_last_ended, null);
});

/* ══ f3/f19 — env wiring: NaN-safe parsing + the restart floor is pinned ══ */

test('envNum — non-numeric env falls back to the default instead of NaN-poisoning Math.max', () => {
  assert.equal(envNum('1,500', 1500, 50), 1500);   // the exact sidecar-wipe input
  assert.equal(envNum(undefined, 1500, 50), 1500);
  assert.equal(envNum('abc', 24, 0), 24);
  assert.equal(envNum('7', 1500, 50), 50, 'min floor still applies');
  assert.equal(envNum('2000', 1500, 50), 2000);
});

test('resolveOutageAlertOptions — defaults carry the v1.13.0 restart floor; NaN env falls back', () => {
  const d = resolveOutageAlertOptions({});
  assert.equal(d.enabled, true);
  assert.equal(d.recentWindowMs, 24 * H);
  assert.equal(d.minDurationMs, 15 * MIN);
  // THE mutation the review flagged: dropping this field silently regresses to
  // pre-F10 alerting (the fallback design makes the omission invisible).
  assert.equal(d.restartMinDurationMs, 5 * MIN);
  const bad = resolveOutageAlertOptions({ SYSTEM_OUTAGE_RECENT_WINDOW_H: 'x', SYSTEM_OUTAGE_MIN_MINUTES: '1,5', SYSTEM_OUTAGE_RESTART_MIN_MINUTES: '' });
  assert.equal(bad.recentWindowMs, 24 * H);
  assert.equal(bad.minDurationMs, 15 * MIN);
  assert.equal(bad.restartMinDurationMs, 5 * MIN);
  const custom = resolveOutageAlertOptions({ SYSTEM_OUTAGE_RESTART_MIN_MINUTES: '8', SYSTEM_OUTAGE_ALERT_ENABLED: 'false' });
  assert.equal(custom.restartMinDurationMs, 8 * MIN);
  assert.equal(custom.enabled, false);
});

/* ══ F19 — tiered eviction: warning churn can NEVER amputate a critical ═══ */

function cleared(severity: Alert['severity'], clearedAt: number, id = `x-${severity}-${clearedAt}`): ClearedAlert {
  return {
    alert: { id, severity, category: 'Battery', device: 'Core 1', title: 't' } as Alert,
    raisedAt: clearedAt - 1000, clearedAt, durationMs: 1000,
  };
}

test('pruneOldestNonSignificant — warning-severity churn evicts warnings, never the critical (the FIFO bypass)', () => {
  // The review repro: a log dominated by warning-severity noise (demoted families
  // are EMITTED at warning) with one old critical — v1.12.0 fell through to
  // pop() and amputated the critical.
  const log: ClearedAlert[] = [];
  for (let i = 0; i < 200; i++) log.push(cleared('warning', 10_000 - i));
  log.push(cleared('critical', 1)); // the oldest entry of all
  for (let i = 0; i < 150; i++) pruneOldestNonSignificant(log);
  assert.ok(log.some((c) => c.alert.severity === 'critical'), 'the critical survives sustained warning churn');
  assert.equal(log.length, 51);
});

test('pruneOldestNonSignificant — the noise predicate evicts a chronic-family warning before a genuine warning', () => {
  const log: ClearedAlert[] = [
    cleared('warning', 30, 'genuine-warning-1'),
    cleared('warning', 20, 'peer-temp-noise-1'), // newer than the genuine? no: 20 < 30 → older
    cleared('warning', 10, 'genuine-warning-2'),
  ];
  pruneOldestNonSignificant(log, (e) => e.alert.id.startsWith('peer-temp-noise'));
  assert.ok(!log.some((c) => c.alert.id === 'peer-temp-noise-1'), 'the noise-flagged warning goes first');
  assert.equal(log.length, 2);
});

test('pruneOldestNonSignificant — an all-critical log pops the oldest as the last resort', () => {
  const log: ClearedAlert[] = [cleared('critical', 30), cleared('critical', 20), cleared('critical', 10)];
  pruneOldestNonSignificant(log);
  assert.equal(log.length, 2);
  assert.ok(!log.some((c) => c.clearedAt === 10));
});

/* ══ shp2-src-err — the 05:35 wake-the-house flap gets the 3-min debounce ═ */

function shp2With(errorCodeNum: number): Record<string, DeviceSnapshot> {
  return {
    'SHP2-1': {
      sn: 'SHP2-1', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
      online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'shp2',
        sources: [{ slot: 1, errorCodeNum, isConnected: true, hwConnect: true }],
        pairedCircuits: [],
      } as any,
    } as DeviceSnapshot,
  };
}
const srcErr = (a: Alert[]) => a.find((x) => x.id === 'shp2-src-err-1');
const connWith = (map: Map<string, { count: number; sinceMs: number }>) =>
  ({ lastDeviceListAttemptAt: Date.now(), lastDeviceListSuccessAt: Date.now(), perDevice: new Map(), shp2SrcErrOnsetBySlot: map });

test('shp2-src-err — a fresh device-reported error (< 3 min) is SUPPRESSED (no 05:35 wake-up for a 60-s flap)', () => {
  const alerts = computeAlerts(shp2With(1), connWith(new Map([['SHP2-1:1', { count: 1, sinceMs: Date.now() - 30_000 }]])));
  assert.equal(srcErr(alerts), undefined);
});

test('shp2-src-err — a SUSTAINED error (> 3 min) fires the CRITICAL', () => {
  const alerts = computeAlerts(shp2With(1), connWith(new Map([['SHP2-1:1', { count: 1, sinceMs: Date.now() - 4 * MIN }]])));
  const a = srcErr(alerts);
  assert.ok(a);
  assert.equal(a!.severity, 'critical');
});

test('shp2-src-err — a COUNT change re-baselines (a new fault serves its own debounce)', () => {
  // Live count is 3 but the tracked onset is for count 1 → not debounced-eligible;
  // fires (matches the dpu-err convention: never silently lose a changed fault).
  const alerts = computeAlerts(shp2With(3), connWith(new Map([['SHP2-1:1', { count: 1, sinceMs: Date.now() - 10 * MIN }]])));
  assert.ok(srcErr(alerts), 'a changed count is a different fault — the stale onset must not debounce it');
});

test('shp2-src-err — no onset context (older callers) fires immediately — a real fault is never lost', () => {
  assert.ok(srcErr(computeAlerts(shp2With(2))), 'back-compat unguarded path still fires');
});
