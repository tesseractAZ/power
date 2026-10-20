## 5. Runway, Depletion & Battery-SoC Alarms (safety-critical)

This cluster is the life-safety heart of the add-on: the engines that decide **when the home is at risk of losing power** and **when to make an audible alarm**. Seven cooperating modules are documented here:

| Module | File | Role |
| --- | --- | --- |
| Runway depletion sim | `analytics.ts` (`computeRunway`) | Hour-by-hour DC-pool depletion projection → `hoursToReserve` / `hoursToEmpty` |
| Runway audible alarm | `runwayAlarm.ts` (`classifyRunway`, `createRunwayAlarm`) | Maps a runway projection to an ISA priority and drives the dedicated audible path |
| Battery-SoC floor alarm | `batterySocAlarm.ts` | The 50/40/30/20/15/10/8/4/2 % descending-crossing ladder |
| SoC ladder wiring | `socLadders.ts` (`startSocLadders`) | The store tick that feeds the house ladder, one ladder per secondary panel and the grid-drop re-escalation, behind the boot gate (§3.8) |
| Grid backstop resolver | `gridState.ts` (`resolveGridBackstop`, `liveGridBackstop`) | Answers "is the grid carrying the home right now?" — the input that re-escalates islanded vs grid-backed |
| Load-shed advisor | `loadShedAdvisor.ts` | Advisory-only counterfactual: "shed X, runway extends to Y" |
| Grid dispatch helpers | `socGridDispatch.ts` | Pure SoC grid-downgrade + grid-drop re-escalation logic |

Two overarching **safety invariants** govern the whole cluster and are repeated throughout the source:

1. **Conservative PV basis, never optimistic.** The depletion sim reads *only* the reporting-only forecast PV series (live-present home Cores). Any restored/estimated/scaled PV would lengthen runway and under-alarm during a wedge. This is pinned by `runwayPvBasisGuard.test.ts`.
2. **Fail toward "off-grid / still an emergency."** Every grid-presence signal defaults to *not present / not backstopping* when missing, stale, or unknown. A false "grid is fine" that silences a real off-grid emergency is the one outcome the code refuses; an extra alert when the grid was actually fine is merely annoying.

---

### 1. The runway depletion simulation — `computeRunway`

#### 1.1 What it does + why

`computeRunway` (analytics.ts) projects the SHP2 backup pool forward hour-by-hour over a 24 h horizon and reports **how many hours until the pool reaches its reserve floor (`hoursToReserve`) and until it hits empty (`hoursToEmpty`)**, given the recent load and the forecast solar. This is the "act now so we last until the sun comes back" signal that the SoC-threshold ladder (§3) cannot give — the ladder only fires once the pool has *already* fallen to a threshold, whereas the runway sim fires while the pool is still healthy but the (PV − load) trajectory is headed below reserve before solar recovers.

#### 1.2 Inputs

| Input | Source | Notes |
| --- | --- | --- |
| `backupRemainWh`, `backupFullCapWh` | SHP2 projection (`backupIncreInfo` aggregate) | Pool remaining / full capacity, Wh → kWh; nameplate, so × `capacityScale` (v1.187.19, §1.3a) |
| `capacityScale`, `overheadW` | `runwayEnergyBasis` (`poolEnergyBasis.ts` + `runwayPoolOverheadW`) | Measured full-charge / nameplate ratio of the panel's connected Cores; the Cores' fixed drain (§1.3a) |
| `getOwnerReserveFloorPct()` → `backupReserveSoc` | Owner floor (night-charge actuator), else SHP2 projection | Reserve floor %: the owner's floor first (v1.115.0, §12h), else the live `backupReserveSoc`, else **15** |
| `panel_load` (last hour) | Recorder series on `shp2.sn` | Averaged over `RUNWAY_LOAD_WINDOW_MS` = 60 min |
| `forecast.hours[h].forecastPvW` | `getDayForecast` (reporting-only `solarModel`) | Per-hour PV, first 24 h |
| `forecast.hours[h].forecastLoadW` | `getDayForecast` diurnal/day-of-week load curve | Per-hour load |
| `forecast.hours[h].predictedEvLoadW` | `getDayForecast` EV window prediction | **Subtracted out** of the alarm load (see §1.5) |

**v1.99.0 — EV recurrence probability divides by CALENDAR days.** A mined pattern is confidence-weighted by how often it actually fires, so a sparse charger contributes its expected value rather than its full plateau. The denominator counted days on which ANY EV session occurred, not calendar days in the window — with 4-5 charging days in 30, every probability was ~7.5x too high (measured live: `recurrences: 3` reporting `probability: 0.6` where 3/30 = 0.10 is honest, putting `predictedEvLoadW: 7643` from a 10.19 kW plateau into four consecutive day-ahead hours). This accounted for essentially the whole load-forecast bias (`loadBias` -0.241, load OVER-forecast by ~24%). The weekday-keyed branch carried the identical defect and is fixed the same way. The denominator is bounded by REAL history — a recorder holding 10 days divides by 10, not 30, so a young install does not under-predict a genuinely frequent charger. Net effect on night-charge sizing: predicted load falls, so the planner buys less; the supervised write clamp `[10,50]` bounds it either way.

#### 1.3 The calculation, step by step

**Step 0 — cache.** Returns the cached projection if it is younger than `RUNWAY_TTL_MS` = 60 s.

