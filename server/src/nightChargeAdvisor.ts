/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeAdvisor.ts — the night-charge TOU-arbitrage planner (ADVISORY).
 *
 * v1.37.0 (night-charge arbitrage, increment 1). This is the PURE sizing brain
 * — `computeNightChargePlan(inputs)` — and its types. NOTHING consumes it yet:
 * the module holder, the `createNightChargeAdvisor` wrapper, the ~21:30 evening
 * job, the HA/notify/endpoint surfaces, the learning ledger, and the
 * write-readiness gate all land in later, separately-attributable releases
 * (design: docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §2–§5). Shipping the sizing
 * math alone — dependency-injected, zero I/O — keeps this increment provable
 * entirely by unit tests with ZERO live surface, exactly as tariff.ts shipped.
 *
 * WHY this exists (owner requirement): on a day a shortfall is anticipated, buy
 * the RIGHT amount of grid energy in the cheap overnight window (APS R-EV
 * 11pm–5am Mon–Fri) so the home (a) never imports at the 4–7pm peak and (b)
 * keeps an OUTAGE CUSHION above the reserve floor. Framed as much a RESILIENCE
 * feature as a cost feature. Posture is ADVISORY / NO-WRITE.
 *
 * ★★ SAFETY POSTURE (binding, from the life-safety design dimension):
 *  - This module is READ-ONLY and NEVER touches the floor / runway / SoC alarm
 *    spine. It reads the same `backupReserveSoc` the floor alarm defends; it
 *    never produces state those alarms depend on.
 *  - UNDER-BUY IS A SAFETY MISS, not a cost miss: the outage cushion is the
 *    owner's explicit resilience requirement, so a confident under-sized buy
 *    leaves the home at the floor with no cushion when an outage hits.
 *    Therefore sizing uses WORST-CASE inputs — P10 (low) PV and P90 (high)
 *    load, with committed-EV load placed as a worst-case block upstream.
 *  - EMIT NULL over a fabricated number: any incomplete / incoherent / thin /
 *    climatology-only basis yields a null plan (chargeTonight=false, no buy),
 *    never a best-effort small number the owner might trust as cushion.
 *  - CONTENDED CHARGE RATE (v1.60.0): the charger and the house share ONE grid
 *    input, so an overnight EV session takes its draw straight out of the buy.
 *    Modelling it can only LOWER the deliverable lift — the plan under-promises
 *    and flags the shortfall rather than announcing a target the window cannot
 *    reach. The planner NEVER commands the EVSE: it models contention, it does
 *    not fight it. Where no EVSE prediction covers the window the model falls
 *    back to the flat charge cap and SAYS the contention is unmodelled — a
 *    missing prediction is never rendered as a predicted zero.
 *  - The over-buy CEILING (don't clip next-morning PV) is sized with P90 (high)
 *    PV — the deliberate asymmetry: floor with P10 so we never under-buy, ceiling
 *    with P90 so we never over-buy into clipping. On a genuinely tight day where
 *    floor+cushion collides with morning-PV headroom, RESILIENCE FLOOR WINS,
 *    accept the clip, surface bindingCap='overBuy'.
 *
 * The DC-bus depletion recurrence matches computeRunway / getDayForecast /
 * the multi-day sim EXACTLY (analytics.ts:7973): each hour the pack changes by
 * `pvW − loadW / dischargeEff` (delivering `load` at the panel draws `load/η`
 * from the pack — the discharge conversion tax), clamped to [0, fullWh]. Using
 * the same recurrence keeps the advisor's trough consistent with the alarm's
 * runway projection.
 * ═════════════════════════════════════════════════════════════════════════ */

// The ONE definition of the reserve-write bound ([10,50], the device's own
// clamp). Imported rather than re-stated so the value published to the HA
// automation and the value the supervised path writes can never drift apart.
// (nightChargeActuator.ts imports nothing — no cycle.)
import { clampReserveTarget } from './nightChargeActuator.js';

const HOUR_MS = 3_600_000;

/** One hour of the CONSERVATIVE forecast the planner sizes against. PV is the
 *  P10 (pessimistic-low) band; load is the P90 (pessimistic-high) band with any
 *  committed-EV block already folded in upstream and de-duplicated against the
 *  base curve (design §2.3). Both in WATTS, ts hour-aligned. */
export interface NightChargeHour {
  ts: number;
  pvP10W: number;
  loadP90W: number;
  /** v1.60.0 — the EV/EVSE component ALREADY INCLUDED in this hour's loadP90W,
   *  watts. Used ONLY to attribute a charge-rate derate to EV charging (the
   *  derate itself is driven by the total load — see chargeRateKwAt).
   *
   *  ★ null / absent ⇒ NO EV PREDICTION COVERS THIS HOUR. That is NOT the same
   *  claim as `0` ("a prediction exists and says the car will not charge"), and
   *  the two must never collapse: a null hour makes the plan report
   *  evContention.basis='unavailable' (contention unmodelled, disclosed), while
   *  a 0 hour is a real predicted-zero the plan may rely on. */
  evP90W?: number | null;
}

export interface NightChargeInputs {
  /** Evaluation instant (~21:30). Drives the pre-window carry start. */
  nowMs: number;

  // ── Battery state (read from the SHP2 projection upstream) ──
  /** Usable pool capacity, kWh (backupFullCapWh/1000, ~92.16). */
  fullKwh: number;
  /** Current state-of-charge %, as the SHP2 reports it. */
  socNowPct: number;
  /** The reserve floor % the SHP2 defends and the floor alarm reads
   *  (backupReserveSoc). The SAME field, never a divergent copy. */
  reserveFloorPct: number;
  /** Outage cushion % ABOVE the floor (owner default 15; later learned). */
  cushionPct: number;
  /** SoC coherence check (% vs remainWh/fullCapWh) passed upstream (I11).
   *  false ⇒ null plan. */
  socCoherent: boolean;

  // ── Efficiency (verified constants, injected — never hard-coded here) ──
  /** Charge-leg efficiency = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.927. The pack
   *  gains legEff of grid energy diverted to the charger. */
  legEff: number;
  /** Discharge DC-bus efficiency = RUNWAY_DISCHARGE_EFFICIENCY ≈ 0.94. */
  dischargeEff: number;

  // ── Charge feasibility ──
  /** Real SHP2 grid-charge power ceiling, kW (chChargeWatt live 7.2 kW). The
   *  true hardware envelope is an OPEN datum; flagged in the design. */
  chargeCapKw: number;
  /** v1.60.0 — the SHARED grid-input envelope, kW: the total the service/SHP2
   *  input carries at once for house pass-through AND battery charging. The
   *  charger only ever gets what the house leaves, so this is what makes the
   *  charge rate contended (see chargeRateKwAt).
   *
   *  null / non-finite / ≤0 ⇒ NO envelope modelled: the charge rate falls back
   *  to the flat chargeCapKw (pre-v1.60.0 behaviour). Never silently "0". */
  gridInputCapKw: number | null;

  // ── The cheap charge window tonight (resolved upstream via tariff.rateAt) ──
  window: { startMs: number; endMs: number } | null;

  /** Hourly conservative forecast covering [nowMs, nextRecharge). MUST include
   *  the pre-window carry (now→windowStart), the window hours, and the
   *  post-window horizon (windowEnd→nextRecharge). Hour-aligned, ascending. */
  horizon: NightChargeHour[];

  /** P90 (high) next-morning PV surplus, kWh — the over-buy ceiling headroom so
   *  a too-full pack doesn't clip morning PV. null ⇒ ceiling not applied. */
  morningPvSurplusP90Kwh: number | null;

  // ── Basis quality (gates) ──
  confidenceTier: 'forecast' | 'mixed' | 'climatology';
  /** calScoredDays ≥ N_MIN AND band coverage ≥ 0.78 (nominal 80% band, matching the write gate's floor) AND forecast present. */
  basisComplete: boolean;

  /** Below this buy, treat the night as "hold" (no meaningful charge). kWh. */
  minBuyKwh: number;
}

export type BindingCap =
  | 'requirement' // buy met the resilience requirement exactly
  | 'chargePower' // capped below requirement by the hardware charge rate
  | 'evContention' // v1.60.0 — a MORE SPECIFIC chargePower: the charge rate that
  //                   bound the buy was itself cut by predicted EV charging
  //                   sharing the grid input during the window
  | 'poolHeadroom' // capped below requirement by pool capacity
  | 'overBuy' // requirement itself exceeds morning-PV headroom (clip accepted)
  | null;

/** Every non-null BindingCap, in the order the sizing math resolves them.
 *  Exported so the delivery surfaces can enumerate the vocabulary instead of
 *  hand-copying it. The `_bindingCapsExhaustive` line below turns "added a cap
 *  and forgot a surface" into a COMPILE error under `tsc --noEmit` (which covers
 *  src/ — server/test/ is deliberately outside tsconfig's `include`). */
export const BINDING_CAPS = ['requirement', 'chargePower', 'evContention', 'poolHeadroom', 'overBuy'] as const;
const _bindingCapsExhaustive: Exclude<NonNullable<BindingCap>, (typeof BINDING_CAPS)[number]> extends never
  ? true
  : never = true;
void _bindingCapsExhaustive;

/** v1.60.0 — how much of tonight's window the EV is expected to take out of the
 *  charger's share of the grid input, and whether that is a PREDICTION at all. */
export interface NightChargeEvContention {
  /** 'predicted'   — an EVSE prediction covers EVERY simulated window hour; the
   *                  numbers below are real (windowEvKwh may legitimately be 0).
   *  'unavailable' — no EVSE prediction covers the window (no history, EVSE
   *                  offline, cloud gap, or the window lies past the predictor's
   *                  24 h reach). Contention is NOT modelled and the plan says
   *                  so — it never presents the fallback as a predicted zero. */
  basis: 'predicted' | 'unavailable';
  /** Predicted EV energy inside the window, kWh. null iff basis==='unavailable'. */
  windowEvKwh: number | null;
  /** Peak predicted EV draw inside the window, kW. null iff unavailable. */
  peakEvKw: number | null;
  /** Lowest deliverable GRID-side charge power across the window hours, kW —
   *  what the packs are actually left with at the worst hour. null when no
   *  grid-input envelope is modelled. */
  minChargeRateKw: number | null;
  /** Pack-kWh of lift the window CANNOT deliver because the grid input is
   *  shared: (flat-chargeCapKw ceiling) − (per-hour contended ceiling). 0 when
   *  nothing contends; null when no envelope is modelled. Reported whatever the
   *  basis is — the derate is physics, not a prediction. */
  derateKwh: number | null;
}

export type NightChargeObjective =
  | 'resilience_cushion' // a buy is needed to hold floor+cushion through the carry
  | 'none'; // projected trough already ≥ floor+cushion, or basis incomplete

export interface NightChargePlan {
  generatedAt: number;
  /** false ⇒ every numeric field is null and chargeTonight is false. */
  basisComplete: boolean;
  objective: NightChargeObjective;
  /** The single owner-facing decision. NEVER null (defaults false). */
  chargeTonight: boolean;

  /** Grid energy to buy at the meter, kWh. null when basis incomplete. */
  buyKwh: number | null;
  /** PREDICTION: the pack SoC % the window is expected to actually REACH by its
   *  close, given every cap — including the v1.60.0 EV-contention derate. This
   *  is the number the ledger scores (a systematic gap between this and the
   *  measured arrival is what under-buy detection is made of).
   *
   *  ★★ NOT the write setpoint — see `setpointSocPct`. Do not merge them. */
  targetSocPct: number | null;
  /** SETPOINT: the pack SoC % that MEETS floor+cushion — what the supervised
   *  write asks the device for. Equals `targetSocPct` on any night nothing caps
   *  the buy; it is HIGHER exactly when a cap (contention, charge power, pool)
   *  means the requirement cannot be delivered.
   *
   *  ★★ WHY THE TWO DIFFER (v1.60.0 — the next reader WILL want to merge them):
   *  `backupReserveSoc` is not a promise, it is an instruction — the device
   *  charges as fast as physics allows and stops at the reserve. Writing the
   *  contention-DERATED arrival would cap the charge at a guess: if the
   *  predicted EV session never plugs in, the full rate was available all night
   *  and the device would still have stopped at the derated number — a
   *  model-induced under-buy on the resilience buy. Writing the REQUIREMENT can
   *  only help: real contention simply means the device never reaches it (and
   *  the normal auto-revert fires on schedule), no contention means we get the
   *  reserve we actually wanted. Still bounded by the actuator's [10,50]
   *  clampReserveTarget — the write envelope is unchanged. */
  setpointSocPct: number | null;
  /** Pack-kWh the buy must ADD at the trough to hold floor+cushion. */
  requiredExtraKwh: number | null;
  /** Why buyKwh is what it is (which cap bound). */
  bindingCap: BindingCap;
  /** true when charge-power / pool caps prevented reaching floor+cushion —
   *  the cushion is NOT fully met and residual risk remains (surfaced honestly). */
  cushionShortfall: boolean;

  /** v1.60.0 — EV-contention disclosure for tonight's window (see the type).
   *  null only on a null plan (no window was even resolved). */
  evContention: NightChargeEvContention | null;

  /** Simulated PLAN-trajectory minimum SoC % over [windowEnd, nextRecharge]
   *  WITH the buy applied — the number the learning ledger scores its
   *  floor-breach verdict on (design §3.3), not raw baseline telemetry. */
  minProjSocPct: number | null;
  minProjSocTsMs: number | null;
  /** The no-buy baseline trough (what WOULD happen without the recommendation). */
  baselineMinSocPct: number | null;

  /** v1.39.0 (§4 honesty): the plan-projected pack SoC % ENTERING the charge
   *  window (the carry from now to window open). Freezes into the ledger's
   *  soc_at_window_start_pct plan column. null when basis incomplete. */
  projSocAtWindowStartPct: number | null;
  /** v1.39.0 (§4 honesty): the projected minimum SoC % over [now, windowStart)
   *  — the span a tonight buy CANNOT protect. On weekend evenings the resolved
   *  window can be 24–50 h away, so this span covers whole nights; the plan
   *  must not silently exclude it from its safety claims. */
  preWindowMinSocPct: number | null;

  confidenceTier: NightChargeInputs['confidenceTier'];
  window: { startMs: number; endMs: number } | null;
  reserveFloorPct: number;
  cushionPct: number;
  rationale: string;
}

interface SimResult {
  /** Pack kWh at the end of the simulated span. */
  endPackKwh: number;
  /** Minimum pack kWh over the SCORED sub-window [scoreFromMs, end). */
  minPackKwh: number;
  minTsMs: number | null;
  /** Pack kWh at a specific instant (windowEnd), captured during the walk. */
  packAtMarkKwh: number;
}

/** Walk the DC-bus recurrence from startPackKwh across `hours`, tracking the
 *  minimum pack over [scoreFromMs, ∞) and the pack level AT `markMs`.
 *  Recurrence identical to analytics.ts:7973 (pv − load/η, clamp [0,full]). */
function simulate(
  startPackKwh: number,
  fullKwh: number,
  hours: NightChargeHour[],
  dischargeEff: number,
  scoreFromMs: number,
  markMs: number,
): SimResult {
  const fullWh = fullKwh * 1000;
  let packWh = Math.max(0, Math.min(fullWh, startPackKwh * 1000));
  let minPackWh = Infinity;
  let minTsMs: number | null = null;
  // Pack level at the mark instant: default to the start (if the mark precedes
  // the first hour) so a caller asking for windowEnd before any horizon hour
  // still gets a defined value.
  let packAtMarkWh = packWh;
  let markCaptured = false;

  for (const h of hours) {
    // Capture the mark level at the FIRST hour at/after markMs, BEFORE applying
    // that hour's flux — i.e. the pack level entering the mark hour.
    if (!markCaptured && h.ts >= markMs) {
      packAtMarkWh = packWh;
      markCaptured = true;
    }
    packWh = Math.max(0, Math.min(fullWh, packWh + (h.pvP10W - h.loadP90W / dischargeEff)));
    if (h.ts >= scoreFromMs && packWh < minPackWh) {
      minPackWh = packWh;
      minTsMs = h.ts;
    }
  }
  if (!markCaptured) packAtMarkWh = packWh; // mark is after all hours → end level

  return {
    endPackKwh: packWh / 1000,
    minPackKwh: minPackWh === Infinity ? packWh / 1000 : minPackWh / 1000,
    minTsMs,
    packAtMarkKwh: packAtMarkWh / 1000,
  };
}

/** A null / hold plan — every numeric field null, chargeTonight strictly false. */
function nullPlan(
  inputs: NightChargeInputs,
  basisComplete: boolean,
  rationale: string,
): NightChargePlan {
  return {
    generatedAt: inputs.nowMs,
    basisComplete,
    objective: 'none',
    chargeTonight: false,
    buyKwh: null,
    targetSocPct: null,
    setpointSocPct: null,
    requiredExtraKwh: null,
    bindingCap: null,
    cushionShortfall: false,
    // A null plan resolved no window to contend over — 'unavailable' with a
    // number would be a claim; null is the honest absence.
    evContention: null,
    minProjSocPct: null,
    minProjSocTsMs: null,
    baselineMinSocPct: null,
    projSocAtWindowStartPct: null,
    preWindowMinSocPct: null,
    confidenceTier: inputs.confidenceTier,
    window: inputs.window,
    reserveFloorPct: inputs.reserveFloorPct,
    cushionPct: inputs.cushionPct,
    rationale,
  };
}

/**
 * Pure night-charge sizing. Returns the ADVISORY recommendation for tonight.
 * No I/O, no clock reads, no globals — everything is injected so the accuracy
 * of the recommendation is provable by unit test.
 *
 * Objective is LEXICOGRAPHIC (design §2.1): (1) HARD resilience constraint — the
 * P10-PV/P90-load pool trajectory must stay ≥ floor+cushion from window-end to
 * the next recharge; (2) source that energy in the cheap window (arbitrage);
 * (3) CEILING so a too-full pack doesn't clip morning PV. Sizing sub-steps map
 * to design §2.2.
 */
export function computeNightChargePlan(inputs: NightChargeInputs): NightChargePlan {
  const {
    nowMs, fullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,
    legEff, dischargeEff, chargeCapKw, gridInputCapKw, window, horizon,
    morningPvSurplusP90Kwh, basisComplete, minBuyKwh,
  } = inputs;

  // ── Gates (fail-safe → null over a fabricated number) ──
  // I11 SoC coherence; I6 basis; I5 SHP2/state; and structural preconditions.
  if (!basisComplete) return nullPlan(inputs, false, 'No plan — forecast/telemetry basis incomplete; nothing will be charged.');
  if (!socCoherent) return nullPlan(inputs, false, 'No plan — SoC telemetry incoherent (% vs remaining/full mismatch).');
  if (inputs.confidenceTier === 'climatology') return nullPlan(inputs, false, 'No plan — horizon is climatology-only (no real forecast); will not size a buy on a guessed sky.');
  if (!window || !(window.endMs > window.startMs)) return nullPlan(inputs, false, 'No plan — no valid cheap charge window resolved for tonight.');
  if (!Number.isFinite(fullKwh) || fullKwh <= 0) return nullPlan(inputs, false, 'No plan — pool capacity unavailable.');
  if (!Number.isFinite(socNowPct)) return nullPlan(inputs, false, 'No plan — current SoC unavailable.');
  // v1.39.0 review fix: a non-finite floor/cushion made targetFloorKwh NaN,
  // every bisection comparison false, and the buy silently resolved to the FULL
  // pool headroom — a confident max-buy instead of the fail-closed null the
  // module's contract promises for degenerate inputs. Same class for the
  // efficiency/charge-cap knobs (all operator-config-sourced).
  if (!Number.isFinite(reserveFloorPct) || reserveFloorPct < 0 || !Number.isFinite(cushionPct) || cushionPct < 0)
    return nullPlan(inputs, false, 'No plan — reserve floor / outage cushion is not a finite non-negative number.');
  if (!Number.isFinite(legEff) || legEff <= 0 || !Number.isFinite(dischargeEff) || dischargeEff <= 0 || !Number.isFinite(chargeCapKw) || chargeCapKw < 0)
    return nullPlan(inputs, false, 'No plan — efficiency/charge-power configuration is not a finite number.');
  if (horizon.length === 0) return nullPlan(inputs, false, 'No plan — empty forecast horizon.');

  const fullWh = fullKwh * 1000;
  const reserveKwh = (fullKwh * reserveFloorPct) / 100;
  const cushionKwh = (fullKwh * cushionPct) / 100;
  const targetFloorKwh = reserveKwh + cushionKwh; // the line the trough must hold

  const socNowKwh = (fullKwh * socNowPct) / 100;
  const windowStart = window.startMs;
  const windowEnd = window.endMs;
  // v1.39.0 review fix (HIGH): the charge-power feasibility cap must credit only
  // the REMAINING window when the plan is computed mid-window — the 30-min
  // recompute tick runs around the clock, and resolveCheapWindow deliberately
  // walks back to the true window start for display honesty. Crediting the full
  // window length mid-window over-credits already-elapsed hours (up to ~6 h ×
  // chargeCapKw of nonexistent lift) and can present an undeliverable buy as
  // fully meeting the cushion — the exact unflagged-residual-risk class the
  // v1.37.0 re-sim fix exists to prevent.
  const effChargeStartMs = Math.max(windowStart, nowMs);
  const remainingWindowHours = Math.max(0, (windowEnd - effChargeStartMs) / HOUR_MS);

  // Window hours — the slice the with-buy walk simulates (grid bypass during
  // charging hours, normal drain otherwise; see packAtWindowEndWith). Trimmed
  // to ≥ the current hour so an untrimmed caller horizon cannot re-drain
  // already-elapsed window hours (mid-window honesty does not depend on the
  // upstream trim).
  const windowSimFloorMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const windowHrs = horizon.filter((h) => h.ts >= windowStart && h.ts >= windowSimFloorMs && h.ts < windowEnd);
  // The scored trajectory runs from window-end forward (the buy tops the pack at
  // 05:00; the pre-window trough is a TONIGHT concern the alarm owns, not
  // something a 23:00 buy can fix).
  const postHours = horizon.filter((h) => h.ts >= windowEnd);

  // ── §2.2 step 1: pack level ENTERING window-close, no buy (carry SoC_now
  // through the pre-window + window house load). ──
  // v1.39.0 2nd-pass: simulate from the FLOOR of the current hour, not nowMs —
  // filtering h.ts >= nowMs dropped the in-progress hour entirely, so every
  // 21:30 plan under-simulated ~30 min of drain (under-buy direction).
  // Including the full current hour over-counts by ≤ the elapsed fraction —
  // the conservative (over-buy) direction, consistent with buildInputs' trim.
  const simFromMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const preHorizon = horizon.filter((h) => h.ts >= simFromMs);
  const baseline = simulate(socNowKwh, fullKwh, preHorizon, dischargeEff, windowEnd, windowEnd);
  const packAtWindowEnd_noBuy = baseline.packAtMarkKwh;
  // v1.49.0 — pack level ENTERING the window (carry to window OPEN), the anchor
  // for the lift-aware window model below.
  const packAtWindowStartKwh = simulate(socNowKwh, fullKwh, preHorizon, dischargeEff, windowStart, windowStart).packAtMarkKwh;

  // v1.39.0 (§4 honesty): the PRE-WINDOW carry — pack path from now to the
  // window OPEN. A tonight buy cannot prevent a pre-window dip (the floor alarm
  // owns that span), but the plan must not silently exclude it from its safety
  // claims: on weekend evenings the resolved window can be 24–50 h away, so the
  // carry crosses whole nights the [windowEnd, …] scored trough never sees.
  // packAtMark here = pack ENTERING the window → the ledger's frozen
  // soc_at_window_start_pct plan column.
  // 2nd-pass: MID-WINDOW (nowMs ≥ windowStart) there IS no pre-window span —
  // fields stay null and no note is emitted. The pre-fix code collapsed them
  // to the CURRENT SoC and could emit a false "before the charge window opens"
  // statement about a window that was already open.
  const midWindow = nowMs >= windowStart;
  let projSocAtWindowStartPct: number | null = null;
  let preWindowMinSocPct: number | null = null;
  let preWindowNote = '';
  if (!midWindow) {
    const preWindow = simulate(
      socNowKwh, fullKwh,
      horizon.filter((h) => h.ts >= simFromMs && h.ts < windowStart),
      dischargeEff, 0, windowStart,
    );
    projSocAtWindowStartPct = round1((preWindow.packAtMarkKwh / fullKwh) * 100);
    preWindowMinSocPct = round1((preWindow.minPackKwh / fullKwh) * 100);
    if (preWindowMinSocPct < round1(reserveFloorPct + cushionPct)) {
      preWindowNote = ` NOTE: before the charge window opens (${fmtPhoenixDayHm(windowStart, nowMs)}) the pack is projected to dip to ~${preWindowMinSocPct}% — a dip tonight's buy cannot prevent; the floor alarm owns that span.`;
    }
  }

  // ★★ THE SIZING AUTHORITY (v1.37.0 review fix — two CONFIRMED criticals):
  // `trough(lift)` = the simulated PLAN-trajectory minimum pack over
  // [windowEnd, end] when the overnight buy raises the window-close pack by
  // `lift` kWh. Sizing is SOLVED against this clamp-exact re-simulation, NOT the
  // additive-offset `targetFloor − clampedBaselineTrough`, which the DC-bus
  // clamps break in BOTH safety-critical directions:
  //   (a) a mid-window PV surge that clamps the pack to FULL erases the lift, so
  //       an additive estimate reports "requirement met" while the trajectory
  //       still dips below floor+cushion (unflagged residual risk); and
  //   (b) a deep drain that clamps the baseline trough at 0 TRUNCATES the
  //       apparent deficit at targetFloor, so the additive requiredExtra
  //       under-sizes the buy on exactly the deep-shortfall night — an UNDER-BUY,
  //       the life-safety miss.
  // trough(lift) is monotone non-decreasing in `lift` (max(0,min(full,·))
  // preserves order), so a bisection is exact.
  // v1.49.0 — the with-buy WINDOW model. `chChargeWatt` is a CHARGE-ONLY cap
  // (the SHP2 CHARGE_TIME_TASK's grid→battery power); house load on a grid-tied
  // SHP2 is grid pass-through and NEVER competes with the charger — the prior
  // model subtracted window house load from the charge budget AND drained it
  // from the pack (double-count), under-sizing buys ~5× (empirically falsified
  // by the ledger: measured window imports sustain ~2× chargeCapKw). Charging
  // occupies the FIRST chargeHours(lift) of the remaining window; while the
  // charger runs, the home rides grid bypass (no pack drain); the rest of the
  // window drains normally. Per-hour clamps keep saturation/empty honest, and
  // pack(lift) is monotone non-decreasing in lift so the bisection stays exact.
  // ★★ v1.60.0 — EV CONTENTION. Measured 2026-08-02→03: the plan announced
  // 10% → 36% (~36 kWh buy); at 03:00 `panel_load` was 14.0 kW (EVSE ~11.5 kW +
  // ~2.5 kW baseline) and the packs were taking only ~2.8 kW (battery_net
  // −2,757 W) — arrival ~31–32%, not the promised 36%. The v1.49.0 model is
  // right that house load is grid PASS-THROUGH and does not DRAIN the pack while
  // the charger runs; it was wrong that the charger therefore always gets the
  // full chChargeWatt. Pass-through and charging draw on the SAME grid input, so
  // the charger only ever gets what the house leaves:
  //
  //     deliverable_kW(hour) = clamp(gridInputCap − houseLoad(hour), 0, chargeCap)
  //
  // With the measured 17 kW coexistence envelope and 14.0 kW of house load that
  // is 3.0 kW at the meter ⇒ 3.0 × legEff ≈ 2.8 kW into the packs — the number
  // actually observed. The house load used here is the P90 (high) curve WITH the
  // committed-EV block already folded in (§2.3), so the EVSE is exactly what
  // makes this bite: nothing else in this home approaches the envelope.
  //
  // Direction of the change is one-way SAFE: it can only LOWER the deliverable
  // lift, so the plan under-promises and flags cushionShortfall instead of
  // silently claiming a target the window cannot reach. It NEVER pauses,
  // throttles, or reschedules the EVSE — that circuit is not this add-on's to
  // command; the planner models the contention and reports it.
  const envelopeKw =
    gridInputCapKw != null && Number.isFinite(gridInputCapKw) && gridInputCapKw > 0 ? gridInputCapKw : null;
  /** Deliverable GRID-side charge power in one window hour, kW. With no
   *  envelope configured this is the flat cap — i.e. exactly pre-v1.60.0. */
  const chargeRateKwAt = (h: NightChargeHour): number => {
    if (envelopeKw == null) return chargeCapKw;
    return Math.max(0, Math.min(chargeCapKw, envelopeKw - Math.max(0, h.loadP90W) / 1000));
  };
  // Per-hour {rate, wall-clock availability}. availH carries the mid-window
  // partial hour the flat model used to fold into `chargeHours`.
  const windowRates: Array<{ hour: NightChargeHour; rateKw: number; availH: number }> = [];
  {
    let hoursLeft = remainingWindowHours;
    for (const h of windowHrs) {
      const availH = Math.max(0, Math.min(1, hoursLeft));
      hoursLeft -= 1;
      windowRates.push({ hour: h, rateKw: chargeRateKwAt(h), availH });
    }
  }

  // The deliverable-lift ceiling is now the SUM of the per-hour contended rates,
  // not a flat rate × hours — an hour the EV is sharing contributes only its
  // remainder. Credit is still bounded by BOTH the wall-clock remaining window
  // and the simulable window buckets (availH), so a horizon gap inside the
  // window can never bill grid energy the trajectory model cannot absorb.
  const chargePowerLiftKwh = Math.max(
    0,
    windowRates.reduce((acc, w) => acc + w.rateKw * legEff * w.availH, 0),
  );
  // The same ceiling WITHOUT contention (the pre-v1.60.0 figure). Used ONLY to
  // quantify the derate for the disclosure — never to size a buy.
  const chargePowerLiftUncontendedKwh = Math.max(0, chargeCapKw * Math.min(remainingWindowHours, windowHrs.length) * legEff);
  const contentionDerateKwh = Math.max(0, chargePowerLiftUncontendedKwh - chargePowerLiftKwh);

  // ── The EV-contention DISCLOSURE (honesty, not sizing) ──
  // basis='predicted' requires the EVSE predictor to cover EVERY simulated
  // window hour. One uncovered hour (a weekend window past the predictor's 24 h
  // reach, an EVSE cloud gap, a rollup-synthesized hour) means we do NOT know
  // what the car will do — and a missing evP90W must never be read as a
  // predicted 0 kW. The DERATE above still applies either way (it is driven by
  // total load, which is physics); only the ATTRIBUTION needs a prediction.
  const evCovered =
    windowRates.length > 0 &&
    windowRates.every((w) => w.hour.evP90W != null && Number.isFinite(w.hour.evP90W as number));
  const evWindowKwh = evCovered
    ? windowRates.reduce((acc, w) => acc + (Math.max(0, w.hour.evP90W as number) / 1000) * w.availH, 0)
    : null;
  const evPeakKw = evCovered
    ? windowRates.reduce((m, w) => Math.max(m, w.availH > 0 ? Math.max(0, w.hour.evP90W as number) / 1000 : 0), 0)
    : null;
  const evContention: NightChargeEvContention = {
    basis: evCovered ? 'predicted' : 'unavailable',
    windowEvKwh: evWindowKwh == null ? null : round2(evWindowKwh),
    peakEvKw: evPeakKw == null ? null : round1(evPeakKw),
    minChargeRateKw:
      envelopeKw == null || windowRates.length === 0
        ? null
        : round1(windowRates.reduce((m, w) => (w.availH > 0 ? Math.min(m, w.rateKw) : m), chargeCapKw)),
    derateKwh: envelopeKw == null ? null : round2(contentionDerateKwh),
  };
  // The EV is nameable as the cause only when a prediction covers the window AND
  // that prediction is non-zero AND the derate is material. A derate with no
  // covering prediction is real and still sizes the buy — it is attributed to
  // 'chargePower' and disclosed as UNMODELLED contention, never as a prediction.
  const evAttributable = evCovered && (evWindowKwh ?? 0) > 0 && contentionDerateKwh > 1e-6;

  // Charging still occupies the EARLIEST hours of the remaining window (that is
  // what the device does once the reserve setpoint is raised) — but each hour
  // now delivers only its OWN contended rate, so a lift that needs 2 h of a free
  // window may need 5 h of a window the car is sharing. With a flat rate this
  // reduces EXACTLY to the v1.49.0 "first chargeHours at chargeCapKw" walk.
  const packAtWindowEndWith = (lift: number): number => {
    if (lift <= 0 || chargeCapKw <= 0) return packAtWindowEnd_noBuy;
    let pack = packAtWindowStartKwh;
    let remainingLift = lift;
    for (const { hour: h, rateKw, availH } of windowRates) {
      // Pack-kWh a FULL hour of charging would add here (0 when the house has
      // taken the whole envelope — that hour simply cannot charge).
      const hourLiftKwh = rateKw * legEff;
      const chargeFrac = hourLiftKwh > 0
        ? Math.max(0, Math.min(availH, remainingLift / hourLiftKwh))
        : 0;
      const gainKwh = hourLiftKwh * chargeFrac;
      remainingLift = Math.max(0, remainingLift - gainKwh);
      const pvKwh = h.pvP10W / 1000;
      const drainKwh = ((h.loadP90W / 1000) * (1 - chargeFrac)) / dischargeEff;
      pack = Math.max(0, Math.min(fullKwh, pack + pvKwh + gainKwh - drainKwh));
    }
    return pack;
  };
  const troughAtLift = (lift: number): { minKwh: number; minTs: number | null } => {
    const r = simulate(packAtWindowEndWith(lift), fullKwh, postHours, dischargeEff, windowEnd, windowEnd);
    return { minKwh: r.minPackKwh, minTs: r.minTsMs };
  };

  const baselineTrough = troughAtLift(0);
  const baselineMinSocPct = round1((baselineTrough.minKwh / fullKwh) * 100);

  // No shortfall projected → HOLD (no buy). Honest "you don't need to charge".
  if (baselineTrough.minKwh >= targetFloorKwh - 1e-9) {
    return {
      ...nullPlan(inputs, true, `Hold — projected overnight trough (${baselineMinSocPct}%) stays at/above the ${round1(reserveFloorPct + cushionPct)}% floor+cushion; no charge needed.${preWindowNote}`),
      objective: 'none',
      buyKwh: 0,
      requiredExtraKwh: 0,
      targetSocPct: round1((packAtWindowEnd_noBuy / fullKwh) * 100),
      // A hold night asks for nothing: the trough already holds the line, no
      // write arms, and setpoint == prediction (there is no gap to disclose).
      setpointSocPct: round1((packAtWindowEnd_noBuy / fullKwh) * 100),
      minProjSocPct: baselineMinSocPct,
      minProjSocTsMs: baselineTrough.minTs,
      baselineMinSocPct,
      projSocAtWindowStartPct,
      preWindowMinSocPct,
      // Nothing was bought, but the contention basis is still a fact about
      // tonight's window and the owner-facing surfaces may show it.
      evContention,
    };
  }

  // Feasibility bounds on the lift.
  // Charge-power: the per-hour contended ceiling computed above (v1.60.0).
  // Pool headroom: the pack physically cannot hold more than full.
  const poolHeadroomLiftKwh = Math.max(0, fullKwh - packAtWindowEnd_noBuy);

  // §2.2 step 3 — minimal lift that makes the re-simulated trough reach
  // floor+cushion, searched over the ACHIEVABLE-model plateau bound (v1.49.0
  // review fix): under the bypass model, pack(L) keeps rising past the old
  // fullKwh − noBuy bound — a larger L extends the charging (bypass) hours even
  // after the full clamp bites — and only plateaus once chargeHours pins at the
  // remaining window (L = chargePowerLiftKwh). Searching the stale bound
  // UNDER-BOUGHT deliverable cushions and mis-reported them as unmeetable (the
  // life-safety miss). The per-hour [0, fullKwh] clamps inside
  // packAtWindowEndWith keep any over-wide domain honest; pack(L) is monotone,
  // so the bisection stays exact.
  const hiLift = Math.max(chargePowerLiftKwh, poolHeadroomLiftKwh);
  const meetable = troughAtLift(hiLift).minKwh >= targetFloorKwh - 1e-9;
  let requiredExtraKwh: number;
  if (!meetable) {
    // Even max effort can't hold the line — report the legacy full-pack proxy;
    // cushionShortfall (from the re-simulated trough below) tells the truth.
    requiredExtraKwh = poolHeadroomLiftKwh;
  } else {
    let lo = 0;
    let hi = hiLift;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (troughAtLift(mid).minKwh >= targetFloorKwh) hi = mid;
      else lo = mid;
    }
    requiredExtraKwh = hi;
  }

  // The ACTUALLY achievable lift = requirement bounded by charge power.
  const liftKwh = Math.min(requiredExtraKwh, chargePowerLiftKwh);
  let bindingCap: BindingCap = 'requirement';
  if (!meetable) {
    bindingCap = poolHeadroomLiftKwh <= chargePowerLiftKwh ? 'poolHeadroom' : 'chargePower';
  } else if (chargePowerLiftKwh < requiredExtraKwh - 1e-6) {
    bindingCap = 'chargePower';
  }

  // ★ cushionShortfall is driven by the re-simulated trough under the lift we can
  // actually deliver — so NEITHER a full-clamp erasing the lift NOR a
  // below-empty deficit can present as "requirement met" (fixes both criticals).
  const withBuy = troughAtLift(liftKwh);
  const minProjKwh = withBuy.minKwh;
  const minProjSocPct = round1((minProjKwh / fullKwh) * 100);
  const cushionShortfall = minProjKwh < targetFloorKwh - 1e-6;
  if (cushionShortfall && bindingCap === 'requirement') {
    // A clamp (saturation / below-empty), not a linear cap, is the limiter;
    // attribute to the tighter physical bound so the flag is never 'requirement'.
    bindingCap = poolHeadroomLiftKwh <= chargePowerLiftKwh ? 'poolHeadroom' : 'chargePower';
  }
  // v1.60.0 — refine the charge-rate cap to its actual cause. 'evContention' is
  // a MORE SPECIFIC 'chargePower', not a parallel vocabulary: the rate that
  // bound the buy was itself cut by the car sharing the grid input. It is
  // claimed ONLY when a prediction covers the window (evAttributable), so a
  // missing EVSE prediction can never masquerade as a modelled one.
  if (bindingCap === 'chargePower' && evAttributable) bindingCap = 'evContention';

  const targetPackKwh = packAtWindowEndWith(liftKwh);

  // Over-buy ceiling (flag only; resilience wins): the required buy pushes the
  // pack above full − P90 morning surplus, so morning PV will clip. Keep the
  // buy; flag the accepted clip — but only when the cushion IS met (otherwise
  // the shortfall flag already dominates).
  if (
    morningPvSurplusP90Kwh != null &&
    !cushionShortfall &&
    targetPackKwh > fullKwh - morningPvSurplusP90Kwh + 1e-6
  ) {
    bindingCap = 'overBuy';
  }

  const buyKwh = liftKwh / legEff; // meter sees more than the pack stores
  const targetSocPct = round1((targetPackKwh / fullKwh) * 100);
  const chargeTonight = buyKwh >= minBuyKwh;

  // ── v1.60.0 — THE WRITE SETPOINT (see NightChargePlan.setpointSocPct) ──
  // The pack level at window close whose post-window trough holds floor+cushion
  // — derived from the REQUIREMENT, deliberately NOT from the deliverable
  // `liftKwh`. Deriving it from the lift would hand the device the
  // contention-derated arrival as an instruction and cap the charge there even
  // on a night the car never plugs in (the model-induced under-buy this field
  // exists to prevent).
  //
  // Stated on the trough itself rather than through a window walk: this is a
  // property of the POST-window trajectory alone, so it cannot inherit the
  // charge model's caps (a lift-based expression plateaus at the deliverable
  // ceiling and silently collapses back into targetSocPct). trough(P) is
  // monotone non-decreasing in P — the sim's [0, full] clamps preserve order —
  // so the bisection is exact.
  const troughFromPack = (p: number): number =>
    simulate(p, fullKwh, postHours, dischargeEff, windowEnd, windowEnd).minPackKwh;
  let requiredPackAtWindowEndKwh: number;
  if (troughFromPack(fullKwh) < targetFloorKwh - 1e-9) {
    requiredPackAtWindowEndKwh = fullKwh; // even a full pack cannot hold the line — ask for all of it
  } else {
    let lo = 0;
    let hi = fullKwh;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (troughFromPack(mid) >= targetFloorKwh) hi = mid;
      else lo = mid;
    }
    requiredPackAtWindowEndKwh = hi;
  }
  // The setpoint can never sit BELOW the arrival we already predict — that
  // would be strictly worse than the pre-v1.60.0 write and would cap a charge
  // the window can demonstrably deliver. (Only bisection tolerance can put them
  // out of order; the guard makes the ordering structural.)
  const setpointSocPct = Math.max(
    targetSocPct,
    round1((requiredPackAtWindowEndKwh / fullKwh) * 100),
  );

  // v1.60.0 — name the contention. Two MUTUALLY EXCLUSIVE shapes, and neither
  // may claim a prediction the planner does not have: either the EVSE forecast
  // covered the window and we quantify it, or it did not and we say the
  // contention is unmodelled (a warning, never a reassuring "no EV expected").
  const evNote = evAttributable
    ? ` NOTE: EV charging is predicted inside the window (~${evContention.windowEvKwh} kWh, peak ~${evContention.peakEvKw} kW); it shares the grid input, leaving ~${evContention.minChargeRateKw} kW for the packs and cutting ~${round1(contentionDerateKwh)} kWh off the deliverable buy.`
    : evContention.basis === 'unavailable' && (cushionShortfall || bindingCap === 'chargePower')
      ? ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges overnight the packs will receive less than planned.'
      : '';

  // v1.60.0 — when the ask and the expectation diverge, say BOTH. Naming only
  // the setpoint would over-promise; naming only the expectation would hide
  // what the device is actually being told to do. Identical numbers ⇒ silence,
  // rather than a distinction that does not exist tonight.
  const setpointNote = setpointSocPct > targetSocPct + 0.05
    ? ` The reserve is set to ${setpointSocPct}% (the resilience requirement) but the window is only expected to reach ~${targetSocPct}%.`
    : '';

  const rationale = chargeTonight
    ? `Buy ~${round1(buyKwh)} kWh overnight → target ${targetSocPct}% by ${fmtLocalHint(windowEnd)}.${setpointNote} Without it the P10-PV/P90-load trough falls to ~${baselineMinSocPct}% (floor+cushion is ${round1(reserveFloorPct + cushionPct)}%).${cushionShortfall ? ' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.' : ''}${bindingCap === 'overBuy' ? ' NOTE: buy exceeds morning-PV headroom; a small clip is accepted to hold resilience.' : ''}${evNote}${preWindowNote}`
    // The deliverable buy can be pushed under the minimum-buy threshold BY the
    // contention itself, so this branch must carry the shortfall disclosure too
    // — otherwise a night the window physically cannot serve would read as a
    // tidy "nothing worth buying".
    : `Hold — the projected shortfall (${round1(buyKwh)} kWh) is below the ${round1(minBuyKwh)} kWh minimum-buy threshold; no meaningful charge.${cushionShortfall ? ' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.' : ''}${evNote}${preWindowNote}`;

  return {
    generatedAt: nowMs,
    basisComplete: true,
    objective: chargeTonight ? 'resilience_cushion' : 'none',
    chargeTonight,
    buyKwh: round2(buyKwh),
    targetSocPct,
    setpointSocPct,
    requiredExtraKwh: round2(requiredExtraKwh),
    bindingCap,
    cushionShortfall,
    evContention,
    minProjSocPct,
    minProjSocTsMs: withBuy.minTs,
    baselineMinSocPct,
    projSocAtWindowStartPct,
    preWindowMinSocPct,
    confidenceTier: inputs.confidenceTier,
    window,
    reserveFloorPct,
    cushionPct,
    rationale,
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
/** Hour-of-day hint for the rationale string (no TZ math — display only; the
 *  window bounds are already resolved in Phoenix upstream). */
function fmtLocalHint(_ms: number): string { return 'the window close'; }

/* ═══════════════════════════════════════════════════════════════════════════
 * WS1 — advisor plumbing (module holder, state fields, input assembly, scoring,
 * and the createNightChargeAdvisor wrapper). Everything below is ADDITIVE to the
 * pure sizing brain above; it never touches computeNightChargePlan.
 *
 * Design: docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §2 (one planner, scored ==
 * actuated), §3.1 (score columns), §4.1 (12 h staleness state fields). Posture
 * stays READ-ONLY / NO-WRITE: nothing here produces state the floor/runway/SoC
 * alarm spine depends on, and every surface emits NULL over a fabricated number.
 * ═════════════════════════════════════════════════════════════════════════ */

// --- Module holder (latest plan) for the API + MQTT + notify surfaces ---------
// Mirrors loadShedAdvisor's getLatestAdvisory/setLatestAdvisory holder.
let latestPlan: NightChargePlan | null = null;
export function getLatestNightChargePlan(): NightChargePlan | null {
  return latestPlan;
}
export function setLatestNightChargePlan(p: NightChargePlan): void {
  latestPlan = p;
}

/** 12 h staleness guard (design §4.1 / I12). Past this, a plan is not fresh —
 *  its numeric fields read null and charge_tonight reverts to false so a dead or
 *  wedged advisor (the Pi power-cycles daily) can never leave a stale ON. The HA
 *  layer additionally sets expire_after so the retained topic goes UNAVAILABLE. */
const PLAN_STALENESS_MS = 43_200_000; // 12 h

/** Format a UTC instant as "HH:MM" in America/Phoenix (design: America/Phoenix
 *  via Intl, never the host clock; Phoenix has no DST but the resolver does not
 *  rely on that). */
function fmtPhoenixHm(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const hh = get('hour') || '00';
  const mm = get('minute') || '00';
  return `${hh}:${mm}`;
}

/** v1.39.0 (§4 display honesty): "HH:MM" for instants within the next 24 h,
 *  "EEE HH:MM" (e.g. "Mon 00:00") beyond — a Saturday-evening plan resolving
 *  Monday's window must not present it as tonight's. Exported for the
 *  delivery surfaces (MQTT state / TUI / notify) so they agree. */
export function fmtPhoenixDayHm(ms: number, nowMs: number): string {
  const hm = fmtPhoenixHm(ms);
  if (ms - nowMs < 24 * HOUR_MS) return hm;
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short' })
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'weekday')?.value ?? '';
  return wd ? `${wd} ${hm}` : hm;
}

