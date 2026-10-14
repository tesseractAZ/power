# Configuration options

Every option is grouped by function. "Env var" is the exported name (identical to the option
key in all cases). "Schema" is the `voluptuous`-style validator from the `schema:` block; a
trailing `?` marks the field optional. Defaults are the values in the `options:` block.

Set options on the add-on's **Configuration** tab in Home Assistant; saving restarts the add-on.
This page has one row per option, and `scripts/check-docs.mjs` holds every Default and Schema
cell to `ecoflow_panel/config.yaml`. The operator guide, `ecoflow_panel/DOCS.md`, groups the
common ones by goal.

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
| `FORECAST_LAT` | `33.4484` | `float(-90,90)` | Latitude for the day-ahead solar forecast (Open-Meteo). The default is a placeholder: replace it with your site's. |
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
| `BROADCAST_SIP_TARGETS` | `""` | `str?` | Second list of announce-only targets (for example a SIP phone exposed as a media player) that get alarms via `media_player.play_media(announce)` instead of Music Assistant. |
| `BROADCAST_MIN_SEVERITY` | `critical` | `list(critical\|warning)` | Minimum severity for an audible broadcast. |
| `BROADCAST_QUIET_HOURS` | `"22-06"` | `str?` | Quiet window for audible alarms. |
| `CRITICAL_BREAKS_QUIET_HOURS` | `false` | `bool` (→ `true`/`false`) | When true, a critical alert breaks through quiet hours on the push channel, and a High (P2) or Critical (P1) announcement breaks through on the speakers. Default false ⇒ quiet hours silence every tier (the alert still shows on screen, and its push arrives in the morning digest). Shared by alertMonitor (push) and broadcast (audible). |
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
| `BROADCAST_BILINGUAL` | `true` | `bool` (→ `true`/`false`) | Second announcement pass in Spanish after English. |
| `BROADCAST_WYOMING_VOICE_ES` | `""` | `str?` | Piper voice for the Spanish pass. |

