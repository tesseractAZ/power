// v0.69.0 — single-flight (in-flight promise dedup).
//
// Several hot paths (getWeather, getDayForecast, the NWS cloud/grid caches)
// memoize their *resolved value* behind a TTL, but NOT the in-flight Promise.
// During a cold-cache window (every add-on restart, or a TTL expiry that
// coincides with a multi-tab dashboard open + the worker self-warm loop), N
// concurrent callers each see an empty cache, fall through, and independently
// run the full scan + external fetch. The boot logs showed the smoking gun:
// `weather:fetched-216h` / `nws-cloud:185h` each emitted EXACTLY 11x inside a
// single 50s window, plus 9 analytics worker timeouts as the duplicate forecast
// scans piled onto one thread.
//
// `singleFlight` coalesces those concurrent callers onto ONE computation: the
// first caller starts the work and stores its Promise; callers 2..N await that
// same Promise; once it settles the slot is cleared so the next cold cycle
// recomputes. This is the exact pattern already proven in haStateCache.ts — this
// module just makes it reusable and unit-testable.
//
// IMPORTANT: the wrapped `fn` must still do its own TTL cache read/write. This
// only dedupes the *concurrent* recompute; it does not add caching. Callers
// should check their fast synchronous cache BEFORE calling run(), so a warm hit
// never pays the Promise overhead, and re-check inside `fn` (a prior flight may
// have just populated the cache while this caller was queued).
export function singleFlight<T>(): {
  run: (fn: () => Promise<T>) => Promise<T>;
  inFlight: () => boolean;
} {
  let inflight: Promise<T> | null = null;
  return {
    run(fn: () => Promise<T>): Promise<T> {
      if (inflight) return inflight; // coalesce: callers 2..N await caller 1's work
      inflight = (async () => {
        try {
          return await fn();
        } finally {
          inflight = null; // clear on settle (success OR throw) so the next cold cycle recomputes
        }
      })();
      return inflight;
    },
    inFlight() {
      return inflight !== null;
    },
  };
}
