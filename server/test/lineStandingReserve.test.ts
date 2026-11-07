import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNightChargePlan, buildNightChargeInputs, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import * as act from '../src/nightChargeActuator.js';
import type { ActuationTickOpts, NightActuationState } from '../src/nightChargeActuator.js';
import * as nfc from '../src/nightForceCharge.js';
import type { ForceChargeOpts } from '../src/nightForceCharge.js';
import * as cyc from '../src/chargeCycle.js';
import type { ChargeLegState } from '../src/chargeCycle.js';
import * as notify from '../src/notify.js';
import * as gate from '../src/nightChargeGate.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';
import * as cardText from '../../web/src/cards/nightChargeText.js';

/**
 * v1.200.1 — A LINE NIGHT RIDES A STANDING 50. When the panel already reads the 50% target, the force-charge switches on with no reserve
 * write; a night whose reserve fell under 50 after the plan keeps its ask, gets its write and rides it. The new names are read off the
 * modules so a run on a3588d96 fails on each assert, one test at a time (A3-failing-first.txt, "## v1.200.1").
 *
 * S1 the plan: the reading decides words, never the record. S2 the stamp: behind every apply guard, and the grid. S3 after the stamp: no
 * apply, the foreign rule to the close, the grid-loss stamp. S4 the ride: stamp and a same-tick reading. S5 the record's readers. S6 the OFF
 * and the ceiling, no revert ever. S7 the texts, true in every outcome. S8 the gate: graded by disposition, no graduation evidence.
 * S9 the wiring, source-anchored. S10 a grid read lost where the stamp would go: one-way, on a record with no stamp, and each reader of it.
 * The year's walks are in lineStandingWalk.test.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (p: string): string => readFileSync(resolve(HERE, p), 'utf8');
const INDEX = SRC('../src/index.ts');
const M = 60_000;
const H = 60 * M;
const OPEN = Date.UTC(2027, 0, 5, 6); // 23:00 MST
const CLOSE = OPEN + 6 * H; // 05:00 MST
const G = { cost: false, line: true };
const CASES = legacyIdentityCases();
const LABEL = '2027-01-04 21:30';
const STOOD_PREFIX = 'reserve stood — ';

type Rec = NightActuationState & { reserveStandingAtMs: number | null; gridLostAtMs: number | null };
type P = NightChargePlan & { forceChargeLine?: { askPct: number; linePct: number }; cushionEnvelopeReason?: string; cushionShortfallCause?: string; expectedForceChargeMode?: string; lineReserveStands?: true };

const armed = (o: Partial<Rec> = {}): Rec => ({
  ...act.emptyActuationState(), day: '2027-01-04', announcedAtMs: OPEN - 90 * M, targetPct: 50, buyKwh: 28, windowStartMs: OPEN, windowEndMs: CLOSE,
  forceChargeRides: true, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55, ...o,
} as Rec);
const noAsk = (o: Partial<Rec> = {}): Rec => armed({ forceChargeLineAskPct: null, forceChargeLinePct: null, ...o });
const stood = (o: Partial<Rec> = {}): Rec => armed({ reserveStandingAtMs: OPEN, ...o });
const written = (o: Partial<Rec> = {}): Rec => armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 30, appliedAtMs: OPEN, priorReservePct: 30, applyVerifiedAtMs: OPEN + 3 * M, ...o });
const running = (o: Partial<Rec> = {}): Rec => stood({ forceChargeOnAtMs: CLOSE - 2 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: CLOSE - 2 * H + M, forceChargeMode: 'line', forceChargeCeilingSyncedPct: 80, ...o });
const ao = (o: Partial<ActuationTickOpts> = {}): ActuationTickOpts => ({ mode: 'supervised', writeReady: false, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true, ...o });
const fo = (o: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false, slotsOn: [], reservePct: 50, connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 80, poolSocPct: 50, fullKwh: 92.16, chargeRateKw: 14, ...o,
} as ForceChargeOpts);
const leg = (s: Rec, o: Partial<ChargeLegState> = {}): ChargeLegState => ({ ...cyc.asChargeLeg(s), ...o });
const dfc = (s: Rec, t: number, o: Partial<ForceChargeOpts> = {}) => nfc.decideForceCharge(s, t, fo(o));
const dac = (s: Rec, t: number, o: Partial<ActuationTickOpts> = {}) => act.decideActuation(s, t, ao(o));
const ride = (s: Parameters<typeof nfc.forceChargeLineNightPct>[0] & Partial<Rec>): boolean => (nfc as unknown as { reserveRideReady: (s: unknown) => boolean }).reserveRideReady(s);
const startTick = CLOSE - H; // past the timed start at 14 kW from a 50% pool

const planAt = (floor: number, o: { eligible?: boolean; cost?: boolean; hours?: number; label?: string } = {}): P => computeNightChargePlan(buildNightChargeInputs({
  ...CASES.find((c) => c.label === (o.label ?? LABEL))!.deps, reserveFloorPct: floor, cushionPoolScale: MEASURED_SCALE,
  forceChargeEligible: o.cost === true, ...(o.cost === true ? { objectiveMode: 'cost', costMaxSocPct: 80 } : {}),
  ...(o.eligible !== false ? { lineForceChargeEligible: true } : {}), ...(o.hours != null ? { outageCushionHours: o.hours } : {}),
} as never)) as P;
const SIZING = ['chargeTonight', 'buyKwh', 'buyKwhDebiased', 'requiredExtraKwh', 'targetSocPct', 'setpointSocPct', 'costCeilingSocPct', 'cushionTroughSocPct', 'cushionLineSocPct', 'bindingCap', 'minProjSocPct'] as const;
const sizing = (p: NightChargePlan) => Object.fromEntries(SIZING.map((k) => [k, (p as never)[k] ?? null]));
const SUP = { cancelDeadlineText: 'at 11:00 PM', targetPct: 50, forceChargeTargetPct: null, forceChargeLine: null };
const lineSup = (p: P) => ({ ...SUP, forceChargeLine: { askPct: p.forceChargeLine!.askPct, linePct: p.forceChargeLine!.linePct, panelCeilingPct: p.forceChargeLine!.askPct + 10 } });
const banner = cardText.actuationBannerState as unknown as (a: unknown, d: string | null, r?: number | null) => { text: string; settled: boolean; cancel: string | null };

/* ══ S1 — the plan ═════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ S1 at a reserve of 50 the ask is carried: the record gets it, no sizing figure moves, and the reason is gone or says what the walk cannot hold', () => {
  const p = planAt(50);
  assert.equal(p.chargeTonight, true);
  assert.ok(p.cushionLineSocPct! > 50);
  assert.ok(p.forceChargeLine != null, 'the ask is carried');
  assert.equal(p.lineReserveStands, true);
  assert.ok(p.cushionEnvelopeReason == null || p.cushionEnvelopeReason === 'nearFull' || p.cushionEnvelopeReason === 'closeUnder', String(p.cushionEnvelopeReason));
  assert.deepEqual(sizing(p), sizing(planAt(50, { eligible: false })), 'the plan-time reading decides no write');
  const rec = act.armFromPlan(act.emptyActuationState(), '2027-01-04', p as never, p.window!.startMs - 90 * M, 50, false, null, true)!;
  assert.equal(rec.forceChargeLineAskPct, p.forceChargeLine!.askPct);
  assert.equal(rec.targetPct, 50);
});

test('★★★ S1 one point under the reserve is a written night with its words; one point over it, or a mid-day leg at it, is disclosed with no ask', () => {
  const under = planAt(49);
  assert.ok(under.forceChargeLine != null);
  assert.equal('lineReserveStands' in under, false, 'a written night: not set, so its digest does not move');
  assert.ok(under.rationale.includes('The reserve is set to 50%, the most the panel accepts'), under.rationale);
  assert.ok(under.rationale.includes('After the window the reserve returns to 49%'), under.rationale);
  const over = planAt(51);
  assert.equal(over.forceChargeLine, undefined);
  assert.equal(over.cushionEnvelopeReason, 'reserveAtTarget');
  assert.equal('lineReserveStands' in over, false);
  for (const p of [planAt(45), planAt(10), planAt(50, { eligible: false }), planAt(45, { hours: 1 })]) assert.equal('lineReserveStands' in p, false);
});

test('★★★ S1 no eligibility input: no ask and no flag at a reserve of 50, as v1.199.1 was', () => {
  const p = planAt(50, { eligible: false });
  assert.equal(p.forceChargeLine, undefined);
  assert.equal(p.cushionEnvelopeReason, undefined);
  assert.equal('lineReserveStands' in p, false);
});

test('★★★ S1 a ride under 50 is unreachable: no plan of the year stands at a floor under the write (c1)', () => {
  const evenings = CASES.filter((c) => / 21:30$/.test(c.label));
  for (const floor of [10, 16, 30, 40, 47, 49]) for (const hours of [4, 12, 20]) for (const c of evenings) {
    const p = planAt(floor, { label: c.label, hours });
    assert.equal('lineReserveStands' in p, false, `${c.label} at ${floor}, ${hours} h`);
  }
});

const MID_DAY = { kind: 'super_off_peak', role: 'cost' } as const;
test('★★★ S1 a mid-day leg at the write keeps its disclosure: its re-entry rule is a separate change', () => {
  // The leg's kind is all the plan's standing test reads; its window stays the case's own.
  const deps = { ...CASES.find((c) => c.label === LABEL)!.deps, reserveFloorPct: 50, cushionPoolScale: MEASURED_SCALE, lineForceChargeEligible: true, forceChargeEligible: false } as never;
  const inputs = buildNightChargeInputs(deps)!;
  const spec = { ...MID_DAY, window: { startMs: inputs.nowMs + 12 * H, endMs: inputs.nowMs + 17 * H } };
  const p = computeNightChargePlan({ ...inputs, windowSpec: spec } as never) as P;
  assert.equal(p.forceChargeLine, undefined, p.rationale);
  assert.equal('lineReserveStands' in p, false);
  assert.ok('middayReentryHold' in p, 'nothing armed, so the leg keeps its re-entry hold');
  const under = computeNightChargePlan({ ...buildNightChargeInputs({ ...(deps as object), reserveFloorPct: 45 } as never)!, windowSpec: spec } as never) as P;
  assert.ok(under.forceChargeLine != null, 'under the write the same leg arms: this is the reading, not the leg');
});

test('★★★ S1 the rationale of a night that stands names no write and no restore; a cost-dominant night too', () => {
  const p = planAt(50);
  assert.ok(p.rationale.includes('The reserve reads 50%, the most the panel accepts as a backup reserve'), p.rationale);
  assert.ok(p.rationale.includes('No restore is due while the reserve reads 50%.'), p.rationale);
  assert.doesNotMatch(p.rationale, /tonight's write|returns to|as usual|The reserve is set to/, p.rationale);
  assert.ok(p.rationale.includes("the panel's own reserve charges it") || !/charges it/.test(p.rationale), p.rationale);
  const costPlan = (label: string): P => computeNightChargePlan(buildNightChargeInputs({
    ...CASES.find((c) => c.label === label)!.deps, reserveFloorPct: 50, cushionPoolScale: MEASURED_SCALE, outageCushionHours: 4,
    forceChargeEligible: true, objectiveMode: 'cost', costMaxSocPct: 95, lineForceChargeEligible: true,
  } as never)) as P;
  const label = CASES.map((c) => c.label).filter((l) => / 21:30$/.test(l)).find((l) => { const c = costPlan(l); return c.forceChargeLine != null && c.expectedForceChargeMode !== 'line'; });
  assert.ok(label != null, 'a cost-dominant night, with its ask');
  const cost = costPlan(label);
  assert.equal(cost.lineReserveStands, true);
  assert.doesNotMatch(cost.rationale, /tonight's write|The reserve is set to/, cost.rationale);
});

test('★★★ S1 the two sentences only a pool under the reserve or a cost-dominant ask reach: the panel\'s own reserve fills it, and it reads 50%', () => {
  // A recompute mid-window with the pool under the reserve: what charges it is the panel's own, no write.
  const d = CASES.find((c) => c.label === '2026-10-14 21:30')!.deps as { nowMs: number };
  const low = computeNightChargePlan(buildNightChargeInputs({ ...d, reserveFloorPct: 50, cushionPoolScale: MEASURED_SCALE, forceChargeEligible: false, lineForceChargeEligible: true, nowMs: d.nowMs + 2 * H, socNowPct: 45 } as never)) as P;
  assert.equal(low.lineReserveStands, true);
  assert.ok(low.rationale.includes("the pool is at ~45% now, and the panel's own reserve charges it to the 50% reserve"), low.rationale);
  // A cost-dominant night with its setpoint above what the window reaches keeps the reserve sentence, in the words of a reading.
  const cost = computeNightChargePlan(buildNightChargeInputs({ ...CASES.find((c) => c.label === '2026-10-12 mid-window 02:55')!.deps, reserveFloorPct: 50, outageCushionHours: 2, forceChargeEligible: true, objectiveMode: 'cost', costMaxSocPct: 80, lineForceChargeEligible: true } as never)) as P;
  assert.equal(cost.lineReserveStands, true);
  assert.ok(cost.expectedForceChargeMode !== 'line');
  assert.ok(cost.rationale.includes("The reserve reads 50% — tonight's cost target asks for 80%, but the panel only accepts a backup reserve up to 50%."), cost.rationale);
});

/* ══ S2 — the stamp ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ S2 the stamp: on a line ask, a reading strictly equal to the target, no attempt on record, inside every apply guard; nothing else', () => {
  assert.deepEqual(dac(armed(), OPEN), { kind: 'reserveStanding' }, 'the open');
  assert.deepEqual(dac(armed(), OPEN + act.APPLY_LATE_MS), { kind: 'reserveStanding' }, 'the last instant of the apply window');
  assert.deepEqual(dac(armed(), OPEN + act.APPLY_LATE_MS + 1000), { kind: 'none' }, 'past it: no late stamp');
  assert.deepEqual(dac(armed(), OPEN - M), { kind: 'none' }, 'a reading before the open never stamps');
  assert.deepEqual(dac(noAsk(), OPEN), { kind: 'none' }, 'no ask: byte-identical');
  assert.deepEqual(dac(armed(), OPEN, { mode: 'advisory' }), { kind: 'none' }, 'advisory');
  assert.deepEqual(dac(armed(), OPEN, { vitalsRed: true }), { kind: 'none' }, 'vitals');
  assert.deepEqual(dac(armed(), OPEN, { socCoherent: false }), { kind: 'none' }, 'incoherent');
  assert.deepEqual(dac(armed(), OPEN, { currentReservePct: null }), { kind: 'none' }, 'stale');
  assert.deepEqual(dac(armed(), OPEN, { currentReservePct: 60 }), { kind: 'none' }, 'above the write: out of the envelope');
  assert.deepEqual(dac(armed({ targetPct: 45 }), OPEN, { currentReservePct: 50 }), { kind: 'none' }, 'above the target: strict equality');
  assert.deepEqual(dac(armed({ cancelled: true }), OPEN), { kind: 'none' }, 'cancelled');
  assert.deepEqual(dac(armed(), OPEN, { currentReservePct: 45 }), { kind: 'apply', targetPct: 50 }, 'lowered: the write goes, as armed');
  assert.deepEqual(dac(armed({ nextOnPeakStartMs: OPEN + 30 * M }), OPEN), { kind: 'none' }, 'the on-peak guard');
  assert.deepEqual(dac(armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 45 }), OPEN + 2 * M), { kind: 'adopt', priorPct: 45 }, 'an attempt on record: its reading adopts it');
  assert.deepEqual(dac(armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 50 }), OPEN + 2 * M), { kind: 'none' }, 'an attempt that read the target: no stamp');
});

test('★★★ S2 a grid read lost where the stamp would go is one-way, never a deferred stamp; unknown keeps its reading for the ON to refuse', () => {
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: false }), { kind: 'gridLost' });
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: null }), { kind: 'reserveStanding' }, 'unknown: the ON needs it known, and a stamp writes nothing');
  assert.deepEqual(dac(noAsk(), OPEN, { gridPresent: false }), { kind: 'none' });
  // The same site as the stamp, so the same guards: each of these is the stamp's own "no".
  assert.deepEqual(dac(armed(), OPEN - M, { gridPresent: false }), { kind: 'none' }, 'before the open');
  assert.deepEqual(dac(armed(), OPEN + 30 * M + 1000, { gridPresent: false }), { kind: 'none' }, 'past the apply window');
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: false, mode: 'advisory' }), { kind: 'none' });
  assert.deepEqual(dac(armed({ cancelled: true }), OPEN, { gridPresent: false }), { kind: 'none' });
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: false, vitalsRed: true }), { kind: 'none' });
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: false, socCoherent: false }), { kind: 'none' });
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: false, currentReservePct: null }), { kind: 'none' });
  assert.deepEqual(dac(armed({ targetPct: 45 }), OPEN, { gridPresent: false, currentReservePct: 50 }), { kind: 'none' }, 'above the target: strict equality');
  assert.deepEqual(dac(armed({ applyAttemptedAtMs: OPEN, attemptBaselinePct: 50 }), OPEN + 2 * M, { gridPresent: false }), { kind: 'none' }, 'an attempt on record');
  assert.deepEqual(dac(armed(), OPEN, { gridPresent: false, currentReservePct: 45 }), { kind: 'apply', targetPct: 50 }, 'a reading under the target: a written night, as it was');
});

/* ══ S3 — after the stamp ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ S3 no apply follows a stamp: a lowered reading gets no raise, and nothing of the record is written by it', () => {
  assert.deepEqual(dac(stood(), OPEN + M, { currentReservePct: 45 }), { kind: 'foreignSeen', pct: 45 }, 'a sighting, never an apply');
  for (const reading of [50, null]) assert.deepEqual(dac(stood(), OPEN + 5 * M, { currentReservePct: reading }), { kind: 'none' }, String(reading));
  assert.deepEqual(dac(stood(), OPEN + 5 * M, { mode: 'advisory', currentReservePct: 45 }), { kind: 'foreignSeen', pct: 45 }, 'mode-independent, like the restore');
});

test('★★★ S3 the foreign rule on a stood night: seen, cleared, settled on two readings 5 min apart, and it ends at the close', () => {
  const seen = stood({ foreignReservePct: 40, foreignSeenAtMs: OPEN + H });
  assert.deepEqual(dac(seen, OPEN + H + act.FOREIGN_RESERVE_SETTLE_MS - 1000, { currentReservePct: 40 }), { kind: 'none' }, 'under 5 min');
  assert.deepEqual(dac(seen, OPEN + H + act.FOREIGN_RESERVE_SETTLE_MS, { currentReservePct: 40 }), { kind: 'foreignSettled', pct: 40 });
  assert.deepEqual(dac(seen, OPEN + H + M, { currentReservePct: 50 }), { kind: 'foreignCleared' });
  assert.deepEqual(dac(seen, OPEN + H + M, { currentReservePct: 35 }), { kind: 'foreignSeen', pct: 35 }, 'another value starts over');
  assert.deepEqual(dac(stood(), CLOSE, { currentReservePct: 40 }), { kind: 'none' }, 'at the close: a change is no longer the night\'s');
  assert.deepEqual(dac(stood(), CLOSE + 9 * H, { currentReservePct: 16 }), { kind: 'none' }, 'tomorrow\'s change never settles as foreign');
  assert.deepEqual(dac(stood({ nextOnPeakStartMs: CLOSE + 30 * M }), CLOSE - 30 * M, { currentReservePct: 40 }), { kind: 'none' }, 'the on-peak bound');
  assert.deepEqual(dac(stood(), OPEN + H, { currentReservePct: 0 }), { kind: 'none' }, 'a reconnect 0 is no sighting');
  assert.deepEqual(dac(stood({ cancelled: true }), OPEN + H, { currentReservePct: 40 }), { kind: 'none' }, 'cancelled');
  assert.deepEqual(dac(stood({ foreignSettledAtMs: OPEN + H }), OPEN + 2 * H, { currentReservePct: 30 }), { kind: 'none' }, 'settled once');
  assert.deepEqual(dac(stood({ gridLostAtMs: OPEN + H }), OPEN + 2 * H, { currentReservePct: 30 }), { kind: 'none' }, 'the ride is over');
  assert.equal(stood().priorReservePct, null, 'the view is a view: the record keeps no prior');
});

test('★★★ S3 a stood night read the grid lost: one action, before the close, ahead of a sighting; once', () => {
  assert.deepEqual(dac(stood(), OPEN + H, { gridPresent: false }), { kind: 'gridLost' });
  assert.deepEqual(dac(stood(), OPEN + H, { gridPresent: false, currentReservePct: 40 }), { kind: 'gridLost' }, 'ahead of a sighting');
  assert.deepEqual(dac(stood({ gridLostAtMs: OPEN + H }), OPEN + H + M, { gridPresent: false }), { kind: 'none' }, 'stamped once');
  assert.deepEqual(dac(stood(), OPEN + H, { gridPresent: null }), { kind: 'none' }, 'unknown is no loss, as on a written night');
  assert.deepEqual(dac(stood(), CLOSE, { gridPresent: false }), { kind: 'none' }, 'past the close: no ride to end');
  assert.deepEqual(dac(stood({ cancelled: true }), OPEN + H, { gridPresent: false }), { kind: 'none' }, 'cancelled');
  assert.deepEqual(dac(running(), CLOSE - H, { gridPresent: false }), { kind: 'gridLost' }, 'with an ON too: the record says it is over');
});

test('★★★ S3 the two paths never share a record, across a restart: the stamp and the grid-loss stamp round-trip; a record of v1.200.0 reads null', () => {
  const back = act.coerceActuationState(JSON.parse(JSON.stringify(stood({ gridLostAtMs: OPEN + H })))) as Rec;
  assert.equal(back.reserveStandingAtMs, OPEN);
  assert.equal(back.gridLostAtMs, OPEN + H);
  const old = JSON.parse(JSON.stringify(armed())) as Record<string, unknown>;
  delete old.reserveStandingAtMs; delete old.gridLostAtMs;
  const read = act.coerceActuationState(old) as Rec;
  assert.equal(read.reserveStandingAtMs, null);
  assert.equal(read.gridLostAtMs, null);
  assert.deepEqual(dac(read, OPEN + M), { kind: 'reserveStanding' }, 'the first tick in the window stamps it');
  const e = act.emptyActuationState() as Rec;
  assert.equal(e.reserveStandingAtMs, null);
  assert.equal(e.gridLostAtMs, null);
});

/* ══ S4 — the ride ═════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ S4 the ride: the stamp AND a same-tick reading of the target; moved and unread each decline with their own words, ahead of the ceiling', () => {
  assert.deepEqual(dfc(stood(), startTick), { kind: 'on', slots: [1, 2, 3] });
  assert.deepEqual(dfc(stood(), startTick, { reservePct: 40 }), { kind: 'none', why: 'the reserve no longer reads the night\'s target' });
  assert.deepEqual(dfc(stood(), startTick, { reservePct: 51 }), { kind: 'none', why: 'the reserve no longer reads the night\'s target' }, 'strict equality');
  assert.deepEqual(dfc(stood(), startTick, { reservePct: null }), { kind: 'none', why: 'the panel is not reporting its reserve' });
  assert.deepEqual(dfc(stood(), startTick, { reservePct: undefined }), { kind: 'none', why: 'the panel is not reporting its reserve' }, 'absent is no reading');
  // No ceiling write on a moved reading.
  const unsynced = { ceilingReadbackPct: 100 };
  assert.deepEqual(dfc(stood(), startTick, unsynced), { kind: 'syncCeiling', pct: 80, prior: 100 });
  assert.deepEqual(dfc(stood(), startTick, { ...unsynced, reservePct: 40 }), { kind: 'none', why: 'the reserve no longer reads the night\'s target' });
  assert.deepEqual(dfc(stood(), startTick, { ...unsynced, reservePct: null }), { kind: 'none', why: 'the panel is not reporting its reserve' });
  // Both are blockers, so one that never settles (out of the envelope) pushes.
  const W = nfc.FORCE_CHARGE_BLOCKER_WHY as unknown as Record<string, string>;
  assert.equal(nfc.forceChargeBlockerClass(W.reserveMoved), 'reserveMoved');
  assert.equal(nfc.forceChargeBlockerClass(W.reserveUnread), 'reserveUnread');
});

test('★★★ S4 no stamp is no ride; a stamp with its ask coerced away is none; a written night never reads the input', () => {
  assert.deepEqual(dfc(armed(), startTick), { kind: 'none', why: 'waiting for the reserve write to be verified by readback' }, 'no stamp, whatever the reading');
  assert.equal(ride(stood()), true);
  assert.equal(ride(armed()), false);
  assert.equal(ride(written()), true);
  assert.equal(ride(written({ applyVerifiedAtMs: null })), false, 'an unread write');
  assert.equal(ride(stood({ forceChargeLineAskPct: null, forceChargeLinePct: null })), false, 'no ride with the ask coerced away');
  assert.equal(ride(stood({ gridLostAtMs: OPEN + H })), false, 'the grid-loss stamp ends it');
  assert.equal(dfc(stood({ forceChargeLineAskPct: null, forceChargeLinePct: null, forceChargeCeilingPct: 80 }), startTick, { enabled: true }).kind, 'none');
  for (const reading of [null, 40, 50, undefined]) assert.equal(dfc(written(), startTick, { reservePct: reading }).kind, 'on', `written night, reading ${reading}`);
});

test('★★★ S4 the one deliberate non-identity: a cost-dominant night WITH an ask at a standing 50 rides in cost mode, for its stop carries the line; with no ask it never stamps', () => {
  const dominant = stood({ forceChargeCeilingPct: 90, forceChargeLineAskPct: 56 });
  assert.equal(nfc.forceChargeModeOf(dominant, { cost: true, line: true })?.kind, 'cost');
  const t = CLOSE - 2 * H;
  assert.deepEqual(dfc(dominant, t, { enabled: true, ceilingReadbackPct: 90 }), { kind: 'on', slots: [1, 2, 3] });
  assert.deepEqual(dfc(dominant, t, { enabled: true, ceilingReadbackPct: 90, reservePct: 40 }), { kind: 'none', why: 'the reserve no longer reads the night\'s target' });
  assert.deepEqual(dac(noAsk({ forceChargeCeilingPct: 90 }), OPEN), { kind: 'none' }, 'a cost night with no ask at a reading of 50 is as it was: no stamp, no ride');
  assert.equal(dfc(noAsk({ forceChargeCeilingPct: 90 }), t, { enabled: true, ceilingReadbackPct: 90 }).kind, 'none');
});

test('★★★ S4 a grid lost is one-way: the same blip as a written night, no ON when it returns, and the ceiling comes back at once', () => {
  const lost = stood({ forceChargeCeilingPriorPct: 100, forceChargeCeilingAttemptedAtMs: OPEN, forceChargeCeilingSyncedPct: 66 });
  // c4: before the change the second read started an ON.
  assert.equal(dfc(lost, startTick, { gridPresent: false, ceilingReadbackPct: 66 }).kind, 'none');
  const stamped = { ...lost, gridLostAtMs: startTick } as Rec;
  assert.deepEqual(dfc(stamped, startTick + 10 * M, { ceilingReadbackPct: 66 }), { kind: 'restoreCeiling', pct: 100, lastAttempt: false }, 'the grid back: no ON, the ceiling goes back');
  assert.deepEqual(dfc({ ...stamped, forceChargeCeilingPriorPct: null } as Rec, startTick + 10 * M, { ceilingReadbackPct: 66 }), { kind: 'none', why: 'the grid was lost during the window' });
  // A written night, the same blip: for comparison.
  assert.deepEqual(dac(written(), startTick, { gridPresent: false }), { kind: 'revert', restorePct: 30, gridLossAbort: true });
  // An ON on the record goes off on the stamp alone, the grid reading true again.
  assert.deepEqual(dfc(running({ gridLostAtMs: CLOSE - H }), CLOSE - H + M, { slotsOn: [1, 2, 3] }), { kind: 'off', slots: [1, 2, 3], reason: 'gridLoss' });
});

test('★★ S4 the declined-start push rides the stamp: a held start on a stood night pushes, and a night with the grid lost or no ride does not', () => {
  const why = 'host vitals are critical — no new device writes';
  const pushed = (s: Rec): string[] => {
    let mem = { day: null as string | null, st: nfc.EMPTY_LINE_DECLINED_PUSH };
    const out: string[] = [];
    for (let t = OPEN + H; t <= OPEN + H + 11 * M; t += M) { const r = nfc.lineDeclinedPushTick(mem, s, why, t, G); mem = r.mem; if (r.push != null) out.push(r.push); }
    return out;
  };
  assert.deepEqual(pushed(stood()), ['vitals']);
  assert.deepEqual(pushed(armed()), [], 'no ride: the missed push has it');
  assert.deepEqual(pushed(stood({ gridLostAtMs: OPEN + H })), [], 'the ride is over: its push went');
  assert.deepEqual(pushed(written()), ['vitals'], 'a written night as ever');
  assert.deepEqual(pushed(written({ applyVerifiedAtMs: null })), [], 'before its write verified');
});

/* ══ S5 — the record's readers ═════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ S5 forceChargeStartClosed: a stamp is no "noWrite"; the grid-loss stamp is its own key, in words true for the night', () => {
  const t = OPEN + 31 * M;
  assert.equal(nfc.forceChargeStartClosed(armed(), t, G), 'noWrite', 'no stamp');
  assert.equal(nfc.forceChargeStartClosed(stood(), t, G), null);
  assert.equal(nfc.forceChargeStartClosed(stood({ gridLostAtMs: t }), t, G), 'gridLost');
  assert.equal(nfc.forceChargeStartClosed(stood({ foreignSettledAtMs: t }), t, G), 'foreign');
  assert.equal(nfc.forceChargeStartClosed(stood({ cancelled: true }), t, G), 'cancelled');
  assert.equal(nfc.forceChargeStartClosed(stood(), CLOSE - 20 * M, G), 'late');
  assert.equal(nfc.forceChargeStartClosed(stood(), CLOSE, G), 'over');
  assert.equal(nfc.lineStartClosedWords('the 55.6% outage line', 'gridLost'), 'no force-charge for the 55.6% outage line starts: the grid was lost during the window');
  assert.equal(nfc.lineStartClosedWords('the 55.6% outage line', 'noWrite'), 'no force-charge for the 55.6% outage line starts: it rides a verified reserve write or the reserve read at the target, and neither came in the apply window');
  assert.equal(nfc.lineStartClosedWords('the 55.6% outage line', 'foreign'), 'no force-charge for the 55.6% outage line starts: the reserve was changed');
  const closure = nfc.armedLineStartClosed(stood({ gridLostAtMs: t, forceChargeOnAtMs: t - M, forceChargeOffAtMs: t }), t, G);
  assert.deepEqual(closure, { windowStartMs: OPEN, why: 'gridLost' }, 'a run stopped by it: the same key, and no write stands');
});

test('★★★ S5 lineCloseAccountDue: foreign ahead of standing ahead of noWrite; a cancel is the person\'s own; once a record', () => {
  assert.equal(nfc.lineCloseAccountDue(stood(), CLOSE - M), null, 'before the close');
  assert.equal(nfc.lineCloseAccountDue(stood(), CLOSE), 'standing');
  assert.equal(nfc.lineCloseAccountDue(armed(), CLOSE), 'noWrite', 'no stamp');
  assert.equal(nfc.lineCloseAccountDue(stood({ foreignSettledAtMs: OPEN + H }), CLOSE), 'foreign');
  assert.equal(nfc.lineCloseAccountDue(stood({ cancelled: true }), CLOSE), null);
  assert.equal(nfc.lineCloseAccountDue(stood({ lineCloseAccountAtMs: CLOSE }), CLOSE + M), null, 'once');
  assert.equal(nfc.lineCloseAccountDue(stood({ gridLostAtMs: OPEN + H }), CLOSE), 'standing', 'a grid loss still gets the close\'s account');
  assert.equal(nfc.lineCloseAccountDue(noAsk(), CLOSE), null, 'no ask');
});

test('★★★ S5 legFinished: a stood leg rides past its apply window and finishes at the close, or at the grid loss that ended it', () => {
  assert.equal(cyc.legFinished(stood(), OPEN + 31 * M), false);
  assert.equal(cyc.legFinished(stood(), CLOSE - M), false);
  assert.equal(cyc.legFinished(stood(), CLOSE), true);
  assert.equal(cyc.legFinished(stood({ nextOnPeakStartMs: CLOSE + 30 * M }), CLOSE - 30 * M), true, 'the add-on\'s close');
  assert.equal(cyc.legFinished(stood({ gridLostAtMs: OPEN + H }), OPEN + H), true);
  assert.equal(cyc.legFinished(armed(), OPEN + 31 * M), true, 'no stamp: as ever');
});

test('★★★ S5 legStatusState and lineStartClosedStatus: armed while it can ride, completed once finished and with no Cancel; never "missed", never "armed" at noon (c2)', () => {
  assert.equal(cyc.legStatusState(stood(), OPEN + 31 * M), 'armed');
  for (const t of [CLOSE, CLOSE + M, CLOSE + 50 * M, CLOSE + 7 * H]) {
    assert.equal(cyc.legStatusState(stood(), t), 'completed', String((t - CLOSE) / M));
    assert.deepEqual(cyc.lineStartClosedStatus(stood(), t, G), { lineStartClosed: { text: 'No force-charge for the 55.6% outage line starts: the window has closed.', cancel: false } });
  }
  assert.equal(cyc.legStatusState(armed(), OPEN + 31 * M), 'missed', 'no stamp: as ever');
  assert.equal(cyc.legStatusState(stood({ cancelled: true }), CLOSE), 'cancelled');
  assert.equal(cyc.legStatusState(stood({ foreignSettledAtMs: OPEN + H }), CLOSE), 'foreign');
  assert.equal(cyc.legStatusState(stood({ gridLostAtMs: OPEN + H }), OPEN + H), 'completed');
  assert.equal(cyc.legStatusState(running(), CLOSE), 'forceChargeOff', 'its OFF has not read back');
  assert.equal(cyc.lineStartClosedStatus(stood({ gridLostAtMs: OPEN + H }), OPEN + H, G).lineStartClosed?.cancel, false);
  assert.equal(cyc.lineStartClosedStatus(stood(), CLOSE - 20 * M, G).lineStartClosed?.cancel, true, 'a late start closed, the night still running');
});

test('★★★ S5 no missed push on a stamp, and its reason on a leg that lost the window: the block first, a reading that never cleared the checks', () => {
  assert.equal(cyc.missedApplyDue(leg(stood()), OPEN + 31 * M), false);
  assert.equal(cyc.missedApplyDue(leg(armed()), OPEN + 31 * M), true);
  const ctx = { blockedBy: null, mode: 'supervised' as const, vitalsRed: false, socCoherent: true, currentReservePct: 50, panelBlock: null };
  // c4.
  assert.equal(cyc.missedApplyReason(leg(armed()), ctx), "the panel's reserve reading did not reach the add-on with every check clear while the 30-minute apply window was open");
  assert.equal(cyc.missedApplyReason(leg(armed()), { ...ctx, panelBlock: 'two smart panels present and none pinned' }), 'two smart panels present and none pinned');
  // No ask: unchanged, in both.
  assert.equal(cyc.missedApplyReason(leg(noAsk()), ctx), 'the backup reserve already read 50%, at or above the 50% this charge sets');
  assert.equal(cyc.missedApplyReason(leg(noAsk()), { ...ctx, panelBlock: 'two smart panels present and none pinned' }), 'the backup reserve already read 50%, at or above the 50% this charge sets');
  // A reading above the target on a line ask keeps its own words: it was not due.
  assert.equal(cyc.missedApplyReason(leg(armed({ targetPct: 45 })), ctx), 'the backup reserve already read 50%, at or above the 45% this charge sets');
});

test('★★★ S5 priorArmSuperseded leaves a stood leg: its disposition is the strike\'s evidence', () => {
  assert.equal(cyc.priorArmSuperseded(leg(stood()), '2027-01-05'), false);
  assert.equal(cyc.priorArmSuperseded(leg(armed()), '2027-01-05'), true);
});

test('★★★ S5 reserveWriteStands: a stamp stands until something settles it; the closure carries it', () => {
  const stands = (s: Rec) => nfc.reserveWriteStands(s);
  assert.equal(stands(stood()), true);
  assert.equal(stands(armed()), false);
  for (const o of [{ cancelled: true }, { foreignSettledAtMs: OPEN + H }, { gridLostAtMs: OPEN + H }]) assert.equal(stands(stood(o as Partial<Rec>)), false, JSON.stringify(o));
  assert.deepEqual(nfc.armedLineStartClosed(stood(), CLOSE - 20 * M, G), { windowStartMs: OPEN, why: 'late', writeStands: true });
});

test('★★★ S5 lineGridOffPushDue: a stood night\'s OFF reports the grid loss itself, no abort does; a written night keeps its abort\'s account', () => {
  const r = running();
  assert.equal(nfc.lineGridOffPushDue(r, 'gridLoss', { gridPresent: false }), 55.55);
  assert.equal(nfc.lineGridOffPushDue(written(), 'gridLoss', { gridPresent: false }), null, 'the abort\'s own account goes');
  assert.equal(nfc.lineGridOffPushDue(written(), 'gridLoss', { gridPresent: true }), 55.55, 'a gridSta reading alone');
  assert.equal(nfc.lineGridOffPushDue(r, 'windowEnd', { gridPresent: false }), null);
});

test('★★ S5 what a stamp does not change: armOpenItem, the arbitrage posture, the owner\'s floor, the restore summary', () => {
  const s = stood();
  assert.equal(act.armOpenItem(s, 50), null, 'it holds nothing on the device');
  assert.equal(act.armOpenItem(running(), 50) != null, true, 'an ON whose OFF has not verified does');
  assert.equal(act.isReserveArbitrageRaised(s), false);
  assert.equal(act.ownerReserveFloorPct(s, 50, OPEN + H), 50, 'the panel\'s own');
  assert.equal(act.restoreSummaryDue(s, CLOSE + H), null);
  assert.equal(act.chargeWriteHold(s), null);
});

/* ══ S6 — the OFF and the ceiling ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ S6 every OFF of a stood ride reads no write', () => {
  const on = { slotsOn: [1, 2, 3] };
  const off = (s: Rec, t: number, o: Partial<ForceChargeOpts> = {}) => dfc(s, t, { ...on, ...o });
  assert.deepEqual(off(running(), CLOSE), { kind: 'off', slots: [1, 2, 3], reason: 'windowEnd' });
  assert.deepEqual(off(running({ nextOnPeakStartMs: CLOSE - 30 * M }), CLOSE - 90 * M), { kind: 'off', slots: [1, 2, 3], reason: 'onPeakGuard' });
  assert.deepEqual(off(running({ cancelled: true }), CLOSE - H), { kind: 'off', slots: [1, 2, 3], reason: 'cancelled' });
  assert.deepEqual(off(running({ foreignSettledAtMs: CLOSE - H }), CLOSE - H + M), { kind: 'off', slots: [1, 2, 3], reason: 'foreign' });
  assert.deepEqual(off(running(), CLOSE - H, { gridPresent: false }), { kind: 'off', slots: [1, 2, 3], reason: 'gridLoss' });
  assert.deepEqual(off(running(), CLOSE - H, { gridStaLost: true }), { kind: 'off', slots: [1, 2, 3], reason: 'gridLoss' });
  assert.deepEqual(off(running(), CLOSE - H, { lineEnabled: false }), { kind: 'off', slots: [1, 2, 3], reason: 'disabled' });
  assert.deepEqual(off(running({ forceChargeOnAtMs: CLOSE - 8 * H, forceChargeOnVerifiedAtMs: CLOSE - 8 * H + M }), CLOSE - H), { kind: 'off', slots: [1, 2, 3], reason: 'maxRun' });
  assert.deepEqual(nfc.actuationStepOrder(running(), CLOSE), ['forceCharge', 'reserve'], 'the OFF first');
});

test('★★★ S6 the ceiling comes back: after an OFF, and on a night that never switched on; the reserve step has nothing to do at the close', () => {
  const done = running({ forceChargeOffAtMs: CLOSE, forceChargeOffVerifiedAtMs: CLOSE + M, forceChargeCeilingPriorPct: 100, forceChargeOffReason: 'windowEnd' });
  assert.deepEqual(dfc(done, CLOSE + 2 * M, { ceilingReadbackPct: 66 }), { kind: 'restoreCeiling', pct: 100, lastAttempt: false });
  assert.deepEqual(dfc(stood({ forceChargeCeilingPriorPct: 100 }), CLOSE, { ceilingReadbackPct: 66 }), { kind: 'restoreCeiling', pct: 100, lastAttempt: false });
  assert.deepEqual(dac(done, CLOSE + 2 * M), { kind: 'none' });
});

test('★★★ S6 no revert action, ever: across a whole night of readings, on every stood shape', () => {
  const kinds = new Set<string>();
  const shapes = [stood(), running(), stood({ cancelled: true }), running({ cancelled: true }), stood({ foreignSettledAtMs: OPEN + H }), stood({ gridLostAtMs: OPEN + H })];
  for (const s of shapes) for (let t = OPEN; t <= CLOSE + 2 * H; t += 5 * M) for (const reading of [10, 16, 45, 49, 50, 0, null]) for (const g of [true, false, null]) {
    kinds.add(act.decideActuation(s, t, ao({ currentReservePct: reading, gridPresent: g })).kind);
  }
  assert.deepEqual([...kinds].sort(), ['foreignCleared', 'foreignSeen', 'foreignSettled', 'gridLost', 'none'].filter((k) => k === 'none' || kinds.has(k)).sort());
  for (const k of ['apply', 'revert', 'retryRevert', 'retryApply', 'adopt', 'applyVerified', 'revertVerified', 'ceilingMoved']) assert.equal(kinds.has(k), false, k);
  const r = stood();
  assert.deepEqual([r.appliedAtMs, r.applyVerifiedAtMs, r.priorReservePct, r.revertedAtMs], [null, null, null, null]);
});

/* ══ S7 — the texts ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

const TAIL = 'A reading under 50% when the window opens lets the armed write go, the force-charge rides it, and that reading is restored after the window. Cancel from the night-charge card on the panel.';

test('★★★ S7 the evening push of a night that stands: true whether the reading stays, falls before the open, or moves after it', () => {
  const p = planAt(50);
  const body = notify.buildNightChargeMessage(p as never, 'charge', lineSup(p) as never).body;
  assert.ok(body.includes('SUPERVISED: the backup reserve reads 50% now, so no write is due while it does. '), body);
  assert.ok(body.endsWith(TAIL), body);
  assert.doesNotMatch(body, /raises the backup reserve|auto-restores|returns to|as usual|stays at 50|before then|before at/, body);
  assert.ok(body.includes('No restore is due while the reserve reads 50%.'), body);
  assert.match(body, /the add-on switches the panel's force-charge ON/, 'names the add-on: "it" would read as the reserve');
  // No force-charge line beside it (a record the gates do not ride): the words hold.
  const none = notify.buildNightChargeMessage(p as never, 'charge', SUP as never).body;
  assert.ok(none.includes(`so no write is due while it does. ${TAIL}`), none);
});

test('★★★ S7 the evening push: a cost-dominant night that stands names the add-on and no raise; a written night keeps its words, "it" included', () => {
  const p = { ...planAt(50), expectedForceChargeMode: undefined, expectedForceChargeStartMs: planAt(50).window!.endMs - 2 * H } as P;
  const body = notify.buildNightChargeMessage(p as never, 'charge', { ...SUP, forceChargeTargetPct: 80 } as never).body;
  assert.match(body, /the add-on switches the panel's force-charge ON just long enough to reach/, body);
  assert.doesNotMatch(body, /raises the backup reserve/, body);
  const q = planAt(49);
  const w = notify.buildNightChargeMessage(q as never, 'charge', lineSup(q) as never).body;
  assert.ok(w.includes('SUPERVISED: at 11:00 PM the add-on raises the backup reserve to 50%'), w);
  assert.ok(w.includes('After the window the reserve returns to 49% and the house uses the pool as usual.'), w);
  assert.match(w, /, it switches the panel's force-charge ON/, w);
  assert.doesNotMatch(w, /No restore is due/, w);
  const held = notify.buildNightChargeMessage({ ...p, expectedForceChargeStartMs: null } as never, 'charge', { ...SUP, forceChargeTargetPct: 80 } as never).body;
  assert.match(held, /The add-on also arms the panel's force-charge toward/, held);
});

test('★★★ S7 the Cancel sentence of a reading above the write: the real text, never "before at 11:00 PM", in either deadline phrase', () => {
  const p = planAt(51);
  for (const cancelDeadlineText of ['at 11:00 PM', 'on Sunday at 11:55 PM']) {
    const body = notify.buildNightChargeMessage(p as never, 'charge', { ...SUP, cancelDeadlineText } as never).body;
    assert.ok(body.endsWith('Cancel from the night-charge card on the panel before the window opens.'), body);
    assert.doesNotMatch(body, /before at|before on/, body);
  }
});

test('★★★ S7 the close of a stood night: what ran, the close against the line, no restore; its panel-stop, re-ON and late words are the written night\'s', () => {
  const sum = (o: Record<string, unknown>) => notify.buildNightChargeMorningSummary({ day: '2027-01-04', targetPct: 50, restorePct: 50, expectedKwh: 12.3, standing: true, linePct: 55.55, ...o } as never);
  const ran = { kind: 'ran', stopPct: null, expectedLeg: true, line: { askPct: 56, linePct: 55.55, offReason: 'windowEnd', offAtMs: CLOSE } };
  const a = sum({ forceCharge: ran, closePoolPct: 80 });
  assert.equal(a.title, 'Night-charge: reserve stood at 50%');
  assert.equal(a.body, "Supervised night charge for 2027-01-04 completed: the reserve stood at 50%, and force-charge ran to the window close for the 55.55% outage line; the pool read 80% at the close (~12.3 kWh expected); no restore was due. Delivery vs plan scores in the ledger at tomorrow evening's update.".replace('55.55%', '55.6%'));
  assert.doesNotMatch(a.body, /restored|raised|restore to/);
  const under = sum({ forceCharge: ran, closePoolPct: 52 });
  assert.ok(under.body.includes('the pool read 52% at the close, under the 55.6% outage line'), under.body);
  assert.ok(sum({ forceCharge: ran, closePoolPct: null }).body.includes('the pool was not read at the close (no fresh panel reading)'));
  assert.ok(sum({ forceCharge: ran, closePoolPct: 80, closeReadLate: true }).body.includes('the pool reads 80% now, past the window close'));
  const stop = sum({ forceCharge: { ...ran, line: { ...ran.line, panelOffAtMs: CLOSE - H, reOns: 1, lastReOnAtMs: CLOSE - 30 * M, lastReOnApplied: true, reOnAppliedAtMs: CLOSE - 30 * M } }, closePoolPct: 80 });
  assert.ok(stop.body.includes("switched back on 1 time(s) after the panel's own stop"), stop.body);
  const stopped = sum({ forceCharge: { ...ran, line: { ...ran.line, panelOffAtMs: CLOSE - H } }, closePoolPct: 80 });
  assert.ok(stopped.body.includes("until the panel's own stop switched Charge Now off"), stopped.body);
  const never = sum({ forceCharge: { kind: 'neverStarted', stopPct: null, expectedLeg: true, line: { askPct: 56, linePct: 55.55 } }, closePoolPct: 52 });
  assert.ok(never.body.includes('the reserve stood at 50%; force-charge for the 55.6% outage line never started; the pool read 52% at the close, under the 55.6% outage line; no restore was due.'), never.body);
  const lost = sum({ forceCharge: { kind: 'neverStarted', stopPct: null, expectedLeg: true, line: { askPct: 56, linePct: 55.55 } }, closePoolPct: 52, gridLost: true });
  assert.ok(lost.body.includes('never started (the grid was lost during the window)'), lost.body);
  const none = sum({ forceCharge: { kind: 'none', expectedLeg: false }, closePoolPct: 52 });
  assert.ok(none.body.startsWith('Supervised night charge for 2027-01-04 completed: the reserve stood at 50%; no restore was due.'), none.body);
  // A written night keeps its words.
  const w = notify.buildNightChargeMorningSummary({ day: '2027-01-04', targetPct: 50, restorePct: 30, expectedKwh: 12.3, linePct: 55.55, forceCharge: ran, closePoolPct: 80 } as never);
  assert.ok(w.body.includes('reserve raised to 50%') && w.body.includes('the reserve is restored to 30%.'), w.body);
  assert.equal(w.title, 'Night-charge: reserve restored to 30%');
});

test('★★★ S7 the foreign push of a stood night: what it reads against what it read, no restore clause, nothing of who changed it', () => {
  const m = notify.buildNightChargeForeignReserve({ day: '2027-01-04', pct: 40, targetPct: 50, restorePct: null, line: { linePct: 55.55, started: false, closeText: '5:00 AM' }, standing: true } as never);
  assert.equal(m.severity, 'warning');
  assert.equal(m.title, 'Night-charge: the reserve now reads 40%');
  assert.doesNotMatch(`${m.title} ${m.body}`, /outside the add-on|restore|—%/, m.body);
  assert.ok(m.body.includes("The backup reserve reads 40%, not the 50% it read in the 2027-01-04 night charge's apply window, on two readings five or more minutes apart."), m.body);
  assert.ok(m.body.includes("No force-charge for tonight's 55.6% outage line starts: the reserve was changed, and setting it back does not change that."), m.body);
  const on = notify.buildNightChargeForeignReserve({ day: '2027-01-04', pct: 40, targetPct: 50, restorePct: null, line: { linePct: 55.55, started: true, closeText: '5:00 AM' }, standing: true } as never);
  assert.ok(on.body.includes('rode that reading, so the add-on switches it off'), on.body);
  const late = notify.buildNightChargeForeignReserve({ day: '2027-01-04', pct: 40, targetPct: 50, restorePct: null, line: null, standing: true } as never);
  assert.equal(late.severity, 'info');
  // A written night keeps its words.
  const w = notify.buildNightChargeForeignReserve({ day: '2027-01-04', pct: 40, targetPct: 50, restorePct: 30, line: null });
  assert.equal(w.title, 'Night-charge: reserve set to 40% outside the add-on');
});

test('★★ S7 the foreign close account of a stood night says what happened, and nothing of who', () => {
  const m = notify.buildLineNightCloseAccount({ day: '2027-01-04', linePct: 55.55, cause: 'foreign', closePoolPct: 52, standing: true } as never);
  assert.ok(m.body.startsWith("Supervised night charge for 2027-01-04: the reserve was changed after it read the night's target, so no force-charge ran"), m.body);
  const ran = notify.buildLineNightCloseAccount({ day: '2027-01-04', linePct: 55.55, cause: 'foreign', closePoolPct: 52, onAtMs: CLOSE - 2 * H, offAtMs: CLOSE - H, offReason: 'foreign', standing: true } as never);
  assert.doesNotMatch(ran.body, /outside the add-on/, ran.body);
  assert.ok(ran.body.includes('(switched off: the reserve was changed)'), ran.body);
  const w = notify.buildLineNightCloseAccount({ day: '2027-01-04', linePct: 55.55, cause: 'foreign', closePoolPct: 52 });
  assert.ok(w.body.includes('the reserve was set outside the add-on'), w.body);
});

test('★★★ S7 the card\'s footer holds on both kinds of night, on both shapes that render it: a bounded write only under the target, none and no restore at it', () => {
  const src = SRC('../../web/src/cards/NightChargeCard.tsx');
  const note = src.slice(src.indexOf('function AdvisoryNote('), src.indexOf('Advisory only — this add-on'));
  const flat = note.replace(/\s+/g, ' ');
  assert.ok(flat.includes("{mode === 'auto' ? 'Auto' : 'Supervised'} write mode — on a charge night the add-on performs at most one bounded reserve write, only when the reserve reads under the night's target (announced each evening, cancellable above), and auto-restores the prior reserve after it. A reserve that already reads the target gets no write and no restore."), flat);
  assert.ok(flat.includes('The reserve-floor alarms are independent of this path.'), flat);
  assert.doesNotMatch(flat, /on charge nights|performs one/, flat);
  assert.equal(src.split('<AdvisoryNote mode={status.mode} />').length - 1, 2, 'the charge shape and the hold shape');
});

test('★★★ S7 the card\'s reserve label reads plan.lineReserveStands: no write sets a standing reserve, and a written night keeps its words', () => {
  const label = cardText.reserveWriteLabel as unknown as (s: number | null, p: number | null, m: number | null, stands?: boolean) => string | null;
  assert.equal(label(66, 50, 50, true), "reserve reads 50% (the panel's maximum; 66% needed)");
  assert.equal(label(66, 50, 50, false), "reserve set to 50% (the panel's maximum; 66% needed)");
  assert.equal(label(66, 50, 50), "reserve set to 50% (the panel's maximum; 66% needed)", 'the fourth argument is optional');
  assert.equal(label(50, 40, 50, true), 'reserve reads 50%');
  assert.equal(label(50, 40, 50), 'reserve set to 50%');
  assert.equal(label(40, 40, 50, true), null, 'nothing to say');
  const src = SRC('../../web/src/cards/NightChargeCard.tsx');
  assert.ok(src.includes('reserveWriteLabel(plan.setpointSocPct, plan.targetSocPct, status.reserveWriteMaxPct ?? null, plan.lineReserveStands === true)'), 'the card passes it');
  assert.ok(src.includes('lineReserveStands?: boolean;'), 'and its plan carries it');
});

test('★★★ S7 the grid-loss push: no force-charge starts tonight, whatever the grid does next; what a person can do; an OFF keeps its words', () => {
  const none = notify.buildLineForceChargeGridOff({ linePct: 55.55, poolPct: 52, closeText: '5:00 AM', noneOn: true } as never);
  assert.equal(none.severity, 'warning');
  assert.equal(none.title, 'Night-charge: no force-charge for the outage line starts tonight');
  assert.equal(none.body, "The grid read as lost during the window, so no force-charge for tonight's 55.6% outage line starts, whatever the grid does next. The pool reads 52%, under the 55.6% outage line. Charge Now switched on by hand in the EcoFlow app can still lift the pool with the grid present; switch it off again by ~5:00 AM.");
  const off = notify.buildLineForceChargeGridOff({ linePct: 55.55, poolPct: 52, closeText: '5:00 AM' });
  assert.equal(off.title, 'Night-charge: the force-charge for the outage line stopped');
  assert.ok(off.body.startsWith("The panel read the grid as lost, so the add-on switched off the force-charge for tonight's 55.6% outage line; it does not start again tonight. "), off.body);
});

test('★★★ S7 the banner and the card: the reserve stands, no write and nothing to restore, Cancel to the close; every shape words the stamp', () => {
  const card = (o: Record<string, unknown> = {}) => ({ day: '2027-01-04', targetPct: 50, priorReservePct: null, appliedAtMs: null, revertedAtMs: null, foreignSettledAtMs: null, foreignReservePct: null, cancelled: false, windowEndMs: CLOSE, cancelDeadlineMs: OPEN, reserveStandingAtMs: OPEN, ...o });
  assert.deepEqual(banner(card(), '23:00', 50), { text: 'The reserve stands at 50%: no write and nothing to restore.', settled: false, cancel: 'Cancel tonight' });
  assert.equal(cardText.writeStands(card() as never, 'supervised', OPEN + H), true, 'a recompute holding does not disarm it');
  const closed = { lineStartClosed: { text: 'No force-charge for the 55.6% outage line starts: the window has closed.', cancel: false } };
  assert.deepEqual(banner(card(closed), '23:00', 50), { text: closed.lineStartClosed.text, settled: false, cancel: null }, 'a closed start says so first');
  assert.equal(cardText.writeStands(card(closed) as never, 'supervised', CLOSE), false);
  assert.deepEqual(banner(card({ cancelled: true }), '23:00', 50), { text: "Cancelled — no reserve write to undo; any force-charge of tonight's switches off within a minute.", settled: true, cancel: null });
  assert.deepEqual(banner(card({ foreignSettledAtMs: OPEN + H, foreignReservePct: 40 }), '23:00', 40), { text: "The reserve was changed to 40% after it read the night's target — no force-charge runs on it tonight.", settled: true, cancel: null });
  const ct = cardText as unknown as { noPlanText: (b: boolean, s: boolean, r?: boolean) => string; holdSummary: (p: unknown, o: unknown) => { headline: string; detail: string }; cancelOutcome: (s: number, b: unknown) => { text: string }; RESERVE_STOOD_HEADLINE: string };
  assert.ok(ct.noPlanText(false, true, true).endsWith('The night armed on the standing reserve can be cancelled below.'));
  assert.ok(ct.noPlanText(true, true, true).endsWith('The night armed on the standing reserve can be cancelled below.'));
  assert.doesNotMatch(ct.noPlanText(false, true, true), /rides/, 'true with the ride over: the banner beneath says why');
  assert.ok(ct.noPlanText(false, true).endsWith('The write armed with the announced plan stands; cancel it below.'), 'a written night');
  const hold = ct.holdSummary({ requiredExtraKwh: null, reserveFloorPct: 50 }, { writeStands: true, reserveStood: true });
  assert.equal(hold.headline, 'The latest recompute would not charge — the night armed on the standing reserve stands.');
  assert.doesNotMatch(hold.detail, /write armed/, hold.detail);
  assert.equal(ct.holdSummary({ requiredExtraKwh: null, reserveFloorPct: 50 }, { writeStands: true }).headline, 'The latest recompute would not charge — the armed write stands.');
  assert.equal(ct.cancelOutcome(200, { actuation: { appliedAtMs: null, reserveStandingAtMs: OPEN } }).text, "Cancelled — no reserve write to undo; any force-charge of tonight's switches off within a minute.");
  assert.equal(ct.cancelOutcome(200, { actuation: { appliedAtMs: null, reserveStandingAtMs: null } }).text, 'Cancelled — no write tonight.');
});

test('★★ S7 the card does not name a cost night as stood: a record with no stamp keeps every word', () => {
  const a = { day: '2027-01-04', targetPct: 50, priorReservePct: null, appliedAtMs: null, revertedAtMs: null, foreignSettledAtMs: null, foreignReservePct: null, cancelled: false, windowEndMs: CLOSE, cancelDeadlineMs: OPEN };
  assert.equal(banner(a, '23:00', 45).text, 'Supervised write armed — reserve → 50% at 23:00.');
  assert.equal(banner(a, '23:00', 50).text, 'Supervised write armed for 23:00 — the reserve reads 50%, so none is due while it does.');
  assert.equal(banner({ ...a, cancelled: true }, '23:00', 50).text, 'Cancelled — no write tonight.');
  assert.equal(banner({ ...a, foreignSettledAtMs: OPEN + H, foreignReservePct: 40 }, '23:00', 40).text, "The reserve was set to 40% outside the add-on — tonight's write no longer holds it.");
});

test('★★ S7 the cancel refused on a stood night that settled names neither the app nor a write; on any other night it keeps its words', () => {
  const c = (s: Rec) => cyc.cancelLeg({ active: leg(s), pendingLegs: [], trailing: null } as never, null) as { ok: boolean; error?: string };
  assert.deepEqual(c(stood({ foreignSettledAtMs: OPEN + H, foreignReservePct: 40 })), { ok: false, error: 'the reserve was changed to 40% after it read the night’s target; nothing of tonight’s is left to cancel' });
  assert.deepEqual(c(armed({ foreignSettledAtMs: OPEN + H, foreignReservePct: 40 })), { ok: false, error: 'the reserve was set to 40% outside the add-on; nothing of tonight’s write is left to cancel' });
});

/* ══ S8 — the gate ═════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 17, 4, 30);
const ago = (d: number): string => gate.phoenixYmd(NOW - d * DAY);
const STOOD = (): string => `${(gate as unknown as { RESERVE_STOOD_DISPOSITION: string }).RESERVE_STOOD_DISPOSITION}the panel read the 50% target in the apply window; no write was due`;
const led = (n: number, mut?: (r: Record<string, unknown>, i: number) => void) => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const d = n - i;
    const inBand = i % 20 < 17 ? 1 : 0;
    const r: Record<string, unknown> = {
      plan_date: ago(d), algo_version: gate.CURRENT_ALGO_VERSION, issued_at_ms: NOW - d * DAY, confidence_tier: 'forecast', outcome_captured_at_ms: NOW - (d - 1) * DAY,
      scored: 1, actuated: 1, actuation_applied_at_ms: NOW - d * DAY, cushion_shortfall: 0, plan_traj_floor_breached: 0, cushion_breached: 0, buy_err_kwh: 0.5,
      pv_err_frac: i % 2 ? 0.05 : -0.05, load_err_frac: i % 2 ? 0.05 : -0.05, pv_in_band: inBand, load_in_band: inBand, grid_home_coverage_frac: 0.95,
    };
    mut?.(r, i);
    rows.push(r);
  }
  return rows;
};
const stoodRow = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  plan_date: ago(3), algo_version: gate.CURRENT_ALGO_VERSION, issued_at_ms: NOW - 3 * DAY, confidence_tier: 'forecast', outcome_captured_at_ms: NOW - 2 * DAY,
  scored: 1, actuated: null, actuation_applied_at_ms: null, cushion_shortfall: 0, cushion_breached: 1, buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: 0.05, pv_in_band: 1, load_in_band: 1,
  reserve_floor_pct: 50, cushion_pct: 13.2, cushion_line_soc_pct: 65.3, cushion_line_force_charge_pct: 66, window_close_soc_pct: 51.5, actual_min_soc_pct: 50, force_charge_on_at_ms: null,
  arm_disposition: STOOD(), ...o,
});
const read = (rows: Array<Record<string, unknown>>) => gate.computeNightChargeReadiness(rows as never, NOW);
const without3 = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.plan_date !== ago(3));

test('★★★ S8 a claimed stood night that closes under is struck, ON or not; one that holds is not', () => {
  const base = without3(led(30));
  assert.equal(read([...base, stoodRow()]).metrics.activeStrikes, 1, 'never ran');
  assert.equal(read([...base, stoodRow({ force_charge_on_at_ms: NOW - 3 * DAY })]).metrics.activeStrikes, 1, 'a ride that ran: the realized strike');
  assert.equal(read([...base, stoodRow({ cushion_breached: 0, window_close_soc_pct: 70, actual_min_soc_pct: 60 })]).metrics.activeStrikes, 0, 'held');
  assert.equal(read([...base, stoodRow()]).metrics.lineForceChargeStrikes, 1);
});

test('★★★ S8 the disposition grades a line night alone: with no ask on the plan row it is no evidence of anything', () => {
  const base = without3(led(30));
  assert.equal(read([...base, stoodRow({ cushion_line_force_charge_pct: null })]).metrics.activeStrikes, 0, 'no ask on the row');
  assert.equal(read([...base, stoodRow({ cushion_line_force_charge_pct: null, cushion_shortfall: 1 })]).metrics.activeStrikes, 0);
  assert.equal(read([stoodRow({ cushion_shortfall: 1, cushion_line_force_charge_pct: null })]).metrics.strikesMeasurable, 0, 'no line row: nothing to measure');
  assert.equal(read([stoodRow({ cushion_shortfall: 1 })]).metrics.strikesMeasurable, 1, 'a stood line row can strike, though disclosed');
});

test('★★★ S8 a disclosed stood night is struck only if it never ran and closed under; a ride that ran is physics, as a written night is', () => {
  const base = without3(led(30));
  assert.equal(read([...base, stoodRow({ cushion_shortfall: 1 })]).metrics.activeStrikes, 1, 'armed, never ran, closed under');
  assert.equal(read([...base, stoodRow({ cushion_shortfall: 1, force_charge_on_at_ms: NOW - 3 * DAY })]).metrics.activeStrikes, 0, 'ran: disclosed');
  assert.equal(read([...base, stoodRow({ cushion_shortfall: 1, window_close_soc_pct: 70 })]).metrics.activeStrikes, 0, 'held');
});

test('★★★ S8 a person\'s cancel is no strike: the route rewrites the disposition on a record with no ON (c3)', () => {
  const cancelled = stoodRow({ arm_disposition: 'cancelled by a person; the reserve stood at the target and no force-charge had started' });
  assert.equal(read([...without3(led(30)), cancelled]).metrics.activeStrikes, 0);
  assert.equal(read([...without3(led(30)), { ...cancelled, cushion_shortfall: 1 }]).metrics.activeStrikes, 0, 'disclosed');
});

test('★★★ S8 a standing plant gives no graduation or streak evidence: 30 stood nights stay LEARNING, and clear no strike (c3)', () => {
  const stoodOnly = (r: Record<string, unknown>): void => { r.actuated = null; r.actuation_applied_at_ms = null; r.cushion_line_force_charge_pct = 66; r.cushion_line_soc_pct = 65.3; r.window_close_soc_pct = 80; r.arm_disposition = STOOD(); };
  const all = read(led(30, stoodOnly));
  assert.notEqual(all.state, 'READY_TO_CONSIDER_WRITES');
  assert.equal(all.writeReady, false);
  assert.equal(all.metrics.scoredDays, 0, 'no write landed');
  // A real strike 20 days ago, then stood nights only: the streak does not run, the strike does not clear.
  const strike = { plan_date: ago(20), algo_version: gate.CURRENT_ALGO_VERSION, issued_at_ms: NOW - 20 * DAY, confidence_tier: 'forecast', outcome_captured_at_ms: NOW - 19 * DAY, scored: 1, actuated: 1, actuation_applied_at_ms: NOW - 20 * DAY, cushion_shortfall: 0, cushion_breached: 1, buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: 0.05, pv_in_band: 1, load_in_band: 1 };
  const after = read([...led(40, stoodOnly).filter((r) => r.plan_date !== ago(20)), strike]);
  assert.equal(after.metrics.strikeFreeStreak, 0);
  assert.equal(after.metrics.strikesCleared, 0);
  assert.equal(after.metrics.activeStrikes, 1);
  assert.equal(all.metrics.strikesMeasurable, 1, 'a stood night can strike, so a 0 is a measured 0');
});

test('★★★ S8 the stood rows stay off the buy de-bias: it reads actuated rows alone', () => {
  // nightChargeAdvisor's learner filters r.actuated === 1: pinned on the source, with the disposition never stamping it.
  const src = SRC('../src/nightChargeAdvisor.ts');
  assert.ok(src.includes('return r.actuated === 1 &&\n        r.scored === 1 &&'), 'the learner\'s filter');
  const at = INDEX.indexOf("if (action.kind === 'reserveStanding') {");
  const branch = INDEX.slice(at, INDEX.indexOf("if (action.kind === 'gridLost') {", at));
  assert.ok(at > 0 && !branch.includes('actuated:'), 'the stamp writes no `actuated`');
});

test('★★★ S8 a lowered night can be struck at a line its reserve never asked: stated in 15-2 and pinned, with no exemption', () => {
  // 50 at the plan, lowered to 16: the write goes (actuated 1), the night rides the floor-50 line of 76.8, and closes 74, far above the 42.8 its own reserve would ask.
  const lowered = { ...stoodRow(), actuated: 1, actuation_applied_at_ms: NOW - 3 * DAY, arm_disposition: null, cushion_line_soc_pct: 76.8, cushion_line_force_charge_pct: 77, window_close_soc_pct: 74, force_charge_on_at_ms: NOW - 3 * DAY };
  assert.equal(read([...without3(led(30)), lowered]).metrics.activeStrikes, 1);
});

/* ══ S9 — the wiring ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

const reserveTick = (): string => INDEX.slice(INDEX.indexOf('async function runNightActuationTickInner()'), INDEX.indexOf('// action.kind === \'revert\''));

test('★★★ S9 the reserve step: the stamp under the write block, the disposition, no write; the grid-loss stamp once, its push when no OFF will send one', () => {
  const t = reserveTick();
  const stamp = t.slice(t.indexOf("if (action.kind === 'reserveStanding') {"), t.indexOf("if (action.kind === 'gridLost') {"));
  assert.ok(stamp.includes('const blocked = multiPanelWriteBlock();\n    if (blocked) { app.log.warn(`night-charge: reserve stand refused — ${blocked}`); return; }\n    persistNightActuation({ ...state, reserveStandingAtMs: nowMs, lastError: null });'), stamp);
  assert.ok(stamp.includes('stampLegOutcome(state, { arm_disposition: `${RESERVE_STOOD_DISPOSITION}'), stamp);
  assert.doesNotMatch(stamp, /setBackupReserveSoc|appliedAtMs:|priorReservePct:/);
  const lost = t.slice(t.indexOf("if (action.kind === 'gridLost') {"), t.indexOf("if (action.kind === 'apply') {"));
  assert.ok(lost.includes('persistNightActuation({ ...state, gridLostAtMs: nowMs, lastError: null });'), lost);
  assert.ok(lost.includes('(state.forceChargeOnAtMs == null || state.forceChargeOffAtMs != null)'), lost);
  assert.ok(lost.includes('buildLineForceChargeGridOff({ linePct: lostLinePct, poolPct: freshPoolSocPct(nowMs), closeText: fmtSiteClock(closeAtMs), noneOn: true })'), lost);
  assert.doesNotMatch(lost, /setBackupReserveSoc|multiPanelWriteBlock/);
});

test('★★★ S9 the force-charge step reads the reserve from the same fresh `sp` as the slots, and its "why not" log rides the stamp', () => {
  assert.ok(INDEX.includes("reservePct: typeof sp?.backupReserveSoc === 'number' ? sp.backupReserveSoc : null,\n    connectedSlots,"));
  assert.ok(INDEX.includes('const live = (state.appliedAtMs != null || reserveRideReady(state)) && state.revertedAtMs == null && !state.cancelled'));
});

test('★★★ S9 the close: a stood night goes to the morning summary with `standing`, never the close account; the foreign one tells the stamp', () => {
  const fn = INDEX.slice(INDEX.indexOf('function runLineCloseAccountStep(): void {'), INDEX.indexOf(' * R5 (v1.189.0) — THE LIVE MORNING REFRESH'));
  const stoodAt = fn.indexOf("if (due === 'standing') {");
  assert.ok(stoodAt > 0 && stoodAt < fn.indexOf('buildLineNightCloseAccount({'), fn);
  const s = fn.slice(stoodAt, fn.indexOf('buildLineNightCloseAccount({'));
  assert.ok(s.includes('const stoodClose = buildNightChargeMorningSummary({'), s);
  assert.ok(s.includes('standing: true, gridLost: state.gridLostAtMs != null,'), s);
  assert.ok(s.includes('closeReadLate: lineCloseReadingLate(state, nowMs)'), s);
  assert.ok(fn.includes('standing: state.reserveStandingAtMs != null,'), fn);
});

test('★★★ S9 the ledger: a stood row is measured, never actuated; a verify after applyFailed stamps actuated, keyed on the escalation', () => {
  assert.ok(INDEX.includes("const measuredDelivery = wasActuated || String(y.arm_disposition ?? '').startsWith(RESERVE_STOOD_DISPOSITION);"));
  assert.ok(INDEX.includes('    row: y,\n    actuated: measuredDelivery,'), 'delivered_kwh is measured');
  assert.ok(INDEX.includes("`${measuredDelivery ? `; delivered ~${deliveredKwh ?? '?'} kWh"), 'not "advisory night"');
  assert.ok(INDEX.includes('    windowOpenSocPct,\n    actuated: measuredDelivery,'));
  const t = reserveTick();
  const verified = t.slice(t.indexOf("if (action.kind === 'applyVerified') {"), t.indexOf("if (action.kind === 'applyCeiling') {"));
  assert.ok(verified.includes('if (state.applyEscalated) stampLegOutcome(state, { actuated: 1 });'), verified);
  const ceiling = t.slice(t.indexOf("if (action.kind === 'applyCeiling') {"), t.indexOf("if (action.kind === 'ceilingMoved') {"));
  assert.ok(ceiling.includes('if (state.applyEscalated) stampLegOutcome(state, { actuated: 1 });'), ceiling);
});

test('★★★ S9 a late verify on the record: the gate sees a real night again, and a normal night writes nothing new', () => {
  // A line night whose late-verified write carried an ON and closed under.
  const row = { ...stoodRow(), arm_disposition: null, actuated: 0, actuation_applied_at_ms: NOW - 3 * DAY, force_charge_on_at_ms: NOW - 3 * DAY };
  assert.equal(read([...without3(led(30)), row]).metrics.activeStrikes, 0, 'as stamped by applyFailed');
  assert.equal(read([...without3(led(30)), { ...row, actuated: 1 }]).metrics.activeStrikes, 1, 'as the late verify stamps it');
});

test('★★★ S9 the cancel route: the disposition goes on a stood record with no ON, before the close only', () => {
  const route = INDEX.slice(INDEX.indexOf("app.post('/api/night-charge/cancel'"), INDEX.indexOf('// v1.184.0 — the operator\'s "the grid is back"'));
  assert.ok(route.includes('s.forceChargeOnAtMs == null && (cancelledCloseMs == null || Date.now() < cancelledCloseMs)) {'), route);
  assert.ok(route.includes("stampLegOutcome(s, { arm_disposition: 'cancelled by a person; the reserve stood at the target and no force-charge had started' });"), route);
  assert.equal('cancelled by a person; the reserve stood at the target and no force-charge had started'.startsWith(STOOD_PREFIX), false, 'it leaves the gate\'s prefix');
  assert.equal((gate as unknown as { RESERVE_STOOD_DISPOSITION: string }).RESERVE_STOOD_DISPOSITION, STOOD_PREFIX);
});

test('★★★ S9 the pin guard: a stood night holds the house panel to its close, or while an ON of the night is in flight', () => {
  const route = INDEX.slice(INDEX.indexOf("app.post<{ Body: { sn?: unknown } }>('/api/house-panel'"), INDEX.indexOf('store.pinHousePanel(sn);'));
  assert.ok(route.includes("forceChargeInFlight(m) || (m.reserveStandingAtMs != null && !legFinished(m, Date.now())) ? 'a night-charge force-charge is riding the house panel\\'s reserve'"), route);
});

test('★★ S9 the logs a stood night reaches word the stamp: the ARMED line, the foreign rule, the floor route', () => {
  const armedLine = INDEX.slice(INDEX.indexOf('`night-charge: supervised write ARMED for ${today}'), INDEX.indexOf('`night-charge: supervised write NOT armed for ${today}'));
  assert.ok(armedLine.includes("plan?.lineReserveStands === true ? `the reserve reads ${plan.reserveFloorPct}%, so no write is due while it does"), armedLine);
  assert.ok(INDEX.includes("if (state.reserveStandingAtMs != null) app.log.info(`night-charge: reserve reading moved"));
  assert.ok(INDEX.includes("if (state.reserveStandingAtMs != null) app.log.warn(`night-charge: reserve reading SETTLED"));
  assert.ok(INDEX.includes('line: foreignLineWords(state, nowMs), standing: state.reserveStandingAtMs != null,'));
  assert.ok(INDEX.includes("? `tonight's reserve stood at its target, so no restore is due at this window's close"));
});

/* ══ S10 — a grid read lost where the stamp would go ═══════════════════════════════════════════════════════════════

/** A record whose reading of the target, every apply guard clear, came with the grid read lost. It has no stamp, and never will. */
const lostAtStamp = (o: Partial<Rec> = {}): Rec => armed({ gridLostAtMs: OPEN, ...o });

