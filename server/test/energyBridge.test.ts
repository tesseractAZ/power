/**
 * v1.188.1 — the energy bridge's pure parts (energyBridge.ts).
 *
 * 2026-10-14 23:52 MST every home Core went cloud-offline while the Smart Home Panel 2 stayed
 * online. Battery in/out and solar read 0 in Home Assistant for two days and the Now view's Power
 * usage read 0 W, while the panel's three source slots metered ~3.4 kW out of the Cores. The
 * bridge meters a dark Core at its slot: battery = slot net AC − PV, PV from the panel's own field
 * (once seen working), 0 at night, or inferred from the slot's net output plus the stored-energy
 * change. Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  darkHomeSlots, darkCoreSns, sunUp, slotPvWatts, windowSplit, slotAcEnergy, valueAt, inferPvStep,
  bridgeFleetFlow, heldPackKeysOf, slotPowerBasis,
} from '../src/energyBridge.js';
import { aggregateFleetFlow } from '../src/shp2Membership.js';

type Any = any;

const PANEL = 'HD31XXX00XXX0001';
const C1 = 'Y711XXX00XXX0001';
const C2 = 'Y711XXX00XXX0002';
const C3 = 'Y711XXX00XXX0003';
/** 2026-10-15 01:00 MST (night) and 12:00 MST (noon), Phoenix. */
const NIGHT = Date.parse('2026-10-15T01:00:00-07:00');
const NOON = Date.parse('2026-10-15T12:00:00-07:00');

function panel(nowMs: number, sourceWatts: number[], over: Record<string, unknown> = {}, src: Array<Record<string, unknown>> = []): Any {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true,
    lastUpdated: nowMs, lastQuotaAtMs: nowMs - 30_000, contentStaleSinceMs: null,
    projection: {
      kind: 'shp2', circuits: [{ ch: 1, watts: 3400 }], pairedCircuits: [], gridWatt: 0, sourceWatts,
      sources: [C1, C2, C3].map((sn, i) => ({
        slot: i + 1, sn, isConnected: true, batteryPercentage: 80, fullCap: 30_720,
        pvWatts: 0, pvHighWatts: 0, pvLowWatts: 0, ...(src[i] ?? {}),
      })),
    },
    ...over,
  };
}
const core = (sn: string, online: boolean, projected = online): Any => ({
  sn, deviceName: sn, productName: 'DELTA Pro Ultra', online, lastUpdated: online ? NIGHT : 0,
  ...(projected ? { projection: { kind: 'dpu', soc: 80, pvTotalWatts: 1500, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0, packs: [{ outputWatts: 900, inputWatts: 0 }] } } : {}),
});

/* ── which slots are dark ─────────────────────────────────────────────── */

test('★★★ a dark slot is exactly the complement of the Cores aggregateFleetFlow sums', () => {
  const devices = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: core(C1, false, false), [C2]: core(C2, true), [C3]: core(C3, false, true) };
  const dark = darkHomeSlots(devices, NIGHT);
  assert.deepEqual(dark.map((d) => [d.slot, d.sn, d.chW]), [[1, C1, -1145], [3, C3, -1119]]);
  assert.deepEqual([...darkCoreSns(devices)].sort(), [C1, C3]);
  // The summed Core is not dark; aggregateFleetFlow sums exactly it.
  assert.equal(aggregateFleetFlow(devices).fleetPv, 1500);
});

test('★★ an online Core whose projection has not loaded (boot) is not dark; nor is an unlisted or unconnected one', () => {
  const p = panel(NIGHT, [-100, -100, -100]);
  p.projection.sources[2].isConnected = false;
  const devices = { [PANEL]: p, [C1]: core(C1, true, false) };
  assert.deepEqual(darkHomeSlots(devices, NIGHT), [], 'boot: online, no projection; C2 unlisted; C3 not connected');
});

test('★★ the panel reading must be fresh for a slot to be bridged', () => {
  const stale = { [PANEL]: panel(NIGHT, [-1000, 0, 0], { lastQuotaAtMs: NIGHT - 301_000 }), [C1]: core(C1, false) };
  assert.equal(darkHomeSlots(stale, NIGHT)[0].panelFresh, false);
  const shadow = { [PANEL]: panel(NIGHT, [-1000, 0, 0], { contentStaleSinceMs: NIGHT - 60_000 }), [C1]: core(C1, false) };
  assert.equal(darkHomeSlots(shadow, NIGHT)[0].panelFresh, false);
  assert.equal(darkHomeSlots({ [PANEL]: panel(NIGHT, [-1000, 0, 0]), [C1]: core(C1, false) }, NIGHT)[0].panelFresh, true);
});

