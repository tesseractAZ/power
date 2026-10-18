/**
 * v1.188.1 (review round 2) — the energy bridge at its seams with the BMS counters, driven through
 * the REAL recorder (test/helpers/energyBridgePlant.ts):
 *  1. a marked Core the cloud still lists offline whose own MQTT data is back, its slot unreadable
 *     (the panel reading not fresh): its PV counted from its own rows, and its battery energy was
 *     absorbed and booked by nobody. Its own pack meters now count for those windows;
 *  2. a held row of a pack the Core no longer reports (a pack moved or replaced) got a hand-over
 *     marker that was never spent: the Core stayed "marked" for good, bridged at once on a 6 s
 *     /status blip with no dwell, its whole rollup window booked at the slot beside the BMS;
 *  3. after a CRASH (no final rollup) followed by 11 min or more of downtime, the bridge's 15-min
 *     window clamp dropped the slot rows written between the last rollup and the crash, while
 *     Panel Load booked the same minutes;
 *  4. one rollup with a dark Core's slot reading isConnect = 0 re-seeded the lifetime battery floors
 *     without that Core's held packs (~1/3 of each counter: Home Assistant's meter reset), and the
 *     next re-seeded them back up.
 * Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPlant, near, MIN, PANEL, CORES, PACKS, PACK_MAH_TO_WH, DISCHARGE_W,
} from './helpers/energyBridgePlant.js';

const { Plant, cleanup } = await loadPlant('ef-bridge-seams-');
test.after(cleanup);

type P = InstanceType<typeof Plant>;
type Regs = { chg: number; dsg: number };
const NIGHT = Date.parse('2026-10-15T00:00:00-07:00');
const TRUE_W = 3409;
const copyRegs = (p: P): Record<string, Regs> => Object.fromEntries(CORES.map((sn) => [sn, { ...(p.trueRegs[sn] ?? p.regs!) }]));
/** What the Cores' BMS measured out between two register snapshots (Wh). */
const bmsDsgWh = (a: Record<string, Regs>, b: Record<string, Regs>): number =>
  CORES.reduce((s, sn) => s + (b[sn].dsg - a[sn].dsg) * PACKS * PACK_MAH_TO_WH, 0);
const markers = (p: P): string[] => p.rec.batteryLifetimeDebug().bridge.markers;

/* ══ 1. a marked Core's own readings where its slot cannot be read ═══════════════ */

test('★★★ a marked Core listed offline, its MQTT data back, the panel reading not fresh for an hour: its battery out counts from its own pack meters, not nothing — and the return counts the two hours once', () => {
  const p = new Plant(NIGHT);
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.run(5);
    const before = p.read();
    const atDark = copyRegs(p);
    p.goDark(DISCHARGE_W);
    p.run(60);
    assert.equal(markers(p).length, CORES.length * PACKS, 'precondition: bridged, every pack marked');
    const h1 = p.read();
    const r1 = copyRegs(p);
    // The panel's reading goes stale (no slot rows); the Cores' MQTT stream is back while the cloud
    // still lists them offline: their registers move and the gate writes their own rows.
    p.panelStale = true;
    p.run(60, (t) => { p.mqttWhileOffline(); for (const sn of CORES) p.ownRows(sn, t); });
    const h2 = p.read();
    const r2 = copyRegs(p);
    const last = p.rec.batteryLifetimeDebug().bridge.lastRollup;
    assert.equal(last?.slots[0].basis, 'unbridgeable', 'precondition: the bridge books nothing at the slot');
    assert.equal(last?.slots[0].own, true, 'the Core’s own readings stand in');
    assert.equal(markers(p).length, CORES.length * PACKS, 'not handed back while listed offline');
    // Before: the hour's 3.4 kWh were absorbed and published by nobody (+0 Wh).
    near(h2.dsg - h1.dsg, bmsDsgWh(r1, r2), bmsDsgWh(r1, r2) * 0.03, 'hour 2: battery out published against what the BMS measured');
    near(h2.chg - h1.chg, 0, 1, 'hour 2: no battery in');
    // The return: listed online, the true registers land; the jump is absorbed.
    p.panelStale = false;
    p.setOnline(true, CORES, p.clock, false);
    p.clock += 30_000;
    p.land();
    p.read();
    p.run(5);
    const end = p.read();
    assert.equal(markers(p).length, 0, 'handed back');
    near(end.dsg - before.dsg, bmsDsgWh(atDark, copyRegs(p)), TRUE_W * 2 * 0.03, 'the whole span, once');
  } finally { p.close(); }
});

/* ══ 2. a marker for a pack the Core no longer reports ═══════════════════════════ */

