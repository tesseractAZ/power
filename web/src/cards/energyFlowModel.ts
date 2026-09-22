import type { DeviceSnapshot, DpuProjection, GridBackstop, Shp2Projection } from '../types';
import { shp2ConnectedDpuSns, isShp2Connected } from '../shp2Membership';

/**
 * v1.175.0 — the Energy flow card's numbers, as a pure function of the snapshot.
 *
 * Extracted from EnergyFlow.tsx so the arithmetic the operator reads off the headline
 * diagram is executed by the test suite (server/test/energyFlowModel.test.ts imports this
 * file directly, the same way webServerMembershipParity runs the web membership module).
 * The component only lays these numbers out.
 *
 * Every edge carries the flow it is drawn as, measured at the meter that sees it:
 *   Solar → Batteries   pv            — PV into the Cores
 *   Grid  → Batteries   gridToCoresW  — the Cores' own AC input (grid charging them)
 *   Grid  → Loads       gridToHouseW  — the grid serving the house through the panel
 *   Batteries → Loads   coresToHouseW — the Cores' delivery, measured at the panel
 * and the Loads NODE is the house total the panel measured. Both edges into Loads are
 * panel-side figures, so they sum to the node by construction. The Solar and Batteries
 * nodes are NOT balanced against them: PV is metered on the DC side and the house on the
 * AC side, and the MPPT, charger and inverter losses between them are not drawn.
 */

/** Below this an edge is not drawn (and an active grid with no qualifying edge keeps
 *  the standby connector). */
export const FLOW_EDGE_MIN_W = 5;

export type GridFlowState = 'active' | 'standby' | 'off';

export interface EnergyFlowModel {
  /** Home DPUs drawn in the Batteries node (SHP2-connected; every online DPU on a cold boot). */
  dpuCount: number;
  /** Online DPUs NOT in the home set (bench spares). */
  spareCount: number;
  pv: number;
  acOut: number;
  /** > 0 = discharging, from per-pack flow. */
  batNet: number;
  soc: number | null;
  /** The house total (SHP2 circuits), or NULL when a present panel reported no channel. */
  load: number | null;
  /** Energized CIRCUITS (split-phase pairs count once), not channels. */
  liveCircuits: number;
  gridState: GridFlowState;
  /** The metered total at the SHP2 main (or the Cores' import when the main is silent). */
  gridSupplyW: number;
  gridToCoresW: number;
  gridToHouseW: number;
  /** The Cores' delivery to the house, measured on the panel (load − grid-to-house). */
  coresToHouseW: number;
}

type Dpu = DeviceSnapshot & { projection: DpuProjection };
type Shp2 = DeviceSnapshot & { projection: Shp2Projection };

