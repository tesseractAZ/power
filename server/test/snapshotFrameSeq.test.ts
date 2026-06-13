import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot.js';

/* ===================================================================
 * v0.20.0 — per-emit frame sequence (the WS serialize-once memo).
 *
 * The /ws handler serializes the snapshot frame once per `store.frameSeq`
 * and reuses the bytes across all connected clients. These tests pin the
 * two preconditions that make that exact:
 *   (1) frameSeq bumps exactly once per 'change' emit (not per listener,
 *       not per millisecond);
 *   (2) every listener within ONE emit sees the SAME snap reference AND
 *       the same frameSeq — so one JSON.stringify is byte-correct for all.
 * =================================================================== */

const dev = (sn: string, online: 0 | 1) =>
  ({ sn, deviceName: sn, productName: 'Delta Pro Ultra', online }) as any;

test('frameSeq bumps exactly once per change emit', () => {
  const store = new SnapshotStore();
  assert.equal(store.frameSeq, 0);
  store.setDeviceList([dev('A', 1)]);           // 1 emit
  const a = store.frameSeq;
  assert.equal(a, 1);
  store.setDeviceOnline('A', false);            // 1 emit (state changed)
  assert.equal(store.frameSeq, 2);
  store.setDeviceOnline('A', false);            // NO emit (unchanged) → no bump
  assert.equal(store.frameSeq, 2);
});

test('all listeners in one emit see the SAME snap reference + frameSeq (memo precondition)', () => {
  const store = new SnapshotStore();
  store.setDeviceList([dev('A', 1)]);
  const seen: Array<{ snap: unknown; seq: number }> = [];
  for (let i = 0; i < 3; i++) store.on('change', (snap) => seen.push({ snap, seq: store.frameSeq }));
  store.setDeviceOnline('A', false);            // one emit → all 3 listeners synchronously
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.snap === seen[0].snap), 'same snapshot object for every listener');
  assert.ok(seen.every((s) => s.seq === seen[0].seq), 'same frameSeq for every listener');
});

test('frameSeq-keyed serialize runs once per emit and refreshes on the next', () => {
  const store = new SnapshotStore();
  store.setDeviceList([dev('A', 1)]);
  let serializeCount = 0;
  let cacheSeq = -1;
  let cacheStr = '';
  const frame = () => {
    if (store.frameSeq !== cacheSeq) { serializeCount++; cacheStr = JSON.stringify(store.get()); cacheSeq = store.frameSeq; }
    return cacheStr;
  };
  store.setDeviceOnline('A', false);            // emit
  const a = frame(), b = frame(), c = frame();  // 3 "clients" in this emit
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(serializeCount, 1, 'one serialize for 3 reads at the same frameSeq');
  store.setDeviceOnline('A', true);             // next emit
  frame();
  assert.equal(serializeCount, 2, 'a new emit triggers exactly one more serialize');
});
