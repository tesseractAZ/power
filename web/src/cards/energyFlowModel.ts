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
 *   Grid  → Batteries   gridToCoresW  — the home Cores' own AC input (grid charging them)
 *   Grid  → Loads       gridToHouseW  — the grid serving the house through the panel
 *   Batteries → Loads   coresToHouseW — the Cores' delivery, never more than their inverters report
 * and the Loads NODE is the house total the panel measured. With one source feeding the
 * house its edge equals the node exactly; with both, each edge is bounded by its own meter
 * and they sum to the node within the meters' disagreement. The Solar and Batteries
 * nodes are NOT balanced against them: PV is metered on the DC side and the house on the
 * AC side, and the MPPT, charger and inverter losses between them are not drawn.
 */

/** Below this an edge is not drawn (and an active grid with no qualifying edge keeps
 *  the standby connector). */
export const FLOW_EDGE_MIN_W = 5;

export type GridFlowState = 'active' | 'standby' | 'off';
/** ok = reporting; silent = no channel watts in the payload; frozen = offline or replaying a
 *  cloud shadow; absent = no SHP2 observed (cold boot). */
export type PanelState = 'ok' | 'silent' | 'frozen' | 'absent';

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
  /** The house total (SHP2 circuits), or NULL when the panel is silent or frozen. */
  load: number | null;
  /** Why `load` is what it is. */
  panelState: PanelState;
  /** Energized CIRCUITS (split-phase pairs count once), not channels. */
  liveCircuits: number;
  gridState: GridFlowState;
  /** The Grid node: the metered total at the main, never less than its own edges. */
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

  // v1.175.0 — the house load, and NULL when the panel's figure cannot be trusted.
  //
  // ★ The old expression was `circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? acOut`.
  // The projection ALWAYS builds twelve channel entries (project.ts loops 1..12) and sets
  // `watts: null` for any the payload omitted, so the array is never absent, `??` never
  // fired, and a panel that reported no channel watts summed to a confident 0 — "the house
  // is drawing 0 W" — rendered identically to a real reading.
  // ★ A panel that is OFFLINE or replaying a cloud shadow (contentStaleSinceMs) keeps its
  // last projection, so its channels still sum to a plausible house load — FROZEN. The
  // server already refuses to count such a panel's grid reading (gridState.ts
  // computeHomeGridWatts returns 0), so pairing the frozen load with that zeroed grid drew
  // the whole house flowing out of idle batteries: the exact picture this release removes.
  // Frozen is treated like silent. Only a total absence of the SHP2 (cold boot) falls back
  // to the Cores' AC output.
  const circuits = shp2?.projection.circuits ?? [];
  const measured = circuits.filter((c) => c.watts != null);
  const panelState: PanelState = !shp2
    ? 'absent'
    : !shp2.online || shp2.contentStaleSinceMs != null
      ? 'frozen'
      : measured.length === 0
        ? 'silent'
        : 'ok';
  const load: number | null = panelState === 'ok'
    ? measured.reduce((s, c) => s + (c.watts as number), 0)
    : panelState === 'absent'
      ? acOut
      : null;

  // v1.175.0 — COUNT CIRCUITS, NOT LEGS. `circuits` is twelve channels; a split-phase 240 V
  // circuit occupies two, and the projection pairs them in `pairedCircuits` (the SHP2 card
  // on the same page renders that list as "Circuits (6)"). Counting energized channels
  // read "9 circuits" on a six-circuit panel and could reach twelve. Raw channels are the
  // fallback only when the payload carried no pairing.
  const groups = shp2?.projection.pairedCircuits ?? [];
  const liveCircuits = groups.length > 0
    ? groups.filter((g) => (g.watts ?? 0) > 1).length
    : circuits.filter((c) => (c.watts ?? 0) > 1).length;

  // ── the grid ─────────────────────────────────────────────────────────────
  // homeGridWatts is the TOTAL metered at the SHP2 main: the panel's node balance is
  // load = grid + Core AC output, and during a charge the main also carries the Cores' AC
  // input. The card used to draw that whole total as ONE edge into the Batteries, with the
  // only edge into Loads coming out of the Batteries — so a grid carrying the house was
  // drawn as the house running on battery (live 2026-09-22 03:30: grid 1901 W, house
  // 1904 W, Core AC output 0 W, packs +16 W).
  //
  // v1.175.0 — the Cores' grid draw is `acIn` over the SAME Cores drawn in the Batteries
  // node, not the server's importWatts, which also counts a source slot whose Core is not
  // connected (gridState.ts sums every `sources` SN; the membership here admits only
  // isConnected). Drawing a non-member's draw into this node would move watts off the
  // grid → house edge onto a phantom Cores → house one.
  const homeGridW = grid?.homeGridWatts ?? 0;
  const gridToCoresW = acIn;
  const gridActive = grid ? homeGridW > 0 || acIn >= FLOW_EDGE_MIN_W : acIn >= FLOW_EDGE_MIN_W;
  const gridPresent = grid ? grid.present || grid.declared : acIn >= FLOW_EDGE_MIN_W;
  const gridState: GridFlowState = gridActive ? 'active' : gridPresent ? 'standby' : 'off';

  // ── who feeds the house ───────────────────────────────────────────────────
  // The house has two sources, the grid and the Cores. The Cores are delivering only when
  // their own inverters say so (acOut). That is the gate the first cut lacked: it took the
  // Cores' share as the panel's remainder (house − grid share), and the panel, the main and
  // the Core meters do not update at the same instant — at a charge ramp (03:42:52-03:43:25:
  // main 3406 W, Core input climbing 3608 → 16275 W, house 3410 W, Core output 0 W) the
  // remainder was the whole house, drawn flowing out of charging Cores whose inverters
  // produced nothing. Replayed against the recorded night, the remainder put a phantom
  // Cores → house edge on screen in more than half the charging samples.
  //   · Cores not delivering, grid active → the grid is the house's only source: grid →
  //     Loads is the house load (exact, whatever the main reads at that instant).
  //   · Cores delivering, grid not feeding the house → the Cores are the only source: their
  //     edge is the house load, so the arrow equals the box it points at (the reported view
  //     had 1925 W into a "1.89 kW" box: the Cores' meter against the panel's).
  //   · both → the grid's share is main − the Cores' own draw, capped at the house; the
  //     Cores' is the remainder, capped at what their inverters report.
  const coresDelivering = acOut >= FLOW_EDGE_MIN_W;
  let gridToHouseW: number;
  let coresToHouseW: number;
  if (load == null) {
    gridToHouseW = Math.max(0, homeGridW - acIn);
    coresToHouseW = coresDelivering ? acOut : 0;
  } else if (!coresDelivering) {
    gridToHouseW = gridState === 'active' ? load : 0;
    coresToHouseW = 0;
  } else {
    const gridShare = Math.min(Math.max(0, homeGridW - acIn), load);
    if (gridShare < FLOW_EDGE_MIN_W) {
      gridToHouseW = 0;
      coresToHouseW = load;
    } else {
      gridToHouseW = gridShare;
      coresToHouseW = Math.min(load - gridShare, acOut);
    }
  }
  if (coresToHouseW < FLOW_EDGE_MIN_W) coresToHouseW = 0;
  if (gridToHouseW < FLOW_EDGE_MIN_W) gridToHouseW = 0;

  // The Grid node: the metered total at the main, but never less than what leaves it. The
  // main updates on the panel's cadence and the Cores' input on theirs; at a charge ramp the
  // main still read 3.41 kW while 16.3 kW was already drawn into the Cores.
  const gridSupplyW = Math.max(homeGridW, gridToCoresW + gridToHouseW);

  return {
    dpuCount: dpus.length,
    spareCount: connected.size > 0 ? allDpus.length - dpus.length : 0,
    pv,
    acOut,
    batNet,
    soc,
    load,
    panelState,
    liveCircuits,
    gridState,
    gridSupplyW,
    gridToCoresW,
    gridToHouseW,
    coresToHouseW,
  };
}
