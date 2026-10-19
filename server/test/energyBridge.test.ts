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
  BRIDGE_PV_EVIDENCE_STEPS, createEnergyBridge, bridgeOfflineKey, slotVerdicts, projectionPacksComplete,
  pvFieldTolerance, pvVerdictHolds, BRIDGE_PV_TOLERANCE_STEPS, BRIDGE_PV_TOLERANCE_FRACTION, BRIDGE_PV_VERDICT_HOLD_MS, BRIDGE_PV_GENUINE_WH,
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
/** A Core listed online that REPORTS at `at`: its content landed and changed then (the store's
 *  lastTelemetryAtMs / contentChangedAtMs). Without them, an online Core's projection is not a
 *  reading of its own (a restart's first body, a frozen meter). */
const live = (sn: string, at: number): Any => ({ ...core(sn, true), lastTelemetryAtMs: at, contentChangedAtMs: at });

/* ── which slots are dark ─────────────────────────────────────────────── */

test('★★★ a dark slot is exactly the complement of the Cores aggregateFleetFlow sums', () => {
  const devices = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: core(C1, false, false), [C2]: live(C2, NIGHT), [C3]: core(C3, false, true) };
  const dark = darkHomeSlots(devices, NIGHT);
  assert.deepEqual(dark.map((d) => [d.slot, d.sn, d.chW, d.darkSinceMs]), [[1, C1, -1145, null], [3, C3, -1119, null]]);
  assert.deepEqual([...offlineHomeCores(devices, NIGHT).keys()].sort(), [C1, C3]);
  // The summed Core is not dark; aggregateFleetFlow sums exactly it.
  assert.equal(aggregateFleetFlow(devices).fleetPv, 1500);
});

test('★★★ an online Core whose projection has not loaded (boot, or an online flip before its first quota) is not a reading: inside the dwell it withholds both power figures; an unlisted or unconnected one is not counted', () => {
  const p = panel(NIGHT, [-100, -100, -100]);
  p.projection.sources[2].isConnected = false;
  const devices = { [PANEL]: p, [C1]: core(C1, true, false) };
  assert.deepEqual(darkHomeSlots(devices, NIGHT), [], 'boot: online, no projection, no instant known — not bridged; C2 unlisted; C3 not connected');
  assert.deepEqual(offlineHomeCores(devices, NIGHT).get(C1), { offlineSinceMs: null, bridged: false });
  assert.deepEqual([...offlineHomeCores(devices, NIGHT).keys()], [C1], 'C2 (unlisted) and C3 (not connected) are not part of the fleet');
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devices, NIGHT, () => false, PHX);
  assert.deepEqual([f.ready, f.fleetBatteryNet, f.pending, f.ownCores], [false, null, [C1], 0], 'unknown, never a partial sum');
  // Its first sight starts the dwell (the bridge records it): bridged once it has passed.
  const seen = (sn: string): number | null => (sn === C1 ? NIGHT - BRIDGE_DWELL_MS : null);
  assert.deepEqual(darkHomeSlots(devices, NIGHT, seen).map((d) => [d.sn, d.darkSinceMs, d.listedOnline]), [[C1, NIGHT - BRIDGE_DWELL_MS, true]]);
  // A first body that only seeded the witness (no content change seen yet) is the same.
  const seeded = { [PANEL]: p, [C1]: { ...core(C1, true), lastTelemetryAtMs: NIGHT } };
  assert.deepEqual(offlineHomeCores(seeded, NIGHT).get(C1), { offlineSinceMs: null, bridged: false });
  assert.equal(offlineHomeCores({ [PANEL]: p, [C1]: live(C1, NIGHT) }, NIGHT).has(C1), false, 'its content changed: it reports');
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
  const devs = (ago: number): Any => ({ [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: at(ago), [C2]: live(C2, NIGHT), [C3]: live(C3, NIGHT) });
  // A 6 s /status flip and the 2026-10-03 ~92 s /device/list blip are not outages.
  for (const ago of [6_000, 92_000, BRIDGE_DWELL_MS - 1]) {
    assert.deepEqual(darkHomeSlots(devs(ago), NIGHT), [], `offline ${ago} ms`);
    assert.deepEqual(offlineHomeCores(devs(ago), NIGHT).get(C1), { offlineSinceMs: NIGHT - ago, bridged: false });
  }
  const dark = darkHomeSlots(devs(BRIDGE_DWELL_MS), NIGHT);
  assert.deepEqual(dark.map((d) => [d.sn, d.darkSinceMs]), [[C1, NIGHT - BRIDGE_DWELL_MS]], 'from the instant it went offline');
  // A flip stamped in the future (clock skew) is read as now: inside the dwell.
  assert.deepEqual(offlineHomeCores(devs(-60_000), NIGHT).get(C1), { offlineSinceMs: NIGHT, bridged: false });
  // The power sensors inside the dwell: the Core is neither summed nor bridged, so both figures
  // are withheld (unknown, never a partial sum: the review's 3-min dwell case).
  const f = bridgeFleetFlow({ fleetPv: 3000, fleetBatteryNet: 1800 }, devs(30_000), NIGHT, () => false, PHX);
  assert.deepEqual([f.ready, f.bridgedSlots, f.fleetBatteryNet, f.pending, f.ownCores], [false, 0, null, [C1], 2]);
  const g = bridgeFleetFlow({ fleetPv: 3000, fleetBatteryNet: 1800 }, devs(BRIDGE_DWELL_MS), NIGHT, () => false, PHX);
  assert.deepEqual([g.ready, g.bridgedSlots, g.fleetBatteryNet, g.pending], [true, 1, 1800 + 1145, []]);
});

