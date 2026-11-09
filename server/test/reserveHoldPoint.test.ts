import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNightChargeInputs, computeNightChargePlan, lineReserveAskPct, lineNeedsForceCharge, askOf,
  type NightChargeInputDeps, type NightChargePlan, type CushionPoolScale,
} from '../src/nightChargeAdvisor.js';
import { clampReserveTarget, armFromPlan, emptyActuationState, RESERVE_WRITE_MAX_PCT, PANEL_RESERVE_HOLD_UNDERSHOOT_PCT } from '../src/nightChargeActuator.js';
import { realizedCushionBreach } from '../src/nightChargeGate.js';
import { lineOverReserveText } from '../src/nightForceCharge.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';

/**
 * ★★★ v1.203.0 — THE POINT THE PANEL HOLDS UNDER A RESERVE IT CHARGED UP TO (owner decision, 2026-11-08).
 *
 * The house panel holds the pool one point UNDER a backup reserve it charged the pool up to: all 11 reserve-only charge-ups to a
 * 50% reserve from 2026-08-31 to 2026-09-17 closed at 49 (fixtures/panelReserveHold0904.json keeps one whole). A night written at
 * its outage line's whole percent therefore held ⌈line⌉ − 1, under the line it was sized on, and the scorer struck it. On every
 * plan whose line the reserve write holds (the overnight leg's pack-at-close test on the islanded-outage basis) the write is the
 * line's whole percent and one point more (lineReserveAskPct, PANEL_RESERVE_HOLD_UNDERSHOOT_PCT = 1); a line whose ⌈line⌉ + 1 is
 * above the 50% the panel accepts as a reserve — a line in (49, 50] included — is the line force-charge's (lineNeedsForceCharge).
 *
 * Here: the trace, the rule, the grade, and the year — on four scales, with and without the Cores' standby, at 4-16 h of cushion,
 * in a write mode and in advisory mode — each plan against the same plan with no hold point (computeNightChargePlan(inputs, 0),
 * v1.202.0's): what moves is the write (and the expected figures it drives) of a line night the reserve holds, by exactly the
 * point, and a line in (49, 50] that is now carried or disclosed; nothing sized moves, no write falls, and the pool the panel
 * holds under every such write holds the line and the whole cushion on the planning pool.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACE = JSON.parse(readFileSync(resolve(HERE, 'fixtures/panelReserveHold0904.json'), 'utf8')) as {
  date: string;
  reserve: Array<[string, number]>;
  pool: Array<[string, number]>;
  slots: Record<string, Array<[string, number]>>;
  during: Array<[string, number, number, number]>;
};
const minuteOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
/** A change-point series read at minute `m`: the last change at or before it. */
const at = (series: Array<[string, number]>, m: number): number | null => {
  let v: number | null = null;
  for (const [t, x] of series) if (minuteOf(t) <= m) v = x;
  return v;
};

test('★★★ THE TRACE (2026-09-04): the panel charged the pool to the 50% reserve and held it one point under it, at 49, until the restore — the pool and every slot', () => {
  const R = at(TRACE.reserve, minuteOf('08:00'))!;
  assert.equal(R, RESERVE_WRITE_MAX_PCT);
  const reached = TRACE.pool.find(([, v]) => v >= R)!;
  assert.deepEqual(reached, ['08:09', 50], 'the pool reached the reserve');
  const restore = minuteOf(TRACE.reserve.find(([, v]) => v < R)![0]);
  assert.equal(restore, minuteOf('12:06'));
  // Every minute from the one after it reached the reserve to the restore: one point under it.
  for (let m = minuteOf(reached[0]) + 1; m < restore; m++) {
    assert.equal(at(TRACE.pool, m), R - PANEL_RESERVE_HOLD_UNDERSHOOT_PCT, `pool at minute ${m}`);
  }
  for (const [slot, series] of Object.entries(TRACE.slots) as Array<[string, Array<[string, number]>]>) {
    const up: [string, number] = series.find(([, v]) => v >= R)!;
    for (let m: number = minuteOf(up[0]) + 1; m < restore; m++) assert.equal(at(series, m), R - PANEL_RESERVE_HOLD_UNDERSHOOT_PCT, `slot ${slot} at minute ${m}`);
  }
  // While it held, the slots took nothing and the house ran on the grid: the hold is the panel's, not a drain.
  for (const [t, grid, load, slotW] of TRACE.during) {
    assert.ok(minuteOf(t) > minuteOf(reached[0]) && minuteOf(t) < restore, t);
    assert.equal(slotW, 0, `${t}: the slots at 0 W`);
    assert.ok(Math.abs(grid - load) <= 5, `${t}: the house on the grid (${grid} W against ${load} W)`);
  }
  assert.equal(PANEL_RESERVE_HOLD_UNDERSHOOT_PCT, R - at(TRACE.pool, restore - 1)!, 'the constant is the trace\'s');
});

