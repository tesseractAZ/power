import { memo } from 'react';
import type { DeviceSnapshot, DpuProjection, Shp2EnergySource } from '../types';
import { fmtMins, fmtPct, fmtTemp, fmtW, fmtWh, socColor } from '../format';
// v0.22.0 — LazySparkline keeps recharts off the dashboard's first-paint path.
import { LazySparkline as Sparkline } from '../charts/LazySparkline';
import { HUES } from '../theme';

export interface DpuViaShp2 {
  source: Shp2EnergySource;
  liveWatts: number | null; // already signed: positive = discharging (contributing power)
  shp2Sn: string;           // for pulling SHP2-attributed history (src{N}_pct, src{N}_w)
}

/**
 * Unified DPU card. Every Core uses this same layout regardless of slot or WiFi state:
 *  - Header: name, SN, status pills
 *  - Headline: best-available SoC (direct → SHP2 fallback), remaining time, 2 sparklines
 *  - Direct telemetry grid: filled when DPU WiFi is up; "—" otherwise
 *  - Per-pack tiles: 5 packs always; live data when direct, "no data" placeholder otherwise
 *  - SHP2 view section: always shown for SHP2-bound DPUs (cross-reference + history fallback)
 */
// v0.22.0 — memo skips re-renders when the parent (App) re-renders without a
// new snapshot (tab/theme/history toggles). On an actual WS push `d`/`viaShp2`
// are fresh references, so the card still re-renders with new data — App's
// useMemo keeps those references stable across non-snapshot renders.
export const DpuCard = memo(function DpuCard({
  d,
  viaShp2,
}: {
  d: DeviceSnapshot & { projection?: DpuProjection };
  viaShp2?: DpuViaShp2;
}) {
  const p = d.projection;
  const directOk = !!p;
  // Headline SoC: direct preferred, fall back to SHP2's view of the pack
  const headlineSoc = p?.soc ?? viaShp2?.source.batteryPercentage ?? null;
  const headlineSocDigits = p?.soc != null ? 1 : 0;
  const remainTimeMin = p?.remainTimeMin ?? null;
  // Pack count: direct tells us, otherwise we know DPUs hold 5 packs
  const packCount = p?.packs.length ?? 5;
  // SHP2 source if bound; "slot" used for sparkline metric keys
  const source = viaShp2?.source;
  const slot = source?.slot;

  return (
    <div className="card">
      <Header d={d} directOk={directOk} viaShp2={!!viaShp2} slot={slot} />

      {/* Headline: SoC + remain + sparklines (sparklines fall back to SHP2-attributed when direct is empty) */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between">
          <span className="text-3xl font-bold tabular-nums">{fmtPct(headlineSoc, headlineSocDigits)}</span>
          <span className="text-xs text-muted">{remainTimeMin != null ? `${fmtMins(remainTimeMin)} remain` : '—'}</span>
        </div>
        <div className="bar mt-2">
          <div className={socColor(headlineSoc)} style={{ width: `${headlineSoc ?? 0}%` }} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-muted">SoC (1h){!directOk && viaShp2 ? ' · via SHP2' : ''}</div>
            {directOk ? (
              <Sparkline sn={d.sn} metric="soc" color={HUES.battery} />
            ) : viaShp2 ? (
              <Sparkline sn={viaShp2.shp2Sn} metric={`src${slot}_pct`} color={HUES.battery} />
            ) : (
              <div className="text-[10px] text-muted" style={{ height: 40 }}>no data</div>
            )}
          </div>
          <div>
            <div className="text-[10px] text-muted">Output (1h){!directOk && viaShp2 ? ' · via SHP2' : ''}</div>
            {directOk ? (
              <Sparkline sn={d.sn} metric="total_out" color={HUES.soc} />
            ) : viaShp2 ? (
              <Sparkline sn={viaShp2.shp2Sn} metric={`src${slot}_w`} color={HUES.soc} />
            ) : (
              <div className="text-[10px] text-muted" style={{ height: 40 }}>no data</div>
            )}
          </div>
        </div>
      </div>

      {/* Direct telemetry — same fields for every DPU; "—" when WiFi down */}
      <DirectGrid p={p} />

      {/* Per-pack tiles — always 5 slots, real data when direct, placeholder otherwise */}
      <div className="text-xs text-muted mb-1">
        {packCount} battery packs{!directOk && ' (per-pack detail needs DPU WiFi)'}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {Array.from({ length: packCount }, (_, i) => {
          const pk = p?.packs[i];
          if (pk) {
            return (
              <div key={i + 1} className="bg-panel2 border border-line rounded-lg p-2 text-center">
                <div className="text-[10px] text-muted">Pack {pk.num}</div>
                <div className="text-lg font-semibold tabular-nums">{fmtPct(pk.soc)}</div>
                <div className="bar mt-1"><div className={socColor(pk.soc)} style={{ width: `${pk.soc ?? 0}%` }} /></div>
                <div className="text-[10px] text-muted mt-1 leading-tight">
                  {fmtTemp(pk.temp)} · {pk.cycles ?? '—'}&#8635;
                </div>
                <div className="text-[10px] text-muted leading-tight">
                  {(pk.outputWatts ?? 0) > (pk.inputWatts ?? 0)
                    ? `▼ ${fmtW(pk.outputWatts)}`
                    : (pk.inputWatts ?? 0) > 0
                    ? `▲ ${fmtW(pk.inputWatts)}`
                    : 'idle'}
                </div>
              </div>
            );
          }
          return (
            <div key={i + 1} className="bg-panel2/40 border border-line/50 rounded-lg p-2 text-center opacity-60">
              <div className="text-[10px] text-muted">Pack {i + 1}</div>
              <div className="text-lg font-semibold tabular-nums text-muted">—</div>
              <div className="bar mt-1">
                <div className="bg-muted" style={{ width: `${headlineSoc ?? 0}%`, opacity: 0.3 }} />
              </div>
              <div className="text-[10px] text-muted mt-1 leading-tight">no data</div>
            </div>
          );
        })}
      </div>

      {/* SHP2 cross-reference — always at the bottom for bound DPUs */}
      {viaShp2 && <Shp2ViewSection viaShp2={viaShp2} />}
    </div>
  );
});

function Header({
  d,
  directOk,
  viaShp2,
  slot,
}: {
  d: DeviceSnapshot;
  directOk: boolean;
  viaShp2: boolean;
  slot: number | undefined;
}) {
  return (
    <div className="flex items-start justify-between mb-3">
      <div className="min-w-0">
        <div className="text-xs text-muted">{d.productName}</div>
        <div className="text-lg font-semibold truncate">{d.deviceName}</div>
        <div className="text-[10px] font-mono text-muted/80 truncate">{d.sn}</div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-1.5">
          {viaShp2 && slot != null && <span className="badge badge-muted">SHP2 slot {slot}</span>}
          <span className={`badge ${d.online ? 'badge-ok' : 'badge-bad'}`}>{d.online ? 'online' : 'offline'}</span>
        </div>
        {!directOk && viaShp2 && (
          <span className="text-[10px] text-muted">direct WiFi down · using SHP2 link</span>
        )}
      </div>
    </div>
  );
}

function DirectGrid({ p }: { p: DpuProjection | undefined }) {
  const v = (val: string | number | null | undefined, fmt = (x: string | number) => String(x)) =>
    p == null || val == null ? '—' : fmt(val);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3 text-sm">
      <div className="kv"><span className="kv-k whitespace-nowrap">PV in</span><span className="kv-v">{fmtW(p?.pvTotalWatts)}</span></div>
      <div className="kv"><span className="kv-k whitespace-nowrap">AC out</span><span className="kv-v">{fmtW(p?.acOutWatts)}</span></div>
      <div className="kv"><span className="kv-k whitespace-nowrap">AC in</span><span className="kv-v">{fmtW(p?.acInWatts)}</span></div>
      <div className="kv"><span className="kv-k whitespace-nowrap">Direct errors</span><span className="kv-v">{p?.sysErrCode ?? '—'}</span></div>
      <div className="kv"><span className="kv-k whitespace-nowrap">PV high MPPT</span><span className="kv-v">{fmtW(p?.pvHighWatts)}</span></div>
      <div className="kv"><span className="kv-k whitespace-nowrap">PV low MPPT</span><span className="kv-v">{fmtW(p?.pvLowWatts)}</span></div>
      {/* Compound-value rows span the full width so labels/values never wrap awkwardly */}
      <div className="kv col-span-2"><span className="kv-k whitespace-nowrap">Total in / out</span><span className="kv-v whitespace-nowrap">{fmtW(p?.totalInWatts)} · {fmtW(p?.totalOutWatts)}</span></div>
      <div className="kv col-span-2">
        <span className="kv-k whitespace-nowrap">Battery V / A</span>
        <span className="kv-v whitespace-nowrap">{v(p?.batVol, (x) => `${(x as number).toFixed(1)} V`)} · {v(p?.batAmp, (x) => `${(x as number).toFixed(2)} A`)}</span>
      </div>
      <div className="kv col-span-2">
        <span className="kv-k whitespace-nowrap">AC out freq / V</span>
        <span className="kv-v whitespace-nowrap">{v(p?.acOutFreq, (x) => `${x} Hz`)} · {v(p?.acOutVol, (x) => `${Math.round(x as number)} V`)}</span>
      </div>
      <div className="kv col-span-2">
        <span className="kv-k whitespace-nowrap">MPPT temp</span>
        <span className="kv-v whitespace-nowrap">HV {fmtTemp(p?.mpptHvTemp)} · LV {fmtTemp(p?.mpptLvTemp)}</span>
      </div>
    </div>
  );
}