test('★★★ after a restart a Core listed offline with no transition time takes the persisted hand-off instant; the store\'s own transition time wins', () => {
  const devs = (c1: Any): Any => ({ [PANEL]: panel(NOON, [-1145, -1145, -1119]), [C1]: c1, [C2]: live(C2, NOON), [C3]: live(C3, NOON) });
  const persisted = NOON - 4 * 60_000;
  const known = (sn: string): number | null => (sn === C1 ? persisted : null);
  // First sight after a restart: no transition time. Without the lookup it reads as offline since
  // before any run saw it (null); with it, the instant the crashed process saw.
  assert.deepEqual(offlineHomeCores(devs(core(C1, false, false)), NOON).get(C1), { offlineSinceMs: null, bridged: true });
  assert.deepEqual(offlineHomeCores(devs(core(C1, false, false)), NOON, known).get(C1), { offlineSinceMs: persisted, bridged: true });
  assert.deepEqual(darkHomeSlots(devs(core(C1, false, false)), NOON, known).map((d) => [d.sn, d.darkSinceMs]), [[C1, persisted]]);
  // A persisted instant inside the dwell is inside the dwell after the restart too.
  const recent = (sn: string): number | null => (sn === C1 ? NOON - 60_000 : null);
  assert.deepEqual(offlineHomeCores(devs(core(C1, false, false)), NOON, recent).get(C1), { offlineSinceMs: NOON - 60_000, bridged: false });
  assert.deepEqual(darkHomeSlots(devs(core(C1, false, false)), NOON, recent), []);
  // The store's transition time (this process saw the flip) wins over a persisted one.
  assert.deepEqual(offlineHomeCores(devs({ ...core(C1, false), onlineChangedAtMs: NOON - 10 * 60_000 }), NOON, known).get(C1), { offlineSinceMs: NOON - 10 * 60_000, bridged: true });
  // A Core that reports is not offline whatever was persisted for it.
  assert.equal(offlineHomeCores(devs(live(C1, NOON)), NOON, known).has(C1), false);
  // The power sensors read the same instant: inside the dwell the Core withholds both figures.
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devs(core(C1, false, false)), NOON, () => false, PHX, recent);
  assert.deepEqual([f.ready, f.bridgedSlots, f.pending], [false, 0, [C1]]);
});

