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
 * ★★★ v1.200.0 — THE LINE NIGHT LENGTHENS THE EXPOSURE, AND REACHES PLANTS THAT NEVER HAD IT. On a night
 * whose outage-cushion line is above the 50% reserve (forceChargeModeOf 'line'), Charge Now is ON from its
 * timed start to the window close, in supervised or auto mode, whatever ARB_OBJECTIVE says: a resilience-
 * objective plant gets Charge Now for the first time. Emulated over the year's line shapes (the panel's
 * own OFF at its ceiling modelled) a slot reads Charge Now ON for 74 min on average, 142 min for lines of
 * 70-90%, and 138 min on the year's lines with a 20 kWh EV predicted (the start comes earlier). The off
 * switches: NIGHT_CHARGE_MODE advisory, the per-night cancel, or a cushion whose line is at or under 50%.
 * The attended test above is recommended before a resilience plant runs line nights.
 *
 * ★★★ v1.200.0 — THE OUTAGE LINE ABOVE THE RESERVE ENVELOPE (forceChargeModeOf). A charge plan whose
 * islanded-outage line, asked to the whole percent above it (⌈L⌉), is above the 50% the panel accepts as a
 * reserve carries that ask (NightChargePlan.forceChargeLine); the armed record keeps it in its own field
 * (forceChargeLineAskPct) beside the cost ceiling (forceChargeCeilingPct, unchanged in meaning). Each tick
 * composes the mode from the LIVE gates — the cost force-charge (forceChargeEnabled) and the line
 * (lineForceChargeEnabled: any write mode) — never from one stored target:
 *  - 'cost' — today's force-charge exactly: no line, or a cost stop already at ⌈L⌉ + 2H or above;
 *  - 'line' — the start is timed to reach max(target, ⌈L⌉ + H) at the close − FORCE_CHARGE_MIN_RUN_MS
 *    (forceChargeLineStartAtMs), so even a one-point lift starts outside the dead zone; there is NO
 *    software stop — it runs to the window close (or the on-peak guard, grid loss, the gates off, max
 *    run); the panel ceiling is desiredForceChargeCeilingPct(max(target, ⌈L⌉ + 2H)). While Charge Now is ON
 *    under that ceiling the house and an EV ride the grid, so a load that starts after the start cannot
 *    draw the pool under the line. AT the ceiling the panel switches each slot OFF by itself and leaves
 *    it OFF (2026-09-18 / 09-23 / 10-02), so a pool that reaches it early (a predicted EV pulling the start
 *    forward) is drawn back down by a late load: the tick switches the slots back ON under the start
 *    target (lineReOnDue, ≤ FORCE_CHARGE_LINE_REON_MAX a night). Design A's drain-aware hold (a stop at
 *    ⌈L⌉ plus the drain to the close) closed under the line on 197 of 200 nights with a 7 kW EV plugging
 *    in 30 minutes before the close; the price of running to the close is the overshoot (~⌈L⌉ + 13 on
 *    average, emulated) — overnight energy stored, not lost.
 *    WHAT IT DOES NOT CARRY (lineForceChargeClose.test.ts, emulated, pinned): a late UNPREDICTED load that
 *    takes the grid cap after the start — the start was timed on a rate the pack then does not get. An
 *    11.52 kW EV (EV_MAX_LOAD_W's default) arriving 90 min before the close closes 73 of 200 year nights
 *    under the line; a 7 kW one from 120 min, 5; an ON 5 min late with a 7 kW EV from 90 min, 1. Slow
 *    packs at lines of 70-90% (8 / 35 at 70% of the rate). A cost-dominant night (cost mode, its own
 *    software stop) with a late EV at a line of 70-90% (5 to 15 of 140).
 * The measured capacity scale never reaches this module: the record carries one whole percent (⌈L⌉), a
 * plan output like the setpoint (runwayBasisContracts.test.ts pin 6).
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
 *    hold it on); and (R1) the on-peak guard, an hour before the on-peak period
 *    after the window when that comes first, and a reserve that settled as someone
 *    else's (nightChargeActuator.foreignStep).
 *  - ★★ R1 — THE ON-PEAK GUARD. The ceiling sync, the ON and the ON re-issue are raises:
 *    none is issued past writeWindowEndMs (the window close, or an hour before the
 *    stamped on-peak start, whichever is sooner), and the just-in-time start counts back
 *    from it. The wall-clock OFF deadline is capped ON_PEAK_PAGE_LEAD_MS before on-peak,
 *    and blind OFF re-sends stop at the next charge window's open (blindResendStopMs).
 *    The overnight window closes eleven hours before on-peak: none of this moves a night
 *    that goes to plan.
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

import {
  RESERVE_WRITE_MAX_PCT, armedForceChargeCeilingPct, clampReserveTarget, type NightActuationState,
  writeWindowEndMs, ON_PEAK_PAGE_LEAD_MS,
} from './nightChargeActuator.js';
import type { ForceChargeCommands } from './settingsDrift.js';
import { FORCE_CHARGE_CEILING_MIN_PCT, FORCE_CHARGE_CEILING_MAX_PCT, SHP2_SOURCE_SLOTS } from './hwSpec.js';
import { limits } from './limits.js';
import { coreLabel, coreNumber } from './topology.js';

/** The panel's documented force-charge ceiling range (`foceChargeHight`): 80..100, a hardware fact
 *  (hwSpec.ts since v1.191.0), re-exported here for the existing importers. */
export { FORCE_CHARGE_CEILING_MIN_PCT, FORCE_CHARGE_CEILING_MAX_PCT };
/** Every SHP2 source slot, 1..SHP2_SOURCE_SLOTS: the slots a force-charge of ours may have switched. */
const ALL_SOURCE_SLOTS: readonly number[] = Array.from({ length: SHP2_SOURCE_SLOTS }, (_, i) => i + 1);
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
/** v1.191.0 (H1) — the per-Core rate in use: FORCE_CHARGE_KW_PER_CORE when it is set above 0, else
 *  the proven FORCE_CHARGE_PROVEN_KW_PER_SLOT. Read per call (limits.ts). */
export function forceChargeKwPerCore(): number {
  return limits.forceChargeKwPerCore ?? FORCE_CHARGE_PROVEN_KW_PER_SLOT;
}
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
  return (Math.min(SHP2_SOURCE_SLOTS, connectedSlots) * forceChargeKwPerCore()) / legEff;
}
/**
 * v1.191.0 (H2) — PURE apart from the option read. The rate the just-in-time start plans with when
 * the live rate is unknown: the fixed FORCE_CHARGE_PLAN_RATE_KW while FORCE_CHARGE_KW_PER_CORE is
 * unset or the connected-Core count is unknown (today's behaviour), else connected slots × that
 * rate (pack side, as forceChargeRateKw's bound).
 */
