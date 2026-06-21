import { memo, useEffect, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { DayForecast } from '../types';
import { fmtPct, fmtW } from '../format';
import { apiUrl } from '../api';
import { CHART, HUES, UI } from '../theme';

/**
 * Day-ahead forecast card: cloud-aware solar prediction, typical-day load, and
 * the resulting projected battery SoC trajectory for the next 24 hours.
 */
// v0.22.0 — zero-prop card, lazy-loaded by App so its recharts import stays
// off the entry chunk; memo also keeps it immune to App's snapshot re-renders.
export const ForecastCard = memo(function ForecastCard() {
  const [fc, setFc] = useState<DayForecast | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(apiUrl('api/forecast'));
        if (r.ok && !cancelled) setFc(await r.json());
      } catch {
        /* ignore */
      }
    };
    load();
    const t = window.setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const ready = fc && fc.hours.length > 0 && fc.historyDays > 0;

  return (
    <div className="card col-span-full">
      <div className="card-title flex items-center justify-between">
        <span>24-hour forecast</span>
        <span className="flex items-center gap-2 normal-case tracking-normal text-xs text-muted">
          {fc && (
            <span className={`badge ${fc.hasWeather ? 'badge-ok' : 'badge-muted'}`}>
              {fc.hasWeather ? 'cloud-aware' : 'history only'}
            </span>
          )}
          {fc && <span>{fc.historyDays.toFixed(1)} days of history</span>}
        </span>
      </div>

      {!ready ? (
        <div className="text-sm text-muted">
          {fc
            ? 'Building the forecast — needs a little recorded history first.'
            : 'Loading forecast…'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <Tile label="Solar next 24h" value={`${(fc!.forecastPvWhNext24 / 1000).toFixed(1)} kWh`} accent="text-warn" sub={`typical ${(fc!.typicalPvWhPerDay / 1000).toFixed(1)} kWh/day`} />
            <Tile
              label="Projected low SoC"
              value={fc!.minProjectedSoc != null ? fmtPct(fc!.minProjectedSoc, 0) : '—'}
              accent={fc!.minProjectedSoc != null && fc!.minProjectedSoc < fc!.reserveSoc ? 'text-bad' : 'text-ok'}
              sub={fc!.minProjectedSocTs ? `at ${new Date(fc!.minProjectedSocTs).toLocaleString([], { weekday: 'short', hour: 'numeric' })}` : ''}
            />
            <Tile label="Reserve floor" value={fmtPct(fc!.reserveSoc, 0)} sub="SHP2 backup reserve" />
            <Tile
              label="Outlook"
              value={
                fc!.minProjectedSoc != null && fc!.minProjectedSoc < fc!.reserveSoc
                  ? 'Tight'
                  : fc!.minProjectedSoc != null && fc!.minProjectedSoc < fc!.reserveSoc + 15
                  ? 'Watch'
                  : 'Comfortable'
              }
              accent={
                fc!.minProjectedSoc != null && fc!.minProjectedSoc < fc!.reserveSoc
                  ? 'text-bad'
                  : fc!.minProjectedSoc != null && fc!.minProjectedSoc < fc!.reserveSoc + 15
                  ? 'text-warn'
                  : 'text-ok'
              }
            />
          </div>

          <div style={{ width: '100%', height: 280 }}>
            {/* v0.12.0 — minWidth={0}/minHeight silence recharts' 0-size warning
                when the parent measures 0 at mount; fixed px height unchanged. */}
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
              <ComposedChart data={fc!.hours} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fcPv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={HUES.solar} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={HUES.solar} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={{ fill: CHART.axis, fontSize: 10 }}
                  tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
                />
                <YAxis yAxisId="w" tick={{ fill: CHART.axis, fontSize: 10 }} width={52} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tick={{ fill: CHART.axis, fontSize: 10 }} width={38} unit="%" />
                <Tooltip
                  contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: CHART.axis }}
                  labelFormatter={(t) => new Date(t as number).toLocaleString([], { weekday: 'short', hour: 'numeric' })}
                  formatter={(v, name) =>
                    name === 'Projected SoC'
                      ? `${typeof v === 'number' ? v.toFixed(0) : v}%`
                      : typeof v === 'number'
                      ? fmtW(v)
                      : v
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11, color: CHART.axis }} />
                <ReferenceLine yAxisId="soc" y={fc!.reserveSoc} stroke={UI.bad} strokeDasharray="4 4" strokeOpacity={0.7} />
                <Area yAxisId="w" type="monotone" dataKey="forecastPvW" name="Solar" stroke={HUES.solar} fill="url(#fcPv)" strokeWidth={1.5} isAnimationActive={false} />
                <Line yAxisId="w" type="monotone" dataKey="forecastLoadW" name="Load" stroke={HUES.battery} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="soc" type="monotone" dataKey="projectedSocPct" name="Projected SoC" stroke={HUES.soc} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[11px] text-muted mt-2 leading-relaxed">
            {/* v0.46.0 — caption follows the same hasWeather flag the badge uses.
                When weather is present the solar curve is the equipment-tuned GHI
                response model applied to the Open-Meteo radiation forecast; the
                fallback is the typical-day curve scaled by the cloud forecast. */}
            Solar ={' '}
            {fc!.hasWeather
              ? 'your equipment-tuned GHI response model applied to the Open-Meteo radiation forecast'
              : 'your typical-day production scaled by the Open-Meteo cloud forecast'}
            ; load = typical-day curve from history;
            SoC = current backup pool integrated forward (red dashed line marks the {fmtPct(fc!.reserveSoc, 0)} reserve).
            Sharpens as more history accumulates.
          </div>
        </>
      )}
    </div>
  );
});

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}
