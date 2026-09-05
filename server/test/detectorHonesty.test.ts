import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInverterIdleSample,
  idleFloorWatts,
  dailyIdleFloors,
  INVERTER_IDLE_PV_DARK_W,
  INVERTER_IDLE_AC_MAX_W,
} from '../src/analytics.js';
import { replaySeedExemplar, familyMetaFor } from '../src/alertMonitor.js';
import { rateFloorSampleSet } from '../src/messageRateFloor.js';
import { dispatchMobilePush, getLastPushFailures, resetLastPushFailures } from '../src/notify.js';
import {
  decideActuation,
  emptyActuationState,
  REVERT_VERIFY_AFTER_MS,
  REVERT_MAX_RETRIES,
  type NightActuationState,
  type ActuationTickOpts,
} from '../src/nightChargeActuator.js';

/**
 * v1.131.0 — three signals that were being published without being earned.
 *
 *  1. The inverter-standby detector ANDed itself off against a whole-house
 *     load gate no occupied house can satisfy.
 *  2. The alert-telemetry exemplar paired one device's id with another's title.
 *  3. The night-charge revert closed on a cloud ACK, the exact evidence
 *     v1.79.0 ruled insufficient on the apply side.
 */

/* ══ 1. the inverter-standby detector could not fire ═════════════════════ */

test('THE MEASURED DEFECT: an occupied house never satisfied the old gate', () => {
  // The old conjunct was `pv < 20 && load < 20 && 0 < ac_out < 200`, where
  // `load` is the SHP2's whole-panel draw. Live 7-day mean panel_load is
  // 1,445 W and the backup circuits never go quiet, so `load < 20` was false
  // at every sample and every DPU reported idleWatts: null forever.
  const houseAtNight = 1_445;
  assert.equal(houseAtNight < 20, false, 'premise: the panel is never dark');
  // The corrected gate does not consult the house at all.
  assert.equal(isInverterIdleSample({ pvW: 0, acOutW: 48 }), true);
});

test('both surviving conditions are about THIS DPU', () => {
  assert.equal(isInverterIdleSample({ pvW: INVERTER_IDLE_PV_DARK_W, acOutW: 48 }), false, 'PV lit → not a night sample');
  assert.equal(isInverterIdleSample({ pvW: INVERTER_IDLE_PV_DARK_W - 1, acOutW: 48 }), true);
  assert.equal(isInverterIdleSample({ pvW: 0, acOutW: 0 }), false, 'inverter off is not standby');
  assert.equal(isInverterIdleSample({ pvW: 0, acOutW: INVERTER_IDLE_AC_MAX_W }), false, 'at the ceiling → real load');
  assert.equal(isInverterIdleSample({ pvW: 0, acOutW: INVERTER_IDLE_AC_MAX_W - 1 }), true);
});

test('★ the gate is monotone in ac_out — no window can be skipped', () => {
  // Exhaustive over the standby window: every watt in (0, 200) qualifies when
  // PV is dark, and nothing outside it does. A mutant that flips a comparison
  // or narrows the window changes at least one of these.
  for (let w = -5; w <= 205; w++) {
    const expected = w > 0 && w < INVERTER_IDLE_AC_MAX_W;
    assert.equal(isInverterIdleSample({ pvW: 0, acOutW: w }), expected, `ac_out=${w}`);
  }
});

test('the headline is the FLOOR of the window, not its middle', () => {
  // A realistic night on a DPU that carries a few small circuits: three samples
  // reach the true standby floor (~45 W) and the rest sit on real load inside
  // the 200 W window. Without the (unreachable) whole-house gate a median
  // reports the LOAD, not the inverter.
  const watts = [44, 45, 45, 120, 130, 150, 160, 170, 180, 190];
  assert.equal(idleFloorWatts(watts), 45, 'p10 lands on the quiet bottom');
  const median = (watts[4] + watts[5]) / 2;
  assert.equal(median, 140, 'the statistic this replaced would have published 140 W');
  // ...and the floor tracks a genuine rise in the inverter's own overhead.
  assert.equal(idleFloorWatts(watts.map((w) => w + 12)), 57);
});

