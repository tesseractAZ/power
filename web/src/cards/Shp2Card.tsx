import { lazy, memo, Suspense, useState } from 'react';
import type { DeviceSnapshot, Shp2Circuit, Shp2PairedCircuit, Shp2Projection } from '../types';
import { fmtMins, fmtPct, fmtTemp, fmtW, fmtWh, socColor } from '../format';
// v0.22.0 — LazySparkline keeps recharts off the dashboard's first-paint path.
import { LazySparkline as Sparkline } from '../charts/LazySparkline';
import { RefreshCloudButton } from '../components/RefreshCloudButton';

// v0.22.0 — CircuitModal pulls in recharts (its 24 h circuit chart). It only
// renders when the user clicks a circuit tile, so a STATIC import here would
// drag the whole recharts chunk into the entry bundle for a view nobody has
// opened yet. Lazy-loading it defers that chunk until the first modal open —
// this is the last eager recharts edge on the dashboard's static graph.
const CircuitModal = lazy(() =>
  import('../components/CircuitModal').then((m) => ({ default: m.CircuitModal })),
);

// v0.22.0 — memo skips parent-driven re-renders that don't change `d`.
export const Shp2Card = memo(function Shp2Card({ d }: { d: DeviceSnapshot & { projection?: Shp2Projection } }) {
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
              <Sparkline sn={d.sn} metric="backup_pct" color="#0e7490" height={36} />
            </div>
            <div className="mt-2">
              <div className="text-[10px] text-muted">Panel load (1h)</div>
              <Sparkline sn={d.sn} metric="panel_load" color="#15803d" height={36} />
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
                          <Sparkline sn={d.sn} metric={histMetric} color={active ? '#15803d' : '#586474'} height={32} />
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
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-2xl font-bold tabular-nums">{fmtPct(s.batteryPercentage)}</span>
                  <span className="text-xs text-muted">
                    {fmtW(p.sourceWatts[i] != null ? -p.sourceWatts[i] : null)} · {fmtTemp(s.emsBatTemp)}
                  </span>
                </div>
                <div className="bar mt-2"><div className={socColor(s.batteryPercentage)} style={{ width: `${s.batteryPercentage ?? 0}%` }} /></div>
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
