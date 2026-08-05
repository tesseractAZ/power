import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPeakDraw, evaluatePeakDraw, gridToBatteryW, peakGridDrawAlerts, trackOnset, resetPeakDrawOnset,
  attributeCores, CORE_ATTRIBUTION_MIN_W,
  PEAK_GRID_DRAW_ALERT_ID, DEFAULT_PEAK_DRAW_CONFIG,
  type PeakDrawInputs, type PeakDrawConfig,
} from '../src/peakGridDraw.js';
import { buildApsREvModel } from '../src/tariff.js';

/**
 * v1.70.0 — the 2026-08-04 on-peak buy. At 17:22 MST the plant imported 11.6 kW
 * against a 6.5 kW house load with 1.3 kW PV and a pack at 41 % (reserve 10 %),
 * refilling the battery at the most expensive rate of the day. Nothing detected it.
 */

const CFG: PeakDrawConfig = { ...DEFAULT_PEAK_DRAW_CONFIG, dwellMs: 10 * 60_000 };

/** APS R-EV with confirmed summer rates so the cost path is exercised. */
const TARIFF = buildApsREvModel({
  confirmed: true, // ★ without this every rate resolves null by design
  onPeak: { summer: 34.0, winter: 24.0 },
  overnight: { summer: 8.0, winter: 7.0 },
});
/** Same plan with rates NOT confirmed (the shipped default). */
const TARIFF_NO_RATES = buildApsREvModel();

// 2026-08-04 17:22 MST (Phoenix is UTC-7, no DST) = 2026-08-05 00:22 UTC.
const PEAK_TS = Date.UTC(2026, 7, 5, 0, 22);
// 2026-08-04 21:30 MST — after the 19:00 on-peak close.
const OFFPEAK_TS = Date.UTC(2026, 7, 5, 4, 30);
const MIN = 60_000;

const inputs = (o: Partial<PeakDrawInputs> = {}): PeakDrawInputs => ({
  nowMs: PEAK_TS,
  gridImportW: 11614, panelLoadW: 6505, pvW: 1345,
  socPct: 41, reserveSocPct: 10,
  gridPresent: true,
  coreDraws: [
    { label: 'Core 1', acInWatts: 7200 },
    { label: 'Core 3', acInWatts: 4414 },
    { label: 'Core 2', acInWatts: 0 },
  ],
  onsetMs: PEAK_TS - 15 * MIN, // already dwelled
  ...o,
});

beforeEach(() => resetPeakDrawOnset());

test('gridToBatteryW: the grid only has to cover what PV does not', () => {
  // Load 6505, PV 1345 → grid owes 5160. Import 11614 → 6454 into the pack.
  assert.equal(gridToBatteryW(11614, 6505, 1345), 6454);
  // PV covers the whole house: every watt imported is going to the battery.
  assert.equal(gridToBatteryW(5000, 2000, 3000), 5000);
  // Import below what the house needs — nothing is charging, and it never goes negative.
  assert.equal(gridToBatteryW(3000, 6000, 0), 0);
});

test('THE INCIDENT: 6.4 kW into the pack at 17:22 on-peak is detected', () => {
  const v = assessPeakDraw(inputs(), TARIFF, CFG);
  assert.equal(v.active, true);
  assert.equal(v.onPeak, true);
  assert.match(v.periodLabel, /On-Peak/);
  assert.equal(v.gridToBatteryW, 6454);
  assert.equal(v.suppressed, null);
  // 6.454 kW × 34 c/kWh ≈ 219 c/h.
  assert.ok(v.centsPerHour !== null && Math.abs(v.centsPerHour - 219.4) < 1,
    `~219 c/h (${v.centsPerHour})`);
});

test('★ THE GUARD: at or near the reserve this stays SILENT', () => {
  // Buying on-peak to restore outage protection is CORRECT. An alert here would
  // advise trading away safety margin for money — the one thing it must never do.
  const atReserve = assessPeakDraw(inputs({ socPct: 10 }), TARIFF, CFG);
  assert.equal(atReserve.active, false);
  assert.equal(atReserve.suppressed, 'below-reserve');

  const inHeadroom = assessPeakDraw(inputs({ socPct: 19 }), TARIFF, CFG);
  assert.equal(inHeadroom.active, false, 'the headroom band is still outage preparation');

  // Just above the headroom, cost becomes a fair consideration again.
  assert.equal(assessPeakDraw(inputs({ socPct: 21 }), TARIFF, CFG).active, true);
});

