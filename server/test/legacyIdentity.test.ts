import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNightChargeInputs, computeNightChargePlan, resolveCheapWindow, OVERNIGHT_WINDOW_SPEC,
  type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { nextChargeableOpenMs, OVERNIGHT_CYCLE, resolveCheapWindow as cwResolveCheapWindow } from '../src/chargeWindows.js';
import { pvSurplusFromBand, surplusSpanEndMs } from '../src/chargeTaper.js';
import {
  legacyIdentityCases, legacyIdentityDigests, legacyMorningSurplus, planDigest, MODEL, periodIdAt,
} from './fixtures/legacyIdentityFixtures.js';

/**
 * R2 — THE OVERNIGHT PLAN DOES NOT MOVE.
 *
 * R2 threads a WindowSpec (the leg a plan sizes) through buildNightChargeInputs and
 * computeNightChargePlan and adds the terms a mid-day window needs: the PV acceptance bound on the
 * grid gain, the P50 PV credited against the expected buy, the taper ceiling, T_mid, the backup
 * hold. Each is a no-op on the overnight leg, where there is no sun. Nothing live consumes the
 * mid-day leg yet, so every plan the add-on makes must be the one it made before R2, byte for byte.
 *
 * legacyIdentity.golden.json holds the digest (JSON and key list) of 1,104 plans: a year of
 * live-shaped evenings, middays and mid-window recomputes (legacyIdentityFixtures.ts), and the
 * 2026-10-12 and 2026-09-29/30 nights. They were produced at 4d10c53, the tree before R2, and R2
 * reproduced every one.
 *
 * v1.194.0 — REGENERATED, deliberately. The planner's walks now store a PV surplus at the charge
 * leg (legEff, physics/chargeLeg.ts) instead of at unity, and the walks that cross a sunny day (the
 * post-window trough, a 13:00 recompute's carry to the window) moved: 472 of the 1,104 digests.
 * What it may move, and in which direction, is pinned below against the figures the planner
 * produced at 3fc751c3 (legacyIdentity.v1192.figures.json); the digests then hold the new plans
 * byte for byte, as they held the old ones.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacyIdentity.golden.json'), 'utf8')) as {
  generatedAt: string;
  digests: Record<string, string>;
};
/** v1.194.0 — per case, the plan before the charge leg: [chargeTonight (1/0), buyKwh,
 *  expectedBuyKwh, setpointSocPct, requiredExtraKwh, targetSocPct] at 3fc751c3 (v1.192.0). */
const BEFORE_CHARGE_LEG = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacyIdentity.v1192.figures.json'), 'utf8')) as {
  generatedAt: string;
  figures: Record<string, [number, number | null, number | null, number | null, number | null, number | null]>;
};
const H = 3_600_000;
const plan = (deps: Parameters<typeof buildNightChargeInputs>[0]): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(deps));

test('★★★ a year of overnight plans is byte-identical to the golden (no spec)', () => {
  const got = legacyIdentityDigests();
  const labels = Object.keys(GOLDEN.digests);
  assert.equal(labels.length, 1104);
  assert.deepEqual(Object.keys(got), labels, 'the same cases, in the same order');
  const moved = labels.filter((l) => got[l] !== GOLDEN.digests[l]);
  assert.deepEqual(moved, [], `${moved.length} plan(s) moved: ${moved.slice(0, 5).join('; ')}`);
});

test('★★★ ... and with the overnight spec passed explicitly (what index.ts passes)', () => {
  const got = legacyIdentityDigests((c) => ({ ...c.deps, windowSpec: OVERNIGHT_WINDOW_SPEC }));
  const moved = Object.keys(GOLDEN.digests).filter((l) => got[l] !== GOLDEN.digests[l]);
  assert.deepEqual(moved, []);
});

test('★★ ... and with a spec that pins the window the resolver finds, carries the default acceptance and no backup', () => {
  // The PV terms are evaluated, not skipped: an explicit acceptance (the default value), a pinned
  // window, an explicit null hold. With no sun in the window they change nothing.
  const got = legacyIdentityDigests((c) => {
    const w = resolveCheapWindow(c.deps.periodIdAt, c.deps.nowMs, c.deps.cheapPeriodId!, c.deps.windowScanHours);
    return {
      ...c.deps,
      windowSpec: { kind: 'overnight', role: 'cost', window: w, packAcceptKw: c.deps.chargeCapKw * c.deps.legEff, backupHold: null },
    };
  });
  const moved = Object.keys(GOLDEN.digests).filter((l) => got[l] !== GOLDEN.digests[l]);
  assert.deepEqual(moved, []);
});

