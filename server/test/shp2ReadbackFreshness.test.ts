import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shp2ReadbackFresh, SHP2_READBACK_STALE_MS } from '../src/shp2Membership.js';

/**
 * v1.140.0 — R3: a CONTROL READBACK must be a live reading, never a frozen one.
 *
 * `setDeviceList` preserves `projection` VERBATIM across an offline transition,
 * by design. The night-charge actuator compares `backupReserveSoc` to its target
 * by STRICT EQUALITY to decide whether a write landed, so over one cloud-dark
 * night a frozen pre-write value never equals the target: `retryApply`, then
 * `applyFailed` — a critical push saying the write NEVER TOOK EFFECT. The
 * scheduled revert then finds `currentReservePct === priorReservePct` and stamps
 * `revertVerified` for a revert no device confirmed. Frozen at the raised target
 * instead, the revert escalates to `revertFailed`: a spoken bilingual CRITICAL
 * broadcast, from a sample that may be hours old.
 *
 * `gridState.ts` already applies this gate to sibling fields on the same
 * projection, for the same stated reason. This shares it so the two cannot drift.
 */
const NOW = 1_788_900_000_000;

test('★ an OFFLINE panel is never a readback, however fresh its sample looks', () => {
  assert.equal(shp2ReadbackFresh({ online: false, lastUpdated: NOW }, NOW), false);
});

test('★ an online panel whose sample is stale is not a readback either', () => {
  assert.equal(shp2ReadbackFresh({ online: true, lastUpdated: NOW - SHP2_READBACK_STALE_MS - 1 }, NOW), false);
});

test('an online panel with a fresh sample IS a readback', () => {
  assert.equal(shp2ReadbackFresh({ online: true, lastUpdated: NOW - 30_000 }, NOW), true);
});

test('the staleness boundary is inclusive', () => {
  assert.equal(shp2ReadbackFresh({ online: true, lastUpdated: NOW - SHP2_READBACK_STALE_MS }, NOW), true);
});

test('★ lastUpdated 0 — never successfully fetched — is not a readback', () => {
  // Live right now: four accessory devices report online:true with lastUpdated:0.
  // The far-future NOW makes a naive `now - 0 <= staleMs` fail by accident, which
  // hides the bug; the SECOND case is the discriminating one — early in an epoch
  // (or on a device whose clock has not advanced) a zero would read as FRESH.
  assert.equal(shp2ReadbackFresh({ online: true, lastUpdated: 0 }, NOW), false);
  assert.equal(
    shp2ReadbackFresh({ online: true, lastUpdated: 0 }, 100_000), false,
    'zero means NEVER FETCHED, not "timestamp 0, which happens to be recent"',
  );
  assert.equal(shp2ReadbackFresh({ online: true, lastUpdated: -1 }, 100_000), false);
});

test('a missing device, or one with no lastUpdated, is not a readback', () => {
  assert.equal(shp2ReadbackFresh(undefined, NOW), false);
  assert.equal(shp2ReadbackFresh(null, NOW), false);
  assert.equal(shp2ReadbackFresh({ online: true }, NOW), false);
  assert.equal(shp2ReadbackFresh({ online: true, lastUpdated: NaN }, NOW), false);
});

test('online must be exactly true — undefined is not permission', () => {
  assert.equal(shp2ReadbackFresh({ lastUpdated: NOW }, NOW), false);
});

// ── the production bridge ────────────────────────────────────────────────────
test('★ BRIDGE: the night-charge actuator actually gates its readback', () => {
  // The predicate can be perfect and the actuator inert. runNightActuationTickInner
  // is not reachable from a test (it closes over the live store and the actuation
  // state machine), so this is a source pin — the convention this repo uses for
  // exactly that situation.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  const i = src.indexOf('async function runNightActuationTickInner');
  assert.ok(i > 0, 'actuator tick located');
  const body = src.slice(i, src.indexOf('const gridNow = liveGridBackstop', i));
  assert.match(
    body, /shp2ReadbackFresh\(shp2, nowMs\)/,
    'the actuator must resolve its SHP2 projection through shp2ReadbackFresh — a frozen sample drives applyFailed/revertFailed verdicts, and revertFailed SPEAKS a bilingual critical broadcast',
  );
});
