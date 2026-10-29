/**
 * limits.ts — the bridged plant limits and policy defaults (plan 2.2): EV, per-Core charge rate,
 * runway overhead, reseed gap, capacity-scale floor, forecast night band, carbon and wear, SoC
 * ladder, opportunistic loads, the reserve fallbacks (OWNER DECISION 10) and the round-trip
 * efficiencies (OWNER DECISION 9 keeps both; lane B's section below).
 *
 * v1.191.0 (S9) — every value comes from a config.ts OPTIONS row; this module only names it and,
 * for the three list-shaped keys, parses the string the row yields (the row's `structuredBy` names
 * the parser here). The getters read at ACCESS time, so a consumer that snapshotted a constant at
 * module level keeps doing so (analytics.ts snapshots EV_MAX_LOAD_W at import) and a per-call reader
 * stays per call. Unset, every value is today's: the defaults live on the rows and in the named
 * constants below, and golden G8 holds them.
 *
 * The analytics worker imports this module too; it resolves from its own copy of the environment,
 * identically (CA17).
 */
import { option } from './config.js';
import type { AlarmPriority } from './alertPriority.js';

/* ───────────────────────────── EV ───────────────────────────── */

/** EV_CHARGER_COUNT unset: one charger, so overlapping predicted sessions are alternatives (MAX). */
export const EV_CHARGER_COUNT_DEFAULT = 1;
/** Remaining-energy basis of a live EV session when no session history exists yet (kWh). */
export const EV_SESSION_FALLBACK_KWH = 11;
/** Physical sanity cap on a live session's projected remaining runtime (largest observed ≈ 3 h). */
export const EV_LIVE_MAX_REMAINING_H = 4;

/**
 * EV_CIRCUITS — the SHP2 channels the EV detectors scan, as a comma list of channel numbers 1..12.
 * A paired (240 V) circuit is scanned when either of its legs is listed. Unset, blank, or a list
 * with no valid channel: null, which scans every circuit (today's behaviour).
 */
export function parseEvCircuits(raw: string | null | undefined): ReadonlySet<number> | null {
  if (raw == null) return null;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!/^\d{1,2}$/.test(t)) continue;
    const ch = Number(t);
    if (ch >= 1 && ch <= 12) out.add(ch);
  }
  return out.size > 0 ? out : null;
}

/** Whether a paired circuit is scanned for EV sessions under `circuits` (null: every circuit). */
export function evCircuitScanned(
  pc: { primaryCh: number; secondaryCh?: number | null },
  circuits: ReadonlySet<number> | null,
): boolean {
  if (circuits == null) return true;
  return circuits.has(pc.primaryCh) || (pc.secondaryCh != null && circuits.has(pc.secondaryCh));
}

/* ───────────────────────────── opportunistic loads ───────────────────────────── */

export type OpportunisticCategory = 'pool' | 'ev' | 'water' | 'hvac' | 'other';
export const OPPORTUNISTIC_CATEGORIES: readonly OpportunisticCategory[] = ['pool', 'ev', 'water', 'hvac', 'other'];

/** One configured opportunistic load (the fields the curtailment report's suggestion carries). */
export interface OpportunisticLoadSpec {
  id: string;
  name: string;
  estimatedW: number;
  category: OpportunisticCategory;
  description: string;
}

/**
 * OPPORTUNISTIC_LOADS (CA22) — `id:watts:category[:label]`, entries separated by commas:
 *   - `id` is [a-z0-9_] (case is folded); `watts` a finite number above 0;
 *   - `category` one of pool | ev | water | hvac | other; left out, blank or unknown reads as other;
 *   - `label` (the rest of the entry, colons allowed) is the name shown; left out, the id.
 * An entry that does not parse is skipped, and a repeated id keeps its first entry. `none` is an
 * empty list. Unset, blank, or no valid entry: null, which keeps the built-in list (analytics.ts
 * DEFAULT_OPPORTUNISTIC_LOADS, today's).
 */
export function parseOpportunisticLoads(raw: string | null | undefined): readonly OpportunisticLoadSpec[] | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === '') return null;
  if (text.toLowerCase() === 'none') return [];
  const out: OpportunisticLoadSpec[] = [];
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const seg = part.split(':');
    const id = (seg[0] ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(id) || seen.has(id)) continue;
    const wattsText = (seg[1] ?? '').trim();
    const watts = wattsText === '' ? NaN : Number(wattsText);
    if (!Number.isFinite(watts) || watts <= 0) continue;
    const catText = (seg[2] ?? '').trim().toLowerCase();
    const category: OpportunisticCategory = (OPPORTUNISTIC_CATEGORIES as readonly string[]).includes(catText)
      ? (catText as OpportunisticCategory) : 'other';
    const label = seg.slice(3).join(':').trim();
    seen.add(id);
    out.push({ id, name: label || id, estimatedW: watts, category, description: '' });
  }
  return out.length > 0 ? out : null;
}

