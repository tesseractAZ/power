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
