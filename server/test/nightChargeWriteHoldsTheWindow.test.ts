/**
 * v1.187.0 — the supervised reserve write holds exactly the cheap window.
 *
 * The reserve raise IS a grid charge the moment it exceeds the pool. With the write at
 * window open − 5 min (APPLY_LEAD_MS, v1.50.0) the Cores took ~5.2 kW each from 22:55:42
 * on 2026-09-28 — 1.12 kWh at the 16.91¢ off-peak rate instead of 12.59¢ (09-22: ~0.85
 * kWh) — and the revert at close + 5 min held a still-short pack on the grid into the
 * off-peak morning. Both constants are 0 now: the write lands at the window open and the
 * restore at its close, with every guard, the readback verification, the force-charge
 * order and the owner's cancel window intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  armFromPlan, decideActuation, emptyActuationState,
  APPLY_VERIFY_AFTER_MS, APPLY_LATE_MS,
  type ArmablePlan, type ActuationTickOpts, type NightActuationState,
} from '../src/nightChargeActuator.js';
import { decideForceCharge, type ForceChargeOpts } from '../src/nightForceCharge.js';
import { deliveredHoldSpan } from '../src/nightLedgerScoring.js';
import { resolveCheapWindow } from '../src/nightChargeAdvisor.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const phx = (y: number, mo: number, d: number, h: number) => Date.UTC(y, mo - 1, d, h + 7);
const REV = buildApsREvModel({ confirmed: true, onPeak: { summer: 44.2, winter: 30 }, offPeak: { summer: 16.91, winter: 12 }, overnight: { summer: 12.59, winter: 12.59 } });

/** The live 2026-09-28 night: window Mon 23:00 → Tue 05:00 MST, reserve 16 → 50. */
const WIN = { startMs: 1790661600000, endMs: 1790683200000 };

const plan = (window = WIN): ArmablePlan => ({
  chargeTonight: true, basisComplete: true, buyKwh: 63.82, setpointSocPct: 95, costCeilingSocPct: 76.4, window,
});
const armed = (window = WIN): NightActuationState => {
  const s = armFromPlan(emptyActuationState(), '2026-09-28', plan(window), window.startMs - 90 * MIN, 16);
  assert.ok(s);
  return s!;
};
const opts = (o: Partial<ActuationTickOpts> = {}): ActuationTickOpts => ({
  mode: 'supervised', writeReady: false, currentReservePct: 16, socCoherent: true, vitalsRed: false, gridPresent: true, ...o,
});

test('★★★ THE DEFECT: no write before the window opens — not at 22:55, not a millisecond early', () => {
  const s = armed();
  assert.equal(WIN.startMs, phx(2026, 9, 28, 23));
  assert.equal(decideActuation(s, WIN.startMs - 5 * MIN + 28_000, opts()).kind, 'none', '22:55:28 was the old apply');
  assert.equal(decideActuation(s, WIN.startMs - 1, opts()).kind, 'none');
  assert.deepEqual(decideActuation(s, WIN.startMs, opts()), { kind: 'apply', targetPct: 50 });
  assert.deepEqual(decideActuation(s, WIN.startMs + 28_000, opts()), { kind: 'apply', targetPct: 50 }, 'the first tick after the open');
  assert.equal(decideActuation(s, WIN.startMs + APPLY_LATE_MS + 1, opts()).kind, 'none', 'the late bound is unchanged');
});

test('★★ every minute the apply can fire, across two weeks of resolved windows, is the overnight rate', () => {
  for (let d = 0; d < 14; d++) {
    const w = resolveCheapWindow((t) => rateAt(REV, t).periodId, phx(2026, 9, 14, 21) + d * 24 * HOUR, 'overnight', 30);
    if (!w) continue; // Saturday evening: the Monday window is > 30 h out
    const s = armed(w);
    for (let t = w.startMs - 15 * MIN; t <= w.startMs + APPLY_LATE_MS; t += MIN) {
      if (decideActuation(s, t, opts()).kind === 'apply') {
        assert.equal(rateAt(REV, t).periodId, 'overnight', `apply at ${new Date(t).toISOString()} is outside the overnight rate`);
      }
    }
  }
});

