## 1. System Architecture & Data Flow

This is the reference for how `ecoflow-panel` moves data from the EcoFlow cloud
to its outputs — HTTP endpoints, the Home Assistant MQTT sensors, the SSH
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
freshness clock (see §1.7, *The `lastUpdated` freshness contract*, below).

---

### 2. Module map

| Module | Thread | Responsibility |
|---|---|---|
| `config.ts` | both | The option table (`OPTIONS`, read through `option(name)`): every add-on option, environment knob and deployment constant with the parse rule its reader applies; the `config` object; lazy-throwing getters for EcoFlow secrets |
| `siteTime.ts` | both | The site clock: one IANA zone resolved at module load, and every local date, hour and clock-text helper (section 12) |
| `siteTimeHa.ts` | main | The site zone's boot log line and the background comparison with Home Assistant's zone |
| `site.ts` | both | Site location, the PV array the physics uses (`pvSite`), the PV strings and the `GET /api/site` payload |
| `limits.ts` / `topology.ts` | both | Plant limits (EV, per-Core charge rate, runway overhead, SoC ladder, opportunistic loads) and device topology (aliases, bench-spare floor, slot names), from the option table |
| `ecoflow/rest.ts` | main | EcoFlow OpenAPI REST client (`listDevices`, `getQuotaAll`) |
| `ecoflow/mqtt.ts` | main | EcoFlow MQTT client; subscribes per-device quota/status topics |
| `ecoflow/mqttTranslate.ts` | main | `translateDpuMqtt()` — DPU cmdId schema → REST quota schema |
| `ecoflow/project.ts` | main | `projectByProduct()` — raw quota → typed `Projection` (dpu/shp2/generic) |
| `snapshot.ts` | main | `SnapshotStore` (live state), `startPollLoop`, `refreshAll` |
| `recorder.ts` | main (write) | SQLite time-series writer, dedupe, lifetime rollup, retention, gap detection |
| `heldSamples.ts` | main (the worker reads the samples generation) | The recorder's freshness gate, the held-span log and the scan that moves held rows to `held_samples` (4.3, 4.4) |
| `energyBridge.ts` | main (the worker reads `bridge_ledger`) | Battery and solar energy of a dark home Core metered at its panel slot, and the per-window rows the Today card reads |
| `readRecorder.ts` | worker (read) | Read-only twin of recorder's read path; parity maintained by convention (§6.1), its own read semantics pinned by `test/worker-offload.test.ts` |
| `aggregator.ts` | worker | Trapezoidal Wh integration (`integrateWh`, `computeTotals`, `circuitHistoryByDay`) |
| `analyticsWorker.ts` | worker | Worker entry: owns read recorder, runs `buildReport`, self-warms caches |
| `analyticsWorkerBootstrap.mjs` | worker | `.mjs` shim that registers tsx's loader then imports the `.ts` worker |
| `analyticsClient.ts` | main | Main-thread proxy: spawn/respawn worker, id-correlate, coalesce + TTL-cache |
| `reports.ts` | worker | The **report registry** (`BUILDERS`), dependency chains, `WARM_REPORTS` |
| `analytics.ts` | worker | The ~560 KB compute engine (forecast, runway, degradation, …) |
| `index.ts` | main | Fastify bootstrap, all HTTP routes, `/ws`, wiring of every subsystem |
| `mqttDiscovery.ts` | main | HA MQTT discovery config + 30s state publish |
| `console/server.ts` | main | SSH control-room TUI (`startSshServer`, port 2323; the directory was `telnet/` until v1.191.6) |
| `alertMonitor.ts` / `alerts.ts` | main | Alarm engine (life-safety path) |

---

### 3. Ingest pipeline (detail)

#### 3.1 REST poll (`snapshot.ts`)

`startPollLoop(store, POLL_INTERVAL_MS, log, warn)` runs `refreshAll(store)` on a
`setTimeout` chain (self-rescheduling; **not** `setInterval`, so a slow poll can't
overlap). Since v1.123.0 the chain is deadline-compensated: the next tick is armed
`intervalMs − poll duration` later (`nextPollDelayMs`), so the period stays constant
instead of stretching by the vendor's own latency.

