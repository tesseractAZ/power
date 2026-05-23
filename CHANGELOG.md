# Changelog

All notable changes to this add-on are listed here. Versioning follows
[Semantic Versioning](https://semver.org).

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
