import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  liveRefreshDue, refreshPastDeadline, refreshWeatherFresh, refreshAborted, liveRefreshOutcome, standingLiveRefresh, applyLiveRefresh,
  liveRefreshLedgerColumns, REFRESH_MAX_WEATHER_AGE_MS,
} from '../src/morningRefresh.js';
import {
  armCycle, coerceCycle, emptyCycle, emptyLegState, serializeCycle, type ChargeCycleState, type ChargeLegState,
} from '../src/chargeCycle.js';
import { REFRESH_LEAD_MS, REFRESH_DEADLINE_MS, weatherAgeSeconds, refreshFromSized, type MiddayShadowRecord } from '../src/middayShadow.js';
import type { NightChargePlan } from '../src/nightChargeAdvisor.js';
import { weatherMaxAgeMs, getWeather, clearWeatherTestOverride, setWeatherCacheForTesting } from '../src/weather.js';
import { getDayForecast, computeProbabilisticForecast, resetForecastCachesForTesting } from '../src/analytics.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * R5 (v1.189.0) — THE LIVE MORNING REFRESH (plan §3.4), built and INERT until the mid-day switch,
 * and the worker plumbing it asks its forecast through (maxWeatherAgeMs).
 *  - It finds a leg only when the cycle's active leg is an armed super off-peak cost leg: every
 *    overnight leg of every shape is refused first, so nothing runs while nothing arms one.
 *  - Lower-only: the announced level is the consent ceiling; a higher need is "capped"; the written
 *    reserve and force-charge ceiling only come down; a hold cancels the leg.
 *  - Once across a restart (refreshedAtMs is in the cycle file); re-read after the await; stamped
 *    before the push; a push, never speech; a forecast on weather older than 45 min defers it.
 */

const H = 3_600_000;
const M = 60_000;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const OPEN = phx(10, 15, 10);

/** An armed mid-day cost leg, as the switch will arm it (announced 2026-10-14 21:30). */
const midday = (o: Partial<ChargeLegState> = {}): ChargeLegState => ({
  ...emptyLegState(),
  leg: 'cost', windowKind: 'super_off_peak', day: '2026-10-14', announcedAtMs: phx(10, 14, 21, 30),
  targetPct: 50, buyKwh: 58.2, windowStartMs: OPEN, windowEndMs: phx(10, 15, 15), nextOnPeakStartMs: phx(10, 15, 16),
  forceChargeCeilingPct: 89.6, forceChargeRides: true, announcedLevelPct: 89.6, announcedExpectedKwh: 34,
  ...o,
});
const cycle = (active: ChargeLegState, o: Partial<ChargeCycleState> = {}): ChargeCycleState => ({ active, pendingLegs: [], trailing: null, ...o });

/** A re-sized plan with the fields the refresh reads. */
const plan = (o: Partial<NightChargePlan> = {}): NightChargePlan => ({
  basisComplete: true, chargeTonight: true, setpointSocPct: 50, costCeilingSocPct: 89.6, expectedWriteLevelPct: 89.6,
  expectedForceChargeStartMs: phx(10, 15, 13), expectedBuyKwh: 34, buyKwh: 58.2, ...o,
} as NightChargePlan);

/* ══ inert: no overnight leg is ever refreshed ═════════════════════════════════ */

test('★★★ inert: every overnight leg, of every shape, at every minute of a day — no refresh', () => {
  const w = { startMs: phx(10, 15, 0), endMs: phx(10, 15, 5) };
  const overnightPlan = plan({ window: w } as Partial<NightChargePlan>);
  const armed = armCycle(emptyCycle(), '2026-10-14', [{
    role: 'cost', kind: 'overnight', plan: overnightPlan, forceChargeEnabled: true, nextOnPeakStartMs: phx(10, 15, 16),
    announcedLevelPct: 89.6, announcedExpectedKwh: 34,
  }], phx(10, 14, 21, 30), 16).cycle!;
  assert.ok(armed != null);
  const shapes: ChargeLegState[] = [
    emptyLegState(),
    armed.active,
    { ...armed.active, windowStartMs: OPEN, windowEndMs: phx(10, 15, 15) }, // an overnight-named leg at the mid-day hours
    midday({ windowKind: 'overnight' }),
    midday({ leg: 'backup' }), // a backup leg, even in the super off-peak window
    { ...midday(), windowKind: undefined as unknown as 'overnight' }, // a record from before the cycle record
  ];
  for (const s of shapes) {
    for (let t = phx(10, 14, 21); t < phx(10, 15, 21); t += M) {
      assert.equal(liveRefreshDue(cycle(s), t), null, `${s.leg}/${s.windowKind} at ${new Date(t).toISOString()}`);
    }
  }
});

