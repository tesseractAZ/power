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
 *  - The reserve ALWAYS reverts: at window close (v1.187.0; +5 min before) (or immediately on
 *    a post-apply cancel) the prior value is restored. Repeated revert
 *    failure escalates to a critical annunciation while retries continue.
 *  - R1 — never into on-peak: no raise from an hour before the on-peak period after the
 *    window, and the restore falls due then at the latest (writeWindowEndMs, revertDueMs);
 *    an unconfirmed restore pages on the clock alone (decideRevertDeadline); a reserve
 *    someone else set is left alone (foreignStep).
 *    The floor/runway/SoC alarm spine is fully independent of this module
 *    and keeps its own protection throughout.
 * ═════════════════════════════════════════════════════════════════════════ */

import { RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT, SHP2_SOURCE_SLOTS } from './hwSpec.js';

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
  state: Pick<NightActuationState, 'appliedAtMs' | 'revertedAtMs'> & Partial<Pick<NightActuationState, 'foreignSettledAtMs'>>,
): boolean {
  // A reserve someone else set during the window (foreignSettledAtMs, decideActuation's two-poll
  // rule) is theirs: our write no longer holds it, and nothing of ours will restore it.
  return state.appliedAtMs != null && state.revertedAtMs == null && state.foreignSettledAtMs == null;
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
/*
 * v1.187.10 — AND through the revert readback lag. The revert stamps `revertedAtMs` on the
 * cloud ACK, so `isReserveArbitrageRaised` turns false while the SHP2 still reports our 50%
 * for ~20-60 s; this returned that 50 as the owner's floor until the readback, and the
 * runway (60 s cache) measured against it for ~90 s. 2026-10-03 00:01:25: "reserve in
 * 5.6 h" from a pool of 67 kWh, against ~52 kWh of margin above the real 16% floor — on 6 of
 * 10 revert nights in 14 days. On grid the runway alarm is backstopped; a revert on GRID
 * LOSS (decideActuation's gridLossAbort) would have run the full ladder against 50, and a
 * pool below 50 reads "at the reserve floor — shed load or start the generator". The floor
 * now holds the prior while `isRevertSettling` does — the predicate the alert posture has
 * used since v1.120.0 (effectiveArbitragePosture): the live value still exactly our target,
 * within REVERT_READBACK_GRACE_MS of the revert.
 */
export function ownerReserveFloorPct(
  state: Pick<NightActuationState, 'appliedAtMs' | 'revertedAtMs' | 'priorReservePct' | 'targetPct'>
    & Partial<Pick<NightActuationState, 'foreignSettledAtMs'>>,
  liveReservePct: number | null,
  nowMs: number,
): number | null {
  if (isReserveArbitrageRaised(state) || isRevertSettling(state, liveReservePct, nowMs)) {
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

/**
 * v1.187.22 — below this an expected draw is NO charge: the figure a push would state as "~0 kWh"
 * (pushes state one decimal). A night whose expected draw is under it is a night the write only
 * holds the reserve as a floor — the pool is expected to open the window at or above the level the
 * write drives it to — and every line says so ("reserve held at 50% tonight — no charge expected"),
 * never "charging to ~50% (~0 kWh)" or "less than 1 kilowatt hour". Here, beside the spoken line,
 * because this module imports nothing; nightChargeAdvisor.noChargeExpected reads it for a plan.
 */
export const NO_CHARGE_EXPECTED_KWH = 0.05;

/** v1.187.22 — an expected draw that is no charge at all (NO_CHARGE_EXPECTED_KWH). false with no
 *  figure: no expected figure is not an expectation of none. PURE. */
export function isNoChargeKwh(kwh: number | null | undefined): boolean {
  return kwh != null && Number.isFinite(kwh) && kwh < NO_CHARGE_EXPECTED_KWH;
}

/*
 * v1.187.22 — the line says what the write will do: the level it drives the pool to (the reserve,
 * or the force-charge stop when force-charge rides the night) and the energy it is expected to
 * draw. On 2026-10-12 it said "Buying about 64 kilowatt hours" — the islanded worst case the plan
 * is sized on — for a write that would have drawn ≈34. With no expected figure it speaks no
 * energy figure at all, never the worst case. Under 1 kWh is said as such, not "about 0".
 * The time is the WINDOW's ("in the charge window that opens at 00:00"), not "starting at": a
 * pool that opens above the reserve is not charged at the open — the house draws it until the
 * just-in-time force-charge (~03:14 from 74% at 21:30). A window that closes before the level is
 * reached (`toward`) is said so: "toward 80 percent, … in the charge window that opens at 23:00,
 * which ends before it gets there."
 * A night that charges nothing (isNoChargeKwh — the pool is expected to stay at or above the
 * level) is not a charge: "The backup reserve will be held at 50 percent in the charge window
 * that opens at 00:00; no charge is expected." — the reserve the write sets (`reservePct`), not
 * the level, and no figure.
 */
export function nightChargeSpokenNotice(o: {
  /** The level tonight's write drives the pool to, % (nightChargeAdvisor.chargeLevelPct). */
  levelPct: number;
  /** The reserve the write sets, % (the armed targetPct): what a night that charges nothing holds. */
  reservePct: number;
  /** The expected draw, kWh (nightChargeAdvisor.statedBuyKwh); null ⇒ no energy figure. */
  expectedKwh: number | null;
  /** The window closes before the level is reached (nightChargeAdvisor.chargeIsWindowBound). */
  toward?: boolean;
  deadlineText: string;
  deadlineTextEs: string;
  cushionShortfall: boolean;
}): { en: string; es: string } {
  // The shortfall clause stays on the audible path — it must never be quieter
  // about residual risk than the text channel — but as a clause, not a sentence,
  // because it discloses on every single plan.
  const shortEn = o.cushionShortfall ? ' Outage cushion not fully met.' : '';
  const shortEs = o.cushionShortfall ? ' Margen de respaldo no cubierto por completo.' : '';
  if (isNoChargeKwh(o.expectedKwh)) {
    const reserve = Math.round(o.reservePct);
    return {
      en:
        `Night charge notice. The backup reserve will be held at ${reserve} percent in the charge window that opens `
        + `${o.deadlineText}; no charge is expected.${shortEn} Cancel on the Power panel before then.`,
      es:
        `Aviso de carga nocturna. La reserva de respaldo se mantendrá en el ${reserve} por ciento en la ventana de carga que comienza `
        + `${o.deadlineTextEs}; no se espera ninguna carga.${shortEs} Cancele en el panel Power antes de esa hora.`,
    };
  }
  const level = Math.round(o.levelPct);
  const kwh = o.expectedKwh != null && Number.isFinite(o.expectedKwh) ? Math.round(o.expectedKwh) : null;
  const kwhEn = kwh == null ? ''
    : kwh < 1 ? ', less than 1 kilowatt hour'
      : `, about ${kwh} kilowatt hour${kwh === 1 ? '' : 's'}`;
  const kwhEs = kwh == null ? ''
    : kwh < 1 ? ', menos de 1 kilovatio hora'
      : kwh === 1 ? ', alrededor de 1 kilovatio hora' : `, unos ${kwh} kilovatios hora`;
  const toward = o.toward === true;
  return {
    en:
      `Night charge notice. Charging the backup pool ${toward ? 'toward' : 'to about'} ${level} percent${kwhEn}, `
      + `in the charge window that opens ${o.deadlineText}${toward ? ', which ends before it gets there' : ''}.`
      + `${shortEn} Cancel on the Power panel before then.`,
    es:
      `Aviso de carga nocturna. Se cargarán las baterías de respaldo ${toward ? 'rumbo al' : 'hasta cerca del'} ${level} por ciento`
      + `${kwhEs}, en la ventana de carga que comienza ${o.deadlineTextEs}${toward ? ' y termina antes de alcanzar ese nivel' : ''}.`
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
 * a minimum equal to this maximum (see docs/reference/15-2-night-charge-writes.md
 * “8b. Supervised write mode”). Anything that reports a
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
 *
 * v1.191.0 — both bounds are hardware facts in hwSpec.ts (values unchanged, re-exported here for
 * the existing importers). The 10 % floor stays a safety rule and the 50 % ceiling the firmware's
 * (P6): neither is an option.
 */
export { RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT };

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

/** Apply window: the write may fire from the moment the plan's charge window
 *  opens until 30 min after (a late boot inside the window still buys most of
 *  the night; later than that the announced sizing is stale).
 *
 *  ★ v1.187.0 — THE LEAD IS 0 (it was 5 min since v1.50.0). The reserve raise IS a
 *  grid charge the moment it exceeds the pool: on 2026-09-28 the write landed at
 *  22:55:28 and the Cores were taking ~5.2 kW each 14 s later, 1.12 kWh by 23:00 at
 *  the 16.91¢ off-peak rate instead of the 12.59¢ overnight one (09-22: ~0.85 kWh).
 *  The lead bought nothing the window would not: the panel takes the write within
 *  seconds, not minutes. Force-charge already refused to start before the window
 *  (nightForceCharge.ts: "the overnight window has not opened yet"), and its ceiling
 *  sync waits for the window too, so it now follows the verified reserve by one tick
 *  (~1 min) — the order (apply → readback → ceiling → ON) is unchanged. The cancel
 *  deadline, which is the write moment, moves to the window open: the owner gains
 *  5 min. The constant stays so every reader of the write moment keeps one name. */
export const APPLY_LEAD_MS = 0;
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

/** Revert fires when the plan's charge window closes.
 *
 *  ★ v1.187.0 — THE LAG IS 0 (it was 5 min since v1.50.0), for the same reason as
 *  APPLY_LEAD_MS: while the raised reserve stands above the pool the panel keeps
 *  grid-charging, so 05:00-05:05 (Mon-Fri; Saturday 00:00-00:05 after a Friday
 *  window) bought at the off-peak rate on any night still under its target at the
 *  close. The revert's readback verification (REVERT_VERIFY_AFTER_MS) and the
 *  revert-settling grace (REVERT_READBACK_GRACE_MS) are measured from the revert
 *  itself, not from this lag, so neither moves. Force-charge's own window-end OFF
 *  fires on the same tick, AHEAD of the restore (nightForceCharge.ts
 *  actuationStepOrder: a slow revert PUT must not hold the OFF); both are
 *  OFF-direction writes. The delivered-energy span ends at the restore's own stamp
 *  (nightLedgerScoring.ts deliveredHoldSpan), not at this constant. */
export const REVERT_LAG_MS = 0;
/** v1.187.0 — the lag every night actuated before v1.187.0 ran with (and its lead): the
 *  scorer's delivered-energy span still uses it for a night applied before its window with
 *  no restore stamp — one actuated wholly on the old schedule (deliveredHoldSpan). */
export const LEGACY_REVERT_LAG_MS = 5 * 60_000;
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

/*
 * THE ON-PEAK GUARD. A raise left standing into the on-peak period is the expensive end
 * state: the panel holds the raised reserve as its floor and refills to it from the grid at
 * the day's highest rate. Each armed night therefore carries the start of the on-peak period
 * that follows its window (`nextOnPeakStartMs`, stamped by armFromPlan from
 * chargeWindows.nextOnPeakStartMs), and:
 *  - no raise is issued from ON_PEAK_RAISE_GUARD_MS before it: the apply, its re-issues, and
 *    on the force-charge side the ceiling sync, the ON and its re-issue
 *    (writeWindowEndMs bounds them all);
 *  - the restore and the force-charge OFF fall due at min(window end, that same moment)
 *    (revertDueMs, writeWindowEndMs);
 *  - an unconfirmed restore pages ON_PEAK_PAGE_LEAD_MS before it at the latest, and again
 *    when it starts (decideRevertDeadline); the force-charge OFF deadline is capped at the
 *    same lead (nightForceCharge.forceChargeOffDeadlineMs).
 * The overnight window ends at 05:00, eleven hours before the 16:00 on-peak start, so on a
 * night that goes to plan none of this moves anything. A record armed before the stamp
 * (null) keeps the window-only schedule.
 */
export const ON_PEAK_RAISE_GUARD_MS = 60 * 60_000;
/** The latest an unconfirmed restore (or force-charge OFF) is paged before on-peak starts. */
export const ON_PEAK_PAGE_LEAD_MS = 30 * 60_000;
/** An unconfirmed restore pages this long after the window close, if on-peak is further off. */
export const REVERT_DEADLINE_AFTER_WINDOW_MS = 30 * 60_000;
/** A reserve reading that is neither ours nor the value we restore must stand this long — the
 *  same value on two readings at least this far apart — before it is taken as someone else's. */
export const FOREIGN_RESERVE_SETTLE_MS = 5 * 60_000;

/** The moment raises stop: ON_PEAK_RAISE_GUARD_MS before the stamped on-peak start; null with
 *  no stamp. PURE. */
export function onPeakGuardStartMs(s: Pick<NightActuationState, 'nextOnPeakStartMs'>): number | null {
  const p = s.nextOnPeakStartMs;
  return p != null && Number.isFinite(p) ? p - ON_PEAK_RAISE_GUARD_MS : null;
}

/** The end of the span a night's raises may stand in: min(window end, onPeakGuardStartMs). The
 *  window end alone with no stamp; the guard alone with no window; null with neither. PURE. */
export function writeWindowEndMs(s: Pick<NightActuationState, 'windowEndMs' | 'nextOnPeakStartMs'>): number | null {
  const guard = onPeakGuardStartMs(s);
  if (s.windowEndMs == null) return guard;
  return guard == null ? s.windowEndMs : Math.min(s.windowEndMs, guard);
}

/** When the restore falls due on the clock: min(window end + REVERT_LAG_MS, onPeakGuardStartMs);
 *  null with neither (only a cancel or a grid loss then reverts). PURE. */
export function revertDueMs(s: Pick<NightActuationState, 'windowEndMs' | 'nextOnPeakStartMs'>): number | null {
  const guard = onPeakGuardStartMs(s);
  if (s.windowEndMs == null) return guard;
  const close = s.windowEndMs + REVERT_LAG_MS;
  return guard == null ? close : Math.min(close, guard);
}

/** True from onPeakGuardStartMs on: no raise of any kind is issued. PURE. */
export function onPeakGuardActive(s: Pick<NightActuationState, 'nextOnPeakStartMs'>, nowMs: number): boolean {
  const guard = onPeakGuardStartMs(s);
  return guard != null && nowMs >= guard;
}

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
  /** STAMPED AT ARM TIME: the start of the first on-peak period at or after the window open
   *  (chargeWindows.nextOnPeakStartMs). Raises stop, and the restore and force-charge OFF fall
   *  due, ON_PEAK_RAISE_GUARD_MS before it. null = no on-peak period ahead, or a record armed
   *  before the stamp (the window-only schedule). */
  nextOnPeakStartMs: number | null;
  /** A reserve reading that is neither our target nor the value we restore, and when it was
   *  first read: the first of the two readings the foreign rule needs (decideActuation). */
  foreignReservePct: number | null;
  foreignSeenAtMs: number | null;
  /** When that reading was read again, FOREIGN_RESERVE_SETTLE_MS or more later: the reserve is
   *  someone else's. Nothing more is written to it for this night, and the night is resolved. */
  foreignSettledAtMs: number | null;
  /** When the unconfirmed-restore page went (decideRevertDeadline): once at the deadline, once
   *  at the on-peak start. */
  revertDeadlinePagedAtMs: number | null;
  revertDeadlineOnPeakPagedAtMs: number | null;
  /** When that stage came with the panel reading neither our target nor nothing: decided, with no
   *  page (decideRevertDeadline's 'pass'). Each stage is decided once, at its moment. */
  revertDeadlinePassedAtMs: number | null;
  revertDeadlineOnPeakPassedAtMs: number | null;
  /** When a live reading proved an attempted write never landed (attemptProvedUnlanded): after the
   *  apply window, and the last attempt's readback grace, the panel still read the attempt-time
   *  baseline. Nothing of ours holds the reserve then, whatever later readings are missing. */
  attemptUnlandedAtMs: number | null;
  /** When a live reading proved an ACK'd write never took effect (applyProvedUnlanded): its apply
   *  ladder ended in applyFailed with the panel still reading the attempt-time baseline, the last
   *  attempt's readback grace run. Its restore is a no-op and nothing of ours holds the reserve —
   *  until a later reading verifies the write (applyVerifiedAtMs), which outranks it. */
  applyUnlandedAtMs: number | null;
  /** When the deadline stage first waited for a restore that had not had its chance
   *  (restoreAwaitingFirstChance: a process down across the deadline). It waits at most
   *  REVERT_DEADLINE_HOLD_MAX_MS from here. */
  revertDeadlineHeldAtMs: number | null;
  /** v1.189.0 (review) — the restore was decideActuation's grid-loss abort (gridLossAbort): what
   *  the summary says ended the night, when it goes after the restore's ACK (restoreSummaryDue). */
  revertGridLossAbort: boolean;
  /** v1.189.0 (review) — when the summary of the restore went (the morning summary, or a mid-day
   *  leg's own): once the restore read back, or once its readback grace ran with none
   *  (restoreSummaryDue). A record from before the field had its summary sent on the ACK, and reads
   *  back with revertedAtMs here (coerceActuationState), so an update never sends it again. */
  restoreSummaryAtMs: number | null;
  /** v1.190.1 — when the owed summary first waited for this process's first reading of the reserve
   *  (restoreSummaryDue 'hold': a restart across the restore's readback grace). It waits at most
   *  REVERT_DEADLINE_HOLD_MAX_MS from here; on the record, so a second restart inside the wait does
   *  not start it over. */
  restoreSummaryHeldAtMs: number | null;
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
    nextOnPeakStartMs: null,
    foreignReservePct: null, foreignSeenAtMs: null, foreignSettledAtMs: null,
    revertDeadlinePagedAtMs: null, revertDeadlineOnPeakPagedAtMs: null,
    revertDeadlinePassedAtMs: null, revertDeadlineOnPeakPassedAtMs: null,
    attemptUnlandedAtMs: null,
    applyUnlandedAtMs: null,
    revertDeadlineHeldAtMs: null,
    revertGridLossAbort: false,
    restoreSummaryAtMs: null, restoreSummaryHeldAtMs: null,
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
      ? o.forceChargeSlots.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= SHP2_SOURCE_SLOTS)
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
      ? o.forceChargeOnFailedSlots.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= SHP2_SOURCE_SLOTS)
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
    nextOnPeakStartMs: num(o.nextOnPeakStartMs),
    foreignReservePct: num(o.foreignReservePct),
    foreignSeenAtMs: num(o.foreignSeenAtMs),
    foreignSettledAtMs: num(o.foreignSettledAtMs),
    revertDeadlinePagedAtMs: num(o.revertDeadlinePagedAtMs),
    revertDeadlineOnPeakPagedAtMs: num(o.revertDeadlineOnPeakPagedAtMs),
    revertDeadlinePassedAtMs: num(o.revertDeadlinePassedAtMs),
    revertDeadlineOnPeakPassedAtMs: num(o.revertDeadlineOnPeakPassedAtMs),
    attemptUnlandedAtMs: num(o.attemptUnlandedAtMs),
    applyUnlandedAtMs: num(o.applyUnlandedAtMs),
    revertDeadlineHeldAtMs: num(o.revertDeadlineHeldAtMs),
    revertGridLossAbort: o.revertGridLossAbort === true,
    // A record written before the field (v1.189.0 review) sent its summary on the restore's ACK:
    // absent, it reads as sent then, so the update never sends a second one.
    restoreSummaryAtMs: o.restoreSummaryAtMs === undefined ? num(o.revertedAtMs) : num(o.restoreSummaryAtMs),
    restoreSummaryHeldAtMs: num(o.restoreSummaryHeldAtMs),
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

/** v1.187.22 — the force-charge ceiling armFromPlan records from a plan: its economic ceiling
 *  when finite, else null (a reserve-only night). One definition, shared with the expected-buy
 *  disclosure (nightForceCharge.armedWriteLevelPct), so the level a plan says its write drives
 *  the pool to is read from the field this records. PURE. */
export function armedForceChargeCeilingPct(plan: Pick<ArmablePlan, 'costCeilingSocPct'>): number | null {
  return typeof plan.costCeilingSocPct === 'number' && Number.isFinite(plan.costCeilingSocPct)
    ? plan.costCeilingSocPct : null;
}

/**
 * Arm tonight's actuation from the evening job's announced plan. Returns the
 * armed state, or null when the plan is not actuatable (hold night,
 * incomplete basis, no window, no target). Arming REPLACES any prior state —
 * except an unresolved night, which must never be orphaned:
 *  - an applied-but-unreverted write always refuses re-arming;
 *  - so does a restore that has not read back while the panel still reads the raised target (or
 *    cannot be read);
 *  - an ATTEMPTED-but-unconfirmed write (write issued, no success recorded)
 *    refuses re-arming unless the live reserve reading proves the write never
 *    landed (it still equals the attempt-time baseline), or a reading after its
 *    apply ladder already did (attemptUnlandedAtMs). A lost confirmation
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
  /** v1.187.22 — force-charge enabled at arm time (index.ts: forceChargeOn(), the gate the plan's
   *  expected figure was made with), stamped as `forceChargeRides`. Omitted ⇒ null, unknown. */
  forceChargeEnabled?: boolean,
  /** The start of the on-peak period after the window open (chargeWindows.nextOnPeakStartMs),
   *  stamped as `nextOnPeakStartMs`. Omitted ⇒ null: the window-only schedule. */
  nextOnPeakStartMs?: number | null,
): NightActuationState | null {
  // Unresolved (armOpenItem, below — one definition, which the charge cycle's legResolved reads too):
  //  - applied and not restored — unless the reserve settled as someone else's (foreignSettledAtMs),
  //    which nothing of ours will restore;
  //  - a restore sent that has not read back, with the panel still on the raised target or silent
  //    (restoreUnconfirmed): the record that pages and holds for it must stay;
  //  - v1.165.0 — a force-charge that was switched ON and never verified OFF. Arming returns a FRESH
  //    record, so re-arming here would bury the only record that knows to switch it off.
  //    Verification keeps running after an escalation, so this clears itself once the slots read OFF;
  //  - an attempt confirmed neither way, not provably un-applied — never bury it.
  if (armOpenItem(prev, liveReservePct) != null) return null;
  if (!plan.chargeTonight || !plan.basisComplete) return null;
  if (plan.window == null || plan.setpointSocPct == null) return null;
  if (plan.buyKwh == null || plan.buyKwh <= 0) return null;
  if (plan.window.endMs <= plan.window.startMs || plan.window.startMs <= nowMs - APPLY_LATE_MS) return null;
  const ceiling = armedForceChargeCeilingPct(plan);
  return {
    ...emptyActuationState(),
    day,
    announcedAtMs: nowMs,
    targetPct: clampReserveTarget(plan.setpointSocPct),
    buyKwh: plan.buyKwh,
    windowStartMs: plan.window.startMs,
    windowEndMs: plan.window.endMs,
    forceChargeCeilingPct: ceiling,
    // v1.187.22 — whether force-charge rides this night, as the evening push names it: enabled,
    // and the armed ceiling above the reserve maximum (at or below it the reserve reaches it alone).
    forceChargeRides: forceChargeEnabled === undefined ? null
      : forceChargeEnabled && ceiling != null && ceiling > RESERVE_WRITE_MAX_PCT,
    nextOnPeakStartMs: nextOnPeakStartMs != null && Number.isFinite(nextOnPeakStartMs) ? nextOnPeakStartMs : null,
    // An unrestored original survives the fresh record, so tonight's restore still
    // returns the OWNER's ceiling, never a value we left behind.
    forceChargeCeilingPriorPct:
      prev.forceChargeCeilingPriorPct != null && prev.forceChargeCeilingRestoredAtMs == null
        ? prev.forceChargeCeilingPriorPct : null,
  };
}

/**
 * What a record still holds on the device, in words — the first of armFromPlan's unresolved
 * conditions, in its order; null when it holds nothing of ours. PURE.
 *  - a reserve write applied and not restored (unless the reserve settled as someone else's);
 *  - a restore sent and not read back while the panel still reads the raised target (or, on a
 *    partly granted night, another value of the raise: readsOwnRaise), or reads
 *    nothing (restoreUnconfirmed): its record carries the restore's readback, the revertDeadline
 *    pages and the money detectors' hold, and a fresh record would bury all three — a Friday
 *    window's stuck restore was replaced by Saturday's arm, and Monday's on-peak page and hold
 *    went with it;
 *  - a force-charge switched ON whose OFF has not verified;
 *  - a reserve write attempted and confirmed neither way — unless it is proven never to have
 *    landed (attemptNeverLanded: the live reading, or a stamped one, of the attempt-time baseline).
 * One definition: armRefusalReason leads with it, and the charge cycle's legResolved reads it
 * (chargeCycle.ts), so promotion within a cycle and arming the next one refuse on the same facts.
 */
export function armOpenItem(prev: NightActuationState, liveReservePct: number | null): string | null {
  const night = prev.day ?? 'a previous night';
  if (prev.appliedAtMs != null && prev.revertedAtMs == null && prev.foreignSettledAtMs == null) {
    return `the ${night} reserve write is still applied and not yet restored`;
  }
  if (restoreUnconfirmed(prev, liveReservePct)) {
    const panel = liveReservePct == null ? 'is not reporting its reserve'
      : readsOwnRaise(prev, liveReservePct) ? `still reads ${liveReservePct}%` : `reads ${liveReservePct}, not a valid reserve`;
    return `the ${night} reserve restore was sent and has not read back (the panel ${panel})`;
  }
  if (prev.forceChargeOnAtMs != null && prev.forceChargeOffVerifiedAtMs == null) {
    return `the ${night} force-charge was switched ON and its OFF has not verified`;
  }
  if (
    prev.applyAttemptedAtMs != null && prev.appliedAtMs == null && prev.revertedAtMs == null &&
    !attemptNeverLanded(prev, liveReservePct)
  ) {
    return `the ${night} reserve write was attempted and is not confirmed either way`;
  }
  return null;
}

/** A reading that is a reserve setting: a whole number inside the write envelope
 *  [RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT]. A null, fractional or out-of-envelope reading —
 *  a reconnect 0 above all — is no evidence of what the reserve is. PURE. */
export function isReserveSetting(v: number | null): v is number {
  return v != null && Number.isInteger(v) && v >= RESERVE_WRITE_MIN_PCT && v <= RESERVE_WRITE_MAX_PCT;
}

/** A restore of ours was sent (cloud-ACK'd) and has not read back, while the write may still hold
 *  the reserve (revertOutstanding), and the panel still reads the raise (readsOwnRaise: the target,
 *  or on a partly granted night another value inside what it asked for) or no reserve setting
 *  (isReserveSetting: nothing, or a reconnect 0): it may still stand. A reading of any other
 *  setting is the restore, or someone else's setting (the foreign rule), never ours to hold the
 *  next arm on. PURE. */
export function restoreUnconfirmed(
  s: Pick<NightActuationState, 'appliedAtMs' | 'applyAttemptedAtMs' | 'revertedAtMs' | 'revertVerifiedAtMs' | 'foreignSettledAtMs' | 'targetPct' | 'priorReservePct'>
    & Partial<Pick<NightActuationState, 'applyVerifiedAtMs' | 'applyUnlandedAtMs' | 'attemptUnlandedAtMs' | 'requestedPct' | 'attemptBaselinePct'>>,
  liveReservePct: number | null,
): boolean {
  return s.appliedAtMs != null && s.revertedAtMs != null && revertOutstanding(s)
    && s.targetPct !== s.priorReservePct
    && (!isReserveSetting(liveReservePct) || readsOwnRaise(s, liveReservePct));
}

/** An attempted write is proven never to have landed: stamped so (attemptUnlandedAtMs), or the live
 *  reading is still the attempt-time baseline. PURE. */
export function attemptNeverLanded(
  s: Pick<NightActuationState, 'attemptBaselinePct'> & Partial<Pick<NightActuationState, 'attemptUnlandedAtMs'>>,
  liveReservePct: number | null,
): boolean {
  if (s.attemptUnlandedAtMs != null) return true;
  return liveReservePct != null && s.attemptBaselinePct != null && liveReservePct === s.attemptBaselinePct;
}

/**
 * The proof attemptUnlandedAtMs stamps, decided on a live reading. PURE. An attempted write with no
 * success recorded (and no restore) whose apply ladder is over — the night cancelled, or past its
 * apply window (APPLY_LATE_MS: no further attempt is made) — and whose last attempt has had its
 * readback grace (APPLY_VERIFY_AFTER_MS), while the panel still reads the attempt-time baseline,
 * never landed. Before this a write the cloud rejected all night stayed "outstanding" for good, and
 * the first stale reading after the deadline — the next afternoon, or days later — paged a critical
 * about a restore of a reserve that was never raised.
 */
export function attemptProvedUnlanded(s: NightActuationState, liveReservePct: number | null, nowMs: number): boolean {
  if (s.day == null || s.attemptUnlandedAtMs != null) return false;
  if (s.applyAttemptedAtMs == null || s.appliedAtMs != null || s.revertedAtMs != null) return false;
  if (s.attemptBaselinePct == null || liveReservePct == null || liveReservePct !== s.attemptBaselinePct) return false;
  if (s.targetPct != null && s.targetPct === s.attemptBaselinePct) return false;
  const ladderOver = s.cancelled || (s.windowStartMs != null && nowMs > s.windowStartMs + APPLY_LATE_MS);
  return ladderOver && nowMs - s.applyAttemptedAtMs >= APPLY_VERIFY_AFTER_MS;
}

/**
 * The proof applyUnlandedAtMs stamps, decided on a live reading. PURE. The ACK'd-write half of
 * attemptProvedUnlanded: a write the cloud accepted whose apply ladder has ended in applyFailed
 * (applyEscalated: its re-issues spent, or none could be sent before the window's end) without its
 * readback ever showing the target (applyVerifiedAtMs null), with no restore sent yet, the last
 * attempt's readback grace run (APPLY_VERIFY_AFTER_MS), and the panel still reading the
 * attempt-time baseline, never took effect. Its restore is a no-op; before this the restore of a
 * write the add-on had itself reported "NEVER TOOK EFFECT" was paged critical twice whenever the
 * readback went dark at the close. A later reading of the target verifies the write
 * (applyVerified) and makes it outstanding again (revertOutstanding).
 */
export function applyProvedUnlanded(s: NightActuationState, liveReservePct: number | null, nowMs: number): boolean {
  if (s.day == null || s.applyUnlandedAtMs != null) return false;
  if (s.appliedAtMs == null || s.applyVerifiedAtMs != null || !s.applyEscalated || s.revertedAtMs != null) return false;
  // The baseline, read live: no reading proves nothing, and our target is a write that landed.
  if (liveReservePct == null || s.attemptBaselinePct == null || liveReservePct !== s.attemptBaselinePct) return false;
  if (s.targetPct === s.attemptBaselinePct) return false;
  return nowMs - (s.applyLastAttemptMs ?? s.appliedAtMs) >= APPLY_VERIFY_AFTER_MS;
}

/**
 * v1.187.22 — PURE. Why armFromPlan refuses `plan`, in words for the evening push; null when it
 * would arm. The checks are armFromPlan's, in its order (a test holds the two equivalent). With a
 * refused arm in a write mode the push used to take the advisory shape and recommend the plan's
 * level and expected draw — a force-charge to ~80% and ~35 kWh — for a write nothing would make.
 */
export function armRefusalReason(
  prev: NightActuationState,
  plan: ArmablePlan,
  nowMs: number,
  liveReservePct: number | null,
): string | null {
  const open = armOpenItem(prev, liveReservePct);
  if (open != null) return open;
  if (!plan.chargeTonight || !plan.basisComplete) return 'the plan does not call for a charge';
  if (plan.window == null || plan.setpointSocPct == null) return 'the plan has no window or reserve setpoint';
  if (plan.buyKwh == null || plan.buyKwh <= 0) return 'the plan sizes no buy';
  if (plan.window.endMs <= plan.window.startMs) return 'the plan has no valid window';
  if (plan.window.startMs <= nowMs - APPLY_LATE_MS) return `the charge window opened more than ${APPLY_LATE_MS / 60_000} minutes ago`;
  return null;
}

/** v1.187.22 — the evening job's record of a refused arm (armRefusalReason), keyed by the window
 *  the refused plan resolved: persisted beside the notify latch so the card can lead with it. */
export interface ArmRefusalRecord {
  reason: string;
  windowStartMs: number;
  windowEndMs: number;
}

/** v1.187.22 — a persisted refusal record read back (the latch file, restart path): anything
 *  malformed is no record — never a fabricated refusal. PURE. */
export function coerceArmRefusalRecord(raw: unknown): ArmRefusalRecord | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof o.reason !== 'string' || o.reason.length === 0 || !fin(o.windowStartMs) || !fin(o.windowEndMs)) return null;
  return { reason: o.reason, windowStartMs: o.windowStartMs, windowEndMs: o.windowEndMs };
}