test('★★★ a pack replaced while the Core reports leaves its old row: the dark span marks only the packs the Core carries, and the return spends every marker', () => {
  const p = new Plant(NIGHT);
  try {
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.sourceWatts = [...DISCHARGE_W];
    let swapped = false;
    const orig = p.devices.bind(p);
    p.devices = () => {
      const d = orig();
      if (swapped) { const pk = d[CORES[0]].projection?.packs?.[1]; if (pk) pk.packSn = `${CORES[0]}-PNEW`; }
      return d;
    };
    p.rec.rollupLifetime();
    p.run(10);
    swapped = true; // pack 2 of Core 1 is replaced
    p.run(10);
    assert.ok(p.lifetimeKeys().includes(`pack_lastwhid_${CORES[0]}:${CORES[0]}-P2_chg`), 'precondition: the old pack’s row stays');
    p.setOnline(false, CORES, p.clock);
    p.run(60);
    assert.equal(markers(p).length, CORES.length * PACKS, 'the packs each Core carries, not the old row');
    assert.ok(!markers(p).includes(`${CORES[0]}:${CORES[0]}-P2`));
    p.setOnline(true, CORES, p.clock);
    p.run(30);
    assert.deepEqual(markers(p), [], 'every marker spent');
    assert.deepEqual(Object.keys(p.rec.batteryLifetimeDebug().bridge.cores), [], 'and the per-Core rows cleared');
  } finally { p.close(); }
});

test('★★★ dark since a restart (no projection, every held row marked, a stale one among them): the return with the whole pack list spends the stale marker too, logged', () => {
  const p = new Plant(NIGHT);
  try {
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.sourceWatts = [...DISCHARGE_W];
    p.rec.rollupLifetime();
    p.run(10);
    // A row a pack Core 1 no longer carries left (moved or replaced long ago).
    p.putLifetime(`pack_lastwhid_${CORES[0]}:${CORES[0]}-POLD_chg`, 1000, NIGHT - 86_400_000);
    p.putLifetime(`pack_lastwhid_${CORES[0]}:${CORES[0]}-POLD_dsg`, 1000, NIGHT - 86_400_000);
    // The add-on restarts while the Cores are dark: no projection (none is fetched for a device listed offline).
    p.setOnline(false, CORES, p.clock);
    p.frozenProjection = false;
    p.crash();
    p.run(30);
    assert.ok(markers(p).includes(`${CORES[0]}:${CORES[0]}-POLD`), 'precondition: with no projection every held row is marked');
    p.frozenProjection = true;
    p.setOnline(true, CORES, p.clock);
    p.run(15);
    assert.deepEqual(markers(p), [], 'the stale marker is spent with the others');
    assert.ok(p.logs.some((l) => l.includes(`hand-over sn=${CORES[0]}: 1 marker(s) spent for pack(s) the Core no longer reports (${CORES[0]}:${CORES[0]}-POLD)`)), 'logged');
  } finally { p.close(); }
});

test('★★ a Core whose pack list is not complete keeps a marker for a pack it has not reported yet (its jump is still to come)', () => {
  const p = new Plant(NIGHT);
  try {
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.sourceWatts = [...DISCHARGE_W];
    p.rec.rollupLifetime();
    p.run(10);
    p.setOnline(false, CORES, p.clock);
    p.run(30);
    // Core 1 comes back showing one of its two packs (its pack count says two).
    const orig = p.devices.bind(p);
    p.devices = () => { const d = orig(); d[CORES[0]].projection.packs = d[CORES[0]].projection.packs.slice(0, 1); return d; };
    p.setOnline(true, CORES, p.clock);
    p.run(10);
    assert.deepEqual(markers(p), [`${CORES[0]}:${CORES[0]}-P2`], 'the absent pack keeps its marker');
  } finally { p.close(); }
});

test('★★★ after the return, a 6 s /status blip on a Core whose packs were replaced is not bridged at once: the dwell holds, nothing is counted twice', () => {
  const p = new Plant(NIGHT);
  const BAT_W = DISCHARGE_W.map((w) => -w);
  try {
    p.coreBatW = [...BAT_W];
    p.sourceWatts = [...DISCHARGE_W];
    p.putLifetime(`pack_lastwhid_${CORES[0]}:${CORES[0]}-POLD_chg`, 1000, NIGHT - 86_400_000);
    p.putLifetime(`pack_lastwhid_${CORES[0]}:${CORES[0]}-POLD_dsg`, 1000, NIGHT - 86_400_000);
    p.restart();
    p.rec.rollupLifetime();
    p.run(10);
    p.setOnline(false, CORES, p.clock);
    p.run(60);
    p.setOnline(true, CORES, p.clock);
    p.run(30);
    assert.deepEqual(markers(p), [], 'precondition: no marker left');
    const before = p.read();
    const t0 = p.clock;
    for (let m = 1; m <= 5; m++) {
      const t = p.clock + MIN;
      p.minute(t);
      p.clock = t;
      if (m === 5) {
        p.setOnline(false, [CORES[0]], t); // /status OFFLINE, no new content
        p.rec.rollupLifetime();
        assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.pending, [CORES[0]], 'inside the dwell, not bridged');
        p.read();
        p.clock = t + 6_000;
        p.setOnline(true, [CORES[0]], p.clock);
      }
      p.read();
    }
    p.run(10);
    const after = p.read();
    const minutes = (p.clock - t0) / MIN;
    near(after.dsg - before.dsg, BAT_W.reduce((a, b) => a + b, 0) * minutes / 60, 15, 'battery out across the blip, once');
  } finally { p.close(); }
});

