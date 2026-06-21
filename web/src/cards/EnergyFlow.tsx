import type { DeviceSnapshot, DpuProjection, GridBackstop, Shp2Projection } from '../types';
import { fmtPct, fmtW } from '../format';
import { shp2ConnectedDpuSns, isShp2Connected } from '../shp2Membership';
import { HUES, UI } from '../theme';

/**
 * v0.36.0 — theme-aware fonts for SVG <text>. The B5 theme swaps `--font-sans`
 * → Orbitron and `--font-mono` → Share Tech Mono under [data-theme="b5"]
 * (src/index.css); the Default theme resolves them to ui-sans-serif /
 * ui-monospace, so referencing the CSS var stays byte-identical on Default
 * while letting B5 re-skin. Hardcoding "ui-sans-serif"/"ui-monospace" here
 * (as the old core-kW label did) bypasses that swap and clashes with the rest
 * of the B5 chrome — so all flow labels route through these vars instead.
 */
const FONT_SANS = 'var(--font-sans)';
const FONT_MONO = 'var(--font-mono)';

/**
 * v0.36.0 — the SHP2 grid backstop, mirrored from the server's GridBackstop
 * (server/src/gridState.ts) and surfaced on the fleet snapshot as `snapshot.grid`.
 * Optional in Props so the card degrades gracefully (legacy DPU-acIn-only view) on a
 * cold snapshot that predates the field. The SHP2 is the grid interconnect; the
 * grid is a BACKSTOP that is tapped automatically at the reserve floor / for
 * rebalancing. Three states the flow renders:
 *   (1) ACTIVE   — homeGridWatts>0 (or importWatts>0): grid carrying the home now.
 *   (2) STANDBY  — present/declared but homeGridWatts≈0: there, not yet needed.
 *   (3) OFF-GRID — present false: islanded.
 */
interface Props {
  devices: Record<string, DeviceSnapshot>;
  /** v0.36.0 — SHP2 grid backstop (snapshot.grid). Absent on a cold snapshot. */
  grid?: GridBackstop;
}