/**
 * v1.187.22 — PURE. The refusal the card leads with, or null. A supervised or auto mode that
 * refused to arm tonight's charge plan pushes "planned charge NOT armed tonight — <reason>"; the
 * card, which reads the plan the 30-min recompute keeps fresh, still led with that plan's expected
 * charge ("34.9 kWh — expected charge to ~80%") for a write nothing would make. The record applies
 * to the plan it was refused for — the same window — until that window closes, in a write mode,
 * on a charge plan; a later evening that arms the window writes no record.
 */
export function servedArmRefusal(
  rec: ArmRefusalRecord | null | undefined,
  plan: { chargeTonight: boolean; window: { startMs: number; endMs: number } | null } | null,
  mode: NightChargeMode,
  nowMs: number,
): string | null {
  if (rec == null || mode === 'advisory' || plan == null || !plan.chargeTonight || plan.window == null) return null;
  if (plan.window.startMs !== rec.windowStartMs || plan.window.endMs !== rec.windowEndMs) return null;
  return nowMs < rec.windowEndMs ? rec.reason : null;
}

/** v1.187.22 — the reason recorded when armFromPlan returned a write but no announcement channel
 *  delivered it, so nothing was armed (a write the owner never heard about must not fire). */
export const ARM_UNDELIVERED_REASON = 'the announcement could not be delivered';

