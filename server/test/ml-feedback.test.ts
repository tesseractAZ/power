import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * v0.9.58 / v0.9.59 ML-feedback tests.
 *
 *   - loadModel:           shadow > baseline > built-in default, with
 *                          mtime-aware cache invalidation.
 *   - computeGateDecision: drift/precision thresholds (auto-downgrade gate).
 *   - computePackRiskV2:   when gate says "degraded", the composite uses
 *                          the heuristic score (no silent score crash).
 *   - snapshotToLrFeatures: captured `lrFeatures` wins over proxy.
 *   - captureLrFeatures:   real 6-D normalized vector at fire time.
 *   - alertTelemetry edge cases (window filter, missing-file guard).
 *
 * Path-override strategy: ml.ts captures MODEL_PATH/SHADOW_PATH at module
 * load via `resolve(cwd, config.dbPath, '..', 'models', ...)`. Setting
 * DB_PATH before the dynamic imports below redirects them into our tmpdir.
 */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'ml-feedback-test-'));
const dbDir = join(tmpRoot, 'db');
// ml.ts resolves model paths as `resolve(cwd, dbPath, '..', 'models', ...)`.
// When dbPath is absolute, `..` walks up from the db FILE (treated by
// path.resolve as a segment), so models lives at dirname(dbPath)/models.
const modelsDir = join(dbDir, 'models');
const dbPath = join(dbDir, 'ecoflow.db');
mkdirSync(dbDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });

const MODEL_PATH = join(modelsDir, 'pack-risk-lr-v1.json');
const SHADOW_PATH = join(modelsDir, 'pack-risk-lr-v1-online.json');

// Critical: env must be set BEFORE the dynamic imports because ml.ts /
// onlineLR.ts / alertOutcomes.ts / alertTelemetry.ts all freeze their
// paths at module-load.
process.env.DB_PATH = dbPath;
process.env.ALERT_OUTCOMES_PATH = join(tmpRoot, 'alert-outcomes.jsonl');
process.env.ALERT_TELEMETRY_PATH = join(tmpRoot, 'alert-telemetry.jsonl');
process.env.FEATURE_SNAPSHOTS_PATH = join(tmpRoot, 'feature-snapshots.jsonl');
// Drift threshold default is 2.0; min precision default is 0.4. Tests
// don't override unless they specifically need a different value.
delete process.env.PACK_RISK_DRIFT_THRESHOLD;
delete process.env.PACK_RISK_MIN_PRECISION;

const ml = await import('../src/ml.js');
const { snapshotToLrFeatures } = await import('../src/models/onlineLR.js');
const { captureLrFeatures } = await import('../src/featureSnapshot.js');
const { appendTelemetryEvent, readRecentTelemetry, readAllTelemetry } =
  await import('../src/alertTelemetry.js');

/** Default baseline shape — mirrors ml.ts DEFAULT_MODEL but reusable for
 *  writing test fixtures into MODEL_PATH/SHADOW_PATH. */
function makeBaseline() {
  return {
    version: 'test-baseline',
    trainedAt: 1_700_000_000_000,
    samples: 100,
    source: 'heuristic-distilled' as const,
    weights: {
      peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
      hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2,
    },
    bias: -2.5,
    finalLoss: 0.1,
  };
}

/** Set a file's mtime explicitly so cache-invalidation tests are deterministic. */
function touchFile(path: string, mtimeMs: number) {
  const t = mtimeMs / 1000;
  utimesSync(path, t, t);
}

