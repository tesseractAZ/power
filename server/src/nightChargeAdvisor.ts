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
 * WHY this exists (requirement): on a day a shortfall is anticipated, buy
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
 *    explicit resilience requirement, so a confident under-sized buy
 *    leaves the home at the floor with no cushion when an outage hits.
 *    Therefore sizing uses WORST-CASE inputs — P10 (low) PV and P90 (high)
 *    load, with committed-EV load placed as a worst-case block upstream.
 *  - EMIT NULL over a fabricated number: any incomplete / incoherent / thin /
 *    climatology-only basis yields a null plan (chargeTonight=false, no buy),
 *    never a best-effort small number that could be mistaken for cushion.
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
 * The DC-bus depletion recurrence: each hour the pack changes by
 * `pvW − loadW / dischargeEff` (delivering `load` at the panel draws `load/η`
 * from the pack — the discharge conversion tax), clamped to [0, fullWh], with the
 * pool sized on the panel's NAMEPLATE capacity (fullKwh = backupFullCapWh).
 * v1.187.22 — this is NOT the runway's recurrence any more. Since v1.187.19 the
 * runway, the day/multi-day SoC trajectories and the probabilistic band drain the
 * pool by the load leg PLUS the Cores' standby overhead (~270 W, analytics.ts), on
 * the MEASURED capacity basis (the packs' BMS full-charge capacity, ~0.944 of
 * nameplate on this fleet). The planner keeps the bare load/η leg on nameplate —
 * its sizing basis is unchanged, and a source-pin test keeps the runway's basis out
 * of this module — so its trough and the runway's projection are no longer the
 * same number.
 * v1.194.0 — a POSITIVE change is a surplus the Cores charge the cells with, and it is
 * stored at legEff (chargeLegStep, physics/chargeLeg.ts): every walk here (simulate, the
 * with-buy window walk, expectedCarryKwh, expectedPvChargeWalk, expectedForceChargeStart)
 * credited it at unity before, which put the sizing trough above what the packs would hold.
 * A buy rises or stays — over a year of plans none fell (legacyIdentity.test.ts pins the
 * direction). The runway's walks take the same leg (√RTE, analytics.ts's own constant).
 * ═════════════════════════════════════════════════════════════════════════ */

// The ONE definition of the reserve-write bound ([10,50], the device's own
// clamp). Imported rather than re-stated so the value published to the HA
// automation and the value the supervised path writes can never drift apart.
// (nightChargeActuator.ts imports nothing — no cycle.)
import { clampReserveTarget, RESERVE_WRITE_MAX_PCT, armedForceChargeCeilingPct, isNoChargeKwh } from './nightChargeActuator.js';
// v1.187.22 — the level an armed write drives the pool to, and the just-in-time start the
// force-charge times itself by, for the expected-buy disclosure.
// (nightForceCharge.ts imports only nightChargeActuator.ts — no cycle.)
import {
  armedWriteLevelPct, forceChargeStartAtMs, forceChargeStopPct, evDisplacedPackKwh,
  FORCE_CHARGE_MIN_RUN_MS, FORCE_CHARGE_MIN_RATE_KW,
} from './nightForceCharge.js';
// R2 — the window resolver and the per-leg rules live with the cycle chooser; the taper ceiling
// with the curtailment engine's taper band. (chargeWindows.ts imports only tariff.ts;
// chargeTaper.ts imports nothing — no cycle.)
import { resolveCheapWindow, legObjective, legForceChargeEligible, type ChargeWindowKind, type ChargeLegRole, type CheapNight } from './chargeWindows.js';
import { taperCeilingKwh } from './chargeTaper.js';
// v1.191.0 (lane A, T5/T10) — window text and plan-date bounds in the site zone.
import { fmtSiteDayHm, siteDayStartMs } from './siteTime.js';
// v1.194.0 — the charge leg of every walk below (physics/chargeLeg.ts imports nothing — no cycle, and
// none of analytics.ts's runway basis).
import { chargeLegStep } from './physics/chargeLeg.js';
export { resolveCheapWindow } from './chargeWindows.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** One hour of the CONSERVATIVE forecast the planner sizes against. PV is the
 *  P10 (pessimistic-low) band; load is the P90 (pessimistic-high) band with any
 *  committed-EV block already folded in upstream and de-duplicated against the
 *  base curve (design §2.3). Both in WATTS, ts hour-aligned. */
/**
 * v1.148.0 — the coverage floor, named. See the v1.48.0 note below for why 0.78.
 *
 * ★ This gate can LATCH. `bandCal` is shrink-only, so once realized error exceeds
 * the published band it pins at 1.0, the threshold collapses to the raw band, and
 * coverage is mathematically forced under 80%. It recovers only if the raw sigma
 * inputs grow or the weather eases. That is a deliberate fail-safe, not a bug —
 * but it means a miss here is a STATE, not a blip, and must be reported as one.
 */
export const BASIS_MIN_BAND_COVERAGE = 0.78;

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
  /** v1.187.22 — the MEDIAN (P50) load, watts: the day-ahead forecastLoadW WITHOUT the P90
   *  factor, with the forecast's expected-value EV left in (never the committed P90 block).
   *  Read ONLY by the expected-buy disclosure (expectedBuyFromPlan) — never by sizing.
   *  null/absent ⇒ no P50 basis for this hour, and the plan states no expected buy. */
  loadP50W?: number | null;
  /** v1.187.22 — the MEDIAN (P50) PV, watts, for the same disclosure; absent ⇒ pvP10W
   *  stands in (a lower PV, so a larger expected buy — never a smaller one). */
  pvP50W?: number | null;
}

/**
 * R2 — WHICH window a plan sizes, and how that window's physics differ from the overnight one.
 *
 * Every live plan is the overnight cost leg (OVERNIGHT_WINDOW_SPEC, or no spec at all — the two
 * are the same plan, byte for byte: legacyIdentity.test.ts). The mid-day super off-peak leg and
 * the overnight backup ahead of it (chargeWindows.ts chooseChargeCycle) are sized by the same
 * engine with these differences, each of which is a no-op on the overnight leg:
 *  - `window`: the leg's window as the chooser pinned it (the resolver is not asked);
 *  - `packAcceptKw`: PV and the grid charger share what the packs accept, so an hour's grid gain
 *    is at most packAcceptKw − PV (no PV ⇒ the contended charge rate alone, as before);
 *  - `curtailFromPct`: the cost ceiling leaves the PV surplus room under the charge taper rather
 *    than under full (basis 'pv-curtail', chargeTaper.ts);
 *  - `backupHold`: the pool this leg is sized from is the one an armed backup leg protects;
 *  - a super off-peak leg's reserve write is middayReserveTargetPct (T_mid), and the force-charge
 *    carries only the cost fill;
 *  - role 'backup': resilience only, never force-charges (legObjective, legForceChargeEligible).
 * P50 PV that lands in the pack while a write charges it is credited against the expected buy
 * (expectedPvChargeWalk) — 0 with no PV.
 */
export interface WindowSpec {
  kind: ChargeWindowKind;
  role: ChargeLegRole;
  /** The leg's window as chooseChargeCycle pinned it. Absent ⇒ resolved from periodIdAt /
   *  cheapPeriodId over windowScanHours, as before. null ⇒ no window (a null plan). */
  window?: { startMs: number; endMs: number } | null;
  /** What the packs accept at once from PV and the grid charger together, kW (pack side).
   *  null/absent ⇒ chargeCapKw × legEff — the grid charge rate alone, the bound with no PV. */
  packAcceptKw?: number | null;
  /** The taper line the cost ceiling measures the PV headroom from, % (chargeTaper.ts
   *  saturationThresholdPct of the pool's charge ceiling). null/absent ⇒ from full (the
   *  overnight morning-solar headroom). */
  curtailFromPct?: number | null;
  /** An armed backup leg ahead of this one: the reserve it writes (%) and its window close. The
   *  islanded carry is lifted to it at the close (max(walk, hold)) and the expected carry floored
   *  at it until then. null/absent ⇒ no backup armed. */
  backupHold?: { pct: number; untilMs: number } | null;
}

/** Today's leg: the overnight window carrying the cost (or the resilience) buy. */
export const OVERNIGHT_WINDOW_SPEC: Readonly<WindowSpec> = Object.freeze({ kind: 'overnight', role: 'cost' });

export interface NightChargeInputs {
  /** Evaluation instant (~21:30). Drives the pre-window carry start. */
  nowMs: number;
  /** R2 — the leg this plan sizes (see WindowSpec). Absent ⇒ the overnight cost leg. */
  windowSpec?: WindowSpec;

  // ── Battery state (read from the SHP2 projection upstream) ──
  /** Pool capacity as the SHP2 reports it, kWh (backupFullCapWh/1000): the packs' nameplate sum
   *  (92.16 at 15 packs), not their measured full-charge capacity and not usable energy. */
  fullKwh: number;
  /** Current state-of-charge %, as the SHP2 reports it. */
  socNowPct: number;
  /** The reserve floor % the SHP2 defends and the floor alarm reads
   *  (backupReserveSoc). The SAME field, never a divergent copy. */
  reserveFloorPct: number;
  /** Outage cushion % ABOVE the floor (configured default 15; later learned). */
  cushionPct: number;
  /** v1.125.0 — observed ISLANDED load (the SHP2's backup circuits), kW. When the
   *  grid drops this is what actually runs; the whole-house figure is not. Null
   *  when unmeasured, which fails closed to the legacy flat band. */
  islandedLoadKw?: number | null;
  /** v1.125.0 — bounded outage the cushion must survive, hours. */
  outageCushionHours?: number;
  /** v1.125.0 — multiplier on the observed islanded load. Higher = stricter. */
  islandedLoadSafety?: number;
  /** v1.127.0 — 'cost' sizes the buy to minimise the bill; 'resilience' (the
   *  legacy behaviour) sizes it to hold floor+cushion. Cost mode is bounded
   *  BELOW by the resilience answer, so it can never buy less. */
  objectiveMode?: 'resilience' | 'cost';
  /** v1.127.0 — hard SoC ceiling for cost mode when no PV surplus is known. */
  costMaxSocPct?: number;
  /** SoC coherence check (% vs remainWh/fullCapWh) passed upstream (I11).
   *  false ⇒ null plan. */
  socCoherent: boolean;

  // ── Efficiency (verified constants, injected — never hard-coded here) ──
  /** Charge-leg efficiency = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.927. The pack
   *  gains legEff of grid energy diverted to the charger — and, v1.194.0, of a PV surplus in
   *  every walk (chargeLegStep). */
  legEff: number;
  /** Discharge DC-bus efficiency = RUNWAY_DISCHARGE_EFFICIENCY ≈ 0.94. */
  dischargeEff: number;

  // ── Charge feasibility ──
  /** The planner's grid-side charge-power ceiling, kW (planChargeCapKw: connected Cores ×
   *  FORCE_CHARGE_PROVEN_KW_PER_SLOT ÷ the charge-leg efficiency, or the ARB_CHARGE_CAP_KW
   *  override). The panel's `chChargeWatt` / `chargeWattPower` reads 7.2 kW, but that is the
   *  limit for EACH connected battery, not the pool's: measured 2026-09-16/18 and 2026-10-13/14,
   *  three Cores take ~17-18 kW together at a ~19.1 kW main (reference 15-2, hardware charge
   *  envelope). */
  chargeCapKw: number;
  /** v1.60.0 — the SHARED grid-input envelope, kW: the total the service/SHP2
   *  input carries at once for house pass-through AND battery charging. The
   *  charger only ever gets what the house leaves, so this is what makes the
   *  charge rate contended (see chargeRateKwAt).
   *
   *  null / non-finite / ≤0 ⇒ NO envelope modelled: the charge rate falls back
   *  to the flat chargeCapKw (pre-v1.60.0 behaviour). Never silently "0". */
  gridInputCapKw: number | null;

  /** v1.112.0 — learned buy de-bias (calibratedBuyDebiasFactor). Multiplies the
   *  ANNOUNCED buy only; buyKwh itself stays raw (ledger + learner input), and
   *  chargeTonight thresholds on the raw figure so learned data never flips the
   *  decision, only the disclosure. Default 1 (no calibration). */
  buyDebiasFactor?: number;
  buyDebiasBasis?: 'measured' | 'default';
  buyDebiasSamples?: number;
  /** v1.187.22 — the night force-charge will ride an armed plan (forceChargeEnabled: a write
   *  mode, cost objective, ARB_COST_MAX_SOC_PCT above the reserve maximum). Read ONLY by the
   *  expected-buy disclosure, to know which level the armed write drives the pool to.
   *  absent/false ⇒ the reserve setpoint alone. */
  forceChargeEligible?: boolean;

  // ── The cheap charge window tonight (resolved upstream via tariff.rateAt) ──
  window: { startMs: number; endMs: number } | null;

  /** Hourly conservative forecast covering [nowMs, nextRecharge). MUST include
   *  the pre-window carry (now→windowStart), the window hours, and the
   *  post-window horizon (windowEnd→nextRecharge). Hour-aligned, ascending. */
  horizon: NightChargeHour[];

  /** P90 (high) next-morning PV surplus, kWh — the over-buy ceiling headroom so
   *  a too-full pack doesn't clip morning PV. null ⇒ ceiling not applied. */
  morningPvSurplusP90Kwh: number | null;
  /** v1.168.0 — the MEDIAN (P50) next-morning PV surplus, kWh: what the COST ceiling
   *  leaves room for (the P90 above stays the resilience over-buy flag). Measured
   *  2026-09-17: the P90 planned for 32.6 kWh against Friday surpluses of 7.7-24.2 kWh
   *  (median ~16), and the pack never passed 80% in 27 days — too cautious every
   *  night. null/absent ⇒ the P90 stands in. */
  morningPvSurplusP50Kwh?: number | null;
  /** v1.168.0 — THE THURSDAY RULE: the next full-length cheap window is more than a
   *  day away (see longGapAhead). Cost mode then fills to the owner's SoC ceiling
   *  and sets the morning-solar headroom aside. */
  longGapAhead?: boolean;
  /** v1.186.0 — the PESSIMISTIC (P10, low-PV) surplus from window close to the evening
   *  on-peak start (pessimisticPrePeakSurplus). Read ONLY on a long-gap night: the ceiling
   *  becomes min(costMaxSocPct, full − this) instead of costMaxSocPct alone. null/absent ⇒
   *  the headroom stays set aside (the v1.168.0 full buy). */
  prePeakPvSurplusP10Kwh?: number | null;
  /** v1.187.1 — the same morning surplus on the DE-BIASED load (see costSurplusLoadFactor):
   *  the cost ceiling uses it only where it widens the headroom, and never below the
   *  resilience target (debiasedCostSurplusKwh). null/absent ⇒ the raw surplus, as before.
   *  Never read on a long-gap night. */
  costSurplusLoad?: CostSurplusLoad | null;

  // ── Basis quality (gates) ──
  confidenceTier: 'forecast' | 'mixed' | 'climatology';
  /** calScoredDays ≥ N_MIN AND band coverage ≥ 0.78 (nominal 80% band, matching the write gate's floor) AND forecast present. */
  basisComplete: boolean;
  /**
   * v1.148.0 — WHICH of the four basis gates failed, or null when complete.
   * `basisComplete: false` alone cost an hour of live probing to explain, after a
   * night the plant spent at its reserve floor.
   */
  basisBlockedBy?: string | null;
  /**
   * v1.186.5 — the failure is the shape a start-up leaves (no forecast yet, no scored
   * calibration day, telemetry not yet coherent), so the evening job waits it out
   * (eveningBasisDefers). A persistent failure — too few calibration days, a band
   * coverage miss, a climatology tier, bad configuration — is decided at once.
   */
  basisTransient?: boolean;
  /** v1.198.0 — the basis is PROVISIONAL (fewer than N_MIN scored calibration days): the horizon's
   *  P10 PV and the beyond-24 h carry are widened (PROVISIONAL_BAND_WIDEN), and this says by how
   *  much. Absent on the full basis and on a refused one. */
  pvBandWiden?: PvBandWiden;

  /** Below this buy, treat the night as "hold" (no meaningful charge). kWh. */
  minBuyKwh: number;
}

/** v1.198.0 — how a plan's PROVISIONAL solar band was widened (buildNightChargeInputs). */
export interface PvBandWiden {
  /** k(n), PROVISIONAL_BAND_WIDEN[calScoredDays]: the widening of the band's lower half-width. */
  factor: number;
  /** The scored calibration days the basis had. */
  calScoredDays: number;
  /** The scored days the full band needs (N_MIN, 14): the widening ends there. */
  fullCalScoredDays: number;
  /** The next 24 h's P10 PV as published (the probabilistic band), and as the plan sized on it, kWh. */
  bandP10Kwh: number;
  widenedP10Kwh: number;
  /** The beyond-24 h carry's widening per √day: factor × the band's own lower half-width
   *  (bandLowerHalfFrac) — what realizedDailyErrHalfFrac is on the full basis. */
  rollupHalfFrac: number;
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
  | 'cost_arbitrage'     // v1.127.0 — buy to minimise the bill, not to hold a cushion
  | 'none'; // nothing to buy, or basis incomplete

export interface NightChargePlan {
  generatedAt: number;
  /** false ⇒ every numeric field is null and chargeTonight is false. */
  basisComplete: boolean;
  /**
   * v1.148.0 — WHICH of the four basis gates failed, or null when complete.
   * `basisComplete: false` alone cost an hour of live probing to explain, after a
   * night the plant spent at its reserve floor.
   *
   * v1.196.0 — which gate refused; set on every refused null plan (`basisComplete: false`):
   * the input's basis gate (null when the caller named none), or the planner's own precondition
   * (SoC incoherent, climatology tier, pool capacity, SoC, floor/cushion, efficiency, horizon).
   * Absent on a complete plan — a charge or hold plan's JSON carries no key. The 21:30 "no plan
   * tonight" push states it (notify.buildNightChargeMessage); it was declared and never set.
   */
  basisBlockedBy?: string | null;
  /**
   * v1.186.5 — the failure is the shape a start-up leaves (no forecast yet, no scored
   * calibration day, telemetry not yet coherent), so the evening job waits it out
   * (eveningBasisDefers). A persistent failure — too few calibration days, a band
   * coverage miss, a climatology tier, bad configuration — is decided at once.
   */
  basisTransient?: boolean;
  objective: NightChargeObjective;
  /** The single owner-facing decision. NEVER null (defaults false). */
  chargeTonight: boolean;

