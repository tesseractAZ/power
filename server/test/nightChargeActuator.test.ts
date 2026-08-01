import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNightChargeMode,
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
    targetSocPct: 43.2,
    window: { ...WINDOW },
    ...overrides,
  };
}

function armed(): NightActuationState {
  const s = armFromPlan(emptyActuationState(), '2026-07-16', plan(), T0);
  assert.ok(s, 'fixture plan must arm');
  return s!;
}

function opts(overrides: Partial<ActuationTickOpts> = {}): ActuationTickOpts {
  return { mode: 'supervised', currentReservePct: 10, socCoherent: true, vitalsRed: false, ...overrides };
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

test('armFromPlan: a charge plan arms with the clamped target', () => {
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
  assert.equal(armFromPlan(prev, 'd', plan({ chargeTonight: false }), T0), null);
  assert.equal(armFromPlan(prev, 'd', plan({ basisComplete: false }), T0), null);
  assert.equal(armFromPlan(prev, 'd', plan({ window: null }), T0), null);
  assert.equal(armFromPlan(prev, 'd', plan({ targetSocPct: null }), T0), null);
  assert.equal(armFromPlan(prev, 'd', plan({ buyKwh: 0 }), T0), null);
  assert.equal(armFromPlan(prev, 'd', plan({ buyKwh: null }), T0), null);
});

test('armFromPlan: refuses to replace an applied-but-unreverted night', () => {
  const prev: NightActuationState = { ...armed(), appliedAtMs: T0, priorReservePct: 10 };
  assert.equal(armFromPlan(prev, '2026-07-17', plan(), T0), null);
});

test('armFromPlan: replaces a resolved (reverted) prior night', () => {
  const prev: NightActuationState = { ...armed(), appliedAtMs: T0, priorReservePct: 10, revertedAtMs: T0 + 1 };
  const s = armFromPlan(prev, '2026-07-17', plan(), T0);
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
  return { ...armed(), appliedAtMs: WINDOW.startMs, priorReservePct: 10 };
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
