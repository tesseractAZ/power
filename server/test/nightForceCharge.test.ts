import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideForceCharge, forceChargeEnabled, desiredForceChargeCeilingPct, forceChargeInFlight,
  FORCE_CHARGE_MIN_RUN_MS, FORCE_CHARGE_MAX_RUN_MS, FORCE_CHARGE_OFF_VERIFY_AFTER_MS,
  FORCE_CHARGE_OFF_MAX_RETRIES, FORCE_CHARGE_OFF_PERSIST_EVERY_MS, FORCE_CHARGE_CEILING_VERIFY_AFTER_MS,
  FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS, FORCE_CHARGE_PLAN_RATE_KW, FORCE_CHARGE_JIT_BUFFER_MS,
  forceChargeStartAtMs, type ForceChargeOpts,
} from '../src/nightForceCharge.js';
import {
  emptyActuationState, coerceActuationState, armFromPlan, RESERVE_WRITE_MAX_PCT,
  type NightActuationState, type ArmablePlan,
} from '../src/nightChargeActuator.js';
import { FORCE_CHARGE_COOLDOWN_MS } from '../src/ecoflow/commands.js';
import { classifyChange } from '../src/settingsDrift.js';
import { buildNightChargeMessage } from '../src/notify.js';
import type { NightChargePlan } from '../src/nightChargeAdvisor.js';
import { costCeilingKwh, costModeTargetKwh } from '../src/nightChargeAdvisor.js';

/**
 * v1.165.0 — force-charge rides the night-charge window.
 *
 * 2026-09-16: the SHP2 caps backupReserveSoc at 50 (a 90 write settled at 50). That
 * night the panel charged 16% -> 49% by 01:00 at ~15 kW into the pack, then sat
 * FLAT at 49% until 05:00 — four hours of overnight window unused. Force-charge
 * (`ch{n}ForceCharge`, the app's "Charge Now") continues past the reserve up to
 * the panel's own `foceChargeHight` ceiling.
 *
 * It is also the control behind the 2026-08-04 on-peak buy: a force-charge left ON
 * buys grid power at the day's highest rate for hours. So the tests below lean on
 * the OFF side: it must be unconditional, restart-safe, verified, and self-healing.
 */

const H = 3_600_000;
const WIN_START = Date.UTC(2026, 8, 17, 6, 0);   // 23:00 MST
const WIN_END = WIN_START + 6 * H;               // 05:00 MST

/** A night whose reserve write was applied AND verified — the only kind force-charge rides. */
const verifiedNight = (over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(),
  day: '2026-09-16', targetPct: 50, buyKwh: 40,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * 60_000, attemptBaselinePct: 16,
  appliedAtMs: WIN_START - 5 * 60_000, priorReservePct: 16,
  applyVerifiedAtMs: WIN_START + 60_000,
  forceChargeCeilingPct: 90, // the announced plan's economic ceiling
  ...over,
});
const forcedNight = (over: Partial<NightActuationState> = {}): NightActuationState =>
  verifiedNight({ forceChargeOnAtMs: WIN_START + 2 * 60_000, forceChargeSlots: [1, 2, 3], ...over });

const opts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 90, // the panel already reads the fixture night's 90% ceiling
  // v1.167.0 — a pool far enough below the 90% target that the just-in-time start is
  // already due at MID (64 kWh needed ⇒ a ~6.7 h lead in a 6 h window). The JIT timing
  // itself is exercised below with a realistic 50% pool.
  poolSocPct: 20, fullKwh: 92,
  ...over,
});
const MID = WIN_START + 2 * H;

/* ══ the gate ═════════════════════════════════════════════════════════════ */

test('the gate is the options the owner already set — cost mode with a ceiling above the reserve', () => {
  const g = (o: Partial<Parameters<typeof forceChargeEnabled>[0]> = {}) => forceChargeEnabled({
    mode: 'auto', objective: 'cost', costMaxSocPct: 90, reserveWriteMaxPct: RESERVE_WRITE_MAX_PCT, ...o,
  });
  assert.equal(g(), true, 'the live config: auto + cost + 90');
  assert.equal(g({ mode: 'supervised' }), true);
  assert.equal(g({ mode: 'advisory' }), false, 'advisory never writes');
  assert.equal(g({ objective: 'resilience' }), false);
  assert.equal(g({ costMaxSocPct: 50 }), false, 'THE KILL SWITCH: a ceiling at the reserve buys nothing past it');
  assert.equal(g({ costMaxSocPct: Number.NaN }), false, 'an unparseable option fails closed');
});

test('the ceiling synced onto the panel is the owner ceiling, clamped to the device range', () => {
  assert.equal(desiredForceChargeCeilingPct(90), 90);
  assert.equal(desiredForceChargeCeilingPct(60), 80, 'the panel documents 80 as its minimum');
  assert.equal(desiredForceChargeCeilingPct(120), 100);
  assert.equal(desiredForceChargeCeilingPct(85.4), 85);
});

