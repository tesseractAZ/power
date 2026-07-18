import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENSORS, BINARY_SENSORS } from '../src/mqttDiscovery.js';
// WS1 (nightChargeAdvisor.ts) + WS3 (nightChargeGate.ts) supply these at
// integration; the interop names are frozen by the shared build contract.
import { nightChargeStateFields } from '../src/nightChargeAdvisor.js';
import type { NightChargePlan } from '../src/nightChargeAdvisor.js';
import { nightChargeGateFields } from '../src/nightChargeGate.js';
import { buildNightChargeMessage } from '../src/notify.js';

/**
 * WS5 (MQTT + notify) tests for the night-charge advisory surfaces.
 *
 * The load-bearing guard here is the value_template ↔ state-field contract:
 * HA's MQTT discovery keys entities on opaque `value_template` strings. If a
 * night-charge discovery config references a `value_json.<key>` that
 * nightChargeStateFields / nightChargeGateFields never emit, the entity sits at
 * "unknown" forever and logs a template warning every publish (exactly the
 * pv_curtailment_* regression this repo already pins for the core buildState).
 * This test fails CI instead, keeping the two ends welded.
 */

/** Extract every `value_json.<key>` a config's value_template references. */
function referencedKeys(value_template: string): string[] {
  return [...value_template.matchAll(/value_json\.([a-z0-9_]+)/g)].map((m) => m[1]);
}

const NIGHT_CHARGE_SENSORS = SENSORS.filter((s) => s.unique_id.startsWith('ecoflow_night_charge_'));
const NIGHT_CHARGE_BINARY = BINARY_SENSORS.filter((s) => s.unique_id.startsWith('ecoflow_night_charge_'));

test('night-charge: the expected 5 sensors + 2 binary_sensors are registered', () => {
  const sensorIds = NIGHT_CHARGE_SENSORS.map((s) => s.unique_id).sort();
  assert.deepEqual(sensorIds, [
    'ecoflow_night_charge_buy_kwh',
    'ecoflow_night_charge_readiness',
    'ecoflow_night_charge_target_soc',
    'ecoflow_night_charge_window_end',
    'ecoflow_night_charge_window_start',
  ]);
  const binaryIds = NIGHT_CHARGE_BINARY.map((s) => s.unique_id).sort();
  assert.deepEqual(binaryIds, [
    'ecoflow_night_charge_recommended',
    'ecoflow_night_charge_write_ready',
  ]);
});

test('night-charge: every value_json key a discovery config references IS emitted by the state/gate fields', () => {
  // Produced with NULL plan + NULL readiness — the fields must still emit EVERY
  // key (numeric fields null, booleans strictly false), so a data gap reads
  // 'unknown'/OFF rather than referencing a missing key.
  const produced = {
    ...nightChargeStateFields(null),
    ...nightChargeGateFields(null),
  };
  const producedKeys = new Set(Object.keys(produced));

  const referenced = new Set<string>();
  for (const cfg of [...NIGHT_CHARGE_SENSORS, ...NIGHT_CHARGE_BINARY]) {
    for (const k of referencedKeys(cfg.value_template)) referenced.add(k);
  }
  // Sanity: the night-charge configs actually reference the expected namespace.
  assert.ok(referenced.has('charge_tonight'), 'recommended binary must read value_json.charge_tonight');
  assert.ok(referenced.has('night_charge_write_ready'), 'write-ready binary must read value_json.night_charge_write_ready');
  assert.ok(referenced.size >= 7, 'expected at least 7 referenced night-charge keys');

  const missing = [...referenced].filter((k) => !producedKeys.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `night-charge discovery configs reference value_json keys the state/gate fields never emit: ${missing.join(', ')}`,
  );
});

test('night-charge: sensors carry NO device_class and a long expire_after (I12)', () => {
  for (const s of NIGHT_CHARGE_SENSORS) {
    assert.equal(s.device_class, undefined, `${s.unique_id} must have no device_class (contract §4.1)`);
    assert.ok((s.expire_after ?? 0) >= 80_000, `${s.unique_id} must carry the ~25 h expire_after so a dead advisor goes UNAVAILABLE`);
  }
  // buy_kwh specifically must NOT be device_class:energy (a target, not an accumulation).
  const buy = NIGHT_CHARGE_SENSORS.find((s) => s.unique_id === 'ecoflow_night_charge_buy_kwh');
  assert.ok(buy && buy.unit_of_measurement === 'kWh' && buy.device_class === undefined);
  for (const s of NIGHT_CHARGE_BINARY) {
    assert.equal(s.device_class, undefined, `${s.unique_id} must have no device_class`);
    assert.ok((s.expire_after ?? 0) >= 80_000, `${s.unique_id} must carry the ~25 h expire_after`);
  }
});

