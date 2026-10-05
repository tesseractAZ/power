import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerReserveFloorPct, setOwnerReserveFloorPct, getOwnerReserveFloorPct,
  resetOwnerReserveFloorPct, LEGACY_REVERT_LAG_MS, REVERT_READBACK_GRACE_MS, isRevertSettling,
} from '../src/nightChargeActuator.js';
import { computeRunway, resetRunwayCache, type DayForecast } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import { classifyRunway } from '../src/runwayAlarm.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChange } from '../src/settingsDrift.js';
import { deliveredHoldSpan, ACTUATOR_TICK_MS, HOLD_DEVICE_SETTLE_MS } from '../src/nightLedgerScoring.js';

/**
 * v1.115.0 — three defects the 2026-08-29 analysis found, all one theme: a
 * consumer reading the DEVICE's current reserve (or the plan's nominal window)
 * when it needed the OWNER's floor (or the actuator's real hold span).
 */

beforeEach(() => resetOwnerReserveFloorPct());

// ── the owner floor vs the device's instruction ─────────────────────────────

test('owner floor: while the actuator holds 50, the owner floor is the RESTORE value', () => {
  const held = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 20, targetPct: 50 };
  assert.equal(ownerReserveFloorPct(held, 50, 2_000), 20,
    'the runway alarm must not read our own instruction as the owner floor');
});

test('owner floor: idle / reverted actuator falls through to the live device value', () => {
  assert.equal(ownerReserveFloorPct({ appliedAtMs: null, revertedAtMs: null, priorReservePct: null, targetPct: null }, 20, 3_000), 20);
  assert.equal(ownerReserveFloorPct({ appliedAtMs: 1_000, revertedAtMs: 2_000, priorReservePct: 20, targetPct: 50 }, 20, 3_000), 20);
});

test('owner floor: an out-of-envelope or missing prior falls back rather than inventing a floor', () => {
  const bad = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 99, targetPct: 50 };
  assert.equal(ownerReserveFloorPct(bad, 50, 2_000), 50, 'never trust a prior outside [10,50]');
  const none = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: null, targetPct: 50 };
  assert.equal(ownerReserveFloorPct(none, 50, 2_000), 50);
});

test('owner floor: null live value stays null — no fabricated floor', () => {
  assert.equal(ownerReserveFloorPct({ appliedAtMs: null, revertedAtMs: null, priorReservePct: null, targetPct: null }, null, 1_000), null);
});

test('owner floor publisher round-trips', () => {
  assert.equal(getOwnerReserveFloorPct(), null);
  setOwnerReserveFloorPct(20);
  assert.equal(getOwnerReserveFloorPct(), 20);
});

// ── the owner's own write must not be reported back as drift ────────────────

const change = (to: number) => ({ key: 'Smart Home Panel 2 · backupReserveSoc', from: 10, to } as any);

test('★ the owner reserve-floor write is OWN-WRITE, with no night in flight', () => {
  const ctx = { targetPct: null, priorReservePct: null, nightActive: false, ownerFloorPct: 20 };
  assert.equal(classifyChange(change(20), ctx), 'own-write',
    'the add-on flagged its own write as EXTERNAL tampering at warn level');
});

test('outside the grace window (caller passes null) it is external again', () => {
  const ctx = { targetPct: null, priorReservePct: null, nightActive: false, ownerFloorPct: null };
  assert.equal(classifyChange(change(20), ctx), 'external');
});

test('a DIFFERENT value while an owner write is pending is still external', () => {
  const ctx = { targetPct: null, priorReservePct: null, nightActive: false, ownerFloorPct: 20 };
  assert.equal(classifyChange(change(35), ctx), 'external',
    'only the value we actually wrote is ours');
});

test('night-charge own-writes keep working, and a genuine external change still warns', () => {
  const night = { targetPct: 50, priorReservePct: 20, nightActive: true, ownerFloorPct: null };
  assert.equal(classifyChange(change(50), night), 'own-write');
  assert.equal(classifyChange(change(20), night), 'own-write', 'the restore value too');
  assert.equal(classifyChange(change(33), night), 'external');
});

