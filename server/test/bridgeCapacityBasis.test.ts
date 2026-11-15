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
import { loadPlant, H, PANEL, CORES, PACK_MAH_TO_WH, NAMEPLATE_WH } from './helpers/energyBridgePlant.js';

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