export function planRateFallbackKw(slotCount?: number | null): number {
  const perCore = limits.forceChargeKwPerCore;
  if (perCore == null || slotCount == null || !Number.isInteger(slotCount) || slotCount < 1) return FORCE_CHARGE_PLAN_RATE_KW;
  return Math.min(SHP2_SOURCE_SLOTS, slotCount) * perCore;
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
 *  not-taken. It MUST exceed the 5-min per-slot cooldown, or the one re-issue comes back
 *  rate-limited and is spent on a write that never reached the panel. (2026-09-23: the drift
 *  watch saw OFF→ON ~3 min after the ON.)
 *  v1.187.12 — 15 min (was 6). A slot's ON can take longer than 6 min to read back: on
 *  2026-10-05 and 10-06 a slot was re-issued at +7 min and given up at +14 min, yet on 10-06
 *  the pool reached the night's target 19 min AHEAD of a plan sized for all three slots, so
 *  that slot was charging and only its readback lagged. The give-up comes at +30 min now. It
 *  is the longest grace the window-end cutoff allows (FORCE_CHARGE_ON_RETRY_CUTOFF_MS ≥
 *  cooldown + this, pinned in edges.test.ts). */
export const FORCE_CHARGE_ON_VERIFY_AFTER_MS = 15 * 60_000;
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
  | 'windowEnd' | 'cancelled' | 'reverted' | 'gridLoss' | 'disabled' | 'maxRun' | 'target'
  /** The on-peak guard: an hour before the on-peak period that follows the window, when that
   *  comes before the window close (nightChargeActuator.writeWindowEndMs). */
  | 'onPeakGuard'
  /** The reserve settled as someone else's (nightChargeActuator.foreignStep): the night's
   *  write no longer holds it, so the force-charge riding it stops too. */
  | 'foreign';

export interface ForceChargeOpts {
  /** Feature gate — see forceChargeEnabled. Gates ONLY the start. v1.200.0 — the COST force-charge's
   *  gate; the line's is `lineEnabled`, and the mode is composed from both every tick (forceChargeModeOf). */
  enabled: boolean;
  /** v1.200.0 — the outage-line force-charge's gate (lineForceChargeEnabled: a write mode; never the
   *  backup leg), read LIVE each tick. Absent ⇒ false: a record with a line ask rides the cost gate alone. */
  lineEnabled?: boolean;
  /** Live grid presence (null = unknown). ON needs true; OFF fires on false. */
  gridPresent: boolean | null;
  /** SHP2 `gridSta` read directly: connected is `=== 1` ONLY (2 is islanded/EPS, 0 is
   *  absent; docs/reference/02-1-cloud-protocol-and-snapshot.md “Backup pool + grid
   *  presence”). Anything else is an independent grid-loss
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
  /** The open of the next charge window after this night's (the latest plan's window, when it
   *  opens after this one closes). Blind OFF re-sends stop there at the latest
   *  (blindResendStopMs): past it a force-charge reading ON may be the next window's own.
   *  Absent/null ⇒ unknown: FORCE_CHARGE_BLIND_RESEND_MAX_MS alone bounds them. */
  nextLegOpenMs?: number | null;
  /** v1.191.0 (S6, plan 3.4 W5) — the run backstop of the tariff in effect (nightSchedule.ts
   *  forceChargeMaxRunMs: FORCE_CHARGE_MAX_RUN_MS on the APS preset, max(7 h, the plan's nominal
   *  cheap window + 1 h) otherwise). It comes from the tariff, never from the armed window, so a
   *  corrupted window still cannot hold a force-charge on. Absent/null ⇒ FORCE_CHARGE_MAX_RUN_MS. */
  maxRunMs?: number | null;
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
  /** v1.200.0 (review) — a LINE night after a verified ON: these slots of ours read OFF (the panel switches
   *  a slot off by itself at its ceiling, and it stays off) and the pool has fallen back under the start
   *  target. Switch them back ON (at most FORCE_CHARGE_LINE_REON_MAX a night; lineReOnDue). */
  | { kind: 'lineReOn'; slots: number[] }
  /** v1.200.0 (review 2) — a line re-ON's readback check, FORCE_CHARGE_ON_VERIFY_AFTER_MS after it, as the first ON
   *  has: `slots` the re-ON switched, `notApplied` those still reading OFF (their Cores under the panel's ceiling)
   *  — [] when it took effect (lineReOnCheckDue). Writes nothing. */
  | { kind: 'lineReOnChecked'; slots: number[]; notApplied: number[] }
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

/** v1.200.0 — H, the headroom of the outage-line force-charge: its start is timed to ⌈L⌉ + H at the close
 *  less FORCE_CHARGE_MIN_RUN_MS, and its panel ceiling is at least ⌈L⌉ + 2H. A line rides only where
 *  ⌈L⌉ + 2H ≤ 100 (nightChargeAdvisor.ts discloses the rest). */
export const FORCE_CHARGE_LINE_HEADROOM_PCT = 5;

/** v1.200.0 (review) — the LINE re-ONs a night may spend (lineReOnDue). The panel switches a slot's Charge
 *  Now OFF by itself as its Core reaches the force-charge ceiling, and does not switch it back on
 *  (2026-09-18: 90 → 86% with Charge Now still set; 2026-09-23: ch1 at 04:19, ch3 at 04:30). An early
 *  start (a predicted EV) can reach the ceiling hours before the close; a load that arrives after that
 *  draws the pool back down. Two re-ONs cover a second latch on a long night (lineForceChargeClose.test.ts). */
export const FORCE_CHARGE_LINE_REON_MAX = 2;

/**
 * v1.200.0 — the outage-line force-charge's gate: any write mode (supervised or auto). Not the cost
 * objective, not ARB_COST_MAX_SOC_PCT: those gate the COST force-charge only (forceChargeEnabled). The
 * off switches are NIGHT_CHARGE_MODE advisory and the per-night cancel. A backup leg never rides it
 * (chargeWindows.legForceChargeEligible). PURE.
 */
export function lineForceChargeEnabled(i: { mode: 'advisory' | 'supervised' | 'auto' }): boolean {
  return i.mode !== 'advisory';
}

/** v1.200.0 — the two force-charge gates as they read NOW (index.ts forceChargeOn / lineForceChargeOn). */
export interface ForceChargeGates { cost: boolean; line: boolean }

/** v1.200.0 — the force-charge a tick runs (forceChargeModeOf). */
export type ForceChargeMode =
  | { kind: 'cost'; targetPct: number; panelCeilingPct: number }
  | { kind: 'line'; targetPct: number; askPct: number; startTargetPct: number; panelCeilingPct: number };

/**
 * v1.200.0 — PURE. The force-charge a record rides under the LIVE gates:
 *  - the cost force-charge rides when its gate is on and its ceiling is above the reserve maximum;
 *  - the line rides when its gate is on and the record carries a line ask;
 *  - LINE mode, unless the cost stop already reaches ⌈L⌉ + 2H: the target is max(cost, ⌈L⌉) (the ask
 *    alone with the cost gate off — never the cost ceiling), the start is timed to max(target, ⌈L⌉ + H),
 *    and the panel ceiling is desiredForceChargeCeilingPct(max(target, ⌈L⌉ + 2H));
 *  - else COST mode: today's force-charge exactly;
 *  - null: neither rides.
 * One stored target for both would let a cost ceiling outlive its own kill switch, and lower the
 * night's target below today's on a restart with the option changed (critique A R4).
 */
export function forceChargeModeOf(
  s: Pick<NightActuationState, 'forceChargeCeilingPct' | 'forceChargeLineAskPct'>,
  gates: ForceChargeGates,
): ForceChargeMode | null {
  const c = s.forceChargeCeilingPct;
  const costOk = gates.cost && c != null && Number.isFinite(c) && c > RESERVE_WRITE_MAX_PCT;
  const ask = s.forceChargeLineAskPct;
  const lineOk = gates.line && ask != null && Number.isFinite(ask) && ask > RESERVE_WRITE_MAX_PCT;
  const H = FORCE_CHARGE_LINE_HEADROOM_PCT;
  if (lineOk && !(costOk && forceChargeStopPct(c!) >= ask! + 2 * H)) {
    const t = costOk ? Math.max(c!, ask!) : ask!;
    return {
      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: Math.max(t, ask! + H),
      panelCeilingPct: desiredForceChargeCeilingPct(Math.max(t, ask! + 2 * H)),
    };
  }
  if (costOk) return { kind: 'cost', targetPct: c!, panelCeilingPct: desiredForceChargeCeilingPct(c!) };
  return null;
}

/** v1.200.0 — PURE. Whether either force-charge may ride the record at all under these gates: the cost
 *  gate (today's `enabled`), or the line gate on a record with a line ask. A record with no ask reads
 *  exactly today's `enabled` (I-A2). */
function anyForceChargeGate(s: Pick<NightActuationState, 'forceChargeLineAskPct'>, gates: ForceChargeGates): boolean {
  return gates.cost || (gates.line && s.forceChargeLineAskPct != null && Number.isFinite(s.forceChargeLineAskPct));
}

/** v1.200.0 — the gates a tick's opts carry. */
function gatesOf(o: Pick<ForceChargeOpts, 'enabled' | 'lineEnabled'>): ForceChargeGates {
  return { cost: o.enabled, line: o.lineEnabled === true };
}

/**
 * v1.200.0 — PURE. When the LINE force-charge should switch on: timed to reach `startTargetPct` at
 * FORCE_CHARGE_MIN_RUN_MS before the window end (forceChargeStartAtMs counted back from there), so a lift
 * of a single point still starts outside the "not worth starting" dead zone, and the pool is at the
 * start target before the close with the last twenty minutes still ON.
 */
export function forceChargeLineStartAtMs(
  writeEndMs: number, startTargetPct: number, poolSocPct: number, tickPoolKwh: number,
  rateKw?: number | null, evDisplacedKwh?: number | null, slotCount?: number | null,
): number {
  return forceChargeStartAtMs(writeEndMs - FORCE_CHARGE_MIN_RUN_MS, startTargetPct, poolSocPct, tickPoolKwh, rateKw, evDisplacedKwh, slotCount);
}

/** v1.200.0 — the "why not" of a start declined by something other than the pool or the clock: the ceiling
 *  refused, Charge Now already on, the grid unknown or absent, vitals red, no slot readback, an incoherent
 *  SoC — and (review) no live readback of the panel's ceiling, or no battery slot connected (the Cores dark),
 *  either of which can hold a line night's start all night. On a line night each class pushes once it has
 *  persisted (lineDeclinedPushStep; index.ts, buildLineForceChargeDeclinedStart). */
export const FORCE_CHARGE_BLOCKER_WHY = Object.freeze({
  vitals: 'host vitals are critical — no new device writes',
  incoherent: 'the pool SoC reading is incoherent',
  gridSta: 'the panel reports the grid is not connected (gridSta ≠ 1)',
  gridPresence: 'grid presence is ',
  noReadback: 'no live slot readback from the panel',
  alreadyOn: 'Charge Now is already ON for slot(s) ',
  noSlots: 'no battery slots are connected',
  ceilingReadback: 'no live readback of the panel\'s force-charge ceiling',
  ceilingRefused: 'the panel would not take the ',
});

/** v1.200.0 (review) — the class of a declined start's `why` (a FORCE_CHARGE_BLOCKER_WHY key), or null when it
 *  is the clock, the pool or anything else. PURE. */
export function forceChargeBlockerClass(why: string | null | undefined): keyof typeof FORCE_CHARGE_BLOCKER_WHY | null {
  if (typeof why !== 'string') return null;
  const hit = (Object.entries(FORCE_CHARGE_BLOCKER_WHY) as Array<[keyof typeof FORCE_CHARGE_BLOCKER_WHY, string]>).find(([, w]) => why.startsWith(w));
  return hit ? hit[0] : null;
}

/** v1.200.0 — PURE. Is a declined start's `why` one of FORCE_CHARGE_BLOCKER_WHY's (never the clock or the pool)? */
export function isForceChargeStartBlocker(why: string | null | undefined): boolean {
  return forceChargeBlockerClass(why) != null;
}

/** v1.200.0 (review) — how long one blocker class must hold a line night's start, unbroken, before it is
 *  pushed: a stale readback for a tick or two at 22:07 is not worth a warning, and must not spend the push a
 *  vitals-crit at 03:20 that lasts through the timed start needs. */
export const FORCE_CHARGE_LINE_DECLINED_PERSIST_MS = 10 * 60_000;

/** v1.200.0 (review) — a line night's declined-start push state: the blocker class seen on consecutive ticks
 *  and since when, and the classes already pushed tonight. */
export interface LineDeclinedPushState { cls: keyof typeof FORCE_CHARGE_BLOCKER_WHY | null; sinceMs: number | null; pushed: ReadonlyArray<string> }
export const EMPTY_LINE_DECLINED_PUSH: LineDeclinedPushState = Object.freeze({ cls: null, sinceMs: null, pushed: Object.freeze([]) as ReadonlyArray<string> });

/**
 * v1.200.0 (review) — PURE. One tick of a LINE night's declined-start push: `why` is the tick's (null when the
 * start was not declined, or the night is not a line night). Each blocker CLASS pushes at most once a night,
 * once it has held for FORCE_CHARGE_LINE_DECLINED_PERSIST_MS unbroken; a tick whose why is another class, or
 * no blocker at all, restarts the clock. Once-per-night under ONE key let a transient stale readback at
 * 22:07 spend the push a vitals-crit holding through the 03:25 start needed.
 */
export function lineDeclinedPushStep(
  st: LineDeclinedPushState, why: string | null | undefined, nowMs: number,
): { state: LineDeclinedPushState; push: keyof typeof FORCE_CHARGE_BLOCKER_WHY | null } {
  const cls = forceChargeBlockerClass(why);
  if (cls == null) return { state: { ...st, cls: null, sinceMs: null }, push: null };
  if (cls !== st.cls || st.sinceMs == null) return { state: { ...st, cls, sinceMs: nowMs }, push: null };
  if (nowMs - st.sinceMs < FORCE_CHARGE_LINE_DECLINED_PERSIST_MS || st.pushed.includes(cls)) return { state: st, push: null };
  return { state: { ...st, pushed: [...st.pushed, cls] }, push: cls };
}

/** v1.200.0 (review 2) — the tick's declined-start push memory: the night it is for, and its step state. */
export interface LineDeclinedPushMem { day: string | null; st: LineDeclinedPushState }

/**
 * v1.200.0 (review 2) — PURE. One tick of the declined-start push, from the record:
 *  - it applies on a LIVE night (the reserve applied AND verified, not reverted or cancelled, no force-charge of
 *    ours ON yet) whose record carries a line ask, with the line gate on and a mode riding it — line mode, or a
 *    COST-DOMINANT night (finding 1: its cost force-charge is what carries the line, and a blocker holding its
 *    start all night left the line unheld in silence);
 *  - the memory is SEEDED FROM THE RECORD (forceChargeLineDeclinedPushed) on a new night or after a restart, so
 *    each class pushes once a night across restarts (finding 9: it was module memory, and every restart under
 *    the same held cause pushed again). index.ts stamps the class on the record BEFORE the push goes.
 * `push` — the class to push now, else null.
 */
export function lineDeclinedPushTick(
  mem: LineDeclinedPushMem, s: NightActuationState, why: string | null | undefined, nowMs: number, gates: ForceChargeGates,
): { mem: LineDeclinedPushMem; push: keyof typeof FORCE_CHARGE_BLOCKER_WHY | null } {
  const st = mem.day === s.day && mem.day != null ? mem.st
    : { ...EMPTY_LINE_DECLINED_PUSH, pushed: [...(s.forceChargeLineDeclinedPushed ?? [])] };
  const live = s.appliedAtMs != null && s.applyVerifiedAtMs != null && s.revertedAtMs == null && !s.cancelled
    && s.forceChargeOnAtMs == null;
  const applies = live && gates.line && forceChargeLineNightPct(s) != null && forceChargeModeOf(s, gates) != null;
  const step = lineDeclinedPushStep(st, applies ? why : null, nowMs);
  return { mem: { day: s.day, st: step.state }, push: step.push };
}

/**
 * v1.200.0 (review) — PURE. The LATEST start that still takes the pool to the line's ask (⌈L⌉) by the close
 * at the rate now: forceChargeStartAtMs to ⌈L⌉ (its 15-min buffer kept), never later than the last start
 * decideForceCharge makes (the close less FORCE_CHARGE_MIN_RUN_MS). The declined-start push quotes it — not
 * the timed start (⌈L⌉ + 5 by the close − 20 min), which a later start still beats: 2027-01-04 is timed for
 * ~03:25 and reaches the line from a start as late as ~04:24.
 */
export function lineLatestStartMs(
  writeEndMs: number, askPct: number, poolSocPct: number, tickPoolKwh: number,
  rateKw?: number | null, evDisplacedKwh?: number | null, slotCount?: number | null,
): number {
  return Math.min(
    forceChargeStartAtMs(writeEndMs, askPct, poolSocPct, tickPoolKwh, rateKw, evDisplacedKwh, slotCount),
    writeEndMs - FORCE_CHARGE_MIN_RUN_MS,
  );
}

/**
 * v1.200.0 (review) — PURE. What the evening push says the armed night's force-charge does (index.ts's
 * supervised context): from the stamp the morning push reads back (forceChargeRides) and the mode the
 * gates NOW compose (forceChargeModeOf). A LINE night is announced as the line force-charge to the close
 * (`forceChargeLine`), never as a cost stop; any other riding night as today's cost target. Both null on a
 * night that does not ride.
 */
export function armedForceChargeAnnouncement(
  armed: Pick<NightActuationState, 'forceChargeRides' | 'forceChargeCeilingPct' | 'forceChargeLineAskPct' | 'forceChargeLinePct'>,
  gates: ForceChargeGates,
): { forceChargeTargetPct: number | null; forceChargeLine: { askPct: number; linePct: number; panelCeilingPct: number } | null } {
  const mode = forceChargeModeOf(armed, gates);
  const rides = armed.forceChargeRides === true;
  return {
    forceChargeTargetPct: rides && mode?.kind !== 'line' ? armed.forceChargeCeilingPct : null,
    forceChargeLine: rides && mode?.kind === 'line'
      ? { askPct: mode.askPct, linePct: armed.forceChargeLinePct ?? mode.askPct, panelCeilingPct: mode.panelCeilingPct }
      : null,
  };
}

/** v1.200.0 — the 21:30 ARMED line's force-charge sentence on a LINE night. PURE. */
export function forceChargeLineArmNote(o: {
  linePct: number; startTargetPct: number; panelCeilingPct: number;
  /** The plan's expected start (expectedForceChargeStartMs), as clock text; null ⇒ "just in time". */
  expectedStartText: string | null;
  /** The close less FORCE_CHARGE_MIN_RUN_MS, as clock text. */
  timedByText: string;
}): string {
  const from = o.expectedStartText != null ? `on from ~${o.expectedStartText}` : 'on just in time';
  return `Force-charge: LINE — tonight's ${round1(o.linePct)}% outage line is above the ${RESERVE_WRITE_MAX_PCT}% reserve: `
    + `${from} (timed to ${round1(o.startTargetPct)}% by ${o.timedByText}) to the window close; panel ceiling ${o.panelCeilingPct}% as backstop.`;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

/** True while a force-charge of ours is on, or its OFF has not yet verified. */
export function forceChargeInFlight(s: NightActuationState): boolean {
  return s.forceChargeOnAtMs != null && s.forceChargeOffVerifiedAtMs == null;
}

/**
 * v1.187.10 — the force-charge writes this add-on issued for the night, from its own
 * record, for settings-drift's own-write test (classifyChange). PURE.
 *  - ON to the slots it switched on — the OFF covers the same slots (the OFF step's own
 *    rule: the recorded slots, or 1-3 when none were recorded);
 *  - the OFF, once issued;
 *  - the ceiling: the synced backstop once a sync was attempted, and the panel's own
 *    value once its restore was attempted.
 */
export function forceChargeCommandsOf(s: NightActuationState): ForceChargeCommands {
  const onSlots = s.forceChargeOnAtMs == null ? null
    : (s.forceChargeSlots != null && s.forceChargeSlots.length > 0 ? [...s.forceChargeSlots] : [...ALL_SOURCE_SLOTS]);
  const ceilingPcts: number[] = [];
  // v1.200.0 — the value the sync actually wrote (forceChargeCeilingSyncedPct: a line night's is
  // ⌈L⌉ + 2H, not the cost ceiling's); a record from before the field, the value the sync always wrote.
  const synced = syncedCeilingPct(s);
  if (s.forceChargeCeilingAttemptedAtMs != null && synced != null) ceilingPcts.push(synced);
  if (s.forceChargeCeilingRestoreLastAttemptMs != null && s.forceChargeCeilingPriorPct != null) {
    ceilingPcts.push(s.forceChargeCeilingPriorPct);
  }
  return { onSlots, offIssued: s.forceChargeOffAtMs != null, ceilingPcts };
}

/** v1.200.0 — the panel ceiling tonight's sync wrote: the stamped value (forceChargeCeilingSyncedPct), or —
 *  on a record from before the field — desiredForceChargeCeilingPct of the cost ceiling, the value the
 *  sync always wrote there. null when neither is known. PURE. */
function syncedCeilingPct(s: Pick<NightActuationState, 'forceChargeCeilingSyncedPct' | 'forceChargeCeilingPct'>): number | null {
  const v = s.forceChargeCeilingSyncedPct;
  if (v != null && Number.isFinite(v)) return v;
  return s.forceChargeCeilingPct != null && Number.isFinite(s.forceChargeCeilingPct) ? desiredForceChargeCeilingPct(s.forceChargeCeilingPct) : null;
}

/**
 * v1.187.0 (review) — a force-charge OFF of ours is due on the night's own record or the
 * clock alone: ON issued, no OFF yet, and the night cancelled, the reserve already
 * reverted, no window, or the window closed (offReason's first three reasons — none needs
 * a readback). PURE.
 */
export function forceChargeOffDueNow(s: NightActuationState, nowMs: number): boolean {
  if (s.forceChargeOnAtMs == null || s.forceChargeOffAtMs != null) return false;
  return s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null
    || s.windowEndMs == null || nowMs >= writeWindowEndMs(s)!;
}

/** The two steps of one actuation tick (index.ts `runNightActuationTick`). */
export type ActuationStep = 'reserve' | 'forceCharge';

/**
 * v1.187.0 (review) — the order of one tick's steps. PURE.
 *
 * Normally the reserve step runs first and force-charge reads the state it just wrote:
 * the START needs the verified reserve (apply → readback → ceiling → ON). But when a
 * force-charge OFF is due (forceChargeOffDueNow) the OFF goes FIRST. With REVERT_LAG_MS
 * at 0 the reserve restore falls due on the same close tick, and the reserve step awaits
 * its PUT (writes carry no timeout of their own — undici's 300 s default applies) and
 * used to await the morning-summary push after it; meanwhile the Cores kept grid-charging
 * at 16-19 kW at the off-peak rate, and `nightActuationInFlight` held every later tick.
 * Both are OFF-direction writes, so neither order can raise a charge. And a force-charge
 * still ON at the close has normally carried the pool past the 50% reserve ceiling (every
 * force-charge target is above it), where the raised reserve drives no charge of its own:
 * there the OFF is the write that stops the spend. Grid-loss OFFs keep the reserve-first
 * order — they need the live reading, and the reserve step aborts the buy first.
 */
export function actuationStepOrder(s: NightActuationState, nowMs: number): readonly ActuationStep[] {
  return forceChargeOffDueNow(s, nowMs) ? ['forceCharge', 'reserve'] : ['reserve', 'forceCharge'];
}

/**
 * v1.187.0 (review) — run the tick's steps in `order`, each in its own try: a failure of
 * one must never skip the other (a reserve-step throw must not skip the force-charge OFF,
 * nor the reverse — the v1.165.0 rule, now independent of the order).
 */
export async function runActuationSteps(
  order: readonly ActuationStep[],
  steps: Readonly<Record<ActuationStep, () => Promise<void>>>,
  onError: (step: ActuationStep, e: unknown) => void,
): Promise<void> {
  for (const step of order) {
    try {
      await steps[step]();
    } catch (e) {
      onError(step, e);
    }
  }
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

/**
 * v1.187.22 — PURE. The pool level an armed plan's write drives to, %: the reserve setpoint as
 * armFromPlan writes it (clampReserveTarget), or — when force-charge rides the night
 * (`eligible`, i.e. forceChargeEnabled) and the ceiling armFromPlan records
 * (armedForceChargeCeilingPct) sits above the reserve maximum — where the force-charge stops
 * (forceChargeStopPct), whichever is higher. The same fields and functions the write uses,
 * never a re-derivation; the expected-buy disclosure (nightChargeAdvisor.expectedBuyFromPlan)
 * reads it. At or below the reserve maximum decideForceCharge starts nothing (the reserve
 * alone reaches it). null with no setpoint.
 */
export function armedWriteLevelPct(
  plan: { setpointSocPct: number | null; costCeilingSocPct?: number | null; forceChargeLine?: { askPct: number } | null },
  /** The cost gate (forceChargeEnabled) — or, v1.200.0, both gates (ForceChargeGates). */
  eligible: boolean | ForceChargeGates,
): number | null {
  if (plan.setpointSocPct == null || !Number.isFinite(plan.setpointSocPct)) return null;
  const reservePct = clampReserveTarget(plan.setpointSocPct);
  const gates: ForceChargeGates = typeof eligible === 'boolean' ? { cost: eligible, line: false } : eligible;
  // v1.200.0 — a LINE night has no software stop: the level its start is timed to (max(target, ⌈L⌉ + H)).
  // The expected close is the walk's (nightChargeAdvisor.expectedBuyFromPlan); this is its floor.
  const lineAsk = gates.line && plan.forceChargeLine != null ? plan.forceChargeLine.askPct : null;
  if (lineAsk != null) {
    const mode = forceChargeModeOf({ forceChargeCeilingPct: armedForceChargeCeilingPct(plan), forceChargeLineAskPct: lineAsk }, gates);
    if (mode?.kind === 'line') return Math.max(reservePct, mode.startTargetPct);
  }
  const ceiling = gates.cost ? armedForceChargeCeilingPct(plan) : null;
  if (ceiling == null || ceiling <= RESERVE_WRITE_MAX_PCT) return reservePct;
  return Math.max(reservePct, forceChargeStopPct(ceiling));
}

/** v1.187.22 — PURE. Where an ARMED night's force-charge stops, %, when it rides the night: the
 *  armed ceiling above the reserve maximum through forceChargeStopPct, force-charge `enabled`
 *  (forceChargeEnabled) — the evening push's own condition; null = reserve only. Whether it ever
 *  ran is the actuation record's (forceChargeNightOutcome), not this. */
export function armedForceChargeStopPct(
  s: Pick<NightActuationState, 'forceChargeCeilingPct'> & Partial<Pick<NightActuationState, 'forceChargeLineAskPct'>>,
  /** The cost gate — or, v1.200.0, both gates: a LINE night has no software stop (null). */
  enabled: boolean | ForceChargeGates,
): number | null {
  if (typeof enabled !== 'boolean') {
    const mode = forceChargeModeOf({ forceChargeCeilingPct: s.forceChargeCeilingPct, forceChargeLineAskPct: s.forceChargeLineAskPct ?? null }, enabled);
    return mode?.kind === 'cost' ? forceChargeStopPct(mode.targetPct) : null;
  }
  const c = s.forceChargeCeilingPct;
  return enabled && c != null && Number.isFinite(c) && c > RESERVE_WRITE_MAX_PCT ? forceChargeStopPct(c) : null;
}

/**
 * v1.187.22 — what tonight's force-charge actually did, from the actuation record, for the
 * morning summary:
 *  - `none` — it did not ride the night (no armed ceiling above the reserve maximum, or
 *    force-charge disabled when the night was armed) and nothing of ours was switched ON;
 *  - `neverStarted` — it rode the night and was never switched ON (decideForceCharge declined
 *    every tick: the pool stayed at or above the stop, the ceiling never read back, Charge Now was
 *    already on, the grid was unknown, the vitals were red, the option was switched off, …);
 *  - `ran` — switched ON and a live readback proved it (forceChargeOnVerifiedAtMs, a late apply
 *    included);
 *  - `failed` — switched ON and the "did not take effect" warning went (forceChargeOnFailedAtMs);
 *    `partialSlots` names the slots that did not take it when the others did
 *    (partialForceChargeOnFailureSlots), null when it failed on every slot;
 *  - `unconfirmed` — switched ON and neither proven nor failed when the night ended.
 * `stopPct` is where it stops (armedForceChargeStopPct); null on a stamped ON with no armed
 * ceiling above the reserve maximum. A stamped ON counts whatever the stamp or the option says.
 * Whether it rode the night is the arm-time stamp (`forceChargeRides`, armFromPlan), never the
 * option as it reads at the restore: a restart mid-night with the option changed turned an
 * armed-to-ride night into `none`. Only a record armed before the stamp reads `enabled` (the option
 * now), as every record did before it.
 * `expectedLeg` — whether the armed day's EXPECTED figure counts a force-charge leg: the same stamp
 * (the plan's figure is made on the gate the arm read, forceChargeEligible); with no stamp, false
 * when no armed ceiling sat above the reserve maximum (no leg was possible), else null (unknown).
 * The morning push names the figure only beside an account of the same legs. PURE.
 */
/** v1.200.0 — on a LINE night (forceChargeModeOf 'line'): the outage line it ran for (no software stop,
 *  so `stopPct` is null). Absent on every other night, whose outcome is unchanged. (review) `offReason` /
 *  `offAtMs`: the record's OFF — a line night "ran to the window close" only when it was switched off there
 *  (windowEnd) or not at all; any other OFF (disabled, maxRun, onPeakGuard, foreign, gridLoss…) ended it
 *  early, and the morning account says when and why. null on a night never switched on.
 *  (review 2) `panelOffAtMs` — the panel's own stop (forceChargeLinePanelOffAtMs, the latest episode); `reOns` —
 *  the line re-ONs issued after it, `reOnsNotApplied` those a readback check found not applied, `lastReOnAtMs` the
 *  last one: the morning account names the panel's stop when it ended the charge, and the re-ONs. */
export interface ForceChargeOutcomeLine {
  askPct: number; linePct: number; offReason?: string | null; offAtMs?: number | null;
  panelOffAtMs?: number | null; reOns?: number; reOnsNotApplied?: number; lastReOnAtMs?: number | null;
}

export type ForceChargeNightOutcome =
  | { kind: 'none'; expectedLeg: boolean | null }
  | { kind: 'neverStarted' | 'ran' | 'unconfirmed'; stopPct: number | null; expectedLeg: boolean | null; line?: ForceChargeOutcomeLine }
  | { kind: 'failed'; stopPct: number | null; expectedLeg: boolean | null; partialSlots: number[] | null; line?: ForceChargeOutcomeLine };

export function forceChargeNightOutcome(
  s: Pick<NightActuationState,
    | 'forceChargeCeilingPct' | 'forceChargeOnAtMs' | 'forceChargeOnVerifiedAtMs' | 'forceChargeOnFailedAtMs'
    | 'forceChargeRides' | 'forceChargeSlots' | 'forceChargeOnFailedSlots'>
    & Partial<Pick<NightActuationState, 'forceChargeLineAskPct' | 'forceChargeLinePct' | 'forceChargeMode' | 'forceChargeOffReason' | 'forceChargeOffAtMs'
      | 'forceChargeLinePanelOffAtMs' | 'forceChargeLineReOns' | 'forceChargeLineReOnsNotApplied' | 'forceChargeLineReOnAtMs'>>,
  /** Force-charge enabled NOW: read only for a record armed before the stamp. v1.200.0 — or both gates
   *  now (ForceChargeGates), which also say whether a night that never started was a line night. */
  enabled: boolean | ForceChargeGates,
): ForceChargeNightOutcome {
  const gates: ForceChargeGates = typeof enabled === 'boolean' ? { cost: enabled, line: false } : enabled;
  const c = s.forceChargeCeilingPct;
  const above = c != null && Number.isFinite(c) && c > RESERVE_WRITE_MAX_PCT;
  const expectedLeg = s.forceChargeRides ?? (above ? null : false);
  const on = forceChargeOnReadbackStatus(s);
  // v1.200.0 — a LINE night: the mode stamped at its ON, or (never started) the mode it rode the night in.
  const ask = s.forceChargeLineAskPct;
  const line: ForceChargeOutcomeLine | null = ask != null && Number.isFinite(ask)
    ? { askPct: ask, linePct: s.forceChargeLinePct != null && Number.isFinite(s.forceChargeLinePct) ? s.forceChargeLinePct : ask } : null;
  if (on != null && line != null && s.forceChargeMode === 'line') {
    const ran: ForceChargeOutcomeLine = {
      ...line, offReason: s.forceChargeOffReason ?? null, offAtMs: s.forceChargeOffAtMs ?? null,
      // (review 2) the panel's own stop and the re-ONs after it, as the record has them.
      panelOffAtMs: s.forceChargeLinePanelOffAtMs ?? null, reOns: s.forceChargeLineReOns ?? 0,
      reOnsNotApplied: s.forceChargeLineReOnsNotApplied ?? 0, lastReOnAtMs: s.forceChargeLineReOnAtMs ?? null,
    };
    if (on === 'failed') return { kind: 'failed', stopPct: null, expectedLeg, partialSlots: partialForceChargeOnFailureSlots(s), line: ran };
    return { kind: on === 'verified' ? 'ran' : 'unconfirmed', stopPct: null, expectedLeg, line: ran };
  }
  if (on == null && line != null && (s.forceChargeRides ?? (gates.cost || gates.line))
    && forceChargeModeOf({ forceChargeCeilingPct: c, forceChargeLineAskPct: ask! }, { cost: gates.cost, line: true })?.kind === 'line') {
    return { kind: 'neverStarted', stopPct: null, expectedLeg, line };
  }
  if (on != null) {
    const stopPct = armedForceChargeStopPct(s, true);
    if (on === 'failed') return { kind: 'failed', stopPct, expectedLeg, partialSlots: partialForceChargeOnFailureSlots(s) };
    return { kind: on === 'verified' ? 'ran' : 'unconfirmed', stopPct, expectedLeg };
  }
  const armedStop = armedForceChargeStopPct(s, s.forceChargeRides ?? gates.cost);
  return armedStop == null ? { kind: 'none', expectedLeg } : { kind: 'neverStarted', stopPct: armedStop, expectedLeg };
}

/**
 * v1.187.22 — PURE. The slots a force-charge ON failure covered when it covered only SOME of ours
 * (the others read ON, or their Cores sat at the panel's ceiling, when the warning went): the
 * failed slots, or null when it covered every slot of ours, or the record cannot say (no slot
 * list, or a failure recorded before the failed slots were kept — read as whole-night, as it always
 * was). The ON-failure push says "will not happen on those slot(s)" on exactly these
 * (buildNightForceChargeOnFailure), and the morning push matches it.
 */
export function partialForceChargeOnFailureSlots(
  s: Pick<NightActuationState, 'forceChargeSlots' | 'forceChargeOnFailedSlots'>,
): number[] | null {
  const failed = s.forceChargeOnFailedSlots;
  const ours = s.forceChargeSlots;
  if (failed == null || failed.length === 0 || ours == null) return null;
  return failed.length < ours.length ? [...failed] : null;
}

/**
 * v1.196.0 — one panel slot as the force-charge ON-failure warning names it: the Core in it, whether
 * the cloud has it, and that Core's OWN work mode and backup reserve (its DPU projection). The
 * warning named slot numbers only; on 2026-10-06 slot 3 refused Charge Now on repeated nights, and the
 * fact that explained it — the Core in slot 3 (Core 5) ran work mode 3 (time-of-use) with its own
 * backup reserve at 60%, where the other Cores read 0 and 50% — was in the store and in no message.
 */
export interface ForceChargeSlotCore {
  slot: number;
  /** coreLabel(coreNumber(…)): "Core N" from a "Core N" name ("Core 5"), or for a fallback-named DPU
   *  its panel slot ("Core 3"); else the display name — never the digits of a serial. null when the
   *  slot's DPU is not in the store. */
  label: string | null;
  /** The DPU's cloud online flag; null when it is not in the store. */
  online: boolean | null;
  /** sysWordMode — 0 default, 1 self-powered, 2 scheduled, 3 time-of-use (project.ts); null unknown. */
  workMode: number | null;
  /** sysBackupSoc — the Core's own backup reserve, %; null unknown. */
  backupSocPct: number | null;
}

/** v1.196.0 — sysWordMode's names (the vendor document, as ecoflow/project.ts states them). */
export const DPU_WORK_MODE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'default', 1: 'self-powered', 2: 'scheduled', 3: 'time-of-use',
});

/** The device fields forceChargeSlotCores reads (a DeviceSnapshot). */
interface SlotDeviceLike {
  sn: string;
  deviceName: string;
  nameFallback?: boolean;
  online?: boolean;
  projection?: { kind?: string; sysWordMode?: number | null; sysBackupSoc?: number | null } | null;
}

/**
 * v1.196.0 — PURE. Every slot the panel lists (`sources`, the SHP2 projection's — the same fresh
 * readback the ON verify reads) joined to its DPU in `devices` (the store's device map). The work
 * mode and the reserve are that DPU's projection — its last report, whatever its age; only the
 * slot → Core join is the fresh readback (a Core the cloud does not have is said to be offline). A
 * slot whose serial is not in the store keeps only its number. Serials are matched, never printed.
 */
export function forceChargeSlotCores(
  sources: ReadonlyArray<{ slot?: unknown; sn?: unknown } | null | undefined> | null | undefined,
  devices: Readonly<Record<string, unknown>> | null | undefined,
): ForceChargeSlotCore[] {
  if (!Array.isArray(sources)) return [];
  const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out: ForceChargeSlotCore[] = [];
  for (const s of sources) {
    const slot = Number(s?.slot);
    if (!Number.isInteger(slot)) continue;
    const sn = typeof s?.sn === 'string' && s.sn.length > 0 ? s.sn : null;
    const raw = sn != null && devices != null ? devices[sn] : undefined;
    const dev = raw != null && typeof raw === 'object' ? (raw as SlotDeviceLike) : null;
    const pj = dev?.projection?.kind === 'dpu' ? dev.projection : null;
    out.push({
      slot,
      label: dev != null ? coreLabel(coreNumber(dev, devices), dev.deviceName) : null,
      online: dev != null ? dev.online === true : null,
      workMode: fin(pj?.sysWordMode),
      backupSocPct: fin(pj?.sysBackupSoc),
    });
  }
  return out;
}

/**
 * v1.196.0 — PURE. The failed slots as the ON-failure warning and its log line write them: each with
 * its Core — "3 (Core 5)" —, "offline in the cloud" when the cloud does not have that Core (its
 * settings are then the last it reported), and a setting of its own that differs from the other
 * Cores': its work mode or its backup reserve, named only when it is known on the failed slot AND on
 * at least one other Cores' slot AND is none of their values ("work mode 3 (time-of-use), where the
 * other Cores read 0 (default)"). The other Cores are ours (the record's forceChargeSlots; every
 * listed slot when it has none) less the failed ones. A slot with no Core in the store is its bare
 * number; with no cores at all the text is the slot numbers alone — the words before v1.196.0.
 * `differing` counts the failed slots with a differing setting (the push then says to compare them).
 */
export function forceChargeFailedSlotsText(
  failed: ReadonlyArray<number>,
  ours: ReadonlyArray<number> | null | undefined,
  cores: ReadonlyArray<ForceChargeSlotCore> | null | undefined,
): { text: string; differing: number } {
  if (cores == null || cores.length === 0) return { text: failed.join(', '), differing: 0 };
  const bySlot = new Map(cores.map((c) => [c.slot, c] as const));
  const others = (ours ?? cores.map((c) => c.slot))
    .filter((n) => !failed.includes(n))
    .map((n) => bySlot.get(n))
    .filter((c): c is ForceChargeSlotCore => c != null);
  const modeWords = (m: number): string => (DPU_WORK_MODE_NAMES[m] != null ? `${m} (${DPU_WORK_MODE_NAMES[m]})` : `${m}`);
  let differing = 0;
  const parts = failed.map((slot) => {
    const c = bySlot.get(slot);
    if (c == null || c.label == null) return `${slot}`;
    const notes: string[] = [];
    if (c.online === false) notes.push('offline in the cloud');
    let differs = false;
    const compare = (v: number | null, pick: (o: ForceChargeSlotCore) => number | null, words: (theirs: number[]) => string): void => {
      const theirs = [...new Set(others.map(pick).filter((x): x is number => x != null))].sort((a, b) => a - b);
      if (v == null || theirs.length === 0 || theirs.includes(v)) return;
      notes.push(words(theirs));
      differs = true;
    };
    compare(c.workMode, (o) => o.workMode,
      (theirs) => `work mode ${modeWords(c.workMode!)}, where the other Cores read ${theirs.map(modeWords).join(' / ')}`);
    compare(c.backupSocPct, (o) => o.backupSocPct,
      (theirs) => `its own backup reserve ${c.backupSocPct}%, where the other Cores read ${theirs.map((x) => `${x}%`).join(' / ')}`);
    if (differs) differing++;
    return notes.length > 0 ? `${slot} (${c.label} — ${notes.join('; ')})` : `${slot} (${c.label})`;
  });
  return { text: parts.join(', '), differing };
}

/** v1.168.0 — when a force-charge of ours that has not verified OFF must escalate,
 *  whatever the readback says: the LATER of (first OFF + 30 min) and (window end +
 *  60 min). A missing window counts from the ON — it stops at once (offReason), so it
 *  is judged from its OFF. Null when nothing of ours is in flight. */
export function forceChargeOffDeadlineMs(s: NightActuationState): number | null {
  if (!forceChargeInFlight(s)) return null;
  const fromOff = s.forceChargeOffAtMs != null ? s.forceChargeOffAtMs + FORCE_CHARGE_OFF_DEADLINE_AFTER_OFF_MS : null;
  const fromWindow = (s.windowEndMs ?? s.forceChargeOnAtMs!) + FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS;
  const later = fromOff != null ? Math.max(fromOff, fromWindow) : fromWindow;
  // Capped ON_PEAK_PAGE_LEAD_MS before the on-peak start the night was armed against: a
  // force-charge still unconfirmed then is about to buy at the peak rate. The overnight window's
  // deadline (06:00) is ten hours inside the cap.
  const p = s.nextOnPeakStartMs;
  return p != null && Number.isFinite(p) ? Math.min(later, p - ON_PEAK_PAGE_LEAD_MS) : later;
}

/** When blind OFF re-sends (no live readback, after the escalation) stop: the first OFF +
 *  FORCE_CHARGE_BLIND_RESEND_MAX_MS, or the next charge window's open if that comes first and
 *  after the first OFF. Null with no OFF yet. PURE. */
export function blindResendStopMs(s: Pick<NightActuationState, 'forceChargeOffAtMs'>, nextLegOpenMs?: number | null): number | null {
  if (s.forceChargeOffAtMs == null) return null;
  const cap = s.forceChargeOffAtMs + FORCE_CHARGE_BLIND_RESEND_MAX_MS;
  return nextLegOpenMs != null && Number.isFinite(nextLegOpenMs) && nextLegOpenMs > s.forceChargeOffAtMs
    ? Math.min(cap, nextLegOpenMs) : cap;
}

/** v1.191.0 (S6, W5) — the run backstop in effect: the schedule's (ForceChargeOpts.maxRunMs), never
 *  below FORCE_CHARGE_MAX_RUN_MS; anything unusable reads as FORCE_CHARGE_MAX_RUN_MS. PURE. */
export function forceChargeRunCapMs(o: Pick<ForceChargeOpts, 'maxRunMs'>): number {
  const v = o.maxRunMs;
  return v != null && Number.isFinite(v) ? Math.max(FORCE_CHARGE_MAX_RUN_MS, v) : FORCE_CHARGE_MAX_RUN_MS;
}

function offReason(s: NightActuationState, nowMs: number, o: ForceChargeOpts): ForceChargeOffReason | null {
  if (s.cancelled) return 'cancelled';
  if (s.revertedAtMs != null) return 'reverted';
  if (s.foreignSettledAtMs != null) return 'foreign';
  // A missing window can't say when to stop, so it stops now.
  if (s.windowEndMs == null || nowMs >= s.windowEndMs) return 'windowEnd';
  if (nowMs >= writeWindowEndMs(s)!) return 'onPeakGuard';
  if (o.gridPresent === false || o.gridStaLost) return 'gridLoss';
  // v1.200.0 — off when neither force-charge may ride the record under the LIVE gates (today: the cost
  // gate; a record with a line ask also rides its line gate). A non-number ask was coerced away, so with
  // the cost gate off that record stops here (fail-closed; the night strikes).
  const gates = gatesOf(o);
  if (!anyForceChargeGate(s, gates)) return 'disabled';
  if (s.forceChargeOnAtMs != null && nowMs - s.forceChargeOnAtMs >= forceChargeRunCapMs(o)) return 'maxRun';
  // v1.167.0 — stop once the desired percentage is reached. A stale or
  // incoherent SoC never ends it early; the window end and the panel's ceiling still do.
  // v1.170.0 — at EVERY target again (the 80+ coast is retired), against forceChargeStopPct.
  // v1.200.0 — never in LINE mode: it runs to the window close (no software stop).
  if (
    forceChargeModeOf(s, gates)?.kind !== 'line'
    && o.poolSocPct != null && s.forceChargeCeilingPct != null
    && o.poolSocPct >= forceChargeStopPct(s.forceChargeCeilingPct)
  ) return 'target';
  return null;
}

/** v1.186.0 — the ceiling at which the panel switches a slot's force-charge off by
 *  itself: tonight's synced ceiling, or the live readback when that is LOWER (a ceiling
 *  lowered in the app mid-night stops a Core sooner). Null when neither is known. */
function panelStopCeilingPct(s: NightActuationState, o: ForceChargeOpts): number | null {
  // v1.200.0 — the ceiling the sync wrote (a line night's ⌈L⌉ + 2H), not the cost ceiling's.
  const synced = syncedCeilingPct(s);
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
    // The re-issue is a raise: the cutoff runs from writeWindowEndMs — the window close, or an
    // hour before on-peak if that is sooner.
    if (s.windowEndMs == null || nowMs >= writeWindowEndMs(s)! - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) {
      return { kind: 'onFailed', slots: pending, noRetry: true };
    }
    // The re-issue starts a grid charge on those slots: the grid must be KNOWN present and
    // the host healthy, exactly as for the start. Otherwise wait — it is not yet a failure.
    if (o.gridPresent !== true || o.vitalsRed) return { kind: 'none' };
    return { kind: 'onRetry', slots: pending };
  }
  return { kind: 'onFailed', slots: pending };
}

/**
 * v1.200.0 (review) — PURE. The LINE re-ON: a line night has no software stop, but the panel has one of
 * its own — it switches a slot's Charge Now OFF as the slot's Core reaches the force-charge ceiling, and
 * leaves it OFF. Below the ceiling the house (and an EV) then draw the pool again. A start pulled early (a
 * predicted EV, a big lift) reaches the ceiling hours before the close; a load that arrives after that
 * took the pool under the line on 8 of 200 emulated year nights (a 20 kWh EV predicted, a 7 kW one
 * arriving 90 min out). So, on a line night whose ON was VERIFIED, when the pool reads under the start
 * target (⌈L⌉ + H) and slots of ours read OFF (connected, and not at the ceiling), those slots are switched
 * back ON — under the start's own gates: the grid KNOWN present, the host healthy, a coherent pool
 * reading, a live slot readback, and a live panel ceiling the pool is under. At most
 * FORCE_CHARGE_LINE_REON_MAX a night, FORCE_CHARGE_ON_VERIFY_AFTER_MS apart, and never inside
 * FORCE_CHARGE_ON_RETRY_CUTOFF_MS of the write window's end (a re-ON shares each slot's command cooldown
 * with the close's OFF). A slot an operator switched OFF in the app reads the same and is switched back
 * on, within the same budget: the documented off switches of a line night are NIGHT_CHARGE_MODE advisory
 * and the per-night cancel. null when not due.
 */
export function lineReOnDue(
  s: NightActuationState, nowMs: number, o: ForceChargeOpts, ours: readonly number[],
): Extract<ForceChargeAction, { kind: 'lineReOn' }> | null {
  if (s.forceChargeOnAtMs == null || s.forceChargeOffAtMs != null || s.forceChargeOnVerifiedAtMs == null) return null;
  if (!(s.forceChargeLineReOns < FORCE_CHARGE_LINE_REON_MAX)) return null;
  const mode = forceChargeModeOf(s, gatesOf(o));
  if (mode?.kind !== 'line') return null;
  if (s.windowEndMs == null || nowMs >= writeWindowEndMs(s)! - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) return null;
  const last = s.forceChargeLineReOnAtMs ?? s.forceChargeOnLastAttemptMs ?? s.forceChargeOnAtMs;
  if (nowMs - last < FORCE_CHARGE_ON_VERIFY_AFTER_MS) return null;
  if (o.vitalsRed || !o.socCoherent || o.gridPresent !== true || o.gridStaLost) return null;
  if (o.slotsOn == null || o.poolSocPct == null || !Number.isFinite(o.poolSocPct)) return null;
  if (o.poolSocPct >= mode.startTargetPct) return null;
  const rb = o.ceilingReadbackPct;
  if (rb == null || !Number.isFinite(rb) || rb < FORCE_CHARGE_CEILING_MIN_PCT || rb > FORCE_CHARGE_CEILING_MAX_PCT || rb <= o.poolSocPct) return null;
  // A slot whose Core still reads at the panel's stop ceiling would only latch again: not switched.
  const stopAt = panelStopCeilingPct(s, o);
  const coreBelowStop = (n: number): boolean => {
    const soc = o.slotSocPct?.[n];
    return stopAt == null || typeof soc !== 'number' || !Number.isFinite(soc) || soc < stopAt;
  };
  const slots = ours.filter((n) => !o.slotsOn!.includes(n) && o.connectedSlots.includes(n) && coreBelowStop(n));
  return slots.length > 0 ? { kind: 'lineReOn', slots } : null;
}

/**
 * v1.200.0 (review) — PURE. While ON in LINE mode, a panel ceiling synced ABOVE the line mode's own
 * (mode.panelCeilingPct) is lowered to it. It arises only when the cost gate goes off mid-run on a
 * cost-dominant night (synced at the cost ceiling, e.g. 90; the line mode's own is 80 for an ask of 56):
 * line mode has no software stop, so without this the stale cost ceiling was the only stop and the pool
 * overshot the line mode's ceiling by ten points. One write (the stamp moves to the lowered value, so it
 * does not repeat); a write the panel refuses leaves the cost ceiling as the stop — the pre-fix overshoot,
 * economic only. null when not due — on every record whose synced ceiling is the mode's, i.e. every night
 * but that one.
 * (review 2) It LOWERS ONLY WHAT THE PANEL HOLDS: a live readback inside the panel's documented 80..100 that
 * reads ABOVE the mode's ceiling. A panel reading at or under it (its ceiling lowered in the app mid-night)
 * is left alone — writing the mode's ceiling there would RAISE it, a new grid-charge reach the night never
 * armed (the reviewer's probe: cost 90, ask 75, the panel at 80, the mode's 85). Because it can only lower,
 * it is allowed under red host vitals, as the OFFs are: the safe direction.
 */
export function lineCeilingLoweringDue(
  s: NightActuationState, o: ForceChargeOpts,
): Extract<ForceChargeAction, { kind: 'syncCeiling' }> | null {
  const mode = forceChargeModeOf(s, gatesOf(o));
  if (mode?.kind !== 'line') return null;
  const synced = syncedCeilingPct(s);
  if (synced == null || synced <= mode.panelCeilingPct) return null;
  const rb = o.ceilingReadbackPct;
  if (rb == null || !Number.isFinite(rb) || rb < FORCE_CHARGE_CEILING_MIN_PCT || rb > FORCE_CHARGE_CEILING_MAX_PCT) return null;
  if (!(rb > mode.panelCeilingPct)) return null;
  return { kind: 'syncCeiling', pct: mode.panelCeilingPct, prior: s.forceChargeCeilingPriorPct ?? rb };
}

/**
 * v1.200.0 (review 2) — PURE. A line re-ON's READBACK CHECK, as the first ON has one (verifyForceChargeOn): once,
 * FORCE_CHARGE_ON_VERIFY_AFTER_MS after the re-ON's writes, on a live slot readback (a stale one decides
 * nothing). The slots the re-ON switched that still read OFF, their Cores under the panel's stop ceiling, did not
 * take effect (a Core at the ceiling was switched off by the panel again); with none reading ON, every one is
 * counted not applied (an all-exempt verdict with nothing ON is far likelier a bad reading). It writes nothing:
 * the record keeps the verdict for the line-at-risk push and the morning account, and the budget's next re-ON
 * (lineReOnDue) is the retry. null when no re-ON is pending its check — a re-ON whose every write came back
 * rate-limited stamps no slots (it never reached the panel).
 */
export function lineReOnCheckDue(
  s: NightActuationState, nowMs: number, o: Pick<ForceChargeOpts, 'slotsOn' | 'slotSocPct' | 'ceilingReadbackPct'>,
): Extract<ForceChargeAction, { kind: 'lineReOnChecked' }> | null {
  const slots = s.forceChargeLineReOnSlots;
  const at = s.forceChargeLineReOnAtMs;
  if (at == null || slots == null || slots.length === 0) return null;
  if (s.forceChargeLineReOnCheckedAtMs != null && s.forceChargeLineReOnCheckedAtMs >= at) return null;
  if (nowMs - at < FORCE_CHARGE_ON_VERIFY_AFTER_MS || o.slotsOn == null) return null;
  const ceiling = panelStopCeilingPct(s, o as ForceChargeOpts);
  const atCeiling = (n: number): boolean => {
    const soc = o.slotSocPct?.[n];
    return ceiling != null && typeof soc === 'number' && Number.isFinite(soc) && soc >= ceiling;
  };
  const notOn = slots.filter((n) => !o.slotsOn!.includes(n) && !atCeiling(n));
  const anyOn = slots.some((n) => o.slotsOn!.includes(n));
  return { kind: 'lineReOnChecked', slots: [...slots], notApplied: notOn.length === 0 && !anyOn ? [...slots] : notOn };
}

/**
 * v1.200.0 (review) — PURE. The WRITE-AHEAD stamp of an ON (index.ts persists it before the writes):
 *  - `forceChargeMode`: the mode it is switched ON in (forceChargeModeOf on the record and the gates NOW) —
 *    the ledger's force_charge_mode, the ON-failure push's line sentence, the morning account;
 *  - `forceChargeCeilingSyncedPct`: the mode's panel ceiling. decideForceCharge switches ON only on a tick
 *    whose readback equals it, so it is the ceiling the panel holds — also on a night that needed no sync
 *    (the panel already read it). Without the stamp the ON verify fell back to desired(cost ceiling): a
 *    line night with c = 70 and ask 90 (panel at 100, unsynced) exempted a slot refusing the ON at 84% as
 *    "at the ceiling" and verified it falsely.
 */
export function forceChargeOnStamp(
  s: NightActuationState, nowMs: number, slots: readonly number[], gates: ForceChargeGates,
): Pick<NightActuationState, 'forceChargeOnAtMs' | 'forceChargeSlots' | 'forceChargeMode' | 'forceChargeCeilingSyncedPct'> {
  const mode = forceChargeModeOf(s, gates);
  return {
    forceChargeOnAtMs: nowMs,
    forceChargeSlots: [...slots],
    forceChargeMode: mode?.kind ?? null,
    forceChargeCeilingSyncedPct: mode != null ? mode.panelCeilingPct : s.forceChargeCeilingSyncedPct,
  };
}

/** v1.200.0 (review 2) — PURE. The outage line a night's RECORD carries: the line (forceChargeLinePct), or its
 *  ask where the line is unknown, whenever the record has a line ask above the reserve maximum — whatever mode
 *  the night runs in. A COST-DOMINANT night (cost mode, its stop at ⌈L⌉ + 10 or above) carries its line too:
 *  that line is what its cost force-charge holds, so its failure and its morning account speak for the line.
 *  null on a night with no line ask (every cost night of v1.199.1, word for word). */
export function forceChargeLineNightPct(
  s: Pick<NightActuationState, 'forceChargeLineAskPct' | 'forceChargeLinePct'>,
): number | null {
  const ask = s.forceChargeLineAskPct;
  if (ask == null || !Number.isFinite(ask) || !(ask > RESERVE_WRITE_MAX_PCT)) return null;
  const line = s.forceChargeLinePct;
  return line != null && Number.isFinite(line) ? line : ask;
}

/** v1.200.0 (review 2) — PURE. The ON-failure push's night fields (notify.buildNightForceChargeOnFailure): a
 *  night whose record carries a line names the line (never "toward" a stop, never "no action needed") — in line
 *  mode AND on a cost-dominant night; any other night its cost ceiling, as v1.199.1. Keyed on the record, never
 *  on the stamped mode: a cost-dominant night is stamped 'cost'. */
export function forceChargeOnFailureNight(
  s: Pick<NightActuationState, 'forceChargeLineAskPct' | 'forceChargeLinePct' | 'forceChargeCeilingPct'>,
): { ceilingPct: number | null; lineLinePct: number | null } {
  const line = forceChargeLineNightPct(s);
  return line != null ? { ceilingPct: null, lineLinePct: line } : { ceilingPct: s.forceChargeCeilingPct, lineLinePct: null };
}

/** v1.200.0 (review 2) — the line-at-risk push waits for a reading at least this much older to say the pool is
 *  not rising. Ten minutes at the ~14 kW a pack takes under Charge Now is ~2.5 points of a 92 kWh pool, so a
 *  charging pool shows on whole-percent readings; a shorter span reads a slow charge as flat. */
export const FORCE_CHARGE_LINE_TREND_MS = 10 * 60_000;
/** v1.200.0 (review 2) — no line-at-risk push inside this much of the add-on's close OFF (writeWindowEndMs). It is
 *  the start's own "not worth starting" margin (FORCE_CHARGE_MIN_RUN_MS, 20 min): a Charge Now switched on by hand
 *  later than that, after the push reaches a phone and the app is opened, buys under ~4 points at the measured
 *  ~14 kW — the push would arrive when nothing can still move the close. */
export const FORCE_CHARGE_LINE_AT_RISK_LEAD_MS = FORCE_CHARGE_MIN_RUN_MS;

/** v1.200.0 (review 2) — one pool reading of a line night's trail (forceChargeLinePoolSamples). */
export interface LinePoolSample { pct: number; atMs: number }

/** v1.200.0 (review 2) — PURE. The trail after a fresh, coherent reading: at most two samples; the newer is
 *  replaced (the older dropped) once it is FORCE_CHARGE_LINE_TREND_MS old, so a sample 10-20 min older than now
 *  is always at hand. The SAME array back when nothing changes (the tick persists only a change: one write per
 *  ten minutes). A clock that went back restarts it. */
export function linePoolSamplesStep(
  samples: ReadonlyArray<LinePoolSample> | null | undefined, pct: number, nowMs: number,
): LinePoolSample[] | null {
  const cur = samples != null && samples.length > 0 ? samples : null;
  if (!Number.isFinite(pct) || !Number.isFinite(nowMs)) return (samples as LinePoolSample[] | null | undefined) ?? null;
  if (cur == null) return [{ pct, atMs: nowMs }];
  const last = cur[cur.length - 1];
  if (nowMs < last.atMs) return [{ pct, atMs: nowMs }];
  if (nowMs - last.atMs < FORCE_CHARGE_LINE_TREND_MS) return samples as LinePoolSample[];
  return [last, { pct, atMs: nowMs }];
}

/** v1.200.0 (review 2) — PURE. The newest sample at least FORCE_CHARGE_LINE_TREND_MS older than now, or null. */
export function linePoolReference(samples: ReadonlyArray<LinePoolSample> | null | undefined, nowMs: number): LinePoolSample | null {
  if (samples == null) return null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (nowMs - samples[i].atMs >= FORCE_CHARGE_LINE_TREND_MS) return { pct: samples[i].pct, atMs: samples[i].atMs };
  }
  return null;
}

