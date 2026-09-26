import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideForceCharge, forceChargeOnReadbackStatus, forceChargeOffDeadlineMs,
  FORCE_CHARGE_ON_VERIFY_AFTER_MS, FORCE_CHARGE_ON_MAX_RETRIES, type ForceChargeOpts,
} from '../src/nightForceCharge.js';
import {
  emptyActuationState, coerceActuationState, type NightActuationState,
} from '../src/nightChargeActuator.js';
import { FORCE_CHARGE_COOLDOWN_MS } from '../src/ecoflow/commands.js';

/**
 * v1.186.0 — the force-charge ON is verified by device readback.
 *
 * Before this, only the reserve, the OFF and the ceiling restore were: the ON branch logged
 * "ch1 ok, ch2 ok, ch3 ok" (the cloud accepted the writes) and nothing ever looked again. An
 * ON the cloud rejected, or accepted while the panel ignored it (the 2026-08-16 phantom-write
 * class seen on backupReserveSoc), bought nothing above the 50% reserve; the software stop
 * never fired; 05:00 logged "FORCE-CHARGE OFF (windowEnd)" then "OFF VERIFIED" — a
 * clean-looking night, visible only as a low delivered_kwh the next evening.
 *
 * The check is ONE shot shortly after the ON: the panel switches each slot off by itself as
 * its Core reaches the ceiling (2026-09-23: ch1 at 04:19, ch3 at 04:30, before the software
 * stop at 04:35), so a slot reading OFF later in the run is not a failure.
 */

const H = 3_600_000;
const MIN = 60_000;
const WIN_START = Date.UTC(2026, 8, 24, 6, 0);   // 23:00 MST
const WIN_END = WIN_START + 6 * H;               // 05:00 MST
const ON_AT = WIN_END - 100 * MIN;               // a just-in-time start, ~03:20

/** A night whose reserve write was verified and whose force-charge was switched ON at
 *  ON_AT — and whose ON no readback has proven yet. */
const onNight = (over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(),
  day: '2026-09-23', targetPct: 50, buyKwh: 40,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * MIN, attemptBaselinePct: 16,
  appliedAtMs: WIN_START - 5 * MIN, priorReservePct: 16, applyVerifiedAtMs: WIN_START + MIN,
  forceChargeCeilingPct: 90, forceChargeCeilingAttemptedAtMs: WIN_START + MIN, forceChargeCeilingPriorPct: 100,
  forceChargeOnAtMs: ON_AT, forceChargeSlots: [1, 2, 3],
  ...over,
});

/** A live readback mid-charge: the pool well short of the 90% target (no software stop),
 *  every Core well below the panel's 90% ceiling. */
const opts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 90, poolSocPct: 62, fullKwh: 92,
  slotSocPct: { 1: 62, 2: 61, 3: 63 },
  ...over,
});
const DUE = ON_AT + FORCE_CHARGE_ON_VERIFY_AFTER_MS;

/* ══ verified ═════════════════════════════════════════════════════════════ */

test('★★ every slot we switched ON reads FORCE_CHARGE_ON on a live readback ⇒ verified — no grace needed', () => {
  // 2026-09-23: the drift watch saw OFF→ON on all three ~3 min after the 03:18 ON.
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 3 * MIN, opts()), { kind: 'onVerified', atCeiling: [] },
    'a reading taken after the write that shows ON is proof — success does not wait out the grace');
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts()), { kind: 'onVerified', atCeiling: [] });
  assert.deepEqual(decideForceCharge(onNight({ forceChargeSlots: [1, 3] }), DUE, opts({ slotsOn: [1, 3] })),
    { kind: 'onVerified', atCeiling: [] }, 'only the slots we wrote are required');
});

