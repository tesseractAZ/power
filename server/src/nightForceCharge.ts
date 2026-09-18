/**
 * nightForceCharge.ts — v1.165.0. Force-charge rides the night-charge window.
 *
 * WHY. The reserve write is capped at 50% by the SHP2 itself (proven 2026-09-16:
 * a 90 write settled at 50). That night the panel charged 16% → 49% by 01:00 at
 * ~15 kW into the pack, then sat FLAT at 49% until 05:00 — four hours of cheap
 * overnight window unused, because the reserve had reached its ceiling. The
 * vendor's path past it is the per-channel force-charge switch (`ch{n}ForceCharge`,
 * the EcoFlow app's "Charge Now"), bounded by the panel's own force-charge ceiling
 * `foceChargeHight` (documented 80-100).
 *
 * WHAT. On a night whose reserve write was APPLIED AND VERIFIED, switch force-charge
 * ON for the connected slots and leave it on until the window closes. The panel's
 * own ceiling stops the charge; before the first ON of a night that ceiling is synced
 * to the ANNOUNCED plan's economic ceiling — min(ARB_COST_MAX_SOC_PCT, full minus
 * tomorrow's P90 morning solar) — best-effort. A ceiling under the panel's 80%
 * minimum leaves the night reserve-only: forcing would overfill past the solar
 * headroom, which is the waste ARB_COST_MAX_SOC_PCT exists to prevent.
 *
 * ★★ WHY NOT STOP AT THE CEILING IN SOFTWARE. With the reserve at 50%, switching
 * force-charge OFF at 90% lets the panel serve the house from the pack, draining it
 * back toward 50% for the rest of the window — forfeiting exactly the hours this
 * exists to recover (on 2026-09-16 the reserve held the house on grid at a flat 49%
 * from 01:00 to 05:00). The DEVICE ceiling ends the charge instead, and turning OFF
 * never depends on a fresh SoC reading. ★ That force-charge ON keeps the house on
 * grid is INFERRED from the 2026-08-04 incident (it bought grid for hours), not
 * vendor-documented.
 *
 * ★★★ OUTAGE — NOT ESTABLISHED EITHER WAY. No vendor text says how a slot with
 * ch{n}ForceCharge ON behaves when the grid fails, and no outage has ever overlapped
 * Charge Now on this plant. What argues against harm is inference: islanding is a
 * panel-level EPS transfer (gridSta=2), a grid charge has no source once the grid is
 * gone, and the owner has used this same button by hand with the same exposure since
 * before v1.84.0. The software grid-loss OFF is best-effort (a cloud write). Settle it
 * with one attended test: Charge Now ON for one slot, open the main breaker, confirm the
 * backed-up loads stay up and the pack discharges.
 *
 * ★★★ SAFETY RAILS (each pinned by nightForceCharge.test.ts + the committed harness):
 *  - ON only rides a night whose reserve write was applied AND readback-verified, so
 *    it inherits every reserve guard (mode, cancel window, vitals, coherence,
 *    multi-panel block) and only runs when the write path is demonstrably working.
 *  - ON needs grid KNOWN present, a live slot readback, and no slot already ON (an
 *    operator's Charge Now is theirs — we never take ownership of it).
 *  - WRITE-AHEAD: the slots are persisted BEFORE the ON writes, so a lost
 *    confirmation can never orphan a force-charge — the OFF covers every attempt.
 *  - OFF is MODE-INDEPENDENT and ENABLE-INDEPENDENT (a force-charge we started must
 *    stop even if the owner disables the feature mid-night), and fires on: window
 *    end, a cancelled night, the reserve revert, grid loss (either signal), the
 *    feature being disabled, or MAX_RUN elapsing (a corrupted window can never
 *    hold it on).
 *  - OFF is readback-verified, re-issued, then escalated — and verification KEEPS
 *    RUNNING after the escalation, so the record resolves the moment the slots read
 *    OFF (fixed from the app) instead of wedging.
 *  - armFromPlan refuses to bury a night whose force-charge never verified OFF.
 *  - The v1.84.0 Charge Now responder PUSHES on an on-peak grid draw with force-charge
 *    ON, whoever switched it on. It only switches it OFF in CHARGE_NOW_RESPONSE=
 *    supervised — live it is advisory, so it is a signal, not a backstop.
 *  - The OFF side outlives NIGHT_CHARGE_ADVISOR_ENABLED=false (a separate safety tick
 *    in index.ts), keeps re-issuing OFF every 15 min after the escalation, and
 *    escalates audibly.
 */

