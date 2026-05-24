# Changelog

All notable changes to this add-on are listed here. Versioning follows
[Semantic Versioning](https://semver.org).

## 0.5.1 — 2026-05-23

Patch fix — web UI / API now binds dual-stack, mirroring v0.3.1's telnet fix.

- `config.ts` + run script: changed the Fastify `HOST` default from
  `0.0.0.0` (IPv4 only) to `::` (Node dual-stack). macOS resolves
  `homeassistant.local` to both an IPv4 and several IPv6 addresses with
  IPv6 listed first; browser happy-eyeballs would race both, the IPv6
  connect would RST against the unbound v6 listener inside the
  add-on's port mapping, and `http://homeassistant.local:8787/` would
  stall or fail. Verified `curl -6 http://homeassistant.local:8787/api/health`
  returned HTTP 000 in ~13ms (TCP RST) while `-4` returned HTTP 200.
  With `::`, both protocols land on the same Fastify listener.

## 0.5.0 — 2026-05-23

### Features — Battery longevity v2

- **Temperature-corrected SoH fade (Arrhenius).** Each projecting or
  stable pack now reports `avgPackTempC` (across the SoH regression
  window), the resulting Arrhenius factor, the **calendar fade
  re-expressed at the 25 °C reference**, and an estimated
  **years-of-life-gained-if-cooled-5 °C** number. Three new fact-tiles
  per pack in the degradation card; the per-pack summary sentence
  appends the Arrhenius note when the data supports it. Direct answer
  to "would moving these to a cooler garage save me X years?" for
  Phoenix-class climates.

- **Round-trip efficiency, rolling 7-day.** Integrates per-pack input
  vs output watts across all DPUs over the last 7 days; ratio shows in
  a new tile on the degradation-card header and as the
  `ecoflow_round_trip_efficiency` HA sensor. Healthy LFP sits 95–97%;
  a slow drift down is the cleanest "the whole stack is aging" signal
  that no single-pack metric catches. Cached 5 min.

### Features — Operational

- **Live off-grid runway.** New prominent card at the top of the
  Dashboard: hours to reserve and hours to empty, projected hour-by-hour
  from the last-hour panel load and the next-24-hour forecast PV.
  Headline colour shifts **red < 4h / amber < 12h / neutral ≥ 12h**.
  Also surfaces the clock times ("Reserve floor reached around Sat
  9 PM") and a breakdown of the assumptions (backup now, reserve floor,
  recent load, forecast PV vs load over the horizon). Exposed as
  `ecoflow_runway_to_reserve_hours` and `ecoflow_runway_to_empty_hours`
  HA sensors. Cached 60 s.

### API

- **`/api/runway`** — RunwayProjection.
- **`/api/round-trip-efficiency?days=N`** — RoundTripEfficiency (days
  capped 1–30, default 7).
- **`/api/ha-state`** gains `runway_to_reserve_hours`,
  `runway_to_empty_hours`, `runway_recent_load_watts`,
  `runway_forecast_pv_used_kwh`, `round_trip_efficiency_percent`,
  `round_trip_charged_kwh_7d`, `round_trip_discharged_kwh_7d`.

### Docs / roadmap

- DOCS.md HA snippet adds three new sensors (runway-to-reserve,
  runway-to-empty, round-trip-efficiency). Total: 17 sensors + 1
  binary_sensor.
- README roadmap expanded to a multi-release plan (v0.6.0 anomaly
  engine v2, v0.7.0 sharper forecasts, v0.8.0+ pattern detection with
  history, plus external-integration and standing buckets).

## 0.4.0 — 2026-05-23

### Features

- **Per-circuit multi-day kWh comparison on the circuit modal.** Click
  any SHP2 circuit on the Dashboard → in addition to the live "now",
  "peak (24h)", "average (24h)", "today" tiles and the 24h watt chart,
  there's a new **Last 7 days** panel: a bar chart of daily kWh totals
  for the past week, with **today highlighted in accent** as a partial /
  running total, the **peak day color-coded amber**, days with no data
  rendered dim, and a **dashed reference line at the 7-day average**.
  Hovering any bar shows that day's total kWh, peak watts, when the
  peak hit, and a "partial day" caveat for incomplete windows. Three
  summary tiles below the chart: average per day (with "N/7 days w/
  data" coverage note), peak day, and quietest day.

- **New `/api/circuit/history?sn=<SN>&ch=<N>&days=<N>` endpoint.**
  Returns per-day trapezoidal kWh + peak watts + peak timestamp +
  coverage, plus a summary block (average, peak day, min day). Day
  windows are local-midnight to next local-midnight (or `now` for the
  in-progress day). Days capped at 30 to keep recorder queries bounded;
  default is 7.

## 0.3.1 — 2026-05-23

Patch fix for the telnet TUI over `homeassistant.local`.

- **Telnet binds dual-stack** — changed the `TELNET_HOST` default from
  `0.0.0.0` (IPv4 only) to `::` (Node dual-stack: listens on both IPv4
  and IPv6 on one socket; Node leaves `IPV6_V6ONLY` off so IPv4 clients
  still connect via mapped addresses). macOS resolves
  `homeassistant.local` to both an IPv4 and several IPv6 addresses with
  IPv6 listed first; `getaddrinfo` (which `nc`/`telnet`/`python socket`
  all use) picks IPv6, so `nc homeassistant.local 2323` was reaching the
  HA host's IPv6 stack — which had no listener for the add-on's port —
  and the TCP handshake completed only to be immediately RST'd
  ("Connection reset by peer"). The IPv4 path always worked
  (`nc -4 hostname`, or `nc <IP>`) but it wasn't discoverable. With `::`,
  both protocols land on the same telnet listener.

## 0.3.0 — 2026-05-23

### Features

- **Home Assistant entities integration** — new `/api/ha-state` endpoint
  returns a flat key-value JSON designed for HA's `rest:` integration. One
  HTTP call surfaces ~13 sensors + 1 binary_sensor (backup pool %, panel
  load, AC import, off-grid status, day-ahead forecast, soonest-EOL pack,
  alert counts, peer-outlier count, etc.). Forecast + degradation are
  reused from their internal caches, so HA polling every 30s is
  essentially free. See `DOCS.md` → "Home Assistant entities" for the
  copy-pasteable `configuration.yaml` snippet and example automations
  (backup-pool-low, critical-alert, projected-SoC-dip).

### Chores

- `dependabot.yml`: ignore major version bumps. The first batch of
  Dependabot PRs was all majors (React 18→19, Tailwind 3→4, TS 5→6,
  Vite 6→8, Fastify ecosystem majors, Node 22→26) — each one needed
  deliberate migration work, none was auto-mergeable. All seven closed;
  going forward only minor/patch updates auto-PR.

- README: moved "HA service integration" from Roadmap to Phase 7
  (shipped). Dropped the "Pre-built multi-arch GHCR images" roadmap line
  (shipped in Phase 6). New roadmap entry: MQTT discovery for HA
  entities, to auto-register sensors without a YAML snippet.

## 0.2.3 — 2026-05-22

Runtime fix for the start crash loop.

- `config.yaml`: added `init: false`. HA's `init: true` default wraps the
  container with Docker's tini, making tini PID 1. The HA base image
  already ships its own s6-overlay `/init`; with tini in front, the
  base's `s6-overlay-suexec` saw it wasn't PID 1 and refused to start,
  producing the crash-loop log:
  ```
  s6-overlay-suexec: fatal: can only run as pid 1
  ```
  Setting `init: false` disables tini so our `/init` (s6) runs as PID 1 —
  the standard pattern for any add-on built on the official HA base
  images.

## 0.2.2 — 2026-05-22

Schema fix for the Configuration → Save flow.

- `config.yaml`: relaxed the schema for `NOTIFY_NTFY_SERVER` and
  `NOTIFY_WEBHOOK_URL` from `url?` to `str?`. Voluptuous (HA's schema
  validator) treats `url?` as "may be absent **or** a valid URL" — but
  both fields ship with empty defaults that only get filled when the
  matching `NOTIFY_CHANNEL` is in use. With the strict `url?` type, the
  first **Save** always failed with `Failed to save: expected a URL.
  Got {…}` (voluptuous dumps the whole options dict instead of the
  failing path). The runtime notify code validates each URL at the
  moment it actually uses the channel, so the schema relaxation is safe.

## 0.2.1 — 2026-05-22

Patch fix for two issues that hit on the first `v0.2.0` push.

- **Dockerfile multi-stage ARG**: moved `ARG BUILD_FROM` (and the other
  `BUILD_*` args) to the **global scope** (above every `FROM`) so the
  runtime stage's `FROM ${BUILD_FROM}` substitutes correctly. Declared
  inside the previous stage, `BUILD_FROM` was scoped to that stage and
  evaluated to empty in the runtime `FROM`, so the docker smoke build
  (CI) and `Publish images` (on tag) both failed instantly with
  `ERROR: failed to build: failed to solve: base name (${BUILD_FROM})
  should not be blank`.
- **`server/src/telnet/server.ts`**: cast the socket `data` event payload
  to `Buffer` at the call site. `@types/node` ≥ 22.19 narrowed the event
  payload to `string | Buffer`, and the inner `onData(data: Buffer)`
  signature rejected the union. (Local working tree had `@types/node@22.10`
  cached, so it only surfaced when CI's fresh `npm ci` pulled the latest
  patch.) The runtime never sets a socket encoding, so the cast is
  type-only — no behavior change.

## 0.2.0 — 2026-05-22

### Distribution
- **Pre-built multi-arch images on GHCR** (aarch64 + amd64). Installing this
  version on the Pi pulls a ready-made image instead of building the
  container from source — install time drops from minutes to seconds, and
  the Pi stops having to do `npm ci` over a slow connection.
- `config.yaml` now declares
  `image: ghcr.io/tesseractaz/{arch}-ecoflow-panel`; HA Supervisor substitutes
  `{arch}` with the host's CPU architecture.

### CI / release pipeline
- **Docker smoke build in CI** (`ci.yml`) — every push and PR builds the
  container (amd64, cached) so a broken Dockerfile is caught before it
  reaches the Pi.
- **Split release flow** — `release.yml` cuts the tag and pushes; the new
  `images.yml` workflow takes over on tag push, builds + pushes amd64 and
  aarch64 images to GHCR in parallel, then creates the GitHub Release. **The
  Release appearing on GitHub is now the "go ahead and update" signal.**
- **Dependabot** configured for npm (server + web), GitHub Actions, and the
  Dockerfile base images — weekly Monday PRs, grouped by production /
  development to cut PR noise.

### Notes
- One-time setup after the first `images.yml` run: open
  <https://github.com/tesseractAZ?tab=packages>, find `amd64-ecoflow-panel` and
  `aarch64-ecoflow-panel`, and change each from Private → Public so HA
  Supervisor can pull anonymously.

## 0.1.0 — 2026-05-22

Initial Home Assistant add-on release. Packages the existing EcoFlow Panel app
(Fastify + Vite/React + telnet TUI) as a single supervised container that runs
on a Raspberry Pi or any 64-bit Home Assistant host.

### Features
- **Live dashboard** at `http://<ha-host>:8787/` — energy-flow diagram, today's
  totals, day-ahead forecast, per-DPU detail, SHP2 backup pool + circuits.
- **Solar page** — fleet PV, per-DPU MPPT HV/LV detail, equipment-tuned
  response model, 24h production chart. Renders 10-panel HV + 4-panel LV
  strings per array DPU.
- **Battery page** — fleet pack table, hottest-pack flag, full per-pack thermal
  and electrical detail.
- **Predictive Insights** — anomalies (peer-comparison, self-baseline),
  forecast alerts (runtime, low-solar, low-SoC dip, soiling), and a deep
  per-pack **capacity-fade → end-of-life projection** with regression-derived
  confidence band, cycle intensity, fade-per-100-cycles, lifetime throughput,
  and a fleet peer-outlier flag.
- **Telnet control-room TUI** on port 2323 — 9 screens, NAWS-adaptive, with
  the same EOL projection surfaced inline on the Battery screen.
- **Alerts & history** — threshold + learned alerts, cleared-anomaly log
  persisted in memory, optional **ntfy / Pushover / webhook** push notifications.
- **Persistence** — SQLite history at `/data/ecoflow.db` on HA's persistent
  volume; survives add-on rebuilds and host updates.

### Configuration
- All EcoFlow / MQTT / notification / weather settings exposed as typed
  HA add-on Options — no `.env` editing on the Pi.

### Supported architectures
- `aarch64` — Raspberry Pi 4 / Pi 5 on 64-bit Raspberry Pi OS (the
  modern default), and any other ARM64 HA host.
- `amd64` — for x86 HA hosts and testing.