  /** Grid energy to buy at the meter, kWh. null when basis incomplete.
   *  ★ RAW physics-derived estimate — the ledger records THIS (learner input). */
  buyKwh: number | null;
  /** v1.112.0 — buyKwh x the learned de-bias, for announcement surfaces. Equals
   *  buyKwh when uncalibrated. null iff buyKwh is null. */
  buyKwhDebiased: number | null;
  /** The factor applied above (1 = uncalibrated). */
  buyDebiasFactor: number;
  /**
   * v1.144.0 — WHY the factor is what it is. `1.000` currently reads as
   * "measured, and there is no bias" when it actually means "could not measure".
   * The learner's eligibility filter requires `!(cushion_shortfall === 1)`, and
   * that flag is 1 on EVERY ledger row — so it selects zero rows, falls below
   * minSamples, and returns the floor. The "announced buy calibrated" line has
   * never once been emitted, while delivered/planned has run 1.44-1.55x on every
   * actuated-and-scored night.
   *
   * This does not fix the pin — `cushionShortfall` is set from a grid-blind
   * whole-house island trough (`minProjSocPct = 0`, `requiredExtraKwh` = the
   * entire pool), so no cushion size including zero clears it while the current
   * floor stands, and v1.125.0's re-scope did not unpin it. What it fixes is the
   * silence: an operator reading 1.000 should be able to tell an absent
   * measurement from a null result. `underBuyMeasurable` already does exactly
   * this for its sibling; this was the remaining asymmetry.
   */
  buyDebiasBasis: 'measured' | 'default';
  buyDebiasSamples: number;
  /**
   * v1.187.22 — the EXPECTED meter-side purchase: what the armed write would actually draw
   * into the Cores, beside `buyKwh`, the islanded worst case the plan is SIZED on. On
   * 2026-10-12 the plan said "Buy ~64.2 kWh" from a sizing start of 16.9% at the window
   * open (P90 load ×1.35, a 19.3 kWh P90 EV block before the 00:00 window, no reserve
   * floor); the pool was really at 46%, and from there the write (reserve 50%, then
   * force-charge to 80.4%) draws ≈34 kWh. Over the seven nights scored on the delivered
   * basis, delivered/buy had a median of 0.49.
   *
   * = what the write draws from expectedStartSocPct (expectedBuyFromPlan): the reserve leg
   * (up to the written reserve), plus — when force-charge rides the night — the force-charge
   * stop less the pool at the just-in-time start, the house's drain before that start included
   * (on the median load). × fullKwh / legEff, never negative, bounded by what the window can
   * deliver on the P50 load. 0 on a hold (nothing is written). null when no P50 basis covers
   * the carry or the window, and on a null plan. DISCLOSURE ONLY: it sizes nothing, arms
   * nothing, and the de-bias never touches it. Absent on plans issued before v1.187.22.
   */
  expectedBuyKwh?: number | null;
  /** v1.187.22 — the pool SoC % expected AT THE WINDOW OPEN, when the reserve write lands: the
   *  GRID-PRESENT P50 carry from now to the window open, floored at the reserve the SHP2 holds
   *  (expectedCarryKwh); the live SoC on a mid-window recompute. Not necessarily where charging
   *  starts: above the written reserve on a force-charge night the house draws the pool down
   *  until the just-in-time start (expectedBuyFromPlan). null with no P50 basis. Not the sizing
   *  start (`projSocAtWindowStartPct`, the islanded worst case — unchanged and unclamped). */
  expectedStartSocPct?: number | null;
  /** v1.187.22 — the level that write drives the pool to, % (armedWriteLevelPct): the
   *  reserve setpoint as written, or the force-charge stop when force-charge rides the
   *  night. null on a hold and on a null plan (it does not need a P50 basis). */
  expectedWriteLevelPct?: number | null;
  /** v1.187.22 — the window cannot pass the whole expected draw on the median load
   *  (expectedBuyFromPlan's deliverableBound): the write charges TOWARD expectedWriteLevelPct and
   *  the window closes first (Friday's one-hour 23:00 window from ~48%: ~14 kWh, ~62%, not 80%).
   *  Every surface that states the level then says "toward". Absent/false otherwise. */
  expectedDeliverableBound?: boolean;
  /** v1.187.22 — when force-charge rides the night: the expected just-in-time start
   *  (expectedBuyFromPlan's forceChargeStartMs), or null when no start is expected (the pool stays
   *  at or near the stop). Absent on a reserve-only night, with no P50 basis, on a hold and on
   *  plans issued before it. Read by the supervised push, which says when force-charge is expected
   *  to switch on, and by chargeLevelPct: with no start expected the night is expected to reach the
   *  reserve, not the stop, and every line states the reserve. Disclosure only. */
  expectedForceChargeStartMs?: number | null;
  /** PREDICTION: the pack SoC % the window is expected to actually REACH by its
   *  close, given every cap — including the v1.60.0 EV-contention derate. This
   *  is the number the ledger scores (a systematic gap between this and the
   *  measured arrival is what under-buy detection is made of).
   *  v1.187.22 — on the islanded worst case the plan is SIZED on (the sizing sentence's
   *  "projecting ~X% by the window close"), not the charge the write is expected to make
   *  (expectedWriteLevelPct / expectedBuyKwh): no spoken or pushed line calls it expected.
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
   *  clampReserveTarget — the write envelope is unchanged.
   *
   *  v1.196.0 — "meets floor+cushion" is the leg's OWN arm test: the pack at the window close on
   *  the overnight islanded-outage / disabled basis (the line, asked to the whole percent above it,
   *  or the cost target where that is higher), the whole-house walk to the next recharge on the
   *  legacy-pct basis and the backup leg. A mid-day leg writes T_mid (middayReserveTargetPct). */
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
  /** v1.186.0 — the trough the CUSHION TEST was judged on, % of pool, under the
   *  resilience lift: the whole-house forward trough on the `legacy-pct` basis, the
   *  pack at window close (outage onset) on `islanded-outage` / `disabled`.
   *  `cushionShortfall` is exactly this figure against `cushionLineSocPct`, and the
   *  scorer grades the plan-trajectory verdict on it.
   *
   *  ★ NOT `minProjSocPct`. Since v1.125.0 that field is the whole-house DISCLOSURE
   *  trough, which sits at ~0% on a plant whose pool is smaller than a day of
   *  whole-house load — so grading on it scored every night whose plan held the
   *  cushion as an engine-fault strike, and held the readiness gate BLOCKED.
   *  null/absent on a null plan and on plans issued before v1.186.0. */
  cushionTroughSocPct?: number | null;
  /** v1.186.0 — the line that trough was tested against, % of pool: the reserve
   *  floor plus the cushion AS APPLIED (cushionKwh). Not reserveFloorPct +
   *  cushionPct — cushionPct is the legacy flat band, which is the applied cushion
   *  only on the `legacy-pct` basis. */
  cushionLineSocPct?: number | null;

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
  /** v1.125.0 — how cushionKwh was derived: the bounded islanded-outage energy,
   *  or the legacy flat band when no islanded-load measurement was available. */
  /** v1.125.0 — the cushion in kWh, as actually applied. */
  cushionKwh?: number;
  cushionBasis?: CushionBasis;
  /** v1.127.0 — which ceiling bound the cost-mode target. R2 — 'pv-curtail' on a mid-day leg. */
  costCeilingBasis?: CostCeilingBasis | null;
  /** v1.165.0 — the economic ceiling itself, % of pool (null in resilience mode).
   *  The night force-charge fills to this, never past it. */
  costCeilingSocPct?: number | null;
  /** v1.168.0 — the Thursday rule applied: the solar headroom was set aside. */
  longGapAhead?: boolean;
  /** v1.168.0 — the morning surplus the cost ceiling left room for (P50, else P90;
   *  null when set aside or unknown). */
  costCeilingSurplusKwh?: number | null;
  /** v1.174.0 — WHICH surplus that was: 'p50', the 'p90' stand-in, or 'none' (set aside
   *  by the long-gap rule, or no surplus known — `longGapAhead` tells them apart).
   *  v1.186.0 — 'p10': a long-gap night that kept the pessimistic pre-peak surplus.
   *  null/absent in resilience mode. */
  costCeilingSurplusBasis?: 'p10' | 'p50' | 'p90' | 'none' | null;
  /** v1.187.1 — the surplus on the forecast load as is: what costCeilingSurplusKwh was
   *  before the load de-bias (equal to it when the de-bias did not widen the headroom).
   *  null/absent in resilience mode. */
  costCeilingSurplusRawKwh?: number | null;
  /** v1.187.1 — the load factor the de-biased surplus was computed on (1 = the forecast as
   *  is) and the ledger nights behind it; null when no de-biased surplus was supplied.
   *  v1.196.0 — 1, with its nights, when only the PV term was de-biased (costSurplusPvFactor
   *  above 1): a non-null factor no longer means the load was de-biased. */
  costSurplusLoadFactor?: number | null;
  costSurplusLoadSamples?: number | null;
  /** v1.196.0 — the PV factor the de-biased surplus's P50 PV was counted at (costSurplusPvFactor:
   *  1 = the forecast as is, as when only the load term was de-biased) and the ledger nights
   *  behind it; null when no de-biased surplus was supplied, and on a long-gap night. null/absent
   *  in resilience mode. */
  costSurplusPvFactor?: number | null;
  costSurplusPvSamples?: number | null;
  /** v1.125.0 — the outage this cushion is sized to survive, hours. */
  cushionOutageHours?: number;
  /** R2 — a mid-day (super off-peak) leg only: which term of T_mid set the reserve it writes
   *  (middayReserveTargetPct). Absent on every overnight plan. */
  reserveTargetBasis?: MiddayReserveBasis;
  /** v1.198.0 — a plan sized on the PROVISIONAL solar band (fewer than 14 scored calibration
   *  days): how far its P10 PV was widened (NightChargeInputs.pvBandWiden). The rationale, the
   *  card and the evening push state it (provisionalBandText). Absent on the full basis — that
   *  plan's JSON is unchanged — on a refused plan and on a night with no window (nothing sized). */
  pvBandWiden?: PvBandWiden;
  /** A mid-day cost leg the re-entry hold held (plan §3.3): the level its write would take the pool
   *  to, and the line it had to reach (floor + MIDDAY_REENTRY_MARGIN_PCT). Absent otherwise. */
  middayReentryHold?: { arrivalPct: number; linePct: number };
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
 *  Recurrence pv − load/η, clamp [0,full] (the planner's own; see the header for
 *  how it differs from the runway's since v1.187.19). v1.194.0 — a surplus hour's net is stored
 *  at `chargeEff` (chargeLegStep; legEff), a deficit hour's taken as it is. */
function simulate(
  startPackKwh: number,
  fullKwh: number,
  hours: NightChargeHour[],
  dischargeEff: number,
  /** v1.194.0 — the charge leg a P10 PV surplus goes into the cells at (legEff). */
  chargeEff: number,
  scoreFromMs: number,
  markMs: number,
  /** R2 — an armed backup leg: entering the first hour at/after `atMs` (its window close) the
   *  pack is max(walk, minKwh). null/absent ⇒ the bare walk. */
  lift: { atMs: number; minKwh: number } | null = null,
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
  let lifted = lift == null;

  for (const h of hours) {
    if (!lifted && h.ts >= lift!.atMs) {
      packWh = Math.max(packWh, Math.min(fullWh, Math.max(0, lift!.minKwh) * 1000));
      lifted = true;
    }
    // Capture the mark level at the FIRST hour at/after markMs, BEFORE applying
    // that hour's flux — i.e. the pack level entering the mark hour.
    if (!markCaptured && h.ts >= markMs) {
      packAtMarkWh = packWh;
      markCaptured = true;
    }
    packWh = Math.max(0, Math.min(fullWh, packWh + chargeLegStep(h.pvP10W - h.loadP90W / dischargeEff, chargeEff)));
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
  basisTransient = false,
  /** v1.196.0 — which gate refused (NightChargePlan.basisBlockedBy); read only when the basis is
   *  incomplete. */
  blockedBy: string | null = null,
): NightChargePlan {
  return {
    generatedAt: inputs.nowMs,
    basisComplete,
    // v1.196.0 — only on a refused plan: a hold plan's JSON gains no key.
    ...(basisComplete ? {} : { basisBlockedBy: blockedBy }),
    basisTransient,
    buyKwhDebiased: null,
    buyDebiasFactor: inputs.buyDebiasFactor ?? 1,
    buyDebiasBasis: inputs.buyDebiasBasis ?? 'default',
    buyDebiasSamples: inputs.buyDebiasSamples ?? 0,
    expectedBuyKwh: null,
    expectedStartSocPct: null,
    expectedWriteLevelPct: null,
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
/**
 * v1.132.0 — is this hold a window that CANNOT SERVE, or a night with little to buy?
 *
 * The two look identical in the ledger and mean opposite things. The
 * discriminator is deliberately NOT `bindingCap`: `poolHeadroom` is the label on
 * both a starved window and a nearly-full pack. It is whether the deliverable
 * actually falls short of the requirement — plus `!meetable`, which is the
 * strongest "cannot serve" there is (no amount of effort holds the line) and
 * carries a placeholder requirement that would otherwise compare as covered.
 *
 * Both quantities are converted to the METER side before comparing:
 * `requiredExtraKwh` is pack-side lift, `deliverableKwh` is what the meter
 * passes. Comparing them directly would understate the shortfall by `legEff`.
 *
 * Pure + exported for testing.
 */
export function holdIsStarved(o: {
  meetable: boolean;
  requiredExtraKwh: number;
  deliverableKwh: number;
  legEff: number;
}): boolean {
  if (!o.meetable) return true;
  return o.requiredExtraKwh / o.legEff > o.deliverableKwh + 1e-6;
}

/**
 * v1.187.22 — the hour of the MEDIAN basis that covers the hour starting at `slotTs`, for the
 * expected-buy walks (expectedCarryKwh, expectedWindowLiftKwh, expectedForceChargeStart). The
 * day-ahead forecast's hours start at the NEXT hour (analytics.ts: ceil(now)), so the hour in
 * progress at `fromMs` is usually absent from the band: its remaining part is carried at the next
 * hour's figures rather than dropped (dropping it understated a 21:05 carry by ~3 kWh of median
 * drain). Any other missing hour, or one without a finite loadP50W, is no P50 basis: null.
 */
function p50HourAt(byHour: ReadonlyMap<number, NightChargeHour>, slotTs: number, fromMs: number): NightChargeHour | null {
  const h = bandHourAt(byHour, slotTs, fromMs);
  return h != null && h.loadP50W != null && Number.isFinite(h.loadP50W) ? h : null;
}
/** v1.187.22 — the band hour covering `slotTs`, the in-progress hour at `fromMs` stood in for by
 *  the next one when the band lacks it (p50HourAt). Shared with remainingEvP90, so the walk reads
 *  the load and the EV of one hour from the same entry. */
function bandHourAt(byHour: ReadonlyMap<number, NightChargeHour>, slotTs: number, fromMs: number): NightChargeHour | undefined {
  const key = Math.floor(slotTs / HOUR_MS);
  return byHour.get(key) ?? (slotTs < fromMs ? byHour.get(key + 1) : undefined);
}
function hoursByEpoch(hours: ReadonlyArray<NightChargeHour>): Map<number, NightChargeHour> {
  const m = new Map<number, NightChargeHour>();
  for (const h of hours) if (Number.isFinite(h.ts)) m.set(Math.floor(h.ts / HOUR_MS), h);
  return m;
}

/**
 * v1.187.22 — PURE. The EXPECTED pack (kWh) at `toMs`: a GRID-PRESENT carry from `fromMs` on the
 * median forecast — each hour pvP50W − loadP50W / dischargeEff (v1.194.0: a surplus stored at
 * legEff, chargeLegStep), weighted by the part of the hour
 * inside [fromMs, toMs) (the elapsed part of the current hour has already happened: the SoC now
 * reflects it; an in-progress hour missing from the band is carried at the next hour's figures,
 * p50HourAt) — clamped to [floor, full]. The floor is the reserve the SHP2 holds while the grid
 * is present (or the start, when the pool already sits under it: the carry neither drains it
 * further nor lifts it). The sizing carry (simulate) is the opposite on purpose: islanded,
 * P10 PV / P90 load with the committed P90 EV block, from the top of the hour, no floor.
 * null when an hour of the span is missing or carries no finite loadP50W (no P50 basis — no
 * expected figure).
 */
export function expectedCarryKwh(o: {
  startKwh: number;
  fullKwh: number;
  reserveKwh: number;
  dischargeEff: number;
  /** v1.194.0 — the charge leg a P50 PV surplus goes into the cells at (chargeLegStep). */
  legEff: number;
  hours: ReadonlyArray<NightChargeHour>;
  fromMs: number;
  toMs: number;
  /** R2 — an armed backup leg: the reserve it writes (kWh) holds the pool (lifting it, the grid
   *  being present) through every hour that starts before its window close `untilMs`.
   *  null/absent ⇒ the owner's reserve alone. */
  hold?: { kwh: number; untilMs: number } | null;
}): number | null {
  let pack = Math.max(0, Math.min(o.fullKwh, o.startKwh));
  const floor = Math.min(Math.max(0, o.reserveKwh), pack);
  const hold = o.hold != null && Number.isFinite(o.hold.kwh) && Number.isFinite(o.hold.untilMs) ? o.hold : null;
  const byHour = hoursByEpoch(o.hours);
  for (let slot = Math.floor(o.fromMs / HOUR_MS) * HOUR_MS; slot < o.toMs; slot += HOUR_MS) {
    const w = windowHourAvailH(slot, o.fromMs, o.toMs);
    if (w <= 0) continue;
    const h = p50HourAt(byHour, slot, o.fromMs);
    if (h == null) return null;
    const pv = h.pvP50W != null && Number.isFinite(h.pvP50W) ? h.pvP50W : h.pvP10W;
    const slotFloor = hold != null && slot < hold.untilMs ? Math.max(floor, Math.min(o.fullKwh, hold.kwh)) : floor;
    pack = Math.max(slotFloor, Math.min(o.fullKwh, pack + chargeLegStep((w * (pv - Math.max(0, h.loadP50W!) / o.dischargeEff)) / 1000, o.legEff)));
  }
  return pack;
}

/** v1.187.22 — the grid-side charge rate of one hour on the MEDIAN load (kW): the sizing's
 *  chargeRateKwAt with loadP50W in place of loadP90W. No envelope ⇒ the flat cap. */
function p50ChargeRateKw(loadW: number, chargeCapKw: number, envelopeKw: number | null): number {
  return envelopeKw == null
    ? chargeCapKw
    : Math.max(0, Math.min(chargeCapKw, envelopeKw - Math.max(0, loadW) / 1000));
}

/**
 * v1.187.22 — PURE. The pack-kWh the window can deliver on the MEDIAN load: the sizing's
 * per-hour contended rate (chargeRateKwAt) with loadP50W in place of loadP90W, × legEff × the
 * hour's remaining fraction. Bounds the expected buy on a short window (Friday's one hour) or a
 * busy grid input, as chargePowerLiftKwh bounds the worst case. null when a window hour is
 * missing or carries no finite loadP50W (the in-progress hour as in expectedCarryKwh).
 */
export function expectedWindowLiftKwh(o: {
  hours: ReadonlyArray<NightChargeHour>;
  fromMs: number;
  windowEndMs: number;
  chargeCapKw: number;
  envelopeKw: number | null;
  legEff: number;
  /** R2 — what the packs accept from PV and the grid together, kW: an hour with P50 PV passes
   *  at most this less the PV (gridGainKw). null/absent ⇒ no acceptance bound. */
  acceptKw?: number | null;
}): number | null {
  let kwh = 0;
  const byHour = hoursByEpoch(o.hours);
  for (let slot = Math.floor(o.fromMs / HOUR_MS) * HOUR_MS; slot < o.windowEndMs; slot += HOUR_MS) {
    const availH = windowHourAvailH(slot, o.fromMs, o.windowEndMs);
    if (availH <= 0) continue;
    const h = p50HourAt(byHour, slot, o.fromMs);
    if (h == null) return null;
    kwh += gridGainKw(p50ChargeRateKw(h.loadP50W!, o.chargeCapKw, o.envelopeKw) * o.legEff, p50PvW(h), o.acceptKw ?? null) * availH;
  }
  return Math.max(0, kwh);
}

/**
 * R2 — PURE. The pack-side grid gain of one charging hour, kW: `rateGainKw` (the contended charge
 * rate × legEff) and, with PV on the DC bus, no more than the packs accept beyond that PV
 * (`acceptKw` − PV). No PV, or no acceptance bound ⇒ `rateGainKw` itself, unchanged — the bound
 * every overnight hour has always had.
 */
export function gridGainKw(rateGainKw: number, pvW: number, acceptKw: number | null): number {
  return pvW > 0 && acceptKw != null ? Math.min(rateGainKw, Math.max(0, acceptKw - pvW / 1000)) : rateGainKw;
}

/** R2 — an hour's MEDIAN PV, watts, ≥ 0 (pvP10W stands in, as in expectedCarryKwh). */
function p50PvW(h: NightChargeHour): number {
  const pv = h.pvP50W != null && Number.isFinite(h.pvP50W) ? h.pvP50W : h.pvP10W;
  return Number.isFinite(pv) ? Math.max(0, pv) : 0;
}

/**
 * R2 — PURE. The share of a charge's lift the sun supplies, kWh (pack side), and when the charge
 * completes. Walked minute by minute from `fromMs` on the MEDIAN basis, the way a write charges
 * (the reserve leg below the written reserve, or the force-charge): the house on the grid, the grid
 * charging at the hour's median contended rate × legEff (gridGainKw against `acceptKw`), the P50 PV
 * going into the pack on top (v1.194.0: × legEff, through the same charge leg), until the pack has
 * gained `liftKwh` or the window closes. The grid buys
 * `liftKwh` less `creditKwh`; `doneMs` is when the lift is complete (the window close if it is not).
 *
 * `creditKwh` is 0 with no PV in the span — the figure before R2, which had the grid supply every
 * kWh of the lift — and 0 when a minute of the span has no P50 basis (the grid is then taken to
 * supply all of it: a missing forecast never shrinks the buy). `doneMs` is meaningful only with a
 * credit: with none, the planner keeps its pre-R2 timing (the reserve leg taken as instant).
 */
export function expectedPvChargeWalk(o: {
  liftKwh: number;
  hours: ReadonlyArray<NightChargeHour>;
  fromMs: number;
  windowEndMs: number;
  chargeCapKw: number;
  envelopeKw: number | null;
  legEff: number;
  acceptKw: number | null;
}): { creditKwh: number; doneMs: number } {
  if (!(o.liftKwh > 0)) return { creditKwh: 0, doneMs: o.fromMs };
  const byHour = hoursByEpoch(o.hours);
  let gained = 0;
  let credit = 0;
  let t = o.fromMs;
  for (; t < o.windowEndMs && gained < o.liftKwh; t += EXPECTED_JIT_STEP_MS) {
    const h = p50HourAt(byHour, Math.floor(t / HOUR_MS) * HOUR_MS, o.fromMs);
    if (h == null) return { creditKwh: 0, doneMs: o.fromMs };
    const dtH = Math.min(EXPECTED_JIT_STEP_MS, o.windowEndMs - t) / HOUR_MS;
    const pvW = p50PvW(h);
    const gainKw = gridGainKw(p50ChargeRateKw(h.loadP50W!, o.chargeCapKw, o.envelopeKw) * o.legEff, pvW, o.acceptKw);
    const pvStep = Math.min(chargeLegStep((pvW / 1000) * dtH, o.legEff), o.liftKwh - gained);
    const gridStep = Math.min(gainKw * dtH, o.liftKwh - gained - pvStep);
    gained += pvStep + gridStep;
    credit += pvStep;
  }
  return { creditKwh: credit, doneMs: Math.min(t, o.windowEndMs) };
}

/** v1.187.22 — the step of the just-in-time walk (expectedForceChargeStart). */
const EXPECTED_JIT_STEP_MS = 60_000;

/**
 * v1.187.22 — PURE. Where the pool is when the night's just-in-time force-charge switches on, on
 * the MEDIAN load: walked minute by minute from `fromMs` (the window open, or now mid-window) the
 * way decideForceCharge decides it each tick. While the pool sits at or above the force-charge
 * stop nothing starts; below it, the force-charge starts once the clock reaches
 * forceChargeStartAtMs(window end, the armed ceiling, the pool %, fullKwh, the rate, the EV
 * displacement) — never inside the last FORCE_CHARGE_MIN_RUN_MS. Until then the house runs from the
 * pool (pvP50W − loadP50W / dischargeEff; v1.194.0: a surplus stored at legEff), held at the written
 * reserve `reserveKwh` (the SHP2 holds
 * it with the grid present). The rate is the hour's median contended rate × legEff (what
 * forceChargeRateKw reads live: the grid cap less the house load, through the charge leg; no
 * envelope ⇒ unknown, and forceChargeStartAtMs plans with its fixed rate, as the live tick does).
 * The EV displacement is evDisplacedPackKwh of the window's remaining P90 EV (evP90W), as index.ts
 * hands the live tick from the plan's evContention; 0 when the EV prediction does not cover the
 * rest of the window.
 *
 * Returns the pack at the start and its time, or `startMs: null` with the pack at the last
 * possible start when no force-charge is expected (the pool stays at or near its stop). null
 * when a minute of the walk has no P50 basis (p50HourAt).
 */
export function expectedForceChargeStart(o: {
  /** The pack when the window's write takes effect, after the reserve leg (≥ reserveKwh). */
  startKwh: number;
  /** The WRITTEN reserve (clampReserveTarget(setpoint)) as kWh: the floor of the drain. */
  reserveKwh: number;
  fullKwh: number;
  /** The ceiling armFromPlan records (armedForceChargeCeilingPct): decideForceCharge's target. */
  ceilingPct: number;
  hours: ReadonlyArray<NightChargeHour>;
  fromMs: number;
  windowEndMs: number;
  dischargeEff: number;
  chargeCapKw: number;
  envelopeKw: number | null;
  legEff: number;
}): { packKwh: number; startMs: number | null } | null {
  const stopPct = forceChargeStopPct(o.ceilingPct);
  const byHour = hoursByEpoch(o.hours);
  let pack = Math.max(0, Math.min(o.fullKwh, o.startKwh));
  const floor = Math.min(Math.max(0, o.reserveKwh), pack);
  const lastStartMs = o.windowEndMs - FORCE_CHARGE_MIN_RUN_MS;
  for (let t = o.fromMs; t < lastStartMs; t += EXPECTED_JIT_STEP_MS) {
    const h = p50HourAt(byHour, Math.floor(t / HOUR_MS) * HOUR_MS, o.fromMs);
    if (h == null) return null;
    const loadW = Math.max(0, h.loadP50W!);
    const poolPct = (pack / o.fullKwh) * 100;
    if (poolPct < stopPct) {
      const rateKw = o.envelopeKw == null ? null : p50ChargeRateKw(loadW, o.chargeCapKw, o.envelopeKw) * o.legEff;
      const ev = remainingEvP90(byHour, t, o.windowEndMs, o.fromMs);
      const evDisplacedKwh = ev == null ? null : evDisplacedPackKwh({
        evKwh: ev.kwh, peakEvKw: ev.peakKw, rateKw,
        unboundedRateKw: o.envelopeKw == null ? null
          : Math.max(FORCE_CHARGE_MIN_RATE_KW, (o.envelopeKw - loadW / 1000) * o.legEff),
        legEff: o.legEff,
      });
      if (t >= forceChargeStartAtMs(o.windowEndMs, o.ceilingPct, poolPct, o.fullKwh, rateKw, evDisplacedKwh)) {
        return { packKwh: pack, startMs: t };
      }
    }
    const pv = h.pvP50W != null && Number.isFinite(h.pvP50W) ? h.pvP50W : h.pvP10W;
    pack = Math.max(floor, Math.min(o.fullKwh, pack + chargeLegStep(((pv - loadW / o.dischargeEff) / 1000) * (EXPECTED_JIT_STEP_MS / HOUR_MS), o.legEff)));
  }
  return { packKwh: pack, startMs: null };
}

/** v1.187.22 — the window's P90 EV energy (kWh) and peak (kW) from `fromMs` to the close, as the
 *  plan's evContention states it for a plan computed at `fromMs`; null unless every remaining
 *  hour carries a finite evP90W (a missing prediction is never a predicted 0). The hour in
 *  progress at the walk's start (`walkFromMs`) is stood in for by the next one when the band
 *  lacks it, as the load beside it is (bandHourAt): reading it directly voided the EV term for
 *  the walk's whole first part-hour while its load was carried. */
function remainingEvP90(
  byHour: ReadonlyMap<number, NightChargeHour>, fromMs: number, windowEndMs: number, walkFromMs: number,
): { kwh: number; peakKw: number } | null {
  let kwh = 0;
  let peakKw = 0;
  for (let slot = Math.floor(fromMs / HOUR_MS) * HOUR_MS; slot < windowEndMs; slot += HOUR_MS) {
    const availH = windowHourAvailH(slot, fromMs, windowEndMs);
    if (availH <= 0) continue;
    const ev = bandHourAt(byHour, slot, walkFromMs)?.evP90W;
    if (ev == null || !Number.isFinite(ev)) return null;
    kwh += (Math.max(0, ev) / 1000) * availH;
    peakKw = Math.max(peakKw, Math.max(0, ev) / 1000);
  }
  return { kwh, peakKw };
}

/** v1.187.22 — the window an armed write runs in, for the expected buy's force-charge leg. */
export interface ExpectedBuyWindow {
  /** The horizon (the walk picks the window's hours from it; p50HourAt). */
  hours: ReadonlyArray<NightChargeHour>;
  /** When the write takes effect: the window open, or now on a mid-window recompute. */
  fromMs: number;
  windowEndMs: number;
  dischargeEff: number;
  chargeCapKw: number;
  envelopeKw: number | null;
  /** R2 — what the packs accept from PV and the grid together, kW (expectedPvChargeWalk).
   *  null/absent ⇒ no acceptance bound. */
  acceptKw?: number | null;
}

/** v1.187.22 — expectedBuyFromPlan's result. */
export interface ExpectedBuy {
  buyKwh: number | null;
  /** The level the write drives the pool to (armedWriteLevelPct). */
  levelPct: number | null;
  /** When force-charge rides the night: the expected just-in-time start (null = none expected)
   *  and the pool % then. Absent on a reserve-only night and with no P50 basis. */
  forceChargeStartMs?: number | null;
  forceChargeFromPct?: number;
  /** The window cannot deliver the whole draw: the figure is what it can pass on the median load. */
  deliverableBound?: boolean;
}

/**
 * v1.187.22 — PURE. The EXPECTED meter-side buy of an armed plan: the energy its write would
 * draw into the Cores, ÷ legEff, never negative, never past what the window can deliver on the
 * median load.
 *
 * WHAT THE WRITE DOES, by where the pool opens the window (S, `startKwh`) against the written
 * reserve (R) and the force-charge stop (F, when force-charge rides the night):
 *  - The RESERVE LEG: below R the reserve charges the pool R − S at the window open and then
 *    holds the house on the grid; at or above R it charges nothing.
 *  - Reserve only: that is the whole draw — R − S, or 0 (the house draws the pool toward R).
 *  - The FORCE-CHARGE LEG (expectedForceChargeStart): from max(S, R) the house runs from the pool,
 *    held at R, until the just-in-time start, which then fills to F. Draw F − (the pool at the
 *    start): the drain before the start is bought back too. From S < R the pool sits at R and
 *    the draw is F − S in all (2026-10-12: ~46% → 50% → 80%). From S ≥ R it is more than F − S —
 *    the 2026-09-30 shape (74% at 23:00, drawn to ~55%, charged to 76%). No start expected
 *    (the pool stays at or near F) ⇒ 0.
 * The level is armedWriteLevelPct and the start's target the ceiling armFromPlan records
 * (armedForceChargeCeilingPct) — the fields the write uses; `levelPct` is returned even when the
 * buy is null (no P50 basis), because it is a fact about the write.
 *
 * kWh per percent: `fullKwh`, the planner's nameplate pool — the basis `buyKwh` is sized on, so
 * the expected and worst-case figures compare like for like and the ledger grades both against
 * `delivered_kwh` on one basis. The SoC is a share of the packs' BMS full-charge capacity (~0.944
 * of nameplate on this fleet), so a percent holds less energy than this counts; the measured
 * scale lives in the analytics worker and never reaches the planner, and the sizing basis is not
 * this disclosure's to change. The live force-charge times its start with the panel's own
 * backupFullCapWh, the same nameplate figure.
 */
export function expectedBuyFromPlan(o: {
  setpointSocPct: number | null;
  costCeilingSocPct: number | null;
  forceChargeEligible: boolean;
  /** The expected pack when the window's write takes effect (expectedCarryKwh to the window
   *  open, or the live pack mid-window). */
  startKwh: number | null;
  /** expectedWindowLiftKwh. */
  deliverableKwh: number | null;
  fullKwh: number;
  legEff: number;
  window: ExpectedBuyWindow;
}): ExpectedBuy {
  const levelPct = armedWriteLevelPct(
    { setpointSocPct: o.setpointSocPct, costCeilingSocPct: o.costCeilingSocPct }, o.forceChargeEligible,
  );
  if (levelPct == null || o.startKwh == null || o.deliverableKwh == null) return { buyKwh: null, levelPct };
  const reservePct = clampReserveTarget(o.setpointSocPct!);
  const reserveKwh = (reservePct / 100) * o.fullKwh;
  const levelKwh = (levelPct / 100) * o.fullKwh;
  // The reserve leg (the level is never below the reserve: armedWriteLevelPct).
  let liftKwh = Math.max(0, Math.min(levelKwh, reserveKwh) - o.startKwh);
  // R2 — the P50 PV that lands in the pack while the reserve leg charges is not bought, and the
  // house draws on the pool only once the leg is done (0 with no PV: the reserve leg is taken as
  // instant, as before).
  const pvWalk = (lift: number, fromMs: number) => expectedPvChargeWalk({
    liftKwh: lift, hours: o.window.hours, fromMs, windowEndMs: o.window.windowEndMs,
    chargeCapKw: o.window.chargeCapKw, envelopeKw: o.window.envelopeKw, legEff: o.legEff, acceptKw: o.window.acceptKw ?? null,
  });
  const reserveLeg = pvWalk(liftKwh, o.window.fromMs);
  liftKwh -= reserveLeg.creditKwh;
  const out: ExpectedBuy = { buyKwh: null, levelPct };
  const ceilingPct = armedForceChargeCeilingPct({ costCeilingSocPct: o.costCeilingSocPct });
  if (levelPct > reservePct && ceilingPct != null) {
    // The force-charge leg: the drain to the just-in-time start, bought back with the rest.
    const jit = expectedForceChargeStart({
      startKwh: Math.max(o.startKwh, reserveKwh), reserveKwh, fullKwh: o.fullKwh, ceilingPct,
      ...o.window, legEff: o.legEff,
      ...(reserveLeg.creditKwh > 0 ? { fromMs: reserveLeg.doneMs } : {}),
    });
    if (jit == null) return out;
    out.forceChargeStartMs = jit.startMs;
    out.forceChargeFromPct = round1((jit.packKwh / o.fullKwh) * 100);
    if (jit.startMs != null) {
      // R2 — the P50 PV that lands in the pack during the force-charge is not bought (0 with no PV).
      const fcLiftKwh = Math.max(0, levelKwh - jit.packKwh);
      liftKwh += fcLiftKwh - pvWalk(fcLiftKwh, jit.startMs).creditKwh;
    }
  }
  const deliverableKwh = Math.max(0, o.deliverableKwh);
  if (liftKwh > deliverableKwh + 1e-9) out.deliverableBound = true;
  out.buyKwh = round2(Math.min(liftKwh, deliverableKwh) / o.legEff);
  return out;
}

/*
 * v1.187.22 — WHAT A NIGHT-CHARGE LINE STATES. Anything spoken or pushed states what the write
 * will do: the level it drives the pool to (chargeLevelPct) and the energy it is expected to draw
 * (statedBuyKwh). The islanded worst case the plan is SIZED on (buyKwh) is not an outcome: it
 * belongs to the rationale and the card, in one sentence labelled as the sizing basis
 * (sizingBasisText). On 2026-10-12 the push and the speakers said "Buy ~64.2 kWh" — that basis —
 * for a write that would have drawn ≈34 kWh, and the night was cancelled on the figure.
 */

/** v1.187.22 — the level tonight's night is expected to REACH, % — the level every line states:
 *  plan.expectedWriteLevelPct (armedWriteLevelPct — the reserve as written, or the force-charge stop
 *  when force-charge rides the night), except on a force-charge night with no just-in-time start
 *  expected (expectedForceChargeStartMs === null), where the night stops at the reserve as written
 *  and the force-charge only stands by: from 40% under a 51% ceiling the write charges ~18 kWh to
 *  the 50% reserve, and every line said "to ~51%". On a plan issued before v1.187.22, the reserve
 *  as written (clampReserveTarget). null with neither (a hold, a null plan). PURE. */
export function chargeLevelPct(
  plan: Pick<NightChargePlan, 'setpointSocPct' | 'expectedWriteLevelPct' | 'expectedForceChargeStartMs'>,
): number | null {
  const reserve = chargeReservePct(plan);
  const level = plan.expectedWriteLevelPct;
  if (level == null || !Number.isFinite(level)) return reserve;
  return plan.expectedForceChargeStartMs === null && reserve != null ? reserve : level;
}

/** v1.187.22 — the window closes before the write reaches chargeLevelPct
 *  (plan.expectedDeliverableBound): the line says it charges TOWARD the level, as the rationale
 *  headline does, never "to" a level the plan itself says the night will not reach. PURE. */
export function chargeIsWindowBound(plan: Pick<NightChargePlan, 'expectedDeliverableBound'>): boolean {
  return plan.expectedDeliverableBound === true;
}

/** v1.187.22 — the ONLY buy figure a spoken or pushed line states: the expected draw of the armed
 *  write (plan.expectedBuyKwh). null — no P50 basis, or a plan issued before v1.187.22 — means
 *  the line states no energy figure at all; it never falls back to the worst case. PURE. */
export function statedBuyKwh(plan: Pick<NightChargePlan, 'expectedBuyKwh'>): number | null {
  const e = plan.expectedBuyKwh;
  return e != null && Number.isFinite(e) ? e : null;
}

/** v1.187.22 — tonight's write is expected to charge NOTHING (isNoChargeKwh on the stated figure):
 *  the pool is expected to open the window at or above the level the write drives it to — the
 *  reserve on a reserve-only night (2026-10-12's inputs at 74%: opening ~65.9% over a 50% reserve);
 *  above the reserve, with force-charge riding the night, no just-in-time start expected. The write
 *  then only holds the reserve as a floor, and every line says so — "reserve held at 50% tonight —
 *  no charge expected" — never "charging to ~50% (~0 kWh)". false with no expected figure. PURE. */
export function noChargeExpected(plan: Pick<NightChargePlan, 'expectedBuyKwh'>): boolean {
  return isNoChargeKwh(statedBuyKwh(plan));
}

/** v1.187.22 — the reserve tonight's write sets, % (clampReserveTarget of the setpoint, as
 *  armFromPlan writes it): what a night that charges nothing holds. null with no setpoint. PURE. */
export function chargeReservePct(plan: Pick<NightChargePlan, 'setpointSocPct'>): number | null {
  const setpoint = plan.setpointSocPct;
  return setpoint != null && Number.isFinite(setpoint) ? clampReserveTarget(setpoint) : null;
}

/**
 * v1.187.22 — the floor+cushion line every surface states, %: the line the plan is SIZED on — the
 * reserve floor plus the cushion as applied (`targetFloorKwh = reserveKwh + cushionKwh`, the line
 * the bisection holds the trough to, recorded as cushionLineSocPct). The hold push stated it while
 * the charge push and the card stated reserveFloorPct + cushionPct, the legacy flat band — the
 * applied cushion only on the `legacy-pct` basis (resilience with an 8 h cushion on a 1 kW island:
 * sized on 27.6%, pushed as 31%). That sum stands in only on a plan issued before v1.186.0, which
 * has no cushionLineSocPct. The card mirrors it (nightChargeText.floorCushionLinePct). null when
 * neither is finite. PURE.
 */
export function floorCushionLinePct(
  plan: Pick<NightChargePlan, 'cushionLineSocPct' | 'reserveFloorPct' | 'cushionPct'>,
): number | null {
  const line = plan.cushionLineSocPct;
  if (line != null && Number.isFinite(line)) return line;
  const legacy = plan.reserveFloorPct + plan.cushionPct;
  return Number.isFinite(legacy) ? legacy : null;
}

/** v1.187.22 — an armed night's buy inside an after-the-fact push (the morning summary, the
 *  apply-failure warning), from the expected figure the armed day's plan row holds: "~34.9 kWh
 *  expected". null with none (a row from before v1.187.22, no P50 basis, an unreadable ledger)
 *  and on a night that was expected to charge nothing (isNoChargeKwh — the push says the reserve
 *  was held, never "~0 kWh expected"): the push then states no kWh. The armed record's buyKwh is
 *  the worst case and is never pushed. */
export function armedExpectedPhrase(expectedKwh: number | null | undefined): string | null {
  return expectedKwh != null && Number.isFinite(expectedKwh) && !isNoChargeKwh(expectedKwh)
    ? `~${round1(expectedKwh)} kWh expected` : null;
}

/** v1.187.22 — what the sizing basis is, in the words the rationale and the card label it with. */
export const WORST_CASE_BASIS = 'P10 PV, P90 load including any committed EV session, no grid';

/** v1.187.22 — the ONE sentence that names the worst case, labelled as the basis the plan is sized
 *  on: "Sized on an islanded worst case (P10 PV, …, no grid) of ~64.2 kWh" + `calNote` (the de-bias
 *  disclosure, beside the figure it multiplies). The card mirrors it (sizingLine, nightChargeText.ts).
 *  null with no figure. PURE. */
export function sizingBasisText(worstKwh: number | null | undefined, calNote = ''): string | null {
  if (worstKwh == null || !Number.isFinite(worstKwh)) return null;
  return `Sized on an islanded worst case (${WORST_CASE_BASIS}) of ~${round1(worstKwh)} kWh${calNote}`;
}

/** v1.187.22 — both buy figures for a LOG line, each labelled: logs serve diagnosis, so they keep
 *  the worst case — named as the sizing basis, never as the buy. PURE. */
export function buyFiguresLogText(expectedKwh: number | null | undefined, worstKwh: number | null | undefined): string {
  const fmt = (n: number | null | undefined): string => (n != null && Number.isFinite(n) ? `~${round1(n)} kWh` : 'none');
  return `expected buy ${fmt(expectedKwh)}, islanded worst-case sizing ${fmt(worstKwh)}`;
}

export function computeNightChargePlan(inputs: NightChargeInputs): NightChargePlan {
  const plan = sizeNightChargePlan(inputs);
  // v1.198.0 — a plan sized on the PROVISIONAL band says so: the field (absent on the full basis, so
  // that plan's JSON is unchanged) and the rationale's closing sentence. Only a plan that was sized
  // — a charge or a hold (requiredExtraKwh set): a refused plan, or a night with no window, was
  // sized on nothing.
  const w = inputs.pvBandWiden;
  return w != null && plan.basisComplete && plan.requiredExtraKwh != null
    ? { ...plan, rationale: `${plan.rationale}${provisionalBandText(w)}`, pvBandWiden: { ...w } }
    : plan;
}

/** The sizing itself (computeNightChargePlan's body before v1.198.0, unchanged). */
function sizeNightChargePlan(inputs: NightChargeInputs): NightChargePlan {
  const {
    nowMs, fullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,
    legEff, dischargeEff, chargeCapKw, gridInputCapKw, window, horizon,
    morningPvSurplusP90Kwh, basisComplete, minBuyKwh,
  } = inputs;

  // ── Gates (fail-safe → null over a fabricated number) ──
  // I11 SoC coherence; I6 basis; I5 SHP2/state; and structural preconditions.
  // v1.196.0 — every refused plan carries the gate that refused it (NightChargePlan.basisBlockedBy):
  // the rationale alone reached no push. The 21:30 "no plan tonight" push states it.
  const refuse = (why: string, transient = false, tail = ''): NightChargePlan =>
    nullPlan(inputs, false, `No plan — ${why}${tail}.`, transient, why);
  if (!basisComplete) {
    // v1.148.0 — name it here too (the rationale), and v1.196.0 on the plan, where the 21:30
    // push reads it.
    const why = inputs.basisBlockedBy ? ` (${inputs.basisBlockedBy})` : '';
    return nullPlan(inputs, false, `No plan — forecast/telemetry basis incomplete${why}; nothing will be charged.`, inputs.basisTransient === true, inputs.basisBlockedBy ?? null);
  }
  if (!socCoherent) return refuse('SoC telemetry incoherent (% vs remaining/full mismatch)', true);
  if (inputs.confidenceTier === 'climatology') return refuse('horizon is climatology-only (no real forecast)', false, '; will not size a buy on a guessed sky');
  // v1.132.0 — basisComplete TRUE here: the forecast/telemetry basis is fine,
  // there is simply no cheap window tonight (Saturday has none on this tariff).
  // Reporting basisComplete:false made HA say "basis incomplete" about a healthy
  // basis, and conflated a normal windowless night with a genuine data outage.
  if (!window || !(window.endMs > window.startMs)) return nullPlan(inputs, true, 'No plan — no valid cheap charge window resolved for tonight.');
  if (!Number.isFinite(fullKwh) || fullKwh <= 0) return refuse('pool capacity unavailable', true);
  if (!Number.isFinite(socNowPct)) return refuse('current SoC unavailable', true);
  // v1.39.0 review fix: a non-finite floor/cushion made targetFloorKwh NaN,
  // every bisection comparison false, and the buy silently resolved to the FULL
  // pool headroom — a confident max-buy instead of the fail-closed null the
  // module's contract promises for degenerate inputs. Same class for the
  // efficiency/charge-cap knobs (all operator-config-sourced).
  if (!Number.isFinite(reserveFloorPct) || reserveFloorPct < 0 || !Number.isFinite(cushionPct) || cushionPct < 0)
    return refuse('reserve floor / outage cushion is not a finite non-negative number');
  if (!Number.isFinite(legEff) || legEff <= 0 || !Number.isFinite(dischargeEff) || dischargeEff <= 0 || !Number.isFinite(chargeCapKw) || chargeCapKw < 0)
    return refuse('efficiency/charge-power configuration is not a finite number');
  if (horizon.length === 0) return refuse('empty forecast horizon', true);

  // R2 — the leg (WindowSpec). Every term below that reads it is a no-op on the overnight leg.
  const spec = inputs.windowSpec;
  const midday = spec?.kind === 'super_off_peak';
  /** R4 — the outage BACKUP leg ahead of a mid-day buy: its arm test and its setpoint are ONE
   *  walk (troughAtLift below), the islanded P10 PV / P90 load walk from the window close to the
   *  caller's horizon end (nextRechargeMs: option A, the next overnight open), against reserve +
   *  cushion. Every other leg keeps the cushion test it has (the pack at the window close). */
  const backupLeg = spec?.role === 'backup';
  /** What the packs accept from PV and the grid charger together, kW (gridGainKw). The default is
   *  the grid charge rate alone — the bound when there is no PV. */
  const acceptKw = spec?.packAcceptKw != null && Number.isFinite(spec.packAcceptKw) && spec.packAcceptKw >= 0
    ? spec.packAcceptKw : chargeCapKw * legEff;
  /** An armed backup leg still ahead of (or in) its window: the islanded carry is max(walk, hold)
   *  at its close, the expected carry floored at it until then. */
  const holdLift = spec?.backupHold != null && Number.isFinite(spec.backupHold.pct) && Number.isFinite(spec.backupHold.untilMs)
    && spec.backupHold.untilMs > nowMs
    ? { atMs: spec.backupHold.untilMs, minKwh: (fullKwh * Math.max(0, Math.min(100, spec.backupHold.pct))) / 100 }
    : null;

  const fullWh = fullKwh * 1000;
  const reserveKwh = (fullKwh * reserveFloorPct) / 100;
  // v1.125.0 — the cushion is the energy to carry the ISLANDED load through a
  // bounded outage, not a flat share of pool measured against a whole-house
  // forward simulation. See outageCushionKwh for why the old form was unmeetable.
  const legacyCushionKwh = (fullKwh * cushionPct) / 100;
  const cushion = outageCushionKwh({
    islandedLoadKw: inputs.islandedLoadKw,
    outageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS,
    safetyFactor: inputs.islandedLoadSafety ?? DEFAULT_ISLANDED_LOAD_SAFETY,
    dischargeEff,
    legacyCushionKwh,
  });
  const cushionKwh = cushion.kwh;
  const cushionBasis = cushion.basis;
  const targetFloorKwh = reserveKwh + cushionKwh; // the line the pack must hold

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
  const baseline = simulate(socNowKwh, fullKwh, preHorizon, dischargeEff, legEff, windowEnd, windowEnd, holdLift);
  const packAtWindowEnd_noBuy = baseline.packAtMarkKwh;
  // v1.49.0 — pack level ENTERING the window (carry to window OPEN), the anchor
  // for the lift-aware window model below.
  const packAtWindowStartKwh = simulate(socNowKwh, fullKwh, preHorizon, dischargeEff, legEff, windowStart, windowStart, holdLift).packAtMarkKwh;

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
      dischargeEff, legEff, 0, windowStart, holdLift,
    );
    projSocAtWindowStartPct = round1((preWindow.packAtMarkKwh / fullKwh) * 100);
    preWindowMinSocPct = round1((preWindow.minPackKwh / fullKwh) * 100);
    if (preWindowMinSocPct < round1(reserveFloorPct + cushionPct)) {
      // v1.116.0 — LABEL THE BASIS. `simulate()` is deliberately grid-blind:
      // its only clamp is [0, full] (no reserve floor, no pass-through), because
      // the whole advisor sizes for the ISLANDED case — assuming the grid holds
      // until the window is precisely the assumption that fails during the
      // outage the cushion exists for. So this figure is a worst case, not a
      // prediction, and it reads alarmingly (0% is routine) with nothing saying
      // so. While the grid is present the SHP2 defends the reserve, so the pool
      // will not actually fall below `reserveFloorPct`.
      //
      // ★ DISCLOSURE ONLY. Both figures are text; neither reaches the sizing
      // anchor (packAtWindowStartKwh), and the anchor must stay unclamped —
      // measured over 2240 historical nights, clamping it buys strictly less
      // (worst −12.49 kWh) and costs 12 nights their reserve write outright.
      const gridHeldMinPct = round1(Math.max(preWindowMinSocPct, reserveFloorPct));
      const gridHeldNote = gridHeldMinPct > preWindowMinSocPct
        ? ` With the grid present the SHP2 defends the ${round1(reserveFloorPct)}% reserve, so the pool should hold ~${gridHeldMinPct}% — the ${preWindowMinSocPct}% figure is the islanded worst case this plan is sized against.`
        : '';
      preWindowNote = ` NOTE: before the charge window opens (${fmtSiteDayHm(windowStart, nowMs)}) the pack is projected to dip to ~${preWindowMinSocPct}% if islanded — a dip tonight's buy cannot prevent; the floor alarm owns that span.${gridHeldNote}`;
    }
  }
  // v1.187.22 — the EXPECTED pack when the window's write lands, for the expected-buy disclosure
  // only (expectedBuyFromPlan): the grid-present median carry to the window open, or the live pack
  // on a mid-window recompute. Nothing below sizes on it; the sizing anchor stays the
  // unclamped islanded carry above.
  const expectedStartKwh: number | null = midWindow
    ? socNowKwh
    : expectedCarryKwh({
      startKwh: socNowKwh, fullKwh, reserveKwh, dischargeEff, legEff, hours: horizon, fromMs: nowMs, toMs: windowStart,
      ...(holdLift != null ? { hold: { kwh: holdLift.minKwh, untilMs: holdLift.atMs } } : {}),
    });
  const expectedStartSocPct = expectedStartKwh == null ? null : round1((expectedStartKwh / fullKwh) * 100);

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
  // R2 — `gainKw`: the pack-side grid gain of the hour (gridGainKw): rateKw × legEff, and no more
  // than the packs accept beyond the hour's P10 PV. No PV ⇒ rateKw × legEff exactly.
  const windowRates: Array<{ hour: NightChargeHour; rateKw: number; availH: number; gainKw: number }> = [];
  // v1.169.0 — each hour gets its OWN remaining fraction (windowHourAvailH). The old
  // running countdown gave the current hour a full 1 and the partial remainder to the
  // LAST hour, so a mid-window recompute under-counted the final hour — e.g. at 02:55 an
  // EV predicted for 04:00-05:00 counted ~1/12 of its energy (review, 2026-09-18). Before
  // the window every hour is whole, so the 21:30 arming plan is unchanged.
  for (const h of windowHrs) {
    const rateKw = chargeRateKwAt(h);
    windowRates.push({ hour: h, rateKw, availH: windowHourAvailH(h.ts, effChargeStartMs, windowEnd), gainKw: gridGainKw(rateKw * legEff, h.pvP10W, acceptKw) });
  }

  // The deliverable-lift ceiling is now the SUM of the per-hour contended rates,
  // not a flat rate × hours — an hour the EV is sharing contributes only its
  // remainder. Credit is still bounded by BOTH the wall-clock remaining window
  // and the simulable window buckets (availH), so a horizon gap inside the
  // window can never bill grid energy the trajectory model cannot absorb.
  const chargePowerLiftKwh = Math.max(
    0,
    windowRates.reduce((acc, w) => acc + w.gainKw * w.availH, 0),
  );
  // The same ceiling WITHOUT contention (the pre-v1.60.0 figure). Used ONLY to
  // quantify the derate for the disclosure — never to size a buy.
  const chargePowerLiftUncontendedKwh = Math.max(0, chargeCapKw * Math.min(remainingWindowHours, windowHrs.length) * legEff);
  // R2 — the derate the EV disclosure names is the grid input's alone: the PV acceptance bound
  // (gridGainKw) is not contention, so it is measured on the contended rate without it.
  const chargeRateLiftKwh = Math.max(0, windowRates.reduce((acc, w) => acc + w.rateKw * legEff * w.availH, 0));
  const contentionDerateKwh = Math.max(0, chargePowerLiftUncontendedKwh - chargeRateLiftKwh);
  // v1.187.22 — the same window on the median load: what bounds the EXPECTED buy (disclosure only).
  // The whole horizon, not windowHrs: an in-progress hour missing from the band is carried at the
  // next hour's figures (p50HourAt), which may lie past the close.
  const expectedDeliverableKwh = expectedWindowLiftKwh({
    hours: horizon, fromMs: effChargeStartMs, windowEndMs: windowEnd, chargeCapKw, envelopeKw, legEff, acceptKw,
  });

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
    for (const { hour: h, availH, gainKw } of windowRates) {
      // Pack-kWh a FULL hour of charging would add here (0 when the house has
      // taken the whole envelope — that hour simply cannot charge). R2 — and no more than the
      // packs accept beyond the hour's PV (gridGainKw; rateKw × legEff with no PV).
      const hourLiftKwh = gainKw;
      const chargeFrac = hourLiftKwh > 0
        ? Math.max(0, Math.min(availH, remainingLift / hourLiftKwh))
        : 0;
      const gainKwh = hourLiftKwh * chargeFrac;
      remainingLift = Math.max(0, remainingLift - gainKwh);
      const pvKwh = h.pvP10W / 1000;
      const drainKwh = ((h.loadP90W / 1000) * (1 - chargeFrac)) / dischargeEff;
      // v1.194.0 — the P10 PV beyond the hour's drain reaches the cells through the charge leg
      // (chargeLegStep × legEff), as in simulate(); the grid gain is already pack-side (× legEff).
      pack = Math.max(0, Math.min(fullKwh, pack + gainKwh + chargeLegStep(pvKwh - drainKwh, legEff)));
    }
    return pack;
  };
  /** The legacy whole-house forward trough. RETAINED for disclosure only
   *  (minProjSocPct / baselineMinSocPct): it is still the honest answer to "what
   *  if the whole house ran off the pack", it is just not the cushion test. */
  const houseTroughAtLift = (lift: number): { minKwh: number; minTs: number | null } => {
    const r = simulate(packAtWindowEndWith(lift), fullKwh, postHours, dischargeEff, legEff, windowEnd, windowEnd);
    return { minKwh: r.minPackKwh, minTs: r.minTsMs };
  };

  /**
   * v1.125.0 — the CUSHION trough: a bounded outage at islanded load, starting at
   * window close. Monotone decreasing in time, so the minimum is at the end; the
   * pack level is monotone in lift, so the bisection below stays exact.
   *
   * When no islanded-load measurement is available, outageCushionKwh has already
   * fallen back to the legacy band, and this falls back to the legacy trough with
   * it — the pair must not be mixed, or a bounded drain would be tested against a
   * flat band and quietly grant a weaker guarantee than either form intends.
   */
  const troughAtLift = (lift: number): { minKwh: number; minTs: number | null } => {
    // v1.133.0 — ONLY the legacy fallback uses the whole-house trough. A
    // `disabled` cushion keeps this form: the reserve floor is still the line,
    // there is simply no margin above it.
    // R4 — and the backup leg: the walk the setpoint below is solved on (troughFromPack), so the
    // leg arms exactly when the walk it writes for dips under the line.
    // v1.196.0 — every leg's setpoint is its own arm test (setpointOnWalk, below): the walk here,
    // the pack at window close on the branch below.
    if (cushionBasis === 'legacy-pct' || backupLeg) return houseTroughAtLift(lift);
    // The pack AT OUTAGE ONSET. The outage energy itself lives in targetFloorKwh
    // (reserve + cushion), so subtracting it here too would double-count it and
    // demand twice the cushion.
    return { minKwh: packAtWindowEndWith(lift), minTs: windowEnd };
  };

  // v1.125.0 — one phrase describing what the cushion IS, so both rationales
  // below describe the test that actually ran rather than the legacy band.
  // v1.133.0 — a disabled cushion MUST announce itself. Without this branch a
  // night with no outage margin at all reads as "already covers the floor+cushion",
  // which is true of a standard that was lowered rather than met.
  const cushionDesc = cushionBasis === 'disabled'
    ? `the ${reserveFloorPct}% reserve floor alone — the outage cushion is DISABLED, so nothing is held back for an outage`
    : cushionBasis === 'islanded-outage'
      ? `the ${reserveFloorPct}% reserve floor plus ${round1(inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS)} h of islanded backup load (${round1(cushionKwh)} kWh)`
      : `the ${round1(reserveFloorPct + cushionPct)}% floor+cushion`;
  const baselineTrough = troughAtLift(0);
  // v1.125.0 — the DISCLOSED trough stays the whole-house one: "if the entire
  // house ran off the pack" is still a true and useful thing to report, it is
  // just not what the cushion is sized against any more.
  const baselineMinSocPct = round1((houseTroughAtLift(0).minKwh / fullKwh) * 100);

  // v1.174.0 — hoisted from the cost block below: the HOLD must know the objective.
  const costMode = inputs.objectiveMode === 'cost';
  // No shortfall projected → resilience needs no buy tonight.
  const baselineHolds = baselineTrough.minKwh >= targetFloorKwh - 1e-9;
  const noBuyPct = round1((packAtWindowEnd_noBuy / fullKwh) * 100);
  /** v1.174.0 — the HOLD plan (nothing bought, nothing armed), shared by the resilience
   *  early return and the cost-mode hold after the cost block. `cost` carries the
   *  ceiling a cost-mode hold was measured against, so the ledger shows it was asked. */
  const holdPlan = (
    rationale: string,
    cost?: Pick<NightChargePlan, 'costCeilingBasis' | 'costCeilingSocPct' | 'longGapAhead' | 'costCeilingSurplusKwh' | 'costCeilingSurplusBasis'
      | 'costCeilingSurplusRawKwh' | 'costSurplusLoadFactor' | 'costSurplusLoadSamples' | 'costSurplusPvFactor' | 'costSurplusPvSamples'>,
  ): NightChargePlan => ({
      ...nullPlan(inputs, true, rationale),
      objective: 'none',
      // v1.125.0 — the hold path returns nullPlan(), which has no cushion scope;
      // carry the applied cushion here too or a HOLD night reports none.
      cushionKwh: round2(cushionKwh),
      cushionBasis,
      cushionOutageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS,
      buyKwh: 0,
      buyKwhDebiased: 0,
      buyDebiasFactor: inputs.buyDebiasFactor ?? 1,
      buyDebiasBasis: inputs.buyDebiasBasis ?? 'default',
      buyDebiasSamples: inputs.buyDebiasSamples ?? 0,
      // v1.187.22 — a hold arms nothing, so the expected draw is exactly 0; the expected start
      // is still a fact about tonight and the ledger scores it.
      expectedBuyKwh: 0,
      expectedStartSocPct,
      expectedWriteLevelPct: null,
      requiredExtraKwh: 0,
      targetSocPct: round1((packAtWindowEnd_noBuy / fullKwh) * 100),
      // A hold night asks for nothing: the trough already holds the line, no
      // write arms, and setpoint == prediction (there is no gap to disclose).
      setpointSocPct: round1((packAtWindowEnd_noBuy / fullKwh) * 100),
      minProjSocPct: baselineMinSocPct,
      minProjSocTsMs: houseTroughAtLift(0).minTs,   // v1.125.0 — matches the disclosed house trough
      baselineMinSocPct,
      // v1.186.0 — nothing is bought, so the trough the cushion test judged is the
      // no-buy one (baselineHolds is that test passing).
      cushionTroughSocPct: round2((baselineTrough.minKwh / fullKwh) * 100),
      cushionLineSocPct: round2((targetFloorKwh / fullKwh) * 100),
      projSocAtWindowStartPct,
      preWindowMinSocPct,
      // Nothing was bought, but the contention basis is still a fact about
      // tonight's window and the owner-facing surfaces may show it.
      evContention,
      ...(cost ?? {}),
  });
  // ★ v1.174.0 — COST MODE IS ASKED BEFORE IT HOLDS. This early return used to run in
  // BOTH modes, ahead of the cost block, so a high-pack night (Thursday's 90% long-gap
  // ceiling included) never bought toward the cost ceiling. Resilience keeps it; cost
  // mode falls through, and holds below only if the cost target is not worth a buy.
  if (baselineHolds && !costMode) {
    return holdPlan(cushionBasis === 'legacy-pct' || backupLeg
      ? `Hold — projected overnight trough (${baselineMinSocPct}%) stays at/above ${cushionDesc}; no charge needed.${preWindowNote}`
      : `Hold — the pack at window close (${noBuyPct}%) already covers ${cushionDesc}; no charge needed. For reference, a whole-house island would trough at ~${baselineMinSocPct}%, which is not what the cushion is sized against.${preWindowNote}`);
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
  // v1.174.0 — only a COST-mode night reaches here with baselineHolds: resilience needs
  // no lift at all, so skip the bisection (it would return ~1e-13, not 0).
  const meetable = baselineHolds || troughAtLift(hiLift).minKwh >= targetFloorKwh - 1e-9;
  let requiredExtraKwh: number;
  if (baselineHolds) {
    requiredExtraKwh = 0;
  } else if (!meetable) {
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
  // Disclosure: the whole-house trough under the lift we can actually deliver.
  const houseWithBuy = houseTroughAtLift(liftKwh);
  const minProjSocPct = round1((houseWithBuy.minKwh / fullKwh) * 100);
  const cushionShortfall = minProjKwh < targetFloorKwh - 1e-6;
  // v1.186.0 — the trough and the line the test above used, carried to the ledger so
  // the scorer grades the plan on what it was SIZED against (see NightChargePlan).
  const cushionTroughSocPct = round2((minProjKwh / fullKwh) * 100);
  const cushionLineSocPct = round2((targetFloorKwh / fullKwh) * 100);
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
    // v1.127.0 — in COST mode the PV headroom is the ceiling the target is built
    // from, not a line it accidentally crossed, so crossing it here would be a
    // contradiction. costModeTargetKwh keeps the target at or under it.
    if (inputs.objectiveMode !== 'cost') bindingCap = 'overBuy';
  }

  // ── v1.127.0 — COST OBJECTIVE ─────────────────────────────────────────────
  //
  // Resilience mode has now sized `liftKwh` to hold floor+cushion. Cost mode asks
  // a different question — how much cheap energy is worth storing to displace
  // dearer energy later — and answers it by raising the target toward the
  // solar-headroom ceiling. It is bounded BELOW by the resilience answer, so the
  // safety margin can never shrink when the objective changes; the only direction
  // this moves the buy is up.
  //
  // Everything downstream is unchanged: the charge-power and pool-headroom caps
  // still bind, the cushion is still computed and disclosed, and the reserve floor
  // is still a hard minimum.
  let costCeilingBasis: CostCeilingBasis | null = null;
  /** v1.174.0 — the cost target (pack kWh at window close) and whether the charge rate,
   *  not the ceiling, bounded the buy toward it. Read by the cost-mode hold below. */
  let costTargetKwh: number | null = null;
  let costCapBound = false;
  let costCeilingSocPct: number | null = null;
  let effLiftKwh = liftKwh;
  let effTargetPackKwh = targetPackKwh;
  // v1.168.0 — the cost ceiling leaves room for the MEDIAN morning surplus (the P90
  // stands in when the median is unknown), and none at all before a long gap: with
  // no full cheap window for days, the owner's SoC ceiling is the ceiling.
  const longGap = inputs.longGapAhead === true;
  // v1.186.0 — before a long gap the ceiling keeps the PESSIMISTIC (P10) pre-peak surplus
  // instead of none: a sunny forecast leaves room for the sun, a cloudy one (P10 surplus
  // ~0) still fills to costMaxSocPct, and an unknown P10 keeps the full v1.168.0 buy.
  const longGapP10Kwh = inputs.prePeakPvSurplusP10Kwh;
  const longGapP10Known = longGapP10Kwh != null && Number.isFinite(longGapP10Kwh);
  const costSurplusKwh: number | null = longGap ? (longGapP10Known ? Math.max(0, longGapP10Kwh) : null)
    : (inputs.morningPvSurplusP50Kwh != null && Number.isFinite(inputs.morningPvSurplusP50Kwh)
      ? inputs.morningPvSurplusP50Kwh : morningPvSurplusP90Kwh);
  // v1.174.0 — the same choice, named for the ledger (costSurplusKwh alone cannot say
  // whether a 16 kWh headroom was the median or the P90 standing in).
  const costSurplusBasis: 'p10' | 'p50' | 'p90' | 'none' = longGap ? (longGapP10Known ? 'p10' : 'none')
    : inputs.morningPvSurplusP50Kwh != null && Number.isFinite(inputs.morningPvSurplusP50Kwh) ? 'p50'
      : morningPvSurplusP90Kwh != null && Number.isFinite(morningPvSurplusP90Kwh) ? 'p90'
        : 'none';
  // v1.187.1 — the headroom the ceiling actually leaves: the same surplus on the DE-BIASED
  // load (costSurplusLoadFactor) where that is wider, and never past the resilience target
  // (debiasedCostSurplusKwh). The forecast load ran above the measured load on every readable
  // ledger night of 2026-09-23..29, so the raw surplus left too little room: the 09-29 ceiling of
  // 77.7% filled the pool by 13:00 on 09-30 and ~9-12 kWh of PV was curtailed. Only the
  // 'p50' / 'p90' bases have a de-biased figure: a long-gap night ('p10' / 'none') keeps its
  // own pessimistic surplus, untouched.
  const costLoad = inputs.costSurplusLoad ?? null;
  // v1.187.1 (review) — ONLY ON A NIGHT WHOSE MODELLED LIFT HOLDS THE CUSHION LINE. The bound
  // below is targetPackKwh, the pack the modelled lift ARRIVES at. On a cushionShortfall night
  // (the charge rate, a predicted EV sharing the grid input, or a clamp cut the lift) that
  // arrival is derated below the requirement: with a 10 kW islanded load (line 73.71%), a 12 kW
  // grid input and a 40 kWh session predicted at window open, the arrival was 21.5% and the
  // de-bias moved the force-charge stop from 77.7% to 72.8% (×0.793), under the line the old
  // stop cleared. If the car never plugs in (the case the v1.60.0 setpoint exists for), the
  // force-charge runs at full rate and must not stop short of the cushion. A shortfall night
  // therefore keeps the raw surplus whole; on any other night targetPackKwh holds the line
  // (islanded basis: it IS the trough; legacy basis: its whole-house trough clears the line).
  const costHeadroomKwh: number | null = debiasedCostSurplusKwh({
    rawKwh: costSurplusKwh,
    debiasedKwh: cushionShortfall ? null
      : costSurplusBasis === 'p50' ? costLoad?.p50Kwh : costSurplusBasis === 'p90' ? costLoad?.p90Kwh : null,
    fullKwh,
    // The pack the resilience buy lifts to; with no resilience buy there is nothing for the
    // force-charge to deliver, so no bound (a hold night reports its de-biased ceiling).
    resilienceTargetKwh: liftKwh > 0 ? targetPackKwh : 0,
  });
  const costHeadroomFields = {
    costCeilingSurplusRawKwh: costSurplusKwh != null ? round2(costSurplusKwh) : null,
    costSurplusLoadFactor: costLoad != null && !longGap ? costLoad.factor : null,
    costSurplusLoadSamples: costLoad != null && !longGap ? costLoad.samples : null,
    // v1.196.0 — the PV factor beside it (absent on a CostSurplusLoad from before: the forecast as is).
    costSurplusPvFactor: costLoad != null && !longGap ? (costLoad.pvFactor ?? 1) : null,
    costSurplusPvSamples: costLoad != null && !longGap ? (costLoad.pvSamples ?? 0) : null,
  };
  if (costMode) {
    const ct = costModeTargetKwh({
      fullKwh,
      reserveKwh,
      morningPvSurplusKwh: costHeadroomKwh,
      maxSocPct: inputs.costMaxSocPct ?? DEFAULT_COST_MAX_SOC_PCT,
      resilienceTargetKwh: targetPackKwh,
      curtailFromPct: spec?.curtailFromPct,
    });
    costCeilingBasis = ct.ceilingBasis;
    costTargetKwh = ct.targetKwh;
    // v1.165.0 — exposed for the force-charge ceiling (see costCeilingKwh).
    if (fullKwh > 0) {
      costCeilingSocPct = round1((costCeilingKwh({
        fullKwh, morningPvSurplusKwh: costHeadroomKwh, maxSocPct: inputs.costMaxSocPct ?? DEFAULT_COST_MAX_SOC_PCT,
        curtailFromPct: spec?.curtailFromPct,
      }).ceilingKwh / fullKwh) * 100);
    }
    // Convert the desired pack level back into a lift, then re-apply the SAME
    // physical caps the resilience path uses. `packAtWindowEndWith` is monotone
    // in lift and already clamps to [0, full], so bisecting is exact.
    let lo = 0;
    let hi = Math.max(chargePowerLiftKwh, poolHeadroomLiftKwh);
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (packAtWindowEndWith(mid) >= ct.targetKwh) hi = mid; else lo = mid;
    }
    const wanted = Math.min(hi, chargePowerLiftKwh);
    costCapBound = chargePowerLiftKwh < hi - 1e-6;
    if (wanted > effLiftKwh) {
      effLiftKwh = wanted;
      effTargetPackKwh = packAtWindowEndWith(effLiftKwh);
      // The cost target is bounded by the same charge-rate reality as any other
      // buy; say so rather than presenting an undeliverable number.
      if (chargePowerLiftKwh < hi - 1e-6) bindingCap = evAttributable ? 'evContention' : 'chargePower';
    }
  }

  const buyKwh = effLiftKwh / legEff; // meter sees more than the pack stores
  const targetSocPct = round1((effTargetPackKwh / fullKwh) * 100);
  const chargeTonight = buyKwh >= minBuyKwh;

  // v1.174.0 — the cost-mode HOLD. Reached only in cost mode (resilience returned above):
  // floor+cushion already holds with no buy AND the cost target is not worth a buy —
  // either the pack already sits at/above tonight's ceiling, or what the window can
  // deliver toward it is under the minimum buy. Same HOLD shape as resilience (nothing
  // armed), plus the ceiling it was measured against.
  // `round2(buyKwh) > 0` as well as chargeTonight: with ARB_MIN_BUY_KWH=0 a ~1e-13 lift
  // (target at/below the no-buy pack) would otherwise announce "Buy ~0 kWh".
  if (baselineHolds && !(chargeTonight && round2(buyKwh) > 0)) {
    const atCeiling = costTargetKwh == null || costTargetKwh <= packAtWindowEnd_noBuy + 1e-6;
    const coverText = cushionBasis === 'legacy-pct'
      ? `the projected overnight trough (${baselineMinSocPct}%) stays at/above ${cushionDesc}`
      : `the pack at window close (${noBuyPct}%) already covers ${cushionDesc}`;
    return holdPlan(
      `Hold — ${coverText}, and ${atCeiling
        ? `it already sits at or above tonight's ${costCeilingSocPct ?? '—'}% cost ceiling`
        : `this window can deliver only ~${round1(buyKwh)} kWh toward tonight's ${costCeilingSocPct ?? '—'}% cost ceiling${buyKwh < minBuyKwh ? ` — under the ${round1(minBuyKwh)} kWh minimum buy` : ''}${costCapBound ? ' (the charge-rate ceiling over this window binds it)' : ''}`}; no charge needed.${preWindowNote}`,
      {
        costCeilingBasis,
        costCeilingSocPct,
        longGapAhead: longGap,
        costCeilingSurplusKwh: costHeadroomKwh != null ? round2(costHeadroomKwh) : null,
        costCeilingSurplusBasis: costSurplusBasis,
        ...costHeadroomFields,
      },
    );
  }

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
  //
  // ★★ v1.196.0 — ONE TEST: THE SETPOINT IS THE LEG'S OWN ARM TEST. The walk below (troughFromPack,
  // a whole-house P10 PV / P90 load walk from the close to the next recharge) is the arm test of the
  // legacy-pct basis and of the backup leg (troughAtLift), and T_mid's R on a mid-day leg. On the
  // overnight leg with an islanded-outage or disabled cushion the arm test is the pack AT the window
  // close against reserve + cushion (troughAtLift: the outage energy lives in the line). Solving the
  // setpoint on the walk there counted the drain twice: a whole day of whole-house drain AND the
  // outage cushion on top of it. On this plant the walk falls under the line from any start, so every
  // charge night asked ~73-100% and wrote the 50% maximum, while the plan was sized on the line
  // (31.1% on a 16% floor with 4 h × 2.62 kW × 1.25 islanded). That leg's setpoint is now the line
  // itself, asked to the whole percent above it (clampReserveTarget rounds: 28.07% must not write
  // 28), and in cost mode the cost target where that is higher — the target, never the derated
  // arrival, as the v1.60.0 note above requires.
  const setpointOnWalk = midday || backupLeg || cushionBasis === 'legacy-pct';
  const troughFromPack = (p: number): number =>
    simulate(p, fullKwh, postHours, dischargeEff, legEff, windowEnd, windowEnd).minPackKwh;
  let requiredPackAtWindowEndKwh: number;
  if (baselineHolds && !midday) {
    // v1.174.0 — an economic-only night (cost mode; floor+cushion holds with no buy): the
    // ask is the COST TARGET. The whole-house trough below would demand ~100% (clamped to
    // a 50% write) — above a sub-50% ceiling, and labelled a resilience need there is not.
    // R2 — a mid-day leg asks the resilience question whatever cost mode says: its reserve
    // write (T_mid) carries the resilience lift, and the force-charge only the cost fill.
    requiredPackAtWindowEndKwh = Math.max(packAtWindowEnd_noBuy, costTargetKwh ?? packAtWindowEnd_noBuy);
  } else if (!setpointOnWalk) {
    // v1.196.0 — the pack at the window close the arm test asks for: the line, or in cost mode the
    // cost target where that is higher (as on an economic-only night above).
    requiredPackAtWindowEndKwh = Math.min(fullKwh, Math.max(targetFloorKwh, costMode ? (costTargetKwh ?? 0) : 0));
  } else if (troughFromPack(fullKwh) < targetFloorKwh - 1e-9) {
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
  // R2 — a mid-day leg writes T_mid (middayReserveTargetPct): R is the resilience setpoint above,
  // over [window close, next chargeable open). The force-charge, not the reserve, carries the
  // cost fill to the ceiling, so the arrival does not bound it.
  const middayReserve = midday
    ? middayReserveTargetPct({
      floorPct: reserveFloorPct,
      linePct: (targetFloorKwh / fullKwh) * 100,
      expectedPoolPct: expectedStartSocPct,
      resiliencePct: (requiredPackAtWindowEndKwh / fullKwh) * 100,
    })
    : null;
  // The setpoint can never sit BELOW the arrival we already predict — that
  // would be strictly worse than the pre-v1.60.0 write and would cap a charge
  // the window can demonstrably deliver. (Only bisection tolerance can put them
  // out of order; the guard makes the ordering structural.)
  // v1.196.0 — on the pack-at-close leg the line is asked to the whole percent ABOVE it: the
  // actuator writes Math.round (clampReserveTarget), and a write under the line is a write the
  // plan was not sized on. 0 elsewhere (the walk and the cost-only ask keep their own figure).
  // The line is the arm test's, on the planner's nameplate fullKwh; the pool percent the panel
  // holds is a share of the packs' measured capacity (~0.944 of nameplate on this fleet), so the
  // written percent holds about that share of the counted cushion above the floor, beside the Core
  // standby the cushion leaves out (header). The measured basis is kept out of the planner
  // (runwayBasisContracts.test.ts, SCOPE): this ask is on the basis the plan is sized on.
  const lineAskPct = !setpointOnWalk && !baselineHolds
    ? Math.min(100, Math.ceil((targetFloorKwh / fullKwh) * 100 - 1e-9)) : 0;
  const setpointSocPct = middayReserve != null ? middayReserve.pct : Math.max(
    targetSocPct,
    round1((requiredPackAtWindowEndKwh / fullKwh) * 100),
    lineAskPct,
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
  // v1.133.1 — ANNOUNCE THE NUMBER THAT IS ACTUALLY WRITTEN.
  //
  // This said "The reserve is set to ${setpointSocPct}%" using the UN-CLAMPED
  // setpoint. The actuator writes clampReserveTarget(setpointSocPct), which the
  // device accepts only in [10, 50] — so on 2026-09-06 the live plan announced
  // "the reserve is set to 100%" (in the 21:30 notification AND the spoken
  // broadcast) while the panel was being told 50. The sentence was describing an
  // internal quantity as though it were the instruction.
  //
  // Three numbers now, each named for what it is: what the device is TOLD, what
  // the resilience requirement ASKED for when the envelope truncated it, and
  // what the window is expected to REACH.
  const writtenPct = clampReserveTarget(setpointSocPct);
  // v1.196.0 — only the envelope truncates. The write is a whole percent: a 40.3% cost target is
  // written as 40, which is not "the panel only accepts a backup reserve up to 50%" (the words this
  // compared `writtenPct` against said so for any ask with a fraction).
  const truncated = setpointSocPct > RESERVE_WRITE_MAX_PCT + 0.05;
  // v1.196.0 — on the pack-at-close leg a cost night's setpoint is the cost target wherever that
  // is above the line's ask: named as what it is, not as a resilience need.
  const askIsCost = baselineHolds || (!setpointOnWalk && costMode && costTargetKwh != null
    && round1((costTargetKwh / fullKwh) * 100) > lineAskPct);
  const askName = askIsCost ? "tonight's cost target" : 'the resilience requirement';
  // v1.187.22 — the third quantity ("the window is only expected to reach ~X%") was the
  // islanded worst case's arrival, already stated once as such by the sizing sentence just
  // before; called "expected" it contradicted the Expected: sentence (~5 kWh to 50%, then
  // "only expected to reach ~27.5%"). The written reserve and the ask remain.
  const setpointNote = setpointSocPct > targetSocPct + 0.05
    ? ` The reserve is set to ${writtenPct}%${truncated ? ` — ${askName} asks for ${setpointSocPct}%, but the panel only accepts a backup reserve up to ${RESERVE_WRITE_MAX_PCT}%` : ` (${askName})`}.`
    : '';

  // v1.112.0 — the ANNOUNCED buy carries the learned de-bias; the raw figure
  // stays on buyKwh (ledger + learner input) and still owns chargeTonight.
  const buyDebiasFactor = inputs.buyDebiasFactor ?? 1;
  const buyKwhDebiased = round2(buyKwh * buyDebiasFactor);
  const calNote = buyDebiasFactor > 1.005 ? ` (raw estimate ${round1(buyKwh)} kWh × ${buyDebiasFactor.toFixed(2)} realized-buy calibration)` : '';
  // v1.187.22 — the EXPECTED buy beside the worst case (NightChargePlan.expectedBuyKwh): what
  // the write armFromPlan arms from this plan would draw. A night that does not arm (under the
  // minimum buy, below) writes nothing, so its expected draw is 0.
  const expected: ExpectedBuy = chargeTonight
    ? expectedBuyFromPlan({
      setpointSocPct, costCeilingSocPct, forceChargeEligible: inputs.forceChargeEligible === true,
      startKwh: expectedStartKwh, deliverableKwh: expectedDeliverableKwh, fullKwh, legEff,
      window: { hours: horizon, fromMs: effChargeStartMs, windowEndMs: windowEnd, dischargeEff, chargeCapKw, envelopeKw, acceptKw },
    })
    : { buyKwh: 0, levelPct: null };
  // R2 — THE RE-ENTRY HOLD (plan §3.3), a mid-day cost leg only (middayReentryLinePct): a write whose
  // level is under floor + 25 leaves the pool, at the restore, where the panel holds it instead of
  // discharging, and the grid carries the house into on-peak. Such a leg holds.
  if (midday && !backupLeg && chargeTonight) {
    const arrivalPct = expected.levelPct;
    const linePct = middayReentryLinePct(arrivalPct, reserveFloorPct);
    if (arrivalPct != null && linePct != null) {
      return {
        ...holdPlan(
          `Hold — the mid-day charge's write takes the pool only to ~${round1(arrivalPct)}%, under the ${linePct}% re-entry line `
          + `(the ${round1(reserveFloorPct)}% reserve + ${MIDDAY_REENTRY_MARGIN_PCT}): after the restore the panel resumes discharging only `
          + 'once the pool is about 20 points above the reserve, so below the line it would hold the pool and buy from the grid into on-peak.'
          + `${preWindowNote}`,
          costMode ? {
            costCeilingBasis, costCeilingSocPct, longGapAhead: longGap,
            costCeilingSurplusKwh: costHeadroomKwh != null ? round2(costHeadroomKwh) : null,
            costCeilingSurplusBasis: costSurplusBasis, ...costHeadroomFields,
          } : undefined,
        ),
        middayReentryHold: { arrivalPct: round1(arrivalPct), linePct },
      };
    }
  }
  // v1.187.22 — the headline is the CHARGE the write arms: the level it drives the pool to, the
  // window, the expected draw (no kWh with no P50 basis). The worst case follows once, in its own
  // sentence labelled as the sizing basis (sizingNote), the de-bias disclosure beside it.
  // A night expected to charge nothing (isNoChargeKwh) is headlined as the reserve it holds, not
  // as a charge of ~0 kWh to a level the pool already sits above. The level is the one the night is
  // expected to reach (chargeLevelPct): the reserve when no force-charge start is expected.
  const windowText = `${fmtSiteDayHm(windowStart, nowMs)}–${fmtSiteDayHm(windowEnd, nowMs)} window`;
  const headlineLevelPct = chargeLevelPct({
    setpointSocPct, expectedWriteLevelPct: expected.levelPct, expectedForceChargeStartMs: expected.forceChargeStartMs,
  }) ?? writtenPct;
  const chargeHeadline = isNoChargeKwh(expected.buyKwh)
    ? `Hold the reserve at ${writtenPct}% in the ${windowText}: no charge expected.`
    : `Charge ${expected.deliverableBound ? 'toward' : 'to'} ~${headlineLevelPct}% in the ${windowText}`
      + `${expected.buyKwh == null ? '' : `: ~${round1(expected.buyKwh)} kWh expected`}.`;
  const sizingNote = ` ${sizingBasisText(buyKwhDebiased, calNote)}${projSocAtWindowStartPct != null
    ? `, from ~${projSocAtWindowStartPct}% at the window open` : ''}, projecting ~${targetSocPct}% by ${fmtLocalHint(windowEnd)}.`;
  // What the write does from the expected start (expectedBuyFromPlan): the reserve leg, then — when
  // force-charge rides the night — the house's drain to the just-in-time start and the fill to the stop.
  const expectedWriteNote = (start: number, level: number): string => {
    const to = expected.deliverableBound ? `toward ${level}%` : `to ${level}%`;
    const asFar = expected.deliverableBound ? ', as far as the window can deliver' : '';
    if (level <= writtenPct) {
      return start < level
        ? `, and tonight's write charges it ${to}${asFar}`
        : `, already at or above the ${level}% tonight's write charges to`;
    }
    const fcAt = expected.forceChargeStartMs;
    if (fcAt === undefined) return `, and tonight's write charges it ${to}${asFar}`;
    if (fcAt === null) {
      return `${start < writtenPct ? `, and tonight's write charges it to the ${writtenPct}% reserve` : `, above the ${writtenPct}% reserve`}; the just-in-time force-charge to ${level}% is not expected to start`;
    }
    const at = fmtSiteDayHm(fcAt, nowMs);
    if (start < writtenPct) return `, and tonight's write charges it ${to} (the ${writtenPct}% reserve, then force-charge from ~${at})${asFar}`;
    return fcAt <= effChargeStartMs
      ? `, above the ${writtenPct}% reserve; the force-charge is due at once (~${at}) and charges it ${to}${asFar}`
      : `, above the ${writtenPct}% reserve: the house should draw it to ~${expected.forceChargeFromPct}% before the just-in-time force-charge (~${at}) charges it ${to}${asFar}`;
  };
  const expectedNote = expected.buyKwh != null && expected.levelPct != null && expectedStartSocPct != null
    ? ` Expected: ${midWindow
      ? `the pool is at ~${expectedStartSocPct}% now`
      : `the pool should open the window near ~${expectedStartSocPct}% with the grid present (median load and PV, never below the ${round1(reserveFloorPct)}% reserve)`}${expectedWriteNote(expectedStartSocPct, expected.levelPct)}.`
    : '';
  // v1.132.0 — SAY WHICH HOLD THIS IS.
  //
  // This branch used to print `buyKwh` labelled "the projected shortfall". It is
  // not the shortfall: it is the DELIVERABLE — the meter-side energy this window
  // can actually pass after the charge-rate and contention caps. On 2026-09-04 a
  // Friday 1-hour window produced a ~0 kWh deliverable against a whole-pool
  // requirement, and the ledger row read as a tidy "no meaningful charge" — the
  // exact opposite of what happened. The two holds have opposite meanings and an
  // operator must be able to tell them apart:
  //   - a cap bound the buy  ⇒ the window CANNOT serve the need
  //   - no cap bound it      ⇒ the need is genuinely small
  // The discriminator is NOT which cap is labelled — `poolHeadroom` binds both a
  // starved window AND a nearly-full pack, which are opposite situations. It is
  // whether the deliverable actually falls short of the requirement.
  const starved = holdIsStarved({ meetable, requiredExtraKwh, deliverableKwh: buyKwh, legEff });
  const holdCapName =
    bindingCap === 'evContention' ? ' because EV charging contention binds it'
    : bindingCap === 'chargePower' ? ' because the charge-rate ceiling over this window binds it'
    : bindingCap === 'poolHeadroom' ? ' because available pool headroom binds it'
    : '';
  // v1.186.0 — a long-gap night either keeps the pessimistic pre-peak surplus or, with no
  // P10 known, sets the headroom aside; the rationale says which.
  const longGapNote = costSurplusBasis === 'p10'
    ? ` (no full-length cheap window for more than a day after this one, so only the pessimistic (P10) solar surplus before the evening peak, ~${round1(costSurplusKwh ?? 0)} kWh, is left as headroom)`
    : ' (no full-length cheap window for more than a day after this one, so the morning-solar headroom is set aside)';
  // v1.187.1 — when the de-biased load set the headroom, the rationale says so and gives the
  // figure the forecast load alone would have left.
  // v1.196.0 — and the de-biased sun, each term named only where it moved the surplus.
  const debiasTerms = costLoad == null ? [] : [
    ...(costLoad.factor < 1 ? [`the house load at ×${costLoad.factor} of its forecast from ${costLoad.samples} realized nights`] : []),
    ...((costLoad.pvFactor ?? 1) > 1 ? [`the median sun at ×${costLoad.pvFactor} of its forecast from ${costLoad.pvSamples ?? 0} realized nights`] : []),
  ];
  const headroomNote = costLoad != null && debiasTerms.length > 0 && costHeadroomKwh != null && costSurplusKwh != null
    && costHeadroomKwh > costSurplusKwh + 0.005
    ? ` (~${round1(costHeadroomKwh)} kWh, counting ${debiasTerms.join(' and ')}; ~${round1(costSurplusKwh)} kWh on the forecast as is)`
    : '';
  const holdReason = starved
    ? `this window can deliver only ~${round1(buyKwh)} kWh, under the ${round1(minBuyKwh)} kWh minimum-buy threshold${holdCapName} — against a requirement of ${meetable ? `~${round1(requiredExtraKwh)} kWh` : 'more than the pool can hold'}. The window cannot serve the need; this is not a night with little worth buying.`
    : `the buy this window would make (~${round1(buyKwh)} kWh) is under the ${round1(minBuyKwh)} kWh minimum-buy threshold — the projected need is genuinely small.`;
  const rationale = chargeTonight
    ? `${chargeHeadline}${expectedNote}${sizingNote}${setpointNote} ${costMode ? `Objective: COST — buying cheap ${midday ? 'super off-peak' : 'overnight'} energy to displace dearer grid energy later, up to the ${costCeilingBasis === 'pv-headroom' ? `morning-solar headroom${headroomNote}` : costCeilingBasis === 'pv-curtail' ? `solar headroom under the ${round1(spec?.curtailFromPct ?? 0)}% charge taper${headroomNote}` : `${inputs.costMaxSocPct ?? DEFAULT_COST_MAX_SOC_PCT}% state-of-charge ceiling`}${longGap ? longGapNote : ''}. ` : ''}The cushion is ${cushionDesc}; without the buy a whole-house island would trough at ~${baselineMinSocPct}%.${baselineHolds ? ` Resilience needs no buy tonight — the pack at window close (${noBuyPct}%) already covers the cushion; this buy is economic only.` : ''}${cushionShortfall ? ' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.' : ''}${bindingCap === 'overBuy' ? ' NOTE: buy exceeds morning-PV headroom; a small clip is accepted to hold resilience.' : ''}${evNote}${preWindowNote}`
    : `Hold — ${holdReason}${cushionShortfall ? ' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.' : ''}${evNote}${preWindowNote}`;