/* ══ ON — narrow, and only on a working night ═════════════════════════════ */

test('★★ ON rides only a night whose reserve write was applied AND verified', () => {
  assert.deepEqual(decideForceCharge(verifiedNight(), MID, opts()), { kind: 'on', slots: [1, 2, 3] });
  assert.equal(decideForceCharge(verifiedNight({ appliedAtMs: null }), MID, opts()).kind, 'none');
  assert.equal(decideForceCharge(verifiedNight({ applyVerifiedAtMs: null }), MID, opts()).kind, 'none',
    'an unverified write is exactly the night the write path may not be working');
});

test('★★ ON is never before the window opens, nor too close to its end to matter', () => {
  assert.equal(decideForceCharge(verifiedNight(), WIN_START - 1, opts()).kind, 'none',
    'never before 23:00 — the overnight rate has not started');
  assert.equal(decideForceCharge(verifiedNight(), WIN_END - FORCE_CHARGE_MIN_RUN_MS, opts()).kind, 'none');
  assert.equal(decideForceCharge(verifiedNight(), WIN_START, opts()).kind, 'on');
});

test('★★★ ON needs the grid KNOWN present — an unknown grid never starts a grid charge', () => {
  assert.equal(decideForceCharge(verifiedNight(), MID, opts({ gridPresent: null })).kind, 'none');
  assert.equal(decideForceCharge(verifiedNight(), MID, opts({ gridPresent: false })).kind, 'none');
  assert.equal(decideForceCharge(verifiedNight(), MID, opts({ gridStaLost: true })).kind, 'none',
    'the panel\'s own gridSta=0 vetoes a start even if the resolver says present');
});

test('★★ ON never takes ownership of an operator\'s Charge Now, and needs a live readback', () => {
  assert.equal(decideForceCharge(verifiedNight(), MID, opts({ slotsOn: [2] })).kind, 'none',
    'someone else switched force-charge on — it is theirs, and the OFF must not be ours to issue');
  assert.equal(decideForceCharge(verifiedNight(), MID, opts({ slotsOn: null })).kind, 'none');
});

test('ON respects every other guard, and happens at most once a night', () => {
  const n = verifiedNight();
  assert.equal(decideForceCharge(n, MID, opts({ enabled: false })).kind, 'none');
  assert.equal(decideForceCharge(n, MID, opts({ vitalsRed: true })).kind, 'none');
  assert.equal(decideForceCharge(n, MID, opts({ socCoherent: false })).kind, 'none');
  assert.equal(decideForceCharge(verifiedNight({ cancelled: true }), MID, opts()).kind, 'none');
  assert.equal(decideForceCharge(verifiedNight({ revertedAtMs: MID - 1 }), MID, opts()).kind, 'none');
  assert.equal(decideForceCharge(n, MID, opts({ connectedSlots: [] })).kind, 'none');
  assert.deepEqual(decideForceCharge(n, MID, opts({ connectedSlots: [1, 3, 7] })), { kind: 'on', slots: [1, 3] },
    'only real slots');
  // Switched on, then switched off for the ceiling-free reasons — never again tonight.
  const done = forcedNight({ forceChargeOffAtMs: MID, forceChargeOffVerifiedAtMs: MID + 60_000 });
  assert.equal(decideForceCharge(done, MID + 2 * 60_000, opts()).kind, 'none');
});

test('★★★ v1.167.0 — ANY target above the reserve is reachable; the panel\'s 80% minimum no longer matters', () => {
  // Owner design (2026-09-17): "run forcecharge until the desired percentage is reached,
  // then revert." v1.165.0 refused every target under the panel's 80% force-charge minimum —
  // which was every sunny night, 2026-09-17's 64.3% included.
  assert.equal(decideForceCharge(verifiedNight({ forceChargeCeilingPct: 90 }), MID, opts()).kind, 'on');
  assert.equal(decideForceCharge(verifiedNight({ forceChargeCeilingPct: 64.3 }), MID, opts({ ceilingReadbackPct: 80 })).kind, 'on',
    'the 2026-09-17 night: now force-charged, with the panel\'s 80 as a backstop');
  assert.equal(decideForceCharge(verifiedNight({ forceChargeCeilingPct: 50 }), MID, opts()).kind, 'none',
    'at the reserve there is nothing to add');
  assert.equal(decideForceCharge(verifiedNight({ forceChargeCeilingPct: null }), MID, opts()).kind, 'none',
    'no announced ceiling (resilience mode, or a pre-1.165 record) never starts');
  assert.equal(decideForceCharge(verifiedNight({ forceChargeCeilingPct: Number.NaN }), MID, opts()).kind, 'none');
});

