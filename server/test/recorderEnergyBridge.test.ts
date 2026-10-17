/**
 * v1.188.1 — the energy bridge, driven through the REAL recorder (lifetime rollup, emitted totals,
 * BMS hand-over, restart). The transitions themselves (a dark flip between rollups, a blip, a
 * second dark span) are in recorderEnergyBridgeTransitions.test.ts.
 *
 * Live shape, 2026-10-14 23:52 → 10-16 MST: all home Cores cloud-offline, the Smart Home Panel 2
 * fresh, its three source slots metering ≈ −1145 / −1145 / −1119 W (the Cores supplying ~3.4 kW).
 * Home Assistant read battery in/out 0/0 and solar 0.0 kWh for 10-15 and 10-16. With the bridge:
 *  - at night the slots' outflow is battery out, at ~3.4 kWh/h; a night grid charge is battery in,
 *    never solar;
 *  - in daylight the PV that charges the Cores is inferred from the slots' net output plus the
 *    stored-energy rise (an unverified 0 W panel PV field is not "no PV"), or read from the field
 *    once it has been checked against that inferred lower bound (and dropped when it falls below);
 *  - when the Cores report again, their BMS counters jump by the dark days' throughput; the
 *    published totals do not jump (the bridge already counted it) and never step down — also when
 *    MQTT battery data still arrives while the cloud lists them offline, or arrives just before the
 *    online flip from early in the dark span;
 *  - the day/night test is judged at the configured install site;
 *  - a restart mid-outage keeps all of it.
 * Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPlant, near, MIN, H, PANEL, CORES, PACKS, PACK_MAH_TO_WH, FULL_CAP_MAH, NAMEPLATE_WH, DISCHARGE_W,
} from './helpers/energyBridgePlant.js';

const { Plant, cleanup } = await loadPlant('ef-energy-bridge-');
const { BRIDGE_MAX_WINDOW_MS, BRIDGE_PV_EVIDENCE_STEPS, bridgePvSeenKey } = await import('../src/energyBridge.js');
test.after(cleanup);

/* ── the 10-15 shape ─────────────────────────────────────────────────────── */

test('★★★ Cores dark at night, slots discharging 3.4 kW for 4 h → battery out rises ~3.4 kWh/h; battery in and PV stay flat', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.run(240);
    const after = p.read();
    const expected = 3409 * 4 - 3409 / 60; // the first minute after the flip has no sample yet
    near(after.dsg - before.dsg, expected, expected * 0.01, 'battery out bridged');
    near(after.chg - before.chg, 0, 1, 'battery in');
    near(after.pv - before.pv, 0, 1, 'PV at night');
    const dbg = p.rec.batteryLifetimeDebug();
    near(dbg.bridge.dischargeWh, expected, expected * 0.01, 'the bridge row');
    assert.equal(dbg.bridge.markers.length, CORES.length * PACKS, 'every held pack is marked for the hand-over');
    assert.equal(p.logs.filter((l) => l.includes('metering its battery and solar at panel')).length, CORES.length, 'one line per Core');
  } finally { p.close(); }
});

test('★★★ daylight, grid 0, the Cores supplying 300 W each while PV charges them: battery in and PV production rise (an unverified 0 W field is not "no PV")', () => {
  const t0 = Date.parse('2026-10-15T09:00:00-07:00');
  const p = new Plant(t0);
  try {
    // The Cores' measured full-charge capacity, recorded while they reported: 5 packs × 56,000 mAh.
    for (const sn of CORES) for (let k = 1; k <= 5; k++) p.sample(sn, `pack${k}_full_cap_mah`, FULL_CAP_MAH, t0 - H);
    p.darkAtFirstSight();
    p.frozenProjection = false; // the live case: dark since before the restart, no projection
    p.sourceWatts = [-300, -300, -300];
    p.pct = [40, 40, 40];
    p.panelSamples(t0);
    const before = p.read();
    // SoC +1 % every 8 min for 4 h: 40 → 70 %. The panel's PV field reads 0 throughout.
    p.run(240, (_t, m) => { p.pct = CORES.map(() => 40 + Math.floor(m / 8)); });
    const after = p.read();
    const capWh = 5 * FULL_CAP_MAH * PACK_MAH_TO_WH; // 28,672 Wh
    const storedWh = (p.pct[0] - 40) / 100 * capWh;
    const perSlotPv = 300 * 4 + storedWh;
    near(after.pv - before.pv, 3 * perSlotPv, 3 * capWh / 100 + 30, 'PV production inferred');
    near(after.chg - before.chg, 3 * storedWh, 3 * capWh / 100 + 30, 'battery in');
    near(after.dsg - before.dsg, 0, 1, 'battery out: the 300 W the Cores supplied came from PV');
    assert.ok(after.pv - before.pv > 20_000, 'a 0 W reading from a field never seen working was not taken as PV = 0');
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, [], 'a field reading 0 W under a rising charge is below the bound');
    assert.equal(dbg.lastRollup?.slots[0].basis, 'inferred');
    const verdicts = p.logs.filter((l) => l.includes('the field is not trusted (the inferred basis stays)'));
    assert.equal(verdicts.length, CORES.length, 'one verdict line per slot, with both figures');
    assert.match(verdicts[0], /PV field read 0\.00 kWh since \S+ against the inferred lower bound [\d.]+ kWh \(one SoC step 0\.29 kWh\)/);
  } finally { p.close(); }
});

/* ── the panel's PV field: checked against the inferred lower bound ─────────── */

/** Daylight, Cores dark since before the restart; each slot: PV `pvW` W, of which `outW` crosses
 *  to the panel and the rest charges the Core (its percent rising on the nameplate basis). */