test('★★★ ONE shot: once verified, a slot that reads OFF later in the run is never a failure', () => {
  // The panel switched ch1 off at its ceiling at 04:19 — a Core that then eases a point
  // below the ceiling must not turn that into "did not take effect".
  const verified = onNight({ forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN });
  for (const slotsOn of [[2, 3], [], [3]]) {
    assert.deepEqual(decideForceCharge(verified, ON_AT + 60 * MIN, opts({ slotsOn, slotSocPct: { 1: 88, 2: 70, 3: 71 } })),
      { kind: 'none' });
  }
});

/* ══ the grace, and a stale readback ══════════════════════════════════════ */

test('★★ inside the grace a slot still reading OFF is waited for, not re-issued', () => {
  assert.deepEqual(decideForceCharge(onNight(), ON_AT + 2 * MIN, opts({ slotsOn: [1, 3] })), { kind: 'none' });
  assert.deepEqual(decideForceCharge(onNight(), DUE - 1, opts({ slotsOn: [] })), { kind: 'none' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3] })), { kind: 'onRetry', slots: [2] },
    'past it, the straggler alone is re-issued');
});

test('★★★ the grace outlasts the per-slot write cooldown, so the one re-issue is not rate-limited', () => {
  // The ON and its re-issue go through the same `charge-now-ch{n}` cooldown.
  assert.ok(FORCE_CHARGE_ON_VERIFY_AFTER_MS > FORCE_CHARGE_COOLDOWN_MS,
    `${FORCE_CHARGE_ON_VERIFY_AFTER_MS} must exceed ${FORCE_CHARGE_COOLDOWN_MS}`);
  assert.equal(FORCE_CHARGE_ON_MAX_RETRIES, 1, 're-issued ONCE, then the warning');
});

test('★★★ a STALE readback decides nothing — not verified, not re-issued, not failed', () => {
  // index.ts nulls slotsOn unless shp2ReadbackFresh. Absence is not evidence either way.
  for (const t of [DUE, DUE + 30 * MIN, WIN_END - 1]) {
    assert.deepEqual(decideForceCharge(onNight(), t, opts({ slotsOn: null, slotSocPct: null })), { kind: 'none' });
    assert.deepEqual(decideForceCharge(onNight({ forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE }), t,
      opts({ slotsOn: null, slotSocPct: null })), { kind: 'none' });
  }
});

/* ══ re-issue once, then warn ═════════════════════════════════════════════ */

test('★★★ re-issued ONCE; still OFF a grace after the re-issue ⇒ onFailed, for the slots still OFF', () => {
  const retried = onNight({ forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE });
  assert.deepEqual(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS - 1, opts({ slotsOn: [1, 3] })),
    { kind: 'none' }, 'the re-issue gets its own grace, measured from the re-issue');
  assert.deepEqual(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, opts({ slotsOn: [1, 3] })),
    { kind: 'onFailed', slots: [2] });
  assert.deepEqual(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, opts({ slotsOn: [] })),
    { kind: 'onFailed', slots: [1, 2, 3] }, 'nothing applied: the whole buy above the reserve is forfeited');
  assert.deepEqual(decideForceCharge(retried, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, opts({ slotsOn: [1, 2, 3] })),
    { kind: 'onVerified', atCeiling: [] }, 'the re-issue took');
});

test('★★ a legacy record (no last-attempt stamp) measures the grace from the ON itself', () => {
  assert.equal(decideForceCharge(onNight({ forceChargeOnLastAttemptMs: null }), DUE, opts({ slotsOn: [] })).kind, 'onRetry');
});

test('★★ the warning goes ONCE — and a late apply still resolves the record', () => {
  const failed = onNight({ forceChargeOnRetries: 1, forceChargeOnLastAttemptMs: DUE, forceChargeOnFailedAtMs: DUE + 6 * MIN });
  assert.deepEqual(decideForceCharge(failed, DUE + 30 * MIN, opts({ slotsOn: [1, 3] })), { kind: 'none' },
    'no second warning, no third write');
  assert.deepEqual(decideForceCharge(failed, DUE + 30 * MIN, opts({ slotsOn: [1, 2, 3] })), { kind: 'onVerified', atCeiling: [] },
    'fixed from the app, or the panel was merely slow: the record says so');
});