/* ── the pieces ──────────────────────────────────────────────────────────── */

test('sun geometry: Phoenix at 01:00 MST is night, at noon it is day', () => {
  assert.equal(sunUp(NIGHT), false);
  assert.equal(sunUp(NOON), true);
  assert.equal(sunUp(Date.parse('2026-10-15T05:30:00-07:00')), false, 'before sunrise');
  assert.equal(sunUp(Date.parse('2026-10-15T18:45:00-07:00')), false, 'after sunset');
});

test('the panel PV figure: the two MPPT fields when either is reported, else pvChargeWatts, else unknown', () => {
  assert.equal(slotPvWatts({ pvWatts: 999, pvHighWatts: 1200, pvLowWatts: 300 }), 1500);
  assert.equal(slotPvWatts({ pvWatts: 999, pvHighWatts: 1200, pvLowWatts: null }), 1200);
  assert.equal(slotPvWatts({ pvWatts: 700, pvHighWatts: null, pvLowWatts: null }), 700);
  assert.equal(slotPvWatts({ pvWatts: null, pvHighWatts: null, pvLowWatts: null }), null);
  assert.equal(slotPvWatts({}), null);
});

test('★★★ the window split keeps grid + PV + out − in equal to the panel load (AC basis)', () => {
  // Night: the Core supplies 1145 W for an hour → all of it is battery out.
  assert.deepEqual(windowSplit(1145, 0, 0), { outWh: 1145, inWh: 0 });
  // Day: the Core supplies 300 W while PV makes 2300 W → 2000 Wh into the battery.
  assert.deepEqual(windowSplit(300, 0, 2300), { outWh: 0, inWh: 2000 });
  // Night grid charge: 2 kWh into the Core from the panel → battery in, no PV.
  assert.deepEqual(windowSplit(0, 2000, 0), { outWh: 0, inWh: 2000 });
  // Day: the Core supplies 1500 W, PV 1000 W → 500 out.
  assert.deepEqual(windowSplit(1500, 0, 1000), { outWh: 500, inWh: 0 });
});

test('the slot meter integrates each direction separately (negative = the Core supplies the panel)', () => {
  const t0 = NIGHT;
  const pts = [0, 1, 2, 3, 4, 5].map((m) => ({ ts: t0 + m * 60_000, value: m < 3 ? -1200 : 600 }));
  const r = slotAcEnergy(pts, t0, t0 + 5 * 60_000);
  // −1200 W for 2 min, a sign change over minute 2→3 (a trapezoid each way), +600 W for 2 min:
  // out = (1200 + 1200 + 600) W·min = 50 Wh, in = (300 + 600 + 600) W·min = 25 Wh.
  assert.ok(Math.abs(r.acOutWh - 50) < 1e-9, String(r.acOutWh));
  assert.ok(Math.abs(r.acInWh - 25) < 1e-9, String(r.acInWh));
  assert.equal(valueAt(pts, t0 + 150_000), -1200);
  assert.equal(valueAt(pts, t0 - 1), null);
});

test('★★★ inferred PV: slot output plus the stored-energy rise, a monotone envelope from the day\'s anchor', () => {
  const cap = 28_672;
  // First daylight window: anchor at 40 %, the Core supplied 25 Wh, SoC still 40 % → PV 25 Wh.
  let r = inferPvStep(undefined, { pctStart: 40, pctEnd: 40, acNetWh: 25, capWh: cap, covered: true });
  assert.equal(r.pvWh, 25);
  // SoC steps to 41 %: PV = 25 + 286.72 for this window.
  r = inferPvStep(r.state, { pctStart: 40, pctEnd: 41, acNetWh: 25, capWh: cap, covered: true });
  assert.ok(Math.abs((r.pvWh as number) - (25 + cap / 100)) < 1e-9, String(r.pvWh));
  // SoC falls back (quantisation): the envelope holds — no negative PV.
  r = inferPvStep(r.state, { pctStart: 41, pctEnd: 40, acNetWh: 25, capWh: cap, covered: true });
  assert.equal(r.pvWh, 0);
  // A grid charge in daylight: 2 kWh in at the slot, SoC +7 % (≈ 2 kWh): no PV booked.
  const g = inferPvStep({ anchorPct: 50, cumAcNetWh: 0, envWh: 0 }, { pctStart: 50, pctEnd: 57, acNetWh: -2010, capWh: cap, covered: true });
  assert.equal(g.pvWh, 0, 'grid charging is not solar');
});

