# Power

Power is a Home Assistant add-on for an EcoFlow off-grid power system: a Smart Home Panel 2 and
its Delta Pro Ultra battery Cores. It reads the system through the EcoFlow cloud and turns it into
a live dashboard, battery and grid alarms that are spoken on your speakers and pushed to your
phone, a day-ahead solar and battery forecast, pack-health tracking and Home Assistant entities.
A night-charge planner sizes an overnight grid charge on a time-of-use tariff; it only advises
unless you allow it to write.

> [!WARNING]
> Power can warn you only while its host, your network, the EcoFlow cloud and your speakers all
> work. If the host loses power or the add-on stops, every alarm Power owns goes quiet with it.
> Set `HEARTBEAT_URL` to an outside monitoring service, which alerts you when Power stops
> checking in, and keep the host on an always-on circuit.

## Scope and requirements

These are limits of the product, not settings:

- **Hardware.** An EcoFlow Smart Home Panel 2 with Delta Pro Ultra Cores. Other EcoFlow devices
  on the account are listed, but only these two have dedicated logic. With two panels, the one on
  the account at first start is the house panel: alarms, sensors and night-charge writes follow
  it, and the role never moves by itself.
- **Connection.** Cloud only, through EcoFlow IoT-Open developer keys. Power polls the cloud
  every minute and follows its MQTT stream. There is no local (LAN) API: when the cloud stops
  answering, Power cannot see the system, and it raises an alarm saying so.
- **Tariff.** The tariff model is APS Rate Schedule R-EV (its periods, seasons and holidays) and
  nothing else. The night-charge planner and the cost figures are built on it.
- **Clock.** Scheduling runs on America/Phoenix time, fixed in the code: the nightly notice, the
  charge window, the tariff periods and the daily jobs. Quiet hours and the morning digest use
  the host's local hour.
- **Optional.** An MQTT broker (for the Home Assistant entities), Music Assistant speakers or
  announce-capable SIP targets (for spoken alarms), and Piper over Wyoming (the voice). Without
  speakers, alarms reach you only as notifications.
- **Host.** A 64-bit Home Assistant OS or Supervised install (aarch64 or amd64).

## What Power changes on your system

Power writes to your EcoFlow devices only through the paths below, each audit-logged with its
outcome. With the default options it writes nothing on its own: a write happens only when you
press a button or make an API request.

| Writer | When it writes | Limits | Off switch |
|---|---|---|---|
| **Backup-reserve setpoint** (night charge) | `NIGHT_CHARGE_MODE` is `supervised` or `auto`, and that evening's notice reached you. Once, at the charge window's open (or up to 30 minutes after), it raises the panel's backup reserve to the plan's setpoint. It restores the earlier value at the window close (an hour before on-peak at the latest), or at once on a cancel or a grid loss; a reserve you set yourself during the night is left as you set it. | 10–50 %, whole numbers, and only above the current reserve. Not while the alarm host is under critical pressure, nor within an hour of on-peak. Read back after each write and re-issued up to twice; a restore that does not take, or is not confirmed 30 minutes after the close, is announced as critical. | `advisory` (the default). **Cancel tonight** on the night-charge card. A reserve already raised is still restored. |
| **Force charge ON/OFF per Core slot** and the panel's **force-charge ceiling** (night charge) | As above, plus `ARB_OBJECTIVE` `cost` and `ARB_COST_MAX_SOC_PCT` above 50, on a night whose reserve write has read back. The ceiling is set to the night's target and restored afterwards. Force charge switches on late in the window, just in time to reach the target, and off at the target, the window close, a cancel or a grid loss. | Panel slots 1–3; ceiling 80–100 %. On only with the grid known present and no slot already on. ON and OFF are read back; a slot that stays on is announced as critical and sent OFF again every 15 minutes. | `ARB_COST_MAX_SOC_PCT` 50, `ARB_OBJECTIVE` `resilience`, or `advisory`. The OFF side keeps running. |
| **Force charge OFF** (Charge Now responder) | `CHARGE_NOW_RESPONSE` is `supervised`, and a Core's Charge Now has been buying grid power on-peak (800 W or more for 10 minutes) with the pool more than 10 points above the reserve. | OFF only, never ON. Once per episode, at most twice a day, read back with one retry. Stands down while a storm pre-charge advisory is active. | `advisory` (the default: a notification only) or `off`. |
| **Reserve floor** (your request) | `POST /api/reserve-floor?pct=N`, through the write gate. | 10–50 %, whole numbers. Refused while a night-charge write holds the reserve up; the refusal says when it is restored. At most 10 an hour. | Do not call it. |
| **Cloud-presence refresh** | The **Refresh cloud** button on the panel's card. | Re-sends the reserve the panel already holds, so nothing changes; refused if that reading is missing or outside 10–50. Once per 30 seconds. | Do not press it. |
| **Raw command** (debugging) | `POST /api/device/send-command` through the write gate, only while `WRITE_DEBUG_TOKEN` is set and the request carries it. | Allow-listed command sets, parameters up to 1 KB, once per 30 seconds per device. | Leave `WRITE_DEBUG_TOKEN` empty (the default). |

