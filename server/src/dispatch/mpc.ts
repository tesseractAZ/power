/**
 * v0.9.27 — Model-Predictive Control dispatch optimizer.
 *
 * Track B. Takes our existing inputs (probabilistic PV forecast, load
 * forecast, current SoC, tariff schedule, reserve floor) and produces a
 * **recommended reserve setpoint schedule** for the next 24 hours that
 * minimizes a cost function trading off:
 *
 *   - Grid import $ at TOU rates (BAD)
 *   - Cycling degradation $ (each kWh through the pack has a $ cost
 *     based on cell aging — proxy via charge-throughput × $/kWh)
 *   - Reserve-dip risk (probability of dropping below reserve floor,
 *     weighted by a big penalty)
 *
 * We use **discrete dynamic programming** over the next 24 hours, with
 * the state being the projected SoC at each hour. At each step we
 * choose one of a few discrete reserve-setpoint actions (e.g. drop
 * reserve to 10%, hold at current, raise to 25%) and the DP finds
 * the schedule with lowest total cost.
 *
 * This is RECOMMEND-ONLY in v0.9.27 — we don't actually apply the
 * setpoint. The output is surfaced to the operator + scored against
 * what the operator would have done by default. Later releases can
 * close the loop and actually issue the writes.
 *
 * v0.9.59 — TOU-arbitrage rebuild:
 *   1. Per-hour PV/load curves (not flat-fill) are now consumed.
 *   2. `pvForecastP10` is actually read — used as a risk-averse worst-case
 *      branch when sizing grid imports for upcoming on-peak windows.
 *   3. Action set expanded beyond reserve-floor moves to include explicit
 *      `dischargeMax`, `chargeFromGrid`, and `idleHold` battery-flow actions
 *      so the planner can actually do TOU arbitrage (charge off-peak →
 *      discharge on-peak).
 *   4. `startHour` is cached once at the top of `recommendDispatch` so the DP
 *      and the reconstruction pass can't drift across a wall-clock boundary.
 *   5. New `degradeReason` output tells consumers when the planner cannot
 *      meaningfully optimize (flat forecast or no TOU spread).
 */

/**
 * Per-hour tariff fallback (¢/kWh) when `tariffOnPeakCentsByHour[h]` is missing
 * or undefined. Defaults to the operator's APS flat rate of 17 ¢/kWh; override with
 * `TARIFF_FLAT_CENTS_PER_KWH` to match the env-driven default used by
 * `index.ts` and the canonical tariff constants in `analytics.ts` (v0.9.58+).
 */
const TARIFF_FALLBACK_CENTS = Number(process.env.TARIFF_FLAT_CENTS_PER_KWH ?? 17);

/**
 * Round-trip efficiency for grid→battery→load arbitrage. ~90% is a
 * conservative LFP estimate (charger η × discharge η × cable losses).
 * Off-peak charge-from-grid only pays back when (on_peak − off_peak/η_rt)
 * × discharged_kWh > 0. With η_rt = 0.9, an 8 ¢ off-peak / 25 ¢ on-peak
 * spread leaves ~16 ¢/kWh of margin; a 17 ¢ flat tariff leaves nothing.
 */
const ROUND_TRIP_EFFICIENCY = Number(process.env.MPC_ROUND_TRIP_EFFICIENCY ?? 0.9);

/**
 * Maximum battery charge / discharge rate as a fraction of pool capacity
 * per hour. SHP2 + 4 DPUs can move ~6 kW continuous (~5% of a 120 kWh pool
 * per hour); cap the per-hour battery flow to a realistic envelope.
 */
const MAX_C_RATE = Number(process.env.MPC_MAX_C_RATE ?? 0.25);

/** Export tariff (¢/kWh) — defaults to 0 (no net-metering credit). */
const EXPORT_TARIFF_CENTS = Number(process.env.TARIFF_EXPORT_CENTS_PER_KWH ?? 0);

