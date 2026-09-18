/**
 * blindRemediation.ts — v1.166.0. REMEDIATE FIRST, ALARM ONLY IF IT FAILS.
 *
 * Owner decision (2026-09-17): "Sound the stale data alarm only after the retry has
 * been initiated and failed … I want it to alarm, however only after immediate
 * remediation has failed." That settles the open question from v1.154.0 about the
 * telemetry-blind alarm speaking at 4-5 minutes.
 *
 * THE INCIDENT THAT DECIDED IT (2026-09-17, during on-peak):
 *   16:27:48  the EcoFlow cloud replays a stale SHP2 shadow; message rate 34 -> 0/min
 *   16:31:48  telemetry-blind CRITICAL; spoken aloud at 16:32
 *   16:47:48  self-heal rebuilds the MQTT session — after its 20-minute dwell
 *   16:49:48  data moving again; the alarm resolves
 * The order was backwards: the alarm spoke at ~4 minutes and the remedy that fixed
 * it in two minutes did not start until 20. Weather and NWS fetches succeeded in the
 * same second the panel froze — the Pi was fine; the cloud session was wedged.
 *
 * WHAT. When the telemetry-blind alert first goes active, the integrator's
 * remediation (an MQTT session rebuild) fires IMMEDIATELY, and the alert is held
 * non-annunciating — no voice, no push; still on-screen and in /api/health — for at
 * most BLIND_REMEDIATION_VERIFY_MS. Telemetry back inside the window: the alert
 * clears having never sounded. Still blind when the window ends: the remediation
 * FAILED, the hold releases, and the alarm fires exactly as it always did.
 *
 * ★★★ SAFETY RAILS:
 *  - The hold has a hard DEADLINE (VERIFY window from the remediation). It cannot
 *    be extended, re-armed within an episode, or held by a remediation that never
 *    reports back — absence is not success.
 *  - NO remediation available (the rolling-24h heal budget is spent, or a heal ran
 *    under BLIND_REMEDIATION_MIN_GAP_MS ago — i.e. the last remedy did not hold)
 *    means there is nothing to wait for: the alarm fires IMMEDIATELY, as before.
 *  - One remediation per episode. A blind episode that persists is never re-held.
 *  - It gates ONLY the telemetry-blind alert. Every other alarm is untouched.
 *  - ★ THE COST, STATED PLAINLY: the hold does NOT look at the cause. A genuine blind
 *    condition an MQTT rebuild cannot fix (the internet down, a clock-skew auth failure,
 *    the panel offline) alarms up to the verify window LATER than before — about 10 min
 *    after the last good poll instead of about 5 (TELEMETRY_BLIND_STALE_MS 5 min + this
 *    5 min). That is inside the owner's rule ("only after immediate remediation has
 *    failed"), and it is also a debounce for a blip that clears in the window. Scoping
 *    the hold to rebuild-fixable causes is a possible refinement, not done here.
 *  - The all-clear SPEECH gate (broadcast.ts allClearSpeechBlocked) still counts the
 *    held alert: held is not cleared, so "All clear" is never spoken while blind.
 */

/** How long a remediation gets to restore telemetry before the alarm is released.
 *  On 2026-09-17 the rebuild restored a moving payload in ~2 min (the shadow latch
 *  needs two distinct readings to clear); 5 min is that with margin. */
export const BLIND_REMEDIATION_VERIFY_MS = 5 * 60_000;

export interface BlindRemediationState {
  /** When the current blind episode began; null = not blind. */
  episodeStartMs: number | null;
  /** When this episode's remediation fired; null = none was available. */
  remediatedAtMs: number | null;
}

export type BlindRemediationPhase = 'idle' | 'remediating' | 'failed' | 'unavailable';

export interface BlindRemediationDecision {
  phase: BlindRemediationPhase;
  /** Hold the alert non-annunciating this tick. */
  hold: boolean;
  /** Fire the remediation now (at most once per episode). */
  triggerHeal: boolean;
  next: BlindRemediationState;
}

export function freshBlindRemediationState(): BlindRemediationState {
  return { episodeStartMs: null, remediatedAtMs: null };
}

