/**
 * R5 (v1.189.0) — the overnight announcement's cases, for the golden test
 * (overnightTextGolden.test.ts). Each case is the evening job's inputs for one overnight cycle —
 * the plan the real engine sizes, the arm the cycle record makes from it, the push shape and the
 * spoken deadline — and overnightTextGolden.json holds the push and the spoken pair the release
 * before the day-aware formatter produced for it (captured at d42b556). The formatter must route
 * every one of them to exactly those words.
 *
 * The fixture is the 2026-10-12 evening of nightChargeExpectedBuy.test.ts (21:30, window
 * 00:00–05:00, cost mode, force-charge eligible), varied in pool, objective, charge rate and mode
 * so every shape of the push is covered: charge (force-charge riding, reserve only, toward, the
 * cushion short), a night that charges nothing, the three holds, no plan, advisory, refused.
 */
import {
  buildNightChargeInputs, computeNightChargePlan,
  type NightChargeInputDeps, type NightForecastHour, type NightChargePlan,
} from '../../src/nightChargeAdvisor.js';
import { armCycle, emptyCycle } from '../../src/chargeCycle.js';
import { chargeLevelPct, statedBuyKwh } from '../../src/nightChargeAdvisor.js';
import type { NightChargeMode } from '../../src/nightChargeActuator.js';

const H = 3_600_000;
const POOL = 92.16;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
export const GOLDEN_NOW = phx(10, 12, 21, 30);
const WIN_START = phx(10, 13, 0);
const WIN_END = phx(10, 13, 5);
const NEXT_WINDOW = phx(10, 13, 23);
const phxHour = (ts: number): number => (new Date(ts).getUTCHours() + 17) % 24;
const houseKw = (h: number): number => (h >= 21 || h < 0 ? 2.8 : h < 5 ? 2.2 : h < 17 ? 2.6 : 3.4);
const pvP50Kw = (h: number): number => (h >= 7 && h < 18 ? 6 * Math.sin(((h - 7 + 0.5) / 11) * Math.PI) : 0);

function band(): NightForecastHour[] {
  const out: NightForecastHour[] = [];
  for (let ts = phx(10, 12, 21); ts < NEXT_WINDOW; ts += H) {
    const hour = phxHour(ts);
    const forecastLoadW = houseKw(hour) * 1000;
    const p50W = pvP50Kw(hour) * 1000;
    out.push({ ts, pvP10W: p50W * 0.8, loadP90W: forecastLoadW * 1.35, embeddedEvW: 0, loadP50W: forecastLoadW, pvP50W: p50W });
  }
  return out;
}

function deps(over: Partial<NightChargeInputDeps>): NightChargeInputDeps {
  return {
    nowMs: GOLDEN_NOW, fullKwh: POOL, socNowPct: 53, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
    islandedLoadKw: 2.62, outageCushionHours: 4, islandedLoadSafety: 1.25,
    objectiveMode: 'cost', costMaxSocPct: 90,
    legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 17.8, gridInputCapKw: 17,
    periodIdAt: (ms) => (ms >= WIN_START && ms < WIN_END) || ms >= NEXT_WINDOW ? 'overnight' : 'off_peak',
    cheapPeriodId: 'overnight', windowScanHours: 30,
    bandHours: band(), dayRollups: [], realizedDailyErrHalfFrac: 0.1, nextRechargeMs: NEXT_WINDOW,
    ev: { p90SessionKwh: 19.3, chargeStartMs: phx(10, 12, 21), sessionCount: 12 },
    evMaxLoadW: 11520,
    confidenceTier: 'forecast', forecastPresent: true, calScoredDays: 30, minCalScoredDays: 14, bandCoverageFrac: 0.85,
    morningPvSurplusP90Kwh: 30, morningPvSurplusP50Kwh: 18.06, longGapAhead: false, minBuyKwh: 1,
    buyDebiasFactor: 1, buyDebiasBasis: 'default', buyDebiasSamples: 0,
    forceChargeEligible: true,
    ...over,
  };
}

/** The fixture's plan with `over` applied (the probe the cases are chosen with). */
export function goldenPlan(over: Partial<NightChargeInputDeps>): NightChargePlan {
  return computeNightChargePlan(buildNightChargeInputs(deps(over)));
}

/** v1.196.0 — the fixture's planner inputs with `over` applied (realizedCushionAtClose.test.ts
 *  walks the plan's own P50 horizon after the close). */
export function goldenInputs(over: Partial<NightChargeInputDeps>): ReturnType<typeof buildNightChargeInputs> {
  return buildNightChargeInputs(deps(over));
}

/** One overnight evening's announcement inputs, as the evening job assembles them. */
export interface OvernightTextCase {
  name: string;
  plan: NightChargePlan | null;
  shape: 'charge' | 'hold' | 'insufficient_basis';
  supervised: {
    cancelDeadlineText: string; cancelDeadlineTextEs: string; targetPct: number; forceChargeTargetPct?: number | null;
  } | null;
  armRefused: string | null;
  mode: NightChargeMode;
}

