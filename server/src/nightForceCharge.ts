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
 * WHAT (v1.167.0 — CHARGE TO TARGET, JUST IN TIME; design of 2026-09-17). The
 * target is the announced plan's economic ceiling — min(ARB_COST_MAX_SOC_PCT, full minus
 * tomorrow's P50 morning solar; v1.168.0), or before a long gap (the Thursday rule,
 * nightChargeAdvisor.ts longGapAhead) min(ARB_COST_MAX_SOC_PCT, full minus the P10 solar
 * surplus before the evening on-peak; v1.186.0). On a night whose reserve write is APPLIED AND VERIFIED,
 * force-charge switches ON only in the LAST STRETCH of the window — late enough that the
 * pack arrives at the target as the window closes — and OFF the moment it gets there
 * (or at the window close). Requirement: force-charge runs until the desired
 * percentage is reached, then reverts. Any target above the 50% reserve works; the
 * panel's own 80% force-charge minimum no longer matters.
 *
 * ★★ WHY "JUST IN TIME". Once force-charge is OFF the only thing holding the pack up is
 * the 50% reserve, so a pack that reaches 64% at 02:00 is drawn back toward 50% by the
 * house for the three hours left (≈57% at 05:00). But the reserve already charges the
 * pack to ~50% and then HOLDS THE HOUSE ON GRID (2026-09-16: flat at 49% from 01:00 to
 * 05:00). So force-charge only has to add the last stretch, and starting it late means
 * there is nothing left to drain. The start is computed every tick from the live pool:
 * needed kWh ÷ the charge rate + a buffer. v1.169.0: the rate is LIVE — the panel caps
 * its total grid import and the house shares the cap, so the pack gets
 * (ARB_GRID_INPUT_CAP_KW − live house load) × the charge-leg efficiency (forceChargeRateKw;
 * FORCE_CHARGE_PLAN_RATE_KW only when that is unknown). v1.167.0's fixed 10 kW against the
 * 14.6 kW the pack actually took on 2026-09-18 arrived at 90% at 03:30, 1.5 h early.
 * Faster than planned arrives a little early and drains a few minutes; slower (an EV that
 * starts after the switch-on) arrives a little short. It never ends below the reserve.
 *
 * THE PANEL'S CEILING becomes a BACKSTOP. `foceChargeHight` (documented 80-100) is synced
 * to clamp(target, 80, 100) as soon as the night is live — hours before the start, so its
 * readback never delays it. The software stop ends it at every target (forceChargeStopPct);
 * the ceiling only catches a stop that fails (at 80+ it is the target itself, below 80 it
 * is 80). The panel's original ceiling is restored afterwards.
 *
 * ★★ v1.168.0 — COAST ON GRID (2026-09-17). A target of 80+ is one the panel
 * enforces AND HOLDS: with Charge Now still ON at its ceiling the pack sits there and the
 * house runs on grid. So for those targets there is no software stop at the target —
 * force-charge stays ON until the window closes. (That premise did NOT hold — see the
 * 2026-09-18 measurement below.) Below 80 the panel cannot hold the target (its
 * minimum ceiling is 80), so the software stop still ends it there. Dropping the
 * software stop at 80+ also retires a rounding miss: an 85.3 target synced an 85
 * ceiling, and a whole-number pool reading never reached 85.3.
 *
 * ★ That force-charge ON keeps the house on grid is INFERRED from the 2026-08-04 incident
 * (it bought grid for hours), not vendor-documented. 07-23 and 07-28 — the two nights the
 * pack held above 50% on grid — were confirmed (2026-09-17) as manual Charge Now sessions;
 * that is the evidence the coast rested on.
 * ★★★ v1.170.0 — THE COAST IS RETIRED (2026-09-18): the software stop applies at
 * every target again (forceChargeStopPct), so force-charge is on only as long as it charges.
 * ★★★ MEASURED 2026-09-18 — THE COAST DID NOT HOLD. The pack reached the 90% ceiling at
 * 03:30; grid import then fell to 0 W and the house ran from the pack, 90% → 86% by 05:00,
 * with Charge Now still ON. At its ceiling the panel stops importing; it does NOT keep the
 * house on grid. So the coast gives back what a stop at the target would, and only adds
 * Charge Now time — v1.170.0 restored the stop at every target (above), and the
 * live charge rate (v1.169.0) shrinks the early arrival.
 * ★ Not yet measured at a non-90 ceiling: that the whole-number pool reading REACHES the
 * synced ceiling when the pack tops out (09-18 read 90 at the 90 ceiling). If a pack parks
 * one below, the stop never fires and the window-end OFF (and the deadline) end it.
 * ★ Known, safe-side: with a Core out AND an EV predicted, the EV allowance is counted in
 * full though the per-Core bound already absorbs part of it — the start comes early.
 *
 * ★★★ OUTAGE — NOT ESTABLISHED EITHER WAY. No vendor text says how a slot with
 * ch{n}ForceCharge ON behaves when the grid fails, and no outage has ever overlapped
 * Charge Now on this plant. What argues against harm is inference: islanding is a
 * panel-level EPS transfer (gridSta=2), a grid charge has no source once the grid is
 * gone, and this same button has been used by hand with the same exposure since
 * before v1.84.0. The software grid-loss OFF is best-effort (a cloud write). v1.167.0's
 * just-in-time start shrinks the nightly exposure from ~6 h to ~1 h; v1.168.0's coast
 * lengthens it again for 80+ targets (a Thursday: ~4-6 h). Neither settles the question. Settle it with one attended test: Charge Now ON for one slot, open the
 * main breaker, confirm the backed-up loads stay up and the pack discharges.
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
 *    stop even if the feature is disabled mid-night), and fires on: window
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
 *  - ★★★ v1.168.0 — a WALL-CLOCK DEADLINE (forceChargeOffDeadlineMs). Every other
 *    escalation needs a live readback or an accepted OFF: a panel whose readback stays
 *    stale, or a cloud that keeps rejecting the OFF, left the verify loop waiting
 *    forever in silence. The deadline needs only the clock — past it, a force-charge
 *    of ours not verified OFF escalates audibly, and index.ts runs it even when the
 *    panel is missing from the device list.
 *  - ★★ v1.186.0 — ON is readback-verified too (section 2b). Before it, only the reserve,
 *    the OFF and the ceiling were: an ON the cloud rejected, or accepted while the panel
 *    ignored it (the 2026-08-16 phantom-write class, seen on backupReserveSoc), bought
 *    nothing above the reserve, the software stop never fired, and 05:00 logged a clean
 *    "OFF VERIFIED". Now every slot we switched ON must READ FORCE_CHARGE_ON on a live
 *    readback (a slot whose Core already sits at the panel's ceiling is exempt — the panel
 *    switches that one off itself); otherwise ON is re-issued once, then a warning is
 *    logged and pushed. It sits strictly AFTER the OFF triggers, re-issues nothing inside
 *    FORCE_CHARGE_ON_RETRY_CUTOFF_MS of the window end, and an OFF is never held by the
 *    per-slot cooldown an ON took, so it cannot delay the window-end OFF or the deadline;
 *    it decides nothing on a stale readback.
 */

