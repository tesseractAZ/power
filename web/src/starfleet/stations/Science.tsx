/**
 * SCIENCE — long-range sensors, anomaly detection, forecasts.
 *
 * Spock's domain. We map our analytics outputs to "sensor sweeps":
 *   - LONG-RANGE SENSORS = day-ahead solar forecast
 *   - SUBSPACE ANOMALY ANALYSIS = pack risk scoring
 *   - ATMOSPHERIC COMPOSITION = weather model / cloud cover
 *   - PROBE TELEMETRY = soiling decomposition, MPPT efficiency drift
 */

import { useEffect, useState } from 'react';
import { BridgePanel } from '../components/BridgePanel';
import { apiUrl } from '../../api';
import type { FleetSnapshot } from '../../types';

interface ForecastData {
  forecastPvWhNext24: number;
  typicalPvWhPerDay: number;
  historyDays: number;
  hasWeather: boolean;
  minProjectedSoc: number | null;
  minProjectedSocTs: number | null;
  soiling?: { dropPct: number | null; cleanDays: number };
}

/**
 * Shape returned by /api/pack-risk/v2 (the trained-ML endpoint).
 * The tier + composite score live nested under `heuristic` and on the
 * pack root respectively — Science previously declared a flat shape
 * (`p.tier`, `p.score0to100`) which crashed `.toFixed()` when the real
 * data arrived. v0.9.24 — match the actual server response.
 */
interface PackRiskV2Pack {
  device: string;
  packNum: number;
  sn?: string;
  coreNum?: number;
  composite0to100: number;
  heuristic?: { tier: string; score0to100: number };
  trained?: { score0to100: number; modelSource?: string };
  novelty?: { score0to100: number };
}
interface PackRiskData {
  packs?: PackRiskV2Pack[];
}

