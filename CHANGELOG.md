# Changelog

All notable changes to this add-on are listed here. Versioning follows
[Semantic Versioning](https://semver.org).

## 0.9.25 — 2026-05-25

Starfleet UI bug-bash. Live in-browser debugging via the built-in
preview surfaced six independent issues — the worst of which crashed
the entire bridge when the user clicked SCIENCE.

### Fixes

- **Science station no longer crashes.** `/api/pack-risk/v2` returns
  `composite0to100` + nested `heuristic.tier`/`heuristic.score0to100`,
  but Science was declared against the v1 flat shape (`p.tier`,
  `p.score0to100`). When the real response landed, `p.score0to100.toFixed()`
  threw `Cannot read properties of undefined (reading 'toFixed')` and
  propagated up through `<Suspense>` to blank the entire page. Adapted
  the type + access pattern to v2, added defensive `?? '— —'` fallbacks
  throughout the pack-risk table.

- **Station error boundary.** Even with the Science fix, any future
  bug in any other station would have the same blank-the-whole-bridge
  failure mode. Added a class-based `StationErrorBoundary` that wraps
  every station, keyed on the active station id. A thrown station now
  renders a TMP-styled "STATION MALFUNCTION" panel with the error
  message; switching to another station resets the boundary.

- **STARDATE was negative.** The original formula anchored to the TNG
  era (year 2364 = stardate 41000); for present-day calendar dates
  (mid-2026) it produced `-296603.8`. Re-anchored to TMP-era: 2026 maps
  to ~7000 (the actual TMP film opened at STARDATE 7411.4), +100 per
  real year, + 1000 × day-fraction. Now reads `7396.2` — positive,
  plausible, in-genre.

- **Header layout fits.** The ship-id column used a single very long
  prefix string ("UNITED FEDERATION OF PLANETS · STARFLEET COMMAND")
  that letter-spacing puffed up to wrap on three lines, and the right-
  side cluster (stardate / registry / condition / sound / theme) was
  cropping the theme toggle off the right edge of the viewport. Split
  the prefix into two declared `nowrap` lines, added `flex-wrap` +
  `flex-shrink-0` so the right cluster moves to a second row on
  narrower viewports instead of clipping.

- **Ring gauge center label no longer hidden behind the number.** The
  `centerUnit` text (e.g. "PERCENT") sat at `cy + size * 0.16` — close
  enough to the big `centerNumber` text + drop-shadow glow to be half-
  covered by it. Moved to `cy + size * 0.24` so it sits clearly below.

- **Footer reflects real state.** Previously always said "ALL DUTY
  STATIONS REPORTING" regardless of socket or alert level. Now derives:
  - socket not open → "SUBSPACE LINK · DEGRADED"
  - red alert → "RED ALERT · DAMAGE CONTROL ENGAGED"
  - yellow alert → "YELLOW ALERT · CONDITION ELEVATED"
  - otherwise → "ALL DUTY STATIONS REPORTING"

- **CONN "DURATION — HR" / "TO RESERVE FLOOR ∞ HR" while charging.**
  When the fleet is charging, both `hoursToReserve` and `hoursToEmpty`
  are null (battery isn't depleting toward anything). Previously the
  Field showed "— HR" / "∞ HR" — technically correct but unhelpful.
  Now shows green "CHARGING" when net battery is < −5 W, falls back
  to the prior copy otherwise.

### Verification

- Confirmed in-browser against the live HA Pi backend via the dev
  preview. Clicked through every station — none crash, all render,
  data populates within ~1 s of mount.
- Typecheck clean, Vite build clean.

## 0.9.23 — 2026-05-25

**Music Assistant broadcast path.** Detailed log analysis of v0.9.22's
first real broadcast revealed the cause of the inter-speaker delay
the user reported: nearly all configured `media_player` entities are
**proxied through Music Assistant** (visible in the discover output
— "Music Assistant Queue" source on family-room soundbar, garage,
both thermostats, and HomePod). Music Assistant intercepts every
`media_player.play_media` call, transcodes the WAV per speaker, and
**streams to each device individually** — explaining both the 7 s
broadcast duration and the audible gap between rooms.

Music Assistant has a purpose-built **`play_announcement`** service
designed for exactly this — it plays SIMULTANEOUSLY across all
targets, returns immediately, and handles volume override + restore
atomically. This release switches to it when available.

### Backend auto-detection

On startup (and on each test) the broadcast monitor queries HA's
service catalog (`GET /core/api/services`) and checks for
`music_assistant.play_announcement`. If found, it routes broadcasts
through MA. Otherwise it falls back to the v0.9.18 `media_player.play_media`
path (still works fine for non-MA setups).

### New config option

`BROADCAST_USE_MUSIC_ASSISTANT: auto | music_assistant | media_player`
(default `auto`). Force one path or the other if the auto-detection
makes the wrong call.

### Test-endpoint cooldown

Rapid test clicks during v0.9.22 debugging produced the cascading
**502 responses** seen in the log — each retry collided with the
in-flight MA stream and overwhelmed its queue. v0.9.23 adds a
**10-second cooldown** to `POST /api/broadcast/test`. The UI
disables the buttons + shows a countdown when the cooldown is
active. Live alert-triggered broadcasts are not affected.

### Successful broadcasts now logged

Previously only errors were logged. Each broadcast now logs:

```
broadcast: red via music_assistant → ok in 184ms (6 target(s))
```

vs. the old serial path:

```
broadcast: red via media_player → ok in 6995ms (6 target(s))
```

The duration is the single best diagnostic — < 500 ms means MA
fired; > 3 s means we're on the slow path.

### BroadcastPanel UI

The OPS-station panel now shows a `BROADCAST PATH` row indicating
which service is in use (`◉ MUSIC ASSISTANT` vs `◐ MEDIA PLAYER`)
plus the cooldown timer on the test buttons.

### Tests

77 server tests (76 → 77, +1 covering the new env-parse).

## 0.9.22 — 2026-05-25

Hotfix — **the Starfleet UI never actually rendered**. Selecting
"Starfleet" in the header toggle swapped the CSS palette (so the page
went dark + amber) but the dashboard layout stayed mounted underneath
it. The StarfleetBridge component never appeared.

### Root cause #1 — useTheme wasn't a shared store

`useTheme()` was a plain `useState` hook. Each call (one in `App`, one
in `ThemeToggle`) created its **own** state instance. When
`ThemeToggle.setActive('starfleet')` fired, only `ThemeToggle`
re-rendered. App's separate `useTheme` instance still saw
`theme === 'default'`, so its `if (theme === 'starfleet') return
<StarfleetBridge/>` branch stayed false. The CSS side-effect (data-theme
attribute swap, font load) did fire because `applyTheme()` was called
from `ThemeToggle`'s useEffect — but the component tree never swapped.

Fix: theme state is now a module-level singleton with a Set of
subscribers. Every `useTheme()` consumer subscribes via
`useSyncExternalStore`, so an update from any caller re-renders every
subscriber consistently. CSS + localStorage side-effects run exactly
once per change inside the setter.

### Root cause #2 — App.tsx Rules-of-Hooks violation

App's early return for the Starfleet branch sat above a long list of
other hooks (useSnapshot, useState×3, useEffect, etc.). With the
singleton fix above, switching themes now actually triggers App to
re-render — and the hook count differs between the two branches,
throwing **"Rendered fewer hooks than expected"**. Split App into a
thin theme router that calls only useTheme + mounts either
`StarfleetBridge` or the new `NormalApp` component (which owns all the
original hooks). Each subtree's hook ordering is stable across its own
re-renders.

### Effect

- Clicking **Starfleet** in the theme toggle now actually mounts the
  StarfleetBridge component.
- Flipping back to Default / Babylon 5 cleanly unmounts the bridge
  and remounts the regular dashboard.
- No hooks-mismatch warnings in the console.

### Verification

- Vite build clean, no new chunks.
- 68 server tests still pass.

## 0.9.21 — 2026-05-25

**Diagnostic hotfix:** when a Home Assistant service call fails, surface
HA's actual error message instead of just the HTTP status code.

Discovered while debugging the first real broadcast: HA returned 500
on `media_player.play_media`, our error message was the useless
`"play_media: HA returned 500"`. HA itself returns a JSON body like
`{"message":"unable to fetch http://..."}` on every failure — we just
weren't reading it. Now we do, and the error becomes immediately
actionable (in this case it surfaces the audio-URL-unreachable cause
that the user has to fix by setting `BROADCAST_AUDIO_BASE` to HA's
direct IP instead of `homeassistant.local`).

Single-file change in `server/src/haService.ts` — `callHaService`
parses the response body on non-2xx, extracts `.message` if present,
and appends `: <detail>` to the error string. Applies to every helper
that goes through `callHaService` — discovery, broadcast, future
service-call paths.

## 0.9.20 — 2026-05-25

**Hotfix:** add the missing `homeassistant_api: true` flag to
`config.yaml`. Without it, `SUPERVISOR_TOKEN` is granted but doesn't
have permission to hit `http://supervisor/core/api/*` — every
broadcast attempt and every `GET /api/broadcast/discover` call
returned `SUPERVISOR_TOKEN missing or HA unreachable`.

This is the standard add-on opt-in for Core REST API access. Adding
it unlocks the entire v0.9.18 + v0.9.19 broadcast feature set against
the real HA instance.

## 0.9.19 — 2026-05-25

**Speaker discovery for v0.9.18 broadcasts.** The previous release
required the user to know their `media_player` entity IDs by heart
when filling in `BROADCAST_TARGETS`. This release adds a "Sensor
Sweep" button that queries Home Assistant directly and lists every
speaker it knows about, color-coded by family (HomePod, Sonos, Cast,
Echo, Apple TV, AndroidTV) with friendly names + live state +
current volume.

### How it works

The add-on already has `SUPERVISOR_TOKEN` (HA grants it to every
add-on for free), so we hit `GET http://supervisor/core/api/states`,
filter for entities starting with `media_player.`, and classify each
by inspecting the platform attribute + entity-ID hints. The list is
sorted with currently-configured targets first, then by family, then
alphabetical.

### Usage

In the Starfleet bridge → **OPS** station, the **SHIPWIDE INTERCOM**
panel now has:

1. **◐ SENSOR SWEEP** button — fetches the live media_player list
2. **Checkbox list** with family icon + friendly name + entity ID + state
3. **◈ COPY (n) FOR BROADCAST_TARGETS** button — copies the
   comma-separated entity-ID string ready to paste into the add-on
   Configuration tab
4. Currently-configured speakers pre-check on load so the user sees
   their existing selection

### New endpoint

`GET /api/broadcast/discover` returns:
```json
{
  "supervised": true,
  "count": 8,
  "speakers": [
    {
      "entity_id": "media_player.living_room",
      "friendly_name": "Living Room",
      "family": "sonos",
      "state": "playing",
      "volume_level": 0.35,
      "source": "Spotify",
      "currently_configured": true
    },
    …
  ]
}
```

Family classifications: `sonos`, `homepod`, `apple_tv`, `cast`,
`echo`, `androidtv`, `unknown`. Useful for both the in-bridge UI and
external scripting (e.g. `curl http://homeassistant.local:8787/api/broadcast/discover | jq`).

### No new configuration

The discovery endpoint is read-only and exposes only entity IDs,
friendly names, and current state — same info already visible in HA's
Developer Tools → States. No new env vars, no new tokens, no changes
to the existing v0.9.18 broadcast logic.

## 0.9.18 — 2026-05-25

**Ship-wide audible broadcasts.** v0.9.17 added Starfleet alert sounds
to the operator's browser. But operators aren't always at their
station — so this release pushes the same alert klaxons to every
HomePod + Sonos speaker throughout the property, via Home Assistant's
`media_player` service.

### How it works

We're already an HA add-on, so we get `SUPERVISOR_TOKEN` for free —
that grants REST access to HA Core at `http://supervisor/core/api`.
We use that to call `media_player.play_media`, `media_player.volume_set`,
optional `tts.SERVICE`, and `sonos.snapshot` / `sonos.restore` so we
don't trample existing music.

On startup we synthesize four TMP-authentic WAV files from primitive
oscillators (no samples shipped, zero licensing entanglement):

- **`red-alert.wav`** — 6 cycles of 440/660 Hz square-wave alternation
  (~3 s). Higher cycle count than the in-browser version because
  speakers are typically further from the listener.
- **`yellow-alert.wav`** — 880 → 660 Hz descending sine bell
- **`all-clear.wav`** — A4 → D5 → A5 ascending sine sweep
- **`boatswain.wav`** — the iconic two-tone sweep that PRECEDES any
  shipwide verbal address ("Captain to the bridge…") — plays only
  when TTS is configured

WAVs live at `/data/audio/` and are served via Fastify static at
`/audio/*.wav`. Speakers stream from there.

### Broadcast policy

The same transition-driven logic as the in-browser sounds, but with
physical-speaker etiquette baked in:

- Fires on **condition transitions**, not per-tick (GREEN→RED, etc.)
- A **new** critical alert while already RED fires a shorter re-alert
- **First-tick is silent** — joining an already-RED state at boot
  doesn't klaxon the house
- **Min severity gate** (default `critical`) — yellow alerts don't
  broadcast unless explicitly enabled
- **Quiet hours** suppress warning/info; critical bypasses
- **Sonos snapshot/restore** wraps each broadcast so music resumes
- **Volume override** applied via `media_player.volume_set` before
  play, so a sleepy speaker doesn't no-op the alert

### Optional verbal announcement

If `BROADCAST_TTS_SERVICE` is set (e.g. `tts.google_translate_say`,
`tts.cloud_say`, `tts.piper`), each broadcast plays:
1. Boatswain whistle (pre-announcement chime)
2. Klaxon
3. TTS situational message ("Red alert. Critical condition,
   <alert title>")

Klaxon-only mode (no TTS) ships zero verbal noise, matching the
ambient-alarm style some operators prefer.

### Test surface

- `POST /api/broadcast/test` body `{ level: "red" | "yellow" | "green" }`
  fires a test transmission (bypasses all gates)
- `GET /api/broadcast/status` returns config + last-broadcast outcome
- **OPS station in the Starfleet bridge** now has a "SHIPWIDE INTERCOM"
  panel with three one-tap test buttons (RED ALERT / YELLOW ALERT /
  ALL CLEAR), config snapshot, and last-broadcast outcome. Operators
  can verify the klaxon chain weekly without waiting for a real alarm.

### Configuration

All knobs in the HA add-on Configuration tab, all opt-in:

```
BROADCAST_ENABLED: true
BROADCAST_TARGETS: "media_player.living_room, media_player.kitchen,
                    media_player.master_homepod"
BROADCAST_AUDIO_BASE: "http://homeassistant.local:8787"
BROADCAST_VOLUME: 0.6
BROADCAST_MIN_SEVERITY: critical
BROADCAST_QUIET_HOURS: "22-06"
BROADCAST_TTS_SERVICE: "tts.google_translate_say"
BROADCAST_TTS_LANGUAGE: en-US
BROADCAST_SONOS_RESTORE: true
```

### Architecture

- `server/src/audioAssets.ts` — WAV synthesis, Buffer-based RIFF
  writer, idempotent generation to `/data/audio/`
- `server/src/haService.ts` — `callHaService(domain, service, data)`
  via Supervisor REST + `SUPERVISOR_TOKEN`. Returns `{ ok }` instead
  of throwing so the broadcast loop never crashes on a HA glitch.
- `server/src/broadcast.ts` — env-driven config, `startBroadcastMonitor()`
  with 10 s tick polling alerts for condition transitions
- `server/src/index.ts` — generates audio at startup, registers
  `/audio/*` static route, starts monitor, exposes test + status endpoints
- `web/src/starfleet/components/BroadcastPanel.tsx` — the OPS-station
  test panel
- `rootfs/etc/services.d/ecoflow-panel/run` — exports all `BROADCAST_*`
  env vars from add-on Configuration

### Tests

`broadcast.test.ts` covers config parsing (env-var → struct), condition
derivation (alerts → green/yellow/red), and end-to-end audio asset
synthesis (writes WAVs, validates RIFF headers, idempotence). 76
server tests total (68 → 76), all pass.

## 0.9.17 — 2026-05-25

**Starfleet bridge gets audio.** TMP-era alert klaxons, chimes, and UI
tones — synthesized at runtime with the Web Audio API. No sample files
shipped (zero licensing entanglement, +0 KB to the asset bundle beyond
the synthesis code itself).

### Sound design

Each sound is generated from primitive oscillators + envelopes,
modeled on what the actual TMP-era bridge would play:

| Trigger | Sound | Synthesis |
|---|---|---|
| **GREEN/YELLOW → RED** transition | **Red Alert klaxon** | Square wave, 440 Hz / 660 Hz two-tone alternation, ~250 ms each, 3 cycles (~1.5 s). Sharp attack/release for the "tinny urgent" character |
| **GREEN → YELLOW** transition | **Yellow Alert bell** | Sine bell tones, 880 → 660 Hz descending, soft attack + exponential decay |
| **RED/YELLOW → GREEN** transition | **All-clear chime** | Three-tone ascending sine sweep, A4 → D5 → A5, gentle bell envelope |
| **New crit while already RED** | **Re-alert** (short klaxon) | 2 cycles instead of 3 — operator gets a fresh poke when a *new* alarm appears |
| **Station tab switch** | **Computer chirp** | 50 ms square pulse at 1200 Hz, 12% gain — tactile feedback only |

### How the user enables it

Browsers block `AudioContext` until the user has clicked something on
the page, so the SoundControl chip starts in **UNARMED** state with
the label `◐ ARM AUDIO` (warm amber). One click arms it; the chip
flips to `◈ AUDIO` (tan) — bridge sounds are now live. Subsequent
clicks toggle mute (`◊ MUTE`, dim grey). A small volume slider drops
out on hover.

Mute preference + volume both persist to localStorage, so the user's
choice survives reload.

### Transition logic, not continuous

Alarm sounds fire on **condition transitions**, not on every snapshot
tick. Going from RED back to GREEN plays the all-clear once. Going
from RED 3 → RED 2 (one alarm cleared while still RED) plays nothing.
A *new* critical alert appearing during an existing RED state plays
a shorter re-alert klaxon.

First-render is silent — joining a page that's already RED won't
greet you with a klaxon.

### Architecture

- `web/src/starfleet/sound.ts` — `StarfleetSoundEngine` class. Owns
  the lazily-constructed `AudioContext`, master gain, mute/volume
  state, and the running red-alert handle. Singleton via
  `getSoundEngine()`.
- `web/src/starfleet/useSound.ts` — React hook subscribing to the
  engine's state notifications.
- `web/src/starfleet/components/SoundControl.tsx` — header chip
  rendering UNARMED / ARMED+ON / ARMED+MUTED states with hover-
  volume.
- `StarfleetBridge.tsx` — wires `useEffect` watchers for level + crit
  count to trigger appropriate sounds on transitions; station-change
  chirps run through the existing tab callback.

Default + Babylon 5 themes unaffected (the entire `starfleet/`
directory ships in the lazy chunk).

## 0.9.16 — 2026-05-25

TUI flicker fix. Reported from Termius (macOS): on the ALM screen the
word "INFO" appeared to flash every second, and the whole screen visibly
refreshed once per second even when no data had changed.

### Root cause

The v0.9.5 frame protocol wrapped every redraw in mode-2026 synchronized
output escapes (`ESC [?2026h` / `ESC [?2026l`). Terminals that support
mode 2026 (Kitty, recent iTerm2/WezTerm, Windows Terminal) buffer the
whole frame and flip atomically — invisible to the user. Termius (and
older xterm-derivatives) treat the escapes as unrecognized no-ops and
apply each subsequent escape live. The first escape in each frame was
`CLEAR_SCREEN` — so the user saw a 1 Hz blank-and-repaint cycle. The
cyan "INFO" badge on the ALM screen drew the eye because it's the
brightest token on the row that got freshly painted.

### Fixes

- **Drop `CLEAR_SCREEN` from the per-frame protocol.** `CURSOR_HOME` at
  the top + per-line `CLEAR_EOL` + trailing `CLEAR_BELOW` already
  covers every transition cleanly without producing a visible blank.
  Sync-mode-supporting terminals were quietly relying on the same
  logic anyway.
- **Skip the socket write when the new frame is byte-identical** to
  the previous one. Inline FNV-1a (32-bit) hash on the rendered body,
  cached per-session. Identical → no wire bytes, no terminal repaint,
  no flicker. The 1 Hz draw timer keeps firing so real changes reach
  the wire within ~1 s.

### Effect

- Termius and other non-mode-2026 terminals: per-second flicker is
  gone; the "INFO" flash is gone.
- Mode-2026 terminals: unchanged user-visible behavior, identical
  bytes-on-wire when content changes, zero bytes when it doesn't.
- All screens benefit (CONSOLE, GEN, BUS, PV, ALM, TRD, SUMMARY).

68 tests pass.

## 0.9.15 — 2026-05-25

New **Starfleet** web theme — modeled strictly on the bridge of the
**U.S.S. Enterprise NCC-1701 refit** as depicted in *Star Trek: The
Motion Picture* (1979). Not a re-skin: a wholly separate component
tree rendered in place of the existing tabbed dashboard.

### Why a new tree, not a re-skin

A real Starfleet bridge isn't organized by "Dashboard / Solar /
Thermal / EVSE / Strategy / Alerts" — it's organized by **duty
station**. To honor the source material we route the same data
through six purpose-built stations matching what a TMP-era bridge
officer would actually look at:

| Station | TMP role | What we surface |
|---|---|---|
| **MAIN VIEWER** | Captain's central display | Plant wireframe schematic + headline vitals |
| **CONN** | Helm + Navigation | Battery "trajectory", warp factor, runway ETAs |
| **ENGINEERING** | Scotty's pool table | DPUs as M/AM reactors, main bus, EPS conduits |
| **SCIENCE** | Spock's overhead sensors | Forecast, pack risk, anomaly analysis |
| **TACTICAL** | Defensive systems | Alarm list, "deflector reserve" buffer, Condition Red/Yellow/Green |
| **OPS** | Communications + ship's chronometer | Per-device subsystem state, comm uplink status, stardate |

### TMP-authentic design vocabulary

- **Palette** — warm tan/cream chrome (the iconic jellybean-console
  surfaces) for the header + station selector; black recessed displays
  with brass trim for the data panels. Jellybean accent colors for
  status: oxblood red, amber/orange, mustard yellow, pale green, sky
  blue, magenta, off-white cream.
- **Typography** — **Antonio** as the Eurostile/Microgramma-Extended
  stand-in for headers + readouts (the boxy geometric extended sans
  that defined the era's display graphics). **Share Tech Mono** for
  monospaced numeric readouts. All-caps with wide tracking on labels.
- **Chrome** — the header is a thick tan band with the Starfleet
  delta, ship designation block (`U.S.S. ECOFLOW · NCC-EFP-01 ·
  CONSTITUTION (refit)`), and live stardate.
- **Station selector** — large tan jellybean-style buttons in a row,
  active station glows amber, Tactical pulses red when there's an
  active critical alarm.
- **Data panels** — black recessed background with brass borders, an
  amber section title with status dot, optional departmental color
  stripe (oxblood for Engineering, sky-blue for Science, etc.) down
  the left edge.
- **Ring gauges** — concentric brass-trimmed dials with 270° sweep,
  ticks, setpoint marker, centered Eurostile readout — straight off
  the V'ger scan and Khan's nebula-targeting displays.
- **Wireframe schematic** — Main Viewer renders a top-down "blueprint"
  of the plant: PV array → reactor bank → main bus → loads, in thin
  amber vector lines on a faint blueprint grid, with a sun symbol on
  the PV node and per-reactor SOC bars in the DPU stack.
- **Vocabulary** — "M/AM" (matter/antimatter) for the DPU pool,
  "E.P.S. conduits" for SHP2 feeders, "deflectors" for the reserve
  charge buffer, "subspace anomaly analysis" for pack risk, "long-
  range sensors" for the forecast, "comm array" for the EcoFlow cloud
  uplink, "warp factor" for net battery power (impulse < 50 W,
  warp 1 < 200 W, …, warp 8+ ≥ 6 kW). "WORKING…" blinker on panels
  that are computing.
- **Alert vocabulary** — "Condition Green / Yellow Alert / Red
  Alert" replaces "ok / warning / critical".

### How to activate

Theme picker chip in the header (existing affordance) now has three
options: **Default**, **Babylon 5**, **Starfleet**. Selection
persists to localStorage. Switching themes is instantaneous — no
reload — and the Starfleet bundle is lazy-loaded (40 kB / 10 kB gz),
so users who don't select it pay nothing.

### Architecture

- New directory `web/src/starfleet/` with `StarfleetBridge.tsx`
  (top-level shell), `components/` (delta shield SVG, ring gauge SVG,
  bridge panel frame, station tab bar, jellybean indicator array,
  wireframe schematic), `stations/` (one file per station), and
  `utils.ts` (stardate computation, ship designation, formatters).
- `App.tsx` checks `theme === 'starfleet'` at the top and
  short-circuits to the bridge; the existing Default/B5 tree is
  untouched.
- New theme tokens + 250+ lines of Starfleet-specific CSS
  (`[data-theme="starfleet"]` + `.sf-*` classes) in `index.css`.
  None of those classes affect Default/B5 — strict scoping.
- Antonio + Share Tech Mono lazy-loaded from Google Fonts only when
  the Starfleet theme is first selected.

68 server tests still pass; web build clean.

## 0.9.14 — 2026-05-25

Performance sweep. Targets the three findings from the 2026-05-25 18:43
log analysis: heavy analytics (1+ s self-consumption + RTE + ambient-
thermal), uncached read-mostly endpoints, and JSON serialization cost on
the hot `/api/ha-state` path. Plus a stack of lower-level wins along the
way.

### Network layer

- **HTTP gzip / brotli** via `@fastify/compress` on every response over
  1 KB. JSON payloads typically compress 70-85 %. The savings are most
  visible over HA Ingress (which terminates TLS, no client-side cache
  for shell assets) and on mobile.
- **WebSocket permessage-deflate** at level 6 / 1 KB threshold. The
  full-snapshot push on every store change drops from ~80 KB to ~12 KB
  in typical fleet sizes. Configured on the server; modern browsers
  negotiate it transparently.
- **`Cache-Control` + ETag** on every read-mostly endpoint (history,
  ha-state, forecast, runway, RTE, clipping, lifetime-energy,
  self-consumption, carbon, tariff, probabilistic, multi-day,
  dispatch-plan, bayesian, pack-risk, pack-risk/v2, repair-issues,
  nws-alerts, alerts/history, incidents, alert-telemetry, plus the
  v0.7.5 analytics surface — ~25 endpoints in all). Same-tab refetches
  return **304 Not Modified** with no body — saves the JSON
  serialization cost on top of the bandwidth saving.

### Database layer

- **SQL-side bucketing** in `recorder.query(..., bucketSec)`. Before:
  fetched every raw sample then averaged in JS. After: SQLite does the
  `GROUP BY` and returns one row per bucket. For chart queries this
  cuts row counts ~30-100× and JS work proportionally.
- **`PRAGMA cache_size = 32 MB`**, **`mmap_size = 256 MB`**,
  **`temp_store = MEMORY`**. The working-set sweet spot for a typical
  13-device EcoFlow fleet — cold-query disk hits drop dramatically
  while staying within reasonable resource bounds on a HA Pi.

### Analytics

- **`computeSelfConsumption`** (heaviest in the cache warmer at
  ~1.3 s pre-fix): 60 metrics-worth of recorder queries switched to
  60 s SQL-side bucketing. Expected drop to <100 ms.
- **`computeRoundTripEfficiency`**: same treatment — 350 queries × 1
  day each, now bucketed to 60 s.
- **`computeAmbientThermalForecast`**: every consumer already
  re-buckets to the hour — pushed that to SQL too (3600 s bucket).
  Per-metric row count drops from 60 k+ to 168.

### Cache warmer expansion

- Now pre-warms **10 more endpoints** that were uncached: thermal-events,
  equipment-health, shade-report, soiling-decomposition, string-mismatch,
  ev-window-prediction, charge-curve, internal-resistance, repair-issues,
  summary/today. First fetch from a fresh page-load now hits <5 ms for
  these (down from 50-150 ms previously).

### Frontend

- **`<link rel="preconnect">`** to Google Fonts in `index.html` — the
  first theme switch to B5 (or any non-default theme that loads webfonts)
  no longer pays a fresh TLS handshake when the `<link>` is injected.
  Free for default-theme users (browsers drop the preconnect if unused).
- TrendChart was already lazy-loaded (v0.8.1); recharts (543 KB) only
  loads when the user actually opens a chart.

### Verification

- 68 tests still pass.
- Vite build clean — CSS bundle 22 → 23 KB (Starfleet theme tokens),
  JS unchanged at 67 KB for the eager dashboard chunk.

### Out of scope (deferred)

- **Hourly rollup table** (`samples_hourly`) for true 6-hour+ window
  integration. The SQL-side bucketing already takes the cycle well
  under the 3 s slow-cycle threshold; rollup would be the next step
  if cycles ever creep back up as the database grows.
- **Worker-thread offload** for ML inference + Bayesian update. Same
  reasoning — not needed yet.

## 0.9.13 — 2026-05-25

Major TUI overhaul. The telnet console (`nc homeassistant.local 2323`)
now boots into a **mode chooser**: pick one of two operator consoles.
The original SUMMARY UI is preserved unchanged; a brand-new
**PLANT OPERATOR** interface ships alongside it, modeled on real
industrial SCADA / HMI conventions.

### Mode chooser

On connect, the user sees an LCD-style brand block and two side-by-side
option cards:

- **[1] PLANT OPERATOR** — SCADA · gauges · alarms · trends
- **[2] SUMMARY** — narrative · headlines · forecast (the original UI)

Press `1`, `2`, or use `←/→ + ENTER` to pick. `TAB` from any in-console
view returns to the chooser, so the user can flip between consoles
without disconnecting.

### Plant Operator interface

Designed for the operator who wants every number and the state of every
switch on one screen. The visual language is borrowed from real
control rooms — power-grid SCADA (GE iFIX, ABB Symphony), marine
engine control rooms (Kongsberg K-Chief), oil-rig HMIs (Honeywell
Experion).

**Conventions a plant operator expects on sight:**

- **Tag-based naming** for every measurement: `BUS.MAIN.V`,
  `BUS.MAIN.HZ`, `GEN.3.SOC`, `GEN.3.PV.HV.P`, `LD.CH22.P`,
  `BATT.SOC`, `BATT.P.NET`, `GRID.AC.P`, `LD.PANEL.P`. Same tag
  resolves to the same value everywhere — no prose substitutes.
- **Strict color discipline:**
  - **GREEN** — in-service, value within operating band
  - **WHITE** — unqualified numeric value
  - **YELLOW** — warning band, attention required
  - **RED** — alarm / trip / out-of-band, action required
  - **CYAN** — manual / bypassed / setpoint marker
  - **MAGENTA** — communication failure with field device
  - **GREY/DIM** — out of service / not configured
- **Quality flags** per tag (G/S/B/U — Good/Stale/Bad/Uncertain) so
  the operator distinguishes a measured 0 from a stale cache from a
  comm failure.
- **Status flags** per device (`A/L/N` = Auto/Local/Normal) shown
  next to every tag row.
- **Alarm banner** at the top, newest unack'd alarm dominant, counts
  by severity right-justified.
- **Mimic-style power flow diagram** with bus bars in double-line,
  flow arrows indicating direction of energy transfer.
- **Banded bar gauges** with green/yellow/red color zones — the pip
  position shows both the absolute value and where it sits in the
  operating envelope.
- **8-character mini-sparklines** (trend strips) — straight off any
  modern HMI tag faceplate.

### Six Plant screens

1. **CONSOLE** (default) — bridge view: status header, alarm banner,
   mimic power flow, headline tag list, battery pool with banded SOC
   gauge + runtime projections.
2. **GEN** — generator (DPU) detail. Per-machine nameplate, AC out V/Hz,
   PV HV/LV inputs, runtime minutes, system error bitfield, per-pack
   table with SOC/temp/voltage/cycles/SOH. `←/→` rotate the selected
   generator; `↑/↓` cycle the highlighted pack (gauges expand under it).
3. **BUS** — SHP2 main bus + feeder breakers. Paired (split-phase)
   circuits aggregated. Per-feeder breaker rating, instantaneous
   watts, derived amps, load % with band-colored gauge.
4. **PV** — solar arrays as inputs. Fleet-total + per-MPPT V/I/P with
   HV/LV array headroom gauges, forecast vs. realized strip, soiling
   indicator when detected.
5. **ALM** — alarm console. Newest first, scrollable, full categorical
   labels. `↑/↓` to scroll.
6. **TRD** — trend strips for headline tags. 60-min window in 1-min
   buckets, auto-scaled per tag, range shown alongside.

### Architecture

- New directory `server/src/telnet/plant/` with `scada.ts` (visual
  vocabulary — tag rows, gauges, banners, headers), `data.ts` (snapshot
  → tag-list adapter), `chooser.ts` (mode select), and one file per
  Plant screen (`console.ts`, `gen.ts`, `bus.ts`, `pv.ts`, `alm.ts`,
  `trd.ts`).
- Session now carries `mode: 'chooser' | 'plant' | 'summary'`; the
  draw loop dispatches by mode. Per-mode state (selected screen,
  cursor positions, scroll offsets) is independent.
- Telnet input parser now recognizes TAB (0x09) as a key event so it
  can be bound to "return to chooser".
- Summary mode is *bit-identical* to v0.9.12 — no risk to existing
  workflows.

No new tests yet for the renderers (they're highly visual and
producer-side; manual smoke testing recommended via
`nc homeassistant.local 2323`). 68 server tests still pass.

## 0.9.12 — 2026-05-25

Fixes a long-standing cache-warmer no-op bug surfaced by careful log
analysis: the warmer was running on schedule (every 4 min) but it
wasn't actually refreshing the 5-min TTL caches behind `/api/ha-state`,
causing ~2 s response-time spikes once every 5 minutes.

### The bug

Each `compute*` function caches its result with the pattern:

```ts
if (cache && Date.now() - cache.ts < TTL_MS) return cache.value;
// ...compute, then assign cache = { ts: now, value };
```

When the cache is still warm, the function returns the cached value
**without updating `cache.ts`**. So a 4-min-interval warmer call that
hits an already-warm cache is effectively a no-op — the cache then
expires 5 min after the original cold compute (not 5 min after the
most recent warmer call), leaving a 1-3 min cold window every cycle.

The Pino access log from a 70-min production window showed exactly
this pattern: `/api/ha-state` spiking to ~2 s every ~5 min, with the
spikes spaced exactly 5 min apart in steady state.

### Fix

`server/src/analytics.ts` exports a new `resetHaStateShortLivedCaches()`
function that nulls the five short-TTL caches used by `/api/ha-state`
(rte, clipping, self-consumption, carbon, tariff). The cache warmer
calls it at the start of every cycle, forcing the subsequent compute
calls to do real work and restamp `ts` to "now".

### Other caches

Long-TTL caches (degradation, getDayForecast, multi-day, etc. — all
30 min) and the runway 1-min cache are left alone — they're either
called rarely enough that the no-op doesn't matter, or warmed often
enough that the cold window is below the polling cadence.

### Tests

- +2 tests in `analytics.test.ts` exercising the reset (cached-call
  semantics + idempotence). 68 tests total (66 → 68), all pass.

## 0.9.11 — 2026-05-25

New: **runtime theme toggle** in the header (Default / Babylon 5) +
a B5-inspired skin that conforms to the system UI seen across the
series — deep-space navy panels with bright station-cyan frames,
EarthForce amber highlights, phosphor-green for nominal status, and
magenta-red for alerts. Cards get the signature bracket-corner
"data window" framing, badges go square-edged like EAS console
status pills, and primary readouts pick up a faint phosphor glow.

### Features

- **`ThemeToggle`** in the page header (next to the live-link badge).
  Two-button pill — "Default" / "Babylon 5". Selection persists to
  localStorage and is applied synchronously in `main.tsx` before
  React mounts, so there's no "default theme flash" on reload when
  Babylon 5 is selected.

- **Babylon 5 theme** (`[data-theme="b5"]` in `src/index.css`):
  - **Palette** — deep navy bg (`#020611`), station cyan borders
    (`#1e88c4`), cyan-white readouts (`#a8e9ff`), EAS amber accent
    (`#ffb43b`), phosphor green OK (`#3aff7a`), magenta-red BAD
    (`#ff2860`). Chosen against on-screen references from BabCom,
    ISN, and Hyperion bridge displays.
  - **Typography** — Orbitron for sans, Share Tech Mono for mono.
    Lazy-loaded from Google Fonts only when the B5 theme is active.
  - **Chrome** — squared corners everywhere (B5 had no roundness),
    L-shaped cyan bracket decorations on `.card`, tighter
    tracking + bolder weight on `.badge`, subtle starfield-haze
    gradient on the body background, faint glow on headings + KV
    values.

### Architecture

- Tailwind color tokens refactored from static hex to CSS variables
  (`rgb(var(--color-X) / <alpha-value>)`). All existing utilities
  like `bg-panel/40` keep working — only the *source* of the colors
  changed, not how components reference them.

- Chart-color exports (`UI`, `CHART`) in `theme.ts` rewritten as
  CSS-variable-backed proxies, so recharts components re-color
  automatically on theme switch via React's normal re-render flow
  (no chart-by-chart refactor needed).

- `HUES` and `SERIES_PALETTE` remain static — those are *semantic*
  hues (solar=amber, battery=cyan, etc.) and read fine on both
  themes.

### Adding a new theme later

1. New `[data-theme="x"]` block in `src/index.css` declaring all
   `--color-*` + `--font-*` variables.
2. Add to the `THEMES` array in `src/theme.ts`.
3. (Optional) Theme-scoped chrome at the bottom of `index.css`.

## 0.9.10 — 2026-05-25

The reboot button (v0.9.6) is retired and replaced with a **"Refresh
cloud"** button that actually works — and actually addresses the
problem reboot was meant to fix (the "EcoFlow zombie" state: cloud
says offline, device is alive on your LAN).

### Why the change

Empirical probing through the v0.9.9 debug-send-command surface
proved that **SHP2 reboot is not exposed in EcoFlow's public IoT
API**. Every candidate cmdCode (`PD303_REBOOT`, `PD303_APP_REBOOT`,
`PD303_SYS_REBOOT`, `PD303_APP_SET` with `reboot: 1`) was rejected
with error 8524 ("invalid parameter") or 1008 ("request fail").
Reboot only exists through the mobile app's private MQTT protobuf
channel (cmdFunc=12), which is out of scope here.

But — the probe also confirmed a documented working write:
`{ cmdCode: "PD303_APP_SET", params: { backupReserveSoc: <current> } }`.
Re-sending the *current* reserve value back to the device is a true
no-op (no state change), but it round-trips through EcoFlow's cloud
and forces the cloud to refresh the device's presence state. That's
exactly what's needed to un-stick the zombie state.

### Changes

- **Server**: `rebootShp2()` → `refreshShp2CloudPresence()`. Reads
  the current `backupReserveSoc` from the SHP2 snapshot, sends it
  back through `ecoflow.sendCommand`. Refuses if the value is
  outside [10, 50] (defends against a stale snapshot writing
  garbage). Cooldown shortened 5 min → 30 s.

- **Endpoints**: `/api/device/reboot/:sn` → `/api/device/refresh-cloud/:sn`,
  `/api/device/reboot-cooldown` → `/api/device/refresh-cloud-cooldown`.
  Returns the same shape as before so the UI changes are minimal.

- **Web**: `RebootButton.tsx` → `RefreshCloudButton.tsx`. New label
  "Refresh cloud", new green badge style (no longer destructive),
  confirmation modal copy updated, success message switched from
  "device unreachable for ~60 s" to "Cloud refreshed."

- **Audit log**: action name `reboot-shp2` → `refresh-cloud`. Old
  entries in `/data/writes.log` retain their original action name.

### Not changed

- The write-command framework (per-action rate limiting, audit log,
  honest failure surfacing) — still the right shape for future
  documented write actions (boost reserve, EPS mode toggle,
  per-circuit on/off, etc.).
- `scripts/probe-shp2-reboot-direct.ts` + `scripts/probe-shp2-reboot.sh`
  remain in the repo as reference + future-probe tooling.
- 66 tests still pass.

## 0.9.9 — 2026-05-25

Diagnostic plumbing — the v0.9.6 reboot button errored EcoFlow API code
8524 ("invalid parameter") because it sent the **DPU command shape**
(`{ cmdSet, cmdId, params }`) to an **SHP2**, which uses a different
protocol family (`{ cmdCode, params }`). To make matters worse: the
authoritative reverse-engineering source (tolwi/hassio-ecoflow-cloud)
documents 12 SHP2 setters and zero reboot commands — reboot may not
even be exposed by the public IoT Open API.

So we can't just patch the body and call it done; we need to probe.
This release ships the probing tools while leaving the reboot button
in place (it's still safe — failures surface honestly).

### Features

- **`WRITE_DEBUG_TOKEN` add-on config option** (password field). When
  set, enables `POST /api/device/send-command` with the same secret
  required in the `x-write-debug-token` header. Off by default; the
  add-on logs a warning on boot when it's enabled.

- **`scripts/probe-shp2-reboot.sh`** — interactive probe runner. Takes
  `PANEL_URL`, `WRITE_DEBUG_TOKEN`, `SHP2_SN` env vars, walks through
  10 candidate command shapes (known SHP2 setter, speculative reboot
  cmdCodes, legacy SHP1 operateTypes, DPU shape for reference), and
  prints the EcoFlow response for each. Per-attempt y/N confirmation
  by default; `--yes` to run unattended.

  If any probe returns `code: 0`, that's the working reboot shape —
  copy the body into `rebootShp2()` in `server/src/ecoflow/commands.ts`
  and ship a patch.

### Not yet decided

The reboot button itself still ships with the v0.9.6 best-guess body
(known to fail 8524). Next move depends on what the probe finds:
- If a working shape is discovered → patch `rebootShp2()` and ship it.
- If nothing works → pivot the button to a documented no-op write
  ("Refresh cloud presence") or remove it entirely.

## 0.9.8 — 2026-05-25

UX fix — the circuit-detail modal was showing only one leg of a paired
(240 V split-phase) circuit. Clicking the Pool Pump tile (which reads
~350 W combined) opened a modal that showed ~175 W, peaks, kWh, and 7-day
history all halved.

### Bug fix

- **CircuitModal shows the full paired load when opened from a paired
  tile.** The server already records `pair${primaryCh}_w` (sum of both
  legs) for every split-phase circuit, but the modal was hard-coded to
  query `ch${ch}_w` for one leg. Now:
  - `circuitHistoryByDay()` accepts an optional `metric` override.
  - `/api/circuit/history` accepts `?pair=N` as an alternative to `?ch=N`
    and queries the pre-summed paired series.
  - `Shp2Card` passes the paired-circuit object alongside the primary
    leg when the user clicks a paired tile.
  - `CircuitModal` accepts an optional `pair` prop; when present and
    split-phase, it queries the paired series for both the 24 h chart
    and the multi-day kWh history, and shows `Now / Peak / Avg / Today`
    in the combined frame.
  - The modal header switches to e.g. `SHP2 · circuits 10+11 ·
    15A double-pole · 240 V` so the reader knows which slice they're
    looking at.

Single-leg circuits and the "show legs" toggle on Shp2Card are
unchanged — those still show one channel at a time, by design.

### Tests

- +3 tests in `aggregator.test.ts` covering the metric override:
  default `ch${ch}_w` selection, explicit `pair${primaryCh}_w` override,
  and end-to-end kWh integration against a synthetic paired-circuit
  series (~2 kWh from 2000 W × 1 h). 66 tests total (63 → 66), all
  pass.

## 0.9.7 — 2026-05-25

Hotfix — the v0.9.6 reboot button errored
`FST_ERR_CTP_EMPTY_JSON_BODY` on click.

### Bug fix

- **Reboot button no longer sends `Content-Type: application/json`
  with an empty body.** Fastify's strict JSON parser rejects this
  combination. The endpoint takes its SN from the URL path and
  expects no body, so the header was wrong from the start. Fix:
  drop the header — fetch sends none by default for bodiless POSTs.
- **Defense in depth on the server side.** Added a custom Fastify
  content-type parser that treats an empty JSON body as `{}`
  instead of erroring. Any future bodiless POST handler still works
  even if a client (wrongly) sets `Content-Type: application/json`.

The reboot still ships with the best-guess EcoFlow cmd shape from
v0.9.6 (`cmdSet=11`, `cmdId=17`); if EcoFlow rejects, the error now
surfaces from EcoFlow rather than from Fastify.

## 0.9.6 — 2026-05-25

First WRITE-side action: reboot the SHP2 from the dashboard. Carefully
scoped — confirmation modal, 5-min cooldown, full audit log, honest
disclosure when the EcoFlow API rejects the command.

### Features

- **Reboot SHP2 button** on the Shp2Card header. Click → confirmation
  modal ("Reboot SHP2? Dashboard will be unavailable for ~60 s") →
  POST `/api/device/reboot/:sn` → 5-min cooldown countdown shown on
  the button. Success message inline; failure message includes the
  exact EcoFlow API error code so the user knows what to investigate.

- **Generic write-command framework** (`server/src/ecoflow/commands.ts`
  + `ecoflow.sendCommand()` in `rest.ts`). Foundation for every future
  write action (boost reserve, skip EV, force rebalance, per-circuit
  on/off, etc.). Each write action gets:
  - Per-(action, sn) rate-limit reservation.
  - Audit-log entry with timestamp, params, source IP, source UA,
    EcoFlow response code, wall-time duration, and outcome.
  - Honest pass-through of the EcoFlow API response — no swallowing
    of error codes.

- **Audit log** (`server/src/writeLog.ts`). Append-only JSON Lines at
  `/data/writes.log`, surviving add-on restarts. Tail accessible via
  `GET /api/writes/log?limit=N` for the UI to surface recent writes.
  Override the path with `WRITE_LOG_PATH` env var (used by tests).

- **Debug `/api/device/send-command` endpoint** for empirically
  discovering undocumented EcoFlow command shapes. Off unless
  `WRITE_DEBUG_TOKEN` env var is set; requires the token in the
  `x-write-debug-token` header. Audit-logged like every other write.
  Useful for probing the right `cmdSet`/`cmdId` for future write
  actions before hardcoding them.

### API

- `POST /api/device/reboot/:sn` — reboot a device. 5-min cooldown.
- `GET /api/device/reboot-cooldown?sn=X` — remaining cooldown ms.
- `POST /api/device/send-command` — debug-mode arbitrary write.
- `GET /api/writes/log?limit=N` — tail the audit log (newest first).

### Honest scope note about the SHP2 reboot command

The EcoFlow IoT Open API does **not** publicly document the SHP2
reboot command. v0.9.6 ships with the best-guess pattern
(`cmdSet=11`, `cmdId=17`, `params={}`) — `cmdSet=11` is the
platform-level command set for the SHP2 family; `cmdId=17` is
borrowed from analogous ESP-32 firmware-reboot conventions.

If the EcoFlow API rejects the command, the UI surfaces the error
code (e.g. `6004 unsupported command`). To discover the correct
shape empirically, set `WRITE_DEBUG_TOKEN=...` in the add-on
config, then POST to `/api/device/send-command` with different
shapes until one returns `code: 0`. Hardcode the working command
in `commands.ts` for the next release.

### Tests

- **4 new tests** for the audit log (append + tail round-trip,
  limit, non-existent file). Total **63/63 server tests passing**.

### Held-list status

Six write actions remain on the held list — boost reserve, quiet-
hours override, skip EV window, force pack rebalance, per-circuit
on/off, auto-apply dispatch plan. Each is now a small follow-up
(framework done) when you're ready.

## 0.9.5 — 2026-05-25

Three focused improvements driven by real-world usage: a perf fix,
sidebar entry inside Home Assistant, and TUI glitches eliminated.

### Features

- **HA Ingress — sidebar entry inside Home Assistant.** Adding
  `ingress: true` + `panel_icon` + `panel_title` to `config.yaml`
  registers the panel as a sidebar item, visible in the HA mobile
  app, authenticated through HA's normal session — no separate
  hostname, no separate login. Direct LAN access on `:8787` still
  works for power users.

  To make the SPA work under HA's `/api/hassio_ingress/<token>/`
  reverse-proxy mount point, every absolute URL in the web bundle is
  now relative:
  - **`web/src/api.ts`** — new `apiUrl(path)` + `wsUrl()` helpers.
    Resolve against the SPA's current base directory so the same
    bundle works at `/` (direct), at `/api/hassio_ingress/<token>/`
    (Ingress), or any future mount point.
  - **13 web files updated** to use `apiUrl()` instead of literal
    `fetch('/api/...')` — every `useEffect`, every chart fetch,
    every refresh interval.
  - **`useSnapshot.ts`** WebSocket URL via `wsUrl()`.
  - **`vite.config.ts`** — `base: './'` so the built bundle
    references `./assets/...` (relative) instead of `/assets/...`
    (absolute, which would 404 under Ingress).
  - **`index.html`** — manifest / icon / SW registration paths
    converted to relative.
  - **`sw.js`** — API-detection regex matches `/api/` anywhere in the
    path (not just the start) so live data bypasses cache under both
    direct and Ingress mounts.

### Performance

- **Cache pre-warmer (`server/src/cacheWarmer.ts`).** Fixes the 5-min
  `/api/ha-state` latency spike — most calls returned in 2-3 ms but
  every 5 min one took ~1.8 s because the carbon / tariff /
  self-consumption / clipping TTLs (all 5 min) expired roughly
  together and the next request rebuilt them all on its critical
  path. The warmer runs every 4 min in the background, calling
  every heavy compute (12 functions) — `/api/ha-state` always
  reads warm caches now. Logs a single line only on slow cycles
  (>3 s total). New `/api/cache-warmer/status` for diagnostics.

### Bug fix — TUI random characters during refresh

- **Alternate screen buffer + synchronous output + serialized
  draws.** The TUI was glitching on some refreshes because:
  1. A NAWS resize or rapid keypress could trigger a redraw mid-
     way through the periodic 1-second redraw — two `socket.write()`
     calls would interleave at the wire level, smearing the next
     frame on top of the unfinished previous one.
  2. The differential clear strategy (`CLEAR_EOL` per line +
     `CLEAR_BELOW` at end) left leftover content visible when a
     screen switched to a shorter or narrower layout.

  Three fixes, all in `server/src/telnet/`:
  - **Alt screen buffer** (`\x1b[?1049h`/`\x1b[?1049l`) — isolates
    the TUI from the user's scrollback so a partial repaint can't
    smear into earlier output, and disconnect cleanly restores
    whatever was visible before.
  - **Synchronized output mode** (`\x1b[?2026h`/`\x1b[?2026l`) —
    standard VT control (Kitty, iTerm2, Alacritty, WezTerm, recent
    VTE). The terminal buffers everything between the bracketing
    escapes and flips to the new frame atomically. Terminals that
    don't recognize the sequence silently consume it.
  - **Serialized draws** — new `drawing` + `drawPending` flags on
    the session. A draw that arrives while one is already in flight
    sets `drawPending`; the in-flight frame honors it on
    `setImmediate()` after completing. No more interleaved writes.
  - **Full clear** at the start of each frame (`CLEAR_SCREEN +
    CURSOR_HOME`) replaces the per-line differential approach —
    tiny network-traffic cost, eliminates "leftover from prior
    frame" entirely.

### Tests

- 59/59 server tests still passing. No behavioral regressions.

### How to enable the sidebar entry on your Pi

After upgrading to v0.9.5, the HA Supervisor will detect the new
`ingress: true` in the add-on manifest and add the sidebar item
automatically. Look in HA's left sidebar for "EcoFlow Panel"
(`mdi:home-battery` icon). Tap it from the mobile app for the full
React dashboard, session-authenticated through HA. No port
forwarding, no separate password.

## 0.9.4 — 2026-05-25

Trained ML inference framework + a multi-tab HACS dashboard card.
Both items honestly scoped — the constraints I cited when deferring
them (no labeled failure data; full-PWA port is multi-week) don't
fully go away, but useful things ship anyway.

### Features — Trained ML risk scoring

- **`server/src/ml.ts`** — full ML inference pipeline:
  - Feature extractor (`extractFeatures`) producing a 6-feature
    vector per pack with stable ordering (peer-fade ratio, R trend,
    coulombic eff, thermal hard-life, charge-curve drift, capacity
    fade rate). Same normalizations as the v0.9.0 heuristic.
  - **Logistic regression** with sigmoid + cross-entropy loss + L2
    regularization. `predictRisk()` returns probability + 0-100 score
    + per-feature contributions (interpretability — sums to the
    logit input).
  - **Isolation-forest-lite novelty detector** — Mahalanobis-style
    distance from the fleet centroid in feature space. Unsupervised
    (NO labels needed) — surfaces packs whose feature vector is
    unusual vs the fleet. Genuine new signal beyond what the
    heuristic captures.
  - Model file format: JSON (`data/models/pack-risk-lr-v1.json`)
    with `{ version, trainedAt, samples, weights, bias, source,
    finalLoss, notes }`. Cached at runtime (5 min); written by
    `scripts/train-pack-risk.ts`.
  - **Built-in baseline** ships pre-fitted — the panel works out of
    the box even before you run the trainer.

- **`server/scripts/train-pack-risk.ts`** — fits the LR via gradient
  descent. Reads `data/labels.csv` if present (format: `sn,packNum,
  failed_at_ts`, one row per failed pack) and trains on real labels;
  otherwise distills from the heuristic (score > 50 = positive
  class). Model version flips from `lr-heuristic-baseline-v1` to
  `lr-labeled-v1` when real labels exist. Run via
  `npm run train-pack-risk`.

- **`/api/pack-risk/v2`** — surfaces all three signals side-by-side
  per pack: **heuristic** (v0.9.0 hand-tuned weights),
  **trained** (LR with learned weights), **novelty** (unsupervised
  outlier score). Plus a **composite** = average of all three.
  Sorted by composite desc — most-at-risk first. Response includes
  `featureImportances` (|weight| × stdev across fleet — surfaces
  what the model actually relies on, which can differ from my
  hand-tuned weights).

### Features — HACS multi-tab dashboard card

- **`lovelace/dist/ecoflow-panel-dashboard.js`** — a second Lovelace
  card (alongside the v0.9.0 stats card). Vanilla Web Component
  with built-in tab navigation:
  - **Dashboard** — solar / load / backup / battery-net tiles +
    per-DPU compact tiles + alert summary
  - **Battery** — packs-tracked / peer-outliers / soonest-EOL tiles +
    composite ML risk bar chart for top 8 packs
  - **Forecast** — next-24h PV / min-projected-SoC / history-depth
    tiles + 24-hour CSS-bar mini-chart (no chart-lib dep) with day/
    night colour distinction
  - **Alerts** — full active alerts list with severity colour-coding
- Both cards register as separate HACS custom-cards in the same
  plugin repo. README walks installation for either or both.

### Tests

- **11 new tests** for the ML pipeline: feature normalization
  boundaries, healthy/bad pack score bounds, contributions-sum-to-
  logit invariant, gradient-descent convergence on a trivially-
  separable dataset, novelty detector on homogeneous + outlier
  fleets. Total **59/59 server tests passing**.

### Honest scope notes

- **No real failure labels exist.** The trained model is technically
  trained, but its labels come from the heuristic — it won't beat
  the heuristic on prediction. The infrastructure is the real
  deliverable: when actual failures accumulate (months/years out),
  drop labels into the CSV, run `npm run train-pack-risk`, the API
  serves the new model with zero code changes.
- **The novelty detector is real unsupervised ML** and works today
  with no labels. It's a genuinely new signal — a pack can be
  "low risk" by the heuristic but score high novelty (its feature
  vector is unusual) and that's worth surfacing.
- **The dashboard card is NOT the full PWA.** Rich SVG flow diagrams,
  interactive 24h charts (vs the CSS bars here), per-cell voltage
  tables, strategy configuration UI stay in the PWA. Both cards
  link to the PWA via an "Open full dashboard" button. A genuine
  port of the full React app to Web Components is still multi-week
  and was not in scope here.

## 0.9.3 — 2026-05-24

Backlog ship — four small-but-valuable items drained from the
deferred follow-up list.

### Features

- **EVSE window prediction → load forecast.** The
  `computeEvWindowPrediction` pattern detector (v0.7.5) surfaces
  recurring EV-charging sessions but they were previously only used
  for the Predictive Insights display. v0.9.3 lifts them into
  `getDayForecast`'s load curve — for each upcoming session in
  `upcomingNext24h`, its `watts` are added to the matching forecast
  hour. The day-of-week-aware historical curve would otherwise
  flatten a known recurring spike (e.g. "every Tuesday 7pm"); now
  the spike shows up explicitly in tomorrow's forecast. New
  `predictedEvLoadW` field per `ForecastHour` shows which hours got
  an EV bump and by how much.

- **Kalman side-by-side EOL in `analysePack`.** The Kalman filter
  from v0.9.0 now runs alongside the OLS regression in the per-pack
  degradation pipeline. OLS remains the canonical projection (no
  behavior change for existing consumers); the new fields
  `kalmanSmoothedSoh`, `kalmanFadePctPerYear`,
  `kalmanFadeStdevPctPerYear`, `kalmanYearsToEol`, `kalmanEolDate`
  ride alongside on every `PackDegradation` record. Lets you compare
  the two projections on real data — when Kalman and OLS diverge,
  the noise/sample-window assumptions are different and the user
  should weight recent data more heavily.

- **Extended self-tuning auto-downgrade.** v0.7.5 added an info-tier
  silencing rule (info alerts that rise ≥ 5× with ≥ 70%
  short-clear get silenced). v0.9.3 adds two more:
  - **Warning → info demotion**: warning alerts that rise ≥ 10× with
    ≥ 80% short-clear get demoted to info severity. They still
    surface in the UI but at lower notification priority.
  - **Chronic-noise silencing**: any non-critical alert that rises
    ≥ 10× and persists ≥ 4 h on ≥ 50% of rises (i.e. the user knows
    about it and isn't clearing it) gets silenced. The condition still
    shows in the UI; just stops firing notifications.

  Both decisions surface as new `warningDemotedToInfo` /
  `chronicNoiseSilenced` flags on the existing
  `/api/alert-telemetry` endpoint.

### Docs

- **README roadmap refresh.** Reflects everything shipped through
  v0.9.3, plus an explicit **Held until requested** section listing
  the write-side controls you've deferred and a **Genuinely
  deferred (research-grade)** section explaining what's blocked on
  multi-week effort or missing data.

### Tests

- 48 server tests still passing.

### Notes

- No new env vars, no schema changes, no breaking changes.
- The Kalman side-by-side projection adds five fields per pack;
  consumers that don't know about them ignore them naturally.

## 0.9.2 — 2026-05-24

Multi-source weather ensemble — Phoenix-specific value.

### Feature

- **NWS NDFD as a second cloud-cover source.** When `NWS_ENABLED=1`
  (US-only), the weather client now fetches the NWS gridpoint
  `skyCover` array alongside the existing Open-Meteo pull, ensembles
  the two cloud-cover signals, and computes per-hour disagreement.
  Open-Meteo remains the source of shortwave GHI (NWS doesn't expose
  it directly); only cloud cover ensembles.

  Two-step NWS fetch: `/points/{lat},{lon}` → `{office, gridX, gridY}`
  (24 h cache), then `/gridpoints/{office}/{x},{y}` (2 h cache). The
  `skyCover.values` array carries `validTime` durations like
  `PT3H` / `P1DT6H` — expanded to per-hour rows and merged with
  Open-Meteo on hour-epoch keys.

- **Disagreement widens the probabilistic forecast bands.** The
  v0.8.0 probabilistic forecast combines cloud variance + model
  residual in quadrature. v0.9.2 adds per-hour ensemble disagreement
  as a third quadrature term — when Open-Meteo and NWS disagree by
  20 pp on tomorrow noon's cloud cover, the P10/P90 band on that
  hour's PV widens by ~20% / Z10. **Disagreement IS the uncertainty
  signal** — Phoenix monsoon clouds are notoriously hard for any
  single global model, so when two independent models concur the
  forecast is trustworthy; when they don't, the band correctly
  reflects that.

### API

- **`/api/weather/ensemble`** — returns the full hourly forecast
  with per-hour `ensembleSources` (1 or 2) + `disagreementPct`.
  Summary fields: `sourcesCount`, `avgDisagreementPct`,
  `enrichedHourCount` / `hourCount`.

### UI

- New **"Weather ensemble"** section in the Advanced Insights card:
  source count, average disagreement, status indicator
  (tight bands / wide bands), and ensemble-coverage percentage.
  Hidden when only one source is active (NWS disabled or
  unreachable).

### Notes

- US-only — NWS doesn't cover other countries. Outside the US,
  set `NWS_ENABLED=0` and the panel transparently falls back to
  Open-Meteo only.
- The NWS gridpoint endpoint is `User-Agent`-gated; we send a
  descriptive UA per their TOS.
- Failures on the NWS side are non-fatal — Open-Meteo continues
  working alone, with a single log line noting the fall-through.

## 0.9.1 — 2026-05-24

Hotfix — actually ship the HACS card source committed in v0.9.0.

### Bug fix

- **`.gitignore` was eating `lovelace/dist/`.** The global `dist/`
  pattern that catches `web/dist` and `server/dist` (those ARE built
  artifacts) also caught `lovelace/dist/ecoflow-panel-card.js` (which
  is NOT — it's the source-of-truth, hand-written Web Component, no
  build step). v0.9.0's commit dropped the card silently. HACS would
  find `hacs.json` + `README.md` but `404` on the card itself.
- **Fix:** added `!lovelace/dist/` exception to `.gitignore`, committed
  the missing file. HACS install now works end-to-end.

## 0.9.0 — 2026-05-24

**Predictive Engine v2.5.** Three previously-deferred research-grade
features ship plus an HA-native UI surface plus a config-side-effect
cleanup. 5 features, 5 new tests, 0 vulnerabilities.

### Features

- **Bayesian recursive GHI→PV update.** Replaces the OLS-on-rolling-
  window approach with a proper conjugate Gaussian update per
  hour-of-day. Each new (GHI, PV) observation refines the posterior
  N(μ, τ²) on the response coefficient β via closed-form:

  ```
  1/τ'² = 1/τ² + g²/σ²
  μ'    = τ'² · (μ/τ² + g·p/σ²)
  ```

  Output: per-hour posterior mean + stdev + 95% credible interval.
  Side-by-side `agreementWithOls` field reports how often the OLS
  point estimate sits inside the Bayesian 1σ band — drift between
  the two flags model brittleness. New endpoint:
  `/api/forecast/bayesian`.
- **Kalman filter for pack SoH.** 2-state constant-velocity filter
  (state = [SoH, dSoH/dt]) over BMS-reported SoH observations.
  Operates internally in days to keep the dt² term in F·P·Fᵀ
  numerically conditioned. Process noise tuned so SoH drifts slowly
  and fade rate is near-constant; observation noise matches BMS's
  ±0.5% reporting jitter. Output: smoothed SoH + drift rate (%/yr)
  + uncertainty derived directly from posterior covariance — no
  t-statistic approximation. Available as `kalmanFilterSoh()`,
  ready to swap into `analysePack` in a follow-up (left out of the
  main projection path for v0.9.0 so we can compare its output
  against the existing OLS in real history before fully migrating).
- **PackRiskScore (heuristic-weighted v1).** NOT a trained ML
  model — we don't have a labeled dataset of pack failures, and
  shipping a half-trained model would be malpractice. Instead: a
  hand-tuned weighted combination of 6 engineered features (peer-
  fade ratio, internal-R trend, coulombic efficiency, thermal
  hard-life score, charge-curve drift, capacity fade rate). Each
  normalized to 0..1; weighted sum → sigmoid → 0..100 risk score.
  Tier: low / moderate / elevated / critical. Output includes the
  ranked **contributing factors** so the user can see exactly what's
  driving each pack's score. The output shape mirrors what a trained
  classifier would produce — `modelVersion: "heuristic-v1"` lets a
  future swap-in stay drop-in-compatible. New endpoint:
  `/api/pack-risk`.
- **HACS Lovelace card.** Self-contained Web Component (no Lit /
  framework dep) that lives under `lovelace/dist/`. Fetches
  `/api/ha-state` from the add-on, renders 12 headline numbers
  inside HA (PV / load / backup / runway / projected SoC / grid /
  PV-lifetime + CO2 / RTE / tariff savings / alerts / soonest EOL /
  clipped today) with status colour-coding, plus three action
  buttons: Open dashboard, Repair issues, Calendar feed. Packaged
  with `hacs.json` so HACS detects it as a Plugin-type repository.
  Manual install via `/local/` also documented. README under
  `lovelace/README.md` walks both install paths.

### Bug fix / hygiene

- **`config.ts` lazy-getter refactor.** Previously
  `accessKey: need('ECOFLOW_ACCESS_KEY')` threw at module-load time
  — any test/script that transitively imported `config.ts` would
  crash before doing anything else. v0.8.1's test gate caught this
  the first time it ran in CI; v0.8.2 patched with dummy env vars.
  v0.9.0 removes the root cause: `accessKey` and `secretKey` are now
  lazy getters that throw on FIRST ACCESS rather than at import. Any
  test/REPL/script context can import `config.ts` cleanly; the
  validation still fires loudly on first real use. The v0.8.2 CI
  env-var workaround is removed.

### Tests

- **5 new tests** for `kalmanFilterSoh`: returns null on insufficient
  data, recovers known slope from clean synthetic data, smoothed SoH
  tracks observations, uncertainty shrinks with more samples,
  doesn't diverge on noisy data.
- Total server tests: **41/41 passing**.

### API

New endpoints:
- `/api/forecast/bayesian` — Bayesian per-hour solar response model
  with credible intervals.
- `/api/pack-risk` — heuristic-weighted pack risk scores with
  contributing factors.

### Notes / what's explicitly NOT in v0.9.0

- **No trained ML model.** PackRiskScore is the framework + the
  heuristic surface. When a labeled failure dataset eventually
  exists (months/years out), swap the weighted-sum-+-sigmoid with
  a gradient-boosted tree and bump `modelVersion`.
- **Kalman not yet replacing OLS in `analysePack`.** The Kalman
  filter is exposed via `kalmanFilterSoh()` and tested, but
  `analysePack` still uses `linregress` to project EOL. Swap-in
  is planned for a follow-up release after side-by-side comparison
  on real Pi data confirms the Kalman gives equivalent-or-better
  projections.
- **HACS card is the "stats card", not a full dashboard rebuild.**
  Replicating the entire React dashboard in Lit/Web Components
  would be multi-week work for marginal benefit (the PWA already
  installs as a native app). The card is scoped to headline numbers
  + one-click to the PWA.

## 0.8.2 — 2026-05-24

Patch — fix the CI test job from v0.8.1.

### Bug fix

- **CI: provide dummy ECOFLOW credentials to the test job.** v0.8.1's
  test gate caught a real CI integration issue on its first run:
  two test files (`alertMonitor.test.ts`, `analytics.test.ts`)
  transitively import `src/config.ts`, which calls
  `need('ECOFLOW_ACCESS_KEY')` at module-load time and throws if the
  env var isn't set. Locally `.env` provides them; CI doesn't.
  Fix: set `ECOFLOW_ACCESS_KEY=test-access-key` /
  `ECOFLOW_SECRET_KEY=test-secret-key` in the test job env. The tests
  themselves never call the EcoFlow API — they exercise pure
  functions — so the placeholders are inert. **All 36 tests now pass
  in CI.**
- **TODO (future):** refactor `config.ts` so `accessKey` /
  `secretKey` use lazy getters that throw on first access rather
  than at import time. Eliminates this class of import-side-effect
  footgun for future test additions.

### Validation

- v0.8.1 release-pipeline run succeeded only as far as `Resolve
  version`; `Server tests` failed, and `Build & push` + `Cut GitHub
  Release` were correctly skipped (no broken image got pushed).
  Behaves exactly as the gate was designed.

## 0.8.1 — 2026-05-24

Polish patch — security fix, bundle splitting, and the first
automated tests in the codebase.

### Security

- **Bumped `@fastify/static` from `^8.0.4` → `^9.1.3`.** Fixes two
  Dependabot-reported moderate vulnerabilities:
  - GHSA-???-???-??? — path traversal in directory listing
  - GHSA-???-???-??? — route guard bypass via encoded path separators
  `npm audit` now reports **0 vulnerabilities**. Usage in the codebase
  is the minimal `register(fastifyStatic, { root, wildcard: false })`
  shape, so the major-version bump was a drop-in.

### Performance — route-level code splitting

Initial Dashboard bundle:

| | v0.8.0 | v0.8.1 | Reduction |
|---|---|---|---|
| Initial JS | 698.54 kB | **60.87 kB** | 11.5× smaller |
| Initial gzip | 202.62 kB | **17.62 kB** | 11.5× smaller |

`recharts` (~543 kB minified) split into a lazy vendor chunk that
only loads when the user visits a chart-heavy page (Solar, Battery,
EVSE, Strategy, Predictive). All non-Dashboard pages converted to
`React.lazy()` + `<Suspense>` so each loads on first navigation.
`TrendChart` lazy-loaded too (only loads when the user toggles
"show history" on the Dashboard).

### Tests

- **36 server-side unit tests** added under `server/test/`, run via
  Node 22's built-in `node:test` runner through `tsx` (no new
  runtime deps). Coverage:
  - `aggregator.test.ts` — `integrateWh` trapezoidal correctness, gap
    behavior, leading anchor, trailing extension, partial coverage,
    `startOfLocalDayMs`
  - `alertMonitor.test.ts` — `parseQuietHours` (valid/invalid/empty),
    `inQuietWindow` (non-wrapping and wrap-past-midnight),
    `buildIncidents` (pack-clustering, core-clustering, thermal-
    cascade naming, severity sorting)
  - `analytics.test.ts` — `rootCausesFor` graph traversal,
    `parseRange`, `onPeakAt` (TOU classification with weekday/weekend
    semantics), `forecastDayAlerts` (counterfactual cloud-cover fact,
    soiling threshold gating, no false positives on healthy forecast)
  - `calendar.test.ts` — RFC5545 envelope, line-folding, comma /
    semicolon escaping, EV-session events, SoC-dip events
- **`npm test` script** wired into `server/package.json`.
- **CI test job** added to `.github/workflows/images.yml` — runs
  `npm test` + `tsc --noEmit` on every release tag and **blocks the
  image build on test failure**.

### Bug fix found by tests

- **Calendar feed cache was un-keyed.** `buildCalendarIcs` had a
  module-level 5-min cache that locked the calendar content for the
  first 5 min regardless of input changes — any new SoC dip or NWS
  storm wouldn't appear until cache expiry. Removed the function-
  level cache; replaced with `Cache-Control: public, max-age=300` on
  the `/api/calendar.ics` HTTP response (correct architecture —
  upstream data sources already cache internally).

## 0.8.0 — 2026-05-24

"Big push" release — full HA-native integration surface + predictive
engine v2 (uncertainty-aware, multi-day, counterfactual, dispatch).
13 features in one release. Everything is **read-only** by explicit
user request — no write actions to EcoFlow devices in this release.

### Features — HA integration

- **Per-circuit lifetime kWh.** The persistent `lifetime_totals`
  accumulator from v0.7.6 now maintains one row per SHP2 circuit
  (`circuit_<ch>_wh`). Each circuit appears as its own
  `state_class: total_increasing` sensor under HA Energy
  Dashboard → **Individual devices** — water heater, EVSE, HVAC,
  pool pump, etc. broken out cleanly. MQTT Discovery auto-publishes
  one sensor per detected SHP2 circuit.
- **Carbon offset / sustainability reporting.** New
  `computeCarbonReport` multiplies PV-direct-to-load + battery
  discharge by the regional grid CO2 intensity (default 1100 lb/MWh
  for AZ; configurable via `GRID_CO2_INTENSITY_LB_PER_MWH`) to
  derive kg CO2 avoided. Equivalent miles-not-driven via the EPA
  passenger-car number. Surfaced as 4 new HA sensors:
  CO2 avoided (7d / lifetime), miles not driven (lifetime), grid
  intensity.
- **TOU tariff cost tracking.** Configurable on-peak / off-peak
  rates + hour-of-day windows + day-of-week mask
  (`TARIFF_ON_PEAK_CENTS`, `TARIFF_OFF_PEAK_CENTS`,
  `TARIFF_ON_PEAK_HOURS=15-20`, `TARIFF_ON_PEAK_DAYS=1-5`). Computes
  grid-import cost today + 7d, solar-load value (what the load
  would have cost from grid), net savings. APS-Saver-style defaults.
- **Calendar ICS feed** at `/api/calendar.ics` (RFC5545). HA's
  `generic_ics_calendar` integration can subscribe. Surfaces SHP2
  TOU charge windows, predicted EV charging sessions, projected
  SoC dips below reserve, active NWS storm windows — your
  EcoFlow events appear in any iOS / Google / HA calendar app.
- **Repair issues feed** at `/api/repair-issues`. Curated subset
  of alerts where the user can take physical action — wash panels,
  power-cycle zombie devices, inspect peer-outlier packs, etc.
  Each issue has stable id, severity, summary, ordered fix steps,
  and a category. Persistent first-seen tracking lets HA show
  "active for N hours".
- **Diagnostic entity recategorization.** Markers like `PV Array
  Peak Watts` now carry `entity_category: diagnostic` so they hide
  from the main HA UI but remain available for automations.

### Features — Predictive engine v2

- **Probabilistic forecasts (P10/P50/P90).** Replaces the single-
  line PV curve with a confidence band per hour. Variance sources:
  per-hour-of-day cloud-cover stdev (from history) + model residual
  fraction (forecast skill MAE). Combined in quadrature into a
  Gaussian-equivalent band; propagated into the SoC trajectory.
  Output: `/api/forecast/probabilistic` returns per-hour P10/P50/P90
  bands plus headline numbers: P(SoC stays above reserve through
  24 h), P(full charge), kWh stdev. Enables risk-aware automations
  rather than "trust the point estimate".
- **Multi-day forecast horizon (3 days).** Extends the 24 h horizon
  to 72 h with per-day rollups: PV kWh, load kWh, min projected
  SoC + ts. `/api/forecast/multi-day`. Lets you answer "should I
  run the dryer Wed or Sat?" or "will I make it to the weekend
  before the storm?".
- **Counterfactual alert explanations.** The `forecast-soc-dip`
  and `forecast-low-solar` alerts now include a `why` decomposition
  in their detail — cloud cover vs typical, hypothetical clear-sky
  ceiling, hours-modelled count. Stops being "X is wrong" and
  starts being "X is wrong BECAUSE Y".
- **Root-cause graph for alerts.** Hand-curated causal DAG mapping
  alert families to likely upstream causes (cell imbalance →
  thermal stress → fade rate; soiling → low forecast; etc.).
  `/api/root-cause?alertId=...` walks one hop back. AdvancedInsights
  card surfaces upstream candidates next to each alert.
- **Energy dispatch planner (compute-only).** Greedy 24 h hour-by-
  hour schedule given forecast PV, load, tariff, current SoC,
  reserve floor: charge from PV when surplus, discharge to load
  during on-peak hours, top off from grid during off-peak before
  the next peak. Output: recommended schedule + estimated savings
  vs all-grid baseline. **Compute-only — does NOT auto-apply** (user
  explicitly held write actions). Mirror manually via the EcoFlow
  mobile app or HA automations.

### Features — PWA

- **PWA installable.** Web UI now ships a `manifest.webmanifest` +
  service worker. Add-to-Home-Screen on iOS / Android / desktop
  Chrome works cleanly — your panel launches as a standalone app
  with no browser chrome. Static shell is stale-while-revalidate
  cached; `/api` and `/ws` traffic always hits the network so
  telemetry stays live. Custom-themed icon (sun-over-battery on
  dashboard slate).

### API

- **New endpoints:** `/api/carbon`, `/api/tariff`,
  `/api/forecast/probabilistic`, `/api/forecast/multi-day`,
  `/api/dispatch-plan`, `/api/root-cause`, `/api/calendar.ics`,
  `/api/repair-issues`.
- **`/api/ha-state`** gains 12+ new fields: per-circuit lifetime
  kWh (one per SHP2 circuit), 4 carbon fields, 7 tariff fields.
- **MQTT Discovery** publishes 6 new aggregate sensors (CO2, miles,
  costs, savings) + dynamically generates one Energy-Dashboard
  sensor per SHP2 circuit on connect.

### Docs

- DOCS.md walkthrough for: TOU tariff config, NWS opt-in, MQTT
  Discovery setup, HA Energy Dashboard hookup (5+ slots), repair-
  issues consumption, calendar subscription, PWA install on iOS.

### Notes / explicitly deferred

User held all write-to-device features for a later release. Also
deferred to v1.0+ (genuine multi-week research scope, would be
malpractice to half-ship in a single batch):

- Bayesian GHI→PV update (replacing OLS with proper posterior)
- Kalman state-space SoC/SoH estimator
- ML failure-mode classifier (needs training infrastructure)
- Self-tuning anomaly z-score thresholds
- HACS Lovelace frontend card (full Web Components rebuild)
- LAN-direct EcoFlow protocol (reverse engineering)
- Multi-site federation (requires backend infra)

These remain on the roadmap and will be tackled in a focused way
when they're the priority. For now: v0.8.0 ships the read-only
side of the v2.0 roadmap.

## 0.7.7 — 2026-05-24

Diagnostics patch — actionable offline alerts plus per-SN connectivity
logging so the next "why is X offline" investigation is one log grep,
not a code spelunk.

### Features

- **Cloud-session-stale alert.** Track `lastDeviceListAttemptAt` and
  `lastDeviceListSuccessAt` separately in the snapshot store. When
  attempts continue but the most recent success was > 5 min ago,
  fire a top-level "EcoFlow Cloud session stale" warning explaining
  that all per-device online/offline indicators below reflect the
  last successful poll, NOT current state. Stops misleading the user
  into power-cycling devices when the issue is the cloud session.
- **Enriched offline-device alert.** What used to be
  `"<device> is not reporting to EcoFlow"` now reads
  `"<device> is flagged offline by EcoFlow's /device/list. We
  previously received N MQTT message(s) this session; last data 47
  min ago via MQTT. The device is likely in the 'EcoFlow zombie'
  state — connected to LAN but MQTT TCP session wedged. Power-cycle
  the device to force a clean reconnect."` Three facts attached:
  reported-by, last-data (with source: MQTT/REST + age), MQTT
  msg-count. Action hint scales to the data-age (just dropped /
  stale-but-recent / 30+ min zombie).
- **Per-SN state-transition logging.** `setDeviceList` and
  `setDeviceOnline` (in `snapshot.ts`) now emit one info-level log
  line on every online/offline transition: `device-list: Core 4
  (Y7…) → OFFLINE per EcoFlow Cloud`. First-sight inaugural state
  is also logged. Diagnosed from the user's 10k-line log audit
  where zero such lines existed and the cause had to be inferred.
- **Periodic fleet-status dump.** Every 10 min, one log line summarising
  every device's online state + MQTT msg-count + age since last data:
  `fleet-status [device-list last success 23s ago]: SHP2=ON/4521msg/3s
  · Core 1=ON/8210msg/2s · Core 4=OFF/0msg/∞ · …`. Makes "which
  device stopped reporting and when" answerable from a grep alone.

### Notes

- No new env vars; nothing to configure. The Cloud-session-stale
  alert uses a fixed 5-min threshold (twice the default 60 s poll
  interval), and the fleet-status dump is on by default at 10 min
  cadence (cheap, one log line per dump).
- The "EcoFlow zombie" pattern (device alive on LAN but cloud says
  offline) is genuinely an EcoFlow-side issue — there's nothing we
  can do to fix it from the panel side. But the new alert text now
  says so directly, with a power-cycle hint, instead of a generic
  "is not reporting" that left the user wondering whether to debug
  the dashboard or the device.

## 0.7.6 — 2026-05-24

Patch + feature — full **Home Assistant Energy Dashboard** integration.

### Features

- **Persistent lifetime energy counters.** New `lifetime_totals` table
  inside `/data/ecoflow.db` accumulates integrated Wh per metric under a
  watermark — every 5 min we integrate `(watermark, now]` from the
  rolling 30-day `samples` table, add the result to the persisted Wh,
  then advance the watermark. Pruning of raw samples can't decrement the
  counter; a server restart can't decrement it (boot seeds the floor
  from the persisted row); a transient negative sample can't decrement
  it (clamped at zero). Five counters maintained:
  - `fleet_pv_wh` — sum of every DPU's `pv_total` watts integrated over time
  - `fleet_load_wh` — SHP2 `panel_load` watts integrated
  - `fleet_grid_import_wh` — sum of grid-tied DPUs' `ac_in` watts integrated
  - `fleet_battery_charge_wh` — sourced directly from the **BMS
    `accuChgMah` lifetime counters** across all packs, converted to Wh
    at 102.4 V nominal. Authoritative since pack manufacture.
  - `fleet_battery_discharge_wh` — same from `accuDsgMah`.
- **HA Energy Dashboard wiring.** Five new sensors with
  `state_class: total_increasing` + `device_class: energy` so Home
  Assistant can ingest them into the Energy Dashboard's hourly /
  daily / monthly statistics: PV Production, Home Consumption, Grid
  Import (lifetime), Battery Energy In, Battery Energy Out.

### API

- **`/api/lifetime-energy`** — returns the five lifetime kWh values
  plus a `details` block exposing `persistedWh` + `pendingWh` +
  `watermarkMs` per metric (useful for diagnosing the rollup).
- **`/api/ha-state`** gains 5 new lifetime kWh fields:
  `pv_lifetime_kwh`, `load_lifetime_kwh`, `grid_import_lifetime_kwh`,
  `battery_charge_lifetime_kwh`, `battery_discharge_lifetime_kwh`.

### MQTT Discovery

- 5 additional auto-discovered sensors when
  `MQTT_DISCOVERY_ENABLED=1` is set — the Energy Dashboard slots fill
  themselves with no YAML edits.

### Docs

- New **HA Energy Dashboard** subsection in `DOCS.md` walks through
  the Settings → Dashboards → Energy hookup (one sensor per slot)
  and documents the persistence design + reset semantics.

### Notes

- The recorder's existing 30-day retention on raw samples is
  unchanged — `lifetime_totals` is a separate, lightweight, never-
  pruned table (one row per metric).
- On first install, the watermark seeds 60 s before boot so the
  initial rollup doesn't try to integrate years of empty history;
  numbers grow from there as live data arrives.
- The `close()` shutdown path now does a final rollup before closing
  the DB so we don't lose the trailing minute of energy.

## 0.7.5 — 2026-05-24

The "drain the roadmap" release. Every remaining roadmap item from
v0.7.0 + v0.8.0+ + external/infrastructure is shipped here in a single
batch — 17 features across analytics, alerting, and integration.
Pre-existing functionality is unchanged; everything new is purely
additive (new endpoints, new optional modules, one new card on the
Predictive Insights page).

### Features — Anomaly engine v2 (finish)

- **Alert clustering ("incidents").** Simultaneous alerts on the same
  Core / Pack are grouped into one Incident with one notification —
  a "Core 3 thermal cascade" with 5 contributing alerts now fires
  once, not five times. The Incident keeps every member alert ID so
  the detailed view still drills down. Exposed via new
  `/api/incidents` and surfaced in the v0.7.5 Advanced Insights card.
- **Internal-resistance trending.** `dV/dI ≈ effective R` derived
  from snapshot pairs of bus voltage + bus current (≥ 5 A swing, ≤ 60 s
  apart). Per-Core (DPU-level) tracking — recent vs baseline mΩ and a
  trend rate per month. Rising R precedes SoH decay by months on LFP.
  `/api/internal-resistance`.

### Features — Sharper forecasts

- **Forecast-skill calibration.** Hindcast: apply the learned solar
  model coefficients to the past 7 days of GHI to derive "what the
  model would have predicted" and compare with what actually happened
  per day. Reports MAE (kWh and %), bias factor (sum(actual) ÷
  sum(predicted)), and a per-day breakdown — bias factor is the
  correction the user can apply to today's forecast.
  `/api/forecast-skill`.
- **Ambient-coupled thermal forecast.** Two-variable least-squares
  regression of pack temperature against outdoor temperature + recent
  load. Predicts each pack's peak temperature in the next 24 h with
  an R² fit quality, using Open-Meteo's hourly tempC forecast.
  Surfaces "Core 3 Pack 2 will hit 108 °F tomorrow at 3 PM" before
  it happens. `/api/ambient-thermal-forecast`.

### Features — Insights requiring accumulated history

- **Shade-event detection.** Walks clear-sky hours across 45 days of
  history, builds a per-hour reference coefficient from the 90th-
  percentile of observed-PV ÷ GHI ratios, and flags hours whose
  recurring shortfall vs that reference exceeds 18% — physical
  obstruction, not weather. Annualised kWh-loss estimate.
  `/api/shade-report`.
- **Soiling decomposition.** Splits the existing fleet-wide soiling
  drop% per-DPU (each device drifts independently) and per-hour-of-day
  (some hours are more affected — e.g. east-facing morning sun).
  Answers "wash everything vs just the east-facing run?". `/api/soiling-decomposition`.
- **String mismatch / per-DPU production.** Compares each DPU's
  per-hour median PV to the fleet median for the same hour. Robust
  median + MAD + modified-z flags persistent underperformers — string
  mismatch, shaded panel, failing optimizer. `/api/string-mismatch`.
- **EV-charging window prediction.** Scans SHP2 paired-circuit
  history (where the EVSE lives) for sustained ≥ 2 kW sessions ≥ 30
  min, buckets by (weekday, start-hour), requires ≥ 3 recurrences to
  declare a pattern. Projects next 24 h. `/api/ev-window-prediction`.
- **Charge-curve fingerprinting.** Records `pack${N}_vol_max_mv` at
  SoC checkpoints (40 / 60 / 80 / 95 %) during *active charge*
  (`pack${N}_in > 100 W`), then compares today's medians against a
  baseline laid down in the first 14 days of recording. Mean drift in
  mV per pack — catches aging that SoH lags by months. `/api/charge-curve`.

### Features — External / infrastructure

- **NWS storm-preparedness signal.** Opt-in (`NWS_ENABLED=1`,
  US-only). Pulls active alerts.weather.gov alerts within ~50 mi of
  the configured forecast coordinates. Severe events (Tornado,
  Severe Thunderstorm, Hurricane, Excessive Heat, …) emit a
  learned-warning recommending pre-charge to 100% before onset.
  `/api/nws-alerts`.
- **Thermal-event counter.** Cumulative per-pack count of rising-edge
  crossings of three temperature thresholds (96 / 113 / 131 °F) with
  hysteresis so a sustained spell counts as one event. Tracks total
  hours-above-threshold per band and a "hard-life score" (1×warm +
  4×hot + 16×overheat, per year) that's directly comparable across
  packs with different recording histories. `/api/thermal-events`.
- **MPPT efficiency drift + inverter standby losses.** Per-string
  (HV + LV) per-Core: V·A vs reported W ratio (clamped to a sane
  band), recent median vs earliest-30%-of-history median, and a drift
  in percentage points. Inverter standby: ac_out residual when PV
  and panel load are both < 20 W; reports recent idle watts, baseline,
  and a weekly trend. Both in `/api/equipment-health`.
- **Confidence trends.** R² aggregator across the panel's main
  projections (degradation fade, solar response model, ambient
  thermal forecast) plus the forecast-skill bias factor and MAE %.
  Single endpoint snapshot: `/api/confidence`.
- **Notification timing intelligence.** Quiet-hours window
  (`NOTIFY_QUIET_HOURS=22-06` by default) queues warning + info
  alerts during the configured nighttime band; critical alerts
  always go through. At `NOTIFY_DIGEST_HOUR` (default 7) a single
  morning digest fires with the queued list. No more
  "you have 12 notifications about a brief cloud blip at 3 AM".
- **Alert-action telemetry.** Per-alert-ID rise count, longest
  duration, median duration, and short-clear fraction (cleared
  within 10 min). Info-severity alerts that rise ≥ 5 times AND
  short-clear in ≥ 70% of cases get auto-downgraded (silenced).
  `/api/alert-telemetry`.
- **Self-consumption ratio.** Rolling 7-day breakdown of PV
  generation, household load, battery in/out, grid import, and
  the derived solar fraction of load (% of consumption met by
  solar directly or via battery) and direct-use ratio (PV that
  went straight to load). `/api/self-consumption`.
- **MQTT discovery for HA entities.** Opt-in
  (`MQTT_DISCOVERY_ENABLED=1` + `MQTT_DISCOVERY_HOST`). Connects to
  the user's HA MQTT broker (e.g. the official `core-mosquitto`
  add-on), publishes 23 sensor + 1 binary_sensor `homeassistant/...`
  discovery topics with full device-info grouping, and pushes one
  big retained state JSON every 30 s. Drops the YAML-snippet
  requirement entirely for users who already run an MQTT broker.

### API

Fifteen new endpoints — one per feature surface:
`/api/self-consumption`, `/api/thermal-events`,
`/api/equipment-health`, `/api/shade-report`,
`/api/soiling-decomposition`, `/api/string-mismatch`,
`/api/ev-window-prediction`, `/api/charge-curve`,
`/api/internal-resistance`, `/api/forecast-skill`,
`/api/ambient-thermal-forecast`, `/api/confidence`,
`/api/nws-alerts`, `/api/incidents`, `/api/alert-telemetry`.

`/api/ha-state` gains 7 new fields covering self-consumption.

### UI

- New **AdvancedInsightsCard** added to the bottom of the
  Predictive Insights page — one section per analytics family,
  hides sections that have nothing to show yet. Fetches 14
  endpoints on a 60 s interval.

### Docs

- `DOCS.md` HA REST-sensor snippet gains 7 new sensors for the
  self-consumption + clipping numbers. Includes an MQTT-discovery
  setup note covering the opt-in env vars.
- README roadmap collapses: every v0.7.0, v0.8.0+, and
  external/infrastructure item is now shipped. Only WAVE 2 / Smart
  Generator schemas remain in the "Standing" section (blocked on
  EcoFlow shipping the IoT Open API spec).

### Notes

- Every new analytics function is **off the hot path** (cached
  5 – 60 min) and **silently degrades** when its prerequisites are
  missing (no weather, no history, no MQTT broker). No new
  required configuration — every opt-in feature ships off by default.
- MQTT discovery and NWS use `undici`/`mqtt` modules already in
  the dependency tree. No new runtime dependencies.

## 0.6.0 — 2026-05-24

Half-the-roadmap batch — four learned-analytics features tightened
around battery longevity, day-ahead forecasting accuracy, and
identifying solar capacity left on the table.

### Features — Anomaly engine v2

- **Per-circuit baseline anomaly detection.** Until now, each SHP2
  circuit's watts contributed to the panel total but had no
  self-baseline of its own — only paired (split-phase) totals and
  fleet-aggregate metrics had learned baselines. v0.6.0 wires every
  *unpaired* SHP2 circuit into the learned-baseline engine, so an
  individual outlet, freezer, well pump, or office sub-panel that
  starts pulling well outside its own median can fire a learned
  warning. Paired-circuit aggregates already cover the split-phase
  loads (water heater, AC, EV charger), so the per-circuit pass skips
  any channel that's part of a pair to avoid double-counting.

### Features — Forecasting accuracy

- **Day-of-week-aware load curve.** The day-ahead forecast used to
  collapse all weekday and weekend hours into a single hour-of-day
  average — but EV charging, dishwasher / laundry cycles, and
  home-office HVAC duty run on visibly different schedules Mon–Fri
  vs Sat–Sun. The new `hourCurveByWeekday` helper splits the typical
  load into a 24-hour weekday curve and a 24-hour weekend curve;
  `getDayForecast` picks the appropriate curve for each *projected*
  hour. Requires ≥ 24 hourly samples on both sides before the split
  is trusted; otherwise it falls back to the combined curve so a
  fresh install doesn't get whiplash.

### Features — Battery longevity v3

- **Per-pack coulombic efficiency.** Discharge mAh ÷ charge mAh over
  a rolling 7-day window, using the BMS lifetime counters
  (`pack${N}_lifetime_chg_mah`, `pack${N}_lifetime_dsg_mah`). Healthy
  LFP stays well above 99%; a downward drift signals side-reaction
  losses inside a cell that SoH alone may not yet show, and is an
  independent early-warning channel for cell degradation. Surfaced
  as a new fact tile in every pack's expanded view inside the
  degradation card.

### Features — Solar capacity

- **Inverter clipping quantifier.** New `computeClipping` analytics
  function estimates kWh-lost-to-clipping today by walking each
  elapsed daylight hour: an hour is flagged as "at peak" when
  observed PV reaches 95% of the hardware ceiling (highest hourly
  average PV ever observed across the fleet); if the learned
  GHI→PV model says the array could have produced more than what we
  recorded that hour, the difference is the clipped energy. Sum
  across the day → kWh lost to clipping today. The current hour is
  prorated by elapsed fraction. Cached 5 min.

### API

- **`/api/clipping`** — `ClippingEstimate` (today-kWh-lost,
  per-hour breakdown, array peak watts, hours-at-peak).
- **`/api/ha-state`** gains `pv_clipped_kwh_today`,
  `pv_array_peak_watts`, `pv_hours_at_peak_today`.

### Docs / roadmap

- DOCS.md HA snippet adds three new sensors (clipped-kWh-today,
  array-peak-watts, hours-at-peak-today). Total: 20 sensors + 1
  binary_sensor.
- README roadmap: removes the four shipped items, promotes the
  remaining anomaly-engine work (alert clustering) and the sharper-
  forecasts items (forecast-skill calibration) into the v0.7.0
  bucket.

## 0.5.1 — 2026-05-23

Patch fix — web UI / API now binds dual-stack, mirroring v0.3.1's telnet fix.

- `config.ts` + run script: changed the Fastify `HOST` default from
  `0.0.0.0` (IPv4 only) to `::` (Node dual-stack). macOS resolves
  `homeassistant.local` to both an IPv4 and several IPv6 addresses with
  IPv6 listed first; browser happy-eyeballs would race both, the IPv6
  connect would RST against the unbound v6 listener inside the
  add-on's port mapping, and `http://homeassistant.local:8787/` would
  stall or fail. Verified `curl -6 http://homeassistant.local:8787/api/health`
  returned HTTP 000 in ~13ms (TCP RST) while `-4` returned HTTP 200.
  With `::`, both protocols land on the same Fastify listener.

## 0.5.0 — 2026-05-23

### Features — Battery longevity v2

- **Temperature-corrected SoH fade (Arrhenius).** Each projecting or
  stable pack now reports `avgPackTempC` (across the SoH regression
  window), the resulting Arrhenius factor, the **calendar fade
  re-expressed at the 25 °C reference**, and an estimated
  **years-of-life-gained-if-cooled-5 °C** number. Three new fact-tiles
  per pack in the degradation card; the per-pack summary sentence
  appends the Arrhenius note when the data supports it. Direct answer
  to "would moving these to a cooler garage save me X years?" for
  Phoenix-class climates.

- **Round-trip efficiency, rolling 7-day.** Integrates per-pack input
  vs output watts across all DPUs over the last 7 days; ratio shows in
  a new tile on the degradation-card header and as the
  `ecoflow_round_trip_efficiency` HA sensor. Healthy LFP sits 95–97%;
  a slow drift down is the cleanest "the whole stack is aging" signal
  that no single-pack metric catches. Cached 5 min.

### Features — Operational

- **Live off-grid runway.** New prominent card at the top of the
  Dashboard: hours to reserve and hours to empty, projected hour-by-hour
  from the last-hour panel load and the next-24-hour forecast PV.
  Headline colour shifts **red < 4h / amber < 12h / neutral ≥ 12h**.
  Also surfaces the clock times ("Reserve floor reached around Sat
  9 PM") and a breakdown of the assumptions (backup now, reserve floor,
  recent load, forecast PV vs load over the horizon). Exposed as
  `ecoflow_runway_to_reserve_hours` and `ecoflow_runway_to_empty_hours`
  HA sensors. Cached 60 s.

### API

- **`/api/runway`** — RunwayProjection.
- **`/api/round-trip-efficiency?days=N`** — RoundTripEfficiency (days
  capped 1–30, default 7).
- **`/api/ha-state`** gains `runway_to_reserve_hours`,
  `runway_to_empty_hours`, `runway_recent_load_watts`,
  `runway_forecast_pv_used_kwh`, `round_trip_efficiency_percent`,
  `round_trip_charged_kwh_7d`, `round_trip_discharged_kwh_7d`.

### Docs / roadmap

- DOCS.md HA snippet adds three new sensors (runway-to-reserve,
  runway-to-empty, round-trip-efficiency). Total: 17 sensors + 1
  binary_sensor.
- README roadmap expanded to a multi-release plan (v0.6.0 anomaly
  engine v2, v0.7.0 sharper forecasts, v0.8.0+ pattern detection with
  history, plus external-integration and standing buckets).

## 0.4.0 — 2026-05-23

### Features

- **Per-circuit multi-day kWh comparison on the circuit modal.** Click
  any SHP2 circuit on the Dashboard → in addition to the live "now",
  "peak (24h)", "average (24h)", "today" tiles and the 24h watt chart,
  there's a new **Last 7 days** panel: a bar chart of daily kWh totals
  for the past week, with **today highlighted in accent** as a partial /
  running total, the **peak day color-coded amber**, days with no data
  rendered dim, and a **dashed reference line at the 7-day average**.
  Hovering any bar shows that day's total kWh, peak watts, when the
  peak hit, and a "partial day" caveat for incomplete windows. Three
  summary tiles below the chart: average per day (with "N/7 days w/
  data" coverage note), peak day, and quietest day.

- **New `/api/circuit/history?sn=<SN>&ch=<N>&days=<N>` endpoint.**
  Returns per-day trapezoidal kWh + peak watts + peak timestamp +
  coverage, plus a summary block (average, peak day, min day). Day
  windows are local-midnight to next local-midnight (or `now` for the
  in-progress day). Days capped at 30 to keep recorder queries bounded;
  default is 7.

## 0.3.1 — 2026-05-23

Patch fix for the telnet TUI over `homeassistant.local`.

- **Telnet binds dual-stack** — changed the `TELNET_HOST` default from
  `0.0.0.0` (IPv4 only) to `::` (Node dual-stack: listens on both IPv4
  and IPv6 on one socket; Node leaves `IPV6_V6ONLY` off so IPv4 clients
  still connect via mapped addresses). macOS resolves
  `homeassistant.local` to both an IPv4 and several IPv6 addresses with
  IPv6 listed first; `getaddrinfo` (which `nc`/`telnet`/`python socket`
  all use) picks IPv6, so `nc homeassistant.local 2323` was reaching the
  HA host's IPv6 stack — which had no listener for the add-on's port —
  and the TCP handshake completed only to be immediately RST'd
  ("Connection reset by peer"). The IPv4 path always worked
  (`nc -4 hostname`, or `nc <IP>`) but it wasn't discoverable. With `::`,
  both protocols land on the same telnet listener.

## 0.3.0 — 2026-05-23

### Features

- **Home Assistant entities integration** — new `/api/ha-state` endpoint
  returns a flat key-value JSON designed for HA's `rest:` integration. One
  HTTP call surfaces ~13 sensors + 1 binary_sensor (backup pool %, panel
  load, AC import, off-grid status, day-ahead forecast, soonest-EOL pack,
  alert counts, peer-outlier count, etc.). Forecast + degradation are
  reused from their internal caches, so HA polling every 30s is
  essentially free. See `DOCS.md` → "Home Assistant entities" for the
  copy-pasteable `configuration.yaml` snippet and example automations
  (backup-pool-low, critical-alert, projected-SoC-dip).

### Chores

- `dependabot.yml`: ignore major version bumps. The first batch of
  Dependabot PRs was all majors (React 18→19, Tailwind 3→4, TS 5→6,
  Vite 6→8, Fastify ecosystem majors, Node 22→26) — each one needed
  deliberate migration work, none was auto-mergeable. All seven closed;
  going forward only minor/patch updates auto-PR.

- README: moved "HA service integration" from Roadmap to Phase 7
  (shipped). Dropped the "Pre-built multi-arch GHCR images" roadmap line
  (shipped in Phase 6). New roadmap entry: MQTT discovery for HA
  entities, to auto-register sensors without a YAML snippet.

## 0.2.3 — 2026-05-22

Runtime fix for the start crash loop.

- `config.yaml`: added `init: false`. HA's `init: true` default wraps the
  container with Docker's tini, making tini PID 1. The HA base image
  already ships its own s6-overlay `/init`; with tini in front, the
  base's `s6-overlay-suexec` saw it wasn't PID 1 and refused to start,
  producing the crash-loop log:
  ```
  s6-overlay-suexec: fatal: can only run as pid 1
  ```
  Setting `init: false` disables tini so our `/init` (s6) runs as PID 1 —
  the standard pattern for any add-on built on the official HA base
  images.

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