import type { NightActuationState } from './nightChargeActuator.js';

/** The panel's documented force-charge ceiling range (`foceChargeHight`). */
export const FORCE_CHARGE_CEILING_MIN_PCT = 80;
export const FORCE_CHARGE_CEILING_MAX_PCT = 100;
/** Don't START a force-charge this close to the window end — it would buy
 *  nothing and cost two writes. */
export const FORCE_CHARGE_MIN_RUN_MS = 20 * 60_000;
/** Hard backstop: no force-charge of ours may outlive this, whatever the window says. */
export const FORCE_CHARGE_MAX_RUN_MS = 7 * 3_600_000;
/** Readback grace after an OFF write before it counts as not-taken. ★ It MUST
 *  exceed FORCE_CHARGE_COOLDOWN_MS (5 min, ecoflow/commands.ts): the re-issue goes
 *  through the same per-slot cooldown, so a shorter grace makes every retry come
 *  back rate-limited — spending the retry budget on writes that never reach the
 *  panel, and escalating a force-charge that was merely slow to read back. */
export const FORCE_CHARGE_OFF_VERIFY_AFTER_MS = 6 * 60_000;
export const FORCE_CHARGE_OFF_MAX_RETRIES = 2;
/** After the escalation the OFF keeps being re-issued on this cadence for as long
 *  as a live readback shows one of our slots ON. Escalation changes how LOUDLY we
 *  report, never WHETHER we keep switching it off — the 2026-08-04 buy ran for hours. */
export const FORCE_CHARGE_OFF_PERSIST_EVERY_MS = 15 * 60_000;
/** A ceiling (foceChargeHight) write must read back before ON may rely on it; above
 *  the 5-min command cooldown for the same reason as the OFF grace. */
export const FORCE_CHARGE_CEILING_VERIFY_AFTER_MS = 6 * 60_000;
export const FORCE_CHARGE_CEILING_SYNC_RETRIES = 1;
export const FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS = 2;

export type ForceChargeOffReason =
  | 'windowEnd' | 'cancelled' | 'reverted' | 'gridLoss' | 'disabled' | 'maxRun';

export interface ForceChargeOpts {
  /** Feature gate — see forceChargeEnabled. Gates ONLY the start. */
  enabled: boolean;
  /** Live grid presence (null = unknown). ON needs true; OFF fires on false. */
  gridPresent: boolean | null;
  /** SHP2 `gridSta` read directly: connected is `=== 1` ONLY (DOCS "Grid presence";
   *  2 is islanded/EPS, 0 is absent). Anything else is an independent grid-loss
   *  signal that turns force-charge OFF even if the resolver disagrees. */
  gridStaLost: boolean;
  /** Live readback of the panel's force-charge ceiling (foceChargeHight); null = no
   *  fresh reading. ON waits until it reads the night's ceiling. */
  ceilingReadbackPct: number | null;
  /** Slots whose LIVE readback reads FORCE_CHARGE_ON; null = no fresh readback. */
  slotsOn: number[] | null;
  /** Slots physically connected (hwConnect) — the candidates for ON. */
  connectedSlots: number[];
  /** Host vitals critical — no new device writes from a struggling process. */
  vitalsRed: boolean;
  /** Live SoC coherence verdict (I11). */
  socCoherent: boolean;
}

export type ForceChargeAction =
  | { kind: 'none' }
  /** Write foceChargeHight; `prior` is the panel's own value, kept for the restore. */
  | { kind: 'syncCeiling'; pct: number; prior: number | null }
  /** Put the panel's own ceiling back once tonight is done with it. */
  | { kind: 'restoreCeiling'; pct: number; lastAttempt: boolean }
  | { kind: 'ceilingRestored' }
  | { kind: 'on'; slots: number[] }
  | { kind: 'off'; slots: number[]; reason: ForceChargeOffReason }
  | { kind: 'offVerified' }
  | { kind: 'offRetry'; slots: number[] }
  | { kind: 'offFailed'; slots: number[] };

/**
 * The feature gate. Wired to options the owner ALREADY set rather than a new one:
 * `ARB_OBJECTIVE=cost` with `ARB_COST_MAX_SOC_PCT` above the reserve ceiling is
 * precisely "buy cheap overnight energy past the reserve". The kill switch is
 * setting ARB_COST_MAX_SOC_PCT to 50 or below (or NIGHT_CHARGE_MODE=advisory).
 */