/** Wipe both model files so each test starts from a known "no files" state. */
function resetModelFiles() {
  for (const p of [MODEL_PATH, SHADOW_PATH]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/* ─── loadModel ──────────────────────────────────────────────────────── */

test('loadModel — cold start (no files) returns built-in default', () => {
  resetModelFiles();
  const m = ml.loadModel();
  assert.equal(m.version, 'lr-heuristic-baseline-v1-builtin');
  // The built-in default is the safety net documented in the file header.
  assert.equal(m.bias, -2.5);
  assert.ok(m.weights.peerFadeRatio > 0);
});

test('loadModel — baseline file present, no shadow → returns baseline', () => {
  resetModelFiles();
  const baseline = { ...makeBaseline(), version: 'lr-baseline-only-v1' };
  writeFileSync(MODEL_PATH, JSON.stringify(baseline, null, 2));
  const m = ml.loadModel();
  assert.equal(m.version, 'lr-baseline-only-v1');
});

test('loadModel — shadow wins over baseline when both exist', () => {
  resetModelFiles();
  writeFileSync(MODEL_PATH, JSON.stringify({ ...makeBaseline(), version: 'baseline-x' }));
  writeFileSync(
    SHADOW_PATH,
    JSON.stringify({ ...makeBaseline(), version: 'shadow-x', source: 'labeled' as const }),
  );
  const m = ml.loadModel();
  assert.equal(m.version, 'shadow-x', 'shadow path should override baseline');
});

test('loadModel — mtime invalidation: rewriting shadow with newer mtime busts cache', () => {
  resetModelFiles();
  // Prime with a baseline only.
  writeFileSync(MODEL_PATH, JSON.stringify({ ...makeBaseline(), version: 'before-shadow' }));
  const before = ml.loadModel();
  assert.equal(before.version, 'before-shadow');

  // Now write a NEW shadow file with an explicitly-later mtime. The
  // mtime-aware cache check should bust immediately even though the
  // 5-minute TTL has not elapsed — that's the v0.9.58 guarantee.
  const later = Date.now() + 60_000;
  writeFileSync(SHADOW_PATH, JSON.stringify({ ...makeBaseline(), version: 'after-shadow' }));
  touchFile(SHADOW_PATH, later);

  const after = ml.loadModel();
  assert.equal(after.version, 'after-shadow', 'cache should pick up newer shadow file');
});

test('loadModel — rewriting same source file with newer mtime busts the cache', () => {
  resetModelFiles();
  writeFileSync(SHADOW_PATH, JSON.stringify({ ...makeBaseline(), version: 'v1' }));
  const first = ml.loadModel();
  assert.equal(first.version, 'v1');

  // Same file, new content, advance mtime.
  writeFileSync(SHADOW_PATH, JSON.stringify({ ...makeBaseline(), version: 'v2' }));
  touchFile(SHADOW_PATH, Date.now() + 120_000);
  const second = ml.loadModel();
  assert.equal(second.version, 'v2');
});

/* ─── computeGateDecision ────────────────────────────────────────────── */

test('computeGateDecision — cold-start (no shadow, no outcomes) is NOT degraded', () => {
  resetModelFiles();
  // No shadow file; loadShadowModel falls back to the in-code default
  // (which mirrors the baseline supplied here), so drift = 0.
  // No alert outcomes; precision is null.
  const gate = ml.computeGateDecision(makeBaseline());
  assert.equal(gate.degraded, false, 'cold start should not degrade');
  assert.equal(gate.driftL2, 0, 'no drift when shadow matches baseline');
  assert.equal(gate.overallPrecision, null, 'no decided outcomes → null precision');
});

test('computeGateDecision — drift > threshold fires "drift" reason', () => {
  resetModelFiles();
  // v0.9.62 — Drift is now computed as L2 between the on-disk shadow and
  // the on-disk baseline (MODEL_PATH), so both files must exist for the
  // drift branch to engage. Write a baseline at bias=-2.5 and a shadow
  // with bias deliberately pushed to -10 → bias delta = -7.5 → L2 ≥ 7.5,
  // well over the 2.0 default threshold.
  writeFileSync(MODEL_PATH, JSON.stringify({ ...makeBaseline(), version: 'baseline-drift' }));
  const driftedShadow = { ...makeBaseline(), version: 'shadow-drifted', bias: -10 };
  writeFileSync(SHADOW_PATH, JSON.stringify(driftedShadow));
  // Force a fresh load so the in-process module-level cache (if any) is
  // bypassed: touch with a far-future mtime.
  touchFile(MODEL_PATH, Date.now() + 300_000);
  touchFile(SHADOW_PATH, Date.now() + 300_000);

  const gate = ml.computeGateDecision(makeBaseline());
  assert.equal(gate.degraded, true, 'large drift must degrade');
  assert.equal(gate.reason, 'drift');
  assert.ok(gate.driftL2 !== null && gate.driftL2 > 2.0,
    `expected drift > 2.0, got ${gate.driftL2}`);
});

test('computeGateDecision — env override for PACK_RISK_DRIFT_THRESHOLD widens the gate', () => {
  resetModelFiles();
  // Same shape as the previous test (L2 ≈ 7.5), but raise the threshold
  // to 100 so it should NOT fire. v0.9.62: both MODEL_PATH and SHADOW_PATH
  // must exist for the drift comparison to engage.
  writeFileSync(MODEL_PATH, JSON.stringify({ ...makeBaseline(), version: 'baseline-drift-2' }));
  const driftedShadow = { ...makeBaseline(), version: 'shadow-drifted-2', bias: -10 };
  writeFileSync(SHADOW_PATH, JSON.stringify(driftedShadow));
  touchFile(MODEL_PATH, Date.now() + 360_000);
  touchFile(SHADOW_PATH, Date.now() + 360_000);

  const prev = process.env.PACK_RISK_DRIFT_THRESHOLD;
  process.env.PACK_RISK_DRIFT_THRESHOLD = '100';
  try {
    const gate = ml.computeGateDecision(makeBaseline());
    assert.equal(gate.degraded, false, 'threshold 100 should not trigger on L2≈7.5');
    assert.equal(gate.threshold, 100);
  } finally {
    if (prev === undefined) delete process.env.PACK_RISK_DRIFT_THRESHOLD;
    else process.env.PACK_RISK_DRIFT_THRESHOLD = prev;
  }
});

test('computeGateDecision — v0.9.62: drift compares shadow vs on-disk baseline (not arg)', () => {
  // Regression guard for the v0.9.62 fix. Previously `computeGateDecision`
  // compared the shadow to the `model` argument passed in. Since
  // `computePackRiskV2` calls `loadModel()` (shadow-preferred) and passes
  // that as the arg, both ends were the same shadow object → driftL2 was
  // always 0 → drift branch unreachable end-to-end.
  //
  // Post-fix behavior: drift always compares shadow on disk vs baseline on
  // disk, regardless of what's passed in `_model`. Prove it: pass a `model`
  // that LOOKS LIKE the shadow on disk (would produce drift=0 under the
  // old logic), and assert drift is nonzero because the baseline on disk
  // differs.
  resetModelFiles();
  writeFileSync(MODEL_PATH, JSON.stringify({ ...makeBaseline(), version: 'baseline-on-disk' }));
  const driftedShadow = { ...makeBaseline(), version: 'shadow-on-disk', bias: -10 };
  writeFileSync(SHADOW_PATH, JSON.stringify(driftedShadow));
  touchFile(MODEL_PATH, Date.now() + 400_000);
  touchFile(SHADOW_PATH, Date.now() + 400_000);

  // Pass the drifted shadow AS the model arg. Under the old logic this
  // would have made drift = 0 (shadow vs shadow). Under v0.9.62 the arg
  // is ignored and drift is computed against the on-disk baseline at -2.5.
  const gate = ml.computeGateDecision(driftedShadow);
  assert.ok(gate.driftL2 !== null && gate.driftL2 > 2.0,
    `v0.9.62 should ignore _model arg and compare on-disk shadow vs baseline; got drift=${gate.driftL2}`);
  assert.equal(gate.degraded, true, 'drift > 2.0 must degrade');
  assert.equal(gate.reason, 'drift');
});

test('computeGateDecision — no on-disk baseline (only shadow) → drift treated as 0', () => {
  // Cold-start edge case: operator has never run training, so MODEL_PATH
  // doesn't exist, but the shadow has accumulated SGD updates. We have no
  // "true baseline" to compare against — the gate treats drift as 0 (the
  // correct "no comparison possible" answer) so it stays open and lets
  // the precision branch decide on its own.
  resetModelFiles();
  // Shadow only, with bias deliberately far from any reasonable baseline.
  writeFileSync(SHADOW_PATH, JSON.stringify({ ...makeBaseline(), version: 'shadow-orphan', bias: -10 }));
  touchFile(SHADOW_PATH, Date.now() + 440_000);

  const gate = ml.computeGateDecision(makeBaseline());
  assert.equal(gate.driftL2, 0, 'missing baseline → drift defaults to 0, not null');
  assert.equal(gate.degraded, false, 'no baseline + no decided outcomes → gate stays open');
});

/* ─── computePackRiskV2 — degraded gate pins trained → heuristic ─────── */

test('computePackRiskV2 — degraded gate pins trained score to heuristic per pack', () => {
  resetModelFiles();
  // Force the gate to fire by seeding alert-outcomes that all-dismiss
  // ("false-positive" verdicts) → overall precision = 0 < 0.4 threshold.
  //
  // v0.9.62: the drift branch IS also reachable end-to-end now (see the
  // dedicated drift-through-computePackRiskV2 test below). Here we use
  // the precision branch because it's the simplest way to force degraded
  // mode without seeding both MODEL_PATH and SHADOW_PATH.
  const outcomesPath = process.env.ALERT_OUTCOMES_PATH!;
  // Wipe any prior content from earlier tests.
  if (existsSync(outcomesPath)) rmSync(outcomesPath);
  const now = Date.now();
  const dismissEntries = [
    { ts: now, alertId: 'pack-hot-X-1', outcome: 'dismiss', source: {} },
    { ts: now, alertId: 'pack-hot-X-2', outcome: 'dismiss', source: {} },
    { ts: now, alertId: 'pack-hot-X-3', outcome: 'dismiss', source: {} },
  ];
  writeFileSync(
    outcomesPath,
    dismissEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  // Minimal heuristic input — one pack with score 60. Trained should pin
  // to that exact value when degraded.
  const heuristic = [{
    sn: 'TESTSN1',
    device: 'TestDev',
    coreNum: 1,
    packNum: 1,
    score0to100: 60,
    tier: 'attention' as const,
    topFactors: [],
  }];
  // Devices map: one DPU with one pack matching the heuristic entry.
  const devices = {
    TESTSN1: {
      sn: 'TESTSN1',
      deviceName: 'TestDev',
      productName: 'Delta Pro Ultra',
      online: true,
      lastUpdated: Date.now(),
      projection: {
        kind: 'dpu' as const,
        soc: 50,
        packCount: 1,
        packs: [{
          num: 1, soc: 50, soh: 95, actSoh: null, inputWatts: null, outputWatts: null,
          temp: 25, cycles: 100, remainTimeMin: null, packSn: 'TESTPACK1',
          designCapMah: null, fullCapMah: null, remainCapMah: null,
          accuChgMah: null, accuDsgMah: null, cellTemps: [], mosTemps: [], ptcTemps: [],
          hwBoardTemp: null, curResTemp: null, minCellTemp: null, maxCellTemp: null,
          minMosTemp: null, maxMosTemp: null, cellVoltagesMv: [],
          minCellVoltageMv: null, maxCellVoltageMv: null, maxVolDiffMv: null,
          balanceState: null, packVoltageMv: null, adBatVoltageMv: null, ocvMv: null,
        }],
        pvHighWatts: null, pvLowWatts: null, pvTotalWatts: null, pvHighVolts: null,
        pvHighAmps: null, pvLowVolts: null, pvLowAmps: null, pvHighErrCode: null,
        pvLowErrCode: null, acInWatts: null, acOutWatts: null, acOutFreq: null,
        acOutVol: null, batVol: null, batAmp: null, totalInWatts: null, totalOutWatts: null,
        remainTimeMin: null, mpptHvTemp: null, mpptLvTemp: null,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: null, emsParaVolMaxMv: null, emsParaVolMinMv: null,
        chgMaxSoc: null, dsgMinSoc: null,
      },
    },
  };
  // Empty analytics inputs are fine — extractFeatures defaults missing
  // sources to null which the normalizer maps to 0.
  const degradation = { packs: [], generatedAt: 0 } as any;
  const thermalEvents = { packs: [], generatedAt: 0 } as any;
  const internalR = { devices: [], generatedAt: 0 } as any;
  const chargeCurve = { packs: [], generatedAt: 0 } as any;

  const report = ml.computePackRiskV2(
    devices as any,
    heuristic,
    degradation,
    thermalEvents,
    internalR,
    chargeCurve,
  );
  assert.equal(report.degraded, true, 'gate should have fired');
  assert.equal(report.packs.length, 1);
  const entry = report.packs[0];
  // The pin: trained.score0to100 must equal heuristic.score0to100.
  assert.equal(
    entry.trained.score0to100,
    entry.heuristic.score0to100,
    'degraded gate must pin trained → heuristic',
  );
  assert.equal(entry.trained.score0to100, 60);
});

test('computePackRiskV2 — v0.9.62: drift gate fires end-to-end via on-disk baseline vs shadow', () => {
  // v0.9.62 regression guard. The drift branch of the auto-downgrade gate
  // is supposed to fire when shadow weights have wandered far from the
  // trained baseline. Prior to v0.9.62 this was structurally impossible
  // via the public `computePackRiskV2` surface (both sides of the L2 calc
  // resolved to the same shadow object). Now that baseline is read
  // directly from MODEL_PATH, the drift branch IS reachable end-to-end.
  resetModelFiles();
  // Seed both files with a deliberate drift: baseline at bias=-2.5,
  // shadow at bias=-10 → L2 ≥ 7.5 ≫ 2.0 default threshold.
  writeFileSync(MODEL_PATH, JSON.stringify({ ...makeBaseline(), version: 'baseline-e2e' }));
  writeFileSync(
    SHADOW_PATH,
    JSON.stringify({ ...makeBaseline(), version: 'shadow-e2e-drifted', bias: -10 }),
  );
  touchFile(MODEL_PATH, Date.now() + 500_000);
  touchFile(SHADOW_PATH, Date.now() + 500_000);
  // Wipe alert outcomes so precision is null and ONLY the drift branch
  // can drive the degraded verdict — proves the drift path is live.
  const outcomesPath = process.env.ALERT_OUTCOMES_PATH!;
  if (existsSync(outcomesPath)) rmSync(outcomesPath);

  const heuristic = [{
    sn: 'TESTSN2',
    device: 'TestDev2',
    coreNum: 1,
    packNum: 1,
    score0to100: 42,
    tier: 'attention' as const,
    topFactors: [],
  }];
  const devices = {
    TESTSN2: {
      sn: 'TESTSN2',
      deviceName: 'TestDev2',
      productName: 'Delta Pro Ultra',
      online: true,
      lastUpdated: Date.now(),
      projection: {
        kind: 'dpu' as const,
        soc: 50,
        packCount: 1,
        packs: [{
          num: 1, soc: 50, soh: 95, actSoh: null, inputWatts: null, outputWatts: null,
          temp: 25, cycles: 100, remainTimeMin: null, packSn: 'TESTPACK2',
          designCapMah: null, fullCapMah: null, remainCapMah: null,
          accuChgMah: null, accuDsgMah: null, cellTemps: [], mosTemps: [], ptcTemps: [],
          hwBoardTemp: null, curResTemp: null, minCellTemp: null, maxCellTemp: null,
          minMosTemp: null, maxMosTemp: null, cellVoltagesMv: [],
          minCellVoltageMv: null, maxCellVoltageMv: null, maxVolDiffMv: null,
          balanceState: null, packVoltageMv: null, adBatVoltageMv: null, ocvMv: null,
        }],
        pvHighWatts: null, pvLowWatts: null, pvTotalWatts: null, pvHighVolts: null,
        pvHighAmps: null, pvLowVolts: null, pvLowAmps: null, pvHighErrCode: null,
        pvLowErrCode: null, acInWatts: null, acOutWatts: null, acOutFreq: null,
        acOutVol: null, batVol: null, batAmp: null, totalInWatts: null, totalOutWatts: null,
        remainTimeMin: null, mpptHvTemp: null, mpptLvTemp: null,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: null, emsParaVolMaxMv: null, emsParaVolMinMv: null,
        chgMaxSoc: null, dsgMinSoc: null,
      },
    },
  };
  const degradation = { packs: [], generatedAt: 0 } as any;
  const thermalEvents = { packs: [], generatedAt: 0 } as any;
  const internalR = { devices: [], generatedAt: 0 } as any;
  const chargeCurve = { packs: [], generatedAt: 0 } as any;

  const report = ml.computePackRiskV2(
    devices as any,
    heuristic,
    degradation,
    thermalEvents,
    internalR,
    chargeCurve,
  );
  assert.equal(report.degraded, true, 'drift > 2.0 must fire degraded mode end-to-end');
  assert.equal(report.degradeReason, 'drift', 'reason must be drift (precision is null)');
  assert.ok(
    report.gateDecision!.driftL2 !== null && report.gateDecision!.driftL2 > 2.0,
    `drift must be measurable and over threshold; got ${report.gateDecision!.driftL2}`,
  );
  assert.equal(report.gateDecision!.overallPrecision, null, 'no outcomes seeded → null');
  // Pin: trained should equal heuristic since gate degraded.
  assert.equal(report.packs[0].trained.score0to100, report.packs[0].heuristic.score0to100);
});

/* ─── snapshotToLrFeatures — captured wins over proxy ────────────────── */

test('snapshotToLrFeatures — prefers captured lrFeatures over proxy reconstruction', () => {
  // Build a proxy-feature snapshot that would yield specific values.
  const snapshot: Record<string, number> = {
    pack_vol_diff_mv: 50,      // would make peerFadeRatio=0.5 + ccDriftMv=0.5
    pack_temp_c: 45,           // would make rTrend=0.5 (KNOWN-BAD proxy)
    pack_cycles: 1000,         // would make hardLifeScore=0.5
    pack_soh: 87.5,            // would make fadePctPerYear=0.5
  };
  // Captured vector with DIFFERENT, deliberate values.
  const captured = {
    peerFadeRatio: 0.95, rTrend: 0.05, coulombicEffPct: 0.42,
    hardLifeScore: 0.13, ccDriftMv: 0.08, fadePctPerYear: 0.27,
  };
  const out = snapshotToLrFeatures(snapshot, captured);
  assert.ok(out);
  // Each field should be the captured value, not the proxy-derived value.
  assert.equal(out!.peerFadeRatio, 0.95, 'captured wins, NOT proxy 0.5');
  assert.equal(out!.rTrend, 0.05, 'captured wins, NOT proxy 0.5');
  assert.equal(out!.coulombicEffPct, 0.42, 'captured wins, NOT proxy 0');
  assert.equal(out!.hardLifeScore, 0.13);
  assert.equal(out!.ccDriftMv, 0.08);
  assert.equal(out!.fadePctPerYear, 0.27);
});

test('snapshotToLrFeatures — falls back to proxy when captured is null', () => {
  const snapshot: Record<string, number> = {
    pack_vol_diff_mv: 100,   // peerFadeRatio = ccDriftMv = 1.0
    pack_temp_c: 60,         // rTrend = 1.0
    pack_cycles: 2000,       // hardLifeScore = 1.0
    pack_soh: 75,            // fadePctPerYear = 1.0
  };
  const out = snapshotToLrFeatures(snapshot, null);
  assert.ok(out);
  assert.equal(out!.peerFadeRatio, 1.0);
  assert.equal(out!.ccDriftMv, 1.0);
  assert.equal(out!.rTrend, 1.0);
  assert.equal(out!.hardLifeScore, 1.0);
  assert.equal(out!.fadePctPerYear, 1.0);
  // Documented gap: coulombicEffPct has no snapshot proxy → always 0.
  assert.equal(out!.coulombicEffPct, 0);
});

test('snapshotToLrFeatures — empty captured object falls through to proxy', () => {
  const snapshot: Record<string, number> = { pack_vol_diff_mv: 50 };
  const out = snapshotToLrFeatures(snapshot, {});
  assert.ok(out);
  // Empty captured object → no hasAny → uses proxy logic
  assert.equal(out!.peerFadeRatio, 0.5, '50/100 mV proxy');
});

test('snapshotToLrFeatures — no snapshot AND no captured returns null', () => {
  assert.equal(snapshotToLrFeatures(undefined, null), null);
  assert.equal(snapshotToLrFeatures(undefined), null);
});

/* ─── captureLrFeatures — real 6-D vector at fire time ───────────────── */

test('captureLrFeatures — non-pack alert (no packNum) returns null', async () => {
  const alert: any = {
    id: 'system-x', severity: 'warning', category: 'SHP2', device: 'SHP2-1', title: '', detail: '',
    packNum: null,
  };
  const snap: any = { generatedAt: 0, devices: {} };
  const recorder: any = {};
  const out = await captureLrFeatures(alert, snap, recorder);
  assert.equal(out, null, 'no packNum means nothing for the pack-risk LR to learn');
});

test('captureLrFeatures — pack alert with unknown device returns null', async () => {
  const alert: any = {
    id: 'pack-hot-FAKE-1', severity: 'warning', category: 'Thermal',
    device: 'FakeDev', title: '', detail: '', packNum: 1,
  };
  const snap: any = { generatedAt: 0, devices: {} };
  const recorder: any = {};
  const out = await captureLrFeatures(alert, snap, recorder);
  assert.equal(out, null, 'device cannot be resolved → null');
});

test('captureLrFeatures — pack alert on a known DPU returns a 6-D normalized vector', async () => {
  // Minimal DPU snapshot. The analytics functions will receive an
  // effectively-empty recorder and produce sparse outputs; the resulting
  // FeatureVector will have null raw values that normalize to 0. The
  // shape contract (6 fields, all numbers, in FEATURE_NAMES order) is
  // what we're verifying here — same code path as inference.
  const snap: any = {
    generatedAt: Date.now(),
    devices: {
      DPU1: {
        sn: 'DPU1',
        deviceName: 'Delta Pro Ultra 1',
        productName: 'Delta Pro Ultra',
        online: true,
        lastUpdated: Date.now(),
        projection: { kind: 'dpu', soc: 50, packCount: 1, packs: [{ num: 1, soc: 50 }] },
      },
    },
  };
  // Recorder stub that returns nothing for every query. computeDegradation
  // is async (it hits the DB / recorder) so we provide both shapes; the
  // empty returns make the analytics output empty arrays, which is fine.
  const recorder: any = {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: () => new Map(),
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  };
  const alert: any = {
    id: 'pack-hot-DPU1-1', severity: 'warning', category: 'Thermal',
    device: 'DPU1', title: '', detail: '', packNum: 1,
  };
  const out = await captureLrFeatures(alert, snap, recorder);
  assert.ok(out, 'pack alert on a known DPU should return a vector');
  // The vector must have the exact 6 FEATURE_NAMES keys, all finite numbers.
  for (const name of ml.FEATURE_NAMES) {
    assert.ok(name in out!, `missing feature ${name}`);
    assert.ok(typeof out![name] === 'number' && Number.isFinite(out![name]),
      `feature ${name} must be a finite number, got ${out![name]}`);
    // Normalized space is [0, 1].
    assert.ok(out![name] >= 0 && out![name] <= 1, `${name} must be in [0,1]`);
  }
});

/* ─── alertTelemetry edge cases (additive — main suite is in
        alertTelemetry.test.ts) ───────────────────────────────────────── */

test('alertTelemetry — 30-day window filter drops a 31-day-old event', () => {
  // Fresh path for this test so we don't tangle with main alertTelemetry.test.ts
  const isolated = join(tmpRoot, 'tele-30d.jsonl');
  const prev = process.env.ALERT_TELEMETRY_PATH;
  process.env.ALERT_TELEMETRY_PATH = isolated;
  try {
    // The alertTelemetry module captured its PATH at import time, so the
    // env swap above only affects this isolated tmp area for nothing in
    // the already-imported module. The proper edge-case we can test
    // against the existing import: a far-old event vs. a fresh event in
    // the SAME path the module imported.
    process.env.ALERT_TELEMETRY_PATH = prev!;
    // Append a 31-day-old event AND a fresh event into the imported path.
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    appendTelemetryEvent({
      familyKey: 'edge-old', alertId: 'edge-old-1', event: 'rise', ts: old,
    });
    appendTelemetryEvent({
      familyKey: 'edge-fresh', alertId: 'edge-fresh-1', event: 'rise', ts: Date.now(),
    });
    // Default window is 30 days — old should be excluded.
    const recent = readRecentTelemetry();
    assert.ok(!recent.some((e) => e.familyKey === 'edge-old'),
      '31-day-old event must be filtered out');
    assert.ok(recent.some((e) => e.familyKey === 'edge-fresh'),
      'fresh event must be present');
  } finally {
    process.env.ALERT_TELEMETRY_PATH = prev;
  }
});

test('alertTelemetry — custom narrow window keeps only entries within it', () => {
  appendTelemetryEvent({
    familyKey: 'edge-window', alertId: 'edge-window-1',
    event: 'shortClear', ts: Date.now(), durationMs: 1234,
  });
  // 100 ms window — should at least contain the very fresh entry we
  // just appended; readAll should always contain it too.
  const narrow = readRecentTelemetry(60_000);
  const all = readAllTelemetry();
  assert.ok(all.some((e) => e.alertId === 'edge-window-1'));
  // The fresh entry is well within a 60 s window.
  assert.ok(narrow.some((e) => e.alertId === 'edge-window-1'));
});

/* ─── cleanup ──────────────────────────────────────────────────────── */

test('cleanup tmp dir', () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
