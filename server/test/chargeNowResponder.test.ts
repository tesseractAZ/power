import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideChargeNowResponse, freshResponderState, resolveChargeNowMode,
  CHARGE_NOW_DAILY_CAP, FORCE_OFF_VERIFY_AFTER_MS, FORCE_OFF_MAX_RETRIES,
  type ResponderInputs, type ResponderState,
} from '../src/chargeNowResponder.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * chargeNowResponder — bounded response to the 08-04 incident class (v1.84.0).
 * The verdict already carries the economics (on-peak, grid present, pool above
 * reserve, 10-min dwell); these tests pin the RESPONSE discipline: modes,
 * storm hold, episode latch, daily cap, and the readback loop.
 * ═════════════════════════════════════════════════════════════════════════ */

const T0 = 1_787_000_000_000;
const ON = [{ slot: 1, label: 'Core 3', on: true }, { slot: 2, label: 'Core 1', on: false }];

function inputs(over: Partial<ResponderInputs> = {}): ResponderInputs {
  return {
    mode: 'supervised', verdictActive: true, slots: ON,
    stormPrepActive: false, nowMs: T0, phoenixDay: '2026-08-17', ...over,
  };
}

test('mode resolution fails safe to advisory', () => {
  assert.equal(resolveChargeNowMode('supervised'), 'supervised');
  assert.equal(resolveChargeNowMode('off'), 'off');
  assert.equal(resolveChargeNowMode('advisory'), 'advisory');
  assert.equal(resolveChargeNowMode('Supervised'), 'advisory');
  assert.equal(resolveChargeNowMode(undefined), 'advisory');
});

test('THE 08-04 RESPONSE: supervised turns OFF exactly the ON channels, once per episode', () => {
  const s = freshResponderState();
  const a = decideChargeNowResponse(s, inputs());
  assert.deepEqual(a, { kind: 'turnOff', on: [{ slot: 1, label: 'Core 3' }] });
  // pendingVerify holds further evaluation; a second tick inside the grace is none
  assert.equal(decideChargeNowResponse(s, inputs({ nowMs: T0 + 60_000 })).kind, 'none');
});

test('readback: device shows OFF → verified; still ON past grace → one retry → honest failure', () => {
  const s = freshResponderState();
  decideChargeNowResponse(s, inputs());
  // device flips OFF within the grace
  const off = [{ slot: 1, label: 'Core 3', on: false }, { slot: 2, label: 'Core 1', on: false }];
  assert.deepEqual(decideChargeNowResponse(s, inputs({ nowMs: T0 + 90_000, slots: off })),
    { kind: 'verified', slots: [1] });

  // fresh episode where the write never takes:
  const s2 = freshResponderState();
  decideChargeNowResponse(s2, inputs());
  const r = decideChargeNowResponse(s2, inputs({ nowMs: T0 + FORCE_OFF_VERIFY_AFTER_MS }));
  assert.deepEqual(r, { kind: 'retryWrite', slots: [1] });
  assert.equal(FORCE_OFF_MAX_RETRIES, 1);
  const f = decideChargeNowResponse(s2, inputs({ nowMs: T0 + 2 * FORCE_OFF_VERIFY_AFTER_MS }));
  assert.deepEqual(f, { kind: 'verifyFailed', slots: [1] });
});

test('readback verifies even after the draw stops (the write is owed its outcome)', () => {
  const s = freshResponderState();
  decideChargeNowResponse(s, inputs());
  const off = [{ slot: 1, label: 'Core 3', on: false }];
  const a = decideChargeNowResponse(s, inputs({ verdictActive: false, slots: off, nowMs: T0 + 60_000 }));
  assert.equal(a.kind, 'verified');
});

test('STORM HOLD: an active storm-prep advisory stands the responder down, logged once', () => {
  const s = freshResponderState();
  assert.deepEqual(decideChargeNowResponse(s, inputs({ stormPrepActive: true })), { kind: 'stormHold' });
  assert.equal(decideChargeNowResponse(s, inputs({ stormPrepActive: true, nowMs: T0 + 60_000 })).kind, 'none');
  // storm clears while the episode continues → responds normally
  assert.equal(decideChargeNowResponse(s, inputs({ nowMs: T0 + 120_000 })).kind, 'turnOff');
});

test('episode latch: one response per continuous episode; a NEW episode responds again', () => {
  const s = freshResponderState();
  assert.equal(decideChargeNowResponse(s, inputs({ mode: 'advisory' })).kind, 'advise');
  assert.equal(decideChargeNowResponse(s, inputs({ mode: 'advisory', nowMs: T0 + 60_000 })).kind, 'none');
  // condition clears (force charge off), then a new episode starts
  decideChargeNowResponse(s, inputs({ mode: 'advisory', slots: [{ slot: 1, label: 'Core 3', on: false }], nowMs: T0 + 120_000 }));
  assert.equal(decideChargeNowResponse(s, inputs({ mode: 'advisory', nowMs: T0 + 180_000 })).kind, 'advise');
});

test('daily cap: past CHARGE_NOW_DAILY_CAP supervised responses, it names but does not write', () => {
  const s: ResponderState = { ...freshResponderState(), day: '2026-08-17', actionsToday: CHARGE_NOW_DAILY_CAP };
  const a = decideChargeNowResponse(s, inputs());
  assert.equal(a.kind, 'advise', 'the responder can never fight a determined operator');
  // and the day rolling over resets the budget
  const b = decideChargeNowResponse(
    { ...freshResponderState(), day: '2026-08-17', actionsToday: CHARGE_NOW_DAILY_CAP },
    inputs({ phoenixDay: '2026-08-18' }),
  );
  assert.equal(b.kind, 'turnOff');
});

test('mode off is inert; advisory never writes; unknown force-charge state never acts', () => {
  assert.equal(decideChargeNowResponse(freshResponderState(), inputs({ mode: 'off' })).kind, 'none');
  const s = freshResponderState();
  const a = decideChargeNowResponse(s, inputs({ mode: 'advisory' }));
  assert.equal(a.kind, 'advise');
  assert.equal(s.pendingVerify, null, 'advisory sets no write in flight');
  assert.equal(decideChargeNowResponse(freshResponderState(), inputs({ slots: null })).kind, 'none',
    'no reported state = no basis to act');
});
