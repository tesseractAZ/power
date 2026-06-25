/**
 * Shared, periodically-refreshed data caches for the control-room TUI.
 *
 * v0.67.0 — extracted from `telnet/server.ts`. The energy integration, the
 * day-ahead forecast, and the capacity-fade degradation report are all too
 * heavy to recompute on every 1 Hz frame, so they're refreshed on timers and
 * the latest cached value is handed to each render. Pulling this out lets the
 * telnet TCP server and the browser WebSocket console (`wsConsole.ts`) share
 * ONE set of refresh timers instead of each spinning up its own.
 *
 * The refresh cadence / fast-retry / degraded-result-never-clobbers-good
 * behaviour is byte-for-byte the same as the original inline implementation.
 */

import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import { getAnalytics } from '../analyticsClient.js';
import { startOfLocalDayMs } from '../aggregator.js';
import type { FleetEnergyTotals } from '../aggregator.js';
import type { DayForecast, FleetDegradation } from '../analytics.js';
import type { TuiDataProvider } from './session.js';

export interface CreateTuiDataProviderOptions {
  store: SnapshotStore;
  recorder: Recorder;
  log: (msg: string) => void;
}

/**
 * Start the shared refresh timers and return a `{ provider, stop }` pair. The
 * provider's `totals()/forecast()/degradation()` accessors return the latest
 * cached value (or null until the first refresh lands). Call `stop()` to clear
 * every timer.
 */
export function createTuiDataProvider(opts: CreateTuiDataProviderOptions): {
  provider: TuiDataProvider;
  stop: () => void;
} {
  const { store, recorder, log } = opts;
  // Captured once at start so the Plant header can show SYS.UPTIME.
  const serverStartedAt = Date.now();

  let totals: FleetEnergyTotals | null = null;
  let forecast: DayForecast | null = null;
  let degradation: FleetDegradation | null = null;
  let stopped = false;
  let forecastTimer: NodeJS.Timeout | null = null;
  let degradationTimer: NodeJS.Timeout | null = null;

  const storeReady = () => Object.keys(store.get().devices).length > 0;

  const refreshTotals = async () => {
    if (!storeReady()) return; // leave totals null until the fleet is discovered
    try {
      totals = await getAnalytics().report('totals', { sinceMs: startOfLocalDayMs(), untilMs: Date.now() });
    } catch (e: any) {
      log(`telnet: totals refresh failed: ${e?.message ?? e}`);
    }
  };

  // The day-ahead forecast is heavy and needs the device list + recorder
  // history ready, so it self-schedules: fast retries until the first usable
  // result lands, then a relaxed 5-minute cadence. A degraded result (no
  // history yet) never clobbers a good one.
  const refreshForecast = async (): Promise<boolean> => {
    if (!storeReady()) return false;
    try {
      const f = await getAnalytics().report('forecast');
      if (f.historyDays > 0 || forecast == null) forecast = f;
      return f.historyDays > 0;
    } catch (e: any) {
      log(`telnet: forecast refresh failed: ${e?.message ?? e}`);
      return false;
    }
  };
  const scheduleForecast = (delayMs: number) => {
    forecastTimer = setTimeout(async () => {
      if (stopped) return;
      const good = await refreshForecast();
      if (!stopped) scheduleForecast(good ? 5 * 60_000 : 30_000);
    }, delayMs);
  };

  // Async-aware degradation refresh — same self-scheduling shape as forecast.
  // computeDegradation's internal cache is 30 min, so a 5 min poll is the right
  // balance: a fresh value soon after each cache expiry while staying inside
  // the analytics layer's intended cadence.
  const refreshDegradation = async (): Promise<boolean> => {
    if (!storeReady()) return false;
    try {
      degradation = await getAnalytics().report('degradation');
      return true;
    } catch (e: any) {
      log(`telnet: degradation refresh failed: ${e?.message ?? e}`);
      return false;
    }
  };
  const scheduleDegradation = (delayMs: number) => {
    degradationTimer = setTimeout(async () => {
      if (stopped) return;
      const good = await refreshDegradation();
      if (!stopped) scheduleDegradation(good ? 5 * 60_000 : 30_000);
    }, delayMs);
  };

  void refreshTotals();
  const totalsTimer = setInterval(() => { void refreshTotals(); }, 15_000);
  scheduleForecast(2_000);
  scheduleDegradation(3_000);

  const provider: TuiDataProvider = {
    store,
    recorder,
    totals: () => totals,
    forecast: () => forecast,
    degradation: () => degradation,
    serverStartedAt,
  };

  return {
    provider,
    stop: () => {
      stopped = true;
      clearInterval(totalsTimer);
      if (forecastTimer) clearTimeout(forecastTimer);
      if (degradationTimer) clearTimeout(degradationTimer);
    },
  };
}
