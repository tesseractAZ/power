/**
 * v0.9.27 — LFP (lithium iron phosphate) Open-Circuit Voltage curve.
 *
 * Track C (physics-informed hybrid). The Delta Pro Ultra packs are LFP
 * chemistry — confirmed by their nameplate + the cell voltage range
 * we see (3.0-3.6 V per cell). LFP has a famously FLAT discharge
 * curve, which is normally a pain (hard to estimate SoC from V) but
 * also means small deviations from the canonical curve are diagnostic:
 *
 *   - **Cell drift**: one cell's OCV diverging from siblings under no
 *     load → imbalance / capacity fade in that cell
 *   - **OCV vs reported SoC mismatch**: BMS-reported SoC drifting from
 *     physics-implied SoC under resting conditions → SoH miscalibration
 *
 * We embed the canonical 16-cell LFP discharge curve as a small lookup
 * table (16 V endpoints; intermediate via linear interpolation). The
 * curve is for a single cell at 25°C resting (no load). At pack level,
 * the DPU runs 16 cells in series — 51.2 V nominal, 48.0 V min,
 * 57.6 V max — so we scale by 16 for pack-level comparison.
 *
 * Note: this curve is for STATIC (rested) conditions. Under load, the
 * IR drop adds 50-200 mV depending on current, so a "rested" SoC
 * estimate requires the pack to have been idle for 10+ minutes. We
 * apply this only when we can detect a low-current state.
 *
 * Source: typical LFP datasheets (LiFePO4 18650 / prismatic cell
 * discharge curves). The shape is consistent across manufacturers.
 */

/** Per-cell OCV samples at SoC = 0..100 in 5% increments, 25°C, rested.
 *  These are typical LFP values; not specific to EcoFlow but consistent
 *  with the voltages we observe. */
const LFP_OCV_TABLE_25C: Array<[number, number]> = [
  // [soc%, V_cell]
  [0,    2.50],
  [5,    3.15],
  [10,   3.20],
  [15,   3.22],
  [20,   3.25],
  [25,   3.27],
  [30,   3.28],
  [35,   3.29],
  [40,   3.30],
  [45,   3.30],
  [50,   3.31],
  [55,   3.31],
  [60,   3.32],
  [65,   3.32],
  [70,   3.33],
  [75,   3.33],
  [80,   3.34],
  [85,   3.35],
  [90,   3.36],
  [95,   3.40],
  [100,  3.55],
];

const CELLS_IN_SERIES = 16;        // DPU pack architecture
const RESTING_CURRENT_THRESHOLD_A = 0.5;
const RESTING_AGE_MIN_MS = 10 * 60 * 1000;  // 10 minutes idle

/** Linear interpolation in the OCV table. Voltage may be pack-level
 *  (V) or per-cell (V); pass `perCell=true` for cell-level input. */
export function socFromOcv(voltsTotal: number, perCell = false): number | null {
  const vCell = perCell ? voltsTotal : voltsTotal / CELLS_IN_SERIES;
  if (!Number.isFinite(vCell)) return null;
  // Clamp to table range
  if (vCell <= LFP_OCV_TABLE_25C[0][1]) return 0;
  if (vCell >= LFP_OCV_TABLE_25C[LFP_OCV_TABLE_25C.length - 1][1]) return 100;
  // Find the bracket and interpolate
  for (let i = 1; i < LFP_OCV_TABLE_25C.length; i++) {
    const [soc1, v1] = LFP_OCV_TABLE_25C[i - 1];
    const [soc2, v2] = LFP_OCV_TABLE_25C[i];
    if (vCell >= v1 && vCell <= v2) {
      // Note: voltage isn't strictly monotonic at the very flat midrange
      // — neighboring points can be equal. Handle by mid-bracket fallback.
      if (v2 === v1) return (soc1 + soc2) / 2;
      const frac = (vCell - v1) / (v2 - v1);
      return soc1 + frac * (soc2 - soc1);
    }
  }
  return null;
}

/** Inverse — given SoC %, return per-cell OCV. Used for fault-injection
 *  in tests + for projecting "what cell voltage should we see at SoC X?" */
