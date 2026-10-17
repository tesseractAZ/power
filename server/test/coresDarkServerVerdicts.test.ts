/**
 * v1.188.1 — the server's verdicts for Cores whose own meters are absent or frozen.
 *
 * 1. The card has no clock, so the server says which Cores and panels are not a live reading:
 *    shp2Membership.ts panelForClient puts `dpuFrozen` (a Core listed online on a frozen meter) on
 *    each source slot beside `dpuStale`, and `readbackFresh` (shp2ReadbackFresh) on each panel.
 * 2. The backup timers (/api/ha-state backup_charge_minutes / backup_discharge_minutes, the console's
 *    RUN line) were gated on the Cores' battery net, which is 0 W with every Core dark. Live
 *    2026-10-16 20:04 MST: every Core cloud-offline, the panel fresh, its slots delivering ~3.56 kW,
 *    the pool falling 92 → 86 %, and the gate published "38 min" to full. backupTimerGate bounds the
 *    pool's net through the panel instead.
 *
 * Fixtures carry fake serials and only the fields the code reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dpuContentFresh, isSourceDpuFrozen, panelForClient, poolNetUpperBound, backupTimerGate,
  SHP2_READBACK_STALE_MS, BACKUP_TIMER_DEADBAND_W,
} from '../src/shp2Membership.js';
import { renderConsole } from '../src/telnet/plant/console.js';
import { energyFlowModel } from '../../web/src/cards/energyFlowModel.js';

type Any = any; // fixtures carry only the fields the code reads

const NOW = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

/** A Core reporting on its own meter: content changed `changedAgoMs` ago; packNet > 0 = discharging. */
function core(sn: string, o: { packNet?: number; acOut?: number; changedAgoMs?: number | null; online?: boolean } = {}): Any {
  const net = o.packNet ?? 0;
  return {
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: o.online ?? true, lastUpdated: NOW,
    ...(o.changedAgoMs === null ? {} : { contentChangedAtMs: NOW - (o.changedAgoMs ?? 5_000) }),
    projection: {
      kind: 'dpu', soc: 60, pvTotalWatts: 0, acInWatts: 0, acOutWatts: o.acOut ?? 0,
      packs: [{ num: 1, outputWatts: Math.max(0, net), inputWatts: Math.max(0, -net) }],
    },
  };
}

/** A cloud-offline Core as the snapshot carries it: listed, offline, no projection. */
const darkCore = (sn: string): Any => ({ sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: false, lastUpdated: NOW - 45 * 3600_000 });

/** The house panel: online, a quota `quotaAgoMs` ago, its slots' own meter (negative = delivering). */
function panel(sns: string[], sourceWatts: number[], o: { quotaAgoMs?: number; shadowed?: boolean } = {}): Any {
  return {
    sn: 'PANEL-TEST-01', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW,
    lastQuotaAtMs: NOW - (o.quotaAgoMs ?? 30_000), contentStaleSinceMs: o.shadowed ? NOW - 60_000 : null,
    projection: {
      kind: 'shp2', area: 'Home', backupBatPercent: 86, backupFullCapWh: 92_160, backupRemainWh: 79_000,
      backupChargeTimeMin: 38, backupDischargeTimeMin: 1206, backupReserveSoc: 10, chargeWattPower: 7200, gridWatt: 0,
      circuits: Array.from({ length: 12 }, (_, i) => ({ ch: i + 1, name: `Circuit ${i + 1}`, watts: i < 3 ? 1130 : 0 })),
      pairedCircuits: [],
      sources: sns.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, batteryPercentage: 86, isAcOpen: true, fullCap: 30720, ratePower: 7200, emsBatTemp: 29, hwConnect: true, errorCodeNum: 0 })),
      sourceWatts,
    },
  };
}

const devs = (...ds: Any[]) => Object.fromEntries(ds.map((d) => [d.sn, d]));
const SNS = ['CORE-A', 'CORE-B', 'CORE-C'];
/** The live 20:04 slot figures (W, negative = delivering into the panel). */
const LIVE_W = [-1190.67, -1195.02, -1173.66];
const live2004 = () => devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), darkCore('CORE-D'), darkCore('CORE-E'), panel(SNS, LIVE_W));

/* ══ 1. a frozen Core, and a panel that is not fresh ══════════════════════ */

