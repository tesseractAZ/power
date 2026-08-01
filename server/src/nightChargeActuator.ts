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
 *    min(targetSocPct, 50), never above the device's own [10, 50] clamp,
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
  targetSocPct: number | null;
  window: { startMs: number; endMs: number } | null;
}

/**
 * Arm tonight's actuation from the evening job's announced plan. Returns the
 * armed state, or null when the plan is not actuatable (hold night,
 * incomplete basis, no window, no target). Arming REPLACES any prior state —
 * except a still-unresolved applied night (reserve raised, not yet reverted),
 * which must never be orphaned; arming is refused (null) until it reverts.
 */
export function armFromPlan(
  prev: NightActuationState,
  day: string,
  plan: ArmablePlan,
  nowMs: number,
): NightActuationState | null {
  if (prev.appliedAtMs != null && prev.revertedAtMs == null) return null; // unresolved night
  if (!plan.chargeTonight || !plan.basisComplete) return null;
  if (plan.window == null || plan.targetSocPct == null) return null;
  if (plan.buyKwh == null || plan.buyKwh <= 0) return null;
  if (plan.window.endMs <= plan.window.startMs || plan.window.startMs <= nowMs - APPLY_LATE_MS) return null;
  return {
    ...emptyActuationState(),
    day,
    announcedAtMs: nowMs,
    targetPct: clampReserveTarget(plan.targetSocPct),
    buyKwh: plan.buyKwh,
    windowStartMs: plan.window.startMs,
    windowEndMs: plan.window.endMs,
  };
}

export type ActuationAction =
  | { kind: 'none' }
  | { kind: 'apply'; targetPct: number }
  | { kind: 'revert'; restorePct: number };

export interface ActuationTickOpts {
  mode: NightChargeMode;
  /** Live backupReserveSoc from the SHP2 projection (null = unknown). */
  currentReservePct: number | null;
  /** I11 SoC coherence verdict from the same snapshot. */
  socCoherent: boolean;
  /** True while the alert condition is red — no APPLY during an active
   *  critical (reverts still run; restoring the floor is the safe direction). */
  vitalsRed: boolean;
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

  // ── REVERT (checked first — always allowed, mode-independent: a raised
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
  if (opts.mode === 'advisory') return { kind: 'none' };
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
