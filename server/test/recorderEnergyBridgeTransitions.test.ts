/**
 * v1.188.1 — the energy bridge at its transitions, driven through the REAL recorder, with a read
 * every minute (the MQTT publish runs every 30 s) asserted never to decrease.
 *
 *  - A home Core going dark BETWEEN rollups in daylight: its pv_total (and, charging from the grid,
 *    its ac_in) since the last rollup was already showing in the pending integral. The read path
 *    must keep it — the Core is handed to the bridge at the instant it went offline, and the bridge
 *    starts its window there — so PV Production and Grid to Battery Charge never step down, and
 *    nothing is counted twice or lost.
 *  - A /status or /device/list blip (seconds; ~92 s on 2026-10-03) is not an outage: inside the
 *    dwell nothing is bridged, no marker or log line is written, and the BMS / pv_total keep
 *    counting, even when the blip straddles a rollup.
 *  - A second dark span starts its inferred anchor afresh.
 *  - The two counters the bridge changes the contributors of hold a dip between rollups.
 * Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlant, near, MIN, PANEL, CORES, PACKS, NAMEPLATE_WH } from './helpers/energyBridgePlant.js';

const { Plant, cleanup } = await loadPlant('ef-energy-bridge-transitions-');
const { BRIDGE_DWELL_MS, bridgePvSeenKey } = await import('../src/energyBridge.js');
test.after(cleanup);

type P = InstanceType<typeof Plant>;
const STEP_WH = NAMEPLATE_WH / 100;
const NOON = Date.parse('2026-10-15T11:00:00-07:00');
const NIGHT = Date.parse('2026-10-15T01:00:00-07:00');

/** Three Cores reporting in daylight: `pvW` each into the MPPT, `outW` of it across to the panel,
 *  the rest into the battery (the percent rising on the nameplate basis); the panel's PV field
 *  reads `fieldW`. Registers move with the battery power. */
function sunnyOnline(t0: number, o: { pvW: number; outW: number; fieldW: number; trusted?: boolean }): P {
  const p = new Plant(t0);
  if (o.trusted) {
    for (let s = 1; s <= 3; s++) p.putLifetime(bridgePvSeenKey(PANEL, s), o.fieldW, t0 - 24 * 60 * MIN);
    p.restart();
  }
  p.corePv = [o.pvW, o.pvW, o.pvW];
  p.sourceWatts = [-o.outW, -o.outW, -o.outW];
  p.pvW = [o.fieldW, o.fieldW, o.fieldW];
  p.coreBatW = [o.outW - o.pvW, o.outW - o.pvW, o.outW - o.pvW];
  p.pct = [40, 40, 40];
  return p;
}
function riseSoc(p: P, chargeW: number, stored: { wh: number }): () => void {
  return () => {
    stored.wh += chargeW / 60;
    p.pct = CORES.map(() => 40 + Math.floor(stored.wh / STEP_WH));
  };
}

/* ── a dark flip between rollups ─────────────────────────────────────────── */

test('★★★ daylight, every Core goes dark 1 min after a rollup (trusted panel field): no read steps down, and PV is the Cores\' own up to the flip plus the field after it — exactly', () => {
  const p = sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 3000, trusted: true });
  try {
    const stored = { wh: 0 };
    p.rec.rollupLifetime();
    p.run(10, riseSoc(p, 2500, stored), { readEach: true });
    const start = p.read();
    // 1 minute into the window (just after that minute's readings) every Core flips cloud-offline;
    // the panel keeps metering.
    p.run(30, (t, m) => { riseSoc(p, 2500, stored)(); if (m === 2) p.setOnline(false, CORES, t - MIN); }, { readEach: true });
    const end = p.read();
    near(end.pv - start.pv, 3 * 3000 * 30 / 60, 10, 'PV over the 30 min: nothing dropped, nothing counted twice');
    near(end.chg - start.chg, 3 * 2500 * 30 / 60, 3, 'battery in: the BMS up to the flip, the bridge after it');
    const r = p.rec.batteryLifetimeDebug().bridge;
    assert.equal(r.lastRollup?.slots[0].basis, 'measured');
    assert.ok(p.logs.some((l) => l.includes('is cloud-offline since')), 'the hand-off instant is logged');
  } finally { p.close(); }
});

