import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIONS, DECLARED_DIVERGENCES, DEFAULT_SITE_LAT, DEFAULT_SITE_LON, type Env, type OptionRow } from '../src/config.js';
import { forceChargeRateKw, planRateFallbackKw, FORCE_CHARGE_PLAN_RATE_KW, FORCE_CHARGE_PROVEN_KW_PER_SLOT } from '../src/nightForceCharge.js';
import { encode } from './golden/support/encode.js';

/**
 * v1.191.0 (S2) — default parity: each option's value when the variable is ABSENT equals its value
 * when the run script exports the shipped `options:` default, and (for an optional `?` key, which
 * Home Assistant lets the user clear) a cleared field — exported as '' or as the literal 'null' — reads
 * as the default too. Every difference must be listed in config.ts DECLARED_DIVERGENCES with its
 * reason, and every listed divergence must be real: the list cannot rot in either direction.
 *
 * The fourth kind, `clamp`, holds a row's clamp to the schema range (plan 2.3: "the schema range
 * equals the row's clamp"); a ranged schema with no clamp in the code, or a clamp that differs, is a
 * declared difference (Home Assistant validates the form; a hand-set environment is not clamped).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = readFileSync(resolve(ROOT, 'ecoflow_panel/config.yaml'), 'utf8');
const RUN = readFileSync(resolve(ROOT, 'rootfs/etc/services.d/ecoflow-panel/run'), 'utf8');

function yamlScalar(v: string): string {
  v = v.trim();
  const hash = v.indexOf(' #');
  if (hash >= 0) v = v.slice(0, hash).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
function block(name: 'options' | 'schema'): Map<string, string> {
  const i = CONFIG.indexOf(`\n${name}:`);
  assert.notEqual(i, -1);
  const text = CONFIG.slice(i + 1);
  const end = text.search(/\n[a-z]/);
  const out = new Map<string, string>();
  for (const m of (end < 0 ? text : text.slice(0, end)).matchAll(/^  ([A-Z][A-Z0-9_]+):(.*)$/gm)) out.set(m[1], yamlScalar(m[2]));
  return out;
}
const DEFAULTS = block('options');
const SCHEMA = block('schema');

/** How the run script exports the yaml default of `key`: 1/0, true/false or the value verbatim. */
function exportedDefault(key: string, def: string): string {
  if (RUN.includes(`bashio::config.true '${key}'`)) {
    const body = RUN.slice(RUN.indexOf(`bashio::config.true '${key}'`));
    const seg = body.slice(0, body.indexOf('\nfi'));
    const oneZero = /=1\b/.test(seg) && /=0\b/.test(seg);
    const t = def === 'true';
    return oneZero ? (t ? '1' : '0') : (t ? 'true' : 'false');
  }
  return def;
}

