import { lazy, memo, Suspense, useState } from 'react';
import type { ReactNode } from 'react';
import type { DeviceSnapshot, GridBackstop, Shp2Circuit, Shp2PairedCircuit, Shp2Projection } from '../types';
import { fmtMins, fmtPct, fmtTemp, fmtW, fmtWh, socColor } from '../format';
// v0.22.0 — LazySparkline keeps recharts off the dashboard's first-paint path.
import { LazySparkline as Sparkline } from '../charts/LazySparkline';
import { RefreshCloudButton } from '../components/RefreshCloudButton';
import { HUES, UI } from '../theme';
import type { DpuViaShp2 } from './DpuCard';

// v0.36.0 — the SHP2 IS the grid interconnect: grid is a BACKSTOP it taps
// automatically when the backup pool hits its reserve floor (or for rebalancing).
// v0.37.0 — the server attaches the GridBackstop (gridState.ts) + an `off_grid`
// flag onto the SHP2 DEVICE snapshot (snapshotForClient), and `DeviceSnapshot`
// now declares both, so we read them off `d.grid`/`d.off_grid` with the shared
// `GridBackstop` type — no local shim. Three operator-facing states, in priority
// order:
//   (1) ACTIVE   — grid carrying the home right now (homeGridWatts>0, or DPU
//                  ac_in importWatts>0): show as a live source → "Grid X.X kW → home".
//   (2) STANDBY  — grid present/declared but not needed (battery/PV covering):
//                  "Grid: available (backstop)".
//   (3) ISLANDED — grid not present: "Off-grid".
type GridStatus =
  | { state: 'active'; homeWatts: number; importWatts: number; reason?: string }
  | { state: 'standby'; reason?: string }
  | { state: 'islanded'; reason?: string }
  | { state: 'unknown' };

function resolveGridStatus(
  grid: GridBackstop | undefined,
  offGrid: boolean | undefined,
): GridStatus {
  // Off-grid is authoritative: an islanded SHP2 has no grid to tap.
  if (offGrid === true || grid?.present === false) {
    return { state: 'islanded', reason: grid?.reason };
  }
  if (!grid) return { state: 'unknown' };
  const homeWatts = grid.homeGridWatts ?? 0;
  const importWatts = grid.importWatts ?? 0;
  // ACTIVE NOW — grid is carrying the home (SHP2 main backstop) or charging the
  // DPUs (ac_in). Either measured flow means the grid is being tapped right now.
  if (homeWatts > 0 || importWatts > 0 || grid.importLive) {
    return { state: 'active', homeWatts, importWatts, reason: grid.reason };
  }
  // Present/declared but no measured flow → grid is there as a standby backstop.
  if (grid.present || grid.declared) {
    return { state: 'standby', reason: grid.reason };
  }
  return { state: 'unknown' };
}

function GridStatusLine({ d }: { d: DeviceSnapshot }) {
  const status = resolveGridStatus(d.grid, d.off_grid);
  if (status.state === 'unknown') return null;

  // Theme-aware colors: grid identity hue for the live/standby states, the card's
  // bad token for an islanded home. cssVar (UI.*) keeps High Contrast (dark) correct.
  const dotStyle = (color: string) => ({
    width: 8,
    height: 8,
    borderRadius: 9999,
    background: color,
    flex: '0 0 auto',
  });

  let dot: string;
  let label: ReactNode;
  let detail: string | undefined;

  if (status.state === 'active') {
    dot = HUES.grid;
    // Prefer the SHP2 main-line home power (the new backstop path); fall back to
    // the DPU ac_in import when only that is flowing.
    const flowWatts = status.homeWatts > 0 ? status.homeWatts : status.importWatts;
    const kw = (flowWatts / 1000).toFixed(1);
    label = (
      <span>
        <span className="font-semibold" style={{ color: UI.ink }}>Grid {kw} kW</span>
        <span style={{ color: UI.muted }}> → home</span>
      </span>
    );
    detail = status.homeWatts > 0 ? 'backstopping the home now' : 'charging the cores (ac-in)';
  } else if (status.state === 'standby') {
    dot = HUES.grid;
    label = (
      <span style={{ color: UI.muted }}>
        Grid: <span className="font-medium" style={{ color: UI.ink }}>available</span> (standby backstop)
      </span>
    );
    detail = 'connected, not needed — battery/PV covering';
  } else {
    // islanded
    dot = UI.bad;
    label = <span className="font-semibold" style={{ color: UI.bad }}>Off-grid (islanded)</span>;
    detail = 'no grid — running on battery + PV';
  }

  return (
    <div
      className="mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5"
      style={{ background: UI.panel2, border: `1px solid ${UI.line}` }}
      title={status.reason}
    >
      <span style={dotStyle(dot)} />
      <span className="text-sm leading-tight">{label}</span>
      {detail ? <span className="text-[10px] ml-auto text-right" style={{ color: UI.muted }}>{detail}</span> : null}
    </div>
  );
}