/** One night through the real deciders, tick by tick, the grid and the reading as inputs. `log` holds every action that is not 'none'. */
const walkGrid = (rec: Rec, from: number, grid: (t: number) => boolean | null, reading: (t: number, s: Rec) => number | null = () => 50) => {
  let s = { ...rec } as Rec;
  let ceiling = 100;
  let on = false;
  const log: string[] = [];
  const at = (t: number): number => (t - OPEN) / M;
  for (let t = from; t <= CLOSE + 10 * M; t += M) {
    const r = reading(t, s);
    const g = grid(t);
    const a = act.decideActuation(s, t, ao({ currentReservePct: r, gridPresent: g }));
    if (a.kind !== 'none') log.push(`${a.kind}@${at(t)}`);
    if (a.kind === 'reserveStanding') s = { ...s, reserveStandingAtMs: t };
    else if (a.kind === 'gridLost') s = { ...s, gridLostAtMs: t };
    else if (a.kind === 'apply') s = { ...s, applyAttemptedAtMs: t, attemptBaselinePct: r, appliedAtMs: t, priorReservePct: r, applyLastAttemptMs: t };
    else if (a.kind === 'applyVerified') s = { ...s, applyVerifiedAtMs: t };
    else if (a.kind === 'revert') s = { ...s, revertedAtMs: t, revertLastAttemptMs: t };
    else if (a.kind === 'revertVerified') s = { ...s, revertVerifiedAtMs: t };
    const f = nfc.decideForceCharge(s, t, fo({ gridPresent: g, reservePct: r, ceilingReadbackPct: ceiling, slotsOn: on ? [1, 2, 3] : [], slotSocPct: { 1: 50, 2: 50, 3: 50 } }));
    if (f.kind !== 'none') log.push(`${f.kind}@${at(t)}`);
    if (f.kind === 'syncCeiling') { s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? f.prior, forceChargeCeilingSyncedPct: f.pct }; ceiling = f.pct; }
    else if (f.kind === 'on') { s = { ...s, ...nfc.forceChargeOnStamp(s, t, f.slots, G), forceChargeOnLastAttemptMs: t }; on = true; }
    else if (f.kind === 'onVerified') s = { ...s, forceChargeOnVerifiedAtMs: t };
    else if (f.kind === 'off') { s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: f.reason, forceChargeOffLastAttemptMs: t }; on = false; }
    else if (f.kind === 'offVerified') s = { ...s, forceChargeOffVerifiedAtMs: t };
    else if (f.kind === 'restoreCeiling') { s = { ...s, forceChargeCeilingRestoreAttempts: s.forceChargeCeilingRestoreAttempts + 1, forceChargeCeilingRestoreLastAttemptMs: t }; ceiling = f.pct; }
    else if (f.kind === 'ceilingRestored') s = { ...s, forceChargeCeilingRestoredAtMs: t };
  }
  return { log, s };
};
const ons = (log: string[]): string[] => log.filter((l) => /^(on|lineReOn|syncCeiling)@/.test(l));