import { RESERVE_WRITE_MAX_PCT, type NightActuationState } from './nightChargeActuator.js';

/** The panel's documented force-charge ceiling range (`foceChargeHight`). */
export const FORCE_CHARGE_CEILING_MIN_PCT = 80;
export const FORCE_CHARGE_CEILING_MAX_PCT = 100;
/** Don't START a force-charge this close to the window end — it would buy
 *  nothing and cost two writes. */
export const FORCE_CHARGE_MIN_RUN_MS = 20 * 60_000;
/** v1.167.0 — the rate the just-in-time start PLANS with. Deliberately below the ~15 kW
 *  into the pack measured on 2026-09-16, because an EV charging at the same time shares
 *  the grid input: faster than planned arrives early and drains a few minutes, slower
 *  arrives short. v1.169.0: only the FALLBACK, when the live rate (forceChargeRateKw) is
 *  unknown — no fresh panel reading of the house load, or no grid cap configured. */
export const FORCE_CHARGE_PLAN_RATE_KW = 10;
/** v1.169.0 — the charge rate is NOT a fixed figure: the panel caps its total GRID IMPORT
 *  and the house draws from the same cap, so the pack gets what the house leaves.
 *  Measured 2026-09-18 01:10-03:25: grid pinned at 19.0-19.1 kW while the house moved
 *  1.3-4.0 kW, and the pack took (19.1 − house) × ~0.93 (13.8-17.0 kW); 2026-08-02, with
 *  the EV drawing (panel load 14.0 kW), the pack took ~2.8 kW = (17 − 14) × 0.927. The
 *  start is timed from forceChargeRateKw with ARB_GRID_INPUT_CAP_KW (17, the conservative
 *  coexistence figure) and the LIVE house load; this floor keeps a house drawing past
 *  the cap from producing a zero or negative rate — the start must then come NOW (the
 *  pack gets almost nothing), never fall back to a faster fixed rate that starts late. */
export const FORCE_CHARGE_MIN_RATE_KW = 1;
/** v1.170.0 — the least each connected Core has been SEEN to take into its pack: on
 *  2026-09-18 three took ~17.8 kW at the grid (≈ 5.5 kW each after the charge leg) while
 *  the grid cap, not the Cores, was the limit. So a Core's own input limit is at least
 *  this — never measured higher. With fewer Cores connected (one out for a pack swap) the
 *  live rate is bounded by slots × this, so the start comes earlier rather than the night
 *  ending short. With all three it never binds (17 × 0.927 = 15.8 < 16.5). */
export const FORCE_CHARGE_PROVEN_KW_PER_SLOT = 5.5;
/** v1.173.0 — the pre-v1.173 fixed grid-side charge cap, kept only as the fallback when the
 *  connected-Core count is unknown (the historical `chChargeWatt` reading). */
export const LEGACY_CHARGE_CAP_KW = 7.2;

/**
 * v1.173.0 — PURE. The planner's GRID-side charge cap. `ARB_CHARGE_CAP_KW` > 0 is an owner
 * override; 0 (the new default) is AUTO: connected Cores × what each is proven to take into
 * its pack, back through the charge leg — the same model the force-charge start uses, so
 * the plan and the charge can no longer disagree. The home load is NOT subtracted here:
 * the planner already takes min(this, ARB_GRID_INPUT_CAP_KW − the hour's load). The fixed
 * 7.2 kW under-stated the ~15 kW the pack actually takes (2026-09-16/18), so every plan
 * announced a lower target than the night reached. Unknown Core count ⇒ the legacy 7.2.
 */
