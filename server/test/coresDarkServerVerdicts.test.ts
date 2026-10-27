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
  SHP2_READBACK_STALE_MS, BACKUP_TIMER_DEADBAND_W, SLOT_UNMETERED_DRAW_W,
} from '../src/shp2Membership.js';
import { renderConsole } from '../src/telnet/plant/console.js';
import { plantFlow } from '../src/telnet/plant/types.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import { TuiSession } from '../src/telnet/session.js';
import { bridgeFleetFlow, sunUp } from '../src/energyBridge.js';
import { aggregateFleetFlow } from '../src/shp2Membership.js';
import { energyFlowModel } from '../../web/src/cards/energyFlowModel.js';

type Any = any; // fixtures carry only the fields the code reads

const NOW = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

/** A Core reporting on its own meter: content changed `changedAgoMs` ago; packNet > 0 = discharging.
 *  `liveNet`: the pack's stream figure (liveFlow), when it differs from the polled one. */
function core(sn: string, o: { packNet?: number; liveNet?: number; acOut?: number; changedAgoMs?: number | null; online?: boolean } = {}): Any {
  const net = o.packNet ?? 0;
  const live = o.liveNet == null ? {} : { liveFlow: { outputWatts: Math.max(0, o.liveNet), inputWatts: Math.max(0, -o.liveNet), atMs: NOW - 2_000 } };
  return {
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: o.online ?? true, lastUpdated: NOW,
    ...(o.changedAgoMs === null ? {} : { contentChangedAtMs: NOW - (o.changedAgoMs ?? 5_000) }),
    projection: {
      kind: 'dpu', soc: 60, pvTotalWatts: 0, acInWatts: 0, acOutWatts: o.acOut ?? 0,
      packs: [{ num: 1, outputWatts: Math.max(0, net), inputWatts: Math.max(0, -net), ...live }],
    },
  };
}

/** A cloud-offline Core as the snapshot carries it: listed, offline, no projection. */
const darkCore = (sn: string): Any => ({ sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: false, lastUpdated: NOW - 45 * 3600_000 });

/** The house panel: online, a quota `quotaAgoMs` ago, its slots' own meter (negative = delivering).
 *  `connected`: each slot's isConnected (default every slot); `sn`: a second panel's serial. */
function panel(sns: string[], sourceWatts: number[], o: { quotaAgoMs?: number; shadowed?: boolean; connected?: boolean[]; sn?: string } = {}): Any {
  return {
    sn: o.sn ?? 'PANEL-TEST-01', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW,
    lastQuotaAtMs: NOW - (o.quotaAgoMs ?? 30_000), contentStaleSinceMs: o.shadowed ? NOW - 60_000 : null,
    projection: {
      kind: 'shp2', area: 'Home', backupBatPercent: 86, backupFullCapWh: 92_160, backupRemainWh: 79_000,
      backupChargeTimeMin: 38, backupDischargeTimeMin: 1206, backupReserveSoc: 10, chargeWattPower: 7200, gridWatt: 0,
      circuits: Array.from({ length: 12 }, (_, i) => ({ ch: i + 1, name: `Circuit ${i + 1}`, watts: i < 3 ? 1130 : 0 })),
      pairedCircuits: [],
      sources: sns.map((sn, i) => ({ slot: i + 1, sn, isConnected: o.connected?.[i] ?? true, batteryPercentage: 86, isAcOpen: true, fullCap: 30720, ratePower: 7200, emsBatTemp: 29, hwConnect: true, errorCodeNum: 0 })),
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
    '? { ...panelForClient(shp2, s.devices, nowMs, verdicts), grid, off_grid }',
    'for (const p of secondaryShp2s(s.devices)) devices[p.sn] = panelForClient(p, s.devices, nowMs, verdicts);',
    // v1.188.1 (review) — the verdicts come from the computation the two power sensors publish.
    'const verdicts = slotVerdicts(recorder.bridgedFleetFlow({ fleetPv: agg.fleetPv, fleetBatteryNet: agg.fleetBatteryNetDisplay }, s.devices, nowMs));',
  ]) assert.ok(idx.includes(pin), `index.ts: missing ${pin}`);
});

/* ══ 2. the backup timers ═════════════════════════════════════════════════ */