> Note: an option reaches the server only through the runner's options→env bridge
> (`rootfs/etc/services.d/ecoflow-panel/run`), which exports every option on this page. A new
> option added to config.yaml is dead until the runner exports it (see
> [the options→env bridge](../reference/12-configuration-deployment-security.md#the-optionsenv-bridge-run-script)).

#### Battery & grid alarms

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `BATTERY_SOC_ALARM_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the state-of-charge alarm engine. |
| `BATTERY_RUNWAY_ALARM_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the runway (time-to-reserve) alarm. |
| `BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN` | `60` | `int(5,720)?` | Minutes between re-announcements of an active runway alarm. |
| `GRID_AVAILABLE` | `false` | `bool` (→ `true`/`false`) | Must be `false` for an islanded/off-grid site — drives off-grid honesty + the grid-aware floor. |
| `GRID_PRESENCE_ENTITY` | `""` | `str?` | HA entity reporting real grid presence (grid-aware floor re-escalation). |
| `GRID_FLOOR_SLACK_PCT` | `"1.5"` | `str?` | Points above the backup reserve at which a declared grid with no measured flow stops being trusted and lighting austerity may pre-arm. Runtime-clamped to 0–10; blank or garbage = 1.5. The critical floor alarm's own +1.5 % coherence check is unaffected ([the backstopping decision](../reference/05-runway-and-soc-alarms.md#43-the-backstopping-decision-stricter-than-present)). |
| `CHARGE_NOW_RESPONSE` | `advisory` | `list(off\|advisory\|supervised)?` | Response to on-peak grid charging while the SHP2 "Charge Now" switch is on. `advisory` pushes once per episode; `supervised` also turns the switch OFF through the audited write path; `off` disables it ([Charge Now responder](../reference/12-configuration-deployment-security.md#12c-charge-now-responder-chargenowresponderts-v1840)). |
| `HOST_POWER_ENTITY` | `""` | `str?` | HA `binary_sensor` (device_class=problem) reporting the Pi's kernel under-voltage flag. When set, the alarm engine warns on a browning-out host before it goes dark. Empty = dormant. |

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
| `NWS_ENABLED` | `false` | `bool` (→ `1`/`0`) | US-only NWS storm-preparedness alerts. |
| `MQTT_DISCOVERY_ENABLED` | `false` | `bool` (→ `1`/`0`) | Publish HA MQTT-discovery sensors. |
| `MQTT_DISCOVERY_HOST` | `""` | `str?` | MQTT broker host. |
| `MQTT_DISCOVERY_PORT` | `1883` | `port` | MQTT broker port. |
| `MQTT_DISCOVERY_USER` | `""` | `str?` | MQTT username. |
| `MQTT_DISCOVERY_PASS` | `""` | `password?` | MQTT password. |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | `str?` | MQTT discovery topic prefix. |

#### Telnet control-room TUI (LAN-only; unauthenticated unless a console password is set)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `TELNET_ENABLED` | `false` | `bool` (→ `1`/`0`) | **Default OFF** (CWE-1188). An unauthenticated control-plane on the LAN shouldn't be on by default. Existing installs keep their saved value on upgrade. |
| `TELNET_PORT` | `2323` | `port` | Telnet TUI port. |
| `TUI_USERNAME` | empty | `str?` | Console login username (defaults to `operator` when empty and a password is set). |
| `TUI_PASSWORD` | empty | `password?` | Console login password; empty disables the login prompt. Masked in the options UI. |
| `TUI_TRUSTED_ORIGINS` | empty | `str?` | Comma-separated EXACT browser origins (for example one specific Nabu Casa URL) added to the same-origin set. A listed origin can open `/console/ws` and `/ws`, **and it passes the write-auth gate with no token** ([write-auth gate](../reference/12-configuration-deployment-security.md#write-auth-gate-requirewriteauth-serversrcauthts), condition 2). Empty = LAN + ingress only. |

#### Night-charge engine

The engine plans an overnight grid charge in the APS R-EV overnight window (23:00–05:00
America/Phoenix, Monday to Friday). The full semantics are in
[night-charge planning](../reference/15-1-night-charge-planning.md) and
[the night-charge writes](../reference/15-2-night-charge-writes.md).

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `NIGHT_CHARGE_ADVISOR_ENABLED` | `true` | `bool` (→ `true`/`false`) | Runs the night-charge planner: the plan recomputed every 30 minutes, the nightly notice and the write timers. Off: no plan is computed, the night-charge sensors carry none, no notice is sent and no write is armed. Change it outside a charge night: the timer that restores a raised reserve stops with it (the force-charge OFF keeps its own). |
| `NIGHT_CHARGE_MODE` | `advisory` | `list(advisory\|supervised\|auto)` | What the engine may write. `advisory` writes nothing. `supervised` arms one announced, cancellable write per charge night: the backup reserve is raised at the window open to the plan's setpoint (clamped to 10–50), read back, and restored at the window close, or at once on a cancel or a grid loss. With `ARB_OBJECTIVE` set to `cost` and `ARB_COST_MAX_SOC_PCT` above 50 it adds a just-in-time force-charge toward the night's target. `auto` runs exactly as `supervised`. Unknown values fail closed to `advisory`. |
| `ARB_OUTAGE_CUSHION_PCT` | `15` | `int(0,40)` | Legacy cushion, as a percent of the pool, used only while no islanded-load measurement exists; the primary cushion is `ARB_OUTAGE_CUSHION_HOURS` of the measured islanded load. Never changes the floor alarm. |
| `ARB_OUTAGE_CUSHION_HOURS` | `4` | `float(0,72)` | Hours of outage the pack must carry the panel's own circuits after the window closes, above the reserve: hours × the 7-day mean panel load × `ARB_ISLANDED_LOAD_SAFETY` ÷ the discharge efficiency. `0` disables the cushion. |
| `ARB_ISLANDED_LOAD_SAFETY` | `1.25` | `float(1,5)` | Multiplier on the measured panel load in the cushion. Higher buys more. |
| `ARB_OBJECTIVE` | `resilience` | `list(resilience\|cost)` | `resilience` buys only the reserve plus the cushion. `cost` treats that as a floor and fills further, toward a ceiling that leaves room for tomorrow morning's solar, capped at `ARB_COST_MAX_SOC_PCT`. It can buy more, never less. |
| `ARB_COST_MAX_SOC_PCT` | `90` | `int(50,100)` | Cost-mode fill ceiling. The panel's backup reserve stops at 50, so above 50 the night's target is reached by force-charge; `50` turns force-charge off. |
| `ARB_MIN_BUY_KWH` | `1` | `float(0,50)` | Below this recommended buy the night is a "hold". |
| `ARB_CHARGE_CAP_KW` | `0` | `float(0,50)` | Grid-side charge-power ceiling the plan is sized against. `0` = automatic: the connected Cores × the rate each is measured to take (about 5.9 kW per Core at the grid). Above 0 is a fixed override. Sizing only; no device is set. |
| `ARB_GRID_INPUT_CAP_KW` | `17` | `float(0,100)` | The panel's total grid-input envelope, shared by house load and charging. It caps what the plan assumes the packs receive while the house draws (an EV above all) and times the force-charge start (this value less the live house load). `0` ignores contention. |
| `ARB_LOAD_P90_FACTOR` | `1.15` | `float(1,2)` | Floor of the multiplier that pads the forecast household load when the buy is sized; the calibrated band only widens above it. |
| `NIGHT_CHARGE_NOTIFY_HOUR` | `21` | `int(0,23)` | Hour, America/Phoenix, of the nightly job: it records the plan, sends the notice and, in a write mode, arms the write. The job may run only until 23:00, so the hour is clamped to 22. |
| `NIGHT_CHARGE_NOTIFY_MINUTE` | `30` | `int(0,59)` | Minute of that hour. If the add-on is down from this time until 23:00, that night's notice is skipped rather than sent late. |
| `NIGHT_CHARGE_NOTIFY_ON_HOLD` | `true` | `bool` (→ `true`/`false`) | Send the nightly notice on hold nights too, as confirmation the job ran. A night with no plan always notifies. |

#### Tariff (APS R-EV)

The tariff model is APS Rate Schedule R-EV: on-peak 16:00–19:00 Monday to Friday, overnight
23:00–05:00 Monday to Friday, super-off-peak 10:00–15:00 Monday to Friday in winter, and off-peak
otherwise, including weekends and the schedule's holidays. Summer is April to September by month
of use. Enter each rate as the effective ¢/kWh from a bill.

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `TARIFF_APS_ONPEAK_SUMMER_CENTS` | `""` | `str?` | Summer on-peak rate. Empty = not set. |
| `TARIFF_APS_ONPEAK_WINTER_CENTS` | `""` | `str?` | Winter on-peak rate. |
| `TARIFF_APS_OFFPEAK_SUMMER_CENTS` | `""` | `str?` | Summer off-peak rate. |
| `TARIFF_APS_OFFPEAK_WINTER_CENTS` | `""` | `str?` | Winter off-peak rate. |
| `TARIFF_APS_OVERNIGHT_CENTS` | `""` | `str?` | Overnight rate, both seasons. |
| `TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS` | `""` | `str?` | Winter super-off-peak rate. |
| `TARIFF_APS_RATES_CONFIRMED` | `false` | `bool` (→ `true`/`false`) | Confirms the rates above come from a bill. While false the tariff table prices nothing (Grid Rate Now reads unknown), and the cost and savings figures use a flat 17 ¢/kWh default. Fill the rates in first: a period left without a rate is still priced at the flat default. |

#### Heartbeat (dead-man's switch)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `HEARTBEAT_URL` | `""` | `str?` | An https URL from an outside monitoring service. Power sends it a GET every `HEARTBEAT_INTERVAL_S`; when the pings stop (host down, add-on killed, power lost) that service alerts you, from outside everything Power could report on. Empty = off. A value that is not a parseable https URL is rejected, nothing is sent, and the log names the reason. Treat the URL as a secret: only its host is ever logged. |
| `HEARTBEAT_INTERVAL_S` | `300` | `int(60,3600)?` | Seconds between pings, clamped to 60–3600. Set the outside check's period to match, with a grace of about two intervals. |


#### Diagnostic / advanced

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `RECORDER_RETENTION_DAYS` | `30` | `int(7,3650)` | Raw-samples retention in days for the SQLite recorder. Runtime clamps to [7, 3650] and falls back to 30 on a malformed value; the durable night-charge ledger and lifetime totals are never pruned regardless. |
| `ECOFLOW_DEVICE_REACHABILITY` | `""` | `str?` | SN→HA-ping-entity JSON map for cloud-wedge vs real-outage detection. |
| `WRITE_DEBUG_TOKEN` | `""` | `password?` | When non-empty, unlocks `POST /api/device/send-command`. Default empty = the debug write path is disabled. See [the write-debug lockdown](../reference/12-configuration-deployment-security.md#write-debug-lockdown--post-apidevicesend-command). |