/**
 * Flat fields published into the MQTT state payload + /api/ha-state so the
 * owner's HA automation can gate on the recommendation (advisory actuation
 * model). 12 h staleness guard (design §4.1): numeric fields are null unless the
 * plan is fresh AND its basis is complete; charge_tonight is STRICTLY false
 * unless fresh && plan.chargeTonight (never null-as-true). window_start/_end are
 * "HH:MM" America/Phoenix from plan.window, null when there is no window.
 */
export function nightChargeStateFields(
  plan: NightChargePlan | null,
  nowMs: number = Date.now(),
): {
  night_charge_target_soc_percent: number | null;
  night_charge_expected_soc_percent: number | null;
  night_charge_buy_kwh: number | null;
  night_charge_window_start: string | null;
  night_charge_window_end: string | null;
  charge_tonight: boolean;
} {
  const fresh = !!plan && plan.basisComplete && nowMs - plan.generatedAt < PLAN_STALENESS_MS;
  const win = plan?.window ?? null;
  return {
    // v1.60.0 — this entity is consumed as a WRITE VALUE: the advisory-mode HA
    // automation sets backupReserveSoc from it. So it carries the SETPOINT (the
    // requirement), not the contention-derated prediction — publishing the
    // prediction here would leave the advisory path capping its own charge at a
    // guess, the same defect the supervised path is being fixed for. It is
    // passed through the actuator's own [10,50] bound so the automation is
    // never handed a value the device cannot accept; the bound itself is
    // unchanged, and it is the single definition (imported, not re-stated).
    night_charge_target_soc_percent:
      fresh && plan!.setpointSocPct != null ? clampReserveTarget(plan!.setpointSocPct) : null,
    // …and the PREDICTION gets its own entity, so "what will the pack actually
    // reach tonight" stays visible instead of being overwritten by the ask.
    night_charge_expected_soc_percent: fresh ? plan!.targetSocPct : null,
    night_charge_buy_kwh: fresh ? plan!.buyKwh : null,
    // Window is informational (the automation gates on availability+charge_tonight
    // AND honors this window). Surfaced from plan.window whenever present; null on
    // no window / null plan. HA expire_after (§I12) covers the dead-advisor case.
    // v1.39.0: day-qualified beyond 24 h ("Mon 00:00") — a weekend plan resolving
    // Monday's window must not present a date-less HH:MM as tonight's window.
    night_charge_window_start: win ? fmtPhoenixDayHm(win.startMs, nowMs) : null,
    night_charge_window_end: win ? fmtPhoenixDayHm(win.endMs, nowMs) : null,
    charge_tonight: fresh ? plan!.chargeTonight === true : false,
  };
}