**Step 1 — pool state** (v1.187.19: on the packs' measured energy, §1.3a).
```
basis              = runwayEnergyBasis(devices, shp2, now)   # same snapshot, no await between
backupRemainingKwh = backupRemainWh  · basis.capacityScale / 1000
backupFullKwh      = backupFullCapWh · basis.capacityScale / 1000
reservePct         = getOwnerReserveFloorPct() ?? backupReserveSoc ?? 15   # v1.115.0 — the owner's floor, not the night-charge hold
backupReserveKwh   = backupFullKwh * reservePct / 100
```
If the SHP2 or either capacity field is missing → early return `emptyRunway(..., 'SHP2 backup-pool capacity not yet reported')` (all hours null, `unavailable` set).

**Step 2 — recent load anchor.** Average `panel_load` over the last hour. If fewer than 2 recorded samples exist (sparse post-restart window), fall back in order to:
1. Live SHP2 panel load = Σ circuit watts (available from MQTT immediately),
2. a single recent recorded sample,
3. the last good `runwayCache.value.recentLoadWatts`, but only while the last real panel reading (a recorded `panel_load` row or a live channel sum) is within `RUNWAY_LOAD_CARRY_MAX_MS` = 2 h (v1.175.0). The projection's `recentLoadBasis` names the source used (`hour-mean` | `live` | `single-sample` | `carried`),
else early-return `emptyRunway(..., 'panel-load history insufficient — wait a few minutes')`. This keeps the sensor numeric instead of flapping to HA `unknown`/`unavailable` on an islanded home.

**Step 3 — build the per-hour PV and load arrays** (24 entries each). PV = `forecastPvW/1000`. Load = `max(0, forecastLoadW − predictedEvLoadW)/1000`, falling back to the trailing average when a forecast hour carries no modelled load. Arrays are padded to 24 h (PV→0, load→trailing average).

**Step 4 — degenerate-curve guard.** If the mean modelled load `curveMeanKw < LOAD_CURVE_MIN_PLAUSIBLE_KW` (0.05 kW = 50 W), the whole curve is data failure (a post-boot worker built the forecast from zero `panel_load` rows). Set `loadModelDegraded = true` and fill the entire horizon with the observed load average. No real occupied home averages < 50 W.

**Step 5 — observed-load anchor blend** (near-term hours). For the first `RUNWAY_BLEND_HOURS` = 4 hours:
```
w = 1 − h/4               // 1, .75, .5, .25
loadByHour[h] = max(loadByHour[h], loadAvgKw*w + loadByHour[h]*(1−w))
```
The `max()` means a lighter-than-modelled day never becomes *more* optimistic, and a transient burst decays out by hour 4 so it cannot dominate the far horizon. This closed a live failure where the day-of-week curve ignored a *sustained* real 5–9 kW draw against a ~3 kW modelled hour and a recompute muted the alarm.

**Step 6 — the DC-bus depletion loop** (the core math). For each hour h ∈ [0,24):
```
delta   = pvKwh − runwayDrainW(loadKwhPerHour·1000, basis.overheadW) / 1000
        # runwayDrainW(load, ovh) = max(load/η, ovh + load/η_m)   (v1.187.19; was load/η)
nextState = stateKwh + delta
```
This is the **v1.26.0 DC-bus pool-drain accounting**: PV enters the DC bus at ~unity (MPPT); the AC home load is pulled through the inverter at `1/η_dis`; so the pool changes by `pv − load/η` per hour. It is deliberately **not** `(pv−load)/η` — that would wrongly divide the PV credit by η and stay optimistic whenever pv>0 (e.g. `pv==load` must still drain at `load·(1−1/η)`).

Crossings are captured with linear interpolation within the crossing hour:
```
if hoursToReserve==null and stateKwh > reserve and nextState <= reserve:
    frac = delta<0 ? (stateKwh − reserve)/(−delta) : 1
    hoursToReserve = h + clamp(frac, 0, 1)

if hoursToEmpty==null and stateKwh > 0 and nextState <= 0:
    frac = delta<0 ? stateKwh/(−delta) : 1
    hoursToEmpty = h + clamp(frac, 0, 1)

stateKwh = min(backupFullKwh, max(0, nextState))   # v1.32.0 — capped at capacity; the cap can only shorten runway
```
`totalForecastPv` and `totalLoad` accumulate the **raw** (reporting-basis) PV/load, so the reported `forecastPvUsedKwh` / `loadHorizonKwh` stay on the reporting basis even though the drain uses the η-corrected delta.

**Step 7 — empty hysteresis** (see §1.6). `pubHoursToEmpty = basisPending ? hoursToEmpty : applyEmptyHysteresis(hoursToEmpty, runwayEmptyState)`. A compute made while a home Core's first reading is pending (`homeBasisPending`, v1.187.10) neither reads nor arms the latch, is not cached, and is marked `basisPending: true`. Its figures still reach the alarm, but the publishers withhold them (§1.8).

**Step 8 — ordering repair (v1.129.0, `coherentRunwayPair`).** Above the floor the pool drains through the reserve on its way to empty, so a published `hoursToEmpty` earlier than `hoursToReserve` is impossible. In that case the reserve crossing is pulled back to the empty crossing (the repair only ever shortens) and the projection carries `runwayPairClamped: true`. At or below the floor the pair is left as computed.

#### 1.3a The measured energy basis (v1.187.19)

**Why.** The panel's pool percent (`backupBatPercent`, each source's `batteryPercentage`) is a
fraction of the packs' BMS full-charge capacity (Σ `fullCapMah`), but the panel converts it to
energy against nameplate (`backupRemainWh = pct × backupFullCapWh`, 30,720 Wh per Core). Every
kWh the runway counted was therefore high by the packs' capacity ratio (0.944 on 2026-10-01).
And the drain `load/η` omitted the Cores' own consumption, which never appears in
`panel_load`. Replayed against 30 clean pack-only discharge spans (2026-09-02..10-11; loads
2.1–7.7 kW; capacity ratios 0.981, 0.970, 0.959, 0.944) the old runway overstated the hours in
every span, by +7.0 % to +18.7 % (worst at low load); the measured basis below predicts all 30
within −2.6 % to +1.5 % (`docs/PERFORMANCE.md` §4a, `test/runwayReplayBacktest.test.ts`).

**Capacity scale** (`poolEnergyBasis.ts`). Over the Cores the panel lists as connected sources
(`sources[].isConnected` — not the online DPUs, not a spare list: a bench Core's fresher packs
must not lend the pool capacity), each Core's ratio is Σ `fullCapMah` / Σ `designCapMah` over its
packs; the scale is their capacity-weighted (`sources[].fullCap`) mean, which with every Core
reporting equals Σ `fullCapMah` × 102.4 V ÷ `backupFullCapWh`. Clamped `[0.80, 1.00]` — never
above nameplate. A pack with `fullCapMah` null, ≤ 0 or above 1.1 × its design, a pack count that
disagrees with the Core's `packCount`, or a Core that is offline or has not reported, makes that
Core incomplete: it uses its last complete ratio (persisted, `POOL_ENERGY_BASIS_DIR`, valid 30
days), else the lowest ratio known for any Core; plain nameplate (1.0) only when no ratio has ever
been measured. A lower scale applies at once; a higher one only after it has held 24 h (the
lowest figure seen during the hold is applied). Only a complete measurement (every connected Core
reporting) moves the applied scale or its hold: a figure built on substitutes is answered as
`min(applied, figure)` and not recorded, so a partial boot map neither lengthens the runway nor
plants a low figure that the first full map must wait 24 h out. The worker's basis reset
(`resetWorkerReportCaches`) leaves this state alone: it is persisted measurement, not a report
result. `capacityBasis` names the worst input used:
`measured` | `held` | `min-known` | `nameplate`. The analytics worker's tracker is the only one
the house runway and the forecasts read; a secondary panel's drain runway (`panelRunway.ts`,
main thread) has its own tracker and file and applies the scale only — its drain is measured at
the packs and already contains the Cores' overhead.

**Drain.** `runwayDrainW(load, overheadW) = max(load/η, overheadW + load/η_m)`, with
`overheadW = max(RUNWAY_POOL_OVERHEAD_FLOOR_W (270 W) while the panel reports a pool,
RUNWAY_CORE_OVERHEAD_W (90 W) × connected Cores)` and `η_m = RUNWAY_DRAIN_MARGINAL_EFFICIENCY`
(0.94). Fitted on the same 30 spans: on the measured capacity the pool's DC drain is ≈ 267 W +
load/0.94 (residual sd 40 W; a two-term fit, 245 W + 1.070 × load, is indistinguishable over
2–8 kW). Every one of those spans had the same three Cores connected, so the fit is a POOL figure
and cannot say how it splits. Each Core's own stream can: `Σ pack_out − ac_out/0.94` over the same
spans is 17–75 W on SHP2 slot 1, 21–82 W on slot 2 and 128–200 W on slot 3 (means 41 / 52 /
175 W, summing to 269 W). The overhead is therefore not even per Core, and the 270 W is a FLOOR
while the pool is reported: a Core leaving the panel, or a partial reading that lists no
connected source, keeps it (conservative by up to ~230 W when only a slot-1/2 Core remains), and
90 W × Cores only raises it for a pool of more than three. The overhead is a constant, not a live
measurement: the panel-side figure (pack drain − `panel_load`) mixes the Cores' 10 s stream with
the panel's 60 s frame, and the single-stream per-Core figure works only while islanded —
grid-tied, `ac_out` reads 0 because the Cores feed the house through the panel link. It applies
in every hour —
in PV-surplus hours of the same history the pool charged 8–19 % less than `pv − load/η` predicts
on the measured capacity (2–7 % less with the overhead), so the overhead is present by day too
and the charge leg remains a little optimistic. The `max()` holds the drain at or above the
pre-v1.187.19 `load/η` for any configuration, so with the scale ≤ 1 the runway can only shorten
(`poolEnergyBasis.test.ts` checks 400 random pools, loads and PV curves; a pool already below
its floor is the floor alarm's, not the hours'). ∂delta/∂pv is still 1, so the
`runwayPvBasisGuard` monotonicity holds.