/** The evening job's arm step (index.ts runNightChargeEveningJob): armCycle with the overnight cost
 *  leg against an empty cycle; the supervised context from the armed leg. */
function armed(plan: NightChargePlan, forceCharge: boolean): OvernightTextCase['supervised'] {
  const arm = armCycle(emptyCycle(), '2026-10-12', [{
    role: 'cost', kind: 'overnight', plan, forceChargeEnabled: forceCharge, nextOnPeakStartMs: phx(10, 13, 16),
    announcedLevelPct: chargeLevelPct(plan), announcedExpectedKwh: statedBuyKwh(plan),
  }], GOLDEN_NOW, plan.reserveFloorPct);
  const c = arm.cycle?.active;
  if (c == null || c.windowStartMs == null || c.targetPct == null) return null;
  return {
    cancelDeadlineText: 'at 12:00 AM', cancelDeadlineTextEs: 'a las 12:00 AM', targetPct: c.targetPct,
    forceChargeTargetPct: c.forceChargeRides === true ? c.forceChargeCeilingPct : null,
  };
}

const shapeOf = (p: NightChargePlan | null): OvernightTextCase['shape'] =>
  (p == null || !p.basisComplete ? 'insufficient_basis' : p.chargeTonight ? 'charge' : 'hold');

/** Every case, in a fixed order. */
export function overnightTextCases(): OvernightTextCase[] {
  const out: OvernightTextCase[] = [];
  const add = (name: string, over: Partial<NightChargeInputDeps>, o: { forceCharge?: boolean; mode?: NightChargeMode; refused?: string | null; advisory?: boolean } = {}) => {
    const p = computeNightChargePlan(buildNightChargeInputs(deps(over)));
    const shape = shapeOf(p);
    const fc = o.forceCharge ?? true;
    const mode = o.mode ?? 'supervised';
    const supervised = shape === 'charge' && !o.advisory && o.refused == null ? armed(p, fc) : null;
    out.push({ name, plan: p, shape, supervised, armRefused: o.refused ?? null, mode });
  };
  add('charge, force-charge riding (10-12)', {});
  add('charge, reserve only (resilience)', { objectiveMode: 'resilience', socNowPct: 30 }, { forceCharge: false });
  add('charge, reserve only, low pool', { objectiveMode: 'resilience', socNowPct: 18 }, { forceCharge: false });
  add('charge, window-bound (toward)', { chargeCapKw: 8, gridInputCapKw: 8 });
  add('charge, window-bound, the cushion short', { chargeCapKw: 5, gridInputCapKw: 5 });
  add('charge, reserve only, the cushion short', { chargeCapKw: 8, gridInputCapKw: 8, socNowPct: 10, objectiveMode: 'resilience' }, { forceCharge: false });
  // v1.196.0 — a resilience night writes its cushion line (32%), not 50%: the case above now charges
  // "to ~32%", and this one keeps a reserve-only "toward" in the golden (a 4 kW grid input).
  add('charge, reserve only, window-bound (toward)', { chargeCapKw: 4, gridInputCapKw: 4, socNowPct: 10, objectiveMode: 'resilience' }, { forceCharge: false });
  add('charge, nothing expected (a reserve hold)', { objectiveMode: 'resilience', socNowPct: 70 }, { forceCharge: false });
  add('charge, cost mode from a full pool', { socNowPct: 85 });
  add('hold, the cushion holds', { objectiveMode: 'resilience', socNowPct: 95 }, { forceCharge: false });
  add('hold, under the minimum buy', { objectiveMode: 'resilience', socNowPct: 60, minBuyKwh: 40 }, { forceCharge: false });
  add('hold, the window cannot cover the cushion', { objectiveMode: 'resilience', socNowPct: 12, chargeCapKw: 0.2, gridInputCapKw: 0.2, minBuyKwh: 5 }, { forceCharge: false });
  add('charge, advisory', {}, { mode: 'advisory', advisory: true });
  add('charge, refused (supervised)', {}, { refused: "a prior night's reserve write is unresolved" });
  add('charge, refused (auto)', {}, { refused: "a prior night's reserve write is unresolved", mode: 'auto' });
  add('charge, refused (a reserve hold)', { objectiveMode: 'resilience', socNowPct: 70 }, { forceCharge: false, refused: 'the reserve reads 0%' });
  out.push({ name: 'no plan', plan: null, shape: 'insufficient_basis', supervised: null, armRefused: null, mode: 'supervised' });
  add('incomplete basis', { socCoherent: false });
  return out;
}

