/**
 * v1.185.0 — two smart panels, supported.
 *
 * The second SHP2 (the EV charger and the garage bank) used to be a FAIL-LOUD state: a
 * critical alert, every supervised write blocked, muting disarmed, and every number
 * describing ONE panel — picked by lowest serial, so a second panel with a lower serial would
 * have become the target of the SoC ladder, the HA backup sensors and the night-charge writes.
 *
 * Now: the house panel is PINNED (and persisted); night charge writes only to it; the grid
 * resolver reads every panel and fails loud; every other panel carries its own reserve, SoC and
 * runway alarms, named by panel. One panel stays byte-identical (the whole pre-existing suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveHousePanel, findShp2, secondaryShp2s, panelMeanSoc, housePoolFallbackSoc, homeFleetMeanSoc, aggregateFleetFlow,
} from '../src/shp2Membership.js';
import { resolveGridBackstop, computeShp2GridConnected, computeHomeGridWatts, computeGridImportWatts } from '../src/gridState.js';
import { SnapshotStore } from '../src/snapshot.js';
import { computeAlerts, resetOnScreenSocBandForTesting } from '../src/alerts.js';
import { resolveHandoffOwner, multiPanelRosterUnsound } from '../src/alertMonitor.js';
import { familyOf } from '../src/alertOutcomes.js';
import { panelPoolNetWatts, noteDrainSample, panelDrainRunway, PANEL_DRAIN_MIN_SPAN_MS } from '../src/panelRunway.js';
import { runwayAlarmMessage, runwayAlarmMessageEs, classifyRunway, belowReserveFloor } from '../src/runwayAlarm.js';
import { socAlarmMessage, socAlarmMessageEs } from '../src/batterySocAlarm.js';
import { publishReadiness } from '../src/publishReadiness.js';
import { findHousePanel, allPanels } from '../../web/src/shp2Membership.js';

type Any = any;
const NOW = Date.now();
const entity = (state: string): Any => ({ entity_id: 'input_boolean.grid_available', state, last_updated: new Date(NOW).toISOString() });

/** HOUSE panel (serial Z…) and GARAGE panel (serial A… — the LOWER serial, the old retarget hazard). */
function plant(o: {
  houseSta?: number | null; garageSta?: number | null;
  houseFresh?: boolean; garageFresh?: boolean;
  houseFlag?: boolean; garageProjected?: boolean;
  houseSoc?: number | null; garageSoc?: number | null;
  houseGridW?: number; garageGridW?: number;
  garageLastReading?: { connected: boolean; sta: number | null; atMs: number };
  garageSourcesConnected?: boolean;
} = {}): Any {
  const panel = (sn: string, name: string, sta: number | null, fresh: boolean, soc: number | null, gridW: number, core: string, reserve: number) => ({
    sn, deviceName: name, productName: 'Smart Home Panel 2',
    online: fresh, lastUpdated: NOW, lastQuotaAtMs: fresh ? NOW - 20_000 : NOW - 3_600_000, contentStaleSinceMs: null,
    projection: {
      kind: 'shp2', gridSta: sta, gridConnected: sta == null ? null : sta === 1, gridWatt: gridW,
      backupBatPercent: soc, backupReserveSoc: reserve, backupFullCapWh: 20_000, backupRemainWh: soc == null ? null : soc * 200,
      sources: [{ slot: 1, sn: core, isConnected: core === 'C2' ? o.garageSourcesConnected ?? true : true, hwConnect: true, errorCodeNum: 0 }],
      circuits: [{ ch: 1, watts: sn === 'ZHOUSE' ? 1000 : 3000 }], pairedCircuits: [],
    },
  });
  const core = (sn: string, soc: number, acIn: number, net: number) => ({
    sn, deviceName: sn, productName: 'Delta Pro Ultra', online: true, lastUpdated: NOW, contentChangedAtMs: NOW - 10_000,
    projection: { kind: 'dpu', soc, acInWatts: acIn, acOutWatts: 0, pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 0, packs: [{ num: 1, outputWatts: Math.max(0, net), inputWatts: Math.max(0, -net) }] },
  });
  const house = { ...panel('ZHOUSE', 'House Panel', o.houseSta === undefined ? 1 : o.houseSta, o.houseFresh ?? true, o.houseSoc === undefined ? 60 : o.houseSoc, o.houseGridW ?? 0, 'C1', 20), ...(o.houseFlag ?? true ? { housePanel: true } : {}) };
  const garage: Any = panel('AGARAGE', 'Garage Panel', o.garageSta === undefined ? 1 : o.garageSta, o.garageFresh ?? true, o.garageSoc === undefined ? 50 : o.garageSoc, o.garageGridW ?? 0, 'C2', 15);
  if (o.garageProjected === false) delete garage.projection;
  if (o.garageLastReading) garage.lastGridReading = o.garageLastReading;
  return { ZHOUSE: house, AGARAGE: garage, C1: core('C1', 70, 0, 800), C2: core('C2', 30, 0, 2000) };
}