test('★★★ the re-issue is a NEW grid-charge write — the start\'s grid and vitals gates apply, and it waits', () => {
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], gridPresent: null })), { kind: 'none' },
    'an unknown grid never starts a grid charge');
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], vitalsRed: true })), { kind: 'none' },
    'no new device writes from a struggling process');
  assert.deepEqual(decideForceCharge(onNight(), DUE + 10 * MIN, opts({ slotsOn: [1, 3] })), { kind: 'onRetry', slots: [2] },
    'waiting is not failing: once the gates clear, the re-issue goes');
});

/* ══ the at-the-ceiling exemption ═════════════════════════════════════════ */

test('★★★ a slot whose Core already sits at the panel\'s ceiling is exempt — the panel switches it off itself', () => {
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], slotSocPct: { 1: 70, 2: 90, 3: 71 } })),
    { kind: 'onVerified', atCeiling: [2] }, 'Core 2 at the synced 90% ceiling');
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], slotSocPct: { 1: 70, 2: 89, 3: 71 } })),
    { kind: 'onRetry', slots: [2] }, 'one point below: the panel would still be charging it');
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], slotSocPct: { 1: 70, 3: 71 } })),
    { kind: 'onRetry', slots: [2] }, 'an unknown Core SoC is never an exemption');
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], slotSocPct: null })),
    { kind: 'onRetry', slots: [2] });
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], slotSocPct: { 2: Number.NaN } })),
    { kind: 'onRetry', slots: [2] });
  assert.deepEqual(
    decideForceCharge(onNight({ forceChargeCeilingPct: 64.3 }), DUE, opts({ slotsOn: [1, 3], ceilingReadbackPct: 80, poolSocPct: 55, slotSocPct: { 2: 80 } })),
    { kind: 'onVerified', atCeiling: [2] }, 'below 80 the synced ceiling is the panel\'s 80 minimum');
});

test('★★ a ceiling LOWERED in the app mid-night stops a Core sooner — the lower live readback counts', () => {
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], ceilingReadbackPct: 80, slotSocPct: { 2: 85 } })),
    { kind: 'onVerified', atCeiling: [2] });
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], ceilingReadbackPct: null, slotSocPct: { 2: 90 } })),
    { kind: 'onVerified', atCeiling: [2] }, 'no live ceiling reading: the synced ceiling');
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [1, 3], ceilingReadbackPct: 100, slotSocPct: { 2: 85 } })),
    { kind: 'onRetry', slots: [2] }, 'a HIGHER live reading never widens the exemption past tonight\'s ceiling');
});

/* ══ it never delays or blocks the OFF ════════════════════════════════════ */

test('★★★ the OFF comes FIRST — window end, target, grid loss and disable are never delayed by the ON verify', () => {
  const o = opts({ slotsOn: [] }); // nothing applied, past the grace: a re-issue would be due
  assert.deepEqual(decideForceCharge(onNight(), WIN_END, o), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [], poolSocPct: 90 })),
    { kind: 'off', slots: [1, 2, 3], reason: 'target' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [], gridPresent: false })),
    { kind: 'off', slots: [1, 2, 3], reason: 'gridLoss' });
  assert.deepEqual(decideForceCharge(onNight(), DUE, opts({ slotsOn: [], enabled: false })),
    { kind: 'off', slots: [1, 2, 3], reason: 'disabled' }, 'the master-switch safety tick only ever switches OFF');
  assert.deepEqual(decideForceCharge(onNight({ cancelled: true }), DUE, o), { kind: 'off', slots: [1, 2, 3], reason: 'cancelled' });
  // A failed ON still ends the normal way.
  const failed = onNight({ forceChargeOnRetries: 1, forceChargeOnFailedAtMs: DUE + 6 * MIN });
  assert.deepEqual(decideForceCharge(failed, WIN_END, o), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
});

