## 14. Intelligent Lighting & HVAC Posture (energy-aware automation)

This cluster documents the add-on's **energy-aware automation layer** — the signals the
add-on computes and publishes so that *Home-Assistant-side* automations can make the
home's lighting (and, in an aspirational Phase-2 sense, its HVAC) behave according to how
much stored/harvested energy is actually available overnight.

> **Read this first — the division of labor.** The add-on is a *sensor*, not an
> *actuator*, in this layer. It computes one runway-driven enum (**Lighting Posture**) and
> a set of **PV-curtailment / surplus** signals, and publishes them as MQTT sensors. It
> **never toggles a light, never sets a thermostat, never calls a dimmer**. All of the
> actuation the design narrative describes — heartbeat pulses, exterior-light policy,
> "dimmer ceilings", pre-cool — lives in **Home Assistant automations** that the operator
> writes and that are gated behind `input_boolean.lighting_postures_enabled`. Where the
> code is explicit that a consumer is HA-side or a feature is dormant, this document says
> so plainly rather than describing behavior that does not exist in the repo.

The two concrete engines that live in the add-on are:

1. **Lighting Posture sensor** — `server/src/lightingPosture.ts` (the runway-driven enum +
   asymmetric hysteresis + restart persistence), published by
   `server/src/mqttDiscovery.ts`.
2. **PV-curtailment / surplus + opportunistic loads** — `computeCurtailment()` in
   `server/src/analytics.ts`, which produces the `surplus` posture trigger and the
   (advisory-only) `ac_precool` / `dehumidifier` HVAC suggestions.

Everything else in the "HVAC posture framework" is **dormant** — it exists as data
structures and `null`-valued hint fields, not as running logic. This is stated honestly in
the relevant section below.

---

### 1. Lighting Posture sensor

#### 1.1 WHAT it does + why

`lightingPosture.ts` distills the whole overnight-energy question into **one enum** that HA
automations can key on. The central design decision (from the file header) is that the
posture is driven by the **runway model's forward question** — *"will we reach sunrise
above the reserve floor?"* — **not by raw State-of-Charge**:

> *"a 45% pool at 21:00 with a clear-day forecast is fine; the same pool at 01:00 drawing
> 8 kW is not. Raw-SoC triggers nag on good nights and under-react on bad ones."*

The published enum is a six-level escalating ladder:

| Posture | Meaning (from header) | Severity rank |
|---|---|---|
| `surplus` | PV curtailment active — energy is going unharvested; lighting (and everything) may run freely. Only entered from normal. | 0 |
| `normal` | Projected dawn minimum comfortably above reserve. | 0 |
| `conserve` | Projected dawn minimum getting thin (`< CONSERVE_DAWN_PCT`). | 1 |
| `amber` | A reserve crossing is projected within the horizon. | 2 |
| `red` | The crossing is near (`≤ RED_HOURS_TO_RESERVE` h away). | 3 |
| `critical` | The pool is at/below its reserve floor **right now**. | 4 |

The severity ranks come from `POSTURE_RANK`:

```ts
const POSTURE_RANK: Record<LightingPosture, number> = {
  surplus: 0, normal: 0, conserve: 1, amber: 2, red: 3, critical: 4,
};
```

Note `surplus` and `normal` **share rank 0** — `surplus` is *not* a warning tier, it is
"normal with headroom", so the two swap freely without tripping the hysteresis.

#### 1.2 INPUTS

The classifier takes a `PostureInputs` object (assembled fresh on every MQTT publish in
`mqttDiscovery.ts`):

