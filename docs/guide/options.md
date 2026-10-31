# Configuration options

Every option is grouped by function. "Env var" is the exported name (identical to the option
key in all cases). "Schema" is the `voluptuous`-style validator from the `schema:` block; a
trailing `?` marks the field optional. Defaults are the values in the `options:` block. A key with no
`options:` default is unset until you set it, and is not passed to the server while unset; its
Default cell says what Power does then, which is the built-in behaviour.

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

#### Site location

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `FORECAST_LAT` | `33.4484` | `float(-90,90)` | Latitude for the day-ahead solar forecast (Open-Meteo), the NWS storm alerts, the PV model once a `PV_*` key is set, and where day is told from night while a Core is offline and its solar is counted at the panel. The default is a placeholder: replace it with your site's. With `SITE_LOCATION_FROM_HA` on, Home Assistant's home location replaces both coordinates from the start after it is read. |
| `FORECAST_LON` | `-112.074` | `float(-180,180)` | Longitude for the forecast. The default is a placeholder too. |

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
| `BROADCAST_TARGETS` | `""` | `str?` | Comma-separated `media_player` entity IDs that Music Assistant plays alarms on. An entry that does not start with `media_player.` is dropped. |
| `BROADCAST_SIP_TARGETS` | `""` | `str?` | Second list of announce-only targets (for example a SIP phone exposed as a media player) that get alarms via `media_player.play_media(announce)` instead of Music Assistant. |
| `BROADCAST_MIN_SEVERITY` | `critical` | `list(critical\|warning)` | Minimum severity for an audible broadcast. |
| `BROADCAST_QUIET_HOURS` | `"22-06"` | `str?` | Quiet window for audible alarms. |
| `CRITICAL_BREAKS_QUIET_HOURS` | `false` | `bool` (→ `true`/`false`) | When true, a critical alert breaks through quiet hours on the push channel, and on the speakers every critical alarm breaks through, as does a High (P2) runway alarm; other High alarms stay silent. Default false ⇒ quiet hours silence every tier (the alert still shows on screen, and its push arrives in the morning digest; the speech is not played later). Shared by alertMonitor (push) and broadcast (audible). |
| `BROADCAST_AUDIO_BASE` | `http://homeassistant.local:8787` | `str?` | Base URL speakers fetch klaxon/announcement WAVs from. |
| `BROADCAST_VOLUME` | `0.5` | `float(0,1)` | Broadcast (chime) volume. |
| `BROADCAST_ANNOUNCE_VOLUME` | `""` | `str?` | Optional separate volume for the spoken announcement. |
| `BROADCAST_USE_PRE_ANNOUNCE` | `false` | `bool` (→ `true`/`false`) | Play the platform pre-announce tone before the message. |
| `BROADCAST_LEAD_SILENCE_MS` | `1000` | `int(0,5000)?` | Silence before each alarm, so a slow speaker (AirPlay, ecobee) joins the stream before the chime starts. Raise it toward 1500 if the start is clipped. |
| `BROADCAST_REPEAT` | `2` | `int(1,3)?` | How many times to repeat the announcement. |
| `BROADCAST_REPEAT_GAP_MS` | `1500` | `int(0,5000)?` | Gap between repeats. |
| `BROADCAST_CHIME_GAP_MS` | `1000` | `int(0,5000)?` | Gap between chime and speech. |
| `BROADCAST_ANNOUNCE_RETRIES` | `1` | `int(0,3)?` | Retries if the announce call fails. |
| `BROADCAST_WYOMING_HOST` | `core-piper` | `str?` | Wyoming/Piper TTS host. |
| `BROADCAST_WYOMING_PORT` | `10200` | `port` | Wyoming TTS port. |
| `BROADCAST_WYOMING_VOICE` | `""` | `str?` | Piper voice (English). |
| `BROADCAST_BILINGUAL` | `false` | `bool` (→ `true`/`false`) | Second announcement pass in Spanish after English, once `BROADCAST_WYOMING_VOICE_ES` names a Spanish voice. Off by default; a saved configuration keeps the value it holds. |
| `BROADCAST_WYOMING_VOICE_ES` | `""` | `str?` | Piper voice for the Spanish pass. |

