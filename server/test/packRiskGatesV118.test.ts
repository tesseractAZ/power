import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/* ===================================================================
 * v1.18.0 — engine-review F16: pack-risk v2 gate repair.
 *
 * The live system served a 13-sample one-class shadow LR (learned
 * signal 99.99% bias — "raise everyone's risk") straight to the HA
 * dashboard, inflating healthy-fleet composites 4-7× (three near-new
 * packs falsely tiered 'moderate'), while BOTH safety gates were
 * structurally dead: the drift gate read driftL2=0 because no on-disk
 * baseline existed (cold-start path), and the precision gate was
 * pinned at 1.0 because a UI that only ever produces 'ack' can never
 * register a false positive (33/33 outcomes were batch-acks, median
 * time-to-action 21.9 days).
 *
 * Fixes under test:
 *  1. minimum-training-samples gate ('samples' reason, default 100);
 *  2. composite pins to the HEURISTIC ALONE under the samples gate
 *     (novelty excluded too — with only the trained track pinned,
 *     mean(heur, heur, novelty=100) still read 'moderate');
 *  3. missing baseline → driftL2 null (unknown), not a fake measured 0;
 *  4. precision is evidence only with ≥ MIN_DECIDED outcomes AND ≥1
 *     dismissal (a sub-0.4 stream always qualifies arithmetically).
 *
 * Path strategy mirrors onlineLrGuard.test.ts: ml.ts freezes its model
 * paths from config.dbPath at module load, so DB_PATH is set BEFORE the
 * dynamic import and all model/outcome files live in a tmpdir.
 * =================================================================== */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'pack-risk-gates-test-'));
const dbDir = join(tmpRoot, 'db');
const modelsDir = join(dbDir, 'models');
const dbPath = join(dbDir, 'ecoflow.db');
mkdirSync(modelsDir, { recursive: true });

const SHADOW_PATH = join(modelsDir, 'pack-risk-lr-v1-online.json');
const BASELINE_PATH = join(modelsDir, 'pack-risk-lr-v1.json');
const OUTCOMES_PATH = join(dbDir, 'alert-outcomes.jsonl');

process.env.DB_PATH = dbPath;

const { computeGateDecision, computePackRiskV2, loadModel, FEATURE_NAMES } = await import('../src/ml.js');

function modelJson(opts: { samples: number; bias?: number; weights?: Record<string, number> }) {
  const weights: Record<string, number> = {};
  for (const n of FEATURE_NAMES) weights[n] = opts.weights?.[n] ?? 0;
  return JSON.stringify({
    version: 'test-model',
    source: 'labeled',
    trainedAt: 1_780_000_000_000,
    samples: opts.samples,
    finalLoss: 0.1,
    bias: opts.bias ?? 0,
    weights,
  });
}

function writeOutcomes(rows: Array<{ outcome: string }>) {
  writeFileSync(
    OUTCOMES_PATH,
    rows
      .map((r, i) =>
        JSON.stringify({
          ts: 1_780_000_000_000 + i * 60_000,
          alertId: `soc-low-SN-${(i % 5) + 1}`,
          familyKey: 'soc-low',
          outcome: r.outcome,
          severity: 'warning',
          raisedAt: 1_780_000_000_000 + i * 60_000 - 120_000,
        }),
      )
      .join('\n') + '\n',
  );
}

function resetFiles() {
  for (const p of [SHADOW_PATH, BASELINE_PATH, OUTCOMES_PATH]) {
    if (existsSync(p)) rmSync(p);
  }
}

test('F16 — the samples gate: a 13-sample shadow degrades with reason "samples"', () => {
  resetFiles();
  // The live failure state: shadow exists (loadModel prefers it), 13 samples,
  // all-bias weights; no baseline file; no informative outcomes.
  writeFileSync(SHADOW_PATH, modelJson({ samples: 13, bias: 0.586 }));
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.degraded, true, 'a 13-sample shadow must be gated');
  assert.equal(gate.reason, 'samples');
  assert.equal(gate.minTrainingSamples, 100);
});

test('F16 — the samples gate passes a mature model (no other condition firing)', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  // Baseline identical to the shadow → drift 0, well under threshold.
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.degraded, false, `mature identical shadow/baseline must pass; got reason=${gate.reason}`);
});

test('F16 — missing baseline reads driftL2 null (unknown), never a fake measured 0', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250, bias: 0.586 }));
  // No baseline file: pre-fix this reported driftL2 = 0 — a "measured
  // no-drift" verdict for a comparison that never happened, hiding the
  // shadow's actual +0.586 all-bias walk from /api/models/health.
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.driftL2, null, 'no baseline → drift is UNKNOWN, not 0');
  assert.equal(gate.degraded, false, 'unknown drift alone must not degrade');
});

test('F16 — real drift beyond threshold still degrades a mature model', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250, bias: 3.0 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250, bias: 0 })); // L2 = 3.0 > 2.0
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.degraded, true);
  assert.equal(gate.reason, 'drift');
  assert.ok((gate.driftL2 ?? 0) > 2);
});

