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
 */

/**
 * Per-hour tariff fallback (¢/kWh) when `tariffOnPeakCentsByHour[h]` is missing
 * or undefined. Defaults to the operator's APS flat rate of 17 ¢/kWh; override with
 * `TARIFF_FLAT_CENTS_PER_KWH` to match the env-driven default used by
 * `index.ts` and the canonical tariff constants in `analytics.ts` (v0.9.58+).
 */
const TARIFF_FALLBACK_CENTS = Number(process.env.TARIFF_FLAT_CENTS_PER_KWH ?? 17);

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
  action: 'maintain' | 'raise' | 'lower';
  recommendedReservePct: number;
  expectedSocStartPct: number;
  expectedSocEndPct: number;
  pvExpectedKwh: number;
  loadExpectedKwh: number;
  gridImportKwh: number;
  cycleEnergyKwh: number;
  hourCostUsd: number;
}

export interface MpcResult {
  steps: MpcStep[];
  totalCostUsd: number;
  /** Cost broken down by component for the operator's intuition. */
  costBreakdown: {
    gridImportUsd: number;
    cyclingUsd: number;
    reserveDipPenaltyUsd: number;
  };
  /** Cost vs the do-nothing baseline (keep reserve at current setpoint). */
  savingsVsBaselineUsd: number;
  /** Suggested setpoint schedule — just the recommendedReservePct sequence. */
  setpointSchedule: number[];
  notes: string[];
}

/* ─── core DP ───────────────────────────────────────────────────── */

interface DpState {
  socPct: number;            // discretized to 5% buckets
  totalCost: number;
  parentAction?: 'maintain' | 'raise' | 'lower';
  parentReserve?: number;
}

const SOC_BUCKETS = Array.from({ length: 21 }, (_, i) => i * 5);  // 0, 5, 10, ..., 100

function nearestBucket(socPct: number): number {
  return Math.round(socPct / 5) * 5;
}

/**
 * Simulate one hour given a starting SoC + PV + load + reserve setpoint.
 * Returns the ending SoC + the cost components for the hour.
 */
function simulateHour(
  startSocPct: number,
  pvKwh: number,
  loadKwh: number,
  reservePct: number,
  capacityKwh: number,
  gridAvailable: boolean,
  tariffUsdPerKwh: number,
  cyclingCostUsdPerKwh: number,
  reserveDipPenaltyUsdPerKwh: number,
): { endSocPct: number; gridKwh: number; cycleKwh: number; cost: number } {
  const startEnergyKwh = (startSocPct / 100) * capacityKwh;
  const netSurplusKwh = pvKwh - loadKwh;       // positive = excess solar
  let endEnergyKwh = startEnergyKwh + netSurplusKwh;
  let gridKwh = 0;
  let cycleKwh = 0;
  // We charge / discharge to maintain reserve when possible.
  const reserveEnergyKwh = (reservePct / 100) * capacityKwh;

  // If we'd go below reserve and grid is available, pull from grid.
  if (endEnergyKwh < reserveEnergyKwh && gridAvailable) {
    const shortfall = reserveEnergyKwh - endEnergyKwh;
    gridKwh = shortfall;
    endEnergyKwh = reserveEnergyKwh;
  }
  // Cap at capacity (excess solar wasted / clipped).
  if (endEnergyKwh > capacityKwh) {
    endEnergyKwh = capacityKwh;
  }
  // Cycle energy is the absolute change.
  cycleKwh = Math.abs(endEnergyKwh - startEnergyKwh);
  // Penalty for dipping below reserve.
  let dipPenalty = 0;
  if (endEnergyKwh < reserveEnergyKwh) {
    dipPenalty = (reserveEnergyKwh - endEnergyKwh) * reserveDipPenaltyUsdPerKwh;
  }
  const cost =
    gridKwh * tariffUsdPerKwh +
    cycleKwh * cyclingCostUsdPerKwh +
    dipPenalty;
  return {
    endSocPct: nearestBucket((endEnergyKwh / capacityKwh) * 100),
    gridKwh, cycleKwh, cost,
  };
}

/**
 * Run the dispatch optimizer. Returns a 24h schedule + total cost.
 */