/* ══ 3. a crash, then downtime ═════════════════════════════════════════════════ */

for (const downMin of [11, 20]) {
  test(`★★★ a crash 4 min after a rollup, ${downMin} min down: the first rollup after the restart books the slot rows written before the crash, as Panel Load does`, () => {
    const p = new Plant(Date.parse('2026-10-16T21:00:00-07:00'));
    const origPanel = p.panelSamples.bind(p);
    p.panelSamples = (t: number) => { origPanel(t); p.sample(PANEL, 'panel_load', 3390, t); };
    try {
      p.establishHeld();
      p.goDark([-1130, -1130, -1130]);
      p.run(30);
      const row = (k: string) => (p.db.prepare('SELECT wh FROM lifetime_totals WHERE metric_key = ?').get(k) as { wh: number }).wh;
      const load0 = row('fleet_load_wh');
      const out0 = row('bridge_battery_discharge_wh');
      p.run(4);
      p.crash();
      p.clock += downMin * MIN;
      p.last = {};
      p.clock += 30_000; // the first rollup ~30 s after boot
      p.rec.rollupLifetime();
      const load = row('fleet_load_wh') - load0;
      const out = row('bridge_battery_discharge_wh') - out0;
      // Before (13 min down or more): 0 Wh bridged out against 226 Wh of load.
      near(load, 3390 * 4 / 60, 15, 'precondition: Panel Load books the 4 pre-crash minutes');
      near(out, load, 15, 'the bridge books the same minutes');
    } finally { p.close(); }
  });
}

test('★★ a graceful restart after a long downtime still clamps the first window (nothing is pending, the downtime has no rows)', () => {
  const p = new Plant(Date.parse('2026-10-16T21:00:00-07:00'));
  try {
    p.establishHeld();
    p.goDark([-1130, -1130, -1130]);
    p.run(30);
    p.rec.close();
    p.db.close();
    p.clock += 2 * 60 * MIN;
    p.open();
    p.run(5);
    const r = p.rec.batteryLifetimeDebug().bridge.lastRollup!;
    assert.ok(r.untilMs - r.sinceMs <= 15 * MIN, `the first window spans ${(r.untilMs - r.sinceMs) / MIN} min`);
  } finally { p.close(); }
});

/* ══ 4. a slot's isConnect flicker ═════════════════════════════════════════════ */

test('★★★ one rollup with a dark Core’s slot reading isConnect = 0 does not re-seed the battery floors: no published total steps down, none jumps back', () => {
  const p = new Plant(Date.parse('2026-10-17T07:00:00Z'));
  try {
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(30);
    const before = p.read();
    p.connected = [true, true, false];
    p.run(6); // one rollup with slot 3 disconnected; read() asserts every total non-decreasing
    p.connected = [true, true, true];
    p.run(10);
    const after = p.read();
    assert.ok(!p.logs.some((l) => l.includes('v1.96.0 SHP2 pool membership changed')), 'no re-seed');
    assert.ok(p.logs.some((l) => l.includes('the lifetime battery floors are re-seeded only once the change holds for 3 rollups')), 'the pending change is logged');
    near(after.chg - before.chg, 0, 1, 'battery in flat (night, discharging)');
    assert.ok(after.dsg - before.dsg < TRUE_W * 16 / 60 * 1.1, `no jump back: ${(after.dsg - before.dsg).toFixed(0)} Wh in 16 min`);
  } finally { p.close(); }
});