test('★★★ v1.194.0 — the charge leg moves the year only toward buying more: no buy, no expected buy and no requirement falls', () => {
  // Against the planner at 3fc751c3, which credited a PV surplus at unity. A surplus stored at
  // legEff leaves every walk at or below where it was, so the trough the buy is sized on can only
  // fall and the buy can only rise. A setpoint may fall in two shapes only: a charge night whose
  // requirement rose but whose window cannot deliver more (the setpoint is the arrival, from a
  // lower pack at the open — the buy itself is unchanged), and a hold (nothing armed, nothing
  // required) whose setpoint is the no-buy pack at the close, which the charge leg lowers.
  const labels = Object.keys(GOLDEN.digests);
  assert.equal(BEFORE_CHARGE_LEG.generatedAt, '3fc751c3');
  assert.deepEqual(Object.keys(BEFORE_CHARGE_LEG.figures), labels, 'the same cases, in the same order');
  const plans = new Map(legacyIdentityCases().map((c) => [c.label, plan(c.deps)]));
  const ge = (a: number | null | undefined, b: number | null, what: string, l: string): void => {
    if (b == null) { assert.equal(a ?? null, null, `${l}: ${what} appeared`); return; }
    assert.ok(a != null && a >= b - 1e-9, `${l}: ${what} ${b} → ${a}`);
  };
  let buyRose = 0, expectedRose = 0, holdToCharge = 0, setpointFell = 0, setpointMoved = 0;
  let maxBuyRise = 0;
  for (const l of labels) {
    const [charge0, buy0, exp0, sp0, req0, tgt0] = BEFORE_CHARGE_LEG.figures[l];
    const p = plans.get(l)!;
    ge(p.buyKwh, buy0, 'buyKwh', l);
    ge(p.expectedBuyKwh, exp0, 'expectedBuyKwh', l);
    ge(p.requiredExtraKwh, req0, 'requiredExtraKwh', l);
    assert.ok(!(charge0 === 1 && !p.chargeTonight), `${l}: a charge night became a hold`);
    if (charge0 === 0 && p.chargeTonight) holdToCharge += 1;
    if (buy0 != null && p.buyKwh! > buy0 + 1e-9) { buyRose += 1; maxBuyRise = Math.max(maxBuyRise, p.buyKwh! - buy0); }
    if (exp0 != null && p.expectedBuyKwh! > exp0 + 1e-9) expectedRose += 1;
    if (sp0 == null) { assert.equal(p.setpointSocPct ?? null, null, l); continue; }
    if (p.setpointSocPct !== sp0) setpointMoved += 1;
    if (p.setpointSocPct! < sp0 - 1e-9) {
      setpointFell += 1;
      const windowBound = p.chargeTonight && p.requiredExtraKwh! > req0! + 1e-9 && p.buyKwh === buy0 && p.setpointSocPct === p.targetSocPct;
      const holdArrival = !p.chargeTonight && p.requiredExtraKwh === 0 && p.setpointSocPct === p.targetSocPct && p.targetSocPct! < tgt0!;
      assert.ok(windowBound || holdArrival, `${l}: setpoint ${sp0} → ${p.setpointSocPct} (requirement ${req0} → ${p.requiredExtraKwh}, buy ${buy0} → ${p.buyKwh})`);
    }
  }
  // The year as measured when the change was made: 95 buys rise (by up to 2.84 kWh), 118 expected
  // buys rise, one hold becomes a charge (0.96 → 1.49 kWh, over the 1 kWh minimum buy), and 264
  // setpoints move, 16 of them down.
  assert.deepEqual({ buyRose, expectedRose, holdToCharge, setpointMoved, setpointFell }, { buyRose: 95, expectedRose: 118, holdToCharge: 1, setpointMoved: 264, setpointFell: 16 });
  assert.ok(Math.abs(maxBuyRise - 2.84) < 0.005, `largest buy rise ${maxBuyRise}`);
  const flipped = labels.filter((l) => BEFORE_CHARGE_LEG.figures[l][0] === 0 && plans.get(l)!.chargeTonight);
  assert.deepEqual(flipped.map((l) => [l, BEFORE_CHARGE_LEG.figures[l][1], plans.get(l)!.buyKwh]), [['2027-08-25 21:30', 0.96, 1.49]]);
});