// ── the pin ─────────────────────────────────────────────────────────────────

test('resolveHousePanel: one panel pins itself; a second one never takes the role', () => {
  assert.deepEqual(resolveHousePanel(['ZHOUSE'], null), { sn: 'ZHOUSE', pin: 'ZHOUSE', ambiguous: false });
  assert.deepEqual(resolveHousePanel(['AGARAGE', 'ZHOUSE'], 'ZHOUSE'), { sn: 'ZHOUSE', pin: 'ZHOUSE', ambiguous: false });
});

test('resolveHousePanel: a replaced panel (one on the account, pin gone) re-pins; two with no pin is AMBIGUOUS', () => {
  assert.deepEqual(resolveHousePanel(['NEWPANEL'], 'OLDPANEL'), { sn: 'NEWPANEL', pin: 'NEWPANEL', ambiguous: false });
  assert.deepEqual(resolveHousePanel(['AGARAGE', 'ZHOUSE'], null), { sn: null, pin: null, ambiguous: true });
  assert.deepEqual(resolveHousePanel(['AGARAGE', 'ZHOUSE'], 'GONE'), { sn: null, pin: 'GONE', ambiguous: true });
  assert.deepEqual(resolveHousePanel([], 'ZHOUSE'), { sn: null, pin: 'ZHOUSE', ambiguous: false }, 'no panel known: the pin is kept');
});

test('★★★ findShp2 returns the PINNED panel, not the lower serial — the night-charge target cannot move', () => {
  const d = plant();
  assert.equal(findShp2(d)?.sn, 'ZHOUSE');
  assert.deepEqual(secondaryShp2s(d).map((p) => p.sn), ['AGARAGE']);
  // web mirror agrees
  assert.equal(findHousePanel(d)?.sn, 'ZHOUSE');
  assert.deepEqual(allPanels(d).map((p) => p.sn), ['ZHOUSE', 'AGARAGE']);
});

test('★★ a pinned house panel with NO projection yet resolves to nothing — never to the other panel', () => {
  const d = plant();
  delete d.ZHOUSE.projection;
  assert.equal(findShp2(d), undefined);
  assert.equal(findHousePanel(d), undefined);
});

test('no panel flagged (ambiguous, or a pre-v1.185 caller): the lowest serial, as before', () => {
  const d = plant({ houseFlag: false });
  assert.equal(findShp2(d)?.sn, 'AGARAGE');
});

test('★★ the store pins the first panel it sees, persists it, and a lower-serial panel added later does not take over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'house-panel-'));
  const path = join(dir, 'house-panel.json');
  const prev = process.env.HOUSE_PANEL_PATH;
  process.env.HOUSE_PANEL_PATH = path;
  try {
    const s = new SnapshotStore();
    s.setLogger(() => {});
    s.setDeviceList([{ sn: 'ZHOUSE', deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: 1 } as Any]);
    assert.equal(s.get().devices.ZHOUSE.housePanel, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { sn: 'ZHOUSE' });
    s.setDeviceList([
      { sn: 'ZHOUSE', deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: 1 } as Any,
      { sn: 'AGARAGE', deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 } as Any,
    ]);
    assert.equal(s.get().devices.ZHOUSE.housePanel, true, 'the flag survives the literal rebuild');
    assert.equal(s.get().devices.AGARAGE.housePanel, undefined);
    assert.equal(s.housePanelState().ambiguous, false);
    // a restart with both panels on the account reads the pin back
    const s2 = new SnapshotStore();
    s2.setLogger(() => {});
    s2.setDeviceList([
      { sn: 'AGARAGE', deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 } as Any,
      { sn: 'ZHOUSE', deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: 1 } as Any,
    ]);
    assert.equal(s2.get().devices.ZHOUSE.housePanel, true);
    assert.equal(s2.housePanelState().sn, 'ZHOUSE');
  } finally {
    if (prev === undefined) delete process.env.HOUSE_PANEL_PATH; else process.env.HOUSE_PANEL_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ two panels at first sight with no pin: ambiguous, nothing flagged, until an operator pins one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'house-panel-'));
  const prev = process.env.HOUSE_PANEL_PATH;
  process.env.HOUSE_PANEL_PATH = join(dir, 'house-panel.json');
  try {
    const s = new SnapshotStore();
    s.setLogger(() => {});
    s.setDeviceList([
      { sn: 'AGARAGE', deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 } as Any,
      { sn: 'ZHOUSE', deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: 1 } as Any,
    ]);
    assert.equal(s.housePanelState().ambiguous, true);
    assert.ok(!Object.values(s.get().devices).some((d) => d.housePanel));
    assert.equal(s.pinHousePanel('NOT-A-PANEL'), false);
    assert.equal(s.pinHousePanel('ZHOUSE'), true);
    assert.equal(s.housePanelState().ambiguous, false);
    assert.equal(s.get().devices.ZHOUSE.housePanel, true);
  } finally {
    if (prev === undefined) delete process.env.HOUSE_PANEL_PATH; else process.env.HOUSE_PANEL_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a path or SUPERVISOR_TOKEN the pin is in memory only (no file written)', () => {
  const s = new SnapshotStore();
  s.setLogger(() => {});
  s.setDeviceList([{ sn: 'ZHOUSE', deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: 1 } as Any]);
  assert.equal(s.get().devices.ZHOUSE.housePanel, true);
  assert.equal(existsSync(join(process.cwd(), 'data', 'house-panel.json')), false);
});