test('★★★ 10-16 20:04: every Core offline, the panel fresh, slots delivering 3.56 kW — no charge timer', () => {
  const g = backupTimerGate(live2004(), NOW);
  assert.equal(g.charge, false, 'was "38 min" to full during the drain');
  assert.equal(g.discharge, true, 'the time-to-reserve stays published');
  assert.equal(g.basis, 'panel');
  const b = poolNetUpperBound(live2004(), NOW);
  assert.ok(Math.abs(b.watts - (3559.35 + 3 * SLOT_UNMETERED_DRAW_W)) < 0.01, `the slots' delivery plus each Core's own draw bounds the pool's net (got ${b.watts})`);
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
  assert.equal(poolNetUpperBound(charging, NOW).watts, -3500 + SLOT_UNMETERED_DRAW_W, 'a reporting Core’s slot is not read');
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
    'const timers = backupTimerGate(snap.devices, Date.now(), slotVerdicts(bridged));',
    'backup_charge_minutes: timers.charge ? (shp2?.projection.backupChargeTimeMin ?? null) : null,',
    'backup_discharge_minutes: timers.discharge ? (shp2?.projection.backupDischargeTimeMin ?? null) : null,',
  ]) assert.ok(idx.includes(pin), `index.ts: missing ${pin}`);
  assert.ok(!idx.includes('fleetBatteryNet > 50 ? null'), 'the Cores-only gate is gone from index.ts');
  const con = src('src/telnet/plant/console.ts');
  assert.ok(con.includes('const timers = backupTimerGate(data.snap.devices, Date.now(), data.flow?.verdicts);'), 'console.ts: the shared gate, on the bridge\u2019s verdicts');
  assert.ok(!con.includes('batNet > 50 ? null'), 'the Cores-only gate is gone from the console');
});

test('★★★ the console’s RUN line at 20:04: "▲ CHG —" beside the discharge time, not "▲ CHG 38m"', () => {
  const view: Any = { width: 100, height: 40, screen: 'console', genSel: 0, genPack: 0, almScroll: 0, connectedAt: NOW - 60_000 };
  const data: Any = { snap: { generatedAt: NOW, devices: live2004(), alerts: [] }, totals: null, forecast: null, degradation: { devices: [], fleetSummary: null }, serverStartedAt: NOW - 3_600_000 };
  data.flow = plantFlow(makeRecorderStub(), data.snap.devices, NOW);
  const plain = renderConsole(view, data).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const run = plain.find((l) => l.includes('RUN '));
  assert.ok(run, 'the RUN line renders');
  assert.ok(run!.includes('▲ CHG —'), `no charge timer during the drain: ${run}`);
  assert.ok(run!.includes('▼ DCH 20h 06m'), `the discharge time stays: ${run}`);
  // A force charge with the Cores dark: the charge timer, not the discharge one.
  data.snap.devices = devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [5300, 5300, 5300]));
  data.flow = plantFlow(makeRecorderStub(), data.snap.devices, NOW);
  const chg = renderConsole(view, data).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => l.includes('RUN '))!;
  assert.ok(chg.includes('▲ CHG 38m') && chg.includes('▼ DCH —'), chg);
});

/* ══ v1.188.1 review — poolNetUpperBound's per-slot guards ══════════════════ */

test('★★★ a bench spare in a DISCONNECTED slot, online and charging 4 kW from the wall, does not reverse the timers', () => {
  // Two home Cores dark, their slots delivering 1 kW each (a 2 kW drain); slot 3 is not connected.
  const ds = devs(darkCore('CORE-A'), darkCore('CORE-B'), core('SPARE-Z', { packNet: -4000 }),
    panel(['CORE-A', 'CORE-B', 'SPARE-Z'], [-1000, -1000, 0], { connected: [true, true, false] }));
  assert.equal(poolNetUpperBound(ds, NOW).watts, 2000 + 2 * SLOT_UNMETERED_DRAW_W, 'the spare is not in the pool');
  assert.deepEqual(backupTimerGate(ds, NOW), { charge: false, discharge: true, basis: 'panel' },
    'a time to full during the drain, and the time to reserve hidden, if the spare counted');
});

test('★★ a Core listed by two panels is counted once', () => {
  const ds = devs(darkCore('CORE-A'),
    panel(['CORE-A'], [500]), panel(['CORE-A'], [500], { sn: 'PANEL-TEST-02' }));
  assert.equal(poolNetUpperBound(ds, NOW).watts, -500 + SLOT_UNMETERED_DRAW_W, 'not −1000 W: one Core taking 500 W of AC');
});