test('★★★ the bridge persists each hand-off instant once, reads it back in a new process, and deletes it once the Core reports again', () => {
  const rows = new Map<string, { wh: number; ts: number }>();
  const writes: string[] = [];
  const deps: Any = {
    readLifetime: (k: string) => rows.get(k) ?? { wh: 0, ts: 0 },
    writeLifetime: (k: string, wh: number, ts: number) => { rows.set(k, { wh, ts }); writes.push(k); },
    deleteLifetime: (k: string) => { rows.delete(k); },
    listLifetimeKeys: () => [...rows.keys()],
    query: () => [],
    coreCapacityWh: () => null,
    site: () => PHX,
    log: () => {},
  };
  const flip = NOON - 5 * 60_000;
  const devs = (c1: Any): Any => ({ [PANEL]: panel(NOON, [-1145, -1145, -1119]), [C1]: c1, [C2]: live(C2, NOON), [C3]: live(C3, NOON) });
  const a = createEnergyBridge(deps);
  assert.deepEqual(a.offlineHomeCores(devs({ ...core(C1, false), onlineChangedAtMs: flip }), NOON).get(C1), { offlineSinceMs: flip, bridged: true });
  assert.deepEqual(rows.get(bridgeOfflineKey(C1)), { wh: 1, ts: flip });
  a.offlineHomeCores(devs({ ...core(C1, false), onlineChangedAtMs: flip }), NOON + 30_000);
  assert.deepEqual(writes, [bridgeOfflineKey(C1)], 'written once, not on every read');
  // A new process (a crash restart): the store lists C1 offline with no transition time.
  const b = createEnergyBridge(deps);
  assert.deepEqual(b.offlineHomeCores(devs(core(C1, false, false)), NOON + 60_000).get(C1), { offlineSinceMs: flip, bridged: true });
  assert.deepEqual(b.debug(devs(core(C1, false, false)), NOON + 60_000).offlineSince, [{ sn: C1, sinceMs: flip }]);
  // Listed online with no reading of its own yet (the flip before the first quota): still dark,
  // from the same instant.
  assert.deepEqual(b.offlineHomeCores(devs({ ...core(C1, true, false), onlineChangedAtMs: NOON + 80_000 }), NOON + 80_000).get(C1), { offlineSinceMs: flip, bridged: true });
  assert.equal(rows.get(bridgeOfflineKey(C1))?.ts, flip);
  // It reports again: deleted, so a later first sight offline does not reuse it.
  b.offlineHomeCores(devs({ ...live(C1, NOON + 90_000), onlineChangedAtMs: NOON + 85_000 }), NOON + 90_000);
  assert.equal(rows.has(bridgeOfflineKey(C1)), false);
  assert.deepEqual(b.offlineHomeCores(devs(core(C1, false, false)), NOON + 120_000).get(C1), { offlineSinceMs: null, bridged: true });
  assert.equal(rows.has(bridgeOfflineKey(C1)), false, 'no transition time, nothing persisted');
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

test('★★★ the panel PV field against the inferred lower bound: pending until the bound has risen enough, then at least the bound less max(two steps, 15 %)', () => {
  const step = 286.72;
  const evidence = BRIDGE_PV_EVIDENCE_STEPS * step;
  assert.equal(BRIDGE_PV_EVIDENCE_STEPS, 8);
  assert.deepEqual([BRIDGE_PV_TOLERANCE_STEPS, BRIDGE_PV_TOLERANCE_FRACTION], [2, 0.15]);
  assert.equal(pvFieldTolerance(evidence, step), 2 * step, 'at a small bound the two steps of quantization');
  assert.equal(pvFieldTolerance(20_000, step), 3000, 'at a large one the fraction');
  assert.equal(pvFieldVerdict(5_000, evidence - 1, step), 'pending', 'one reading, or a little sun, proves nothing');
  assert.equal(pvFieldVerdict(evidence, evidence, step), 'consistent');
  assert.equal(pvFieldVerdict(evidence - 2 * step, evidence, step), 'consistent', 'the bound carries a step of quantization at each end');
  assert.equal(pvFieldVerdict(evidence - 2 * step - 1, evidence, step), 'below');
  assert.equal(pvFieldVerdict(0, evidence, step), 'below', 'a field reading 0 under a rising charge');
  assert.equal(pvFieldVerdict(evidence / 2, evidence, step), 'below', 'half the solar (the battery-charging share alone): 4 of 8 steps against 6');
  assert.equal(pvFieldVerdict(0.75 * evidence, evidence, step), 'consistent', 'the first verdict passes r ≥ 0.75, as before');
  assert.equal(pvFieldVerdict(3 * evidence, evidence, step), 'consistent', 'a field reading high is not caught (the bound is a lower one)');
  assert.equal(pvFieldVerdict(10, 10_000, 0), 'pending', 'no capacity: no verdict');
  // At a large bound the fraction governs: 16 % short is below, 14 % is not.
  assert.equal(pvFieldVerdict(8_400, 10_000, step), 'below');
  assert.equal(pvFieldVerdict(8_600, 10_000, step), 'consistent');
});

test('★★★ 2026-10-18 as logged: the three honest fields the one-step rule revoked (2.67 vs 2.99, 7.37 vs 7.66, 9.25 vs 9.54 kWh) are consistent, and so is the day\'s end (9.51 vs 10.53); a field half the solar is still below', () => {
  // (field kWh, bound kWh, one SoC step kWh) from the add-on log and the replay of the recorded series.
  const live: Array<[number, number, number, string]> = [
    [2.67, 2.99, 0.30, 'slot 3 at 11:16 (1.05 steps short)'],
    [7.37, 7.66, 0.29, 'slot 1 at 14:36 (1.00 step short)'],
    [9.25, 9.54, 0.28, 'slot 2 at 17:51 (1.01 steps short)'],
    [9.36, 10.14, 0.29, 'slot 1 at dusk (2.70 steps, 7.7 %)'],
    [9.51, 10.53, 0.30, 'slot 3 at dusk (3.40 steps, 9.6 %)'],
    [5.36, 5.98, 0.30, 'slot 3 at 13:26, one window at 10.4 %'],
    [1.07, 1.20, 0.30, 'slot 3 at 09:46 (0.43 steps): pending now, 4 steps of evidence'],
  ];
  for (const [f, b, s, why] of live) {
    const v = pvFieldVerdict(f * 1000, b * 1000, s * 1000);
    assert.equal(v, b * 1000 < BRIDGE_PV_EVIDENCE_STEPS * s * 1000 ? 'pending' : 'consistent', why);
  }
  for (const [f, b, s, why] of live) {
    if (b * 1000 < BRIDGE_PV_EVIDENCE_STEPS * s * 1000) continue;
    assert.equal(pvFieldVerdict(f * 500, b * 1000, s * 1000), 'below', `half of ${why}`);
  }
});

test('★★★ a verdict takes effect after one full hour, or at once on a genuine margin of 2 kWh in its direction — the same rule both ways', () => {
  const t0 = NOON;
  assert.equal(BRIDGE_PV_VERDICT_HOLD_MS, 60 * 60_000);
  assert.equal(BRIDGE_PV_GENUINE_WH, 2000);
  assert.equal(pvVerdictHolds('below', t0, t0 + 59 * 60_000, 4_000, 5_000), false, '1 kWh short for 59 min: not yet');
  assert.equal(pvVerdictHolds('below', t0, t0 + 60 * 60_000, 4_000, 5_000), true, 'the hour');
  assert.equal(pvVerdictHolds('below', t0, t0, 3_000, 5_000), true, '2 kWh short: at once');
  assert.equal(pvVerdictHolds('below', t0, t0, 7_000, 5_000), false, 'a field ABOVE the bound never holds a below verdict early');
  assert.equal(pvVerdictHolds('consistent', t0, t0 + 59 * 60_000, 5_000, 5_000), false);
  assert.equal(pvVerdictHolds('consistent', t0, t0 + 60 * 60_000, 5_000, 5_000), true);
  assert.equal(pvVerdictHolds('consistent', t0, t0, 7_000, 5_000), true, '2 kWh above the bound: at once');
  assert.equal(pvVerdictHolds('consistent', t0, t0, 3_000, 5_000), false, 'a shortfall never holds a consistent verdict early');
});

test('★★★ the power-sensor basis of a dark slot in daylight: the field trusted is measured, present but unchecked is unchecked, found below or absent is unbridgeable', () => {
  const src = [{ pvHighWatts: 2000, pvLowWatts: 500 }, { pvWatts: null, pvHighWatts: null, pvLowWatts: null }, { pvHighWatts: 0, pvLowWatts: 0 }];
  const devices = { [PANEL]: panel(NOON, [-500, -800, 300], {}, src), [C1]: core(C1, false), [C2]: core(C2, false), [C3]: core(C3, false) };
  const [s1, s2, s3] = darkHomeSlots(devices, NOON);
  assert.equal(slotPowerBasis(s1, NOON, true, PHX), 'measured');
  assert.equal(slotPowerBasis(s1, NOON, false, PHX), 'unchecked');
  assert.equal(slotPowerBasis(s1, NOON, 'below', PHX), 'unbridgeable', 'a field found short of the bound today is withheld');
  assert.equal(slotPowerBasis(s2, NOON, false, PHX), 'unbridgeable', 'no field at all');
  assert.equal(slotPowerBasis(s2, NOON, true, PHX), 'unbridgeable', 'trusted or not, an absent field is no figure');
  assert.equal(slotPowerBasis(s3, NOON, false, PHX), 'unchecked', 'a field reading 0 W is present');
  assert.equal(slotPowerBasis(s1, NIGHT, 'below', PHX), 'night', 'at night the field does not matter');
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
  assert.deepEqual(bridgeFleetFlow(ONLINE, devices, NOON, () => false, PHX).slots.map((s) => s.basis), ['unchecked', 'unchecked', 'unchecked'], 'noon in Phoenix: daylight, the field is read');
  assert.equal(bridgeFleetFlow(ONLINE, devices, NOON, () => 'below', PHX).ready, false, 'noon in Phoenix with the field found short: no figure');
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

test('★★★ in daylight the PV field is the solar figure and battery = −chW − pv, trusted or unchecked; a field found below, or absent, is no figure at all', () => {
  const src = [{ pvHighWatts: 2000, pvLowWatts: 500 }, { pvHighWatts: 0, pvLowWatts: 0 }, { pvHighWatts: 1000, pvLowWatts: 0 }];
  const devices = { [PANEL]: panel(NOON, [-500, -800, 300], {}, src), [C1]: core(C1, false), [C2]: core(C2, false), [C3]: core(C3, false) };
  const trusted = bridgeFleetFlow({ fleetPv: 100, fleetBatteryNet: 50 }, devices, NOON, () => true, PHX);
  assert.equal(trusted.ready, true);
  assert.equal(trusted.fleetPv, 100 + 2500 + 0 + 1000);
  // battery: 50 + (500 − 2500) + (800 − 0) + (−300 − 1000) = −2450 (charging)
  assert.equal(trusted.fleetBatteryNet, 50 - 2000 + 800 - 1300);
  assert.deepEqual(trusted.slots.map((s) => s.basis), ['measured', 'measured', 'measured']);
  // Unchecked: the same figures (the two sum to the slot meter whatever the field reads).
  const unchecked = bridgeFleetFlow({ fleetPv: 100, fleetBatteryNet: 50 }, devices, NOON, () => false, PHX);
  assert.deepEqual([unchecked.ready, unchecked.fleetPv, unchecked.fleetBatteryNet], [true, 3600, -2450], 'a present field publishes before its check');
  assert.deepEqual(unchecked.slots.map((s) => s.basis), ['unchecked', 'unchecked', 'unchecked']);
  assert.equal((unchecked.fleetPv as number) + (unchecked.fleetBatteryNet as number), 150 + 500 + 800 - 300, 'PV + battery = Σ −chW + the online sums: the consumption the dashboard derives');
  // Found below today: withheld.
  const below = bridgeFleetFlow(ONLINE, devices, NOON, () => 'below', PHX);
  assert.equal(below.ready, false, 'a field the check has found short is not published');
  assert.equal(below.fleetPv, null);
  assert.equal(below.fleetBatteryNet, null);
  const oneBelow = bridgeFleetFlow(ONLINE, devices, NOON, (_p, slot) => (slot === 2 ? 'below' : slot === 1), PHX);
  assert.equal(oneBelow.ready, false, 'one unbridgeable slot withholds both figures');
  assert.deepEqual(oneBelow.slots.map((s) => s.basis), ['measured', 'unbridgeable', 'unchecked']);
  // Absent: withheld, trusted or not.
  const bare = panel(NOON, [-500, -800, 300], {}, [{ pvWatts: null, pvHighWatts: null, pvLowWatts: null }, {}, {}]);
  const absent = bridgeFleetFlow(ONLINE, { ...devices, [PANEL]: bare }, NOON, () => true, PHX);
  assert.deepEqual([absent.ready, absent.fleetPv, absent.fleetBatteryNet, absent.slots[0].basis], [false, null, null, 'unbridgeable'], 'no field: no figure, never a made-up 0');
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
  const plant = (at: number): Any => {
    const devices: Any = {
      [PANEL]: house, [GARAGE]: garage,
      [C1]: { ...live(C1, at), lastQuotaAtMs: at },
      [C2]: { ...live(C2, at), lastQuotaAtMs: at },
      [CG]: { ...core(CG, false, true), onlineChangedAtMs: NIGHT - 60 * 60_000 },
    };
    devices[C1].projection = { ...devices[C1].projection, pvTotalWatts: 2000 };
    devices[C2].projection = { ...devices[C2].projection, pvTotalWatts: 1500 };
    return devices;
  };
  const agg = aggregateFleetFlow(plant(NOON));
  assert.equal(agg.fleetPv, 3500, 'the two house Cores');
  for (const at of [NOON, NIGHT]) {
    const devices = plant(at);
    const f = bridgeFleetFlow({ fleetPv: agg.fleetPv, fleetBatteryNet: agg.fleetBatteryNetDisplay }, devices, at, () => true, PHX);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet, f.bridgedSlots], [true, 3500, agg.fleetBatteryNetDisplay, 0], new Date(at).toISOString());
    assert.deepEqual(f.slots.map((s) => [s.panelSn, s.sn, s.basis, s.leftOut]), [[GARAGE, CG, 'unbridgeable', true]]);
    const r = publishReadiness({ devices, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
      curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: at, flowBridge: f } as Any);
    assert.equal(r.flowBridged, true, 'Fleet PV and Battery Net publish the house Cores');
  }
  // A single panel that is itself cloud-offline with every Core dark: nothing is summed, both withheld (as before the bridge).
  const alone: Any = { [GARAGE]: garage, [CG]: plant(NIGHT)[CG] };
  const g = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, alone, NIGHT, () => true, PHX);
  assert.deepEqual([g.ready, g.bridgedSlots], [true, 0]);
  const r = publishReadiness({ devices: alone, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
    curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: NIGHT, flowBridge: g } as Any);
  assert.equal(r.flowBridged, false);
});

test('★★ a stale panel bridges nothing; an all-online fleet is unchanged by the bridge', () => {
  const stale = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119], { lastQuotaAtMs: NIGHT - 400_000 }), [C1]: core(C1, false), [C2]: live(C2, NIGHT), [C3]: live(C3, NIGHT) };
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 1800 }, stale, NIGHT, () => true, PHX);
  assert.equal(f.ready, false);
  assert.equal(f.fleetBatteryNet, null);
  assert.equal(slotPowerBasis(darkHomeSlots(stale, NIGHT)[0], NIGHT, true, PHX), 'unbridgeable');
  const online = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: live(C1, NIGHT), [C2]: live(C2, NIGHT), [C3]: live(C3, NIGHT) };
  const g = bridgeFleetFlow({ fleetPv: 4500, fleetBatteryNet: 2700 }, online, NIGHT, () => false, PHX);
  assert.deepEqual([g.fleetPv, g.fleetBatteryNet, g.bridgedSlots, g.ready, g.ownCores], [4500, 2700, 0, true, 3]);
});

