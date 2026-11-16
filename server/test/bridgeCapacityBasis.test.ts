/**
 * v1.207.0 — the energy bridge's capacity source, driven through the REAL recorder (the Plant helper).
 *
 * The bridge counts a dark slot on its Core's capacity ratio × the slot's nameplate. Until v1.207.0 that figure came from the
 * recorded pack<k>_full_cap_mah rows, read at most 45 days back, and past that the slot was counted on its nameplate without a
 * log line: 2.8–8.8 % more stored energy per percent on the three slots of the reference plant, 45 days after the Cores' last
 * pack rows. The inferred lower bound grows by the same share, and an honest PV field that read 0.90 of it is then found short.
 *
 * The figures are the three held capacities of test/fixtures/panelPvRecord.json (heldWh: 28,889 / 28,227 / 29,879 Wh on a
 * 30,720 Wh nameplate), dated in these tests at 2026-10-14 23:52 MST, when the Cores' telemetry stopped. Test serials are
 * placeholders.
 *
 * v1.207.0 (review) — and which Cores the recorder lets its tracker measure: only those that are not dark to the bridge, so
 * a dark slot's figure does not move on a body that is not a reading; two panels; a tracker failure; persistence disabled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlant, H, MIN, PANEL, CORES, PACK_MAH_TO_WH, NAMEPLATE_WH, DISCHARGE_W, PANEL2, CORE4, PANEL2_NAME } from './helpers/energyBridgePlant.js';

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

test('★★★ T1a — a Core dark for 46 days keeps its capacity: the check\'s step is the same on 11-27 (day 43) and on 11-30 (day 46) — and on day 120 and day 400', () => {
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
    // v1.207.0 (review) — "at any age" through the recorder: a new process on day 120 and on day 400 of the outage. A finite
    // limit anywhere above 46 days would pass the two dates above.
    for (const [label, at] of [['day 120', '2027-02-12T09:00:00-07:00'], ['day 400', '2027-11-19T09:00:00-07:00']]) {
      p.close();
      p = new Plant(Date.parse(at), { reuse: true });
      dark(p);
      p.panelSamples(p.clock);
      drive(p, 30, { outW: 300, batW: 2400, fieldW: 2700 }, { wh: 0 });
      assert.deepEqual(steps(p), HELD_STEP, `${label}: the same capacity`);
      assert.deepEqual(capLines(p), SEED_LINES, `${label}: the same three "(held)" lines, of the instant the ratios were measured`);
    }
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
    // ... while the tracker has measured each Core that delivers a reading: its own file holds the three ratios (no seed
    // file exists), first measured at the 10:05 rollup.
    assert.equal(p.basisFile('pool-energy-basis'), null);
    const fed = p.basisFile('pool-energy-basis-bridge');
    assert.deepEqual(Object.keys(fed?.cores ?? {}).sort(), [...CORES].sort());
    for (const sn of CORES) {
      assert.ok(Math.abs((fed?.cores[sn].ratio as number) - 56_000 / 60_000) < 1e-6, `${sn}: ${fed?.cores[sn].ratio}`);
      assert.equal(fed?.cores[sn].atMs, Date.parse('2026-11-27T10:05:00-07:00'), 'the first reading: the first body at 10:00 only seeds the witness');
    }
    p.goDark(DISCHARGE_W); // 10:05
    p.run(20);
    const line = (slot: number, iso: string): string => heldLine(slot, '28.67', '0.9333', iso);
    assert.deepEqual(capLines(p), [1, 2, 3].map((n) => line(n, '2026-11-27T17:05:00.000Z')), 'held at the last rollup each Core reported at');
    for (const c of p.rec.batteryLifetimeDebug().bridge.capacity) {
      assert.ok(Math.abs((c.wh as number) - 28_672) < 0.01, `${c.slot}: ${c.wh}`);
      assert.deepEqual([c.basis, c.atMs], ['held', Date.parse('2026-11-27T10:05:00-07:00')]);
    }
    // A restart mid-outage, no projection: the same figure from the bridge's own file, at the instant the file holds. That
    // is 10:05, the first rollup each Core delivered a reading at: at the 10:00 rollup the store held only each Core's first
    // body, which is not a reading, so the tracker measured nothing (v1.207.0 review; T10 shows a file instant older than
    // the last reading: an unchanged ratio's time is re-persisted hourly, not at every rollup).
    p.frozenProjection = false;
    p.restart();
    const from = p.logs.length;
    p.run(10);
    assert.deepEqual(capLines(p, from), [1, 2, 3].map((n) => line(n, '2026-11-27T17:05:00.000Z')));
    for (const c of p.rec.batteryLifetimeDebug().bridge.capacity) assert.ok(Math.abs((c.wh as number) - 28_672) < 0.01, `${c.slot}: ${c.wh}`);
    assert.equal(p.basisFile('pool-energy-basis'), null, 'the bridge never writes the runway tracker\'s file');
  } finally { p.close(); }
});

test('★★ T9 — a start at night logs the basis: the capacity is resolved at every rollup that books a bridged slot, not only in daylight', () => {
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

/* ── v1.207.0 (review): a dark Core is never measured ───────────────────────── */