test('★★★ an OFFLINE Core whose projection is still recent is not on its own meter: its slot is read', () => {
  // setDeviceList carries the projection and its content clock across an offline flip: the packs
  // still show the 3 kW charge they were in a minute ago, while the slots deliver 1 kW each.
  const ds = devs(
    core('CORE-A', { online: false, packNet: -3000, changedAgoMs: 60_000 }),
    core('CORE-B', { online: false, packNet: -3000, changedAgoMs: 60_000 }),
    core('CORE-C', { online: false, packNet: -3000, changedAgoMs: 60_000 }),
    panel(SNS, [-1000, -1000, -1000]),
  );
  assert.equal(poolNetUpperBound(ds, NOW).watts, 3000 + 3 * SLOT_UNMETERED_DRAW_W);
  assert.deepEqual(backupTimerGate(ds, NOW), { charge: false, discharge: true, basis: 'panel' },
    'its last 3 kW charge is not a reading');
});

test('★★ a reporting Core in a partial roster contributes its pack’s STREAM figure, not the poll’s replay', () => {
  // CORE-A reports: the poll replays a 3 kW charge, the stream says 2 kW out. CORE-B and CORE-C dark, slots idle.
  const ds = devs(core('CORE-A', { packNet: -3000, liveNet: 2000 }), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [-9999, 0, 0]));
  assert.equal(poolNetUpperBound(ds, NOW).watts, 2000 + 2 * SLOT_UNMETERED_DRAW_W);
  assert.deepEqual(backupTimerGate(ds, NOW), { charge: false, discharge: true, basis: 'panel' });
});

/* ══ v1.188.1 review — the timers' bound counts each dark Core's own draw ═══════════════ */

test('★★★ at the reserve hold the dark slots read ~0 W while the packs still supply the Cores\u2019 own draw: no time to full is published', () => {
  const at = (w: number) => backupTimerGate(devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [w, w, w])), NOW);
  assert.deepEqual(at(0), { charge: false, discharge: true, basis: 'panel' }, 'slots at 0 W: the packs still discharge into the Cores\u2019 standby');
  assert.deepEqual(at(30), { charge: false, discharge: true, basis: 'panel' }, '30 W of AC into each slot feeds standby: not a proven charge, the time to empty stays');
  assert.deepEqual(at(500), { charge: true, discharge: false, basis: 'panel' }, 'a real charge still proves itself');
  assert.equal(SLOT_UNMETERED_DRAW_W, 100);
});

