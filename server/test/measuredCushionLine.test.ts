import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNightChargePlan, buildNightChargeInputs, cushionLineKwh, cushionPoolScaleLedgerColumns, cushionScaleLogText,
  chargeReservePct, floorCushionLinePct, middayReentryLinePct, CUSHION_SCALE_PLAUSIBLE_MIN,
  type NightChargeInputs, type NightChargePlan, type CushionPoolScale,
} from '../src/nightChargeAdvisor.js';
import { armFromPlan, clampReserveTarget, emptyActuationState, RESERVE_WRITE_MAX_PCT } from '../src/nightChargeActuator.js';
import { PoolEnergyBasisTracker, CAPACITY_SCALE_MIN } from '../src/poolEnergyBasis.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Shp2Projection } from '../src/ecoflow/project.js';
import { legacyIdentityCases, planDigest } from './fixtures/legacyIdentityFixtures.js';
import { FIGURE_FIELDS, figuresOf, measuredFigures, MEASURED_SCALE, type Figures } from './fixtures/measuredCushionLineFigures.js';

/**
 * v1.199.0 — THE OUTAGE CUSHION'S LINE HOLDS THE WHOLE CUSHION ON THE PACKS' MEASURED CAPACITY.
 *
 * Since v1.196.0 a resilience night writes the backup reserve at the cushion line, ⌈floor + cushion⌉,
 * with the cushion's energy converted to a percent on the panel's NAMEPLATE pool. The panel's reserve
 * percent is a share of the packs' MEASURED (BMS full-charge) capacity, ~0.944 of nameplate on the
 * reference fleet, so the written line held only ~0.944 of the cushion above the floor: on the
 * scenario below (92.16 kWh, a 10% floor, an 18.85 kWh cushion) the 30.45% line, written 31%, holds
 * 21% × 86.999 = 18.27 kWh, 96.9% of the cushion — about 7.75 of the 8 configured hours of
 * load at the scenario's own drain, before the Cores' standby, which the cushion leaves out.
 *
 * The fix (nightChargeAdvisor.ts cushionLineKwh): on the islanded-outage basis the line is
 * floor + 100 · cushion ÷ (pool · scale), the scale the house pool's measured capacity scale
 * (index.ts measuredCushionScale). Here: 31.67%, written 32%, holding 22% × 86.999 = 19.14 kWh.
 *
 * These tests pin, in this order: the defect fixed on the scenario, worked by hand; the guarantee
 * (property, and on every islanded charge night of the year) and its limit (a scale that is high);
 * the fail-safe (absent / implausible ⇒ today's line exactly, a lower scale never lowers anything
 * below the nameplate plan); the scope of the conversion (legacy-pct, disabled, the cost formula);
 * that every consumer agrees with the one line; the legs; the plumbing; the year against the golden
 * at 0.944 (direction, counts and the per-case figures); the explicit-nameplate digests; the ledger
 * and log helpers; the tracker file.
 */

const H = 3_600_000;
const B = Date.UTC(2026, 9, 20, 4); // 21:00 MST, 2026-10-19
const horizon = (loadP90W: number) =>
  Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W, loadP50W: loadP90W / 1.35, pvP50W: 0 }));
/** setpointOneTest.test.ts's scenario: a 92.16 kWh pool, a 10% floor, 1.445 kW × 8 h × 1.5 ÷ 0.92 =
 *  18.85 kWh of cushion, 25% at 21:00, a 23:00–05:00 window, a 3.6 kW P90 house and no sun. */
const inputs = (o: Partial<NightChargeInputs> = {}): NightChargeInputs => ({
  nowMs: B, fullKwh: 92.16, socNowPct: 25, reserveFloorPct: 10, cushionPct: 15, socCoherent: true,
  islandedLoadKw: 1.445, outageCushionHours: 8, islandedLoadSafety: 1.5,
  legEff: 0.927, dischargeEff: 0.92, chargeCapKw: 10, gridInputCapKw: null,
  window: { startMs: B + 2 * H, endMs: B + 8 * H }, horizon: horizon(3600),
  morningPvSurplusP90Kwh: null, confidenceTier: 'forecast', basisComplete: true, minBuyKwh: 1,
  objectiveMode: 'resilience',
  ...o,
});
const plan = (o: Partial<NightChargeInputs> = {}): NightChargePlan => computeNightChargePlan(inputs(o));
const S944: CushionPoolScale = { scale: 0.944, basis: 'measured' };
const MEASURED_KWH = 92.16 * 0.944; // 86.99904
const COST55 = { objectiveMode: 'cost', costMaxSocPct: 90, morningPvSurplusP50Kwh: 55, morningPvSurplusP90Kwh: 70, forceChargeEligible: true } as const;
const written = (p: NightChargePlan): number | null => (p.setpointSocPct != null ? clampReserveTarget(p.setpointSocPct) : null);
/** A plan's digest without its cushionPoolScale key: what the plan says apart from the scale. */
const digestWithoutScale = (p: NightChargePlan): string => {
  const { cushionPoolScale: _s, ...rest } = p;
  return planDigest(rest as NightChargePlan);
};
const yearPlan = (deps: Parameters<typeof buildNightChargeInputs>[0], scale?: CushionPoolScale | null): NightChargePlan =>
  computeNightChargePlan(buildNightChargeInputs(scale === undefined ? deps : { ...deps, cushionPoolScale: scale }));

/* ══ the defect, fixed ════════════════════════════════════════════════════════ */

