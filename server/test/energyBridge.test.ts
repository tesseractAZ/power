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
  darkHomeSlots, offlineHomeCores, ownEnergyUntil, sunUp, slotPvWatts, windowSplit, slotAcEnergy, valueAt, inferPvStep,
  bridgeFleetFlow, heldPackKeysOf, slotPowerBasis, pvFieldVerdict, bridgeSite, reportsSinceReturn, BRIDGE_DWELL_MS,
  BRIDGE_PV_EVIDENCE_STEPS,
} from '../src/energyBridge.js';
import { aggregateFleetFlow } from '../src/shp2Membership.js';
import { publishReadiness } from '../src/publishReadiness.js';
import { config } from '../src/config.js';

type Any = any;

const PANEL = 'HD31XXX00XXX0001';
const C1 = 'Y711XXX00XXX0001';
const C2 = 'Y711XXX00XXX0002';
const C3 = 'Y711XXX00XXX0003';
/** 2026-10-15 01:00 MST (night) and 12:00 MST (noon), Phoenix. */
const NIGHT = Date.parse('2026-10-15T01:00:00-07:00');
const NOON = Date.parse('2026-10-15T12:00:00-07:00');
/** The options' default site (FORECAST_LAT / FORECAST_LON). */
const PHX = { lat: 33.4484, lon: -112.074 };

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
  assert.deepEqual(dark.map((d) => [d.slot, d.sn, d.chW, d.darkSinceMs]), [[1, C1, -1145, null], [3, C3, -1119, null]]);
  assert.deepEqual([...offlineHomeCores(devices, NIGHT).keys()].sort(), [C1, C3]);
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

test('★★★ a Core is bridged only once it has been offline for the dwell; inside it, it is neither summed nor bridged', () => {
  const at = (ago: number): Any => ({ ...core(C1, false), onlineChangedAtMs: NIGHT - ago });
  const devs = (ago: number): Any => ({ [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: at(ago), [C2]: core(C2, true), [C3]: core(C3, true) });
  // A 6 s /status flip and the 2026-10-03 ~92 s /device/list blip are not outages.
  for (const ago of [6_000, 92_000, BRIDGE_DWELL_MS - 1]) {
    assert.deepEqual(darkHomeSlots(devs(ago), NIGHT), [], `offline ${ago} ms`);
    assert.deepEqual(offlineHomeCores(devs(ago), NIGHT).get(C1), { offlineSinceMs: NIGHT - ago, bridged: false });
  }
  const dark = darkHomeSlots(devs(BRIDGE_DWELL_MS), NIGHT);
  assert.deepEqual(dark.map((d) => [d.sn, d.darkSinceMs]), [[C1, NIGHT - BRIDGE_DWELL_MS]], 'from the instant it went offline');
  // A flip stamped in the future (clock skew) is read as now: inside the dwell.
  assert.deepEqual(offlineHomeCores(devs(-60_000), NIGHT).get(C1), { offlineSinceMs: NIGHT, bridged: false });
  // The power sensors inside the dwell: the Core is not a dark slot, so nothing is withheld for it.
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 1200 }, devs(30_000), NIGHT, () => false, PHX);
  assert.deepEqual([f.ready, f.bridgedSlots, f.fleetBatteryNet], [true, 0, 1200]);
});

test('★★★ how far a Core\'s own pv_total / ac_in count: a read cuts at the instant it went offline at once, a rollup only once it is bridged', () => {
  const inDwell = { offlineSinceMs: NIGHT - 60_000, bridged: false };
  const bridged = { offlineSinceMs: NIGHT - 600_000, bridged: true };
  const sinceBoot = { offlineSinceMs: null, bridged: true };
  assert.equal(ownEnergyUntil(undefined, 'read'), undefined, 'a Core that reports: no limit');
  assert.equal(ownEnergyUntil(undefined, 'rollup'), undefined);
  assert.equal(ownEnergyUntil(inDwell, 'read'), NIGHT - 60_000, 'a read never shows what the next rollup may not keep');
  assert.equal(ownEnergyUntil(inDwell, 'rollup'), undefined, 'a rollup inside the dwell still counts the Core itself');
  assert.equal(ownEnergyUntil(bridged, 'rollup'), NIGHT - 600_000, 'the bridge\'s window starts there');
  assert.equal(ownEnergyUntil(bridged, 'read'), NIGHT - 600_000);
  assert.equal(ownEnergyUntil(sinceBoot, 'read'), null, 'offline since before this process: not at all');
  assert.equal(ownEnergyUntil(sinceBoot, 'rollup'), null);
});

