import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { fmtW, fmtWh } from '../format';
import type { Shp2Circuit } from '../types';

interface Point {
  ts: number;
  value: number;
}

export function CircuitModal({
  sn,
  circuit,
  onClose,
}: {
  sn: string;
  circuit: Shp2Circuit;
  onClose: () => void;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [todayWh, setTodayWh] = useState<number | null>(null);

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
      const r1 = await fetch(`/api/history?sn=${sn}&metric=ch${circuit.ch}_w&since=${since}&bucket=60`);
      const j1 = (await r1.json()) as { points: Point[] };
      if (cancelled) return;
      setPoints(j1.points);

      // Compute today's Wh via the same trapezoidal idea client-side
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
  }, [sn, circuit.ch]);

  const peak = points.length > 0 ? Math.max(...points.map((p) => p.value)) : null;
  const avg = points.length > 0 ? points.reduce((s, p) => s + p.value, 0) / points.length : null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-line rounded-2xl w-full max-w-3xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="text-xs text-muted">SHP2 · circuit {circuit.ch} · {circuit.setAmp ?? '—'}A breaker</div>
            <div className="text-xl font-semibold">{circuit.name}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink text-2xl leading-none px-2">×</button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Stat label="Now" value={fmtW(circuit.watts)} />
          <Stat label="Peak (24h)" value={fmtW(peak)} />
          <Stat label="Average (24h)" value={fmtW(avg)} />
          <Stat label="Today" value={fmtWh(todayWh)} />
        </div>

        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradCircuit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#15803d" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#15803d" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#c4cad3" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                tick={{ fill: '#586474', fontSize: 10 }}
                tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              />
              <YAxis tick={{ fill: '#586474', fontSize: 10 }} width={48} unit=" W" />
              <Tooltip
                contentStyle={{ background: '#ffffff', border: '1px solid #9aa3b0', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#586474' }}
                labelFormatter={(t) => new Date(t as number).toLocaleString()}
                formatter={(v) => (typeof v === 'number' ? `${Math.round(v)} W` : v)}
              />
              <Area type="monotone" dataKey="value" stroke="#15803d" fill="url(#gradCircuit)" strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel2 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}
