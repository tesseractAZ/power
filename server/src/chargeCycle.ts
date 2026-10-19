/**
 * chargeCycle.ts — the charge cycle's record: the legs one evening arms, applied in order. PURE:
 * every clock is an argument, nothing here reads a file or writes a device.
 *
 * THE LEGS. A cycle belongs to the plan date (YYYY-MM-DD) that armed it and holds one or two legs
 * (chargeWindows.chooseChargeCycle): today's single overnight cost leg, or, in a winter mid-day
 * cycle, a resilience-only overnight BACKUP leg followed by the super off-peak COST leg. Each leg is
 * the per-night actuation record (nightChargeActuator.NightActuationState) plus what names it
 * (ChargeLegFields), so every per-night rule — one apply, one ON, the write-ahead intent, the
 * readback ladders, the on-peak guard — holds per leg. Only one leg is ACTIVE at a time: the one
 * the actuator ticks drive.
 *
 * THE FILE. One JSON object (`.night-charge-actuation.json`): the active leg at the top level, in
 * the shape every release since v1.50.0 reads, plus `pendingLegs` (legs armed and not yet active —
 * they have written nothing) and `trailing` (see below). A release from before the cycle record
 * (v1.187, v1.188) reads the top level and ignores the rest: rolled back, it still finds, reverts
 * and switches off the active leg. What it drops is a pending leg (never written: dropping it can
 * only cancel a write) and a trailing leg (only the verification of a force-charge OFF already
 * due). A file it writes back reads here as a one-leg cycle.
 *
 * PROMOTION. When the active leg is resolved (legResolved) the first pending leg becomes active.
 * One predicate gates it, built on the same open-item check that refuses an arm
 * (nightChargeActuator.armOpenItem): a leg is resolved when it is finished (cancelled, restored,
 * settled as someone else's reserve, or past its apply window with no write), holds nothing of
 * ours (armOpenItem), and its restore and force-charge OFF have read back. An unconfirmed write
 * therefore blocks promotion, and the active leg's ADOPT can still revert it; a leg still
 * unresolved when the next one's apply window passes makes that one MISSED (missedApplyDue).
 *
 * TRAILING. A backup leg is reserve-only, so a prior leg whose only open item is a force-charge
 * OFF not yet verified does not stop it arming: that leg moves to `trailing`, which keeps its OFF
 * verification, its re-sends and its ceiling restore, and the cost leg waits for it to resolve.
 *
 * With one leg — every cycle the add-on arms until the mid-day switch — the record is the per-night
 * record it always was: armCycle arms exactly what armFromPlan arms and refuses exactly what it
 * refuses, nothing is pending or trailing, and the drift attribution of the overnight leg is the
 * one it always had (legDriftActive), but for a night whose reserve settled as someone else's (the
 * foreign rule, R1): a change of their value is theirs.
 */
import {
  APPLY_LATE_MS, RESERVE_WRITE_MAX_PCT, RESERVE_WRITE_MIN_PCT,
  armFromPlan, armOpenItem, armRefusalReason, coerceActuationState, emptyActuationState, onPeakGuardActive,
  type ArmablePlan, type NightActuationState,
} from './nightChargeActuator.js';
import { forceChargeInFlight, FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS } from './nightForceCharge.js';
import type { ChargeLegRole, ChargeWindowKind } from './chargeWindows.js';

/** What names a leg, beside its per-night actuation record. */
export interface ChargeLegFields {
  /** The leg's role: the cost buy, or the resilience-only outage backup ahead of a mid-day one. */
  leg: ChargeLegRole;
  /** The tariff window it charges in. */
  windowKind: ChargeWindowKind;
  /** The level the evening announcement named — the consent ceiling a morning refresh may lower,
   *  never raise. null on a record armed before the cycle record. */
  announcedLevelPct: number | null;
  /** The expected draw the evening announcement named, kWh. */
  announcedExpectedKwh: number | null;
  /** When the morning refresh re-planned this leg (stamped before any push). */
  refreshedAtMs: number | null;
  /** When the missed-apply info push went for this leg (once). */
  missedApplyPushedAtMs: number | null;
}

/** One leg: the per-night actuation record plus its name. */
export type ChargeLegState = NightActuationState & ChargeLegFields;

/** A cycle: the active leg, the legs after it, and the prior leg still verifying its OFF. */
export interface ChargeCycleState {
  active: ChargeLegState;
  pendingLegs: ChargeLegState[];
  trailing: ChargeLegState | null;
}

/** The file's cycle version (absent on every file written before the cycle record). */
export const CYCLE_FILE_VERSION = 2;
/** At most this many pending legs are read back from a file (a cycle has at most two legs). */
export const MAX_PENDING_LEGS = 3;

/** The name a record armed before the cycle record carries: the overnight cost leg. */
export const LEGACY_LEG_FIELDS: Readonly<ChargeLegFields> = Object.freeze({
  leg: 'cost', windowKind: 'overnight',
  announcedLevelPct: null, announcedExpectedKwh: null, refreshedAtMs: null, missedApplyPushedAtMs: null,
});