test('★★★ THE RULE: a line the reserve holds is written ⌈line⌉ + 1, so the pool the panel holds is ⌈line⌉; a line whose ⌈line⌉ + 1 is above 50 — one in (49, 50] included — is the line force-charge\'s', () => {
  const F = 100;
  // A line of 27.94% (the critic's 10-31 night: L 1.75 kW): ⌈line⌉ 28, written 29, held 28 ≥ 27.94.
  assert.equal(lineReserveAskPct(27.94, F), 29);
  assert.equal(lineReserveAskPct(27.94, F, 0), 28, 'v1.202.0: 28, held at 27 under the line');
  // A whole-percent line is its own whole percent, and one more.
  assert.equal(lineReserveAskPct(30, F), 31);
  // The envelope: ⌈line⌉ + 1 at most 50 is written; above it the ask stays ⌈line⌉ and the line force-charge carries it.
  assert.equal(lineReserveAskPct(48.5, F), 50);
  assert.equal(lineReserveAskPct(49.5, F), 50);
  assert.equal(lineReserveAskPct(55.2, F), 56);
  for (const [line, needs] of [[48.5, false], [49, false], [49.01, true], [49.97, true], [50, true], [50.03, true], [55.2, true]] as const) {
    assert.equal(lineNeedsForceCharge(askOf(line, F)), needs, `${line}%`);
    assert.equal(lineNeedsForceCharge(askOf(line, F), 0), askOf(line, F) > 50, `${line}%: v1.202.0's test`);
  }
  // The words: a line at or under 50 is above the 49% the panel holds, never "above the 50% reserve".
  assert.equal(lineOverReserveText(49.97, 'reserve'), 'the 49% the panel holds the pool at under a 50% reserve');
  assert.equal(lineOverReserveText(50.03, 'reserve'), 'the 50% reserve', 'a line above 50: the words before');
});

test('★★★ THE GRADE: at the pool the panel holds, a ⌈line⌉ write is a realized strike and a ⌈line⌉ + 1 write is not', () => {
  for (const line of [27.2, 27.94, 28.4, 31.13, 33.26, 46.59]) {
    const row = (close: number) => ({ reserve_floor_pct: 16, cushion_pct: 15, cushion_line_soc_pct: line, actual_min_soc_pct: close, window_close_soc_pct: close });
    const held = (written: number) => written - PANEL_RESERVE_HOLD_UNDERSHOOT_PCT;
    assert.equal(realizedCushionBreach(row(held(Math.ceil(line)))), 1, `${line}%: v1.202.0's write held under it`);
    assert.equal(realizedCushionBreach(row(held(lineReserveAskPct(line, 100)))), 0, `${line}%: the write held at it`);
  }
});

type Plan = NightChargePlan & { forceChargeLine?: { askPct: number; linePct: number }; cushionEnvelopeReason?: string; cushionShortfallCause?: string };
const SIZED = ['chargeTonight', 'buyKwh', 'buyKwhDebiased', 'requiredExtraKwh', 'targetSocPct', 'cushionLineSocPct', 'cushionTroughSocPct',
  'minProjSocPct', 'baselineMinSocPct', 'costCeilingSocPct', 'bindingCap', 'cushionKwh', 'objective'] as const;
const SCALES: Array<[string, CushionPoolScale | null]> = [['np', null], ['m', { scale: 0.944, basis: 'measured' }], ['held', { scale: 0.92, basis: 'held' }], ['mk', { scale: 0.9, basis: 'min-known' }]];
const costGate = (d: NightChargeInputDeps): boolean => d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50;

