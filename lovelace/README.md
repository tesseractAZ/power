# EcoFlow Panel — Lovelace cards

HACS plugin that ships Lovelace cards for the **EcoFlow Panel**
add-on. **Seven Lit-based cards** (v1.1.0) plus the original two
legacy cards. Pick one or use several — all the new cards share a
single WebSocket connection to the add-on per host.

| Card | When to use |
|---|---|
| `custom:ecoflow-fleet-card` | Top-level dashboard — energy-flow SVG, runway, per-device grid, 24h forecast |
| `custom:ecoflow-battery-card` | Fleet thermal + per-pack vitals + degradation trend + round-trip efficiency |
| `custom:ecoflow-solar-card` | Live PV, per-MPPT detail, probabilistic 24h forecast, clipping/soiling/shade diagnostics |
| `custom:ecoflow-alerts-card` | Active + cleared alerts, predictive insights, notify controls |
| `custom:ecoflow-panel-card` (legacy) | Compact stats glance — 12 headline numbers (kept for backward compat) |
| `custom:ecoflow-panel-dashboard` (legacy v0.9.4) | Tabbed interface — Dashboard / Battery / Forecast / Alerts (kept for backward compat) |

For deep analytics not in any single card (strategy config, advanced
insights, per-circuit history) the PWA at `:8787` remains the full
surface; each new card links out to it for context.

## Quick install

1. **HACS → Frontend → ⋮ → Custom repositories**
2. Add `https://github.com/tesseractAZ/ecoflow-panel` as **Type: Plugin**
3. Search for "EcoFlow Panel Card" and install it
4. HACS will copy `dist/ecoflow-panel-card.js` (the HACS-registered
   entry) into `<config>/www/community/EcoFlow-Panel-Card/`. To use
   the other cards (`fleet`, `battery`, `solar`, `alerts`):
   1. Open `<config>/www/community/EcoFlow-Panel-Card/` in the
      File Editor or via SSH
   2. The release ZIP includes every `dist/ecoflow-*.js` file —
      they are already next to `ecoflow-panel-card.js`
   3. **Settings → Dashboards → Resources → Add resource** for each
      one you want, e.g.
      `URL: /hacsfiles/EcoFlow-Panel-Card/ecoflow-fleet-card.js`,
      resource type **JavaScript Module**
5. Add the card to a Lovelace dashboard (see per-card YAML below)