| Field | Type | Source (see §1.5 trace) | Meaning |
|---|---|---|---|
| `belowReserveFloor` | `boolean` | `belowReserveFloor(runway)` — the runway report | Pool currently at/below its reserve floor. |
| `hoursToReserve` | `number \| null` | `runway.hoursToReserve` | Projected hours until the pool crosses reserve; `null` = no crossing in horizon. |
| `dawnMinSocPct` | `number \| null` | `forecast.minProjectedSoc` | Forecast's projected minimum SoC % over the horizon (the "dawn minimum"). |
| `reservePct` | `number \| null` | `shp2.projection.backupReserveSoc` | The SHP2's configured reserve %, used for the amber margin. |
| `curtailmentActive` | `boolean` | `curtailment.active` (`computeCurtailment`) | PV curtailment currently active (energy going unharvested). |
| `gridBackstopping` | `boolean?` (v0.87.0) | `liveGridBackstop(snap.devices).backstopping` | The utility grid is genuinely carrying/able to carry the home right now. |
| `gridImportLive` | `boolean?` (v1.186.3) | `liveGridBackstop(snap.devices).importLive` | Measured grid import is flowing. Selects only the wording of the grid-backstop reason ("grid supplying the house" vs "grid available as backup"). |
| `nowMs` | `number` | `Date.now()` | Clock injection (deterministic in tests). |

#### 1.3 The CALCULATION — `rawPosture(i)` then hysteresis

The classification is a **pure function** `rawPosture()` (no state, exported for tests),
wrapped by a **stateful tracker** that applies asymmetric hysteresis and restart
persistence.

##### 1.3.1 `rawPosture()` — the pure classifier

Real constants (from the file):

```ts
const CONSERVE_DAWN_PCT      = 35;   // dawn-min % below which "conserve" engages
const AMBER_DAWN_MARGIN_PCT  = 5;    // margin above reserve % treated as "grazing"
const RED_HOURS_TO_RESERVE   = 4;    // hoursToReserve at/below which "red" engages
```

Evaluation order (first match wins):

1. **`critical`** — if `belowReserveFloor` is true → `critical`, reason `"pool at/below
   reserve floor"`. (This is the only branch that fires when below floor; it is checked
   *before* the grid-backstop short-circuit, so a floored pool is always critical.)

2. **Grid-backstop short-circuit (v0.87.0)** — if `gridBackstopping` is true (and we are
   above the floor, since branch 1 already handled the floor): the runway-to-reserve
   projection is *islanded-only* — on a grid-tied evening the SHP2 simply transfers to
   mains at the floor, so the depletion escalations must **not** fire. Result:
   - if `curtailmentActive` → `surplus` (excess solar still applies), else
   - `normal`, reason `"grid available as backup — depletion projection is for an outage only"` — or `"grid supplying the house — …"` while measured grid import flows (`gridImportLive`, v1.186.3; wording only).

   When `gridBackstopping` is false/absent (islanding — the **safe default**), the full
   ladder below runs unchanged.

3. **`red`** — if `hoursToReserve != null && hoursToReserve <= RED_HOURS_TO_RESERVE (4)` →
   `red`, reason `"reserve crossing in {h}h"`.

4. **`amber`** — with `reserve = reservePct ?? 15` (the 15% fallback), amber fires if
   **either**:
   - `hoursToReserve != null` (a crossing is projected, just >4 h out), **or**
   - `dawnMinSocPct != null && dawnMinSocPct < reserve + AMBER_DAWN_MARGIN_PCT` (dawn
     minimum grazes within 5 points of reserve).

   Reason is either `"reserve crossing in {h}h"` or `"dawn minimum {n}% grazes reserve
   {reserve}%"`.

5. **`conserve`** — if `dawnMinSocPct != null && dawnMinSocPct < CONSERVE_DAWN_PCT (35)` →
   `conserve`, reason `"dawn minimum {n}% (< 35%)"`.

6. **`surplus`** — if `curtailmentActive` → `surplus`, reason `"PV curtailment active —
   surplus energy available"`.

7. **`normal`** (fallthrough) — reason `"dawn minimum {n}%"` when a dawn minimum is available, else `"no
   depletion projected"`.

##### 1.3.2 Asymmetric hysteresis — `createPostureTracker()`

The stateful wrapper enforces **"escalate immediately, de-escalate slowly"**:

```ts
export const DEESCALATE_HOLD_MS = 15 * 60 * 1000;   // 15 minutes
```