test('★★★ the mid-day cost leg: due from 30 to 5 minutes before the open, then the arm stands; never twice, never a pending or blocked leg', () => {
  const c = cycle(midday());
  assert.equal(REFRESH_LEAD_MS, 30 * M);
  assert.equal(REFRESH_DEADLINE_MS, 5 * M);
  assert.equal(liveRefreshDue(c, OPEN - 31 * M), null);
  assert.equal(liveRefreshDue(c, OPEN - 30 * M), 'run');
  assert.equal(liveRefreshDue(c, OPEN - 5 * M - 1), 'run');
  assert.equal(liveRefreshDue(c, OPEN - 5 * M), 'stand');
  assert.equal(liveRefreshDue(c, OPEN - 1), 'stand');
  assert.equal(liveRefreshDue(c, OPEN), null, 'the window opened: the actuator owns the leg');
  for (const o of [
    { refreshedAtMs: OPEN - 20 * M }, { cancelled: true }, { applyAttemptedAtMs: OPEN - 10 * M }, { appliedAtMs: OPEN - 10 * M },
    { announcedAtMs: null }, { day: null }, { windowStartMs: null },
  ] as Array<Partial<ChargeLegState>>) {
    assert.equal(liveRefreshDue(cycle(midday(o)), OPEN - 20 * M), null, JSON.stringify(o));
  }
  // Pending behind a backup that has not resolved: not refreshed (it is not the active leg).
  const backup = midday({ leg: 'backup', windowKind: 'overnight', windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5), appliedAtMs: phx(10, 14, 23) });
  assert.equal(liveRefreshDue(cycle(backup, { pendingLegs: [midday()] }), OPEN - 20 * M), null);
  // A trailing leg still verifying its force-charge OFF holds the cost leg.
  const trailing = midday({ windowKind: 'overnight', forceChargeOnAtMs: phx(10, 14, 3), forceChargeOffVerifiedAtMs: null, revertedAtMs: phx(10, 14, 5) });
  assert.equal(liveRefreshDue(cycle(midday(), { trailing }), OPEN - 20 * M), null);
  // Once across a restart: the stamp is in the cycle file.
  const done = applyLiveRefresh(midday(), standingLiveRefresh(midday(), 'x'), OPEN - 20 * M);
  const back = coerceCycle(JSON.parse(JSON.stringify(serializeCycle(cycle(done)))));
  assert.equal(back.active.refreshedAtMs, OPEN - 20 * M);
  assert.equal(back.active.windowKind, 'super_off_peak');
  assert.equal(liveRefreshDue(back, OPEN - 19 * M), null);
});

/* ══ lower-only ═════════════════════════════════════════════════════════════ */