test('★★★ S10 grid false from the open through open + 5, then true: the first tick stamps the loss; no stamp, no ceiling write, no ON, one action, ever', () => {
  const r = walkGrid(armed(), OPEN, (t) => t > OPEN + 5 * M);
  assert.deepEqual(r.log, ['gridLost@0']);
  assert.equal(r.s.reserveStandingAtMs, null);
  assert.equal(r.s.gridLostAtMs, OPEN);
  assert.equal(r.s.forceChargeOnAtMs, null);
  assert.equal(r.s.forceChargeCeilingPriorPct, null, 'no ceiling to bring back');
  assert.equal(r.s.appliedAtMs, null);
  assert.equal(r.s.priorReservePct, null);
});

test('★★★ S10 deep in the window too: false from the open to open + 29, or for the whole night, is the same one action', () => {
  assert.deepEqual(walkGrid(armed(), OPEN, (t) => t >= OPEN + 30 * M).log, ['gridLost@0']);
  assert.deepEqual(walkGrid(armed(), OPEN, () => false).log, ['gridLost@0']);
  // A reading that then drops, or comes back: nothing raises it, nothing stamps it.
  assert.deepEqual(walkGrid(armed(), OPEN, (t) => t >= OPEN + 10 * M, (t) => (t > OPEN + 5 * M ? 45 : 50)).log, ['gridLost@0']);
  assert.deepEqual(walkGrid(armed(), OPEN, (t) => t >= OPEN + 10 * M, (t) => (t === OPEN || t > OPEN + 12 * M ? 50 : null)).log, ['gridLost@0']);
});