test('a non-reserve key is never own-write', () => {
  const ctx = { targetPct: null, priorReservePct: null, nightActive: false, ownerFloorPct: 20 };
  assert.equal(classifyChange({ key: 'Core 1 · chgMaxSoc', from: 70, to: 20 } as any, ctx), 'external');
});

// ── the delivered-energy span ───────────────────────────────────────────────

test('delivered span covers the real hold, which straddles the nominal window', () => {
  // The 08-28 night: nominal window 23:00->00:00, actual hold 22:55:55->00:05:55 — the
  // pre-v1.187.0 schedule (5 min lead, 5 min lag), which the scorer still honours for an
  // unstamped row applied before its window (LEGACY_REVERT_LAG_MS). v1.187.0 (review): read
  // through deliveredHoldSpan, the scorer's own function, not re-derived here.
  const windowStart = Date.UTC(2026, 7, 29, 6, 0);   // 23:00 MST
  const windowEnd = Date.UTC(2026, 7, 29, 7, 0);     // 00:00 MST
  const appliedAt = windowStart - 4 * 60_000 - 5_000; // 22:55:55
  const { startMs: holdStart, endMs: holdEnd } = deliveredHoldSpan({ windowStartMs: windowStart, windowEndMs: windowEnd, appliedAtMs: appliedAt, revertedAtMs: null });
  assert.ok(holdStart < windowStart, 'the legacy apply fired before the window opened');
  assert.ok(holdEnd > windowEnd, 'and its revert landed after it closed');
  // The straddle is the energy the old nominal integration dropped.
  assert.equal(holdEnd - windowEnd, LEGACY_REVERT_LAG_MS);
  assert.ok((windowStart - holdStart) > 0);
});

test('v1.187.0 — on the current schedule the hold starts at the window and ends at the restore, plus the settle', () => {
  const windowStart = Date.UTC(2026, 8, 29, 6, 0);
  const windowEnd = Date.UTC(2026, 8, 29, 12, 0);
  const appliedAt = windowStart + 28_000; // the first tick after the open
  const unstamped = deliveredHoldSpan({ windowStartMs: windowStart, windowEndMs: windowEnd, appliedAtMs: appliedAt, revertedAtMs: null });
  assert.equal(unstamped.startMs, windowStart);
  assert.equal(unstamped.endMs, windowEnd + ACTUATOR_TICK_MS + HOLD_DEVICE_SETTLE_MS, 'the restore tick after the close, and the stop');
  const stamped = deliveredHoldSpan({ windowStartMs: windowStart, windowEndMs: windowEnd, appliedAtMs: appliedAt, revertedAtMs: windowEnd + 28_000 });
  assert.equal(stamped.endMs, windowEnd + 28_000 + HOLD_DEVICE_SETTLE_MS);
});

test('delivered span never starts LATER than the window (a late apply cannot shrink it)', () => {
  const windowStart = 1_000_000;
  const lateApply = windowStart + 60_000;
  assert.equal(deliveredHoldSpan({ windowStartMs: windowStart, windowEndMs: windowStart + 3_600_000, appliedAtMs: lateApply, revertedAtMs: null }).startMs, windowStart);
});

// ── v1.116.0: the planner is the THIRD sibling reading the device ───────────

test('★ mid-window recompute: the planner must size against the OWNER floor, not our hold', () => {
  // The plan is recomputed ~every 30 min, including while our own write holds
  // the reserve at 50. Reading the device there makes floor+cushion 50+15=65%
  // — the add-on treating its own instruction as the owner's requirement.
  const holding = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 20, targetPct: 50 };
  assert.equal(ownerReserveFloorPct(holding, 50, 2_000), 20,
    'a recompute during the hold must still size against 20');
  // Outside the hold the device value IS the owner floor.
  const idle = { appliedAtMs: null, revertedAtMs: null, priorReservePct: null, targetPct: null };
  assert.equal(ownerReserveFloorPct(idle, 20, 2_000), 20);
});

