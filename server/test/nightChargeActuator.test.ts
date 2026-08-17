import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNightChargeMode,
  effectiveActuationMode,
  clampReserveTarget,
  emptyActuationState,
  coerceActuationState,
  armFromPlan,
  decideActuation,
  APPLY_LEAD_MS,
  APPLY_LATE_MS,
  REVERT_LAG_MS,
  type NightActuationState,
  type ArmablePlan,
  type ActuationTickOpts,
  APPLY_VERIFY_AFTER_MS,
  APPLY_MAX_RETRIES,
} from '../src/nightChargeActuator.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeActuator — the supervised-write decision core (v1.50.0).
 *
 * PURE decision logic; these tests pin the fail-CLOSED apply guards (any
 * missing/incoherent input ⇒ no write), the announced-plan arming rules (a
 * hold/incomplete/windowless plan never arms; an unresolved applied night
 * refuses re-arming), and the always-on revert path (mode-independent,
 * cancel-triggered, invalid-restore-refusing).
 * ═════════════════════════════════════════════════════════════════════════ */

const T0 = Date.UTC(2026, 6, 16, 6 + 24, 0); // arbitrary fixed instant
const WINDOW = { startMs: T0 + 2 * 3_600_000, endMs: T0 + 8 * 3_600_000 };

function plan(overrides: Partial<ArmablePlan> = {}): ArmablePlan {
  return {
    chargeTonight: true,
    basisComplete: true,
    buyKwh: 40,
    // v1.60.0 — the write arms from the SETPOINT (the resilience requirement),
    // never from the contention-derated arrival the plan predicts.
    setpointSocPct: 43.2,
    window: { ...WINDOW },
    ...overrides,
  };
}

function armed(): NightActuationState {
  const s = armFromPlan(emptyActuationState(), '2026-07-16', plan(), T0, 10);
  assert.ok(s, 'fixture plan must arm');
  return s!;
}

function opts(overrides: Partial<ActuationTickOpts> = {}): ActuationTickOpts {
  return { mode: 'supervised', writeReady: false, currentReservePct: 10, socCoherent: true, vitalsRed: false, gridPresent: true, ...overrides };
}

// ── Mode + clamp ────────────────────────────────────────────────────────────

test('resolveNightChargeMode: unknown/absent fail closed to advisory', () => {
  assert.equal(resolveNightChargeMode('supervised'), 'supervised');
  assert.equal(resolveNightChargeMode('auto'), 'auto');
  assert.equal(resolveNightChargeMode('advisory'), 'advisory');
  assert.equal(resolveNightChargeMode('Supervised'), 'advisory');
  assert.equal(resolveNightChargeMode(''), 'advisory');
  assert.equal(resolveNightChargeMode(undefined), 'advisory');
  assert.equal(resolveNightChargeMode(null), 'advisory');
});

test('clampReserveTarget: rounds and clamps to the device [10, 50] range', () => {
  assert.equal(clampReserveTarget(43.2), 43);
  assert.equal(clampReserveTarget(80), 50);
  assert.equal(clampReserveTarget(3), 10);
  assert.equal(clampReserveTarget(49.6), 50);
});

// ── Arming ──────────────────────────────────────────────────────────────────

test('armFromPlan: a charge plan arms with the clamped SETPOINT', () => {
  const s = armed();
  assert.equal(s.day, '2026-07-16');
  assert.equal(s.targetPct, 43);
  assert.equal(s.buyKwh, 40);
  assert.equal(s.windowStartMs, WINDOW.startMs);
  assert.equal(s.cancelled, false);
  assert.equal(s.appliedAtMs, null);
});

test('armFromPlan: hold / incomplete / windowless / zero-buy plans never arm', () => {
  const prev = emptyActuationState();
  assert.equal(armFromPlan(prev, 'd', plan({ chargeTonight: false }), T0, 10), null);
  assert.equal(armFromPlan(prev, 'd', plan({ basisComplete: false }), T0, 10), null);
  assert.equal(armFromPlan(prev, 'd', plan({ window: null }), T0, 10), null);
  assert.equal(armFromPlan(prev, 'd', plan({ setpointSocPct: null }), T0, 10), null);
  assert.equal(armFromPlan(prev, 'd', plan({ buyKwh: 0 }), T0, 10), null);
  assert.equal(armFromPlan(prev, 'd', plan({ buyKwh: null }), T0, 10), null);
});

test('armFromPlan: refuses to replace an applied-but-unreverted night', () => {
  const prev: NightActuationState = { ...armed(), appliedAtMs: T0, priorReservePct: 10 };
  assert.equal(armFromPlan(prev, '2026-07-17', plan(), T0, 10), null);
});

