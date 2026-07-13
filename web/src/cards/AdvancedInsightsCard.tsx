import { useEffect, useState } from 'react';
import type {
  SelfConsumption,
  FleetThermalEvents,
  EquipmentHealth,
  ShadeReport,
  SoilingDecomposition,
  StringMismatchReport,
  EvWindowPrediction,
  ChargeCurveReport,
  InternalResistanceReport,
  ForecastSkillReport,
  AmbientThermalReport,
  ConfidenceSnapshot,
  NwsAlert,
  Incident,
} from '../types';
import { apiUrl } from '../api';
import { PredictiveBadge, type PredictiveKind } from '../components/PredictiveBadge';
import { HowItWorks } from '../components/sections';

/**
 * Advanced Insights (v0.7.5) — surfaces the dozen new analytics functions
 * built in the v0.7.5 release. Each section is one fetch + one compact
 * read-only summary. The compute heavy lifting happens server-side; this
 * card just renders.
 *
 * v0.85.0 — the Predictive tab was dissolved; this card is now embedded into
 * the Solar / Battery / Dashboard / Strategy pages. Each embed passes a
 * `sections` allow-list (stable keys, see SectionKey) so a page renders only
 * the analytics relevant to it. Passing nothing renders all sections (the
 * former full-page behaviour). The fetches are unchanged — a page that hides a
 * section still fetches it (cheap; keeps this file un-split).
 */

/** Stable identifiers for each analytics block — the `sections` filter keys. */
export type SectionKey =
  | 'incidents'
  | 'nws'
  | 'self-consumption'
  | 'weather-ensemble'
  | 'model-fit'
  | 'thermal-events'
  | 'equipment-health'
  | 'shade'
  | 'soiling-decomposition'
  | 'string-mismatch'
  | 'ev-window'
  | 'charge-curve'
  | 'internal-resistance'
  | 'forecast-skill'
  | 'ambient-thermal';
// v0.85.0 — render an NWS alert's TRUE event window. The old display showed
// `expires` (the message-refresh deadline, often ~30 min out) as if it were the
// event end, so a future storm read start-after-end. Use onset→ends; show
// "in effect until X" when it has already begun.
function nwsWindow(a: NwsAlert): string {
  const begins = a.onset ?? a.effective;
  const ends = a.ends ?? a.expires;
  const beginsMs = begins ? Date.parse(begins) : NaN;
  const endsMs = ends ? Date.parse(ends) : NaN;
  const endsStr = Number.isFinite(endsMs) ? new Date(endsMs).toLocaleString() : null;
  const inEffect = !Number.isFinite(beginsMs) || beginsMs <= Date.now();
  if (inEffect) return endsStr ? `in effect until ${endsStr}` : 'in effect now';
  const beginsStr = new Date(beginsMs).toLocaleString();
  return endsStr ? `${beginsStr} → ${endsStr}` : `begins ${beginsStr}`;
}

