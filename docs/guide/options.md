# Configuration options

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
| `NOTIFY_CHANNEL` | `none` | `list(none\|ha)` | Home Assistant notifications on/off. |
| `NOTIFY_MIN_SEVERITY` | `warning` | `list(warning\|critical)` | Minimum severity that triggers a push. |
| `NOTIFY_RESOLVED` | `true` | `bool` (→ `1`/`0`) | Also send a push when an alert clears. |
| `NOTIFY_HA_PUSH_TARGETS` | `""` | `str?` | HA notify services that receive the push, e.g. `notify.mobile_app_iphone`, or `notify.notify` for every registered device. Empty = drawer card only, no push. |
| `NOTIFY_CRITICAL_BYPASS_DND` | `true` | `bool` (→ `1`/`0`) | Critical alerts carry the companion app's critical payload and sound through Do Not Disturb. Warnings never do. |
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
| `GRID_FLOOR_SLACK_PCT` | `"1.5"` | `str?` | (v1.74.0) Points above the backup reserve at which a declared grid with no measured flow stops being trusted and lighting austerity may pre-arm. Runtime-clamped to 0–10; blank or garbage = 1.5. The critical floor alarm's own +1.5 % coherence check is unaffected (§5 4.3). |
| `CHARGE_NOW_RESPONSE` | `advisory` | `list(off\|advisory\|supervised)?` | (v1.84.0) Response to on-peak grid charging while the SHP2 "Charge Now" switch is on. `advisory` pushes once per episode; `supervised` also turns the switch OFF through the audited write path; `off` disables it (§12c). |
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

#### Telnet control-room TUI (LAN-only; unauthenticated unless a console password is set)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `TELNET_ENABLED` | `false` | `bool` (→ `1`/`0`) | (v1.7.0, security #5, CWE-1188) **Default OFF.** An unauthenticated control-plane on the LAN shouldn't be on by default. Existing installs keep their saved value on upgrade. |
| `TELNET_PORT` | `2323` | `port` | Telnet TUI port. |
| `TUI_USERNAME` | empty | `str?` | Console login username (defaults to `operator` when empty and a password is set). |
| `TUI_PASSWORD` | empty | `password?` | Console login password; empty disables the login prompt. Masked in the options UI. |
| `TUI_TRUSTED_ORIGINS` | empty | `str?` | (v1.47.3) Comma-separated EXACT browser origins (for example one specific Nabu Casa URL) added to the same-origin set. A listed origin can open `/console/ws` and `/ws`, **and it passes the write-auth gate with no token** (Security posture, condition 2). Empty = LAN + ingress only. |

#### Night-charge engine + tariff + heartbeat

The night-charge option group (`NIGHT_CHARGE_ADVISOR_ENABLED`,
`NIGHT_CHARGE_MODE` — `list(advisory|supervised|auto)`, default `advisory` —
`ARB_OUTAGE_CUSHION_PCT`, `ARB_OUTAGE_CUSHION_HOURS` (default 4 h, 0–72), `ARB_ISLANDED_LOAD_SAFETY` (default 1.25, 1–5), `ARB_OBJECTIVE` (`resilience`/`cost`, default `resilience`), `ARB_COST_MAX_SOC_PCT` (default 90, 50–100), `ARB_MIN_BUY_KWH`, `ARB_CHARGE_CAP_KW`, `ARB_GRID_INPUT_CAP_KW` (default 17 kW, 0–100; 0 ignores grid-input contention),
`ARB_LOAD_P90_FACTOR`, `NIGHT_CHARGE_NOTIFY_HOUR`/`_MINUTE`,
`NIGHT_CHARGE_NOTIFY_ON_HOLD`) and the APS R-EV tariff options
(`TARIFF_APS_*_CENTS` ×6, `TARIFF_APS_RATES_CONFIRMED`) are documented with
full semantics, defaults, and ranges in the chapter that owns them —
§15.10 — including the supervised/auto write-posture contract (§15.8b).
`HEARTBEAT_URL` / `HEARTBEAT_INTERVAL_S` (dead-man's-switch pings to an
external monitor; empty URL disables) are documented in §13.0c.

#### Diagnostic / advanced

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `RECORDER_RETENTION_DAYS` | `30` | `int(7,3650)` | (v1.51.0; ceiling raised v1.108.0) Raw-samples retention in days for the SQLite recorder. Runtime clamps to [7, 3650] and falls back to 30 on a malformed value; the durable night-charge ledger and lifetime totals are never pruned regardless. |
| `ECOFLOW_DEVICE_REACHABILITY` | `""` | `str?` | (v0.72.0) SN→HA-ping-entity JSON map for cloud-wedge vs real-outage detection. |
| `WRITE_DEBUG_TOKEN` | `""` | `password?` | (v0.9.9) When non-empty, unlocks `POST /api/device/send-command`. Default empty = the debug write path is disabled. See Security. |
