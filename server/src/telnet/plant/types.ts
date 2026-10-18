/**
 * Shared types for the Plant Operator interface.
 */

import type { DeviceSnapshot, FleetSnapshot } from '../../snapshot.js';
import type { FleetEnergyTotals } from '../../aggregator.js';
import type { DayForecast, FleetDegradation } from '../../analytics.js';
import type { Recorder } from '../../recorder.js';
import { aggregateFleetFlow, type BridgeVerdicts } from '../../shp2Membership.js';
import { slotVerdicts } from '../../energyBridge.js';

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

/** v1.188.1 (review) — Fleet PV and Battery Net exactly as the HA sensors publish them (null =
 *  unknown: a home Core inside the dwell, or a dark slot that cannot be bridged right now). */
export interface PlantFlow {
  fleetPv: number | null;
  fleetBatteryNet: number | null;
  /** v1.188.1 (review) — the bridge's verdicts the RUN line's timers take, as /api/ha-state does
   *  (shp2Membership.ts BridgeVerdicts). Absent: the timers' own rule. */
  verdicts?: BridgeVerdicts;
}

/**
 * v1.188.1 (review) — the console's power flow, from the same computation both state publishers
 * run (index.ts /api/ha-state, mqttDiscovery buildState): aggregateFleetFlow's online sums handed to
 * Recorder.bridgedFleetFlow, which counts each home Core at its own reading or, dark, at its panel
 * slot. With every Core dark the Cores-only sum is 0 W; the console read "BATT.P.NET 0 W IDLE"
 * beside a 3.4 kW drain (2026-10-16) while the sensors published the slots.
 */
export function plantFlow(recorder: Pick<Recorder, 'bridgedFleetFlow'>, devices: Record<string, DeviceSnapshot>, nowMs: number): PlantFlow {
  const { fleetPv, fleetBatteryNetDisplay: fleetBatteryNet } = aggregateFleetFlow(devices);
  const b = recorder.bridgedFleetFlow({ fleetPv, fleetBatteryNet }, devices, nowMs);
  return { fleetPv: b.fleetPv, fleetBatteryNet: b.fleetBatteryNet, verdicts: slotVerdicts(b) };
}

export interface PlantData {
  snap: FleetSnapshot;
  totals: FleetEnergyTotals | null;
  forecast: DayForecast | null;
  degradation: FleetDegradation;
  /** Server start time, for SYS.UPTIME. */
  serverStartedAt: number;
  /** v1.188.1 (review) — Fleet PV and Battery Net as published (plantFlow). */
  flow: PlantFlow;
}