export function AdvancedInsightsCard({ sections }: { sections?: SectionKey[] } = {}) {
  // When `sections` is provided, render ONLY those keys (order-independent — the
  // page decides layout order by where it places this card). Undefined ⇒ all.
  const only = sections ? new Set<SectionKey>(sections) : null;
  const show = (key: SectionKey) => only == null || only.has(key);

  const [sc, setSc] = useState<SelfConsumption | null>(null);
  const [thermal, setThermal] = useState<FleetThermalEvents | null>(null);
  const [equip, setEquip] = useState<EquipmentHealth | null>(null);
  const [shade, setShade] = useState<ShadeReport | null>(null);
  const [soil, setSoil] = useState<SoilingDecomposition | null>(null);
  const [mismatch, setMismatch] = useState<StringMismatchReport | null>(null);
  const [ev, setEv] = useState<EvWindowPrediction | null>(null);
  const [charge, setCharge] = useState<ChargeCurveReport | null>(null);
  const [ir, setIr] = useState<InternalResistanceReport | null>(null);
  const [skill, setSkill] = useState<ForecastSkillReport | null>(null);
  const [ambient, setAmbient] = useState<AmbientThermalReport | null>(null);
  const [conf, setConf] = useState<ConfidenceSnapshot | null>(null);
  const [nws, setNws] = useState<NwsAlert[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [ensemble, setEnsemble] = useState<{ sourcesCount: number; avgDisagreementPct: number; enrichedHourCount: number; hourCount: number } | null>(null);

  useEffect(() => {
    const fetchAll = () => {
      const endpoints: Array<[string, (j: any) => void]> = [
        ['api/self-consumption', setSc],
        ['api/thermal-events', setThermal],
        ['api/equipment-health', setEquip],
        ['api/shade-report', setShade],
        ['api/soiling-decomposition', setSoil],
        ['api/string-mismatch', setMismatch],
        ['api/ev-window-prediction', setEv],
        ['api/charge-curve', setCharge],
        ['api/internal-resistance', setIr],
        ['api/forecast-skill', setSkill],
        ['api/ambient-thermal-forecast', setAmbient],
        ['api/confidence', setConf],
        ['api/nws-alerts', (j) => setNws(j.alerts ?? [])],
        ['api/incidents', (j) => setIncidents(j.incidents ?? [])],
        ['api/weather/ensemble', (j) => setEnsemble(j.error ? null : {
          sourcesCount: j.sourcesCount,
          avgDisagreementPct: j.avgDisagreementPct,
          enrichedHourCount: j.enrichedHourCount,
          hourCount: j.hourCount,
        })],
      ];
      for (const [url, setter] of endpoints) {
        fetch(apiUrl(url)).then((r) => r.json()).then(setter).catch(() => {});
      }
    };
    fetchAll();
    const t = setInterval(fetchAll, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-4">
      {/* The generic intro only appears in "render-all" mode (the legacy full
          page). On a destination page each section carries its own header, so
          this blurb would just be noise. */}
      {only == null && (
        <div className="card">
          <div className="card-title">Advanced insights</div>
          <p className="takeaway">
            One block per analytics family — a quiet section means that signal has nothing actionable right now.
          </p>
        </div>
      )}

      {show('incidents') && incidents.length > 0 && (
        <Section title="Active incidents" subtitle="Clustered alerts that share a Core / Pack">
          <div className="space-y-2">
            {incidents.slice(0, 8).map((i) => (
              <div key={i.id} className="bg-panel2/50 border border-line rounded-md p-2 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold">{i.title}</span>
                  <span className="text-[10px] uppercase text-muted">{i.scope}</span>
                  <span className="text-[10px] text-muted ml-auto">{i.alertCount} alerts</span>
                </div>
                <div className="text-xs text-muted mt-1 leading-relaxed">{i.detail}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('nws') && nws.length > 0 && (
        <Section title="NWS active alerts" subtitle="Storm-prep — pre-charge to 100%">
          <div className="space-y-2">
            {nws.map((a) => (
              <div key={a.id} className="bg-panel2/50 border border-warn/50 rounded-md p-2 text-sm">
                <div className="font-semibold">{a.event}</div>
                <div className="text-xs text-muted mt-1">{a.headline ?? a.areaDesc}</div>
                <div className="text-[10px] text-muted mt-1">
                  Severity {a.severity} · {a.urgency} · {nwsWindow(a)}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('self-consumption') && sc && (
        <Section title="Self-consumption (7-day rolling)" subtitle="Where the kWh actually went">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            <Tile label="PV gen" value={`${sc.pvKwh.toFixed(1)} kWh`} />
            <Tile label="Load" value={`${sc.loadKwh.toFixed(1)} kWh`} />
            <Tile label="To battery" value={`${sc.pvToBatteryKwh.toFixed(1)} kWh`} />
            <Tile label="Bat discharge" value={`${sc.batteryDischargeKwh.toFixed(1)} kWh`} />
            <Tile label="Grid import" value={sc.gridForKpiKwh != null ? `${sc.gridForKpiKwh.toFixed(1)} kWh` : '—'} sub={sc.gridForKpiKwh != null && sc.gridToHomeKwh > 0 ? 'whole-home @ SHP2 main' : undefined} />
            <Tile label="Solar fraction" value={sc.solarFractionOfLoadPct != null ? `${sc.solarFractionOfLoadPct}%` : '—'} />
            <Tile label="Direct use" value={sc.directUseRatioPct != null ? `${sc.directUseRatioPct}%` : '—'} />
          </div>
        </Section>
      )}

      {show('weather-ensemble') && ensemble && ensemble.sourcesCount > 1 && (
        <Section
          title="Weather ensemble"
          subtitle="Open-Meteo + NWS NDFD cloud-cover blend"
          predictive={{
            kind: 'model',
            accuracy: `±${ensemble.avgDisagreementPct.toFixed(1)}% spread`,
            title: 'Cross-source cloud-cover disagreement — how far the forecasts diverge (wider = less certain).',
          }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Tile label="Sources" value={`${ensemble.sourcesCount}`} sub={`enriched ${ensemble.enrichedHourCount}/${ensemble.hourCount} h`} />
            <Tile label="Avg disagreement" value={`${ensemble.avgDisagreementPct.toFixed(1)}%`} sub="|Open-Meteo − NWS|" />
            <Tile label="Status" value={ensemble.avgDisagreementPct > 15 ? 'wide bands' : 'tight bands'} sub="forecast confidence" />
            <Tile label="Coverage" value={`${Math.round((ensemble.enrichedHourCount / Math.max(1, ensemble.hourCount)) * 100)}%`} sub="ensemble overlap" />
          </div>
          <HowItWorks>
            High disagreement (&gt; 15%) widens P10/P90 forecast bands — sources don't agree, so the
            point estimate has more uncertainty than usual. Phoenix monsoon clouds are where this
            matters most.
          </HowItWorks>
        </Section>
      )}

      {show('model-fit') && conf && (
        // Model fit (R²) — the regression-quality side of "trust this projection".
        // Forecast MAE / bias are intentionally NOT shown here: they are the richer
        // "Forecast skill" section's single source of truth (model-vs-actual PV
        // hindcast, below) and were duplicated here byte-for-byte.
        <Section
          title="Model fit (R²)"
          subtitle="Trust each projection by its regression fit"
          predictive={{
            kind: 'model',
            accuracy: null,
            title: 'Regression fit quality (R²) for each learned model — closer to 1.00 = better fit.',
          }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Tile label="Degradation R²" value={conf.degradationMedianR2 != null ? conf.degradationMedianR2.toFixed(2) : '—'} />
            <Tile label="Forecast day R²" value={conf.forecastDayR2 != null ? conf.forecastDayR2.toFixed(2) : '—'} />
            <Tile label="Thermal R²" value={conf.thermalMedianR2 != null ? conf.thermalMedianR2.toFixed(2) : '—'} />
          </div>
        </Section>
      )}

      {show('thermal-events') && thermal && thermal.packs.length > 0 && (
        <Section title="Thermal events — cumulative" subtitle="Hard-life score, normalised per year">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {thermal.packs
              .slice()
              .sort((a, b) => b.hardLifeScore - a.hardLifeScore)
              .slice(0, 8)
              .map((p) => (
                <div key={`${p.sn}-${p.packNum}`} className="bg-panel2/50 border border-line rounded-md p-2 text-sm flex items-baseline gap-3">
                  <div className="font-semibold w-32 shrink-0">Core {p.coreNum} · Pk {p.packNum}</div>
                  <div className="text-xs text-muted flex-1">
                    {p.warmEvents}w / {p.hotEvents}h / {p.overheatEvents}o · {p.warmHours}h warm
                  </div>
                  <div className="text-xs font-mono tabular-nums text-accent">{p.hardLifeScore.toFixed(0)}</div>
                </div>
              ))}
          </div>
        </Section>
      )}

      {show('equipment-health') && equip && (equip.mpptStrings.some((s) => s.driftPctPts != null) || equip.inverterStandby.some((s) => s.idleWatts != null)) && (
        <Section title="Equipment health" subtitle="MPPT conversion drift + inverter idle losses">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">MPPT efficiency</div>
              {equip.mpptStrings.filter((s) => s.recentEffPct != null).map((s) => (
                <div key={`${s.sn}-${s.string}`} className="text-xs flex items-baseline gap-2 py-0.5">
                  <span className="w-24 shrink-0">Core {s.coreNum} {s.string}</span>
                  <span className="font-mono tabular-nums">{s.recentEffPct}% / base {s.baselineEffPct}%</span>
                  {/* v0.41.0 — warn-color at the SAME threshold the repair-issue alert fires
                       (repairIssues.ts MPPT drift gate = −3 pp), not −1, so the color can't
                       imply a problem the alert engine doesn't act on. */}
                  <span className={`text-[10px] ${(s.driftPctPts ?? 0) < -3 ? 'text-warn' : 'text-muted'}`}>
                    {s.driftPctPts != null ? (s.driftPctPts >= 0 ? '+' : '') + s.driftPctPts : ''}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Inverter standby</div>
              {equip.inverterStandby.filter((s) => s.idleWatts != null).map((s) => (
                <div key={s.sn} className="text-xs flex items-baseline gap-2 py-0.5">
                  <span className="w-24 shrink-0">Core {s.coreNum}</span>
                  <span className="font-mono tabular-nums">{s.idleWatts} W idle (base {s.baselineIdleWatts})</span>
                  <span className="text-[10px] text-muted">
                    {s.trendWattsPerWeek != null ? `${s.trendWattsPerWeek >= 0 ? '+' : ''}${s.trendWattsPerWeek} W/wk` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {show('shade') && shade && shade.hours.length > 0 && (
        <Section title="Shade events" subtitle="Recurring per-hour shortfall vs the clean-array reference">
          <div className="text-xs text-muted mb-2">
            Est. <span className="font-mono">{shade.estTotalKwhPerYear} kWh/yr</span> lost to physical obstruction
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {shade.hours.map((h) => (
              <Tile
                key={h.hour}
                label={`${h.hour}:00`}
                value={`-${h.shortfallPct}%`}
                sub={`${h.observedW}/${h.expectedW} W`}
              />
            ))}
          </div>
        </Section>
      )}

      {show('soiling-decomposition') && soil && (soil.perDevice.length > 0 || soil.perHour.length > 0) && (
        <Section title="Soiling decomposition" subtitle="Per-DPU and per-hour breakdown">
          {soil.perDevice.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Per DPU</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {soil.perDevice.map((d) => (
                  <Tile
                    key={d.sn}
                    label={`Core ${d.coreNum ?? d.device}`}
                    value={d.dropPct != null ? `${d.dropPct}%` : '—'}
                    sub={`${d.cleanDays} clear d`}
                  />
                ))}
              </div>
            </div>
          )}
          {soil.perHour.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Per hour</div>
              <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-12 gap-1">
                {soil.perHour.map((h) => (
                  <div key={h.hour} className="bg-panel2/50 border border-line rounded px-1 py-0.5 text-center">
                    <div className="text-[9px] text-muted">{h.hour}</div>
                    <div className={`text-[10px] font-mono ${h.dropPct >= 15 ? 'text-warn' : ''}`}>{h.dropPct}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {show('string-mismatch') && mismatch && mismatch.devices.length > 0 && (
        <Section title="String mismatch / per-DPU production" subtitle="Each DPU vs the fleet median">
          <div className="space-y-1">
            {mismatch.devices.map((d) => (
              <div
                key={d.sn}
                className={`flex items-baseline gap-2 text-xs py-0.5 ${d.outlier ? 'text-warn' : ''}`}
              >
                <span className="w-24 shrink-0">Core {d.coreNum ?? d.device}</span>
                <span className="font-mono tabular-nums w-32">{d.recentMedianW} W / fleet {d.fleetMedianW} W</span>
                <span className="font-mono">{d.ratio != null ? `×${d.ratio.toFixed(2)}` : '—'}</span>
                {d.outlier && <span className="badge badge-warn text-[10px]">underperformer</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('ev-window') && ev && ev.patterns.length > 0 && (
        <Section
          title="EV-charging window prediction"
          subtitle="Recurring sessions detected in EVSE-bound circuit history"
          predictive={{
            kind: 'prediction',
            accuracy: `${ev.sessionsObserved} sessions / 30 d`,
            title: 'Next-24h EV sessions predicted from recurring weekly patterns in EVSE-circuit history.',
          }}
        >
          <div className="text-xs text-muted mb-2">
            {ev.sessionsObserved} session{ev.sessionsObserved === 1 ? '' : 's'} observed in last 30 d ·{' '}
            {ev.upcomingNext24h.length} predicted in next 24 h
          </div>

          {/* Predicted schedule for the next 24 h — actual timestamped sessions
              (not the weekly patterns). Each entry's `watts` is a power figure,
              so divide by 1000 for kW; `ts` is epoch-ms shown in local time. */}
          <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Next 24 h</div>
          {ev.upcomingNext24h.length === 0 ? (
            <div className="text-xs text-muted mb-3">None predicted in next 24 h.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              {ev.upcomingNext24h.map((u, i) => (
                <div key={i} className="bg-panel2/50 border border-line rounded-md p-2 text-xs flex items-baseline gap-2">
                  <span className="font-semibold w-28 shrink-0">{fmtEvStart(u.ts)}</span>
                  <span className="text-muted">{u.durationHours.toFixed(1)} h</span>
                  <span className="font-mono tabular-nums text-muted ml-auto">{(u.watts / 1000).toFixed(1)} kW</span>
                </div>
              ))}
            </div>
          )}

          <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Recurring patterns</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ev.patterns.slice(0, 8).map((p, i) => (
              <div key={i} className="bg-panel2/50 border border-line rounded-md p-2 text-xs">
                <div className="font-semibold">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.dayOfWeek]} @ {p.startHour}:00
                </div>
                <div className="text-muted mt-1">
                  ~{p.typicalDurationHours} h · {p.typicalWatts} W · ≈ {p.energyKwh} kWh ·
                  observed {p.recurrences}×
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('charge-curve') && charge && charge.packs.some((p) => p.meanDriftMv != null) && (
        <Section title="Charge-curve fingerprint drift" subtitle="V at SoC checkpoints, recent vs baseline">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {charge.packs.filter((p) => p.meanDriftMv != null).slice(0, 10).map((p) => (
              <div key={`${p.sn}-${p.packNum}`} className="bg-panel2/50 border border-line rounded-md p-2 text-xs">
                <div className="font-semibold flex items-baseline gap-2">
                  <span>Core {p.coreNum} · Pack {p.packNum}</span>
                  <span className="text-[10px] text-muted ml-auto">mean drift ±{p.meanDriftMv} mV</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1">
                  {p.checkpoints.map((c) => (
                    <div key={c.soc} className="bg-panel rounded px-1 py-0.5 text-center">
                      <div className="text-[9px] text-muted">{c.soc}%</div>
                      <div className="font-mono text-[10px]">{c.driftMv != null ? `${c.driftMv >= 0 ? '+' : ''}${c.driftMv}` : '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('internal-resistance') && ir && ir.devices.some((d) => d.recentMilliohms != null) && (
        <Section title="Internal resistance trend" subtitle="dV/dI from snapshots — per Core (bus-level)">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ir.devices.filter((d) => d.recentMilliohms != null).map((d) => (
              <div key={d.sn} className="bg-panel2/50 border border-line rounded-md p-2 text-xs flex items-baseline gap-2">
                <span className="font-semibold w-20 shrink-0">Core {d.coreNum}</span>
                <span className="font-mono tabular-nums">{d.recentMilliohms} mΩ</span>
                <span className="text-[10px] text-muted">base {d.baselineMilliohms} mΩ</span>
                <span className={`text-[10px] ml-auto ${(d.trendMilliohmsPerMonth ?? 0) > 0.5 ? 'text-warn' : 'text-muted'}`}>
                  {d.trendMilliohmsPerMonth != null ? `${d.trendMilliohmsPerMonth >= 0 ? '+' : ''}${d.trendMilliohmsPerMonth} mΩ/mo` : ''}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('forecast-skill') && skill && skill.days.length > 0 && (
        <Section
          title="Forecast skill"
          subtitle="Hindcast: model vs actual PV, last 7 days"
          predictive={{
            kind: 'forecast',
            accuracy:
              skill.meanAbsErrorPct != null
                ? `±${skill.meanAbsErrorPct}%${skill.biasFactor != null ? ` · ×${skill.biasFactor.toFixed(2)} bias` : ''}`
                : null,
            title: 'Day-ahead PV forecast accuracy — mean absolute error vs actuals over the last 7 days, with the multiplicative bias.',
          }}
        >
          {skill.meanAbsErrorPct != null && (
            <div className="text-xs text-muted mb-2">
              MAE <span className="font-mono">{skill.meanAbsErrorKwh} kWh</span> ({skill.meanAbsErrorPct}%) · bias factor{' '}
              <span className="font-mono">×{skill.biasFactor?.toFixed(2) ?? '—'}</span>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            {skill.days.map((d) => (
              <Tile
                key={d.date}
                label={d.date.slice(5)}
                value={`${d.actualKwh.toFixed(1)} kWh`}
                sub={`pred ${d.predictedKwh.toFixed(1)}`}
              />
            ))}
          </div>
        </Section>
      )}

      {show('ambient-thermal') && ambient && ambient.packs.some((p) => p.predictedPeak24hC != null) && (
        <Section
          title="Ambient-coupled thermal forecast"
          subtitle="Predicted pack-temp peaks in next 24 h"
          predictive={{
            kind: 'forecast',
            accuracy: (() => {
              const r2s = ambient.packs
                .filter((p) => p.predictedPeak24hC != null && p.r2 != null)
                .map((p) => p.r2 as number)
                .sort((a, b) => a - b);
              if (r2s.length === 0) return null;
              const mid = Math.floor(r2s.length / 2);
              const med = r2s.length % 2 ? r2s[mid] : (r2s[mid - 1] + r2s[mid]) / 2;
              return `R² ${med.toFixed(2)}`;
            })(),
            title: 'Pack-temperature peak forecast fitted from ambient temperature + load; R² is the fit quality.',
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ambient.packs.filter((p) => p.predictedPeak24hC != null).slice(0, 10).map((p) => {
              const tF = p.predictedPeak24hC != null ? Math.round(p.predictedPeak24hC * 1.8 + 32) : null;
              return (
                <div key={`${p.sn}-${p.packNum}`} className="bg-panel2/50 border border-line rounded-md p-2 text-xs flex items-baseline gap-2">
                  <span className="font-semibold w-32 shrink-0">Core {p.coreNum} · Pk {p.packNum}</span>
                  <span className="font-mono tabular-nums">{tF}°F</span>
                  <span className="text-[10px] text-muted">
                    {p.predictedPeakAtMs ? new Date(p.predictedPeakAtMs).toLocaleString([], { weekday: 'short', hour: 'numeric' }) : ''}
                  </span>
                  <span className="text-[10px] text-muted ml-auto">R² {p.r2?.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

/** A predicted EV-session start (epoch-ms) → local weekday + time, e.g. "Tue 2:00 PM". */
function fmtEvStart(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Section({
  title,
  subtitle,
  predictive,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When set, a PredictiveBadge is rendered next to the title marking this
   *  section as model-driven, with an accuracy chip. */
  predictive?: { kind?: PredictiveKind; accuracy?: string | null; title?: string };
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-title flex items-center gap-2 flex-wrap">
        <span>{title}</span>
        {predictive && (
          <PredictiveBadge kind={predictive.kind} accuracy={predictive.accuracy} title={predictive.title} />
        )}
        {subtitle && (
          <span className="text-[11px] text-muted normal-case tracking-normal ml-auto hidden sm:inline">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-md px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted leading-none">{label}</div>
      <div className="text-sm font-mono font-semibold tabular-nums text-ink mt-1 leading-none">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}
