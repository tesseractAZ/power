/**
 * v1.180.0 — the panel's last NOT-OK grid reading survives a restart.
 *
 * The v1.178.0 declared-grid veto holds on the panel's last reading, but that reading lived in
 * memory only. An outage with `input_boolean.grid_available` ON, a panel gone cloud-dark (an
 * outage that also takes the ISP down) and an add-on restart left the veto with no input: on
 * first sight setDeviceList gives the panel no projection, and refreshAll fetches quota only for
 * devices listed online — "grid present" came back for as long as the panel stayed dark.
 *
 * These drive two REAL SnapshotStore instances (A, then B after a simulated restart) sharing a
 * GRID_READING_PATH, and the REAL resolver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/snapshot.js';
import { resolveGridBackstop } from '../src/gridState.js';

type Any = any;
const SN = 'SHP2-P';
const listed = (online: 0 | 1) => [{ sn: SN, deviceName: 'Panel', productName: 'Smart Home Panel 2', online } as never];
const quota = (gridSta: number, k = 1): Record<string, unknown> => ({
  'pd303_mc.masterIncreInfo.gridSta': gridSta, 'wattInfo.gridWatt': 0,
  'loadInfo.hall1Watt': [k, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
});
const toggleOn = (devices: Any) => resolveGridBackstop({
  devices,
  gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
  gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
});

/** Run with isolated GRID_READING_PATH / SHADOW_WITNESS_PATH; `file` is the grid-reading path. */
function withPaths(fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'grid-reading-'));
  const prev = { g: process.env.GRID_READING_PATH, s: process.env.SHADOW_WITNESS_PATH };
  process.env.GRID_READING_PATH = join(dir, 'grid-reading.json');
  process.env.SHADOW_WITNESS_PATH = join(dir, 'shadow-witness.json');
  try { fn(process.env.GRID_READING_PATH); } finally {
    if (prev.g == null) delete process.env.GRID_READING_PATH; else process.env.GRID_READING_PATH = prev.g;
    if (prev.s == null) delete process.env.SHADOW_WITNESS_PATH; else process.env.SHADOW_WITNESS_PATH = prev.s;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★★★ an outage survives a restart while the panel is dark: the persisted "no grid" still vetoes the toggle', () => {
  withPaths((file) => {
    const a = new SnapshotStore();
    a.setDeviceList(listed(1));
    a.setDeviceQuota(SN, quota(0));
    assert.equal(toggleOn(a.get().devices).backstopping, false, '(process A: the outage is announced)');
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[SN]?.connected, false, 'the reading was persisted');

    // Restart. The panel is cloud-dark: listed offline, so no quota is ever fetched.
    const b = new SnapshotStore();
    b.setDeviceList(listed(0));
    const dev = b.get().devices[SN];
    assert.equal(dev.projection, undefined, '(no projection: nothing else could restore the reading)');
    const g = toggleOn(b.get().devices);
    assert.equal(g.declared, false, 'the veto holds');
    assert.equal(g.present, false, 'off_grid reads ON');
    assert.equal(g.backstopping, false, 'the runway audible is not gated');
    assert.equal(g.presenceUnknown, false, 'the night-charge sees evidence of absence, not "unknown"');
    assert.match(g.reason, /gridSta=0\) \(last reading from before a restart; panel offline\)/);
  });
});

test('★★ the panel listed ONLINE after the restart but its quota failing: the persisted reading still vetoes', () => {
  withPaths(() => {
    const a = new SnapshotStore();
    a.setDeviceList(listed(1));
    a.setDeviceQuota(SN, quota(2));
    const b = new SnapshotStore();
    b.setDeviceList(listed(1));
    b.setDeviceError(SN, 'quota fetch failed');
    const g = toggleOn(b.get().devices);
    assert.equal(g.backstopping, false);
    assert.match(g.reason, /gridSta=2, islanded\) \(last reading from before a restart; nothing since\)/);
  });
});

test('★★★ a Grid OK reading deletes the persisted entry: after the grid returns, a restart does not resurrect "no grid"', () => {
  withPaths((file) => {
    const a = new SnapshotStore();
    a.setDeviceList(listed(1));
    a.setDeviceQuota(SN, quota(0));
    a.setDeviceQuota(SN, quota(1, 2));
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[SN], undefined, 'the entry is gone');
    const b = new SnapshotStore();
    b.setDeviceList(listed(0));
    const g = toggleOn(b.get().devices);
    assert.equal(g.declared, true, 'the declaration stands again: nothing says the grid is gone');
    assert.equal(g.shp2GridConnected, null, 'and nothing asserts it is there');
    assert.equal(b.get().devices[SN].lastGridReading, undefined);
  });
});

test('★★ a persisted Grid OK is never rehydrated and never asserts presence', () => {
  withPaths((file) => {
    writeFileSync(file, JSON.stringify({ [SN]: { connected: true, sta: 1, atMs: Date.now() } }));
    const b = new SnapshotStore();
    b.setDeviceList(listed(0));
    assert.equal(b.get().devices[SN].lastGridReading, undefined, 'a "1" is not rehydrated');
    const g = resolveGridBackstop({ devices: b.get().devices, gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: false });
    assert.equal(g.present, false);
    assert.equal(g.shp2GridConnected, null);
  });
});

test('a corrupt or absent file starts cold (the pre-v1.180 behaviour), without throwing', () => {
  withPaths((file) => {
    writeFileSync(file, '{not json');
    const b = new SnapshotStore();
    assert.doesNotThrow(() => b.setDeviceList(listed(0)));
    assert.equal(toggleOn(b.get().devices).declared, true);
  });
});