// --- buildNightChargeInputs: assemble worst-case inputs from injected pieces ---
// Design §2.3 (conservative worst-case: P10 PV, P90 load, committed-EV block,
// EV de-dup) + §2.4 (multi-day horizon, daily P10/P90 widened by √daysAhead) +
// §1 (cheap-window resolution via a tariff period resolver). Everything is
// INJECTED — no analytics/tariff import — so the assembly is unit-provable.

/** One hour of the injected within-horizon probabilistic band. `loadP90W` is the
 *  P90 (high) load; when the base curve embeds historical EV, `embeddedEvW` is
 *  the historical-EV watts to subtract so the explicit committed-EV block is not
 *  double-counted (§2.3). Beyond the band, hours are synthesized from rollups. */
export interface NightForecastHour {
  ts: number;
  pvP10W: number;
  loadP90W: number;
  /** Historical EV watts embedded in loadP90W to de-dup (default 0 = EV-clean). */
  embeddedEvW?: number;
}

/** A future day's hourly trajectory (multi-day sim rollup), used beyond the 24 h
 *  band. `daysAhead` (1,2,3…) widens the daily P10/P90 by √daysAhead (§2.4). */
export interface NightDayRollup {
  daysAhead: number;
  hours: { ts: number; pvW: number; loadW: number }[];
}