test('★★★ the panel PV field against the inferred lower bound: pending until the bound has risen enough, then at least the bound less one step', () => {
  const step = 286.72;
  const evidence = BRIDGE_PV_EVIDENCE_STEPS * step;
  assert.equal(pvFieldVerdict(5_000, evidence - 1, step), 'pending', 'one reading, or a little sun, proves nothing');
  assert.equal(pvFieldVerdict(evidence, evidence, step), 'consistent');
  assert.equal(pvFieldVerdict(evidence - step, evidence, step), 'consistent', 'the bound is good to one SoC step');
  assert.equal(pvFieldVerdict(evidence - step - 1, evidence, step), 'below');
  assert.equal(pvFieldVerdict(0, evidence, step), 'below', 'a field reading 0 under a rising charge');
  assert.equal(pvFieldVerdict(evidence / 2, evidence, step), 'below', 'half the solar (the battery-charging share alone)');
  assert.equal(pvFieldVerdict(3 * evidence, evidence, step), 'consistent', 'a field reading high is not caught (the bound is a lower one)');
  assert.equal(pvFieldVerdict(10, 10_000, 0), 'pending', 'no capacity: no verdict');
});

/* ── the pieces ──────────────────────────────────────────────────────────── */

test('sun geometry: Phoenix at 01:00 MST is night, at noon it is day', () => {
  assert.equal(sunUp(NIGHT, PHX), false);
  assert.equal(sunUp(NOON, PHX), true);
  assert.equal(sunUp(Date.parse('2026-10-15T05:30:00-07:00'), PHX), false, 'before sunrise');
  assert.equal(sunUp(Date.parse('2026-10-15T18:45:00-07:00'), PHX), false, 'after sunset');
});

const BERLIN = { lat: 52.52, lon: 13.405 };
const SYDNEY = { lat: -33.8688, lon: 151.2093 };

test('★★★ the sun test is judged at the given site, not Phoenix\'s clock', () => {
  const berlin10 = Date.parse('2026-10-15T10:00:00+02:00'); // 01:00 in Phoenix
  const berlin02 = Date.parse('2026-10-15T02:00:00+02:00'); // 17:00 in Phoenix (sun up there)
  const sydney13 = Date.parse('2026-10-15T13:00:00+11:00'); // 19:00 in Phoenix
  assert.equal(sunUp(berlin10, BERLIN), true, '10:00 in Berlin is daylight');
  assert.equal(sunUp(berlin02, BERLIN), false, '02:00 in Berlin is night');
  assert.equal(sunUp(sydney13, SYDNEY), true, '13:00 in Sydney is daylight');
  assert.equal(sunUp(berlin10, { lat: 33.4484, lon: -112.074 }), false, 'the same instant is night in Phoenix');
});

test('★★★ the bridge\'s site is the configured location (FORECAST_LAT / FORECAST_LON); Phoenix when it is not a coordinate', () => {
  assert.deepEqual(bridgeSite({ forecastLat: BERLIN.lat, forecastLon: BERLIN.lon }), BERLIN);
  assert.deepEqual(bridgeSite(config), { lat: config.forecastLat, lon: config.forecastLon }, 'the options\' value as configured');
  const devices = { [PANEL]: panel(NOON, [-1000, -1000, -1000]), [C1]: core(C1, false), [C2]: core(C2, false), [C3]: core(C3, false) };
  // 12:00 in Phoenix is 21:00 in Berlin: night at the site, so the power sensors read the slots.
  const f = bridgeFleetFlow(ONLINE, devices, NOON, () => false, BERLIN);
  assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet], [true, 0, 3000]);
  assert.deepEqual(f.slots.map((s) => s.basis), ['night', 'night', 'night']);
  assert.equal(bridgeFleetFlow(ONLINE, devices, NOON, () => false, PHX).ready, false, 'noon in Phoenix: no trusted field, no figure');
  for (const [lat, lon] of [[Number.NaN, 13.4], [52.5, Number.NaN], [91, 0], [0, 181]]) {
    assert.deepEqual(bridgeSite({ forecastLat: lat, forecastLon: lon }), PHX, `${lat},${lon}`);
  }
});