  return {
    generatedAt: nowMs,
    basisComplete: true,
    objective: chargeTonight ? (costMode ? 'cost_arbitrage' : 'resilience_cushion') : 'none',
    chargeTonight,
    buyKwh: round2(buyKwh),
    buyKwhDebiased,
    buyDebiasFactor,
    buyDebiasBasis: inputs.buyDebiasBasis ?? 'default',
    buyDebiasSamples: inputs.buyDebiasSamples ?? 0,
    expectedBuyKwh: expected.buyKwh,
    expectedStartSocPct,
    expectedWriteLevelPct: expected.levelPct,
    expectedDeliverableBound: expected.deliverableBound === true,
    ...(expected.forceChargeStartMs !== undefined ? { expectedForceChargeStartMs: expected.forceChargeStartMs } : {}),
    targetSocPct,
    setpointSocPct,
    requiredExtraKwh: round2(requiredExtraKwh),
    bindingCap,
    cushionShortfall,
    evContention,
    minProjSocPct,
    minProjSocTsMs: houseWithBuy.minTs,   // v1.125.0 — matches the disclosed house trough
    baselineMinSocPct,
    cushionTroughSocPct,
    cushionLineSocPct,
    projSocAtWindowStartPct,
    preWindowMinSocPct,
    confidenceTier: inputs.confidenceTier,
    window,
    reserveFloorPct,
    cushionPct,
    cushionKwh: round2(cushionKwh),
    /** v1.127.0 — which ceiling bound the cost-mode target (null in resilience mode). */
    costCeilingBasis,
    costCeilingSocPct,
    longGapAhead: costMode ? longGap : undefined,
    costCeilingSurplusKwh: costMode ? (costHeadroomKwh != null ? round2(costHeadroomKwh) : null) : undefined,
    costCeilingSurplusBasis: costMode ? costSurplusBasis : undefined,
    ...(costMode ? costHeadroomFields : {}),
    // v1.125.0 — how the cushion was derived, so a reader can tell a bounded
    // islanded-outage requirement from the legacy flat band at a glance.
    cushionBasis,
    cushionOutageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS,
    // R2 — a mid-day leg only: which term set its reserve write (middayReserveTargetPct).
    ...(middayReserve != null ? { reserveTargetBasis: middayReserve.basis } : {}),
    rationale,
  };
}