test('★★ the cases are not vacuous: buys, holds, force-charge starts, cost and resilience, null plans, mid-window', () => {
  const plans = legacyIdentityCases().map((c) => ({ c, p: plan(c.deps) }));
  const count = (f: (x: { c: (typeof plans)[number]['c']; p: NightChargePlan }) => boolean): number => plans.filter(f).length;
  // (At 4d10c53: 740 charge, 232 hold, 132 null, 524 cost, 216 resilience, 324 force-charge starts,
  // 562 expected buys, 248 mid-window, 100 long-gap, 71 EV-bound, 131 shortfall, 117 window-bound.)
  assert.ok(count((x) => x.p.chargeTonight) >= 600, 'charge nights');
  assert.ok(count((x) => !x.p.chargeTonight && x.p.basisComplete) >= 180, 'hold nights');
  assert.ok(count((x) => !x.p.basisComplete) >= 100, 'null plans');
  assert.ok(count((x) => x.p.objective === 'cost_arbitrage') >= 400, 'cost buys');
  assert.ok(count((x) => x.p.objective === 'resilience_cushion') >= 170, 'resilience buys');
  assert.ok(count((x) => typeof x.p.expectedForceChargeStartMs === 'number') >= 250, 'force-charge starts expected');
  assert.ok(count((x) => (x.p.expectedBuyKwh ?? 0) > 1) >= 450, 'expected buys');
  assert.ok(count((x) => x.p.window != null && x.c.deps.nowMs >= x.p.window.startMs) >= 200, 'mid-window recomputes');
  assert.ok(count((x) => x.p.longGapAhead === true) >= 80, 'long-gap nights');
  assert.ok(count((x) => x.p.bindingCap === 'evContention') >= 50, 'EV contention');
  assert.ok(count((x) => x.p.cushionShortfall) >= 100, 'cushion shortfalls');
  assert.ok(count((x) => x.p.expectedDeliverableBound === true) >= 90, 'window-bound expected buys');
});

test('★★ the premise: no overnight window hour of any case carries sun', () => {
  for (const c of legacyIdentityCases()) {
    const inputs = buildNightChargeInputs(c.deps);
    const w = inputs.window;
    if (!w) continue;
    for (const h of inputs.horizon) {
      if (h.ts < w.startMs || h.ts >= w.endMs) continue;
      assert.equal(h.pvP10W, 0, `${c.label}: P10 PV at ${new Date(h.ts).toISOString()}`);
      assert.ok(!(h.pvP50W ?? 0), `${c.label}: P50 PV at ${new Date(h.ts).toISOString()}`);
    }
  }
});

test('★★ the planDigest notices a field added with an undefined value', () => {
  const p = plan(legacyIdentityCases()[0].deps);
  assert.notEqual(planDigest({ ...p, reserveTargetBasis: undefined }), planDigest(p));
});

test('★★★ nextChargeableOpenMs under the overnight cycle is the 96 h overnight scan index.ts ran, every hour of a year', () => {
  const t0 = Date.UTC(2026, 9, 13, 7);
  for (let t = t0, i = 0; t < t0 + 366 * 24 * H; t += H, i++) {
    const from = t + (i % 2) * 30 * 60_000; // on the hour and on the half hour, alternately
    const legacy = resolveCheapWindow(periodIdAt, from, 'overnight', 96)?.startMs ?? null;
    assert.equal(i % 3 === 0 ? nextChargeableOpenMs(MODEL, from, OVERNIGHT_CYCLE) : nextChargeableOpenMs(MODEL, from), legacy, new Date(from).toISOString());
  }
});

