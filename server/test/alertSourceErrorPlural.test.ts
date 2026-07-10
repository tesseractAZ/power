import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.2.0 — "SHP2 slot 1 reports 1 error(s)."
 *
 * `shp2-src-err` is a CRITICAL alert, and critical alert details are read aloud by the
 * TTS broadcast path. "error(s)" is not a thing a voice can pronounce. `errorCodeNum`
 * is a COUNT of active error codes, so pluralize it properly.
 * =================================================================== */

const now = Date.now();

const shp2With = (errorCodeNum: number): DeviceSnapshot => ({
  sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: now,
  projection: {
    kind: 'shp2', backupBatPercent: 80, backupReserveSoc: 10, pairedCircuits: [],
    sources: [{ slot: 1, errorCodeNum, isConnected: true, hwConnect: true }],
  } as any,
} as DeviceSnapshot);

const detailFor = (n: number): string | undefined =>
  computeAlerts([shp2With(n)]).find((a) => a.id === 'shp2-src-err-1')?.detail;

test('exactly one error reads as singular — no "error(s)" reaches TTS', () => {
  const d = detailFor(1);
  assert.equal(d, 'SHP2 slot 1 reports 1 error.');
  assert.ok(!d!.includes('(s)'));
});

test('more than one error reads as plural', () => {
  assert.equal(detailFor(3), 'SHP2 slot 1 reports 3 errors.');
});

test('zero errors raises no alert at all', () => {
  assert.equal(detailFor(0), undefined);
});
