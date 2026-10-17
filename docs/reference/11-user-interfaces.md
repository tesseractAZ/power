## 11. User Interfaces: Web Dashboard & Telnet TUI

The ecoflow-panel add-on exposes the same underlying fleet telemetry through **two independent front ends**, each aimed at a different consumption context:

| UI | Transport | Where it runs | Auth posture |
|---|---|---|---|
| **React web dashboard (PWA)** | WebSocket `/ws` + REST `/api/*` | Browser at `:8787` or via HA Ingress sidebar | Same-origin; writes need ingress/same-origin/token |
| **Control-room TUI** | Raw telnet TCP `:2323` **and** browser xterm.js at `/console` | `nc`/`telnet` client, or browser | LAN-trust by default; opt-in operator login via `TUI_PASSWORD` (§11 2.3) |

Both read the **same `FleetSnapshot`** the server pushes over `/ws` on every snapshot change, plus the same analytics REST endpoints. This document is a features-and-navigation reference for each surface.

The server that backs both is a single Fastify instance (`server/src/index.ts`) listening on port **8787** (web + REST + WS), with the raw telnet listener on **2323**. Both ports are declared in the add-on `config.yaml`:

```yaml
ports:
  8787/tcp: 8787         # Web dashboard + REST API + WebSocket
  2323/tcp: 2323         # Telnet "control-room" TUI (off by default; optional login — keep on a trusted LAN)
ingress: true
ingress_port: 8787
panel_icon: mdi:home-battery
panel_title: Power
```

---

### The shared data spine: `/ws` snapshot + `/api/*` analytics

Every UI follows the same two-tier data model:

1. **Live snapshot over WebSocket** — the server sends a JSON frame `{ type: 'snapshot', serverNowMs, data: FleetSnapshot }` when the socket opens and again on every snapshot change (each MQTT message, poll result or alert update). This is event-driven, not a fixed 1 Hz tick. The body is serialized once per change and shared by every client; `serverNowMs` is stamped per send (v1.176.0). `FleetSnapshot` carries `devices` (per-device projections: DPU packs, SHP2 backup pool, generic small devices), `grid`, `alerts`, and `generatedAt`. This is the source of truth for all live tiles.
2. **On-demand analytics over REST** — heavier computed views (forecast, runway, degradation, self-consumption, per-circuit history, etc.) are fetched from `/api/*` endpoints on mount and/or a refresh interval. These are cached server-side and never streamed on the WS hot path.

The REST endpoints the web dashboard calls. The Lovelace card family that also consumed several of
them was removed in v1.47.0 (§3 below). The dashboard seeds from the `/ws` connect-time frame, not
from `/api/snapshot`.

| Endpoint | Consumed by | Payload |
|---|---|---|
| `/api/runway` | RunwayCard | reserve-runway projection |
| `/api/summary/today` | TodaySummary, SolarPanel | day energy totals |
| `/api/forecast` | ForecastCard, ForecastDetail, SolarResponseCard | day-ahead forecast |
| `/api/degradation`, `/api/round-trip-efficiency` | DegradationCard | capacity-fade report, RTE |
| `/api/curtailment` | CurtailmentCard | curtailment diagnostics |
| `/api/history`, `/api/circuit/history` | Sparkline/TrendChart, SolarPanel, CircuitModal | recorder time-series |
| `/api/alerts/history`, `/api/alerts/outcome` | AlertsPanel, AlertOutcomeButtons | cleared-alert log, outcome tagging |
| `/api/alert-settings`, `/api/chimes`, `/api/chime-config`, `/api/broadcast/config`, `/api/alert-preview` | Alert Console | alarm-audio administration |
| `/api/night-charge/status`, `/api/night-charge/cancel` | NightChargeCard (Strategy tab) | tonight's plan; cancel (write) |
| `/api/db-export` | DbExportButton (Strategy tab) | database-copy age; export (write) |
| `/api/house-panel` | HousePanelPin (Dashboard) | pin the house panel (write) |
| `/api/grid-veto/clear` | GridVetoClear (Dashboard) | clear a stale grid veto (write) |
| `/api/self-consumption`, `/api/thermal-events`, `/api/equipment-health`, `/api/shade-report`, `/api/soiling-decomposition`, `/api/string-mismatch`, `/api/ev-window-prediction`, `/api/charge-curve`, `/api/internal-resistance`, `/api/forecast-skill`, `/api/ambient-thermal-forecast`, `/api/confidence`, `/api/nws-alerts`, `/api/incidents`, `/api/weather/ensemble` | AdvancedInsightsCard | predictive/analytics detail |
| `/api/device/refresh-cloud/<sn>`, `/api/device/refresh-cloud-cooldown` | RefreshCloudButton (Shp2Card) | manual cloud-poll trigger (write) |

`/api/snapshot`, `/api/clipping`, `/api/forecast/probabilistic`, `/api/dispatch-plan`, `/api/notify/status`
and `/api/notify/test` remain on the server with no front-end consumer (Appendix A.7).