test('★★★ THE DEFECT FIXED: the 30.45% nameplate line (written 31, 18.27 kWh held) becomes 31.67% (written 32, 19.14 kWh ≥ 18.85)', () => {
  // Without a scale: today's plan, the shortfall the owner asked to fix.
  const before = plan();
  assert.equal(before.cushionKwh, 18.85);
  assert.equal(before.cushionLineSocPct, 30.45);
  assert.equal(written(before), 31);
  const heldBefore = ((31 - 10) / 100) * MEASURED_KWH;
  assert.ok(Math.abs(heldBefore - 18.27) < 0.005 && heldBefore < 18.85, `held ${heldBefore}`);
  // In hours of the scenario's own drain, 1.445 kW × 1.5 ÷ 0.92 = 2.356 kW: 7.75 of the 8 configured.
  const drainKw = (1.445 * 1.5) / 0.92;
  assert.equal(before.cushionOutageHours, 8);
  assert.equal(Math.round((heldBefore / drainKw) * 100) / 100, 7.75);

  const p = plan({ cushionPoolScale: S944 });
  // The line by hand: 10 + 100 × 18.85 ÷ (92.16 × 0.944) = 10 + 1885 ÷ 86.99904 = 31.6669%.
  assert.equal(p.cushionLineSocPct, 31.67);
  assert.equal(p.cushionKwh, 18.85, 'the cushion is still real energy, unchanged');
  assert.equal(p.cushionBasis, 'islanded-outage');
  assert.deepEqual(p.cushionPoolScale, { scale: 0.944, basis: 'measured' });
  // The write: the measured line asked to the whole percent above it.
  assert.equal(p.setpointSocPct, 32);
  assert.equal(chargeReservePct(p), 32);
  assert.equal(armFromPlan(emptyActuationState(), '2026-10-19', p, B, 10)!.targetPct, 32, 'the reserve the actuator arms');
  const held = ((32 - 10) / 100) * MEASURED_KWH; // 19.14 kWh
  assert.ok(Math.abs(held - 19.14) < 0.005 && held >= 18.85, `held ${held}`);
  assert.equal(Math.round((held / drainKw) * 100) / 100, 8.12, 'the whole 8 h, and the write\'s rounding');
  // The plan agrees with the write: sized to the measured line, reaching it, no shortfall.
  assert.equal(p.targetSocPct, 31.7);
  assert.equal(p.cushionTroughSocPct, 31.67);
  assert.equal(p.cushionShortfall, false);
  assert.equal(p.bindingCap, 'requirement');
  // The lift that reaches the higher line: 0.78 kWh more of pack (not the 1.12 kWh of line — each
  // extra charging hour rides the grid bypass instead of draining the pack), 0.85 kWh more at the meter.
  assert.equal(before.requiredExtraKwh, 25.55);
  assert.equal(p.requiredExtraKwh, 26.33);
  assert.equal(before.buyKwh, 27.56);
  assert.equal(p.buyKwh, 28.41);
  assert.equal(p.expectedWriteLevelPct, 32);
  assert.equal(p.expectedBuyKwh, 13.21, 'the expected draw to 32% (12.22 kWh to 31%)');
  // Every surface's line is the measured one.
  assert.equal(floorCushionLinePct(p), 31.67);
  assert.match(p.rationale, / The reserve is set to 32% \(the resilience requirement\)\. /);
  assert.match(p.rationale, /the 10% reserve floor plus 8 h of islanded backup load \(18\.9 kWh, 21\.7% of the packs' measured capacity at ×0\.944 of nameplate\)/);
  assert.doesNotMatch(p.rationale, /asks for|only accepts|residual risk/);
});

test('★★★ the line is the cushion on the measured capacity — the floor is not divided (32.26% would be the whole line ÷ 0.944)', () => {
  const l = cushionLineKwh({ reserveKwh: 9.216, cushionKwh: 18.85, cushionBasis: 'islanded-outage', poolScale: S944 });
  assert.ok(Math.abs(l.kwh - (9.216 + 18.85 / 0.944)) < 1e-12, `${l.kwh}`);
  assert.ok(Math.abs((l.kwh / 92.16) * 100 - 31.6669) < 1e-4);
  assert.ok(Math.abs(((9.216 + 18.85) / 0.944 / 92.16) * 100 - 32.26) < 0.01, 'the mutant this rules out');
  assert.deepEqual(l.applied, { scale: 0.944, basis: 'measured' });
  // The basis is echoed, whatever it was.
  for (const basis of ['measured', 'held', 'min-known', 'nameplate'] as const) {
    assert.deepEqual(cushionLineKwh({ reserveKwh: 1, cushionKwh: 2, cushionBasis: 'islanded-outage', poolScale: { scale: 0.9, basis } }).applied, { scale: 0.9, basis });
  }
});

/* ══ the guarantee ════════════════════════════════════════════════════════════ */

test('★★★ THE GUARANTEE (property): wherever the write is under the 50% envelope, (written − floor)% of the measured capacity ≥ the cushion', () => {
  // ⌈L⌉ − f ≥ L − f = 100 · cushion ÷ (N · s), so (⌈L⌉ − f)/100 · N · s ≥ cushion. A line above 50%
  // is truncated by the panel's envelope (clampReserveTarget) and disclosed in the rationale ("the
  // panel only accepts a backup reserve up to 50%"): that write cannot hold the line, and is excluded.
  let checked = 0;
  let truncated = 0;
  for (const N of [30.72, 61.44, 92.16, 122.88]) {
    for (let floor = 10; floor <= 30; floor += 4) {
      for (let cushion = 0.25; cushion <= 40; cushion += 0.85) {
        for (let k = 0; k <= 100; k++) {
          const s = 0.5 + k * 0.005;
          const reserveKwh = (N * floor) / 100;
          const line = cushionLineKwh({ reserveKwh, cushionKwh: cushion, cushionBasis: 'islanded-outage', poolScale: { scale: s, basis: 'measured' } });
          const linePct = (line.kwh / N) * 100;
          const w = clampReserveTarget(Math.min(100, Math.ceil(linePct - 1e-9))); // the planner's lineAskPct, written
          if (w >= RESERVE_WRITE_MAX_PCT && linePct > RESERVE_WRITE_MAX_PCT) { truncated += 1; continue; }
          const held = ((w - floor) / 100) * N * s;
          assert.ok(held >= cushion - 1e-9, `N ${N} floor ${floor} cushion ${cushion} s ${s}: line ${linePct} written ${w} holds ${held}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 40_000 && truncated > 10_000, `${checked} checked, ${truncated} over the envelope`);
});

test('★★★ THE GUARANTEE on the year: every islanded charge night written under 50% holds its cushion on the measured capacity (114 of 175 did not before)', () => {
  let held = 0, heldBefore = 0, n = 0;
  for (const c of legacyIdentityCases()) {
    const p = yearPlan(c.deps, MEASURED_SCALE);
    if (p.cushionBasis !== 'islanded-outage' || !p.chargeTonight || written(p)! >= RESERVE_WRITE_MAX_PCT) continue;
    n += 1;
    const atScale = ((written(p)! - p.reserveFloorPct) / 100) * c.deps.fullKwh * MEASURED_SCALE.scale;
    assert.ok(atScale >= p.cushionKwh! - 1e-9, `${c.label}: written ${written(p)} holds ${atScale} of ${p.cushionKwh}`);
    held += 1;
    const b = yearPlan(c.deps);
    if (((written(b)! - b.reserveFloorPct) / 100) * c.deps.fullKwh * MEASURED_SCALE.scale >= b.cushionKwh! - 1e-9) heldBefore += 1;
  }
  assert.deepEqual({ n, held, heldBefore }, { n: 175, held: 175, heldBefore: 61 });
});

test('★★ THE GUARANTEE\'S LIMIT — it holds on the capacity the scale states: a held ratio after an unseen drop, or packs under CAPACITY_SCALE_MIN, hold less than the cushion', () => {
  // (1) A held ratio. Measured at 0.944, then Core A goes cloud-dark while the panel still lists it
  // as connected, and its packs fall to 0.85 unseen: the tracker holds its last ratio.
  const t = new PoolEnergyBasisTracker({ path: null });
  const m = fleet(0.944);
  t.evaluate(m.devs, m.panel, B);
  const drop = fleet(0.944);
  drop.devs['CORE-A'] = { ...fleet(0.85).devs['CORE-A'], online: false } as DeviceSnapshot;
  const h = t.evaluate(drop.devs, drop.panel, B + H);
  assert.equal(h.capacityBasis, 'held');
  assert.ok(Math.abs(h.capacityScale - 0.944) < 1e-12, `${h.capacityScale}`);
  const ph = plan({ cushionPoolScale: { scale: h.capacityScale, basis: h.capacityBasis } });
  assert.deepEqual([ph.cushionLineSocPct, written(ph)], [31.67, 32]);
  // The capacity the panel's percent is a share of: (0.85 + 0.944 + 0.944) ÷ 3 = 0.91267 of nameplate,
  // 84.111 kWh. 22% of it is 18.50 kWh, under the 18.85 kWh cushion.
  const trueHeld = ((32 - 10) / 100) * 92.16 * ((0.85 + 2 * 0.944) / 3);
  assert.ok(Math.abs(trueHeld - 18.50) < 0.005 && trueHeld < 18.85, `${trueHeld}`);
  // (2) Packs under the clamp. At 0.75 of nameplate the tracker counts them at CAPACITY_SCALE_MIN.
  assert.equal(CAPACITY_SCALE_MIN, 0.8, 'CAPACITY_SCALE_MIN is unset in the suite');
  const low = fleet(0.75);
  const l = new PoolEnergyBasisTracker({ path: null }).evaluate(low.devs, low.panel, B);
  assert.deepEqual([l.capacityBasis, l.capacityScale], ['measured', 0.8]);
  const pl = plan({ cushionPoolScale: { scale: l.capacityScale, basis: l.capacityBasis } });
  // 10 + 1885 ÷ (92.16 × 0.8) = 10 + 1885 ÷ 73.728 = 35.567%, written 36; 26% × 69.12 = 17.97 kWh.
  assert.deepEqual([pl.cushionLineSocPct, written(pl)], [35.57, 36]);
  const trueLow = ((36 - 10) / 100) * 92.16 * 0.75;
  assert.ok(Math.abs(trueLow - 17.97) < 0.005 && trueLow < 18.85, `${trueLow}`);
  // At the clamp itself the write holds the cushion: the guarantee is exact from CAPACITY_SCALE_MIN up.
  assert.ok(((36 - 10) / 100) * 92.16 * 0.8 >= 18.85);
  // Chapter 15 part 1 states the limit with these figures, not a guarantee on every basis.
  const ch = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/reference/15-1-night-charge-planning.md'), 'utf8');
  const bullet = ch.split('\n').find((x) => x.startsWith('- **The guarantee and its limit.**'));
  assert.ok(bullet, 'chapter 15 part 1\'s guarantee bullet');
  assert.doesNotMatch(bullet, /conservatively/, 'a held or lowest-known ratio is not conservative');
  assert.match(bullet, /exact on a `measured` basis at or above `CAPACITY_SCALE_MIN`/);
  assert.match(bullet, /22% × 84\.11 = 18\.50 kWh/);
  assert.match(bullet, /26% × 69\.12 = 17\.97 kWh/);
});

/* ══ the fail-safe ════════════════════════════════════════════════════════════ */

test('★★★ FAIL-SAFE — no scale (undefined, null) is today\'s plan byte for byte, with no new key', () => {
  const base = plan();
  assert.equal('cushionPoolScale' in base, false);
  for (const s of [undefined, null]) {
    const p = plan({ cushionPoolScale: s });
    assert.equal(planDigest(p), planDigest(base));
    assert.equal('cushionPoolScale' in p, false);
  }
});

test('★★★ FAIL-SAFE — an implausible scale is ignored: today\'s numbers and text, recorded as basis \'implausible\'', () => {
  const base = plan();
  for (const s of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 0.3, CUSHION_SCALE_PLAUSIBLE_MIN - 1e-6, 1.2, 1 + 1e-8]) {
    const p = plan({ cushionPoolScale: { scale: s, basis: 'measured' } });
    assert.deepEqual(p.cushionPoolScale, { scale: 1, basis: 'implausible' }, `scale ${s}`);
    assert.equal(digestWithoutScale(p), planDigest(base), `scale ${s}: the plan moved`);
  }
  // A non-number is no reading either.
  const junk = plan({ cushionPoolScale: { scale: '0.9' as unknown as number, basis: 'measured' } });
  assert.deepEqual(junk.cushionPoolScale, { scale: 1, basis: 'implausible' });
  assert.equal(CUSHION_SCALE_PLAUSIBLE_MIN, 0.5, "CAPACITY_SCALE_MIN's own lower clamp");
});

test('★★★ FAIL-SAFE — scale 1 (and float noise above it) moves no number and no word; 0.5 is accepted', () => {
  const base = plan();
  for (const [s, echo] of [[1, 1], [1 + 1e-10, 1]] as const) {
    const p = plan({ cushionPoolScale: { scale: s, basis: 'measured' } });
    assert.deepEqual(p.cushionPoolScale, { scale: echo, basis: 'measured' });
    assert.equal(digestWithoutScale(p), planDigest(base));
  }
  const half = plan({ cushionPoolScale: { scale: 0.5, basis: 'min-known' } });
  assert.deepEqual(half.cushionPoolScale, { scale: 0.5, basis: 'min-known' });
  assert.equal(half.cushionLineSocPct, 50.91, '10 + 1885 ÷ 46.08');
  assert.equal(written(half), RESERVE_WRITE_MAX_PCT);
  assert.match(half.rationale, /asks for 51%, but the panel only accepts a backup reserve up to 50%/);
});

test('★★★ FAIL-SAFE — on the year, at every scale down to 0.5 nothing falls below the nameplate plan; line, setpoint, write, requirement, buy and cost ceiling are monotone in the scale', () => {
  // The expected buy and level are NOT monotone between adjacent scales (a higher write can start the
  // just-in-time force-charge earlier from a level that draws less: 2027-08-09 13:00, 3.38 → 3.32 kWh
  // from 0.82 to 0.80), so they are held only against the s = 1 plan, which no scale goes under.
  const SCALES = [0.99, 0.97, 0.944, 0.92, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5];
  const atLeast = ['cushionLineSocPct', 'setpointSocPct', 'buyKwh', 'buyKwhDebiased', 'requiredExtraKwh', 'expectedBuyKwh',
    'expectedWriteLevelPct', 'costCeilingSocPct', 'targetSocPct'] as const;
  const monotone = ['cushionLineSocPct', 'setpointSocPct', 'requiredExtraKwh', 'buyKwh', 'costCeilingSocPct'] as const;
  for (const c of legacyIdentityCases()) {
    const one = yearPlan(c.deps);
    let prev = one;
    for (const s of SCALES) {
      const p = yearPlan(c.deps, { scale: s, basis: 'measured' });
      const holdToCharge = !one.chargeTonight && p.chargeTonight;
      for (const f of atLeast) {
        const a = one[f] as number | null | undefined, b = p[f] as number | null | undefined;
        // A figure only a charge night states (the write level) appears where a hold becomes a charge.
        if (a == null) { if (!holdToCharge) assert.equal(b ?? null, null, `${c.label} s ${s}: ${f} appeared`); continue; }
        assert.ok(b != null && b >= a - 1e-9, `${c.label} s ${s}: ${f} ${a} → ${b}`);
      }
      for (const f of monotone) {
        const a = prev[f] as number | null | undefined, b = p[f] as number | null | undefined;
        if (a != null) assert.ok(b != null && b >= a - 1e-9, `${c.label} s ${s}: ${f} fell ${a} → ${b} as the scale fell`);
      }
      const wa = written(prev), wb = written(p);
      if (prev.chargeTonight && p.chargeTonight && wa != null) assert.ok(wb! >= wa, `${c.label} s ${s}: write ${wa} → ${wb}`);
      assert.ok(!(one.chargeTonight && !p.chargeTonight), `${c.label} s ${s}: a charge night became a hold`);
      assert.ok(!(one.cushionShortfall && !p.cushionShortfall), `${c.label} s ${s}: a disclosed shortfall vanished`);
      prev = p;
    }
  }
});

/* ══ the scope of the conversion ══════════════════════════════════════════════ */

test('★★★ SCOPE — the legacy band and a disabled cushion do not move at any scale, and carry no scale', () => {
  for (const o of [{ islandedLoadKw: null }, { outageCushionHours: 0 }] as const) {
    const base = plan(o);
    for (const s of [0.944, 0.5]) {
      const p = plan({ ...o, cushionPoolScale: { scale: s, basis: 'measured' } });
      assert.equal(planDigest(p), planDigest(base), `${JSON.stringify(o)} at ${s}`);
      assert.equal('cushionPoolScale' in p, false);
    }
  }
  assert.equal(cushionLineKwh({ reserveKwh: 9.216, cushionKwh: 13.82, cushionBasis: 'legacy-pct', poolScale: S944 }).kwh, 9.216 + 13.82);
  assert.deepEqual(cushionLineKwh({ reserveKwh: 9.216, cushionKwh: 0, cushionBasis: 'disabled', poolScale: S944 }), { kwh: 9.216, applied: null });
});

test('★★★ SCOPE — the cost formula is untouched: a cost target above the line is written as before (COST55: 40.3%, written 40)', () => {
  const base = plan(COST55);
  const p = plan({ ...COST55, cushionPoolScale: S944 });
  assert.equal(p.costCeilingSocPct, 40.3);
  assert.equal(p.setpointSocPct, 40.3);
  assert.equal(chargeReservePct(p), 40);
  assert.equal(p.buyKwh, base.buyKwh, 'the cost target, not the line, sizes the buy');
  assert.equal(p.expectedBuyKwh, base.expectedBuyKwh);
  assert.equal(p.cushionLineSocPct, 31.67, 'the line it is bounded below by moved');
  assert.equal(p.requiredExtraKwh, 26.33);
});

test('★★ SCOPE — the line equals the planner run with the islanded load ÷ the scale, to the cushion\'s own rounding', () => {
  // A cushion of c / s is the same line (the conversion is linear); the rounded cushion differs by at
  // most 0.005 kWh, under 0.006 points of line on this pool.
  for (const s of [0.98, 0.944, 0.9, 0.8]) {
    const p = plan({ cushionPoolScale: { scale: s, basis: 'measured' } });
    const e = plan({ islandedLoadKw: 1.445 / s });
    assert.ok(Math.abs(p.cushionLineSocPct! - e.cushionLineSocPct!) <= 0.01, `${s}: ${p.cushionLineSocPct} vs ${e.cushionLineSocPct}`);
    assert.equal(p.setpointSocPct, e.setpointSocPct);
    assert.ok(Math.abs(p.requiredExtraKwh! - e.requiredExtraKwh!) <= 0.02);
    assert.equal(p.cushionKwh, 18.85, 'the reported cushion stays the energy');
  }
});

/* ══ every consumer agrees with the one line ══════════════════════════════════ */

test('★★★ AGREEMENT — a charge-bound night that held the nameplate line discloses a shortfall on the measured one, and still writes the line', () => {
  // A 2.4 kW charger: 6 h × 2.4 × 0.927 lifts the pack to the 30.45% nameplate line exactly, not to
  // the 31.67% measured one. The plan says so, and the write is the requirement, not the arrival.
  const before = plan({ chargeCapKw: 2.4 });
  assert.equal(before.cushionShortfall, false);
  assert.equal(before.cushionTroughSocPct, 30.45);
  const p = plan({ chargeCapKw: 2.4, cushionPoolScale: S944 });
  assert.equal(p.cushionShortfall, true);
  assert.equal(p.bindingCap, 'chargePower');
  assert.equal(p.requiredExtraKwh, 92.16, 'unmeetable at full power: the full-pack proxy, as on any unmeetable line');
  assert.equal(p.cushionTroughSocPct, 30.99);
  assert.equal(p.cushionLineSocPct, 31.67);
  assert.equal(p.setpointSocPct, 32);
  assert.equal(chargeReservePct(p), 32);
  assert.match(p.rationale, /NOTE: charge\/pool caps prevent fully meeting the cushion — residual risk remains\./);
  // A 2 kW charger fell short of both: the arrival is unchanged, the write follows the line.
  const two = plan({ chargeCapKw: 2, cushionPoolScale: S944 });
  assert.deepEqual([two.targetSocPct, two.setpointSocPct, two.cushionShortfall], [28.6, 32, true]);
});

test('★★★ AGREEMENT — a pack at the close between the two lines: the nameplate plan holds, the measured one sizes the gap', () => {
  // 65% at 21:00 leaves the pack at ~31% at the close: over the 30.45% line, under the 31.67% one.
  const before = plan({ socNowPct: 65 });
  assert.equal(before.chargeTonight, false);
  assert.equal(before.requiredExtraKwh, 0);
  assert.match(before.rationale, /^Hold — the pack at window close \(31%\) already covers the 10% reserve floor/);
  const p = plan({ socNowPct: 65, cushionPoolScale: S944 });
  assert.equal(p.chargeTonight, false, 'the gap is under the 1 kWh minimum buy');
  assert.equal(p.requiredExtraKwh, 0.41);
  assert.match(p.rationale, /^Hold — the buy this window would make \(~0\.4 kWh\) is under the 1 kWh minimum-buy threshold — the projected need is genuinely small\./);
  // A pack over both lines holds on both, and the hold states the measured line.
  const over = plan({ socNowPct: 67, cushionPoolScale: S944 });
  assert.deepEqual([over.chargeTonight, over.requiredExtraKwh, over.cushionLineSocPct, over.cushionTroughSocPct], [false, 0, 31.67, 33.03]);
  assert.deepEqual(over.cushionPoolScale, S944);
  assert.match(over.rationale, /already covers the 10% reserve floor plus 8 h of islanded backup load \(18\.9 kWh, 21\.7% of the packs' measured capacity at ×0\.944 of nameplate\)/);
  // A little lower and the gap is a charge on the measured line only.
  const lower = [plan({ socNowPct: 64 }), plan({ socNowPct: 64, cushionPoolScale: S944 })];
  assert.deepEqual(lower.map((x) => [x.chargeTonight, x.buyKwh]), [[false, 0.29], [true, 1.14]]);
  assert.equal(chargeReservePct(lower[1]), 32);
});

test('★★ AGREEMENT — on the year, every islanded charge night that is not economic-only writes at least ⌈its measured line⌉ (or the envelope)', () => {
  let n = 0;
  for (const c of legacyIdentityCases()) {
    const p = yearPlan(c.deps, MEASURED_SCALE);
    if (p.cushionBasis !== 'islanded-outage' || !p.chargeTonight || p.requiredExtraKwh === 0) continue;
    n += 1;
    const ask = Math.min(RESERVE_WRITE_MAX_PCT, Math.ceil(p.cushionLineSocPct! - 0.005 - 1e-9));
    assert.ok(written(p)! >= ask, `${c.label}: line ${p.cushionLineSocPct}, written ${written(p)}`);
  }
  assert.ok(n >= 250, `${n} nights`);
});

/* ══ the legs ═════════════════════════════════════════════════════════════════ */

test('★★ LEGS — the backup leg\'s walk is held to the measured line; the mid-day T_mid line term is ⌈the measured line⌉; the re-entry line is not a cushion', () => {
  const backup = (o: Partial<NightChargeInputs> = {}) => plan({
    objectiveMode: 'resilience', forceChargeEligible: false, windowSpec: { kind: 'overnight', role: 'backup' },
    horizon: horizon(900), chargeCapKw: 12, ...o,
  });
  const b0 = backup();
  const b1 = backup({ cushionPoolScale: S944 });
  // The walk to the horizon end drains the same energy from any start, so the pack it asks for at the
  // close rises by the line's own 1.22 points (53.8 → 55.0) and the trough reaches each line.
  assert.deepEqual([b0.cushionLineSocPct, b0.setpointSocPct, b0.requiredExtraKwh, b0.cushionTroughSocPct], [30.45, 53.8, 31.6, 30.45]);
  assert.deepEqual([b1.cushionLineSocPct, b1.setpointSocPct, b1.requiredExtraKwh, b1.cushionTroughSocPct], [31.67, 55, 32.62, 31.67]);
  assert.equal(b1.cushionShortfall, false);
  // A 3 kW charger cannot lift the walk over either line: the arrival (38.4%) is the same, and the
  // setpoint is the pack whose walk holds the line, so it rises by the line's own 1.22 points.
  const c0 = backup({ horizon: horizon(2000), chargeCapKw: 3 });
  const c1 = backup({ horizon: horizon(2000), chargeCapKw: 3, cushionPoolScale: S944 });
  assert.deepEqual([c0.targetSocPct, c0.setpointSocPct, c0.cushionShortfall], [38.4, 82.3, true]);
  assert.deepEqual([c1.targetSocPct, c1.setpointSocPct, c1.cushionShortfall], [38.4, 83.6, true]);
  // A 17 kW charger from 60%, a light house to the close and 2.65 kW after it: a full pack's walk holds
  // the nameplate line (sized: 78.93 kWh, 99.2%) but not the measured one, so the measured plan is
  // unmeetable — the shortfall disclosed, the requirement the pool-headroom proxy, all of the pack asked.
  const post = Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W: i >= 8 ? 2650 : 800, loadP50W: 800 / 1.35, pvP50W: 0 }));
  const u0 = backup({ socNowPct: 60, horizon: post, chargeCapKw: 17 });
  const u1 = backup({ socNowPct: 60, horizon: post, chargeCapKw: 17, cushionPoolScale: S944 });
  assert.deepEqual([u0.requiredExtraKwh, u0.setpointSocPct, u0.bindingCap, u0.cushionShortfall], [78.93, 99.2, 'requirement', false]);
  assert.deepEqual([u1.requiredExtraKwh, u1.setpointSocPct, u1.bindingCap, u1.cushionShortfall], [43.82, 100, 'poolHeadroom', true]);
  // The mid-day leg: no load after the window, so R is the line itself and T_mid's line term sets it.
  const mid = (o: Partial<NightChargeInputs> = {}) => plan({
    objectiveMode: 'cost', costMaxSocPct: 90, forceChargeEligible: true, socNowPct: 20,
    window: { startMs: B + 2 * H, endMs: B + 7 * H },
    windowSpec: { kind: 'super_off_peak', role: 'cost', window: { startMs: B + 2 * H, endMs: B + 7 * H } },
    horizon: Array.from({ length: 30 }, (_, i) => ({ ts: B + i * H, pvP10W: 0, loadP90W: i < 7 ? 600 : 0, loadP50W: i < 7 ? 450 : 0, pvP50W: 0 })),
    ...o,
  });
  const m0 = mid();
  const m1 = mid({ cushionPoolScale: S944 });
  assert.deepEqual([m0.reserveTargetBasis, m0.setpointSocPct], ['line', 31]);
  assert.deepEqual([m1.reserveTargetBasis, m1.setpointSocPct], ['line', 32]);
  assert.equal(middayReentryLinePct(30, 10), 35, 'floor + 25: unchanged, and not on the cushion');
});

/* ══ the plumbing ═════════════════════════════════════════════════════════════ */

test('★★ PLUMBING — buildNightChargeInputs forwards the scale; absent, the inputs carry no key', () => {
  const c = legacyIdentityCases()[2]; // '2026-10-12 resilience'
  assert.equal('cushionPoolScale' in buildNightChargeInputs(c.deps), false);
  assert.deepEqual(buildNightChargeInputs({ ...c.deps, cushionPoolScale: S944 }).cushionPoolScale, S944);
  assert.equal(buildNightChargeInputs({ ...c.deps, cushionPoolScale: null }).cushionPoolScale, null);
  // End to end through the builder: the live-shaped night (16% floor, 4 h × 2.62 kW × 1.25 ÷ 0.94).
  const p0 = yearPlan(c.deps);
  const p1 = yearPlan(c.deps, S944);
  assert.deepEqual([p0.cushionKwh, p0.cushionLineSocPct, written(p0)], [13.94, 31.13, 32]);
  assert.deepEqual([p1.cushionKwh, p1.cushionLineSocPct, written(p1)], [13.94, 32.02, 33]);
});

/* ══ the year at 0.944 ════════════════════════════════════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacyIdentity.golden.json'), 'utf8')) as { digests: Record<string, string> };
const FIGURES = JSON.parse(readFileSync(resolve(HERE, 'fixtures/measuredCushionLine.figures.json'), 'utf8')) as {
  generatedAt: string; scale: CushionPoolScale; fields: string[]; figures: Record<string, Figures>;
};

test('★★★ the year with an explicit nameplate scale ({ 1, \'nameplate\' }) digests to the golden, less the scale key', () => {
  const labels = Object.keys(GOLDEN.digests);
  let n = 0;
  for (const c of legacyIdentityCases()) {
    const p = yearPlan(c.deps, { scale: 1, basis: 'nameplate' });
    assert.equal(digestWithoutScale(p), GOLDEN.digests[c.label], c.label);
    assert.equal('cushionPoolScale' in p, p.cushionBasis === 'islanded-outage', `${c.label}: the key only where the cushion is energy`);
    n += 1;
  }
  assert.equal(n, labels.length);
});

test('★★★ the year at 0.944 against the golden\'s planner: nothing falls, no charge night holds, and the counts as measured', () => {
  let lineUp = 0, buyUp = 0, reqUp = 0, setpointUp = 0, writtenUp = 0, expectedUp = 0, costUp = 0, shortfallOn = 0, islanded = 0, legacy = 0;
  let maxLine = 0, maxBuy = 0, maxReq = 0, maxExpected = 0;
  let maxReqAt = '';
  const env = { base: 0, fix: 0, base2130: 0, fix2130: 0, baseNoFc: 0, fixNoFc: 0 };
  /** The 15-2 count: an evening islanded charge over 50% with no shortfall and no force-charge stop at the line. */
  const evening = { charges: 0, base: 0, fix: 0 };
  /** Resilience writes under 50% that the nameplate line set (⌈line⌉), and those the measured line leaves alone. */
  const lineSet = { writes: 0, unchanged: 0 };
  /** A charge night whose islanded line is above the 50% envelope and whose plan claims no shortfall:
   *  the write is 50, so where no force-charge stop reaches the line the realized verdict at the close
   *  can strike (nightChargeGate.realizedCushionBreach). Counted, not exempted (CHANGELOG 1.199.0). */
  const overEnvelope = (p: NightChargePlan) => p.chargeTonight && p.cushionBasis === 'islanded-outage' && p.cushionLineSocPct! > RESERVE_WRITE_MAX_PCT + 0.05 && !p.cushionShortfall;
  for (const c of legacyIdentityCases()) {
    const b = yearPlan(c.deps);
    assert.equal(planDigest(b), GOLDEN.digests[c.label], `${c.label}: the base is the golden`);
    const p = yearPlan(c.deps, MEASURED_SCALE);
    if (b.cushionBasis === 'islanded-outage') islanded += 1;
    if (b.cushionBasis === 'legacy-pct') { legacy += 1; assert.equal(planDigest(p), planDigest(b), `${c.label}: legacy band moved`); }
    const up = (a: number | null | undefined, z: number | null | undefined, what: string): number => {
      if (a == null) { assert.equal(z ?? null, null, `${c.label}: ${what} appeared`); return 0; }
      assert.ok(z != null && z >= a - 1e-9, `${c.label}: ${what} fell ${a} → ${z}`);
      return z - a > 1e-9 ? z - a : 0;
    };
    const dl = up(b.cushionLineSocPct, p.cushionLineSocPct, 'line');
    const db = up(b.buyKwh, p.buyKwh, 'buyKwh');
    const dr = up(b.requiredExtraKwh, p.requiredExtraKwh, 'requiredExtraKwh');
    const ds = up(b.setpointSocPct, p.setpointSocPct, 'setpointSocPct');
    const de = up(b.expectedBuyKwh, p.expectedBuyKwh, 'expectedBuyKwh');
    const dc = up(b.costCeilingSocPct, p.costCeilingSocPct, 'costCeilingSocPct');
    up(b.expectedWriteLevelPct, p.expectedWriteLevelPct, 'expectedWriteLevelPct');
    up(b.buyKwhDebiased, p.buyKwhDebiased, 'buyKwhDebiased');
    assert.ok(!(b.chargeTonight && !p.chargeTonight), `${c.label}: a charge night became a hold`);
    assert.ok(!(b.cushionShortfall && !p.cushionShortfall), `${c.label}: a shortfall vanished`);
    if (dl) { lineUp += 1; maxLine = Math.max(maxLine, dl); }
    if (db) { buyUp += 1; maxBuy = Math.max(maxBuy, db); }
    if (dr) { reqUp += 1; if (dr > maxReq) { maxReq = dr; maxReqAt = c.label; } }
    if (ds) setpointUp += 1;
    if (de) { expectedUp += 1; maxExpected = Math.max(maxExpected, de); }
    if (dc) costUp += 1;
    if (b.chargeTonight && p.chargeTonight && written(p)! > written(b)!) writtenUp += 1;
    if (!b.cushionShortfall && p.cushionShortfall) shortfallOn += 1;
    if (c.label.endsWith('21:30') && p.cushionBasis === 'islanded-outage' && p.chargeTonight) evening.charges += 1;
    if (b.cushionBasis === 'islanded-outage' && b.objective === 'resilience_cushion' && written(b)! < RESERVE_WRITE_MAX_PCT
      && written(b) === Math.ceil(b.cushionLineSocPct! - 1e-9)) {
      lineSet.writes += 1;
      if (written(p) === written(b)) lineSet.unchanged += 1;
      // The rule (CHANGELOG 1.199.0): the write stays where the nameplate line L0 sits at least the
      // shift below the next whole percent, the shift being 100 · cushion ÷ pool × (1/s − 1).
      const share = (100 * b.cushionKwh!) / c.deps.fullKwh;
      const L0 = b.reserveFloorPct + share;
      assert.ok(Math.abs(L0 - b.cushionLineSocPct!) < 0.0051, `${c.label}: L0 ${L0} vs the plan's ${b.cushionLineSocPct}`);
      const shift = share * (1 / MEASURED_SCALE.scale - 1);
      assert.equal(written(p) === written(b), Math.ceil(L0 - 1e-9) - L0 >= shift - 1e-9,
        `${c.label}: L0 ${L0}, shift ${shift}, written ${written(b)} → ${written(p)}`);
    }
    for (const [k, x] of [['base', b], ['fix', p]] as const) {
      if (c.label.endsWith('21:30') && x.chargeTonight && x.cushionBasis === 'islanded-outage' && x.cushionLineSocPct! > RESERVE_WRITE_MAX_PCT
        && !x.cushionShortfall && (x.costCeilingSocPct == null || x.costCeilingSocPct < x.cushionLineSocPct!)) evening[k] += 1;
      if (!overEnvelope(x)) continue;
      env[k] += 1;
      if (c.label.endsWith('21:30')) env[`${k}2130`] += 1;
      if (x.costCeilingSocPct == null || x.costCeilingSocPct < x.cushionLineSocPct!) env[`${k}NoFc`] += 1;
    }
  }
  // Measured when the change was made (v1.199.0). Every islanded-outage line moves (by up to 2.01
  // points); 452 requirements rise, the largest +72.53 kWh where the measured line is unmeetable
  // mid-window and the requirement takes the full-pack proxy; 166 worst-case buys (≤ +1.71 kWh), 143
  // setpoints, 120 writes, 67 expected buys (≤ +1.99 kWh) and 5 cost ceilings rise; 4 nights the
  // charge rate or a predicted EV holds under the measured line now disclose a shortfall.
  assert.deepEqual(
    { islanded, legacy, lineUp, reqUp, buyUp, setpointUp, writtenUp, expectedUp, costUp, shortfallOn },
    { islanded: 702, legacy: 148, lineUp: 702, reqUp: 452, buyUp: 166, setpointUp: 143, writtenUp: 120, expectedUp: 67, costUp: 5, shortfallOn: 4 },
  );
  assert.ok(Math.abs(maxLine - 2.01) < 0.005, `${maxLine}`);
  assert.ok(Math.abs(maxBuy - 1.71) < 0.005, `${maxBuy}`);
  assert.ok(Math.abs(maxExpected - 1.99) < 0.005, `${maxExpected}`);
  assert.deepEqual([Math.round(maxReq * 100) / 100, maxReqAt], [72.53, '2027-04-07 +1 01:30']);
  // The 50% envelope: a line above it cannot be written (13 such charge plans on the nameplate line,
  // 24 on the measured one; 5 → 9 at 21:30; 10 → 15 with no force-charge stop at or above the line).
  // v1.200.0 — counted here with no line force-charge eligibility passed (the fixture's), so unchanged;
  // with index.ts passing it these are carried by the night force-charge or disclosed
  // (lineForceCharge.test.ts T4).
  assert.deepEqual(env, { base: 13, fix: 24, base2130: 5, fix2130: 9, baseNoFc: 10, fixNoFc: 15 });
  // As chapter 15 part 2 counts them: evening charges whose close the realized verdict can strike.
  assert.deepEqual(evening, { charges: 209, base: 4, fix: 6 });
  // A write moves only where the line crosses a whole percent: the shift is (line − floor) × (1/s − 1).
  assert.deepEqual(lineSet, { writes: 154, unchanged: 38 });
});

test('★★★ the year at 0.944, case by case: the figures as measured (measuredCushionLine.figures.json)', () => {
  assert.deepEqual(FIGURES.fields, [...FIGURE_FIELDS]);
  assert.deepEqual(FIGURES.scale, MEASURED_SCALE);
  const labels = Object.keys(GOLDEN.digests);
  assert.deepEqual(Object.keys(FIGURES.figures), labels, 'the same cases, in the same order');
  const got = measuredFigures();
  const moved = labels.filter((l) => JSON.stringify(got[l]) !== JSON.stringify(FIGURES.figures[l]));
  assert.deepEqual(moved.map((l) => [l, FIGURES.figures[l], got[l]]).slice(0, 5), [], `${moved.length} case(s) moved`);
  // The figures are what figuresOf says of the plan: spot one by hand (the live-shaped resilience night).
  assert.deepEqual(FIGURES.figures['2026-10-12 resilience'].slice(0, 4), [1, 32.02, 33, 33]);
  assert.deepEqual(figuresOf(yearPlan(legacyIdentityCases()[2].deps, MEASURED_SCALE)), FIGURES.figures['2026-10-12 resilience']);
});

/* ══ the ledger, the log, the tracker ═════════════════════════════════════════ */

test('★★ the ledger columns: the scale and its basis where one applied, null otherwise', () => {
  assert.deepEqual(cushionPoolScaleLedgerColumns(plan({ cushionPoolScale: S944 })), { cushion_pool_scale: 0.944, cushion_pool_scale_basis: 'measured' });
  assert.deepEqual(cushionPoolScaleLedgerColumns(plan({ cushionPoolScale: { scale: 7, basis: 'held' } })), { cushion_pool_scale: 1, cushion_pool_scale_basis: 'implausible' });
  for (const p of [plan(), plan({ islandedLoadKw: null, cushionPoolScale: S944 }), plan({ basisComplete: false, cushionPoolScale: S944 })]) {
    assert.deepEqual(cushionPoolScaleLedgerColumns(p), { cushion_pool_scale: null, cushion_pool_scale_basis: null });
  }
  // A row is self-describing: the line from its own columns, to the line's rounding.
  const p = plan({ cushionPoolScale: S944 });
  const cols = cushionPoolScaleLedgerColumns(p);
  assert.ok(Math.abs(p.reserveFloorPct + (100 * p.cushionKwh!) / (92.16 * cols.cushion_pool_scale!) - p.cushionLineSocPct!) < 0.005);
});

test('★★ the log line names the basis and the scale; unavailable and never-measured say the line is on nameplate', () => {
  assert.equal(cushionScaleLogText({ scale: 0.944, basis: 'measured', connectedCores: 3 }),
    "night-charge: the outage-cushion line counts the cushion on the packs' measured capacity, ×0.944 of nameplate (measured, 3 connected Core(s))");
  assert.equal(cushionScaleLogText({ scale: 0.95, basis: 'held', connectedCores: 3 }),
    "night-charge: the outage-cushion line counts the cushion on the packs' measured capacity, ×0.950 of nameplate (held, 3 connected Core(s))");
  assert.equal(cushionScaleLogText({ scale: 1, basis: 'nameplate', connectedCores: 3 }),
    'night-charge: the outage-cushion line is on nameplate — no pack capacity ratio has been measured yet (3 connected Core(s))');
  assert.equal(cushionScaleLogText(null),
    "night-charge: the packs' measured capacity is unavailable (capacity tracker error) — the outage-cushion line is on nameplate");
});

/** The reference fleet: a panel with three connected Cores of five packs each at `ratio`. */
function fleet(ratio: number, online = true): { devs: Record<string, DeviceSnapshot>; panel: DeviceSnapshot & { projection: Shp2Projection } } {
  const sns = ['CORE-A', 'CORE-B', 'CORE-C'];
  const panel = {
    sn: 'PANEL', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: B,
    projection: {
      kind: 'shp2', backupBatPercent: 25, backupFullCapWh: 92_160, backupRemainWh: 0.25 * 92_160, backupReserveSoc: 10,
      circuits: [], pairedCircuits: [], sourceWatts: [], strategy: {},
      sources: sns.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, hwConnect: true, fullCap: 30_720 })),
    },
  } as unknown as DeviceSnapshot & { projection: Shp2Projection };
  const devs: Record<string, DeviceSnapshot> = { PANEL: panel };
  for (const sn of sns) {
    devs[sn] = {
      sn, deviceName: sn, online, lastSeenMs: B,
      projection: {
        kind: 'dpu', soc: 25, packCount: 5,
        packs: [1, 2, 3, 4, 5].map((num) => ({ num, soc: 25, designCapMah: 60_000, fullCapMah: Math.round(ratio * 60_000) })),
      },
    } as unknown as DeviceSnapshot;
  }
  return { devs, panel };
}

test('★★★ end to end: the main thread\'s tracker, evaluated as measuredCushionScale evaluates it, gives the planner its scale', () => {
  const t = new PoolEnergyBasisTracker({ path: null });
  const toScale = (b: ReturnType<PoolEnergyBasisTracker['evaluate']>): CushionPoolScale => ({ scale: b.capacityScale, basis: b.capacityBasis });
  // The first complete measurement applies at once: the fix takes effect on the first plan.
  const m = fleet(0.944);
  const s1 = toScale(t.evaluate(m.devs, m.panel, B));
  assert.equal(s1.basis, 'measured');
  assert.ok(Math.abs(s1.scale - 0.944) < 1e-12, `${s1.scale}`);
  assert.equal(written(plan({ cushionPoolScale: s1 })), 32);
  // The Cores go dark: their held ratios stand (never nameplate once measured).
  const dark = fleet(0.944, false);
  const s2 = toScale(t.evaluate(dark.devs, dark.panel, B + H));
  assert.equal(s2.basis, 'held');
  assert.ok(Math.abs(s2.scale - 0.944) < 1e-12, `${s2.scale}`);
  assert.equal(written(plan({ cushionPoolScale: s2 })), 32);
  // A higher reading waits the tracker's 24 h hold: the line stays high (the safe direction).
  const better = fleet(0.99);
  assert.ok(Math.abs(t.evaluate(better.devs, better.panel, B + 2 * H).capacityScale - 0.944) < 1e-12);
  // Never measured: nameplate, today's line.
  const fresh = new PoolEnergyBasisTracker({ path: null });
  const s3 = toScale(fresh.evaluate(dark.devs, dark.panel, B));
  assert.deepEqual(s3, { scale: 1, basis: 'nameplate' });
  assert.equal(written(plan({ cushionPoolScale: s3 })), 31);
});

test('★★ the cushion tracker\'s file: /data/pool-energy-basis-cushion.json under the Supervisor, distinct from the other two', () => {
  const serverDir = resolve(HERE, '..');
  const env: NodeJS.ProcessEnv = { ...process.env, SUPERVISOR_TOKEN: 'test-token' };
  delete env.DB_PATH;
  delete env.POOL_ENERGY_BASIS_DIR;
  const out = execFileSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    "const m = await import('./src/poolEnergyBasis.ts'); process.stdout.write(JSON.stringify(['pool-energy-basis', 'pool-energy-basis-panels', 'pool-energy-basis-cushion'].map((n) => m.defaultPoolEnergyBasisPath(n))));",
  ], { cwd: serverDir, env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['/data/pool-energy-basis.json', '/data/pool-energy-basis-panels.json', '/data/pool-energy-basis-cushion.json']);
});
