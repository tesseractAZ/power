/**
 * v1.193.0 — what Home Assistant's long-term statistics book for a `state_class: total_increasing`
 * sensor fed a series of states, by its rule (homeassistant/components/sensor/recorder.py,
 * compile_statistics and reset_detected):
 *   - a state below 0.9 × the previous one is a METER RESET: the cycle restarts from 0 and the
 *     whole new state is booked as energy;
 *   - any other state adds (state − previous) to the sum, so a smaller drop books a negative
 *     change (logged as "not strictly increasing");
 *   - a non-finite state (unknown / unavailable) is skipped.
 * Every lifetime-counter scenario asserts `resets === 0` and `sum` equal to the real energy.
 * PURE.
 */
export interface HaTotalIncreasing {
  /** What the statistics' sum grows by over the series (the Energy dashboard's figure). */
  sum: number;
  /** States read as meter resets. */
  resets: number;
  /** Booked again by those resets: the whole post-reset state each time. */
  phantomWh: number;
  /** Drops under 10 %: booked as negative changes. */
  dips: number;
  /** Their total. */
  negativeWh: number;
}

export function haTotalIncreasing(series: readonly number[]): HaTotalIncreasing {
  const out: HaTotalIncreasing = { sum: 0, resets: 0, phantomWh: 0, dips: 0, negativeWh: 0 };
  let prev: number | null = null;
  for (const v of series) {
    if (!Number.isFinite(v)) continue;
    if (prev != null) {
      if (v < 0.9 * prev) {
        out.resets += 1;
        out.phantomWh += v;
        out.sum += v;
      } else {
        if (v < prev) {
          out.dips += 1;
          out.negativeWh += prev - v;
        }
        out.sum += v - prev;
      }
    }
    prev = v;
  }
  return out;
}