export function forceChargeEnabled(i: {
  mode: 'advisory' | 'supervised' | 'auto';
  objective: 'cost' | 'resilience';
  costMaxSocPct: number;
  reserveWriteMaxPct: number;
}): boolean {
  return i.mode !== 'advisory'
    && i.objective === 'cost'
    && Number.isFinite(i.costMaxSocPct)
    && i.costMaxSocPct > i.reserveWriteMaxPct;
}

/** The ceiling to sync onto the panel: the night's economic ceiling, clamped into
 *  the device's documented range. (A ceiling below 80 never reaches here — the
 *  start is refused; the clamp is a backstop, not a policy.) */
export function desiredForceChargeCeilingPct(costMaxSocPct: number): number {
  return Math.min(FORCE_CHARGE_CEILING_MAX_PCT,
    Math.max(FORCE_CHARGE_CEILING_MIN_PCT, Math.round(costMaxSocPct)));
}

/** True while a force-charge of ours is on, or its OFF has not yet verified. */
export function forceChargeInFlight(s: NightActuationState): boolean {
  return s.forceChargeOnAtMs != null && s.forceChargeOffVerifiedAtMs == null;
}

function offReason(s: NightActuationState, nowMs: number, o: ForceChargeOpts): ForceChargeOffReason | null {
  if (s.cancelled) return 'cancelled';
  if (s.revertedAtMs != null) return 'reverted';
  // A missing window can't say when to stop, so it stops now.
  if (s.windowEndMs == null || nowMs >= s.windowEndMs) return 'windowEnd';
  if (o.gridPresent === false || o.gridStaLost) return 'gridLoss';
  if (!o.enabled) return 'disabled';
  if (s.forceChargeOnAtMs != null && nowMs - s.forceChargeOnAtMs >= FORCE_CHARGE_MAX_RUN_MS) return 'maxRun';
  return null;
}

/**
 * The per-tick decision. Pure: the integrator executes the action through the
 * audited write helper and persists the observed outcome.
 */
