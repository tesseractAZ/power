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
- Edge cases & honest-null summary
- 2.14 Request-signing clock correction (`clockOffset.ts`)
- 2.15 Telemetry-blind self-alert (`telemetryBlind.ts`)
- 2.16 Cloud-session self-heal (`sessionSelfHeal.ts`)

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
`getQuotaData` (v1.82.0: `POST /iot-open/sign/device/quota/data`, the SHP2 historical-energy
endpoint, read-only despite the verb), `getMqttCertification`, and `sendCommand`. Reads
(GET/POST) are bounded by `ECOFLOW_REST_TIMEOUT_MS` = 30 s for headers and body (v1.179.0),
so one hung read cannot hold the poll past `SHP2_READBACK_STALE_MS`. Writes (PUT) keep
undici's defaults, because a slow write may still have landed and a re-send can escalate
falsely. A read that answers code `"0"` with a null `data` throws (v1.171.1); a write may
legitimately do so (v1.171.2). Every response's `Date` header feeds the clock-offset
learner (§2.14). Every call funnels through `call()`, which:

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
`randomInt(100000, 999999)`; `timestamp` is the injected `nowMs` in ms. `rest.ts` passes
`signingNowMs()`, the local clock corrected by the offset learned from server `Date` headers
(§2.14); `Date.now()` is only the fallback when no clock is passed.

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
   reconnectPeriod: 5000, keepalive: 30, rejectUnauthorized: true, resubscribe: true })`.

**Cert fetch retry** (`getMqttCertificationWithRetry`): up to 5 attempts with waits of `2s, 4s, 8s, 16s` between them (the schedule's final `30s` entry is never reached, because the fifth failure throws);
only retried when `isTransientNetworkError()` matches (`EAI_AGAIN`, `ENOTFOUND`,
`ECONNREFUSED`, `ETIMEDOUT`, `timeout`, `connect timeout`, `fetch failed`). This is
the same classifier the process guard uses as its survive/fatal gate, so it was
deliberately narrowed — the bare `network` token was dropped because it matched
"neural network training failed"-style strings.

#### Subscription model

EcoFlow's ACL **rejects wildcard subscribes** (`+/quota`), so the client subscribes
**per-SN**: `[/open/{username}/{sn}/quota, /open/{username}/{sn}/status]` at QoS 0.
It subscribes to every SN currently in the store on `connect`, and subscribes newly
appearing devices whenever the store emits `change` (while connected). A `subscribed` `Set`
coalesces bursts and rolls back on subscribe error. The set is never cleared on close, so
after a reconnect or session rebuild this loop no-ops for every known SN. Re-subscription
then rests on mqtt.js re-issuing the subscriptions itself, which the client pins with
`resubscribe: true` (v1.145.0) rather than inheriting the library default.

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
`ECOFLOW_TRACE_FILE` (appends that SN's full messages to a file; it does nothing unless `ECOFLOW_TRACE_SN` is also set), `ECOFLOW_TRACE_TOPICS=1`
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
| `lastSourceBySn` | `'rest' \| 'mqtt'` |
| `lastMqttAtBySn`, `mqttMsgCountBySn` | per-SN MQTT liveness |
| `lastDeviceListAttemptAt` / `…SuccessAt` | distinguishes "cloud session stale" from "device genuinely offline" |
| `frameSeq` | monotonic counter bumped on every `change` emit; lets the WS layer serialize the 50–150 KB snapshot frame **once** per emit and reuse the bytes across clients |

#### `DeviceSnapshot` shape

```ts
{ sn, deviceName, productName, online, lastUpdated, lastError?, lastErrorAt?,
  projection?, raw? /* only if SNAPSHOT_INCLUDE_RAW=1 */, grid?, off_grid? }