test('★★★ lower-only: a higher need is capped and writes nothing; a lower one lowers the reserve and the stop; a hold cancels', () => {
  const leg = midday();
  // Unchanged.
  const same = liveRefreshOutcome(leg, plan());
  assert.equal(same.disposition, 'unchanged');
  assert.deepEqual(applyLiveRefresh(leg, same, OPEN - 20 * M), { ...leg, refreshedAtMs: OPEN - 20 * M });
  // Capped with a lower reserve asked: a cap writes nothing at all.
  const capLow = liveRefreshOutcome(leg, plan({ costCeilingSocPct: 95, expectedWriteLevelPct: 95, setpointSocPct: 45 }));
  assert.equal(capLow.disposition, 'capped');
  assert.deepEqual(applyLiveRefresh(leg, capLow, OPEN - 20 * M), { ...leg, refreshedAtMs: OPEN - 20 * M });
  // Capped: the re-plan asks for 95% — the leg keeps the announced 89.6 ceiling and the 50 reserve.
  const cap = liveRefreshOutcome(leg, plan({ costCeilingSocPct: 95, expectedWriteLevelPct: 95, expectedBuyKwh: 40 }));
  assert.equal(cap.disposition, 'capped');
  assert.equal(cap.neededLevelPct, 95);
  assert.equal(cap.expectedBuyKwh, null, 'no figure is invented for the capped level');
  assert.equal(liveRefreshOutcome(leg, plan({ costCeilingSocPct: 95, expectedWriteLevelPct: 95, buyKwh: 66 })).buyKwh, 58.2,
    'the armed worst case, not the capped level\'s: refreshed_buy_kwh is the figure the leg ran on');
  assert.equal(cap.wouldPush, true);
  const capped = applyLiveRefresh(leg, cap, OPEN - 20 * M);
  assert.equal(capped.forceChargeCeilingPct, 89.6);
  assert.equal(capped.targetPct, 50);
  // Lowered: a sunnier morning — the stop to 80, the reserve to 45.
  const low = liveRefreshOutcome(leg, plan({ costCeilingSocPct: 80, expectedWriteLevelPct: 80, setpointSocPct: 45, expectedBuyKwh: 20 }));
  assert.equal(low.disposition, 'lowered');
  const lowered = applyLiveRefresh(leg, low, OPEN - 20 * M);
  assert.equal(lowered.forceChargeCeilingPct, 80);
  assert.equal(lowered.targetPct, 45);
  assert.equal(lowered.refreshedAtMs, OPEN - 20 * M);
  assert.equal(lowered.cancelled, false);
  // A lower stop with a HIGHER reserve: the stop comes down, the reserve never goes up.
  const mixed = applyLiveRefresh(leg, liveRefreshOutcome(leg, plan({ costCeilingSocPct: 80, expectedWriteLevelPct: 80, setpointSocPct: 50, expectedBuyKwh: 20 })), OPEN - 20 * M);
  assert.ok(mixed.targetPct! <= leg.targetPct!);
  assert.ok(mixed.forceChargeCeilingPct! <= leg.forceChargeCeilingPct!);
  // The re-plan needs no force-charge: none rides the leg.
  const noFc = liveRefreshOutcome(leg, plan({ costCeilingSocPct: null, expectedWriteLevelPct: 50, expectedForceChargeStartMs: null, expectedBuyKwh: 10 }));
  assert.equal(noFc.disposition, 'lowered');
  assert.equal(applyLiveRefresh(leg, noFc, OPEN - 20 * M).forceChargeCeilingPct, null);
  // A hold cancels the leg; nothing more is written for it.
  const hold = liveRefreshOutcome(leg, plan({ chargeTonight: false }));
  assert.equal(hold.disposition, 'cancelled');
  const cancelled = applyLiveRefresh(leg, hold, OPEN - 20 * M);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.targetPct, 50, 'the record keeps what was armed (the actuator writes nothing for a cancelled leg)');
  // No plan, or an incomplete basis: the evening arm stands.
  assert.equal(liveRefreshOutcome(leg, null).disposition, 'stood');
  assert.equal(liveRefreshOutcome(leg, plan({ basisComplete: false })).disposition, 'stood');
  // No announced level: nothing to refresh against — never a raise.
  const legacy = liveRefreshOutcome(midday({ announcedLevelPct: null }), plan({ costCeilingSocPct: 95, expectedWriteLevelPct: 95 }));
  assert.equal(legacy.disposition, 'stood');
  // Each guard holds alone. The outcome never states a reserve above the armed one…
  const leg40 = midday({ targetPct: 40 });
  const up = liveRefreshOutcome(leg40, plan({ costCeilingSocPct: 80, expectedWriteLevelPct: 80, setpointSocPct: 50 }));
  assert.equal(up.disposition, 'capped', 'a higher reserve than announced is a higher need');
  assert.equal(up.reservePct, 40, 'the outcome caps the reserve at the armed one');
  // A lower stop with a lower reserve ask than the re-plan's cap: lowered, and never above the armed.
  const down = liveRefreshOutcome(leg40, plan({ costCeilingSocPct: 80, expectedWriteLevelPct: 80, setpointSocPct: 35 }));
  assert.equal(down.disposition, 'lowered');
  assert.equal(down.reservePct, 35);
  // …nor a ceiling above the armed one…
  const fcUp = liveRefreshOutcome(midday({ forceChargeCeilingPct: 85 }), plan({ costCeilingSocPct: 95, expectedWriteLevelPct: 80 }));
  assert.equal(fcUp.disposition, 'lowered');
  assert.equal(fcUp.forceChargeCeilingPct, 85, 'the outcome caps the ceiling at the armed one');
  // …and the write takes the lower of the armed and the stated, whatever an outcome says.
  const forged = { ...low, reservePct: 50, forceChargeCeilingPct: 95 };
  const written = applyLiveRefresh(midday({ targetPct: 40, forceChargeCeilingPct: 85 }), forged, OPEN - 20 * M);
  assert.equal(written.targetPct, 40);
  assert.equal(written.forceChargeCeilingPct, 85);
  // Every outcome, every input: the leg is never raised.
  for (const ceil of [null, 50, 60, 80, 89.6, 95, 100]) for (const sp of [10, 30, 45, 50]) for (const lvl of [50, 70, 89.6, 100]) for (const ch of [true, false]) {
    const o = liveRefreshOutcome(leg, plan({ costCeilingSocPct: ceil, setpointSocPct: sp, expectedWriteLevelPct: lvl, chargeTonight: ch }));
    const a = applyLiveRefresh(leg, o, OPEN - 20 * M);
    assert.ok(a.targetPct == null || a.targetPct <= leg.targetPct!, `reserve ${a.targetPct}`);
    assert.ok(a.forceChargeCeilingPct == null || a.forceChargeCeilingPct <= leg.forceChargeCeilingPct!, `ceiling ${a.forceChargeCeilingPct}`);
    assert.ok(o.levelPct == null || o.levelPct <= leg.announcedLevelPct!, `level ${o.levelPct}`);
  }
});

