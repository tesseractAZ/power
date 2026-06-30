import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePackRiskScores,
  type FleetDegradation,
  type FleetThermalEvents,
  type InternalResistanceReport,
  type ChargeCurveReport,
} from '../src/analytics.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ─── computePackRiskScores (v0.71 Predictive surface) ──────────────────
 *
 * This is the first DIRECT coverage of the pack-risk scorer. It pins:
 *   - the six factor weights sum to 1;
 *   - the sigmoid / 0..100 normalization mapping (linear=50 → 50, all-max
 *     → ~98, all-zero → ~2);
 *   - the tier boundaries (low <25, moderate <50, elevated <75, critical
 *     ≥75 — the code uses four risk tiers, NOT the low/medium/high the
 *     review brief named);
 *   - the `hasAnyData` no-data edge (ALL six factors null → 'no-data');
 *   - a majority-null characterization (4 of 6 factors null → still 'low').
 *
 * ★ TEST-ISOLATION HAZARD (confirmed live): `computePackRiskScores`
 *   memoises into an UNKEYED module-level `riskCache` (30-min TTL) and
 *   exposes NO reset seam — unlike the clipping/RTE/etc. caches, which all
 *   have `reset*` exports. A SECOND call in the same process returns the
 *   FIRST call's cached `FleetRiskReport` regardless of its inputs. So this
 *   suite makes exactly ONE `computePackRiskScores` call, packs EVERY
 *   scenario into distinct pack-numbers of that one fleet, and asserts
 *   per-pack. (The review should consider adding a `resetRiskCache()` seam.)
 * ─────────────────────────────────────────────────────────────────── */

// Two DPUs. The internal-R trend is BUS-LEVEL (one value per DPU, shared by all
// its packs), so the all-null 'no-data' pack must live on a DPU whose irTrend is
// null. We therefore split: SN_A holds the fully-instrumented pack 1 (irTrend
// present), SN_B holds the edge-case packs (irTrend null).
const SN_A = 'DPU-RISK-A';
const SN_B = 'DPU-RISK-B';

/** A fleet of DPUs, each carrying the given pack numbers (only `num` is read). */
function dpuFleet(spec: Record<string, number[]>): Record<string, DeviceSnapshot> {
  const out: Record<string, DeviceSnapshot> = {};
  let core = 0;
  for (const [sn, packNums] of Object.entries(spec)) {
    core++;
    out[sn] = {
      sn,
      deviceName: `Core ${core}`,
      productName: 'Delta Pro Ultra',
      online: true,
      lastUpdated: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs: packNums.map((num) => ({ num })) },
    } as unknown as DeviceSnapshot;
  }
  return out;
}

/** Degradation report entry for (sn, packNum). Unset fields default to null. */
function degPack(
  sn: string,
  packNum: number,
  f: { peerFadeRatio?: number; coulombicEffPct?: number; fadePctPerYear?: number },
) {
  return {
    sn,
    device: 'Core',
    coreNum: 1,
    packNum,
    peerFadeRatio: f.peerFadeRatio ?? null,
    coulombicEffPct: f.coulombicEffPct ?? null,
    fadePctPerYear: f.fadePctPerYear ?? null,
  } as any;
}

function thermPack(sn: string, packNum: number, hardLifeScore: number | null) {
  return { sn, device: 'Core', coreNum: 1, packNum, hardLifeScore } as any;
}

function ccPack(sn: string, packNum: number, meanDriftMv: number | null) {
  return { sn, device: 'Core', coreNum: 1, packNum, meanDriftMv } as any;
}

/** IR device row (bus-level). trendMilliohmsPerMonth feeds feature 2. */
function irDev(sn: string, trend: number | null) {
  return { sn, device: 'Core', coreNum: 1, trendMilliohmsPerMonth: trend } as any;
}

