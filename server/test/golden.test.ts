import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (S1) — the characterisation goldens.
 *
 * server/test/golden/G*.json pin what the code computes TODAY for this install's settings: the
 * site clock (G1), the tariff (G2), every option key's parse (G3), the night-charge schedule (G4),
 * the PV physics (G5), the panel/spare topology (G6), the MQTT discovery payloads (G7) and the plant
 * limits (G8). Each group is re-captured here exactly as scripts/golden-capture.mts captured it:
 * in a child process with TZ=America/Phoenix (the zone this install runs in; CI runners are UTC, so
 * the host-clock paths would otherwise be tested in a different zone from production), with the
 * environment reduced to a fixed set (test/golden/captureCli.ts), and compared structurally.
 *
 * A difference is a behaviour change on the owner's install. The lanes that consolidate the
 * settings (site time, tariff, PV, devices, limits) must leave every group byte-identical while the
 * new options are unset; a probe whose reader moved is re-pointed (test/golden/support), the golden
 * is not re-captured. Re-capturing needs a matching FROZEN.sha256 change (goldenFrozen.test.ts).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const GOLDEN = resolve(HERE, 'golden');
const CLI = resolve(GOLDEN, 'captureCli.ts');
export const GROUPS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;

function capture(group: string): Promise<unknown> {
  return new Promise((res, rej) => {
    execFile(process.execPath, ['--import', 'tsx', CLI, group], {
      cwd: SERVER,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'America/Phoenix', TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '' },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`capture ${group} failed: ${err.message}\n${stderr}`));
      try { res(JSON.parse(stdout)); } catch (e) { rej(new Error(`capture ${group} wrote non-JSON: ${(e as Error).message}\n${stdout.slice(0, 400)}`)); }
    });
  });
}

/** The first path at which two encoded values differ, with both sides — deepStrictEqual's diff of a megabyte is unreadable. */
export function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: golden ${JSON.stringify(a)?.slice(0, 200)} ≠ live ${JSON.stringify(b)?.slice(0, 200)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of [...keys].sort()) {
    if (!(k in ao)) return `${path}.${k}: missing in golden (live has ${JSON.stringify(bo[k])?.slice(0, 200)})`;
    if (!(k in bo)) return `${path}.${k}: missing live (golden has ${JSON.stringify(ao[k])?.slice(0, 200)})`;
    const d = firstDiff(ao[k], bo[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

// The captures run through a small pool (three at a time): all eight at once starve the slowest (G1,
// 8,760 hours of unmemoized Intl formatting) for a minute; each test awaits its own.
const pool: Array<() => void> = [];
let running = 0;
function pooled<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    const start = () => {
      running += 1;
      fn().then(res, rej).finally(() => { running -= 1; pool.shift()?.(); });
    };
    if (running < 3) start(); else pool.push(start);
  });
}
const live = new Map<string, Promise<unknown>>(GROUPS.map((g) => [g, pooled(() => capture(g))]));

for (const g of GROUPS) {
  test(`★ golden ${g} is unchanged`, async () => {
    const file = resolve(GOLDEN, `${g}.json`);
    assert.ok(existsSync(file), `${file} is missing — run: cd server && node --import tsx ../scripts/golden-capture.mts ${g}`);
    const expected = JSON.parse(readFileSync(file, 'utf8')) as { group: string; value: unknown };
    const actual = (await live.get(g)!) as { group: string; value: unknown };
    assert.equal(actual.group, g);
    const diff = firstDiff(expected.value, actual.value);
    assert.equal(diff, null, `golden ${g} differs — ${diff}`);
  });
}

test('golden G3 covers every config.yaml option key, each with the six standard variants', () => {
  const g3 = JSON.parse(readFileSync(resolve(GOLDEN, 'G3.json'), 'utf8')) as { value: { keyCount: number; keys: Record<string, { variants: Record<string, unknown> }> } };
  const cfg = readFileSync(resolve(SERVER, '../ecoflow_panel/config.yaml'), 'utf8');
  const schema = cfg.slice(cfg.indexOf('\nschema:'));
  const options = cfg.slice(cfg.indexOf('\noptions:'), cfg.indexOf('\nschema:'));
  const shipped = new Set((options.match(/^  ([A-Z][A-Z0-9_]+):/gm) ?? []).map((m) => m.trim().replace(':', '')));
  // v1.191.0 — G3 pins every key that has a shipped default (the 85 the reference install stores).
  // A schema-only key added later (optional, no default) is absent on that install by construction,
  // so it is not in G3; it must be optional, and none of the shipped keys may become schema-only.
  const all = (schema.match(/^  ([A-Z][A-Z0-9_]+):/gm) ?? []).map((m) => m.trim().replace(':', ''));
  const keys = all.filter((k) => shipped.has(k));
  assert.equal(keys.length, 85);
  assert.deepEqual(Object.keys(g3.value.keys).sort(), [...keys].sort());
  for (const k of all.filter((x) => !shipped.has(x))) {
    assert.match(schema, new RegExp(`^  ${k}: "?[a-z]+(\\([^)]*\\))?\\?"?$`, 'm'), `${k}: a schema-only key must be optional`);
    assert.ok(!(k in g3.value.keys), `${k}: a key in G3 cannot lose its shipped default`);
  }
  for (const k of keys) {
    for (const v of ['unset', 'blank', 'null', 'default', 'valid', 'invalid']) assert.ok(v in g3.value.keys[k].variants, `${k} lacks variant ${v}`);
  }
  // S0's type note: a float key can arrive int-shaped from the persisted options store.
  assert.ok('intShaped' in g3.value.keys.LOAD_SHEDDING_RUNWAY_THRESHOLD_H.variants);
  assert.ok('intShaped' in g3.value.keys.LOAD_SHEDDING_RESTORE_MARGIN_H.variants);
});

