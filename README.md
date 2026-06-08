# EcoFlow Home Energy Panel

Local "control-room" dashboard and telnet TUI for an EcoFlow fleet (SHP2,
Delta Pro Ultra inverters, Delta/River 3 Plus UPS units, EV charger). Talks to
the EcoFlow IoT Open API (HMAC-SHA256-signed REST polling + MQTT live
telemetry), persists per-metric history to SQLite, and serves a React
dashboard with learned anomaly detection, day-ahead forecasting, and per-pack
capacity-fade → end-of-life projection. Also publishes 22+ entities into
Home Assistant via MQTT Discovery, ships 9 Lit-based HACS Lovelace cards,
and includes a klaxon/TTS broadcast subsystem with off-grid (no-Cloud-TTS)
mode.

This repo is **also a Home Assistant add-on** — see below.

## Install on Home Assistant (Raspberry Pi)

For a Pi running Home Assistant OS or Supervised:

1. SSH into the host — enable the **SSH & Web Terminal** add-on, or use the
   HA Console.
2. Clone this repo into the local add-ons folder:
   ```bash
   cd /addons      # HA OS default; on HA Supervised: /usr/share/hassio/addons/local
   git clone https://github.com/tesseractAZ/ecoflow-panel.git
   ```
3. In Home Assistant: **Settings → Add-ons → Add-on Store**, click the ⋮ menu
   → **Reload**. **EcoFlow Panel** appears under "Local add-ons".
