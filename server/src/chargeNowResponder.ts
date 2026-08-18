/**
 * chargeNowResponder.ts — v1.84.0. The Charge Now auto-off responder.
 *
 * The 2026-08-04 incident: "Charge Now" (the SHP2's per-channel force-charge)
 * left ON bought grid energy at the day's highest rate for hours, and the
 * operator's ask was "switch it now … and put code in to address that in the
 * future." v1.80.0 made the setting READABLE (the peak-grid-draw alert names
 * the culprit); this module closes the loop with a bounded, audited response.
 *
 * MODES (CHARGE_NOW_RESPONSE option; default 'advisory'):
 *  - 'off'        — the responder is inert.
 *  - 'advisory'   — one [Medium] push per episode naming the channel and how
 *                   to fix it (app, or flip this option to supervised).
 *  - 'supervised' — announce + audited `ch{n}ForceCharge = FORCE_CHARGE_OFF`
 *                   write + readback verification (the v1.79.0 lesson: a
 *                   cloud ACK is not an actuation), with one retry and an
 *                   honest failure push.
 *
 * SAFETY RAILS (each pinned by the committed harness):
 *  - Fires only on an ACTIVE peak-grid-draw verdict — which already encodes:
 *    grid present, genuinely on-peak, pool comfortably above reserve, and a
 *    10-minute dwell. The responder never re-derives those judgments.
 *  - STORM HOLD: while any storm-prep advisory is active, the responder stands
 *    down entirely — an operator pre-charging ahead of a storm, even on-peak,
 *    is exercising judgment this module must not override.
 *  - ONE response per episode (latched until the condition clears), and a hard
 *    daily cap of 2 — the responder can never fight a determined operator.
 *  - Turning force-charge OFF is the only write it can ever issue. It never
 *    writes ON, never touches any other setting.
 */

export type ChargeNowMode = 'off' | 'advisory' | 'supervised';

export function resolveChargeNowMode(raw: unknown): ChargeNowMode {
  return raw === 'supervised' || raw === 'off' ? raw : 'advisory'; // fail to advisory
}

export const CHARGE_NOW_DAILY_CAP = 2;
/** Readback: how long after a write before the device must show OFF. */
export const FORCE_OFF_VERIFY_AFTER_MS = 3 * 60_000;
export const FORCE_OFF_MAX_RETRIES = 1;

export interface ResponderState {
  day: string | null;          // Phoenix YYYY-MM-DD for the daily cap
  actionsToday: number;
  episodeLatched: boolean;     // one response per continuous episode
  stormHoldLogged: boolean;
  /** Supervised write awaiting device readback; null = none in flight. */
  pendingVerify: {
    slots: number[];
    writtenAtMs: number;
    retries: number;
  } | null;
}

export function freshResponderState(): ResponderState {
  return { day: null, actionsToday: 0, episodeLatched: false, stormHoldLogged: false, pendingVerify: null };
}

export interface ResponderInputs {
  mode: ChargeNowMode;
  /** The peak-grid-draw verdict's active flag (post-dwell, post-guards). */
  verdictActive: boolean;
  /** Slot-numbered force-charge states from the same observation; null = not reported. */
  slots: { slot: number; label: string; on: boolean }[] | null;
  stormPrepActive: boolean;
  nowMs: number;
  phoenixDay: string;
}

export type ResponderAction =
  | { kind: 'none' }
  | { kind: 'stormHold' }                                  // log once per episode
  | { kind: 'advise'; on: { slot: number; label: string }[] }
  | { kind: 'turnOff'; on: { slot: number; label: string }[] }
  | { kind: 'verified'; slots: number[] }                  // readback shows all OFF
  | { kind: 'retryWrite'; slots: number[] }                // still ON past the grace
  | { kind: 'verifyFailed'; slots: number[] };             // retries exhausted

/**
 * One evaluation tick. MUTATES `state`. Pure w.r.t. inputs — the driver
 * executes the returned action (push / announce / audited write) and nothing
 * else carries state.
 */
export function decideChargeNowResponse(state: ResponderState, i: ResponderInputs): ResponderAction {
  if (state.day !== i.phoenixDay) {
    state.day = i.phoenixDay;
    state.actionsToday = 0;
  }

  const onNow = (i.slots ?? []).filter((s) => s.on);

  // ── PENDING VERIFY (supervised write in flight) — checked first, and
  // independent of the verdict: the write happened; its outcome is owed even
  // if the draw already stopped (turning OFF is exactly what stops it). ──
  if (state.pendingVerify != null) {
    const pv = state.pendingVerify;
    if (i.slots != null && pv.slots.every((n) => !(i.slots!.find((s) => s.slot === n)?.on))) {
      state.pendingVerify = null;
      return { kind: 'verified', slots: pv.slots };
    }
    if (i.nowMs - pv.writtenAtMs >= FORCE_OFF_VERIFY_AFTER_MS) {
      const stillOn = pv.slots.filter((n) => i.slots?.find((s) => s.slot === n)?.on !== false);
      if (pv.retries < FORCE_OFF_MAX_RETRIES) {
        pv.retries += 1;
        pv.writtenAtMs = i.nowMs;
        return { kind: 'retryWrite', slots: stillOn };
      }
      state.pendingVerify = null;
      return { kind: 'verifyFailed', slots: stillOn };
    }
    return { kind: 'none' }; // readback grace still running
  }

  // ── EPISODE TRACKING. The latch releases only when the condition is gone —
  // verdict inactive, or force-charge no longer ON anywhere. ──
  if (!i.verdictActive || onNow.length === 0) {
    state.episodeLatched = false;
    state.stormHoldLogged = false;
    return { kind: 'none' };
  }
  if (state.episodeLatched) return { kind: 'none' };
  if (i.mode === 'off') return { kind: 'none' };

  // ── STORM HOLD — operator judgment outranks economics. ──
  if (i.stormPrepActive) {
    if (state.stormHoldLogged) return { kind: 'none' };
    state.stormHoldLogged = true;
    return { kind: 'stormHold' };
  }

  const named = onNow.map(({ slot, label }) => ({ slot, label }));
  if (i.mode === 'advisory') {
    state.episodeLatched = true;
    return { kind: 'advise', on: named };
  }

  // supervised
  if (state.actionsToday >= CHARGE_NOW_DAILY_CAP) {
    state.episodeLatched = true; // cap reached: fall back to naming it once
    return { kind: 'advise', on: named };
  }
  state.actionsToday += 1;
  state.episodeLatched = true;
  state.pendingVerify = { slots: named.map((s) => s.slot), writtenAtMs: i.nowMs, retries: 0 };
  return { kind: 'turnOff', on: named };
}