test('night-charge: charge_tonight is STRICTLY false for a null plan (never null-as-true)', () => {
  const fields = nightChargeStateFields(null);
  assert.strictEqual(fields.charge_tonight, false);
  // Numeric fields must be null (→ HA 'unknown'), never a fabricated number.
  assert.strictEqual(fields.night_charge_target_soc_percent, null);
  assert.strictEqual(fields.night_charge_buy_kwh, null);
  assert.strictEqual(fields.night_charge_window_start, null);
  assert.strictEqual(fields.night_charge_window_end, null);
});

test('night-charge: write_ready is STRICTLY false for a null readiness (fail-closed)', () => {
  const fields = nightChargeGateFields(null);
  assert.strictEqual(fields.night_charge_write_ready, false);
  assert.equal(typeof fields.night_charge_readiness, 'string');
});

// ── buildNightChargeMessage (design §4.2) ───────────────────────────────────

function fakePlan(overrides: Partial<NightChargePlan> = {}): NightChargePlan {
  return {
    generatedAt: Date.now(),
    basisComplete: true,
    objective: 'resilience_cushion',
    chargeTonight: true,
    buyKwh: 12.3,
    targetSocPct: 78,
    requiredExtraKwh: 10.1,
    bindingCap: 'requirement',
    cushionShortfall: false,
    minProjSocPct: 26.4,
    minProjSocTsMs: Date.now() + 8 * 3_600_000,
    baselineMinSocPct: 7.2,
    confidenceTier: 'forecast',
    window: { startMs: 1, endMs: 2 },
    reserveFloorPct: 10,
    cushionPct: 15,
    rationale: 'test',
    ...overrides,
  };
}

test('night-charge message: all shapes are severity=info + dedupId=night_charge_plan', () => {
  for (const shape of ['charge', 'hold', 'insufficient_basis'] as const) {
    const msg = buildNightChargeMessage(fakePlan(), shape);
    assert.equal(msg.severity, 'info');
    assert.equal(msg.dedupId, 'night_charge_plan');
    assert.ok(msg.title.length > 0 && msg.body.length > 0);
  }
});

test('night-charge message: a null plan yields the insufficient_basis shape regardless of requested shape', () => {
  for (const shape of ['charge', 'hold', 'insufficient_basis'] as const) {
    const msg = buildNightChargeMessage(null, shape);
    assert.match(msg.body, /incomplete/i);
    assert.match(msg.body, /nothing will be charged/i);
    // Must never fabricate a buy on a null plan.
    assert.doesNotMatch(msg.body, /Buy ~/);
  }
});

test('night-charge message: the charge shape states buy, target, without/with dip, floor+cushion, confidence, and the advisory note', () => {
  const msg = buildNightChargeMessage(fakePlan(), 'charge');
  assert.match(msg.body, /12\.3 kWh/); // buy kWh
  assert.match(msg.body, /78%/);       // target SoC
  assert.match(msg.body, /7\.2%/);     // tomorrow's dip WITHOUT the buy (baseline)
  assert.match(msg.body, /26\.4%/);    // dip WITH the buy (plan trajectory)
  assert.match(msg.body, /25%/);       // floor (10) + cushion (15)
  assert.match(msg.body, /forecast/);  // confidence tier
  // Advisory-only automation contract — the crux of the read-only posture.
  assert.match(msg.body, /Advisory only/);
  assert.match(msg.body, /charge_tonight/);
  assert.match(msg.body, /night_charge_write_ready/);
  assert.match(msg.body, /night_charge_window_start/);
});

test('night-charge message: the hold shape says no charge is needed and reports the trough vs floor+cushion', () => {
  const msg = buildNightChargeMessage(fakePlan({ chargeTonight: false, minProjSocPct: 41.0 }), 'hold');
  assert.match(msg.body, /No overnight charge needed/i);
  assert.match(msg.body, /41%/);
  assert.match(msg.body, /25%/); // floor+cushion
  assert.doesNotMatch(msg.body, /Buy ~/);
});

test('night-charge message: cushion-shortfall and over-buy caveats surface in the charge body', () => {
  const shortfall = buildNightChargeMessage(fakePlan({ cushionShortfall: true, bindingCap: 'chargePower' }), 'charge');
  assert.match(shortfall.body, /residual risk remains/i);

  const overBuy = buildNightChargeMessage(fakePlan({ bindingCap: 'overBuy' }), 'charge');
  assert.match(overBuy.body, /clip is accepted/i);
});
