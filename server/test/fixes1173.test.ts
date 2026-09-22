import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideForceCharge, planChargeCapKw, evDisplacedPackKwh, LEGACY_CHARGE_CAP_KW,
  FORCE_CHARGE_PROVEN_KW_PER_SLOT, FORCE_CHARGE_BLIND_RESEND_MAX_MS, FORCE_CHARGE_DEADLINE_REPAGE_MS,
  FORCE_CHARGE_DEADLINE_REPAGE_MAX, FORCE_CHARGE_OFF_PERSIST_EVERY_MS, type ForceChargeOpts,
} from '../src/nightForceCharge.js';
import { emptyActuationState, coerceActuationState, type NightActuationState } from '../src/nightChargeActuator.js';
import { pollLogLines } from '../src/snapshot.js';

/** v1.173.0 — items 4, 5, 6, 8a, 8b, 8d and 12 of the 2026-09-21 open list. */

const H = 3_600_000;
const M = 60_000;
const LEG = Math.sqrt(0.86);
const WIN_START = Date.UTC(2026, 8, 19, 6, 0);
const WIN_END = WIN_START + H;
const here = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(here, '../src/index.ts'), 'utf8');

const offNight = (over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(), day: '2026-09-18', targetPct: 50, windowStartMs: WIN_START, windowEndMs: WIN_END,
  appliedAtMs: WIN_START - 5 * M, applyVerifiedAtMs: WIN_START + M, priorReservePct: 16,
  forceChargeOnAtMs: WIN_START + 2 * M, forceChargeSlots: [1, 2, 3], forceChargeCeilingPct: 90,
  forceChargeOffAtMs: WIN_END, forceChargeOffLastAttemptMs: WIN_END, forceChargeOffReason: 'windowEnd',
  ...over,
});
const opts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false, slotsOn: [1], connectedSlots: [1, 2, 3],
  vitalsRed: false, socCoherent: true, ceilingReadbackPct: 90, poolSocPct: 60, fullKwh: 92, ...over,
});

/* ══ 12. the planner's charge cap follows the connected Cores ════════════ */

test('★★★ ARB_CHARGE_CAP_KW 0 = AUTO: connected Cores × the proven per-Core rate, grid-side', () => {
  assert.ok(Math.abs(planChargeCapKw(0, 3, LEG) - (3 * FORCE_CHARGE_PROVEN_KW_PER_SLOT) / LEG) < 1e-9);
  assert.ok(Math.abs(planChargeCapKw(0, 3, LEG) - 17.79) < 0.01, '~17.8 kW for three Cores — the envelope minus load binds first');
  assert.ok(Math.abs(planChargeCapKw(0, 1, LEG) - 5.93) < 0.01, 'one Core out of three ⇒ a third');
  assert.equal(planChargeCapKw(0, 5, LEG), planChargeCapKw(0, 3, LEG), 'the panel has three battery slots');
  assert.equal(planChargeCapKw(0, null, LEG), LEGACY_CHARGE_CAP_KW, 'unknown ⇒ the legacy 7.2 (under-stating is the honest-shortfall side)');
  assert.equal(planChargeCapKw(0, 0, LEG), LEGACY_CHARGE_CAP_KW);
  assert.equal(planChargeCapKw(16, 3, LEG), 16, 'an owner value > 0 is an override');
});

test('★★ the planner uses it, from the panel\'s connected slots', () => {
  assert.ok(INDEX.includes("const chargeCapKw = planChargeCapKw(Number(process.env.ARB_CHARGE_CAP_KW ?? 0), planConnectedSlots, legEff);"));
  assert.ok(INDEX.includes('c?.hwConnect === true'));
  const cfg = readFileSync(resolve(here, '../../ecoflow_panel/config.yaml'), 'utf8');
  assert.match(cfg, /^\s+ARB_CHARGE_CAP_KW: 0$/m, 'the shipped default is AUTO');
});

/* ══ 8d. the EV allowance with a Core out ═════════════════════════════════ */

test('★★★ with a Core out the EV first eats the slack under the cap — only the rest displaces pack charge', () => {
  // The v1.170.0 review case: one Core (bound 5.5), house 2.5 kW, cap 17 ⇒ unbounded 13.4,
  // slack ~7.95; an EV predicted at 11.5 kW / 20 kWh. Old: 20 × 0.927 = 18.5 kWh.
  const unb = (17 - 2.5) * LEG;
  const d = evDisplacedPackKwh({ evKwh: 20, peakEvKw: 11.5, rateKw: 5.5, unboundedRateKw: unb, legEff: LEG })!;
  const expect = 20 * Math.max(0, LEG - (unb - 5.5) / 11.5);
  assert.ok(Math.abs(d - expect) < 1e-9);
  assert.ok(d > 4 && d < 5.5, `~4.7 kWh, not 18.5 (got ${d})`);
  // All Cores in (no slack) ⇒ exactly v1.169.0.
  assert.equal(evDisplacedPackKwh({ evKwh: 20, peakEvKw: 11.5, rateKw: 13.4, unboundedRateKw: 13.4, legEff: LEG }), 20 * LEG);
  assert.equal(evDisplacedPackKwh({ evKwh: 20, peakEvKw: null, rateKw: 5.5, unboundedRateKw: unb, legEff: LEG }), 20 * LEG,
    'unknown EV power ⇒ the full count (early, the safe side)');
  assert.equal(evDisplacedPackKwh({ evKwh: null, peakEvKw: 11.5, rateKw: 5.5, unboundedRateKw: unb, legEff: LEG }), null);
  assert.equal(evDisplacedPackKwh({ evKwh: 20, peakEvKw: 2, rateKw: 5.5, unboundedRateKw: unb, legEff: LEG }), 0,
    'a small EV fits entirely in the slack');
});