// ── the grid, across every panel ────────────────────────────────────────────

test('★★★ the GARAGE panel freshly reporting no grid vetoes a declared grid, though the house panel says Grid OK', () => {
  const d = plant({ garageSta: 0 });
  assert.equal(computeShp2GridConnected(d, NOW), false);
  const g = resolveGridBackstop({ devices: d, gridEntity: entity('on'), gridEntityConfigured: true, gridAvailableFallback: false, nowMs: NOW });
  assert.equal(g.declared, false);
  assert.equal(g.backstopping, false);
  assert.match(g.reason, /Garage Panel: grid not detected/);
  assert.equal(g.vetoClearable, false, 'a fresh reading is the measurement, not stale');
});

test('★★ a DARK garage panel whose last reading was no grid still vetoes, and that stale veto is clearable', () => {
  const d = plant({ garageSta: null, garageFresh: false, garageLastReading: { connected: false, sta: 0, atMs: NOW - 3_600_000 } });
  const g = resolveGridBackstop({ devices: d, gridEntity: entity('on'), gridEntityConfigured: true, gridAvailableFallback: false, nowMs: NOW });
  assert.equal(g.declared, false);
  assert.equal(g.vetoClearable, true);
  assert.equal(computeShp2GridConnected(d, NOW), true, 'presence from the fresh house panel alone');
});

test('Grid OK needs every fresh panel to agree; nothing fresh is unknown', () => {
  assert.equal(computeShp2GridConnected(plant(), NOW), true);
  assert.equal(computeShp2GridConnected(plant({ houseFresh: false, garageFresh: false }), NOW), null);
});

test('grid power is SUMMED over fresh panels; a panel freshly saying no grid drops its Cores\' ac_in only', () => {
  assert.equal(computeHomeGridWatts(plant({ houseGridW: 1200, garageGridW: 800 }), NOW), 2000);
  assert.equal(computeHomeGridWatts(plant({ houseGridW: 1200, garageGridW: 800, garageFresh: false }), NOW), 1200);
  const d = plant({ garageSta: 0 });
  d.C1.projection.acInWatts = 500;
  d.C2.projection.acInWatts = 700;
  assert.equal(computeGridImportWatts(d, NOW), 500);
});

// ── per-panel alarms ────────────────────────────────────────────────────────

test('★★★ the garage pool at its floor raises ITS OWN critical, named, suffixed — the house pair is untouched', () => {
  resetOnScreenSocBandForTesting();
  const a = computeAlerts(plant({ garageSoc: 12 }), undefined, { present: false, backstopping: false });
  const g = a.find((x) => x.id === 'shp2-below-reserve-AGARAGE');
  assert.ok(g, 'garage below-reserve present');
  assert.equal(g!.severity, 'critical');
  assert.match(g!.title, /^Garage Panel: /);
  assert.equal(g!.sourceSn, 'AGARAGE');
  assert.equal(familyOf(g!.id), 'shp2-below-reserve', 'rolls up with the house family');
  assert.ok(!a.some((x) => x.id === 'shp2-below-reserve'), 'house pool at 60% raises nothing');
  assert.ok(!a.some((x) => x.id === 'shp2-multi-panel'), 'a pinned two-panel plant is SUPPORTED, not an alarm');
});