test('★★★ a Core has reported since its return only when its content changed at or after its online flip (or at all, online since first sight)', () => {
  const t = NIGHT;
  assert.equal(reportsSinceReturn({ online: true, onlineChangedAtMs: t, contentChangedAtMs: t + 1 }), true, 'fresh data after the flip');
  assert.equal(reportsSinceReturn({ online: true, onlineChangedAtMs: t, contentChangedAtMs: t }), true, 'data landing with the flip');
  assert.equal(reportsSinceReturn({ online: true, onlineChangedAtMs: t, contentChangedAtMs: t - 1 }), false, 'MQTT data from before the flip; a frozen projection');
  assert.equal(reportsSinceReturn({ online: true, onlineChangedAtMs: t }), false, 'no content change seen');
  assert.equal(reportsSinceReturn({ online: false, onlineChangedAtMs: t, contentChangedAtMs: t + 1 }), false, 'listed offline: MQTT data while dark');
  assert.equal(reportsSinceReturn({ online: true, contentChangedAtMs: t }), true, 'online since first sight, its content changed since');
  assert.equal(reportsSinceReturn({ online: true }), false, 'after a restart the first body only seeds the witness: it may be a replay');
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
  const f = bridgeFleetFlow(ONLINE, devices, NIGHT, () => false, PHX);
  assert.equal(f.ready, true);
  assert.equal(f.bridgedSlots, 3);
  assert.equal(f.fleetBatteryNet, 3409);
  assert.equal(f.fleetPv, 0);
  assert.deepEqual(f.slots.map((s) => s.basis), ['night', 'night', 'night']);
});

test('★★★ in daylight a trusted PV field is the solar figure and battery = −chW − pv; an untrusted one is no figure at all', () => {
  const src = [{ pvHighWatts: 2000, pvLowWatts: 500 }, { pvHighWatts: 0, pvLowWatts: 0 }, { pvHighWatts: 1000, pvLowWatts: 0 }];
  const devices = { [PANEL]: panel(NOON, [-500, -800, 300], {}, src), [C1]: core(C1, false), [C2]: core(C2, false), [C3]: core(C3, false) };
  const trusted = bridgeFleetFlow({ fleetPv: 100, fleetBatteryNet: 50 }, devices, NOON, () => true, PHX);
  assert.equal(trusted.ready, true);
  assert.equal(trusted.fleetPv, 100 + 2500 + 0 + 1000);
  // battery: 50 + (500 − 2500) + (800 − 0) + (−300 − 1000) = −2450 (charging)
  assert.equal(trusted.fleetBatteryNet, 50 - 2000 + 800 - 1300);
  const untrusted = bridgeFleetFlow(ONLINE, devices, NOON, () => false, PHX);
  assert.equal(untrusted.ready, false, 'a 0 W reading from a field never seen working is not "no PV"');
  assert.equal(untrusted.fleetPv, null);
  assert.equal(untrusted.fleetBatteryNet, null);
  const oneTrusted = bridgeFleetFlow(ONLINE, devices, NOON, (_p, slot) => slot !== 2, PHX);
  assert.equal(oneTrusted.ready, false, 'one unbridgeable slot withholds both figures');
});

