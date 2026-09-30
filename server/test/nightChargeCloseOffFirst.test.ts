/**
 * v1.187.0 (review) — at the window close the force-charge OFF goes out FIRST.
 *
 * With REVERT_LAG_MS at 0 the reserve restore and force-charge's window-end OFF fall due on
 * the same tick. The tick ran the reserve step first and awaited it — the revert PUT (writes
 * carry no timeout of their own; undici's 300 s default applies) and then the morning-summary
 * push — before force-charge issued its OFF, while the Cores kept grid-charging at 16-19 kW
 * at the off-peak rate. Before v1.187.0 the restore was not due until +5 min, so the OFF went
 * out alone. Now `actuationStepOrder` runs force-charge first whenever its OFF is due on the
 * night's own record (closed, cancelled, reverted); the START still rides the verified reserve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  armFromPlan, decideActuation, emptyActuationState,
  type ArmablePlan, type ActuationTickOpts, type NightActuationState,
} from '../src/nightChargeActuator.js';
import {
  decideForceCharge, forceChargeOffDueNow, actuationStepOrder, runActuationSteps,
  type ActuationStep, type ForceChargeOpts,
} from '../src/nightForceCharge.js';

const MIN = 60_000;
const HOUR = 3_600_000;
/** A Friday one-hour window, Fri 23:00 → Sat 00:00 MST (the pack needs all of it). */
const WIN = { startMs: Date.UTC(2026, 9, 3, 6), endMs: Date.UTC(2026, 9, 3, 7) };

const plan: ArmablePlan = {
  chargeTonight: true, basisComplete: true, buyKwh: 40, setpointSocPct: 95, costCeilingSocPct: 90, window: WIN,
};
const armed = (): NightActuationState => {
  const s = armFromPlan(emptyActuationState(), '2026-10-02', plan, WIN.startMs - 90 * MIN, 16);
  assert.ok(s);
  return s!;
};
/** Reserve applied and verified at the open, force-charge ON from 23:05, not yet OFF. */
const charging = (o: Partial<NightActuationState> = {}): NightActuationState => ({
  ...armed(),
  appliedAtMs: WIN.startMs + 28_000, applyVerifiedAtMs: WIN.startMs + 88_000, priorReservePct: 16,
  forceChargeOnAtMs: WIN.startMs + 5 * MIN, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: WIN.startMs + 11 * MIN,
  ...o,
});
const tick = (o: Partial<ActuationTickOpts> = {}): ActuationTickOpts => ({
  mode: 'supervised', writeReady: false, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true, ...o,
});
const fc: ForceChargeOpts = {
  enabled: true, gridPresent: true, gridStaLost: false, ceilingReadbackPct: 90, slotsOn: [1, 2, 3],
  connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true, poolSocPct: 70, fullKwh: 92,
};

