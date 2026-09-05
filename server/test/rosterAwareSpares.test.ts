import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPARE_DPU_SNS, isBenchSpareSn, benchSpareSns, isExpectedOfflineSpare, homeCoreCoverage,
  setLastKnownHomeRoster, resetLastKnownHomeRoster,
} from '../src/shp2Membership.js';
import {
  evaluateSelfHeal, DEFAULT_SELF_HEAL_CONFIG, type SelfHealState,
} from '../src/sessionSelfHeal.js';

/**
 * v1.121.0 — the 2026-08-20 physical swap inverted SPARE_DPU_SNS and four
 * consumers were left reading the raw literal.
 *
 * LIVE TOPOLOGY (measured 2026-09-03 from /api/snapshot):
 *   SHP2 sources slot 1/2/3 = Core 1 / Core 2 / CORE 5, all isConnected,
 *   sourceWatts [-1981, -1864, -1874] — Core 5 is delivering ~1.87 kW.
 *   Core 3 ("xxCore 3") is online, idle at 69%, and NOT a source — it is the bench.
 * The literal still says the spares are Core 4 + Core 5.
 */

const CORE1 = 'Y711ZAB59GBC0314';
const CORE2 = 'Y711ZAB59GBC0482';
const CORE3 = 'Y711FAB59J234000';   // bench since 08-20
const CORE4 = 'Y711ZABA9H3T0489';   // genuine bench spare (holds the RMA pack)
const CORE5 = 'Y711ZAB59G9P0090';   // LIVE pool member, slot 3
const LIVE_ROSTER = new Set([CORE1, CORE2, CORE5]);

beforeEach(() => resetLastKnownHomeRoster());

test('precondition: the literal really is inverted', () => {
  assert.ok(SPARE_DPU_SNS.has(CORE5), 'the literal calls the live pool member a spare');
  assert.ok(!SPARE_DPU_SNS.has(CORE3), 'and does not name the actual bench unit');
});

test('THE HOLE: with the SHP2 dark, Core 5 was muted as an expected-offline spare', () => {
  const dark = new Set<string>();           // SHP2 cloud-blind: no connected sources
  setLastKnownHomeRoster(LIVE_ROSTER);
  assert.equal(isExpectedOfflineSpare(CORE5, dark), false,
    'a DPU the SHP2 last reported as a pool source is NOT bench hardware');
  // The genuine spare is still muted — the fix must not make everything noisy.
  assert.equal(isExpectedOfflineSpare(CORE4, dark), true);
});

test('without a remembered roster it degrades to the old literal behaviour', () => {
  const dark = new Set<string>();
  assert.equal(isExpectedOfflineSpare(CORE5, dark), true, 'first-ever boot, nothing learned yet');
  assert.equal(isExpectedOfflineSpare(CORE4, dark), true);
});

test('the safety floor is intact: a home core is never a spare, roster or not', () => {
  setLastKnownHomeRoster(new Set([CORE4]));  // deliberately absurd roster
  for (const sn of [CORE1, CORE2, CORE3]) {
    assert.equal(isBenchSpareSn(sn), false, `${sn} is not in the literal, so never a spare`);
  }
});

test('the roster can only REMOVE spare status — it is monotone toward fail-loud', () => {
  // Every SN, under every roster, must be a spare only if the literal says so.
  for (const roster of [null, new Set<string>(), LIVE_ROSTER, new Set([CORE1, CORE2, CORE3, CORE4, CORE5])]) {
    resetLastKnownHomeRoster();
    if (roster) setLastKnownHomeRoster(roster);
    for (const sn of [CORE1, CORE2, CORE3, CORE4, CORE5]) {
      if (isBenchSpareSn(sn)) assert.ok(SPARE_DPU_SNS.has(sn), `${sn} muted without the literal`);
    }
  }
});

test('a live connected source is re-armed regardless of the roster', () => {
  setLastKnownHomeRoster(new Set([CORE1]));
  assert.equal(isExpectedOfflineSpare(CORE5, new Set([CORE1, CORE2, CORE5])), false);
});

test('benchSpareSns reflects the roster, not just the literal', () => {
  setLastKnownHomeRoster(LIVE_ROSTER);
  assert.deepEqual(benchSpareSns(), [CORE4]);
  resetLastKnownHomeRoster();
  assert.deepEqual(benchSpareSns().sort(), [CORE4, CORE5].sort());
});

/* ── homeCoreCoverage's SHP2-blind fallback ───────────────────────────────── */

const dpu = (sn: string, online: boolean) => ({
  sn, deviceName: sn, online, projection: { kind: 'dpu' as const },
});
// SHP2 present but cloud-dark: no connected sources to read.
const darkFleet = (core5Online: boolean) => Object.fromEntries(
  [dpu(CORE1, true), dpu(CORE2, true), dpu(CORE3, true), dpu(CORE5, core5Online)]
    .map((d) => [d.sn, d]),
) as never;