/* ══ 5. blind re-sends end ════════════════════════════════════════════════ */

test('★★★ blind OFF re-sends stop 12 h after the first OFF (an owner\'s own Charge Now is not switched off)', () => {
  assert.equal(FORCE_CHARGE_BLIND_RESEND_MAX_MS, 12 * H);
  const esc = offNight({ forceChargeOffEscalated: true, forceChargeOffDeadlinePagedAtMs: WIN_END + H, forceChargeOffLastAttemptMs: WIN_END + 11 * H });
  assert.deepEqual(decideForceCharge(esc, WIN_END + 11 * H + FORCE_CHARGE_OFF_PERSIST_EVERY_MS, opts({ slotsOn: null })),
    { kind: 'offRetry', slots: [1, 2, 3], unconfirmed: true }, 'inside 12 h: still re-sending');
  const late = { ...esc, forceChargeOffLastAttemptMs: WIN_END + 12 * H - FORCE_CHARGE_OFF_PERSIST_EVERY_MS };
  assert.equal(decideForceCharge(late, WIN_END + 12 * H, opts({ slotsOn: null })).kind, 'none', 'past 12 h: blind re-sends stop');
  assert.equal(decideForceCharge(late, WIN_END + 12 * H, opts({ slotsOn: [2] })).kind, 'offRetry', 'a LIVE readback still re-sends');
});

/* ══ 4. a deadline muted by quiet hours is re-spoken ══════════════════════ */

test('★★★ a deadline page silenced by quiet hours is re-spoken every 30 min until heard (bounded)', () => {
  const muted = offNight({
    forceChargeOffEscalated: true, forceChargeOffDeadlinePagedAtMs: WIN_END + H, forceChargeOffDeadlineMutedAtMs: WIN_END + H,
  });
  assert.equal(decideForceCharge(muted, WIN_END + H + FORCE_CHARGE_DEADLINE_REPAGE_MS - 1, opts()).kind === 'offFailed', false);
  assert.deepEqual(decideForceCharge(muted, WIN_END + H + FORCE_CHARGE_DEADLINE_REPAGE_MS, opts()),
    { kind: 'offFailed', slots: [1], deadline: true, unconfirmed: false, repage: true });
  assert.notEqual(decideForceCharge({ ...muted, forceChargeOffDeadlineMutedAtMs: null }, WIN_END + 3 * H, opts()).kind, 'offFailed',
    'heard ⇒ no re-page');
  assert.notEqual(decideForceCharge({ ...muted, forceChargeOffDeadlineRepages: FORCE_CHARGE_DEADLINE_REPAGE_MAX }, WIN_END + 3 * H, opts()).kind,
    'offFailed', 'bounded');
  assert.equal(decideForceCharge(muted, WIN_END + 3 * H, opts({ slotsOn: [] })).kind, 'offVerified', 'reading OFF resolves instead');
});

test('the mute state survives a restart and resets for a new night', () => {
  const back = coerceActuationState(JSON.parse(JSON.stringify(offNight({ forceChargeOffDeadlineMutedAtMs: 123, forceChargeOffDeadlineRepages: 2 }))));
  assert.equal(back.forceChargeOffDeadlineMutedAtMs, 123);
  assert.equal(back.forceChargeOffDeadlineRepages, 2);
  assert.equal(emptyActuationState().forceChargeOffDeadlineMutedAtMs, null);
  assert.equal(emptyActuationState().forceChargeOffDeadlineRepages, 0);
});

test('★★ the escalation records whether the deadline page was HEARD, and a re-page pushes nothing', () => {
  const fn = INDEX.indexOf('async function escalateForceChargeStuck(');
  const body = INDEX.slice(fn, INDEX.indexOf('async function runNightActuationTickInner(', fn));
  assert.ok(body.includes('forceChargeOffDeadlineMutedAtMs: heard && heard.ok === false ? Date.now() : null,'));
  assert.ok(body.includes('if (repage) return; // the push already went with the first page'));
  assert.ok(body.indexOf('if (repage) return;') < body.indexOf('await sendNotification('));
});

/* ══ 6 + 8b ═══════════════════════════════════════════════════════════════ */

test('★★ the ceiling RESTORE is our own write (no false "Setting changed" push)', () => {
  assert.ok(INDEX.includes('(act.forceChargeCeilingRestoreLastAttemptMs != null && nowMs - act.forceChargeCeilingRestoreLastAttemptMs < 15 * 60_000)'));
});

test('the escalation words match the re-send behaviour', () => {
  assert.ok(!INDEX.includes('while a readback shows it on'), 'blind re-sends happen too');
  assert.ok(INDEX.includes('until it reads off (blind, with no readback, for up to 12 h)'));
});

/* ══ 8a. the poll-slow line names the failure set honestly ════════════════ */

test('★★ poll slow only blames the standing accessory set when that IS the failure set', () => {
  const line = (failed: number, standing: number) =>
    pollLogLines({ tookMs: 9000, failedCount: failed, standingFailedCount: standing, lastPollFailed: false, slowMs: 5000, pollDebug: false })
      .find((l) => l.startsWith('poll slow'));
  assert.match(line(4, 4)!, /the standing accessory set/);
  assert.match(line(9, 4)!, /5 OUTSIDE the standing 1006 accessory set/, '2026-09-20 09:06: five Cores failed with the accessories');
  assert.match(line(5, 0)!, /5 OUTSIDE/);
});