function sunnyPlant(t0: number): InstanceType<typeof Plant> {
  const p = new Plant(t0);
  p.darkAtFirstSight();
  p.frozenProjection = false;
  p.pct = [40, 40, 40];
  return p;
}
const STEP_WH = NAMEPLATE_WH / 100; // 307.2 Wh, no pack capacity recorded
function sunny(p: InstanceType<typeof Plant>, minutes: number, slot: { outW: number; pvW: number; fieldW: number }, stored: { wh: number }): void {
  p.sourceWatts = [-slot.outW, -slot.outW, -slot.outW];
  p.pvW = [slot.fieldW, slot.fieldW, slot.fieldW];
  p.run(minutes, () => {
    stored.wh += (slot.pvW - slot.outW) / 60;
    p.pct = CORES.map(() => 40 + Math.floor(stored.wh / STEP_WH));
  });
}

test('★★★ a panel PV field that reads the solar the Cores take in is trusted once the inferred bound has risen enough, logged with both figures; then battery = slot net − PV', () => {
  const p = sunnyPlant(Date.parse('2026-10-15T11:00:00-07:00'));
  try {
    p.panelSamples(p.clock);
    const before = p.read();
    const stored = { wh: 0 };
    sunny(p, 5, { outW: 500, pvW: 2500, fieldW: 2500 }, stored);
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.trustedSlots, [], 'one reading proves nothing: inferred while the check is pending');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.pvChecks[0].verdict, 'pending');
    sunny(p, 115, { outW: 500, pvW: 2500, fieldW: 2500 }, stored);
    const after = p.read();
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`]);
    const lines = p.logs.filter((l) => l.includes('the field is trusted from now on'));
    assert.equal(lines.length, CORES.length);
    const m = /PV field read ([\d.]+) kWh since \S+ against the inferred lower bound ([\d.]+) kWh \(one SoC step 0\.31 kWh\)/.exec(lines[0]);
    assert.ok(m, lines[0]);
    assert.ok(Number(m[2]) >= BRIDGE_PV_EVIDENCE_STEPS * STEP_WH / 1000 - 0.005, `trusted only after ${BRIDGE_PV_EVIDENCE_STEPS} steps of evidence: ${m[2]}`);
    assert.ok(Number(m[1]) >= Number(m[2]) - STEP_WH / 1000, 'the field read at least the bound less one step');
    assert.equal(dbg.lastRollup?.slots[0].basis, 'measured');
    // Two hours: the early windows inferred (a lower bound, one step either way), the rest the field.
    near(after.pv - before.pv, 3 * 2500 * 2, 3 * STEP_WH + 30, 'PV');
    near(after.chg - before.chg, 3 * 2000 * 2, 3 * STEP_WH + 30, 'battery in = PV − slot output');
    near(after.dsg - before.dsg, 0, 1, 'battery out');
    // The power sensors follow the slots and the field.
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet], [true, 7500, 3 * 500 - 7500]);
    // ★★ The trust is saved: after a restart the power sensors read the field at once.
    p.restart();
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`], 'trust survives the restart');
    const g = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([g.ready, g.fleetPv, g.fleetBatteryNet], [true, 7500, 3 * 500 - 7500]);
  } finally { p.close(); }
});

test('★★★ a panel PV field that reads half the solar (e.g. only the battery-charging share) is never trusted: the inferred basis stays', () => {
  const p = sunnyPlant(Date.parse('2026-10-15T11:00:00-07:00'));
  try {
    p.panelSamples(p.clock);
    const before = p.read();
    const stored = { wh: 0 };
    sunny(p, 120, { outW: 500, pvW: 2500, fieldW: 1250 }, stored);
    const after = p.read();
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, []);
    assert.equal(dbg.lastRollup?.slots[0].basis, 'inferred');
    assert.equal(p.logs.filter((l) => l.includes('the field is not trusted (the inferred basis stays)')).length, CORES.length);
    // The inferred lower bound, not the half-reading field: PV within a step of the truth per slot.
    near(after.pv - before.pv, 3 * 2500 * 2, 3 * STEP_WH + 30, 'PV');
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet], [false, null, null], 'no instantaneous figure without a trusted field');
  } finally { p.close(); }
});

test('★★★ a trusted field that falls below the bound (PV passing through to the house is missing from it) is revoked, logged with both figures', () => {
  const p = sunnyPlant(Date.parse('2026-10-15T10:00:00-07:00'));
  try {
    // Trusted by an earlier day's check (the persisted row a previous process left).
    for (let s = 1; s <= 3; s++) p.putLifetime(bridgePvSeenKey(PANEL, s), 2000, p.clock - 24 * H);
    p.restart();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.trustedSlots.length, 3);
    p.panelSamples(p.clock);
    const stored = { wh: 0 };
    sunny(p, 60, { outW: 500, pvW: 2500, fieldW: 2500 }, stored);
    assert.equal(p.rec.batteryLifetimeDebug().bridge.pvChecks[0].verdict, 'consistent');
    assert.ok(!p.logs.some((l) => l.includes('no longer trusted')));
    // The house draws 1500 W through each Core; the field now reads only the 1000 W into the battery.
    const before = p.read();
    sunny(p, 60, { outW: 1500, pvW: 2500, fieldW: 1000 }, stored);
    const after = p.read();
    const revoked = p.logs.filter((l) => l.includes('the field is no longer trusted (back to the inferred basis)'));
    assert.equal(revoked.length, CORES.length);
    assert.match(revoked[0], /PV field read [\d.]+ kWh since \S+ against the inferred lower bound [\d.]+ kWh \(one SoC step 0\.31 kWh\) — below it by more than one SoC step/);
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, []);
    assert.ok(!p.lifetimeKeys().some((k) => k.startsWith('bridge_pvseen_')), 'the persisted trust is deleted');
    assert.equal(dbg.lastRollup?.slots[0].basis, 'inferred');
    // What the field missed before the revocation is bounded: about a step per slot, not the hour.
    assert.ok(after.pv - before.pv > 3 * 2500 - 3 * 2 * STEP_WH - 60, `PV over the hour ${(after.pv - before.pv).toFixed(0)} Wh`);
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.equal(f.ready, false, 'the power sensors no longer read the field');
  } finally { p.close(); }
});