/** The inverse of parseOpportunisticLoads for a parsed list (round-trip tests, the docs example). */
export function formatOpportunisticLoads(loads: readonly OpportunisticLoadSpec[]): string {
  if (loads.length === 0) return 'none';
  return loads.map((l) => `${l.id}:${l.estimatedW}:${l.category}${l.name !== l.id ? `:${l.name}` : ''}`).join(',');
}

/* ───────────────────────────── SoC ladder ───────────────────────────── */

export interface SocRung { pct: number; priority: AlarmPriority }
const PRIORITIES: readonly AlarmPriority[] = ['low', 'medium', 'high', 'critical'];

/**
 * BATTERY_SOC_LADDER (Z6) — `pct:tier`, comma-separated: `pct` an integer 1..99, `tier` one of
 * low | medium | high | critical. The rungs are ordered highest percent first; a repeated percent
 * keeps its first entry; an entry that does not parse is skipped. Unset, blank, or no valid rung:
 * null, which keeps the built-in ladder (batterySocAlarm.ts DEFAULT_BATTERY_SOC_THRESHOLDS,
 * 50/40/30/20/15/10/8/4/2).
 */
export function parseSocLadder(raw: string | null | undefined): readonly SocRung[] | null {
  if (raw == null) return null;
  const out: SocRung[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^\s*(\d{1,2})\s*:\s*([a-z]+)\s*$/i.exec(part);
    if (!m) continue;
    const pct = Number(m[1]);
    const priority = m[2].toLowerCase() as AlarmPriority;
    if (pct < 1 || pct > 99 || !PRIORITIES.includes(priority) || seen.has(pct)) continue;
    seen.add(pct);
    out.push({ pct, priority });
  }
  if (out.length === 0) return null;
  return out.sort((a, b) => b.pct - a.pct);
}

/** The inverse of parseSocLadder (round-trip tests, the docs example). */
export function formatSocLadder(rungs: readonly SocRung[]): string {
  return rungs.map((r) => `${r.pct}:${r.priority}`).join(',');
}

/** The healthy-pool baseline of the SoC slew guard: a fall is judged implausible only FROM above it. */
export const SOC_HEALTHY_BASELINE_PCT = 30;

/* ───────────────────────────── reserve fallbacks (OWNER DECISION 10) ───────────────────────────── */

/** The backup reserve assumed while the panel has not reported one (analytics, alerts, runway, lighting). */
export const RESERVE_FALLBACK_PCT = 15;
/** The same fallback in the MPC dispatch inputs (index.ts), kept at its own value. */
export const MPC_RESERVE_FALLBACK_PCT = 20;
/** The LAN console's fallback (console/ code, which keeps its literal until its lane moves it). */
export const CONSOLE_RESERVE_FALLBACK_PCT = 0;

/* ───────────────────────────── the bridged values ───────────────────────────── */

