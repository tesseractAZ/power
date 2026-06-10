import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * v0.15.12 — regression tests for the adversarially-verified anomaly fixes.
 *
 * 1. cmdId 4 bpPwr sign convention (mqttTranslate.ts). Validated live on an
 *    off-grid discharging fleet: every pack reported NEGATIVE bpPwr while
 *    SoC fell fleet-wide, the same core's cmdId 2 showed bmsOutputWatts ≈
 *    Σ|bpPwr| (bmsInputWatts=0), and cmdId 28's native fields showed
 *    outputWatts=|bpPwr|. So: negative = discharging. The previous mapping
 *    was inverted, flapping fleet_battery_net_watts against cmdId 28/REST
 *    writes and violating conservation by ~4 kW.
 *
 * 2. Worker lifetime totals (readRecorder.ts). getLifetimeTotals() was a {}
 *    stub, zeroing carbon_lifetime_kg_avoided / miles_not_driven while
 *    pv_lifetime_kwh=889 sat in the same payload. Now reads the persisted
 *    lifetime_totals table.
 *
 * 3. ML fade-feature maturity gate (ml.ts). extractFeatures consumed the raw
 *    early-fit fade slope: a fresh pack 18 days in showed 22.1 %/yr of fit
 *    noise (status='learning') and ranked most-at-risk. Fade features are
 *    null unless the degradation engine itself trusts the fit
 *    (status==='projecting').
 *
 * 4. onlineLR finalLoss (models/onlineLR.ts). Was a hardcoded 0 from the
 *    shadow-init template — published as a perfect-fit training loss. Now a
 *    prequential log-loss EMA computed at each online step.
 */

/* ─── path bootstrap for onlineLR (must precede the dynamic import) ───── */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'anomaly-fixes-v1512-'));
const dbDir = join(tmpRoot, 'db');
const modelsDir = join(dbDir, 'models');
mkdirSync(modelsDir, { recursive: true });
process.env.DB_PATH = join(dbDir, 'ecoflow.db');
const SHADOW_PATH = join(modelsDir, 'pack-risk-lr-v1-online.json');

const { translateDpuMqtt } = await import('../src/ecoflow/mqttTranslate.js');
const { createReadRecorder } = await import('../src/readRecorder.js');
const { extractFeatures } = await import('../src/ml.js');
const { updateFromOutcome } = await import('../src/models/onlineLR.js');

/* ─── 1. bpPwr sign convention ────────────────────────────────────────── */

test('cmdId4 bpPwr — negative = discharging → outputWatts', () => {
  const out = translateDpuMqtt(4, { bpInfo: [{ bpNo: 1, bpPwr: -329, bpSoc: 67 }] }, undefined)!;
  assert.equal(out['hs_yj751_bms_slave_addr.1.outputWatts'], 329);
  assert.equal(out['hs_yj751_bms_slave_addr.1.inputWatts'], 0);
  assert.equal(out['hs_yj751_bms_slave_addr.1.soc'], 67);
});

test('cmdId4 bpPwr — positive = charging → inputWatts', () => {
  const out = translateDpuMqtt(4, { bpInfo: [{ bpNo: 3, bpPwr: 412 }] }, undefined)!;
  assert.equal(out['hs_yj751_bms_slave_addr.3.inputWatts'], 412);
  assert.equal(out['hs_yj751_bms_slave_addr.3.outputWatts'], 0);
});

test('cmdId4 bpPwr — zero = idle → both fields 0', () => {
  const out = translateDpuMqtt(4, { bpInfo: [{ bpNo: 2, bpPwr: 0 }] }, undefined)!;
  assert.equal(out['hs_yj751_bms_slave_addr.2.outputWatts'], 0);
  assert.equal(out['hs_yj751_bms_slave_addr.2.inputWatts'], 0);
});

test('cmdId4 bpPwr — fleet net reconstructed from a real discharging trace is positive', () => {
  // The exact bpInfo observed live (Core 3, off-grid, AC out 1195 W, SoC falling).
  const bpInfo = [
    { bpNo: 1, bpPwr: -329 }, { bpNo: 2, bpPwr: -296 }, { bpNo: 3, bpPwr: -268 },
    { bpNo: 4, bpPwr: -238 }, { bpNo: 5, bpPwr: -225 },
  ];
  const out = translateDpuMqtt(4, { bpInfo }, undefined)!;
  let net = 0;
  for (let i = 1; i <= 5; i++) {
    net += (out[`hs_yj751_bms_slave_addr.${i}.outputWatts`] as number)
         - (out[`hs_yj751_bms_slave_addr.${i}.inputWatts`] as number);
  }
  // positive = discharging; must ≈ the cmdId 2 bmsOutputWatts (1377) observed
  // on the same core at the same moment.
  assert.equal(net, 1356);
});

/* ─── 2. worker lifetime totals ───────────────────────────────────────── */