/* ══ v1.188.1 review — the console's PV and battery figures are the published ones ══════ */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** One console frame through the production session (session.ts renderLines → plantFlow). */
function consoleFrame(devices: Any, recorder: Any): string[] {
  const writes: string[] = [];
  const snap = { generatedAt: NOW, devices, alerts: [] };
  const session = new TuiSession({
    write: (d) => writes.push(d),
    data: { store: { get: () => snap } as Any, recorder, totals: () => null, forecast: () => null, degradation: () => null, serverStartedAt: NOW - 3_600_000 },
    width: 120, height: 44, auth: null,
  });
  session.draw();
  return writes.join('').replace(ANSI, '').split('\r\n');
}
/** A site where the sun is down at `ms` (one of four equatorial points 90° apart always is). */
const nightSite = (ms: number) => [{ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, { lat: 0, lon: 180 }, { lat: 0, lon: -90 }].find((s) => !sunUp(ms, s))!;

test('★★★ the console\u2019s PV.ARRAY.P, BATT.P.NET and mimic are the HA sensors\u2019 figures: every Core dark, the pool delivering 3.56 kW through the panel — not "0 W IDLE"', () => {
  const ds = live2004();
  const site = nightSite(NOW);
  const recorder = makeRecorderStub({ bridgedFleetFlow: (o, d, n) => bridgeFleetFlow(o, d, n, () => false, site) });
  const { fleetPv, fleetBatteryNetDisplay } = aggregateFleetFlow(ds);
  const ha = bridgeFleetFlow({ fleetPv, fleetBatteryNet: fleetBatteryNetDisplay }, ds, NOW, () => false, site);
  assert.ok(Math.abs((ha.fleetBatteryNet as number) - 3559.35) < 0.01, 'precondition: the Battery Net sensor publishes the slots');
  const lines = consoleFrame(ds, recorder);
  const net = lines.find((l) => l.includes('BATT.P.NET'));
  assert.ok(net && /3\.56\s*kW/.test(net) && net.includes('DCH'), `BATT.P.NET: ${net}`);
  const pv = lines.find((l) => l.includes('PV.ARRAY.P'));
  assert.ok(pv && /\b0\s*W/.test(pv), `PV.ARRAY.P: night, a real 0 W: ${pv}`);
  const mimic = lines.find((l) => l.includes('BATT ') && l.includes('%') && !l.includes('BATT.'));
  assert.ok(mimic && mimic.includes('▼ DCH') && !mimic.includes('idle'), `the mimic draws the drain: ${mimic}`);
});

test('★★ while the sensors are unknown (a dark slot not bridgeable, a Core inside its dwell), the console shows "—", never a Cores-only sum', () => {
  const ds = live2004();
  const unknown = { fleetPv: null, fleetBatteryNet: null, bridgedSlots: 0, ownCores: 0, ownSns: [], ready: false, pending: [], slots: [], acIn: null, fleetIn: null, fleetOut: null };
  const lines = consoleFrame(ds, makeRecorderStub({ bridgedFleetFlow: () => unknown }));
  const net = lines.find((l) => l.includes('BATT.P.NET'));
  const pv = lines.find((l) => l.includes('PV.ARRAY.P'));
  assert.ok(net && net.includes('—') && !/\b0\s*W/.test(net) && !net.includes('IDLE'), `BATT.P.NET: ${net}`);
  assert.ok(pv && pv.includes('—') && !/\b0\s*W/.test(pv), `PV.ARRAY.P: ${pv}`);
  const mimic = lines.find((l) => l.includes('BATT ') && l.includes('%') && !l.includes('BATT.'));
  assert.ok(mimic && !mimic.includes('idle') && !mimic.includes('DCH'), `the mimic: ${mimic}`);
});

/* ══ v1.188.1 review round 2 — the timers, the card and the sensors take one verdict per Core ══ */

/** A site where the sun is up at `ms` (one of four equatorial points 90° apart always is). */
const daySite = (ms: number) => [{ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, { lat: 0, lon: 180 }, { lat: 0, lon: -90 }].find((s) => sunUp(ms, s))!;
/** The panel with each slot's PV field reading `pvW` (pvHighWatts: the MPPT field the bridge reads). */
function pvPanel(sourceWatts: number[], pvW: number): Any {
  const p = panel(SNS, sourceWatts);
  for (const s of p.projection.sources) Object.assign(s, { pvWatts: null, pvHighWatts: pvW, pvLowWatts: 0 });
  return p;
}
/** What both publishers and the console compute: the bridged flow over aggregateFleetFlow's sums. */
function bridged(ds: Any, trusted: boolean | 'below', site = daySite(NOW)) {
  const { fleetPv, fleetBatteryNetDisplay } = aggregateFleetFlow(ds);
  return bridgeFleetFlow({ fleetPv, fleetBatteryNet: fleetBatteryNetDisplay }, ds, NOW, () => trusted, site);
}

test('★★★ by day with every Core dark and the panel’s PV field trusted (the measured basis): the timers, the card and the console agree with Battery Net — a charge, not "▼ out" and a time to empty', async () => {
  // The review case: 2 kW of PV per Core, 500 W of it delivered to the panel, the packs charging 1.5 kW each.
  const { slotVerdicts } = await import('../src/energyBridge.js');
  const ds = devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), pvPanel([-500, -500, -500], 2000));
  const f = bridged(ds, true);
  assert.deepEqual([f.fleetPv, f.fleetBatteryNet], [6000, -4500], 'precondition: HA publishes 6 kW of PV and a 4.5 kW charge');
  const v = slotVerdicts(f);
  // The timers: the slot less the PV the bridge reads as measured, plus each Core's own draw.
  assert.deepEqual(backupTimerGate(ds, NOW, v), { charge: true, discharge: false, basis: 'panel' }, 'was time to empty during the charge');
  assert.equal(poolNetUpperBound(ds, NOW, v).watts, 3 * (500 - 2000 + SLOT_UNMETERED_DRAW_W));
  // With the field found short of the inferred bound today the slots cannot separate PV from the
  // packs: the documented bound stays. Unchecked (present, not yet checked) it is read as the
  // sensors read it (v1.190.1).
  assert.deepEqual(backupTimerGate(ds, NOW, slotVerdicts(bridged(ds, 'below'))), { charge: false, discharge: true, basis: 'panel' });
  assert.deepEqual(backupTimerGate(ds, NOW, slotVerdicts(bridged(ds, false))), { charge: true, discharge: false, basis: 'panel' });
  // The card on the server's output.
  const client = { ...ds, 'PANEL-TEST-01': panelForClient(ds['PANEL-TEST-01'], ds, NOW, v) };
  const grid: Any = { present: true, declared: true, importWatts: 0, homeGridWatts: 0, panelFresh: true };
  const m = energyFlowModel(client, grid);
  assert.equal(m.pv, 6000, 'Solar: the measured slot PV, not "—"');
  assert.equal(m.batNet, -4500, 'Batteries: the packs’ charge, not "1.50 kW out"');
  const { batteriesSubtitle, solarSubtitle } = await import('../../web/src/cards/energyFlowModel.js');
  assert.equal(batteriesSubtitle(m), '▲ 4.50 kW charging');
  assert.equal(solarSubtitle(m), '42 panels');
});

