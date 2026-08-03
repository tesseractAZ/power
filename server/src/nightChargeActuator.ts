/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeActuator.ts — the supervised-write decision core (v1.50.0).
 *
 * PURE decision logic for the bounded night-charge reserve write. The
 * integrator (index.ts) owns all I/O: it persists the actuation state file,
 * reads the live snapshot, calls the audited write helper
 * (ecoflow/commands.setBackupReserveSoc), and drives this module on a 60 s
 * tick. Everything here takes an injected `nowMs` and returns a value —
 * fully unit-testable, no clock reads, no globals.
 *
 * ★★ SAFETY POSTURE (binding):
 *  - ONE bounded write per night: raise `backupReserveSoc` to
 *    min(setpointSocPct, 50), never above the device's own [10, 50] clamp,
 *    never touching any other field. The write is armed ONLY from the plan
 *    that was ANNOUNCED at the evening job (the owner's cancel window ran
 *    against those exact numbers) — a fresher recompute never silently
 *    substitutes a different buy.
 *  - The write path stays fail-closed: no announced plan, a cancelled night,
 *    an incoherent SoC read, a stale/out-of-range current reserve, a missed
 *    apply window, or advisory mode ⇒ no write.
 *  - The reserve ALWAYS reverts: at window close + 5 min (or immediately on
 *    a post-apply cancel) the prior value is restored. Repeated revert
 *    failure escalates to a critical annunciation while retries continue.
 *    The floor/runway/SoC alarm spine is fully independent of this module
 *    and keeps its own protection throughout.
 * ═════════════════════════════════════════════════════════════════════════ */

export type NightChargeMode = 'advisory' | 'supervised' | 'auto';

/** Owner mode from the add-on option. Unknown/absent values fail closed to
 *  'advisory' (never a write because a config string was mistyped). */
export function resolveNightChargeMode(raw: string | undefined | null): NightChargeMode {
  return raw === 'supervised' || raw === 'auto' ? raw : 'advisory';
}

/** The device clamp for backupReserveSoc plus the supervised ceiling: the
 *  write never raises the reserve above 50% regardless of the plan target. */
export function clampReserveTarget(targetSocPct: number): number {
  return Math.min(50, Math.max(10, Math.round(targetSocPct)));
}

/** Apply window: the write may fire from 5 min before the plan's charge
 *  window opens until 30 min after (a late boot inside the window still
 *  buys most of the night; later than that the announced sizing is stale). */
export const APPLY_LEAD_MS = 5 * 60_000;
export const APPLY_LATE_MS = 30 * 60_000;
/** Revert fires 5 min after the plan's charge window closes. */
export const REVERT_LAG_MS = 5 * 60_000;
/** Consecutive revert failures before the critical escalation annunciates. */
export const REVERT_ESCALATE_AFTER = 3;

/** Restart-persistent per-night actuation record (one file, day-keyed). */
export interface NightActuationState {
  /** plan_date (YYYY-MM-DD America/Phoenix) of the armed plan; null = idle. */
  day: string | null;
  /** When the evening job armed + announced this plan. */
  announcedAtMs: number | null;
  /** The clamped reserve target the announcement named. */
  targetPct: number | null;
  /** The announced buy, for the morning summary. */
  buyKwh: number | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  /** Owner cancelled tonight's write (dashboard button / API). */
  cancelled: boolean;
  /** Write-ahead intent: persisted BEFORE the apply write is issued, so a
   *  write whose confirmation is lost (device applied it, response dropped)
   *  is still reconcilable from the live reserve reading — a raised reserve
   *  must never be orphaned by a lost HTTP response. */
  applyAttemptedAtMs: number | null;
  /** The live reserve read at attempt time — the adoption/revert baseline. */
  attemptBaselinePct: number | null;
  appliedAtMs: number | null;
  /** The reserve value read immediately before the write — the revert target. */
  priorReservePct: number | null;
  revertedAtMs: number | null;
  revertAttempts: number;
  /** The critical revert-failure annunciation already fired (once per night). */
  revertEscalated: boolean;
  lastError: string | null;
}

export function emptyActuationState(): NightActuationState {
  return {
    day: null, announcedAtMs: null, targetPct: null, buyKwh: null,
    windowStartMs: null, windowEndMs: null, cancelled: false,
    applyAttemptedAtMs: null, attemptBaselinePct: null,
    appliedAtMs: null, priorReservePct: null, revertedAtMs: null,
    revertAttempts: 0, revertEscalated: false, lastError: null,
  };
}

