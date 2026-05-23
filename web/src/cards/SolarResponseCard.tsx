import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { DayForecast, SolarResponseModel } from '../types';

const fmtHour = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);
const INV_COLORS = ['#0e7490', '#15803d', '#d97706', '#7c3aed', '#db2777'];
const STR_COLORS = ['#0e7490', '#3aa6c2', '#15803d', '#4d9e63', '#d97706', '#ca8a04', '#7c3aed', '#9b87e0'];

interface Series {
  key: string;
  model: SolarResponseModel;
  color: string;
  width: number;
}

/**
 * "Array sunlight response" — the learned GHI→PV model. Toggle between
 * whole-inverter view (fleet + per-DPU) and per-string view (each DPU's HV and
 * LV MPPT arrays, which can face different directions).
 */
export function SolarResponseCard() {
  const [fc, setFc] = useState<DayForecast | null>(null);
  const [mode, setMode] = useState<'inverter' | 'string'>('inverter');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/forecast');
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

  const fleet = fc?.solarModel;
  const ready = fleet && fleet.pairCount > 0;
  const dpuModels = (fc?.deviceModels ?? []).filter(
    (d) => d.model.peakCoeff > 0 || d.hv.peakCoeff > 0 || d.lv.peakCoeff > 0,
  );

  // Build the series for the active mode.
  let series: Series[] = [];
  if (fleetReady(fleet)) {
    if (mode === 'inverter') {
      series = [
        { key: 'Fleet', model: fleet!, color: '#1b2027', width: 2.5 },
        ...dpuModels
          .filter((d) => d.model.peakCoeff > 0)
          .map((d, i) => ({ key: d.device, model: d.model, color: INV_COLORS[i % INV_COLORS.length], width: 1.5 })),
      ];
    } else {
      let ci = 0;
      for (const d of dpuModels) {
        if (d.hv.peakCoeff > 0) series.push({ key: `${d.device} HV`, model: d.hv, color: STR_COLORS[ci++ % STR_COLORS.length], width: 1.5 });
        if (d.lv.peakCoeff > 0) series.push({ key: `${d.device} LV`, model: d.lv, color: STR_COLORS[ci++ % STR_COLORS.length], width: 1.5 });
      }
    }
  }

  // Daylight hour range.
  const daylight: number[] = [];
  if (fleet) for (let h = 4; h <= 21; h++) if (fleet.hourly[h].coeff != null || fleet.hourly[h].observedMaxPvW > 0) daylight.push(h);

  const data = daylight.map((h) => {
    const row: Record<string, number | string | null> = { label: fmtHour(h) };
    for (const s of series) row[s.key] = s.model.hourly[h].coeff;
    return row;
  });

  let peakHour: number | null = null;
  let minSamples = Infinity;
  if (fleet) {
    let best = -1;
    for (const hr of fleet.hourly) {
      if (hr.coeff != null && hr.coeff > best) {
        best = hr.coeff;
        peakHour = hr.hour;
      }
      if (hr.coeff != null) minSamples = Math.min(minSamples, hr.samples);
    }
  }

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Array sunlight response (learned)</span>
        <div className="flex items-center gap-2 normal-case tracking-normal">
          <div className="flex bg-panel border border-line rounded-lg overflow-hidden text-[10px]">
            <button
              onClick={() => setMode('inverter')}
              className={`px-2 py-0.5 transition-colors ${mode === 'inverter' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              By inverter
            </button>
            <button
              onClick={() => setMode('string')}
              className={`px-2 py-0.5 transition-colors ${mode === 'string' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              By HV/LV string
            </button>
          </div>
          <span className="text-xs text-muted">{fc ? `${fc.historyDays.toFixed(1)} days` : '—'}</span>
        </div>
      </div>

      {!ready ? (
        <div className="text-sm text-muted">
          {fc ? 'Learning your arrays — needs a bit more paired sunlight + output history.' : 'Loading…'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <Tile label="Peak response" value={`${fleet!.peakCoeff.toFixed(1)} W`} sub="per W/m² of sun" accent="text-warn" />
            <Tile label="Strongest hour" value={peakHour != null ? fmtHour(peakHour) : '—'} sub="best sun-to-power angle" />
            <Tile label={mode === 'inverter' ? 'Inverters' : 'Strings'} value={String(series.length - (mode === 'inverter' ? 1 : 0))} sub={mode === 'inverter' ? 'DPUs with PV' : 'HV/LV arrays'} />
            <Tile
              label="Confidence"
              value={minSamples >= 14 ? 'Good' : minSamples >= 5 ? 'Fair' : 'Preliminary'}
              sub={`${Number.isFinite(minSamples) ? minSamples : 0}+ samples/hour`}
              accent={minSamples >= 14 ? 'text-ok' : minSamples >= 5 ? 'text-amber-700' : 'text-muted'}
            />
          </div>

          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#c4cad3" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: '#586474', fontSize: 10 }} />
                <YAxis
                  tick={{ fill: '#586474', fontSize: 10 }}
                  width={44}
                  label={{ value: 'W per W/m²', angle: -90, position: 'insideLeft', fill: '#586474', fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{ background: '#ffffff', border: '1px solid #9aa3b0', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#586474' }}
                  formatter={(v) => (typeof v === 'number' ? `${v.toFixed(1)} W per W/m²` : '—')}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: '#586474' }} />
                {series.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    stroke={s.color}
                    strokeWidth={s.width}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[11px] text-muted mt-2 leading-relaxed">
            Watts of PV per W/m² of sunlight, learned by pairing recorded output with Open-Meteo's solar-radiation
            history. The <em>shape</em> reveals orientation and shading.{' '}
            {mode === 'inverter'
              ? 'Switch to HV/LV string view to compare the two MPPT arrays on each inverter — if their peaks differ, they face different directions.'
              : "Each inverter's HV and LV inputs take separate arrays; differing peak hours mean they're aimed differently (or one is shaded part of the day)."}
            {minSamples < 5 && ' Still preliminary — the curves firm up over the next couple of weeks.'}
          </div>
        </>
      )}
    </div>
  );
}

function fleetReady(m: SolarResponseModel | undefined): m is SolarResponseModel {
  return !!m && m.pairCount > 0;
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}
