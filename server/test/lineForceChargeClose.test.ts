import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, forceChargeRateKw, type ForceChargeOpts } from '../src/nightForceCharge.js';
import { emptyActuationState, type NightActuationState } from '../src/nightChargeActuator.js';

/**
 * v1.200.0 — THE CLOSE GUARANTEE OF THE LINE FORCE-CHARGE (plan §5.4 T7).
 *
 * A charge night whose outage line L is above the panel's 50% reserve is carried by the night
 * force-charge in LINE mode: the reserve leg takes the pool to 50% and holds the house on the grid; the
 * force-charge starts timed to reach ⌈L⌉ + 5 twenty minutes before the window close, has no software
 * stop, and stays ON to the close; the panel ceiling is at least ⌈L⌉ + 10. While Charge Now is ON under
 * the ceiling the house (and an EV) ride the grid, so a load that starts late cannot draw the pool down.
 *
 * The plant (the integrator's rtcSim, run minute by minute around the REAL decideForceCharge):
 *  - 92.16 kWh nameplate × 0.944 measured: the pool percent is a share of 86.999 kWh; the tick times its
 *    start on the panel's nameplate backupFullCapWh (92.16), as index.ts passes it;
 *  - ON and under the panel ceiling: the pack gains (17 − house − EV) × 0.927 × k per hour (the grid
 *    cap less the load, through the charge leg; k the share of that rate the pack actually takes);
 *  - at the ceiling, or OFF: the house draws the pack (load ÷ 0.94 + the Cores' standby), held at the
 *    50% reserve (the 2026-09-18 measurement: at its ceiling the panel stops importing);
 *  - the panel's ceiling reads back the minute after a sync; an ON takes effect after `onDelayMin`;
 *    readings are whole percents (rounded, or floored), `staleMin` old;
 *  - the close is the median of the last 15 minutes' readings (the scorer's window_close_soc_pct), and a
 *    night is UNDER when it closes below L − 0.05 (REALIZED_CLOSE_TOLERANCE_PCT).
 *
 * Year-shaped lines (the legacyIdentity year's qualifying lines, 50.45-65.95), houses 0.6-3.6 kW, rate
 * factors 0.9-1.25: 0 nights under in every cell. Known failures are pinned for asks of 70-90 (the
 * window cannot deliver a 20-40 point lift to a slow pack). Two discriminators show the grid can see the
 * mutants it is meant to kill: a software stop at ⌈L⌉ (design A's hold, F-i) and a start timed to ⌈L⌉
 * without the + 5 (F-iii).
 */

const MIN = 60_000;
const H = 3_600_000;
const NAME = 92.16;
const CAP = NAME * 0.944;
const LEG = 0.927;
const DIS = 0.94;
const W0 = Date.UTC(2027, 0, 5, 6);
const W1 = W0 + 6 * H;

type Variant = 'real' | 'hold' | 'askStart';
interface Knobs {
  p0: number; evFromMin: number | null; evKw: number; standbyKw: number; onDelayMin: number; staleMin: number; floor: boolean;
}
const BASE: Knobs = { p0: 50, evFromMin: null, evKw: 7, standbyKw: 0, onDelayMin: 0, staleMin: 0, floor: false };

type LineState = NightActuationState & {
  forceChargeLineAskPct: number | null; forceChargeLinePct: number | null; forceChargeCeilingSyncedPct: number | null;
  forceChargeMode: 'cost' | 'line' | null;
};