export type MpcAction =
  | 'lower'           // drop reserve floor (legacy)
  | 'maintain'        // hold reserve floor (legacy)
  | 'raise'           // raise reserve floor (legacy)
  | 'dischargeMax'    // discharge battery at C-rate cap to displace on-peak imports
  | 'chargeFromGrid'  // pull off-peak grid energy into the battery
  | 'idleHold';       // neither push nor pull from grid beyond PV/load balance

export type MpcDegradeReason =
  | null                // planner could optimize meaningfully
  | 'flat-forecast'     // PV+load both effectively constant — no diurnal signal
  | 'no-tou-spread';    // single tariff bin — no arbitrage opportunity

export interface MpcInputs {
  /** Now-SoC, %. */
  currentSocPct: number;
  /** Reserve floor, %. */
  reserveFloorPct: number;
  /** Pool capacity, kWh. */
  capacityKwh: number;
  /** Hourly PV forecast (kWh) for the next 24 hours, P50. */
  pvForecastP50: number[];
  /** Hourly PV forecast (kWh), P10 (pessimistic). */
  pvForecastP10: number[];
  /** Hourly load forecast (kWh) for the next 24 hours. */
  loadForecast: number[];
  /** Tariff $/kWh by hour-of-day (0..23). */
  tariffOnPeakCentsByHour: number[];
  /** Are we currently grid-tied (import available)? */
  gridAvailable: boolean;
  /** $/kWh cost of cycling — approximates lifetime cost per kWh charged. */
  cyclingCostUsdPerKwh: number;
  /** Big penalty for reserve dip ($/kWh below reserve). */
  reserveDipPenaltyUsdPerKwh: number;
}

export interface MpcStep {
  hour: number;                  // 0..23 from start
  action: MpcAction;
  recommendedReservePct: number;
  expectedSocStartPct: number;
  expectedSocEndPct: number;
  pvExpectedKwh: number;
  loadExpectedKwh: number;
  gridImportKwh: number;
  /** Energy sent to the grid this hour (export). */
  gridExportKwh: number;
  cycleEnergyKwh: number;
  hourCostUsd: number;
}

export interface MpcResult {
  steps: MpcStep[];
  totalCostUsd: number;
  /** Cost broken down by component for the operator's intuition. */
  costBreakdown: {
    gridImportUsd: number;
    /** Net of export credit (positive = revenue). */
    gridExportCreditUsd: number;
    cyclingUsd: number;
    reserveDipPenaltyUsd: number;
  };
  /** Cost vs the do-nothing baseline (keep reserve at current setpoint). */
  savingsVsBaselineUsd: number;
  /** Expected $ savings — synonym kept for older consumers. */
  expectedSavingsUsd: number;
  /** Suggested setpoint schedule — just the recommendedReservePct sequence. */
  setpointSchedule: number[];
  /** Null when the planner could optimize, otherwise why it couldn't. */
  degradeReason: MpcDegradeReason;
  notes: string[];
}

/* ─── core DP ───────────────────────────────────────────────────── */

const SOC_BUCKETS = Array.from({ length: 21 }, (_, i) => i * 5);  // 0, 5, 10, ..., 100

function nearestBucket(socPct: number): number {
  return Math.round(socPct / 5) * 5;
}

/** Action descriptor used by the DP. */
interface ActionDef {
  name: MpcAction;
  /** Reserve-floor delta applied this hour (legacy lever). */
  deltaReservePct: number;
  /**
   * Battery flow this hour beyond PV-vs-load balance, in fraction of pool
   * capacity. Positive = charge from grid (pull energy in). Negative =
   * discharge to load (push energy out, displacing imports). 0 = idle/no
   * grid flow beyond what PV imbalance forces. Capped against MAX_C_RATE.
   */
  batteryFlowFrac: number;
}

const ACTIONS: ActionDef[] = [
  { name: 'lower',          deltaReservePct: -10,  batteryFlowFrac: 0 },
  { name: 'maintain',       deltaReservePct: 0,    batteryFlowFrac: 0 },
  { name: 'raise',          deltaReservePct: +15,  batteryFlowFrac: 0 },
  { name: 'dischargeMax',   deltaReservePct: 0,    batteryFlowFrac: -MAX_C_RATE },
  { name: 'chargeFromGrid', deltaReservePct: 0,    batteryFlowFrac: +MAX_C_RATE },
  { name: 'idleHold',       deltaReservePct: 0,    batteryFlowFrac: 0 },
];

