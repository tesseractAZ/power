/**
 * v1.207.0 — the energy bridge's capacity source, driven through the REAL recorder (the Plant helper).
 *
 * The bridge counts a dark slot on its Core's capacity ratio × the slot's nameplate. Until v1.207.0 that figure came from the
 * recorded pack<k>_full_cap_mah rows, read at most 45 days back, and past that the slot was counted on its nameplate without a
 * log line: 2.8–8.8 % more stored energy per percent on the three slots of the reference plant, 45 days after the Cores' last
 * pack rows. The inferred lower bound grows by the same share, and an honest PV field that read 0.90 of it is then found short.
 *
 * The figures are the three held capacities of test/fixtures/panelPvRecord.json (28,889 / 28,227 / 29,879 Wh on a 30,720 Wh
 * nameplate), recorded at the instant the Cores' telemetry stopped. Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlant, H, MIN, PANEL, CORES, PACK_MAH_TO_WH, NAMEPLATE_WH, DISCHARGE_W } from './helpers/energyBridgePlant.js';

const { Plant, cleanup } = await loadPlant('ef-bridge-capacity-');
const { bridgePvSeenKey } = await import('../src/energyBridge.js');
test.after(cleanup);

type P = InstanceType<typeof Plant>;
/** The Cores' last pack rows, and the instant the runway tracker last measured their ratios. */
const SEED_AT = Date.parse('2026-10-14T23:52:00-07:00');
/** Each slot's held capacity, Wh (panelPvRecord.json heldWh). */
const HELD_WH = [28_889, 28_227, 29_879];
const HELD_STEP = { [`${PANEL}_1`]: 288.89, [`${PANEL}_2`]: 282.27, [`${PANEL}_3`]: 298.79 };

/** What a previous process left: the runway tracker's per-Core ratios (the bridge's seed from v1.207.0) and each Core's five
 *  pack<k>_full_cap_mah rows (what the bridge read until then), both at SEED_AT and both worth the same Wh. */
function seedHeld(p: P): void {
  p.seedCapacityRatios(Object.fromEntries(CORES.map((sn, i) => [sn, HELD_WH[i] / NAMEPLATE_WH])), SEED_AT);
  CORES.forEach((sn, i) => {
    for (let k = 1; k <= 5; k++) p.sample(sn, `pack${k}_full_cap_mah`, HELD_WH[i] / PACK_MAH_TO_WH / 5, SEED_AT);
  });
}
/** Dark since before this process saw them, no projection (the live case). */
function dark(p: P): void {
  p.darkAtFirstSight();
  p.frozenProjection = false;
  p.pct = [40, 40, 40];
}
/** Each slot: `outW` to the panel, `batW` into its battery (its percent rising on its HELD capacity), the field reading `fieldW`. */
function drive(p: P, minutes: number, w: { outW: number; batW: number; fieldW: number }, stored: { wh: number }): void {
  p.sourceWatts = [-w.outW, -w.outW, -w.outW];
  p.pvW = [w.fieldW, w.fieldW, w.fieldW];
  p.run(minutes, () => {
    stored.wh += w.batW / 60;
    p.pct = HELD_WH.map((wh) => 40 + Math.floor(stored.wh / (wh / 100)));
  });
}
/** The capacity lines logged since `from` (an index into the plant's log). */
const capLines = (p: P, from = 0): string[] => p.logs.slice(from).filter((l) => / counted on | has no capacity figure /.test(l));
const heldLine = (slot: number, kwh: string, ratio: string, iso: string): string =>
  `energy bridge: slot ${slot} is counted on ${kwh} kWh — ×${ratio} of its 30.72 kWh nameplate, its Core's last measured ratio, of ${iso} (held)`;
const SEED_ISO = '2026-10-15T06:52:00.000Z';
/** The three lines of a plant seeded by seedHeld and dark: each slot on its Core's own ratio, measured at SEED_AT. */
const SEED_LINES = [heldLine(1, '28.89', '0.9404', SEED_ISO), heldLine(2, '28.23', '0.9188', SEED_ISO), heldLine(3, '29.88', '0.9726', SEED_ISO)];
/** bridge.capacity, the Wh rounded to 2 dp. */
const capacityOf = (p: P): Array<{ slot: string; wh: number | null; basis: string; atMs: number | null }> =>
  p.rec.batteryLifetimeDebug().bridge.capacity.map((c) => ({ slot: c.slot, wh: c.wh == null ? null : Math.round(c.wh * 100) / 100, basis: c.basis, atMs: c.atMs }));