test('★★★ a night grid charge: battery in rises with the slot inflow, PV production does not; Grid to Battery Charge follows it', () => {
  const p = new Plant(Date.parse('2026-10-15T23:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark([2000, 2000, 2000]);
    p.run(240);
    const after = p.read();
    const expected = 6000 * 4 - 6000 / 60;
    near(after.chg - before.chg, expected, expected * 0.01, 'battery in');
    near(after.pv - before.pv, 0, 1, 'no PV at night');
    near(after.dsg - before.dsg, 0, 1, 'battery out');
    near(after.gridImport - before.gridImport, expected, expected * 0.01, 'the Cores\' AC input, metered at the panel');
  } finally { p.close(); }
});

/* ── the return ──────────────────────────────────────────────────────────── */

for (const [label, jumpWh, bms] of [
  ['under one pack\'s capacity', 3_000, 'the BMS counted 2.00 kWh in / 6.00 kWh out while dark'],
  ['over one pack\'s capacity', 20_000, 'the BMS counted 13.33 kWh in / 40.00 kWh out while dark'],
] as const) {
  test(`★★★ the Cores report again with their counters ${label} ahead: the published totals do not jump, then count on; both return lines state the figures`, () => {
    const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
    try {
      p.establishHeld();
      p.goDark(DISCHARGE_W);
      p.run(120);
      const beforeReturn = p.read();
      const bridgedCores = p.rec.batteryLifetimeDebug().bridge.cores;
      // Back: each pack's discharge register is `jumpWh` ahead, charge a third of it.
      const dMah = jumpWh / PACK_MAH_TO_WH;
      p.coresOnline = true;
      p.regs = { chg: p.regs!.chg + dMah / 3, dsg: p.regs!.dsg + dMah };
      const atReturn = p.read();
      near(atReturn.dsg, beforeReturn.dsg, 1, 'battery out on return (the dark throughput is absorbed)');
      near(atReturn.chg, beforeReturn.chg, 1, 'battery in on return');
      p.run(15);
      const settled = p.read();
      near(settled.dsg, beforeReturn.dsg, 1, 'no jump on the following rollups either');
      // Counting resumes from the held value: +500 mAh per pack, both Cores' packs.
      p.regs = { chg: p.regs.chg, dsg: p.regs.dsg + 500 };
      p.run(5);
      const resumed = p.read();
      near(resumed.dsg - settled.dsg, CORES.length * PACKS * 500 * PACK_MAH_TO_WH, 0.01, 'live counting resumed');
      const dbg = p.rec.batteryLifetimeDebug().bridge;
      assert.deepEqual(dbg.markers, [], 'every marker cleared');
      assert.deepEqual(dbg.cores, {}, 'the per-Core accumulators are cleared once handed over and logged');
      const lines = p.logs.filter((l) => l.includes('energy-bridge hand-over'));
      assert.equal(lines.length, CORES.length, 'one hand-over line per Core');
      for (const sn of CORES) {
        const b = bridgedCores[sn];
        assert.ok(b && b.dischargeWh > 2_000, `${sn} was bridged: ${JSON.stringify(b)}`);
        const panelFig = `${(b.chargeWh / 1000).toFixed(2)} kWh in / ${(b.dischargeWh / 1000).toFixed(2)} kWh out`;
        const hand = lines.find((l) => l.includes(`sn=${sn}:`));
        assert.ok(hand, sn);
        // The figures the statistics repair reads: what the BMS counted while dark, and what the bridge published.
        assert.ok(hand.includes(`re-baselined on return — ${bms} (absorbed, not published)`), hand);
        assert.ok(hand.includes(`the panel bridge counted ${panelFig} (AC basis at the slot, or the Core's own pack meters where the slot could not be read; already published)`), hand);
        // ★★ The "no longer bridged" line follows the hand-over (a read ran it first) and still has them.
        const gone = p.logs.find((l) => l.includes(`Core ${sn} is no longer bridged`));
        assert.ok(gone, sn);
        assert.ok(gone.endsWith(`— bridged ${panelFig} while dark`), gone);
      }
    } finally { p.close(); }
  });
}

test('★★ the first pass after the return is a rollup: the "no longer bridged" line comes first, with the same figures as the hand-over line', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(60);
    const before = p.read();
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 9_000, dsg: p.regs!.dsg + 27_000 };
    p.clock += MIN;
    p.rec.rollupLifetime();
    near(p.read().dsg, before.dsg, 1, 'absorbed');
    for (const sn of CORES) {
      const gone = p.logs.findIndex((l) => l.includes(`Core ${sn} is no longer bridged`));
      const hand = p.logs.findIndex((l) => l.includes(`hand-over sn=${sn}:`));
      assert.ok(gone >= 0 && hand > gone, `${sn}: ${gone} then ${hand}`);
      const fig = /bridged ([\d.]+ kWh in \/ [\d.]+ kWh out) while dark/.exec(p.logs[gone])![1];
      assert.ok(p.logs[hand].includes(`the panel bridge counted ${fig}`), p.logs[hand]);
      assert.ok(!fig.startsWith('0.00 kWh in / 0.00'), fig);
    }
    p.run(5);
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.cores, {}, 'cleared at the next rollup');
  } finally { p.close(); }
});

