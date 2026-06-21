import { useEffect, useState, type ReactNode } from 'react';
import type { DayForecast, ForecastHour, HourResponse, SolarResponseModel, DeviceSolarModel } from '../types';
import { fmtW } from '../format';
import { apiUrl } from '../api';

/**
 * Forecast detail for the Predictive Insights page — shows the full machinery
 * behind the day-ahead projection: the Open-Meteo cloud/GHI prediction, the
 * learned GHI→PV response coefficients (the "calculation adjustments"), and the
 * panel-position inference those coefficients reveal.
 */

const kwh = (wh: number) => `${(wh / 1000).toFixed(1)} kWh`;

function fmtHour(h: number): string {
  const hr = ((h % 24) + 24) % 24;
  if (hr === 0) return '12 AM';
  if (hr === 12) return '12 PM';
  return hr < 12 ? `${hr} AM` : `${hr - 12} PM`;
}
function tsHour(ts: number): string {
  return fmtHour(new Date(ts).getHours());
}

/** Hour-of-day with the strongest WELL-FIT learned response coefficient. */
function peakResponse(m: SolarResponseModel): HourResponse | null {
  let best: HourResponse | null = null;
  for (const h of m.hourly) {
    // v0.41.0 — gate on fit quality + sample count (mirrors the backend peakCoeff gate).
    // Low-GHI dawn hours yield numerically unstable PV/GHI slopes that otherwise falsely
    // win "peak" and mislabel a south-facing array as east-facing.
    if (h.coeff == null || h.r2 < 0.2 || h.samples < 3) continue;
    if (!best || h.coeff > (best.coeff ?? -1)) best = h;
  }
  return best;
}

/** Production-weighted centroid hour — the robust orientation signal: Σ(hour·peakPV) / Σ(peakPV). */
function productionCentroidHour(m: SolarResponseModel): number | null {
  let num = 0, den = 0;
  for (const h of m.hourly) {
    if (h.observedMaxPvW > 0) {
      num += h.hour * h.observedMaxPvW;
      den += h.observedMaxPvW;
    }
  }
  return den > 0 ? num / den : null;
}

/** Plain-language array orientation implied by the peak-response hour. */
function orientation(hour: number): string {
  if (hour <= 8) return 'strongly morning-biased — east-facing, or shaded later in the day';
  if (hour <= 10) return 'morning-biased — array faces east of south';
  if (hour <= 13) return 'near solar noon — array faces close to true south';
  if (hour <= 15) return 'afternoon-biased — array faces west of south';
  return 'strongly afternoon-biased — west-facing, or shaded in the morning';
}

export function ForecastDetail() {
  const [fc, setFc] = useState<DayForecast | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl('api/forecast'));
        if (!live) return;
        if (r.ok) {
          setFc(await r.json());
          setErr(false);
        } else setErr(true);
      } catch {
        if (live) setErr(true);
      }
    };
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  if (!fc) {
    return (
      <div className="card text-sm text-muted">
        {err ? 'Forecast unavailable — the server has not produced a day-ahead forecast.' : 'Computing day-ahead forecast…'}
      </div>
    );
  }
  return (
    <>
      <ForecastCard fc={fc} />
      <ModelCard fc={fc} />
    </>
  );
}

/* ── Card 1 — cloud prediction & hourly projection ── */