/** The committed-EV worst case: place `p90SessionKwh` (NOT the prob-weighted
 *  expected value — §2.3) as a block starting at the predicted charge hour. */
export interface NightEvCommit {
  p90SessionKwh: number | null;
  chargeStartMs: number | null;
  sessionCount: number;
}

export interface NightChargeInputDeps {
  nowMs: number;

  // Battery state (from the SHP2 projection upstream).
  fullKwh: number;
  socNowPct: number;
  reserveFloorPct: number;
  cushionPct: number;
  socCoherent: boolean;

  // Verified efficiency constants + charge feasibility (INJECTED, never hard-coded).
  legEff: number; // √DISPATCH_ROUND_TRIP_EFFICIENCY
  dischargeEff: number; // RUNWAY_DISCHARGE_EFFICIENCY
  chargeCapKw: number;
  /** v1.60.0 — shared grid-input envelope, kW (see NightChargeInputs). null ⇒
   *  contention not modelled; passed through untouched. */
  gridInputCapKw: number | null;

  // Cheap-window resolution: a tariff period resolver (rateAt(...).periodId) and
  // the id of the OVERNIGHT (23:00–05:00) cheap period. No tariff import here.
  periodIdAt: (tsMs: number) => string;
  cheapPeriodId: string;
  windowScanHours?: number;

