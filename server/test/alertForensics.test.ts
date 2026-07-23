import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packCellForensics, packLatchSignature } from '../src/alerts.js';

/* v1.41.0 — the cell-forensics contract: a battery fault alert must isolate
 * the exact deviant cell with supporting ranges (vs pack median AND sibling
 * packs), and the protection-latch classifier must fire only on the full
 * three-legged signature — never on benign shared idleness. */

const mkCells = (n: number, baseMv: number, overrides: Record<number, number> = {}): number[] =>
  Array.from({ length: n }, (_, i) => overrides[i + 1] ?? baseMv);

test('forensics — isolates the single weak cell with signed deviation and sibling contrast', () => {
  const packs = [
    { num: 1, cellVoltagesMv: mkCells(32, 3198, { 31: 3124 }) },  // cell #31 low by 74 mV
    { num: 2, cellVoltagesMv: mkCells(32, 3200, { 7: 3204 }) },   // benign 4 mV spread
    { num: 3, cellVoltagesMv: mkCells(32, 3199, { 12: 3196 }) },  // benign 3 mV spread
  ];
  const f = packCellForensics(packs, 1)!;
  assert.equal(f.deviantCell, 31, 'must name the exact cell');
  assert.equal(f.deviantMv, 3124);
  assert.equal(f.deltaMv, -74, 'signed deviation vs pack median (weak/low)');
  assert.equal(f.spreadMv, 74);
  assert.deepEqual([...f.siblingSpreadsMv].sort(), [3, 4], 'sibling ranges for contrast');
});

test('forensics — a HIGH deviant cell reports a positive delta', () => {
  const packs = [{ num: 1, cellVoltagesMv: mkCells(32, 3200, { 5: 3260 }) }];
  const f = packCellForensics(packs, 1)!;
  assert.equal(f.deviantCell, 5);
  assert.equal(f.deltaMv, 60);
});

test('forensics — null over fabrication: missing/degenerate cell data', () => {
  assert.equal(packCellForensics([{ num: 1, cellVoltagesMv: [] }], 1), null);
  assert.equal(packCellForensics([{ num: 1, cellVoltagesMv: [3200, 0, 3200, 3200] }], 1), null, 'zero reading ⇒ null');
  assert.equal(packCellForensics([{ num: 2, cellVoltagesMv: mkCells(32, 3200) }], 1), null, 'pack absent');
});

test('latch — fires on the full signature: SoC-stranded + zero flow + active siblings', () => {
  const packs = [
    { num: 1, soc: 8, inputWatts: 0, outputWatts: 0 },
    { num: 2, soc: 54, inputWatts: 620, outputWatts: 0 },
    { num: 3, soc: 52, inputWatts: 635, outputWatts: 0 },
    { num: 4, soc: 51, inputWatts: 610, outputWatts: 0 },
  ];
  const l = packLatchSignature(packs, 1)!;
  assert.equal(l.socPct, 8);
  assert.ok(l.siblingMedianSocPct >= 51);
  assert.equal(l.packAbsW, 0);
  assert.ok(l.siblingMedianAbsW >= 600);
});

test('latch — does NOT fire when siblings are also idle (benign shared idleness)', () => {
  const packs = [
    { num: 1, soc: 8, inputWatts: 0, outputWatts: 0 },
    { num: 2, soc: 54, inputWatts: 0, outputWatts: 0 },
    { num: 3, soc: 52, inputWatts: 0, outputWatts: 0 },
  ];
  assert.equal(packLatchSignature(packs, 1), null);
});

test('latch — does NOT fire on modest SoC drift (< 20 pts)', () => {
  const packs = [
    { num: 1, soc: 40, inputWatts: 0, outputWatts: 0 },
    { num: 2, soc: 55, inputWatts: 620, outputWatts: 0 },
    { num: 3, soc: 52, inputWatts: 600, outputWatts: 0 },
  ];
  assert.equal(packLatchSignature(packs, 1), null);
});

test('latch — null when pack power telemetry is absent (no fabricated verdict)', () => {
  const packs = [
    { num: 1, soc: 8, inputWatts: null, outputWatts: null },
    { num: 2, soc: 54, inputWatts: 620, outputWatts: 0 },
    { num: 3, soc: 52, inputWatts: 600, outputWatts: 0 },
  ];
  assert.equal(packLatchSignature(packs, 1), null);
});