test('idleFloorWatts is null-safe and never indexes past the end', () => {
  assert.equal(idleFloorWatts([]), null);
  assert.equal(idleFloorWatts([73]), 73, 'a single sample IS its own floor');
  assert.equal(idleFloorWatts([90, 10]), 10, 'unsorted input still yields the low end');
});

/* ── daily floors: the series the trend is actually fitted to ───────────── */

const DAY = 86_400_000;

test('★ a Phoenix night lands inside ONE bucket', () => {
  // MST is UTC-7 with no DST, so 19:00 -> 06:00 local is 02:00 -> 13:00 UTC on
  // a single UTC date. A local-midnight bucket would split every night in two
  // and halve the sample count on both sides of the boundary.
  const utcDay = 20_000;
  const at = (utcHour: number) => utcDay * DAY + utcHour * 3_600_000;
  const night = [at(2), at(6), at(9), at(13)].map((ts) => ({ ts, w: 50 }));
  const floors = dailyIdleFloors(night);
  assert.equal(floors.length, 1, 'one night, one floor');
  assert.equal(floors[0].ts, utcDay * DAY);
});

test('a thin night contributes no floor rather than a noisy one', () => {
  const utcDay = 20_001;
  const thin = [{ ts: utcDay * DAY + 3_600_000, w: 50 }, { ts: utcDay * DAY + 7_200_000, w: 51 }];
  assert.deepEqual(dailyIdleFloors(thin), [], 'two samples is below minPerDay=3');
  assert.equal(dailyIdleFloors(thin, 2).length, 1, 'the threshold is a parameter, not a constant');
});

test('floors come back in chronological order regardless of input order', () => {
  const mk = (day: number, w: number) =>
    [0, 1, 2].map((i) => ({ ts: day * DAY + i * 3_600_000, w }));
  const shuffled = [...mk(20_003, 62), ...mk(20_001, 44), ...mk(20_002, 51)];
  const floors = dailyIdleFloors(shuffled);
  assert.deepEqual(floors.map((f) => f.value), [44, 51, 62]);
  assert.ok(floors[0].ts < floors[1].ts && floors[1].ts < floors[2].ts);
});

/* ══ 2. the exemplar must describe one alert, not two ════════════════════ */

test('THE MEASURED DEFECT: a sidecar title paired with a foreign id', () => {
  // Family `pack-hot`. The sidecar remembers Core 3's title; the JSONL's first
  // event in the window belongs to Core 1. Before v1.131.0 the rollup published
  // Core 3's title beside Core 1's id.
  const meta = { title: 'Core 3 pack 1 over temperature', alertId: 'pack-hot-core3-p1' };
  const seeded = replaySeedExemplar(meta, 'pack-hot-core1-p2', 'pack-hot');
  assert.equal(seeded.title, 'Core 3 pack 1 over temperature');
  assert.equal(seeded.alertId, 'pack-hot-core3-p1', 'id follows the title it was written with');
  assert.equal(seeded.pinned, true, 'later events must not move it');
});

test('a sidecar with no id yields a NEUTRAL title, so nothing is mispaired', () => {
  // Pre-v1.131.0 sidecars have title but no alertId. Rather than pair that
  // title with an arbitrary event id, the fallback is unpinned: the caller
  // advances the id to the family's last event.
  const seeded = replaySeedExemplar({ title: 'Core 3 pack 1 over temperature' }, 'pack-hot-core1-p2', 'pack-hot');
  assert.equal(seeded.alertId, 'pack-hot-core1-p2');
  assert.equal(seeded.pinned, false, 'unpinned → tracks the last event');
});

test('a family the sidecar has never seen falls back to the familyKey', () => {
  const seeded = replaySeedExemplar(undefined, 'cell-imbalance-core2', 'cell-imbalance');
  assert.equal(seeded.title, 'cell-imbalance', 'no subject in the title → no subject to mismatch');
  assert.equal(seeded.alertId, 'cell-imbalance-core2');
  assert.equal(seeded.pinned, false);
});