export function planChargeCapKw(optionKw: number, connectedSlots: number | null, legEff: number): number {
  if (Number.isFinite(optionKw) && optionKw > 0) return optionKw;
  if (connectedSlots == null || !Number.isInteger(connectedSlots) || connectedSlots < 1) return LEGACY_CHARGE_CAP_KW;
  if (!Number.isFinite(legEff) || !(legEff > 0)) return LEGACY_CHARGE_CAP_KW;
  return (Math.min(3, connectedSlots) * FORCE_CHARGE_PROVEN_KW_PER_SLOT) / legEff;
}
/** v1.167.0 — added to the computed lead: readback latency, the ramp, the first tick. */
export const FORCE_CHARGE_JIT_BUFFER_MS = 15 * 60_000;
/** Hard backstop: no force-charge of ours may outlive this, whatever the window says. */
export const FORCE_CHARGE_MAX_RUN_MS = 7 * 3_600_000;
/** Readback grace after an OFF write before it counts as not-taken. ★ It MUST
 *  exceed FORCE_CHARGE_COOLDOWN_MS (5 min, ecoflow/commands.ts): the re-issue goes
 *  through the same per-slot cooldown, so a shorter grace makes every retry come
 *  back rate-limited — spending the retry budget on writes that never reach the
 *  panel, and escalating a force-charge that was merely slow to read back. */
export const FORCE_CHARGE_OFF_VERIFY_AFTER_MS = 6 * 60_000;
export const FORCE_CHARGE_OFF_MAX_RETRIES = 2;
/** v1.186.0 — readback grace after an ON write before a slot still reading OFF counts as
 *  not-taken. Same 6 min as the OFF grace, for the same reason: it MUST exceed the 5-min
 *  per-slot cooldown, or the one re-issue comes back rate-limited and is spent on a write
 *  that never reached the panel. (2026-09-23: the drift watch saw OFF→ON ~3 min after the ON.) */
export const FORCE_CHARGE_ON_VERIFY_AFTER_MS = 6 * 60_000;
/** v1.186.0 — ON is re-issued ONCE; still not applied after that ⇒ the warning. */
export const FORCE_CHARGE_ON_MAX_RETRIES = 1;
/** v1.186.0 — no ON re-issue this close to the window end: the warning instead. It is the
 *  start's own "not worth starting" margin, and it MUST be at least the per-slot write
 *  cooldown (5 min, ecoflow/commands.ts) plus FORCE_CHARGE_ON_VERIFY_AFTER_MS, so a re-issue
 *  can never sit in front of the window-end OFF on the same slot, and its PUT (undici's
 *  300 s default) can never hold the actuation lock across the window end. */
export const FORCE_CHARGE_ON_RETRY_CUTOFF_MS = FORCE_CHARGE_MIN_RUN_MS;
/** After the escalation the OFF keeps being re-issued on this cadence for as long
 *  as a live readback shows one of our slots ON. Escalation changes how LOUDLY we
 *  report, never WHETHER we keep switching it off — the 2026-08-04 buy ran for hours. */
export const FORCE_CHARGE_OFF_PERSIST_EVERY_MS = 15 * 60_000;
/** A ceiling (foceChargeHight) write must read back before ON may rely on it; above
 *  the 5-min command cooldown for the same reason as the OFF grace. */
export const FORCE_CHARGE_CEILING_VERIFY_AFTER_MS = 6 * 60_000;
export const FORCE_CHARGE_CEILING_SYNC_RETRIES = 1;
export const FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS = 2;
/** v1.168.0 — the wall-clock deadline: this long after the first OFF, or this long after
 *  the window closes, whichever is LATER. The later of the two keeps a 3 a.m. target OFF
 *  that is merely slow to verify from waking the house — force-charge left on inside the
 *  cheap window costs nothing extra — while one still on an hour into the morning is
 *  buying at the off-peak rate and heading for the on-peak one. */
export const FORCE_CHARGE_OFF_DEADLINE_AFTER_OFF_MS = 30 * 60_000;
export const FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS = 60 * 60_000;
/** v1.173.0 — blind (no-readback) OFF re-sends stop this long after the first OFF. Beyond it
 *  a panel still dark for half a day is more likely to be carrying an operator's manual Charge
 *  Now than ours, and a blind OFF would switch that off. The escalation has already paged. */
export const FORCE_CHARGE_BLIND_RESEND_MAX_MS = 12 * 3_600_000;
/** v1.173.0 — a deadline page silenced by broadcast quiet hours is re-spoken this often
 *  (audible only — the push already went) until it is heard, at most this many times. */
export const FORCE_CHARGE_DEADLINE_REPAGE_MS = 30 * 60_000;
export const FORCE_CHARGE_DEADLINE_REPAGE_MAX = 16;

