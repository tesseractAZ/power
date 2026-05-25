# EcoFlow Panel — Lovelace cards

This HACS plugin ships **two** Lovelace cards for your **EcoFlow Panel**
add-on. Pick one or use both:

| Card | When to use |
|---|---|
| `custom:ecoflow-panel-card` | Compact stats glance — 12 headline numbers in a single panel |
| `custom:ecoflow-panel-dashboard` (v0.9.4) | Multi-tab interface — Dashboard / Battery / Forecast / Alerts |

For the deepest analytics (interactive charts, per-cell voltage,
strategy config) the PWA at `:8787` remains the full surface — both
cards have an **Open full dashboard** button.

## Stats card (`custom:ecoflow-panel-card`)

A focused Home Assistant Lovelace card that pulls the 12 most important
live numbers from your **EcoFlow Panel** add-on and renders them inside
HA — no need to bookmark `:8787`. For deep analytics (Predictive Insights,
Advanced Insights, charts) tap the **Open dashboard →** button to launch
the full PWA.

## What you see

PV right now · Panel load · Backup pool % · Runway to reserve · Projected
SoC low · Grid status · PV lifetime + CO2 avoided · Round-trip
efficiency · Tariff savings · Alerts count · Soonest pack EOL · Clipped
today.

Each tile colour-codes status: green = healthy, amber = watch, red = act.

## Install via HACS (Frontend → Custom repositories)

1. **HACS → Frontend → ⋮ → Custom repositories**
2. Add `https://github.com/tesseractAZ/ecoflow-panel` as **Type: Plugin**
3. Search for "EcoFlow Panel Card" and install it
4. Add to your Lovelace dashboard:
   ```yaml
   type: 'custom:ecoflow-panel-card'
   host: http://homeassistant.local:8787
   refresh_seconds: 30
   ```

## Install manually (no HACS)

1. Copy `dist/ecoflow-panel-card.js` to `<config>/www/ecoflow-panel-card.js`
2. **Settings → Dashboards → Resources → Add resource**
   - URL: `/local/ecoflow-panel-card.js`
   - Resource type: JavaScript Module
3. Add the YAML snippet above to your dashboard

## Options

| Option | Default | Notes |
|---|---|---|
| `host` | `http://<current hostname>:8787` | Where the EcoFlow Panel add-on lives |
| `refresh_seconds` | `30` | Poll interval (min 5) |
| `title` | `EcoFlow Panel` | Card header text |

## Dashboard card (`custom:ecoflow-panel-dashboard`) — v0.9.4

Bigger sibling of the stats card. Four navigable tabs covering the
high-value views inline:

- **Dashboard** — PV/load/backup tiles + per-DPU compact tiles + alert summary
- **Battery** — per-pack SoC/SoH/temp + degradation summary + ML composite risk (heuristic + trained LR + novelty)
- **Forecast** — next-24h PV mini-chart (CSS bars, no chart-lib dep) + key projections
- **Alerts** — full active alerts list with severity colour-coding

Same install path as the stats card. Add to a Lovelace dashboard:

```yaml
type: 'custom:ecoflow-panel-dashboard'
host: http://homeassistant.local:8787
refresh_seconds: 30
default_tab: dashboard       # dashboard | battery | forecast | alerts
```

For manual install (no HACS), copy
`dist/ecoflow-panel-dashboard.js` to `<config>/www/` alongside the
stats card and add a second JavaScript Module resource for it.

## Why two cards and not the full dashboard?

The full React dashboard lives in the add-on and ships as a PWA — you
can Add-to-Home-Screen it for app-like access. Replicating the entire
Predictive Insights / Advanced Insights / per-circuit / strategy views
inside Lovelace would be a multi-week Web Components rewrite that
duplicates work for marginal benefit.

The **stats card** focuses on the quick glance. The **dashboard card**
covers the next layer down — most-asked questions per tab. For the
deepest data (SVG flow diagrams, interactive 24h charts, per-cell
voltage detail, strategy config) the PWA is still the right answer
and lives one button-click away.