test('off-peak the same charging is exactly what we want — silent', () => {
  const v = assessPeakDraw(inputs({ nowMs: OFFPEAK_TS, onsetMs: OFFPEAK_TS - 15 * MIN }), TARIFF, CFG);
  assert.equal(v.active, false);
  assert.equal(v.suppressed, 'off-peak');
});

test('during an outage there is nothing to buy — silent', () => {
  const v = assessPeakDraw(inputs({ gridPresent: false }), TARIFF, CFG);
  assert.equal(v.active, false);
  assert.equal(v.suppressed, 'outage');
});

test('a brief surplus does not alert — the condition must dwell', () => {
  const brief = assessPeakDraw(inputs({ onsetMs: PEAK_TS - 3 * MIN }), TARIFF, CFG);
  assert.equal(brief.active, false, 'an EV plugging in is not a buying pattern');
  assert.ok(brief.gridToBatteryW > 0, 'but the condition IS observed');
  assert.equal(assessPeakDraw(inputs({ onsetMs: PEAK_TS - 11 * MIN }), TARIFF, CFG).active, true);
});

test('small residuals are ignored — this is not an energy-balance instrument', () => {
  // 400 W of residual across two different meters is noise, not a decision.
  const v = assessPeakDraw(inputs({ gridImportW: 5560 }), TARIFF, CFG);
  assert.equal(v.active, false);
});

test('missing telemetry does not fabricate a verdict', () => {
  for (const gap of [{ gridImportW: null }, { panelLoadW: null }, { pvW: null }]) {
    const v = assessPeakDraw(inputs(gap), TARIFF, CFG);
    assert.equal(v.active, false);
    assert.equal(v.suppressed, 'insufficient-data');
  }
});

test('unconfirmed rates still alert, but quote NO fabricated cost', () => {
  const v = assessPeakDraw(inputs(), TARIFF_NO_RATES, CFG);
  assert.equal(v.active, true, 'the behaviour is wrong even when the price is unknown');
  assert.equal(v.centsPerHour, null);
  const [a] = peakGridDrawAlerts(v, PEAK_TS);
  assert.match(a.detail, /not confirmed/i);
  assert.ok(!/\$\d/.test(a.detail), 'no invented dollar figure');
});

test('the alert is a WARNING — cost must never compete with life-safety', () => {
  const v = assessPeakDraw(inputs(), TARIFF, CFG);
  const [a] = peakGridDrawAlerts(v, PEAK_TS);
  assert.equal(a.id, PEAK_GRID_DRAW_ALERT_ID);
  assert.equal(a.severity, 'warning');
  assert.equal(a.priority, 'low', 'below every physical-risk condition');
  assert.equal(a.category, 'Grid');
  assert.match(a.detail, /EcoFlow app/, 'points at the setting that actually owns this');
  assert.match(a.detail, /\$2\.19 per hour/);
});

test('a healthy off-peak system produces NO alert', () => {
  const v = assessPeakDraw(inputs({ nowMs: OFFPEAK_TS }), TARIFF, CFG);
  assert.deepEqual(peakGridDrawAlerts(v, OFFPEAK_TS), []);
});

test('evaluatePeakDraw: a sustained condition reaches the dwell across ticks', () => {
  // This is the wiring the alert monitor actually uses. If it were called with a
  // fresh null onset each tick, the dwell could never elapse and the alert would
  // never fire — silently, with every unit test still green.
  const tick = (minsFromStart: number) => evaluatePeakDraw({
    nowMs: PEAK_TS + minsFromStart * MIN,
    gridImportW: 11614, panelLoadW: 6505, pvW: 1345,
    socPct: 41, reserveSocPct: 10, gridPresent: true, coreDraws: [],
  }, TARIFF, CFG);

  assert.equal(tick(0).active, false, 'first sighting starts the dwell');
  assert.equal(tick(5).active, false);
  assert.equal(tick(10).active, true, '★ the dwell actually elapses across ticks');
});