test('★★★ S10 a loss that ends before the open still rides: the night has not begun, and the stamp reads the tick it stands on', () => {
  const r = walkGrid(armed(), OPEN - 30 * M, (t) => t >= OPEN);
  assert.equal(r.log[0], 'reserveStanding@0');
  assert.equal(r.s.gridLostAtMs, null);
  assert.ok(ons(r.log).some((l) => l.startsWith('on@')), r.log.join(' '));
  assert.ok(!r.log.includes('gridLost@0'));
});

test('★★★ S10 a stamped record is unchanged: its stamp stands, the loss is its second one-way stamp, and the ride ends there', () => {
  const r = walkGrid(armed(), OPEN, (t) => !(t >= OPEN + 2 * M && t <= OPEN + 5 * M));
  assert.equal(r.log[0], 'reserveStanding@0');
  assert.ok(r.log.includes('gridLost@2'), r.log.join(' '));
  assert.equal(r.s.reserveStandingAtMs, OPEN);
  assert.equal(r.s.gridLostAtMs, OPEN + 2 * M);
  assert.equal(r.log.filter((l) => l.startsWith('on@')).length, 0, r.log.join(' '));
  assert.equal(r.log.filter((l) => l.startsWith('gridLost@')).length, 1);
});

test('★★★ S10 a written night and a record with no ask never carry it: the same blip, as they were', () => {
  const reading = (_t: number, s: Rec): number => (s.revertedAtMs != null || s.appliedAtMs == null ? 30 : 50);
  const w = walkGrid(armed(), OPEN, (t) => t > OPEN + 5 * M, reading);
  assert.deepEqual(w.log, ['apply@0', 'revert@1', 'revertVerified@2'], 'its abort, on the first grid-false tick after the apply');
  assert.equal(w.s.gridLostAtMs, null);
  const one = walkGrid(armed(), OPEN, (t) => t > OPEN, reading);
  assert.equal(one.log.slice(0, 2).join(' '), 'apply@0 applyVerified@1', 'one false tick, on the apply\'s own: a written night reads no loss');
  assert.equal(one.s.gridLostAtMs, null);
  assert.deepEqual(walkGrid(noAsk(), OPEN, (t) => t > OPEN + 5 * M).log, []);
  assert.deepEqual(walkGrid(noAsk(), OPEN, () => false).log, []);
  assert.deepEqual(walkGrid(noAsk({ forceChargeCeilingPct: 90, forceChargeRides: true }), OPEN, (t) => t > OPEN + 5 * M).log, []);
});