function buildReports(opts: {
  deg?: any[];
  therm?: any[];
  ir?: any[];
  cc?: any[];
}): {
  degradation: FleetDegradation;
  thermalEvents: FleetThermalEvents;
  internalR: InternalResistanceReport;
  chargeCurve: ChargeCurveReport;
} {
  const now = Date.now();
  return {
    degradation: { generatedAt: now, eolSoh: 80, packs: opts.deg ?? [] } as unknown as FleetDegradation,
    thermalEvents: { generatedAt: now, packs: opts.therm ?? [] } as unknown as FleetThermalEvents,
    internalR: { generatedAt: now, devices: opts.ir ?? [] } as unknown as InternalResistanceReport,
    chargeCurve: { generatedAt: now, packs: opts.cc ?? [] } as unknown as ChargeCurveReport,
  };
}

test('computePackRiskScores — weights, sigmoid mapping, tier boundaries, no-data / majority-null edges', () => {
  // ONE call (see TEST-ISOLATION HAZARD above), distinct pack-numbers:
  //
  //   pack 1   — ALL six features present (mixed)  → weight-sum read-back
  //   pack 10  — ALL six features null             → linear 0  → score 2  → 'no-data'
  //   pack 20  — 4 of 6 null, 2 present & HEALTHY   → linear ~0 → score 2  → 'low' (majority-null thinness)
  //   pack 30  — engineered linear == 50            → score 50            → 'elevated' (lower edge)
  //   pack 40  — 5 of 6 at max risk (IR null)       → linear 85 → score 95 → 'critical'
  //
  // pack 30 detail: peerFadeNorm 1 (→25) + fadeNorm 1 (→20) + ccDriftNorm 0.5 (→5) = 50.
  //   peerFade=2  → clamp01((2-1)/1)  = 1
  //   fade=6      → clamp01((6-1)/5)  = 1
  //   ccDrift=25  → clamp01(|25|/50)  = 0.5
  // pack 40 detail (each present feature clamps to 1; irTrend is null on SN_B):
  //   peerFade=2.5, ce=97, hardLife=300, ccDrift=50, fade=6 → 5 features × their
  //   weights × 100 = 100 − 15 (the absent irTrend weight) = linear 85.
  //
  // SN_A (irTrend=1) carries ONLY pack 1 so its all-six-present factor set is
  // valid for the weight read-back. SN_B (irTrend=null) carries packs 10/20/30/40
  // so the all-null 'no-data' pack 10 is genuinely all-null.
  const reports = buildReports({
    deg: [
      // pack 1 (SN_A): every degradation feature present (mixed magnitudes)
      degPack(SN_A, 1, { peerFadeRatio: 1.5, coulombicEffPct: 98.5, fadePctPerYear: 2 }),
      // pack 10 (SN_B): nothing
      // pack 20 (SN_B): healthy peer-fade + healthy fade only (other 4 null)
      degPack(SN_B, 20, { peerFadeRatio: 1.0, fadePctPerYear: 1.0 }),
      // pack 30 (SN_B): engineered to linear == 50
      degPack(SN_B, 30, { peerFadeRatio: 2, fadePctPerYear: 6 }),
      // pack 40 (SN_B): degradation features at max risk
      degPack(SN_B, 40, { peerFadeRatio: 2.5, coulombicEffPct: 97, fadePctPerYear: 6 }),
    ],
    therm: [thermPack(SN_A, 1, 100), thermPack(SN_B, 40, 300)],
    cc: [ccPack(SN_A, 1, 10), ccPack(SN_B, 30, 25), ccPack(SN_B, 40, 50)],
    // IR is bus-level: SN_A has a trend (so pack 1 has all six), SN_B is null.
    ir: [irDev(SN_A, 1), irDev(SN_B, null)],
  });

  const r = computePackRiskScores(
    dpuFleet({ [SN_A]: [1], [SN_B]: [10, 20, 30, 40] }),
    reports.degradation,
    reports.thermalEvents,
    reports.internalR,
    reports.chargeCurve,
  );

  const byNum = new Map(r.packs.map((p) => [p.packNum, p]));

  // ── weights sum to 1 (read off pack 1, which has all six factors). ──
  const p1 = byNum.get(1)!;
  assert.ok(p1, 'pack 1 must be scored');
  assert.equal(p1.allFactors.length, 6);
  const weightSum = p1.allFactors.reduce((s, f) => s + f.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9, `weights must sum to 1, got ${weightSum}`);
  const byName = new Map(p1.allFactors.map((f) => [f.name, f.weight]));
  assert.equal(byName.get('Peer-fade ratio'), 0.25);
  assert.equal(byName.get('Internal-R trend'), 0.15);
  assert.equal(byName.get('Coulombic efficiency'), 0.15);
  assert.equal(byName.get('Thermal hard-life'), 0.15);
  assert.equal(byName.get('Charge-curve drift'), 0.10);
  assert.equal(byName.get('Capacity fade rate'), 0.20);

  // ── no-data edge: every rawValue null → tier 'no-data' (NOT 'low'). ──
  const p10 = byNum.get(10)!;
  assert.ok(p10, 'pack 10 must be scored');
  assert.ok(p10.allFactors.every((f) => f.rawValue == null), 'pack 10 has no feature data');
  assert.equal(p10.tier, 'no-data');
  // Sigmoid floor: linear 0 → round(100/(1+e^(50/12))) = 2.
  assert.equal(p10.score0to100, 2);

  // ── majority-null (4 of 6 null) characterization: still 'low'. ──
  // KNOWN COVERAGE-THINNESS the review flagged: a pack with only 2 of 6
  // factors present is scored on the same 0-baseline as a fully-instrumented
  // healthy pack — missing factors contribute 0, not "unknown". Two HEALTHY
  // factors leave the linear score ~0, so the pack reads 'low' despite being
  // mostly un-measured. Pinned here as characterization, not endorsement.
  const p20 = byNum.get(20)!;
  const nullCount = p20.allFactors.filter((f) => f.rawValue == null).length;
  assert.equal(nullCount, 4, 'pack 20 should have exactly 4 null factors');
  assert.equal(p20.tier, 'low');
  assert.ok(p20.score0to100 < 25, `majority-null healthy pack scores low, got ${p20.score0to100}`);

  // ── sigmoid mapping + tier boundary at 50: linear==50 → score 50 → 'elevated'. ──
  const p30 = byNum.get(30)!;
  // Verify the linear pre-sigmoid sum is exactly 50 (25 + 20 + 5).
  const linear30 = p30.allFactors.reduce((s, f) => s + f.weightedScore, 0);
  assert.ok(Math.abs(linear30 - 50) < 1e-9, `pack 30 linear score must be 50, got ${linear30}`);
  // 100/(1+e^0) = 50 exactly.
  assert.equal(p30.score0to100, 50);
  // Boundary: `< 50` is moderate, so exactly 50 lands in 'elevated'.
  assert.equal(p30.tier, 'elevated');

  // ── all-max → top of the sigmoid → 'critical'. ──
  const p40 = byNum.get(40)!;
  const linear40 = p40.allFactors.reduce((s, f) => s + f.weightedScore, 0);
  // 5 of 6 features maxed (IR trend left null) → 100 − 15 (irTrend weight×100) = 85.
  assert.ok(Math.abs(linear40 - 85) < 1e-9, `pack 40 linear score must be 85, got ${linear40}`);
  // round(100/(1+e^(-(85-50)/12))) = round(100/(1+e^-2.9167)) ≈ 95.
  assert.equal(p40.score0to100, 95);
  assert.equal(p40.tier, 'critical');
  assert.ok(p40.score0to100 >= 75, 'critical tier requires score >= 75');

  // topFactors are the present factors sorted by weightedScore desc, capped at 3.
  assert.ok(p40.topFactors.length <= 3);
  assert.ok(p40.topFactors.every((f) => f.rawValue != null));
  for (let i = 1; i < p40.topFactors.length; i++) {
    assert.ok(
      p40.topFactors[i - 1].weightedScore >= p40.topFactors[i].weightedScore,
      'topFactors must be sorted by weightedScore desc',
    );
  }
});