test('★★★ after the hand-over and a restart no marker row is left: the next movement is counted, not absorbed again', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 9_000, dsg: p.regs!.dsg + 27_000 };
    p.read();
    p.run(10);
    assert.equal(p.logs.filter((l) => l.includes('energy-bridge hand-over')).length, CORES.length);
    p.restart();
    assert.deepEqual(p.lifetimeKeys().filter((k) => k.startsWith('bridge_dark_')), [], 'the marker rows went with the markers');
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.markers, []);
    const before = p.read();
    p.regs = { chg: p.regs.chg, dsg: p.regs.dsg + 500 };
    p.run(5);
    near(p.read().dsg - before.dsg, CORES.length * PACKS * 500 * PACK_MAH_TO_WH, 0.01, 'counted');
    assert.equal(p.logs.filter((l) => l.includes('energy-bridge hand-over')).length, CORES.length, 'no second hand-over');
  } finally { p.close(); }
});

test('★★★ an online flip before the first fresh quota does not spend the marker: the jump is still absorbed when it lands', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const before = p.read();
    p.coresOnline = true; // online, the projection still the frozen one (registers = held)
    p.run(5);
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'markers kept');
    p.regs = { chg: p.regs!.chg + 10_000, dsg: p.regs!.dsg + 30_000 }; // the fresh quota
    const after = p.read();
    near(after.dsg, before.dsg, 1, 'absorbed');
  } finally { p.close(); }
});

type Regs = { chg: number; dsg: number };
const copyRegs = (p: InstanceType<typeof Plant>): Record<string, Regs> =>
  Object.fromEntries(CORES.map((sn) => [sn, { ...p.trueRegs[sn] }]));
/** Night, every Core discharging into its slot (the 10-15 shape), the BMS registers moving with it. */
function dischargingNight(): { p: InstanceType<typeof Plant>; before: ReturnType<InstanceType<typeof Plant>['read']>; atDark: Record<string, Regs> } {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  p.establishHeld();
  p.coreBatW = DISCHARGE_W.map((w) => -w);
  p.run(5);
  const before = p.read();
  const atDark = copyRegs(p);
  p.goDark(DISCHARGE_W);
  return { p, before, atDark };
}
const TRUE_4H = 3409 * 4;

test('★★★ MQTT battery data still arriving after the Cores are listed offline is their own reading: the BMS counts it and the bridge stays off; once it stops the bridge meters the slot, and the return counts the dark span once', () => {
  const { p, before } = dischargingNight();
  try {
    // The store translates DPU battery data whatever the online flag: 10 min of it after the
    // offline flag, past the dwell. Its content changes after the flip: a reading of its own.
    p.run(10, () => p.mqttWhileOffline());
    const mid = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(mid.markers, [], 'not dark: no marker');
    assert.equal(mid.dischargeWh, 0, 'nothing bridged');
    assert.deepEqual(mid.lastRollup?.slots, [], 'no dark slot');
    near(p.read().dsg - before.dsg, 3409 * 9 / 60, 3409 / 60 + 1, 'the BMS counted what the MQTT data carried');
    // What the last MQTT data carried: the BMS has counted up to it.
    const atStop: Record<string, Regs> = Object.fromEntries(CORES.map((sn) => [sn, { ...p.shown[sn] }]));
    const stopAt = CORES.map((sn) => p.contentAt[sn]);
    p.run(230);
    const dark = p.rec.batteryLifetimeDebug().bridge;
    assert.equal(dark.markers.length, CORES.length * PACKS, 'its data stopped: bridged, every held pack marked');
    assert.deepEqual(dark.offlineSince.map((o) => o.sinceMs), stopAt, 'dark from its last own reading, not from the earlier offline flip');
    // Online again before any fresh data: the projection is still the one MQTT left.
    p.setOnline(true, CORES, p.clock, false);
    p.clock += 30_000;
    p.read();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'the flip does not spend the markers');
    p.clock += 30_000;
    p.land();
    const after = p.read();
    near(after.dsg - before.dsg, TRUE_4H, TRUE_4H * 0.01, 'battery out over the 4 h: the BMS while MQTT carried it, then the bridge — never both');
    near(after.chg - before.chg, 0, 1, 'battery in');
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.markers, []);
    assert.ok(!p.lifetimeKeys().some((k) => k.startsWith('bridge_absorbed_')), 'nothing absorbed before the return');
    // The hand-over line states what the BMS counted while dark: from the last MQTT data on.
    CORES.forEach((sn) => {
      const line = p.logs.find((l) => l.includes(`hand-over sn=${sn}:`));
      assert.ok(line, sn);
      const m = /the BMS counted ([\d.]+) kWh in \/ ([\d.]+) kWh out while dark/.exec(line)!;
      const dsgKwh = (p.trueRegs[sn].dsg - atStop[sn].dsg) * PACKS * PACK_MAH_TO_WH / 1000;
      near(Number(m[2]), dsgKwh, 0.015, `${sn} BMS discharge while dark (kWh)`);
      near(Number(m[1]), 0, 0.005, `${sn} BMS charge while dark (kWh)`);
    });
  } finally { p.close(); }
});