test('armFromPlan: replaces a resolved (reverted) prior night', () => {
  const prev: NightActuationState = { ...armed(), appliedAtMs: T0, priorReservePct: 10, revertedAtMs: T0 + 1 };
  const s = armFromPlan(prev, '2026-07-17', plan(), T0, 10);
  assert.ok(s);
  assert.equal(s!.day, '2026-07-17');
});

// ── Apply guards (every one fail-closed) ────────────────────────────────────

test('apply fires inside [windowStart − 5 min, windowStart + 30 min]', () => {
  const s = armed();
  assert.equal(decideActuation(s, WINDOW.startMs - APPLY_LEAD_MS - 1, opts()).kind, 'none');
  assert.deepEqual(decideActuation(s, WINDOW.startMs - APPLY_LEAD_MS, opts()), { kind: 'apply', targetPct: 43 });
  assert.deepEqual(decideActuation(s, WINDOW.startMs + APPLY_LATE_MS, opts()), { kind: 'apply', targetPct: 43 });
  assert.equal(decideActuation(s, WINDOW.startMs + APPLY_LATE_MS + 1, opts()).kind, 'none');
});

test('apply guards: advisory mode / cancel / red vitals / incoherent SoC → none', () => {
  const s = armed();
  const at = WINDOW.startMs; // inside the apply window
  assert.equal(decideActuation(s, at, opts({ mode: 'advisory' })).kind, 'none');
  assert.equal(decideActuation({ ...s, cancelled: true }, at, opts()).kind, 'none');
  assert.equal(decideActuation(s, at, opts({ vitalsRed: true })).kind, 'none');
  assert.equal(decideActuation(s, at, opts({ socCoherent: false })).kind, 'none');
});

test('apply guards: unknown/out-of-range/non-integer current reserve → none', () => {
  const s = armed();
  const at = WINDOW.startMs;
  assert.equal(decideActuation(s, at, opts({ currentReservePct: null })).kind, 'none');
  assert.equal(decideActuation(s, at, opts({ currentReservePct: 9 })).kind, 'none');
  assert.equal(decideActuation(s, at, opts({ currentReservePct: 51 })).kind, 'none');
  assert.equal(decideActuation(s, at, opts({ currentReservePct: 10.5 })).kind, 'none');
});

test('apply guard: target at/below the current reserve → nothing to raise', () => {
  const s = armed(); // target 43
  assert.equal(decideActuation(s, WINDOW.startMs, opts({ currentReservePct: 43 })).kind, 'none');
  assert.equal(decideActuation(s, WINDOW.startMs, opts({ currentReservePct: 50 })).kind, 'none');
});

test('idle state → none', () => {
  assert.equal(decideActuation(emptyActuationState(), T0, opts()).kind, 'none');
});

// ── Revert (always allowed) ─────────────────────────────────────────────────

function appliedState(): NightActuationState {
  // v1.79.0 — applyVerifiedAtMs is set: these tests pin REVERT timing/refusal
  // semantics in isolation, so the readback machinery (tested separately
  // below) must not trip on the fixture's unverified-write shape.
  return { ...armed(), appliedAtMs: WINDOW.startMs, applyVerifiedAtMs: WINDOW.startMs + 1, priorReservePct: 10 };
}

test('revert fires at window close + 5 min with the prior value', () => {
  const s = appliedState();
  assert.equal(decideActuation(s, WINDOW.endMs + REVERT_LAG_MS - 1, opts()).kind, 'none');
  assert.deepEqual(decideActuation(s, WINDOW.endMs + REVERT_LAG_MS, opts()), { kind: 'revert', restorePct: 10 });
});

test('revert runs even in advisory mode (mode flip mid-night must not orphan the reserve)', () => {
  const s = appliedState();
  assert.deepEqual(
    decideActuation(s, WINDOW.endMs + REVERT_LAG_MS, opts({ mode: 'advisory' })),
    { kind: 'revert', restorePct: 10 },
  );
});

test('post-apply cancel triggers an immediate revert', () => {
  const s: NightActuationState = { ...appliedState(), cancelled: true };
  assert.deepEqual(decideActuation(s, WINDOW.startMs + 60_000, opts()), { kind: 'revert', restorePct: 10 });
});

test('revert refuses an invalid restore value (never writes garbage back)', () => {
  const bad: NightActuationState = { ...appliedState(), priorReservePct: null };
  assert.equal(decideActuation(bad, WINDOW.endMs + REVERT_LAG_MS, opts()).kind, 'none');
  const oob: NightActuationState = { ...appliedState(), priorReservePct: 7 };
  assert.equal(decideActuation(oob, WINDOW.endMs + REVERT_LAG_MS, opts()).kind, 'none');
});