/**
 * R2 — the re-entry margin (plan §3.3). After the pool stops at its reserve the panel resumes
 * discharging only once it has climbed back roughly 20 points above it (measured 2026-09-13/14/27/28:
 * 36–38% against a 16% reserve; peakGridDraw.ts, the idle-pool notice). A mid-day charge restores
 * the reserve at 15:00, an hour before on-peak: a pool that ends the window under floor + this
 * margin sits in that band, the panel holds it, and the grid carries the house through on-peak.
 * 25 points is the measured 20 and 5 of margin. Whether the re-entry is measured from the restored
 * reserve or from the stop point is what the attended test before the switch measures.
 */
export const MIDDAY_REENTRY_MARGIN_PCT = 25;

/**
 * R2 — the re-entry hold's test (plan §3.3). PURE. The figure is the level a mid-day cost leg's write
 * drives the pool to (expectedBuyFromPlan's levelPct, armedWriteLevelPct: the reserve T_mid, or the
 * force-charge stop when force-charge rides the leg) — a fact about the write, known with or without
 * a P50 basis. A window that cannot deliver all of it ends below it, and the window's PV beyond the
 * write is not counted: a level under the line cannot be lifted over it by the write. Returns the
 * line (floor + MIDDAY_REENTRY_MARGIN_PCT) when the level is under it — the leg holds — else null.
 */
