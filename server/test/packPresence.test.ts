import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prunePhantomPacks, freshPackSlotHistory, packFingerprint, PACK_STALE_MS } from '../src/packPresence.js';

/**
 * v1.172.0 — a physically removed pack stops being shown.
 * 2026-09-20: the defective Core 4 pack 1 was pulled; the Core renumbered the rest as 1-4
 * (bpNum=4) while the panel showed 5 packs — slot 5 frozen at 55% / 84 °F with the SAME
 * packSn as slot 4, because the cached raw quota never forgets a slot.
 */

const M = 60_000;
const pk = (num: number, soc: number, mv: number) =>
  ({ num, soc, packVoltageMv: mv, maxCellVoltageMv: mv, minCellVoltageMv: mv - 5, temp: 30, cellVoltagesMv: [mv], cellTemps: [30] } as any);

/** Five slots; slots in `live` move every minute, the others stay frozen. */
function run(minutes: number, live: number[], packCount: number | null, hist = freshPackSlotHistory(), t0 = 0) {
  let last: ReturnType<typeof prunePhantomPacks> | null = null;
  for (let m = 0; m <= minutes; m++) {
    const packs = [1, 2, 3, 4, 5].map((n) => live.includes(n) ? pk(n, 70, 3330 + (m % 7)) : pk(n, 55, 3328));
    last = prunePhantomPacks(packs, packCount, hist, t0 + m * M);
  }
  return last!;
}

test('★★★ Core 4, 2026-09-20: pack 1 pulled, the rest renumbered 1-4 — the frozen slot 5 is hidden', () => {
  const r = run(30, [1, 2, 3, 4], 4);
  assert.deepEqual(r.packs.map((p) => p.num), [1, 2, 3, 4]);
  assert.deepEqual(r.dropped.map((d) => d.num), [5]);
  assert.equal(r.dropped[0].frozenSinceMs, 0, 'frozen since it was first seen');
});

test('★★★ right after a restart nothing is hidden until the live packs actually move', () => {
  // Every slot is "first seen" at the same instant: no evidence yet which one is gone.
  const hist = freshPackSlotHistory();
  const packs = [1, 2, 3, 4, 5].map((n) => pk(n, 55, 3328));
  assert.equal(prunePhantomPacks(packs, 4, hist, 0).packs.length, 5);
  assert.equal(prunePhantomPacks(packs, 4, hist, PACK_STALE_MS + M).packs.length, 5,
    'all frozen alike (no live change) — ambiguous, so nothing is hidden');
  // Once the live four move, the frozen fifth is hidden after the stale window.
  assert.equal(run(PACK_STALE_MS / M - 1, [1, 2, 3, 4], 4).packs.length, 5, 'not before the window');
  assert.equal(run(PACK_STALE_MS / M + 1, [1, 2, 3, 4], 4).packs.length, 4);
});

test('★★★ never prunes without a positive pack count from the Core (null, or a transient 0)', () => {
  assert.equal(run(60, [1, 2, 3, 4], null).packs.length, 5);
  assert.equal(run(60, [1, 2, 3, 4], 0).packs.length, 5, 'the reconnect-zero trap');
  assert.equal(run(60, [1, 2, 3, 4], 5).packs.length, 5, 'count matches the slots');
});

test('★★ a MIDDLE slot removed is found by its frozen readings, not by position', () => {
  const r = run(30, [1, 3, 4, 5], 4);
  assert.deepEqual(r.packs.map((p) => p.num), [1, 3, 4, 5]);
  assert.deepEqual(r.dropped.map((d) => d.num), [2]);
});

test('★★ a pack that starts reporting again (re-inserted) is shown again', () => {
  const hist = freshPackSlotHistory();
  run(30, [1, 2, 3, 4], 4, hist);
  const back = [1, 2, 3, 4, 5].map((n) => pk(n, n === 5 ? 60 : 70, 3335));
  const r = prunePhantomPacks(back, 5, hist, 31 * M);
  assert.equal(r.packs.length, 5, 'the Core counts it again and it moved');
});

test('★★ a slot quiet for a while but with packs of similar age is NOT hidden (differentiation required)', () => {
  // Slot 5 froze at minute 4; the live four went quiet (at rest) at minute 7 — a 3-minute
  // gap, not enough separation to call slot 5 gone.
  const hist = freshPackSlotHistory();
  const at = (m: number) => [1, 2, 3, 4, 5].map((n) =>
    pk(n, 70, n === 5 ? (m < 4 ? 3330 + m : 3328) : (m < 7 ? 3330 + m : 3350)));
  for (let m = 0; m <= 60; m++) prunePhantomPacks(at(m), 4, hist, m * M);
  const quiet = at(60);
  assert.ok(hist.changedMs.get(1)! - hist.changedMs.get(5)! < PACK_STALE_MS);
  assert.equal(prunePhantomPacks(quiet, 4, hist, 61 * M).packs.length, 5);
});

test('the fingerprint moves with any live reading', () => {
  const a = pk(1, 70, 3330);
  assert.notEqual(packFingerprint(a), packFingerprint({ ...a, temp: 31 }));
  assert.notEqual(packFingerprint(a), packFingerprint({ ...a, cellVoltagesMv: [3331] }));
  assert.equal(packFingerprint(a), packFingerprint({ ...a }));
});

test('★★★ snapshot.ts applies it after EVERY projection (REST refresh and MQTT merge)', () => {
  const SNAP = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/snapshot.ts'), 'utf8');
  const sites = SNAP.split('cur.projection = projectByProduct(').length - 1;
  const hides = SNAP.split('this.hidePhantomPacks(sn, cur);').length - 1;
  assert.equal(sites, 2);
  assert.equal(hides, 2, 'both projection sites hide phantom packs');
  assert.ok(SNAP.includes('prunePhantomPacks(proj.packs, proj.packCount ?? null, hist, this.now())'));
});

test('★★★ a repeated packSn marks the older slot as a renumbered ghost — even with no pack count', () => {
  const hist = freshPackSlotHistory();
  let r: ReturnType<typeof prunePhantomPacks> | null = null;
  for (let m = 0; m <= 30; m++) {
    const packs = [1, 2, 3, 4, 5].map((n) => {
      const p = n === 5 ? pk(5, 55, 3328) : pk(n, 70, 3330 + (m % 7));
      p.packSn = n === 4 || n === 5 ? 'SN-DUP-4' : `SN-${n}`;
      return p;
    });
    r = prunePhantomPacks(packs, null, hist, m * M);
  }
  assert.deepEqual(r!.packs.map((p) => p.num), [1, 2, 3, 4], 'slot 5 repeats slot 4\'s serial and is frozen');
  assert.deepEqual(r!.dropped.map((d) => d.num), [5]);
});

test('★★ two slots sharing a serial are both kept while both are LIVE', () => {
  const hist = freshPackSlotHistory();
  let r: ReturnType<typeof prunePhantomPacks> | null = null;
  for (let m = 0; m <= 30; m++) {
    const packs = [1, 2].map((n) => { const p = pk(n, 70, 3330 + (m % 7) + n); p.packSn = 'SAME'; return p; });
    r = prunePhantomPacks(packs, null, hist, m * M);
  }
  assert.equal(r!.packs.length, 2, 'the serial rule never hides a slot that is still moving');
});