With two panels and none pinned as the house panel, Power will not raise the reserve, switch
force charge on, set the ceiling, answer Charge Now or set the reserve floor; restoring a raised
reserve and switching force charge off still run. The dashboard offers the pin.

Power also writes to Home Assistant: notifications (when `NOTIFY_CHANNEL` is `ha`), speaker
announcements (when `BROADCAST_ENABLED` is on), retained MQTT discovery and state messages (when
`MQTT_DISCOVERY_ENABLED` is on), and once a day five external long-term statistics series from
EcoFlow's own daily energy record. The night-charge writes in full:
[the night-charge writes](https://github.com/tesseractAZ/power/blob/main/docs/reference/15-2-night-charge-writes.md).

## Getting started

1. In Home Assistant open **Settings → Add-ons → Add-on Store**, choose **⋮ → Repositories** and
   add `https://github.com/tesseractAZ/power`. Install **Power**. Updates arrive through Home
   Assistant's own update button.
2. Create IoT-Open access and secret keys in the EcoFlow developer portal
   (`developer.ecoflow.com`). On the add-on's **Configuration** tab, enter them as
   `ECOFLOW_ACCESS_KEY` and `ECOFLOW_SECRET_KEY`. Power does not start without both.
3. Set `FORECAST_LAT` and `FORECAST_LON` to your site. The defaults are a placeholder; every
   solar forecast, and so the runway and the night-charge plan, is fetched for these coordinates,
   and day is told from night there while a Core's solar is counted at the panel.
4. Tell Power whether you have a grid connection: `GRID_AVAILABLE` on if you do. Better still,
   name a Home Assistant entity that turns off when the grid drops in `GRID_PRESENCE_ENTITY`. A
   low battery is an emergency only when no grid can carry the house, and the alarms are graded
   on this.
5. Start the add-on and open **Power** in the Home Assistant sidebar. The first readings arrive
   within a minute; forecasts and learned baselines improve over the first days.
6. Turn on phone notifications: `NOTIFY_CHANNEL` to `ha`, and `NOTIFY_HA_PUSH_TARGETS` to your
   phone's notify service, for example `notify.mobile_app_<phone>`.
7. Turn on spoken alarms: `BROADCAST_ENABLED` on, `BROADCAST_TARGETS` to your Music Assistant
   speakers, and a Piper add-on reachable at `BROADCAST_WYOMING_HOST`. The speakers fetch the
   alarm audio from `BROADCAST_AUDIO_BASE` (default `http://homeassistant.local:8787`); if they
   cannot resolve that name, use the host's address. Play a spoken preview from
   **Alerts → Alert Settings**.
8. Set `HEARTBEAT_URL` (see the warning above).
9. Optional: `MQTT_DISCOVERY_ENABLED` and the broker options for Home Assistant entities, and
   `NWS_ENABLED` for US storm warnings.

Saving any option restarts the add-on; its alarms are silent until it is back.

## When you hear an alarm

Power speaks an alarm as a chime and then the words. With a Spanish voice set
(`BROADCAST_WYOMING_VOICE_ES`) and `BROADCAST_BILINGUAL` on, it says them in English and then in
Spanish; otherwise it plays them `BROADCAST_REPEAT` times (default 2). An announcement whose
delivery cannot be confirmed is retried after 30 seconds, 90 seconds and 3 minutes. The charge
levels also show on the dashboard, and the alert behind each is pushed to your phone when it is a
warning or a critical (see `NOTIFY_MIN_SEVERITY`). The Low levels are information only: spoken
and shown, never pushed. The runway's "Projected runtime … to reserve" alert is pushed only
inside 6 hours.

| You hear | It means | Do this |
|---|---|---|
| Advisory, "backup pool at 50 / 40 / 30 percent" (Low, P4) | The pool crossed that charge level on the way down. | Nothing urgent; note the trend. |
| Medium, "at 20 / 15 percent" (P3) | The pool is low. | Cut discretionary loads. |
| Critical, "at 10 / 8 / 4 / 2 percent … restore charge immediately" (P1) | The pool is nearly empty. | Shed load, charge from the grid or a generator. |
| "Projected to reach reserve in about N hours" (Low, or Medium within 6 hours) | The forecast trajectory reaches the reserve before solar recovers. | Reduce consumption. |
| High, "projected to deplete in about N hours … reduce load now" (P2) | Empty within 8 hours on the forecast. | Shed load now. |
| Critical, "projected empty …" or "at the reserve floor … start the generator" (P1) | Empty within 3 hours, or at the reserve with no grid carrying the house. | Shed load; start a generator; check the panel. |
| Advisory, "backup pool at 10 / 8 / 4 / 2 percent … no action needed" (Low, P4) | A near-empty level, with the grid carrying the house. | Nothing. |

Each charge level is spoken once on the way down and re-arms when the pool recovers. A runway
alarm repeats every `BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN` minutes (default 60) while it lasts.
When the grid is carrying the house, the near-empty levels are spoken as a calm advisory and the
runway alarm stays silent; if the grid then drops while the pool is still low, the true priority
is announced.

**Priorities and their switches.** Every alarm has an ISA-18.2 priority: Critical (P1), High
(P2), Medium (P3) or Low (P4). **Alerts → Alert Settings** has one switch per priority, also
published as Home Assistant switches. Off silences that priority's pushes, speech and chime; the
alarm stays visible on the dashboard. Other alarms are spoken only at or above
`BROADCAST_MIN_SEVERITY` (default: critical only); the charge-level and runway alarms above
speak at every priority.

**Quiet hours.** By default `BROADCAST_QUIET_HOURS` silences every spoken alarm and
`NOTIFY_QUIET_HOURS` holds every push, critical included (both `22-06`). Silenced speech is not
played later: a charge level crossed overnight is not spoken in the morning. A runway alarm that
still stands speaks at its next repeat, and a night-charge force charge that will not switch off
is paged again. Held pushes arrive in one morning digest at `NOTIFY_DIGEST_HOUR`. Turn on
`CRITICAL_BREAKS_QUIET_HOURS` to be woken: then a critical push, any critical spoken alarm and a
High runway alarm break through; other High alarms stay silent. The nightly night-charge notice
ignores the push quiet hours.

**The audible channel.** Power probes its speakers. When none can play, "Audible alarm channel
unreachable" is pushed; when some cannot, "Audible alarm channel degraded" names them. Both are
warnings that never break through quiet hours, and both clear when the speakers return. Check
the speakers and Music Assistant.

**The host.** Power watches the machine it runs on:

- **Temperature.** "Alarm host running hot" at 78 °C and "overheating" (critical) at 84 °C,
  read from the kernel. Improve airflow or move the host.
- **Pressure.** "Alarm host under pressure" when event-loop delay, free memory, free data disk
  or load average crosses its line, usually because another add-on is consuming the host. It is
  spoken only after 5 minutes, and becomes critical after 3 minutes at the critical line, when
  Power pauses its optional analytics to protect the alarm path.
- **Power.** "Alarm host power — under-voltage" when the `binary_sensor` named in
  `HOST_POWER_ENTITY` reports it. Check the power supply before the host browns out.

## Alerts and phone notifications

With `NOTIFY_CHANNEL` set to `ha`, every alert at or above `NOTIFY_MIN_SEVERITY` becomes a card
in Home Assistant's notification drawer, dismissed when the condition clears, and a push to each
service in `NOTIFY_HA_PUSH_TARGETS`. Leave the targets empty for drawer cards only. A critical
push carries the companion app's critical payload, so it sounds through Do Not Disturb and the
silent switch (turn that off with `NOTIFY_CRITICAL_BYPASS_DND`); warnings arrive as ordinary
pushes. `NOTIFY_RESOLVED` also pushes when an alert clears. Device serial numbers are shortened in
pushes.

The alert families you are most likely to see:

| Alert | Means | Do this |
|---|---|---|
| Below or near the reserve floor | The pool is at or approaching the panel's backup reserve. | Shed load unless the grid carries the house. |
| Backup pool charge level | One of the charge levels in the alarm table. | As in that table. |
| Running off-grid | No grid is present; the house runs on solar and batteries. Shown on the dashboard, not pushed. | Watch the runway: the battery alarms are now graded with no grid. |
| Device offline, cloud session stale, reserve alarm blind | A Core or the panel stopped reporting, or the EcoFlow session went stale, so an alarm cannot see. Blind while off-grid is critical. | Check the device's Wi-Fi and the EcoFlow app. |
| Cell voltage spread | A pack's cells have drifted apart. A warning is pushed, not spoken; a critical is spoken. | Watch it; a critical one needs EcoFlow support. |
| Temperature | A cell, circuit board or solar charger reads warm or hot, or a pack is too cold to charge at full rate. | Improve ventilation; expect slower charging in the cold. |
| Pack health | State of health is falling, or a pack is confirmed defective. | Export the warranty evidence (below). |
| Charging from the grid on-peak | The batteries are buying grid power at the on-peak rate, usually a Core's Charge Now. | Turn Charge Now off in the EcoFlow app, or see `CHARGE_NOW_RESPONSE`. |
| Setting changed | A panel or Core setting, such as the reserve, changed outside Power (held through quiet hours). | If you made the change, nothing. |
| Storm pre-charge recommended | A National Weather Service warning near your coordinates. | Charge the pool before it arrives. |

Every alert family, its condition and its severity:
[alerts](https://github.com/tesseractAZ/power/blob/main/docs/reference/08-1-alerts.md) and
[the alert monitor](https://github.com/tesseractAZ/power/blob/main/docs/reference/08-2-alert-monitor.md).

## Night charge and other advisories

**Night charge.** Each evening at `NIGHT_CHARGE_NOTIFY_HOUR`:`NIGHT_CHARGE_NOTIFY_MINUTE`
(21:30 America/Phoenix by default) the planner decides whether the next overnight window, 23:00
to 05:00 on Monday to Friday nights, should charge the pool from the grid, and sends one notice. A
Friday window ends at midnight, and a Sunday window starts at midnight. The plan is sized on a
worst case: low solar and high load tomorrow, and the house cut off from the grid, so the pack
still holds the reserve plus an outage cushion (`ARB_OUTAGE_CUSHION_HOURS` of the panel's own
load).

The notice states the charge itself, not the worst case: the level the charge drives the pool to
and the grid energy it is expected to draw from the pool's expected level at the window open, for
example "charging to ~80% tonight (~34.9 kWh)", or "toward" a level the window cannot reach. A
night expected to draw nothing says the reserve is held and no charge is expected; a hold night
says why; a night without a plan says so. The worst case appears once, on the night-charge card,
labelled as the basis the target is sized on, and as the "(Worst Case)" sensors. When the reserve
is restored, a morning summary says what the night did, including whether the force charge ran.

| Mode (`NIGHT_CHARGE_MODE`) | What happens |
|---|---|
| `advisory` (default) | Nothing is written. Use the notice, or automate on the night-charge entities. |
| `supervised` | On a charge night the notice announces the write and is also spoken; the write is armed only if the notice reached you (a notification or the speakers). The panel's reserve is raised at the window open and restored at the close; in cost mode, a just-in-time force charge carries the pool past 50 %. |
| `auto` | Runs exactly as `supervised`. |

To stop a night, press **Cancel tonight** (or **Cancel & revert** once the reserve is raised) on
the night-charge card on the **Strategy** page. To stop all writes, set `NIGHT_CHARGE_MODE` to
`advisory`: a reserve already raised is still restored. To stop only the force charge, set
`ARB_COST_MAX_SOC_PCT` to 50. Change `NIGHT_CHARGE_ADVISOR_ENABLED` only outside a charge night:
turning it off also stops the timer that restores a raised reserve. The planner's write-readiness
gate reports `LEARNING`, `READY_TO_CONSIDER_WRITES` or `BLOCKED` from scored nights on which Power
itself raised the reserve. It needs at least 21, so it never graduates in an install that only
advises; it informs `auto` only and does not hold back `supervised`. Planning in full:
[night-charge planning](https://github.com/tesseractAZ/power/blob/main/docs/reference/15-1-night-charge-planning.md).

**Load shedding.** With `LOAD_SHEDDING_SHED_ENTITIES` listing your sheddable loads, Power
recommends which to switch off when the runway alarm stands at Medium or above and the runway
falls under `LOAD_SHEDDING_RUNWAY_THRESHOLD_H`, and how much runway that buys. It never switches
anything; your automations do.

**Storm pre-charge.** With `NWS_ENABLED`, a National Weather Service warning near your
coordinates raises a "pre-charge recommended" alert advising a full charge before it arrives. It
is advice; while it stands, the Charge Now responder stands down.

**Pack health.** Power tracks each pack's state of health, internal resistance, cell spread and
projected end of life, compares packs with their peers, and keeps a confirmed-defective pack
latched to its serial number. For a warranty claim, open
`http://<host>:8787/api/warranty-export?sn=<Core serial>`: a Markdown bundle of live per-pack and
per-cell data with the alert history (`&format=csv` for the cell grid).

**Lighting posture.** The `ecoflow_lighting_posture` entity tells lighting automations how to
behave: `surplus`, `normal`, `conserve`, `amber`, `red` or `critical`, from the runway's answer
to "will the pool reach sunrise above the reserve?".

## Configuration by goal

Every option, with its default and range, is in
[the option reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/options.md).
Set them on the **Configuration** tab.

| Goal | Options |
|---|---|
| Connect | `ECOFLOW_ACCESS_KEY`, `ECOFLOW_SECRET_KEY`; `ECOFLOW_API_HOST` (try the EU or US host on a 401) |
| Accurate forecasts | `FORECAST_LAT`, `FORECAST_LON` |
| Grid-aware alarms | `GRID_AVAILABLE`, `GRID_PRESENCE_ENTITY`, `GRID_FLOOR_SLACK_PCT` |
| Phone alerts | `NOTIFY_CHANNEL`, `NOTIFY_HA_PUSH_TARGETS`, `NOTIFY_MIN_SEVERITY`, `NOTIFY_CRITICAL_BYPASS_DND`, `NOTIFY_RESOLVED` |
| Spoken alarms | `BROADCAST_ENABLED`, `BROADCAST_TARGETS`, `BROADCAST_SIP_TARGETS`, `BROADCAST_MIN_SEVERITY`, `BROADCAST_VOLUME`, `BROADCAST_WYOMING_*`, `BROADCAST_BILINGUAL` |
| Quiet nights | `NOTIFY_QUIET_HOURS`, `BROADCAST_QUIET_HOURS`, `NOTIFY_DIGEST_HOUR`, `CRITICAL_BREAKS_QUIET_HOURS` |
| Alarm engines | `BATTERY_SOC_ALARM_ENABLED`, `BATTERY_RUNWAY_ALARM_ENABLED`, `BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN` |
| Night charge | `NIGHT_CHARGE_MODE`, `ARB_OBJECTIVE`, `ARB_COST_MAX_SOC_PCT`, `ARB_OUTAGE_CUSHION_HOURS`, `ARB_GRID_INPUT_CAP_KW`, `NIGHT_CHARGE_NOTIFY_HOUR` |
| Cost figures | `TARIFF_APS_*_CENTS`, then `TARIFF_APS_RATES_CONFIRMED` |
| Out-of-band alarm | `HEARTBEAT_URL`, `HEARTBEAT_INTERVAL_S` |
| Home Assistant entities | `MQTT_DISCOVERY_ENABLED`, `MQTT_DISCOVERY_HOST`, `MQTT_DISCOVERY_USER`, `MQTT_DISCOVERY_PASS` |
| Charge Now on-peak | `CHARGE_NOW_RESPONSE` |
| Host health | `HOST_POWER_ENTITY` |

Until `TARIFF_APS_RATES_CONFIRMED` is on, the cost and savings figures use a flat 17 ¢/kWh.

## Entities and Energy Dashboard

With MQTT discovery on, Power publishes about 90 sensors and binary sensors under one device,
**EcoFlow Panel**, plus an energy and a power sensor for each panel circuit and four
alarm-priority switches.
Every entity, its unique_id, meaning and unit:
[the entity reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/entities.md).

- **Energy Dashboard.** Solar: `ecoflow_pv_lifetime_kwh`. Grid consumption:
  `ecoflow_grid_to_home_lifetime_kwh`. Battery: `ecoflow_battery_charge_lifetime_kwh` (in) and
  `ecoflow_battery_discharge_lifetime_kwh` (out). Give each source its power sensor too, or the
  dashboard's Now view gets consumption wrong. Each circuit's energy sensor can be an individual
  device.
- **A Core with no reading of its own** (offline in the cloud, or its readings stopped). Its
  battery and solar energy, and its share of Fleet PV and Battery Net, are counted from the
  panel's meter on its slot, so the counters keep rising. In daylight the two power sensors read
  unknown until the panel's solar reading has been checked against the Core's charge; the log
  states each check. When the Core reports again, the jump in its own counters is absorbed, not
  booked in one hour. Once energy has been counted this way, do not go back to a release that
  does not count it: Home Assistant would book the battery energy it drops as a negative hour, or
  as a meter reset ([the energy bridge](https://github.com/tesseractAZ/power/blob/main/docs/reference/07-energy-and-cost.md#22-the-two-accumulation-paths)).
- **Gap-free history.** Each morning Power imports EcoFlow's own daily energy record into Home
  Assistant's statistics as series named "(EcoFlow ledger)"; pick those for history without the
  gaps restarts leave.
- **Automations.** `ecoflow_night_charge_recommended`, `ecoflow_load_shed_recommended`,
  `ecoflow_off_grid` and `ecoflow_lighting_posture` are the usual hooks.
- **Names.** Home Assistant names an entity once, when it first appears, and keeps that
  entity_id; find an entity by its unique_id.

## Dashboard and console

Open **Power** in the Home Assistant sidebar. The dashboard has five pages:

- **Dashboard**: the runway, the energy flow, today's summary, the panel and every Core, and the
  forecast.
- **Solar**: per-Core solar, the solar response model, curtailment and the solar forecast.
- **Battery**: every pack's state, and the battery projection and diagnostics.
- **Strategy**: the night-charge card (with its cancel button), forecast and storm preparation,
  and maintenance, including the database snapshot.
- **Alerts**: active, learned and cleared alerts, and **Alert Settings**: the broadcast switch,
  one card per priority with its switch, tone and spoken preview, and the tone library.

On your LAN the dashboard is also at `http://<host>:8787`. The control-room console is in the
browser at `http://<host>:8787/console`, and over telnet on `TELNET_PORT` (2323) once
`TELNET_ENABLED` is on; it displays and writes nothing. Set `TUI_PASSWORD` to require a login.
[User interfaces](https://github.com/tesseractAZ/power/blob/main/docs/reference/11-user-interfaces.md)
describes both.

## Access and security

- Port 8787 is published on your network and is meant for a trusted network only. Reading (the
  dashboard and the read API) needs no login.
- Every write and every admin request needs one of: Home Assistant's sidebar (ingress), the
  dashboard's own origin, or the `X-Panel-Write-Token` header carrying the token Power creates
  on first start in `/data/panel-write-token.txt`.
- The origin condition is not a login. It stops a web page on another site from writing through
  a browser, but any program on your network can send that origin and write, including turning
  the alarm-priority switches off. Keep untrusted devices off the host's network, and reach Power
  from outside it only through Home Assistant, which asks for its own login.
- `TUI_TRUSTED_ORIGINS` adds exact browser origins to the dashboard's own; a listed origin
  passes the write gate without a token.
- The telnet console is unencrypted and off by default.
- `WRITE_DEBUG_TOKEN` stays empty unless you are debugging a device command.
- The add-on runs under an AppArmor profile and asks the Supervisor only for a read-only add-on
  list. Every device write is recorded in `/data/writes.log` (`GET /api/writes/log`, through the
  write gate).

How writes are authorised:
[trust boundary and network exposure](https://github.com/tesseractAZ/power/blob/main/SECURITY.md#trust-boundary-and-network-exposure).
The full posture and how to report a vulnerability:
[security policy](https://github.com/tesseractAZ/power/blob/main/SECURITY.md).

## Data and backups

Power keeps its history in SQLite at `/data/ecoflow.db`. `RECORDER_RETENTION_DAYS` (default 30,
7–3,650) bounds the raw samples; the night-charge ledger and the lifetime energy totals are never
pruned. Home Assistant backups include it while Power keeps running: just before the copy Power
pauses the database's background tidy-up, and resumes after (on its own after 10 minutes if the
backup never reports back). **Refresh snapshot** on the Strategy page writes a consistent copy
to `/share/ecoflow-panel/` for an outside SQLite viewer. Power records a device only while it
reports fresh readings. Readings that earlier versions saved while a device was offline in the
EcoFlow cloud, its last reading repeated as if new, are moved to a separate table in the same
database: kept, not deleted, and not used for history, learning or scoring.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The add-on stops right after starting | An EcoFlow key is empty. | Enter both keys; the log says they must be set. |
| No devices; the log shows a 401 | The keys belong to another EcoFlow region. | Set `ECOFLOW_API_HOST` to `https://api-e.ecoflow.com` (EU) or `https://api-us.ecoflow.com` (US). |
| No push on the phone | `NOTIFY_CHANNEL` is `none`, or `NOTIFY_HA_PUSH_TARGETS` is empty. | Set both; check the notify service name under Developer tools. |
| Nothing is spoken | Broadcast off, no targets, quiet hours, or the speakers cannot reach `BROADCAST_AUDIO_BASE`. | Check those, then play a spoken preview from Alert Settings. |
| Alarms are silent overnight | Quiet hours silence every tier. | Turn on `CRITICAL_BREAKS_QUIET_HOURS`. |
| Low-battery alarms on a grid-tied home | Power does not know the grid is there. | Set `GRID_AVAILABLE` and `GRID_PRESENCE_ENTITY`. |
| No Home Assistant entities | MQTT discovery is off or cannot reach the broker. | Set `MQTT_DISCOVERY_ENABLED` and the broker options; check the log. |
| Entities read unavailable | The add-on is stopped or its state messages stopped. | Check the add-on and broker logs. |
| Circuit entities missing | They appear once the first poll lists the circuits. | Wait a minute after start. |
| History shows a gap for a device | The EcoFlow cloud listed it offline, so Power had no fresh reading and recorded nothing. After 6 hours in which the other devices kept reporting, a "Device telemetry gap" warning is pushed. | Check the device's Wi-Fi and the EcoFlow app; recording resumes with its first reading. |
| The supervised night charge was not armed | The notice reached no channel, or arming was refused. | Set `NOTIFY_CHANNEL` to `ha`; the card and the notice name the reason. |
| Cost figures look flat | The tariff is not confirmed. | Enter the rates, then `TARIFF_APS_RATES_CONFIRMED`. |
| "Setting changed" notification | A setting was changed outside Power, usually in the EcoFlow app. | Confirm the change was yours. |
| An API write returns 401 | The request has no write authority. | Use the sidebar, or send `X-Panel-Write-Token`. |
| Heartbeat monitor reports down | Power stopped checking in. The host, the add-on or its power is down, so no alarm of Power's is running; or the internet link is down, so Power cannot reach the EcoFlow cloud either. Less often, a changed URL was rejected. | Check the batteries and the panel in the EcoFlow app now, then the host and the add-on. If Power is running, use an https URL; the log names a rejection. |

## More documentation

- [The option reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/options.md)
  and [the entity reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/entities.md).
- [The engineering reference](https://github.com/tesseractAZ/power/blob/main/docs/reference/README.md):
  how every engine works. An old link to a heading of the single-file manual now opens this
  page; the
  [moved sections](https://github.com/tesseractAZ/power/blob/main/docs/reference/README.md#moved-sections)
  table says where each heading went.
- What changed in each release: [the changelog](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG.md)
  and [the releases](https://github.com/tesseractAZ/power/releases), with a printable manual
  attached to each.
- Questions and bugs: [issues](https://github.com/tesseractAZ/power/issues).
