import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNightChargePlan, buildNightChargeInputs } from '../src/nightChargeAdvisor.js';
import { armFromPlan, emptyActuationState, decideActuation } from '../src/nightChargeActuator.js';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, forceChargeRateKw, evDisplacedPackKwh } from '../src/nightForceCharge.js';
import { nextOnPeakStartMs } from '../src/chargeWindows.js';
import { legacyIdentityCases, MODEL } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';

/**
 * v1.205.0 (AO-R) — THE AT-OPEN ALLOWANCE, REPLAYED. Every 21:30 plan of the year at 4-20 h on both pools (the live cost gate,
 * eligibility true) that CLAIMS its line (armed, nothing disclosed) on a one-hour window is armed (armFromPlan) and its night run
 * minute by minute through the real decisions: decideActuation's reserve write and its readback, decideForceCharge's ceiling sync,
 * ON and its readback, its line re-ONs and OFF. A write takes effect on the tick after it is sent. The pack charges at the grid's
 * contended rate (the fixture's grid input cap, and a grid pinned at 19.1 kW), at most 5.5 kW a Core, and the house draws it, held
 * at the reserve, whenever no ON of ours is in effect. The start shapes the plant has shown: every Core takes the ON; one Core, and
 * two, take it 17 min late (2026-11-10; 2026-10-16). None of these nights closes under its line (L − 0.05): on v1.204.0, 7 / 4
 * (every Core), 10 / 5 (one late) and 17 / 12 (two late) of the 168 then claimed did (the fixture grid / 19.1 kW).
 * An emulation: read every value on the tick it is taken and puts the charge cap on the plant; its figures are relative.
 */

const MIN = 60_000, H = 3_600_000, NAME = 92.16, LEG = 0.927, DIS = 0.94, CAP = NAME * 0.944, PER_CORE = 5.5;
type Shape = 'all' | 'one' | 'two';
/* eslint-disable @typescript-eslint/no-explicit-any */
const live = (d: any) => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50 });
const planOf = (d: any, b: string, h: number): any => computeNightChargePlan(buildNightChargeInputs({
  ...live(d), outageCushionHours: h, ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: true,
} as never)!);

function loadKwAt(d: any, t: number): number {
  const he = Math.floor(t / H) * H;
  const b = d.bandHours.find((x: any) => x.ts === he);
  if (b?.loadP50W != null) return b.loadP50W / 1000;
  for (const r of d.dayRollups ?? []) { const x = r.hours.find((y: any) => y.ts === he); if (x) return x.loadW / 1000; }
  return 2.2;
}