test('dpuContentFresh: the content-change clock within SHP2_READBACK_STALE_MS; unknown is not fresh', () => {
  assert.equal(dpuContentFresh({ contentChangedAtMs: NOW - SHP2_READBACK_STALE_MS }, NOW), true);
  assert.equal(dpuContentFresh({ contentChangedAtMs: NOW - SHP2_READBACK_STALE_MS - 1 }, NOW), false);
  assert.equal(dpuContentFresh({}, NOW), false, 'no change seen since a restart');
  assert.equal(dpuContentFresh({ contentChangedAtMs: 0 }, NOW), false);
  assert.equal(dpuContentFresh(undefined, NOW), false);
});

test('★★★ isSourceDpuFrozen: listed online with a projection, content unchanged for 5 min', () => {
  const slot = (sn: string | null, isConnected = true) => ({ sn, isConnected });
  const ds = devs(
    core('LIVE', { changedAgoMs: 4_000 }), core('FROZEN', { changedAgoMs: 6 * 60_000 }), core('NEVER', { changedAgoMs: null }),
    darkCore('OFF'), { sn: 'BARE', deviceName: 'BARE', productName: 'DELTA Pro Ultra', online: true, lastUpdated: NOW },
  );
  assert.equal(isSourceDpuFrozen(slot('FROZEN'), ds, NOW), true, 'a failing quota or a replayed body');
  assert.equal(isSourceDpuFrozen(slot('NEVER'), ds, NOW), true, 'no change seen yet: nothing vouches for it');
  assert.equal(isSourceDpuFrozen(slot('LIVE'), ds, NOW), false);
  assert.equal(isSourceDpuFrozen(slot('OFF'), ds, NOW), false, 'an offline Core is dpuStale, not frozen');
  assert.equal(isSourceDpuFrozen(slot('BARE'), ds, NOW), false, 'no projection: no figures to freeze');
  assert.equal(isSourceDpuFrozen(slot('MISSING'), ds, NOW), false);
  assert.equal(isSourceDpuFrozen(slot('FROZEN', false), ds, NOW), false, 'a disconnected slot is not a home source');
  assert.equal(isSourceDpuFrozen(slot(null), ds, NOW), false);
});

test('★★★ panelForClient: each slot carries dpuStale and dpuFrozen, the panel readbackFresh; the store is not mutated', () => {
  const ds = devs(core('CORE-A', { changedAgoMs: 6 * 60_000 }), core('CORE-B'), darkCore('CORE-C'), panel(SNS, LIVE_W));
  const p = ds['PANEL-TEST-01'];
  const out = panelForClient(p, ds, NOW);
  assert.deepEqual(out.projection.sources.map((s: Any) => [s.sn, s.dpuStale, s.dpuFrozen]), [
    ['CORE-A', false, true], ['CORE-B', false, false], ['CORE-C', true, false],
  ]);
  assert.equal(out.readbackFresh, true);
  assert.equal(p.readbackFresh, undefined, 'the store’s device is untouched');
  assert.equal(p.projection.sources[0].dpuFrozen, undefined);
  assert.deepEqual(out.projection.sourceWatts, LIVE_W);
  // A panel whose quota stopped refreshing, or that is replaying a shadow, is not fresh.
  assert.equal(panelForClient(panel(SNS, LIVE_W, { quotaAgoMs: SHP2_READBACK_STALE_MS + 1 }), ds, NOW).readbackFresh, false);
  assert.equal(panelForClient(panel(SNS, LIVE_W, { shadowed: true }), ds, NOW).readbackFresh, false);
});

test('★★★ the card on the server’s output: a Core listed online on a frozen meter is read from its slot', () => {
  // End to end: the store's devices → panelForClient (as snapshotForClient sends them) → the card.
  const ds = devs(core('CORE-A', { changedAgoMs: 6 * 60_000 }), core('CORE-B', { changedAgoMs: 6 * 60_000 }), core('CORE-C', { changedAgoMs: 6 * 60_000 }), panel(SNS, LIVE_W));
  const client = { ...ds, 'PANEL-TEST-01': panelForClient(ds['PANEL-TEST-01'], ds, NOW) };
  const grid: Any = { present: true, declared: true, importWatts: 0, homeGridWatts: 0, panelFresh: true };
  const m = energyFlowModel(client, grid);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0);
  assert.equal(m.viaPanelCount, 3);
  assert.equal(m.dpuCount, 0);
  // ...and the same Cores with live content are on their own meters.
  const fresh = devs(core('CORE-A'), core('CORE-B'), core('CORE-C'), panel(SNS, LIVE_W));
  const m2 = energyFlowModel({ ...fresh, 'PANEL-TEST-01': panelForClient(fresh['PANEL-TEST-01'], fresh, NOW) }, grid);
  assert.equal(m2.viaPanelCount, 0);
  assert.equal(m2.dpuCount, 3);
});