function ForecastCard({ fc }: { fc: DayForecast }) {
  const loadWh = fc.hours.reduce((s, h) => s + h.forecastLoadW, 0);
  const runtimeNote =
    fc.minProjectedSoc == null
      ? 'Battery SoC projection unavailable — not enough history yet.'
      : fc.minProjectedSoc < fc.reserveSoc
        ? `Consumption outpaces solar — the backup pool is projected to fall to ${fc.minProjectedSoc}%, below the ${fc.reserveSoc}% reserve floor${fc.minProjectedSocTs != null ? `, around ${tsHour(fc.minProjectedSocTs)}` : ''}.`
        : `The backup pool stays above the ${fc.reserveSoc}% reserve floor across the 24-hour window — projected low of ${fc.minProjectedSoc}%${fc.minProjectedSocTs != null ? ` around ${tsHour(fc.minProjectedSocTs)}` : ''}.`;
  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Day-ahead solar &amp; consumption forecast</span>
        <span className={`badge ${fc.hasWeather ? 'badge-ok' : 'badge-muted'}`}>
          {fc.hasWeather ? 'cloud-aware' : 'typical-day fallback'}
        </span>
      </div>
      <p className="text-sm text-muted leading-relaxed mb-3">
        Open-Meteo supplies an hourly cloud-cover and solar-radiation (GHI) forecast for your
        location. Each hour's GHI is run through the equipment-tuned response model (below) to
        project PV; that is integrated against the typical-day load curve into a battery SoC track
        — the runtime forecast.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
        <Tile label="Solar next 24 h" value={kwh(fc.forecastPvWhNext24)} accent="text-accent" />
        <Tile label="Forecast load 24 h" value={kwh(loadWh)} accent="text-warn" />
        <Tile label="Typical solar / day" value={kwh(fc.typicalPvWhPerDay)} />
        <Tile
          label="Projected low SoC"
          value={fc.minProjectedSoc != null ? `${fc.minProjectedSoc}%` : '—'}
          sub={fc.minProjectedSocTs != null ? `at ${tsHour(fc.minProjectedSocTs)}` : undefined}
        />
        <Tile label="History depth" value={`${fc.historyDays} days`} sub={`reserve floor ${fc.reserveSoc}%`} />
      </div>
      <div className="border border-line rounded-md bg-panel2/50 px-3 py-2 text-sm mb-4">
        <span className="text-[10px] uppercase tracking-widest text-muted mr-2">Runtime</span>
        {runtimeNote}
      </div>
      <div className="text-xs uppercase tracking-widest text-muted mb-1.5">
        Cloud prediction & hourly projection — next 24 h
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-muted text-left">
              <Th>Hour</Th>
              <Th>Cloud cover</Th>
              <Th>GHI</Th>
              <Th>Forecast PV</Th>
              <Th>Forecast load</Th>
              <Th>Proj. SoC</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody>
            {fc.hours.map((h) => (
              <HourRow key={h.ts} h={h} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HourRow({ h }: { h: ForecastHour }) {
  return (
    <tr className="border-t border-line/50">
      <td className="py-1 pr-4 text-ink font-medium">{tsHour(h.ts)}</td>
      <td className="py-1 pr-4">{h.cloudCoverPct != null ? `${Math.round(h.cloudCoverPct)}%` : '—'}</td>
      <td className="py-1 pr-4">{h.ghiWm2 != null ? `${h.ghiWm2} W/m²` : '—'}</td>
      <td className="py-1 pr-4 font-semibold text-ink">{fmtW(h.forecastPvW)}</td>
      <td className="py-1 pr-4">{fmtW(h.forecastLoadW)}</td>
      <td className="py-1 pr-4">{h.projectedSocPct != null ? `${h.projectedSocPct}%` : '—'}</td>
      <td className="py-1">
        <span className={`badge text-[9px] ${h.modelled ? 'badge-ok' : 'badge-muted'}`}>
          {h.modelled ? 'model' : 'typical'}
        </span>
      </td>
    </tr>
  );
}

/* ── Card 2 — learned response model & panel inference ── */

function ModelCard({ fc }: { fc: DayForecast }) {
  const m = fc.solarModel;
  const daylight = m.hourly.filter((h) => h.coeff != null || h.observedMaxPvW > 0);
  const fleetPeak = peakResponse(m);
  const centroidHour = productionCentroidHour(m);

  return (
    <div className="card">
      <div className="card-title">Learned response model · equipment-tuned</div>
      <p className="text-sm text-muted leading-relaxed mb-3">
        Rather than a generic cloud-derate, the model pairs every hour of recorded PV with
        Open-Meteo's <em>historical</em> solar radiation for that same hour, groups by hour-of-day,
        and fits a response coefficient — watts of PV per W/m² of GHI. That single number bakes in
        array size, orientation, inverter clipping and time-of-day shading. Built from{' '}
        <span className="text-ink font-medium">{m.pairCount}</span> hourly (GHI, PV) pairs over{' '}
        <span className="text-ink font-medium">{m.historyDays.toFixed(1)} days</span>; peak
        coefficient <span className="text-ink font-medium">{m.peakCoeff.toFixed(1)} W per W/m²</span>.
      </p>

      <SoilingNote fc={fc} />

      <div className="text-xs uppercase tracking-widest text-muted mb-1.5">
        Response coefficient by hour-of-day
      </div>
      {daylight.length === 0 ? (
        <div className="text-sm text-muted mb-4">
          Not enough recorded PV paired with sunlight data yet — the model falls back to a
          typical-day curve with a cloud derate.
        </div>
      ) : (
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-muted text-left">
                <Th>Hour</Th>
                <Th>Coefficient</Th>
                <Th>Fit R²</Th>
                <Th>Samples</Th>
                <Th>Observed peak PV</Th>
              </tr>
            </thead>
            <tbody>
              {daylight.map((h) => (
                <CoeffRow key={h.hour} h={h} peak={m.peakCoeff} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs uppercase tracking-widest text-muted mb-1.5">Panel-position inference</div>
      <div className="space-y-1.5 text-sm">
        {centroidHour != null ? (
          <Inference
            label="Fleet"
            detail={`Peak output around ${fmtHour(Math.round(centroidHour))} — ${orientation(Math.round(centroidHour))}${
              fleetPeak ? ` (strongest learned response ${fleetPeak.coeff!.toFixed(1)} W per W/m² at ${fmtHour(fleetPeak.hour)})` : ''
            }.`}
          />
        ) : (
          <div className="text-muted">Not enough recorded PV yet to infer array orientation.</div>
        )}
        {fc.deviceModels.map((dm) => (
          <DeviceInference key={dm.sn} dm={dm} />
        ))}
      </div>
    </div>
  );
}

function CoeffRow({ h, peak }: { h: HourResponse; peak: number }) {
  const isPeak = h.coeff != null && peak > 0 && h.coeff >= peak - 0.001;
  return (
    <tr className="border-t border-line/50">
      <td className="py-1 pr-4 text-ink font-medium">{fmtHour(h.hour)}</td>
      <td className="py-1 pr-4 font-semibold text-ink">
        {h.coeff != null ? `${h.coeff.toFixed(1)} W per W/m²` : '—'}
        {isPeak && <span className="badge badge-ok text-[9px] ml-1.5">peak</span>}
      </td>
      <td className="py-1 pr-4">{h.coeff != null ? h.r2.toFixed(2) : '—'}</td>
      <td className="py-1 pr-4">{h.samples}</td>
      <td className="py-1">{h.observedMaxPvW > 0 ? fmtW(h.observedMaxPvW) : '—'}</td>
    </tr>
  );
}

function DeviceInference({ dm }: { dm: DeviceSolarModel }) {
  const whole = peakResponse(dm.model);
  const hv = peakResponse(dm.hv);
  const lv = peakResponse(dm.lv);
  if (!whole && !hv && !lv) {
    return (
      <Inference
        label={dm.device}
        detail="No recorded PV — offline gaps or an unwired spare; orientation can't be inferred yet."
        muted
      />
    );
  }
  const pairs = dm.model.pairCount;
  const lowConf = pairs < 15;
  const parts: string[] = [];
  if (whole) parts.push(`array peaks ${fmtHour(whole.hour)}`);
  if (hv) parts.push(`HV string ${fmtHour(hv.hour)}`);
  if (lv) parts.push(`LV string ${fmtHour(lv.hour)}`);
  let note = '';
  if (hv && lv) {
    if (hv.hour < lv.hour) note = ' — HV string sees the sun earlier (more easterly)';
    else if (lv.hour < hv.hour) note = ' — LV string sees the sun earlier (more easterly)';
    else note = ' — both strings track together';
  }
  const conf = lowConf ? ` · low confidence — only ${pairs} paired hours of data so far` : '';
  return <Inference label={dm.device} detail={`${parts.join(' · ')}${note}${conf}.`} muted={lowConf} />;
}

function Inference({ label, detail, muted }: { label: string; detail: string; muted?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="text-accent font-semibold shrink-0 w-20">{label}</span>
      <span className={muted ? 'text-muted' : 'text-ink'}>{detail}</span>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="font-medium py-1 pr-4">{children}</th>;
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-md p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

/** Panel-soiling status derived from the clear-sky response coefficient. */
function SoilingNote({ fc }: { fc: DayForecast }) {
  const s = fc.soiling;
  const bad = s != null && s.dropPct >= 12;
  return (
    <div className={`border rounded-md px-3 py-2 text-sm mb-4 ${bad ? 'border-warn/55 bg-warn/10' : 'border-line bg-panel2/50'}`}>
      <span className="text-[10px] uppercase tracking-widest text-muted mr-2">Soiling</span>
      {s == null
        ? 'Needs at least 6 clear-sky days of recorded history to assess panel soiling.'
        : s.dropPct >= 12
          ? `Clear-sky output is ~${s.dropPct}% below the cleanest day on record (${s.cleanDays} clear days analysed) — consistent with dust on the panels. A wash should recover most of it.`
          : s.dropPct >= 6
            ? `Clear-sky output is ~${s.dropPct}% below the clean-day baseline — minor soiling, worth watching (${s.cleanDays} clear days analysed).`
            : `Panels are tracking their clean-day baseline — no soiling detected (${s.cleanDays} clear days analysed).`}
    </div>
  );
}
