import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.186.0 — edges of the v1.186.0 changes found in review:
 *   1. the force-charge ON re-issue must never delay or block the OFF: no re-issue inside
 *      FORCE_CHARGE_ON_RETRY_CUTOFF_MS of the window end (the warning instead), an OFF is never
 *      held by the per-slot cooldown an ON took, the grace runs from when the ON writes
 *      FINISHED, and an implausible ceiling readback never exempts a slot;
 *   2. a degraded audible channel that goes fully dead never reads "remaining speaker(s) still
 *      work", and hands off to the unreachable alert without a "Resolved" push;
 *   3. the readiness gate derives the trajectory verdict from the sizing trough/line columns
 *      where they exist, so a flag stamped by a different scorer version cannot BLOCK it.
 */

// Point config-derived paths at a throwaway dir BEFORE commands.ts (→ writeLog → config) loads.
const tmp = mkdtempSync(join(tmpdir(), 'ef-edges-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.WRITE_LOG_PATH = join(tmp, 'writes.log');

const FC = await import('../src/nightForceCharge.js');
const { emptyActuationState } = await import('../src/nightChargeActuator.js');
const { setChannelForceCharge, FORCE_CHARGE_COOLDOWN_MS } = await import('../src/ecoflow/commands.js');
const { ecoflow } = await import('../src/ecoflow/rest.js');
const H = await import('../src/broadcastHealth.js');
const { resolveHandoffOwner } = await import('../src/alertMonitor.js');
const { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } = await import('../src/nightChargeGate.js');
const { PLAN_TRAJ_BREACH_TOLERANCE_PCT } = await import('../src/nightChargeAdvisor.js');
type NightActuationState = import('../src/nightChargeActuator.js').NightActuationState;
type ForceChargeOpts = import('../src/nightForceCharge.js').ForceChargeOpts;
type NightLedgerRow = import('../src/recorder.js').NightLedgerRow;

/* ══ 1. force-charge ON re-issue vs the OFF ═══════════════════════════════ */

const H_MS = 3_600_000;
const MIN = 60_000;
const WIN_START = Date.UTC(2026, 8, 24, 6, 0);
const WIN_END = WIN_START + 6 * H_MS;

const onNight = (onAt: number, over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(),
  day: '2026-09-23', targetPct: 50, buyKwh: 40,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * MIN, attemptBaselinePct: 16,
  appliedAtMs: WIN_START - 5 * MIN, priorReservePct: 16, applyVerifiedAtMs: WIN_START + MIN,
  forceChargeCeilingPct: 90, forceChargeCeilingAttemptedAtMs: WIN_START + MIN, forceChargeCeilingPriorPct: 100,
  forceChargeOnAtMs: onAt, forceChargeSlots: [1, 2, 3],
  ...over,
});
const opts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 90, poolSocPct: 62, fullKwh: 92,
  slotSocPct: { 1: 62, 2: 61, 3: 63 },
  ...over,
});

test('★★★ the re-issue cutoff covers the per-slot cooldown plus the grace, and is the start\'s own margin', () => {
  assert.ok(FC.FORCE_CHARGE_ON_RETRY_CUTOFF_MS >= FORCE_CHARGE_COOLDOWN_MS + FC.FORCE_CHARGE_ON_VERIFY_AFTER_MS,
    'a re-issue can never sit inside the cooldown the window-end OFF needs');
  assert.ok(FC.FORCE_CHARGE_ON_RETRY_CUTOFF_MS >= FC.FORCE_CHARGE_MIN_RUN_MS);
});

