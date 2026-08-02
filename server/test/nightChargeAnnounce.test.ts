import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNightChargeMessage } from '../src/notify.js';
import type { NightChargePlan } from '../src/nightChargeAdvisor.js';

/* v1.51.2 — the supervised announcement must never be ambiguous about WHICH
 * night it names. Weekend tariff semantics routinely resolve a Saturday plan's
 * window to Monday 00:00 (write moment ~28 h out); a bare clock time reads as
 * tonight. The deadline text is produced day-qualified by the caller, and the
 * notification must not re-prefix "at". */

function chargePlan(over: Partial<NightChargePlan> = {}): NightChargePlan {
  return {
    generatedAt: Date.now(), basisComplete: true, objective: 'resilience_cushion',
    chargeTonight: true, buyKwh: 36, targetSocPct: 36.2, requiredExtraKwh: 30,
    bindingCap: 'chargePower', cushionShortfall: false, minProjSocPct: 0,
    minProjSocTsMs: null, baselineMinSocPct: 0, projSocAtWindowStartPct: null,
    preWindowMinSocPct: null, confidenceTier: 'forecast',
    window: { startMs: Date.now() + 28 * 3_600_000, endMs: Date.now() + 33 * 3_600_000 },
    reserveFloorPct: 10, cushionPct: 15, rationale: 'x', ...over,
  } as NightChargePlan;
}

test('supervised notification carries the day-qualified deadline verbatim (no doubled "at")', () => {
  const m = buildNightChargeMessage(chargePlan(), 'charge', {
    cancelDeadlineText: 'on Sunday at 11:55 PM', targetPct: 36,
  });
  assert.ok(m.body.includes('SUPERVISED: on Sunday at 11:55 PM the add-on raises'), m.body);
  assert.ok(!m.body.includes('at on Sunday'), 'must not double the preposition');
  assert.ok(m.body.includes('36%'));
});

test('same-night deadline still reads naturally', () => {
  const m = buildNightChargeMessage(chargePlan(), 'charge', {
    cancelDeadlineText: 'at 10:55 PM', targetPct: 40,
  });
  assert.ok(m.body.includes('SUPERVISED: at 10:55 PM the add-on raises'), m.body);
});

test('advisory (no supervised ctx) keeps the automation-wiring tail', () => {
  const m = buildNightChargeMessage(chargePlan(), 'charge', null);
  assert.ok(m.body.includes('Advisory only'));
  assert.ok(!m.body.includes('SUPERVISED'));
});

test('cushionShortfall is disclosed in the notification body', () => {
  const m = buildNightChargeMessage(chargePlan({ cushionShortfall: true }), 'charge', {
    cancelDeadlineText: 'on Sunday at 11:55 PM', targetPct: 36,
  });
  assert.ok(/residual risk/i.test(m.body), m.body);
});