export function emptyLegState(): ChargeLegState {
  return { ...emptyActuationState(), ...LEGACY_LEG_FIELDS };
}

export function emptyCycle(): ChargeCycleState {
  return { active: emptyLegState(), pendingLegs: [], trailing: null };
}

/**
 * A record with its name: `s`'s own leg fields when it has them, else `fields`, else the legacy
 * overnight cost leg. Every actuation write in index.ts spreads the active record, so its name
 * rides along; a record built fresh (emptyActuationState, armFromPlan) takes the defaults. PURE.
 */
export function asChargeLeg(s: NightActuationState & Partial<ChargeLegFields>, fields: Partial<ChargeLegFields> = {}): ChargeLegState {
  return {
    ...s,
    leg: s.leg ?? fields.leg ?? LEGACY_LEG_FIELDS.leg,
    windowKind: s.windowKind ?? fields.windowKind ?? LEGACY_LEG_FIELDS.windowKind,
    announcedLevelPct: s.announcedLevelPct !== undefined ? s.announcedLevelPct : fields.announcedLevelPct ?? null,
    announcedExpectedKwh: s.announcedExpectedKwh !== undefined ? s.announcedExpectedKwh : fields.announcedExpectedKwh ?? null,
    refreshedAtMs: s.refreshedAtMs !== undefined ? s.refreshedAtMs : fields.refreshedAtMs ?? null,
    missedApplyPushedAtMs: s.missedApplyPushedAtMs !== undefined ? s.missedApplyPushedAtMs : fields.missedApplyPushedAtMs ?? null,
  };
}

/** The leg's role from a record (a record from before the cycle record is the cost leg). PURE. */
export function legRoleOf(s: Partial<Pick<ChargeLegFields, 'leg'>>): ChargeLegRole {
  return s.leg ?? 'cost';
}

/* ── the file ─────────────────────────────────────────────────────────────── */

/**
 * One leg read back. The per-night fields go through coerceActuationState (a malformed record is
 * idle; a plausible applied write is kept). The name fails closed: no `leg` is the legacy cost
 * leg; a `leg` that is neither role reads as the backup, which never force-charges. PURE.
 */
export function coerceLegState(raw: unknown): ChargeLegState {
  const base = coerceActuationState(raw);
  const o = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const leg: ChargeLegRole = o.leg === undefined || o.leg === 'cost' ? 'cost' : 'backup';
  const windowKind: ChargeWindowKind = o.windowKind === 'super_off_peak' ? 'super_off_peak' : 'overnight';
  return {
    ...base, leg, windowKind,
    announcedLevelPct: num(o.announcedLevelPct),
    announcedExpectedKwh: num(o.announcedExpectedKwh),
    refreshedAtMs: num(o.refreshedAtMs),
    missedApplyPushedAtMs: num(o.missedApplyPushedAtMs),
  };
}

/**
 * The cycle read back from the file (restart path). PURE. The top level is the active leg — every
 * file written since v1.50.0 is a one-leg cycle. A pending leg must belong to the active leg's plan
 * date (it was armed with it); one that does not, or reads idle, is dropped — a pending leg has
 * written nothing, so dropping it can only cancel a write. A trailing leg is kept when it reads as
 * a record at all (it may hold a force-charge to switch off).
 */
export function coerceCycle(raw: unknown): ChargeCycleState {
  const active = coerceLegState(raw);
  const o = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const pendingLegs = Array.isArray(o.pendingLegs)
    ? o.pendingLegs.map(coerceLegState).filter((l) => l.day != null && l.day === active.day).slice(0, MAX_PENDING_LEGS)
    : [];
  const t = o.trailing != null ? coerceLegState(o.trailing) : null;
  return { active, pendingLegs, trailing: t != null && t.day != null ? t : null };
}

/** The file's JSON object: the active leg at the top level (the v1 shape), then the cycle. PURE. */
export function serializeCycle(c: ChargeCycleState): Record<string, unknown> {
  return { ...c.active, cycleVersion: CYCLE_FILE_VERSION, pendingLegs: c.pendingLegs, trailing: c.trailing };
}

/* ── resolution and promotion ─────────────────────────────────────────────── */

/**
 * A leg is FINISHED: idle, cancelled, restored, settled as someone else's reserve, or past its apply
 * window (decideActuation's APPLY_LATE_MS) with no write applied. PURE.
 */
export function legFinished(s: NightActuationState, nowMs: number): boolean {
  if (s.day == null) return true;
  if (s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null) return true;
  return s.appliedAtMs == null && s.windowStartMs != null && nowMs > s.windowStartMs + APPLY_LATE_MS;
}

