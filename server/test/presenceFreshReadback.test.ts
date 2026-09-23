/**
 * v1.179.0 — a stale gridSta=1 ("Grid OK") must never assert grid presence.
 *
 * computeShp2GridConnected gated the panel's flag on `online` and the shadow latch only, with
 * no look at how old the reading was. Two paths let a stale "1" through, both in the
 * missed-alarm direction (present + gridStaBackstop true, the runway audible gated, SoC
 * crossings spoken as "drawing from grid power", off_grid OFF, shp2_grid_connected ON):
 *   1. an OFFLINE→ONLINE /status flip re-exposes the pre-offline sample before any quota
 *      lands (setDeviceOnline never touches the projection or lastQuotaAtMs);
 *   2. a quota fetch that keeps failing with the panel still listed online.
 * The presence term now needs a fresh readback (shp2ReadbackFresh). These drive the REAL
 * SnapshotStore and the REAL resolver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/snapshot.js';
import { resolveGridBackstop, computeShp2GridConnected } from '../src/gridState.js';
import { SHP2_READBACK_STALE_MS } from '../src/shp2Membership.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

type Any = any;
const MIN = 60_000;

const quota = (gridSta: number, k = 1, gridWatt = 0): Record<string, unknown> => ({
  'pd303_mc.masterIncreInfo.gridSta': gridSta,
  'wattInfo.gridWatt': gridWatt,
  'loadInfo.hall1Watt': [k, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
});

/** A real store with the panel listed online; `at` sets the store clock (quota times). */
function withStore(fn: (store: SnapshotStore, at: (ms: number) => void) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'presence-'));
  const prev = process.env.SHADOW_WITNESS_PATH;
  process.env.SHADOW_WITNESS_PATH = join(dir, 'shadow-witness.json');
  try {
    const store = new SnapshotStore();
    let t = Date.now();
    store.setClock(() => t);
    store.setDeviceList([{ sn: 'SHP2-1', deviceName: 'SHP2-1', productName: 'Smart Home Panel 2', online: 1 } as never]);
    fn(store, (ms) => { t = ms; });
  } finally {
    if (prev == null) delete process.env.SHADOW_WITNESS_PATH; else process.env.SHADOW_WITNESS_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** No declaration at all: presence can come only from import or the panel's own flag. */
const resolve = (devices: Any, extra: Partial<Parameters<typeof resolveGridBackstop>[0]> = {}) =>
  resolveGridBackstop({ devices, gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: false, atReserveFloor: false, ...extra });

test('★★★ path 1 — OFFLINE→ONLINE flip with no quota: the pre-offline "Grid OK" asserts nothing', () => {
  withStore((store, at) => {
    at(Date.now() - 12 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    assert.equal(resolve(store.get().devices, { nowMs: Date.now() - 12 * MIN + 1_000 }).present, true, '(fresh then: Grid OK)');
    store.setDeviceOnline('SHP2-1', false);
    // ...the utility fails while the panel is dark; /status reports ONLINE before any quota.
    store.setDeviceOnline('SHP2-1', true);
    const g = resolve(store.get().devices);
    assert.equal(g.shp2GridConnected, null, 'shp2_grid_connected publishes unknown, not ON');
    assert.equal(g.present, false, 'off_grid reads ON');
    assert.equal(g.backstopping, false, 'the runway audible is not gated');
    // The first quota after the flip decides.
    at(Date.now());
    store.setDeviceQuota('SHP2-1', quota(0, 2));
    assert.equal(resolve(store.get().devices).shp2GridConnected, false);
    store.setDeviceQuota('SHP2-1', quota(1, 3));
    assert.equal(resolve(store.get().devices).present, true, 'a fresh Grid OK asserts presence again');
  });
});

test('★★★ path 2 — the quota fetch keeps failing with the panel still online: the stale "1" lapses at the readback window', () => {
  withStore((store, at) => {
    at(Date.now() - 6 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    store.setDeviceError('SHP2-1', 'quota fetch failed');
    const d = store.get().devices['SHP2-1'];
    assert.equal(d.online, true, 'nothing marks the panel offline');
    const g = resolve(store.get().devices);
    assert.equal(g.shp2GridConnected, null);
    assert.equal(g.present, false);
    assert.equal(g.backstopping, false);
  });
});

test('★★ the burst-gap backstop is untouched inside the window: gridSta=1 a poll old, at the floor, pool idle → backstopping', () => {
  // v0.89.0 — gridSta stays 1 between the SHP2's 8 kW charge bursts while gridWatt reads 0.
  // Quotas arrive every ~60 s, far inside SHP2_READBACK_STALE_MS.
  withStore((store, at) => {
    at(Date.now() - 1 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.shp2GridConnected, true);
    assert.equal(g.backstopping, true, 'no false at-floor critical between bursts');
  });
});

test('the window boundary is the shared SHP2_READBACK_STALE_MS (5 min), not a private constant', () => {
  assert.equal(SHP2_READBACK_STALE_MS, 5 * MIN);
  withStore((store, at) => {
    const q = Date.now() - 10 * MIN;
    at(q);
    store.setDeviceQuota('SHP2-1', quota(1));
    const devs = store.get().devices;
    assert.equal(computeShp2GridConnected(devs, q + SHP2_READBACK_STALE_MS - 1_000), true, 'just inside');
    assert.equal(computeShp2GridConnected(devs, q + SHP2_READBACK_STALE_MS + 1_000), null, 'just outside');
  });
});

test('★ a 6 s /status blip does not drop a reading that is still fresh (dropping it would remove the burst-gap backstop at the floor)', () => {
  withStore((store, at) => {
    at(Date.now() - 20_000);
    store.setDeviceQuota('SHP2-1', quota(1));
    store.setDeviceOnline('SHP2-1', false);
    assert.equal(resolve(store.get().devices, { atReserveFloor: true }).shp2GridConnected, null, 'while offline: unknown (unchanged)');
    store.setDeviceOnline('SHP2-1', true);
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.shp2GridConnected, true);
    assert.equal(g.backstopping, true);
  });
});

test('★★ the v1.178.0 declared-grid veto is unchanged: it still reads the LAST reading, however stale', () => {
  withStore((store, at) => {
    at(Date.now() - 40 * MIN);
    store.setDeviceQuota('SHP2-1', quota(0));
    const g = resolveGridBackstop({
      devices: store.get().devices,
      gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
      gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
    });
    assert.equal(g.shp2GridConnected, null, 'presence: stale → unknown');
    assert.equal(g.declared, false, 'veto: the last reading still says no grid');
    assert.equal(g.backstopping, false);
  });
});

/* ── the flow terms: a frozen gridWatt / Core ac_in is the same stale reading ─────────────── */

test('★★★ path 1 with the panel carrying the home from grid: a frozen 7.8 kW gridWatt proves nothing either', () => {
  // gridWatt comes only from the REST quota, like gridSta, and it freezes with it. As importLive
  // it is exempt from BOTH floor guards, so the stale sample muted an at-floor outage outright.
  withStore((store, at) => {
    at(Date.now() - 12 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1, 1, 7800));
    store.setDeviceOnline('SHP2-1', false);
    store.setDeviceOnline('SHP2-1', true);
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.homeGridWatts, 0, 'no measured flow from a reading the panel has not refreshed');
    assert.equal(g.importLive, false);
    assert.equal(g.present, false);
    assert.equal(g.backstopping, false, 'the at-floor alarm is not muted');
  });
});