test('★★★ a reconnect burst of queued MQTT data from early in the dark span, just before the online flip, is not the return: the marker waits for data after the flip', () => {
  const { p, before } = dischargingNight();
  try {
    let early: Record<string, Regs> = {};
    p.run(240, (_t, m) => { if (m === 20) early = copyRegs(p); });
    // The Cores reconnect: the broker delivers battery data queued 20 min into the outage, and
    // seconds later the cloud lists them online. No read runs in between.
    p.mqttWhileOffline(CORES, early);
    p.clock += 5_000;
    p.setOnline(true, CORES, p.clock, false);
    p.clock += 10_000;
    p.read();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'not spent on data from before the flip');
    p.clock += 20_000;
    p.land();
    near(p.read().dsg - before.dsg, TRUE_4H, TRUE_4H * 0.01, 'battery out: the dark span once');
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.markers, []);
  } finally { p.close(); }
});

test('★★★ a content change without pack data right after the online flip: what MQTT moved while the Cores were listed offline was absorbed then, so the markers wait for the real jump', () => {
  const { p, before } = dischargingNight();
  try {
    // Bridged first (every pack marked), then 10 min of MQTT battery data while still listed offline.
    p.run(30);
    p.run(10, () => p.mqttWhileOffline());
    p.run(200);
    p.setOnline(true, CORES, p.clock, false);
    p.clock += 5_000;
    p.touch(); // e.g. an output-power message: the content witness moves, the packs' registers do not
    p.clock += 25_000;
    p.read();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'nothing moved since the return');
    p.clock += 30_000;
    p.land();
    near(p.read().dsg - before.dsg, TRUE_4H, TRUE_4H * 0.01, 'battery out: the dark span once');
    assert.equal(p.logs.filter((l) => l.includes('energy-bridge hand-over')).length, CORES.length);
  } finally { p.close(); }
});

test('★★★ after a restart a Core listed online at first sight hands over only once its content changes: a first body that replays one from the dark span does not spend the marker', () => {
  const { p, before } = dischargingNight();
  try {
    let early: Record<string, Regs> = {};
    p.run(120, (_t, m) => { if (m === 30) early = copyRegs(p); });
    const bridged = p.read();
    // The add-on restarts while the Cores come back: online at first sight (no transition time, the
    // content witness only seeded), the cloud's first body a cached one from 30 min into the outage.
    p.restart();
    for (const sn of CORES) { p.online[sn] = true; p.shown[sn] = { ...early[sn] }; }
    p.clock += 30_000;
    near(p.read().dsg, bridged.dsg, 60, 'absorbed (the final rollup at the stop may add its minute)');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'kept: no content change seen yet');
    p.clock += 30_000;
    p.land(); // the Cores stream: their content changes, with their current registers
    const after = p.read();
    near(after.dsg, bridged.dsg, 60, 'the rest of the dark span is absorbed too');
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.markers, []);
    near(after.dsg - before.dsg, 3409 * 2, 3409 * 2 * 0.02, 'battery out: the two bridged hours');
  } finally { p.close(); }
});

/* ── the install site ───────────────────────────────────────────────────── */

test('★★★ the day/night test is judged at the configured site: 10:00 in Berlin is daylight (the solar the Cores pass on is PV, not battery out); 23:00 there is night for the power sensors', async () => {
  const { config } = await import('../src/config.js');
  const saved = [config.forecastLat, config.forecastLon];
  config.forecastLat = 52.52;
  config.forecastLon = 13.405;
  const t0 = Date.parse('2026-10-15T10:00:00+02:00'); // 01:00 in Phoenix
  const p = new Plant(t0);
  try {
    for (const sn of CORES) for (let k = 1; k <= 5; k++) p.sample(sn, `pack${k}_full_cap_mah`, FULL_CAP_MAH, t0 - H);
    p.darkAtFirstSight();
    p.frozenProjection = false;
    p.sourceWatts = [-300, -300, -300];
    p.pct = [40, 40, 40];
    p.panelSamples(t0);
    const before = p.read();
    p.run(120, (_t, m) => { p.pct = CORES.map(() => 40 + Math.floor(m / 8)); });
    const after = p.read();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.lastRollup?.slots[0].basis, 'inferred');
    assert.ok(after.pv - before.pv > 3 * 300 * 2, `solar booked: ${(after.pv - before.pv).toFixed(0)} Wh`);
    near(after.dsg - before.dsg, 0, 1, 'the 300 W the Cores supplied came from PV, not the battery');
    // 23:00 in Berlin is 14:00 in Phoenix.
    p.clock = Date.parse('2026-10-15T23:00:00+02:00');
    p.sourceWatts = [-1000, -1000, -1000];
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet], [true, 0, 3000]);
  } finally {
    p.close();
    config.forecastLat = saved[0];
    config.forecastLon = saved[1];
  }
});

/* ── restarts ───────────────────────────────────────────────────────────── */

test('★★★ a restart mid-outage: the bridged totals, the markers and the watermark persist; nothing steps down; the return is absorbed', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(60);
    const beforeRestart = p.read();
    p.frozenProjection = false; // after the restart the dark Cores have no projection (the live case)
    p.restart();
    const afterRestart = p.read();
    near(afterRestart.dsg, beforeRestart.dsg, 60, 'no step at the restart (the final rollup may add its minute)');
    p.run(60);
    const afterHour = p.read();
    near(afterHour.dsg - afterRestart.dsg, 3409, 3409 * 0.02, 'the bridge carries on after the restart');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS, 'markers survived the restart');
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 9_000, dsg: p.regs!.dsg + 27_000 };
    const atReturn = p.read();
    near(atReturn.dsg, afterHour.dsg, 1, 'absorbed after a restart too');
  } finally { p.close(); }
});

