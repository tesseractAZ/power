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
/**
 * v1.113.0 — is the SHP2's reserve CURRENTLY raised by our own night-charge
 * write? PURE.
 *
 * The below-reserve alert used to answer this with a magic number: an on-grid
 * pool at/below a reserve of <= 15 was the TRUE floor (warning + one [Medium]
 * push per episode), and anything higher was assumed to be the charge window's
 * normal filling state (silent info, the F14 "floor-riding must not page"
 * contract). That proxy holds only while the owner's floor happens to sit
 * below 15. The moment the owner RAISES the floor for more buffer — 20% on
 * 2026-08-28 — the proxy inverts: a genuine floor breach at the new, higher,
 * more conservative floor would be classified as arbitrage and go silent,
 * so asking for more protection would have bought less.
 *
 * The actuator already knows the answer as a fact: it applied the raise, it
 * recorded the value it will restore, and its state is persisted across
 * restarts. Key on that, never on the number.
 */
export function isReserveArbitrageRaised(
  state: Pick<NightActuationState, 'appliedAtMs' | 'revertedAtMs'>,
): boolean {
  return state.appliedAtMs != null && state.revertedAtMs == null;
}

/**
 * v1.115.0 — the OWNER's reserve floor, as distinct from whatever the device
 * currently reports. PURE.
 *
 * While the night-charge actuator holds the reserve at its target (typically
 * 50%), `backupReserveSoc` is OUR instruction, not the owner's floor — the
 * actuator recorded the real floor as `priorReservePct` and restores it at
 * window close. Any consumer that asks "is the pool at its floor?" must ask
 * about the OWNER's floor, or it manufactures an at-the-floor posture for the
 * whole charge window every night (the runway alarm did exactly that, a
 * documented ~6 h nightly artifact).
 *
 * v1.113.0 fixed this in `shp2-below-reserve`; this is the same fact, shared
 * so the sibling consumers cannot drift apart from it again.
 */
export function ownerReserveFloorPct(
  state: Pick<NightActuationState, 'appliedAtMs' | 'revertedAtMs' | 'priorReservePct'>,
  liveReservePct: number | null,
): number | null {
  if (isReserveArbitrageRaised(state)) {
    const prior = state.priorReservePct;
    if (prior != null && Number.isInteger(prior) && prior >= 10 && prior <= 50) return prior;
  }
  return liveReservePct;
}

/**
 * v1.122.0 — the SPOKEN night-charge advisory, bounded.
 *
 * The prose that goes to the HA push was reused verbatim as TTS, and the
 * bilingual pass doubles it. On 2026-09-02 that rendered a 2,643,918-byte clip =
 * 59.95 s of audio, 3.3x every other clip in the corpus. Because every broadcast
 * is serialised through one promise chain, the two alarm speakers were held for a
 * full minute each evening by the least urgent message the system produces, and a
 * red arising in that window could not be spoken until it finished.
 *
 * Speech keeps only what the listener must act on. The bound below is asserted by
 * a test so this cannot rot back: at ~44,100 bytes/s of rendered WAV the
 * bilingual pair must stay well under ANNOUNCE_TIMEOUT_FLOOR_MS (75 s).
 */
export const MAX_SPOKEN_ADVISORY_CHARS = 560;

export function nightChargeSpokenNotice(o: {
  buyKwhRounded: number;
  targetPct: number;
  deadlineText: string;
  deadlineTextEs: string;
  cushionShortfall: boolean;
}): { en: string; es: string } {
  // The shortfall clause stays on the audible path — it must never be quieter
  // about residual risk than the text channel — but as a clause, not a sentence,
  // because it discloses on every single plan.
  const shortEn = o.cushionShortfall ? ' Outage cushion not fully met.' : '';
  const shortEs = o.cushionShortfall ? ' Margen de respaldo no cubierto por completo.' : '';
  return {
    en:
      `Night charge notice. Buying about ${o.buyKwhRounded} kilowatt hours overnight, `
      + `raising backup reserve to ${o.targetPct} percent ${o.deadlineText}.`
      + `${shortEn} Cancel on the Power panel before then.`,
    es:
      `Aviso de carga nocturna. Comprando unos ${o.buyKwhRounded} kilovatios hora durante la noche, `
      + `elevando la reserva de respaldo al ${o.targetPct} por ciento ${o.deadlineTextEs}.`
      + `${shortEs} Cancele en el panel Power antes de esa hora.`,
  };
}