On each `update(i)`:

- **First tick** (`current == null`): adopt the raw posture, set `changedAtMs = nowMs`.
- **Escalation** (`POSTURE_RANK[raw] > POSTURE_RANK[current]`): apply **immediately**
  (safety first), reset the calmer-hold timer.
- **De-escalation** (`POSTURE_RANK[raw] < POSTURE_RANK[current]`): start (or continue) a
  `calmerSinceMs` timer. Only when the calmer raw posture has **held for `holdMs`
  (15 min)** does `current` actually relax. Otherwise the sterner posture (and its
  original reason) is held. This stops a cloud edge or a compressor cycle from making the
  house "breathe up and down".
- **Same rank, same posture**: adopt the fresh reason immediately; any pending hold or dwell is cleared.
- **Same rank, different posture** (`normal↔surplus`, v1.63.0): the swap must hold for
  `SURPLUS_DWELL_MS` (10 min) before it is adopted, in both directions. Until then the current
  posture is held. The posture is an actuation edge for HA-side automations, such as a surplus
  pre-cool that moves thermostat setpoints on `→ surplus` and restores them on `→ normal`. The
  upstream curtailment signal is a bare 300 W threshold with no hysteresis of its own. A move
  from `surplus` to `conserve`/`amber`/`red`/`critical` is a rank increase and still applies on
  the next tick.

The classifier is deliberately re-evaluated every publish; only the *hold* is asymmetric.

##### 1.3.3 Restart persistence (v0.15.20)

The tracker was process-local, so an add-on restart mid-event flapped the published
posture (observed live Jun 11 19:28 local: `amber → normal → amber` within minutes),
firing a spurious "restore-then-reclamp" heartbeat at the family. The tracker now
persists `{posture, reason, changedAtMs, calmerSinceMs, swapSinceMs, savedAtMs}` to disk (`swapSinceMs`, v1.63.0, is absent from older files and read as null, so the dwell restarts):

- **Write policy (SD-card diet):** persist only on posture changes and hold-window
  transitions — **not** every tick.
- **Load-on-start:** on construction with a `statePath`, `loadPersisted()` restores the
  held posture so a restart **resumes** it. A half-warm calmer reading after restart is
  merely a de-escalation *candidate* that must still survive the 15-min hold.
- **Staleness guard:** persisted state older than `PERSIST_MAX_AGE_MS = 60 * 60 * 1000`
  (1 hour) is discarded (the event is likely over → start fresh). Corrupt JSON or an
  unknown posture string also → start fresh.
- Writes go through `atomicWriteFileSync` (`atomicWrite.ts`, shared with battery-soc-alarm
  / runway-alarm) so a crash mid-write cannot corrupt the file.

State path resolution:

```ts
const STATE_PATH =
  process.env.LIGHTING_POSTURE_STATE_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'lighting-posture.json');
```

The process-wide singleton `lightingPostureTracker` (created with `DEESCALATE_HOLD_MS` and
`STATE_PATH`) is shared by every consumer.

#### 1.4 OUTPUTS + API / MQTT

The tracker returns `{ posture, reason, changedAtMs }`. Two values are published as MQTT
discovery sensors (`mqttDiscovery.ts`):

| MQTT `unique_id` | Sensor name | value_json key | Notes |
|---|---|---|---|
| `ecoflow_lighting_posture` | Lighting Posture | `lighting_posture` | icon `mdi:lightbulb-auto`; the enum string. |
| `ecoflow_lighting_posture_reason` | Lighting Posture Reason | `lighting_posture_reason` | icon `mdi:information-outline`; `entity_category: diagnostic`; human-readable basis. |

Data shape (fields of the MQTT state payload):

```json
{
  "lighting_posture": "amber",
  "lighting_posture_reason": "dawn minimum 18% grazes reserve 15%"
}
```

