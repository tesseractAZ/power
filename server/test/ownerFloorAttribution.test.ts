import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerReserveFloorPct, setOwnerReserveFloorPct, getOwnerReserveFloorPct,
  resetOwnerReserveFloorPct, LEGACY_REVERT_LAG_MS,
} from '../src/nightChargeActuator.js';
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
  const held = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 20 };
  assert.equal(ownerReserveFloorPct(held, 50), 20,
    'the runway alarm must not read our own instruction as the owner floor');
});

test('owner floor: idle / reverted actuator falls through to the live device value', () => {
  assert.equal(ownerReserveFloorPct({ appliedAtMs: null, revertedAtMs: null, priorReservePct: null }, 20), 20);
  assert.equal(ownerReserveFloorPct({ appliedAtMs: 1_000, revertedAtMs: 2_000, priorReservePct: 20 }, 20), 20);
});

test('owner floor: an out-of-envelope or missing prior falls back rather than inventing a floor', () => {
  const bad = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 99 };
  assert.equal(ownerReserveFloorPct(bad, 50), 50, 'never trust a prior outside [10,50]');
  const none = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: null };
  assert.equal(ownerReserveFloorPct(none, 50), 50);
});

test('owner floor: null live value stays null — no fabricated floor', () => {
  assert.equal(ownerReserveFloorPct({ appliedAtMs: null, revertedAtMs: null, priorReservePct: null }, null), null);
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
  const holding = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 20 };
  assert.equal(ownerReserveFloorPct(holding, 50), 20,
    'a recompute during the hold must still size against 20');
  // Outside the hold the device value IS the owner floor.
  const idle = { appliedAtMs: null, revertedAtMs: null, priorReservePct: null };
  assert.equal(ownerReserveFloorPct(idle, 20), 20);
});

test('all three sibling consumers now derive the floor from one helper', () => {
  // below-reserve alert (v1.113.0), runway alarm (v1.115.0), planner (v1.116.0).
  // One fact, one function — the drift that produced three separate defects
  // came from each consumer reading backupReserveSoc for itself.
  const holding = { appliedAtMs: 1_000, revertedAtMs: null, priorReservePct: 20 };
  const viaHelper = ownerReserveFloorPct(holding, 50);
  assert.equal(viaHelper, 20);
  assert.notEqual(viaHelper, 50, 'none of them may see the actuator hold as a floor');
});