test('evaluatePeakDraw: the dwell restarts after the condition clears', () => {
  const base = { gridImportW: 11614, panelLoadW: 6505, pvW: 1345, socPct: 41, reserveSocPct: 10, gridPresent: true, coreDraws: [] };
  evaluatePeakDraw({ ...base, nowMs: PEAK_TS }, TARIFF, CFG);
  // Grid import collapses to house-only — nothing is charging any more.
  evaluatePeakDraw({ ...base, nowMs: PEAK_TS + 5 * MIN, gridImportW: 5160 }, TARIFF, CFG);
  // It comes back; the clock must start over, not resume the old dwell.
  assert.equal(evaluatePeakDraw({ ...base, nowMs: PEAK_TS + 11 * MIN }, TARIFF, CFG).active, false);
  assert.equal(evaluatePeakDraw({ ...base, nowMs: PEAK_TS + 21 * MIN }, TARIFF, CFG).active, true);
});

test('evaluatePeakDraw: a suppressed condition never accrues dwell', () => {
  const belowReserve = { gridImportW: 11614, panelLoadW: 6505, pvW: 1345, socPct: 12, reserveSocPct: 10, gridPresent: true, coreDraws: [] };
  for (const m of [0, 10, 20, 30]) {
    assert.equal(evaluatePeakDraw({ ...belowReserve, nowMs: PEAK_TS + m * MIN }, TARIFF, CFG).active, false,
      'a depleted pack must never age into a cost alert');
  }
});

test('onset tracking resets the moment the condition clears', () => {
  assert.equal(trackOnset(true, PEAK_TS), PEAK_TS, 'first sighting stamps the onset');
  assert.equal(trackOnset(true, PEAK_TS + 5 * MIN), PEAK_TS, 'onset is held, not advanced');
  assert.equal(trackOnset(false, PEAK_TS + 6 * MIN), null, 'clearing drops it');
  assert.equal(trackOnset(true, PEAK_TS + 7 * MIN), PEAK_TS + 7 * MIN, 'and the dwell restarts');
});

/* ─── v1.71.0 — per-Core attribution ──────────────────────────────────────── */

test('attributeCores names the drawing units, biggest first', () => {
  const out = attributeCores([
    { label: 'Core 3', acInWatts: 4414 },
    { label: 'Core 1', acInWatts: 7200 },
  ]);
  assert.equal(out, 'Core 1 (7.2 kW), Core 3 (4.4 kW)', 'ordered by draw, not by input order');
});

test('attributeCores ignores idle and standby-level Cores', () => {
  assert.equal(attributeCores([
    { label: 'Core 1', acInWatts: 7200 },
    { label: 'Core 2', acInWatts: 0 },
    { label: 'Core 3', acInWatts: CORE_ATTRIBUTION_MIN_W - 1 },
  ]), 'Core 1 (7.2 kW)');
  assert.equal(attributeCores([]), null, 'nothing to name');
  assert.equal(attributeCores([{ label: 'Core 1', acInWatts: 10 }]), null, 'standby is not a culprit');
});

test('★ the alert names WHICH Cores — Charge Now is a per-unit setting', () => {
  const v = assessPeakDraw(inputs(), TARIFF, CFG);
  assert.equal(v.coreAttribution, 'Core 1 (7.2 kW), Core 3 (4.4 kW)');
  const [a] = peakGridDrawAlerts(v, PEAK_TS);
  assert.match(a.detail, /Charge Now/, 'names the real setting, not smartBackupMode');
  assert.match(a.detail, /PER-UNIT/, 'tells the operator it is per-unit');
  assert.ok(!/Smart Backup/i.test(a.detail), 'the v1.70.0 misattribution is gone');
  assert.match(a.detail, /Core 1 \(7\.2 kW\)/, 'the culprits are in the operator-facing text');
  const who = a.facts?.find((f) => f.label === 'Drawing');
  assert.equal(who?.value, 'Core 1 (7.2 kW), Core 3 (4.4 kW)');
});

test('no dominant Core still produces a usable alert', () => {
  const v = assessPeakDraw(inputs({ coreDraws: [] }), TARIFF, CFG);
  assert.equal(v.coreAttribution, null);
  const [a] = peakGridDrawAlerts(v, PEAK_TS);
  assert.equal(a.facts?.find((f) => f.label === 'Drawing')?.value, 'no single Core dominant');
  assert.ok(!/Drawing now:/.test(a.detail), 'no dangling empty clause');
});