---

### 1. Web Dashboard (React PWA)

The web app is a Vite/React SPA served from the add-on's `:8787` root. Source lives in `web/src/`. The entry `App.tsx` renders a thin `NormalApp` that owns the WebSocket subscription and all derived views.

**Styling — Tailwind CSS 4 (v1.187.7).** Utilities come from Tailwind CSS 4 through the `@tailwindcss/vite` plugin; there is no `tailwind.config.js`, PostCSS config or Autoprefixer (Lightning CSS adds vendor prefixes in the build). `web/src/index.css` is the whole configuration:

- `@import 'tailwindcss' source(none)` with explicit `@source` globs (`../index.html`, `./**/*.{ts,tsx}`), the v3 `content` list, so only the app's own markup is scanned.
- `@theme inline reference` maps each colour token to the runtime theme's `R G B` triple (`bg-panel` → `rgb(var(--color-panel))`; §1.10). `inline` embeds the value in the utility and `reference` emits no Tailwind variable, because the `--color-*` names are already the triples. An opacity modifier (`bg-panel/40`) compiles to `color-mix(in oklab, rgb(var(--color-panel)) 40%, transparent)`, the same colour at that alpha. `--font-sans` / `--font-mono` likewise wrap the theme's font variables, and `amber-700`, the one default-palette colour in use, is pinned to v3's `#b45309`.
- Tailwind 4 behaviour that would have changed the rendering is set back to v3's: text-size line heights are absolute (`text-xs` → `1rem`; v4's ratios are inherited as ratios, so a `text-[10px]` badge in a `text-xs` row would lose 2.7px of line); `hover:` matches on every device (`@custom-variant hover (&:hover)`; v4 limits it to `(hover: hover)`); preflight keeps v3's default border colour (`#e5e7eb`), the pointer cursor on buttons, and the browser's padding on `td`, `th` and `option` (v4 zeroes every element's padding).
- The hand-written classes (`.card`, `.card-title`, `.takeaway`, `.kv*`, `.badge*`, `.bar`) and the High Contrast chrome sit in `@layer utilities` after the generated utilities, the cascade they had under v3: they win against a utility of equal specificity (`badge text-[9px]` stays 10px; `card border-bad/45` keeps the card's border) and lose to a `hover:` or `disabled:` one. v3 also emitted responsive variants after them; no element combines the two.
- `space-y-*` puts the gap on the earlier sibling at zero specificity in v4 (v3: on the later one, overriding its own margins). The overview digest, whose `SectionHeader` carries `mb-3`, uses `*:not-first:mt-4` to keep its 16px gap; no other `space-y` container has a child with its own vertical margin.

Browser floor: Safari 16.4, Chrome 111, Firefox 128 (cascade layers, `@property`, `color-mix()`). Without `color-mix()` every opacity-modified colour is invalid at computed-value time (fills vanish, borders fall back to the text colour); without cascade layers (before Safari 15.4 / Chrome 99) no Tailwind rule applies.

#### 1.1 Connection & rendering model

- **`useSnapshot()`** (`web/src/useSnapshot.ts`) opens a single WebSocket to `wsUrl()` and stores the latest `FleetSnapshot`. On close it reconnects with exponential backoff: `Math.min(15000, 500 * 2 ** retry)` ms, resetting on open. It exposes `conn` as `'connecting' | 'open' | 'closed'`, and (since **v1.176.0**) `clockOffsetMs`, the browser-minus-server clock offset: every frame carries `serverNowMs`, stamped by the server at SEND time, and the offset is the minimum sample since the socket opened (`nextClockOffset`), so a transport backlog shows as age rather than being absorbed as skew.
- **Header age and link pill** (since **v1.176.0**, pure logic in `web/src/freshness.ts`, run by `server/test/dashboardFreshness.test.ts`). "updated N ago" is the age of the OLDEST home reading on the server's clock (browser now − `clockOffsetMs`), re-rendered by a 5 s ticker. Home = every Smart Home Panel (by projection, or by `productName` before its first quota) plus the ONLINE SHP2-connected Cores (every online DPU on a cold boot). A reading's time is the device's `lastTelemetryAtMs` — a server clock moved only when telemetry content lands (REST quota or MQTT delta; not a `/status` flip, a failed poll or an empty payload; carried through the `/device/list` rebuild) — capped at `contentStaleSinceMs` for a panel replaying a cloud shadow; a device with no telemetry since the add-on started counts as never reported. The pill reads **live** only when the socket is open AND the oldest reading is under `TELEMETRY_STALE_MS` (3 min, the alarm engine's "Telemetry stale" threshold), **stale** when open but older, **linking** while connecting, **offline** with no socket. Before v1.176.0 the header printed `snapshot.generatedAt` (bumped by every poll FAILURE) and the pill was the socket's readyState alone — open, and green, through the 2026-09-22 03:17–03:28 cloud outage.
- **`api.ts`** builds every URL *relative to the directory the SPA was loaded from* so the same bundle works both on direct LAN (`/api/snapshot`) and under HA Ingress (`/api/hassio_ingress/<token>/api/snapshot`). `apiUrl('api/...')` prepends `baseDir()`; `wsUrl()` swaps `http→ws`/`https→wss` and appends `<baseDir>ws`.
- **Memoization** — `App.tsx` memoizes every derived view keyed on `snapshot` identity, so the ~1 Hz push only re-renders cards whose data actually changed; tab/theme toggles reuse stable references and skip re-render.
- **Code splitting** — the Dashboard is the eagerly-loaded landing page. Every other tab, plus `TrendChart`/`ForecastCard`/`AdvancedInsightsCard` (which pull in the ~540 kB recharts vendor chunk), is `React.lazy`-loaded so the entry bundle stays lean and first paint is fast.

#### 1.2 Tab navigation

The header renders a **5-tab pill** (reduced from 7 in v0.85.0). The tab set (`App.tsx` `tab` state):

| Tab label | Internal id | Component | What it shows |
|---|---|---|---|
| **Dashboard** | `dashboard` | inline in `App.tsx` | Landing overview (default) |
| **Solar** | `solar` | `pages/SolarPanel.tsx` | PV production + forecast + diagnostics |
| **Battery** | `thermal` | `pages/ThermalPanel.tsx` | Thermal + per-pack vitals + degradation |
| **Strategy** | `strategy` | `pages/StrategyPanel.tsx` | SHP2 dispatch config + circuit priority |
| **Alerts** | `alerts` | `pages/AlertsPanel.tsx` | Active/Learned/Cleared alerts + settings |

The **Alerts** tab carries a numeric badge: the `critical + high + medium` count of *threshold* alerts plus, since v1.182.0, every *learned* alert at Critical priority (other learned alerts are not counted). The badge colour follows the highest present ISA priority (bad → high → warn; a learned Critical colours it bad). It is computed by `alertBadge()` in `web/src/alertPriority.ts`.

Note the id/label mismatch: the **Battery** tab uses internal id `thermal` (historically the thermal panel). The former standalone "Predictive Insights" and "Alert Console" tabs were dissolved in v0.85.0 — predictive sections were relocated into their home pages, and the Alert Console became a sub-view of the Alerts page.

#### 1.3 Dashboard tab (landing page)

Rendered inline in `App.tsx`. Top-to-bottom:

- **GridVetoClear** (`components/GridVetoClear.tsx`, v1.184.0): the "Grid is back — clear" button. It appears only while the top-level `grid.vetoClearable` is set, so it shows even with no projected panel, and it posts `/api/grid-veto/clear` (write-auth).
- **HousePanelPin** (`components/HousePanelPin.tsx`, v1.185.0): appears while `snapshot.housePanel` is ambiguous or missing, and pins the panel night charge writes to with `POST /api/house-panel` (write-auth).

- **RunwayCard** (`cards/RunwayCard.tsx`) — reserve-runway headline, fetches `/api/runway` through `usePolled` (v1.176.0): a failed refresh keeps the last projection, and once it has missed 2.5 polls (`pollStale`) the header shows a `StaleNote` ("stale · as of `<time>`", naming the day when it is not today). `CurtailmentCard` follows the same pattern. Since **v1.177.0** its wording comes from the pure `cards/runwayText.ts` (run by `server/test/runwayCardText.test.ts`): with no reserve crossing in the horizon the headline is "reserve holds N h", labelled with the projection's lowest point (`troughKwh`/`troughAtMs`) and its margin over the floor — "forecast PV keeps up with the load" only when the pool never falls below its current level — and neutral (not green) when that margin is under `TROUGH_TIGHT_FRAC` (15%) of full. The grid note (`gridNote`) is shown only while `grid.backstopping` — the resolver's verdict, which HA's `runway_projection_islanded_only` and the runway alarm's audible gate also use; a grid merely reported `present` at the reserve floor, which the resolver distrusts, gets no "not a live countdown" note — and says "grid is supplying the house" only when `grid.importLive`, else "grid available as backup" (v1.186.3 wording; both followed by "these are outage projections (if the grid goes down), not a live countdown"). The header names the load model in use ("typical load", or "last-hour load" when `loadModelDegraded`); "Recent load" is captioned by `recentLoadBasis`; the PV tile's load says it excludes predicted EV (the Solar tab's forecast load says it includes it). Since **v1.187.19** the "Backup now" tile's "of N full" caption comes from `fullCaption`: on a measured basis it adds "measured X% of nameplate", "last measured" when a Core's held ratio was used, "lowest measured" for the lowest-known fallback, and nothing on the nameplate basis or from a server without the field; its tooltip (`fullTitle`) follows the same basis (measured capacity vs the panel's nameplate).
- **EnergyFlow** (`cards/EnergyFlow.tsx`) — animated SVG power-flow diagram; reads `snapshot.devices` + `snapshot.grid`, no fetch. Since **v1.175.0** every number comes from the pure `cards/energyFlowModel.ts` (run by `server/test/energyFlowModel.test.ts`). Two cadences drive it: the panel's figures (`homeGridWatts`, house load, channels) arrive in one frame every ~60 s; the Cores' `acIn`/`acOut` every ~10 s. Attribution uses the fresher meter first. Edges: Solar → Batteries `pv`; Grid → Batteries `gridToCoresW` = the Cores' draw (`acIn` over the Cores drawn in the Batteries node when the connection table exists; `grid.importWatts`, which fails safe to 0, when it does not — so a bench spare's wall charge is never drawn as grid); Grid → Loads `gridToHouseW`, drawn below the battery node; Batteries → Loads `coresToHouseW`. The Cores deliver only when their inverters report `acOut` ≥ 5 W. Cores idle → the grid carries the whole house (`gridState` is also active when the Cores deliver nothing while the house draws and the grid is present: the minute before the panel's next frame shows the main rising — an inference drawn only on the Cores' own meters, below). Since **v1.188.1** a connected Core with no reading of its own (cloud-offline, or listed without a projection) is metered at the panel while the panel's reading is live: its source slot's `sourceWatts` (negative = delivering into the panel, positive = charging from it) joins the Cores' `acOut` and `acIn`, its slot's net output joins the Batteries node's battery net, and its slot's battery percentage joins the SoC average. The Batteries title then counts it ("3 via panel", or "2 DPU, 1 via panel") and the subtitle reads "out" / "in" rather than "discharging" / "charging", since a slot meters the Core's AC exchange, which carries its PV as well as its packs. A Core that reports keeps its own (faster) meter and its slot is not read. A Core listed online whose own meter the server judges frozen (its slot's `dpuFrozen`, `shp2Membership.ts` `isSourceDpuFrozen`: content unchanged for 5 min — a quota fetch that keeps failing, or the cloud replaying its cached body) has no reading of its own either: its figures are left out and its slot is read. The house-on-grid inference needs at least one Core reporting on its own meter and a figure for every connected Core; otherwise every figure is from the panel's one frame and the measured main is drawn (live 2026-10-16: every Core offline, main 0 W, slots delivering 3.4 kW, and the card had drawn the 3.39 kW house as grid import). Cores the only source → their edge is the house load. Both → `coresToHouseW = min(acOut, load)`, `gridToHouseW = load − coresToHouseW`. The two edges into Loads always sum to the node; edges under 5 W are not drawn. The Grid node shows `homeGridWatts` unless it differs from the sum of its edges by more than max(500 W, 10%) — then the main is a frame behind and the node shows its edges. The Loads node is the SHP2 channel sum, NULL ("—") when the panel is silent (every channel `watts: null`: "panel not reporting") or frozen (offline, `contentStaleSinceMs` set, or — since v1.179.0 — `grid.panelFresh === false`, and since v1.188.1 any panel whose `readbackFresh` is false, the server's per-panel verdict that also covers a second panel: "panel data stale" — the server already zeroes such a panel's grid reading); the subtitle counts `pairedCircuits`, not channels. A frozen or silent panel's slots are never read. The Solar node is the Cores' own PV meters: "—" ("Cores not reporting") when no connected Core has a reading of its own, "N of M Cores" when some lack one. The Solar and Batteries nodes are not balanced against the house: PV is DC-side, the house AC-side, and conversion losses are not drawn.
- **TodaySummary** (`cards/TodaySummary.tsx`) — today's energy totals from `/api/summary/today` through `usePolled`. The response carries `dayEndMs` (v1.176.0: the local midnight that ends its day, from `setDate(+1)`, exact across daylight-saving changes); a payload whose day is over is dropped rather than shown under "since 12:00 AM" (`dayWindowExpired`, server-clock now estimated as `untilMs` + time since it arrived). The Solar tab's Today tile applies the same rule.
- **Shp2Card**: one card per Smart Home Panel (v1.185.0), with the house panel (`findHousePanel`) first and then any other panel. Each shows backup %, panel load, sources and the `RefreshCloudButton`.
- **DpuCard** per Delta Pro Ultra — with a `viaShp2` fallback so a cloud-offline DPU still shows the state the SHP2 reports over its wired link (battery %, contributed watts, AC-open, temp, errors).
- **ForecastCard** (lazy) — 24 h day-ahead forecast, `/api/forecast`.
- **Two TrendCharts** (lazy, recharts) — "Backup pool & panel load (24h)" and "DPU output & PV (24h)", each pulling `/api/history` per series over a 24 h / 60 s-bucket window.
- **Other devices** grid — `SmallDeviceCard` for anything that isn't the SHP2 or a DPU (UPS, EVSE, etc.), online-first.
- **Overview digest** — a compact `AdvancedInsightsCard` filtered to `['model-fit', 'self-consumption', 'incidents']`: model-fit R² trust scorecard, 7-day self-consumption, and clustered incidents. Each block is **empty-by-design on a healthy fleet** and simply doesn't render.

