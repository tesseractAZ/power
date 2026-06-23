import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BATTERY_SOC_THRESHOLDS,
  createBatterySocAlarm,
  socAlarmMessage,
  activeSocBand,
  socAlertSeverity,
  type SocThreshold,
} from '../src/batterySocAlarm.js';

// v0.12.0 — Unit tests for the backup-pool SoC audible alarm. Each test uses a
// UNIQUE tmp statePath so the persisted armed-map / lastSoc never leaks between
// cases (the alarm boot-arms from /data on construction). We collect the paths
// and best-effort remove them at the end.
const tmpPaths: string[] = [];
let seq = 0;
function makeAlarm(onCross: (t: SocThreshold) => void) {
  const statePath = join(tmpdir(), `soc-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(statePath);
  return createBatterySocAlarm({ onCross, statePath });
}

test('BATTERY_SOC_THRESHOLDS — pcts and escalating priorities', () => {
  assert.deepEqual(
    BATTERY_SOC_THRESHOLDS.map((t) => t.pct),
    [50, 40, 30, 20, 15, 10, 8, 4, 2],
  );
  assert.deepEqual(
    BATTERY_SOC_THRESHOLDS.map((t) => t.priority),
    ['low', 'low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical'],
  );
});

test('v0.14.0 — 50% advisory fires on a downward crossing (booted above 50)', () => {
  const fired: { pct: number; priority: string }[] = [];
  const alarm = makeAlarm((t) => fired.push({ pct: t.pct, priority: t.priority }));
  alarm.update(60); // boot above 50 → 50 is armed
  alarm.update(49); // cross down through 50 only
  assert.deepEqual(fired, [{ pct: 50, priority: 'low' }]);
  // Booting AT 49 must NOT retroactively fire 50.
  const fired2: number[] = [];
  const alarm2 = makeAlarm((t) => fired2.push(t.pct));
  alarm2.update(49);
  assert.deepEqual(fired2, []);
});

test('fresh alarm — only the 40 threshold crossed, no re-fire on repeat', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // First reading arms all (50 is above every threshold).
  alarm.update(50);
  // Down to 35: crosses only 40 (35 is still above 30).
  alarm.update(35);
  assert.deepEqual(fired, [40]);
  // Same reading again: edge-triggered, so no new fire.
  alarm.update(35);
  assert.deepEqual(fired, [40]);
});

test('boot-arming — first reading below thresholds must NOT re-announce', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // FIRST reading is 18: 40/30/20 are already below current SoC and must not
  // fire on boot — they are simply disarmed since we booted under them.
  alarm.update(18);
  assert.deepEqual(fired, []);
});

test('crossing deep — fires 40..4 but not 2 when landing at 3', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // v0.54.4 — a 47-pt fall in one tick is implausible from a FRESH baseline (the new
  // single-tick plausibility guard would treat it as a stale-reconnect artifact). Here we
  // exercise the deep-crossing ladder against a STALE baseline (>10 min apart), which is the
  // case the guard intentionally allows (a large change after a long gap is real).
  alarm.update(50, 0); // arms all
  alarm.update(3, 11 * 60 * 1000); // crosses everything at/above 3
  const set = new Set(fired);
  for (const pct of [40, 30, 20, 15, 10, 8, 4]) {
    assert.ok(set.has(pct), `expected ${pct} to have fired`);
  }
  assert.ok(!set.has(2), '2 must NOT fire (3 > 2)');
});

test('hysteresis — a value hovering on a boundary does not re-arm/chatter', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // v0.54.4 — stale baseline (>10 min) so the 50→19 deep crossing is honored (the plausibility
  // guard only suppresses a big fall from a FRESH baseline). The subsequent small moves are
  // within the cap so they pass regardless.
  const t0 = 11 * 60 * 1000;
  alarm.update(50, 0); // arms all
  alarm.update(19, t0); // crosses 40, 30, 20
  assert.deepEqual(fired, [40, 30, 20]);
  // +1 over the 20 boundary is NOT enough hysteresis to re-arm 20.
  alarm.update(21, t0 + 1000);
  assert.deepEqual(fired, [40, 30, 20]);
  // +2 over the boundary DOES re-arm 20.
  alarm.update(22, t0 + 2000);
  // Back below 20 → 20 fires again (now the 4th entry).
  alarm.update(19, t0 + 3000);
  assert.deepEqual(fired, [40, 30, 20, 20]);
});

test('activeSocBand — lowest threshold currently crossed', () => {
  assert.equal(activeSocBand(51), null); // above the top threshold (now 50)
  assert.equal(activeSocBand(50)?.pct, 50); // 50 ≤ 50 → the new top band
  assert.equal(activeSocBand(45)?.pct, 50); // 45 ≤ 50, > 40
  assert.equal(activeSocBand(18)?.pct, 20); // 18 ≤ 20, > 15
  assert.equal(activeSocBand(1)?.pct, 2); // 1 ≤ 2 (the lowest band)
});

test('socAlertSeverity — derives the (severity, source, priority) for each priority', () => {
  // v0.44.0 — these are REAL measured crossings: always source='threshold', and
  // the ISA tier is carried in the explicit `priority` field (Medium no longer
  // fakes source='learned').
  assert.deepEqual(socAlertSeverity('medium'), {
    severity: 'warning',
    source: 'threshold',
    priority: 'medium',
  });
  assert.equal(socAlertSeverity('high').source, 'threshold');
  assert.equal(socAlertSeverity('high').priority, 'high');
  assert.equal(socAlertSeverity('critical').severity, 'critical');
  assert.equal(socAlertSeverity('critical').source, 'threshold');
  assert.equal(socAlertSeverity('low').severity, 'info');
  assert.equal(socAlertSeverity('low').priority, 'low');
  // Every tier must be source='threshold' now — none route to the Predictive page.
  for (const p of ['critical', 'high', 'medium', 'low'] as const) {
    assert.equal(socAlertSeverity(p).source, 'threshold');
  }
});

test('socAlarmMessage — speaks the pct and band', () => {
  assert.ok(
    socAlarmMessage({ pct: 20, priority: 'medium' }).includes('Backup pool at 20 percent'),
  );
});

/* ─── v0.54.4 — single-tick plausibility guard (transient SoC=0 on SHP2 reconnect) ─── */

const MIN = 60_000;

test('v0.54.4 — a transient SoC=0 from a healthy fresh baseline does NOT ladder the cascade', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(63, 0); // boot healthy → arms every threshold
  alarm.update(0, 1 * MIN); // 63→0 in one 60s tick = the 2026-06-21 18:12 reconnect artifact
  assert.deepEqual(fired, [], 'an implausible single-tick collapse must be ignored, not announced');
  alarm.update(63, 2 * MIN); // pool was fine all along → recovers, still nothing fires
  assert.deepEqual(fired, []);
});

test('v0.54.4 — a SUSTAINED stale 0 keeps being ignored (baseline never poisoned)', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(63, 0);
  alarm.update(0, 1 * MIN); // ignored
  alarm.update(0, 2 * MIN); // still ignored — lastSoc stayed 63, so still a >25 drop
  alarm.update(0, 3 * MIN);
  assert.deepEqual(fired, []);
});

test('v0.54.4 — a genuine gradual discharge still fires every band once', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  // Each step is well under the 25-pt cap → the guard never engages; the ladder fires normally.
  alarm.update(63, 0); // boot, arms all (no fire)
  alarm.update(45, 1 * MIN); // ↓ crosses 50
  alarm.update(35, 2 * MIN); // ↓ crosses 40
  alarm.update(28, 3 * MIN); // ↓ crosses 30
  alarm.update(18, 4 * MIN); // ↓ crosses 20
  alarm.update(13, 5 * MIN); // ↓ crosses 15
  alarm.update(9, 6 * MIN); // ↓ crosses 10 (baseline now <30 — guard inactive anyway)
  alarm.update(7, 7 * MIN); // ↓ crosses 8
  alarm.update(3, 8 * MIN); // ↓ crosses 4
  alarm.update(1, 9 * MIN); // ↓ crosses 2
  assert.deepEqual(fired, [50, 40, 30, 20, 15, 10, 8, 4, 2]);
});

test('v0.54.4 — a real deep discharge that reaches 0 from a LOW baseline still fires critical', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(12, 0); // boot already low (<30) → 50..15 disarmed, 10/8/4/2 armed
  alarm.update(0, 1 * MIN); // 12→0: guard inactive (baseline <30) → critical bands fire
  assert.deepEqual(fired, [10, 8, 4, 2]);
});

test('v0.54.4 — after a long gap (stale baseline) a large real change re-baselines, not suppressed', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(63, 0); // boot healthy
  // 25 min later (was the add-on down / SHP2 offline?) the pool genuinely sits at 20 — a real
  // 43-pt change, but plausible across the gap. Stale baseline → guard inactive → bands fire.
  alarm.update(20, 25 * MIN);
  assert.deepEqual(fired, [50, 40, 30, 20]);
});

test('v0.54.4 — throttled persist keeps the slew guard active across a quick restart', () => {
  const sp = join(tmpdir(), `soc-restart-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(sp);
  // Run quietly at 63% for a while: no crossings, but the throttle persists the baseline so the
  // on-disk lastSocAtMs stays fresh (without it, only the boot persist @ t=0 would survive).
  const a1 = createBatterySocAlarm({ onCross: () => {}, statePath: sp });
  a1.update(63, 0); // boot → persist baseline @ 0
  a1.update(63, 6 * MIN); // quiet, >5min since persist → throttled persist @ 6min
  a1.update(63, 12 * MIN); // quiet → throttled persist @ 12min
  // "Restart": a fresh instance loads the persisted state (baseline ≈ 12min old at t=13min → fresh).
  const fired: number[] = [];
  const a2 = createBatterySocAlarm({ onCross: (t) => fired.push(t.pct), statePath: sp });
  a2.update(0, 13 * MIN); // transient 0 right after restart — guard still active (baseline 1min old)
  assert.deepEqual(fired, [], 'a quick restart must not re-open the cascade — throttled persist kept the baseline fresh');
});

test('cleanup — remove tmp state files (best effort)', () => {
  for (const p of tmpPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});