**Published.** `RunwayProjection.capacityScale`, `capacityBasis`, `overheadW` (also on
`/api/runway`); `backupRemainingKwh` / `backupFullKwh` / `backupReserveKwh` / `troughKwh` /
`endKwh` are on the measured basis. The HA sensors `backup_full_capacity_kwh` /
`backup_remaining_kwh` / `backup_pool_percent` keep the panel's own figures; the runway hours and
`projected_low_soc_percent` carry the corrected values.

**Not changed (the change is scoped to the runway and its alarms).** The night-charge planner, its cushion,
the JIT force-charge, the MPC/dispatch recommendations and `RUNWAY_DISCHARGE_EFFICIENCY` itself.
The planner reads only the forecast's per-hour PV/load and the band's PV percentiles, which do not
depend on the basis; `runwayBasisContracts.test.ts` builds every report on the old and the new
basis and requires the planner's inputs and its plan to be identical.

#### 1.4 Key constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `RUNWAY_HORIZON_HOURS` | 24 | Projection horizon |
| `RUNWAY_LOAD_WINDOW_MS` | 60 min | Recent-load averaging window |
| `RUNWAY_TTL_MS` | 60 s | Recompute throttle |
| `RUNWAY_BLEND_HOURS` | 4 | Observed-load anchor decay length |
| `LOAD_CURVE_MIN_PLAUSIBLE_KW` | 0.05 kW | Degenerate-curve threshold |
| `RUNWAY_DISCHARGE_EFFICIENCY` | 0.94 (default) | DC→AC discharge efficiency η; `min(1, max(0.8, env ?? 0.94))`, env `RUNWAY_DISCHARGE_EFFICIENCY` |
| `RUNWAY_POOL_OVERHEAD_FLOOR_W` | 270 (default, clamp 0–1500) | v1.187.19 — the pool overhead's floor while the panel reports a pool (§1.3a) |
| `RUNWAY_CORE_OVERHEAD_W` | 90 (default, clamp 0–500) | v1.187.19 — the overhead is `max(floor, this × connected Cores)` (§1.3a) |
| `RUNWAY_DRAIN_MARGINAL_EFFICIENCY` | 0.94 (default, clamp 0.80–1.0) | v1.187.19 — η_m in `overheadW + load/η_m` |
| `CAPACITY_SCALE_MIN` / `CAPACITY_SCALE_MAX` | 0.80 / 1.00 | v1.187.19 — the capacity-scale clamp |
| `CAPACITY_INCREASE_HOLD_MS` / `HELD_RATIO_MAX_AGE_MS` | 24 h / 30 d | v1.187.19 — increase hold; validity of a held per-Core ratio |
| `RUNWAY_EMPTY_CLEAR_SAMPLES` | 3 (default) | Empty-hysteresis latch length; env `RUNWAY_EMPTY_CLEAR_SAMPLES` |
| `RUNWAY_NO_DEPLETION_SENTINEL_H` | 999 | Healthy-but-no-depletion publish sentinel |

`RUNWAY_DISCHARGE_EFFICIENCY` default 0.94 is marginally conservative vs. the measured ~0.945 pack-terminal→AC discharge-conversion leg (6.22 kW drawn for 5.88 kW delivered). That figure only numerically coincided with a 7-day pack-plane RTE reading, which is a different quantity (v1.32.0). It is clamped to `[0.80, 1.0]` so a bad env can never lengthen runway beyond the true (unity) reading or collapse it to an untrusted extreme. Because η divides the load term in every hour (surplus hours included), `delta ≤` the pre-v1.26 unity delta for all pv,load, **runway can only ever shorten-or-equal** — preserving the `runwayPvBasisGuard` "monotonic in forecastPvW" invariant.

#### 1.5 The PV-basis and predicted-EV safety invariants

Two deliberate exclusions keep the alarm evidence-based and never optimistic:

- **Reporting-only PV (v0.78.0 invariant).** `pvByHour` reads *exclusively* `forecast.hours[h].forecastPvW`, built from the reporting-only `solarModel`. The higher *display* basis (`forecastPvWhNext24Display`, `typicalPvWhPerDayDisplay`, `restoredSolarModel`) exists **solely** for the display tiles and must never be read here — a higher PV input lengthens runway and would under-alarm during a wedge.
- **Predicted-EV stripped (v0.15.21).** The forecast folds speculative EV sessions into `forecastLoadW` (right for planning), but the sim subtracts `predictedEvLoadW` so it never treats "the car usually charges tonight" as certain load — that roughly doubled the modelled draw on nights the EV never plugged in and produced a false red voice alarm. If the car *is* charging, the observed-load anchor (Step 5) carries the real draw and the 60 s recompute keeps it current.

#### 1.6 Empty hysteresis — `applyEmptyHysteresis`

Asymmetric latch on the `hoursToEmpty → 999 sentinel` transition **only**. A finite empty crossing sits at the far edge of the 24 h horizon, so minute-to-minute jitter tips it across the boundary ~30×/window, churning the recorder and history UI.

```
applyEmptyHysteresis(hoursToEmpty, state, clearSamples=3):
  if hoursToEmpty != null:            # real depletion → publish immediately, arm latch
      state.streak = 0; state.lastFinite = hoursToEmpty; return hoursToEmpty
  if state.lastFinite != null:        # optimistic finite→none direction
      if ++state.streak < clearSamples: return state.lastFinite   # hold
      state.lastFinite = null          # streak satisfied → release to sentinel
  return null
```
It **only damps the optimistic direction** (finite→none): a real depletion (none→finite) publishes immediately and is never delayed. A briefly-held stale finite is *pessimistic* (over-warns), never optimistic.

#### 1.7 Degenerate / honest-null behavior

| Condition | Output |
| --- | --- |
| SHP2 or capacity missing | `emptyRunway`, `unavailable='SHP2 backup-pool capacity not yet reported'`, all hours null |
| < 2 load samples and no live fallback | `emptyRunway`, `unavailable='panel-load history insufficient — wait a few minutes'` |
| Degenerate load curve (< 50 W mean) | Runs whole horizon on observed load; `loadModelDegraded=true` |
| Healthy, no depletion projected | `hoursToReserve`/`hoursToEmpty` = `null`; published via `runwayHoursForPublish` as **999** so HA can distinguish "plenty of runway" from data-loss `unknown` |
| Genuinely unavailable | Hours = `null` (HA shows `unknown`) |

`runwayHoursForPublish(hours, unavailable)`: returns `hours` if finite; else `999` when `unavailable==null` (healthy no-depletion), else `null` (real outage → HA `unknown`).

#### 1.8 Outputs + endpoint