test('★★★ once the OFF is sent the ON verify is over — slots reading OFF VERIFY the OFF, never "ON failed"', () => {
  const off = onNight({ forceChargeOffAtMs: WIN_END, forceChargeOffLastAttemptMs: WIN_END, forceChargeOffReason: 'windowEnd' });
  assert.deepEqual(decideForceCharge(off, WIN_END + MIN, opts({ slotsOn: [] })), { kind: 'offVerified' });
  assert.deepEqual(decideForceCharge(off, WIN_END + MIN, opts({ slotsOn: null })), { kind: 'none' });
});

test('★★ the wall-clock deadline is untouched by an unverified ON', () => {
  const off = onNight({ forceChargeOffAtMs: WIN_END, forceChargeOffLastAttemptMs: WIN_END });
  assert.equal(forceChargeOffDeadlineMs(off), WIN_END + H);
  const late = decideForceCharge(off, WIN_END + H, opts({ slotsOn: null }));
  assert.equal(late.kind, 'offFailed', 'past the deadline with nothing verified OFF: still pages');
});

/* ══ a restart resumes, and the status says it ════════════════════════════ */

test('★★★ the ON-verify record survives a restart — no second re-issue, no second warning', () => {
  const n = onNight({
    forceChargeOnVerifiedAtMs: null, forceChargeOnRetries: 1,
    forceChargeOnLastAttemptMs: DUE, forceChargeOnFailedAtMs: DUE + 6 * MIN,
  });
  const back = coerceActuationState(JSON.parse(JSON.stringify(n)));
  assert.equal(back.forceChargeOnRetries, 1);
  assert.equal(back.forceChargeOnLastAttemptMs, DUE);
  assert.equal(back.forceChargeOnFailedAtMs, DUE + 6 * MIN);
  assert.equal(back.forceChargeOnVerifiedAtMs, null);
  assert.deepEqual(decideForceCharge(back, DUE + 30 * MIN, opts({ slotsOn: [1, 3] })), { kind: 'none' },
    'the restarted process neither re-issues nor warns again');
  const verified = coerceActuationState(JSON.parse(JSON.stringify(onNight({ forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN }))));
  assert.equal(verified.forceChargeOnVerifiedAtMs, ON_AT + 3 * MIN);
  // A record written before v1.186.0 has none of the fields: it starts unverified, 0 retries.
  const legacy = coerceActuationState({ day: '2026-09-23', forceChargeOnAtMs: ON_AT, forceChargeSlots: [1, 2, 3] });
  assert.equal(legacy.forceChargeOnVerifiedAtMs, null);
  assert.equal(legacy.forceChargeOnRetries, 0);
  assert.equal(legacy.forceChargeOnLastAttemptMs, null);
  assert.equal(legacy.forceChargeOnFailedAtMs, null);
  const junk = coerceActuationState({ day: '2026-09-23', forceChargeOnRetries: 'x', forceChargeOnFailedAtMs: 'soon' });
  assert.equal(junk.forceChargeOnRetries, 0);
  assert.equal(junk.forceChargeOnFailedAtMs, null);
});

test('the status verdict served beside forceChargeOnAtMs', () => {
  assert.equal(forceChargeOnReadbackStatus(emptyActuationState()), null, 'no force-charge tonight');
  assert.equal(forceChargeOnReadbackStatus(onNight()), 'unverified');
  assert.equal(forceChargeOnReadbackStatus(onNight({ forceChargeOnFailedAtMs: DUE })), 'failed');
  assert.equal(forceChargeOnReadbackStatus(onNight({ forceChargeOnVerifiedAtMs: DUE })), 'verified');
  assert.equal(forceChargeOnReadbackStatus(onNight({ forceChargeOnFailedAtMs: DUE, forceChargeOnVerifiedAtMs: DUE + MIN })),
    'verified', 'a late apply wins');
});

