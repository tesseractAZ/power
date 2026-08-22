import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packLatchSignature, packCellForensics, isNeverMutedAlert, DEFECTIVE_PACK_MIN_DEVIANT_MV, computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.101.0 — the standing "pack confirmed defective" alert.
 *
 * MOTIVATING INCIDENT (2026-08-20). The defective warranty pack (Y712ZABA4H350037:
 * frozen coulomb counter, 1% SoC against siblings at 44-63%, dead cell #31) moved
 * onto a bench chassis, where every alert it raised was demoted to
 * annunciate:false — while its healthy 29-cycle replacement, on a panel-wired
 * chassis, pushed [High] cell imbalance to the operator's phone. Alarm loudness
 * became inversely correlated with physical severity.
 *
 * The alert fires only on an unambiguous TWO-LEG signature (BMS protection latch
 * AND an identified deviant cell) so it cannot be raised by an idle pack or by
 * low-SoC knee noise, and it is exempt from both demotion paths.
 */

const pack = (num: number, soc: number | null, inW: number, outW: number, cells?: number[]) => ({
  num, soc, inputWatts: inW, outputWatts: outW,
  cellVoltagesMv: cells ?? new Array(32).fill(3300),
  maxVolDiffMv: cells ? Math.max(...cells) - Math.min(...cells) : 0,
});

/** The live shape: pack 1 stranded at 1% and taking 0 W while siblings charge. */
const defectiveFleet = () => {
  const bad = new Array(32).fill(3125); bad[30] = 3019;      // dead cell #31
  return [
    pack(1, 1, 0, 0, bad),
    pack(2, 48, 420, 0), pack(3, 49, 380, 0), pack(4, 45, 358, 0), pack(5, 49, 351, 0),
  ];
};

test('latch signature fires on the live defective-pack shape', () => {
  const l = packLatchSignature(defectiveFleet(), 1);
  assert.ok(l, 'latch detected');
  assert.equal(l!.socPct, 1);
  assert.ok(l!.siblingMedianSocPct >= 45, `sibling median ${l!.siblingMedianSocPct}`);
  assert.ok(l!.packAbsW < 25 && l!.siblingMedianAbsW >= 100);
});

test('latch signature does NOT fire when the whole bank is idle (the false-positive case)', () => {
  // Same SoC spread, but nothing is moving power — an idle pack is not a latched one.
  const idle = [pack(1, 1, 0, 0), pack(2, 48, 0, 0), pack(3, 49, 0, 0), pack(4, 45, 0, 0), pack(5, 49, 0, 0)];
  assert.equal(packLatchSignature(idle, 1), null, 'idle siblings must not imply a latch');
});

test('latch signature does NOT fire on a merely low pack that is still charging', () => {
  const charging = [pack(1, 1, 300, 0), pack(2, 48, 420, 0), pack(3, 49, 380, 0), pack(4, 45, 358, 0), pack(5, 49, 351, 0)];
  assert.equal(packLatchSignature(charging, 1), null, 'a pack accepting charge is not latched');
});

test('both legs are required — a latch on a cell-MATCHED pack does not qualify', () => {
  // packCellForensics always names its most-deviant cell, even on a perfectly
  // matched pack, so the second leg is a THRESHOLD, not a null check. A latched
  // pack whose cells all agree is a different fault and must not be reported as
  // a deviant-cell defect (the detail would read "0 mV from the pack median").
  const flat = [
    pack(1, 1, 0, 0, new Array(32).fill(3125)),
    pack(2, 48, 420, 0), pack(3, 49, 380, 0), pack(4, 45, 358, 0), pack(5, 49, 351, 0),
  ];
  assert.ok(packLatchSignature(flat, 1), 'latch leg holds');
  const fx = packCellForensics(flat as any, 1);
  assert.ok(fx, 'forensics still returns a row');
  assert.ok(Math.abs(fx!.deltaMv) < DEFECTIVE_PACK_MIN_DEVIANT_MV, 'but the deviation is below the bar');
});

test('the live defective pack clears the deviant-cell bar comfortably', () => {
  const fx = packCellForensics(defectiveFleet() as any, 1);
  assert.ok(fx, 'forensics present');
  assert.equal(fx!.deviantCell, 31, 'names the real dead cell');
  assert.ok(Math.abs(fx!.deltaMv) >= DEFECTIVE_PACK_MIN_DEVIANT_MV,
    `deviation ${fx!.deltaMv} mV must clear the ${DEFECTIVE_PACK_MIN_DEVIANT_MV} mV bar`);
});

test('the defective-pack alert is never muted, by id, on either demotion path', () => {
  assert.equal(isNeverMutedAlert({ id: 'pack-defective-Y711ZABA9H3T0489-1', severity: 'warning', category: 'Battery' }), true);
  assert.equal(isNeverMutedAlert({ id: 'vdiff-crit-Y711ZABA9H3T0489-1', severity: 'critical', category: 'Battery' }), false);
  assert.equal(isNeverMutedAlert({ id: 'temp-cell-X-1-critical', severity: 'critical', category: 'Thermal' }), true);
  assert.equal(isNeverMutedAlert({ id: 'temp-cell-X-1-warning', severity: 'warning', category: 'Thermal' }), false);
});

/* ── EMISSION PATH ────────────────────────────────────────────────────────
 * The pure-helper tests above do not exercise `computeAlerts`, and the
 * mutation harness (scripts/mutate-never-muted.mjs) correctly flagged that:
 * three mutants — dropping the spare-stamp exemption, the deviant-cell leg and
 * the latch leg — all survived a suite that only tested the helpers. These
 * tests close that gap end to end.
 * ─────────────────────────────────────────────────────────────────────── */

const BENCH_SN = 'Y711ZABA9H3T0489';   // in SPARE_DPU_SNS — the bench chassis

function fleet(packs: any[], sn = BENCH_SN): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: 'Core 4', productName: 'DELTA Pro Ultra', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 40, packs } as any,
    } as any,
  };
}