const SEED_CAPACITY = HELD_WH.map((wh, i) => ({ slot: `${PANEL}_${i + 1}`, wh, basis: 'held', atMs: SEED_AT }));
/** The field check's step per slot (1 % of the capacity the slot is counted on), Wh to 2 dp. */
const steps = (p: P): Record<string, number> =>
  Object.fromEntries(p.rec.batteryLifetimeDebug().bridge.pvChecks.map((c) => [c.slot, Math.round(c.stepWh * 100) / 100]));

test('★★★ T1a — a Core dark for 46 days keeps its capacity: the check\'s step is the same on 11-27 (day 43) and on 11-30 (day 46)', () => {
  let p = new Plant(Date.parse('2026-11-27T09:00:00-07:00'));
  try {
    seedHeld(p);
    dark(p);
    p.panelSamples(p.clock);
    drive(p, 30, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 });
    assert.deepEqual(steps(p), HELD_STEP, 'day 43: each slot is counted on its Core\'s held capacity');
    p.close();
    p = new Plant(Date.parse('2026-11-30T09:00:00-07:00'), { reuse: true });
    dark(p);
    p.panelSamples(p.clock);
    drive(p, 30, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 });
    assert.deepEqual(steps(p), HELD_STEP, 'day 46: the same capacity — never the 30,720 Wh nameplate (a step of 307.2 Wh)');
  } finally { p.close(); }
});

