import { lazy, Suspense, useEffect, useState } from 'react';
import { useSnapshot } from './useSnapshot';
import { EnergyFlow } from './cards/EnergyFlow';
import { TodaySummary } from './cards/TodaySummary';
import { ForecastCard } from './cards/ForecastCard';
import { RunwayCard } from './cards/RunwayCard';
import { CurtailmentCard } from './cards/CurtailmentCard';
import { DpuCard, type DpuViaShp2 } from './cards/DpuCard';
import type { Shp2Projection } from './types';
import { Shp2Card } from './cards/Shp2Card';
import { SmallDeviceCard } from './cards/SmallDeviceCard';
import { alertCounts } from './alerts';
import { sortDevices } from './sort';
import { fmtRel } from './format';
import { SERIES_PALETTE } from './theme';
import { ThemeToggle } from './components/ThemeToggle';
import { installGlossaryTooltips } from './glossary';

// v0.8.1 — route-level code splitting. Each non-default page becomes its own
// chunk; recharts (~300 kB minified) is vendor-chunked separately via the
// Vite config. The Dashboard remains the eagerly-loaded landing page so the
// first paint is fast. TrendChart is also lazy since recharts only needs to
// land when the user toggles "show history".
const ThermalPanel = lazy(() => import('./pages/ThermalPanel').then((m) => ({ default: m.ThermalPanel })));
const SolarPanel = lazy(() => import('./pages/SolarPanel').then((m) => ({ default: m.SolarPanel })));
const EvsePanel = lazy(() => import('./pages/EvsePanel').then((m) => ({ default: m.EvsePanel })));
const StrategyPanel = lazy(() => import('./pages/StrategyPanel').then((m) => ({ default: m.StrategyPanel })));
const AlertsPanel = lazy(() => import('./pages/AlertsPanel').then((m) => ({ default: m.AlertsPanel })));
// v0.11.0 — Alert Settings: per-priority annunciation on/off + chime + preview.
const AlertSettingsPanel = lazy(() =>
  import('./pages/AlertSettingsPanel').then((m) => ({ default: m.AlertSettingsPanel })),
);
const PredictiveInsights = lazy(() => import('./pages/PredictiveInsights').then((m) => ({ default: m.PredictiveInsights })));
const TrendChart = lazy(() => import('./charts/TrendChart').then((m) => ({ default: m.TrendChart })));

const PageFallback = () => (
  <div className="card flex items-center gap-2 text-sm text-muted">
    <span className="h-2 w-2 rounded-full bg-accent inline-block animate-pulse" />
    Loading view…
  </div>
);

/**
 * v0.15.6 — the Default / Babylon 5 dashboard is the only UI now; the
 * alternate Starfleet and Opus themes were removed. App is a thin wrapper
 * around NormalApp, which owns all the dashboard's hooks and state. (The CSS
 * palette still swaps between Default and B5 via the data-theme attribute.)
 */
export default function App() {
  return <NormalApp />;
}