test('★★★ S10 the APPLY guards read it: no stamp, no apply, whatever the reading does, the grid back', () => {
  for (const t of [OPEN + M, OPEN + 5 * M, OPEN + 30 * M]) for (const r of [50, 45, 30, 10, null]) {
    assert.deepEqual(dac(lostAtStamp(), t, { currentReservePct: r, gridPresent: true }), { kind: 'none' }, `${(t - OPEN) / M} min, reading ${r}`);
    assert.deepEqual(dac(lostAtStamp(), t, { currentReservePct: r, gridPresent: false }), { kind: 'none' }, `${(t - OPEN) / M} min, reading ${r}, still lost`);
  }
  assert.deepEqual(dac(lostAtStamp(), OPEN + M, { currentReservePct: 45, mode: 'auto', writeReady: true }), { kind: 'none' });
});

test('★★★ S10 the ride reads it: no ON and no ceiling sync, with the grid back and the reserve at the target, and its own words', () => {
  assert.equal(ride(lostAtStamp()), false);
  assert.deepEqual(dfc(lostAtStamp(), startTick, { ceilingReadbackPct: 66 }), { kind: 'none', why: 'the grid was lost during the window' });
  assert.deepEqual(dfc(lostAtStamp({ forceChargeCeilingPct: 90 }), startTick, { enabled: true, ceilingReadbackPct: 90 }), { kind: 'none', why: 'the grid was lost during the window' }, 'nor a cost ceiling');
  assert.equal(nfc.reserveWriteStands(lostAtStamp()), false);
});