/**
 * legResolved — the one predicate that lets the next leg go (plan §3.2). PURE. All of:
 *  1. the leg is finished (legFinished);
 *  2. it holds nothing of ours on the device (armOpenItem — armFromPlan's own refusal, which
 *     arming the next cycle reads too): no applied write unrestored, no force-charge ON with its
 *     OFF unverified, no attempted write confirmed neither way (a live reading of the
 *     attempt-time baseline proves an attempt never landed);
 *  3. an applied write's restore has read back (or the reserve settled as someone else's); a
 *     force-charge's OFF has read back (condition 2 already asks it: armOpenItem's second item).
 * The panel's force-charge ceiling is not a condition: as armFromPlan has done since v1.165.0, an
 * original not yet restored travels on to the next leg (carryCeilingPrior), which restores it.
 */
export function legResolved(s: NightActuationState, nowMs: number, liveReservePct: number | null): boolean {
  if (s.day == null) return true;
  if (!legFinished(s, nowMs)) return false;
  if (armOpenItem(s, liveReservePct) != null) return false; // includes a force-charge OFF not read back
  return !(s.appliedAtMs != null && s.revertVerifiedAtMs == null && s.foreignSettledAtMs == null);
}

/** The panel's force-charge ceiling original is still to be restored on this record. PURE. */
export function ceilingRestorePending(s: NightActuationState): boolean {
  return s.forceChargeCeilingPriorPct != null && s.forceChargeCeilingRestoredAtMs == null;
}

/**
 * A trailing leg is done: its force-charge OFF has read back, and its ceiling original is restored
 * or no longer being attempted (the restore's attempts are spent — it then travels on). PURE.
 */
export function trailingResolved(t: NightActuationState): boolean {
  if (forceChargeInFlight(t)) return false;
  return !ceilingRestorePending(t) || t.forceChargeCeilingRestoreAttempts >= FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS;
}

/** `to` with the panel's ceiling original `from` still owes, when `to` carries none: the restore
 *  travels on with it, with a fresh budget (as armFromPlan carries it to the next night). PURE. */
export function carryCeilingPrior<T extends NightActuationState>(from: NightActuationState, to: T): T {
  if (!ceilingRestorePending(from) || to.forceChargeCeilingPriorPct != null) return to;
  return { ...to, forceChargeCeilingPriorPct: from.forceChargeCeilingPriorPct, forceChargeCeilingRestoredAtMs: null,
    forceChargeCeilingRestoreAttempts: 0, forceChargeCeilingRestoreLastAttemptMs: null };
}

/** What one cycle tick changed (promoteCycle). */
export interface CycleStep {
  cycle: ChargeCycleState;
  /** The trailing leg that resolved and left the cycle, if any. */
  trailingDone: ChargeLegState | null;
  /** The leg that left (resolved) and the one now active, when a promotion happened. */
  promoted: { from: ChargeLegState; to: ChargeLegState } | null;
}

/**
 * The cycle's own step, before the actuator steps of a tick. PURE. A trailing leg that has resolved
 * leaves (its unrestored ceiling original, if any, travels to the active leg). Then, while legs are
 * pending, the active leg's resolution promotes the first of them — never while a trailing leg is
 * still open, and never while the active leg's missed-apply push is still due: a leg whose apply
 * window passed with no write is resolved at the same instant its push falls due, and promoted
 * first it would leave the cycle unannounced (the push step reads the cycle's legs). null when
 * nothing changes.
 */
export function promoteCycle(c: ChargeCycleState, nowMs: number, liveReservePct: number | null): CycleStep | null {
  let cycle = c;
  let trailingDone: ChargeLegState | null = null;
  if (cycle.trailing != null && trailingResolved(cycle.trailing)) {
    trailingDone = cycle.trailing;
    const active = cycle.active.day != null ? carryCeilingPrior(trailingDone, cycle.active) : cycle.active;
    cycle = { ...cycle, active, trailing: null };
  }
  let promoted: CycleStep['promoted'] = null;
  if (cycle.pendingLegs.length > 0 && cycle.trailing == null && legResolved(cycle.active, nowMs, liveReservePct)
      && !missedApplyDue(cycle.active, nowMs)) {
    const [next, ...rest] = cycle.pendingLegs;
    const to = carryCeilingPrior(cycle.active, next);
    promoted = { from: cycle.active, to };
    cycle = { active: to, pendingLegs: rest, trailing: null };
  }
  return trailingDone == null && promoted == null ? null : { cycle, trailingDone, promoted };
}

/**
 * Where blind force-charge OFF re-sends for `leg` stop at the latest (nightForceCharge
 * blindResendStopMs): the open of the next window a force-charge of ours may run in after `leg`
 * closes. That is the first COST leg among `after` (the legs behind it in the cycle) opening at or
 * after `leg`'s close — a backup leg never force-charges, so an OFF sent inside its window can cut
 * nothing of ours — and with none, the latest plan's window when it opens at or after the close
 * (the next evening's arm). null when there is neither. With one leg nothing is behind it, and this
 * is the plan's window alone, as the force-charge step has bounded it since the on-peak guard. PURE.
 */
