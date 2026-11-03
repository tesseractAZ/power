import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, forceChargeRateKw, evDisplacedPackKwh, type ForceChargeOpts } from '../src/nightForceCharge.js';
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
 *  - AT THE CEILING THE PANEL SWITCHES THE SLOTS' CHARGE NOW OFF AND LEAVES THEM OFF (read with the
 *    panel-side classifier on 2026-09-23 — ch1 off at 04:19, ch3 at 04:30 — and 2026-10-02, slots 2 and 1 at
 *    04:24-04:25; 2026-09-18's 90 → 86% after the ceiling is consistent with it, but that night's slot state is
 *    the add-on's record, not a readback). The plant once resumed importing below the ceiling, which no Core
 *    does. Then, or OFF, the house draws the pack (load ÷ 0.94 + the Cores' standby), held at the 50% reserve; the slots read OFF
 *    until an ON of ours (the tick's 'on', 'onRetry' or 'lineReOn') takes effect;
 *  - the tick's evDisplacedKwh is the plan's predicted (P90) window EV, constant through the night, through
 *    evDisplacedPackKwh, exactly as index.ts passes it — so a predicted EV pulls the start early;
 *  - the panel's ceiling reads back the minute after a sync; an ON takes effect after `onDelayMin`;
 *    readings are whole percents (rounded, or floored), `staleMin` old; each slot's Core reads the pool;
 *  - the close is the median of the last 15 minutes' readings (the scorer's window_close_soc_pct), and a
 *    night is UNDER when it closes below L − 0.05 (REALIZED_CLOSE_TOLERANCE_PCT).
 *
 * Year-shaped lines (the legacyIdentity year's qualifying lines, 50.45-65.95), houses 0.6-3.6 kW, rate
 * factors 0.9-1.25: 0 nights under in every STRESS cell and every PREDICTED-EV cell (the MEASURED, OFF-reading
 * latch, then the tick's line re-ON, lineReOnDue). What the line force-charge cannot carry is pinned exactly, not claimed:
 *  - asks of 70-90 with a slow pack (the window cannot deliver a 20-40 point lift);
 *  - a late UNPREDICTED load that takes the grid cap after the start (an 11.52 kW EV — EV_MAX_LOAD_W, the
 *    site's 48 A × 240 V default — or a 7 kW one two hours out), alone or with another stress: the start
 *    was timed on a rate the pack then does not get;
 *  - a COST-DOMINANT night (the cost stop already at ⌈L⌉ + 10 or above: today's cost force-charge exactly,
 *    with its software stop) whose late EV draws the pool back under the line after that stop.
 * (review 2) THE ON-READING LATCH — a slot that keeps reading ON at its ceiling and stops importing — is UNMEASURED on
 * this plant (variant 'onLatch'): nothing of ours switches it back on, so predicted-EV nights close under the line there
 * (pinned exactly, PIN_ON_LATCH); the line-at-risk push (lineAtRiskPushDue) reaches every one of them at least 20 min
 * before the close. The plant stamps the night's observations and asks for the push on each tick, as index.ts does.
 * Three discriminators show the grid can see the mutants it is meant to kill: a software stop at ⌈L⌉ (design
 * A's hold, F-i), a start timed to ⌈L⌉ without the + 5 (F-iii), and no re-ON after the latch.
 */

const MIN = 60_000;
const H = 3_600_000;
const NAME = 92.16;
const CAP = NAME * 0.944;
const LEG = 0.927;
const DIS = 0.94;
const W0 = Date.UTC(2027, 0, 5, 6);
const W1 = W0 + 6 * H;
/** EV_MAX_LOAD_W at its default (config.ts; analytics.ts "48 A × 240 V"), kW. */
const EV_MAX_KW = 11.52;

/** 'onLatch' (review 2) — the ON-READING latch, UNMEASURED on this plant: at the ceiling a slot stops importing but
 *  keeps reading Charge Now ON, and imports again only once an ON of ours takes effect (none comes: the re-ON keys
 *  on slots reading OFF). */
type Variant = 'real' | 'hold' | 'askStart' | 'noReOn' | 'onLatch';
interface Knobs {
  p0: number; evFromMin: number | null; evKw: number; standbyKw: number; onDelayMin: number; staleMin: number; floor: boolean;
  /** The plan's predicted window EV (kWh) the tick passes as evDisplacedKwh; 'exact' = the EV that comes. */
  predEvKwh: number | 'exact' | null;
  /** The record's cost ceiling, with the cost gate on (null: the cost gate off, a resilience-objective night). */
  costPct: number | ((ask: number) => number) | null;
}
const BASE: Knobs = { p0: 50, evFromMin: null, evKw: 7, standbyKw: 0, onDelayMin: 0, staleMin: 0, floor: false, predEvKwh: null, costPct: null };

type LineState = NightActuationState & {
  forceChargeLineAskPct: number | null; forceChargeLinePct: number | null; forceChargeCeilingSyncedPct: number | null;
  forceChargeMode: 'cost' | 'line' | null;
};

function night(L: number, houseKw: number, k: number, kn: Knobs, variant: Variant): { close: number; onMin: number; reOns: number; pushedAtMs: number | null } {
  const ask = Math.ceil(L - 1e-9);
  const cost = typeof kn.costPct === 'function' ? Math.min(100, kn.costPct(ask)) : kn.costPct;
  let s: LineState = {
    ...emptyActuationState(),
    day: '2027-01-04', targetPct: 50, buyKwh: 20, windowStartMs: W0, windowEndMs: W1,
    applyAttemptedAtMs: W0 - 5 * MIN, attemptBaselinePct: 30, appliedAtMs: W0 - 5 * MIN, priorReservePct: 30,
    applyVerifiedAtMs: W0 - MIN, forceChargeCeilingPct: cost, forceChargeRides: true,
    forceChargeLineAskPct: ask, forceChargeLinePct: L, forceChargeCeilingSyncedPct: null, forceChargeMode: null,
  } as LineState;
  const gates = { cost: cost != null, line: true };
  let pack = (kn.p0 / 100) * CAP;
  let panelCeiling = 100;
  let pendingCeiling: number | null = null;
  let onEffectiveMs: number | null = null;
  let chargeNowOn = false;
  let importing = true;
  let pushedAtMs: number | null = null;
  let onMin = 0;
  let reOns = 0;
  const readings: number[] = [];
  const tail: number[] = [];
  const evKwh = kn.evFromMin != null ? kn.evKw * Math.min(kn.evFromMin, (W1 - W0) / MIN) / 60 : 0;
  const pred = kn.predEvKwh === 'exact' ? evKwh : kn.predEvKwh;
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
    // index.ts: the plan's P90 window EV, through evDisplacedPackKwh, on every tick of this window.
    const evDisplacedKwh = pred != null && pred > 0
      ? evDisplacedPackKwh({ evKwh: pred, peakEvKw: kn.evKw, rateKw: chargeRateKw, unboundedRateKw: Math.max(1, (17 - load) * LEG), legEff: LEG })
      : null;
    if (onEffectiveMs != null && t >= onEffectiveMs) { chargeNowOn = true; importing = true; onEffectiveMs = null; }
    const o = {
      enabled: gates.cost, lineEnabled: gates.line, gridPresent: true, gridStaLost: false,
      slotsOn: chargeNowOn ? [1, 2, 3] : [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
      slotSocPct: { 1: seen, 2: seen, 3: seen },
      ceilingReadbackPct: panelCeiling, poolSocPct: seen, fullKwh: NAME, chargeRateKw, evDisplacedKwh,
    } as ForceChargeOpts;
    // (review 2) index.ts: the night's observations (the pool trail, the panel's own stop) on the record before
    // the decision; and on a tick that decides nothing, the line-at-risk push (once a night).
    const obs = nfc.lineNightObservations(s, t, o);
    if (obs != null) s = { ...s, ...obs };
    const a = decideForceCharge(s, t, o);
    if (a.kind === 'none' && pushedAtMs == null && nfc.lineAtRiskPushDue(s, t, o) != null) {
      pushedAtMs = t;
      s = { ...s, forceChargeLineAtRiskPushedAtMs: t };
    }
    if (a.kind === 'syncCeiling') {
      s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? a.prior, forceChargeCeilingSyncedPct: a.pct };
      pendingCeiling = a.pct;
    } else if (a.kind === 'on') {
      // F-iii's emulation: the ON honoured only once a start timed to ⌈L⌉ alone (no + 5) is due.
      if (variant !== 'askStart' || t >= nfc.forceChargeLineStartAtMs(W1, ask, seen, NAME, chargeRateKw, evDisplacedKwh, 3)) {
        s = { ...s, ...nfc.forceChargeOnStamp(s, t, a.slots, gates), forceChargeOnLastAttemptMs: t } as LineState;
        onEffectiveMs = t + kn.onDelayMin * MIN;
      }
    } else if (a.kind === 'onVerified') {
      s = { ...s, forceChargeOnVerifiedAtMs: t };
    } else if (a.kind === 'onRetry') {
      s = { ...s, forceChargeOnRetries: s.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: t };
      onEffectiveMs = t + kn.onDelayMin * MIN;
    } else if (a.kind === 'lineReOn') {
      if (variant !== 'noReOn') {
        s = { ...s, forceChargeLineReOns: s.forceChargeLineReOns + 1, forceChargeLineReOnAtMs: t, forceChargeLineReOnSlots: [...a.slots] };
        onEffectiveMs = t + kn.onDelayMin * MIN;
        reOns += 1;
      }
    } else if (a.kind === 'lineReOnChecked') {
      // (review 2) index.ts records the re-ON's readback check; the budget's next re-ON is the retry.
      s = { ...s, forceChargeLineReOnCheckedAtMs: t, forceChargeLineReOnNotAppliedSlots: [...a.notApplied],
        forceChargeLineReOnsNotApplied: s.forceChargeLineReOnsNotApplied + (a.notApplied.length > 0 ? 1 : 0) };
    } else if (a.kind === 'off') {
      s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: a.reason };
      chargeNowOn = false; onEffectiveMs = null;
    }
    // F-i's emulation: a software stop at ⌈L⌉ (design A's hold without its drain allowance).
    if (variant === 'hold' && chargeNowOn && seen >= ask) { chargeNowOn = false; onEffectiveMs = null; s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: 'target' }; }
    if (chargeNowOn && importing && pack < (panelCeiling / 100) * CAP) {
      pack = Math.min((panelCeiling / 100) * CAP, pack + Math.max(1, (17 - load) * LEG) * k * (MIN / H));
      onMin += 1;
    } else {
      // At the ceiling the panel switches the slots OFF by itself, and they stay OFF (measured). 'onLatch': they
      // stop importing and keep reading ON (unmeasured).
      if (chargeNowOn) { onMin += 1; if (variant === 'onLatch') importing = false; else chargeNowOn = false; }
      if (pack > 0.5 * CAP) pack = Math.max(0.5 * CAP, pack - (load / DIS + kn.standbyKw) * (MIN / H));
    }
  }
  tail.sort((x, y) => x - y);
  const m = Math.floor(tail.length / 2);
  return { close: tail.length % 2 ? tail[m] : (tail[m - 1] + tail[m]) / 2, onMin, reOns, pushedAtMs };
}

const YEAR_LINES = [50.45, 50.61, 51.15, 51.43, 52.62, 54.33, 55.55, 57.52, 59.1, 65.95];
const HIGH_LINES = [69.5, 72.2, 74.6, 77.1, 80.3, 84.9, 89.6];
const HOUSES = [0.6, 1.2, 2.0, 2.8, 3.6];
const KS = [0.9, 1.0, 1.1, 1.25];

/** (review 2) `pushed` — nights the line-at-risk push went; `underPushed` — of the nights under, those it reached;
 *  `latePushed` — pushes inside FORCE_CHARGE_LINE_AT_RISK_LEAD_MS of the close (the helper never makes one). */
function cell(lines: number[], kn: Partial<Knobs>, ks: number[] = KS, variant: Variant = 'real'): { under: number; n: number; worst: number; meanOn: number; reOns: number; pushed: number; underPushed: number; latePushed: number } {
  const k2 = { ...BASE, ...kn };
  let under = 0, n = 0, worst = Infinity, on = 0, reOns = 0, pushed = 0, underPushed = 0, latePushed = 0;
  for (const L of lines) for (const h of HOUSES) for (const k of ks) {
    const r = night(L, h, k, k2, variant);
    n += 1; on += r.onMin; reOns += r.reOns; worst = Math.min(worst, r.close - L);
    if (r.pushedAtMs != null) { pushed += 1; if (r.pushedAtMs > W1 - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) latePushed += 1; }
    if (r.close < L - 0.05) { under += 1; if (r.pushedAtMs != null) underPushed += 1; }
  }
  return { under, n, worst, meanOn: on / n, reOns, pushed, underPushed, latePushed };
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

/** The tick's evDisplacedKwh as index.ts passes it: a PREDICTED EV pulls the start early, the pool reaches
 *  the panel ceiling and latches, and the real EV (later, or larger) draws it back down — the review's case. */
const PREDICTED: Array<[string, Partial<Knobs>]> = [
  ['20 kWh predicted, 7 kW EV from 60 min', { predEvKwh: 20, evFromMin: 60 }],
  ['20 kWh predicted, 7 kW EV from 90 min', { predEvKwh: 20, evFromMin: 90 }],
  ['30 kWh predicted, 11 kW EV from 90 min', { predEvKwh: 30, evKw: 11, evFromMin: 90 }],
  ['30 kWh predicted, 11 kW EV from 120 min', { predEvKwh: 30, evKw: 11, evFromMin: 120 }],
  ['predicted exactly, 7 kW EV from 90 min', { predEvKwh: 'exact', evFromMin: 90 }],
  ['predicted exactly, 11.52 kW EV from 90 min', { predEvKwh: 'exact', evKw: EV_MAX_KW, evFromMin: 90 }],
  ['predicted exactly, 11.52 kW EV from 120 min', { predEvKwh: 'exact', evKw: EV_MAX_KW, evFromMin: 120 }],
  ['36 kWh predicted, 11.52 kW EV from 90 min', { predEvKwh: 36, evKw: EV_MAX_KW, evFromMin: 90 }],
  ['36 kWh predicted, 11.52 kW EV from 180 min', { predEvKwh: 36, evKw: EV_MAX_KW, evFromMin: 180 }],
  ['pool 77 + 20 kWh predicted, 7 kW EV from 90 min', { p0: 77, predEvKwh: 20, evFromMin: 90 }],
  ['all: standby, ON 5 min late, 3 min stale + 20 kWh predicted, 7 kW EV from 90 min',
    { standbyKw: 0.27, onDelayMin: 5, staleMin: 3, predEvKwh: 20, evFromMin: 90 }],
];

test('★★★ T7 the year-shaped lines close at or above the line in EVERY stress cell: 0 under, rounded and floored readings', () => {
  const out: string[] = [];
  for (const floor of [false, true]) {
    for (const [name, kn] of STRESSES) {
      const r = cell(YEAR_LINES, { ...kn, floor });
      out.push(`${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
      assert.equal(r.under, 0, `${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n} under, worst close − L ${r.worst.toFixed(2)}`);
      // (review 2) and the line-at-risk push never goes on them: a carried night with no latch is never a warning.
      assert.equal(r.pushed, 0, `${name}${floor ? ' (floor)' : ''}: ${r.pushed} pushed`);
    }
    for (const k of [0.7, 0.6]) {
      const r = cell(YEAR_LINES, { floor }, [k]);
      assert.equal(r.under, 0, `the pack takes ${k} of the rate${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
    }
  }
  assert.ok(out.length === 26);
});

test('★★★ T7 (review) a PREDICTED EV pulls the start early and the panel latches OFF at its ceiling: the re-ON closes every cell at or above the line, year and high asks', () => {
  for (const floor of [false, true]) {
    for (const [name, kn] of PREDICTED) {
      for (const [lines, label] of [[YEAR_LINES, 'year'], [HIGH_LINES, 'high asks']] as const) {
        const r = cell(lines as number[], { ...kn, floor });
        assert.equal(r.under, 0, `${name}, ${label}${floor ? ' (floor)' : ''}: ${r.under}/${r.n} under, worst close − L ${r.worst.toFixed(2)}`);
      }
    }
  }
  // The re-ON is what carries them: it fires on these nights (and never on the plain year cells).
  assert.ok(cell(YEAR_LINES, { predEvKwh: 30, evKw: 11, evFromMin: 90 }).reOns >= 40);
  assert.equal(cell(YEAR_LINES, {}).reOns, 0);
});

test('★★★ T7 (review 2) the ON-READING latch — UNMEASURED here: no re-ON keys on a slot reading ON, so predicted-EV nights close under; pinned exactly, and the line-at-risk push reaches every one of them ≥ 20 min before the close', () => {
  const got: Record<string, Array<[number, number]>> = {};
  let real = { round: 0, floor: 0 };
  for (const [name, kn] of PREDICTED) {
    got[name] = [];
    for (const [lines, floor] of [[YEAR_LINES, false], [YEAR_LINES, true], [HIGH_LINES, false], [HIGH_LINES, true]] as const) {
      const r = cell(lines as number[], { ...kn, floor }, KS, 'onLatch');
      got[name].push([r.under, r.pushed]);
      assert.equal(r.underPushed, r.under, `${name} (${lines === YEAR_LINES ? 'year' : 'high'}${floor ? ', floor' : ''}): the push reached ${r.underPushed} of ${r.under} under`);
      assert.equal(r.latePushed, 0, 'never inside the lead');
      const m = cell(lines as number[], { ...kn, floor });
      assert.equal(m.under, 0, 'the measured (OFF-reading) latch: carried by the re-ON');
      real = { ...real, [floor ? 'floor' : 'round']: real[floor ? 'floor' : 'round'] + m.pushed };
    }
  }
  assert.deepEqual(got, PIN_ON_LATCH);
  assert.deepEqual(real, PIN_REAL_PREDICTED_PUSHES);
  // The shape is what the once-a-night log names: a slot of ours reading ON, its Core under the ceiling, the pool falling.
  const s = { ...emptyActuationState(), day: '2027-01-04', windowStartMs: W0, windowEndMs: W1, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55,
    forceChargeOnAtMs: W0, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: W0 + MIN, forceChargeCeilingSyncedPct: 80,
    forceChargeLinePoolSamples: [{ pct: 66, atMs: W1 - 70 * MIN }] } as LineState;
  const o = { enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false, slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3],
    vitalsRed: false, socCoherent: true, slotSocPct: { 1: 62, 2: 62, 3: 62 }, ceilingReadbackPct: 80, poolSocPct: 62, fullKwh: NAME } as ForceChargeOpts;
  assert.deepEqual(nfc.lineOnReadingShape(s, W1 - H, o)?.slots, [1, 2, 3]);
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
  // The mean ON time on these lines (the exposure the CHANGELOG states), against the year's.
  assert.equal(Math.round(cell(HIGH_LINES, {}).meanOn), MEAN_ON.high);
  assert.equal(Math.round(cell(YEAR_LINES, {}).meanOn), MEAN_ON.year);
  assert.equal(Math.round(cell(YEAR_LINES, { predEvKwh: 20, evFromMin: 90 }).meanOn), MEAN_ON_PREDICTED_EV);
});

test('★★★ T7 (review) known failures: a late UNPREDICTED load that takes the grid cap after the start, alone or combined — pinned exactly, never claimed carried', () => {
  const got: Record<string, [number, number, number, number]> = {};
  for (const [name, kn, ks] of KNOWN_CELLS) {
    const r = (lines: number[], floor: boolean) => cell(lines, { ...kn, floor }, ks).under;
    got[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(got, PIN_KNOWN);
  // (review 2) The line-at-risk push on those nights: the under nights it reached, pinned (it needs the pool not rising).
  const pushed: Record<string, [number, number, number, number]> = {};
  for (const [name, kn, ks] of KNOWN_CELLS) {
    const r = (lines: number[], floor: boolean) => { const c = cell(lines, { ...kn, floor }, ks); assert.equal(c.latePushed, 0); return c.underPushed; };
    pushed[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(pushed, PIN_KNOWN_PUSHED);
});

test('★★ T7 (review) cost-dominant nights (the cost stop at ⌈L⌉ + 10 or above runs today\'s cost force-charge, with its software stop): pinned, never claimed carried', () => {
  const got: Record<string, [number, number, number, number]> = {};
  for (const [name, kn] of COST_CELLS) {
    const r = (lines: number[], floor: boolean) => cell(lines, { ...kn, floor }).under;
    got[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(got, PIN_COST);
  // Those nights ARE cost-dominant (the mode the tick runs), so the line's re-ON never rides them.
  const s = { ...emptyActuationState(), forceChargeCeilingPct: 66, forceChargeLineAskPct: 56 };
  assert.equal(nfc.forceChargeModeOf(s, { cost: true, line: true })?.kind, 'cost');
});

test('★★ T7 the discriminators: a software stop at ⌈L⌉, a start timed to ⌈L⌉ alone, and no re-ON after the latch close under the line on this grid', () => {
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
  // No re-ON after the panel's latch (the review's finding): a predicted EV that arrives late closes under.
  const noReOn20 = cell(YEAR_LINES, { predEvKwh: 20, evFromMin: 90 }, KS, 'noReOn');
  const noReOn30 = cell(YEAR_LINES, { predEvKwh: 30, evKw: 11, evFromMin: 90 }, KS, 'noReOn');
  assert.ok(noReOn20.under >= 8 && noReOn30.under >= 40, `no re-ON: 20 kWh/7 kW from 90 ${noReOn20.under}, 30 kWh/11 kW from 90 ${noReOn30.under}`);
});

/** Measured when the change was made (v1.200.0) on the real decideForceCharge. Rounded readings match the
 *  integrator's emulation (rtcSim4-highasks.out: 1/140, 8/35, 30/35); floored readings cost a point at the
 *  close. Out of 140 nights (7 lines × 5 houses × 4 rate factors), or 35 at a single rate factor. */
const PIN_HIGH = { round: { ev90: 1, rate07: 8, rate06: 30 }, floor: { ev90: 10, rate07: 11, rate06: 33 } };
/** Mean minutes a slot reads Charge Now ON (the exposure stated in the CHANGELOG and the docs), emulated: from
 *  the ON to the window close, or to the panel's own OFF at its ceiling (the latch). Before the plant modelled
 *  the latch these read 75 and 169; a predicted EV starts earlier and lengthens them (pinned below). */
const MEAN_ON = { year: 74, high: 142 };
/** …and on the year's lines with a 20 kWh EV predicted (a 7 kW one arriving 90 min out). */
const MEAN_ON_PREDICTED_EV = 138;

/** Known failures (review): the start is timed on the live rate, and an unpredicted load that arrives after
 *  it takes the grid cap the pack was timed on. [year rounded, year floored, high rounded, high floored]
 *  under, of 200 / 200 / 140 / 140 (50 / 50 / 35 / 35 at a single rate factor). */
const KNOWN_CELLS: Array<[string, Partial<Knobs>, number[]?]> = [
  ['unpredicted 7 kW EV from 120 min', { evFromMin: 120 }],
  ['unpredicted 11.52 kW EV from 60 min', { evKw: EV_MAX_KW, evFromMin: 60 }],
  ['unpredicted 11.52 kW EV from 90 min', { evKw: EV_MAX_KW, evFromMin: 90 }],
  ['unpredicted 11.52 kW EV from 120 min', { evKw: EV_MAX_KW, evFromMin: 120 }],
  ['ON 5 min late × unpredicted 7 kW EV from 90 min', { onDelayMin: 5, evFromMin: 90 }],
  ['pack at 0.85 of the rate × unpredicted 7 kW EV from 90 min', { evFromMin: 90 }, [0.85]],
];
const PIN_KNOWN: Record<string, [number, number, number, number]> = {
  'unpredicted 7 kW EV from 120 min': [5, 8, 45, 55],
  'unpredicted 11.52 kW EV from 60 min': [0, 1, 8, 18],
  'unpredicted 11.52 kW EV from 90 min': [73, 82, 87, 93],
  'unpredicted 11.52 kW EV from 120 min': [55, 61, 138, 139],
  'ON 5 min late × unpredicted 7 kW EV from 90 min': [1, 4, 19, 30],
  'pack at 0.85 of the rate × unpredicted 7 kW EV from 90 min': [1, 3, 29, 34],
};

/** Cost-dominant nights (review): the cost gate on with a cost ceiling at ⌈L⌉ + 10 or + 15 (≤ 100). */
const COST_CELLS: Array<[string, Partial<Knobs>]> = [
  ['cost ⌈L⌉ + 10, baseline', { costPct: (a) => a + 10 }],
  ['cost ⌈L⌉ + 10, 7 kW EV from 60 min', { costPct: (a) => a + 10, evFromMin: 60 }],
  ['cost ⌈L⌉ + 10, 7 kW EV from 90 min', { costPct: (a) => a + 10, evFromMin: 90 }],
  ['cost ⌈L⌉ + 10, 11.52 kW EV from 60 min', { costPct: (a) => a + 10, evKw: EV_MAX_KW, evFromMin: 60 }],
  ['cost ⌈L⌉ + 15, 11.52 kW EV from 60 min', { costPct: (a) => a + 15, evKw: EV_MAX_KW, evFromMin: 60 }],
];
const PIN_COST: Record<string, [number, number, number, number]> = {
  'cost ⌈L⌉ + 10, baseline': [0, 0, 0, 0],
  'cost ⌈L⌉ + 10, 7 kW EV from 60 min': [0, 0, 5, 5],
  'cost ⌈L⌉ + 10, 7 kW EV from 90 min': [0, 0, 0, 7],
  'cost ⌈L⌉ + 10, 11.52 kW EV from 60 min': [0, 0, 15, 27],
  'cost ⌈L⌉ + 15, 11.52 kW EV from 60 min': [0, 0, 15, 15],
};

/** (review 2) THE ON-READING LATCH — UNMEASURED on this plant (no per-slot readback ever showed a slot reading ON at
 *  its ceiling and not importing; 2026-09-18's "Charge Now still ON" is the add-on's record, not a readback). Per
 *  PREDICTED cell: [under, nights the line-at-risk push went] for [year rounded, year floored, high rounded, high
 *  floored], of 200 / 200 / 140 / 140. The re-ON keys on slots reading OFF, so nothing of ours switches these back on;
 *  the push reaches every night that closes under (pinned below), at least FORCE_CHARGE_LINE_AT_RISK_LEAD_MS before
 *  the close, and also goes on nights the remaining charge still carries. Matches the round-2 reviewer's emulation. */
const PIN_ON_LATCH: Record<string, Array<[number, number]>> = {
  '20 kWh predicted, 7 kW EV from 60 min': [[1, 7], [2, 8], [84, 140], [93, 140]],
  '20 kWh predicted, 7 kW EV from 90 min': [[8, 13], [9, 15], [137, 140], [139, 140]],
  '30 kWh predicted, 11 kW EV from 90 min': [[44, 57], [47, 59], [140, 140], [140, 140]],
  '30 kWh predicted, 11 kW EV from 120 min': [[31, 33], [32, 33], [140, 140], [140, 140]],
  'predicted exactly, 7 kW EV from 90 min': [[0, 0], [0, 0], [52, 72], [55, 74]],
  'predicted exactly, 11.52 kW EV from 90 min': [[8, 8], [8, 9], [105, 105], [105, 105]],
  'predicted exactly, 11.52 kW EV from 120 min': [[8, 8], [8, 12], [105, 109], [105, 113]],
  '36 kWh predicted, 11.52 kW EV from 90 min': [[65, 84], [72, 91], [140, 140], [140, 140]],
  '36 kWh predicted, 11.52 kW EV from 180 min': [[10, 42], [10, 55], [124, 140], [127, 140]],
  'pool 77 + 20 kWh predicted, 7 kW EV from 90 min': [[5, 13], [7, 17], [140, 140], [140, 140]],
  'all: standby, ON 5 min late, 3 min stale + 20 kWh predicted, 7 kW EV from 90 min': [[7, 11], [8, 13], [131, 140], [133, 140]],
};
/** (review 2) The line-at-risk push on the MEASURED (OFF-reading) latch, summed over every PREDICTED cell (3,740 nights),
 *  rounded and floored: none of those nights closes under the line (the re-ON carries them), so each push here is a
 *  warning on a night that still held — the cost of pushing while there is time to act. */
const PIN_REAL_PREDICTED_PUSHES = { round: 202, floor: 227 };
/** (review 2) …and on the KNOWN late-unpredicted-load cells: the under nights the push reached, in PIN_KNOWN's order. It needs
 *  the pool NOT RISING with at least 20 min left: a load that slows the charge without stopping it (7 kW from 120 min;
 *  an ON 5 min late with a 7 kW EV) still rises, short of the line, and is not pushed — a residual, pinned. */
const PIN_KNOWN_PUSHED: Record<string, [number, number, number, number]> = {
  'unpredicted 7 kW EV from 120 min': [0, 0, 0, 0],
  'unpredicted 11.52 kW EV from 60 min': [0, 1, 8, 18],
  'unpredicted 11.52 kW EV from 90 min': [69, 72, 83, 90],
  'unpredicted 11.52 kW EV from 120 min': [52, 58, 124, 123],
  'ON 5 min late × unpredicted 7 kW EV from 90 min': [0, 0, 0, 0],
  'pack at 0.85 of the rate × unpredicted 7 kW EV from 90 min': [0, 1, 2, 1],
};