export function EnergyFlow({ devices, grid }: Props) {
  const list = Object.values(devices);
  const allDpus = list.filter((d) => d.projection?.kind === 'dpu' && d.online) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;

  // v0.9.77 — the headline diagram is the HOME energy flow. Spare DPUs
  // (Cores 4 & 5 — currently bench-charging or sitting idle until the
  // second SHP2 lands) are not part of the home's PV / battery / SoC
  // story, even when they're online. Filter them out via the same
  // SHP2-membership helper the analytics engines + MQTT discovery use
  // (server-side: server/src/shp2Membership.ts). The diagram now
  // mirrors what the HA Energy Dashboard and lifetime counters show.
  // When the SHP2 hasn't been observed yet (cold boot), fall back to
  // every online DPU so the diagram isn't empty.
  const connected = shp2ConnectedDpuSns(devices);
  const dpus = connected.size > 0 ? allDpus.filter((d) => isShp2Connected(d.sn, connected)) : allDpus;

  const pv = dpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  // acIn is computed from the same connected set (the SHP2's sources
  // ARE the home-connected DPUs by definition), so the previous
  // sourceSns calculation is now redundant — kept as a defensive
  // fallback for the cold-boot path above.
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
  const acIn = gridDpus.reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  const acOut = dpus.reduce((s, d) => s + (d.projection.acOutWatts ?? 0), 0);
  // v0.46.0 — battery net from PER-PACK flow, not DPU throughput, mirroring the
  // server's fleet_battery_net_watts (server/src/index.ts:1108). total_in/out are
  // DPU THROUGHPUT (PV+grid in / AC out), NOT battery-cell flow — using
  // `totalOut − totalIn` overstated the charge/discharge magnitude. Pack out =
  // discharge, pack in = charge; net positive = discharging. Same `dpus` set the
  // battery node already iterates (home-connected DPUs, or all online on cold boot).
  const batNet = dpus.reduce(
    (s, d) => s + d.projection.packs.reduce((p, pk) => p + ((pk.outputWatts ?? 0) - (pk.inputWatts ?? 0)), 0),
    0,
  ); // > 0 = discharging
  const soc = dpus.length === 0 ? null : dpus.reduce((s, d) => s + (d.projection.soc ?? 0), 0) / dpus.length;
  const load = shp2?.projection.circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? acOut;

  // ── v0.36.0 — 3-state grid supply model ─────────────────────────────────
  // The SHP2 is the grid interconnect; the grid is a BACKSTOP, tapped
  // automatically at the reserve floor / for rebalancing. The OLD diagram only
  // knew off-grid vs DPU-acIn import and was blind to the home-grid backstop
  // (the SHP2 carrying the home directly through the panel without charging the
  // DPUs). `snapshot.grid.homeGridWatts` exposes that path now.
  //
  // homeGridWatts (SHP2 main) is the authoritative live "grid → home" flow;
  // importWatts (DPU ac_in) is grid charging the DPUs. Either > 0 ⇒ grid ACTIVE.
  // When the snapshot predates the field, fall back to the legacy acIn signal so
  // the card still renders a sensible (import-only) view.
  const homeGridW = grid?.homeGridWatts ?? 0;
  const gridImportW = grid?.importWatts ?? acIn;
  // The kW figure to show on the grid→home flow when active: prefer the SHP2
  // main-line measurement (the home backstop), else the DPU-charging import.
  const gridSupplyW = homeGridW > 0 ? homeGridW : gridImportW;

  // State resolution. With `grid` present, trust its present/declared flags;
  // otherwise derive from the legacy acIn threshold (matches the old offGrid<5).
  const gridActive = grid
    ? homeGridW > 0 || gridImportW >= 5
    : acIn >= 5;
  const gridPresent = grid ? grid.present || grid.declared : acIn >= 5;
  // (1) ACTIVE/BACKSTOPPING, (2) AVAILABLE/STANDBY, (3) OFF-GRID (islanded).
  const gridState: 'active' | 'standby' | 'off' = gridActive
    ? 'active'
    : gridPresent
      ? 'standby'
      : 'off';

  // SVG geometry
  const W = 720;
  const H = 260;

  const Solar = { x: 90, y: 50, w: 130, h: 60 };
  const Grid = { x: 90, y: 170, w: 130, h: 60 };
  const Battery = { x: 290, y: 95, w: 150, h: 90 };
  const Loads = { x: 510, y: 95, w: 130, h: 90 };

  // Convert a watt value to an animation period (seconds): more watts = faster.
  const period = (w: number) => {
    if (w < 5) return 0; // no animation if effectively zero
    return Math.max(0.6, Math.min(8, 1500 / Math.max(w, 50)));
  };
  const strokeW = (w: number) => Math.min(8, Math.max(1.5, Math.log10(Math.max(10, w)) * 1.6));

  return (
    <div className="card col-span-full">
      <div className="card-title flex items-center justify-between">
        <span>Energy flow</span>
        <span className="flex items-center gap-2 normal-case tracking-normal text-xs text-muted">
          {gridState === 'off' ? (
            <span className="badge badge-warn">off-grid</span>
          ) : gridState === 'active' ? (
            <span className="badge badge-ok">grid active</span>
          ) : (
            <span className="badge badge-ok">grid standby</span>
          )}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 280 }}>
        <defs>
          <style>{`
            @keyframes flowdash { to { stroke-dashoffset: -32; } }
          `}</style>
        </defs>

        {/* PV → Battery */}
        <FlowLine from={[Solar.x + Solar.w, Solar.y + Solar.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} watts={pv} color={HUES.solar} period={period(pv)} strokeW={strokeW(pv)} label="solar" />
        {/* Grid → Home (backstop). v0.36.0 — three states:
            (1) ACTIVE: animated grid→battery flow labelled with the live kW the
                SHP2 is pulling to carry the home (homeGridWatts) or to charge
                the DPUs (importWatts).
            (2) STANDBY: a faint, un-animated connector — grid is there but the
                battery/PV is covering, so it is NOT a live source.
            (3) OFF-GRID: omit the flow entirely (islanded). */}
        {gridState === 'active' ? (
          <FlowLine from={[Grid.x + Grid.w, Grid.y + Grid.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} watts={gridSupplyW} color={HUES.grid} period={period(gridSupplyW)} strokeW={strokeW(gridSupplyW)} label="grid" />
        ) : gridState === 'standby' ? (
          <StandbyLink from={[Grid.x + Grid.w, Grid.y + Grid.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} color={HUES.grid} />
        ) : null}
        {/* Battery → Loads (use load if available, fallback acOut) */}
        <FlowLine from={[Battery.x + Battery.w, Battery.y + Battery.h / 2]} to={[Loads.x, Loads.y + Loads.h / 2]} watts={Math.max(load, acOut)} color={HUES.soc} period={period(Math.max(load, acOut))} strokeW={strokeW(Math.max(load, acOut))} label="load" />

        {/* Solar node */}
        <Node {...Solar} title="Solar" subtitle="42 panels" value={fmtW(pv)} icon="☀" accent={HUES.solar} />
        {/* Grid node — 3-state subtitle + value:
            active → live kW into the home; standby → "standby" backstop;
            off → "islanded". The amber/accent treatment is reserved for the
            ACTIVE state so a backstopping grid reads as a live source. */}
        <Node
          {...Grid}
          title="Grid"
          subtitle={gridState === 'active' ? 'backstopping' : gridState === 'standby' ? 'standby / backstop' : 'islanded'}
          value={gridState === 'active' ? fmtW(gridSupplyW) : gridState === 'standby' ? 'available' : 'off'}
          icon="⌁"
          accent={gridState === 'active' ? HUES.battery : HUES.grid}
          dim={gridState !== 'active'}
        />
        {/* Battery node (big) */}
        <Node
          {...Battery}
          title={`Batteries (${dpus.length} DPU${connected.size > 0 && allDpus.length > dpus.length ? `, +${allDpus.length - dpus.length} spare` : ''})`}
          subtitle={batNet > 5 ? `▼ ${fmtW(batNet)} discharging` : batNet < -5 ? `▲ ${fmtW(-batNet)} charging` : 'idle'}
          value={fmtPct(soc, 1)}
          big
          accent={socAccent(soc)}
        />
        {/* Loads node */}
        <Node {...Loads} title="Loads" subtitle={`${shp2?.projection.circuits.filter((c) => (c.watts ?? 0) > 1).length ?? 0} circuits`} value={fmtW(load)} icon="⌂" accent={HUES.soc} />
      </svg>
    </div>
  );
}

function Node({
  x,
  y,
  w,
  h,
  title,
  subtitle,
  value,
  icon,
  accent,
  big = false,
  dim = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle?: string;
  value: string;
  icon?: string;
  accent: string;
  big?: boolean;
  /** Render the node muted (standby / off-grid) so it doesn't read as live. */
  dim?: boolean;
}) {
  return (
    <g opacity={dim ? 0.6 : 1}>
      <rect x={x} y={y} width={w} height={h} rx={6} fill={UI.elev} stroke={accent} strokeOpacity={dim ? 0.5 : 0.9} strokeWidth={1.5} strokeDasharray={dim ? '4 4' : undefined} />
      <text x={x + 12} y={y + 18} fill={UI.muted} fontSize="10" fontFamily={FONT_SANS} letterSpacing="0.1em" style={{ textTransform: 'uppercase' }}>{title}</text>
      <text x={x + 12} y={y + h - 10} fill={UI.muted} fontSize="10" fontFamily={FONT_SANS}>{subtitle ?? ''}</text>
      {/* The central core/value readout — uses the theme MONO var (Share Tech
          Mono in B5) so it matches the rest of the B5 flow chrome instead of the
          old hardcoded ui-sans-serif that clashed with the dark station UI. */}
      <text x={x + w - 12} y={y + h / 2 + (big ? 8 : 6)} textAnchor="end" fill={accent} fontSize={big ? 28 : 18} fontWeight="700" fontFamily={FONT_MONO}>
        {value}
      </text>
      {icon && (
        <text x={x + 12} y={y + h / 2 + 8} fill={accent} fontSize={big ? 26 : 22} fontFamily={FONT_SANS}>{icon}</text>
      )}
    </g>
  );
}

/**
 * v0.36.0 — a faint, un-animated connector for the grid STANDBY state: the grid
 * interconnect is present and available but the battery/PV is covering the home,
 * so it is NOT a live flow. Visually distinct from FlowLine (no moving dashes,
 * lower opacity) so a backstop-on-standby never reads as imported power.
 */
function StandbyLink({ from, to, color }: { from: [number, number]; to: [number, number]; color: string }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const cx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.22} strokeWidth={1.5} strokeDasharray="2 6" />
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 11}
        textAnchor="middle"
        fill={color}
        fontSize="11"
        fontFamily={FONT_SANS}
        stroke={UI.panel}
        strokeWidth={4}
        style={{ paintOrder: 'stroke' }}
      >
        standby
      </text>
    </g>
  );
}

