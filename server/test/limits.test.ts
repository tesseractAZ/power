import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OPTIONS, DECLARED_DIVERGENCES, option } from '../src/config.js';
import {
  limits, RESERVE_FALLBACK_PCT, MPC_RESERVE_FALLBACK_PCT, CONSOLE_RESERVE_FALLBACK_PCT,
  EV_SESSION_FALLBACK_KWH, EV_LIVE_MAX_REMAINING_H, SOC_HEALTHY_BASELINE_PCT, EV_CHARGER_COUNT_DEFAULT,
} from '../src/limits.js';
import {
  planChargeCapKw, forceChargeRateKw, forceChargeKwPerCore, planRateFallbackKw, forceChargeStartAtMs,
  FORCE_CHARGE_PROVEN_KW_PER_SLOT, FORCE_CHARGE_PLAN_RATE_KW, LEGACY_CHARGE_CAP_KW, FORCE_CHARGE_JIT_BUFFER_MS,
} from '../src/nightForceCharge.js';
import { withEnv } from './golden/support/env.js';

/**
 * v1.191.0 (S9) — lane E: the plant limits bridged as schema-only add-on options.
 *
 * For each of the fifteen keys: the bridge carries it (schema-only and optional in config.yaml,
 * exported only under has_value, an `option` row in config.ts), its schema range equals its code
 * clamp (CA10), unset it reads exactly today's value (golden G8 pins the same from the module side),
 * and a set value reaches the consumer. The last one is the regression this repository has shipped
 * three times: a key wired everywhere except the line that reads it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = readFileSync(resolve(ROOT, 'ecoflow_panel/config.yaml'), 'utf8');
const RUN = readFileSync(resolve(ROOT, 'rootfs/etc/services.d/ecoflow-panel/run'), 'utf8');
const SRC = resolve(ROOT, 'server/src');

export const LANE_E_KEYS = [
  'EV_MAX_LOAD_W', 'EV_CHARGER_COUNT', 'EV_PLATEAU_MIN_W', 'EV_CIRCUITS',
  'FORCE_CHARGE_KW_PER_CORE', 'RUNWAY_POOL_OVERHEAD_FLOOR_W', 'RUNWAY_CORE_OVERHEAD_W', 'BMS_RESEED_MIN_GAP_WH',
  'CAPACITY_SCALE_MIN', 'FORECAST_NIGHT_START_HOUR', 'FORECAST_NIGHT_END_HOUR', 'GRID_CO2_INTENSITY_LB_PER_MWH',
  'CYCLING_BASE_WEAR_USD_PER_KWH', 'OPPORTUNISTIC_LOADS', 'BATTERY_SOC_LADDER',
] as const;
const UNSET = Object.fromEntries([...LANE_E_KEYS, 'RUNWAY_DRAIN_MARGINAL_EFFICIENCY', 'RUNWAY_DISCHARGE_EFFICIENCY',
  'BMS_RESEED_SUSTAINED_ROLLUPS', 'BATTERY_SOC_MAX_DROP_PCT', 'ARB_MIN_BUY_KWH'].map((k) => [k, undefined]));

function block(name: 'options' | 'schema'): Map<string, string> {
  const i = CONFIG.indexOf(`\n${name}:`);
  const text = CONFIG.slice(i + 1);
  const end = text.search(/\n[a-z]/);
  const out = new Map<string, string>();
  for (const m of (end < 0 ? text : text.slice(0, end)).matchAll(/^  ([A-Z][A-Z0-9_]+):(.*)$/gm)) out.set(m[1], m[2].trim().replace(/^"|"$/g, ''));
  return out;
}
const SCHEMA = block('schema');
const DEFAULTS = block('options');

/** `int(a,b)?` / `float(a,)?` → { min, max } with an open side undefined; null for an unranged schema. */
function schemaRange(schema: string): { min?: number; max?: number } | null {
  const m = /^(?:int|float)\((-?[\d.]*),(-?[\d.]*)\)\??$/.exec(schema);
  if (!m) return null;
  return { ...(m[1] !== '' ? { min: Number(m[1]) } : {}), ...(m[2] !== '' ? { max: Number(m[2]) } : {}) };
}

/* ── the bridge, per key ─────────────────────────────────────────────────────────────────── */