/**
 * Compact "via SHP2" subsection rendered for every SHP2-bound DPU. Shows what the SHP2
 * sees over its wired link — useful as a cross-reference (e.g. SHP2's measured
 * contribution vs. the DPU's own total_out) and as a fallback when the DPU's WiFi is down.
 */
function Shp2ViewSection({ viaShp2 }: { viaShp2: DpuViaShp2 }) {
  const { source, liveWatts, shp2Sn } = viaShp2;
  const slot = source.slot;
  const remainWh =
    source.fullCap != null && source.batteryPercentage != null
      ? (source.fullCap * source.batteryPercentage) / 100
      : null;
  return (
    <div className="mt-4 pt-3 border-t border-line">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-widest text-muted">SHP2 view · slot {slot}</div>
        <span
          className={`badge text-[10px] ${
            source.isAcOpen ? 'badge-ok' : source.isConnected ? 'badge-warn' : 'badge-muted'
          }`}
        >
          {source.isAcOpen ? 'AC open' : source.isConnected ? 'standby' : 'disconnected'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3">
        <div className="kv"><span className="kv-k">Live contribution</span><span className="kv-v">{fmtW(liveWatts)}</span></div>
        <div className="kv"><span className="kv-k">EMS bat temp</span><span className="kv-v">{fmtTemp(source.emsBatTemp)}</span></div>
        <div className="kv"><span className="kv-k">Battery %</span><span className="kv-v">{fmtPct(source.batteryPercentage)}</span></div>
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
