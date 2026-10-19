/**
 * FIXTURE — the per-night actuation record of v1.188.0 (commit 111247f), verbatim: its interface,
 * emptyActuationState and coerceActuationState from server/src/nightChargeActuator.ts, renamed with
 * a V1188 suffix and nothing else changed. It is what a rolled-back add-on reads the actuation file
 * with, so chargeCycle.test.ts can hold the charge cycle's file to it: the active leg at the top
 * level must read back, field for field, as the record a v1.187 / v1.188 release reverts and
 * switches off. Do not edit it to follow the live record — it stands for the released code.
 */
/* eslint-disable */
export interface NightActuationStateV1188 {
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
  /** v1.187.22 — the slots that warning named (the ones still reading OFF). Fewer than
   *  `forceChargeSlots` = a PARTIAL failure: the other slots took the ON
   *  (nightForceCharge.partialForceChargeOnFailureSlots), and the morning push says "on those
   *  slot(s)", as the warning did. null = no failure, or a record from before it was kept. */
  forceChargeOnFailedSlots: number[] | null;
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
  /** v1.187.22 — STAMPED AT ARM TIME: whether force-charge rides this night — force-charge
   *  enabled (forceChargeEnabled) and the armed ceiling above the reserve maximum. The gate the
   *  evening push named the force-charge on, and the one the plan's expected figure was made with
   *  (forceChargeEligible), so the morning push reads it (forceChargeNightOutcome) instead of the
   *  option as it stands at the restore: a restart mid-night with the option changed turned an
   *  armed-to-ride night into "reserve only" beside a figure that counts the force-charge leg.
   *  Arming does not change what decideForceCharge does. null = a record armed before the stamp. */
  forceChargeRides: boolean | null;
  lastError: string | null;
}

export function emptyActuationStateV1188(): NightActuationStateV1188 {
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
    forceChargeOnFailedAtMs: null, forceChargeOnFailedSlots: null,
    forceChargeOffAtMs: null,
    forceChargeOffReason: null, forceChargeOffLastAttemptMs: null, forceChargeOffRetries: 0,
    forceChargeOffVerifiedAtMs: null, forceChargeOffEscalated: false, forceChargeOffDeadlinePagedAtMs: null,
    forceChargeOffDeadlineMutedAtMs: null, forceChargeOffDeadlineRepages: 0,
    forceChargeCeilingAttemptedAtMs: null, forceChargeCeilingPct: null,
    forceChargeCeilingSyncRetries: 0, forceChargeCeilingPriorPct: null,
    forceChargeCeilingRestoredAtMs: null, forceChargeCeilingRestoreAttempts: 0,
    forceChargeCeilingRestoreLastAttemptMs: null,
    forceChargeRides: null,
    lastError: null,
  };
}

/** Coerce a parsed JSON blob back into a sound state (restart path). Any
 *  malformed field resets to the idle state — fail-closed: a corrupt file
 *  must never fabricate an armed or half-applied night. EXCEPTION: a record
 *  with a plausible appliedAtMs + priorReservePct is preserved even when
 *  other fields are off, because losing it would orphan a raised reserve. */
export function coerceActuationStateV1188(raw: unknown): NightActuationStateV1188 {
  const empty = emptyActuationStateV1188();
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
    // v1.187.22 — as the slots above: 1-3 integers, else no list (read as a whole-night failure,
    // as every failure before the list was kept).
    forceChargeOnFailedSlots: Array.isArray(o.forceChargeOnFailedSlots)
      ? o.forceChargeOnFailedSlots.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 3)
      : null,
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
    // v1.187.22 — a record armed before the stamp has none: null, never a guess.
    forceChargeRides: typeof o.forceChargeRides === 'boolean' ? o.forceChargeRides : null,
    lastError: str(o.lastError),
  };
}