test('★★ the push rule: a cancel, a changed written value, a cap or an expected-kWh move above 25% either way', () => {
  const leg = midday();
  assert.equal(liveRefreshOutcome(leg, plan({ expectedBuyKwh: 34 * 1.25 })).wouldPush, false);
  assert.equal(liveRefreshOutcome(leg, plan({ expectedBuyKwh: 34 * 1.26 })).wouldPush, true);
  assert.equal(liveRefreshOutcome(leg, plan({ expectedBuyKwh: 34 * 0.75 })).wouldPush, false);
  assert.equal(liveRefreshOutcome(leg, plan({ expectedBuyKwh: 34 * 0.74 })).wouldPush, true);
  assert.equal(liveRefreshOutcome(leg, plan({ chargeTonight: false })).wouldPush, true);
  assert.equal(standingLiveRefresh(leg, 'x').wouldPush, false, 'a standing arm says nothing');
});

test('★★★ the enforced deadline: an answer at or after 5 minutes before the open is dropped; a leg with no window has none to make', () => {
  const leg = midday();
  assert.equal(refreshPastDeadline(leg, OPEN - 30 * M), false);
  assert.equal(refreshPastDeadline(leg, OPEN - 5 * M - 1), false);
  assert.equal(refreshPastDeadline(leg, OPEN - 5 * M), true, 'the evening arm stands from here');
  assert.equal(refreshPastDeadline(leg, OPEN + H), true, 'and after the open the actuator owns the leg');
  assert.equal(refreshPastDeadline(midday({ windowStartMs: null }), OPEN - 20 * M), true);
  assert.equal(refreshPastDeadline(midday({ windowStartMs: Number.NaN }), OPEN - 20 * M), true);
});

test('★★★ the announced reserve is a ceiling too: a re-plan asking for a higher reserve is capped and writes nothing', () => {
  // Armed at 40%, announced "the backup reserve is held at 40%"; the morning asks for 50.
  const leg = midday({ targetPct: 40 });
  const up = liveRefreshOutcome(leg, plan({ setpointSocPct: 50 }));
  assert.equal(up.disposition, 'capped');
  assert.equal(up.reservePct, 40);
  assert.equal(up.levelPct, 89.6);
  assert.equal(up.expectedBuyKwh, null, 'sized on a reserve that will not be written: no figure');
  assert.equal(liveRefreshOutcome(leg, plan({ setpointSocPct: 50, buyKwh: 66 })).buyKwh, 58.2, 'nor its worst case');
  assert.equal(liveRefreshLedgerColumns(liveRefreshOutcome(leg, plan({ setpointSocPct: 50, buyKwh: 66 })), OPEN - 20 * M, 60).refreshed_buy_kwh, 58.2,
    'the de-bias learner reads refreshed_buy_kwh as the figure the leg ran on');
  assert.equal(up.wouldPush, true);
  assert.match(up.reason, /refreshed reserve \(50%\) is above the announced 40%/);
  assert.deepEqual(applyLiveRefresh(leg, up, OPEN - 20 * M), { ...leg, refreshedAtMs: OPEN - 20 * M });
  // A lower stop beside the higher reserve: still a cap — nothing moves.
  const both = liveRefreshOutcome(leg, plan({ setpointSocPct: 50, costCeilingSocPct: 80, expectedWriteLevelPct: 80 }));
  assert.equal(both.disposition, 'capped');
  assert.deepEqual(applyLiveRefresh(leg, both, OPEN - 20 * M), { ...leg, refreshedAtMs: OPEN - 20 * M });
  // The same reserve, the same stop, the same figure: unchanged, and nothing to push.
  const same = liveRefreshOutcome(leg, plan({ setpointSocPct: 40 }));
  assert.equal(same.disposition, 'unchanged');
  assert.equal(same.wouldPush, false, 'no written value changed and the figure did not move');
  // A lower reserve alone is a lowering, pushed.
  const lower = liveRefreshOutcome(leg, plan({ setpointSocPct: 30 }));
  assert.equal(lower.disposition, 'lowered');
  assert.equal(lower.reservePct, 30);
  assert.equal(lower.wouldPush, true);
  assert.equal(applyLiveRefresh(leg, lower, OPEN - 20 * M).targetPct, 30);
  // So is a force-charge ceiling the re-plan no longer needs, with the level and the reserve as
  // announced: a written value comes down, so it is a lowering, and it is pushed.
  const noCeiling = liveRefreshOutcome(midday(), plan({ costCeilingSocPct: null }));
  assert.equal(noCeiling.disposition, 'lowered');
  assert.equal(noCeiling.forceChargeCeilingPct, null);
  assert.equal(noCeiling.wouldPush, true, 'a written change is pushed, whatever the shadow rule counts');
  assert.equal(applyLiveRefresh(midday(), noCeiling, OPEN - 20 * M).forceChargeCeilingPct, null);
});