/**
 * Simulate one hour given a starting SoC + PV + load + reserve setpoint
 * + intended battery flow. Returns the ending SoC + the cost components.
 *
 * Energy balance (v0.9.64):
 *   PV + grid_import + battery_discharge = load + battery_charge + grid_export
 *
 * The `batteryFlowFrac` action controls **deliberate** battery flow (in
 * addition to whatever the natural PV/load imbalance would do):
 *   - `idleHold`/`maintain`/`raise`/`lower` (flow = 0): battery acts passively
 *     — absorbs PV surplus into storage, supplies load shortfall from storage
 *     down to the reserve floor, and grid covers any remaining gap.
 *   - `chargeFromGrid` (flow > 0): on top of passive PV absorption, pull extra
 *     grid kWh into the battery so it's pre-charged for an upcoming on-peak
 *     window. Grid import = (load shortfall after PV) + (explicit charge).
 *   - `dischargeMax` (flow < 0): deliberately drain the battery toward the
 *     load. The discharged kWh first displaces load (reducing grid imports);
 *     only if the requested discharge exceeds the load shortfall would the
 *     remainder export, so we cap the actual discharge at `loadShortfall`
 *     (we don't deliberately export-for-no-credit). C-rate, reserve floor,
 *     and physical SoC bounds are all enforced.
 *
 * Pre-v0.9.64 the simulator used `endEnergy = start + (pv - load) + flow`,
 * which double-counted the load against both passive battery drain AND the
 * explicit flow — so a `dischargeMax` selected during a load peak silently
 * dropped 15 kWh of battery energy without reducing grid import (the reserve
 * clamp re-imported it from grid). The DP correctly never picked the action
 * because it only saw downside. See test/dispatch.test.ts:563.
 *
 * Cost model:
 *   import_kwh × tariff
 * + cycle_kwh × cycling_cost
 * + reserve_dip_kwh × dip_penalty
 * − export_kwh × export_tariff             (credit, may be 0)
 *
 * `cycleKwh` is the total energy moved through the cells this hour
 * (charge + discharge, not their net), so round-tripping is correctly
 * penalized twice for cycling.
 */