function FlowLine({
  from,
  to,
  watts,
  color,
  period,
  strokeW,
  label,
}: {
  from: [number, number];
  to: [number, number];
  watts: number;
  color: string;
  period: number;
  strokeW: number;
  label: string;
}) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  // Smooth bezier (control points at horizontal midpoint)
  const cx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
  const active = period > 0;
  return (
    <g>
      {/* Base line */}
      <path d={d} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={strokeW} />
      {/* Animated dashes */}
      {active && (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray="6 10"
          strokeLinecap="round"
          style={{ animation: `flowdash ${period}s linear infinite` }}
        />
      )}
      {/* Wattage label — white halo (paint-order: stroke) keeps it readable
          where it crosses the animated flow path. */}
      {watts >= 1 && (
        <text
          x={(x1 + x2) / 2}
          y={(y1 + y2) / 2 - 11}
          textAnchor="middle"
          fill={color}
          fontSize="12"
          fontFamily={FONT_MONO}
          fontWeight="700"
          stroke={UI.panel}
          strokeWidth={4}
          style={{ paintOrder: 'stroke' }}
        >
          {Math.round(watts)} W
        </text>
      )}
    </g>
  );
}

function socAccent(soc: number | null) {
  if (soc == null) return HUES.grid;
  if (soc >= 50) return HUES.soc;
  if (soc >= 25) return HUES.solar;
  return UI.bad;
}