4. **Install** — HA Supervisor pulls the pre-built image from GHCR (seconds,
   not minutes — see [Releasing a new version](#releasing-a-new-version) for
   the build pipeline). Then open **Configuration** and paste your EcoFlow
   IoT Open API keys (get them at
   <https://developer.ecoflow.com> → IoT Open Platform → User Information).
5. (Optional) adjust `FORECAST_LAT` / `FORECAST_LON` to your location, and
   configure a push channel (ntfy / Pushover / webhook).
6. **Start**. Dashboard: `http://<homeassistant-IP>:8787/`. Telnet TUI:
   `nc <homeassistant-IP> 2323`.

### Updating

```bash
cd /addons/ecoflow-panel
git pull
```
Home Assistant detects the bumped `version:` in `config.yaml` and the add-on
page surfaces an **Update** button.

### Surviving a Pi reimage

Everything that defines the deployment lives in this GitHub repo. The only
state *not* in git is the SQLite history at `/data/ecoflow.db` (HA's
persistent volume) — that re-bootstraps from device telemetry once the add-on
starts on the fresh image.

---

## Local development (macOS / Linux)

### Layout

- `server/` — Fastify + TypeScript backend. REST poll + MQTT live, projects
  raw quotas into compact per-product shapes, broadcasts to `/ws`, and serves
  the built web in production.
- `web/` — Vite + React + Tailwind frontend.
- HA packaging lives at the repo root: `config.yaml`, `Dockerfile`,
  `build.yaml`, `rootfs/`, `DOCS.md`, `CHANGELOG.md`.

### Setup

1. Put your IoT Open API keys in `server/.env` (see `server/.env.example`).
2. Install deps:
   ```bash
   cd server && npm install
   cd ../web && npm install
   ```
3. Run (two terminals — Vite proxies `/api` and `/ws` to the backend):
   ```bash
   cd server && npm run dev    # http://127.0.0.1:8787
   cd web && npm run dev       # http://localhost:5173
   ```
4. Open <http://localhost:5173>.

### Production-style local run (single process)

```bash
cd web && npm run build       # produces web/dist/
cd ../server && npm start     # Fastify serves /api + /ws + the built web on :8787
```

### Useful CLIs

- `npm run discover` (in `server/`) — list every device on the account
- `npm run probe -- <SN>` — print the full raw quota for one device
- `npm run probe -- all` — probe every online device (~80 KB of output)

### Auto-start on Mac login (launchd)

A LaunchAgent plist template is included at `launchd/com.local.ecoflow-panel.plist`.
**Edit the `/ABSOLUTE/PATH/TO/ecoflow-panel` placeholders to your clone's absolute
path first** (run `pwd` from the repo root). It auto-starts the backend (Vite is a
dev-time concern; for "always-on" use `npm run build` and let Fastify serve
`web/dist`).

```bash
cp launchd/com.local.ecoflow-panel.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.local.ecoflow-panel.plist
launchctl list | grep ecoflow
tail -f data/launchd.out.log data/launchd.err.log

# Stop / uninstall
launchctl unload ~/Library/LaunchAgents/com.local.ecoflow-panel.plist
```

## Releasing a new version

Three GitHub Actions live under `.github/workflows/`:

- **`ci.yml`** — on every push to `main` and on every PR:
  - type-checks `server/` and `web/`
  - builds the add-on container (amd64, cached) as a Dockerfile smoke test
- **`release.yml`** — manual one-click "cut a release." From the repo on
  GitHub: **Actions → Release → Run workflow** → choose
  `patch` / `minor` / `major` (or paste an explicit `version`). Optionally
  paste markdown release notes; leave empty to auto-generate them from the
  commit log since the previous tag. The workflow bumps `version:` in
  `config.yaml`, prepends a section to `CHANGELOG.md`, commits
  `Release vX.Y.Z`, tags `vX.Y.Z`, and pushes both.
- **`images.yml`** — triggered automatically by the tag push. In parallel,
  builds amd64 + aarch64 images via buildx + QEMU and pushes them to GHCR
  as `:vX.Y.Z` and `:latest`. Once both arch builds succeed, it extracts
  the version's CHANGELOG section and creates the GitHub Release. **The
  GitHub Release appearing on the repo is your "go ahead and update"
  signal** — at that point the pre-built image is ready to pull.

Then on the Pi:
```bash
cd /addons/ecoflow-panel && git pull
```
Home Assistant detects the bumped `version:` in `config.yaml`, surfaces
an **Update** button, and pulls the pre-built image from GHCR (seconds,
not minutes).

### One-time setup after the first `images.yml` run

Open <https://github.com/tesseractAZ?tab=packages>. Two new packages appear:

- `amd64-ecoflow-panel`
- `aarch64-ecoflow-panel`

Open each → **Package settings** → **Change visibility** → **Public**.
HA Supervisor needs anonymous pulls to install. This is a one-time flip;
future versions inherit the visibility.

### Dependency PRs

Dependabot is configured (`.github/dependabot.yml`) to open weekly PRs
on Monday morning (Phoenix time) for `server/` and `web/` npm packages,
GitHub Actions versions, and the Dockerfile base images — grouped by
production vs development to keep the PR list short.

## What's shipped

- **Phase 1** — REST polling, WebSocket push, React/Tailwind dashboard.
- **Phase 2** — MQTT live telemetry + SQLite recorder + `/api/history` +
  sparklines and 24-hour trend charts.
- **Phase 3** — kWh aggregator, animated EnergyFlow diagram, click-to-detail
  circuit modal, launchd auto-start.
- **Phase 4** — Learned alerting engine: peer-comparison anomalies, per-sensor
  self-baseline, runtime + capacity-fade forecasting, equipment-tuned solar
  response model, day-ahead PV/load/SoC forecast, PV soiling detection.
- **Phase 5** — Control-room telnet TUI (9 screens, NAWS-adaptive),
  Predictive Insights tab, per-pack capacity-fade → end-of-life projection
  with confidence band + fleet peer comparison, cleared-anomalies log,
  glossary hover tooltips on every metric label.
- **Phase 6** — Home Assistant add-on packaging (this repo, multi-arch
  GHCR images, one-click release pipeline, Dependabot).
- **Phase 7** — Home Assistant entities via **MQTT Discovery** —
  22+ sensors + 1 binary_sensor auto-registered under one "EcoFlow Panel"
  device (backup pool %, panel load, AC import, off-grid status, day-ahead
  forecast, soonest-EOL, alert counts, peer outliers, per-circuit lifetime
  kWh, etc.). Energy Dashboard wiring is plug-and-play. The legacy
  REST-sensor YAML approach still works for existing installs but is
  deprecated as of v0.9.68. See `DOCS.md` → "Home Assistant entities".

## Roadmap

### Shipped through v0.10.2

The original roadmap (v0.7.0 / v0.8.0+ / external + infrastructure) and
multiple follow-on series (predictive-engine v2, polish + tests, HACS
Lovelace cards, security hardening, broadcast/TTS robustness, engine
audit + test backfill) are all shipped. Highlights — see
[CHANGELOG.md](CHANGELOG.md) for the per-release breakdown:

**Off-thread analytics (v0.10.0–v0.10.2)** — `node:sqlite` is synchronous, so
every heavy history scan now runs on a dedicated **worker thread**; the main
event loop never blocks on a multi-second query. The main thread keeps the
sole write connection (MQTT ingestion + lifetime rollup); a read-only worker
connection to the same WAL DB serves every report + raw query and self-warms
its caches. Benchmark: a 25-scan workload that froze the main loop ~1066 ms
on-thread holds main-loop lag to ~34 ms on the worker (31.7×). This ended a
Supervisor-watchdog restart loop — the add-on had been restarting ~every
40 min whenever a health probe coincided with a synchronous scan.

**Solar curtailment + self-consumption (v0.9.76–v0.9.84)** — detects when PV
is rejected at the panels because batteries are full and home load is below
solar input, judged against the *configured* charge ceiling (`chgMaxSoc`,
which Storm Guard / mode changes move), and surfaces the headroom you could
absorb (e.g. run the pool pump). Self-consumption energy integrals are
memoized per-calendar-day (completed days are immutable), cutting the rolling
7-day recompute cost ~7×.

**Predictive engine** — peer-comparison anomaly, self-baseline anomaly,
day-ahead forecast (cloud-aware + day-of-week-aware load + 3-day horizon
+ P10/P50/P90 probabilistic bands + counterfactual cloud-cover
explanations + multi-source weather ensemble with NWS NDFD), per-pack
SoH degradation (Arrhenius + coulombic eff + Kalman side-by-side),
PackRiskScore (heuristic v1), shade detection, soiling decomposition,
string-mismatch, EV window prediction + load-curve folding, thermal-
event counter, MPPT efficiency drift, alert clustering, root-cause
graph, energy dispatch planner, forecast skill calibration, Bayesian
recursive GHI→PV updates with credible intervals.

**HA integration** — REST sensors, MQTT Discovery (22+ entities), HA
Energy Dashboard (5 lifetime kWh counters + per-circuit Individual
devices, plus the 2026.6 battery state-of-charge badge via
`sensor.ecoflow_backup_pool`), per-circuit lifetime accumulators,
carbon offset reporting,
TOU tariff cost tracking, calendar ICS feed, repair issues feed,
diagnostic entity categorization, NWS storm-prep alerts, HACS Lovelace
"stats" card.

**Notifications** — ntfy / Pushover / webhook, quiet-hours +
morning-digest, alert telemetry with three-tier self-tuning
auto-downgrade (info-silencing, warning→info demotion, chronic-noise
silencing).

**Plumbing** — Node 22 + Fastify + node:sqlite + tsx, native ARM64 CI
build pipeline (1m 30s end-to-end), 341-test CI gate that blocks bad
releases, PWA-installable web UI with route-level code splitting
(60 kB initial JS), persistent lifetime energy accumulator that
survives recorder pruning + restarts, telnet TUI for terminal monitoring,
per-SN connectivity logging, EcoFlow-zombie detection with actionable
fix steps in offline alerts.

**HACS Lovelace cards (v0.9.50–v0.9.55)** — 9 Lit-based cards (fleet,
alerts, battery, solar, strategy, insights, circuit, broadcast, stats)
served directly from the add-on at
`http://homeassistant.local:8787/lovelace/<card>.js`. Add as Lovelace
resources without HACS, or install via HACS — both URLs work.

**Security hardening (v0.9.60)** — write-auth token model + CSRF
protection + CORS allow-list. 11 write endpoints require one of:
HA Ingress header, same-origin, or `X-Panel-Write-Token` (auto-
generated at `/data/panel-write-token.txt`, mode 0600). The
`send-command` debug path adds constant-time token compare, per-SN
cooldown, `cmdSet` allow-list, and payload-shape caps.

**Broadcast / TTS robustness (v0.9.63, v0.9.65)** — TTS language-format
retry chain (`en-US` → `en_US` → no-language) auto-recovers from the
Wyoming/Cloud format mismatch; new `BROADCAST_TTS_REQUIRE_LOCAL`
option enforces no-Cloud-TTS for off-grid setups; explicit
`BROADCAST_TTS_SERVICE` pin now disables the fallback chain.

**MPC dispatch fix (v0.9.64)** — `simulateHour()` now actually applies
the explicit battery-flow component for `dischargeMax`,
`chargeFromGrid`, and `idleHold` actions; previously the DP optimizer
couldn't distinguish them from `idleHold` and never selected them.

**Engine audit + test backfill (v0.9.58, v0.9.59, v0.9.61, v0.9.67,
v0.9.68)** — 14 correctness fixes across Kalman, Bayes, MPC, and
EV-window engines; 341-test suite gating every release; MPC test
determinism via injectable `nowMs`; MQTT Discovery dedup with
regression-guard tests.

**Entity registry hygiene (v0.9.68)** — REST sensors path deprecated.
MQTT Discovery is the canonical surface, with a one-shot retained-empty
sweep that prunes historical-mistake double-prefixed `unique_id`s.

### Held until requested

The following are **read-only by design**. The panel doesn't modify the
EcoFlow devices it observes. When you're ready to make it bi-directional
these are the candidates:

- Boost backup reserve switch (storm mode)
- Quiet-hours notification override toggle
- Skip next predicted EV charging window
- Force pack rebalance button
- Per-circuit on/off
- Auto-apply the recommended dispatch plan
- Live SHP2 strategy adjustment (mode, reserve, TOU windows)

### Genuinely deferred (research-grade)

Each is multi-week effort or blocked on data the deployment doesn't yet
generate:

- **Trained ML failure-mode classifier** — replaces the heuristic
  `PackRiskScore` with a gradient-boosted model. Needs a labeled
  pack-failure dataset, which only accumulates as deployments age and
  packs hit EOL. Shipping infrastructure (feature engineering, API
  shape, drop-in replacement target) is already in place.
- **LAN-direct EcoFlow protocol** — eliminates the "EcoFlow Cloud
  zombie" failure mode by reading telemetry from the SHP2 / DPUs
  directly over the local network. Multi-week reverse engineering on
  the wire format.
- **Multi-site federation** — anonymized fleet comparison across
  installs ("your fade rate is 0.8× peer median across N installs").
  Needs server infrastructure + opt-in plumbing + privacy review.
- **Full HACS dashboard rewrite** — re-implement the entire React UI
  as Lit/Web Components inside HA. Marginal benefit over the PWA;
  multi-week port. The current "stats card" covers the highest-value
  HA-side use cases.

### Standing

- **WAVE 2 / Smart Generator schemas** — proper projections when those
  come online via the EcoFlow IoT Open API.
- **Broadcast / TTS subsystem refactor** — the
  `broadcast.ts` + `ttsService.ts` + `haService.ts` paths accumulated
  workarounds across v0.9.18 → v0.9.65 (MA `media_stop` pre-flight,
  `tts_proxy` URL handoff, klaxon settle timers, language-format
  retry chain, no-cloud gating). Many were defensive responses to bugs
  that have since been fixed upstream (MA queue races, Wyoming locale
  parsing, Piper 500s). Worth a clean-room redesign that:
    1. Picks one canonical broadcast target representation
       (deduplicate the MA/Sonos/apple_tv pairings — the operator currently has
       three device-registry duplicates that the broadcast code papers
       over),
    2. Collapses the MA / `media_player` backend selector into a single
       service-call path with a thin compatibility shim,
    3. Drops the settle timers in favor of HA-event-driven sequencing
       (`media_player.state == playing` → fire next), and
    4. Replaces the TTS engine-pick fallback chain with a small
       provider interface tested against Piper / Cloud / Google in
       isolation. Bundle the cleanup as a single focused release.