These are **not** exposed on a dedicated REST endpoint — they are computed inside the MQTT
`buildState` path (`mqttDiscovery.ts` ~line 1337) and delivered to HA via MQTT. (The
underlying inputs — `runway`, `forecast`, `curtailment` — each have their own `/api/*`
endpoints; see §2 for curtailment.)

#### 1.5 The TRACE — where inputs come from, where the output goes

**Upstream (inputs):** In `mqttDiscovery.ts` `buildState`, the code settles each analytics
report on its own with `settleStateReports` (v1.186.0). A report's value is its answer within
`STATE_REPORT_WAIT_MS` (5 s), otherwise its last good answer if that is no older than the live
sensors' `expire_after`, otherwise null. The reports are `forecast`, `degradation`, `runway`, `roundTripEfficiency`,
`clipping`, `selfConsumption`, `carbon`, `tariff`, `curtailment` — then calls
`lightingPostureTracker.update({...})` with:

```
belowReserveFloor : belowReserveFloor(runway)
hoursToReserve    : runway.hoursToReserve
dawnMinSocPct     : forecast.minProjectedSoc
reservePct        : shp2.projection.backupReserveSoc ?? null
curtailmentActive : !!curtailment.active
gridBackstopping  : liveGridBackstop(snap.devices).backstopping
gridImportLive    : liveGridBackstop(snap.devices).importLive   // v1.186.3 — reason wording only
nowMs             : Date.now()
```

The `gridBackstopping` resolver `liveGridBackstop()` is the **same** grid-presence
resolver used by the `off_grid` and `runway_projection_islanded_only` sensors and by the
floor-alarm engine, so the posture's grid-awareness is coherent with the alarm layer.

**Downstream (output → actuation):** The two MQTT sensors land in HA. From the file
header and `mqttDiscovery.ts` comments, the intended HA-side consumers are:

- a **heartbeat pulse** (a brief light flash on escalation edges),
- an **exterior-light policy**,
- **dimmer ceilings** (cap brightness under conserve/amber/red).

**All of these are HA automations the operator writes**, and they are **gated behind
`input_boolean.lighting_postures_enabled`** — the add-on "only ever computes and
publishes" and "never toggles a light". The escalation-edge-triggered nature of these
consumers is exactly why the restart-persistence work (§1.3.3) matters: a flap would fire a
spurious pulse at the household.

#### 1.6 CONFIG knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `LIGHTING_POSTURE_STATE_PATH` | env var | `<config.dbPath>/../lighting-posture.json` | Override the persistence file location. |
| `input_boolean.lighting_postures_enabled` | **HA-side** (operator-created) | — | Master gate for all lighting-posture *consumers*. The add-on ignores it; it only gates HA automations. |

The classification thresholds — `CONSERVE_DAWN_PCT` (35), `AMBER_DAWN_MARGIN_PCT` (5),
`RED_HOURS_TO_RESERVE` (4), `DEESCALATE_HOLD_MS` (15 min), `SURPLUS_DWELL_MS` (10 min, v1.63.0), `PERSIST_MAX_AGE_MS` (1 h) — are
**compile-time constants**, not env/config options. There is no config.yaml option to tune
the posture ladder; changing it requires a code change.

#### 1.7 EDGE CASES / guards / honest-null behavior

- **Floor beats everything.** `belowReserveFloor → critical` is checked *before* the
  grid-backstop short-circuit, so a floored pool is `critical` even on grid.
- **Grid-tied evenings do not nag.** With `gridBackstopping` true and above floor, the
  depletion escalations (`red`/`amber`/`conserve`) are suppressed — only `surplus`/`normal`
  can publish. Absent/false grid signal → full ladder (the islanding-safe default).
- **Missing reports publish no posture (v1.186.0, v1.187.10).** The tracker is advanced only
  when the `runway`, `forecast` and `curtailment` reports all settled. It is also not advanced
  when the forecast (`homeBasisPending`) or the runway (`basisPending`) was built while a home
  Core's first reading was pending. Otherwise `lighting_posture` and `lighting_posture_reason`
  publish null ("unknown" in HA) and the held posture is left untouched, so no posture is
  computed from reports that were never measured.