test('already-reverted night → none (idempotent)', () => {
  const s: NightActuationState = { ...appliedState(), revertedAtMs: WINDOW.endMs + REVERT_LAG_MS };
  assert.equal(decideActuation(s, WINDOW.endMs + 2 * REVERT_LAG_MS, opts()).kind, 'none');
});

// ── Persistence coercion ────────────────────────────────────────────────────

test('coerceActuationState: garbage → idle; sound record round-trips', () => {
  assert.deepEqual(coerceActuationState(null), emptyActuationState());
  assert.deepEqual(coerceActuationState('x'), emptyActuationState());
  assert.deepEqual(coerceActuationState({ day: 'not-a-date' }), emptyActuationState());
  const s = appliedState();
  const rt = coerceActuationState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(rt, s);
});

// ── v1.50.0 review fixes: auto-mode gating, unconfirmed-write adoption ──────

test('effectiveActuationMode: auto is DEMOTED to supervised until writeReady', () => {
  assert.equal(effectiveActuationMode('auto', false), 'supervised');
  assert.equal(effectiveActuationMode('auto', true), 'auto');
  assert.equal(effectiveActuationMode('supervised', false), 'supervised');
  assert.equal(effectiveActuationMode('supervised', true), 'supervised');
  assert.equal(effectiveActuationMode('advisory', true), 'advisory');
});

test('auto mode without writeReady still runs the supervised flow (evidence collection)', () => {
  const s = armed();
  assert.deepEqual(
    decideActuation(s, WINDOW.startMs, opts({ mode: 'auto', writeReady: false })),
    { kind: 'apply', targetPct: 43 },
  );
});

function attemptedState(): NightActuationState {
  // Write issued at window open with baseline 10, no success recorded.
  return { ...armed(), applyAttemptedAtMs: WINDOW.startMs, attemptBaselinePct: 10 };
}

test('adopt: device reads the attempted target (≠ baseline) → the lost-confirmation write is adopted', () => {
  const s = attemptedState();
  assert.deepEqual(
    decideActuation(s, WINDOW.startMs + 60_000, opts({ currentReservePct: 43 })),
    { kind: 'adopt', priorPct: 10 },
  );
  // Mode-independent and time-independent: adoption still fires after the
  // window (and even if the owner flipped to advisory) — the raised reserve
  // must find its way back down.
  assert.deepEqual(
    decideActuation(s, WINDOW.endMs + 3_600_000, opts({ mode: 'advisory', currentReservePct: 43 })),
    { kind: 'adopt', priorPct: 10 },
  );
});

test('adopt does NOT fire when the reserve still reads the baseline (write truly failed) — retry applies instead', () => {
  const s = attemptedState();
  assert.deepEqual(
    decideActuation(s, WINDOW.startMs + 60_000, opts({ currentReservePct: 10 })),
    { kind: 'apply', targetPct: 43 },
  );
});

test('adopt does NOT fire on a third-party reading (never guess a revert target)', () => {
  const s = attemptedState();
  assert.equal(decideActuation(s, WINDOW.startMs + 60_000, opts({ currentReservePct: 30 })).kind, 'apply');
  assert.equal(decideActuation(s, WINDOW.endMs + 3_600_000, opts({ currentReservePct: 30 })).kind, 'none');
});

test('adopt is idempotent: an already-applied or reverted night never re-adopts', () => {
  const appliedS: NightActuationState = { ...attemptedState(), appliedAtMs: WINDOW.startMs, priorReservePct: 10 };
  assert.notEqual(decideActuation(appliedS, WINDOW.endMs + REVERT_LAG_MS, opts({ currentReservePct: 43 })).kind, 'adopt');
  const revertedS: NightActuationState = { ...appliedS, revertedAtMs: WINDOW.endMs + REVERT_LAG_MS };
  assert.equal(decideActuation(revertedS, WINDOW.endMs + 2 * REVERT_LAG_MS, opts({ currentReservePct: 43 })).kind, 'none');
});

test('armFromPlan: an unresolved unconfirmed attempt refuses re-arming unless provably un-applied', () => {
  const prev = attemptedState();
  // Live reading unknown → fail-closed, no re-arm.
  assert.equal(armFromPlan(prev, '2026-07-17', plan(), T0, null), null);
  // Live reading at the old target → the write landed; adoption must resolve it first.
  assert.equal(armFromPlan(prev, '2026-07-17', plan(), T0, 43), null);
  // Live reading still at the attempt baseline → the write provably never landed; safe to arm.
  assert.ok(armFromPlan(prev, '2026-07-17', plan(), T0, 10));
});

test('coerceActuationState round-trips the attempt fields', () => {
  const s = attemptedState();
  assert.deepEqual(coerceActuationState(JSON.parse(JSON.stringify(s))), s);
});