test('snapshotForClient sends every panel through panelForClient', () => {
  const idx = src('src/index.ts');
  for (const pin of [
    '? { ...panelForClient(shp2, s.devices, nowMs), grid, off_grid }',
    'for (const p of secondaryShp2s(s.devices)) devices[p.sn] = panelForClient(p, s.devices, nowMs);',
  ]) assert.ok(idx.includes(pin), `index.ts: missing ${pin}`);
});

/* ══ 2. the backup timers ═════════════════════════════════════════════════ */

test('★★★ 10-16 20:04: every Core offline, the panel fresh, slots delivering 3.56 kW — no charge timer', () => {
  const g = backupTimerGate(live2004(), NOW);
  assert.equal(g.charge, false, 'was "38 min" to full during the drain');
  assert.equal(g.discharge, true, 'the time-to-reserve stays published');
  assert.equal(g.basis, 'panel');
  const b = poolNetUpperBound(live2004(), NOW);
  assert.ok(Math.abs(b.watts - 3559.35) < 0.01, `the slots' delivery bounds the pool's net (got ${b.watts})`);
});

test('★★★ a force charge with every Core offline: the slots taking AC prove the charge', () => {
  const g = backupTimerGate(devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [5300, 5300, 5300])), NOW);
  assert.equal(g.charge, true);
  assert.equal(g.discharge, false);
  assert.equal(g.basis, 'panel');
});

test('★★ by day a dark Core delivering through its slot can be its PV passing through: no charge is proven, none is shown', () => {
  // Slot figures cannot separate PV from the packs, so delivery bounds the net from above only.
  const g = backupTimerGate(devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [-900, -900, -900])), NOW);
  assert.equal(g.charge, false);
  assert.equal(g.discharge, true);
});