/* ── v1.191.0 (S2): the OPTIONS table reproduces every reader the goldens pinned ───────────── */

import { OPTIONS, type Env } from '../src/config.js';
import { KEYS as G3_KEYS } from './golden/support/g3.js';
import { encode } from './golden/support/encode.js';

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const envFrom = (vars: Record<string, string | undefined>): Env => ({ get: (n) => vars[n] });
function rowValue(name: string, raw: string | undefined, vars: Record<string, string | undefined>): unknown {
  const row = OPTIONS[name];
  try {
    const v = row.parse(raw, envFrom({ ...vars, [name]: raw }));
    return encode(row.readerView ? row.readerView(v) : v);
  } catch (e) { return { throws: (e as Error).message }; }
}

interface G3Key { exportForm: string; probes: Array<{ reader: string; derived: boolean }>; variants: Record<string, { raw: unknown; readers: Record<string, unknown> }> }
const G3 = (JSON.parse(readFileSync(resolve(GOLDEN, 'G3.json'), 'utf8')) as { value: { keys: Record<string, G3Key> } }).value.keys;

test('★ G3: every option row parses each captured input to what its canonical reader saw', () => {
  const problems: string[] = [];
  for (const spec of G3_KEYS) {
    const row = OPTIONS[spec.key];
    const g = G3[spec.key];
    assert.ok(row, `${spec.key} has no OPTIONS row`);
    assert.equal(row.exportForm, g.exportForm, `${spec.key}: exportForm differs from the golden's`);
    const canonical = g.probes.find((p) => p.reader === row.canonicalReader);
    assert.ok(canonical, `${spec.key}: canonicalReader ${row.canonicalReader} is not a probe in golden G3 (${g.probes.map((p) => p.reader).join(', ')})`);
    if (row.structuredBy) { assert.equal(row.structuredBy, row.canonicalReader); continue; }
    for (const [vName, v] of Object.entries(g.variants)) {
      const raw = v.raw as string | undefined;
      const vars: Record<string, string | undefined> = { ...(spec.context ?? {}) };
      const got = rowValue(spec.key, raw, vars);
      // The capture's serial-redaction pass is a JSON round trip, which drops a reader's `undefined`
      // before encoding: an absent key in the golden is the reader seeing undefined.
      const want = row.canonicalReader in v.readers ? v.readers[row.canonicalReader] : encode(undefined);
      if (!sameJson(got, want)) problems.push(`${spec.key} [${vName}] raw=${JSON.stringify(raw)}: OPTIONS → ${JSON.stringify(got)}, reader ${row.canonicalReader} → ${JSON.stringify(want)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('★ G3: a reader that disagrees with the canonical one is declared on the row, and no declaration is stale', () => {
  const problems: string[] = [];
  for (const spec of G3_KEYS) {
    const row = OPTIONS[spec.key];
    const g = G3[spec.key];
    const declared = new Set(Object.keys(row.divergentReaders ?? {}));
    for (const p of g.probes) {
      if (p.derived || p.reader === row.canonicalReader) continue;
      const seen = (v: { readers: Record<string, unknown> }, r: string) => (r in v.readers ? v.readers[r] : encode(undefined));
      const differs = Object.values(g.variants).some((v) => !sameJson(seen(v, p.reader), seen(v, row.canonicalReader)));
      if (differs && !declared.has(p.reader)) problems.push(`${spec.key}: reader ${p.reader} disagrees with ${row.canonicalReader} for some input and is not declared in divergentReaders`);
      if (!differs && declared.has(p.reader)) problems.push(`${spec.key}: divergentReaders names ${p.reader}, which agrees with the canonical reader for every input (stale)`);
    }
    for (const d of declared) {
      if (!g.probes.some((p) => p.reader === d)) problems.push(`${spec.key}: divergentReaders names ${d}, which golden G3 does not probe`);
    }
  }
  assert.deepEqual(problems, []);
});

test('G8/G2: the environment-only rows parse each captured input to what the module constant evaluated to', async () => {
  const { LIMITS_ENV_MATRIX, TARIFF_ENV_MATRIX } = await import('./golden/support/groups.js');
  type Variant = Record<string, Record<string, unknown>>;
  const g8 = (JSON.parse(readFileSync(resolve(GOLDEN, 'G8.json'), 'utf8')) as { value: { variants: Record<string, Variant> } }).value.variants;
  const g2 = (JSON.parse(readFileSync(resolve(GOLDEN, 'G2.json'), 'utf8')) as { value: { variants: Record<string, { mpc: Record<string, unknown> }> } }).value.variants;
  const at = (v: Variant, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], v);
  const MAP: Record<string, string> = {
    EV_MAX_LOAD_W: 'ev.EV_MAX_LOAD_W', EV_PLATEAU_MIN_W: 'ev.EV_PLATEAU_MIN_W',
    RUNWAY_POOL_OVERHEAD_FLOOR_W: 'runway.RUNWAY_POOL_OVERHEAD_FLOOR_W', RUNWAY_CORE_OVERHEAD_W: 'runway.RUNWAY_CORE_OVERHEAD_W',
    RUNWAY_DRAIN_MARGINAL_EFFICIENCY: 'runway.RUNWAY_DRAIN_MARGINAL_EFFICIENCY', RUNWAY_DISCHARGE_EFFICIENCY: 'runway.RUNWAY_DISCHARGE_EFFICIENCY',
    BMS_RESEED_MIN_GAP_WH: 'reseed.RESEED_MIN_GAP_WH', BMS_RESEED_SUSTAINED_ROLLUPS: 'reseed.RESEED_SUSTAINED_ROLLUPS',
    GRID_CO2_INTENSITY_LB_PER_MWH: 'co2.DEFAULT_GRID_CO2_LB_PER_MWH', CYCLING_BASE_WEAR_USD_PER_KWH: 'co2.cyclingBaseWear',
    FORECAST_NIGHT_START_HOUR: 'nightHours.FORECAST_NIGHT_START_HOUR', FORECAST_NIGHT_END_HOUR: 'nightHours.FORECAST_NIGHT_END_HOUR',
    SELF_HEAL_MIN_DEVICES: 'quorum.minStarvedDevices', BATTERY_SOC_MAX_DROP_PCT: 'ladder.MAX_PLAUSIBLE_DROP_PCT',
    DISPATCH_ROUND_TRIP_EFFICIENCY: 'efficiencies.DISPATCH_ROUND_TRIP_EFFICIENCY', MPC_ROUND_TRIP_EFFICIENCY: 'efficiencies.MPC_ROUND_TRIP_EFFICIENCY',
    TARIFF_EXPORT_CENTS_PER_KWH: 'efficiencies.EXPORT_TARIFF_CENTS', ARB_GRID_INPUT_CAP_KW: 'chargeCaps.gridInputCapKw', ARB_CHARGE_CAP_KW: 'chargeCaps.optionKw',
  };
  const problems: string[] = [];
  for (const [vName, patch] of Object.entries(LIMITS_ENV_MATRIX)) {
    const vars = { ...LIMITS_ENV_MATRIX.unset, ...patch };
    for (const [name, path] of Object.entries(MAP)) {
      const got = rowValue(name, vars[name], vars);
      const want = at(g8[vName], path);
      if (!sameJson(got, want)) problems.push(`${name} [G8 ${vName}] raw=${JSON.stringify(vars[name])}: OPTIONS → ${JSON.stringify(got)}, module → ${JSON.stringify(want)}`);
    }
  }
  for (const [vName, patch] of Object.entries(TARIFF_ENV_MATRIX)) {
    const vars = { ...TARIFF_ENV_MATRIX.defaults, ...patch };
    for (const [name, path] of [['TARIFF_FLAT_CENTS_PER_KWH', 'flatCents'], ['TARIFF_ON_PEAK_CENTS_PER_KWH', 'onPeak'], ['TARIFF_OFF_PEAK_CENTS_PER_KWH', 'offPeak']] as const) {
      const got = rowValue(name, vars[name], vars);
      const want = g2[vName].mpc[path];
      if (!sameJson(got, want)) problems.push(`${name} [G2 ${vName}]: OPTIONS → ${JSON.stringify(got)}, index.ts MPC pair → ${JSON.stringify(want)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every option row is a complete row: source, doc, canonical reader; option rows carry an exportForm', () => {
  for (const row of Object.values(OPTIONS)) {
    assert.ok(row.doc.length > 10, `${row.name}: doc`);
    assert.ok(row.canonicalReader.includes('.'), `${row.name}: canonicalReader names a file`);
    if (row.source === 'option') assert.ok(row.exportForm, `${row.name}: exportForm`);
    else assert.equal(row.exportForm, undefined, `${row.name}: only option rows have an export convention`);
  }
});