test('held pack keys of a Core: both persisted shapes, and no other Core\'s rows', () => {
  const keys = [
    `pack_lastwhid_${C1}:${C1}-P1_chg`, `pack_lastwhid_${C1}:${C1}-P1_dsg`, `pack_lastwh_${C1}_3_chg`,
    `pack_lastwhid_${C2}:${C2}-P1_chg`, `pack_base_${C1}_3_chg`, 'fleet_pv_wh', `bridge_dark_${C1}:${C1}-P1`,
  ];
  assert.deepEqual(heldPackKeysOf(C1, keys), [`${C1}:${C1}-P1`, `${C1}|3`]);
});

test('★★ every home Core listed offline but its own MQTT data arriving after the flip: each counts at its own reading, and both power figures publish', () => {
  const off = (sn: string): Any => ({ ...live(sn, NIGHT), online: false, onlineChangedAtMs: NIGHT - 60_000 });
  const devices: Any = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: off(C1), [C2]: off(C2), [C3]: off(C3) };
  const agg = aggregateFleetFlow(devices);
  assert.deepEqual([agg.fleetPv, agg.fleetBatteryNetDisplay], [0, 0], 'precondition: none is listed online');
  const f = bridgeFleetFlow({ fleetPv: agg.fleetPv, fleetBatteryNet: agg.fleetBatteryNetDisplay }, devices, NIGHT, () => false, PHX);
  assert.deepEqual([f.ready, f.ownCores, f.bridgedSlots, f.fleetPv, f.fleetBatteryNet], [true, 3, 0, 4500, 2700]);
  assert.deepEqual(darkHomeSlots(devices, NIGHT), [], 'not dark: their own readings arrive');
  const r = publishReadiness({ devices, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
    curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: NIGHT, flowBridge: f } as Any);
  assert.equal(r.flow, false, 'the Cores-only flows: none listed online');
  assert.equal(r.flowBridged, true, 'Fleet PV and Battery Net: every figure a reading');
  // Data from BEFORE the flip is its last report, not a reading after it: dark at the flip.
  const stale: Any = { ...devices, [C1]: { ...off(C1), onlineChangedAtMs: NIGHT + 1 } };
  assert.deepEqual(offlineHomeCores(stale, NIGHT + 2).get(C1), { offlineSinceMs: NIGHT + 1, bridged: false });
});

