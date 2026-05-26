/**
 * v0.9.40 — Forecast canvas.
 *
 * Beautiful 24-hour outlook combining PV (solar gold) and Load (pink)
 * forecasts in a single canvas. Stacked area chart with linear gradient
 * fills, fine grid, large axis labels. Reserves the "now" indicator
 * as a thin vertical hairline.
 *
 * Wired to /api/forecast (the existing day-ahead Bayesian forecast).
 * Falls back to a "no forecast yet" placeholder when data missing.
 */

import { useEffect, useState } from 'react';
import { fmtClock } from '../utils';

interface ForecastPoint {
  hour: number;                 // 0..23 (in next 24h)
  ts: number;                   // ms
  pvWh: number | null;
  loadWh: number | null;
  socPct: number | null;
}

export function ForecastCanvas() {
  const [points, setPoints] = useState<ForecastPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/forecast');
        if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        // The existing /api/forecast returns either an array of 24 hourly
        // entries, or a shape we need to coerce. Be flexible.
        const arr = Array.isArray(data) ? data : data?.hours ?? data?.forecast ?? [];
        const mapped: ForecastPoint[] = (arr as Array<Record<string, unknown>>).slice(0, 24).map((p, i) => ({
          hour: i,
          ts: Number(p.ts ?? Date.now() + i * 3_600_000),
          pvWh: numOrNull(p.pvWh ?? p.pv_wh ?? p.pv ?? p.pvForecast ?? p.pv_p50),
          loadWh: numOrNull(p.loadWh ?? p.load_wh ?? p.load ?? p.loadForecast),
          socPct: numOrNull(p.socPct ?? p.soc_pct ?? p.soc),
        }));
        setPoints(mapped.length > 0 ? mapped : null);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      }
    }
    load();
    const t = window.setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);

  return (
    <div className="opus-glass p-6">
      <div className="flex items-baseline justify-between mb-1">
        <div className="opus-eyebrow">24-HOUR OUTLOOK</div>
        <div className="opus-label">SOLAR · LOAD · STORAGE</div>
      </div>
      <div style={{ color: 'rgb(var(--color-ink))', fontSize: 16, fontWeight: 500, marginBottom: 24 }}>
        {points && points.length > 0
          ? sentenceFor(points)
          : err
            ? 'Forecast unavailable.'
            : 'Loading forecast…'}
      </div>

      {points && points.length > 0 ? (
        <ForecastSvg points={points} />
      ) : (
        <div className="flex items-center justify-center" style={{ height: 220, color: 'rgb(var(--color-muted))', fontSize: 13 }}>
          {err ?? 'Forecast updates every 5 minutes.'}
        </div>
      )}
    </div>
  );
}

