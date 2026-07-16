# Power — EcoFlow off-grid monitoring, forecasting & life-safety alarm

**Power** (add-on slug `ecoflow_panel`) is a Home Assistant add-on that turns a
cloud-only EcoFlow off-grid system into a fully-instrumented, self-learning
"control room" — with a **life-safety battery-depletion alarm** at its center.

It ingests EcoFlow IoT-Open telemetry (HMAC-SHA256-signed REST + live MQTT),
persists a per-metric SQLite time-series, runs ~40 analytics engines in a
worker thread, and serves the results four ways: a **React dashboard**, a
**telnet TUI**, **50+ Home Assistant MQTT-discovery sensors** (incl. the Energy
Dashboard), and **HACS Lovelace cards**. When the battery is projected to reach
its reserve floor, it raises an **audible alarm** — chimes + text-to-speech over
Home Assistant media players and a SIP intercom.

The reference deployment is a Phoenix, AZ off-grid home: an EcoFlow **Smart Home
Panel 2**, ~4 **Delta Pro Ultra** battery/inverter Cores (5 packs each), a
**42-panel / 16.8 kW** array, and an EVSE.

> 📖 **Full reference:** [`ecoflow_panel/DOCS.md`](ecoflow_panel/DOCS.md) documents
> **every** feature and engine — what each does, the exact algorithm and math it
> computes, how data traces through the pipeline, its endpoints/sensors, config
> knobs, and edge-case guards. This README is the tour; DOCS.md is the manual.

---

## What it does — at a glance

**Telemetry & history**
- Reverse-engineered EcoFlow cloud MQTT ingest (per-SN raw merge across
  `cmdId` 1/21/28) → a unified device snapshot for every DPU Core, the SHP2, and
  the EVSE — including **SHP2-attributed data for Cores whose Wi-Fi is down**.
- SQLite time-series (adaptive interval + value-epsilon dedup, ~30-day
  retention) and monotonic lifetime-energy accumulators (HA Energy Dashboard).

**Forecasting**
- Per-hour-of-day **GHI→PV response model** (OLS, brightness/sample-gated) fed by
  an Open-Meteo + NWS weather ensemble, plus a **recursive Bayesian** variant.
- Day-ahead PV + load + **projected state-of-charge** curve, a self-calibrating
  **P10/P90 probability band**, a 3-day horizon, and a **forecast-skill** backtest
  (predicted-vs-actual daily kWh, MAE, bias).
- A **first-principles clear-sky** PV ceiling that cross-checks the learned model.

**Battery & PV health engines**
- Per-pack **State-of-Health** (Kalman filter vs raw BMS), **end-of-life**
  projection (with a 10 %/yr fade ceiling that kills false-EOL), a **hierarchical
  Bayesian** SoH cross-check with 2σ outlier detection, and an **LFP open-circuit-
  voltage → SoC** estimate gated on pack rest.
- **Pack-risk** classifier (heuristic + an ML logistic-regression / isolation-
  forest v2), **internal-resistance** trend, **round-trip efficiency**,
  **coulombic efficiency**, **charge-curve** fingerprinting, ambient-coupled
  **thermal forecast** + event counter, **string-mismatch**, and **PV soiling**
  decomposition (per-Core, weather-normalized).

**Energy & economics**
- Self-consumption decomposition (solar fraction, PV→load/battery), carbon
  accounting, TOU tariff + cost, clipping/curtailment, and an **advisory
  round-trip-aware dispatch planner** (compute-only, never auto-applied).

**Alarms & learning**
- Threshold + four families of **learned** alerts (peer-comparison, self-baseline,
  degradation/runtime forecast, solar/load forecast), an alert **monitor**
  (transition debounce, incident clustering, churn auto-silence, quiet hours),
  Home Assistant notifications with dedupe + digest, a **repair-issues** feed, and
  an **online learning loop** (feature snapshots → realized outcomes → shadow
  models).
- The **safety-critical** runway engine: an hour-by-hour DC-bus depletion sim
  (accounting for the DC→AC discharge loss), grid-aware severity, and a battery-
  SoC floor ladder — driving the audible broadcast.

**Delivery**
- Audible **broadcast** pipeline: per-target volume pinning, a built-in tone
  library (+ uploads, per-level assignment), TTS (local Piper/Wyoming with a
  Cloud fallback), Music Assistant / `media_player`, and a **SIP** side-channel to
  an antique-phone intercom.
