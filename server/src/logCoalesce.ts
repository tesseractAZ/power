// v0.76.0 — log coalescer (duplicate-line storm suppression).
//
// Some emitters fire the SAME line over and over during a transient incident.
// The smoking gun was the MQTT reconnect cycle: a 66-minute DNS brownout drove
// the mqtt client into a tight reconnect→close→error loop, and those lines
// (e.g. `mqtt: error getaddrinfo EAI_AGAIN ...`) were logged 514 times — pure
// duplicate noise that buried the real signal an operator greps for during an
// outage.
//
// `makeLogCoalescer` keeps the FIRST occurrence of each distinct message at its
// original level/format, then suppresses identical repeats and emits a periodic
// roll-up — "(mqtt: error … : 513 more in last 66m)" — so the count and the
// window survive without the flood. This is the logging analogue of the storm
// gate in broadcast.ts; factored out here so it's reusable and unit-testable.
//
// Design notes:
//   - State is PER DISTINCT KEY (default: the exact message string), so several
//     lines that interleave in a loop (reconnect / close / error) each coalesce
//     independently rather than resetting each other. Override `keyFor` to
//     collapse messages that vary only in a volatile suffix.
//   - The FIRST sighting of a key always logs immediately — a state CHANGE (a
//     new distinct line) is never swallowed behind a stale "suppressed" count.
//   - While a key keeps repeating, a roll-up summary is emitted at most once per
//     `summaryWindowMs`, carrying the suppressed count + elapsed window.
//   - The clock is injectable (`now`) so the window logic is testable without
//     real time.
//   - `flush()` force-emits all pending summaries and re-arms every key, so the
//     tail isn't lost (call it on recovery — e.g. a successful reconnect — or
//     shutdown) and the next sighting logs fresh.

export interface LogCoalescer {
  /** Log `msg` if it's new or the summary window elapsed; otherwise count it as suppressed. */
  log: (msg: string) => void;
  /** Emit any pending "N more" summaries now and re-arm all keys. */
  flush: () => void;
}

export interface LogCoalescerOptions {
  /** Emit a roll-up summary at most once per this many ms while a key keeps repeating. */
  summaryWindowMs?: number;
  /** Collapse messages to a key; identical keys are treated as duplicates. Defaults to identity. */
  keyFor?: (msg: string) => string;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

interface KeyState {
  sample: string;       // the most recent raw message for this key (used in the summary)
  suppressed: number;   // duplicates swallowed since the last emit
  windowStartedAt: number;
  lastEmitAt: number;
}

function humanizeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

/**
 * Build a coalescer over an underlying `emit` sink (typically the module's
 * info/warn logger). Pure aside from the injected clock — no module-global state.
 */
export function makeLogCoalescer(emit: (msg: string) => void, opts: LogCoalescerOptions = {}): LogCoalescer {
  const summaryWindowMs = opts.summaryWindowMs ?? 60_000;
  const keyFor = opts.keyFor ?? ((m) => m);
  const now = opts.now ?? Date.now;

  const states = new Map<string, KeyState>();

  const emitSummary = (st: KeyState, atMs: number) => {
    if (st.suppressed > 0) {
      emit(`${st.sample} : ${st.suppressed} more in last ${humanizeMs(atMs - st.windowStartedAt)}`);
    }
    st.suppressed = 0;
  };

  return {
    log(msg: string): void {
      const key = keyFor(msg);
      const t = now();
      const st = states.get(key);
      if (!st) {
        // First sighting of this key — a distinct line / state change. Log now.
        states.set(key, { sample: msg, suppressed: 0, windowStartedAt: t, lastEmitAt: t });
        emit(msg);
        return;
      }
      // Seen before → suppress, rolling up the count once per window.
      st.sample = msg;
      st.suppressed++;
      if (t - st.lastEmitAt >= summaryWindowMs) {
        emitSummary(st, t);
        st.windowStartedAt = t;
        st.lastEmitAt = t;
      }
    },
    flush(): void {
      const t = now();
      for (const st of states.values()) emitSummary(st, t);
      // Re-arm: next sighting of any key logs fresh rather than silently counting.
      states.clear();
    },
  };
}
