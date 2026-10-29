import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  productKind, isDpuProduct, isShp2Product, coreNumberFromName, coreNumber, coreLabel, slotOfDpu,
  disambiguatedName, disambiguateFallbackNames, warrantyChassis, DPU_LABEL,
} from '../src/topology.js';
import { projectByProduct } from '../src/ecoflow/project.js';
import { dpuNum as mathDpuNum } from '../src/analytics/mathHelpers.js';
import { generatorNumber, getDpus } from '../src/console/plant/data.js';

/**
 * v1.191.0 (S8, lane D) — topology.ts: product identification, Core numbering and the warranty
 * export's default chassis. Serials are placeholders (…XXX00XXX00NN).
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const read = (f: string) => readFileSync(resolve(SRC, f), 'utf8');

const PANEL = 'HD31XXX00XXX0001';
const CORE_A = 'Y711XXX00XXX0011';
const CORE_B = 'Y711XXX00XXX0012';
const CORE_C = 'Y711XXX00XXX0013';

/* ── product identification ── */

const PRODUCTS = ['DELTA Pro Ultra', 'delta pro ultra', 'DELTA PRO ULTRA X', 'Smart Home Panel 2', 'Smart Home Panel', 'SMART HOME PANEL',
  'PowerInsight', 'DELTA 3 Plus', 'WAVE 2', 'Smart Generator 3000', 'Core 5', '', 'Delta Pro Ultra + Smart Home Panel'];

test('★ productKind, isDpuProduct and isShp2Product give the inline substring tests\' answers for every name', () => {
  for (const p of PRODUCTS) {
    const lower = p.toLowerCase();
    assert.equal(isDpuProduct(p), lower.includes('delta pro ultra'), p);
    assert.equal(isShp2Product(p), lower.includes('smart home panel'), p);
    // projectByProduct's order: a name with both substrings is a DPU.
    const inline = lower.includes('delta pro ultra') ? 'dpu' : lower.includes('smart home panel') ? 'shp2' : 'other';
    assert.equal(productKind(p), inline, p);
  }
  for (const p of [null, undefined]) {
    assert.equal(productKind(p), 'other');
    assert.equal(isDpuProduct(p), false);
    assert.equal(isShp2Product(p), false);
  }
});

test('projectByProduct still projects by the same two tests (kind for kind)', () => {
  for (const p of PRODUCTS) {
    const want = productKind(p) === 'other' ? 'generic' : productKind(p);
    assert.equal(projectByProduct(p, {}).kind, want, p);
  }
});