- **Web dashboard** (Energy, Battery, Solar, EVSE, Strategy, Alerts, Predictive
  Insights), **telnet TUI** (Plant Operator console), and **HACS Lovelace cards**.

See the [DOCS.md table of contents](ecoflow_panel/DOCS.md#table-of-contents) for
the full, math-level treatment of each of the above.

---

## Architecture (60-second version)

```
EcoFlow cloud ──MQTT──▶ snapshot store ──▶ SQLite recorder ──▶ analytics worker (≈40 engines)
   (IoT-Open)          (DeviceSnapshot)     (time-series +          │
                                             lifetime accum.)       ├─▶ HTTP API  (:8787)
                                                                    ├─▶ HA MQTT-discovery sensors
                                                                    ├─▶ React web UI + HACS cards
                                                                    ├─▶ telnet TUI (:2323)
                                                                    └─▶ runway alarm ─▶ audible broadcast
```

Analytics run **off the main thread** (a worker + a client proxy with per-report
caching) so ingest and the API never block. Full detail, the recorder schema,
and the report dependency graph are in
[DOCS.md ch.1 — System Architecture & Data Flow](ecoflow_panel/DOCS.md#1-system-architecture--data-flow).

---

## Install on Home Assistant (Raspberry Pi)

For a Pi running Home Assistant OS or Supervised:

1. Enable the **SSH & Web Terminal** add-on (or use the HA Console) and SSH in.
2. Clone this repo into the local add-ons folder:
   ```bash
   cd /addons      # HA OS default; on HA Supervised: /usr/share/hassio/addons/local
   git clone https://github.com/tesseractAZ/ecoflow-panel.git
   ```
3. In Home Assistant: **Settings → Add-ons → Add-on Store**, ⋮ menu → **Reload**.
   **Power** appears under "Local add-ons".
4. **Install** — the Supervisor pulls the pre-built multi-arch image from GHCR
   (seconds, not a local build). Open **Configuration**, paste your EcoFlow
   `access_key` / `secret_key` and location, and **Start**.
5. Open the add-on's **Web UI** (ingress), or reach the trusted-LAN data API at
   `http://<host>:8787` and the telnet TUI at `nc <host> 2323`.

Every configuration option is documented in
[DOCS.md ch.12 — Configuration, Deployment, Security & Operations](ecoflow_panel/DOCS.md#12-configuration-deployment-security--operations).

---

## Repository layout

| Path | What it is |
|------|-----------|
| `server/` | Node/TypeScript server — ingest, recorder, ~40 analytics engines, HTTP API, MQTT discovery, broadcast/TTS, telnet TUI |
| `web/` | React dashboard (Vite) |
| `lovelace/` | HACS Lit cards (`ecoflow-fleet/alerts/battery/solar/strategy/insights/circuit`) |
| `ecoflow_panel/` | Add-on manifest (`config.yaml`), `DOCS.md`, `CHANGELOG.md`, AppArmor profile |
| `.github/workflows/` | CI (type-check, tests, CodeQL, smoke build) + tag-release → multi-arch GHCR publish |

## Development

```bash
cd server && npm install && npm test     # 1,480+ tests
cd server && npx tsc --noEmit            # server type-check
cd web    && npm install && npm run build
```

**Release pipeline:** bump `ecoflow_panel/config.yaml` + prepend `CHANGELOG.md` →
open a PR whose squash subject starts `Release vX.Y.Z …` → the 6 CI checks + an
adversarial multi-agent review gate it → merge fires `tag-release.yml`, which
builds the multi-arch GHCR image and cuts a GitHub Release → the add-on updates
in place. Details in DOCS.md ch.12.

## Quality & accuracy

This is a life-safety system, and it's held to that bar. A recent **whole-system
accuracy assessment** (every engine cross-validated against independent
ground-truth — Open-Meteo GHI, array physics, energy conservation, and the
system's own backtest) graded it **A−**: daily PV matches independent expectation
to 0–1 %, battery capacity ties to 0.07 %, energy conservation closes to ~6.5 %,
and the alert engine ran at 7/7 true positives. Every change to an engine ships
through green tests **plus** an adversarial multi-agent review before it can reach
the alarm path.

## Security

See [`SECURITY.md`](SECURITY.md) for the vulnerability-reporting policy and the
security posture (AppArmor confinement, write-commands-off-by-default with an
audit log, auth-gated write endpoints, secrets reported presence-only).