  // Forecast basis.
  bandHours: NightForecastHour[]; // within-24 h probabilistic band (authoritative)
  dayRollups: NightDayRollup[]; // beyond day-0, for the weekend/multi-day carry
  realizedDailyErrHalfFrac: number; // widens synthesized daily P10/P90
  /** Horizon end (next reliable recharge). null ⇒ end after the last hour. */
  nextRechargeMs: number | null;

  // Committed-EV worst case + clamp.
  ev: NightEvCommit | null;
  evMaxLoadW: number; // EV_MAX_LOAD_W = 11520

  // Basis-quality gates (→ basisComplete).
  confidenceTier: 'forecast' | 'mixed' | 'climatology';
  forecastPresent: boolean;
  calScoredDays: number;
  minCalScoredDays: number; // N_MIN
  bandCoverageFrac: number;

  morningPvSurplusP90Kwh: number | null;
  minBuyKwh: number;
}

/**
 * Resolve tonight's cheap charge window by scanning a period resolver forward
 * for the next contiguous run of `cheapPeriodId` (the OVERNIGHT tier, §1). Hour-
 * aligned bounds. Returns null if no cheap hour is found within `scanHours`.
 * PURE — the resolver (rateAt-backed) is injected, resolved in Phoenix upstream.
 */
export function resolveCheapWindow(
  periodIdAt: (tsMs: number) => string,
  fromMs: number,
  cheapPeriodId: string,
  scanHours = 30,
): { startMs: number; endMs: number } | null {
  const h0 = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  // v1.39.0 review fix: the END of a found run is scanned up to 24 h past the
  // run's own start — a window START must lie within scanHours, but a run
  // straddling the scan edge must not have its end truncated to the horizon
  // (a Saturday-evening scan found Monday 00:00 at hour 27 of a 30 h scan and
  // clipped the window end to Monday 04:00 instead of 05:00).
  const endOfRun = (runStartMs: number): number => {
    for (let i = 1; i <= 24; i++) {
      const t = runStartMs + i * HOUR_MS;
      if (periodIdAt(t) !== cheapPeriodId) return t;
    }
    return runStartMs + 25 * HOUR_MS; // pathological always-cheap resolver — bounded
  };
  // If `fromMs` is ALREADY inside a cheap window (a recompute running during the
  // 23:00–05:00 window), walk BACK to the window's true start so the reported
  // window_start isn't truncated to the live mid-window clock (§4 display honesty).
  if (periodIdAt(h0) === cheapPeriodId) {
    let s = h0;
    for (let i = 1; i <= scanHours; i++) {
      const t = h0 - i * HOUR_MS;
      if (periodIdAt(t) === cheapPeriodId) s = t;
      else break;
    }
    return { startMs: s, endMs: endOfRun(h0) };
  }
  for (let i = 0; i <= scanHours; i++) {
    const t = h0 + i * HOUR_MS;
    if (periodIdAt(t) === cheapPeriodId) return { startMs: t, endMs: endOfRun(t) };
  }
  return null;
}