test('★★ an ON stamped with no readable slot list must see ALL three read ON', () => {
  // The same fallback the OFF uses: an empty list must never verify as "all ours ON".
  for (const slots of [null, [] as number[]]) {
    assert.equal(decideForceCharge(onNight({ forceChargeSlots: slots }), DUE, opts({ slotsOn: [1, 3] })).kind, 'onRetry');
    assert.equal(decideForceCharge(onNight({ forceChargeSlots: slots }), DUE, opts({ slotsOn: [1, 2, 3] })).kind, 'onVerified');
  }
});

/* ══ the integrator (index.ts) ════════════════════════════════════════════ */

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const TICK = INDEX.slice(
  INDEX.indexOf('async function runForceChargeTick('),
  INDEX.indexOf('async function escalateForceChargeStuck('),
);
const branch = (kind: string): string => {
  const at = TICK.indexOf(`if (action.kind === '${kind}') {`);
  assert.ok(at > 0, `runForceChargeTick handles '${kind}'`);
  return TICK.slice(at, TICK.indexOf('\n  }\n', at));
};

test('★★★ index.ts: the verify reads the pinned house panel, and only a FRESH readback', () => {
  assert.ok(TICK.includes('const shp2 = findShp2(store.get().devices);'), 'the pinned house panel only');
  assert.ok(TICK.includes("const sp: any = shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs) ? shp2.projection : null;"));
  assert.ok(TICK.includes('const slotSocPct: Record<number, number | null> | null = sources == null ? null'),
    'the Core SoCs come from the same fresh readback as slotsOn — a stale one gives none');
  assert.ok(TICK.includes('    slotSocPct,'), 'and reach the decision');
});

test('★★★ index.ts: the re-issue is spent BEFORE its writes (write-ahead) and targets the house panel', () => {
  const b = branch('onRetry');
  assert.ok(b.includes('const blocked = multiPanelWriteBlock();'), 'the multi-panel block applies to the re-issue too');
  const spend = b.indexOf('forceChargeOnRetries: nightActuationMem.forceChargeOnRetries + 1,');
  const stamp = b.indexOf('forceChargeOnLastAttemptMs: nowMs,');
  const write = b.indexOf('await setChannelForceCharge({ sn: shp2.sn, slot, on: true');
  assert.ok(spend > 0 && stamp > 0 && write > spend && write > stamp,
    'a cloud that keeps refusing must still reach the warning, not loop in silence');
});

test('★★★ index.ts: the failure is persisted once, logged as a warning and pushed', () => {
  const b = branch('onFailed');
  assert.ok(b.includes('persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs });'));
  assert.ok(b.includes('app.log.warn(`night-charge: force-charge ON NEVER TOOK EFFECT'));
  assert.ok(b.includes("dedupId: 'night_charge_force_charge_on_failure',"));
  assert.ok(b.includes("severity: 'warning',"), 'a cost, not a safety, matter — the reserve is verified on its own');
  assert.match(b, /Tonight's buy above the \$\{RESERVE_WRITE_MAX_PCT\}% reserve/);
  assert.ok(!b.includes('setChannelForceCharge'), 'the warning writes nothing');
  const v = branch('onVerified');
  assert.ok(v.includes('persistNightActuation({ ...nightActuationMem, forceChargeOnVerifiedAtMs: nowMs });'));
});

test('★★ index.ts: /api/night-charge/status serves the verdict beside forceChargeOnAtMs', () => {
  const route = INDEX.slice(INDEX.indexOf("app.get('/api/night-charge/status'"), INDEX.indexOf("app.post('/api/night-charge/cancel'"));
  assert.ok(route.includes('...nightActuationMem,'), 'forceChargeOnVerifiedAtMs / forceChargeOnFailedAtMs are spread');
  assert.ok(route.includes('forceChargeOnVerify: forceChargeOnReadbackStatus(nightActuationMem),'));
});