test('★★ the same with the Cores reporting: a one-rollup flicker re-seeds nothing; a change that holds for three rollups re-seeds once, at the third', () => {
  const p = new Plant(Date.parse('2026-10-17T07:00:00Z'));
  const reseeds = () => p.logs.filter((l) => l.includes('v1.96.0 SHP2 pool membership changed')).length;
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.run(10);
    p.connected = [true, true, false];
    p.run(6); // monotone reads throughout
    p.connected = [true, true, true];
    p.run(10);
    assert.equal(reseeds(), 0, 'a flicker is not a rollover');
    // Core 3 leaves the panel for good. The re-seed is a deliberate step down (a different set of
    // batteries), so these minutes are run without the plant's monotone read.
    p.connected = [true, true, false];
    const rollups = (n: number) => {
      for (let r = 0; r < n; r++) for (let m = 1; m <= 5; m++) { const t = p.clock + MIN; p.minute(t); p.clock = t; if (m === 5) p.rec.rollupLifetime(); }
    };
    rollups(2);
    assert.equal(reseeds(), 0, 'not before the change has held for three rollups');
    rollups(1);
    assert.equal(reseeds(), 1, 'at the third');
    rollups(2);
    assert.equal(reseeds(), 1, 'once');
  } finally { p.close(); }
});

test('★★★ a two-rollup isConnect flicker after hours of discharge: the Core that left stays in the battery sum while the change is pending, so the v1.98.0 floor-gap re-seed does not fire either', () => {
  const p = new Plant(Date.parse('2026-10-17T07:00:00Z'));
  try {
    p.establishHeld();
    p.coreBatW = DISCHARGE_W.map((w) => -w);
    p.sourceWatts = [...DISCHARGE_W];
    p.run(360); // six hours: each Core's share of the counters is now well over the 5 kWh re-seed gap
    const before = p.read();
    p.connected = [true, true, false];
    p.run(10); // two rollups; every read asserted non-decreasing
    p.connected = [true, true, true];
    p.run(10);
    const after = p.read();
    assert.ok(!p.logs.some((l) => l.includes('v1.98.0 lifetime battery floor sat')), 'the floor-gap re-seed did not fire');
    assert.ok(!p.logs.some((l) => l.includes('v1.96.0 SHP2 pool membership changed')), 'no membership re-seed');
    near(after.dsg - before.dsg, TRUE_W * 20 / 60, TRUE_W * 20 / 60 * 0.05, 'battery out over the 20 min, once');
  } finally { p.close(); }
});

test('★★ a held bridge window holds the two counters it adds to: a marked Core counting its own readings across a long panel gap keeps its AC input for the whole span', () => {
  const B = CORES[1];
  const p = new Plant(NIGHT);
  try {
    p.establishHeld();
    p.coreAcIn = [0, 1000, 0];
    p.goDark([-1000, 1000, -1000]);
    p.run(30);
    assert.ok(markers(p).some((k) => k.startsWith(`${B}:`)), 'precondition: Core B is marked');
    // Core B's own stream comes back while the cloud still lists it offline (its content changes, the
    // gate writes its rows); the panel's reading then goes stale for 20 min, so no slot row.
    p.run(5, (t) => { p.touch([B]); p.ownRows(B, t); });
    const before = p.read();
    // The panel goes stale two minutes into a rollup window, for the rest of the run: the next window
    // has no slot row while the last is 7 min old, so the bridge HOLDS it (A's and C's rows could
    // still be bridged); the one after counts Core B's own rows over the whole held span.
    let held = false;
    p.run(25, (t, m) => {
      if (m === 3) p.panelStale = true;
      p.touch([B]);
      p.ownRows(B, t);
      if (m === 11) held = p.rec.batteryLifetimeDebug().bridge.lastRollup?.held === true;
    });
    const after = p.read();
    assert.ok(held, 'precondition: the bridge held a window');
    // Core B's AC input: its slot while the panel was fresh, its own rows after — 1 kW throughout.
    near(after.gridImport - before.gridImport, 1000 * 25 / 60, 25, 'Grid to Battery Charge across the gap');
  } finally { p.close(); }
});

test('★★ a reporting Core whose own rows are sparse (a constant reading restated at the 5-min heartbeat) never holds the two counters the bridge adds to: the bridged slots’ grid charge is booked in every window', () => {
  const p = new Plant(NIGHT);
  try {
    p.establishHeld();
    // Core 1 reports (its own rows only every 7 min: a heartbeat drifting past the 5-min window);
    // Cores 2 and 3 dark, charging 2 kW each from the grid through their slots.
    const own = p.ownRows.bind(p);
    p.ownRows = (sn: string, t: number) => { if (sn !== CORES[0] || Math.round((t - NIGHT) / MIN) % 7 === 0) own(sn, t); };
    p.setOnline(false, CORES.slice(1), p.clock);
    p.sourceWatts = [0, 2000, 2000];
    p.run(10);
    const before = p.read();
    p.run(60);
    const after = p.read();
    near(after.gridImport - before.gridImport, 2 * 2000, 2 * 2000 * 0.02, 'Grid to Battery Charge: the two slots for the hour');
  } finally { p.close(); }
});