/**
 * Assemble a NightChargeInputs from injected forecast pieces. PURE. The
 * conservative-worst-case rules (§2.3) live here so they are provable:
 *  - PV = P10 (band within 24 h; synthesized daily P10 = rollup PV × (1 −
 *    errHalfFrac·√daysAhead) beyond 24 h).
 *  - Load = P90 base with the historical-EV component DE-DUPLICATED out, then the
 *    committed p90SessionKwh EV block placed from the predicted charge hour,
 *    clamped per-hour at evMaxLoadW (EV_MAX_LOAD_W).
 *  - v1.60.0: each BAND hour also carries `evP90W` — how much of that hour's
 *    load is the car — so the sizer can attribute a contended charge rate. Hours
 *    with no covering EV prediction (no ev report at all; rollup-synthesized
 *    hours beyond the band) leave it UNDEFINED, never 0.
 *  - Window from the injected tariff period resolver (OVERNIGHT tier).
 *  - basisComplete = forecast present AND not climatology AND calScoredDays ≥
 *    N_MIN AND band coverage ≥ 0.78 (write-gate floor); a false here forces a null plan downstream.
 */
export function buildNightChargeInputs(deps: NightChargeInputDeps): NightChargeInputs {
  const {
    nowMs, fullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,
    legEff, dischargeEff, chargeCapKw, gridInputCapKw,
    periodIdAt, cheapPeriodId, windowScanHours = 30,
    bandHours, dayRollups, realizedDailyErrHalfFrac, nextRechargeMs,
    ev, evMaxLoadW,
    confidenceTier, forecastPresent, calScoredDays, minCalScoredDays, bandCoverageFrac,
    morningPvSurplusP90Kwh, minBuyKwh,
  } = deps;

  const window = resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, windowScanHours);

  // ★ EV de-dup MUST be atomic with the re-add (§2.3): only STRIP the embedded
  // expected-value EV from the base load when we will actually place the
  // committed p90 EV block in its stead. If the committed block will NOT be
  // placed (no EV report / no valid p90 session / no charge-start), KEEP the
  // embedded expected-value EV in the load — stripping it without replacing it
  // would erase a real charging night from the sizing basis and UNDER-buy (a
  // safety miss). Never strip without replacing.
  // 2nd-pass guard: a degenerate evMaxLoadW (≤0 / NaN) would make every
  // placement hour add 0 W while still stripping its embedded EV — the exact
  // strip-without-replace mass under-buy. Treat it as "cannot place".
  const evBlockWillPlace = !!(
    ev && ev.p90SessionKwh != null && ev.p90SessionKwh > 0 && ev.chargeStartMs != null &&
    Number.isFinite(evMaxLoadW) && evMaxLoadW > 0
  );

  // Merge band (authoritative) with beyond-24 h synthesized rollup hours, keyed
  // by ts so the band always wins where both cover an hour.
  // v1.39.0 review fix: the embedded EV is NOT stripped here — the strip happens
  // hour-by-hour inside the block placement below, so ONLY the hours the
  // committed p90 block actually covers are de-duped. Stripping every band hour
  // up front erased OTHER predicted sessions (e.g. tomorrow evening's mined
  // pattern) and any hours a truncated block never reached — an under-buy.
  // "Never strip without replacing" (§2.3) now holds PER-HOUR, not per-plan.
  // v1.60.0 — is there an EVSE PREDICTION at all? `ev == null` means the
  // evWindowPrediction report itself was unavailable (no EVSE history, EVSE
  // offline, cloud gap, analytics failure) — NOT "the car will not charge". In
  // that case every hour's evP90W stays undefined and the planner falls back to
  // the EV-blind charge model while DISCLOSING that contention is unmodelled.
  // An ev report that predicts nothing is a different, positive claim and does
  // set evP90W = 0.
  const evPredictionAvailable = ev != null;

  const embByTs = new Map<number, number>();
  const byTs = new Map<number, NightChargeHour>();
  for (const h of bandHours) {
    if (!Number.isFinite(h.ts)) continue;
    const embW = Math.max(0, h.embeddedEvW ?? 0);
    embByTs.set(h.ts, embW);
    byTs.set(h.ts, {
      ts: h.ts,
      pvP10W: Math.max(0, h.pvP10W),
      loadP90W: Math.max(0, h.loadP90W),
      // Within the band the EV component of the load IS known when a prediction
      // exists: it is the day-ahead expected-value EV embedded in loadP90W,
      // replaced hour-by-hour below wherever the committed p90 block lands.
      evP90W: evPredictionAvailable ? embW : undefined,
    });
  }
  for (const dr of dayRollups) {
    const da = Math.max(1, dr.daysAhead);
    const widen = Math.max(0, realizedDailyErrHalfFrac) * Math.sqrt(da);
    const p10Frac = Math.max(0, 1 - widen); // pessimistic-low PV
    const p90Frac = 1 + widen; // pessimistic-high load
    for (const hh of dr.hours) {
      if (!Number.isFinite(hh.ts) || byTs.has(hh.ts)) continue;
      byTs.set(hh.ts, {
        ts: hh.ts,
        pvP10W: Math.max(0, hh.pvW * p10Frac),
        loadP90W: Math.max(0, hh.loadW * p90Frac),
      });
    }
  }

  const horizon = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);

  // Place the committed-EV worst-case block on the EV-CLEAN base (§2.3). The
  // p90 session energy is laid down from the predicted charge hour forward, the
  // EV component capped at evMaxLoadW/hour, spilling to later hours if a single
  // hour cannot hold the whole session (physically correct worst case).
  if (evBlockWillPlace) {
    const startHour = Math.floor(ev!.chargeStartMs! / HOUR_MS) * HOUR_MS;
    // Only place the committed block within the next-24 h BAND region (the
    // committed session is a next-day event). Beyond-24 h rollup hours already
    // embed typical EV in their loadW and are NOT de-duped, so adding the block
    // there would double-count (a — safe-direction — over-buy). Bounding to 24 h
    // keeps the block on the EV-clean band and avoids the double count.
    const blockEndMs = nowMs + 24 * HOUR_MS;
    let remainingKwh = ev!.p90SessionKwh!;
    for (const h of horizon) {
      if (remainingKwh <= 1e-9 || h.ts >= blockEndMs) break;
      if (h.ts < startHour) continue;
      // De-dup exactly THIS hour's embedded EV and replace it with the
      // committed-block watts (atomic per-hour strip+re-add). Hours before the
      // block, after it exhausts, or beyond the band region keep their embedded
      // expected-value EV untouched.
      const emb = embByTs.get(h.ts) ?? 0;
      const addW = Math.min(Math.max(0, evMaxLoadW), remainingKwh * 1000);
      h.loadP90W = Math.max(0, h.loadP90W - emb) + addW;
      // v1.60.0 — keep the EV ATTRIBUTION atomic with the strip+re-add: this
      // hour's EV component is now the committed block, not the expected-value
      // EV it replaced. The charge-rate derate reads loadP90W (total load);
      // this field only tells the plan how much of it is the car.
      h.evP90W = addW;
      remainingKwh -= addW / 1000;
    }
  }

  // Trim to [nowHour, nextRecharge). The sizing brain also filters ≥ nowMs, but
  // clamping here keeps the horizon we hand it honest.
  const nowHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const end = nextRechargeMs ?? (horizon.length ? horizon[horizon.length - 1].ts + HOUR_MS : nowHour + HOUR_MS);
  const trimmed = horizon.filter((h) => h.ts >= nowHour && h.ts < end);

  // v1.48.0 — coverage floor corrected 0.9 → 0.78. The P10–P90 band nominally
  // covers 80%, and the WRITE gate (nightChargeGate.ts) accepts realized
  // coverage in [0.78, 0.92] as calibrated. Requiring ≥ 0.9 here meant a
  // CORRECTLY calibrated forecast (e.g. the live 85%) failed the basis every
  // night — no plan, no advisory content, nothing scored, readiness starved.
  // Below 0.78 the band is overconfident (too narrow) and still blocks; above
  // 0.92 it is over-wide, which is CONSERVATIVE for the P10-PV sizing this
  // basis feeds, so the advisory basis needs no upper bound (the write gate
  // keeps its stricter two-sided band).
  const basisComplete =
    forecastPresent &&
    confidenceTier !== 'climatology' &&
    calScoredDays >= minCalScoredDays &&
    bandCoverageFrac >= 0.78;

  return {
    nowMs,
    fullKwh,
    socNowPct,
    reserveFloorPct,
    cushionPct,
    socCoherent,
    legEff,
    dischargeEff,
    chargeCapKw,
    gridInputCapKw,
    window,
    horizon: trimmed,
    morningPvSurplusP90Kwh,
    confidenceTier,
    basisComplete,
    minBuyKwh,
  };
}