test('★★★ path 2 with a frozen 7.8 kW gridWatt: the failing quota lapses the flow term at the window too', () => {
  withStore((store, at) => {
    at(Date.now() - 6 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1, 1, 7800));
    store.setDeviceError('SHP2-1', 'quota fetch failed');
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.homeGridWatts, 0);
    assert.equal(g.backstopping, false);
  });
});

test('a fresh 7.8 kW gridWatt still proves the grid (unchanged)', () => {
  withStore((store, at) => {
    at(Date.now() - 1 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1, 1, 7800));
    const g = resolve(store.get().devices, { atReserveFloor: true });
    assert.equal(g.homeGridWatts, 7800);
    assert.equal(g.importLive, true);
  });
});

/** A Core wired to the panel (slot 1), its content clock `agoMs` old, drawing `acIn` W. */
function coreFleet(agoMs: number, acIn: number): Any {
  const now = Date.now();
  return {
    SHP2: {
      sn: 'SHP2', online: true, productName: 'Smart Home Panel 2', lastQuotaAtMs: now - 20_000,
      projection: { kind: 'shp2', gridWatt: 0, gridConnected: null, circuits: [], sources: [{ slot: 1, sn: 'C1', isConnected: true }] },
    },
    C1: {
      sn: 'C1', online: true, productName: 'Delta Pro Ultra', lastTelemetryAtMs: now - agoMs, contentChangedAtMs: now - agoMs,
      projection: { kind: 'dpu', acInWatts: acIn, packs: [{ inputWatts: 0, outputWatts: 0 }] },
    },
  };
}