/** Every Core reports with packs of 56,000 mAh on a 60,000 mAh design (×0.9333: 28,672 Wh a slot), then goes dark supplying
 *  300 W a slot. The bridge marks their held packs, so each Core stays dark until it hands back. */
function reportThenDark(p: P): void {
  p.measurableCapacity = true;
  p.pct = [40, 40, 40];
  p.coreBatW = [0, 0, 0];
  p.establishHeld();
  p.goDark([-300, -300, -300]);
  p.run(10);
}
const HELD_9333 = (56_000 / 60_000) * NAMEPLATE_WH;

test('★★★ the return, a body that is not a reading — a dark Core is listed online and its first body after a restart carries pack figures 3.6 % above its held ratio, and a rollup lands before it reports: its slot stays counted on the held ratio, the day is not restated and the trusted field keeps its trust; the new ratio is recorded once the Core has handed back', () => {
  const p = new Plant(Date.parse('2026-11-30T07:30:00-07:00'));
  try {
    reportThenDark(p);
    // The fields were trusted by an earlier day's check; a restart while dark (no projection) loads the rows.
    for (let s = 1; s <= 3; s++) p.putLifetime(bridgePvSeenKey(PANEL, s), 2000, p.clock - 24 * H);
    p.frozenProjection = false;
    p.restart();
    // Five hours of daylight: per slot 3,000 W of solar (300 W to the panel, 2,700 W into the battery), the field reading
    // 2,580 W of it (0.86: honest, and inside the 15 % tolerance of the bound).
    p.pvW = [2580, 2580, 2580];
    let stored = 0;
    const go = (min: number): void => p.run(min, () => { stored += 2700 / 60; p.pct = [0, 1, 2].map(() => 40 + Math.floor(stored / (HELD_9333 / 100))); });
    go(300);
    const before = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(before.capacity.map((c) => [c.slot, Math.round((c.wh as number) * 100) / 100, c.basis]),
      [1, 2, 3].map((n) => [`${PANEL}_${n}`, HELD_9333, 'held']), 'after the restart: each slot held at the ratio its Core last reported');
    assert.deepEqual(before.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`]);
    for (const c of before.pvChecks) assert.ok(c.verdict === 'consistent' && c.fieldWh / c.inferredWh > 0.85 && c.fieldWh / c.inferredWh < 0.87, JSON.stringify(c));
    // Slot 1's Core is listed online. The store holds its first body since the restart: a complete pack list at 58,000 mAh a
    // pack (×0.9667), which only seeds the content witness — the Core delivers no reading yet and its slot stays bridged.
    p.packFullCapMah[CORES[0]] = 58_000;
    p.frozenProjection = true;
    p.unprojected.add(CORES[1]);
    p.unprojected.add(CORES[2]);
    p.frozen.add(CORES[0]);
    p.setOnline(true, [CORES[0]], p.clock + MIN, false);
    const from = p.logs.length;
    go(5); // the one rollup between the first body and the first counted report
    const mid = p.rec.batteryLifetimeDebug().bridge;
    assert.deepEqual(capLines(p, from), [], 'no capacity line: the figure did not move');
    assert.deepEqual(mid.capacity.map((c) => [c.slot, Math.round((c.wh as number) * 100) / 100, c.basis]),
      [1, 2, 3].map((n) => [`${PANEL}_${n}`, HELD_9333, 'held']), 'slot 1 is still a bridged dark slot, on its Core\'s held ratio — never the 29.70 kWh of a body that is not a reading');
    assert.deepEqual(steps(p), { [`${PANEL}_1`]: 286.72, [`${PANEL}_2`]: 286.72, [`${PANEL}_3`]: 286.72 }, 'the check\'s step is unchanged: the morning is not restated');
    assert.deepEqual(p.logs.slice(from).filter((l) => l.includes('no longer trusted')), [], 'the honest field is not revoked');
    assert.deepEqual(mid.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`]);
    assert.ok(Math.abs((p.basisFile('pool-energy-basis-bridge')?.cores[CORES[0]].ratio as number) - 56_000 / 60_000) < 1e-6, 'the tracker did not measure a Core that is dark to the bridge');
    // The Core reports and hands back: its slot is no longer bridged, and only now is its new ratio recorded.
    p.frozen.delete(CORES[0]);
    go(10);
    assert.ok(p.logs.slice(from).some((l) => l.includes(`Core ${CORES[0]} is no longer bridged`)));
    assert.deepEqual(capLines(p, from), [], 'still no capacity line');
    assert.deepEqual(p.logs.slice(from).filter((l) => l.includes('no longer trusted')), []);
    assert.deepEqual(p.rec.batteryLifetimeDebug().bridge.trustedSlots, [`${PANEL}_1`, `${PANEL}_2`, `${PANEL}_3`], 'all three fields are still trusted after the return');
    const file = p.basisFile('pool-energy-basis-bridge')?.cores ?? {};
    assert.ok(Math.abs(file[CORES[0]].ratio - 58_000 / 60_000) < 1e-6, `the returned Core's ratio, measured from its own reading: ${file[CORES[0]].ratio}`);
    for (const sn of CORES.slice(1)) assert.ok(Math.abs(file[sn].ratio - 56_000 / 60_000) < 1e-6, `${sn}: ${file[sn].ratio}`);
  } finally { p.close(); }
});