test('★★★ the Cores come back while the add-on is down: the persisted markers absorb the jump at the first read after boot', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const beforeRestart = p.read();
    // Down for 20 minutes; the Cores return in that window with their dark-span jump.
    p.rec.close();
    p.db.close();
    p.clock += 20 * MIN;
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 9_000, dsg: p.regs!.dsg + 27_000 };
    p.open();
    near(p.read().dsg, beforeRestart.dsg, 60, 'no jump at the first read after boot (no bridge rollup has run yet)');
  } finally { p.close(); }
});

test('★★★ a restart across dusk: the first window after boot spans at most 15 min, so it is judged on the part the samples cover (night)', () => {
  const p = new Plant(Date.parse('2026-10-15T16:00:00-07:00'));
  try {
    p.darkAtFirstSight();
    p.frozenProjection = false;
    p.sourceWatts = [-1000, -1000, -1000];
    p.run(60);
    // Stopped at 17:00 (sun up), started at 19:00 (dark).
    p.rec.close();
    p.db.close();
    p.clock += 2 * H;
    p.open();
    const before = p.read();
    p.run(5);
    const r = p.rec.batteryLifetimeDebug().bridge.lastRollup!;
    assert.ok(r.untilMs - r.sinceMs <= BRIDGE_MAX_WINDOW_MS, `window ${(r.untilMs - r.sinceMs) / MIN} min`);
    assert.equal(r.slots[0].basis, 'night');
    // Samples from 19:01: four minutes of 3 kW out of the slots.
    near(p.read().dsg - before.dsg, 3000 * 4 / 60, 5, 'battery out on the night basis');
  } finally { p.close(); }
});

test('★★★ more than the v1.98.0 re-seed gap bridged: the floor is not involved, so nothing steps down', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.run(180); // ≈ 10 kWh bridged against a 5 kWh re-seed gap; every read asserted non-decreasing
    const after = p.read();
    assert.ok(after.dsg - before.dsg > 9_500, `bridged ${(after.dsg - before.dsg).toFixed(0)} Wh`);
    assert.ok(!p.logs.some((l) => l.includes('v1.98.0 lifetime battery floor sat')), 'the floor-gap re-seed never fired');
  } finally { p.close(); }
});

/* ── what is not bridged ─────────────────────────────────────────────────── */

test('★★ a stale panel bridges nothing', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.panelStale = true;
    p.run(60);
    const after = p.read();
    near(after.dsg - before.dsg, 0, 1, 'battery out');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.lastRollup?.slots[0].reason, 'the panel reading is not fresh');
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.fleetBatteryNet], [false, null]);
  } finally { p.close(); }
});

test('★★ no double count: a dark Core\'s held pv_total rows are not integrated beside the bridge', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    const before = p.read();
    p.goDark(DISCHARGE_W);
    // The held sample a frozen projection re-records every 5 minutes (the recorder's heartbeat).
    p.run(60, (t, m) => { if (m % 5 === 0) for (const sn of CORES) { p.sample(sn, 'pv_total', 3000, t); p.sample(sn, 'ac_in', 900, t); } });
    const after = p.read();
    near(after.pv - before.pv, 0, 1, 'PV: night, and the held 3 kW is not a reading');
    near(after.gridImport - before.gridImport, 0, 1, 'the held ac_in is not a reading either');
  } finally { p.close(); }
});

test('★★ the read-only debug pass writes nothing, and reports the held value for a returned, marked pack', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const before = p.read();
    p.coresOnline = true;
    p.regs = { chg: p.regs!.chg + 10_000, dsg: p.regs!.dsg + 30_000 };
    const rowsBefore = p.rows();
    const dbg = p.rec.batteryLifetimeDebug();
    assert.equal(p.rows(), rowsBefore, 'the lifetime table is byte-identical');
    near(dbg.emittedDischargeWh, before.dsg, 1, 'debug reports held + bridged');
    assert.equal(dbg.bridge.markers.length, CORES.length * PACKS, 'the markers are untouched');
    near(p.read().dsg, before.dsg, 1, 'and the first mutating pass then absorbs the jump');
  } finally { p.close(); }
});

test('★★ the power sensors at night follow the slots while bridged; the readiness verdict follows the bridge', async () => {
  const { publishReadiness } = await import('../src/publishReadiness.js');
  const p = new Plant(Date.parse('2026-10-16T20:15:00-07:00'));
  try {
    p.darkAtFirstSight();
    p.frozenProjection = false;
    p.sourceWatts = [-627, -623, -625];
    const devices = p.store.get().devices;
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, devices, p.clock);
    assert.deepEqual([f.ready, f.fleetPv, f.fleetBatteryNet, f.bridgedSlots], [true, 0, 1875, 3]);
    const base = {
      devices, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: null, runway: null, clipping: null,
      curtailment: null, carbon: null, tariff: null, degradation: null, nowMs: p.clock,
    };
    const r = publishReadiness({ ...base, flowBridge: f });
    assert.equal(r.flow, false, 'no online home Core: the Cores\' own in/out/ac-import sums stay withheld');
    assert.equal(r.flowBridged, true, 'Fleet PV and Battery Net publish');
    assert.equal(publishReadiness({ ...base, flowBridge: { bridgedSlots: 3, ready: false } }).flowBridged, false);
    assert.equal(publishReadiness(base).flowBridged, false, 'without a bridged flow it reads as flow');
  } finally { p.close(); }
});

/* ── v1.188.1 review: a Core with no reading of its OWN is dark, whatever its online flag ───────── */

const TRUE_W = 3409;
const markerCount = (p: InstanceType<typeof Plant>): number => p.rec.batteryLifetimeDebug().bridge.markers.length;