export function recommendDispatch(inputs: MpcInputs): MpcResult {
  const H = 24;
  // Reserve action set — relative changes from current floor.
  const actions: Array<{ name: MpcStep['action']; deltaPct: number }> = [
    { name: 'lower',    deltaPct: -10 },
    { name: 'maintain', deltaPct: 0 },
    { name: 'raise',    deltaPct: +15 },
  ];

  // DP forward pass. State = (hour, soc bucket). Track best cost + path.
  // dp[h][socBucket] = { totalCost, parent action, parent reserve, parent soc }
  type Cell = { cost: number; parentSoc: number; parentAction: MpcStep['action']; parentReserve: number };
  const dp: Map<number, Cell>[] = [];
  for (let h = 0; h <= H; h++) dp.push(new Map());
  // Initial state
  const startBucket = nearestBucket(inputs.currentSocPct);
  dp[0].set(startBucket, { cost: 0, parentSoc: -1, parentAction: 'maintain', parentReserve: inputs.reserveFloorPct });

  for (let h = 0; h < H; h++) {
    const fwd = dp[h];
    if (fwd.size === 0) continue;
    const hourOfDay = (new Date().getHours() + h) % 24;
    const pv = inputs.pvForecastP50[h] ?? 0;
    const load = inputs.loadForecast[h] ?? 0;
    const tariffUsdPerKwh = (inputs.tariffOnPeakCentsByHour[hourOfDay] ?? TARIFF_FALLBACK_CENTS) / 100;
    for (const [socStart, cell] of fwd) {
      for (const action of actions) {
        const newReserve = Math.max(0, Math.min(50, inputs.reserveFloorPct + action.deltaPct));
        const sim = simulateHour(
          socStart, pv, load, newReserve, inputs.capacityKwh,
          inputs.gridAvailable, tariffUsdPerKwh,
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
      costBreakdown: { gridImportUsd: 0, cyclingUsd: 0, reserveDipPenaltyUsd: 0 },
      savingsVsBaselineUsd: 0,
      setpointSchedule: [],
      notes: ['DP found no feasible schedule'],
    };
  }

  // Walk back to reconstruct the schedule.
  const reverseSteps: { socStart: number; socEnd: number; action: MpcStep['action']; reserve: number }[] = [];
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
  let gridImportUsd = 0, cyclingUsd = 0, reserveDipUsd = 0;
  for (let h = 0; h < H; h++) {
    const s = reverseSteps[h];
    const hourOfDay = (new Date().getHours() + h) % 24;
    const pv = inputs.pvForecastP50[h] ?? 0;
    const load = inputs.loadForecast[h] ?? 0;
    const tariffUsdPerKwh = (inputs.tariffOnPeakCentsByHour[hourOfDay] ?? TARIFF_FALLBACK_CENTS) / 100;
    const sim = simulateHour(
      s.socStart, pv, load, s.reserve, inputs.capacityKwh,
      inputs.gridAvailable, tariffUsdPerKwh,
      inputs.cyclingCostUsdPerKwh, inputs.reserveDipPenaltyUsdPerKwh,
    );
    const reserveEnergyKwh = (s.reserve / 100) * inputs.capacityKwh;
    const endEnergyKwh = (sim.endSocPct / 100) * inputs.capacityKwh;
    const dip = endEnergyKwh < reserveEnergyKwh ? reserveEnergyKwh - endEnergyKwh : 0;
    gridImportUsd += sim.gridKwh * tariffUsdPerKwh;
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
      cycleEnergyKwh: sim.cycleKwh,
      hourCostUsd: sim.cost,
    });
  }

  // Baseline = always maintain current reserve floor.
  let baselineSoc = nearestBucket(inputs.currentSocPct);
  let baselineCost = 0;
  for (let h = 0; h < H; h++) {
    const hourOfDay = (new Date().getHours() + h) % 24;
    const pv = inputs.pvForecastP50[h] ?? 0;
    const load = inputs.loadForecast[h] ?? 0;
    const tariffUsdPerKwh = (inputs.tariffOnPeakCentsByHour[hourOfDay] ?? TARIFF_FALLBACK_CENTS) / 100;
    const sim = simulateHour(
      baselineSoc, pv, load, inputs.reserveFloorPct, inputs.capacityKwh,
      inputs.gridAvailable, tariffUsdPerKwh,
      inputs.cyclingCostUsdPerKwh, inputs.reserveDipPenaltyUsdPerKwh,
    );
    baselineSoc = sim.endSocPct;
    baselineCost += sim.cost;
  }

  return {
    steps,
    totalCostUsd: bestEnd.cell.cost,
    costBreakdown: {
      gridImportUsd, cyclingUsd, reserveDipPenaltyUsd: reserveDipUsd,
    },
    savingsVsBaselineUsd: baselineCost - bestEnd.cell.cost,
    setpointSchedule: steps.map((s) => s.recommendedReservePct),
    notes: [
      `Optimized 24 h schedule via dynamic programming (${SOC_BUCKETS.length} SoC buckets × ${actions.length} actions)`,
      `Baseline (no MPC) projected cost: $${baselineCost.toFixed(2)}; optimized: $${bestEnd.cell.cost.toFixed(2)}`,
    ],
  };
}