export function nextForceChargeOpenMs(
  leg: Pick<NightActuationState, 'windowEndMs'>,
  after: readonly ChargeLegState[],
  planWindowStartMs: number | null | undefined,
): number | null {
  const end = leg.windowEndMs;
  if (end == null) return null;
  const next = after.find((l) => l.day != null && l.leg === 'cost' && l.windowStartMs != null && l.windowStartMs >= end);
  if (next != null) return next.windowStartMs;
  return planWindowStartMs != null && planWindowStartMs >= end ? planWindowStartMs : null;
}

/* ── arming ───────────────────────────────────────────────────────────────── */

/** One leg the evening job asks to arm: its name and the plan it is armed from. */
export interface LegCandidate {
  role: ChargeLegRole;
  kind: ChargeWindowKind;
  plan: ArmablePlan;
  /** Force-charge enabled for this leg (index.ts forceChargeOn(role)); a backup leg never is. */
  forceChargeEnabled?: boolean;
  /** The on-peak start after the leg's window open (chargeWindows.nextOnPeakStartMs). */
  nextOnPeakStartMs?: number | null;
  announcedLevelPct?: number | null;
  announcedExpectedKwh?: number | null;
}

export interface ArmCycleResult {
  /** The cycle to persist once the announcement is delivered; null when no leg arms (the record
   *  in place then stays, as an unarmed evening has always left it). */
  cycle: ChargeCycleState | null;
  /** The legs armed, in order (cycle.active, then cycle.pendingLegs). */
  legs: ChargeLegState[];
  /** Each leg that did not arm, with armRefusalReason's words. */
  refused: Array<{ role: ChargeLegRole; reason: string }>;
  /** The prior leg moved to `trailing` so a backup leg could arm over its unverified OFF. */
  trailingFrom: ChargeLegState | null;
}

/** The prior leg's only open item is a force-charge OFF not yet verified: its reserve is restored
 *  (or someone else's) and no attempt is unconfirmed. PURE. */
export function onlyForceChargeOffOpen(prev: NightActuationState, liveReservePct: number | null): boolean {
  if (!forceChargeInFlight(prev)) return false;
  return armOpenItem({ ...prev, forceChargeOnAtMs: null }, liveReservePct) == null;
}

/**
 * armCycle — arm an evening's legs against the cycle in place (plan §3.2). PURE; index.ts persists
 * the result only once an announcement channel has delivered it.
 *  - A trailing leg still open refuses the cycle (one trailing leg at a time).
 *  - The first leg is armed by armFromPlan against the active leg in place, so it refuses exactly
 *    what armFromPlan refuses and carries the ceiling original armFromPlan carries — EXCEPT that a
 *    backup first leg (reserve-only) arms over a prior leg whose only open item is an unverified
 *    force-charge OFF: that leg moves to `trailing`, keeping its OFF and its ceiling restore.
 *  - Any other open item refuses every leg, with the same words.
 *  - Later legs arm from an empty record (the open-item check is the cycle's, made once); the
 *    first leg that arms carries the ceiling original, so one leg owns its restore.
 *  - A backup leg never force-charges: its ceiling is null and force-charge never rides it.
 * With one cost leg this is armFromPlan / armRefusalReason against the active leg, unchanged.
 */
export function armCycle(
  prev: ChargeCycleState,
  day: string,
  candidates: readonly LegCandidate[],
  nowMs: number,
  liveReservePct: number | null,
): ArmCycleResult {
  const refused: ArmCycleResult['refused'] = [];
  if (prev.trailing != null && !trailingResolved(prev.trailing)) {
    const why = `the ${prev.trailing.day ?? 'a previous night'} force-charge was switched ON and its OFF has not verified`;
    for (const c of candidates) refused.push({ role: c.role, reason: why });
    return { cycle: null, legs: [], refused, trailingFrom: null };
  }
  // The record armFromPlan checks the next leg against: the active leg in place until a leg arms
  // (its open items refuse every leg), then an empty one (the first armed leg carries the ceiling).
  let carrier: NightActuationState = prev.active;
  let trailingFrom: ChargeLegState | null = null;
  const legs: ChargeLegState[] = [];
  candidates.forEach((c, i) => {
    const backup = c.role === 'backup';
    const plan: ArmablePlan = backup ? { ...c.plan, costCeilingSocPct: null } : c.plan;
    const fc = backup ? false : c.forceChargeEnabled;
    // The trailing exception: only when the backup itself arms. A backup that does not leaves the
    // open item in place, and every later leg is refused on it.
    const over = i === 0 && backup && onlyForceChargeOffOpen(prev.active, liveReservePct) ? emptyActuationState() : carrier;
    const armed = armFromPlan(over, day, plan, nowMs, liveReservePct, fc, c.nextOnPeakStartMs);
    if (armed == null) {
      refused.push({ role: c.role, reason: armRefusalReason(over, plan, nowMs, liveReservePct) ?? 'the plan does not arm' });
      return;
    }
    if (over !== carrier) trailingFrom = prev.active;
    legs.push(asChargeLeg(armed, {
      leg: c.role, windowKind: c.kind,
      announcedLevelPct: c.announcedLevelPct ?? null, announcedExpectedKwh: c.announcedExpectedKwh ?? null,
    }));
    carrier = emptyActuationState();
  });
  if (legs.length === 0) return { cycle: null, legs, refused, trailingFrom: null };
  // A trailing leg that resolved is done; its unrestored ceiling original goes with the first leg.
  if (prev.trailing != null) legs[0] = carryCeilingPrior(prev.trailing, legs[0]);
  return {
    cycle: { active: legs[0], pendingLegs: legs.slice(1), trailing: trailingFrom },
    legs, refused, trailingFrom,
  };
}