export function energyFlowModel(devices: Record<string, DeviceSnapshot>, grid?: GridBackstop): EnergyFlowModel {
  const list = Object.values(devices);
  const allDpus = list.filter((d) => d.projection?.kind === 'dpu' && d.online) as Dpu[];
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as Shp2 | undefined;

  // v0.9.77 — the headline diagram is the HOME energy flow. Bench spares are not part of
  // the home's PV / battery / SoC story, even when they're online; filter them out via
  // the same SHP2-membership helper the analytics engines + MQTT discovery use
  // (server/src/shp2Membership.ts). When the SHP2 hasn't been observed yet (cold boot),
  // fall back to every online DPU so the diagram isn't empty.
  const connected = shp2ConnectedDpuSns(devices);
  const dpus = connected.size > 0 ? allDpus.filter((d) => isShp2Connected(d.sn, connected)) : allDpus;

  const pv = dpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  // acIn from the SHP2's sources (by definition the home-connected DPUs) — kept as a
  // defensive fallback for the cold-boot path above.
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
  const acIn = gridDpus.reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  const acOut = dpus.reduce((s, d) => s + (d.projection.acOutWatts ?? 0), 0);
  // v0.46.0 — battery net from PER-PACK flow, not DPU throughput, mirroring the server's
  // fleet_battery_net_watts. Pack out = discharge, pack in = charge; net > 0 = discharging.
  const batNet = dpus.reduce(
    (s, d) => s + d.projection.packs.reduce((p, pk) => p + ((pk.outputWatts ?? 0) - (pk.inputWatts ?? 0)), 0),
    0,
  );
  // v1.145.0 — average only the packs that REPORTED; a silent DPU is not a 0% pack.
  const socVals = dpus.map((d) => d.projection.soc).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const soc = socVals.length === 0 ? null : socVals.reduce((a, b) => a + b, 0) / socVals.length;

  // v1.175.0 — the house load, and NULL when the panel did not report it.
  //
  // ★ The old expression was `circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? acOut`.
  // The projection ALWAYS builds twelve channel entries (project.ts loops 1..12) and sets
  // `watts: null` for any the payload omitted, so the array is never absent, `??` never
  // fired, and a panel that reported no channel watts summed to a confident 0 — "the house
  // is drawing 0 W" — rendered identically to a real reading. Only a total absence of the
  // SHP2 (cold boot) falls back to the Cores' AC output; a present-but-silent panel is null.
  const circuits = shp2?.projection.circuits ?? [];
  const measured = circuits.filter((c) => c.watts != null);
  const load: number | null = measured.length > 0
    ? measured.reduce((s, c) => s + (c.watts as number), 0)
    : shp2
      ? null
      : acOut;

  // v1.175.0 — COUNT CIRCUITS, NOT LEGS. `circuits` is twelve channels; a split-phase 240 V
  // circuit occupies two, and the projection pairs them in `pairedCircuits` (the SHP2 card
  // on the same page renders that list as "Circuits (6)"). Counting energized channels
  // read "9 circuits" on a six-circuit panel and could reach twelve. Raw channels are the
  // fallback only when the payload carried no pairing.
  const groups = shp2?.projection.pairedCircuits ?? [];
  const liveCircuits = groups.length > 0
    ? groups.filter((g) => (g.watts ?? 0) > 1).length
    : circuits.filter((c) => (c.watts ?? 0) > 1).length;

  // ── v0.36.0 — 3-state grid supply model ──────────────────────────────────
  // homeGridWatts is the SHP2 main; importWatts is the Cores' AC input (grid charging
  // them). When the snapshot predates the field, fall back to the legacy acIn signal.
  const homeGridW = grid?.homeGridWatts ?? 0;
  const gridImportW = grid?.importWatts ?? acIn;
  const gridSupplyW = homeGridW > 0 ? homeGridW : gridImportW;

  // v1.175.0 — WHERE the grid goes. homeGridWatts is the TOTAL at the main: the panel's
  // node balance is load = grid + Core AC output, and during a force charge the main also
  // carries the Cores' AC input. The card drew that whole total as ONE edge into the
  // Batteries, and the only edge into Loads came out of the Batteries — so a grid carrying
  // the house was drawn as the house running on battery. Live 2026-09-22 03:30: grid
  // 1901 W, house 1904 W, Core AC output 0 W, packs +16 W — the card showed 1.9 kW into a
  // battery nothing was charging and 1.9 kW out of inverters producing 0 W.
  // Grid → Batteries now carries only the Cores' AC input, and grid → Loads the rest,
  // capped at the house load it points at: the main and the Core meters disagree by ~1 kW
  // under a 16 kW charge (04:05: main 19053 W, Core input 15969 W, house 1996 W). The node
  // keeps the metered total; the edge never claims more than the house drew.
  const gridToCoresW = gridImportW;
  const gridToHouseRaw = Math.max(0, homeGridW - gridImportW);
  const gridToHouseW = load != null ? Math.min(gridToHouseRaw, load) : gridToHouseRaw;
  // v1.175.0 — the Cores' share of the house, on the SAME meter as the Loads node. The
  // panel has two sources — the grid and the Cores — so what it measured beyond the grid
  // is what the Cores delivered to it. The edge used to be Math.max(load, acOut): acOut
  // is the Cores' own inverter meter, which reads tens of watts off the panel (live
  // 14427 W vs 14356 W; the reported screenshot showed 1925 W into a "1.89 kW" box, and
  // ~30% of overnight 5-min buckets disagreed), so the arrow and the box it points at
  // never agreed. Measured on the panel side, the two edges into Loads sum to the node.
  // A residual under the edge floor is meter disagreement, not delivery (03:30: 1904.4 W
  // house − 1900.6 W grid = 3.8 W while the Cores output 0 W), so it draws as nothing.
  // A silent panel has no residual to take; the Cores' own meter stands in.
  const coresResidual = load != null ? Math.max(0, load - gridToHouseW) : acOut;
  const coresToHouseW = coresResidual < FLOW_EDGE_MIN_W ? 0 : coresResidual;

  // State resolution. With `grid` present, trust its present/declared flags; otherwise
  // derive from the legacy acIn threshold (matches the old offGrid<5).
  const gridActive = grid ? homeGridW > 0 || gridImportW >= FLOW_EDGE_MIN_W : acIn >= FLOW_EDGE_MIN_W;
  const gridPresent = grid ? grid.present || grid.declared : acIn >= FLOW_EDGE_MIN_W;
  const gridState: GridFlowState = gridActive ? 'active' : gridPresent ? 'standby' : 'off';

  return {
    dpuCount: dpus.length,
    spareCount: connected.size > 0 ? allDpus.length - dpus.length : 0,
    pv,
    acOut,
    batNet,
    soc,
    load,
    liveCircuits,
    gridState,
    gridSupplyW,
    gridToCoresW,
    gridToHouseW,
    coresToHouseW,
  };
}
