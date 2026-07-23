# EcoFlow Panel — Complete System & Engine Reference

This is the definitive technical reference for the **ecoflow-panel** Home Assistant add-on: a life-safety off-grid solar/battery monitor and depletion alarm for a Phoenix, AZ system (EcoFlow Smart Home Panel 2 + Delta Pro Ultra battery/inverter Cores + a 42-panel array + EVSE). It documents **every** feature and engine — what each does, its inputs, the exact algorithm and math it computes, how data traces through the pipeline to it and where its output goes, the endpoints and sensors it produces, the configuration knobs that tune it, and its edge-case guards.

The add-on is a Node/TypeScript server (`server/`) that ingests EcoFlow cloud MQTT, persists a SQLite time-series, runs ~40 analytics engines in a worker thread, and exposes the results over an HTTP API (`:8787`), Home Assistant MQTT-discovery sensors, a React web dashboard, a telnet TUI (`:2323`), and a set of HACS Lovelace cards. It also drives an **audible** alarm (chimes + text-to-speech over Home Assistant media players and a SIP intercom) when the battery is projected to deplete.

> Every constant, formula, endpoint path, and config key below was written directly from the source and independently completeness-/accuracy-checked against it. Where a value is a tunable default, that is noted. For the operator quick-start, install steps, and the option list, see the top of the **Configuration, Deployment, Security & Operations** chapter; for a high-level tour, see `README.md`.


## Table of Contents

1. [System Architecture & Data Flow](#1-system-architecture--data-flow)
2. [EcoFlow Cloud Integration & Home Assistant Wiring](#2-ecoflow-cloud-integration--home-assistant-wiring)
3. [Solar & PV Forecast Engine](#3-solar--pv-forecast-engine)
4. [Physics-Based & Bayesian Model Tier](#4-physics-based--bayesian-model-tier)
5. [Runway, Depletion & Battery-SoC Alarms (safety-critical)](#5-runway-depletion--battery-soc-alarms-safety-critical)
6. [Battery & PV Health Engines (SoH, EOL, pack-risk, resistance, RTE, thermal, soiling)](#6-battery--pv-health-engines-soh-eol-pack-risk-resistance-rte-thermal-soiling)
7. [Energy Accounting, Self-Consumption, Cost & Dispatch](#7-energy-accounting-self-consumption-cost--dispatch)
8. [Alerts, Anomaly Detection, Incidents & Learning Loop](#8-alerts-anomaly-detection-incidents--learning-loop)
9. [The Online Learning Loop (shadow models, online regression, model health)](#9-the-online-learning-loop-shadow-models-online-regression-model-health)
10. [Audible Broadcast, Chimes & Text-to-Speech](#10-audible-broadcast-chimes--text-to-speech)
11. [User Interfaces: Web Dashboard, Telnet TUI & HACS Cards](#11-user-interfaces-web-dashboard-telnet-tui--hacs-cards)
12. [Configuration, Deployment, Security & Operations](#12-configuration-deployment-security--operations)
13. [Safety & Operational Plumbing](#13-safety--operational-plumbing)
14. [Intelligent Lighting & HVAC Posture (energy-aware automation)](#14-intelligent-lighting--hvac-posture-energy-aware-automation)
15. [Night-Charge TOU Arbitrage Advisor (advisory)](#15-night-charge-tou-arbitrage-advisor-advisory)
16. [Appendix A — Feature Inventory (evidence linkage)](#appendix-a--feature-inventory-evidence-linkage)


---

## 1. System Architecture & Data Flow

This is the reference for how `ecoflow-panel` moves data from the EcoFlow cloud
to its outputs — HTTP endpoints, the Home Assistant MQTT sensors, the telnet
control-room TUI, and the React web UI. It documents the ingest pipeline, the
storage layer (SQLite time-series + lifetime accumulators), the off-main-thread
analytics worker, the report registry, and the request-resolution path.

Every function name, constant, endpoint, and config key below is drawn from the
actual source in `server/src/`.

---

### 1. End-to-end data flow

The add-on is a single Node process (Fastify HTTP server on the main thread) plus
**one worker thread** for heavy analytics. Telemetry arrives by two independent
paths and converges in a single in-memory `SnapshotStore`, which is the fan-out
hub for every downstream consumer.

```
                          EcoFlow Cloud (IoT-Open OpenAPI)
                          │                        │
              REST /device/list + /quota/all      MQTT /open/{user}/{sn}/quota,/status
              (poll, POLL_INTERVAL_MS=60s)         (push, ~1–9 msg/min per device)
                          │                        │
                snapshot.ts refreshAll()     ecoflow/mqtt.ts on('message')
                store.setDeviceList()        → translateDpuMqtt() (DPU only)
                store.setDeviceQuota()       → store.setMqttMessage(sn,cmdId,param,translated)
                          │                        │
                          └──────────┬─────────────┘
                                     ▼
                         ┌──────────────────────────┐
                         │  SnapshotStore (snapshot.ts) │  ← single source of live truth
                         │  - rawBySn / mqttFlatBySn    │
                         │  - devices[sn].projection    │  projectByProduct(productName, raw)
                         │  - grace-holds, err onsets   │
                         │  emits 'change' (frameSeq++)  │
                         └──────────────────────────┘
             ┌──────────────┬──────────────┬────────────────┬──────────────┐
             ▼              ▼              ▼                ▼              ▼
      recorder.ts     analyticsClient   /ws snapshot    alertMonitor   mqttDiscovery
      (on 'change')   .pushSnapshot()   frame (WS)      (20s eval)     .publishState()
      extract()→SQL   throttled 750ms   snapshotForClient  alarms        (30s → HA MQTT)
             │              │
             │ WAL DB (samples + lifetime_totals)
             │              ▼
             │      analyticsWorker.ts (worker thread)
             │      read-only recorder (readRecorder.ts)
             │      buildReport(name) via reports.ts registry
             │              ▲
             └──────────────┘ same WAL file, separate read connection
```

**Two schemas, one store.** The REST poll and the MQTT push carry *different*
field schemas (`snapshot.ts` header comment): REST is `hs_yj751_*` / `pd303_mc.*`
quota shape; MQTT is `cmdId`-routed (`bpInfo[].*`). `SnapshotStore` keeps them in
separate caches (`rawBySn` for REST-schema, `mqttByCmd`/`mqttFlatBySn` for MQTT).
Only DPU (`delta pro ultra`) MQTT messages are translated back into the REST
schema (`translateDpuMqtt`); when translation succeeds, MQTT drives the live
projection. For all other products (notably the SHP2), the MQTT message is stored
for `/api/debug/raw` but does **not** refresh the projection — the REST poll owns
those. This is why the SHP2's healthy MQTT chatter must **not** touch the
freshness clock (see §7 `lastUpdated`).

---

### 2. Module map

| Module | Thread | Responsibility |
|---|---|---|
| `config.ts` | main | Runtime config from env vars; lazy-throwing getters for EcoFlow secrets |
| `ecoflow/rest.ts` | main | EcoFlow OpenAPI REST client (`listDevices`, `getQuotaAll`) |
| `ecoflow/mqtt.ts` | main | EcoFlow MQTT client; subscribes per-device quota/status topics |
| `ecoflow/mqttTranslate.ts` | main | `translateDpuMqtt()` — DPU cmdId schema → REST quota schema |
| `ecoflow/project.ts` | main | `projectByProduct()` — raw quota → typed `Projection` (dpu/shp2/generic) |
| `snapshot.ts` | main | `SnapshotStore` (live state), `startPollLoop`, `refreshAll` |
| `recorder.ts` | main (write) | SQLite time-series writer, dedupe, lifetime rollup, retention, gap detection |
| `readRecorder.ts` | worker (read) | Read-only twin of recorder's read path; byte-parity guaranteed by test |
| `aggregator.ts` | worker | Trapezoidal Wh integration (`integrateWh`, `computeTotals`, `circuitHistoryByDay`) |
| `analyticsWorker.ts` | worker | Worker entry: owns read recorder, runs `buildReport`, self-warms caches |
| `analyticsWorkerBootstrap.mjs` | worker | `.mjs` shim that registers tsx's loader then imports the `.ts` worker |
| `analyticsClient.ts` | main | Main-thread proxy: spawn/respawn worker, id-correlate, coalesce + TTL-cache |
| `reports.ts` | worker | The **report registry** (`BUILDERS`), dependency chains, `WARM_REPORTS` |
| `analytics.ts` | worker | The ~450 KB compute engine (forecast, runway, degradation, …) |
| `index.ts` | main | Fastify bootstrap, all HTTP routes, `/ws`, wiring of every subsystem |
| `mqttDiscovery.ts` | main | HA MQTT discovery config + 30s state publish |
| `telnet/server.ts` | main | Telnet control-room TUI (port 2323) |
| `alertMonitor.ts` / `alerts.ts` | main | Alarm engine (life-safety path) |

---

### 3. Ingest pipeline (detail)

#### 3.1 REST poll (`snapshot.ts`)

`startPollLoop(store, POLL_INTERVAL_MS, log, warn)` runs `refreshAll(store)` on a
`setTimeout` chain (self-rescheduling; **not** `setInterval`, so a slow poll can't
overlap).

- `POLL_INTERVAL_MS` default `60_000` (env `POLL_INTERVAL_MS`).
- `refreshAll`:
  1. `store.markDeviceListAttempt()` (records attempt time).
  2. `ecoflow.listDevices()` → `store.setDeviceList()` — upserts each device,
     resolves display name (`resolveDeviceName`, alias file, product guess),
     sets `online = (d.online === 1)`, logs online/offline transitions.
  3. For each `online === 1` device, `ecoflow.getQuotaAll(sn)` →
     `store.setDeviceQuota(sn, quota)`; on error `store.setDeviceError(sn, msg)`.
- Logging discipline: routine "poll ok" is **debug-gated** (`POLL_DEBUG`);
  only failure→recovery (`poll ok … (recovered)`) and slow polls
  (`SLOW_POLL_MS = 5_000`) stay at INFO; a failed poll logs at **warn**.
- A `fleet-status` line dumps per-SN MQTT msg-count + last-seen every
  `STATUS_DUMP_INTERVAL_MS = 10 min`.

#### 3.2 MQTT push (`ecoflow/mqtt.ts`)

`startMqtt(store, log, warn)` fetches a broker cert from
`/iot-open/sign/certification`, connects, and subscribes per device to
`/open/{username}/{sn}/quota` and `.../status` (QoS 0). On `message`:

- `kind === 'quota'`: extract `cmdId` + `param`; if the product name includes
  `delta pro ultra`, run `translateDpuMqtt(cmdId, param, store.getRaw(sn))`, else
  `translated = null`. Then `store.setMqttMessage(sn, cmdId, param, translated)`.
- `kind === 'status'`: `store.setDeviceOnline(sn, status === 1)`.

Boot resilience (`index.ts` `startMqttWithRetry`): indefinite backoff
`MQTT_RETRY_MS = [10s, 30s, 60s, 120s, 300s]` (cap 5 min). The first
`MQTT_BOOT_GRACE_ATTEMPTS = 5` failures log at warn (benign boot transient);
after that, error. REST polling works regardless of MQTT state.

#### 3.3 Projection (`ecoflow/project.ts`)

Every ingest path (`setDeviceQuota`, `mergeDeviceQuota`) calls
`projectByProduct(productName, raw)` to rebuild a typed `Projection`
(`kind: 'dpu' | 'shp2' | 'generic'`) attached to `devices[sn].projection`. After
projecting, the store also runs three per-device trackers:

- `applyBackupPoolGraceHold` — SHP2 only; substitutes the last-coherent
  backup-pool trio (`backupBatPercent`/`backupFullCapWh`/`backupRemainWh`) across
  brief cloud-reconnect blips instead of publishing "unknown"
  (`BACKUP_POOL_GRACE_HOLD_MS`; smooths ~10–15 reconnect blips/day).
- `trackDpuErrOnset` — per-DPU `{code, sinceMs}` of the standing `sysErrCode`;
  re-baselined on code change/clear so `alerts.ts` can debounce transient
  reconnect blips of the inverter-error CRITICAL.
- `trackShp2SrcErrOnsets` — per-SHP2-slot source-error onset (`<sn>:<slot>`),
  the same debounce discipline for `shp2-src-err-<slot>` CRITICALs.

#### 3.4 The `change` event and frame sequencing

Every mutating store method ends with `this.emit('change', this.snap, sn?)`.
`SnapshotStore.emit` is overridden to bump a monotonic `frameSeq` on each
`'change'`. Because `snap` is mutated in place (stable reference), consumers key
on `frameSeq` — not `generatedAt`, which can collide within a millisecond under
sub-second MQTT bursts. This lets `index.ts` serialize the WS snapshot frame
**once per emit** (`snapshotFrame()`), reusing the same bytes across all clients.

---

### 4. Storage layer — `recorder.ts`

The recorder owns the **sole write connection** to the WAL SQLite database at
`config.dbPath`.

#### 4.1 `config.dbPath`

`process.env.DB_PATH ?? (process.env.SUPERVISOR_TOKEN ? '/data/ecoflow.db' : '../data/ecoflow.db')`.
Inside the HA add-on container `SUPERVISOR_TOKEN` is always injected, so an
absolute `/data/ecoflow.db` default guards against a dropped `DB_PATH` silently
redirecting writes to `/app/data` (which the AppArmor profile would block).

#### 4.2 Schema

```sql
CREATE TABLE IF NOT EXISTS samples (
  ts     INTEGER NOT NULL,   -- ms epoch
  sn     TEXT    NOT NULL,   -- device serial (or 'weather' for GHI/cloud series)
  metric TEXT    NOT NULL,
  value  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_sn_metric_ts ON samples (sn, metric, ts);
CREATE INDEX IF NOT EXISTS idx_samples_ts           ON samples (ts);  -- retention DELETE seek

CREATE TABLE IF NOT EXISTS lifetime_totals (
  metric_key         TEXT PRIMARY KEY,
  wh                 REAL    NOT NULL DEFAULT 0,
  last_integrated_ts INTEGER NOT NULL DEFAULT 0   -- watermark
);
```

The composite `(sn, metric, ts)` index serves `query()`/`queryMulti()`; the
dedicated single-column `idx_samples_ts` lets the hourly retention `DELETE WHERE
ts < ?` seek instead of full-scanning under the write lock.

**Pragmas** (write connection): `journal_mode = WAL`, `synchronous = NORMAL`,
`cache_size = -32768` (32 MB), `mmap_size = 268435456` (256 MB),
`temp_store = MEMORY`. `ANALYZE samples` runs on every startup (cheap; keeps the
planner current as row skew grows).

#### 4.3 Write path — `record(extract(snap))`

`store.on('change')` coalesces bursts with a `setImmediate` guard (one
`extract`+`record` per tick, not per MQTT message). `extract(snap)` walks
`devices[*].projection` and emits `MetricSample[]` (`{sn, metric, value}`),
pushing only finite numbers. Metrics emitted per projection kind:

- **DPU**: `soc`, `pv_total`, `pv_high`/`pv_low` (+ `_v`/`_a`), `ac_in`,
  `ac_out`, `total_in`, `total_out`, `bat_vol`, `bat_amp`, `mppt_hv_temp`,
  `mppt_lv_temp`, `chg_max_soc`, and per pack `packN_soc/temp/in/out/cell_max/
  cell_min/mos_max/board/vol_diff_mv/vol_max_mv/vol_min_mv/balancing/soh/cycles/
  full_cap_mah/remain_cap_mah/lifetime_chg_mah/lifetime_dsg_mah`.
- **SHP2**: `backup_pct`, `backup_remain_min`, `backup_charge_min`, per-circuit
  `chN_w`, summed `panel_load`, `grid_home_w` (SHP2-metered home grid import),
  split-phase `pairN_w`, per-source `srcN_pct/temp/w`.
- **Generic**: `soc`, `in_watts`, `out_watts`, `pv_watts`, `ac_in`, `ac_out`,
  `temp`.

#### 4.4 Dedupe / heartbeat

`shouldRecord(sn, metric, value, now)` (constants top of file):

- `MIN_INTERVAL_MS = 10_000` — never write the same metric more than once / 10 s.
- `MAX_INTERVAL_MS = 300_000` — heartbeat: always write at least every 5 min even
  if unchanged.
- `VALUE_EPSILON = 0.5` — between those bounds, write only if the value moved
  ≥ 0.5 (W or %).

#### 4.5 Retention

Hourly `setInterval` runs `DELETE FROM samples WHERE ts < now − RETAIN_MS`,
`RETAIN_MS = 30 days`. Timer is `.unref()`'d.

#### 4.6 Lifetime accumulators — `rollupLifetime()`

Runs every `LIFETIME_ROLLUP_INTERVAL_MS = 5 min` (first run ~30 s after boot).
Two kinds of lifetime keys:

1. **Watt-integrated keys** from `buildContributors(snap)`:
   `fleet_pv_wh`, `fleet_load_wh`, `fleet_grid_import_wh` (DPU `ac_in`),
   `fleet_grid_home_wh` (SHP2 `grid_home_w`), and per-circuit `circuit_<ch>_wh`.
   For each key, integrate each contributor's series over `[watermark, now]`
   (fetching from `watermark − LIFETIME_ROLLUP_LOOKBACK_MS` so `integrateWh` gets
   the pre-window boundary sample), sum the Wh, clamp negatives to 0, and
   `writeLifetime(key, prev.wh + addedWh, now)`. First run seeds the watermark
   only 60 s back (avoids integrating all history).
   - `LIFETIME_ROLLUP_LOOKBACK_MS = 10 min` (== `integrateWh` default `maxGapMs`).
   - Fleet PV/grid rollups are gated on SHP2 membership (spare cores excluded).
2. **BMS coulomb-counter keys**: `fleet_battery_charge_wh` /
   `fleet_battery_discharge_wh`, stored as monotone `max(BMS, persistedFloor)`.
   The old discharge≤charge clamp was **removed** in v0.45.0 — over an open
   window ending below the baseline SoC, cumulative discharge legitimately
   exceeds charge; HA ingests the two as independent `total_increasing` sensors.

The read-only worker reproduces these via the persisted table only
(`getLifetimeTotals`), reporting `persistedWh` with `pendingWh = 0` — it lags by
at most one rollup interval, negligible against a forever-accumulating total.

#### 4.7 Telemetry-gap detection

`record()` only fires on a `'change'`; nothing runs when telemetry *stops*. The
recorder tracks the last HOME-device insert (spares excluded) and, when writes
resume after a silence, persists a durable marker (not synthetic samples) to
`telemetry-gaps.json` (bounded ring `GAPS_MAX = 50`), surfaced at
`/api/telemetry-gaps`.

- In-process stall threshold `GAP_THRESHOLD_MS = 3 × MAX_INTERVAL_MS = 15 min`.
- Restart-spanning floor `RESTART_GAP_FLOOR_MS = MAX_INTERVAL_MS = 5 min`
  (one heartbeat) — a restart that lost even one interval is real dark time.
- RTC-less-Pi hardening: if the boot clock is behind the newest persisted sample
  (before NTP steps), the boot check is deferred and resolved in-process using
  monotonic `performance.now()` (`bootMonoMs`, `RESTART_GAP_SETTLE_MS = 10 min`).

---

### 5. Aggregation — `aggregator.ts`

`integrateWh(points, sinceMs, untilMs, maxGapMs = 10 min)` is the shared
trapezoidal integrator, gap-aware:

- Filters to `[sinceMs, untilMs]`; includes the last pre-`sinceMs` sample as a
  head-hold **only if** the first in-window sample is within `maxGapMs` of it
  (the v1.14.0 F9 fix — the head-hold is conditioned on the *real* inter-sample
  gap, not the distance to the window edge, so a window boundary chopping a real
  >maxGap coverage loss can't fabricate held-power Wh).
- Holds the last value to `untilMs` only if within `maxGapMs`.
- Sums `avg(v[i], v[i-1]) × dt / 3_600_000` for each segment with `0 < dt ≤
  maxGapMs`; segments over `maxGapMs` are skipped and counted as gap.
- Returns `{ wh, coverageMs, totalMs, gapMs, samples }`.

Callers widen their fetch by `INTEGRATE_HEAD_LOOKBACK_MS = 10 min` so the head
segment is recoverable, then integrate the exact window.

- `computeTotals(store, recorder, sinceMs, untilMs)` → `FleetEnergyTotals`
  (fleet `pvWh`/`acOutWh`/`panelLoadWh`/`batteryNetWh` + `coverage`/`pvCoverage`).
  Fleet PV/AC/battery rollups count **only SHP2-connected DPUs**
  (`shp2ConnectedDpuSns`); spares get per-device metrics but no fleet inclusion.
  Battery net is per-pack `in`/`out` (true battery flow), not `total_in/out`.
- `circuitHistoryByDay(recorder, sn, ch, days, metric?)` → per-day kWh/peakW/
  coverage for one SHP2 circuit, including the in-progress today.

---

### 6. Threading model & the analytics worker

#### 6.1 Why a worker (`analyticsWorker.ts` header)

Heavy multi-second history scans (7-day forecasts, degradation, etc.) used to run
on the main event loop, intermittently starving the HTTP port and tripping the
Supervisor watchdog into a restart every ~40 min. Since v0.10.0 all
recorder-backed analytics run on **one worker thread** with its own read-only
WAL connection; the main thread keeps the sole write connection and never blocks
on a SQLite scan.

- WAL allows one writer + many concurrent readers across connections, so the
  worker's read connection sees the writer's committed rows with no locking.
- `readRecorder.ts` is a faithful copy of `recorder.ts`'s read path (same SQL,
  same bucketing); `test/readRecorder.test.ts` asserts byte-for-byte parity.
  Read pragmas add `PRAGMA query_only = ON`. Write methods are stubbed.

#### 6.2 Worker message protocol

Messages **in**: `{kind:'snapshot', snapshot}`, `{kind:'report', id, name, args}`,
`{kind:'query', id, …}`, `{kind:'listMetrics', id, sn}`.
Messages **out**: `{kind:'ready'}`, `{kind:'log', message}`,
`{kind:'result', id, ok, result|error}`.

The worker holds the latest `FleetSnapshot` and builds reports against
`ctx = {recorder, snapshot, log}`.

#### 6.3 Self-warm

The worker keeps report TTL caches hot: `WARM_INTERVAL_MS = 4 min` loop (plus a
500 ms first-warm poll once devices exist) recomputes every report in
`WARM_REPORTS` (all no-arg reports the dashboard/HA hit each poll). Recomputes
happen on the worker, never on main — so an endpoint request returns the cached
value over a ~1 ms IPC hop.

#### 6.4 Main-thread proxy (`analyticsClient.ts`)

`createAnalyticsClient(dbPath, log)` (process-wide singleton via
`initAnalyticsClient` / `getAnalytics`) spawns the worker via the `.mjs`
bootstrap, correlates request/response by incrementing `id`, and:

- **Timeout / retry**: `REQUEST_TIMEOUT_MS = 30_000`; one retry on a timeout that
  isn't a stop (rides out cold-worker boot warm-up).
- **Respawn**: on worker `exit`, fails all in-flight requests, clears caches, and
  respawns after `RESPAWN_DELAY_MS = 1_000`; re-pushes `lastSnapshot` on `ready`.
- **Snapshot throttle**: `store.on('change')` → `pushSnapshot()` sets a dirty
  flag; a `SNAPSHOT_PUSH_MS = 750` timer forwards the latest snapshot at most
  ~once/750 ms (analytics is mostly historical; it doesn't need every frame).
- **Coalesce + TTL cache** (`report()` only): concurrent identical calls collapse
  into one worker round-trip (`inflightReport`); a repeat within the TTL is served
  from a `structuredClone` of the cached value. Cloning preserves the semantic
  that `alertMonitor` mutates `a.annunciate` on alert objects inside report
  results, so no two consumers share a mutable ref.
  - Default TTL `ANALYTICS_REPORT_TTL_MS = 20_000`.
  - Overrides: `forecast`/`runway` = 5 s; `curtailmentAlerts`/`baselineAlerts`/
    `forecastAlerts` = 3 s (alarm path — coalescing does the heavy lifting, TTL
    staleness stays well under one 20 s alert-eval interval); `circuitHistory`/
    `totals`/`backtest` = 0 (parameterised → coalesce only, no unbounded key
    growth; HTTP-cached at the endpoint).
  - Cache key: report name + canonicalised args (sorted keys; numeric args
    `Math.trunc`'d so fractional `{days:7.1}` can't grow the map).
  - `query()`/`listMetrics()` are **not** cached (unbounded `untilMs≈now` args;
    `/api/history` HTTP-caches instead).

---

### 7. The `lastUpdated` freshness contract

`devices[sn].lastUpdated` is the "last **fresh telemetry**" clock the
`Telemetry stale` alarm keys on (`alerts.ts`, `STALE_MS = 3 min`). Two hard
rules keep it honest:

- A **failed** REST poll (`setDeviceError`) records `lastErrorAt` but does **not**
  bump `lastUpdated` — otherwise a recurring REST error with a frozen projection
  would reset the clock every ~60 s and defeat the stale safety-net (v0.97.0).
- An **untranslatable** MQTT message (`setMqttMessage` with `translated == null`,
  e.g. every SHP2 message) updates `lastMqttAt`/source and emits `'change'` but
  does **not** bump `lastUpdated` — it carries no telemetry (v1.3.0).

Only `setDeviceQuota` and `mergeDeviceQuota` (a real REST refresh or a translated
DPU MQTT delta) advance `lastUpdated`.

---

### 8. How a `/api/<report>` request resolves

Using `/api/forecast` as the canonical example:

```
HTTP GET /api/forecast
  → index.ts route handler
      cached(req, reply, await analytics.report('forecast'), 60)
                              │
        analyticsClient.report('forecast', {})
          1) TTL fresh?  → return structuredClone(cachedValue)         [no worker]
          2) in-flight?  → await the coalesced promise, then clone
          3) miss        → request({kind:'report', name:'forecast', id})
                              worker.postMessage(...)
                                 │
                  analyticsWorker on('message', {kind:'report'})
                    buildReport('forecast', ctx, {})
                       reports.ts BUILDERS.forecast(ctx)
                         = getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log)
                              reads samples via read-only recorder (readRecorder.ts)
                                 │
                    postMessage({kind:'result', id, ok:true, result})
                              │
          cache RAW value under 5s TTL; resolve promise
      → cached(): sets Cache-Control: private, max-age=60 + ETag (sha1)
                  returns 304 if If-None-Match matches, else the body
```

Two caching layers stack: the **HTTP** `cached()` helper (ETag + `max-age`, per
browser tab) and the **analyticsClient** TTL/coalesce layer (per process). Under
that, each heavy report carries its own 5–30 min internal TTL cache inside the
worker.

#### Report registry (`reports.ts`)

`BUILDERS` is the single source of truth for "what each report contains and what
it depends on." Each entry is a named async builder `(ctx, args) => result`.
Dependency chains are explicit — e.g. `runway`, `clipping`, `forecastAlerts`,
`multiDayForecast`, and `probabilisticForecast` each first `await
getDayForecast(...)` (internally cached, so the repeat calls are free). Report
names map 1:1 to `analytics.report('<name>')` calls in `index.ts`.

`{days}`-parameterised reports (`roundTripEfficiency`, `selfConsumption`,
`carbon`, `tariff`, `forecastSkill`, `multiDayForecast`) default to 7 or 3 days;
`circuitHistory`/`totals`/`backtest` take explicit args. Pure assemblers that need
no recorder (`computeConfidenceSnapshot`, `computeRepairIssues`,
`computePackRiskScores`, `computeDispatchPlan`, `buildCalendarIcs`) intentionally
stay on the **main** thread and compose these reports there.

---

### 9. Outputs & their surfaces

#### 9.1 HTTP (Fastify, `index.ts`)

`config.port` default `8787`, `config.host` default `::` (dual-stack; Node does
not set `IPV6_V6ONLY`, so IPv4 works via mapped addresses — required because
macOS resolves `.local` to IPv6). Notable endpoints:

| Endpoint | Source | Cache |
|---|---|---|
| `/api/snapshot` | `snapshotForClient()` | none |
| `/api/health`, `/api/version`, `/api/panel-info` | trivial | none |
| `/api/history?sn&metric&since&until&bucket` | `analytics.query()` | 15 s |
| `/api/summary/today` | `analytics.report('totals', …)` | 30 s |
| `/api/circuit/history?sn&(ch|pair)&days` | `analytics.report('circuitHistory')` | none (worker-cached) |
| `/api/metrics?sn` | `analytics.listMetrics(sn)` | none |
| `/api/forecast`, `/api/runway`, `/api/degradation`, … | `analytics.report(name)` | 60 s (runway 30 s) |
| `/api/ha-state` | composed multi-report | short |
| `/api/lifetime-energy`, `/api/telemetry-gaps`, `/api/debug/*` | recorder/store | varies |

`cached<T>()` computes a sha1 ETag over the JSON, sets `Cache-Control:
private, max-age=N`, and returns a `304` (via `reply.code(304).send()`) on an
`If-None-Match` hit.

#### 9.2 WebSocket `/ws`

On connect, sends the current `snapshotFrame()`; on every store `'change'`, sends
the (frame-sequence-cached) `{type:'snapshot', data: snapshotForClient()}`.
Cross-origin upgrades are rejected (`isAllowedOrigin`); missing-Origin
(same-origin / HA dashboards / curl) passes. Registered with permessage-deflate
and a 64 KiB inbound frame cap.

#### 9.3 HA MQTT discovery (`mqttDiscovery.ts`)

Opt-in (`MQTT_DISCOVERY_ENABLED=1` + `MQTT_DISCOVERY_HOST`). Connects to the HA
broker (`MQTT_DISCOVERY_PORT` default 1883, `MQTT_DISCOVERY_PREFIX` default
`homeassistant`, MQTT protocol **v5**, LWT on the availability topic). Publishes
retained discovery configs (one-time legacy-config cleanup guarded by a
`/data` dedup flag) and a single big JSON state payload to
`ecoflow_panel/state` every `PUBLISH_INTERVAL_MS = 30 s` via `publishState()`
→ `buildState(snap)` (which reuses the same analytics reports as the HTTP layer).

#### 9.4 Telnet TUI

`startTelnetServer` on `config.telnet.port` default `2323`, host `::`, enabled
unless `TELNET_ENABLED=0`. Menu-driven fleet view reading the same store +
analytics.

#### 9.5 Web UI

Built React bundle served by `@fastify/static` at `/` with SPA fallback
(`WEB_DIST_PATH`), plus Lovelace card bundles. In dev, Vite is the front-end and
proxies `/api` + `/ws` back to this process.

---

### 10. Configuration reference (`config.ts` + env)

| Key | Env var | Default | Purpose |
|---|---|---|---|
| `accessKey` | `ECOFLOW_ACCESS_KEY` | *(required, lazy)* | EcoFlow OpenAPI access key |
| `secretKey` | `ECOFLOW_SECRET_KEY` | *(required, lazy)* | EcoFlow OpenAPI secret key |
| `apiHost` | `ECOFLOW_API_HOST` | `https://api-a.ecoflow.com` | REST/MQTT sign base |
| `port` | `PORT` | `8787` | HTTP listen port |
| `host` | `HOST` | `::` | HTTP bind (dual-stack) |
| `dbPath` | `DB_PATH` | `/data/ecoflow.db` (container) | SQLite WAL DB |
| `logLevel` | `LOG_LEVEL` | `info` | Pino level; `debug`/`trace` un-gate poll-ok lines |
| `forecastLat` | `FORECAST_LAT` | `33.4484` | Solar forecast latitude (Phoenix) |
| `forecastLon` | `FORECAST_LON` | `-112.074` | Solar forecast longitude |
| `telnet.enabled` | `TELNET_ENABLED` | `true` (unless `0`) | TUI on/off |
| `telnet.host` | `TELNET_HOST` | `::` | TUI bind |
| `telnet.port` | `TELNET_PORT` | `2323` | TUI port |
| — | `POLL_INTERVAL_MS` | `60_000` | REST poll cadence |
| — | `ANALYTICS_REPORT_TTL_MS` | `20_000` | Default report cache TTL (main thread) |
| — | `SNAPSHOT_INCLUDE_RAW` | `0` | Attach raw quota to snapshots (debug) |
| — | `MQTT_BOOT_GRACE_ATTEMPTS` | `5` | MQTT retries treated as benign at warn |
| — | `MQTT_DISCOVERY_ENABLED` / `_HOST` / `_PORT` / `_USER` / `_PASS` / `_PREFIX` | off / — / `1883` / — / — / `homeassistant` | HA discovery target |
| — | `BUILD_VERSION` / `BUILD_DATE` / `BUILD_REF` | `dev`/null/null | Version stamp for `/api/version` |
| — | `ECOFLOW_TRACE_SN` | — | Env-gated MQTT topic/payload trace for one SN |
| — | `BMS_REBASELINE_SUSPECT_ROLLUPS` | `3` | Rollups before a BMS reconnect re-baseline is trusted |

**Secret handling**: `config.accessKey`/`secretKey` are lazy getters that throw
`Missing required env var: …` on **first access**, not at import — so tests and
scripts that never call the EcoFlow API can import `config.ts` safely.

---

### 11. Edge cases & guards (cross-cutting)

- **Honest-null over fabrication**: `extract()` skips non-finite values; the
  head-hold guard prevents fabricating held-power Wh across boundary-chopped
  gaps; the read worker reports persisted lifetime only (no phantom `pendingWh`).
- **Two grid quantities** are distinct series: `fleet_grid_import_wh` (DPU
  `ac_in`, grid charging DPUs) vs `fleet_grid_home_wh` (SHP2 `grid_home_w`, grid
  serving home loads directly). Not interchangeable.
- **Spare-Core exclusion**: fleet rollups (`computeTotals`, `buildContributors`)
  count only SHP2-connected DPUs; spares are recorded per-device but never dilute
  fleet PV/coverage/energy.
- **Worker respawn is transparent**: in-flight requests fail fast (callers don't
  hang on a dead worker), caches clear, `lastSnapshot` re-pushes on `ready`, and
  the first post-respawn report recomputes fresh.
- **Frame de-dup correctness**: `frameSeq` (a counter), not `generatedAt` (a
  millisecond timestamp that can collide under bursts), keys the shared WS frame.
- **Immutability contract**: `mergeDeviceQuota` mutates the raw map **in place**
  (GC win on ~1 Hz deltas); safe because `partial` is always fresh, MQTT reads
  `getRaw()` before merge, the projection is rebuilt, the WS frame is
  re-stringified per `frameSeq`, and the worker gets a `structuredClone` via
  `postMessage`. No consumer may retain a raw-map reference across merges.


---

## 2. EcoFlow Cloud Integration & Home Assistant Wiring

This cluster documents how the ecoflow-panel add-on gets telemetry out of EcoFlow's
cloud (there is **no LAN protocol** — see below), how it shapes that raw telemetry
into typed per-product `Projection`s, how it distinguishes a *cloud wedge* from a
*real outage*, how it decides which DPU cores are actually wired into the home
(SHP2 membership), how it publishes everything to Home Assistant via MQTT
auto-discovery + the Energy Dashboard, and how the (deliberately tiny) write path +
audit log work.

Source files covered: `server/src/ecoflow/{rest,sign,mqtt,mqttTranslate,project,commands}.ts`,
`server/src/snapshot.ts`, `server/src/deviceLink.ts`, `server/src/shp2Membership.ts`,
`server/src/mqttDiscovery.ts`, `server/src/haService.ts`, `server/src/writeLog.ts`,
and the endpoint handlers in `server/src/index.ts`.

> **A note on scope vs. the cluster brief.** `deviceLink.ts` is *not* an EVSE↔SHP2
> circuit mapper — it is the **cloud-wedge-vs-real-outage classifier**. EVSE has no
> dedicated device-link module; the single home EVSE is handled entirely by the
> forecast/load engines in `analytics.ts` (a residential charger tops out near
> ~11.5 kW = 48 A × 240 V), and by the generic projector. Split-phase / paired
> circuits are an **SHP2** concept, decoded in `project.ts` (`Shp2PairedCircuit`).
> This document describes what the code actually does.

---

### Table of contents (top-level sections)

- The EcoFlow IoT-Open cloud protocol (no LAN)
- REST layer and request signing
- MQTT telemetry: message shapes, cmdIds, and the `param`-not-`params` fix
- MQTT→REST translation (`mqttTranslate.ts`)
- The `SnapshotStore`: `rawBySn`, `mqttByCmd`, freshness, grace-holds
- Projections: DPU, SHP2, Generic
- SHP2 backup pool, grid presence, and coherence gating
- SHP2 membership: home cores vs. spares
- Cloud-wedge vs. real-outage classification (`deviceLink.ts`)
- Home Assistant service layer (`haService.ts`)
- HA MQTT auto-discovery entity set + Energy Dashboard
- The write-command framework + audit log + rate limits
- HTTP API surface: `/api/ha-state`, `/api/snapshot`, `/api/panel-info`, and friends
- Config knobs (env / config.yaml) reference

---

### The EcoFlow IoT-Open cloud protocol (no LAN)

#### What it does + why

EcoFlow's Delta Pro Ultra (DPU) cores and the Smart Home Panel 2 (SHP2) are
**cloud-only** devices on the public IoT-Open API. There is no documented
LAN-IP protocol for DPU/SHP2 telemetry: the only local path is reverse-engineered
BLE, which is unsuitable as an alarm source. Consequently *every* live number this
add-on shows originates from EcoFlow's cloud, reached two ways:

1. **REST polling** — `GET /iot-open/sign/device/list` + `GET
   /iot-open/sign/device/quota/all` per online device, on a fixed interval.
2. **Cloud MQTT** — a subscribe-only stream of per-device `quota`/`status` topics
   off EcoFlow's broker (URL + credentials handed out by a REST call).

Both feed one in-memory `SnapshotStore`. REST is the authoritative full snapshot;
MQTT is the low-latency delta stream (and, for the SHP2, the only near-real-time
signal — see the translation section).

Because the cloud is the sole source, a **wedged cloud session looks identical to a
dead device** from the API's `online` flag alone. The add-on's whole resilience
strategy is built around resolving that ambiguity with an *external* LAN reachability
signal (HA ping sensors), not by reflexively power-cycling — see
[Cloud-wedge vs. real-outage](#cloud-wedge-vs-real-outage-classification-devicelinkts).

#### Inputs / outputs at the protocol boundary

| Direction | Transport | Path / topic | Payload |
|---|---|---|---|
| Read device roster | REST GET | `/iot-open/sign/device/list` | `[{ sn, productName, deviceName, online }]` |
| Read full snapshot | REST GET | `/iot-open/sign/device/quota/all?sn=…` | flat `Record<string, unknown>` (REST schema) |
| Read specific keys | REST POST | `/iot-open/sign/device/quota` `{ sn, params:{ quotas } }` | subset map (fallback for devices blocking `/quota/all`) |
| Get MQTT creds | REST GET | `/iot-open/sign/certification` | `{ certificateAccount, certificatePassword, url, port, protocol }` |
| Telemetry stream | MQTT SUB | `/open/{username}/{sn}/quota` | `{ cmdId, cmdFunc, param:{…} }` (deltas) |
| Online/offline | MQTT SUB | `/open/{username}/{sn}/status` | `{ params:{ status } }` or `{ status }` |
| **Write** command | REST PUT | `/iot-open/sign/device/quota` `{ sn, …body }` | `{ cmdCode/cmdSet, cmdId, params }` |

Response envelope (`EcoFlowResponse<T>`): `{ code, message, data, eagleEyeTraceId?, tid? }`.
`code === "0"` is success; anything else throws
`EcoFlow API error <code>: <message> (trace <id>)`.

---

### REST layer and request signing

#### `ecoflow/rest.ts`

Thin client (`ecoflow` object) with `listDevices`, `getQuotaAll`, `getQuotaSpecific`,
`getMqttCertification`, and `sendCommand`. Every call funnels through `call()`, which:

- signs via `signRequest()`,
- for GET, appends a sorted query string (`buildQuery`) that **byte-matches the
  signed string**,
- for non-GET, sends `params` as a JSON body with
  `Content-Type: application/json;charset=UTF-8`,
- parses the JSON envelope and throws on non-`"0"` `code`.

`sendCommand` is the single write primitive: `PUT /iot-open/sign/device/quota` with
`{ sn, ...body }`. The same POST/PUT endpoint serves **both reads and writes** —
reads carry `params.quotas`, writes carry `cmdSet`/`cmdId`/`operateType`.

Base host default: `ECOFLOW_API_HOST` → `https://api-a.ecoflow.com`.

#### `ecoflow/sign.ts` — HMAC-SHA256 request signing

The IoT-Open signing scheme:

```
1. Flatten params: nested objects → dot keys (a.b), arrays → bracket (a[0]).
2. Sort the flattened business keys ASCII-ascending.
3. paramStr = "k1=v1&k2=v2&…"  (sorted business keys only)
4. suffix   = "accessKey=<AK>&nonce=<6-digit>&timestamp=<ms>"   (NOT sorted in)
5. toSign   = paramStr ? `${paramStr}&${suffix}` : suffix
6. sign     = HMAC_SHA256(secretKey, toSign) → lowercase hex
```

Headers returned: `{ accessKey, nonce, timestamp, sign }`. `nonce` is
`randomInt(100000, 999999)`; `timestamp` is `Date.now()` in ms.

**Security detail:** the flatten accumulator is a `Map`, not a plain object, to avoid
prototype-pollution / remote-property-injection (CodeQL `js/remote-property-injection`)
from param-derived keys such as SNs or quota names. A hostile `"__proto__"` key now
signs faithfully instead of being silently dropped (which the old plain-object
accumulator did, guaranteeing a signature mismatch). `ECOFLOW_DEBUG_SIGN=1` logs the
`toSign` string (JSON-stringified to prevent log-injection).

Credentials come from `config.accessKey`/`config.secretKey`, backed by
**lazy getters** over `ECOFLOW_ACCESS_KEY` / `ECOFLOW_SECRET_KEY` that throw on first
*access* (not import), so tests/scripts that never call the API don't need them.

---

### MQTT telemetry: message shapes, cmdIds, and the `param`-not-`params` fix

#### `ecoflow/mqtt.ts`

Startup (`startMqtt`):

1. Fetch certification (with retry) → broker URL + username/password.
2. Build a **stable** `clientId`:
   `ecoflow-panel-<sha1(accessKey)[:12]>`. Stability matters because **EcoFlow caps
   unique client IDs at ~10/day per account** — a random ID per restart would exhaust
   the quota.
3. Connect with `mqtt.connect(url, { protocolVersion: 5, clean: true,
   reconnectPeriod: 5000, keepalive: 30, rejectUnauthorized: true })`.

**Cert fetch retry** (`getMqttCertificationWithRetry`): backoff `2s, 4s, 8s, 16s, 30s`;
only retried when `isTransientNetworkError()` matches (`EAI_AGAIN`, `ENOTFOUND`,
`ECONNREFUSED`, `ETIMEDOUT`, `timeout`, `connect timeout`, `fetch failed`). This is
the same classifier the process guard uses as its survive/fatal gate, so it was
deliberately narrowed — the bare `network` token was dropped because it matched
"neural network training failed"-style strings.

#### Subscription model

EcoFlow's ACL **rejects wildcard subscribes** (`+/quota`), so the client subscribes
**per-SN**: `[/open/{username}/{sn}/quota, /open/{username}/{sn}/status]` at QoS 0.
It subscribes to every SN currently in the store on `connect`, and re-subscribes
whenever the store emits `change` (new devices appearing). A `subscribed` `Set`
coalesces bursts and rolls back on subscribe error.

The `/get_reply` request-reply topic is **not** authorized by this API, so **active
polling of silent devices is impossible over MQTT** — Delta 3 Plus, River 3 Plus,
PowerInsight, EVSE, and Smart Generators are app-only and simply never appear on the
MQTT bus (they show as `API-online/no-MQTT` in the fleet-status log dump).

#### The message shape and the `param`-not-`params` fix

The **real** EcoFlow MQTT quota message (discovered via trace, 2026-05) is:

```json
{ "cmdId": <number>, "cmdFunc": <number>, "param": { … } }
```

Note the **singular `param`**, which differs from REST and from some older/other
firmwares that use plural `params` or wrap under `data`. The parser accepts *all*
shapes in priority order:

```
param  ??  params  ??  data.param  ??  data.params
```

The `param` payload uses a **different field schema** from REST `/quota/all`
(e.g. `bpInfo[].bpSoc` vs. `hs_yj751_bms_slave_addr.{N}.soc`), so MQTT data is stored
in a **parallel cache** (`mqttByCmd` / `mqttFlatBySn`) and only merged into the
REST-schema raw cache when a translator exists (DPU only — see next section).

`status` messages set device online/offline via `store.setDeviceOnline(sn, status === 1)`.

#### DPU cmdId map (as reverse-engineered)

| cmdId | Meaning |
|---|---|
| 1 | appshow snapshot (top-level summary) |
| 2 | backend snapshot (PCS / MPPT / AC-out detail) |
| 4 | `bpInfo[]` per-pack incremental (`bp*` schema) |
| 21 | single field `powGetPvH` (alias for `inHvMpptPwr`) |
| 28 | per-pack BMS detail (identified by `packSn` lookup) |

**Trace env knobs:** `ECOFLOW_TRACE_SN` (log one SN's topics+payloads),
`ECOFLOW_TRACE_FILE` (append full messages to a file), `ECOFLOW_TRACE_TOPICS=1`
(print each unique topic shape once).

**Log-storm coalescing:** reconnect/close/error lines are coalesced
(`makeLogCoalescer`) so a DNS brownout that drives a tight reconnect loop (one logged
incident produced 514 duplicate lines / 66 min) does not spam the log; the first of
each distinct line is kept, and `connect` flushes the suppressed tail for a clean
recovery transition. Errors coalesce at **warn** level so a `level>=40` scan surfaces
them; reconnect/close stay at info.

---

### MQTT→REST translation (`ecoflow/mqttTranslate.ts`)

`translateDpuMqtt(cmdId, param, currentRaw)` maps a DPU MQTT `param` onto REST-schema
keys so it can merge into the same `rawBySn` map the projectors read:

- **cmdId 1** → prefix every key with `hs_yj751_pd_appshow_addr.`
- **cmdId 2** → prefix with `hs_yj751_pd_backend_addr.`
- **cmdId 21** → `{ 'hs_yj751_pd_appshow_addr.inHvMpptPwr': powGetPvH }`
- **cmdId 28** → look up which slot (`1..5`) has a matching
  `hs_yj751_bms_slave_addr.{i}.packSn === param.packSn`, then prefix into that slot.
- **cmdId 4** → per `bpInfo[]` element keyed by `bpNo`, emit
  `hs_yj751_bms_slave_addr.{bpNo}.{soc,temp,remainTime,errCode,inputWatts,outputWatts}`.

**Sign convention for `bpPwr` (validated live, v0.15.12):** NEGATIVE `bpPwr` =
discharging (out), positive = charging (in). Translated to REST's two-field shape:

```
bpPwr <= 0 : outputWatts = |bpPwr| (abs, so −0 → 0), inputWatts = 0
bpPwr  > 0 : inputWatts  =  bpPwr,                    outputWatts = 0
```

The original mapping was inverted (inferred from a charging-only trace); the fix stops
`fleet_battery_net_watts` from flapping sign against cmdId-28/REST writes and
violating power conservation by ~4 kW.

**Only DPUs are translated.** In `mqtt.ts`, `translateDpuMqtt` is called only when
`productName.includes('delta pro ultra')`; for everything else (crucially the SHP2)
`translatedRest` is `null`. This has a safety consequence — see the freshness clock
below.

---

### The `SnapshotStore` (`snapshot.ts`)

`SnapshotStore extends EventEmitter` is the single in-memory hub. Key state:

| Field | Purpose |
|---|---|
| `snap: FleetSnapshot` | `{ generatedAt, devices: Record<sn, DeviceSnapshot>, alerts?, grid?, off_grid? }` — mutated in place (stable ref) |
| `rawBySn` | REST-schema raw quota per SN (mutated in place on merge) |
| `mqttByCmd` | per-SN `Map<cmdId, param>` (for `/api/debug/raw`) |
| `mqttFlatBySn` | flat union of all MQTT fields seen per SN |
| `lastSourceBySn` | `'rest' | 'mqtt'` |
| `lastMqttAtBySn`, `mqttMsgCountBySn` | per-SN MQTT liveness |
| `lastDeviceListAttemptAt` / `…SuccessAt` | distinguishes "cloud session stale" from "device genuinely offline" |
| `frameSeq` | monotonic counter bumped on every `change` emit; lets the WS layer serialize the 50–150 KB snapshot frame **once** per emit and reuse the bytes across clients |

#### `DeviceSnapshot` shape

```ts
{ sn, deviceName, productName, online, lastUpdated, lastError?, lastErrorAt?,
  projection?, raw? /* only if SNAPSHOT_INCLUDE_RAW=1 */, grid?, off_grid? }
```

`lastUpdated` = ms epoch of **last SUCCESSFUL fresh telemetry**. The `Telemetry stale`
alarm keys on this (`STALE_MS = 3 min` in `alerts.ts`), so several guards protect it:

- **A failed REST poll does NOT bump `lastUpdated`** (v0.97.0). `setDeviceError` records
  `lastErrorAt` separately. Otherwise a recurring REST error (device still listed
  online, projection frozen) would reset the clock every ~60 s and defeat the stale
  safety-net forever.
- **An untranslatable MQTT message does NOT bump `lastUpdated`** (v1.3.0). Because the
  SHP2 is never translated, its healthy ~9 msg/min stream would otherwise perpetually
  reset the freshness clock — masking a frozen SHP2 projection if the REST poll began
  failing. Untranslatable messages still update `lastMqttAt`/`source` and emit a
  `change` (so the WS/UI see the new liveness), but the stale clock is untouched.

#### Data ingest paths

- `setDeviceList(devices)` — updates roster + `online`, resolves display name
  (`resolveDeviceName`: cloud name unless it's blank or equals the SN → productName →
  SN), sanitizes it (`sanitizeDisplayName`, 48 chars, strips ESC/control bytes), logs
  online↔offline transitions.
- `setDeviceQuota(sn, raw, source)` — REST full replace; re-projects via
  `projectByProduct`, applies grace-holds + onset trackers, bumps `lastUpdated`.
- `mergeDeviceQuota(sn, partial, source)` — merges a delta **in place**
  (`Object.assign` — avoids re-allocating the large pack/cell arrays on every ~1 Hz
  MQTT delta); re-projects. Documented **immutability contract**: no consumer may
  retain the raw map across merges.
- `setMqttMessage(sn, cmdId, param, translatedRest?)` — stores raw MQTT; if a
  translation exists, routes through `mergeDeviceQuota` (which handles emit); else
  emits without touching `lastUpdated`.

#### Poll loop (`startPollLoop`)

`refreshAll()` = `markDeviceListAttempt()` → `listDevices()` → `setDeviceList()` →
`getQuotaAll()` for each **online** device (in parallel; per-device errors captured via
`setDeviceError`). Routine "poll ok" lines are demoted to debug; only **recovery**
(failure→ok) and **slow** (`>= SLOW_POLL_MS = 5000`) polls stay at INFO; a failed poll
logs at **warn**. Every 10 min a bounded **fleet-status** line dumps per-SN
`ON/<count>msg/<age>s` (or `OFF` / `API-online/no-MQTT`).

---

### Projections (`ecoflow/project.ts`)

`projectByProduct(productName, quota)` dispatches on the product name:

- `…includes('delta pro ultra')` → `projectDpu` (`kind: 'dpu'`)
- `…includes('smart home panel')` → `projectShp2` (`kind: 'shp2'`)
- otherwise → `projectGeneric` (`kind: 'generic'`; D3+, R3+, EVSE, WAVE, generators)

Two helpers guard field reads: `num(q,k)` (finite-number-or-null) and `str(q,k)`.

#### DPU projection (`projectDpu`)

Reads the `hs_yj751_*` register families. Up to **5 packs** (`hs_yj751_bms_slave_addr.{1..5}.*`),
each a `DpuPack` (32S1P; per-cell mV sum to `packVoltageMv`; Wh ≈ mAh × 0.1024).
Notable per-pack fields: `soc/soh/actSoh`, `inputWatts/outputWatts`, `temp/cycles`,
`packSn`, capacities (`designCap/fullCap/remainCap/accuChgCap/accuDsgCap`), thermal
arrays (`cellTemp[7]`, `mosTemp[4]`, `ptcTemp[4]`), voltage arrays (`cellVol[32]`),
`balanceState`, `ocv` (65535 sentinel → null).

Top-level: `soc`, `packCount` (`bpNum`), PV high/low (watts/volts/amps/errcodes),
`acInWatts` = `inAc5p8Pwr + inAcC20Pwr`, `acOutWatts`, `totalInWatts`/`totalOutWatts`
(`wattsInSum`/`wattsOutSum`), split-phase legs (`outAcL{11,12,14,21,22}Pwr`),
`sysErrCode`, EMS limits, `chgMaxSoc`/`dsgMinSoc`.

**`deriveWholeUnitBatAmp`** (v0.33.0): the raw `batAmp` register under-reads by ~4–7×,
so whole-unit DC current is derived from per-pack power:
`batAmp = (Σ inputWatts − Σ outputWatts) / batVol` (charging positive), falling back to
the raw register only when pack power or `batVol` is unavailable. This is the series the
internal-resistance model reads.

#### SHP2 projection (`projectShp2`)

The SHP2 is the home's grid interconnect and owner of the backup pool.

**Circuits (1..12):** each `Shp2Circuit` reads live watts from `loadInfo.hall1Watt[i-1]`,
name/`setAmp` from `loadIncreInfo.hall1IncreInfo.ch{i}Info.*`, split-phase link from
`pd303_mc.loadIncreInfo.hall1IncreInfo.ch{i}Info.splitphase.{linkCh,linkMark}`, and
priority/enable from `pd303_mc.LoadStrategyCfg.hall1ChInfo[i-1]`.

**Paired circuits (`Shp2PairedCircuit`):** double-pole 240 V loads are grouped —
primary = smaller channel (carries name + breaker rating), watts = sum of both legs.
> SHP2 native `loadPriority` is **ASCENDING = most-protected** (highest number sheds
> FIRST; e.g. Pool Pump = 25, a subpanel = 1). This is the **opposite polarity** of
> `loadShedRegistry.ts`'s internal convention (priority 1 = shed-first). They are
> different systems — do not unify them.

**Energy sources / slots (1..3):** each `Shp2EnergySource` reads
`pd303_mc.backupIncreInfo.Energy{i}Info.*`: `devInfo.modelInfo.sn`,
`batteryPercentage`, `isConnect`, `isAcOpen`, `devInfo.fullCap`, `devInfo.ratePower`,
`emsBatTemp`, `hwConnect`, `errorCodeNum`. The `sn` here is the Core↔SHP2 connector
mapping — **positional to slot but the SN is read from the slot's own `devInfo`, not
inferred from position**; spares never appear.

**Strategy (`projectShp2Strategy`):** load-shed enable/config, `midPriorityChDischargeLow`,
`backupMode`/`overloadMode`/`smartBackupMode`, `backupReserveSoc` (**flat
`backupReserveSoc` key only** — the same field the floor alarm defends with; do not
re-point it at a `pd303_mc.*` variant without changing the alarm), `backupReserveEnable`,
`solarBackupReserveSoc`, and a decoded `timeTask` charge schedule.

**`decodeTimeScale`:** the `timeScale.sta` bitmap is an array of base64 bytes, MSB-first,
18 bytes × 8 bits = 144 slots → 10-minute resolution, decoded into contiguous active
`{startMinute, endMinute}` windows.

#### Backup pool + grid presence

`backupBatPercent / backupFullCapWh / backupRemainWh` come from
`backupIncreInfo.{backupBatPer, backupFullCap, backupDischargeRmainBatCap}` — the SHP2's
**own aggregate** fields (NOT summed from per-slot data). This is why a cloud-offline DPU
does not over/under-count the pool, and why a stale slot is **not** subtracted (that
would falsely lower reserve % and false-escalate the floor alarm).

The trio is gated for coherence before publish:

**`coherentBackupPool(pct, fullCapWh, remainWh)`** (v0.54.4): requires the full trio +
`fullCapWh > 0`; checks `|pct − remain/full×100| ≤ BACKUP_POOL_COHERENCE_SLACK_PCT (=5)`.
Incoherent (or incomplete) → **all-null (unknown)**; every consumer (SoC alarm, reserve
alert, runway, MQTT, recorder, TUI) treats null as "no data" and self-heals. This
suppressed the 2026-06-21 `50→2%` false SoC-alarm cascade off a transient `0.0%` member.

**Grid presence** (`pd303_mc.masterIncreInfo.gridSta`):

| `gridSta` | Meaning | `gridConnected` (alarm-facing) |
|---|---|---|
| 0 | grid volt. not detected (islanded) | `false` |
| 1 | Grid OK | `true` |
| 2 | grid energized but over-volt/over-freq → SHP2 islands onto EPS | `false` |
| null | field absent / older firmware | `null` (never fabricate) |

`gridConnected` is **VALUE-1-ONLY**: true iff `gridSta === 1`. Unlike `gridWatt`
(`wattInfo.gridWatt`, which reads 0 in the gaps between the SHP2's ~8 kW charge bursts),
`gridSta` is the master controller's live line-sensing flag — present even when not
momentarily drawing. It feeds `gridState.computeShp2GridConnected` as an additive,
online-gated backstop.

#### Grace-hold + slew guard (`backupPoolWithGraceHold`)

Applied in `snapshot.ts::applyBackupPoolGraceHold` after every ingest, mutating the
projection in place so **every** consumer sees one consistent value.

- **Live coherent** → publish live, refresh the hold anchor.
- **Live incoherent, hold within window** → publish HELD (anchor `atMs` NOT advanced,
  so the window keeps closing — a sustained outage can't hold forever).
- **Live incoherent, hold absent/expired** → publish null (gauge → unknown).

`BACKUP_POOL_GRACE_HOLD_MS` default **180000 (3 min)** — longer than a reconnect blip
(which happens ~10–15×/day), shorter than a real outage, and **must stay below the SoC
alarm's `SLEW_BASELINE_MAX_AGE_MS` (10 min)**.

A second guard rejects a **coherent-but-implausible** single-tick SoC slew from a fresh
held baseline (`BACKUP_POOL_SLEW_MAX_AGE_MS = 10 min`):
`BACKUP_POOL_MAX_SLEW_PCT` (env `BATTERY_SOC_MAX_DROP_PCT`, default **25**) on the
~92 kWh pool is physically impossible in one poll. **Asymmetric gating:** a DROP is
rejected only from a HEALTHY baseline (`>= 30%`) — never mask a low near the danger zone;
a RISE is rejected **regardless** of baseline health (holding the lower value can only
over-alarm, never mask a low). The rise-gate specifically stops a stale-HIGH replay from
becoming the "healthy" baseline that then arms the drop-guard to mask every subsequent
real low.

`snapshot.ts` also tracks `backupPoolUnknownSince` (onset of a published-null pool, for
the reserve-blind compensating alert), `dpuErrOnset` (per-DPU `sysErrCode` onset,
re-baselined on code change/clear — debounces the "Inverter error code" CRITICAL through
20–160 s reconnect blips), and `shp2SrcErrOnsets` (per-slot `errorCodeNum` onset).

---

### SHP2 membership: home cores vs. spares (`shp2Membership.ts`)

The operator's fleet has **5 DPU cores on the account but only 3 wired into the home
SHP2**; Cores 4 & 5 are bench spares that report telemetry but cannot deliver energy to
the home bus. Every fleet aggregation must exclude spares.

- **`shp2ConnectedDpuSns(devices)`** → `Set<sn>` of connected sources = the SHP2's
  `sources[]` filtered on `isConnected && sn`. Empty when no SHP2 is present.
- **`isShp2Connected(sn, connected)`** → **fallback semantics**: when `connected` is
  empty (no SHP2 observed / DPU-only setup) returns **true for every SN** (so a
  no-SHP2 user's tiles aren't zeroed). Otherwise membership is exact.
- **`SPARE_DPU_SNS`** = explicit allowlist:
  `Y711ZABA9H3T0489` (Core 4), `Y711ZAB59G9P0090` (Core 5). This is the **safety
  floor**: a home core (1/2/3) can never be in this set, so it can never have its real
  offline alarm muted, even if it faults out of the SHP2's `isConnected` list. A spare's
  offline state is the *expected* steady state → its connectivity alert is
  non-annunciating.
- **`isExpectedOfflineSpare(sn, …)`** = `SPARE_DPU_SNS.has(sn) && !connected.has(sn)` —
  the `!has` re-arms a spare the instant it's wired into an SHP2 and reports as a
  connected source.
- **`isSourceDpuStale(source, devices)`** (observability only): a connected slot whose
  underlying DPU is itself cloud-offline. Surfaced as `dpuStale` on the source (set by
  `snapshotForClient`); does **not** change backup-pool capacity or the floor alarm.
- **`homeCoreCoverage(devices)`** → `{ connected, reporting, complete }`. Roster = SHP2
  connected sources, or (fallback) every non-spare DPU. `complete` = all roster cores
  reporting. Core principle: *we can PROVE discharge from a partial sum; we can never
  DISPROVE it.* An empty roster means no home cores exist at all → `complete` is vacuously
  true.
- **`homeFleetMeanSoc(devices)`** — reserve-alarm SHP2-blind fallback: mean SoC of home
  cores still reporting (spares + offline cores excluded). Used when the SHP2 nulls
  `backupBatPercent` while cloud-offline, so the audible reserve ladder keeps firing on
  the right side of a real depletion. Null when no home core reports.
- **`aggregateFleetFlow(devices)`** — the shared power-flow aggregate consumed by both
  `/api/ha-state` and MQTT `buildState` (previously two byte-identical loops). Sums
  `pvTotalWatts/totalInWatts/totalOutWatts/acInWatts` and per-pack net
  (`Σ outputWatts − inputWatts`) over **online, SHP2-connected** DPUs; `panelLoad` =
  Σ SHP2 circuit watts. Returns raw un-rounded sums (each caller rounds at emission;
  the raw `fleetBatteryNet` feeds the ±50 W charge/discharge timer gates). Guarded with
  `?? []` on `sources`/`packs`/`circuits` so a partial projection can't throw.

Roster reference (from memory / topic files): Core 1/2/3 home =
`GBC0314…`/`GBC0482…`/`J234000…`; Core 4/5 spares as above.

---

### Cloud-wedge vs. real-outage classification (`deviceLink.ts`)

#### What it does + why

The cloud's per-device `online` flag can't distinguish two very different failure modes:

- **CLOUD WEDGE** — device alive on the LAN, but its EcoFlow cloud session / MQTT pipe
  wedged (a core can sit cloud-offline >25 h with a perfectly fine LAN). Telemetry
  resumes on its own; a reflexive power-cycle just papers over the cloud-side stall.
- **REAL OUTAGE** — device genuinely gone (no power, tripped breaker, dead WiFi). *This*
  is the case a power-cycle / breaker / WiFi check actually addresses.

The reachability signal comes from **Home Assistant**, not raw ICMP (the add-on adds no
container capabilities). The operator configures one HA `ping` `binary_sensor`
(device_class connectivity) per device IP and maps SN→entity via
`ECOFLOW_DEVICE_REACHABILITY` (JSON). This feature is **purely additive diagnostics** —
it never changes whether an alarm fires, its severity, id, or spare-gating; when unset it
is fully dormant.

#### The pure classifier

```
classifyDeviceLink(cloudOnline, reachable):
  cloudOnline=true                       → 'online'        (reachability irrelevant)
  false, reachable='up'                  → 'cloud_wedge'
  false, reachable='down'                → 'real_outage'
  false, reachable='unknown'             → 'unknown'
```

- `deviceReachabilityEntities()` parses `ECOFLOW_DEVICE_REACHABILITY`; tolerant
  (malformed/empty/non-object → `{}`); only accepts well-formed entity IDs matching
  `^[a-z0-9_]+\.[a-z0-9_]+$` (defense-in-depth vs. injection).
- `interpretReachabilityState(state)` maps HA states → `up`/`down`/`unknown`
  (`on/home/connected/true/…` → up; `off/not_home/…` → down;
  `unavailable/unknown/none/''` → unknown).
- **Staleness guard:** `getDeviceReachability` decays a reading older than
  `REACHABILITY_MAX_AGE_MS` (default **150000 ≈ 5× the 30 s poll**) to `unknown` — a
  frozen HA read must never replay a stale `up`/`down` that could misclassify.
- `countCloudWedges(devices, reachableOf?)` — the value behind the
  `ecoflow_cloud_wedge_count` diagnostic sensor; 0 when unconfigured.

The broader root-cause context: "WiFi loss" is usually **not** radio — it's cloud
session/MQTT wedge + DNS `EAI_AGAIN` from router power-cycling; the fix is LAN ping per
DPU, not reflexive reboots. The write path's `refreshShp2CloudPresence` (below) is the
add-on's *only* remediation lever, and it's a no-op cloud round-trip, not a reboot.

---

### Home Assistant service layer (`haService.ts`)

When running under HA Supervisor, `SUPERVISOR_TOKEN` grants access to Core's REST API at
`http://supervisor/core/api`. `isSupervised()` gates every call; outside Supervisor
each returns `{ ok:false, error }` (no crash).

Key helpers:

- `callHaService(domain, service, data)` — POST `/services/…`; surfaces HA's JSON
  `message` on non-2xx. Timeouts are tuned per service: Music Assistant
  `play_announcement` gets **75 s headers / 120 s body** (a long repeated klaxon WAV to
  slow ecobee speakers); everything else **5 s / 10 s**.
- `getEntityState(entityId, opts?)` — GET `/states/<encoded id>` (id is
  `encodeURIComponent`-encoded; operator-supplied). This is how the main loop reads the
  ping/grid-presence sensors each cycle.
- `getServiceCatalog()` / `hasService()` / `probeService()` — the last is 3-state
  (`present`/`absent`/`unknown`) so a boot-time catalog-fetch failure isn't read as
  "service genuinely absent".
- `getAllStates()` — enumerate every entity (broadcast target discovery + grid-presence
  refresh; bounded 4 s/8 s so a wedged Supervisor can't stall the alert loop).
- `ttsGetUrl(...)` — render TTS to a URL (locale-separator fallback chain on HTTP 500).
- Supervisor add-on API + Core config-flow helpers (`listAddons`, `listConfigEntries`,
  `startConfigFlow`, `submitConfigFlow`, `deleteConfigEntry`) — used by the Piper/Wyoming
  broadcast setup endpoints.

(Detailed broadcast/TTS behavior belongs to the audible-alert cluster; here the relevant
point is that HA integration is via the **Supervisor Core proxy**, token-gated, and that
`getEntityState`/`getAllStates` are the read path feeding grid-presence and
device-reachability.)

---

### HA MQTT auto-discovery entity set + Energy Dashboard (`mqttDiscovery.ts`)

#### What it does + why

A **separate** MQTT client publishes HA-native auto-discovery configs to the user's HA
broker (e.g. `core-mosquitto`), so every metric appears under one **"EcoFlow Panel"**
device without any `configuration.yaml` editing. This is distinct from the EcoFlow cloud
MQTT client in `mqtt.ts`.

**Enable:** `MQTT_DISCOVERY_ENABLED=1` (or `true`) **and** `MQTT_DISCOVERY_HOST` set.
Off by default.

#### Topic scheme

```
<prefix>/sensor/<unique_id>/config          (retained entity definition)
<prefix>/binary_sensor/<unique_id>/config   (retained)
<prefix>/switch/<unique_id>/config          (retained; alarm-priority toggles)
ecoflow_panel/state                         (one big retained JSON state payload)
ecoflow_panel/availability                  (online/offline; LWT = offline)
```

`prefix` = `MQTT_DISCOVERY_PREFIX` (default `homeassistant`). Every sensor's
`value_template` extracts its field from the single `ecoflow_panel/state` payload, so
**one state publish refreshes every entity at once**. State is published every
`PUBLISH_INTERVAL_MS = 30 s`. Connection defaults: port `MQTT_DISCOVERY_PORT` (1883),
`MQTT_DISCOVERY_USER`/`PASS`, `protocolVersion: 5`, `reconnectPeriod: 30 s`, LWT retains
`offline`.

#### Availability + expiry

- `AVAILABILITY_TOPIC` is republished `online` on **every** `connect` and on **every**
  state cycle (v1.14.1) — a broker-side LWT `offline` must be overwritten on reconnect or
  HA holds all ~87 entities unavailable until an add-on restart.
- `EXPIRE_AFTER_S = 120` (≈4× publish interval) is applied to **live-measurement**
  sensors only — **never** to `total_increasing` lifetime/energy sensors (an expiring
  long-term-statistics source would gap the HA Energy dashboard).

#### Entity categories

`SENSORS[]` (~50) and `BINARY_SENSORS[]` (~9). Selected groups:

- **Power flow:** `fleet_pv_watts`, `panel_load_watts`, `ac_import_watts`,
  `fleet_battery_net_watts`, `grid_home_watts` (SHP2 `gridWatt`).
- **Backup pool:** `backup_pool` (%), `backup_remaining_kwh`, `backup_full_capacity_kwh`
  (both `energy_storage`).
- **Forecast/degradation/runway/RTE/clipping/curtailment/self-consumption** — one sensor
  each, mostly `measurement` (no `device_class energy` on rolling kWh that can go down).
- **Alert counts** — `alert_critical_count`, `alert_warning_count`,
  `learned_warning_count`, plus per-ISA-priority `alert_{high,medium,low}_count`.
- **Diagnostics** (`entity_category: 'diagnostic'`): `ecoflow_cloud_wedge_count`,
  `system_outage_24h` + count/minutes + `system_power_outage_count_24h` /
  `system_telemetry_gap_count_24h`, `audible_channel_status` /
  `audible_speakers_reachable`, `shp2_grid_sta`, `backup_reserve_percent`,
  `solar_backup_reserve_percent`, `backup_reserve_enabled`, and the raw SHP2 mode-code
  sensors (`smart_backup_mode_code` / `backup_mode_code` / `overload_mode_code` — exposed
  as **honest integers**, no fabricated labels).
- **Binary sensors:** `off_grid`, `shp2_grid_connected`,
  `runway_projection_islanded_only`, `projected_low_soc_islanded_only`,
  `pv_curtailment_active`, `load_shed_recommended`,
  `self_consumption_coverage_partial`, `forecast_basis_incomplete`.

**Honest-null discipline:** numeric-null fields emit `null` → HA renders `unknown`
(never substituted with 0). `backup_reserve_enabled` uses
`{{ "unknown" if … is none else … }}` so a cloud-offline SHP2 never reads a fabricated
"reserve OFF". `off_grid` deliberately carries **no** `device_class connectivity` (that
class means ON=connected, which would invert the meaning).

#### Energy Dashboard (`total_increasing` counters)

Monotonic lifetime kWh counters HA accumulates into long-term statistics:
`pv_lifetime_kwh`, `load_lifetime_kwh`, `grid_import_lifetime_kwh` (DPU `ac_in` — grid
that *charged the batteries*; a **diagnostic** sub-metric, near-zero on a solar home),
`grid_to_home_lifetime_kwh` (SHP2-main `gridWatt` — the **true** whole-home grid import,
the sensor to wire into HA Energy → Grid consumption), `battery_charge_lifetime_kwh`,
`battery_discharge_lifetime_kwh`, plus per-circuit `carbon`/`tariff` sensors.

**Per-SHP2-circuit Energy sensors** are published dynamically (`planCircuitDiscovery` /
`publishCircuitDiscovery`) driven by the recurring `publishState()` loop — NOT the
one-shot connect path — because the circuit list only exists after the first REST poll,
which can land *after* broker connect. `circuitLifetimeFields` emits a
`circuit_<ch>_lifetime_kwh` key for the **union** of live circuits + persisted
accumulator keys (so no discovered sensor references a missing `value_json` key, which
would spam HA template warnings), and emits **null (not 0)** when the accumulator isn't
ready (a 0 on a `total_increasing` sensor reads as a spurious reset).

#### Alarm-priority switches (bidirectional)

Each ISA priority gets a `switch` entity
(`ecoflow_alarms_<p>_<isa>` / unique_id `ecoflow_alerts_<p>`) with dedicated state/command
topics (`ecoflow_panel/alerts/<p>/{state,set}`). HA toggling → `parseAlertSwitchCommand`
(pure, side-effect-free; unknown payload = no-op, never guesses a default that could
silence an alarm) → `updateAlertSettings(...,'mqtt')` → echo the resolved state to the
**state** topic (never the command topic → no feedback loop). Changes originating in the
web UI republish all switch states via `onAlertSettingsChange`.

#### Legacy dedup

`MQTT_DISCOVERY_DEDUP_VERSION = 1`: on first startup, publish an empty retained payload
to every legacy `ecoflow_panel_<uid>` double-prefixed config topic (HA treats empty
retained config as "entity removed"). Gated by a marker file (`DATA_DIR` or `/data`,
TOCTOU-hardened read-probe + `wx` exclusive write).

#### The state payload (`buildState`)

Assembled from `aggregateFleetFlow(devices)` + the analytics worker's cached reports
(`forecast`, `degradation`, `runway`, `roundTripEfficiency`, `clipping`,
`selfConsumption`, `carbon`, `tariff`, `curtailment`), `recorder.getLifetimeTotals()`,
lighting posture, `liveGridBackstop`, `countCloudWedges`, `systemOutageFields`, and
broadcast health. It is **byte-aligned with `/api/ha-state`** for the shared fields
(same `aggregateFleetFlow`, same rounding, same forecast display basis).

---

### The write-command framework + audit log + rate limits (`ecoflow/commands.ts`, `writeLog.ts`)

#### Design posture

Writes are **deliberately minimal**. Empirical probing (v0.9.10) confirmed **SHP2 reboot
is not in the public IoT API** (`PD303_REBOOT`/`PD303_APP_REBOOT`/`PD303_SYS_REBOOT` and
DPU-style shapes all return error 8524 "invalid parameter"; reboot only exists via the
mobile app's private MQTT protobuf channel, `cmdFunc=12`).

#### `refreshShp2CloudPresence` — the one real write

A documented **no-op**: re-send the current `backupReserveSoc` back to the SHP2
(`{ cmdCode: 'PD303_APP_SET', params: { backupReserveSoc } }`). No state changes, but the
round-trip forces EcoFlow's cloud to refresh the device's presence — the actual fix for
the "cloud says offline, LAN says online" wedge.

- **Rate limit:** `REFRESH_COOLDOWN_MS = 30 s` per (action, sn); returns
  `rate-limited` + remaining ms when hot.
- **Sanity bound:** `backupReserveSoc` must be an integer in **[10, 50]** or the write is
  refused (`no-reserve-soc`) rather than pushing a garbage value.
- Endpoint: **`POST /api/device/refresh-cloud/:sn`** (`preHandler: requireWriteAuth`).
  404 unknown sn; 409 `no-snapshot` when no current reserve is available; 429 rate-limited;
  502 other failure. Cooldown readable at `GET /api/device/refresh-cloud-cooldown?sn=…`.

#### `debugSendCommand` — arbitrary command (admin, off by default)

Gated by `WRITE_DEBUG_TOKEN` (constant-time compare via `timingSafeEqual`, with a
fixed-shape scratch compare for unequal lengths to avoid length-timing leaks). Endpoint
**`POST /api/device/send-command`** (`requireWriteAuth` + `x-write-debug-token` header)
applies layered guards before forwarding:

- **cmdSet allow-list:** `PD303_APP_SET` (SHP2), `WN511_PORTABLE_*`, `WN511_BLE_FUNC_*`
  (DPU prefixes). Rejections are audit-logged.
- **`params` shape guard:** max depth 5, max 100 keys, max 1 KB serialized, must be a
  plain object.
- **Per-SN cooldown:** `SEND_CMD_COOLDOWN_MS` (default 30 s) → 429.

#### Audit log (`writeLog.ts`)

Every write (success or failure) appends one JSON-Lines row to `writes.log`
(`WRITE_LOG_PATH` env, else sibling of the DB):

```
{ ts, action, sn, params, source:{ip,ua}, outcome, code, message, durationMs }
```

`runCommand` records timing and parses `EcoFlow API error <code>: <message>` into
`{code, message}`. The path is a fixed constant (never request-influenced); content is
re-serialized through `sanitizeWriteLogEntry` (finite numbers, control-stripped,
length-bounded strings) to defeat log/file-access injection. A logging failure never
fails the underlying write. `tailWriteLog(limit)` reads at most the last 256 KB (newest
first); surfaced at **`GET /api/writes/log`**.

---

### HTTP API surface

| Endpoint | Method | Auth | Returns |
|---|---|---|---|
| `/api/snapshot` | GET | none (read-only) | `snapshotForClient()` — full `FleetSnapshot` + grid/off_grid, with each SHP2 source annotated `dpuStale` |
| `/api/ha-state` | GET | none | flat HA-facing payload (power flow, backup pool, forecast, degradation, alerts, runway, RTE, clipping, curtailment, self-consumption, lifetime) |
| `/api/panel-info` | GET | none | `{ writeAuthRequired:true, sameOriginOk:true, ingressOk:true, tokenHeader:'X-Panel-Write-Token', tokenPath }` |
| `/api/debug/raw?sn=` | GET | none | `{ sn, raw, mqtt (by cmdId), mqttFlat, source, lastMqttAt, mqttMsgCount }` |
| `/api/debug/mqtt-summary` | GET | none | per-SN msg counts + cmdIds seen |
| `/api/version` | GET | none | `{ version, builtAt, ref }` (build-time env) |
| `/api/device/refresh-cloud/:sn` | POST | write | no-op cloud-presence refresh |
| `/api/device/refresh-cloud-cooldown?sn=` | GET | none | cooldown state |
| `/api/device/send-command` | POST | write + debug token | arbitrary allow-listed command |
| `/api/writes/log` | GET | — | tail of the audit log |

#### `snapshotForClient()`

Wraps `store.get()` with the live grid backstop (`liveGridBackstop(devices)` → `grid`,
`off_grid = !grid.present`), and **immutably** enriches the SHP2 device: shallow-copies
the devices map + SHP2 device, attaches `grid`/`off_grid`, and maps each source to add
`dpuStale`. The immutability is load-bearing — `/api/ha-state` and the broadcast path
read raw `store.get()` and must stay byte-identical.

#### `/api/ha-state` (selected fields)

Power flow from `aggregateFleetFlow` (rounded): `fleet_pv_watts`,
`fleet_total_in_watts`, `fleet_total_out_watts`, `fleet_battery_net_watts` (positive =
discharging), `panel_load_watts`, `ac_import_watts`, `off_grid` (via `liveGridBackstop`,
**not** `acIn < 5` — DPU `ac_in` is structurally ~0 on a solar home). Backup:
`backup_pool_percent`, `backup_reserve_percent`, `backup_full_capacity_kwh`,
`backup_remaining_kwh`, and `backup_charge_minutes`/`backup_discharge_minutes` gated on
the ±50 W deadband (both timers are always reported by the SHP2 regardless of direction).
Then forecast, degradation, alert counts (split by engine source × severity), runway,
RTE, clipping, curtailment, and self-consumption blocks. Internally the analytics reports
are cached (~30 min) on the worker.

---

### Config knobs reference

#### EcoFlow cloud / auth

| Key | Default | Effect |
|---|---|---|
| `ECOFLOW_ACCESS_KEY` | (required, lazy) | IoT-Open access key |
| `ECOFLOW_SECRET_KEY` | (required, lazy) | HMAC signing secret |
| `ECOFLOW_API_HOST` | `https://api-a.ecoflow.com` | REST base |
| `ECOFLOW_DEBUG_SIGN` | unset | `1` logs the signed `toSign` string |
| `ECOFLOW_TRACE_SN` / `ECOFLOW_TRACE_FILE` / `ECOFLOW_TRACE_TOPICS` | unset | MQTT trace diagnostics |

#### Snapshot / freshness / pool guards

| Key | Default | Effect |
|---|---|---|
| `SNAPSHOT_INCLUDE_RAW` | unset | `1` includes the full raw quota in each `DeviceSnapshot` |
| `BACKUP_POOL_GRACE_HOLD_MS` | `180000` | grace-hold window for the coherence gate (0 disables) |
| `BATTERY_SOC_MAX_DROP_PCT` | `25` | single-tick slew rejection threshold (`BACKUP_POOL_MAX_SLEW_PCT`) |

(`BACKUP_POOL_COHERENCE_SLACK_PCT = 5`, `BACKUP_POOL_HEALTHY_BASELINE_PCT = 30`,
`BACKUP_POOL_SLEW_MAX_AGE_MS = 10 min` are compile-time constants.)

#### Cloud-wedge / reachability

| Key | Default | Effect |
|---|---|---|
| `ECOFLOW_DEVICE_REACHABILITY` | unset | JSON `{ sn: entity_id }` mapping HA ping sensors; whole feature dormant when unset |
| `REACHABILITY_MAX_AGE_MS` | `150000` | stale reachability decays to `unknown` |

#### HA MQTT discovery

| Key | Default | Effect |
|---|---|---|
| `MQTT_DISCOVERY_ENABLED` | unset | `1`/`true` to enable (also needs host) |
| `MQTT_DISCOVERY_HOST` | — | HA broker host (required to enable) |
| `MQTT_DISCOVERY_PORT` | `1883` | broker port |
| `MQTT_DISCOVERY_USER` / `MQTT_DISCOVERY_PASS` | — | broker auth |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | discovery topic prefix |
| `DATA_DIR` | `/data` | dedup marker location |

(Compile-time: `PUBLISH_INTERVAL_MS = 30 s`, `EXPIRE_AFTER_S = 120`.)

#### Writes

| Key | Default | Effect |
|---|---|---|
| `WRITE_DEBUG_TOKEN` | unset | enables `/api/device/send-command`; required in `x-write-debug-token` |
| `SEND_CMD_COOLDOWN_MS` | `30000` | per-SN send-command cooldown |
| `WRITE_LOG_PATH` | sibling of DB | audit-log location |

(`REFRESH_COOLDOWN_MS = 30 s` is a compile-time constant.)

#### Runtime / HA host

| Key | Default | Effect |
|---|---|---|
| `SUPERVISOR_TOKEN` | injected by HA | enables `haService` Core calls; also flips `dbPath` to `/data/ecoflow.db` |
| `PORT` | `8787` | HTTP server |
| `HOST` | `::` | dual-stack bind |
| `DB_PATH` | `/data/ecoflow.db` (supervised) | recorder DB |
| `LOG_LEVEL` | `info` | `debug`/`trace` un-gates routine "poll ok" lines |
| `TELNET_ENABLED` / `TELNET_HOST` / `TELNET_PORT` | on / `::` / `2323` | telnet TUI |
| `TUI_USERNAME` / `TUI_PASSWORD` | empty | console login (empty password = prompt disabled) |

---

### Edge cases & honest-null summary

- **No LAN protocol.** Everything is cloud-sourced; resilience = LAN-ping
  wedge-vs-outage classification + a no-op cloud-presence refresh, never a reflexive
  reboot.
- **SHP2 is never MQTT-translated** → its freshness clock is protected by *not* bumping
  `lastUpdated` on untranslatable messages; a frozen SHP2 with a failing REST poll will
  still trip `Telemetry stale`.
- **Backup pool is an SHP2 aggregate**, not a per-slot sum — a cloud-offline DPU never
  over/under-counts it, and a stale slot is intentionally not subtracted.
- **Coherence + grace-hold + slew guard** together suppress reconnect-blip false SoC
  cascades while never masking a real low near the danger zone (asymmetric drop/rise
  gating).
- **Spares (Cores 4/5)** are an explicit SN allowlist safety-floor; home cores can never
  be misclassified as spares and muted.
- **Honest nulls everywhere:** null numeric fields emit `null` → HA `unknown`, never a
  fabricated 0/OFF; `gridSta` null stays null; `backup_reserve_enabled` reads `unknown`
  when the strategy object is absent.
- **Write surface is intentionally tiny**, rate-limited, allow-listed, sanity-bounded,
  and fully audit-logged.


---

## 3. Solar & PV Forecast Engine

This cluster covers everything that turns weather irradiance + recorded telemetry
into a day-ahead (and multi-day) projection of PV generation, house load, and
battery State-of-Charge (SoC). It is the analytical backbone the runway alarm,
the MPC dispatch planner, and the Solar/Forecast dashboard tiles all consume.

All code lives in `server/src/analytics.ts` unless noted. Weather ingestion is
`server/src/weather.ts` (Open-Meteo GHI) and `server/src/nws.ts` (NWS cloud
ensemble). Everything here is deterministic + pure where marked, and heavily
guarded against the "missing telemetry read as darkness" class of bug.

Pipeline at a glance:

```
Open-Meteo (GHI, cloud, temp) ─┐
NWS NDFD cloud (opt-in) ────────┼─► getWeather() ─► ghiByEpoch / wxByHour
                                │
recorder pv_total / panel_load ─┴─► buildSolarResponse() ─► SolarResponseModel (per hour-of-day β)
                                        │
                                        ├─► computePvBiasCorrection() ─► pvBiasFactor [0.5,1.2]
                                        ▼
                            computeDayForecastUncached() ─► DayForecast (24h PV+load+projectedSoc)
                                        │
             ┌──────────────────────────┼──────────────────────────────┐
             ▼                          ▼                               ▼
   computeForecastSkill()   computeProbabilisticForecast()    computeMultiDayForecast()
   (/api/forecast-skill,     (/api/forecast/probabilistic)    (/api/forecast/multi-day)
    /api/confidence)
```

---

### 1. The GHI→PV response model (`buildSolarResponse`)

#### What it does + why

The core physical model is a learned linear map from **Global Horizontal
Irradiance** (GHI, W/m²) to **PV output** (watts), fit separately **for each
hour-of-day (0–23)**. Splitting by hour-of-day captures the sun's changing
angle-of-incidence and any per-hour shading, so a 9 AM W/m² and a 1 PM W/m²
produce different watts even at equal irradiance. It is fit for the
whole-inverter `pv_total` (the fleet-facing model) and, per DPU, for the two
MPPT strings `pv_high` (HV) and `pv_low` (LV), which may face different
directions.

#### Inputs

| Input | Source | Notes |
|---|---|---|
| `pvByEpoch` | recorder `pv_total` / `pv_high` / `pv_low` bucketed to hour-epochs | `Map<hourEpoch, meanWatts>`, hour-epoch = `floor(ts/3_600_000)` |
| `ghiByEpoch` | Open-Meteo `shortwave_radiation` + recorder-persisted `ghi_wm2` | `Map<hourEpoch, W/m²>` |

PV is pre-averaged into 5-min SQL buckets (`HOUR_CURVE_BUCKET_SEC = 300`) then
into hourly means before pairing — a ~30× rowcount reduction with no material
curve change.

#### The calculation

For each hour-of-day `h`, pairs `{ghi, pv}` whose `ghi > DAYLIGHT_GHI (20 W/m²)`
are collected (below that is night/near-night and is discarded). If fewer than
`MIN_RESPONSE_PAIRS = 2` daylight pairs exist, that hour's `coeff = null`
(honest "no fit").

Otherwise a **through-origin least-squares slope** (line forced through 0,0 —
zero sun = zero watts) is fit:

```
coeff (β) = Σ(pv·ghi) / Σ(ghi²)          // W of PV per W/m² of GHI
```

`observedMaxPvW` is the historical peak PV at that hour (a physical clipping
clamp used downstream). A Pearson r² is also computed:

```
r² = cov(ghi,pv)² / (var(ghi)·var(pv))    // only when day.length ≥ 3, vg>0, vp>0; else 0
```

> **r² is DIAGNOSTIC ONLY (v1.20.0, F21).** Within-slot r² tracks the *weather
> regime*, not the array: in Phoenix's low-variance clear-sky climate per-slot
> GHI is near-constant, so r² degenerates to ~0.00–0.15 even for an excellent
> model (whose *day-level* replay scores r²≈0.94). **Nothing may gate on
> within-slot r².**

#### `peakCoeff` (the headline "Peak response")

`peakCoeff` is the best hourly slope across the day, used as a single headline
number. Its gate was moved off r² (v1.20.0, F21) onto **brightness + samples**:

```
if (meanGhiWm2 ≥ PEAK_RESPONSE_MIN_GHI_WM2 && day.length ≥ 3 && coeff > peakCoeff)
    peakCoeff = coeff
```

`PEAK_RESPONSE_MIN_GHI_WM2` defaults to **300 W/m²** (env-overridable; NaN/empty
safe) — far above the dawn-instability regime (~25 W/m²) where a poorly
conditioned slope could otherwise win, and below any productive mid-morning
slot. `peakGateMinGhiWm2` is published in the model so frontend mirrors gate on
the same threshold rather than hardcoding 300.

> **No Bayesian recursive update.** The prompt asked whether one exists — it does
> not. The model is a plain batched OLS refit over the trailing 30-day window on
> each forecast build. There is no per-observation Kalman/Bayes state.

#### Output shape (`SolarResponseModel`)

```ts
interface HourResponse {
  hour: number;            // 0-23
  coeff: number | null;    // β = W per W/m²; null = insufficient data
  r2: number;              // DIAGNOSTIC ONLY
  samples: number;
  observedMaxPvW: number;  // historical peak PV this hour (×1.05 = ceiling)
  meanGhiWm2?: number;     // mean daylight GHI of the slot (feeds the peak gate)
}
interface SolarResponseModel {
  hourly: HourResponse[];  // length 24
  peakCoeff: number;
  peakGateMinGhiWm2: number;
  pairCount: number;       // total (GHI,PV) pairs used
  historyDays: number;
}
```

#### Constants

| Constant | Value | Meaning |
|---|---|---|
| `DAYLIGHT_GHI` | 20 W/m² | below = night, pair discarded |
| `MIN_RESPONSE_PAIRS` | 2 | min daylight pairs to fit an hour |
| `PEAK_RESPONSE_MIN_GHI_WM2` | 300 (env) | brightness floor for the peak headline |
| `HOUR_CURVE_BUCKET_SEC` | 300 | 5-min pre-average bucket |
| `TYPICAL_HISTORY_MS` | 30 days | training window |

#### Full-coverage fitting gate (`fullCoverageFleetPv`, v1.10.0 F11)

The **alarm-facing** fleet model is NOT fit on the naive fleet sum. The 30-day
review found 31% of training pairs were missing ≥1 home Core (a cloud blackout),
and pairing full GHI against a partial-fleet PV sum deflated coefficients 11–23%
(noon 8.25 vs 9.44 full-coverage) — a chronic ~-21% clear-day under-forecast.

`fullCoverageFleetPv(perCore)` sums per-core hourly PV maps using **only
hour-epochs where every contributing core reported** (the intersection). Cores
dark for the whole window are skipped from the requirement. If fewer than
`SOLAR_FIT_MIN_FULL_COVERAGE_HOURS = 72` (~3 days) full-coverage hours exist, it
falls back to the ungated union sum (pre-v1.10.0 behavior). The returned `map`
feeds `solarModel = buildSolarResponse(fleetFit.map, ghiByEpoch)`.

A separate **restored** model (`restoredSolarModel`) is fit from the ungated
union *plus* each SHP2-connected-but-live-absent Core's own recorded `pv_total`.
It is DISPLAY/clipping-only and never feeds the alarm.

---

### 2. Day-ahead forecast (`getDayForecast` / `computeDayForecastUncached`)

#### What it does + why

Builds the 24-hour ahead per-hour series of PV watts, load watts, and projected
battery SoC%. This is the object every downstream forecast/alarm consumer reads.
`getDayForecast` is the cached + single-flighted entry point;
`computeDayForecastUncached` does the work.

#### Caching & single-flight

- `FORECAST_DAY_TTL_MS = 30 min` for a **complete** forecast.
- `INCOMPLETE_FORECAST_TTL_MS ≈ 150 s` (env `INCOMPLETE_FORECAST_TTL_MS`, default
  150000) for a **structurally-incomplete** forecast (SHP2 cloud-offline: no SoC
  basis / cold load history). This short negative-cache window bounds the >30 s
  cold recorder rescan to once per ~150 s instead of every `/api/ha-state` poll
  (which previously cascaded to 30 s client timeout → retry → HTTP 500).
- `dayForecastFlight = singleFlight<DayForecast>()` coalesces concurrent
  cold-cache callers onto one computation (v0.69.0).

#### Inputs

| Input | Source |
|---|---|
| Home DPU `pv_total` / `pv_high` / `pv_low` | recorder, 30-day window, home-connected DPUs only (`shp2ConnectedDpuSns`) |
| SHP2 `panel_load` | recorder, weekday/weekend split via `hourCurveByWeekday` |
| GHI / cloud | `getWeather()` (live) + recorder `ghi_wm2` / `cloud_pct` backfill |
| Backup pool | `shp2.projection.backupFullCapWh` / `backupRemainWh` / `backupReserveSoc` |
| EV load | `computeEvWindowPrediction` → `evLoadByHour` (expected-value watts) |
| Recent load | recorder `panel_load` over `FORECAST_RECENT_LOAD_WINDOW_MS` (3 h) |

#### The per-hour calculation

Loop over `k = 0..23`, `ts = ceil(now/1h) + k·1h`, `clock = local hour`:

**(a) PV projection** — via `forecastHourPvW(resp, ghi, cloud, fallbackCurveW, clearnessHist)`:

```
if resp.coeff != null and ghi != null:          // equipment-modelled
    pv = min(resp.coeff · ghi, resp.observedMaxPvW · 1.05)   // capped at physical ceiling
    modelled = true
else:                                            // fallback: typical-day curve × cloud derate
    pv = cloud != null
       ? fallbackCurveW · clamp(0.1, 1.3, (1 − 0.75·cloud/100) / clearnessHist)
       : fallbackCurveW
    modelled = false
```

`clearnessHist = max(0.2, 1 − 0.75·mean(pastCloud)/100)` — recent historical
clearness normalizer for the fallback derate only.

**(b) PV bias correction + re-clamp** (v0.93.0 #3 / v1.3.1 rank 11):

```
hourCeil = modelled ? resp.observedMaxPvW · 1.05 : null
pvAlarm  = hourCeil != null ? min(pv · pvBiasFactor, hourCeil) : pv · pvBiasFactor
```

The re-clamp matters: `pvBiasFactor` is clamped to `[0.5, 1.2]`, so an
UNDER-predicting model (factor >1) could otherwise multiply straight past the
observed ceiling and inflate the SoC slope → runway reads LONG (unsafe).
Deflation (factor <1) stays unclamped — it is the conservative direction.

**(c) Load projection**:

```
rawBase = useSplitLoad ? (isWeekend ? weekend[clock] : weekday[clock]) : combined[clock]
trimmed = (nightTrimActive && isSameNightTrimWindow) ? blendNightLoad(rawBase, recentLoadW) : rawBase
baseLoad = anchorNearTermLoad(trimmed, recentLoadW, k, RUNWAY_BLEND_HOURS=4)
load = baseLoad + evLoad
```

- `useSplitLoad` requires ≥ `WEEKDAY_MIN_SAMPLES = 24` weekday and 24 weekend
  hourly samples; else the combined curve is used.
- **Night trim** (`blendNightLoad`) only ever REDUCES a stale-high overnight
  curve toward recent measured load, gated three ways:
  1. Overnight band only: `FORECAST_NIGHT_START_HOUR` (21) .. 23 ∪ 0 .. `FORECAST_NIGHT_END_HOUR` (5).
  2. `shouldTrimNightCurve` — the premise ("curve over-predicts nights") is
     re-checked each build against the last 7 days: enabled only when
     `meanBias > max(150 W, 25%·meanActual)` over ≥12 hindcast night-hours
     (else, with <12 pairs, the trim stays on = the original stale-curve
     regime).
  3. `isSameNightTrimWindow(anchorClock, clock, k)` — the generation-time
     anchor may only trim hours of THIS night (anchor & target in night band,
     `0 ≤ hoursAhead ≤ 9`), so a 04:00 idle anchor can't gut tomorrow evening's AC.
  Trim formula: `max(rawBase·(1−blend), rawBase·(1−maxTrim), min(rawBase, recentLoadW))`
  with `blend = FORECAST_NIGHT_BLEND (0.6)`, `maxTrim = FORECAST_NIGHT_MAX_TRIM (0.5)`,
  ratio `FORECAST_NIGHT_OVERPREDICT_RATIO (1.5)`.
- **Near-term anchor** (`anchorNearTermLoad`) pulls the first
  `RUNWAY_BLEND_HOURS = 4` hours UPWARD toward observed load with a linearly
  decaying weight `w = 1 − hoursAhead/blendHours`, `max`-combined so it never
  makes a light day more optimistic. Mirrors the v0.15.17 runway fix.

**(d) SoC integration — v1.26.0 DC-bus balance**:

```
socWh = clamp(0, fullWh, socWh + (pvAlarm − load / RUNWAY_DISCHARGE_EFFICIENCY))
socPct = socWh / fullWh · 100
```

`RUNWAY_DISCHARGE_EFFICIENCY` (η) defaults to **0.94** (env
`RUNWAY_DISCHARGE_EFFICIENCY`, clamped `[0.80, 1.0]`). PV enters the DC bus at
~unity; the AC load is pulled through the inverter at 1/η, so delivering 1 kWh
costs the pack ~1/η kWh. This makes the pool drain ~6% faster than the raw load
implies — the safe (shorter-runway) direction. Live-confirmed 2026-07-14: 6.22 kW
gross drew for 5.88 kW delivered (ratio 0.945 = measured 7-day RTE). `min` with
`socWh + delta` means this is applied on net-discharge hours; surplus/charging
hours keep the raw delta, so the sim is never MORE optimistic than pre-v1.26.

`minProjectedSoc` / `minProjectedSocTs` track the lowest SoC over the horizon —
these feed the forecast-soc-dip narrative and are bounded by the runtime card.

#### Restored display basis (v0.78.0)

After the alarm loop, a second 24-hour loop re-runs `forecastHourPvW` with the
`restoredSolarModel` + `restoredPvCurve` (all SHP2-connected Cores including
cloud-wedged ones) to produce `forecastPvWhNext24Display` /
`typicalPvWhPerDayDisplay` / `typicalPvCurveWhPerHourDisplay`. Built by SUMMING
real recorded PV by SN only — never scaled/extrapolated. Equal to the
reporting-basis fields exactly when no Core is missing. These NEVER feed the
runway alarm.

#### Structural-incompleteness gate

```
loadCold        = loadRes.spanMs === 0            // no panel_load history (also true when SHP2 absent)
pvCold          = homeDpus.length > 0 && pvSpan === 0
socBasisMissing = fullWh == null                  // no SHP2 / incoherent backup pool
structurallyIncomplete = loadCold || pvCold || socBasisMissing || historyDays <= 0
```

Surfaced as `DayForecast.structurallyIncomplete` (v0.77.0) so ha-state/MQTT can
publish a diagnostic "forecast basis incomplete" sensor; also drives the short
negative-cache TTL.

#### Output (`DayForecast`, key fields)

| Field | Meaning |
|---|---|
| `hours[]` | `{ts, forecastPvW, forecastLoadW, cloudCoverPct, ghiWm2, projectedSocPct, modelled, predictedEvLoadW?}` — the alarm-facing (bias-corrected, reporting-only) series |
| `forecastPvWhNext24` | Σ bias-corrected PV (alarm basis) |
| `typicalPvWhPerDay` | RAW historical hour-of-day avg — NEVER bias-corrected |
| `pvBiasFactor` | the applied factor (1.0 no-op until mature) |
| `typicalPvCurveWhPerHour[]` | 24-slot diurnal baseline (sums to typicalPvWhPerDay) |
| `pvCeilingW` | max `observedMaxPvW·1.05` over modelled hours (P90 clamp) |
| `minProjectedSoc` / `minProjectedSocTs` | horizon low SoC |
| `reserveSoc` | `backupReserveSoc ?? 15` |
| `solarModel` / `restoredSolarModel` | alarm vs display fleet fits |
| `deviceModels[]` | per-DPU whole-inverter + HV + LV models |
| `soiling` | `fleetSoilingFromDevices(...)` (per-Core median drop; null <6 clean days) |
| `*Display` fields | full-fleet display basis |
| `homeDpusConnected/Reporting/CoveragePartial` | coverage caveat |

#### Endpoint

`GET /api/forecast` → `analytics.report('forecast')`, HTTP cache 60 s.

---

### 3. PV bias correction (`computePvBiasCorrection`, v0.93.0 #3)

#### What + why

The GHI→PV model over-predicts on cloudy days (field factor ≈0.62). Left raw,
over-predicted PV shrinks the runway deficit → latent islanding UNDER-alarm.
This helper hindcasts the reporting-only `solarModel` against the last 7 days of
actual home-Core PV and returns a **clamped, guarded scalar** applied to the
alarm-facing PV before `computeRunway` / `computeMultiDayForecast` /
`computeProbabilistic` consume it.

#### Calculation

For each of the last `windowDays = 7` days that (a) has any GHI coverage
(`dayHasGhiCoverage`) and (b) is NOT a telemetry-gap day (per
`coreCoverageByDay` — every wired core must report ≥ `PV_COVERAGE_MIN_FRAC = 80%`
of the day's daylight hours):

```
predWh = Σ_h  resp[hod].coeff · ghi(h)          // where coeff != null
actWh  = Σ_h  mean over SNs of hourly-mean pv_total
```

A day feeds the ratio only if **mature**: `predKwh > 0.5 && actKwh > 0.5 &&
predKwh ≥ 0.25·actKwh`. Then:

```
if matureDays < PV_BIAS_MIN_MATURE_DAYS (3) or totalPred ≤ 0.5:  return 1.0   // no-op
raw = totalAct / totalPred
return clamp(PV_BIAS_CLAMP_LO=0.5, PV_BIAS_CLAMP_HI=1.2, raw)
```

The `[0.5, 1.2]` clamp: factor <1 (over-prediction) shortens runway = safe; the
1.2 ceiling caps any runway-lengthening correction. Self-activating — a no-op
until data matures.

The per-core coverage gate (v1.10.0 F4) exists because scoring missing telemetry
as missing sunlight had crashed the factor to 0.63 (truth ~1.15) during the
06-29→07-02 cloud/wedge blackout.

---

### 4. Forecast skill (`computeForecastSkill`)

#### What + why

Backtests the model: predicted vs actual **daily PV kWh** over a trailing window,
yielding MAE and a `biasFactor`. Powers `/api/forecast-skill`,
`/api/confidence`, and (via MAE→sigma) the probabilistic band width.

#### Calculation

Window `windowDays` (default 7, clamped 1–14 at the route; `/api/confidence`
requests 30). For each past day `i = windowDays..1`, `dayStart = todayStart − i·1d`:

```
predWh = Σ_h  forecast.solarModel.hourly[hod].coeff · ghi(h)     // coeff != null
actWh  = Σ_h  Σ_DPU  mean(pv_total slice over the hour)
predKwh, actKwh = /1000;  errKwh = predKwh − actKwh
errPct = (weatherCovered && !coverageGap && actKwh>0.5) ? errKwh/actKwh·100 : null
```

Day is emitted with `weatherCovered` (`dayHasGhiCoverage`) and `coverageGap`
(per-core <80% daylight coverage). Only days that are weather-covered, NOT a
coverage gap, AND mature (`predKwh>0.5 && actKwh>0.5 && predKwh ≥ 0.25·actKwh`)
feed the aggregate stats:

```
meanAbsErrorKwh = mean(|errKwh|)  over scored days
meanAbsErrorPct = mae / meanActual · 100   (when meanActual > 0.5)
biasFactor = totalActual / totalPredicted  (Σactual/Σpredicted; null if totalPred ≤ 0.5)
```

> `biasFactor` is the **multiplier convention**: >1 = model UNDER-produces (alarm
> scales PV up). This is the same quantity `computePvBiasCorrection` clamps.
> Note `/api/degradation`'s forecast bias (in `reports.ts`) is `mean(pred−actual)
> Wh/h` — the opposite-signed *additive* convention for the SAME error.

Actuals are scoped to **SHP2-connected home DPUs only** (v0.21.0), matching the
predictor's training set. Cached `FORECAST_SKILL_TTL_MS = 1 h`, keyed by
`windowDays`.

#### Output (`ForecastSkillReport`)

```ts
{ generatedAt, days: ForecastSkillDay[], meanAbsErrorKwh, meanAbsErrorPct,
  biasFactor, windowDays }
ForecastSkillDay = { date, predictedKwh, actualKwh, errorKwh, errorPct|null,
                     weatherCovered, coverageGap? }
```

#### Endpoint

`GET /api/forecast-skill?days=N` (N clamped 1–14, default 7) →
`analytics.report('forecastSkill', {days})`, cache 60 s.

---

### 5. Confidence snapshot (`computeConfidenceSnapshot`)

#### What + why

A small, honest "how trustworthy is each engine" headline. Aggregates
degradation, thermal, and forecast-skill diagnostics.

#### The `forecastDayR2` metric (v1.20.0 F21)

Replaces the old within-slot median r² (`solarModelMedianR2`), which read a
degenerate ~0.02 while the model's day-level replay scored ~0.94. This is the
**Pearson r² of predicted vs actual daily PV kWh** across the skill report's
scored days:

```
scored = skill.days.filter(weatherCovered && errorPct != null)
if scored.length ≥ 5:
    forecastDayR2 = cov(pred,act)² / (var(pred)·var(act))
else: null
```

`/api/confidence` deliberately requests a **30-day** skill window (the basis the
r²≈0.94 premise was validated on) — a 7-day clear-sky window gives low-variance
points whose r² is noise-dominated.

#### Output (`ConfidenceSnapshot`)

```ts
{ generatedAt, degradationMedianR2, forecastDayR2, thermalMedianR2,
  forecastSkillBiasFactor, forecastSkillMaePct }
```

#### Endpoint

`GET /api/confidence` — fetches `degradation`, `ambientThermal`, and
`forecastSkill{days:30}`, cache 60 s.

---

### 6. Probabilistic P10/P90 SoC band (`computeProbabilisticForecast`)

#### What + why

Wraps the deterministic forecast in a **coherent trajectory ensemble** that
compounds uncertainty across the horizon, producing P10/P50/P90 PV watts and SoC%
per hour plus summary event probabilities. Cached `PROB_TTL_MS = 15 min`.

#### Per-hour sigma (raw, then calibrated)

For each forecast hour:

```
cloudStdev       = cloudVarByHour[hod]        // historical hour-of-day cloud stdev (fallback 0.25, capped 0.6)
disagreementFrac = ensembleDisagreementPct/100   // Open-Meteo vs NWS (v0.9.2)
skillFrac        = skill.meanAbsErrorPct/100  (fallback 0.15)
baseSigmaFrac    = sqrt(cloudStdev² + skillFrac² + disagreementFrac²)
horizonHours     = (h.ts − forecastStartTs)/1h
sf (raw)         = baseSigmaFrac · sqrt(1 + horizonHours/24)     // hour 24 ≈ 1.41× (variance ~linear in time)
```

#### Self-calibrating band width (v1.23.0 F30)

The raw band over-covers badly (live pre-fix: 76% daily half-width vs ~7%
realized error → ~100% coverage against a nominal 80%). So the band is
**shrunk** toward the realized error spread:

```
producedHalfFrac = Σ (p90−p10)/2  /  Σ p50            // raw band's daily half-width fraction
errs             = pvBandScoredErrs(skill.days, pvBiasFactor)
                   //  v1.31.0 — per scored day: |actual − pred·biasFactor| / (pred·biasFactor)
                   //  (bias-adjusted so the errors are of the SERIES THE BAND WRAPS —
                   //   hours[].forecastPvW carries pvBiasFactor — and %-of-PREDICTED,
                   //   matching how the half-width is applied to P50)
realizedHalfFrac = errs[k],  k = ceil(0.8·(n+1))       // v1.31.0 — E[coverage] = k/(n+1) ≥ 0.8 ∀n
if env PV_BAND_SIGMA_CAL set:  bandCal = clamp(0.1, 2, env)
elif realized & produced known: bandCal = clamp(PV_BAND_CAL_FLOOR=0.4, 1, realizedHalfFrac/producedHalfFrac)
else: bandCal = 1
sigmaFrac = sfRaw · bandCal
```

`pvBandRealizedHalfFrac` returns null below `PV_BAND_CAL_MIN_DAYS = 14` scored
days (so a short clear-sky window can't collapse the band — monsoon variability
must be in the sample). The skill window feeding it is
`PV_BAND_CAL_WINDOW_DAYS = 30` **calendar** days (v1.30.0 — the gate counts
*scored* days; at realistic ~50–65% weather/telemetry coverage a 14-day window
can never reach 14 scored days, which left the calibration dormant from
v1.23.0 to v1.30.0). Shrink-only, floored at 0.4.

**Honest label:** the floor binds in practice (realized/produced ≈ 0.1–0.2 <
0.4), so this band targets "**≥ 80% coverage, deliberately conservative**" — not
"= 80%". Known gaps the floor is insurance for (v1.31.0 review): the
calibrator's errors come from a *current-model hindcast against realized GHI*,
so they (a) are rewritten when the model re-learns, (b) omit the
weather-forecast component of true day-ahead error, (c) apply `pvBiasFactor` as
a plain daily multiply while publication re-clamps per-hour at the physical
ceiling — under an *under-prediction* regime (`pvBiasFactor > 1`, ceiling
pinned) the calibrator's basis sits above the published series and its errors
under-state the published band's misses (dormant while `pvBiasFactor ≤ 1`, the
current regime), and (d) the sample censors tail days — `actualKwh ≤ 0.5`
days (errorPct null) and `adjPred ≤ 0.5` days drop rather than scoring as
≈100% misses, and a retention-truncated fragment day at the window's oldest
edge can carry a phantom error (conservative direction: it inflates q80). All
four are resolved properly by archive-based out-of-sample scoring, not by
patching the hindcast basis further. The recorder's `forecast/pv_next24_wh`
archive series (v1.31.0, written by the main process's GHI-persistence tick)
accumulates the *issued* forecasts so a future release can score genuinely
out-of-sample; the published `calScoredDays` + `bandRealizedCoveragePct`
diagnostics make the coverage claim continuously measurable — a reading
trending toward 80% is the signal to revisit the floor, below it is a
regression. **Display + MPC-recommend only; NOT an alarm input** (verified by
exhaustive consumer census, v1.30.0 audit — wiring any field into
mqttDiscovery/alerts/runwayAlarm requires re-auditing the calibration).

#### PV band per hour

```
p50 = h.forecastPvW
p10 = max(0, p50·(1 − Z10·sigmaFrac))       Z10 = 1.282
p90raw = p50·(1 + Z10·sigmaFrac)
p90 = pvCeilingW>0 ? min(p90raw, pvCeilingW) : p90raw   // clamp best case to physical ceiling (v0.14.1)
```

#### Coherent SoC ensemble (v1.16.0 F7)

The old design reset the band per hour (overnight it collapsed to ±0.1 pt while
real nightly minima spanned 9–38%). Now `PROB_ENSEMBLE_Z` is **21
equal-probability quantiles** `Φ⁻¹((i+0.5)/21)` from −1.9808..+1.9808. Every
member draws ONE z and holds it for the whole window (forecast errors are
correlated across hours — a cloudy day is cloudy all day), so the trajectory is
monotone in z and the z=∓1.282 paths are exact P10/P90 trajectories.

**Back-out of full capacity** (`fullKwh`) — the forecast was generated against
`backupFullCapWh` via `socWh += (pv − load/η)`, so it is inverted from the
forecast's own SoC trajectory:

```
fullKwh = (cur.forecastPvW − cur.forecastLoadW/η)/1000  /  (dSocPct/100)
```

picking the hour with the largest unclamped `|dSocPct|` (best conditioning;
skips deltas <0.05 pt, SoC within 0.5 of 0/100, kwhDelta <0.05, candidate outside
[5,1000] kWh). Fallback when no SoC trajectory: `dpuCount · PACKS_PER_DPU(5) ·
PACK_KWH_NAMEPLATE(6.144)`.

**Integration** — each path (and the low/mid/high band paths) steps per hour:

```
sigmaPvKwh   = (p90 − p10)/2000/Z10
sigmaLoadKwh = PROB_LOAD_SIGMA_FRAC · max(0, forecastLoadW) / 1000    // 0.15 default (env PROB_LOAD_SIGMA_FRAC)
sigmaNetKwh  = sqrt(sigmaPvKwh² + sigmaLoadKwh²)                       // quadrature within the hour
dP50Kwh      = (p50 − forecastLoadW/η)/1000                            // v1.26.0 DC-bus balance
stepPct(z)   = (dP50Kwh + z·sigmaNetKwh)/fullKwh · 100
path = clampSoc(path + stepPct(z))                                    // clamp 0..100 per path
```

The load-side sigma is essential: PV sigma is 0 at night (multiplicative on PV=0),
yet load surprise (EV, HVAC) dominates realized overnight spread.

Published SoC anchors to the deterministic curve, band carries only the OFFSET:

```
p50SocOut = anchorSoc (= h.projectedSocPct, carried across null/NaN hours)
p10SocOut = clampSoc(anchorSoc + lowSoc − midSoc)
p90SocOut = clampSoc(anchorSoc + highSoc − midSoc)
```

The ensemble is seeded ONE deterministic step behind the anchor (using hour-0's
own `pv − load/η` delta) so the raw median doesn't clamp a rail an hour early.

#### Summary probabilities (v1.16.0 F23)

Min/max-over-path event probabilities over the equal-weight ensemble (replacing
the old fraction-of-hours count that read "42% above reserve" while the median
sat below reserve 11 h straight):

```
pAboveReservePct = share of paths whose per-path MIN SoC ≥ reserveSoc    (null if no trajectory)
pFullCharge      = share of paths whose per-path MAX SoC ≥ 99
uncertaintyKwhStdev = Σ per-hour sigmaNetKwh
```

A non-finite PV/load hour sets `windowUnscored` and nulls the min/max summaries
(fails safe: "never dips" is unknowable for a window not fully scored).

#### Output (`ProbabilisticForecast`)

```ts
{ generatedAt, hours: ForecastBand[], pAboveReservePct|null, pFullCharge|null,
  uncertaintyKwhStdev, bandSigmaCal?, realizedDailyErrHalfFrac?,
  calScoredDays?, bandRealizedCoveragePct? }   // v1.31.0 coverage diagnostics
ForecastBand = { ts, p10W, p50W, p90W, p10SocPct|null, p50SocPct|null, p90SocPct|null }
```

#### Endpoint

`GET /api/forecast/probabilistic` → `analytics.report('probabilisticForecast')`,
cache 60 s. Also consumed by the MPC dispatch planner (index.ts ~1600) for a
pessimistic P10 PV envelope.

---

### 7. Multi-day horizon (`computeMultiDayForecast`)

#### What + why

Extends the 24 h horizon to `horizonDays` (default 3, clamped 1–7 at route) with
per-day rollups. Cached `MULTI_DAY_TTL_MS = 30 min`.

#### Calculation

Hours **inside** the 24 h day-ahead window reuse the exact `ForecastHour`
verbatim (bias-corrected PV + weekday/EV/trim-aware load) via `forecastByHourEpoch`
(v1.4.4 #50/#22) — no re-derivation, so day-0 stays consistent with
`getDayForecast`.

Hours **beyond** the window:

```
radiationWm2 = wx ? wx.radiationWm2 : climoRadiationWm2(hod)   // per-hour-of-day mean of observed GHI
pv = min(min(resp.coeff·rad, observedMaxPvW·1.05)·pvBiasFactor, ceilW)   // same bias + re-clamp
load = useSplitLoad ? (weekend?weekend[hod]:weekday[hod]) : (loadByHod[hod] ?? fallbackLoad)
       + evLoad
```

The radiation climatology (v0.10.4) is critical — Open-Meteo's hourly radiation
reaches only ~48 h, so day-3 hours had no `wx` → PV computed 0 → a phantom
"battery dead in 3 days" panic. `pvBiasFactor` is reused from the day-ahead
forecast (`forecast.pvBiasFactor ?? 1`).

SoC integrated with the same v1.26.0 DC-bus balance
`socWh + (pv − load/η)`, clamped `[0, fullWh]`. Report-only, never an alarm gate.

#### Output (`MultiDayForecast`)

```ts
{ generatedAt, days: DayRollup[] }
DayRollup = { date, pvKwh, loadKwh, minProjectedSoc|null, minProjectedSocTs|null }
```

#### Endpoint

`GET /api/forecast/multi-day?days=N` (default 3) →
`analytics.report('multiDayForecast', {days})`, cache 60 s.

---

### 8. Weather ingestion (`weather.ts` + `nws.ts`)

#### Open-Meteo (primary — GHI source)

`getWeather()` — TTL-cached (`TTL_MS = 2 h`), single-flighted. Fetches:

```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}
  &hourly=cloud_cover,shortwave_radiation,temperature_2m&forecast_days=2&past_days=7
```

`past_days=7` (v0.13.1) so one fetch backfills a week of irradiance into the
recorder (`recordWeatherGhi` on `/api/weather/ensemble`), unblocking
forecast-skill days 4–7 and the soiling estimator beyond the in-memory window.
Local-zone ISO times are converted to true UTC epoch via `utc_offset_seconds`.
On fetch failure it returns the stale cache ("better than nothing").

`WeatherHour = { ts, cloudCoverPct, radiationWm2, tempC, ensembleSources?, ensembleDisagreementPct? }`.

Lat/lon default to Phoenix: `FORECAST_LAT = 33.4484`, `FORECAST_LON = -112.074`
(env `FORECAST_LAT` / `FORECAST_LON`).

#### NWS NDFD (opt-in — cloud ensemble)

Off by default; `NWS_ENABLED=1` (or `true`). US-only. NWS does not expose
shortwave radiation, so it contributes **only cloud cover** to an ensemble:

```
h.cloudCoverPct = (openMeteoCloud + nwsCloud) / 2       // ensemble mean
h.ensembleSources = 2
h.ensembleDisagreementPct = round(|openMeteoCloud − nwsCloud|)
```

The per-hour disagreement is a direct uncertainty signal folded into the
probabilistic band's `disagreementFrac`. NWS uses `api.weather.gov/points/{lat},{lon}`
→ `gridpoints/{office}/{x},{y}`. Failure degrades gracefully to Open-Meteo only.

`GET /api/weather/ensemble` returns the forecast with ensemble metadata and
persists GHI/cloud rows to the recorder.

---

### 9. Config knobs (env / config.yaml)

| Env var | Default | Effect |
|---|---|---|
| `PEAK_RESPONSE_MIN_GHI_WM2` | 300 | brightness floor for `peakCoeff` headline |
| `RUNWAY_DISCHARGE_EFFICIENCY` | 0.94 (clamp 0.80–1.0) | η in DC-bus SoC balance `load/η` |
| `INCOMPLETE_FORECAST_TTL_MS` | 150000 | negative-cache TTL for incomplete forecast |
| `FORECAST_RECENT_LOAD_WINDOW_MS` | 3 h | recent-load trailing window |
| `FORECAST_NIGHT_START_HOUR` | 21 | night-band start |
| `FORECAST_NIGHT_END_HOUR` | 5 | night-band end |
| `FORECAST_NIGHT_OVERPREDICT_RATIO` | 1.5 | night-trim trigger ratio |
| `FORECAST_NIGHT_BLEND` | 0.6 | night-trim blend weight |
| `FORECAST_NIGHT_MAX_TRIM` | 0.5 | night-trim floor cap |
| `PROB_LOAD_SIGMA_FRAC` | 0.15 | load-side 1σ fraction in the ensemble |
| `PV_BAND_SIGMA_CAL` | (auto) | manual band-cal override, clamp 0.1–2 |
| `NWS_ENABLED` | off | enable NWS cloud ensemble |
| `FORECAST_LAT` / `FORECAST_LON` | 33.4484 / -112.074 | weather location |

Hard-coded (non-env) constants: `DAYLIGHT_GHI=20`, `MIN_RESPONSE_PAIRS=2`,
`HOUR_CURVE_BUCKET_SEC=300`, `TYPICAL_HISTORY_MS=30d`, `WEEKDAY_MIN_SAMPLES=24`,
`RUNWAY_BLEND_HOURS=4`, `SOLAR_FIT_MIN_FULL_COVERAGE_HOURS=72`,
`PV_COVERAGE_MIN_FRAC=0.8`, `PV_BIAS_CLAMP_LO/HI=0.5/1.2`,
`PV_BIAS_MIN_MATURE_DAYS=3`, `Z10=1.282`, `PV_BAND_CAL_MIN_DAYS=14`,
`PV_BAND_CAL_FLOOR=0.4`, `PACK_KWH_NAMEPLATE=6.144`, `PACKS_PER_DPU=5`,
`FORECAST_DAY_TTL_MS=30m`, `FORECAST_SKILL_TTL_MS=1h`, `PROB_TTL_MS=15m`,
`MULTI_DAY_TTL_MS=30m`, weather `TTL_MS=2h`.

---

### 10. Edge cases, guards, and honest-null behavior

- **Insufficient data → `coeff = null`, not a fabricated slope.** An hour with
  <2 daylight pairs is honestly unmodelled; `forecastHourPvW` then falls back to
  the typical-day curve × cloud derate.
- **Within-slot r² is degenerate by design** in a low-variance climate and gates
  nothing. `forecastDayR2` (day-level replay) is the honest confidence headline;
  needs ≥5 scored days else null.
- **Missing telemetry ≠ darkness** — the pervasive guard. Bias correction, skill
  scoring, and the fleet fit all EXCLUDE days/hours where a wired Core reported
  <80% of daylight hours (`coreCoverageByDay`, `fullCoverageFleetPv`), and mark
  their `errorPct`/`coverageGap` rather than scoring a phantom over-forecast.
- **PV bias factor is a no-op (1.0) until mature** (≥3 mature covered days) and
  clamped `[0.5, 1.2]`; deflation is unclamped-safe, inflation is re-clamped to
  the physical ceiling.
- **Structural incompleteness** is surfaced (`structurallyIncomplete`) and
  short-negative-cached; the SoC/floor alarms read the live snapshot's
  `backupBatPercent`, not the forecast, so caching an incomplete forecast is
  alarm-neutral.
- **Empty/cold load curve is never cached long** (v0.15.21 / v0.57.0 / v0.73.0
  gate on input spans, never output values — a real zero-PV night still caches).
- **P90 clamped to the physical array ceiling** (`pvCeilingW`); P10 floored at 0.
- **Coherent ensemble compounds uncertainty**; a NaN/non-finite hour skips the
  step (state carries, band recovers) and nulls the safety-facing min/max
  summaries rather than scoring only the clean prefix.
- **Multi-day radiation climatology** prevents day-3 PV collapsing to 0 (phantom
  depletion panic) once Open-Meteo's ~48 h radiation window runs out.
- **Fleet soiling** uses the per-Core median drop (`fleetSoilingFromDevices`),
  immune to the fleet-sum coverage-deflation artifact that once produced a false
  ~35% soiling alarm; null until ≥6 clean days AND ≥2 covered Cores.


---

## 4. Physics-Based & Bayesian Model Tier

> **Track C (physics-informed hybrid) + Track D (hierarchical Bayes).** A set of
> *first-principles* models that run **alongside** the learned engines (the OLS
> solar-response model and the Kalman SoH filter). They exist to give the panel a
> ground-truth yardstick the learned engines can be scored against: "what does
> physics say *should* be happening right now?" When the learned model and the
> physics model disagree, that disagreement is itself a signal — mis-tuned
> forecast, BMS SoH miscalibration, a drifting cell, or a soiled array.

This tier is composed of four independent modules, each exposed as its own
read-only endpoint:

| Module | File | Endpoint | Purpose |
| --- | --- | --- | --- |
| Clear-sky PV ceiling | `server/src/physics/clearSky.ts` | `/api/physics/pv-pmax` | Theoretical max PV for the site + time; realized/ideal score |
| LFP OCV → SoC | `server/src/physics/lfpOcv.ts` + `physics/restTracker.ts` | `/api/physics/lfp-soc` | Physics SoC from rested pack voltage vs BMS-reported SoC |
| Hierarchical pack SoH | `server/src/models/hierarchicalBayes.ts` | `/api/models/hierarchical-pack-soh` | Partial-pooled per-pack SoH + 2σ outlier flags |
| Recursive Bayesian solar | `computeBayesianSolarModel` in `server/src/analytics.ts` | `/api/forecast/bayesian` | Bayesian GHI→PV response posterior, cross-checked vs OLS |

All four are **honest-null** by design: they emit `null` / empty rather than a
fabricated number whenever their preconditions aren't met (sun below horizon,
pack not rested, no observations, no weather).

---

### 1. Clear-Sky PV Physical Model (`clearSky.ts`)

#### WHAT + why

Computes the **theoretical maximum PV output** for a specific site and instant,
assuming a cloudless sky and applying cell-temperature derating. The realized
fleet PV is then divided by this ceiling to produce a **physics score** — the
fraction of "physics-max" the array is actually making right now.

The value of this is *normalization*: "we're making 12.8 kW today" is
uninterpretable (depends on time of day, season, weather). "We're making 90% of
what clear-sky physics says is possible at this exact moment" is directly
interpretable and comparable across days, and it is the reference the Bayesian /
cloud-aware forecast should predict close to. If the forecast diverges from the
realized physics fraction, the forecast is mis-tuned.

#### INPUTS

- `ts` — the instant (epoch ms), taken as `Date.now()` at the endpoint.
- `ambientC` — ambient air temperature (°C). The endpoint currently passes a
  **placeholder constant `30`** (`// °C — placeholder; real call would use weather.ts`).
- `site: SiteParams` — defaults to `PHOENIX_SITE` (the operator's plant).
- `realizedW` — summed live `pvTotalWatts` across online DPUs (endpoint side).

#### PHOENIX_SITE constants (the real, in-code values)

```
PHOENIX_SITE = {
  lat:        33.4484,        // Phoenix, AZ
  lon:       -112.074,
  pNamplate:  16_800 W,       // 42 panels × 400 W = 16.8 kWp nameplate
  tilt:       25°,            // roof mount, approximate
  azimuth:    180°,           // due south
  noct:       45 °C,          // Nominal Operating Cell Temperature
  tempCoeff: -0.0035 /°C,     // Pmax temp coefficient, crystalline silicon
  derate:     0.85,           // wiring + inverter + soiling-clean baseline
}
```

Global constant: `DEG = Math.PI / 180`.

#### THE CALCULATION (step by step)

The pipeline is a 5-stage physical chain. `physicsPmax(ts, ambientC, site)`:

**Step 1 — Solar position (Spencer 1971).** `solarPosition(d, lat, lon)`:

- Day-of-year `doy(d)` and the seasonal angle `B = 2π·(doy − 1) / 365`.
- **Equation of time** (minutes), Spencer Fourier series:

  ```
  EoT = 229.18 · (0.000075 + 0.001868·cosB − 0.032077·sinB
                  − 0.014615·cos2B − 0.040849·sin2B)
  ```

- **Declination** (degrees), Spencer series:

  ```
  δ = (180/π) · (0.006918 − 0.399912·cosB + 0.070257·sinB
                 − 0.006758·cos2B + 0.000907·sin2B
                 − 0.002697·cos3B + 0.001480·sin3B)
  ```

- **Hour angle**: true solar time `tst = utcMin + 4·lon + EoT`, then
  `ha = tst/4 − 180` (degrees; negative before noon).
- **Zenith / elevation**:

  ```
  cos(z) = sin(lat)·sin(δ) + cos(lat)·cos(δ)·cos(ha)
  elevation = 90 − acos(clamp(cos z, −1, 1))·(180/π)
  cosZenith = max(cos z, 0)          // 0 if sun below horizon
  ```

- Azimuth via the standard `atan2(sinA, cosA)` formula (from north, clockwise).

**Step 2 — Clear-sky GHI (Haurwitz model).** `clearSkyGHI(cosZenith)`:

```
GHI = 0                                    if cosZenith ≤ 0  (night)
GHI = 1098 · cosZenith · exp(−0.057 / cosZenith)   [W/m²]
```

Constants `1098` and `0.057` are the canonical Haurwitz coefficients — a simple,
fast model that is documented in-code as **±10%** of more sophisticated models,
which is fine for a scoring baseline.

**Step 3 — Plane-of-array (POA) irradiance.**
`plantOfArrayIrradiance(ghi, elev, azimuth, tilt, panelAzimuth)`:

```
cosθ  = sin(elev)·cos(tilt) + cos(elev)·sin(tilt)·cos(sunAz − panelAz)
cosZ  = sin(elev)
POA   = ghi · (cosθ / cosZ)
```

Guards: returns `0` if `ghi ≤ 0`, `elev ≤ 0`, `cosθ ≤ 0` (sun behind panel), or
`cosZ < 0.05` (horizon clipping, avoids divide-by-near-zero blowup).

**Step 4 — Cell temperature (NOCT estimator).** `cellTemp(ambientC, poa, noct)`:

```
T_cell = T_amb + ((NOCT − 20) / 800) · POA        [°C]
```

**Step 5 — Pmax.** With `tempFactor = 1 + tempCoeff·(T_cell − 25)`:

```
Pmax = max(0, pNamplate · derate · (POA / 1000) · tempFactor)   [W]
```

POA is normalized to STC irradiance (1000 W/m²); `tempFactor` derates for cells
hotter than 25 °C at the `−0.0035/°C` coefficient.

#### The physics score

`physicsScore(realizedW, theoreticalW)`:

```
null                             if theoreticalW ≤ 0   (night / no ceiling)
clamp(realizedW / theoreticalW, 0, 1)   otherwise
```

`1.0` = clear sky, no soiling, no shade. `< 1.0` = cloud, dust, dirt, or shade.

#### TRACE (inputs → outputs)

- **In:** `realizedW = Σ (d.projection.pvTotalWatts)` over `onlineDpus(...)`;
  `ambient = 30` (placeholder); `ts = Date.now()`.
- **Compute:** `physicsPmax(ts, ambient, PHOENIX_SITE)` → `physicsScore(...)`.
- **Out:** HTTP `GET /api/physics/pv-pmax`, cached 30 s.

#### OUTPUT shape (`/api/physics/pv-pmax`)

```jsonc
{
  "ts": 1752607200000,
  "pMaxW": 14210.5,          // theoretical clear-sky ceiling
  "poaIrradiance": 905.2,    // W/m²
  "ghi": 870.1,              // W/m² Haurwitz
  "cellTempC": 51.3,
  "solarElevation": 71.2,    // degrees
  "notes": "clear-sky",      // 'night' | 'sun-not-on-panel' | 'clear-sky'
  "realizedW": 12800,        // summed live fleet PV
  "score": 0.90              // realized / theoretical (null at night)
}
```

#### CONFIG knobs + defaults

There are **no environment-variable knobs** for this module. Site parameters are
the compile-time `PHOENIX_SITE` constant; `SiteParams` can be overridden at the
call site if the add-on is ever shipped to another operator. The ambient
temperature is a hardcoded `30 °C` placeholder in the endpoint.

#### EDGE CASES / guards / honest-null

- **Night / sun below horizon** → `cosZenith = 0` → `ghi = 0` → `poa = 0` →
  `pMaxW = 0`, `notes = 'night'`, and `physicsScore` returns **`null`** (no
  ceiling to score against).
- **Sun behind the panel plane** (`cosθ ≤ 0`) → `poa = 0`, `notes = 'sun-not-on-panel'`.
- **Horizon clipping** (`cosZ < 0.05`) → POA forced to 0 to avoid the
  `cosθ/cosZ` singularity near sunrise/sunset.
- **`acos` domain safety** via `clamp(cosZ, −1, 1)`.
- Ambient is a placeholder — cell-temp derate is approximate until `weather.ts`
  is wired in.

---

### 2. LFP Open-Circuit-Voltage → SoC (`lfpOcv.ts` + `restTracker.ts`)

#### WHAT + why

The Delta Pro Ultra packs are **LFP** (lithium iron phosphate) chemistry, whose
discharge curve is famously **flat**. Flatness makes SoC-from-voltage hard in
general — but it also makes small deviations from the canonical curve
*diagnostic*. Two signals fall out:

1. **OCV-vs-reported-SoC mismatch** — physics-implied SoC (from rested voltage)
   drifting from BMS-reported SoC → SoH miscalibration in the BMS.
2. **Cell drift** — one cell's voltage diverging from siblings → imbalance /
   per-cell capacity fade.

Crucially, OCV → SoC is only valid at **rest**: under load the IR drop adds
50–200 mV, so a rested estimate requires the pack to have been idle long enough
for the terminal voltage to settle to true OCV. That gating is the whole reason
`restTracker.ts` exists.

#### INPUTS (`LfpAnalysisInputs`)

- `packVoltageMv` — pack terminal voltage (mV). Endpoint uses
  `pk.packVoltageMv ?? pk.adBatVoltageMv ?? null`.
- `reportedSoCPct` — BMS SoC (`pk.soc`).
- `cellVoltagesMv[]` — per-cell voltages (`pk.cellVoltagesMv`).
- `packCurrentA` — derived, not measured (see below).
- `lastNonRestingAtMs` — from the rest tracker, keyed on pack serial.
- `nowMs` — defaults to `Date.now()`.

#### The OCV lookup table (real values)

21 points, single-cell OCV at 25 °C, rested, in 5% SoC increments
(`LFP_OCV_TABLE_25C`). Notice the extreme flatness across the midrange:

| SoC% | V/cell | SoC% | V/cell | SoC% | V/cell |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0  | 2.50 | 35 | 3.29 | 70 | 3.33 |
| 5  | 3.15 | 40 | 3.30 | 75 | 3.33 |
| 10 | 3.20 | 45 | 3.30 | 80 | 3.34 |
| 15 | 3.22 | 50 | 3.31 | 85 | 3.35 |
| 20 | 3.25 | 55 | 3.31 | 90 | 3.36 |
| 25 | 3.27 | 60 | 3.32 | 95 | 3.40 |
| 30 | 3.28 | 65 | 3.32 | 100 | 3.55 |

Key constants:

```
CELLS_IN_SERIES            = 32     // DPU pack is 32S1P (~102.4 V nominal = 32 × 3.2 V)
RESTING_CURRENT_THRESHOLD_A = 0.5   // |I| ≤ 0.5 A = electrically at rest
RESTING_AGE_MIN_MS          = 10 min // OCV must have settled this long
```

#### THE CALCULATION

**Voltage → SoC (`socFromOcv`).** Pack voltage is divided by 32 to get per-cell,
then bracketed in the table and **linearly interpolated**:

```
frac = (v_cell − v1) / (v2 − v1)
soc  = soc1 + frac · (soc2 − soc1)
```

Clamped: `v_cell ≤ 2.50 → 0`; `v_cell ≥ 3.55 → 100`.

**The plateau-midpoint fix (v1.3.1, audit rank 51).** The flat midrange holds
one voltage across two SoC points (e.g. 3.30 V at both 40% and 45%). A cell
sitting exactly on a plateau matches the *rising* bracket into it first
(`[35, 3.29] → [40, 3.30]`), whose endpoints differ, so it silently returned
`frac = 1` → the plateau's **low** end, biasing `socDriftPct` low by up to 5
points. The fix: when `v_cell === v2`, walk forward over the full run of table
entries sharing that voltage and return the **midpoint** of the ambiguity band:

```
if v_cell === v2:
    extend `last` while table[last+1].v === v2
    if last > i:  return (soc2 + table[last].soc) / 2   // honest centre
```

The `if (v2 === v1) return (soc1+soc2)/2` guard is retained only for a
hypothetical descending table; it is unreachable with the current ascending
table (documented in-code).

**Rest gating (`analyzePackLfp`).**

```
lowCurrent      = packCurrentA != null && |packCurrentA| ≤ 0.5 A
idleLongEnough  = lastNonRestingAtMs != null && (now − lastNonRestingAtMs) ≥ 10 min
isResting       = lowCurrent && idleLongEnough

physicsSoCPct   = isResting && packVoltageMv != null
                    ? socFromOcv(packVoltageMv / 1000)
                    : null
socDriftPct     = (physicsSoCPct != null && reportedSoCPct != null)
                    ? physicsSoCPct − reportedSoCPct     // + = BMS under-reports
                    : null
```

**Cell spread + deviations** (always computed, no rest needed): sort cell
voltages, `cellSpreadMv = max − min`, `cellDeviationsMv[i] = v[i] − median`.

**Confidence (0..1):**

```
+0.5  if isResting
+0.3  if we have ≥ CELLS_IN_SERIES/2 (=16) cell deviations
+0.2  if packVoltageMv != null
confidence = min(1, sum)
```

#### The rest tracker (`restTracker.ts`) — why it exists

`analyzePackLfp` needs `lastNonRestingAtMs`, but nothing produced it — the
endpoint used to hardcode `null`, so `isResting` was false on **every one of the
15 live packs forever**, and `physicsSoCPct` was permanently null. `restTracker.ts`
supplies that timestamp:

- **`packCurrentAmps(outputWatts, inputWatts, packVoltageMv)`** — derives current
  from power, because the projection has no direct current field:

  ```
  netW = (outputWatts ?? 0) − (inputWatts ?? 0)     // + = discharging
  A    = netW / (packVoltageMv / 1000)
  ```

  Returns `null` if `packVoltageMv` is null/≤0 or both power fields are null.

- **`observePackRest(packKey, packCurrentA, nowMs)`** — called every poll. A pack
  is "moving" if `packCurrentA == null` (unreadable current is **not** evidence
  of stillness) **or** `|I| > 0.5 A`. It sets `lastNonRestingAt[packKey] = now`
  on every moving observation **and on first sight** (the seeding rule).
- **`packRestKey(dpuSn, pack)`** — keys on the pack hardware serial
  (`pack:<packSn>`), falling back to `slot:<dpuSn>:<num>`, so rest history
  survives pack renumbering / DPU reordering.
- **`retainPacks(keys)`** — drops packs no longer present so a removed / re-serialled
  pack cannot pin memory.

**The seeding rule (deliberately conservative).** On first sight the tracker
does *not* know how long the pack has already been idle — rest may have begun
before the add-on started. It seeds `lastNonRestingAt = now`, forcing a full
freshly-observed 10 minutes of rest before it will claim `isResting`. This
**under-claims** rest rather than fabricating an OCV SoC from an unverified
assumption — the same "emit null over a fabricated number" rule the panel
applies everywhere.

#### TRACE

- **Poll loop** (`index.ts` ~L1761, `restTrackerTick` on `POLL_INTERVAL_MS`):
  for every online DPU pack, `observePackRest(packRestKey(d.sn, pk),
  packCurrentAmps(pk.outputWatts, pk.inputWatts, pk.packVoltageMv ?? pk.adBatVoltageMv), now)`,
  then `retainPacks(keys)`.
- **Endpoint** (`/api/physics/lfp-soc`, `index.ts` ~L1511): for every online DPU
  pack, build `LfpAnalysisInputs` (voltage, reported SoC, cell voltages, derived
  current, and `lastNonRestingAtMs(packRestKey(...))`) → `analyzePackLfp(...)`.
- **Out:** cached 30 s.

#### OUTPUT shape (`/api/physics/lfp-soc`)

```jsonc
{
  "packs": [
    {
      "device": "Core 1",
      "packNum": 2,
      "analysis": {
        "physicsSoCPct": 62.5,     // null unless resting
        "reportedSoCPct": 61,
        "socDriftPct": 1.5,        // + = BMS under-reports
        "isResting": true,
        "packVoltageMv": 104425,
        "cellSpreadMv": 18,
        "cellDeviationsMv": [ -3, 2, ... ],
        "confidence": 1.0,
        "notes": [ ... ]
      }
    }
  ],
  "generatedAt": 1752607200000
}
```

#### EDGE CASES / guards / honest-null

- **Pack not rested** → `physicsSoCPct = null`, `socDriftPct = null`; only the
  cell-spread signals remain.
- **Current unreadable** (`packCurrentA == null`) → note "pack current not
  reported — cannot confirm rest" (v0.95.0 re-audit #12 fixed a prior bug that
  printed a bogus "current undefined A > 0.5 A threshold"). Counts as non-resting.
- **Plateau ambiguity** → midpoint of the shared-voltage run (v1.3.1), never the
  low end.
- **No cell readings** → note "no per-cell voltage readings available",
  `cellSpreadMv`/`cellDeviationsMv` null.
- **Non-finite voltage** → `socFromOcv` returns null.

---

### 3. Hierarchical Bayesian Pack SoH (`models/hierarchicalBayes.ts`)

#### WHAT + why

The operator has ~25 packs (5 DPUs × 5 packs). Estimating each pack's SoH **in
isolation** is noisy; **fully pooling** them gives a precise fleet mean but
erases individual signal. The right answer is **partial pooling** — every pack
"borrows strength" from its siblings, drifting toward the group mean when its own
measurement is noisy but standing its ground when its measurement is tight. This
is exactly what catches a genuinely-failing pack without chasing measurement
noise, and it feeds a principled **2σ outlier** flag.

#### The model

A closed-form **three-level Gaussian** (no MCMC):

```
y_pack  ~ Normal(μ_dpu,   σ²_pack)      one observation per pack
μ_dpu   ~ Normal(μ_fleet, σ²_dpu)       DPU-level prior
μ_fleet ~ Normal(μ_global,σ²_fleet)     fleet-level prior
```

Conjugate Gaussian precision-weighted mean (applied up the levels):

```
posterior_mean = (prior_mean · prior_precision + y · obs_precision)
               / (prior_precision + obs_precision)
```

#### INPUTS (`HBPackObs[]`)

- `packKey` = `<dpu-sn>:<pack-num>`, `dpuKey` = `<dpu-sn>`.
- `value` — the pack's SoH observation (`pk.actSoh ?? pk.soh`).
- `obsSigma` — per-observation 1σ. The endpoint derives it from cycle count so
  that **newer packs are treated as noisier**:

  ```
  sigma = max(0.3, 3.0 − min(2.5, cycles / 500))
  ```

  A 0-cycle pack → σ = 3.0; a ≥1250-cycle pack → σ floors at 0.5 (then the
  0.3 floor). Packs with `actSoh == null && soh == null` are skipped.

#### THE CALCULATION (`fitHierarchical`)

1. **Group** observations by DPU.

2. **Within-DPU σ (empirical, winsorized).** Collect squared deviations of each
   pack from its DPU mean, but **10%-winsorize** them: sort, cap the top 10% at
   the 90th-percentile value, then

   ```
   σ_withinDpu = sqrt( trimmedSum / N )
   ```

   Winsorization is load-bearing: without it a single large outlier *inflates* σ,
   which then *suppresses* the very shrinkage that should catch it. The in-code
   example: one 25-point outlier in 25 obs → naïve σ ≈ 4.5 → shrinkage ≈ 4%
   (outlier ignored); winsorized σ ≈ 2.2 → shrinkage ≈ 16% (outlier meaningfully
   pulled toward its DPU mean).

3. **DPU raw means** (simple average) and **between-DPU σ**:

   ```
   σ_withinFleet = sqrt( Σ(dpuMean − fleetMean)² / nDpu )
   ```

   `fleetMean` is the plain empirical average of DPU means (uninformative top prior).

4. **Posterior DPU means** — shrink each DPU mean toward the fleet mean:

   ```
   likPrec  = n / σ_withinDpu²          (n = packs in the DPU)
   priorPrec = 1 / σ_withinFleet²
   μ_dpu_post = (likPrec·dpuRaw + priorPrec·fleetMean) / (likPrec + priorPrec)
   ```

5. **Posterior pack means** — shrink each pack toward its DPU posterior mean:

   ```
   likPrec   = 1 / max(1e-3, obsSigma)²
   priorPrec = 1 / σ_withinDpu²
   μ_pack_post = (likPrec·value + priorPrec·μ_dpu_post) / (likPrec + priorPrec)
   σ_pack_post = 1 / sqrt(likPrec + priorPrec)
   shrinkageToDpu = clamp( (value − μ_pack_post) / (value − μ_dpu_post), 0, 1 )
   ```

   `shrinkageToDpu` = 0 (pack unchanged, trusted its own data) … 1 (fully pulled
   to the DPU mean).

#### Outlier rule (`findOutliers(fit, zThreshold = 2.0)`)

A pack is an outlier when its **posterior** sits ≥ z·σ_withinDpu from its DPU
posterior mean:

```
z = |μ_pack_post − μ_dpu_post| / max(1e-9, σ_withinDpu)
outlier  ⇔  z ≥ 2.0
```

Because shrinkage already pulls noisy packs inward, a pack that *stays* far out
after shrinkage is one whose own (tight) data genuinely disagrees with its
siblings — the exact thing worth flagging.

#### TRACE

- **In:** `/api/models/hierarchical-pack-soh` (`index.ts` ~L1537) iterates online
  DPU packs, building `HBPackObs` from `actSoh/soh` + cycle-derived σ.
- **Compute:** `fitHierarchical(obs)` → `findOutliers(fit, 2.0)`.
- **Out:** cached **300 s**.

#### OUTPUT shape (`/api/models/hierarchical-pack-soh`)

```jsonc
{
  "generatedAt": 1752607200000,
  "metric": "pack_soh_pct",
  "packs": [
    {
      "packKey": "GBC0314:1", "dpuKey": "GBC0314",
      "rawValue": 98.0, "rawSigma": 3.0,
      "posteriorMean": 97.4, "posteriorSigma": 1.2,
      "shrinkageToDpu": 0.31
    }
  ],
  "dpuMeans": { "GBC0314": 97.6, "GBC0482": 98.1 },
  "fleetMean": 97.8,
  "sigmaWithinDpu": 1.1,
  "sigmaWithinFleet": 0.4,
  "outlierPackKeys": [ "GBC0482:4" ]
}
```

#### CONFIG knobs + defaults

No env knobs. The z-threshold is a call-time argument (`2.0` at the endpoint);
the per-obs σ formula (`max(0.3, 3.0 − min(2.5, cycles/500))`) and the 10%
winsorization fraction are compile-time.

#### EDGE CASES / guards / honest-null

- **No observations** → empty fit (`packs: []`, `fleetMean: 0`, σ's 0).
- **Single-pack DPU / single DPU** → within-group σ falls back to `1` (can't
  estimate spread from one point).
- **σ = 0 observation** → clamped to a 1e-3 floor (avoids infinite precision
  pinning), and all precisions floor divisors at `1e-9`.
- **Null SoH packs skipped**, never fabricated to 0.

---

### 4. Recursive Bayesian Solar Model (`computeBayesianSolarModel`)

#### WHAT + why

A **recursive Bayesian** estimate of the array's GHI→PV response coefficient β
(watts of PV per W/m² of irradiance), maintained **per hour-of-day**. It answers
the same question as the learned OLS solar-response model, but with a full
posterior (mean + variance + 95% CI) instead of a point slope — and it
explicitly reports how often it **agrees with OLS**, so a divergence between the
two is a visible signal that one of them is mis-fit.

#### The prior and the observation model

Per hour-of-day slot, the coefficient β is `Normal(μ, τ²)`, seeded with a
deliberately vague prior so the first observations dominate:

```
BAYES_PRIOR_MU   = 0        // "no clue"
BAYES_PRIOR_TAU2 = 1000     // huge prior variance → first obs dominates
```

Each daylight hour contributes one observation: measured PV `p` at irradiance
`g` (GHI). The observation model is `p ≈ β·g` with Gaussian noise σ². The
observation noise is pinned to the **signal scale** (10% of nameplate), which is
the whole reason the filter behaves like a filter:

```
BAYES_OBS_SIGMA2 = (0.10 · PHOENIX_SITE.pNamplate)²
                 = (0.10 · 16 800)² = 1 680² ≈ 2.82e6      (σ ≈ 1 680 W)
```

The in-code note (v0.9.59) explains why: the original placeholder σ² = 50 (σ ≈ 7 W)
made every single observation's information weight `g²/σ²` swamp the prior in one
update — e.g. at GHI 500, `500²/50 = 5000` — collapsing the posterior onto the
latest sample and defeating the point of a recursive filter. At σ² ≈ 2.82e6 the
same update contributes precision `500²/2.82e6 ≈ 0.089`, so the prior
(`1/1000 = 0.001`) is overwritten over *dozens* of observations, not one.

#### THE CALCULATION

**The recursive update (`bayesUpdate`)** — conjugate Gaussian precision update
for the through-origin regression coefficient:

```
newPrecision = 1/τ² + g²/σ²
newTau2      = 1 / newPrecision
newMu        = newTau2 · ( μ/τ² + (g·p)/σ² )
```

(The `g²` weighting is the linear-model twist: a high-irradiance observation is
more informative about the *slope* β than a low-irradiance one.)

**`computeBayesianSolarModel(devices, recorder)`:**

1. Pull weather (GHI series) and build `wxByHourEpoch`. Return empty if no
   weather.
2. Build **fleet PV per hour-epoch** from the recorder, summed over the
   **home-connected DPUs only** (`homeConnectedDpus`) — a spare's bench-charge PV
   would bias the prior away from what the connected arrays actually produce (v0.9.76).
3. Initialize 24 hour-of-day slots at the prior `(μ=0, τ²=1000)`.
4. Walk observations in **time order**; for each, skip if no weather or
   `GHI < DAYLIGHT_GHI` (20 W/m²); else fold in with `bayesUpdate` into that
   slot, incrementing `samples`.
5. For each hour with `samples ≥ 2`, emit the posterior: `stdev = sqrt(τ²)`,
   `ci95 = μ ± 1.96·stdev`.
6. **Cross-check vs OLS**: build the OLS response over the same history
   (`buildSolarResponse`) and count a slot as "agreeing" when
   `|olsCoeff − μ| ≤ stdev`; report the fraction.

#### THE CALCULATION — history + cache constants

```
BAYES_HISTORY_MS = 60 days
BAYES_TTL_MS     = 30 min           // in-process cache
DAYLIGHT_GHI     = 20 W/m²          // shared night gate
```

#### TRACE

- **In:** recorder PV history (`pv_total` per home DPU) + weather GHI
  (`getWeather()`), 60-day window.
- **Compute:** `computeBayesianSolarModel` (registered as the `bayesianSolar`
  report in `reports.ts`: `bayesianSolar: (ctx) => computeBayesianSolarModel(...)`).
- **Out:** `GET /api/forecast/bayesian` → `analytics.report('bayesianSolar')`,
  HTTP-cached 60 s (module-level cache 30 min). Also consumed internally by the
  curtailment report (`analytics.ts` ~L6563) to derive `pvExpectedW` /
  `bayesianSamples`.

#### OUTPUT shape (`/api/forecast/bayesian`)

```jsonc
{
  "generatedAt": 1752607200000,
  "hourly": [
    {
      "hour": 12,
      "posteriorMean": 26.4,     // μ — W of PV per W/m² of GHI
      "posteriorStdev": 3.1,     // sqrt(τ²)
      "ci95Low": 20.3,           // μ − 1.96τ
      "ci95High": 32.5,          // μ + 1.96τ
      "samples": 47
    }
  ],
  "totalSamples": 512,
  "medianStdev": 3.4,
  "agreementWithOls": 0.83       // fraction of hours within 1σ of OLS coeff
}
```

#### CONFIG knobs + defaults

No env knobs; all four `BAYES_*` constants and `DAYLIGHT_GHI` are compile-time.
`BAYES_OBS_SIGMA2` is *derived* from `PHOENIX_SITE.pNamplate`, so it automatically
tracks the site nameplate.

#### EDGE CASES / guards / honest-null

- **No DPUs / no weather** → `empty()` (empty `hourly`, zero aggregates).
- **Hours with `< 2` samples** are omitted entirely — no low-confidence slot is
  published.
- **Night / near-night** (`GHI < 20`) observations are dropped.
- **`agreementWithOls`** is 0 when no OLS coefficient exists to compare against
  (`agreementDenom = 0`), not a fabricated value.

---

### 5. How the physics/Bayesian tier cross-checks the learned engines

The physics tier is not a replacement for the learned engines — it is their
**referee**. The relationships:

| Physics / Bayesian model | Learned counterpart | Cross-check |
| --- | --- | --- |
| Clear-sky `physicsScore` (realized / clear-sky max) | Cloud-aware / probabilistic PV **forecast** | The forecast's predicted PV fraction *should* track the realized physics fraction; a persistent gap means the forecast is mis-tuned (as documented in `clearSky.ts`). |
| Bayesian GHI→PV posterior (`bayesianSolar`) | **OLS** solar-response (`buildSolarResponse`, through-origin `Σ(pv·ghi)/Σ(ghi²)`) | `agreementWithOls` = fraction of hours whose OLS slope lies within 1σ of the Bayesian μ. Low agreement flags a modeling problem in one of them; the Bayesian version adds calibrated uncertainty the OLS point slope lacks. |
| LFP OCV physics SoC (`socDriftPct`) | **BMS-reported SoC** / Kalman SoH filter | A rested physics SoC that persistently disagrees with reported SoC (`socDriftPct ≠ 0`) points at BMS SoH miscalibration — the same fade the Kalman filter (`kalmanFilterSoh`, 2-state constant-velocity, `R = 0.05`) tracks from a different angle (reported-SoH time series). |
| Hierarchical Bayes pack SoH (partial pooling + 2σ outliers) | **Kalman per-pack SoH** and heuristic PackRiskScore | The hierarchical fit is a *cross-sectional* (fleet-at-one-instant) view that flags a pack anomalous **relative to its siblings**; the Kalman filter is a *longitudinal* (single-pack-over-time) view of the same SoH. Agreement between "outlier now" and "declining over time" is strong corroboration; disagreement warrants a look. |

The unifying design rule across the whole tier — stated repeatedly in the source
(`restTracker.ts`, `lfpOcv.ts` plateau fix, `hierarchicalBayes.ts` null-skip,
`computeBayesianSolarModel` empty-return) — is **emit `null` / omit rather than
fabricate**: a physics estimate is only published when its physical
preconditions (sun up, pack rested, ≥2 samples, non-null SoH) are actually met.


---

## 5. Runway, Depletion & Battery-SoC Alarms (safety-critical)

This cluster is the life-safety heart of the add-on: the engines that decide **when the home is at risk of losing power** and **when to make an audible alarm**. Four cooperating modules are documented here:

| Module | File | Role |
| --- | --- | --- |
| Runway depletion sim | `analytics.ts` (`computeRunway`) | Hour-by-hour DC-pool depletion projection → `hoursToReserve` / `hoursToEmpty` |
| Runway audible alarm | `runwayAlarm.ts` (`classifyRunway`, `createRunwayAlarm`) | Maps a runway projection to an ISA priority and drives the dedicated audible path |
| Battery-SoC floor alarm | `batterySocAlarm.ts` | The 50/40/30/20/15/10/8/4/2 % descending-crossing ladder |
| Grid backstop resolver | `gridState.ts` (`resolveGridBackstop`, `liveGridBackstop`) | Answers "is the grid carrying the home right now?" — the input that re-escalates islanded vs grid-backed |
| Load-shed advisor | `loadShedAdvisor.ts` | Advisory-only counterfactual: "shed X, runway extends to Y" |
| Grid dispatch helpers | `socGridDispatch.ts` | Pure SoC grid-downgrade + grid-drop re-escalation logic |

Two overarching **safety invariants** govern the whole cluster and are repeated throughout the source:

1. **Conservative PV basis, never optimistic.** The depletion sim reads *only* the reporting-only forecast PV series (live-present home Cores). Any restored/estimated/scaled PV would lengthen runway and under-alarm during a wedge. This is pinned by `runwayPvBasisGuard.test.ts`.
2. **Fail toward "off-grid / still an emergency."** Every grid-presence signal defaults to *not present / not backstopping* when missing, stale, or unknown. A false "grid is fine" that silences a real off-grid emergency is the one outcome the code refuses; an extra alert when the grid was actually fine is merely annoying.

---

### 1. The runway depletion simulation — `computeRunway`

#### 1.1 What it does + why

`computeRunway` (analytics.ts ~L2973) projects the SHP2 backup pool forward hour-by-hour over a 24 h horizon and reports **how many hours until the pool reaches its reserve floor (`hoursToReserve`) and until it hits empty (`hoursToEmpty`)**, given the recent load and the forecast solar. This is the "act now so we last until the sun comes back" signal that the SoC-threshold ladder (§3) cannot give — the ladder only fires once the pool has *already* fallen to a threshold, whereas the runway sim fires while the pool is still healthy but the (PV − load) trajectory is headed below reserve before solar recovers.

#### 1.2 Inputs

| Input | Source | Notes |
| --- | --- | --- |
| `backupRemainWh`, `backupFullCapWh` | SHP2 projection (`backupIncreInfo` aggregate) | Pool remaining / full capacity, Wh → kWh |
| `backupReserveSoc` | SHP2 projection | Reserve floor %, **default 15** if null |
| `panel_load` (last hour) | Recorder series on `shp2.sn` | Averaged over `RUNWAY_LOAD_WINDOW_MS` = 60 min |
| `forecast.hours[h].forecastPvW` | `getDayForecast` (reporting-only `solarModel`) | Per-hour PV, first 24 h |
| `forecast.hours[h].forecastLoadW` | `getDayForecast` diurnal/day-of-week load curve | Per-hour load |
| `forecast.hours[h].predictedEvLoadW` | `getDayForecast` EV window prediction | **Subtracted out** of the alarm load (see §1.5) |

#### 1.3 The calculation, step by step

**Step 0 — cache.** Returns the cached projection if it is younger than `RUNWAY_TTL_MS` = 60 s.

**Step 1 — pool state.**
```
backupRemainingKwh = backupRemainWh / 1000
backupFullKwh      = backupFullCapWh / 1000
reservePct         = backupReserveSoc ?? 15
backupReserveKwh   = backupFullKwh * reservePct / 100
```
If the SHP2 or either capacity field is missing → early return `emptyRunway(..., 'SHP2 backup-pool capacity not yet reported')` (all hours null, `unavailable` set).

**Step 2 — recent load anchor.** Average `panel_load` over the last hour. If fewer than 2 recorded samples exist (sparse post-restart window), fall back in order to:
1. Live SHP2 panel load = Σ circuit watts (available from MQTT immediately),
2. a single recent recorded sample,
3. the last good `runwayCache.value.recentLoadWatts`,
else early-return `emptyRunway(..., 'panel-load history insufficient — wait a few minutes')`. This keeps the sensor numeric instead of flapping to HA `unknown`/`unavailable` on an islanded home.

**Step 3 — build the per-hour PV and load arrays** (24 entries each). PV = `forecastPvW/1000`. Load = `max(0, forecastLoadW − predictedEvLoadW)/1000`, falling back to the trailing average when a forecast hour carries no modelled load. Arrays are padded to 24 h (PV→0, load→trailing average).

**Step 4 — degenerate-curve guard.** If the mean modelled load `curveMeanKw < LOAD_CURVE_MIN_PLAUSIBLE_KW` (0.05 kW = 50 W), the whole curve is data failure (a post-boot worker built the forecast from zero `panel_load` rows). Set `loadModelDegraded = true` and fill the entire horizon with the observed load average. No real occupied home averages < 50 W.

**Step 5 — observed-load anchor blend** (near-term hours). For the first `RUNWAY_BLEND_HOURS` = 4 hours:
```
w = 1 − h/4               // 1, .75, .5, .25
loadByHour[h] = max(loadByHour[h], loadAvgKw*w + loadByHour[h]*(1−w))
```
The `max()` means a lighter-than-modelled day never becomes *more* optimistic, and a transient burst decays out by hour 4 so it cannot dominate the far horizon. This closed a live failure where the day-of-week curve ignored a *sustained* real 5–9 kW draw against a ~3 kW modelled hour and a recompute muted the alarm.

**Step 6 — the DC-bus depletion loop** (the core math). For each hour h ∈ [0,24):
```
delta   = pvKwh − loadKwhPerHour / RUNWAY_DISCHARGE_EFFICIENCY
nextState = stateKwh + delta
```
This is the **v1.26.0 DC-bus pool-drain accounting**: PV enters the DC bus at ~unity (MPPT); the AC home load is pulled through the inverter at `1/η_dis`; so the pool changes by `pv − load/η` per hour. It is deliberately **not** `(pv−load)/η` — that would wrongly divide the PV credit by η and stay optimistic whenever pv>0 (e.g. `pv==load` must still drain at `load·(1−1/η)`).

Crossings are captured with linear interpolation within the crossing hour:
```
if hoursToReserve==null and stateKwh > reserve and nextState <= reserve:
    frac = delta<0 ? (stateKwh − reserve)/(−delta) : 1
    hoursToReserve = h + clamp(frac, 0, 1)

if hoursToEmpty==null and stateKwh > 0 and nextState <= 0:
    frac = delta<0 ? stateKwh/(−delta) : 1
    hoursToEmpty = h + clamp(frac, 0, 1)

stateKwh = max(0, nextState)
```
`totalForecastPv` and `totalLoad` accumulate the **raw** (reporting-basis) PV/load, so the reported `forecastPvUsedKwh` / `loadHorizonKwh` stay on the reporting basis even though the drain uses the η-corrected delta.

**Step 7 — empty hysteresis** (see §1.6). `pubHoursToEmpty = applyEmptyHysteresis(hoursToEmpty, runwayEmptyState)`.

#### 1.4 Key constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `RUNWAY_HORIZON_HOURS` | 24 | Projection horizon |
| `RUNWAY_LOAD_WINDOW_MS` | 60 min | Recent-load averaging window |
| `RUNWAY_TTL_MS` | 60 s | Recompute throttle |
| `RUNWAY_BLEND_HOURS` | 4 | Observed-load anchor decay length |
| `LOAD_CURVE_MIN_PLAUSIBLE_KW` | 0.05 kW | Degenerate-curve threshold |
| `RUNWAY_DISCHARGE_EFFICIENCY` | 0.94 (default) | DC→AC discharge efficiency η; `min(1, max(0.8, env ?? 0.94))`, env `RUNWAY_DISCHARGE_EFFICIENCY` |
| `RUNWAY_EMPTY_CLEAR_SAMPLES` | 3 (default) | Empty-hysteresis latch length; env `RUNWAY_EMPTY_CLEAR_SAMPLES` |
| `RUNWAY_NO_DEPLETION_SENTINEL_H` | 999 | Healthy-but-no-depletion publish sentinel |

`RUNWAY_DISCHARGE_EFFICIENCY` default 0.94 is marginally conservative vs. the measured ~0.945 7-day RTE. It is clamped to `[0.80, 1.0]` so a bad env can never lengthen runway beyond the true (unity) reading or collapse it to an untrusted extreme. Because the η correction is applied to the deficit only and `delta ≤` the pre-v1.26 unity delta for all pv,load, **runway can only ever shorten-or-equal** — preserving the `runwayPvBasisGuard` "monotonic in forecastPvW" invariant.

#### 1.5 The PV-basis and predicted-EV safety invariants

Two deliberate exclusions keep the alarm evidence-based and never optimistic:

- **Reporting-only PV (v0.78.0 invariant).** `pvByHour` reads *exclusively* `forecast.hours[h].forecastPvW`, built from the reporting-only `solarModel`. The higher *display* basis (`forecastPvWhNext24Display`, `typicalPvWhPerDayDisplay`, `restoredSolarModel`) exists **solely** for the display tiles and must never be read here — a higher PV input lengthens runway and would under-alarm during a wedge.
- **Predicted-EV stripped (v0.15.21).** The forecast folds speculative EV sessions into `forecastLoadW` (right for planning), but the sim subtracts `predictedEvLoadW` so it never treats "the car usually charges tonight" as certain load — that roughly doubled the modelled draw on nights the EV never plugged in and produced a false red voice alarm. If the car *is* charging, the observed-load anchor (Step 5) carries the real draw and the 60 s recompute keeps it current.

#### 1.6 Empty hysteresis — `applyEmptyHysteresis`

Asymmetric latch on the `hoursToEmpty → 999 sentinel` transition **only**. A finite empty crossing sits at the far edge of the 24 h horizon, so minute-to-minute jitter tips it across the boundary ~30×/window, churning the recorder and history UI.

```
applyEmptyHysteresis(hoursToEmpty, state, clearSamples=3):
  if hoursToEmpty != null:            # real depletion → publish immediately, arm latch
      state.streak = 0; state.lastFinite = hoursToEmpty; return hoursToEmpty
  if state.lastFinite != null:        # optimistic finite→none direction
      if ++state.streak < clearSamples: return state.lastFinite   # hold
      state.lastFinite = null          # streak satisfied → release to sentinel
  return null
```
It **only damps the optimistic direction** (finite→none): a real depletion (none→finite) publishes immediately and is never delayed. A briefly-held stale finite is *pessimistic* (over-warns), never optimistic.

#### 1.7 Degenerate / honest-null behavior

| Condition | Output |
| --- | --- |
| SHP2 or capacity missing | `emptyRunway`, `unavailable='SHP2 backup-pool capacity not yet reported'`, all hours null |
| < 2 load samples and no live fallback | `emptyRunway`, `unavailable='panel-load history insufficient — wait a few minutes'` |
| Degenerate load curve (< 50 W mean) | Runs whole horizon on observed load; `loadModelDegraded=true` |
| Healthy, no depletion projected | `hoursToReserve`/`hoursToEmpty` = `null`; published via `runwayHoursForPublish` as **999** so HA can distinguish "plenty of runway" from data-loss `unknown` |
| Genuinely unavailable | Hours = `null` (HA shows `unknown`) |

`runwayHoursForPublish(hours, unavailable)`: returns `hours` if finite; else `999` when `unavailable==null` (healthy no-depletion), else `null` (real outage → HA `unknown`).

#### 1.8 Outputs + endpoint

`RunwayProjection` shape (analytics.ts ~L2878):
```
{
  generatedAt, backupRemainingKwh, backupReserveKwh, backupFullKwh,
  recentLoadWatts, hoursToReserve, hoursToEmpty, reserveAtMs, emptyAtMs,
  forecastPvUsedKwh, loadHorizonKwh, horizonHours, unavailable, loadModelDegraded
}
```

| Sink | Where |
| --- | --- |
| REST | `GET /api/runway` → `analytics.report('runway')`, 30 s HTTP cache (index.ts L614) |
| MQTT | `runway_to_reserve_hours` / `runway_to_empty_hours` in buildState (index.ts L1266, mqttDiscovery.ts L744) via `runwayHoursForPublish` |
| HA sensors | `sensor.ecoflow_runway_to_reserve` (`ecoflow_runway_to_reserve_hours`, unit h, mdi:timer-sand); `sensor.ecoflow_runway_to_empty` (`ecoflow_runway_to_empty_hours`, unit h, mdi:timer-off) |
| Audible alarm | Consumed by `runwayAlarm.update` on a 2-min tick (§2) |
| Load-shed advisor | Consumed by `loadShedAdvisor.update` (§5) |

---

### 2. The runway audible alarm — `classifyRunway` + grid-aware severity

#### 2.1 What it does

`runwayAlarm.ts` maps a `RunwayProjection` to an ISA `AlarmPriority` (low/medium/high/critical) and drives a **dedicated audible path** (`broadcast.announce` directly), not the alert→condition→broadcast pipeline — so it still annunciates when the operator's broadcast min-severity is `critical`. The matching on-screen alert is `forecast-runtime-*` (analytics.ts §4), which is excluded from the broadcast condition so the two never double-chime.

#### 2.2 The severity ladder — `classifyRunway(p, grid?)`

Two special cases first, then the standard ladder:

**At/below the reserve floor** (`belowReserveFloor`: `backupRemainingKwh <= backupReserveKwh`, both non-null, reserve > 0):
- grid **backstopping** → `low` (advisory: pool transferred to mains, non-event)
- otherwise → `critical` (the genuine "no backstop at the floor" emergency — the SHP2 cuts non-backup circuits here)

This fixed a real regression where the old ranking *de-escalated* to `high` once the floor crossing was behind us ("high — reserve in 18.8 h" while pinned at the floor).

**Not yet at the floor:**
- grid **backstopping** → `null` (silent audible; the grid will carry the load once the pool reaches the floor — the on-screen "approaching reserve" alert still shows).
- otherwise, the standard escalation-by-urgency ladder:

| Condition | Priority |
| --- | --- |
| `hoursToEmpty ≤ 3` | **critical** |
| `hoursToEmpty ≤ 8` | **high** |
| `hoursToReserve ≤ 6` | **medium** |
| `hoursToReserve` finite (any) | **low** |
| else / `unavailable != null` | `null` |

EMPTY escalates harder than RESERVE because empty is the harder failure. `unavailable != null` always returns `null` (no alarm on a data outage).

#### 2.3 Grid presence — how it re-escalates islanded vs grid-backed

The `grid?: GridContext` argument (`{present, backstopping}`) is resolved live by `liveGridBackstop(devices)` (§4) and passed in on every tick. **Omitted ⇒ treated as off-grid** (the safe default: floor stays critical). The distinction that matters is `backstopping` (grid actively carrying the load *now*), not merely `present` — a grid *declared* present but not carrying (pool still net-discharging) keeps the full ladder so a genuine fast depletion still annunciates.

#### 2.4 The alarm state machine — `createRunwayAlarm`

`update(p, grid)` computes `desired = classifyRunway(p, grid)` and:

- **`desired == null`** (recovered/unavailable) → re-arm so the next descent announces fresh, **but not during warm-up**: for the first `REARM_WARMUP_MS` = 10 min after process start, a null projection must NOT re-arm (post-boot projections are computed from half-warm inputs and had been silently clearing active alarms).
- **entering / escalated / stale** → announce. `entering` = no prior priority; `escalated` = `RANK[desired] > RANK[announced]`; `stale` = `now − lastAnnouncedAt ≥ reannounceMs`. Re-announce cadence `RUNWAY_ALARM_REANNOUNCE_MS` = `max(1, BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN ?? 60) × 60 s` (default 60 min).
- **de-escalation** (`RANK[desired] < RANK[announced]`) is held: a calmer tier must persist `ALARM_DEESCALATE_HOLD_MS` = 10 min before the latch steps down. This stopped a projection hovering at the critical↔high boundary (`hoursToEmpty` oscillating around 3.0 h while the EV charged) from re-announcing the *same* critical message on every re-cross (household heard it 4+ times in under an hour). Escalations are always immediate.

State (`{announcedPriority, lastAnnouncedAt, calmerSinceMs}`) is persisted atomically to `runway-alarm.json` (env `BATTERY_RUNWAY_ALARM_PATH`) so a restart mid-event doesn't re-announce. The clock uses the projection's own `generatedAt`, making it deterministic under test.

#### 2.5 Spoken messages

`runwayAlarmMessage(p, priority, grid)` produces context-appropriate speech (English + a Spanish second pass via `runwayAlarmMessageEs`):
- floor + grid backstopping → *"Advisory. Backup pool reached the reserve floor. Now drawing from grid power; no action needed."*
- critical + at floor → *"Critical alarm. Critical alarm. Backup pool is at the reserve floor. Non-backup circuits may lose power. Shed load or start the generator."*
- critical + `hoursToEmpty` → *"…projected empty in about N hours before solar recovers. Shed load immediately."*
- high + `hoursToEmpty` → *"…projected to deplete in about N hours… Reduce load now."*
- else → *"…projected to reach reserve in about N hours at the forecast load. Reduce consumption…"* (severity prefix leads).

#### 2.6 Reaching the audible path (index.ts)

A 2-min `setInterval` (index.ts L2050) runs: refresh the grid entity (TTL-gated) → `r = analytics.report('runway')` → `runwayGridForTick = liveGridBackstop(store.get().devices)` (assigned synchronously *before* update so `onTrigger` reads the same grid state the classifier saw) → `runwayAlarm.update(r, runwayGridForTick)`.

`onTrigger(priority, message, messageEs)`:
1. `if (!isPriorityEnabled(priority)) return;` — honours the per-priority Alert-Settings annunciation toggles.
2. **`if (shouldGateRunwayAudible(runwayGridForTick)) return;`** — `shouldGateRunwayAudible` returns `grid.backstopping === true`. This is a belt-and-braces **audible-only** mute while the grid actively backstops (in case a transient `backstopping=false` let the classifier reach critical). Push + on-screen are untouched; off-grid → no-op.
3. `broadcast.announce(priority, message, messageEs)`.

Enabled unless `BATTERY_RUNWAY_ALARM_ENABLED=false`.

---

### 3. The battery-SoC floor alarm — `batterySocAlarm.ts`

#### 3.1 What it does

Fires an escalating audible announcement when the SHP2 backup-pool SoC crosses **down** through a threshold, with priority rising as the reserve gets lower. Like the runway alarm it is a **dedicated audible path** (`broadcast.announce` directly), because the normal pipeline only chimes for warning/critical and the user wants the 40 %/30 % (low-priority) crossings audible too. The matching on-screen alert is emitted by `alerts.ts` (and excluded from the broadcast condition so it never double-chimes).

#### 3.2 The SoC ladder — `BATTERY_SOC_THRESHOLDS`

| SoC % | Priority |
| --- | --- |
| 50 | low |
| 40 | low |
| 30 | low |
| 20 | medium |
| 15 | medium |
| 10 | **critical** |
| 8 | **critical** |
| 4 | **critical** |
| 2 | **critical** |

10 % and 8 % are **critical, not high** (audit #24): `alerts.ts`'s `shp2-below-reserve` classifier treats any SoC under the default `backupReserveSoc ?? 15` floor as critical while off-grid, and 10 %/8 % sit below 15 %. A `high` here would have let a user who muted only "High" go silent on a genuinely reserve-floor-critical SoC. Reconciled upward only. (Note: `backupReserveSoc` is user-configurable; a reserve set far from the 15 % default can still let this fixed ladder diverge from the floor classifier at other pcts — this targets the concrete default-config off-grid disagreement.)

#### 3.3 Crossing detection, arming & hysteresis

`update(socPct, nowMs)`:
1. **Null/non-finite SoC → no-op** (return).
2. **Coherence / slew guard** (see §3.4).
3. **First real reading with no persisted state** → arm only thresholds the battery is currently *above* (so a boot at 18 % doesn't re-announce 40/30/20), set baseline, persist, return.
4. **Gather all newly-crossed armed thresholds this tick.** A band is crossed when `armed && soc <= t.pct` (then disarmed). A band **re-arms** when `!armed && soc >= t.pct + REARM_MARGIN_PCT` (`REARM_MARGIN_PCT` = 2). The 2-point margin stops a value sitting exactly on a boundary from chattering.
5. **Announce ONCE for the most-severe band crossed** (v0.75.0). Since thresholds descend by pct, the last crossed entry is the lowest pct = highest priority. `onCross(t, isPrimary)` still fires for **every** crossed band (so per-band bookkeeping stays complete) with `isPrimary=true` only on the worst; the consumer announces only when `isPrimary`. This collapses a same-tick multi-band crossing (a long-offline source returning at low SoC, or a fast discharge spanning bands in one ~60 s poll) to a single audible. A normal gradual discharge (one band per tick) is unchanged, and **the most-severe crossed band is always announced** — nothing real is suppressed.

#### 3.4 Coherence guard vs. transient zero (v0.54.4)

The physical-plausibility guard prevents the SHP2's `backupIncreInfo` briefly reading 0 on an EcoFlow-cloud reconnect from laddering the whole 50→2 % cascade (as it did on 2026-06-21 18:12). A single-tick drop is ignored (not fired, and the baseline is **not** advanced, so it self-heals the instant a real read returns) when **all** of:
```
initialized && lastSoc != null && lastSocAtMs != null
&& nowMs − lastSocAtMs <= SLEW_BASELINE_MAX_AGE_MS   (10 min)
&& lastSoc >= HEALTHY_BASELINE_PCT                    (30 %)
&& lastSoc − soc > MAX_PLAUSIBLE_DROP_PCT             (25, env BATTERY_SOC_MAX_DROP_PCT)
```
The guard **only** fires from a *fresh, healthy* baseline: a real deep discharge reaches 0 from an already-low (< 30 %) baseline where the guard is inactive and the critical bands must still fire; and a real discharge is gradual (each tick well under the cap). The `SLEW_BASELINE_MAX_AGE_MS` bound means that after a long gap (restart / hours cloud-offline) the stale baseline is not trusted — the first fresh read re-baselines instead of being wrongly rejected. This is the depth backstop for the rare perfectly-coherent zero the source coherence gate (`ecoflow/project.ts coherentBackupPool`) can't distinguish from a real empty pool.

#### 3.5 State persistence

`{armed: Record<pct,bool>, lastSoc, lastSocAtMs}` persisted atomically to `battery-soc-alarm.json` (env `BATTERY_SOC_ALARM_PATH`). Persisted on any crossing/re-arm, or on the `BASELINE_PERSIST_THROTTLE_MS` = 5 min throttle so the on-disk baseline stays fresher than `SLEW_BASELINE_MAX_AGE_MS`, keeping the slew guard active across a quick restart (SHP2 reconnects often coincide with add-on restart boundaries).

#### 3.6 On-screen banding helpers (pure, consumed by alerts.ts)

- `activeSocBand(socPct)` — highest-pct threshold at/below the SoC (the single on-screen "backup low" band).
- `activeSocBandWithHysteresis(socPct, prevBandPct)` (v1.17.0/F15) — adds the ladder's 2 % re-arm margin to the on-screen band. A deeper crossing takes effect immediately; the held band clears/ascends only once SoC climbs *above* `band + 2`. Pure banding had 399 on-screen rises in 30 days vs ~115 real crossings (3.5× churn) polluting cleared-history and the auto-silencer's training data.
- `socAlertSeverity(priority)` — stamps `{severity, source:'threshold', priority}` so the web/TUI `priorityOf()` derives the same ISA tier as the audible. Always `source:'threshold'` (a real measurement, not a learned forecast); Medium is carried by an explicit `priority` field rather than faking `source:'learned'`.

#### 3.7 SHP2-blind failover (index.ts, v1.8.0/F3)

The ladder reads only the SHP2 backup-pool %, which nulls when the SHP2 goes cloud-offline; the 30-day review found blackouts (42.2 h, 25.8 h) in which the pool crossed 50/40/30/20 % while the ladder sat dark for 17.8–20.8 h. When `backupBatPercent` is null, index.ts falls back to `homeFleetMeanSoc(devices)` (the pool *is* those batteries). It returns null only when no Core is reporting, where `update(null)` is a safe no-op and the reserve-blind warning + offline alerts are the signal.

---

### 4. Grid backstop resolver — `gridState.ts`

#### 4.1 What it does + why

The SHP2 cloud telemetry exposes **no** grid-presence field (no line voltage, no transfer/bypass state, no on-grid/island flag). The only on-device grid signal was grid *import* watts, and that reads zero whenever PV/battery covers the load even when the mains are live. So "is the grid energized, even if unused" must come from an operator-provided HA entity, corroborated by live import. `resolveGridBackstop` answers one question for the floor/runway/SoC alarms: **is the grid backstopping the home right now**, such that the pool reaching its reserve floor merely transfers to mains (non-event) rather than risking a local outage (emergency)?

#### 4.2 Signals combined (`resolveGridBackstop`)

| Signal | Function | Threshold |
| --- | --- | --- |
| DPU AC-in import | `computeGridImportWatts` | `GRID_IMPORT_WATTS` = 5 W; scoped **strictly** to SHP2 source SNs; **0 if source identity unknown** (a wall-charging spare must not masquerade as house grid) |
| SHP2 main-line grid | `computeHomeGridWatts` (`wattInfo.gridWatt`) | `HOME_GRID_IMPORT_WATTS` = 25 W; **0 if SHP2 offline** (frozen sample must not fabricate presence) |
| SHP2 own grid flag | `computeShp2GridConnected` (`pd303_mc.masterIncreInfo.gridSta`, value-1-only) | true=Grid OK / false=islanded / null=unknown; **null if SHP2 offline**; burst-gap immune |
| HA entity | `interpretGridEntity(GRID_PRESENCE_ENTITY)` | on/true/home/…→present; numeric voltage >50→present; unavailable/unknown→null |
| Standing declaration | `GRID_AVAILABLE=true` | Coarse fallback when no entity configured |

Derived flags:
```
importLive = importWatts ≥ 5 OR homeGridWatts ≥ 25          # positive, unambiguous
declared   = entity configured ? (entityPresent === true) : gridAvailableFallback
present    = importLive OR declared OR shp2GridConnected===true
```

#### 4.3 The `backstopping` decision (stricter than `present`)

`backstopping` = safe to downgrade the floor to advisory. It requires the grid to actually be **carrying** the load. Two floor-scoped guards distrust a merely-declared grid:

- **`poolDischargingAtFloor`** — `poolDischarging && atReserveFloor`. `poolDischarging = (aggregateFleetFlow.fleetBatteryNet > POOL_DISCHARGE_WATTS=50) OR !homeCoreCoverage.complete`. At the reserve floor a present grid must have transferred and the pool must stop draining; if it keeps draining (or the roster is incomplete so drain is unobservable — v1.3.0 coverage gate: "we can PROVE discharge from a partial sum but never DISPROVE it"), the declared grid isn't really there. (The old `chargeWattPower < −50` check was permanently dead — that field is a non-negative configured charge *limit* ~7.2 kW even when idle.)
- **`floorWithoutFlow`** — `atReserveFloor && importWatts==0 && homeGridWatts==0`. A stale "grid available" toggle with no measured flow must not mute a real at-floor outage.

```
gridStaBackstop = shp2GridConnected===true && !poolDischargingAtFloor   # exempt from floorWithoutFlow (live device signal)
backstopping    = importLive
               OR gridStaBackstop
               OR (declared && !poolDischargingAtFloor && !floorWithoutFlow)
```
Away from the floor, a flow-less declaration remains a valid backstop (grid available, not yet needed) so a self-consumption home doesn't nuisance-escalate every evening.

#### 4.4 Staleness fail-safe (`liveGridBackstop`)

`liveGridBackstop(devices)` reads env + HA cache. A configured grid entity older than `GRID_ENTITY_MAX_AGE_MS` = 120 s (`getCacheAgeMs` since the last *successful* fetch) is treated as **UNKNOWN, not its frozen value** — when HA is unreachable (Pi reboot / network partition / token expiry, exactly when the grid may be down), replaying a stale "on" is the one false "grid is fine" the safety posture forbids. `atReserveFloor` is derived from `socPct = backupRemainWh/backupFullCapWh × 100 ≤ backupReserveSoc + 1.5` (the 1.5 % slack absorbs SoC quantisation jitter).

#### 4.5 Grid-aware priority downgrade + SoC dispatch (`socGridDispatch.ts`)

`downgradePriorityForGrid(p, backstopping)`: collapses `critical`/`high` → `low` when backstopping; medium/low unchanged (already non-emergency).

- `socGridCrossDecision(t, backstopping)` → `{priority, onGrid}` where `onGrid = priority !== t.priority`. `onGrid=true` means the consumer must **record** the crossing's true priority in the `socDowngraded` map so a later grid drop can restore it.
- `reEscalateGridDrop(socDowngraded, soc, backstopping, isPriorityEnabled)` — the grid-drop re-escalation pass. Deletes any band the pool climbed back above; and when the grid is **not** backstopping, deletes and returns every still-active downgraded band so the consumer re-announces it at its **true** priority. This closes the one-shot fail-silent window: the SoC ladder fires once per downward crossing, so without re-escalation a grid drop while the pool sits in a downgraded band would never re-fire.

In index.ts the SoC alarm's `onCross` uses `socGridCrossDecision`, records/clears `socDowngraded` for **every** crossed band (not just the primary), and the store-change handler runs `reEscalateGridDrop` each tick. This self-heals on the ~60 s REST poll cadence even under a total MQTT stall (the poll loop unconditionally emits 'change').

---

### 5. Load-shed advisor — `loadShedAdvisor.ts`

#### 5.1 What it does

Advisory-only (**never actuates**). Reads the runway projection + live HA device state + SHP2 circuit watts, decomposes the load, and emits a recommendation like *"shed pool pump + EVSE, runway extends from ~3.5 h to up to ~8 h."* The operator's own HA automations consume it. It **reuses `classifyRunway()` verbatim** so shed bands line up exactly with the audible runway alarm, and it is passed the same live grid backstop so it stays grid-aware.

#### 5.2 The counterfactual — `computeRunwayWithShedOffset`

Given `shedWatts`, backs the average net pool-drain rate out of the projection's own energy/time and re-derives the time after removing the shed power. It is an **UPPER BOUND** (assumes the shed load drew across the whole horizon), so results are labeled `isUpperBound` and phrased "up to".
```
shedKw = max(0, shedWatts)/1000
netKw  = energyKwh / hours                       # gross pool-drain rate (delivered/η)
newNetKw = netKw − shedKw / RUNWAY_DISCHARGE_EFFICIENCY   # v1.26 pool-basis consistency
if newNetKw <= 0.001: return null                # shedding ≥ net draw → no depletion
return round((energyKwh / newNetKw), 1)
```
The `/η` on the shed term is essential: since v1.26 `hours` is the η-corrected pool-drain countdown, so `netKw` is the *gross pool-drain* rate; shedding `shedKw` of **delivered** load reduces pool drain by `shedKw/η`, not `shedKw`. Dividing onto the same pool basis keeps the two terms consistent (else the shed benefit is under-counted by ~1/η). `hoursToReserve` uses `remain − reserve`; `hoursToEmpty` uses `remain`.

#### 5.3 Composition & recommendation

`buildLoadComposition` picks the best watt source per allowlisted entity: **SHP2 circuit (authoritative) → HA power sensor → operator estimate**. An entity missing/unavailable/unknown in HA is flagged `available:false` (a phantom candidate, e.g. a dead device still on the allowlist) rather than silently counted.

`computeAdvisory` recommends only when **in an actionable band** (`classifyRunway` returns medium/high/critical) **AND below** `thresholdHours`. It walks the composition shed-first, accumulating loads that are currently ON with positive watts until the (upper-bound) counterfactual clears `thresholdHours + restoreMarginHours` or the list is exhausted. `actionable` additionally requires the shed to **materially help**: either it clears the depletion, or it extends `hoursToReserve` by ≥ `MIN_SHED_BENEFIT_HOURS` = 0.25 h (a 70 W shed off a 6 kW draw is cosmetic and a "shed now" prompt would mislead). Grid-aware: when backstopping, `classifyRunway` returns null → band null → no shed recommended, matching the audible alarm.

#### 5.4 Config, outputs & endpoints

| Env | Default | Meaning |
| --- | --- | --- |
| `LOAD_SHEDDING_ADVISORY_ENABLED` | `true` | Master enable (set `false` to disable) |
| `LOAD_SHEDDING_RUNWAY_THRESHOLD_H` | 4.0 | Only advise when runway ≤ this |
| `LOAD_SHEDDING_RESTORE_MARGIN_H` | 2.0 | Extra margin the shed must buy past the threshold |
| `LOAD_SHEDDING_SHED_ENTITIES` | (empty) | Allowlist (empty ⇒ advisory inactive, zero overhead) |

- REST: `GET /api/load-shedding/status` → `{enabled, mode:'advisory', candidatesConfigured, haStateCacheAgeMs, advisory}`.
- MQTT (via `advisoryStateFields`): `load_shed_recommended` (bool), `load_shed_recommended_count`, `load_shed_recommended_watts`, `runway_to_reserve_if_shed_hours`.
- Driven by a 2-min tick (index.ts L2175) that skips entirely when no candidates are configured (opted-out installs pay zero cost).

> Memory note (`project_ecoflow_expected_unknowns`): `..._runway_to_reserve_if_shed` reading `unknown` is **by design** on a healthy fleet (no depletion → nothing to shed), not a broken sensor.

---

### 6. Cross-cutting: the audible path

All three alarms (runway, SoC, and the grid-drop re-escalation) converge on `broadcast.announce(priority, message, messageEs)` — a **dedicated** audible path bypassing the alert→condition pipeline so they annunciate even at a `critical` broadcast min-severity. Every announce is gated by `isPriorityEnabled(priority)` (per-priority Alert-Settings toggles) and, for runway, additionally by `shouldGateRunwayAudible` (mute while grid backstopping). Each message carries an English + Latin-American-Spanish second pass. The matching on-screen alerts (`forecast-runtime-*` for runway, the `alerts.ts` reserve band for SoC) are excluded from the broadcast condition so nothing double-chimes.

> Operational note (memory `project_alarm_audible_and_host_dns`): the audible path is LIVE via 2 ecobee speaker targets; quiet-hours 22:00–05:00 gating criticals to a 06:00 digest is an **accepted, postponed** configuration — do not re-surface it as a defect.


---

## 6. Battery & PV Health Engines (SoH, EOL, pack-risk, resistance, RTE, thermal, soiling)

This cluster covers every long-horizon *health* analytic in the ecoflow-panel add-on: pack state-of-health (SoH) fade and end-of-life (EOL) projection, coulombic efficiency, internal resistance, round-trip efficiency (RTE), charge-curve fingerprinting, ambient-coupled thermal forecasting, thermal-event counting, string-mismatch / per-Core underperformance, soiling decomposition, inverter clipping, MPPT/inverter equipment health, and the two pack-risk scorers (heuristic v1 + ML v2).

All of these live in `server/src/analytics.ts` (~450 KB) except the ML risk model, which lives in `server/src/ml.ts`. They are pure(ish) compute functions fed by the `Recorder` time-series store plus the live `DeviceSnapshot` map, run on the analytics worker thread, cached with per-engine TTLs, and surfaced over `/api/*` endpoints. None of these engines is an *alarm* source (the alarm paths are documented separately); they are diagnostic/planning KPIs, and every one of them prefers an honest `null`/`no-data`/`learning` state over a fabricated number.

### Shared conventions

- **Recorder queries.** `recorder.query(sn, metric, since, now, bucketSec?)` and `recorder.queryMulti(sn, [metrics], since, now, bucketSec?)` return `Array<{ts, value}>` in ascending-ts order, optionally SQL-bucketed (GROUP BY) to a coarser interval to cut row counts. `queryMulti` collapses N per-metric round-trips to one. `node:sqlite` is fully synchronous, so several engines run `await new Promise(r => setImmediate(r))` between packs to yield the event loop.
- **Pack keying.** Packs are keyed `` `${sn}|${pk.num}` ``. Per-pack metric names are templated: `pack${n}_soh`, `pack${n}_cycles`, `pack${n}_temp`, `pack${n}_in`, `pack${n}_out`, `pack${n}_soc`, `pack${n}_vol_max_mv`, `pack${n}_lifetime_chg_mah`, `pack${n}_lifetime_dsg_mah`. DPU-bus metrics: `bat_vol`, `bat_amp`, `pv_total`, `total_in`, `total_out`, `panel_load`.
- **Fleet scoping.** `shp2ConnectedDpuSns(devices)` returns the SNs of DPU Cores actually wired into the SHP2 backup panel; `homeConnectedDpus(dpus, connected)` filters to them; `isShp2Connected(sn, connected)` tests membership. Spare Cores (4 & 5) are still *analyzed* per-pack but are excluded from any *baseline* that a Core is compared against (they cycle differently — storage SoC, bench top-ups). This "filter the baseline, score everyone" pattern recurs in degradation peer-fade, RTE, string-mismatch, novelty, clipping, and soiling.
- **Robust statistics.** `median(arr)`, `mad(arr, med)` (median absolute deviation), and `robustZ(x, med, mad, floor, zAtFloor)` (MAD-floored modified z-score) are shared helpers. `Z_INFO = 3.5`, `Z_WARN = 5`. `linregress(pts)` returns `{slopePerMs, slopeStdErrPerMs, r2}`; `lstsq2(rows)` returns a 2-regressor fit `{b0, b1, b2, r2}`.
- **Endpoint wrapper.** Almost all endpoints go through `analytics.report('<name>', opts?)` on the worker, then `cached(req, reply, value, seconds)` which adds a hash-ETag + `Cache-Control`.

---

### 1. State-of-Health fade + End-of-Life projection (`analysePack` / `computeDegradation`)

#### What it does + why
Regresses each pack's BMS-reported SoH history into a calendar-fade rate (%/yr), projects when it will cross the conventional LFP end-of-life mark, and compares each pack against its fleet peers to flag the fastest-wearing pack. This is the single most guard-heavy engine in the file because a raw OLS slope on early-life BMS `fullCap` settling routinely fabricates physically-impossible fades on near-new packs.

#### Inputs
| Metric | Role |
|---|---|
| `pack${n}_soh` (6-h buckets) | primary fade regression signal |
| `pack${n}_cycles` (6-h buckets) | cycle-intensity regression → `cyclesPerYear`, `projectedCyclesAtEol` |
| `pack${n}_temp` (6-h buckets) | Arrhenius temperature correction |
| `pack${n}_lifetime_chg_mah`, `pack${n}_lifetime_dsg_mah` | coulombic efficiency (see §2) |
| Device fields `pk.actSoh ?? pk.soh`, `pk.fullCapMah`, `pk.designCapMah`, `pk.accuDsgMah`/`accuChgMah`, `pk.cycles` | current-state snapshot |

`DEGRADE_REPORT_HISTORY_MS = 30 d` (== recorder retention), `DEGRADE_BUCKET_SEC = 6*3600` (6-hour buckets to de-noise SoH jitter), `DEGRADE_REPORT_TTL_MS = 30 min`.

#### Calculation — step by step

**Current state.** `rawSoh = actSoh ?? soh`; `currentSoh = min(100, rawSoh)` (v0.14.1 clamp — a freshly-calibrated BMS can read >100%). Capacity via `PACK_MAH_TO_KWH = (32 × 3.2) / 1e6` (single 32-cell, 3.2 V string mAh → kWh). `capacityFadeKwh = max(0, designCapacityKwh − currentCapacityKwh)`.

**OLS fade.** `fit = linregress(sohPts)`; `fadePctPerYear = −slopePerMs × YEAR_MS` where `YEAR_MS = 365.25 d`. `fadeUncertaintyPct = slopeStdErrPerMs × YEAR_MS` (±1 SE).

**Kalman side-by-side.** The same `sohPts` are fed to a 2-state constant-velocity `kalmanFilterSoh` (§8). It publishes `kalmanSmoothedSoh` (posterior SoH, also clamped ≤100), `kalmanFadePctPerYear` (= `−driftPerYear`), `kalmanFadeStdevPctPerYear` (posterior stdev), and a dated `kalmanYearsToEol`/`kalmanEolDate` — but only after mirroring every OLS gate (span ≥ `EOL_MIN_SPAN_MS`, r² ≥ `EOL_MIN_R2`, and `!fadeExceedsPlausibleCeiling`). OLS remains the canonical projection; Kalman is parallel comparison data.

**Arrhenius.** `avgPackTempC` = mean of `pack${n}_temp`. `arrheniusFactor = 2^((avgTemp − 25)/10)` (LFP fade roughly doubles per +10 °C). `fadePctPerYearAt25C = fadePctPerYear / arrheniusFactor`. `coolingBenefitYears` = extra service-years if avg pack temp fell 5 °C (`COOLING_DELTA_C = 5`), computed by re-running the headroom/fade math at the cooled Arrhenius factor and reporting the delta if > 0.05 yr.

**EOL projection.** `headroom = currentSoh − EOL_SOH` (`EOL_SOH = 80`). `yearsToEol = headroom / fadePctPerYear`. Confidence band: `fadeFast = fade + SE`, `fadeSlow = max(0.02, fade − SE)`; `yearsToEolLow = headroom/fadeFast`; `yearsToEolHigh = headroom/fadeSlow` (null if `fadeSlow ≤ 0.05` or the high bound exceeds `EOL_MAX_YEARS`). `eolDate = now + yearsToEol × YEAR_MS`. `fadePctPer100Cycles = (fade/cyclesPerYear)×100` only when `cyclesPerYear ≥ 5`.

#### Status gates (in evaluation order)
The function returns one of `no-data | learning | stable | projecting` via `mk(...)`. Order matters — the first matching gate wins:

1. **`no-data`** — `sohPts.length < 8` or `currentSoh == null`.
2. **`learning` (step-dominated)** — `sohStepDominated(sohPts)`: a BMS-recalibration staircase. Returns true if <3 distinct values, or the largest flat run covers >70% of samples, or ≤3 step transitions all fall in the final 20% of the window. Fade/r²/Kalman-EOL all forced null so it can't seed the peer pool or pollute the confidence median-r².
3. **`learning` (signal-below-floor)** — `sohSignalBelowFloor(sohPts)`: `mean(first quartile) − mean(last quartile) < SOH_MIN_OBSERVED_DROP_PTS (1.5)`. Catches a shallow multi-step decline smaller than BMS quantization noise.
4. **`learning` (immature)** — `!fit || spanMs < EOL_MIN_SPAN_MS (21 d) || fit.r2 < EOL_MIN_R2 (0.3)`. Preliminary fade shown; dated EOL withheld; Kalman dated EOL also nulled.
5. **`stable`** — `fade == null || fade < 0.1 || currentSoh ≤ EOL_SOH || yearsToEol > EOL_MAX_YEARS (40)`. Flat / improving / already-at-EOL / effectively-never.
6. **`learning` (implausible-fast-fade)** — `fadeExceedsPlausibleCeiling(fade)` i.e. `fade > EOL_MAX_FADE_PCT_PER_YEAR (10 %/yr, = MAX_SOH_FADE_PCT_PER_YEAR)`. Real LFP fades ~2–3 %/yr; anything faster is early-life fullCap settling. **This mirrors the forecast-soh alert ceiling so the dated EOL can never outrun the alert.** Fade/EOL nulled → HA `..._soonest_pack_eol` stays `unknown` (documented expected-unknown on a near-new fleet).
7. **`projecting`** — the real dated projection with confidence band + Arrhenius note.

#### Peer comparison (Pass 2 of `computeDegradation`)
Baseline pool = packs with `status==='projecting'` **and** SHP2-connected. Needs ≥3. `med = median(rates)`, `m = mad(rates, med)`. For every projecting pack: `peerFadeRatio = fade/med`; `z = robustZ(fade, med, m, FADE_PEER_Z_FLOOR_PCT_PER_YEAR (0.1), Z_INFO)`. If `fade > med && z ≥ Z_INFO` → `peerOutlier = true` and the summary gains "fading ~N× the fleet-median rate". Spares are *scored* against the connected baseline but never *define* it.

Packs are sorted worst-first (`projecting` → `learning` → `stable` → `no-data`; within projecting by soonest `yearsToEol`).

#### Outputs
`GET /api/degradation` → `FleetDegradation { generatedAt, eolSoh, packs: PackDegradation[] }`. Each `PackDegradation` carries ~40 fields: current SoH/capacity, `fadePctPerYear`+`fadeUncertaintyPct`, `r2`, `yearsToEol`/`Low`/`High`, `eolDate`, `peerFadeRatio`/`peerOutlier`, all Arrhenius fields, `coulombicEffPct`, all five `kalman*` fields, and a plain-language `summary`. Feeds HA sensor `..._soonest_pack_eol`, the pack-risk scorers (both v1 & v2), `computeConfidenceSnapshot` (median r²), and `/api/repair-issues`.

#### Config knobs
`RUNWAY_DISCHARGE_EFFICIENCY` etc. belong to runway (separate cluster). Degradation itself is constant-driven (no env knobs); the salient constants are `EOL_SOH=80`, `EOL_MIN_SPAN_DAYS=21`, `EOL_MIN_R2=0.3`, `EOL_MAX_YEARS=40`, `EOL_MAX_FADE_PCT_PER_YEAR=10`, `SOH_MIN_OBSERVED_DROP_PTS=1.5`.

#### Edge cases / honest-null
Empty roster short-circuits (cache not stored when `dpus.length === 0`). Every "artifact" gate routes to `learning` with null fade so the artifact cannot seed the peer pool, the confidence median-r², or the HA EOL sensor. Fresh fleet → all packs `learning`/`stable` and the EOL sensor is `unknown` **by design**.

---

### 2. Coulombic efficiency (`coulombicEfficiencyFromCounters`)

#### What + why
Discharge-mAh ÷ charge-mAh over a recent window from the BMS lifetime counters. Healthy LFP stays ≥ ~99.5%; a downward drift means side reactions consuming charge — an early cell-aging signal SoH-by-itself misses. **On this specific fleet the BMS counters are demonstrably unphysical, so the self-validating estimator publishes `null` for all 15 home packs by design** (v1.19.0 engine-review F17).

#### Inputs & the F17 self-validation
Reads only the **edge points** (first/last) of two windows for both `pack${n}_lifetime_chg_mah` and `_dsg_mah`: the full ~30-day degradation window and the 7-day tail (`CE_WINDOW_MS = 7 d`). `mergeCounterEdges` dedups the two edge pairs by ts — provably equivalent input to reading the raw window, at four LIMIT-1 index seeks instead of ~28k rows.

Publishes the 7-day CE **only when all three gates pass**:
1. Span guard: both counters span ≥ `CE_MIN_SPAN_MS = 2 × 7 d` (a shorter history makes tail == full and the checks tautological).
2. Full-window ratio: `fullChg ≥ CE_MIN_FULL_CHG_DELTA_MAH (30 000)`, `fullDsg > 0`, and `fullRatio ∈ [CE_BAND_LO=90, CE_BAND_HI=100.5]`. A long-window ratio >100.5% *proves* the counters are artifact-ridden, so no sub-window is trustworthy.
3. 7-day ratio: `chgDelta ≥ CE_MIN_CHG_DELTA_MAH (10 000)`, `dsgDelta > 0`, ratio in the same band, **and** `|ratio − fullRatio| ≤ CE_CONSISTENCY_TOL_PP (2.0)` — real CE moves slowly; a divergence larger than the entire downstream discriminating span (99%→97% max-risk) is window noise.

Passing value is `min(100, round2(ratio))`. `null` means "unknown" and every consumer treats it neutrally (heuristic `ceNorm → 0`, LR `normalizeFeature → 0`, tile shows `—`).

#### Output / trace
Carried inside `PackDegradation.coulombicEffPct` (no dedicated endpoint). Feeds pack-risk feature 3 in both v1 and v2.

---

### 3. Round-Trip Efficiency (`computeRoundTripEfficiency`)

#### What + why
Energy retrieved from packs ÷ energy stored into packs over a rolling window (default 7 days). Healthy LFP ≈ 95–97%; a slow drift down is the cleanest "whole stack is aging" signal. Uses per-pack in/out integrals so PV-direct passthrough doesn't contaminate the ratio.

#### Inputs
Per home-connected pack: `pack${n}_in`, `pack${n}_out`, one `queryMulti` per Core at 60 s buckets (300 s buckets for the wide extended pass). `RTE_TTL_MS = 15 min`. Spares excluded (`homeConnectedDpus`).

#### Calculation
For each day in the window it integrates each pack's in/out with `integrateWh` (trapezoidal, day boundary shared as a sample endpoint so no interval is double-counted) → `chargedKwh`, `dischargedKwh`, plus per-pack `coverageMs`.

Two per-day gates decide inclusion:
- **Coverage:** `coverage = coverageMsSum / (packCount × dayMs) ≥ RTE_MIN_DAY_COVERAGE (0.5)`. A boot-partial day (<50% measured) is excluded so a tiny charge integral can't yield a 130% ratio.
- **Round-trip band:** `ratio = dischargedKwh/chargedKwh` (only if `chargedKwh > 0.5`), must sit in `[RTE_ROUNDTRIP_MIN_FRAC=0.8, RTE_ROUNDTRIP_MAX_FRAC=1.05]`. Net-fill (<0.80) and net-drain/anomalous (>1.05) days are listed with their kWh but carry no `efficiencyPct` (they aren't round trips).

Included days accumulate into `totalCharged`/`totalDischarged`. **Steady-state clamp:** both per-day (`min(100, ratio×100)`) and aggregate (`effPct = totalCharged > 1 ? min(100, (totalDischarged/totalCharged)×100) : null`) are clamped ≤100% — you can't get more energy out than in; the 1.05 band admits an in-flight edge interval, the clamp keeps the *published* number physical.

**Extended-lookback backstop (v0.65.0):** if the primary window found no balanced day (`effPct == null` — typically a sustained drawdown), it recurses once over `RTE_EXTENDED_WINDOW_DAYS` (`max(7, env RTE_EXTENDED_WINDOW_DAYS ?? 30)`) at coarse buckets and reports the most-recent real balanced cycles. Stateless, self-terminating, still ≤100%, honest `null` if even the wide window has none.

#### Outputs
`GET /api/round-trip-efficiency?days=N` (N clamped 1–30, default 7) → `RoundTripEfficiency { generatedAt, windowDays, daysWithData, totalChargedKwh, totalDischargedKwh, efficiencyPct, perDay: RoundTripDay[] }`. Feeds the RTE HA sensor and (as a display annotation, *not* a divisor) informs the runway DC-drain factor. **Related invariant:** `/api/lifetime-energy` reports `charge == discharge` exactly (RTE=100%) as a steady-state clamp — that is deliberate, not sign-mixing.

#### Config / edge cases
`RTE_EXTENDED_WINDOW_DAYS` env. `daysWithData` counts only days with a non-null `efficiencyPct`. Cache keyed by `d${windowDays}`.

---

### 4. Internal-resistance trending (`computeInternalResistance`)

#### What + why
`dV/dI ≈` effective internal resistance at the inverter bus (pack voltage isn't recorded separately — `bat_vol`/`bat_amp` give one R per DPU, not per pack). Rising R precedes SoH decay by months on LFP. **Honest caveat baked in:** a 10–120 s polled series is OCV/SoC-drift-dominated, so this engine can't truly converge — the value of the engine is its honest terminal states, not a precise number (v1.22.0 F27 hardened it).

#### Inputs / constants
`bat_vol`, `bat_amp` over `IR_HISTORY_MS = 30 d`, `IR_TTL_MS = 30 min`. Requires ≥30 raw samples each else `no-data`.

#### Calculation
Snaps V/A onto common timestamps (rejecting pairs >30 s apart). For each adjacent pair within `IR_DELTA_T_MAX_MS = 120 000`:
- count it as a within-cadence candidate;
- require `|dI| ≥ IR_DELTA_I_MIN_A (5 A)`;
- **steady-state filter** `steadyOn`: scan the ±`IR_STEADY_WINDOW_MS (3 000 ms)` neighborhood on both sides; reject if any adjacent `|dA|/dt ≥ IR_STEADY_DIDT_MAX_A_PER_S (3 A/s)` (a transient — motor inrush, MPPT chase, inverter load-step);
- `r = (dV/dI) × 1000` mΩ; **reject wrong-signed** pairs (bat_amp is into-battery-positive, so a genuine Ohmic response has `dV/dI > 0`; F27 replaced an `abs()` that was aging OCV drift into the trend as plausible positive R); keep only `r ∈ [IR_R_MIN_MILLI=2, IR_R_MAX_MILLI=100]`.

Need ≥10 accepted samples. `recentMilliohms = median(samples in last 7 d)`. `baselineMilliohms`: drawn **only** from samples older than the 7-day recent window (needs ≥`IR_BASELINE_MIN_SAMPLES = 5` pre-recent points, then the earliest-30% slice of that older cohort).

**Trend publication (F27 gates).** `fit = linregress(rSamples)`; `slopePerMonth = slopePerMs × 30 d`. Published as `trendMilliohmsPerMonth` **only if** `fit.r2 ≥ IR_TREND_MIN_R2 (0.3)` AND `spanMs ≥ IR_TREND_MIN_SPAN_MS (14 d)` AND `|slopePerMonth| ≤ IR_TREND_MAX_ABS_MILLI_PER_MONTH (5)`. Otherwise null. `trendR2` is always published as a diagnostic so the UI can see *why* the trend was gated.

#### Terminal states
`tracking` (≥10 clean pairs), `learning` (pairs within cadence but rejected as transient/out-of-band — genuinely accumulating), `insufficient-cadence` (fewer than `IR_MIN_CANDIDATE_PAIRS = 5` pairs even landed within cadence — will never converge at this poll rate), `no-data` (<30 raw samples).

#### Output
`GET /api/internal-resistance` → `InternalResistanceReport { generatedAt, devices: InternalResistanceDevice[] }` (per-DPU: `recentMilliohms`, `baselineMilliohms`, `trendMilliohmsPerMonth`, `trendR2`, `samples`, `status`). Feeds pack-risk feature 2 (bus-level R shared by all packs on a DPU).

---

### 5. Charge-curve fingerprint (`computeChargeCurveFingerprint`)

#### What + why
Tracks how the pack's max-cell voltage at fixed SoC checkpoints drifts from its early-life baseline during active charge. A widening voltage plateau at a given SoC is a slow aging fingerprint.

#### Inputs / constants
Per pack `queryMulti` of `pack${n}_soc`, `pack${n}_vol_max_mv`, `pack${n}_in` over `CHARGE_CURVE_HISTORY_MS = 200 d`, `CHARGE_CURVE_TTL_MS = 60 min`. Needs ≥50 SoC and ≥50 V samples else `no-data`.

#### Calculation
Snap V and IN to nearest SoC sample (two-pointer). Checkpoints `CHARGE_CHECKPOINTS = [40, 60, 80, 95]` %, tolerance `±CHARGE_CHECKPOINT_TOLERANCE_PCT (1.5)`. Only samples **during active charge** (`inW ≥ 100`, avoids resting voltage) count.

- Baseline window = `[firstRecordedTs, firstTs + CHARGE_BASELINE_WINDOW_MS (14 d)]` (anchored to oldest real sample, not the fixed 200-days-ago `since`, so a weeks-old DB still has a baseline).
- Recent window = last 14 days.
- `windowsSeparated = recentCutoff > baselineCutoff` — until ~28 days of span the windows overlap and the engine holds at `baseline` rather than diffing overlapping periods.

Per checkpoint: `baselineV = median(≥3 baseline samples)`, `recentV = median(≥3 recent samples)`, `driftMv = round(recentV − baselineV)`. `meanDriftMv = mean(|driftMv|)` across checkpoints. Status: `tracking` (meanDrift non-null) / `baseline` (has ≥3 baseline samples on some checkpoint) / `no-data`.

#### Output
`GET /api/charge-curve` → `ChargeCurveReport { generatedAt, packs: ChargeCurvePack[] }` (per pack: `checkpoints[]` with baseline/recent/drift/sample counts, `meanDriftMv`, `status`). Feeds pack-risk feature 5.

---

### 6. Ambient-coupled thermal forecast (`computeAmbientThermalForecast`)

#### What + why
Learns each pack's temperature as a linear function of outdoor ambient temp + DPU duty (load), then predicts the peak pack temperature over the next 24 h from the weather forecast.

#### Inputs
Weather (`getWeather()` → `wh.tempC`, `wh.ts`), per-pack `pack${n}_temp` and per-DPU `total_in`/`total_out`, all hour-bucketed (`HOUR_BUCKET_SEC = 3600`) over `AMBIENT_THERMAL_HISTORY_MS = 30 d`. `AMBIENT_THERMAL_TTL_MS = 60 min`.

#### Calculation
Per hour-epoch build a training row `{ x1 = ambientTempC, x2 = loadW/1000 (= mean total_in + mean total_out, kW), y = mean pack_temp }`. Fit `lstsq2(rows)` → `{b0 (intercept), b1 (ambientCoeff, °C pack per °C ambient), b2 (loadCoeff, °C pack per kW), r2}`. Prediction over the next 24 forecast hours: `pred = b0 + b1·tempC + b2·recentLoad` (recentLoad = mean of last 24 in/out samples, kW); tracks the max as `predictedPeak24hC` at `predictedPeakAtMs`.

#### Output
`GET /api/ambient-thermal-forecast` → `AmbientThermalReport { generatedAt, packs: AmbientThermalPack[] }` (`ambientCoeff`, `loadCoeff`, `intercept`, `r2`, `samples`, `predictedPeak24hC`, `predictedPeakAtMs`). `r2` feeds `computeConfidenceSnapshot.thermalMedianR2`. Empty (no DPUs / no weather) → empty packs.

---

### 7. Thermal-event counter (`computeThermalEvents`)

#### What + why
Counts how often and how long each pack sat in "warm / hot / overheat" temperature bands, and rolls that into a normalized per-year "hard-life score" — a lens on cumulative thermal stress even when packs have different recording histories.

#### Inputs / thresholds
`pack${n}_temp` (raw, unbucketed) over `THERMAL_EVENT_HISTORY_MS = 30 d`, `THERMAL_EVENT_TTL_MS = 30 min`. Bands (stored in °C, commented in °F):
- `THERMAL_THRESHOLD_C_INFO = (96−32)/1.8 ≈ 35.6 °C` (warm)
- `THERMAL_THRESHOLD_C_WARN = (113−32)/1.8 = 45 °C` (hot)
- `THERMAL_THRESHOLD_C_CRIT = (131−32)/1.8 = 55 °C` (overheat)
- `THERMAL_HYSTERESIS_C = 1.5` (must fall this far below the trigger to re-arm)

#### Calculation
**Event count** = rising-edge with hysteresis: crossing above a threshold counts one event and disarms; the band re-arms only once temp falls `THERMAL_HYSTERESIS_C` below the trigger — so one sustained hot spell is one event, not many.

**Time-above** credits each inter-sample interval `dt` to whichever bands the *previous* reading occupied, **but only if** `dt ≤ THERMAL_SAMPLE_GAP_CAP_MS (15 min = 3× the 5-min heartbeat)` — a wider gap is a telemetry outage and must not be scored as "hot for the whole outage".

`spanDays = max(1, spanMs/86.4e6)`. `hardLifeScore = ((warmEvents + 4·hotEvents + 16·overheatEvents) / spanDays) × 365` (weighted, per-year-normalized).

#### Output
`GET /api/thermal-events` → `FleetThermalEvents { generatedAt, packs: ThermalEventCounts[] }` (`warmEvents`/`hotEvents`/`overheatEvents`, `warmHours`/`hotHours`/`overheatHours`, `dataSpanDays`, `hardLifeScore`). Feeds pack-risk feature 4 (`hardLifeScore`). No samples → all-zero row.

---

### 8. Kalman SoH filter (`kalmanFilterSoh`)

2-state constant-velocity Kalman over `[SoH, dSoH/dt]`, run internally in **days** for conditioning (input ts are ms). Requires ≥3 points.

- Transition `F = [[1, dt],[0,1]]`; observation `H = [1, 0]`.
- Init: `x = [firstValue, 0]`, `P00 = KALMAN_INIT_VAR_SOH (100)`, `P11 = KALMAN_INIT_VAR_RATE_PER_DAY (0.01)`.
- Process noise scales with `dt`: `Q_SOH = KALMAN_Q_SOH (1e-4)`, `Q_RATE = KALMAN_Q_RATE_PER_DAY (1e-7)`.
- Observation noise `R = KALMAN_R_OBS (0.05)` — deliberately 5× smaller than raw-sample R because each 6-h bucket is already the mean of ~360 raw samples (conservative vs the ~350× theoretical variance reduction).
- Covariance update uses the symmetric `(I−KH)P` closed form (v0.9.58 fixed a `p10` asymmetry that compounded into overconfident EOL).

Returns `{smoothedSoh, smoothedSohVar, driftPerYear (= x1 × 365.25), driftPerYearStdev (= √p11 × 365.25), samples, observationVariance}`. Consumed by `analysePack` (§1) as the side-by-side projection.

---

### 9. Pack-risk v1 heuristic (`computePackRiskScores`)

#### What + why
A hand-tuned weighted-sum-then-sigmoid risk score (0–100) per pack. **Not** a trained model — there's no labeled failure dataset — but the output shape matches what a trained classifier would yield, so v2 is a drop-in. `RISK_MODEL_VERSION = 'heuristic-v1'`, `RISK_TTL_MS = 30 min`.

#### Inputs (six features, each normalized to 0..1 where 1 = high risk)
| # | Feature | Source | Normalization | Weight |
|---|---|---|---|---|
| 1 | Peer-fade ratio | `deg.peerFadeRatio` | `clamp01((r−1)/1.0)` (2.0→max) | 0.25 |
| 2 | Internal-R trend | `ir.trendMilliohmsPerMonth` (bus-level, shared per DPU) | `clamp01(r/3)` (3 mΩ/mo→max) | 0.15 |
| 3 | Coulombic efficiency | `deg.coulombicEffPct` | `clamp01((99−ce)/2)` (97%→max) | 0.15 |
| 4 | Thermal hard-life | `therm.hardLifeScore` | `clamp01(h/300)` | 0.15 |
| 5 | Charge-curve drift | `cc.meanDriftMv` | `clamp01(|d|/50)` | 0.10 |
| 6 | Capacity fade rate | `deg.fadePctPerYear` | `clamp01((f−1)/5)` | 0.20 |

Weights sum to 1.

#### Calculation
`linearScore = Σ (normalized × weight × 100)`. `score0to100 = round(100 / (1 + exp(−(linearScore − 50)/12)))` (sigmoid-flatten around 50 so extreme single features don't dominate; steepness 12 chosen so linear 70 → ~80). Tier: `no-data` (no feature has data), `low` (<25), `moderate` (<50), `elevated` (<75), `critical` (≥75). `topFactors` = the ≤3 highest-weightedScore factors with data. Each factor carries a plain-language `comment`. Packs sorted critical-first, highest score within tier.

#### Output
`GET /api/pack-risk` (composes degradation + thermalEvents + internalResistance + chargeCurve reports) → `FleetRiskReport { generatedAt, modelVersion, packs: PackRiskScore[] }`.

#### Edge cases
A null feature normalizes to 0 (neutral), so missing data never inflates risk. On the current near-new fleet CE is null for all packs and immature fade is null → most packs read `low`.

---

### 10. Pack-risk v2 ML (`ml.ts` — `computePackRiskV2`)

#### What + why
Three side-by-side signals per pack — the v1 heuristic, a **logistic-regression** trained track, and an unsupervised **Mahalanobis novelty** detector — plus a composite. Real inference path (learned weights, sigmoid), gated by an auto-downgrade mechanism that pins the trained track to the heuristic whenever the model can't be trusted.

#### Feature extraction (`extractFeatures` / `normalizeFeature`)
Same six features and the same normalization thresholds as v1 (`FEATURE_NAMES = [peerFadeRatio, rTrend, coulombicEffPct, hardLifeScore, ccDriftMv, fadePctPerYear]`). Crucially, **fade features are consumed only when `deg.status === 'projecting'`** (`fadeMature`); an immature early-fit slope is treated as `null → 0`, so a fresh pack with 22 %/yr fit noise is not ranked most-at-risk. Null/non-finite → 0.

#### Logistic regression (`predictRisk`, `LrModel`)
`logit = bias + Σ weight·normalizedFeature`; `probability = sigmoid(logit)`; `score0to100 = round(prob×100)`; per-feature `contributions` returned for interpretability. `trainLrModel` fits by batch gradient descent (default 2000 iters, lr 0.05, L2 0.01, BCE loss) — used offline by `scripts/train-pack-risk.ts`.

**Model source chain (`loadModel`, highest→lowest):** online-shadow file `pack-risk-lr-v1-online.json` (SGD-updated on `/api/alerts/outcome`) → trained baseline `pack-risk-lr-v1.json` → in-code `DEFAULT_MODEL` (`version 'lr-heuristic-baseline-v1-builtin'`, weights mirroring the heuristic × a sigmoid scale, bias −2.5). Cache (`MODEL_CACHE_TTL_MS = 5 min`) invalidates the instant the source file's mtime moves. `provenance` (`shadow`/`baseline`/`default`) is stamped, never persisted.

#### Novelty (`computeNovelty`)
Per-pack **Mahalanobis centroid distance**: inverse-stdev-weighted distance from the fleet centroid in 6-D normalized feature space. Centroid + per-feature stdev are built from the **SHP2-connected baseline pool only** (spares would drag the centroid and compress the spread), but every pack is *scored*. Mapped **absolutely** against a fixed chi-square cutoff `CHI2_THRESHOLD = 3.4`: `novelty0to100 = round(min(1, distance/3.4) × 100)`. A pack reads 100 only once its distance actually reaches the outlier threshold (the old divide-by-in-sample-max forced one pack to 100 even on a healthy fleet). `topFeatures` = the 3 largest scaled deviations.

#### Auto-downgrade gate (`computeGateDecision`)
Decides whether the trained track is trustworthy. Three degrade reasons:
- **`samples`** — shadow model has < `PACK_RISK_MIN_TRAINING_SAMPLES` (env, default **100**) labeled samples. The live 13-sample one-class shadow learned essentially "raise everyone's risk" (99.99% bias), inflating healthy composites 4–7×. When this fires, the composite is **heuristic-only** (novelty track also excluded).
- **`drift`** — `driftL2 > PACK_RISK_DRIFT_THRESHOLD` (env, default 2.0), the L2 distance between the shadow and the on-disk baseline (`loadBaselineModelOnly`, bypassing the shadow preference — v0.9.62 fixed a self-comparison that made drift always 0). No baseline on disk → drift is `null` (unknown), not 0.
- **`precision`** — alert-family `overallPrecision < PACK_RISK_MIN_PRECISION` (env, default 0.4) with ≥`PACK_RISK_MIN_DECIDED_OUTCOMES` (default 3) decided outcomes including ≥1 dismissal. Env parsing via `gateEnvNum` treats `''`/NaN/negative as the default (so `Number('')===0` can't silently zero a threshold).

For a mature-model degrade (drift/precision) the trained score pins to the heuristic but novelty still averages into the composite.

#### Composite
Per pack: `trainedScore = gate.degraded ? heuristic : pred.score0to100`. `composite0to100 = gate.reason === 'samples' ? heuristic : round((heuristic + trainedScore + novelty)/3)`. `featureImportances = |weight| × per-fleet-stdev` (surfaces what actually drives between-pack differences, not just the weight). Packs sorted by composite desc.

#### Output
`GET /api/pack-risk/v2` → `PackRiskV2Report { generatedAt, modelVersion, modelSource, modelTrainedAt, modelTrainingSamples, modelFinalLoss, featureImportances[], packs: PackRiskV2Entry[], degraded?, degradeReason?, gateDecision{} }`. Each entry carries `heuristic{}`, `trained{}` (with raw probability + contributions even when pinned), `novelty{}`, and `composite0to100`. `gateDecision` feeds `/api/models/health`.

---

### 11. String-mismatch / per-Core underperformance (`computeStringMismatch`)

#### What + why
Flags a DPU whose PV output is persistently low vs the fleet at the same hour-of-day — a shaded panel, failed optimizer, or string mismatch. Same robust median+MAD test as the peer-anomaly engine, applied to per-DPU PV ratios.

#### Inputs / constants
`pv_total` at 300 s buckets over `STRING_MISMATCH_WINDOW_DAYS = 14 d`, `STRING_MISMATCH_TTL_MS = 15 min`. Daytime only (`value ≥ 100 W`).

#### Calculation
Per DPU build a 24-bucket hour-of-day median. For each hour, compute a **leave-one-out** fleet median from the *other* SHP2-connected DPUs (never itself — including itself pulls every ratio toward 1.0 and is degenerate with only 2 cores). `ratioSamples.push(deviceMed / fleetMed)` when ≥1 other connected DPU reports. `ratio = median(ratioSamples)`. If ≥3 devices have a ratio: `med = median`, `m = mad`; `z = robustZ(ratio, med, m, STRING_MISMATCH_RATIO_FLOOR (0.05), Z_INFO)`; `outlier = ratio < med && z ≥ Z_INFO`.

#### Output
`GET /api/string-mismatch` → `StringMismatchReport { generatedAt, windowDays, devices: DeviceProductionRatio[] }` (per device: `recentMedianW`, `fleetMedianW`, `ratio`, `modifiedZ`, `outlier`, `hourBuckets` = # of hour-of-day buckets compared, not raw samples). Spares are evaluated against but excluded from the connected baseline.

---

### 12. Soiling decomposition (`computeSoiling` / `computeSoilingDecomposition`)

#### What + why
Extends the fleet soiling estimate into a **per-Core** breakdown ("wash everything or just the east run?") plus a **per-hour** shape. `SOILING_DECOMP_TTL_MS = 30 min`.

#### Per-Core estimate (`computeSoiling`)
Reads a Core's `pv_total` hourly map + weather. Clear-daytime filter: `cloudCoverPct ≤ 25` and `radiationWm2 ≥ 250`. `coeff = pv / GHI` (drop non-finite / ≤0). Per clear day with ≥3 clear hours, `dayCoeff = median(hour coeffs)`. Needs ≥6 clean days.
- **`baselineCoeff` = p90 of the clean-day coeffs** (`sortedAsc[floor(0.9×(n−1))]`) — the robust "best clean day" reference, NOT the all-time max (v0.54.2 — a freak cool-clear peak inflated `dropPct`).
- **`recentCoeff` = median of the last 5 well-covered days** (coverage bar `covBar = max(3, round(maxDayHours × 0.5))`; `recentCovered = wellCovered ≥ 3`, else falls back to all days). The 5-day median rejects 1–2 transient/gap-depressed outliers while a sustained real drop still lowers it.
- `dropPct = round(((baseline − recent)/baseline) × 1000)/10`.

#### Fleet aggregation (`fleetSoilingFromDevices`)
Fleet soiling = **median** of each home Core's own `dropPct` (only Cores with a `recentCovered` estimate; needs ≥2). This is immune to the coverage-deflation artifact where one Core's cloud-offline `pv_total` gap on a clear hour deflates a *summed* fleet coefficient into a phantom ~35% "soiling" while every array is ~3–6% (real soiling dims all arrays roughly uniformly and shows up equally per-Core). **This is the documented "monsoon rinse" behavior: published soiling decays toward 0 over ~a week; do not re-surface "panels want cleaning".**

#### Per-Core panel (in `computeSoilingDecomposition`)
For each DPU it emits `SoilingPerDevice { sn, device, coreNum, dropPct, cleanDays, recentCoeff, baselineCoeff }` from `computeSoiling`.

#### F29 multi-week weather backfill
The decomposition window (`since = now − 60 d`, a query ceiling only) seeds weather from the **recorder-persisted** series first — `recorder.query('weather', 'ghi_wm2'/'cloud_pct', since, now, 3600)` via `mergeRecorderWeather` — then lets the live `getWeather()` cache overwrite its freshest hours. Before F29 the baseline was paired only with `getWeather()`'s 7-day cache, so the soiling baseline **slid forward with the dirt it exists to measure** (reported 0.9–1.6% while the truth was ~10–12%). Now the weather spans the same window as the PV it's compared against (effectively bounded by the recorder's ~30-day retention). Bails only if neither source produced any weather.

#### Per-hour shape (fleet, home-connected only)
Sums home-Core `pv_total` per hour-epoch (`fleetPvE`). Filter: `cloudCoverPct ≤ 25` and `radiationWm2 ≥ PERHOUR_MIN_GHI_WM2 (400)` — a raised floor (v1.24.0) because at dawn/dusk the pv/GHI ratio is geometry-dominated (sun angle/tilt), not soiling (hour 18 once read an impossible 67.3% drop). Split by hour-of-day into `baseline` (older than 7 d) and `recent` (last 7 d). Need ≥3 baseline + ≥2 recent. `base = p90 of baseline` (`sorted[floor(0.9×(n−1))]`, not all-time max), `rec = median(recent)`, `dropPct = ((base−rec)/base)×100`.

#### Output
`GET /api/soiling-decomposition` → `SoilingDecomposition { generatedAt, perDevice: SoilingPerDevice[], perHour: [{hour, dropPct, samples}] }`. Per-Core medians are the honest F29 output; `perHour` is display-only (no alarm/wash-card consumer). Feeds `/api/repair-issues`.

*(Note: `computeShadeReport` / `shadeHoursFromCorePvMaps` at `/api/shade-report` is the sibling engine — recurring same-hour clear-sky shortfall = physical obstruction, `SHADE_DROP_THRESHOLD = 0.18`, `SHADE_MIN_CLEAR_DAYS = 5`, per-Core p90 refCoeff, fleet median shortfall — same per-Core anti-deflation pattern.)*

---

### 13. Inverter clipping (`computeClipping`)

#### What + why
Estimates kWh lost today because the home array hit the inverter's power ceiling — observed PV pinned at the hardware peak while the learned model says the sun could have made more. Distinct from *curtailment* (batteries full, MPPTs throttled — a separate engine).

#### Inputs / constants
Needs a `DayForecast` (for the solar model) + `getWeather()` (per-hour GHI) + per-SN `pv_total` at 60 s buckets for today. `CLIPPING_TTL_MS = 5 min`, `CLIPPING_PEAK_FRAC = 0.95`, `DAYLIGHT_GHI = 20 W/m²`. Injectable `nowMs` clock for the elapsed-hour determination (tests); cache freshness uses the real wall clock regardless.

#### Calculation
Uses the **restored display basis** (`forecast.restoredSolarModel ?? forecast.solarModel`) — clipping is a display KPI, so it iterates all SHP2-connected SNs including any cloud-wedged Core absent from the live map (`clippingSns = present home Cores + missing connected Cores`); observed watts are read straight from each SN's own recorded `pv_total` (anti-fabrication — real recorded values, never scaled).

`arrayPeakW = max(restoredModel.hourly[].observedMaxPvW)` (the hardware ceiling — highest hourly PV ever observed). For each elapsed hour today: `observedW = Σ per-SN hourly mean pv_total`; `modelW = coeff × GHI` (only when `GHI > DAYLIGHT_GHI` and the hour's model coeff exists). `atPeak = observedW ≥ 0.95 × arrayPeakW`. If `atPeak && modelW > observedW`: `clippedW = modelW − observedW`, and `clippedKwh += (clippedW/1000) × elapsedHrs` (partial current hour weighted). `hoursAtPeak` counts at-peak hours.

#### Output
`GET /api/clipping` → `ClippingEstimate { generatedAt, todayKwh, perHour: ClippingHour[], arrayPeakW, hoursAtPeak }`. `arrayPeakW ≤ 0` or no forecast/weather/DPUs → empty. Feeds the HA clipping sensor and dashboard.

---

### 14. Equipment health — MPPT + inverter standby (`computeEquipmentHealth` via `ratioSeries` / `cappedMedianEffPct`)

#### What + why
Two DPU-electronics KPIs: **MPPT conversion efficiency** (DC-side V·A vs AC-side W — really a register-consistency ratio, capped 100%; a sustained drop is earliest electronics aging) per HV/LV string, and **inverter standby loss** (residual `ac_out` when PV is dark and load ≈ 0 — the inverter's own idle draw), trended week-over-week.

#### Inputs / constants
`ratioSeries` pulls `{watts, volts, amps}` per string via `queryMulti` at `EQ_HEALTH_BUCKET_SEC = 300 s` over the equipment-health history window; snaps V/A to nearest W ts within the bucket size. Per-sample ratios >100.5% are dropped; `cappedMedianEffPct(effs) = effs.length ? min(100, median(effs)) : null`. `MPPT_EFF_TTL_MS = 10 min`.

#### Output
`GET /api/equipment-health` → `EquipmentHealth { generatedAt, mpptStrings: MpptString[], inverterStandby: InverterStandby[] }`. Per string: `recentEffPct`, `baselineEffPct` (earliest 30% of history), `driftPctPts` (recent − baseline; negative = drift), `samples`, `spanDays`. Per DPU standby: `idleWatts` (recent median ac_out when PV<20W & panel-load<20W), `baselineIdleWatts`, `trendWattsPerWeek`, `samples`. Feeds `/api/repair-issues`.

---

### Cross-engine consumers

- **`computeConfidenceSnapshot(degradation, thermal, skill)`** → `/api/confidence`: `degradationMedianR2` (median of projecting packs' r²), `thermalMedianR2`, `forecastDayR2` (Pearson r² of predicted vs actual daily PV over the skill report's covered days, ≥5 days else null — replaced a degenerate within-slot median r²), plus forecast bias/MAE.
- **`computeRepairIssues`** → `/api/repair-issues`: composes degradation + soiling + equipmentHealth + forecastSkill into actionable repair cards.
- **Pack-risk v1/v2** consume degradation, thermalEvents, internalResistance, chargeCurve (see §9–10).

### Global honest-null / anti-footgun summary
Every engine here caches only when `dpus.length > 0`; prefers `null`/`learning`/`no-data`/`insufficient-cadence` to a fabricated number; excludes spare Cores from baselines while still scoring them; floors MAD in every robust-z test to avoid unbounded scores at zero scatter; and clamps published physical quantities (SoH ≤100, CE ≤100, RTE ≤100). The following HA sensors read `unknown` **by design** on the current near-new fleet, not because anything is broken: `..._soonest_pack_eol` (degradation), all `coulombicEffPct` (F17), predictive-SoH, and the immature IR trend.


---

## 7. Energy Accounting, Self-Consumption, Cost & Dispatch

This cluster covers the "economics" engines of ecoflow-panel: how the add-on
decomposes fleet energy flows into a conserved balance (PV → load / battery /
grid), how it accumulates the monotonic lifetime counters that feed Home
Assistant's Energy Dashboard, and the derived KPIs built on top of them —
self-consumption / solar-fraction, carbon avoided, TOU tariff cost, the greedy
day-ahead **dispatch plan**, the dynamic-programming **MPC** dispatch
recommender, and the two "wasted PV" detectors (inverter **clipping** and
SoC-saturation **curtailment**).

All code lives in `server/src/analytics.ts` unless noted. The lifetime
accumulators live in `server/src/recorder.ts`; the MPC lives in
`server/src/dispatch/mpc.ts`; the trapezoidal energy integrator lives in
`server/src/aggregator.ts`.

---

### 0. Foundations: the two grid quantities and the energy integrator

Two facts underpin every engine below, and getting them wrong is the source of
most historical bugs in this cluster.

#### 0.1 Trapezoidal, gap-aware integration (`integrateWh`)

`server/src/aggregator.ts::integrateWh(points, sinceMs, untilMs, maxGapMs=600000)`
is the one primitive that turns a power series (W samples) into energy (Wh) over
a window. Algorithm:

1. Clip samples to `[sinceMs, untilMs]`. If a sample exists just *before*
   `sinceMs` **and** the first in-window sample is within `maxGapMs` of it,
   synthesize a head point at `sinceMs` holding the pre-window value (assume the
   value held up to the window start).
2. Hold the last value to `untilMs` only if the tail sample is within `maxGapMs`.
3. Trapezoid each adjacent pair: `wh += ((v[i]+v[i-1])/2 · dtMs) / 3_600_000`,
   **skipping** any interval where `dtMs <= 0` or `dtMs > maxGapMs` (a gap → not
   extrapolated).

Returns `{ wh, coverageMs, totalMs, gapMs, samples }`. `coverageMs` (ms actually
integrated) is what the coverage gates below compare against.

| Constant | Value | Meaning |
|---|---|---|
| `maxGapMs` (default) | `10 min` | recorder heartbeats every 5 min; > 10 min = lost coverage, do not extrapolate |
| `INTEGRATE_HEAD_LOOKBACK_MS` | `10 min` | how far callers widen the query lower bound so the pre-window boundary sample is available |

> **F9 correctness note (v1.14.0):** the head-hold is conditioned on the *real*
> inter-sample gap (first-in-window − boundary), **not** the distance to the
> window edge. Otherwise the 5-min lifetime-rollup watermark could chop a real
> >10 min telemetry stall into ≤10 min slices and fabricate held-power Wh into
> `total_increasing` counters. An empty window contributes exactly 0.

#### 0.2 `gridImport` (DPU `ac_in`) vs `gridToHome` (SHP2 `grid_home_w`)

There are **two distinct grid metrics** and they are not interchangeable:

| Quantity | Source field | Recorder metric | Captures | Fleet lifetime key |
|---|---|---|---|---|
| **Grid import to battery** | DPU `ac_in` | `ac_in` (per DPU) | grid that AC-**charged the DPUs** — a *subset* of home grid | `fleet_grid_import_wh` |
| **Whole-home grid import** | SHP2 `wattInfo.gridWatt` | `grid_home_w` (SHP2) | grid metered at the SHP2 main that serves **home loads directly through the panel** — the term that closes the *load* balance | `fleet_grid_home_wh` |

On an SHP2 home the DPU `ac_in` reads **~0** while real grid flows through the
SHP2 main. Therefore **`grid_home_w` is the authoritative grid term** for the
solar-fraction, carbon, and tariff KPIs. But `grid_home_w` was only instrumented
in v0.34.0 with **no historical back-fill**, so for ~7 days after that update it
covered only the tail of the window while `panel_load` covered all of it — which
made the solar-fraction come out impossibly inflated. The fix is a **coverage
gate** (see §1.3), used identically by self-consumption, carbon, and tariff.

---

### 1. Self-Consumption / Solar-Fraction (`computeSelfConsumption`)

#### 1.1 What & why

Decomposes the last-7-day fleet energy into a conserved breakdown —
PV-generated, household load, battery charge/discharge, and grid import — and
derives the headline **solar fraction of load** (share of household consumption
*not* served by grid) and **direct-use ratio** (PV that went straight to load).
On an off-grid/no-export home the naive "self-consumption %" is structurally
100%, so the useful outputs are the breakdown and the two ratios.

#### 1.2 Inputs

| Input | Source | Notes |
|---|---|---|
| `pv_total` (per home DPU) | recorder | fleet PV |
| `ac_in` (per home DPU) | recorder | `gridImportKwh` |
| `pack{N}_in` / `pack{N}_out` (per pack) | recorder | battery charge / discharge |
| `panel_load` (SHP2) | recorder | `loadKwh` — the denominator |
| `grid_home_w` (SHP2) | recorder | whole-home grid (`gridToHomeKwh`) |
| SHP2 connector membership | `shp2ConnectedDpuSns(devices)` | scope: **home cores only** |

**Scope discipline (v0.9.76):** the numerator (PV/charge/discharge/`ac_in`) sums
over **SHP2-connected home DPUs only** because the denominator `panel_load` is
intrinsically home-only. Summing spare-core PV against home load once produced a
physically impossible `solarFractionOfLoadPct = 127%`.

#### 1.3 The calculation, step by step

1. **Window:** `since = now − windowDays·86_400_000` (default 7 days).
2. **Integrate energy per metric** via `windowedEnergyWh(...)` at a **300 s
   bucket** (`ANALYTICS_BUCKET_SEC = 300`). `windowedEnergyWh` memoizes each
   *completed calendar day*'s integral (immutable) keyed by
   `${dayStart}|${sn}|${sortedMetrics}` and only re-integrates today + the
   window's leading partial (7.4× faster warm; identical to whole-window to
   ~0.011 %). Cache retains ~10 days, pruned at 256 entries.
3. **Restore cloud-wedged cores (v0.78.0):** a SHP2-connected SN that's absent
   from the live device map (cloud-wedged) is added back by enumerating the
   `pack{N}_in/out` metrics that *actually exist* in the recorder via
   `listMetrics(sn)` — anti-fabrication: real recorded metrics only, an SN with
   no history contributes 0.
4. **Grid coverage gate:**
   ```
   gridHomeCoverageFrac = coverageMs(grid_home_w) / coverageMs(panel_load)   // clamped ≤1
   gridHomeTrusted      = shp2 present && gridHomeCoverageFrac ≥ 0.9          // GRID_HOME_MIN_COVERAGE
   ```
5. **Pick the grid term for KPIs:**
   ```
   gridForKpiKwh =
     no SHP2 (DPU-only)          → gridImportKwh          // ac_in IS the grid measure
     SHP2 && gridHomeTrusted     → max(gridToHomeKwh, gridImportKwh)
     SHP2 && NOT trusted (ramp)  → null                   // publish "unknown", never a wrong number
   ```
6. **PV↔battery↔grid apportionment (v0.93.0 audit #4):** the SHP2 carries the
   home from grid and tops the pool at the ~10 % floor, so grid *beyond* the load
   is what charged the battery from grid:
   ```
   gridToBatteryKwh = (shp2 && gridForKpiKwh!=null) ? max(0, gridForKpiKwh − loadKwh) : gridImportKwh
   pvToBatteryKwh   = max(0, batteryChargeKwh − gridToBatteryKwh)
   pvToLoadKwh      = max(0, pvKwh − pvToBatteryKwh)
   ```
7. **Headline KPIs (grid-displacement form, caps at 100 % by construction):**
   ```
   solarFractionOfLoadPct = (loadKwh>0.5 && gridForKpiKwh!=null)
        ? max(0, round(((loadKwh − gridForKpiKwh) / loadKwh)·1000)/10)  : null
   directUseRatioPct      = pvKwh>0.5 ? round((pvToLoadKwh/pvKwh)·1000)/10 : null
   ```
   > **v0.10.4 fix:** the prior `(pvToLoad + batteryDischarge)/load` form
   > double-counted PV that transited the battery (counted at charge *and* again
   > at discharge), yielding an impossible 104.5 % while importing 76 kWh grid.

#### 1.4 Coverage telemetry (`selfConsumptionCoverage`)

Because each home core's own metrics are integrated, a wired core that goes
cloud-offline silently deflates the KPIs. `selfConsumptionCoverage(connected,
homeDpus, devices, shp2Present)` reports:

- `homeDpusConnected` = `connected.size`
- `homeDpusReporting` = 0 when `connected.size===0`, else home cores with
  `devices[sn].online !== false`
- `coveragePartial` = `shp2Present && (homeDpusConnected===0 || reporting < connected)`

> **Anti-footgun (v0.69.0):** when the SHP2 *itself* is cloud-offline it reports
> **zero** connectors — the KPI is *least* trustworthy. Deriving the flag naively
> as `reporting < connected` would read `N < 0 = false` ("fine") in exactly that
> window. The explicit `homeDpusConnected===0` clause flags it partial.

#### 1.5 Outputs — `SelfConsumption`

`GET /api/self-consumption?days=<1..30>` (default 7), cached 60 s.

```jsonc
{
  "generatedAt": 0, "windowDays": 7,
  "pvKwh": 0, "loadKwh": 0,
  "batteryChargeKwh": 0, "batteryDischargeKwh": 0,
  "gridImportKwh": 0,          // DPU ac_in
  "gridToHomeKwh": 0,          // SHP2 grid_home_w
  "pvToLoadKwh": 0, "pvToBatteryKwh": 0,
  "solarFractionOfLoadPct": 0,      // null when grid untrusted
  "directUseRatioPct": 0,           // null when pvKwh ≤ 0.5
  "gridForKpiKwh": 0,               // null on the grid_home_w ramp
  "gridHomeCoverageFrac": 0.0,
  "homeDpusConnected": 0, "homeDpusReporting": 0,
  "homeDpusCoveragePartial": false
}
```

#### 1.6 Trace to HA

`/api/ha-state` → `solar_fraction_of_load_percent` (= `solarFractionOfLoadPct`),
`direct_use_ratio_percent`, `self_consumption_coverage_partial`. MQTT sensors:
`ecoflow_solar_fraction_of_load`, `ecoflow_direct_use_ratio`,
`ecoflow_self_consumption_coverage_partial` (binary; `entity_category:
diagnostic`).

#### 1.7 Config & guards

| Knob | Default | Effect |
|---|---|---|
| `?days` query | 7 | window (clamped 1–30) |
| `GRID_HOME_MIN_COVERAGE` (const) | `0.9` | grid-trust gate |
| `ANALYTICS_BUCKET_SEC` (const) | `300` | SQL bucket |
| `SELF_CONSUMPTION_TTL_MS` (const) | `15 min` | engine cache |

- **Honest null:** `solarFractionOfLoadPct` / `gridForKpiKwh` are `null` (→ HA
  "unknown") during the `grid_home_w` instrument ramp — by design.
- **No poison-cache:** only latched when `dpus.length > 0 && shp2 != null`; a
  boot-partial snapshot may be *returned* but never cached (v0.15.13).

---

### 2. Lifetime Energy Accumulators (`recorder.getLifetimeTotals` + rollup)

#### 2.1 What & why

Monotonically-increasing kWh counters for HA's Energy Dashboard. HA ingests them
with `state_class: total_increasing` and treats any decrease as a meter reset, so
these counters must never regress.

#### 2.2 The two accumulation paths

**(a) Watt-integrated fleet keys** — `fleet_pv_wh`, `fleet_load_wh`,
`fleet_grid_import_wh`, `fleet_grid_home_wh`, plus `circuit_<N>` keys.
`rollupLifetime()` runs every **5 min** (`LIFETIME_ROLLUP_INTERVAL_MS`; first run
~30 s post-boot). Each tick, for each key it integrates
`integrateWh(samples, watermark, now)` from `watermark − LIFETIME_ROLLUP_LOOKBACK_MS`
(so `integrateWh` sees the pre-window boundary), adds `wh`, clamps negative
deltas to 0 (a sign-flip can't decrement), and advances the watermark.

**(b) BMS-sourced battery keys** — `fleet_battery_charge_wh`,
`fleet_battery_discharge_wh`. These come from the BMS coulomb registers
(`accuChgMah`/`accuDsgMah`), converted to home-relative Wh by subtracting a
per-pack baseline (`packDeltaWh`, deltas floored at 0), not integrated from
power. Each rollup stores `max(BMS, persistedFloor)` so a momentary BMS readback
dropout (0/null) never looks like "battery emptied".

#### 2.3 The RTE clamp invariant — history and current state

> **Anti-footgun.** The BMS packs ship with `accuDsgMah > accuChgMah` (bench
> cycling), so on the raw absolute registers the home discharge total permanently
> exceeded charge. Two one-time, marker-gated resets fixed the *sign* of the
> problem:
> - **v0.9.74** (`.shp2-filter-v1.flag`): re-zero the four fleet counters when the
>   SHP2-membership filter shipped.
> - **v0.13.0** (`.bms-baseline-v1.flag`): capture per-pack BMS baselines and
>   re-zero the two battery counters, so subsequent deltas drive them.
>
> **The old `discharge ≤ charge` clamp was REMOVED in v0.45.0.** Rationale: the
> `accu*` registers are **coulomb counters** over an *open* window (baseline →
> now) that legitimately ends **below** baseline SoC, so cumulative discharge
> honestly exceeds cumulative charge. HA never requires in ≥ out — it ingests the
> two counters as **independent** `total_increasing` sensors. The clamp protected
> no RTE sensor (RTE = `computeRoundTripEfficiency`, windowed, with its own ≤100 %
> clamp). Both monotone floors are now emitted **unclamped**; the discharge floor
> stepped up to its true (~+45 kWh higher) value once, post-deploy — an intended
> honest correction.

The surviving artifact is **informational only**: `battery_baseline_deficit_kwh
= discharge − charge` (positive = discharge ahead of charge; shrinks toward zero
as the pool returns to baseline SoC). A one-line log fires **once per transition**
into the deficit state (`deficitWh > 1000`), latched by `bmsClampActive`.

> Marker-file fail-safety (`markerPresentProbe`, v0.79.0): the one-time markers
> are probed by **reading** (not `existsSync`) to close a TOCTOU race; only a
> confirmed-absent (`ENOENT`) marker counts as "not yet claimed". Any other read
> error (EIO from a corrupt inode after unclean power-off — this host's dominant
> reboot cause) is treated as **claimed**, so the destructive reset never re-runs
> per boot. Writes use `wx` (exclusive create); `EEXIST` = a racing starter, = success.

#### 2.4 The micro-dip clamp (`clampLifetimeDip`)

The live total (`persistedWh + pendingWh`) is re-estimated every call and can dip
a few Wh below the last emitted value (rollup-persist vs live-trapezoid
rounding). Because HA reads any decrease as a reset, `clampLifetimeDip`:

```
if prevEmitted == null:            return pendingWh
dip = prevEmitted − (persisted + pending)
if 0 < dip ≤ maxDipWh (50):        return prevEmitted − persisted   // hold flat
else:                              return pendingWh                 // let a real reset pass
```

`lifetimeEmitHighWater` (the per-key last-emitted map) is seeded from a persisted
sidecar so the clamp keeps its baseline across restarts, and persisted on the
5-min rollup (not the hot read path).

#### 2.5 Outputs — `GET /api/lifetime-energy` (cached 15 s)

`toKwh(x) = round(x/1000·1000)/1000`; `live(k) = toKwh(persistedWh + pendingWh)`.

```jsonc
{
  "generated_at": 0,
  "pv_lifetime_kwh": 0,
  "load_lifetime_kwh": 0,
  "grid_import_lifetime_kwh": 0,        // fleet_grid_import_wh (DPU ac_in)
  "grid_to_home_lifetime_kwh": 0,       // fleet_grid_home_wh (SHP2 main)
  "battery_charge_lifetime_kwh": 0,
  "battery_discharge_lifetime_kwh": 0,
  "battery_baseline_deficit_kwh": 0,    // DISPLAY-ONLY: discharge − charge
  "details": { "<key>": { "persistedWh", "pendingWh", "watermarkMs" } }
}
```

`GET /api/debug/battery-lifetime` (cached 15 s, strictly read-only) surfaces
`rawChargeFloorWh`/`rawDischargeFloorWh`, emitted totals (persisted+pending
split), `deficitWh` (what the removed clamp *would* have shaved), the per-pack
`PackLifetimeDetail[]` (filter membership + offline held-carry +
`backfilledFromHistory`), and `offlineHeldMembers`.

#### 2.6 HA Energy Dashboard wiring

All six counters publish `device_class: energy, state_class: total_increasing`
MQTT sensors so they slot directly into HA's Energy Dashboard:

| MQTT `unique_id` | HA name | Value key |
|---|---|---|
| `ecoflow_pv_lifetime_kwh` | EcoFlow PV Production | `pv_lifetime_kwh` |
| `ecoflow_load_lifetime_kwh` | EcoFlow Home Consumption | `load_lifetime_kwh` |
| `ecoflow_grid_import_lifetime_kwh` | EcoFlow Grid to Battery Charge (diagnostic) | `grid_import_lifetime_kwh` |
| `ecoflow_grid_to_home_lifetime_kwh` | EcoFlow Grid Import (Home) | `grid_to_home_lifetime_kwh` |
| `ecoflow_battery_charge_lifetime_kwh` | EcoFlow Battery Energy In | `battery_charge_lifetime_kwh` |
| `ecoflow_battery_discharge_lifetime_kwh` | EcoFlow Battery Energy Out | `battery_discharge_lifetime_kwh` |

Per-circuit `ecoflow_circuit_<ch>_lifetime_kwh` sensors are enumerated from
`shp2.projection.circuits` (also `total_increasing`). `listLifetimeKeys()` lets
the MQTT payload emit per-circuit keys at startup — before the first poll — to
match retained HA sensors from the prior run.

---

### 3. Carbon Accounting (`computeCarbonReport`)

#### 3.1 What & why

Estimates CO₂ **avoided** by not pulling kWh from the grid, over a rolling window
and lifetime. Two "useful kWh" categories — PV-direct-to-load and
battery-discharge (mostly originally PV) — but they must not double-count PV that
cycled through the battery.

#### 3.2 Constants & formula

| Constant | Value |
|---|---|
| `DEFAULT_GRID_CO2_LB_PER_MWH` | `1100` (AZ avg; env `GRID_CO2_INTENSITY_LB_PER_MWH`) |
| `LB_PER_MWH_TO_KG_PER_KWH` | `0.4536 / 1000` |
| `KG_CO2_PER_MILE` | `0.404` (EPA avg passenger car) |
| `intensity` | `1100 · 0.0004536 ≈ 0.4990 kg/kWh` |

**Window carbon = grid you DIDN'T pull = `(load − whole-home grid)`** (v0.10.4 —
avoids the ~23 % overstatement of `pvToLoad + batteryDischarge`):

```
gridDisplacedKwh = sc.gridForKpiKwh != null ? max(0, sc.loadKwh − sc.gridForKpiKwh) : null
totalKg          = gridDisplacedKwh != null ? gridDisplacedKwh · intensity : null
pvToLoadKg       = min(sc.pvToLoadKwh · intensity, totalKg)      // capped so parts sum to total
batteryDischargeKg = max(0, totalKg − pvToLoadKg)
equivMilesNotDriven = round(totalKg / 0.404)
```

**Lifetime carbon** derives from the lifetime PV counter (unaffected by the grid
gate): `lifetimeKg = (fleet_pv_wh_live / 1000) · intensity` (lifetime PV ≈ grid
kWh avoided).

#### 3.3 Guards

- Reuses `computeSelfConsumption`'s **coverage-gated** `gridForKpiKwh`; window
  fields are **null** during the `grid_home_w` ramp (mirrors the solar-fraction
  gate) rather than overstating ~1.7×. Lifetime fields stay populated.
- Cache (`CARBON_TTL_MS = 15 min`) only latched when the fleet is **complete**
  (≥1 DPU *and* an SHP2), else the uncached zero is returned (v0.15.13).

#### 3.4 Outputs — `GET /api/carbon?days=<1..30>` (default 7, cached 60 s)

`CarbonReport`: `pvToLoadKgAvoided`, `batteryDischargeKgAvoided`,
`totalKgAvoided`, `equivMilesNotDriven` (all `null` on the ramp), plus
`lifetimePvKwh`, `lifetimeKgAvoided`, `lifetimeMilesNotDriven`,
`gridCo2IntensityKgPerKwh`. → `/api/ha-state`: `carbon_kg_avoided_7d`,
`carbon_lifetime_kg_avoided`. MQTT: `ecoflow_carbon_kg_avoided_7d`,
`ecoflow_carbon_lifetime_kg` / `_miles` (`total_increasing`).

---

### 4. TOU Tariff Cost (`computeTariffReport`, `onPeakAt`, `parseRange`)

#### 4.1 What & why

Estimates dollars actually spent on grid import **and** dollars saved (the price
you'd have paid for the load served from solar+battery), over 7 days and today,
at TOU rates.

#### 4.2 Tariff constants (all env-overridable)

| Constant | Env | Default |
|---|---|---|
| `TARIFF_FLAT_CENTS` | `TARIFF_FLAT_CENTS_PER_KWH` | `17` (operator's APS flat plan) |
| `TARIFF_ON_PEAK_CENTS` | `TARIFF_ON_PEAK_CENTS` | = flat (17) |
| `TARIFF_OFF_PEAK_CENTS` | `TARIFF_OFF_PEAK_CENTS` | = flat (17) |
| `TARIFF_ON_PEAK_HOURS_ENV` | `TARIFF_ON_PEAK_HOURS` | `"15-20"` |
| `TARIFF_ON_PEAK_DAYS_ENV` | `TARIFF_ON_PEAK_DAYS` | `"1-5"` (Mon–Fri) |

> **v0.9.58:** defaults to a **flat** rate — the prior 25¢/8¢ split implied a TOU
> plan most APS customers lack and silently overstated both cost and solar value.
> A TOU-plan user sets `TARIFF_ON_PEAK_CENTS` / `TARIFF_OFF_PEAK_CENTS`.

`onPeakAt(ts)`: `dow` mapped 1=Mon…7=Sun; both hour and day ranges support
wrap-around (`hStart > hEnd`). Returns `dayOk && hourOk`.

#### 4.3 Calculation

Prefetch each metric once for the full window at 60 s bucket, then walk **hourly**
calling `integrateWh` per hour (cuts ~960 SQL round-trips to ~5). Scope = SHP2
home DPUs only. Per hour:

```
rate  = (onPeakAt(t) ? ON_PEAK : OFF_PEAK)/100
gridWh = Σ integrateWh(ac_in_series[d], t, tEnd)            // home DPUs
loadWh = integrateWh(panel_load_series, t, tEnd)            // SHP2
if shp2 && gridHomeTrusted:  gridWh = max(gridWh, integrateWh(grid_home_w, t, tEnd))   // audit #5
gridCost  += (gridWh/1000)·rate
loadValue += (max(0, loadWh − gridWh)/1000)·rate           // v0.10.4 — value only the non-grid load
```

`gridHomeTrusted` uses the **same** coverage ≥ `GRID_HOME_MIN_COVERAGE` (0.9)
test as self-consumption. `tally()` runs for `since` (window) and `todayStart`.

> **v0.93.0 audit #5:** without the whole-home superset, an SHP2 home reported
> `gridImportCost=$0` (ac_in ~0) and credited ALL `panel_load` as solar value.

#### 4.4 Outputs — `GET /api/tariff?days=<1..30>` (default 7, cached 60 s)

`TariffReport`: `onPeakCents`, `offPeakCents`, `onPeakHours`, `onPeakDays`,
`gridImportCostDollars`, `solarLoadValueDollars`,
`netSavingsDollars = solarLoadValue − gridCost`, `todayGridImportCostDollars`,
`todaySolarLoadValueDollars`. → `/api/ha-state`:
`tariff_net_savings_7d_dollars`, `tariff_today_grid_cost_dollars`,
`tariff_today_solar_value_dollars`. MQTT: `ecoflow_tariff_today_cost`,
`ecoflow_tariff_today_saved`, `ecoflow_tariff_savings_7d` (unit USD).

Cache latched only when `dpus.length > 0 && shp2 != null` (v0.15.13 — `&&`, not
`||`; a boot-partial snapshot once produced net_savings −$4.36).

---

### 5. Greedy Dispatch Plan (`computeDispatchPlan`) — advisory only

#### 5.1 What & why

A day-ahead, hour-by-hour **advisory** plan showing what to do with the battery
(charge from PV / discharge to load / grid-import / hold) to minimize TOU cost,
plus estimated savings vs an all-grid baseline. **Advisory only** — issues no
writes.

#### 5.2 Round-trip efficiency (v1.27.0)

Unlike the discharge-only runway sims (which use `RUNWAY_DISCHARGE_EFFICIENCY`
0.94), this planner both charges and discharges, so a **round-trip** loss
applies, split **symmetrically** across the two legs:

```
DISPATCH_ROUND_TRIP_EFFICIENCY = clamp[0.80, 1.0]( env DISPATCH_ROUND_TRIP_EFFICIENCY ?? 0.945 )
legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.972       // η_chg = η_dis; net round-trip = RTE
```

> Reusing 0.94 on the discharge leg would imply `η_chg = RTE/0.94 > 1`
> (unphysical). This choice never under-states the grid import a real round trip
> needs (conservative).

#### 5.3 Inputs & state

From the SHP2 projection: `backupFullCapWh` → `fullKwh`, `backupRemainWh` →
`socKwh`, `backupReserveSoc` → `reservePct` (default 15). Returns `empty()` if
either capacity or remaining is null. `reserveKwh = fullKwh·reservePct/100`;
`targetPrePeakSocPct = 80` → `targetPrePeakKwh`. PV/load come from the day-ahead
`forecast.hours` (`forecastPvW`, `forecastLoadW`).

#### 5.4 Per-hour greedy branches

```
if pvKwh > loadKwh:                              // surplus PV → charge
    surplus = pvKwh − loadKwh;  room = fullKwh − socKwh
    stored  = min(surplus·legEff, room)          // pack GAINS legEff of PV surplus
    socKwh += stored;  flow = stored/legEff;  action = charge_from_pv
else:                                            // deficit
    deficit = loadKwh − pvKwh;  drawn = deficit/legEff   // pack DRAWS deficit/legEff
    if onPeak && socKwh − drawn ≥ reserveKwh:    action = discharge_to_load (saves most $)
    elif !onPeak && socKwh < targetPrePeakKwh:   // off-peak top-off before peak
        need = min(deficit + (targetPrePeakKwh − socKwh)·0.1, deficit + 1)
        hourlyCost = need·rate;  action = grid_import
        socKwh = min(fullKwh, socKwh + (need − deficit)·legEff)
    elif socKwh − drawn ≥ reserveKwh:            action = discharge_to_load
    else:                                        action = grid_import (forced; battery at reserve)
allGridCost += loadKwh·rate;  plannedCost += hourlyCost
```

The **reserve guard** always tests the *drawn* amount (`socKwh − drawn ≥
reserveKwh`) so a discharge can never dip the pack below reserve.

#### 5.5 Outputs — `GET /api/dispatch-plan` (cached 60 s at the route; 30 min engine)

`DispatchPlan`: `horizon`, `hours[]` (`{ts, pvW, loadW, socStartPct, socEndPct,
onPeak, action, flowW, hourlyCostDollars}`),
`estimatedSavingsDollars = allGridCost − plannedCost`, `targetPrePeakSocPct`
(80). Route: `computeDispatchPlan(store.get().devices, forecast)`. Returns
`empty()` when no forecast or no SHP2 capacity.

---

### 6. MPC Dispatch Recommender (`server/src/dispatch/mpc.ts::recommendDispatch`)

#### 6.1 What & why

A **discrete dynamic-programming** optimizer (Track B, v0.9.27) that produces a
recommended 24-hour reserve-setpoint + battery-flow schedule minimizing a cost
function trading grid-import $, cycling-degradation $, and reserve-dip risk.
**Recommend-only** — issues no writes; scored against a do-nothing baseline.

#### 6.2 State, actions, cost

- **State:** `(hour, SoC bucket)` over `SOC_BUCKETS` = `0,5,…,100` (21 buckets),
  horizon `H = 24`. `nearestBucket(soc) = round(soc/5)·5`.
- **Actions** (6): `lower` (Δreserve −10), `maintain` (0), `raise` (+15),
  `dischargeMax` (flow −MAX_C_RATE), `chargeFromGrid` (flow +MAX_C_RATE),
  `idleHold` (0). The DP-allowable reserve is floored at the operator's real
  `reserveFloorPct` and capped at 50 (**v0.93.0 audit #12** — the legacy `lower`
  action could otherwise drive reserve to 0 and the planner would recommend
  emptying the battery with no penalty).
- **`simulateHour`** enforces the balance
  `PV + grid_import + batt_discharge = load + batt_charge + grid_export` with
  three flow modes (charge-from-grid / discharge-max / passive), C-rate cap
  (`maxFlowKwh = MAX_C_RATE·capacity`), reserve headroom, and physical SoC
  bounds. Cost per hour:
  ```
  gridKwh·tariff − exportKwh·exportTariff + cycleKwh·cyclingCost + dipPenalty
  cycleKwh = charge + discharge   // round-trips penalized twice (correct)
  dipPenalty = max(0, reserveEnergy − endEnergy)·reserveDipPenalty
  ```
- **Risk-averse branch:** inside an on-peak window (tariff > median+2¢) or one
  imminent within 3 h, the DP uses the **P10** PV forecast (pessimistic) when
  sizing; the public per-hour view re-simulates on **P50**.
- Forward pass fills `dp[h+1][endBucket]` with the min-cost parent; back-walk
  from the cheapest `dp[H]` endpoint reconstructs the schedule; a separate
  baseline (always `maintain` at current floor, no arbitrage flow) gives
  `savingsVsBaselineUsd = baselineCost − optimizedCost`.

#### 6.3 Constants (env-overridable)

| Constant | Env | Default |
|---|---|---|
| `TARIFF_FALLBACK_CENTS` | `TARIFF_FLAT_CENTS_PER_KWH` | 17 |
| `ROUND_TRIP_EFFICIENCY` | `MPC_ROUND_TRIP_EFFICIENCY` | 0.9 *(declared; surfaced in `notes` — the energy balance is modeled directly in `simulateHour`, not via this scalar)* |
| `MAX_C_RATE` | `MPC_MAX_C_RATE` | 0.25 (frac of pool/hour) |
| `EXPORT_TARIFF_CENTS` | `TARIFF_EXPORT_CENTS_PER_KWH` | 0 (no net-metering) |

#### 6.4 Degrade detection

`detectDegradeReason` returns `'no-tou-spread'` (tariff max−min < 1¢/kWh) or
`'flat-forecast'` (PV & load range < 5 % of mean) — the DP still runs (callers
want the shape) but `expectedSavingsUsd` is zeroed.

#### 6.5 Endpoint — `GET /api/dispatch/recommend` (cached 300 s)

Returns `503 {error:'SHP2 not online'}` if no SHP2. Inputs assembled in
`index.ts`: `currentSocPct = backupBatPercent??50`, `reserveFloorPct =
backupReserveSoc??20`, `capacityKwh = (backupFullCapWh??60000)/1000`, per-hour
`pvP50`/`pvP10` (from forecast + probabilistic bands), `loadForecast`,
`tariffByHour` (on-peak 15–20 h), and **`gridAvailable = process.env.GRID_AVAILABLE
=== 'true'`** (default **false** — v0.15.2 off-grid honesty: a hardcoded `true`
let the optimizer "assume away" reserve dips via imports that don't physically
exist on an islanded site). `cyclingCostUsdPerKwh` is fed **live** from RTE:
`baseWear (CYCLING_BASE_WEAR_USD_PER_KWH, 0.015) + (1−effFrac)·(flatCents/100)`,
fallback 0.02. Response = `{ inputs, ...MpcResult }` where `MpcResult` carries
`steps[]`, `totalCostUsd`, `costBreakdown`, `savingsVsBaselineUsd`,
`expectedSavingsUsd`, `setpointSchedule[]`, `degradeReason`, `notes[]`.

---

### 7. Inverter Clipping (`computeClipping`)

#### 7.1 What & why

Detects PV **lost to the inverter hardware ceiling**: the array wanted to produce
more than the MPPT/inverter could pass, so the excess was clipped. (Contrast §8
curtailment, the opposite — batteries full.)

#### 7.2 Inputs, constants

| Item | Value / source |
|---|---|
| `pv_total` per home DPU (today) | recorder, 60 s bucket → per-hour buckets |
| GHI per hour | `getWeather()` (Open-Meteo, cached) |
| Solar model | `forecast.restoredSolarModel ?? forecast.solarModel` (`hourly[hod].coeff`, `observedMaxPvW`) |
| `arrayPeakW` | `max(observedMaxPvW over hours)` |
| `CLIPPING_PEAK_FRAC` | `0.95` ("at peak" ≥ 0.95·arrayPeak) |
| `DAYLIGHT_GHI` | `20` W/m² |
| `CLIPPING_TTL_MS` | `5 min` |

Scope = SHP2-connected home cores **plus** cloud-wedged connected SNs (v0.78.0
display-basis restore), read straight from each SN's own recorded `pv_total`
(anti-fabrication).

#### 7.3 Per-hour calculation

```
observedW = Σ mean(pv_total bucket[h]) over clippingSns    // skip empty buckets
modelW    = (wx.radiationWm2 > DAYLIGHT_GHI && coeff!=null) ? coeff·radiationWm2 : null
atPeak    = observedW ≥ CLIPPING_PEAK_FRAC·arrayPeakW
if atPeak && modelW!=null && modelW>observedW:
    clippedW    = modelW − observedW
    clippedKwh += (clippedW/1000)·elapsedHrs     // current partial hour weighted
```

`nowMs` is an injectable clock for the elapsed-hour/local-day determination only;
cache freshness stays on the real wall clock (v0.99.0). Returns `empty()` on no
forecast / no DPUs / `arrayPeakW ≤ 0` / no weather.

#### 7.4 Outputs — `GET /api/clipping` (cached 60 s)

`ClippingEstimate`: `todayKwh`, `perHour[] ({hour, observedW, modelW, clippedW})`,
`arrayPeakW`, `hoursAtPeak`. → `/api/ha-state`: `pv_clipped_kwh_today`
(=`todayKwh`). MQTT: `ecoflow_pv_clipped_kwh_today`
(`device_class: energy, total_increasing`), `ecoflow_pv_array_peak_watts`
(diagnostic).

---

### 8. SoC-Saturation Curtailment (`computeCurtailment`)

#### 8.1 What & why

Detects PV **rejected at the array because there's nowhere for it to go** —
batteries at/near their charge ceiling and home load low, so the DPUs throttle
their MPPTs to match `(load + standby)`. The curtailed watts are never directly
observed; they're inferred as `expectedPV − actualPV`.

#### 8.2 Signal chain & guards

`predictExpectedPv` uses the **Bayesian** solar model
(`computeBayesianSolarModel`) posterior `μ[hour]·GHI` (requires ≥
`CURTAIL_MIN_BAYES_SAMPLES = 3` samples). Curtailment is called active when, for
the current hour, **all** hold:

| Guard | Constant |
|---|---|
| SoC ≥ saturation threshold | `saturationThresholdPct(ceiling)` = `(ceiling or 100) − CURTAIL_TAPER_BAND_PCT(10)` |
| PV actually producing | `CURTAIL_MIN_PV_W = 200` |
| meaningful gap (expected − actual) | `CURTAIL_MIN_SURPLUS_W = 300` |
| daylight | `CURTAIL_MIN_GHI_WM2 = 100` |
| posterior support | `CURTAIL_MIN_BAYES_SAMPLES = 3` |
| PV matched to load (not bulk-charge) | PV ≤ load·`CURTAIL_PV_MATCH_LOAD_FACTOR(2.0)` |

> **v0.9.78/79 taper insight:** the "battery full" threshold is **not** a fixed
> 96 %. DPUs charge to a *configured* `chgMaxSoc` (Storm Guard raises it to 100),
> and real PV rejection begins in the CV/absorption **taper ~10 % below** the
> ceiling, not at it — hence `ceiling − 10`. `homeChargeCeilingPct` = **mean**
> `chgMaxSoc` across home DPUs (mean, not min: the pool is saturated only when the
> average has reached the average ceiling).

`inactiveReason` enumerates why it's *not* firing: `soc-too-low` | `pv-too-low` |
`no-daylight` | `no-model` | `small-gap` | `pv-exceeds-load` | `no-shp2` |
`no-home-dpus`.

#### 8.3 History & outputs — `GET /api/curtailment` (cached 60 s route; `CURTAIL_TTL_MS = 5 min` engine)

`today` walks past hours with weather; `recent7d` (`CURTAIL_HISTORY_DAYS = 7`)
walks daylight hours (days 1–3 weather-verified from Open-Meteo `past_days=3`,
days 4–7 heuristic). `CurtailmentReport` fields: `active`, `currentSurplusW`,
`current{socAvg, pvActualW, pvExpectedW, loadW, ghiWm2, bayesianSamples,
chargeCeilingPct, saturationThresholdPct}`, `inactiveReason`, `todayKwh`,
`todayHours[]`, `recent7dKwh`, `recent7dHoursCount`, `hourlyHistogram[]`
(hour-of-day siting for opportunistic loads), and `opportunisticLoads[]` (static
Phoenix-home suggestions — pool pump 1800 W, dehumidifier 700 W, AC pre-cool
3500 W, water heater 4500 W, EV full-rate 7200 W — each with `fitsInSurplus`).
`computeCurtailmentAlerts` wraps this for the alert monitor.

→ `/api/ha-state`: `pv_curtailment_active`, `pv_curtailment_kwh_today`
(=`todayKwh`). MQTT: `ecoflow_pv_curtailment_active` (binary — ON means "we are
curtailing", not power-present), `ecoflow_pv_curtailment_surplus_watts`,
`ecoflow_pv_curtailment_kwh_today` (`total_increasing`),
`ecoflow_pv_curtailment_kwh_7d`, `ecoflow_charge_ceiling` (diagnostic).

---

### 9. Cross-cutting: conservation, caching, honest-null

- **Energy conservation.** The self-consumption decomposition is internally
  consistent: `pvKwh = pvToLoadKwh + pvToBatteryKwh` and
  `gridForKpiKwh = gridToBatteryKwh + (load served by grid)`; carbon's
  `pvToLoadKg + batteryDischargeKg = totalKg` by the capping construction.
- **One grid gate, three consumers.** Self-consumption, carbon, and tariff all
  gate the whole-home grid term on `coverageMs(grid_home_w) /
  coverageMs(panel_load) ≥ GRID_HOME_MIN_COVERAGE (0.9)`. Below it they publish
  `null` (KPIs) or fall back to `ac_in` (tariff) rather than a wrong number.
- **Cache TTLs:** self-consumption 15 min, carbon 15 min (reuses warm
  self-consumption), tariff 15 min, dispatch-plan 30 min, clipping 5 min,
  curtailment 5 min; every route additionally wraps `cached(...)` with a
  hash-etag + short `Cache-Control` (60 s typical; lifetime-energy 15 s;
  dispatch/recommend 300 s).
- **No poison-cache of zeros.** All device-integrating engines require a
  *structurally complete* fleet (≥1 DPU **and** the SHP2) before latching, so a
  post-restart boot-partial snapshot is returned once but never cached.
- **Advisory ≠ control.** `computeDispatchPlan` and `recommendDispatch` are both
  recommend-only and touch no safety alarm or device write.


---

## 8. Alerts, Anomaly Detection, Incidents & Learning Loop

This is the complete reference for the ecoflow-panel alerting subsystem: how conditions become alerts, how learned/anomaly alerts are derived, how the monitor turns the per-tick alert list into notifications, incidents, and telemetry, and how operator feedback feeds a learning loop. Everything below is drawn from the actual source in `server/src/` — real function names, constants, thresholds, endpoint paths, and env keys.

The architecture is a pipeline:

```
                            ┌── computeAlerts()        (threshold, alerts.ts)
                            ├── computeLearnedAlerts() (peer-comparison)
                            ├── computeBaselineAlerts()(self-baseline)      ─┐  analytics.ts
                            ├── computeForecastAlerts()(degradation/runtime) │
snapshot.devices ─► evaluateInner() (alertMonitor.ts) ├── forecastDayAlerts()   (solar/load)          ─┘
                            ├── outageAlerts()         (data-gap events)
                            ├── broadcastHealthAlert() (audible self-alert)
                            └── rateFloorAlerts()      (msg-rate collapse)
                                       │
                                       ├─► store.setAlerts()   → snapshot.alerts → /api/snapshot, WS, HACS cards
                                       ├─► buildIncidents()     → /api/incidents
                                       ├─► rising/falling edges → notify.ts (ntfy/Pushover/webhook/HA) + digest
                                       ├─► telemetry rollups     → /api/alert-telemetry (drives auto-silence)
                                       ├─► featureSnapshot capture → learning loop
                                       └─► cleared log            → /api/alerts/history
```

Two independent identity concepts run throughout and must not be confused:

- **`alert.id`** — the stable per-subject key, e.g. `soc-low-<SN>-<packNum>`, `dpu-err-<SN>`, `peer-temp-<SN>-<pack>`. It is the notification dedup key and the cleared-history key.
- **`familyOf(alert.id)`** (`alertOutcomes.ts`) — the rollup key that strips device serials and trailing pack numbers, e.g. `soc-low`, `cell-imbalance`, `pack-hot`. Auto-silencing and outcome precision are keyed by **family** so a condition spread across 5 packs aggregates as one statistical unit.

---

### 1. The `Alert` type and priority taxonomy

#### The `Alert` shape (`alerts.ts`)

```ts
interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  category: 'Battery' | 'Solar' | 'Thermal' | 'SHP2' | 'Grid' | 'Connectivity';
  device: string;
  title: string;
  detail: string;
  source?: 'threshold' | 'learned';       // default 'threshold'; 'learned' = anomaly/forecast engine
  priority?: 'critical' | 'high' | 'medium' | 'low';  // explicit ISA tier (wins over the heuristic)
  coreNum?: number | null;                // subject identity: Core (DPU) number
  packNum?: number | null;                // subject identity: pack number
  facts?: AlertFact[];                    // { label, value } statistical breakdown
  annunciate?: boolean;                   // false = VISIBLE but never chime/push/raise-condition
}
```

Two fields carry most of the subtlety:

- **`annunciate: false`** — the annunciation gate (v0.16.4). The condition still renders in `snapshot.alerts` (never hide an active alarm), but it must never produce an audible broadcast, a push, or raise the broadcast condition level. Used for expected steady states (a designated bench spare offline). Both annunciation channels honour it: `broadcast.conditionFromAlerts` (audible) and the monitor's rising-edge router (push/digest).
- **`priority`** — explicit ISA-18.2 tier. When present, `priorityOf()` reads it FIRST and skips the severity+source heuristic. Lets a *real* measured threshold crossing reach ISA Medium without faking `source='learned'` (which would misroute it to the Predictive page).

#### ISA-18.2 / IEC 62682 priority derivation (`alertPriority.ts`)

`priorityOf(alert)` is the single source of truth:

```
if alert.priority present          → use it verbatim
else if severity === 'critical'    → 'critical'  (P1)
else if severity === 'warning'     → source === 'learned' ? 'medium' (P3) : 'high' (P2)
else                               → 'low'        (P4)
```

| Priority | ISA | rank | colorToken | klaxon | Meaning |
|----------|-----|------|-----------|--------|---------|
| critical | P1  | 0 | bad  | red    | Immediate action to protect people/battery/plant |
| high     | P2  | 1 | high | red    | Protective hardware limit crossed; prompt action |
| medium   | P3  | 2 | warn | yellow | Learned/statistical anomaly; investigate |
| low      | P4  | 3 | info | yellow | Advisory / situational awareness |

The High-vs-Medium split on `source` is itself ISA logic: a deterministic threshold breach is more certain and more actionable than a learned deviation. `klaxonLevelForPriority()` maps critical+high → `red`, medium+low → `yellow` (green is reserved for genuine recovery via `conditionFromAlerts`, never a priority). `notifyBracketPriority(alert, effectiveSeverity)` computes the `[Medium]`-style title bracket, honouring the explicit priority UNLESS auto-tune demoted the severity for this send (then the demoted severity drives the bracket → `[Low]`). The web app mirrors this file at `web/src/alertPriority.ts` and the two must stay in lockstep.

---

### 2. Threshold alerts — `computeAlerts()` (`alerts.ts`)

**WHAT.** The static-rule engine and the single source of truth for `snapshot.alerts`. Given the device map (plus optional connectivity and grid context) it returns a sorted `Alert[]`. The web UI renders this; the monitor uses the same output to decide what to push.

**Signature:** `computeAlerts(devices, connectivity?, grid?)`.

- `grid?: { present?, backstopping?, reason? }` — when the grid backstops the home, at/near-reserve conditions merely transfer to mains and are downgraded critical→info (still visible, no chime). Omitted ⇒ treated as off-grid (safe default).
- `connectivity?: ConnectivityContext` — carries last `/device/list` attempt/success timestamps, per-device MQTT last-seen/count, and several debounce-onset maps read from the snapshot store (`backupPoolUnknownSinceMs`, `dpuErrOnsetBySn`, `shp2SrcErrOnsetBySlot`).

#### 2.1 Constants and temperature bands

Temperature bands (`TempBand = { infoF, warnF, critF? }`, one band per physically-distinct sensor; exported so the TUI colours readings against the same lines):

| Band | infoF | warnF | critF |
|------|-------|-------|-------|
| `CELL_TEMP` | 104 | 113 | 131 |
| `MOS_TEMP` | 104 | 131 | 149 |
| `BOARD_TEMP` | 113 | 140 | 158 |
| `SHUNT_TEMP` | 113 | 140 | — |
| `MPPT_TEMP` | 131 | 149 | 167 |
| `PTC_TEMP` | 158 | 176 | 194 |  (TUI-colour only; no alert wired — PTC is a resistive heater, hot by design) |
| `CELL_TEMP_COLD_F` | — | — | ≤ 41 °F fires a cold-charge-derate warning |

`classifyTemp()` converts °C→°F (`cToF = c*1.8+32`) and returns the highest band crossed. `tempAlert()` builds the alert with verb (`overheating`/`running hot`/`getting warm`).

Battery/voltage/health thresholds:

| Constant | Value | Purpose |
|----------|-------|---------|
| `VOL_DIFF_WARN_MV` | 20 | vdiff warning HOLD floor (hysteresis low side) |
| `VOL_DIFF_WARN_RISE_MV` | 24 | vdiff warning FIRE line (rise-side hysteresis) |
| `VOL_DIFF_CRIT_MV` | 50 | cell-imbalance critical (off-plateau) |
| `VOL_DIFF_PLATEAU_SOC_PCT` | 85 (`VOL_DIFF_PLATEAU_SOC_PCT` env) | above this SoC, relax the crit |
| `VOL_DIFF_PLATEAU_CRIT_MV` | 90 (`VOL_DIFF_PLATEAU_CRIT_MV` env) | relaxed crit on the LFP top-of-charge plateau |
| `VOL_DIFF_PLATEAU_QUIET_SOC_PCT` | 95 (env) | at/above this pack SoC, warn-band spread is visible but `annunciate:false` (v1.45.0) |
| `SOH_WARN_PCT` / `SOH_CRIT_PCT` | 85 / 75 | pack health warn/critical |
| `PACK_SOC_LOW_PCT` | 10 | per-pack "nearly empty" |
| `PACK_IMBALANCE_WARN_PCT` | 15 | intra-DPU SoC spread warning |
| `STALE_MS` | 3 min | telemetry-stale threshold |
| `CIRCUIT_BREAKER_WARN_FRAC` | 0.9 | circuit ≥90% of breaker capacity |
| `CLOUD_SESSION_STALE_MS` | 5 min | `/device/list` poll gap → session-stale alert |
| `RESERVE_BLIND_AFTER_MS` / `_CRITICAL_MS` | 15 min / 60 min | reserve-alarm-blind debounce / off-grid escalation |
| `DPU_ERR_DEBOUNCE_MS` | 3 min | inverter/source error must persist this long before CRITICAL |
| `MPPT_WATT_FLOOR` / `MPPT_AMP_FLOOR` | 20 W / 0.3 A | "string is meaningfully producing" gate |

#### 2.2 Alerts emitted (id → condition → severity)

**System / connectivity:**

- `cloud-session-stale` (warning, Connectivity) — no successful `/device/list` in `CLOUD_SESSION_STALE_MS`; per-device online flags are last-known, not current.
- `host-power-undervoltage` (warning) — `HOST_POWER_ENTITY` (HA RPi Power Supply Checker) tripped; early warning the Pi is browning out.
- `grid-offgrid` (info, Grid) — off-grid. Decision uses `grid.present` when supplied (the same resolver behind `binary_sensor.off_grid`); falls back to `acIn < 5` W over SHP2-bound cores only. Wall-charging spares never register as grid.
- `offline-<SN>` / `offline-spare-<SN>` (warning for Core/Panel, info otherwise; spare=info+`annunciate:false`) — device offline per `/device/list`. Enriched with last-data age/source, MQTT count, and a cause-matched hint; when `ECOFLOW_DEVICE_REACHABILITY` is configured, `classifyDeviceLink()` adds a `cloud_wedge` vs `real_outage` fact and hint. Explicit priority: Panel=high (alarm data source), Core=medium, peripheral=low, spare=low.
- `stale-<SN>` / `stale-spare-<SN>` (warning; spare=info) — online per EcoFlow but no fresh telemetry for > `STALE_MS`.

**Per-DPU (Core), for online DPUs:**

- `dpu-err-<SN>` (critical, Battery) — `sysErrCode != 0`, **debounced** by `DPU_ERR_DEBOUNCE_MS`: suppressed until the SAME code has stood 3 min (cloud-reconnect blips 20–160 s are dropped). No onset context ⇒ fires immediately (never silently loses a real fault).
- `dpu-pvh-err-<SN>` / `dpu-pvl-err-<SN>` (warning, Solar) — HV/LV MPPT error code AND the string is actually producing per `mpptProducing(watts, amps)` (needs BOTH watts > 20 W and, if reported, amps > 0.3 A). Rejects sunset/dusk standby codes that are identical across independent cores.
- `mppt-hv-temp-<SN>` / `mppt-lv-temp-<SN>` — `MPPT_TEMP` band. Channel slug precedes SN so `familyOf` yields per-channel families.
- `ems-volt-<SN>` (warning, Battery) — pack voltage outside EcoFlow's `emsParaVol` parallel-operation window.
- `dpu-imbalance-<SN>` (warning) — SoC spread across the DPU's packs ≥ `PACK_IMBALANCE_WARN_PCT` (15%).

**Per-pack (each DPU pack):**

- `soh-crit-<SN>-<pk>` (critical) / `soh-warn-<SN>-<pk>` (warning) — `actSoh ?? soh` below 75 / 85%.
- `vdiff-crit-<SN>-<pk>` (critical) / `vdiff-warn-<SN>-<pk>` (warning) — cell spread. **Rise-side hysteresis** (F28): warning fires only at ≥ `VOL_DIFF_WARN_RISE_MV` (24 mV), then HOLDS while still ≥ `VOL_DIFF_WARN_MV` (20 mV); held state is keyed `${sn}-${pk}` and pruned each cycle for any pack that produced no reading. Critical at ≥ `critMv` where `critMv` = 90 mV on the plateau (`packSoc ≥ 85%`) else 50 mV. Three `annunciate:false` demotions keep benign excursions visible-but-silent: (a) `balanceState != 0` (BMS actively balancing), (b) a plateau-benign excursion (would be crit off-plateau but under the relaxed plateau ceiling, BMS idle), (c) **v1.45.0** — any warn-band spread on a pack at ≥ `VOL_DIFF_PLATEAU_QUIET_SOC_PCT` (95%): at top of charge the LFP curve transiently widens warn-band spread fleet-wide (observed: 14 of 15 packs within two hours of a full top-up, all self-clearing), so those stay visible without pushing. Silence is bounded — SoC dropping below the respective plateau line re-arms standard annunciation, and the plateau-critical ceiling (90 mV) always annunciates.
- **Cell forensics (v1.41.0).** Every cell-fault alert carries detection → isolation → root cause with supporting ranges, sourced from the pure helpers `packCellForensics` and `packLatchSignature` (`alerts.ts`, unit-tested, null when per-cell telemetry is absent):
  - `packCellForensics` isolates the cell farthest from the pack's median cell voltage across the 32S1P string (`cellVoltagesMv`) and reports the deviant cell's 1-based index, its voltage, the pack median, the **signed deviation** (negative = weak/low cell), the pack spread, and the sibling packs' spreads for contrast. The critical's detail names the isolated cell inline (spoken by the audible pipeline); the full dossier renders as alert facts.
  - `packLatchSignature` classifies a **BMS protection latch** only when all three legs hold: the pack is SoC-stranded ≥ 20 points below the sibling median, exchanging < 25 W, while the sibling median flow is ≥ 100 W. A pack idling alongside idle siblings never classifies (no false latch verdicts from shared idleness).
  - `dpu-err-<SN>` titles by error-code band: codes 500–599 present as **"Battery protection fault"** (battery/BMS protection band) instead of the historical blanket "Inverter error code" that mis-pointed triage; the alert id is unchanged so a standing fault does not re-raise on upgrade. When a pack shows the latch signature, the alert names the probable source pack and attaches the cell dossier.
  - `dpu-imbalance-<SN>` names the lowest pack and, when the latch signature holds, states the stranded-pack flow contrast explicitly.
- `balancing-<SN>-<pk>` (info) — BMS actively balancing (housekeeping).
- `temp-cell-` / `temp-mos-` / `temp-board-` / `temp-shunt-<SN>-<pk>` — per-sensor `tempAlert()` against the respective band.
- `temp-cold-<SN>-<pk>` (warning, Thermal) — min cell temp ≤ 41 °F (charge derates near freezing).
- `soc-low-<SN>-<pk>` (warning) — pack SoC ≤ `PACK_SOC_LOW_PCT` (10%).

Online bench spares (`SPARE_DPU_SNS` not wired into SHP2) get `annunciate:false` stamped on **every** alert they emitted this DPU block (dpu-err, mppt-*, vdiff-*, soh-*, soc-low, temp-*, ems-volt, imbalance).

**SHP2:**

- `shp2-below-reserve` (critical off-grid, info on-grid, SHP2) — `backupBatPercent <= reserve` (INCLUSIVE, matching `runwayAlarm.belowReserveFloor`; the pool pins at exactly the integer reserve for hours nightly). `reserve = backupReserveSoc ?? 15`.
- `shp2-near-reserve` (warning off-grid, info on-grid) — `reserve < backupBatPercent < reserve+10`.
- `shp2-src-err-<slot>` (critical, SHP2) — energy-source error count `errorCodeNum != 0`, **debounced** by the same `DPU_ERR_DEBOUNCE_MS` per `<sn>:<slot>` onset.
- `shp2-src-hw-<slot>` (warning) — slot `isConnected && !hwConnect`.
- `circuit-overload-<primaryCh>` (warning) — paired-circuit watts ≥ `capacity * 0.9`, where `capacity = breakerAmps * (isSplitPhase ? 240 : 120)`.

**Reserve-alarm-blind compensating alert (F3):**

- `reserve-alarm-blind` (warning; critical after `RESERVE_BLIND_CRITICAL_MS` off-grid) — the entire reserve chain keys off the SHP2 backup-pool %; when that reads null (cloud wedge) for ≥ `RESERVE_BLIND_AFTER_MS` (15 min past the grace hold), this says the reserve alarm is *blind right now*. Reports the `homeFleetMeanSoc()` fallback ladder. Listed in `ENERGY_STATE_FAMILIES` so the auto-silencer can never eat it.

**Backup-pool SoC ladder:**

- `backup-soc-<pct>` — one on-screen alert for the lowest SoC threshold the pool is at/below, ladder **50 / 40 / 30 / 20 / 15 / 10 / 8 / 4 / 2 %**, via `activeSocBandWithHysteresis(soc, heldBand)` (clears only once SoC climbs past band+2, matching the audible ladder's re-arm margin). Severity/priority from `socAlertSeverity`. **Dedup:** suppressed inside the `shp2-near/below-reserve` window when the SHP2 is online (`coveredByShp2Pair`); on a cloud-offline SHP2 the band remains the fallback. The id MUST start `backup-soc` so `broadcast.ts` excludes it from its own chime — the escalating audible SoC alarm is fired separately by `batterySocAlarm`/`index.ts`.

Output is sorted by `SEVERITY_ORDER` (critical=0, warning=1, info=2) then category.

#### 2.3 System data-gap / unplanned-outage EVENTS (`outageAlerts()`)

The recorder persists telemetry blackouts (host power loss / add-on stop / MQTT stall) into a gaps sidecar. `outageAlerts(gaps, now, opts)` turns each recent gap into a WARNING push (ISA medium, or **low** when the gap matched a graceful clean-shutdown marker — a deploy). It is an EVENT, not a condition:

- Stable id `outageAlertId(startMs, durationMs)` = `system-outage-<startMs>[-<tier>]`, where `outageDurationTier` is 0 (<15 min), 1 (≥15 min), 2 (≥1 h), 3 (≥6 h). Crossing a tier changes the id so an in-place-extended blackout re-notifies with its true magnitude.
- `isOutageEventFamily()` (id starts `system-outage-`) → **never** sends a "Resolved:" (`shouldSendResolve` returns false) and is NOT firstRun-boot-seeded (`bootSeedNotified`), so a restart-spanning outage fires on the boot that follows it.
- `resolveOutageAlertOptions(env)` (NaN-safe via `envNum`): `SYSTEM_OUTAGE_ALERT_ENABLED` (default true), `SYSTEM_OUTAGE_RECENT_WINDOW_H` (24), `SYSTEM_OUTAGE_MIN_MINUTES` (15), `SYSTEM_OUTAGE_RESTART_MIN_MINUTES` (5 — lower floor for restart-spanning gaps).
- `outageTracking()` / `systemOutageFields()` feed HA `system_outage_*` sensors, splitting count into `powerOutageCount` (host down) vs `gracefulRestartCount` (deploys) vs `telemetryGapCount` (cloud stall) so a deploy doesn't poison the power-loss trend.

---

### 3. The four learned-alert families (`analytics.ts`)

Learned alerts carry `source: 'learned'` (→ ISA Medium at warning severity). Robust statistics use `median` + `mad` (median absolute deviation) and a MAD-floored modified z (`robustZ(v, med, mad, floor, floorZ)`). Global gates: `Z_INFO = 3.5`, `Z_WARN = 5`.

#### 3.1 Peer-comparison — `computeLearnedAlerts(devices)`

**WHAT.** For each online DPU with ≥3 packs, compares each pack against its sibling packs on four metrics, flagging the outlier. Naturally cancels positional bias.

`PEER_METRICS` (getters return DISPLAY units):

| key | label | category | floor | source field |
|-----|-------|----------|-------|--------------|
| `temp` | temperature | Thermal | 9 °F | `maxCellTemp ?? temp` (→°F) |
| `voldiff` | cell-voltage spread | Battery | 10 mV | `maxVolDiffMv` |
| `soh` | state of health | Battery | 2 % | `actSoh ?? soh` |
| `soc` | state of charge | Battery | 8 % | `soc` |

**CALCULATION.** Per metric: collect finite sibling values → `med`, `m = mad`. For each pack, `absDev = |v − med|`; skip if `absDev < floor`. Compute `z = robustZ(v, med, m, floor, Z_INFO)` (a bare floor-cross with zero sibling scatter scores exactly `Z_INFO`, not infinity); skip if `z < Z_INFO`. **Hysteresis** (`bumpPeerHit(key)` keyed `metric-sn-pack`): require ≥ `PEER_HIT_EMIT_MIN` = 3 consecutive eval cycles before emitting; `prunePeerHitCounts(seen)` resets any key that lapsed a cycle. Severity: `z ≥ Z_WARN && warnEligible ? 'warning' : 'info'`, where thermal outliers are `warnEligible` only on the HOT side (a cold pack is benign).

**OUTPUT id** `peer-<key>-<SN>-<pk>` with facts: this pack, sibling median, deviation, peer z-score, flag thresholds.

#### 3.2 Self-baseline — `computeBaselineAlerts(devices, recorder)`

**WHAT.** Each sensor learns its OWN normal range from history, bucketed by hour-of-day (±1 h window) so daily cycles don't false-alarm. Catches "unusual for itself" deviations peer/threshold both miss. Cached ~5 min (`BASELINE_TTL_MS`).

**Targets** (`buildBaselineTargets`): per DPU — `mppt_hv_temp`/`mppt_lv_temp` (floor 9 °F), `pack{N}_temp` (9 °F), `pack{N}_board` (11 °F); per SHP2 — `pair{ch}_w` for paired circuits and `ch{N}_w` for the rest (floor 500 W, `sustained: true`).

**CALCULATION.** Pull `BASELINE_HISTORY_MS` (14 d) of history; need ≥ `BASELINE_MIN_SAMPLES` (8) samples and ≥ `BASELINE_MIN_SPAN_MS` (2 d) span. Bucket samples within ±1 hour of the current hour-of-day (again ≥8). `med`, `m = mad`, `absDev = |live − med|`; skip if `< floor`. For `sustained` load circuits: require the excursion to PERSIST — of the recent `BASELINE_SUSTAINED_MS` (30 min) real-time samples (≥ `BASELINE_SUSTAINED_MIN_RECENT`=3), ≥ `BASELINE_SUSTAINED_FRAC` (0.6) must sit on the same side past the floor, else skip (rejects AC-compressor cycling). `z = robustZ(live, med, m, floor, Z_INFO)`; skip `< Z_INFO`. **Severity:** `sustained` targets are capped at INFO (a bimodal on/off circuit scores huge z every cycle; the dedicated `circuit-overload-<ch>` absolute alert covers real faults); other targets use `z ≥ Z_WARN ? 'warning' : 'info'`.

**OUTPUT id** `baseline-<metric>-<SN>` (e.g. `baseline-pair6_w-<SN>`, `baseline-pack3_temp-<SN>`), title "… unusual for the hour", facts: current, typical-this-hour, deviation, baseline window (days/samples), z-score.

**Regime-shift absorption (v1.42.0).** The baseline is a rolling 14-day hour-of-day median with no stored model, so a persistent behavior change (for example two AC zones exchanging duty roles) is fully absorbed once the new pattern becomes the window majority (≈ 7 days). Until then the deviation is real but is a *new normal*, not an anomaly: `regimeShiftDays` (pure, exported) counts trailing consecutive days whose daily bucket-median deviates in the same direction past the floor, and at ≥ `REGIME_SHIFT_MIN_DAYS` (5) the alert states the situation ("persisted N consecutive days — a new normal pattern the rolling baseline is absorbing, ~M day(s) to full absorption") and sets `annunciate:false` until absorption completes. A trailing day that reverses direction, or deviates under the floor, breaks the streak and restores normal annunciation.

#### 3.3 Degradation & runtime forecast — `computeForecastAlerts(devices, recorder, forecast?)`

**WHAT.** Regression-based projections. Cached ~10 min (`FORECAST_TTL_MS`), keyed also on the depletion gate boolean.

- **`forecast-runtime-<SN>`** (SHP2) — linear regression of `backup_pct` over the trailing `RUNTIME_TRAIL_MS` (3 h). Fires only when slope `pctPerHour < -0.05`, `cur > reserve`, AND the diurnal day-ahead forecast ALSO confirms depletion (`diurnalConfirmsDepletion` = `forecast.minProjectedSoc < forecast.reserveSoc`). The displayed time-to-reserve is **bounded** by the diurnal forecast's own first reserve-crossing hour (the flat trailing extrapolation ignores dawn recovery and can read ~4× the authoritative runway). Severity: `<6 h` warning, `≤18 h` info; grid-backstopping downgrades warning→info. Facts include decline rate, implied draw, R², reserve floor, ETA.
- **`forecast-soh-<SN>-<pk>`** (info, Battery) — SoH decline → projected months to 85%. Uses its OWN tighter gates: `SOH_FORECAST_HISTORY_MS` (120 d), `SOH_DEGRADE_MIN_SPAN_MS` (45 d), `SOH_DEGRADE_MIN_R2` (0.5), plus `sohStepDominated`/`sohSignalBelowFloor` guards and a `MAX_SOH_FADE_PCT_PER_YEAR` (10%/yr) ceiling — so it fires only on an abnormal ~6–10 %/yr decline, never on normal 2–3 %/yr aging (which would be alarm fatigue and is backstopped by the SoH threshold alarm).
- **`forecast-imbalance-<SN>-<pk>`** (warning, Battery) — cell-spread rising → projected weeks to 50 mV. Shared gates: `DEGRADE_MIN_SPAN_MS` (5 d), `DEGRADE_MIN_R2` (0.25); fires when `mvPerWeek > 0.5` and current spread < 50 mV and `0 < weeksTo50 < 52`.

#### 3.4 Solar/load day-ahead — `forecastDayAlerts(df, grid?)`

**WHAT.** Narrative alerts from the learned solar-response `DayForecast`. Also does **counterfactual driver analysis** — decomposing a shortfall into "cloud cover" vs "everything else (shading/soiling/model error)".

- **`forecast-soc-dip`** (warning; info when grid backstopping, SHP2) — `minProjectedSoc < reserveSoc`. Discriminates severity by *hours-below-reserve* (depth alone is degenerate on a grid-tied home that pins at the floor). `why` text is chosen by average cloud cover (>50% / >30% / else). Facts: projected low SoC, reserve, hours below reserve, expected-at, solar next 24 h, clear-sky ceiling, avg cloud.
- **`forecast-low-solar`** (info, Solar) — `forecastPvWhNext24 < 0.6 × typicalBiasAdjusted`, where `typicalBiasAdjusted = typicalPvWhPerDay × pvBiasFactor` (puts both sides on the same bias basis). `why` attributes the gap to cloud (>60% / >40% / else) vs equipment.
- **`soiling-pv`** (info; warning if `dropPct ≥ 22`, Solar) — clear-sky output ≥ 12% below the clean-panel baseline, with `cleanDays ≥ 6` and `recentCovered !== false`.

#### Other learned/situational sources threaded into the monitor's eval

- **`stormPrepAlerts(devices)`** — NWS storm → `storm-*` (also converted to repair issues).
- **`curtailmentAlerts`** (analytics report) — SoC-saturation headroom advisory (info).
- **`broadcastHealthAlert(getBroadcastHealth(), now)`** — the audible-delivery self-alert: when audible broadcasting is enabled but the broadcast monitor CONFIRMED no reachable speaker, one WARNING push rides the notify path (the audible channel can't announce its own outage). Null health ⇒ no alert. Its id is excluded from `conditionFromAlerts` so it never tries to chime.
- **`rateFloorAlerts(getRateFloorCollapses())`** — devices whose incoming message RATE collapsed below their learned baseline while `lastUpdated` stays fresh (the SHP2 ~13 h crawl that defeats staleness/gap detectors). WARNING push.

---

### 4. The alert monitor — `startAlertMonitor()` (`alertMonitor.ts`)

**WHAT.** Runs `evaluate()` every `EVAL_INTERVAL_MS` (`ALERT_EVAL_MS`, default 20 s), re-entrancy-guarded (`evaluating` latch — an overlapping tick during a hung send is skipped). Each tick: assembles the full alert list from all sources above, `store.setAlerts()`, `buildIncidents()`, then processes rising edges, the morning digest, and falling edges.

#### 4.1 Rising edges, debounce, dispatch decision

For each alert not yet tracked, the monitor captures a feature snapshot (§6), `recordRise()`, and seeds a `TrackedAlert` with `notified = bootSeedNotified(...)`. For an already-tracked alert it updates `peakSeverity` (the most-severe severity ever reached), refreshes the notify-state record if older than `NOTIFY_STATE_REFRESH_MS` (12 h), and — if annunciating — computes the dispatch decision.

**Debounce.** `DEBOUNCE_MS` (`ALERT_DEBOUNCE_MS`, default 60 s). Critical alerts bypass debounce (0 ms) so a brief critical isn't swallowed. The per-circuit load-anomaly family (`baseline-(ch|pair)N_w-…`, `isSustainGatedLoadAnomaly`) uses a much longer fire debounce `BASELINE_LOAD_SUSTAIN_MS` (`BASELINE_LOAD_SUSTAIN_MS`, default 8 min) so a normal compressor cycle clears inside the window and never pushes.

**Escalation.** `isAlertEscalation(prev, severity)` — an alert that has escalated above the severity it was last acted on (dispatched OR queued) re-notifies even after a prior push; a critical escalation bypasses debounce.

**The pure decision** `decideAlertDispatch({qualifies, alreadyNotified, alreadyQueued, escalated, debounceElapsed, inQuiet, breaksThrough})`:

```
eligible = (!alreadyNotified && !alreadyQueued) || escalated
if !eligible || !debounceElapsed || !qualifies → 'none'
return inQuiet && !breaksThrough ? 'queue' : 'dispatch'
```

`qualifies(sev, cfg.minSeverity)` gates on the configured minimum severity.

#### 4.2 Quiet hours (F1) and the morning digest

- `QUIET_WINDOW = parseQuietHours(NOTIFY_QUIET_HOURS)` (default `"22-06"`; `inQuietWindow` handles the midnight wrap). **This is the F1 knob the memory flags as the #1 postponed risk** — during quiet hours warning/info are queued for the morning digest.
- `CRITICAL_BREAKS_QUIET` (`CRITICAL_BREAKS_QUIET_HOURS`, default **false**) — when false, critical alerts are ALSO held for the digest (nights stay truly quiet); set `true`/`1` to be woken for criticals. The live config on this host holds every tier including critical until `DIGEST_HOUR`.
- `DIGEST_HOUR` (`NOTIFY_DIGEST_HOUR`, default 7). `dispatchDigest()` fires once when the local hour rolls to `DIGEST_HOUR`, sorted most-severe first, one line per subject with ISA-priority labels. It only digests entries still legitimately held (`tracked.get(id)?.queued === true`), and on success marks them notified + `pushSent` + persisted (deferred from queue-time, so a pre-digest restart re-queues rather than drops). A failed digest send does NOT latch `lastDigestHour`, so it retries each tick within the hour. No channel configured ⇒ it logs loudly and drops the queue.

Queue mechanics: `action === 'queue'` sets only the in-memory `queued` flag and `notifiedSeverity` (NOT `notified`, NOT persisted) so a restart re-evaluates and re-queues; an escalation-while-queued replaces the held entry in place (one line, escalated severity).

#### 4.3 Incident clustering — `buildIncidents(alerts)`

Groups the current alert list into `Incident`s so a cascade fires one notification, not five:

- **Pack-scoped** (`inc-core{N}.pack{M}`) — 2+ alerts on the same (Core, Pack); title "N concurrent alerts on Core X · Pack Y".
- **Core-scoped** (`inc-core{N}`) — 2+ alerts on the same Core with no pack; a same-category Thermal cluster is titled "Thermal cascade on Core X".
- **System-scoped** (`inc-system-<id>`) — orphans with no Core/pack pass through as 1-alert incidents.

Sorted by severity then alert-count desc. Served at **`/api/incidents`** (`{ incidents }`, cached 15 s).

#### 4.4 Cooldown / churn auto-silence

Family rollups (`AlertActionStats`, keyed by `familyOf`) track `riseCount`, `shortClearsCount`, `neverClearedCount` (longActive), `medianDurationMs` (EWMA), etc. Clear-duration classification (`classifyClearDuration`): `shortClear` = duration ≤ `SHORT_CLEAR_MS` (10 min), `longActive` = duration ≥ `CHRONIC_NOISE_LONG_MS` (4 h). **Every** cleared rise is counted (a sub-debounce <60 s flap is the most transient clear and MUST count as a shortClear — F for auto-demote reachability). Durations are clamped `max(0, ...)` against the Pi's backward clock jumps.

`applySilencingRules(t)` re-derives three flags from current counters on every evaluation (never one-way latches):

| Rule | Trigger | Effect |
|------|---------|--------|
| 1 (info silence) | `severity==='info'` & `riseCount≥5` & shortFrac ≥ 0.7 | `downgradedSilenced` → skip dispatch |
| 2 (warn→info) | `severity==='warning'` & `riseCount≥10` & shortFrac ≥ 0.8 | `warningDemotedToInfo` → notify at info priority |
| 3 (chronic noise) | not critical & `riseCount≥10` & neverClearFrac ≥ 0.5 | `chronicNoiseSilenced` → skip dispatch |
| 4 (high-volume) | not critical & `riseCount≥150` & neverClearFrac ≤ 0.2 | warning→demote, info→silence |

**Critical is never silenced or demoted.** `ENERGY_STATE_FAMILIES` are exempt from all four rules (a fast clear is a genuine recovery, not jitter): `backup-soc`, `shp2-below-reserve`, `shp2-near-reserve`, `soc-low`, `forecast-runtime`, `offline`, `stale`, `forecast-soc-dip`, `reserve-alarm-blind`. Bench-spare churn rolls up under separate `offline-spare` / `stale-spare` families so it can still be auto-tuned without poisoning home-device stats. In `dispatch()`, a critical alert is never suppressed even if its family latch was set from info/warning noise.

#### 4.5 Falling edges + resolve-side dwells

An alert absent this tick is a candidate for "Resolved:". Several family-specific dwells hold the falling edge to stop good-news spam from boundary flapping:

| Family predicate | Dwell | Env |
|------------------|-------|-----|
| `learned` alert within post-boot window | `LEARNED_RESOLVE_GRACE_MS` (10 min) | — (warm-up guard) |
| `isSustainGatedLoadAnomaly` | `BASELINE_LOAD_RESOLVE_DWELL_MS` (8 min) | `BASELINE_LOAD_RESOLVE_DWELL_MS` |
| `isSocResolveDwellFamily` (`soc-low-`) | `SOC_RESOLVE_DWELL_MS` (3 min) | `SOC_RESOLVE_DWELL_MS` |
| `isCellImbalanceResolveDwellFamily` (`vdiff-(warn|crit)-`, `peer-voldiff-`) | `VDIFF_RESOLVE_DWELL_MS` (3 min) | `VDIFF_RESOLVE_DWELL_MS` |
| `isForecastDipResolveDwellFamily` (`forecast-soc-dip`) | `FORECAST_DIP_RESOLVE_DWELL_MS` (90 min) | `FORECAST_DIP_RESOLVE_DWELL_MS` |

Dwells are resolve-ONLY — they can never delay a fire, an escalation, or the audible alarm. If the alert reappears mid-dwell the rising-edge path clears `clearedSince`.

Once the dwell passes: the notify-state record is deleted FIRST (so a failed resolve can't strand a record that eats a future re-fire), then `shouldSendResolve(t, notifyResolved, minSeverity)` gates the "Resolved:" push on `pushSent === true` (a REAL delivered fire, NOT boot-seeded `notified`), `annunciate !== false`, `notifyResolved`, and qualifying on the severity the fire was notified at. Outage events never resolve. Clears with `duration ≥ DEBOUNCE_MS` are recorded to `clearedLog` (at peak severity). `recordClear()` updates telemetry regardless of duration.

#### 4.6 Notify-state persistence & boot reconcile

`persistedNotified: Map<id, NotifyRecord{ts, sent, sev?, title?}>` survives restarts at `NOTIFY_STATE_PATH` (default sibling of the DB). Loaded with a `NOTIFY_STATE_MAX_AGE_MS` (24 h) TTL; still-active records are refreshed every 12 h so a >25 h cloud wedge keeps its owed "Resolved:" across the daily reboot. `orphanedNotifiedIds()` runs once per boot after `LEARNED_RESOLVE_GRACE_MS` warm-up: persisted ids neither firing nor tracked are retired — resolved (if owed, dismissing the exact HA card via the id-as-dedupId) or merely dropped. Dispatch is **at-least-once** (F): send first, mark `notified`/persist only when not `failed`; a failed send retries next tick.

Cleared history persists to `CLEARED_LOG_PATH` (default sibling of DB), cap `CLEARED_LOG_MAX` (`CLEARED_LOG_MAX`, default 1500, min 50). Eviction (`pruneOldestNonSignificant`) is severity-tiered: oldest info → oldest noise-flagged warning (auto-tune family flags) → oldest warning → oldest overall; a critical is evicted only when the whole log is criticals. Served at **`/api/alerts/history`** (`{ cleared }`, cached 30 s).

The `AlertMonitor` handle exposes `incidents()`, `telemetry()`, `history()`, `stats()`, `getConfig()`, `sendTest()`, `stop()`.

---

### 5. Notification delivery, dedupe, digest — `notify.ts`

**Channels** (`NOTIFY_CHANNEL`, default `none`): `ntfy`, `pushover`, `webhook`, `ha`, `none`. `isConfigured()` checks the channel's required creds; `ha` requires `SUPERVISOR_TOKEN`.

**Config** (`loadNotifyConfig`):

| Env | Field | Default |
|-----|-------|---------|
| `NOTIFY_CHANNEL` | channel | `none` |
| `NOTIFY_MIN_SEVERITY` | minSeverity (`warning`=warn+crit, `critical`=crit only) | `warning` |
| `NOTIFY_RESOLVED` | notifyResolved (`!= '0'`) | true |
| `NOTIFY_NTFY_SERVER` / `NOTIFY_NTFY_TOPIC` | ntfy | `https://ntfy.sh` / `''` |
| `NOTIFY_PUSHOVER_TOKEN` / `NOTIFY_PUSHOVER_USER` | pushover | `''` |
| `NOTIFY_WEBHOOK_URL` | webhook | `''` |

**Severity → channel priority maps:**

- ntfy `Priority` header: critical `5`, warning `4`, info `3`, resolved `2`; `Tags`: `rotating_light`/`warning`/`information_source`/`white_check_mark`.
- Pushover `priority`: critical `1`, warning `0`, info `-1`, resolved `-1`.

**Dedupe.** `NotifyMessage.dedupId` (= `notifyDedupId(alert)` = the alert id) drives per-subject card identity for the HA channel. `haNotificationId(dedupId, severity)` slugs the dedupId to `[a-z0-9_]` (≤96 chars, prefixed `ecoflow_panel_`); without a dedupId it falls back to the legacy per-severity id. `haNotifyCall(msg)`: a "Resolved:" with a dedupId issues `persistent_notification.dismiss` (drawer shows ACTIVE conditions only); a fire issues `create`. The title carries the ISA bracket and a device locator (`notifyLocator`), e.g. `EcoFlow · [Medium] Pack nearly empty — Core 3 pack 1`. The morning digest, the manual test push, and the `digest`/`test` cards each get distinct dedupIds so they never overwrite each other.

**Dispatch outcomes** (`dispatch()` in the monitor): `'sent'` (delivered), `'suppressed'` (policy gate — no channel / auto-tune silence / disabled priority), `'failed'` (send errored → retry next tick). Auto-tune warning→info demotion changes the `effectiveSeverity` (and the `[Low]` bracket) but keeps the underlying `NotifyMessage.severity` for the channel priority maps.

---

### 6. Outcome-capture feedback loop & feature snapshots

#### Feature snapshots — `featureSnapshot.ts`

On every RISE the monitor calls `captureSnapshot()` (in-memory LRU of `MAX_IN_MEMORY` = 500, persisted JSONL at `FEATURE_SNAPSHOTS_PATH`). Captures the feature vector AS IT WAS at fire time, since the operator may not ack for hours. `extractFeatures(alert, snap)` returns category-specific generic features (Thermal: pack temps + MPPT; Battery: SoC/power/voltage + pack SoH/cycles/vdiff; SHP2: pool SoC/reserve/panel load; Solar: PV totals/volts/amps; Grid/Connectivity: online + snapshot age). `captureLrFeatures(alert, snap, recorder)` additionally captures the REAL normalized ML feature vector (same `ml.ts` `extractFeatures` path `computePackRiskV2` uses) — only for pack-level alerts (`packNum != null`); null otherwise. A `SAME_RISE_GUARD_MS` (60 s, `Math.abs` for clock jumps) absorbs same-rise double-invocation; the file compacts at boot past `COMPACT_BYTES` (512 KB).

#### Outcome capture — `alertOutcomes.ts` + `POST /api/alerts/outcome`

The operator's response is the ground-truth label. `AlertOutcome ∈ {ack, dismiss, failed, resolved}`:

- `ack` → true positive; `dismiss` → false positive; `failed` → strong TP (preceded actual failure); `resolved` → ambiguous (excluded from precision).

`POST /api/alerts/outcome` (`{alertId, outcome, notes?}`) looks up the live alert (for category/severity) and the captured snapshot, appends an `AlertOutcomeEntry` (sanitized: verdict allow-listed, numbers coerced finite, strings control-stripped/length-bounded; IP+UA recorded for audit) to `ALERT_OUTCOMES_PATH` (append-only JSONL, kept forever), fires an online-LR weight update (`updateFromOutcome` — only when labelable and features exist; writes a shadow model, never overwrites the baseline), then drops the in-memory snapshot. Returns `{ ok, onlineLrUpdated }`.

`GET /api/alerts/outcomes?limit=` → `{ entries }` (tail, newest-first). `GET /api/alerts/outcomes/stats` → `{ families }`: `computeFamilyStats()` groups by `familyOf`, precision = `(ack+failed)/(ack+failed+dismiss)`, plus median time-to-action — **null** for `PERSISTENT_FAMILIES` (`offline`, `grid-offgrid`) where `ts−alertFiredAt` is condition-age, not response latency.

#### Machine telemetry — `alertTelemetry.ts`

Separate from outcomes (machine-generated, valuable ~weeks). `appendTelemetryEvent()` writes `{familyKey, alertId, event: 'rise'|'shortClear'|'longActive', ts, durationMs?}` JSONL to `ALERT_TELEMETRY_PATH`. On boot `replayPersistedTelemetry()` re-hydrates rollups from the last `REPLAY_WINDOW_MS` (30 d) / `REPLAY_MAX_BYTES` (4 MB) so auto-silencing survives restarts; the file rotates past `ROTATE_AT_BYTES` (8 MB). `parseTelemetryLine()` strips a leading NUL run (F31 — recovers records torn by the daily power-cut mid-append). A `FamilyMeta` sidecar (`ALERT_FAMILY_META_PATH`) persists real title/severity/category so a replayed family boots with true metadata instead of the `familyKey`/`info`/`Battery` placeholder. Served at **`/api/alert-telemetry`** (`{ telemetry }`, cached 30 s).

---

### 7. Repair issues — `repairIssues.ts`

**WHAT.** A curated ACTIONABLE subset of alerts — only conditions the operator can physically fix — surfaced as REST + an MQTT-discoverable `binary_sensor` per repair. `computeRepairIssues(ctx)` builds them with a persistent first-seen map (`REPAIR_FIRST_SEEN_PATH`) so "active for N hours" survives restarts.

Issues emitted:

- `cloud-offline-<SN>` (Connectivity) — offline device (skips `SPARE_DPU_SNS`); severity mirrors the alert engine via `isCoreOrShp2()` (Core/SHP2 = warning, peripheral = info). 5-step reconnect/power-cycle guide.
- `wash-panels` (Cleaning) — per-DPU soiling ≥ `SOILING_CARD_DROP_PCT` (12%, aligned to the soiling alert) with `cleanDays ≥ 6`; warning if worst ≥ 22%.
- `peer-outlier-<SN>-<pk>` (Battery, warning) — a `degradation.peerOutlier` pack fading fastest.
- `mppt-drift-<SN>-<string>` (Hardware, info) — MPPT efficiency drift `< -3` pp.
- `forecast-bias` (Configuration, info) — `|biasFactor − 1| > 0.25`.
- `storm-*` — active NWS storm alerts converted to a storm-prep checklist.

Stale ids are pruned each cycle. Served at **`/api/repair-issues`** (cached), assembled from the `forecastSkill`, `degradation`, `soilingDecomposition`, `equipmentHealth` analytics reports plus live devices + `snapshot.alerts`.

---

### 8. SHP2-membership zombie gate — `shp2Membership.ts`

**WHAT.** The safety machinery that decides which DPUs count as home fleet and which are expected-offline bench spares, so a spare's offline state is muted while a real home Core's is NEVER muted.

- `shp2ConnectedDpuSns(devices)` — set of DPU SNs the SHP2 reports as connected sources (`s.isConnected && s.sn`). Empty when no SHP2 observed → `isShp2Connected` returns true for every SN (DPU-only fallback; don't zero the dashboard).
- **`SPARE_DPU_SNS`** — the explicit allowlist SAFETY FLOOR: `Y711ZABA9H3T0489` (Core 4), `Y711ZAB59G9P0090` (Core 5). A home Core (1/2/3) is NEVER in this set, so even a faulted/unplugged home Core — which drops out of the SHP2's connected sources — still annunciates its genuine offline alarm. This is the "zombie gate": membership is by explicit SN, not by dynamic `isConnected` (which would mute a faulted core).
- `isExpectedOfflineSpare(sn, connected)` — `SPARE_DPU_SNS.has(sn) && !connected.has(sn)`. The positive connected-source check RE-ARMS a spare the instant it is wired into an SHP2. Overloaded to accept a pre-computed Set (hot loop) or the raw devices Record.
- The monitor applies a central spare gate each tick: any alert whose id contains a muted spare's SN gets `annunciate: false` stamped (idempotent with the per-emitter gate in `alerts.ts`).
- Supporting helpers: `isSourceDpuStale` (observability-only `dpuStale` flag), `homeCoreCoverage` (`{connected, reporting, complete}` — can we see the whole pool?), `homeFleetMeanSoc` (mean SoC of reporting home Cores — the reserve-alarm-blind fallback ladder), `aggregateFleetFlow` (SHP2-membership-filtered fleet power totals).

---

### 9. Root-cause & counterfactual (`analytics.ts`)

**Root-cause graph.** A static, hand-curated causal DAG (`CAUSE_GRAPH`) over the EcoFlow LFP architecture (cell imbalance / high temp / high R → fade rate → capacity loss → EOL; MPPT temp → efficiency drop → PV underperformance; cloud → PV shortfall → low forecast; grid disconnect → battery draw → reserve depletion). `rootCausesFor(alertId)` walks one hop backwards (matching by 2-token id family or `to`-prefix) and returns upstream `{id, description}` causes.

**Counterfactual driver analysis** lives inside `forecastDayAlerts` (§3.4): it decomposes a PV shortfall into cloud-cover vs everything-else and writes the `why` narrative into `forecast-soc-dip` / `forecast-low-solar`, so the operator learns *why*, not just *that*, the forecast is low.

Served at **`/api/root-cause?alertId=<id>`** → `{ causes }`.

---

### 10. Confidence — `computeConfidenceSnapshot()` (`analytics.ts`)

**WHAT.** A model-health headline used by the UI to say how much to trust the learned outputs. `GET /api/confidence` assembles it from the `degradation`, `ambientThermal`, and a **30-day** `forecastSkill` report (the window its r²≈0.94 premise was validated on), cached 60 s.

`ConfidenceSnapshot`: `degradationMedianR2`, `forecastDayR2` (Pearson r² of predicted vs actual daily PV kWh across ≥5 scored weather-covered days — replaced the degenerate within-slot median r²), `thermalMedianR2`, `forecastSkillBiasFactor`, `forecastSkillMaePct`.

---

### 11. Alert-annunciation settings — `alertSettings.ts`

A small user-mutable layer on top of the env baseline, persisted atomically to `ALERT_SETTINGS_PATH` (default sibling of DB). `AlertSettings`: `priorityEnabled: Record<AlarmPriority, boolean>` (default all true) and `chimeRepeat` (1–4, `DEFAULT_CHIME_REPEAT` = 2).

**SEMANTICS.** Disabling a priority silences its *annunciation* (push + audible + chime) — it does NOT hide the alarm (the alert stays in the lists, rendered muted). In the monitor's `dispatch()`, `isPriorityEnabled(priorityOf(alert))` false → the push is `'suppressed'`. `getChimeRepeat()` drives the audible path.

Served at **`GET /api/alert-settings`** (`alertSettingsResponse()`, cached in-process, read-rate-limited 120/60 s) and **`PUT /api/alert-settings`** (`{priorityEnabled?, chimeRepeat?}`, write-auth-gated, audit-logged, notifies listeners e.g. to re-publish HA switch states).

---

### 12. API endpoint summary

| Endpoint | Method | Payload / shape |
|----------|--------|-----------------|
| `/api/snapshot` | GET | `snapshot.alerts` (the `computeAlerts` + learned output) among the full frame; also pushed over WS |
| `/api/incidents` | GET | `{ incidents: Incident[] }` (cached 15 s) |
| `/api/alerts/history` | GET | `{ cleared: ClearedAlert[] }` (cached 30 s) |
| `/api/alert-telemetry` | GET | `{ telemetry: AlertActionStats[] }` (cached 30 s) |
| `/api/alerts/outcome` | POST | `{alertId, outcome, notes?}` → `{ok, onlineLrUpdated}` (auth-open) |
| `/api/alerts/outcomes` | GET | `{ entries }` (tail, `?limit=`) |
| `/api/alerts/outcomes/stats` | GET | `{ families: AlertFamilyStats[] }` |
| `/api/root-cause` | GET | `?alertId=` → `{ causes: [{id, description}] }` |
| `/api/repair-issues` | GET | `RepairIssuesReport { generatedAt, issues: RepairIssue[] }` |
| `/api/confidence` | GET | `ConfidenceSnapshot` (cached 60 s) |
| `/api/alert-settings` | GET/PUT | `AlertSettings` (PUT write-gated) |

---

### 13. Honest-null behaviour, edge cases & guards

- **Debounce onsets are optional.** When `connectivity` (or a specific onset map) is absent — older callers/tests — the `dpu-err` / `shp2-src-err` debounce is skipped and the CRITICAL fires immediately (pre-v1.11 behaviour). No path silently loses a real fault.
- **Reserve default.** Every reserve consumer defaults `backupReserveSoc ?? 15`, kept consistent between the near/below pair and the SoC-band dedup.
- **`mpptProducing` fallback.** `amps == null` (device doesn't report current) falls back to the watt test alone rather than suppressing an MPPT error.
- **Bench-spare mute is bidirectional & self-re-arming.** A spare wired into an SHP2 immediately loses `annunciate:false` (it becomes a connected source); a home Core can never be muted (never in `SPARE_DPU_SNS`).
- **Auto-silence never touches criticals** and never touches `ENERGY_STATE_FAMILIES`; flags are re-derived (not latched) each evaluation, so a family that stops flapping sheds its latch as the 30-day replay window decays.
- **Delivery integrity.** At-least-once dispatch; a failed send retries; a "Resolved:" gates on a REAL delivered fire (`pushSent`), not boot-seeding; the notify-state record is deleted before a resolve attempt so a failed resolve can't eat a future re-fire.
- **Clock skew.** The Pi is RTC-less and jumps at NTP resync; `recordClear` clamps durations `max(0, …)`, `SAME_RISE_GUARD_MS` uses `Math.abs`, and torn-append NUL runs are stripped from telemetry lines.
- **Outage events don't "recover"** — they age off the list silently (no resolve push) and re-notify only when their duration tier changes.
- **Warm-up grace.** Learned alerts absent in the first `LEARNED_RESOLVE_GRACE_MS` (10 min) after boot are treated as warm-up, not recovery, so a restart can't emit a premature "Resolved:".
- **Confidence honesty.** `forecastDayR2` returns null with <5 scored days; the within-slot solar r² is diagnostic-only (degenerate in a low-variance climate) and nothing gates on it.


---

## 9. The Online Learning Loop (shadow models, online regression, model health)

### What this is, and why it exists

The ecoflow-panel pack-risk model does not sit frozen. Every time the operator
tells the panel whether an alert was *real* or *noise*, that verdict is turned
into a labeled training example and fed back into a **shadow copy** of the
pack-risk logistic-regression (LR) model via a single stochastic-gradient-descent
(SGD) step. Over days and weeks the shadow model drifts away from the shipped
"champion" baseline in the direction that would have predicted the operator's
verdicts better. A separate model-health report (`/api/models/health`) tracks how
far the shadow has moved, whether that movement is real or a no-op, and whether
the currently-served model has degraded enough to be auto-benched.

This is the codebase's one genuine closed-loop learning system. The module header
of `server/src/models/onlineLR.ts` is blunt about the intent: it is the thing that
turns "ML cargo cult" into "ML that's actually learning." The rest of the fleet's
models (forecast, degradation, novelty, Bayesian/Kalman baselines) update
implicitly through their own statistical mechanisms or are pure heuristics —
pack-risk LR is the only differentiable, labeled-data-trainable model here.

The loop has four stages, each in its own file:

| Stage | File | Role |
|-------|------|------|
| 1. Capture inputs | `server/src/featureSnapshot.ts` | Freeze the feature vector **at alert-fire time** |
| 2. Capture label | `server/src/alertOutcomes.ts` | Record the operator's ack/dismiss/failed/resolved verdict |
| 3. Learn | `server/src/models/onlineLR.ts` | One SGD step on the shadow model per labelable outcome |
| 4. Report / gate | `server/src/models/modelHealth.ts` + `server/src/ml.ts` | Expose drift, precision, sample counts; decide whether to bench the model |

#### Honest framing: live vs scaffolding

- **Live:** feature-snapshot capture on every alert rise, outcome persistence,
  the online SGD step (with bias clamp and degenerate-feature guard), the
  prequential-loss EMA, the shadow-vs-baseline drift report, and the
  auto-downgrade **gate** that pins the model to the heuristic when it looks bad.
- **Scaffolding / not-yet-wired:** there is **no automatic promotion** of a
  shadow model to champion. The shadow file is *preferred* by inference the
  moment it exists, but "promotion" in the sense of blessing the shadow as the
  new frozen baseline happens only when a human re-runs the batch trainer
  (`scripts/train-pack-risk.ts`), which overwrites the baseline file via
  `saveModel`. Nothing in the request path calls `saveModel`. Likewise, "bulk
  retraining from accumulated outcomes" is referenced in comments but the online
  step is the only thing that consumes outcomes at runtime.

---

### The six-feature model being learned

Both the champion and the shadow are the same shape: a 6-weight + bias logistic
regression over `FEATURE_NAMES` (`server/src/ml.ts:56`):

| Feature | Meaning | Normalization (`normalizeFeature`, ml.ts:84) |
|---------|---------|-----------|
| `peerFadeRatio` | wear rate vs fleet (1.0 = average) | `clamp01((raw − 1) / 1.0)` → 2.0 = max risk |
| `rTrend` | internal-resistance rise, mΩ/month | `clamp01(raw / 3)` → 3 mΩ/mo = max |
| `coulombicEffPct` | discharge÷charge mAh | `clamp01((99 − raw) / 2)` → 97% = max |
| `hardLifeScore` | thermal-stress events/yr | `clamp01(raw / 300)` → 300 events/yr = max |
| `ccDriftMv` | charge-curve drift at SoC checkpoints | `clamp01(abs(raw) / 50)` → 50 mV = max |
| `fadePctPerYear` | SoH erosion rate | `clamp01((raw − 1) / 5)` → 6 %/yr = max |

Every feature is normalized to `[0,1]` where 1 = high risk; a null/non-finite raw
value maps to the neutral `0`. The in-code champion (`DEFAULT_MODEL`, ml.ts:250)
is heuristic-distilled:

```
weights = { peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
            hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2 }
bias    = -2.5
```

Inference is `p = sigmoid(bias + Σ wᵢ·xᵢ)`.

#### Two files on disk

```
<dbPath>/../models/pack-risk-lr-v1.json          ← MODEL_PATH  (champion / baseline)
<dbPath>/../models/pack-risk-lr-v1-online.json   ← SHADOW_PATH (online-updated)
```

The baseline is **frozen** — only the batch trainer overwrites it. The shadow is
rewritten after **every** SGD step. Inference (`loadModel`, ml.ts:307) prefers the
shadow when it exists, then the baseline, then the in-code `DEFAULT_MODEL`.

---

### Stage 1 — Feature snapshot at fire time (`featureSnapshot.ts`)

#### Why snapshot at all

When an alert fires, the operator may not act on it for minutes or hours. By the
time they ack/dismiss it, live telemetry has moved on. To train on *what the model
actually saw*, the feature vector is frozen **at fire time**, keyed by `alertId`.

#### What is captured

`captureSnapshot` (featureSnapshot.ts:154) writes a `SnapshotRecord` carrying two
distinct payloads:

1. **`features`** — a category-specific generic vector (diagnostics + pre-v0.9.59
   fallback). Extractors per category (`extractFeatures`, ts:209):
   - **Thermal** → `pack_temp_c`, `min/max_cell_temp_c`, `board_temp_c`, `pack_soc`, `mppt_hv/lv_temp_c`
   - **Battery** → `device_soc`, `p_in_w`, `p_out_w`, `bat_v_mv`, `bat_a_ma`, `pack_soc`, `pack_soh`, `pack_cycles`, `pack_vol_diff_mv`
   - **SHP2** → `pool_soc`, `reserve_soc`, `panel_load_w`
   - **Solar** → `pv_total_w`, `pv_hv/lv_w`, `pv_hv/lv_v`, `pv_hv/lv_a`
   - **Grid/Connectivity** → `device_online`, `snapshot_age_ms`
2. **`lrFeatures`** — the **real normalized 6-dim LR vector** (v0.9.59), produced
   by `captureLrFeatures` (ts:317) which calls the *same* `extractFeatures` /
   `normalize` path (`ml.ts`) that `computePackRiskV2` uses for inference. This is
   the training-inference-parity fix: the model trains on exactly the inputs it
   predicted from, not a proxy reconstructed later. It is populated **only for
   pack-level alerts** (`alert.packNum != null` and the device resolves to a DPU);
   for SHP2/EVSE/system alerts it is `null`.

`captureLrFeatures` pulls the four analytics reports (`degradation`,
`thermalEvents`, `internalResistance`, `chargeCurve`) from the analytics worker
(each internally TTL-cached ~60 s), runs `extractMlFeatures`, and returns
`fv.normalized`. Any error → `null` (SGD step is simply skipped; never blocks
alert dispatch).

#### Storage, dedup, and the once-per-rise fix

- In-memory **LRU** `Map` keyed by `alertId`, `MAX_IN_MEMORY = 500`, delete-before-set
  so Map insertion order = recency.
- Persisted append-only to `/data/feature-snapshots.jsonl`; on boot the most
  recent entries are re-hydrated (delete-before-set again so recency = *last*
  appearance, not first).
- **F20 fix (v1.19.0):** the caller (`alertMonitor`, line 1474–1483) captures
  once per **rise** (transition from not-firing to firing). The old dedup
  (`if (cache.has(id)) return`) against a boot-hydrated cache meant a recurring
  alertId was *never* re-snapshotted — the "fire-time" vector could be weeks
  stale (outcome records once embedded features up to 618 h older than the fire
  they labeled). Now each rise captures fresh features. A `SAME_RISE_GUARD_MS =
  60_000` window absorbs same-rise double-invocation (boot replay racing a live
  tick), using `Math.abs(record.ts − prev.ts)` so an NTP backward clock step
  can't be misread as "same rise."
- **Compaction:** at boot, if the jsonl exceeds `COMPACT_BYTES = 512 KiB`, it is
  atomically rewritten (temp+rename) from the retained cache — this host loses
  power daily, so an in-place truncate could destroy the only copy.

---

### Stage 2 — Outcome capture (`alertOutcomes.ts`)

#### The label space

The operator's response is the ground-truth label (`AlertOutcome`):

| Verdict | Meaning | Learning use |
|---------|---------|--------------|
| `ack` | "real, I'm handling it" | true positive → label **1.0** |
| `dismiss` | "noise, stop nagging" | false positive → label **0.0** |
| `failed` | "this preceded an actual failure" | strong TP → label **1.0**, sample weight **2×** |
| `resolved` | "system cleared it itself" | ambiguous → **skipped** (no label) |

#### The record and its endpoint

`POST /api/alerts/outcome` (index.ts ~1440) validates the verdict against
`['ack','dismiss','failed','resolved']`, then assembles an `AlertOutcomeEntry`
(alertOutcomes.ts:29) by joining the request to the frozen snapshot:

```
ts, alertId, category, severity, outcome, notes,
features:     snap?.features,      // generic vector
lrFeatures:   snap?.lrFeatures,    // real LR vector (pack alerts only)
alertFiredAt: snap?.ts,            // for time-to-action
source: { ip, ua }
```

`appendAlertOutcome` (ts:127) sanitizes before writing one JSON line to
`/data/alert-outcomes.jsonl` (append-only, kept forever — the labeled dataset
grows in value). Sanitization (`sanitizeOutcomeEntry`, ts:96) re-serializes an
explicit typed shape: verdict allow-listed to a fresh literal, numbers coerced
finite, feature maps bounded to 64 keys with cleaned keys, strings length-bounded
— defending the on-disk file against the operator-supplied `notes` and any
request-derived field (CodeQL `js/http-to-file-access`). The `lrFeatures` tri-state
is preserved: `undefined` = pre-v0.9.59 row (key omitted), `null` = "no LR vector"
(non-pack alert), object = real vector.

#### Family rollups and precision

`computeFamilyStats` (ts:253) groups outcomes by **family** — `familyOf` (ts:237)
strips the device serial by splitting `alertId` on `-` and stopping at the first
token containing an uppercase letter (families are all-lowercase like `pack-hot`,
`cell-imbalance`; serials are uppercase), then drops a trailing all-digits pack
number so `pack-hot-3` and `pack-hot-7` roll up under `pack-hot`. Per family:

```
precision = (ack + failed) / (ack + failed + dismiss)      // null if no decided outcomes
medianTimeToActionMs = median(ts − alertFiredAt)           // null for persistent families
```

`PERSISTENT_FAMILIES = { 'offline', 'grid-offgrid' }` return `null` for
time-to-action: their condition is continuously true, so `ts − alertFiredAt` is
condition-age not response latency (the 7-day audit saw 9.44 d for `offline`,
13.18 d for `grid-offgrid` — meaningless as response time). Families are sorted
noisiest-first (lowest precision, then highest volume).

---

### Stage 3 — The online SGD step (`onlineLR.ts` → `updateFromOutcome`)

Fired synchronously from the outcome endpoint (index.ts:1475) on every submission.

#### Constants

```
LEARNING_RATE       = 0.05    // conservative — a few outcomes/day
L2                  = 0.001   // ridge on weights (not bias)
FAILED_LABEL_WEIGHT = 2.0     // 'failed' pulls 2× harder
BIAS_CLAMP          = 1.0     // bias bounded to ±1.0 of baseline bias
DEFAULT_BASELINE_BIAS = -2.5  // used only if no on-disk baseline exists
```

#### Step 0 — build the feature vector (`snapshotToLrFeatures`, ts:96)

Prefer the captured `outcome.lrFeatures` verbatim (real inference inputs). Each of
the six names is copied if finite, else set to `0`; if **at least one** value is
present, that vector is used. Only pre-v0.9.59 historical rows (no captured
vector) fall to the **proxy** reconstruction from generic `features` — explicitly
documented as known-bad (`rTrend` proxied off pack temperature would train "every
Phoenix-summer pack = high risk"; `coulombicEffPct` had no source and defaulted to
0). Returns `null` when no usable vector can be built.

#### Step 1 — guards (honest-null / no-op prevention)

1. **`resolved` → skip** (ambiguous, `updated:false`, `reason:'resolved (ambiguous)'`).
2. **No features** → skip (`reason:'no features captured'`).
3. **Degenerate-feature guard (v0.13.0, ts:249):** iterate the six features; any
   NaN/Inf → skip (`reason:'degenerate-features'`); **all-zero → skip** (same
   reason). This is the P0-2 fix: a non-pack outcome collapses to an all-zero
   proxy vector, and with `x = 0` the gradient's data term vanishes so *only the
   bias moves* — 13 system-level labels once walked the pack-risk baseline from
   2.5% to 12.9% with every `weightDelta` exactly 0. Now such outcomes are still
   *persisted* for audit but do **not** train.

#### Step 2 — the math

Binary cross-entropy logistic SGD, one sample:

```
label       = (outcome === 'dismiss') ? 0 : 1          // ack + failed → 1
sampleWeight= (outcome === 'failed')  ? 2.0 : 1.0

logit = bias + Σ wᵢ·xᵢ
p     = sigmoid(logit)
error = (p − label) · sampleWeight

# per-weight (ridge-regularized):
grad_i = error·xᵢ + L2·wᵢ
wᵢ    ← wᵢ − LEARNING_RATE · grad_i

# bias (NO regularization):
rawBias = bias − LEARNING_RATE · error
newBias = clamp(rawBias, baselineBias − 1.0, baselineBias + 1.0)
```

`sigmoid` is the numerically-stable two-branch form (ts:151). `baselineBias` comes
from `loadBaselineBias` (ts:190) which reads the **on-disk baseline** (`MODEL_PATH`),
not the shadow — the clamp anchor must be the frozen model, not accumulated drift.

**Why the bias clamp (v0.13.2):** even a legitimate one-sided stream (every alert
ack'd, never dismissed) drives `bias −= η·(p−1)` monotonically upward forever.
Bounding to ±1.0 of baseline keeps the intercept from walking unboundedly while
still allowing real adaptation (a logit shift of 1.0 already moves a 50% prediction
to ~73%). Weights and the inference path are untouched — only the bias is bounded.

#### Step 3 — prequential loss tracking (v0.15.12)

`finalLoss` was once a hardcoded `0` inherited from the shadow-init template,
publishing as a misleadingly perfect training loss. It now tracks a real
prequential (test-then-train) log-loss: each sample's cross-entropy is computed
against the **pre-update** model and smoothed with an EMA (`LOSS_EMA = 0.9`, ~10-sample
horizon), seeded from the first online step:

```
pClamped   = clamp(p, 1e-7, 1 − 1e-7)
sampleLoss = −(label·log(pClamped) + (1−label)·log(1−pClamped))
newFinalLoss = finalLoss>0 ? 0.9·finalLoss + 0.1·sampleLoss : sampleLoss   // rounded to 4 dp
```

#### Step 4 — persist the shadow

Write the updated `LrModel` to `SHADOW_PATH` (`saveShadow`, ts:207), stamping
`trainedAt = now`, `samples += 1`, `source = 'labeled'`, and a provenance `notes`
string. The `alertId` embedded in `notes` is request-derived, so it is
allow-listed (`[^A-Za-z0-9._:-] → _`) and length-bounded to 120 chars before it
lands on disk. The baseline file is **never** touched.

Return shape:
```ts
{ updated: boolean, prevLogit: number, newLogit: number, label: number | null, reason?: string }
```
The endpoint surfaces only `onlineLrUpdated: result?.updated ?? false` to the client.

#### `loadCurrent` / `loadShadowModel`

`loadCurrent` (ts:157) reads the shadow file first, then the baseline, then falls
to an in-code seed (`version:'lr-online-shadow-init'`, same weights as
`DEFAULT_MODEL`, bias −2.5). `loadShadowModel` (ts:337) is the read-only export the
health report uses to show "online has diverged from baseline by N%."

---

### Stage 4 — Model health & the gate

Two consumers read the loop's state: the **health report** (`/api/models/health`,
diagnostic) and the **auto-downgrade gate** (`computeGateDecision`, authoritative —
it decides whether the served model is trusted). Since v1.18.0 (F16) the report
single-sources the gate verdict so the two can never disagree.

#### The gate — `computeGateDecision(model)` (ml.ts:726)

Three independent degrade conditions; any one benches the model.

**Knobs** (env, parsed by `gateEnvNum` which rejects empty/NaN/negative so
`Number('') === 0` can't silently zero a threshold):

| Env var | Default | Meaning |
|---------|---------|---------|
| `PACK_RISK_DRIFT_THRESHOLD` | `2.0` | max allowed shadow-vs-baseline L2 |
| `PACK_RISK_MIN_PRECISION` | `0.4` | min alert-family precision |
| `PACK_RISK_MIN_TRAINING_SAMPLES` | `100` | min samples before a labeled shadow may serve |
| `PACK_RISK_MIN_DECIDED_OUTCOMES` | `3` | min decided outcomes (with ≥1 dismissal) before precision is evidence |

**Condition A — samples (F16, dominant).** An immature online shadow must not
reach the operator composite:
```
samplesBad = provenance !== 'baseline'
          && source     !== 'heuristic-distilled'
          && !(Number.isFinite(model.samples) && model.samples >= 100)
```
Exemptions are deliberate: a `heuristic-distilled` model (in-code default /
distilled fit) mirrors the heuristic by construction, and a `baseline`-provenance
labels.csv batch fit is converged and legitimately has ~one sample per fleet pack
(~20–25). Everything else — the online-SGD shadow, or any file with missing/
unrecognized `source` (fail-safe: `undefined === 'labeled'` is false, and
`undefined < 100` is false, so a corrupt file can't sneak through) — must show a
finite `samples ≥ 100`. This gate catches the live incident where a 13-sample
one-class shadow (99.99% bias, "raise everyone's risk") inflated healthy-fleet
composites 4–7×.

**Condition B — drift.** L2 distance shadow-vs-baseline, read via
`loadBaselineModelOnly()` (the true frozen baseline, bypassing loadModel's shadow
preference):
```
driftL2 = sqrt( Σ (shadowᵢ − baselineᵢ)² + (shadowBias − baselineBias)² )
driftBad = driftL2 != null && driftL2 > 2.0
```
If no on-disk baseline exists, `driftL2 = null` (**unknown, not 0**) — the pre-F16
`driftL2 = 0` displayed as a measured "no drift" while the shadow's real
divergence was structurally invisible. `null` does not degrade by itself; the
samples gate covers the cold-start case.

**Condition C — precision.** Evidence only when the stream can express a false
positive:
```
overallPrecision = (totalDismiss > 0 && totalDecided >= 3)
                   ? totalReal / totalDecided : null
precBad = overallPrecision != null && overallPrecision < 0.4
```
A one-class all-`ack` stream pins precision at 1.0 forever, which is not a
measurement — the live system's 33 batch-acks (median time-to-action 21.9 **days**)
rendered a fake permanent 1.0. Requiring ≥1 dismissal fixes that; since every
sub-0.4 stream necessarily contains dismissals, this guard can delay a genuine
degrade by at most two outcomes, never block it.

**Verdict:**
```
degraded = samplesBad || driftBad || precBad
reason   = samplesBad ? 'samples'                       // dominates
         : driftBad && precBad ? 'drift+precision'
         : driftBad ? 'drift' : precBad ? 'precision' : undefined
```

#### How the gate is applied (`computePackRiskV2`, ml.ts:852)

The pack-risk composite is `mean(heuristic, trained, novelty)`. When the gate
fires:
- The **trained** track is pinned to the heuristic score (`trainedScore =
  gate.degraded ? heur.score0to100 : pred.score0to100`) so a crashed shadow can't
  crater the composite. The raw `pred.probability`/`contributions` stay exposed
  for debug.
- If `reason === 'samples'` (immature ML stack) the composite drops the novelty
  track too — it becomes **heuristic-only** (`composite = heur.score0to100`),
  because an unsupervised novelty score built from a 16-sample charge-curve
  checkpoint was itself part of the 4–7× inflation. Mature-model degrades
  (drift/precision) keep the pre-existing behavior: trained pinned, novelty still
  averaged.

#### The report — `computeModelHealth()` → `GET /api/models/health`

Endpoint: `app.get('/api/models/health', cached(..., computeModelHealth(), 60))`
(index.ts:1488) — 60 s cache.

`computeModelHealth` (modelHealth.ts:69) resolves a **true** baseline via
`loadBaselineModelOnly()` (falling back to in-code `DEFAULT_MODEL` when absent —
critically *not* the shadow, or every delta would read 0), diffs it against
`loadShadowModel()`, and single-sources the gate verdict from
`computeGateDecision(loadModel())`.

`ModelHealthReport` (modelHealth.ts:21) shape:

| Field | Source / meaning |
|-------|------------------|
| `generatedAt` | `Date.now()` |
| `packRiskLr.baseline` | `{version, trainedAt, samples, source}` of the frozen baseline |
| `packRiskLr.shadow` | same fields for the online shadow |
| `packRiskLr.weightDeltas` | per-feature `shadow − baseline`, plus `_bias` |
| `packRiskLr.totalDriftL2` | `sqrt(Σ delta²)` incl. bias |
| `packRiskLr.driftBasis` | `'baseline'` if a trained file exists, else `'default-seed'` (movement is vs the in-code seed, **not** true drift) |
| `packRiskLr.baselineOnDisk` | whether `MODEL_PATH` exists |
| `packRiskLr.onlineSamples` | `max(0, shadow.samples − baseline.samples)` |
| `packRiskLr.effectiveOnlineSamples` | same, **but 0 unless some weight/bias actually moved** (>`DELTA_EPSILON = 1e-9`) — makes a P0-2 no-op ("13 updates, 0 drift") visible instead of silently claiming progress |
| `alertFamilies` | `computeFamilyStats()` (per-family precision, TTA, counts) |
| `labeledAlertCount` | total outcomes with verdicts |
| `overallPrecision` | the gate's evidence-guarded precision (`null` unless ≥1 dismissal and ≥3 decided) |
| `gate` | the full `computeGateDecision` object — the authoritative served-model verdict |

`driftBasis` matters: with no on-disk baseline, `totalDriftL2` measures movement
from the in-code seed, while the gate's `driftL2` reads `null`. The two numbers
answer different questions and the report labels which is which so the +0.586
all-bias walk can no longer render as authoritative drift.

---

### Promotion: what actually happens (and doesn't)

There is **no runtime promotion path.** Concretely:

- `updateFromOutcome` writes **only** `SHADOW_PATH`. It never calls `saveModel`.
- `saveModel` (ml.ts:364, overwrites `MODEL_PATH`) is called **only** by the
  offline batch trainer `scripts/train-pack-risk.ts` — a human-run tool.
- Inference (`loadModel`) *prefers* the shadow the instant it exists, so in
  practice the online shadow **is** the served model without any explicit
  blessing — but that model is exactly what the samples/drift/precision gate
  polices, and until it clears the `PACK_RISK_MIN_TRAINING_SAMPLES = 100` floor
  its score is pinned to the heuristic and contributes nothing to the composite.
- To "promote" the shadow to a new frozen champion, the operator re-runs training
  (which rebuilds the baseline from labels/heuristic distillation). There is no
  automated "shadow beat champion on held-out data, swap it in" step — that
  comparison would be the natural next stage, but it is not implemented.

So the honest summary of the loop's autonomy: **it learns continuously and serves
its learning immediately, but it is fenced by a conservative gate rather than
promoted by a champion-challenger evaluation.** The gate — not a promotion
decision — is what protects the life-safety alarm from a mis-trained shadow.

---

### Edge cases & guard summary

- **`resolved` outcomes** never train (ambiguous) but are still persisted.
- **Non-pack alerts** (SHP2/EVSE/system) capture `lrFeatures = null`; their
  outcomes persist for audit but the all-zero proxy is refused by the
  degenerate-feature guard, so they cannot walk the pack-risk bias.
- **NaN/Inf features** → step refused (`reason:'degenerate-features'`).
- **One-sided label streams** — bias clamp (±1.0 of baseline) bounds intercept
  walk; precision gate ignored until a dismissal exists.
- **No on-disk baseline** — drift is `null` (unknown), not a false 0; report
  labels `driftBasis: 'default-seed'`; samples gate covers the immature case.
- **No-op online updates** — `effectiveOnlineSamples` reads 0 when nothing moved,
  surfacing a silent no-op.
- **Immature shadow (<100 samples)** — served but pinned to heuristic; composite
  becomes heuristic-only (`reason:'samples'`).
- **Stale snapshots** — F20 once-per-rise capture + 60 s same-rise guard +
  512 KiB atomic compaction keep fire-time features fresh and the file bounded.
- **finalLoss** — real prequential EMA, no longer a misleading hardcoded 0.
- **File corruption / IO errors** — every read path (`loadCurrent`,
  `loadBaselineBias`, `loadModel`, tail/readAll) swallows parse errors and falls
  back rather than crashing; append failures are logged, not thrown.


---

## 10. Audible Broadcast, Chimes & Text-to-Speech

This cluster documents how the ecoflow-panel add-on turns an in-memory alert
condition into **audible sound in the house** — a synthesized alarm chime
followed by a spoken, TTS-rendered description of the alert, pushed to every
configured speaker. It is the "last mile" of a life-safety alarm: the on-screen
tiles and HA push notifications tell you *what* is wrong; this pipeline makes
sure someone who is not looking at a screen *hears* it.

The design philosophy that recurs throughout every module below is: **collapse
the delivery method, never the measurement, and never let a cosmetic sub-step
silence an alarm.** A missing custom tone falls back to a built-in klaxon; a
failed Spanish pass still plays English; a failed "End of message" terminator
still plays the message; a dead speaker channel raises a *push* alert about
itself rather than trying to chime over the broken channel.

Source files covered:

| File | Role |
|------|------|
| `server/src/broadcast.ts` | The monitor: condition derivation, gates, per-target volume pin, MA + SIP dispatch, retries, health probe |
| `server/src/audioRenderer.ts` | Assembles chime + TTS PCM into one cached WAV; the cache key |
| `server/src/audioAssets.ts` | Synthesizes the built-in klaxons + named tone library at boot |
| `server/src/chimeStore.ts` | Operator WAV uploads: normalize-on-ingest + content-addressed storage |
| `server/src/chimeConfig.ts` | Per-level tone assignment (`resolveChime`) |
| `server/src/ttsService.ts` | Alert → spoken sentence; the TTS text normalizer (`verbalizeForTts`) |
| `server/src/wyomingTts.ts` | Wyoming-protocol Piper TCP client + `pcmToWav` |
| `server/src/broadcastRuntimeConfig.ts` | Live enable/volume override layer on top of env |
| `server/src/haService.ts` | `callHaService` and friends — every HA call, never throws |
| `server/src/broadcastHealth.ts` | Audible-delivery health signal + self-alert builder |

---

### 1. Pipeline overview

At the top level, the flow is:

```
alert condition transition (or a dedicated announce()/test()/preview() call)
        │
        ▼
 gates: enabled? minSeverity? quiet hours? storm gate? restart/boot grace?
        │
        ▼
 resolveChime(level)      →  which WAV prepends this level
        │
        ▼
 renderAnnouncement(...)  →  build (or cache-hit) the combined WAV:
        │                     [lead silence][chime×N][gap][TTS][terminator], ×repeat
        │                     TTS rendered via Wyoming/Piper over TCP
        ▼
 url = audioBase + /audio-render/<sha1>.wav
        │
        ├─► SIP side-channel  (fire-and-forget, BEFORE MA pre-flight)
        │      media_player.play_media(announce=true) → antique-phone switchboard
        │
        ▼
 MA pre-flight: ≥1 target registered & not 'unavailable'? else defer+retry
        │
        ▼
 per-target volume_set (pin standing volume)  →  music_assistant.play_announcement
        │
        ▼
 verify: call ok AND wall-clock ≥ 2 s (a sub-2 s "ok" = HA dropped it)
        │
        ▼
 record lastPlayed*, persist broadcast-last.json
```

Two distinct output channels carry the **same rendered WAV**:

1. **Music Assistant** (`music_assistant.play_announcement`) → the primary
   speakers (the two ecobee thermostats exposed as MA AirPlay players). This is
   the verified, retried, health-tracked path.
2. **SIP / announce-only** (`media_player.play_media` with `announce: true`) →
   the Switchboard cordless phone (an antique-phone PBX endpoint). MA cannot
   drive a SIP phone, so this is a parallel, fire-and-forget side-channel.

---

### 2. Condition derivation & annunciation gates (`broadcast.ts`)

#### 2.1 `conditionFromAlerts(alerts)` → level

The audible **condition level** is a 3-value collapse of the alert list:

```
crit  = count of counted alerts with severity === 'critical'
warn  = count of counted alerts with severity === 'warning'
level = crit > 0 ? 'red' : warn > 0 ? 'yellow' : 'green'
```

Before counting, alerts are filtered out ("not counted") when:

- `a.annunciate === false` (e.g. an expected-offline bench spare — visible but silent);
- `a.id` starts with `backup-soc` (owned by the dedicated `announce()` SoC path);
- `a.id` starts with `shp2-below-reserve` (owned by the grid-aware runway alarm; its severity flips critical↔info with grid backstop);
- `a.id` starts with `forecast-runtime` (owned by the runway-alarm `announce()` path);
- `a.id` starts with `system-outage` (a retrospective event, fires its own one-shot push);
- `a.id` starts with `system-audible` (the audible-unreachable self-alert — must never chime over the channel it reports broken).

These exclusions keep the standing chime/all-clear from double-announcing a
crossing that a dedicated `announce()` path already owns.

Additionally, on every tick, alerts whose **ISA priority is silenced** on the
Alert Settings page are dropped *before* `conditionFromAlerts` runs
(`isPriorityEnabled(priorityOf(a))`), so a silenced priority never raises the
level. The alerts stay visible in the UI — only the audible annunciation is gated.

#### 2.2 The tick loop and its guards (`tick()`, every 10 s)

The monitor polls `store.get().alerts` on a **10 s `setInterval`** and fires on
**condition transitions**, not per-tick. Ordered guard logic:

| Guard | Behavior |
|-------|----------|
| `firstTick` | The very first observation only records `prevLevel`/`prevCrit` and returns — joining an already-RED state at boot is silent. |
| `transitioned` | `level !== prevLevel`. |
| `newCrit` | `level === 'red' && crit > prevCrit` — a *new* critical while already red re-fires. |
| **Restart continuation** (`isRestartContinuation`) | Within `BROADCAST_BOOT_WARMUP_MS` (default **10 min**), a yellow/green transition at or below the persisted pre-restart baseline is adopted silently (analytics warm-up re-presents an already-broadcast advisory as a fresh rise). **RED is never suppressed here.** |
| **Boot phantom-red hold** (`holdBootRed`) | Within the warm-up window, the *first* fresh red is held for **one tick** to confirm it is standing and not a telemetry-populate phantom (`prevLevel` is NOT advanced, so a persisting red re-fires ≤10 s late; a one-tick phantom clears and is never spoken). |
| **In-flight** (`tickInFlight`) | An MA announcement blocks 20–105 s (>> the 10 s tick). If a different level arrives mid-flight, the tick returns WITHOUT advancing `prevLevel`, so the missed transition re-presents next tick (prevents a lost yellow→green). |
| `cfg.enabled` | Disabled → adopt level, no broadcast. |
| **All-clear-vs-critical** | A `green` is adopted silently (no spoken all-clear) if any critical alert with `annunciate !== false` is still active — avoids a spoken "all clear" contradicting a runway-alarm critical on the same speakers. |
| `minSeverity` | `yellow` is skipped when `cfg.minSeverity === 'critical'` (the default). |
| **Quiet hours** | `yellow`/`green` always respect quiet hours. `red` breaks through ONLY when `criticalBreakThrough` is opted in; default OFF ⇒ red is also suppressed overnight (alert stays on-screen; push queues the morning digest). |

Only after all guards pass does `tick()` set `tickInFlight`, build the message
(`messageFor` / `messageEsFor`), and call `runBroadcast`.

#### 2.3 Storm gates (`runBroadcastInner`)

Two suppression gates prevent an alarm storm from wedging Music Assistant (the
Jun 12 event fired 5 broadcasts in 50 min from 3 sources and drove MA into HTTP
500s). Both are **bypassed by a genuine escalation** (a level higher than the
last thing that *actually played*) and by test/preview:

- **`SAME_MESSAGE_GAP_MS = 10 min`** — an identical spoken message within the window is suppressed (tier-boundary flapping repeats the exact text).
- **`SAME_LEVEL_GAP_MS = 2 min`** — any same-or-lower level within the window is suppressed (at most one non-escalating voice alarm per gap).

Gates key off `lastPlayedAt`/`lastPlayedLevel`/`lastPlayedMessage`, which are set
**only on verified playback**, so a failed/unverified dispatch never blocks its
own retry. `stormSuppressedCount` is surfaced in `/api/broadcast/status`.

#### 2.4 Single-flight serialization

Every broadcast (tick, `announce()`, `test()`, `preview()` speakers, retries)
is serialized through one promise chain (`broadcastChain`). A second request
waits for the first playback to finish rather than overlapping `play_announcement`
calls (which wedged MA into 500s).

#### 2.5 Deferred retry

`scheduleBroadcastRetry` provides a single-slot deferred retry with delays
`RETRY_DELAYS_MS = [30 s, 90 s, 180 s]` for broadcasts that could not be
*verified* (all targets unavailable, MA call failure, or a suspiciously fast
completion). A retry:

- re-checks `cfg.enabled` (an operator who disabled broadcasts must not hear an armed retry);
- passes `skipSip = true` — the SIP target already got the audio on the first dispatch, so it isn't replayed on the cordless at +30/+90/+180 s;
- resets `retryAttempt` to 0 on any verified success.

---

### 3. The audible dispatch: MA + SIP (`broadcast.ts`)

#### 3.1 Per-target volume pin (v1.24.0)

Before the MA announcement, `playAnnounce(url)` pins each target's **standing
volume** to `announceVolumeLevel(cfg.announceVolume)` (0..1), derived from the
same `announceVolume` (0..100) that is sent as `announce_volume`. This exists
because RAOP/AirPlay speakers (ecobees especially) handle MA's
set→play→restore `announce_volume` unreliably and fall back to a standing
volume that can silently drift low (~0.2 after re-provisioning).

**v1.24.0 audit fix — per-target, not batched:** the volume_set is issued
**one call per target in parallel** (`Promise.all(cfg.targets.map(...))`), not
as one batched `entity_id` list. HA resolves a batched list before executing,
so a single VOLUME_SET-incapable target (the cordless lacks the feature bit;
the two ecobees have it) would make the whole call raise `ServiceNotSupported`
and pin *nobody*. Per-target isolates the incapable one so capable speakers are
always pinned. It is best-effort — a failure is logged and never blocks the
announcement; after any success there is a 300 ms pause to let RAOP apply
before the stream. Skipped entirely when `announceVolume` is `null`
(`'standing'`/`'off'` escape hatch).

The MA call itself:

```js
music_assistant.play_announcement({
  entity_id: cfg.targets,          // all MA targets in one call
  url,                             // http://<audioBase>/audio-render/<sha1>.wav
  use_pre_announce: cfg.usePreAnnounce,
  announce_volume: cfg.announceVolume,   // omitted entirely when null
})
```

Retried up to `cfg.announceRetries` times (1.5 s apart) on an actual call failure.

#### 3.2 SIP side-channel (v1.25.0)

`playSipAnnounce(url)` delivers the **same rendered WAV** to `cfg.sipTargets`
via `media_player.play_media` with `announce: true`, `media_content_type:
'music'`. Key properties:

- Dispatched **BEFORE the MA pre-flight** and **fire-and-forget** — so the cordless is a genuine *alternate* channel that still speaks even when the MA pre-flight defers because the ecobees are mid-restart / unavailable.
- **No volume pre-pin** — the cordless has no volume feature (a `volume_set` on it 500s).
- Fire-and-forget so the ~3–5 s play_media → switchboard render+originate round-trip never delays the (already 17–34 s) MA announcement.
- Skipped on deferred MA retries (`skipSip`) so the identical alarm isn't replayed on the cordless.
- A target listed in **both** `BROADCAST_TARGETS` and `BROADCAST_SIP_TARGETS` is dropped from the SIP list at load — MA wins.
- **At least one MA target is required.** A SIP-only configuration is treated as "no targets" (`cfg.targets.length === 0` → `no targets configured`), because the whole outcome/retry/health machinery keys on `cfg.targets` and SIP dispatch is unverifiable.

#### 3.3 MA pre-flight & verification

After the SIP dispatch, before the MA call:

- **Pre-flight:** `getEntityState` each MA target; require `≥1` registered and not `'unavailable'`. During HA/MA restart windows entities briefly deregister and HA *accepts* `play_announcement` then silently drops it (3 confirmed swallowed broadcasts, each "ok" in 20–34 ms). If `usable === 0`, defer + retry, mark `lastOutcome = 'failure'`, and freshen the health probe.
- **Post-call verification:** a real MA announcement blocks until playback completes (17–34 s). If the call returns `ok` in **< 2000 ms**, it is treated as unverified (`unverified: completed in <n>ms — too fast for real playback`) and a retry is scheduled — a success no one heard is not reported as success.

Outcome (`'success'` / `'partial'` / `'failure'`), errors, level, spoken message,
and last render diagnostics are persisted to `broadcast-last.json` (next to the
SQLite DB) so "what played last and did it work" survives the very restarts that
most need auditing.

---

### 4. Announcement rendering (`audioRenderer.ts`)

#### 4.1 Layout

`renderAnnouncement(opts)` assembles one WAV, per repeated/language block:

```
[lead-in silence][chime × chimeRepeat][chime gap][TTS pass] ... [terminator]
```

Multiple blocks are joined with `repeatGapMs` of silence. The full ordering is
built by the pure, unit-tested `assembleAnnouncementParts(silence, blocks, gap,
tails, endGap)`. Silence buffers are frame-aligned zero-filled PCM
(`makeSilencePcm`).

Timing knobs (all resolved once and folded into the cache key):

| Knob | Default | Meaning |
|------|---------|---------|
| `leadSilenceMs` | 1500 ms | Digital silence before the first chime so AirPlay/multi-room speakers sync up (prevents clipped chime starts + slow devices missing short clips). 0 disables. |
| `chimeRepeat` (`getChimeRepeat()`) | 2 | Times the chime plays inside each block. Clamped 1..4 by settings; hard-capped at `MAX_CHIME_REPEAT = 8` at the allocation site. |
| `chimeGapMs` | 1000 ms | Silence after the chime group, before the spoken message (chime decays first). |
| `announceRepeat` (`cfg.repeat`) | 2 | Whole (chime+message) block repeats so a missed first pass gets a second. Clamped 1..3. **Ignored when bilingual** (the two languages ARE the redundancy). |
| `repeatGapMs` | 1500 ms | Silence between repeated blocks. |
| `endOfMessageGapMs` | 700 ms | Silence before the "End of message" terminator on the final block. |

#### 4.2 TTS passes & the bilingual second language

By default there is **one pass** (`message`), repeated `announceRepeat` times.
When `opts.messages` is supplied (bilingual active), each entry
(`{ text, voice, lang }`) is its own pass, played once in order — e.g. English
then Spanish. Each unique `(lang, voice, text)` is rendered once via Wyoming and
de-duped. Each pass's text is normalized with its language's verbalizer
(`verbalizeForTts` for `en`, `verbalizeForTtsEs` for `es`) at render time.

A pass whose TTS fails, or whose WAV format doesn't match the klaxon
(rate/width/channels), is **dropped** — non-fatal; the other passes still play.
`≥1` pass must survive or the render is a hard error.

#### 4.3 "End of message" terminator (per-language)

When enabled, a terminator utterance ("End of message" / "Fin del mensaje")
rides the **last block of each language**. A bilingual alarm gets the English
phrase after the English pass and the Spanish phrase after the Spanish pass; a
monolingual alarm gets one terminator on the final block. A terminator that
fails to render or mismatches format is **omitted** (message still plays) and
marks the render incomplete.

#### 4.4 Format & concat

Everything is a **byte-splice of raw PCM** — there is no per-render resampling.
The renderer requires the chime WAV and every TTS WAV to be **identical format**
(22050 Hz / 16-bit / mono). Piper's default voice matches exactly. A mismatched
Piper voice (e.g. a 16 kHz voice) causes that pass to drop with a diagnostic like
`format mismatch — klaxon=22050/16/1 tts=16000/16/1`. `parseWavHeader` tolerates
extra chunks (Piper sometimes emits a LIST chunk) by scanning for `data`.

#### 4.5 Klaxon-only path

If **no** pass has spoken text (`anySpoken === false`), the render is chime-only
(lead silence + `announceRepeat` blocks of `chimeRepeat` chimes) — still cached,
no Wyoming call. With `leadMs === 0 && chimeRepeat === 1 && announceRepeat === 1`
this is byte-identical to the source klaxon WAV.

#### 4.6 Cache & the cache key

Renders are cached at `/data/audio-render/<hash>.wav`. On a cache hit a single
async `stat` short-circuits (returns `fromCache: true`). Writes are atomic:
unpredictable temp name (`<path>.<pid>.<rand>.tmp`) + exclusive create (`flag:
'wx'`) + `rename`, so the HTTP route can never serve a partially-written WAV.

**`renderCacheKey(...)`** is `sha1(...).slice(0,16)` over a `|`-joined string:

```
v<RENDER_VERSION>|<level>|x<chimeRepeat>|r<announceRepeat>|s<leadMs>|g<repeatGapMs>|c<chimeGapMs>
  <tagPart><eomPart><msgPart><voicePart>|<message ?? '<null>'>
```

- `RENDER_VERSION = 6` — bumping it invalidates every cached render without touching disk.
- **Zero-churn design:** components are *omitted* for their neutral/default value so a default operator's key is byte-identical to the pre-feature string. Built-in chime tag omits `tagPart`; disabled terminator omits `eomPart`; monolingual omits `msgPart`; unpinned voice omits `voicePart`.
- `tagPart` for a named/custom tone also folds in `AUDIO_ASSETS_VERSION`, so regenerating a tone asset invalidates dependent combined renders.
- A null `message` hashes distinctly from empty string (klaxon-only vs empty-spoken don't share a slot).
- `wyomingVoice` (`BROADCAST_WYOMING_VOICE`) is folded in so a voice change re-renders (the monolingual path historically had no voice token → cache-hit the wrong voice's WAV; fixed v0.64.0).

**Incomplete renders** (a dropped pass or dropped terminator) are written to a
distinct `<hash>.partial.wav` name — served for this announcement but never
cache-hit — so once a Spanish voice is provisioned the next render is complete
and caches properly. Both are pruned by age.

`pruneRenderCache(dir, maxAgeMs, log)` runs hourly with
`CACHE_MAX_AGE_MS = 7 days`, and also sweeps crash-orphaned `*.tmp` files older
than 1 h.

#### 4.7 Render health — the dead-voice self-alert (v1.44.0)

The cache creates a blind spot: a wedged TTS engine (a Home Assistant Core
update can kill the Piper add-on's Wyoming socket while the add-on still reports
`started`) renders nothing, yet previously-cached WAVs keep playing, so the
alarm's voice can be dead for days while every repeated announcement still
sounds normal. The failure only surfaces when a *changed* message forces a fresh
render — which is precisely when speech matters.

`audioRenderer.ts` therefore tracks **fresh-render health** in a module holder
(`ttsRenderHealth()`): each render request whose spoken passes *all* fail
increments a consecutive-failure counter (recording the last error and
timestamp); a successful fresh render resets it. Cache hits never touch the
counter in either direction — they prove the disk file exists, not that the
engine is alive.

`alerts.ts` raises **`tts-render-degraded`** (warning, Connectivity/System)
when the counter reaches **≥ 2** — one blown render is tolerated as transient;
two consecutive failures with no intervening success indicates a wedged engine.
The alert names the failure count and last error, states that critical chimes
still deliver (the klaxon path needs no TTS) while speech is dropped, and
carries the remedy: restart the Piper add-on, after which the next changed
message re-renders and the alert self-resolves.

**Failure-path delivery (v1.45.0).** A spoken-render failure never silences a
condition broadcast: the announcement falls back to a **chime-only render**
(cached, no Wyoming dependency) so the klaxon still sounds, the outcome reports
`partial` with the render error retained, and the tick layer schedules **one
spoken retry 90 s later** — past a transient host stall (the observed failure
class: nightly backup I/O saturating the host at 04:58–05:02, colliding with
quiet-hours end). The retry re-checks the condition level, enablement, and
quiet hours, bypasses the storm gate (the identical message is intentional),
and is never repeated — a second consecutive failure is this alert's job. The
chime-only fallback does not touch the failure counter; only a fresh spoken
render success resets it.

---

### 5. The tone library (`audioAssets.ts`)

All alarm audio is **synthesized in-process at server startup** (speakers can't
synthesize on the fly, they need URLs). Format is fixed **PCM 22050 Hz / 16-bit
mono** (`SAMPLE_RATE`/`BITS_PER_SAMPLE`/`NUM_CHANNELS`). The synth primitive
`addTone` supports `square`, `sine`, and additive-harmonic `bell` waveforms with
attack/release envelopes; `addTone` floors the onset attack at ~4 ms to kill a
sample-0 DC click.

#### 5.1 The four level klaxons + chime packs

There are four asset ids (`red-alert`, `yellow-alert`, `all-clear`, `boatswain`),
written to `/data/audio/<id>.wav`, and mapped to levels by:

```
KLAXON_FOR_LEVEL = { red: 'red-alert.wav', yellow: 'yellow-alert.wav', green: 'all-clear.wav' }
```

The waveforms depend on the selected **chime pack** (`BROADCAST_CHIME_PACK`):

| Pack | red | yellow | green |
|------|-----|--------|-------|
| **`powerplant`** (default) | Fast hi/lo square warble ~4 alt/s, 880/587 Hz, ~2.6 s ("drop everything") | Slow ~1.5 Hz single-tone sine, 620 Hz, 3 beeps, ~1.9 s | Soft descending bell double-chime 660→554 Hz, ~1.0 s |
| **`airport`** | Descending struck-bell Am arpeggio C5→A4→F4, ×2, ~3.0 s | Two-note "bing-bong" E5→C5 bell, ~1.4 s | Rising C-major arpeggio C5→E5→G5 bell, ~1.3 s |

The `powerplant` pack follows ISA-18.2 / EEMUA-191 convention (priority conveyed
by *cadence*: fast warble = emergency, slow pulse = caution, soft chime =
advisory). `boatswain` (a two-tone sine sweep) is pack-independent.

#### 5.2 Named built-in tone library (v0.17.0)

A fixed, **selectable** library of 16 short tones (separate from the 4 klaxons),
synthesized once to `/data/audio/<id>.wav`, pack-independent. Catalog
(`BUILTIN_TONES`, ordered as shown in the UI dropdown):

`ping-single` (Single Ping), `ping-double` (Double Ping), `triad-bell` (Triad
Bell), `triad-up` (Rising Triad), `marimba-run` (Marimba Run), `cascade` (Chime
Cascade), `doorbell` (Two-Tone Doorbell), `chirp-rise` (Rising Chirp),
`sweep-down` (Descending Sweep), `sonar-ping` (Sonar Ping), `pulse-slow` (Slow
Pulse (caution)), `warble-fast` (Fast Warble (emergency)), `buzz-alarm` (Alarm
Buzz), `klaxon-honk` (Klaxon Honk), `knock-soft` (Soft Knock), `gong` (Gong).

**Immutability contract:** a tone id is a permanent identity for one sound (its
render-cache tag is `b:<id>`, with no version component). To *change* a sound,
ship a new id — never edit an existing builder's waveform in place (it would
serve stale cached renders). Module load asserts every `BUILTIN_TONES` entry has
a matching `NAMED_TONE_BUILDERS` fn (a refused deploy is better than a catalog
tone that writes no WAV). A named-tone id must match
`BUILTIN_TONE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/`.

#### 5.3 Version-gated regeneration

`AUDIO_ASSETS_VERSION = 5`. A marker file `/data/audio/.assets-version` stores
`"<version>:<pack>"` (e.g. `"5:powerplant"`). If it doesn't match, all WAVs are
force-regenerated at boot (atomic tmp→rename). So bumping the version OR
switching the pack regenerates without manual `/data/audio` cleanup.
`regenerateAudioAssets` (tests / explicit reset) deletes all assets + the marker
first.

---

### 6. Operator-uploaded tones (`chimeStore.ts`)

The operator can upload their own short WAV to prepend the spoken message.
Library lives at `CHIMES_DIR` (`$CHIMES_DIR` / `$DATA_DIR/chimes`, default
`/data/chimes`): `<id>.wav` (normalized) + `manifest.json`.

**Two hard safety rules:**

1. **Normalize on ingest.** The renderer requires exactly 22050/16/mono. Rather
   than reject the ~99% of real files that are 44.1 kHz stereo, `normalizeToTarget`
   decodes (PCM int 8/16/24/32 or IEEE float 32), downmixes to mono, linear-
   resamples to 22050 Hz, and requantizes to 16-bit — ONCE, at upload. The
   per-render path stays a byte-splice.
2. **Server-generated ids only.** The id is `sha1(normalized PCM).slice(0,16)`
   (16 hex) — content-addressed, so a re-upload de-dupes. A client filename
   never touches a path/URL; it lives in the manifest only as a display label
   (`sanitizeName`). Every id passes through `chimeFilePath` which enforces
   `/^[a-f0-9]{16}$/` + a directory-containment check.

**Caps:** `MAX_UPLOAD_BYTES = 2 MB` raw, `MAX_CHIME_COUNT = 20` tones,
`MAX_DURATION_MS = 15 s`. The manifest is read into a null-prototype object with
per-key hex validation (prototype-pollution defense). `listChimes` self-heals
after manual file deletes (only surfaces entries whose file exists).

---

### 7. Per-level chime assignment (`chimeConfig.ts`)

Persisted at `$CHIME_CONFIG_PATH` (default `chime-config.json` next to the DB).
Stores a per-**level** (not per-priority) assignment for `red`/`yellow`/`green`:

```
{ kind: 'builtin' }        // the level's synthesized klaxon (default)
{ kind: 'named', id }      // a named built-in tone
{ kind: 'custom', id }     // an uploaded tone
```

Granularity is per-level because every render call site is level-based
(`AnnouncementLevel`), and `klaxonLevelForPriority` already collapses the 4 ISA
priorities to these 3 levels. Default is all-`builtin`, so until the operator
assigns a custom tone this module is a pure no-op and audio is byte-identical to
pre-feature.

**`resolveChime(level, klaxonDir)`** is the single resolution seam (used at
every render call site). It returns `{ path, tag, fellBack }`:

| Assignment | path | tag |
|------------|------|-----|
| `builtin` (or unset) | `klaxonDir/KLAXON_FOR_LEVEL[level]` | `'builtin'` (omitted from cache key) |
| `named` (file present) | `builtinTonePath(id, klaxonDir)` | `b:<id>` |
| `custom` (file present) | `chimePath(id)` | `<16-hex id>` |
| named/custom **file missing** | **falls back** to the builtin klaxon path | `'builtin'`, `fellBack: true` |

The tag **always matches the returned path**, so the render cache can never
serve a stale tone for a swapped id. A dangling/deleted assignment degrades to
"wrong tone, message still plays" — never a silent alarm. `updateChimeConfig`
rejects assignments to ids that don't exist (keeps the prior value);
`revertAssignmentsFor(id)` reverts every level using a custom id back to builtin
when that tone is deleted.

---

### 8. Text-to-speech: message building & normalization (`ttsService.ts`)

#### 8.1 `buildAlertMessage(level, alerts)` → spoken English sentence

- `green` → `"All clear. All stations report normal."`
- `red`/`yellow` → picks a **primary alert** (`pickPrimaryAlert`: prefer target severity, then alerts with a location, then category rank Battery > SHP2 > Solar > Grid > Thermal > Connectivity; never a non-annunciating alert) and builds:

  ```
  <ISA priority prefix> <Category clause> <Location>. <Title>. <detail>[ Acknowledge at console.][ Repeat. <prefix> <Title>.]
  ```

  Critical uses a doubled prefix ("Critical alarm. Critical alarm.") and appends
  an acknowledge + a brief repeat. Category is spoken-friendly ("Battery" →
  "Battery system", "SHP2" → "Smart panel"); location is number-worded ("Core 3
  Pack 2" → "Core three pack two"). Detail is shortened to ~200 chars at a
  sentence boundary. A no-primary fallback derives the prefix from the level's
  severity.

#### 8.2 `verbalizeForTts(s)` — the normalizer

Makes Piper read symbols/units naturally. It is the **v0.57.0 chokepoint**:
`buildAlertMessage` normalizes the title/detail, and the renderer normalizes the
whole assembled message a second time (so hand-built SoC/runway/test/preview
strings get the same treatment). It is therefore **idempotent at the function
level** (`verbalizeForTts(verbalizeForTts(x)) === verbalizeForTts(x)`).

Rules (order matters — longest token first):

- plural `(s)` → plain plural (`month(s)` → `months`);
- rate slashes → "per unit" (`%/h` → `percent per hour`);
- relational/math symbols (`≥`→"at or above", `≤`→"at or below", `≈`/`~`→"about", `<`→"below", `>`→"above", `→`→"to", `²`→"squared"), plus ASCII `>=`/`<=`;
- em/en dash, middot → a spoken pause; parens dropped;
- energy/power/electrical units, **number-anchored** (`(\d…)\s*UNIT\b`): `kWh`→"kilowatt hours", `Wh`, `kWp`, `kW`, `W`→"watts", `mAh`, `Ah`, `mA`, `A`→"amps", `mV`, `kV`, `V`→"volts";
- time units: `h`/`hr`/`hrs`/`hours`→"hours", `min`→"minutes", `mo`→"months", combo `3h 7m`→"3 hours 7 minutes";
- `°F`/`°C`→degrees, `%`→"percent";
- domain abbreviations: `SoC`→"state of charge", `SoH`→"state of health", `IR`→"internal resistance", `EVSE`→"charger" (before `EV`), `RTE`, `TOU`, `PV`→"solar", `MPPT`→"M P P T", `BMS`/`EMS`, `HV`/`LV`, `EV`→"E V", `SHP2`→"smart panel", `DPU`→"D P U";
- singularize the realistic `1 <time>s` cases (`in 1 hours` → `1 hour`);
- collapse whitespace runs, tidy space-before-punctuation.

Unit rules are number-anchored so device SNs (`GBC0314`), error codes, and prose
("a breaker") are never corrupted. en_US only.

#### 8.3 Spanish second pass

`buildAlertMessageEs` mirrors the English builder with fully Spanish framing
(`priorityAnnouncementPrefixEs`, `categoryEs`, `locationEs`, `numberWordEs`). The
**title** is translated for broadcast-eligible families via `ES_TITLE_BY_ID_PREFIX`
(an id-prefix map, longer prefixes first), else the English title is read; the
free-form **detail tail** falls back to the English original (verbalized) — by
design, no translation API on the alarm path. `verbalizeForTtsEs` is the light
Spanish normalizer (templates are authored spoken-ready, so it only converts
stray symbols). Green → `"Todo despejado. Todas las estaciones reportan
normalidad."`

---

### 9. Wyoming / Piper TTS client (`wyomingTts.ts`)

`renderWyomingTts({host, port, text, voice, timeoutMs})` speaks the **Wyoming
protocol directly to the Piper add-on over TCP** — no HA Core, no
`tts_get_url`, no Supervisor proxy in the path (that path went through six
failed iterations v0.9.18–v0.9.69; HA 2026.6.0b0's proxy started 500ing on
`tts_get_url`, so HA was removed from the TTS critical path entirely).

Protocol: JSON events over TCP with optional binary payloads. The client sends a
`synthesize` event (`{ text, voice?: { name } }` — voice omitted → Piper's
configured default), then assembles `audio-start` (format metadata) +
`audio-chunk` (binary PCM, repeated) + `audio-stop` into a WAV via `pcmToWav`.
Default `timeoutMs = 15000`. It is resilient to connect-refused, mid-stream RST,
malformed events, a hung server, empty payloads, and surfaces a Wyoming `error`
event (e.g. unknown voice name) verbatim. It does **not** retry — the renderer
owns retry/fallback policy (a failed pass simply drops).

`pcmToWav(pcm, rate, width, channels)` writes a 44-byte RIFF/WAVE header (single
allocation) byte-identical to `audioAssets.buildWavBuffer`, so the two renderers
produce concat-compatible WAVs.

---

### 10. `callHaService` — total, never throws (`haService.ts`)

Every HA interaction goes through `haService.ts`, which reads `SUPERVISOR_TOKEN`
and POSTs to `http://supervisor/core/api`. Outside Supervisor
(`isSupervised() === false`) every call is a no-op returning `{ ok: false,
error }` so the rest of the pipeline still runs in dev.

**`callHaService(domain, service, data)`** never throws — a network error is
caught and returned as `{ ok: false, error }`. It surfaces HA's actual error
message (`{"message": "..."}` body) rather than just a status code. Timeouts are
tuned per service:

| Call | headersTimeout | bodyTimeout | Why |
|------|----------------|-------------|-----|
| `music_assistant.play_announcement` | **75 s** | **120 s** | MA blocks until the announce is queued + started on every target; a ~2.2 MB / ~24 s repeated WAV to slow ecobees needs the headroom, else it aborts "partial" though audio played. |
| everything else | 5 s | 10 s | Keep hangs visible. |

Helpers used by the broadcast monitor: `getEntityState` (pre-flight + health
probe; returns null when HA doesn't know the entity), `getAllStates`
(discover + config-drift resolver), `probeService` (three-state
`present`/`absent`/`unknown` MA detection — `unknown` is not treated as a
confirmed negative, avoiding the boot-race "broadcasts will fail" false alarm),
`getServiceCatalog`, `startConfigFlow`/`submitConfigFlow`/`deleteConfigEntry`
(the `/api/broadcast/setup-piper` + `/reset-piper` Wyoming integration
management), and the legacy `ttsGetUrl` (with its en_US↔en-US language-toggle
retry chain — retained but off the current critical path).

---

### 11. Runtime config: env baseline + live override

#### 11.1 The two-layer model (`broadcastRuntimeConfig.ts`)

The add-on's env vars (from the HA options UI) set the **baseline**. A small,
user-mutable **override** layer persisted at
`broadcast-runtime-config.json` (next to the DB) sits on top. Each field is an
override: `null` = defer to env, a concrete value wins. `loadBroadcastConfig()`
re-merges the override every tick (~10 s) and per broadcast, so a UI change takes
effect within one tick with **no restart**. Only `enabled` and `volume` are
overridable this way. Writes are atomic (tmp+rename) with change listeners; the
monitor subscribes (`onBroadcastRuntimeConfigChange`) to keep its closure `cfg`
coherent for immediate read-back on `/api/broadcast/config` + `/status`.

**Important coupling:** `volume` here is the abstract 0..1 master level. What
actually reaches the speakers is `announceVolume` (0..100), which
`loadBroadcastConfig` recomputes from the effective volume — setting only
`volume` without that recompute would be audibly inert. When
`BROADCAST_ANNOUNCE_VOLUME` is pinned in env (a number or `'off'`/`'standing'`),
that advanced override wins and the slider is informational only
(`announceVolumePinned` in the API discloses this).

#### 11.2 `resolveAnnounceVolume` / `announceVolumeLevel`

- `BROADCAST_ANNOUNCE_VOLUME` = `'off'`/`'none'`/`'standing'` → `null` (omit `announce_volume`, play at standing level — more reliable on ecobees, and the pre-pin is skipped).
- a `0..100` number → that value.
- empty → `round(effectiveVolume × 100)`.

`announceVolumeLevel(announceVolume)` divides by 100 back to 0..1 for the
standing-volume pin — both knobs carry one value, not competing sources.

---

### 12. Full config knob reference

Loaded by `loadBroadcastConfig()` (env, with the runtime override for
enabled/volume). Booleans accept `true`/`1`.

| Env var | Default | Effect |
|---------|---------|--------|
| `BROADCAST_ENABLED` | `false` | Opt-in master enable (overridable live). |
| `BROADCAST_TARGETS` | — | Comma-separated `media_player.*` entity ids (MA speakers). Non-`media_player.` entries dropped. |
| `BROADCAST_SIP_TARGETS` | — | Comma-separated `media_player.*` SIP/announce-only targets. Entries also in `BROADCAST_TARGETS` dropped. |
| `BROADCAST_AUDIO_BASE` | `http://homeassistant.local:8787` | URL prefix speakers fetch the rendered WAV from (trailing slash stripped). |
| `BROADCAST_VOLUME` | `0.5` | 0..1 master level (overridable live). Clamped. |
| `BROADCAST_ANNOUNCE_VOLUME` | (empty → volume×100) | Pins announce volume: a `0..100` number, or `off`/`none`/`standing` to omit it. |
| `BROADCAST_MIN_SEVERITY` | `critical` | `critical` or `warning` — the lowest level that broadcasts (`yellow` skipped when `critical`). |
| `BROADCAST_QUIET_HOURS` | (empty) | e.g. `"22-06"`. Suppresses non-critical (and critical unless break-through) in-window. |
| `CRITICAL_BREAKS_QUIET_HOURS` | `false` | When true, red/high/critical break through quiet hours; default OFF ⇒ everything held overnight. |
| `BROADCAST_WYOMING_HOST` | `core-piper` | Wyoming/Piper TCP host. |
| `BROADCAST_WYOMING_PORT` | `10200` | Wyoming/Piper TCP port. |
| `BROADCAST_WYOMING_VOICE` | (Piper default) | Piper voice override (e.g. `en_US-amy-medium`). Folded into the cache key. |
| `BROADCAST_WYOMING_VOICE_ES` | (empty) | Second-language (Spanish) Piper voice. Empty → bilingual inactive. |
| `BROADCAST_BILINGUAL` | `true` | Enable the Spanish second pass (no-op until `_VOICE_ES` set). |
| `BROADCAST_LEAD_SILENCE_MS` | `1500` | Lead-in silence, clamped 0..5000. |
| `BROADCAST_REPEAT` | `2` | Whole-block repeats, clamped 1..3. |
| `BROADCAST_REPEAT_GAP_MS` | `1500` | Silence between repeats, clamped 0..5000. |
| `BROADCAST_CHIME_GAP_MS` | `1000` | Post-chime gap, clamped 0..5000. |
| `BROADCAST_USE_PRE_ANNOUNCE` | `false` | MA pre-announce wake tone. |
| `BROADCAST_ANNOUNCE_RETRIES` | `1` | In-call MA retries, clamped 0..3. |
| `BROADCAST_END_OF_MESSAGE` | `true` | Append the terminator to the final play. |
| `BROADCAST_END_OF_MESSAGE_PHRASE` | `End of message` | English terminator (blank disables). |
| `BROADCAST_END_OF_MESSAGE_PHRASE_ES` | `Fin del mensaje` | Spanish terminator. |
| `BROADCAST_END_OF_MESSAGE_GAP_MS` | `700` | Pre-terminator gap, clamped 0..5000. |
| `BROADCAST_CHIME_PACK` | `powerplant` | `powerplant` (ISA-18.2 cadences) or `airport` (melodic bells). |
| `BROADCAST_BOOT_WARMUP_MS` | `600000` (10 min) | Restart-continuation + boot phantom-red window. |
| `BROADCAST_HEALTH_PROBE_MS` | `60000` | Audible-health probe interval. |
| `BROADCAST_UNREACHABLE_CONFIRM` | `3` | Consecutive-fail streak before confirming unreachable. |
| `DATA_DIR` / `CHIMES_DIR` / `CHIME_CONFIG_PATH` / `BROADCAST_RUNTIME_CONFIG_PATH` | `/data`-relative | Storage locations. |

Alert-settings knobs consumed by rendering: **chime repeat** (`getChimeRepeat()`,
`DEFAULT_CHIME_REPEAT = 2`, clamped `CHIME_REPEAT_MIN = 1`..`CHIME_REPEAT_MAX = 4`)
and the per-priority annunciation enable flags.

---

### 13. Audible-delivery health & self-alert (`broadcastHealth.ts`)

The audible channel can be **enabled yet reach zero speakers** — the exact
silent failure that once hid a dead alarm channel (Music Assistant fell into
`setup_error`, every MA media_player went `unavailable`, and nothing said so).
This module makes that self-announcing.

The monitor runs `computeAudibleHealth()` on its own throttle
(`AUDIBLE_HEALTH_PROBE_MS`, default 60 s, seeded ~15 s after boot) — **not** only
when a broadcast fires — so a dead channel is caught even while the fleet is
green. It probes target availability (`getEntityState` each target; usable =
present and not `'unavailable'`) and publishes a `BroadcastHealth` snapshot via
`setBroadcastHealth`. Reachability is **debounced**: `reachable` stays `null`
until `unreachableStreak >= AUDIBLE_UNREACHABLE_CONFIRM` (default 3) flips it to
`false`, so a transient HA/MA restart blip never fires. A re-entrancy guard
(`audibleProbeInFlight`) coalesces overlapping probes so one real window can't
double-increment the streak.

Two not-usable signatures are distinguished for triage: all-`null`
(entities NOT FOUND → MA likely down/removed its players, or HA API unreachable)
vs all-`unavailable` (integration loaded, speakers offline). A one-shot
**config-drift resolver** (`resolveTargetDriftOnce`, ~16 s after boot) resolves
every configured target against the full HA registry and, when *other*
`media_player` entities exist but the specific target does not (the unambiguous
rename signature), logs a loud named WARN and un-debounced marks the channel
unreachable — a rename never self-heals.

**`broadcastHealthAlert(h, nowMs)`** is a pure builder: an enabled + supervised
channel that is CONFIRMED unreachable becomes a **WARNING / MEDIUM** push alert
`system-audible-unreachable` (`AUDIBLE_UNREACHABLE_ALERT_ID`). It returns null in
every other state (disabled / unsupervised / `reachable !== false`), so an
unwarmed monitor never false-alarms. It is deliberately NOT `annunciate: false`
(that would suppress the push too); instead `conditionFromAlerts` excludes its id
so it can never circularly try to chime over the channel it reports broken.
Severity is medium so it never wakes the household through quiet hours — an
unreachable speaker is not itself an emergency (the real emergencies push on
their own alerts). It also mirrors to HA diagnostic sensors via `mqttDiscovery`.

---

### 14. HTTP API surface (`index.ts`)

Static routes (all `decorateReply: false`; render/chime dirs use `wildcard:
true` for on-demand files):

| Route | Serves |
|-------|--------|
| `/audio/<id>.wav` | Built-in klaxons + named tones (generated at boot; `wildcard: false`). |
| `/audio-render/<sha1>.wav` | On-demand combined announcement renders. |
| `/chimes/<id>.wav` | Operator-uploaded tones (in-browser preview). |

JSON endpoints:

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `GET /api/broadcast/status` | none (read-only) | Full status snapshot: `enabled`, `targets`, `lastBroadcastAt/Level/Outcome/Errors`, `musicAssistantAvailable` (honest: present AND not confirmed-unreachable), `wyomingReachable`, `stormSuppressedCount`, `audibleReachable`/`audibleUsableTargets`/`audibleReason`, `lastRender` (filename/bytes/ttsRenderMs/fromCache/error), live `grid` backstop, and a resolved `config` block (all knobs + `announceVolume`). |
| `GET /api/broadcast/config` | none (120/min bucket) | Effective enable/volume + `announceVolume` + `announceVolumePinned` + `override` + `envBaseline`. |
| `PUT /api/broadcast/config` | write (30/min) | Set/clear the runtime `enabled`/`volume` override (`null` clears to env). Audit-logged. |
| `POST /api/broadcast/test` | write | Fire a test broadcast at `{ level }` (default `red`). Bypasses all gates except the 10 s test cooldown (`TEST_COOLDOWN_MS`). 429 on cooldown, 502 on failure. |
| `GET /api/broadcast/discover` | write | Enumerate every `media_player` HA knows (friendly name, inferred family, state, volume, `currently_configured`) so the operator picks targets from a real list. 503 if unsupervised/unreachable. |
| `POST /api/broadcast/setup-piper` / `reset-piper` | write | Add/reset the Wyoming Protocol integration via config-flow helpers. |
| `GET /api/chimes`, `GET /api/chime-config` | none | Console payload: levels, level labels, per-level `assignments`, uploaded `chimes`, `builtinTones`, `maxUploadBytes`. |
| `POST /api/chimes?name=` | write (rate-limited) | Upload a raw WAV body; `saveChime` validates + normalizes + stores. 400 on bad WAV / full library. |
| `DELETE /api/chimes/:id` | write | Delete a tone; reverts any level assigned to it back to builtin. 404 if absent. |
| `PUT /api/chime-config` | write | Assign tones per level (`{ assignments }`). 422 with `rejected[]` for unknown ids (prior value kept). |
| `GET/PUT /api/alert-settings` | read/write | Per-priority enable flags + `chimeRepeat` (`DEFAULT_CHIME_REPEAT = 2`). |
| `POST /api/alert-preview` | write | Preview a `{ priority, target }` announcement. `browser` renders only (returns `audioPath` for the web app to play); `speakers` also plays to MA targets. Short 2 s cooldown (`PREVIEW_COOLDOWN_MS`). |

#### The three operator-initiated render paths

- **`test(level)`** — 10 s cooldown; bypasses storm gate + all annunciation gates; speaks an ISA-prefixed "Test broadcast. This is only a test." (bilingual when a Spanish voice is set).
- **`preview(priority, target)`** — 2 s cooldown; renders via the identical `renderAnnouncement` call so it sounds exactly like a real alarm; `browser` never touches MA (works even when broadcasts are disabled / no targets).
- **`announce(priority, message, messageEs?)`** — the dedicated edge-triggered path for SoC / runway crossings. Maps priority → level via `klaxonLevelForPriority`, reuses `runBroadcast`, applies the quiet-hours gate but **no cooldown** (the SoC/runway monitors already edge-limit crossings). Never throws.

---

### 15. Honest-null & edge-case behavior (summary)

- **Missing/corrupt custom or named tone** → `resolveChime` / renderer fall back to the built-in klaxon (`fellBack: true`); never a silent alarm.
- **Failed TTS pass** (Wyoming down, unknown voice, format mismatch) → that pass drops; other passes still play; `≥1` must survive or it's a hard error.
- **Failed terminator** → omitted; message still plays; render marked incomplete → written to `.partial.wav` (served but not cached).
- **All MA targets unavailable** → deferred + retried at 30/90/180 s; SIP side-channel already delivered independently.
- **Sub-2 s MA "ok"** → treated as unverified (HA accepted but dropped it) → retried.
- **`musicAssistantAvailable`** reported true only when the service is present AND audible isn't confirmed-unreachable (MA in `setup_error` keeps its services registered while playing to no one).
- **`audibleReachable = null`** (pre-probe / transient restart) never raises the self-alert — only a debounced `false` does.
- **VOLUME_SET-incapable target** (cordless) → per-target pin isolates it so capable ecobees are still pinned.
- **Renderer cache** keyed on version + every timing/tone/voice/message input; incomplete renders never occupy the complete key; hourly prune at 7-day age plus a 1-hour orphan-`.tmp` sweep.
- **Restart** → boot warm-up (10 min) suppresses re-spoken yellow/green advisories but **never** a red; the first fresh red is held one tick to filter a telemetry-populate phantom.


---

## 11. User Interfaces: Web Dashboard, Telnet TUI & HACS Cards

The ecoflow-panel add-on exposes the same underlying fleet telemetry through **three independent front ends**, each aimed at a different consumption context:

| UI | Transport | Where it runs | Auth posture |
|---|---|---|---|
| **React web dashboard (PWA)** | WebSocket `/ws` + REST `/api/*` | Browser at `:8787` or via HA Ingress sidebar | Same-origin; writes need ingress/same-origin/token |
| **Control-room TUI** | Raw telnet TCP `:2323` **and** browser xterm.js at `/console` | `nc`/`telnet` client, or browser | Unauthenticated, LAN-trust |
| **HACS Lovelace cards** | WebSocket `/ws` + REST `/api/*` (cross-origin CORS) | Home Assistant Lovelace dashboards | CORS-allowlisted read; writes token-gated |

All three read the **same `FleetSnapshot`** the server pushes ~1×/sec over `/ws`, plus the same analytics REST endpoints. This document is a features-and-navigation reference for each surface.

The server that backs all three is a single Fastify instance (`server/src/index.ts`) listening on port **8787** (web + REST + WS), with the raw telnet listener on **2323**. Both ports are declared in the add-on `config.yaml`:

```yaml
ports:
  8787/tcp: 8787         # Web dashboard + REST API + WebSocket
  2323/tcp: 2323         # Telnet "control-room" TUI (no auth — keep on a trusted LAN)
ingress: true
ingress_port: 8787
panel_icon: mdi:home-battery
panel_title: Power
```

---

### The shared data spine: `/ws` snapshot + `/api/*` analytics

Every UI follows the same two-tier data model:

1. **Live snapshot over WebSocket** — the server pushes a JSON frame `{ type: 'snapshot', data: FleetSnapshot }` roughly once per second. `FleetSnapshot` carries `devices` (per-device projections: DPU packs, SHP2 backup pool, generic small devices), `grid`, `alerts`, and `generatedAt`. This is the source of truth for all live tiles.
2. **On-demand analytics over REST** — heavier computed views (forecast, runway, degradation, self-consumption, per-circuit history, etc.) are fetched from `/api/*` endpoints on mount and/or a refresh interval. These are cached server-side and never streamed on the WS hot path.

The full set of REST endpoints consumed by the front ends:

| Endpoint | Consumed by | Payload |
|---|---|---|
| `/api/snapshot` | one-shot seed (web + cards) | full `FleetSnapshot` |
| `/api/runway` | web RunwayCard, fleet-card | reserve-runway projection |
| `/api/summary/today` | web TodaySummary/SolarPanel, fleet-card, solar-card | day energy totals |
| `/api/forecast` | web ForecastCard/ForecastDetail/SolarResponseCard, fleet-card, solar-card | day-ahead forecast |
| `/api/forecast/probabilistic` | solar-card | P10/P50/P90 forecast bands |
| `/api/degradation` | web DegradationCard, battery-card | capacity-fade report |
| `/api/round-trip-efficiency` | web DegradationCard, battery-card | RTE |
| `/api/curtailment`, `/api/clipping` | web CurtailmentCard, solar-card | clipping/curtailment diagnostics |
| `/api/history`, `/api/circuit/history` | Sparkline/TrendChart, CircuitModal, circuit-card | recorder time-series |
| `/api/dispatch-plan` | strategy-card | dispatch plan |
| `/api/alerts/history`, `/api/alerts/outcome` | web AlertsPanel/AlertOutcomeButtons, alerts-card | cleared-alert log, outcome tagging |
| `/api/notify/status`, `/api/notify/test` | alerts-card | notify channel status/test |
| `/api/alert-settings`, `/api/chimes`, `/api/chime-config`, `/api/broadcast/config`, `/api/alert-preview` | web Alert Console | alarm-audio administration |
| `/api/self-consumption`, `/api/thermal-events`, `/api/equipment-health`, `/api/shade-report`, `/api/soiling-decomposition`, `/api/string-mismatch`, `/api/ev-window-prediction`, `/api/charge-curve`, `/api/internal-resistance`, `/api/forecast-skill`, `/api/ambient-thermal-forecast`, `/api/confidence`, `/api/nws-alerts`, `/api/incidents`, `/api/weather/ensemble` | web AdvancedInsightsCard, insights-card | predictive/analytics detail |
| `/api/device/refresh-cloud/<sn>`, `/api/device/refresh-cloud-cooldown` | web RefreshCloudButton | manual cloud-poll trigger (write) |

---

### 1. Web Dashboard (React PWA)

The web app is a Vite/React SPA served from the add-on's `:8787` root. Source lives in `web/src/`. The entry `App.tsx` renders a thin `NormalApp` that owns the WebSocket subscription and all derived views.

#### 1.1 Connection & rendering model

- **`useSnapshot()`** (`web/src/useSnapshot.ts`) opens a single WebSocket to `wsUrl()` and stores the latest `FleetSnapshot`. On close it reconnects with exponential backoff: `Math.min(15000, 500 * 2 ** retry)` ms, resetting on open. It exposes `conn` as `'connecting' | 'open' | 'closed'`, surfaced in the header as a **live / linking / offline** badge.
- **`api.ts`** builds every URL *relative to the directory the SPA was loaded from* so the same bundle works both on direct LAN (`/api/snapshot`) and under HA Ingress (`/api/hassio_ingress/<token>/api/snapshot`). `apiUrl('api/...')` prepends `baseDir()`; `wsUrl()` swaps `http→ws`/`https→wss` and appends `<baseDir>ws`.
- **Memoization** — `App.tsx` memoizes every derived view keyed on `snapshot` identity, so the ~1 Hz push only re-renders cards whose data actually changed; tab/theme toggles reuse stable references and skip re-render.
- **Code splitting** — the Dashboard is the eagerly-loaded landing page. Every other tab, plus `TrendChart`/`ForecastCard`/`AdvancedInsightsCard` (which pull in the ~540 kB recharts vendor chunk), is `React.lazy`-loaded so the entry bundle stays lean and first paint is fast.

#### 1.2 Tab navigation

The header renders a **5-tab pill** (reduced from 7 in v0.85.0). The tab set (`App.tsx` `tab` state):

| Tab label | Internal id | Component | What it shows |
|---|---|---|---|
| **Dashboard** | `dashboard` | inline in `App.tsx` | Landing overview (default) |
| **Solar** | `solar` | `pages/SolarPanel.tsx` | PV production + forecast + diagnostics |
| **Battery** | `thermal` | `pages/ThermalPanel.tsx` | Thermal + per-pack vitals + degradation |
| **Strategy** | `strategy` | `pages/StrategyPanel.tsx` | SHP2 dispatch config + circuit priority |
| **Alerts** | `alerts` | `pages/AlertsPanel.tsx` | Active/Learned/Cleared alerts + settings |

The **Alerts** tab carries a numeric badge = `critical + high + medium` count of *threshold* alerts (learned/model alerts are excluded from the count). The badge color follows the highest present ISA priority (bad → high → warn), computed via `alertPriority.priorityCounts()`.

Note the id/label mismatch: the **Battery** tab uses internal id `thermal` (historically the thermal panel). The former standalone "Predictive Insights" and "Alert Console" tabs were dissolved in v0.85.0 — predictive sections were relocated into their home pages, and the Alert Console became a sub-view of the Alerts page.

#### 1.3 Dashboard tab (landing page)

Rendered inline in `App.tsx`. Top-to-bottom:

- **RunwayCard** (`cards/RunwayCard.tsx`) — reserve-runway headline, fetches `/api/runway`.
- **EnergyFlow** (`cards/EnergyFlow.tsx`) — animated SVG power-flow diagram (PV → battery/grid → loads); reads `snapshot.devices` + `snapshot.grid`, no fetch.
- **TodaySummary** (`cards/TodaySummary.tsx`) — today's energy totals from `/api/summary/today`.
- **Shp2Card** — the SHP2 backup pool card (backup %, panel load, sources).
- **DpuCard** per Delta Pro Ultra — with a `viaShp2` fallback so a cloud-offline DPU still shows the state the SHP2 reports over its wired link (battery %, contributed watts, AC-open, temp, errors).
- **ForecastCard** (lazy) — 24 h day-ahead forecast, `/api/forecast`.
- **Two TrendCharts** (lazy, recharts) — "Backup pool & panel load (24h)" and "DPU output & PV (24h)", each pulling `/api/history` per series over a 24 h / 60 s-bucket window.
- **Other devices** grid — `SmallDeviceCard` for anything that isn't the SHP2 or a DPU (UPS, EVSE, etc.), online-first.
- **Overview digest** — a compact `AdvancedInsightsCard` filtered to `['model-fit', 'self-consumption', 'incidents']`: model-fit R² trust scorecard, 7-day self-consumption, and clustered incidents. Each block is **empty-by-design on a healthy fleet** and simply doesn't render.

#### 1.4 Solar tab (`SolarPanel.tsx`)

Live PV surface. Summary tiles ("Producing now" split HV/LV, HV/LV channel counts), a **FlowDiagram** of DPUs → arrays → panels, per-DPU `DpuSolarCard`s, a stacked-area PV history chart (recharts `AreaChart` over merged `/api/history` series). Then the diagnostic cards:

- **SolarResponseCard** — forecast-vs-actual response (`/api/forecast`).
- **CurtailmentCard** — clipping/curtailment (`/api/curtailment`).
- **ForecastDetail** — the deep day-ahead breakdown (`/api/forecast`).
- **AdvancedInsightsCard** filtered to the solar-relevant sections (shade, soiling, string-mismatch, forecast-skill, ambient-thermal, etc.).

Producing/idle/no-sun/fault status labels classify each array.

#### 1.5 Battery tab (`ThermalPanel.tsx`, internal `thermal`)

Fleet thermal + per-pack detail. A **SummaryStrip** (Avg SoC, Avg SoH, hottest pack, cells balancing). A selectable per-pack **PackDetail** pane exposing every BMS reading: SoC, runtime, representative/cell-max/cell-min/board/shunt/MOS-max temps, pack voltage, open-circuit voltage, cell mean, plus **per-cell temperature and voltage sensor grids** (32 cells). Color banding thresholds are labeled inline (SoC `<25% / 25–50% / ≥50%`; SoH `<75% / 75–85% / 85–95% / ≥95%`; cell imbalance `≤5 / ≤20 / ≤50 / >50 mV`). Cloud-offline cores are flagged ("still wired and counted in the pool capacity"). Below: **DegradationCard** (`/api/degradation` + `/api/round-trip-efficiency`) and an `AdvancedInsightsCard` filtered to battery sections (equipment-health, internal-resistance, charge-curve, thermal-events).

#### 1.6 Strategy tab (`StrategyPanel.tsx`)

SHP2 dispatch strategy, read from the SHP2 projection in the snapshot. Tiles for mid-priority discharge floor SoC, backup reserve SoC (+enabled), solar backup reserve SoC, and raw SHP2 mode codes (smart-backup mode, backup mode, overload mode). A **circuit-priority ranking** (`PriorityRow` per paired circuit, ranked). A **charge time-task** panel (task type, repeat mode, charge ceiling/floor SoC, charge watts) with a **DayTimeline** of charge windows and a "now" marker. Predictive strip = `AdvancedInsightsCard` filtered to `['ev-window', 'nws']` (EV-charging window prediction + NWS weather alerts).

#### 1.7 Alerts tab (`AlertsPanel.tsx`)

Uses a `SubNav` pill (`components/SubNav.tsx`) with four sub-views:

| Sub-view | Content |
|---|---|
| **Active** | Live threshold alerts, grouped, with `SubjectBoxes` breakdown and a low/medium/high/critical count tile row. |
| **Learned** | Model-driven detections (`source === 'learned'`): "Anomalies" (peer comparison & self-baseline) and "Forecasts" (runtime/degradation/day-ahead), each rendering the detection's statistical `facts`. Marked as *not* fixed-threshold rules. |
| **Cleared** | Cleared-alert history from `/api/alerts/history`, with a `ClearedFilter` sub-nav (All / Critical+High) and `AlertOutcomeButtons` posting to `/api/alerts/outcome`. |
| **Alert Settings** | Hosts the **Alert Console** panel (see below). |

Each active/learned alert row can carry a `PredictiveBadge`.

#### 1.8 Alert Console (`pages/AlertConsolePanel.tsx`)

The unified alarm-audio administration surface (v0.19.0), hosted inside the Alerts → Settings sub-view. It manages **three independent state objects**, each bound to its own endpoint and replaced wholesale on its own PUT (never merged, so one section can't clobber another):

- **`settings`** ← `GET/PUT /api/alert-settings` — per-ISA-priority on/off switches (with a Critical-silence confirmation dialog) and chime-repeat.
- **`data`** ← `GET/PUT /api/chimes` + `/api/chime-config` — tone-level assignments, uploaded `.wav` tone library, built-in tones.
- **`bcastCfg`** ← `GET/PUT /api/broadcast/config` — the broadcast master (audible on/off, live volume, override-vs-env-baseline).

Sections: (1) broadcast master (enable + volume, warns when off); (2) per-priority annunciation with repeat and per-priority preview (`/api/alert-preview`); (3) tone-per-level assignment — the level klaxon (`KLAXON_FILE = { red: 'red-alert', yellow: 'yellow-alert', green: 'all-clear' }`, served from `audio/<file>.wav`), a named built-in tone, or an uploaded custom tone, each previewable in-browser; (4) tone library upload/list/delete. A bad/deleted tone falls back to the level klaxon **server-side** — an alarm is never silenced by a missing file.

#### 1.9 Glossary tooltips

`web/src/glossary.ts` defines a `GLOSSARY` map (`def('soc|state of charge', '…')`, ~150 terms across battery/power-flow/MPPT/forecast domains) and `installGlossaryTooltips()`, mounted once in `App.tsx`. Rather than hand-adding `title=` to every label, a `MutationObserver` walks the DOM, finds **text-only leaf elements** (non-SVG) whose normalized text matches a glossary key, and sets their `title`. New pages/components are covered automatically. Rescans are throttled to at most one per `RESCAN_THROTTLE_MS = 1000` (trailing-guaranteed), so the ~30 childList mutations/sec from the live re-render don't thrash it. `normalize()` drops a trailing `· …` or `( …)` and lowercases before lookup.

#### 1.10 Themes

`web/src/theme.ts` + `ThemeToggle`. Two themes, switched via a header pill and persisted to `localStorage`:

- **Default** — "Light industrial HMI / control-room palette".
- **High Contrast** — "High-contrast dark palette — deep navy + cyan + amber accents" (lazy-loads its Google Fonts on first selection).

The palette itself lives in CSS variables under `[data-theme="..."]` selectors in `index.css`; `applyTheme` sets the attribute. recharts needs literal color strings (Tailwind classes can't reach it), so `UI`/`CHART`/`HUES`/`SERIES_PALETTE` are **Proxies** that resolve the current theme's CSS variable (a space-separated `R G B` triple → hex) on every access, so charts re-color on theme toggle through React's normal re-render.

#### 1.11 PWA + Ingress

- **Manifest** (`web/public/manifest.webmanifest`) — `name: "Power"`, `display: standalone`, `theme_color: #0b1014`, single maskable SVG icon. Plus `apple-mobile-web-app-capable` meta so it installs to the iOS home screen as "EcoFlow".
- **Service worker** (`web/public/sw.js`, cache `ecoflow-panel-v0.11.2`) — **never** caches `/api/*` or `/ws` (matched anywhere in the path so it works under ingress too); the HTML document is **network-first** (so a redeploy's new content-hashed bundles are always found — fixes the Safari white-screen after redeploy); content-hashed JS/CSS/img/fonts are **stale-while-revalidate** (immutable). Registered with a relative path so it resolves under both LAN and ingress.
- **HA Ingress** — `config.yaml` sets `ingress: true`, `ingress_port: 8787`. The Supervisor reverse-proxies the panel into HA's session as a sidebar item titled **Power** (icon `mdi:home-battery`). Because `api.ts` builds all URLs relative to `baseDir()`, the SPA, its WS, and its service worker all work behind the `/api/hassio_ingress/<token>/` prefix without change. Direct LAN access on `:8787` still works simultaneously.

---

### 2. Control-room TUI (telnet + browser)

A SCADA/power-plant-styled terminal UI. The per-session render/input state machine (`server/src/telnet/session.ts`, class `TuiSession`) is **transport-agnostic** and is driven by two front ends that share it plus the same refreshed data caches (`dataProvider.ts` — energy totals, day-ahead forecast, degradation):

- **Raw telnet TCP** (`telnet/server.ts`) on **:2323** — speaks just enough telnet IAC to put a client in character-at-a-time mode + NAWS (window-size) negotiation, enters the alt-screen buffer, and renders at 1 Hz.
- **Browser web terminal** (`telnet/wsConsole.ts`) at **`/console`** on `:8787` — serves a self-contained xterm.js page over a WebSocket (`/console/ws`), vendoring `xterm.js`/`xterm.css` from `node_modules` (no CDN). Suitable for an HA `panel_iframe` at `http://<host>:8787/console`.

#### 2.1 How to connect

```
nc <host> 2323          # or:  telnet <host> 2323
```

Gated by `TELNET_ENABLED` (env, default on; `TELNET_ENABLED=0` disables). Host defaults to `::`, port to `2323` (`config.ts`: `TELNET_HOST`, `TELNET_PORT`). The browser variant needs no client — open `/console`.

The TUI is **unauthenticated** on both transports — read-only telemetry meant for a trusted LAN (the `ports_description` explicitly warns so). The `/console/ws` upgrade rejects a cross-origin `Origin` but accepts same-origin/LAN/missing-Origin (so the panel_iframe works).

#### 2.2 Hardening (DoS guards)

Both transports cap concurrency and reap idle sessions so a LAN flood can't spawn unbounded 1 Hz render timers on the single-threaded event loop:

- Telnet: `MAX_TELNET_CONNS = 16`, `TELNET_IDLE_TIMEOUT_MS = 5 min` (reset on any inbound byte; over-cap connections get a banner and close). Inbound buffer capped at 4096 bytes.
- WS console: parity `MAX_WS_SESSIONS` / `WS_IDLE_TIMEOUT_MS` + `maxPayload`-bounded frames.

#### 2.3 Operator login (v1.46.0)

When a console password is configured (`TUI_PASSWORD` option, non-empty), every
session — telnet and `/console` alike — starts at a login prompt (`telnet/login.ts`)
rendered in the same pseudo-LCD lettering as the console brand. `TUI_USERNAME`
defaults to `operator` when left empty. The input state machine lives in the
transport-agnostic session driver, so both transports share one implementation:
printable keys type into the active field (password echoes masked), backspace
edits, TAB switches fields, ENTER advances username → password → verify.
Credential comparison is constant-time (SHA-256 digests through
`timingSafeEqual`, so neither content nor length leaks). Three failed attempts
disconnect. `q` does not quit at the prompt (it is a legitimate credential
character); `Ctrl-C` always disconnects. With no password configured the
session opens straight into the console — the login layer is opt-in, and
classic telnet is unencrypted, so the prompt is LAN-level access control, not
transport security.

#### 2.4 The console (`telnet/plant/`)

v1.46.0 consolidates the TUI to a **single interface**: the v0.9.13 mode
chooser and the legacy Summary console (`telnet/screens.ts`) are removed, so
every connection lands in the same SCADA-style console, there is one theme to
maintain, and the full terminal is spent on the console itself.

Every screen shares a top status header (timestamp, SYS.UPTIME, mode, alarm
count), an alarm banner (newest unack'd, keyed on 4-tier ISA-18.2/IEC-62682
priority), a body, and a footer hotkey legend. `PLANT_SCREENS`
(`plant/types.ts`), selected with digits **1–6**; **TAB** cycles to the next
screen. `Q`/`Ctrl-C` disconnects.

| Key | Id | Label | Content |
|---|---|---|---|
| 1 | `console` | CONSOLE | Bridge view: mimic power-flow diagram (PV→BATTERY┐├BUS├LOADS └GRID), banded gauges, headline tag rows (BUS.MAIN.V/HZ, PV.ARRAY.P, BATT.SOC, LD.PANEL.P, EVSE.P, GRID.AC.P). |
| 2 | `gen` | GEN | Per-DPU "generator" detail — `←/→` selects DPU, `↑/↓` selects pack (pack count is per-DPU, 1–5). |
| 3 | `bus` | BUS | Bus/interconnect detail. |
| 4 | `pv` | PV | Solar array detail. |
| 5 | `alm` | ALARM | Scrollable alarm list (`↑/↓` scroll). |
| 6 | `trd` | TRENDS | Recorder-backed trend view (uses the `Recorder`). |

The grid state resolver (`gridState.liveGridBackstop`) drives the console's ACTIVE / AVAILABLE / OFF-GRID grid annunciation.

#### 2.5 Large-format graphics (v1.46.0)

Two pure primitive modules feed the screens; both emit plain strings (callers
colorize whole segments, and visible width equals `.length` before styling):

- **`telnet/bigfont.ts`** — a 5-row pseudo-LCD block font (digits, `%`, `kW`,
  `.`, `:`, `-`, `+`, `/`, `h`). `bigText(s)` returns 5 equal-width rows;
  `bigTextWidth(s)` sizes without rendering.
- **`telnet/gauges.ts`** — `hbar` (eighth-block horizontal bar, width×8-step
  resolution), `vscale` (eighth-height column chart), `braille` (2×4-dot
  braille sparkline — 4 vertical levels per half-column), `tile` (3-row
  ISA-annunciator window), `fracLabel`. All total: NaN/Infinity/degenerate
  ranges clamp rather than throw.

Screen usage — every placement is width/height-adaptive and degrades to the
pre-v1.46.0 rendering when the terminal is too small (80×24 stays clean):
CONSOLE gains a big-digit headline band (fleet SoC / PV kW / LOAD kW) at
≥ 96×32 plus an always-on full-width POOL `hbar` gauge; TRENDS strips are
full-width `braille` sparklines; ALARM gains a 7-window annunciator header
(BATTERY SOLAR THERMAL SHP2 GRID COMMS SYSTEM — lit red for critical, yellow
for warning, dark-but-visible otherwise, ISA-style); GEN pack rows gain `hbar`
SoC bars.

#### 2.6 Rendering internals

`TuiSession.draw()` builds a frame body (`HIDE_CURSOR + CURSOR_HOME`, per-line `CLEAR_EOL`, trailing `CLEAR_BELOW`), computes a 32-bit **FNV-1a hash** of it, and **skips the write entirely** when the body is byte-identical to the previous frame (zero bandwidth, zero flicker). Frames are wrapped in synchronized-output escapes (`BEGIN_SYNC`/`END_SYNC`, terminal mode 2026) so supporting terminals flip atomically. Draws are serialized (`drawing`/`drawPending`) so a resize + 1 Hz tick can't interleave. Size is clamped to 60–200 cols × 16–80 rows. On disconnect the session restores the user's primary screen buffer (`?1049l`) so their terminal returns to what was there before.

---

### 3. HACS Lovelace cards (`lovelace/`)

Lit-based custom cards installed via HACS, for embedding the fleet views inside a native Home Assistant Lovelace dashboard. **Seven Lit cards** (v1.1.0) plus two legacy cards. Source in `lovelace/src/`.

#### 3.1 Card set

| Card (`custom:` type) | Source | Reads (beyond `/ws` snapshot) |
|---|---|---|
| `ecoflow-fleet-card` | `cards/fleet-card.ts` | `/api/runway`, `/api/summary/today`, `/api/forecast` — energy-flow SVG, runway, per-device grid, 24 h forecast, connection badge |
| `ecoflow-battery-card` | `cards/battery-card.ts` | `/api/degradation`, `/api/round-trip-efficiency` — thermal + per-pack vitals + degradation trend + RTE |
| `ecoflow-solar-card` | `cards/solar-card.ts` | `/api/summary/today`, `/api/forecast`, `/api/forecast/probabilistic`, `/api/clipping`, `/api/shade-report`, `/api/soiling-decomposition` — live PV, per-MPPT, probabilistic forecast, clipping/soiling/shade |
| `ecoflow-alerts-card` | `cards/alerts-card.ts` | `/api/alerts/outcome`, `/api/notify/status`, `/api/notify/test` — active/cleared alerts, predictive insights, notify controls |
| `ecoflow-strategy-card` | `cards/strategy-card.ts` | `/api/dispatch-plan` — dispatch/strategy |
| `ecoflow-insights-card` | `cards/insights-card.ts` | 15 analytics endpoints (self-consumption, thermal-events, equipment-health, shade, soiling, string-mismatch, ev-window, charge-curve, internal-resistance, forecast-skill, ambient-thermal, confidence, nws-alerts, incidents, weather/ensemble) |
| `ecoflow-circuit-card` | `cards/circuit-card.ts` | `/api/circuit/history`, `/api/history` — per-circuit history |
| `ecoflow-panel-card` (legacy) | — | 12 headline numbers |
| `ecoflow-panel-dashboard` (legacy v0.9.4) | — | Tabbed Dashboard/Battery/Forecast/Alerts |

For deep analytics not in a single card (full strategy config, per-circuit history at length), each card links out to the PWA at `:8787`.

#### 3.2 Shared per-host snapshot store

All Lit cards extend `EcoflowCardBase` (`shared/base-card.ts`) and share **one WebSocket per host** via a refcounted singleton store (`shared/snapshot-store.ts`, `getStore(host)`). Behavior:

- **Config**: each card accepts `host` (default `http://homeassistant.local:8787`), `title` (default `Power`), and `refresh_seconds` (default 30, min clamped to 10 for HTTP fetches).
- **Subscribe lifecycle**: the first subscriber opens the WS **and** fires a one-shot REST `/api/snapshot` seed (`seedFromRest`) so cards mounted before the first WS push render immediately; the seed never clobbers a snapshot already delivered by WS.
- **Reconnect**: exponential backoff `[1s, 2s, 4s, 8s, 16s, 30s]` (capped), reset to 1 s on open. `connectionState()` reports `idle | connecting | open | closed | reconnecting` for the fleet card's badge.
- **Grace teardown**: when the last subscriber leaves, the WS stays alive for `GRACE_MS = 5000` before teardown, so Lovelace tab switches / minor DOM churn don't churn the connection; the singleton is dropped only after the grace window expires with no subscribers.
- The last good snapshot is retained across a disconnect, so a card keeps showing data while "reconnecting".

#### 3.3 How cards reach the add-on over CORS

Cards run inside the HA frontend (origin e.g. `http://homeassistant.local:8123`) but fetch/WS to the add-on's own origin (`http://homeassistant.local:8787`) — a **cross-origin** request. The server's `@fastify/cors` uses `auth.corsOriginCallback`:

- A missing `Origin` (same-origin, curl, server-side) → allowed.
- Otherwise `isAllowedOrigin(origin, sameOrigins)` must pass: same-origin set, the explicit **`HA_DASHBOARD_ORIGINS`** allowlist (`http(s)://homeassistant(.local):8123` and `:8787`), or the **`LAN_ORIGIN_RE`** regex — private IPv4 ranges (`10.*`, `127.*`, `192.168.*`, `172.16–31.*`) or any `*.local` host, on ports `8123` or `8787`.
- Anything else → CORS denied (no `Access-Control-Allow-Origin`, browser blocks it).

`snapshot-store.ts` normalizes the configured `host` for both transports: `buildWsUrl` maps `http→ws`/`https→wss` (or defaults a bare `host:port` to `ws://`) + `/ws`; `buildApiUrl` maps `ws→http` (or defaults to `http://`) + the path. `shared/api.ts` provides the same `apiUrl(host, path)` / `wsUrl(host)` helpers for the REST fetches.

Read-only telemetry (snapshot/analytics) passes CORS freely; **writes** (alert outcome, notify test, chime upload) additionally require the write-auth preHandler (`requireWriteAuth`): HA-ingress + Supervisor source, same-origin, or an `X-Panel-Write-Token` header — otherwise `401`.

#### 3.4 Shared building blocks

`lovelace/src/shared/` mirrors the web app's helpers so the cards render consistently: `theme.css.ts` (theme tokens), `glossary.ts` (the same term→explanation map applied as tooltips inside the cards), `charts.ts` (inline SVG sparklines/charts — no chart library), `format.ts`/`sort.ts`/`alerts.ts`, and `primitives/` (`ef-section`, `ef-tile`, `ef-badge` Lit components). Cards refresh their HTTP-backed resources on their own `refresh_seconds` interval independent of the shared WS snapshot.

---

### Cross-cutting notes

- **One data model, three renderers.** The `FleetSnapshot` pushed over `/ws` and the `/api/*` analytics are identical across all three UIs; only the presentation differs (React tiles, ANSI SCADA frames, Lit cards).
- **Honest-null / empty-by-design.** Predictive/insight sections render nothing on a healthy fleet rather than fabricating numbers — true in the web `AdvancedInsightsCard`, the Lovelace `insights-card`, and the TUI predictive screen.
- **Ingress-relative everywhere.** The web SPA (via `baseDir()`), its service worker, and its WS all resolve correctly behind HA Ingress; the WS console's `panel_iframe` and the Lovelace cards' cross-origin fetches are explicitly accommodated by the CORS allowlist.
- **Auth asymmetry.** Reads are open (CORS-allowlisted); the telnet/`/console` TUI is unauthenticated LAN-trust; every write is gated by `requireWriteAuth` (ingress / same-origin / token).


---

## 12. Configuration, Deployment, Security & Operations

This is the operations reference for the **ecoflow-panel** Home Assistant add-on (add-on
name/`panel_title`: **"Power"**, slug: `ecoflow_panel`). It documents every configuration
option and the env var it maps to, the options→env bridge, the security posture (AppArmor,
write-auth, CORS, the write-debug lockdown), the CI + release pipeline, the ingress/port map,
and the operational runbook.

Sources of truth cited throughout:
- `ecoflow_panel/config.yaml` — add-on manifest + options + schema (currently `version: "1.27.0"`)
- `ecoflow_panel/translations/en.yaml` — per-field labels/help on the HA Configuration page
- `rootfs/etc/services.d/ecoflow-panel/run` — the s6 service runner (options→env bridge)
- `server/src/auth.ts` — write-auth gate, CORS allow-list, token bootstrap
- `server/src/ecoflow/commands.ts`, `server/src/writeLog.ts` — write-debug lockdown + audit log
- `ecoflow_panel/apparmor.txt` — the LSM confinement profile
- `.github/workflows/{ci,release,tag-release,images}.yml` — CI + release/publish pipeline
- `Dockerfile`, `build.yaml`, `repository.yaml` — image build + add-on repository manifest

---

### Add-on manifest (config.yaml top-level)

These are the non-option keys of `ecoflow_panel/config.yaml` — they define how HA Supervisor
runs the container.

| Key | Value | Meaning |
|-----|-------|---------|
| `name` | `Power` | Store display name |
| `version` | `1.27.0` | Add-on version; the **release trigger** (see Release Pipeline). HA compares this to installed to surface the Update button. |
| `slug` | `ecoflow_panel` | Stable identifier — used in the HA add-on API path (`.../addons/local_ecoflow_panel/...` for a local install, or the store slug). Never change it. |
| `arch` | `aarch64`, `amd64` | Supported CPU arches (Pi = aarch64) |
| `image` | `ghcr.io/tesseractaz/{arch}-ecoflow-panel` | **Pre-built GHCR image**; `{arch}` substituted by Supervisor. Presence of this key means Supervisor *pulls* the image rather than building on the Pi. |
| `startup` | `services` | Start in the "services" phase of HA boot |
| `boot` | `auto` | Auto-start on HA boot |
| `stage` | `experimental` | Add-on maturity stage |
| `init` | `false` | **Critical.** Disables Docker's tini so the HA base image's own s6-overlay `/init` runs as PID 1. With tini in front, `s6-overlay-suexec` refuses to start (`fatal: can only run as pid 1`) → crash loop. Do not flip to true. |
| `ports` | `8787/tcp`, `2323/tcp` | Directly-published host ports (see Port Map) |
| `ingress` | `true` | Panel appears as an HA sidebar item, authenticated through HA's session |
| `ingress_port` | `8787` | Same server/port the Supervisor reverse-proxies into |
| `panel_icon` | `mdi:home-battery` | Sidebar icon |
| `panel_title` | `Power` | Sidebar label |
| `panel_admin` | `false` | Non-admin HA users may see the sidebar panel |
| `map` | `data:rw` | `/data` volume mounted read-write (persistence) |
| `homeassistant_api` | `true` | Grants `SUPERVISOR_TOKEN` access to Core `/core/api/*` — needed for `media_player.play_media` broadcasts and entity-state reads. Without it, broadcasts fail with "SUPERVISOR_TOKEN missing or HA unreachable". |
| `hassio_api` | `true` | Grants Supervisor API access (read-only survey of installed add-ons for Piper/speaker visibility). |
| `hassio_role` | `homeassistant` | **Least-privilege (v1.7.0, CWE-250).** Downgraded from `manager`. `homeassistant` keeps Core API + the read it needs but drops add-on start/stop/reconfigure that `manager` would grant a compromised process. Bump back to `manager` only if a feature needs true add-on management. |

`repository.yaml` makes the repo installable as an HA add-on repository (name `Power`,
maintainer `tesseractAZ`). Once added under **Settings → Add-ons → Add-on Store → ⋮ →
Repositories**, HA manages updates natively via the GHCR image — no local git workflow.

---

### The options→env bridge (run script)

The HA **Configuration** tab writes an options JSON that the s6 service runner
`rootfs/etc/services.d/ecoflow-panel/run` translates into environment variables the Node
server reads. The runner is a `#!/usr/bin/with-contenv bashio` script; it `set -e`, exports
each var via `bashio::config '<KEY>'`, then `cd /app/server && exec npm start`.

#### Fixed (non-configurable) env set by the runner

These are hard-coded in `run`, not exposed as options:

```sh
PORT=8787
HOST=::                      # bind all interfaces, IPv6-capable
DB_PATH=/data/ecoflow.db
WEB_DIST_PATH=/app/web/dist
TELNET_HOST=::
```

`SUPERVISOR_TOKEN` is injected automatically by the Supervisor and inherited by the Node
process (not re-exported).

#### ★ The two boolean conventions — do not flip them

The runner emits booleans in **two different formats** depending on which env var the server
expects. This is deliberate; changing one to the other silently breaks the feature (the
server's parser only recognizes its own convention).

**Numeric `1`/`0`** — used for:
`TELNET_ENABLED`, `NOTIFY_RESOLVED`, `NWS_ENABLED`, `MQTT_DISCOVERY_ENABLED`

```sh
if bashio::config.true 'TELNET_ENABLED'; then export TELNET_ENABLED=1; else export TELNET_ENABLED=0; fi
```

**String `true`/`false`** — used for:
`BROADCAST_ENABLED`, `BROADCAST_USE_PRE_ANNOUNCE`, `CRITICAL_BREAKS_QUIET_HOURS`,
`BROADCAST_BILINGUAL`, `GRID_AVAILABLE`, `BATTERY_SOC_ALARM_ENABLED`,
`BATTERY_RUNWAY_ALARM_ENABLED`, `LOAD_SHEDDING_ADVISORY_ENABLED`

```sh
if bashio::config.true 'BROADCAST_ENABLED'; then export BROADCAST_ENABLED=true; else export BROADCAST_ENABLED=false; fi
```

All other options are exported verbatim as strings (`$(bashio::config 'KEY')`).

#### Startup guards in the runner

- **Missing credentials fail fast:** if `ECOFLOW_ACCESS_KEY` or `ECOFLOW_SECRET_KEY` is
  empty, the runner logs `bashio::log.fatal`, `sleep 30`, then `exit 1` — the sleep prevents
  HA restart-looping the fatal message off the top of the Log tab.
- **Write-debug warning:** if `WRITE_DEBUG_TOKEN` has a value, the runner logs a warning that
  `POST /api/device/send-command` is enabled.
- **Broadcast confirmation:** if `BROADCAST_ENABLED`, logs `broadcast: enabled (targets: …)`.

---

### Full config.yaml option reference

Every option is grouped by function. "Env var" is the exported name (identical to the option
key in all cases). "Schema" is the `voluptuous`-style validator from the `schema:` block; a
trailing `?` marks the field optional. Defaults are the values in the `options:` block.

#### Credentials & core (the only fields a fresh install must set)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `ECOFLOW_ACCESS_KEY` | `""` | `password` | EcoFlow IoT-Open API access key. **Required** (runner exits without it). |
| `ECOFLOW_SECRET_KEY` | `""` | `password` | EcoFlow IoT-Open API secret. **Required.** |
| `ECOFLOW_API_HOST` | `https://api-a.ecoflow.com` | `url` | EcoFlow cloud API base. Switch to `api-e.ecoflow.com` (EU) or `api-us.ecoflow.com` (US) on a `401`. |
| `LOG_LEVEL` | `info` | `list(trace\|debug\|info\|warn\|error\|fatal)` | Pino log level for the server. |

#### Site location (solar forecast only)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `FORECAST_LAT` | `33.4484` | `float(-90,90)` | Latitude for the day-ahead solar forecast (Open-Meteo). Default = Phoenix AZ. |
| `FORECAST_LON` | `-112.074` | `float(-180,180)` | Longitude for the forecast. |

#### Push notifications

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `NOTIFY_CHANNEL` | `none` | `list(none\|ntfy\|pushover\|webhook\|ha)` | Per-alert push channel. |
| `NOTIFY_MIN_SEVERITY` | `warning` | `list(warning\|critical)` | Minimum severity that triggers a push. |
| `NOTIFY_RESOLVED` | `true` | `bool` (→ `1`/`0`) | Also send a push when an alert clears. |
| `NOTIFY_NTFY_SERVER` | `https://ntfy.sh` | `str?` | ntfy server base. **`str?` not `url?` on purpose** — HA's `url?` rejects an empty default at Save; the runtime validates at send time. Do not "tidy" to `url?`. |
| `NOTIFY_NTFY_TOPIC` | `""` | `str?` | ntfy topic. |
| `NOTIFY_PUSHOVER_TOKEN` | `""` | `password?` | Pushover application token. |
| `NOTIFY_PUSHOVER_USER` | `""` | `password?` | Pushover user/group key. |
| `NOTIFY_WEBHOOK_URL` | `""` | `str?` | Generic webhook URL (same `str?` rationale as ntfy). |
| `NOTIFY_QUIET_HOURS` | `"22-06"` | `str?` | Quiet window `HH-HH`; pushes gated to the digest (see below). |
| `NOTIFY_DIGEST_HOUR` | `7` | `int(0,23)?` | Hour the morning digest of quiet-hours-suppressed alerts is sent. |

#### Audible broadcast (spoken alarms + chimes over HA media_player speakers)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `BROADCAST_ENABLED` | `false` | `bool` (→ `true`/`false`) | Master enable for audible broadcast. |
| `BROADCAST_TARGETS` | `""` | `str?` | Comma/JSON list of Music-Assistant-driven `media_player` targets. |
| `BROADCAST_SIP_TARGETS` | `""` | `str?` | (v1.25.0) Second list of announce-only targets (e.g. the Switchboard cordless) that get alarms via `media_player.play_media(announce)` instead of Music Assistant. |
| `BROADCAST_MIN_SEVERITY` | `critical` | `list(critical\|warning)` | Minimum severity for an audible broadcast. |
| `BROADCAST_QUIET_HOURS` | `"22-06"` | `str?` | Quiet window for audible alarms. |
| `CRITICAL_BREAKS_QUIET_HOURS` | `false` | `bool` (→ `true`/`false`) | (v0.23.0) When true, criticals break through quiet hours for both push and audible. Default false ⇒ quiet hours silence every tier (alert still shows on-screen + morning digest). Shared by alertMonitor (push) and broadcast (audible). |
| `BROADCAST_AUDIO_BASE` | `http://homeassistant.local:8787` | `str?` | Base URL speakers fetch klaxon/announcement WAVs from. |
| `BROADCAST_VOLUME` | `0.5` | `float(0,1)` | Broadcast (chime) volume. |
| `BROADCAST_CHIME_PACK` | `powerplant` | `list(powerplant\|airport)?` | Built-in chime sound pack. |
| `BROADCAST_ANNOUNCE_VOLUME` | `""` | `str?` | Optional separate volume for the spoken announcement. |
| `BROADCAST_USE_PRE_ANNOUNCE` | `false` | `bool` (→ `true`/`false`) | Play the platform pre-announce tone before the message. |
| `BROADCAST_LEAD_SILENCE_MS` | `1000` | `int(0,5000)?` | Lead-in silence; MA 2.9's faster AirPlay RAOP start needs it to avoid clipping the chime start. |
| `BROADCAST_REPEAT` | `2` | `int(1,3)?` | How many times to repeat the announcement. |
| `BROADCAST_REPEAT_GAP_MS` | `1500` | `int(0,5000)?` | Gap between repeats. |
| `BROADCAST_CHIME_GAP_MS` | `1000` | `int(0,5000)?` | Gap between chime and speech. |
| `BROADCAST_ANNOUNCE_RETRIES` | `1` | `int(0,3)?` | Retries if the announce call fails. |
| `BROADCAST_WYOMING_HOST` | `core-piper` | `str?` | Wyoming/Piper TTS host. |
| `BROADCAST_WYOMING_PORT` | `10200` | `port` | Wyoming TTS port. |
| `BROADCAST_WYOMING_VOICE` | `""` | `str?` | Piper voice (English). |
| `BROADCAST_BILINGUAL` | `true` | `bool` (→ `true`/`false`) | (v0.62.0) Second announcement pass in Spanish after English. |
| `BROADCAST_WYOMING_VOICE_ES` | `""` | `str?` | Piper voice for the Spanish pass. |

> Note: `BROADCAST_LEAD_SILENCE_MS`, `BROADCAST_CHIME_GAP_MS`, `CRITICAL_BREAKS_QUIET_HOURS`,
> `BATTERY_SOC_ALARM_ENABLED`, and `BATTERY_RUNWAY_ALARM_ENABLED` were all declared in
> config.yaml but **not exported** by the runner before v0.23.0 — the HA knobs were dead and
> the server used its code defaults. They are wired now. If adding a new option, remember it
> is dead until the runner exports it.

#### Battery & grid alarms

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `BATTERY_SOC_ALARM_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the state-of-charge alarm engine. |
| `BATTERY_RUNWAY_ALARM_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the runway (time-to-reserve) alarm. |
| `BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN` | `60` | `int(5,720)?` | Minutes between re-announcements of an active runway alarm. |
| `GRID_AVAILABLE` | `false` | `bool` (→ `true`/`false`) | (v0.15.2) Must be `false` for an islanded/off-grid site — drives off-grid honesty + the grid-aware floor. |
| `GRID_PRESENCE_ENTITY` | `""` | `str?` | (v0.23.0) HA entity reporting real grid presence (grid-aware floor re-escalation). |
| `HOST_POWER_ENTITY` | `""` | `str?` | (v1.6.0) HA `binary_sensor` (device_class=problem) reporting the Pi's kernel under-voltage flag. When set, the alarm engine warns on a browning-out host before it goes dark. Empty = dormant. |

#### Load-shedding advisor (read + advise only; never actuates)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `LOAD_SHEDDING_ADVISORY_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the advisory engine (HA automations do the actual actuation). |
| `LOAD_SHEDDING_SHED_ENTITIES` | `""` | `str?` | Entities the advisor recommends shedding. |
| `LOAD_SHEDDING_RUNWAY_THRESHOLD_H` | `4.0` | `float(0,168)` | Runway (hours) below which the advisor recommends shedding. |
| `LOAD_SHEDDING_RESTORE_MARGIN_H` | `2.0` | `float(0,168)` | Runway margin (hours) above threshold before it recommends restoring. |

#### Integrations (opt-in): NWS storm alerts + MQTT auto-discovery

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `NWS_ENABLED` | `false` | `bool` (→ `1`/`0`) | (v0.7.5) US-only NWS storm-preparedness alerts. |
| `MQTT_DISCOVERY_ENABLED` | `false` | `bool` (→ `1`/`0`) | (v0.7.5) Publish HA MQTT-discovery sensors. |
| `MQTT_DISCOVERY_HOST` | `""` | `str?` | MQTT broker host. |
| `MQTT_DISCOVERY_PORT` | `1883` | `port` | MQTT broker port. |
| `MQTT_DISCOVERY_USER` | `""` | `str?` | MQTT username. |
| `MQTT_DISCOVERY_PASS` | `""` | `password?` | MQTT password. |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | `str?` | MQTT discovery topic prefix. |

#### Telnet control-room TUI (LAN-only, unauthenticated)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `TELNET_ENABLED` | `false` | `bool` (→ `1`/`0`) | (v1.7.0, security #5, CWE-1188) **Default OFF.** An unauthenticated control-plane on the LAN shouldn't be on by default. Existing installs keep their saved value on upgrade. |
| `TELNET_PORT` | `2323` | `port` | Telnet TUI port. |
| `TUI_USERNAME` | empty | `str?` | Console login username (defaults to `operator` when empty and a password is set). |
| `TUI_PASSWORD` | empty | `password?` | Console login password; empty disables the login prompt. Masked in the options UI. |

#### Diagnostic / advanced

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `ECOFLOW_DEVICE_REACHABILITY` | `""` | `str?` | (v0.72.0) SN→HA-ping-entity JSON map for cloud-wedge vs real-outage detection. |
| `WRITE_DEBUG_TOKEN` | `""` | `password?` | (v0.9.9) When non-empty, unlocks `POST /api/device/send-command`. Default empty = the debug write path is disabled. See Security. |

---

### Security posture

The design principle: **read endpoints are open; every write is gated.** Read endpoints
(snapshot, history, forecast, Lovelace card data) are unauthenticated by design because
Lovelace cards fetch them cross-origin. Writes require one of three credentials, plus an
extra lockdown on the raw device-command path. Defense-in-depth is layered on top with an
AppArmor profile.

#### Write-auth gate (`requireWriteAuth`, `server/src/auth.ts`)

Built by `createAuth({ host, port, log })` at boot. Applied as a Fastify `preHandler` on
every POST/PUT/DELETE route and on admin GETs (audit log, add-on listing, media-player
discovery). A request is accepted if **any** of three conditions hold:

1. **HA Ingress** — `req.headers['x-ingress-path']` is present **AND** `isSupervisorSource(req.ip)`
   is true. The header alone is forgeable from the directly-published `:8787` LAN port, so the
   TCP peer is additionally pinned to the Supervisor network `172.30.32.0/23`
   (regex `^172\.30\.3[23]\.\d{1,3}$`, IPv4-mapped-IPv6 normalized). `req.ip` is the raw,
   unspoofable socket peer because Fastify runs with **trustProxy OFF** — so a client-supplied
   `X-Forwarded-For` cannot fake it. **Both** conditions must hold, closing the LAN-forge bypass.
2. **Same-origin** — `req.headers.origin` is in the same-origin allow-list built by
   `buildSameOrigins(host, port)`: `http(s)://{host}:{port}`, `http(s)://homeassistant.local:{port}`,
   `http(s)://localhost:{port}`, `http(s)://127.0.0.1:{port}`.
3. **Explicit token** — `req.headers['x-panel-write-token']` equals the bootstrap token
   (constant-time compare via `tokenEquals`, which does a length-independent `timingSafeEqual`
   even on length mismatch to avoid leaking token length by timing).

Otherwise returns `401 {"error":"write-auth-required", "hint":"set X-Panel-Write-Token header or use HA ingress"}`.

#### Write token bootstrap (`loadOrCreateWriteToken`)

- Reads `PANEL_WRITE_TOKEN` from env if present and ≥16 chars.
- Otherwise reads `/data/panel-write-token.txt` (path = `resolve(dataDir, 'panel-write-token.txt')`,
  `dataDir` defaults to `DATA_DIR` env or `/data`).
- If absent/unreadable/too short, generates a fresh `randomUUID()` and persists it
  **mode-0600** (`writeFileSync(..., {mode:0o600})` + a best-effort `chmodSync(0o600)`).
- TOCTOU-hardened (CodeQL `js/file-system-race`): reads directly and catches ENOENT rather
  than `exists→read→write`.
- **Rotate the token** by deleting `/data/panel-write-token.txt` and restarting the add-on.

#### CORS allow-list (`corsOriginCallback` / `isAllowedOrigin`)

`@fastify/cors` is registered with the callback form. Same-origin requests (no `Origin`
header, curl, server-side) pass. Cross-origin requests pass only if the origin is:
- in the same-origin set, **or**
- in `HA_DASHBOARD_ORIGINS` (`homeassistant.local` / `homeassistant` on `:8123` and `:8787`), **or**
- matched by `LAN_ORIGIN_RE`: RFC1918 ranges (`10.x`, `127.x`, `192.168.x`, `172.16–31.x`) or
  `*.local`, **on ports 8123 or 8787 only**.

Anything else gets no `Access-Control-Allow-Origin` header and the browser blocks the JS from
reading the response.

#### Write-debug lockdown — `POST /api/device/send-command`

The raw-command debug path is the most dangerous endpoint (arbitrary EcoFlow commands). It is
gated by **five** layers (`server/src/index.ts`, `server/src/ecoflow/commands.ts`):

1. `requireWriteAuth` preHandler (ingress / same-origin / token).
2. **Feature flag** — `isWriteDebugEnabled()` returns false unless `WRITE_DEBUG_TOKEN` env is
   non-empty; otherwise `403 {"error":"write-debug disabled (set WRITE_DEBUG_TOKEN env to enable)"}`.
3. **Second token** — the request must carry header `x-write-debug-token` matching
   `WRITE_DEBUG_TOKEN` via constant-time compare (`checkWriteDebugToken`); else `401`.
4. **cmdSet allow-list** — `cmdSet`/`cmdCode` must match `ALLOWED_CMD_SETS`:
   `PD303_APP_SET` (SHP2 exact), `WN511_PORTABLE_` / `WN511_BLE_FUNC_` (DPU-family prefixes).
   Rejections are audit-logged and return `400 cmdSet-not-allowlisted`.
5. **Params shape guard** (`paramsObjectOk`) — must be a non-array object, max depth 5, max 100
   total keys, max 1 KB serialized; plus a **per-SN cooldown** `SEND_CMD_COOLDOWN_MS`
   (env, default `30000` ms) returning `429` while cooling down.

The non-debug write (`POST /api/device/refresh-cloud/:sn`) is a true no-op cloud-presence
refresh (re-sends the current `backupReserveSoc`) with its own `REFRESH_COOLDOWN_MS = 30_000`
per-SN cooldown (`commands.ts`).

#### Audit log (`server/src/writeLog.ts`)

Every write action is appended as JSON Lines to `/data/writes.log` (path override:
`WRITE_LOG_PATH` env, default sibling-of-DB). Each row:
`{ ts, action, sn, params, source:{ip,ua}, outcome, code, message, durationMs }`.
Content is re-serialized through an explicit typed shape (`sanitizeWriteLogEntry`) — known
fields only, finite-coerced numbers, control-stripped/length-bounded strings (CodeQL
`js/http-to-file-access`); the path itself is a fixed constant, never request-influenced.
`GET /api/writes/log?limit=N` (default 50, clamped 1–500) tails it, re-reading at most
256 KiB — and is itself behind `requireWriteAuth` because it can leak source IPs and attempted
command shapes.

#### In-process rate limiting

`makeRateLimiter(max, windowMs)` — a dependency-free fixed-window limiter returning `429`
when exceeded. `chimeWriteRateLimit = makeRateLimiter(30, 60_000)` guards the chime
upload/delete/config write routes (bounds CPU for WAV normalization + disk churn; addresses
CodeQL `js/missing-rate-limiting`). WebSocket inbound frames are capped at `maxPayload = 64 KiB`.

#### AppArmor profile (`ecoflow_panel/apparmor.txt`)

Loaded by Supervisor as the container's LSM profile (`profile addon_ecoflow_panel`). It bumps
the HA security rating and confines the process even if a Fastify endpoint is exploited.

- **Capabilities allowed:** `net_bind_service`, `setuid`, `setgid`, `chown`, `dac_override`,
  `dac_read_search`, `fowner`, `fsetid`, `kill`, `sys_chroot` (the s6 user-switching dance).
- **Capabilities explicitly denied:** `sys_admin`, `sys_module`, `sys_rawio`, `sys_ptrace`,
  `sys_boot`, `sys_time`, `mac_admin`, `mac_override`.
- **Denied file ops:** reading `/etc/shadow`, `/etc/gshadow`, `/root/**`, `/home/**`,
  `/etc/ssh/**`; writing `/proc/sys/**`, `/sys/**`, `/proc/sysrq-trigger`; mount/umount/
  pivot_root/remount; ptrace.
- `/data/**` is `rwk` (SQLite WAL/shm need `k`); `/tmp`, `/var/tmp`, `/run` are `rwk`.

★ Two hard-won footguns baked into the profile comments (do not "clean up"):

1. **KEEP the blanket `file,` rule.** v1.7.0 replaced it with a per-path allow-list that had
   `/init ix` (execute only), but s6-overlay **re-opens `/init` for READING** during
   shutdown/restart → `/bin/sh: can't open '/init': Permission denied` crash-loop → whole
   add-on (and alarm) down. Reverted v1.7.1. v1.7.2 instead keeps `file,` (so no read/exec can
   ever be denied) and layers **write-immutability** deny rules on the code/binary/lib dirs
   (`deny /app|/usr|/bin|/sbin|/lib|/lib64|/init … wl`) — closing the dominant CWE-732
   persistence vector without any read-denial risk.
2. **★★ The write-mask is `wl`, NOT `wal`.** The append bit `a` and write bit `w` are mutually
   exclusive in a single rule on the stricter apparmor parser HAOS ships on **kernel 6.18**.
   v1.7.2–v1.9.0 shipped `wal`, which parsed on the old feature set but the compiled result was
   cached; a host reboot into the new feature set forced a fresh compile that rejected `wal`
   (`Conflict 'a' and 'w' perms are mutually exclusive`) → profile failed to load → container
   couldn't start → **whole alarm DOWN** until hot-patched (v1.9.1 fix). **Never combine `a`
   with `w`; validate any mask change with `apparmor_parser -T -Q` (fresh, cache-skipping)
   before shipping.**

Diagnostic note: after a profile change, denied ops log to `/var/log/audit/audit.log` on the
host (Pi) as `type=AVC`.

#### Image signing / rating ceiling

CodeNotary (`vcn`) image signing was set up in v0.9.45–47 then **removed** in v0.9.48: the OSS
`vcn` project is dead (repo 404, amd64-only image SIGSEGVs under QEMU, native binaries gone),
and HA's own addons repo dropped it too. Net: the security-rating ceiling for this add-on is
**~7** (with the v0.9.44 AppArmor profile), not 8. `CN_USER`/`CN_PASSWORD` repo secrets are
unreferenced and harmless.

---

### Port & ingress map

| Port | Protocol | Purpose | Auth |
|------|----------|---------|------|
| `8787/tcp` | HTTP | Web dashboard + REST API + WebSocket (`/ws`) | Reads open; writes via `requireWriteAuth`. Also the `ingress_port`. |
| `2323/tcp` | Telnet | "Control-room" TUI | **None** — keep on a trusted LAN; default OFF (`TELNET_ENABLED=false`). |

**Ingress:** with `ingress: true` / `ingress_port: 8787`, the Supervisor reverse-proxies the
same server into the HA sidebar ("Power"), authenticated by HA's session (visible in the HA
mobile app). Ingress traffic carries `X-Ingress-Path` and originates from `172.30.32.0/23`, so
it satisfies `requireWriteAuth` condition #1 automatically. Direct LAN access on `:8787` still
works in parallel.

---

### Container build (Dockerfile)

3-stage build:
1. **webbuilder** (`node:22-alpine`) — `npm ci` + `npm run build` the React web UI.
2. **serverdeps** (`node:22-alpine`) — `npm ci` the server deps (`tsx` is a runtime dep, not
   just dev — the server runs TS directly).
3. **runtime** (`FROM ${BUILD_FROM}` — the HA Alpine+s6+bashio base) — `apk add nodejs npm
   ca-certificates tzdata`, copy `server/`, the built `web/dist`, the prebuilt `lovelace/dist`,
   and `rootfs/` (the s6 service). `chmod a+x` the run script. `EXPOSE 8787 2323`.

Runtime ENV baked in: `NODE_ENV=production`, `PORT=8787`, `HOST=0.0.0.0`, `DB_PATH=/data/ecoflow.db`,
`WEB_DIST_PATH=/app/web/dist`. Build metadata (`BUILD_VERSION`, `BUILD_DATE`, `BUILD_REF`) is
promoted from ARG to ENV (v0.14.0) so `/api/version` reports the real release instead of "dev".

**Base image is digest-pinned** in three files that must stay in lockstep (v1.7.2, CWE-1357):
`build.yaml`, `.github/workflows/ci.yml`, `.github/workflows/images.yml` — all reference
`ghcr.io/home-assistant/{arch}-base:3.21@sha256:…`. Update the digest deliberately on a base bump.

---

### Release & publish pipeline

The release is driven by a **`version:` bump in `config.yaml`** landing on `main`. The `main`
branch is governed by the `BranchAuth` ruleset (PR + verified signatures + CodeQL), so no
workflow pushes to `main` directly — everything goes through an auto-merging PR whose
squash-commit is GitHub-web-flow-signed.

#### Step 1 — `release.yml` (manual dispatch)

Trigger from **Actions → Release → Run workflow**. Inputs: `bump` (patch/minor/major, default
patch), `version` (explicit override), `notes` (markdown; auto-generated from the commit log
since the previous tag if empty). It:
1. Parses the current `version:` from `config.yaml`; computes the next semver (refuses if
   `vX.Y.Z` tag already exists — idempotent).
2. Builds release notes.
3. `sed`-bumps `version:` in `ecoflow_panel/config.yaml` and prepends a
   `## <version> — <date>` section to `ecoflow_panel/CHANGELOG.md`.
4. Opens PR `release/vX.Y.Z` → `main` with commit subject **`Release vX.Y.Z`** and enables
   `--squash --auto --delete-branch`. (The branch commit is unsigned; only the signed squash
   commit lands on main.)

#### Step 2 — CI checks gate the PR

`ci.yml` runs on every push/PR to `main`:
- **`typecheck` (matrix: server, web)** — `npm ci` + `tsc --noEmit` → **2 checks**.
- **`docker-smoke`** — buildx amd64-only Dockerfile build (`push:false`) → **1 check**.

`images.yml`'s `test` job (`npm test` + `tsc --noEmit` on the server) runs post-tag, not as a
PR gate. CodeQL is enforced via the repo's GHAS ruleset (not a workflow file in this repo).

#### Step 3 — `tag-release.yml` (post-merge)

Triggers on `push` to `main` touching `ecoflow_panel/config.yaml`, **gated by
`if: startsWith(github.event.head_commit.message, 'Release v')`**. So the squash-merge subject
**must start with `Release v`** — this is why `release.yml` titles the PR/commit `Release vX.Y.Z`.
It parses the version, creates an annotated tag `vX.Y.Z` (idempotent — skips if the tag exists),
pushes it, then **`gh workflow run images.yml -f version=X.Y.Z`**. (A tag pushed with the default
`GITHUB_TOKEN` won't trigger other workflows due to GitHub's recursion guard, so it dispatches
`images.yml` explicitly.) Permissions: `contents: write`, `actions: write`.

#### Step 4 — `images.yml` (build + publish + release)

Triggers on `v[0-9]+.[0-9]+.[0-9]+` tag push, or manual `workflow_dispatch` with a `version`
input. Jobs:
1. **resolve** — validate/normalize the version.
2. **test** — checkout the tag, `npm ci`, `npm test`, `tsc --noEmit` on the server.
3. **build** (matrix aarch64 + amd64, each on its **native** runner: `ubuntu-24.04-arm` /
   `ubuntu-24.04` — no QEMU emulation, ~3 min vs 30–60 min) — buildx build + push to
   `ghcr.io/<owner>/{arch}-ecoflow-panel` as both `:{version}` and `:latest`. Base images
   digest-pinned. GHA cache uses `ignore-error=true` so a flaky cache backend can't fail a release.
4. **release** — extract the version's `CHANGELOG.md` section and `gh release create` the
   GitHub Release (skipped if it already exists). **The Release appearing = "go ahead and update the Pi."**
   Permissions: `contents: write`, `packages: write`.

First-time-only: toggle the two new GHCR packages from Private → Public so HA can pull anonymously.

#### Step 5 — deploy to the Pi

Because `config.yaml`'s `image:` key points at GHCR, HA Supervisor **pulls** the prebuilt
multi-arch image — it does **not** build on the Pi. Once the GitHub Release is out, in HA:
**Settings → Add-ons → Add-on Store → ⋮ → Check for updates**, open **Power**, click **Update**
(HA reads the bumped `version:` from `config.yaml` on `main` and drives the update-entity).

> Per the project's standing memory: for ecoflow-panel, always merge the release PR with a
> subject that **starts `Release vX.Y.Z`** (the `tag-release.yml` gate) — never `Release v` +
> something that doesn't parse. If the bot reviewer (Codex/Copilot) is down, proceed with
> admin-merge + deploy; green tests + adversarial review are the gate.

---

### Operational runbook basics

#### Persistence — what lives in `/data`

`/data` is the `data:rw`-mapped volume; it survives restarts/updates. Key files:
- `ecoflow.db` — SQLite recorder (WAL mode → `.db-wal`/`.db-shm`).
- `panel-write-token.txt` — mode-0600 write token.
- `writes.log` — JSONL audit log.
- `audio/` — startup-generated klaxon WAVs (served at `/audio/*`).
- `audio-render/` — on-demand rendered klaxon+TTS announcements (served at `/audio-render/*`, `wildcard:true`).
- Operator-uploaded chimes dir (served at `/chimes/*`).

#### First-run setup

1. Set `ECOFLOW_ACCESS_KEY` + `ECOFLOW_SECRET_KEY` in the **Configuration** tab → Save → Restart
   (the runner exits without them). Set `FORECAST_LAT`/`LON` if not Phoenix.
2. Devices populate from the REST poll within ~15–60 s (MQTT warms up after).

#### Common failure modes (from DOCS.md + memory)

- **"Missing required env var: ECOFLOW_ACCESS_KEY"** — set the key, Save, Restart.
- **`401` from `api-a.ecoflow.com`** — switch `ECOFLOW_API_HOST` to `api-e` (EU) / `api-us` (US).
- **Dashboard loads but no devices** — check the Log tab; the REST poll fills the snapshot in 15–60 s.
- **Telnet refuses connection** — confirm `TELNET_ENABLED` is on and `:2323` is exposed in the Network tab.
- **PV forecast "no history yet"** — the learned solar model needs a handful of clear-sky
  daylight hours of recorded PV first; give it a day.
- **AppArmor profile change → container won't start / alarm dark** — a bad mask (e.g. `wal`) or a
  denial in the s6 init trees fails the profile compile; check `/var/log/audit/audit.log`
  (`type=AVC`) on the Pi, and validate with `apparmor_parser -T -Q`. `/command` + `/package`
  (s6 PID1 trees) are intentionally left `rwix` — a mistaken denial there is an *invisible* init
  crash-loop, so tightening them requires a host audit-log boot-test (deferred).
- **Errored add-on after a bad boot** — needs an explicit `/restart` (per the apparmor-init memory).
- **★ Physical power to the Pi:** the Pi's circuit has been observed losing power for
  84–187 min/day → the alarm goes dark with no self-alert. The monitor must be on an always-on
  circuit. `HOST_POWER_ENTITY` (a `binary_sensor` device_class=problem) can warn on a
  browning-out host before it goes fully dark.

#### Rotating secrets

- **Write token:** delete `/data/panel-write-token.txt`, restart. A fresh UUID is generated.
- **Write-debug path:** clear `WRITE_DEBUG_TOKEN` in Configuration to disable
  `POST /api/device/send-command` entirely (default state).


---

## 13. Safety & Operational Plumbing

### 13.0 Alarm-host thermal monitor (v1.42.0)

The add-on monitors the machine it runs on. `hostThermal.ts` samples the kernel thermal zones (`/sys/class/thermal/thermal_zone*/temp`, read-only in the container) every 60 s, takes the hottest valid zone (readings outside 5–130 °C are rejected), and holds the freshest sample with a 5-minute staleness bound. Surfaces:

- `host_soc_temp_c` in `/api/ha-state` and the MQTT state payload; discovery sensor `ecoflow_host_soc_temp` (`device_class: temperature`, diagnostic). Trend history comes from the Home Assistant recorder — the add-on stores none.
- Alerts `host-temp-warn` (warning, ≥ `HOST_TEMP_WARN_C`, default 78 °C) and `host-temp-crit` (critical, ≥ `HOST_TEMP_CRIT_C`, default 84 °C), with 3 °C rise/clear hysteresis (`hostTempLevel`, pure). The critical sits just below the host SoC's ~85 °C throttle point: thermal throttling slows the alarm pipeline precisely when extreme ambient heat makes it matter most.
- Null-honest: a host with no readable thermal zone produces a null sensor and no alerts. Thresholds are env-overridable (`HOST_TEMP_WARN_C`, `HOST_TEMP_CRIT_C`), not add-on options.

### 13.0b Co-tenant degradation defense — self-vitals (v1.43.0)

The alarm shares its host with other add-ons; a co-tenant failure (memory leak, CPU spin, disk fill) degrades the alarm indirectly. `selfVitals.ts` provides in-band early warning across four dimensions, each null-honest when its source is unreadable:

| Dimension | Source | Warn / Crit (env-overridable) |
|---|---|---|
| Event-loop lag | 500 ms drift probe, EMA α=0.2 + 60 s max | ≥ 200 ms / ≥ 1000 ms EMA (`VITALS_LAG_*_MS`) |
| Memory available | `/proc/meminfo` MemAvailable | < 700 MB / < 350 MB (`VITALS_MEM_*_MB`) |
| Data-disk free | `statfs` on the data directory | < 2048 MB / < 512 MB (`VITALS_DISK_*_MB`) |
| Load (1 min) | `/proc/loadavg` | ≥ 3.5 / ≥ 6 (`VITALS_LOAD_*`, 4-core host) |

`assessVitals` (pure) applies per-dimension hysteresis — escalation immediate, de-escalation only past a clearance margin — and rolls the maximum into one assessment. Surfaces: four HA diagnostic sensors (`ecoflow_host_evloop_lag`, `ecoflow_host_mem_available`, `ecoflow_host_disk_free`, `ecoflow_host_load_1m`), `vitalsLevel` on `/api/health`, and ONE rolled alert (`host-pressure-warn`/`host-pressure-crit`) whose detail names every pressured dimension with its value — a starved host is one operator situation, not four alert families. Under a critical assessment, **alarm-first QoS** pauses discretionary analytics ticks (rest tracker, GHI persistence) so the process's remaining CPU serves the poll → alert → broadcast path; the alert states that this shedding is active.

**Crit dwell (v1.45.0).** The critical alert (and the red broadcast it raises)
requires the crit assessment to sustain for `HOST_PRESSURE_CRIT_DWELL_S`
(default 180 s, range 0–900) — observed transient spikes (boot load, store
refresh, the nightly backup's docker exports) each last 1–3 minutes and are
real pressure but not red-klaxon events. During the dwell the condition
surfaces as the warning; QoS shedding keys on the raw assessment level and
engages immediately regardless.

### 13.0c Out-of-band dead-man heartbeat (v1.43.0)

In-band self-monitoring fails with the host, so the final layer lives outside the failure domain: `heartbeat.ts` sends an HTTPS GET to an operator-configured external heartbeat receiver (`HEARTBEAT_URL`, healthchecks.io-style) every `HEARTBEAT_INTERVAL_S` (60–3600 s, default 300, ±10 % jitter), starting at boot. When the pings stop — host dead, container OOM-killed, kernel wedged, power lost — the external service notifies the operator from outside the house. Properties: fully inert when no URL is configured; https-only; the URL is treated as a capability token and never logged (only its host, once, on rejection); state-transition-only logging; a send failure is local information only (internet-down ≠ host-down — the external service's own grace period makes the dead-man decision), so the module raises no alerts and only reports `heartbeatStatus()` on `/api/health`. Recommended external configuration: check period = the configured interval, grace ≈ 2 intervals.

*Process guard, host-power self-monitor, HA state cache, onset persistence, message-rate floor, and log/format hygiene — the reliability layer that keeps a life-safety monitor alive and honest.*

This cluster is not a feature the operator sees on a screen. It is the connective tissue that lets every other engine survive the real-world failure modes of an off-grid Raspberry Pi: a daily Supervisor maintenance bounce, a Pi that loses power almost every day, an EcoFlow cloud session that wedges without going fully silent, and a log stream that floods during outages. Three of these modules (`processGuard`, `hostPower`, `messageRateFloor`) are load-bearing safety components — a bug in them can either kill the alarm or blind it. The rest bound what lands on disk and in the log so a real signal stays greppable and a hostile device name can't hijack the operator's terminal.

All file paths below are relative to `server/src/`. Line numbers cite the code as read at documentation time.

---

### 1. `processGuard.ts` — top-level crash survival (SAFETY-CRITICAL)

#### What + why

The add-on once crashed with `exit code 255` during the daily 13:00 Supervisor maintenance window (a CoreDNS plugin restart + AppArmor reload). A transient DNS/network bounce leaked out of the MQTT reconnect path as an uncaught error and killed a **critical** power monitor for ~2 minutes. `processGuard` installs the process-level `uncaughtException` / `unhandledRejection` handlers that decide, per error, whether to **survive** (a transient network/DNS blip that must not take the alarm down) or **re-raise as fatal** (a genuine bug we must never silently swallow).

The animating principle: a life-safety process should not die from the network sneezing, but it also must not become a zombie that has quietly eaten a real crash.

#### Inputs

- The thrown error / rejection reason (`unknown`).
- A logger with `error` and `fatal` sinks.
- An optional `onFatal` sink (tests inject a non-exiting one; production defaults to `process.exit(1)`).

#### The classification (real algorithm)

```
classifyTopLevelError(e):
    return isTransientNetworkError(e) ? 'survive' : 'fatal'
```

`isTransientNetworkError` (shared with the MQTT cert-fetch retry in `ecoflow/mqtt.ts:53`) matches on two axes:

| Axis | Pattern |
|------|---------|
| `e.code` | `/EAI_AGAIN\|ENOTFOUND\|ECONNREFUSED\|ETIMEDOUT/i` |
| `e.message` (lowercased) | `/eai_again\|enotfound\|econnrefused\|etimedout\|timeout\|connect timeout\|fetch failed/i` |

A match on **either** axis ⇒ transient ⇒ survive. Everything else ⇒ fatal.

> **Deliberate narrowing (v0.60.0):** the classifier used to also match a bare `network` token in the message. That was dropped because it matched *any* string containing "network" (e.g. `"neural network training failed"`). Harmless when the classifier only gated an MQTT retry, but dangerous now that it is *also* the process-guard's survive/fatal gate — an over-broad match could **mask a genuine bug**. The specific terms still cover every real transient case, which also carry a `code`.

#### The handler body

`handleTopLevelError(e, kind, log, onFatal)`:

1. Compute `decision = classifyTopLevelError(e)`.
2. Extract `detail = e.stack ?? e.message ?? String(e)`.
3. If `survive`: log **loudly** at ERROR with the greppable prefix
   `process-guard: SURVIVED transient <kind> (network/DNS, not exiting): <detail>`
   and return — the process keeps running. The line is intentionally noisy so a *misclassified recurring* fault (something that keeps "surviving" but is actually broken) is still findable by grep.
4. If `fatal`: log at FATAL `process-guard: FATAL <kind>, exiting: <detail>` and call `onFatal(e)`.

`installProcessGuards(log, opts?)` wires both `process.on('uncaughtException', …)` and `process.on('unhandledRejection', …)` to that body. `onFatal` defaults to `() => process.exit(1)`.

#### Trace / wire-in

Installed once at startup in **`index.ts:2872`**:

```ts
installProcessGuards({
  error: (m) => app.log.error(m),
  fatal: (m) => app.log.fatal(m),
});
```

It covers the **post-boot steady state**, where a transient DNS error can escape the MQTT client's reconnect path as an unhandled rejection. Boot-time DNS transients are handled separately by the cert-fetch retry (`getMqttCertificationWithRetry`), and a genuine boot-time crash is correctly left fatal.

#### Edge cases / guards

- **Pure + exported.** `classifyTopLevelError` and `handleTopLevelError` take injected logger + `onFatal`, so both are unit-tested without registering real process listeners or exiting the test runner.
- **Shared classifier.** Reusing `isTransientNetworkError` keeps the guard and the MQTT retry from drifting apart on what counts as "transient."
- **Never silent.** A survived error is *always* logged at ERROR — surviving is not the same as ignoring.

---

### 2. `hostPower.ts` — Pi under-voltage self-monitor (SAFETY-CRITICAL)

#### What + why

The alarm's own host — the Raspberry Pi — is the single point of failure for the entire monitor: if it loses power, every channel goes dark **at once**. HA's *"Raspberry Pi Power Supply Checker"* exposes the kernel under-voltage/throttling flag as a `binary_sensor` with `device_class: problem` (`on` = under-voltage/throttling detected, `off` = OK). A marginal supply — or a sagging power circuit — trips this flag *before* the Pi actually browns out, so surfacing it is an early warning to fix the supply while the alarm is still up. (Per operational memory, the Pi circuit has historically lost power daily for 84–187 min; this signal is the leading indicator for that class of failure.)

#### Inputs

- `HOST_POWER_ENTITY` env var — the configured binary_sensor entity id. Empty ⇒ the feature is dormant.
- The shared HA state cache (`haStateCache`), which `index.ts` keeps warm whenever a host/grid entity is configured.

#### Key constant

```
HOST_POWER_MAX_AGE_MS = 120_000   // 2 min
```

Chosen comfortably above the ~30 s cache TTL. Beyond 2 min the cached read is treated as stale and reported as **unknown** rather than replaying a frozen last value.

#### The interpretation (pure)

```
interpretHostPowerEntity(e):
    if e is null                        → null
    s = lowercase(e.state)
    if s in {on, true, problem}         → true    (under-voltage present)
    if s in {off, false, ok}            → false   (OK)
    otherwise (unavailable/unknown/…)   → null
```

#### The live wrapper

`liveHostPower(now = Date.now())` returns a `HostPowerHealth`:

```
if !entityId                        → { configured:false, entityId:'', underVoltage:null, stale:false }
if cacheAge > HOST_POWER_MAX_AGE_MS → { configured:true, entityId, underVoltage:null, stale:true }
else                                → { configured:true, entityId,
                                        underVoltage: interpretHostPowerEntity(getCachedEntity(entityId)),
                                        stale:false }
```

#### Trace / wire-in

- **Cache warm-keeping:** `index.ts:1981` and `:2056` call `haStateCache.refreshIfStale()` whenever `gridPresenceEntityId() || hostPowerEntityId()` is set — the host-power entity rides the same TTL-gated refresh as the grid-presence classifier (ingestion mirrors `gridState.ts`).
- **Alert emission:** `alerts.ts:349` calls `liveHostPower()`; when `underVoltage === true` it pushes a **warning** alert `host-power-undervoltage` (category `Connectivity`, device `System`) advising the operator to check the Pi's supply and circuit before it browns out.

#### Output shape (the alert)

```json
{ "id": "host-power-undervoltage", "severity": "warning",
  "category": "Connectivity", "device": "System",
  "title": "Alarm host power — under-voltage",
  "detail": "The Raspberry Pi running this monitor reported under-voltage (<entityId>). …" }
```

#### Config knobs

| Env var | Default | Meaning |
|---------|---------|---------|
| `HOST_POWER_ENTITY` | *(empty)* | binary_sensor entity id; empty ⇒ dormant |

#### Edge cases / honest-null

- **Best-effort throughout.** An unset entity or a stale cache reads as `null` (unknown), never as a false alarm.
- **Warning, not critical.** This is a *leading* indicator, not a live emergency, so it rides the push/UI channel without breaking through quiet hours.

---

### 3. `haStateCache.ts` — TTL-gated HA entity-watts cache

#### What + why

The load-shedding advisor needs to know which household devices are on and how many watts they draw, so it can decompose the opaque SHP2 `panel_load` number into named contributors and simulate "what if we shed the pool pump?". Polling HA's full state list on every decision tick would be wasteful, so this wraps `getAllStates()` behind a short TTL. It is also the shared substrate for the **grid-presence** and **host-power** reads. **Read-only** — it never calls a service or mutates HA state.

#### Key constant

```
TTL_MS = Number(process.env.HA_STATE_CACHE_TTL_MS ?? 30_000)   // 30 s default
```

Plenty fresh for runway decisions that operate on hours-scale projections, and (importantly) below the 120 s host-power/grid staleness ceilings that consume it.

#### Watts extraction (`extractEntityWatts`)

Precedence, first hit wins:

1. **Explicit power attribute** — scan, in order:
   `current_power_w`, `current_power`, `power_w`, `power`, `wattage`, `active_power`.
   Accept a number, or a string coercible to a finite number.
2. **Dedicated power sensor** — if `attributes.device_class === 'power'`, read the entity **state** as the value, honoring unit: `unit_of_measurement === 'KW'` ⇒ multiply by 1000, else watts as-is.
3. Otherwise ⇒ `null` (a plain on/off switch with no metering). The advisor then falls back to SHP2 circuit watts or the operator's estimate.

#### The cache mechanism

Module-level state: `cache: Map<entityId, CachedEntity>`, `lastFetchedAt`, `inflight`.

`refreshIfStale(now = Date.now())`:

- If `now - lastFetchedAt < TTL_MS` ⇒ return immediately (fresh).
- If a fetch is already `inflight` ⇒ return that promise (**concurrent-call coalescing** — no stampede).
- Otherwise fetch `getAllStates()`, and *only if it returns states*, rebuild the map atomically: each `CachedEntity` carries `{entityId, state, attributes, watts: extractEntityWatts(s), fetchedAt}`, then swap `cache` and set `lastFetchedAt`. `inflight` is always cleared in `finally`.

Read accessors:

| Function | Returns |
|----------|---------|
| `getCachedEntity(entityId)` | the `CachedEntity` or `null` |
| `getCachedStates()` | the whole `ReadonlyMap` |
| `getCacheAgeMs(now)` | `lastFetchedAt ? now - lastFetchedAt : +Infinity` |
| `cacheSize()` | number of cached entities |
| `__resetHaStateCache()` | test hook |

#### Trace / wire-in

- Refreshed at `index.ts:1981/2056/2181` before grid/host reads and before the load-shed advisor tick.
- `haEntity: (id) => haStateCache.getCachedEntity(id)` supplied to the advisor (`index.ts:2163`).
- Age surfaced on `/api/load-shedding/status` as `haStateCacheAgeMs` (`index.ts:2243`).
- Consumed by `hostPower.liveHostPower` and the grid classifier.

#### Edge cases

- **Failed fetch keeps the old cache.** If `getAllStates()` returns falsy, the map and `lastFetchedAt` are untouched — but `getCacheAgeMs` then keeps climbing, so consumers with a staleness ceiling (host-power's 120 s) correctly flip to unknown rather than trusting a frozen value.
- **Cold cache ⇒ `+Infinity` age**, which every staleness gate reads as stale/safe.

---

### 4. `alertOnset.ts` — restart-persistent alarm onset timestamps

#### What + why

The `Alert` type is **stateless** — every field is recomputed fresh on each `alertMonitor.evaluate()` tick — so nothing on the alert records *when* it first became active. The ALM screen (`telnet/plant/alm.ts`) used to stamp every alarm row with `snapshot.generatedAt` (this refresh's clock), which is wrong for any alarm that's been active longer than one poll. `alertMonitor`'s in-memory `TrackedAlert.firstSeen` would be correct, but it lives only in the in-process `tracked` Map and resets to "now" on **every add-on restart — and this host restarts roughly daily**. This sidecar is the durable source of truth for first-seen time.

#### Storage

- Path: `ALERT_ONSET_PATH` env, else `resolve(cwd, config.dbPath, '..', 'alert-onset.json')` — the same state-dir convention as the other alarm sidecars (`notify-state.json`, `alert-telemetry.jsonl`, `alert-family-meta.json`).
- Format: a flat JSON object `{ <alertId>: <firstSeenMs> }`.
- Written via `atomicWriteFileSync` (crash-safe temp-then-rename).

#### Key constant

```
ALERT_ONSET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
```

Entries older than 7 days are dropped at load. Scaled up from the notify-state sibling since an onset record is smaller and less sensitive; an onset this old belongs to an alert every other persistence layer has long since forgotten anyway.

#### Mechanism

- `loadAlertOnsets(path, nowMs)` — parse the file; keep only entries where `v` is a finite number **and** `v > nowMs - ALERT_ONSET_MAX_AGE_MS`. Corrupt/missing file ⇒ empty map (start fresh, never throw).
- `saveAlertOnsets(path, state)` — atomic write; on failure, swallow (ALM just falls back to `generatedAt`).
- `syncAlertOnsets(activeIds, nowMs)` — **the single per-cycle hook.** For each active id not yet recorded, stamp `nowMs` (`changed = true`); for each recorded id no longer active, delete it (`changed = true`); persist **only if `changed`**. A steady-state tick with an unchanged roster is a pure in-memory no-op. Wrapped in try/catch so a disk/permission failure can never propagate into the alarm loop.
- `getAlertOnset(id)` — look up first-seen ms; `undefined` if never recorded, pruned, or the sidecar failed to load.

#### The clear-then-rise semantics

Pruning an id the moment it leaves the active set means a later **re-fire** of the same id gets a *fresh* onset — matching how every other alarm-lifecycle concept in this codebase (`tracked`, notify-state, telemetry) treats a clear-then-rise as a **new event**, not a continuation.

#### Trace / wire-in

- **Write:** `alertMonitor.ts:1790` calls `syncAlertOnsets(new Set(tracked.keys()), now)` once per evaluate tick, alongside the falling-edge/dwell loop.
- **Read:** `telnet/plant/alm.ts:123` renders each row's timestamp as `fmtTs(getAlertOnset(a.id) ?? stamp)` — onset if known, else the pre-existing `generatedAt` fallback.

#### Edge cases / honest-null

- Best-effort everywhere; the alarm loop is never blocked or crashed by onset I/O.
- `resetAlertOnsetCacheForTests()` clears the module cache so tests can repoint `ALERT_ONSET_PATH` per test.

---

### 5. `messageRateFloor.ts` + `messageRateFloorAlert.ts` — data-quality "rate collapse" detector (SAFETY-CRITICAL)

#### What + why

The staleness alarm (`alerts.ts`) and the recorder gap detector (`recorder.ts`) both key off the **time since the last message**. A device can defeat *both* by still sending *something*. The live audit caught the SHP2 crawling at **~0.24 msg/min for ~13 h** (150× below its ~30 msg/min norm): its ~5-min heartbeat kept `lastUpdated` under the 180 s stale threshold *and* under the 15-min recorder-gap threshold, so neither fired while the device was effectively not reporting. The SHP2 is the single-point-critical alarm **data source** (floor / SoC / runway), so a silent rate-collapse is a real blind spot — the inputs look live while being effectively stale.

`RateFloorTracker` watches each device's incoming message **rate** against its own learned baseline and flags a sustained collapse even while `lastUpdated` stays fresh.

#### Inputs

- Per-SN cumulative message count `store.mqttMsgCountBySn`.
- The current time (injected for determinism).

#### Config + constants (`DEFAULT_RATE_FLOOR_CONFIG`)

| Field | Env var | Default | Meaning |
|-------|---------|---------|---------|
| `minBaselineRate` | `MSG_RATE_FLOOR_MIN_BASELINE` | `10` msg/min | Min learned baseline for a device to be **eligible** at all |
| `floorFraction` | `MSG_RATE_FLOOR_FRACTION` | `0.2` | Collapse trips when live rate `<` this fraction of baseline |
| `collapseMs` | `MSG_RATE_FLOOR_COLLAPSE_MIN` | `20` min (`× 60_000`) | A collapse must persist this long before firing |
| `baselineAlpha` | *(constant)* | `0.2` | EWMA smoothing for the baseline |

#### The algorithm (`sample(sn, cumulativeCount, nowMs)`)

Per SN it holds `{lastCount, lastMs, baseline, collapseSinceMs, fired}`.

1. **First sample** ⇒ seed state, return `{rate:null, baseline:0, collapsed:false, recovered:false, collapsing:false}`.
2. `dtMin = (nowMs - lastMs) / 60000`. If `dtMin <= 0` ⇒ return the current state's `collapsing = fired` (no time passed).
3. **Counter reset guard:** if `cumulativeCount < lastCount` (a process restart re-zeroes the counter) ⇒ re-baseline instead of computing a negative/huge rate; clear the collapse; `recovered` reflects whether it had `fired`.
4. `rate = max(0, (cumulativeCount - lastCount) / dtMin)`.
5. `eligible = baseline >= minBaselineRate`.
6. `isCollapsed = eligible && rate < floorFraction * baseline`.
7. **Baseline update — healthy samples only:**
   ```
   if !isCollapsed:
       baseline = (baseline == 0) ? rate
                                  : baselineAlpha*rate + (1-baselineAlpha)*baseline
   ```
   A collapse never erodes the baseline, so it **cannot drag the baseline down to meet itself**.
8. **Persistence / edge-trigger:**
   - If `isCollapsed`: set `collapseSinceMs` (from the last healthy sample) if unset; if `!fired && nowMs - collapseSinceMs >= collapseMs` ⇒ `fired = true`, emit `collapsed = true` (the one-tick edge).
   - Else: if it had `fired`, emit `recovered = true`; clear `collapseSinceMs` and `fired`.
9. Return `{rate, baseline, collapsed, recovered, collapsing: fired}`.

#### False-positive guards (by design)

- **Eligibility floor** — only devices sustaining `>= minBaselineRate` (SHP2 ~30/min qualifies; idle/spare units never do) can "collapse."
- **Healthy-only EWMA** — the baseline is immune to the collapse it's detecting.
- **Persistence window** — rides out a brief burst gap before firing.
- **Edge-triggered** — fires once, then holds `collapsing` until recovery (stable dedup key across ticks).

#### The self-alert (`messageRateFloorAlert.ts`)

v0.92.0 only `app.log.warn`-ed a collapse — invisible to the operator. v0.93.0 promotes it to a push alert. The 60 s tick publishes the currently-collapsing set via `setRateFloorCollapses(...)`; `alertMonitor` turns each into a **warning** Alert through the same notify + `snapshot.alerts` pipeline as offline/stale alerts (it is **not** `annunciate:false`).

- `rateFloorAlertId(sn) = "msg-rate-floor-<sn>"` — stable per device, so it de-dups across ticks and simply drops from the set on recovery.
- `rateFloorAlerts(collapses)` — pure builder, one Alert per device: `severity: 'warning'`, `category: 'Connectivity'`, `priority: 'medium'` (explicit ISA P3 — serious but must **not** read as a High protective-limit breach and must **not** break through quiet hours as a full emergency). Facts: live rate + `~<baseline>` msg/min. Detail names the trap explicitly (looks fresh, defeats staleness + gap detectors, floor/SoC/runway effectively stale) and recommends a power-cycle for a clean reconnect.

#### Trace / wire-in

`index.ts:2204–2236` — `const rateFloor = new RateFloorTracker()` plus a 60 s `setInterval` (`.unref()`-ed):

```
for [sn, count] of store.mqttMsgCountBySn:
    r = rateFloor.sample(sn, count, now)
    if r.collapsing → push {sn, deviceName, rate, baseline} into collapses
    if r.collapsed  → app.log.warn(...)      // preserved verbatim
    else if r.recovered → app.log.info(...)
setRateFloorCollapses(collapses)
```

Errors in the tick are caught and logged at DEBUG (`tick skipped`). The tick is purely observational — it **cannot suppress or alter any existing alarm**.

#### Edge cases

- Counter reset (restart) is explicitly handled to avoid a spurious negative/huge rate.
- `rate` is `null` until two samples exist; the alert renders `—` / `?` when a rate isn't yet computed.

---

### 6. Log & format hygiene helpers

These bound what lands on disk and in the log, and keep a real signal greppable during a storm. Individually small; collectively they are why an outage log is still readable.

#### 6.1 `logCoalesce.ts` — duplicate-line storm suppression

**What + why.** Some emitters fire the *same* line over and over during a transient incident. The smoking gun: a 66-minute DNS brownout drove the MQTT client into a tight reconnect→close→error loop, logging `mqtt: error getaddrinfo EAI_AGAIN …` **514 times** — pure noise that buried the real signal.

**Mechanism.** `makeLogCoalescer(emit, opts)` returns `{ log, flush }`:

- **First sighting** of a key logs immediately at original level/format (a state *change* is never swallowed).
- Repeats are counted as `suppressed` and rolled up **at most once per `summaryWindowMs`** (default `60_000`) as
  `"<sample> : <N> more in last <window>"` (window humanized to `ms`/`s`/`m`/`h`).
- **State is per distinct key** — default key is the exact message string; several interleaving lines (reconnect / close / error) each coalesce independently. Override `keyFor` to collapse messages varying only in a volatile suffix.
- `flush()` force-emits all pending summaries and clears state so the tail isn't lost and the next sighting logs fresh — call it on recovery (successful reconnect) or shutdown.
- Clock is injectable (`now`) for testing; no module-global state.

**Wire-in.** `ecoflow/mqtt.ts:147/151` — `stormLog` and `stormWarn` wrap the module's info/warn loggers around the reconnect loop. This is the logging analogue of the storm gate in `broadcast.ts`.

#### 6.2 `logSanitize.ts` — bound what's persisted / rendered

Shared sanitizers for request/network-derived values that are **intentionally** persisted (audit log, alert outcomes, model notes) or rendered to a terminal. They don't make tainted data "safe" in the CodeQL sense (recording provenance is the feature) — they bound what can land on disk.

| Function | Behavior |
|----------|----------|
| `cleanText(v, max)` | Non-string ⇒ `undefined`. Strip C0/DEL (` –`, ``), clamp to `max`. |
| `sanitizeDisplayName(v, max=64, fallback='')` | **Security #2, CWE-150.** Strip **all C0 (incl. ESC 0x1b), DEL, and C1 (0x7f–0x9f, incl. 8-bit CSI 0x9b)**, collapse runs to a space, trim, clamp. Non-string / all-control ⇒ `fallback`. Prevents a device/circuit name set in the EcoFlow app or SHP2 config from injecting terminal escape sequences (OSC title-set, OSC 52 clipboard-write, cursor control) that would execute in the operator's terminal when they view the TUI. |
| `cleanMultilineText(v, max)` | Like `cleanText` but **preserves `\n` and `\t`** (operator-typed multi-line notes). |
| `finiteNumber(v)` | Finite number or `undefined` (so `JSON.stringify` drops it like an absent field). |

**Wire-in.** `sanitizeDisplayName` guards every cloud/MQTT-sourced display name at the ingest boundary: `snapshot.ts:214` (`deviceName`, max 48, falls back to the SN) and `ecoflow/project.ts:579/592` (device + SHP2 circuit names).

#### 6.3 `mqttStartClassify.ts` — boot-grace log-level selection

**What + why.** The first few MQTT start failures that look like a boot-time DNS race (`EAI_AGAIN` / `ENOTFOUND` / `getaddrinfo`) or the EcoFlow `8521 "signature is wrong"` handshake error are **benign** — they self-heal within ~10 min on the retry backoff *while REST polling (the alarm data path) never stops*. So they should log at **WARN**, not ERROR, and not alarm an operator reading the boot log.

**Mechanism.**

```
MQTT_BOOT_TRANSIENT_RE = /EAI_AGAIN|ENOTFOUND|getaddrinfo|8521|signature is wrong/i

classifyMqttStartFailure(attempt, message, graceAttempts):
    return (attempt < graceAttempts && MQTT_BOOT_TRANSIENT_RE.test(message))
             ? 'warn' : 'error'
```

A failure recurring **past** the grace window, or **any other** error class at any attempt, logs at ERROR so it stands out instead of being buried under benign boot artifacts. Extracted from `index.ts` specifically so the v0.75.0 boot-grace behaviour is unit-tested (it had zero coverage and no post-deploy boot had hit a DNS race).

**Wire-in.** `index.ts:1831` — `const transientBoot = classifyMqttStartFailure(attempt, msg, MQTT_BOOT_GRACE_ATTEMPTS) === 'warn'`.

#### 6.4 `haPayloadFmt.ts` — shared HA payload formatting

**What + why.** The REST `/api/ha-state` handler (`index.ts`) and the MQTT-discovery `buildState` (`mqttDiscovery.ts`) carried **byte-identical** copies of these formatters. Factored out **verbatim** so the published HA sensor values are unchanged across both surfaces.

| Helper | Behavior |
|--------|----------|
| `kwh1(wh)` | Wh → kWh at 1 decimal, null-safe: `wh == null ? null : Math.round(wh/100)/10`. Used for SHP2 backup-pool fields. |
| `makeLifetimeKwh(lifetime)` | Returns `(k) =>` lifetime key → kWh at 3 decimals over `persistedWh + pendingWh`. Preserves the exact **falsy-entry** guard (`lifetime[k] ? … : null`, *not* `!= null`), so a missing **or** zero/falsy entry maps to `null` as before. |
| `makeAlertCounter(alerts)` | Returns `(src, sev) =>` count. `src === 'learned'` ⇒ `a.source === 'learned'`; `'threshold'` matches **every non-`learned`** source (`a.source !== 'learned'`) — verbatim. |
| `soonestProjecting(packs)` | Returns `{ projecting, soonest }`: packs with `status === 'projecting'`, and the fewest-`yearsToEol` pack via a reduce using the `?? 1e9` sentinel so a `null` `yearsToEol` sorts **last** — verbatim. |

**Wire-in.** `index.ts:17` imports all four; `:1183` (`lifetimeKwh`), `:1187` (`soonestProjecting`), `:1199` (`makeAlertCounter`), `:1219–1220` (`kwh1` for `backup_full_capacity_kwh` / `backup_remaining_kwh`).

---

### Cross-cutting design invariants

- **Collapse the method, never the measurement.** Every unknown here (host-power stale, cache cold, onset missing, rate not yet computed) reports honest-null and falls back — none fabricates a value or a false alarm.
- **Best-effort never blocks the alarm loop.** `alertOnset`, `haStateCache`, and the rate-floor tick all wrap I/O in try/catch so a disk/permission/network failure degrades gracefully instead of crashing the life-safety process.
- **Pure cores, injected clocks.** `classifyTopLevelError`, `interpretHostPowerEntity`, `extractEntityWatts`, `RateFloorTracker.sample`, `makeLogCoalescer`, `classifyMqttStartFailure`, and the `haPayloadFmt` helpers are all pure/clock-injected and unit-tested off the live pipeline.
- **Greppable loudness.** Survived-but-suspicious events (`process-guard: SURVIVED …`, coalescer roll-ups, boot-grace WARNs) stay findable so a *masked recurring* fault can still be diagnosed.


---

## 14. Intelligent Lighting & HVAC Posture (energy-aware automation)

This cluster documents the add-on's **energy-aware automation layer** — the signals the
add-on computes and publishes so that *Home-Assistant-side* automations can make the
home's lighting (and, in an aspirational Phase-2 sense, its HVAC) behave according to how
much stored/harvested energy is actually available overnight.

> **Read this first — the division of labor.** The add-on is a *sensor*, not an
> *actuator*, in this layer. It computes one runway-driven enum (**Lighting Posture**) and
> a set of **PV-curtailment / surplus** signals, and publishes them as MQTT sensors. It
> **never toggles a light, never sets a thermostat, never calls a dimmer**. All of the
> actuation the design narrative describes — heartbeat pulses, exterior-light policy,
> "dimmer ceilings", pre-cool — lives in **Home Assistant automations** that the operator
> writes and that are gated behind `input_boolean.lighting_postures_enabled`. Where the
> code is explicit that a consumer is HA-side or a feature is dormant, this document says
> so plainly rather than describing behavior that does not exist in the repo.

The two concrete engines that live in the add-on are:

1. **Lighting Posture sensor** — `server/src/lightingPosture.ts` (the runway-driven enum +
   asymmetric hysteresis + restart persistence), published by
   `server/src/mqttDiscovery.ts`.
2. **PV-curtailment / surplus + opportunistic loads** — `computeCurtailment()` in
   `server/src/analytics.ts`, which produces the `surplus` posture trigger and the
   (advisory-only) `ac_precool` / `dehumidifier` HVAC suggestions.

Everything else in the "HVAC posture framework" is **dormant** — it exists as data
structures and `null`-valued hint fields, not as running logic. This is stated honestly in
the relevant section below.

---

### 1. Lighting Posture sensor

#### 1.1 WHAT it does + why

`lightingPosture.ts` distills the whole overnight-energy question into **one enum** that HA
automations can key on. The central design decision (from the file header) is that the
posture is driven by the **runway model's forward question** — *"will we reach sunrise
above the reserve floor?"* — **not by raw State-of-Charge**:

> *"a 45% pool at 21:00 with a clear-day forecast is fine; the same pool at 01:00 drawing
> 8 kW is not. Raw-SoC triggers nag on good nights and under-react on bad ones."*

The published enum is a six-level escalating ladder:

| Posture | Meaning (from header) | Severity rank |
|---|---|---|
| `surplus` | PV curtailment active — energy is going unharvested; lighting (and everything) may run freely. Only entered from normal. | 0 |
| `normal` | Projected dawn minimum comfortably above reserve. | 0 |
| `conserve` | Projected dawn minimum getting thin (`< CONSERVE_DAWN_PCT`). | 1 |
| `amber` | A reserve crossing is projected within the horizon. | 2 |
| `red` | The crossing is near (`≤ RED_HOURS_TO_RESERVE` h away). | 3 |
| `critical` | The pool is at/below its reserve floor **right now**. | 4 |

The severity ranks come from `POSTURE_RANK`:

```ts
const POSTURE_RANK: Record<LightingPosture, number> = {
  surplus: 0, normal: 0, conserve: 1, amber: 2, red: 3, critical: 4,
};
```

Note `surplus` and `normal` **share rank 0** — `surplus` is *not* a warning tier, it is
"normal with headroom", so the two swap freely without tripping the hysteresis.

#### 1.2 INPUTS

The classifier takes a `PostureInputs` object (assembled fresh on every MQTT publish in
`mqttDiscovery.ts`):

| Field | Type | Source (see §1.5 trace) | Meaning |
|---|---|---|---|
| `belowReserveFloor` | `boolean` | `belowReserveFloor(runway)` — the runway report | Pool currently at/below its reserve floor. |
| `hoursToReserve` | `number \| null` | `runway.hoursToReserve` | Projected hours until the pool crosses reserve; `null` = no crossing in horizon. |
| `dawnMinSocPct` | `number \| null` | `forecast.minProjectedSoc` | Forecast's projected minimum SoC % over the horizon (the "dawn minimum"). |
| `reservePct` | `number \| null` | `shp2.projection.backupReserveSoc` | The SHP2's configured reserve %, used for the amber margin. |
| `curtailmentActive` | `boolean` | `curtailment.active` (`computeCurtailment`) | PV curtailment currently active (energy going unharvested). |
| `gridBackstopping` | `boolean?` (v0.87.0) | `liveGridBackstop(snap.devices).backstopping` | The utility grid is genuinely carrying/able to carry the home right now. |
| `nowMs` | `number` | `Date.now()` | Clock injection (deterministic in tests). |

#### 1.3 The CALCULATION — `rawPosture(i)` then hysteresis

The classification is a **pure function** `rawPosture()` (no state, exported for tests),
wrapped by a **stateful tracker** that applies asymmetric hysteresis and restart
persistence.

##### 1.3.1 `rawPosture()` — the pure classifier

Real constants (from the file):

```ts
const CONSERVE_DAWN_PCT      = 35;   // dawn-min % below which "conserve" engages
const AMBER_DAWN_MARGIN_PCT  = 5;    // margin above reserve % treated as "grazing"
const RED_HOURS_TO_RESERVE   = 4;    // hoursToReserve at/below which "red" engages
```

Evaluation order (first match wins):

1. **`critical`** — if `belowReserveFloor` is true → `critical`, reason `"pool at/below
   reserve floor"`. (This is the only branch that fires when below floor; it is checked
   *before* the grid-backstop short-circuit, so a floored pool is always critical.)

2. **Grid-backstop short-circuit (v0.87.0)** — if `gridBackstopping` is true (and we are
   above the floor, since branch 1 already handled the floor): the runway-to-reserve
   projection is *islanded-only* — on a grid-tied evening the SHP2 simply transfers to
   mains at the floor, so the depletion escalations must **not** fire. Result:
   - if `curtailmentActive` → `surplus` (excess solar still applies), else
   - `normal`, reason `"grid backstopping — depletion projection is islanded-only"`.

   When `gridBackstopping` is false/absent (islanding — the **safe default**), the full
   ladder below runs unchanged.

3. **`red`** — if `hoursToReserve != null && hoursToReserve <= RED_HOURS_TO_RESERVE (4)` →
   `red`, reason `"reserve crossing in {h}h"`.

4. **`amber`** — with `reserve = reservePct ?? 15` (the 15% fallback), amber fires if
   **either**:
   - `hoursToReserve != null` (a crossing is projected, just >4 h out), **or**
   - `dawnMinSocPct != null && dawnMinSocPct < reserve + AMBER_DAWN_MARGIN_PCT` (dawn
     minimum grazes within 5 points of reserve).

   Reason is either `"reserve crossing in {h}h"` or `"dawn minimum {n}% grazes reserve
   {reserve}%"`.

5. **`conserve`** — if `dawnMinSocPct != null && dawnMinSocPct < CONSERVE_DAWN_PCT (35)` →
   `conserve`, reason `"dawn minimum {n}% (< 35%)"`.

6. **`surplus`** — if `curtailmentActive` → `surplus`, reason `"PV curtailment active —
   surplus energy available"`.

7. **`normal`** (fallthrough) — reason `"dawn minimum {n}%"` if we have one, else `"no
   depletion projected"`.

##### 1.3.2 Asymmetric hysteresis — `createPostureTracker()`

The stateful wrapper enforces **"escalate immediately, de-escalate slowly"**:

```ts
export const DEESCALATE_HOLD_MS = 15 * 60 * 1000;   // 15 minutes
```

On each `update(i)`:

- **First tick** (`current == null`): adopt the raw posture, set `changedAtMs = nowMs`.
- **Escalation** (`POSTURE_RANK[raw] > POSTURE_RANK[current]`): apply **immediately**
  (safety first), reset the calmer-hold timer.
- **De-escalation** (`POSTURE_RANK[raw] < POSTURE_RANK[current]`): start (or continue) a
  `calmerSinceMs` timer. Only when the calmer raw posture has **held for `holdMs`
  (15 min)** does `current` actually relax. Otherwise the sterner posture (and its
  original reason) is held. This stops a cloud edge or a compressor cycle from making the
  house "breathe up and down".
- **Same rank**: adopt the fresh reason immediately, and if it's a `normal↔surplus` swap
  (same rank 0) the posture text changes freely; the calmer-hold timer is cleared.

The classifier is deliberately re-evaluated every publish; only the *hold* is asymmetric.

##### 1.3.3 Restart persistence (v0.15.20)

The tracker was process-local, so an add-on restart mid-event flapped the published
posture (observed live Jun 11 19:28 local: `amber → normal → amber` within minutes),
firing a spurious "restore-then-reclamp" heartbeat at the family. The tracker now
persists `{posture, reason, changedAtMs, calmerSinceMs, savedAtMs}` to disk:

- **Write policy (SD-card diet):** persist only on posture changes and hold-window
  transitions — **not** every tick.
- **Load-on-start:** on construction with a `statePath`, `loadPersisted()` restores the
  held posture so a restart **resumes** it. A half-warm calmer reading after restart is
  merely a de-escalation *candidate* that must still survive the 15-min hold.
- **Staleness guard:** persisted state older than `PERSIST_MAX_AGE_MS = 60 * 60 * 1000`
  (1 hour) is discarded (the event is likely over → start fresh). Corrupt JSON or an
  unknown posture string also → start fresh.
- Writes go through `atomicWriteFileSync` (`atomicWrite.ts`, shared with battery-soc-alarm
  / runway-alarm) so a crash mid-write cannot corrupt the file.

State path resolution:

```ts
const STATE_PATH =
  process.env.LIGHTING_POSTURE_STATE_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'lighting-posture.json');
```

The process-wide singleton `lightingPostureTracker` (created with `DEESCALATE_HOLD_MS` and
`STATE_PATH`) is shared by every consumer.

#### 1.4 OUTPUTS + API / MQTT

The tracker returns `{ posture, reason, changedAtMs }`. Two values are published as MQTT
discovery sensors (`mqttDiscovery.ts`):

| MQTT `unique_id` | Sensor name | value_json key | Notes |
|---|---|---|---|
| `ecoflow_lighting_posture` | EcoFlow Lighting Posture | `lighting_posture` | icon `mdi:lightbulb-auto`; the enum string. |
| `ecoflow_lighting_posture_reason` | EcoFlow Lighting Posture Reason | `lighting_posture_reason` | icon `mdi:information-outline`; `entity_category: diagnostic`; human-readable basis. |

Data shape (fields of the MQTT state payload):

```json
{
  "lighting_posture": "amber",
  "lighting_posture_reason": "dawn minimum 18% grazes reserve 15%"
}
```

These are **not** exposed on a dedicated REST endpoint — they are computed inside the MQTT
`buildState` path (`mqttDiscovery.ts` ~line 691) and delivered to HA via MQTT. (The
underlying inputs — `runway`, `forecast`, `curtailment` — each have their own `/api/*`
endpoints; see §2 for curtailment.)

#### 1.5 The TRACE — where inputs come from, where the output goes

**Upstream (inputs):** In `mqttDiscovery.ts` `buildState`, the code fetches the analytics
reports in one `Promise.all` — `forecast`, `degradation`, `runway`, `roundTripEfficiency`,
`clipping`, `selfConsumption`, `carbon`, `tariff`, `curtailment` — then calls
`lightingPostureTracker.update({...})` with:

```
belowReserveFloor : belowReserveFloor(runway)
hoursToReserve    : runway.hoursToReserve
dawnMinSocPct     : forecast.minProjectedSoc
reservePct        : shp2.projection.backupReserveSoc ?? null
curtailmentActive : !!curtailment.active
gridBackstopping  : liveGridBackstop(snap.devices).backstopping
nowMs             : Date.now()
```

The `gridBackstopping` resolver `liveGridBackstop()` is the **same** grid-presence
resolver used by the `off_grid` and `runway_projection_islanded_only` sensors and by the
floor-alarm engine, so the posture's grid-awareness is coherent with the alarm layer.

**Downstream (output → actuation):** The two MQTT sensors land in HA. From the file
header and `mqttDiscovery.ts` comments, the intended HA-side consumers are:

- a **heartbeat pulse** (a brief light flash on escalation edges),
- an **exterior-light policy**,
- **dimmer ceilings** (cap brightness under conserve/amber/red).

**All of these are HA automations the operator writes**, and they are **gated behind
`input_boolean.lighting_postures_enabled`** — the add-on "only ever computes and
publishes" and "never toggles a light". The escalation-edge-triggered nature of these
consumers is exactly why the restart-persistence work (§1.3.3) matters: a flap would fire a
spurious pulse at the family.

#### 1.6 CONFIG knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `LIGHTING_POSTURE_STATE_PATH` | env var | `<config.dbPath>/../lighting-posture.json` | Override the persistence file location. |
| `input_boolean.lighting_postures_enabled` | **HA-side** (operator-created) | — | Master gate for all lighting-posture *consumers*. The add-on ignores it; it only gates HA automations. |

The classification thresholds — `CONSERVE_DAWN_PCT` (35), `AMBER_DAWN_MARGIN_PCT` (5),
`RED_HOURS_TO_RESERVE` (4), `DEESCALATE_HOLD_MS` (15 min), `PERSIST_MAX_AGE_MS` (1 h) — are
**compile-time constants**, not env/config options. There is no config.yaml option to tune
the posture ladder; changing it requires a code change.

#### 1.7 EDGE CASES / guards / honest-null behavior

- **Floor beats everything.** `belowReserveFloor → critical` is checked *before* the
  grid-backstop short-circuit, so a floored pool is `critical` even on grid.
- **Grid-tied evenings do not nag.** With `gridBackstopping` true and above floor, the
  depletion escalations (`red`/`amber`/`conserve`) are suppressed — only `surplus`/`normal`
  can publish. Absent/false grid signal → full ladder (the islanding-safe default).
- **Missing forecast/runway inputs** are `null`-tolerant: with `hoursToReserve == null` and
  `dawnMinSocPct == null`, none of the amber/conserve branches fire and the result is
  `normal` ("no depletion projected") — an honest "no data → no alarm" rather than a
  fabricated warning.
- **`reservePct` fallback** is `15` when the SHP2 reserve is unknown.
- **Same-rank `surplus↔normal`** swaps are free and don't trip hysteresis (both rank 0).
- **Persistence is best-effort:** save failures are swallowed (`catch {}`) — the only cost
  is one possible restart flap; corrupt/stale state is discarded, never trusted.
- **Restart mid-hold resumes the countdown** rather than resetting it (the hold-start
  timestamp is persisted).

---

### 2. PV-curtailment / surplus signal + opportunistic loads

#### 2.1 WHAT it does + why

`computeCurtailment()` (`analytics.ts`) is the engine behind the **`surplus`** posture and
the surplus/opportunistic-load layer. It answers: *is the fleet's PV being thrown away
right now because the batteries are saturated, and if so how much surplus power is
available to soak up?* This is distinct from inverter **clipping** (a separate report) —
this is **SoC-saturation** curtailment: PV that the array could produce but the pool won't
accept because it's near its charge ceiling.

Two things flow out of it into the automation layer:

1. `active` / `currentSurplusW` → the **`curtailmentActive`** input to lighting posture
   (drives `surplus`) and the `pv_curtailment_*` MQTT sensors.
2. `opportunisticLoads[]` → a ranked list of loads that could absorb the surplus, each
   flagged `fitsInSurplus`. This is where the (advisory) HVAC pre-cool suggestion lives.

#### 2.2 INPUTS

- Live home-DPU SoC, PV actual (W), and load (W) from the device snapshots
  (`homeConnectedDpus`, the SHP2 device).
- Per-DPU charge ceiling `projection.chgMaxSoc` → `homeChargeCeilingPct()` (mean across
  home DPUs).
- Weather GHI (`radiationWm2`) for the current hour from the weather cache.
- The **Bayesian solar posterior** (expected PV given hour-of-day and GHI).
- 7 days of recorder history for the today/7-day curtailment walk and hour-of-day
  histogram.

#### 2.3 The CALCULATION (relevant constants)

```ts
const CURTAIL_TTL_MS         = 5 * 60 * 1000;  // report cached 5 min
const CURTAIL_MIN_SURPLUS_W  = 300;            // min gap before we call it curtailment
const CURTAIL_MIN_BAYES_SAMPLES = 3;           // posterior support required
const CURTAIL_TAPER_BAND_PCT = 10;             // SoC band below ceiling where shedding begins
```

- **Saturation threshold:** `saturationThresholdPct(ceiling) = max(0, (ceiling>0 ? ceiling
  : 100) − CURTAIL_TAPER_BAND_PCT)`. With no reported ceiling this is `100 − 10 = 90%`
  (taper-aware; replaces an older fixed 96).
- **Expected PV** comes from `predictExpectedPv()` = `posteriorMean × GHI`, but only if the
  hour's posterior has `≥ CURTAIL_MIN_BAYES_SAMPLES (3)` samples — else `null` (honest
  "no model").
- **Surplus** is the expected-minus-actual PV gap (net of load); curtailment is `active`
  only when SoC ≥ saturation threshold, there is daylight/GHI, a trusted model exists, and
  the gap `≥ CURTAIL_MIN_SURPLUS_W (300 W)`. Otherwise `inactiveReason` is one of:
  `soc-too-low | pv-too-low | no-daylight | no-model | small-gap | pv-exceeds-load |
  no-shp2 | no-home-dpus`.
- **Opportunistic loads** are sized against `currentSurplusW`: each load's `fitsInSurplus =
  currentSurplusW >= estimatedW`.

#### 2.4 OUTPUTS + endpoints

**REST:** `GET /api/curtailment` (cached 60 s) returns the full `CurtailmentReport`;
curtailment fields are also folded into the big `/api/ha-state` payload
(`pv_curtailment_active`, `pv_curtailment_surplus_watts`, `pv_curtailment_kwh_today`,
`pv_curtailment_kwh_7d`, …).

**MQTT sensors** (`mqttDiscovery.ts`):

| unique_id | key | notes |
|---|---|---|
| `ecoflow_pv_curtailment_active` | `pv_curtailment_active` | binary ON/OFF; the `surplus`-posture trigger. |
| `ecoflow_pv_curtailment_surplus_watts` | `pv_curtailment_surplus_watts` | power (W). |
| `ecoflow_pv_curtailment_kwh_today` | `pv_curtailment_kwh_today` | energy, `total_increasing`. |
| `ecoflow_pv_curtailment_kwh_7d` | `pv_curtailment_kwh_7d` | 7-day kWh. |
| `ecoflow_charge_ceiling` | `pv_curtailment_charge_ceiling_pct` | diagnostic, %. |

> Historical note (v0.15.3): the `curtailment` report was originally not fetched in the
> MQTT `buildState`, so the five `pv_curtailment_*` sensors (added v0.9.77) read permanent
> "unknown". Wiring the fetch lit them up *and* gave lighting posture its live
> `pv_curtailment_active` signal.

#### 2.5 CONFIG knobs

The opportunistic-load catalog is a **hardcoded** default sized for the operator's Phoenix
off-grid home; the comment explicitly says *"Update via config in a later rev"* — i.e. it
is **not yet config-driven**. The curtail constants above are compile-time. There is no
env/config.yaml knob for the surplus thresholds or the load list.

---

### 3. HVAC posture framework + surplus pre-cool — DORMANT (honest status)

**This is the section to read carefully, because most of the "HVAC posture" narrative is
aspirational, not running code.**

#### 3.1 What actually exists

The only HVAC-related logic in the add-on is **two entries in the opportunistic-load
catalog** (`DEFAULT_OPPORTUNISTIC_LOADS` in `analytics.ts`), both `category: 'hvac'`:

```ts
{ id: 'ac_precool',
  name: 'AC pre-cool (-5°F)',
  estimatedW: 3500,
  category: 'hvac',
  description: 'Drop the thermostat ~5°F now to bank thermal mass for evening hours when SoC is dropping.' },
{ id: 'dehumidifier',
  name: 'Dehumidifier',
  estimatedW: 700,
  category: 'hvac',
  description: 'Reduces moisture load the AC has to remove later — banks comfort into the building envelope.' },
```

**Surplus pre-cool rationale:** when PV is being curtailed (surplus energy is free and
otherwise wasted), it is cheap to over-cool the house now — "banking thermal mass" into the
building envelope — so the AC runs *less* in the evening when SoC is falling and every watt
comes out of the battery. The engine surfaces `ac_precool` with `fitsInSurplus = true`
whenever `currentSurplusW ≥ 3500 W`, and `dehumidifier` when `≥ 700 W`. That is the extent
of the computation.

#### 3.2 What does NOT exist (dormant / Phase-2)

- **No HVAC posture sensor.** There is no `hvac_posture` / `climate_posture` /
  `cooling_posture` MQTT sensor or REST field anywhere in the code — grep confirms zero
  matches. The "posture" concept is implemented only for **lighting**.
- **No ecobee / thermostat actuation from this layer.** The only `ecobee` references in the
  server are in `broadcast.ts` — and those are about the ecobee units' **speakers** as
  audible-alert / TTS targets (`media_player.*`), **not** climate control. The add-on never
  calls `climate.set_temperature` or any thermostat service.
- **`haServiceHint` is always `null`.** Every opportunistic load is built with
  `haServiceHint: null // Phase 2 — wire to HA service.call here.` The intended automatic
  actuation (have the add-on itself call an HA service to start the pre-cool) is an
  explicitly-deferred Phase-2 feature that is not implemented.
- **`haService.ts` snapshot/restore is unrelated.** The `sonos.snapshot` / `sonos.restore`
  helpers in `haService.ts` exist to avoid clobbering music during audible announcements —
  they are **not** an HVAC/lighting "snapshot & restore" mechanism. Likewise the "gauge"
  references in the codebase are the SHP2 backup-pool gauge and self-consumption gauge
  *icons*, not a "capacity-gauge ceiling" engine.

#### 3.3 On "capacity-gauge ceilings" and "dimmer ceilings"

The design narrative refers to "ceilings" in a couple of senses; to be precise about what
is add-on code vs. HA-side:

- The only **ceiling computed by the add-on** is the battery **charge ceiling**
  (`homeChargeCeilingPct()` = mean `chgMaxSoc` across home DPUs), used by the curtailment
  engine to decide when the pool is saturated. This is a battery-charge ceiling, not a
  lighting/HVAC output ceiling.
- **"Dimmer ceilings"** (capping light brightness under conserve/amber/red) are named only
  in comments as an **HA-side consumer** of the posture enum. There is **no dimmer-ceiling
  code, no snapshot/restore of light state, and no occupancy-sweep logic in the add-on** —
  those are automations the operator builds in Home Assistant, gated behind
  `input_boolean.lighting_postures_enabled`. If you are looking for the occupancy-sweep or
  brightness-ceiling implementation, it is not in this repo; the add-on's contribution ends
  at publishing `lighting_posture` + `lighting_posture_reason`.

---

### 4. Summary — add-on vs. Home Assistant responsibilities

| Responsibility | Where it lives | Status |
|---|---|---|
| Compute runway-driven lighting posture enum | Add-on (`lightingPosture.ts`) | **Live** |
| Asymmetric hysteresis (immediate up, 15-min down) | Add-on | **Live** |
| Restart-persist the held posture | Add-on (atomic JSON, 1-h staleness) | **Live** |
| Publish `lighting_posture` + `_reason` MQTT sensors | Add-on (`mqttDiscovery.ts`) | **Live** |
| Compute PV-curtailment / surplus + `surplus` trigger | Add-on (`computeCurtailment`) | **Live** |
| Rank opportunistic loads incl. AC pre-cool / dehumidifier | Add-on | **Live (advisory only)** |
| Heartbeat pulse / exterior policy / dimmer ceilings / occupancy sweeps | **Home Assistant automations** | HA-side, gated by `input_boolean.lighting_postures_enabled` |
| HVAC posture sensor | — | **Does not exist** |
| Automatic pre-cool actuation (`haServiceHint`) | — | **Dormant / Phase-2 (`null`)** |
| Ecobee climate control | — | **Not implemented** (ecobee is only an audible-alert speaker target) |

**Bottom line:** the add-on is a *posture publisher and surplus estimator*. It computes the
signals honestly (including null-safe "no data → normal/inactive" behavior) and hands them
to Home Assistant. Every actuation — lighting or HVAC — is HA-side automation, and the HVAC
side is little more than a labeled recommendation today.

---

## 15. Night-Charge TOU Arbitrage Advisor (advisory)

*Tariff model, worst-case sizing brain, learning ledger, completion-gated scoring, and the frozen write-readiness gate — the advisory engine that recommends a cheap-overnight grid buy sized to hold an outage cushion above the reserve floor.*

On a day a battery shortfall is anticipated, the advisor recommends buying the *right* amount of grid energy in the cheap APS R-EV overnight window (23:00–05:00 Mon–Fri) so the home (a) never imports at the 4–7pm on-peak and (b) carries an **outage cushion** above the reserve floor into the next day. It is framed as much a *resilience* feature as a cost feature, and its posture is **ADVISORY / NO-WRITE**: the add-on never issues a device write. The recommendation is published as HA entities, an API endpoint, a nightly notification, and TUI/web panels; an owner-authored HA automation decides whether to act on it. In parallel, every night's plan is frozen into a durable ledger and scored against measured reality, and a fail-closed readiness gate reduces that record into a single "is the accuracy proven enough to even *consider* writes?" verdict.

The subsystem spans five modules, all shipped incrementally (v1.36.0 tariff → v1.37.0 sizing brain → v1.38.0 ledger + wiring + surfaces → v1.39.x scoring/gate hardening):

| Module | Role |
|---|---|
| `tariff.ts` | Declarative multi-period, seasonal, timezone-resolved TOU model + `rateAt` resolver (pure) |
| `nightChargeAdvisor.ts` | Pure sizing brain (`computeNightChargePlan`), input assembly, outcome scoring math, night-clock bounds, plan holder |
| `nightChargeGate.ts` | Pure write-readiness reduction over the ledger + readiness holder |
| `recorder.ts` | `night_charge_ledger` / `night_charge_calibration` durable tables + injection-safe upsert |
| `index.ts:2320–3200` | Orchestration: 30-min recompute tick, ~21:30 evening job, backfill scorer, premature-capture repair, `/api/night-charge/status` |

---

### 1. Purpose & safety posture

The binding safety invariants, enforced structurally rather than by convention:

- **Read-only with respect to the alarm spine.** The advisor reads the same `projection.backupReserveSoc` the reserve-floor alarm (§5) defends — the *same field*, never a divergent copy — and produces **no** state the floor/runway/SoC alarms consume. A bug here can mis-recommend; it cannot mis-alarm.
- **Under-buy is a safety miss, not a cost miss.** The outage cushion is an explicit resilience requirement; a confidently under-sized buy leaves the home at the floor with no cushion when an outage hits. Sizing therefore uses **worst-case inputs**: P10 (pessimistic-low) PV and P90 (pessimistic-high) load, with committed EV load placed as a worst-case block.
- **The over-buy ceiling is the deliberate asymmetry.** The floor is sized with P10 PV (never under-buy); the "don't clip tomorrow morning's PV" ceiling is sized with **P90** PV (never over-buy into clipping). Where the two collide on a genuinely tight day, **resilience wins**: the buy is kept, the clip is accepted, and `bindingCap='overBuy'` is surfaced.
- **Emit null over a fabricated number.** An incomplete, incoherent, thin, or climatology-only basis yields a *null plan* (`chargeTonight=false`, every numeric field `null`) — never a best-effort small number the operator might trust as cushion. The same discipline runs through the tariff (`ratesConfirmed=false` ⇒ every `$` output null), the scorer (zero telemetry samples ⇒ `null`, not a "measured" `0`), and the gate (null readiness ⇒ `write_ready` strictly `false`).
- **The gate never enables a write.** `READY_TO_CONSIDER_WRITES` only unlocks *consideration*; the device write path is separately deferred behind a probe + owner toggle + the safety spine (design `docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md` §6, not yet built).

---

### 2. Architecture & data flow

```
  SHP2 projection (backupFullCapWh, backupBatPercent,      analytics worker reports
  backupRemainWh, backupReserveSoc)                        probabilisticForecast · forecast
          │                                                multiDayForecast(4d) · evWindowPrediction
          └──────────────┬─────────────────────────────────────────┘
                         ▼
        recomputeNightChargePlan()  (index.ts:2451, every 30 min + evening job)
          buildApsREvModel(env) → periodIdAt = rateAt(...).periodId
          buildNightChargeInputs(deps)   (nightChargeAdvisor.ts:712, pure)
          computeNightChargePlan(inputs) (nightChargeAdvisor.ts:258, pure)
                         │
                         ▼
        setLatestNightChargePlan(plan)  — in-process holder (12 h staleness guard)
          ├─→ /api/ha-state + MQTT state payload (nightChargeStateFields)
          ├─→ /api/night-charge/status (index.ts:3180)
          ├─→ TUI Strategy screen "TONIGHT'S PLAN" · web NightChargeCard
          │
   ~21:30 evening job (once per Phoenix day, restart-persistent latch)
          ├─→ recordNightPlanRow() → night_charge_ledger (frozen PLAN columns)
          ├─→ scoreCompletedNights() → OUTCOME + SCORE columns (completion-gated)
          ├─→ computeNightChargeReadiness(readNightLedger(400)) → readiness holder
          └─→ ONE notification (buildNightChargeMessage, dedupId night_charge_plan)
```

Everything below the report boundary is dependency-injected and pure — `computeNightChargePlan`, `buildNightChargeInputs`, `resolveCheapWindow`, `scoreNightOutcome`, `nightWindowBounds`, `medianFilter3`, and `computeNightChargeReadiness` perform no I/O and read no clocks, so the sizing and gating math is provable by unit test.

**Timers** (all created only when `NIGHT_CHARGE_ADVISOR_ENABLED !== 'false'`, all `unref()`'d):

| Timer | Cadence | Work |
|---|---|---|
| Recompute tick | 30 min | Fresh plan → holder; score completed nights; recompute readiness; refresh the status route's in-memory ledger cache |
| Evening-job tick | 60 s | `runNightChargeEveningJob()` (minute-granular fire gate, see below) |
| Boot warm-up | once, +60 s | `repairPrematureNightOutcomes()`; fresh plan; score; readiness — so the holder and HA gate fields are not null for up to 30 min after the daily host power-cycle (v1.39.0) |

**The evening job** (`index.ts:3009`). Fires at most **once per Phoenix calendar day**, keyed by a restart-persistent latch file (`.night-charge-latch.json` beside the DB, atomic write, in-memory mirror so no request/timer performs an unbounded filesystem read). The fire window is `[NIGHT_CHARGE_NOTIFY_HOUR:MINUTE, 23:00)` local (default 21:30); a re-entrancy guard prevents a slow run (awaited analytics + weather + notify) from overlapping the next 60 s tick (v1.39.0). In order: recompute fresh plan → record the plan row → score completed nights → recompute readiness → send **one** notification → latch *only after a successful send* (failure retries on the next tick within the window). Past 23:00 the notify is skipped-and-latched — a plan pushed after charging should already have begun is worse than none — but scoring and readiness still run, so a missed notify window can never orphan a night's outcome (an MNAR bias in the gate's evidence). All local-time gates resolve via explicit `America/Phoenix` `Intl` parts (`phoenixMinuteOfDay`, `localParts`), never the host clock. The freshest pre-window plan (with its ledger extras) also persists to disk on every recompute (`.night-charge-plan.json`, atomic write, v1.40.0); when the live record window is missed entirely (a restart or update between 21:30 and 23:00), the next run records the persisted plan with its original `generatedAt` — the plan row survives, timestamps are never backdated.

---

### 3. The tariff model (`tariff.ts`, v1.36.0)

A declarative, pure TOU model — periods, seasons, holidays, timezone — plus the `rateAt(model, tsMs)` resolver. `buildApsREvModel(rates)` constructs the deployed plan, **APS Rate Schedule R-EV** (four periods, two seasons, no demand charge):

| Period id | Local window | Days | Seasons | Notes |
|---|---|---|---|---|
| `on_peak` | 16:00–19:00 | Mon–Fri | year-round | `onPeak: true` (drives the `isOnPeak` back-compat flag) |
| `super_off_peak` | 10:00–15:00 | Mon–Fri | winter only | overlaps solar |
| `overnight` | 23:00–05:00 (wraps) | Mon–Fri | year-round | **the cheap charge window the advisor sizes against** |
| `off_peak` | catch-all | — | — | all remaining hours, all weekends, observed holidays |

Seasons: `APS_SUMMER_MONTHS = [5,6,7,8,9,10]` (May–Oct); the rest is winter. This is a documented approximation — APS defines seasons by *billing cycle*, not calendar month, so a handful of boundary days each year may be seasoned one cycle early/late (bounded to ≤ a few days/yr; inert while rates are unconfirmed). `holidays` (local `YYYY-MM-DD` strings, all-day off-peak, checked *before* every specific period) defaults to `[]` — the APS observed-holiday list is documented as "confirm from a bill", not guessed.

**Resolution algorithm** (`rateAt`): resolve the instant into local parts via a memoized `Intl.DateTimeFormat('en-US', { timeZone, hourCycle:'h23' })` `formatToParts` (one formatter per timezone; never the host clock, so a non-Phoenix container cannot bleed a rate boundary); derive day-of-week from the *resolved calendar date* via `Date.UTC(y,m-1,d).getUTCDay()` rather than an ICU `weekday` part — a degraded/small-ICU runtime that dropped the part would otherwise collapse every weekday to Sunday and silently misprice every on-peak/overnight hour as weekend off-peak (fail-safe by construction). Then: holiday check → first matching period in priority order (season gate, weekday gate, `inHourWindow` with wrap-around: `start>end` wraps past midnight, `start===end` means all 24 h) → the `off_peak` catch-all.

**★ Per-instant weekday semantics (load-bearing).** A period's `weekdays` gate is evaluated against **each instant's own** local day-of-week, not the day the window "started". The wrap-around overnight window therefore resolves literally: Fri 23:00 *is* overnight (Friday is Mon–Fri) but Sat 00:00–05:00 is **off-peak** (Saturday is a weekend); likewise Sun 23:00 is off-peak while Mon 00:00–05:00 is overnight. Whether real APS billing treats Friday-night→Saturday-morning as a single overnight block is an **open tariff question** only a bill can settle (see §11); the model's reading is the defensible default consistent with "off-peak = all weekends".

**Rates-unconfirmed ⇒ `$` outputs null.** Every period carries per-season `centsBySeason` values that default to `null`, and the model carries `ratesConfirmed` (default `false`). While `ratesConfirmed=false`, `rateAt` resolves `centsPerKwh` to **null for every period regardless of the numbers in the model**, and `buildApsREvModel` also nulls `fixedDailyCents` — an unconfirmed model can never leak a fabricated basic-service charge or energy rate into a cost consumer. The returned `RateSlice` mirrors `ratesConfirmed` so a consumer can distinguish "null because unconfirmed" from "null because this confirmed period has a missing-season data gap". `periodId` is **structural** and needs no confirmed rate — which is what lets the advisor resolve the charge window while every `$` output stays null. `flatTariffModel(cents)` wraps a single-rate legacy plan in the same shape so an eventual consumer rewire is a behavior-preserving swap.

**Env mapping** (`apsREvRatesFromEnv`, `index.ts`): empty-string/unset options read as `null` (unconfirmed).

| Env option | Fills |
|---|---|
| `TARIFF_APS_ONPEAK_SUMMER_CENTS` / `TARIFF_APS_ONPEAK_WINTER_CENTS` | `on_peak` summer / winter |
| `TARIFF_APS_OFFPEAK_SUMMER_CENTS` / `TARIFF_APS_OFFPEAK_WINTER_CENTS` | `off_peak` summer / winter |
| `TARIFF_APS_OVERNIGHT_CENTS` | `overnight`, **both** seasons (one env, same rate) |
| `TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS` | `super_off_peak` winter (summer stays `null` — the period is winter-only) |
| `TARIFF_APS_RATES_CONFIRMED` | `ratesConfirmed` (`'true'` only) |

---

### 4. Input assembly — the worst-case basis

`recomputeNightChargePlan()` (`index.ts:2451`) assembles `NightChargeInputDeps` from live state, then hands off to the pure `buildNightChargeInputs` → `computeNightChargePlan`. It returns `null` (no plan recorded, holder untouched) when inputs cannot be constructed at all — SHP2 projection missing, or `backupFullCapWh`/`backupBatPercent`/`backupReserveSoc` absent (design invariant I5).

**Battery state.** `fullKwh = backupFullCapWh/1000`, `socNowPct = backupBatPercent`, `reserveFloorPct = backupReserveSoc`. SoC coherence (I11): `socCoherent = |remainWh/fullWh·100 − socNowPct| ≤ 8` — the same %-vs-Wh cross-check discipline the SoC alarm uses; `false` forces a null plan downstream.

**Efficiency seams** (injected, never hard-coded downstream): `legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.927` (charge leg — the pack stores `legEff` of what reaches the charger; `DISPATCH_ROUND_TRIP_EFFICIENCY` defaults 0.86, §7) and `dischargeEff = RUNWAY_DISCHARGE_EFFICIENCY` (default 0.94, the runway DC-bus discharge tax, §5).

**The conservative band** (within ~24 h, authoritative): for each probabilistic-forecast hour with a matching day-ahead hour, `pvP10W = p10W` and `loadP90W = forecastLoadW × ARB_LOAD_P90_FACTOR` (default 1.15). The day-ahead load already folds an *expected-value* EV block (`predictedEvLoadW`) into `forecastLoadW`, so `embeddedEvW = predictedEvLoadW × factor` is carried alongside for de-duplication. Hours with no load side are skipped — the band must carry both.

**Beyond the band**: multi-day rollup hours, widened per day by `√daysAhead`: `pvP10 = pvW·max(0, 1 − errHalfFrac·√daysAhead)`, `loadP90 = loadW·(1 + errHalfFrac·√daysAhead)` where `errHalfFrac` is the probabilistic forecast's realized daily error half-width. The merge is keyed by hour timestamp and **the band always wins** where both cover an hour.

**Cheap-window resolution** (`resolveCheapWindow`, `nightChargeAdvisor.ts:662`): scan the injected `periodIdAt` resolver forward hour-by-hour (default 30 h) for the next contiguous run of the `overnight` period id; a run's *end* is scanned up to 24 h past the run's own start so a run straddling the scan edge is not truncated (v1.39.0 — a Saturday-evening scan finding Monday 00:00 at hour 27 of 30 must still report the close as 05:00, not 04:00). When the scan instant is already *inside* a cheap window (the recompute tick runs around the clock), the resolver walks **back** to the window's true start so the reported `window_start` is the real 23:00, not the live mid-window clock (display honesty). A pathological always-cheap resolver is bounded at 25 h.

**`nextRechargeMs`** = the start of the *next* cheap window after tonight's (separate 96 h scan) — the horizon end. Tariff-based and deterministic: a single transient sunny hour, or a central-forecast pv≥load crossing that the P10/P90 sim would still be draining through, cannot truncate the multi-day carry. On a weekday this lands ~tomorrow night; across a weekend it produces the 24–50 h carry described in §11.

**Morning-PV ceiling headroom**: `morningPvSurplusP90Kwh = Σ max(0, p90W − forecastLoadW)/1000` over `[windowEnd, windowEnd+14 h)` — P90 (best-case) PV by design, so the ceiling never over-buys into clipping. `null` when the band doesn't cover the span (ceiling simply not applied).

**Committed-EV worst case**: from the EV window prediction report — `p90SessionKwh` (the P90 session energy, **not** the probability-weighted expected value), `chargeStartMs` = the first upcoming/ongoing predicted session (floored to ≥ the current hour), `sessionCount`. Placement (in `buildNightChargeInputs`) lays the P90 energy down from the predicted charge hour forward, capped at `EV_MAX_LOAD_W` (default 11 520 W) per hour, spilling into later hours until exhausted, and bounded to the next-24 h band region (beyond-24 h rollup hours already embed typical EV in their `loadW` and are not de-duplicated — adding the block there would double-count).

**★ EV strip/re-add atomicity.** The embedded expected-value EV is stripped from the base load **only** on the hours the committed P90 block actually covers, hour-by-hour, atomically with the re-add: `loadP90W = max(0, loadP90W − embeddedEvW) + addW`. Hours before the block, after it exhausts, or beyond the band keep their embedded EV untouched. Stripping without replacing would erase a real charging night from the sizing basis and under-buy — a safety miss — so "never strip without replacing" holds **per-hour**, not per-plan (v1.39.0; the earlier whole-band strip erased *other* predicted sessions). A degenerate `evMaxLoadW` (≤ 0 / NaN) would make every placement hour add 0 W while still stripping — it is treated as "cannot place" and the embedded EV is kept.

**Confidence tier**: `forecast` when the whole horizon (through `nextRecharge`) is inside the real-weather horizon; `climatology` when there is no weather-backed day-ahead forecast at all *or* the charge window itself lies past the weather horizon; `mixed` when only part of the horizon runs past it (the weekend carry beyond the ~4-day forecast).

**`basisComplete`** = `forecastPresent && confidenceTier !== 'climatology' && calScoredDays ≥ 14 && bandCoverageFrac ≥ 0.9` — the probabilistic band must have ≥ `NIGHT_MIN_CAL_DAYS = 14` scored calibration days *and* realized in-band coverage ≥ 90% before the advisor will size anything on it. `false` forces the null plan.

Finally the horizon is trimmed to `[floor(now to hour), nextRecharge)`.

---

### 5. The sizing brain (`computeNightChargePlan`, `nightChargeAdvisor.ts:258`)

Pure; the objective is **lexicographic**: (1) *hard resilience constraint* — the P10-PV/P90-load pool trajectory must stay ≥ floor+cushion from window-end to the next recharge; (2) source that energy in the cheap window (the arbitrage); (3) ceiling so a too-full pack doesn't clip morning PV.

#### Fail-closed gates (every one ⇒ the null plan — all numerics null, `chargeTonight` strictly false)

1. `basisComplete === false`; 2. `socCoherent === false`; 3. `confidenceTier === 'climatology'` ("will not size a buy on a guessed sky"); 4. no valid window (`window` null or `endMs ≤ startMs`); 5. non-finite/non-positive `fullKwh`; 6. non-finite `socNowPct`; 7. non-finite or negative `reserveFloorPct`/`cushionPct` (v1.39.0 — a NaN floor made `targetFloorKwh` NaN, every bisection comparison false, and the buy silently resolved to the *full pool headroom*: a confident max-buy instead of the promised fail-closed null); 8. non-finite `legEff`/`dischargeEff`/`chargeCapKw` (same class — all operator-config-sourced); 9. empty horizon.

#### The DC-bus recurrence

Each simulated hour: `packWh ← clamp(packWh + pvP10W − loadP90W/dischargeEff, [0, fullWh])` — delivering `load` at the panel draws `load/η` from the pack. This is **identical** to the runway/forecast/multi-day recurrence (`analytics.ts:7973`), so the advisor's trough is consistent with the alarm's runway projection. The simulation starts from the **floor of the current hour** (`simFromMs = floor(nowMs/1h)·1h`), not `nowMs`: filtering `≥ nowMs` dropped the in-progress hour entirely, under-simulating ~30 min of drain at the 21:30 issue time (an under-buy); including the full current hour over-counts by at most the elapsed fraction — the conservative, over-buy direction (v1.39.0).

#### Baseline and the pre-window carry

One baseline walk yields `packAtWindowEnd_noBuy` (pack entering the window close with no buy, carrying tonight's pre-window + in-window house load) and the no-buy trough over `[windowEnd, horizon end]` → `baselineMinSocPct`.

When the plan is issued *before* the window opens, a second walk over `[simFromMs, windowStart)` produces the **pre-window carry** (v1.39.0, §4-honesty): `projSocAtWindowStartPct` (pack entering the window — frozen into the ledger's `soc_at_window_start_pct`) and `preWindowMinSocPct` (the projected minimum over the span a tonight buy *cannot* protect). On weekend evenings the resolved window can be 24–50 h away, so this span covers whole nights the scored `[windowEnd, …)` trough never sees; if it dips below floor+cushion, the rationale carries an explicit "a dip tonight's buy cannot prevent; the floor alarm owns that span" note with the day-qualified window-open time. **Mid-window** (`nowMs ≥ windowStart`) there is no pre-window span: both fields stay `null` and no note is emitted — the pre-fix code collapsed them to the current SoC and could emit a false "before the charge window opens" statement about a window already open.

#### The hold branch

With `targetFloorKwh = fullKwh·(reserveFloorPct + cushionPct)/100`: if the no-buy trough already holds the line (`≥ targetFloorKwh − 1e-9`), the plan is an honest **hold** — `buyKwh: 0`, `requiredExtraKwh: 0`, `objective: 'none'`, trough fields populated, rationale "no charge needed".

#### ★★ The sizing authority — bisection against the re-simulated with-buy trough

`troughAtLift(lift)` re-runs the full post-window simulation with the window-close pack raised by `lift` kWh. Sizing is **solved against this clamp-exact re-simulation, never the additive offset** `targetFloor − clampedBaselineTrough`, which the DC-bus clamps break in *both* safety-critical directions (two confirmed v1.37.0 criticals):

- (a) a mid-window PV surge that clamps the pack to FULL **erases the lift** — an additive estimate reports "requirement met" while the trajectory still dips below floor+cushion (unflagged residual risk);
- (b) a deep drain that clamps the baseline trough at 0 **truncates the apparent deficit** at `targetFloor` — the additive requiredExtra under-sizes the buy on exactly the deep-shortfall night (an under-buy, the life-safety miss).

`trough(lift)` is monotone non-decreasing in `lift` (`max(0,min(full,·))` preserves order), so a bisection is exact: if even `troughAtLift(poolHeadroomLiftKwh)` cannot hold the line, `requiredExtraKwh = poolHeadroomLiftKwh` (the requirement *is* the full-pack lift; the unmet cushion is flagged via the trough below, never assumed met); otherwise 48 bisection iterations over `[0, poolHeadroomLiftKwh]` find the minimal lift whose re-simulated trough reaches `targetFloorKwh`.

#### The three caps

```
remainingWindowHours  = max(0, (windowEnd − max(windowStart, nowMs)) / 1 h)     // mid-window clamp (v1.39.0)
windowLoadKwh         = Σ loadP90W/1000 over horizon hours in [windowStart, windowEnd)
chargePowerLiftKwh    = max(0, (chargeCapKw · remainingWindowHours − windowLoadKwh) · legEff)
poolHeadroomLiftKwh   = max(0, fullKwh − packAtWindowEnd_noBuy)
liftKwh               = min(requiredExtraKwh, chargePowerLiftKwh)
```

The charge-power cap credits only the **remaining** window when computed mid-window: the 30-min recompute tick runs around the clock and `resolveCheapWindow` deliberately walks back to the true window start for display honesty, so crediting the full window length would over-credit up to ~6 h × `chargeCapKw` of nonexistent lift and present an undeliverable buy as fully meeting the cushion (v1.39.0). The horizon is already trimmed to ≥ the current hour upstream, so `windowLoadKwh` sums the same remaining span. In-window house load is served first (billed load happens while grid-charging), and only `legEff` of what reaches the charger is stored.

`bindingCap` resolution: `'requirement'` by default; `'poolHeadroom'` when `requiredExtraKwh ≥ poolHeadroomLiftKwh − 1e-6`; `'chargePower'` when `chargePowerLiftKwh < requiredExtraKwh − 1e-6`. **`cushionShortfall`** is driven by the re-simulated trough *under the lift actually deliverable* (`troughAtLift(liftKwh).minKwh < targetFloorKwh − 1e-6`) — so neither a full-clamp erasing the lift nor a below-empty deficit can present as "requirement met". If the shortfall exists while `bindingCap` still reads `'requirement'` (a clamp, not a linear cap, was the limiter), the flag is re-attributed to the tighter physical bound so it is never `'requirement'`-with-shortfall. Finally the **over-buy ceiling** is a *flag only* (resilience wins): when the cushion IS met and `targetPackKwh > fullKwh − morningPvSurplusP90Kwh + 1e-6`, `bindingCap='overBuy'` — the buy is kept and the accepted clip is disclosed.

#### Outputs

`buyKwh = liftKwh / legEff` (the meter sees more than the pack stores), `targetSocPct = (packAtWindowEnd_noBuy + liftKwh)/fullKwh·100` (clamped to full), `minProjSocPct`/`minProjSocTsMs` from the with-buy re-simulation (the number the ledger's floor verdict is scored on), `baselineMinSocPct`, `chargeTonight = buyKwh ≥ minBuyKwh` (`ARB_MIN_BUY_KWH`, default 1 — below it the night is a "hold", no nagging about a trivial top-up), and a composed `rationale` string carrying the buy, target, no-buy trough, floor+cushion line, and the honest shortfall / over-buy / pre-window notes.

---

### 6. The learning ledger (`night_charge_ledger`, `recorder.ts`, v1.38.0)

One durable row per `plan_date` (`YYYY-MM-DD`, America/Phoenix; primary key), in three column groups:

- **PLAN** (frozen the evening before; a re-issue for the same date overwrites only the plan columns): `issued_at_ms`, `algo_version` (stored TEXT — a physics fix bumps it and makes prior rows excludable, §8), `posture` (`'advisory'`), `objective`, `rationale`, `confidence_tier`, `horizon_hours`, `soc_now_pct`, `soc_at_window_start_pct` (v1.39.0 — the plan's own projected pack SoC entering the window; NULL on every pre-v1.39.0 row), `target_soc_pct`, `buy_kwh`, `required_extra_kwh`, `reserve_floor_pct`, `cushion_pct`, `cushion_kwh`, `binding_cap`, the forecast basis (`pv_p10/p50/p90_kwh`, `load_p10/p50/p90_kwh`, `ev_p90_session_kwh`, `ev_session_count`, `band_sigma_cal`, `cal_scored_days`, `forecast_basis`, `weather_covered`), `min_proj_soc_pct`/`min_proj_soc_ts_ms` (the simulated plan trajectory — **omitted entirely for an incomplete-basis plan**, so a NULL here is the scorer's "no basis" sentinel), `pool_full_kwh`, `tariff_snapshot` (JSON: plan/season/period-now/ratesConfirmed/cents-by-tier), and **`window_start_ms` / `window_end_ms`** (v1.39.0) — the plan's *actually resolved* charge window. Weekend plans resolve windows disjoint from the canonical 23:00–05:00 night (a Saturday plan's window is Monday 00:00–05:00), and the scorer/completion gate must pair actuals to the **real** window; without these columns a Saturday night would be captured before its window even opened. Added to existing databases by an idempotent `ALTER TABLE` migration.
- **OUTCOME** (NULL until the night completes): `outcome_captured_at_ms`, `actual_pv_kwh`, `actual_load_kwh`, `actual_window_import_kwh`, `actual_onpeak_import_kwh`, `onpeak_import_occurred`, `actual_min_soc_pct`/`_ts_ms`, `plan_traj_floor_breached`, `cushion_breached`, `grid_home_coverage_frac`, `scored` (0/1), `score_notes`.
- **SCORE** (NULL until scored): `pv_err_frac`, `pv_in_band`, `load_err_frac`, `load_in_band`, `buy_err_kwh` (signed, + = over-bought), `soc_min_err_pct`.

Several declared columns are *never written* in the current release and read NULL by design: `actual_grid_to_battery_kwh` (exact charge attribution needs an actuated night), `outage_during_day`, and the cost/savings columns (`realized_cost_cents`, `counterfactual_cost_cents`, `realized_savings_cents`, `demand_charge_savings_cents`, `would_have_peak_imported`) — there is no valid savings counterfactual pre-write, and rates default unconfirmed.

**★ Never pruned.** The table is created alongside `lifetime_totals` and is never referenced by the hourly `samples` prune — the multi-month verification record the write-readiness gate reduces over **must survive the 30-day samples retention** (design §0.1, binding). The companion `night_charge_calibration` singleton (`id=1 CHECK`; seasonal cushion learner / buy de-bias / EV-tail inflation state, design §3.4) has schema and read/write API but **no live producer or consumer yet** — the learner is a later increment.

**Write path.** `nightUpsert` builds a dynamic `INSERT … ON CONFLICT(plan_date) DO UPDATE` where column names come *only* from a frozen whitelist (`NIGHT_LEDGER_COLUMNS`), never caller keys — that is what makes the interpolation injection-safe. Only columns present and not `undefined` are written, so a partial outcome merge preserves every frozen plan column; prepared statements are cached per column-shape; JS booleans are coerced to INTEGER 0/1 (`node:sqlite` rejects a boolean bind). `recordNightPlanRow` (`index.ts:2668`) coerces nullable plan numerics to 0 for the non-null plan columns (`target_soc_pct`, `buy_kwh`, `required_extra_kwh`) but *omits* `min_proj_soc_pct` when null so the sentinel survives. The synthetic SN `night_charge` is reserved for optional disposable 30-day chart-overlay samples and joins the restart-gap exclusion list (like `weather`/`forecast`) so off-cadence wall-clock rows can never mask a real telemetry stall; the durable ledger itself never rides the `samples` table.

---

### 7. Completion-gated outcome scoring

#### The night clock (`nightWindowBounds`, `nightChargeAdvisor.ts:951`)

The single source of truth for a plan date's spans, in fixed America/Phoenix arithmetic (UTC−7, no DST; pure, null on a malformed date): plan for day `D` covers charge window `[D 23:00, D+1 05:00)`; the plan-trajectory score span runs `[D+1 05:00, D+1 21:00)`; the night is **complete** — and may be outcome-captured — only at/after `D+1 21:00` (`completeMs`, = day-start + 45 h). `nightSpansForRow` (`index.ts:2782`) prefers the row's **own stored window** when present: the score span then runs **16 h past the real window close** (`window_end_ms + 16 h` — the same close+16 h shape as the canonical 05:00→21:00), which is what pairs a weekend plan's actuals to its Monday-morning window instead of the canonical night. Rows without a stored window (`pre-v1.39.0`) are marked `windowKnown=false` and captured honestly as `scored=0` — actuals cannot be paired to the plan's real window, and a fabricated cross-span comparison must never enter the gate's evidence.

**★ The completion gate** (v1.39.0): a night may be captured only once `nowMs ≥ completeMs`. The pre-fix midnight tick captured yesterday's row while its charge window was still *open* — window coverage ~25% ⇒ `scored=0`, inverted SoC query ⇒ null actuals — and the idempotence latch then froze those truncated actuals into the never-pruned ledger forever, so the readiness gate could never accumulate a single scored night.

#### The backfill sweep (`scoreCompletedNights`, `index.ts:2804`)

Runs on the 30-min tick, the evening job, and the boot warm-up. Sweeps the last **60 days** of ledger rows (not exactly-yesterday — the old scorer orphaned any night left uncaptured across SHP2-wedge/downtime days forever, an uncounted MNAR exclusion), skipping rows already captured (`outcome_captured_at_ms != null` — idempotent) and rows still in flight. A night whose raw telemetry (~30-day retention) has aged out captures honestly as `scored=0` with null actuals — it does not stay uncaptured forever.

#### Measuring one night (`scoreNightRow`, `index.ts:2840`)

- **Grid import**: trapezoidal integration of SHP2 `grid_home_w` (positive-clamped, gaps > 1 h skipped) over the real charge window and over the plan-day 16:00–19:00 on-peak. **Null-over-fabrication**: zero samples record NULL, never a "measured" 0 kWh.
- **Coverage**: fraction of 5-min buckets in the window with ≥ 1 sample; `< 0.9` ⇒ `scored=0` ("MNAR-excluded").
- **PV/load actuals** are integrated over `[issued_at_ms, +24 h]` — the same horizon the frozen P50 forecast covered, so `pv_err_frac`/`load_err_frac` are like-for-like. Actual PV = Σ `pv_total` over the SHP2-connected home DPUs (the same basis the forecast is built from); actual load = SHP2 `panel_load`.
- **Minimum SoC** over the score span passes through `medianFilter3` (3-sample median; endpoints pass through) *before* the min-scan: the documented SHP2 cloud-reconnect artifact emits a single transient `backupBatPercent=0` sample, and an unfiltered min-scan latches it — fabricating a realized need equal to the full floor+cushion and a false HARD under-buy in the gate's evidence. A genuine sustained low has agreeing neighbors and passes.
- **Realized-need buy** — the hindsight counterfactual `buy_err_kwh` is scored against — is defensible **only on a clean night**: in advisory phase the home runs *without* the buy, and on a grid-tied home its own overnight import props the SoC. `scored=1` requires: plan had a trajectory (`min_proj_soc_pct` non-null) ∧ coverage ≥ 0.9 ∧ a min-SoC read exists ∧ window import ≤ `ARB_MIN_BUY_KWH` (near-zero — "clean islanded baseline"). Then `realizedNeedBuyKwh = max(0, targetFloorKwh − actualMinPackKwh)/legEff`. Every other case records `scored=0` with an explicit `score_notes` reason.
- **The floor verdict is the plan trajectory, never baseline telemetry** (design §3.3): `plan_traj_floor_breached` = the plan's own simulated `minProjSocPct < reserveFloor + cushion` — in advisory phase raw min-SoC telemetry measures the un-actuated baseline, not the plan's line. Raw telemetry feeds only `soc_min_err_pct` (plan minus actual) and the separate `cushion_breached` observation. `pv_in_band`/`load_in_band` check the actual against the frozen `[P10, P90]`; `onpeak_import_occurred` uses a 0.05 kWh threshold.

#### Premature-capture repair (`repairPrematureNightOutcomes`, `index.ts:3096`)

Once per boot, idempotent: any row whose `outcome_captured_at_ms` **precedes its own night's `completeMs`** (the pre-v1.39.0 mid-window defect) has its outcome/score columns reset to NULL (`scored=0`, explanatory `score_notes`) so the now-completion-gated sweep re-captures it with full-span actuals. Rows are corrected in place — never deleted.

---

### 8. The write-readiness gate (`computeNightChargeReadiness`, `nightChargeGate.ts:193`)

A pure reduction over the ledger (no I/O, `nowMs` injected) into one of three states — `LEARNING` / `READY_TO_CONSIDER_WRITES` / `BLOCKED` — plus `writeReady` and a human-readable `blocking[]` list. It gates **only on physically-measured prediction accuracy**: there is deliberately *no* savings term (no valid counterfactual exists pre-write, so a savings gate would certify a number the system cannot observe). Recomputed over `readNightLedger(400)` on every tick, evening job, and warm-up.

**Thresholds are pre-registered and frozen** — never tuned on the season they gate (garden-of-forking-paths); a re-tune bumps `CURRENT_ALGO_VERSION` (currently **1**) and resets the readiness clock. Rows are filtered to the current algo version by **string** comparison (`recordNightPlan` persists `algo_version` as SQLite TEXT; a numeric compare never matched a real row and left the gate permanently stuck). Prior-version rows are *excluded*, not tagged — a planner physics fix changes the meaning of every prior row.

**Eligible rows** = `scored=1` ∧ current algo ∧ `confidence_tier === 'forecast'` (climatology/mixed weekend rows never count), chronological by `plan_date`.

**HARD failures ⇒ `BLOCKED`** (evaluated first):

| Gate | Rule |
|---|---|
| Plan-trajectory floor breach | A **single** `plan_traj_floor_breached` row blocks. Evaluated over **all** current-algo forecast-tier rows with a recorded verdict — *not* only the coverage-`scored` subset: the breach is a property of the plan's own simulated trajectory, independent of `grid_home_w` coverage, so a would-have-breached plan on a coverage-excluded (propped/storm/SHP2-offline) night — exactly the adverse night the gate exists to catch — still blocks. Presence-checked with a loose `!= null` so both boolean and 0/1 forms count. |
| Under-buy rate | With ≥ `MIN_NIGHTS_TO_JUDGE_UNDERBUY = 5` scored nights: fraction of `buy_err_kwh < 0` must be ≤ `MAX_UNDERBUY_RATE = 0.10` (under-buy is the asymmetric safety miss). Below 5 nights this is still LEARNING, not BLOCKED. |

**Soft eligibility gates** — *any* unmet or uncomputable metric ⇒ fail-closed `LEARNING` (design I13; missing/thin/young data is never null-as-ready):

| Metric | Threshold | Constant |
|---|---|---|
| Scored forecast-backed nights | ≥ 60 | `MIN_SCORED_ELIGIBLE_DAYS = 60` |
| In-season record age (oldest eligible `issued_at_ms`) | ≥ 90 days | `REQUIRED_IN_SEASON_DAYS = 90` |
| Autocorrelation-adjusted effective N | ≥ 45 | `MIN_EFFECTIVE_N = 45` |
| Signed buy bias (mean `buy_err_kwh`) | in `[0, 5]` kWh | `BUY_BIAS_MIN_KWH = 0`, `BUY_BIAS_MAX_KWH = 5` — never net under, never gross over |
| PV day-ahead accuracy | MAE ≤ 0.20 ∧ \|bias\| ≤ 0.10 (fractions of actual) | `PV_MAE_MAX_FRAC`, `PV_BIAS_ABS_MAX_FRAC` |
| Load day-ahead accuracy | MAE ≤ 0.20 ∧ \|bias\| ≤ 0.10 | `LOAD_MAE_MAX_FRAC`, `LOAD_BIAS_ABS_MAX_FRAC` |
| Realized band coverage (both PV *and* load in `[P10,P90]`) | in `[0.78, 0.92]` | `BAND_COVERAGE_MIN/MAX` — too high means the band is uselessly wide, too low means unsafe |
| MNAR exclusion fraction | ≤ 0.35 | `MAX_EXCLUSION_FRAC = 0.35` |

Accuracy is **normalized MAE + a separate signed bias, deliberately not r²**: r² is variance-driven and inflated by monsoon swings — a +15–20% biased-but-correlated forecast passes r² ≥ 0.80 yet mis-sizes the buy.

**Effective N** (`effectiveSampleSize`, `nightChargeGate.ts:157`): `n·(1−r₁)/(1+r₁)` with lag-1 autocorrelation `r₁` computed over the PV residual series (fallback: load residuals, then the raw count), clamped to `[0, 0.99]` — a cloudy stretch is several *correlated* bad nights, so raw count over-counts evidence; negative autocorrelation is clamped to 0 so it can only ever reduce, never inflate.

**The MNAR denominator is *expected* nights, not captured rows** (v1.39.0): nights that never produced a ledger row at all — add-on down at the evening job, SHP2 cloud-offline, the documented *adverse* failure modes — must count as exclusions; keying the fraction on captured rows let exactly those nights vanish from both numerator and denominator. Expected range = every Phoenix calendar date from the first current-algo plan (bounded to a trailing 120 days) through the most recent *completed* night — the Phoenix date of `now − 45 h` (plan `D` completes at `D+1 21:00`). `exclusionFrac = max(0, expected − distinct scored plan-dates in range)/expected`. Phoenix dates are built from `en-US` `formatToParts` (v1.39.1) — the `en-CA` `format()` shortcut silently falls back to a non-ISO shape on a small-ICU Node, cascading into a swallowed throw and a permanently-null readiness.

`nightChargeGateFields` (`nightChargeGate.ts:426`) flattens the result for the state payloads; on a null readiness it emits `night_charge_readiness: 'unknown'`, **`night_charge_write_ready` strictly `false`**, and every diagnostic null.

---

### 9. Delivery surfaces

**State payloads.** `nightChargeStateFields(plan, now)` + `nightChargeGateFields(readiness)` are spread into **both** the MQTT state payload (`mqttDiscovery.ts:894`) and `/api/ha-state` (`index.ts:1444`) — deliberate MQTT/REST parity. A plan is *fresh* only when `basisComplete && age < PLAN_STALENESS_MS` (12 h = 43 200 000 ms, design I12): numeric fields are null and `charge_tonight` strictly `false` otherwise, so a dead or wedged advisor (the host power-cycles daily) can never leave a stale ON. The window strings are informational (published whenever the plan carries a window) and **day-qualified beyond 24 h** via `fmtPhoenixDayHm` — `"23:00"` within a day, `"Mon 00:00"` beyond — so a Saturday plan resolving Monday's window is never presented as tonight's (v1.39.0).

**HA MQTT-discovery entities** (all carry `expire_after = 90 000 s` (~25 h) so the once-nightly cadence doesn't trip expiry but a dead add-on flips them to `unavailable` — a retained `charge_tonight=ON` from a dead advisor would be worse):

| Entity | Type | Content |
|---|---|---|
| `ecoflow_night_charge_recommended` | binary_sensor | `charge_tonight` — the single flag an owner automation gates on |
| `ecoflow_night_charge_target_soc` | sensor (%) | Target pool SoC by window close |
| `ecoflow_night_charge_buy_kwh` | sensor (kWh) | Recommended meter-side buy |
| `ecoflow_night_charge_window_start` / `_end` | sensor (string) | Day-qualified Phoenix `HH:MM` window bounds |
| `ecoflow_night_charge_readiness` | sensor (diagnostic) | `LEARNING` / `READY_TO_CONSIDER_WRITES` / `BLOCKED` |
| `ecoflow_night_charge_write_ready` | binary_sensor (diagnostic) | Fail-closed gate boolean |

The remaining gate diagnostics (`night_charge_under_buy_rate`, `night_charge_band_coverage_pct`, `night_charge_plan_nights_scored`, `night_charge_effective_n`, `night_charge_forecast_basis_pct`, `night_charge_exclusion_fraction`) ride the same payloads without dedicated discovery entities.

**`GET /api/night-charge/status`** (`index.ts:3180`): `{ enabled, mode:'advisory', window, reserveFloorPercent, confidence, notify:{hour,minute,lastNotifyDay}, plan, readiness, recentOutcomes }`. `reserveFloorPercent` is read live from `projection.backupReserveSoc` — the same field the floor alarm defends. `recentOutcomes` is an in-memory mirror of the last 7 ledger days refreshed by the timers, so the request handler never touches the DB inline (CWE-770). No auth: read-only, exposes no secrets, actuates nothing.

**Notification** (`buildNightChargeMessage`, `notify.ts:245`): three shapes — `charge` (buy kWh, target SoC, low-SoC without vs with the buy, floor+cushion line, confidence, honest shortfall/over-buy notes, and the advisory automation contract), `hold` (no charge needed), and `insufficient_basis` (sent so the *absence* of a plan is explicit — the owner never wonders if the job died; a null plan can only ever render this shape regardless of the requested one). All severity `info` with a single `dedupId: 'night_charge_plan'` so the nightly message lands in **one updating card**, and dispatched via a *direct* `sendNotification` that bypasses quiet-hours and min-severity (design I10) — a plan queued past the charge-window open is worse than none. `NIGHT_CHARGE_NOTIFY_ON_HOLD=false` suppresses hold-night sends (still latching the day).

**TUI**: the Strategy screen renders a `TONIGHT'S PLAN` block (`telnet/screens.ts:1153`) from a 12 h staleness-gated accessor (`dataProvider.nightChargePlan` — present ∧ `basisComplete` ∧ fresh, else one grey line), formatted through the *same* `nightChargeStateFields` so the terminal and the HA entities never disagree. It is deliberately distinct from the adjacent `CHARGE SCHEDULE` block (the SHP2's native `timeTask` config). **Web**: `NightChargeCard` on the Strategy panel — zero-prop, self-fetching `/api/night-charge/status` on a 60 s poll, with its own matching 12 h client-side staleness guard; a null/incomplete/stale plan renders the grey "unavailable" shape, never a fabricated number.

---

### 10. Configuration

Add-on options (`config.yaml` → env):

| Option | Default | Range | Meaning |
|---|---|---|---|
| `NIGHT_CHARGE_ADVISOR_ENABLED` | `true` | bool | Master switch for the timers + surfaces (env compare is `!== 'false'`) |
| `ARB_OUTAGE_CUSHION_PCT` | `15` | int 0–40 | Cushion % above the reserve floor the trough must hold; never changes the independent floor alarm |
| `ARB_MIN_BUY_KWH` | `1` | float 0–50 | Below this recommended buy, the night is a "hold" |
| `ARB_CHARGE_CAP_KW` | `7.2` | float 0–50 | Grid-charge power ceiling used by the feasibility cap (the live `chChargeWatt`); sizing only, no device is ever set |
| `ARB_LOAD_P90_FACTOR` | `1.15` | float 1–2 | Pessimistic-high load multiplier on the day-ahead forecast |
| `NIGHT_CHARGE_NOTIFY_HOUR` / `_MINUTE` | `21` / `30` | runtime-clamped int 0–**22** / 0–59 | Evening-job fire time; hour is clamped to ≤ 22 because the catch-up window is `[fire, 23:00)` — hour 23 made it the empty set (v1.39.0) |
| `NIGHT_CHARGE_NOTIFY_ON_HOLD` | `true` | bool | Send the nightly advisory even on hold nights (consistent "the job ran" confirmation) |
| `TARIFF_APS_*_CENTS` ×6 | `""` | str | Per-period effective ¢/kWh from a bill (§3 table); empty = unconfirmed |
| `TARIFF_APS_RATES_CONFIRMED` | `false` | bool | While false, **every** `$` output is null regardless of entered rates |

Env-only knobs (not in the options form): `NIGHT_CHARGE_LATCH_PATH` (latch file location; defaults beside the DB), `EV_MAX_LOAD_W` (default `11520` — the per-hour EV block cap, shared with the EV detection engine), and the shared efficiency seams `DISPATCH_ROUND_TRIP_EFFICIENCY` (default `0.86`, clamped [0.8, 1]; the advisor's charge leg is its square root ≈ 0.927) and `RUNWAY_DISCHARGE_EFFICIENCY` (default `0.94`, clamped [0.8, 1]) — both injected from `analytics.ts`, never re-declared.

---

### 11. Failure modes & known limitations

- **Basis-completeness gate.** No plan is sized unless the probabilistic band exists, the confidence tier is not climatology, `calScoredDays ≥ 14`, *and* realized band coverage ≥ 0.9. On a young install (or after a forecast-model reset) the advisor publishes the explicit `insufficient_basis` shape nightly — this is by design, not a fault.
- **SHP2 offline / missing battery fields** ⇒ `recomputeNightChargePlan` returns null and the holder keeps the prior plan until the 12 h staleness guard nulls the surfaces and the ~25 h `expire_after` flips the HA entities to `unavailable`. The scorer likewise cannot source actuals while the SHP2 projection is absent; affected nights land as MNAR exclusions, which the gate's expected-nights denominator counts against readiness.
- **Weekend tariff boundary (open question).** The model's per-instant weekday gating makes Friday's window Fri 23:00–24:00 only (Sat 00:00–05:00 is weekend off-peak) with the next window opening Mon 00:00 — a ~48 h carry sized against a 1-hour charge window (charge-power capped, `cushionShortfall` honestly flagged) on a mostly `mixed`-tier basis that never enters gate eligibility. Whether real APS billing extends Friday's overnight into Saturday morning can only be settled from a bill; if it does, the correction belongs in `tariff.ts` weekday gating. Rates are null until confirmed, so no `$` output depends on the answer.
- **Hardware charge envelope is an open datum.** `ARB_CHARGE_CAP_KW` reflects the observed `chChargeWatt` (7.2 kW), not a verified hardware spec; the feasibility cap is only as accurate as this knob.
- **Advisory-only, twice over.** The add-on performs no writes in any state, and `READY_TO_CONSIDER_WRITES` unlocks only *consideration* — the eventual write path is separately deferred behind a probe, an owner toggle, and the safety spine. During the advisory phase the realized-need counterfactual is defensible only on clean (near-zero-import) nights, so grid-propped nights are excluded from scoring rather than fabricated.
- **Pre-v1.39.0 ledger rows** carry no stored window and are permanently unscoreable (captured as `scored=0` with an explanatory note); nights whose raw telemetry has aged past the 30-day samples retention capture honestly unscored rather than staying open forever.
- **The calibration learner is not yet live.** `night_charge_calibration` (seasonal cushion, buy de-bias, EV-tail inflation) exists as schema + API only; the cushion remains the static `ARB_OUTAGE_CUSHION_PCT` until the learner ships as its own increment.

---

All verification complete. Composing the appendix now from the verified consumer graph.

---

## Appendix A — Feature Inventory (evidence linkage)

Purpose: a pruning-oriented ledger of every substantive feature/engine, what math it runs, which field signals feed it, and — decisive for keeping it — **what actually consumes its output**. Consumer columns were verified by grepping the pinned source revision (`git grep … HEAD -- server/src web/src lovelace/src`), not by reading intent from comments. Evidence status is one of:

- **measured-and-active** — output is consumed by at least one live surface (alarm, HA sensor, UI card, TUI screen, or another engine) and the math has operated on real field data.
- **data-gated (…)** — wired and correct, but a stated gate holds the output at `null`/inactive until the field record satisfies it; the parenthetical names what unlocks it.
- **advisory-dormant** — deliberately advisory or deliberately not wired (documented posture, not an accident).
- **weak-linkage candidate** — no consumer beyond its own ad-hoc endpoint, or math that has never received field validation; one-line justification given. These are the removal-review set collected at the end.

Diagnostic endpoints with a documented validation role (e.g. the forecast backtest) are not flagged merely for lacking an automated consumer; endpoint-only engines with no validation role are.

### A.1 Ingest, storage & threading (§1, §2)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| `SnapshotStore` dual-schema ingest | Two caches (REST `rawBySn`, MQTT `mqttFlatBySn`), single `change` fan-out with `frameSeq` (§1.1, §1.3) | REST `/device/list`+`/quota/all` (60 s poll); MQTT `/open/{user}/{sn}/quota`,`/status` | recorder, analytics worker, `/ws`, alert monitor, MQTT discovery — every downstream | measured-and-active |
| DPU MQTT→REST translation | `translateDpuMqtt()` cmdId schema → `hs_yj751_*` quota shape; only DPUs drive live projection from MQTT (§2) | DPU cmdId frames (`bpInfo[].*`) | `SnapshotStore` projection refresh | measured-and-active |
| Product projections | `projectByProduct()` → typed dpu/shp2/generic `Projection` (§2) | Raw quota maps | Every engine, UI, sensors | measured-and-active |
| Backup-pool grace-hold + slew guard | `backupPoolWithGraceHold` holds last-good pool through transient nulls; slew-limits implausible jumps (§2) | SHP2 `backupIncreInfo.*` (aggregate `backup{Remain,FullCap}Wh`, `backupBatPercent`) | Runway, SoC alarm, HA `backup_pool` sensors | measured-and-active |
| SQLite recorder | `record(extract(snap))` with dedupe/heartbeat, retention, WAL; read-only worker twin `readRecorder.ts` byte-parity-tested (§1.4) | All projected metrics | Every history-driven engine | measured-and-active |
| Lifetime accumulators | `rollupLifetime()` monotonic Wh counters; steady-state RTE clamp (`charge == discharge` by design) + micro-dip clamp `clampLifetimeDip` (§1.4.6, §7.2) | `pv_total`, `panel_load`, `ac_in`, `grid_home_w`, pack in/out | `/api/lifetime-energy`, HA Energy Dashboard `*_lifetime_kwh` | measured-and-active |
| Telemetry-gap detection | Recorder gap scan → outage/gap events (§1.4.7) | Sample timestamps | `/api/telemetry-gaps`, `outageAlerts()`, HA `system_outage_*` / `system_telemetry_gap_count_24h` | measured-and-active |
| Trapezoidal integration | `integrateWh` gap-aware trapezoid; shared day-boundary endpoint (§1.5, §7.0.1) | Any W-metric series | selfConsumption, RTE, tariff, carbon, totals, circuit history | measured-and-active |
| Analytics worker + report registry | Worker thread, `BUILDERS` registry, coalesce + TTL cache, `WARM_REPORTS` self-warm (§1.6, §1.8) | — (infrastructure) | All `/api/<report>` routes, MQTT state, TUI | measured-and-active |
| `lastUpdated` freshness contract | SHP2 MQTT chatter must not touch the freshness clock; REST owns non-DPU freshness (§1.7) | Message arrival times | Staleness alerts, grace-holds | measured-and-active |

### A.2 Cloud protocol & HA wiring (§2)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| REST client + HMAC signing | `ecoflow/sign.ts` HMAC-SHA256 request signing (§2) | Cloud credentials (env) | Poll loop | measured-and-active |
| MQTT client (`param`-not-`params` fix) | Per-device quota/status subscription; corrected payload key (§2) | Broker frames | Ingest | measured-and-active |
| SHP2 membership + spare roster | Core↔SHP2 from `backupIncreInfo.Energy{1,2,3}Info`, not positional; explicit spare-SN allowlist (§2, §8.8) | SHP2 energy-info slots; `SPARE_DPU_SNS` env | Zombie gate, selfConsumption scope, degradation peer baselines | measured-and-active |
| Cloud-wedge vs outage classifier | `deviceLink.ts` pure classifier: LAN-reachable + cloud-silent = wedge, both-dark = outage (§2) | LAN ICMP ping, MQTT/REST freshness | Offline alerts, HA `ecoflow_cloud_wedge_count` | measured-and-active |
| HA service layer | `haService.ts` `callHaService` — total, never throws (§2, §10.10) | HA supervisor API | Broadcast, shed registry, hostPower, haStateCache | measured-and-active |
| MQTT discovery entity set | ~50 sensors + ~9 binary sensors, availability + expiry, honest-null templating (§2) | `buildState()` composition | Home Assistant | measured-and-active |
| Energy Dashboard counters | `total_increasing` lifetime kWh set incl. dynamic per-circuit discovery (§2) | Lifetime accumulators | HA Energy | measured-and-active |
| Alarm-priority switches | Bidirectional `switch` per ISA priority; `parseAlertSwitchCommand` no-op on unknown payload (§2) | HA command topic | `alertSettings`, alarm gating | measured-and-active |
| `refreshShp2CloudPresence` write | The one real write; audited (`writeLog.ts`), rate-limited, `requireWriteAuth` (§2, §12) | Operator action | Web `RefreshCloudButton`, cooldown endpoint | measured-and-active |
| `debugSendCommand` | Arbitrary-command escape hatch; off unless write-debug env + token (§2, §12) | Operator action | `/api/device/send-command` | advisory-dormant (disabled by default, by design) |

### A.3 Solar & PV forecast (§3)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| GHI→PV response model | Per-hour through-origin OLS `β = Σ(pv·ghi)/Σ(ghi²)`; `peakCoeff` gated on GHI ≥ 300 W/m² + ≥3 samples (§3.1) | Recorder `pv_total`, Open-Meteo GHI | `getDayForecast`, `SolarResponseCard`, backtest | measured-and-active |
| Full-coverage fitting gate | `fullCoverageFleetPv` excludes cloud-gap hours from fitting (§3.1) | Per-Core coverage | Response model | measured-and-active |
| Day-ahead forecast | Per-hour `forecastPvW`/`forecastLoadW`; PV bias correction; structural-incompleteness gate; restored display basis (§3.2) | Response model, weather, load history, EV prediction | Runway, runway/forecast alarms, HA sensors, cards, TUI, calendar, MPC | measured-and-active |
| PV bias correction | `pvBiasFactor = Σactual/Σpredicted` multiplier (§3.3) | Forecast vs recorded PV | Day-ahead forecast, `/api/confidence` | measured-and-active |
| EV-window prediction | `computeEvWindowPrediction` expected-value `evLoadByHour`; subtracted from the alarm load (safety invariant §5.1.5) | EVSE circuit history | Forecast load, runway (subtraction), calendar, insights cards | measured-and-active |
| Forecast skill | Day-level replay MAE/bias/r² over covered days (§3.4) | Forecast archive vs actuals | Probabilistic band calibration, `/api/confidence.forecastDayR2`, repair issues, insights | measured-and-active |
| Confidence snapshot | Medians of engine r² + forecast bias/MAE (§3.5, §8.10) | degradation, thermal, skill reports | `/api/confidence`, insights cards | measured-and-active |
| Probabilistic P10/P90 SoC band | Per-hour sigma + coherent SoC ensemble; F30 self-calibrating shrink over `PV_BAND_CAL_WINDOW_DAYS = 30` (§3.6) | Forecast + skill | `/api/forecast/probabilistic`, Lovelace solar-card, MPC P10 envelope | measured-and-active; band **calibration** data-gated (needs ≥14 scored days in the 30-day window) |
| Multi-day horizon | `computeMultiDayForecast` extends PV/SoC 2–3 days on typical-day curves (§3.7) | Forecast + weather | `/api/forecast/multi-day` only — no UI, TUI, HA, or engine consumer | **weak-linkage candidate** — output consumed by nothing |
| Open-Meteo ingestion | GHI + temp hourly fetch, cached (§3.8) | Open-Meteo API | Forecast, curtailment, thermal, shade | measured-and-active |
| NWS NDFD ensemble | Opt-in second cloud source + disagreement metric (§3.8) | NWS NDFD (`NWS_ENABLED`) | `/api/weather/ensemble`, insights cards | data-gated (off unless `NWS_ENABLED`) |
| NWS storm alerts | CAP alert fetch → alert/calendar/broadcast context (§8.3.4) | NWS CAP feed | `forecastDayAlerts`, calendar, insights cards | data-gated (off unless `NWS_ENABLED`) |
| Forecast backtest | `backtestPvForecast` RMSE/MAE/bias/R² replay incl. the alarm-facing predictor (F24) (§1.8) | 168 h recorder actuals | `/api/backtest/forecast` (operator-invoked validation harness) | measured-and-active (validation instrument; no automated consumer by design) |

### A.4 Physics & Bayesian tier (§4)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Clear-sky PV model | Solar geometry → `clearSkyGHI` → POA → cell-temp derate → `physicsPmax`; `physicsScore = realized/theoretical` (§4.1) | Site constants, ambient temp, live PV | `/api/physics/pv-pmax` only (referee role is manual; `PHOENIX_SITE.pNamplate` is separately load-bearing in `BAYES_OBS_SIGMA2`) | **weak-linkage candidate** — no automated cross-check consumes `physicsScore` |
| LFP OCV→SoC + rest tracker | OCV lookup on rested packs (`REST_CURRENT_THRESHOLD_A = 0.5`, 60 s tick) → `socDriftPct` vs BMS (§4.2) | `bmsMaster` volts/amps per pack | `/api/physics/lfp-soc` only | **weak-linkage candidate** — drift feeds no alarm/engine; tick runs regardless |
| Hierarchical Bayes pack SoH | Partial pooling `fitHierarchical` + `findOutliers(z ≥ 2.0)` (§4.3) | Per-pack SoH cross-section | `/api/models/hierarchical-pack-soh` only | **weak-linkage candidate** — endpoint-only; near-new fleet has produced no outlier to validate against |
| Recursive Bayesian solar model | Per-hour Gaussian posterior over GHI→PV slope with `agreementWithOls` (§4.4) | Recorder pv/GHI pairs | **Curtailment expected-PV** (`predictExpectedPv`), `/api/forecast/bayesian` | measured-and-active |
| Kalman SoH filter | 2-state constant-velocity filter (`R = 0.05`) run side-by-side with OLS fade; mirrors every OLS gate (§6.8) | `sohPts` per pack | `kalman*` fields inside `/api/degradation` | measured-and-active (parallel diagnostic inside a consumed report) |

### A.5 Runway, depletion & SoC alarms (§5) — safety-critical

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Runway depletion simulation | DC-bus drain `delta = pv − load/η` (`RUNWAY_DISCHARGE_EFFICIENCY`), interpolated reserve/empty crossings, 4 h observed-load `max()` blend, 50 W degenerate-curve guard (§5.1) | SHP2 pool fields, `panel_load` history, day-ahead forecast, `backupReserveSoc` | Audible alarm, HA runway sensors, `RunwayCard`, fleet-card, TUI, shed advisor | measured-and-active |
| Empty hysteresis | `applyEmptyHysteresis` de-flaps the published hours-to-empty (§5.1.6) | Raw crossing | Published runway | measured-and-active |
| Runway severity ladder | `classifyRunway(p, grid)` bands + grid-aware null while backstopping; islanded re-escalation (§5.2) | Runway + grid backstop | Alarm state machine, shed advisor, TUI banners | measured-and-active |
| Runway alarm state machine | `createRunwayAlarm` edge-triggered spoken alarms (§5.2.4) | Severity band | Audible path, notify | measured-and-active |
| Battery-SoC floor alarm | Ladder 50/40/30/20/15/10/8/4/2 % with arming hysteresis + coherence guard (% vs `remainWh/fullCapWh`) against transient zeros (§5.3) | `backupBatPercent`, pool Wh | Audible path, HA alert counts, banding helpers | measured-and-active |
| SHP2-blind failover | Fleet-median DPU SoC drives the ladder when the SHP2 aggregate is absent (§5.3.7) | Per-DPU `soc` | SoC alarm | measured-and-active |
| Grid backstop resolver | `resolveGridBackstop`/`liveGridBackstop` combine `gridSta` (0/1/2), grid watts, staleness fail-safe; `backstopping` stricter than `present` (§5.4) | SHP2 `pd303_mc.masterIncreInfo.gridSta`, `grid_home_w` | Alarms, `off_grid` sensor, lighting posture, TUI, analytics | measured-and-active |
| Grid-aware SoC dispatch | `socGridCrossDecision` downgrade on-grid + `reEscalateGridDrop` on islanding (§5.4.5) | SoC bands + backstop | SoC alarm tick | measured-and-active |
| Load-shed advisor | Upper-bound counterfactual `computeRunwayWithShedOffset` (`shedKw/η` on pool basis); recommends only in actionable band with ≥ 0.25 h benefit (§5.5) | Runway, HA entity watts (`haStateCache`), SHP2 circuits | `load_shed_recommended*` sensors, `/api/load-shedding/status`, `runway_to_reserve_if_shed_hours` | data-gated (inactive until `LOAD_SHEDDING_SHED_ENTITIES` allowlist is configured; advisory-only by design) |
| Load-shed registry | Candidate composition: SHP2 circuit → HA sensor → estimate; phantom-entity flagging (§5.5) | Allowlist + HA states | Shed advisor, StrategyPanel/TUI priority displays | data-gated (same allowlist) |

### A.6 Battery & PV health (§6)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| SoH fade + EOL projection | OLS fade `−slope×YEAR_MS` ±1 SE, Arrhenius `2^((T−25)/10)`, 7-state gate chain, `EOL_SOH = 80` (§6.1) | `actSoh`/`soh`, `pack{n}_temp`, cycles | HA `..._soonest_pack_eol`, `DegradationCard`, battery-card, TUI, pack-risk, confidence, repair issues | measured-and-active; dated EOL data-gated (fade gates on near-new fleet — `unknown` by design) |
| Peer fade comparison | Robust median+MAD z on projecting, connected packs; spares scored, never baseline (§6.1) | Fade rates | Degradation summaries | data-gated (needs ≥3 projecting packs) |
| Coulombic efficiency (F17) | 7-day counter-edge ratio with span/full-window/consistency triple gate (§6.2) | `pack{n}_lifetime_{chg,dsg}_mah` edges | `coulombicEffPct` in degradation; pack-risk feature 3 | data-gated (all three F17 gates; null on current counters by design) |
| Round-trip efficiency | Day-level `discharged/charged` in [0.8, 1.05] with ≥50 % coverage; ≤100 clamp; v0.65.0 extended-lookback backstop (§6.3) | Pack in/out integrals | HA RTE sensor, `DegradationCard`, battery-card, MPC cycling cost | measured-and-active |
| Internal resistance | Steady-state-filtered `dV/dI` (≥5 A steps, sign-checked F27), median recent vs baseline, gated trend (§6.4) | `bmsMaster` V/A pairs | `/api/internal-resistance`, insights, pack-risk feature | data-gated (trend needs r² ≥ 0.3, 14 d span; currently immature by design) |
| Charge-curve fingerprint | Median V drift at SoC checkpoints [40, 60, 80, 95] % during active charge; baseline vs recent 14 d windows (§6.5) | V + SoC + input W | `/api/charge-curve`, insights, pack-risk feature 5 | measured-and-active (holds at `baseline` until ~28 d span) |
| Ambient-thermal forecast | 2-var least squares `pack_temp ~ ambient + load`; 24 h predicted peak (§6.6) | `pack{n}_temp`, weather, in/out | `/api/ambient-thermal-forecast`, insights, `thermalMedianR2` | measured-and-active |
| Thermal-event counter | Rising-edge events at 35.6/45/55 °C with 1.5 °C hysteresis; gap-capped time-above; `hardLifeScore` (§6.7) | `pack{n}_temp` raw | `/api/thermal-events`, insights, pack-risk feature | measured-and-active |
| Pack-risk v1 heuristic | Weighted six-feature composite (fade, thermal, IR, CE, curve-drift, cycles) (§6.9) | Health reports above | `/api/pack-risk` + input to v2 only | **weak-linkage candidate** — no alarm/UI/sensor reads either pack-risk endpoint |
| Pack-risk v2 ML | Logistic regression + novelty + auto-downgrade gate; heuristic-pinned below `PACK_RISK_MIN_TRAINING_SAMPLES = 100` (§6.10, §9) | LR features + shadow model | `/api/pack-risk/v2` only | **weak-linkage candidate** — endpoint-only AND gate-pinned (≥100 labeled outcomes required); no field validation event yet |
| String mismatch | Per-DPU PV ratio vs fleet at same hour, robust median+MAD (§6.11) | Per-Core `pv_total` | `/api/string-mismatch`, insights cards | measured-and-active |
| Soiling decomposition | Per-Core soiling estimate; published fleet figure = per-Core **median** (v0.63.0 anti-deflation); F29 multi-week weather backfill (§6.12) | Per-Core PV, GHI | `/api/soiling-decomposition`, `/api/debug/soiling`, insights, solar-card, repair issues | measured-and-active (validated against a real soiling event and a false-alarm fix) |
| Shade report | Recurring same-hour shortfall vs clear-day reference, `SHADE_DROP_THRESHOLD = 0.18`, ≥`SHADE_MIN_CLEAR_DAYS = 5`, per-Core median (§6.12 note) | Per-Core PV, weather | `/api/shade-report`, insights, solar-card | measured-and-active |
| Inverter clipping | Flat-top detection vs forecast peak (§6.13, §7.7) | `pv_total`, forecast | HA clipping sensor, solar-card | measured-and-active |
| Equipment health | MPPT ratio series + inverter standby `cappedMedianEffPct` (§6.14) | MPPT in/out, standby W | `/api/equipment-health`, insights, repair issues (−3 pp MPPT drift gate) | measured-and-active |

### A.7 Energy accounting, cost & dispatch (§7)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Self-consumption / solar fraction | Grid-displacement form `(load − gridForKpi)/load`; PV↔battery↔grid apportionment; coverage gate `GRID_HOME_MIN_COVERAGE = 0.9` (§7.1) | `pv_total`, `panel_load`, `ac_in`, `grid_home_w`, pack in/out | HA sensors, insights, carbon, tariff | measured-and-active |
| Two-grid-quantities discipline | `gridImport` (DPU `ac_in`) vs `gridToHome` (SHP2 `grid_home_w`); KPI picks trusted superset (§7.0.2) | Both grid metrics | selfConsumption, tariff, HA Energy wiring | measured-and-active |
| Carbon accounting | `gridDisplacedKwh × 0.4990 kg/kWh` (`GRID_CO2_INTENSITY_LB_PER_MWH = 1100`); capped part-sum (§7.3) | selfConsumption output | `/api/carbon`, HA carbon sensor | measured-and-active |
| Legacy tariff report | Hourly `onPeakAt` walk; `TARIFF_FLAT_CENTS_PER_KWH = 17` default; whole-home superset (audit #5) (§7.4) | Grid + load integrals | `/api/tariff`, HA `tariff_*` sensors | measured-and-active |
| Greedy dispatch plan | Per-hour charge/discharge/import branches, `legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY` (0.86 → ≈0.927), reserve guard on drawn amount (§7.5) | SoC, forecast, tariff constants | `/api/dispatch-plan`, Lovelace strategy-card | measured-and-active (advisory-only by design) |
| MPC dispatch recommender | Rolling DP over 24 h with P10 risk branch, degrade detection, `reserveDipPenaltyUsdPerKwh = 1.0` (§7.6) | Forecast, probabilistic band, RTE, legacy flat-tariff env (not `tariff.ts`) | `/api/dispatch/recommend` only — no card, sensor, or engine | **weak-linkage candidate** — endpoint-only; tariff basis diverges from the canonical R-EV model |
| SoC-saturation curtailment | Bayesian expected-PV gap vs live PV above dynamic charge ceiling `homeChargeCeilingPct()`; surplus W + kWh history (§7.8, §14.2) | SoC, `pv_total`, GHI, circuits | `pv_curtailment_*` sensors, `CurtailmentCard`, lighting posture `surplus` trigger, curtailment alerts | measured-and-active |

### A.8 Alerts, incidents & learning loop (§8, §9)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Alert taxonomy + ISA priority | `Alert` shape; ISA-18.2/IEC 62682 priority derivation (§8.1) | — | Everything alert-adjacent | measured-and-active |
| Threshold alerts | `computeAlerts()` temp/SoC/offline/reserve bands incl. LFP top-of-charge relaxation (§8.2) | Projections, connectivity, grid | Monitor → notify/audible/sensors/UI | measured-and-active |
| Outage events | `outageAlerts()` power-loss vs telemetry-gap events (§8.2.3) | Gap detection | Monitor, HA outage sensors | measured-and-active |
| Peer-comparison learned alerts | Robust median+MAD cross-fleet outliers (§8.3.1) | Fleet projections | Monitor | measured-and-active |
| Self-baseline alerts | Per-device baseline drift (§8.3.2) | Recorder history | Monitor | measured-and-active |
| Degradation/runtime forecast alerts | Trailing-3h runtime + SoH-decline with `SOH_FORECAST_*` gates (§8.3.3) | Degradation, forecast | Monitor | measured-and-active |
| Day-ahead solar/load alerts | `forecastDayAlerts(df, grid)` incl. storm context (§8.3.4) | Forecast, NWS | Monitor | measured-and-active |
| Alert monitor | 20 s eval; rising-edge debounce, dwell, dispatch decision (§8.4) | All alert sources | notify, broadcast, incidents, persistence | measured-and-active |
| Quiet hours + morning digest | `NOTIFY_QUIET_HOURS` (default `22-06`), `CRITICAL_BREAKS_QUIET_HOURS` (default false), digest at `NOTIFY_DIGEST_HOUR = 7` (§8.4.2) | Wall clock | notify queue | measured-and-active |
| Incident clustering | `buildIncidents(alerts)` correlation grouping (§8.4.3) | Live alerts | `/api/incidents`, insights cards | measured-and-active |
| Cooldown auto-silence | Churn detection → temporary silence (§8.4.4) | Fire history | Monitor | measured-and-active |
| Notification delivery | ntfy/Pushover/webhook/HA channels, dedupe, digest (§8.5) | Monitor decisions | Operator push | measured-and-active |
| Feature snapshots | `featureSnapshot.ts` captures LR feature vector once per rise (§8.6, §9.1) | degradation/thermal/IR/chargeCurve reports | Outcome→LR training join | measured-and-active (scaffolding for the gated loop) |
| Outcome capture | `POST /api/alerts/outcome` labels + family precision rollups (§8.6, §9.2) | Operator button presses (web/Lovelace) | LR update, `/api/alerts/outcomes/stats` | measured-and-active |
| Online LR (SGD) | `updateFromOutcome` shadow-only step + prequential loss (§9.3) | Snapshots + labels | Shadow model → pack-risk v2 gate | data-gated (gate floor 100 samples; no promotion path by design) |
| Model health + gate | `computeGateDecision` samples/drift/precision policing (§9.4) | Shadow model state | `/api/models/health`; gate applied inside `computePackRiskV2` | data-gated (same floor; report endpoint has no other consumer) |
| Machine alert telemetry | `alertTelemetry.ts` structured fire/resolve log (§8.6) | Monitor events | `/api/alert-telemetry` only | **weak-linkage candidate** — machine-readable diagnostic no tool ingests |
| Repair issues | `computeRepairIssues` composes degradation+soiling+equipmentHealth+skill into repair cards (§8.7) | Those four reports | `/api/repair-issues` only — no UI/HA surface renders it | **weak-linkage candidate** — endpoint-only composition of already-surfaced engines |
| Zombie gate | Spare-DPU offline-alert gate via explicit SN allowlist (§8.8) | `SPARE_DPU_SNS` | Offline alerting | measured-and-active |
| Root-cause map | `rootCausesFor(alertId)` static cause suggestions (§8.9) | Alert id | `/api/root-cause` only | **weak-linkage candidate** — no UI passes an alert id to it |
| Annunciation settings | `alertSettings.ts` per-priority enable + chime repeat, MQTT-bidirectional (§8.11) | Operator toggles | Alert Console, HA switches, broadcast gating | measured-and-active |

### A.9 Audible broadcast & TTS (§10)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Condition derivation + tick | `conditionFromAlerts` → level; 10 s tick with boot-grace, priority and settings gates (§10.2) | Live alerts | Speaker/SIP announcements | measured-and-active |
| Alarm-storm gates | Identical-message and per-level repeat suppression; escalations always play (§10.2.3) | Broadcast history | Tick loop | measured-and-active |
| MA + SIP dispatch | Media-player pre-flight + verification; per-target volume pin; `BROADCAST_SIP_TARGETS` side-channel (§10.3) | HA media players, SIP endpoint | Household audible path | measured-and-active |
| Announcement renderer | Chime + TTS layout, per-language terminator, content-keyed cache (§10.4) | Level + message | Broadcast, browser/speaker test paths | measured-and-active |
| Tone library + chime packs | Four level klaxons + named built-ins, version-gated regeneration (§10.5) | — | Renderer | measured-and-active |
| Operator tones + per-level assignment | `chimeStore.ts` uploads; `chimeConfig.ts` level→chime map (§10.6–10.7) | Operator uploads | Alert Console, renderer | measured-and-active |
| TTS build + verbalizer | `buildAlertMessage` → `verbalizeForTts` (idempotent normalizer); optional second-language pass (§10.8) | Alert facts | Renderer | measured-and-active (second language data-gated on config) |
| Wyoming/Piper client | Raw-PCM synth over Wyoming protocol, `en_US-lessac-medium` (§10.9) | Piper add-on | Renderer | measured-and-active |
| Runtime config two-layer | Env baseline + live override file; `resolveAnnounceVolume` (§10.11) | Operator PUT | Broadcast | measured-and-active |
| Audible-delivery health | `broadcastHealth.ts` reachability probes → `audible_channel_status` + self-alert (§10.13) | MA/SIP probe results | HA sensors, alert monitor | measured-and-active |

### A.10 Night-charge advisory stack (v1.36–v1.39; no chapter yet — `tariff.ts`, `nightChargeAdvisor.ts`, `nightChargeGate.ts`)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| APS R-EV tariff model | `buildApsREvModel`/`rateAt`: 4-period, 2-season, weekday-literal windows; unconfirmed rates resolve to `null` cents (fail-safe) | Env rate config (`apsREvRatesFromEnv()`; no price API exists) | Night-charge advisor + gate | measured-and-active |
| Night-charge plan | `computeNightChargePlan`: deep-shortfall buy sized by **bisection against a clamp-exact with-buy re-sim trough** (never additive offset); `legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.927` | Day forecast, probabilistic band, SoC/pool, tariff windows, EV commitments | Evening notify (bypasses quiet hours as a plan advisory), HA `charge_tonight` sensors, `/api/night-charge/status`, `NightChargeCard` | measured-and-active (**advisory-only — the add-on never writes `backupReserveSoc`**) |
| Plan staleness fail-safe | `nightChargeStateFields`: `charge_tonight` strictly `false` unless plan < 12 h old (`PLAN_STALENESS_MS`) | Latest plan timestamp | HA sensors, `/api/ha-state` | measured-and-active |
| Night ledger + outcome scorer | Never-pruned `night_charge_ledger`/`_calibration`; `scoreNightOutcome` against the ledger's **stored per-plan window** (weekend windows are disjoint from weekday 23:00–05:00); premature-capture repair; grid-import-propped baselines refused a score | Recorder actuals over the plan window | Readiness gate, status endpoint, card | measured-and-active |
| Write-readiness gate | `computeNightChargeReadiness`: ≥60 scored forecast-backed nights, effective-N ≥ 45, underbuy ≤ 10 %, PV/load MAE ≤ 20 % and \|bias\| ≤ 10 %, band coverage 0.78–0.92, exclusions ≤ 35 %, ≥90 in-season days | Ledger rows | HA `write_ready` flag (strictly false on failure), status endpoint | data-gated (unlocks only when every criterion holds; the write path itself is intentionally not implemented) |

### A.11 Safety & operational plumbing (§13)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| `processGuard` | Top-level crash classification + survival policy (§13.1) | Uncaught errors | Process lifetime (safety-critical) | measured-and-active |
| `hostPower` | Pi under-voltage interpretation with `HOST_POWER_MAX_AGE_MS = 120 000` staleness (§13.2) | HA entity named by `HOST_POWER_ENTITY` | Self-alert via `alerts.ts` | data-gated (inert until `HOST_POWER_ENTITY` is configured) |
| `haStateCache` | TTL-gated entity-watts cache + `extractEntityWatts` (§13.3) | HA states API | Shed advisor, hostPower | measured-and-active |
| `alertOnset` | Restart-persistent alarm onset timestamps, clear-then-rise semantics (§13.4) | Alert edges | Monitor, TUI ALM screen | measured-and-active |
| Message-rate floor | Per-SN healthy-only EWMA baseline; collapse < 0.2× baseline sustained 20 min → edge-triggered P3 alert (§13.5) | Cumulative MQTT message counters | Alert monitor self-alert (defeats the "looks fresh" wedge trap) | measured-and-active |
| Log/format hygiene | `logCoalesce` storm suppression, `logSanitize` bounds, `mqttStartClassify` boot-grace levels, `haPayloadFmt` shared formatting (§13.6) | Log/publish paths | All logging + HA payloads | measured-and-active |

### A.12 UI surfaces & automation posture (§11, §14)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| `/ws` snapshot spine | Throttled full-snapshot frames (§11.0) | SnapshotStore | Web dashboard, wsConsole | measured-and-active |
| Web dashboard (React PWA) | Tabs: Dashboard/Solar/Battery/Strategy/Alerts/Console (§11.1) | `/ws` + 30+ `/api/*` | Operator | measured-and-active |
| Telnet TUI | Plant Operator + Summary consoles, DoS-hardened, port 2323 (§11.2) | dataProvider (`totals`/`forecast`/`degradation`) + snapshot | Operator | measured-and-active |
| HACS Lovelace cards | fleet/solar/battery/circuit/alerts/insights/strategy cards, shared per-host store, CORS allow-list (§11.3) | `/api/*` (verified per-card set) | HA dashboards | measured-and-active |
| Lighting posture | `rawPosture` ladder (critical/red ≤ 4 h/amber/conserve < 35 % dawn/surplus/normal) + asymmetric 15-min de-escalation hold + restart persistence (§14.1) | Runway, dawn-min SoC, reserve, curtailment, grid backstop | HA `lighting_posture`(+`_reason`) sensors → HA-side automations | measured-and-active |
| Surplus / opportunistic loads | Curtailment surplus vs hardcoded load catalog (`fitsInSurplus = surplus ≥ estimatedW`) (§14.2) | Curtailment report | Curtailment endpoint/card fields | measured-and-active (catalog hardcoded; `haServiceHint` always `null` — Phase-2 actuation not implemented) |
| HVAC posture | Two `category:'hvac'` catalog entries only; no posture sensor, no thermostat actuation (§14.3) | — | — | advisory-dormant (documented DORMANT) |

### Candidates for removal review

Consumers verified at the pinned revision; deleting an engine also deletes its listed route/fields. Items are candidates for *review*, not verdicts — each line states the linkage failure.

1. `server/src/analytics.ts:computeMultiDayForecast` (+ `multiDayForecast` builder, `/api/forecast/multi-day`) — no UI, TUI, HA, or engine consumer.
2. `server/src/dispatch/mpc.ts:recommendDispatch` (entire module + `/api/dispatch/recommend`) — endpoint-only; duplicates dispatch-plan territory on a legacy flat-tariff basis that diverges from `tariff.ts`.
3. `server/src/analytics.ts:computePackRiskScores` + `server/src/ml.ts:computePackRiskV2` (+ `/api/pack-risk`, `/api/pack-risk/v2`) — nothing reads either endpoint. Removing v2 orphans the chain `server/src/models/onlineLR.ts` + `server/src/models/modelHealth.ts` + the LR-vector portion of `featureSnapshot.ts`; outcome capture itself should stay (it powers `/api/alerts/outcomes/stats` precision accounting).
4. `server/src/models/hierarchicalBayes.ts:fitHierarchical` (+ `/api/models/hierarchical-pack-soh`) — endpoint-only referee; no automated cross-check.
5. `server/src/physics/clearSky.ts:physicsPmax`/`physicsScore` (+ `/api/physics/pv-pmax`) — endpoint-only. **`PHOENIX_SITE` must survive any removal** (consumed by `BAYES_OBS_SIGMA2` in `analytics.ts`).
6. `server/src/physics/lfpOcv.ts:analyzePackLfp` + `server/src/physics/restTracker.ts` (+ `/api/physics/lfp-soc` and the 60 s rest-tracker interval) — `socDriftPct` feeds no alarm or engine; the tick costs cycles regardless.
7. `server/src/repairIssues.ts:computeRepairIssues` (+ `/api/repair-issues`) — recomposes four already-surfaced engines into cards nothing renders.
8. `server/src/analytics.ts:rootCausesFor` (+ `/api/root-cause`) — no caller passes an alert id.
9. `server/src/alertTelemetry.ts` (+ `/api/alert-telemetry`) — marginal: machine-readable fire/resolve log with no ingesting tool; cheapest to keep, first to cut if the file grows.

Not candidates despite thin linkage: the forecast backtest (`/api/backtest/forecast`) is the validation instrument for the alarm-facing PV model; `debugSendCommand` and the HVAC-posture stub are documented deliberate postures, not orphans.