/**
 * The armed cycle as it is persisted once delivered: armCycle's result with its trailing leg re-read
 * from the record in place. The evening job awaits the announcement between the arm and the
 * persist, and the actuator ticks in between may advance the leg armCycle moved to `trailing` (its
 * OFF read back, a re-send or a page stamped); persisting the arm-time copy would erase that. Only
 * the same leg is taken — same plan date and window — otherwise the arm-time copy stands. With one
 * leg nothing trails, and the cycle is persisted exactly as armed. PURE.
 */
export function withLiveTrailing(armed: ChargeCycleState, liveActive: ChargeLegState): ChargeCycleState {
  const t = armed.trailing;
  if (t == null || liveActive.day == null || liveActive.day !== t.day || liveActive.windowStartMs !== t.windowStartMs) return armed;
  return { ...armed, trailing: liveActive };
}

/**
 * The prior legs a newly armed cycle replaces without their having written anything (the
 * supersede stamp, plan §3.2 "Supersede compares legs"). PURE.
 *  - the active leg, by the rule the evening job has applied since v1.79.0: an earlier evening's,
 *    neither applied nor attempted, with a target (Saturday's arm for the Monday window Sunday
 *    re-arms);
 *  - a pending leg whose apply window has not passed.
 * `sharedWindow` = a leg of the new cycle has the same window.
 */
export function supersededLegs(
  prev: ChargeCycleState,
  next: readonly ChargeLegState[],
  today: string,
  nowMs: number,
): Array<{ leg: ChargeLegState; sharedWindow: boolean }> {
  const shares = (l: ChargeLegState): boolean => next.some((n) => n.windowStartMs === l.windowStartMs && n.windowEndMs === l.windowEndMs);
  const out: Array<{ leg: ChargeLegState; sharedWindow: boolean }> = [];
  const a = prev.active;
  if (a.day != null && a.day !== today && a.appliedAtMs == null && a.applyAttemptedAtMs == null && a.targetPct != null) {
    out.push({ leg: a, sharedWindow: shares(a) });
  }
  for (const p of prev.pendingLegs) {
    if (p.day == null || p.day === today || p.applyAttemptedAtMs != null || p.appliedAtMs != null) continue;
    if (p.windowStartMs != null && nowMs > p.windowStartMs + APPLY_LATE_MS) continue;
    out.push({ leg: p, sharedWindow: shares(p) });
  }
  return out;
}

/* ── the owner's cancel ───────────────────────────────────────────────────── */

export type CancelLegResult =
  | { ok: true; cycle: ChargeCycleState; leg: ChargeLegState; where: 'active' | 'pending' }
  | { ok: false; error: string };

/**
 * POST /api/night-charge/cancel, by leg (plan §5 "API"). PURE.
 *  - `req` null (no leg named): the cost leg, wherever it is — active or pending — else the active
 *    leg. With one leg that is the active leg, as the route has always cancelled.
 *  - `req` 'cost' / 'backup': that leg, or a 409 when the cycle has none.
 * The pending legs are looked at before any 409: at 05:02 the backup leg has just reverted and the
 * cost leg is still pending, and "already completed" would answer for the wrong leg. A leg already
 * restored, or settled as someone else's reserve, has nothing left to cancel (409, the route's own
 * words). Cancelling a pending leg disarms it; cancelling the active leg disarms it before its write
 * and restores it (on the next tick) after.
 */
export function cancelLeg(c: ChargeCycleState, req: ChargeLegRole | null): CancelLegResult {
  const legs: Array<{ leg: ChargeLegState; where: 'active' | 'pending'; i: number }> = [];
  if (c.active.day != null) legs.push({ leg: c.active, where: 'active', i: -1 });
  c.pendingLegs.forEach((leg, i) => legs.push({ leg, where: 'pending', i }));
  const target = req == null
    ? legs.find((l) => l.leg.leg === 'cost') ?? legs.find((l) => l.where === 'active')
    : legs.find((l) => l.leg.leg === req);
  if (target == null) {
    return { ok: false, error: req === 'backup' ? 'no outage backup is armed' : 'no supervised write is armed' };
  }
  const s = target.leg;
  if (s.revertedAtMs != null) return { ok: false, error: 'tonight’s write already completed and reverted' };
  if (s.foreignSettledAtMs != null) {
    return { ok: false, error: `the reserve was set to ${s.foreignReservePct ?? '?'}% outside the add-on; nothing of tonight’s write is left to cancel` };
  }
  const leg: ChargeLegState = { ...s, cancelled: true };
  const cycle: ChargeCycleState = target.where === 'active'
    ? { ...c, active: leg }
    : { ...c, pendingLegs: c.pendingLegs.map((p, i) => (i === target.i ? leg : p)) };
  return { ok: true, cycle, leg, where: target.where };
}

