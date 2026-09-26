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
 *    min(setpointSocPct, RESERVE_WRITE_MAX_PCT), never outside the write
 *    envelope [RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT] (v1.162.0: the
 *    envelope has ONE definition and every guard reads it),
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
 *  write never raises the reserve above RESERVE_WRITE_MAX_PCT regardless of the
 *  plan target. */
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

/**
 * v1.133.1 — the device's backup-reserve write envelope, named.
 *
 * The bound was a bare `50` inside clampReserveTarget and a second literal
 * inside setBackupReserveSoc's range check, so nothing in the codebase said out
 * loud that it is the ceiling on everything the night-charge engine can achieve
 * — which is how `ARB_COST_MAX_SOC_PCT`, schema `int(50,100)`, came to ship with
 * a minimum equal to this maximum (see DOCS.md §8b). Anything that reports a
 * reserve figure to an operator must reconcile against these. There is now ONE
 * definition: `ecoflow/commands.ts` imports these rather than repeating them.
 *
 * ★★★ v1.164.0 — THE MAXIMUM IS 50, AND IT IS THE DEVICE'S, PROVEN.
 *
 * v1.161.0 raised this to 90 to match the configuration (`ARB_COST_MAX_SOC_PCT` had been
 * set to 90 all along and was inert above 50). The night of 2026-09-16 settled it against
 * the hardware:
 *
 *   21:31:40  ARMED — reserve -> 90% ... announced via HA notify + audible
 *   22:55:45  SUPERVISED WRITE APPLIED — backupReserveSoc 16% -> 90%
 *   22:57:45  settings-drift: EXTERNAL change — backupReserveSoc 16 -> 50
 *   23:01:45  applyVerified, targetPct 50, requestedPct 90, applyRetries 0
 *
 * The cloud ACCEPTED the 90 without error; the SHP2 moved 16 -> 50 and stopped. So the
 * old "[10, 50]" comment was RIGHT — it simply never carried the evidence, which is why
 * it was raised. It carries it now. Do not raise this again without new evidence from the
 * device; asking for more than 50 buys nothing and costs two false notifications:
 *   - the 21:30 announcement promises a reserve the panel will not hold (the v1.133.1
 *     over-promise, reintroduced by v1.161.0 and removed again here), and
 *   - settingsDrift reads our own clamped write as an EXTERNAL change and pushes
 *     "Reserve floor changed externally: 16% -> 50%" (observed 22:57:45).
 *
 * ★ `deviceCeilingPct` (v1.161.0) STAYS. It is why that night cost two log lines instead
 * of a false "tonight's buy is forfeited" page with the ledger corrected to actuated:0 —
 * it adopted the 50 as a real partial actuation, 0 retries. It still guards the general
 * case: an owner who moves the reserve slider while a write is in flight.
 *
 * ★★ CHARGING ABOVE 50% IS A DIFFERENT MECHANISM. backupReserveSoc is a floor, and this
 * is its ceiling. The vendor's path to a fuller battery is force-charge
 * (`ch{n}ForceCharge` + `foceChargeHight`, documented range 80-100) — a separate command
 * with its own on-peak hazard. It is NOT reachable by widening this constant.
 */
export const RESERVE_WRITE_MIN_PCT = 10;
export const RESERVE_WRITE_MAX_PCT = 50;

export function clampReserveTarget(targetSocPct: number): number {
  return Math.min(RESERVE_WRITE_MAX_PCT, Math.max(RESERVE_WRITE_MIN_PCT, Math.round(targetSocPct)));
}

/**
 * v1.161.0 — THE DEVICE TOOK THE WRITE BUT STOPPED SHORT.
 *
 * Raising the envelope to 90 (above) made a new outcome reachable: the SHP2
 * accepts the command, moves its reserve UP, and settles somewhere below what
 * was asked — either because the panel enforces a ceiling of its own, or
 * because the owner moved the slider during the window.
 *
 * Without this, that outcome is read as the 2026-08-16 phantom: strict equality
 * against `targetPct` never holds, the apply is re-issued twice, and the night
 * ends on `applyFailed` — which logs "write NEVER TOOK EFFECT ... tonight's buy
 * is forfeited", pushes it, and corrects the ledger to `actuated:0`, all while
 * the panel is holding a raised reserve and charging. A false forfeiture is the
 * worst of both worlds: the operator is paged about a buy that IS happening,
 * and the record says it did not.
 *
 * So a reading strictly between the attempt-time baseline and the target, still
 * standing after APPLY_VERIFY_AFTER_MS, is treated as the actuation the device
 * was willing to grant. The phantom case is untouched: a device that never
 * moved still reads the baseline, which this deliberately does NOT accept.
 *
 * Returns the achieved percentage, or null when this is not that situation.
 */