- `POLL_INTERVAL_MS` default `60_000` (env `POLL_INTERVAL_MS`).
- `refreshAll`:
  1. `store.markDeviceListAttempt()` (records attempt time).
  2. `ecoflow.listDevices()` → `store.setDeviceList()` — upserts each device,
     resolves display name (an alias, from `DEVICE_ALIASES` merged over
     `device-aliases.json` beside the database and the image's own file; else
     `resolveDeviceName`; two unnamed devices that share a fallback name get their
     panel slot, else the serial's last four characters, `disambiguateFallbackNames`),
     sets `online = (d.online === 1)`, logs online/offline transitions.
  3. For each `online === 1` device, `ecoflow.getQuotaAll(sn)` →
     `store.setDeviceQuota(sn, quota)`; on error `store.setDeviceError(sn, msg)`.
- Logging discipline: there is no per-poll success line. A poll after a failed one
  logs `poll ok in Nms (recovered)` and a poll at or over `SLOW_POLL_MS = 5_000` logs
  `poll slow: …`, both at INFO. At `LOG_LEVEL` debug/trace (`POLL_DEBUG`) a duration
  summary (p50/p95/max) is logged once every `POLL_SUMMARY_EVERY` polls (default 30,
  v1.148.0). A thrown poll logs `poll failed: …` at **warn**. Per-device quota failures
  are logged as set-change deltas (`pollFailureLines`): warn for devices newly failing
  outside the standing 1006 set, info for recoveries and the daily standing-set restatement.
- A `fleet-status` line dumps per-SN MQTT msg-count + last-seen every
  `STATUS_DUMP_INTERVAL_MS = 10 min`. It goes out in full at INFO only when the
  per-device ON/OFF/API-online-no-MQTT state vector changes, plus an hourly anchor
  (v1.145.0). Otherwise a compact `fleet-status (unchanged)` line carrying only the
  MQTT-reporting devices' counters goes to debug (v1.187.10).

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
`MQTT_BOOT_GRACE_ATTEMPTS = 5` failures that match a boot transient
(`MQTT_BOOT_TRANSIENT_RE`: DNS race `EAI_AGAIN`/`ENOTFOUND`/`getaddrinfo`, or EcoFlow
`8521 signature is wrong`) log at warn. Any other error class, at any attempt, or a
transient still recurring past the grace window, logs at error (`classifyMqttStartFailure`). REST polling works regardless of MQTT state.

#### 3.3 Projection (`ecoflow/project.ts`)

Every ingest path (`setDeviceQuota`, `mergeDeviceQuota`) calls
`projectByProduct(productName, raw)` to rebuild a typed `Projection`
(`kind: 'dpu' | 'shp2' | 'generic'`) attached to `devices[sn].projection`. After
projecting, the store hides phantom packs (`hidePhantomPacks`), annotates stream flow
(`annotateStreamFlow`), and runs four per-device trackers:

- `applyBackupPoolGraceHold` — SHP2 only; substitutes the last-coherent
  backup-pool trio (`backupBatPercent`/`backupFullCapWh`/`backupRemainWh`) across
  brief cloud-reconnect blips instead of publishing "unknown"
  (`BACKUP_POOL_GRACE_HOLD_MS`; smooths ~10–15 reconnect blips/day).
- `trackDpuErrOnset` — per-DPU `{code, sinceMs}` of the standing `sysErrCode`;
  re-baselined on code change/clear so `alerts.ts` can debounce transient
  reconnect blips of the inverter-error CRITICAL.
- `trackShp2SrcErrOnsets` — per-SHP2-slot source-error onset (`<sn>:<slot>`),
  the same debounce discipline for `shp2-src-err-<slot>` CRITICALs.
- `trackMpptErrOnsets` (v1.174.0) — per-string MPPT error onset (`<sn>:hv` / `<sn>:lv`),
  kept only while that string is producing, so the `dpu-pvh-err` / `dpu-pvl-err` warnings
  need the code to stand rather than ride a sunrise-ramp standby code.

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

The same database also holds the durable night-charge tables `night_charge_ledger` and
`night_charge_calibration` (chapter 15 §6), which the retention sweep never touches, and
`bridge_ledger`: one row per rollup window per home Core the energy bridge metered at its panel
slot, with what that rollup booked for it, which the Today card reads (chapter 7, the energy
bridge). It is pruned with the samples retention. Besides
hardware serials, `samples.sn` carries three synthetic series: `weather` (GHI/cloud),
`forecast` (day-ahead archive) and `night_charge` (disposable chart overlay).

Four tables hold what the recorder knows about held readings (`heldSamples.ts`, v1.188.1).
`held_samples` has the same four columns as `samples` and holds rows moved out of it because
they restated a held reading (see 4.4); nothing in it is read as a measurement. `held_spans`
(`sn`, `start_ts`, `end_ts`, `reason`, `rows`, `detected_at_ms`, `restored_at_ms`) logs each hold
of an hour or more: `gate-stale` or `gate-shadow` when the recorder wrote nothing (4.3), `frozen`
when held rows were moved, with `start_ts` the newest row of the device kept in `samples` before
them (exclusive: its last fresh reading, or a restated row left there, 4.4) and `rows` the rows
moved. `held_scan` keeps the scan's watermark. `held_generation` is a single counter, the
samples generation, advanced in the same transaction as every move and every restore (4.4).

The composite `(sn, metric, ts)` index serves `query()`/`queryMulti()`; the
dedicated single-column `idx_samples_ts` lets the hourly retention `DELETE WHERE
ts < ?` seek instead of full-scanning under the write lock.

**Pragmas** (write connection): `journal_mode = WAL`, `synchronous = NORMAL`,
`cache_size = -32768` (32 MB), `mmap_size = 268435456` (256 MB),
`temp_store = MEMORY`. **Planner statistics:** at startup `PRAGMA optimize=0x03` lists
the `ANALYZE` a table needs because one of its indexes has no `sqlite_stat1` row (a
fresh install, or an index a migration just created). The recorder runs exactly those,
with no sampling bound, and logs `recorder: planner stats — SQLite <version>, …`. A
table whose indexes all have statistics is not re-analyzed at boot, however stale:
every statement that reads `samples` plans the same with no, full or truncated
statistics (`test/bootPlannerStats.test.ts`). An `ANALYZE` of `samples` costs a read of
every index page (~917 MB in a 2026-09-07 snapshot of the live database), bounded or
not.

#### 4.3 Write path — `record(extract(snap))`

`store.on('change')` coalesces bursts with a `setImmediate` guard (one
`extract`+`record` per tick, not per MQTT message). `extract(snap)` walks
`devices[*].projection` and emits `MetricSample[]` (`{sn, metric, value}`),
pushing only finite numbers. Metrics emitted per projection kind:

- **DPU**: `soc`, `pv_total`, `pv_high`/`pv_low` (+ `_v`/`_a`), `ac_in`,
  `ac_out`, `total_in`, `total_out`, `bat_vol`, `bat_amp`,
  `ems_para_vol_min_mv`/`ems_para_vol_max_mv` (**v1.187.3** — EcoFlow's EMS parallel band, in mV
  as projected, from the same backend block as `bat_vol`; the `ems-volt-*` notice compares the two),
  `mppt_hv_temp`,
  `mppt_lv_temp`, `chg_max_soc`, and per pack `packN_soc/temp/in/out/cell_max/
  cell_min/mos_max/board/vol_diff_mv/vol_max_mv/vol_min_mv/balancing/soh/cycles/
  full_cap_mah/remain_cap_mah/lifetime_chg_mah/lifetime_dsg_mah`.
- **SHP2**: `backup_pct`, `backup_reserve` (the reserve setpoint, v1.117.0), `backup_remain_min`, `backup_charge_min`, per-circuit
  `chN_w`, summed `panel_load`, `grid_home_w` (SHP2-metered home grid import),
  split-phase `pairN_w`, per-source `srcN_pct/temp/w` and the panel's per-slot PV and input
  fields `srcN_pv_w/pv_hv_w/pv_lv_w/in_w` (the energy bridge's).
- **Generic**: `soc`, `in_watts`, `out_watts`, `pv_watts`, `ac_in`, `ac_out`,
  `temp`.

**Freshness gate (v1.188.1).** `extract()` writes a device's projection only while
`projectionRecordable(d, now)` holds: its `lastTelemetryAtMs` is within `RECORD_FRESH_MS`
(3 min, the 'Telemetry stale' alarm's figure) of now in either direction, the panel's
cloud-shadow latch (`contentStaleSinceMs`) is clear or the arrival that stamped
`lastTelemetryAtMs` brought a NEW body (`latchedBodyNew`: `contentNewAtMs`, a body whose witness
has not been seen since the content froze, `shp2Shadow.ts advanceBodySeen`), and for a Core its content clock
(`contentChangedAtMs`, the v1.181.0 witness) moved within `SHP2_READBACK_STALE_MS` (5 min,
`dpuContentFresh`): a REST 200 replaying a Core's cached body still lands content, so arrival
alone is not a reading, and a Core's first body after a restart only seeds the witness (it is
written from its first change). `lastTelemetryAtMs` is stamped only when
telemetry content lands, by `setDeviceQuota` (a REST quota) or `mergeDeviceQuota` (a translated
MQTT delta), the only writers of a projection; a device without it is not recorded. The store keeps
a device's last projection across `/device/list` polls (the alarms read it) and fetches quota only
for a device listed online, so before v1.188.1 every change event after a device went offline in
the cloud restated its last reading: after the 2026-10-14 internet outage, about 1,300 rows per
Core per hour with no value changing for 20 h. The key is content, not `online` (a Core streaming
MQTT while listed offline keeps recording, and a device absent from the list keeps its last flag),
not `lastUpdated` (a bare `/status` flip bumps it) and not `lastQuotaAtMs` (REST only). A device's
own content arrival emits `change`, so it is recorded at age 0 and the poll cadence and dedupe are
unchanged; the gate bites only on rows written on another device's event. A latched panel shadow
releases with hysteresis (two distinct new bodies), but a body that arrives new is a reading at
once, so the first moving reading after a replay is recorded while the latch still holds; its own
replay, the frozen body again, or a cloud alternating between cached bodies is not. (Keyed on the
latch alone, the gate had dropped that first reading: a 9-poll replay was an 11-min row gap.) A
held panel's hold then starts at that body (`heldSinceMs`).
A hold of an hour or more is logged in `held_spans` from the device's last fresh content, with one
log line when it reaches an hour and one when the device reports again. A later start for a device
held at every evaluation since its span opened is the same hold (`noteGate`): a Core with no content
clock yet, after a restart, is held from its last arrival, which moves with every poll, so its span
runs from the first instant the process held it, never from before the restart (re-opened at each
new start, a replay after a restart was never an hour long and never logged). The gate never writes the
store: the offline, stale and blind alarms and the SoC ladder read the same projection as before.

#### 4.4 Dedupe / heartbeat

`shouldRecord(sn, metric, value, now)` (constants top of file):

- `MIN_INTERVAL_MS = 10_000` — never write the same metric more than once / 10 s.
- `MAX_INTERVAL_MS = 300_000` — heartbeat: always write at least every 5 min even
  if unchanged.
- `VALUE_EPSILON = 0.5` — between those bounds, write only if the value moved
  ≥ 0.5 (W or %).
- The heartbeat restates only fresh content. The freshness gate (4.3) is shorter than
  `MAX_INTERVAL_MS`, so a device that stops reporting gets no restated row at all, and a held
  stretch is a gap, which every consumer already handles: the coverage gates, `integrateWh`'s
  `maxGapMs`, the night ledger's per-Core coverage and the per-device gap sweep (4.7). The
  lifetime rollup integrates each 5-min window on its own, and `integrateWh` gives a window
  with no row 0 Wh, so a panel counter (Panel Load, Grid Import (Home), each circuit) whose
  series has no row in a window while its last row is less than 10 min old holds its watermark
  instead: the next window integrates across the gap from the rows on both sides, as
  `integrateWh` bridges a gap of up to 10 min inside one window. The energy bridge holds its
  window the same way (energy chapter, the bridge). Before, every 5-min window inside a cloud
  shadow or a quota stall was lost from those counters for good. The hold is judged per
  contributor, so a live second panel's rows do not release a held panel's window.
- **The lifetime counters across a held panel.** v1.188.0 lost nothing to a replay or a stall:
  its heartbeat restated the held reading and the counters integrated it. For the lifetime
  energy counters only (`samples` stay as written), a row gap the gate itself explains is
  integrated with the held reading up to `HELD_ENERGY_BRIDGE_MAX_MS` (30 min): `createHeldGapLog`
  (`heldSamples.ts`) keeps each panel's evaluations in memory, held or fresh, and a gap (a, b) of
  one series is explained when the recorder watched the panel through it (no two evaluations more
  than `HELD_EVAL_GAP_MS`, 3 min, apart), held it at some evaluation inside it, and read it fresh
  no later than one heartbeat after a (a fresh evaluation after that would have written the metric,
  so its absence is not the gate's). `energyPoints` (`recorder.ts`) then restates the reading at a
  every 5 min across the gap, the rows v1.188.0 wrote, for the watt counters, their read path and
  the energy bridge; a gap still open within the bound holds the window (`heldGaps.open`). Past the
  bound a gap stays a gap: the next window books nothing for it, beyond `integrateWh`'s own tail of
  up to 10 min after the last row. The bound comes from the panel's whole recorded history
  (2026-07-02 → 10-16, 2.75 M rows, written by recorders that restated a held reading): 703 restated
  runs of 5-180 min through which the recorder kept evaluating the panel, median 11.2 min, p90 15.0,
  p99 15.6, 702 of them at most 15.8 min; the next is the 2026-10-15 01:54-04:16 internet outage,
  142 min. A metric written only at the heartbeat starts its gap up to 5 min before the content
  froze, so 30 min covers every common episode with margin and stays far below an outage. A gap
  across a restart (the log is in memory), a fleet silence inside it, or a device with no
  projection is not explained. Only the panels are logged: a Core held by the gate is the energy
  bridge's after its 3-min dwell.

**Held rows already written.** Rows written before v1.188.1 while a device was held are found by a
scan and moved, unchanged, from `samples` to `held_samples`, so no consumer reads them as
measurements. A stretch qualifies when, from the device's last changed value (a fresh reading,
kept) to its last restated row, at least an hour of observed constancy passed with no metric of
the device changing, some metric was restated at least three times and at least eight metrics
were restated (`createFrozenScanner`). Observed constancy counts only the intervals between two
consecutive rows no more than `HELD_ROW_BRIDGE_MS` (10 min, two heartbeats) apart: a gap with no
rows is never a hold, and it does not count toward a stretch's length either, so a constant device
back from a gap with identical heartbeats is not moved after a few minutes of them. A body the
cloud replays after a long gap is therefore moved once it has been restated for an hour, not
before (the gate's own span over the gap still refuses the night-ledger row). What a gap does to a
stretch depends on its length (`HELD_RETURN_GAP_MS`, an hour: the night ledger's own bridge):

- A gap of up to an hour is a **hole** (an add-on restart, a host reboot, a poll outage): the
  stretch goes on across it, and the observed time on both sides adds up.
- A longer gap is a **silence**, and the restated rows after it are a **return piece**. It joins
  the stretch only once it qualifies on its own (an hour observed after the silence), and the
  stretch then runs from the last change before the silence: the incident's Cores, silent through
  the 2 h outage, then restated for 20 h. A return piece that ends before that is a **return
  reading** and stays in `samples`; the stretch before it ends at its last restated row. On a copy
  of the live database a Core held for about 23 h, silent for 9.8 days, came back with one group
  equal to its held values; before the dry run that return reading had been moved with the span,
  which then claimed 257.9 h.
- A stretch that neither qualifies nor extends a moved span when a silence begins is over: its
  rows stay, and the next stretch starts from its last row, as it does after a return reading
  that another silence follows. Such a kept restated row can then be a span's start. When it
  starts a span an earlier scan moved, the scanner measures the gap to the next row again from the
  end of the moved rows, so a scan that re-reads the span from before its start treats a short gap
  there as a hole, as a scan anchored on that row does (v1.188.1, third review: the next row always
  opened a return piece, and a scan that re-read the span left the rest of a hold that ended within
  the hour in `samples` for good; the 3 h overlap, the boot scan after a stop and the retry after a
  failed slice, which always re-reads from the span's start, all re-read it).

The anchor of every stretch is therefore the newest row kept in `samples` before it, which is what
an hourly scan reads as its anchor, and which rows are moved, where a span starts and where it ends
do not depend on how often the scan runs (v1.188.1, second review: with every gap of more than two
heartbeats ending a stretch, a restart's 20-min hole had left a running hold's tail in `samples`,
two 40-min parts of one hold had never added up, and a scan of the whole history and the hourly
scans had disagreed about equal groups between two silences). The one limit is a hold whose
observed hour takes longer than the 3 h rescan overlap to build up. Any interval of more than two
heartbeats between its rows adds nothing to the observed time, so restatements 25 min apart are
enough, not only hour-long holes. Only a scan that reads such a hold whole, the first, moves all of
it; the hourly scans leave its first restated rows in `samples` as the anchor, or all of it when
its restatements stay that far apart throughout, since then no 3 h re-read holds an observed hour
(v1.188.1, fourth review: this said only "its first restated rows"). A stretch that does
not qualify on its own is kept only to extend a span an earlier scan moved, from the same start;
the scanner measures its first row from where that span ends (`movedThroughMs`), so a hole after
the moved rows is a hole, and a longer silence makes the rows after it a return piece. Synthetic series and
bench spares are never scanned. Each hour of a stretch moves in one transaction: copy, delete, the two counts
compared (a mismatch rolls back), the span logged. A slice whose transaction fails rolls back,
the rest of that span stays in `samples`, and the scan saves its watermark no later than the span's
start, so the next scan re-reads the span from there and extends what was already moved. Rows
younger than 15 min wait for the next scan, because the lifetime rollup re-reads its last 10 min. The scan runs a minute after boot, then
hourly, on the main thread (the alarm engine's): six hours of one device's rows read, or one hour of
them moved, per timer tick. A device's frozen spans are read once per scan, before its rows, and the
scanner keeps only the stretches that can be moved (those that qualify and the tails above); the
finishing step had looked a span up for every stretch the device had, 100,000 to 486,000 per
device over the live retention window (1.6 to 5.4 s of the alarm thread per device on the reference plant's Raspberry Pi), and
kept them all until the device finished (+190 to 360 MB). The first covers the
retention window from each device's oldest row (one index seek per series), not from the horizon,
where most of its six-hour steps read nothing; the night-charge capture waits for it (section 7 of chapter 15); later scans
re-read 3 h before their watermark, so a hold still running is extended from where its last move
stopped. It runs in the add-on (`SUPERVISOR_TOKEN` set) unless `RECORDER_HELD_SCAN=off`, and
elsewhere only with `RECORDER_HELD_SCAN=on`. Each span logs one `HELD SAMPLES` line, from its start
to the end of what that scan moves, with an estimate of the held flow the lifetime
counters had integrated over the stretch's observed time in that range (`FrozenStretch.observed`,
the intervals the counters integrate); each later scan that extends the span states the range it
moved and the held flow in it on its `held samples of … moved` line, so the parts add up to the
span's held flow once. The counters are not rewritten, because Home Assistant reads a decrease as a
meter reset. If a device's gap clock (4.7), seeded at boot or written in this process, was one of
the moved rows, or a restatement of the same stretch that the scan read and has not moved yet
(younger than 15 min, or in a later slice: `onMoved`'s `heldThroughMs`), the clock goes back to the
span's start, and a per-device gap record whose start was one of them is re-dated to it, keeping
its alert id (4.7). So it does when the clock is a row the scan never read, written after the scan
was planned (the scan reads every device before its first move, minutes on the reference plant's Raspberry Pi), as long as
every write of the device since `heldThroughMs` restated the stretch's values (`onMoved`'s
`heldValues`: no write in which a value changed, even back again, and each metric's last write equal
to its held value) within an hour of it (v1.188.1, fifth review: a heartbeat in that window left a
replayed Core unheld, and its record came at the next hourly scan, or never). That test reads only
this process's writes, so it holds only a clock this process wrote: a seeded clock is a persisted
row the scan read (it is planned after the boot), and past the stretch's last restated row it is a
fresh reading or a later hold's start (v1.188.1, sixth review: a Core back fresh for 15 min after a
40 h hold, dark again 25 min at the restart, was held from the hold's start and pushed as dark for
41 h).

**Readers that memoise.** Every move and restore advances the samples generation
(`held_generation`) in its own transaction; both recorders read it (`samplesGeneration()`). The
analytics worker keeps two memos that assume `samples` only grows: the per-day energy integrals of
closed days (`windowedEnergyWh`, chapter 7 section 1.3) and the 60-day equipment-health series
(`eqQueryMulti`). Its report chokepoint (`reports.ts` `buildReport`) reads the generation before
every report; when it has moved since the previous report it clears both memos and every report
cache (`resetWorkerSampleCaches`) and advances the flight generation, so a report still running on
the moved rows writes no cache, and the generation is part of the flight key. Without it the
worker's first warm pass, seconds after the upgrade boot, memoised the incident's closed day with
its held flows a minute before the scan moved them.

**Restoring.** `restoreHeldSamples(sn, start)` moves one span back unchanged and sets
`held_spans.restored_at_ms`; no later scan moves a restored span again, nor the rest of its hold.
A stretch that overlaps a restored span, or whose anchor is one of its rows (no metric of the device
changed since its start), is left in `samples`, qualifying in that scan's window or not, and the
span's `end_ts` follows the stretch's last row, so a restore made while the device still restates
its readings holds to the end of the hold at any scan cadence. A change ends it: the stretch from
the change is a new hold. So does a return reading after a silence of more than an hour that another
silence follows: as for any device, the stretch starts again from that reading, which lies after the
restored end, so a later replay of the same readings is a new hold (the restore's log line says so;
v1.188.1, fifth review: it promised the rest of the hold without that limit). (Matched on overlap
alone, a restore held for about four hours: once the 3 h re-read started after the restored end,
each hourly scan's anchor was a restated row of the same hold, and the rest of it was moved as a new span with a second `HELD SAMPLES` line, while a boot
scan after a stop left the same rows. v1.188.1, fourth review.) A restore can land while a scan runs: the SQL below needs no
restart, and a scan runs one step per timer tick, so it may have read the device's spans before the
SQL. Each move slice therefore reads the device's restored spans again in its own transaction
(`BEGIN IMMEDIATE`, so no other connection commits between that read and the move; a write lock
held elsewhere fails that slice, which the next scan retries), and a stretch that continues a span
restored since the scan was planned is left in `samples` like any other
(v1.188.1, sixth review: the scan moved the rest of the hold under the span just marked restored,
and those rows stayed in `held_samples` for good, under a span no reader treats as held). A
per-device gap record the move had re-dated to the span's start goes back to the start it was filed
with, and a gap clock the move had set back into that span goes forward again (4.7). In SQL, in one transaction:
copy the span's rows (`sn = ? AND ts > start_ts AND ts <= end_ts`) from `held_samples` to `samples`,
delete them from `held_samples`, set `restored_at_ms` on the span, and advance the samples
generation with `UPDATE held_generation SET gen = gen + 1 WHERE id = 1`. Without that last step the
analytics worker's closed-day memos and report caches (above) keep serving the days without the
restored rows until the next restart: the generation is the only signal that `samples` changed
other than by appending. A gap record re-dated from the span is returned to its filed start at the
next boot while the device is still dark (its seed reads that row again, 4.7), and a record filed at
the span's start after the move is extended by that boot and keeps its start (the seed lies inside
its window, or inside the restored span from its start, which can run past the record's end: 4.7);
`telemetry-gaps.json` needs no edit. The SQL does not extend `end_ts` over the rest
of a running hold: the next scan does (above). A device whose gap clock is the span's start (4.7)
is released when the per-device sweep would file a record from that start: it looks the span up
first (`restoredSpanFrom`), and a restored span gets the restore's treatment instead (the clock to
the device's last restated write, the hold ended, a re-dated record returned), so the add-on need
not be restarted after the SQL (v1.188.1, fifth review: a Core that went on restating the restored
readings, every row in `samples`, was filed and pushed as dark 6 h after the span's start). That
holds whichever process moved the span: a boot after the move seeds the span's start (the newest
row then left in `samples`), with no hold and no clock of its own to give back, and the restore then
moves the clock to the device's newest row back in `samples`, what the next boot would seed
(v1.188.1, sixth review: the record was filed from the span's start 6 h after it, "no data for
372 min (09:00 → 15:12)" for a Core whose restored rows ran to 12:00). A clock the restore cannot
move (nothing of the span back in `samples`) is filed from where it is. A
night-ledger row refused for the span's hours is re-captured by the next sweep while its telemetry
is retained (chapter 15, section 7).

#### 4.5 Retention

Hourly `setInterval` runs `DELETE FROM samples WHERE ts < now − RETAIN_MS`.
`RETAIN_MS` derives from the `RECORDER_RETENTION_DAYS` option (v1.51.0 —
default 30 days, clamped [7, 3650] (cap raised from 730 in v1.108.0); malformed values fall back to the default
so a config typo can never become a delete-everything retention). The
effective value is logged at startup. Timer is `.unref()`'d. The same sweep ages
`held_samples` off at the same cutoff; `held_spans` rows are kept for the retention or
61 days, whichever is longer (past the night ledger's 60-day sweep).

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
   - A dark home Core (no reading of its own, which the energy bridge meters at its panel
     slot) counts its own `pv_total` / `ac_in` only up to the instant its reading stopped.
     Its slot's bridged PV and AC input are added to `fleet_pv_wh` / `fleet_grid_import_wh`,
     and its bridged battery energy (`bridge_battery_charge_wh` / `_discharge_wh`) rides on
     top of the two battery totals, never folded into the floors ([chapter 7, path
     (c)](07-energy-and-cost.md#22-the-two-accumulation-paths)).
2. **BMS coulomb-counter keys**: `fleet_battery_charge_wh` /
   `fleet_battery_discharge_wh`, stored as monotone `max(BMS, persistedFloor)`.
   The old discharge≤charge clamp was **removed** in v0.45.0 — over an open
   window ending below the baseline SoC, cumulative discharge legitimately
   exceeds charge; HA ingests the two as independent `total_increasing` sensors.

   **v1.96.0 — membership rollover.** A monotone floor is correct while the pool
   is stable and wrong the moment its membership changes: when a Core leaves the
   SHP2 source list its packs drop out of the live sum, which can land far BELOW
   the pinned floor (measured ~904 kWh after the 2026-08-20 reconfiguration), so
   both counters read FLAT — silently, for an estimated ~35 days — until the new
   pool climbs back over the old mark. The floors now RE-SEED from the live sum
   whenever the source set changes, keyed on a fingerprint persisted to
   `/data/bms-membership.json` (v0.9.74 established this shape as a one-time
   marker; a fingerprint generalises it, since membership can change again). A
   stable roster still ratchets monotonically, so a transiently-offline device
   re-seeds nothing. v1.193.0 — the floors re-seed and the published counters
   continue from their last values: the difference is a basis shift (`lifetime_basis`,
   written with the floors and the accepted roster, the `bms_membership` row, in one
   transaction; the file follows the commit for an older release and is read only while
   there is no row).
   The step down was not honest: HA books a reading below 0.9 × the previous one as a
   meter reset, the whole new reading again (about 12,043 kWh of Battery Energy In by
   2026-09-07), and a step up as energy. A Core joining counts from the re-seed, whose
   negative shift absorbs its packs' history ([chapter 7, path (b)](07-energy-and-cost.md#22-the-two-accumulation-paths)).

   **v1.98.0 — the gap invariant.** Keying the repair on a fingerprint CHANGE was insufficient: v1.96.0 wrote the fingerprint on first observation without repairing, so on every later boot the fingerprint matched and the branch (with v1.97.0's first-run repair inside it) was unreachable — the freeze survived both releases. The floor/live gap is therefore now checked DIRECTLY: when the floor sits more than `BMS_RESEED_MIN_GAP_WH` (50 kWh) above the live sum for `BMS_RESEED_SUSTAINED_ROLLUPS` (2, ~10 min) consecutive rollups, it is re-seeded, at most once per process. Requiring persistence is what makes it safe — a genuinely-offline device cannot open that gap, because held-carry keeps its last-known Wh in the live sum for exactly that reason. The fingerprint path is kept for explicit membership changes, where it repairs immediately instead of waiting out the dwell. v1.193.0 — this re-seed too carries the published counters by a basis shift, so Home Assistant sees no step.

   **v1.103.0 — membership history (`membershipHistory.ts`).** Pool membership was resolved once from the live snapshot and applied across historical windows, so a query spanning a reconfiguration attributed one fleet's energy under another's roster — and `computeLocalPackRte` accumulated 77,218 Wh in against 92,676 Wh out (a round-trip ratio of 1.20, impossible) because the two legs of a day were measured over different batteries. A timestamped record of the connected-DPU set is now appended on EVERY rollup (`recordMembership` is idempotent; recording the STATE rather than the EVENT is what makes the first entry appear on a stable plant). `membershipVerdict(from,to)` returns `stable` / `changed` / **`unknown`** — a window predating the record is REFUSED, never assumed clean — and an empty fingerprint (panel unreadable) is never recorded. The pack-DC RTE excludes non-`stable` days and reports `excludedDays`; `computeTotals` declares its `membershipBasis`. Honest limit: history cannot be reconstructed backwards, so windows before this release report `unknown`.

**v1.96.0 — orphaned held rows.** Held per-pack rows are keyed
   `(chassisSn, packSn)` but the carry gate checked only the CHASSIS, so after
   packs are physically moved the old chassis keeps rows for packs it no longer
   holds (five rows, ~937 kWh, after the same reconfiguration). They are dormant
   only while that chassis is off-panel — re-wiring it would re-add all five in
   ONE 5-minute rollup, ~520x the fleet's physical charge ceiling, with no rate
   guard. A `packSn` observed in a DIFFERENT chassis this snapshot proves the row
   is stale, so it is never carried; the skip logs once per change. The guard
   needs that chassis to be projected, so the member set must not fall back to
   "every row" when the panel reads no source set: on a boot with the cloud
   unreachable, or with the panel's quota failing, the panel has no projection
   until its first quota lands, and the empty set (the fallback for a plant with
   no panel) carried those five rows (+938.8 kWh in, +965.9 kWh out on the first
   publish, then a re-seed step down once the panel returned). With an accepted
   roster on file (`bms-membership.json`; v1.193.0: the `bms_membership` row), the
   members are that roster while the panel reads no source set; the rollup already
   reads an empty set as no change.
   v1.193.0 — the members are the accepted roster whatever the panel reads, until a
   change holds for `BMS_MEMBERSHIP_SUSTAINED_ROLLUPS` (3) rollups and is re-seeded:
   a Core that left stays in the sum meanwhile, and a Core that joined is not summed
   (by reads or rollups) until the re-seed counts it. Before, every read until the first
   rollup saw a change summed the live set, so a joining Core's packs entered with
   their whole history since their baselines.

The read-only worker reproduces these via the persisted table only
(`getLifetimeTotals`), reporting `persistedWh` (v1.193.0: with each key's basis shift
from `lifetime_basis`) with `pendingWh = 0` — it lags by at most one rollup interval,
negligible against a forever-accumulating total.

Every published counter passes the publish guard (`guardLifetimeEmit`, v1.193.0): it
never emits below the last value, holds a dip of up to 5 kWh and continues from the last
value past it (a basis shift and one WARN line); a read integrates each panel series up
to its newest reading only ([chapter 7, the publish guard](07-energy-and-cost.md#24-the-published-counter-guard-guardlifetimeemit)).

#### 4.7 Telemetry-gap detection

`record()` only fires on a `'change'`; nothing runs when telemetry *stops*. The
recorder tracks the last HOME-device insert (spares excluded) and, when writes
resume after a silence, persists a durable marker (not synthetic samples) to
`telemetry-gaps.json` (bounded ring `GAPS_MAX = 50`), surfaced at
`/api/telemetry-gaps`.

- In-process stall threshold `GAP_THRESHOLD_MS = 3 × MAX_INTERVAL_MS = 15 min`.
- Restart-spanning floor `RESTART_GAP_FLOOR_MS = MAX_INTERVAL_MS = 5 min`
  (one heartbeat) — a restart that lost even one interval is real dark time.
- RTC-less host hardening (a Raspberry Pi has no real-time clock): if the boot clock is behind the newest persisted sample
  (before NTP steps), the boot check is deferred and resolved in-process using
  monotonic `performance.now()` (`bootMonoMs`, `RESTART_GAP_SETTLE_MS = 10 min`).
- **Per-device silence (v1.150.0, seed reworked v1.154.0).** One dark device is
  invisible to the fleet clock, because any surviving device resets it. A sweep run
  on every home write records a gap for any SN silent past
  `PER_DEVICE_GAP_THRESHOLD_MS` (6 h), once per blackout (`perDeviceGapOpen`),
  logged as `DEVICE TELEMETRY GAP`. The per-SN clocks are seeded at boot so a
  blackout spanning a restart is still seen. The seed is an exact index skip-scan
  (distinct SN → distinct metric → `MAX(ts)`, every statement an index SEARCH) that
  skips only the synthetic SNs; bench spares are filtered at sweep time against the
  live roster. Where the held-sample scan runs (4.4), a record is filed or extended from a
  seeded clock only once its first scan has finished (`heldSamplesReady`): on the upgrade boot the
  seed is a held row the scan sets back, and a record filed before it was dispatched about a minute
  after the boot with that row's start and a duration short by the whole hold, under the id the
  re-date then kept, so the corrected figures were never pushed (v1.188.1, fifth review). A seeded
  device that writes before then is remembered with the clock that write ended (`returnedDuringScan`;
  set back to the span's start when the scan moves the row it was) and judged once the scan has
  finished, as the sweep would have judged it at that write; a record filed then ends at the write,
  since the device is back (v1.188.1, sixth review: waiting, the sweep saw such a device only after
  the write had moved its clock on, and a Core back during the first scan after a 40 h hold got no
  record and no warning). A device
  still on its seeded clock is charged only with dark time the
  add-on could observe (`seededDeviceDarkMs`): how far its last sample trails the
  fleet's newest before the outage, plus monotonic time since this process's first home write, less every fleet-dark window already in the gap ledger between those two points (so an intervening short boot cannot charge a silent device with an earlier outage). The outage itself is the restart-spanning fleet gap, not every
  device's.
- **Held devices (v1.188.1).** With the freshness gate (4.3) a held device writes nothing, so
  the per-device sweep files a gap for a device the EcoFlow cloud lists offline; before, its
  restated rows reset its clock. A device is charged only with time in which another home device
  could report. One that has written in this process is measured as the time since its last
  sample less every fleet-dark window in it (`inProcessDeviceDarkMs`): the gap ledger's fleet
  records and the fleet silence the current batch is ending, which the fleet block files only
  after the sweep. With the gate a device is in a batch only once its own content lands, and
  quota and MQTT deltas arrive device by device, so measured as now − last a fleet-wide outage of
  more than 6 h filed every device but the first to answer. The fleet gap of a fleet-wide hold
  ends at the first FRESH home write; after the 2026-10-14 outage each Core still held is filed
  6 h after the panel's first fresh reading (04:16 → about 10:16), not 6 h after it went quiet.
  A Core still held at a restart is measured from the start of its held span (as a rule its last
  fresh sample) once the scan has moved its held rows, or read the newest of them as restatements of
  that stretch (4.4). So is a device whose held body was written in this process: when the scan
  moves the stretch the row its clock reads belongs to, the clock goes back to the span's start.
  (The content-clock gate, 4.3, holds a Core whose cached body is replayed unchanged once its content
  clock is more than 5 min old, so in this process such a replay writes its first minutes at most;
  the held rows the scan finds are those written before v1.188.1, as on the upgrade boot, and any
  that reach `samples` anyway, while a marker the gate reads moves with the recorded readings
  repeating.) Left on the moved row,
  the sweep filed the record a hold late, with a start at the last held row and a duration short by
  the whole hold, and no later move re-dated it. The device is then held from that start
  (`heldReplayFrom`): while its writes only restate the same readings (each metric equal to its
  previous write, within `HELD_RETURN_GAP_MS` of it, the scanner's own rule) they leave the clock
  there and its record open, so a replay still being written is filed 6 h after the span's start,
  once. A write in which a metric changes ends the hold and re-arms the sweep; so does a write after
  more than an hour without one (a return, which the scan keeps as a reading until it has been
  restated for an hour), and a restore of the span (4.4), by SQL too (the sweep looks the span up
  before it files a record from its start). A metric with no write in this process yet is compared
  with the stretch's held value and its last restated row (`heldValues`, `heldThroughMs`): the dedupe
  map is empty after a restart and the boot scan holds a Core from its seeded clock, and compared
  with nothing, its first write after that scan ended the hold, so the record came at the next
  hourly scan, or never (v1.188.1, fifth review). Before (v1.188.1, fourth review), each
  replayed write reset the clock and re-armed the sweep, and the clock was always newer than any
  moved range (the scan never moves a row younger than 15 min): no warning while the replay lasted,
  none at all when it ended with a fresh reading, and one a whole replay late when it ended in
  silence. A write that only restates such a hold is not a home insert: it neither moves the fleet
  clock nor runs the sweeps. When the move holds a device, the fleet clock goes back to the newest
  gap clock of any home device, not before this process's first home write (`pullFleetClockBack`),
  and a restore that moves a device's clock past it moves it forward again. So with every home device
  held (the panel behind its shadow latch, the Cores' held rows written with fresh clocks) no device is filed,
  and the fleet gap is filed when a fresh home reading comes, from the last fresh one (v1.188.1, sixth
  review: the replayed writes kept the fleet clock current, no fleet silence was seen, and at 6 h each
  device got a per-device warning saying that other home devices kept reporting).
- **One blackout, one record (v1.188.1).** A per-device record filed from a held row (the seed
  before the scan moved it, by this boot or by an earlier version) is re-dated when that row is
  moved: its start becomes the span's start, the newest row of the device left in `samples` (its
  last fresh reading, or a restated row too short to be a hold that a silence followed, 4.4, which
  the log names as such and which the next boot's seed reads), and the start it was filed with is
  kept as `alertStartMs`, which keys its alert id, so the push and digest dedupe hold (alerts
  chapter, section 2.3). The sweep also extends an overlapping record of the
  same device that starts later than the gap it measures, with the same re-dating: that is the
  record a boot finds when the move happened in a process that did not re-date it. Matched only on
  the exact start, the restart after the move filed a second record for every Core still dark, with
  a new id: four more warnings pushed at once and `system_device_gap_count_24h` doubled. A device
  that wrote since its record starts its next gap after that record's end, so a second blackout is
  a second record. A restore of the span (4.4) returns the record to the start it was filed with
  (`alertStartMs`, then dropped) and puts a gap clock the move had set back into that span where it
  was (the clock is remembered per device, and only the restore of the span it lies in uses it); a
  boot whose seed reads that start again (a restore by SQL) does the same through the sweep. Left
  re-dated, the next boot's seed matched neither the record's start nor its overlap and filed a
  second record with the same alert id. A record filed at the span's start after the move (the
  upgrade boot's path: the first sweep runs before the scan, so the record is filed from the
  set-back clock, with no `alertStartMs`) is not re-dated by a restore; the next boot's seed, the
  restored span's last row, lies inside the record's window, and the sweep extends that record,
  which keeps the start it was filed with. A device that wrote after a record's end starts its next
  gap past it, so only rows moved back to `samples` can put a seed inside a record. Matched by none
  of the other rules, that boot filed a second record with a new id: a second pushed warning for the
  same darkness (v1.188.1, fourth review). The record's window reaches to the end of a restored span
  that starts where the record does: the record of a replayed Core is filed 6 h into the replay,
  while it is still being written, and the hourly scans move the replay on past the record's end
  (its detection time), so a restore puts the next boot's seed, the replay's last row, past that end
  (v1.188.1, sixth review: the boot filed a second record with a new id). Any other record of the device that starts at or after
  the span's start, up to the moved end, is the same darkness, inside the re-dated record's window,
  and is merged into it (dropped; the re-dated record keeps its id). The case is a record filed at
  the last fresh reading during a first silence, then a replay of that reading, then a second
  silence filed from the last replayed row, with no scan in between (scans off or failing, or an
  upgrade over such a pair). The scan joins the replay to the hold, and re-dated alone the second
  record took the first one's start: two alerts for one darkness, `system_device_gap_count_24h` at
  2 (v1.188.1, fifth review).
- **Silences the gate explains (v1.188.1).** The recorder keeps the home devices the gate held in
  the evaluations since the last one with a recordable home reading (written, or skipped by the
  dedupe, which happens only within one heartbeat of the last home write), and the time between
  those evaluations. An in-process fleet gap (or the post-boot silence) carries the set (`held`:
  each SN, and whether it was the panel's cloud shadow) only when the evaluations went on through
  it, none more than `RECORD_FRESH_MS` (3 min) apart and the last that close to its end; its alert
  then names what was held instead of an MQTT/broker stall. A home device those evaluations read
  with fresh content and nothing measurable (an SHP2 body with no channel and no grid reading), never
  held in the silence, is carried beside it (`unmeasured`), so the alert names it instead of saying
  that every home device it had a reading for was held. A device held from a moved span's start
  (`heldReplayFrom`) whose readings only restate that hold is carried too, as `replayed` (written,
  then moved by the scan), unless the gate held it in the silence; such an evaluation is not one with
  a recordable home reading. Before the gate a held projection was
  restated every 5 min, so a fleet gap meant that no change event reached the recorder at all; with
  it, a panel shadowed or stale for 15 min while no Core has a projection files one. (The first
  version took the set from every evaluation that wrote no home row: a panel reading the dedupe
  skipped added every held Core, and a true stall minutes later, with no evaluation at all, was
  filed as held readings.)
- **Clean-shutdown marker.** A restart-spanning gap is graceful (a deploy, not a power loss)
  when the marker `close()` wrote is no older than one heartbeat before the newest persisted
  home sample (`cleanShutdownWasGraceful`). Before v1.188.1 it had to be within a heartbeat on
  either side, which assumed the newest sample was always near the stop; with the gate, a
  deploy made while every home device was held finds its newest sample hours earlier. An older
  marker, or none, is not graceful.
- **Held-evaluation marker.** Behind the gate a hold writes nothing, so the newest home sample
  can predate the stop by the whole hold. When an evaluation has no recordable home reading and
  the gate held a home device in it, the recorder writes that evaluation's time to
  `/data/.held-evaluation`, at most once a minute. The restart probe starts the dark window at
  that time when it is later than the newest home sample: up to it the recorder was evaluating
  the held devices, as the restated rows of earlier releases showed. A crash 19 min into a panel
  quota stall with every Core dark is then a 70 s stop (no record) instead of "System outage —
  alarm was dark 20 min". With nothing reaching the recorder (the internet down: no list, no
  MQTT) no evaluation runs, and the window starts at the newest home sample as before. The
  marker is never deleted; an older one loses to a newer sample.
- **Boot phases.** `createRecorder` blocks the whole add-on (no HTTP listener, MQTT
  ingest, poll or alarm evaluation), so it ends with one line on the monotonic clock:
  `open`, `schema+migrations`, `analyze` (the planner-statistics refresh — normally no
  `ANALYZE` at all; see **Planner statistics** above),
  `setup`, `seed`, `restart-probe`, `rest` and `total`. `index.ts` also logs the
  call's duration from outside; the two should agree.

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

- `computeTotals(store, recorder, sinceMs, untilMs, { bridged? })` → `FleetEnergyTotals`
  (fleet `pvWh`/`acOutWh`/`panelLoadWh`/`batteryNetWh` + `coverage`/`pvCoverage`).
  Fleet PV/AC/battery rollups count **only SHP2-connected DPUs**
  (`shp2ConnectedDpuSns`); spares get per-device metrics but no fleet inclusion.
  Battery net is per-pack `in`/`out` (true battery flow), not `total_in/out`.
  With `bridged` (`/api/summary/today` only), each home Core the energy bridge metered counts
  the energy booked for it in `bridge_ledger` (`Recorder.bridgeLedger`) over those windows in
  place of its own samples there, and `fleet.bridged` names that share (chapter 7, the energy
  bridge); with no bridged window in the range the payload is the one without it.
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
  same bucketing) — parity is maintained by convention, not by an automated
  cross-module equivalence test. `test/worker-offload.test.ts` pins
  `readRecorder`'s own read semantics (ts ordering, 60 s bucket averaging,
  `queryMulti` batching, `listMetrics`) and that the write methods are stubbed
  no-ops. Read pragmas add `PRAGMA query_only = ON`.

#### 6.2 Worker message protocol

Messages **in**: `{kind:'snapshot', snapshot}`, `{kind:'ownerFloor', pct}` (v1.119.0 — the owner reserve floor the runway model measures against), `{kind:'homeRoster', sns}` (v1.191.0 — the last-known home roster the bench-spare floor honours, so the worker's spare answers match the main thread's), `{kind:'report', id, name, args}` (single-flighted by name + args since v1.186.0),
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
  isn't a stop (rides out cold-worker boot warm-up). v1.187.20: per-report budgets in
  `REPORT_TIMEOUT_OVERRIDES_MS` (`reportTimeoutMs`) — `chargeCurve` 90 s, for its cold build
  after a start or a device-basis reset.
- **Respawn**: on worker `exit`, fails all in-flight requests, clears caches, and
  respawns after `RESPAWN_DELAY_MS = 1_000`; on `ready` it re-pushes `lastSnapshot` and
  replays the owner reserve floor (`{kind:'ownerFloor'}`, v1.119.0), without which a
  respawned worker's runway model would read the device reserve instead, and the last
  home roster (`{kind:'homeRoster'}`).
- **First-snapshot gate (v1.186.0)**: a report request waits until the worker holds a
  snapshot with device projections. While no devices exist yet it waits up to
  `FIRST_SNAPSHOT_WAIT_MS = 5_000`, once per process, so a boot-time report is not
  computed against an empty fleet.
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

`setDeviceQuota` and `mergeDeviceQuota` (a real REST refresh or a translated DPU MQTT
delta) advance `lastUpdated`. `setDeviceOnline` (an MQTT `/status` online/offline flip)
also bumps it, deliberately (v1.142.0), so a brief status flip cannot raise a
self-clearing stale alert. That path never refreshes the projection, so control readbacks
key on `lastQuotaAtMs` (set only by `setDeviceQuota`) instead. An empty REST payload is a
no-op and advances nothing (v1.171.1).

---

### 8. How a `/api/<report>` request resolves

Using `/api/forecast` as the canonical example:

```
HTTP GET /api/forecast
  → index.ts route handler
      fc = await analytics.report('forecast')
      cached(req, reply, { ...fc, siteTimeZone: siteTimeZone() }, 60)
                              │
        analyticsClient.report('forecast', {})
          1) TTL fresh?  → return structuredClone(cachedValue)         [no worker]
          2) in-flight?  → await the coalesced promise, then clone
          3) miss        → request({kind:'report', name:'forecast', id})
                              worker.postMessage(...)
                                 │
                  analyticsWorker on('message', {kind:'report'})
                    buildReport('forecast', ctx, {})
                       reports.ts BUILDERS.forecast(ctx, args)
                         = getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log, weatherAgeOpts(args))
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

The day forecast's own cache (`dayForecastCache`, `analytics.ts`) holds a complete forecast
for `FORECAST_DAY_TTL_MS` (30 min) and a structurally incomplete one for
`INCOMPLETE_FORECAST_TTL_MS` (150 s, env-overridable). An entry is written while at least one
Core is projected or the house panel is: a process started while every home Core is dark in
the EcoFlow cloud builds a complete forecast on the panel's load and each connected Core's
own recorded PV, and caches it (v1.191.2; before, every report that read it rebuilt it). A
fleet with no projection at all caches nothing. The entry records the dark-Core basis it was
built on: the connected home Cores with no projection whose recorded PV it re-adds
(`homeRestoredSns`) and whether a home Core's first reading was pending
(`homeBasisPending`). `dayForecastCacheUsable` serves it only while the projected home Cores
(`solarModelSns`) and the restored Cores both match the current map, and never serves an
entry built with no pending Core to a map on which one is now pending. Each restored Core's
30-day PV series is read once per build. The solar-forecast chapter describes the build.

Self-consumption is cached on the same dark-Core basis (v1.191.3): its key records the house
panel, `homeModelSns` and `homeRestoredSns`, and while no Core is projected an entry is written
only when the panel lists restored Cores and none of them is pending (`homeBasisPending`).
Carbon and tariff are not cached while no Core is projected, as their `basisComplete` says; a
carbon rebuild then reads the cached self-consumption, and the tariff's hourly tally reads
each hour's own samples (`windowIntegrator`). The energy chapter has the rules.

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
| `/api/health` | blind assessment (`assessBlind`) + `pollHealth()`, `shp2ContentFrozenMs`, vitals, heartbeat — **HTTP 503** while the add-on cannot see telemetry (v1.69.0) | none |
| `/api/version`, `/api/panel-info` | trivial (`{version, builtAt, ref}`; write-auth hints) | none |
| `/api/history?sn&metric&since&until&bucket` | `analytics.query()` | 15 s |
| `/api/summary/today` | `analytics.report('totals', { …, bridged: true })` (a dark home Core counts what the energy bridge booked for it) plus `dayEndMs` and `siteTimeZone`; the default `since` is the site's midnight | 30 s |
| `/api/site` | `siteResponse()` (`site.ts`): site zone and its source, coordinates and their source, currency, PV strings (global and per Core), the PV array, the web's solar assumptions, mains voltages; per Core a `benchSpare` flag only while `BENCH_SPARE_SNS` is set | 60 s |
| `/api/calendar.ics` | forecast + EV windows + active NWS alerts | `public, max-age=300` (5 min; honoured by HA's ics calendar) — a subscribable iCal feed; point a calendar client at it |
| `/api/circuit/history?sn&(ch\|pair)&days` | `analytics.report('circuitHistory')` | none (worker-cached) |
| `/api/metrics?sn` | `analytics.listMetrics(sn)` | none |
| `/api/forecast`, `/api/runway`, `/api/degradation`, … | `analytics.report(name)` (`/api/forecast` adds `siteTimeZone`, the zone its hours were computed in) | 60 s (runway 30 s) |
| `/api/ha-state` | composed multi-report | short |
| `/api/lifetime-energy`, `/api/telemetry-gaps`, `/api/debug/*` | recorder/store | varies |

`cached<T>()` computes a sha1 ETag over the JSON, sets `Cache-Control:
private, max-age=N`, and returns a `304` (via `reply.code(304).send()`) on an
`If-None-Match` hit.

#### 9.2 WebSocket `/ws`

On connect, sends the current `snapshotFrame()`; on every store `'change'`, sends
the (frame-sequence-cached) `{type:'snapshot', serverNowMs, data: snapshotForClient()}`. The body is serialized once per emit; `serverNowMs` is stamped at send time (v1.176.0) so the dashboard measures data age on the server's clock.
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
Live-measurement sensors carry `expire_after: 120` s (`EXPIRE_AFTER_S`), so a stalled
publisher turns them unavailable instead of leaving a frozen value. `total_increasing`
and `total` energy sensors carry no expiry, and the night-charge sensors carry ~25 h
(`NIGHT_CHARGE_EXPIRE_AFTER_S`). Each report gets `STATE_REPORT_WAIT_MS = 5 s`; a late
one publishes its last good value for no longer than `EXPIRE_AFTER_S`, then null
(v1.186.0).

#### 9.4 SSH TUI

`startSshServer` on `config.ssh.port` default `2323`, host `::`, with the host key from
`config.ssh.hostKeyPath` (`loadOrCreateHostKey`; its fingerprint is on the startup line).
In bare env it is enabled unless `SSH_ENABLED=0`, but the add-on ships `SSH_ENABLED: false`,
which the runner bridges to `0`, so the SSH transport is **off by default**. The
`TELNET_ENABLED` / `TELNET_PORT` aliases were removed in v1.191.6. The same Plant Operator console is always served in a browser at
`/console` on the web port (xterm.js over `/console/ws`), independent of the SSH toggle.
SSH logins are password only against `TUI_USERNAME` / `TUI_PASSWORD` and are all refused
until a password is set; the browser console shows its login card once one is set. Both
transports spend one failure budget per source address (`AUTH_MAX_ATTEMPTS` = 3 per
connection; `AUTH_THROTTLE_MAX_FAILURES` = 10 per `AUTH_THROTTLE_WINDOW_MS` = 10 min refuse
that address alone, and a successful login clears it). The TCP side is a plain `net` server
that hands each socket to ssh2: `MAX_SSH_CONNS` = 16, `MAX_SSH_CONNS_PER_IP` = 4, a 2-min
login grace (`SSH_AUTH_GRACE_MS`), a 5-min receive-idle close and TCP keep-alive. One
terminal per connection; exec, sftp and port forwarding are refused.

#### 9.5 Web UI

Built React bundle served by `@fastify/static` at `/` with SPA fallback
(`WEB_DIST_PATH`), plus the SSH TUI. In dev, Vite is the front-end and
proxies `/api` + `/ws` back to this process.

---

### 10. Configuration reference (`config.ts` + env)

`config.ts` holds the option table, `OPTIONS` (v1.191.0): a row for every `config.yaml` option
(85 with a default and 38 schema-only, 123 in all), every environment knob and every
deployment constant, each with the parse rule its reader applies (four truthiness conventions,
the blank and `null` rules and the clamps are kept per key). `option(name)` reads a value
through its row. A schema-only key has no default and the run script exports it only when it
is set, so an unset key leaves the variable absent and the code takes the path it took before
the key existed. The full option list is in [the option reference](../guide/options.md); the
table below lists the `config` object's fields and the knobs this chapter uses.

| Key | Env var | Default | Purpose |
|---|---|---|---|
| `accessKey` | `ECOFLOW_ACCESS_KEY` | *(required, lazy)* | EcoFlow OpenAPI access key |
| `secretKey` | `ECOFLOW_SECRET_KEY` | *(required, lazy)* | EcoFlow OpenAPI secret key |
| `apiHost` | `ECOFLOW_API_HOST` | `https://api-a.ecoflow.com` | REST/MQTT sign base |
| `port` | `PORT` | `8787` | HTTP listen port |
| `host` | `HOST` | `::` | HTTP bind (dual-stack) |
| `dbPath` | `DB_PATH` | `/data/ecoflow.db` (container) | SQLite WAL DB |
| `logLevel` | `LOG_LEVEL` | `info` | Pino level; `debug`/`trace` add the periodic poll-duration summary (every `POLL_SUMMARY_EVERY` polls) and the recorder's sample-count heartbeat |
| `forecastLat` | `FORECAST_LAT` | `33.4484` | Solar forecast latitude; the default is a placeholder (Phoenix, the reference plant's city) |
| `forecastLon` | `FORECAST_LON` | `-112.074` | Solar forecast longitude |
| `ssh.enabled` | `SSH_ENABLED` | bare env: `true` (unless `0`); add-on option default `false` (bridged to `0`) | SSH transport on/off (the `/console` browser terminal is always served) |
| `ssh.host` | `SSH_HOST` | `::` | TUI bind |
| `ssh.port` | `SSH_PORT` | `2323` | TUI port |
| `ssh.hostKeyPath` | `SSH_HOST_KEY` | `/data/ssh_host_ed25519_key` | ed25519 host key, generated on first start |
| `retentionDays` | `RECORDER_RETENTION_DAYS` | `30` (clamped [7, 3650]) | `samples` retention (4.5), read at call time |
| `dataRoot` / `dataFile(name, override)` | `DB_PATH` | the directory beside the database | Where the state files live; a `*_PATH` override wins |
| `siteTimeZone()` (`siteTime.ts`) | `SITE_TIMEZONE`, else `TZ` | `America/Phoenix` (`DEFAULT_SITE_TIME_ZONE`) | The site clock (section 12) |
| — | `POLL_INTERVAL_MS` | `60_000` | REST poll cadence |
| — | `ANALYTICS_REPORT_TTL_MS` | `20_000` | Default report cache TTL (main thread) |
| — | `SNAPSHOT_INCLUDE_RAW` | `0` | Attach raw quota to snapshots (debug) |
| — | `MQTT_BOOT_GRACE_ATTEMPTS` | `5` | MQTT retries treated as benign at warn |
| — | `MQTT_DISCOVERY_ENABLED` / `_HOST` / `_PORT` / `_USER` / `_PASS` / `_PREFIX` | off / — / `1883` / — / — / `homeassistant` | HA discovery target |
| — | `BUILD_VERSION` / `BUILD_DATE` / `BUILD_REF` | `dev`/null/null | Version stamp for `/api/version` |
| — | `ECOFLOW_TRACE_SN` | — | Env-gated MQTT topic/payload trace for one SN |
| — | `BMS_REBASELINE_SUSPECT_ROLLUPS` | `3` | Rollups before a BMS reconnect re-baseline is trusted |
| — | `BMS_RESEED_MIN_GAP_WH` (add-on option) / `BMS_RESEED_SUSTAINED_ROLLUPS` | `50_000` / `2` | Floor/live gap and dwell before a BMS-counter floor re-seeds (§4.6); the published counters continue across it (a basis shift, v1.193.0) |
| — | `BACKUP_POOL_GRACE_HOLD_MS` | `180_000` | SHP2 backup-pool grace hold (§3.3) |
| — | `POLL_SUMMARY_EVERY` | `30` | Polls per debug-level poll-duration summary (§3.1) |

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

### 12. The site clock (`siteTime.ts`)

Every local calendar date, hour, weekday and clock text the add-on computes is in one IANA
zone, the site zone (v1.191.0). Before, three sources disagreed: the host's clock, the
literal `America/Phoenix` and fixed UTC−7 arithmetic, which agreed only on a host whose zone
was the reference plant's.

- **Resolution.** `resolveSiteTimeZone` runs once, when `siteTime.ts` loads, and the zone is
  never switched while the process runs: `SITE_TIMEZONE` when the runtime resolves it, else
  `TZ` (the container's zone, which the Supervisor sets to Home Assistant's; a leading `:` is
  accepted), else `DEFAULT_SITE_TIME_ZONE` (`America/Phoenix`, the only copy of that literal
  in `server/src`). `checkTimeZone` refuses a name `Intl` does not know, a name the runtime
  answers with UTC because its zone data lacks it, and a zone it cannot format numeric parts
  in; a refused value is recorded (`siteTimeZoneResolution().rejected`), raised as a repair
  issue and the chain falls through. It never becomes UTC silently. Links of the legacy zone
  (`US/Arizona`, `MST`, any letter case) read as `America/Phoenix` (`LEGACY_ZONE_LINKS`).
- **Both threads.** The module resolves from the environment alone, so the analytics worker
  computes the same zone as the main thread with no message between them. It logs nothing;
  the main thread logs `site time zone <zone> (source: <source>)` at boot, and `siteTimeHa.ts`
  reads Home Assistant's `/core/api/config` `time_zone` in the background after boot: a
  different zone raises a warning and a repair issue, and the add-on keeps the zone it booted
  with until it restarts.
- **Helpers.** Zone-parameterised pure functions (`zonedWallParts`, `zonedWallTimeMs`, which
  returns the first occurrence of a repeated fall-back time and the first instant after a
  spring-forward gap, `zonedDayStartMs`, `zoneOffsetMs`) and their site-zone forms
  (`siteYmd`, `siteHour`, `siteDow`, `siteMinuteOfDay`, `siteDayStartMs`, `siteDayStartOf`,
  `siteNextDayStartOf`, `siteShiftDaysMs`, `siteNoonIso` for the statistics import, and the
  `fmtSite…` text forms). Every formatter is an `en-US` `formatToParts`; Spanish weekday names
  come from a fixed map (`WEEKDAY_ES`), never from an `es` locale.
- **Readers.** The tariff periods and the MPC tariff vector, the night-charge window, its
  evening notice and schedule, quiet hours and the morning digest, the daily totals and day
  starts (`startOfLocalDayMs`), the Home Assistant statistics import, the telemetry-gap and
  outage alert times, and the console's stamps and its two 1 Hz divider clocks.
- **The web.** The browser never formats a site time in its own zone. The server reports the
  zone as `siteTimeZone` on `/api/site`, `/api/summary/today`, `/api/forecast` and
  `/api/night-charge/status`; `web/src/siteTime.ts` formats in it, and a card with no zone
  shows no time rather than the browser's.

In `America/Phoenix` the site clock equals the former fixed-offset arithmetic at every
instant, so an install with `SITE_TIMEZONE` unset in that zone computes what it did before.

---