export function middayReentryLinePct(levelPct: number | null, floorPct: number): number | null {
  if (levelPct == null || !Number.isFinite(levelPct) || !Number.isFinite(floorPct)) return null;
  const linePct = round1(floorPct + MIDDAY_REENTRY_MARGIN_PCT);
  return levelPct < linePct ? linePct : null;
}

/** R2 — which term of T_mid set a mid-day leg's reserve write (middayReserveTargetPct). */
export type MiddayReserveBasis = 'floor' | 'line' | 'pool' | 'resilience';

/**
 * R2 — PURE. T_mid, the reserve a mid-day (super off-peak) cost leg writes at its window open, %:
 *
 *     clampReserveTarget(max(floor + 1, ⌈line⌉, ⌊expected pool⌋ − 2, ⌈R⌉))
 *
 *  - floor + 1: a raise over the owner's floor — the write is a write;
 *  - ⌈line⌉: the floor + cushion line the plan is sized on (cushionLineSocPct);
 *  - ⌊expected pool⌋ − 2: the pool held about where the window finds it (expectedStartSocPct), so
 *    the house runs on the cheap grid through the window rather than drawing the pool down for the
 *    force-charge to buy back;
 *  - ⌈R⌉: the resilience setpoint — the pack at the window close whose islanded P10/P90 trough
 *    holds the line until the next chargeable window opens (troughFromPack). The reserve write
 *    carries the resilience lift, as the overnight write does; the force-charge carries only the
 *    cost fill. R is usually above 50 (the line plus about 8 h of P90 drain), so T_mid is usually 50.
 * Clamped to the reserve write envelope [10, 50]. A term with no figure drops out (no P50 basis ⇒
 * no pool term). `basis` names the largest term (the first, in the order above, on a tie).
 */
export function middayReserveTargetPct(o: {
  floorPct: number;
  linePct: number;
  expectedPoolPct: number | null;
  resiliencePct: number | null;
}): { pct: number; basis: MiddayReserveBasis } {
  const terms: Array<[MiddayReserveBasis, number]> = [
    ['floor', o.floorPct + 1],
    ['line', Math.ceil(o.linePct)],
  ];
  if (o.expectedPoolPct != null && Number.isFinite(o.expectedPoolPct)) terms.push(['pool', Math.floor(o.expectedPoolPct) - 2]);
  if (o.resiliencePct != null && Number.isFinite(o.resiliencePct)) terms.push(['resilience', Math.ceil(o.resiliencePct)]);
  let best = terms[0];
  for (const t of terms) if (Number.isFinite(t[1]) && (!Number.isFinite(best[1]) || t[1] > best[1])) best = t;
  return { pct: clampReserveTarget(best[1]), basis: best[0] };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : null;
}
/** Hour-of-day hint for the rationale string (no TZ math — display only; the
 *  window bounds are already resolved in the site zone upstream). */
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

/** v1.39.0 (§4 display honesty): "HH:MM" for instants within the next 24 h, "EEE HH:MM" (e.g.
 *  "Mon 00:00") beyond — a Saturday-evening plan resolving Monday's window must not present it as
 *  tonight's. The delivery surfaces (MQTT state / TUI / notify) read the same formatter so they agree.
 *  v1.191.0 (T5) — the formatter is siteTime.ts fmtSiteDayHm (the site zone, never the host clock);
 *  this name stays as a deprecated alias for its existing importers (notify.ts, the TUI). */
export { fmtSiteDayHm as fmtPhoenixDayHm } from './siteTime.js';

/**
 * Flat fields published into the MQTT state payload + /api/ha-state so the
 * owner's HA automation can gate on the recommendation (advisory actuation
 * model). 12 h staleness guard (design §4.1): numeric fields are null unless the
 * plan is fresh AND its basis is complete; charge_tonight is STRICTLY false
 * unless fresh && plan.chargeTonight (never null-as-true). window_start/_end are
 * "HH:MM" in the site zone from plan.window, null when there is no window.
 */
export function nightChargeStateFields(
  plan: NightChargePlan | null,
  nowMs: number = Date.now(),
): {
  night_charge_target_soc_percent: number | null;
  night_charge_expected_soc_percent: number | null;
  night_charge_buy_kwh: number | null;
  night_charge_expected_buy_kwh: number | null;
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
    // v1.187.22 — that arrival is the islanded worst case's (NightChargePlan.targetSocPct); the
    // entity keeps its key and value and is named for it ("Arrival SoC (Worst Case)").
    night_charge_expected_soc_percent: fresh ? plan!.targetSocPct : null,
    // The worst case the plan is SIZED on, unchanged in meaning (history and automations read it).
    night_charge_buy_kwh: fresh ? plan!.buyKwh : null,
    // v1.187.22 — the EXPECTED draw beside it (NightChargePlan.expectedBuyKwh); null with no P50
    // basis and on a plan issued before v1.187.22.
    night_charge_expected_buy_kwh: fresh ? (plan!.expectedBuyKwh ?? null) : null,
    // Window is informational (the automation gates on availability+charge_tonight
    // AND honors this window). Surfaced from plan.window whenever present; null on
    // no window / null plan. HA expire_after (§I12) covers the dead-advisor case.
    // v1.39.0: day-qualified beyond 24 h ("Mon 00:00") — a weekend plan resolving
    // Monday's window must not present a date-less HH:MM as tonight's window.
    night_charge_window_start: win ? fmtSiteDayHm(win.startMs, nowMs) : null,
    night_charge_window_end: win ? fmtSiteDayHm(win.endMs, nowMs) : null,
    charge_tonight: fresh ? plan!.chargeTonight === true : false,
  };
}

/**
 * R4 (v1.189.0) — `ecoflow_night_charge_role`: what tonight's overnight window is for in the charge
 * cycle the add-on runs. 'cost' — it carries the cost buy (today's cycle, and every cycle until the
 * mid-day switch); 'backup' — it is the outage backup ahead of a mid-day charge. The night-charge
 * entities (nightChargeStateFields) stay bound to the overnight leg, so an automation on them reads
 * this beside them. null (HA 'unknown') under the same freshness rule as those entities: no fresh
 * plan with a window. `role` is the live leg's; nothing passes 'backup' before the switch — a mid-day
 * cycle computed in shadow (middayShadow.ts) never reaches it. PURE.
 */