test('★★★ two panels: a second panel that drops off the cloud with its Core leaves that slot out; the house figures still publish', () => {
  const GARAGE = 'HD31XXX00XXX0002';
  const CG = 'Y711XXX00XXX0009';
  const garage: Any = {
    ...panel(NOON, [-300]), sn: GARAGE, online: false, lastQuotaAtMs: NIGHT - 60 * 60_000,
  };
  garage.projection = { ...garage.projection, sources: [{ slot: 1, sn: CG, isConnected: true, batteryPercentage: 50, fullCap: 30_720, pvWatts: null, pvHighWatts: null, pvLowWatts: null }] };
  const house = panel(NOON, [-500, -500, 0]);
  house.projection.sources = house.projection.sources.slice(0, 2);
  const devices: Any = {
    [PANEL]: house, [GARAGE]: garage,
    [C1]: { ...core(C1, true), lastQuotaAtMs: NOON },
    [C2]: { ...core(C2, true), lastQuotaAtMs: NOON },
    [CG]: { ...core(CG, false, true), onlineChangedAtMs: NIGHT - 60 * 60_000 },
  };
  devices[C1].projection = { ...devices[C1].projection, pvTotalWatts: 2000 };
  devices[C2].projection = { ...devices[C2].projection, pvTotalWatts: 1500 };
  const agg = aggregateFleetFlow(devices);
  assert.equal(agg.fleetPv, 3500, 'the two house Cores');
  for (const at of [NOON, NIGHT]) {
    const f = bridgeFleetFlow({ fleetPv: agg.fleetPv, fleetBatteryNet: agg.fleetBatteryNetDisplay }, devices, at, () => true, PHX);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet, f.bridgedSlots], [true, 3500, agg.fleetBatteryNetDisplay, 0], new Date(at).toISOString());
    assert.deepEqual(f.slots.map((s) => [s.panelSn, s.sn, s.basis, s.leftOut]), [[GARAGE, CG, 'unbridgeable', true]]);
    const r = publishReadiness({ devices, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
      curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: at, flowBridge: f } as Any);
    assert.equal(r.flowBridged, true, 'Fleet PV and Battery Net publish the house Cores');
  }
  // A single panel that is itself cloud-offline with every Core dark: nothing is summed, both withheld (as before the bridge).
  const alone: Any = { [GARAGE]: garage, [CG]: devices[CG] };
  const g = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, alone, NIGHT, () => true, PHX);
  assert.deepEqual([g.ready, g.bridgedSlots], [true, 0]);
  const r = publishReadiness({ devices: alone, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
    curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: NIGHT, flowBridge: g } as Any);
  assert.equal(r.flowBridged, false);
});

test('★★ a stale panel bridges nothing; an all-online fleet is unchanged by the bridge', () => {
  const stale = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119], { lastQuotaAtMs: NIGHT - 400_000 }), [C1]: core(C1, false), [C2]: core(C2, true), [C3]: core(C3, true) };
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 1800 }, stale, NIGHT, () => true, PHX);
  assert.equal(f.ready, false);
  assert.equal(f.fleetBatteryNet, null);
  assert.equal(slotPowerBasis(darkHomeSlots(stale, NIGHT)[0], NIGHT, true, PHX), 'unbridgeable');
  const online = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: core(C1, true), [C2]: core(C2, true), [C3]: core(C3, true) };
  const g = bridgeFleetFlow({ fleetPv: 4500, fleetBatteryNet: 2700 }, online, NIGHT, () => false, PHX);
  assert.deepEqual([g.fleetPv, g.fleetBatteryNet, g.bridgedSlots, g.ready], [4500, 2700, 0, true]);
});

test('held pack keys of a Core: both persisted shapes, and no other Core\'s rows', () => {
  const keys = [
    `pack_lastwhid_${C1}:${C1}-P1_chg`, `pack_lastwhid_${C1}:${C1}-P1_dsg`, `pack_lastwh_${C1}_3_chg`,
    `pack_lastwhid_${C2}:${C2}-P1_chg`, `pack_base_${C1}_3_chg`, 'fleet_pv_wh', `bridge_dark_${C1}:${C1}-P1`,
  ];
  assert.deepEqual(heldPackKeysOf(C1, keys), [`${C1}:${C1}-P1`, `${C1}|3`]);
});
