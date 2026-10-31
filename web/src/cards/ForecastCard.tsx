import { memo, useEffect, useState } from 'react';
import { outlookOf, forecastView, restoredSolarBadge, alarmBasisLine } from './cardText';
import { kwTick } from '../charts/axisFormat';
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
import { fmtLocaleIn } from '../siteTime';
import { CHART, HUES, UI } from '../theme';

// v1.183.0 — outlook tone → text colour (a neutral tone gets none).
const TONE_CLASS = { bad: 'text-bad', warn: 'text-warn', ok: 'text-ok', muted: undefined } as const;

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
  // v1.191.1 — the times below are written in the site zone the payload names (GET /api/forecast
  // `siteTimeZone`), the zone the server computed the hours in, never the browser's.
  const zone = fc?.siteTimeZone;
  // v1.195.0 — the figures shown (cardText.forecastView): the restored display basis while home Cores
  // are offline in the cloud (it read 0 kWh and a 0% low then — the alarm basis, no Core reporting),
  // labelled, with the runway alarm's own figures beside it; otherwise the alarm basis, as before.
  const view = fc ? forecastView(fc) : null;
  const lowAt = view?.minSocTs ? fmtLocaleIn(view.minSocTs, zone, { weekday: 'short', hour: 'numeric' }) : null;

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
          {/* v0.75.0 — calm caveat when a wired home Core is cloud-offline: the
              day-ahead PV / projected-low-SoC is computed from a degraded basis. */}
          {fc && fc.homeDpusCoveragePartial && fc.homeDpusConnected != null && (
            <span className="badge badge-warn normal-case tracking-normal">
              Forecast basis: {fc.homeDpusReporting ?? 0} of {fc.homeDpusConnected} home Cores reporting
            </span>
          )}
          {view?.restored && (
            <span className="badge badge-muted normal-case tracking-normal">{restoredSolarBadge(view.restoredCores, view.pending)}</span>
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
            <Tile
              label="Solar next 24h"
              value={view!.pvWh != null ? `${(view!.pvWh / 1000).toFixed(1)} kWh` : '—'}
              accent="text-warn"
              sub={view!.typicalWh != null ? `typical ${(view!.typicalWh / 1000).toFixed(1)} kWh/day` : 'no PV history'}
            />
            <Tile
              label="Projected low SoC"
              value={view!.minSoc != null ? fmtPct(view!.minSoc, 0) : '—'}
              accent={view!.minSoc == null ? undefined : view!.minSoc < fc!.reserveSoc ? 'text-bad' : 'text-ok'}
              sub={lowAt ? `at ${lowAt}` : ''}
            />
            <Tile label="Reserve floor" value={fmtPct(fc!.reserveSoc, 0)} sub="SHP2 backup reserve" />
            <Tile
              label="Outlook"
              // v1.183.0 — no projection is not "Comfortable" (cardText.outlookOf).
              value={outlookOf(view!.minSoc, fc!.reserveSoc).label}
              accent={TONE_CLASS[outlookOf(view!.minSoc, fc!.reserveSoc).tone]}
              sub={view!.minSoc == null ? 'no projection yet' : undefined}
            />
          </div>
          {/* v1.195.0 — on the restored basis, the runway alarm's own figures beside it. */}
          {view!.restored && (
            <div className="text-[11px] text-muted -mt-1 mb-3">{alarmBasisLine(view!.alarm)}</div>
          )}

          <div style={{ width: '100%', height: 280 }}>
            {/* v0.12.0 — minWidth={0}/minHeight silence recharts' 0-size warning
                when the parent measures 0 at mount; fixed px height unchanged. */}
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
              <ComposedChart data={view!.hours} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                  tickFormatter={(t) => fmtLocaleIn(t, zone, { hour: 'numeric' }) ?? ''}
                />
                <YAxis yAxisId="w" tick={{ fill: CHART.axis, fontSize: 10 }} width={52} tickFormatter={kwTick} label={{ value: 'kW', angle: -90, position: 'insideLeft', fill: CHART.axis, fontSize: 10 }} />
                <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tick={{ fill: CHART.axis, fontSize: 10 }} width={38} unit="%" />
                <Tooltip
                  contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: CHART.axis }}
                  labelFormatter={(t) => fmtLocaleIn(t as number, zone, { weekday: 'short', hour: 'numeric' }) ?? ''}
                  formatter={(v, name) =>
                    name === 'Projected SoC' || name === 'Alarm-basis SoC'
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
                {/* v1.195.0 — on the restored basis, the runway alarm's own SoC path (reporting Cores only). */}
                {view!.restored && (
                  <Line yAxisId="soc" type="monotone" dataKey="alarmSocPct" name="Alarm-basis SoC" stroke={HUES.soc} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.6} dot={false} isAnimationActive={false} connectNulls />
                )}
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
            {view!.restored && (
              <>
                {' '}While home Cores are offline in the cloud, solar and SoC are rebuilt from each offline Core&apos;s own
                recorded production; the dashed SoC line is the runway alarm&apos;s, which counts only the Cores reporting live.
              </>
            )}
            {' '}Sharpens as more history accumulates.
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
