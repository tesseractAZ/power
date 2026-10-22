## 13. Safety & Operational Plumbing

### 13.0 Alarm-host thermal monitor (v1.42.0)

The add-on monitors the machine it runs on. `hostThermal.ts` samples the kernel thermal zones (`/sys/class/thermal/thermal_zone*/temp`, read-only in the container) every 60 s, takes the hottest valid zone (readings outside 5–130 °C are rejected), and holds the freshest sample with a 5-minute staleness bound. Surfaces:

- `host_soc_temp_c` in `/api/ha-state` and the MQTT state payload; discovery sensor `ecoflow_host_soc_temp` (`device_class: temperature`, diagnostic). Trend history comes from the Home Assistant recorder — the add-on stores none.
- Alerts `host-temp-warn` (warning, ≥ `HOST_TEMP_WARN_C`, default 78 °C) and `host-temp-crit` (critical, ≥ `HOST_TEMP_CRIT_C`, default 84 °C), with 3 °C rise/clear hysteresis (`hostTempLevel`, pure). The defaults are tuned for a Raspberry Pi, the reference plant's host: the critical sits just below its SoC's ~85 °C throttle point: thermal throttling slows the alarm pipeline precisely when extreme ambient heat makes it matter most.
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
surfaces as the warning (on the card; audible only once the episode has stood the warning dwell
below); QoS shedding keys on the raw assessment level and engages immediately regardless.