/** The slots a force-charge of ours covers: the record's, or all of them when the list is gone (decideForceCharge). */
function oursOf(s: Pick<NightActuationState, 'forceChargeSlots'>): number[] {
  return s.forceChargeSlots != null && s.forceChargeSlots.length > 0 ? [...s.forceChargeSlots] : [...ALL_SOURCE_SLOTS];
}

/**
 * v1.200.0 (review 2) — PURE. What a line night's tick stamps on the record before it decides (index.ts persists
 * a change only):
 *  - the pool trail (linePoolSamplesStep), on a fresh, coherent reading, while a force-charge of ours is ON and
 *    no OFF has been issued;
 *  - the PANEL'S OWN STOP (forceChargeLinePanelOffAtMs): after the verified ON, a live readback showing every slot
 *    of ours OFF with a Core at the panel's stop ceiling (one point under it counts: a reading taken just after
 *    the last slot latched). It is the shape measured on 2026-09-23 and 2026-10-02. Stamped once per episode: a
 *    second latch re-stamps it only once a re-ON's readback grace has run (a re-ON just written still reads OFF).
 * Only on a night whose record carries a line ask; null when there is nothing new to stamp.
 */
export function lineNightObservations(
  s: NightActuationState, nowMs: number, o: ForceChargeOpts,
): Partial<Pick<NightActuationState, 'forceChargeLinePoolSamples' | 'forceChargeLinePanelOffAtMs'>> | null {
  if (forceChargeLineNightPct(s) == null || s.forceChargeOnAtMs == null || s.forceChargeOffAtMs != null) return null;
  const out: Partial<Pick<NightActuationState, 'forceChargeLinePoolSamples' | 'forceChargeLinePanelOffAtMs'>> = {};
  if (o.socCoherent && o.poolSocPct != null && Number.isFinite(o.poolSocPct)) {
    const next = linePoolSamplesStep(s.forceChargeLinePoolSamples, o.poolSocPct, nowMs);
    if (next !== s.forceChargeLinePoolSamples) out.forceChargeLinePoolSamples = next;
  }
  if (s.forceChargeOnVerifiedAtMs != null && o.slotsOn != null) {
    const ours = oursOf(s);
    const stop = panelStopCeilingPct(s, o);
    const allOff = ours.every((n) => !o.slotsOn!.includes(n));
    const coreAtStop = stop != null && ours.some((n) => {
      const soc = o.slotSocPct?.[n];
      return typeof soc === 'number' && Number.isFinite(soc) && soc >= stop - 1;
    });
    const prev = s.forceChargeLinePanelOffAtMs;
    const reOn = s.forceChargeLineReOnAtMs;
    const newEpisode = prev == null || (reOn != null && reOn > prev && nowMs - reOn >= FORCE_CHARGE_ON_VERIFY_AFTER_MS);
    if (allOff && coreAtStop && newEpisode) out.forceChargeLinePanelOffAtMs = nowMs;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** v1.200.0 (review 2) — why the add-on cannot act on a line at risk (lineAtRiskPushDue):
 *  - 'onNotRising' — slots of ours read ON and the pool is not rising (the UNMEASURED ON-reading latch, or a late
 *    load taking the grid cap): no re-ON keys on a slot reading ON;
 *  - 'reOnSpent' / 'reOnNotApplied' — the FORCE_CHARGE_LINE_REON_MAX re-ONs are spent (the last one's readback
 *    check found it not applied);
 *  - 'reOnHeld' — a re-ON is possible but its gates hold it (the grid not known present, red vitals, no
 *    coherent reading, no live panel ceiling the pool is under);
 *  - 'costMode' — a COST-DOMINANT night: its cost force-charge has its own stop and no re-ON. */
export type LineAtRiskCause = 'onNotRising' | 'reOnSpent' | 'reOnNotApplied' | 'reOnHeld' | 'costMode';

/** v1.200.0 (review 2) — a line at risk (lineAtRiskPushDue), for the push and its log line. */
export interface LineAtRisk {
  cause: LineAtRiskCause;
  /** Slots of ours reading OFF, connected, their Cores under the panel's stop ceiling: switch Charge Now on. */
  offSlots: number[];
  /** Slots of ours reading ON while the pool is not rising: off and on again may restart the charge. */
  onSlots: number[];
  poolPct: number;
  /** The reading at least FORCE_CHARGE_LINE_TREND_MS older the pool is not above. */
  refPct: number;
  refAtMs: number;
  /** The at-risk threshold: the line mode's start target (⌈L⌉ + H at least), or ⌈L⌉ + H on a cost-dominant night. */
  thresholdPct: number;
  linePct: number;
  /** When the add-on switches the force-charge off (writeWindowEndMs). */
  closeAtMs: number;
  /** The last re-ON check's slots still reading OFF (forceChargeLineReOnNotAppliedSlots); null when none checked. */
  reOnNotAppliedSlots: number[] | null;
}

/**
 * v1.200.0 (review 2) — PURE. THE LINE AT RISK, while a person can still act. A line night's only in-night remedy
 * after its verified ON is the re-ON (lineReOnDue), and it keys on slots reading OFF, spends at most
 * FORCE_CHARGE_LINE_REON_MAX, and rides the start's gates. Every other way the line is lost after the start —
 * the ON-reading latch (UNMEASURED on this plant: a slot that keeps reading ON at its ceiling and stops
 * importing), a re-ON refused or never applied, a spent budget, gates holding, an unpredicted late load taking
 * the grid cap — went unseen until the morning. Due when ALL hold:
 *  - the record carries a line ask (forceChargeLineNightPct) and the live gates still ride it: the line gate on
 *    (never in advisory mode, never on the backup leg) and a mode — LINE, or COST-DOMINANT (cost mode on a record
 *    with a line ask, whose cost force-charge is what carries the line);
 *  - the ON verified, no OFF issued, and at least FORCE_CHARGE_LINE_AT_RISK_LEAD_MS before the add-on's close OFF;
 *  - a fresh, coherent pool reading UNDER the night's at-risk threshold: the line mode's start target (the value
 *    lineReOnDue switches back on under), or ⌈L⌉ + H on a cost-dominant night — its cost target (⌈L⌉ + 2H or
 *    more) is an economic level, and falling short of it is no line risk; ⌈L⌉ + H is the same margin over the
 *    line the line mode times its start and its re-ON to;
 *  - the add-on cannot act on it now: no re-ON due, and none (nor the ON) inside its readback grace
 *    (FORCE_CHARGE_ON_VERIFY_AFTER_MS) — a re-ON that may yet take effect is left alone;
 *  - the pool NOT RISING: at or under a reading at least FORCE_CHARGE_LINE_TREND_MS older (the record's trail);
 *  - a live slot readback that names a slot a person can switch: one of ours reading OFF (connected, its Core
 *    under the panel's stop ceiling), or reading ON;
 *  - once a night (forceChargeLineAtRiskPushedAtMs, stamped write-ahead by index.ts).
 * No new write rests on the unmeasured ON-reading shape: the add-on tells, a person decides.
 */
export function lineAtRiskPushDue(s: NightActuationState, nowMs: number, o: ForceChargeOpts): LineAtRisk | null {
  if (s.forceChargeLineAtRiskPushedAtMs != null) return null;
  const linePct = forceChargeLineNightPct(s);
  if (linePct == null) return null;
  const gates = gatesOf(o);
  if (!gates.line) return null;
  const mode = forceChargeModeOf(s, gates);
  if (mode == null) return null;
  if (s.forceChargeOnAtMs == null || s.forceChargeOnVerifiedAtMs == null || s.forceChargeOffAtMs != null) return null;
  if (s.windowEndMs == null) return null;
  const closeAtMs = writeWindowEndMs(s)!;
  if (nowMs > closeAtMs - FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) return null;
  if (!o.socCoherent || o.poolSocPct == null || !Number.isFinite(o.poolSocPct)) return null;
  const thresholdPct = mode.kind === 'line' ? mode.startTargetPct : s.forceChargeLineAskPct! + FORCE_CHARGE_LINE_HEADROOM_PCT;
  if (!(o.poolSocPct < thresholdPct)) return null;
  const ours = oursOf(s);
  if (lineReOnDue(s, nowMs, o, ours) != null) return null;
  const last = s.forceChargeLineReOnAtMs ?? s.forceChargeOnLastAttemptMs ?? s.forceChargeOnAtMs;
  if (nowMs - last < FORCE_CHARGE_ON_VERIFY_AFTER_MS) return null;
  const ref = linePoolReference(s.forceChargeLinePoolSamples, nowMs);
  if (ref == null || o.poolSocPct > ref.pct) return null;
  if (o.slotsOn == null) return null;
  const stopAt = panelStopCeilingPct(s, o);
  const coreBelowStop = (n: number): boolean => {
    const soc = o.slotSocPct?.[n];
    return stopAt == null || typeof soc !== 'number' || !Number.isFinite(soc) || soc < stopAt;
  };
  const offSlots = ours.filter((n) => !o.slotsOn!.includes(n) && o.connectedSlots.includes(n) && coreBelowStop(n));
  const onSlots = ours.filter((n) => o.slotsOn!.includes(n));
  if (offSlots.length === 0 && onSlots.length === 0) return null;
  const notApplied = s.forceChargeLineReOnNotAppliedSlots;
  const cause: LineAtRiskCause = mode.kind === 'cost' ? 'costMode'
    : offSlots.length === 0 ? 'onNotRising'
      : s.forceChargeLineReOns >= FORCE_CHARGE_LINE_REON_MAX
        ? (notApplied != null && notApplied.length > 0 ? 'reOnNotApplied' : 'reOnSpent')
        : 'reOnHeld';
  return {
    cause, offSlots, onSlots, poolPct: o.poolSocPct, refPct: ref.pct, refAtMs: ref.atMs, thresholdPct, linePct, closeAtMs,
    reOnNotAppliedSlots: notApplied != null ? [...notApplied] : null,
  };
}

/** v1.200.0 (review 2) — the ON-reading shape as seen (lineOnReadingShape), for its one log line a night. */
export interface LineOnReadingShape { slots: number[]; poolPct: number; refPct: number; refAtMs: number; stopCeilingPct: number }

/**
 * v1.200.0 (review 2) — PURE. THE ON-READING SHAPE, AS SEEN: on a line-ask night after the verified ON and before
 * any OFF, slots of ours READ ON with their Cores (known) under the panel's stop ceiling while the pool FELL
 * against a reading at least FORCE_CHARGE_LINE_TREND_MS older. It is what a slot that keeps reading ON at its
 * ceiling and stops importing would look like once the house draws it down — never measured on this plant (a
 * late load taking the grid cap reads the same). index.ts logs it once a night whatever the push conditions, so
 * its first real occurrence is on record. null otherwise.
 */
export function lineOnReadingShape(s: NightActuationState, nowMs: number, o: ForceChargeOpts): LineOnReadingShape | null {
  if (forceChargeLineNightPct(s) == null) return null;
  if (s.forceChargeOnAtMs == null || s.forceChargeOnVerifiedAtMs == null || s.forceChargeOffAtMs != null) return null;
  if (o.slotsOn == null || !o.socCoherent || o.poolSocPct == null || !Number.isFinite(o.poolSocPct)) return null;
  const ref = linePoolReference(s.forceChargeLinePoolSamples, nowMs);
  if (ref == null || !(o.poolSocPct < ref.pct)) return null;
  const stop = panelStopCeilingPct(s, o);
  if (stop == null) return null;
  const slots = oursOf(s).filter((n) => {
    const soc = o.slotSocPct?.[n];
    return o.slotsOn!.includes(n) && typeof soc === 'number' && Number.isFinite(soc) && soc < stop;
  });
  return slots.length > 0 ? { slots, poolPct: o.poolSocPct, refPct: ref.pct, refAtMs: ref.atMs, stopCeilingPct: stop } : null;
}

/** v1.186.0 — the ON-verify verdict /api/night-charge/status serves beside forceChargeOnAtMs:
 *  null = no force-charge tonight; 'unverified' = ON issued, no live readback has proven it
 *  yet (stays so if the night ends that way). */
export function forceChargeOnReadbackStatus(
  s: Pick<NightActuationState, 'forceChargeOnAtMs' | 'forceChargeOnVerifiedAtMs' | 'forceChargeOnFailedAtMs'>,
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
  const ours = s.forceChargeSlots != null && s.forceChargeSlots.length > 0 ? s.forceChargeSlots : [...ALL_SOURCE_SLOTS];

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
        && nowMs < blindResendStopMs(s, o.nextLegOpenMs)!
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
    // ── 2a. LINE CEILING LOWERED (v1.200.0, review). A night switched ON in cost mode whose cost gate went
    // off since (an option change and a restart) runs in line mode — no software stop — under the cost
    // ceiling the panel was synced to. Lower the panel ceiling to the line mode's own, the safe direction:
    // never under ⌈L⌉ + 2H, and the cost gate off must never leave the cost ceiling in charge (R4). ──
    const lower = lineCeilingLoweringDue(s, o);
    if (lower) return lower;
    // ── 2b. ON VERIFICATION (v1.186.0). Only when no OFF is due, and no re-issue inside
    // FORCE_CHARGE_ON_RETRY_CUTOFF_MS of the window end; an OFF is also never held by the
    // per-slot cooldown an ON took (ecoflow/commands.ts), so a re-issue cannot delay the
    // window-end, target or grid-loss OFF. ──
    const verify = verifyForceChargeOn(s, nowMs, o, ours);
    if (verify.kind !== 'none') return verify;
    // ── 2c. LINE RE-ON CHECK (v1.200.0, review 2). A line re-ON is readback-checked like the ON: once, its
    // grace after it, BEFORE the budget's next re-ON (lineReOnCheckDue). ──
    const reOnCheck = lineReOnCheckDue(s, nowMs, o);
    if (reOnCheck) return reOnCheck;
    // ── 2d. LINE RE-ON (v1.200.0, review). A line night whose verified ON the panel has since switched
    // off at its ceiling, with the pool back under the start target: switch it back on (lineReOnDue). ──
    return lineReOnDue(s, nowMs, o, ours) ?? verify;
  }

  // ── 3. RESTORE the panel's own force-charge ceiling once tonight is done with it.
  // Without this an operator's later storm-prep Charge Now silently stops at tonight's
  // 80-90 instead of the 100 the panel was set to. "Done" = our force-charge verified
  // OFF, or — if it never started — the night is over. ──
  const nightOver = s.cancelled || s.revertedAtMs != null || s.foreignSettledAtMs != null
    || s.windowEndMs == null || nowMs >= writeWindowEndMs(s)!;
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
  // v1.200.0 — the mode from the LIVE gates (forceChargeModeOf): the cost force-charge, the outage line,
  // or neither. A record with no line ask reads exactly today's gate and target.
  const gates = gatesOf(o);
  if (!anyForceChargeGate(s, gates)) {
    return { kind: 'none', why: `disabled (NIGHT_CHARGE_MODE advisory; or, with no outage line above the reserve tonight, ARB_OBJECTIVE not cost or ARB_COST_MAX_SOC_PCT at or below the ${RESERVE_WRITE_MAX_PCT}% reserve)` };
  }
  // v1.167.0 — the target is the announced plan's economic ceiling. Anything above the
  // reserve is reachable: the software stop ends it at the target, whatever the panel's
  // 80% force-charge minimum. At or below the reserve there is nothing to add.
  // v1.200.0 — or, on a line night, max(that ceiling where it rides, ⌈L⌉). Above the reserve maximum or
  // nothing: forceChargeModeOf rides neither a cost ceiling nor a line ask at or below it.
  const mode = forceChargeModeOf(s, gates);
  if (mode == null) {
    const c = s.forceChargeCeilingPct;
    if (c == null || !Number.isFinite(c)) {
      return { kind: 'none', why: `no force-charge target tonight (no cost ceiling and no outage line above the ${RESERVE_WRITE_MAX_PCT}% reserve) — reserve-only night` };
    }
    return { kind: 'none', why: `tonight's ${c}% target is at or below the ${RESERVE_WRITE_MAX_PCT}% reserve — the reserve alone reaches it` };
  }
  const target = mode.targetPct;
  if (s.appliedAtMs == null || s.applyVerifiedAtMs == null) return { kind: 'none', why: 'waiting for the reserve write to be verified by readback' };
  if (s.cancelled || s.revertedAtMs != null) return { kind: 'none', why: s.cancelled ? 'the night was cancelled' : 'the reserve has already been reverted' };
  if (s.foreignSettledAtMs != null) return { kind: 'none', why: 'the reserve was set outside the add-on — the night\'s write no longer holds it' };
  if (s.windowStartMs == null || s.windowEndMs == null) return { kind: 'none', why: 'the night has no charge window' };
  if (nowMs < s.windowStartMs) return { kind: 'none', why: 'the overnight window has not opened yet' };
  // The force-charge ends at the window close, or an hour before on-peak if that is sooner
  // (writeWindowEndMs): the ceiling sync and the ON are raises, and stop there.
  const endMs = writeWindowEndMs(s)!;
  if (nowMs >= endMs - FORCE_CHARGE_MIN_RUN_MS) {
    return { kind: 'none', why: endMs < s.windowEndMs
      ? `under ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min left before the on-peak guard (an hour before on-peak) — not worth starting`
      : `under ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min of window left — not worth starting` };
  }
  const W = FORCE_CHARGE_BLOCKER_WHY;
  if (o.vitalsRed) return { kind: 'none', why: W.vitals };
  if (!o.socCoherent) return { kind: 'none', why: W.incoherent };
  if (o.gridPresent !== true || o.gridStaLost) { // unknown grid never starts a grid charge
    return { kind: 'none', why: o.gridStaLost ? W.gridSta : `${W.gridPresence}${o.gridPresent === false ? 'ABSENT' : 'unknown'}` };
  }
  if (o.slotsOn == null) return { kind: 'none', why: W.noReadback }; // need a live readback to start
  if (o.slotsOn.length > 0) return { kind: 'none', why: `${W.alreadyOn}${o.slotsOn.join(', ')} — that is the operator's, never taken over` }; // someone else's Charge Now — never take ownership
  const slots = o.connectedSlots.filter((n) => Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS);
  if (slots.length === 0) return { kind: 'none', why: W.noSlots };
  // The panel must READ its backstop ceiling before ON. Issuing ON in the same tick as an
  // unverified ceiling write leaves a failed software stop to fill to whatever the panel
  // holds (100 live) — past the owner's ceiling and past the solar headroom.
  // v1.200.0 — the mode's: the cost ceiling's (today), or a line night's ⌈L⌉ + 2H at least.
  const desired = mode.panelCeilingPct;
  if (o.ceilingReadbackPct == null) return { kind: 'none', why: W.ceilingReadback };
  if (o.ceilingReadbackPct !== desired) {
    // The first capture of the panel's own value is kept (and carried across nights
    // by armFromPlan while unrestored), so the restore always returns the ORIGINAL.
    const prior = s.forceChargeCeilingPriorPct ?? o.ceilingReadbackPct;
    if (s.forceChargeCeilingAttemptedAtMs == null) return { kind: 'syncCeiling', pct: desired, prior };
    if (nowMs - s.forceChargeCeilingAttemptedAtMs < FORCE_CHARGE_CEILING_VERIFY_AFTER_MS) return { kind: 'none', why: `waiting for the panel's ceiling to read ${desired}% (reads ${o.ceilingReadbackPct}%)` };
    if (s.forceChargeCeilingSyncRetries < FORCE_CHARGE_CEILING_SYNC_RETRIES) return { kind: 'syncCeiling', pct: desired, prior };
    return { kind: 'none', why: `${W.ceilingRefused}${desired}% ceiling (still reads ${o.ceilingReadbackPct}%) — reserve-only tonight rather than overfill` };
  }
  // v1.167.0 — JUST IN TIME. The ceiling above is synced the moment the night is live,
  // hours before this, so its readback never delays the start.
  if (o.poolSocPct == null || o.fullKwh == null || !(o.fullKwh > 0)) {
    return { kind: 'none', why: 'no live pool reading to time the start from' };
  }
  if (mode.kind === 'line') {
    // v1.200.0 — LINE: "already there" is the panel ceiling (above it the panel would not import), so a
    // pool above the line but under the ceiling still gets its final segment ON; the start is timed to
    // the start target at the close less FORCE_CHARGE_MIN_RUN_MS; nothing stops it before the close.
    if (o.poolSocPct >= mode.panelCeilingPct) {
      return { kind: 'none', why: `the pool already reads the ${mode.panelCeilingPct}% panel ceiling — above tonight's ${mode.askPct}% outage line` };
    }
    if (nowMs < forceChargeLineStartAtMs(endMs, mode.startTargetPct, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh, slots.length)) {
      return { kind: 'none', why: `just in time — holding off so the pool reaches ~${mode.startTargetPct}% ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min before the window closes, then stays on to the close for the ${mode.askPct}% outage line` };
    }
    return { kind: 'on', slots };
  }
  if (o.poolSocPct >= forceChargeStopPct(target)) return { kind: 'none', why: `the pack is already at tonight's ${target}% target` };
  if (nowMs < forceChargeStartAtMs(endMs, target, o.poolSocPct, o.fullKwh, o.chargeRateKw, o.evDisplacedKwh, slots.length)) { // window checked above
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
  /** v1.191.0 (H2) — connected slots, for the fallback rate (planRateFallbackKw); omitted = unknown. */
  slotCount?: number | null,
): number {
  // Unknown ⇒ the fixed plan rate (or slots × FORCE_CHARGE_KW_PER_CORE when that is set). A known
  // rate under the floor is FLOORED (start sooner), never replaced by the faster fixed rate (which
  // would start later and end short).
  const rate = rateKw != null && Number.isFinite(rateKw)
    ? Math.max(FORCE_CHARGE_MIN_RATE_KW, rateKw) : planRateFallbackKw(slotCount);
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
    rate = Math.min(rate, i.slotCount * forceChargeKwPerCore());
  }
  return Math.max(FORCE_CHARGE_MIN_RATE_KW, rate);
}