test('the sidecar is written with the id that belongs to the title', () => {
  // The other half of the fix: replaySeedExemplar can only pair them coherently
  // if the live path PERSISTED all four together. Assembling the tuple in one
  // function means a field can only go missing by editing this invariant.
  const alert = {
    id: 'pack-hot-core3-p1',
    title: 'Core 3 pack 1 over temperature',
    severity: 'warning' as const,
    category: 'Battery' as const,
  };
  assert.deepEqual(familyMetaFor(alert), {
    title: 'Core 3 pack 1 over temperature',
    severity: 'warning',
    category: 'Battery',
    alertId: 'pack-hot-core3-p1',
  });
  // ...and what it writes round-trips through the seeder as one subject.
  const seeded = replaySeedExemplar(familyMetaFor(alert), 'pack-hot-core1-p2', 'pack-hot');
  assert.equal(seeded.alertId, alert.id);
  assert.equal(seeded.title, alert.title);
  assert.equal(seeded.pinned, true);
});

test('★ pinned ⇒ id and title came from the SAME record', () => {
  // The whole point of the fix, stated as an invariant over the input space.
  const titles = [undefined, 'Core 3 pack 1 over temperature'];
  const ids = [undefined, 'pack-hot-core3-p1'];
  for (const title of titles) {
    for (const alertId of ids) {
      const meta = title === undefined && alertId === undefined ? undefined : { title, alertId };
      const seeded = replaySeedExemplar(meta, 'pack-hot-core1-p2', 'pack-hot');
      if (seeded.pinned) {
        assert.equal(seeded.alertId, alertId, 'pinned id is the sidecar id');
        assert.equal(seeded.title, title ?? 'pack-hot', 'and the title beside it is the sidecar title');
      } else {
        assert.equal(seeded.alertId, 'pack-hot-core1-p2', 'unpinned id is event-derived');
      }
    }
  }
});

/* ══ 3. the revert closed on a cloud ACK ═════════════════════════════════ */

const T0 = 1_788_600_000_000;

function revertedState(over: Partial<NightActuationState> = {}): NightActuationState {
  return {
    ...emptyActuationState(),
    day: '2026-09-05',
    targetPct: 50,
    priorReservePct: 16,
    windowStartMs: T0 - 6 * 3_600_000,
    windowEndMs: T0 - 3_600_000,
    appliedAtMs: T0 - 6 * 3_600_000,
    applyVerifiedAtMs: T0 - 6 * 3_600_000 + 60_000,
    revertedAtMs: T0,
    ...over,
  };
}

function opts(over: Partial<ActuationTickOpts> = {}): ActuationTickOpts {
  return {
    mode: 'supervised',
    writeReady: true,
    currentReservePct: 16,
    socCoherent: true,
    vitalsRed: false,
    gridPresent: true,
    ...over,
  } as ActuationTickOpts;
}

test('THE MEASURED DEFECT: a reverted night stopped looking at the device', () => {
  // The panel still reads the raised 50% well past the settling window. Before
  // v1.131.0 nothing compared it to anything — `revertedAtMs` was stamped on the
  // cloud ACK and the branch that reads the device requires it to be null.
  const a = decideActuation(
    revertedState(),
    T0 + REVERT_VERIFY_AFTER_MS,
    opts({ currentReservePct: 50 }),
  );
  assert.equal(a.kind, 'retryRevert');
  assert.equal((a as { restorePct: number }).restorePct, 16);
});

test('the device reading the restored floor closes the night for real', () => {
  const a = decideActuation(revertedState(), T0 + REVERT_VERIFY_AFTER_MS, opts({ currentReservePct: 16 }));
  assert.equal(a.kind, 'revertVerified');
});

test('no verdict is reached before the settling window expires', () => {
  // isRevertSettling documents a 20-60 s projection lag with a 5 min grace.
  // Reaching a failure verdict inside it would fight the posture hold.
  const a = decideActuation(revertedState(), T0 + REVERT_VERIFY_AFTER_MS - 1, opts({ currentReservePct: 50 }));
  assert.equal(a.kind, 'none', 'still settling');
});