/** PURE. The per-tick decision. */
export function decideBlindRemediation(
  s: BlindRemediationState,
  nowMs: number,
  i: { blindActive: boolean; healAvailable: boolean },
): BlindRemediationDecision {
  if (!i.blindActive) {
    return { phase: 'idle', hold: false, triggerHeal: false, next: freshBlindRemediationState() };
  }
  if (s.episodeStartMs == null) {
    // A new episode: remediate first, if there is anything to remediate with.
    return i.healAvailable
      ? { phase: 'remediating', hold: true, triggerHeal: true, next: { episodeStartMs: nowMs, remediatedAtMs: nowMs } }
      : { phase: 'unavailable', hold: false, triggerHeal: false, next: { episodeStartMs: nowMs, remediatedAtMs: null } };
  }
  // An episode in progress: held only inside its one verify window.
  if (s.remediatedAtMs != null && nowMs - s.remediatedAtMs < BLIND_REMEDIATION_VERIFY_MS) {
    return { phase: 'remediating', hold: true, triggerHeal: false, next: s };
  }
  return { phase: s.remediatedAtMs != null ? 'failed' : 'unavailable', hold: false, triggerHeal: false, next: s };
}

/* ─── integration (module state + hooks, like messageRateFloorAlert's set/get) ─── */

export interface BlindRemediationHooks {
  /** True when a remediation may run now (budget + minimum gap). */
  canHeal: () => boolean;
  /** Run the remediation. Must not throw into the alert tick. */
  heal: (reason: string) => void;
}

let hooks: BlindRemediationHooks | null = null;
let state: BlindRemediationState = freshBlindRemediationState();
let lastPhase: BlindRemediationPhase = 'idle';

/** index.ts registers the remediation it owns (the MQTT session and the heal budget). */
export function setBlindRemediationHooks(h: BlindRemediationHooks | null): void {
  hooks = h;
}

/** Test seam. */
export function resetBlindRemediation(): void {
  state = freshBlindRemediationState();
  lastPhase = 'idle';
}

/**
 * Called by the alert engine in the same tick that builds the telemetry-blind alert,
 * so the hold can never lag the alert by a tick (a lag would let the first tick
 * speak). With no hooks registered there is no remediation, and the alarm is never
 * held — fail toward sounding.
 */
export function blindRemediationStep(
  nowMs: number,
  blindActive: boolean,
  log: (m: string) => void,
): { hold: boolean; phase: BlindRemediationPhase } {
  let healAvailable = false;
  try { healAvailable = hooks?.canHeal() === true; } catch { healAvailable = false; }
  const d = decideBlindRemediation(state, nowMs, { blindActive, healAvailable });
  if (d.triggerHeal && hooks) {
    try {
      hooks.heal('telemetry blind — remediating before alarming');
    } catch (e: any) {
      // The remedy could not even start: nothing to wait for. Sound now.
      log(`telemetry-blind: remediation failed to start (${e?.message ?? e}) — alarming now`);
      state = { episodeStartMs: d.next.episodeStartMs, remediatedAtMs: null };
      lastPhase = 'unavailable';
      return { hold: false, phase: 'unavailable' };
    }
  }
  if (d.phase !== lastPhase) {
    if (d.phase === 'remediating') {
      log(`telemetry-blind: remediating FIRST — rebuilding the EcoFlow MQTT session now; the alarm is held for up to ${Math.round(BLIND_REMEDIATION_VERIFY_MS / 60_000)} min and sounds only if telemetry does not return`);
    } else if (d.phase === 'failed') {
      log(`telemetry-blind: remediation did NOT restore telemetry within ${Math.round(BLIND_REMEDIATION_VERIFY_MS / 60_000)} min — releasing the alarm`);
    } else if (d.phase === 'unavailable') {
      log('telemetry-blind: no remediation available (heal budget spent, or the last heal was too recent to have held) — alarming now');
    } else if (d.phase === 'idle' && lastPhase === 'remediating') {
      log('telemetry-blind: telemetry RESTORED by the remediation — the alarm never sounded');
    }
  }
  state = d.next;
  lastPhase = d.phase;
  return { hold: d.hold, phase: d.phase };
}