/**
 * v1.120.0 — REVERT READBACK LAG.
 *
 * The revert stamps `revertedAtMs` the moment the CLOUD acknowledges the write,
 * but the SHP2's projection keeps reporting the RAISED reserve for another
 * ~20-60 s until the next device readback lands. `isReserveArbitrageRaised`
 * goes false immediately, so for that window the alert engine sees
 * arbitrageRaised=false against a still-raised reserve of 50 and classifies a
 * pool sitting at ~49% as a genuine floor breach — a false "[Medium] Backup at
 * reserve" push, followed by its own resolve ~40 s later.
 *
 * Observed live on 2026-09-03: revert 05:05:56 -> push 05:06:16 -> resolve
 * 05:06:56, with the owner's real floor at 16% and the pool at 49%. The same
 * pattern is in the cleared-alert ledger for 08-31 and 09-01. It recurs on any
 * night the pool is at or under the raised reserve when the window closes.
 *
 * The apply side races the same way but in the SAFE direction (the flag is set
 * before the device shows the raise), so only the revert is exposed.
 *
 * This predicate holds the posture true through the settling window, and is
 * deliberately narrow: it requires the live reading to still be EXACTLY the
 * target we wrote, and expires after REVERT_READBACK_GRACE_MS so a genuine
 * owner change made just after a revert is never masked for long.
 */
export const REVERT_READBACK_GRACE_MS = 5 * 60_000;

export function isRevertSettling(
  state: Pick<NightActuationState, 'appliedAtMs' | 'revertedAtMs' | 'priorReservePct' | 'targetPct'>,
  liveReservePct: number | null,
  nowMs: number,
): boolean {
  const { appliedAtMs, revertedAtMs, priorReservePct, targetPct } = state;
  if (appliedAtMs == null || revertedAtMs == null) return false;
  if (priorReservePct == null || targetPct == null || liveReservePct == null) return false;
  if (targetPct === priorReservePct) return false;      // nothing was actually raised
  if (liveReservePct !== targetPct) return false;       // readback already caught up (or owner moved it)
  const since = nowMs - revertedAtMs;
  return since >= 0 && since <= REVERT_READBACK_GRACE_MS;
}

/** v1.115.0 — publisher for the owner floor (same set/get pattern as the
 *  posture flag; analytics reads it without importing index.ts). */
let ownerFloorPct: number | null = null;
export function setOwnerReserveFloorPct(v: number | null): void { ownerFloorPct = v; }
export function getOwnerReserveFloorPct(): number | null { return ownerFloorPct; }
export function resetOwnerReserveFloorPct(): void { ownerFloorPct = null; }

/** v1.113.0 — publisher so the alert engine can read the actuator's posture
 *  without importing index.ts (mirrors messageRateFloorAlert's set/get). */
let reserveArbitrageRaised = false;
export function setReserveArbitrageRaised(v: boolean): void { reserveArbitrageRaised = v; }
export function getReserveArbitrageRaised(): boolean { return reserveArbitrageRaised; }
/** Test seam. */
export function resetReserveArbitrageRaised(): void { reserveArbitrageRaised = false; }

export function clampReserveTarget(targetSocPct: number): number {
  return Math.min(50, Math.max(10, Math.round(targetSocPct)));
}

/** Apply window: the write may fire from 5 min before the plan's charge
 *  window opens until 30 min after (a late boot inside the window still
 *  buys most of the night; later than that the announced sizing is stale). */
export const APPLY_LEAD_MS = 5 * 60_000;
export const APPLY_LATE_MS = 30 * 60_000;
/** v1.79.0 - how long after an apply (or retry) the device readback must show
 *  the target before we treat the write as not-taken. The strategy quota
 *  refreshes on a minutes cadence; 5 min is ~3 refresh opportunities. */
export const APPLY_VERIFY_AFTER_MS = 5 * 60_000;
/** v1.79.0 - re-issue attempts after a cloud-ACK'd write fails readback. On
 *  2026-08-16 the Sunday write was ACK'd and the device never took it; the
 *  ledger scored a phantom actuation and ~13 kWh of arbitrage was silently
 *  forfeited. Two retries span ~15 min of the window. */
