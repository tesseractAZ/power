# EcoFlow Panel

A local "control-room" dashboard and telnet TUI for an EcoFlow off-grid home
(Smart Home Panel 2, Delta Pro Ultras, smaller UPS units, EV charger).

## What it does

- Connects to your EcoFlow IoT Open API account (HMAC-SHA256-signed REST plus
  MQTT live telemetry) and projects raw quotas into compact per-device shapes.
- Persists time-series readings to a local SQLite database (`/data/ecoflow.db`),
  with deduplicated writes that keep size manageable over months of history.
- Serves a React dashboard with live power-flow, per-DPU detail, solar/PV
  forecast, alerts, and a deep predictive-insights tab — including a per-pack
  capacity-fade → end-of-life projection with an honest confidence band.
- Exposes a telnet TUI on port 2323 — a 9-screen "nuclear control room" view
  built to look right at 80×24 and adapt larger.

## Setup

1. **Get IoT Open API keys.** Sign in at
   [developer.ecoflow.com](https://developer.ecoflow.com) → IoT Open Platform
   → User Information → generate access + secret keys.
2. In this add-on's **Configuration** tab, paste your `ECOFLOW_ACCESS_KEY`
   and `ECOFLOW_SECRET_KEY`. Leave `ECOFLOW_API_HOST` as the default unless
   your account routes to a regional host (`api-e.ecoflow.com` for the EU,
   `api-us.ecoflow.com` for North America).
3. (Optional) set `FORECAST_LAT` / `FORECAST_LON` to your location for the
   solar/load day-ahead forecast. Defaults are Phoenix, AZ.
4. (Optional) configure push notifications. `ntfy` is free, requires no
   account, and just needs a private topic name.
5. **Start** the add-on. The dashboard appears at
   `http://<your-ha-host>:8787/`. Telnet TUI:
   `nc <your-ha-host> 2323` (or any telnet client).

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `ECOFLOW_ACCESS_KEY` | _(required)_ | From the EcoFlow developer portal. |
| `ECOFLOW_SECRET_KEY` | _(required)_ | Same. |
| `ECOFLOW_API_HOST` | `https://api-a.ecoflow.com` | Try `api-e` or `api-us` if `api-a` returns 401. |
| `LOG_LEVEL` | `info` | One of `trace` / `debug` / `info` / `warn` / `error` / `fatal`. |
| `FORECAST_LAT`, `FORECAST_LON` | Phoenix, AZ | Used by the day-ahead solar/load forecast (Open-Meteo). |
| `TELNET_ENABLED` | `true` | Disable to skip the TUI server. |
| `TELNET_PORT` | `2323` | Container-side port. Re-map via the Network tab. |
| `NOTIFY_CHANNEL` | `none` | `ntfy` / `pushover` / `webhook` to enable pushes. |
| `NOTIFY_MIN_SEVERITY` | `warning` | `warning` (warning + critical) or `critical` only. |
| `NOTIFY_RESOLVED` | `true` | Also notify when an alert clears. |
| `NOTIFY_NTFY_SERVER`, `NOTIFY_NTFY_TOPIC` | — | ntfy server + private topic. |
| `NOTIFY_PUSHOVER_TOKEN`, `NOTIFY_PUSHOVER_USER` | — | Pushover credentials. |
| `NOTIFY_WEBHOOK_URL` | — | Generic JSON POST. |

## Persistence

SQLite history lives at `/data/ecoflow.db`, on the HA persistent volume that
survives add-on rebuilds and Home Assistant OS updates. The database is
write-deduplicated (no more than once per 10s per metric; heartbeat every 5
minutes if unchanged), so months of history stay manageable.

## Data flow

```
EcoFlow Cloud  ──REST poll (60 s)─┐
                                  ├─► snapshot store ─► /api/snapshot
                                  │                  └─► /ws (push to web)
EcoFlow MQTT  ──live telemetry────┘
                                            │
                                            └─► SQLite recorder ─► history queries,
                                                                  learned alerts,
                                                                  forecast, EOL
```

## Home Assistant entities

The add-on exposes a flat key-value endpoint at `/api/ha-state` that's
designed for HA's [`rest:` integration](https://www.home-assistant.io/integrations/rest/).
One HTTP call returns everything worth surfacing as an HA sensor — live
power flow, backup pool, day-ahead forecast, per-pack degradation
summary, alert counts, off-grid status.

**Paste this into your `configuration.yaml`** (or a `packages/*` file),
then **Settings → Developer Tools → YAML → "All YAML configuration"
→ Restart** (or just restart HA):

```yaml
rest:
  - resource: http://homeassistant.local:8787/api/ha-state
    scan_interval: 30
    timeout: 10
    sensor:
      - name: "EcoFlow Backup Pool"
        unique_id: ecoflow_backup_pool_percent
        value_template: "{{ value_json.backup_pool_percent }}"
        unit_of_measurement: "%"
        device_class: battery
        state_class: measurement
        icon: mdi:battery-high

      - name: "EcoFlow Backup Remaining"
        unique_id: ecoflow_backup_remaining_kwh
        value_template: "{{ value_json.backup_remaining_kwh }}"
        unit_of_measurement: kWh
        device_class: energy_storage
        state_class: measurement

      - name: "EcoFlow Solar Now"
        unique_id: ecoflow_solar_now_watts
        value_template: "{{ value_json.fleet_pv_watts }}"
        unit_of_measurement: W
        device_class: power
        state_class: measurement
        icon: mdi:solar-power

      - name: "EcoFlow Panel Load"
        unique_id: ecoflow_panel_load_watts
        value_template: "{{ value_json.panel_load_watts }}"
        unit_of_measurement: W
        device_class: power
        state_class: measurement
        icon: mdi:home-lightning-bolt

      - name: "EcoFlow AC Import"
        unique_id: ecoflow_ac_import_watts
        value_template: "{{ value_json.ac_import_watts }}"
        unit_of_measurement: W
        device_class: power
        state_class: measurement
        icon: mdi:transmission-tower

      - name: "EcoFlow Battery Net"
        unique_id: ecoflow_battery_net_watts
        value_template: "{{ value_json.fleet_battery_net_watts }}"
        unit_of_measurement: W
        device_class: power
        state_class: measurement
        icon: mdi:battery-charging

      - name: "EcoFlow Solar Forecast 24h"
        unique_id: ecoflow_solar_forecast_24h_kwh
        value_template: "{{ value_json.forecast_pv_next_24h_kwh }}"
        unit_of_measurement: kWh
        device_class: energy
        state_class: measurement
        icon: mdi:solar-power-variant

      - name: "EcoFlow Projected Low SoC"
        unique_id: ecoflow_projected_low_soc
        value_template: "{{ value_json.projected_low_soc_percent }}"
        unit_of_measurement: "%"
        device_class: battery
        state_class: measurement
        icon: mdi:battery-low

      - name: "EcoFlow Soonest EOL"
        unique_id: ecoflow_soonest_eol_years
        value_template: "{{ value_json.degradation_soonest_eol_years }}"
        unit_of_measurement: yr
        state_class: measurement
        icon: mdi:battery-alert-variant-outline

      - name: "EcoFlow Critical Alerts"
        unique_id: ecoflow_critical_alerts
        value_template: "{{ value_json.alert_critical_count + value_json.learned_critical_count }}"
        state_class: measurement
        icon: mdi:alert-circle

      - name: "EcoFlow Warning Alerts"
        unique_id: ecoflow_warning_alerts
        value_template: "{{ value_json.alert_warning_count + value_json.learned_warning_count }}"
        state_class: measurement
        icon: mdi:alert

      - name: "EcoFlow Peer-Outlier Packs"
        unique_id: ecoflow_peer_outlier_packs
        value_template: "{{ value_json.degradation_peer_outliers }}"
        state_class: measurement
        icon: mdi:battery-sync

      - name: "EcoFlow Soiling Drop"
        unique_id: ecoflow_soiling_drop_percent
        value_template: "{{ value_json.soiling_drop_percent }}"
        unit_of_measurement: "%"
        state_class: measurement
        icon: mdi:weather-dust

    binary_sensor:
      - name: "EcoFlow Off-Grid"
        unique_id: ecoflow_off_grid
        value_template: "{{ value_json.off_grid }}"
        device_class: connectivity
        icon: mdi:transmission-tower-off
```

### Example automations

```yaml
automation:
  - alias: "EcoFlow: backup pool low"
    trigger:
      - platform: numeric_state
        entity_id: sensor.ecoflow_backup_pool
        below: 25
        for: "00:05:00"
    action:
      - service: notify.mobile_app_YOUR_PHONE   # rename to your device
        data:
          title: "EcoFlow backup low"
          message: "Backup pool at {{ states('sensor.ecoflow_backup_pool') }}%."

  - alias: "EcoFlow: critical alert"
    trigger:
      - platform: numeric_state
        entity_id: sensor.ecoflow_critical_alerts
        above: 0
    action:
      - service: notify.mobile_app_YOUR_PHONE
        data:
          title: "EcoFlow critical alert"
          message: "{{ states('sensor.ecoflow_critical_alerts') }} critical alert(s) — open the dashboard."

  - alias: "EcoFlow: projected SoC dip below reserve"
    trigger:
      - platform: numeric_state
        entity_id: sensor.ecoflow_projected_low_soc
        below: 20
    action:
      - service: notify.mobile_app_YOUR_PHONE
        data:
          title: "EcoFlow forecast warning"
          message: "Day-ahead forecast projects SoC down to {{ states('sensor.ecoflow_projected_low_soc') }}%."
```

### URL alternatives

- `http://homeassistant.local:8787` — the LAN-accessible address (works from
  any device on your network, requires mDNS/Avahi for `.local` lookup).
- `http://YOUR-HA-IP:8787` — works without mDNS.

### Full field reference

Every key returned by `/api/ha-state`:

| Field | Type | Notes |
| --- | --- | --- |
| `generated_at` | epoch ms | When the snapshot was assembled |
| `fleet_pv_watts` | W | Sum across online DPUs |
| `fleet_total_in_watts` | W | Charging power into DPUs |
| `fleet_total_out_watts` | W | Discharging power out of DPUs |
| `fleet_battery_net_watts` | W | `out − in`; positive = discharging |
| `panel_load_watts` | W | Sum of SHP2 circuit loads |
| `ac_import_watts` | W | Grid import via SHP2-bound DPUs only |
| `off_grid` | bool | `true` when `ac_import_watts < 5` |
| `backup_pool_percent` | % | SHP2 backup-pool SoC |
| `backup_reserve_percent` | % | SHP2 reserve-floor setting |
| `backup_full_capacity_kwh` | kWh | SHP2 full backup-pool capacity |
| `backup_remaining_kwh` | kWh | SHP2 backup-pool remaining energy |
| `backup_charge_minutes` | min | Estimated minutes to fully charge |
| `backup_discharge_minutes` | min | Estimated minutes to depletion |
| `forecast_pv_next_24h_kwh` | kWh | Day-ahead solar forecast |
| `typical_pv_per_day_kwh` | kWh | Typical-day baseline |
| `projected_low_soc_percent` | % | Forecast minimum SoC over next 24h |
| `projected_low_soc_at` | epoch ms | When the low is projected |
| `forecast_history_days` | days | Depth of history behind the forecast |
| `forecast_has_weather` | bool | `true` when Open-Meteo data was used |
| `soiling_drop_percent` | % | Clear-sky output drop vs cleanest day |
| `degradation_packs_total` | int | Total packs in the fleet |
| `degradation_packs_projecting` | int | Packs with a real fade trend |
| `degradation_soonest_eol_years` | yr | Soonest projected EOL across the fleet |
| `degradation_soonest_eol_date` | epoch ms | Same, as a date |
| `degradation_soonest_eol_pack` | string | Which pack is soonest (e.g. `Core 3 · Pack 2`) |
| `degradation_peer_outliers` | int | Packs fading abnormally fast vs siblings |
| `alert_critical_count` | int | Threshold-rule critical alerts |
| `alert_warning_count` | int | Threshold-rule warnings |
| `alert_info_count` | int | Threshold-rule info notices |
| `learned_critical_count` | int | Learned-engine critical alerts |
| `learned_warning_count` | int | Learned-engine warnings |
| `learned_info_count` | int | Learned-engine info notices |
| `fleet_devices_total` | int | Total devices known on the account |
| `fleet_devices_online` | int | Currently online |

## Troubleshooting

- **"Missing required env var: ECOFLOW_ACCESS_KEY"** — set the key in the
  add-on **Configuration** tab → Save → Restart.
- **`401` from `api-a.ecoflow.com`** — switch `ECOFLOW_API_HOST` to
  `api-e.ecoflow.com` (EU) or `api-us.ecoflow.com` (US).
- **Dashboard loads, devices don't appear** — check the add-on **Log** tab.
  MQTT may still be warming up; the REST poll usually fills the snapshot
  within 15–60 seconds.
- **Telnet refuses connection** — confirm `TELNET_ENABLED` is on and port
  2323 is exposed in the **Network** tab.
- **PV forecast tab says "no history yet"** — the learned solar-response model
  needs a handful of clear-sky daylight hours of recorded PV before it can
  fit. Give it a day, then revisit.
