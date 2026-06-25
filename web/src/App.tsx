import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSnapshot } from './useSnapshot';
import { EnergyFlow } from './cards/EnergyFlow';
import { TodaySummary } from './cards/TodaySummary';
import { RunwayCard } from './cards/RunwayCard';
import { DpuCard, type DpuViaShp2 } from './cards/DpuCard';
import type { DeviceSnapshot, DpuProjection, GenericProjection, Shp2Projection } from './types';
import { Shp2Card } from './cards/Shp2Card';
import { SmallDeviceCard } from './cards/SmallDeviceCard';
import { alertCounts } from './alerts';
import { priorityOf, priorityCounts } from './alertPriority';
import { sortDevices } from './sort';
import { fmtRel } from './format';
import { SERIES_PALETTE } from './theme';
import { ThemeToggle } from './components/ThemeToggle';
import { installGlossaryTooltips } from './glossary';

// v0.8.1 — route-level code splitting. Each non-default page becomes its own
// chunk; recharts (~540 kB) is vendor-chunked separately via the Vite config.
// The Dashboard remains the eagerly-loaded landing page so the first paint is
// fast. TrendChart stays lazy purely to keep recharts OUT of the entry chunk —
// v0.23.0 note: history defaults ON now, so the dashboard requests the (lazy)
// TrendChart/recharts chunk a beat after first paint rather than on toggle;
// the entry chunk stays lean either way.
const ThermalPanel = lazy(() => import('./pages/ThermalPanel').then((m) => ({ default: m.ThermalPanel })));
const SolarPanel = lazy(() => import('./pages/SolarPanel').then((m) => ({ default: m.SolarPanel })));
const StrategyPanel = lazy(() => import('./pages/StrategyPanel').then((m) => ({ default: m.StrategyPanel })));
const AlertsPanel = lazy(() => import('./pages/AlertsPanel').then((m) => ({ default: m.AlertsPanel })));
// v0.19.0 — the unified Alert Console (broadcast master + per-priority
// annunciation + per-level tones + library) replaced the separate Alert
// Settings + Alert Console tabs.
const AlertConsolePanel = lazy(() =>
  import('./pages/AlertConsolePanel').then((m) => ({ default: m.AlertConsolePanel })),
);
const PredictiveInsights = lazy(() => import('./pages/PredictiveInsights').then((m) => ({ default: m.PredictiveInsights })));
const TrendChart = lazy(() => import('./charts/TrendChart').then((m) => ({ default: m.TrendChart })));
// v0.22.0 — ForecastCard is the last eager recharts consumer on the dashboard.
// Lazy-loading it (alongside LazySparkline in the DPU/SHP2 cards) is what
// finally keeps the ~540 kB recharts chunk OUT of the entry bundle: the
// dashboard shell + non-chart data paint first, charts stream in a beat later.
const ForecastCard = lazy(() => import('./cards/ForecastCard').then((m) => ({ default: m.ForecastCard })));

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
  const [tab, setTab] = useState<
    'dashboard' | 'solar' | 'thermal' | 'strategy' | 'alerts' | 'alert-console' | 'predictive'
  >('dashboard');

  // Attach glossary hover tooltips to every matching label across the app.
  useEffect(() => installGlossaryTooltips(), []);

  // v0.22.0 — memoize every derived view keyed on `snapshot`. The WS pushes a
  // fresh snapshot ~1×/sec; on those, these recompute (data changed). But on a
  // re-render that DOESN'T change `snapshot` (tab/theme/history toggles), each
  // memo returns the SAME array/Map/object reference, so the memo'd cards below
  // see unchanged props and skip re-rendering entirely.
  const devices = useMemo(() => (snapshot ? Object.values(snapshot.devices) : []), [snapshot]);
  const sorted = useMemo(() => sortDevices(devices), [devices]);

  const alerts = snapshot?.alerts ?? [];
  const thresholdAlerts = useMemo(() => alerts.filter((a) => a.source !== 'learned'), [alerts]);
  const learnedAlerts = useMemo(() => alerts.filter((a) => a.source === 'learned'), [alerts]);
  const learnedCounts = useMemo(() => alertCounts(learnedAlerts), [learnedAlerts]);
  // v0.54.0 — derive the Alerts badge + pill colour from the ISA priority of the
  // threshold alerts, so a real measured-threshold Medium (P3, e.g. a reserve
  // band) is reflected the same way the Alerts page counts it as "actionable".
  const thresholdPriority = useMemo(() => priorityCounts(thresholdAlerts), [thresholdAlerts]);
  const alertBadgeCount =
    thresholdPriority.critical + thresholdPriority.high + thresholdPriority.medium;
  const predictiveBadgeCount = learnedCounts.critical + learnedCounts.warning;

  const shp2 = useMemo(() => sorted.find((d) => d.projection?.kind === 'shp2'), [sorted]);
  const dpus = useMemo(
    () => sorted.filter((d) => d.productName.toLowerCase().includes('delta pro ultra')),
    [sorted],
  );
  // v0.25.0 — stabilize the two TrendChart `series` props. They were fresh array
  // literals every render, which DEFEATED TrendChart's merge memo (keyed on series
  // identity) and forced a full 24h-chart rebuild + recharts reconcile on every
  // ~1 Hz snapshot tick. Memoize on the underlying identity so the series rebuild
  // only when they actually change (a DPU on/offline/rename, or the SHP2 SN).
  const shp2TrendSeries = useMemo(
    () =>
      shp2
        ? [
            // v0.24.2 — Panel W (left, watts) + Backup % (right axis, 0–100) so the
            // % isn't flattened against the kW load.
            { sn: shp2.sn, metric: 'panel_load', label: 'Panel W', color: SERIES_PALETTE[2], unit: 'W' },
            { sn: shp2.sn, metric: 'backup_pct', label: 'Backup %', color: SERIES_PALETTE[0], axis: 'right' as const, unit: '%' },
          ]
        : [],
    [shp2?.sn],
  );
  const onlineDpus = dpus.filter((d) => d.online);
  // Key the DPU series on the online-DPU identity + name + order (palette index is
  // positional) so it rebuilds only when a DPU goes on/offline or is renamed.
  const onlineDpuSig = onlineDpus.map((d) => `${d.sn}|${d.deviceName}`).join(',');
  const dpuTrendSeries = useMemo(
    () =>
      onlineDpus.flatMap((d, i) => {
        const color = SERIES_PALETTE[i % SERIES_PALETTE.length];
        return [
          { sn: d.sn, metric: 'total_out', label: `${d.deviceName} out`, color },
          { sn: d.sn, metric: 'pv_total', label: `${d.deviceName} PV`, color, dashed: true },
        ];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onlineDpuSig],
  );
  // O(1) membership for the "others" partition below (was dpus.includes(d), O(n)).
  const dpuSet = useMemo(() => new Set(dpus), [dpus]);
  // "Other devices" — everything that isn't the SHP2 or a DPU. Offline ones sort
  // to the end (stable sort preserves the compareDevices order within each group).
  const others = useMemo(
    () =>
      sorted
        .filter((d) => d !== shp2 && !dpuSet.has(d))
        .sort((a, b) => Number(b.online) - Number(a.online)),
    [sorted, shp2, dpuSet],
  );

  // Build a DPU-SN → SHP2-derived data map so we can fall back when a DPU's own
  // cloud connection is offline. The SHP2 reports its bound DPUs' overall state
  // (battery %, contributed watts, AC-open, temp, errors) via its wired link.
  // Memoized on `shp2` so each DpuViaShp2 value keeps a stable reference across
  // non-snapshot re-renders — that is what lets the memo'd DpuCard actually skip.
  const dpuViaShp2 = useMemo(() => {
    const m = new Map<string, DpuViaShp2>();
    if (shp2?.projection?.kind === 'shp2') {
      const sp = shp2.projection as Shp2Projection;
      sp.sources.forEach((source, i) => {
        if (!source.sn) return;
        const w = sp.sourceWatts[i];
        // chWatt is reported as negative when the source is contributing power to SHP2.
        // Flip sign so positive = discharging (consistent with the rest of the UI).
        const liveWatts = typeof w === 'number' ? -w : null;
        m.set(source.sn, { source, liveWatts, shp2Sn: shp2.sn });
      });
    }
    return m;
  }, [shp2]);

  return (
    <div className="min-h-full p-4 md:p-6 max-w-[1800px] mx-auto">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Power</h1>
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
                    thresholdPriority.critical > 0
                      ? 'bg-bad/25 text-bad'
                      : thresholdPriority.high > 0
                        ? 'bg-high/25 text-high'
                        : 'bg-warn/25 text-warn'
                  }`}
                >
                  {alertBadgeCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab('alert-console')}
              className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap ${tab === 'alert-console' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}
              title="Broadcast on/off + volume, per-priority annunciation, and the tone for each alert level (built-in or your own)."
            >
              Alert Console
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
          {tab === 'strategy' && <StrategyPanel devices={snapshot.devices} />}
          {tab === 'alerts' && <AlertsPanel alerts={thresholdAlerts} />}
          {tab === 'alert-console' && <AlertConsolePanel />}
          {tab === 'predictive' && <PredictiveInsights alerts={learnedAlerts} />}
        </Suspense>
      ) : (
        <>
        {snapshot && <RunwayCard />}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start mt-4">
          {snapshot && <EnergyFlow devices={snapshot.devices} grid={snapshot.grid} />}
          <TodaySummary />

          {/* OVERVIEW REORDER — the SHP2 card and the active/online DPU cards sit
              directly under the Today summary section. */}
          {shp2 && <Shp2Card d={shp2 as DeviceSnapshot & { projection?: Shp2Projection }} />}
          {dpus.map((d) => (
            <DpuCard key={d.sn} d={d as DeviceSnapshot & { projection?: DpuProjection }} viaShp2={dpuViaShp2.get(d.sn)} />
          ))}

          {/* v0.22.0 — ForecastCard is lazy (recharts off the entry chunk). The
              fallback is col-span-full like the card itself, so the lazy chunk
              resolving causes no layout shift. */}
          <Suspense fallback={<div className="card col-span-full text-sm text-muted">Loading forecast…</div>}>
            <ForecastCard />
          </Suspense>

          {shp2 && (
            <Suspense fallback={<PageFallback />}>
              <TrendChart
                title="Backup pool & panel load (24h)"
                windowMs={24 * 60 * 60 * 1000}
                bucketSec={60}
                unit="W"
                series={shp2TrendSeries}
              />
            </Suspense>
          )}

          {onlineDpus.length > 0 && (
            <Suspense fallback={<PageFallback />}>
              <TrendChart
                title="DPU output & PV (24h)"
                windowMs={24 * 60 * 60 * 1000}
                bucketSec={60}
                unit="W"
                series={dpuTrendSeries}
              />
            </Suspense>
          )}
        </div>

        {others.length > 0 && (
          <div className="mt-6">
            <div className="text-xs uppercase tracking-widest text-muted mb-2">
              Other devices ({others.filter((d) => d.online).length} online · {others.filter((d) => !d.online).length} offline)
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
              {others.map((d) => (
                <SmallDeviceCard key={d.sn} d={d as DeviceSnapshot & { projection?: GenericProjection }} />
              ))}
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