/** The morning summary's inputs (notify.buildNightChargeMorningSummary), one per shape. */
export type SummaryCase = Parameters<typeof import('../../src/notify.js').buildNightChargeMorningSummary>[0];
export function overnightSummaryCases(): Array<{ name: string; input: SummaryCase }> {
  const base = { day: '2026-10-12', targetPct: 50, restorePct: 16 };
  return [
    { name: 'reserve only', input: { ...base, expectedKwh: 27.9, forceCharge: { kind: 'none', expectedLeg: false }, ended: 'window' } },
    { name: 'reserve only, no figure', input: { ...base, expectedKwh: null, forceCharge: null } },
    { name: 'a reserve hold', input: { ...base, expectedKwh: 0.01, forceCharge: { kind: 'none', expectedLeg: false } } },
    { name: 'force-charge ran', input: { ...base, expectedKwh: 34.9, forceCharge: { kind: 'ran', stopPct: 80, expectedLeg: true } } },
    { name: 'force-charge never started', input: { ...base, expectedKwh: 34.9, forceCharge: { kind: 'neverStarted', stopPct: 80, expectedLeg: true } } },
    { name: 'force-charge failed on slot 2', input: { ...base, expectedKwh: 34.9, forceCharge: { kind: 'failed', stopPct: 80, expectedLeg: true, partialSlots: [2] } } },
    { name: 'force-charge failed', input: { ...base, expectedKwh: 34.9, forceCharge: { kind: 'failed', stopPct: 80, expectedLeg: true, partialSlots: null } } },
    { name: 'force-charge unconfirmed', input: { ...base, expectedKwh: 34.9, forceCharge: { kind: 'unconfirmed', stopPct: 80, expectedLeg: true } } },
    { name: 'cancelled after the write', input: { ...base, expectedKwh: 34.9, forceCharge: { kind: 'ran', stopPct: 80, expectedLeg: true }, ended: 'cancelled' } },
    { name: 'grid lost', input: { ...base, expectedKwh: 34.9, forceCharge: null, ended: 'gridLoss' } },
    { name: 'no day', input: { day: null, targetPct: null, restorePct: 16, expectedKwh: null } },
  ];
}

/** The revert-deadline page's inputs (notify.buildNightChargeRevertDeadline and
 *  nightChargeActuator.revertDeadlineSpoken take the same fields). */
export function overnightRevertDeadlineCases(): Array<{
  name: string;
  input: { day: string | null; stage: 'deadline' | 'onPeak'; unknown: boolean; targetPct: number; restorePct: number | null; onPeakClock: string | null; retrying: boolean };
}> {
  const out: ReturnType<typeof overnightRevertDeadlineCases> = [];
  for (const stage of ['deadline', 'onPeak'] as const) {
    for (const unknown of [true, false]) {
      for (const restorePct of [16, null]) {
        for (const onPeakClock of ['4:00 PM', null]) {
          out.push({ name: `${stage}/${unknown ? 'unknown' : 'reads'}/${restorePct ?? 'no prior'}/${onPeakClock ?? 'no on-peak'}`, input: { day: '2026-10-12', stage, unknown, targetPct: 50, restorePct, onPeakClock, retrying: true } });
        }
      }
    }
  }
  return out;
}

/** The missed-apply push's inputs (notify.buildNightChargeMissedApply): a backup and a cost leg, a
 *  window that opens tonight, today and on another day, with and without a reading. Not an overnight
 *  text (the overnight cost leg never sends it), but R5 moved its clocks onto the day-aware
 *  formatter's, so its words are held to the release before it too. */
export type MissedApplyCase = Parameters<typeof import('../../src/notify.js').buildNightChargeMissedApply>[0];
export function missedApplyCases(): Array<{ name: string; input: MissedApplyCase }> {
  const out: Array<{ name: string; input: MissedApplyCase }> = [];
  const windows: Array<[string, 'backup' | 'cost', number, number, number]> = [
    ['backup, Monday 12am (Sunday evening plan)', 'backup', phx(10, 19, 0), phx(10, 19, 5), phx(10, 19, 0, 31)],
    ['backup, tonight 11pm', 'backup', phx(10, 14, 23), phx(10, 15, 5), phx(10, 14, 23, 31)],
    ['cost, today 10am', 'cost', phx(10, 15, 10), phx(10, 15, 15), phx(10, 15, 10, 31)],
    ['cost, another day', 'cost', phx(10, 15, 10), phx(10, 15, 15), phx(10, 14, 23, 50)],
    ['cost, overnight 12am', 'cost', phx(10, 13, 0), phx(10, 13, 5), phx(10, 13, 0, 31)],
  ];
  for (const [name, role, start, end, now] of windows) {
    for (const reservePct of [16, null]) {
      out.push({
        name: `${name}/${reservePct ?? 'no reading'}`,
        input: { day: '2026-10-14', role, windowStartMs: start, windowEndMs: end, reason: 'the panel reading was stale', reservePct, nowMs: now },
      });
    }
  }
  return out;
}