test('★★★ the restore lands at the window close, not five minutes into the off-peak morning', () => {
  const applied: NightActuationState = {
    ...armed(), appliedAtMs: WIN.startMs + 28_000, applyVerifiedAtMs: WIN.startMs + 88_000, priorReservePct: 16,
  };
  const live = opts({ currentReservePct: 50 });
  assert.equal(decideActuation(applied, WIN.endMs - 1, live).kind, 'none', 'the whole window is held');
  assert.deepEqual(decideActuation(applied, WIN.endMs, live), { kind: 'revert', restorePct: 16 });
  // Grid loss and the owner's cancel still revert at once, mid-window.
  assert.equal(decideActuation(applied, WIN.startMs + 2 * HOUR, opts({ currentReservePct: 50, gridPresent: false })).kind, 'revert');
  assert.equal(decideActuation({ ...applied, cancelled: true }, WIN.startMs + 2 * HOUR, live).kind, 'revert');
});

test('★★ the readback verification is measured from the write, so it is untouched', () => {
  const applied: NightActuationState = { ...armed(), appliedAtMs: WIN.startMs, priorReservePct: 16 };
  assert.equal(decideActuation(applied, WIN.startMs + MIN, opts({ currentReservePct: 50 })).kind, 'applyVerified');
  assert.equal(decideActuation(applied, WIN.startMs + APPLY_VERIFY_AFTER_MS - 1, opts({ currentReservePct: 16 })).kind, 'none');
  assert.equal(decideActuation(applied, WIN.startMs + APPLY_VERIFY_AFTER_MS, opts({ currentReservePct: 16 })).kind, 'retryApply');
});

test('★★ force-charge keeps its order: nothing before the open, and nothing before the verified reserve', () => {
  const fcOpts: ForceChargeOpts = {
    enabled: true, gridPresent: true, gridStaLost: false, ceilingReadbackPct: 100, slotsOn: [],
    connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true, poolSocPct: 25, fullKwh: 92,
  };
  const applied: NightActuationState = { ...armed(), appliedAtMs: WIN.startMs + 28_000, priorReservePct: 16 };
  assert.equal(decideForceCharge(applied, WIN.startMs + MIN, fcOpts).kind, 'none', 'the reserve is not verified yet');
  const verified: NightActuationState = { ...applied, applyVerifiedAtMs: WIN.startMs + 88_000 };
  // One tick after the verify, the ceiling sync — the first force-charge step — proceeds.
  assert.deepEqual(decideForceCharge(verified, WIN.startMs + 88_000, fcOpts), { kind: 'syncCeiling', pct: 80, prior: 100 });
});

/* ══ integration pins ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');

test('the announced cancel deadline and the status route name the write moment (now the window open)', () => {
  assert.ok(INDEX.includes('cancelDeadlineText: fmtDeadlineSpoken(armedCandidate.windowStartMs! - APPLY_LEAD_MS, nowMs),'));
  assert.ok(INDEX.includes('nightActuationMem.windowStartMs != null ? nightActuationMem.windowStartMs - APPLY_LEAD_MS : null,'));
});

test('★ the delivered-energy span keeps the pre-v1.187.0 tail only for an unstamped night applied before its window', () => {
  // v1.187.0 (review) — behaviour, through deliveredHoldSpan (was a source pin).
  const legacy = deliveredHoldSpan({ windowStartMs: WIN.startMs, windowEndMs: WIN.endMs, appliedAtMs: WIN.startMs - 5 * MIN + 28_000, revertedAtMs: null });
  assert.deepEqual(legacy, { startMs: WIN.startMs - 5 * MIN + 28_000, endMs: WIN.endMs + 5 * MIN, basis: 'legacy-schedule' });
  const current = deliveredHoldSpan({ windowStartMs: WIN.startMs, windowEndMs: WIN.endMs, appliedAtMs: WIN.startMs + 28_000, revertedAtMs: null });
  assert.equal(current.basis, 'close-plus-tick');
  assert.equal(current.startMs, WIN.startMs);
  // The night straddling the upgrade: applied at 22:55 by the old binary, restored at the
  // close by the new one, which stamps it — the stamp wins over the legacy tail.
  const straddle = deliveredHoldSpan({ windowStartMs: WIN.startMs, windowEndMs: WIN.endMs, appliedAtMs: WIN.startMs - 5 * MIN, revertedAtMs: WIN.endMs + 28_000 });
  assert.deepEqual(straddle, { startMs: WIN.startMs - 5 * MIN, endMs: WIN.endMs + 88_000, basis: 'revert-stamp' });
});