test('★★★ the return, a marked Core that has not handed back — its data arrives while the cloud lists it offline, then it is listed online with nothing new since: it delivers a reading, the bridge still meters its slot, and the tracker does not measure it until it hands back', () => {
  const p = new Plant(Date.parse('2026-11-30T09:00:00-07:00'));
  try {
    reportThenDark(p);
    const held = [1, 2, 3].map((n) => heldLine(n, '28.67', '0.9333', '2026-11-30T16:05:00.000Z'));
    assert.deepEqual(capLines(p), held);
    assert.ok(p.rec.batteryLifetimeDebug().bridge.markers.some((k) => k.includes(CORES[0])), 'precondition: the Core is marked, so only a hand-back ends its dark span');
    p.packFullCapMah[CORES[0]] = 58_000; // its pack figures now read ×0.9667
    p.run(5, (t, m) => {
      if (m !== 4) return;
      p.mqttWhileOffline([CORES[0]]);            // fresh content at 09:18, the cloud still listing it offline
      p.frozen.add(CORES[0]);
      p.setOnline(true, [CORES[0]], t, false);   // listed online at 09:19, nothing new since
    });
    // 09:20: a reading of its own (content two minutes old), not reported since its return: still a bridged dark slot.
    assert.deepEqual(capLines(p), held, 'no new capacity line');
    assert.deepEqual(capacityOf(p).map((c) => [c.slot, c.wh, c.basis]), [1, 2, 3].map((n) => [`${PANEL}_${n}`, HELD_9333, 'held']));
    assert.ok(Math.abs((p.basisFile('pool-energy-basis-bridge')?.cores[CORES[0]].ratio as number) - 56_000 / 60_000) < 1e-6, 'not measured while it is dark to the bridge');
    // It reports: handed back at 09:25, measured from then.
    p.frozen.delete(CORES[0]);
    p.run(5);
    assert.ok(p.logs.some((l) => l.includes(`Core ${CORES[0]} is no longer bridged`)));
    assert.deepEqual(capLines(p), held);
    assert.ok(Math.abs((p.basisFile('pool-energy-basis-bridge')?.cores[CORES[0]].ratio as number) - 58_000 / 60_000) < 1e-6);
  } finally { p.close(); }
});

/* ── v1.207.0 (review): two panels ──────────────────────────────────────────── */

const HOUSE = 'Smart Home Panel 2'; // the house panel's name in the plant