/* ══ v1.188.1 review round 2 ════════════════════════════════════════════════ */

test('★★★ the flow sensors (AC Import, Fleet Total In / Out) on the same notion as Battery Net: every Core frozen online mid grid-charge, the slots at 0 W — not 15 kW of held AC input', () => {
  // Each Core's quota began failing during a 5 kW grid charge; the charge has ended and the slots read 0 W.
  const frozen = (sn: string): Any => ({
    ...core(sn, true), lastTelemetryAtMs: NIGHT - 30 * 60_000, contentChangedAtMs: NIGHT - 30 * 60_000,
    projection: { kind: 'dpu', soc: 80, pvTotalWatts: 0, totalInWatts: 5000, totalOutWatts: 0, acInWatts: 5000, packs: [{ outputWatts: 0, inputWatts: 4800 }] },
  });
  const devices: Any = { [PANEL]: panel(NIGHT, [0, 0, 0]), [C1]: frozen(C1), [C2]: frozen(C2), [C3]: frozen(C3) };
  const agg = aggregateFleetFlow(devices);
  assert.equal(agg.acIn, 15000, 'precondition: the online sums carry the held figures');
  const f = bridgeFleetFlow({ fleetPv: agg.fleetPv, fleetBatteryNet: agg.fleetBatteryNetDisplay, acIn: agg.acIn, fleetIn: agg.fleetIn, fleetOut: agg.fleetOut }, devices, NIGHT, () => false, PHX);
  assert.equal(f.bridgedSlots, 3);
  assert.deepEqual([f.acIn, f.fleetIn, f.fleetOut, f.fleetBatteryNet], [0, 0, 0, 0], 'the slots: no AC exchange, nothing held');
  // Cores dark delivering through their slots at night: AC out and no input.
  const dark: Any = { [PANEL]: panel(NIGHT, [-1145, -1145, -1119]), [C1]: core(C1, false, false), [C2]: core(C2, false, false), [C3]: core(C3, false, false) };
  const g = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0, acIn: 0, fleetIn: 0, fleetOut: 0 }, dark, NIGHT, () => false, PHX);
  assert.deepEqual([g.acIn, g.fleetIn, g.fleetOut], [0, 0, 3409]);
  // A force charge through the slots: AC input, which Fleet Total In carries too.
  const charging: Any = { ...dark, [PANEL]: panel(NIGHT, [5300, 5300, 5300]) };
  const h = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0, acIn: 0, fleetIn: 0, fleetOut: 0 }, charging, NIGHT, () => false, PHX);
  assert.deepEqual([h.acIn, h.fleetIn, h.fleetOut], [15900, 15900, 0]);
});