/** The leg a cancel request names: 'cost' or 'backup'; null for none; undefined for an invalid
 *  value (the route answers 400). PURE. */
export function parseCancelLeg(body: unknown): ChargeLegRole | null | undefined {
  const leg = body != null && typeof body === 'object' ? (body as Record<string, unknown>).leg : undefined;
  if (leg === undefined || leg === null) return null;
  return leg === 'cost' || leg === 'backup' ? leg : undefined;
}

/* ── status ───────────────────────────────────────────────────────────────── */

export type LegStatusState =
  | 'idle' | 'armed' | 'cancelled' | 'applied' | 'restoring' | 'completed' | 'foreign' | 'missed' | 'forceChargeOff';

/** One leg as /api/night-charge/status serves it in `legs[]`. */
export interface LegStatus {
  leg: ChargeLegRole;
  windowKind: ChargeWindowKind;
  position: 'active' | 'pending' | 'trailing';
  state: LegStatusState;
  day: string | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  /** The write moment, which is the cancel deadline (APPLY_LEAD_MS is 0). */
  cancelDeadlineMs: number | null;
  targetPct: number | null;
  priorReservePct: number | null;
  announcedLevelPct: number | null;
  announcedExpectedKwh: number | null;
  cancelled: boolean;
  appliedAtMs: number | null;
  revertedAtMs: number | null;
  revertVerifiedAtMs: number | null;
  foreignSettledAtMs: number | null;
  forceChargeOnAtMs: number | null;
  forceChargeOffVerifiedAtMs: number | null;
}

/** A leg's state in one word. PURE. */
export function legStatusState(s: NightActuationState, nowMs: number): LegStatusState {
  if (s.day == null) return 'idle';
  if (s.foreignSettledAtMs != null) return 'foreign';
  if (s.revertedAtMs != null) {
    if (s.revertVerifiedAtMs == null && s.appliedAtMs != null) return 'restoring';
    return forceChargeInFlight(s) ? 'forceChargeOff' : 'completed';
  }
  if (s.appliedAtMs != null) return s.cancelled ? 'restoring' : 'applied';
  if (forceChargeInFlight(s)) return 'forceChargeOff';
  if (s.cancelled) return 'cancelled';
  if (s.applyAttemptedAtMs == null && s.windowStartMs != null && nowMs > s.windowStartMs + APPLY_LATE_MS) return 'missed';
  return 'armed';
}

/** The cycle's legs in order — trailing (if any), active, pending — for the status route. PURE. */
export function cycleLegsStatus(c: ChargeCycleState, nowMs: number): LegStatus[] {
  const one = (s: ChargeLegState, position: LegStatus['position']): LegStatus => ({
    leg: s.leg, windowKind: s.windowKind, position, state: legStatusState(s, nowMs), day: s.day,
    windowStartMs: s.windowStartMs, windowEndMs: s.windowEndMs, cancelDeadlineMs: s.windowStartMs,
    targetPct: s.targetPct, priorReservePct: s.priorReservePct,
    announcedLevelPct: s.announcedLevelPct, announcedExpectedKwh: s.announcedExpectedKwh,
    cancelled: s.cancelled, appliedAtMs: s.appliedAtMs, revertedAtMs: s.revertedAtMs,
    revertVerifiedAtMs: s.revertVerifiedAtMs, foreignSettledAtMs: s.foreignSettledAtMs,
    forceChargeOnAtMs: s.forceChargeOnAtMs, forceChargeOffVerifiedAtMs: s.forceChargeOffVerifiedAtMs,
  });
  const out: LegStatus[] = [];
  if (c.trailing != null) out.push(one(c.trailing, 'trailing'));
  if (c.active.day != null) out.push(one(c.active, 'active'));
  for (const p of c.pendingLegs) out.push(one(p, 'pending'));
  return out;
}

/* ── settings-drift attribution, per leg (plan §4.6) ──────────────────────── */

/** A reserve change confirmed this long after our restore is still ours (settings-drift confirms a
 *  change a poll or two after the panel takes it). */
export const DRIFT_TAIL_MS = 15 * 60_000;
/** A mid-day leg's write is ours from this long before its window opens. */
export const DRIFT_LEAD_MS = 10 * 60_000;