/** The parse under a fixed environment of other keys (their shipped defaults as exported). */
function envOf(overrides: Record<string, string | undefined>): Env {
  return {
    get: (name) => {
      if (name in overrides) return overrides[name];
      const d = DEFAULTS.get(name);
      return d === undefined ? undefined : exportedDefault(name, d);
    },
  };
}
function value(row: OptionRow, raw: string | undefined, others: Record<string, string | undefined> = {}): unknown {
  try {
    const v = row.parse(raw, envOf({ [row.name]: raw, ...others }));
    return encode(row.readerView ? row.readerView(v) : v);
  }
  catch (e) { return { throws: (e as Error).message }; }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function schemaRange(schema: string): { min: number; max: number } | null {
  const m = /^(?:int|float)\((-?[\d.]+),\s*(-?[\d.]+)\)\??$/.exec(schema.replace(/^"|"$/g, ''));
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}
const isOptional = (schema: string) => schema.replace(/"/g, '').endsWith('?');

interface Found { key: string; kind: 'unset' | 'blank' | 'null' | 'clamp'; detail: string }

function findDivergences(): Found[] {
  const found: Found[] = [];
  for (const [key, def] of DEFAULTS) {
    const row = OPTIONS[key];
    assert.ok(row, `${key} has no OPTIONS row`);
    const exported = exportedDefault(key, def);
    const whenDefault = value(row, exported);
    const whenUnset = value(row, undefined);
    if (!same(whenDefault, whenUnset)) found.push({ key, kind: 'unset', detail: `unset → ${JSON.stringify(whenUnset)}, default ${JSON.stringify(exported)} → ${JSON.stringify(whenDefault)}` });
    const schema = SCHEMA.get(key) ?? '';
    if (isOptional(schema)) {
      const whenBlank = value(row, '');
      if (!same(whenDefault, whenBlank)) found.push({ key, kind: 'blank', detail: `'' → ${JSON.stringify(whenBlank)}, default → ${JSON.stringify(whenDefault)}` });
      const whenNull = value(row, 'null');
      if (!same(whenDefault, whenNull)) found.push({ key, kind: 'null', detail: `'null' → ${JSON.stringify(whenNull)}, default → ${JSON.stringify(whenDefault)}` });
    }
  }
  // v1.191.0 (review 3) — the clamp rule holds for every schema key, the schema-only ones (no `options:`
  // default) included: it ran over the defaulted keys only, so a PV_* clamp could drift from its range.
  for (const [key, schema] of SCHEMA) {
    const row = OPTIONS[key];
    assert.ok(row, `${key} has no OPTIONS row`);
    const range = schemaRange(schema);
    if (range) {
      const c = row.clamp;
      if (!c || c.min !== range.min || c.max !== range.max) found.push({ key, kind: 'clamp', detail: `schema ${schema} vs clamp ${JSON.stringify(c ?? null)}` });
    } else if (row.clamp && (row.clamp.min !== undefined || row.clamp.max !== undefined) && !isOptional(schema) && /^(int|float|port)/.test(schema)) {
      found.push({ key, kind: 'clamp', detail: `the code clamps ${JSON.stringify(row.clamp)} but the schema ${schema} states no range` });
    }
  }
  return found;
}

test('★ every option row reads the shipped default and an absent or cleared field alike, or declares why not', () => {
  const found = findDivergences();
  const declared = new Set(DECLARED_DIVERGENCES.map((d) => `${d.key}/${d.kind}`));
  const undeclared = found.filter((f) => !declared.has(`${f.key}/${f.kind}`));
  assert.deepEqual(undeclared.map((f) => `${f.key}/${f.kind}: ${f.detail}`), [],
    'these differences between the shipped default and an absent/cleared value are not declared in config.ts DECLARED_DIVERGENCES');
});

test('★ every declared divergence is real (no stale declarations)', () => {
  const found = new Set(findDivergences().map((f) => `${f.key}/${f.kind}`));
  const stale = DECLARED_DIVERGENCES
    .filter((d) => DEFAULTS.has(d.key) || (SCHEMA.has(d.key) && d.kind === 'clamp')) // env-only rows (CA10) are pre-declared for the bridging lane
    .filter((d) => !found.has(`${d.key}/${d.kind}`))
    .map((d) => `${d.key}/${d.kind}`);
  assert.deepEqual(stale, [], 'declared in config.ts DECLARED_DIVERGENCES but the row no longer diverges — delete the entry');
});

/**
 * v1.191.0 (review 3) — a row's `clamp` is what its parse does. The schema-range rule above compares the
 * `clamp` metadata with config.yaml; nothing tied the metadata to the parse, so PV_TILT_DEG parsed
 * through floatOrNull(0, 80) under a clamp of 0..90 passed every test (an 85° tilt the schema accepts
 * was held at 80). For every row with a clamp: a value at each bound reads as that bound, and a value
 * one past it is held to it. The rows whose parse reads otherwise are listed with the reason.
 */
const EDGE_READS: Record<string, { scale?: number; belowMin?: unknown; atMin?: unknown; why: string }> = {
  BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN: { scale: 60_000, why: 'read in milliseconds' },
  HEARTBEAT_INTERVAL_S: { scale: 1000, why: 'read in milliseconds' },
  EV_PLATEAU_MIN_W: { belowMin: 6000, why: 'a negative value is not a plateau: the 6000 W fallback' },
  FORCE_CHARGE_KW_PER_CORE: { belowMin: null, atMin: null, why: '0 or less reads as unset (the measured per-Core rate)' },
};

test('★★★ every clamped row holds a value at and past each bound to that bound (the parse is the clamp it declares)', () => {
  const env: Env = { get: () => undefined };
  const rows = Object.values(OPTIONS).filter((r) => r.clamp);
  assert.ok(rows.length >= 25, `only ${rows.length} clamped rows — the table drifted`);
  for (const key of Object.keys(EDGE_READS)) assert.ok(OPTIONS[key]?.clamp, `${key}: listed in EDGE_READS but has no clamp`);
  for (const row of rows) {
    const { min, max } = row.clamp!;
    const e = EDGE_READS[row.name];
    const scale = e?.scale ?? 1;
    const at = (x: number) => row.parse(String(x), env);
    if (min !== undefined) {
      assert.deepEqual(at(min), e && 'atMin' in e ? e.atMin : min * scale, `${row.name}: ${min} (the lower bound)`);
      assert.deepEqual(at(min - 1), e && 'belowMin' in e ? e.belowMin : min * scale, `${row.name}: ${min - 1} is held to the lower bound`);
    }
    if (max !== undefined) {
      assert.deepEqual(at(max), max * scale, `${row.name}: ${max} (the upper bound)`);
      assert.deepEqual(at(max + 1), max * scale, `${row.name}: ${max + 1} is held to the upper bound`);
    }
  }
});

test('★★ the PV array keys: the schema range, the clamp and the parse agree (schema-only keys, review 3)', () => {
  for (const [key, range] of [['PV_ARRAY_KWP', { min: 0.1, max: 500 }], ['PV_TILT_DEG', { min: 0, max: 90 }], ['PV_AZIMUTH_DEG', { min: 0, max: 360 }]] as const) {
    assert.ok(!DEFAULTS.has(key), `${key} is schema-only`);
    assert.deepEqual(schemaRange(SCHEMA.get(key)!), range, `${key}: schema`);
    assert.deepEqual(OPTIONS[key].clamp, range, `${key}: clamp`);
  }
  const env: Env = { get: () => undefined };
  assert.equal(OPTIONS.PV_TILT_DEG.parse('85', env), 85, 'a steep tilt the schema accepts is kept');
  assert.equal(OPTIONS.PV_ARRAY_KWP.parse('0.05', env), 0.1);
  assert.equal(OPTIONS.PV_AZIMUTH_DEG.parse('359.5', env), 359.5);
});

test('a declared divergence names a registered key with a reason', () => {
  for (const d of DECLARED_DIVERGENCES) {
    assert.ok(OPTIONS[d.key], `${d.key} is not a registered option`);
    assert.ok(d.reason.length > 20, `${d.key}/${d.kind}: the reason is too short to be one`);
    if (!DEFAULTS.has(d.key)) assert.equal(d.kind, 'clamp', `${d.key} has no shipped default; only a clamp can be pre-declared for it`);
  }
  const seen = new Set<string>();
  for (const d of DECLARED_DIVERGENCES) {
    const id = `${d.key}/${d.kind}`;
    assert.ok(!seen.has(id), `${id} is declared twice`);
    seen.add(id);
  }
});

test('★★ OWNER DECISION 21: a new install no longer inherits the reference home\'s Spanish pass; the other three defaults stay, for the reasons pinned here', () => {
  // S0 C8 found every option stored on the reference install (stored options win over the `options:`
  // defaults), so a changed default reaches only an install that has not saved its configuration.
  assert.equal(DEFAULTS.get('BROADCAST_BILINGUAL'), 'false', 'a new install speaks English only until the Spanish pass is turned on');
  // The reference install stores true, and the run script exports it: its pass stays on (G3 pins the reader).
  assert.equal(value(OPTIONS.BROADCAST_BILINGUAL, 'true'), true);
  assert.equal(value(OPTIONS.BROADCAST_BILINGUAL, exportedDefault('BROADCAST_BILINGUAL', 'false')), false);
  // FORECAST_LAT / FORECAST_LON: OWNER DECISION 5 keeps the placeholder, and the 50 km notices are measured from it.
  assert.equal(Number(DEFAULTS.get('FORECAST_LAT')), DEFAULT_SITE_LAT);
  assert.equal(Number(DEFAULTS.get('FORECAST_LON')), DEFAULT_SITE_LON);
  // BROADCAST_AUDIO_BASE: Home Assistant's own host name and this add-on's port (a deployment constant, plan 8).
  assert.equal(DEFAULTS.get('BROADCAST_AUDIO_BASE'), 'http://homeassistant.local:8787');
  // ARB_GRID_INPUT_CAP_KW: no value is neutral. 0 turns the contention model off, and the force-charge is then
  // timed at the fixed fallback rate, about twice what one Core takes: on a one-Core plant it starts late and
  // the night ends short. With 17 the rate is bounded by the connected Cores. Every other figure is one home's.
  assert.equal(DEFAULTS.get('ARB_GRID_INPUT_CAP_KW'), '17');
  assert.equal(value(OPTIONS.ARB_GRID_INPUT_CAP_KW, '0'), null, '0 reads as no envelope modelled');
  const legEff = Math.sqrt(0.86);
  const at17 = forceChargeRateKw({ gridCapKw: 17, houseLoadKw: 2, legEff, slotCount: 1 });
  assert.equal(at17, FORCE_CHARGE_PROVEN_KW_PER_SLOT, 'one Core: the rate the force-charge is timed at, with 17');
  assert.equal(forceChargeRateKw({ gridCapKw: null, houseLoadKw: 2, legEff, slotCount: 1 }), null, 'with 0 there is no live rate');
  assert.equal(planRateFallbackKw(1), FORCE_CHARGE_PLAN_RATE_KW, 'so the start is timed at the fallback');
  assert.ok(FORCE_CHARGE_PLAN_RATE_KW > at17!, 'which is faster than one Core charges: a later start');
});