**Warning dwell (v1.187.20).** `host-pressure-warn` is on the card from the first non-ok
assessment and its push keeps the usual 60 s debounce (overnight it goes to the morning digest),
but it counts toward the audible condition only after the pressure episode has stood
`HOST_PRESSURE_WARN_DWELL_S` (default 300 s, range 0–900; 0 = audible at once) or the critical has
sustained; until then it carries `audible: false` and its card says when it would be announced (the
critical dwell when the reading is at critical level). Once audible it stays audible for the episode,
which ends only after ok has stood 180 s (the broadcast's clear dwell), so a dip does not speak an
all-clear and then a second yellow. The episode (onset, audible, last held) is written to
`host-pressure-state.json` beside the database (`HOST_PRESSURE_STATE_PATH`) and carried across a
restart when the add-on held it at most 10 minutes before. The 2026-10-10 22:33 yellow came from a
59 s spike during the HA Core 2026.10.1 update.

### 13.0c Out-of-band dead-man heartbeat (v1.43.0)

In-band self-monitoring fails with the host, so the final layer lives outside the failure domain: `heartbeat.ts` sends an HTTPS GET to an operator-configured external heartbeat receiver (`HEARTBEAT_URL`, healthchecks.io-style) every `HEARTBEAT_INTERVAL_S` (60–3600 s, default 300, ±10 % jitter), starting at boot. When the pings stop — host dead, container OOM-killed, kernel wedged, power lost — the external service notifies the operator from outside the house. Properties: fully inert when no URL is configured; https-only; the URL is treated as a capability token and never logged (only its host, once, on rejection); state-transition-only logging; a send failure is local information only (internet-down ≠ host-down — the external service's own grace period makes the dead-man decision), so the module raises no alerts and only reports `heartbeatStatus()` on `/api/health`. Recommended external configuration: check period = the configured interval, grace ≈ 2 intervals.

*Process guard, host-power self-monitor, HA state cache, onset persistence, message-rate floor, and log/format hygiene — the reliability layer that keeps a life-safety monitor alive and honest.*

This cluster is not a feature the operator sees on a screen. It is the connective tissue that lets every other engine survive the real-world failure modes of a small always-on host, as seen on the reference plant's Raspberry Pi: a daily Supervisor maintenance bounce, a host that loses power almost every day, an EcoFlow cloud session that wedges without going fully silent, and a log stream that floods during outages. Three of these modules (`processGuard`, `hostPower`, `messageRateFloor`) are load-bearing safety components — a bug in them can either kill the alarm or blind it. The rest bound what lands on disk and in the log so a real signal stays greppable and a hostile device name can't hijack the operator's terminal.

All file paths below are relative to `server/src/`. Line numbers cite main at v1.187.15; function and constant names are authoritative where they drift.

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

Installed once near the end of boot in **`index.ts:7032`**:

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

The alarm's own host — a Raspberry Pi on the reference plant — is the single point of failure for the entire monitor: if it loses power, every channel goes dark **at once**. Any under-voltage `binary_sensor` serves; on a Raspberry Pi, HA's *"Raspberry Pi Power Supply Checker"* exposes the kernel under-voltage/throttling flag as a `binary_sensor` with `device_class: problem` (`on` = under-voltage/throttling detected, `off` = OK). A marginal supply — or a sagging power circuit — trips this flag *before* the Pi actually browns out, so surfacing it is an early warning to fix the supply while the alarm is still up. (On the reference plant the host's circuit has historically lost power daily for 84–187 min; this signal is the leading indicator for that class of failure.)

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

- **Cache warm-keeping:** `index.ts:2573` and `:2689` call `haStateCache.refreshIfStale()` whenever `gridPresenceEntityId() || hostPowerEntityId()` is set — the host-power entity rides the same TTL-gated refresh as the grid-presence classifier (ingestion mirrors `gridState.ts`).
- **Alert emission:** `alerts.ts:1338` calls `liveHostPower()`; when `underVoltage === true` it pushes a **warning** alert `host-power-undervoltage` (category `Connectivity`, device `System`) advising the operator to check the host's supply and circuit before it browns out.

#### Output shape (the alert)

```json
{ "id": "host-power-undervoltage", "severity": "warning",
  "category": "Connectivity", "device": "System",
  "title": "Alarm host power — under-voltage",
  "detail": "The host running this monitor reported under-voltage (<entityId>). …" }
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
2. **Dedicated power sensor** — if `attributes.device_class === 'power'`, read the entity **state** as the value, honoring unit: when `unit_of_measurement` is `kW` in any case (the code upper-cases it before comparing with `'KW'`), multiply by 1000; otherwise watts as-is.
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
| `getCacheAgeMs(now)` | `lastFetchedAt ? now - lastFetchedAt : +Infinity` |
| `refreshIfStale(now)` | `Promise<void>`: the TTL-gated, coalesced refresh above (the module exports no test-reset hook) |

#### Trace / wire-in

- Refreshed at `index.ts:2573/2689` before grid/host reads, and at `:2832` before the load-shed advisor tick (only when shed candidates are configured).
- `haEntity: (id) => haStateCache.getCachedEntity(id)` supplied to the advisor (`index.ts:2814`).
- Age surfaced on `/api/load-shedding/status` as `haStateCacheAgeMs` (`index.ts:3203`).
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
- `syncAlertOnsets(activeIds, nowMs, { prune })` — **the single per-cycle hook.** Each active id not yet recorded is stamped `nowMs` (`changed = true`). Each recorded id no longer active is deleted (`changed = true`) unless `prune` withholds it: `prune: false` keeps every absent id, and a predicate (v1.186.0) prunes only the ids it returns true for. It persists **only if `changed`**. `alertMonitor` prunes an absent id once its absence is evidence: the analytics-worker feed that owns it has delivered since boot, or, for a live-snapshot id, the store has hydrated. As a fallback bound, it also prunes once `LEARNED_RESOLVE_GRACE_MS` (10 min) has passed, counted from hydration for a device-derived id (v1.186.3) and from boot for any other. A steady-state tick with an unchanged roster is a pure in-memory no-op. Wrapped in try/catch so a disk/permission failure can never propagate into the alarm loop.
- `getAlertOnset(id)` — look up first-seen ms; `undefined` if never recorded, pruned, or the sidecar failed to load.

#### The clear-then-rise semantics

Pruning an id once it has left the active set and its absence is evidence (above) means a later **re-fire** of the same id gets a *fresh* onset — matching how every other alarm-lifecycle concept in this codebase (`tracked`, notify-state, telemetry) treats a clear-then-rise as a **new event**, not a continuation.

#### Trace / wire-in

- **Write:** `alertMonitor.ts:4155` calls `syncAlertOnsets(new Set(tracked.keys()), now, { prune })` once per evaluate tick, alongside the falling-edge/dwell loop. `alertMonitor.ts:3724` calls `restampAlertOnset(id, now)` (v1.173.0) when the pack residency check finds a new subject under a still-active id.
- **Read:** `telnet/plant/alm.ts:205` renders each row's timestamp as `fmtTs(getAlertOnset(a.id) ?? stamp)`: the onset if known, else the pre-existing `generatedAt` fallback. Two other readers:
  - `alertMonitor`, for a cleared alert's true duration in its history record (`getAlertOnset(id) ?? t.firstSeen`, `:3651`) and for the boot re-track decision (`priorOnsetMs`, `:3761`).
  - The broadcast pre-filter `speakableAlerts` (`broadcast.ts`), which passes it as `onsetOf` to the cell-imbalance speak hold (`heldForImbalanceConfirm`).

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
| `minBaselineRate` | `MSG_RATE_FLOOR_MIN_BASELINE` | `10` msg/min | Eligibility floor, tested against the high-water mark `peak` |
| `floorFraction` | `MSG_RATE_FLOOR_FRACTION` | `0.2` | Collapse when the live rate is below this fraction of the comparison baseline |
| `collapseMs` | `MSG_RATE_FLOOR_COLLAPSE_MIN` | `20` min | Collapse dwell for a device with a diurnal profile |
| `flatCollapseMs` | `MSG_RATE_FLOOR_FLAT_COLLAPSE_MIN` | `4` min | Collapse dwell for a flat-profile device (v1.95.0) |
| `flatnessMaxCv` | `MSG_RATE_FLOOR_FLATNESS_MAX_CV` | `0.15` | Max coefficient of variation across mature hour buckets for "flat" |
| `flatnessMinMatureHours` | `MSG_RATE_FLOOR_FLATNESS_MIN_HOURS` | `18` | Mature hour buckets required before flatness is trusted |
| `recoverMs` | `MSG_RATE_FLOOR_RECOVER_MIN` | `5` min | Dwell before a fired collapse clears, or a pending one is forgiven |
| `baselineAlpha` | *(constant)* | `0.2` | EWMA alpha upward, and the symmetric global EWMA |
| `baselineAlphaDown` | *(constant)* | `0.02` | Hour-bucket EWMA alpha downward (10× slower) |
| `minHourSamples` | `MSG_RATE_FLOOR_MIN_HOUR_SAMPLES` | `30` | Healthy samples before an hour bucket outranks the global baseline |
| `peakHalfLifeMs` | `MSG_RATE_FLOOR_PEAK_HALFLIFE_DAYS` | `7` days | Half-life of the eligibility high-water mark |

#### The algorithm (`sample(sn, cumulativeCount, nowMs)`)

Per SN it holds `{lastCount, lastMs, baseline, peak, hourly[24], hourlyN[24], collapseSinceMs, recoverSinceMs, fired, wasEligible}`. The learned part (`baseline`, `hourly`, `hourlyN`, `peak`) is written to `msg-rate-floor.json` beside the database every 10 ticks and hydrated at boot; `MSG_RATE_FLOOR_STATE_PATH` overrides the path. Counters and timers are never restored, so a restart cannot resurrect an in-flight collapse.

1. **First sample** ⇒ seed state, return `{rate:null, baseline:0, collapsed:false, recovered:false, collapsing:false}`.
2. `dtMin = (nowMs - lastMs) / 60000`. If `dtMin <= 0` ⇒ return the current state's `collapsing = fired` (no time passed).
3. **Counter reset guard:** if `cumulativeCount < lastCount` (a process restart re-zeroes the counter) ⇒ re-baseline instead of computing a negative/huge rate; clear the collapse; `recovered` reflects whether it had `fired`.
4. `rate = max(0, (cumulativeCount - lastCount) / dtMin)`.
5. **Eligibility from a high-water mark:** `peak = max(rate, peak × 0.5^(dt / peakHalfLife))`; `eligible = peak >= minBaselineRate`. The mark rises instantly and decays over days, so a collapse cannot disarm the detector. A device that does lose eligibility is logged `NO LONGER MONITORED` (`eligibilityLost`).
6. **Comparison baseline:** `cmpBaseline` is this hour-of-day's bucket once it holds `minHourSamples` healthy samples, else the global EWMA (v1.66.0). Then `isCollapsed = eligible && rate < floorFraction * cmpBaseline`.
7. **Baseline update — each estimator gated on its own view:**
   - global: unless `eligible && rate < floorFraction × baseline`, `baseline = baseline == 0 ? rate : 0.2·rate + 0.8·baseline`. It is symmetric, so it follows the diurnal swing while buckets are immature.
   - hour bucket: unless the bucket is mature and `rate < floorFraction × bucket`, update at `baselineAlpha` (0.2) when `rate ≥ bucket` and at `baselineAlphaDown` (0.02) when below, and count the sample.

   A sub-floor sample never moves an estimator, and the 10× slower downward rate stops a ramp-down from walking the bucket down to meet a collapse. The v0.92.0 claim that a single healthy-only EWMA was immune was false: samples between 0.2× and 1× of the baseline still eroded it.
8. **Dwell on both edges:**
   - Not fired, `isCollapsed`: set `collapseSinceMs` (from the last healthy sample) if unset. The collapse fires (`fired = true`, `collapsed = true` for one tick) after `flatCollapseMs` (4 min) if the device's mature hour buckets are flat (`isFlatProfile`: ≥ 18 mature buckets, cv ≤ 0.15; v1.95.0), else after `collapseMs` (20 min).
   - Not fired, not collapsed: a pending `collapseSinceMs` is forgiven only after `recoverMs` (5 min) of non-collapsed samples.
   - Fired: it clears (`recovered = true`) only after `recoverMs` of `rate ≥ max(floorFraction × cmpBaseline, minBaselineRate)`. Losing eligibility, or a bucket that learned the starved rate, never reads as recovery.
9. Return `{rate, baseline: cmpBaseline, collapsed, recovered, collapsing: fired, usedHourBucket, eligibilityLost, eligibilityPeak}`.

#### False-positive guards (by design)

- **Eligibility floor** — only a device whose high-water mark reaches `minBaselineRate` can "collapse" (SHP2 ~30/min qualifies; idle/spare units never do). The mark's 7-day half-life means an outage cannot disarm it.
- **Hour-of-day baselines** — the Cores' 13× diurnal swing (idle ~4.6–6.2 msg/min at 19:00–22:00) is compared against the same hour, not a daily average (v1.66.0).
- **Asymmetric bucket EWMA** — a sub-floor sample never updates an estimator, and a mature bucket decays 10× slower than it rises.
- **Persistence windows** — 20 min (4 min for a flat-profile device) before firing; 5 min of genuinely healthy traffic before clearing.
- **Surfacing gates** (index.ts tick, `decideCollapseSurfacing`) — an offline device is never surfaced; the offline alert owns it. An electrically idle device (< 30 W in + out, v1.108.0), or one whose rate has already rebounded (v1.112.1), does not enter the surfaced set, but neither condition evicts an episode already surfaced.
- **Edge-triggered** — fires once, then holds `collapsing` until recovery (stable dedup key across ticks).

#### The self-alert (`messageRateFloorAlert.ts`)

v0.92.0 only `app.log.warn`-ed a collapse — invisible to the operator. v0.93.0 promotes it to a push alert. The 60 s tick publishes the currently-collapsing set via `setRateFloorCollapses(...)`; `alertMonitor` turns each into a **warning** Alert through the same notify + `snapshot.alerts` pipeline as offline/stale alerts (it is **not** `annunciate:false`).

- `rateFloorAlertId(sn) = "msg-rate-floor-<sn>"` — stable per device, so it de-dups across ticks and simply drops from the set on recovery.
- `rateFloorAlerts(collapses)` — pure builder, one Alert per device: `severity: 'warning'`, `category: 'Connectivity'`, `priority: 'medium'` (explicit ISA P3 — serious but must **not** read as a High protective-limit breach and must **not** break through quiet hours as a full emergency). Facts: live rate + `~<baseline>` msg/min. Detail names the trap explicitly (looks fresh, defeats staleness + gap detectors, floor/SoC/runway effectively stale) and recommends a power-cycle for a clean reconnect. **v1.187.10** — the first surfacing of an episode freezes its onset rate and baseline (`surfacedCollapseEntry`, a `Rate at onset` fact); a card whose live rate is back at or above the floor during the 5-min recovery dwell says it fell to the onset figures and is now recovering, with the recovery bar, instead of "collapsed to 27.0 msg/min, far below its learned ~25" (all 78 closing bodies in the live ledger were at or above the floor). The collapse log line is WARN, or INFO naming the mute for a device the roster mutes (bench spare, off-panel Core: `rateFloorCollapseLine`, `rosterMuteReasonForSn` from the last alert tick).

#### Trace / wire-in

`index.ts:2855`: `const rateFloor = new RateFloorTracker()`, hydrated from `msg-rate-floor.json` at `:2933–2939`. It is driven by a 60 s `setInterval` (`.unref()`-ed) at `:3029–3195`:

```
for {sn, count} of rateFloorSampleSet(Object.keys(devices), store.mqttMsgCountBySn):
    r = rateFloor.sample(sn, count, now)
    dec = decideCollapseSurfacing(r.collapsing, online, idle, alreadySurfaced, starvedNow)
    if !online → drop sn from the surfaced set; continue
    if dec.surfaced → push surfacedCollapseEntry(...) into collapses   // onset rate frozen (v1.187.10)
    if dec.logCollapse → WARN (INFO naming the mute for a roster-muted device)
    else if r.recovered and it had surfaced → app.log.info(... recovered)
    if r.eligibilityLost → WARN 'NO LONGER MONITORED'
setRateFloorCollapses(collapses)
→ session self-heal quorum (v1.76.0); learned baselines persisted every 10 ticks
```

**v1.131.0 — sample the roster, not the observation map.** The tick used to
iterate `store.mqttMsgCountBySn` directly. That map gains an entry only inside the
MQTT ingest path, so a device that has produced **zero** messages since process
start is simply absent from it and was never sampled at all: the detector was
armed for a 0.2 msg/min collapse and blind to a 0.0 msg/min one — and a restart is
precisely what converts the first into the second. The blind spot landed on the
one device the section above calls "the single-point-critical alarm data source".
`rateFloorSampleSet(rosterSns, counts)` (`messageRateFloor.ts`) drives from the
device roster with `counts.get(sn) ?? 0`, so silence enters the existing dwell and
eligibility logic as the rate-0 sample it is; serials present in the counter map
but absent from the roster are still sampled, so a mid-run roster change cannot
silently drop a device out of monitoring. Mutation-proven load-bearing
(`scripts/mutate-detector-honesty.mjs`, mutants xiv–xv).

Errors in the tick are caught and logged at DEBUG (`tick skipped`). The tick raises only its own `msg-rate-floor-*` alerts, but its output acts elsewhere in two ways:
- The published collapse set freezes learned `baseline-*` anomalies for a starved Core (`applyStarvedFeedFilter` / `starvedFeedSns` in `alertMonitor`, v1.79.0/v1.184.0). While the feed is starved they are neither raised nor resolved.
- A sustained collapse quorum triggers the MQTT session self-heal (`rebuildMqttSession`, v1.76.0, with a cooldown and a 24 h budget).

It never touches the REST poll, which is the alarm data path.

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

**Wire-in.** `ecoflow/mqtt.ts:161/165` — `stormLog` and `stormWarn` (flushed on recovery at `:168–169`) wrap the module's info/warn loggers around the reconnect loop. This is the logging analogue of the storm gate in `broadcast.ts`.

#### 6.2 `logSanitize.ts` — bound what's persisted / rendered

Shared sanitizers for request/network-derived values that are **intentionally** persisted (audit log, alert outcomes, model notes) or rendered to a terminal. They don't make tainted data "safe" in the CodeQL sense (recording provenance is the feature) — they bound what can land on disk.

| Function | Behavior |
|----------|----------|
| `cleanText(v, max)` | Non-string ⇒ `undefined`. Strip C0/DEL (`\x00–\x1f`, `\x7f`), clamp to `max`. |
| `sanitizeDisplayName(v, max=64, fallback='')` | **Security #2, CWE-150.** Strip **all C0 (incl. ESC 0x1b), DEL, and C1 (0x7f–0x9f, incl. 8-bit CSI 0x9b)**, collapse runs to a space, trim, clamp. Non-string / all-control ⇒ `fallback`. Prevents a device/circuit name set in the EcoFlow app or SHP2 config from injecting terminal escape sequences (OSC title-set, OSC 52 clipboard-write, cursor control) that would execute in the operator's terminal when they view the TUI. |
| `cleanMultilineText(v, max)` | Like `cleanText` but **preserves `\n` and `\t`** (operator-typed multi-line notes). |
| `finiteNumber(v)` | Finite number or `undefined` (so `JSON.stringify` drops it like an absent field). |

**Wire-in.** `sanitizeDisplayName` guards every cloud/MQTT-sourced display name at the ingest boundary: `snapshot.ts:586` (`deviceName`, max 48, falls back to the SN) and `ecoflow/project.ts:617/630` (device + SHP2 circuit names).

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

**Wire-in.** `index.ts:2352` — `const transientBoot = classifyMqttStartFailure(attempt, msg, MQTT_BOOT_GRACE_ATTEMPTS) === 'warn'`.

#### 6.4 `haPayloadFmt.ts` — shared HA payload formatting

**What + why.** The REST `/api/ha-state` handler (`index.ts`) and the MQTT-discovery `buildState` (`mqttDiscovery.ts`) carried **byte-identical** copies of these formatters. Factored out **verbatim** so the published HA sensor values are unchanged across both surfaces.

| Helper | Behavior |
|--------|----------|
| `kwh1(wh)` | Wh → kWh at 1 decimal, null-safe: `wh == null ? null : Math.round(wh/100)/10`. Used for SHP2 backup-pool fields. |
| `makeLifetimeKwh(lifetime)` | Returns `(k) =>` lifetime key → kWh at 3 decimals over `persistedWh + pendingWh`. Preserves the exact **falsy-entry** guard (`lifetime[k] ? … : null`, *not* `!= null`), so a missing **or** zero/falsy entry maps to `null` as before. |
| `makeAlertCounter(alerts)` | Returns `(src, sev) =>` count. `src === 'learned'` ⇒ `a.source === 'learned'`; `'threshold'` matches **every non-`learned`** source (`a.source !== 'learned'`) — verbatim. |
| `soonestProjecting(packs)` | Returns `{ projecting, soonest }`: packs with `status === 'projecting'`, and the fewest-`yearsToEol` pack via a reduce using the `?? 1e9` sentinel so a `null` `yearsToEol` sorts **last** — verbatim. |

A fifth helper, `dailyFigureResetIso(reportGeneratedAtMs)` (v1.187.10), returns the ISO local midnight that starts the day a re-estimated daily figure covers. It takes that day from the report's `generatedAt`, or uses today when there is no report. Its output is published as `pv_clipped_kwh_today_since` and `pv_curtailment_kwh_today_since`.

**Wire-in.** `index.ts:23` and `mqttDiscovery.ts:11` import all five. In the `/api/ha-state` handler: `:1573` (`lifetimeKwh`), `:1577` (`soonestProjecting`), `:1589` (`makeAlertCounter`), `:1609–1610` (`kwh1` for `backup_full_capacity_kwh` / `backup_remaining_kwh`), `:1681`/`:1692` (`dailyFigureResetIso`).

---

### Cross-cutting design invariants

- **Collapse the method, never the measurement.** Every unknown here (host-power stale, cache cold, onset missing, rate not yet computed) reports honest-null and falls back — none fabricates a value or a false alarm.
- **Best-effort never blocks the alarm loop.** `alertOnset`, `haStateCache`, and the rate-floor tick all wrap I/O in try/catch so a disk/permission/network failure degrades gracefully instead of crashing the life-safety process.
- **Pure cores, injected clocks.** `classifyTopLevelError`, `interpretHostPowerEntity`, `extractEntityWatts`, `RateFloorTracker.sample`, `makeLogCoalescer`, `classifyMqttStartFailure`, and the `haPayloadFmt` helpers are all pure/clock-injected and unit-tested off the live pipeline.
- **Greppable loudness.** Survived-but-suspicious events (`process-guard: SURVIVED …`, coalescer roll-ups, boot-grace WARNs) stay findable so a *masked recurring* fault can still be diagnosed.


---