export type ForceChargeOffReason =
  | 'windowEnd' | 'cancelled' | 'reverted' | 'gridLoss' | 'disabled' | 'maxRun' | 'target';

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
  /** v1.167.0 — live pool SoC (null unless fresh AND coherent): times the start and
   *  ends the charge at the target. Unknown never starts one; it never stops one early. */
  poolSocPct: number | null;
  /** v1.167.0 — live pool size (kWh), for the kWh the target still needs. */
  fullKwh: number | null;
  /** v1.169.0 — the charge rate into the pack the start is timed with (forceChargeRateKw:
   *  the grid-import cap less the live house load). Absent/null ⇒ FORCE_CHARGE_PLAN_RATE_KW. */
  chargeRateKw?: number | null;
  /** v1.169.0 — pack kWh the EV will DISPLACE in the rest of tonight's window: the planner's
   *  predicted (P90) EV energy inside the window × the charge leg. The EV draws from the
   *  same grid cap, so every grid kWh it takes is a kWh the pack does not get. A reading
   *  taken before the car plugs in cannot see it; this does. Absent/null ⇒ 0. */
  evDisplacedKwh?: number | null;
  /** v1.186.0 — each slot's live Core SoC (Shp2EnergySource.batteryPercentage), keyed by
   *  slot, from the SAME fresh readback as slotsOn. The ON verify exempts a slot whose Core
   *  already sits at the panel's ceiling. Absent/null/missing slot ⇒ no exemption. */
  slotSocPct?: Readonly<Record<number, number | null>> | null;
}

export type ForceChargeAction =
  /** `why` — v1.166.0: set whenever the START is declined, so "chose not to" is
   *  distinguishable from "broke" in the log. Absent on the OFF/verify waits. */
  | { kind: 'none'; why?: string }
  /** Write foceChargeHight; `prior` is the panel's own value, kept for the restore. */
  | { kind: 'syncCeiling'; pct: number; prior: number | null }
  /** Put the panel's own ceiling back once tonight is done with it. */
  | { kind: 'restoreCeiling'; pct: number; lastAttempt: boolean }
  | { kind: 'ceilingRestored' }
  | { kind: 'on'; slots: number[] }
  /** v1.186.0 — a live readback shows every slot of ours ON; `atCeiling` = the slots
   *  exempted because their Core already sits at the panel's ceiling. */
  | { kind: 'onVerified'; atCeiling: number[] }
  /** v1.186.0 — slots still reading OFF past the ON grace: re-issue ON to them, once. */
  | { kind: 'onRetry'; slots: number[] }
  /** v1.186.0 — still not ON after the re-issue: warn + push (once; the record keeps
   *  watching, and a late apply still stamps onVerified). `noRetry` — the re-issue was
   *  skipped because the window end was too close (FORCE_CHARGE_ON_RETRY_CUTOFF_MS). */
  | { kind: 'onFailed'; slots: number[]; noRetry?: boolean }
  | { kind: 'off'; slots: number[]; reason: ForceChargeOffReason }
  | { kind: 'offVerified' }
  /** `unconfirmed` — v1.168.0: re-sent with NO live readback (after the escalation). */
  | { kind: 'offRetry'; slots: number[]; unconfirmed?: boolean }
  /** `deadline` — v1.168.0: raised by the wall-clock deadline, not the retry budget.
   *  `unconfirmed` — no live readback, so the slots are the ones we switched on, not
   *  ones seen ON: the alarm must say "could not confirm", never "still reads ON". */
  /** `repage` — v1.173.0: re-speak a deadline page quiet hours silenced (audible only). */
  | { kind: 'offFailed'; slots: number[]; deadline?: boolean; unconfirmed?: boolean; repage?: boolean };

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

/** The ceiling to sync onto the panel: the night's target clamped into the device's
 *  documented range. v1.167.0: below 80 the panel's 80 is a BACKSTOP — the software
 *  stop ends the charge at the target, and the panel caps a stop that fails. */
export function desiredForceChargeCeilingPct(costMaxSocPct: number): number {
  return Math.min(FORCE_CHARGE_CEILING_MAX_PCT,
    Math.max(FORCE_CHARGE_CEILING_MIN_PCT, Math.round(costMaxSocPct)));
}

/** True while a force-charge of ours is on, or its OFF has not yet verified. */
export function forceChargeInFlight(s: NightActuationState): boolean {
  return s.forceChargeOnAtMs != null && s.forceChargeOffVerifiedAtMs == null;
}

/** v1.170.0 — where the software stop ends it: the target, or the panel's own (whole-
 *  number) ceiling when that is lower — an 85.3 target syncs an 85 ceiling, and a whole-
 *  number pool reading never reaches 85.3, so it stops at 85. Below 80 the ceiling is 80
 *  and the target itself is the stop. (v1.168.0's coast skipped this stop at 80+; measured
 *  2026-09-18 it held nothing — at the ceiling the house drew the pack 90 → 86% by 05:00 —
 *  and v1.170.0 retired it.) */
export function forceChargeStopPct(targetPct: number): number {
  return Math.min(targetPct, desiredForceChargeCeilingPct(targetPct));
}

/** v1.168.0 — when a force-charge of ours that has not verified OFF must escalate,
 *  whatever the readback says: the LATER of (first OFF + 30 min) and (window end +
 *  60 min). A missing window counts from the ON — it stops at once (offReason), so it
 *  is judged from its OFF. Null when nothing of ours is in flight. */