#### 1.4 Solar tab (`SolarPanel.tsx`)

Live PV surface. Summary tiles ("Producing now" split HV/LV, HV/LV channel counts), a **FlowDiagram** of DPUs → arrays → panels, per-DPU `DpuSolarCard`s, a stacked-area PV history chart (recharts `AreaChart` over merged `/api/history` series). Then the diagnostic cards:

- **SolarResponseCard** — forecast-vs-actual response (`/api/forecast`).
- **CurtailmentCard** — clipping/curtailment (`/api/curtailment`).
- **ForecastDetail** — the deep day-ahead breakdown (`/api/forecast`).
- **AdvancedInsightsCard** filtered to `['forecast-skill', 'weather-ensemble', 'equipment-health', 'shade', 'soiling-decomposition', 'string-mismatch']`. Ambient-thermal is on the Battery tab.

Producing/idle/no-sun/fault status labels classify each array.

#### 1.5 Battery tab (`ThermalPanel.tsx`, internal `thermal`)

Fleet thermal + per-pack detail. A **SummaryStrip** (Avg SoC, Avg SoH, hottest pack, cells balancing). A selectable per-pack **PackDetail** pane exposing every BMS reading: SoC, runtime, representative/cell-max/cell-min/board/shunt/MOS-max temps, pack voltage, open-circuit voltage, cell mean, plus **per-cell temperature and voltage sensor grids** (32 cells). Color banding thresholds are labeled inline (SoC `<25% / 25–50% / ≥50%`; SoH `<75% / 75–85% / 85–95% / ≥95%`; cell imbalance `≤5 / ≤20 / ≤50 / >50 mV`). Cloud-offline cores are flagged ("still wired and counted in the pool capacity"). Below: **DegradationCard** (`/api/degradation` + `/api/round-trip-efficiency`) and an `AdvancedInsightsCard` filtered to `['ambient-thermal', 'thermal-events', 'internal-resistance', 'charge-curve']` (equipment-health is on the Solar tab).

