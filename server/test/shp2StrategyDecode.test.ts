import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectShp2 } from '../src/ecoflow/project.js';

/**
 * v0.47.0 — Strategy-page accuracy-audit fixes.
 *
 * FIX 6 — decodeTimeScale must iterate EVERY byte of each base64 entry, not only
 *   the first. These tests PIN that today's single-byte live bitmap decodes to the
 *   SAME windows it always did (no behavior change), AND that a multi-byte entry
 *   now contributes all of its slots (the robustness gain).
 *
 * FIX 1(b) — the strategy tile's backupReserveSoc must decode IDENTICALLY to the
 *   top-level projection.backupReserveSoc (the flat `backupReserveSoc` key — the
 *   exact field the floor alarm defends with). A pd303_mc.* override must NOT be
 *   able to make the tile disagree with the alarm.
 */

// The exact live SHP2 timeScale.sta bitmap (HD31ZASAHH120432, 18 single-byte
// base64 entries → 144 slots @ 10-min). Two active runs: bytes 8-10 = 0xff (24
// contiguous slots, 640–880) and byte 11 = 0x03 (two slots, 940–960).
const LIVE_STA = [
  'AA==', 'AA==', 'AA==', 'AA==', 'AA==', 'AA==', 'AA==', 'AA==',
  '/w==', '/w==', '/w==', 'Aw==', 'AA==', 'AA==', 'AA==', 'AA==', 'AA==', 'AA==',
];

function quotaWith(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'pd303_mc.TimeTaskCfg1.comCfg.type': 'CHARGE_TIME_TASK',
    'pd303_mc.TimeTaskCfg1.comCfg.isEnable': false,
    'pd303_mc.TimeTaskCfg1.comCfg.timeRange.isEnable': true,
    'pd303_mc.TimeTaskCfg1.comCfg.timeScale.sta': LIVE_STA,
    ...extra,
  };
}

test('v0.89.0 — gridSta (pd303_mc.masterIncreInfo.gridSta) parses raw + VALUE-1-ONLY gridConnected', () => {
  // Grid OK (live captured value on HD31ZASAHH120432: gridSta=1, gridVol=123).
  let p = projectShp2(quotaWith({ 'pd303_mc.masterIncreInfo.gridSta': 1 }));
  assert.equal(p.gridSta, 1);
  assert.equal(p.gridConnected, true, 'gridSta=1 → connected');
  // Grid gone.
  p = projectShp2(quotaWith({ 'pd303_mc.masterIncreInfo.gridSta': 0 }));
  assert.equal(p.gridSta, 0);
  assert.equal(p.gridConnected, false, 'gridSta=0 → not connected');
  // Energized but out-of-spec → SHP2 islands onto EPS → NOT a safe backstop → false.
  p = projectShp2(quotaWith({ 'pd303_mc.masterIncreInfo.gridSta': 2 }));
  assert.equal(p.gridSta, 2);
  assert.equal(p.gridConnected, false, 'gridSta=2 (overvolt/overfreq) is NOT a backstop — value-1-only');
  // Absent (older firmware / partial quota) → unknown, never fabricated.
  p = projectShp2(quotaWith());
  assert.equal(p.gridSta, null);
  assert.equal(p.gridConnected, null, 'absent gridSta → unknown');
});

test('FIX 6 — live single-byte bitmap decodes to the same windows (no behavior change)', () => {
  const p = projectShp2(quotaWith());
  assert.equal(p.strategy.timeTask?.slotMinutes, 10);
  assert.deepEqual(p.strategy.timeTask?.windows, [
    { startMinute: 640, endMinute: 880 },
    { startMinute: 940, endMinute: 960 },
  ]);
});

test('FIX 6 — a multi-byte entry contributes ALL its bytes, not just the first', () => {
  // Single entry, two bytes: 0x00 then 0xff. Old [0]-only path would have decoded
  // just the first byte (all-zero → no window). With full iteration, the 8 set
  // bits of the second byte form one window spanning slots 8..15.
  const sta = [Buffer.from([0x00, 0xff]).toString('base64')];
  const p = projectShp2(quotaWith({ 'pd303_mc.TimeTaskCfg1.comCfg.timeScale.sta': sta }));
  // 2 bytes × 8 = 16 slots over 24h → 90-min slots.
  assert.equal(p.strategy.timeTask?.slotMinutes, 90);
  assert.deepEqual(p.strategy.timeTask?.windows, [{ startMinute: 8 * 90, endMinute: 16 * 90 }]);
});

test('FIX 1b — strategy reserve == top-level projection reserve (the alarm field)', () => {
  const p = projectShp2(quotaWith({ backupReserveSoc: 10 }));
  assert.equal(p.backupReserveSoc, 10);
  assert.equal(p.strategy.backupReserveSoc, 10);
  assert.equal(p.strategy.backupReserveSoc, p.backupReserveSoc);
});

test('FIX 1b — a divergent pd303_mc.backupReserveSoc CANNOT make the tile disagree with the alarm', () => {
  // If the cloud ever populated the pd303_mc.* variant differently, both the
  // tile (strategy) and the alarm (projection) must still read the SAME flat key.
  const p = projectShp2(
    quotaWith({ backupReserveSoc: 10, 'pd303_mc.backupReserveSoc': 99 }),
  );
  assert.equal(p.backupReserveSoc, 10, 'projection reads the flat key');
  assert.equal(p.strategy.backupReserveSoc, 10, 'strategy must read the SAME flat key, not pd303_mc.*');
  assert.equal(p.strategy.backupReserveSoc, p.backupReserveSoc);
});