export function nightChargeRoleFields(
  plan: Pick<NightChargePlan, 'basisComplete' | 'generatedAt' | 'window'> | null,
  nowMs: number = Date.now(),
  role: ChargeLegRole = 'cost',
): { night_charge_role: ChargeLegRole | null } {
  const fresh = !!plan && plan.basisComplete && nowMs - plan.generatedAt < PLAN_STALENESS_MS;
  return {
    night_charge_role: fresh && plan!.window != null ? role : null,
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
  /** v1.187.22 — the MEDIAN load (forecastLoadW, no P90 factor, its expected-value EV kept) and
   *  PV, watts: copied onto the planner hour for the expected-buy disclosure only. Never
   *  de-duped or replaced by the committed P90 EV block. */
  loadP50W?: number | null;
  pvP50W?: number | null;
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
  /** R2 — the leg this plan sizes, forwarded to the inputs (see WindowSpec). Absent ⇒ the
   *  overnight cost leg, exactly as before. */
  windowSpec?: WindowSpec;
  /** v1.125.0 — observed ISLANDED load (the SHP2's backup circuits), kW. */
  islandedLoadKw?: number | null;
  /** v1.125.0 — bounded outage the cushion must survive, hours. */
  outageCushionHours?: number;
  /** v1.125.0 — multiplier on the observed islanded load. Higher = stricter. */
  islandedLoadSafety?: number;
  /** v1.127.0 — buy sizing objective; cost mode is bounded below by resilience. */
  objectiveMode?: 'resilience' | 'cost';
  /** v1.127.0 — hard SoC ceiling for cost mode when no PV surplus is known. */
  costMaxSocPct?: number;
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
  // the id of the tariff's cheap period (tariff.ts cheapPeriodIdOf: the APS preset's OVERNIGHT
  // 23:00–05:00 period; a custom plan's `cheap` one). null — the plan has none — resolves no
  // window (a null plan). No tariff import here.
  periodIdAt: (tsMs: number) => string;
  cheapPeriodId: string | null;
  /** v1.191.0 (review) — the night a window is bounded to (chargeWindows.ts cheapNightOf): one
   *  night of a run longer than a night (a weekend of off-peak). null/absent — the APS preset — as before. */
  cheapNight?: CheapNight | null;
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
  /** v1.198.0 — the fewest scored calibration days a PROVISIONAL plan is sized on (index.ts: 4).
   *  From here to minCalScoredDays the basis is admitted on a widened solar band
   *  (PROVISIONAL_BAND_WIDEN); from minCalScoredDays on, the band as published. Absent (every
   *  caller before v1.198.0) or non-finite ⇒ minCalScoredDays: no provisional range, the gate as
   *  before. */
  provisionalMinCalScoredDays?: number;
  bandCoverageFrac: number;

  morningPvSurplusP90Kwh: number | null;
  /** v1.168.0 — forwarded verbatim (see NightChargeInputs). */
  morningPvSurplusP50Kwh?: number | null;
  longGapAhead?: boolean;
  /** v1.186.0 — forwarded verbatim (see NightChargeInputs). v1.198.0 — on the full basis; a
   *  provisional basis sums it again over `prePeakSurplusBasis` on the widened P10. */
  prePeakPvSurplusP10Kwh?: number | null;
  /** v1.198.0 — the hours, span and on-peak test `prePeakPvSurplusP10Kwh` was summed over
   *  (pessimisticPrePeakSurplus), each hour with its P50. Read ONLY on a provisional basis, where
   *  the surplus is summed again on the widened P10 (provisionalP10W); absent there, the headroom
   *  is set aside (null: the full long-gap buy). index.ts passes it whenever it passes the surplus. */
  prePeakSurplusBasis?: {
    hours: ReadonlyArray<{ ts: number; p10W: number; p50W?: number | null; loadW: number }>;
    windowEndMs: number;
    isOnPeakAt: (tsMs: number) => boolean;
  } | null;
  /** v1.187.1 — forwarded verbatim (see NightChargeInputs). */
  costSurplusLoad?: CostSurplusLoad | null;
  minBuyKwh: number;
  /** v1.112.0 — learned buy de-bias, forwarded verbatim to the inputs. */
  buyDebiasFactor?: number;
  buyDebiasBasis?: 'measured' | 'default';
  buyDebiasSamples?: number;
  /** v1.187.22 — forwarded verbatim (see NightChargeInputs). */
  forceChargeEligible?: boolean;
}

/** v1.169.0 — PURE. The fraction of the window hour starting at `hourTs` that is still
 *  ahead: from max(hour start, `fromMs`) to min(hour end, `windowEndMs`), clamped to [0, 1]. */
export function windowHourAvailH(hourTs: number, fromMs: number, windowEndMs: number): number {
  const a = Math.max(hourTs, fromMs);
  const b = Math.min(hourTs + HOUR_MS, windowEndMs);
  return Math.max(0, Math.min(1, (b - a) / HOUR_MS));
}

// resolveCheapWindow — moved to chargeWindows.ts (R2), re-exported above.

/** v1.168.0 — a cheap window shorter than this is not a recharge: Friday's 23:00-24:00
 *  (Saturday 00:00-05:00 is weekend off-peak) buys ~15 kWh at most. */
export const FULL_CHEAP_WINDOW_MIN_MS = 3 * HOUR_MS;
/** v1.168.0 — a gap to the next full window longer than this is a "long gap". A
 *  weekday gap is 18 h (05:00 → 23:00); Thursday's is 67 h (Fri 05:00 → Mon 00:00). */
export const LONG_GAP_MS = 24 * HOUR_MS;

/** v1.168.0 — the next cheap window of at least FULL_CHEAP_WINDOW_MIN_MS starting at or
 *  after `fromMs` (short windows are stepped over), or null if none starts within
 *  `scanHours`. v1.191.0 (CA15) — `minFullMs` is the schedule's (nightSchedule.ts
 *  fullWindowMinMs): FULL_CHEAP_WINDOW_MIN_MS on the APS preset. */
export function nextFullCheapWindow(
  periodIdAt: (tsMs: number) => string,
  fromMs: number,
  cheapPeriodId: string,
  scanHours = 120,
  minFullMs: number = FULL_CHEAP_WINDOW_MIN_MS,
  /** v1.191.0 (review) — the night bound (chargeWindows.ts cheapNightOf); null on the APS preset. */
  night: CheapNight | null = null,
): { startMs: number; endMs: number } | null {
  const limitMs = fromMs + scanHours * HOUR_MS;
  let from = fromMs;
  for (let i = 0; i < 16 && from < limitMs; i++) {
    const w = resolveCheapWindow(periodIdAt, from, cheapPeriodId, Math.max(1, Math.ceil((limitMs - from) / HOUR_MS)), night);
    if (!w || w.startMs >= limitMs) return null;
    if (w.endMs - w.startMs >= minFullMs) return w;
    from = w.endMs;
  }
  return null;
}

/**
 * v1.168.0 — THE THURSDAY RULE, keyed off the tariff calendar rather than a weekday
 * name (a holiday makes its own long gap). True when tonight is itself a full-length
 * window AND the next full-length one opens more than LONG_GAP_MS after tonight's
 * closes — or none opens within the scan at all. Friday's 1-hour window is never one:
 * it is not a full window. Measured 2026-09-17 (8 weeks replayed): filling to ~90% on
 * these nights beats the solar-headroom ceiling by ~$1/week.
 */
export function longGapAhead(
  tonight: { startMs: number; endMs: number } | null,
  nextFull: { startMs: number; endMs: number } | null,
  /** v1.191.0 (CA15) — the schedule's full-window minimum (FULL_CHEAP_WINDOW_MIN_MS on the APS preset). */
  minFullMs: number = FULL_CHEAP_WINDOW_MIN_MS,
): boolean {
  if (!tonight || tonight.endMs - tonight.startMs < minFullMs) return false;
  if (!nextFull) return true;
  return nextFull.startMs - tonight.endMs > LONG_GAP_MS;
}

/** v1.186.0 — how far past tonight's window close the pre-peak surplus may reach when
 *  no on-peak hour starts first (the same span the P50/P90 morning surplus covers). */
export const PRE_PEAK_SURPLUS_MAX_HOURS = 14;

/**
 * v1.186.0 — the PESSIMISTIC solar headroom kept on a long-gap night: the sum of
 * max(0, P10 PV − forecast load) over [windowEnd, the first on-peak hour after it), capped
 * at PRE_PEAK_SURPLUS_MAX_HOURS. P10 is the LOW-PV quantile (analytics.ts ForecastBand:
 * "10th-percentile PV (worst case, cloudy)"); the surplus stops at the evening on-peak
 * start, so the sun has refilled the pack before the dearest hours whenever the day
 * delivers at least its P10 — the evening peak stays covered. Measured 2026-09-24→25: with
 * the headroom set aside the long-gap buy reached 90% overnight, the pool was full before
 * 11:00 and the Cores curtailed 12.27 kWh of PV that day.
 *
 * `untilMs` is always the bound used. `kwh` is null (⇒ the headroom stays set aside and
 * the full long-gap buy stands) when no hour in the span is covered or any covered hour
 * carries a non-finite P10 or load: absence of a pessimistic forecast is not evidence of sun.
 */
export function pessimisticPrePeakSurplus(o: {
  hours: ReadonlyArray<{ ts: number; p10W: number; loadW: number }>;
  windowEndMs: number;
  isOnPeakAt: (tsMs: number) => boolean;
  maxHours?: number;
}): { kwh: number | null; untilMs: number } {
  const capMs = o.windowEndMs + (o.maxHours ?? PRE_PEAK_SURPLUS_MAX_HOURS) * HOUR_MS;
  let untilMs = capMs;
  for (let t = o.windowEndMs; t < capMs; t += HOUR_MS) {
    if (o.isOnPeakAt(t)) { untilMs = t; break; }
  }
  let kwh = 0;
  let covered = false;
  for (const h of o.hours) {
    if (h.ts < o.windowEndMs || h.ts >= untilMs) continue;
    if (!Number.isFinite(h.p10W) || !Number.isFinite(h.loadW)) return { kwh: null, untilMs };
    covered = true;
    kwh += Math.max(0, h.p10W - h.loadW) / 1000;
  }
  return { kwh: covered ? round2(kwh) : null, untilMs };
}

/* ── v1.198.0 — THE PROVISIONAL SOLAR BAND ──────────────────────────────────
 *
 * The basis gate needs N_MIN (14) scored calibration days before the PV band is trusted. A day on
 * which a home Core had no readings is a coverage gap and does not score (v1.196.0), so after a
 * stretch of cloud-offline Cores the gate refused every plan for about two weeks after they
 * reported again (14 covered days), and the backup pool spent those nights at its reserve floor.
 *
 * From PROVISIONAL (index.ts NIGHT_PROVISIONAL_MIN_CAL_DAYS, 4) scored days the basis is admitted
 * on a deliberately WIDER band: below N_MIN the P10 PV every planner hour is sized on is pushed
 * below the published P10 by k(n), and the beyond-24 h carry is widened by k × the band's own
 * lower half-width (realizedDailyErrHalfFrac is null below 14, so the carry was not widened at all
 * — the `?? 0` index.ts passes). The plan sizes on P10 PV / P90 load, and every reader of the P10
 * is monotone non-decreasing in it (simulate, packAtWindowEndWith, gridGainKw's acceptance bound,
 * the long-gap pre-peak surplus), so a lower P10 never lowers the requirement, the write setpoint
 * or the cost ceiling. P50 and P90 are not touched: the expected buy and start, the morning
 * surplus, the over-buy flag and held import read the published band.
 *
 * What stays: the coverage gate (≥ 78% of the scored days inside the band) is judged on the
 * PUBLISHED band, before any widening, so the widening never helps a plan pass; at 4 days Math.round
 * makes it unanimous (3 of 4 is 75%). The published band, the ledger's pv_p10/p50/p90 and every
 * display keep the band as published: pv_in_band keeps its meaning, so CURRENT_ALGO_VERSION
 * stays 3. From N_MIN on, nothing here runs and every plan is byte-identical to the planner
 * before v1.198.0 (legacyIdentity.golden.json; provisionalBand.test.ts).
 */

/**
 * v1.198.0 — k(n): the Student-t predictive inflation of a scale estimated from n days,
 * normalised to exactly 1 at the 14 days the band is trusted on today:
 *
 *     k(n) = t₀.₉₀(n − 1) · √(1 + 1/n) / ( t₀.₉₀(13) · √(1 + 1/14) )
 *
 * (the √(1 + 1/n) because the P50's own bias correction, pvBiasFactor, is fitted on the same recent
 * days). Below 14 days the band is the raw one (bandSigmaCal cannot engage), not an order
 * statistic of the n errors, so this is a deliberate, principled-in-form inflation rather than a
 * derivation. 4 days is where the table starts: the maximum of n exchangeable daily errors covers
 * a new day with probability n/(n+1), 0.75 at 3 and 0.80 at 4. √(14/n) (1.87 at 4) was the more
 * conservative alternative; on a raw lower half-width of 0.40-0.55 it drives most P10 hours to 0.
 * Hard-coded, as PROB_ENSEMBLE_Z is; provisionalBand.test.ts recomputes it from the t quantiles.
 */
export const PROVISIONAL_BAND_WIDEN: Readonly<Record<number, number>> = Object.freeze({
  4: 1.3102, 5: 1.2018, 6: 1.1407, 7: 1.1013, 8: 1.0738,
  9: 1.0535, 10: 1.0379, 11: 1.0255, 12: 1.0154, 13: 1.0071,
});
/** v1.198.0 — the scored days PROVISIONAL_BAND_WIDEN is normalised to (k = 1): N_MIN. */
export const PROVISIONAL_BAND_FULL_DAYS = 14;

/** v1.198.0 — k(n) (PROVISIONAL_BAND_WIDEN): the table value for 4 ≤ n ≤ 13, 1 from
 *  PROVISIONAL_BAND_FULL_DAYS on, and null below 4 or for a non-integer n — no widening is
 *  defined there, and a basis that would need one is refused, never sized unwidened. PURE. */
export function provisionalBandWiden(calScoredDays: number): number | null {
  if (!Number.isInteger(calScoredDays)) return null;
  if (calScoredDays >= PROVISIONAL_BAND_FULL_DAYS) return 1;
  return PROVISIONAL_BAND_WIDEN[calScoredDays] ?? null;
}

/** v1.198.0 — one hour's widened P10 PV, W: min(P10, max(0, P50 − k·(P50 − P10))) — the band's
 *  lower half-width × k below the median, never above the published P10 (a P10 the ceiling clamp
 *  put above its P50 is kept, not raised) and never below 0. No finite P50 ⇒ 0: no credit for
 *  sun the band does not state. A non-finite P10 is returned as it is. PURE. */
export function provisionalP10W(p10W: number, p50W: number | null | undefined, k: number): number {
  if (!Number.isFinite(p10W)) return p10W;
  const p10 = Math.max(0, p10W);
  if (p50W == null || !Number.isFinite(p50W)) return 0;
  return Math.min(p10, Math.max(0, p50W - k * (p50W - p10)));
}

/** v1.198.0 — the band's own daily lower half-width, as a fraction of its P50: Σ max(0, P50 − P10)
 *  / Σ P50 over the hours that carry both (each P50 and P10 floored at 0). 1 — the widest — when
 *  those hours hold under 0.5 kWh of P50: a band that states no sun says nothing about its width.
 *  In [0, 1]. PURE. */
export function bandLowerHalfFrac(hours: ReadonlyArray<NightForecastHour>): number {
  let p50Wh = 0;
  let halfWh = 0;
  for (const h of hours) {
    if (h.pvP50W == null || !Number.isFinite(h.pvP50W) || !Number.isFinite(h.pvP10W)) continue;
    const m = Math.max(0, h.pvP50W);
    p50Wh += m;
    halfWh += Math.max(0, m - Math.max(0, h.pvP10W));
  }
  return p50Wh < 500 ? 1 : halfWh / p50Wh;
}

/** v1.198.0 — the sentence a provisional plan closes its rationale with, and the card and the evening
 *  push state (the card mirrors it word for word: nightChargeText.ts provisionalBandText). '' on the
 *  full basis. PURE. */
export function provisionalBandText(w: PvBandWiden | null | undefined): string {
  if (w == null) return '';
  return ` PROVISIONAL SOLAR BAND: ${w.calScoredDays} of ${w.fullCalScoredDays} calibration days scored, so the P10 PV this plan is sized on`
    + ` is widened ×${w.factor.toFixed(2)} (the next 24 h: ~${round1(w.bandP10Kwh)} → ~${round1(w.widenedP10Kwh)} kWh)`
    + ` and the multi-day carry by ±${Math.round(w.rollupHalfFrac * 100)}% per √day; the full band returns at ${w.fullCalScoredDays} scored days.`;
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
 *    v1.198.0 — calScoredDays ≥ the PROVISIONAL minimum (provisionalMinCalScoredDays, 4; absent ⇒
 *    N_MIN): below N_MIN the basis is admitted on the widened band (PROVISIONAL_BAND_WIDEN) — the
 *    planner's P10 PV and the beyond-24 h carry, never the coverage the gate judges.
 */
export function buildNightChargeInputs(deps: NightChargeInputDeps): NightChargeInputs {
  const {
    nowMs, fullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,
    legEff, dischargeEff, chargeCapKw, gridInputCapKw,
    periodIdAt, cheapPeriodId, cheapNight = null, windowScanHours = 30,
    bandHours, dayRollups, realizedDailyErrHalfFrac, nextRechargeMs,
    ev, evMaxLoadW,
    confidenceTier, forecastPresent, calScoredDays, minCalScoredDays, bandCoverageFrac,
    // v1.198.0 — the provisional band: its minimum, and the pre-peak hours it widens.
    provisionalMinCalScoredDays, prePeakSurplusBasis,
    morningPvSurplusP90Kwh, minBuyKwh, buyDebiasFactor,
    morningPvSurplusP50Kwh, longGapAhead, prePeakPvSurplusP10Kwh: publishedPrePeakP10Kwh,
    costSurplusLoad,
    // v1.187.3 — the learner's basis and sample count, carried beside its factor: until
    // v1.187.2 only the factor was copied, so every plan reported 'default' / 0 samples
    // whatever the learner said (the 09-30 log: "UNMEASURED (6 eligible night(s))" while
    // the plan the log points to said 0) — the hazard the note below describes.
    buyDebiasBasis, buyDebiasSamples,
    // v1.187.22 — read by the expected-buy disclosure; copied through like the fields below.
    forceChargeEligible,
    // v1.125.0 — the islanded-outage cushion inputs. Destructuring here is not
    // decoration: NightChargeInputs is built field-by-field below, so a field
    // added to the deps interface and to the inputs interface but NOT copied
    // through this function arrives as `undefined` and silently takes the legacy
    // path. That is exactly what happened on the first cut of this change, and
    // only the end-to-end test caught it — the unit tests of the pure cushion
    // function all passed.
    islandedLoadKw, outageCushionHours, islandedLoadSafety,
    objectiveMode, costMaxSocPct,
    // R2 — the leg (WindowSpec): its pinned window, and its role's objective and force-charge.
    windowSpec,
  } = deps;

  // R2 — a leg the chooser pinned is sized on that window; otherwise the resolver, as before.
  const window = windowSpec?.window !== undefined
    ? (windowSpec.window != null && Number.isFinite(windowSpec.window.startMs) && Number.isFinite(windowSpec.window.endMs)
      ? { startMs: windowSpec.window.startMs, endMs: windowSpec.window.endMs } : null)
    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, windowScanHours, cheapNight);
  // R2 — per leg: the backup leg is resilience-only and never force-charges, whatever the
  // configuration says (chargeWindows.ts legObjective / legForceChargeEligible). The cost leg —
  // and a plan with no spec — keeps the configured values exactly as passed.
  const legRole: ChargeLegRole = windowSpec?.role ?? 'cost';

  // v1.48.0 — coverage floor corrected 0.9 → 0.78. The P10–P90 band nominally
  // covers 80%, and the WRITE gate (nightChargeGate.ts) accepts realized
  // coverage in [0.78, 0.92] as calibrated. Requiring ≥ 0.9 here meant a
  // CORRECTLY calibrated forecast (e.g. the live 85%) failed the basis every
  // night — no plan, no advisory content, nothing scored, readiness starved.
  // Below 0.78 the band is overconfident (too narrow) and still blocks; above
  // 0.92 it is over-wide, which is CONSERVATIVE for the P10-PV sizing this
  // basis feeds, so the advisory basis needs no upper bound (the write gate
  // keeps its stricter two-sided band).
  // v1.198.0 — decided BEFORE the band is built: a PROVISIONAL basis (from
  // provisionalMinCalScoredDays to N_MIN scored days) widens the hours below. The coverage is the
  // published band's (bandRealizedCoveragePct), judged as before — never on the widened band.
  const provisionalMinDays = provisionalMinCalScoredDays != null && Number.isFinite(provisionalMinCalScoredDays)
    ? Math.min(provisionalMinCalScoredDays, minCalScoredDays) : minCalScoredDays;
  const basisGatePasses =
    forecastPresent &&
    confidenceTier !== 'climatology' &&
    calScoredDays >= provisionalMinDays &&
    bandCoverageFrac >= BASIS_MIN_BAND_COVERAGE;
  const provisionalDays = basisGatePasses && calScoredDays < minCalScoredDays;
  // A provisional day count with no widening defined for it (under the table's first entry, or not
  // a whole number) is refused: never sized on the band unwidened.
  const provisionalK = provisionalDays ? provisionalBandWiden(calScoredDays) : null;
  const basisComplete = basisGatePasses && (!provisionalDays || provisionalK != null);
  /** v1.198.0 — k(n) on a provisional basis; null on the full basis (and on a refused one): every
   *  transform below runs only when this is set, so the full basis is the planner as it was. */
  const bandWidenK: number | null = basisComplete ? provisionalK : null;
  /** v1.198.0 — the day count as the coverage refusal prints it, the minimum it PASSED: the
   *  provisional one below the full one, said so ("4/14" read as a failed count on the likeliest
   *  refusal after a return), and the full one from it, as before. */
  const calDaysPassedText = calScoredDays < minCalScoredDays
    ? `${calScoredDays}/${provisionalMinDays}, provisional band below ${minCalScoredDays}`
    : `${calScoredDays}/${minCalScoredDays}`;
  // v1.148.0 — SAY WHICH GATE FAILED.
  //
  // On 2026-09-10 this returned false, the plan was null, and the backup pool sat
  // at its 16% reserve floor from 22:36 to 07:50 — 9 h 13 m one grid failure from
  // empty, recovering on morning solar. The reason appeared NOWHERE: not in the
  // log, not on the plan, not in the evening advisory, not on the dashboard.
  // Three of the four gates passed; band coverage missed by six points (72% vs
  // 78%). Reconstructing that took an hour of live probing.
  //
  // "forecast/telemetry basis incomplete" is four conditions wearing one coat.
  const basisBlockedBy: string | null = basisComplete
    ? null
    : !forecastPresent
      ? 'no PV forecast available'
      : confidenceTier === 'climatology'
        ? 'forecast is climatology-tier (no site-specific history yet)'
        : calScoredDays < provisionalMinDays
          ? `only ${calScoredDays} scored calibration day(s), need ${provisionalMinDays}`
            + (provisionalMinDays < minCalScoredDays
              ? ` (a provisional plan on a widened solar band from ${provisionalMinDays}; the full band from ${minCalScoredDays})` : '')
          : !(bandCoverageFrac >= BASIS_MIN_BAND_COVERAGE)
            ? `PV band coverage ${Math.round(bandCoverageFrac * 100)}% < ${Math.round(BASIS_MIN_BAND_COVERAGE * 100)}%`
              + ` (forecast present, tier=${confidenceTier}, calDays ${calDaysPassedText})`
            : `no provisional band widening is defined for ${calScoredDays} scored calibration day(s)`;

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
      // v1.187.22 — copied, not derived: an hour without them has no P50 basis (and the plan
      // then states no expected buy). The block placement below never touches them.
      loadP50W: finiteOrNull(h.loadP50W),
      pvP50W: finiteOrNull(h.pvP50W),
    });
  }
  // v1.198.0 — THE PROVISIONAL BAND: every band hour is sized on its widened P10 (provisionalP10W),
  // and the beyond-24 h carry on k × the band's own lower half-width instead of the realized one
  // (null below N_MIN: index.ts passes 0, which left the carry unwidened). An hour with no P50 goes
  // to 0, and its P50 walks (expectedCarryKwh, expectedWindowLiftKwh, expectedForceChargeStart)
  // keep the published P10 they stood on in its absence: the expected figures do not move.
  let pvBandWiden: PvBandWiden | null = null;
  let provisionalRollupHalfFrac: number | null = null;
  if (bandWidenK != null) {
    let publishedWh = 0;
    let widenedWh = 0;
    for (const h of byTs.values()) {
      if (!Number.isFinite(h.pvP10W)) continue;
      const widened = provisionalP10W(h.pvP10W, h.pvP50W, bandWidenK);
      publishedWh += h.pvP10W;
      widenedWh += widened;
      if (h.pvP50W == null) h.pvP50W = h.pvP10W;
      h.pvP10W = widened;
    }
    provisionalRollupHalfFrac = bandWidenK * bandLowerHalfFrac(bandHours);
    pvBandWiden = {
      factor: bandWidenK,
      calScoredDays,
      fullCalScoredDays: minCalScoredDays,
      bandP10Kwh: round2(publishedWh / 1000),
      widenedP10Kwh: round2(widenedWh / 1000),
      rollupHalfFrac: Math.round(provisionalRollupHalfFrac * 1e4) / 1e4,
    };
  }
  for (const dr of dayRollups) {
    const da = Math.max(1, dr.daysAhead);
    const widen = Math.max(0, provisionalRollupHalfFrac ?? realizedDailyErrHalfFrac) * Math.sqrt(da);
    const p10Frac = Math.max(0, 1 - widen); // pessimistic-low PV
    const p90Frac = 1 + widen; // pessimistic-high load
    for (const hh of dr.hours) {
      if (!Number.isFinite(hh.ts) || byTs.has(hh.ts)) continue;
      byTs.set(hh.ts, {
        ts: hh.ts,
        pvP10W: Math.max(0, hh.pvW * p10Frac),
        loadP90W: Math.max(0, hh.loadW * p90Frac),
        // v1.187.22 — the rollup's own (central) figures, unwidened: its loadW already embeds
        // typical EV, and the committed P90 block is never placed out here.
        loadP50W: finiteOrNull(hh.loadW),
        pvP50W: finiteOrNull(hh.pvW),
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

  // v1.198.0 — the long-gap headroom on a provisional basis: the same pre-peak hours, span and
  // on-peak test index.ts summed the published surplus over (prePeakSurplusBasis), on the widened
  // P10. Without them the headroom is set aside (null: the full long-gap buy) — never the published
  // surplus, which a provisional plan has not earned. The full basis forwards it verbatim.
  const prePeakPvSurplusP10Kwh: number | null | undefined = bandWidenK == null
    ? publishedPrePeakP10Kwh
    : prePeakSurplusBasis != null
      ? pessimisticPrePeakSurplus({
        hours: prePeakSurplusBasis.hours.map((h) => ({ ts: h.ts, p10W: provisionalP10W(h.p10W, h.p50W, bandWidenK), loadW: h.loadW })),
        windowEndMs: prePeakSurplusBasis.windowEndMs,
        isOnPeakAt: prePeakSurplusBasis.isOnPeakAt,
      }).kwh
      : null;

  // v1.186.5 — no forecast, or not ONE scored calibration day: what a start-up leaves
  // (a skill scored on a partial device map is now empty rather than wrong). 1 to the
  // provisional minimum − 1 (1-3) scored days is a young history and a coverage miss is a real
  // miss: both persistent.
  const basisTransient = !basisComplete && (!forecastPresent || calScoredDays === 0);
  return {
    nowMs,
    // R2 — forwarded only when given, so a plan with no spec carries exactly the inputs it did.
    ...(windowSpec !== undefined ? { windowSpec } : {}),
    basisBlockedBy,
    basisTransient,
    // v1.198.0 — only on a provisional basis: the full basis's inputs carry exactly what they did.
    ...(pvBandWiden != null ? { pvBandWiden } : {}),
    fullKwh,
    socNowPct,
    reserveFloorPct,
    cushionPct,
    // v1.125.0 — carried through explicitly; see the destructure note above.
    islandedLoadKw,
    outageCushionHours,
    islandedLoadSafety,
    objectiveMode: legObjective(legRole, objectiveMode),
    costMaxSocPct,
    socCoherent,
    legEff,
    dischargeEff,
    chargeCapKw,
    gridInputCapKw,
    window,
    horizon: trimmed,
    morningPvSurplusP90Kwh,
    morningPvSurplusP50Kwh,
    longGapAhead,
    prePeakPvSurplusP10Kwh,
    buyDebiasFactor,
    // v1.187.3 — forwarded verbatim; see the destructure note above.
    buyDebiasBasis,
    buyDebiasSamples,
    // v1.187.22 — forwarded verbatim; see the destructure note above. R2 — never on a backup leg.
    forceChargeEligible: forceChargeEligible === undefined ? undefined : legForceChargeEligible(legRole, forceChargeEligible),
    confidenceTier,
    basisComplete,
    minBuyKwh,
    // v1.187.1 — forwarded verbatim; see the destructure note above.
    costSurplusLoad,
  };
}

// --- v1.50.0 actuated-night measurement helpers (PURE) -----------------------

/**
 * v1.187.3 — the basis an actuated night's `delivered_kwh` is measured on, recorded beside
 * it in the ledger's `delivered_basis` column: the energy INTO the home Cores, from the
 * house panel's per-Core source channels (nightLedgerScoring.deliveredIntoCores).
 *
 * WHY A BASIS. From v1.50.0 to v1.187.2 the column was window grid import minus the
 * concurrent house load (`actuatedDeliveredKwh`, removed), which assumed the house ran on
 * the grid for the whole hold. When the SHP2 carries the house from the pack instead —
 * 2026-09-30: pool 74% at 23:00 against the 50% reserve, the house on the pack until the
 * force-charge at 03:18 and again after its 04:32 OFF, 15.5 kWh of load with zero import —
 * the subtraction removes load the grid never carried: 4.71 kWh recorded against ~20.3 kWh
 * into the Cores (source channels 20.34, the Cores' own AC input 20.25, pool 55→76%).
 * Always toward under-delivery, in the column the buy de-bias below trains on.
 *
 * Rows captured before v1.187.3 carry `delivered_basis` NULL and are KEPT as recorded; the
 * learner admits only rows on this basis (calibratedBuyDebiasFactor), so the old estimate
 * is never mixed with the measurement. A change of method gets a new value here.
 */
export const DELIVERED_BASIS = 'source-charge';

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
 *
 * v1.194.0 — the conversion is fixed, the planner's is not. Since the charge leg
 * (chargeLegStep) the planner stores a surplus hour's PV at legEff, so a PV miss
 * inside a surplus hour moves its own buy by 1 kWh per kWh missed; this formula
 * still says 1/legEff, about 7.8 % more, in both directions (a cloudy day scores a
 * deeper under-buy, a sunny one a larger over-buy). A deficit hour's PV miss is
 * converted exactly. The formula is kept so every algo-v3 row is scored alike
 * (nightChargeGate.ts, CURRENT_ALGO_VERSION); runwayChargeLeg.test.ts works both
 * hours on the planner.
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

/**
 * v1.112.0 — BUY DE-BIAS from realized nights (design §3.4's "buy de-bias",
 * first live producer/consumer for that lane).
 *
 * The 08-26/27 night announced "buy ~21.6 kWh" and delivered ~35.8 kWh — a
 * 1.66x under-PREDICTION. The actuation itself is bounded by the reserve
 * setpoint, so nothing unsafe happened; but the announcement is the advisory's
 * product, and a number the operator learns to distrust is a number that stops
 * informing decisions.
 *
 * The factor is the MEDIAN of realized/planned buy over eligible nights
 * (actuated, scored, no disclosed cushion shortfall, plan large enough that the
 * ratio is meaningful), with the load-band guards:
 *  - FLOOR at 1.0 — the calibration only ever RAISES the announced buy. The
 *    raw physics-derived estimate stays the lower bound; shrinking it on
 *    learned data would import forecast noise into the safe direction's
 *    denominator.
 *  - CAP so a few pathological nights cannot run the announcement away.
 *  - minSamples before trusting it at all.
 *
 * ★ SELF-REFERENCE GUARD: the ledger's `buy_kwh` column must keep recording
 * the RAW plan buy (recordNightPlanRow does — see the test pinning it).
 * Feeding the DEBIASED figure back into the ledger would make each night's
 * ratio ≈1 and decay the factor toward nothing — the learner eating its own
 * output. The debiased figure exists ONLY on the announcement surfaces.
 *
 * v1.187.3 — ONE BASIS. Only rows whose `delivered_basis` is DELIVERED_BASIS are samples.
 * A row captured before v1.187.3 holds the import-minus-house-load estimate, which
 * under-counts every night the SHP2 ran the house from the pack inside the hold (09-30:
 * 4.71 against ~20.3 kWh, a 0.26 ratio for a true ~1.1) — it is counted in `setAside`,
 * never a sample, and never rewritten. Until DELIVERED_BASIS rows reach minSamples the
 * factor is the floor with basis 'default', which the log says with the set-aside count.
 *
 * R4 (v1.189.0) — ONE STRATUM PER WINDOW KIND (plan §3.3 "Learners"). A mid-day leg charges
 * beside the sun and an overnight one in the dark, so their delivered/planned ratios are not one
 * population: the factor reads only the rows of `opts.windowKind` (default 'overnight'; a row
 * written before the charge cycle has no `window_kind` and is an overnight row). The planned
 * figure is the morning refresh's (`refreshed_buy_kwh`, the refreshed worst case — the same basis
 * as `buy_kwh`) when the row has one: the leg ran on it. The load band and the cost-ceiling load
 * factor stay POOLED — they learn the forecast load over [issue, +24 h], which does not depend on
 * the window, and a thin mid-day stratum would sit on their floors.
 */
/** R4 — the window kind a ledger row's cost leg charged in: NULL (a row written before the
 *  charge cycle record) is overnight. PURE. */
export function ledgerRowWindowKind(r: { window_kind?: string | null }): ChargeWindowKind {
  return r.window_kind === 'super_off_peak' ? 'super_off_peak' : 'overnight';
}

export function calibratedBuyDebiasFactor(
  rows: ReadonlyArray<{
    buy_kwh?: number | null;
    delivered_kwh?: number | null;
    delivered_basis?: string | null;
    actuated?: number | null;
    scored?: number | null;
    cushion_shortfall?: number | null;
    window_kind?: string | null;
    refreshed_buy_kwh?: number | null;
  }>,
  opts: { floor?: number; cap?: number; minSamples?: number; minPlanKwh?: number; windowKind?: ChargeWindowKind } = {},
): { factor: number; basis: 'measured' | 'default'; samples: number; setAside: number } {
  const floor = opts.floor ?? 1.0;
  const cap = opts.cap ?? 1.75;
  const minSamples = opts.minSamples ?? 7;
  const minPlanKwh = opts.minPlanKwh ?? 3;
  const stratum = opts.windowKind ?? 'overnight';
  /** The figure the leg ran on: the refreshed worst case when the row has one. */
  const plannedKwh = (r: { buy_kwh?: number | null; refreshed_buy_kwh?: number | null }): number | null | undefined =>
    typeof r.refreshed_buy_kwh === 'number' && Number.isFinite(r.refreshed_buy_kwh) ? r.refreshed_buy_kwh : r.buy_kwh;
  const eligible = rows
    .filter((r) => ledgerRowWindowKind(r) === stratum)
    .filter((r) => {
      const planned = plannedKwh(r);
      return r.actuated === 1 &&
        r.scored === 1 &&
        !(r.cushion_shortfall === 1) &&
        typeof planned === 'number' && Number.isFinite(planned) && planned >= minPlanKwh &&
        typeof r.delivered_kwh === 'number' && Number.isFinite(r.delivered_kwh) && r.delivered_kwh >= 0;
    });
  const onBasis = eligible.filter((r) => r.delivered_basis === DELIVERED_BASIS);
  const setAside = eligible.length - onBasis.length;
  const ratios = onBasis
    .map((r) => (r.delivered_kwh as number) / (plannedKwh(r) as number))
    .sort((a, b) => a - b);
  if (ratios.length < minSamples) return { factor: floor, basis: 'default', samples: ratios.length, setAside };
  const median = ratios[Math.floor(ratios.length / 2)];
  const factor = Math.min(cap, Math.max(floor, median));
  return { factor: Math.round(factor * 1000) / 1000, basis: 'measured', samples: ratios.length, setAside };
}

/**
 * v1.187.3 (review) — the UNMEASURED log line for the buy de-bias learner (v1.144.0: the
 * silent case, said once on change), as a key and its text; null on a measured result,
 * which has its own "calibrated ×N" line. PURE so a test drives it: the key carries the
 * set-aside count, so a pre-v1.187.3 row scored after the upgrade logs a new line, and the
 * text names that count, so a reset to 'default' after the upgrade reads as what it is.
 */
export function buyDebiasUnmeasuredLogLine(
  cal: Pick<ReturnType<typeof calibratedBuyDebiasFactor>, 'basis' | 'samples' | 'setAside'>,
): { key: string; text: string } | null {
  if (cal.basis === 'measured') return null;
  return {
    key: `unmeasured:${cal.samples}:${cal.setAside}`,
    text: `night-charge: announced-buy calibration UNMEASURED (${cal.samples} eligible night(s), `
      + `${cal.setAside} set aside for a pre-v1.187.3 delivered_kwh) — the announcement carries no `
      + `learned correction. Eligibility excludes rows with cushion_shortfall=1 and rows whose delivered_basis `
      + `is not '${DELIVERED_BASIS}'; see /api/night-charge/status → plan.buyDebiasBasis.`,
  };
}

/**
 * v1.125.0 — THE OUTAGE CUSHION, RE-SCOPED TO SOMETHING THAT CAN BE MET.
 *
 * WHAT WAS WRONG. `ARB_OUTAGE_CUSHION_PCT` was a flat 15 % of pool, and the test
 * asked whether a deliberately grid-blind forward simulation stayed above
 * floor+cushion. That simulation runs the WHOLE HOUSE off the battery for the
 * entire remaining forecast horizon — 25 to 49 hours. Measured on this plant:
 * P90 load 156-185 kWh/day against a 92.16 kWh pool, so the trough hit zero 1-8
 * hours after window close on 7 of 7 nights and `cushionShortfall` was pinned
 * TRUE by arithmetic. Being a constant, it silently exempted every night from
 * three separate mechanisms (the under-buy pool, the buy de-bias learner, and the
 * engine-fault strike detector), so each reported "nothing to see" for a reason
 * unrelated to whether there was anything to see.
 *
 * WHY IT COULD NEVER BE MET. The model was of a scenario that cannot happen. When
 * the grid drops, the SHP2 carries its BACKUP CIRCUITS; the rest of the house is
 * simply dead. Measured live 2026-09-05: `panel_load_watts` 1445 W against
 * `runway_recent_load_watts` 4863 W — a 3.4x difference. Draining the pack at
 * whole-house load modelled an island that the hardware does not create.
 *
 * THE RE-SCOPE. The cushion is now the energy to carry the ISLANDED load for a
 * bounded outage:
 *
 *     cushionKwh = outageHours x islandedLoadKw x safetyFactor / dischargeEff
 *
 * and the test is whether the pack at window close clears reserve + that. At
 * 1.445 kW islanded, 8 h and a 1.5x factor that is ~18.7 kWh — comparable to the
 * old flat 13.8 kWh band, so this is not a loosening in magnitude. What changes is
 * that it is now a REACHABLE, physically meaningful statement ("we can run the
 * backup circuits for 8 hours") instead of an unreachable one ("we can run the
 * whole house for two days"), so the flag becomes a signal again.
 *
 * NO PV CREDIT, deliberately: an outage can begin at dusk, and crediting P10 PV
 * over a bounded window would weaken the guarantee for a few kWh.
 *
 * SAFETY FACTOR. `panel_load_watts` is a spot reading of circuits whose ch1
 * scaling is a known open question on this plant, and islanded load is not
 * constant. The multiplier absorbs both. It is NOT a fudge for optimism: raising
 * it makes the requirement harder.
 *
 * FAIL-CLOSED. With no islanded-load measurement the legacy flat band and the
 * legacy whole-house trough both stand, which keeps the old (permanently
 * shortfalling) behaviour rather than silently granting a weaker guarantee.
 */
/**
 * v1.127.0 — COST OBJECTIVE: size the buy to minimise the bill.
 *
 * MEASURED ON THIS PLANT (2026-09-05), which is what makes this worth doing:
 *   overnight 13.1c/kWh · off-peak 17.0c · on-peak summer 41.6c · RTE 0.86
 *   => a kWh bought overnight delivers at 13.1/0.86 = 15.23c, so it beats
 *      off-peak by +1.77c and on-peak by +26.37c.
 *   7-day import 453.89 kWh at $81.36 = 17.9c/kWh average, against a 13.1c
 *      overnight rate — every kWh shifted into the window is worth ~4.8c.
 *   On-peak import is 0 on most days but was 22.89 kWh on Fri 08-28, the day
 *      whose charge window is truncated to ONE hour by the weekend DOW boundary
 *      (~$6 of avoidable on-peak, weekly).
 *
 * THE BINDING CONSTRAINT IS NOT MONEY, IT IS SUNLIGHT. Every one of those rates
 * beats 15.23c, so the naive answer is "always fill completely" — and that is
 * wrong. A pack too full to accept the morning's solar curtails it, and a
 * curtailed kWh costs the full 15.23c we paid for the grid kWh occupying its
 * place. That is 8.6x the weekend-carry gain, so the ceiling matters far more
 * than the floor.
 *
 * Ceiling, most-preferred first:
 *   1. `fullKwh - morningPvSurplusP90Kwh` — leave room for tomorrow's P90 surplus.
 *   2. `maxSocPct` of pool — a hard cap for when the forecast band does not
 *      cover window-end +14 h, which is exactly when the surplus is null. Never
 *      "fill to 100% because we could not see the sun".
 * The two are combined with `min`, so a present forecast can only ever make the
 * ceiling LOWER.
 *
 * The reserve floor remains a hard minimum: cost mode may buy more than
 * resilience mode, never less. Switching objective can therefore never reduce
 * the safety margin — a property asserted by test.
 */
/**
 * v1.129.0 — parse a persisted islanded-load seed.
 *
 * Pure so the shape checks are testable: a corrupt or half-written sidecar must
 * yield null (falling the cushion back to its legacy band) rather than seeding a
 * NaN, a negative, or a stale-typed value into safety-relevant sizing.
 */
/**
 * v1.129.0 — the runway pair must be COHERENT: empty can never precede reserve.
 *
 * Reported 2026-08-05: the alarm printed "time to empty 1 h" beside "time to
 * reserve 20.5 h". The pool drains through the reserve floor on its way to empty,
 * so reserve must come first or the pair is nonsense.
 *
 * Two mechanisms produce it, and they need different answers:
 *
 *  - BELOW THE FLOOR the pair is not incoherent at all. The reserve detector arms
 *    only while the pool is ABOVE the floor, so once under it the reserve figure is
 *    the NEXT crossing after a modelled solar recharge — genuinely later than empty.
 *    Leave that alone; it is correctly labelled elsewhere.
 *  - ABOVE THE FLOOR it is a real contradiction, and the usual cause is the empty
 *    HYSTERESIS latch holding a stale finite `hoursToEmpty` for a couple of
 *    recomputes after the crossing has gone, while `hoursToReserve` comes from the
 *    current simulation.
 *
 * The rule is one-directional and alarm-safe: it may only make the runway SHORTER
 * or leave it alone, never longer, and it never turns a finite projection into
 * null. Clamping reserve down to empty is the conservative repair — it says the
 * floor arrives no later than empty, which is always true.
 */
export function coherentRunwayPair(o: {
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  belowFloor: boolean;
}): { hoursToReserve: number | null; hoursToEmpty: number | null; clamped: boolean } {
  const { hoursToReserve, hoursToEmpty, belowFloor } = o;
  if (belowFloor) return { hoursToReserve, hoursToEmpty, clamped: false };
  if (hoursToReserve == null || hoursToEmpty == null) return { hoursToReserve, hoursToEmpty, clamped: false };
  if (!Number.isFinite(hoursToReserve) || !Number.isFinite(hoursToEmpty)) {
    return { hoursToReserve, hoursToEmpty, clamped: false };
  }
  if (hoursToEmpty >= hoursToReserve) return { hoursToReserve, hoursToEmpty, clamped: false };
  // Impossible above the floor. Pull reserve back to empty — shortens, never lengthens.
  return { hoursToReserve: hoursToEmpty, hoursToEmpty, clamped: true };
}

export function parsePersistedIslandedLoad(raw: unknown): { kw: number; atMs: number } | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as { kw?: unknown; atMs?: unknown };
  if (typeof o.kw !== 'number' || !Number.isFinite(o.kw) || o.kw <= 0) return null;
  if (typeof o.atMs !== 'number' || !Number.isFinite(o.atMs) || o.atMs <= 0) return null;
  return { kw: o.kw, atMs: o.atMs };
}

export const DEFAULT_COST_MAX_SOC_PCT = 90;

/** v1.174.0 — minute-of-day (site zone) until which the evening job DEFERS a plan
 *  while the panel reading is stale. 22:30: an hour past the 21:30 fire (the longest
 *  stale latch measured was 22 min, 2026-09-14), and 30 min before a 23:00 window's
 *  write (v1.187.0: at the window open; it was 22:55), so the owner keeps a cancel
 *  window. After it the plan is sized on the
 *  last reading and says so — staleness alone never costs the night. */
export const NIGHT_PLAN_STALE_DEFER_UNTIL_MIN = 22 * 60 + 30;

/**
 * v1.186.5 — the evening job DEFERS an incomplete basis the way it defers a stale panel:
 * no plan row, no notification, no latch, no cancel of a prior arm; the minute tick
 * retries until NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, and from then on the night is decided
 * on what is known. An incomplete basis at 21:30 is usually a start-up transient: on
 * 2026-09-27 a restart at 21:06 left a calibration built on one Core's PV in the cache,
 * the plan read "PV band coverage 7%", latched "no plan" and cancelled the armed 66 kWh
 * weekend-carry charge; the same inputs read 97% by 22:14. `plan` null = inputs
 * unavailable (no plan was produced), which is equally transient at start-up. Only a
 * TRANSIENT-shaped failure defers (`basisTransient`); a persistent one is decided at once.
 */
export function eveningBasisDefers(
  plan: { basisComplete: boolean; basisTransient?: boolean } | null,
  nowMin: number,
  /** v1.191.0 (W3) — the schedule's deferral end (nightSchedule.ts staleDeferUntilMin):
   *  NIGHT_PLAN_STALE_DEFER_UNTIL_MIN on the APS preset. */
  deferUntilMin: number = NIGHT_PLAN_STALE_DEFER_UNTIL_MIN,
): boolean {
  // Only a transient-shaped failure waits; a persistent one is announced at 21:30 so the
  // owner keeps the full evening to act on it.
  return (plan == null || (!plan.basisComplete && plan.basisTransient === true))
    && nowMin < deferUntilMin;
}

/**
 * v1.165.0 — the economic ceiling alone: how full it is worth filling the pack
 * tonight, BEFORE the resilience floor and the physical charge caps. The same
 * `min(maxSoc, full - morning P90 solar surplus)` costModeTargetKwh applies — one
 * definition, so the force-charge ceiling can never drift from the planner's.
 */
export function costCeilingKwh(o: {
  fullKwh: number;
  morningPvSurplusKwh: number | null | undefined;
  maxSocPct: number;
  /** R2 — a mid-day leg's taper line (WindowSpec.curtailFromPct): the PV headroom is left under
   *  it (chargeTaper.ts taperCeilingKwh, basis 'pv-curtail') rather than under full. null/absent ⇒
   *  the overnight form, unchanged. */
  curtailFromPct?: number | null;
}): { ceilingKwh: number; basis: CostCeilingBasis } {
  const { fullKwh, morningPvSurplusKwh, maxSocPct } = o;
  const socCap = (fullKwh * Math.max(0, Math.min(100, maxSocPct))) / 100;
  if (o.curtailFromPct != null && Number.isFinite(o.curtailFromPct)) {
    // C_mid = min(maxSoc, taper − surplus): the sun that follows the charge fills the pool to the
    // taper, where the Cores start shedding it, and no further. No surplus known ⇒ the taper.
    const curtailCap = taperCeilingKwh(fullKwh, o.curtailFromPct, morningPvSurplusKwh);
    return { ceilingKwh: Math.min(socCap, curtailCap), basis: curtailCap <= socCap ? 'pv-curtail' : 'max-soc' };
  }
  const pvCap = morningPvSurplusKwh != null && Number.isFinite(morningPvSurplusKwh)
    ? fullKwh - Math.max(0, morningPvSurplusKwh)
    : null;
  const ceilingKwh = pvCap != null ? Math.min(socCap, pvCap) : socCap;
  const basis: CostCeilingBasis = pvCap != null && pvCap <= socCap ? 'pv-headroom' : 'max-soc';
  return { ceilingKwh, basis };
}

/** Which ceiling bound a cost-mode target: the morning-solar headroom under full (overnight), the
 *  owner's SoC ceiling, or — R2, a mid-day leg — the solar headroom under the charge taper. */
export type CostCeilingBasis = 'pv-headroom' | 'max-soc' | 'pv-curtail';

export function costModeTargetKwh(o: {
  fullKwh: number;
  reserveKwh: number;
  morningPvSurplusKwh: number | null | undefined;
  maxSocPct: number;
  /** The resilience target, so cost mode can never sit BELOW it. */
  resilienceTargetKwh: number;
  /** R2 — see costCeilingKwh. */
  curtailFromPct?: number | null;
}): { targetKwh: number; ceilingBasis: CostCeilingBasis } {
  const { fullKwh, reserveKwh, morningPvSurplusKwh, maxSocPct, resilienceTargetKwh } = o;
  const { ceilingKwh: ceiling, basis } = costCeilingKwh({ fullKwh, morningPvSurplusKwh, maxSocPct, curtailFromPct: o.curtailFromPct });
  // Never below the reserve floor, and never below what resilience would have asked.
  const targetKwh = Math.max(reserveKwh, resilienceTargetKwh, Math.min(ceiling, fullKwh));
  return { targetKwh: round2(targetKwh), ceilingBasis: basis };
}

/**
 * v1.187.1 — THE COST CEILING'S LOAD TERM, DE-BIASED FROM THE LEDGER.
 *
 * The cost ceiling leaves room for the morning surplus Σ max(0, P50 PV − forecast load) over
 * window close → +14 h. The forecast load is the panel's hour-of-day history curve, and it ran
 * ABOVE the measured load on every readable ledger night of 2026-09-23..29 (load_err_frac
 * −0.29 to −0.43, the actual under the load P10 on all seven; the readiness gate's loadBias
 * −0.18 over its whole forecast pool). Each
 * phantom kW of load is a kW of sun the ceiling left no room for: the 09-29 plan's 77.7%
 * ceiling bought ~18.9 kWh, the pool was full by 13:00 on 09-30 and ~9-12 kWh of PV was
 * curtailed until ~16:00.
 *
 * The factor is the MEDIAN realized/forecast load ratio (1 + load_err_frac) over the rows the
 * caller passes (the last COST_SURPLUS_LOAD_LOOKBACK_DAYS of the ledger), with three guards:
 *  - SHRINK-ONLY: capped at 1. It only ever lowers the load the surplus subtracts, so it can
 *    only widen the headroom (lower the ceiling) — never raise a buy. A ledger whose load ran
 *    at or above the forecast leaves the ceiling exactly as it was.
 *  - FEW SAMPLES: under COST_SURPLUS_LOAD_MIN_SAMPLES nights the factor is 1 (the forecast as
 *    is); from there the correction ramps in, whole at COST_SURPLUS_LOAD_FULL_SAMPLES.
 *  - BOUNDED below at COST_SURPLUS_LOAD_FACTOR_MIN: a forecast past ~1.7× the realized load is
 *    a broken input (actual_load_kwh skips telemetry gaps, so a gap under-counts it), not a
 *    bias to learn.
 * The per-hour physical floor (costSurplusLoadW) and the resilience bound
 * (debiasedCostSurplusKwh) apply on top. COST MODE ONLY: the resilience sizing, the P90 over-buy
 * flag, the long-gap P10 surplus, the islanded cushion and every alarm keep the raw forecast.
 * v1.196.0 — the surplus's other term, the P50 PV, is de-biased beside it from the same rows
 * (costSurplusPvFactor, expand-only), under the same sample ramp and the same bounds.
 */
export const COST_SURPLUS_LOAD_LOOKBACK_DAYS = 14;
export const COST_SURPLUS_LOAD_MIN_SAMPLES = 5;
export const COST_SURPLUS_LOAD_FULL_SAMPLES = 10;
export const COST_SURPLUS_LOAD_FACTOR_MIN = 0.6;

export function costSurplusLoadFactor(
  rows: ReadonlyArray<{ load_err_frac?: number | null }>,
): { factor: number; basis: 'measured' | 'default'; samples: number; medianRatio: number | null } {
  const ratios = rows
    .map((r) => r.load_err_frac)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .map((v) => 1 + v)
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  const n = ratios.length;
  if (n < COST_SURPLUS_LOAD_MIN_SAMPLES) return { factor: 1, basis: 'default', samples: n, medianRatio: null };
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  const weight = Math.min(1, n / COST_SURPLUS_LOAD_FULL_SAMPLES);
  const factor = Math.min(1, Math.max(COST_SURPLUS_LOAD_FACTOR_MIN, 1 + weight * (median - 1)));
  return {
    factor: Math.round(factor * 1000) / 1000,
    basis: 'measured',
    samples: n,
    medianRatio: Math.round(median * 1000) / 1000,
  };
}

/**
 * v1.196.0 — THE COST CEILING'S PV TERM, DE-BIASED FROM THE LEDGER, beside the load term above.
 *
 * The morning surplus is Σ max(0, P50 PV − load). v1.187.1 de-biased the load and left the P50 PV
 * as forecast, and the PV forecast is censored low on exactly the days the ceiling matters: the
 * solar fit and pvBiasFactor (analytics.ts) learn from hours when the pool was full and the Cores
 * shed their PV, so a sunny morning's P50 under-states the sun, the surplus comes out small, the
 * ceiling high, and the overnight buy fills room the sun would have filled.
 *
 * The factor is the MEDIAN realized/forecast P50 PV ratio (1 + pv_err_frac, the ledger's own
 * measure of the same 24 h P50 sum the surplus hours are part of) over the rows that measured the
 * sun and nothing else:
 *  - a forecast-tier row whose PV verdict stands (pv_verdict_set_aside null: the band was built
 *    for the Cores it was graded against) — the readiness gate's own PV pool;
 *  - not SATURATED (pv_saturated): a day whose pool reached the charge taper shed PV, so its
 *    actual measures the curtailment, not the sun. A row from before the column (NULL) counts —
 *    censoring only pulls its ratio down, toward the forecast as is;
 *  - a forecast of at least COST_SURPLUS_PV_MIN_FORECAST_KWH: a near-dark day's ratio is noise.
 * Guards, as the load factor's:
 *  - EXPAND-ONLY: at least 1. It only ever raises the PV the surplus counts, so it can only widen
 *    the headroom (lower the ceiling) — never raise a buy. A ledger whose sun ran at or under the
 *    forecast leaves the ceiling as it was;
 *  - FEW SAMPLES: under COST_SURPLUS_LOAD_MIN_SAMPLES nights the factor is 1; the correction ramps
 *    in, whole at COST_SURPLUS_LOAD_FULL_SAMPLES;
 *  - BOUNDED above at COST_SURPLUS_PV_FACTOR_MAX, and per hour never past that hour's own P90
 *    (costSurplusPvW).
 * COST MODE ONLY, through the same resilience bound (debiasedCostSurplusKwh) and the same
 * exclusions (a cushion-shortfall night, a long-gap night). The analytics PV forecast that feeds
 * the runway and every alarm is unchanged: its curtailed hours are its own question.
 */
export const COST_SURPLUS_PV_FACTOR_MAX = 1.3;
export const COST_SURPLUS_PV_MIN_FORECAST_KWH = 5;

/** The ledger fields costSurplusPvFactor reads (a NightLedgerRow). */
export interface CostSurplusPvRow {
  pv_err_frac?: number | null;
  pv_p50_kwh?: number | null;
  pv_verdict_set_aside?: string | null;
  confidence_tier?: string | null;
  pv_saturated?: number | null;
}

export function costSurplusPvFactor(
  rows: ReadonlyArray<CostSurplusPvRow>,
): { factor: number; basis: 'measured' | 'default'; samples: number; medianRatio: number | null } {
  const ratios = rows
    .filter((r) => r.confidence_tier === 'forecast' && r.pv_verdict_set_aside == null && r.pv_saturated !== 1)
    .filter((r) => typeof r.pv_p50_kwh === 'number' && Number.isFinite(r.pv_p50_kwh) && r.pv_p50_kwh >= COST_SURPLUS_PV_MIN_FORECAST_KWH)
    .map((r) => r.pv_err_frac)
    // An actual of nothing or less (err ≤ −1) is a dark fleet, not a ratio.
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > -1)
    .map((v) => 1 + v)
    .sort((a, b) => a - b);
  const samples = ratios.length;
  if (samples < COST_SURPLUS_LOAD_MIN_SAMPLES) return { factor: 1, basis: 'default', samples, medianRatio: null };
  const mid = Math.floor(samples / 2);
  const median = samples % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  const weight = Math.min(1, samples / COST_SURPLUS_LOAD_FULL_SAMPLES);
  const factor = Math.max(1, Math.min(COST_SURPLUS_PV_FACTOR_MAX, 1 + weight * (median - 1)));
  return {
    factor: Math.round(factor * 1000) / 1000,
    basis: 'measured',
    samples,
    medianRatio: Math.round(median * 1000) / 1000,
  };
}

/** v1.196.0 — one morning hour's P50 PV for the cost ceiling's surplus: × the factor, but never past
 *  the hour's own P90 (the band's best case), and never below the P50 itself. A factor of 1 or less,
 *  or a non-finite one, keeps the P50 as is. PURE. */
export function costSurplusPvW(p50W: number, p90W: number, factor: number): number {
  if (!(factor > 1) || !Number.isFinite(factor)) return p50W;
  return Math.min(p50W * factor, Math.max(p50W, Number.isFinite(p90W) ? p90W : p50W));
}

/** v1.187.1 — the trailing days the per-hour physical floor is measured over, and how many of
 *  them must carry a reading at a clock hour before that hour has a floor at all. */
export const COST_SURPLUS_FLOOR_DAYS = 7;
export const COST_SURPLUS_FLOOR_MIN_DAYS = 4;

/**
 * v1.187.1 — the PHYSICAL floor under the de-biased load: per local clock hour, the least
 * hourly-mean house load measured on any of the trailing days (`points` = the panel load in
 * hourly buckets). null for an hour seen on fewer than COST_SURPLUS_FLOOR_MIN_DAYS days — that
 * hour keeps its forecast as is (costSurplusLoadW). PURE.
 */
export function measuredHourlyLoadFloorW(
  points: ReadonlyArray<{ ts: number; value: number }>,
  hourOf: (ts: number) => number,
): Array<number | null> {
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of points) {
    if (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0) continue;
    const h = hourOf(p.ts);
    if (Number.isInteger(h) && h >= 0 && h < 24) byHour[h].push(p.value);
  }
  return byHour.map((v) => (v.length >= COST_SURPLUS_FLOOR_MIN_DAYS ? Math.min(...v) : null));
}