test('★★★ THE CASE: at the close both writes are due, and the force-charge OFF is ordered first', () => {
  const s = charging();
  const close = WIN.endMs + 28_000; // the first 60-s tick after 00:00
  assert.equal(decideActuation(s, close, tick()).kind, 'revert', 'the restore is due on this tick');
  assert.deepEqual(decideForceCharge(s, close, fc), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
  assert.equal(forceChargeOffDueNow(s, close), true);
  assert.deepEqual(actuationStepOrder(s, close), ['forceCharge', 'reserve']);
  assert.deepEqual(actuationStepOrder(s, WIN.endMs), ['forceCharge', 'reserve'], 'from the close itself');
});

test('★★ the OFF also goes first on a cancel or once the reserve is reverted', () => {
  const mid = WIN.startMs + 30 * MIN;
  assert.deepEqual(actuationStepOrder(charging({ cancelled: true }), mid), ['forceCharge', 'reserve']);
  assert.deepEqual(actuationStepOrder(charging({ revertedAtMs: mid - MIN }), mid), ['forceCharge', 'reserve']);
  assert.deepEqual(actuationStepOrder(charging({ windowEndMs: null }), mid), ['forceCharge', 'reserve'], 'no window stops at once');
});

test('★★★ otherwise the reserve step runs first — the START rides the reserve it just verified', () => {
  const s = armed();
  assert.deepEqual(actuationStepOrder(s, WIN.startMs - MIN), ['reserve', 'forceCharge'], 'before the open');
  assert.deepEqual(actuationStepOrder(s, WIN.startMs), ['reserve', 'forceCharge'], 'the apply tick');
  assert.deepEqual(actuationStepOrder(charging(), WIN.endMs - 1), ['reserve', 'forceCharge'], 'ON, inside the window');
  // The OFF already issued: verification and the ceiling restore follow the reserve step.
  const off = charging({ forceChargeOffAtMs: WIN.endMs + 28_000 });
  assert.equal(forceChargeOffDueNow(off, WIN.endMs + 2 * MIN), false);
  assert.deepEqual(actuationStepOrder(off, WIN.endMs + 2 * MIN), ['reserve', 'forceCharge']);
  // No force-charge tonight at all.
  const reserveOnly = { ...charging(), forceChargeOnAtMs: null };
  assert.equal(forceChargeOffDueNow(reserveOnly, WIN.endMs + HOUR), false);
  assert.deepEqual(actuationStepOrder(reserveOnly, WIN.endMs), ['reserve', 'forceCharge']);
});

test('★★★ a hung revert no longer holds the OFF: the OFF completes before the revert starts', async () => {
  const s = charging();
  const close = WIN.endMs + 28_000;
  const log: string[] = [];
  let releaseRevert!: () => void;
  const revertHangs = new Promise<void>((r) => { releaseRevert = r; });
  const run = runActuationSteps(actuationStepOrder(s, close), {
    reserve: async () => { log.push('revert:start'); await revertHangs; log.push('revert:done'); },
    forceCharge: async () => { log.push('off:start'); await Promise.resolve(); log.push('off:done'); },
  }, () => assert.fail('no step throws here'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['off:start', 'off:done', 'revert:start'], 'the OFF is out while the revert PUT is still pending');
  releaseRevert();
  await run;
  assert.deepEqual(log, ['off:start', 'off:done', 'revert:start', 'revert:done']);
});

test('★★★ each step in its own try, in EITHER order: one throwing never skips the other', async () => {
  for (const order of [['reserve', 'forceCharge'], ['forceCharge', 'reserve']] as ActuationStep[][]) {
    for (const thrower of order) {
      const ran: ActuationStep[] = [];
      const errors: ActuationStep[] = [];
      await runActuationSteps(order, {
        reserve: async () => { ran.push('reserve'); if (thrower === 'reserve') throw new Error('PUT failed'); },
        forceCharge: async () => { ran.push('forceCharge'); if (thrower === 'forceCharge') throw new Error('PUT failed'); },
      }, (step) => errors.push(step));
      assert.deepEqual(ran, order, `order ${order.join('→')}, ${thrower} throws: both ran`);
      assert.deepEqual(errors, [thrower], 'the failure is reported with its step');
    }
  }
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');

test('★★ the morning summary after a revert is not awaited, and the restore time is stamped for the ledger', () => {
  const fn = INDEX.indexOf('async function runNightActuationTickInner(');
  assert.ok(fn > 0);
  const i = INDEX.indexOf("persistNightActuation({ ...state, revertedAtMs: nowMs, lastError: null });", fn);
  assert.ok(i > fn);
  const branch = INDEX.slice(i, INDEX.indexOf('\n    return;\n  }', i));
  assert.ok(branch.includes('recorder.recordNightOutcome(state.day, { actuation_reverted_at_ms: nowMs });'));
  assert.ok(branch.includes('void sendNotification(loadNotifyConfig(), {'), 'the info push is fire-and-forget');
  assert.ok(!branch.includes('await sendNotification('), 'nothing in the revert branch waits on a push');
});
