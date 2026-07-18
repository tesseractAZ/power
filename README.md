# Power — EcoFlow off-grid monitoring, forecasting & life-safety alarm

**Power** (Home Assistant add-on, slug `ecoflow_panel`) turns a cloud-only
EcoFlow off-grid system into a fully-instrumented, self-learning **control room**
— with a **battery-depletion life-safety alarm** at its center.

It ingests EcoFlow IoT-Open telemetry (HMAC-SHA256-signed REST + live MQTT),
persists a per-metric SQLite time-series, runs **~40 analytics engines** in a
worker thread, and serves the results four ways: a **React dashboard**, a
**telnet "control-room" TUI**, **78 Home Assistant MQTT-discovery entities**
(including the Energy Dashboard), and **HACS Lovelace cards**. When the pack is
projected to reach its reserve floor, it raises an **audible alarm** — chimes +
text-to-speech over Home Assistant media players and a SIP intercom.

The reference deployment is a Phoenix, AZ off-grid home: an EcoFlow **Smart Home
Panel 2**, three home **Delta Pro Ultra** battery/inverter Cores (5 packs each =
92 kWh usable), a **42-panel / ~16.8 kW** array, and an EVSE — on the APS R-EV
time-of-use rate.

> 📖 **Full reference:** [`ecoflow_panel/DOCS.md`](ecoflow_panel/DOCS.md) (~7,600
> lines) documents **every** feature and engine — what each does, the exact
> algorithm and math it computes, how data traces through the pipeline, its
> endpoints/sensors, config knobs, and edge-case guards. This README is the tour;
> DOCS.md is the manual.
>
> 🖨️ **Offline / printable:** a single-file **`.docx` and `.pdf`** build of this
> README + `SECURITY.md` + the full `DOCS.md` (with a linked table of contents)
> is attached to every [GitHub Release](https://github.com/tesseractAZ/power/releases).
> Regenerate locally with `python3 scripts/build-docs-docx.py` (needs `pandoc`;
> the PDF additionally needs LibreOffice).

---

## What it does — at a glance

**Telemetry & history**
- Reverse-engineered EcoFlow cloud MQTT ingest (per-SN raw merge across `cmdId`
  1/21/28) → a unified snapshot for every DPU Core, the SHP2, and the EVSE —
  including **SHP2-attributed data for Cores whose Wi-Fi is down**.
- SQLite time-series (adaptive interval + value-epsilon dedup, ~30-day retention)
  and monotonic lifetime-energy accumulators wired into the HA Energy Dashboard.

**Forecasting**
- Per-hour-of-day **GHI→PV response model** (OLS, brightness/sample-gated) fed by
  an Open-Meteo + NWS weather ensemble, plus a **recursive Bayesian** variant.
- Day-ahead PV + load + **projected state-of-charge** curve, a self-calibrating
  **P10/P90 probability band**, a **4-day** horizon, and a **forecast-skill**
  backtest (predicted-vs-actual daily kWh: MAE, bias, r²).
- A **first-principles clear-sky** PV ceiling that cross-checks the learned model.

**Battery & PV health engines**
- Per-pack **State-of-Health** (Kalman filter vs raw BMS), **end-of-life**
  projection (fade-rate-ceilinged to kill false-EOL), a **hierarchical-Bayesian**
  SoH cross-check with 2σ outlier detection, and an **LFP open-circuit-voltage →
  SoC** estimate gated on pack rest.
- **Pack-risk** classifier (heuristic + an ML logistic-regression / isolation-
  forest v2), **internal-resistance** trend, **round-trip** and **coulombic**
  efficiency, **charge-curve** fingerprinting, ambient-coupled **thermal
  forecast** + event counter, **string-mismatch**, and per-Core weather-
  normalized **PV soiling** decomposition.

**Energy, economics & dispatch**
- Self-consumption decomposition (solar fraction, PV→load/battery), carbon
  accounting, time-of-use tariff + cost, and clipping/curtailment.
- A **night-charge TOU-arbitrage advisor** *(advisory only — issues no device
  commands)*: on a night a shortfall is anticipated, it sizes "buy N kWh → charge
  to X% in the cheap overnight window" so the pack holds `reserve + outage
  cushion` to the next cheap window — worst-case sized (P10 solar / P90 load).
  It **learns from night one**: a durable ledger records each prediction and its
  next-day outcome, and a fail-closed write-readiness gate must prove accuracy
  before any write is ever offered.
- Two advisory round-trip-aware dispatch planners (greedy + a model-predictive
  DP), compute-only, never auto-applied.

**Alarms & learning**
- Threshold + four families of **learned** alerts (peer-comparison, self-baseline,
  degradation/runtime forecast, solar/load forecast), an alert **monitor**
  (transition debounce, incident clustering, churn auto-silence, quiet hours),
  HA notifications with dedupe + morning digest, a **repair-issues** feed, and an
  **online learning loop** (feature snapshots → realized outcomes → shadow models).
- The **safety-critical runway engine**: an hour-by-hour DC-bus depletion sim
  (accounting for the DC→AC discharge loss), grid-aware severity, and a battery-
  SoC floor ladder — driving the audible broadcast.

**Delivery surfaces**
- Audible **broadcast** pipeline: per-target volume pinning, a built-in tone
  library (+ uploads, per-level assignment), TTS (local Piper/Wyoming with a Cloud
  fallback), Music Assistant / `media_player`, and a **SIP** side-channel to an
  antique-phone intercom.
- **Web dashboard** (Energy · Battery · Solar · EVSE · Strategy · Alerts ·
  Predictive Insights), **telnet TUI** (Plant-Operator console), and **HACS
  Lovelace cards**.

See the [DOCS.md table of contents](ecoflow_panel/DOCS.md#table-of-contents) for
the full, math-level treatment of each of the above.

---

## Architecture (60-second version)

```
EcoFlow cloud ──MQTT──▶ snapshot store ──▶ SQLite recorder ──▶ analytics worker (≈40 engines)
   (IoT-Open)          (DeviceSnapshot)     (time-series +           │
                                             lifetime accum.)        ├─▶ HTTP API  (:8787)
                                                                     ├─▶ HA MQTT-discovery entities
                                                                     ├─▶ React web UI + HACS cards
                                                                     ├─▶ telnet TUI (:2323)
                                                                     └─▶ runway alarm ─▶ audible broadcast
```

Analytics run **off the main thread** (a worker + a client proxy with per-report
caching) so ingest and the API never block. The recorder schema, report
dependency graph, and full data-flow are in
[DOCS.md ch.1 — System Architecture & Data Flow](ecoflow_panel/DOCS.md#1-system-architecture--data-flow).

---

## Install on Home Assistant (Raspberry Pi)

For a Pi running Home Assistant OS or Supervised:

1. Enable the **Advanced SSH & Web Terminal** add-on (or use the HA Console) and
   SSH in.
2. Clone this repo into the local add-ons folder:
   ```bash
   cd /addons      # HA OS default; on HA Supervised: /usr/share/hassio/addons/local
   git clone https://github.com/tesseractAZ/power.git ecoflow-panel
   ```
3. In Home Assistant: **Settings → Add-ons → Add-on Store**, ⋮ menu → **Reload**.
   **Power** appears under "Local add-ons".
4. **Install** — the Supervisor pulls the pre-built multi-arch image from GHCR
   (seconds, not a local build). Open **Configuration**, paste your EcoFlow
   `ECOFLOW_ACCESS_KEY` / `ECOFLOW_SECRET_KEY` and site location, then **Start**.
5. Open the add-on's **Web UI** (HA ingress), or reach the trusted-LAN data API at
   `http://<host>:8787` and the telnet TUI at `nc <host> 2323`.

Every configuration option is documented in
[DOCS.md ch.12 — Configuration, Deployment, Security & Operations](ecoflow_panel/DOCS.md#12-configuration-deployment-security--operations).

---

## Repository layout

| Path | What it is |
|------|-----------|
| `server/` | Node/TypeScript server — ingest, recorder, ~40 analytics engines, HTTP API, MQTT discovery, broadcast/TTS, telnet TUI |
| `web/` | React dashboard (Vite) |
| `lovelace/` | HACS Lit cards (`ecoflow-fleet` / `alerts` / `battery` / `solar` / `strategy` / `insights` / `circuit`) |
| `ecoflow_panel/` | Add-on manifest (`config.yaml`), `DOCS.md`, `CHANGELOG.md` (+ archive), AppArmor profile |
| `scripts/` | Docs builder (`build-docs-docx.py`), device probes |
| `.github/workflows/` | CI (type-check ×2, Dockerfile smoke, docs `.docx`+`.pdf`, CodeQL) + tag-release → multi-arch GHCR publish |

## Development

```bash
cd server && npm install && npm test     # ~1,600 tests
cd server && npx tsc --noEmit            # server type-check
cd web    && npm install && npm run build
```

**Release pipeline.** Bump `ecoflow_panel/config.yaml` + prepend `CHANGELOG.md` →
open a PR whose squash subject starts `Release vX.Y.Z …`. `main` is branch-
protected: the CI checks (both type-checks, the Dockerfile smoke build, the docs
`.docx`+`.pdf` build, and CodeQL) must pass, and every engine change also clears
an **adversarial multi-agent review** before it can reach the alarm path. Merging
a `Release …` subject fires `tag-release.yml`, which builds the multi-arch GHCR
image and cuts a GitHub Release (with the docs attached); the add-on then updates
in place. Full runbook in DOCS.md ch.12.

## Quality & accuracy

This is a life-safety system and is held to that bar. Engines are cross-validated
against **independent** ground truth — Open-Meteo GHI, first-principles array
physics, energy conservation, and the system's own forecast backtest — with
concrete results tracked over time (daily PV matches independent expectation to
~0–1%; measured pack capacity ties to nameplate within a fraction of a percent;
the round-trip efficiency reconciles the conversion losses it should).

The real guardrail is process: **every** change to an engine or the alarm path
ships through green tests **plus** an adversarial multi-agent review that
actively tries to break it. That review earns its keep — e.g. the night-charge
advisor's review caught safety-direction sizing bugs (an under-buy on charging
nights, a truncated weekend horizon) *before* they shipped. New actuation stays
advisory-only and must prove out-of-sample accuracy through the learning ledger
before any device-writing capability is even offered.

## Security

See [`SECURITY.md`](SECURITY.md) for the vulnerability-reporting policy and the
security posture: AppArmor confinement, device writes off by default behind an
audit log and auth-gated endpoints, the unauthenticated TUI off by default, and
secrets handled presence-only (never logged or echoed).
