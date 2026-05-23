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
4. **Install** (HA Supervisor builds the container on the Pi — takes a few
   minutes the first time). Then open **Configuration** and paste your
   EcoFlow IoT Open API keys (get them at
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

Two GitHub Actions live under `.github/workflows/`:

- **`ci.yml`** — type-checks `server/` and `web/` on every push to `main`
  and on every PR.
- **`release.yml`** — manual one-click release. From the repo on GitHub:
  **Actions → Release → Run workflow** → choose `patch` / `minor` / `major`
  (or paste an explicit `version`). Optionally paste release notes
  (markdown); leave empty to auto-generate them from the commit log since
  the previous tag. The workflow then:
  1. Bumps `version:` in `config.yaml`.
  2. Prepends a section to `CHANGELOG.md`.
  3. Commits `Release vX.Y.Z`, tags `vX.Y.Z`, pushes both.
  4. Creates a GitHub Release.

Then on the Pi:
```bash
cd /addons/ecoflow-panel && git pull
```
Home Assistant detects the new `version:` and surfaces an **Update** button.

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
- **Phase 6** — Home Assistant add-on packaging (this repo, multi-arch).

## Roadmap

- **WAVE 2 / Smart Generator schemas** — proper projections when those come
  online.
- **Per-circuit kWh history** — multi-day comparison on the circuit modal.
- **HA service integration** — surface key panel sensors (backup %, projected
  low SoC, soonest EOL) as Home Assistant entities so they can drive
  automations.
- **Pre-built multi-arch images via GHCR** — skip the on-Pi container build
  for faster installs.