export function deviceCeilingPct(
  state: Pick<NightActuationState, 'targetPct' | 'attemptBaselinePct'>,
  liveReservePct: number | null,
): number | null {
  const { targetPct, attemptBaselinePct } = state;
  if (targetPct == null || attemptBaselinePct == null || liveReservePct == null) return null;
  if (liveReservePct <= attemptBaselinePct) return null; // never moved — the phantom write
  if (liveReservePct >= targetPct) return null;          // took it in full (or overshot)
  return liveReservePct;
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
/** Consecutive revert failures before the critical escalation annunciates.
 *  This counts CLOUD-REJECTED writes; a write the cloud ACCEPTS but the device
 *  ignores is the readback path below. */
export const REVERT_ESCALATE_AFTER = 3;
/** v1.131.0 - how long after a revert (or revert retry) the device readback
 *  must show the restored floor before we treat the restore as not-taken.
 *  Deliberately the same as REVERT_READBACK_GRACE_MS: that constant is the
 *  measured settling lag during which the projection legitimately still reports
 *  the raised value, so a verdict may not be reached before it expires. */
export const REVERT_VERIFY_AFTER_MS = REVERT_READBACK_GRACE_MS;
/** v1.131.0 - re-issues of the restore after a cloud-ACK'd revert fails
 *  readback. Mirrors APPLY_MAX_RETRIES. */
export const REVERT_MAX_RETRIES = 2;

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
  /** v1.131.0 - when the DEVICE readback first showed the restored floor.
   *  null on a reverted night = the restore is cloud-ACK'd but not yet proven,
   *  exactly the state applyVerifiedAtMs describes on the apply side. */
  revertVerifiedAtMs: number | null;
  /** v1.131.0 - readback-failure re-issues of the revert (cap REVERT_MAX_RETRIES). */
  revertRetries: number;
  /** v1.131.0 - most recent revert attempt (initial or retry); readback is
   *  measured from here so each retry gets its own verification window. */
  revertLastAttemptMs: number | null;
  /** v1.131.0 - the revert-READBACK-failure escalation already fired (once per
   *  night). Distinct from revertEscalated, which counts cloud rejections. */
  revertReadbackEscalated: boolean;
  /** v1.161.0 - what the apply ASKED for, when the device granted something
   *  lower. Null whenever the device took the write in full. `targetPct` is
   *  rewritten to what the panel actually holds (see applyCeiling), so every
   *  downstream equality — readback verification, the arbitrage posture, the
   *  revert-settling predicate — keeps comparing against the live truth; this
   *  field is what preserves the intent for the ledger and the operator. */
  requestedPct: number | null;
  /** v1.165.0 — FORCE-CHARGE (nightForceCharge.ts). All null/0/false on a night
   *  that never force-charged. `forceChargeOnAtMs` + `forceChargeSlots` are a
   *  WRITE-AHEAD intent: persisted BEFORE the ON writes, so a lost confirmation
   *  can never orphan a force-charge — the OFF covers every slot attempted. */
  forceChargeOnAtMs: number | null;
  forceChargeSlots: number[] | null;
  /** v1.186.0 — when a LIVE readback first showed every slot of ours FORCE_CHARGE_ON (a
   *  slot whose Core already sits at the panel's ceiling is exempt: the panel switches
   *  that one off itself). null on a force-charged night = the ON is cloud-ACK'd, or
   *  merely attempted, and not yet proven — the reserve's applyVerifiedAtMs, for ON. */
  forceChargeOnVerifiedAtMs: number | null;
  /** v1.186.0 — the most recent ON attempt (initial or re-issue); the ON readback grace
   *  is measured from here so the re-issue gets its own window. null ⇒ forceChargeOnAtMs. */
  forceChargeOnLastAttemptMs: number | null;
  /** v1.186.0 — ON re-issues spent (cap FORCE_CHARGE_ON_MAX_RETRIES). Counted whether or
   *  not the cloud accepted the re-issue, so a cloud that keeps refusing still ends in
   *  the warning instead of retrying in silence. */
  forceChargeOnRetries: number;
  /** v1.186.0 — the FAILURE marker: when the "tonight's buy above the reserve did not
   *  take effect" warning went (once per night). A restart must not repeat it. */
  forceChargeOnFailedAtMs: number | null;
  forceChargeOffAtMs: number | null;
  forceChargeOffReason: string | null;
  forceChargeOffLastAttemptMs: number | null;
  forceChargeOffRetries: number;
  forceChargeOffVerifiedAtMs: number | null;
  forceChargeOffEscalated: boolean;
  /** v1.168.0 — when the wall-clock DEADLINE paged (nightForceCharge.ts section 0). Kept
   *  apart from forceChargeOffEscalated: an earlier retry-budget escalation can land in
   *  quiet hours and be silent, and it must not disarm the deadline's own page. */
  forceChargeOffDeadlinePagedAtMs: number | null;
  /** v1.173.0 — when a deadline page was last SILENCED by broadcast quiet hours; null = heard
   *  (or never paged). Drives the audible re-page once quiet hours end. */
  forceChargeOffDeadlineMutedAtMs: number | null;
  /** v1.173.0 — audible re-pages spent on a muted deadline (bounded). */
  forceChargeOffDeadlineRepages: number;
  /** Last foceChargeHight sync attempt (ON waits for it to read back). */
  forceChargeCeilingAttemptedAtMs: number | null;
  forceChargeCeilingSyncRetries: number;
  /** The panel's OWN ceiling before our first sync — restored once tonight is done.
   *  Carried into the next night by armFromPlan while still unrestored, so a failed
   *  restore can never make our value look like the owner's. */
  forceChargeCeilingPriorPct: number | null;
  forceChargeCeilingRestoredAtMs: number | null;
  forceChargeCeilingRestoreAttempts: number;
  forceChargeCeilingRestoreLastAttemptMs: number | null;
  /** The ANNOUNCED plan's economic ceiling, captured at arming — like targetPct, a
   *  fresher recompute never silently substitutes a different buy. */
  forceChargeCeilingPct: number | null;
  lastError: string | null;
}

