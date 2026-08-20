import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWarrantyBundle, renderWarrantyMarkdown, renderWarrantyCsv } from '../src/warrantyExport.js';

/**
 * v1.90.0 (B3) — the warranty evidence bundle. Built for the Core 3 pack-1
 * RMA (err533, spread 71→98→122 mV) but generic over any DPU serial. The
 * invariants: spread derives from the REAL cell grid when present (falls back
 * to the projected maxVolDiffMv), history admits a row by id-contains-SN OR
 * sourceSn (the v1.78.0 evidence-gate lesson: SN-less ids exist), and the
 * renders carry every number the RMA thread needs.
 */

const SN = 'Y711FAB59J234000';

function device() {
  return {
    sn: SN,
    deviceName: 'Core 3',
    projection: {
      kind: 'dpu', soc: 43, errCode: 533,
      emsParaVolMinMv: 3210, emsParaVolMaxMv: 3390,
      packs: [
        { num: 1, packSn: 'PACK1SN', soc: 4, actSoh: 99, adBatVoltageMv: 51_200, cycles: 412, remainCapMah: 3_100, temp: 31, cellVoltagesMv: [3300, 3298, 3202, 3305] },
        { num: 2, packSn: 'PACK2SN', soc: 12, actSoh: 99, maxVolDiffMv: 22, cycles: 398 }, // no cell grid -> fallback
      ],
    },
  };
}

const CLEARED = [
  { alert: { id: `pack-imbalance-${SN}-p1`, severity: 'critical', title: 'Cell imbalance', fault: 'err533' }, raisedAt: Date.UTC(2026, 6, 20, 12), clearedAt: Date.UTC(2026, 6, 20, 14), durationMs: 2 * 3_600_000 },
  { alert: { id: 'weird-snless-id', sourceSn: SN, severity: 'warning', title: 'BMS warning' }, raisedAt: Date.UTC(2026, 6, 18, 8), clearedAt: Date.UTC(2026, 6, 18, 9), durationMs: 3_600_000 },
  { alert: { id: 'offline-OTHERSN', sourceSn: 'OTHERSN', severity: 'warning', title: 'Other device' }, raisedAt: 1, clearedAt: Date.UTC(2026, 7, 1), durationMs: 60_000 },
];

test('bundle: spread comes from the real cell grid; fallback is maxVolDiffMv', () => {
  const b = buildWarrantyBundle(device(), CLEARED as any, '2026-08-19T12:00:00Z');
  assert.equal(b.sysErrCode, 533);
  assert.equal(b.packs[0].spreadMv, 3305 - 3202, 'min/max over the actual cells');
  assert.equal(b.packs[0].minCellMv, 3202);
  assert.equal(b.packs[0].maxCellMv, 3305);
  assert.equal(b.packs[1].spreadMv, 22, 'no cell grid -> projected maxVolDiffMv');
  assert.equal(b.packs[1].cellVoltagesMv, null);
});

test('history: admitted by id-contains-SN OR sourceSn, other devices excluded, newest first', () => {
  const b = buildWarrantyBundle(device(), CLEARED as any, '2026-08-19T12:00:00Z');
  assert.equal(b.history.length, 2, 'the OTHERSN row must not leak in');
  assert.equal(b.history[0].title, 'Cell imbalance', 'newest first');
  assert.equal(b.history[1].title, 'BMS warning', 'SN-less id admitted via sourceSn');
  assert.equal(b.history[0].fault, 'err533');
});

test('markdown render carries the numbers the RMA thread needs', () => {
  const md = renderWarrantyMarkdown(buildWarrantyBundle(device(), CLEARED as any, '2026-08-19T12:00:00Z'));
  assert.match(md, /Core 3 \(Y711FAB59J234000\)/);
  assert.match(md, /Device error code: \*\*533\*\*/);
  assert.match(md, /\| 1 \| PACK1SN \| 4 \| 99 \|/);
  assert.match(md, /cells 1–4: 3300, 3298, 3202, 3305/);
  assert.match(md, /Cell imbalance/);
});

test('csv render: one row per cell, only packs with a real grid', () => {
  const csv = renderWarrantyCsv(buildWarrantyBundle(device(), CLEARED as any, '2026-08-19T12:00:00Z'));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'pack,pack_sn,cell,voltage_mv');
  assert.equal(lines.length, 1 + 4, 'pack 2 has no grid and contributes no rows');
  assert.equal(lines[3], '1,PACK1SN,3,3202');
});