function simulateHour(
  startSocPct: number,
  pvKwh: number,
  loadKwh: number,
  reservePct: number,
  batteryFlowFrac: number,
  capacityKwh: number,
  gridAvailable: boolean,
  tariffUsdPerKwh: number,
  exportTariffUsdPerKwh: number,
  cyclingCostUsdPerKwh: number,
  reserveDipPenaltyUsdPerKwh: number,
): { endSocPct: number; gridKwh: number; exportKwh: number; cycleKwh: number; cost: number } {
  const startEnergyKwh = (startSocPct / 100) * capacityKwh;
  const reserveEnergyKwh = (reservePct / 100) * capacityKwh;

  // Natural PV/load balance — PV serves load first.
  const pvToLoadKwh = Math.min(pvKwh, loadKwh);
  const pvSurplusKwh = pvKwh - pvToLoadKwh;        // >= 0 (excess PV)
  const loadShortfallKwh = loadKwh - pvToLoadKwh;  // >= 0 (load not yet met)

  // Deliberate battery flow this hour as kWh (positive = charge from grid,
  // negative = discharge to load). Capped against the C-rate envelope.
  const maxFlowKwh = MAX_C_RATE * capacityKwh;
  const requestedFlowKwh = Math.max(-maxFlowKwh, Math.min(maxFlowKwh, batteryFlowFrac * capacityKwh));

  let batteryChargeKwh = 0;
  let batteryDischargeKwh = 0;
  let gridKwh = 0;
  let exportKwh = 0;

  if (requestedFlowKwh > 0) {
    // chargeFromGrid: extra grid import lifts the battery above whatever
    // PV surplus already provides. Cap at remaining capacity.
    const roomKwh = Math.max(0, capacityKwh - startEnergyKwh);
    const pvIntoBattery = Math.min(pvSurplusKwh, roomKwh);
    const remainingRoom = roomKwh - pvIntoBattery;
    const explicitCharge = gridAvailable ? Math.min(requestedFlowKwh, remainingRoom) : 0;
    batteryChargeKwh = pvIntoBattery + explicitCharge;
    exportKwh = pvSurplusKwh - pvIntoBattery;
    // Grid covers the unmet load + the explicit charge into the battery.
    gridKwh = (gridAvailable ? loadShortfallKwh : 0) + explicitCharge;
  } else if (requestedFlowKwh < 0) {
    // dischargeMax: deliberately drain the battery toward load. Bounded by
    // available headroom above reserve and by the load shortfall (we don't
    // deliberately export for no credit; PV surplus is the only export path).
    const headroomAboveReserveKwh = Math.max(0, startEnergyKwh - reserveEnergyKwh);
    const wantedDischargeKwh = -requestedFlowKwh;
    const actualDischargeKwh = Math.min(wantedDischargeKwh, headroomAboveReserveKwh, loadShortfallKwh);
    batteryDischargeKwh = actualDischargeKwh;
    // Any PV surplus tops up battery first (subject to remaining room AFTER
    // the discharge), then exports.
    const roomAfterDischargeKwh = Math.max(0, capacityKwh - (startEnergyKwh - actualDischargeKwh));
    const pvIntoBattery = Math.min(pvSurplusKwh, roomAfterDischargeKwh);
    batteryChargeKwh = pvIntoBattery;
    exportKwh = pvSurplusKwh - pvIntoBattery;
    // Grid covers whatever load the battery didn't.
    const remainingLoadKwh = loadShortfallKwh - actualDischargeKwh;
    gridKwh = gridAvailable ? remainingLoadKwh : 0;
  } else {
    // Passive mode (legacy raise/maintain/lower/idleHold): PV surplus charges
    // the battery, load shortfall discharges the battery to the reserve floor,
    // grid fills the rest.
    const roomKwh = Math.max(0, capacityKwh - startEnergyKwh);
    const pvIntoBattery = Math.min(pvSurplusKwh, roomKwh);
    batteryChargeKwh = pvIntoBattery;
    exportKwh = pvSurplusKwh - pvIntoBattery;
    const headroomAboveReserveKwh = Math.max(0, startEnergyKwh - reserveEnergyKwh);
    const passiveDischargeKwh = Math.min(loadShortfallKwh, headroomAboveReserveKwh);
    batteryDischargeKwh = passiveDischargeKwh;
    const remainingLoadKwh = loadShortfallKwh - passiveDischargeKwh;
    gridKwh = gridAvailable ? remainingLoadKwh : 0;
  }

  let endEnergyKwh = startEnergyKwh + batteryChargeKwh - batteryDischargeKwh;

  // Off-grid safety net: when grid is unavailable and load couldn't be met
  // from PV+battery, the planner can't physically import — but the energy
  // imbalance has to land somewhere. Treat the unmet load as a reserve dip
  // (penalized below) and floor the battery at zero.
  if (endEnergyKwh < 0) endEnergyKwh = 0;
  if (endEnergyKwh > capacityKwh) {
    exportKwh += endEnergyKwh - capacityKwh;
    endEnergyKwh = capacityKwh;
  }

  // Cycle energy = total kWh moved through cells (charge + discharge).
  const cycleKwh = batteryChargeKwh + batteryDischargeKwh;

  // Reserve dip = end energy below floor (e.g. off-grid case above).
  const dipPenalty = endEnergyKwh < reserveEnergyKwh
    ? (reserveEnergyKwh - endEnergyKwh) * reserveDipPenaltyUsdPerKwh
    : 0;

  const cost =
    gridKwh * tariffUsdPerKwh
    - exportKwh * exportTariffUsdPerKwh
    + cycleKwh * cyclingCostUsdPerKwh
    + dipPenalty;

  return {
    endSocPct: nearestBucket((endEnergyKwh / capacityKwh) * 100),
    gridKwh,
    exportKwh,
    cycleKwh,
    cost,
  };
}