test('★★ a Core left listed online with its telemetry stopped: its frozen ac_in proves nothing', () => {
  assert.equal(resolve(coreFleet(6 * MIN, 3000)).importWatts, 0, '6 min old');
  assert.equal(resolve(coreFleet(20_000, 3000)).importWatts, 3000, 'fresh: unchanged');
  const noClock = coreFleet(20_000, 3000);
  delete noClock.C1.contentChangedAtMs; // v1.181.0 — the gate's clock
  assert.equal(resolve(noClock).importWatts, 0, 'no content ever landed');
});

/* ── presenceUnknown: "nothing can be heard" is not "the grid is gone" ──────────────────── */

test('★★ presenceUnknown: true only when presence is false for lack of any evidence', () => {
  withStore((store, at) => {
    at(Date.now() - 12 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    const g = resolve(store.get().devices);
    assert.equal(g.present, false);
    assert.equal(g.presenceUnknown, true, 'a stale panel and no declaration: unknown, not absent');
  });
  withStore((store) => {
    store.setDeviceQuota('SHP2-1', quota(0));
    const g = resolve(store.get().devices);
    assert.equal(g.present, false);
    assert.equal(g.presenceUnknown, false, 'a fresh "grid not detected" is evidence of absence');
  });
  withStore((store, at) => {
    at(Date.now() - 40 * MIN);
    store.setDeviceQuota('SHP2-1', quota(0));
    const g = resolveGridBackstop({
      devices: store.get().devices,
      gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
      gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
    });
    assert.equal(g.presenceUnknown, false, "the veto's last reading is evidence, however stale");
  });
  withStore((store, at) => {
    at(Date.now() - 12 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    const g = resolveGridBackstop({
      devices: store.get().devices,
      gridEntity: { entity_id: 'input_boolean.grid_available', state: 'off', last_updated: new Date().toISOString() } as Any,
      gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
    });
    assert.equal(g.presenceUnknown, false, 'a usable grid entity reading off is evidence');
  });
  const present = resolve(coreFleet(20_000, 3000));
  assert.equal(present.present, true);
  assert.equal(present.presenceUnknown, false, 'present is never unknown');
});

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolvePath(here, '../src/', f), 'utf8');

test('★★ both night-charge deciders get a tri-state: null (never act) when presence is only unknown', () => {
  const idx = src('index.ts');
  const sites = idx.match(/gridPresent: [^\n]+,/g) ?? [];
  const wired = sites.filter((l) => !l.includes('gridPresent: null'));
  assert.equal(wired.length, 2, `decideActuation + decideForceCharge: ${JSON.stringify(sites)}`);
  for (const l of wired) assert.equal(l.trim(), 'gridPresent: gridNow.present ? true : gridNow.presenceUnknown ? null : false,');
});

test('the EcoFlow REST READS carry an explicit bound well inside the readback window; WRITES keep the default', () => {
  const rest = src('ecoflow/rest.ts');
  const ms = Number(/export const ECOFLOW_REST_TIMEOUT_MS = ([\d_]+);/.exec(rest)?.[1]?.replace(/_/g, ''));
  assert.ok(ms > 0 && ms * 4 <= SHP2_READBACK_STALE_MS, `${ms} ms`);
  // A write whose reply is merely slow may have landed: failing it re-sends it, and a reserve
  // revert re-sent three times escalates to a spoken "reserve stuck" CRITICAL.
  assert.match(rest, /\.\.\.\(method === 'PUT' \? \{\} : \{ headersTimeout: ECOFLOW_REST_TIMEOUT_MS, bodyTimeout: ECOFLOW_REST_TIMEOUT_MS \}\)/);
  assert.match(rest, /sendCommand[\s\S]{0,400}call<unknown>\('PUT'/, 'commands go out as PUT');
});

test('the resolver publishes the panel verdict the dashboard keys on (panelFresh)', () => {
  withStore((store, at) => {
    at(Date.now() - 6 * MIN);
    store.setDeviceQuota('SHP2-1', quota(1));
    assert.equal(resolve(store.get().devices).panelFresh, false);
    at(Date.now());
    store.setDeviceQuota('SHP2-1', quota(1, 2));
    assert.equal(resolve(store.get().devices).panelFresh, true);
  });
  assert.equal(resolve({}).panelFresh, null, 'no panel');
});