#### 1.6 Strategy tab (`StrategyPanel.tsx`)

SHP2 dispatch strategy of the house panel (`findHousePanel`, v1.185.0), read from its projection only while that panel is online; otherwise the tab shows a "SHP2 not available" card plus the predictive strip. With the panel online, top to bottom:

- **NightChargeCard** — tonight's night-charge plan from `/api/night-charge/status`, with the cancel button (§15.9).
- The predictive strip — `AdvancedInsightsCard` filtered to `['ev-window', 'nws']` (EV-charging window prediction + NWS weather alerts).
- A **Maintenance** block (v1.135.0) with `DbExportButton`: the published database copy and its age (`/api/db-export`).
- The live SHP2 state: tiles for mid-priority discharge floor SoC, backup reserve SoC (+enabled), solar backup reserve SoC, and raw SHP2 mode codes (smart-backup mode, backup mode, overload mode); a **circuit-priority ranking** (`PriorityRow` per paired circuit, ranked); a **charge time-task** panel (task type, repeat mode, charge ceiling/floor SoC, charge watts) with a **DayTimeline** of charge windows and a "now" marker.

#### 1.7 Alerts tab (`AlertsPanel.tsx`)

Uses a `SubNav` pill (`components/SubNav.tsx`) with four sub-views:

| Sub-view | Content |
|---|---|
| **Active** | Live threshold alerts, grouped, with `SubjectBoxes` breakdown and a low/medium/high/critical count tile row. |
| **Learned** | Model-driven detections (`source === 'learned'`): "Anomalies" (peer comparison & self-baseline) and "Forecasts" (runtime/degradation/day-ahead), each rendering the detection's statistical `facts`. Marked as *not* fixed-threshold rules. |
| **Cleared** | Cleared-alert history from `/api/alerts/history`, with a `ClearedFilter` sub-nav (All / Critical+High) and `AlertOutcomeButtons` posting to `/api/alerts/outcome`. |
| **Alert Settings** | Hosts the **Alert Console** panel (see below). |

Each active/learned alert row can carry a `PredictiveBadge`.

#### 1.8 Alert Console (`pages/AlertConsolePanel.tsx`)

The unified alarm-audio administration surface (v0.19.0), hosted inside the Alerts → Settings sub-view. It manages **three independent state objects**, each bound to its own endpoint and replaced wholesale on its own PUT (never merged, so one section can't clobber another):

- **`settings`** ← `GET/PUT /api/alert-settings` — per-ISA-priority on/off switches (with a Critical-silence confirmation dialog).
- **`data`** ← `GET/PUT /api/chimes` + `/api/chime-config` — tone-level assignments, uploaded `.wav` tone library, built-in tones.
- **`bcastCfg`** ← `GET/PUT /api/broadcast/config` — the broadcast master (audible on/off, live volume, override-vs-env-baseline).

**LAYOUT — one block per alert category (v1.60.0).** The page was previously organised by FUNCTION, which scattered a single severity's enable switch, tone and spoken preview across three separate cards. It is now:

1. **Global, above** — broadcast master (enable, override-vs-env-baseline disclosure, warns when off) and the Critical-silenced banner. **v1.61.0 removed the global preview-target toggle**: it was a MODE — set it to speakers once, forget, then press Preview on another card and get an unintended house-wide broadcast. Each category now carries its own **▶ In browser** and **▶ On speakers** buttons, so the click names its destination.
2. **One card per rung**, in `data.levels` order (critical → high → medium → low → clear), each carrying that category's badge/label/ISA/response/description, enable switch, tone `<select>` + tone preview, spoken `Preview ▶` + status, and the resulting "Will announce: …" text.
3. **Global, below** — the uploaded tone library (upload/list/delete, with the "in use:" cross-reference). **v1.61.0 removed the built-in tone audition grid**; the built-ins remain in every category's tone `<optgroup>`, and are auditioned in place with that category's **▶ Preview tone** button. One fewer place tones live.

**The 4-vs-5 asymmetry is explicit, not smoothed over.** Tone assignment is per **rung** (five, `clear` included; driven by `data.levels`). The enable switch is per **priority** (four; driven by `ALARM_PRIORITY_ORDER` and `settings.priorityEnabled`); there is no `priorityEnabled.clear`, so the all-clear card has no enable switch and says why. The spoken preview is per **rung** since v1.186.4: `POST /api/alert-preview` accepts `clear`, which speaks the recovery broadcast's words (`ALL_CLEAR_MESSAGE`, shared with `buildAlertMessage('green')`) over the all-clear tone, marked as a preview (`ALL_CLEAR_PREVIEW_MESSAGE`) so it is never the real recovery's exact audio. A priority card whose settings failed to load still withholds the spoken preview. The per-card tone button is labelled **▶ Tone in browser** (v1.186.4): it plays the bare tone in the browser only; the speakers hear a tone through **▶ On speakers** (tone + spoken message).

Tone choices per rung are the rung klaxon (`KLAXON_FILE` in `web/src/alarmLevels.ts`, mirroring the server's `KLAXON_FOR_LEVEL`, served from `audio/<file>.wav`; the mirror is pinned by `test/alarmLevelWebMirror.test.ts`), a named built-in tone, or an uploaded custom tone — each previewable in-browser via a HEAD precheck that distinguishes a missing file from an autoplay block. A bad/deleted tone falls back to the rung klaxon **server-side** — an alarm is never silenced by a missing file.

**Error placement.** Page-level failures (upload, delete, broadcast master, library preview) render in the header. A failure that belongs to one category — a failed enable-toggle PUT, a failed tone assignment, a missing tone file — renders on that category's card, next to the control that raised it.

**Category colours (v1.187.8).** Each category card is framed in its rung's colour (critical red, high orange, medium amber, low blue, all-clear green — `ACCENT_BY_TOKEN.ring`), the Critical-silenced banner is framed and tinted red, and the Critical-silence dialog is framed red. Until v1.187.8 none of these rendered: `index.css` emits its hand-written `.card` class (`bg-panel border-line p-4 …`) after Tailwind's generated utilities, so at equal specificity `.card`'s seam colour and panel face overrode a `border-bad/45` or `bg-bad/10` on the same element, and every one of these cards drew the neutral seam on the panel face in both themes. The colour utilities on a `.card` now carry Tailwind's `!` (important) modifier, which wins regardless of order; `.card` itself is unchanged, and so is every card without one. The same rule holds for any utility that sets something `.card` sets — border colour, background, padding, radius, shadow, position: on a `.card` it needs `!`.

#### 1.9 Glossary tooltips

`web/src/glossary.ts` defines a `GLOSSARY` map (`def('soc|state of charge', '…')`, ~150 terms across battery/power-flow/MPPT/forecast domains) and `installGlossaryTooltips()`, mounted once in `App.tsx`. Rather than hand-adding `title=` to every label, a `MutationObserver` walks the DOM, finds **text-only leaf elements** (non-SVG) whose normalized text matches a glossary key, and sets their `title`. New pages/components are covered automatically. Rescans are throttled to at most one per `RESCAN_THROTTLE_MS = 1000` (trailing-guaranteed), so the ~30 childList mutations/sec from the live re-render don't thrash it. `normalize()` drops a trailing `· …` or `( …)` and lowercases before lookup.

#### 1.10 Themes

`web/src/theme.ts` + `ThemeToggle`. Two themes, switched via a header pill and persisted to `localStorage`:

- **Default** — "Light industrial HMI / control-room palette".
- **High Contrast** — "High-contrast dark palette — deep navy + cyan + amber accents" (lazy-loads its Google Fonts on first selection).

The palette itself lives in CSS variables under `[data-theme="..."]` selectors in `index.css`; `applyTheme` sets the attribute. Tailwind's colour utilities read the same triples (`@theme inline reference`, §1 intro). recharts needs literal color strings (Tailwind classes can't reach it), so `UI`/`CHART`/`HUES`/`SERIES_PALETTE` are **Proxies** that resolve the current theme's CSS variable (a space-separated `R G B` triple → hex) on every access, so charts re-color on theme toggle through React's normal re-render.

#### 1.11 PWA + Ingress

- **Manifest** (`web/public/manifest.webmanifest`) — `name: "Power"`, `display: standalone`, `theme_color: #0b1014`, single maskable SVG icon. Plus `apple-mobile-web-app-capable` meta so it installs to the iOS home screen as "EcoFlow".
- **Service worker** (`web/public/sw.js`, cache `ecoflow-panel-v0.11.2`) — **never** caches `/api/*` or `/ws` (matched anywhere in the path so it works under ingress too); the HTML document is **network-first** (so a redeploy's new content-hashed bundles are always found — fixes the Safari white-screen after redeploy); content-hashed JS/CSS/img/fonts are **stale-while-revalidate** (immutable). Registered with a relative path so it resolves under both LAN and ingress.
- **HA Ingress** — `config.yaml` sets `ingress: true`, `ingress_port: 8787`. The Supervisor reverse-proxies the panel into HA's session as a sidebar item titled **Power** (icon `mdi:home-battery`). Because `api.ts` builds all URLs relative to `baseDir()`, the SPA, its WS, and its service worker all work behind the `/api/hassio_ingress/<token>/` prefix without change. Direct LAN access on `:8787` still works simultaneously.

---

### 2. Control-room TUI (telnet + browser)

A SCADA/power-plant-styled terminal UI. The per-session render/input state machine (`server/src/telnet/session.ts`, class `TuiSession`) is **transport-agnostic** and is driven by two front ends that share it plus the same refreshed data caches (`dataProvider.ts` — energy totals, day-ahead forecast, degradation):

- **Raw telnet TCP** (`telnet/server.ts`) on **:2323** — speaks just enough telnet IAC to put a client in character-at-a-time mode + NAWS (window-size) negotiation, enters the alt-screen buffer, and renders at 1 Hz.
- **Browser web terminal** (`telnet/wsConsole.ts`) at **`/console`** on `:8787` — serves a self-contained xterm.js page over a WebSocket (`/console/ws`), vendoring `xterm.js`/`xterm.css` from `node_modules` (no CDN). Suitable for an HA `panel_iframe` at `http://<host>:8787/console`.

#### 2.1 How to connect

```
nc <host> 2323          # or:  telnet <host> 2323
```

Gated by `TELNET_ENABLED` (bare-env default on; the SHIPPED add-on options default is `TELNET_ENABLED: false` — enable it in the add-on configuration). Host defaults to `::`, port to `2323` (`config.ts`: `TELNET_HOST`, `TELNET_PORT`). The browser variant needs no client — open `/console`.

By default the TUI is **unauthenticated** on both transports — read-only telemetry meant for a trusted LAN (the `ports_description` explicitly warns so); setting `TUI_PASSWORD` enables the operator login on both (§2.3). The `/console/ws` upgrade rejects a cross-origin `Origin`, accepting same-origin, LAN, and missing-Origin. The blanket `*.ui.nabu.casa` match was **removed in v1.47.3** as a CSWSH hole — a wildcard would let any HA Cloud tenant pass a gate that is not same-origin-protected. Remote access is via HA ingress (auth-gated) or an exact-match `TUI_TRUSTED_ORIGINS` entry.

#### 2.2 Hardening (DoS guards)

Both transports cap concurrency and reap idle sessions so a LAN flood can't spawn unbounded 1 Hz render timers on the single-threaded event loop:

- Telnet: `MAX_TELNET_CONNS = 16`, `TELNET_IDLE_TIMEOUT_MS = 5 min` (reset on any inbound byte; over-cap connections get a banner and close). Inbound buffer capped at 4096 bytes.
- WS console: parity `MAX_WS_SESSIONS` / `WS_IDLE_TIMEOUT_MS` + `maxPayload`-bounded frames.

#### 2.3 Operator login (v1.46.0)

When a console password is configured (`TUI_PASSWORD` option, non-empty), every
session — telnet and `/console` alike — starts at a login prompt (`telnet/login.ts`)
rendered in the same pseudo-LCD lettering as the console brand. `TUI_USERNAME`
defaults to `operator` when left empty. The input state machine lives in the
transport-agnostic session driver, so both transports share one implementation:
printable keys type into the active field (password echoes masked), backspace
edits, TAB switches fields, ENTER advances username → password → verify.
Credential comparison is constant-time (fixed-length buffers through
`timingSafeEqual`, so neither content nor length leaks). Brute-force is
bounded twice: three failed attempts disconnect the session, and a
cross-session sliding-window throttle (10 failures per 10 minutes, shared by
both transports) refuses further submits outright while saturated. `q` does not quit at the prompt (it is a legitimate credential
character); `Ctrl-C` always disconnects. With no password configured the
session opens straight into the console — the login layer is opt-in, and
classic telnet is unencrypted, so the prompt is LAN-level access control, not
transport security.

#### 2.4 The console (`telnet/plant/`)

v1.46.0 consolidates the TUI to a **single interface**: the v0.9.13 mode
chooser and the legacy Summary console (`telnet/screens.ts`) are removed, so
every connection lands in the same SCADA-style console, there is one theme to
maintain, and the full terminal is spent on the console itself.

Every screen shares a top status header (timestamp, SYS.UPTIME, mode, alarm
count), an alarm banner (newest unack'd, keyed on 4-tier ISA-18.2/IEC-62682
priority), a body, and a footer hotkey legend. `PLANT_SCREENS`
(`plant/types.ts`), selected with digits **1–6**; **TAB** cycles to the next
screen. `Q`/`Ctrl-C` disconnects.

| Key | Id | Label | Content |
|---|---|---|---|
| 1 | `console` | CONSOLE | Bridge view: mimic power-flow diagram (PV→BATTERY┐├BUS├LOADS └GRID), banded gauges, headline tag rows (BUS.MAIN.V/HZ, PV.ARRAY.P, BATT.SOC, LD.PANEL.P, EVSE.P, GRID.AC.P). |
| 2 | `gen` | GEN | Per-DPU "generator" detail — `←/→` selects DPU, `↑/↓` selects pack (pack count is per-DPU, 1–5). |
| 3 | `bus` | BUS | Bus/interconnect detail. |
| 4 | `pv` | PV | Solar array detail. |
| 5 | `alm` | ALARM | Scrollable alarm list (`↑/↓` scroll). |
| 6 | `trd` | TRENDS | Recorder-backed trend view (uses the `Recorder`). |

The grid state resolver (`gridState.liveGridBackstop`) drives the console's ACTIVE / AVAILABLE / OFF-GRID grid annunciation.

#### 2.5 Large-format graphics (v1.46.0)

Two pure primitive modules feed the screens; both emit plain strings (callers
colorize whole segments, and visible width equals `.length` before styling):

- **`telnet/bigfont.ts`** — a 5-row pseudo-LCD block font (digits, `%`, `kW`,
  `.`, `:`, `-`, `+`, `/`, `h`). `bigText(s)` returns 5 equal-width rows;
  `bigTextWidth(s)` sizes without rendering.
- **`telnet/gauges.ts`** — `hbar` (eighth-block horizontal bar, width×8-step
  resolution), `vscale` (eighth-height column chart), `braille` (2×4-dot
  braille sparkline — 4 vertical levels per half-column), `tile` (3-row
  ISA-annunciator window), `fracLabel`. All total: NaN/Infinity/degenerate
  ranges clamp rather than throw.

Screen usage — every placement is width/height-adaptive and degrades to the
pre-v1.46.0 rendering when the terminal is too small (80×24 stays clean):
CONSOLE gains a big-digit headline band (fleet SoC / PV kW / LOAD kW) at
≥ 96×32 plus an always-on full-width POOL `hbar` gauge; TRENDS strips are
full-width `braille` sparklines; ALARM gains a 7-window annunciator header
(BATTERY SOLAR THERMAL SHP2 GRID COMMS SYSTEM — lit red for critical, yellow
for warning, dark-but-visible otherwise, ISA-style); GEN pack rows gain `hbar`
SoC bars.

#### 2.6 Rendering internals

`TuiSession.draw()` builds a frame body (`HIDE_CURSOR + CURSOR_HOME`, per-line `CLEAR_EOL`, trailing `CLEAR_BELOW`), computes a 32-bit **FNV-1a hash** of it, and **skips the write entirely** when the body is byte-identical to the previous frame (zero bandwidth, zero flicker). Frames are wrapped in synchronized-output escapes (`BEGIN_SYNC`/`END_SYNC`, terminal mode 2026) so supporting terminals flip atomically. Draws are serialized (`drawing`/`drawPending`) so a resize + 1 Hz tick can't interleave. Size is clamped to 60–200 cols × 16–80 rows. On disconnect the session restores the user's primary screen buffer (`?1049l`) so their terminal returns to what was there before.

---

### 3. HACS Lovelace cards (moved)

The note on the removed HACS Lovelace cards is frozen, unedited, in
[operations-audits.md](../history/operations-audits.md#3-hacs-lovelace-cards--removed-v1470).