test('★★★ one rule: the shadow refresh records what this live refresh would do, on the same leg and re-plan', () => {
  // The shadow's record of an evening and the live leg the switch would arm from it.
  const shadowOf = (lvl: number, res: number): MiddayShadowRecord => ({
    version: 1, day: '2026-10-14', computedAtMs: phx(10, 14, 21, 30), why: 'midday', mode: 'supervised', backup: null, refresh: null, note: null,
    cost: {
      role: 'cost', kind: 'super_off_peak', windowStartMs: OPEN, windowEndMs: phx(10, 15, 15), basisComplete: true, chargeTonight: true,
      reservePct: res, reserveBasis: 'pool', levelPct: lvl, costCeilingSocPct: 89.6, buyKwh: 58.2, expectedBuyKwh: 34, expectedStartSocPct: 40,
      cushionTroughSocPct: null, cushionLineSocPct: null, wouldArm: true, disposition: 'would arm', windowPvP50Kwh: 20, windowLoadP50Kwh: 14,
    },
  });
  let caps = 0;
  for (const annLvl of [50, 70, 89.6]) for (const annRes of [20, 30, 45, 50]) {
    if (annRes > annLvl) continue;
    const leg = midday({ announcedLevelPct: annLvl, targetPct: annRes });
    for (const lvl of [50, 60, 70, 80, 95]) for (const sp of [10, 25, 30, 40, 45, 50]) {
      const p = plan({ setpointSocPct: sp, expectedWriteLevelPct: lvl });
      const live = liveRefreshOutcome(leg, p);
      const shadow = refreshFromSized(shadowOf(annLvl, annRes), { plan: p, windowPvP50Kwh: 20, windowLoadP50Kwh: 14 }, OPEN - 30 * M);
      const at = `announced ${annLvl}%/${annRes}%, re-plan ${lvl}%/${sp}%`;
      assert.equal(shadow.disposition, live.disposition, at);
      assert.equal(shadow.reservePct, live.reservePct, at);
      assert.equal(shadow.levelPct, live.levelPct, at);
      assert.equal(shadow.expectedBuyKwh, live.expectedBuyKwh, at);
      assert.equal(shadow.reason, live.reason, at);
      assert.ok(shadow.reservePct == null || shadow.reservePct <= annRes, `${at}: never above the announced reserve`);
      if (live.disposition === 'capped') caps++;
    }
  }
  assert.ok(caps > 20, `${caps} caps reached`);
});

test('★★ a leg with no armed reserve is given none by the refresh', () => {
  const o = liveRefreshOutcome(midday({ targetPct: null }), plan({ setpointSocPct: 35, expectedWriteLevelPct: 80 }));
  assert.equal(o.disposition, 'lowered');
  assert.equal(o.reservePct, null, 'the outcome states no reserve the leg was never armed with');
  assert.equal(o.neededReservePct, 35);
});