test('★★★ a first FRESH readback near the window end warns instead of re-issuing ON', () => {
  // The review probe: ON at WE-30, ch2 rejected, readback stale until WE-2, then ch2 reads OFF.
  const n = onNight(WIN_END - 30 * MIN);
  assert.deepEqual(FC.decideForceCharge(n, WIN_END - 2 * MIN, opts({ slotsOn: [1, 3] })),
    { kind: 'onFailed', slots: [2], noRetry: true }, 'loud, and nothing written in front of the window-end OFF');
  const cut = WIN_END - FC.FORCE_CHARGE_ON_RETRY_CUTOFF_MS;
  assert.deepEqual(FC.decideForceCharge(onNight(WIN_END - 40 * MIN), cut, opts({ slotsOn: [1, 3] })),
    { kind: 'onFailed', slots: [2], noRetry: true }, 'the cutoff is inclusive');
  assert.deepEqual(FC.decideForceCharge(onNight(WIN_END - 40 * MIN), cut - 1, opts({ slotsOn: [1, 3] })),
    { kind: 'onRetry', slots: [2] }, 'one ms earlier the re-issue still goes');
  // The grid/vitals wait cannot push the re-issue into the cutoff either.
  assert.deepEqual(FC.decideForceCharge(onNight(WIN_END - 40 * MIN), cut + MIN, opts({ slotsOn: [1, 3], gridPresent: null })),
    { kind: 'onFailed', slots: [2], noRetry: true });
  // The window-end OFF itself is untouched.
  assert.deepEqual(FC.decideForceCharge(n, WIN_END, opts({ slotsOn: [1, 3] })),
    { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
  // Inside the grace nothing is decided, cutoff or not.
  assert.deepEqual(FC.decideForceCharge(onNight(WIN_END - 22 * MIN), WIN_END - 19 * MIN, opts({ slotsOn: [1, 3] })), { kind: 'none' });
});

test('★★★ an OFF is never held by the per-slot cooldown an ON took — OFF after OFF, and ON after OFF, still are', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const orig = ecoflow.sendCommand;
  (ecoflow as any).sendCommand = async (_sn: string, body: Record<string, unknown>) => { sent.push(body); return {}; };
  try {
    const w = (sn: string, slot: number, on: boolean) => setChannelForceCharge({ sn, slot, on, source: { ua: 'test' } });
    assert.equal((await w('PANEL-A', 2, true)).outcome, 'success', 'the ON re-issue');
    const off = await w('PANEL-A', 2, false);
    assert.equal(off.outcome, 'success', 'the window-end OFF right behind it goes out');
    assert.notEqual(off.rateLimited, true);
    assert.deepEqual((sent.at(-1) as any).params, { ch2ForceCharge: 'FORCE_CHARGE_OFF' });
    const off2 = await w('PANEL-A', 2, false);
    assert.equal(off2.code, 'rate-limited', 'OFFs are still spaced by the cooldown');
    const on2 = await w('PANEL-A', 2, true);
    assert.equal(on2.code, 'rate-limited', 'an ON right after an OFF still waits');
    assert.equal((await w('PANEL-A', 3, true)).outcome, 'success');
    assert.equal((await w('PANEL-A', 3, true)).code, 'rate-limited', 'ON after ON unchanged');
    assert.equal((await w('PANEL-A', 1, false)).outcome, 'success', 'slots are independent');
    assert.equal((await w('PANEL-A', 1, true)).code, 'rate-limited', 'an OFF on a fresh slot still spaces the ON after it');
    assert.equal(sent.length, 4);
  } finally {
    (ecoflow as any).sendCommand = orig;
  }
});

test('★★★ an implausible ceiling readback never exempts a slot — 0, below 80, above 100, NaN', () => {
  const n = onNight(WIN_END - 100 * MIN);
  const due = WIN_END - 100 * MIN + FC.FORCE_CHARGE_ON_VERIFY_AFTER_MS;
  for (const ceilingReadbackPct of [0, 16, 60, 79, 101, Number.NaN]) {
    assert.deepEqual(FC.decideForceCharge(n, due - 4 * MIN, opts({ slotsOn: [1, 3], ceilingReadbackPct, slotSocPct: { 1: 62, 2: 61, 3: 63 } })),
      { kind: 'none' }, `a ${ceilingReadbackPct} readback is not a ceiling`);
    assert.deepEqual(FC.decideForceCharge(n, due, opts({ slotsOn: [1, 3], ceilingReadbackPct, slotSocPct: { 1: 62, 2: 61, 3: 63 } })),
      { kind: 'onRetry', slots: [2] });
  }
  // The review's all-zero blip: ceiling 0, Core SoCs 0, pool unknown, nothing reading ON.
  assert.deepEqual(FC.decideForceCharge(n, due, opts({ slotsOn: [], ceilingReadbackPct: 0, poolSocPct: null, slotSocPct: { 1: 0, 2: 0, 3: 0 } })),
    { kind: 'onRetry', slots: [1, 2, 3] });
  // An in-range lower reading still counts (a ceiling lowered in the app mid-night).
  assert.deepEqual(FC.decideForceCharge(n, due, opts({ slotsOn: [1, 3], ceilingReadbackPct: 80, slotSocPct: { 2: 85 } })),
    { kind: 'onVerified', atCeiling: [2] });
});

test('★★ an all-exempt verdict needs at least one slot of ours actually reading ON', () => {
  const n = onNight(WIN_END - 100 * MIN);
  const due = WIN_END - 100 * MIN + FC.FORCE_CHARGE_ON_VERIFY_AFTER_MS;
  const allAt = { 1: 90, 2: 91, 3: 90 };
  assert.deepEqual(FC.decideForceCharge(n, due - MIN, opts({ slotsOn: [], poolSocPct: null, slotSocPct: allAt })), { kind: 'none' },
    'no stamp inside the grace — and no permanent false VERIFIED');
  assert.deepEqual(FC.decideForceCharge(n, due, opts({ slotsOn: [], poolSocPct: null, slotSocPct: allAt })),
    { kind: 'onRetry', slots: [1, 2, 3] });
  assert.deepEqual(FC.decideForceCharge(n, due, opts({ slotsOn: [3], poolSocPct: null, slotSocPct: allAt })),
    { kind: 'onVerified', atCeiling: [1, 2] }, 'one reading ON: the exemptions stand');
});

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const TICK = INDEX.slice(INDEX.indexOf('async function runForceChargeTick('), INDEX.indexOf('async function escalateForceChargeStuck('));
const branch = (kind: string): string => {
  const at = TICK.indexOf(`if (action.kind === '${kind}') {`);
  assert.ok(at > 0, `runForceChargeTick handles '${kind}'`);
  return TICK.slice(at, TICK.indexOf('\n  }\n', at));
};

test('★★★ index.ts: the ON-verify grace is stamped when the ON writes FINISHED', () => {
  const b = branch('on');
  const write = b.indexOf('await setChannelForceCharge({ sn: shp2.sn, slot, on: true');
  const stamp = b.indexOf('persistNightActuation({ ...nightActuationMem, forceChargeOnLastAttemptMs: Date.now() });');
  assert.ok(write > 0 && stamp > write, 'after the sequential write loop, not before it');
});

test('★★★ index.ts: the re-issue re-stamps after its writes, and one that was wholly rate-limited is not spent', () => {
  const b = branch('onRetry');
  const write = b.indexOf("await setChannelForceCharge({ sn: shp2.sn, slot, on: true, source: { ua: 'night-force-charge-retry' } });");
  const restamp = b.indexOf('forceChargeOnLastAttemptMs: Date.now(),');
  assert.ok(write > 0 && restamp > write);
  assert.ok(b.includes('if (r.rateLimited === true) limited++;'));
  assert.ok(b.includes('const unspent = limited === action.slots.length;'));
  assert.ok(b.includes('...(unspent ? { forceChargeOnRetries: Math.max(0, nightActuationMem.forceChargeOnRetries - 1) } : {}),'));
  const f = branch('onFailed');
  assert.ok(f.includes('action.noRetry'), 'the warning says why no re-issue went');
});

/* ══ 2. degraded → unreachable audible handover ═══════════════════════════ */

const HB = (over: Partial<import('../src/broadcastHealth.js').BroadcastHealth>) => ({
  enabled: true, supervised: true, targetCount: 2, usableTargets: 1, musicAssistantAvailable: true,
  reachable: true, reason: null, lastProbeAt: 1, degraded: true,
  unusableTargets: ['media_player.b (unavailable)'], ...over,
});

test('★★★ zero usable while the unreachable alert confirms: never "Only 0 of N … remaining speaker(s) still work"', () => {
  const a = H.broadcastDegradedAlert(HB({ usableTargets: 0, unusableTargets: ['media_player.a (unavailable)', 'media_player.b (unavailable)'] }), 0);
  assert.ok(a, 'the alert stays up until the unreachable alert takes over');
  assert.ok(!a!.detail.includes('remaining speaker(s)'), a!.detail);
  assert.ok(!a!.detail.includes('Only 0'), a!.detail);
  assert.match(a!.detail, /No configured speaker \(0 of 2\)/);
  assert.match(a!.detail, /will NOT play/);
  const partial = H.broadcastDegradedAlert(HB({}), 0)!;
  assert.match(partial.detail, /^Only 1 of 2 configured speaker\(s\)/, 'a partial channel reads as before');
  assert.match(partial.detail, /the remaining speaker\(s\) and push alerts still work/);
});

test('★★★ degraded → fully dead is a HANDOFF (no "Resolved"); a genuine recovery still resolves', () => {
  assert.equal(H.AUDIBLE_DEGRADED_ALERT_ID, 'system-audible-degraded', 'alertMonitor spells the ids out');
  assert.equal(H.AUDIBLE_UNREACHABLE_ALERT_ID, 'system-audible-unreachable');
  // The tick the channel is confirmed dead: degraded yields, unreachable rises.
  const dead = HB({ reachable: false, usableTargets: 0 });
  assert.equal(H.broadcastDegradedAlert(dead, 0), null);
  const ids = new Set([H.broadcastHealthAlert(dead, 0)!.id]);
  assert.equal(resolveHandoffOwner(H.AUDIBLE_DEGRADED_ALERT_ID, ids), H.AUDIBLE_UNREACHABLE_ALERT_ID);
  assert.equal(resolveHandoffOwner(H.AUDIBLE_DEGRADED_ALERT_ID, new Set()), null, 'every speaker back: resolved');
  assert.equal(resolveHandoffOwner(H.AUDIBLE_DEGRADED_ALERT_ID, new Set(['shp2-below-reserve'])), null);
  assert.equal(resolveHandoffOwner(H.AUDIBLE_UNREACHABLE_ALERT_ID, new Set([H.AUDIBLE_DEGRADED_ALERT_ID])), null,
    'dead → partial: the unreachable alert resolves normally');
});

/* ══ 3. readiness: the trajectory verdict from the sizing columns ═════════ */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 4, 30);
const ago = (d: number) => phoenixYmd(NOW - d * DAY);
function row(plan_date: string, f: Record<string, unknown> = {}): NightLedgerRow {
  const d = Math.round((NOW - Date.parse(`${plan_date}T12:00:00Z`)) / DAY);
  return {
    plan_date, algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - d * DAY, outcome_captured_at_ms: NOW - (d - 1) * DAY,
    scored: 1, actuated: 1, cushion_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 0,
    min_proj_soc_pct: 0, actual_min_soc_pct: 60, buy_err_kwh: 1,
    pv_err_frac: 0.05, load_err_frac: -0.1, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.97,
    cushion_trough_soc_pct: 34.12, cushion_line_soc_pct: 34.12,
    ...f,
  } as unknown as NightLedgerRow;
}
const clean = (): NightLedgerRow[] => { const r: NightLedgerRow[] = []; for (let d = 25; d >= 3; d--) r.push(row(ago(d))); return r; };