test('★★★ two panels, every Core dark, the seed holding the house Cores only — each slot is answered from ITS OWN panel\'s Cores: the house slots held on their own ratios, the secondary panel\'s slot on the lowest ratio the tracker holds, each line naming its panel by name', () => {
  const p = new Plant(Date.parse('2026-11-30T02:00:00-07:00'));
  try {
    p.seedCapacityRatios(Object.fromEntries(CORES.map((sn, i) => [sn, HELD_WH[i] / NAMEPLATE_WH])), SEED_AT);
    dark(p);
    p.sourceWatts = [...DISCHARGE_W];
    p.second = { online: false, projected: false, fullCapMah: 57_000, w: -300, pct: 50 };
    p.panelSamples(p.clock);
    p.run(10);
    const house = (slot: number, kwh: string, ratio: string): string => heldLine(slot, kwh, ratio, SEED_ISO).replace('energy bridge: slot', `energy bridge: ${HOUSE} slot`);
    assert.deepEqual(capLines(p), [
      house(1, '28.89', '0.9404'), house(2, '28.23', '0.9188'), house(3, '29.88', '0.9726'),
      `energy bridge: ${PANEL2_NAME} slot 1 is counted on 28.23 kWh — ×0.9188 of its 30.72 kWh nameplate, the lowest ratio the capacity tracker holds: it holds none for this slot's Core (min-known)`,
    ]);
    for (const l of capLines(p)) assert.ok(![PANEL, PANEL2, CORE4, ...CORES].some((sn) => l.includes(sn)), `a serial in: ${l}`);
    assert.deepEqual(capacityOf(p), [...SEED_CAPACITY, { slot: `${PANEL2}_1`, wh: HELD_WH[1], basis: 'min-known', atMs: null }]);
  } finally { p.close(); }
});

test('★★★ two panels, every Core reporting and then dark — the tracker measured EVERY panel\'s Cores while they reported: the secondary panel\'s slot is held on its own Core\'s ratio, and the bridge\'s file holds all four Cores', () => {
  const p = new Plant(Date.parse('2026-11-27T10:00:00-07:00'));
  try {
    p.measurableCapacity = true; // the house Cores: ×0.9333
    p.second = { online: true, projected: true, fullCapMah: 57_000, w: 0, pct: 50 }; // the secondary panel's Core: ×0.9500
    p.establishHeld();
    assert.deepEqual(p.logs.filter((l) => l.startsWith('energy bridge:')), [], 'nothing is bridged: nothing logged');
    const fed = p.basisFile('pool-energy-basis-bridge')?.cores ?? {};
    assert.deepEqual(Object.keys(fed).sort(), [...CORES, CORE4].sort(), 'all four Cores, both panels');
    assert.ok(Math.abs(fed[CORE4].ratio - 0.95) < 1e-9, `${fed[CORE4].ratio}`);
    p.goDark(DISCHARGE_W); // 10:05
    p.second = { ...p.second, online: false, changedAt: p.clock, w: -300 };
    p.run(20);
    const iso = '2026-11-27T17:05:00.000Z';
    assert.deepEqual(capLines(p), [
      ...[1, 2, 3].map((n) => heldLine(n, '28.67', '0.9333', iso).replace('energy bridge: slot', `energy bridge: ${HOUSE} slot`)),
      `energy bridge: ${PANEL2_NAME} slot 1 is counted on 29.18 kWh — ×0.9500 of its 30.72 kWh nameplate, its Core's last measured ratio, of ${iso} (held)`,
    ], 'each slot held on its own Core\'s ratio — the secondary panel\'s never on the lowest known one');
    assert.deepEqual(capacityOf(p).map((c) => [c.slot, c.wh, c.basis]), [
      ...[1, 2, 3].map((n) => [`${PANEL}_${n}`, HELD_9333, 'held']), [`${PANEL2}_1`, 0.95 * NAMEPLATE_WH, 'held'],
    ]);
  } finally { p.close(); }
});

/* ── v1.207.0 (review): a tracker failure is contained ──────────────────────── */

