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
  alarm.update(50); // arms all
  alarm.update(3); // crosses everything at/above 3
  const set = new Set(fired);
  for (const pct of [40, 30, 20, 15, 10, 8, 4]) {
    assert.ok(set.has(pct), `expected ${pct} to have fired`);
  }
  assert.ok(!set.has(2), '2 must NOT fire (3 > 2)');
});

test('hysteresis — a value hovering on a boundary does not re-arm/chatter', () => {
  const fired: number[] = [];
  const alarm = makeAlarm((t) => fired.push(t.pct));
  alarm.update(50); // arms all
  alarm.update(19); // crosses 40, 30, 20
  assert.deepEqual(fired, [40, 30, 20]);
  // +1 over the 20 boundary is NOT enough hysteresis to re-arm 20.
  alarm.update(21);
  assert.deepEqual(fired, [40, 30, 20]);
  // +2 over the boundary DOES re-arm 20.
  alarm.update(22);
  // Back below 20 → 20 fires again (now the 4th entry).
  alarm.update(19);
  assert.deepEqual(fired, [40, 30, 20, 20]);
});

test('activeSocBand — lowest threshold currently crossed', () => {
  assert.equal(activeSocBand(51), null); // above the top threshold (now 50)
  assert.equal(activeSocBand(50)?.pct, 50); // 50 ≤ 50 → the new top band
  assert.equal(activeSocBand(45)?.pct, 50); // 45 ≤ 50, > 40
  assert.equal(activeSocBand(18)?.pct, 20); // 18 ≤ 20, > 15
  assert.equal(activeSocBand(1)?.pct, 2); // 1 ≤ 2 (the lowest band)
});

test('socAlertSeverity — derives the (severity, source) for each priority', () => {
  assert.deepEqual(socAlertSeverity('medium'), { severity: 'warning', source: 'learned' });
  assert.equal(socAlertSeverity('high').source, 'threshold');
  assert.equal(socAlertSeverity('critical').severity, 'critical');
  assert.equal(socAlertSeverity('low').severity, 'info');
});

test('socAlarmMessage — speaks the pct and band', () => {
  assert.ok(
    socAlarmMessage({ pct: 20, priority: 'medium' }).includes('Backup pool at 20 percent'),
  );
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