test('★★ an uncovered window (restart, panel gap) is not inferred: it re-anchors instead of landing the SoC change', () => {
  const r = inferPvStep({ anchorPct: 40, cumAcNetWh: 0, envWh: 0 }, { pctStart: 40, pctEnd: 55, acNetWh: 0, capWh: 28_672, covered: false });
  assert.equal(r.pvWh, null);
  assert.deepEqual(r.state, { anchorPct: 55, cumAcNetWh: 0, envWh: 0 });
  assert.equal(inferPvStep(undefined, { pctStart: null, pctEnd: 55, acNetWh: 10, capWh: 1, covered: true }).pvWh, null, 'no anchor reading');
  assert.equal(inferPvStep(undefined, { pctStart: 50, pctEnd: null, acNetWh: 10, capWh: 1, covered: true }).pvWh, null, 'no SoC reading');
});

/* ── the two power sensors ───────────────────────────────────────────────── */

const ONLINE = { fleetPv: 0, fleetBatteryNet: 0 };

test('★★★ at night every dark slot is bridged: Battery Net = Σ −chW, Fleet PV = 0, ready', () => {
  const devices = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: core(C1, false), [C2]: core(C2, false), [C3]: core(C3, false) };
  const f = bridgeFleetFlow(ONLINE, devices, NIGHT, () => false);
  assert.equal(f.ready, true);
  assert.equal(f.bridgedSlots, 3);
  assert.equal(f.fleetBatteryNet, 3409);
  assert.equal(f.fleetPv, 0);
  assert.deepEqual(f.slots.map((s) => s.basis), ['night', 'night', 'night']);
});

test('★★★ in daylight a trusted PV field is the solar figure and battery = −chW − pv; an untrusted one is no figure at all', () => {
  const src = [{ pvHighWatts: 2000, pvLowWatts: 500 }, { pvHighWatts: 0, pvLowWatts: 0 }, { pvHighWatts: 1000, pvLowWatts: 0 }];
  const devices = { [PANEL]: panel(NOON, [-500, -800, 300], {}, src), [C1]: core(C1, false), [C2]: core(C2, false), [C3]: core(C3, false) };
  const trusted = bridgeFleetFlow({ fleetPv: 100, fleetBatteryNet: 50 }, devices, NOON, () => true);
  assert.equal(trusted.ready, true);
  assert.equal(trusted.fleetPv, 100 + 2500 + 0 + 1000);
  // battery: 50 + (500 − 2500) + (800 − 0) + (−300 − 1000) = −2450 (charging)
  assert.equal(trusted.fleetBatteryNet, 50 - 2000 + 800 - 1300);
  const untrusted = bridgeFleetFlow(ONLINE, devices, NOON, () => false);
  assert.equal(untrusted.ready, false, 'a 0 W reading from a field never seen working is not "no PV"');
  assert.equal(untrusted.fleetPv, null);
  assert.equal(untrusted.fleetBatteryNet, null);
  const oneTrusted = bridgeFleetFlow(ONLINE, devices, NOON, (_p, slot) => slot !== 2);
  assert.equal(oneTrusted.ready, false, 'one unbridgeable slot withholds both figures');
});

test('★★ a stale panel bridges nothing; an all-online fleet is unchanged by the bridge', () => {
  const stale = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119], { lastQuotaAtMs: NIGHT - 400_000 }), [C1]: core(C1, false), [C2]: core(C2, true), [C3]: core(C3, true) };
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 1800 }, stale, NIGHT, () => true);
  assert.equal(f.ready, false);
  assert.equal(f.fleetBatteryNet, null);
  assert.equal(slotPowerBasis(darkHomeSlots(stale, NIGHT)[0], NIGHT, true), 'unbridgeable');
  const online = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: core(C1, true), [C2]: core(C2, true), [C3]: core(C3, true) };
  const g = bridgeFleetFlow({ fleetPv: 4500, fleetBatteryNet: 2700 }, online, NIGHT, () => false);
  assert.deepEqual([g.fleetPv, g.fleetBatteryNet, g.bridgedSlots, g.ready], [4500, 2700, 0, true]);
});

test('held pack keys of a Core: both persisted shapes, and no other Core\'s rows', () => {
  const keys = [
    `pack_lastwhid_${C1}:${C1}-P1_chg`, `pack_lastwhid_${C1}:${C1}-P1_dsg`, `pack_lastwh_${C1}_3_chg`,
    `pack_lastwhid_${C2}:${C2}-P1_chg`, `pack_base_${C1}_3_chg`, 'fleet_pv_wh', `bridge_dark_${C1}:${C1}-P1`,
  ];
  assert.deepEqual(heldPackKeysOf(C1, keys), [`${C1}:${C1}-P1`, `${C1}|3`]);
});
