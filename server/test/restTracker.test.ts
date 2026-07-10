import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  packCurrentAmps, observePackRest, lastNonRestingAtMs, retainPacks, packRestKey, _resetRestTracker,
} from '../src/physics/restTracker.js';
import { analyzePackLfp } from '../src/physics/lfpOcv.js';

/* ===================================================================
 * v1.2.0 — `/api/physics/lfp-soc` could never produce its headline number.
 *
 * Two independent defects, both confirmed against the LIVE fleet (15 packs):
 *   1. packCurrentA was derived from `pk.totalVoltage` — a field the pack projection
 *      has never had. It was `undefined` on every pack, so packCurrentA was null and
 *      every pack noted "pack current not reported".
 *   2. `lastNonRestingAtMs: null` was hardcoded at the call site, so `idleLongEnough`
 *      was false forever.
 *
 * Result: isResting=false on all 15 packs, physicsSoCPct null on all 15, confidence
 * capped at 0.5. The "physics says X, BMS says Y" comparison never existed.
 * =================================================================== */

const REST_AGE_MS = 10 * 60 * 1000;
const MIN = 60_000;

beforeEach(() => _resetRestTracker());

test('packCurrentAmps uses the fields the projection ACTUALLY has', () => {
  // Live Core 3 pack 1: outputWatts 432, inputWatts 0, packVoltageMv 103342 → 4.18 A.
  const a = packCurrentAmps(432, 0, 103342)!;
  assert.ok(Math.abs(a - 4.18) < 0.01, `expected ~4.18 A, got ${a}`);
  // Charging is negative (input exceeds output).
  assert.ok(packCurrentAmps(0, 500, 103342)! < 0);
  // The old code's field is gone; a missing/zero voltage must not divide by zero.
  assert.equal(packCurrentAmps(432, 0, null), null);
  assert.equal(packCurrentAmps(432, 0, 0), null);
  // No power reading at all is unknowable, not "zero current".
  assert.equal(packCurrentAmps(null, null, 103342), null);
});

test('a pack is NOT claimed rested on first sight — even if it is idle right now', () => {
  const t0 = 1_700_000_000_000;
  const seeded = observePackRest('pack:A', 0.1, t0);
  assert.equal(seeded, t0, 'first observation seeds lastNonRestingAt to now');
  // Rest may have begun hours ago, but we have no evidence. Under-claim.
  assert.equal(analyzePackLfp({
    packVoltageMv: 104_000, reportedSoCPct: 50, cellVoltagesMv: [],
    packCurrentA: 0.1, lastNonRestingAtMs: seeded, nowMs: t0,
  }).isResting, false);
});

test('after 10 observed minutes of idle, the pack IS rested and physics SoC appears', () => {
  const t0 = 1_700_000_000_000;
  observePackRest('pack:A', 0.1, t0);
  for (let m = 1; m <= 11; m++) observePackRest('pack:A', 0.1, t0 + m * MIN);

  const at = t0 + 11 * MIN;
  const analysis = analyzePackLfp({
    packVoltageMv: 104_000, reportedSoCPct: 50, cellVoltagesMv: [],
    packCurrentA: 0.1, lastNonRestingAtMs: lastNonRestingAtMs('pack:A'), nowMs: at,
  });
  assert.equal(analysis.isResting, true);
  assert.ok(analysis.physicsSoCPct != null, 'a rested pack must yield a physics SoC');
  assert.ok(analysis.confidence >= 0.5);
});

test('any current excursion resets the rest clock', () => {
  const t0 = 1_700_000_000_000;
  observePackRest('pack:A', 0.1, t0);
  for (let m = 1; m <= 9; m++) observePackRest('pack:A', 0.1, t0 + m * MIN);
  const kick = observePackRest('pack:A', 4.18, t0 + 9.5 * MIN);  // discharge burst
  assert.equal(kick, t0 + 9.5 * MIN, 'a moving pack re-stamps lastNonRestingAt');

  // 9 min of prior idle no longer counts; we are 1 min past the excursion.
  const at = t0 + 10.5 * MIN;
  assert.ok(at - kick < REST_AGE_MS);
  assert.equal(analyzePackLfp({
    packVoltageMv: 104_000, reportedSoCPct: 50, cellVoltagesMv: [],
    packCurrentA: 0.1, lastNonRestingAtMs: kick, nowMs: at,
  }).isResting, false);
});

test('an UNREADABLE current counts as movement — silence is not evidence of stillness', () => {
  const t0 = 1_700_000_000_000;
  observePackRest('pack:A', 0.1, t0);
  for (let m = 1; m <= 20; m++) observePackRest('pack:A', 0.1, t0 + m * MIN);
  const dropped = observePackRest('pack:A', null, t0 + 21 * MIN);
  assert.equal(dropped, t0 + 21 * MIN, 'null current must re-stamp, not coast on old rest');
});

test('rest history is keyed on the pack HARDWARE serial, so renumbering keeps it', () => {
  assert.equal(packRestKey('DPU1', { packSn: 'Y712ZABA4H350037', num: 1 }), 'pack:Y712ZABA4H350037');
  // Same physical pack moved to slot 3 → same key → 20 min of observed rest survives.
  assert.equal(packRestKey('DPU2', { packSn: 'Y712ZABA4H350037', num: 3 }), 'pack:Y712ZABA4H350037');
  // No BMS serial → fall back to slot identity rather than collide every pack on one key.
  assert.equal(packRestKey('DPU1', { packSn: null, num: 2 }), 'slot:DPU1:2');
  assert.notEqual(packRestKey('DPU1', { num: 2 }), packRestKey('DPU2', { num: 2 }));
});

test('retainPacks evicts departed packs so a removed pack cannot pin memory', () => {
  const t0 = 1_700_000_000_000;
  observePackRest('pack:A', 1, t0);
  observePackRest('pack:B', 1, t0);
  retainPacks(['pack:A']);
  assert.equal(lastNonRestingAtMs('pack:A'), t0);
  assert.equal(lastNonRestingAtMs('pack:B'), null);
});