function night(L: number, houseKw: number, k: number, kn: Knobs, variant: Variant): { close: number; onMin: number } {
  const ask = Math.ceil(L - 1e-9);
  let s: LineState = {
    ...emptyActuationState(),
    day: '2027-01-04', targetPct: 50, buyKwh: 20, windowStartMs: W0, windowEndMs: W1,
    applyAttemptedAtMs: W0 - 5 * MIN, attemptBaselinePct: 30, appliedAtMs: W0 - 5 * MIN, priorReservePct: 30,
    applyVerifiedAtMs: W0 - MIN, forceChargeCeilingPct: null, forceChargeRides: true,
    forceChargeLineAskPct: ask, forceChargeLinePct: L, forceChargeCeilingSyncedPct: null, forceChargeMode: null,
  } as LineState;
  let pack = (kn.p0 / 100) * CAP;
  let panelCeiling = 100;
  let pendingCeiling: number | null = null;
  let onEffectiveMs: number | null = null;
  let chargeNowOn = false;
  let onMin = 0;
  const readings: number[] = [];
  const tail: number[] = [];
  for (let t = W0; t < W1; t += MIN) {
    if (pendingCeiling != null) { panelCeiling = pendingCeiling; pendingCeiling = null; }
    const raw = (pack / CAP) * 100;
    const now = kn.floor ? Math.floor(raw) : Math.round(raw);
    readings.push(now);
    const seen = readings[Math.max(0, readings.length - 1 - kn.staleMin)];
    if (t >= W1 - 15 * MIN) tail.push(now);
    const ev = kn.evFromMin != null && t >= W1 - kn.evFromMin * MIN ? kn.evKw : 0;
    const load = houseKw + ev;
    const chargeRateKw = forceChargeRateKw({ gridCapKw: 17, houseLoadKw: load, legEff: LEG, slotCount: 3 });
    if (onEffectiveMs != null && t >= onEffectiveMs) chargeNowOn = true;
    const o = {
      enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false,
      slotsOn: chargeNowOn ? [1, 2, 3] : [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
      ceilingReadbackPct: panelCeiling, poolSocPct: seen, fullKwh: NAME, chargeRateKw, evDisplacedKwh: null,
    } as ForceChargeOpts;
    const a = decideForceCharge(s, t, o);
    if (a.kind === 'syncCeiling') {
      s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? a.prior, forceChargeCeilingSyncedPct: a.pct };
      pendingCeiling = a.pct;
    } else if (a.kind === 'on') {
      // F-iii's emulation: the ON honoured only once a start timed to ⌈L⌉ alone (no + 5) is due.
      if (variant !== 'askStart' || t >= nfc.forceChargeLineStartAtMs(W1, ask, seen, NAME, chargeRateKw, null, 3)) {
        s = { ...s, forceChargeOnAtMs: t, forceChargeSlots: a.slots, forceChargeOnLastAttemptMs: t, forceChargeMode: 'line' };
        onEffectiveMs = t + kn.onDelayMin * MIN;
      }
    } else if (a.kind === 'onVerified') {
      s = { ...s, forceChargeOnVerifiedAtMs: t };
    } else if (a.kind === 'off') {
      s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: a.reason };
      chargeNowOn = false; onEffectiveMs = null;
    }
    // F-i's emulation: a software stop at ⌈L⌉ (design A's hold without its drain allowance).
    if (variant === 'hold' && chargeNowOn && seen >= ask) { chargeNowOn = false; onEffectiveMs = null; s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: 'target' }; }
    if (chargeNowOn && pack < (panelCeiling / 100) * CAP) {
      pack = Math.min((panelCeiling / 100) * CAP, pack + Math.max(1, (17 - load) * LEG) * k * (MIN / H));
      onMin += 1;
    } else {
      if (chargeNowOn) onMin += 1;
      if (pack > 0.5 * CAP) pack = Math.max(0.5 * CAP, pack - (load / DIS + kn.standbyKw) * (MIN / H));
    }
  }
  tail.sort((x, y) => x - y);
  const m = Math.floor(tail.length / 2);
  return { close: tail.length % 2 ? tail[m] : (tail[m - 1] + tail[m]) / 2, onMin };
}

const YEAR_LINES = [50.45, 50.61, 51.15, 51.43, 52.62, 54.33, 55.55, 57.52, 59.1, 65.95];
const HIGH_LINES = [69.5, 72.2, 74.6, 77.1, 80.3, 84.9, 89.6];
const HOUSES = [0.6, 1.2, 2.0, 2.8, 3.6];
const KS = [0.9, 1.0, 1.1, 1.25];

function cell(lines: number[], kn: Partial<Knobs>, ks: number[] = KS, variant: Variant = 'real'): { under: number; n: number; worst: number; meanOn: number } {
  const k2 = { ...BASE, ...kn };
  let under = 0, n = 0, worst = Infinity, on = 0;
  for (const L of lines) for (const h of HOUSES) for (const k of ks) {
    const r = night(L, h, k, k2, variant);
    n += 1; on += r.onMin; worst = Math.min(worst, r.close - L);
    if (r.close < L - 0.05) under += 1;
  }
  return { under, n, worst, meanOn: on / n };
}

const STRESSES: Array<[string, Partial<Knobs>]> = [
  ['baseline (pool 50 at the open)', {}],
  ['0.27 kW standby', { standbyKw: 0.27 }],
  ['ON 5 min late', { onDelayMin: 5 }],
  ['reading 3 min stale', { staleMin: 3 }],
  ['EV 7 kW from 15 min before the close', { evFromMin: 15 }],
  ['EV 7 kW from 25 min before the close', { evFromMin: 25 }],
  ['EV 7 kW from 30 min before the close', { evFromMin: 30 }],
  ['EV 7 kW from 60 min before the close', { evFromMin: 60 }],
  ['EV 7 kW from 90 min before the close', { evFromMin: 90 }],
  ['pool 60 at the open', { p0: 60 }],
  ['pool 77 at the open', { p0: 77 }],
  ['pool 77 at the open + EV from 30 min', { p0: 77, evFromMin: 30 }],
  ['all: standby, ON 5 min late, 3 min stale', { standbyKw: 0.27, onDelayMin: 5, staleMin: 3 }],
];

