### Home Assistant service layer (`haService.ts`)

When running under HA Supervisor, `SUPERVISOR_TOKEN` grants access to Core's REST API at
`http://supervisor/core/api`. `isSupervised()` gates every call; outside Supervisor
each returns `{ ok:false, error }` (no crash).

Key helpers:

- `callHaService(domain, service, data)` — POST `/services/…`; surfaces HA's JSON
  `message` on non-2xx. A caller may pass its own timeout budget. The announce path does, sizing it from
  the rendered clip's duration (`announceTimeoutMs`, v1.119.0: floor 75 s, ceiling 10 min),
  because `play_announcement` returns only when playback finishes. Without a budget, Music
  Assistant `play_announcement` falls back to **75 s headers / 120 s body** and everything
  else to **5 s / 10 s**.
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
`MQTT_DISCOVERY_USER`/`PASS`, `protocolVersion: 5`, `reconnectPeriod: 5 s` (v1.148.0; it was 30 s, which left every entity unavailable ~20 s longer than needed after a broker restart), LWT retains
`offline`.

#### Availability + expiry

- `AVAILABILITY_TOPIC` is republished `online` on **every** state cycle and first on
  every broker **reconnect** (v1.14.1) — a broker-side LWT `offline` must be overwritten on
  reconnect or HA holds every entity (about 126 on a 12-circuit panel) unavailable until an add-on restart.
- **v1.187.10 — the process's first connect** (every restart) does not publish `online`
  ahead of the state: the state cycle (`publishStateCycle`) publishes the per-circuit
  configs, then the fresh state payload, then `online`, and asserts `online` also when the
  build or the publish throws. Publishing `online` first made HA re-show every entity's
  pre-restart value until the first fresh payload landed, a stale replay that a state trigger
  reads as a transition (an automation keyed on Lighting Posture "to normal" fired twice per
  deploy). The add-on's own retained `offline` (from `stop()` or its LWT) now stands about
  5 s longer at a restart. Not changed: a release still changes every discovery payload
  (`sw_version`), so HA re-sets up each entity and an `expire_after` entity reads unavailable
  until its next state message; the per-circuit power sensors do so one cycle later, when
  their configs are first published.
- `EXPIRE_AFTER_S = 120` (≈4× publish interval) is applied to **live-measurement**
  sensors only — **never** to `total_increasing` lifetime/energy sensors, nor (v1.187.10)
  to the `total` daily energy figures (an expiring long-term-statistics source would gap
  the HA Energy dashboard).

#### Entity categories

`SENSORS[]` (87) and `BINARY_SENSORS[]` (11), plus the four alarm-priority switches and two
dynamic sensors per SHP2 circuit (energy and power; 24 on a 12-channel panel). Selected groups:

- **Power flow:** `fleet_pv_watts`, `panel_load_watts`, `ac_import_watts`,
  `fleet_battery_net_watts`, `grid_home_watts` (SHP2 `gridWatt`). Fleet PV and Battery
  Net count each connected home Core once (the energy bridge, `Recorder.bridgedFleetFlow`;
  [chapter 7, path (c)](07-energy-and-cost.md#22-the-two-accumulation-paths)). A Core
  with a reading of its own counts at its own figures, even one the cloud lists offline
  whose MQTT data still arrives. A dark Core is metered at its panel slot: no reading of its
  own for at least 3 min, cloud-offline or listed online on a frozen meter or with no
  projection yet. A frozen projection listed online is never summed as live. The two figures
  have their own readiness flag, `flowBridged`. By day a dark slot's PV is the panel's PV
  field whenever it is present and the day's check has not found it short of the inferred
  bound (trusted or not yet checked; chapter 7); the two sensors sum to the slot meter
  whatever it reads. They are null, never a partial sum, while a dark slot on an online
  panel cannot be bridged (no fresh meter; by day no PV field, or one found short today), or
  while a Core is inside its 3-min dwell and so in neither figure. A dark slot whose panel is itself cloud-offline is left out of
  both, as an offline Core always was. `ac_import_watts` (and the REST twin's Fleet Total In /
  Out) count each Core the same way (v1.188.1): a frozen projection listed online is taken out
  of the online sums, and a dark Core counts at its slot's AC exchange (in: `max(0, chW)`; out:
  `max(0, −chW)`; Fleet Total In also the slot's PV on the night, measured or unchecked basis). Before,
  every Core frozen online mid grid-charge kept AC Import at their held 15 kW while the slots
  read 0 W. They are null while a Core is inside its dwell or a dark slot on an online panel has
  no fresh meter (Fleet Total In also while its PV is unknown).
- **Backup pool:** `backup_pool` (%), `backup_remaining_kwh`, `backup_full_capacity_kwh`
  (both `energy_storage`).
- **Forecast/degradation/runway/RTE/clipping/curtailment/self-consumption** — one sensor
  each, mostly `measurement` (no `device_class energy` on rolling kWh that can go down).
- **Alert counts** — `alert_critical_count`, `alert_warning_count`,
  `learned_warning_count`, plus per-ISA-priority `alert_{high,medium,low}_count`. They
  count every alert on screen, including alerts with `annunciate: false` (roster-muted
  bench spares and off-panel Cores, the top-of-charge cell-spread mutes, a remediate-first
  hold), the same set the web dashboard's badges count. A non-zero count is therefore not
  a statement that anything was spoken or pushed; an automation that should follow the
  audible condition cannot key on these counts alone.
- **Night charge and the mid-day charge:** the `night_charge_*` figures (target and arrival
  SoC, worst-case and expected buy, readiness, the window start and end) and
  `night_charge_role` (`cost`, or `backup` ahead of a mid-day charge), and the seven
  `midday_charge_*` figures (target SoC, reserve hold, expected and worst-case buy, the window
  start and end as `timestamp` sensors, the morning refresh), each with a `basis` attribute
  that reads `shadow` while the mid-day charge is computed in shadow. All carry the ~25 h
  `NIGHT_CHARGE_EXPIRE_AFTER_S`. Home Assistant's MQTT sensor reads an empty value as unknown,
  for a timestamp sensor too.
- **Diagnostics** (`entity_category: 'diagnostic'`): `ecoflow_cloud_wedge_count`, `poll_health`,
  `shp2_content_frozen_s`, the host vitals (`host_evloop_lag`, `host_mem_available`,
  `host_disk_free`, `host_load_1m`, `host_soc_temp`),
  `system_outage_24h` + count/minutes + `system_power_outage_count_24h` /
  `system_telemetry_gap_count_24h`, `system_device_gap_count_24h` (per-device gaps, not
  outages), `audible_channel_status` /
  `audible_speakers_reachable`, `shp2_grid_sta`, `backup_reserve_percent`,
  `solar_backup_reserve_percent`, `backup_reserve_enabled`, and the raw SHP2 mode-code
  sensors (`smart_backup_mode_code` / `backup_mode_code` / `overload_mode_code` — exposed
  as **honest integers**, no fabricated labels).
- **Binary sensors:** `off_grid`, `shp2_grid_connected`,
  `runway_projection_islanded_only`, `projected_low_soc_islanded_only`,
  `pv_curtailment_active`, `load_shed_recommended`, `night_charge_recommended`,
  `night_charge_write_ready` (diagnostic), `midday_charge_recommended` (always off while the
  mid-day charge is a shadow), `self_consumption_coverage_partial`, `forecast_basis_incomplete`.

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
`battery_discharge_lifetime_kwh`. The two lifetime CO2 counters (`carbon_lifetime_kg`,
`carbon_lifetime_miles`) are also `total_increasing`. The tariff readouts are `measurement`
(waived USD readouts; see Table invariants), and the per-circuit lifetime counters are
described below.

**Per-SHP2-circuit Energy sensors** are published dynamically (`planCircuitDiscovery` /
`publishCircuitDiscovery`) driven by the recurring `publishState()` loop — NOT the
one-shot connect path — because the circuit list only exists after the first REST poll,
which can land *after* broker connect. `circuitLifetimeFields` emits a
`circuit_<ch>_lifetime_kwh` key for the **union** of live circuits + persisted
accumulator keys (so no discovered sensor references a missing `value_json` key, which
would spam HA template warnings), and emits **null (not 0)** when the accumulator isn't
ready (a 0 on a `total_increasing` sensor reads as a spurious reset).

#### Per-circuit POWER sensors (v1.141.0)

`planCircuitDiscovery` publishes **two** configs per channel: the existing
`ecoflow_circuit_<ch>_lifetime_kwh` (energy) and `ecoflow_circuit_<ch>_watts`
(power, `device_class: power`, `state_class: measurement`, `W`). The watts
already existed end to end — `loadInfo.hall1Watt[i-1]` → `Shp2Circuit.watts`,
recorded as `ch<ch>_w` — so no projection or recorder change was needed.

**Twelve, not six.** The "primaries only" idea comes from a *naming* problem
v1.65.0 already solved (legs labelled "X L1"/"X L2" while keeping twelve
entities), and it does not transfer: `stat_rate` is a field **on** a
`device_consumption` entry, of which there are twelve. Six sensors would fill six
entries and silently drop half the panel from the Sankey, and putting a pair
total on the primary would make that entity mean two things at once.

- **Entity ids are stable across renames — but not because of `object_id`.**
  v1.141.0 published one and it was inert: HA minted
  `sensor.ecoflow_panel_kitchen_l1_power` (device slug + slugified name), so
  the key was removed in v1.141.1. Stability comes from HA persisting an
  entity_id against its `unique_id` at first discovery, which matters because the
  energy prefs wire `stat_rate` **by string**. The proof is on the reference plant: the
  energy entity_ids still read `…_circuit_3_energy` from before v1.65.0's
  pair-aware naming, while the power entity minted for the same channel reads
  `…_kitchen_l2_power`.
- A missing reading is `null`, **never 0** — on a `measurement` sensor a zero is
  compiled into HA's mean as a positive claim the circuit drew nothing. A genuine
  measured 0 passes through.
- `circuitChannels` is shared by both field builders so they cannot drift; a
  drift shows only as a permanent `unknown` on whichever entity was forgotten.
- `clear` emits **both** config topics for a departed channel.
- The dynamic configs are now routed through `auditDiscoveryTables` in the test
  suite. They never had been — the audit only ever saw the static tables, which
  is the same filtered-subset shape as the v1.137.0 table-invariant defects (Table
  invariants + connect re-assertion, below).

**Operator step, HA-side:** give each circuit's `device_consumption` entry in the energy
prefs a `"stat_rate"` naming that channel's power entity. Take the entity_id from HA's
entity registry (unique_id `ecoflow_circuit_<ch>_watts`): HA mints it from the device and
circuit name, e.g. `sensor.ecoflow_panel_kitchen_l1_power`, never
`sensor.ecoflow_circuit_<ch>_power`. `stat_consumption` is untouched and the Energy tab is
unaffected. A circuit whose current transformer reads nothing publishes a steady 0 W; pair
sums are not published, so such a circuit stays visible. (The reference plant's own wiring
note is in [the reference plant's notes](../history/reference-plant-notes.md).)

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

Each report settles independently (`settleStateReports`, v1.186.0). It uses its fresh
answer if one arrives within `STATE_REPORT_WAIT_MS` (5 s), else its last good answer if that
is no older than `STATE_REPORT_LAST_GOOD_MAX_AGE_MS` (= `EXPIRE_AFTER_S`, 120 s), else null.
A slow or failed report therefore nulls only its own fields, and the snapshot, alarm and
readiness fields publish on the 30 s cadence regardless. The payload is assembled from
`aggregateFleetFlow(devices)` + the analytics worker's cached reports
(`forecast`, `degradation`, `runway`, `roundTripEfficiency`, `clipping`,
`selfConsumption`, `carbon`, `tariff`, `curtailment`), `recorder.getLifetimeTotals()`,
lighting posture, `liveGridBackstop`, `countCloudWedges`, `systemOutageFields`, and
broadcast health. It is **byte-aligned with `/api/ha-state`** for the shared fields
(same `aggregateFleetFlow`, same rounding, same forecast display basis).

---

#### Table invariants + connect re-assertion (v1.137.0)

Two failure modes in this file are silent by construction: the publish succeeds,
the topic retains, and the damage shows up only in Home Assistant.

**`auditDiscoveryTables(sensors, binarySensors, waivers?)`** — pure; returns a
`DiscoveryViolation[]` that callers assert is **empty** (never a count, so a new
violation cannot be masked by removing an old one). HA does not reject an
incoherent `(device_class, state_class, unit_of_measurement)` triple loudly: it
either drops the entity with one log line, or accepts it and compiles the wrong
statistic. Rules enforced over the whole table:

| Rule | What it catches |
|---|---|
| `device-class-state-class` | e.g. `energy` + `measurement`, which HA refuses outright |
| `device-class-unit` | e.g. `power` carrying `kWh` |
| `unit-without-state-class` | compiles **no** long-term statistics at all |
| `total-increasing-without-unit` | a unitless sum the Energy Dashboard cannot consume |
| `daily-figure-needs-total-with-reset` | a daily figure (value key ending `_today`) that accumulates statistics without `total` and a `last_reset_value_template`: `total_increasing` reads a revision of 10 % or more as a meter reset, and `total` with no reset books the midnight drop as a negative day (v1.187.10) |
| `currency-needs-monetary-total` | a currency amount that is not `monetary` + `total`, so HA compiles a **mean** and it can never be an Energy-Dashboard cost source |
| `duplicate-unique-id` | a collision silently drops one of the two entities |

`USD/kWh` is deliberately **not** treated as a currency: that is a *price*, not an
amount of money, and `monetary` does not apply to it. `ecoflow_grid_price_now`
ships exactly that shape, and HA mints its own `monetary`/`total` cost entity
from it.

The money units follow `TARIFF_CURRENCY` (v1.191.0; USD while unset, else EUR, GBP, CAD or
AUD, the codes `money.ts` `CURRENCIES` accepts). The tables are written in USD, and
`sensorDiscoveryConfig` publishes `USD` as the configured code and `USD/kWh` as
`<code>/kWh` (`currencyUnit`); a USD install's payload is built exactly as before. The audit's
currency rule recognises every accepted code, not only USD. The state payload's key names
(`…_dollars`, `…_usd_per_kwh`) are unchanged.

Deliberate departures live in `DISCOVERY_WAIVERS`, and **a waiver with an empty
reason is not a waiver**. The reason text is the only place the intent is
recorded, so adding a fourth `USD` sensor forces the author to state whether it
is a dashboard readout or a cost source. The three shipped waivers are the
daily-resetting / rolling-window tariff readouts, none of which is monotonic.

**`runBrokerConnect(latch, effects)`** — the connect sequence, extracted so it is
testable without a broker. Discovery configs are retained, so the case that
breaks is the **broker** losing its retained store (a Mosquitto restart without
persistence, a re-created container). The configs vanish, and the previous
one-time `published` latch meant the add-on never re-asserted them: HA kept only
what was already in its registry, and a fresh HA never learned the entities at
all. So:

| Step | Every connect? | Why |
|---|---|---|
| availability `online` | **reconnects only**, first (v1.187.10) | a retained LWT `offline` holds every entity unavailable regardless of what follows (live: 9+ h, 2026-07-12). On the process's first connect it is asserted by the state cycle, right after the fresh payload (see Availability + expiry) |
| `clearLegacyDiscovery()` | **no — once** | empty payloads to *retired* config topics need saying once; repeating them forever is traffic that never stops |
| `publishDiscovery()` | yes | 102 retained publishes of unchanged payloads (87 sensors, 11 binary sensors, 4 switches); HA re-processes them as no-ops |
| invalidate circuit signature | yes | the per-circuit configs are retained on the same broker and vanish with the same store |
| `publishedCircuitChannels` | **never reset** | not a latch — it is the *orphan ledger*, the memory of which circuits to clear a config topic for. Reset it and a removed circuit's retained config sits on the broker forever with nothing left to remove it |
| switch subscriptions | yes | MQTT subscriptions do not survive a clean-session reconnect |

Proven by `scripts/mutate-discovery-invariants.mjs` (23 mutants: the original 17, plus six (xviii–xxiii) for the v1.141.0 per-circuit power sensors), which includes
a mutant that leaves `runBrokerConnect` correct while making the **real**
`client.on('connect')` handler inert — the failure mode where a wired, tested,
mutation-proven mechanism never reaches production.

### The write-command framework + audit log + rate limits (`ecoflow/commands.ts`, `writeLog.ts`)

#### Design posture

Writes are **deliberately minimal**. Empirical probing (v0.9.10) confirmed **SHP2 reboot
is not in the public IoT API** (`PD303_REBOOT`/`PD303_APP_REBOOT`/`PD303_SYS_REBOOT` and
DPU-style shapes all return error 8524 "invalid parameter"; reboot only exists via the
mobile app's private MQTT protobuf channel, `cmdFunc=12`).

#### `setBackupReserveSoc` — the night-charge reserve write (v1.50.0)

The supervised night-charge actuator's single write primitive: set
`backupReserveSoc` on the SHP2 via the same documented `PD303_APP_SET` shape
the cloud-presence refresh round-trips, with a changed value. The target is
VALIDATED (not silently clamped) into the [10, 50] write envelope
(`RESERVE_WRITE_MIN_PCT` / `RESERVE_WRITE_MAX_PCT`, nightChargeActuator.ts),
audit-logged under action `night-charge-reserve`, and paced by a 5-minute
per-SN cooldown. It has two callers. One is the night-charge actuator
(§15.8b). The other is the owner reserve-floor endpoint `POST /api/reserve-floor?pct=N`,
which needs write-auth and is refused outside the same envelope and while a night-charge
write holds the reserve raised (§12h). No surface writes an arbitrary reserve value.

#### `setChannelForceCharge` / `setForceChargeCeiling` — the force-charge writes

`setChannelForceCharge` (v1.84.0) sets `ch{n}ForceCharge` to `FORCE_CHARGE_ON`/`FORCE_CHARGE_OFF`,
the EcoFlow app's "Charge Now", on SHP2 slot 1–3; any other slot is refused with
`slot-out-of-range`. It is audit-logged as action `charge-now-ch<n>` and has a 5-min cooldown
per slot and SN. An OFF is limited only by earlier OFFs, never by a preceding ON (v1.186.0).
`setForceChargeCeiling` (v1.165.0) sets `foceChargeHight` (the vendor's spelling) within the
documented [80, 100]; anything else is refused with `ceiling-out-of-range`. It is audit-logged
as `force-charge-ceiling` and has a 5-min cooldown. Both use the same `PD303_APP_SET` shape and
the audited `runCommand` path. Callers: the Charge Now responder (OFF only) and the night
force-charge path.

#### `refreshShp2CloudPresence` — the documented no-op write

A documented **no-op**: re-send the current `backupReserveSoc` back to the SHP2
(`{ cmdCode: 'PD303_APP_SET', params: { backupReserveSoc } }`). No state changes, but the
round-trip forces EcoFlow's cloud to refresh the device's presence — the actual fix for
the "cloud says offline, LAN says online" wedge.

- **Rate limit:** `REFRESH_COOLDOWN_MS = 30 s` per (action, sn); returns
  `rate-limited` + remaining ms when hot.
- **Sanity bound:** `backupReserveSoc` must be an integer in **[10, 50]** (raised to 90 in v1.161.0, returned to 50 in v1.164.0 when the device proved the limit) or the write is
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
| `/api/snapshot` | GET | none (read-only) | `snapshotForClient()` — full `FleetSnapshot` + grid/off_grid, with each SHP2 source annotated `dpuStale` / `dpuFrozen` and each panel `readbackFresh` |
| `/api/ha-state` | GET | none | flat HA-facing payload (power flow, backup pool, forecast, degradation, alerts, runway, RTE, clipping, curtailment, self-consumption, lifetime) |
| `/api/panel-info` | GET | none | `{ writeAuthRequired:true, sameOriginOk:true, ingressOk:true, tokenHeader:'X-Panel-Write-Token', tokenPath }` |
| `/api/debug/raw?sn=` | GET | none | `{ sn, raw, mqtt (by cmdId), mqttFlat, source, lastMqttAt, mqttMsgCount }` |
| `/api/debug/mqtt-summary` | GET | none | per-SN msg counts + cmdIds seen |
| `/api/version` | GET | none | `{ version, builtAt, ref }` (build-time env) |
| `/api/device/refresh-cloud/:sn` | POST | write | no-op cloud-presence refresh |
| `/api/device/refresh-cloud-cooldown?sn=` | GET | none | cooldown state |
| `/api/device/send-command` | POST | write + debug token | arbitrary allow-listed command |
| `/api/writes/log?limit=` | GET | write | tail of the audit log (default 50, max 500 entries); write-auth because rows carry source IPs and attempted command shapes |

#### `snapshotForClient()`

Wraps `store.get()` with the live grid backstop (`liveGridBackstop(devices)` → `grid`,
`off_grid = !grid.present`), and **immutably** enriches the SHP2 device: shallow-copies
the devices map + SHP2 device, attaches `grid`/`off_grid`, and maps each source to add
`dpuStale`. The immutability is load-bearing — `/api/ha-state` and the broadcast path
read raw `store.get()` and must stay byte-identical. Since v1.188.1 every panel goes through
`panelForClient` (`shp2Membership.ts`): each source also carries `dpuFrozen` (its Core is listed
online but its content has not changed for `SHP2_READBACK_STALE_MS`) and the panel carries
`readbackFresh` (`shp2ReadbackFresh`). The Energy flow card has no clock and keys on both.
v1.188.1 (review) — each connected source also carries the energy bridge's verdicts, from the
computation the two power sensors publish (`slotVerdicts`): `ownReading` (the sensors count its
Core at its own reading) and `pvMeasuredW` (its PV where the bridge reads the panel's PV field as
measured, else null).

#### `/api/ha-state` (selected fields)

Power flow from `aggregateFleetFlow` (rounded): `fleet_pv_watts`,
`fleet_total_in_watts`, `fleet_total_out_watts`, `fleet_battery_net_watts` (positive =
discharging; Fleet PV and Battery Net plus the dark home slots metered at the panel,
`recorder.bridgedFleetFlow`, the same figures as the MQTT payload), `panel_load_watts`, `ac_import_watts`, `off_grid` (via `liveGridBackstop`,
**not** `acIn < 5` — DPU `ac_in` is structurally ~0 on a solar home). Backup:
`backup_pool_percent`, `backup_reserve_percent`, `backup_full_capacity_kwh`,
`backup_remaining_kwh`, and `backup_charge_minutes`/`backup_discharge_minutes` gated on
the ±50 W deadband (both timers are always reported by the SHP2 regardless of direction).
The gate (`backupTimerGate`, shared with the console's RUN line and, since v1.190.1, the dashboard's Smart Home Panel card through the per-panel `backupTimers` field `panelForClient` sends) reads the Cores' battery net
while every home Core reports on a fresh meter (v1.188.1: and the energy bridge counts each at its
own reading; the gate takes the bridge's verdicts, `BridgeVerdicts`). Otherwise that sum is not the pool's (0 W with
every Core dark), so it reads an upper bound through the panel instead: each dark or frozen Core
contributes its slot's delivery (`−sourceWatts`) plus `SLOT_UNMETERED_DRAW_W` (100 W) while that
panel is fresh. The slot sees neither the Core's PV nor its own standby and conversion draw, which
comes out of its packs (65-85 W per Core, measured by the energy bridge), so pack net ≤ −slot +
draw. A slot proves a charge only while it takes in more AC than that draw: at the reserve hold the
slots read about 0 W while the packs still supply the Cores' standby, and no time to full is
published. A slot delivering never proves a discharge, since it can be the Core's PV passing
through. With nothing to bound it, only the discharge timer is published. Where the power sensors
read a dark slot's panel PV field (the sun up; trusted, or present and not found short of the
inferred bound today), that PV comes out of
the bound (`−slot − PV + draw`), so by day the timers follow the Battery Net sensor, which
publishes `−slot − PV` for that slot: before, the bound stayed positive while Battery Net read a
charge, and the time to empty was published beside it. The field's check catches a field that
reads low, not high, so a field reading high would show the time to full early, beside a Battery
Net reading the same charge. A Core the cloud lists offline whose MQTT data still arrives counts
at its own pack net, as the sensors count it.
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
| `HOUSE_PANEL_PATH` | `house-panel.json` beside the DB (supervised), else in memory | house-panel pin + per-panel last rosters (v1.185.0) |
| `GRID_READING_PATH` | `grid-reading.json` beside the DB (supervised), else disabled | persisted not-OK grid reading for the declared-grid veto (v1.180.0); `''` disables |
| `POOL_UNKNOWN_PATH` | `pool-unknown.json` beside the DB (supervised), else disabled | pool-unknown onsets carried across a restart (v1.187.4); `''` disables |
| `PACK_GHOSTS_PATH` | `pack-ghosts.json` beside the DB (supervised), else disabled | hidden ghost pack slots carried across a restart (v1.187.1); `''` disables |
| `POOL_ENERGY_BASIS_DIR` | beside the DB (supervised), else disabled | directory for `pool-energy-basis.json` (the analytics worker's held per-Core capacity ratios and applied scale) and `pool-energy-basis-panels.json` (the main thread's, secondary panels) — v1.187.19, §5.1.3a; `''` disables |
| `SHADOW_WITNESS_PATH` | `shadow-witness.json` beside the DB | last SHP2 shadow witness (v1.148.0) |
| `POLL_SUMMARY_EVERY` | `30` | polls per poll-duration summary line (v1.148.0) |

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
| `SITE_TIMEZONE` / `TZ` | unset / Home Assistant's zone (set by the Supervisor) | the site clock: `SITE_TIMEZONE` when it resolves, else `TZ`, else `America/Phoenix`; resolved once at start. Home Assistant's own `time_zone` is read after boot and a different zone raises a repair issue (architecture chapter, section 12) |
| `PORT` | `8787` | HTTP server |
| `HOST` | `::` | dual-stack bind |
| `DB_PATH` | `/data/ecoflow.db` (supervised) | recorder DB |
| `LOG_LEVEL` | `info` | `debug`/`trace` adds the periodic poll-duration summary (p50/p95/max once per `POLL_SUMMARY_EVERY` polls, v1.148.0; there is no line per poll) and the DEBUG channel (e.g. the compact unchanged fleet-status line) |
| `SSH_ENABLED` / `SSH_HOST` / `SSH_PORT` / `SSH_HOST_KEY` | `false` (add-on option, exported as `0`; the server alone turns it off only on `0`, so it is on when the variable is unset) / `::` / `2323` / `/data/ssh_host_ed25519_key` | SSH TUI; `TELNET_ENABLED` / `TELNET_PORT` are deprecated aliases (either enabled option serves SSH; `SSH_PORT` at its default defers to a changed `TELNET_PORT`; the log names the alias that applied) |
| `TUI_USERNAME` / `TUI_PASSWORD` | empty | console login; an empty username logs in as `operator` (empty password: the browser console has no prompt and the SSH console refuses every login) |
| `TUI_TRUSTED_ORIGINS` | empty | comma-separated extra origins accepted **verbatim, with no validation** — entries need not be private-range or `.local`; a public HTTPS origin is accepted, which is the point (remote HA Cloud access is the use case). The same set gates the write-auth origin check, the `/ws` and `/console/ws` upgrades, and CORS. Built-in LAN matching is separate and automatic. |

---

### Edge cases & honest-null summary

- **No LAN protocol.** Everything is cloud-sourced; resilience = LAN-ping
  wedge-vs-outage classification + a no-op cloud-presence refresh + a bounded rebuild of
  the add-on's own MQTT session (§2.15, §2.16), never a reflexive device reboot.
- **SHP2 is never MQTT-translated** → its freshness clock is protected by *not* bumping
  `lastUpdated` on untranslatable messages; a frozen SHP2 with a failing REST poll will
  still trip `Telemetry stale`.
- **Backup pool is an SHP2 aggregate**, not a per-slot sum — a cloud-offline DPU never
  over/under-counts it, and a stale slot is intentionally not subtracted.
- **Coherence + grace-hold + slew guard** together suppress reconnect-blip false SoC
  cascades while never masking a real low near the danger zone (asymmetric drop/rise
  gating).
- **Spares** are resolved from the SHP2's live connected-source roster, then the persisted
  last-known roster, with the bench-spare list only as a floor (a DPU it does not name is never
  a spare): `BENCH_SPARE_SNS` when set, else the `SPARE_DPU_SNS` literal. A literal goes stale
  when a plant is rewired, so it is never consulted alone.
- **Honest nulls everywhere:** null numeric fields emit `null` → HA `unknown`, never a
  fabricated 0/OFF; `gridSta` null stays null; `backup_reserve_enabled` reads `unknown`
  when the strategy object is absent.
- **Publish readiness (v1.178.0, `publishReadiness.ts`):** a figure computed before the data
  behind it exists is null, not 0. Both state publishers (MQTT `buildState` and the REST
  twin `/api/ha-state`) pass their payload through `withholdUnready(publishReadiness(...))`,
  which nulls each group of fields whose own input is missing: the fleet in/out and AC-import
  flows (`flow`) until an online Core has a projection; Fleet PV and Battery Net
  (`flowBridged`) until an online Core has a projection, a home Core reports, or the energy
  bridge meters a dark home slot, and while any connected home Core on an online panel is
  counted by neither (inside its dwell, or its slot unbridgeable); `panel_load_watts` until
  the panel reports a channel; the nine
  alarm counts until the monitor has evaluated once; `audible_usable_speakers` until the
  first speaker probe; the forecast PV pair while `pvForecastUnavailable` (no PV history on
  the published display basis, which re-adds connected-but-unprojected Cores' own records);
  the clipping trio while the array peak is 0; the curtailment four, CO2 7 d and the tariff
  three while their report's `basisComplete` is false (curtailment: home Cores, the panel,
  weather and a solar posterior — the analytics worker's weather cache is empty after every
  restart until the first Open-Meteo fetch succeeds; tariff: a DPU-only install with no
  panel listed at all is complete, a panel listed but not yet projected is not). The one
  binary sensor governed, `pv_curtailment_active`, renders null as `"None"` (unknown) rather
  than `"OFF"`, so a restart draws no on→off edge. `pv_curtailment_charge_ceiling_pct` is
  not governed: it is the Cores' live `chgMaxSoc`, null when unknown, never a model-less 0.
  The fleet sums are taken after the reports' await, from the same live device map readiness
  judges (v1.178.1): taken before it, a boot-time sum over nothing passed a readiness verdict
  made after the first poll. The fleet flows need an online projected Core the panel lists as
  a source (any Core on a DPU-only install — no panel listed at all), or for Fleet PV and
  Battery Net a home Core at its own reading or a dark home slot the bridge meters: a bench spare's
  projection alone does not make a fleet sum real, and a panel listed but not yet projected
  leaves membership unknown.
  The first state publish runs on broker connect, ~0.8 s before the first poll, and the
  next one ~75 s later, so each of these used to publish X → 0 → X at every restart; on
  the then-`total_increasing` `pv_curtailment_kwh_today` the dip read as a meter reset and
  Home Assistant counted the day's curtailment again. Lifetime counters come from the
  recorder's persisted accumulators and are not governed.
  **v1.187.10 — a reading, not a replay; a complete home basis.** (1) While a Smart Home
  Panel 2 fails `shp2ReadbackFresh` (cloud-offline, no quota within
  `SHP2_READBACK_STALE_MS`, or replaying a cloud shadow — the same rule that already makes
  `shp2_grid_connected` unknown and the dashboard show the panel STALE), its projection is
  frozen. `panel_load_watts` (it sums every panel's channels) now needs every projected panel
  fresh, and a new `panelLive` group needs the house panel fresh: `grid_home_watts`,
  `shp2_grid_status`, `backup_pool_percent`, `backup_remaining_kwh`,
  `backup_charge_minutes` / `backup_discharge_minutes` and every `circuit_<ch>_watts`
  (matched by pattern, `READINESS_PATTERNS`, since the channel keys are dynamic). Before,
  Panel Load sat at its last value through a stale shadow while the Cores' battery net rose
  by ~2 kW; MQTT `expire_after` cannot catch a freeze, because each 30 s republish resets the
  timer. The lifetime counters (per-circuit too), the battery net, the capacity, the reserve
  settings and the frozen-for diagnostic are not governed by this group (the battery net is
  null while a dark home slot's panel reading is not fresh, through `flowBridged`). Freshness is first proven by a
  quota (`lastQuotaAtMs`, REST or MQTT), so these fields are also null after a restart
  until the panel's first quota lands. (2) `projected_low_soc_percent` / `_at` join the forecast PV group, and a new
  `runwayBasis` group governs `runway_to_reserve_hours`, `runway_to_empty_hours`,
  `runway_recent_load_watts` and `runway_forecast_pv_used_kwh`: both are null while the
  forecast or runway was built on a pending home basis (`homeBasisPending`, below), and the
  runway fields while the runway report is missing. The audible status is not a readiness
  field; it reads `unknown` before the first probe by its own rule (`audibleStatus`).
- **Pending home basis (v1.187.10, `analytics.homeBasisPending`):** the analytics worker is
  released on the first snapshot with any projection, at a restart often the panel's alone.
  The first forecast then had every Core's PV missing; published as definite values it read
  Projected Low SoC 0 % and a finite runway to reserve and to empty, with
  `forecast_basis_incomplete` OFF (the PV-cold test needs a home Core in the map). A home
  Core the panel lists as a connected source, that the device list reports ONLINE, and that
  has no projection yet is pending: its first quota has not landed. A Core listed offline is
  a cloud wedge, not pending, and keeps the conservative figures. While pending, the
  forecast is structurally incomplete (`homeBasisPending` on the value, negative-cached and
  rebuilt), and the runway is marked `basisPending`, is not cached, and neither reads nor
  arms the to-empty hysteresis (a boot crossing had latched and clamped the next complete
  reserve crossing to it). The lighting posture is not advanced on either. The bound is
  `HOME_BASIS_PENDING_MAX_MS` (10 min) from the analytics module's load: a Core whose quota
  keeps failing while it stays listed online stops counting, so the figures publish again
  rather than reading unknown indefinitely. The alarm path is unchanged: it reads the same
  conservative figures as before. Not changed: `night_charge_recommended` still reads OFF
  until the first plan (fail-safe by design), and `self_consumption_coverage_partial` and
  the daily PV peak restart from in-process state.
- **Write surface is intentionally tiny**, rate-limited, allow-listed, sanity-bounded,
  and fully audit-logged.


---

### 2.14 Request-signing clock correction (`server/src/ecoflow/clockOffset.ts`) — v1.69.0

EcoFlow signs every REST request with a local-clock timestamp; a skewed host
clock makes the cloud reject every call with `8521 signature is wrong`. On
2026-08-04 a post-power-cut boot ran 170 s behind (no RTC battery then fitted)
and the add-on held zero telemetry for 22 minutes while reporting healthy.

Every HTTP response carries a `Date` header — **including the 8521 rejection
itself** — so the first rejected request already reveals the skew. `noteServerDate`
adopts the measured offset (deadband 2 s — sub-threshold deltas are round-trip
latency, not skew; sanity bound 24 h — an absurd header is a broken proxy, not a
skewed host) and `signingNowMs()` applies it **to signing only**. Recorder
timestamps, alert onsets and night-charge windows always use the system clock.
Recovery is within one poll cycle instead of waiting on NTP. Committed harness:
`scripts/mutate-telemetry-blind.mjs` (its starred mutant is "learn only from
successful responses", which silently restores the 22-minute outage).

**v1.109.0 — the deadband must yield to a rejection.** On 2026-08-25 02:46 a
marginal −2.1 s adoption crossed the vendor's (evidently tight) timestamp
tolerance and every poll failed `8524 timestamp's value is invalid` for six
minutes: each rejection's own Date header measured the true offset, but the
correction differed from the bad offset by ~2.0 s — just inside the 2 s
deadband — so the very evidence that would have fixed signing was discarded as
jitter. `noteTimestampRejection` (fed by `rest.ts` whenever the response code
is 8521/8524) adopts any finite, plausible measurement with the deadband
bypassed; the RTT gate keeps only its absolute cold ceiling there, because the
vendor's degraded window produces uniformly slow responses and a 2×-median
gate could starve recovery exactly when it is needed. Backdrop worth knowing:
HAOS restarts systemd-timesyncd on every 2-hourly DHCP renewal, and each
restart performs an "Initial clock synchronization" step — small host-clock
steps are routine on the reference plant's Raspberry Pi, not exceptional.

### 2.15 Telemetry-blind self-alert (`server/src/telemetryBlind.ts`) — v1.69.0

The one condition where a quiet system is the most dangerous system: the add-on
itself holding no telemetry. `assessBlind` raises the CRITICAL `telemetry-blind`
alert when there is no usable device telemetry past the boot grace
(`TELEMETRY_BLIND_BOOT_GRACE_MS`, 3 min) or freshness bound
(`TELEMETRY_BLIND_STALE_MS`, 5 min). Health requires devices **and** a fresh
successful poll — a device map left over from before an outage is not sight.
`classifyPollError` splits `auth` (8521 / "signature is wrong" — on this
hardware, clock skew, not credentials) from `network` from `other`; sustained
auth-shaped failure recommends a client rebuild, cooldown-limited.
**Remediate first (v1.166.0, `blindRemediation.ts`).** When the alert first goes active, the
MQTT session rebuild fires at once. The alert is held non-annunciating (on screen and in
`/api/health`, but no voice or push) for at most `BLIND_REMEDIATION_VERIFY_MS` (5 min). If
telemetry returns inside that window, the alert clears without ever sounding; if the add-on
is still blind at the deadline, the alert is released as before. When no remedy is
available — the rolling-24 h heal budget shared with §2.16 is spent, or a heal ran less than
`BLIND_REMEDIATION_MIN_GAP_MS` (15 min) ago — the alert fires immediately. There is one
remediation per episode. A cause a rebuild cannot fix therefore alarms up to ~5 min later
than the stale bound alone would.
`/api/health` returns `ok:false` **and HTTP 503** while blind, so the HA
watchdog and any uptime probe see it.
`/api/health`'s `pollErrorKind` is that class only while a failure is current (blind, or a failed
poll not yet followed by a success) and `null` otherwise (`healthPollErrorKind`, v1.187.10 — it
read `"other"` on a healthy add-on, the classifier's fallback for no error).

**Panel verdicts (v1.154.0).** A failed, never-asked or replayed alarm-path SHP2
poll also routes here: `notePollFailed` carries `{cause, sns}`, bound to that
failure and cleared by any other. When the failure is a panel verdict and at least
one other device is still current (`blindAlertContext`: online, a dpu/shp2
projection, a quota write inside the stale bound, not itself replaying, not a Core outside the home pool), the alert names the panel
condition — e.g. *"Panel data is stale — grid presence unknown"*, with the count of
devices still reporting — instead of claiming the add-on sees nothing. With nothing
else current the original text is used, because it is then true. Id, severity and
priority are identical either way, and the Cause fact names the verdict.

### 2.16 Cloud-session self-heal (`server/src/sessionSelfHeal.ts`) — v1.76.0

**v1.108.0 — electrical-idleness gate.** EcoFlow devices message in proportion to electrical activity, so an idle device's collapsed rate is explained by idleness, not a wedged session: the 08-24 audit found the detector repeatedly flagging an off-panel spare parked at its charge cap (2–4 msg/min against a baseline learned while panel-wired) and burning the nightly self-heal budget on an all-idle fleet. The tick now skips SURFACING (push + warn) for a device whose `|totalInWatts| + |totalOutWatts| < 30 W` (`isElectricallyIdle`, messageRateFloor.ts) while still SAMPLING it, so learned baselines stay honest. Nulls fail toward monitored — the SHP2's projection has no such fields and is therefore never idle-suppressed; a discharging (islanded) Core is never idle; a wedge on hardware moving real power still surfaces. Side effect, intended: the nightly all-idle vendor window no longer consumes self-heal budget. **Correction (v1.157.0):** that held only for collapses that never surfaced. Since v1.111.0 a collapse that surfaced while its device was active is HELD through idleness, and an idle Core cannot clear the 10 msg/min recovery bar, so on 2026-09-13 three Cores held at reserve spent four heals on a healthy session (see v1.157.0 below).

**v1.111.0 — idleness gates ENTRY, never eviction.** The v1.108.0 gate was
stateless per tick, so a brief idle spell mid-collapse EVICTED the standing
alert: silent resolve, duplicate push on re-fire, and — because the tracker's
fired-edge had been consumed while suppressed — pushes with no matching warn
line (six pushes, zero warns on the night of 08-26, aligned to the night-charge
write edges that woke the fleet). `decideCollapseSurfacing` (pure) now owns the
decision: offline evicts (the offline alert's business), recovery evicts,
idleness only blocks initial entry; the collapse warn logs exactly once per
surfaced episode, even when the edge passed during an idle spell. Harness
extended to 16 mutants.

**v1.112.1 — entry additionally requires starved-RIGHT-NOW.** v1.111.0's first
live night showed every late surface firing during the RECOVERY dwell: the
device woke at the night-charge write edge, its rate rebounded instantly, and
the warn read "collapsed to 34 msg/min (baseline ~15)" — self-contradicting —
while the alert pushed for the ~4 minutes the tracker needed to confirm
recovery (one episode idled open 7 h that way). Entry now also requires the
current rate to sit under the collapse floor (`floorFraction x baseline`;
nulls fail toward starved): an episode that has already rebounded closes
silently via the recovery dwell, a still-starved active device (the SHP2-crawl
case) surfaces exactly as before, and holding is untouched. Harness 17/17.

**v1.157.0 — an idle device's held collapse no longer votes for a heal.** The heal
quorum is decided by `selfHealQuorum` (sessionSelfHeal.ts), not by the size of the alert
set: a surfaced collapse counts when its device is the alarm-path panel (by identity,
whatever its projection reads) or is not electrically idle on this tick — the same
`isElectricallyIdle` reading the entry gate uses, where a missing power reading counts as
not idle. The alert set, its push dwell, the
latch, the dwell, cooldown and rolling budget, and the panel exception (§12m) are
unchanged. On 2026-09-13 the collapses of three Cores surfaced at 21:31 while they
discharged; the 21:35 heal restored the session; the packs reached reserve at 21:37,
inside the recovery dwell, and the held collapses kept a three-device quorum that spent
heals at 22:35, 23:35, 00:35 and 01:35 before the cap stood the healer down at 02:35.
Replayed under the new rule that night heals once. The heal warn line now lists its
members (`[counted: …]`), and its "N devices starved" counts those members, not every
surfaced collapse; a device leaving the quorum as idle logs one info line per edge.
Accepted trade-off, pinned by a test: a Core that reads idle for a single tick during an
active wedge restarts the dwell when that tick drops the count below the quorum. Harness
`scripts/mutate-heal-idle-quorum.mjs` (17/17).

**v1.158.0 — the same set now also holds the PUSH.** v1.157.0 removed the heal vote for a
held-idle device and left the notification, which is how three `[Medium] Device barely
reporting` cards pushed at 21:51 on 2026-09-13 — twenty minutes after a collapse that the
21:35 rebuild had already fixed (the panel was back at 31 msg/min by 21:41) — and stood until
the packs woke at 07:04-07:29, telling the operator to check the cloud session and power on
three healthy packs. The rate-floor tick publishes `selfHealQuorum`'s own `idleExcluded` set
(`setRateFloorIdleHeld`), and `pushDwellStart` re-bases the 20-minute dwell for as long as an
alert's device is in it, so the dwell is re-earned once the device is ACTIVE and still
starved. The CARD is unchanged (same episode, same on-screen alert), the alarm-path panel is
never held (identity), and a collapse that never idles pages at 20 minutes exactly as before.
★ Deliberately UNCHANGED: `analytics.ts`'s `starvedSnsForBaseline` still reads the raw
collapse set, so a held-idle collapse also suppresses the learned-baseline alert family for
the life of the hold (9 h 30 m on 2026-09-13/14). Filtering it would resume raises on a pack
whose feed genuinely is low-cadence; that needs evidence those raises are meaningful there.
Harness: `scripts/mutate-push-dwell.mjs`.

When the quorum of devices sits in a surfaced message-rate collapse that
`selfHealQuorum` counts (not electrically idle this tick, or the alarm-path panel, which
alone also satisfies the quorum — §12m)
for `SELF_HEAL_AFTER_MS` (20 min), the add-on rebuilds its own MQTT session:
stop, certificate re-fetch, fresh connect. Guards, each mutation-proven
load-bearing (`scripts/mutate-session-self-heal.mjs`, 8/8; the quorum membership rule in
`scripts/mutate-heal-idle-quorum.mjs`, 17/17): the multi-device
threshold, the dwell, a 60-min cooldown, a 6-heal cap over a **rolling 24 h
window persisted to `/data/self-heal-budget.json`** (v1.93.0 — it was previously
process-local, so the cap was really "6 per process lifetime"; with this add-on's
restart cadence that yielded 10 rebuilds in 22 h against a nominal cap of 6.
`lastHealMs` persists with it so the cooldown also survives a restart, while
`starvedSinceMs` deliberately does not — the dwell is re-earned against live
telemetry) (v1.90.0 — previously UTC-day-keyed, which reset to zero at UTC midnight,
17:00 at the reference plant, and granted a fresh burst mid-evening; the rolling window frees one
slot as each heal ages past 24 h, so the cap is a true rate limit), and a
post-heal onset reset. Read-path only — REST polling is untouched, and a failed rebuild
falls back to the existing `startMqttWithRetry` backoff.

The quorum is `effectiveQuorum`: the smaller of `SELF_HEAL_MIN_DEVICES` (2 when unset) and
the number of devices on the account (v1.191.0), so an account with a single device can still
trigger a rebuild. The count is every device on the account, not the online or eligible ones,
so on a plant with more devices than the setting a dark half of the fleet does not lower it;
with no device known yet the setting stands.

**Measured verdict (maiden night, 2026-08-11, reference plant).** The mechanism ran exactly to
spec — five rebuilds, each mechanically perfect (~1.4 s, all subscriptions
restored) — and **did not shorten the starvation**: message rates stayed pinned
through every heal window, and recovery arrived at ~05:11 MST, the same
wall-clock minute as the prior heal-free night. The nightly starvation is
therefore **upstream of the client session** (an EcoFlow cloud- or device-side
window with jittered onset and recovery anchored near 05:11 MST); no client-side
rebuild can end it. The healer is retained as a bounded, harmless probe for
other session-wedge classes (e.g. the 08-08 keepalive death), not as a fix for
the nightly window.