test('★★★ S10 forceChargeStartClosed and the closure: the loss from its own tick, ahead of "noWrite", the clock and every later reading', () => {
  for (const t of [OPEN, OPEN + 31 * M, CLOSE - 20 * M, CLOSE, CLOSE + H]) {
    assert.equal(nfc.forceChargeStartClosed(lostAtStamp(), t, G), 'gridLost', String((t - OPEN) / M));
    assert.deepEqual(nfc.armedLineStartClosed(lostAtStamp(), t, G), { windowStartMs: OPEN, why: 'gridLost' }, 'no write stands');
  }
});

test('★★★ S10 missedApplyDue is false: its own push told the person, and "no write was issued" would give a false cause', () => {
  const armedLeg = leg(armed(), {});
  assert.equal(cyc.missedApplyDue(armedLeg, OPEN + 31 * M), true, 'no stamp, no loss: as ever');
  for (const t of [OPEN + 31 * M, OPEN + H, CLOSE, CLOSE + H]) assert.equal(cyc.missedApplyDue(leg(lostAtStamp(), {}), t), false, String((t - OPEN) / M));
});

test('★★★ S10 legFinished from its own tick, inside the apply window; legStatusState completed, no Cancel; resolved, with nothing of ours held', () => {
  for (const t of [OPEN, OPEN + 5 * M, OPEN + 31 * M, CLOSE]) {
    assert.equal(cyc.legFinished(lostAtStamp(), t), true, String((t - OPEN) / M));
    assert.equal(cyc.legStatusState(lostAtStamp(), t), 'completed', String((t - OPEN) / M));
    assert.equal(cyc.lineStartClosedStatus(lostAtStamp(), t, G).lineStartClosed?.cancel, false, String((t - OPEN) / M));
    assert.equal(cyc.legResolved(lostAtStamp(), t, 50), true, String((t - OPEN) / M));
  }
  assert.deepEqual(cyc.lineStartClosedStatus(lostAtStamp(), OPEN + M, G), { lineStartClosed: { text: 'No force-charge for the 55.6% outage line starts: the grid was lost during the window.', cancel: false } });
  assert.equal(cyc.legStatusState(lostAtStamp({ cancelled: true }), OPEN + M), 'cancelled', 'a cancel still reads as one');
  assert.equal(cyc.legStatusState(armed(), OPEN + 31 * M), 'missed', 'no loss: as ever');
  assert.equal(act.armOpenItem(lostAtStamp(), 50), null, 'the next arm is free');
});

