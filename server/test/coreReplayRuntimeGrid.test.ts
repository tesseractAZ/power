/**
 * v1.181.0 — two grid-path gaps left open by v1.178–v1.180.
 *
 * 1. A cloud REPLAYING a Core's cached REST body kept its pre-outage acIn counting as grid flow
 *    (importLive — exempt from both floor guards): the v1.179.0 freshness gate read the arrival
 *    clock, which a replayed 200 still bumps. The gate now reads a content-CHANGE clock, and a
 *    fresh panel reading of no grid zeroes Core import outright.
 * 2. The projected-runtime alert (`forecast-runtime-*`) decided its grid downgrade inside the
 *    analytics worker — whose HA state cache is never refreshed and which has no persisted-
 *    reading source — and cached the verdict for 10 min. The main thread now applies it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SnapshotStore, dpuContentWitness } from '../src/snapshot.js';
import { resolveGridBackstop } from '../src/gridState.js';
import { applyRuntimeGrid, RUNTIME_GRID_NOTE } from '../src/analytics.js';

type Any = any;
const MIN = 60_000;
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

/* ── 1. Core replay ───────────────────────────────────────────────────────────────────── */

test('★★ a Core REST body replayed identically does not move its content clock; a changed one does', () => {
  const s = new SnapshotStore();
  let t = 1_000_000;
  s.setClock(() => t);
  s.setDeviceList([{ sn: 'C1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: 1 } as never]);
  s.setDeviceQuota('C1', { 'hs_yj751_pd_appshow_addr.soc': 80 });
  assert.equal(s.get().devices.C1.contentChangedAtMs, undefined, 'first sight only seeds: after a restart it may itself be a replay');
  t += MIN;
  s.setDeviceQuota('C1', { 'hs_yj751_pd_appshow_addr.soc': 79 }); // real content
  const first = s.get().devices.C1.contentChangedAtMs;
  assert.equal(first, t, 'the first CHANGE starts the clock');
  t += 10 * MIN;
  s.setDeviceQuota('C1', { 'hs_yj751_pd_appshow_addr.soc': 79 }); // the same body, replayed
  assert.equal(s.get().devices.C1.lastTelemetryAtMs, t, '(the arrival clock moves)');
  assert.equal(s.get().devices.C1.contentChangedAtMs, first, 'the content clock does not');
  s.setDeviceList([{ sn: 'C1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: 1 } as never]);
  assert.equal(s.get().devices.C1.contentChangedAtMs, first, 'carried through the 60 s list rebuild');
  t += MIN;
  s.mergeDeviceQuota('C1', { 'hs_yj751_pd_appshow_addr.soc': 81 }); // a real MQTT delta
  assert.equal(s.get().devices.C1.contentChangedAtMs, s.get().devices.C1.lastTelemetryAtMs, 'real content moves it');
});

test('the witness is null for anything that is not a projected Core', () => {
  assert.equal(dpuContentWitness(undefined), null);
  assert.equal(dpuContentWitness({ kind: 'shp2' } as Any), null);
  assert.notEqual(dpuContentWitness({ kind: 'dpu', acInWatts: 1, packs: [] } as Any), null);
});

/** A fresh panel (gridSta as given) sourcing Core C1, whose content last changed `agoMs` ago. */
function fleet(gridSta: number | null, agoMs: number, acIn = 3000): Any {
  const now = Date.now();
  return {
    SHP2: {
      sn: 'SHP2', online: true, productName: 'Smart Home Panel 2', lastQuotaAtMs: now - 20_000,
      projection: { kind: 'shp2', gridWatt: 0, gridSta, gridConnected: gridSta == null ? null : gridSta === 1, circuits: [], sources: [{ slot: 1, sn: 'C1', isConnected: true }] },
    },
    C1: {
      sn: 'C1', online: true, productName: 'Delta Pro Ultra', lastTelemetryAtMs: now - 5_000, contentChangedAtMs: now - agoMs,
      projection: { kind: 'dpu', acInWatts: acIn, packs: [{ inputWatts: 0, outputWatts: 0 }] },
    },
  };
}
const toggleOn = (devices: Any, atReserveFloor = false) => resolveGridBackstop({
  devices,
  gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
  gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor,
});

test('★★★ a replayed Core (content unchanged 6 min, arrival fresh) proves no grid flow — the at-floor alarm is not muted', () => {
  const g = toggleOn(fleet(null, 6 * MIN), true);
  assert.equal(g.importWatts, 0);
  assert.equal(g.importLive, false);
  assert.equal(g.backstopping, false);
  assert.equal(toggleOn(fleet(null, 20_000), true).importLive, true, 'a Core whose content is moving still proves it');
});

test('★★★ a FRESH panel reading of no grid zeroes Core import: the Cores draw grid only through the panel', () => {
  for (const sta of [0, 2]) {
    const g = toggleOn(fleet(sta, 20_000)); // the Core's content is even moving
    assert.equal(g.importWatts, 0, `gridSta=${sta}`);
    assert.equal(g.importLive, false);
    assert.equal(g.backstopping, false, 'the replayed/stray Core cannot outvote the panel');
  }
  assert.equal(toggleOn(fleet(1, 20_000)).importWatts, 3000, 'Grid OK: unchanged');
  assert.equal(toggleOn(fleet(null, 20_000)).importWatts, 3000, 'no gridSta reported: unchanged');
});

/* ── 2. The runtime alert's grid rule, on the main thread ───────────────────────────────── */

const runtime = (severity: 'warning' | 'info'): Any => ({ id: 'forecast-runtime-P', severity, detail: 'Backup pool 40% draining.' });

test('★★ applyRuntimeGrid: while backstopping, a runtime warning is info and says why; nothing else changes', () => {
  const other: Any = { id: 'forecast-soc-dip-P', severity: 'warning', detail: 'x' };
  const input = [runtime('warning'), runtime('info'), other];
  const out = applyRuntimeGrid(input, true);
  assert.equal(out[0].severity, 'info');
  assert.ok(out[0].detail!.endsWith(RUNTIME_GRID_NOTE));
  assert.equal(out[1].severity, 'info');
  assert.ok(out[1].detail!.endsWith(RUNTIME_GRID_NOTE));
  assert.equal(out[2], other, 'non-runtime alerts untouched');
  assert.equal(input[0].severity, 'warning', "the worker's cached alert is never mutated");
  assert.equal(applyRuntimeGrid(input, false), input, 'islanded: as computed');
});

test('★★ wiring: the worker no longer resolves the grid; the alert monitor applies it with its live verdict', () => {
  assert.doesNotMatch(src('analytics.ts'), /liveGridBackstop/, 'the analytics worker cannot see the grid entity');
  assert.match(src('alertMonitor.ts'), /\.\.\.applyRuntimeGrid\(forecastAlerts, grid\.backstopping === true\),/);
});