test('written only when the reading CHANGES, not on every 60 s poll', () => {
  withPaths((file) => {
    const a = new SnapshotStore();
    a.setDeviceList(listed(1));
    a.setDeviceQuota(SN, quota(0));
    rmSync(file);
    a.setDeviceQuota(SN, quota(0, 2)); // same reading, a new poll
    assert.equal(existsSync(file), false, 'an unchanged reading does not rewrite the file');
    a.setDeviceQuota(SN, quota(2, 3)); // 0 → 2: a change
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[SN]?.sta, 2);
  });
});

test('persistence is off by default outside the add-on (no SUPERVISOR_TOKEN, no GRID_READING_PATH)', () => {
  const prev = { g: process.env.GRID_READING_PATH, t: process.env.SUPERVISOR_TOKEN };
  delete process.env.GRID_READING_PATH;
  delete process.env.SUPERVISOR_TOKEN;
  try {
    const s = new SnapshotStore();
    s.setDeviceList(listed(1));
    assert.equal((s as Any).gridReadingPath, '', 'a shared default file would leak readings between test processes');
  } finally {
    if (prev.g != null) process.env.GRID_READING_PATH = prev.g;
    if (prev.t != null) process.env.SUPERVISOR_TOKEN = prev.t;
  }
});

test('★★★ a restart with the CLOUD unreachable (no /device/list ever succeeds): the persisted reading still vetoes', () => {
  // The outage also took the internet down: refreshAll throws at listDevices, setDeviceList never
  // runs, and the store has no devices at all. The reading must still reach the resolver.
  withPaths(() => {
    const a = new SnapshotStore();
    a.setDeviceList(listed(1));
    a.setDeviceQuota(SN, quota(0));
    const b = new SnapshotStore(); // restart; never listed
    assert.deepEqual(Object.keys(b.get().devices), []);
    const persisted = b.persistedGridAbsent();
    assert.equal(persisted?.sta, 0);
    const g = resolveGridBackstop({
      devices: b.get().devices, persistedGridAbsent: persisted,
      gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
      gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
    });
    assert.equal(g.declared, false);
    assert.equal(g.backstopping, false);
    assert.equal(g.presenceUnknown, false);
    assert.match(g.reason, /\(last reading from before a restart; the device list is unreachable\)/);
    // The first successful list hands over to the per-device reading (a panel removed from the
    // account cannot leave a veto behind).
    b.setDeviceList([]);
    assert.equal(b.persistedGridAbsent(), null);
  });
});

test('★★ the live wrapper carries the store\'s persisted reading (index.ts registers the source)', async () => {
  const { liveGridBackstop, setPersistedGridAbsentSource } = await import('../src/gridState.js');
  const prev = { fb: process.env.GRID_AVAILABLE, ent: process.env.GRID_PRESENCE_ENTITY };
  process.env.GRID_AVAILABLE = 'true';
  delete process.env.GRID_PRESENCE_ENTITY;
  try {
    setPersistedGridAbsentSource(() => ({ sta: 0, atMs: Date.now() - 3_600_000 }));
    assert.equal(liveGridBackstop({}).present, false, 'GRID_AVAILABLE=true is vetoed by the persisted reading');
    setPersistedGridAbsentSource(null);
    assert.equal(liveGridBackstop({}).present, true, '(without it the declaration stands)');
  } finally {
    setPersistedGridAbsentSource(null);
    if (prev.fb == null) delete process.env.GRID_AVAILABLE; else process.env.GRID_AVAILABLE = prev.fb;
    if (prev.ent != null) process.env.GRID_PRESENCE_ENTITY = prev.ent;
  }
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /setPersistedGridAbsentSource\(\(\) => store\.persistedGridAbsent\(\)\);/);
});

test('★★ PRODUCTION path: with SUPERVISOR_TOKEN set, the file lives next to the database', async () => {
  const { config } = await import('../src/config.js');
  const { resolve } = await import('node:path');
  const prev = { g: process.env.GRID_READING_PATH, t: process.env.SUPERVISOR_TOKEN };
  delete process.env.GRID_READING_PATH;
  process.env.SUPERVISOR_TOKEN = 'test-token-not-a-secret';
  try {
    const s = new SnapshotStore(); // reads only (the file is absent or unrelated); never writes here
    assert.equal((s as Any).gridReadingPath, resolve(process.cwd(), config.dbPath, '..', 'grid-reading.json'));
  } finally {
    if (prev.g != null) process.env.GRID_READING_PATH = prev.g;
    if (prev.t == null) delete process.env.SUPERVISOR_TOKEN; else process.env.SUPERVISOR_TOKEN = prev.t;
  }
});

test('a failed save is retried on the next panel reading, and the write is atomic (temp + rename)', () => {
  withPaths((file) => {
    const a = new SnapshotStore();
    a.setDeviceList(listed(1));
    (a as Any).gridReadingPath = join(file, 'no-such-dir', 'grid-reading.json'); // unwritable
    a.setDeviceQuota(SN, quota(0));
    assert.equal((a as Any).gridReadingDirty, true, 'the failure is remembered');
    (a as Any).gridReadingPath = file;
    a.setDeviceQuota(SN, quota(0, 2)); // unchanged reading, but dirty: retried
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[SN]?.connected, false);
    assert.equal((a as Any).gridReadingDirty, false);
    assert.equal(existsSync(`${file}.tmp`), false, 'no temp file left behind');
  });
});