test('★ every lane E key is schema-only and optional, exported only when set, and an option row', () => {
  for (const key of LANE_E_KEYS) {
    const schema = SCHEMA.get(key);
    assert.ok(schema, `${key}: no schema entry in config.yaml`);
    assert.ok(schema.endsWith('?'), `${key}: a schema-only key must be optional`);
    assert.ok(!DEFAULTS.has(key), `${key}: a new key has no options: default (it would reach every stored configuration)`);
    assert.ok(RUN.includes(`if bashio::config.has_value '${key}'; then export ${key}="$(bashio::config '${key}')"; fi`),
      `${key}: the run script must export it only under has_value`);
    const row = OPTIONS[key];
    assert.ok(row, `${key}: no OPTIONS row`);
    assert.equal(row.source, 'option');
    assert.equal(row.exportForm, 'has_value');
  }
});

test('★ each lane E key\'s schema range equals its code clamp, or the difference is declared (CA10)', () => {
  const declared = new Set(DECLARED_DIVERGENCES.filter((d) => d.kind === 'clamp').map((d) => d.key));
  for (const key of LANE_E_KEYS) {
    const range = schemaRange(SCHEMA.get(key)!);
    const clamp = OPTIONS[key].clamp ?? null;
    const same = JSON.stringify(range ?? null) === JSON.stringify(clamp && { ...(clamp.min !== undefined ? { min: clamp.min } : {}), ...(clamp.max !== undefined ? { max: clamp.max } : {}) });
    assert.ok(same || declared.has(key), `${key}: schema ${SCHEMA.get(key)} vs clamp ${JSON.stringify(clamp)}`);
    assert.ok(!declared.has(key), `${key}: a lane E key's range is chosen to equal its clamp; no declaration is needed`);
  }
  // The four the critic named: open-ended where the code clamps one side only; float where it takes decimals.
  assert.equal(SCHEMA.get('EV_MAX_LOAD_W'), 'int(0,)?');
  assert.equal(SCHEMA.get('EV_PLATEAU_MIN_W'), 'int(0,)?');
  assert.equal(SCHEMA.get('RUNWAY_POOL_OVERHEAD_FLOOR_W'), 'float(0,1500)?');
  assert.equal(SCHEMA.get('RUNWAY_CORE_OVERHEAD_W'), 'float(0,500)?');
});

test('the clamps are real: a value outside the schema range is held to it by the row', async () => {
  const cases: Array<[string, string, unknown]> = [
    ['EV_MAX_LOAD_W', '-5', 0], ['EV_CHARGER_COUNT', '9', 4], ['EV_CHARGER_COUNT', '-1', 0],
    ['RUNWAY_POOL_OVERHEAD_FLOOR_W', '9000', 1500], ['RUNWAY_CORE_OVERHEAD_W', '-3', 0],
    ['CAPACITY_SCALE_MIN', '0.3', 0.5], ['CAPACITY_SCALE_MIN', '2', 1],
    ['FORECAST_NIGHT_START_HOUR', '25', 23], ['FORECAST_NIGHT_END_HOUR', '-3', 0],
  ];
  for (const [key, raw, want] of cases) {
    await withEnv({ ...UNSET, [key]: raw }, () => assert.deepEqual(option(key), want, `${key}=${raw}`));
  }
});

/* ── unset is today ──────────────────────────────────────────────────────────────────────── */