export const limits = {
  /** EV_MAX_LOAD_W — ceiling on predicted EV load per hour, per charger (W); clamped at ≥ 0. */
  get evMaxLoadW(): number { return option<number>('EV_MAX_LOAD_W'); },
  /** EV_CHARGER_COUNT — 0 (no EV charger: no circuit is classed as EV), 1 (MAX of overlapping
   *  sessions), 2..4 (SUM, capped at count × evMaxLoadW). */
  get evChargerCount(): number { return option<number>('EV_CHARGER_COUNT'); },
  /** EV_PLATEAU_MIN_W — average watts above which a sustained circuit load is an EV session. */
  get evPlateauMinW(): number { return option<number>('EV_PLATEAU_MIN_W'); },
  /** EV_CIRCUITS — the channels the EV detectors scan; null scans every circuit. */
  get evCircuits(): ReadonlySet<number> | null { return parseEvCircuits(option<string | undefined>('EV_CIRCUITS')); },
  /** FORCE_CHARGE_KW_PER_CORE — what each connected Core takes into its pack while force-charging;
   *  null (unset, 0 or not a positive number) is the measured 5.5 kW (nightForceCharge.ts). */
  get forceChargeKwPerCore(): number | null { return option<number | null>('FORCE_CHARGE_KW_PER_CORE'); },
  /** RUNWAY_POOL_OVERHEAD_FLOOR_W — the pool standby overhead floor while the panel reports a pool. */
  get runwayPoolOverheadFloorW(): number { return option<number>('RUNWAY_POOL_OVERHEAD_FLOOR_W'); },
  /** RUNWAY_CORE_OVERHEAD_W — standby overhead per connected Core (lifts the floor above three Cores). */
  get runwayCoreOverheadW(): number { return option<number>('RUNWAY_CORE_OVERHEAD_W'); },
  /** RUNWAY_DRAIN_MARGINAL_EFFICIENCY (environment only). */
  get runwayDrainMarginalEfficiency(): number { return option<number>('RUNWAY_DRAIN_MARGINAL_EFFICIENCY'); },
  /** RUNWAY_DISCHARGE_EFFICIENCY (environment only). */
  get runwayDischargeEfficiency(): number { return option<number>('RUNWAY_DISCHARGE_EFFICIENCY'); },
  /** BMS_RESEED_MIN_GAP_WH — the floor-vs-live lifetime gap that re-seeds the floors (about one Core). */
  get bmsReseedMinGapWh(): number { return option<number>('BMS_RESEED_MIN_GAP_WH'); },
  /** BMS_RESEED_SUSTAINED_ROLLUPS (environment only). */
  get bmsReseedSustainedRollups(): number { return option<number>('BMS_RESEED_SUSTAINED_ROLLUPS'); },
  /** CAPACITY_SCALE_MIN — the lowest measured capacity scale applied to the panel's nameplate energies. */
  get capacityScaleMin(): number { return option<number>('CAPACITY_SCALE_MIN'); },
  /** FORECAST_NIGHT_START_HOUR / _END_HOUR — the overnight band the load-forecast night blend applies in. */
  get forecastNightStartHour(): number { return option<number>('FORECAST_NIGHT_START_HOUR'); },
  get forecastNightEndHour(): number { return option<number>('FORECAST_NIGHT_END_HOUR'); },
  /** GRID_CO2_INTENSITY_LB_PER_MWH — grid carbon intensity for the avoided-CO2 figures. */
  get gridCo2LbPerMwh(): number { return option<number>('GRID_CO2_INTENSITY_LB_PER_MWH'); },
  /** CYCLING_BASE_WEAR_USD_PER_KWH — the base battery wear cost the MPC prices cycling with. */
  get cyclingBaseWearUsdPerKwh(): number { return option<number>('CYCLING_BASE_WEAR_USD_PER_KWH'); },
  /** OPPORTUNISTIC_LOADS — null keeps the built-in list. */
  get opportunisticLoads(): readonly OpportunisticLoadSpec[] | null { return parseOpportunisticLoads(option<string | undefined>('OPPORTUNISTIC_LOADS')); },
  /** BATTERY_SOC_LADDER — null keeps the built-in ladder. */
  get batterySocLadder(): readonly SocRung[] | null { return parseSocLadder(option<string | undefined>('BATTERY_SOC_LADDER')); },
  /** BATTERY_SOC_MAX_DROP_PCT (environment only) — the largest plausible one-tick SoC fall. */
  get batterySocMaxDropPct(): number { return option<number>('BATTERY_SOC_MAX_DROP_PCT'); },
  /**
   * ARB_MIN_BUY_KWH, second meaning. The option is the night planner's smallest worthwhile buy
   * (index.ts, minBuyKwh); the ledger scoring also reads it as the most a window may import and
   * still count as a clean baseline night. One option, two named uses (plan 4.1).
   */
  get cleanBaselineMaxImportKwh(): number { return option<number>('ARB_MIN_BUY_KWH'); },
};

/* ───────────────────────────── round-trip efficiencies (lane B) ───────────────────────────── */

/**
 * Round-trip efficiency the night-charge sizing and the advisory dispatch planner assume (grid or PV in
 * → pack → AC out): DISPATCH_ROUND_TRIP_EFFICIENCY, clamped to 0.8..1, a blank or NaN reads 0.86. Each
 * leg is √RTE (analytics.ts explains the 0.86). OWNER DECISION 9 keeps it beside the MPC's own 0.9; both
 * values are today's. Module-level: read once when the module loads, as analytics.ts did.
 */
export const DISPATCH_ROUND_TRIP_EFFICIENCY = option<number>('DISPATCH_ROUND_TRIP_EFFICIENCY');

/** Round-trip efficiency the MPC dispatch optimiser states in its rationale: MPC_ROUND_TRIP_EFFICIENCY,
 *  bare Number, 0.9 (OWNER DECISION 9: kept apart from the 0.86 above). */
export const MPC_ROUND_TRIP_EFFICIENCY = option<number>('MPC_ROUND_TRIP_EFFICIENCY');
