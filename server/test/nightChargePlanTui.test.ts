import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightChargePlanIfFresh } from '../src/telnet/dataProvider.js';
import type { NightChargePlan } from '../src/nightChargeAdvisor.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargePlanIfFresh — the PURE fail-safe staleness gate the TUI's
 * TONIGHT'S PLAN block and the web card share (design §4.3 / I12). It decides
 * "render the live plan" vs "render the grey unavailable line". The safety
 * requirement is one-directional: it must NEVER surface a stale / incomplete /
 * absent plan as if it were tonight's live recommendation.
 *
 * The 12 h horizon MUST match nightChargeStateFields' guard (43_200_000 ms) so
 * the terminal, the web card, and the HA entities never disagree about whether
 * a plan is still live.
 * ═════════════════════════════════════════════════════════════════════════ */

const NOW = 1_800_000 * 3_600_000; // arbitrary fixed epoch
const TWELVE_H = 12 * 60 * 60 * 1000;

function mkPlan(overrides: Partial<NightChargePlan> = {}): NightChargePlan {
  return {
    generatedAt: NOW,
    basisComplete: true,
    objective: 'resilience_cushion',
    chargeTonight: true,
    buyKwh: 3.2,
    targetSocPct: 85,
    requiredExtraKwh: 3,
    bindingCap: 'requirement',
    cushionShortfall: false,
    minProjSocPct: 25,
    minProjSocTsMs: NOW + 6 * 3_600_000,
    baselineMinSocPct: 12,
    confidenceTier: 'forecast',
    window: { startMs: NOW + 3_600_000, endMs: NOW + 7 * 3_600_000 },
    reserveFloorPct: 10,
    cushionPct: 15,
    rationale: 'test',
    ...overrides,
  };
}

test('null / undefined holder → null (grey unavailable line)', () => {
  assert.equal(nightChargePlanIfFresh(null, NOW), null);
  assert.equal(nightChargePlanIfFresh(undefined, NOW), null);
});

test('a fresh, complete plan is returned unchanged', () => {
  const p = mkPlan({ generatedAt: NOW - 60_000 });
  assert.equal(nightChargePlanIfFresh(p, NOW), p);
});

test('incomplete basis → null even when just generated', () => {
  const p = mkPlan({ generatedAt: NOW, basisComplete: false });
  assert.equal(nightChargePlanIfFresh(p, NOW), null);
});

test('a HOLD plan (chargeTonight=false) is still returned when fresh+complete', () => {
  // The gate is about freshness, not the recommendation — HOLD must reach the
  // surface so the TUI/web can render the honest "no charge needed" line.
  const hold = mkPlan({ chargeTonight: false, buyKwh: 0, generatedAt: NOW });
  assert.equal(nightChargePlanIfFresh(hold, NOW), hold);
});

test('exactly at the 12 h horizon → stale → null (fail-safe boundary)', () => {
  const p = mkPlan({ generatedAt: NOW - TWELVE_H });
  assert.equal(nightChargePlanIfFresh(p, NOW), null);
});

test('just inside the 12 h horizon → still live', () => {
  const p = mkPlan({ generatedAt: NOW - (TWELVE_H - 1) });
  assert.equal(nightChargePlanIfFresh(p, NOW), p);
});

test('well past 12 h (dead/wedged advisor) → null, never a stale retained plan', () => {
  const p = mkPlan({ generatedAt: NOW - 25 * 60 * 60 * 1000 });
  assert.equal(nightChargePlanIfFresh(p, NOW), null);
});

test('non-finite generatedAt → null (never trust a malformed timestamp)', () => {
  assert.equal(nightChargePlanIfFresh(mkPlan({ generatedAt: NaN }), NOW), null);
  assert.equal(nightChargePlanIfFresh(mkPlan({ generatedAt: Infinity }), NOW), null);
});