export function emptyActuationState(): NightActuationState {
  return {
    day: null, announcedAtMs: null, targetPct: null, buyKwh: null,
    windowStartMs: null, windowEndMs: null, cancelled: false,
    applyAttemptedAtMs: null, attemptBaselinePct: null,
    appliedAtMs: null, priorReservePct: null, revertedAtMs: null,
    applyVerifiedAtMs: null, applyRetries: 0, applyLastAttemptMs: null, applyEscalated: false,
    revertAttempts: 0, revertEscalated: false,
    revertVerifiedAtMs: null, revertRetries: 0, revertLastAttemptMs: null, revertReadbackEscalated: false,
    requestedPct: null,
    forceChargeOnAtMs: null, forceChargeSlots: null,
    forceChargeOnVerifiedAtMs: null, forceChargeOnLastAttemptMs: null, forceChargeOnRetries: 0,
    forceChargeOnFailedAtMs: null,
    forceChargeOffAtMs: null,
    forceChargeOffReason: null, forceChargeOffLastAttemptMs: null, forceChargeOffRetries: 0,
    forceChargeOffVerifiedAtMs: null, forceChargeOffEscalated: false, forceChargeOffDeadlinePagedAtMs: null,
    forceChargeOffDeadlineMutedAtMs: null, forceChargeOffDeadlineRepages: 0,
    forceChargeCeilingAttemptedAtMs: null, forceChargeCeilingPct: null,
    forceChargeCeilingSyncRetries: 0, forceChargeCeilingPriorPct: null,
    forceChargeCeilingRestoredAtMs: null, forceChargeCeilingRestoreAttempts: 0,
    forceChargeCeilingRestoreLastAttemptMs: null,
    lastError: null,
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
    revertVerifiedAtMs: num(o.revertVerifiedAtMs),
    revertRetries: num(o.revertRetries) ?? 0,
    revertLastAttemptMs: num(o.revertLastAttemptMs),
    revertReadbackEscalated: o.revertReadbackEscalated === true,
    requestedPct: num(o.requestedPct),
    forceChargeOnAtMs: num(o.forceChargeOnAtMs),
    // Slots are 1-3 integers; anything else is dropped, never guessed. A record
    // whose slots are unreadable but whose ON is stamped still OFFs every slot —
    // see the integrator's fallback to all three.
    forceChargeSlots: Array.isArray(o.forceChargeSlots)
      ? o.forceChargeSlots.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 3)
      : null,
    // v1.186.0 — the ON-verify record resumes across a restart: no second warning, no
    // second re-issue, and a verified ON is not re-judged.
    forceChargeOnVerifiedAtMs: num(o.forceChargeOnVerifiedAtMs),
    forceChargeOnLastAttemptMs: num(o.forceChargeOnLastAttemptMs),
    forceChargeOnRetries: num(o.forceChargeOnRetries) ?? 0,
    forceChargeOnFailedAtMs: num(o.forceChargeOnFailedAtMs),
    forceChargeOffAtMs: num(o.forceChargeOffAtMs),
    forceChargeOffReason: str(o.forceChargeOffReason),
    forceChargeOffLastAttemptMs: num(o.forceChargeOffLastAttemptMs),
    forceChargeOffRetries: num(o.forceChargeOffRetries) ?? 0,
    forceChargeOffVerifiedAtMs: num(o.forceChargeOffVerifiedAtMs),
    forceChargeOffEscalated: o.forceChargeOffEscalated === true,
    forceChargeOffDeadlinePagedAtMs: num(o.forceChargeOffDeadlinePagedAtMs),
    forceChargeOffDeadlineMutedAtMs: num(o.forceChargeOffDeadlineMutedAtMs),
    forceChargeOffDeadlineRepages: num(o.forceChargeOffDeadlineRepages) ?? 0,
    forceChargeCeilingAttemptedAtMs: num(o.forceChargeCeilingAttemptedAtMs),
    forceChargeCeilingPct: num(o.forceChargeCeilingPct),
    forceChargeCeilingSyncRetries: num(o.forceChargeCeilingSyncRetries) ?? 0,
    forceChargeCeilingPriorPct: num(o.forceChargeCeilingPriorPct),
    forceChargeCeilingRestoredAtMs: num(o.forceChargeCeilingRestoredAtMs),
    forceChargeCeilingRestoreAttempts: num(o.forceChargeCeilingRestoreAttempts) ?? 0,
    forceChargeCeilingRestoreLastAttemptMs: num(o.forceChargeCeilingRestoreLastAttemptMs),
    lastError: str(o.lastError),
  };
}

