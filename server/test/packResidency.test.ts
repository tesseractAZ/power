import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.102.0 — pack identity travels with the hardware.
 *
 * MOTIVATING INCIDENT (2026-08-20). Alert ids are keyed (chassis, slot), which
 * is stable and cheap right up until the thing in that slot is replaced. A
 * physical pack swap carried `vdiff-crit-<sn>-1` straight through with NO
 * resolve and NO re-raise — its detail silently changed from "Deviant cell #31
 * (-105 mV)" to "cell #32 (-84 mV)" mid-episode, so one cleared-alert record
 * described two different batteries. That record is the RMA evidence trail.
 *
 * The BMS reports packSn on every read; stamping it lets the monitor tell
 * "this condition continues" from "this is different hardware".
 */

const SN = 'Y711ZABA9H3T0489';

function deviceWith(packSn: string): Record<string, DeviceSnapshot> {
  const bad = new Array(32).fill(3125); bad[30] = 3019;   // 106 mV deviant cell
  const ok = () => new Array(32).fill(3330);
  const mk = (num: number, soc: number, inW: number, cells: number[], psn: string) => ({
    num, soc, soh: 100, actSoh: 100, inputWatts: inW, outputWatts: 0, cycles: 100,
    temp: 30, maxCellTemp: 30, minCellTemp: 30, packSn: psn,
    cellVoltagesMv: cells, maxVolDiffMv: Math.max(...cells) - Math.min(...cells),
  });
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 4', productName: 'DELTA Pro Ultra', online: true, lastSeenMs: Date.now(),
      projection: {
        kind: 'dpu', soc: 40,
        packs: [
          mk(1, 1, 0, bad, packSn),
          mk(2, 48, 420, ok(), 'SIB-2'), mk(3, 49, 380, ok(), 'SIB-3'),
          mk(4, 45, 358, ok(), 'SIB-4'), mk(5, 49, 351, ok(), 'SIB-5'),
        ],
      } as any,
    } as any,
  };
}

const grid = { present: true, backstopping: true };

test('pack-scoped alerts carry the physical pack serial', () => {
  const alerts = computeAlerts(deviceWith('PACK-A'), undefined, grid);
  const scoped = alerts.filter((a) => a.packNum === 1 && a.id.includes(SN));
  assert.ok(scoped.length > 0, 'slot 1 raised something');
  for (const a of scoped) {
    assert.equal(a.sourcePackSn, 'PACK-A', `${a.id} must name the pack it is about`);
  }
});

test('the SAME slot with DIFFERENT hardware is distinguishable — id alone is not enough', () => {
  const before = computeAlerts(deviceWith('PACK-A'), undefined, grid).filter((a) => a.packNum === 1);
  const after = computeAlerts(deviceWith('PACK-B'), undefined, grid).filter((a) => a.packNum === 1);
  const idsBefore = before.map((a) => a.id).sort();
  const idsAfter = after.map((a) => a.id).sort();
  assert.deepEqual(idsAfter, idsBefore, 'ids are slot-keyed, so they are IDENTICAL across the swap');
  // ...which is exactly why the serial is required to tell the episodes apart.
  assert.notEqual(before[0].sourcePackSn, after[0].sourcePackSn);
  assert.equal(before[0].sourcePackSn, 'PACK-A');
  assert.equal(after[0].sourcePackSn, 'PACK-B');
});

test('sibling packs each carry their own serial, not slot 1\'s', () => {
  const alerts = computeAlerts(deviceWith('PACK-A'), undefined, grid);
  for (const a of alerts) {
    if (a.packNum == null || !a.id.includes(SN)) continue;
    if (a.packNum === 1) assert.equal(a.sourcePackSn, 'PACK-A');
    else assert.equal(a.sourcePackSn, `SIB-${a.packNum}`, `${a.id} names its own pack`);
  }
});