- **Missing forecast/runway inputs** are `null`-tolerant: with `hoursToReserve == null` and
  `dawnMinSocPct == null`, none of the amber/conserve branches fire and the result is
  `normal` ("no depletion projected") — an honest "no data → no alarm" rather than a
  fabricated warning.
- **`reservePct` fallback** is `15` when the SHP2 reserve is unknown.
- **Same-rank `surplus↔normal`** swaps do not trip the 15-min de-escalation hold (both rank 0), but they must dwell `SURPLUS_DWELL_MS` (10 min) before they publish (v1.63.0). A restart mid-dwell resumes the countdown because `swapSinceMs` is persisted.
- **Persistence is best-effort:** save failures are swallowed (`catch {}`) — the only cost
  is one possible restart flap; corrupt/stale state is discarded, never trusted.
- **Restart mid-hold resumes the countdown** rather than resetting it (the hold-start
  timestamp is persisted).

---

### 2. PV-curtailment / surplus signal + opportunistic loads

#### 2.1 WHAT it does + why

`computeCurtailment()` (`analytics.ts`) is the engine behind the **`surplus`** posture and
the surplus/opportunistic-load layer. It answers: *is the fleet's PV being thrown away
right now because the batteries are saturated, and if so how much surplus power is
available to soak up?* This is distinct from inverter **clipping** (a separate report) —
this is **SoC-saturation** curtailment: PV that the array could produce but the pool won't
accept because it's near its charge ceiling.

Two things flow out of it into the automation layer:

1. `active` / `currentSurplusW` → the **`curtailmentActive`** input to lighting posture
   (drives `surplus`) and the `pv_curtailment_*` MQTT sensors.
2. `opportunisticLoads[]` → a ranked list of loads that could absorb the surplus, each
   flagged `fitsInSurplus`. This is where the (advisory) HVAC pre-cool suggestion lives.

#### 2.2 INPUTS

- Live home-DPU SoC, PV actual (W), and load (W) from the device snapshots
  (`homeConnectedDpus`, the SHP2 device).
- Per-DPU charge ceiling `projection.chgMaxSoc` → `homeChargeCeilingPct()` (mean across
  home DPUs).
- Weather GHI (`radiationWm2`) for the current hour from the weather cache.
- The **Bayesian solar posterior** (expected PV given hour-of-day and GHI).
- 7 days of recorder history for the today/7-day curtailment walk and hour-of-day
  histogram.

#### 2.3 The CALCULATION (relevant constants)

```ts
const CURTAIL_TTL_MS         = 5 * 60 * 1000;  // report cached 5 min
const CURTAIL_MIN_SURPLUS_W  = 300;            // min gap before we call it curtailment
const CURTAIL_MIN_BAYES_SAMPLES = 3;           // posterior support required
const CURTAIL_TAPER_BAND_PCT = 10;             // chargeTaper.ts: SoC band below ceiling where shedding begins
```

- **Saturation threshold:** `saturationThresholdPct(ceiling) = max(0, (ceiling>0 ? ceiling
  : 100) − CURTAIL_TAPER_BAND_PCT)`. With no reported ceiling this is `100 − 10 = 90%`
  (taper-aware; replaces an older fixed 96).
- **Expected PV** comes from `predictExpectedPv()` = `posteriorMean × GHI`, but only if the
  hour's posterior has `≥ CURTAIL_MIN_BAYES_SAMPLES (3)` samples — else `null` (honest
  "no model").
- **Surplus** is the expected-minus-actual PV gap (`expected − pvActualW`, not netted against
  load). Curtailment is `active` only when all of these hold:
  - the home-DPU mean SoC is ≥ the saturation threshold;
  - actual PV is ≥ `CURTAIL_MIN_PV_W` (200 W);
  - GHI is ≥ `CURTAIL_MIN_GHI_WM2` (100 W/m²);
  - a trusted model exists;
  - the gap is ≥ `CURTAIL_MIN_SURPLUS_W` (300 W);
  - PV does not exceed `CURTAIL_PV_MATCH_LOAD_FACTOR` (2.0) × the SHP2 circuit load when that
    load is > 100 W. Load is used only as this disqualifier. Otherwise `inactiveReason` is one of:
  `soc-too-low | pv-too-low | no-daylight | no-model | small-gap | pv-exceeds-load |
  no-shp2 | no-home-dpus`.