test('★ a reading that is NEITHER value is treated as interference, not failure', () => {
  // The owner moved the floor in the EcoFlow app after the revert. Re-issuing
  // our restore would silently overwrite their change — the same discipline
  // ADOPT applies ("never guess a revert target").
  for (const pct of [10, 20, 30, 40, 49]) {
    const a = decideActuation(revertedState(), T0 + REVERT_VERIFY_AFTER_MS, opts({ currentReservePct: pct }));
    assert.equal(a.kind, 'none', `reserve=${pct}% is not ours to correct`);
  }
});

test('an unknown reading pauses the check instead of failing it', () => {
  const a = decideActuation(revertedState(), T0 + REVERT_VERIFY_AFTER_MS, opts({ currentReservePct: null }));
  assert.equal(a.kind, 'none');
});

test('retries are capped, then it escalates exactly once', () => {
  const stuck = opts({ currentReservePct: 50 });
  const at = T0 + REVERT_VERIFY_AFTER_MS;
  assert.equal(decideActuation(revertedState({ revertRetries: REVERT_MAX_RETRIES - 1 }), at, stuck).kind, 'retryRevert');
  assert.equal(decideActuation(revertedState({ revertRetries: REVERT_MAX_RETRIES }), at, stuck).kind, 'revertFailed');
  assert.equal(
    decideActuation(revertedState({ revertRetries: REVERT_MAX_RETRIES, revertReadbackEscalated: true }), at, stuck).kind,
    'none',
    'the critical annunciation fires once per night',
  );
});

test('each retry earns its own verification window', () => {
  const retried = revertedState({ revertRetries: 1, revertLastAttemptMs: T0 + 10 * 60_000 });
  const stuck = opts({ currentReservePct: 50 });
  assert.equal(decideActuation(retried, T0 + 12 * 60_000, stuck).kind, 'none', 'measured from the RETRY, not the revert');
  assert.equal(decideActuation(retried, T0 + 10 * 60_000 + REVERT_VERIFY_AFTER_MS, stuck).kind, 'retryRevert');
});

test('a no-op restore (target === floor) verifies immediately', () => {
  // The applyFailed path closes the night with a restore to a value the device
  // already reads. That must not look like a stuck reserve.
  const a = decideActuation(
    revertedState({ targetPct: 16 }),
    T0 + REVERT_VERIFY_AFTER_MS,
    opts({ currentReservePct: 16 }),
  );
  assert.equal(a.kind, 'revertVerified');
});

test('★ an unverified revert never blocks the next night from arming', () => {
  // The check falls THROUGH rather than returning 'none'. With a fresh plan
  // armed for the next day the apply path must still be reachable.
  const nextNight: NightActuationState = {
    ...emptyActuationState(),
    day: '2026-09-06',
    targetPct: 50,
    windowStartMs: T0 + 1_000,
    windowEndMs: T0 + 6 * 3_600_000,
  };
  const a = decideActuation(nextNight, T0 + 1_000, opts({ currentReservePct: 16 }));
  assert.equal(a.kind, 'apply', 'a fresh night arms normally');
});

/* ══ 4. signals that reported health they had not measured ══════════════ */

test('THE MEASURED DEFECT: a totally silent device was never sampled', () => {
  // `mqttMsgCountBySn` gains an entry only in the MQTT ingest path, so a device
  // that has produced ZERO messages since process start is absent from it. The
  // collapse detector iterated that map, so it was armed for a 0.2 msg/min
  // collapse and blind to a 0.0 msg/min one — and the SHP2 it exists to watch
  // is the single-point-critical alarm data source.
  const roster = ['SHP2-A', 'CORE-1', 'CORE-2'];
  const counts = new Map([['CORE-1', 412], ['CORE-2', 388]]);   // SHP2 never spoke
  const sampled = rateFloorSampleSet(roster, counts);
  assert.deepEqual(sampled, [
    { sn: 'SHP2-A', count: 0 },
    { sn: 'CORE-1', count: 412 },
    { sn: 'CORE-2', count: 388 },
  ]);
  assert.ok(sampled.some((s) => s.sn === 'SHP2-A'), 'silence is a rate-0 sample, not an absence');
});

