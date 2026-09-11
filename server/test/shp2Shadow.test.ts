import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shp2ContentWitness,
  advanceContentFreshness,
  isContentStale,
  SHP2_SHADOW_MIN_REPEATS,
  SHP2_SHADOW_MIN_MS,
} from '../src/shp2Shadow.js';
import { computeHomeGridWatts, computeShp2GridConnected } from '../src/gridState.js';

/**
 * v1.142.0 — the cloud shadow.
 *
 * THE OBSERVED DEFECT (2026-09-08 and 09-09, both nights): the SHP2's gridWatt —
 * the grid-presence alarm input — held ONE value for 16.0 min and 14.5 min while
 * the 60 s REST poll returned 200 OK sixteen times in a row, inside armed
 * night-charge windows with 4-7 kW flowing. Zero fetch failures, poll_health ok,
 * /api/health blind:false. The add-on did nothing wrong; EcoFlow's cloud served a
 * replayed body and our gates all key on the fetch, not the content.
 */

const chans = (watts: (number | null)[]) =>
  ({ kind: 'shp2', circuits: watts.map((w, i) => ({ ch: i + 1, watts: w })), gridWatt: 3914, backupBatPercent: 49, backupRemainWh: 45000 });

const LIVE = chans([0, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60]);

test('a witness is formed from the twelve-channel vector plus the scalars', () => {
  const w = shp2ContentWitness(LIVE);
  assert.ok(w && w.includes('1:0') && w.includes('12:60') && w.includes('g=3914'));
});

test('★ one moving leg is enough to move the witness — a scalar alone is not', () => {
  // grid_power_home legitimately holds 0 W for 12.5+ h on a sunny day, so a rule
  // built on it could only ever fire falsely. Over 1,558 sampled minutes of live
  // history the full twelve-channel vector never held identical for ONE minute.
  const solarNoon = { ...LIVE, gridWatt: 0 };
  const a = shp2ContentWitness(solarNoon)!;
  const b = shp2ContentWitness({ ...solarNoon, circuits: solarNoon.circuits.map((c, i) => i === 2 ? { ...c, watts: 105 } : c) })!;
  assert.notEqual(a, b, 'a single leg moving by 1 W must move the witness');
  assert.equal(shp2ContentWitness({ ...solarNoon, gridWatt: 0 }), a, 'an unchanged panel yields an identical witness');
});

test('a non-SHP2, or a payload with no circuits, yields NO witness — fail open', () => {
  assert.equal(shp2ContentWitness({ kind: 'dpu', circuits: [{ ch: 1, watts: 5 }] }), null);
  assert.equal(shp2ContentWitness({ kind: 'shp2', circuits: [] }), null);
  assert.equal(shp2ContentWitness({ kind: 'shp2' }), null);
  assert.equal(shp2ContentWitness(undefined), null);
});

test('★ an unmeasurable poll RESETS rather than accumulating toward stale', () => {
  // A partial payload is not evidence of a shadow. Accumulating on it would let
  // a run of degraded responses assert a freeze that never happened.
  let f = advanceContentFreshness(undefined, 'w', 0);
  f = advanceContentFreshness(f, 'w', 60_000);
  assert.equal(f!.repeats, 2);
  f = advanceContentFreshness(f, null, 120_000);
  assert.equal(f, undefined, 'a null witness clears the state');
});

test('repeats accumulate against the FIRST sighting, not the last', () => {
  let f = advanceContentFreshness(undefined, 'w', 1_000);
  for (let i = 1; i <= 9; i++) f = advanceContentFreshness(f, 'w', 1_000 + i * 60_000);
  assert.equal(f!.repeats, 10);
  assert.equal(f!.firstSeenMs, 1_000, 'the clock runs from when the payload stopped moving');
});

test('a changed witness restarts the clock', () => {
  let f = advanceContentFreshness(undefined, 'a', 0);
  f = advanceContentFreshness(f, 'a', 60_000);
  f = advanceContentFreshness(f, 'b', 120_000);
  assert.equal(f!.repeats, 1);
  assert.equal(f!.firstSeenMs, 120_000);
});

test('★ staleness requires BOTH a repeat count and a duration', () => {
  // Neither a burst of fast polls nor one long gap may assert a shadow alone.
  const many = { witness: 'w', firstSeenMs: 0, repeats: SHP2_SHADOW_MIN_REPEATS };
  assert.equal(isContentStale(many, SHP2_SHADOW_MIN_MS - 1), false, 'enough repeats, too soon');
  assert.equal(isContentStale(many, SHP2_SHADOW_MIN_MS), true, 'boundary is inclusive');
  const few = { witness: 'w', firstSeenMs: 0, repeats: SHP2_SHADOW_MIN_REPEATS - 1 };
  assert.equal(isContentStale(few, 10 * SHP2_SHADOW_MIN_MS), false, 'long enough, too few polls');
  assert.equal(isContentStale(undefined, 1e12), false, 'no state is never stale');
});

test('★ THE INCIDENT: sixteen identical 60 s polls read as stale', () => {
  let f = advanceContentFreshness(undefined, shp2ContentWitness(LIVE), 0);
  for (let i = 1; i < 16; i++) f = advanceContentFreshness(f, shp2ContentWitness(LIVE), i * 60_000);
  assert.equal(f!.repeats, 16);
  assert.equal(isContentStale(f, 15 * 60_000), true);
});

// ── the alarm path ───────────────────────────────────────────────────────────
const fleet = (over: Record<string, unknown>) => ({
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
    online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', gridWatt: 7800, gridConnected: true },
    ...over,
  },
}) as never;

test('★ a SHADOWED panel contributes no grid flow and asserts no presence', () => {
  // v0.88.0 names the consequence exactly: a frozen-high gridWatt keeps
  // importLive=true → backstopping=true → silently MUTES a real at-floor outage.
  // It guarded the offline door; this is the same freeze through the online one.
  assert.equal(computeHomeGridWatts(fleet({ contentStaleSinceMs: Date.now() - 900_000 })), 0);
  assert.equal(computeShp2GridConnected(fleet({ contentStaleSinceMs: Date.now() - 900_000 })), null);
});

test('a healthy panel is completely unaffected', () => {
  assert.equal(computeHomeGridWatts(fleet({ contentStaleSinceMs: null })), 7800);
  assert.equal(computeShp2GridConnected(fleet({ contentStaleSinceMs: null })), true);
  assert.equal(computeHomeGridWatts(fleet({})), 7800, 'an absent field means moving');
});

test('the offline guard still works on its own', () => {
  assert.equal(computeHomeGridWatts(fleet({ online: false })), 0);
  assert.equal(computeShp2GridConnected(fleet({ online: false })), null);
});