/* ═══ v1.79.0 — readback verification: a cloud ACK is not an actuation ═══════ */

function ackedState(over: Partial<NightActuationState> = {}): NightActuationState {
  // The 08-16 23:55 shape: write ACK'd (appliedAtMs set), device untouched.
  return {
    ...armed(), applyAttemptedAtMs: T0 + 1, appliedAtMs: T0 + 1, priorReservePct: 10,
    ...over,
  };
}

test('THE PHANTOM: device still reads the prior reserve after the grace — retry the write', () => {
  const a = decideActuation(ackedState(), T0 + 1 + APPLY_VERIFY_AFTER_MS, opts({ currentReservePct: 10 }));
  assert.deepEqual(a, { kind: 'retryApply', targetPct: 43 });
});

test('device readback shows the target — stamp verification (before or after the grace)', () => {
  assert.deepEqual(decideActuation(ackedState(), T0 + 60_000, opts({ currentReservePct: 43 })), { kind: 'applyVerified' });
  assert.deepEqual(decideActuation(ackedState(), T0 + 1 + APPLY_VERIFY_AFTER_MS + 60_000, opts({ currentReservePct: 43 })), { kind: 'applyVerified' });
});

test('retries exhausted and still not taken — applyFailed fires exactly once', () => {
  const s = ackedState({ applyRetries: APPLY_MAX_RETRIES, applyLastAttemptMs: T0 + 1 });
  assert.deepEqual(decideActuation(s, T0 + 1 + APPLY_VERIFY_AFTER_MS, opts({ currentReservePct: 10 })), { kind: 'applyFailed' });
  assert.deepEqual(
    decideActuation({ ...s, applyEscalated: true }, T0 + 1 + APPLY_VERIFY_AFTER_MS, opts({ currentReservePct: 10 })),
    { kind: 'none' }, 'the warning goes once per night');
});

test('each retry earns a fresh verification window (measured from applyLastAttemptMs)', () => {
  const s = ackedState({ applyRetries: 1, applyLastAttemptMs: T0 + 10 * 60_000 });
  assert.deepEqual(
    decideActuation(s, T0 + 10 * 60_000 + APPLY_VERIFY_AFTER_MS - 1_000, opts({ currentReservePct: 10 })),
    { kind: 'none' }, 'still inside the retry grace');
});

test('no retry once the window is nearly over — escalate instead of writing into a closing window', () => {
  const nearEnd = WINDOW.endMs - APPLY_VERIFY_AFTER_MS + 1;
  const s = ackedState({ applyLastAttemptMs: nearEnd - APPLY_VERIFY_AFTER_MS });
  assert.deepEqual(decideActuation(s, nearEnd, opts({ currentReservePct: 10 })), { kind: 'applyFailed' });
});

test('readback pauses on a null (unknown/starved) reading — never retries or escalates blind', () => {
  assert.deepEqual(
    decideActuation(ackedState(), T0 + 1 + 2 * APPLY_VERIFY_AFTER_MS, opts({ currentReservePct: null })),
    { kind: 'none' });
});

test('a verified night skips the readback machinery entirely', () => {
  const s = ackedState({ applyVerifiedAtMs: T0 + 2 });
  assert.deepEqual(decideActuation(s, T0 + 1 + 2 * APPLY_VERIFY_AFTER_MS, opts({ currentReservePct: 10 })), { kind: 'none' });
});

/* ═══ v1.79.0 — grid-loss abort ═════════════════════════════════════════════ */

test('grid lost mid-window: revert NOW, flagged as the abort path', () => {
  const a = decideActuation(ackedState(), T0 + 60_000, opts({ gridPresent: false }));
  assert.deepEqual(a, { kind: 'revert', restorePct: 10, gridLossAbort: true });
});

test('grid UNKNOWN never aborts — normal schedule holds', () => {
  const a = decideActuation(ackedState(), T0 + 60_000, opts({ gridPresent: null, currentReservePct: 43 }));
  assert.deepEqual(a, { kind: 'applyVerified' }, 'null grid falls through to the readback, not the abort');
});

test('grid-loss abort still beats the readback machinery (order: abort > due-revert > readback)', () => {
  const s = ackedState({ applyRetries: APPLY_MAX_RETRIES });
  assert.deepEqual(
    decideActuation(s, T0 + 1 + APPLY_VERIFY_AFTER_MS, opts({ gridPresent: false, currentReservePct: 10 })),
    { kind: 'revert', restorePct: 10, gridLossAbort: true });
});

test('window-close revert unchanged (no abort flag on the normal path)', () => {
  const a = decideActuation(ackedState(), WINDOW.endMs + 5 * 60_000 + 1, opts({}));
  assert.deepEqual(a, { kind: 'revert', restorePct: 10 });
});