test('★ every roster device is sampled on every tick, whatever the map holds', () => {
  const roster = ['A', 'B', 'C', 'D'];
  for (const present of [[], ['A'], ['B', 'D'], ['A', 'B', 'C', 'D']]) {
    const counts = new Map(present.map((sn, i) => [sn, (i + 1) * 100]));
    const sampled = rateFloorSampleSet(roster, counts);
    assert.deepEqual(sampled.map((s) => s.sn), roster, `roster coverage with ${present.length} talking`);
  }
});

test('a device in the counter map but off the roster is still watched', () => {
  // Losing a device from the roster mid-run must not silently stop watching it.
  const sampled = rateFloorSampleSet(['A'], new Map([['A', 10], ['GHOST', 3]]));
  assert.deepEqual(sampled, [{ sn: 'A', count: 10 }, { sn: 'GHOST', count: 3 }]);
});

test('no device is sampled twice', () => {
  const sampled = rateFloorSampleSet(['A', 'B'], new Map([['A', 10], ['B', 20]]));
  assert.equal(new Set(sampled.map((s) => s.sn)).size, sampled.length);
});

/* ── push health: record before throwing ──────────────────────────────────── */

const ok = async () => ({ ok: true });
const down = async (target: string) => ({ ok: false, error: `connect ECONNREFUSED (${target})` });

test('THE MEASURED DEFECT: with ONE target the failure record was unreachable', async () => {
  // 100% down is the only way a single-target config can fail, and the record
  // used to be written after the throw. /api/notify/status reported an empty
  // failure list for a completely dead push channel.
  resetLastPushFailures();
  await assert.rejects(
    () => dispatchMobilePush(['notify.mobile_app_iphone'], { message: 'x' }, down),
    /failed on all 1 target/,
  );
  assert.deepEqual(getLastPushFailures(), ['notify.mobile_app_iphone: connect ECONNREFUSED (notify.mobile_app_iphone)']);
});

test('the throw still happens — the caller must retry a dead channel', async () => {
  resetLastPushFailures();
  await assert.rejects(() => dispatchMobilePush(['a', 'b'], {}, down), /failed on all 2 target/);
  assert.equal(getLastPushFailures().length, 2, 'and the record survives the throw');
});

test('a partial failure reports without throwing', async () => {
  resetLastPushFailures();
  const halfDown = async (t: string) => (t === 'b' ? { ok: false, error: 'HTTP 500' } : { ok: true });
  await dispatchMobilePush(['a', 'b'], {}, halfDown);
  assert.deepEqual(getLastPushFailures(), ['b: HTTP 500']);
});

test('a clean send CLEARS a stale failure record', async () => {
  resetLastPushFailures();
  await assert.rejects(() => dispatchMobilePush(['a'], {}, down));
  assert.equal(getLastPushFailures().length, 1);
  await dispatchMobilePush(['a'], {}, ok);
  assert.deepEqual(getLastPushFailures(), [], 'recovery must not leave the channel looking broken');
});

test('★ the record always matches the attempt, thrown or not', async () => {
  // Exhaustive over which of three targets fail. The record equals the failing
  // set in every case — including the all-down case, which throws.
  for (let mask = 0; mask < 8; mask++) {
    resetLastPushFailures();
    const targets = ['a', 'b', 'c'];
    const failing = targets.filter((_, i) => (mask >> i) & 1);
    const call = async (t: string) => (failing.includes(t) ? { ok: false, error: 'E' } : { ok: true });
    const run = dispatchMobilePush(targets, {}, call);
    if (failing.length === targets.length) await assert.rejects(() => run);
    else await run;
    assert.deepEqual(getLastPushFailures(), failing.map((t) => `${t}: E`), `mask=${mask}`);
  }
});