- **Opportunistic loads** are sized against `currentSurplusW`: each load's `fitsInSurplus =
  currentSurplusW >= estimatedW`.

#### 2.4 OUTPUTS + endpoints

**REST:** `GET /api/curtailment` (cached 60 s) returns the full `CurtailmentReport`;
curtailment fields are also folded into the big `/api/ha-state` payload
(`pv_curtailment_active`, `pv_curtailment_surplus_watts`, `pv_curtailment_kwh_today`,
`pv_curtailment_kwh_7d`, …).

**MQTT sensors** (`mqttDiscovery.ts`):

| unique_id | key | notes |
|---|---|---|
| `ecoflow_pv_curtailment_active` | `pv_curtailment_active` | binary ON/OFF; the `surplus`-posture trigger. |
| `ecoflow_pv_curtailment_surplus_watts` | `pv_curtailment_surplus_watts` | power (W). |
| `ecoflow_pv_curtailment_kwh_today` | `pv_curtailment_kwh_today` | energy, `total` with `last_reset` from `pv_curtailment_kwh_today_since` (v1.187.10). |
| `ecoflow_pv_curtailment_kwh_7d` | `pv_curtailment_kwh_7d` | 7-day kWh. |
| `ecoflow_charge_ceiling` | `pv_curtailment_charge_ceiling_pct` | diagnostic, %. |

> Historical note (v0.15.3): the `curtailment` report was originally not fetched in the
> MQTT `buildState`, so the five `pv_curtailment_*` sensors (added v0.9.77) read permanent
> "unknown". Wiring the fetch lit them up *and* gave lighting posture its live
> `pv_curtailment_active` signal.

#### 2.5 CONFIG knobs

The opportunistic-load catalog below is the built-in default, sized for the reference plant's
home. The add-on option `OPPORTUNISTIC_LOADS` replaces it (`<id>:<watts>:<category>[:<label>]`,
comma-separated, the category one of pool, ev, water, hvac or other; `none` empties it); while
it is unset the list below applies unchanged. The curtail constants above are compile-time, and
there is no knob for the surplus thresholds.

---

### 3. HVAC posture framework + surplus pre-cool — DORMANT (honest status)

**This is the section to read carefully, because most of the "HVAC posture" narrative is
aspirational, not running code.**

#### 3.1 What actually exists

The only HVAC-related logic in the add-on is **two entries in the opportunistic-load
catalog** (`DEFAULT_OPPORTUNISTIC_LOADS` in `analytics.ts`), both `category: 'hvac'`:

```ts
{ id: 'ac_precool',
  name: 'AC pre-cool (-5°F)',
  estimatedW: 3500,
  category: 'hvac',
  description: 'Drop the thermostat ~5°F now to bank thermal mass for evening hours when SoC is dropping.' },
{ id: 'dehumidifier',
  name: 'Dehumidifier',
  estimatedW: 700,
  category: 'hvac',
  description: 'Reduces moisture load the AC has to remove later — banks comfort into the building envelope.' },