test('★★★ S10 lineCloseAccountDue: the standing account with gridLost, never "noWrite"; a cancel is still the person\'s own', () => {
  assert.equal(nfc.lineCloseAccountDue(lostAtStamp(), CLOSE - M), null, 'before the close');
  assert.equal(nfc.lineCloseAccountDue(lostAtStamp(), CLOSE), 'standing');
  assert.equal(nfc.lineCloseAccountDue(lostAtStamp({ cancelled: true }), CLOSE), null);
  assert.equal(nfc.lineCloseAccountDue(lostAtStamp({ lineCloseAccountAtMs: CLOSE }), CLOSE + M), null, 'once');
  const m = notify.buildNightChargeMorningSummary({ day: '2027-01-04', targetPct: 50, restorePct: 50, expectedKwh: 12.3, linePct: 55.55, standing: true, gridLost: true, closePoolPct: 52, forceCharge: nfc.forceChargeNightOutcome(lostAtStamp(), G) } as never);
  assert.ok(m.body.includes('the reserve stood at 50%'), m.body);
  assert.ok(m.body.includes('never started (the grid was lost during the window)'), m.body);
  assert.ok(m.body.includes('no restore was due.'), m.body);
  assert.doesNotMatch(m.body, /no reserve write was confirmed/, m.body);
});