test('★★ the garage SoC band fires on its own ladder above its reserve window', () => {
  resetOnScreenSocBandForTesting();
  const a = computeAlerts(plant({ garageSoc: 29 }), undefined, { present: false, backstopping: false });
  const b = a.find((x) => x.id.startsWith('backup-soc-') && x.id.endsWith('-AGARAGE'));
  assert.ok(b);
  assert.equal(b!.id, 'backup-soc-30-AGARAGE');
  assert.equal(familyOf(b!.id), 'backup-soc');
});

test('two panels with NONE pinned: the ambiguity alert stands', () => {
  const a = computeAlerts(plant({ houseFlag: false }), undefined, { present: true, backstopping: true });
  const m = a.find((x) => x.id === 'shp2-multi-panel');
  assert.ok(m);
  assert.match(m!.title, /house panel not identified/);
});

test('★★ a secondary band hands off to ITS OWN reserve pair, never the house panel\'s', () => {
  const ids = new Set(['shp2-below-reserve', 'shp2-near-reserve-AGARAGE']);
  assert.equal(resolveHandoffOwner('backup-soc-20-AGARAGE', ids), 'shp2-near-reserve-AGARAGE');
  assert.equal(resolveHandoffOwner('backup-soc-20', ids), 'shp2-below-reserve');
  assert.equal(resolveHandoffOwner('backup-soc-20-AGARAGE', new Set(['shp2-below-reserve'])), null);
});

test('★★ the house pool\'s blind fallback averages ITS OWN Cores on a two-panel plant', () => {
  const d = plant();
  assert.equal(homeFleetMeanSoc(d), 50, 'the plant-wide mean mixes both pools');
  assert.equal(housePoolFallbackSoc(d), 70, 'the house pool is Core 1 alone');
  assert.equal(panelMeanSoc(d, d.AGARAGE), 30);
  const one: Any = { ZHOUSE: d.ZHOUSE, C1: d.C1 };
  assert.equal(housePoolFallbackSoc(one), homeFleetMeanSoc(one), 'one panel: unchanged');
});

test('muting is disarmed only while a panel\'s roster is unknown', () => {
  assert.equal(multiPanelRosterUnsound(plant()), false);
  assert.equal(multiPanelRosterUnsound(plant({ garageProjected: false })), true);
  assert.equal(multiPanelRosterUnsound(plant({ garageSourcesConnected: false })), true);
  const d = plant();
  assert.equal(multiPanelRosterUnsound({ ZHOUSE: d.ZHOUSE, C1: d.C1 }), false, 'one panel never disarms');
});

test('the plant load is every panel\'s circuits', () => {
  assert.equal(aggregateFleetFlow(plant()).panelLoad, 4000);
});

test('flow readiness waits for EVERY panel\'s projection (the union roster is incomplete until then)', () => {
  const r = (d: Any) => publishReadiness({ devices: d, alerts: [], speakerLastProbeAt: null, forecast: null, runway: null, degradation: null, carbon: null, tariff: null } as Any);
  assert.equal(r(plant()).flow, true);
  assert.equal(r(plant({ garageProjected: false })).flow, false);
});

// ── the secondary runway ────────────────────────────────────────────────────

test('★★ the garage runway: measured drain, hours to reserve and empty, and nothing until the window spans 10 min', () => {
  const d = plant({ garageSoc: 50 });
  const net = panelPoolNetWatts(d, d.AGARAGE);
  assert.deepEqual(net, { netW: 2000, reporting: 1, connected: 1 });
  let s = noteDrainSample([], net.netW, NOW - PANEL_DRAIN_MIN_SPAN_MS - 60_000);
  assert.equal(panelDrainRunway(d.AGARAGE, s, NOW - PANEL_DRAIN_MIN_SPAN_MS - 60_000).unavailable, 'measuring the drain');
  s = noteDrainSample(s, 2000, NOW);
  const r = panelDrainRunway(d.AGARAGE, s, NOW);
  assert.equal(r.unavailable, null);
  assert.equal(r.drainW, 2000);
  // 10 kWh remaining, 3 kWh reserve, 2 kW: 3.5 h to reserve, 5 h to empty → high
  assert.equal(r.hoursToReserve, 3.5);
  assert.equal(r.hoursToEmpty, 5);
  assert.equal(classifyRunway(r, { present: false, backstopping: false }), 'high');
  assert.equal(classifyRunway(r, { present: true, backstopping: true }), null, 'grid backstopping: silent');
});