test('★ unset, every limit is today\'s value', async () => {
  await withEnv(UNSET, () => {
    assert.equal(limits.evMaxLoadW, 11520);
    assert.equal(limits.evChargerCount, 1);
    assert.equal(limits.evChargerCount, EV_CHARGER_COUNT_DEFAULT);
    assert.equal(limits.evPlateauMinW, 6000);
    assert.equal(limits.evCircuits, null);
    assert.equal(limits.forceChargeKwPerCore, null);
    assert.equal(limits.runwayPoolOverheadFloorW, 270);
    assert.equal(limits.runwayCoreOverheadW, 90);
    assert.equal(limits.runwayDrainMarginalEfficiency, 0.94);
    assert.equal(limits.runwayDischargeEfficiency, 0.94);
    assert.equal(limits.bmsReseedMinGapWh, 50_000);
    assert.equal(limits.bmsReseedSustainedRollups, 2);
    assert.equal(limits.capacityScaleMin, 0.8);
    assert.equal(limits.forecastNightStartHour, 21);
    assert.equal(limits.forecastNightEndHour, 5);
    assert.equal(limits.gridCo2LbPerMwh, 1100);
    assert.equal(limits.cyclingBaseWearUsdPerKwh, 0.015);
    assert.equal(limits.opportunisticLoads, null);
    assert.equal(limits.batterySocLadder, null);
    assert.equal(limits.batterySocMaxDropPct, 25);
    assert.equal(limits.cleanBaselineMaxImportKwh, 1);
  });
  // Named constants, values kept (OWNER DECISION 10; the EV group's constants).
  assert.equal(RESERVE_FALLBACK_PCT, 15);
  assert.equal(MPC_RESERVE_FALLBACK_PCT, 20);
  assert.equal(CONSOLE_RESERVE_FALLBACK_PCT, 0);
  assert.equal(EV_SESSION_FALLBACK_KWH, 11);
  assert.equal(EV_LIVE_MAX_REMAINING_H, 4);
  assert.equal(SOC_HEALTHY_BASELINE_PCT, 30);
});

/* ── set values reach the consumers ──────────────────────────────────────────────────────── */

let seq = 0;
/** A fresh copy of a module whose constants snapshot the limits at import (the production shape). */
async function fresh<T>(file: string, env: Record<string, string | undefined>): Promise<T> {
  seq += 1;
  return withEnv({ ...UNSET, ...env }, async () => (await import(`${pathToFileURL(resolve(SRC, file)).href}?limits=${seq}`)) as T);
}
type Analytics = typeof import('../src/analytics.js');
type Pool = typeof import('../src/poolEnergyBasis.js');

test('★ RUNWAY_POOL_OVERHEAD_FLOOR_W and RUNWAY_CORE_OVERHEAD_W set reach the runway overhead', async () => {
  const base = await fresh<Analytics>('analytics.ts', {});
  assert.equal(base.runwayPoolOverheadW(1, true), 270);
  assert.equal(base.runwayPoolOverheadW(4, true), 360);
  const floor = await fresh<Analytics>('analytics.ts', { RUNWAY_POOL_OVERHEAD_FLOOR_W: '180' });
  assert.equal(floor.RUNWAY_POOL_OVERHEAD_FLOOR_W, 180);
  assert.equal(floor.runwayPoolOverheadW(1, true), 180, 'a one-Core pool with a lower floor');
  const perCore = await fresh<Analytics>('analytics.ts', { RUNWAY_CORE_OVERHEAD_W: '120' });
  assert.equal(perCore.runwayPoolOverheadW(4, true), 480);
  // Decimals and int-shaped values both arrive (float schema; HA stores an integer as a JSON int).
  const dec = await fresh<Analytics>('analytics.ts', { RUNWAY_POOL_OVERHEAD_FLOOR_W: '180.5', RUNWAY_CORE_OVERHEAD_W: '60' });
  assert.equal(dec.runwayPoolOverheadW(1, true), 180.5);
  assert.equal(dec.runwayPoolOverheadW(4, true), 240);
});

test('★ the runway overhead is NOT derived from the connected-Core count (O1: unchanged below three Cores)', async () => {
  const a = await fresh<Analytics>('analytics.ts', {});
  for (const cores of [0, 1, 2, 3]) assert.equal(a.runwayPoolOverheadW(cores, true), 270, `${cores} Core(s)`);
});

