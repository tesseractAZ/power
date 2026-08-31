import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHomePoolDpu, homeFleetMeanSoc } from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.117.0 — the last-known roster, and the audible replay it prevents.
 *
 * INCIDENT (2026-08-29). Both deploys replayed an already-announced 30% SoC rung
 * to the speakers. On the first tick after a boot the SHP2 projection is not yet
 * hydrated, so the connected-source roster reads EMPTY; membership then fell
 * through to the static SPARE_DPU_SNS literal, which has been stale since the
 * 08-20 swap moved Core 3 off-panel without adding it. The off-panel Core 3
 * (75%) was averaged into the pool mean while the real pool sat at 21%; that
 * phantom re-armed the 50/40/30 rungs, the true 21% was then rejected by the
 * slew guard for exactly 10 minutes, and on expiry three rungs crossed at once
 * and announced. Reproduced identically on both boots, 10m01s after each.
 *
 * The roster is durable STATE. Remember it instead of re-guessing from a
 * hardcoded list every time the panel goes quiet.
 */

const CORE1 = 'Y711ZAB59GBC0314';   // home pool
const CORE2 = 'Y711ZAB59GBC0482';   // home pool
const CORE5 = 'Y711ZAB59G9P0090';   // home pool (took slot 3 on 08-20)
const CORE3 = 'Y711FAB59J234000';   // OFF-PANEL since 08-20, NOT in SPARE_DPU_SNS
const LAST_KNOWN = new Set([CORE1, CORE2, CORE5]);

const dpu = (sn: string, soc: number, online = true): DeviceSnapshot => ({
  sn, deviceName: sn, productName: 'DELTA Pro Ultra', online, lastSeenMs: Date.now(),
  projection: { kind: 'dpu', soc } as any,
} as any);

test('live roster wins whenever it is populated', () => {
  const live = new Set([CORE1, CORE2, CORE5]);
  assert.equal(isHomePoolDpu(CORE1, live, LAST_KNOWN), true);
  assert.equal(isHomePoolDpu(CORE3, live, LAST_KNOWN), false, 'off-panel stays out');
});

test('★ empty live roster uses the LAST-KNOWN roster, not the stale literal', () => {
  const empty = new Set<string>();
  assert.equal(isHomePoolDpu(CORE3, empty, LAST_KNOWN), false,
    'the off-panel Core 3 must not re-enter the pool during boot hydration');
  assert.equal(isHomePoolDpu(CORE1, empty, LAST_KNOWN), true);
});

test('the stale literal is still the last resort when nothing is known', () => {
  const empty = new Set<string>();
  // No history yet (first ever boot): fall back to the literal, as before.
  assert.equal(isHomePoolDpu(CORE3, empty, new Set()), true, 'literal admits Core 3 — the old behaviour');
  assert.equal(isHomePoolDpu(CORE3, empty, null), true);
  assert.equal(isHomePoolDpu(CORE3, empty, undefined), true);
});

test('★ THE REPLAY KILL: an unhydrated tick yields NO pool SoC instead of a bench spare’s', () => {
  // Exactly the 08-29 boot shape: only the off-panel Core 3 has a projection.
  const devices = { [CORE3]: dpu(CORE3, 75) };
  assert.equal(homeFleetMeanSoc(devices, LAST_KNOWN), null,
    'null is a safe no-op for the ladder; 75 re-arms the rungs and replays the alarm');
  // The pre-fix behaviour, for the record:
  assert.equal(homeFleetMeanSoc(devices), 75, 'without the roster the phantom gets through');
});

test('the SHP2-blind failover still works — that is what the fallback is FOR', () => {
  // SHP2 cloud-offline (no shp2 projection ⇒ empty roster), home Cores reporting.
  const devices = {
    [CORE1]: dpu(CORE1, 21), [CORE2]: dpu(CORE2, 21), [CORE5]: dpu(CORE5, 20),
    [CORE3]: dpu(CORE3, 75),
  };
  const mean = homeFleetMeanSoc(devices, LAST_KNOWN);
  assert.ok(mean != null && Math.abs(mean - 20.667) < 0.01,
    `pool mean must exclude the bench spare, got ${mean}`);
  assert.ok(mean! < 22, 'the v1.92.0 bench-floor bug must not return');
});

test('offline home Cores are excluded; an all-offline pool yields null', () => {
  const devices = {
    [CORE1]: dpu(CORE1, 21, false), [CORE2]: dpu(CORE2, 21, false), [CORE5]: dpu(CORE5, 20, false),
    [CORE3]: dpu(CORE3, 75),
  };
  assert.equal(homeFleetMeanSoc(devices, LAST_KNOWN), null,
    'a bench spare must never stand in for an offline pool');
});