test('★★★ a cap writes nothing, whatever its outcome states', () => {
  const leg = midday({ targetPct: 45, forceChargeCeilingPct: 85 });
  const forged = { ...liveRefreshOutcome(leg, plan({ setpointSocPct: 50 })), reservePct: 30, forceChargeCeilingPct: 60 };
  assert.equal(forged.disposition, 'capped');
  assert.deepEqual(applyLiveRefresh(leg, forged, OPEN - 20 * M), { ...leg, refreshedAtMs: OPEN - 20 * M });
  for (const d of ['capped', 'unchanged', 'stood'] as const) {
    assert.deepEqual(applyLiveRefresh(leg, { ...forged, disposition: d }, OPEN - 20 * M), { ...leg, refreshedAtMs: OPEN - 20 * M }, d);
  }
});

test('★★★ re-read after the await: a leg re-armed, cancelled, attempted or refreshed meanwhile is not refreshed', () => {
  const leg = midday();
  assert.equal(refreshAborted(leg, leg), null);
  assert.equal(refreshAborted(leg, { ...leg }), null);
  assert.match(refreshAborted(leg, midday({ day: '2026-10-15' }))!, /no longer holds/);
  assert.match(refreshAborted(leg, midday({ windowStartMs: OPEN + H }))!, /no longer holds/);
  assert.match(refreshAborted(leg, midday({ announcedAtMs: phx(10, 14, 22) }))!, /re-announced/);
  assert.match(refreshAborted(leg, midday({ applyAttemptedAtMs: OPEN - 4 * M }))!, /attempted/);
  assert.match(refreshAborted(leg, midday({ cancelled: true }))!, /cancelled/);
  assert.match(refreshAborted(leg, midday({ refreshedAtMs: OPEN - 21 * M }))!, /already refreshed/);
});

test('★★ the refresh ledger columns: the cost leg\'s refreshed_* columns, with the weather age', () => {
  const o = liveRefreshOutcome(midday(), plan({ costCeilingSocPct: 80, expectedWriteLevelPct: 80, setpointSocPct: 45, expectedBuyKwh: 20, buyKwh: 40 }));
  assert.deepEqual(liveRefreshLedgerColumns(o, OPEN - 20 * M, 1500), {
    refreshed_at_ms: OPEN - 20 * M, refresh_disposition: 'lowered', refreshed_level_pct: 80, refreshed_reserve_pct: 45,
    refreshed_buy_kwh: 40, refresh_weather_age_s: 1500,
  });
});

/* ══ the forecast's weather age ═════════════════════════════════════════════ */

test('★★★ a forecast on weather older than 45 minutes defers the refresh; unknown is not fresh', () => {
  const now = OPEN - 20 * M;
  assert.equal(REFRESH_MAX_WEATHER_AGE_MS, 45 * M);
  assert.equal(refreshWeatherFresh(now - 45 * M, now), true);
  assert.equal(refreshWeatherFresh(now - 45 * M - 1, now), false);
  assert.equal(refreshWeatherFresh(null, now), false);
  assert.equal(refreshWeatherFresh(undefined, now), false);
  assert.equal(weatherAgeSeconds(now - 25 * M, now), 1500);
  assert.equal(weatherAgeSeconds(null, now), null);
});