test('★★★ the morning surplus helper is the loop index.ts ran inline, on every case', () => {
  for (const c of legacyIdentityCases()) {
    const w = resolveCheapWindow(c.deps.periodIdAt, c.deps.nowMs, c.deps.cheapPeriodId!, 30);
    const windowEndMs = w?.endMs ?? c.deps.nowMs;
    // The band the fixtures build, as the probabilistic forecast hours index.ts reads.
    const prob = c.deps.bandHours.map((h) => ({ ts: h.ts, p50W: h.pvP50W ?? 0, p90W: (h.pvP50W ?? 0) * 1.25, loadW: h.loadP50W ?? 0 }));
    const legacy = legacyMorningSurplus(prob, w, windowEndMs);
    const loads = new Map(prob.map((p) => [p.ts, p.loadW]));
    const now = w
      ? pvSurplusFromBand({ hours: prob, loadAt: (ts) => loads.get(ts), fromMs: windowEndMs, toMs: surplusSpanEndMs('overnight', windowEndMs, null) })
      : { p90Kwh: null, p50Kwh: null };
    assert.deepEqual([now.p90Kwh, now.p50Kwh], [legacy.p90, legacy.p50], c.label);
  }
});

test('★ resolveCheapWindow moved to chargeWindows.ts: the planner re-exports the same function', () => {
  assert.equal(resolveCheapWindow, cwResolveCheapWindow);
});

test('★★ wiring — index.ts plans the overnight leg: the overnight cycle, the overnight span, the overnight spec', () => {
  const index = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  // R4 — a shadow leg (middayShadow.ts) pins its own; every live plan takes the overnight branch.
  assert.ok(index.includes('const nextRechargeMs: number | null = shadowLeg ? shadowLeg.nextRechargeMs : nextChargeableOpenMs(tariffModel, windowEndMs + HOUR_MS);'),
    'the horizon end is the overnight cycle\'s next open (no mid-day config passed until the switch)');
  assert.ok(index.includes("const morningEndMs = shadowLeg ? shadowLeg.surplusEndMs : surplusSpanEndMs('overnight', windowEndMs, null);"));
  assert.ok(index.includes("windowSpec: shadowLeg ? shadowLeg.spec : legRole === 'cost' ? OVERNIGHT_WINDOW_SPEC : { kind: 'overnight', role: legRole },"));
  assert.ok(index.includes('const window = shadowLeg ? (shadowLeg.spec.window ?? null)\n    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, 30, cheapNight);'));
  // The shadow passes a pinned leg, and so does the live morning refresh (R5, inert until the switch:
  // it plans only an armed super off-peak leg); no other caller does.
  assert.equal(index.split('shadowLeg: sizing').length - 1, 2, 'sizeShadowLeg and the morning refresh pin a leg');
  assert.ok(index.includes('const r = await recomputeNightChargePlan({ allowStalePanel, shadowLeg: sizing });'));
  const refresh = index.slice(index.indexOf('async function runMorningRefreshTickInner('), index.indexOf('\n}\n', index.indexOf('async function runMorningRefreshTickInner(')));
  assert.ok(refresh.includes('const r = await recomputeNightChargePlan({ shadowLeg: sizing, maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS });'));
  assert.match(refresh, /^async function runMorningRefreshTickInner\(nowMs: number\): Promise<void> \{\n {2}const due = liveRefreshDue\(nightCycleView\(\), nowMs\);\n {2}if \(due == null\) return;/);
  // v1.191.0 (W1) — the cheap period is the tariff's own (cheapPeriodIdOf: 'overnight' on the APS preset).
  assert.ok(index.includes('  const cheapPeriodId = cheapPeriodIdOf(tariffModel);'));
  assert.ok(index.includes('    periodIdAt, cheapPeriodId, cheapNight, windowScanHours: 30,'));
  // Per leg: the force-charge gate and the objective follow the leg's role.
  assert.ok(index.includes("const forceChargeOn = (role: ChargeLegRole = 'cost'): boolean => legForceChargeEligible(role, forceChargeEnabled({"));
  // v1.191.0 — ARB_OBJECTIVE is read through its config.ts row (the same 'cost'-in-any-case rule).
  assert.ok(index.includes("const objectiveMode = legObjective(legRole, option<'cost' | 'resilience'>('ARB_OBJECTIVE'));"));
  assert.equal(index.split('chooseChargeCycle(').length - 1, 0, 'the chooser is not wired to the actuator in this release');
  assert.equal(index.split('recomputeNightChargePlan({ role').length - 1, 0, 'every caller plans the overnight cost leg');
});