test('readRecorder — getLifetimeTotals reads the persisted accumulator table', () => {
  const path = join(tmpRoot, 'lifetime.db');
  try { unlinkSync(path); } catch { /* */ }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE samples (ts INTEGER, sn TEXT, metric TEXT, value REAL);
    CREATE INDEX idx ON samples (sn, metric, ts);
    CREATE TABLE lifetime_totals (
      metric_key TEXT PRIMARY KEY,
      wh REAL NOT NULL DEFAULT 0,
      last_integrated_ts INTEGER NOT NULL DEFAULT 0
    );`);
  db.prepare('INSERT INTO lifetime_totals VALUES (?,?,?)').run('fleet_pv_wh', 889455, 1781050000000);
  db.prepare('INSERT INTO lifetime_totals VALUES (?,?,?)').run('fleet_load_wh', 880840, 1781050000000);
  db.close();

  const rec = createReadRecorder(path);
  const totals = rec.getLifetimeTotals();
  assert.equal(totals.fleet_pv_wh.persistedWh, 889455);
  assert.equal(totals.fleet_pv_wh.pendingWh, 0); // worker has no live integral
  assert.equal(totals.fleet_pv_wh.watermarkMs, 1781050000000);
  assert.equal(totals.fleet_load_wh.persistedWh, 880840);
  rec.close();
  unlinkSync(path);
});

/* ─── 3. fade-feature maturity gate ───────────────────────────────────── */

function degWith(status: string) {
  return {
    packs: [{
      sn: 'CORE3', packNum: 2, status,
      fadePctPerYear: 22.12, peerFadeRatio: 1.9, coulombicEffPct: 99.1,
    }],
  } as any;
}
const emptyReports = {
  therm: { packs: [] } as any,
  ir: { devices: [] } as any,
  cc: { packs: [] } as any,
};

test('extractFeatures — immature (learning) fade is nulled, mature (projecting) passes', () => {
  const learning = extractFeatures('CORE3', 2, degWith('learning'), emptyReports.therm, emptyReports.ir, emptyReports.cc);
  assert.equal(learning.values.fadePctPerYear, null, 'learning-status fade must be unknown');
  assert.equal(learning.values.peerFadeRatio, null, 'learning-status peer ratio must be unknown');
  assert.equal(learning.normalized.fadePctPerYear, 0, 'null normalizes to neutral 0');
  // Non-fade features are NOT gated by degradation maturity.
  assert.equal(learning.values.coulombicEffPct, 99.1);

  const projecting = extractFeatures('CORE3', 2, degWith('projecting'), emptyReports.therm, emptyReports.ir, emptyReports.cc);
  assert.equal(projecting.values.fadePctPerYear, 22.12);
  assert.equal(projecting.values.peerFadeRatio, 1.9);
});

/* ─── 4. onlineLR real prequential loss ───────────────────────────────── */

const FEATURES = ['peerFadeRatio', 'rTrend', 'coulombicEffPct', 'hardLifeScore', 'ccDriftMv', 'fadePctPerYear'] as const;

test('onlineLR — finalLoss becomes a real positive log-loss after an online step', () => {
  writeFileSync(SHADOW_PATH, JSON.stringify({
    version: 'test-baseline', trainedAt: 1_700_000_000_000, samples: 7,
    source: 'heuristic-distilled',
    weights: { peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9, hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2 },
    bias: -2.5, finalLoss: 0,
  }, null, 2));

  const lrFeatures = Object.fromEntries(FEATURES.map((n) => [n, 0.5]));
  const res = updateFromOutcome({
    ts: Date.now(), alertId: 'loss-test', outcome: 'ack', lrFeatures, source: {},
  } as any);
  assert.equal(res.updated, true);

  const after = JSON.parse(readFileSync(SHADOW_PATH, 'utf-8'));
  // ack → label 1; pre-update prob = sigmoid(-2.5 + 0.5·Σw) = sigmoid(0.5) ≈ 0.6225
  // sample loss = −ln(0.6225) ≈ 0.4741; seeds finalLoss directly (was 0).
  assert.ok(after.finalLoss > 0, 'finalLoss must be a real positive loss, not the hardcoded 0');
  assert.ok(Math.abs(after.finalLoss - 0.4741) < 0.001, `expected ≈0.4741, got ${after.finalLoss}`);

  // Second step: EMA smooths toward the new sample loss.
  const res2 = updateFromOutcome({
    ts: Date.now(), alertId: 'loss-test-2', outcome: 'ack', lrFeatures, source: {},
  } as any);
  assert.equal(res2.updated, true);
  const after2 = JSON.parse(readFileSync(SHADOW_PATH, 'utf-8'));
  assert.ok(after2.finalLoss > 0 && Number.isFinite(after2.finalLoss));
  assert.ok(after2.finalLoss < after.finalLoss + 0.01, 'EMA must not blow up');
});