/**
 * v1.187.1 — one morning hour's load for the cost ceiling's surplus. PURE.
 *
 * The expected-value EV block inside the forecast (predictedEvLoadW) is kept whole: the factor
 * de-biases the house's own curve, not a predicted session. The rest is scaled by the factor,
 * but never below the hour's measured physical floor (measuredHourlyLoadFloorW) and never above
 * the forecast itself. An hour with no floor, or a factor of 1 or more, keeps the forecast as is.
 */
export function costSurplusLoadW(o: {
  loadW: number;
  evW?: number | null;
  factor: number;
  floorW: number | null | undefined;
}): number {
  const { loadW, factor, floorW } = o;
  if (!Number.isFinite(loadW) || !(factor < 1) || floorW == null || !Number.isFinite(floorW)) return loadW;
  const evW = o.evW != null && Number.isFinite(o.evW) && o.evW > 0 ? Math.min(o.evW, Math.max(0, loadW)) : 0;
  const baseW = loadW - evW;
  return Math.max(baseW * factor, Math.min(Math.max(0, floorW), baseW)) + evW;
}

/** v1.187.1 — one hour of the morning-surplus span (window close → +14 h). */
export interface MorningSurplusHour {
  p50W: number | null | undefined;
  p90W: number;
  /** The day-ahead forecast load (forecastLoadW), EV block included. */
  loadW: number;
  /** The expected-value EV block inside loadW (predictedEvLoadW). */
  evW?: number | null;
  /** The measured physical floor for this hour's clock hour, or null. */
  floorW?: number | null;
}

