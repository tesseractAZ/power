/**
 * v1.187.10 (log review) — the stale-shadow latch SETTING logs at warn.
 *
 * 2026-10-02 00:09:17: "shp2-shadow: … the cloud is serving a STALE SHADOW; grid readings are being
 * treated as UNKNOWN" logged at level 30, in the same second as the level-40 msg-rate-floor line and
 * four minutes before the level-40 self-heal line — the root condition (grid presence UNKNOWN, the
 * telemetry-blind verdict) was the one line a level >= 40 scan could not find, against the rule the
 * poll loop states for itself (v1.3.1: a failure must surface in that scan). The latch setting goes to
 * the store's warn sink (setWarnLogger, wired by startPollLoop to its `warn`); the movement and
 * release lines stay INFO. Driven through a real SnapshotStore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SHADOW_WITNESS_PATH = join(mkdtempSync(join(tmpdir(), 'shadow-warn-')), 'shadow-witness.json');
const { SnapshotStore } = await import('../src/snapshot.js');

const PANEL = 'PANEXXX00XXX0001';
const item = { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 } as never;
const frozen = (): Record<string, unknown> => ({
  'loadInfo.hall1Watt': [0, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
  'wattInfo.gridWatt': 7618,
});
const moved = (k: number): Record<string, unknown> => ({
  'loadInfo.hall1Watt': [k, 134 + k, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
  'wattInfo.gridWatt': 7618 + k,
});

function drive(withWarn: boolean): { info: string[]; warn: string[]; latched: boolean; released: boolean } {
  const info: string[] = [];
  const warn: string[] = [];
  const s = new SnapshotStore();
  let t = 1_000_000;
  s.setClock(() => t);
  s.setLogger((m) => info.push(m));
  if (withWarn) s.setWarnLogger((m) => warn.push(m));
  s.setDeviceList([item]);
  for (let i = 0; i < 16; i++) { s.setDeviceQuota(PANEL, frozen()); t += 60_000; }
  const latched = s.get().devices[PANEL].contentStaleSinceMs != null;
  for (let k = 1; k <= 4; k++) { s.setDeviceQuota(PANEL, moved(k)); t += 60_000; }
  const released = s.get().devices[PANEL].contentStaleSinceMs == null;
  return { info, warn, latched, released };
}

test('★★★ the latch setting goes to the warn sink; the movement and release lines stay info', () => {
  const r = drive(true);
  assert.ok(r.latched, 'the frozen payload latched');
  assert.ok(r.released, 'the moving payload released it');
  const set = r.warn.filter((l) => l.includes('the cloud is serving a STALE SHADOW; grid readings are being treated as UNKNOWN'));
  assert.equal(set.length, 1, r.warn.join('\n'));
  assert.ok(!r.info.some((l) => l.includes('STALE SHADOW')), 'not at info');
  assert.ok(r.info.some((l) => l.includes('payload moved (1/')), 'movement: info');
  assert.ok(r.info.some((l) => l.includes('payload is moving again')), 'release: info');
  assert.ok(!r.warn.some((l) => l.includes('moving again') || l.includes('payload moved')), 'neither at warn');
});

test('★★ with no warn sink wired the latch setting still logs, at info (a store built without the poll loop)', () => {
  const r = drive(false);
  assert.ok(r.latched);
  assert.equal(r.info.filter((l) => l.includes('STALE SHADOW')).length, 1);
});

test('★ (labelled source pin, last resort: startPollLoop polls the cloud as soon as it starts) the poll loop wires its warn sink into the store', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/snapshot.ts'), 'utf8');
  assert.ok(src.includes('  store.setLogger(log);\n  store.setWarnLogger(warn); // v1.187.10 — the stale-shadow latch setting\n'));
});