test('fail-loud: a Core not reporting clears the window; a stale panel is unavailable; charging projects nothing', () => {
  const d = plant();
  d.C2.online = false;
  assert.equal(panelPoolNetWatts(d, d.AGARAGE).netW, null);
  assert.deepEqual(noteDrainSample([{ tMs: NOW - 60_000, netW: 500 }], null, NOW), []);
  const stale = plant({ garageFresh: false });
  assert.equal(panelDrainRunway(stale.AGARAGE, [{ tMs: NOW - 900_000, netW: 1 }, { tMs: NOW, netW: 1 }], NOW).unavailable, 'panel reading not fresh');
  const charging = panelDrainRunway(d.AGARAGE, [{ tMs: NOW - 900_000, netW: -800 }, { tMs: NOW, netW: -800 }], NOW);
  assert.equal(charging.hoursToEmpty, null);
  assert.equal(classifyRunway(charging, { present: false, backstopping: false }), null);
});

test('a pool already at its floor reads as at the floor (critical off-grid)', () => {
  const d = plant({ garageSoc: 10 });
  const r = panelDrainRunway(d.AGARAGE, [{ tMs: NOW - 900_000, netW: 1500 }, { tMs: NOW, netW: 1500 }], NOW);
  assert.equal(belowReserveFloor(r), true);
  assert.equal(classifyRunway(r, { present: false, backstopping: false }), 'critical');
});

// ── the words ───────────────────────────────────────────────────────────────

test('★ the house wording is unchanged; a secondary panel names its pool and its basis', () => {
  const p: Any = { hoursToEmpty: 5, hoursToReserve: 3.5, unavailable: null, backupRemainingKwh: 10, backupReserveKwh: 3 };
  assert.equal(runwayAlarmMessage(p, 'high'), 'High priority alarm. Backup pool projected to deplete in about 5 hours before solar recovers. Reduce load now.');
  assert.equal(runwayAlarmMessage(p, 'high', undefined, { poolName: 'Garage Panel', basis: 'drain' }),
    'High priority alarm. Garage Panel backup pool projected to deplete in about 5 hours at the current drain. Reduce load now.');
  assert.match(runwayAlarmMessageEs(p, 'high', undefined, { poolName: 'Garage Panel', basis: 'drain' }), /la reserva de respaldo de Garage Panel se agote .* al consumo actual/);
  assert.match(runwayAlarmMessageEs(p, 'high'), /Se proyecta que la reserva de respaldo se agote/);
  assert.equal(socAlarmMessage({ pct: 30, priority: 'medium' } as Any), socAlarmMessage({ pct: 30, priority: 'medium' } as Any, undefined));
  assert.match(socAlarmMessage({ pct: 30, priority: 'medium' } as Any, 'Garage Panel'), /Garage Panel backup pool at 30 percent\./);
  assert.match(socAlarmMessageEs({ pct: 30, priority: 'medium' } as Any, 'Garage Panel'), /Reserva de respaldo de Garage Panel al 30 por ciento/);
});

test('beyond the 24 h horizon the figure is dropped (no hourly "low" for a slow evening drain)', () => {
  const d = plant({ garageSoc: 90 }); // 18 kWh at 100 W: 180 h
  const r = panelDrainRunway(d.AGARAGE, [{ tMs: NOW - 900_000, netW: 100 }, { tMs: NOW, netW: 100 }], NOW);
  assert.equal(r.hoursToEmpty, null);
  assert.equal(r.hoursToReserve, null);
  assert.equal(classifyRunway(r, { present: false, backstopping: false }), null);
});

test('★★★ one of the panel\'s Cores not reporting: no drain at all, never the smaller sum', () => {
  const d = plant();
  d.AGARAGE.projection.sources.push({ slot: 2, sn: 'C3', isConnected: true, hwConnect: true, errorCodeNum: 0 });
  d.C3 = { ...d.C2, sn: 'C3', online: false };
  assert.deepEqual(panelPoolNetWatts(d, d.AGARAGE), { netW: null, reporting: 1, connected: 2 });
});

test('★★ a pool at its floor raises the at-floor alarm before any drain is measured', () => {
  const d = plant({ garageSoc: 10 });
  const r = panelDrainRunway(d.AGARAGE, [], NOW);
  assert.equal(r.unavailable, null);
  assert.equal(classifyRunway(r, { present: false, backstopping: false }), 'critical');
  assert.equal(panelDrainRunway(plant().AGARAGE, [], NOW).unavailable, 'measuring the drain', 'above the floor it waits');
});