/** One night from the armed record: the pool at the close, %, and when the first ON took effect (min after the open). */
function night(p: any, d: any, rec0: any, p0: number, reserveOpen: number, shape: Shape, gridPin: number | null, lateMin: number): { close: number; onAtMin: number | null } {
  let s: any = { ...rec0 };
  const W0 = s.windowStartMs as number, W1 = s.windowEndMs as number;
  const gates = { cost: d.forceChargeEligible === true, line: true };
  const capKw = gridPin ?? d.gridInputCapKw ?? 17;
  const pCap = (d.chargeCapKw ?? 17.8) * LEG;
  let pack = (p0 / 100) * CAP, reserve = reserveOpen, ceiling = 100;
  let pendingC: number | null = null, pendingR: number | null = null;
  let on = false, onEff: number | null = null, firstOnEff: number | null = null;
  const slots = [1, 2, 3];
  const evKwh = p.evContention?.windowEvKwh, peak = p.evContention?.peakEvKw;
  for (let t = W0; t < W1; t += MIN) {
    if (pendingC != null) { ceiling = pendingC; pendingC = null; }
    if (pendingR != null) { reserve = pendingR; pendingR = null; }
    if (onEff != null && t >= onEff) { on = true; firstOnEff ??= onEff; onEff = null; }
    const seen = Math.round((pack / CAP) * 100);
    const load = loadKwAt(d, t);
    const a: any = decideActuation(s, t, { mode: 'supervised', writeReady: false, currentReservePct: reserve, socCoherent: true, vitalsRed: false, gridPresent: true } as never);
    if (a.kind === 'apply') { s = { ...s, applyAttemptedAtMs: t, attemptBaselinePct: reserve, appliedAtMs: t, priorReservePct: reserve, applyLastAttemptMs: t }; pendingR = Math.min(50, a.targetPct); }
    else if (a.kind === 'applyVerified') s = { ...s, applyVerifiedAtMs: t };
    else if (a.kind === 'reserveStanding') s = { ...s, reserveStandingAtMs: t };
    else if (a.kind === 'revert') { s = { ...s, revertedAtMs: t, revertLastAttemptMs: t }; pendingR = a.restorePct; }
    else if (a.kind === 'revertVerified') s = { ...s, revertVerifiedAtMs: t };
    const rate = forceChargeRateKw({ gridCapKw: d.gridInputCapKw ?? null, houseLoadKw: load, legEff: LEG, slotCount: 3 });
    const evD = typeof evKwh === 'number' && evKwh > 0 ? evDisplacedPackKwh({ evKwh, peakEvKw: peak ?? null, rateKw: rate, unboundedRateKw: d.gridInputCapKw != null ? Math.max(1, (d.gridInputCapKw - load) * LEG) : null, legEff: LEG }) : null;
    const o: any = {
      enabled: gates.cost, lineEnabled: gates.line, gridPresent: true, gridStaLost: false, slotsOn: on ? slots : [], reservePct: reserve, connectedSlots: slots, vitalsRed: false,
      socCoherent: true, slotSocPct: { 1: seen, 2: seen, 3: seen }, ceilingReadbackPct: ceiling, poolSocPct: seen, fullKwh: NAME, chargeRateKw: rate, evDisplacedKwh: evD,
    };
    const obs = nfc.lineNightObservations(s, t, o);
    if (obs != null) s = { ...s, ...obs };
    const f: any = decideForceCharge(s, t, o);
    if (f.kind === 'syncCeiling') { s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? f.prior, forceChargeCeilingSyncedPct: f.pct }; pendingC = f.pct; }
    else if (f.kind === 'on') { s = { ...s, ...nfc.forceChargeOnStamp(s, t, f.slots, gates), forceChargeOnLastAttemptMs: t }; onEff = t; }
    else if (f.kind === 'onVerified') s = { ...s, forceChargeOnVerifiedAtMs: t };
    else if (f.kind === 'lineReOn') { s = { ...s, forceChargeLineReOns: s.forceChargeLineReOns + 1, forceChargeLineReOnAtMs: t, forceChargeLineReOnSlots: [...f.slots] }; onEff = t; }
    else if (f.kind === 'lineReOnChecked') s = { ...s, ...nfc.lineReOnCheckedStamp(s, t, f) };
    else if (f.kind === 'off') { s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: f.reason, forceChargeOffLastAttemptMs: t }; on = false; onEff = null; }
    else if (f.kind === 'offVerified') s = { ...s, forceChargeOffVerifiedAtMs: t };
    let rateP = Math.min(Math.max(1, (capKw - load) * LEG), 3 * PER_CORE, pCap);
    // A late Core: the Cores that took the ON charge alone for `lateMin` after it took effect.
    if (on && firstOnEff != null && t < firstOnEff + lateMin * MIN && shape !== 'all') rateP = Math.min(rateP, (shape === 'one' ? 2 : 1) * PER_CORE);
    const resKwh = (reserve / 100) * CAP;
    if (on && pack < (ceiling / 100) * CAP) pack += Math.min((ceiling / 100) * CAP - pack, rateP * (MIN / H));
    else {
      if (on) on = false;
      if (pack < resKwh) pack += Math.min(resKwh - pack, rateP * (MIN / H));
      else if (pack > resKwh) pack = Math.max(resKwh, pack - (load / DIS) * (MIN / H));
    }
  }
  return { close: (pack / CAP) * 100, onAtMin: firstOnEff == null ? null : (firstOnEff - W0) / MIN };
}

/** Measured on the landed change: the claimed one-hour line nights (every shape and grid runs the same nights). */
const PIN_CLAIMED = 115;

test('★★★ AO-R the year at 4-20 h, both pools, through the real apply / readback / ceiling / ON decisions: no claimed one-hour line night closes under its line on the observed start shapes (every Core; one, and two, Cores 17 min late), at the fixture grid and at 19.1 kW', () => {
  const out: Record<string, { claimed: number; under: number; worst: number; ex: string[] }> = {};
  for (const c of legacyIdentityCases().filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm']) for (let h = 4; h <= 20; h++) {
    const d0: any = live(c.deps);
    const own = d0.reserveFloorPct as number;
    const p = planOf(d0, b, h);
    if (p.forceChargeLine == null || p.cushionShortfall === true) continue;
    if ((p.window.endMs - p.window.startMs) / MIN > 60) continue;
    const rec = armFromPlan(emptyActuationState(), c.label.slice(0, 10), p as never, d0.nowMs, own, d0.forceChargeEligible === true, p.window ? nextOnPeakStartMs(MODEL as never, p.window.startMs) : null, true);
    if (!rec) continue;
    for (const shape of ['all', 'one', 'two'] as Shape[]) for (const gp of [null, 19.1]) {
      const k = `${shape}|${gp ?? 'fx'}`;
      out[k] ??= { claimed: 0, under: 0, worst: Infinity, ex: [] };
      const r = night(p, d0, rec, Math.max(own, p.expectedStartSocPct ?? own), own, shape, gp, 17);
      const margin = r.close - p.cushionLineSocPct;
      out[k].claimed += 1;
      out[k].worst = Math.min(out[k].worst, margin);
      if (margin < -0.05) { out[k].under += 1; if (out[k].ex.length < 3) out[k].ex.push(`${b} ${h} h ${c.label}: ${r.close.toFixed(2)} under ${p.cushionLineSocPct}`); }
    }
  }
  assert.deepEqual(Object.keys(out).sort(), ['all|19.1', 'all|fx', 'one|19.1', 'one|fx', 'two|19.1', 'two|fx']);
  for (const [k, v] of Object.entries(out)) {
    assert.equal(v.under, 0, `${k}: ${v.under} of ${v.claimed} claimed one-hour nights close under — ${v.ex.join('; ')}`);
    assert.equal(v.claimed, PIN_CLAIMED, k);
    assert.ok(v.worst > 0, `${k}: the smallest margin ${v.worst.toFixed(2)}`);
  }
});