// --- v1.50.0 actuated-night measurement helpers (PURE) -----------------------

/**
 * Charge-attributable meter energy on an ACTUATED night: the window grid
 * import minus the concurrent house pass-through. Under the bypass model the
 * home runs on grid during charge hours, so window import = house load +
 * battery charge; subtracting the measured window load isolates the delivered
 * buy. Null when either side is unmeasured — never a fabricated delivery.
 */
export function actuatedDeliveredKwh(
  windowImportKwh: number | null,
  windowLoadKwh: number | null,
): number | null {
  if (windowImportKwh == null || windowLoadKwh == null) return null;
  if (!Number.isFinite(windowImportKwh) || !Number.isFinite(windowLoadKwh)) return null;
  return round2(Math.max(0, windowImportKwh - windowLoadKwh));
}

/**
 * Realized-need buy on an ACTUATED night (§5 as amended 2026-07-31): the home
 * ran WITH the delivered charge, so the no-buy counterfactual trough is the
 * measured trough minus the pack-side delivered energy — a MEASURED
 * counterfactual (subtract what was injected), not a modeled one. The need is
 * the meter energy that would have lifted that counterfactual trough back to
 * floor+cushion.
 */
export function actuatedRealizedNeedBuyKwh(opts: {
  targetFloorKwh: number;
  actualMinPackKwh: number;
  deliveredMeterKwh: number;
  legEff: number;
}): number {
  const deliveredPackKwh = opts.deliveredMeterKwh * opts.legEff;
  const noBuyTroughKwh = opts.actualMinPackKwh - deliveredPackKwh;
  return round2(Math.max(0, opts.targetFloorKwh - noBuyTroughKwh) / opts.legEff);
}

/**
 * v1.105.0 (algo v3) — the realized need on the PLANNER-SIZING basis.
 *
 * `buy_err_kwh` now answers exactly one question: **did the planner size the
 * buy correctly?** The previous definition answered neither of the two
 * available questions. It computed `planBuy − (delivered + troughDeficit)`,
 * which is the DIFFERENCE of "did the planner size right?" and "did delivery
 * meet the need?", so:
 *
 *  - it added the ACTUATOR'S OWN delivered energy back into "realized need",
 *    making actuator over-delivery arithmetically indistinguishable from
 *    planner under-sizing. The actuator over-delivers BY DESIGN — the device is
 *    handed a setpoint derived from the requirement, deliberately not from the
 *    derated deliverable (see the header at the buyKwh/setpointSocPct split) —
 *    so this term was systematically negative;
 *  - and it anchored its counterfactual on a trough read 16 h past window
 *    close, by which time the pack is resting on the REVERTED reserve setpoint.
 *    That trough is a control variable, not a free energy variable: injecting
 *    38 kWh overnight does not raise where the pack bottoms out, it delays it.
 *    At a 10 % trough this contributed a fixed −14.9 kWh regardless of anything
 *    the planner did.
 *
 * Between them those two terms produced a 56 % "under-buy rate" that hard-blocked
 * promotion and that no forecast improvement could ever move — an honest load
 * correction LOWERS the planned buy and makes the residual MORE negative.
 *
 * THE PLANNER-SIZING BASIS. A planner sizes the buy from its forecast. Its
 * sizing error is therefore its FORECAST error, expressed in kWh:
 *
 *   netMissKwh = (forecastPv − actualPv) + (actualLoad − forecastLoad)
 *   realizedNeed = planBuy + netMissKwh / legEff
 *   buy_err = planBuy − realizedNeed = −netMissKwh / legEff
 *
 * Less PV than forecast, or more load, means the true requirement exceeded the
 * plan — an under-buy, negative, preserving the existing sign convention that
 * `buy_err < 0` is the asymmetric safety miss. It contains no delivered term,
 * no trough, and no reverted setpoint: it measures the planner and nothing else.
 */
