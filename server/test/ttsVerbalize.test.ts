import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verbalizeForTts } from '../src/ttsService.js';

/**
 * v0.57.0 — TTS verbalizer. The spoken-alert path was reading units, symbols and
 * abbreviations verbatim ("6 h" instead of "6 hours", "%", "≥", "→" literally).
 * verbalizeForTts is the single, idempotent normalizer applied at the renderer
 * chokepoint (and inside buildAlertMessage). These tests pin the user-reported
 * gaps + the safety guards (number-anchoring, idempotency).
 */

/* ─── the headline complaint: bare units ─────────────────────────── */

test('verbalize — time units: "6 h" / "6h" / "6hr" → "6 hours"', () => {
  assert.equal(verbalizeForTts('reserve in 6 h'), 'reserve in 6 hours');
  assert.equal(verbalizeForTts('empty in 6h'), 'empty in 6 hours');
  assert.equal(verbalizeForTts('about 6hr'), 'about 6 hours');
  assert.equal(verbalizeForTts('about 6 hrs'), 'about 6 hours');
});

test('verbalize — duration combo "3h 7m" → "3 hours 7 minutes"', () => {
  assert.equal(verbalizeForTts('runtime 3h 7m to reserve'), 'runtime 3 hours 7 minutes to reserve');
});

test('verbalize — "1 hour" is singularized, not "1 hours"', () => {
  assert.equal(verbalizeForTts('reserve in 1 h'), 'reserve in 1 hour');
  assert.equal(verbalizeForTts('full in 1 day'), 'full in 1 day');
});

test('verbalize — power / energy / electrical units', () => {
  assert.equal(verbalizeForTts('producing 450 W'), 'producing 450 watts');
  assert.equal(verbalizeForTts('6.4kW load'), '6.4 kilowatts load');
  assert.equal(verbalizeForTts('7.5 kWh'), '7.5 kilowatt hours');
  assert.equal(verbalizeForTts('40.2 V'), '40.2 volts');
  assert.equal(verbalizeForTts('5.1 A breaker'), '5.1 amps breaker');
  assert.equal(verbalizeForTts('spread 35 mV'), 'spread 35 millivolts');
});

test('verbalize — longest-unit-wins: kWh not "k W h", kW not "k watts"', () => {
  assert.equal(verbalizeForTts('12 kWh'), '12 kilowatt hours');
  assert.equal(verbalizeForTts('12 kW'), '12 kilowatts');
  assert.equal(verbalizeForTts('12 Wh'), '12 watt hours');
});

/* ─── rate slashes ──────────────────────────────────────────────── */

test('verbalize — rate slashes → "per <unit>"', () => {
  assert.equal(verbalizeForTts('draining 1.2%/h'), 'draining 1.2 percent per hour');
  assert.equal(verbalizeForTts('typical 18.3 kWh/day'), 'typical 18.3 kilowatt hours per day');
  assert.equal(verbalizeForTts('rising 4.1 mV/week'), 'rising 4.1 millivolts per week');
  assert.equal(verbalizeForTts('declining 3%/month'), 'declining 3 percent per month');
});

/* ─── special characters / math symbols ─────────────────────────── */

test('verbalize — relational + math symbols', () => {
  assert.equal(verbalizeForTts('critical < 70%'), 'critical below 70 percent');
  assert.equal(verbalizeForTts('warning > 80%'), 'warning above 80 percent');
  assert.equal(verbalizeForTts('spread ≥ 5%'), 'spread at or above 5 percent');
  assert.equal(verbalizeForTts('floor ≤ 10%'), 'floor at or below 10 percent');
  assert.equal(verbalizeForTts('declining ~3%'), 'declining about 3 percent');
  assert.equal(verbalizeForTts('runtime ≈ 4 hours'), 'runtime about 4 hours');
  assert.equal(verbalizeForTts('R² 0.94'), 'R squared 0.94');
});

test('verbalize — ASCII >= / <= do not leave a dangling "="', () => {
  assert.equal(verbalizeForTts('voltage >= 450 V'), 'voltage at or above 450 volts');
  assert.equal(verbalizeForTts('floor <= 10%'), 'floor at or below 10 percent');
});

test('verbalize — separators (em-dash, middot) become a pause, arrow becomes "to"', () => {
  assert.equal(verbalizeForTts('near freezing — derates'), 'near freezing, derates');
  assert.equal(verbalizeForTts('Core 3 · Pack 2'), 'Core 3, Pack 2');
  assert.equal(verbalizeForTts('warning→critical'), 'warning to critical');
});

test('verbalize — "month(s)" and parentheticals read cleanly', () => {
  assert.equal(verbalizeForTts('in about 4 month(s)'), 'in about 4 months');
  // parentheses dropped, inner clause survives, no orphaned glyphs
  assert.equal(verbalizeForTts('error 17 (450 V, 5 A)'), 'error 17 450 volts, 5 amps');
});

/* ─── domain abbreviations ──────────────────────────────────────── */

test('verbalize — abbreviations: expand unknowns, keep established initialisms', () => {
  assert.equal(verbalizeForTts('SoC spread'), 'state of charge spread');
  assert.equal(verbalizeForTts('SoH declining'), 'state of health declining');
  assert.equal(verbalizeForTts('EVSE charging'), 'charger charging');
  assert.equal(verbalizeForTts('RTE clamp'), 'round trip efficiency clamp');
  assert.equal(verbalizeForTts('TOU window'), 'time of use window');
  assert.equal(verbalizeForTts('PV production'), 'solar production');
  assert.equal(verbalizeForTts('HV MPPT error'), 'high voltage M P P T error');
});

/* ─── safety: number-anchoring must NOT corrupt prose / identifiers ─ */

test('verbalize — bare unit letters in prose are NOT expanded', () => {
  // "A" as an article, "V"/"W"/"h" with no preceding number must survive
  assert.equal(verbalizeForTts('A breaker tripped'), 'A breaker tripped');
  assert.equal(verbalizeForTts('the home office HVAC'), 'the home office HVAC');
  assert.equal(verbalizeForTts('3 home runs'), '3 home runs'); // "3 h..." must not eat "home"
});

test('verbalize — device serials and error codes are untouched', () => {
  assert.equal(verbalizeForTts('Core GBC0314 fault'), 'Core GBC0314 fault');
  assert.equal(verbalizeForTts('spare ZABA9H3T0489'), 'spare ZABA9H3T0489');
});

/* ─── idempotency: the renderer applies this a second time ───────── */

test('verbalize — idempotent (double application is a no-op)', () => {
  const samples = [
    'Core 3 Pack 2 SoH 68.2% (critical < 70%).',
    'Backup pool projected empty in about 6 h, draining 1.2%/h.',
    'producing 450 W (40 V, 5.1 A) — HV MPPT error code 17.',
    'declining ~3%/month, R² 0.94, in about 4 month(s).',
    'runtime ≈ 3h 7m to reserve ≥ 15%.',
  ];
  for (const s of samples) {
    const once = verbalizeForTts(s);
    assert.equal(verbalizeForTts(once), once, `not idempotent for: ${s}`);
  }
});

test('verbalize — full SoC alarm + runway alarm strings read naturally', () => {
  // the hand-built strings that previously bypassed normalization
  assert.equal(verbalizeForTts('Backup pool at 30 percent.'), 'Backup pool at 30 percent.');
  assert.equal(
    verbalizeForTts('Backup pool projected empty in about 6h. Grid is present.'),
    'Backup pool projected empty in about 6 hours. Grid is present.',
  );
});