test('THE HOLE: the blind fallback counted BENCH Core 3 and dropped live Core 5', () => {
  setLastKnownHomeRoster(LIVE_ROSTER);
  // Core 5 has gone cloud-dark while the SHP2 is also dark — the pool is NOT
  // fully observable, and gridState uses `complete` to decide whether to withhold
  // the at-floor grid backstop.
  const cov = homeCoreCoverage(darkFleet(false));
  assert.equal(cov.complete, false, 'a live pool member is unobserved — coverage is incomplete');
  assert.equal(cov.connected, 3, 'the roster is the SHP2-remembered {1,2,5}, not {1,2,3}');
  assert.equal(cov.reporting, 2);
});

test('with every remembered member reporting, coverage is complete', () => {
  setLastKnownHomeRoster(LIVE_ROSTER);
  const cov = homeCoreCoverage(darkFleet(true));
  assert.deepEqual(cov, { connected: 3, reporting: 3, complete: true });
});

test('a remembered member missing from the device map pushes coverage incomplete', () => {
  setLastKnownHomeRoster(new Set([CORE1, CORE2, CORE5, 'GHOST-SN']));
  assert.equal(homeCoreCoverage(darkFleet(true)).complete, false,
    'an SN we cannot even see must never read as observed');
});

/* ── self-heal quorum ─────────────────────────────────────────────────────── */

const freshState = (): SelfHealState => ({ starvedSinceMs: null, lastHealMs: null, healTimesMs: [] });
const T0 = 1_788_400_000_000;

test('THE DEFECT: a solo SHP2 wedge could never reach the 2-device quorum', () => {
  const st = freshState();
  // Old behaviour: starvedCount 1 < 2, so the onset clock is reset every tick and
  // the dwell never accrues — no rebuild, ever.
  assert.equal(evaluateSelfHeal(T0, 1, st, DEFAULT_SELF_HEAL_CONFIG).heal, false);
  assert.equal(st.starvedSinceMs, null, 'onset reset — the clock never starts');

  // Fixed: the alarm-critical device alone starts the clock.
  const st2 = freshState();
  const v1 = evaluateSelfHeal(T0, 1, st2, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved: true });
  assert.equal(v1.heal, false, 'still must serve the dwell');
  assert.equal(st2.starvedSinceMs, T0, 'but the clock is now RUNNING');
  const v2 = evaluateSelfHeal(T0 + 20 * 60_000, 1, st2, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved: true });
  assert.equal(v2.heal, true, 'heals after the 20-minute dwell');
});

test('the exception relaxes ONLY the quorum — dwell, cooldown and budget still bind', () => {
  const st = freshState();
  evaluateSelfHeal(T0, 1, st, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved: true });
  // Dwell.
  assert.equal(evaluateSelfHeal(T0 + 19 * 60_000, 1, st, DEFAULT_SELF_HEAL_CONFIG,
    { alarmCriticalStarved: true }).heal, false);
  assert.equal(evaluateSelfHeal(T0 + 20 * 60_000, 1, st, DEFAULT_SELF_HEAL_CONFIG,
    { alarmCriticalStarved: true }).heal, true);
  // Immediately after a heal the ONSET is reset by design ("a persisting
  // starvation must dwell again on top of the cooldown"), so the dwell guard is
  // what answers first — not the cooldown.
  const justAfter = evaluateSelfHeal(T0 + 21 * 60_000, 1, st, DEFAULT_SELF_HEAL_CONFIG,
    { alarmCriticalStarved: true });
  assert.equal(justAfter.heal, false);
  assert.match(String(justAfter.reason), /dwell/, 'onset was reset, so the dwell re-accrues');
  // Serve the new dwell and the cooldown is the one still holding the line
  // (heal at T0+20m, so T0+45m is 25m of cooldown against the 60m minimum).
  const inCooldown = evaluateSelfHeal(T0 + 45 * 60_000, 1, st, DEFAULT_SELF_HEAL_CONFIG,
    { alarmCriticalStarved: true });
  assert.equal(inCooldown.heal, false);
  assert.match(String(inCooldown.reason), /cooldown/);
  // Budget.
  const capped = freshState();
  capped.healTimesMs = Array.from({ length: 6 }, (_, i) => T0 - i * 60_000);
  capped.starvedSinceMs = T0 - 30 * 60_000;
  const v = evaluateSelfHeal(T0, 1, capped, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved: true });
  assert.equal(v.heal, false);
  assert.match(String(v.reason), /daily cap/);
});

test('an ordinary single starved device still does NOT satisfy the quorum', () => {
  const st = freshState();
  assert.equal(evaluateSelfHeal(T0, 1, st, DEFAULT_SELF_HEAL_CONFIG,
    { alarmCriticalStarved: false }).heal, false);
  assert.equal(st.starvedSinceMs, null, 'anti-thrash for one flaky Core is unchanged');
});