/**
 * Whether a reserve change to this leg's target or restore value is the add-on's own write. PURE.
 *  - The OVERNIGHT leg keeps the rule settings-drift has used since v1.83.0: its write applied and
 *    unrestored, armed and uncancelled, or restored within DRIFT_TAIL_MS — with one exception R1
 *    adds, a write whose reserve settled as someone else's (foreignSettledAtMs), whose later changes
 *    are theirs. A one-leg night is otherwise attributed exactly as before.
 *  - A MID-DAY leg is armed at 21:30 for a 10:00 write, and a change to its 50% target overnight is
 *    not ours: its write spans are [window open − DRIFT_LEAD_MS, open + APPLY_LATE_MS] (the apply
 *    window, unless cancelled before any attempt) and from its attempt to DRIFT_TAIL_MS after the
 *    last restore attempt — the armed 21:30 → 10:00 span is dropped.
 */
export function legDriftActive(leg: ChargeLegState, nowMs: number): boolean {
  if (leg.day == null) return false;
  if (leg.windowKind === 'overnight') {
    return (leg.appliedAtMs != null && leg.revertedAtMs == null && leg.foreignSettledAtMs == null) ||
      (leg.announcedAtMs != null && leg.appliedAtMs == null && leg.cancelled !== true) ||
      (leg.revertedAtMs != null && nowMs - leg.revertedAtMs < DRIFT_TAIL_MS);
  }
  const open = leg.windowStartMs;
  if (open != null && nowMs >= open - DRIFT_LEAD_MS && nowMs <= open + APPLY_LATE_MS
      && !(leg.cancelled && leg.applyAttemptedAtMs == null)) return true;
  const wrote = leg.appliedAtMs != null || leg.applyAttemptedAtMs != null;
  if (wrote && leg.revertedAtMs == null && leg.foreignSettledAtMs == null) return true;
  if (leg.revertedAtMs != null) {
    const last = Math.max(leg.revertedAtMs, leg.revertLastAttemptMs ?? leg.revertedAtMs);
    return nowMs - last < DRIFT_TAIL_MS;
  }
  return false;
}

/**
 * A leg that has LEFT the cycle — the leg a promotion moved on from, or a trailing leg done — and
 * when. promoteCycle drops a leg the moment it resolves, which is the tick its restore (or its
 * force-charge OFF) reads back; settings-drift confirms a change only on its second sighting, a
 * drift tick or two later, by when the leg was gone, and the add-on's own restore or OFF was pushed
 * as an external change. A departed leg stays in the drift attribution for DRIFT_TAIL_MS after it
 * left (in memory: a restart in that minute costs at most one such push).
 */
export interface DepartedLeg {
  leg: ChargeLegState;
  leftAtMs: number;
}

/** The departed legs after a cycle step: those still within DRIFT_TAIL_MS of leaving, plus the
 *  legs this step took out (its finished trailing leg, the leg it promoted from). PURE. */
export function departedAfterStep(prev: readonly DepartedLeg[], step: CycleStep | null, nowMs: number): DepartedLeg[] {
  const out = prev.filter((d) => nowMs - d.leftAtMs < DRIFT_TAIL_MS);
  if (step?.trailingDone != null) out.push({ leg: step.trailingDone, leftAtMs: nowMs });
  if (step?.promoted != null) out.push({ leg: step.promoted.from, leftAtMs: nowMs });
  return out;
}

/** The legs that left the cycle less than DRIFT_TAIL_MS ago, latest first. PURE. */
export function recentlyDeparted(departed: readonly DepartedLeg[], nowMs: number): ChargeLegState[] {
  return departed.filter((d) => nowMs - d.leftAtMs < DRIFT_TAIL_MS && nowMs >= d.leftAtMs)
    .sort((a, b) => b.leftAtMs - a.leftAtMs).map((d) => d.leg);
}

/** The leg whose write a reserve change now could be: the first of trailing, active and pending
 *  legs whose drift span is open (legDriftActive), then the legs that left the cycle within
 *  DRIFT_TAIL_MS (recentlyDeparted) whose span is still open; null when none is. With one leg
 *  nothing departs, and this is the overnight leg's rule alone. PURE. */
export function cycleDriftLeg(c: ChargeCycleState, nowMs: number, departed: readonly DepartedLeg[] = []): ChargeLegState | null {
  for (const l of [c.trailing, c.active, ...c.pendingLegs, ...recentlyDeparted(departed, nowMs)]) {
    if (l != null && legDriftActive(l, nowMs)) return l;
  }
  return null;
}

/** The record whose force-charge writes a force-charge change now could be: the trailing leg while
 *  its writes are in flight or recent (`active`, index.ts forceChargeDriftActive), else the active
 *  leg when its are, else a leg that left the cycle within DRIFT_TAIL_MS whose are (the trailing
 *  leg whose OFF read back on the tick it left), else the active leg. PURE. */
export function forceChargeDriftLeg(
  c: ChargeCycleState,
  departed: readonly DepartedLeg[],
  nowMs: number,
  active: (l: NightActuationState) => boolean,
): NightActuationState {
  if (c.trailing != null && active(c.trailing)) return c.trailing;
  if (active(c.active)) return c.active;
  return recentlyDeparted(departed, nowMs).find(active) ?? c.active;
}