/**
 * v1.187.22 — PURE. What the evening job records as tonight's refusal (ArmRefusalRecord), so the
 * card leads with it (servedArmRefusal): armRefusalReason's reason; or, when armFromPlan returned a
 * `candidate` that no announcement channel `delivered` — nothing is armed, and the card led with
 * the plan's expected charge — ARM_UNDELIVERED_REASON. Not when the record that stays in place
 * (`prior`, since the candidate is not persisted) is itself an arm for the same window that will
 * still write (Saturday's arm for the shared Monday window): a write is armed then. null = armed,
 * or nothing to arm.
 */
export function eveningNotArmedReason(o: {
  refused: string | null;
  candidate: Pick<NightActuationState, 'windowStartMs' | 'windowEndMs'> | null;
  delivered: boolean;
  prior: Pick<NightActuationState, 'day' | 'cancelled' | 'targetPct' | 'revertedAtMs' | 'windowStartMs' | 'windowEndMs'>;
}): string | null {
  if (o.refused) return o.refused;
  if (o.candidate == null || o.delivered) return null;
  const p = o.prior;
  const priorWrites = p.day != null && !p.cancelled && p.targetPct != null && p.revertedAtMs == null
    && p.windowStartMs === o.candidate.windowStartMs && p.windowEndMs === o.candidate.windowEndMs;
  return priorWrites ? null : ARM_UNDELIVERED_REASON;
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
  | { kind: 'revertFailed'; restorePct: number }
  /** The reserve reads `pct`, neither our target nor the value we restore: the first of the
   *  two readings the foreign rule needs. Record it (foreignReservePct, foreignSeenAtMs). */
  | { kind: 'foreignSeen'; pct: number }
  /** The reserve reads one of our own values again: the pending sighting no longer stands. */
  | { kind: 'foreignCleared' }
  /** The same foreign value FOREIGN_RESERVE_SETTLE_MS or more after it was first read: it is
   *  someone else's. Stamp foreignSettledAtMs, write nothing, and send an info push. */
  | { kind: 'foreignSettled'; pct: number }
  /** A night whose write the panel granted only in part (applyCeiling) now reads another value
   *  within what the night asked for (ceilingMovedPct): the panel moved on our own write. Adopt it
   *  as the target, as applyCeiling does, so the restore's readback, the revertDeadline pages and
   *  the money detectors' hold compare against what the panel holds. */
  | { kind: 'ceilingMoved'; pct: number };

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
  if (attemptAdoptable(state, opts.currentReservePct)) {
    return { kind: 'adopt', priorPct: state.attemptBaselinePct! };
  }

  // ── REVERT (checked next — always allowed, mode-independent: a raised
  // reserve must come back down even if the owner flipped to advisory). ──
  if (state.appliedAtMs != null && state.revertedAtMs == null) {
    // The reserve settled as someone else's (the foreign rule below): nothing of ours holds it,
    // and restoring our prior would overwrite their value. Write nothing.
    if (state.foreignSettledAtMs != null) return { kind: 'none' };
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
    // FOREIGN. Once the write has read back, a reserve reading that is an in-envelope whole
    // number and neither our target nor our prior is someone else's change — but only on two
    // readings of the same value FOREIGN_RESERVE_SETTLE_MS apart (foreignStep). A settled one
    // wins over the clock: the restore would overwrite it. A pending one does not hold the
    // restore — the window-end revert stays clock-driven, and blind on a null or out-of-envelope
    // reading. Before the write reads back, a short reading is the apply ladder's (applyCeiling).
    const foreign = state.applyVerifiedAtMs != null ? foreignStep(state, opts.currentReservePct, nowMs) : null;
    if (foreign?.kind === 'foreignSettled') return foreign;
    // The restore falls due at the window close, or an hour before on-peak if that is sooner
    // (revertDueMs: the on-peak guard).
    const dueAt = revertDueMs(state);
    const due = state.cancelled || (dueAt != null && nowMs >= dueAt);
    if (due && restorable) {
      return { kind: 'revert', restorePct: state.priorReservePct! };
    }
    if (foreign) return foreign;
    // The panel moved on a write it granted in part (ceilingMovedPct): ours, adopted as the target.
    const moved = state.applyVerifiedAtMs != null ? ceilingMovedPct(state, opts.currentReservePct) : null;
    if (moved != null) return { kind: 'ceilingMoved', pct: moved };
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
        // A re-issue is a raise: never into a closing window, nor within an hour of on-peak
        // (writeWindowEndMs).
        const writeEnd = writeWindowEndMs(state);
        if (state.applyRetries < APPLY_MAX_RETRIES &&
            (writeEnd == null || nowMs < writeEnd - APPLY_VERIFY_AFTER_MS)) {
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
    state.revertVerifiedAtMs == null && state.priorReservePct != null && state.targetPct != null &&
    state.foreignSettledAtMs == null
  ) {
    const restorePct = state.priorReservePct;
    if (opts.currentReservePct === restorePct) return { kind: 'revertVerified' };
    // A value that is neither ours nor the restore, standing on two readings, settles the night
    // as someone else's (foreignStep) — the wait for our restore to read back ends there. Only once
    // the write had read back, as before the restore: a short reading of a write never verified is
    // the panel's partial answer to it, not someone else's setting.
    const foreign = state.applyVerifiedAtMs == null ? null : foreignStep(state, opts.currentReservePct, nowMs);
    if (foreign) return foreign;
    // After the restore, as before it: a partly granted night's panel reading another value within
    // what the night asked for (ceilingMovedPct) is the raise that has not come down, never the
    // restore nor someone else's setting. Adopted as the target, so the re-issue and the failure
    // verdict below, the revertDeadline pages, the next arm's refusal and the money detectors' hold
    // compare against what the panel holds. Without it a reading of 45 after a restore of a night
    // granted 40 of 50 passed both pages, lifted the hold and let the next arm replace the record.
    const movedAfter = state.applyVerifiedAtMs == null ? null : ceilingMovedPct(state, opts.currentReservePct);
    if (movedAfter != null) return { kind: 'ceilingMoved', pct: movedAfter };
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
  if (onPeakGuardActive(state, nowMs)) return { kind: 'none' }; // never a raise within an hour of on-peak
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

type OwnReserveFields = Pick<NightActuationState, 'targetPct' | 'priorReservePct'>
  & Partial<Pick<NightActuationState, 'requestedPct' | 'attemptBaselinePct'>>;

/**
 * The reserve values a night's own write accounts for. PURE.
 *  - the target, and the value the restore writes;
 *  - on a night the panel granted only in part (applyCeiling: `requestedPct` is what was asked,
 *    `targetPct` what the panel settled at), every whole value above the attempt-time baseline up
 *    to the request: the panel moving on our own write — taking more of it later, or settling
 *    somewhere else inside it — is not someone else's setting. Without this the night's own
 *    request, read back late, settled as foreign: the window-close restore was skipped and the
 *    raise stood into on-peak with no page.
 */
export function isOwnReserveValue(s: OwnReserveFields, v: number): boolean {
  if (v === s.targetPct || v === s.priorReservePct) return true;
  const req = s.requestedPct;
  const lower = s.attemptBaselinePct ?? s.priorReservePct;
  return req != null && lower != null && req > lower && v > lower && v <= req;
}

/**
 * The night's raise still stands on this reading. PURE. Our target; or, on a night the panel granted
 * only in part, another whole value inside what the night asked for (isOwnReserveValue's band) that
 * is not the value we restore — the reading the foreign rule and ceilingMoved take as the night's own
 * write. A restore that has not read back is judged on both (decideRevertDeadline, restoreUnconfirmed,
 * revertRetryPending, moneyDetectorReservePct): a reading of the raise is never the restore.
 */
export function readsOwnRaise(s: OwnReserveFields, v: number | null): boolean {
  if (v == null || !Number.isInteger(v)) return false;
  if (v === s.targetPct) return true;
  return v !== s.priorReservePct && isOwnReserveValue(s, v);
}

/**
 * An attempted write with no recorded success (and no restore) whose target the panel reads back,
 * from a valid attempt-time baseline other than the target: it landed, and its confirmation was
 * lost. decideActuation adopts it (then restores it); restoreAwaitingFirstChance lets the deadline
 * stage wait for that restore. One definition for both. PURE.
 */
export function attemptAdoptable(
  state: Pick<NightActuationState, 'applyAttemptedAtMs' | 'appliedAtMs' | 'revertedAtMs' | 'targetPct' | 'attemptBaselinePct'>,
  liveReservePct: number | null,
): boolean {
  return (
    state.applyAttemptedAtMs != null && state.appliedAtMs == null && state.revertedAtMs == null &&
    state.targetPct != null && state.attemptBaselinePct != null &&
    liveReservePct === state.targetPct &&
    state.targetPct !== state.attemptBaselinePct &&
    Number.isInteger(state.attemptBaselinePct) &&
    state.attemptBaselinePct >= RESERVE_WRITE_MIN_PCT &&
    state.attemptBaselinePct <= RESERVE_WRITE_MAX_PCT
  );
}

/** The value a partly granted write now reads, when the panel moved within what the night asked
 *  for (isOwnReserveValue's band) to a whole value other than the adopted target; else null. PURE. */
export function ceilingMovedPct(s: OwnReserveFields, liveReservePct: number | null): number | null {
  if (s.requestedPct == null || s.targetPct == null || liveReservePct == null || !Number.isInteger(liveReservePct)) return null;
  if (liveReservePct === s.targetPct || liveReservePct === s.priorReservePct) return null;
  return isOwnReserveValue(s, liveReservePct) ? liveReservePct : null;
}

/** A reading that could be someone else's reserve: an in-envelope whole number that is not one of
 *  our own values (isOwnReserveValue: the target, the value we restore, and on a partly granted
 *  write what we asked for). A null, fractional or out-of-envelope reading never is (a reconnect 0
 *  is not a setting), and nothing is while the value we restore is not itself a valid reserve —
 *  without it, ours and theirs cannot be told apart. PURE. */
export function isForeignReserveReading(s: OwnReserveFields, liveReservePct: number | null): boolean {
  const inEnvelope = (v: number | null): v is number =>
    v != null && Number.isInteger(v) && v >= RESERVE_WRITE_MIN_PCT && v <= RESERVE_WRITE_MAX_PCT;
  return inEnvelope(liveReservePct) && inEnvelope(s.priorReservePct) && s.targetPct != null
    && !isOwnReserveValue(s, liveReservePct);
}

/**
 * THE FOREIGN RULE, one reading at a time. PURE. A reserve someone else set during the night
 * (the EcoFlow app, Storm Guard) is theirs, and restoring our prior over it would undo their
 * change at the window close. One reading proves nothing: a foreign value must read the same on
 * two readings at least FOREIGN_RESERVE_SETTLE_MS apart.
 *  - a foreign reading (isForeignReserveReading): the first sighting of that value is recorded
 *    (foreignSeen; a different value restarts it); the same value FOREIGN_RESERVE_SETTLE_MS or
 *    more after it settles (foreignSettled);
 *  - one of our own values (isOwnReserveValue) with a sighting pending: cleared;
 *  - a null or out-of-envelope reading: nothing — absence is not evidence either way.
 * null = nothing to record.
 */
export function foreignStep(
  s: OwnReserveFields & Pick<NightActuationState, 'foreignReservePct' | 'foreignSeenAtMs'>,
  liveReservePct: number | null,
  nowMs: number,
): Extract<ActuationAction, { kind: 'foreignSeen' | 'foreignCleared' | 'foreignSettled' }> | null {
  if (isForeignReserveReading(s, liveReservePct)) {
    const pct = liveReservePct!;
    if (s.foreignReservePct === pct && s.foreignSeenAtMs != null) {
      return nowMs - s.foreignSeenAtMs >= FOREIGN_RESERVE_SETTLE_MS ? { kind: 'foreignSettled', pct } : null;
    }
    return { kind: 'foreignSeen', pct };
  }
  if (s.foreignSeenAtMs != null && liveReservePct != null && isOwnReserveValue(s, liveReservePct)) {
    return { kind: 'foreignCleared' };
  }
  return null;
}

/**
 * A write of ours may still hold the reserve. PURE. One was applied — unless proven never to have
 * taken effect (applyUnlandedAtMs) and not verified since — or attempted and never confirmed either
 * way, and not proven never to have landed (attemptUnlandedAtMs); its restore has not read back,
 * and the reserve has not settled as someone else's.
 */
export function revertOutstanding(
  s: Pick<NightActuationState, 'targetPct' | 'appliedAtMs' | 'applyAttemptedAtMs' | 'revertedAtMs'
    | 'revertVerifiedAtMs' | 'foreignSettledAtMs'>
    & Partial<Pick<NightActuationState, 'attemptUnlandedAtMs' | 'applyUnlandedAtMs' | 'applyVerifiedAtMs'>>,
): boolean {
  if (s.targetPct == null || s.revertVerifiedAtMs != null || s.foreignSettledAtMs != null) return false;
  if (s.appliedAtMs != null) return s.applyUnlandedAtMs == null || s.applyVerifiedAtMs != null;
  return s.applyAttemptedAtMs != null && s.revertedAtMs == null && s.attemptUnlandedAtMs == null;
}

/** When an unconfirmed restore pages: min(window close + REVERT_DEADLINE_AFTER_WINDOW_MS, on-peak
 *  start − ON_PEAK_PAGE_LEAD_MS); either alone when the other is unknown; null with neither. PURE. */
export function revertDeadlineMs(s: Pick<NightActuationState, 'windowEndMs' | 'nextOnPeakStartMs'>): number | null {
  const afterClose = s.windowEndMs != null ? s.windowEndMs + REVERT_DEADLINE_AFTER_WINDOW_MS : null;
  const beforePeak = s.nextOnPeakStartMs != null && Number.isFinite(s.nextOnPeakStartMs)
    ? s.nextOnPeakStartMs - ON_PEAK_PAGE_LEAD_MS : null;
  if (afterClose == null) return beforePeak;
  return beforePeak == null ? afterClose : Math.min(afterClose, beforePeak);
}

/** A revertDeadline stage not decided within this long of its moment is dropped: three hours, the
 *  length of the R-EV on-peak period (16:00–19:00) the on-peak stage guards. Past it the cycle the
 *  page belongs to is over (the deadline stage of a record with no on-peak stamp gets the same
 *  span; with a stamp, it lasts until the on-peak stage takes over). */
export const REVERT_PAGE_STAGE_SPAN_MS = 3 * 60 * 60_000;

export type RevertDeadlineStage = 'deadline' | 'onPeak';

export type RevertDeadlineDecision =
  | { kind: 'none' }
  /** `stage`: the deadline (revertDeadlineMs), or the on-peak start itself. `unknown`: no reserve
   *  setting read (nothing, or a reading that is not one: isReserveSetting) — the words say the
   *  restore could not be CONFIRMED, never that it reads raised. */
  | { kind: 'page'; stage: RevertDeadlineStage; unknown: boolean;
    /** The reading, when it is the raise at a value other than the target (readsOwnRaise: a partly
     *  granted night's panel moved within what it asked for, not yet adopted): what the words say
     *  the reserve still reads. Absent when the reading is the target, or unknown. */
    readsPct?: number }
  /** The stage's moment came with the panel reading `pct`, a reserve setting that is not the raise
   *  (readsOwnRaise): the stage is decided, with no page (stamp revertDeadlinePassedAtMs / …OnPeakPassedAtMs). */
  | { kind: 'pass'; stage: RevertDeadlineStage; pct: number }
  /** The deadline stage came before the restore had its chance (restoreAwaitingFirstChance): it is
   *  left undecided this tick (stamp revertDeadlineHeldAtMs on the first). */
  | { kind: 'hold'; stage: 'deadline' };

/** The longest the deadline stage waits for a restore that had not had its chance when the stage
 *  fell due (from revertDeadlineHeldAtMs): ten minutes — one reserve-write cooldown (5 min:
 *  ecoflow/commands NIGHT_RESERVE_COOLDOWN_MS) for its send, and its readback grace
 *  (REVERT_VERIFY_AFTER_MS). */
export const REVERT_DEADLINE_HOLD_MAX_MS = 2 * REVERT_VERIFY_AFTER_MS;

/**
 * The restore has not yet had its chance at the deadline stage. PURE. A process down across the
 * deadline comes back with the restore never sent: decideActuation sends it on the tick the
 * deadline stage is decided, and the page went out first, saying the restore had failed. True,
 * from the first tick that waits (revertDeadlineHeldAtMs) for less than REVERT_DEADLINE_HOLD_MAX_MS,
 * while an applied write's restore has not read back and either
 *  - it is due and was never attempted (neither accepted nor rejected), its prior is a valid
 *    reserve and the panel is in the device list: decideActuation sends it this tick; or
 *  - it was accepted less than REVERT_VERIFY_AFTER_MS ago: it is inside its readback grace;
 * or while an attempted write whose confirmation was lost reads its target, with the panel listed
 * (attemptAdoptable): decideActuation adopts it this tick and sends its restore on the next — a
 * crash inside the write call, down past the deadline, paged "could not restore … still reads 50
 * percent" before any restore had been sent.
 * The deadline stage's span lasts until the on-peak start, so it pages on a later tick when the
 * restore is rejected, does not read back, or the panel leaves the device list. A restore sent at
 * the window close is half an hour past its grace at the deadline: a night that goes to plan, and
 * a stuck restore, are decided as before.
 *
 * v1.189.0 (review) — and while an accepted restore has no reading (no reserve setting) and this
 * process has read none since it started (`readSinceBoot` false): a process down from just after
 * the 05:00 ACK to past the deadline comes back with the restore's readback grace spent and its
 * first readback not yet fresh, and paged "could not be confirmed" a tick before the restore read
 * back. The wait is for one reading, at most REVERT_DEADLINE_HOLD_MAX_MS: a readback that stays dark
 * is paged then, and the on-peak stage never waits.
 */
export function restoreAwaitingFirstChance(
  s: NightActuationState,
  nowMs: number,
  panelListed: boolean,
  /** The live reading, for an attempt whose confirmation was lost (attemptAdoptable); omitted: none. */
  liveReservePct: number | null = null,
  /** This process has read a reserve setting since it started; omitted: it has (nothing waits on it). */
  readSinceBoot = true,
): boolean {
  if (s.revertVerifiedAtMs != null) return false;
  if (s.revertDeadlineHeldAtMs != null && nowMs - s.revertDeadlineHeldAtMs >= REVERT_DEADLINE_HOLD_MAX_MS) return false;
  if (s.appliedAtMs == null) return panelListed && attemptAdoptable(s, liveReservePct);
  if (s.revertedAtMs != null) return nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS || (!readSinceBoot && !isReserveSetting(liveReservePct));
  const dueAt = revertDueMs(s);
  const due = s.cancelled || (dueAt != null && nowMs >= dueAt);
  return panelListed && due && s.revertAttempts === 0 && isReserveSetting(s.priorReservePct);
}

/**
 * The revertDeadline stage whose moment has come and that is still undecided, or null. PURE.
 *  - the on-peak stage: from the stamped on-peak start, for REVERT_PAGE_STAGE_SPAN_MS;
 *  - the deadline stage: from revertDeadlineMs until the on-peak start (which then stands for it:
 *    a process down through both is paged once, at the on-peak stage), or for
 *    REVERT_PAGE_STAGE_SPAN_MS on a record with no on-peak stamp.
 * A stage paged or passed is decided.
 */
export function revertDeadlineStageDue(s: NightActuationState, nowMs: number): RevertDeadlineStage | null {
  const p = s.nextOnPeakStartMs != null && Number.isFinite(s.nextOnPeakStartMs) ? s.nextOnPeakStartMs : null;
  if (p != null && nowMs >= p) {
    const open = s.revertDeadlineOnPeakPagedAtMs == null && s.revertDeadlineOnPeakPassedAtMs == null;
    return open && nowMs < p + REVERT_PAGE_STAGE_SPAN_MS ? 'onPeak' : null;
  }
  const d = revertDeadlineMs(s);
  if (d == null || nowMs < d) return null;
  const open = s.revertDeadlinePagedAtMs == null && s.revertDeadlinePassedAtMs == null;
  return open && nowMs < (p ?? d + REVERT_PAGE_STAGE_SPAN_MS) ? 'deadline' : null;
}

/**
 * revertDeadline — the wall-clock page for a restore that has not read back. PURE.
 *
 * Every other revert escalation needs evidence: three cloud-rejected writes, or a live reading
 * of the raised target after the re-issues. A panel whose readback goes dark at the close gave
 * neither, and the reserve could stand raised into the on-peak period with nothing said. This
 * needs only the clock: an audible critical (and a critical push) at revertDeadlineMs and at the
 * on-peak start, while a write of ours may still hold the reserve (revertOutstanding) and the live
 * reading is the raise (readsOwnRaise) or unknown.
 * Each stage is decided ONCE, at its moment (revertDeadlineStageDue): the first tick at or after
 * it pages on the raise (readsOwnRaise: our target, or a partly granted night's other value inside
 * what it asked for) or no reserve setting (nothing, or a reading that is not a setting: a
 * reconnect 0 — isReserveSetting), and passes on any other setting — the restore itself (it reads
 * back on this tick), the attempt-time baseline of a write that never landed, or a value someone
 * else set. A stage passed is never paged later, so a stale reading hours after its moment pages
 * nothing; nor is a stage whose moment is more than its span past. The deadline stage waits, a
 * bounded while, for a restore that has not had its chance (restoreAwaitingFirstChance). Broadcast
 * quiet hours apply as to every critical announce; the push always goes.
 */
export function decideRevertDeadline(
  s: NightActuationState,
  nowMs: number,
  liveReservePct: number | null,
  /** The panel is in the device list (what restoreAwaitingFirstChance needs to know the restore is
   *  sent this tick); false, the default, never waits. */
  panelListed = false,
  /** This process has read a reserve setting since it started (restoreAwaitingFirstChance); true,
   *  the default, never waits for one. */
  readSinceBoot = true,
): RevertDeadlineDecision {
  if (s.day == null || !revertOutstanding(s)) return { kind: 'none' };
  const stage = revertDeadlineStageDue(s, nowMs);
  if (stage == null) return { kind: 'none' };
  // Only a reserve setting decides a stage without a page: a reconnect 0, a fraction or a value
  // outside the envelope is no evidence of the reserve (as for the foreign rule), so it counts
  // as no reading.
  const reading = isReserveSetting(liveReservePct) ? liveReservePct : null;
  if (reading != null && !readsOwnRaise(s, reading)) return { kind: 'pass', stage, pct: reading };
  if (stage === 'deadline' && restoreAwaitingFirstChance(s, nowMs, panelListed, reading, readSinceBoot)) return { kind: 'hold', stage };
  if (reading != null && reading !== s.targetPct) return { kind: 'page', stage, unknown: false, readsPct: reading };
  return { kind: 'page', stage, unknown: reading == null };
}

/**
 * Whether a restore of ours will still be sent, for what a revertDeadline page says of it. PURE.
 *  - an applied write whose restore the cloud has not accepted: decideActuation sends it on every
 *    tick from its due moment while its prior is a valid reserve;
 *  - an accepted restore whose readback re-issues are not spent (REVERT_MAX_RETRIES), with the
 *    panel reading the raise (readsOwnRaise: retryRevert re-issues only then, a partly granted
 *    night's other value once decideActuation has adopted it);
 *  - an attempt never confirmed that the panel reads at our target (it is adopted, then restored).
 * Never with the panel missing from the device list (nothing is sent to it), nor once the restore
 * read back or the reserve settled as someone else's. A stuck restore whose re-issues are spent,
 * or one the panel cannot be read for, is not re-sent: the page must not say it is.
 */
export function revertRetryPending(s: NightActuationState, liveReservePct: number | null, panelListed: boolean): boolean {
  if (!panelListed || s.revertVerifiedAtMs != null || s.foreignSettledAtMs != null) return false;
  if (s.appliedAtMs != null && s.revertedAtMs == null) {
    const p = s.priorReservePct;
    return p != null && Number.isInteger(p) && p >= RESERVE_WRITE_MIN_PCT && p <= RESERVE_WRITE_MAX_PCT;
  }
  const readsTarget = liveReservePct != null && liveReservePct === s.targetPct;
  if (s.appliedAtMs != null) {
    return readsOwnRaise(s, liveReservePct) && s.targetPct !== s.priorReservePct && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES;
  }
  return s.applyAttemptedAtMs != null && s.revertedAtMs == null && readsTarget;
}

/** What a restore of ours that is not being sent waits on, when one will be sent once the panel
 *  reports its reserve again (revertResendOnReport). */
export type RevertResendOnReport = 'listed' | 'raise';

/**
 * v1.189.0 (review) — a restore of ours that is NOT being sent (revertRetryPending is false) and
 * will be once the panel reports its reserve again, for what a revertDeadline page says of it.
 * PURE. Only with no reserve setting read (nothing, or a reading that is not one: isReserveSetting)
 * — a dark readback, or a panel missing from the device list; a known reading is the page's own
 * words, and revertRetryPending says what follows it.
 *  - 'listed': an applied write whose restore the cloud has not accepted, its prior a valid reserve,
 *    with the panel missing from the device list: decideActuation sends it on the first tick the
 *    panel is listed again, whatever it reads then;
 *  - 'raise': an accepted restore whose readback re-issues are not spent (retryRevert re-issues it on
 *    a reading of our target), or an attempt never confirmed (adopted on a reading of its target,
 *    then restored): sent only if the panel reads the raise once it reports.
 * null otherwise: one is being sent (revertRetryPending), the reading is known, the restore read
 * back or the reserve settled as someone else's, or none will be sent. The page said "not
 * re-sending" for a dark readback, and then the add-on re-sent the restore on the first readback of
 * the raise.
 */
export function revertResendOnReport(s: NightActuationState, liveReservePct: number | null, panelListed: boolean): RevertResendOnReport | null {
  if (s.revertVerifiedAtMs != null || s.foreignSettledAtMs != null) return null;
  if (isReserveSetting(liveReservePct) || revertRetryPending(s, liveReservePct, panelListed)) return null;
  if (s.appliedAtMs != null && s.revertedAtMs == null) return isReserveSetting(s.priorReservePct) ? 'listed' : null;
  if (s.appliedAtMs != null) {
    return s.targetPct != null && s.priorReservePct != null && s.targetPct !== s.priorReservePct
      && !s.revertReadbackEscalated && s.revertRetries < REVERT_MAX_RETRIES ? 'raise' : null;
  }
  return s.applyAttemptedAtMs != null && s.revertedAtMs == null && s.attemptUnlandedAtMs == null
    && s.targetPct != null && isReserveSetting(s.attemptBaselinePct) && s.targetPct !== s.attemptBaselinePct ? 'raise' : null;
}

/** The value an outstanding write restores: the prior read before the write, else (an attempt
 *  never confirmed) the attempt-time baseline; null when neither is a valid reserve. PURE. */
export function restoreTargetPct(s: Pick<NightActuationState, 'priorReservePct' | 'attemptBaselinePct'>): number | null {
  const ok = (v: number | null): v is number =>
    v != null && Number.isInteger(v) && v >= RESERVE_WRITE_MIN_PCT && v <= RESERVE_WRITE_MAX_PCT;
  if (ok(s.priorReservePct)) return s.priorReservePct;
  return ok(s.attemptBaselinePct) ? s.attemptBaselinePct : null;
}

/** What a revertDeadline push (and its log line) says of the restore: retried only while one will
 *  still be sent (revertRetryPending); with none being sent, what it waits on when one will be once
 *  the panel reports again (revertResendOnReport: "the raised reserve" — on a partly granted night
 *  any value within what it asked for is the raise); otherwise that it is not re-sent. PURE. */
export function revertRetryText(retrying: boolean, onReport: RevertResendOnReport | null = null): string {
  if (retrying) return 'The add-on keeps retrying the restore.';
  if (onReport === 'listed') return 'The add-on sends the restore once the panel reports again.';
  if (onReport === 'raise') return 'The add-on sends the restore if the panel still reads the raised reserve once it reports again.';
  return 'The add-on is not re-sending the restore.';
}

/** What the summary of a restore says of it (restoreSummaryDue): read back ("restored to 16%"), or
 *  sent and acknowledged with no readback yet. */
export type RestoreSummaryKind = 'readBack' | 'acknowledged';
/** restoreSummaryDue's step: a summary to send, or 'hold' — owed, and waiting for this process's first
 *  reading of the reserve (v1.190.1, restoreSummaryAwaitsFirstReading; stamp restoreSummaryHeldAtMs
 *  on the first tick that waits). */
export type RestoreSummaryStep = RestoreSummaryKind | 'hold';

/**
 * v1.189.0 (review) — the summary of a restore is owed, and what it says. PURE. The morning summary
 * (and a mid-day leg's own) went on the restore's cloud ACK saying "reserve restored to 16%", and a
 * restore that then did not read back was paged critical half an hour later, both cards standing.
 *  - 'readBack': the restore read back (revertVerifiedAtMs) — "restored", what the panel reported;
 *  - 'acknowledged': its readback grace (REVERT_VERIFY_AFTER_MS from the ACK) ran with no readback —
 *    the restore was SENT and acknowledged, and the panel has not read it back;
 *  - null: no restore accepted yet, inside its grace with no readback, or the summary already went
 *    (restoreSummaryAtMs). Once per record. Nor while the live reading is the restored value: that
 *    is the readback, which decideActuation stamps on this same tick (revertVerified), and the
 *    summary goes then saying "restored";
 *  - 'hold' (v1.190.1): owed, and waiting for this process's first reading of the reserve
 *    (restoreSummaryAwaitsFirstReading) — told `readSinceBoot`; a call that does not tell it
 *    (the readback tick) never holds.
 */
type RestoreSummaryRecord = Pick<NightActuationState, 'day' | 'revertedAtMs' | 'revertVerifiedAtMs' | 'restoreSummaryAtMs' | 'priorReservePct' | 'restoreSummaryHeldAtMs'>;
export function restoreSummaryDue(s: RestoreSummaryRecord, nowMs: number, liveReservePct?: number | null): RestoreSummaryKind | null;
export function restoreSummaryDue(s: RestoreSummaryRecord, nowMs: number, liveReservePct: number | null, readSinceBoot: boolean): RestoreSummaryStep | null;
export function restoreSummaryDue(
  s: RestoreSummaryRecord,
  nowMs: number,
  /** The live reading this tick (null: none); omitted, none. */
  liveReservePct: number | null = null,
  /** This process has read a reserve setting since it started (the tick's nightReserveReadSinceBoot);
   *  omitted: it has (nothing waits on it — the readback tick). */
  readSinceBoot = true,
): RestoreSummaryStep | null {
  if (s.day == null || s.revertedAtMs == null || s.restoreSummaryAtMs != null) return null;
  if (s.revertVerifiedAtMs != null) return 'readBack';
  if (liveReservePct != null && liveReservePct === s.priorReservePct) return null;
  if (restoreSummaryAwaitsFirstReading(s, nowMs, liveReservePct, readSinceBoot)) return 'hold';
  return nowMs - s.revertedAtMs >= REVERT_VERIFY_AFTER_MS ? 'acknowledged' : null;
}

/**
 * v1.190.1 — the owed summary waits for this process's first reading of the reserve. PURE. A process
 * down across the restore's readback grace came back with the summary owed and no reading yet, sent
 * "the restore was sent and has not read back" on its first tick, and the readback a tick or two
 * later added a "restored" card after it. True while the grace is spent, this process has read no
 * reserve setting since it started and this tick reads none, for less than REVERT_DEADLINE_HOLD_MAX_MS
 * from the first tick that waits (restoreSummaryHeldAtMs) — the bound the deadline stage's own
 * restart wait has (restoreAwaitingFirstChance). A reading of the raise ends it (the summary says
 * "sent"); a reading of the restore is the readback (restoreSummaryDue returns null, and the summary
 * goes on the revertVerified tick saying "restored"); none, and the summary goes at the bound.
 */
export function restoreSummaryAwaitsFirstReading(
  s: Pick<NightActuationState, 'revertedAtMs' | 'restoreSummaryHeldAtMs'>,
  nowMs: number,
  liveReservePct: number | null,
  readSinceBoot: boolean,
): boolean {
  if (s.revertedAtMs == null || nowMs - s.revertedAtMs < REVERT_VERIFY_AFTER_MS) return false;
  if (readSinceBoot || isReserveSetting(liveReservePct)) return false;
  return s.restoreSummaryHeldAtMs == null || nowMs - s.restoreSummaryHeldAtMs < REVERT_DEADLINE_HOLD_MAX_MS;
}

/**
 * v1.190.1 — how the restore stands, for the revertDeadline hold line (index.ts): not yet sent; sent
 * before this process started (an ACK that predates a restart: the hold then waits for the first
 * reading, not for a restore "only just" sent); or only just sent, by this process. PURE.
 */
export function restoreSentWords(revertedAtMs: number | null, bootMs: number): string {
  if (revertedAtMs == null) return 'not yet sent';
  if (revertedAtMs < bootMs) return 'sent before the add-on last started';
  return 'only just sent';
}

/**
 * The spoken revertDeadline page, English and Spanish. PURE. `onPeakClock` is the on-peak start
 * as a clock ("4:00 PM"), null when the night has no stamp; `onPeakDay` names its day when that is
 * not the page's own date (chargeText.onPeakDayWords: "on Monday" — a Friday window's page
 * at 12:30 AM Saturday is about Monday's on-peak). With no live reading it says the restore could
 * not be confirmed; with our target still read back it says the reserve still reads it. A restore
 * value that is not known is "its usual level".
 */
export function revertDeadlineSpoken(o: {
  stage: 'deadline' | 'onPeak';
  unknown: boolean;
  /** Our target — what the reserve still reads when the reading is known. */
  targetPct: number;
  restorePct: number | null;
  onPeakClock: string | null;
  /** The on-peak start's day, at the deadline stage, when it is not the page's day; absent or
   *  null: the same day (the bare clock). */
  onPeakDay?: { en: string; es: string } | null;
}): { en: string; es: string } {
  const r = o.restorePct;
  const toEn = r != null ? `${r} percent` : 'its usual level';
  const insteadEs = r != null ? `en lugar del ${r} por ciento` : 'en lugar de su nivel habitual';
  const toEs = r != null ? `al ${r} por ciento` : 'a su nivel habitual';
  const t = o.targetPct;
  const day = o.onPeakDay ?? null;
  const peakEn = o.onPeakClock != null ? `, and on-peak pricing starts ${day != null ? `${day.en} ` : ''}at ${o.onPeakClock}` : '';
  const peakEs = o.onPeakClock != null ? `, y la tarifa punta comienza ${day != null ? `${day.es} ` : ''}a las ${o.onPeakClock}` : '';
  if (o.stage === 'onPeak') {
    return o.unknown
      ? {
        en: `Critical. On-peak pricing has started and the night charge system still cannot confirm that the backup reserve was restored to ${toEn}. `
          + `Check the backup reserve in the EcoFlow app and set it to ${toEn}.`,
        es: 'Alarma crítica. Alarma crítica. La tarifa punta ya comenzó y el sistema de carga nocturna sigue sin poder confirmar '
          + `que la reserva de respaldo se restableció ${toEs}. Revise la reserva de respaldo en la aplicación EcoFlow y ajústela ${toEs}.`,
      }
      : {
        en: `Critical. On-peak pricing has started and the backup reserve still reads ${t} percent instead of ${toEn}. `
          + `The house is buying grid power at the peak rate to hold it. Set the backup reserve to ${toEn} in the EcoFlow app.`,
        es: `Alarma crítica. Alarma crítica. La tarifa punta ya comenzó y la reserva de respaldo sigue en el ${t} por ciento ${insteadEs}. `
          + `La casa está comprando energía de la red a la tarifa punta para mantenerla. Ajuste la reserva de respaldo ${toEs} en la aplicación EcoFlow.`,
      };
  }
  if (o.unknown) {
    const full = {
      en: `Critical. The night charge system could not confirm that the backup reserve was restored to ${toEn}: `
        + `the panel is not reporting it${peakEn}. Check the backup reserve in the EcoFlow app and set it to ${toEn}.`,
      es: 'Alarma crítica. Alarma crítica. El sistema de carga nocturna no pudo confirmar que la reserva de respaldo se restableció '
        + `${toEs}: el panel no la está informando${peakEs}. Revise la reserva de respaldo en la aplicación EcoFlow y ajústela ${toEs}.`,
    };
    if (full.en.length + full.es.length <= MAX_SPOKEN_ADVISORY_CHARS) return full;
    // The on-peak day named (a Friday window's page): what to do, said compactly, keeps it within
    // the bound; the day, the reserve to set and the clock never drop.
    return {
      en: `Critical. The night charge system could not confirm that the backup reserve was restored to ${toEn}: `
        + `the panel is not reporting it${peakEn}. Set the backup reserve to ${toEn} in the EcoFlow app.`,
      es: 'Alarma crítica. Alarma crítica. El sistema de carga nocturna no pudo confirmar que la reserva de respaldo se restableció '
        + `${toEs}: el panel no la está informando${peakEs}. Ajuste la reserva de respaldo ${toEs} en la aplicación EcoFlow.`,
    };
  }
  return {
    en: `Critical. The night charge system could not restore the backup reserve. It still reads ${t} percent instead of ${toEn}${peakEn}. `
      + `Set the backup reserve to ${toEn} in the EcoFlow app.`,
    es: 'Alarma crítica. Alarma crítica. El sistema de carga nocturna no pudo restablecer la reserva de respaldo. '
      + `Sigue en el ${t} por ciento ${insteadEs}${peakEs}. Ajuste la reserva de respaldo ${toEs} en la aplicación EcoFlow.`,
  };
}

/**
 * heldByChargeWrite — the on-peak MONEY detectors (peakGridDraw.ts: the grid-to-battery draw and
 * the idle pool) stay quiet near the reserve, because near the OWNER's floor buying on-peak is
 * outage protection. A restore of ours that did not take leaves OUR target standing as the
 * panel's reserve, and against it those detectors read "near the reserve" and stay silent while
 * the panel refills to our value at the peak rate. While that holds they measure against the
 * prior floor instead. The runway and below-reserve alarms are untouched: they keep the live
 * value, the conservative side for safety.
 *
 * chargeWriteHold is the record's half (PURE): an applied write whose restore has not read back
 * and has not settled as someone else's, with a valid prior that differs from the target, the
 * moment its restore fell due (revertDueMs), and the moment the hold applies (heldFromMs: past the
 * restore's readback grace). moneyDetectorReservePct is the reading's half: from heldFromMs, with
 * the panel still reading the raise (readsOwnRaise: exactly our target, or a partly granted night's
 * other value inside what it asked for), the prior; otherwise the live value.
 *
 * THE READBACK GRACE. A restore that goes to plan is sent on the first actuator tick after it falls
 * due and the panel keeps reporting the raised value for ~20–60 s after the cloud ACK (the lag
 * isRevertSettling and the revert readback allow for). Held from the due moment itself, the hold
 * engaged on almost every armed night between 05:00 and the readback, and the alert monitor
 * logged "heldByChargeWrite — … past its restore" (then "cleared") about restores that were fine.
 * It applies only once the restore has had the same REVERT_VERIFY_AFTER_MS the revert readback
 * waits before its first re-issue (heldFromMs).
 */
export interface ChargeWriteHold {
  targetPct: number;
  priorPct: number;
  restoreDueMs: number;
  heldFromMs: number;
  /** On a night the panel granted only in part: what the night asked for, and the attempt-time
   *  baseline its band starts above (isOwnReserveValue). A reading inside the band is the raise too
   *  (readsOwnRaise), held as the target is. Absent on every other night. */
  requestedPct?: number;
  attemptBaselinePct?: number;
}

/**
 * When a stuck restore's hold applies. PURE. REVERT_VERIFY_AFTER_MS after the restore was sent
 * (`revertedAtMs`, the cloud ACK), or after it fell due when it was sent earlier (a cancel, a grid
 * loss) — and REVERT_VERIFY_AFTER_MS after the due moment while no restore has been accepted. An
 * ACK that arrives after that point does not move it: the restore had already failed for that
 * long, and the hold already applied must not lapse for a fresh grace.
 */
export function chargeWriteHeldFromMs(restoreDueMs: number, revertedAtMs: number | null): number {
  const fromDue = restoreDueMs + REVERT_VERIFY_AFTER_MS;
  if (revertedAtMs == null || revertedAtMs >= fromDue) return fromDue;
  return Math.max(restoreDueMs, revertedAtMs) + REVERT_VERIFY_AFTER_MS;
}

export function chargeWriteHold(s: NightActuationState): ChargeWriteHold | null {
  if (s.appliedAtMs == null || !revertOutstanding(s)) return null;
  const prior = s.priorReservePct;
  const target = s.targetPct;
  const due = revertDueMs(s);
  if (prior == null || !Number.isInteger(prior) || prior < RESERVE_WRITE_MIN_PCT || prior > RESERVE_WRITE_MAX_PCT) return null;
  if (target == null || target === prior || due == null) return null;
  const band = s.requestedPct == null ? {}
    : { requestedPct: s.requestedPct, ...(s.attemptBaselinePct != null ? { attemptBaselinePct: s.attemptBaselinePct } : {}) };
  return { targetPct: target, priorPct: prior, restoreDueMs: due, heldFromMs: chargeWriteHeldFromMs(due, s.revertedAtMs), ...band };
}

export function moneyDetectorReservePct(
  liveReservePct: number | null,
  hold: ChargeWriteHold | null,
  nowMs: number,
): { reservePct: number | null; heldByChargeWrite: boolean } {
  if (hold != null && liveReservePct != null && nowMs >= hold.heldFromMs && readsOwnRaise({
    targetPct: hold.targetPct, priorReservePct: hold.priorPct,
    requestedPct: hold.requestedPct ?? null, attemptBaselinePct: hold.attemptBaselinePct ?? null,
  }, liveReservePct)) {
    return { reservePct: hold.priorPct, heldByChargeWrite: true };
  }
  return { reservePct: liveReservePct, heldByChargeWrite: false };
}

/** Publisher (same set/get pattern as the owner floor): index.ts sets it on every actuation-state
 *  write, the alert monitor reads it. */
let chargeWriteHoldPub: ChargeWriteHold | null = null;
export function setChargeWriteHold(v: ChargeWriteHold | null): void { chargeWriteHoldPub = v; }
export function getChargeWriteHold(): ChargeWriteHold | null { return chargeWriteHoldPub; }
/** Test seam. */
export function resetChargeWriteHold(): void { chargeWriteHoldPub = null; }

/**
 * What /api/reserve-floor's refusal says about the active night's restore. PURE. While the night's
 * write holds the reserve, a floor set now would be overwritten by the restore, so the refusal names
 * when that is: on a cancelled night, on the next actuator tick; otherwise at revertDueMs (the window
 * close, or an hour before on-peak if that is sooner) — or, past it, that it was due then and has not
 * completed. `fmtWhen` renders an instant as the announcement does ("at 5:00 AM", "on Monday at
 * 12:00 AM"). `atMs` is the restore moment; null when only a cancel would restore.
 */
export function reserveRestoreNote(
  s: Pick<NightActuationState, 'priorReservePct' | 'cancelled' | 'windowEndMs' | 'nextOnPeakStartMs'>,
  nowMs: number,
  fmtWhen: (ms: number, nowMs: number) => string,
): { text: string; atMs: number | null } {
  const prior = s.priorReservePct != null ? `${s.priorReservePct}%` : 'the old floor';
  if (s.cancelled) return { text: `the night was cancelled and it restores ${prior} within a minute`, atMs: nowMs };
  const due = revertDueMs(s);
  if (due == null) return { text: `it restores ${prior} only when the night's write is cancelled`, atMs: null };
  const when = fmtWhen(due, nowMs);
  return due > nowMs
    ? { text: `it restores ${prior} ${when}, and would put that back over a floor set now`, atMs: due }
    : { text: `its restore to ${prior} was due ${when} and has not completed yet`, atMs: due };
}