test('★★★ the capacity tracker throws at a rollup (a Core\'s pack figure cannot be read) — the rollup completes and every counter advances; each dark slot keeps the figure it had, in use and in its "unavailable" line; when the tracker answers again each slot logs its basis again', () => {
  const p = new Plant(Date.parse('2026-11-30T09:00:00-07:00'));
  try {
    seedHeld(p);
    dark(p);
    p.measurableCapacity = true;
    p.setOnline(true, [CORES[2]]); // slot 3's Core reports throughout; slots 1 and 2 stay dark on their held ratios
    // While `broken`, reading the design capacity of that Core's packs throws: the tracker's ratio read fails for the panel.
    let broken = false;
    const get = p.store.get;
    p.store.get = () => {
      const snap = get();
      if (broken) for (const pk of snap.devices[CORES[2]].projection.packs) Object.defineProperty(pk, 'designCapMah', { get() { throw new Error('unreadable pack figure'); } });
      return snap;
    };
    p.panelSamples(p.clock);
    const stored = { wh: 0 };
    const w = { outW: 300, batW: 2400, fieldW: 2700 };
    drive(p, 15, w, stored);
    assert.deepEqual(capLines(p), [SEED_LINES[0], SEED_LINES[1]]);
    const twoSteps = { [`${PANEL}_1`]: 288.89, [`${PANEL}_2`]: 282.27 };
    assert.deepEqual(steps(p), twoSteps);
    const pvBefore = p.totals().pv;
    const from = p.logs.length;
    broken = true;
    drive(p, 5, w, stored); // one rollup with the tracker throwing
    assert.deepEqual(p.logs.slice(from).filter((l) => l.includes('rollup failed')), [], 'the bridge\'s rollup did not fail');
    assert.deepEqual(capLines(p, from), [
      'energy bridge: slot 1 stays counted on 28.89 kWh — the capacity tracker did not answer (unavailable)',
      'energy bridge: slot 2 stays counted on 28.23 kWh — the capacity tracker did not answer (unavailable)',
    ]);
    const dbg = p.rec.batteryLifetimeDebug().bridge;
    assert.equal(dbg.watermarkMs, p.clock, 'the bridge booked the window');
    assert.deepEqual(dbg.lastRollup?.slots.map((s) => [s.slot, s.basis]), [[1, 'inferred'], [2, 'inferred']], 'still inferred, on the kept figure');
    assert.deepEqual(steps(p), twoSteps, 'the check runs on the kept figure');
    assert.deepEqual(capacityOf(p).map((c) => [c.slot, c.wh, c.basis]), [[`${PANEL}_1`, HELD_WH[0], 'unavailable'], [`${PANEL}_2`, HELD_WH[1], 'unavailable']]);
    assert.ok(p.totals().pv > pvBefore + 40, `the solar counter advanced through the failing rollup (two slots, 300 W each to the panel for 5 minutes at least): ${pvBefore} → ${p.totals().pv}`);
    // The tracker answers again: the basis is logged again, the figures unchanged.
    broken = false;
    const again = p.logs.length;
    drive(p, 5, w, stored);
    assert.deepEqual(capLines(p, again), [SEED_LINES[0], SEED_LINES[1]]);
    assert.deepEqual(steps(p), twoSteps);
  } finally { p.close(); }
});

/* ── v1.207.0 (review): what the nameplate line says ────────────────────────── */

test('★★ persistence disabled (POOL_ENERGY_BASIS_DIR empty) — the tracker holds its ratios in memory only: the outage starts held on them, and a restart while the Cores are dark counts each slot on its nameplate, the line saying what the tracker HOLDS (a ratio was measured twenty minutes earlier)', () => {
  const dir = process.env.POOL_ENERGY_BASIS_DIR;
  process.env.POOL_ENERGY_BASIS_DIR = '';
  const p = new Plant(Date.parse('2026-11-27T10:00:00-07:00'));
  try {
    p.measurableCapacity = true;
    p.establishHeld();
    p.goDark(DISCHARGE_W);
    p.run(20);
    assert.deepEqual(capLines(p), [1, 2, 3].map((n) => heldLine(n, '28.67', '0.9333', '2026-11-27T17:05:00.000Z')), 'held, from memory');
    assert.equal(p.basisFile('pool-energy-basis-bridge'), null, 'nothing is written');
    p.frozenProjection = false;
    p.restart();
    const from = p.logs.length;
    p.run(10);
    assert.deepEqual(capLines(p, from), [1, 2, 3].map((n) =>
      `energy bridge: slot ${n} is counted on its 30.72 kWh nameplate — the capacity tracker holds no ratio for any Core (nameplate)`));
    assert.deepEqual(capacityOf(p).map((c) => [c.wh, c.basis, c.atMs]), [1, 2, 3].map(() => [NAMEPLATE_WH, 'nameplate', null]));
  } finally {
    p.close();
    if (dir == null) delete process.env.POOL_ENERGY_BASIS_DIR; else process.env.POOL_ENERGY_BASIS_DIR = dir;
  }
});