/**
 * v1.187.1 — the cost ceiling's morning surplus on the de-biased load: the P50, and the P90 that
 * stands in for it, over the same hours as morningPvSurplusP50Kwh / P90Kwh. PURE. Null exactly
 * where the raw figures are: no hour ⇒ both null; any hour without a finite p50W ⇒ the P50 null.
 * v1.196.0 — and on the de-biased P50 PV (`pvFactor`, costSurplusPvW). The P90 is the band's
 * best case already, and stays as forecast.
 */
export function costMorningSurplusKwh(
  hours: ReadonlyArray<MorningSurplusHour>,
  factor: number,
  pvFactor = 1,
): { p50Kwh: number | null; p90Kwh: number | null } {
  if (hours.length === 0) return { p50Kwh: null, p90Kwh: null };
  let p50Kwh = 0;
  let p90Kwh = 0;
  let p50Complete = true;
  for (const h of hours) {
    const loadW = costSurplusLoadW({ loadW: h.loadW, evW: h.evW, factor, floorW: h.floorW });
    p90Kwh += Math.max(0, h.p90W - loadW) / 1000;
    if (typeof h.p50W === 'number' && Number.isFinite(h.p50W)) p50Kwh += Math.max(0, costSurplusPvW(h.p50W, h.p90W, pvFactor) - loadW) / 1000;
    else p50Complete = false;
  }
  return { p50Kwh: p50Complete ? round2(p50Kwh) : null, p90Kwh: round2(p90Kwh) };
}

/** v1.187.1 — what index.ts hands the planner: the de-biased surplus and how it was made. */
export interface CostSurplusLoad {
  factor: number;
  basis: 'measured' | 'default';
  samples: number;
  p50Kwh: number | null;
  p90Kwh: number | null;
  /** v1.196.0 — the PV factor the P50 was de-biased by (costSurplusPvFactor) and the ledger nights
   *  behind it. Absent ⇒ 1 and 0: the P50 PV as forecast. */
  pvFactor?: number;
  pvSamples?: number;
}

/**
 * v1.187.1 (review) — the night ledger's record of the cost ceiling's surplus: the headroom
 * used, the raw one, and the load factor and ledger nights behind the difference. Without them
 * a row's cost_ceiling_soc_pct cannot say whether a 72% ceiling was de-biased, nor what the raw
 * ceiling would have been. Every field null when the plan has none (resilience mode). PURE.
 */
export function costSurplusLedgerColumns(
  plan: Pick<NightChargePlan, 'costCeilingSurplusKwh' | 'costCeilingSurplusRawKwh' | 'costSurplusLoadFactor' | 'costSurplusLoadSamples'
    | 'costSurplusPvFactor' | 'costSurplusPvSamples'>,
): {
  cost_surplus_kwh: number | null;
  cost_surplus_raw_kwh: number | null;
  cost_surplus_load_factor: number | null;
  cost_surplus_load_samples: number | null;
  cost_surplus_pv_factor: number | null;
  cost_surplus_pv_samples: number | null;
} {
  return {
    cost_surplus_kwh: plan.costCeilingSurplusKwh ?? null,
    cost_surplus_raw_kwh: plan.costCeilingSurplusRawKwh ?? null,
    cost_surplus_load_factor: plan.costSurplusLoadFactor ?? null,
    cost_surplus_load_samples: plan.costSurplusLoadSamples ?? null,
    // v1.196.0 — the PV factor beside the load factor (costSurplusPvFactor).
    cost_surplus_pv_factor: plan.costSurplusPvFactor ?? null,
    cost_surplus_pv_samples: plan.costSurplusPvSamples ?? null,
  };
}

/**
 * v1.187.22 — the night ledger's record of the EXPECTED buy and the expected SoC at the window
 * open, beside `buy_kwh` (the worst case, unchanged): what lets the scorer grade the expected
 * figure against `delivered_kwh` and the measured window-open SoC. Null when the plan has none
 * (a null plan, no P50 basis, a plan snapshot from before v1.187.22). PURE.
 */
export function expectedBuyLedgerColumns(
  plan: Pick<NightChargePlan, 'expectedBuyKwh' | 'expectedStartSocPct'>,
): { expected_buy_kwh: number | null; expected_start_soc_pct: number | null } {
  return {
    expected_buy_kwh: plan.expectedBuyKwh ?? null,
    expected_start_soc_pct: plan.expectedStartSocPct ?? null,
  };
}

/**
 * v1.187.22 — the EXPECTED buy recorded on `day`'s plan row (expected_buy_kwh), for the pushes
 * that report an armed night after the fact (the morning summary, the apply-failure warning):
 * the armed record keeps only the worst case (armFromPlan's buyKwh), and the plan row is the
 * plan that was armed. null when no row for `day` carries a finite figure. PURE.
 */
export function ledgerExpectedBuyKwh(
  rows: ReadonlyArray<{ plan_date: string; expected_buy_kwh?: number | null }>,
  day: string | null,
): number | null {
  if (day == null) return null;
  const v = rows.find((r) => r.plan_date === day)?.expected_buy_kwh;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * v1.187.1 (review) — what index.ts hands the planner as `costSurplusLoad`, end to end: the
 * ledger factor, the week's hourly floor, the morning hours and the de-biased sums. It lived
 * inline in recomputeNightChargePlan, where only source pins could reach it; it is here so the
 * gates and fallbacks are driven by tests. index.ts supplies the reads as callbacks.
 *
 * null — the planner keeps the raw surplus, today's behaviour — in resilience mode, with no
 * morning hour, under COST_SURPLUS_LOAD_MIN_SAMPLES ledger nights, or with a ledger whose load
 * ran at or above its forecast (factor 1) AND whose sun ran at or under its forecast (PV factor
 * 1, v1.196.0: costSurplusPvFactor). A ledger read that throws counts as no nights. The
 * hourly-load query runs only when the load de-bias can apply; a query that fails or returns
 * nothing leaves every hour without a floor, so on its forecast (costSurplusLoadW).
 *
 * The hours are those of index.ts's raw morning surplus: [fromMs, toMs) (window close →
 * +14 h), an hour with no day-ahead load skipped, the expected-value EV block carried whole.
 */
export async function buildCostSurplusLoad(o: {
  objectiveMode: NightChargeInputs['objectiveMode'];
  nowMs: number;
  /** The probabilistic PV hours (P50 / P90 W). Empty when there is no cheap window. */
  probHours: ReadonlyArray<{ ts: number; p50W?: number | null; p90W: number }>;
  /** The day-ahead forecast hour covering `ts`, or undefined. */
  loadAt: (ts: number) => { forecastLoadW: number; predictedEvLoadW?: number | null } | undefined;
  fromMs: number;
  toMs: number;
  /** The ledger rows over the last `days` days. */
  readLedger: (days: number) => ReadonlyArray<{ load_err_frac?: number | null } & CostSurplusPvRow>;
  /** The house panel's load in `bucketS`-second means over [fromMs, toMs), or null. */
  fetchHourlyLoad: (fromMs: number, toMs: number, bucketS: number) => Promise<ReadonlyArray<{ ts: number; value: number }> | null>;
  /** The local clock hour (0-23) of `ts` in the tariff's timezone. */
  hourOf: (ts: number) => number;
}): Promise<{ load: CostSurplusLoad; medianRatio: number | null; pvMedianRatio: number | null; floored: boolean } | null> {
  if (o.objectiveMode !== 'cost') return null;
  const hours: Array<MorningSurplusHour & { ts: number }> = [];
  for (const pb of o.probHours) {
    if (pb.ts < o.fromMs || pb.ts >= o.toMs) continue;
    const fh = o.loadAt(pb.ts);
    if (!fh) continue;
    hours.push({ ts: pb.ts, p50W: pb.p50W, p90W: pb.p90W, loadW: fh.forecastLoadW, evW: fh.predictedEvLoadW ?? 0 });
  }
  if (hours.length === 0) return null;
  let rows: ReadonlyArray<{ load_err_frac?: number | null } & CostSurplusPvRow> = [];
  try { rows = o.readLedger(COST_SURPLUS_LOAD_LOOKBACK_DAYS); } catch { rows = []; }
  const cal = costSurplusLoadFactor(rows);
  // v1.196.0 — the PV factor from the same rows: either de-bias alone builds a surplus.
  const pv = costSurplusPvFactor(rows);
  if (!(cal.factor < 1) && !(pv.factor > 1)) return null;
  let pts: ReadonlyArray<{ ts: number; value: number }> | null = null;
  if (cal.factor < 1) {
    try {
      pts = await o.fetchHourlyLoad(o.nowMs - COST_SURPLUS_FLOOR_DAYS * 24 * 3_600_000, o.nowMs, 3600);
    } catch { pts = null; }
  }
  const floorByHour = pts ? measuredHourlyLoadFloorW(pts, o.hourOf) : null;
  const deb = costMorningSurplusKwh(
    hours.map((h) => ({ ...h, floorW: floorByHour ? floorByHour[o.hourOf(h.ts)] : null })),
    cal.factor,
    pv.factor,
  );
  return {
    load: { factor: cal.factor, basis: cal.basis, samples: cal.samples, ...deb, pvFactor: pv.factor, pvSamples: pv.samples },
    medianRatio: cal.medianRatio,
    pvMedianRatio: pv.medianRatio,
    floored: floorByHour?.some((v) => v != null) === true,
  };
}

/**
 * v1.187.1 — the headroom the cost ceiling leaves, from the raw and the de-biased surplus. PURE.
 *
 * The de-biased figure is taken only where it is LARGER than the raw one (a lower ceiling, a
 * smaller buy), and never so large that the ceiling (full − headroom) falls below the
 * resilience target — unless the raw ceiling already sat below it. The force-charge stops at
 * this ceiling, so a de-bias that crossed the resilience target would stop a charge the cushion
 * asked for. Raw unknown ⇒ raw (the P90 stand-in or the max-SoC cap decide, as before).
 */
export function debiasedCostSurplusKwh(o: {
  rawKwh: number | null;
  debiasedKwh: number | null | undefined;
  fullKwh: number;
  resilienceTargetKwh: number;
}): number | null {
  const { rawKwh, debiasedKwh, fullKwh, resilienceTargetKwh } = o;
  if (rawKwh == null || !Number.isFinite(rawKwh)) return rawKwh;
  if (debiasedKwh == null || !Number.isFinite(debiasedKwh) || !(debiasedKwh > rawKwh)) return rawKwh;
  return Math.min(debiasedKwh, Math.max(rawKwh, fullKwh - resilienceTargetKwh));
}

export const DEFAULT_OUTAGE_CUSHION_HOURS = 4;
export const DEFAULT_ISLANDED_LOAD_SAFETY = 1.25;

/**
 * v1.133.0 — how the outage cushion was arrived at. Three genuinely different
 * states that a single number cannot distinguish:
 *
 *  - `islanded-outage` — sized from a measured islanded load over a bounded
 *    outage. The intended path.
 *  - `legacy-pct` — no usable islanded-load measurement, so the flat
 *    percentage-of-pool band stands in. Conservative fallback; also switches the
 *    cushion test to the whole-house forward trough.
 *  - `disabled` — the owner set the cushion to zero. NOT a measurement of zero
 *    and NOT a fallback: the plan stops sizing for an outage at all. It keeps
 *    the islanded-outage trough form, because the reserve floor is still the
 *    line being held; only the margin above it is gone.
 */
export type CushionBasis = 'islanded-outage' | 'legacy-pct' | 'disabled';

export function outageCushionKwh(o: {
  islandedLoadKw: number | null | undefined;
  outageHours: number;
  safetyFactor: number;
  dischargeEff: number;
  /** Legacy flat band, used when no islanded-load measurement is available. */
  legacyCushionKwh: number;
}): { kwh: number; basis: CushionBasis } {
  const { islandedLoadKw, outageHours, safetyFactor, dischargeEff, legacyCushionKwh } = o;

  // v1.133.0 — DELIBERATELY ZERO IS NOT THE SAME AS UNMEASURABLE.
  //
  // The pre-v1.133.0 guard folded `outageHours <= 0` into the unmeasurable
  // branch, so an owner who set the cushion to 0 h silently got the LEGACY FLAT
  // BAND instead (15% of pool = 13.8 kWh on this plant) — the option was
  // accepted, validation passed, and the setting did not take effect. Worse, the
  // legacy basis also flips the cushion test to the whole-house forward trough,
  // which is HARSHER, so asking for no cushion made the requirement larger.
  //
  // An explicit zero is a decision and is honoured as one. It is checked FIRST:
  // a disabled cushion does not depend on an islanded-load measurement, so a
  // missing measurement must not resurrect the legacy band underneath it.
  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };

  if (
    islandedLoadKw == null || !Number.isFinite(islandedLoadKw) || islandedLoadKw <= 0
    || !Number.isFinite(outageHours) || outageHours <= 0
    || !Number.isFinite(safetyFactor) || safetyFactor <= 0
    || !Number.isFinite(dischargeEff) || dischargeEff <= 0
  ) {
    return { kwh: legacyCushionKwh, basis: 'legacy-pct' };
  }
  return {
    kwh: round2((outageHours * islandedLoadKw * safetyFactor) / dischargeEff),
    basis: 'islanded-outage',
  };
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
   *  Evaluated on the plan trajectory (§3.3), never on baseline telemetry.
   *  v1.186.0 — graded on the trough the plan was SIZED against
   *  (cushionTroughSocPct vs cushionLineSocPct). null when the plan produced no
   *  trajectory, or did not record that trough (a plan issued before v1.186.0):
   *  unknown, never "held". */
  planTrajFloorBreached: boolean | null;
}

/**
 * v1.186.0 — a sizing trough this far (%-points of pool) under its line is rounding,
 * not a trajectory fault: both figures are persisted at 0.01 %, while
 * `cushionShortfall` tests the unrounded kWh with a 1e-6 tolerance. 0.05 %-pt is
 * ~46 Wh on a 92 kWh pool, and reproduces the half-step of the round1
 * `minProjSocPct` the verdict used to be graded on.
 */
export const PLAN_TRAJ_BREACH_TOLERANCE_PCT = 0.05;

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
  // floor+cushion.
  //
  // v1.186.0 — graded on the trough the plan was SIZED against, not minProjSocPct.
  // v1.125.0 split the two: minProjSocPct became the whole-house DISCLOSURE trough
  // (~0% on this plant every night) while the cushion test moved to the islanded
  // outage onset, and this line kept grading the disclosure figure against the
  // legacy flat band. Every night whose plan held the cushion was then stored as
  // plan_traj_floor_breached=1 and counted as an engine-fault strike, so the
  // readiness gate could never leave BLOCKED. On the `legacy-pct` basis the sizing
  // trough IS the whole-house trough and the line IS floor + cushionPct, so that
  // basis grades exactly as before.
  //
  // A plan that did not record its sizing trough is UNKNOWN (null) — neither a
  // strike nor a clean verdict.
  const trough = plan?.cushionTroughSocPct ?? null;
  const line = plan?.cushionLineSocPct ?? null;
  const planTrajFloorBreached =
    trough == null || line == null || !Number.isFinite(trough) || !Number.isFinite(line)
      ? null
      : trough < line - PLAN_TRAJ_BREACH_TOLERANCE_PCT;

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
 * v1.39.0: the site-clock bounds of a plan
 * date's night — the single source of truth for the SCORER's spans and for the
 * "may this night be scored yet?" completion boundary. Plan for day D covers
 * charge window [D 23:00, D+1 05:00); its plan-trajectory score span runs
 * [D+1 05:00, D+1 21:00); the night is COMPLETE — and may be outcome-captured —
 * only at/after D+1 21:00. Scoring earlier permanently freezes truncated
 * actuals into the never-pruned ledger (the pre-v1.39.0 midnight-capture
 * defect). PURE — returns null on a malformed date string.
 *
 * v1.187.0 — no on-peak span here any more. It was D 16:00-19:00: the afternoon
 * BEFORE the plan, which is issued at ~D 21:30, and on every day of the week. The
 * on-peak a plan governs follows its window and depends on the tariff calendar
 * (weekends and holidays have none), so it is resolved from the tariff model by
 * nightLedgerScoring.governedOnPeakSpan, not from the clock.
 */
/** v1.191.0 (W4) — the APS R-EV night, in minutes after the plan date's local midnight: the window
 *  D 23:00 → D+1 05:00, complete at D+1 21:00 (the close + SCORE_SPAN_AFTER_CLOSE_MS). Another plan's
 *  night is nightSchedule.ts fallbackNight. */
export const APS_FALLBACK_NIGHT: Readonly<{ windowStartMin: number; windowEndMin: number; completeMin: number }> =
  Object.freeze({ windowStartMin: 23 * 60, windowEndMin: 29 * 60, completeMin: 45 * 60 });

export function nightWindowBounds(
  planDate: string,
  night: Readonly<{ windowStartMin: number; windowEndMin: number; completeMin: number }> = APS_FALLBACK_NIGHT,
): {
  windowStartMs: number;
  windowEndMs: number;
  scoreSpanEndMs: number;
  /** The instant the night is fully observable; scoring before this is invalid. */
  completeMs: number;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate ?? '');
  if (!m) return null;
  // v1.191.0 (T10) — the plan date's local midnight in the site zone (in the default zone 07:00 UTC, the
  // fixed UTC−7 this read before). (S6) — the offsets are the schedule's: 23 / 29 / 45 h on the APS
  // preset (APS_FALLBACK_NIGHT), the plan's own nominal window otherwise.
  const dayStartUtc = siteDayStartMs(planDate);
  const scoreSpanEndMs = dayStartUtc + night.completeMin * MINUTE_MS; // APS: D+1 21:00
  return {
    windowStartMs: dayStartUtc + night.windowStartMin * MINUTE_MS, // APS: D 23:00
    windowEndMs: dayStartUtc + night.windowEndMin * MINUTE_MS,     // APS: D+1 05:00
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