test('★ CAPACITY_SCALE_MIN set reaches the scale clamp (one constant for the pool, the alerts and the secondary panel)', async () => {
  const sp = { projection: { sources: [{ slot: 1, sn: 'C1', isConnected: true }] } } as never;
  const low = (sn: string) => ({
    sn, online: true, deviceName: sn,
    projection: { kind: 'dpu', packCount: 5, packs: Array.from({ length: 5 }, (_, i) => ({ num: i + 1, fullCapMah: 36_000, designCapMah: 60_000 })) },
  });
  const devices = { C1: low('C1') } as never;
  const today = await fresh<Pool>('poolEnergyBasis.ts', {});
  assert.equal(today.CAPACITY_SCALE_MIN, 0.8);
  assert.equal(today.candidatePoolScale(sp, devices, new Map(), 0).scale, 0.8, 'a 0.6 ratio is floored at 0.8 today');
  const set = await fresh<Pool>('poolEnergyBasis.ts', { CAPACITY_SCALE_MIN: '0.55' });
  assert.equal(set.CAPACITY_SCALE_MIN, 0.55);
  assert.ok(Math.abs(set.candidatePoolScale(sp, devices, new Map(), 0).scale - 0.6) < 1e-12, 'with the floor at 0.55 the measured 0.6 applies');
  const intShaped = await fresh<Pool>('poolEnergyBasis.ts', { CAPACITY_SCALE_MIN: '1' });
  assert.equal(intShaped.CAPACITY_SCALE_MIN, 1, 'an int-shaped float (a JSON int in the options store) is accepted');
  // panelRunway.ts and alertMonitor.ts import the constant rather than restating it.
  for (const f of ['panelRunway.ts', 'alertMonitor.ts']) {
    const text = readFileSync(resolve(SRC, f), 'utf8');
    assert.match(text, /import \{[^}]*\bCAPACITY_SCALE_MIN\b[^}]*\} from '\.\/poolEnergyBasis\.js'/, `${f} imports the one constant`);
    assert.ok(!/0\.8\b/.test(text.split('\n').filter((l) => /CAPACITY_SCALE|capacityScale/.test(l)).join('\n')), `${f}: no restated 0.8 beside the scale`);
  }
});

test('★ FORECAST_NIGHT_START_HOUR / _END_HOUR set move the overnight band', async () => {
  const today = await fresh<Analytics>('analytics.ts', {});
  assert.deepEqual([20, 21, 23, 0, 5, 6].map((h) => today.isForecastNightHour(h)), [false, true, true, true, true, false]);
  const set = await fresh<Analytics>('analytics.ts', { FORECAST_NIGHT_START_HOUR: '22', FORECAST_NIGHT_END_HOUR: '6' });
  assert.deepEqual([21, 22, 23, 0, 6, 7].map((h) => set.isForecastNightHour(h)), [false, true, true, true, true, false]);
});

test('★ GRID_CO2_INTENSITY_LB_PER_MWH set reaches the carbon report', async () => {
  const rec = { query: () => [], getLifetimeTotals: () => ({}) } as never;
  const today = await fresh<Analytics>('analytics.ts', {});
  const kg = (lb: number) => Math.round(lb * 0.4536 / 1000 * 10_000) / 10_000; // the report rounds to 4 places
  assert.equal(today.computeCarbonReport({}, rec).gridCo2IntensityKgPerKwh, kg(1100));
  const set = await fresh<Analytics>('analytics.ts', { GRID_CO2_INTENSITY_LB_PER_MWH: '800' });
  assert.equal(set.computeCarbonReport({}, rec).gridCo2IntensityKgPerKwh, kg(800));
  assert.notEqual(kg(800), kg(1100));
});

test('★ BMS_RESEED_MIN_GAP_WH and CYCLING_BASE_WEAR_USD_PER_KWH: the getters read the option, and their readers read the getters', async () => {
  await withEnv({ ...UNSET, BMS_RESEED_MIN_GAP_WH: '30000', CYCLING_BASE_WEAR_USD_PER_KWH: '0.02' }, () => {
    assert.equal(limits.bmsReseedMinGapWh, 30_000);
    assert.equal(limits.cyclingBaseWearUsdPerKwh, 0.02);
  });
  await withEnv({ ...UNSET, CYCLING_BASE_WEAR_USD_PER_KWH: '0' }, () => assert.equal(limits.cyclingBaseWearUsdPerKwh, 0, 'int-shaped 0 is a value, not unset'));
  // recorder.ts reads it inside createRecorder (recorderFloorGapInvariant.test.ts drives a set value end to end);
  // index.ts cannot be imported in a test, so its reader is pinned by its source line.
  assert.match(readFileSync(resolve(SRC, 'recorder.ts'), 'utf8'), /const RESEED_MIN_GAP_WH = limits\.bmsReseedMinGapWh;/);
});

/* ── the per-Core charge rate (H1, H2) ───────────────────────────────────────────────────── */

