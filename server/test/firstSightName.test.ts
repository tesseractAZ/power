/**
 * v1.187.10 (log review 10-03, C31) — the device-list "first sight" line names the device as the
 * store keeps it (resolveDeviceName + sanitizeDisplayName), not the raw cloud name.
 *
 * A device the cloud lists under its bare serial printed "device-list: <SN> (<SN>) first sight",
 * and a cloud name with a leading space kept it, while the fleet-status line and every later line
 * used the resolved name. Device ids are made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'ef-first-sight-'));
process.env.DB_PATH = join(TMP, 'ecoflow.db');
for (const k of ['GRID_READING_PATH', 'SHADOW_WITNESS_PATH', 'HOUSE_PANEL_PATH', 'POOL_UNKNOWN_PATH', 'PACK_GHOSTS_PATH']) {
  process.env[k] = join(TMP, `${k.toLowerCase()}.json`);
}
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { SnapshotStore } = await import('../src/snapshot.js');

const WAVE = 'WAVEXXX00XXX0001';
const BACC = 'BACCXXX00XXX0001';

test('★★ first sight logs the resolved, trimmed name the store keeps — not the bare serial twice, not a leading space', () => {
  const store = new SnapshotStore();
  const logs: string[] = [];
  store.setLogger((m) => logs.push(m));
  store.setDeviceList([
    { sn: WAVE, deviceName: WAVE, productName: 'WAVE 2', online: 0 },
    { sn: BACC, deviceName: ' BACC - Delta 3 Plus', productName: 'DELTA 3 Plus', online: 1 },
  ] as any);
  const devices = store.get().devices;
  const sight = logs.filter((l) => l.includes('first sight'));
  assert.deepEqual(sight, [
    `device-list: ${devices[WAVE].deviceName} (${WAVE}) first sight, offline`,
    `device-list: ${devices[BACC].deviceName} (${BACC}) first sight, online`,
  ]);
  assert.notEqual(devices[WAVE].deviceName, WAVE, 'a cloud name that is the serial resolves to the product');
  assert.ok(!/^device-list: {2}/.test(sight[1]), 'no raw leading space');
  assert.equal(devices[BACC].deviceName, 'BACC - Delta 3 Plus');
});