test('★★★ getWeather: a caller\'s maxAgeMs shortens the 2 h cache for that call only; a failed fetch still serves the stale cache', async () => {
  assert.equal(weatherMaxAgeMs(undefined), 2 * H);
  assert.equal(weatherMaxAgeMs(45 * M), 45 * M);
  assert.equal(weatherMaxAgeMs(5 * H), 2 * H, 'never longer than the cache');
  assert.equal(weatherMaxAgeMs(Number.NaN), 2 * H);
  assert.equal(weatherMaxAgeMs(-1), 2 * H);
  const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('undici');
  const prev = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  let fetches = 0;
  let fail = false;
  agent.get('https://api.open-meteo.com')
    .intercept({ path: (p: string) => p.startsWith('/v1/forecast'), method: 'GET' })
    .reply(() => {
      fetches++;
      return fail ? { statusCode: 503, data: '' } : { statusCode: 200, data: { utc_offset_seconds: 0, hourly: { time: ['2026-10-15T17:00'], cloud_cover: [10], shortwave_radiation: [500], temperature_2m: [20] } } };
    }).persist();
  setGlobalDispatcher(agent);
  mock.timers.enable({ apis: ['Date'], now: OPEN - 3 * H });
  try {
    clearWeatherTestOverride();
    const a = await getWeather();
    assert.equal(fetches, 1);
    mock.timers.tick(50 * M);
    const b = await getWeather();
    assert.equal(fetches, 1, 'every other caller: the 2 h cache, as before');
    assert.equal(b, a);
    const c = await getWeather(() => {}, { maxAgeMs: 45 * M });
    assert.equal(fetches, 2, 'the refresh: 50 min is too old, so the weather is fetched');
    assert.equal(c!.fetchedAt, OPEN - 3 * H + 50 * M);
    assert.equal(await getWeather(() => {}, { maxAgeMs: 45 * M }), c, 'fresh now: served');
    assert.equal(fetches, 2);
    mock.timers.tick(46 * M);
    fail = true;
    const d = await getWeather(() => {}, { maxAgeMs: 45 * M });
    assert.equal(fetches, 3);
    assert.equal(d, c, 'a failed fetch serves the stale cache — the caller reads its age');
    assert.equal(d!.fetchedAt, OPEN - 3 * H + 50 * M);
  } finally {
    mock.timers.reset();
    setGlobalDispatcher(prev);
    await agent.close();
    clearWeatherTestOverride();
  }
});