test('★★ the flow sensors: a dark slot on a stale panel withholds them (unknown, never a partial sum); in daylight with the PV field found short Fleet Total In is unknown, AC Import and Fleet Total Out are the slots', () => {
  const dark = (p: Any): Any => ({ [PANEL]: p, [C1]: core(C1, false, false), [C2]: core(C2, false, false), [C3]: core(C3, false, false) });
  const online = { fleetPv: 0, fleetBatteryNet: 0, acIn: 0, fleetIn: 0, fleetOut: 0 };
  const stale = bridgeFleetFlow(online, dark(panel(NIGHT, [-1000, -1000, -1000], { lastQuotaAtMs: NIGHT - 400_000 })), NIGHT, () => false, PHX);
  assert.deepEqual([stale.acIn, stale.fleetIn, stale.fleetOut], [null, null, null]);
  const day = bridgeFleetFlow(online, dark(panel(NOON, [-500, -500, 200])), NOON, () => 'below', PHX);
  assert.deepEqual([day.acIn, day.fleetIn, day.fleetOut, day.fleetPv], [200, null, 1000, null]);
  const unchecked = bridgeFleetFlow(online, dark(panel(NOON, [-500, -500, 200])), NOON, () => false, PHX);
  assert.deepEqual([unchecked.acIn, unchecked.fleetIn, unchecked.fleetOut, unchecked.fleetPv], [200, 200, 1000, 0], 'the field present (0 W), unchecked: Fleet Total In adds it');
  // No such input given (a caller that passes only the two power figures): null, never a 0.
  const bare = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, dark(panel(NIGHT, [-1000, -1000, -1000])), NIGHT, () => false, PHX);
  assert.deepEqual([bare.acIn, bare.fleetIn, bare.fleetOut], [null, null, null]);
});

