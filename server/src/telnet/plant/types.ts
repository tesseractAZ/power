/**
 * Shared types for the Plant Operator interface.
 */

import type { FleetSnapshot } from '../../snapshot.js';
import type { FleetEnergyTotals } from '../../aggregator.js';
import type { DayForecast, FleetDegradation } from '../../analytics.js';

/** The Plant Operator's sub-screens (small set, each densely-packed). */
export const PLANT_SCREENS = ['console', 'gen', 'bus', 'pv', 'alm', 'trd'] as const;
export type PlantScreenId = (typeof PLANT_SCREENS)[number];

export const PLANT_SCREEN_LABEL: Record<PlantScreenId, string> = {
  console: 'CONSOLE',
  gen:     'GEN',
  bus:     'BUS',
  pv:      'PV',
  alm:     'ALARM',
  trd:     'TRENDS',
};

export interface PlantView {
  width: number;
  height: number;
  screen: PlantScreenId;
  /** Selected DPU index on GEN screen. */
  genSel: number;
  /** Selected pack on GEN screen. */
  genPack: number;
  /** Scroll offset on alarm list. */
  almScroll: number;
  /** When the user connected — for the "OPR" header timer. */
  connectedAt: number;
}

export interface PlantData {
  snap: FleetSnapshot;
  totals: FleetEnergyTotals | null;
  forecast: DayForecast | null;
  degradation: FleetDegradation;
  /** Server start time, for SYS.UPTIME. */
  serverStartedAt: number;
}