export function forceChargeOffDeadlineMs(s: NightActuationState): number | null {
  if (!forceChargeInFlight(s)) return null;
  const fromOff = s.forceChargeOffAtMs != null ? s.forceChargeOffAtMs + FORCE_CHARGE_OFF_DEADLINE_AFTER_OFF_MS : null;
  const fromWindow = (s.windowEndMs ?? s.forceChargeOnAtMs!) + FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS;
  return fromOff != null ? Math.max(fromOff, fromWindow) : fromWindow;
}

function offReason(s: NightActuationState, nowMs: number, o: ForceChargeOpts): ForceChargeOffReason | null {
  if (s.cancelled) return 'cancelled';
  if (s.revertedAtMs != null) return 'reverted';
  // A missing window can't say when to stop, so it stops now.
  if (s.windowEndMs == null || nowMs >= s.windowEndMs) return 'windowEnd';
  if (o.gridPresent === false || o.gridStaLost) return 'gridLoss';
  if (!o.enabled) return 'disabled';
  if (s.forceChargeOnAtMs != null && nowMs - s.forceChargeOnAtMs >= FORCE_CHARGE_MAX_RUN_MS) return 'maxRun';
  // v1.167.0 — stop once the desired percentage is reached. A stale or
  // incoherent SoC never ends it early; the window end and the panel's ceiling still do.
  // v1.170.0 — at EVERY target again (the 80+ coast is retired), against forceChargeStopPct.
  if (
    o.poolSocPct != null && s.forceChargeCeilingPct != null
    && o.poolSocPct >= forceChargeStopPct(s.forceChargeCeilingPct)
  ) return 'target';
  return null;
}

/** v1.186.0 — the ceiling at which the panel switches a slot's force-charge off by
 *  itself: tonight's synced ceiling, or the live readback when that is LOWER (a ceiling
 *  lowered in the app mid-night stops a Core sooner). Null when neither is known. */
function panelStopCeilingPct(s: NightActuationState, o: ForceChargeOpts): number | null {
  const synced = s.forceChargeCeilingPct != null && Number.isFinite(s.forceChargeCeilingPct)
    ? desiredForceChargeCeilingPct(s.forceChargeCeilingPct) : null;
  // v1.186.0 — a readback outside the panel's documented [80, 100] range (a reconnect 0, a
  // stray low value) is not a ceiling: it would exempt every slot and stamp a false ON
  // VERIFIED. Such a reading is ignored and the synced ceiling stands.
  const rb = o.ceilingReadbackPct;
  if (rb == null || !Number.isFinite(rb) || rb < FORCE_CHARGE_CEILING_MIN_PCT || rb > FORCE_CHARGE_CEILING_MAX_PCT) return synced;
  return synced == null ? rb : Math.min(synced, rb);
}

/**
 * v1.186.0 — section 2b: is the ON we issued actually applied? One check shortly after
 * the ON (and one after the re-issue), NOT a watch over the whole run: the panel switches
 * each slot OFF by itself as its Core reaches the ceiling (2026-09-23: ch1 at 04:19, ch3 at
 * 04:30, before the software stop at 04:35), so a slot reading OFF later is not a failure.
 *  - Stale readback (slotsOn null) ⇒ wait. Absence is not evidence either way.
 *  - Every slot of ours reads ON, or its Core already sits at the panel's ceiling ⇒ verified.
 *    Success needs no grace (a reading taken after the write that shows ON is proof), and
 *    it is stamped even after the warning — a late apply resolves the record.
 *  - Past FORCE_CHARGE_ON_VERIFY_AFTER_MS from the last attempt: re-issue ON to the slots
 *    still OFF, once — under the start's own grid and vitals gates, since it is a new grid-
 *    charge write — then warn. The warning is once per night (forceChargeOnFailedAtMs).
 * A REJECTED ON write (cloud error, timeout, rate limit) lands here the same way: its slot
 * never reads ON.
 */
function verifyForceChargeOn(
  s: NightActuationState, nowMs: number, o: ForceChargeOpts, ours: number[],
): ForceChargeAction {
  if (s.forceChargeOnVerifiedAtMs != null) return { kind: 'none' };
  if (o.slotsOn == null) return { kind: 'none' };
  const ceiling = panelStopCeilingPct(s, o);
  const atCeiling = (n: number): boolean => {
    const soc = o.slotSocPct?.[n];
    return ceiling != null && typeof soc === 'number' && Number.isFinite(soc) && soc >= ceiling;
  };
  const notOn = ours.filter((n) => !o.slotsOn!.includes(n) && !atCeiling(n));
  // v1.186.0 — an all-exempt verdict needs at least one slot of ours actually reading ON:
  // with none ON, "every Core at the ceiling" is far likelier a bad reading than a finished
  // charge (ON only starts below the stop), and a false verdict is permanent and silent.
  const anyOn = ours.some((n) => o.slotsOn!.includes(n));
  if (notOn.length === 0 && anyOn) {
    return { kind: 'onVerified', atCeiling: ours.filter((n) => !o.slotsOn!.includes(n)) };
  }
  const pending = notOn.length > 0 ? notOn : ours;
  if (s.forceChargeOnFailedAtMs != null) return { kind: 'none' };
  const since = nowMs - (s.forceChargeOnLastAttemptMs ?? s.forceChargeOnAtMs!);
  if (since < FORCE_CHARGE_ON_VERIFY_AFTER_MS) return { kind: 'none' };
  if (s.forceChargeOnRetries < FORCE_CHARGE_ON_MAX_RETRIES) {
    // v1.186.0 — too close to the window end for a re-issue: it would share the per-slot
    // cooldown with the window-end OFF (which then came back rate-limited and the slot kept
    // grid-charging past the close). Warn instead — the forfeit is reported, never silent.
    if (s.windowEndMs == null || nowMs >= s.windowEndMs - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) {
      return { kind: 'onFailed', slots: pending, noRetry: true };
    }
    // The re-issue starts a grid charge on those slots: the grid must be KNOWN present and
    // the host healthy, exactly as for the start. Otherwise wait — it is not yet a failure.
    if (o.gridPresent !== true || o.vitalsRed) return { kind: 'none' };
    return { kind: 'onRetry', slots: pending };
  }
  return { kind: 'onFailed', slots: pending };
}