/** Coerce a parsed JSON blob back into a sound state (restart path). Any
 *  malformed field resets to the idle state — fail-closed: a corrupt file
 *  must never fabricate an armed or half-applied night. EXCEPTION: a record
 *  with a plausible appliedAtMs + priorReservePct is preserved even when
 *  other fields are off, because losing it would orphan a raised reserve. */
export function coerceActuationState(raw: unknown): NightActuationState {
  const empty = emptyActuationState();
  if (raw == null || typeof raw !== 'object') return empty;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const day = str(o.day);
  if (day == null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return empty;
  return {
    day,
    announcedAtMs: num(o.announcedAtMs),
    targetPct: num(o.targetPct),
    buyKwh: num(o.buyKwh),
    windowStartMs: num(o.windowStartMs),
    windowEndMs: num(o.windowEndMs),
    cancelled: o.cancelled === true,
    applyAttemptedAtMs: num(o.applyAttemptedAtMs),
    attemptBaselinePct: num(o.attemptBaselinePct),
    appliedAtMs: num(o.appliedAtMs),
    priorReservePct: num(o.priorReservePct),
    revertedAtMs: num(o.revertedAtMs),
    revertAttempts: num(o.revertAttempts) ?? 0,
    revertEscalated: o.revertEscalated === true,
    lastError: str(o.lastError),
  };
}

/** The plan fields the actuator needs at announce time. */
export interface ArmablePlan {
  chargeTonight: boolean;
  basisComplete: boolean;
  buyKwh: number | null;
  /** v1.60.0 — the WRITE SETPOINT: the pack SoC % that meets floor+cushion.
   *  ★ Deliberately NOT `targetSocPct`, which since v1.60.0 is the
   *  contention-DERATED prediction of what the window will actually reach.
   *  `backupReserveSoc` is an instruction, not a promise: the device charges as
   *  fast as physics allows and stops at the reserve, so writing the derated
   *  arrival would cap the charge at a guess — on a night the predicted EV
   *  session never plugs in, the full rate was there all along and we would
   *  still have stopped short. Ask for the requirement; let physics decide how
   *  far it gets. Still clamped to [10,50] below. */
  setpointSocPct: number | null;
  window: { startMs: number; endMs: number } | null;
}

/**
 * Arm tonight's actuation from the evening job's announced plan. Returns the
 * armed state, or null when the plan is not actuatable (hold night,
 * incomplete basis, no window, no target). Arming REPLACES any prior state —
 * except an unresolved night, which must never be orphaned:
 *  - an applied-but-unreverted write always refuses re-arming;
 *  - an ATTEMPTED-but-unconfirmed write (write issued, no success recorded)
 *    refuses re-arming unless the live reserve reading proves the write never
 *    landed (it still equals the attempt-time baseline). A lost confirmation
 *    whose write actually applied is instead adopted by `decideActuation` and
 *    reverts through the normal path before any new night may arm.
 */
export function armFromPlan(
  prev: NightActuationState,
  day: string,
  plan: ArmablePlan,
  nowMs: number,
  /** Live backupReserveSoc at arm time (null = unknown → fail-closed). */
  liveReservePct: number | null,
): NightActuationState | null {
  if (prev.appliedAtMs != null && prev.revertedAtMs == null) return null; // unresolved night
  if (
    prev.applyAttemptedAtMs != null && prev.appliedAtMs == null && prev.revertedAtMs == null &&
    !(liveReservePct != null && prev.attemptBaselinePct != null && liveReservePct === prev.attemptBaselinePct)
  ) {
    return null; // unconfirmed attempt not provably un-applied — never bury it
  }
  if (!plan.chargeTonight || !plan.basisComplete) return null;
  if (plan.window == null || plan.setpointSocPct == null) return null;
  if (plan.buyKwh == null || plan.buyKwh <= 0) return null;
  if (plan.window.endMs <= plan.window.startMs || plan.window.startMs <= nowMs - APPLY_LATE_MS) return null;
  return {
    ...emptyActuationState(),
    day,
    announcedAtMs: nowMs,
    targetPct: clampReserveTarget(plan.setpointSocPct),
    buyKwh: plan.buyKwh,
    windowStartMs: plan.window.startMs,
    windowEndMs: plan.window.endMs,
  };
}

export type ActuationAction =
  | { kind: 'none' }
  | { kind: 'apply'; targetPct: number }
  | { kind: 'revert'; restorePct: number }
  /** A write whose confirmation was lost is proven applied by the live reserve
   *  reading — the driver stamps it as applied (priorPct = the attempt-time
   *  baseline) so the normal revert path takes over. */
  | { kind: 'adopt'; priorPct: number };

export interface ActuationTickOpts {
  mode: NightChargeMode;
  /** Readiness-gate verdict (getLatestReadiness()?.writeReady === true). Gates
   *  ONLY the 'auto' differentiation — see effectiveActuationMode. */
  writeReady: boolean;
  /** Live backupReserveSoc from the SHP2 projection (null = unknown). */
  currentReservePct: number | null;
  /** I11 SoC coherence verdict from the same snapshot. */
  socCoherent: boolean;
  /** True while the alert condition is red — no APPLY during an active
   *  critical (reverts still run; restoring the floor is the safe direction). */
  vitalsRed: boolean;
}

/**
 * The readiness enforcement point for AUTO (binding): 'auto' carries its own
 * semantics ONLY while the write-readiness gate has graduated (`writeReady`);
 * otherwise it is structurally DEMOTED to 'supervised'. In this release the
 * two modes are operationally identical (both run the announced, cancellable
 * flow), so the demotion changes nothing yet — but any future auto-only
 * relaxation (e.g. dropping the evening cancel checkpoint) MUST branch on the
 * mode returned HERE, never on the raw config value, so it can never ship
 * ungated.
 */
export function effectiveActuationMode(mode: NightChargeMode, writeReady: boolean): NightChargeMode {
  return mode === 'auto' && !writeReady ? 'supervised' : mode;
}

/**
 * The per-tick decision. Pure — the integrator executes the returned action
 * through the audited write helper and updates/persists the state on the
 * observed outcome.
 */
export function decideActuation(
  state: NightActuationState,
  nowMs: number,
  opts: ActuationTickOpts,
): ActuationAction {
  if (state.day == null) return { kind: 'none' };
  const mode = effectiveActuationMode(opts.mode, opts.writeReady);

  // ── ADOPT (checked before everything — mode-independent, like revert): an
  // attempted write with no recorded success whose target the device now
  // READS BACK (and which differs from the attempt-time baseline) really did
  // land — the confirmation was lost, not the write. Without adoption the
  // "nothing to raise" guard would no-op forever and the raised reserve
  // would never revert. Strict equality: any other reading means either the
  // write truly failed (still at baseline → re-attempt/arm paths handle it)
  // or outside interference (never guess a revert target from it). ──
  if (
    state.applyAttemptedAtMs != null && state.appliedAtMs == null && state.revertedAtMs == null &&
    state.targetPct != null && state.attemptBaselinePct != null &&
    opts.currentReservePct === state.targetPct &&
    state.targetPct !== state.attemptBaselinePct &&
    Number.isInteger(state.attemptBaselinePct) &&
    state.attemptBaselinePct >= 10 && state.attemptBaselinePct <= 50
  ) {
    return { kind: 'adopt', priorPct: state.attemptBaselinePct };
  }

  // ── REVERT (checked next — always allowed, mode-independent: a raised
  // reserve must come back down even if the owner flipped to advisory). ──
  if (state.appliedAtMs != null && state.revertedAtMs == null) {
    const due =
      state.cancelled ||
      (state.windowEndMs != null && nowMs >= state.windowEndMs + REVERT_LAG_MS);
    if (due && state.priorReservePct != null &&
        Number.isInteger(state.priorReservePct) &&
        state.priorReservePct >= 10 && state.priorReservePct <= 50) {
      return { kind: 'revert', restorePct: state.priorReservePct };
    }
    return { kind: 'none' };
  }

  // ── APPLY. Every guard fail-closed. ──
  if (mode === 'advisory') return { kind: 'none' };
  if (state.cancelled || state.appliedAtMs != null) return { kind: 'none' };
  if (state.targetPct == null || state.windowStartMs == null) return { kind: 'none' };
  if (nowMs < state.windowStartMs - APPLY_LEAD_MS) return { kind: 'none' }; // too early
  if (nowMs > state.windowStartMs + APPLY_LATE_MS) return { kind: 'none' }; // window missed — no late write
  if (opts.vitalsRed) return { kind: 'none' }; // never actuate during an active critical
  if (!opts.socCoherent) return { kind: 'none' };
  const cur = opts.currentReservePct;
  if (cur == null || !Number.isInteger(cur) || cur < 10 || cur > 50) return { kind: 'none' };
  if (state.targetPct <= cur) return { kind: 'none' }; // nothing to raise
  return { kind: 'apply', targetPct: state.targetPct };
}