function NormalApp() {
  const { snapshot, conn } = useSnapshot();
  const devices = snapshot ? Object.values(snapshot.devices) : [];
  const [showHistory, setShowHistory] = useState(false);
  const [tab, setTab] = useState<
    'dashboard' | 'solar' | 'thermal' | 'evse' | 'strategy' | 'alerts' | 'alert-settings' | 'predictive'
  >('dashboard');
  const sorted = sortDevices(devices);

  // Attach glossary hover tooltips to every matching label across the app.
  useEffect(() => installGlossaryTooltips(), []);

  const alerts = snapshot?.alerts ?? [];
  const thresholdAlerts = alerts.filter((a) => a.source !== 'learned');
  const learnedAlerts = alerts.filter((a) => a.source === 'learned');
  const thresholdCounts = alertCounts(thresholdAlerts);
  const learnedCounts = alertCounts(learnedAlerts);
  const alertBadgeCount = thresholdCounts.critical + thresholdCounts.warning;
  const predictiveBadgeCount = learnedCounts.critical + learnedCounts.warning;

  const shp2 = sorted.find((d) => d.projection?.kind === 'shp2');
  const dpus = sorted.filter((d) => d.productName.toLowerCase().includes('delta pro ultra'));
  // "Other devices" — everything that isn't the SHP2 or a DPU. Offline ones sort
  // to the end (stable sort preserves the compareDevices order within each group).
  const others = sorted
    .filter((d) => d !== shp2 && !dpus.includes(d))
    .sort((a, b) => Number(b.online) - Number(a.online));

  // Build a DPU-SN → SHP2-derived data map so we can fall back when a DPU's own
  // cloud connection is offline. The SHP2 reports its bound DPUs' overall state
  // (battery %, contributed watts, AC-open, temp, errors) via its wired link.
  const dpuViaShp2 = new Map<string, DpuViaShp2>();
  if (shp2?.projection?.kind === 'shp2') {
    const sp = shp2.projection as Shp2Projection;
    sp.sources.forEach((source, i) => {
      if (!source.sn) return;
      const w = sp.sourceWatts[i];
      // chWatt is reported as negative when the source is contributing power to SHP2.
      // Flip sign so positive = discharging (consistent with the rest of the UI).
      const liveWatts = typeof w === 'number' ? -w : null;
      dpuViaShp2.set(source.sn, { source, liveWatts, shp2Sn: shp2.sn });
    });
  }

  return (
    <div className="min-h-full p-4 md:p-6 max-w-[1800px] mx-auto">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">EcoFlow Home Energy</h1>
          <div className="text-xs text-muted">
            {snapshot ? `${devices.length} devices · ${devices.filter((d) => d.online).length} online` : 'Loading…'} ·
            updated {fmtRel(snapshot?.generatedAt ?? null)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* v0.15.9 — the tab pill WRAPS (was overflow-x-auto, which silently
              scroll-hid Strategy/Alerts/Settings/Predictive on narrow widths / the
              HA ingress sidebar). Wrapping keeps every tab reachable. */}
          <div className="flex flex-wrap bg-panel border border-line rounded-lg max-w-full">
            <button
              onClick={() => setTab('dashboard')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'dashboard' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setTab('solar')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'solar' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Solar
            </button>
            <button
              onClick={() => setTab('thermal')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'thermal' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Battery
            </button>
            <button
              onClick={() => setTab('evse')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'evse' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Charger
            </button>
            <button
              onClick={() => setTab('strategy')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'strategy' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Strategy
            </button>
            <button
              onClick={() => setTab('alerts')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap flex items-center gap-1.5 ${tab === 'alerts' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Alerts
              {alertBadgeCount > 0 && (
                <span
                  className={`text-[10px] font-semibold rounded-full px-1.5 py-px ${
                    thresholdCounts.critical > 0 ? 'bg-bad/25 text-bad' : 'bg-warn/25 text-warn'
                  }`}
                >
                  {alertBadgeCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab('alert-settings')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'alert-settings' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
              title="Turn alarm annunciation on/off per ISA priority, set the chime repeat, and preview announcements."
            >
              Alert Settings
            </button>
            <button
              onClick={() => setTab('predictive')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap flex items-center gap-1.5 ${tab === 'predictive' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
            >
              Predictive
              {predictiveBadgeCount > 0 && (
                <span
                  className={`text-[10px] font-semibold rounded-full px-1.5 py-px ${
                    learnedCounts.critical > 0 ? 'bg-bad/25 text-bad' : 'bg-warn/25 text-warn'
                  }`}
                >
                  {predictiveBadgeCount}
                </span>
              )}
            </button>
          </div>
          {tab === 'dashboard' && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="badge badge-muted hover:bg-muted/20 transition-colors"
            >
              {showHistory ? 'hide history' : 'show history'}
            </button>
          )}
          <span
            className={`badge ${conn === 'open' ? 'badge-ok' : conn === 'connecting' ? 'badge-warn' : 'badge-bad'}`}
            title="Live data link to the server (WebSocket). LIVE = real-time telemetry is streaming; LINKING = (re)connecting; OFFLINE = no link, readings may be stale."
          >
            {conn === 'open' ? 'live' : conn === 'connecting' ? 'linking' : 'offline'}
          </span>
          {/* v0.9.11 — theme picker (Default / Babylon 5). */}
          <ThemeToggle />
        </div>
      </header>

      {!snapshot ? (
        <div className="card">Waiting for first snapshot…</div>
      ) : tab !== 'dashboard' ? (
        <Suspense fallback={<PageFallback />}>
          {tab === 'thermal' && <ThermalPanel devices={snapshot.devices} />}
          {tab === 'solar' && <SolarPanel devices={snapshot.devices} />}
          {tab === 'evse' && <EvsePanel devices={snapshot.devices} />}
          {tab === 'strategy' && <StrategyPanel devices={snapshot.devices} />}
          {tab === 'alerts' && <AlertsPanel alerts={thresholdAlerts} />}
          {tab === 'alert-settings' && <AlertSettingsPanel />}
          {tab === 'predictive' && <PredictiveInsights alerts={learnedAlerts} />}
        </Suspense>
      ) : (
        <>
        {snapshot && <RunwayCard />}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start mt-4">
          {snapshot && <EnergyFlow devices={snapshot.devices} />}
          <TodaySummary />
          <ForecastCard />
          {/* v0.9.77 — solar curtailment surface. Sits next to TodaySummary
              so the "lost kWh today" reading is one glance away from the
              "delivered kWh today" reading on TodaySummary. */}
          <CurtailmentCard />

          {showHistory && shp2 && (
            <Suspense fallback={<PageFallback />}>
              <TrendChart
                title="Backup pool & panel load (24h)"
                windowMs={24 * 60 * 60 * 1000}
                bucketSec={60}
                unit=""
                series={[
                  { sn: shp2.sn, metric: 'backup_pct', label: 'Backup %', color: SERIES_PALETTE[0] },
                  { sn: shp2.sn, metric: 'panel_load', label: 'Panel W', color: SERIES_PALETTE[2] },
                ]}
              />
            </Suspense>
          )}

          {showHistory && dpus.filter((d) => d.online).length > 0 && (
            <Suspense fallback={<PageFallback />}>
              <TrendChart
                title="DPU output & PV (24h)"
                windowMs={24 * 60 * 60 * 1000}
                bucketSec={60}
                unit="W"
                series={dpus.filter((d) => d.online).flatMap((d, i) => {
                  const color = SERIES_PALETTE[i % SERIES_PALETTE.length];
                  return [
                    { sn: d.sn, metric: 'total_out', label: `${d.deviceName} out`, color },
                    { sn: d.sn, metric: 'pv_total', label: `${d.deviceName} PV`, color, dashed: true },
                  ];
                })}
              />
            </Suspense>
          )}

          {shp2 && <Shp2Card d={shp2 as any} />}
          {dpus.map((d) => (
            <DpuCard key={d.sn} d={d as any} viaShp2={dpuViaShp2.get(d.sn)} />
          ))}
        </div>

        {others.length > 0 && (
          <div className="mt-6">
            <div className="text-xs uppercase tracking-widest text-muted mb-2">
              Other devices ({others.filter((d) => d.online).length} online · {others.filter((d) => !d.online).length} offline)
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
              {others.map((d) => (
                <SmallDeviceCard key={d.sn} d={d as any} />
              ))}
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