/** The year swept, each plan against the same plan with no hold point. */
function sweep() {
  const out = { plans: 0, moved: 0, plus1: 0, askNamed: 0, band: 0, bandCarried: 0, bandDisclosed: 0, cost: 0, held: 0, guarantee: 0, worst: Infinity, ex: [] as string[] };
  for (const c of legacyIdentityCases()) {
    for (const [sn, sc] of SCALES) for (const w of [0, 270]) for (const h of [4, 8, 12, 16]) for (const mode of ['write', 'advisory'] as const) {
      const deps = {
        ...c.deps, outageCushionHours: h, cushionStandbyW: w, ...(sc != null ? { cushionPoolScale: sc } : {}),
        lineForceChargeEligible: mode === 'write', forceChargeEligible: mode === 'write' && costGate(c.deps),
      } as NightChargeInputDeps;
      const inputs = buildNightChargeInputs(deps);
      const p1 = computeNightChargePlan(inputs) as Plan;
      const p0 = computeNightChargePlan(inputs, 0) as Plan;
      out.plans += 1;
      const at_ = `${c.label} ${sn} ${w} W ${h} h ${mode}`;
      for (const k of SIZED) assert.deepEqual(p1[k] ?? null, p0[k] ?? null, `${at_}: ${k} is sized, and the point sizes nothing`);
      const w0 = p0.chargeTonight && p0.setpointSocPct != null ? clampReserveTarget(p0.setpointSocPct) : null;
      const w1 = p1.chargeTonight && p1.setpointSocPct != null ? clampReserveTarget(p1.setpointSocPct) : null;
      if (w0 != null) assert.ok(w1 != null && w1 >= w0, `${at_}: a write fell ${w0} → ${w1}`);
      if (JSON.stringify(p1) === JSON.stringify(p0)) continue;
      out.moved += 1;
      const line = p0.cushionLineSocPct!;
      assert.equal(p0.cushionBasis, 'islanded-outage', `${at_}: only the outage line moves`);
      if (p1.setpointSocPct !== p0.setpointSocPct) {
        // THE +1: the write of a line the reserve holds, one point above the line's whole percent, at most 50.
        out.plus1 += 1;
        if (p0.objective === 'cost_arbitrage') out.cost += 1;
        assert.ok(Number.isInteger(p1.setpointSocPct) && p1.setpointSocPct! <= RESERVE_WRITE_MAX_PCT, `${at_}: ${p1.setpointSocPct}`);
        assert.ok(p1.setpointSocPct! - 1 >= line - 0.005 && p1.setpointSocPct! - 2 < line + 0.01, `${at_}: ⌈${line}⌉ + 1 = ${p1.setpointSocPct}`);
        assert.ok(p1.setpointSocPct! > p0.setpointSocPct!, `${at_}`);
        assert.equal(p1.forceChargeLine ?? null, p0.forceChargeLine ?? null, `${at_}: no line force-charge moves with the point`);
      } else if ((p1.forceChargeLine ?? null) === null && (p1.cushionShortfallCause ?? null) === (p0.cushionShortfallCause ?? null)) {
        // The same write, named for the point: a cost target equal to ⌈line⌉ + 1 is now the resilience requirement's own write.
        out.askNamed += 1;
        const diff = Object.keys({ ...p0, ...p1 }).filter((k) => JSON.stringify((p0 as never)[k]) !== JSON.stringify((p1 as never)[k]));
        assert.deepEqual(diff, ['rationale'], `${at_}`);
        assert.equal(p1.rationale.replace(/ \(the resilience requirement: one point above the [\d.]+% outage line's whole percent, since the panel holds the pool one point under a reserve it charges up to\)/, " (tonight's cost target)"), p0.rationale, `${at_}`);
      } else {
        // A LINE IN (49, 50]: its 50% reserve holds 49, so the line force-charge carries it (a write mode) or it is disclosed.
        out.band += 1;
        assert.ok(line > 49 - 0.005 && line <= 50 + 0.005, `${at_}: a band line ${line}`);
        assert.equal(w1, RESERVE_WRITE_MAX_PCT, `${at_}: the write is the 50% maximum`);
        if (mode === 'write') {
          out.bandCarried += 1;
          assert.equal(p1.forceChargeLine?.askPct, RESERVE_WRITE_MAX_PCT + 1, `${at_}: asked one point above the reserve`);
        } else {
          out.bandDisclosed += 1;
          // (envelope+caps where the sizing fell short too: its caps note stands beside it.)
          assert.deepEqual([p1.cushionShortfallCause, p1.cushionEnvelopeReason, p1.forceChargeLine ?? null],
            [p0.cushionShortfall ? 'envelope+caps' : 'envelope', 'advisory', null], `${at_}`);
        }
        assert.doesNotMatch(p1.rationale, /outage line is above it\b/, `${at_}: never "above it" of the 50% reserve`);
      }
      // THE GUARANTEE at the pool the panel holds: written under the envelope with no shortfall, (written − 1 − floor)% of the
      // planning pool holds the whole cushion.
      if (p1.chargeTonight && !p1.cushionShortfall && w1 != null && w1 - 1 >= line - 0.005 && p1.setpointSocPct! <= RESERVE_WRITE_MAX_PCT) {
        out.held += 1;
        const pool = p1.planPool?.kwh ?? deps.fullKwh;
        const heldKwh = ((w1 - PANEL_RESERVE_HOLD_UNDERSHOOT_PCT - p1.reserveFloorPct) / 100) * pool;
        out.worst = Math.min(out.worst, heldKwh - p1.cushionKwh!);
        if (heldKwh + 0.01 >= p1.cushionKwh!) out.guarantee += 1;
        else if (out.ex.length < 5) out.ex.push(`${at_}: holds ${heldKwh.toFixed(2)} of ${p1.cushionKwh} kWh`);
      }
    }
  }
  return out;
}

test('★★★ THE YEAR on four scales, 0 and 270 W, 4-16 h, write and advisory: the point moves only a line night\'s write (and what follows it), never a sized figure; no write falls; the pool held under every such write holds the cushion (counts as measured)', () => {
  const s = sweep();
  assert.deepEqual(s.ex, []);
  assert.equal(s.guarantee, s.held, 'every reserve-held line night holds its whole cushion at the pool the panel holds');
  assert.ok(s.worst >= -0.01, `worst margin ${s.worst}`);
  // Measured when the change was made (the lane's accounting lists every night).
  assert.deepEqual({ plans: s.plans, moved: s.moved, plus1: s.plus1, cost: s.cost, askNamed: s.askNamed, band: s.band, bandCarried: s.bandCarried, bandDisclosed: s.bandDisclosed, held: s.held },
    PIN_YEAR);
});

/** Measured on the change: 70,656 plans; 7,840 move — 7,044 by the point (394 of them cost nights whose cost target sat within a
 *  point of the line), 12 that keep their write and name it the resilience requirement's (a cost target equal to ⌈line⌉ + 1), and
 *  784 lines in (49, 50] (392 carried by the line force-charge in a write mode, 392 disclosed in advisory mode). 6,141 charge nights
 *  held by the reserve hold their whole cushion at the pool the panel holds (the worst by −0.0006 kWh, the cushion's rounding). */
const PIN_YEAR = { plans: 70656, moved: 7840, plus1: 7044, cost: 394, askNamed: 12, band: 784, bandCarried: 392, bandDisclosed: 392, held: 6141 };

test('★★ the armed record carries the point: the reserve armFromPlan writes is ⌈line⌉ + 1 (the live-shaped resilience night: 33 for the 31.13% line)', () => {
  const c = legacyIdentityCases().find((x) => x.label === '2026-10-12 resilience')!;
  const p = computeNightChargePlan(buildNightChargeInputs({ ...c.deps, lineForceChargeEligible: true } as NightChargeInputDeps));
  assert.equal(p.cushionLineSocPct, 31.13);
  const a = armFromPlan(emptyActuationState(), '2026-10-12', p, c.deps.nowMs, c.deps.reserveFloorPct, false, null, true);
  assert.equal(a?.targetPct, 33);
  assert.equal(a?.forceChargeLineAskPct, null, 'no line force-charge under 50');
});
