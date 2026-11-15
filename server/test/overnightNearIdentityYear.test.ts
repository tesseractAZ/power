import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeNightChargePlan, buildNightChargeInputs, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import { clampReserveTarget } from '../src/nightChargeActuator.js';
import { eveningAnnouncement } from '../src/chargeAnnounce.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';
import { darkDeps } from './fixtures/cushionOnlyFigures.js';

/**
 * ★★★ v1.206.0 — THE OVERNIGHT WORDS OF A WINDOW INSIDE 24 H ARE BYTE-IDENTICAL, the fixture year over.
 *
 * v1.206.0 words a window that opens a day or more after the plan from the window (farWindowText.test.ts). Every other
 * 21:30 push, and every spoken notice far or near, must not move by a byte. This file imports nothing v1.206.0 adds, so it runs
 * unchanged on the release before it: the pins below were captured by running it at 8f4b6748 (v1.205.1), and hold after.
 *
 * The sweep, through the route the evening job takes (chargeAnnounce.eveningAnnouncement):
 *  A. the year as issued — all 1,104 cases (21:30, 13:00, +1 01:30 and the named nights);
 *  B. the 21:30 plans at ARB_OUTAGE_CUSHION_HOURS 4..20 on both pools, the line gate on and off (the notes' year);
 *  C. the year with the Cores dark on the held ratio (the cushion-only plans).
 * Each plan: armed (supervised and auto), advisory, and — a charge plan — refused in both write modes.
 * NEAR here is written out, not read from the subject: no window, or one that opens less than 86,400,000 ms after the plan.
 */

const H24 = 86_400_000;
const CASES = legacyIdentityCases();
type Deps = (typeof CASES)[number]['deps'];
const live = (d: Deps): Deps => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50 } as Deps);
const planOf = (d: Deps): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(d));
const WHY = "a prior night's reserve write is unresolved";

/** The pins: captured at 8f4b6748 (v1.205.1). `far` plans are counted, never hashed here. */
const PIN = {
  plans: 27028, nearPlans: 23388, farPlans: 3640,
  nearPushes: 104802, nearSha256: '9b69b1a12ac3f5c130f478bff26a984e1fbc7b9db6f3f85db85eee3abce39f78',
  spoken: 41350, spokenSha256: 'ce9a96d3e3807b657b751e79aeccb1be19abcfd9879692c10361624ce9b11c5f',
};

test('★★★ inside 24 h every 21:30 push, and far or near every spoken notice, is byte-identical to v1.205.1: the year as issued, the 21:30 plans at 4-20 h on both pools with the line gate on and off, and the dark year', (t) => {
  const near = createHash('sha256');
  const spoken = createHash('sha256');
  const n = { plans: 0, nearPlans: 0, farPlans: 0, nearPushes: 0, spoken: 0 };
  const render = (p: NightChargePlan, lineGate: boolean): void => {
    n.plans += 1;
    const far = p.window != null && p.window.startMs - p.generatedAt >= H24;
    if (far) n.farPlans += 1; else n.nearPlans += 1;
    const shape = !p.basisComplete ? 'insufficient_basis' as const : p.chargeTonight ? 'charge' as const : 'hold' as const;
    const line = lineGate && p.forceChargeLine != null ? { askPct: p.forceChargeLine.askPct, linePct: p.forceChargeLine.linePct, panelCeilingPct: 80 } : null;
    const supervised = shape === 'charge' && p.setpointSocPct != null ? {
      cancelDeadlineText: 'at 11:00 PM', cancelDeadlineTextEs: 'a las 11:00 PM', targetPct: clampReserveTarget(p.setpointSocPct),
      forceChargeTargetPct: line != null ? null : p.costCeilingSocPct ?? null, forceChargeLine: line,
    } : null;
    const routes = [
      { supervised, armRefused: null, mode: 'supervised' as const },
      { supervised, armRefused: null, mode: 'auto' as const },
      { supervised: null, armRefused: null, mode: 'advisory' as const },
      ...(shape === 'charge' ? [
        { supervised: null, armRefused: WHY, mode: 'supervised' as const },
        { supervised: null, armRefused: WHY, mode: 'auto' as const },
      ] : []),
    ];
    for (const r of routes) {
      const a = eveningAnnouncement({ cycle: 'overnight', plan: p, shape, ...r });
      if (!far) { near.update(`${a.push.title}\n${a.push.body}\n`); n.nearPushes += 1; }
      if (a.spoken != null) { spoken.update(`${a.spoken.en}\n${a.spoken.es}\n`); n.spoken += 1; }
    }
  };
  for (const c of CASES) render(planOf(c.deps), true);
  for (const c of CASES.filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm'] as const) for (let h = 4; h <= 20; h++) for (const gate of [true, false]) {
    render(planOf({ ...live(c.deps), outageCushionHours: h, ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: gate } as Deps), gate);
  }
  for (const c of CASES) render(planOf(darkDeps(c.deps, 'held')), true);
  const measured = { ...n, nearSha256: near.digest('hex'), spokenSha256: spoken.digest('hex') };
  // What this run measured, printed on every run (the evidence beside a commit hash), then held to the pin.
  t.diagnostic(`measured ${JSON.stringify(measured)}`);
  assert.deepEqual(measured, PIN);
});