// v0.22.0 — CircuitModal pulls in recharts (its 24 h circuit chart). It only
// renders when the user clicks a circuit tile, so a STATIC import here would
// drag the whole recharts chunk into the entry bundle for a view nobody has
// opened yet. Lazy-loading it defers that chunk until the first modal open —
// this is the last eager recharts edge on the dashboard's static graph.
const CircuitModal = lazy(() =>
  import('../components/CircuitModal').then((m) => ({ default: m.CircuitModal })),
);

/**
 * v0.70.0 — per-slot DPU detail, rendered in-box at the bottom of each SHP2
 * "Energy sources" slot. This used to be a standalone "SHP2 view · slot N" section
 * at the bottom of every SHP2-bound DpuCard; folding it into the matching slot box
 * keeps all of a slot's info in one place. The summary fields the slot box already
 * shows up top — battery %, signed watts, EMS temp, status badge — are intentionally
 * NOT repeated here; this adds the deeper SHP2-link fields plus the SHP2-attributed
 * history sparklines (which are exactly what survive a DPU WiFi/cloud drop). `liveWatts`
 * stays on the prop (the slot box header renders it) so the DpuViaShp2 contract is unchanged.
 */
function Shp2ViewSection({ viaShp2 }: { viaShp2: DpuViaShp2 }) {
  const { source, shp2Sn } = viaShp2;
  const slot = source.slot;
  const remainWh =
    source.fullCap != null && source.batteryPercentage != null
      ? (source.fullCap * source.batteryPercentage) / 100
      : null;
  return (
    <div className="mt-3 pt-3 border-t border-line">
      <div className="text-[10px] uppercase tracking-widest text-muted mb-2">DPU detail</div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3">
        <div className="kv"><span className="kv-k">Remain (est)</span><span className="kv-v">{fmtWh(remainWh)}</span></div>
        <div className="kv"><span className="kv-k">Capacity</span><span className="kv-v">{fmtWh(source.fullCap)}</span></div>
        <div className="kv"><span className="kv-k">Rated power</span><span className="kv-v">{fmtW(source.ratePower)}</span></div>
        <div className="kv"><span className="kv-k">HW link</span><span className="kv-v">{source.hwConnect ? 'connected' : 'no link'}</span></div>
        <div className="kv"><span className="kv-k">SHP2 errors</span><span className="kv-v">{source.errorCodeNum ?? 0}</span></div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] text-muted">SoC (1h) · via SHP2</div>
          <Sparkline sn={shp2Sn} metric={`src${slot}_pct`} color={HUES.violet} />
        </div>
        <div>
          <div className="text-[10px] text-muted">Contribution (1h) · via SHP2</div>
          <Sparkline sn={shp2Sn} metric={`src${slot}_w`} color={HUES.violet} />
        </div>
      </div>
    </div>
  );
}