test('★★★ T7 the year-shaped lines close at or above the line in EVERY cell: 0 under, rounded and floored readings', () => {
  const out: string[] = [];
  for (const floor of [false, true]) {
    for (const [name, kn] of STRESSES) {
      const r = cell(YEAR_LINES, { ...kn, floor });
      out.push(`${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
      assert.equal(r.under, 0, `${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n} under, worst close − L ${r.worst.toFixed(2)}`);
    }
    for (const k of [0.7, 0.6]) {
      const r = cell(YEAR_LINES, { floor }, [k]);
      assert.equal(r.under, 0, `the pack takes ${k} of the rate${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
    }
  }
  assert.ok(out.length === 26);
});

test('★★★ T7 the line force-charge actually runs: ON to the close on a 50% pool, no OFF before it', () => {
  const r = night(55.55, 2.0, 1.0, BASE, 'real');
  assert.ok(r.onMin >= 35, `ON ${r.onMin} min`);
  assert.ok(r.close >= 56, `close ${r.close}`);
  // A pool already above the start target still gets the final segment ON (under the panel ceiling).
  assert.ok(night(55.55, 2.0, 1.0, { ...BASE, p0: 77 }, 'real').onMin >= 30);
});

test('★★★ T7 known failures at asks of 70-90 (the window cannot deliver to a slow pack), pinned so a regression is seen', () => {
  for (const floor of [false, true]) {
    const pin = floor ? PIN_HIGH.floor : PIN_HIGH.round;
    for (const [name, kn] of STRESSES) {
      const r = cell(HIGH_LINES, { ...kn, floor });
      const known = name.startsWith('EV 7 kW from 90') ? pin.ev90 : 0;
      assert.equal(r.under, known, `${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
    }
    assert.equal(cell(HIGH_LINES, { floor }, [0.7]).under, pin.rate07, `rate 0.7${floor ? ' (floor)' : ''}`);
    assert.equal(cell(HIGH_LINES, { floor }, [0.6]).under, pin.rate06, `rate 0.6${floor ? ' (floor)' : ''}`);
  }
  // The mean ON time on these lines (the exposure the CHANGELOG states): ~169 min, against ~75 on the year's.
  assert.equal(Math.round(cell(HIGH_LINES, {}).meanOn), 169);
  assert.equal(Math.round(cell(YEAR_LINES, {}).meanOn), 75);
});

test('★★ T7 the discriminators: a software stop at ⌈L⌉, and a start timed to ⌈L⌉ alone, close under the line on this grid', () => {
  // F-i (design A's hold, with no drain allowance): an EV 30 min before the close takes the pool back down.
  const hold = cell(YEAR_LINES, { evFromMin: 30 }, KS, 'hold');
  assert.ok(hold.under >= 150, `hold, EV 30 min out: ${hold.under}/${hold.n}`);
  // F-iii (no + 5): an EV 60 or 90 min out, or a slow pack, arrives short.
  const ask90 = cell(YEAR_LINES, { evFromMin: 90 }, KS, 'askStart');
  const ask60 = cell(YEAR_LINES, { evFromMin: 60 }, KS, 'askStart');
  const ask06 = cell(YEAR_LINES, {}, [0.6], 'askStart');
  // Measured: 17/200, 5/200 and 5/50 (the integrator's emulation: the same); the hold 200/200.
  assert.ok(ask90.under >= 15 && ask60.under >= 5, `start to ⌈L⌉: EV 90 ${ask90.under}, EV 60 ${ask60.under}`);
  assert.ok(ask06.under >= 5, `start to ⌈L⌉, rate 0.6: ${ask06.under}/${ask06.n}`);
});

/** Measured when the change was made (v1.200.0) on the real decideForceCharge. Rounded readings match the
 *  integrator's emulation (rtcSim4-highasks.out: 1/140, 8/35, 30/35); floored readings cost a point at the
 *  close. Out of 140 nights (7 lines × 5 houses × 4 rate factors), or 35 at a single rate factor. */
const PIN_HIGH = { round: { ev90: 1, rate07: 8, rate06: 30 }, floor: { ev90: 10, rate07: 11, rate06: 33 } };