test('★★★ S10 priorArmSuperseded is false: the next arm leaves its disposition, which the gate grades', () => {
  assert.equal(cyc.priorArmSuperseded(armed() as never, '2027-01-05'), true, 'no stamp, no loss: superseded as ever');
  assert.equal(cyc.priorArmSuperseded(lostAtStamp() as never, '2027-01-05'), false);
  assert.equal(cyc.priorArmSuperseded(stood() as never, '2027-01-05'), false);
});

test('★★★ S10 no other push of the record: a held start has no ride to be held, and the push rides the stamp\'s tick alone', () => {
  let mem = { day: null as string | null, st: nfc.EMPTY_LINE_DECLINED_PUSH };
  const out: string[] = [];
  for (let t = OPEN + H; t <= OPEN + H + 11 * M; t += M) { const r = nfc.lineDeclinedPushTick(mem, lostAtStamp(), 'host vitals are critical — no new device writes', t, G); mem = r.mem; if (r.push != null) out.push(r.push); }
  assert.deepEqual(out, []);
  assert.equal(nfc.lineAtRiskPushDue(lostAtStamp(), OPEN + H, fo()), null);
});

test('★★★ S10 the record survives a restart: the loss on a record with no stamp reads back, one-way', () => {
  const back = act.coerceActuationState(JSON.parse(JSON.stringify(lostAtStamp()))) as Rec;
  assert.equal(back.gridLostAtMs, OPEN);
  assert.equal(back.reserveStandingAtMs, null);
  assert.deepEqual(dac(back, OPEN + M), { kind: 'none' });
});

test('★★★ S10 the handler: words true with no stamp, the one push, and a stood disposition for the gate on that record alone', () => {
  const t = reserveTick();
  const lost = t.slice(t.indexOf("if (action.kind === 'gridLost') {"), t.indexOf("if (action.kind === 'apply') {"));
  assert.ok(lost.includes('if (state.reserveStandingAtMs == null) stampLegOutcome(state, { arm_disposition: `${RESERVE_STOOD_DISPOSITION}the panel read the ${state.targetPct}% target in the apply window with the grid read lost; no write was due and no ride followed` });'), lost);
  assert.ok(lost.includes('`night-charge: GRID LOST mid-window on ${state.day}\'s stood night — the ride on the ${state.targetPct}% reserve is over for the night;'), lost);
  assert.ok(lost.includes('`night-charge: GRID LOST in the apply window of ${state.day}\'s night, with the panel reading the ${state.targetPct}% target — nothing was written and no ride follows: no force-charge starts tonight, whatever the grid does next.`'), lost);
  assert.ok(lost.includes('app.log.warn(state.reserveStandingAtMs != null\n      ? `night-charge: GRID LOST mid-window on'), 'the stood words on a stamped record alone');
  assert.ok(lost.includes('    if (lostLinePct != null && closeAtMs != null && (state.forceChargeOnAtMs == null || state.forceChargeOffAtMs != null)) {\n'), 'the push goes on a record with no ON, stamped or not');
  assert.doesNotMatch(lost, /actuated:/);
});

test('★★★ S10 the gate grades it as a stood grid loss: the stood prefix on its disposition, so a close under the line is a strike, on either shape', () => {
  const words = `${(gate as unknown as { RESERVE_STOOD_DISPOSITION: string }).RESERVE_STOOD_DISPOSITION}the panel read the 50% target in the apply window with the grid read lost; no write was due and no ride followed`;
  const base = without3(led(30));
  assert.equal(read([...base, stoodRow({ arm_disposition: words })]).metrics.activeStrikes, 1, 'no stamp: the same strike');
  assert.equal(read([...base, stoodRow()]).metrics.activeStrikes, 1, 'a stamped night that lost the grid: nothing on the row tells it apart');
  assert.equal(read([...base, stoodRow({ arm_disposition: words, cushion_breached: 0, window_close_soc_pct: 70, actual_min_soc_pct: 60 })]).metrics.activeStrikes, 0, 'held');
  assert.equal(read([...base, stoodRow({ arm_disposition: words, cushion_shortfall: 1 })]).metrics.activeStrikes, 1, 'disclosed, never ran, closed under');
  assert.equal(read(led(30, (r) => { r.actuated = null; r.actuation_applied_at_ms = null; r.arm_disposition = words; })).metrics.scoredDays, 0, 'no graduation evidence');
});

test('★★★ S10 the cancel route and the floor route read it as they read a stood record', () => {
  const route = INDEX.slice(INDEX.indexOf("app.post('/api/night-charge/cancel'"), INDEX.indexOf('// v1.184.0 — the operator\'s "the grid is back"'));
  assert.ok(route.includes('if ((s.reserveStandingAtMs != null || s.gridLostAtMs != null) && s.forceChargeOnAtMs == null && (cancelledCloseMs == null || Date.now() < cancelledCloseMs)) {'), route);
  assert.ok(INDEX.includes("nightActuationMem.reserveStandingAtMs != null || nightActuationMem.gridLostAtMs != null ? `tonight's reserve stood at its target, so no restore is due at this window's close"));
});