/**
 * v1.106.0 — a CALIBRATED half-width for the load band, from realized error.
 *
 * `loadP10Kwh`/`loadP90Kwh` were `P50 ÷ 1.15` and `P50 × 1.15`: a hand-set ±15%
 * sizing multiplier that nothing estimated from data, named P10/P90 and graded
 * by the readiness gate as if it were a calibrated 80% interval. Measured on the
 * live ledger it contained the actual **14%** of the time (a calibrated band
 * should be ~80%), and realized load errors of −28% sat far outside it.
 *
 * The factor is now the empirical band that WOULD have contained ~80% of past
 * realized errors, with two guards:
 *
 *  - FLOOR at the historical 1.15, so this can only ever WIDEN the band. On the
 *    sizing side only `loadP90W` matters (it drives the projected drain), and a
 *    wider P90 buys more — under-buy is the asymmetric safety miss, so the
 *    monotone direction of this change is the safe one.
 *  - CAP, so a handful of pathological nights cannot run the band away.
 *
 * Below `minSamples` it returns the floor and says so, rather than calibrating
 * on noise.
 */
export function calibratedLoadBandFactor(
  errFracs: ReadonlyArray<number | null | undefined>,
  opts: { floor?: number; cap?: number; minSamples?: number; quantile?: number } = {},
): { factor: number; basis: 'measured' | 'default'; samples: number } {
  const floor = opts.floor ?? 1.15;
  const cap = opts.cap ?? 2.0;
  const minSamples = opts.minSamples ?? 10;
  const q = opts.quantile ?? 0.8;
  const abs = errFracs
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .map((v) => Math.abs(v))
    .sort((a, b) => a - b);
  if (abs.length < minSamples) return { factor: floor, basis: 'default', samples: abs.length };
  // Nearest-rank quantile: the half-width that would have covered `q` of them.
  const idx = Math.min(abs.length - 1, Math.max(0, Math.ceil(q * abs.length) - 1));
  const halfWidth = abs[idx];
  const factor = Math.min(cap, Math.max(floor, 1 + halfWidth));
  return { factor: Math.round(factor * 1000) / 1000, basis: 'measured', samples: abs.length };
}

export function plannerSizingNeedBuyKwh(opts: {
  planBuyKwh: number;
  forecastPvKwh: number;
  actualPvKwh: number;
  forecastLoadKwh: number;
  actualLoadKwh: number;
  legEff: number;
}): number {
  const netMissKwh = (opts.forecastPvKwh - opts.actualPvKwh) + (opts.actualLoadKwh - opts.forecastLoadKwh);
  return round2(opts.planBuyKwh + netMissKwh / opts.legEff);
}

// --- scoreNightOutcome: the §3.1 score columns from a plan + measured actuals ---

/** Measured next-evening actuals for scoring last night's plan (design §3.1). */
export interface NightOutcomeActuals {
  /** Realized PV energy over the scored span, kWh. */
  actualPvKwh: number | null;
  /** Realized house load over the scored span, kWh. */
  actualLoadKwh: number | null;
  /** Realized minimum SoC % and its instant (raw telemetry — the UN-actuated
   *  baseline in advisory phase; used only for soc_min_err, NOT the floor
   *  verdict, which is the plan trajectory per §3.3). */
  actualMinSocPct: number | null;
  actualMinSocTsMs: number | null;
  /** The buy that, in hindsight with actual PV/load, WOULD have been required to
   *  hold floor+cushion — the "realized need". buy_err = planned − this. */
  realizedNeedBuyKwh: number | null;
  /** Central (P50) forecast totals the plan was issued against, for the signed
   *  fractional PV/load errors (the plan itself sizes on P10/P90). */
  forecastPvKwh: number | null;
  forecastLoadKwh: number | null;
}

/** The §3.1 SCORE columns produced from a plan + its measured outcome. */
export interface NightOutcomeScore {
  /** (actual − forecast)/forecast; + = more PV than forecast (less shortfall). */
  pvErrFrac: number | null;
  /** (actual − forecast)/forecast; + = more load than forecast (worse). */
  loadErrFrac: number | null;
  /** planned buy − realized need, kWh, signed (+ = over-bought, the SAFE side;
   *  − = under-bought, the life-safety miss §5.1). */
  buyErrKwh: number | null;
  /** plan minProjSoc − actual min SoC, %-points (+ = plan optimistic vs reality). */
  socMinErrPct: number | null;
  /** Would the PLAN's own trajectory (buy applied) have breached floor+cushion?
   *  Evaluated on the plan trajectory (§3.3), never on baseline telemetry. null
   *  when the plan produced no trajectory (incomplete basis / hold). */
  planTrajFloorBreached: boolean | null;
}

/**
 * Score a plan against its measured outcome (design §3.1). PURE. The floor-breach
 * verdict is taken from the PLAN's own simulated trajectory (§3.3) — in advisory
 * phase the home runs WITHOUT the buy, so raw min-SoC telemetry measures the
 * un-actuated baseline, not the plan's line. All fields fail null-safe.
 */
export function scoreNightOutcome(
  plan: NightChargePlan | null,
  actuals: NightOutcomeActuals,
): NightOutcomeScore {
  const signedFrac = (actual: number | null, forecast: number | null): number | null => {
    if (actual == null || forecast == null || !Number.isFinite(forecast) || Math.abs(forecast) < 1e-9) return null;
    return round2((actual - forecast) / forecast);
  };

  const planBuy = plan?.buyKwh ?? null;
  const buyErrKwh =
    planBuy != null && actuals.realizedNeedBuyKwh != null
      ? round2(planBuy - actuals.realizedNeedBuyKwh)
      : null;

  const socMinErrPct =
    plan?.minProjSocPct != null && actuals.actualMinSocPct != null
      ? round1(plan.minProjSocPct - actuals.actualMinSocPct)
      : null;

  // §3.3: the safety verdict is the plan trajectory (buy applied) dipping below
  // floor+cushion, i.e. the module's own minProjSocPct vs the floor+cushion line.
  const targetFloorPct = plan ? plan.reserveFloorPct + plan.cushionPct : null;
  const planTrajFloorBreached =
    plan == null || plan.minProjSocPct == null || targetFloorPct == null
      ? null
      : plan.minProjSocPct < targetFloorPct - 1e-9;

  return {
    pvErrFrac: signedFrac(actuals.actualPvKwh, actuals.forecastPvKwh),
    loadErrFrac: signedFrac(actuals.actualLoadKwh, actuals.forecastLoadKwh),
    buyErrKwh,
    socMinErrPct,
    planTrajFloorBreached,
  };
}

// --- createNightChargeAdvisor: the thin wrapper (mirrors createLoadShedAdvisor) ---

export interface NightChargeAdvisor {
  /** Assemble fresh inputs → compute the plan → store it in the holder → return. */
  update(): NightChargePlan;
  getStatus(): NightChargePlan | null;
}

/**
 * Thin advisor wrapper: injects the input assembly (via buildInputs, which the
 * integrator wires to the live analytics/tariff pieces at ~21:30), computes the
 * plan through the pure brain, and latches it in the module holder for the API /
 * MQTT / notify surfaces. Mirrors createLoadShedAdvisor (loadShedAdvisor.ts).
 */
export function createNightChargeAdvisor(deps: {
  buildInputs: () => NightChargeInputDeps;
  now?: () => number;
}): NightChargeAdvisor {
  return {
    update(): NightChargePlan {
      const inputs = buildNightChargeInputs(deps.buildInputs());
      const plan = computeNightChargePlan(inputs);
      setLatestNightChargePlan(plan);
      return plan;
    },
    getStatus: () => getLatestNightChargePlan(),
  };
}

/**
 * v1.39.0: the fixed America/Phoenix (UTC-7, no DST) clock bounds of a plan
 * date's night — the single source of truth for the SCORER's spans and for the
 * "may this night be scored yet?" completion boundary. Plan for day D covers
 * charge window [D 23:00, D+1 05:00); its plan-trajectory score span runs
 * [D+1 05:00, D+1 21:00); the night is COMPLETE — and may be outcome-captured —
 * only at/after D+1 21:00. Scoring earlier permanently freezes truncated
 * actuals into the never-pruned ledger (the pre-v1.39.0 midnight-capture
 * defect). PURE — returns null on a malformed date string.
 */
export function nightWindowBounds(planDate: string): {
  onpeakStartMs: number;
  onpeakEndMs: number;
  windowStartMs: number;
  windowEndMs: number;
  scoreSpanEndMs: number;
  /** The instant the night is fully observable; scoring before this is invalid. */
  completeMs: number;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate ?? '');
  if (!m) return null;
  const dayStartUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + 7 * HOUR_MS; // Phoenix midnight
  const scoreSpanEndMs = dayStartUtc + 45 * HOUR_MS; // D+1 21:00
  return {
    onpeakStartMs: dayStartUtc + 16 * HOUR_MS, // D 16:00
    onpeakEndMs: dayStartUtc + 19 * HOUR_MS,   // D 19:00
    windowStartMs: dayStartUtc + 23 * HOUR_MS, // D 23:00
    windowEndMs: dayStartUtc + 29 * HOUR_MS,   // D+1 05:00
    scoreSpanEndMs,
    completeMs: scoreSpanEndMs,
  };
}

/**
 * v1.39.0: 3-sample median filter over a {ts,value} series. Kills ISOLATED
 * transient spikes (the SHP2 cloud-reconnect single-sample backupBatPercent=0
 * artifact) while passing genuine sustained excursions — a real low reading
 * has neighbors that agree with it. Endpoints pass through unchanged. PURE.
 */
export function medianFilter3(
  pts: ReadonlyArray<{ ts: number; value: number }>,
): Array<{ ts: number; value: number }> {
  if (pts.length < 3) return pts.slice();
  const out: Array<{ ts: number; value: number }> = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const tri = [pts[i - 1].value, pts[i].value, pts[i + 1].value].sort((a, b) => a - b);
    out.push({ ts: pts[i].ts, value: tri[1] });
  }
  out.push(pts[pts.length - 1]);
  return out;
}
