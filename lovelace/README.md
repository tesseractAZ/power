# EcoFlow Panel Card

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

## Why a separate card and not the full dashboard?

The full React dashboard lives in the add-on and ships as a PWA — you
can Add-to-Home-Screen it for app-like access. Replicating the entire
Predictive Insights / Advanced Insights / per-circuit / strategy views
inside Lovelace would be a multi-week Web Components rewrite that
duplicates work for marginal benefit (most users will open the PWA
when they want the deep view).

This card focuses on what HA users actually want in their main
dashboard: a glance at the headline numbers, and a one-click jump to
the full thing when they need it.