test('★★★ getDayForecast: maxWeatherAgeMs rebuilds a forecast built on older weather, and the band carries the weather time; without it, as before', async () => {
  const SN = 'DPU-R5';
  const devices: Record<string, DeviceSnapshot> = {
    [SN]: { sn: SN, deviceName: 'Core 1', online: true, projection: { kind: 'dpu', soc: 80, packs: [] } } as unknown as DeviceSnapshot,
  };
  const rec = makeRecorderStub({ query: () => [] });
  const wx = (fetchedAt: number) => ({ fetchedAt, lat: 0, lon: 0, hours: [{ ts: fetchedAt, radiationWm2: 0, cloudCoverPct: 0, tempC: 20 }] });
  resetForecastCachesForTesting();
  try {
    const t0 = Date.now();
    setWeatherCacheForTesting(wx(t0 - 60 * M) as never);
    const a = await getDayForecast(devices, rec);
    assert.equal(a.weatherFetchedAtMs, t0 - 60 * M, 'the forecast says which weather it was built on');
    // Newer weather lands (another caller's fetch): an ordinary caller still gets the cached forecast.
    setWeatherCacheForTesting(wx(t0 - 1 * M) as never);
    assert.equal(await getDayForecast(devices, rec), a, 'without maxWeatherAgeMs: exactly as before');
    // The refresh: the cached forecast was built on other weather — rebuilt on the newest.
    const b = await getDayForecast(devices, rec, () => {}, { maxWeatherAgeMs: 45 * M });
    assert.notEqual(b, a);
    assert.equal(b.weatherFetchedAtMs, t0 - 1 * M);
    // Built on the newest weather already: served from the cache.
    assert.equal(await getDayForecast(devices, rec, () => {}, { maxWeatherAgeMs: 45 * M }), b);
    // The band carries the weather time of the forecast it was built on.
    const band = await computeProbabilisticForecast(b, null);
    assert.equal(band.weatherFetchedAtMs, t0 - 1 * M);
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

/* ══ the wiring (index.ts is not importable: its source is checked) ═══════════ */

const INDEX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const REPORTS = readFileSync(new URL('../src/reports.ts', import.meta.url), 'utf8');

function refreshBlock(): string {
  const a = INDEX.indexOf('async function runMorningRefreshTickInner(');
  const b = INDEX.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'the refresh block is found');
  return INDEX.slice(a, b);
}

test('★★★ index.ts: the refresh asks the worker for fresh weather, defers on older, re-reads after the await, stamps before it pushes, never speaks', () => {
  const blk = refreshBlock();
  // Inert: the first test is liveRefreshDue on the cycle.
  assert.match(blk, /^async function runMorningRefreshTickInner\(nowMs: number\): Promise<void> \{\n {2}const due = liveRefreshDue\(nightCycleView\(\), nowMs\);\n {2}if \(due == null\) return;/);
  // The worker's forecast on fresh weather, never the main thread's cached answer.
  assert.match(blk, /await recomputeNightChargePlan\(\{ shadowLeg: sizing, maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS \}\);/);
  assert.match(INDEX, /\? analytics\.report<ProbabilisticForecast>\('probabilisticForecast', \{ maxWeatherAgeMs: wxAge \}\)/);
  assert.match(INDEX, /\? analytics\.report<DayForecast>\('forecast', \{ maxWeatherAgeMs: wxAge \}\)/);
  // Every other caller passes none: the two reports are requested exactly as before.
  assert.match(INDEX, /\n {2}const wxAge = opts\.maxWeatherAgeMs;\n/);
  assert.match(INDEX, /: analytics\.report<ProbabilisticForecast>\('probabilisticForecast'\)\)\.catch\(\(\) => null\),/);
  assert.match(INDEX, /: analytics\.report<DayForecast>\('forecast'\)\)\.catch\(\(\) => null\),/);
  assert.equal(INDEX.split('maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS').length - 1, 1, 'only the live refresh asks for fresh weather');
  // A pinned leg's plan says when its band's weather was fetched.
  assert.match(INDEX, /\.\.\.\(shadowLeg \? \{ weatherFetchedAtMs: prob\?\.weatherFetchedAtMs \?\? dayAhead\?\.weatherFetchedAtMs \?\? null \} : \{\}\),/);
  assert.match(INDEX, /weatherFetchedAtMs: r\.extras\.weatherFetchedAtMs \?\? null,\n/);
  assert.match(REPORTS, /forecast: \(ctx, a\) => getDayForecast\(devicesOf\(ctx\), ctx\.recorder, ctx\.log, weatherAgeOpts\(a\)\),/);
  assert.match(REPORTS, /probabilisticForecast: async \(ctx, a\) => \{\n\s+const fc = await getDayForecast\(devicesOf\(ctx\), ctx\.recorder, ctx\.log, weatherAgeOpts\(a\)\);/);
  // Older weather defers, before anything is decided.
  // The clock after the await judges what follows it: the deadline first, then the weather's age.
  const awaited = blk.indexOf('const r = await recomputeNightChargePlan(');
  const at = blk.indexOf('const at = Date.now();');
  const late = blk.indexOf('if (refreshPastDeadline(leg, at)) {');
  const fresh = blk.indexOf('if (!refreshWeatherFresh(wxAt, at)) {');
  const reread = blk.indexOf('const aborted = refreshAborted(leg, live);');
  const decide = blk.indexOf('const o = liveRefreshOutcome(live, r.plan);');
  const persist = blk.indexOf('persistNightActuation(applyLiveRefresh(live, o, at));');
  const push = blk.indexOf('void sendNotification(loadNotifyConfig(), msg)');
  assert.ok(awaited > 0 && awaited < at && at < late && late < fresh, 'await → the clock → the deadline → the weather');
  assert.ok(fresh < reread && reread < decide && decide < persist && persist < push, 'fresh → re-read → decide → persist → push');
  assert.match(blk.slice(late), /^if \(refreshPastDeadline\(leg, at\)\) \{\n[^\n]*\n\s+return;\n/);
  assert.match(blk, /stampLegOutcome\(live, liveRefreshLedgerColumns\(o, at, weatherAgeSeconds\(wxAt, at\)\)\);/);
  assert.match(blk.slice(reread), /^const aborted = refreshAborted\(leg, live\);\n\s+if \(aborted != null\) \{/);
  // The push is told the outcome's figures, the reserve a cap came from among them.
  assert.ok(blk.includes('    neededLevelPct: o.neededLevelPct,\n    neededReservePct: o.neededReservePct,\n'), 'what a reserve cap was asked for');
  assert.match(blk, /const live = nightActuationMem;\n/);
  // A push, never speech; nothing re-arms.
  for (const banned of ['broadcast.', 'announce(', 'armFromPlan(', 'armCycle(', 'setBackupReserveSoc', 'setChannelForceCharge']) {
    assert.ok(!blk.includes(banned), `${banned} in the refresh`);
  }
  // The standing arm is stamped once, and pushes nothing.
  const stand = blk.slice(blk.indexOf("if (due === 'stand') {"), blk.indexOf('const model = apsREvModelFromEnv();'));
  assert.ok(stand.includes('persistNightActuation(applyLiveRefresh(leg, o, nowMs));'));
  assert.ok(!stand.includes('sendNotification'));
  // Its own single-flight tick.
  assert.match(INDEX, /const nightMorningRefreshTick = setInterval\(\(\) => \{ void runMorningRefreshTick\(\); \}, 60 \* 1000\);/);
  assert.match(INDEX, /if \(morningRefreshInFlight\) return;\n\s+morningRefreshInFlight = true;/);
});