/** The plan fields the actuator needs at announce time. */
export interface ArmablePlan {
  chargeTonight: boolean;
  basisComplete: boolean;
  buyKwh: number | null;
  /** v1.165.0 — the plan's economic ceiling (% of pool); the night force-charge
   *  fills to this and never past it. Optional: absent in resilience mode. */
  costCeilingSocPct?: number | null;
  /** v1.60.0 — the WRITE SETPOINT: the pack SoC % that meets floor+cushion.
   *  ★ Deliberately NOT `targetSocPct`, which since v1.60.0 is the
   *  contention-DERATED prediction of what the window will actually reach.
   *  `backupReserveSoc` is an instruction, not a promise: the device charges as
   *  fast as physics allows and stops at the reserve, so writing the derated
   *  arrival would cap the charge at a guess — on a night the predicted EV
   *  session never plugs in, the full rate was there all along and we would
   *  still have stopped short. Ask for the requirement; let physics decide how
   *  far it gets. Still clamped to the write envelope below. */
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
  // v1.165.0 — a force-charge that was switched ON and never verified OFF is an
  // unresolved night too. Arming returns a FRESH record, so re-arming here would
  // bury the only record that knows to switch it off. Verification keeps running
  // after an escalation, so this clears itself once the slots read OFF.
  if (prev.forceChargeOnAtMs != null && prev.forceChargeOffVerifiedAtMs == null) return null;
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
    forceChargeCeilingPct:
      typeof plan.costCeilingSocPct === 'number' && Number.isFinite(plan.costCeilingSocPct)
        ? plan.costCeilingSocPct : null,
    // An unrestored original survives the fresh record, so tonight's restore still
    // returns the OWNER's ceiling, never a value we left behind.
    forceChargeCeilingPriorPct:
      prev.forceChargeCeilingPriorPct != null && prev.forceChargeCeilingRestoredAtMs == null
        ? prev.forceChargeCeilingPriorPct : null,
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
  /** v1.161.0 - the device raised the reserve but settled BELOW the target (its
   *  own ceiling, or an owner adjustment). A real, partial actuation: adopt the
   *  achieved value as the target so the night proceeds and reverts normally,
   *  instead of being scored a phantom and paged as a forfeited buy. */
  | { kind: 'applyCeiling'; achievedPct: number }
  /** v1.79.0 - retries exhausted, device still reads the old reserve: warn the
   *  operator once and correct the ledger (actuated:0). The night then closes
   *  through the normal revert path (a no-op restore). */
  | { kind: 'applyFailed' }
  /** v1.131.0 - the device readback confirms the restored floor: stamp it. */
  | { kind: 'revertVerified' }
  /** v1.131.0 - the revert was cloud-ACK'd but the device still reads the
   *  RAISED target; re-issue the restore. */
  | { kind: 'retryRevert'; restorePct: number }
  /** v1.131.0 - revert retries exhausted and the reserve is still stuck raised.
   *  Escalate once: this is the expensive end state (the panel holds the raised
   *  floor, so it buys grid instead of discharging) and it does not self-heal. */
  | { kind: 'revertFailed'; restorePct: number };

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
    state.attemptBaselinePct >= RESERVE_WRITE_MIN_PCT &&
    state.attemptBaselinePct <= RESERVE_WRITE_MAX_PCT
  ) {
    return { kind: 'adopt', priorPct: state.attemptBaselinePct };
  }

  // ── REVERT (checked next — always allowed, mode-independent: a raised
  // reserve must come back down even if the owner flipped to advisory). ──
  if (state.appliedAtMs != null && state.revertedAtMs == null) {
    // ★★★ v1.162.0 — this MUST track the same envelope as the apply guard below.
    // It was a bare [10,50] pair while the apply guard was too, which is the only
    // reason v1.161.0 was survivable: the apply refused a baseline above 50, so no
    // such baseline could ever be captured. Raising ONE of the two would open the
    // expensive end state this module exists to prevent — apply at 60, capture 60,
    // and then `restorable` is false FOREVER, so the reserve never comes back down.
    const restorable = state.priorReservePct != null &&
      Number.isInteger(state.priorReservePct) &&
      state.priorReservePct >= RESERVE_WRITE_MIN_PCT &&
      state.priorReservePct <= RESERVE_WRITE_MAX_PCT;
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
        // v1.161.0 — the device moved, but not all the way. Adopt it BEFORE the
        // retry ladder: re-issuing a write the panel has already answered cannot
        // change the answer, and the ladder's end state pages a forfeited buy
        // against a reserve that is genuinely raised.
        const achieved = deviceCeilingPct(state, opts.currentReservePct);
        if (achieved != null) return { kind: 'applyCeiling', achievedPct: achieved };
        if (state.applyRetries < APPLY_MAX_RETRIES &&
            (state.windowEndMs == null || nowMs < state.windowEndMs - APPLY_VERIFY_AFTER_MS)) {
          return { kind: 'retryApply', targetPct: state.targetPct };
        }
        if (!state.applyEscalated) return { kind: 'applyFailed' };
      }
    }
    return { kind: 'none' };
  }

  // ── REVERT READBACK (v1.131.0). ──
  // The revert stamped `revertedAtMs` on the CLOUD ACK, which is exactly the
  // evidence v1.79.0 ruled insufficient on the apply side — and the branch
  // above stops looking at the device the moment that stamp lands. A restore
  // the SHP2 ignores therefore leaves the reserve pinned at the raised target
  // with the ledger recording a clean, completed night. That is the expensive
  // failure: the panel holds the raised floor, so it buys grid at on-peak
  // instead of discharging the pack it just paid overnight rates to fill.
  //
  // Falls THROUGH rather than returning 'none'. Today that is defensive only —
  // the APPLY branch below refuses anything with a non-null appliedAtMs, and
  // armFromPlan rebuilds from emptyActuationState(), so a newly armed night can
  // never be inside this block. Written as a fall-through anyway because the
  // alternative is a `return` whose safety depends on a guard two branches away.
  if (
    state.appliedAtMs != null && state.revertedAtMs != null &&
    state.revertVerifiedAtMs == null && state.priorReservePct != null && state.targetPct != null
  ) {
    const restorePct = state.priorReservePct;
    if (opts.currentReservePct === restorePct) return { kind: 'revertVerified' };
    // Strict equality against the RAISED target for the failure verdict, the
    // same discipline as ADOPT: a reading that is neither value means the owner
    // (or the app) moved the floor themselves, and re-issuing our restore would
    // overwrite their change. Fall through — never guess at interference.
    const attemptedAt = state.revertLastAttemptMs ?? state.revertedAtMs;
    if (
      opts.currentReservePct === state.targetPct && state.targetPct !== restorePct &&
      nowMs - attemptedAt >= REVERT_VERIFY_AFTER_MS
    ) {
      if (state.revertRetries < REVERT_MAX_RETRIES) return { kind: 'retryRevert', restorePct };
      if (!state.revertReadbackEscalated) return { kind: 'revertFailed', restorePct };
    }
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
  // v1.162.0 — the envelope constants, not a third copy of the bound. An out-of-
  // envelope reading is garbage or outside interference; fail closed either way.
  if (cur == null || !Number.isInteger(cur)
      || cur < RESERVE_WRITE_MIN_PCT || cur > RESERVE_WRITE_MAX_PCT) return { kind: 'none' };
  if (state.targetPct <= cur) return { kind: 'none' }; // nothing to raise
  return { kind: 'apply', targetPct: state.targetPct };
}