test('★★★ JUST IN TIME: it starts late enough to arrive AT the target as the window closes', () => {
  // A realistic night: the reserve has carried the pack to 50% and holds the house on grid.
  // Starting at 23:00 would reach 64.3% by ~02:00 and let the house draw it back toward 50
  // (≈57% by 05:00). Starting late leaves nothing to drain.
  const n = verifiedNight({ forceChargeCeilingPct: 64.3 });
  const o = opts({ ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16 });
  const startAt = forceChargeStartAtMs(WIN_END, 64.3, 50, 92.16);
  // 13.18 kWh at the planned 10 kW = 79 min, + the 15 min buffer ⇒ ~94 min before 05:00.
  assert.equal(Math.round((WIN_END - startAt) / 60_000), 94);
  assert.equal(decideForceCharge(n, MID, o).kind, 'none', 'at 01:00 it holds off — hours early would drain');
  assert.match((decideForceCharge(n, MID, o) as { why?: string }).why ?? '', /^just in time/);
  assert.equal(decideForceCharge(n, startAt - 1, o).kind, 'none');
  assert.equal(decideForceCharge(n, startAt, o).kind, 'on', '…and starts at the last responsible moment');
});

test('the start moves with the pool, and the plan rate is deliberately below the measured ~15 kW', () => {
  assert.equal(FORCE_CHARGE_PLAN_RATE_KW, 10, 'an EV sharing the grid input slows the pack — plan below the measured peak');
  assert.equal(FORCE_CHARGE_JIT_BUFFER_MS, 15 * 60_000);
  const lead = (soc: number) => WIN_END - forceChargeStartAtMs(WIN_END, 80, soc, 100);
  assert.ok(lead(50) > lead(70), 'a fuller pack starts later');
  assert.equal(lead(80), FORCE_CHARGE_JIT_BUFFER_MS, 'nothing needed ⇒ only the buffer');
});

test('★★ the "why" while waiting is STABLE — a reason that changed every tick would log every tick', () => {
  const n = verifiedNight({ forceChargeCeilingPct: 64.3 });
  const w = (soc: number) => (decideForceCharge(n, MID, opts({ ceilingReadbackPct: 80, poolSocPct: soc, fullKwh: 92.16 })) as { why?: string }).why;
  assert.equal(w(50), w(51), 'the computed start moves with the SoC; the logged reason must not');
});

test('★★ the panel\'s ceiling is synced as soon as the night is live — hours BEFORE the start', () => {
  // Its readback takes minutes; waiting for the start moment to sync would delay the ON.
  const n = verifiedNight({ forceChargeCeilingPct: 64.3 });
  const d = decideForceCharge(n, WIN_START + 60_000, opts({ ceilingReadbackPct: 100, poolSocPct: 30, fullKwh: 92.16 }));
  assert.deepEqual(d, { kind: 'syncCeiling', pct: 80, prior: 100 },
    'at 23:01 — the start is hours away; below 80 the panel\'s 80 is the BACKSTOP for a failed software stop');
});

test('★★ below-target guards: at or past the target, or with no live pool reading, it does not start', () => {
  const n = verifiedNight({ forceChargeCeilingPct: 64.3 });
  const why = (o: ForceChargeOpts) => (decideForceCharge(n, WIN_END - 60 * 60_000, o) as { why?: string }).why ?? '';
  assert.match(why(opts({ ceilingReadbackPct: 80, poolSocPct: 64.3 })), /already at tonight's 64\.3% target/);
  assert.match(why(opts({ ceilingReadbackPct: 80, poolSocPct: null })), /no live pool reading/);
  assert.match(why(opts({ ceilingReadbackPct: 80, fullKwh: null })), /no live pool reading/);
});

test('★★ arming captures the plan\'s ceiling — a fresher recompute never substitutes', () => {
  const a = armFromPlan(emptyActuationState(), '2026-09-17', { ...ARM, costCeilingSocPct: 84.2 }, WIN_END + 16 * H, 16);
  assert.equal(a!.forceChargeCeilingPct, 84.2);
  const r = armFromPlan(emptyActuationState(), '2026-09-17', { ...ARM, costCeilingSocPct: null }, WIN_END + 16 * H, 16);
  assert.equal(r!.forceChargeCeilingPct, null, 'resilience mode arms reserve-only');
  const back = coerceActuationState(JSON.parse(JSON.stringify(a)));
  assert.equal(back.forceChargeCeilingPct, 84.2, 'and it survives a restart');
});

test('★★ ONE definition of the economic ceiling — the planner and the force-charge share it', () => {
  // min(maxSoc, full - P90 morning surplus); a present forecast can only LOWER it.
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusP90Kwh: 25, maxSocPct: 90 }),
    { ceilingKwh: 75, basis: 'pv-headroom' });
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusP90Kwh: 5, maxSocPct: 90 }),
    { ceilingKwh: 90, basis: 'max-soc' });
  assert.deepEqual(costCeilingKwh({ fullKwh: 100, morningPvSurplusP90Kwh: null, maxSocPct: 90 }),
    { ceilingKwh: 90, basis: 'max-soc' }, 'no forecast never means "fill to 100"');
  // costModeTargetKwh is the same ceiling floored by reserve and resilience.
  const t = costModeTargetKwh({ fullKwh: 100, reserveKwh: 16, morningPvSurplusP90Kwh: 25, maxSocPct: 90, resilienceTargetKwh: 40 });
  assert.equal(t.targetKwh, 75);
  assert.equal(t.ceilingBasis, 'pv-headroom');
});

