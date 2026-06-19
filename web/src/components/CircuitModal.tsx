import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { fmtW, fmtWh } from '../format';
import type { Shp2Circuit, Shp2PairedCircuit, CircuitHistory, CircuitDayTotal } from '../types';
import { apiUrl } from '../api';
import { CHART, HUES } from '../theme';

interface Point {
  ts: number;
  value: number;
}

const HISTORY_DAYS = 7;

/**
 * v0.9.8 — when a paired (split-phase) circuit is clicked from Shp2Card,
 * the modal must show the combined load across both legs, not just the
 * primary. We solve this with an optional `pair` prop:
 *
 *   - `circuit` always holds the primary leg (for breaker amps, link
 *     marker, "Now" watts — `pair.watts` is already the sum)
 *   - When `pair` is set + paired, we query the server's pre-summed
 *     `pair${primaryCh}_w` metric for both the 24-h chart and the
 *     multi-day kWh history (the server respects `?pair=N`).
 *   - Header/labels switch to "circuits N+M · 240 V · NA double-pole"
 *     so the user understands which slice they're looking at.
 */
export function CircuitModal({
  sn,
  circuit,
  pair,
  onClose,
}: {
  sn: string;
  circuit: Shp2Circuit;
  pair?: Shp2PairedCircuit;
  onClose: () => void;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [todayWh, setTodayWh] = useState<number | null>(null);
  const [history, setHistory] = useState<CircuitHistory | null>(null);

  // A paired *split-phase* tile is the only case where we want the combined
  // series. Paired but single-leg (no secondary, isSplitPhase = false) falls
  // back to the normal ch${primary}_w metric — there's nothing to combine.
  const useCombined = !!pair && pair.isSplitPhase && pair.secondaryCh != null;
  const seriesMetric = useCombined ? `pair${pair!.primaryCh}_w` : `ch${circuit.ch}_w`;
  const histQuery = useCombined ? `pair=${pair!.primaryCh}` : `ch=${circuit.ch}`;
  const nowWatts = useCombined ? pair!.watts : circuit.watts;
  const breakerAmps = useCombined ? pair!.breakerAmps : circuit.setAmp;
  const title = useCombined ? pair!.name : circuit.name;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const [r1, r2] = await Promise.all([
        fetch(apiUrl(`api/history?sn=${sn}&metric=${seriesMetric}&since=${since}&bucket=60`)),
        fetch(apiUrl(`api/circuit/history?sn=${sn}&${histQuery}&days=${HISTORY_DAYS}`)),
      ]);
      const j1 = (await r1.json()) as { points: Point[] };
      const j2 = (await r2.json()) as CircuitHistory;
      if (cancelled) return;
      setPoints(j1.points);
      setHistory(j2);

      // Compute today's Wh via the same trapezoidal idea client-side. The
      // server's /api/circuit/history also returns today's kWh, but this
      // local pass keeps the "Today" tile fresh between 60s polls.
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const todayPts = j1.points.filter((p) => p.ts >= dayStart.getTime());
      let wh = 0;
      const MAX_GAP = 10 * 60 * 1000;
      for (let i = 1; i < todayPts.length; i++) {
        const dt = todayPts[i].ts - todayPts[i - 1].ts;
        if (dt <= 0 || dt > MAX_GAP) continue;
        wh += ((todayPts[i].value + todayPts[i - 1].value) / 2) * (dt / 3_600_000);
      }
      setTodayWh(wh);
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [sn, seriesMetric, histQuery]);

  const peak = points.length > 0 ? Math.max(...points.map((p) => p.value)) : null;
  const avg = points.length > 0 ? points.reduce((s, p) => s + p.value, 0) / points.length : null;

  const subtitle = useCombined
    ? `SHP2 · circuits ${pair!.primaryCh}+${pair!.secondaryCh} · ${breakerAmps ?? '—'}A double-pole · 240 V`
    : `SHP2 · circuit ${circuit.ch} · ${breakerAmps ?? '—'}A breaker`;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-line rounded-2xl w-full max-w-3xl p-5 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="text-xs text-muted">{subtitle}</div>
            <div className="text-xl font-semibold">{title}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink text-2xl leading-none px-2">×</button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Stat label="Now" value={fmtW(nowWatts)} />
          <Stat label="Peak (24h)" value={fmtW(peak)} />
          <Stat label="Average (24h)" value={fmtW(avg)} />
          <Stat label="Today" value={fmtWh(todayWh)} />
        </div>

        <div className="text-xs uppercase tracking-widest text-muted mb-1.5">Last 24 hours</div>
        <div style={{ width: '100%', height: 240 }}>
          {/* v0.12.0 — minWidth={0}/minHeight stop recharts' "width(-1) and
              height(-1)…" warning: a modal mounts inside a flex-centered
              overlay, so the box can measure 0 on the first layout pass. */}
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={240}>
            <AreaChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradCircuit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={HUES.soc} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={HUES.soc} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                tick={{ fill: CHART.axis, fontSize: 10 }}
                tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              />
              <YAxis tick={{ fill: CHART.axis, fontSize: 10 }} width={48} unit=" W" />
              <Tooltip
                contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: CHART.axis }}
                labelFormatter={(t) => new Date(t as number).toLocaleString()}
                formatter={(v) => (typeof v === 'number' ? `${Math.round(v)} W` : v)}
              />
              <Area type="monotone" dataKey="value" stroke={HUES.soc} fill="url(#gradCircuit)" strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <HistorySection history={history} />
      </div>
    </div>
  );
}