/** Look at the forecast horizon and tariff schedule to decide whether the
 *  problem is meaningfully optimizable. Returns the degrade reason or null. */
function detectDegradeReason(
  pvP50: number[],
  loadForecast: number[],
  tariffByHour: number[],
): MpcDegradeReason {
  // No TOU spread: every hour's tariff is within 1 ¢/kWh of every other hour.
  const tariffMin = Math.min(...tariffByHour);
  const tariffMax = Math.max(...tariffByHour);
  if (tariffMax - tariffMin < 1.0) return 'no-tou-spread';
  // Flat forecast: PV+load curves vary < 5% of their mean (no diurnal signal
  // to optimize against). Mean of zero is "flat" by definition.
  const pvMean = pvP50.reduce((a, b) => a + b, 0) / Math.max(1, pvP50.length);
  const loadMean = loadForecast.reduce((a, b) => a + b, 0) / Math.max(1, loadForecast.length);
  const pvRange = pvP50.length ? Math.max(...pvP50) - Math.min(...pvP50) : 0;
  const loadRange = loadForecast.length ? Math.max(...loadForecast) - Math.min(...loadForecast) : 0;
  const pvFlat = pvMean === 0 || pvRange / Math.max(0.01, pvMean) < 0.05;
  const loadFlat = loadMean === 0 || loadRange / Math.max(0.01, loadMean) < 0.05;
  if (pvFlat && loadFlat) return 'flat-forecast';
  return null;
}

/**
 * Run the dispatch optimizer. Returns a 24h schedule + total cost.
 */