/* ── the missed apply (plan §4.8) ─────────────────────────────────────────── */

/**
 * A leg's apply window passed with no write: armed, not cancelled, no attempt, past
 * windowStartMs + APPLY_LATE_MS, not yet pushed. Only for a leg the overnight-only cycle never had
 * — a backup leg, or a mid-day leg: the overnight cost leg keeps today's behaviour (only a write
 * that never took effect pushes, applyFailed). PURE.
 */
export function missedApplyDue(leg: ChargeLegState, nowMs: number): boolean {
  if (leg.day == null || leg.announcedAtMs == null || leg.cancelled) return false;
  if (leg.missedApplyPushedAtMs != null) return false;
  if (leg.applyAttemptedAtMs != null || leg.appliedAtMs != null) return false;
  if (leg.windowStartMs == null || nowMs <= leg.windowStartMs + APPLY_LATE_MS) return false;
  return leg.leg === 'backup' || leg.windowKind !== 'overnight';
}

/** The missed apply's reason when no guard names one (or the tick could not read them). */
export const MISSED_APPLY_FALLBACK_REASON = `no write was issued in the ${APPLY_LATE_MS / 60_000} minutes after the window opened`;

/** What the tick saw, for the missed-apply reason. */
export interface MissedApplyContext {
  /** The leg was still pending: the leg ahead of it (the active leg) had not resolved. */
  blockedBy: ChargeLegState | null;
  mode: 'advisory' | 'supervised' | 'auto';
  vitalsRed: boolean;
  socCoherent: boolean;
  currentReservePct: number | null;
  /** index.ts multiPanelWriteBlock(): why no panel write is made, or null. */
  panelBlock: string | null;
  liveReservePct?: number | null;
}

/**
 * Why a leg's apply window passed with no write, in words for the push. PURE. The checks are
 * decideActuation's apply guards, in its order, read as of the window (the time guards aside),
 * after the cycle's own: a leg still pending behind an unresolved one.
 */
export function missedApplyReason(leg: ChargeLegState, ctx: MissedApplyContext): string {
  if (ctx.blockedBy != null) {
    const b = ctx.blockedBy;
    const what = b.leg === 'backup' ? 'the outage backup before it' : 'the leg before it';
    const open = armOpenItem(b, ctx.liveReservePct ?? ctx.currentReservePct);
    if (open != null) return `${what} still held the reserve (${open})`;
    if (b.appliedAtMs != null && b.revertVerifiedAtMs == null && b.foreignSettledAtMs == null) {
      return `${what} was restored but the panel had not confirmed it`;
    }
    return `${what} had not finished`;
  }
  if (ctx.mode === 'advisory') return 'the night-charge mode is advisory';
  if (leg.windowStartMs != null && onPeakGuardActive(leg, leg.windowStartMs)) return 'its window opens within an hour of on-peak';
  if (ctx.vitalsRed) return 'the add-on\'s host was under critical load';
  if (!ctx.socCoherent) return 'the pool\'s charge reading was incoherent';
  const cur = ctx.currentReservePct;
  if (cur == null) return 'the panel did not report its backup reserve';
  if (!Number.isInteger(cur) || cur < RESERVE_WRITE_MIN_PCT || cur > RESERVE_WRITE_MAX_PCT) {
    return `the backup reserve read ${cur}%, outside the ${RESERVE_WRITE_MIN_PCT}–${RESERVE_WRITE_MAX_PCT}% the add-on writes`;
  }
  if (leg.targetPct != null && leg.targetPct <= cur) return `the backup reserve already read ${cur}%, at or above the ${leg.targetPct}% this charge sets`;
  if (ctx.panelBlock) return ctx.panelBlock;
  return MISSED_APPLY_FALLBACK_REASON;
}

/* ── the ledger, per leg ──────────────────────────────────────────────────── */

/** The columns a BACKUP leg's stamps go to: the row's own columns hold the cost leg (plan §6).
 *  A stamp with no backup column is not written for a backup leg. */
export const BACKUP_LEDGER_COLUMN: Readonly<Record<string, string>> = Object.freeze({
  actuated: 'backup_actuated',
  actuation_applied_at_ms: 'backup_applied_at_ms',
  actuation_reverted_at_ms: 'backup_reverted_at_ms',
  arm_disposition: 'backup_arm_disposition',
});

/** A leg's outcome stamp, mapped to its columns: the cost leg's as given; a backup leg's to the
 *  backup_* columns (BACKUP_LEDGER_COLUMN), dropping any that have none. PURE. */
export function legLedgerFields(role: ChargeLegRole, fields: Record<string, unknown>): Record<string, unknown> {
  if (role !== 'backup') return fields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const col = BACKUP_LEDGER_COLUMN[k];
    if (col != null) out[col] = v;
  }
  return out;
}
