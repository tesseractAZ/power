import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (S8, plan 3.11 and CA4) — display aliases in three layers (DEVICE_ALIASES over
 * `<dataRoot>/device-aliases.json` over the image file), the snapshot's fallback-name flag, the
 * disambiguator for two un-renamed devices, and the repair cards that used to print "Core null".
 * Serials are placeholders (…XXX00XXX00NN); the image file's own entry is read, never written out.
 */

// Set BEFORE any src module loads: the store reads the aliases once, when snapshot.ts loads.
const TMP = mkdtempSync(join(tmpdir(), 'device-aliases-test-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
process.env.DB_PATH = join(TMP, 'ecoflow.db');
const DATA_ALIASED = 'Y711XXX00XXX0021';
const OPTION_ALIASED = 'Y711XXX00XXX0022';
const BOTH = 'Y711XXX00XXX0023';
writeFileSync(join(TMP, 'device-aliases.json'), JSON.stringify({ aliases: { [DATA_ALIASED]: 'Core 7', [BOTH]: 'From data' } }));
process.env.DEVICE_ALIASES = JSON.stringify({ [OPTION_ALIASED]: 'Core 8', [BOTH]: 'Core 9' });

const topology = await import('../src/topology.js');
const { SnapshotStore, isFallbackName } = await import('../src/snapshot.js');
const { computeRepairIssues } = await import('../src/repairIssues.js');
const { OPTIONS } = await import('../src/config.js');

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = JSON.parse(readFileSync(resolve(SERVER, 'device-aliases.json'), 'utf8')) as { aliases: Record<string, string> };
const [IMAGE_SN, IMAGE_NAME] = Object.entries(IMAGE.aliases)[0] as [string, string];

const file = (name: string, body: unknown): string => {
  const p = join(TMP, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

/* ── the three layers ── */

test('★ unset: the image file alone (no /data file, no option) — today\'s aliases, exactly', () => {
  const r = topology.loadDeviceAliases({ dataPath: join(TMP, 'absent.json'), optionRaw: null });
  assert.deepEqual(r.aliases, IMAGE.aliases);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sourceBySn[IMAGE_SN], 'image');
});

test('★ the /data file overrides the image file, and the option overrides the /data file (per serial)', () => {
  const image = file('image.json', { _comment: 'x', aliases: { A1: 'image A', B1: 'image B', C1: 'image C' } });
  const data = file('data.json', { aliases: { B1: 'data B', C1: 'data C' } });
  const r = topology.loadDeviceAliases({ imagePath: image, dataPath: data, optionRaw: JSON.stringify({ C1: 'option C' }) });
  assert.deepEqual(r.aliases, { A1: 'image A', B1: 'data B', C1: 'option C' });
  assert.deepEqual(r.sourceBySn, { A1: 'image', B1: 'data', C1: 'option' });
  // Only the image layer: identical to the old reader for the image file's shape.
  assert.deepEqual(topology.loadDeviceAliases({ imagePath: image, dataPath: join(TMP, 'nope.json'), optionRaw: null }).aliases, { A1: 'image A', B1: 'image B', C1: 'image C' });
});

test('both forms are read (flat, and under `aliases`); blank names and `_` keys are dropped', () => {
  assert.deepEqual(topology.parseAliasMap('{"A1":"One","B1":"  ","_c":"x","C1":3}'), { A1: 'One' });
  assert.deepEqual(topology.parseAliasMap('{"aliases":{"A1":"One"},"_comment":"hi"}'), { A1: 'One' });
  assert.throws(() => topology.parseAliasMap('[1,2]'));
  assert.throws(() => topology.parseAliasMap('not json'));
});

test('★ fail closed: an unreadable option or /data file is skipped (the layers below still apply) and reported', () => {
  const image = file('image2.json', { aliases: { A1: 'image A' } });
  const badData = file('bad-data.json', '{ nope');
  const r = topology.loadDeviceAliases({ imagePath: image, dataPath: badData, optionRaw: '{"A1": oops}' });
  assert.deepEqual(r.aliases, { A1: 'image A' });
  assert.deepEqual(r.errors.map((e) => e.source).sort(), ['data', 'option']);
  assert.ok(r.errors.every((e) => e.message === 'not valid JSON'), 'the parse error never quotes the text (the owner\'s serials)');
  // A broken IMAGE file stays silent, as before.
  assert.deepEqual(topology.loadDeviceAliases({ imagePath: badData, dataPath: join(TMP, 'none.json'), optionRaw: null }), { aliases: {}, sourceBySn: {}, errors: [] });
});

test('DEVICE_ALIASES is a schema-only option exported under has_value', () => {
  assert.equal(OPTIONS.DEVICE_ALIASES.exportForm, 'has_value');
  assert.equal(OPTIONS.DEVICE_ALIASES.parse('  ', { get: () => undefined }), null, 'blank is unset');
});

/* ── the store ── */

const PANEL = 'HD31XXX00XXX0001';
const OWNER = 'Y711XXX00XXX0024';
const UNNAMED_A = 'Y711XXX00XXX0025';
const UNNAMED_B = 'Y711XXX00XXX0026';
const PERIPHERAL = 'KT21XXX00XXX0027';

const list = () => [
  { sn: PANEL, deviceName: 'House panel', productName: 'Smart Home Panel 2', online: 1 },
  { sn: DATA_ALIASED, deviceName: 'whatever', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: OPTION_ALIASED, deviceName: OPTION_ALIASED, productName: 'DELTA Pro Ultra', online: 1 },
  { sn: BOTH, deviceName: 'x', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: OWNER, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: UNNAMED_A, deviceName: UNNAMED_A, productName: 'DELTA Pro Ultra', online: 1 },
  { sn: UNNAMED_B, deviceName: '', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: PERIPHERAL, deviceName: PERIPHERAL, productName: 'WAVE 2', online: 1 },
  { sn: IMAGE_SN, deviceName: 'cloud name', productName: 'DELTA Pro Ultra', online: 1 },
] as never;

test('★ the store names devices from the merged aliases: option over /data over image, the cloud name otherwise', () => {
  const store = new SnapshotStore();
  store.setDeviceList(list());
  const d = store.get().devices;
  assert.equal(d[DATA_ALIASED].deviceName, 'Core 7', 'the /data alias');
  assert.equal(d[OPTION_ALIASED].deviceName, 'Core 8', 'the option alias');
  assert.equal(d[BOTH].deviceName, 'Core 9', 'the option wins over the /data file');
  assert.equal(d[IMAGE_SN].deviceName, IMAGE_NAME, 'the image alias still applies');
  assert.equal(d[OWNER].deviceName, 'Core 1');
});

test('★ CA4: only a fallback-named DPU carries nameFallback; two of them get distinct names; a named device is untouched', () => {
  const store = new SnapshotStore();
  store.setDeviceList(list());
  const d = store.get().devices;
  for (const sn of [PANEL, DATA_ALIASED, OPTION_ALIASED, BOTH, OWNER, IMAGE_SN, PERIPHERAL]) {
    assert.equal('nameFallback' in d[sn], false, `${sn}: a named device's object gains no field`);
  }
  assert.equal(d[UNNAMED_A].nameFallback, true);
  assert.equal(d[UNNAMED_B].nameFallback, true);
  assert.notEqual(d[UNNAMED_A].deviceName, d[UNNAMED_B].deviceName, 'two un-renamed DPUs no longer share one name');
  assert.equal(d[UNNAMED_A].deviceName, 'DELTA Pro Ultra (…0025)');
  assert.equal(d[UNNAMED_B].deviceName, 'DELTA Pro Ultra (…0026)');
  assert.equal(d[PERIPHERAL].deviceName, 'WAVE 2', 'a lone fallback name is kept as it was');
  // Once the panel lists one of them in a slot, the slot names it (the next device list).
  (d[PANEL] as { projection?: unknown }).projection = { kind: 'shp2', sources: [{ slot: 2, sn: UNNAMED_A, isConnected: true }] };
  store.setDeviceList(list());
  const again = store.get().devices;
  assert.equal(again[UNNAMED_A].deviceName, 'DELTA Pro Ultra (slot 2)');
  assert.equal(topology.coreNumber(again[UNNAMED_A], again), 2, 'and it is Core 2');
  assert.equal(topology.coreNumber(again[UNNAMED_B], again), null, 'the other has no number, never its serial digits');
  assert.equal(topology.coreNumber(again[OWNER], again), 1);
});

test('isFallbackName mirrors resolveDeviceName\'s fallback condition', () => {
  assert.equal(isFallbackName('Core 1', 'X1'), false);
  assert.equal(isFallbackName('X1', 'X1'), true);
  assert.equal(isFallbackName(' X1 ', 'X1'), true);
  assert.equal(isFallbackName('', 'X1'), true);
  assert.equal(isFallbackName(null, 'X1'), true);
});

/* ── repair cards ── */

const repairCtx = (over: Record<string, unknown> = {}) => ({
  devices: {}, alerts: [], degradation: null, soiling: null, equipmentHealth: null, forecastSkill: null, ...over,
}) as never;

test('★ no "Core null": a pack or string whose Core has no number is named by its device', () => {
  const r = computeRepairIssues(repairCtx({
    degradation: { packs: [
      { sn: UNNAMED_A, device: 'DELTA Pro Ultra (…0025)', coreNum: null, packNum: 2, peerOutlier: true, peerFadeRatio: 2.1, summary: '' },
      { sn: OWNER, device: 'Core 1', coreNum: 1, packNum: 3, peerOutlier: true, peerFadeRatio: 2.2, summary: '' },
    ] },
    equipmentHealth: { mpptStrings: [{ sn: UNNAMED_A, device: 'DELTA Pro Ultra (…0025)', coreNum: null, string: 'HV', driftPctPts: -5, recentEffPct: 90, baselineEffPct: 95 }], inverterStandby: [] },
  }));
  const titles = r.issues.map((i) => i.title);
  assert.ok(titles.includes('Pack wearing fast: DELTA Pro Ultra (…0025) · Pack 2'), titles.join(' | '));
  assert.ok(titles.includes('Pack wearing fast: Core 1 · Pack 3'), 'a numbered Core reads exactly as before');
  assert.ok(titles.includes('MPPT reading drift: DELTA Pro Ultra (…0025) HV string'));
  assert.ok(titles.every((t) => !/Core (null|undefined)/.test(t)));
});

test('★ an unreadable DEVICE_ALIASES raises a repair item; a BENCH_SPARE_SNS serial on no device raises one too', () => {
  const savedAliases = process.env.DEVICE_ALIASES;
  const savedSpares = process.env.BENCH_SPARE_SNS;
  try {
    process.env.DEVICE_ALIASES = '{"broken":';
    topology.resetDeviceAliasesForTesting();
    process.env.BENCH_SPARE_SNS = `${OWNER},Y711XXX00XXX0099`;
    const devices = { [OWNER]: { sn: OWNER, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true, lastUpdated: 0 } };
    const r = computeRepairIssues(repairCtx({ devices }));
    const alias = r.issues.find((i) => i.id === 'device-aliases-unreadable-option');
    assert.ok(alias, r.issues.map((i) => i.id).join(','));
    assert.equal(alias!.category, 'Configuration');
    assert.doesNotMatch(alias!.summary, /broken/, 'the option text is never echoed');
    const spare = r.issues.find((i) => i.id === 'bench-spare-unknown');
    assert.ok(spare);
    assert.match(spare!.summary, /…0099/);
    assert.doesNotMatch(spare!.summary, /Y711XXX00XXX0099/, 'only the last four characters');
    // Unset: neither card.
    delete process.env.DEVICE_ALIASES;
    delete process.env.BENCH_SPARE_SNS;
    topology.resetDeviceAliasesForTesting();
    const clean = computeRepairIssues(repairCtx({ devices }));
    assert.deepEqual(clean.issues.filter((i) => i.category === 'Configuration').map((i) => i.id), []);
  } finally {
    if (savedAliases === undefined) delete process.env.DEVICE_ALIASES; else process.env.DEVICE_ALIASES = savedAliases;
    if (savedSpares === undefined) delete process.env.BENCH_SPARE_SNS; else process.env.BENCH_SPARE_SNS = savedSpares;
    topology.resetDeviceAliasesForTesting();
  }
});