test('★★★ a dark Core listed connected by two panels (one panel\u2019s source list stale) is metered once, at one slot: Battery Net and the rollup count it once', () => {
  const P2 = 'HD31XXX00XXX0002';
  const twoPanels = (staleFirst: boolean): Any => {
    const a = panel(NIGHT, [-1000, 0, 0]);
    const b = { ...panel(NIGHT, [-1000, 0, 0]), sn: P2, ...(staleFirst ? {} : { lastQuotaAtMs: NIGHT - 400_000 }) };
    if (staleFirst) a.lastQuotaAtMs = NIGHT - 400_000;
    for (const p of [a, b]) for (const s of p.projection.sources) if (s.sn !== C1) s.isConnected = false;
    return { [PANEL]: a, [P2]: b, [C1]: core(C1, false, false) };
  };
  const fresh = twoPanels(false);
  fresh[P2].lastQuotaAtMs = NIGHT - 30_000;
  assert.equal(darkHomeSlots(fresh, NIGHT).length, 1, 'one slot, not two');
  const f = bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, fresh, NIGHT, () => false, PHX);
  assert.deepEqual([f.fleetBatteryNet, f.bridgedSlots], [1000, 1], 'not 2000 W');
  // The listing on the panel whose reading is fresh is the one read, whatever the device map's order.
  for (const staleFirst of [true, false]) {
    const ds = twoPanels(staleFirst);
    const slots = darkHomeSlots(ds, NIGHT);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].panelSn, staleFirst ? P2 : PANEL, 'the fresh panel\u2019s listing');
    assert.equal(slots[0].panelFresh, true);
    assert.deepEqual(bridgeFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, ds, NIGHT, () => false, PHX).fleetBatteryNet, 1000, 'bridgeable at the fresh listing');
  }
  // The rollup books one window: 10 min at 1 kW out.
  const rows = new Map<string, { wh: number; ts: number }>();
  const samples = (sn: string, metric: string, since: number, until: number) =>
    metric === 'src1_w' && (sn === PANEL || sn === P2) ? Array.from({ length: 11 }, (_, i) => ({ ts: NIGHT - 10 * 60_000 + i * 60_000, value: -1000 })).filter((p) => p.ts >= since && p.ts <= until) : [];
  rows.set('bridge_battery_charge_wh', { wh: 0, ts: NIGHT - 10 * 60_000 });
  const b = createEnergyBridge({
    readLifetime: (k) => rows.get(k) ?? { wh: 0, ts: 0 }, writeLifetime: (k, wh, ts) => { rows.set(k, { wh, ts }); }, deleteLifetime: (k) => { rows.delete(k); },
    listLifetimeKeys: () => [...rows.keys()], query: samples, coreCapacityWh: () => null, site: () => PHX, log: () => {},
  });
  const r = b.rollup({ generatedAt: NIGHT, devices: fresh }, NIGHT);
  assert.equal(r.slots.length, 1);
  assert.ok(Math.abs(r.dischargeWh - 1000 * 10 / 60) < 0.5, `one window booked: ${r.dischargeWh.toFixed(1)} Wh`);
});