test('★★★ the Cores listed online again on a FROZEN meter (their quota failing, no fresh body) stay dark: the bridge books that hour, and the hand-over absorbs only what it booked', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.run(5);
    const before = p.read();
    p.goDark(DISCHARGE_W);
    p.run(240);
    const atReturn = p.read();
    // Listed online; the quota keeps failing (setDeviceError): the projection is the held one.
    for (const sn of CORES) p.frozen.add(sn);
    p.setOnline(true, CORES, p.clock, false);
    p.run(60);
    const afterHour = p.read();
    near(afterHour.dsg - atReturn.dsg, TRUE_W, TRUE_W * 0.02, 'the hour listed online with no reading of their own is bridged (it booked nothing)');
    assert.equal(markerCount(p), CORES.length * PACKS, 'not handed back: no reading of their own since the return');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.lastRollup?.slots.length, CORES.length, 'every slot metered');
    // The first fresh body: the BMS jump (the dark span and the hour) lands and is absorbed at the
    // next read (the publishers read every 30 s).
    p.frozen.clear();
    p.land();
    p.read();
    p.run(10);
    const end = p.read();
    const trueWh = TRUE_W * 310 / 60;
    near(end.dsg - before.dsg, trueWh, trueWh * 0.01, 'battery out: every hour once, none twice');
    assert.equal(markerCount(p), 0);
    assert.equal(p.logs.filter((l) => l.includes('energy-bridge hand-over')).length, CORES.length);
  } finally { p.close(); }
});

test('★★★ the live path: a restart while dark, then the Cores listed online with no projection (the first quota 30 min late) — the half hour is bridged', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.run(5);
    p.goDark(DISCHARGE_W);
    p.run(60);
    p.restart(); // the deploy: the store sees every Core afresh
    p.frozenProjection = false; // no quota is fetched for a device listed offline
    p.run(60);
    const atReturn = p.read();
    for (const sn of CORES) { p.frozen.add(sn); p.unprojected.add(sn); }
    p.setOnline(true, CORES, p.clock, false); // /status: online, the quota not answering yet
    p.run(30);
    const afterHalf = p.read();
    near(afterHalf.dsg - atReturn.dsg, TRUE_W / 2, TRUE_W / 2 * 0.02, 'online with no projection is not a reading: the slots are metered');
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.bridgedSlots, f.fleetBatteryNet], [true, 3, TRUE_W], 'Battery Net: every slot, not a partial sum');
    p.unprojected.clear();
    p.frozen.clear();
    p.land(); // the first quota
    p.read();
    p.run(10);
    const end = p.read();
    near(end.dsg - afterHalf.dsg, TRUE_W / 6, TRUE_W / 6 * 0.05, 'after the hand-over the BMS counts; the jump is absorbed, not added');
    assert.equal(markerCount(p), 0);
  } finally { p.close(); }
});

test('★★★ daylight, no outage, the Cores listed online with their quota failing for 2 h: PV and the charge are metered at the slots, and recovery lands no lump', () => {
  const t0 = Date.parse('2026-10-15T10:00:00-07:00');
  const p = new Plant(t0);
  try {
    p.establishHeld();
    p.corePv = [2500, 2500, 2500];
    p.coreBatW = [-2000, -2000, -2000]; // charging 2 kW each from PV; 500 W each crosses to the panel
    p.sourceWatts = [-500, -500, -500];
    p.run(10);
    const before = p.read();
    for (const sn of CORES) p.frozen.add(sn);
    const stored = { wh: 0 };
    const STEP = NAMEPLATE_WH / 100;
    p.run(120, () => {
      stored.wh += 2000 / 60;
      p.pct = CORES.map(() => 60 + Math.floor(stored.wh / STEP));
    });
    const after = p.read();
    near(after.pv - before.pv, 3 * 2500 * 2, 3 * STEP + 3 * 2500 / 12, 'PV production: the inferred lower bound from the slots, not the 10-min tail of the last row');
    near(after.chg - before.chg, 3 * 2000 * 2, 3 * STEP + 3 * 2000 / 12, 'battery in: booked as it happened');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.lastRollup?.slots[0].basis, 'inferred');
    for (const sn of CORES) p.frozen.delete(sn);
    p.land();
    p.read();
    p.run(10);
    const end = p.read();
    near(end.chg - after.chg, 3 * 2000 * 10 / 60, 3 * 2000 / 60 * 2, 'the 12 kWh register jump is absorbed, not landed as one lump');
  } finally { p.close(); }
});

test('★★ a marked Core whose own MQTT data comes back while the cloud still lists it offline, the panel reading not fresh: its measured PV counts, not nothing', () => {
  const p = new Plant(Date.parse('2026-10-15T10:00:00-07:00'));
  try {
    p.establishHeld();
    p.corePv = [2500, 2500, 2500];
    p.run(10);
    p.goDark([-500, -500, -500]);
    p.run(30, (_t, m) => { p.pct = CORES.map(() => 60 + Math.floor(m / 10)); });
    assert.equal(markerCount(p), CORES.length * PACKS, 'bridged: every held pack marked');
    const before = p.read();
    p.panelStale = true;
    // Each minute a content change (its MQTT stream) and the pv_total row the gate writes for it.
    p.run(60, (t) => { for (const sn of CORES) { p.touch([sn]); p.sample(sn, 'pv_total', 2500, t); } });
    const after = p.read();
    const last = p.rec.batteryLifetimeDebug().bridge.lastRollup;
    assert.equal(last?.slots[0].reason, 'the panel reading is not fresh');
    near(after.pv - before.pv, 3 * 2500, 3 * 2500 * 0.05, 'the Cores\' own pv_total rows count where the bridge booked nothing');
  } finally { p.close(); }
});