test('★ FORCE_CHARGE_KW_PER_CORE unset keeps the measured 5.5 kW and the 10 / 7.2 fallbacks', async () => {
  await withEnv(UNSET, () => {
    assert.equal(forceChargeKwPerCore(), FORCE_CHARGE_PROVEN_KW_PER_SLOT);
    assert.equal(FORCE_CHARGE_PROVEN_KW_PER_SLOT, 5.5);
    assert.equal(planChargeCapKw(0, 2, 0.9), (2 * 5.5) / 0.9);
    assert.equal(planChargeCapKw(0, null, 0.9), LEGACY_CHARGE_CAP_KW);
    assert.equal(forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: 0.93, slotCount: 1 }), 5.5);
    assert.equal(planRateFallbackKw(3), FORCE_CHARGE_PLAN_RATE_KW, 'unset: the fixed 10 kW even when the slots are known');
    assert.equal(planRateFallbackKw(null), 10);
  });
});

test('★ FORCE_CHARGE_KW_PER_CORE set reaches the planner cap, the live-rate bound and the fallback start rate', async () => {
  await withEnv({ ...UNSET, FORCE_CHARGE_KW_PER_CORE: '4' }, () => {
    assert.equal(forceChargeKwPerCore(), 4);
    assert.equal(planChargeCapKw(0, 2, 0.8), (2 * 4) / 0.8);
    assert.equal(planChargeCapKw(0, 5, 0.8), (3 * 4) / 0.8, 'at most the panel\'s three slots');
    assert.equal(planChargeCapKw(12, 2, 0.8), 12, 'ARB_CHARGE_CAP_KW > 0 still wins');
    assert.equal(planChargeCapKw(0, null, 0.8), LEGACY_CHARGE_CAP_KW, 'slots unknown: the 7.2 kW constant (H2)');
    assert.equal(forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 1, legEff: 0.93, slotCount: 2 }), 8);
    assert.equal(planRateFallbackKw(2), 8, 'slots known: slots × the key');
    assert.equal(planRateFallbackKw(null), FORCE_CHARGE_PLAN_RATE_KW, 'slots unknown: the 10 kW constant (H2)');
    // The start uses the fallback only when the live rate is unknown, and with the slot count it is given.
    const end = 1_000_000_000;
    const at = forceChargeStartAtMs(end, 80, 60, 40, null, null, 2); // 8 kWh needed at 8 kW
    assert.equal(at, end - 3_600_000 - FORCE_CHARGE_JIT_BUFFER_MS);
    assert.equal(forceChargeStartAtMs(end, 80, 60, 40, null, null), end - 0.8 * 3_600_000 - FORCE_CHARGE_JIT_BUFFER_MS, 'no slot count: 10 kW');
  });
  for (const raw of ['0', '-2', 'abc', '']) {
    await withEnv({ ...UNSET, FORCE_CHARGE_KW_PER_CORE: raw }, () => assert.equal(forceChargeKwPerCore(), 5.5, `'${raw}' is the measured rate`));
  }
  await withEnv({ ...UNSET, FORCE_CHARGE_KW_PER_CORE: '6' }, () => assert.equal(forceChargeKwPerCore(), 6, 'int-shaped float'));
});

/* ── the index.ts readers (index.ts starts the server and cannot be imported) ─────────────── */

test('★ index.ts reads the lane E limits through limits.ts / config.ts, not process.env', () => {
  const idx = readFileSync(resolve(SRC, 'index.ts'), 'utf8');
  for (const name of ['EV_MAX_LOAD_W', 'CYCLING_BASE_WEAR_USD_PER_KWH', 'ARB_OBJECTIVE', 'ARB_COST_MAX_SOC_PCT', 'ARB_MIN_BUY_KWH',
    'ARB_OUTAGE_CUSHION_PCT', 'ARB_GRID_INPUT_CAP_KW', 'RECORDER_RETENTION_DAYS']) {
    assert.ok(!idx.includes(`process.env.${name}`), `index.ts still reads process.env.${name}`);
  }
  assert.match(idx, /const baseWear = limits\.cyclingBaseWearUsdPerKwh;/);
  assert.match(idx, /const evMaxLoadW = limits\.evMaxLoadW;/);
  assert.match(idx, /limits\.cleanBaselineMaxImportKwh/);
});