test('★★★ daylight, every Core goes dark 3½ min into a window (the live, untrusted field): PV Production never steps down', () => {
  const p = sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 0 });
  try {
    const stored = { wh: 0 };
    p.rec.rollupLifetime();
    p.run(5, riseSoc(p, 2500, stored), { readEach: true });
    const start = p.read();
    // 3½ min into the window; the next read comes before the rollup.
    p.run(60, (t, m) => { riseSoc(p, 2500, stored)(); if (m === 4) p.setOnline(false, CORES, t - 30_000); }, { readEach: true });
    const end = p.read();
    // The inferred lower bound after the flip: within a step per Core of the truth, never above it by more.
    const truth = 3 * 3000 * 60 / 60;
    assert.ok(end.pv - start.pv <= truth + 3 * STEP_WH, `PV ${(end.pv - start.pv).toFixed(0)} vs ${truth}`);
    assert.ok(end.pv - start.pv >= truth - 3 * 2 * STEP_WH, `PV ${(end.pv - start.pv).toFixed(0)} vs ${truth}`);
  } finally { p.close(); }
});

test('★★★ one Core goes dark mid-window in daylight: the read keeps its PV up to the flip and goes on rising with the other two', () => {
  const p = sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 3000, trusted: true });
  try {
    const stored = { wh: 0 };
    p.rec.rollupLifetime();
    p.run(5, riseSoc(p, 2500, stored), { readEach: true });
    let atFlip = 0;
    p.run(3, (t, m) => { riseSoc(p, 2500, stored)(); if (m === 3) { atFlip = p.read().pv; p.setOnline(false, [CORES[0]], t - MIN); } });
    const after = p.read();
    // Minute 3: Core 1's own up to its flip (at minute 2), Cores 2 and 3 up to now.
    near(after.pv - atFlip, 2 * 3000 / 60, 1, 'Core 1 stopped at its flip; Cores 2 and 3 went on');
    p.run(1, riseSoc(p, 2500, stored));
    near(p.read().pv - after.pv, 2 * 3000 / 60, 1, 'the next minute: the two reporting Cores');
    p.run(25, riseSoc(p, 2500, stored), { readEach: true }); // ends on a rollup
    near(p.read().pv - atFlip, 3 * 3000 * 27 / 60, 10, 'Core 1 bridged from its flip: nothing dropped, nothing twice');
  } finally { p.close(); }
});

test('★★★ a daylight grid charge, every Core dark mid-window: Grid to Battery Charge never steps down and is the Cores\' ac_in then the slots\' inflow', () => {
  const p = new Plant(NOON);
  try {
    p.coreAcIn = [2000, 2000, 2000];
    p.sourceWatts = [2000, 2000, 2000];
    p.coreBatW = [-2000, -2000, -2000];
    p.rec.rollupLifetime();
    p.run(5, () => {}, { readEach: true });
    const start = p.read();
    p.run(30, (t, m) => { if (m === 2) p.setOnline(false, CORES, t - MIN); }, { readEach: true });
    near(p.read().gridImport - start.gridImport, 3 * 2000 * 30 / 60, 5, 'Grid to Battery Charge');
  } finally { p.close(); }
});

/* ── a crash restart within one rollup of a dark flip ───────────────────────── */

type Totals = ReturnType<P['read']>;

/**
 * Minute by minute from a rollup: a rollup every 5 min, a published read every minute (asserted
 * never to decrease, across the crash too), the published totals collected. `each` runs before
 * each minute's readings. Just after minute `crashAfter`'s read comes a second read: with `crash`
 * the recorder crashes between the two (Plant.crash: no close(), so no final rollup and the emit
 * high-water of the last rollup), and that second read is the restarted process's first publish
 * (the MQTT connect publish, before its first rollup 30 s after boot).
 */
