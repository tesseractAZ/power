# EcoFlow Home Energy Panel

Local "control-room" dashboard and telnet TUI for an EcoFlow fleet (SHP2,
Delta Pro Ultra inverters, Delta/River 3 Plus UPS units, EV charger). Talks to
the EcoFlow IoT Open API (HMAC-SHA256-signed REST polling + MQTT live
telemetry), persists per-metric history to SQLite, and serves a React
dashboard with learned anomaly detection, day-ahead forecasting, and per-pack
capacity-fade → end-of-life projection.

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

A LaunchAgent plist is included at `launchd/com.ericpaschal.ecoflow-panel.plist`.
It auto-starts the backend (Vite is a dev-time concern; for "always-on" use
`npm run build` and let Fastify serve `web/dist`).

```bash
cp launchd/com.ericpaschal.ecoflow-panel.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ericpaschal.ecoflow-panel.plist
launchctl list | grep ecoflow
tail -f data/launchd.out.log data/launchd.err.log

# Stop / uninstall
launchctl unload ~/Library/LaunchAgents/com.ericpaschal.ecoflow-panel.plist
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
- **Phase 7** — Home Assistant entities integration via `/api/ha-state` —
  ~13 sensors + 1 binary_sensor surfaced through HA's `rest:` integration
  (backup pool %, panel load, AC import, off-grid status, forecast,
  soonest-EOL, alert counts, peer outliers). See `DOCS.md` →
  "Home Assistant entities" for the copy-pasteable `configuration.yaml`
  snippet and example automations.

## Roadmap

Grouped by planned release. Each item leverages existing code paths or
introduces a small new integration; nothing requires a wholesale rebuild.

### Shipped through v0.7.5

The full roadmap from v0.7.0, v0.8.0+, and external/infrastructure
shipped in **v0.7.5** — see [CHANGELOG.md](CHANGELOG.md) for the
17-feature breakdown. Highlights: alert clustering ("incidents"),
internal-resistance trending, forecast-skill calibration,
ambient-coupled thermal forecast, shade-event detection, soiling
decomposition, string-mismatch detection, EV-window prediction,
charge-curve fingerprinting, NWS storm-prep, thermal-event counter,
MPPT efficiency drift + inverter standby losses, confidence trends,
quiet-hours + morning-digest notifications, alert-action telemetry,
self-consumption ratio, and full MQTT Discovery so HA users skip
the YAML snippet entirely.

### Standing

- **WAVE 2 / Smart Generator schemas** — proper projections when those
  come online via the EcoFlow IoT Open API.