If you prefer the manual route (no HACS), see [Manual install](#manual-install-no-hacs)
below.

## Screenshots

> Placeholders — drop PNGs into `docs/screenshots/` next to the
> bundle and link them here.

| Card | Screenshot |
|---|---|
| `ecoflow-fleet-card` | ![fleet card](docs/screenshots/fleet-card.png) |
| `ecoflow-battery-card` | ![battery card](docs/screenshots/battery-card.png) |
| `ecoflow-solar-card` | ![solar card](docs/screenshots/solar-card.png) |
| `ecoflow-alerts-card` | ![alerts card](docs/screenshots/alerts-card.png) |

## Card configuration reference

Every Lit-based card accepts the same three options:

| Option | Default | Notes |
|---|---|---|
| `host` | `http://homeassistant.local:8787` | Where the EcoFlow Panel add-on lives |
| `title` | per-card default | Card header text |
| `refresh_seconds` | `30` (min 10) | Poll interval for HTTP-backed sections (the WS stream updates separately) |

### `ecoflow-fleet-card`

Top-level dashboard view ported from the React PWA's main page:
status banner, animated energy-flow SVG, runway-to-reserve headline,
"today" energy tiles, per-device grid (SHP2 + DPUs + small devices),
and a 24-hour forecast chart layered with projected SoC.

```yaml
type: custom:ecoflow-fleet-card
host: http://homeassistant.local:8787
title: EcoFlow Fleet
refresh_seconds: 30
```

### `ecoflow-battery-card`

Battery-focused view: fleet kWh/SoC/SoH rollup, per-pack thermal &
cell-voltage spread, degradation projection with sparkline per pack,
and round-trip efficiency 30-day trend.

```yaml
type: custom:ecoflow-battery-card
host: http://homeassistant.local:8787
title: Battery
refresh_seconds: 30
```

### `ecoflow-solar-card`

Solar-focused view: live PV / today kWh / forecast 24h headline,
per-MPPT string table (HV + LV across all DPUs), probabilistic
24h forecast (P10/P50/P90 confidence bands), and a "what's holding
solar back" diagnostic section pulling clipping, soiling and shade
estimates from the add-on.

```yaml
type: custom:ecoflow-solar-card
host: http://homeassistant.local:8787
title: Solar
refresh_seconds: 30
```

### `ecoflow-alerts-card`

Active alerts + lazy-loaded cleared history + predictive-insights
subset + notify status. Each active alert has Ack / Dismiss / Failed
buttons that POST to `/api/alerts/outcome` — the feedback loop
feeding the learned-risk model.

```yaml
type: custom:ecoflow-alerts-card
host: http://homeassistant.local:8787
title: Alerts
refresh_seconds: 30
```

### `ecoflow-strategy-card`

Read-only display of SHP2 strategy state: backup reserve floors,
mid-priority discharge floor, smart-backup mode, circuit priorities
+ breaker amps, charge schedule (TOU window), and dispatch
recommendations from `/api/dispatch-plan`. Editing TOU and priorities
still happens in the add-on options or the EcoFlow app — this card
makes the current state visible inside Lovelace.

```yaml
type: custom:ecoflow-strategy-card
host: http://homeassistant.local:8787
title: Strategy
refresh_seconds: 30
```

### `ecoflow-insights-card`

The heaviest card — 15 sections mirroring the React `AdvancedInsightsCard`:
active incidents, NWS alerts, self-consumption, weather ensemble,
confidence, thermal events, equipment health (MPPT + inverter idle),
shade events, soiling decomposition, string mismatch, EV-charging
windows, charge-curve drift, internal resistance, forecast skill
(with 7-day sparkline), ambient thermal forecast.

Top-3 sections auto-expanded; the rest collapse with a Show/Hide
button. 15 HTTP endpoints, each independently stale-flagged on fail.

```yaml
type: custom:ecoflow-insights-card
host: http://homeassistant.local:8787
title: Advanced Insights
refresh_seconds: 60
```

### `ecoflow-circuit-card`

Per-circuit drill-down. **Requires** a `circuit:` option (1-12,
matching SHP2 channel numbers). Renders the channel's live W, a
24-hour sparkline at 2-min resolution, a 30-day kWh + cost rollup
(default `$0.17/kWh`, Phoenix APS residential), and combined
split-phase totals if the channel is paired (e.g. 240V EV charger).

```yaml
type: custom:ecoflow-circuit-card
host: http://homeassistant.local:8787
title: Pool Pump
circuit: 10
cost_per_kwh: 0.17  # optional; default 0.17
refresh_seconds: 60
```

## Manual install (no HACS)

1. Download `dist/ecoflow-<card>-card.js` (one per card you want)
   from a release or build it locally (below)
2. Copy each file to `<config>/www/`
3. **Settings → Dashboards → Resources → Add resource** for each one
   - URL: `/local/ecoflow-<card>-card.js`
   - Resource type: **JavaScript Module**
4. Add the YAML snippets above to your dashboard

## Building locally

```bash
cd lovelace
npm install
npm run build       # writes dist/ecoflow-{fleet,alerts,battery,solar,strategy,insights,circuit}-card.js + test bundle
npm run type-check  # tsc --noEmit
```

Built bundles are committed to `dist/` so HACS can serve them
directly without a build step on the user's machine.

**Tests** — `test/snapshot-store.test.html` loads
`dist/snapshot-store.test.js` and runs five vanilla-JS cases against
a stubbed `WebSocket` (subscribe, refcount, reconnect, grace,
getSnapshot). Open the HTML file in a browser after `npm run build`.

## Architecture notes

The new generation of cards is built on [Lit](https://lit.dev) in
TypeScript and shares:

- **Snapshot store** (`src/shared/snapshot-store.ts`) — per-host
  refcounted singleton; opens a WebSocket on first subscribe,
  REST-seeds from `/api/snapshot`, reconnects with 1/2/4/8/16/30 s
  exponential backoff, and tears down 5 s after the last unsubscribe
  so dashboard tab switches don't churn the connection. **Multiple
  cards on the same dashboard pointing at the same host share ONE
  WS connection.**
- **Primitives** (`src/shared/primitives/`) — `<ef-badge>`,
  `<ef-tile>`, `<ef-section>` — small LitElements styled off the
  `--ef-*` design tokens.
- **Glossary directive** (`src/shared/glossary.ts`) — Shadow-DOM-safe
  rewrite of the React-era hover-tooltip pass.
- **Chart helpers** (`src/shared/charts.ts`) — hand-rolled SVG
  `sparkline()` + `forecastChart()`; ~400 lines total, no chart-library
  dependency.

Each card bundle tree-shakes independently — primitives not used
by a card don't bloat its output. Per-card minified sizes (terser):

| Card | dist/ size |
|---|---|
| `ecoflow-fleet-card.js` | ~58 KB |
| `ecoflow-alerts-card.js` | ~53 KB |
| `ecoflow-battery-card.js` | ~51 KB |
| `ecoflow-solar-card.js` | ~56 KB |
| `ecoflow-strategy-card.js` | ~52 KB |
| `ecoflow-insights-card.js` | ~62 KB |
| `ecoflow-circuit-card.js` | ~48 KB |

## Legacy cards (`ecoflow-panel-card`, `ecoflow-panel-dashboard`)

These two are the original React-era bundles, still shipped in
`dist/` for backward compatibility so existing dashboards don't
break. They are **frozen** — no new features land in them — and are
slated for removal in a future card-pack release. Migrate to
`ecoflow-fleet-card` (the direct replacement for
`ecoflow-panel-dashboard`) when convenient.

### Stats card (`custom:ecoflow-panel-card`) — legacy

Compact 12-tile glance: PV right now · Panel load · Backup pool %
· Runway to reserve · Projected SoC low · Grid status · PV
lifetime + CO2 avoided · Round-trip efficiency · Tariff savings ·
Alerts count · Soonest pack EOL · Clipped today.

```yaml
type: custom:ecoflow-panel-card
host: http://homeassistant.local:8787
refresh_seconds: 30
```

### Dashboard card (`custom:ecoflow-panel-dashboard`) — legacy v0.9.4

Tabbed interface — Dashboard / Battery / Forecast / Alerts.

```yaml
type: custom:ecoflow-panel-dashboard
host: http://homeassistant.local:8787
refresh_seconds: 30
default_tab: dashboard
```

## Why not replicate the entire PWA?

The full React dashboard lives in the add-on and ships as a PWA
— Add-to-Home-Screen it for app-like access. Replicating the
deepest views (strategy config, EVSE detail, interactive multi-day
forecast, per-circuit history) inside Lovelace would duplicate
work for marginal benefit; each Lit card has an **Open full
dashboard** link to drop you there.
