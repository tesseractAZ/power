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

const HOUR_MS = 3_600_000;

/** One hour of the CONSERVATIVE forecast the planner sizes against. PV is the
 *  P10 (pessimistic-low) band; load is the P90 (pessimistic-high) band with any
 *  committed-EV block already folded in upstream and de-duplicated against the
 *  base curve (design §2.3). Both in WATTS, ts hour-aligned. */
export interface NightChargeHour {
  ts: number;
  pvP10W: number;
  loadP90W: number;
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
  /** calScoredDays ≥ N_MIN AND band coverage ≥ 0.9 AND forecast present. */
  basisComplete: boolean;

  /** Below this buy, treat the night as "hold" (no meaningful charge). kWh. */
  minBuyKwh: number;
}

export type BindingCap =
  | 'requirement' // buy met the resilience requirement exactly
  | 'chargePower' // capped below requirement by the hardware charge rate
  | 'poolHeadroom' // capped below requirement by pool capacity
  | 'overBuy' // requirement itself exceeds morning-PV headroom (clip accepted)
  | null;

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
  /** Target pack SoC % to reach by window end (05:00). null when incomplete. */
  targetSocPct: number | null;
  /** Pack-kWh the buy must ADD at the trough to hold floor+cushion. */
  requiredExtraKwh: number | null;
  /** Why buyKwh is what it is (which cap bound). */
  bindingCap: BindingCap;
  /** true when charge-power / pool caps prevented reaching floor+cushion —
   *  the cushion is NOT fully met and residual risk remains (surfaced honestly). */
  cushionShortfall: boolean;

  /** Simulated PLAN-trajectory minimum SoC % over [windowEnd, nextRecharge]
   *  WITH the buy applied — the number the learning ledger scores its
   *  floor-breach verdict on (design §3.3), not raw baseline telemetry. */
  minProjSocPct: number | null;
  minProjSocTsMs: number | null;
  /** The no-buy baseline trough (what WOULD happen without the recommendation). */
  baselineMinSocPct: number | null;

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
    requiredExtraKwh: null,
    bindingCap: null,
    cushionShortfall: false,
    minProjSocPct: null,
    minProjSocTsMs: null,
    baselineMinSocPct: null,
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
    legEff, dischargeEff, chargeCapKw, window, horizon,
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
  if (horizon.length === 0) return nullPlan(inputs, false, 'No plan — empty forecast horizon.');

  const fullWh = fullKwh * 1000;
  const reserveKwh = (fullKwh * reserveFloorPct) / 100;
  const cushionKwh = (fullKwh * cushionPct) / 100;
  const targetFloorKwh = reserveKwh + cushionKwh; // the line the trough must hold

  const socNowKwh = (fullKwh * socNowPct) / 100;
  const windowStart = window.startMs;
  const windowEnd = window.endMs;
  const windowHours = (windowEnd - windowStart) / HOUR_MS;

  // Split the horizon: pre-window carry (now→windowStart), the window hours
  // (billed load happens even while grid-charging), and the post-window horizon.
  const preWindow = horizon.filter((h) => h.ts >= nowMs && h.ts < windowStart);
  const windowHrs = horizon.filter((h) => h.ts >= windowStart && h.ts < windowEnd);
  // The scored trajectory runs from window-end forward (the buy tops the pack at
  // 05:00; the pre-window trough is a TONIGHT concern the alarm owns, not
  // something a 23:00 buy can fix).
  const postAndWindow = horizon.filter((h) => h.ts >= windowStart);

  // ── §2.2 step 1–2: NO-BUY baseline. Carry SoC_now from now to next recharge;
  // record the trough over [windowEnd, end]. ──
  const baseline = simulate(socNowKwh, fullKwh, horizon.filter((h) => h.ts >= nowMs), dischargeEff, windowEnd, windowEnd);
  const packAtWindowEnd_noBuy = baseline.packAtMarkKwh; // pack entering 05:00, no buy
  const minPost_noBuy = baseline.minPackKwh;
  const baselineMinSocPct = round1((minPost_noBuy / fullKwh) * 100);

  // ── §2.2 step 3: required pack-kWh lift so the trough holds floor+cushion ──
  const requiredExtraKwh = Math.max(0, targetFloorKwh - minPost_noBuy);

  // No shortfall projected → HOLD (no buy). Honest "you don't need to charge".
  if (requiredExtraKwh <= 1e-9) {
    return {
      ...nullPlan(inputs, true, `Hold — projected overnight trough (${baselineMinSocPct}%) stays at/above the ${round1(reserveFloorPct + cushionPct)}% floor+cushion; no charge needed.`),
      objective: 'none',
      buyKwh: 0,
      requiredExtraKwh: 0,
      targetSocPct: round1((packAtWindowEnd_noBuy / fullKwh) * 100),
      minProjSocPct: baselineMinSocPct,
      minProjSocTsMs: baseline.minTsMs,
      baselineMinSocPct,
    };
  }

  // ── Caps (design §2.2). Which cap bounds the achievable lift. ──
  // Charge-power feasibility: over the window the grid can deliver at most
  // chargeCapKw·windowHours; the house load during the window is served first,
  // and only legEff of what reaches the charger is stored in the pack.
  const windowLoadKwh = windowHrs.reduce((s, h) => s + h.loadP90W / 1000, 0);
  const maxGridKwh = chargeCapKw * windowHours;
  const chargePowerLiftKwh = Math.max(0, (maxGridKwh - windowLoadKwh) * legEff);

  // Pool headroom: cannot lift the pack past full.
  const poolHeadroomLiftKwh = Math.max(0, fullKwh - packAtWindowEnd_noBuy);

  // The achievable lift is the requirement, bounded by the two HARD caps.
  let liftKwh = requiredExtraKwh;
  let bindingCap: BindingCap = 'requirement';
  if (chargePowerLiftKwh < liftKwh) { liftKwh = chargePowerLiftKwh; bindingCap = 'chargePower'; }
  if (poolHeadroomLiftKwh < liftKwh) { liftKwh = poolHeadroomLiftKwh; bindingCap = 'poolHeadroom'; }
  const cushionShortfall = liftKwh < requiredExtraKwh - 1e-6; // caps prevented meeting floor+cushion

  // Over-buy ceiling: if the (resilience-required) target pushes the pack above
  // full − P90 morning surplus, morning PV will clip. Resilience WINS — we keep
  // the buy — but flag it so the operator/ledger see the accepted clip.
  const targetPackKwh_pre = packAtWindowEnd_noBuy + liftKwh;
  if (
    morningPvSurplusP90Kwh != null &&
    targetPackKwh_pre > fullKwh - morningPvSurplusP90Kwh + 1e-6 &&
    !cushionShortfall
  ) {
    bindingCap = 'overBuy';
  }

  // ── §2.2 step 3 (near-saturation): if the buy pushes the pack near full, the
  // additive-offset assumption breaks (clamping loses lift). Re-simulate the
  // post-window trajectory WITH the buy applied to get the exact trough. ──
  const targetPackKwh = Math.min(fullKwh, packAtWindowEnd_noBuy + liftKwh);
  const withBuy = simulate(targetPackKwh, fullKwh, postAndWindow.filter((h) => h.ts >= windowEnd), dischargeEff, windowEnd, windowEnd);
  const minProjKwh = withBuy.minPackKwh;
  const minProjSocPct = round1((minProjKwh / fullKwh) * 100);

  const buyKwh = liftKwh / legEff; // meter sees more than the pack stores
  const targetSocPct = round1((targetPackKwh / fullKwh) * 100);
  const chargeTonight = buyKwh >= minBuyKwh;

  const rationale = chargeTonight
    ? `Buy ~${round1(buyKwh)} kWh overnight → target ${targetSocPct}% by ${fmtLocalHint(windowEnd)}. Without it the P10-PV/P90-load trough falls to ~${baselineMinSocPct}% (floor+cushion is ${round1(reserveFloorPct + cushionPct)}%).${cushionShortfall ? ' NOTE: charge/pool caps prevent fully meeting the cushion — residual risk remains.' : ''}${bindingCap === 'overBuy' ? ' NOTE: buy exceeds morning-PV headroom; a small clip is accepted to hold resilience.' : ''}`
    : `Hold — the projected shortfall (${round1(buyKwh)} kWh) is below the ${round1(minBuyKwh)} kWh minimum-buy threshold; no meaningful charge.`;

  return {
    generatedAt: nowMs,
    basisComplete: true,
    objective: chargeTonight ? 'resilience_cushion' : 'none',
    chargeTonight,
    buyKwh: round2(buyKwh),
    targetSocPct,
    requiredExtraKwh: round2(requiredExtraKwh),
    bindingCap,
    cushionShortfall,
    minProjSocPct,
    minProjSocTsMs: withBuy.minTsMs,
    baselineMinSocPct,
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