export function Science({ snapshot }: { snapshot: FleetSnapshot | null }) {
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [risk, setRisk] = useState<PackRiskData | null>(null);

  useEffect(() => {
    let live = true;
    const fetchAll = async () => {
      try {
        const [fr, rr] = await Promise.all([
          fetch(apiUrl('api/forecast')),
          fetch(apiUrl('api/pack-risk/v2')).catch(() => null),
        ]);
        if (fr?.ok) {
          const j = await fr.json();
          if (live) setForecast(j);
        }
        if (rr?.ok) {
          const j = await rr.json();
          if (live) setRisk(j);
        }
      } catch {}
    };
    fetchAll();
    const t = window.setInterval(fetchAll, 60_000);
    return () => { live = false; window.clearInterval(t); };
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* ─── Long-range sensors / forecast ─────────────────────────── */}
      <BridgePanel title="LONG-RANGE SENSORS · 24 HR FORECAST" dept="sci" working={!forecast}>
        {forecast ? (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="sf-label">PROJECTED · SOLAR YIELD</div>
              <div className="sf-readout sf-readout-lg" style={{ color: '#e89c40' }}>
                {(forecast.forecastPvWhNext24 / 1000).toFixed(1)}<span className="sf-readout-unit">kWh</span>
              </div>
            </div>
            <div>
              <div className="sf-label">BASELINE · TYPICAL DAY</div>
              <div className="sf-readout sf-readout-lg" style={{ color: '#f4e8c8' }}>
                {(forecast.typicalPvWhPerDay / 1000).toFixed(1)}<span className="sf-readout-unit">kWh</span>
              </div>
            </div>
            <div>
              <div className="sf-label">SENSOR MODE</div>
              <div className="sf-readout sf-readout-md" style={{ color: '#4a86c6' }}>
                {forecast.hasWeather ? 'ATMOSPHERIC-AWARE' : 'TYPICAL-DAY'}
              </div>
            </div>
            <div>
              <div className="sf-label">HISTORICAL TRACE</div>
              <div className="sf-readout sf-readout-md">{forecast.historyDays.toFixed(1)}<span className="sf-readout-unit">DAYS</span></div>
            </div>
            <div className="col-span-2 pt-3 border-t border-[#5a4520]">
              <div className="sf-label">PROJECTED · CHARGE NADIR</div>
              <div className="sf-readout sf-readout-lg" style={{
                color: forecast.minProjectedSoc != null && forecast.minProjectedSoc < 30 ? '#c4242a' : '#e89c40',
              }}>
                {forecast.minProjectedSoc != null ? forecast.minProjectedSoc.toFixed(0) : '—'}<span className="sf-readout-unit">%</span>
              </div>
              {forecast.minProjectedSocTs && (
                <div className="sf-label mt-1">ETA · {new Date(forecast.minProjectedSocTs).toLocaleString([], { weekday: 'short', hour: 'numeric' })}</div>
              )}
            </div>
            {forecast.soiling && forecast.soiling.dropPct != null && forecast.soiling.dropPct > 5 && (
              <div className="col-span-2 pt-3 border-t border-[#5a4520]">
                <div className="sf-label" style={{ color: '#c4242a' }}>SOILING DETECTED · PARTICULATE OBSCURING ARRAYS</div>
                <div className="sf-readout sf-readout-md mt-1" style={{ color: '#c4242a' }}>
                  −{forecast.soiling.dropPct.toFixed(1)}<span className="sf-readout-unit">% EFFICIENCY DROP</span>
                </div>
                <div className="sf-label mt-1">RECOMMEND PHYSICAL INSPECTION · {forecast.soiling.cleanDays} CLEAN DAYS OBSERVED</div>
              </div>
            )}
          </div>
        ) : (
          <div className="sf-working">AWAITING SENSOR DATA…</div>
        )}
      </BridgePanel>

      {/* ─── Pack risk / anomaly analysis ──────────────────────────── */}
      <BridgePanel title="SUBSPACE ANOMALY · M/AM REACTOR ANALYSIS" dept="sci" working={!risk}>
        {risk?.packs && risk.packs.length > 0 ? (
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_80px_80px_70px] gap-2 sf-label px-1">
              <span>REACTOR · PACK</span><span className="text-right">TIER</span><span className="text-right">SCORE</span><span className="text-right">STATUS</span>
            </div>
            {risk.packs.slice(0, 10).map((p, i) => {
              // v0.9.24 — tier lives on `heuristic`, score lives on the pack
              // root as `composite0to100`. Defensive defaults so a future
              // schema shift can't take down the whole bridge again.
              const tier = p.heuristic?.tier ?? 'unknown';
              const score = typeof p.composite0to100 === 'number' ? p.composite0to100
                : typeof p.heuristic?.score0to100 === 'number' ? p.heuristic.score0to100
                : null;
              const tierColor =
                tier === 'critical' ? '#c4242a' :
                tier === 'elevated' ? '#e89c40' :
                tier === 'moderate' ? '#e2c44c' :
                tier === 'low' ? '#6fb854' : '#8c7a5c';
              const tierName =
                tier === 'critical' ? 'RED' :
                tier === 'elevated' ? 'AMBER' :
                tier === 'moderate' ? 'YELLOW' :
                tier === 'low' ? 'GREEN' : '— —';
              return (
                <div key={i} className="grid grid-cols-[1fr_80px_80px_70px] gap-2 items-center px-1 py-1" style={{ borderBottom: '1px dashed rgba(192,158,96,0.15)' }}>
                  <span style={{ color: '#f4e8c8', fontFamily: 'Antonio, sans-serif' }}>{p.device} · PACK {p.packNum}</span>
                  <span className="text-right sf-readout" style={{ color: tierColor, fontSize: 12 }}>{tierName}</span>
                  <span className="text-right sf-readout" style={{ fontSize: 12 }}>{score != null ? score.toFixed(0) : '— —'}<span className="sf-readout-unit">%</span></span>
                  <span className="text-right">
                    <span className="sf-jellybean" style={{ ['--jb-color' as any]: tierColor }} />
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="sf-label">REACTOR POOL · NOMINAL · NO ANOMALIES DETECTED</div>
        )}
      </BridgePanel>
    </div>
  );
}