test('all three sibling consumers now derive the floor from one helper', () => {
  // below-reserve alert (v1.113.0), runway alarm (v1.115.0), planner (v1.116.0).
  // One fact, one function — the drift that produced three separate defects
  // came from each consumer reading backupReserveSoc for itself.
  const holding = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 20, targetPct: 50 };
  const viaHelper = ownerReserveFloorPct(holding, 50, 2_000);
  assert.equal(viaHelper, 20);
  assert.notEqual(viaHelper, 50, 'none of them may see the actuator hold as a floor');
});

// ── v1.187.10: the floor holds through the revert READBACK lag ──────────────
//
// The revert stamps revertedAtMs on the cloud ACK; the SHP2 keeps reporting our 50% for
// ~20-60 s. ownerReserveFloorPct returned that 50 as the owner's floor until the readback,
// and the runway measured against it: 2026-10-03 00:01:25 "reserve in 5.6 h" from a pool of
// 67 kWh, with ~52 kWh of margin above the real 16% floor (6 of 10 revert nights in 14 days).

const REVERTED_AT = Date.UTC(2026, 9, 3, 7, 0, 55); // 00:00:55 MST
const reverted = { appliedAtMs: REVERTED_AT - 3_600_000, revertedAtMs: REVERTED_AT, priorReservePct: 16, targetPct: 50 };

test('★★★ reverted, the device still echoing our 50%, inside the grace: the owner floor is the PRIOR', () => {
  assert.equal(ownerReserveFloorPct(reverted, 50, REVERTED_AT + 20_000), 16,
    'the runway must not measure against our own just-reverted instruction');
  assert.equal(ownerReserveFloorPct(reverted, 50, REVERTED_AT), 16, 'from the ACK itself (persistNightActuation)');
  assert.equal(ownerReserveFloorPct(reverted, 50, REVERTED_AT + REVERT_READBACK_GRACE_MS), 16, 'to the end of the grace');
});

test('★★ the hold is the alert posture\'s own predicate, and ends exactly where it does', () => {
  for (const [live, dt] of [[50, 20_000], [50, REVERT_READBACK_GRACE_MS + 1], [16, 20_000], [30, 20_000], [50, -1]] as const) {
    const settling = isRevertSettling(reverted, live, REVERTED_AT + dt);
    assert.equal(ownerReserveFloorPct(reverted, live, REVERTED_AT + dt), settling ? 16 : live, `live ${live} at +${dt} ms`);
  }
});

test('★★ past the grace a device still at 50 IS the floor (a revert that did not take is not masked)', () => {
  assert.equal(ownerReserveFloorPct(reverted, 50, REVERTED_AT + REVERT_READBACK_GRACE_MS + 1), 50);
});

test('★★ after the readback (16) or an owner move to another value (30) the live value is the floor', () => {
  assert.equal(ownerReserveFloorPct(reverted, 16, REVERTED_AT + 60_000), 16);
  assert.equal(ownerReserveFloorPct(reverted, 30, REVERTED_AT + 60_000), 30, 'a genuine change is never masked');
  // A night that raised nothing (prior == target) never holds.
  assert.equal(ownerReserveFloorPct({ ...reverted, priorReservePct: 50 }, 50, REVERTED_AT + 20_000), 50);
});

const H = 3_600_000;
const MIN = 60_000;
/** The house panel at 00:01:25 on 10-03: 67 kWh of a 92.16 kWh pool, the device still at 50%. */
const panelAt = (remainWh: number, devicePct: number) => ({
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', backupFullCapWh: 92_160, backupRemainWh: remainWh, backupReserveSoc: devicePct,
      circuits: [], pairedCircuits: [],
    },
  },
}) as any;
const load = (w: number): Recorder => makeRecorderStub({
  query: (_sn: string, metric: string) => (metric === 'panel_load'
    ? Array.from({ length: 60 }, (_, i) => ({ ts: Date.now() - (60 - i) * MIN, value: w })) : []),
  queryMulti: () => new Map(),
  listMetrics: () => ['panel_load'],
}) as any;
/** A night then a solar day: 3.7 kW load, PV from hour 7 to 16. */
const nightThenSun = (): DayForecast => ({
  generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 16,
  hours: Array.from({ length: 24 }, (_, h) => ({
    ts: Date.now() + h * H, forecastPvW: h >= 7 && h < 16 ? 9_000 : 0, forecastLoadW: 3_700,
    cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: null, modelled: true,
  })),
  forecastPvWhNext24: 81_000, typicalPvWhPerDay: 0, forecastPvWhNext24Display: 81_000,
  typicalPvWhPerDayDisplay: 0, restoredSolarModel: {} as any,
}) as any;