```

`lastUpdated` = ms epoch of the last evidence of life. That is a REST quota or a translated
MQTT delta, and also, deliberately (v1.142.0), a bare `/status` online/offline flip, so a 6 s
flip cannot raise a self-clearing stale alert. Control readbacks must not key on it; they read
`lastQuotaAtMs` (see *Three clocks* below). The `Telemetry stale`
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
`setDeviceError`). Routine poll success is reported as a PERIODIC DISTRIBUTION (p50/p95/max per POLL_SUMMARY_EVERY polls, v1.148.0 — it was a line per poll and became 32.5% of all log bytes; demoting it would buy nothing because LOG_LEVEL=debug is standing and the ring captures stdout at every level); only **recovery**
(failure→ok) and **slow** (`>= SLOW_POLL_MS = 5000`) polls stay at INFO; a failed poll
logs at **warn**. Every 10 min a **fleet-status** line reports each device by name as
`ON/<count>msg/<age>s`, `OFF` or `API-online/no-MQTT`. The full line goes out at INFO on a
state change, on the first dump and as an hourly anchor (`STATUS_ANCHOR_MS`). Otherwise a
compact DEBUG line lists only the MQTT-reporting devices plus a count of the rest
(v1.187.10; see *Log forensics* below).

**v1.187.10 — failures as a delta, causes per episode.** The poll's failure set is logged as a
change against the previous poll (`pollFailureLines`): **warn** names only the devices newly
failing outside the standing product-class 1006 set, with their error class (`quotaErrorCode`:
`1020`, `HTTP 502`, `timeout`, …) and the alarm-path panel marked (it is never treated as
standing, whatever its code); devices newly failing with 1006 (the standing accessory set, at every
boot), devices that answered again (`recovered`), devices no longer asked (listed offline — not a
recovery) and the daily heartbeat are **info**. Each device's cause is logged once per failure
**episode and code**, with a recovery line when its quota fetch succeeds again; only 1006 says
"serves from device/list presence only", and an alarm-path panel's cause is logged at warn. (It was
once per process and serial, with the 1006 wording for every code: a one-poll 1020 rate limit read
as permanent, and a device failing again later left no cause in the journal.)

##### Attempted vs failed — the three-state rule (v1.138.0)

`refreshAll()` returns `{ attemptedSns, failedSns }`, **not** a bare failure list.
`attemptedSns` is the `online === 1` filtered set — the devices this poll actually
asked. `failedSns` is always a subset of it.

The distinction is load-bearing. Absence from `failedSns` has three causes and only
one of them is success:

| Cause | Meaning |
|---|---|
| the fetch resolved | a real recovery |
| the device was `online: 0`, so never fetched | **unevaluable** |
| it fell out of `/device/list` entirely | **unevaluable** |

Two detectors previously read absence as success. One survives as a pure exported
function taking `attemptedSns` explicitly: `pollHealthVerdict` (S1). It separates an
alarm-path SHP2 that was asked and failed (`shp2-fetch-failed`) from one never asked because
the list showed it offline (`shp2-not-polled`), so a cloud-offline panel no longer counts as
a healthy poll for the telemetry-blind detector. Its full verdict set, and its harness
`scripts/mutate-poll-health-attribution.mjs`, are under *The evidence doctrine* below. The
other detector was deleted:

**`longFailureRecoveries(...)` was REMOVED in v1.139.0.** It announced the moment a
1006-blocked accessory started answering — the "EcoFlow enablement doorbell". The premise
was false: **API error 1006 is a product-class limit, not a grantable account
permission** (settled 2026-09-08; EcoFlow is not expected to extend API
coverage to these device classes). The condition it watched for cannot occur, so every
firing it could produce was necessarily false — and it did fire, pushing "EcoFlow data
restored" to the operator's phone 302 ms after the device went OFFLINE. A detector that
can only fire falsely is worse than none on a life-safety system: it teaches the operator
to discount the push. A source pin in `pollHealthAttribution.test.ts` keeps it deleted.

##### The web membership mirror is CHECKED, not promised (v1.146.0)

`web/src/shp2Membership.ts` is a hand-maintained literal copy of the server
module — a deliberate choice, because the React UI and the Lit HACS cards have
different module graphs. Its header has demanded lock-step since v0.9.75.

**That demand failed three times.** When found it was three server revisions
behind: a single `find` where the server had unioned across every panel since
v1.129.0, so with a second SHP2 present every DPU wired to it fell out of the
connected set and was dropped from `EnergyFlow`'s fleet totals and `ThermalPanel`.

A comment is not a mechanism. Both files export pure functions and the web
module's only import is `import type`, which is erased at runtime — so
`server/test/webServerMembershipParity.test.ts` imports **both real
implementations** and runs them side by side over shared fixtures. Drift now
fails the build. The suite also pins the VALUE, not just the agreement: a parity
test alone would pass if both sides were broken identically.

**When editing either file, edit both.** The parity test will tell you if you did
not.

##### A ratio needs the same population on both sides (v1.146.0)

Two fleet roll-ups filtered numerator and denominator **independently**, so a
pack reporting its design capacity but not its current one landed in the
denominator alone and the UI rendered degradation that did not exist:

- `ThermalPanel.tsx` — `if (fullCapMah != null) fullMah += …` beside
  `if (designCapMah != null) designMah += …`
- `DegradationCard.tsx` — `sumDefined` over the unfiltered pack list, twice

Both are pair-gated now. The server's per-pack degradation already gated this way;
only the roll-ups did not.

##### Log forensics — the ring IS the incident window (v1.145.0)

The add-on log ring reaches roughly **53 hours**. Bytes spent restating unchanged
state are hours of history not available during an incident, and that is not
hypothetical: an SHP2 question in this project could not be settled because the
window had already rolled past it.

| line | was | now |
|---|---|---|
| `fleet-status` 10-min dump | 314 lines / 53 h carrying **one distinct body** | INFO on state **change** + one hourly anchor (full line); **v1.187.10** an unchanged tick emits a **compact** line — only the devices on MQTT (counter and age) plus a count for the OFF / API-online/no-MQTT entries. v1.145.0 only demoted the unchanged line to DEBUG, which saves nothing at the standing `LOG_LEVEL=debug`: those lines were 44.7 % of the reviewed journal's bytes |
| `recorder: N samples in last …` | debug-*gated*, info-*emitted* (v1.143.0) | a real debug channel |
| `solar-model: fitted on N/M` | 109 lines, 54 exact consecutive repeats | emitted on change |
| `poll: N device fetch failure(s) persisting` | hourly | daily — it reports a permanent, settled limit |
| `weather: periodic GHI persistence (264 hours)` | every 45-min tick, byte-identical, whether or not anything was written (54 lines / 40.8 h, 35 on ticks that wrote nothing) | **v1.187.10** removed: the recorder logs every real write; the tick logs "nothing new to store" at most every 6 h, and "no forecast available" / "available again" on the transitions (`createGhiTickLogger`) |
| `device-list: … first sight` | the raw cloud name (a device listed under its serial printed it twice; a leading space was kept) | **v1.187.10** the resolved, sanitized name the store keeps |
| `audioRenderer: terminator pre-warm` | two byte-identical summaries (one per language) | **v1.187.10** names its language (`(es)`, `(en)`) |
| Fastify `FSTDEP023` deprecation | one non-JSON warning per boot (`disableRequestLogging` top-level option, removed in fastify@6) | **v1.187.10** request logging is turned off through `logController: new LogController({ disableRequestLogging: true })` (`panelFastifyOptions`, logHooks.ts) |

`statusDumpLevel`'s signature deliberately **excludes** the per-device message
counters and the device-list age. Those move every tick, so including them would
make every dump a "change" and silently restore the every-tick behaviour while
still looking correct. There is a mutant for exactly that.

> **Parsing the log:** 216 of ~4,900 lines are non-JSON (s6/bashio container
> banners and Node's `ExperimentalWarning` for `node:sqlite`). Guard every
> aggregation with `startswith('{')`. The warnings are deliberately **not**
> suppressed — `--no-warnings=ExperimentalWarning` would hide every future
> experimental-API warning to save under 1% of lines.

**A device that disappears from `/device/list`** now leaves one breadcrumb naming
it, once per disappearance. It is deliberately *only* a breadcrumb: marking an
absent device offline would invert a cloud-side list glitch into a device alarm,
which is the wrong direction here. Its `online` value stays frozen, and the log
says so.

##### Absence on the render surface (v1.145.0)

The same doctrine as the evidence gates above, one layer out — a screen that
paints an unknown **green** is making a claim the data does not support, on the
layer a human actually reads.

- `gen.ts` — every fault term is `x != null && <test>`, so a pack that reported
  **nothing** scored false on all of them and rendered `NORMAL`. It now renders
  `NO DATA` in grey.
- `pv.ts` — `(code ?? 0) === 0` collapsed *no error* and *no reading* into one
  green `OK`. Absence now gets the grey the benign-idle case already used.
- `bus.ts` — `deviceQuality` was computed and never rendered, leaving BUS the only
  Plant screen with no staleness indication, while its liveness tick reads
  `snap.generatedAt`, which advances whether or not the SHP2 answered.
- `EnergyFlow.tsx` — `(soc ?? 0)` averaged a silent DPU in as a 0% pack: four
  Cores at 80% with one silent read as 64%, a number no pack holds.
- `ThermalPanel.tsx` — a `—` tile painted `text-ok`.
- `AlertsPanel.tsx` — "every pack is tracking its siblings" computed from online
  DPUs only, so it overclaimed whenever one was dark.

##### Cloud shadows and the sticky clocks (v1.142.0 / v1.143.0)

A fourth reading of the same family, and the one no fetch-keyed gate can see:
**the call succeeds and the CONTENT is replayed.**

| state | closed by | keyed on |
|---|---|---|
| asked and **failed** | v1.86.0 | the fetch |
| **never asked** | v1.138.0 | the fetch |
| asked, answered 200 OK, **stale body** | v1.142.0 | the **content** |

`shp2ContentWitness` fingerprints the twelve per-circuit watts plus the
whole-panel scalars. The vector is the point: `grid_power_home` alone legitimately
holds 0 W for 12.5+ hours on a sunny day, while over 1,558 sampled minutes the
full twelve-channel vector never held identical for even one minute. Staleness
requires **both** a repeat count and an elapsed duration; an unmeasurable poll
resets rather than accumulating. Release has hysteresis (v1.154.0): once latched,
the panel must show `SHP2_SHADOW_CLEAR_DISTINCT` (2) distinct new witnesses before it
reads live again (`advanceShadowLatch`), so one refreshed body that the cloud then replays stays one latch with its original onset; the frozen body reappearing starts the count over. `computeHomeGridWatts` and
`computeShp2GridConnected` then treat a shadowed panel exactly as v0.88.0 already
treats an offline one. `sensor.ecoflow_panel_shp2_payload_frozen` publishes the
held duration.

**Three clocks, three meanings — do not collapse them:**

| field | advanced by | used for |
|---|---|---|
| `lastUpdated` | any evidence of life, incl. a bare `/status` flip | the 3-min *Telemetry stale* alarm |
| `lastQuotaAtMs` | a real quota write only | **control readbacks** |
| `lastErrorAt` | a poll failure only | so an error cannot reset the staleness clock |

`setDeviceOnline` deliberately bumps `lastUpdated` (a 6 s flip must not raise a
self-clearing stale alert) and deliberately does **not** bump `lastQuotaAtMs` (it
never touches the projection). That is the third path into the defect v0.97.0 and
v1.3.0 each fixed elsewhere.

> ★ `setDeviceList` rebuilds every device object from an explicit literal on each
> 60 s poll and silently drops any field not named there. Every sticky clock must
> be listed in it. `lastErrorAt` was lost that way from v0.97.0 until v1.143.0 —
> masked, because the next `setDeviceQuota` re-derives most of them microseconds
> later, but **not** when the quota fetch then fails, which is exactly when a
> frozen projection matters. There is a mutant per field.

##### Push dwells are a per-family table (v1.143.0)

`pushDebounceMsFor` holds the exceptions. A family that repairs itself within a
known window should not page inside it — the alert still appears on screen
immediately; only the push waits. `msg-rate-floor-` waits 20 minutes, which is
`sessionSelfHeal`'s own starvation trigger, on the measurement that 42 of 50
pushes in one 52.5 h window were that family with a 9-minute median duration.
v0.38.0 set the precedent for the load-anomaly family at 72% of pushes.

The prefix must stay **exact**: leaking a 20-minute hold-down onto a neighbouring
family would delay a real page, a worse defect than the one it fixes. Pinned by a
boundary test and a mutant.

##### The evidence doctrine (v1.140.0)

Four detectors read absence from a filtered collection as evidence of success.
They are now gated on the same rule the alert falling edge already states as
`fallingEdgeFrozenByEvidence`: **a thing that was never observed is unevaluable,
not recovered.**

| Gate | Was | Now |
|---|---|---|
| `alarmPathShp2Sns()` | roster filtered on `projection.kind === 'shp2'` — a projection only exists after a SUCCESSFUL fetch, so a restart while the panel was dark left it `[]` for the whole window | resolved by IDENTITY via `shp2Panels` (`productName`), which `setDeviceList` keeps for offline devices |
| `shp2ReadbackFresh()` | the actuator compared a FROZEN projection to its target by strict equality | a control readback requires `online === true` and a sample newer than `SHP2_READBACK_STALE_MS` |
| `orphanedNotifiedIds()` | any persisted id absent from (current ∪ tracked) was resolve-pushed at boot | ids whose source device is absent/stale are **held**; the hold has a deadline and expiry **drops**, never resolves |
| `retireAbsentPacks()` | deleted a confirmed record after 48 h of absence, however that absence arose | retirement requires the pack's LAST SEEN chassis to be online and reporting; a `DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS` backstop bounds the hold |

Two properties are load-bearing and easy to lose:

- **Holds need deadlines.** Several devices are permanently unevaluable — an
  RMA'd Core (`setDeviceList` never deletes, so it sits at `online:false` for the
  process lifetime), a bench spare whose offline state is by design, and the 1006
  accessories which report `online:true` with `lastUpdated:0`. Without a deadline
  their notifications would linger forever.
- **A never-pushed record is dropped before the evidence test.** A `sent:false`
  record cannot produce a false all-clear, and holding those would stop the sweep
  collecting for exactly the noisiest families it exists to clean up.

`sensor.ecoflow_panel_poll_health` publishes the poll verdict (`ok`, or
`shp2-fetch-failed` / `shp2-not-polled` / `shp2-content-frozen`). The three are
ordered by how hard the evidence is — a failed fetch is the plainest fact, a
never-asked device the next, and a frozen payload the weakest inference — so the
verdict always names the strongest evidence available and `shp2-content-frozen`
(v1.148.0) is reported only when the panel answered, answered `200 OK`, and
returned a body byte-identical to the last one for longer than the shadow
witness tolerates. It exists because the SHP2 half of this
had to be argued from code reading: the value was computed every 60 s and stored
nowhere, so no amount of history could show whether it had ever manifested.

Proven by `scripts/mutate-absence-evidence.mjs` (18/18 killed), including four
mutants that leave every pure function correct while reverting a live call site.

> If EcoFlow ever does extend coverage, the honest signal needs no detector: the device
> stops erroring and `lastUpdated` advances. Check `/api/debug/raw`. Note also that an
> accessory contributes **no** alarms, energy totals or HA entities even when its data
> flows — there are zero server-side consumers of a `generic` projection (see
> §Projections), and for PowerInsight and the EVSE an all-null projection would actively
> regress the UI by replacing `SmallDeviceCard`'s honest "app-only device" badge.

Proven by `scripts/mutate-poll-health-attribution.mjs` (8/8 killed), including mutants
that leave `pollHealthVerdict` correct while making the real `tick()` inert, and one that
reinstates the deleted doorbell's machinery.

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
`emsBatTemp`, `hwConnect`, `errorCodeNum`, plus each slot's `ch{i}ForceCharge` (the flat key,
else the `pd303_mc.`-prefixed one; v1.80.0) as `forceCharge`. That is the EcoFlow app's "Charge
Now" switch, which the Charge Now responder and the house-panel pin guard read. The same
subtree's power fields project as `pvWatts` (`pvChargeWatts`), `pvHighWatts`
(`pvHeightChargeWatts`), `pvLowWatts` (`pvLowChargeWatts`), `inputWatts` (`lcdInputWatts`)
and `outputWatts` (`outputPower`, the magnitude of the slot's `backupInfo.chWatt` while the
Core supplies the panel), each null when omitted. They are REST-only (`pd303_mc.*`, the ~60 s
poll) and recorded per slot as `src<n>_pv_w` (the PV figure the energy bridge integrates:
the two MPPT fields when either is reported, else `pvChargeWatts`), `src<n>_pv_hv_w`,
`src<n>_pv_lv_w` and `src<n>_in_w`. The PV fields read 0 at night on 2026-10-16; whether they
populate in daylight had not been observed, so the bridge reads them only for a slot that has
shown a reading above 0 W with the sun up. `sourceWatts[k]` (`backupInfo.chWatt`) pairs with
`Energy{k+1}Info`, checked live against `outputPower`. Panel-level
v1.80.0 fields: `forceChargeCeilingSoc` (`foceChargeHight`, sic), `stormWatchEnabled`
(`stormIsEnable`), `epsMode` (`epsModeInfo`). The `sn` here is the Core↔SHP2 connector
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

`backupFullCap` is the sum of the sources' `fullCap` — the packs' **nameplate** (6,144 Wh per
pack; 92,160 Wh at 15 packs) — and does not track pack health. At a 2026-10-11 reading
`backupDischargeRmainBatCap` equalled each source's `batteryPercentage` applied to its `fullCap`,
exactly: both figures are nameplate-scaled Wh. The packs' own measured full-charge capacity is
the per-pack `fullCapMah` (94.4 % of nameplate across the home packs on that date;
`docs/PERFORMANCE.md` §4).

The percent itself is a fraction of that measured capacity (each source's `batteryPercentage`
follows its packs' `remainCapMah / fullCapMah`), so the nameplate energies read high by the
packs' capacity ratio. Since v1.187.19 the runway and the forecast SoC trajectories multiply both
energies by the measured ratio (`poolEnergyBasis.ts`, §5.1.3a); the published Backup Capacity /
Backup Remaining sensors, the percent, the floor alarm and the night-charge planner keep the
panel's own figures unchanged.

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
| any other | undocumented status — not "Grid OK" | `false` |

`gridConnected` is **VALUE-1-ONLY**: true iff `gridSta === 1`. Unlike `gridWatt`
(`wattInfo.gridWatt`, which reads 0 in the gaps between the SHP2's ~8 kW charge bursts),
`gridSta` is the master controller's live line-sensing flag — present even when not
momentarily drawing. It feeds `gridState.computeShp2GridConnected` as an additive
backstop (true) — only from a fresh readback since v1.179.0 — and since v1.178.0 its last
value vetoes a declared grid (false); see §5, *4. Grid backstop resolver — `gridState.ts`*, 4.2 Signals combined.

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
20–160 s reconnect blips), `shp2SrcErrOnsets` (per-slot `errorCodeNum` onset), and `mpptErrOnsets` (v1.174.0: per-Core
HV/LV MPPT string-error onset, whose clock runs only while the code is non-zero AND the string
is producing). Since v1.187.4 the pool-unknown onset is persisted (`pool-unknown.json`,
`POOL_UNKNOWN_PATH`), so a restart inside a blind window carries the onset instead of
restarting the reserve-blind clock.

---

### SHP2 membership: home cores vs. spares (`shp2Membership.ts`)

The fleet has **5 DPU cores on the account but only 3 wired into the home SHP2**. The
other two are bench units that report telemetry but cannot deliver energy to the home bus.
Which Cores those are comes from the SHP2's own connected-source roster: since the
2026-08-20 reconfiguration the wired set is Cores 1, 2 and 5 and the bench units are
Cores 3 and 4 (§12l). Every fleet aggregation must exclude spares.

- **`shp2ConnectedDpuSns(devices)`** → `Set<sn>` of connected sources = the SHP2's
  `sources[]` filtered on `isConnected && sn`. Empty when no SHP2 is present.
- **`isShp2Connected(sn, connected)`** → **fallback semantics**: when `connected` is
  empty (no SHP2 observed / DPU-only setup) returns **true for every SN** (so a
  no-SHP2 user's tiles aren't zeroed). Otherwise membership is exact.
- **`SPARE_DPU_SNS`** = the static allowlist of bench-spare serials as written (Core 4,
  Core 5). It is a **floor, not the answer**: a DPU it does not name is never treated as a
  spare. Since the 2026-08-20 reconfiguration it names a wired home Core (Core 5) and omits
  the bench unit Core 3 (§12l). So `isBenchSpareSn(sn, lastKnownRoster?)` (v1.121.0) treats
  an SN as a spare only when the literal names it AND the durable last-known SHP2 roster
  (`setLastKnownHomeRoster`, persisted by index.ts) does not list it. It can only remove
  spare status, never add it. A spare's
  offline state is the *expected* steady state → its connectivity alert is
  non-annunciating.
- **`isExpectedOfflineSpare(sn, …, lastKnownRoster?)`** = `!connected.has(sn) && isBenchSpareSn(sn, lastKnownRoster)`.
  A live connected source is always re-armed, and while the SHP2 is dark (`connected` empty)
  the persisted last-known roster decides, not the literal alone. The `!has` re-arms a spare the instant it's wired into an SHP2 and reports as a
  connected source.
- **`isSourceDpuStale(source, devices)`** (observability only): a connected slot whose
  underlying DPU is itself cloud-offline. Surfaced as `dpuStale` on the source (set by
  `snapshotForClient`); does **not** change backup-pool capacity or the floor alarm.
- **`homeCoreCoverage(devices)`** → `{ connected, reporting, complete }`. Roster = SHP2
  connected sources (the union across panels), else the persisted last-known home roster
  (v1.121.0), else every DPU not in the `SPARE_DPU_SNS` literal. Roster SNs absent from the
  device map count as not reporting, the conservative direction. `complete` = all roster cores
  reporting. Core principle: *we can PROVE discharge from a partial sum; we can never
  DISPROVE it.* An empty roster means no home cores exist at all → `complete` is vacuously
  true.
- **`isHomePoolDpu(sn, connectedOrDevices)`** — v1.92.0; is this DPU wired into the backup pool right now (SHP2 roster, literal only as the unknown-roster fallback).
- **`homeFleetMeanSoc(devices)`** — reserve-alarm SHP2-blind fallback: mean SoC of home
  cores still reporting (spares + offline cores excluded). Used when the SHP2 nulls
  `backupBatPercent` while cloud-offline, so the audible reserve ladder keeps firing on
  the right side of a real depletion. Null when no home core reports.
- **`aggregateFleetFlow(devices)`** — the shared power-flow aggregate consumed by both
  `/api/ha-state` and MQTT `buildState` (previously two byte-identical loops). Sums
  `pvTotalWatts/totalInWatts/totalOutWatts/acInWatts` and per-pack net
  (`Σ outputWatts − inputWatts`) over **online, SHP2-connected** DPUs; `panelLoad` =
  Σ SHP2 circuit watts. Returns raw un-rounded sums (each caller rounds at emission). There are two
  battery-net sums (v1.186.2). `fleetBatteryNet` is built from the polled pack fields and is
  the raw evidence the at-floor discharge guard (`gridState` `poolDischargingObserved`)
  reads. `fleetBatteryNetDisplay` prefers each pack's fresh MQTT `liveFlow`; the Battery Net
  sensor, `/api/ha-state` `fleet_battery_net_watts` and the ±50 W charge/discharge timer
  gates read it. `panelLoad` sums every panel's circuits (v1.185.0). Guarded with
  `?? []` on `sources`/`packs`/`circuits` so a partial projection can't throw.

Roster since the 2026-08-20 reconfiguration: Cores 1/2/5 wired into the SHP2; Cores 3/4 on
the bench. `SPARE_DPU_SNS` still names Cores 4 and 5, and the roster-aware predicates above
correct for it (§12l).

#### Two panels (v1.185.0)

A second SHP2 is supported. Its model:

- **The house panel is pinned, and the pin never moves by itself.** `resolveHousePanel(census,
  pin, singleStable)` (pure) → `pinned | missing | ambiguous | none`. `census` is the panels ON THE
  ACCOUNT (`SnapshotStore.accountPanels`: the identity census less any panel absent from
  `PANEL_ABSENT_LISTS` = 3 consecutive device lists — the device map never forgets a device). A pin
  whose panel is on the account is `pinned`; off the account it is `missing` (no automatic re-pin:
  one partial list after a restart used to hand the role, and the pending revert, to the other
  panel for good). No pin and one panel standing alone for `FIRST_PIN_LISTS` = 2 lists: pin it; two
  or more: `ambiguous`. `SnapshotStore` persists the pin and every panel's last connected-source
  roster (`house-panel.json` beside the DB in production; `HOUSE_PANEL_PATH` overrides; in memory
  elsewhere) and stamps `DeviceSnapshot.housePanel` on the house panel, `housePanelMissing` (the
  pinned serial) on every panel while it is missing, and `lastRoster` on each panel (carried,
  restored on first sight). The flags travel with the device into the analytics worker and the web.
- **`findShp2(devices)`** returns the flagged panel, or **undefined while that panel has no
  projection or the pin is missing** (never the other panel); with nothing flagged, the lowest
  serial (unchanged). `houseSnOf` names the house serial (flagged, else the missing pin, else the
  fallback); `secondaryPanels` lists every other panel by identity, projected or not;
  `panelRoster(panel)` is its live connected sources, else `lastRoster`. Every
  former inline `find(kind === 'shp2')` (analytics, MQTT discovery, recorder, calendar,
  publish readiness, feature snapshot, telnet, web) now resolves through it or its web mirror
  `findHousePanel`. **`secondaryShp2s`** lists every other projected panel by serial.
- **Writes.** `multiPanelWriteBlock` refuses supervised apply writes while the pin is missing (any
  panel count) or two panels stand with none flagged; every write targets `findShp2`.
  `POST /api/house-panel {sn}` (write-auth) pins a panel on the account and refuses to MOVE an
  existing pin while the arbitrage reserve is raised, a reserve apply is unconfirmed, the
  force-charge ceiling is not yet restored, a night-charge write is in flight, a Charge Now write
  awaits readback, or a house slot is force-charging. The `shp2-multi-panel` alert and the
  dashboard's `HousePanelPin` prompt stand while ambiguous or missing.
- **Grid verdict per pool.** `livePoolGridBackstop(devices, sn)` = the resolver over
  `panelScopedDevices` (that panel and its roster's Cores): its own gridSta, main-line flow,
  Cores' ac_in, veto, floor and discharge. Every pool alarm (house and secondary: on-screen via
  `computeAlerts(…, poolGrid)`, the SoC ladders, the runway alarms) reads its own pool's verdict
  on a multi-panel plant; with one panel it returns `liveGridBackstop`, unchanged. The plant
  verdict (`liveGridBackstop`) backstops only when every pool is backstopped.
- **Alarms per panel.** `alerts.secondaryPanelAlerts` gives each secondary panel the house
  panel's reserve pair, source and circuit faults, reserve-blind and SoC band, with ids suffixed
  `-<serial>` (`familyOf` stops at the serial, so every family rule applies) and titles led by
  the panel's name; no arbitrage posture (night charge never writes it). `resolveHandoffOwner`
  hands `backup-soc-<pct>-<serial>` to that panel's own pair. `socLadders.ts` runs a SoC ladder
  per secondary panel (`battery-soc-alarm-<serial>.json`, `socAlarmMessage(t, poolName)`), and
  index.ts a runway alarm per panel (`runway-alarm-<serial>.json`, `RunwayWording { poolName, basis: 'drain' }`).
- **The secondary runway** (`panelRunway.ts`) is the pool's energy against its measured drain:
  the net pack flow of the panel's connected Cores (`panelPoolNetWatts`, null unless EVERY one
  reports), sampled each 2-min runway tick (before, and independent of, the analytics worker's
  report), averaged over 30 min once the window spans 10 min; a null reading clears the window.
  Unavailable on a stale panel reading — and an unavailable figure is not fed to the alarm, which
  holds its state instead of re-arming; no depletion under 50 W or beyond 24 h; a pool at or under
  its reserve reads at the floor whatever the drain.
- **Fallback SoC.** `housePoolFallbackSoc` = `homeFleetMeanSoc` with one panel; with more, only
  the house panel's own Cores (`panelMeanSoc` over `panelRoster`, so a house panel dark since a
  restart still reads its own) — null when no roster is known, never the union. Secondary ladders
  (every secondary panel, projected or not) fall back to their own Cores, and a secondary panel
  with no projection raises `reserve-alarm-blind-<serial>` from when it was first listed.
- **Plant totals.** `aggregateFleetFlow.panelLoad` sums every panel's circuits (the flows were
  already the union roster); the web flow model does the same and freezes the load if any panel
  is frozen. `publishReadiness.flow` waits until every panel in the census has a projection.
- **Muting.** `multiPanelRosterUnsound`: bench-spare / off-panel demotion is disarmed only while
  some panel in a multi-panel census lacks a projection or lists no connected source.
- **Saved grid readings.** A persisted not-OK reading is pruned only after its panel is absent from
  `PANEL_ABSENT_LISTS` consecutive panel-naming lists (one partial list is not evidence).

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
DPU, not reflexive reboots. The add-on has two remediation levers, and neither is a reboot. One is the
operator-triggered `refreshShp2CloudPresence` no-op write (below). The other is an automatic
rebuild of the add-on's own MQTT session, which runs on a sustained multi-device
message-rate collapse (§2.16) or immediately when the telemetry-blind alert goes active
(§2.15, v1.166.0).

---

