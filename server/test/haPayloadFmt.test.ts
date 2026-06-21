import test from 'node:test';
import assert from 'node:assert/strict';
import { kwh1, makeLifetimeKwh, makeAlertCounter, soonestProjecting } from '../src/haPayloadFmt.js';
import type { LifetimeTotals } from '../src/recorder.js';
import type { Alert } from '../src/alerts.js';
import type { FleetDegradation } from '../src/analytics.js';

/**
 * v0.52.0 — covers the four HA-payload helpers shared by /api/ha-state and MQTT
 * buildState. Neither inline copy had runtime tests; these pin the exact
 * rounding / null-guard semantics so the published HA values cannot drift.
 */

test('kwh1: null/undefined → null; Math.round(wh/100)/10 (NOTE: tenths-of-100Wh granularity)', () => {
  assert.equal(kwh1(null), null);
  assert.equal(kwh1(undefined), null);
  assert.equal(kwh1(0), 0); // 0 is NOT treated as null (it is `== null` false)
  // kwh1 = Math.round(wh/100)/10 — rounds to the nearest 100 Wh, expressed in kWh.
  assert.equal(kwh1(1234), 1.2); // round(12.34)/10 = 12/10
  assert.equal(kwh1(1250), 1.3); // round(12.5)/10 = 13/10  (round-half-up)
  assert.equal(kwh1(1299), 1.3); // round(12.99)/10 = 13/10
  assert.equal(kwh1(12_340), 12.3); // round(123.4)/10 = 123/10
});

function lt(persistedWh: number, pendingWh: number): LifetimeTotals {
  return { persistedWh, pendingWh, watermarkMs: 0 };
}

test('makeLifetimeKwh: missing key → null; sums persisted+pending and rounds to 3 decimals', () => {
  const lifetime: Record<string, LifetimeTotals> = {
    fleet_pv_wh: lt(1_234_567, 432),
    zero_entry: lt(0, 0), // falsy entry object is still truthy → NOT null; but value rounds to 0
  };
  const f = makeLifetimeKwh(lifetime);
  assert.equal(f('absent_key'), null, 'absent key → null (the `lifetime[k] ?` guard)');
  // (1234567 + 432) / 1000 = 1234.999 → *1000 round /1000 = 1234.999
  assert.equal(f('fleet_pv_wh'), 1234.999);
  // present-but-zero entry: the object is truthy, so it is NOT null; value is 0.
  assert.equal(f('zero_entry'), 0);
});

function alert(id: string, severity: Alert['severity'], source?: Alert['source']): Alert {
  return { id, severity, category: 'Battery', device: 'X', title: 't', detail: 'd', ...(source ? { source } : {}) } as Alert;
}

test('makeAlertCounter: threshold = every non-learned source; split by severity', () => {
  const alerts: Alert[] = [
    alert('a', 'critical'), // source undefined → threshold
    alert('b', 'critical', 'threshold'),
    alert('c', 'warning', 'threshold'),
    alert('d', 'info'),
    alert('e', 'critical', 'learned'),
    alert('f', 'warning', 'learned'),
    alert('g', 'warning', 'learned'),
  ];
  const cnt = makeAlertCounter(alerts);
  assert.equal(cnt('threshold', 'critical'), 2, 'undefined-source + explicit threshold both count');
  assert.equal(cnt('threshold', 'warning'), 1);
  assert.equal(cnt('threshold', 'info'), 1);
  assert.equal(cnt('learned', 'critical'), 1);
  assert.equal(cnt('learned', 'warning'), 2);
  assert.equal(cnt('learned', 'info'), 0);
});

function pack(status: string, yearsToEol: number | null, peerOutlier = false): FleetDegradation['packs'][number] {
  return { status, yearsToEol, peerOutlier } as any;
}

test('soonestProjecting: empty → no projecting, null soonest', () => {
  const r = soonestProjecting([pack('stable', null), pack('insufficient-data', null)]);
  assert.equal(r.projecting.length, 0);
  assert.equal(r.soonest, null);
});

test('soonestProjecting: single projecting pack is the soonest', () => {
  const r = soonestProjecting([pack('stable', 50), pack('projecting', 7.5)]);
  assert.equal(r.projecting.length, 1);
  assert.equal(r.soonest?.yearsToEol, 7.5);
});

test('soonestProjecting: picks the fewest-years pack; null yearsToEol sorts last via 1e9 sentinel', () => {
  const r = soonestProjecting([
    pack('projecting', 9),
    pack('projecting', null), // 1e9 sentinel → never beats a real value
    pack('projecting', 3),
    pack('projecting', 12),
  ]);
  assert.equal(r.projecting.length, 4);
  assert.equal(r.soonest?.yearsToEol, 3);
});

test('soonestProjecting: ties keep the FIRST encountered (strict-less-than reduce)', () => {
  const first = pack('projecting', 5);
  const second = pack('projecting', 5);
  const r = soonestProjecting([first, second]);
  assert.equal(r.soonest, first, 'equal years → reduce keeps `best` (the earlier one)');
});

test('soonestProjecting: all-null projecting → soonest is the first (none beats the 1e9 sentinel)', () => {
  const a = pack('projecting', null);
  const b = pack('projecting', null);
  const r = soonestProjecting([a, b]);
  assert.equal(r.soonest, a);
});
