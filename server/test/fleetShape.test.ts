/**
 * v1.187.18 — nothing assumes the fleet's shape.
 *
 * A Delta Pro Ultra carries one to five packs, and the account's Cores are not all on the
 * panel: at 2026-10 three home Cores of five packs (92.16 kWh nameplate) and two bench Cores,
 * one of them on four packs since its defective pack was pulled. Two code paths invented a
 * shape instead of reading it:
 *
 *  - the DPU card drew `p?.packs.length ?? 5` tiles, so a Core with no direct projection (after
 *    a restart while it is cloud-offline, briefly at every boot) showed "5 battery packs";
 *  - /api/dispatch/recommend planned against a 60 kWh pool at 50 % whenever the SHP2's backup
 *    readings were untrusted, and returned that plan with a 200, cached 300 s.
 *
 * The forecast's capacity fallback is pinned in forecast.test.ts and displayPvContract.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dpuPackSlots, DPU_MAX_PACKS } from '../../web/src/cards/cardText.js';
import { mpcPoolBasis } from '../src/dispatch/mpc.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const packs = (...nums: number[]) => nums.map((num) => ({ num }));

test('★★★ dpuPackSlots: a Core with no direct projection has NO invented count', () => {
  assert.equal(dpuPackSlots(undefined), null);
  assert.equal(dpuPackSlots(null), null);
  assert.equal(dpuPackSlots({ packCount: null, packs: [] }), null, 'no packs and no count → unknown, not 5');
});

test('★★ dpuPackSlots: one tile per pack the Core reports', () => {
  assert.deepEqual(dpuPackSlots({ packCount: 4, packs: packs(1, 2, 3, 4) }), [1, 2, 3, 4], 'a four-pack Core draws four');
  assert.deepEqual(dpuPackSlots({ packCount: 5, packs: packs(1, 2, 3, 4, 5) }), [1, 2, 3, 4, 5]);
  assert.deepEqual(dpuPackSlots({ packCount: 1, packs: packs(1) }), [1]);
});

test('★★ dpuPackSlots: the count itself is used at both ends of its range (1 and 5)', () => {
  assert.deepEqual(dpuPackSlots({ packCount: 5, packs: packs(1, 2, 3, 4) }), [1, 2, 3, 4, 5], 'five-pack Core, one reading missing');
  assert.deepEqual(dpuPackSlots({ packCount: 5, packs: [] }), [1, 2, 3, 4, 5]);
  assert.deepEqual(dpuPackSlots({ packCount: 1, packs: [] }), [1]);
});

test('★★ dpuPackSlots: the Core\'s own count fills placeholders by NUMBER', () => {
  assert.deepEqual(dpuPackSlots({ packCount: 4, packs: [] }), [1, 2, 3, 4], 'count known, readings not yet in');
  assert.deepEqual(dpuPackSlots({ packCount: 4, packs: packs(1, 2, 4) }), [1, 2, 3, 4], 'pack 3 missing keeps its place');
  assert.deepEqual(dpuPackSlots({ packCount: null, packs: packs(2, 1) }), [1, 2], 'no count: the packs present, in order');
  // A pack the projection still lists beyond the count stays visible (today's behaviour).
  assert.deepEqual(dpuPackSlots({ packCount: 4, packs: packs(1, 2, 3, 4, 5) }), [1, 2, 3, 4, 5]);
});

test('★ dpuPackSlots: an out-of-range count is ignored, never trusted', () => {
  assert.equal(DPU_MAX_PACKS, 5);
  for (const bad of [0, -1, 6, 2.5, Number.NaN]) {
    assert.deepEqual(dpuPackSlots({ packCount: bad, packs: packs(1, 2) }), [1, 2], `packCount ${bad}`);
    assert.equal(dpuPackSlots({ packCount: bad, packs: [] }), null, `packCount ${bad} with no packs`);
  }
});

test('★★ the DPU card renders dpuPackSlots, with no fallback count and no per-pack bar it has no reading for', () => {
  const card = src('web/src/cards/DpuCard.tsx');
  assert.doesNotMatch(card, /\?\?\s*5\b/, 'no `?? 5` anywhere in the card');
  assert.match(card, /const packSlots = dpuPackSlots\(p\);/);
  assert.match(card, /packSlots == null \? \(\s*<div className="text-xs text-muted">\{p \? 'Pack readings not yet received' : 'Pack detail needs DPU WiFi'\}<\/div>/);
  assert.match(card, /\{packSlots\.map\(\(num\) =>/, 'tiles are drawn from packSlots');
  assert.match(card, /\{packSlots\.length\} battery pack\{packSlots\.length === 1 \? '' : 's'\}/, 'the label counts packSlots');
  assert.doesNotMatch(card, /\[1, 2, 3, 4, 5\]|length: 5\b/, 'no fixed five anywhere');
  assert.match(card, /p\?\.packs\.find\(\(x\) => x\.num === num\)/, 'tiles match packs by number, not array index');
  const ph = card.slice(card.indexOf('// No reading for this pack'));
  const placeholder = ph.slice(0, ph.indexOf(');'));
  assert.match(placeholder, /<div className="bar mt-1" \/>/, 'the placeholder bar is empty');
  assert.doesNotMatch(placeholder, /style=|headlineSoc/, 'no fill, and nothing from the Core SoC, on a pack with no reading');
});

test('★★★ mpcPoolBasis: the optimizer gets the SHP2\'s pool or nothing', () => {
  assert.deepEqual(mpcPoolBasis({ backupFullCapWh: 92_160, backupBatPercent: 96 }), { capacityKwh: 92.16, currentSocPct: 96 });
  assert.deepEqual(mpcPoolBasis({ backupFullCapWh: 92_160, backupBatPercent: 0 }), { capacityKwh: 92.16, currentSocPct: 0 });
  assert.deepEqual(mpcPoolBasis({ backupFullCapWh: 92_160, backupBatPercent: 100 }), { capacityKwh: 92.16, currentSocPct: 100 });
  assert.equal(mpcPoolBasis({ backupFullCapWh: null, backupBatPercent: null }), null, 'untrusted trio → no plan');
  assert.equal(mpcPoolBasis({ backupFullCapWh: 92_160, backupBatPercent: null }), null);
  assert.equal(mpcPoolBasis({ backupFullCapWh: null, backupBatPercent: 96 }), null);
  assert.equal(mpcPoolBasis({}), null);
  for (const fullWh of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(mpcPoolBasis({ backupFullCapWh: fullWh, backupBatPercent: 50 }), null, `fullWh ${fullWh}`);
  }
  for (const soc of [-1, 100.5, Number.NaN]) {
    assert.equal(mpcPoolBasis({ backupFullCapWh: 92_160, backupBatPercent: soc }), null, `soc ${soc}`);
  }
});

test('★★ /api/dispatch/recommend answers 503 on an unknown pool instead of planning a made-up one', () => {
  const idx = src('server/src/index.ts');
  const route = idx.slice(idx.indexOf("app.get('/api/dispatch/recommend'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /const pool = mpcPoolBasis\(sp\);\s*if \(!pool\) \{\s*reply\.code\(503\);\s*return \{ error: 'backup pool unknown' \};/);
  assert.match(body, /currentSocPct: pool\.currentSocPct,/);
  assert.match(body, /capacityKwh: pool\.capacityKwh,/);
  assert.doesNotMatch(body, /backupFullCapWh \?\?|backupBatPercent \?\?/, 'no substitute pool or SoC');
});