// v0.22.0 — memo skips parent-driven re-renders that don't change `d`.
// v0.36.0 — the SHP2 snapshot also carries the grid-backstop view (`grid`) and a
// top-level `off_grid` flag, surfaced here as the grid-interconnect status line.
export const Shp2Card = memo(function Shp2Card({
  d,
}: {
  d: DeviceSnapshot & { projection?: Shp2Projection };
}) {
  const p = d.projection;
  // v0.9.8 — track both the leg (for breaker/single-leg fields) and the pair
  // (for combined 240 V chart + kWh history) when the user clicks a paired tile.
  const [selected, setSelected] = useState<{ circuit: Shp2Circuit; pair?: Shp2PairedCircuit } | null>(null);
  const [showLegs, setShowLegs] = useState(false);
  return (
    <div className="card col-span-full">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">{d.productName}</div>
          <div className="text-lg font-semibold">{d.deviceName}</div>
          <div className="text-[10px] font-mono text-muted/80">{d.sn}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`badge ${d.online ? 'badge-ok' : 'badge-bad'}`}>{d.online ? 'online' : 'offline'}</span>
          <RefreshCloudButton sn={d.sn} deviceLabel={d.deviceName} />
        </div>
      </div>

      {/* v0.36.0 — grid interconnect status: the SHP2 connects the grid and taps
          it as a backstop when the backup pool needs it. ACTIVE / STANDBY / ISLANDED. */}
      <GridStatusLine d={d} />

      {!p ? (
        <div className="text-sm text-muted">No telemetry yet.</div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_2fr] gap-6">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted mb-2">Backup pool</div>
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-bold tabular-nums">{fmtPct(p.backupBatPercent)}</span>
              <span className="text-xs text-muted">reserve {fmtPct(p.backupReserveSoc)}</span>
            </div>
            <div className="bar mt-2"><div className={socColor(p.backupBatPercent)} style={{ width: `${p.backupBatPercent ?? 0}%` }} /></div>
            <div className="mt-3">
              <div className="text-[10px] text-muted">Backup % (1h)</div>
              <Sparkline sn={d.sn} metric="backup_pct" color={HUES.battery} height={36} />
            </div>
            <div className="mt-2">
              <div className="text-[10px] text-muted">Panel load (1h)</div>
              <Sparkline sn={d.sn} metric="panel_load" color={HUES.soc} height={36} />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1">
              <div className="kv"><span className="kv-k">Remain (disch)</span><span className="kv-v">{fmtMins(p.backupDischargeTimeMin)}</span></div>
              <div className="kv"><span className="kv-k">Charge time</span><span className="kv-v">{fmtMins(p.backupChargeTimeMin)}</span></div>
              <div className="kv"><span className="kv-k">Capacity (full)</span><span className="kv-v">{fmtWh(p.backupFullCapWh)}</span></div>
              <div className="kv"><span className="kv-k">Capacity (now)</span><span className="kv-v">{fmtWh(p.backupRemainWh)}</span></div>
              <div className="kv"><span className="kv-k">Charge power</span><span className="kv-v">{fmtW(p.chargeWattPower)}</span></div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-widest text-muted">
                {showLegs ? `Channels (${p.circuits.length})` : `Circuits (${p.pairedCircuits.length})`}
              </div>
              <button
                type="button"
                onClick={() => setShowLegs((v) => !v)}
                className="badge badge-muted hover:bg-muted/20 transition-colors text-[10px]"
              >
                {showLegs ? 'show paired' : 'show legs'}
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {showLegs
                ? p.circuits.map((c) => {
                    const w = c.watts ?? 0;
                    const pct = c.setAmp ? Math.min(100, (w / (c.setAmp * 120)) * 100) : 0;
                    const active = w > 1;
                    return (
                      <button
                        type="button"
                        key={c.ch}
                        onClick={() => setSelected({ circuit: c })}
                        className={`text-left bg-panel2 border ${active ? 'border-ok/30' : 'border-line'} rounded-lg p-2 hover:border-accent/60 transition-colors`}
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="text-sm font-medium truncate" title={c.name}>{c.name}</span>
                          <span className="text-[10px] text-muted">{c.setAmp ?? '—'}A</span>
                        </div>
                        <div className="flex items-baseline justify-between mt-1">
                          <span className={`text-base font-semibold tabular-nums ${active ? 'text-ok' : 'text-muted'}`}>{fmtW(c.watts)}</span>
                          <span className="text-[10px] text-muted">ch{c.ch}{c.linkCh != null && c.linkMark ? `↔${c.linkCh}` : ''}</span>
                        </div>
                        <div className="bar mt-1"><div className={active ? 'bg-ok' : 'bg-muted'} style={{ width: `${pct}%` }} /></div>
                      </button>
                    );
                  })
                : p.pairedCircuits.map((pc) => {
                    const w = pc.watts ?? 0;
                    // 240V for split-phase, 120V otherwise
                    const v = pc.isSplitPhase ? 240 : 120;
                    const pct = pc.breakerAmps ? Math.min(100, (w / (pc.breakerAmps * v)) * 100) : 0;
                    const active = w > 1;
                    // Click target — use the primary leg for the modal
                    const primaryCircuit = p.circuits.find((c) => c.ch === pc.primaryCh);
                    const histMetric = pc.isSplitPhase ? `pair${pc.primaryCh}_w` : `ch${pc.primaryCh}_w`;
                    return (
                      <button
                        type="button"
                        key={pc.primaryCh}
                        onClick={() => primaryCircuit && setSelected({ circuit: primaryCircuit, pair: pc })}
                        className={`text-left bg-panel2 border ${active ? 'border-ok/30' : 'border-line'} rounded-lg p-3 hover:border-accent/60 transition-colors`}
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="text-sm font-medium truncate" title={pc.name}>{pc.name}</span>
                          <span className="text-[10px] text-muted">{pc.breakerAmps ?? '—'}A{pc.isSplitPhase ? ' · 240V' : ''}</span>
                        </div>
                        <div className="flex items-baseline justify-between mt-1">
                          <span className={`text-xl font-semibold tabular-nums ${active ? 'text-ok' : 'text-muted'}`}>{fmtW(pc.watts)}</span>
                          <span className="text-[10px] text-muted">
                            {pc.isSplitPhase ? `ch${pc.primaryCh}+${pc.secondaryCh}` : `ch${pc.primaryCh}`}
                          </span>
                        </div>
                        <div className="bar mt-1.5"><div className={active ? 'bg-ok' : 'bg-muted'} style={{ width: `${pct}%` }} /></div>
                        <div className="mt-2">
                          <div className="text-[9px] uppercase tracking-wider text-muted/70 mb-0.5">last hour</div>
                          <Sparkline sn={d.sn} metric={histMetric} color={active ? HUES.soc : HUES.grid} height={32} />
                        </div>
                      </button>
                    );
                  })}
            </div>
          </div>
        </div>
      )}

      {p && (
        <div className="mt-5">
          <div className="text-xs uppercase tracking-widest text-muted mb-2">
            Energy sources ({p.sources.length})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {p.sources.map((s, i) => (
              <div key={s.slot} className="bg-panel2 border border-line rounded-lg p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    Slot {s.slot}
                    {s.sn ? <span className="text-[10px] font-mono text-muted/80 ml-2">{s.sn}</span> : null}
                  </span>
                  <span className={`badge ${s.isConnected ? (s.isAcOpen ? 'badge-ok' : 'badge-warn') : 'badge-muted'}`}>
                    {s.isConnected ? (s.isAcOpen ? 'active' : 'connected') : 'disconnected'}
                  </span>
                </div>
                {s.dpuStale ? (
                  <div
                    className="mt-1"
                    title="The SHP2 still counts this slot's battery in the backup pool, and the pool capacity stays accurate (the SHP2 measures it directly). The slot's DPU is marked offline (last-known EcoFlow-cloud state), so its own per-DPU telemetry is stale."
                  >
                    <span className="badge badge-warn text-[10px]">⚠ DPU telemetry stale · battery still counted</span>
                  </div>
                ) : null}
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-2xl font-bold tabular-nums">{fmtPct(s.batteryPercentage)}</span>
                  <span className="text-xs text-muted">
                    {fmtW(p.sourceWatts[i] != null ? -p.sourceWatts[i] : null)} · {fmtTemp(s.emsBatTemp)}
                  </span>
                </div>
                <div className="bar mt-2"><div className={socColor(s.batteryPercentage)} style={{ width: `${s.batteryPercentage ?? 0}%` }} /></div>
                {/* v0.70.0 — per-slot DPU detail, in-box at the bottom (was a standalone
                    "SHP2 view · slot N" section on each DpuCard). Guard on s.sn so an
                    empty/spare connector renders exactly as before (no detail block). */}
                {s.sn ? (
                  <Shp2ViewSection
                    viaShp2={{
                      source: s,
                      liveWatts: p.sourceWatts[i] != null ? -p.sourceWatts[i] : null,
                      shp2Sn: d.sn,
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && p && (
        <Suspense fallback={null}>
          <CircuitModal
            sn={d.sn}
            circuit={selected.circuit}
            pair={selected.pair}
            onClose={() => setSelected(null)}
          />
        </Suspense>
      )}
    </div>
  );
});