const packFull = (num: number, soc: number, inW: number, cells: number[]) => ({
  num, soc, soh: 100, actSoh: 100, inputWatts: inW, outputWatts: 0, cycles: 100,
  temp: 30, maxCellTemp: 30, minCellTemp: 30,
  cellVoltagesMv: cells,
  maxVolDiffMv: Math.max(...cells) - Math.min(...cells),
});

/** The live shape: pack 1 latched at 1% with dead cell #31 while siblings charge. */
function defectivePacks() {
  const bad = new Array(32).fill(3125); bad[30] = 3019;
  const ok = () => new Array(32).fill(3330);
  return [
    packFull(1, 1, 0, bad),
    packFull(2, 48, 420, ok()), packFull(3, 49, 380, ok()),
    packFull(4, 45, 358, ok()), packFull(5, 49, 351, ok()),
  ];
}

test('emission — the defective pack raises a standing alert that ANNUNCIATES from bench hardware', () => {
  const alerts = computeAlerts(fleet(defectivePacks()), undefined, { present: true, backstopping: true });
  const a = alerts.find((x) => x.id === `pack-defective-${BENCH_SN}-1`);
  assert.ok(a, 'the standing defective-pack alert is emitted');
  assert.notEqual(a!.annunciate, false,
    'must survive the bench-spare stamp — this is the severity inversion the alert exists to fix');
  assert.match(a!.detail, /1% SoC against a sibling median of 4[5-9]%/);
  assert.match(a!.detail, /Deviant cell #31/);
  // The ordinary per-tick families on the SAME bench device are still muted.
  const vdiff = alerts.find((x) => x.id.startsWith(`vdiff-`) && x.id.includes(BENCH_SN));
  if (vdiff) assert.equal(vdiff.annunciate, false, 'ordinary families stay demoted on bench hardware');
});

test('emission — a latched pack whose cells all AGREE does not raise it (deviant-cell leg)', () => {
  const flat = new Array(32).fill(3125);
  const ok = () => new Array(32).fill(3330);
  const packs = [
    packFull(1, 1, 0, flat),
    packFull(2, 48, 420, ok()), packFull(3, 49, 380, ok()),
    packFull(4, 45, 358, ok()), packFull(5, 49, 351, ok()),
  ];
  const alerts = computeAlerts(fleet(packs), undefined, { present: true, backstopping: true });
  assert.equal(alerts.find((x) => x.id.startsWith('pack-defective-')), undefined,
    'no meaningful deviant cell => not reported as a deviant-cell defect');
});

test('emission — a deviant cell WITHOUT a latch does not raise it (latch leg)', () => {
  // Same dead cell, but the pack is charging happily alongside its siblings —
  // this is the low-SoC-knee shape, not a defect.
  const bad = new Array(32).fill(3125); bad[30] = 3019;
  const ok = () => new Array(32).fill(3330);
  const packs = [
    packFull(1, 40, 300, bad),
    packFull(2, 48, 420, ok()), packFull(3, 49, 380, ok()),
    packFull(4, 45, 358, ok()), packFull(5, 49, 351, ok()),
  ];
  const alerts = computeAlerts(fleet(packs), undefined, { present: true, backstopping: true });
  assert.equal(alerts.find((x) => x.id.startsWith('pack-defective-')), undefined,
    'a pack accepting charge is not latched, however deviant one cell looks');
});