export function ocvFromSoc(socPct: number, perCell = true): number {
  const clamped = Math.max(0, Math.min(100, socPct));
  for (let i = 1; i < LFP_OCV_TABLE_25C.length; i++) {
    const [soc1, v1] = LFP_OCV_TABLE_25C[i - 1];
    const [soc2, v2] = LFP_OCV_TABLE_25C[i];
    if (clamped >= soc1 && clamped <= soc2) {
      if (soc2 === soc1) return perCell ? v1 : v1 * CELLS_IN_SERIES;
      const frac = (clamped - soc1) / (soc2 - soc1);
      const v = v1 + frac * (v2 - v1);
      return perCell ? v : v * CELLS_IN_SERIES;
    }
  }
  const last = LFP_OCV_TABLE_25C[LFP_OCV_TABLE_25C.length - 1][1];
  return perCell ? last : last * CELLS_IN_SERIES;
}

/* ─── pack analysis ──────────────────────────────────────────────── */

export interface LfpAnalysis {
  /** SoC implied by physics (rested OCV → curve). Null if not in a rest state. */
  physicsSoCPct: number | null;
  /** SoC the BMS reports. */
  reportedSoCPct: number | null;
  /** Difference (physics - reported). Positive = BMS under-reports SoC. */
  socDriftPct: number | null;
  /** Is the pack effectively at rest (low current, idle a while)? */
  isResting: boolean;
  /** Pack voltage (mV) used for the analysis. */
  packVoltageMv: number | null;
  /** Cell voltage spread within the pack (mV) — separate signal,
   *  large spread → imbalance. */
  cellSpreadMv: number | null;
  /** Per-cell deviation from the median, in mV. Helps spot a single bad cell. */
  cellDeviationsMv: number[] | null;
  /** Confidence the analysis is meaningful (0..1). Drops when the pack
   *  wasn't resting or when we have only sparse cell readings. */
  confidence: number;
  notes: string[];
}

export interface LfpAnalysisInputs {
  packVoltageMv: number | null;
  reportedSoCPct: number | null;
  cellVoltagesMv: number[];
  packCurrentA: number | null;
  lastNonRestingAtMs: number | null;
  nowMs?: number;
}

export function analyzePackLfp(inputs: LfpAnalysisInputs): LfpAnalysis {
  const now = inputs.nowMs ?? Date.now();
  const notes: string[] = [];

  // Determine resting state: current must be low for at least RESTING_AGE_MIN_MS.
  const lowCurrent = inputs.packCurrentA != null && Math.abs(inputs.packCurrentA) <= RESTING_CURRENT_THRESHOLD_A;
  const idleLongEnough = inputs.lastNonRestingAtMs == null
    ? false
    : (now - inputs.lastNonRestingAtMs) >= RESTING_AGE_MIN_MS;
  const isResting = lowCurrent && idleLongEnough;
  if (!lowCurrent) notes.push(`current ${inputs.packCurrentA?.toFixed(2)} A > ${RESTING_CURRENT_THRESHOLD_A} A threshold`);
  if (!idleLongEnough) notes.push('pack hasn\'t been idle long enough for OCV to settle');

  // Physics SoC only meaningful while resting.
  const physicsSoCPct = isResting && inputs.packVoltageMv != null
    ? socFromOcv(inputs.packVoltageMv / 1000)
    : null;
  const socDriftPct = (physicsSoCPct != null && inputs.reportedSoCPct != null)
    ? physicsSoCPct - inputs.reportedSoCPct
    : null;

  // Cell spread + deviations are always meaningful (don't require rest).
  let cellSpreadMv: number | null = null;
  let cellDeviationsMv: number[] | null = null;
  if (inputs.cellVoltagesMv.length > 0) {
    const sorted = [...inputs.cellVoltagesMv].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    cellSpreadMv = sorted[sorted.length - 1] - sorted[0];
    cellDeviationsMv = inputs.cellVoltagesMv.map((v) => v - median);
  } else {
    notes.push('no per-cell voltage readings available');
  }

  // Confidence: highest when resting + we have cell voltages.
  let confidence = 0;
  if (isResting) confidence += 0.5;
  if (cellDeviationsMv && cellDeviationsMv.length >= CELLS_IN_SERIES / 2) confidence += 0.3;
  if (inputs.packVoltageMv != null) confidence += 0.2;
  confidence = Math.min(1, confidence);

  return {
    physicsSoCPct,
    reportedSoCPct: inputs.reportedSoCPct,
    socDriftPct,
    isResting,
    packVoltageMv: inputs.packVoltageMv,
    cellSpreadMv,
    cellDeviationsMv,
    confidence,
    notes,
  };
}