/** v1.186.0 — the ON-verify verdict /api/night-charge/status serves beside forceChargeOnAtMs:
 *  null = no force-charge tonight; 'unverified' = ON issued, no live readback has proven it
 *  yet (stays so if the night ends that way). */
export function forceChargeOnVerifyStatus(
  s: NightActuationState,
): 'verified' | 'failed' | 'unverified' | null {
  if (s.forceChargeOnAtMs == null) return null;
  if (s.forceChargeOnVerifiedAtMs != null) return 'verified';
  if (s.forceChargeOnFailedAtMs != null) return 'failed';
  return 'unverified';
}

/**
 * The per-tick decision. Pure: the integrator executes the action through the
 * audited write helper and persists the observed outcome.
 */
export function decideForceCharge(s: NightActuationState, nowMs: number, o: ForceChargeOpts): ForceChargeAction {
  // An ON is stamped but the slot list is gone (coerced away on a restart): switch
  // off and verify ALL three. An empty list must never verify as "nothing on".
  const ours = s.forceChargeSlots != null && s.forceChargeSlots.length > 0 ? s.forceChargeSlots : [1, 2, 3];

  // ── 0. WALL-CLOCK DEADLINE (v1.168.0). Ahead of every readback wait below: a readback
  // that never comes back, or an OFF the cloud keeps refusing, must not hold the alarm
  // off forever. It pages ONCE, on its own record — NOT on forceChargeOffEscalated: an
  // earlier retry-budget escalation may have landed in quiet hours and been silent, and
  // must not disarm this one (review, 2026-09-17). A live readback showing all our slots
  // OFF falls through to be verified, not escalated. ──
  if (s.forceChargeOffDeadlinePagedAtMs == null) {
    const deadline = forceChargeOffDeadlineMs(s);
    if (deadline != null && nowMs >= deadline) {
      const stillOn = o.slotsOn == null ? ours : ours.filter((n) => o.slotsOn!.includes(n));
      if (stillOn.length > 0) return { kind: 'offFailed', slots: stillOn, deadline: true, unconfirmed: o.slotsOn == null };
    }
  } else if (
    // v1.173.0 — the deadline paged INSIDE broadcast quiet hours (Friday's 1-hour window puts
    // it at Sat 01:00) and was not spoken. Re-speak it every 30 min until it is heard.
    forceChargeInFlight(s) && s.forceChargeOffDeadlineMutedAtMs != null
    && nowMs - s.forceChargeOffDeadlineMutedAtMs >= FORCE_CHARGE_DEADLINE_REPAGE_MS
    && s.forceChargeOffDeadlineRepages < FORCE_CHARGE_DEADLINE_REPAGE_MAX
  ) {
    const stillOn = o.slotsOn == null ? ours : ours.filter((n) => o.slotsOn!.includes(n));
    if (stillOn.length > 0) {
      return { kind: 'offFailed', slots: stillOn, deadline: true, unconfirmed: o.slotsOn == null, repage: true };
    }
  }

  // ── 1. OFF VERIFICATION. Checked first, and NOT stopped by an escalation: the
  // record must resolve the moment the slots read OFF, or it wedges arming. ──
  if (s.forceChargeOnAtMs != null && s.forceChargeOffAtMs != null && s.forceChargeOffVerifiedAtMs == null) {
    const since = nowMs - (s.forceChargeOffLastAttemptMs ?? s.forceChargeOffAtMs);
    if (o.slotsOn == null) {
      // No live readback. Before the escalation, wait for one. After it, keep re-sending
      // the OFF blind on the persistence cadence (v1.168.0, review): an OFF is idempotent,
      // and a stale readback plus one rejected 05:00 OFF otherwise left it on all day.
      return s.forceChargeOffEscalated && since >= FORCE_CHARGE_OFF_PERSIST_EVERY_MS
        && nowMs - s.forceChargeOffAtMs < FORCE_CHARGE_BLIND_RESEND_MAX_MS
        ? { kind: 'offRetry', slots: ours, unconfirmed: true }
        : { kind: 'none' };
    }
    const stillOn = ours.filter((n) => o.slotsOn!.includes(n));
    if (stillOn.length === 0) return { kind: 'offVerified' };
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
    if (reason) return { kind: 'off', slots: ours, reason };
    // ── 2b. ON VERIFICATION (v1.186.0). Only when no OFF is due, and no re-issue inside
    // FORCE_CHARGE_ON_RETRY_CUTOFF_MS of the window end; an OFF is also never held by the
    // per-slot cooldown an ON took (ecoflow/commands.ts), so a re-issue cannot delay the
    // window-end, target or grid-loss OFF. ──
    return verifyForceChargeOn(s, nowMs, o, ours);
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
  if (!o.enabled) return { kind: 'none', why: 'disabled (NIGHT_CHARGE_MODE advisory, ARB_OBJECTIVE not cost, or ARB_COST_MAX_SOC_PCT at or below the 50% reserve)' };
  // v1.167.0 — the target is the announced plan's economic ceiling. Anything above the
  // reserve is reachable: the software stop ends it at the target, whatever the panel's
  // 80% force-charge minimum. At or below the reserve there is nothing to add.
  const target = s.forceChargeCeilingPct;
  if (target == null || !Number.isFinite(target)) {
    return { kind: 'none', why: 'no economic ceiling was announced for this night (resilience mode, or armed before v1.165.0) — reserve-only night' };
  }
  if (target <= RESERVE_WRITE_MAX_PCT) {
    return { kind: 'none', why: `tonight's ${target}% target is at or below the ${RESERVE_WRITE_MAX_PCT}% reserve — the reserve alone reaches it` };
  }
  if (s.appliedAtMs == null || s.applyVerifiedAtMs == null) return { kind: 'none', why: 'waiting for the reserve write to be verified by readback' };
  if (s.cancelled || s.revertedAtMs != null) return { kind: 'none', why: s.cancelled ? 'the night was cancelled' : 'the reserve has already been reverted' };
  if (s.windowStartMs == null || s.windowEndMs == null) return { kind: 'none', why: 'the night has no charge window' };
  if (nowMs < s.windowStartMs) return { kind: 'none', why: 'the overnight window has not opened yet' };
  if (nowMs >= s.windowEndMs - FORCE_CHARGE_MIN_RUN_MS) return { kind: 'none', why: `under ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min of window left — not worth starting` };
  if (o.vitalsRed) return { kind: 'none', why: 'host vitals are critical — no new device writes' };
  if (!o.socCoherent) return { kind: 'none', why: 'the pool SoC reading is incoherent' };
  if (o.gridPresent !== true || o.gridStaLost) { // unknown grid never starts a grid charge
    return { kind: 'none', why: o.gridStaLost ? 'the panel reports the grid is not connected (gridSta ≠ 1)' : `grid presence is ${o.gridPresent === false ? 'ABSENT' : 'unknown'}` };
  }
  if (o.slotsOn == null) return { kind: 'none', why: 'no live slot readback from the panel' }; // need a live readback to start
  if (o.slotsOn.length > 0) return { kind: 'none', why: `Charge Now is already ON for slot(s) ${o.slotsOn.join(', ')} — that is the operator's, never taken over` }; // someone else's Charge Now — never take ownership
  const slots = o.connectedSlots.filter((n) => Number.isInteger(n) && n >= 1 && n <= 3);
  if (slots.length === 0) return { kind: 'none', why: 'no battery slots are connected' };
  // The panel must READ its backstop ceiling before ON. Issuing ON in the same tick as an
  // unverified ceiling write leaves a failed software stop to fill to whatever the panel
  // holds (100 live) — past the owner's ceiling and past the solar headroom.
  const desired = desiredForceChargeCeilingPct(target);
  if (o.ceilingReadbackPct == null) return { kind: 'none', why: 'no live readback of the panel\'s force-charge ceiling' };
  if (o.ceilingReadbackPct !== desired) {
    // The first capture of the panel's own value is kept (and carried across nights
    // by armFromPlan while unrestored), so the restore always returns the ORIGINAL.
    const prior = s.forceChargeCeilingPriorPct ?? o.ceilingReadbackPct;
    if (s.forceChargeCeilingAttemptedAtMs == null) return { kind: 'syncCeiling', pct: desired, prior };
    if (nowMs - s.forceChargeCeilingAttemptedAtMs < FORCE_CHARGE_CEILING_VERIFY_AFTER_MS) return { kind: 'none', why: `waiting for the panel's ceiling to read ${desired}% (reads ${o.ceilingReadbackPct}%)` };
    if (s.forceChargeCeilingSyncRetries < FORCE_CHARGE_CEILING_SYNC_RETRIES) return { kind: 'syncCeiling', pct: desired, prior };
    return { kind: 'none', why: `the panel would not take the ${desired}% ceiling (still reads ${o.ceilingReadbackPct}%) — reserve-only tonight rather than overfill` };
  }
  // v1.167.0 — JUST IN TIME. The ceiling above is synced the moment the night is live,
  // hours before this, so its readback never delays the start.
  if (o.poolSocPct == null || o.fullKwh == null || !(o.fullKwh > 0)) {
    return { kind: 'none', why: 'no live pool reading to time the start from' };
  }
  if (o.poolSocPct >= forceChargeStopPct(target)) return { kind: 'none', why: `the pack is already at tonight's ${target}% target` };
  if (nowMs < forceChargeStartAtMs(s.windowEndMs!, target, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh)) { // window checked above
    // A STABLE reason: the computed start moves with the SoC, and a reason that changes
    // every tick would log every tick.
    return { kind: 'none', why: `just in time — holding off so the pack reaches ${target}% as the window closes, not hours early (which would let the house draw it back toward the reserve)` };
  }
  return { kind: 'on', slots };
}

/**
 * v1.167.0 — PURE. When force-charge should switch on to reach `targetPct` as the window
 * closes: the kWh still needed at the charge rate, plus the buffer, before the end.
 * v1.169.0 — the rate is the live one (forceChargeRateKw); unknown ⇒ the fixed plan rate.
 */
export function forceChargeStartAtMs(
  windowEndMs: number, targetPct: number, poolSocPct: number, fullKwh: number,
  rateKw?: number | null, evDisplacedKwh?: number | null,
): number {
  // Unknown ⇒ the fixed plan rate. A known rate under the floor is FLOORED (start sooner),
  // never replaced by the faster fixed rate (which would start later and end short).
  const rate = rateKw != null && Number.isFinite(rateKw)
    ? Math.max(FORCE_CHARGE_MIN_RATE_KW, rateKw) : FORCE_CHARGE_PLAN_RATE_KW;
  const evKwh = evDisplacedKwh != null && Number.isFinite(evDisplacedKwh) ? Math.max(0, evDisplacedKwh) : 0;
  const neededKwh = Math.max(0, ((targetPct - poolSocPct) / 100) * fullKwh) + evKwh;
  const leadMs = (neededKwh / rate) * 3_600_000 + FORCE_CHARGE_JIT_BUFFER_MS;
  return windowEndMs - leadMs;
}

/**
 * v1.173.0 — PURE. The pack kWh a predicted EV session will DISPLACE in the rest of the
 * window. The EV draws from the grid cap, so with the cap binding every grid kWh it takes
 * is ~legEff kWh the pack does not get. But when the per-Core bound is what limits the
 * rate (a Core out), there is SLACK under the cap — (unbounded rate − bounded rate) — that
 * the EV consumes first: the pack loses only max(0, EV kW × legEff − slack) per hour. With
 * the session's hours taken as energy ÷ its peak power, the displaced energy is
 * evKwh × max(0, legEff − slack ÷ peakEvKw). No slack (all Cores in) ⇒ evKwh × legEff, as
 * v1.169.0. The v1.170.0 review measured the old full count starting ~2.5 h early with one
 * Core out and an EV predicted.
 */
export function evDisplacedPackKwh(i: {
  evKwh: number | null; peakEvKw: number | null; rateKw: number | null;
  unboundedRateKw: number | null; legEff: number;
}): number | null {
  if (i.evKwh == null || !Number.isFinite(i.evKwh)) return null;
  const ev = Math.max(0, i.evKwh);
  const slack = i.rateKw != null && i.unboundedRateKw != null && Number.isFinite(i.rateKw) && Number.isFinite(i.unboundedRateKw)
    ? Math.max(0, i.unboundedRateKw - i.rateKw) : 0;
  const factor = slack > 0 && i.peakEvKw != null && i.peakEvKw > 0
    ? Math.max(0, i.legEff - slack / i.peakEvKw) : i.legEff;
  return ev * factor;
}

/**
 * v1.169.0 — PURE. The live house load at the panel (kW): the sum of the SHP2 circuits'
 * watts, the same quantity the recorder stores as `panel_load` (it includes the EV
 * charger). Null unless at least one circuit reports a finite number.
 */
export function shp2HouseLoadKw(sp: { circuits?: unknown } | null | undefined): number | null {
  const circuits = Array.isArray(sp?.circuits) ? (sp!.circuits as any[]) : null;
  if (!circuits) return null;
  let w = 0;
  let any = false;
  for (const c of circuits) {
    if (typeof c?.watts === 'number' && Number.isFinite(c.watts)) { w += c.watts; any = true; }
  }
  return any ? w / 1000 : null;
}

/**
 * v1.169.0 — PURE. The charge rate into the pack while force-charging: the panel's grid-
 * import cap less the house's own draw, through the charge leg (legEff ≈ 0.927). Floored
 * at FORCE_CHARGE_MIN_RATE_KW; null when the cap or the live house load is unknown (the
 * caller then falls back to FORCE_CHARGE_PLAN_RATE_KW). Recomputed every tick until the
 * start, so the start follows the house's actual usage.
 */
export function forceChargeRateKw(i: {
  gridCapKw: number | null; houseLoadKw: number | null; legEff: number;
  /** v1.170.0 — connected battery slots; bounds the rate at slots × the proven per-Core rate. */
  slotCount?: number | null;
}): number | null {
  if (i.gridCapKw == null || !Number.isFinite(i.gridCapKw) || !(i.gridCapKw > 0)) return null;
  if (i.houseLoadKw == null || !Number.isFinite(i.houseLoadKw)) return null;
  if (!Number.isFinite(i.legEff) || !(i.legEff > 0)) return null;
  let rate = (i.gridCapKw - Math.max(0, i.houseLoadKw)) * i.legEff;
  if (i.slotCount != null && Number.isInteger(i.slotCount) && i.slotCount > 0) {
    rate = Math.min(rate, i.slotCount * FORCE_CHARGE_PROVEN_KW_PER_SLOT);
  }
  return Math.max(FORCE_CHARGE_MIN_RATE_KW, rate);
}