export function recommendDispatch(inputs: MpcInputs): MpcResult {
  const H = 24;

  // v0.9.59 — cache the wall-clock start hour ONCE. The DP runs in O(H × buckets ×
  // actions) iterations; if we keep re-reading `new Date().getHours()` we can
  // straddle a wall-clock boundary mid-DP and silently mis-align tariff lookups
  // by one slot. Cache → reuse in both the forward pass and the reconstruction.
  const startHour = new Date().getHours();

  const exportTariffUsdPerKwh = EXPORT_TARIFF_CENTS / 100;

  // Detect degradation early. We still run the DP (callers want the shape),
  // but we'll surface the reason and zero out expectedSavings.
  const degradeReason = detectDegradeReason(
    inputs.pvForecastP50, inputs.loadForecast, inputs.tariffOnPeakCentsByHour,
  );

  // Precompute "next on-peak hour" lookups — used for the risk-averse P10
  // branch that decides how aggressively to charge-from-grid in advance.
  // Use the tariff schedule itself: any hour whose tariff > median tariff +
  // 2 ¢/kWh counts as on-peak.
  const sortedTariffs = [...inputs.tariffOnPeakCentsByHour].sort((a, b) => a - b);
  const medianTariffCents = sortedTariffs[Math.floor(sortedTariffs.length / 2)] ?? TARIFF_FALLBACK_CENTS;
  const isOnPeakHod = (hod: number) =>
    (inputs.tariffOnPeakCentsByHour[hod] ?? TARIFF_FALLBACK_CENTS) > medianTariffCents + 2;

  // DP forward pass. State = (hour, soc bucket). Track best cost + path.
  type Cell = {
    cost: number;
    parentSoc: number;
    parentAction: MpcAction;
    parentReserve: number;
  };
  const dp: Map<number, Cell>[] = [];
  for (let h = 0; h <= H; h++) dp.push(new Map());

  const startBucket = nearestBucket(inputs.currentSocPct);
  dp[0].set(startBucket, { cost: 0, parentSoc: -1, parentAction: 'maintain', parentReserve: inputs.reserveFloorPct });

  for (let h = 0; h < H; h++) {
    const fwd = dp[h];
    if (fwd.size === 0) continue;
    const hourOfDay = (startHour + h) % 24;
    const tariffUsdPerKwh = (inputs.tariffOnPeakCentsByHour[hourOfDay] ?? TARIFF_FALLBACK_CENTS) / 100;

    // Risk-averse branch: when we're inside an on-peak window (or one is
    // imminent in the next 3 h), use the pessimistic PV forecast so the plan
    // doesn't over-bank on a cloudy day. Otherwise use the median P50.
    let onPeakImminent = isOnPeakHod(hourOfDay);
    for (let k = 1; k <= 3 && !onPeakImminent; k++) {
      if (isOnPeakHod((hourOfDay + k) % 24)) onPeakImminent = true;
    }
    const pvForThisHour = onPeakImminent
      ? (inputs.pvForecastP10[h] ?? inputs.pvForecastP50[h] ?? 0)
      : (inputs.pvForecastP50[h] ?? 0);
    const load = inputs.loadForecast[h] ?? 0;

    for (const [socStart, cell] of fwd) {
      for (const action of ACTIONS) {
        const newReserve = Math.max(0, Math.min(50, inputs.reserveFloorPct + action.deltaReservePct));
        const sim = simulateHour(
          socStart, pvForThisHour, load, newReserve, action.batteryFlowFrac,
          inputs.capacityKwh, inputs.gridAvailable,
          tariffUsdPerKwh, exportTariffUsdPerKwh,
          inputs.cyclingCostUsdPerKwh, inputs.reserveDipPenaltyUsdPerKwh,
        );
        const newTotalCost = cell.cost + sim.cost;
        const existing = dp[h + 1].get(sim.endSocPct);
        if (!existing || newTotalCost < existing.cost) {
          dp[h + 1].set(sim.endSocPct, {
            cost: newTotalCost,
            parentSoc: socStart,
            parentAction: action.name,
            parentReserve: newReserve,
          });
        }
      }
    }
  }

  // Find the cheapest endpoint at h=H.
  let bestEnd: { soc: number; cell: Cell } | null = null;
  for (const [soc, cell] of dp[H]) {
    if (!bestEnd || cell.cost < bestEnd.cell.cost) {
      bestEnd = { soc, cell };
    }
  }
  if (!bestEnd) {
    return {
      steps: [],
      totalCostUsd: 0,
      costBreakdown: { gridImportUsd: 0, gridExportCreditUsd: 0, cyclingUsd: 0, reserveDipPenaltyUsd: 0 },
      savingsVsBaselineUsd: 0,
      expectedSavingsUsd: 0,
      setpointSchedule: [],
      degradeReason,
      notes: ['DP found no feasible schedule'],
    };
  }

  // Walk back to reconstruct the schedule.
  const reverseSteps: {
    socStart: number;
    socEnd: number;
    action: MpcAction;
    reserve: number;
  }[] = [];
  let curSoc = bestEnd.soc;
  for (let h = H; h > 0; h--) {
    const cell = dp[h].get(curSoc)!;
    reverseSteps.push({
      socStart: cell.parentSoc, socEnd: curSoc,
      action: cell.parentAction, reserve: cell.parentReserve,
    });
    curSoc = cell.parentSoc;
  }
  reverseSteps.reverse();

  // Re-simulate forward to gather per-hour details.
  const steps: MpcStep[] = [];
  let gridImportUsd = 0, gridExportCreditUsd = 0, cyclingUsd = 0, reserveDipUsd = 0;
  for (let h = 0; h < H; h++) {
    const s = reverseSteps[h];
    const hourOfDay = (startHour + h) % 24;
    // Use the P50 curve for the public, "what we expect" view — the P10 was
    // only for cost-shaping during planning.
    const pv = inputs.pvForecastP50[h] ?? 0;
    const load = inputs.loadForecast[h] ?? 0;
    const tariffUsdPerKwh = (inputs.tariffOnPeakCentsByHour[hourOfDay] ?? TARIFF_FALLBACK_CENTS) / 100;
    const actionDef = ACTIONS.find((a) => a.name === s.action)!;
    const sim = simulateHour(
      s.socStart, pv, load, s.reserve, actionDef.batteryFlowFrac,
      inputs.capacityKwh, inputs.gridAvailable,
      tariffUsdPerKwh, exportTariffUsdPerKwh,
      inputs.cyclingCostUsdPerKwh, inputs.reserveDipPenaltyUsdPerKwh,
    );
    const reserveEnergyKwh = (s.reserve / 100) * inputs.capacityKwh;
    const endEnergyKwh = (sim.endSocPct / 100) * inputs.capacityKwh;
    const dip = endEnergyKwh < reserveEnergyKwh ? reserveEnergyKwh - endEnergyKwh : 0;
    gridImportUsd += sim.gridKwh * tariffUsdPerKwh;
    gridExportCreditUsd += sim.exportKwh * exportTariffUsdPerKwh;
    cyclingUsd += sim.cycleKwh * inputs.cyclingCostUsdPerKwh;
    reserveDipUsd += dip * inputs.reserveDipPenaltyUsdPerKwh;
    steps.push({
      hour: h,
      action: s.action,
      recommendedReservePct: s.reserve,
      expectedSocStartPct: s.socStart,
      expectedSocEndPct: sim.endSocPct,
      pvExpectedKwh: pv,
      loadExpectedKwh: load,
      gridImportKwh: sim.gridKwh,
      gridExportKwh: sim.exportKwh,
      cycleEnergyKwh: sim.cycleKwh,
      hourCostUsd: sim.cost,
    });
  }

  // Baseline = always maintain current reserve floor, no explicit arbitrage flow.
  let baselineSoc = nearestBucket(inputs.currentSocPct);
  let baselineCost = 0;
  for (let h = 0; h < H; h++) {
    const hourOfDay = (startHour + h) % 24;
    const pv = inputs.pvForecastP50[h] ?? 0;
    const load = inputs.loadForecast[h] ?? 0;
    const tariffUsdPerKwh = (inputs.tariffOnPeakCentsByHour[hourOfDay] ?? TARIFF_FALLBACK_CENTS) / 100;
    const sim = simulateHour(
      baselineSoc, pv, load, inputs.reserveFloorPct, 0,
      inputs.capacityKwh, inputs.gridAvailable,
      tariffUsdPerKwh, exportTariffUsdPerKwh,
      inputs.cyclingCostUsdPerKwh, inputs.reserveDipPenaltyUsdPerKwh,
    );
    baselineSoc = sim.endSocPct;
    baselineCost += sim.cost;
  }

  const rawSavings = baselineCost - bestEnd.cell.cost;
  // When the planner detected no useful structure, zero the headline savings
  // so consumers don't show "$0.01 saved" when the DP is essentially noise.
  const expectedSavingsUsd = degradeReason ? 0 : rawSavings;

  const notes: string[] = [
    `Optimized 24 h schedule via dynamic programming (${SOC_BUCKETS.length} SoC buckets × ${ACTIONS.length} actions)`,
    `Baseline (no MPC) projected cost: $${baselineCost.toFixed(2)}; optimized: $${bestEnd.cell.cost.toFixed(2)}`,
    `Round-trip efficiency assumed: ${(ROUND_TRIP_EFFICIENCY * 100).toFixed(0)}%; C-rate cap: ${(MAX_C_RATE * 100).toFixed(0)}%/h`,
  ];
  if (degradeReason === 'no-tou-spread') {
    notes.push('No TOU spread detected — every hour has the same tariff, so charge/discharge arbitrage cannot save money. Reporting $0 expected savings.');
  } else if (degradeReason === 'flat-forecast') {
    notes.push('PV + load forecasts are effectively flat (no diurnal signal). Planner has no shape to optimize against; reporting $0 expected savings.');
  }

  return {
    steps,
    totalCostUsd: bestEnd.cell.cost,
    costBreakdown: {
      gridImportUsd,
      gridExportCreditUsd,
      cyclingUsd,
      reserveDipPenaltyUsd: reserveDipUsd,
    },
    savingsVsBaselineUsd: rawSavings,
    expectedSavingsUsd,
    setpointSchedule: steps.map((s) => s.recommendedReservePct),
    degradeReason,
    notes,
  };
}
