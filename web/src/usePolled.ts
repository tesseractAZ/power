import { useEffect, useState } from 'react';
import { apiUrl } from './api';

/**
 * v1.176.0 — one polling loop for the dashboard's fetch-driven cards, so each one knows
 * WHEN its data was last good. The cards each hand-rolled this loop and got the failure
 * path wrong in three different ways: RunwayCard kept rendering its last payload with an
 * error flag nothing read; TodaySummary returned silently on !r.ok and kept yesterday's
 * totals after midnight; AdvancedInsightsCard never checked r.ok and set an HTTP 500
 * body as its data. Here a non-OK response is a failure, the last good payload is kept
 * (so a blip does not blank the card), and `lastOkAt` says how old it is — the card
 * decides with pollStale() whether it may still present it as current.
 */
export interface Polled<T> {
  data: T | null;
  /** Wall-clock ms of the last successful fetch, or null if none has succeeded. */
  lastOkAt: number | null;
  /** The most recent attempt failed (network error or non-OK status). */
  failing: boolean;
}

export function usePolled<T>(path: string, intervalMs: number): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, lastOkAt: null, failing: false });
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl(path));
        if (!live) return;
        if (!r.ok) {
          setState((s) => ({ ...s, failing: true }));
          return;
        }
        const j = (await r.json()) as T;
        if (live) setState({ data: j, lastOkAt: Date.now(), failing: false });
      } catch {
        if (live) setState((s) => ({ ...s, failing: true }));
      }
    };
    load();
    const t = window.setInterval(load, intervalMs);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [path, intervalMs]);
  return state;
}

/** A clock that ticks, so relative ages keep moving when no new data arrives. */
export function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(t);
  }, [tickMs]);
  return now;
}