/* ══ OFF — unconditional ═══════════════════════════════════════════════════ */

test('★★★ OFF at window end — even with a STALE readback', () => {
  const d = decideForceCharge(forcedNight(), WIN_END, opts({ slotsOn: null }));
  assert.deepEqual(d, { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' },
    'switching off is time-based; it must never wait for a fresh reading');
  assert.equal(decideForceCharge(forcedNight(), WIN_END - 1, opts()).kind, 'none', 'held on inside the window');
});

test('★★★ OFF on every other stop condition', () => {
  const r = (n: NightActuationState, o = opts()) => (decideForceCharge(n, MID, o) as { reason?: string }).reason;
  assert.equal(r(forcedNight({ cancelled: true })), 'cancelled');
  assert.equal(r(forcedNight({ revertedAtMs: MID - 1 })), 'reverted');
  assert.equal(r(forcedNight(), opts({ gridPresent: false })), 'gridLoss');
  assert.equal(r(forcedNight(), opts({ gridStaLost: true })), 'gridLoss',
    'the panel\'s own gridSta=0 is an independent grid-loss signal');
  assert.equal(r(forcedNight({ windowEndMs: null })), 'windowEnd', 'a missing window cannot say when to stop');
});

test('★★★ v1.167.0 — OFF the moment the pack REACHES the target', () => {
  const n = forcedNight({ forceChargeCeilingPct: 64.3 });
  assert.deepEqual(decideForceCharge(n, MID, opts({ poolSocPct: 64.3 })), { kind: 'off', slots: [1, 2, 3], reason: 'target' });
  assert.equal(decideForceCharge(n, MID, opts({ poolSocPct: 64.2 })).kind, 'none', 'still short: keep charging');
  assert.equal(decideForceCharge(n, MID, opts({ poolSocPct: null })).kind, 'none',
    'an unknown SoC never ends it early — the window end and the panel\'s ceiling still do');
  assert.equal((decideForceCharge(n, WIN_END, opts({ poolSocPct: null })) as { reason?: string }).reason, 'windowEnd');
});

test('★★★ OFF is ENABLE-INDEPENDENT — disabling mid-night stops a force-charge we started', () => {
  assert.deepEqual(decideForceCharge(forcedNight(), MID, opts({ enabled: false })),
    { kind: 'off', slots: [1, 2, 3], reason: 'disabled' });
});

test('★★ MAX_RUN — a corrupted window can never hold a force-charge on', () => {
  const on = WIN_START + 2 * 60_000;
  const n = forcedNight({ forceChargeOnAtMs: on, windowEndMs: on + 48 * H }); // absurd window
  assert.equal(decideForceCharge(n, on + FORCE_CHARGE_MAX_RUN_MS - 1, opts()).kind, 'none');
  assert.equal((decideForceCharge(n, on + FORCE_CHARGE_MAX_RUN_MS, opts()) as { reason?: string }).reason, 'maxRun');
});

test('★★★ an ON stamped with no readable slot list switches off — and verifies — all three', () => {
  for (const slots of [null, [] as number[]]) {
    const n = forcedNight({ forceChargeSlots: slots });
    assert.deepEqual(decideForceCharge(n, WIN_END, opts()), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
    const off = { ...n, forceChargeOffAtMs: WIN_END };
    assert.equal(decideForceCharge(off, WIN_END + 60_000, opts({ slotsOn: [2] })).kind, 'none',
      'slot 2 still ON must NOT read as "nothing still on"');
  }
});

/* ══ VERIFY — and it heals ════════════════════════════════════════════════ */

const offNight = (over: Partial<NightActuationState> = {}) =>
  forcedNight({ forceChargeOffAtMs: WIN_END, forceChargeOffLastAttemptMs: WIN_END, forceChargeOffReason: 'windowEnd', ...over });

test('OFF verifies by readback, waits on an unknown one, and re-issues the stragglers', () => {
  assert.equal(decideForceCharge(offNight(), WIN_END + 60_000, opts({ slotsOn: [] })).kind, 'offVerified');
  assert.equal(decideForceCharge(offNight(), WIN_END + 60_000, opts({ slotsOn: null })).kind, 'none');
  assert.equal(decideForceCharge(offNight(), WIN_END + 60_000, opts({ slotsOn: [2] })).kind, 'none', 'inside the grace');
  assert.deepEqual(
    decideForceCharge(offNight(), WIN_END + FORCE_CHARGE_OFF_VERIFY_AFTER_MS, opts({ slotsOn: [2, 3] })),
    { kind: 'offRetry', slots: [2, 3] },
  );
});

test('★★★ after the escalation the OFF KEEPS being re-issued — escalation changes loudness, not effort', () => {
  // Review finding: the first cut stopped writing after two re-issues (~18 min in). A
  // command path failing 05:00-05:18 then left force-charge ON through the weekday into
  // the 16:00 on-peak — the 2026-08-04 incident, rebuilt.
  const late = WIN_END + 10 * FORCE_CHARGE_OFF_VERIFY_AFTER_MS;
  const exhausted = offNight({ forceChargeOffRetries: FORCE_CHARGE_OFF_MAX_RETRIES });
  assert.deepEqual(decideForceCharge(exhausted, late, opts({ slotsOn: [1] })), { kind: 'offFailed', slots: [1] });
  const escalated = { ...exhausted, forceChargeOffEscalated: true, forceChargeOffLastAttemptMs: late };
  assert.equal(decideForceCharge(escalated, late + 60_000, opts({ slotsOn: [1] })).kind, 'none', 'no second page, no spam');
  assert.deepEqual(decideForceCharge(escalated, late + FORCE_CHARGE_OFF_PERSIST_EVERY_MS, opts({ slotsOn: [1] })),
    { kind: 'offRetry', slots: [1] }, 'still re-issuing OFF, every 15 min, for as long as it reads ON');
  assert.deepEqual(decideForceCharge(escalated, late + 12 * H, opts({ slotsOn: [1] })),
    { kind: 'offRetry', slots: [1] }, '…including hours later, into the afternoon');
  assert.equal(decideForceCharge(escalated, late + 60_000, opts({ slotsOn: [] })).kind, 'offVerified',
    'fixed from the app — the record must resolve itself, or it wedges every later night');
});

test('the persistent re-issue stays above the per-slot write cooldown', () => {
  assert.ok(FORCE_CHARGE_OFF_PERSIST_EVERY_MS > FORCE_CHARGE_COOLDOWN_MS);
});

/* ══ the ceiling — read back before ON, restored after ═══════════════════ */

test('★★★ ON waits until the panel READS the night\'s ceiling — never on an unverified write', () => {
  // Review finding: ON in the same tick as an unverified ceiling write fills to whatever
  // the panel holds (100 live) — past the owner's 90 and past the solar headroom.
  const n = verifiedNight({ forceChargeCeilingPct: 90 });
  assert.equal(decideForceCharge(n, MID, opts({ ceilingReadbackPct: null })).kind, 'none', 'no live ceiling reading');
  assert.deepEqual(decideForceCharge(n, MID, opts({ ceilingReadbackPct: 100 })),
    { kind: 'syncCeiling', pct: 90, prior: 100 }, 'sync first, remembering the panel\'s own 100');
  const synced = { ...n, forceChargeCeilingAttemptedAtMs: MID, forceChargeCeilingPriorPct: 100 };
  assert.equal(decideForceCharge(synced, MID + 60_000, opts({ ceilingReadbackPct: 100 })).kind, 'none',
    'waits out the readback grace — no ON on a ceiling that has not landed');
  assert.deepEqual(decideForceCharge(synced, MID + FORCE_CHARGE_CEILING_VERIFY_AFTER_MS, opts({ ceilingReadbackPct: 100 })),
    { kind: 'syncCeiling', pct: 90, prior: 100 }, 'one retry');
  const refused = { ...synced, forceChargeCeilingSyncRetries: 1 };
  assert.equal(decideForceCharge(refused, MID + 2 * FORCE_CHARGE_CEILING_VERIFY_AFTER_MS, opts({ ceilingReadbackPct: 100 })).kind,
    'none', 'the panel will not take it: reserve-only tonight, never an overfill');
  assert.deepEqual(decideForceCharge(synced, MID + 60_000, opts({ ceilingReadbackPct: 90 })),
    { kind: 'on', slots: [1, 2, 3] }, 'reads 90 → ON');
});

test('★★★ the panel\'s own ceiling is RESTORED once tonight is done with it', () => {
  // Review finding: without this, the owner's storm-prep Charge Now silently stops at
  // tonight's 90 instead of the panel's 100 — forever, and nothing says so.
  const done = offNight({ forceChargeOffVerifiedAtMs: WIN_END + 60_000, forceChargeCeilingPriorPct: 100 });
  const t = WIN_END + 2 * 60_000;
  assert.deepEqual(decideForceCharge(done, t, opts({ ceilingReadbackPct: 90 })),
    { kind: 'restoreCeiling', pct: 100, lastAttempt: false });
  assert.equal(decideForceCharge(done, t, opts({ ceilingReadbackPct: 100 })).kind, 'ceilingRestored');
  assert.equal(decideForceCharge(done, t, opts({ ceilingReadbackPct: null })).kind, 'none');
  const tried = { ...done, forceChargeCeilingRestoreAttempts: 1, forceChargeCeilingRestoreLastAttemptMs: t };
  assert.equal(decideForceCharge(tried, t + 60_000, opts({ ceilingReadbackPct: 90 })).kind, 'none', 'readback grace');
  assert.deepEqual(decideForceCharge(tried, t + FORCE_CHARGE_CEILING_VERIFY_AFTER_MS, opts({ ceilingReadbackPct: 90 })),
    { kind: 'restoreCeiling', pct: 100, lastAttempt: true }, 'the last attempt says so');
  const gaveUp = { ...tried, forceChargeCeilingRestoreAttempts: FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS };
  assert.equal(decideForceCharge(gaveUp, t + 2 * FORCE_CHARGE_CEILING_VERIFY_AFTER_MS, opts({ ceilingReadbackPct: 90 })).kind, 'none');
  // Synced but never switched ON (e.g. the ON was refused) — restored once the night is over.
  const neverOn = verifiedNight({ forceChargeCeilingAttemptedAtMs: MID, forceChargeCeilingPriorPct: 100 });
  assert.equal(decideForceCharge(neverOn, WIN_END, opts({ ceilingReadbackPct: 90 })).kind, 'restoreCeiling');
  assert.notEqual(decideForceCharge(neverOn, MID, opts({ ceilingReadbackPct: 100 })).kind, 'restoreCeiling',
    'not mid-night: the night is still ours');
});

test('★★ an unrestored original is carried into the next night, so the restore returns the OWNER\'s value', () => {
  const failed = offNight({
    revertedAtMs: WIN_END + 5 * 60_000, forceChargeOffVerifiedAtMs: WIN_END + 60_000,
    forceChargeCeilingPriorPct: 100, forceChargeCeilingRestoreAttempts: 2,
  });
  const next = armFromPlan(failed, '2026-09-17', { ...ARM, costCeilingSocPct: 90 }, WIN_END + 16 * H, 16);
  assert.equal(next!.forceChargeCeilingPriorPct, 100, 'our leftover 90 must never be mistaken for the owner\'s ceiling');
  const clean = { ...failed, forceChargeCeilingRestoredAtMs: WIN_END + 10 * 60_000 };
  assert.equal(armFromPlan(clean, '2026-09-17', ARM, WIN_END + 16 * H, 16)!.forceChargeCeilingPriorPct, null);
  // and the next night's sync keeps it rather than capturing the leftover
  const n2 = verifiedNight({ forceChargeCeilingPriorPct: 100 });
  assert.deepEqual(decideForceCharge(n2, MID, opts({ ceilingReadbackPct: 85 })),
    { kind: 'syncCeiling', pct: 90, prior: 100 });
});

test('★★★ the verify grace outlasts the per-slot write cooldown', () => {
  // The re-issue goes through the same `charge-now-ch{n}` cooldown. A shorter grace
  // makes every retry come back rate-limited: the budget is spent on writes that
  // never reach the panel, and a merely-slow readback escalates as "stuck ON".
  assert.ok(FORCE_CHARGE_OFF_VERIFY_AFTER_MS > FORCE_CHARGE_COOLDOWN_MS,
    `${FORCE_CHARGE_OFF_VERIFY_AFTER_MS} must exceed ${FORCE_CHARGE_COOLDOWN_MS}`);
});

/* ══ restart safety and arming ════════════════════════════════════════════ */

test('★★ the force-charge record survives a restart, and garbage slots are dropped, not guessed', () => {
  const n = offNight({ forceChargeOffRetries: 1, forceChargeOffEscalated: true, forceChargeCeilingAttemptedAtMs: 5 });
  const back = coerceActuationState(JSON.parse(JSON.stringify(n)));
  assert.equal(back.forceChargeOnAtMs, n.forceChargeOnAtMs);
  assert.deepEqual(back.forceChargeSlots, [1, 2, 3]);
  assert.equal(back.forceChargeOffAtMs, WIN_END);
  assert.equal(back.forceChargeOffRetries, 1);
  assert.equal(back.forceChargeOffEscalated, true);
  assert.equal(back.forceChargeCeilingAttemptedAtMs, 5);
  assert.equal(forceChargeInFlight(back), true);
  const junk = coerceActuationState({ day: '2026-09-16', forceChargeOnAtMs: 1, forceChargeSlots: [0, 2, 9, 'x', 3.5] });
  assert.deepEqual(junk.forceChargeSlots, [2]);
  assert.equal(coerceActuationState({ day: '2026-09-16' }).forceChargeOnAtMs, null);
});

const ARM: ArmablePlan = {
  chargeTonight: true, basisComplete: true, buyKwh: 40, setpointSocPct: 50,
  window: { startMs: WIN_START + 24 * H, endMs: WIN_END + 24 * H },
};

test('★★★ arming refuses to bury a force-charge whose OFF never verified', () => {
  // armFromPlan returns a FRESH record. On a reverted night whose force-charge is
  // still unverified, that would erase the only record that knows to switch it off.
  const stuck = offNight({ revertedAtMs: WIN_END + 5 * 60_000 });
  assert.equal(armFromPlan(stuck, '2026-09-17', ARM, WIN_END + 16 * H, 16), null);
  const clean = { ...stuck, forceChargeOffVerifiedAtMs: WIN_END + 60_000 };
  assert.ok(armFromPlan(clean, '2026-09-17', ARM, WIN_END + 16 * H, 16), 'a verified OFF re-arms normally');
  assert.ok(armFromPlan(verifiedNight({ revertedAtMs: WIN_END + 5 * 60_000 }), '2026-09-17', ARM, WIN_END + 16 * H, 16),
    'a night that never force-charged is unaffected');
});

/* ══ settings drift — our own writes are not tampering ════════════════════ */

test('★★ settings-drift: our force-charge is own-write; an operator\'s is still reported', () => {
  const ch = { key: 'Smart Home Panel 2 · ch2ForceCharge', from: 'FORCE_CHARGE_OFF', to: 'FORCE_CHARGE_ON' } as never;
  const ceil = { key: 'Smart Home Panel 2 · foceChargeHight', from: 100, to: 90 } as never;
  const base = { targetPct: null, priorReservePct: null, nightActive: false };
  assert.equal(classifyChange(ch, { ...base, forceChargeActive: true }), 'own-write');
  assert.equal(classifyChange(ceil, { ...base, forceChargeActive: true }), 'own-write');
  assert.equal(classifyChange(ch, { ...base, forceChargeActive: false }), 'external',
    'an operator\'s Charge Now is exactly what the watchdog exists to report');
  assert.equal(classifyChange(ch, base), 'external');
  const reserve = { key: 'Smart Home Panel 2 · backupReserveSoc', from: 16, to: 50 } as never;
  assert.equal(classifyChange(reserve, { ...base, forceChargeActive: true }), 'external',
    'force-charge context never launders a reserve change');
});

/* ══ the announcement says what the panel will be told ════════════════════ */

const chargePlan = (over: Partial<NightChargePlan> = {}): NightChargePlan => ({
  generatedAt: Date.now(), basisComplete: true, objective: 'cost_arbitrage',
  chargeTonight: true, buyKwh: 34, targetSocPct: 43.5, requiredExtraKwh: 30,
  bindingCap: 'chargePower', cushionShortfall: false, minProjSocPct: 0,
  minProjSocTsMs: null, baselineMinSocPct: 0, projSocAtWindowStartPct: null,
  preWindowMinSocPct: null, confidenceTier: 'forecast',
  window: { startMs: Date.now() + 2 * H, endMs: Date.now() + 8 * H },
  reserveFloorPct: 10, cushionPct: 15, rationale: 'x', ...over,
} as NightChargePlan);

test('the 21:30 announcement names the force-charge and its TARGET, and drops the under-statement', () => {
  const m = buildNightChargeMessage(chargePlan(), 'charge', {
    cancelDeadlineText: 'at 10:55 PM', targetPct: 50, forceChargeTargetPct: 64.3,
  });
  assert.match(m.body, /near the end of the window, it switches the panel's force-charge ON just long enough to reach ~64\.3%/);
  assert.match(m.body, /OFF when it gets there/);
  assert.doesNotMatch(m.body, /only expected to reach/,
    'on a force-charge night the reserve is not where charging stops');

  const plain = buildNightChargeMessage(chargePlan(), 'charge', { cancelDeadlineText: 'at 10:55 PM', targetPct: 50 });
  assert.doesNotMatch(plain.body, /force-charge/, 'a reserve-only night reads exactly as before');
  assert.match(plain.body, /only expected to reach ~43.5%/);
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ════════ */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★★★ the force-charge step actually RUNS, after the reserve step, in its own try', () => {
  const tick = INDEX.indexOf('async function runNightActuationTick(): Promise<void> {');
  assert.ok(tick > 0);
  const body = INDEX.slice(tick, INDEX.indexOf('async function runForceChargeTick(', tick));
  const reserve = body.indexOf('await runNightActuationTickInner();');
  const force = body.indexOf('await runForceChargeTick();');
  assert.ok(reserve > 0 && force > 0, 'both steps are called');
  assert.ok(force > reserve, 'force-charge reads the state the reserve step just wrote');
  assert.ok(body.slice(reserve, force).includes('} catch'),
    'a reserve-step failure must not skip the force-charge OFF, nor the reverse');
});

test('★★★ WRITE-AHEAD: the ON intent is persisted before any ON write is issued', () => {
  const fn = INDEX.indexOf('async function runForceChargeTick(');
  assert.ok(fn > 0);
  const intent = INDEX.indexOf('forceChargeOnAtMs: nowMs, forceChargeSlots: action.slots', fn);
  const write = INDEX.indexOf("on: true, source: { ua: 'night-force-charge' }", fn);
  assert.ok(intent > fn && write > fn, 'both located');
  assert.ok(intent < write,
    'a lost confirmation must never orphan a force-charge — the OFF covers every slot attempted');
});

test('★★★ the OFF side OUTLIVES the master switch (NIGHT_CHARGE_ADVISOR_ENABLED=false)', () => {
  // Review finding: the actuation interval only exists inside `if (nightChargeEnabled)`,
  // and changing any option restarts the add-on — so flipping the most obvious switch
  // mid-night left force-charge ON with nothing left to switch it off.
  const gate = INDEX.indexOf('if (nightChargeEnabled) {');
  const safety = INDEX.indexOf('const forceChargeSafetyTick = setInterval(');
  assert.ok(gate > 0 && safety > 0);
  const gatedTick = INDEX.indexOf('const nightActuationTick = setInterval(', gate);
  assert.ok(safety > gatedTick, 'registered after (outside) the gated block');
  const body = INDEX.slice(safety, INDEX.indexOf('forceChargeSafetyTick.unref();', safety));
  assert.ok(body.includes('if (nightChargeEnabled) return;'), 'defers to the normal tick when it exists');
  assert.ok(body.includes('if (!forceChargeInFlight(nightActuationMem) || nightActuationInFlight) return;'),
    'inert unless a force-charge of ours is in flight, and never concurrent with the normal tick');
  assert.ok(body.includes('runForceChargeTick({ forceDisabled: true })'), 'and it can only ever switch OFF');
});

test('★★★ grid-connected is gridSta === 1 ONLY — islanded (2) switches force-charge off', () => {
  // Review finding: the first cut tested `gridSta === 0` and would have MISSED the
  // islanded state (2) — exactly the outage case it exists for.
  assert.ok(INDEX.includes("gridStaLost: sp != null && typeof sp.gridSta === 'number' && sp.gridSta !== 1,"));
  assert.ok(!INDEX.includes('gridStaLost: sp?.gridSta === 0'));
});

test('★★ only an OFF the cloud ACCEPTED spends the readback budget', () => {
  const fn = INDEX.indexOf('async function runForceChargeTick(');
  const body = INDEX.slice(fn, INDEX.indexOf('const forceChargeSafetyTick', fn));
  assert.ok(body.includes('if (isRetry && acked > 0) {'),
    'a rejected or rate-limited OFF never reached the panel and must not count as the panel ignoring us');
});

test('★★ the escalation is audible, and its text no longer promises retries that do not happen', () => {
  const fn = INDEX.indexOf('async function runForceChargeTick(');
  const body = INDEX.slice(fn, INDEX.indexOf('const forceChargeSafetyTick', fn));
  const fail = body.indexOf('forceChargeOffEscalated: true');
  assert.ok(fail > 0);
  assert.ok(body.indexOf("broadcast.announce(\n      'critical',", fail) > fail
    || body.indexOf("broadcast.announce(", fail) > fail, 'spoken critical, like a stuck reserve');
  assert.ok(body.includes('keeps sending OFF every 15 minutes'), 'the push states what actually happens');
});

/* ══ v1.166.0 — "chose not to" must never read like "broke" ═══════════════ */

test('★★★ every declined START says WHY — a reserve-only night is a decision, not a fault', () => {
  const why = (n: NightActuationState, o = opts()) => (decideForceCharge(n, MID, o) as { why?: string }).why ?? '';
  assert.match(why(verifiedNight({ forceChargeCeilingPct: 48 })), /48% target is at or below the 50% reserve — the reserve alone reaches it/);
  assert.match(why(verifiedNight({ forceChargeCeilingPct: null })), /no economic ceiling was announced/);
  assert.match(why(verifiedNight(), opts({ enabled: false })), /^disabled/);
  assert.match(why(verifiedNight(), opts({ slotsOn: [2] })), /Charge Now is already ON for slot\(s\) 2 — that is the operator's/);
  assert.match(why(verifiedNight(), opts({ gridPresent: null })), /grid presence is unknown/);
  assert.match(why(verifiedNight(), opts({ gridStaLost: true })), /gridSta ≠ 1/);
  assert.match(why(verifiedNight({ applyVerifiedAtMs: null })), /waiting for the reserve write to be verified/);
  assert.match(why(verifiedNight(), opts({ ceilingReadbackPct: null })), /no live readback of the panel's force-charge ceiling/);
});

test('★★ the "why not" line fires only while a night is LIVE, once per reason', () => {
  const fn = INDEX.indexOf('async function runForceChargeTick(');
  const body = INDEX.slice(fn, INDEX.indexOf("if (action.kind === 'syncCeiling')", fn));
  assert.ok(body.includes('const live = state.appliedAtMs != null && state.revertedAtMs == null && !state.cancelled'),
    'never logged during the day, or after the night is reverted — only while a decision is being made');
  assert.ok(body.includes('if (!forceChargeWhyLogged.reasons.has(action.why)) {'), 'one line per distinct reason');
  assert.ok(body.includes('force-charge NOT starting for'));
});

test('★★ the 21:30 ARMED line states tonight\'s force-charge decision up front', () => {
  assert.ok(INDEX.includes('cancellable until the write moment. ${forceChargeArmNote(armedCandidate)}'));
  const note = INDEX.slice(INDEX.indexOf('function forceChargeArmNote('), INDEX.indexOf('async function runForceChargeTick('));
  assert.ok(note.includes('which reaches it alone') && note.includes('ELIGIBLE — just in time'), 'both outcomes are named');
});
