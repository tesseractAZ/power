import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.45.0 — `errorCodeNum` carries the source device's ERROR CODE, not a
 * count. Proven live 2026-07-23: SHP2 slot 3 read 533, byte-identical to
 * Core 3's own sysErrCode 533 (battery/BMS protection band) during a real
 * BMS protection latch; the 2026-07-12 episode's "461" was likewise a code.
 * The v1.2.0 count reading produced "SHP2 slot 3 reports 533 errors" —
 * factually wrong, needlessly alarming, and spoken aloud by TTS.
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
  computeAlerts([shp2With(n)] as any).find((a) => a.id === 'shp2-src-err-1')?.detail;

test('a 5xx code names the code and the battery/BMS band — never "N errors"', () => {
  const d = detailFor(533);
  assert.equal(d, 'SHP2 slot 1 reports error code 533 (battery/BMS protection band).');
  assert.ok(!d!.includes('errors'));
});

test('a non-5xx code names the code without the band note', () => {
  assert.equal(detailFor(461), 'SHP2 slot 1 reports error code 461.');
});

test('zero (no error code) raises no alert at all', () => {
  assert.equal(detailFor(0), undefined);
});