test('★★★ a boundary row captured by reverted pre-v1.186 code (columns held, flag 1) is not a strike — and is SAID', () => {
  const r = computeNightChargeReadiness([...clean(), row(ago(2), { plan_traj_floor_breached: 1 })], NOW);
  assert.equal(r.metrics.activeStrikes, 0);
  assert.equal(r.metrics.trajStrikesSetAside, 1, 'the overruled flag is counted, never dropped silently');
  assert.ok(!r.blocking.some((b) => b.includes('engine-fault')), r.blocking.join(' | '));
});

test('★★★ the columns decide both ways: a trough under the line is a strike even with the flag 0', () => {
  const r = computeNightChargeReadiness([...clean(), row(ago(2), { cushion_trough_soc_pct: 20, plan_traj_floor_breached: 0 })], NOW);
  assert.equal(r.metrics.activeStrikes, 1);
  assert.equal(r.state, 'BLOCKED');
  const edge = 34.12 - PLAN_TRAJ_BREACH_TOLERANCE_PCT;
  assert.equal(computeNightChargeReadiness([...clean(), row(ago(2), { cushion_trough_soc_pct: edge + 0.001, plan_traj_floor_breached: 1 })], NOW).metrics.activeStrikes, 0,
    'inside the rounding tolerance: not a breach');
  assert.equal(computeNightChargeReadiness([...clean(), row(ago(2), { cushion_trough_soc_pct: edge - 0.01 })], NOW).metrics.activeStrikes, 1);
});

test('★★ without BOTH columns the stored flag still decides (fail-closed, unchanged)', () => {
  const r = computeNightChargeReadiness([...clean(), row(ago(2), { cushion_line_soc_pct: null, plan_traj_floor_breached: 1 })], NOW);
  assert.equal(r.metrics.activeStrikes, 1, 'a trough without a line: the flag counts');
  const n = computeNightChargeReadiness([...clean(), row(ago(2), { cushion_shortfall: null, cushion_trough_soc_pct: null, cushion_line_soc_pct: null, plan_traj_floor_breached: 1 })], NOW);
  assert.equal(n.metrics.activeStrikes, 1, 'the NULL-disclosure row, as before');
  const adv = computeNightChargeReadiness([...clean(), row(ago(2), { confidence_tier: 'climatology', cushion_trough_soc_pct: 20 })], NOW);
  assert.equal(adv.metrics.activeStrikes, 0, 'trajectory strikes are forecast-tier only');
});