test('F16 — one-class all-ack outcomes pin precision to null (insufficient evidence), not 1.0', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  // The live pathology: 33 outcomes, 33 acks, zero dismissals — a stream
  // that structurally cannot express a false positive is not a measurement.
  writeOutcomes(Array.from({ length: 33 }, () => ({ outcome: 'ack' })));
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.overallPrecision, null, 'all-ack stream must read null, not a pinned 1.0');
  assert.equal(gate.degraded, false);
});

test('F16 — a dismiss-heavy stream still computes precision and degrades below the floor', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  // 3 real / 12 decided = 0.25 < 0.4 → the precision gate must fire — the
  // informative-evidence guard can never block a genuine sub-threshold
  // stream (precision < 0.4 arithmetically requires dismissals).
  writeOutcomes([
    ...Array.from({ length: 3 }, () => ({ outcome: 'ack' })),
    ...Array.from({ length: 9 }, () => ({ outcome: 'dismiss' })),
  ]);
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.overallPrecision, 0.25);
  assert.equal(gate.degraded, true);
  assert.equal(gate.reason, 'precision');
});

/* ── composite pinning under the samples gate ─────────────────────── */

function riskFixtures() {
  const packs = [1, 2, 3, 4, 5].map((num) => ({ num }));
  const devices = {
    'SN-D': {
      sn: 'SN-D', deviceName: 'Core 1', online: true,
      projection: { kind: 'dpu', packs },
    },
  } as any;
  const heuristic = [1, 2, 3, 4, 5].map((packNum) => ({
    sn: 'SN-D', device: 'Core 1', coreNum: 1, packNum,
    score0to100: 4, tier: 'low', topFactors: [],
  })) as any;
  const emptyDeg = { packs: [] } as any;
  const emptyTherm = { packs: [] } as any;
  const emptyIr = { devices: [] } as any;
  // Pack 5 carries a large charge-curve drift — the live Core3-pk1 pattern
  // that produced novelty=100 from a 16-sample checkpoint.
  const chargeCurve = { packs: [{ sn: 'SN-D', packNum: 5, meanDriftMv: 40 }] } as any;
  return { devices, heuristic, emptyDeg, emptyTherm, emptyIr, chargeCurve };
}

test('F16 — samples-gated composite is the HEURISTIC ALONE: a novelty artifact cannot tier a healthy pack', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 13, bias: 0.586 }));
  const f = riskFixtures();
  const r = computePackRiskV2(f.devices, f.heuristic, f.emptyDeg, f.emptyTherm, f.emptyIr, f.chargeCurve);
  assert.equal(r.degraded, true);
  assert.equal(r.degradeReason, 'samples');
  for (const p of r.packs) {
    assert.equal(
      p.composite0to100, 4,
      `pack ${p.packNum}: samples-gated composite must equal the heuristic (4); got ${p.composite0to100} ` +
        `(novelty=${p.novelty.score0to100}) — mean(heur, heur, novelty) would falsely tier it`,
    );
  }
  // The diagnostic tracks stay fully populated — visibility is not lost.
  const p5 = r.packs.find((p) => p.packNum === 5)!;
  assert.ok(p5.novelty.score0to100 > 50, `pack 5's novelty track still shows the outlier (${p5.novelty.score0to100})`);
});

test('F16 — a mature ungated model blends novelty into the composite again', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  const f = riskFixtures();
  const r = computePackRiskV2(f.devices, f.heuristic, f.emptyDeg, f.emptyTherm, f.emptyIr, f.chargeCurve);
  assert.equal(r.degraded, false);
  const p5 = r.packs.find((p) => p.packNum === 5)!;
  assert.ok(
    p5.composite0to100 > 4,
    `ungated: the novelty outlier must lift pack 5's composite above the bare heuristic; got ${p5.composite0to100}`,
  );
});

test('F16 — below MIN_DECIDED (3), even a mixed stream is not evidence; AT the boundary it is', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  // 2 decided (1 ack + 1 dismiss) < 3 → a single stray dismissal cannot
  // degrade the model by itself.
  writeOutcomes([{ outcome: 'ack' }, { outcome: 'dismiss' }]);
  let gate = computeGateDecision(loadModel());
  assert.equal(gate.overallPrecision, null, '2 decided outcomes are noise, not a precision estimate');
  // Exactly 3 decided with a dismissal IS evidence (>= is inclusive): a short
  // 100%-false-positive streak must be able to degrade — the review proved a
  // 10-outcome floor would have ignored up to 9 straight dismissals.
  writeOutcomes([{ outcome: 'ack' }, { outcome: 'dismiss' }, { outcome: 'dismiss' }]);
  gate = computeGateDecision(loadModel());
  assert.ok(gate.overallPrecision != null, 'exactly MIN_DECIDED with a dismissal counts');
  assert.ok(Math.abs((gate.overallPrecision ?? 0) - 1 / 3) < 1e-9);
  assert.equal(gate.degraded, true, '33% precision < 0.4 must degrade');
  assert.equal(gate.reason, 'precision');
});