```

**Surplus pre-cool rationale:** when PV is being curtailed (surplus energy is free and
otherwise wasted), it is cheap to over-cool the house now — "banking thermal mass" into the
building envelope — so the AC runs *less* in the evening when SoC is falling and every watt
comes out of the battery. The engine surfaces `ac_precool` with `fitsInSurplus = true`
whenever `currentSurplusW ≥ 3500 W`, and `dehumidifier` when `≥ 700 W`. That is the extent
of the computation.

#### 3.2 What does NOT exist (dormant / Phase-2)

- **No HVAC posture sensor.** There is no `hvac_posture` / `climate_posture` /
  `cooling_posture` MQTT sensor or REST field anywhere in the code — grep confirms zero
  matches. The "posture" concept is implemented only for **lighting**.
- **No ecobee / thermostat actuation from this layer.** The `ecobee` references in the
  server (`broadcast.ts`, plus one comment in `haService.ts`) — and those are about the ecobee units' **speakers** as
  audible-alert / TTS targets (`media_player.*`), **not** climate control. The add-on never
  calls `climate.set_temperature` or any thermostat service.
- **`haServiceHint` is always `null`.** Every opportunistic load is built with
  `haServiceHint: null // Phase 2 — wire to HA service.call here.` The intended automatic
  actuation (have the add-on itself call an HA service to start the pre-cool) is an
  explicitly-deferred Phase-2 feature that is not implemented.
- **`haService.ts` snapshot/restore is unrelated.** The `sonos.snapshot` / `sonos.restore`
  helpers in `haService.ts` exist to avoid clobbering music during audible announcements —
  they are **not** an HVAC/lighting "snapshot & restore" mechanism. Likewise the "gauge"
  references in the codebase are the SHP2 backup-pool gauge and self-consumption gauge
  *icons*, not a "capacity-gauge ceiling" engine.

#### 3.3 On "capacity-gauge ceilings" and "dimmer ceilings"

The design narrative refers to "ceilings" in a couple of senses; to be precise about what
is add-on code vs. HA-side:

- The only **ceiling computed by the add-on** is the battery **charge ceiling**
  (`homeChargeCeilingPct()` = mean `chgMaxSoc` across home DPUs), used by the curtailment
  engine to decide when the pool is saturated. This is a battery-charge ceiling, not a
  lighting/HVAC output ceiling.
- **"Dimmer ceilings"** (capping light brightness under conserve/amber/red) are named only
  in comments as an **HA-side consumer** of the posture enum. There is **no dimmer-ceiling
  code, no snapshot/restore of light state, and no occupancy-sweep logic in the add-on** —
  those are automations the operator builds in Home Assistant, gated behind
  `input_boolean.lighting_postures_enabled`. If you are looking for the occupancy-sweep or
  brightness-ceiling implementation, it is not in this repo; the add-on's contribution ends
  at publishing `lighting_posture` + `lighting_posture_reason`.

---

### 4. Summary — add-on vs. Home Assistant responsibilities

| Responsibility | Where it lives | Status |
|---|---|---|
| Compute runway-driven lighting posture enum | Add-on (`lightingPosture.ts`) | **Live** |
| Asymmetric hysteresis (immediate up, 15-min down) + 10-min `normal↔surplus` dwell | Add-on | **Live** |
| Restart-persist the held posture | Add-on (atomic JSON, 1-h staleness) | **Live** |
| Publish `lighting_posture` + `_reason` MQTT sensors | Add-on (`mqttDiscovery.ts`) | **Live** |
| Compute PV-curtailment / surplus + `surplus` trigger | Add-on (`computeCurtailment`) | **Live** |
| Rank opportunistic loads incl. AC pre-cool / dehumidifier | Add-on | **Live (advisory only)** |
| Heartbeat pulse / exterior policy / dimmer ceilings / occupancy sweeps | **Home Assistant automations** | HA-side, gated by `input_boolean.lighting_postures_enabled` |
| HVAC posture sensor | — | **Does not exist** |
| Automatic pre-cool actuation (`haServiceHint`) | — | **Dormant / Phase-2 (`null`)** |
| Ecobee climate control | — | **Not implemented** (ecobee is only an audible-alert speaker target) |

**Bottom line:** the add-on is a *posture publisher and surplus estimator*. It computes the
signals honestly (including null-safe "no data → normal/inactive" behavior) and hands them
to Home Assistant. Every actuation — lighting or HVAC — is HA-side automation, and the HVAC
side is little more than a labeled recommendation today.

---