test('★★★ the runway after a revert ACK measures against the OWNER floor, not the 50% echo (the 10-03 blip)', () => {
  const now = REVERTED_AT + 30_000;
  // The control: the floor the pre-fix helper pushed (the device's 50).
  resetRunwayCache();
  setOwnerReserveFloorPct(50);
  const blip = computeRunway(panelAt(67_000, 50), load(3_700), nightThenSun());
  assert.ok(blip.hoursToReserve != null && blip.hoursToReserve > 4 && blip.hoursToReserve < 7,
    `the defect reproduces: reserve in ${blip.hoursToReserve} h against 50%`);
  // The fix: what persistNightActuation and the snapshot handler now push.
  resetRunwayCache();
  setOwnerReserveFloorPct(ownerReserveFloorPct(reverted, 50, now));
  const r = computeRunway(panelAt(67_000, 50), load(3_700), nightThenSun());
  assert.ok(Math.abs((r.backupReserveKwh ?? 0) - 14.75) < 0.01, `floor 16% of 92.16 kWh (got ${r.backupReserveKwh})`);
  assert.equal(r.hoursToReserve, null, '~52 kWh above the floor carries the night to the sun');
  assert.equal(classifyRunway(r, { present: false, backstopping: false }), null, 'nothing to announce islanded');
});

test('★★★ a GRID-LOSS revert with the pool below 50%: not a false "at the reserve floor" critical', () => {
  // decideActuation reverts at once on a grid loss inside the window; mid-charge the pool is
  // typically below the raised 50%. Against 50 that is belowReserveFloor → critical, spoken
  // with no backstop ("shed load or start the generator"); the owner's floor is 16%.
  const now = REVERTED_AT + 15_000;
  resetRunwayCache();
  setOwnerReserveFloorPct(50);
  const wrong = computeRunway(panelAt(40_000, 50), load(3_700), nightThenSun());
  assert.equal(classifyRunway(wrong, { present: false, backstopping: false }), 'critical', 'the control: 40 kWh ≤ 46.08');
  resetRunwayCache();
  setOwnerReserveFloorPct(ownerReserveFloorPct(reverted, 50, now));
  const r = computeRunway(panelAt(40_000, 50), load(3_700), nightThenSun());
  assert.notEqual(classifyRunway(r, { present: false, backstopping: false }), 'critical');
  assert.ok((r.backupReserveKwh ?? 0) < 15);
});

/* ══ SOURCE PIN (index.ts has no seam a unit test can drive) ══════════════════
 * The hold above is only as good as the clock each call site hands it: a call site passing
 * anything but the current time reads every revert as settled (or never settled). */
test('★★ SOURCE PIN: every ownerReserveFloorPct call in index.ts passes the current clock', () => {
  const idx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  // The argument list of every call, by paren depth (the import line has no call paren).
  const calls: string[] = [];
  for (let at = idx.indexOf('ownerReserveFloorPct('); at >= 0; at = idx.indexOf('ownerReserveFloorPct(', at + 1)) {
    let depth = 0;
    const open = at + 'ownerReserveFloorPct'.length;
    for (let j = open; j < idx.length; j++) {
      if (idx[j] === '(') depth++;
      else if (idx[j] === ')' && --depth === 0) { calls.push(idx.slice(open + 1, j)); break; }
    }
  }
  assert.equal(calls.length, 7, `the boot seed (2), the snapshot push, persistNightActuation, the planner, the owner route (2): ${calls.join(' | ')}`);
  for (const args of calls) assert.match(args, /, (Date\.now\(\)|nowMs)$/, args);
  // The per-snapshot push is the one that ends the hold on the readback.
  assert.ok(idx.includes('analytics.pushOwnerFloor(ownerReserveFloorPct(nightActuationMem, live, Date.now()));'));
});