test('★ no inline product substring test is left in the files lane D moved onto topology.ts', () => {
  const files = ['shp2Membership.ts', 'alerts.ts', 'repairIssues.ts', 'ecoflow/project.ts', 'ecoflow/mqtt.ts', 'gridState.ts', 'console/plant/data.ts'];
  for (const f of files) {
    const hits = read(f).split('\n').filter((l) => /includes\('(delta pro ultra|smart home panel)'\)/.test(l));
    assert.deepEqual(hits, [], `${f} still tests the product name inline`);
  }
  // snapshot.ts keeps exactly one place that reads a product from a NAME (guessProductFromName,
  // which also keeps its `core ` rule): every other test there goes through topology.ts.
  const snap = read('snapshot.ts').split('\n').filter((l) => /includes\('(delta pro ultra|smart home panel)'\)/.test(l));
  assert.equal(snap.length, 2, snap.join('\n'));
  assert.ok(snap.every((l) => /\bn\.includes\(/.test(l)), 'only guessProductFromName may test inline');
  assert.match(read('snapshot.ts'), /if \(n\.includes\('delta pro ultra'\) \|\| n\.startsWith\('core '\)\) return 'DELTA Pro Ultra';/);
});

/* ── Core numbering ── */

const NAMES = ['Core 3', 'core 12', 'Core12', 'DELTA-PRO-ULTRA-3', 'Garage Core', 'Y711XXX00XXX0007', '7', 'Panel', '', 'Core 0', 'Core -2',
  'Core 3 (bench)', 'Core 5 (slot 2)', '2 Core 5'];
const oldChain = (name: string): number | null => {
  const m = name.match(/core\s*(\d+)/i) ?? name.match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

test('★ coreNumberFromName is the chain the three copies used, for every name', () => {
  for (const n of NAMES) {
    assert.equal(coreNumberFromName(n), oldChain(n), n);
    assert.equal(mathDpuNum(n), oldChain(n), `mathHelpers ${n}`);
  }
  assert.equal(coreNumberFromName(undefined), null);
  assert.equal(coreNumberFromName(null), null);
});

test('the console\'s generator number is the same chain, with its index fallback; identical for every "Core N" name', () => {
  for (const n of ['Core 1', 'Core 2', 'core 5', 'Core12', 'DELTA-PRO-ULTRA-3']) {
    const old = n.match(/(\d+)/);
    assert.equal(generatorNumber(n, 6), old ? Number(old[1]) : 7, n);
  }
  assert.equal(generatorNumber('Garage', 2), 3);
  assert.equal(generatorNumber(undefined as unknown as string, 0), 1);
});

const dpu = (sn: string, deviceName: string, extra: Record<string, unknown> = {}) =>
  ({ sn, deviceName, productName: 'DELTA Pro Ultra', online: true, lastUpdated: 0, projection: { kind: 'dpu', packs: [] }, ...extra });
const panel = (sources: Array<{ slot: number; sn: string | null; isConnected?: boolean }>, sn = PANEL) =>
  ({ sn, deviceName: 'Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: 0, projection: { kind: 'shp2', sources: sources.map((s) => ({ isConnected: true, ...s })) } });

test('★ CA4: a DPU named by its owner is numbered from its name; one still under its product-name fallback by its panel slot', () => {
  const devices = {
    [PANEL]: panel([{ slot: 1, sn: CORE_A }, { slot: 2, sn: CORE_B }, { slot: 3, sn: null, isConnected: false }]),
    [CORE_A]: dpu(CORE_A, 'Core 4'),
    [CORE_B]: dpu(CORE_B, 'DELTA Pro Ultra', { nameFallback: true }),
    [CORE_C]: dpu(CORE_C, 'DELTA Pro Ultra', { nameFallback: true }),
  };
  assert.equal(coreNumber(devices[CORE_A], devices), 4, 'an owner name keeps its own number, whatever slot the Core is in');
  assert.equal(coreNumber(devices[CORE_B], devices), 2, 'the fallback-named Core in slot 2 is Core 2');
  assert.equal(coreNumber(devices[CORE_C], devices), null, 'a fallback-named Core on no panel has no number');
  assert.equal(coreNumber({ sn: CORE_C, deviceName: CORE_C, nameFallback: true }, devices), null, 'never the digits of its serial');
  assert.equal(coreNumber(devices[CORE_B]), null, 'no device map: no slot to read');
});

test('slotOfDpu: a connected listing first, the lowest-serial panel first', () => {
  const other = 'HD31XXX00XXX0002';
  const devices = {
    [other]: panel([{ slot: 3, sn: CORE_A }], other),
    [PANEL]: panel([{ slot: 1, sn: CORE_A, isConnected: false }]),
  };
  assert.equal(slotOfDpu(devices, CORE_A), 3, 'the connected listing wins over a disconnected one');
  assert.equal(slotOfDpu({ [PANEL]: panel([{ slot: 1, sn: CORE_A, isConnected: false }]) }, CORE_A), 1, 'a disconnected listing still places it');
  assert.equal(slotOfDpu(devices, CORE_C), null);
  assert.equal(slotOfDpu(null, CORE_A), null);
});

test('★ coreLabel: "Core N" with a number, the device name without one — never "Core null"', () => {
  assert.equal(DPU_LABEL, 'Core', 'OWNER DECISION 6 keeps "Core" as the label');
  assert.equal(coreLabel(3, 'Core 3'), 'Core 3');
  assert.equal(coreLabel(0, 'x'), 'Core 0');
  assert.equal(coreLabel(null, 'DELTA Pro Ultra'), 'DELTA Pro Ultra');
  assert.equal(coreLabel(undefined, 'DELTA Pro Ultra (…0012)'), 'DELTA Pro Ultra (…0012)');
  assert.equal(coreLabel(Number.NaN, 'Garage'), 'Garage');
});

test('★ two un-renamed DPUs get distinct names: the slot, else the serial tail; an owner\'s name is never touched', () => {
  const slots: Record<string, number | null> = { [CORE_A]: 2, [CORE_B]: null, [CORE_C]: null };
  const out = disambiguateFallbackNames([
    { sn: CORE_A, name: 'DELTA Pro Ultra', fallback: true },
    { sn: CORE_B, name: 'DELTA Pro Ultra', fallback: true },
    { sn: CORE_C, name: 'Core 3', fallback: false },
    { sn: 'KT21XXX00XXX0005', name: 'WAVE 2', fallback: true },
  ], (sn) => slots[sn] ?? null);
  assert.equal(out.get(CORE_A), 'DELTA Pro Ultra (slot 2)');
  assert.equal(out.get(CORE_B), 'DELTA Pro Ultra (…0012)');
  assert.equal(out.get(CORE_C), 'Core 3');
  assert.equal(out.get('KT21XXX00XXX0005'), 'WAVE 2', 'a fallback name no one else carries is kept');
  assert.notEqual(out.get(CORE_A), out.get(CORE_B));
  // A name an owner gave twice is the owner's choice: left alone.
  const owned = disambiguateFallbackNames([{ sn: CORE_A, name: 'Garage', fallback: false }, { sn: CORE_B, name: 'Garage', fallback: false }], () => null);
  assert.deepEqual([...owned.values()], ['Garage', 'Garage']);
  // A serial listed twice is one device, not a collision.
  const twice = disambiguateFallbackNames([{ sn: CORE_A, name: 'DELTA Pro Ultra', fallback: true }, { sn: CORE_A, name: 'DELTA Pro Ultra', fallback: true }], () => null);
  assert.equal(twice.get(CORE_A), 'DELTA Pro Ultra');
});

test('a disambiguated name reads back the right Core number by name alone (the analytics worker\'s path)', () => {
  assert.equal(coreNumberFromName(disambiguatedName('DELTA Pro Ultra', { sn: CORE_A, slot: 2 })), 2, 'the slot form names the slot');
  assert.equal(coreNumberFromName(disambiguatedName('DELTA Pro Ultra', { sn: CORE_B, slot: null })), null, 'the serial tail is not a Core number');
});

test('the console sorts a fallback-named DPU by its slot, an owner-named one by its name', () => {
  const devices = {
    [PANEL]: panel([{ slot: 1, sn: CORE_B }]),
    [CORE_A]: dpu(CORE_A, 'Core 2'),
    [CORE_B]: dpu(CORE_B, 'DELTA Pro Ultra', { nameFallback: true }),
    [CORE_C]: dpu(CORE_C, 'Core 3'),
  };
  const order = getDpus({ snap: { generatedAt: 0, devices } } as never).map((d) => d.sn);
  assert.deepEqual(order, [CORE_B, CORE_A, CORE_C]);
});

/* ── warranty export default (X1) ── */

const LEGACY = 'Y711XXX00XXX0099';

test('★ X1: the legacy default chassis while it is on the account (this install), else the one latched chassis, else none', () => {
  const devices = { [CORE_A]: { sn: CORE_A, productName: 'DELTA Pro Ultra' }, [CORE_B]: { sn: CORE_B, productName: 'DELTA Pro Ultra' }, [PANEL]: { sn: PANEL, productName: 'Smart Home Panel 2' } };
  assert.deepEqual(warrantyChassis(CORE_B, LEGACY, devices, []), { sn: CORE_B, via: 'query' }, '?sn= always wins');
  assert.deepEqual(warrantyChassis(undefined, LEGACY, { ...devices, [LEGACY]: { sn: LEGACY, productName: 'DELTA Pro Ultra' } }, [CORE_A]), { sn: LEGACY, via: 'legacy-default' },
    'the legacy default on the map wins over a latched chassis');
  assert.deepEqual(warrantyChassis(undefined, LEGACY, devices, [CORE_A, CORE_A]), { sn: CORE_A, via: 'latched' }, 'two packs latched in one chassis: that chassis');
  const none = warrantyChassis(undefined, LEGACY, devices, []);
  assert.ok('error' in none);
  assert.deepEqual(none.candidates, ['…0011', '…0012'], 'the 400 lists each Core\'s last four characters, and only the Cores');
  const two = warrantyChassis(undefined, LEGACY, devices, [CORE_A, CORE_B]);
  assert.ok('error' in two && /more than one chassis/.test(two.error));
});

test('DECISION 2: the defective-pack alerts point at the export WITH the chassis serial', () => {
  const alerts = read('alerts.ts');
  assert.equal((alerts.match(/Capture evidence with \/api\/warranty-export\?sn=\$\{d\.sn\}\./g) ?? []).length, 2);
  assert.doesNotMatch(alerts, /Capture evidence with \/api\/warranty-export\.\$\{/);
});