test('★★★ every Core listed OFFLINE whose MQTT data keeps arriving (its own reading): the card and the timers count each at its own meter, as the sensors do', async () => {
  const { slotVerdicts } = await import('../src/energyBridge.js');
  // Noon: 2 kW of PV per Core, the packs taking 1.5 kW (750 W each of two), 500 W to the panel each.
  const own = (sn: string): Any => ({
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: false, onlineChangedAtMs: NOW - 10 * 60_000, lastUpdated: NOW,
    lastTelemetryAtMs: NOW - 5_000, contentChangedAtMs: NOW - 5_000,
    projection: { kind: 'dpu', soc: 60, pvTotalWatts: 2000, acInWatts: 0, acOutWatts: 500, totalInWatts: 2000, totalOutWatts: 500,
      packs: [{ num: 1, outputWatts: 0, inputWatts: 750 }, { num: 2, outputWatts: 0, inputWatts: 750 }] },
  });
  const ds = devs(own('CORE-A'), own('CORE-B'), own('CORE-C'), panel(SNS, [-500, -500, -500]));
  const f = bridged(ds, false);
  assert.deepEqual([f.fleetPv, f.fleetBatteryNet, f.ownCores], [6000, -4500, 3], 'precondition: the sensors count each at its own reading');
  const v = slotVerdicts(f);
  // Before: the slot bound (+1.8 kW): time to full withheld and time to empty published beside a 4.5 kW charge.
  assert.deepEqual(backupTimerGate(ds, NOW, v), { charge: true, discharge: false, basis: 'panel' });
  assert.equal(poolNetUpperBound(ds, NOW, v).watts, -4500);
  const client = { ...ds, 'PANEL-TEST-01': panelForClient(ds['PANEL-TEST-01'], ds, NOW, v) };
  assert.deepEqual(client['PANEL-TEST-01'].projection.sources.map((s: Any) => s.ownReading), [true, true, true]);
  const grid: Any = { present: true, declared: true, importWatts: 0, homeGridWatts: 0, panelFresh: true };
  const m = energyFlowModel(client, grid);
  // Before: "Cores not reporting", "▼ 1.50 kW out", three via the panel.
  assert.deepEqual([m.dpuCount, m.viaPanelCount, m.pv, m.batNet], [3, 0, 6000, -4500]);
});

test('★★ a marked Core the bridge still meters at its slot is not on its own meter for the timers, whatever the store’s clocks say', () => {
  // CORE-A listed online with fresh content, but the bridge keeps it dark (not handed back yet).
  const ds = devs(core('CORE-A', { packNet: -3000 }), core('CORE-B'), core('CORE-C'), panel(SNS, [-1500, 0, 0]));
  const verdicts = { own: new Set(['CORE-B', 'CORE-C']), measuredPvW: new Map<string, number>() };
  assert.deepEqual(backupTimerGate(ds, NOW), { charge: true, discharge: false, basis: 'cores' }, 'precondition: on the clocks alone, its held 3 kW charge');
  assert.deepEqual(backupTimerGate(ds, NOW, verdicts), { charge: false, discharge: true, basis: 'panel' }, 'on the verdict, its slot delivering 1.5 kW');
});

test('★★★ the console’s RUN line on the bridge’s verdicts: with a trusted PV field by day, "▲ CHG" beside "BATT.P.NET … CHG", not "▼ DCH"', () => {
  const ds = devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), pvPanel([-500, -500, -500], 2000));
  const site = daySite(NOW);
  const recorder = makeRecorderStub({ bridgedFleetFlow: (o, d, n) => bridgeFleetFlow(o, d, n, () => true, site) });
  const lines = consoleFrame(ds, recorder);
  const net = lines.find((l) => l.includes('BATT.P.NET'));
  assert.ok(net && /4\.50\s*kW/.test(net) && net.includes('CHG'), `BATT.P.NET: ${net}`);
  const run = lines.find((l) => l.includes('RUN '));
  assert.ok(run && run.includes('▲ CHG 38m') && run.includes('▼ DCH —'), `RUN: ${run}`);
});