function replay(p: P, o: { minutes: number; each: (t: number, m: number) => void; crashAfter: number; crash: boolean; keepProjection?: boolean }): Totals[] {
  const series: Totals[] = [];
  p.rec.rollupLifetime();
  for (let m = 1; m <= o.minutes; m++) {
    const t = p.clock + MIN;
    o.each(t, m);
    p.minute(t);
    p.clock = t;
    if (m % 5 === 0) p.rec.rollupLifetime();
    series.push(p.read());
    if (m === o.crashAfter) {
      if (o.crash) p.crash({ keepProjection: o.keepProjection });
      series.push(p.read());
    }
  }
  return series;
}

const CRASH_CASES: Array<{ name: string; make: () => P; each: (p: P, stored: { wh: number }) => (t: number, m: number) => void; flipM: number; flipBackMs: number; crashAfter: number; keepProjection?: boolean; truth?: (minutes: number) => Partial<Totals> }> = [
  {
    name: 'daylight (trusted field), dark 1 min after a rollup, a crash 3 min later',
    make: () => sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 3000, trusted: true }),
    each: (p, stored) => riseSoc(p, 2500, stored),
    flipM: 12, flipBackMs: MIN, crashAfter: 14,
    truth: (min) => ({ pv: 3 * 3000 * min / 60, chg: 3 * 2500 * min / 60 }),
  },
  {
    name: 'daylight (trusted field), dark 3½ min into a window, a crash before the rollup (inside the dwell)',
    make: () => sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 3000, trusted: true }),
    each: (p, stored) => riseSoc(p, 2500, stored),
    flipM: 14, flipBackMs: 30_000, crashAfter: 14,
  },
  {
    name: 'daylight (trusted field), dark 1 min after a rollup, a crash 3 min later, MQTT still delivering after the restart',
    make: () => sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 3000, trusted: true }),
    each: (p, stored) => riseSoc(p, 2500, stored),
    flipM: 12, flipBackMs: MIN, crashAfter: 14, keepProjection: true,
    truth: (min) => ({ pv: 3 * 3000 * min / 60, chg: 3 * 2500 * min / 60 }),
  },
  {
    name: 'night, the Cores discharging 6 kW, dark 2 min into a window, a crash 2 min later',
    make: () => {
      const p = new Plant(NIGHT);
      p.sourceWatts = [-2000, -2000, -2000];
      p.coreBatW = [2000, 2000, 2000];
      return p;
    },
    each: () => () => {},
    flipM: 13, flipBackMs: MIN, crashAfter: 14,
    truth: (min) => ({ dsg: 3 * 2000 * min / 60 }),
  },
];

for (const c of CRASH_CASES) {
  test(`★★★ a crash restart, ${c.name}: every read matches the uninterrupted process's (none steps down) and nothing is counted twice`, () => {
    let flipAt = 0;
    const run = (crash: boolean): { series: Totals[]; logs: string[] } => {
      const p = c.make();
      flipAt = p.clock + c.flipM * MIN - c.flipBackMs;
      try {
        const stored = { wh: 0 };
        const each = c.each(p, stored);
        const series = replay(p, {
          minutes: 45,
          each: (t, m) => { each(t, m); if (m === c.flipM) p.setOnline(false, CORES, t - c.flipBackMs); },
          crashAfter: c.crashAfter,
          crash,
          keepProjection: c.keepProjection,
        });
        return { series, logs: p.logs };
      } finally { p.close(); }
    };
    const ref = run(false);
    const got = run(true);
    assert.equal(got.series.length, ref.series.length);
    for (let i = 0; i < ref.series.length; i++) {
      for (const k of ['pv', 'chg', 'dsg', 'gridImport'] as const) {
        near(got.series[i][k], ref.series[i][k], 0.01, `read ${i + 1} ${k}: after the crash against the uninterrupted process`);
      }
    }
    if (c.truth) {
      // Against the plant's truth from the rollup at minute 10 to the end (35 min).
      const want = c.truth(35);
      const last = got.series[got.series.length - 1];
      for (const [k, v] of Object.entries(want) as Array<[keyof Totals, number]>) {
        near(last[k] - got.series[9][k], v, 3, `${k} over the 35 min across the crash`);
      }
    }
    // The restarted process bridged each Core from the hand-off instant the crashed one saw.
    const since = `is cloud-offline since ${new Date(flipAt).toISOString()}`;
    assert.equal(got.logs.filter((l) => l.includes(since)).length, CORES.length, got.logs.filter((l) => l.startsWith('energy bridge:')).join('\n'));
  });
}

