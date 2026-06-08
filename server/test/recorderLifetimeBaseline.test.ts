import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packDeltaWh, type PackBaseline } from '../src/recorder.js';

/**
 * v0.13.0 — per-pack BMS lifetime-baseline regression tests (P0-1).
 *
 * Root cause being pinned: DPU packs ship with FACTORY-lifetime registers
 * where accuDsgMah > accuChgMah (bench cycling at the factory). The old
 * recorder summed those ABSOLUTE registers, so the home discharge total
 * permanently exceeded charge → the RTE clamp fired on every rollup (926×
 * in the 7-day audit) and flat-lined HA's discharge tile.
 *
 * The fix subtracts a per-(sn, packNum) baseline captured at install so the
 * home totals are driven by DELTAS. `packDeltaWh` is the pure baseline-
 * subtraction unit; these tests prove discharge ≤ charge holds (so the
 * clamp never trips) precisely when the underlying deltas are physical —
 * even though the absolute registers are discharge-favoring.
 */

// Same conversion the recorder uses (102.4 V × Ah; 1000 mAh = 1 Ah).
const PACK_MAH_TO_WH = (51.2 * 2) / 1_000;

/** Sum packDeltaWh across packs against a shared baseline map keyed by num. */
function fleetDeltaWh(
  packs: Array<{ num: number; accuChgMah: number | null; accuDsgMah: number | null }>,
  baselines: Map<number, PackBaseline>,
): { chargeWh: number; dischargeWh: number } {
  let chargeWh = 0;
  let dischargeWh = 0;
  for (const pk of packs) {
    const { chgWh, dsgWh } = packDeltaWh(pk, baselines.get(pk.num), PACK_MAH_TO_WH);
    chargeWh += chgWh;
    dischargeWh += dsgWh;
  }
  return { chargeWh, dischargeWh };
}

test('packDeltaWh — discharge-favoring absolute registers, but deltas keep discharge ≤ charge (no clamp)', () => {
  // Two packs whose ABSOLUTE registers have accuDsg > accuChg (factory
  // offset). Baselines captured at "install" = snapshot 1.
  const snap1 = [
    { num: 0, accuChgMah: 1_000_000, accuDsgMah: 1_200_000 }, // dsg > chg
    { num: 1, accuChgMah: 900_000, accuDsgMah: 1_050_000 },   // dsg > chg
  ];
  const baselines = new Map<number, PackBaseline>([
    [0, { chgMah: snap1[0].accuChgMah, dsgMah: snap1[0].accuDsgMah }],
    [1, { chgMah: snap1[1].accuChgMah, dsgMah: snap1[1].accuDsgMah }],
  ]);

  // At install the delta is exactly zero for both counters.
  const t0 = fleetDeltaWh(snap1, baselines);
  assert.equal(t0.chargeWh, 0);
  assert.equal(t0.dischargeWh, 0);
  assert.ok(t0.dischargeWh <= t0.chargeWh, 'discharge must not exceed charge at install');

  // Snapshot 2: real home usage since install — each pack charged a bit
  // MORE than it discharged (a healthy round-trip-efficiency < 100%). The
  // absolute registers are STILL discharge-favoring (1.2M > 1.05M etc.),
  // but the deltas correctly show discharge ≤ charge.
  const snap2 = [
    { num: 0, accuChgMah: 1_010_000, accuDsgMah: 1_209_000 }, // +10000 chg, +9000 dsg
    { num: 1, accuChgMah: 905_000, accuDsgMah: 1_054_000 },   // +5000 chg, +4000 dsg
  ];
  const t1 = fleetDeltaWh(snap2, baselines);

  // Deltas: chg = (10000 + 5000) mAh, dsg = (9000 + 4000) mAh.
  assert.equal(t1.chargeWh, 15_000 * PACK_MAH_TO_WH);
  assert.equal(t1.dischargeWh, 13_000 * PACK_MAH_TO_WH);
  // The invariant the clamp exists to enforce now holds naturally — so the
  // clamp (dischargeOut > chargeOut) would NOT fire.
  assert.ok(t1.dischargeWh <= t1.chargeWh, 'baseline-subtracted discharge must be ≤ charge');
});

test('packDeltaWh — missing baseline contributes nothing (pack not yet captured)', () => {
  const pk = { num: 0, accuChgMah: 1_000_000, accuDsgMah: 1_200_000 };
  const { chgWh, dsgWh } = packDeltaWh(pk, undefined, PACK_MAH_TO_WH);
  assert.equal(chgWh, 0);
  assert.equal(dsgWh, 0);
});

test('packDeltaWh — null registers (BMS readback dropout) yield zero, never negative', () => {
  const base: PackBaseline = { chgMah: 1_000_000, dsgMah: 1_200_000 };
  const { chgWh, dsgWh } = packDeltaWh(
    { num: 0, accuChgMah: null, accuDsgMah: null },
    base,
    PACK_MAH_TO_WH,
  );
  assert.equal(chgWh, 0);
  assert.equal(dsgWh, 0);
});

test('packDeltaWh — register below baseline (corrupt/rolled-back read) is floored at 0, not decremented', () => {
  const base: PackBaseline = { chgMah: 1_000_000, dsgMah: 1_200_000 };
  // Both registers read BELOW their captured baseline.
  const { chgWh, dsgWh } = packDeltaWh(
    { num: 0, accuChgMah: 990_000, accuDsgMah: 1_150_000 },
    base,
    PACK_MAH_TO_WH,
  );
  assert.equal(chgWh, 0, 'negative charge delta must floor at 0');
  assert.equal(dsgWh, 0, 'negative discharge delta must floor at 0');
});

test('packDeltaWh — a freshly-swapped pack baselines to its own register, no factory offset leaks', () => {
  // New pack hot-added at slot 1 with a large factory register. Its baseline
  // is captured = its current register, so its install-instant delta is 0
  // and it never injects the absolute factory offset into the fleet total.
  const swappedRegister = { num: 1, accuChgMah: 2_000_000, accuDsgMah: 2_400_000 };
  const baselines = new Map<number, PackBaseline>([
    [1, { chgMah: swappedRegister.accuChgMah, dsgMah: swappedRegister.accuDsgMah }],
  ]);
  const total = fleetDeltaWh([swappedRegister], baselines);
  assert.equal(total.chargeWh, 0);
  assert.equal(total.dischargeWh, 0);
  assert.ok(total.dischargeWh <= total.chargeWh);
});