test('★★ slotVerdicts: the Cores counted at their own reading, and the PV of each slot wherever the sensors read the field (trusted or unchecked), not where it was found short', () => {
  const devices: Any = { [PANEL]: panel(NOON, [-500, -500, -500], {}, [{ pvHighWatts: 2000 }, { pvHighWatts: 2000 }, {}]), [C1]: core(C1, false, false), [C2]: core(C2, false, false), [C3]: live(C3, NOON) };
  const f = bridgeFleetFlow({ fleetPv: 1500, fleetBatteryNet: 900 }, devices, NOON, (_p, slot) => (slot === 1 ? true : 'below'), PHX);
  const v = slotVerdicts(f);
  assert.deepEqual([...v.own], [C3]);
  assert.deepEqual([...v.measuredPvW.entries()], [[`${PANEL}#1`, 2000]], 'slot 1 trusted; slot 2 found short, so not measured');
  const g = bridgeFleetFlow({ fleetPv: 1500, fleetBatteryNet: 900 }, devices, NOON, (_p, slot) => slot === 1, PHX);
  assert.deepEqual([...slotVerdicts(g).measuredPvW.entries()], [[`${PANEL}#1`, 2000], [`${PANEL}#2`, 2000]], 'slot 2 unchecked: the card and the timers read what the sensors publish');
});

test('projectionPacksComplete: the pack count is known and met', () => {
  const d = (packs: number, count: number | null): Any => ({ sn: C1, projection: { kind: 'dpu', packCount: count, packs: Array.from({ length: packs }, (_, i) => ({ num: i + 1 })) } });
  assert.equal(projectionPacksComplete(d(2, 2)), true);
  assert.equal(projectionPacksComplete(d(1, 2)), false, 'a pack not reported yet');
  assert.equal(projectionPacksComplete(d(2, null)), false, 'the count unknown');
  assert.equal(projectionPacksComplete({ sn: C1 } as Any), false, 'no projection');
});

test('★★ held pack keys with the device map: the packs the projection carries; with none, every row but a pack another chassis carries now', () => {
  const keys = [`pack_lastwhid_${C1}:${C1}-P1_chg`, `pack_lastwhid_${C1}:${C1}-POLD_chg`, `pack_lastwhid_${C1}:MOVED_chg`, `pack_lastwh_${C1}_3_chg`];
  const withProj: Any = { [C1]: { sn: C1, projection: { kind: 'dpu', packs: [{ num: 1, packSn: `${C1}-P1` }, { num: 3, packSn: null }] } } };
  assert.deepEqual(heldPackKeysOf(C1, keys, withProj), [`${C1}:${C1}-P1`, `${C1}|3`]);
  const noProj: Any = { [C1]: { sn: C1 }, [C2]: { sn: C2, projection: { kind: 'dpu', packs: [{ num: 1, packSn: 'MOVED' }] } } };
  assert.deepEqual(heldPackKeysOf(C1, keys, noProj), [`${C1}:${C1}-P1`, `${C1}:${C1}-POLD`, `${C1}|3`], 'the pack now in another chassis is not marked');
});
