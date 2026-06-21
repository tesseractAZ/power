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

/**
 * Advanced Insights (v0.7.5) — surfaces the dozen new analytics functions
 * built in the v0.7.5 release. Each section is one fetch + one compact
 * read-only summary. The compute heavy lifting happens server-side; this
 * card just renders.
 */
export function AdvancedInsightsCard() {
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
      <div className="card">
        <div className="card-title">Advanced insights (v0.7.5)</div>
        <p className="text-sm text-muted leading-relaxed">
          The full advanced-analytics surface, one block per family.
          Quiet sections mean the underlying signal has nothing actionable to say right now.
        </p>
      </div>

      {incidents.length > 0 && (
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

      {nws.length > 0 && (
        <Section title="NWS active alerts" subtitle="Storm-prep — pre-charge to 100%">
          <div className="space-y-2">
            {nws.map((a) => (
              <div key={a.id} className="bg-panel2/50 border border-warn/50 rounded-md p-2 text-sm">
                <div className="font-semibold">{a.event}</div>
                <div className="text-xs text-muted mt-1">{a.headline ?? a.areaDesc}</div>
                <div className="text-[10px] text-muted mt-1">
                  Severity {a.severity} · {a.urgency} · expires {a.expires ? new Date(a.expires).toLocaleString() : '—'}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {sc && (
        <Section title="Self-consumption (7-day rolling)" subtitle="Where the kWh actually went">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            <Tile label="PV gen" value={`${sc.pvKwh.toFixed(1)} kWh`} />
            <Tile label="Load" value={`${sc.loadKwh.toFixed(1)} kWh`} />
            <Tile label="To battery" value={`${sc.pvToBatteryKwh.toFixed(1)} kWh`} />
            <Tile label="Bat discharge" value={`${sc.batteryDischargeKwh.toFixed(1)} kWh`} />
            <Tile label="Grid import" value={`${sc.gridImportKwh.toFixed(1)} kWh`} />
            <Tile label="Solar fraction" value={sc.solarFractionOfLoadPct != null ? `${sc.solarFractionOfLoadPct}%` : '—'} />
            <Tile label="Direct use" value={sc.directUseRatioPct != null ? `${sc.directUseRatioPct}%` : '—'} />
          </div>
        </Section>
      )}

      {ensemble && ensemble.sourcesCount > 1 && (
        <Section title="Weather ensemble" subtitle="Open-Meteo + NWS NDFD cloud-cover blend">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Tile label="Sources" value={`${ensemble.sourcesCount}`} sub={`enriched ${ensemble.enrichedHourCount}/${ensemble.hourCount} h`} />
            <Tile label="Avg disagreement" value={`${ensemble.avgDisagreementPct.toFixed(1)}%`} sub="|Open-Meteo − NWS|" />
            <Tile label="Status" value={ensemble.avgDisagreementPct > 15 ? 'wide bands' : 'tight bands'} sub="forecast confidence" />
            <Tile label="Coverage" value={`${Math.round((ensemble.enrichedHourCount / Math.max(1, ensemble.hourCount)) * 100)}%`} sub="ensemble overlap" />
          </div>
          <p className="text-[11px] text-muted mt-2 leading-relaxed">
            High disagreement (&gt; 15%) widens P10/P90 forecast bands — sources don't agree, so the
            point estimate has more uncertainty than usual. Phoenix monsoon clouds are where this
            matters most.
          </p>
        </Section>
      )}

      {conf && (
        <Section title="Confidence" subtitle="Trust each projection by its fit quality">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <Tile label="Degradation R²" value={conf.degradationMedianR2 != null ? conf.degradationMedianR2.toFixed(2) : '—'} />
            <Tile label="Solar model R²" value={conf.solarModelMedianR2 != null ? conf.solarModelMedianR2.toFixed(2) : '—'} />
            <Tile label="Thermal R²" value={conf.thermalMedianR2 != null ? conf.thermalMedianR2.toFixed(2) : '—'} />
            <Tile label="Forecast bias" value={conf.forecastSkillBiasFactor != null ? `×${conf.forecastSkillBiasFactor.toFixed(2)}` : '—'} />
            <Tile label="Forecast MAE" value={conf.forecastSkillMaePct != null ? `${conf.forecastSkillMaePct}%` : '—'} />
          </div>
        </Section>
      )}

      {thermal && thermal.packs.length > 0 && (
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

      {equip && (equip.mpptStrings.some((s) => s.driftPctPts != null) || equip.inverterStandby.some((s) => s.idleWatts != null)) && (
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

      {shade && shade.hours.length > 0 && (
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

      {soil && (soil.perDevice.length > 0 || soil.perHour.length > 0) && (
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

      {mismatch && mismatch.devices.length > 0 && (
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

      {ev && ev.patterns.length > 0 && (
        <Section title="EV-charging window prediction" subtitle="Recurring sessions detected in EVSE-bound circuit history">
          <div className="text-xs text-muted mb-2">
            {ev.sessionsObserved} session{ev.sessionsObserved === 1 ? '' : 's'} observed in last 30 d ·{' '}
            {ev.upcomingNext24h.length} predicted in next 24 h
          </div>
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

      {charge && charge.packs.some((p) => p.meanDriftMv != null) && (
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

      {ir && ir.devices.some((d) => d.recentMilliohms != null) && (
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

      {skill && skill.days.length > 0 && (
        <Section title="Forecast skill" subtitle="Hindcast: model vs actual PV, last 7 days">
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

      {ambient && ambient.packs.some((p) => p.predictedPeak24hC != null) && (
        <Section title="Ambient-coupled thermal forecast" subtitle="Predicted pack-temp peaks in next 24 h">
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

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-title flex items-baseline gap-2">
        <span>{title}</span>
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
