import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyRunway,
  runwayAlarmMessage,
  createRunwayAlarm,
  type RunwayAlarmInput,
} from '../src/runwayAlarm.js';

// v0.14.0 — unit tests for the projection-depletion audible alarm. Each alarm
// gets a UNIQUE tmp statePath (it persists announced-priority/lastAnnouncedAt on
// construction) so state never leaks between cases. The alarm uses the
// projection's own generatedAt as its clock, so time is fully controlled here.
const tmpPaths: string[] = [];
let seq = 0;
function makeAlarm(onTrigger: (priority: string) => void, reannounceMs = 60 * 60 * 1000) {
  const statePath = join(tmpdir(), `runway-${process.pid}-${Date.now()}-${seq++}.json`);
  tmpPaths.push(statePath);
  // rearmWarmupMs: 0 — tests run inside the real 3-min post-boot window, so
  // the v0.15.18 warm-up gate must be disabled to exercise re-arm behavior.
  return createRunwayAlarm({ onTrigger: (p) => onTrigger(p), statePath, reannounceMs, rearmWarmupMs: 0 });
}

const proj = (over: Partial<RunwayAlarmInput>): RunwayAlarmInput => ({
  generatedAt: 0,
  hoursToReserve: null,
  hoursToEmpty: null,
  unavailable: null,
  ...over,
});

test('classifyRunway — escalation bands (reserve-floor trigger)', () => {
  assert.equal(classifyRunway(proj({})), null); // nothing projected → no alarm
  assert.equal(classifyRunway(proj({ unavailable: 'no data', hoursToReserve: 1 })), null);
  assert.equal(classifyRunway(proj({ hoursToReserve: 20 })), 'low'); // finite reserve in horizon
  assert.equal(classifyRunway(proj({ hoursToReserve: 5 })), 'medium'); // ≤6h to reserve
  assert.equal(classifyRunway(proj({ hoursToReserve: 5, hoursToEmpty: 7 })), 'high'); // empty ≤8h dominates
  assert.equal(classifyRunway(proj({ hoursToReserve: 1, hoursToEmpty: 2 })), 'critical'); // empty ≤3h
});

test('announces on entering, silent again within the re-announce window', () => {
  const fired: string[] = [];
  const a = makeAlarm((p) => fired.push(p));
  a.update(proj({ generatedAt: 0, hoursToReserve: 20 })); // enter → low
  assert.deepEqual(fired, ['low']);
  a.update(proj({ generatedAt: 10 * 60_000, hoursToReserve: 18 })); // +10min, still low → no repeat
  assert.deepEqual(fired, ['low']);
});

test('re-announces once the projection persists past the re-announce window', () => {
  const fired: string[] = [];
  const a = makeAlarm((p) => fired.push(p), 60 * 60_000);
  a.update(proj({ generatedAt: 0, hoursToReserve: 20 }));
  a.update(proj({ generatedAt: 61 * 60_000, hoursToReserve: 19 })); // >60min → stale → re-announce
  assert.deepEqual(fired, ['low', 'low']);
});

test('escalates immediately on a higher tier', () => {
  const fired: string[] = [];
  const a = makeAlarm((p) => fired.push(p));
  a.update(proj({ generatedAt: 0, hoursToReserve: 20 })); // low
  a.update(proj({ generatedAt: 5 * 60_000, hoursToReserve: 1, hoursToEmpty: 2 })); // → critical now
  assert.deepEqual(fired, ['low', 'critical']);
});

test('re-arms on recovery, announces fresh on re-entry', () => {
  const fired: string[] = [];
  const a = makeAlarm((p) => fired.push(p));
  a.update(proj({ generatedAt: 0, hoursToReserve: 20 })); // low
  a.update(proj({ generatedAt: 5 * 60_000 })); // recovered → re-arm, silent
  assert.deepEqual(fired, ['low']);
  a.update(proj({ generatedAt: 10 * 60_000, hoursToReserve: 20 })); // re-enter → announce again
  assert.deepEqual(fired, ['low', 'low']);
});

test('de-escalation is silent but tracked, so the next rise re-announces', () => {
  const fired: string[] = [];
  const a = makeAlarm((p) => fired.push(p));
  a.update(proj({ generatedAt: 0, hoursToReserve: 1, hoursToEmpty: 2 })); // critical
  a.update(proj({ generatedAt: 5 * 60_000, hoursToReserve: 20 })); // de-escalate to low → silent
  assert.deepEqual(fired, ['critical']);
  a.update(proj({ generatedAt: 10 * 60_000, hoursToReserve: 1, hoursToEmpty: 2 })); // re-escalate → critical
  assert.deepEqual(fired, ['critical', 'critical']);
});

test('message phrasing — reserve vs empty', () => {
  assert.match(runwayAlarmMessage(proj({ hoursToReserve: 5 }), 'medium'), /reach reserve in about 5 hours/i);
  assert.match(
    runwayAlarmMessage(proj({ hoursToEmpty: 2, hoursToReserve: 1 }), 'critical'),
    /projected empty in about 2 hours/i,
  );
});

test.after(() => {
  for (const p of tmpPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

/* ─── v0.15.18 — at/below the reserve floor is CRITICAL ──────────────── */

test('classifyRunway — at/below the reserve floor → critical regardless of horizon math', () => {
  // Observed Jun 10 00:51 local: pool pinned at the 10% floor, yet the ladder
  // said "high — reserve in 18.8h" (the rising-then-crossing figure).
  const atFloor = proj({ hoursToReserve: 18.8, hoursToEmpty: 4.3, backupRemainingKwh: 9.2, backupReserveKwh: 9.22 });
  assert.equal(classifyRunway(atFloor), 'critical');
  // Above the floor, the normal ladder applies (empty in 4.3h → high).
  const above = proj({ hoursToReserve: 18.8, hoursToEmpty: 4.3, backupRemainingKwh: 20, backupReserveKwh: 9.22 });
  assert.equal(classifyRunway(above), 'high');
});

test('runwayAlarmMessage — floor condition speaks the actual state, not a stale projection', () => {
  const atFloor = proj({ hoursToReserve: 18.8, hoursToEmpty: 4.3, backupRemainingKwh: 9.2, backupReserveKwh: 9.22 });
  const msg = runwayAlarmMessage(atFloor, 'critical');
  assert.match(msg, /^Critical alarm\. Critical alarm\./);
  assert.match(msg, /reserve floor/);
  assert.doesNotMatch(msg, /projected/);
});