test('★★ a Core whose cloud replays its cached body while listed online is dark once its content clock is stale: its replayed PV is not integrated', () => {
  const p = new Plant(Date.parse('2026-10-15T11:00:00-07:00'));
  try {
    p.establishHeld();
    p.corePv = [2600, 0, 0];
    p.sourceWatts = [-1100, -600, -600];
    p.run(10);
    const before = p.read();
    p.replay.add(CORES[0]);
    p.run(90, () => { p.corePv = [2600, 0, 0]; });
    const after = p.read();
    const own = p.rec.query(CORES[0], 'pv_total', p.clock - 84 * MIN, p.clock).length;
    assert.equal(own, 0, 'the gate wrote nothing past its window');
    const slots = p.rec.batteryLifetimeDebug().bridge.lastRollup?.slots ?? [];
    assert.deepEqual(slots.map((s) => s.sn), [CORES[0]], 'the replaying Core is metered at its slot');
    assert.ok(after.pv - before.pv < 2600 * 90 / 60 * 0.5, `no phantom solar from the replay: ${(after.pv - before.pv).toFixed(0)} Wh`);
  } finally { p.close(); }
});

test('★★★ a bridged Core whose MQTT battery data resumes while the cloud still lists it offline stays dark until it hands back: the bridge keeps metering its slot, the data is absorbed, battery out counts once', () => {
  const { p, before, atDark } = dischargingNight();
  const darkAt = p.clock;
  try {
    p.run(60);
    assert.equal(markerCount(p), CORES.length * PACKS, 'bridged, every pack marked');
    const mid = p.read();
    // The Cores' MQTT stream comes back (their content changes after the flip); the cloud still
    // lists them offline, so they have not reported since a return.
    p.run(30, () => p.mqttWhileOffline());
    const after = p.read();
    near(after.dsg - mid.dsg, TRUE_W / 2, TRUE_W / 2 * 0.02, 'the half hour: the bridge, once (the movement absorbed)');
    assert.equal(markerCount(p), CORES.length * PACKS, 'not handed back while listed offline');
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.offlineSince.map((o) => o.sinceMs), CORES.map(() => darkAt), 'the dark span keeps the instant it began');
    assert.equal(dbg.absorbed.length, CORES.length * PACKS, 'the movement is absorbed as it arrives, the markers kept');
    assert.ok(p.lifetimeKeys().some((k) => k.startsWith('bridge_absorbed_')), 'and persisted for the hand-over line');
    p.setOnline(true, CORES, p.clock, false);
    p.clock += 30_000;
    p.land();
    const end = p.read();
    near(end.dsg - before.dsg, TRUE_W * 1.5, TRUE_W * 1.5 * 0.01, 'battery out over the 90 dark minutes, once');
    assert.equal(markerCount(p), 0);
    assert.ok(!p.lifetimeKeys().some((k) => k.startsWith('bridge_absorbed_')), 'the absorbed rows go with the markers');
    // The hand-over line states everything the BMS counted while dark, the part absorbed before the return included.
    CORES.forEach((sn) => {
      const line = p.logs.find((l) => l.includes(`hand-over sn=${sn}:`));
      assert.ok(line, sn);
      const m = /the BMS counted ([\d.]+) kWh in \/ ([\d.]+) kWh out while dark/.exec(line)!;
      const dsgKwh = (p.trueRegs[sn].dsg - atDark[sn].dsg) * PACKS * PACK_MAH_TO_WH / 1000;
      near(Number(m[2]), dsgKwh, 0.015, `${sn} BMS discharge while dark (kWh)`);
    });
  } finally { p.close(); }
});

test('★★★ after a restart a Core listed online whose quota keeps failing (it never reports) is bridged once the dwell from its first sight has passed — not at once, so a live Core reporting seconds later never is', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.sourceWatts = DISCHARGE_W;
    p.run(5);
    p.restart();
    for (const sn of CORES) p.frozen.add(sn); // listed online, no content after the restart
    const atRestart = p.read();
    p.run(2);
    const inDwell = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([inDwell.ready, inDwell.bridgedSlots, [...inDwell.pending].sort()], [false, 0, [...CORES].sort()], 'inside the dwell from first sight: withheld, not bridged');
    assert.equal(markerCount(p), 0);
    p.run(30); // rollups at +7 … +32 min
    const after = p.read();
    near(after.dsg - atRestart.dsg, TRUE_W * 32 / 60, TRUE_W * 32 / 60 * 0.02, 'bridged from its first sight once the dwell passed');
    const f = p.rec.bridgedFleetFlow({ fleetPv: 0, fleetBatteryNet: 0 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.bridgedSlots, f.fleetBatteryNet], [true, 3, TRUE_W]);
  } finally { p.close(); }
});

test('★★ a frozen Core whose pack registers move without its readings changing (BMS data alone) is not handed back: the movement is absorbed while the bridge meters it', () => {
  const p = new Plant(Date.parse('2026-10-15T00:00:00-07:00'));
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.sourceWatts = DISCHARGE_W;
    p.run(5);
    for (const sn of CORES) p.frozen.add(sn); // listed online, its readings stop
    p.run(30);
    assert.equal(markerCount(p), CORES.length * PACKS, 'bridged');
    const before = p.read();
    p.run(30, () => { for (const sn of CORES) p.shown[sn] = { ...p.trueRegs[sn] }; }, { readEach: true });
    const after = p.read();
    near(after.dsg - before.dsg, TRUE_W / 2, TRUE_W / 2 * 0.03, 'the half hour once: the bridge; the register movement absorbed, never counted beside it');
    assert.equal(markerCount(p), CORES.length * PACKS, 'not handed back: no reading of its own');
  } finally { p.close(); }
});