export const APPLY_MAX_RETRIES = 2;

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
  /** v1.79.0 - when the DEVICE readback first showed the target after apply.
   *  null on an applied night = the write is cloud-ACK'd but not yet proven. */
  applyVerifiedAtMs: number | null;
  /** v1.79.0 - readback-failure re-issues of the apply (cap APPLY_MAX_RETRIES). */
  applyRetries: number;
  /** v1.79.0 - most recent apply attempt (initial or retry); readback is
   *  measured from here so each retry gets its own verification window. */
  applyLastAttemptMs: number | null;
  /** v1.79.0 - the apply-failure warning already went (once per night). */
  applyEscalated: boolean;
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
    applyVerifiedAtMs: null, applyRetries: 0, applyLastAttemptMs: null, applyEscalated: false,
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
    applyVerifiedAtMs: num(o.applyVerifiedAtMs),
    applyRetries: num(o.applyRetries) ?? 0,
    applyLastAttemptMs: num(o.applyLastAttemptMs),
    applyEscalated: o.applyEscalated === true,
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
  | { kind: 'revert'; restorePct: number; gridLossAbort?: boolean }
  /** A write whose confirmation was lost is proven applied by the live reserve
   *  reading — the driver stamps it as applied (priorPct = the attempt-time
   *  baseline) so the normal revert path takes over. */
  | { kind: 'adopt'; priorPct: number }
  /** v1.79.0 - the device readback confirms the applied target: stamp it. */
  | { kind: 'applyVerified' }
  /** v1.79.0 - cloud ACK'd, device never took it; re-issue the write. */
  | { kind: 'retryApply'; targetPct: number }
  /** v1.79.0 - retries exhausted, device still reads the old reserve: warn the
   *  operator once and correct the ledger (actuated:0). The night then closes
   *  through the normal revert path (a no-op restore). */
  | { kind: 'applyFailed' };

export interface ActuationTickOpts {
  mode: NightChargeMode;
  /** Readiness-gate verdict (getLatestReadiness()?.writeReady === true). Gates
   *  ONLY the 'auto' differentiation — see effectiveActuationMode. */
  writeReady: boolean;
  /** Live backupReserveSoc from the SHP2 projection (null = unknown). */
  currentReservePct: number | null;
  /** I11 SoC coherence verdict from the same snapshot. */
  socCoherent: boolean;
  /** v1.79.0 doc correction — this is the HOST-VITALS level (selfVitals
   *  'crit': CPU/memory/loop pressure), NOT the alert condition. Deliberate:
   *  gating on alert-critical would have disabled the engine for the entire
   *  month the Core 3 err533 critical has stood. The name stays for state
   *  compatibility; the semantic is "no device writes from a struggling
   *  process" (reverts still run — restoring the floor is the safe direction). */
  vitalsRed: boolean;
  /** v1.79.0 — live grid presence (gridSta-derived); null = unknown. False
   *  during an applied window aborts the buy and reverts immediately. */
  gridPresent: boolean | null;
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
    const restorable = state.priorReservePct != null &&
      Number.isInteger(state.priorReservePct) &&
      state.priorReservePct >= 10 && state.priorReservePct <= 50;
    // v1.79.0 — GRID-LOSS ABORT: with the grid gone the buy cannot happen and
    // the raised reserve only manufactures a false AT-RESERVE-FLOOR posture on
    // top of a real outage. Restore the true floor now. gridPresent === null
    // (unknown) never aborts — fail to the normal schedule.
    if (opts.gridPresent === false && restorable) {
      return { kind: 'revert', restorePct: state.priorReservePct!, gridLossAbort: true };
    }
    const due =
      state.cancelled ||
      (state.windowEndMs != null && nowMs >= state.windowEndMs + REVERT_LAG_MS);
    if (due && restorable) {
      return { kind: 'revert', restorePct: state.priorReservePct! };
    }
    // v1.79.0 — READBACK VERIFICATION. A cloud ACK is not an actuation: on
    // 2026-08-16 23:55 an ACK'd write never reached the SHP2, nothing compared
    // the device's reserve to the target, and the night ran its drawdown on a
    // floor the ledger said was raised. Strict equality against the DEVICE-side
    // reading; measured from the latest attempt so each retry earns a fresh
    // window. Readback pauses while the reading is null (starved/unknown).
    if (state.applyVerifiedAtMs == null && state.targetPct != null) {
      if (opts.currentReservePct === state.targetPct) return { kind: 'applyVerified' };
      const attemptedAt = state.applyLastAttemptMs ?? state.appliedAtMs;
      if (opts.currentReservePct != null && nowMs - attemptedAt >= APPLY_VERIFY_AFTER_MS) {
        if (state.applyRetries < APPLY_MAX_RETRIES &&
            (state.windowEndMs == null || nowMs < state.windowEndMs - APPLY_VERIFY_AFTER_MS)) {
          return { kind: 'retryApply', targetPct: state.targetPct };
        }
        if (!state.applyEscalated) return { kind: 'applyFailed' };
      }
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