export function decideForceCharge(s: NightActuationState, nowMs: number, o: ForceChargeOpts): ForceChargeAction {
  // An ON is stamped but the slot list is gone (coerced away on a restart): switch
  // off and verify ALL three. An empty list must never verify as "nothing on".
  const ours = s.forceChargeSlots != null && s.forceChargeSlots.length > 0 ? s.forceChargeSlots : [1, 2, 3];

  // ── 1. OFF VERIFICATION. Checked first, and NOT stopped by an escalation: the
  // record must resolve the moment the slots read OFF, or it wedges arming. ──
  if (s.forceChargeOnAtMs != null && s.forceChargeOffAtMs != null && s.forceChargeOffVerifiedAtMs == null) {
    if (o.slotsOn == null) return { kind: 'none' }; // no live readback — wait
    const stillOn = ours.filter((n) => o.slotsOn!.includes(n));
    if (stillOn.length === 0) return { kind: 'offVerified' };
    const since = nowMs - (s.forceChargeOffLastAttemptMs ?? s.forceChargeOffAtMs);
    if (s.forceChargeOffEscalated) {
      // Escalated: keep switching it off, slowly, for as long as it reads ON. An OFF
      // is idempotent and can never make anything worse.
      return since >= FORCE_CHARGE_OFF_PERSIST_EVERY_MS ? { kind: 'offRetry', slots: stillOn } : { kind: 'none' };
    }
    if (since < FORCE_CHARGE_OFF_VERIFY_AFTER_MS) return { kind: 'none' };
    if (s.forceChargeOffRetries < FORCE_CHARGE_OFF_MAX_RETRIES) return { kind: 'offRetry', slots: stillOn };
    return { kind: 'offFailed', slots: stillOn };
  }

  // ── 2. OFF. Once ON, ALWAYS allowed — independent of mode and of `enabled`. ──
  if (s.forceChargeOnAtMs != null && s.forceChargeOffAtMs == null) {
    const reason = offReason(s, nowMs, o);
    return reason ? { kind: 'off', slots: ours, reason } : { kind: 'none' };
  }

  // ── 3. RESTORE the panel's own force-charge ceiling once tonight is done with it.
  // Without this an operator's later storm-prep Charge Now silently stops at tonight's
  // 80-90 instead of the 100 the panel was set to. "Done" = our force-charge verified
  // OFF, or — if it never started — the night is over. ──
  const nightOver = s.cancelled || s.revertedAtMs != null || s.windowEndMs == null || nowMs >= s.windowEndMs;
  const forceDone = s.forceChargeOnAtMs != null ? s.forceChargeOffVerifiedAtMs != null : nightOver;
  if (forceDone && s.forceChargeCeilingPriorPct != null && s.forceChargeCeilingRestoredAtMs == null) {
    if (o.ceilingReadbackPct == null) return { kind: 'none' };
    if (o.ceilingReadbackPct === s.forceChargeCeilingPriorPct) return { kind: 'ceilingRestored' };
    const last = s.forceChargeCeilingRestoreLastAttemptMs;
    if (last != null && nowMs - last < FORCE_CHARGE_CEILING_VERIFY_AFTER_MS) return { kind: 'none' };
    if (s.forceChargeCeilingRestoreAttempts >= FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS) return { kind: 'none' };
    return {
      kind: 'restoreCeiling', pct: s.forceChargeCeilingPriorPct,
      lastAttempt: s.forceChargeCeilingRestoreAttempts + 1 >= FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS,
    };
  }

  // ── 4. ON. At most once per night, and only riding a VERIFIED reserve write. ──
  if (s.forceChargeOnAtMs != null) return { kind: 'none' };
  if (!o.enabled) return { kind: 'none' };
  // The announced plan's economic ceiling — min(owner max-SoC, full minus tomorrow's
  // P90 morning solar). Below the panel's force-charge minimum (80) the device would
  // overfill past the solar headroom — the waste ARB_COST_MAX_SOC_PCT exists to
  // prevent — so that night stays reserve-only. Unknown ceiling: never start.
  if (s.forceChargeCeilingPct == null || !(s.forceChargeCeilingPct >= FORCE_CHARGE_CEILING_MIN_PCT)) {
    return { kind: 'none' };
  }
  if (s.appliedAtMs == null || s.applyVerifiedAtMs == null) return { kind: 'none' };
  if (s.cancelled || s.revertedAtMs != null) return { kind: 'none' };
  if (s.windowStartMs == null || s.windowEndMs == null) return { kind: 'none' };
  if (nowMs < s.windowStartMs || nowMs >= s.windowEndMs - FORCE_CHARGE_MIN_RUN_MS) return { kind: 'none' };
  if (o.vitalsRed || !o.socCoherent) return { kind: 'none' };
  if (o.gridPresent !== true || o.gridStaLost) return { kind: 'none' }; // unknown grid never starts a grid charge
  if (o.slotsOn == null) return { kind: 'none' };     // need a live readback to start
  if (o.slotsOn.length > 0) return { kind: 'none' };  // someone else's Charge Now — never take ownership
  const slots = o.connectedSlots.filter((n) => Number.isInteger(n) && n >= 1 && n <= 3);
  if (slots.length === 0) return { kind: 'none' };
  // The panel must READ the night's ceiling before ON. Issuing ON in the same tick as
  // an unverified ceiling write fills to whatever the panel holds (100 live) — past
  // the owner's ceiling and past the solar headroom the <80 gate exists to protect.
  const desired = desiredForceChargeCeilingPct(s.forceChargeCeilingPct);
  if (o.ceilingReadbackPct == null) return { kind: 'none' };
  if (o.ceilingReadbackPct !== desired) {
    // The first capture of the panel's own value is kept (and carried across nights
    // by armFromPlan while unrestored), so the restore always returns the ORIGINAL.
    const prior = s.forceChargeCeilingPriorPct ?? o.ceilingReadbackPct;
    if (s.forceChargeCeilingAttemptedAtMs == null) return { kind: 'syncCeiling', pct: desired, prior };
    if (nowMs - s.forceChargeCeilingAttemptedAtMs < FORCE_CHARGE_CEILING_VERIFY_AFTER_MS) return { kind: 'none' };
    if (s.forceChargeCeilingSyncRetries < FORCE_CHARGE_CEILING_SYNC_RETRIES) return { kind: 'syncCeiling', pct: desired, prior };
    return { kind: 'none' }; // the panel will not take the ceiling: reserve-only tonight
  }
  return { kind: 'on', slots };
}
