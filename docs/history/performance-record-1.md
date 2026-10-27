> [!NOTE]
> Historical, and frozen: section 4b of the performance record, the first measurement of the
> analytics path's runtime cost (2026-09-11), moved here unedited on 2026-10-26 to keep
> `docs/PERFORMANCE.md` under its size limit. A later release may have superseded what it says;
> section 4c of the [current record](../PERFORMANCE.md) measures the live host again. This file is
> not part of the printable manual.

## 4b. Runtime cost of the analytics path (measured 2026-09-11)

The first end-to-end latency measurement of the analytics worker on the live
deployment, prompted by a question about whether it should be multithreaded.

**One report accounted for effectively all of it.** Cold/warm latency, measured
against the live Pi with `curl`:

| Endpoint | Cold | Warm |
|---|---|---|
| `/api/equipment-health` | **9,007 ms** | 14 ms |
| every other analytics endpoint measured (10 of them) | **10–25 ms** | 10–25 ms |

`computeEquipmentHealth` pulled a **60-day** window of three metrics per MPPT
string per DPU, plus two more per DPU for inverter standby — **40 metric-series
of 60 days each** — while `MPPT_EFF_TTL_MS` is **10 minutes**. It re-derived two
months of history every ten minutes. The query was already indexed
(`idx_samples_sn_metric_ts`) and already bucketed at 5 min; it was simply large.

Because the analytics worker is single-threaded this is a **head-of-line block**:
six concurrent requests were observed completing together at **~20.2 s**, on
exactly the endpoints the dashboard fetches on load.

★ **It is not a threading problem, and the measurement is what says so.** The
host is a 4-core Pi at **load average 0.22** with **98.8% idle**. Threads address
contention; there was none. The other five requests in that burst were not
computing for 20 s — they were *waiting* on one slow one. A worker pool would
have bought a SQLite connection per thread against a 1.72 GB database, duplicated
heap on a host already at 3.7 GB used, and cross-thread cache coherence across the
report dependency graph: new failure surface on a life-safety system, to route
*around* one expensive query rather than remove it.

**v1.151.0 result, measured the same way:**

| | Before | After |
|---|---|---|
| Recompute after the 10-min TTL | **9,007 ms** | **96 ms** |
| Span queried per recompute | 60 days | the new tail only (>100× less, in test) |
| Worst latency over 259 polls / 13 min | — | **96 ms** (median 18, p95 24) |

★ **The first number taken for this table was wrong, and the way it was wrong is
the point.** A post-TTL call measured **12 ms**, which looked like a triumph. It
was a cache hit: `generatedAt` showed a background consumer — `/api/ha-state` and
`mqttDiscovery` poll `equipmentHealth` on a ~60 s cadence — had recomputed 18
seconds earlier. Nothing about the 12 ms was false; it simply did not measure what
it appeared to.

The sound measurement uses the client's own single-flight coalescer as the
instrument: if a recompute still cost 9 s, **any** caller arriving during that
window blocks on it and returns ~9 s. Polling every 3 s therefore cannot miss one.
Across 259 polls exactly one recompute was observed (18:19:02), the call that saw
it took **96 ms**, and no call ever blocked near 9 s. *Absence of a slow reading is
only evidence when the method guarantees a slow reading would have been seen.*

★ *2026-10-15 (§4c): the head-of-line signature is still there in dashboard-load bursts —
requests in a burst finish within 14–16 ms of each other — but the worst request in 47.8 h of log
took 8,540 ms, against the ~20.2-s burst above. Probed one at a time, warm reads take 9.5–19.7 ms,
`/api/equipment-health` among them.*