`RunwayProjection` shape (analytics.ts). Besides the fields below, it carries `recentLoadBasis` (see Step 2), `troughKwh` / `troughAtMs` / `endKwh` (the islanded trajectory's minimum and end; reporting only, v1.177.0), `runwayPairClamped?` (Step 8, v1.129.0), `basisPending?` (Step 7, v1.187.10) and `capacityScale` / `capacityBasis` / `overheadW` (v1.187.19, §1.3a — null when the SHP2 or its capacity is not reported; the kWh fields are on the measured basis):
```
{
  generatedAt, backupRemainingKwh, backupReserveKwh, backupFullKwh,
  recentLoadWatts, hoursToReserve, hoursToEmpty, reserveAtMs, emptyAtMs,
  forecastPvUsedKwh, loadHorizonKwh, horizonHours, unavailable, loadModelDegraded
}
```

| Sink | Where |
| --- | --- |
| REST | `GET /api/runway` → `analytics.report('runway')`, with two fields attached at the route: `belowReserveFloor` (null when undeterminable) and the live `grid` backstop (`liveGridBackstop`). 30 s HTTP cache (index.ts) |
| MQTT | `runway_to_reserve_hours` / `runway_to_empty_hours` in `/api/ha-state` (index.ts) and the MQTT state payload (`buildState`, mqttDiscovery.ts), via `runwayHoursForPublish`. Both are null when no runway report was served that cycle (v1.186.0), and are withheld (null) while the projection is `basisPending` (`publishReadiness` `runwayBasis`, v1.187.10, which also governs `runway_recent_load_watts` and `runway_forecast_pv_used_kwh`) |
| HA sensors | `sensor.ecoflow_runway_to_reserve` (`ecoflow_runway_to_reserve_hours`, unit h, mdi:timer-sand); `sensor.ecoflow_runway_to_empty` (`ecoflow_runway_to_empty_hours`, unit h, mdi:timer-off) |
| Audible alarm | Consumed by `runwayAlarm.update` on a 2-min tick (§2) |
| Load-shed advisor | Consumed by `loadShedAdvisor.update` (§5) |

---

### 2. The runway audible alarm — `classifyRunway` + grid-aware severity

#### 2.1 What it does

`runwayAlarm.ts` maps a `RunwayProjection` to an ISA `AlarmPriority` (low/medium/high/critical) and drives a **dedicated audible path** (`broadcast.announce` directly), not the alert→condition→broadcast pipeline — so it still annunciates when the operator's broadcast min-severity is `critical`. The matching on-screen alert is `forecast-runtime-*` (analytics.ts §4), which is excluded from the broadcast condition so the two never double-chime.

#### 2.2 The severity ladder — `classifyRunway(p, grid?)`

Two special cases first, then the standard ladder:

**At/below the reserve floor** (`belowReserveFloor`: `backupRemainingKwh <= backupReserveKwh`, both non-null, reserve > 0):
- grid **backstopping** → `low` (advisory: pool transferred to mains, non-event)
- otherwise → `critical` (the genuine "no backstop at the floor" emergency — the SHP2 cuts non-backup circuits here)

This fixed a real regression where the old ranking *de-escalated* to `high` once the floor crossing was behind us ("high — reserve in 18.8 h" while pinned at the floor).

**Not yet at the floor:**
- grid **backstopping** → `null` (silent audible; the grid will carry the load once the pool reaches the floor — the on-screen "approaching reserve" alert still shows).
- otherwise, the standard escalation-by-urgency ladder:

| Condition | Priority |
| --- | --- |
| `hoursToEmpty ≤ 3` | **critical** |
| `hoursToEmpty ≤ 8` | **high** |
| `hoursToReserve ≤ 6` | **medium** |
| `hoursToReserve` finite (any) | **low** |
| else / `unavailable != null` | `null` |

EMPTY escalates harder than RESERVE because empty is the harder failure. `unavailable != null` always returns `null` (no alarm on a data outage).

#### 2.3 Grid presence — how it re-escalates islanded vs grid-backed

The `grid?: GridContext` argument (`{present, backstopping}`) is resolved live by `livePoolGridBackstop(devices, houseSnOf(devices))` (§4) and passed in on every tick. That is the house pool's own verdict on a multi-panel plant, and identical to `liveGridBackstop(devices)` with one panel. **Omitted ⇒ treated as off-grid** (the safe default: floor stays critical). The distinction that matters is `backstopping` (grid actively carrying the load *now*), not merely `present` — a grid *declared* present but not carrying (pool still net-discharging) keeps the full ladder so a genuine fast depletion still annunciates.

#### 2.4 The alarm state machine — `createRunwayAlarm`

`update(p, grid)` computes `desired = classifyRunway(p, grid)` and:

- **`desired == null`** (recovered/unavailable) → re-arm so the next descent announces fresh, **but not during warm-up**: for the first `REARM_WARMUP_MS` = 10 min after process start, a null projection must NOT re-arm (post-boot projections are computed from half-warm inputs and had been silently clearing active alarms).
- **entering / escalated / stale** → announce. `entering` = no prior priority; `escalated` = `RANK[desired] > RANK[announced]`; `stale` = `now − lastAnnouncedAt ≥ reannounceMs`. Re-announce cadence `RUNWAY_ALARM_REANNOUNCE_MS` = `max(1, BATTERY_RUNWAY_ALARM_REANNOUNCE_MIN ?? 60) × 60 s` (default 60 min).
- **de-escalation** (`RANK[desired] < RANK[announced]`) is held: a calmer tier must persist `ALARM_DEESCALATE_HOLD_MS` = 10 min before the latch steps down. This stopped a projection hovering at the critical↔high boundary (`hoursToEmpty` oscillating around 3.0 h while the EV charged) from re-announcing the *same* critical message on every re-cross (household heard it 4+ times in under an hour). Escalations are always immediate.

State (`{announcedPriority, lastAnnouncedAt, calmerSinceMs}`) is persisted atomically to `runway-alarm.json` (env `BATTERY_RUNWAY_ALARM_PATH`) so a restart mid-event doesn't re-announce. The clock uses the projection's own `generatedAt`, making it deterministic under test.

#### 2.5 Spoken messages

`runwayAlarmMessage(p, priority, grid)` produces context-appropriate speech (English + a Spanish second pass via `runwayAlarmMessageEs`):
- floor + grid backstopping → *"Advisory. Backup pool reached the reserve floor. The grid is available as backup; no action needed."* — or *"…Now drawing from grid power; no action needed."* only while measured grid import flows (`GridContext.importLive`, v1.186.3)
- critical + at floor → *"Critical alarm. Critical alarm. Backup pool is at the reserve floor. Non-backup circuits may lose power. Shed load or start the generator."*
- critical + `hoursToEmpty` → *"…projected empty in about N hours before solar recovers. Shed load immediately."*
- high + `hoursToEmpty` → *"…projected to deplete in about N hours… Reduce load now."*
- else → *"…projected to reach reserve in about N hours at the forecast load. Reduce consumption…"* (severity prefix leads).

#### 2.6 Reaching the audible path (index.ts)

A 2-min `setInterval` (index.ts) runs these steps in order:
1. Refresh the HA state cache (TTL-gated) when a grid-presence or host-power entity is configured.
2. In its own try block, update every secondary panel's drain-measured runway alarm (`panelRunway.ts`, v1.185.0, "at the current drain").
3. `r = analytics.report('runway')`.
4. `runwayGridForTick = livePoolGridBackstop(store.get().devices, houseSnOf(store.get().devices))` (assigned synchronously *before* update so `onTrigger` reads the same grid state the classifier saw).
5. `runwayAlarm.update(r, runwayGridForTick)`.

`onTrigger(priority, message, messageEs)`:
1. `if (!isPriorityEnabled(priority)) return;` — honours the per-priority Alert-Settings annunciation toggles.
2. **`if (shouldGateRunwayAudible(runwayGridForTick)) return;`** — `shouldGateRunwayAudible` returns `grid.backstopping === true`. This is a belt-and-braces **audible-only** mute while the grid actively backstops (in case a transient `backstopping=false` let the classifier reach critical). Push + on-screen are untouched; off-grid → no-op.
3. `broadcast.announce(priority, message, messageEs)`.

Enabled unless `BATTERY_RUNWAY_ALARM_ENABLED=false`.

---

### 3. The battery-SoC floor alarm — `batterySocAlarm.ts`

#### 3.1 What it does

Fires an escalating audible announcement when the SHP2 backup-pool SoC crosses **down** through a threshold, with priority rising as the reserve gets lower. Like the runway alarm it is a **dedicated audible path** (`broadcast.announce` directly), because the normal pipeline only chimes for warning/critical and the user wants the 40 %/30 % (low-priority) crossings audible too. The matching on-screen alert is emitted by `alerts.ts` (and excluded from the broadcast condition so it never double-chimes).

The ladders and the store tick that feeds them live in `server/src/socLadders.ts` (`startSocLadders`, v1.187.22; index.ts before, which now only starts it): the house ladder with its grid-downgrade record (§4.5), one ladder per secondary panel, and the grid-drop re-escalation pass.

#### 3.2 The SoC ladder — `BATTERY_SOC_THRESHOLDS`

| SoC % | Priority |
| --- | --- |
| 50 | low |
| 40 | low |
| 30 | low |
| 20 | medium |
| 15 | medium |
| 10 | **critical** |
| 8 | **critical** |
| 4 | **critical** |
| 2 | **critical** |

10 % and 8 % are **critical, not high** (audit #24): `alerts.ts`'s `shp2-below-reserve` classifier treats any SoC under the default `backupReserveSoc ?? 15` floor as critical while off-grid, and 10 %/8 % sit below 15 %. A `high` here would have let a user who muted only "High" go silent on a genuinely reserve-floor-critical SoC. Reconciled upward only. (Note: `backupReserveSoc` is user-configurable; a reserve set far from the 15 % default can still let this fixed ladder diverge from the floor classifier at other pcts — this targets the concrete default-config off-grid disagreement.)

#### 3.3 Crossing detection, arming & hysteresis

`update(socPct, nowMs)`:
1. **Null/non-finite SoC → no-op** (return).
2. **Coherence / slew guard** (see §3.4).
3. **First real reading with no persisted state** → arm only thresholds the battery is currently *above* (so a boot at 18 % doesn't re-announce 40/30/20), set baseline, persist, return.
4. **Gather all newly-crossed armed thresholds this tick.** A band is crossed when `armed && soc <= t.pct` (then disarmed). A band **re-arms** when `!armed && soc >= t.pct + REARM_MARGIN_PCT` (`REARM_MARGIN_PCT` = 2). The 2-point margin stops a value sitting exactly on a boundary from chattering.
5. **Announce ONCE for the most-severe band crossed** (v0.75.0). Since thresholds descend by pct, the last crossed entry is the lowest pct = highest priority. `onCross(t, isPrimary)` still fires for **every** crossed band (so per-band bookkeeping stays complete) with `isPrimary=true` only on the worst; the consumer announces only when `isPrimary`. This collapses a same-tick multi-band crossing (a long-offline source returning at low SoC, or a fast discharge spanning bands in one ~60 s poll) to a single audible. A normal gradual discharge (one band per tick) is unchanged, and **the most-severe crossed band is always announced** — nothing real is suppressed.

#### 3.4 Coherence guard vs. transient zero (v0.54.4)

The physical-plausibility guard prevents the SHP2's `backupIncreInfo` briefly reading 0 on an EcoFlow-cloud reconnect from laddering the whole 50→2 % cascade (as it did on 2026-06-21 18:12). A single-tick drop is ignored (not fired, and the baseline is **not** advanced, so it self-heals the instant a real read returns) when **all** of:
```
initialized && lastSoc != null && lastSocAtMs != null
&& nowMs − lastSocAtMs <= SLEW_BASELINE_MAX_AGE_MS   (10 min)
&& lastSoc >= HEALTHY_BASELINE_PCT                    (30 %)
&& lastSoc − soc > MAX_PLAUSIBLE_DROP_PCT             (25, env BATTERY_SOC_MAX_DROP_PCT)
```
The guard **only** fires from a *fresh, healthy* baseline: a real deep discharge reaches 0 from an already-low (< 30 %) baseline where the guard is inactive and the critical bands must still fire; and a real discharge is gradual (each tick well under the cap). The `SLEW_BASELINE_MAX_AGE_MS` bound means that after a long gap (restart / hours cloud-offline) the stale baseline is not trusted — the first fresh read re-baselines instead of being wrongly rejected. This is the depth backstop for the rare perfectly-coherent zero the source coherence gate (`ecoflow/project.ts coherentBackupPool`) can't distinguish from a real empty pool.

#### 3.5 State persistence

`{armed: Record<pct,bool>, lastSoc, lastSocAtMs}` persisted atomically to `battery-soc-alarm.json` (env `BATTERY_SOC_ALARM_PATH`). Persisted on any crossing/re-arm, or on the `BASELINE_PERSIST_THROTTLE_MS` = 5 min throttle so the on-disk baseline stays fresher than `SLEW_BASELINE_MAX_AGE_MS`, keeping the slew guard active across a quick restart (SHP2 reconnects often coincide with add-on restart boundaries).

#### 3.6 On-screen banding helpers (pure, consumed by alerts.ts)

- `activeSocBand(socPct)` — highest-pct threshold at/below the SoC (the single on-screen "backup low" band).
- `activeSocBandWithHysteresis(socPct, prevBandPct)` (v1.17.0/F15) — adds the ladder's 2 % re-arm margin to the on-screen band. A deeper crossing takes effect immediately; the held band clears/ascends only once SoC climbs *above* `band + 2`. Pure banding had 399 on-screen rises in 30 days vs ~115 real crossings (3.5× churn) polluting cleared-history and the auto-silencer's training data.
- `socAlertSeverity(priority)` — stamps `{severity, source:'threshold', priority}` so the web/TUI `priorityOf()` derives the same ISA tier as the audible. Always `source:'threshold'` (a real measurement, not a learned forecast); Medium is carried by an explicit `priority` field rather than faking `source:'learned'`.

#### 3.7 SHP2-blind failover (`socLadders.ts`, v1.8.0/F3)

The ladder reads only the SHP2 backup-pool %, which nulls when the SHP2 goes cloud-offline; the 30-day review found blackouts (42.2 h, 25.8 h) in which the pool crossed 50/40/30/20 % while the ladder sat dark for 17.8–20.8 h. When `backupBatPercent` is null, the ladder tick (`socLadders.ts`) falls back to `housePoolFallbackSoc(devices, lastKnownRoster)` (the pool *is* those batteries). With one panel that is `homeFleetMeanSoc`, whose membership comes from the live roster, then the persisted last-known roster, then the `SPARE_DPU_SNS` literal (v1.117.0). On a two-panel plant it is the house panel's own Cores only (v1.185.0). It returns null only when no Core is reporting, where `update(null)` is a safe no-op and the reserve-blind warning + offline alerts are the signal.

**v1.92.0 — pool membership is resolved from the SHP2's own connected-source roster, not from the static `SPARE_DPU_SNS` literal.** `isHomePoolDpu(sn, connectedOrDevices)` returns `connected.has(sn)` when the roster is known and falls back to `!SPARE_DPU_SNS.has(sn)` only when it is empty (the panel itself cloud-dark), which errs toward *including* a device. Motivating incident: a physical reconfiguration moved an allowlisted bench unit onto a panel slot and a home Core off it, inverting the literal. The allowlist-only filter then averaged the bench unit and dropped a live pool member — and because a bench unit charges independently, the reported mean acquired a hard floor of `benchSoc / 3`. Measured with the bench unit at 63 %, the fallback could not read below 21 %, so the 15/10/8/4/2 % rungs — the entire critical half of the ladder — were unreachable during exactly the SHP2-blind window the fallback exists to cover. Guards are mutation-proven load-bearing (`scripts/mutate-pool-membership.mjs`, 6/6), including an exemplar that reproduces the shipped defect verbatim. The same resolver now gates the reconnect auto-audit's device set (§12e), which previously exempted a live home Core while watching a bench unit.

#### 3.8 Boot gate (`socLadders.ts`, v1.187.22)

Until the store is hydrated (`SnapshotStore.firstPollSettledAt`: the first poll has asked every listed-online device for its quota), a tick reads a partial device map: the device list has landed, but only the devices that already answered carry a projection. After a host reboot on 2026-10-12 the first tick carried no panel pool % and only one of the three roster Cores; the fallback mean (§3.7) read 49 % against a real 52 %, the armed 50 % rung was spoken, and the real crossing was spoken again twenty minutes later. The ladders are a dedicated audible path (`broadcast.announce`), outside the broadcast's boot holds, so they now gate themselves: the house ladder, every other panel's ladder and the grid-drop re-escalation (§4.5) are fed only once the first poll has settled (`socLadderBootGate`; the gate latches open), bounded by `BOOT_HYDRATION_MAX_MS` from start — the alert monitor's bound, default 30 s (`ALERT_BOOT_HYDRATION_MAX_MS`; `0` disables the wait). Past the bound the ladders are fed the data that exists, exactly as before, so a cloud outage at boot never holds a real alarm for good. The `hydrated` event and the bound each run a tick, so the first hydrated value is evaluated at once, not on the next change; the live roster is still noted on a withheld tick. One log line when the gate first withholds a tick (`soc-ladder: withholding the SoC ladders until the first poll settles …`, with what the house pool, or its fallback, reads), and one when it opens (`soc-ladder: the first poll settled <n> ms after start …`, or a WARNING when the bound opened it: `no complete poll within <n> s of start …`).

---

### 4. Grid backstop resolver — `gridState.ts`

#### 4.1 What it does + why

The resolver was built (v0.23.0) on the premise that the SHP2 cloud telemetry exposes no grid-presence field, leaving grid *import* watts — zero whenever PV/battery covers the load even when the mains are live — and an operator-provided HA entity, corroborated by live import. v0.89.0 found the panel's own flag (`pd303_mc.masterIncreInfo.gridSta`, value-1-only): additive when it reads Grid OK, and since v1.178.0 a veto on a declared grid when it does not (4.2). `resolveGridBackstop` answers one question for the floor/runway/SoC alarms: **is the grid backstopping the home right now**, such that the pool reaching its reserve floor merely transfers to mains (non-event) rather than risking a local outage (emergency)?

#### 4.2 Signals combined (`resolveGridBackstop`)

| Signal | Function | Threshold |
| --- | --- | --- |
| DPU AC-in import | `computeGridImportWatts` | `GRID_IMPORT_WATTS` = 5 W; scoped **strictly** to SHP2 source SNs; **0 if source identity unknown** (a wall-charging spare must not masquerade as house grid); only Cores whose content-change clock (`contentChangedAtMs`, v1.181.0; `lastTelemetryAtMs` in v1.179.0) is within `SHP2_READBACK_STALE_MS`. The sources of any panel freshly reporting no grid are dropped (v1.181.0, applied per panel since v1.185.0) |
| SHP2 main-line grid | `computeHomeGridWatts` (`wattInfo.gridWatt`) | `HOME_GRID_IMPORT_WATTS` = 25 W; **0 unless a fresh readback** (`shp2ReadbackFresh`, v1.179.0; offline/shadowed only before — a frozen sample must not fabricate presence) |
| SHP2 own grid flag | `computeShp2GridConnected` (`pd303_mc.masterIncreInfo.gridSta`, value-1-only) | true=Grid OK / false=islanded / null=unknown; **null unless a fresh readback** (`shp2ReadbackFresh`: online, a REST quota within `SHP2_READBACK_STALE_MS` = 5 min, not shadowed — v1.179.0; online-and-unshadowed only before); burst-gap immune |
| HA entity | `interpretGridEntity(GRID_PRESENCE_ENTITY)` | on/true/home/…→present; numeric voltage >50→present; unavailable/unknown→null |
| Standing declaration | `GRID_AVAILABLE=true` | Coarse fallback when no entity configured |

Derived flags:
```
importLive = importWatts ≥ 5 OR homeGridWatts ≥ 25          # positive, unambiguous
declaredRaw = entity configured ? (entityPresent === true) : gridAvailableFallback
declared    = declaredRaw AND NOT gridMeasuredAbsent   # v1.178.0 veto: ANY panel's LAST not-OK reading (panelVetoes; v1.185.0 all panels by identity; a reading at or before a v1.184.0 operator clear does not count), or the persisted reading when no panel device exists (v1.180.0)
present     = importLive OR declared OR shp2GridConnected===true
```

**Measured-absent veto (v1.178.0).** A declaration is an operator's statement; a panel
reading other than "Grid OK" (value-1-only: `gridSta` 0 = grid not detected, 2 = out of spec,
the panel islands onto the batteries; an undocumented code is not "Grid OK" either) is a
measurement, and it now outranks the declaration everywhere, not only at the reserve floor. Before, a toggle left ON through a surprise outage kept the
resolver `backstopping` until the pool neared the floor: the runway audible was gated silent,
`runway_projection_islanded_only` read ON and `off_grid` OFF — the hours of warning in which
to shed load or start a generator were lost.

The veto reads the panel's **last** reading (`projection.gridConnected`, falling back to
`lastGridReading` — the last REST reply that carried `gridSta` — when the latest reply omitted
the `pd303_mc` subtree), not the online-gated `shp2GridConnected`, and clears on evidence,
never on silence: only a newer reading of Grid OK. Measured flow (`importLive`) proves the grid
regardless of `gridSta` while it flows, but does not clear the veto. Offline, cloud-shadowed
(`contentStaleSinceMs`), unrefreshed and just-reconnected panels, and replies without
`gridSta`, all keep vetoing on the last not-OK reading — across an add-on restart too
(v1.180.0, "Surviving a restart" below). Every way of lifting the veto on silence that was
tried republished "grid present" in the middle of an outage: a cloud-replay shadow latch (2–4
a day on this plant, up to 16 min), a cloud-offline panel (an outage that also takes the ISP
down), a wall-clock age on an unrefreshed reading, and a 6 s `/status` blip. Each one dropped
`off_grid`, dropped `load_shed_recommended` (so automations could restore shed loads) and
re-gated the runway audible. The cost of stickiness is a stale "no grid" if the grid returns
while the panel is dark: an early alarm, the accepted direction. A field the panel never
reported (no reply ever carried `gridSta`) vetoes nothing. The presence term is the opposite: a stale "1"
asserts nothing (see Presence freshness, below). The resolver's reason names the code the panel reported and says when
it is a last reading — panel offline, data replayed, or the latest reply without `gridSta` ("grid
declared present but the SHP2 reports grid not detected (gridSta=0) (last reading; panel
offline) — not backstopping").

**Presence freshness (v1.179.0).** `computeShp2GridConnected` returned the panel's flag
whenever the panel was online and not shadowed, with no look at the reading's age, so a stale
"Grid OK" asserted presence — the missed-alarm direction — on two paths: an OFFLINE→ONLINE
`/status` flip re-exposes the pre-offline sample before any quota lands (`setDeviceOnline`
never touches the projection or `lastQuotaAtMs`), and a quota fetch that keeps failing with
the panel still listed online left it standing indefinitely. Either made `present` and
`gridStaBackstop` true with no grid: the runway audible gated, SoC crossings spoken as
"drawing from grid power", `off_grid` OFF, `shp2_grid_connected` ON. The flag now needs
`shp2ReadbackFresh` — the same shared gate (and window) the night-charge readbacks use.
The measured-flow terms had the same hole and a stronger effect, since `importLive` is exempt
from both floor guards: a `gridWatt` frozen mid-charge (7–8 kW at the floor) muted an at-floor
outage outright. `computeHomeGridWatts` takes the same gate, and `computeGridImportWatts`
counts a Core only while its content is fresh within the same window. Since v1.181.0 that is
the content-CHANGE clock `contentChangedAtMs` (moved only when `dpuContentWitness` — power and
pack flows, SoC, battery volts/amps — differs), because a REST 200 replaying a cached Core body
still advances `lastTelemetryAtMs`; and a fresh panel reading of no grid zeroes Core import
outright, since the Cores draw grid only through the panel.
Quotas arrive every ~60 s, so the burst-gap behaviour is untouched. The window assumes that
cadence holds, and undici's default request timeouts (300 s, equal to the window) would let a
single hung read hold the serial poll loop past it — a risk, not an observed incident (the one
540 s `/device/list` gap in the log was a connect-timeout outage on the normal cadence). EcoFlow
READS now carry `ECOFLOW_REST_TIMEOUT_MS` = 30 s, so a hang is an ordinary poll failure.
WRITES (`PUT`, `sendCommand`) keep undici's defaults: a slow reply may still mean the command
landed, and a reserve revert failed at 30 s and re-sent three times would escalate to a spoken
"reserve stuck" critical with the panel already restored. A 6 s `/status` blip
does not drop a reading that is still fresh: dropping it would remove the gridSta backstop at
the floor between charge bursts, the false critical this term exists to close. Residual: a
pre-outage "1" can still assert presence until the next successful quota, at most
`SHP2_READBACK_STALE_MS` after the last good one, whether the panel went dark or its polls
began failing as the outage began; the at-floor pool-discharge guard still applies. The cost
runs the other way on a healthy grid: a REST outage of more than 5 minutes at the floor during
a grid charge withdraws the gridSta backstop, and the floor alarm speaks, because nothing can
vouch for the grid. The declared-grid veto is unaffected: it reads the last reading, however
stale.

`presenceUnknown` (v1.179.0) is true when `present` is false only because nothing can be
heard — no veto reading, no fresh not-OK reading, no usable entity reading off. The
night-charge actuator and force-charge receive `gridPresent: null` then, not false: both treat
null as "do nothing", so a stale panel no longer ends a night's buy or switches force-charge
OFF on no evidence.

`panelFresh` (v1.179.0) is the server's `shp2ReadbackFresh` verdict on the panel (null with no
panel). The Energy flow card treats `panelFresh === false` as frozen, like an offline or
shadowed panel: the server has already zeroed that panel's grid reading, and a client-side clock
would reintroduce skew.

**Surviving a restart (v1.180.0).** The last not-OK reading is persisted per panel serial to
`grid-reading.json` next to the database (`GRID_READING_PATH` overrides; off by default outside
the add-on, so test processes never share a file). It is written only when the reading changes,
deleted the moment the panel reports Grid OK, and never holds a Grid OK reading. The write is
atomic (temp file + rename); a failed write is logged once and retried on every later panel
reading. The store loads the file when it is constructed. Two restart cases then keep the veto:
- **The cloud is reachable but the panel is dark.** On first sight `setDeviceList` puts the
  reading back on the panel as `lastGridReading`, logged once. A panel listed offline is never
  polled, so it has no projection and nothing else would restore the reading; the resolver
  finds such a panel by product identity.
- **The cloud itself is unreachable** (an outage that also takes the internet down). No
  `/device/list` succeeds, `setDeviceList` never runs and there is no panel device at all.
  `SnapshotStore.persistedGridAbsent()` hands the reading to `liveGridBackstop`
  (`GridBackstopInput.persistedGridAbsent`, registered in `index.ts`).

The hand-over is per serial and needs evidence. A persisted reading is served until **its own
panel** appears in a list; from then on it lives on the panel's device. A list that comes back
empty or without the panel is a cloud-side glitch, not evidence (v1.145.0), so it leaves the
reading standing. A list showing a **different** panel is evidence the old one was replaced or
removed, and prunes its entry, so a stale reading cannot veto a later restart made while the
cloud is unreachable.

Before v1.180.0 an outage with the toggle ON, a cloud-dark panel and a restart (watchdog, host
reboot, update) brought "grid present" back for as long as the panel stayed dark. The persisted
reading has no age limit, because the veto clears on evidence, not silence. The cost is a stale
"no grid" after a long dark period in which the grid returned. It clears on the panel's first
report; while the panel stays dark, the dashboard's "Grid is back — clear" (v1.184.0,
`POST /api/grid-veto/clear`) sets it aside until the panel's next reading. The reason marks it "(last reading from before a restart; panel offline)",
"(…; nothing since)" or "(…; the device list is unreachable)". A persisted reading never feeds
presence, which still needs a fresh readback.
With nothing persisted, the grid-state fields at boot follow the declaration as before: with no
evidence against it, the operator's statement is the best information, and withholding it would
leave `off_grid` unknown for the whole of a long cloud outage.

#### 4.3 The `backstopping` decision (stricter than `present`)

`backstopping` = safe to downgrade the floor to advisory. It requires the grid to actually be **carrying** the load. Two floor-scoped guards distrust a merely-declared grid:

- **`poolDischargingAtFloor`** — `poolDischarging && atReserveFloor`. `poolDischarging = (aggregateFleetFlow.fleetBatteryNet > POOL_DISCHARGE_WATTS=50) OR !homeCoreCoverage.complete`. At the reserve floor a present grid must have transferred and the pool must stop draining; if it keeps draining (or the roster is incomplete so drain is unobservable — v1.3.0 coverage gate: "we can PROVE discharge from a partial sum but never DISPROVE it"), the declared grid isn't really there. (The old `chargeWattPower < −50` check was permanently dead — that field is a non-negative configured charge *limit*, ~7.2 kW per connected battery, even when idle.) The coverage is judged with the resolver's clock (v1.188.1): a Core listed online on a frozen meter (content unchanged for `SHP2_READBACK_STALE_MS`: a quota that keeps failing, a cloud replaying its cached body, the first list cycle after an online flip) is not reporting, as the backup timers, the energy bridge and the Battery Net sensor read it. Before, its held pack net of 0 W read as "every Core reporting, not draining": at the floor with gridSta = Grid OK and that Core's slot delivering 1.1 kW, the guard backstopped and the SoC-ladder and runway alarms were downgraded, while the same Cores offline kept them critical.
- **`floorWithoutFlow`** — `atReserveFloor && importWatts==0 && homeGridWatts==0`. A stale "grid available" toggle with no measured flow must not mute a real at-floor outage.
- **`atReserveFloor` slack is operator-configurable** (v1.74.0): `GRID_FLOOR_SLACK_PCT`
  sets how many points above the reserve the pool counts as "at the floor" —
  which is also the lighting-austerity pre-arm point. Default 1.5, clamped 0–10;
  blank/garbage falls back to 1.5 (`floorSlackPct()`, tested against the
  `Number("")===0` trap). 0 arms only at the reserve itself. At a typical evening
  drain (~7 %/h) each point is ≈9 min of pre-arm warning; the trade-off is
  documented in the option description (en+es).

```
gridStaBackstop = shp2GridConnected===true && !poolDischargingAtFloor   # exempt from floorWithoutFlow (live device signal)
backstopping    = importLive
               OR gridStaBackstop
               OR (declared && !poolDischargingAtFloor && !floorWithoutFlow)
```
Away from the floor, a flow-less declaration remains a valid backstop (grid available, not yet needed) so a self-consumption home doesn't nuisance-escalate every evening.

#### 4.4 Staleness fail-safe (`liveGridBackstop`)

`liveGridBackstop(devices)` reads env + HA cache. A configured grid entity older than `GRID_ENTITY_MAX_AGE_MS` = 120 s (`getCacheAgeMs` since the last *successful* fetch) is treated as **UNKNOWN, not its frozen value** — when HA is unreachable (Pi reboot / network partition / token expiry, exactly when the grid may be down), replaying a stale "on" is the one false "grid is fine" the safety posture forbids. `atReserveFloor` is true when any panel's `socPct = backupRemainWh/backupFullCapWh × 100 ≤ backupReserveSoc + floorSlackPct()` (`GRID_FLOOR_SLACK_PCT`, default 1.5, see §4.3). The slack absorbs SoC quantisation jitter.

#### 4.5 Grid-aware priority downgrade + SoC dispatch (`socGridDispatch.ts`)

`downgradePriorityForGrid(p, backstopping)`: collapses `critical`/`high` → `low` when backstopping; medium/low unchanged (already non-emergency).

- `socGridCrossDecision(t, backstopping)` → `{priority, onGrid}` where `onGrid = priority !== t.priority`. `onGrid=true` means the consumer must **record** the crossing's true priority in the `socDowngraded` map so a later grid drop can restore it.
- `reEscalateGridDrop(socDowngraded, soc, backstopping, isPriorityEnabled)` — the grid-drop re-escalation pass. Deletes any band the pool climbed back above; and when the grid is **not** backstopping, deletes and returns every still-active downgraded band so the consumer re-announces it at its **true** priority. This closes the one-shot fail-silent window: the SoC ladder fires once per downward crossing, so without re-escalation a grid drop while the pool sits in a downgraded band would never re-fire.

In `socLadders.ts` (index.ts before v1.187.22) the SoC alarm's `onCross` uses `socGridCrossDecision`, records/clears `socDowngraded` for **every** crossed band (not just the primary), and the store-change tick runs `reEscalateGridDrop` each tick once the boot gate is open (§3.8). This self-heals on the ~60 s REST poll cadence even under a total MQTT stall (the poll loop unconditionally emits 'change').

---

### 5. Load-shed advisor — `loadShedAdvisor.ts`

#### 5.1 What it does

Advisory-only (**never actuates**). Reads the runway projection + live HA device state + SHP2 circuit watts, decomposes the load, and emits a recommendation like *"shed pool pump + EVSE, runway extends from ~3.5 h to up to ~8 h."* The operator's own HA automations consume it. It **reuses `classifyRunway()` verbatim** so shed bands line up exactly with the audible runway alarm, and it is passed the same live grid backstop so it stays grid-aware.

#### 5.2 The counterfactual — `computeRunwayWithShedOffset`

Given `shedWatts`, backs the average net pool-drain rate out of the projection's own energy/time and re-derives the time after removing the shed power. It is an **UPPER BOUND** (assumes the shed load drew across the whole horizon), so results are labeled `isUpperBound` and phrased "up to".
```
shedKw = max(0, shedWatts)/1000
netKw  = energyKwh / hours                       # gross pool-drain rate (delivered/η)
newNetKw = netKw − shedKw / RUNWAY_DISCHARGE_EFFICIENCY   # v1.26 pool-basis consistency
if newNetKw <= 0.001: return null                # shedding ≥ net draw → no depletion
return round((energyKwh / newNetKw), 1)
```
The `/η` on the shed term is essential: since v1.26 `hours` is the η-corrected pool-drain countdown, so `netKw` is the *gross pool-drain* rate; shedding `shedKw` of **delivered** load reduces pool drain by `shedKw/η`, not `shedKw`. Dividing onto the same pool basis keeps the two terms consistent (else the shed benefit is under-counted by ~1/η). `hoursToReserve` uses `remain − reserve`; `hoursToEmpty` uses `remain`.

#### 5.3 Composition & recommendation

`buildLoadComposition` picks the best watt source per allowlisted entity: **SHP2 circuit (authoritative) → HA power sensor → operator estimate**. An entity missing/unavailable/unknown in HA is flagged `available:false` (a phantom candidate, e.g. a dead device still on the allowlist) rather than silently counted.

`computeAdvisory` recommends only when **in an actionable band** (`classifyRunway` returns medium/high/critical) **AND below** `thresholdHours`. It walks the composition shed-first, accumulating loads that are currently ON with positive watts until the (upper-bound) counterfactual clears `thresholdHours + restoreMarginHours` or the list is exhausted. `actionable` additionally requires the shed to **materially help**: either it clears the depletion, or it extends `hoursToReserve` by ≥ `MIN_SHED_BENEFIT_HOURS` = 0.25 h (a 70 W shed off a 6 kW draw is cosmetic and a "shed now" prompt would mislead). Grid-aware: when backstopping, `classifyRunway` returns null → band null → no shed recommended, matching the audible alarm.

#### 5.4 Config, outputs & endpoints

| Env | Default | Meaning |
| --- | --- | --- |
| `LOAD_SHEDDING_ADVISORY_ENABLED` | `true` | Master enable (set `false` to disable) |
| `LOAD_SHEDDING_RUNWAY_THRESHOLD_H` | 4.0 | Only advise when runway ≤ this |
| `LOAD_SHEDDING_RESTORE_MARGIN_H` | 2.0 | Extra margin the shed must buy past the threshold |
| `LOAD_SHEDDING_SHED_ENTITIES` | (empty) | Allowlist (empty ⇒ advisory inactive, zero overhead) |

- REST: `GET /api/load-shedding/status` → `{enabled, mode:'advisory', candidatesConfigured, haStateCacheAgeMs, advisory}`.
- MQTT (via `advisoryStateFields`): `load_shed_recommended` (bool), `load_shed_recommended_count`, `load_shed_recommended_watts`, `runway_to_reserve_if_shed_hours`.
- Driven by a 2-min tick (index.ts, `loadShedTick`) that skips entirely when no candidates are configured (opted-out installs pay zero cost).

> `..._runway_to_reserve_if_shed` reading `unknown` is **by design** on a healthy fleet: with no depletion in the horizon `projectedAfterShed.hoursToReserve` is null, and `advisoryStateFields` publishes it as null. It is not a broken sensor.

---

### 6. Cross-cutting: the audible path

All three alarms (runway, SoC, and the grid-drop re-escalation) converge on `broadcast.announce(priority, message, messageEs)` — a **dedicated** audible path bypassing the alert→condition pipeline so they annunciate even at a `critical` broadcast min-severity. Every announce is gated by `isPriorityEnabled(priority)` (per-priority Alert-Settings toggles) and, for runway, additionally by `shouldGateRunwayAudible` (mute while grid backstopping). Each message carries an English + Latin-American-Spanish second pass. The matching on-screen alerts (`forecast-runtime-*` for runway, the `alerts.ts` reserve band for SoC) are excluded from the broadcast condition so nothing double-chimes.

> **Quiet hours.** Inside `BROADCAST_QUIET_HOURS` (default `22-06`) the audible broadcast is silent — the condition broadcast and the dedicated `announce` path alike — unless `CRITICAL_BREAKS_QUIET_HOURS` is on (default off), in which case a red condition (or, for `announce`, a high or critical priority) still sounds. Pushes have their own window, `NOTIFY_QUIET_HOURS` (default `22-06`): warnings and info are held for the morning digest, and critical is held too unless the same option is on (§8, 4.2). On-screen alerts are unaffected. On an off-grid site with quiet hours set and that option off, the add-on logs a boot warning naming the trade-off.


---