test('★★★ the hand-off instant is persisted at the flip, survives a crash, and is cleared once the Core reports again; none is invented for a Core dark since first sight', () => {
  const p = new Plant(NIGHT);
  try {
    const key = `bridge_offline_${CORES[0]}`;
    p.rec.rollupLifetime();
    p.run(5);
    // Its last report (the minute) came 20 s before the cloud's offline flip.
    p.clock += 20_000;
    const flip = p.clock;
    p.setOnline(false, [CORES[0]], flip);
    p.read();
    assert.ok(p.lifetimeKeys().includes(key), 'written by the first read after the flip');
    p.crash();
    p.run(5);
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.offlineSince, [{ sn: CORES[0], sinceMs: flip }]);
    assert.ok(p.logs.some((l) => l.includes(`Core ${CORES[0]} is cloud-offline since ${new Date(flip).toISOString()}`)), 'the restarted process bridges it from the persisted instant');
    p.setOnline(true, [CORES[0]]);
    p.read();
    assert.ok(p.lifetimeKeys().includes(key), 'listed online with no reading of its own yet (the crash cleared the store): still dark, from the same instant');
    p.touch([CORES[0]]);
    p.read();
    assert.ok(!p.lifetimeKeys().includes(key), 'cleared once the Core reports again');
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.offlineSince, []);
    p.darkAtFirstSight();
    p.run(5);
    assert.ok(!p.lifetimeKeys().some((k) => k.startsWith('bridge_offline_')), 'no transition seen, no instant written');
  } finally { p.close(); }
});

/* ── blips: inside the dwell nothing is bridged ──────────────────────────────── */

for (const [label, sns] of [['one Core', [CORES[0]]], ['all three Cores', CORES]] as const) {
  test(`★★★ night, ${label} ${sns.length === 1 ? 'blips' : 'blip'} offline for 6 s across a rollup: no marker, no log line, battery out exactly the BMS's`, () => {
    const p = new Plant(NIGHT);
    try {
      p.sourceWatts = [-1000, -1000, -1000];
      p.coreBatW = [1000, 1000, 1000];
      p.rec.rollupLifetime();
      p.run(5, () => {}, { readEach: true });
      const start = p.read();
      p.run(30, (t, m) => {
        if (m === 10) p.setOnline(false, [...sns], t - 3_000); // the rollup at minute 10 lands inside it
        if (m === 11) p.setOnline(true, [...sns], t - MIN + 3_000);
      }, { readEach: true });
      near(p.read().dsg - start.dsg, 3 * 1000 * 30 / 60, 1, 'battery out');
      const dbg = p.rec.batteryLifetimeDebug().bridge;
      assert.deepEqual(dbg.markers, []);
      assert.equal(dbg.dischargeWh, 0, 'nothing bridged');
      assert.ok(!p.logs.some((l) => l.startsWith('energy bridge:') || l.includes('energy-bridge hand-over')), p.logs.filter((l) => l.includes('bridge')).join('\n'));
    } finally { p.close(); }
  });
}