/* ── review-driven mutation killers + scoping tests ───────────────── */

test('F16 — a labeled model with EXACTLY the floor count passes (boundary is inclusive)', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 100 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 100 }));
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.degraded, false, `exactly ${gate.minTrainingSamples} samples suffices; got reason=${gate.reason}`);
});

test('F16 — the literal in-code default shape (heuristic-distilled, samples 0) stays ungated', () => {
  resetFiles();
  // No files at all → loadModel returns the in-code default: samples 0,
  // source 'heuristic-distilled'. It mirrors the heuristic by construction —
  // gating it would pin every cold-start install to degraded:'samples'.
  const m = loadModel();
  assert.equal(m.source, 'heuristic-distilled');
  assert.equal(m.samples, 0);
  const gate = computeGateDecision(m);
  assert.equal(gate.degraded, false, 'cold-start default must not be samples-gated');
  assert.equal(gate.reason, undefined);
});

test('F16 — a labels.csv BATCH baseline (~20 samples, source labeled) is the graduation path and passes', () => {
  resetFiles();
  // train-pack-risk writes MODEL_PATH with source 'labeled' and ~one sample
  // per fleet pack (~20-25 here). A converged batch fit must not be
  // permanently gated by a floor written for the online one-class walk.
  writeFileSync(BASELINE_PATH, modelJson({ samples: 20 }));
  const m = loadModel(); // no shadow → serves the baseline, provenance 'baseline'
  assert.equal(m.provenance, 'baseline');
  const gate = computeGateDecision(m);
  assert.equal(gate.degraded, false, `batch-trained baseline must pass the samples gate; got reason=${gate.reason}`);
});

test('F16 — a shadow with a MISSING source field is gated (fail-safe), not silently served', () => {
  resetFiles();
  const noSource = JSON.parse(modelJson({ samples: 3 }));
  delete noSource.source;
  writeFileSync(SHADOW_PATH, JSON.stringify(noSource));
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.degraded, true, "undefined !== 'heuristic-distilled' → the floor applies");
  assert.equal(gate.reason, 'samples');
});

test('F16 — a shadow with a MISSING samples field is gated (undefined < 100 is false — the old shape failed open)', () => {
  resetFiles();
  const noSamples = JSON.parse(modelJson({ samples: 0 }));
  delete noSamples.samples;
  writeFileSync(SHADOW_PATH, JSON.stringify(noSamples));
  const gate = computeGateDecision(loadModel());
  assert.equal(gate.degraded, true);
  assert.equal(gate.reason, 'samples');
});

test('F16 — a mature model degraded for PRECISION keeps novelty in the composite (only the samples gate pins fully)', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  // 2 real / 12 decided = 0.17 < 0.4 → precision degrade on a mature model.
  writeOutcomes([
    ...Array.from({ length: 2 }, () => ({ outcome: 'ack' })),
    ...Array.from({ length: 10 }, () => ({ outcome: 'dismiss' })),
  ]);
  const f = riskFixtures();
  const r = computePackRiskV2(f.devices, f.heuristic, f.emptyDeg, f.emptyTherm, f.emptyIr, f.chargeCurve);
  assert.equal(r.degraded, true);
  assert.equal(r.degradeReason, 'precision');
  const p5 = r.packs.find((p) => p.packNum === 5)!;
  // Trained is pinned to the heuristic, but the mean-of-three (with novelty)
  // is preserved for mature-model degrades — the full pin is samples-only.
  assert.equal(p5.trained.score0to100, 4, 'trained track pinned to heuristic');
  assert.ok(
    p5.composite0to100 > 4,
    `precision-degraded composite must still blend novelty; got ${p5.composite0to100}`,
  );
});

test('F16 — gate knobs are empty-string-safe (the HA options→env bridge exports unset options as "")', () => {
  resetFiles();
  writeFileSync(SHADOW_PATH, modelJson({ samples: 250 }));
  writeFileSync(BASELINE_PATH, modelJson({ samples: 250 }));
  const prev = process.env.PACK_RISK_DRIFT_THRESHOLD;
  const prevP = process.env.PACK_RISK_MIN_PRECISION;
  try {
    process.env.PACK_RISK_DRIFT_THRESHOLD = '';
    process.env.PACK_RISK_MIN_PRECISION = '';
    const gate = computeGateDecision(loadModel());
    // Number('') === 0 would set threshold 0 (degrade on any drift) and
    // minPrecision 0 (precision gate never fires) — reintroducing F16.
    assert.equal(gate.threshold, 2, `empty env must fall back to 2.0; got ${gate.threshold}`);
    assert.equal(gate.minPrecision, 0.4, `empty env must fall back to 0.4; got ${gate.minPrecision}`);
    assert.equal(gate.degraded, false);
  } finally {
    if (prev == null) delete process.env.PACK_RISK_DRIFT_THRESHOLD; else process.env.PACK_RISK_DRIFT_THRESHOLD = prev;
    if (prevP == null) delete process.env.PACK_RISK_MIN_PRECISION; else process.env.PACK_RISK_MIN_PRECISION = prevP;
  }
});