test('★★★ T2 — 46 days dark: an honest field reading 0.90 of the solar keeps its trust all day', () => {
  const p = new Plant(Date.parse('2026-11-30T08:00:00-07:00'));
  try {
    seedHeld(p);
    dark(p);
    // Trusted by an earlier day's check (the persisted row a previous process left).
    for (let s = 1; s <= 3; s++) p.putLifetime(bridgePvSeenKey(PANEL, s), 2000, p.clock - 24 * H);
    p.restart();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.trustedSlots.length, 3);
    p.panelSamples(p.clock);
    // Per slot 3,000 W of solar: 300 W to the panel, 2,700 W into the battery; the field reads 2,700 W (0.90 of it, the lowest
    // honest end-of-day reading measured on 2026-10-18).
    drive(p, 300, { outW: 300, batW: 2700, fieldW: 2700 }, { wh: 0 });
    const revoked = p.logs.filter((l) => l.includes('no longer trusted'));
    assert.deepEqual(revoked, [], 'no revocation all day');
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`]);
    assert.deepEqual(dbg.lastRollup?.slots.map((s) => s.basis), ['measured', 'measured', 'measured']);
    const c = dbg.pvChecks.find((x) => x.slot === `${PANEL}_2`);
    assert.ok(c && c.fieldWh / c.inferredWh > 0.899 && c.fieldWh / c.inferredWh < 0.93, `slot 2 field / bound: ${JSON.stringify(c)}`);
  } finally { p.close(); }
});

test('★★★ T1b — the capacity is logged once per slot when the bridge starts metering it, word for word, and served in the debug block; a new process on day 46 logs the same three lines', () => {
  let p = new Plant(Date.parse('2026-11-27T09:00:00-07:00'));
  try {
    seedHeld(p);
    dark(p);
    p.panelSamples(p.clock);
    drive(p, 30, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 });
    assert.deepEqual(capLines(p), SEED_LINES, 'exactly three capacity lines, one per slot, never repeated while nothing changes');
    for (const l of capLines(p)) assert.ok(!l.includes(PANEL) && !CORES.some((sn) => l.includes(sn)), `a serial in: ${l}`);
    assert.deepEqual(capacityOf(p), SEED_CAPACITY, 'bridge.capacity: the held figure and the instant it was measured');
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    for (const c of dbg.pvChecks) assert.equal(c.stepWh, (dbg.capacity.find((x) => x.slot === c.slot)?.wh as number) / 100, 'the check\'s step is 1 % of the capacity served');
    p.close();
    p = new Plant(Date.parse('2026-11-30T09:00:00-07:00'), { reuse: true });
    dark(p);
    p.panelSamples(p.clock);
    drive(p, 30, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 });
    assert.deepEqual(capLines(p), SEED_LINES, 'day 46, a new process: the same three lines — no "(nameplate)", no "(min-known)"');
    assert.deepEqual(capacityOf(p), SEED_CAPACITY);
  } finally { p.close(); }
});

test('★★★ T8 — the tracker is fed while the Cores report (nothing logged, no capacity resolved): an outage starts from the ratio each last reported, and a restart reads it from the bridge\'s own file', () => {
  const p = new Plant(Date.parse('2026-11-27T10:00:00-07:00'));
  try {
    p.measurableCapacity = true; // each Core: packs of 56,000 mAh on a 60,000 mAh design — ×0.9333
    p.establishHeld();
    // The Cores report: no slot is bridged, so no capacity is resolved and no 'energy bridge:' line is logged ...
    assert.deepEqual(p.logs.filter((l) => l.startsWith('energy bridge:')), []);
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.capacity, []);
    // ... while the recorder has fed the tracker at each rollup: its own file holds the three ratios (no seed file exists).
    assert.equal(p.basisFile('pool-energy-basis'), null);
    const fed = p.basisFile('pool-energy-basis-bridge');
    assert.deepEqual(Object.keys(fed?.cores ?? {}).sort(), [...CORES].sort());
    for (const sn of CORES) assert.ok(Math.abs((fed?.cores[sn].ratio as number) - 56_000 / 60_000) < 1e-6, `${sn}: ${fed?.cores[sn].ratio}`);
    p.goDark(DISCHARGE_W); // 10:05
    p.run(20);
    const line = (slot: number, iso: string): string => heldLine(slot, '28.67', '0.9333', iso);
    assert.deepEqual(capLines(p), [1, 2, 3].map((n) => line(n, '2026-11-27T17:05:00.000Z')), 'held at the last rollup each Core reported at');
    for (const c of p.rec.batteryLifetimeDebug().bridge.capacity) {
      assert.ok(Math.abs((c.wh as number) - 28_672) < 0.01, `${c.slot}: ${c.wh}`);
      assert.deepEqual([c.basis, c.atMs], ['held', Date.parse('2026-11-27T10:05:00-07:00')]);
    }
    // A restart mid-outage, no projection: the same figure from the bridge's own file. The instant is the one the file
    // holds: an unchanged ratio's time is re-persisted hourly (10:00, the first reading), not at every rollup.
    p.frozenProjection = false;
    p.restart();
    const from = p.logs.length;
    p.run(10);
    assert.deepEqual(capLines(p, from), [1, 2, 3].map((n) => line(n, '2026-11-27T17:00:00.000Z')));
    for (const c of p.rec.batteryLifetimeDebug().bridge.capacity) assert.ok(Math.abs((c.wh as number) - 28_672) < 0.01, `${c.slot}: ${c.wh}`);
    assert.equal(p.basisFile('pool-energy-basis'), null, 'the bridge never writes the runway tracker\'s file');
  } finally { p.close(); }
});

test('★★ T9 — a start at night logs the basis: the capacity is resolved at every rollup of a bridged slot, not only in daylight', () => {
  const p = new Plant(Date.parse('2026-11-30T02:00:00-07:00'));
  try {
    seedHeld(p);
    dark(p);
    p.sourceWatts = [...DISCHARGE_W];
    p.panelSamples(p.clock);
    p.run(10);
    assert.deepEqual(capLines(p), SEED_LINES);
    assert.deepEqual(capacityOf(p), SEED_CAPACITY);
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(dbg.pvChecks, [], 'night: no field check runs');
    assert.deepEqual(dbg.lastRollup?.slots.map((s) => s.basis), ['night', 'night', 'night']);
  } finally { p.close(); }
});

test('★★★ persistSeed through the recorder — seeded, dark, no Core ever returns: the first rollup writes the three seeded ratios to the bridge\'s own file; with the runway tracker\'s file deleted, a restart logs the same three lines', () => {
  const p = new Plant(Date.parse('2026-11-30T09:00:00-07:00'));
  try {
    seedHeld(p);
    dark(p);
    p.panelSamples(p.clock);
    assert.equal(p.basisFile('pool-energy-basis-bridge'), null, 'no file of its own yet');
    drive(p, 5, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 }); // the first rollup
    const expected = Object.fromEntries(CORES.map((sn, i) => [sn, { ratio: HELD_WH[i] / NAMEPLATE_WH, atMs: SEED_AT }]));
    assert.deepEqual(p.basisFile('pool-energy-basis-bridge')?.cores, expected, 'the three seeded ratios, at the instants the seed recorded');
    assert.deepEqual(p.basisFile('pool-energy-basis')?.cores, expected, 'the seed file is read, never written');
    assert.deepEqual(capLines(p), SEED_LINES);
    // The runway tracker's file is gone (a restore without it, a wiped folder): the bridge no longer depends on it.
    p.removeBasisFile('pool-energy-basis');
    p.restart();
    const from = p.logs.length;
    drive(p, 10, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 });
    assert.deepEqual(capLines(p, from), SEED_LINES, 'the same three "(held)" lines from the bridge\'s own file');
    assert.deepEqual(capacityOf(p), SEED_CAPACITY);
    assert.equal(p.basisFile('pool-energy-basis'), null);
    assert.deepEqual(p.basisFile('pool-energy-basis-bridge')?.cores, expected, 'unchanged: no Core reported');
  } finally { p.close(); }
});

test('★★★ T10 — the return: one Core reports for 15 minutes at a new ratio and goes dark again — its slot is held at the new ratio from its return; the two still-dark slots keep their own seeded ratios throughout; the bridge\'s file holds all three and a restart without the runway tracker\'s file gives the same figures', () => {
  const t0 = Date.parse('2026-11-30T09:00:00-07:00');
  const p = new Plant(t0);
  try {
    seedHeld(p);
    dark(p);
    p.measurableCapacity = true;
    p.packFullCapMah[CORES[0]] = 57_000; // slot 1's Core now measures ×0.95 (57,000 of 60,000 mAh a pack); its seed says ×0.9404
    p.sourceWatts = [-300, -300, -300];
    p.panelSamples(p.clock);
    p.run(10);
    assert.deepEqual(capLines(p), SEED_LINES, 'dark at first sight: each slot on its seeded ratio');
    const others = SEED_CAPACITY.slice(1);
    // Slot 1's Core comes back and reports for 15 minutes (rollups at 09:15, 09:20, 09:25).
    p.setOnline(true, [CORES[0]]);
    p.run(15);
    assert.deepEqual(capacityOf(p), others, 'slot 1 is no longer bridged; slots 2 and 3 stay held on their own ratios, at the seed\'s instant');
    assert.ok(p.logs.some((l) => l.includes(`Core ${CORES[0]} is no longer bridged`)));
    // ... and goes dark again.
    p.setOnline(false, [CORES[0]]);
    p.run(10);
    const returned = heldLine(1, '29.18', '0.9500', '2026-11-30T16:25:00.000Z');
    assert.deepEqual(capLines(p), [...SEED_LINES, returned], 'slot 1: one new line, held at its Core\'s ratio from its return; no new line for slots 2 and 3');
    assert.deepEqual(capacityOf(p), [{ slot: `${PANEL}_1`, wh: 0.95 * NAMEPLATE_WH, basis: 'held', atMs: t0 + 25 * MIN }, ...others],
      'never the lowest known ratio, never slot 1\'s 0.95');
    // The bridge's own file: all three Cores — the returned one at its new ratio (first persisted at 09:15: an unchanged
    // ratio's instant is re-persisted hourly), the other two as seeded.
    assert.deepEqual(p.basisFile('pool-energy-basis-bridge')?.cores, {
      [CORES[0]]: { ratio: 0.95, atMs: t0 + 15 * MIN },
      [CORES[1]]: { ratio: HELD_WH[1] / NAMEPLATE_WH, atMs: SEED_AT },
      [CORES[2]]: { ratio: HELD_WH[2] / NAMEPLATE_WH, atMs: SEED_AT },
    });
    // The runway tracker's file deleted, then a restart: the same three figures.
    p.removeBasisFile('pool-energy-basis');
    p.frozenProjection = false;
    p.restart();
    const from = p.logs.length;
    p.run(10);
    assert.deepEqual(capLines(p, from), [heldLine(1, '29.18', '0.9500', '2026-11-30T16:15:00.000Z'), SEED_LINES[1], SEED_LINES[2]]);
    assert.deepEqual(capacityOf(p).map((c) => [c.slot, c.wh, c.basis]), [
      [`${PANEL}_1`, 0.95 * NAMEPLATE_WH, 'held'], [`${PANEL}_2`, HELD_WH[1], 'held'], [`${PANEL}_3`, HELD_WH[2], 'held'],
    ]);
  } finally { p.close(); }
});