test('★★★ nothing bounds the pool (panel stale, shadowed, or no slot figure): resolve toward discharging', () => {
  const dark = [darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C')];
  for (const [label, p] of [
    ['quota older than the readback window', panel(SNS, [5300, 5300, 5300], { quotaAgoMs: SHP2_READBACK_STALE_MS + 1 })],
    ['a cloud shadow', panel(SNS, [5300, 5300, 5300], { shadowed: true })],
    ['no slot figures', panel(SNS, [])],
  ] as Array<[string, Any]>) {
    const g = backupTimerGate(devs(...dark, p), NOW);
    assert.equal(g.basis, 'unmeasured', label);
    assert.equal(g.charge, false, `${label}: no charge timer`);
    assert.equal(g.discharge, true, `${label}: the discharge timer stays`);
  }
  // No panel projected: the roster is every non-spare Core, and an offline one has no slot to read.
  const noPanel = backupTimerGate(devs(core('CORE-A', { online: false, packNet: -3000 }), core('CORE-B')), NOW);
  assert.deepEqual(noPanel, { charge: false, discharge: true, basis: 'unmeasured' }, 'its last 3 kW charge is not a reading');
});

test('★★ every home Core reporting: the Cores’ exact net, the v0.15.12 ±50 W gate unchanged', () => {
  const at = (net: number) => backupTimerGate(devs(core('CORE-A', { packNet: net }), core('CORE-B'), core('CORE-C'), panel(SNS, [-3000, -3000, -3000])), NOW);
  assert.deepEqual(at(1000), { charge: false, discharge: true, basis: 'cores' }, 'discharging: the slots are not read');
  assert.deepEqual(at(-1000), { charge: true, discharge: false, basis: 'cores' });
  assert.deepEqual(at(0), { charge: true, discharge: true, basis: 'cores' });
  assert.deepEqual(at(BACKUP_TIMER_DEADBAND_W), { charge: true, discharge: true, basis: 'cores' }, '+50 W is inside the deadband');
  assert.deepEqual(at(-BACKUP_TIMER_DEADBAND_W), { charge: true, discharge: true, basis: 'cores' }, '−50 W is inside the deadband');
  assert.deepEqual(at(51), { charge: false, discharge: true, basis: 'cores' });
  assert.deepEqual(at(-51), { charge: true, discharge: false, basis: 'cores' });
});

test('★★ one Core dark: the reporting Cores’ net plus the dark slot’s bound', () => {
  // Two Cores charging 2 kW each on their own meters, the third offline delivering 500 W: at most −3.5 kW.
  const charging = devs(core('CORE-A', { packNet: -2000 }), core('CORE-B', { packNet: -2000 }), darkCore('CORE-C'), panel(SNS, [-9999, -9999, -500]));
  assert.equal(poolNetUpperBound(charging, NOW).watts, -3500, 'a reporting Core’s slot is not read');
  assert.deepEqual(backupTimerGate(charging, NOW), { charge: true, discharge: false, basis: 'panel' });
  // Two idle on their own meters, the third offline delivering 1.5 kW: a drain is not ruled out.
  const draining = devs(core('CORE-A'), core('CORE-B'), darkCore('CORE-C'), panel(SNS, [0, 0, -1500]));
  assert.deepEqual(backupTimerGate(draining, NOW), { charge: false, discharge: true, basis: 'panel' }, 'the Cores’ 0 W said "charge timer"');
});

test('★★★ a Core listed online on a FROZEN meter counts as dark: its frozen 0 W is not "not discharging"', () => {
  const ds = devs(core('CORE-A', { changedAgoMs: 6 * 60_000 }), core('CORE-B'), core('CORE-C'), panel(SNS, [0, 0, 0].map((w, i) => (i === 0 ? -1500 : w))));
  assert.deepEqual(backupTimerGate(ds, NOW), { charge: false, discharge: true, basis: 'panel' });
  // A Core whose content has not changed since a restart is not vouched for either.
  const boot = devs(core('CORE-A', { changedAgoMs: null }), core('CORE-B'), core('CORE-C'), panel(SNS, [-1500, 0, 0]));
  assert.equal(backupTimerGate(boot, NOW).charge, false);
});

test('★★★ /api/ha-state and the console both gate the timers on backupTimerGate', () => {
  const idx = src('src/index.ts');
  for (const pin of [
    'const timers = backupTimerGate(snap.devices, Date.now());',
    'backup_charge_minutes: timers.charge ? (shp2?.projection.backupChargeTimeMin ?? null) : null,',
    'backup_discharge_minutes: timers.discharge ? (shp2?.projection.backupDischargeTimeMin ?? null) : null,',
  ]) assert.ok(idx.includes(pin), `index.ts: missing ${pin}`);
  assert.ok(!idx.includes('fleetBatteryNet > 50 ? null'), 'the Cores-only gate is gone from index.ts');
  const con = src('src/telnet/plant/console.ts');
  assert.ok(con.includes('const timers = backupTimerGate(data.snap.devices, Date.now());'), 'console.ts: the shared gate');
  assert.ok(!con.includes('batNet > 50 ? null'), 'the Cores-only gate is gone from the console');
});

test('★★★ the console’s RUN line at 20:04: "▲ CHG —" beside the discharge time, not "▲ CHG 38m"', () => {
  const view: Any = { width: 100, height: 40, screen: 'console', genSel: 0, genPack: 0, almScroll: 0, connectedAt: NOW - 60_000 };
  const data: Any = { snap: { generatedAt: NOW, devices: live2004(), alerts: [] }, totals: null, forecast: null, degradation: { devices: [], fleetSummary: null }, serverStartedAt: NOW - 3_600_000 };
  const plain = renderConsole(view, data).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const run = plain.find((l) => l.includes('RUN '));
  assert.ok(run, 'the RUN line renders');
  assert.ok(run!.includes('▲ CHG —'), `no charge timer during the drain: ${run}`);
  assert.ok(run!.includes('▼ DCH 20h 06m'), `the discharge time stays: ${run}`);
  // A force charge with the Cores dark: the charge timer, not the discharge one.
  data.snap.devices = devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [5300, 5300, 5300]));
  const chg = renderConsole(view, data).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => l.includes('RUN '))!;
  assert.ok(chg.includes('▲ CHG 38m') && chg.includes('▼ DCH —'), chg);
});