> Note: an option reaches the server only through the runner's options→env bridge
> (`rootfs/etc/services.d/ecoflow-panel/run`), which exports every option on this page (a key with
> no default only while it is set). A new
> option added to config.yaml is dead until the runner exports it (see
> [the options→env bridge](../reference/12-configuration-deployment-security.md#the-optionsenv-bridge-run-script)).

#### Battery & grid alarms

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `BATTERY_SOC_ALARM_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the state-of-charge alarm engine, at the levels `BATTERY_SOC_LADDER` sets. |
| `BATTERY_RUNWAY_ALARM_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the runway (time-to-reserve) alarm. |
| `BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN` | `60` | `int(5,720)?` | Minutes between re-announcements of an active runway alarm. |
| `GRID_AVAILABLE` | `false` | `bool` (→ `true`/`false`) | Must be `false` for an islanded/off-grid site — drives off-grid honesty + the grid-aware floor. |
| `GRID_PRESENCE_ENTITY` | `""` | `str?` | HA entity reporting real grid presence (grid-aware floor re-escalation). |
| `GRID_FLOOR_SLACK_PCT` | `"1.5"` | `str?` | Points above the backup reserve at which a declared grid with no measured flow stops being trusted and lighting austerity may pre-arm. Runtime-clamped to 0–10; blank or garbage = 1.5. The critical floor alarm's own +1.5 % coherence check is unaffected ([the backstopping decision](../reference/05-runway-and-soc-alarms.md#43-the-backstopping-decision-stricter-than-present)). |
| `CHARGE_NOW_RESPONSE` | `advisory` | `list(off\|advisory\|supervised)?` | Response to on-peak grid charging while the SHP2 "Charge Now" switch is on. `advisory` pushes once per episode; `supervised` also turns the switch OFF through the audited write path; `off` disables it ([Charge Now responder](../reference/12-configuration-deployment-security.md#12c-charge-now-responder-chargenowresponderts-v1840)). |
| `HOST_POWER_ENTITY` | `""` | `str?` | HA `binary_sensor` (device_class=problem) reporting the host's under-voltage flag; on a Raspberry Pi host, the Raspberry Pi Power Supply Checker's `binary_sensor.rpi_power_status`. When set, the alarm engine warns on a browning-out host before it goes dark. Empty = dormant. |

#### Load-shedding advisor (read + advise only; never actuates)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `LOAD_SHEDDING_ADVISORY_ENABLED` | `true` | `bool` (→ `true`/`false`) | Enable the advisory engine (HA automations do the actual actuation). |
| `LOAD_SHEDDING_SHED_ENTITIES` | `""` | `str?` | The loads the advisor may recommend shedding, comma-separated, each `entity_id:priority:label:watts[:circuit]`: priority 1 is shed first, `watts` is your estimate, and the optional panel circuit number reads measured watts instead. Example: `switch.pool_pump:2:Pool pump:400:5`. |
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

#### SSH control-room TUI (LAN; password login)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `SSH_ENABLED` | `false` | `bool` (→ `1`/`0`) | **Default OFF** (CWE-1188). Serves the console over SSH on `SSH_PORT`: `ssh -p 2323 <user>@<host>`, logging in with `TUI_USERNAME` / `TUI_PASSWORD`; every login is refused until a password is set. The host key fingerprint is in the add-on log at every start. |
| `SSH_PORT` | `2323` | `port` | SSH TUI port inside the container (the published port). |
| `TUI_USERNAME` | empty | `str?` | Console login username (defaults to `operator` when empty and a password is set). |
| `TUI_PASSWORD` | empty | `password?` | Console login password; empty turns the browser console's login prompt off and makes the SSH console refuse every login. Masked in the options UI. |
| `TUI_TRUSTED_ORIGINS` | empty | `str?` | Comma-separated EXACT browser origins (for example one specific Nabu Casa URL) added to the same-origin set. A listed origin can open `/console/ws` and `/ws`, **and it passes the write-auth gate with no token** ([write-auth gate](../reference/12-configuration-deployment-security.md#write-auth-gate-requirewriteauth-serversrcauthts), condition 2). Empty = LAN + ingress only. |

#### Night-charge engine

The engine plans a grid charge in the tariff's cheap window, in site time: with the APS R-EV
preset, the overnight period, 23:00–05:00 Monday to Friday; on a custom plan, the period flagged
`cheap` (`NIGHT_CHARGE_CHEAP_PERIOD` names another period of the plan). The nightly job runs
before that window opens: with another plan than the preset, its catch-up window, its notify-hour
clamp, its deferral of a stale panel and the force-charge run cap follow the plan's cheap window
(below); the preset keeps 23:00, 22, 22:30 and 7 hours. The full semantics are in
[night-charge planning](../reference/15-1-night-charge-planning.md) and
[the night-charge writes](../reference/15-2-night-charge-writes.md).

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `NIGHT_CHARGE_ADVISOR_ENABLED` | `true` | `bool` (→ `true`/`false`) | Runs the night-charge planner: the plan recomputed every 30 minutes, the nightly notice and the write timers. Off: no plan is computed, the night-charge sensors carry none, no notice is sent and no write is armed. Change it outside a charge night: the timer that restores a raised reserve stops with it (the force-charge OFF keeps its own). |
| `NIGHT_CHARGE_MODE` | `advisory` | `list(advisory\|supervised\|auto)` | What the engine may write. `advisory` writes nothing. `supervised` arms one announced, cancellable write per charge night: the backup reserve is raised at the window open to the plan's setpoint (clamped to 10–50), read back, and restored at the window close (an hour before on-peak at the latest), or at once on a cancel or a grid loss. Nothing is raised or switched on within an hour of on-peak, and a restore the panel does not confirm is paged as critical. With `ARB_OBJECTIVE` set to `cost` and `ARB_COST_MAX_SOC_PCT` above 50 it adds a just-in-time force-charge toward the night's target. `auto` runs exactly as `supervised`. Unknown values fail closed to `advisory`. |
| `ARB_OUTAGE_CUSHION_PCT` | `15` | `int(0,40)` | Legacy cushion, as a percent of the pool, used only while no islanded-load measurement exists; the primary cushion is `ARB_OUTAGE_CUSHION_HOURS` of the measured islanded load. Never changes the floor alarm. |
| `ARB_OUTAGE_CUSHION_HOURS` | `4` | `float(0,72)` | Hours of outage the pack must carry the panel's own circuits after the window closes, above the reserve: hours × the 7-day mean panel load × `ARB_ISLANDED_LOAD_SAFETY` ÷ the discharge efficiency. `0` disables the cushion. Choose the hours an outage that starts as the window closes must be carried before you can act, for example by starting a generator. On a charge night the reserve write raises the reserve to this line, the reserve plus the cushion rounded up to a whole percent, or with `ARB_OBJECTIVE` `cost` to the night's cost target where that is higher (the panel takes at most 50 %). The cushion is counted on the panel's nameplate pool, and the reserve percent is a share of the packs' measured capacity (about 0.94 of nameplate), so the line holds about that share of the cushion's energy above the reserve. |
| `ARB_ISLANDED_LOAD_SAFETY` | `1.25` | `float(1,5)` | Multiplier on the measured panel load in the cushion. Higher buys more. |
| `ARB_OBJECTIVE` | `resilience` | `list(resilience\|cost)` | `resilience` buys only the reserve plus the cushion. `cost` treats that as a floor and fills further, toward a ceiling that leaves room for tomorrow morning's solar, capped at `ARB_COST_MAX_SOC_PCT`. It can buy more, never less. With `cost` and `ARB_COST_MAX_SOC_PCT` above 50, the evening before a winter weekday also works out the charge it would make in the tariff's `super_off_peak` period instead (10:00–15:00 with the APS R-EV preset), as a preview only: it is shown on the Midday-Charge entities and the night-charge card, and nothing is written for it. |
| `ARB_COST_MAX_SOC_PCT` | `90` | `int(50,100)` | Cost-mode fill ceiling. The panel's backup reserve stops at 50, so above 50 the night's target is reached by force-charge; `50` turns force-charge off. |
| `ARB_MIN_BUY_KWH` | `1` | `float(0,50)` | Below this recommended buy the night is a "hold". |
| `ARB_CHARGE_CAP_KW` | `0` | `float(0,50)` | Grid-side charge-power ceiling the plan is sized against. `0` = automatic: the connected Cores × the rate each is measured to take (about 5.9 kW per Core at the grid on the reference plant). Above 0 is a fixed override; leave `0` unless that measured rate is wrong for your Cores. Sizing only; no device is set. |
| `ARB_GRID_INPUT_CAP_KW` | `17` | `float(0,100)` | The panel's total grid-input envelope, shared by house load and charging. The default is the reference plant's measured figure: enter your grid-input breaker capacity. It caps what the plan assumes the packs receive while the house draws (an EV above all) and times the force-charge start (this value less the live house load). `0` ignores contention. |
| `ARB_LOAD_P90_FACTOR` | `1.15` | `float(1,2)` | Floor of the multiplier that pads the forecast household load when the buy is sized; the calibrated band only widens above it. |
| `NIGHT_CHARGE_NOTIFY_HOUR` | `21` | `int(0,23)` | Hour, in site time, of the nightly job: it records the plan, sends the notice and, in a write mode, arms the write. The job may run only until the cheap window opens (23:00 with the APS R-EV preset; at most midnight with any plan), so the hour is clamped to the hour before the window opens, and never above 22. With another plan than the preset a clamped hour raises a repair issue that names the time the job runs at: a write mode refuses to arm a window that opened more than 30 minutes earlier, so the job must run first. |
| `NIGHT_CHARGE_NOTIFY_MINUTE` | `30` | `int(0,59)` | Minute of that hour. If the add-on is down from this time until the cheap window opens (or midnight, if the window opens later), that night's notice is skipped rather than sent late. A stale panel reading or an incomplete basis defers the plan until 22:30 with the preset, and with another plan until the earlier of an hour after this time and 30 minutes before the window opens. |
| `NIGHT_CHARGE_NOTIFY_ON_HOLD` | `true` | `bool` (→ `true`/`false`) | Send the nightly notice on hold nights too, as confirmation the job ran. A night with no plan always notifies. |

#### Tariff: the APS R-EV preset

`TARIFF_PLAN` chooses the tariff model; its keys are under "Your home" below. The keys in this
table are used when `TARIFF_PLAN` is unset or `aps_r_ev`: the built-in APS Rate Schedule R-EV
preset, with on-peak 16:00–19:00 Monday to Friday, overnight
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
| `TARIFF_APS_RATES_CONFIRMED` | `false` | `bool` (→ `true`/`false`) | Confirms the rates above come from a bill. While false the tariff table prices nothing (Grid Rate Now reads unknown), and the cost and savings figures use the flat rate (`TARIFF_FLAT_CENTS_PER_KWH`, 17 ¢/kWh when unset). Another plan's `TARIFF_RATES_CONFIRMED` takes this value while it is unset. Fill the rates in first: once confirmed, a period left without a rate (overnight or super-off-peak) is priced at that season's off-peak rate, and every unpriced hour falls back to the flat rate when the season's on-peak or off-peak rate is empty too. |

#### Heartbeat (dead-man's switch)

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `HEARTBEAT_URL` | `""` | `str?` | An https URL from an outside monitoring service. Power sends it a GET every `HEARTBEAT_INTERVAL_S`; when the pings stop (host down, add-on killed, power lost) that service alerts you, from outside everything Power could report on. Empty = off. A value that is not a parseable https URL is rejected, nothing is sent, and the log names the reason. Treat the URL as a secret: only its host is ever logged. |
| `HEARTBEAT_INTERVAL_S` | `300` | `int(60,3600)?` | Seconds between pings, clamped to 60–3600. Set the outside check's period to match, with a grace of about two intervals. |


#### Diagnostic / advanced

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `RECORDER_RETENTION_DAYS` | `30` | `int(7,3650)` | Raw-samples retention in days for the SQLite recorder. Runtime clamps to [7, 3650] and falls back to 30 on a malformed value; the durable night-charge ledger and lifetime totals are never pruned regardless. |
| `ECOFLOW_DEVICE_REACHABILITY` | `""` | `str?` | JSON object mapping a device serial to a Home Assistant ping `binary_sensor` that watches its LAN address, for example `{"<Core 1 serial>":"binary_sensor.core1_lan"}`. It tells a cloud-session wedge (reachable on the LAN) from a real outage; it never changes whether or how loud an alarm is. |
| `WRITE_DEBUG_TOKEN` | `""` | `password?` | When non-empty, unlocks `POST /api/device/send-command`. Default empty = the debug write path is disabled. See [the write-debug lockdown](../reference/12-configuration-deployment-security.md#write-debug-lockdown--post-apidevicesend-command). |

## Your home

These keys describe the site, the tariff, the solar array, EV charging, the devices and the plant
limits. Each is optional and has no default. While a key is unset it is not passed to the
server, and Power keeps the built-in behaviour its Default cell names, which is the reference
plant's. Home Assistant lists them under **Show unused optional configuration options**. What to
measure for each, and where:
[setting Power up for your home](your-home.md).

#### Site and time

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `SITE_TIMEZONE` | unset (behaves as Home Assistant's time zone) | `str?` | The IANA time zone the schedule runs in, for example `Europe/Berlin`: the nightly notice, the charge window, the tariff periods, quiet hours, the morning digest, the daily jobs, and the times shown on the console and on the night-charge, Today and forecast cards. Empty uses the zone the Supervisor passes from Home Assistant, and `America/Phoenix` when there is none. An unknown name raises a repair issue and is ignored. Leave it empty unless the schedule must differ from Home Assistant's zone. The zone is read once at start; one that differs from Home Assistant's raises a warning and a repair issue. |
| `SITE_LOCATION_FROM_HA` | unset (behaves as off: `FORECAST_LAT` / `FORECAST_LON`) | `bool?` | Use Home Assistant's home latitude and longitude for the forecast, the storm alerts, the day/night test and the PV model. Read in the background after a start and saved, it applies from the next start. Off, a repair item warns when Home Assistant's home is more than 50 km from `FORECAST_LAT` / `FORECAST_LON`. |

#### Tariff plan

Left unset, the tariff is the APS R-EV preset above. `TARIFF_PLAN` picks another: `flat` (one rate),
`two_tier` (one on-peak window) or `custom` (a period table). A tariff setting that cannot be read
never falls back to the APS table: every price reads unknown, the cost figures use the flat fallback
rate, the night charge holds, and a repair issue names the option.

A custom plan in the period grammar, written for the APS R-EV schedule:

```
TARIFF_PERIODS  on_peak 16-19 mon-fri all onpeak; super_off_peak 10-15 mon-fri winter; overnight 23-05 mon-fri all cheap
TARIFF_RATES    on_peak=31.2/22.5; off_peak=16.9/15.1; overnight=12.6; super_off_peak=-/8.2
```

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `TARIFF_PLAN` | unset (behaves as `aps_r_ev`) | `list(aps_r_ev\|flat\|two_tier\|custom)?` | The tariff preset. `aps_r_ev` is the APS R-EV table with the `TARIFF_APS_*` rates; `flat` prices every hour at `TARIFF_FLAT_CENTS_PER_KWH`; `two_tier` has one on-peak period, `TARIFF_ON_PEAK_HOURS` on `TARIFF_ON_PEAK_DAYS`, at `TARIFF_ON_PEAK_CENTS`, and every other hour at `TARIFF_OFF_PEAK_CENTS`; `custom` is `TARIFF_PERIODS` with `TARIFF_RATES`. `flat` and `two_tier` have no cheap window, so the night charge holds every night unless `NIGHT_CHARGE_CHEAP_PERIOD` names one. On `two_tier` that can only be `off_peak`, which is every hour outside the on-peak window; each evening plans one night of it, the longest daily run of off-peak hours (with on-peak 14-19, 19:00 to 14:00 the next day, on weekend nights too); to charge at night only, write the plan as `custom` with a night period flagged `cheap` at the off-peak rate. |
| `TARIFF_PERIODS` | unset (behaves as no custom table) | `str?` | The custom plan's periods, separated by semicolons, highest priority first: `id start-end days season`, then `onpeak` and `cheap` where they apply. Hours are local and end-exclusive (`23-05` wraps midnight, `0-24` is a whole day); days are `all`, a day (`mon` … `sun`), a range (`mon-fri`, or `fri-mon` across the weekend) or a comma list; season is `all`, `summer` or `winter`. Every hour no period covers is `off_peak`. Set only with `TARIFF_PLAN` `custom`. |
| `TARIFF_RATES` | unset (behaves as no custom table) | `str?` | The ¢/kWh of each custom period and of `off_peak`: `id=summer/winter`, or `id=rate` for both seasons, with `-` for no rate in a season. Any number counts, 0 included. Every period and `off_peak` needs an entry. Set only with `TARIFF_PLAN` `custom`. |
| `TARIFF_RATES_CONFIRMED` | unset (behaves as `TARIFF_APS_RATES_CONFIRMED`) | `bool?` | Confirms that the rates of the plan in effect come from a bill, whichever plan it is. Until rates are confirmed every price reads unknown, and the cost figures fall back to `TARIFF_ON_PEAK_CENTS` / `TARIFF_OFF_PEAK_CENTS` over the on-peak window when both are above zero (a `two_tier` plan's own rates), otherwise to the flat rate. With `TARIFF_PLAN` set, the dispatch planner (MPC) prices an unconfirmed hour the same way. |
| `TARIFF_FIXED_DAILY_CENTS` | unset (behaves as no fixed charge) | `float?` | The fixed daily basic-service charge in ¢, for reference only (not part of any per-kWh price); shown once the rates are confirmed. |
| `TARIFF_SUMMER_MONTHS` | unset (behaves as `4-9`) | `str?` | The months of use priced at summer rates: a range or a comma list. A range may wrap the year (`10-3` south of the equator). The other months are winter. Every plan. |
| `TARIFF_HOLIDAYS` | unset (behaves as `aps` for `aps_r_ev`, `none` otherwise) | `str?` | The days priced off-peak all day: `aps` (the R-EV holiday rule, computed for any year), `none`, or a comma list of dates written YYYY-MM-DD. |
| `TARIFF_CURRENCY` | unset (behaves as USD) | `str?` | The currency of the rates and cost figures: USD, EUR, GBP, CAD or AUD; rates stay in hundredths of the unit. Changing it changes the unit of the Home Assistant cost and rate sensors (Home Assistant asks once to repair their statistics). An unknown code keeps USD and raises a repair issue. |
| `NIGHT_CHARGE_CHEAP_PERIOD` | unset (behaves as the plan's cheap period) | `str?` | The tariff period the night charge plans and charges in: `overnight` on the APS R-EV plan, the period flagged `cheap` on a custom plan. `off_peak` names every hour no period covers. A period id the plan does not have fails closed: the night charge holds and a repair issue names it. The nightly job's schedule follows the period's hours (see `NIGHT_CHARGE_NOTIFY_HOUR`). |

#### Tariff rates read by every plan

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `TARIFF_FLAT_CENTS_PER_KWH` | unset (behaves as `17`) | `float?` | The flat plan's rate; with any other plan, the fallback ¢/kWh the cost figures use while no confirmed rate prices an hour. |
| `TARIFF_ON_PEAK_CENTS` | unset (behaves as no override) | `float?` | The two-tier plan's on-peak rate. With any other plan, set together with `TARIFF_OFF_PEAK_CENTS` it overrides the cost figures' two-tier pair (a value above zero only). |
| `TARIFF_OFF_PEAK_CENTS` | unset (behaves as no override) | `float?` | The two-tier plan's off-peak rate. With any other plan, the off-peak half of that override. |
| `TARIFF_EXPORT_CENTS_PER_KWH` | unset (behaves as `0`) | `float?` | The credit per kWh exported to the grid, used by the dispatch optimiser. |
| `TARIFF_ON_PEAK_HOURS` | unset (behaves as `15-20`) | `str?` | The two-tier plan's on-peak window, `start-end`, local and end-exclusive. With any other plan, the legacy window the cost figures judge on-peak by while the rates are unconfirmed. |
| `TARIFF_ON_PEAK_DAYS` | unset (behaves as `1-5`) | `str?` | The two-tier plan's on-peak days, `first-last` with 1 = Monday to 7 = Sunday. With any other plan, the legacy window's days. |

#### Solar array

Setting any `PV_*` key moves the PV model from the reference array onto `FORECAST_LAT` /
`FORECAST_LON` (or Home Assistant's home location with `SITE_LOCATION_FROM_HA`).

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `PV_ARRAY_KWP` | unset (behaves as the 16.8 kWp reference array) | `float(0.1,500)?` | Array nameplate in kWp. Sizes the clear-sky physics maximum and the solar learner's noise scale. |
| `PV_TILT_DEG` | unset (behaves as 25°) | `float(0,90)?` | Panel tilt from horizontal, degrees. |
| `PV_AZIMUTH_DEG` | unset (behaves as 180°, due south) | `float(0,360)?` | Panel azimuth, degrees clockwise from north. |
| `PV_STRINGS` | unset (behaves as `hv=10x400,lv=4x400` on every Core) | `str?` | Strings per Core, `hv=<panels>x<watts>,lv=<panels>x<watts>`. Override one Core after a semicolon, keyed by panel slot or Core name: `hv=10x400,lv=4x400; slot2=hv=8x450`; a string the override leaves out keeps the first layout, `hv=0` / `lv=0` is no string. Drives the Solar page; an unreadable value falls back to the default and raises a repair item. A boot warning names a layout that disagrees with `PV_ARRAY_KWP`. |

#### EV charging

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `EV_MAX_LOAD_W` | unset (behaves as 11520) | `int(0,)?` | The most one EV charger draws, in W (48 A at 240 V when unset). Caps each predicted charging session in the load forecast and the projected draw of a session in progress. |
| `EV_CHARGER_COUNT` | unset (behaves as 1) | `int(0,4)?` | EV chargers at the site. 1: overlapping predicted sessions are alternatives and the largest counts. 2–4: they add up, capped at the count × `EV_MAX_LOAD_W`. 0: no charger, so no circuit is treated as EV charging. |
| `EV_PLATEAU_MIN_W` | unset (behaves as 6000) | `int(0,)?` | Average W above which a sustained circuit load is an EV session (separates a Level 2 charger from air conditioners). Lower it for a smaller charger. |
| `EV_CIRCUITS` | unset (behaves as every circuit) | `str?` | SHP2 circuit numbers 1–12 the EV detection scans, comma-separated, e.g. `11,12`. A 240 V circuit is scanned when either channel is listed. A list with no valid number scans every circuit. |

#### Devices

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `BENCH_SPARE_SNS` | unset (behaves as the built-in spare list) | `str?` | Serials of the Cores kept off the panel as bench spares, comma-separated, or `none`. A spare's offline alarm is shown without a sound or a push, and the unit is left out of the pool. When set, it replaces the built-in list rather than adding to it. A unit the panel lists as a connected source is never a spare, and a missing unit is never taken for one. A serial that matches no device raises a repair item. |
| `DEVICE_ALIASES` | unset (behaves as the alias files alone) | `str?` | Display names by serial, as JSON: `{"<serial>":"Core 5"}`. Merged over `/data/device-aliases.json`, which is merged over the image's own file; read at start. A value that is not a JSON object is ignored and raises a repair item. |

#### Plant limits and factors

The defaults were measured on a three-Core reference plant.

| Option / Env | Default | Schema | Purpose |
|--------------|---------|--------|---------|
| `FORCE_CHARGE_KW_PER_CORE` | unset (behaves as 5.5) | `float(0,)?` | kW each connected Core takes into its pack while force-charging. Times the just-in-time start and sizes the planner's automatic charge cap (connected Cores × this, through the charge leg); 0 means the measured 5.5. `ARB_CHARGE_CAP_KW` above 0 still sets the planner cap. While the connected-Core count is unknown, the fixed 10 kW start rate and 7.2 kW cap apply. |
| `RUNWAY_POOL_OVERHEAD_FLOOR_W` | unset (behaves as 270) | `float(0,1500)?` | The Cores' standby consumption the runway adds while the panel reports a pool, in W. 270 was fitted on three Cores; about 90 W per connected Core is a starting point for another pool. |
| `RUNWAY_CORE_OVERHEAD_W` | unset (behaves as 90) | `float(0,500)?` | Standby consumption per connected Core, in W; lifts the overhead above the floor for a pool with more Cores than the floor covers. |
| `BMS_RESEED_MIN_GAP_WH` | unset (behaves as 50000) | `int?` | The gap between the stored lifetime energy totals and the batteries' own counters that re-seeds the totals, in Wh (about one Core's capacity). |
| `CAPACITY_SCALE_MIN` | unset (behaves as 0.8) | `float(0.5,1)?` | Lowest measured capacity ratio (full-charge over nameplate) applied to the panel's energies for the runway, the forecast and the idle-pool check. |
| `FORECAST_NIGHT_START_HOUR` | unset (behaves as 21) | `int(0,23)?` | First hour of the overnight band in which the load forecast is trimmed toward the recently measured load. |
| `FORECAST_NIGHT_END_HOUR` | unset (behaves as 5) | `int(0,23)?` | Last hour of that overnight band. |
| `GRID_CO2_INTENSITY_LB_PER_MWH` | unset (behaves as 1100) | `float?` | Grid carbon intensity for the avoided-CO2 figures, in lb CO2 per MWh. The utility or grid operator publishes the figure for an area. |
| `CYCLING_BASE_WEAR_USD_PER_KWH` | unset (behaves as 0.015) | `float?` | Base battery wear cost per kWh cycled that the MPC weighs against tariff savings, in the tariff's currency (`TARIFF_CURRENCY`; the key keeps its USD name). |
| `OPPORTUNISTIC_LOADS` | unset (behaves as the built-in examples) | `str?` | Loads to suggest when PV would be curtailed: `id:watts:category[:label]` entries, comma-separated, e.g. `pool_pump:1800:pool:Pool pump,water_heater:4500:water`. Category pool, ev, water, hvac or other (other when left out). `none` lists nothing; a value with no valid entry keeps the built-in examples. |
| `BATTERY_SOC_LADDER` | unset (behaves as 50/40/30/20/15/10/8/4/2) | `str?` | SoC alarm levels announced on the way down: `pct:tier` entries, comma-separated, e.g. `50:low,30:medium,15:critical`; tier low, medium, high or critical. A value with no valid entry keeps the built-in ladder (50–30 low, 20–15 medium, 10–2 critical). |