test('★★★ daylight, a Core offline for 2½ min across a rollup (inside the dwell): its own PV keeps counting, nothing is bridged or lost', () => {
  assert.ok(2.5 * MIN < BRIDGE_DWELL_MS);
  const p = sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 0 });
  try {
    const stored = { wh: 0 };
    p.rec.rollupLifetime();
    p.run(5, riseSoc(p, 2500, stored), { readEach: true });
    const start = p.read();
    p.run(30, (t, m) => {
      riseSoc(p, 2500, stored)();
      if (m === 8) p.setOnline(false, [CORES[0]], t);
      if (m === 11) p.setOnline(true, [CORES[0]], t - 30_000);
    }, { readEach: true });
    near(p.read().pv - start.pv, 3 * 3000 * 30 / 60, 2, 'PV');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.pvWh, 0);
    // The power sensors inside the dwell: the blip Core is not a dark slot, so nothing is withheld for it.
    p.setOnline(false, [CORES[1]], p.clock - MIN);
    const f = p.rec.bridgedFleetFlow({ fleetPv: 6000, fleetBatteryNet: -5000 }, p.store.get().devices, p.clock);
    assert.deepEqual([f.ready, f.bridgedSlots, f.fleetPv], [true, 0, 6000]);
  } finally { p.close(); }
});

test('★★★ night, an outage that starts 2 min into a window: the bridge starts at the flip, so the battery energy the BMS already counted is not booked again', () => {
  const p = new Plant(NIGHT);
  try {
    p.sourceWatts = [-2000, -2000, -2000];
    p.coreBatW = [2000, 2000, 2000];
    p.rec.rollupLifetime();
    p.run(5, () => {}, { readEach: true });
    const start = p.read();
    p.run(30, (t, m) => { if (m === 3) p.setOnline(false, CORES, t - MIN); }, { readEach: true });
    // The BMS up to the flip (2 min in), the slots after it: 3 × 2 kW × 30 min.
    near(p.read().dsg - start.dsg, 3 * 2000 * 30 / 60, 2, 'battery out');
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, CORES.length * PACKS);
  } finally { p.close(); }
});

/* ── a second dark span ─────────────────────────────────────────────────── */

test('★★★ a second dark span hours later starts its inferred anchor afresh: the charge gained while the Cores reported is not booked as one window\'s solar', () => {
  const p = sunnyOnline(Date.parse('2026-10-15T08:00:00-07:00'), { pvW: 3000, outW: 500, fieldW: 0 });
  try {
    const stored = { wh: 0 };
    p.rec.rollupLifetime();
    p.run(5, riseSoc(p, 2500, stored));
    p.run(20, (t, m) => { riseSoc(p, 2500, stored)(); if (m === 2) p.setOnline(false, CORES, t - MIN); });
    p.run(5, (t, m) => { riseSoc(p, 2500, stored)(); if (m === 1) p.setOnline(true, CORES, t); });
    p.run(240, riseSoc(p, 2500, stored)); // four hours reporting: the percent climbs ~33 points
    const start = p.read();
    p.run(20, (t, m) => { riseSoc(p, 2500, stored)(); if (m === 2) p.setOnline(false, CORES, t - MIN); });
    const end = p.read();
    const truth = 3 * 3000 * 20 / 60;
    assert.ok(end.pv - start.pv <= truth + 3 * STEP_WH, `PV over the second span ${(end.pv - start.pv).toFixed(0)} vs ${truth}`);
  } finally { p.close(); }
});

/* ── the backstop ───────────────────────────────────────────────────────── */

test('★★ a Core\'s slot leaves the panel mid-window: PV Production holds (it never steps down) until the persisted total passes it', () => {
  const p = sunnyOnline(NOON, { pvW: 3000, outW: 500, fieldW: 3000 });
  try {
    p.rec.rollupLifetime();
    p.run(9, () => {}, { readEach: true });
    const held = p.read(['pv', 'gridImport']).pv;
    p.connected = [true, true, false]; // its pending pv_total since the last rollup drops out of the sum
    for (let m = 0; m < 12; m++) {
      const t = p.clock + MIN;
      p.minute(t);
      p.clock = t;
      if (m === 0) p.rec.rollupLifetime();
      p.read(['pv', 'gridImport']);
    }
    assert.ok(p.read(['pv', 'gridImport']).pv > held, 'and then it rises again');
  } finally { p.close(); }
});