/** "Last N days" bar chart + summary tiles. */
function HistorySection({ history }: { history: CircuitHistory | null }) {
  if (!history) {
    return (
      <div className="mt-5 text-xs text-muted">Loading multi-day history…</div>
    );
  }
  if (history.days.length === 0 || history.summary.daysWithData === 0) {
    return (
      <div className="mt-5 text-xs text-muted">
        No multi-day history recorded yet — bars appear as the recorder accumulates samples.
      </div>
    );
  }
  const peakDate = history.summary.peakDay?.date;
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs uppercase tracking-widest text-muted">Last {history.days.length} days</span>
        <span className="text-[10px] text-muted">today is partial; bars are daily kWh totals</span>
      </div>
      <div style={{ width: '100%', height: 180 }}>
        {/* v0.12.0 — minWidth={0}/minHeight: same modal 0-size guard as above. */}
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
          <BarChart data={history.days} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: CHART.axis, fontSize: 10 }}
              tickFormatter={(s: string) => dayLabel(s)}
              interval={0}
            />
            <YAxis tick={{ fill: CHART.axis, fontSize: 10 }} width={48} unit=" kWh" />
            <Tooltip content={<BarTooltip />} cursor={{ fill: 'rgba(154,163,176,0.1)' }} />
            <Bar dataKey="kwh" isAnimationActive={false} radius={[3, 3, 0, 0]}>
              {history.days.map((d) => (
                <Cell
                  key={d.date}
                  fill={d.isToday ? HUES.battery : d.date === peakDate ? HUES.solar : HUES.soc}
                  fillOpacity={d.coverageMs > 0 ? 1 : 0.25}
                />
              ))}
            </Bar>
            {history.summary.avgKwh > 0 && (
              <ReferenceLine
                y={history.summary.avgKwh}
                stroke={CHART.tooltipBorder}
                strokeDasharray="4 4"
                label={{
                  value: `avg ${history.summary.avgKwh.toFixed(2)} kWh`,
                  position: 'right',
                  fill: CHART.axis,
                  fontSize: 10,
                }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3">
        <SmallStat
          label="Avg / day"
          value={`${history.summary.avgKwh.toFixed(2)} kWh`}
          sub={`${history.summary.daysWithData}/${history.days.length} days w/ data`}
        />
        <SmallStat
          label="Peak day"
          value={history.summary.peakDay ? `${history.summary.peakDay.kwh.toFixed(2)} kWh` : '—'}
          sub={
            history.summary.peakDay
              ? `${dayLabel(history.summary.peakDay.date)} · peak ${history.summary.peakDay.peakW} W`
              : '—'
          }
          accent="text-warn"
        />
        <SmallStat
          label="Quietest"
          value={history.summary.minDay ? `${history.summary.minDay.kwh.toFixed(2)} kWh` : '—'}
          sub={history.summary.minDay ? dayLabel(history.summary.minDay.date) : '—'}
        />
      </div>
    </div>
  );
}

/** Custom recharts tooltip — one-glance per-day summary. */
function BarTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: CircuitDayTotal }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-panel border border-line rounded-md px-3 py-2 text-xs shadow-lg">
      <div className="font-semibold text-ink">
        {dayLabel(d.date)} <span className="text-muted font-normal">· {d.date}</span>
      </div>
      <div className="mt-1">
        Energy: <span className="font-mono tabular-nums text-ink">{d.kwh.toFixed(3)} kWh</span>
        {d.isToday && <span className="text-muted"> · running total</span>}
        {!d.isToday && d.coverageMs > 0 && d.coverageMs < 23 * 60 * 60 * 1000 && (
          <span className="text-muted"> · partial day</span>
        )}
      </div>
      <div>
        Peak: <span className="font-mono tabular-nums text-ink">{d.peakW} W</span>
        {d.peakAtMs && (
          <span className="text-muted">
            {' '}
            @ {new Date(d.peakAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {d.coverageMs === 0 && <div className="text-muted mt-1">no recorded data</div>}
    </div>
  );
}

/** "Today", "Yest", "Wed", "5/12" — context-sensitive day label. */
function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yest';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return `${m}/${d}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel2 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function SmallStat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-md p-2">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
