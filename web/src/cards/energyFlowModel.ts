import type { DeviceSnapshot, DpuProjection, GridBackstop, Shp2Projection } from '../types';
import { shp2ConnectedDpuSns, isShp2Connected, allPanels } from '../shp2Membership';

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
 * and the Loads NODE is the house total the panel measured. The two edges into Loads always
 * sum to the node: the Cores' share is taken from their own (faster) meter and the grid
 * takes the rest of the house. The Solar and Batteries
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
  /** v1.182.0 — a panel is present but its source list is not known, so every online DPU is
   *  drawn as home — bench spares included — and spareCount cannot say how many. */
  membershipUnknown: boolean;
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
  /** The Grid node: the main meter, or the sum of its edges when the main is evidently stale. */
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
  // v1.185.0 — EVERY panel, house panel first. The Cores, PV, battery and grid figures already
  // span every panel (union roster; the server sums each panel's grid), so the load does too.
  const panels = allPanels(devices) as Shp2[];
  const shp2: Shp2 | undefined = panels[0];

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
    panels.flatMap((p) => p.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
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
  // ★ v1.179.0 — a THIRD way to be frozen: online and unshadowed, but its readings stopped
  // refreshing (a failing quota fetch). The server now zeroes that panel's grid reading too,
  // and says so in `grid.panelFresh`; the card keys on the server's verdict, not a client clock.
  // v1.185.0 — any panel frozen freezes the load: a sum that is half live, half frozen is neither.
  const circuits = panels.flatMap((p) => p.projection.circuits ?? []);
  const measured = circuits.filter((c) => c.watts != null);
  const panelState: PanelState = !shp2
    ? 'absent'
    : panels.some((p) => !p.online || p.contentStaleSinceMs != null) || grid?.panelFresh === false
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
  const groups = panels.flatMap((p) => p.projection.pairedCircuits ?? []);
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
  // ★ TWO CADENCES. The panel's figures (main, house, channels) arrive in one REST frame
  // every ~60 s; the Cores' AC input and output stream every ~10 s. Every transition —
  // a charge ramp, a charge ending, the Cores handing the house to the grid — therefore has
  // up to a minute in which the two disagree. Replayed over 190 h of recorded history, a
  // rule that trusted the panel's frame drew phantom battery output at charge ramps and lost
  // the Cores' real delivery when a charge ended. The rules below attribute from the
  // FRESHER meter first and let the panel's total absorb the rest.
  const homeGridW = grid?.homeGridWatts ?? 0;
  // The Cores' grid draw, over the same Cores drawn in the Batteries node. With a connection
  // table that is their own acIn (the server's importWatts also counts a source slot whose
  // Core is not connected). WITHOUT one (cold boot, or a partial quota missing the sources
  // subtree) every online DPU stands in for the node — bench spares included — so their
  // acIn would include a spare's wall charge; the server's importWatts fails safe to 0 in
  // exactly that state, and is used instead. No snapshot `grid` at all is the legacy path.
  const coresAcIn = connected.size > 0 ? acIn : grid ? (grid.importWatts ?? 0) : acIn;
  const coresDelivering = acOut >= FLOW_EDGE_MIN_W;
  const gridPresent = grid ? grid.present || grid.declared : acIn >= FLOW_EDGE_MIN_W;
  // The house is evidently on the grid when the Cores (fresh meter) deliver nothing while
  // the panel shows the house drawing: the grid is the only other source. This covers the
  // up-to-60 s after the Cores stop, before the panel's next frame shows the main rising
  // (recorded 09-21 22:55:37-22:56:27: house 5137 W, Cores 0 W, main still 0).
  const houseOnGrid = gridPresent && !coresDelivering && load != null && load >= FLOW_EDGE_MIN_W;
  const gridActive = grid
    ? homeGridW > 0 || coresAcIn >= FLOW_EDGE_MIN_W || houseOnGrid
    : acIn >= FLOW_EDGE_MIN_W;
  const gridState: GridFlowState = gridActive ? 'active' : gridPresent ? 'standby' : 'off';
  const gridToCoresW = coresAcIn;

  // ── who feeds the house ───────────────────────────────────────────────────
  //   · Cores idle (their inverters report < 5 W) and grid active → the grid carries the
  //     whole house: grid → Loads is the house load.
  //   · Cores delivering, grid not active → the Cores are the only source: their edge IS the
  //     house load, so the arrow equals the box (the reported view had 1925 W into a
  //     "1.89 kW" box — the Cores' inverter meter against the panel's).
  //   · both → the Cores' share comes from their own fresh meter (capped at the house), and
  //     the grid takes the rest. When a charge ends the panel's frame still shows the main
  //     carrying everything for up to a minute (09-22 04:53:41: main 3331 W, house 3335 W,
  //     Cores already outputting 3298 W); the fresh meter keeps their delivery on screen.
  //   · a silent or frozen panel (load null) → each edge from its own meter.
  let gridToHouseW: number;
  let coresToHouseW: number;
  if (load == null) {
    gridToHouseW = Math.max(0, homeGridW - coresAcIn);
    coresToHouseW = coresDelivering ? acOut : 0;
  } else if (!coresDelivering) {
    gridToHouseW = gridState === 'active' ? load : 0;
    coresToHouseW = 0;
  } else if (gridState !== 'active') {
    gridToHouseW = 0;
    coresToHouseW = load;
  } else {
    coresToHouseW = Math.min(acOut, load);
    gridToHouseW = load - coresToHouseW;
  }
  if (coresToHouseW < FLOW_EDGE_MIN_W) coresToHouseW = 0;
  if (gridToHouseW < FLOW_EDGE_MIN_W) gridToHouseW = 0;

  // The Grid node: the main meter, unless the fresher meters show it is evidently stale.
  // The main and the Cores' meters normally agree to within a few percent (steady 16 kW
  // charge: main 19053 W vs 17965 W drawn — the node keeps the main). At a transition the
  // main can be a whole frame behind: 3.41 kW beside a 16.3 kW grid → Cores edge at a charge
  // ramp, 18.4 kW beside a 2.1 kW house edge when a charge had just ended. Beyond the meters'
  // tolerance the node shows what its edges carry, so it never contradicts them.
  const gridEdgesW = gridToCoresW + gridToHouseW;
  const meterToleranceW = Math.max(500, 0.1 * Math.max(homeGridW, gridEdgesW));
  const gridSupplyW = homeGridW > 0 && Math.abs(homeGridW - gridEdgesW) <= meterToleranceW ? homeGridW : gridEdgesW;

  return {
    dpuCount: dpus.length,
    spareCount: connected.size > 0 ? allDpus.length - dpus.length : 0,
    membershipUnknown: connected.size === 0
      && list.some((d) => (d.productName ?? '').toLowerCase().includes('smart home panel')),
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