function ForecastSvg({ points }: { points: ForecastPoint[] }) {
  const W = 800;
  const H = 240;
  const pad = { l: 48, r: 16, t: 24, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  // Compute y-scales separately for PV/Load (watts) and SoC (%).
  const wattsMax = Math.max(
    1,
    ...points.map((p) => Math.max(p.pvWh ?? 0, p.loadWh ?? 0)),
  );
  const wattsRound = niceCeil(wattsMax);
  const xStep = innerW / Math.max(1, points.length - 1);

  const xy = (i: number, watts: number) => ({
    x: pad.l + i * xStep,
    y: pad.t + innerH - (watts / wattsRound) * innerH,
  });
  const xyS = (i: number, soc: number) => ({
    x: pad.l + i * xStep,
    y: pad.t + innerH - (soc / 100) * innerH,
  });

  // Build path strings.
  const pvLine = pathFrom(points.map((p, i) => xy(i, p.pvWh ?? 0)));
  const pvArea = areaFrom(points.map((p, i) => xy(i, p.pvWh ?? 0)), pad.t + innerH);
  const loadLine = pathFrom(points.map((p, i) => xy(i, p.loadWh ?? 0)));
  const loadArea = areaFrom(points.map((p, i) => xy(i, p.loadWh ?? 0)), pad.t + innerH);
  const socLine = pathFrom(points.map((p, i) => xyS(i, p.socPct ?? 0)));

  // "Now" indicator: first point is hour 0 of forecast, which IS now.
  const nowX = pad.l;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="opus-pv-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--opus-solar)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--opus-solar)" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="opus-load-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--opus-load)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--opus-load)" stopOpacity="0.03" />
        </linearGradient>
      </defs>

      {/* Grid lines (4 horizontal). */}
      {[0.25, 0.5, 0.75, 1].map((t, i) => (
        <line
          key={i}
          x1={pad.l} y1={pad.t + innerH * (1 - t)} x2={pad.l + innerW} y2={pad.t + innerH * (1 - t)}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1"
        />
      ))}

      {/* PV area + line */}
      <path d={pvArea} fill="url(#opus-pv-grad)" />
      <path d={pvLine} fill="none" stroke="var(--opus-solar)" strokeWidth="1.5" strokeLinejoin="round" />

      {/* Load area + line */}
      <path d={loadArea} fill="url(#opus-load-grad)" />
      <path d={loadLine} fill="none" stroke="var(--opus-load)" strokeWidth="1.5" strokeLinejoin="round" />

      {/* SoC overlay line — uses right-side scale (0-100%) — drawn thin */}
      {points.some((p) => p.socPct != null) && (
        <path d={socLine} fill="none" stroke="var(--opus-life-1)" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.7" />
      )}

      {/* Now indicator */}
      <line x1={nowX} y1={pad.t} x2={nowX} y2={pad.t + innerH} stroke="var(--opus-cosmic)" strokeWidth="1" opacity="0.4" />
      <circle cx={nowX} cy={pad.t + innerH + 2} r="3" fill="var(--opus-cosmic)" />

      {/* Y-axis labels (watts) */}
      {[0, 0.5, 1].map((t, i) => (
        <text
          key={i}
          x={pad.l - 8}
          y={pad.t + innerH * (1 - t) + 4}
          textAnchor="end"
          fontSize="10"
          fill="rgb(var(--color-muted))"
          fontFamily="var(--font-mono)"
        >
          {fmtWattsCompact(Math.round(wattsRound * t))}
        </text>
      ))}

      {/* X-axis labels — every 6 hours */}
      {points.filter((_, i) => i % 6 === 0).map((p, idx) => {
        const i = idx * 6;
        const x = pad.l + i * xStep;
        return (
          <text
            key={i}
            x={x}
            y={pad.t + innerH + 22}
            textAnchor={i === 0 ? 'start' : 'middle'}
            fontSize="10"
            fill="rgb(var(--color-muted))"
            fontFamily="var(--font-mono)"
          >
            {fmtClock(new Date(p.ts))}
          </text>
        );
      })}
    </svg>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────── */

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / mag) * mag;
}

function fmtWattsCompact(w: number): string {
  if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(1)} kW`;
  return `${w} W`;
}

function pathFrom(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function areaFrom(pts: Array<{ x: number; y: number }>, baseY: number): string {
  if (pts.length === 0) return '';
  const line = pathFrom(pts);
  const last = pts[pts.length - 1];
  const first = pts[0];
  return `${line} L${last.x.toFixed(1)},${baseY.toFixed(1)} L${first.x.toFixed(1)},${baseY.toFixed(1)} Z`;
}

function sentenceFor(points: ForecastPoint[]): string {
  const totalPv = points.reduce((s, p) => s + (p.pvWh ?? 0), 0);
  const peakIdx = points.reduce((m, p, i) => ((p.pvWh ?? 0) > (points[m].pvWh ?? 0) ? i : m), 0);
  const peakHr = new Date(points[peakIdx].ts).getHours();
  return `${(totalPv / 1000).toFixed(1)} kWh of solar expected over the next 24 hours · peak around ${peakHr}:00.`;
}
