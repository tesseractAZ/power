## 7. Energy Accounting, Self-Consumption, Cost & Dispatch

This cluster covers the "economics" engines of ecoflow-panel: how the add-on
decomposes fleet energy flows into a conserved balance (PV → load / battery /
grid), how it accumulates the monotonic lifetime counters that feed Home
Assistant's Energy Dashboard, and the derived KPIs built on top of them —
self-consumption / solar-fraction, carbon avoided, TOU tariff cost, the greedy
day-ahead **dispatch plan**, the dynamic-programming **MPC** dispatch
recommender, and the two "wasted PV" detectors (inverter **clipping** and
SoC-saturation **curtailment**).

All code lives in `server/src/analytics.ts` unless noted. The lifetime
accumulators live in `server/src/recorder.ts`; the MPC lives in
`server/src/dispatch/mpc.ts`; the trapezoidal energy integrator lives in
`server/src/aggregator.ts`.

---

### 0. Foundations: the two grid quantities and the energy integrator

Two facts underpin every engine below, and getting them wrong is the source of
most historical bugs in this cluster.

#### 0.1 Trapezoidal, gap-aware integration (`integrateWh`)

`server/src/aggregator.ts::integrateWh(points, sinceMs, untilMs, maxGapMs=600000)`
is the one primitive that turns a power series (W samples) into energy (Wh) over
a window. Algorithm:

1. Clip samples to `[sinceMs, untilMs]`. If a sample exists just *before*
   `sinceMs` **and** the first in-window sample is within `maxGapMs` of it,
   synthesize a head point at `sinceMs` holding the pre-window value (assume the
   value held up to the window start).
2. Hold the last value to `untilMs` only if the tail sample is within `maxGapMs`.
3. Trapezoid each adjacent pair: `wh += ((v[i]+v[i-1])/2 · dtMs) / 3_600_000`,
   **skipping** any interval where `dtMs <= 0` or `dtMs > maxGapMs` (a gap → not
   extrapolated).

Returns `{ wh, coverageMs, totalMs, gapMs, samples }`. `coverageMs` (ms actually
integrated) is what the coverage gates below compare against.

| Constant | Value | Meaning |
|---|---|---|
| `maxGapMs` (default) | `10 min` | recorder heartbeats every 5 min while a device reports fresh content; a held device writes nothing (architecture chapter, section 4.3), so its stretch is a gap; > 10 min = lost coverage, do not extrapolate. The lifetime counters alone restate a held panel's reading across a gap the gate explains, up to 30 min, before integrating (architecture chapter, 4.4) |
| `INTEGRATE_HEAD_LOOKBACK_MS` | `10 min` | how far callers widen the query lower bound so the pre-window boundary sample is available |

> **F9 correctness note (v1.14.0):** the head-hold is conditioned on the *real*
> inter-sample gap (first-in-window − boundary), **not** the distance to the
> window edge. Otherwise the 5-min lifetime-rollup watermark could chop a real
> >10 min telemetry stall into ≤10 min slices and fabricate held-power Wh into
> `total_increasing` counters. An empty window contributes exactly 0.

#### 0.2 `gridImport` (DPU `ac_in`) vs `gridToHome` (SHP2 `grid_home_w`)

There are **two distinct grid metrics** and they are not interchangeable:

| Quantity | Source field | Recorder metric | Captures | Fleet lifetime key |
|---|---|---|---|---|
| **Grid import to battery** | DPU `ac_in` | `ac_in` (per DPU) | grid that AC-**charged the DPUs** — a *subset* of home grid | `fleet_grid_import_wh` |
| **Whole-home grid import** | SHP2 `wattInfo.gridWatt` | `grid_home_w` (SHP2) | grid metered at the SHP2 main that serves **home loads directly through the panel** — the term that closes the *load* balance | `fleet_grid_home_wh` |

On an SHP2 home the DPU `ac_in` reads **~0** while real grid flows through the
SHP2 main. Therefore **`grid_home_w` is the authoritative grid term** for the
solar-fraction, carbon, and tariff KPIs. But `grid_home_w` was only instrumented
in v0.34.0 with **no historical back-fill**, so for ~7 days after that update it
covered only the tail of the window while `panel_load` covered all of it — which
made the solar-fraction come out impossibly inflated. The fix is a **coverage
gate** (see §1.3), used identically by self-consumption, carbon, and tariff.

---

### 1. Self-Consumption / Solar-Fraction (`computeSelfConsumption`)

#### 1.1 What & why

Decomposes the last-7-day fleet energy into a conserved breakdown —
PV-generated, household load, battery charge/discharge, and grid import — and
derives the headline **solar fraction of load** (share of household consumption
*not* served by grid) and **direct-use ratio** (PV that went straight to load).
On an off-grid/no-export home the naive "self-consumption %" is structurally
100%, so the useful outputs are the breakdown and the two ratios.

#### 1.2 Inputs

| Input | Source | Notes |
|---|---|---|
| `pv_total` (per home DPU) | recorder | fleet PV |
| `ac_in` (per home DPU) | recorder | `gridImportKwh` |
| `pack{N}_in` / `pack{N}_out` (per pack) | recorder | battery charge / discharge |
| `panel_load` (SHP2) | recorder | `loadKwh` — the denominator |
| `grid_home_w` (SHP2) | recorder | whole-home grid (`gridToHomeKwh`) |
| SHP2 connector membership | `shp2ConnectedDpuSns(devices)` | scope: **home cores only** |

**Scope discipline (v0.9.76):** the numerator (PV/charge/discharge/`ac_in`) sums
over **SHP2-connected home DPUs only** because the denominator `panel_load` is
intrinsically home-only. Summing spare-core PV against home load once produced a
physically impossible `solarFractionOfLoadPct = 127%`.

#### 1.3 The calculation, step by step

1. **Window:** `since = now − windowDays·86_400_000` (default 7 days).
2. **Integrate energy per metric** via `windowedEnergyWh(...)` at a **300 s
   bucket** (`ANALYTICS_BUCKET_SEC = 300`). `windowedEnergyWh` memoizes each
   *completed calendar day*'s integral (immutable) keyed by
   `${dayStart}|${sn}|${sortedMetrics}` and only re-integrates today + the
   window's leading partial (7.4× faster warm; identical to whole-window to
   ~0.011 %). Cache retains ~10 days, pruned at 256 entries. It is cleared, with the
   report caches, when rows leave `samples` (a held-sample move, v1.188.1: the samples
   generation, architecture chapter section 4.4).
3. **Restore cloud-wedged cores (v0.78.0):** a SHP2-connected SN that's absent
   from the live device map (cloud-wedged) is added back by enumerating the
   `pack{N}_in/out` metrics that *actually exist* in the recorder via
   `listMetrics(sn)` — anti-fabrication: real recorded metrics only, an SN with
   no history contributes 0.
4. **Grid coverage gate:**
   ```
   gridHomeCoverageFrac = coverageMs(grid_home_w) / coverageMs(panel_load)   // clamped ≤1
   gridHomeTrusted      = shp2 present && gridHomeCoverageFrac ≥ 0.9          // GRID_HOME_MIN_COVERAGE
   ```
5. **Pick the grid term for KPIs:**
   ```
   gridForKpiKwh =
     no SHP2 (DPU-only)          → gridImportKwh          // ac_in IS the grid measure
     SHP2 && gridHomeTrusted     → max(gridToHomeKwh, gridImportKwh)
     SHP2 && NOT trusted (ramp)  → null                   // publish "unknown", never a wrong number
   ```
6. **PV↔battery↔grid apportionment (v0.93.0 audit #4):** the SHP2 carries the
   home from grid and tops the pool at the ~10 % floor, so grid *beyond* the load
   is what charged the battery from grid:
   ```
   gridToBatteryKwh = (shp2 && gridForKpiKwh!=null) ? max(0, gridForKpiKwh − loadKwh) : gridImportKwh
   pvToBatteryKwh   = max(0, batteryChargeKwh − gridToBatteryKwh)
   pvToLoadKwh      = max(0, pvKwh − pvToBatteryKwh)
   ```
7. **Headline KPIs (grid-displacement form, caps at 100 % by construction):**
   ```
   solarFractionOfLoadPct = (loadKwh>0.5 && gridForKpiKwh!=null)
        ? max(0, round(((loadKwh − gridForKpiKwh) / loadKwh)·1000)/10)  : null
   directUseRatioPct      = pvKwh>0.5 ? round((pvToLoadKwh/pvKwh)·1000)/10 : null
   ```
   > **v0.10.4 fix:** the prior `(pvToLoad + batteryDischarge)/load` form
   > double-counted PV that transited the battery (counted at charge *and* again
   > at discharge), yielding an impossible 104.5 % while importing 76 kWh grid.

#### 1.4 Coverage telemetry (`selfConsumptionCoverage`)

Because each home core's own metrics are integrated, a wired core that goes
cloud-offline silently deflates the KPIs. `selfConsumptionCoverage(connected,
homeDpus, devices, shp2Present)` reports:

- `homeDpusConnected` = `connected.size`
- `homeDpusReporting` = 0 when `connected.size===0`, else home cores with
  `devices[sn].online !== false`
- `coveragePartial` = `shp2Present && (homeDpusConnected===0 || reporting < connected)`

> **Anti-footgun (v0.69.0):** when the SHP2 *itself* is cloud-offline it reports
> **zero** connectors — the KPI is *least* trustworthy. Deriving the flag naively
> as `reporting < connected` would read `N < 0 = false` ("fine") in exactly that
> window. The explicit `homeDpusConnected===0` clause flags it partial.

#### 1.5 Outputs — `SelfConsumption`

`GET /api/self-consumption?days=<1..30>` (default 7), cached 60 s.

```jsonc
{
  "generatedAt": 0, "windowDays": 7,
  "pvKwh": 0, "loadKwh": 0,
  "batteryChargeKwh": 0, "batteryDischargeKwh": 0,
  "gridImportKwh": 0,          // DPU ac_in
  "gridToHomeKwh": 0,          // SHP2 grid_home_w
  "pvToLoadKwh": 0, "pvToBatteryKwh": 0,
  "solarFractionOfLoadPct": 0,      // null when grid untrusted
  "directUseRatioPct": 0,           // null when pvKwh ≤ 0.5
  "gridForKpiKwh": 0,               // null on the grid_home_w ramp
  "gridHomeCoverageFrac": 0.0,
  "homeDpusConnected": 0, "homeDpusReporting": 0,
  "homeDpusCoveragePartial": false
}
```

#### 1.6 Trace to HA

`/api/ha-state` → `solar_fraction_of_load_percent` (= `solarFractionOfLoadPct`),
`direct_use_ratio_percent`, `self_consumption_coverage_partial`. MQTT sensors:
`ecoflow_solar_fraction_of_load`, `ecoflow_direct_use_ratio`,
`ecoflow_self_consumption_coverage_partial` (binary; `entity_category:
diagnostic`).

#### 1.7 Config & guards

| Knob | Default | Effect |
|---|---|---|
| `?days` query | 7 | window (clamped 1–30) |
| `GRID_HOME_MIN_COVERAGE` (const) | `0.9` | grid-trust gate |
| `ANALYTICS_BUCKET_SEC` (const) | `300` | SQL bucket |
| `SELF_CONSUMPTION_TTL_MS` (const) | `15 min` | engine cache |

- **Honest null:** `solarFractionOfLoadPct` / `gridForKpiKwh` are `null` (→ HA
  "unknown") during the `grid_home_w` instrument ramp — by design.
- **No poison-cache:** only latched when `dpus.length > 0 && shp2 != null`; a
  boot-partial snapshot may be *returned* but never cached (v0.15.13).

---

### 2. Lifetime Energy Accumulators (`recorder.getLifetimeTotals` + rollup)

#### 2.1 What & why

Monotonically-increasing kWh counters for HA's Energy Dashboard. HA ingests them
with `state_class: total_increasing` and treats any decrease as a meter reset, so
these counters must never regress.

#### 2.2 The two accumulation paths

**(a) Watt-integrated fleet keys** — `fleet_pv_wh`, `fleet_load_wh`,
`fleet_grid_import_wh`, `fleet_grid_home_wh`, plus `circuit_<N>` keys.
`rollupLifetime()` runs every **5 min** (`LIFETIME_ROLLUP_INTERVAL_MS`; first run
~30 s post-boot). Each tick, for each key it integrates
`integrateWh(samples, watermark, now)` from `watermark − LIFETIME_ROLLUP_LOOKBACK_MS`
(so `integrateWh` sees the pre-window boundary), adds `wh`, clamps negative
deltas to 0 (a sign-flip can't decrement), and advances the watermark.

**(b) BMS-sourced battery keys** — `fleet_battery_charge_wh`,
`fleet_battery_discharge_wh`. These come from the BMS coulomb registers
(`accuChgMah`/`accuDsgMah`), converted to home-relative Wh by subtracting a
per-pack baseline (`packDeltaWh`, deltas floored at 0), not integrated from
power. Each rollup stores `max(BMS, persistedFloor)` so a momentary BMS readback
dropout (0/null) never looks like "battery emptied".

**(c) The energy bridge, while a home Core is dark** (`energyBridge.ts`). Paths (a)
and (b) read the Cores themselves. A Core with no reading of its own while its panel
slot stays connected reports nothing: its packs are carried at their held values (both
counters flat) and its PV integrates to 0. On 2026-10-14 23:52 MST all five Cores
went dark with the panel online; Home Assistant read battery in/out 0/0 and solar
0.0 kWh for 10-15 and 10-16 while the house ran about 48 kWh a day off those
batteries (the vendor ledger for 10-15: solar 48.8, battery out 49.0 kWh).

A Core is **dark** when it delivers no reading of its **own** (`coreReports`), whatever
the cloud's online flag says. Its own reading is a projection the recorder's gate writes:
content landed within 3 min and, for a Core, changed within `SHP2_READBACK_STALE_MS`
(5 min, the content clock the Energy flow card and the backup timers read). A Core the
cloud lists offline must also have changed after the offline flip. Dark therefore covers:

- a Core cloud-offline with no data since the flip;
- a Core listed online on a frozen meter: a quota that keeps failing, or a REST 200
  replaying a cached body;
- a Core listed online with no projection yet, or whose first body after a restart only
  seeded the content witness.

Not dark: a Core the cloud lists offline whose MQTT data still arrives and changes. Its
measured `pv_total` and BMS registers count, as the gate records them. The recorder writes
exactly the Cores that report, and the bridge meters every other connected home Core, so
no span is booked twice or by nobody. A Core the bridge has booked (it holds hand-over
markers) stays dark until it **hands back** (`handsBack`, below): through an online flip
before its first fresh body, and through a quota that keeps failing after the flip.

A slot is bridged once its Core has been dark for `BRIDGE_DWELL_MS` (3 min) from the
instant its own reading stopped (`ownReadingStoppedAt`). Listed offline, that is the later
of its `onlineChangedAtMs` and its last content change. Listed online, it is its last
content change; after a restart the instant persisted for it stands in. A slot is bridged
at once when no run of the add-on saw the Core stop (offline at the device list's first
sight, none persisted), or while it is marked. An online Core with no instant known (a
restart's first body) starts its dwell at the process's first sight of it, so a live Core
that reports seconds after a restart is never bridged. A `/status` flip lasts seconds, and
the 2026-10-03 `/device/list` blip flagged three Cores offline for about 92 s while their
MQTT data kept arriving (not dark at all). Inside the dwell nothing is bridged and no marker
or log line is written. The Core is then in neither power figure, so Fleet PV and Battery
Net read unknown rather than a partial sum.

**The hand-off instant.** The bridge takes a Core over at the instant its own reading
stopped. For each dark slot the window starts at max(the rollup watermark, that instant),
and the recorder counts the Core's own `pv_total` / `ac_in` only up to it
(`offlineHomeCores` / `ownEnergyUntil` in `buildContributors`): on every read at once,
and in a rollup once the dwell has passed. A rollup that falls inside the dwell still
counts the Core itself, and the bridge then starts at that rollup. So a Core that goes
dark between rollups keeps the energy the read path already showed, and no stretch is
counted twice. In a window where the bridge can book nothing for a dark slot (no slot
reading inside it: the recorder writes none while the panel's reading is not fresh), a
marked Core whose own readings arrive again counts them for that window instead: the
recorder its measured `pv_total` / `ac_in`, the bridge its own pack meters for battery in
and out (Σ ∫ `pack<N>_in` / `pack<N>_out`, the rows the gate wrote; `own` on the window in
`bridge.lastRollup`). Its BMS movement is still absorbed, the marker kept. Before, its PV
counted and its battery energy was booked by nobody for as long as that lasted (a REST
problem that keeps the panel's quota failing while the Cores' MQTT stream has resumed).

The instant is persisted (`bridge_offline_<sn>`, the row's ts). It is written when the Core
goes dark, kept through an online flip while the Core is marked, and deleted once the Core
is no longer dark (`/api/debug/battery-lifetime` → `bridge.offlineSince`). A restart reads
it back: the store then has no clocks for the Core, and the persisted instant stands in.
That matters after a
**crash** (a power cut, an OOM kill, an uncaught exception), which runs no final rollup:
the watermark is the last rollup's, up to 5 min before the crash, and the emit high-water
sidecar is the one that rollup persisted. Without the instant the cut and the bridge's
window would both fall at the watermark. The first publish after the restart would then
drop the PV and AC input the crashed process had shown since the flip (PV Production
stepped down 150-525 Wh in the replays), and the bridge would book again the battery
energy the BMS had counted before the flip (125-375 Wh). The Core's recorded series also
count up to the cut when it has no projection: no quota is fetched for a device listed
offline, so after a restart a dark Core usually has none. A crash restart therefore
publishes what the uninterrupted process would have (`recorderEnergyBridgeTransitions`:
read for read, every minute).

Each rollup window, for each dark slot, the bridge reads the slot meter
(`src<n>_w`, the panel's `backupInfo.chWatt`; negative = the Core supplies the panel):

```
acOut = ∫ max(0, −chW)      acIn = ∫ max(0, chW)
net   = acOut − acIn − pv   net ≥ 0 → battery out += net;  net < 0 → battery in += −net
```

The slot meters the **AC exchange** between Core and panel, not battery flow: PV that
charges a Core never crosses it, and the Cores' own conversion and standby draw is
invisible to it. The panel balance closes at AC (10-15: grid 2.22 + slot out 45.60 kWh
against a panel load of 47.95), and the split keeps grid + PV + out − in equal to the
panel load. `pv` comes from one of the bases in the table below. The window is clamped to
15 min (`BRIDGE_MAX_WINDOW_MS`), so the first rollup after a graceful restart never spans
the downtime (its final rollup leaves nothing pending). After a **crash** the rows from the
last rollup to the crash are in `samples`, so when slot rows were recorded in the 15 min
after the watermark the window starts at the watermark instead: the downtime itself has
no rows, and `integrateWh` does not integrate across a gap over 10 min. Clamping past them
had dropped up to one rollup window of every dark Core's battery and solar energy (about
0.28 kWh at a 3.4 kW drain) while Panel Load and the grid counters booked the same minutes.

**Which rows.** A window books the slot rows that exist, whatever the panel's reading is at
the rollup instant: the recorder writes a panel row only while the panel's reading is fresh
(`projectionRecordable`), so each row is a reading. Judging the whole window on the instant
had dropped the minutes that had rows whenever a rollup landed in a cloud shadow or a quota
stall (an hour with a quota stall across one rollup instant booked 3.10 of 3.39 kWh of
battery out). A dark slot
with no row in the window while its last row is less than 10 min old
(`INTEGRATE_HEAD_LOOKBACK_MS`) **holds** the window: nothing is booked or written, the
watermark stays, and the next window integrates across the gap from the rows on both sides,
as `integrateWh` bridges a gap of up to 10 min inside one window (`bridge.lastRollup.held`).
The recorder holds `fleet_pv_wh` and `fleet_grid_import_wh` with it, so the Cores' own rows
and the slots cover the same span. A longer gap that the gate explains (the panel watched
through it and held: architecture chapter, 4.4) is held too while it is within
`HELD_ENERGY_BRIDGE_MAX_MS` (30 min), the 15-min clamp waiting for it as well, and once it ends
the panel's held reading is restated across it every 5 min, as v1.188.0's rows were (a 10-poll
replay had lost 0.52 of an hour's 3.39 kWh of battery out). A gap past the bound, or one the gate
does not explain, is not bridged. A Core whose own readings arrive (above) is not held: its own
meters count instead.

A Core listed connected by two panels (one panel's source list is stale) is metered once,
at one listing (`connectedSourceListings`): on an online panel whose reading is fresh, else
online, then the house panel, then the lower serial, never the device map's order. Battery
Net and the rollup had counted both slots. The backup timers' bound reads the same listing.

| Basis | When | PV over the window |
|---|---|---|
| `night` | sun below the horizon at both ends of the window (`solarPosition` at the configured install site, `FORECAST_LAT` / `FORECAST_LON`, read by `bridgeSite`; Phoenix, the options' default, when the option is not a coordinate) | 0 — physics, not a reading |
| `measured` | daylight, and this slot's panel PV field has passed its check against the inferred bound (persisted `bridge_pvseen_<panel>_<slot>`) | ∫ `src<n>_pv_w` (the panel's `pvHeightChargeWatts + pvLowChargeWatts`, else `pvChargeWatts`) |
| `inferred` | daylight, the field not trusted (not yet checked, or below the bound) | monotone envelope `max(prev, Σ(acOut − acIn) + (pct − pct₀) × capWh)` from the slot's first daylight window of its dark span that day |
| `unchecked` | the power sensors only (`slotPowerBasis`): daylight, the field present, not trusted and not found below today | the field as read, for Fleet PV and Battery Net; the rollup books the same window `inferred` |
| `unbridgeable` | no slot reading in the window (the panel reading was not fresh), or an inferred window the meter did not cover (re-anchored); for the power sensors, the panel reading is not fresh now (`shp2ReadbackFresh`) | nothing booked at the slot (a marked Core's own readings count instead, above) |

The site matters on any install outside Phoenix: judged on Phoenix's clock, a Berlin
morning (10:00 CEST is 01:00 MST) would take the night basis and book the solar a dark
Core passes to the house as battery out, and a Berlin night the inferred basis, with both
power sensors unknown all night.

`capWh` is the Core's measured full-charge capacity (Σ its packs' last recorded
`pack<k>_full_cap_mah` × 0.1024 Wh/mAh, capped at the slot's nameplate), the basis the
panel's per-source percent is a fraction of; the slot's nameplate when none is recorded.
A 0 W reading from a field never checked is not "no PV": the panel PV fields read 0
at night on 2026-10-16 and had not been observed in daylight when the bridge shipped.

**Checking the panel's PV field** (`pvFieldVerdict`). One reading proves nothing, so the
inferred envelope runs in every daylight window of a dark slot whatever the basis, and
the field's integral is summed over the same windows. Once the envelope has risen
`BRIDGE_PV_EVIDENCE_STEPS` SoC steps (8; one step = 1 % of `capWh`, 0.28-0.30 kWh on the
live Cores), the field is **consistent** if it reads at least the bound less a tolerance of
max(`BRIDGE_PV_TOLERANCE_STEPS` steps, `BRIDGE_PV_TOLERANCE_FRACTION` of the bound) — two
steps or 15 %, `pvFieldTolerance` — and **below** otherwise: it reads less PV than the Core
demonstrably took in, by more than the bound's own error. That error is one step of SoC
quantization at each end (the percent is an integer) plus the capacity error of `capWh`.
Measured on 2026-10-18 (one panel, three dark slots; the field replayed from the recorded
`src<n>_pv_w` series against the bound, which reproduced the log's six verdicts to the
minute): the honest field read 1.13 / 1.37 / 0.89 of the bound at 1 kWh, 1.05 / 1.16 /
0.91 at 2 kWh, 0.99 / 1.07 / 0.93 at 5 kWh, 0.93 / — / 0.94 at 10 kWh and 0.92 / 0.97 /
0.90 at dusk (28.1 vs 30.3 kWh over the three slots), its shortfall by dusk 2.7 / 1.2 /
3.4 steps (7.7 / 3.5 / 9.6 %), one window at 10.4 %. With one step of tolerance and four
steps of evidence, the rule as first shipped, all three slots were trusted at about 1 kWh
and revoked at 2.99 / 7.66 / 9.54 kWh, each by 0.29-0.32 kWh — just over one step — and
the Now view lost solar, battery and consumption from 11:15 until dusk. On the days the
Cores reported (10-12, 10-13) the bound read 0.84-0.85 of their own `pv_total`, and
0.79-0.94 of the vendor ledger's solar on 10-15..10-17; the field was not recorded before
v1.188.1, so its ratio to the Cores' own figure is unmeasured.

A verdict is acted on once it has held for `BRIDGE_PV_VERDICT_HOLD_MS` (one hour) of
daylight check windows, or at once when the field differs from the bound by
`BRIDGE_PV_GENUINE_WH` (2 kWh, about seven steps) in the verdict's direction
(`pvVerdictHolds`): the same rule for trust and for revocation, so a transient the growing
tolerance absorbs within the hour — the bound rising in whole steps while the field
integrates smoothly, a field that lags the meter across a ramp — changes nothing. A
consistent field is trusted from then on (persisted, so it survives restarts and later
days). A below field is not trusted, and a trusted field that falls below is revoked (its
row deleted). Until the revocation acts, a trusted field found short is still booked on the
`measured` basis: the shortfall against the bound has first to exceed the tolerance (two
steps, or 15 % of the day's bound so far), and the verdict then holds for an hour unless the
shortfall reaches 2 kWh — so a slot whose trusted field freezes low books up to about the
larger of the tolerance and 2 kWh of solar short of the bound, plus a window's rise and a
step of quantization, before the field is revoked, and its battery in and out carry the same
error the other way (the slot meter is preserved); the one-step rule's exposure was about one
step. In time that is an hour or more after the freeze, longer when the day's bound is large
or the Core charges slowly (a replay: 3 kW of solar, 1 kW to the house, a 28.9 kWh Core, the
field frozen at 500 W at 11:00 — revoked 80 min later, 2.5 kWh short of a 15.2 kWh bound; the
same freeze at 14:00, the bound past 20 kWh — 135 min, 4.2 kWh), and a field that stays
within the tolerance is never revoked. The shortfall is not booked back: the inferred basis
resumes from the envelope, which kept rising through the held windows, so nothing steps down
and the day's counters keep the error. The power sensors publish the frozen field through
the hold (Fleet PV low, Battery Net high by the same amount), as does the backup timers'
bound. Every verdict acted on logs both figures, the tolerance and when the verdict
first appeared (`energy bridge: panel … slot … PV field read X kWh since … against the
inferred lower bound Y kWh (one SoC step Z kWh, tolerance T kWh) — … since …`), so the
first sunny day of an outage can be checked from the log; the debug block's `pvChecks`
carry a candidate verdict not yet acted on. The check restarts at night, when the field or
the slot meter does not cover a window, and when a dark span begins; a below verdict holds
until it restarts, so there is no trust/revoke churn within a day. A field that reads a
fraction r of the solar passes the first verdict only when r ≥ 0.75 (as before), and at a
large bound only when r ≥ 0.85. A field reading high is not caught: the bound is a lower
one.

Where the energy goes:

- **Battery.** Rows `bridge_battery_charge_wh` / `bridge_battery_discharge_wh` (their ts
  is the bridge's watermark) are added to the emitted battery totals in
  `getLifetimeTotals`, on top of the BMS floors. They are deliberately **not** folded into
  `bmsChargeFloor` / `bmsDischargeFloor` or the persisted `fleet_battery_*` rows: the floors
  are seeded from those rows, and the floor-gap re-seed (floor more than
  `BMS_RESEED_MIN_GAP_WH` above the live sum for `BMS_RESEED_SUSTAINED_ROLLUPS` rollups)
  would read a bridged total as a floor for a pool that no longer exists and step Home
  Assistant down: a negative hour while the step is under 10 % of the counter, a meter
  reset (the whole counter booked again — the phantom-kWh failure) at 10 % or more.
- **PV.** Added to `fleet_pv_wh` at each rollup (`bridge_pv_wh` keeps the bridged share);
  the dark Cores' own `pv_total` / `ac_in` count only up to the hand-off instant, so a
  frozen projection's heartbeat rows cannot double-count.
- **Grid to Battery Charge.** The dark slots' `acIn` (the Cores' AC input, metered at the
  panel) is added to `fleet_grid_import_wh` in place of their own `ac_in`.
- Bridged energy steps in at each rollup. Between rollups the pending integral keeps each
  dark Core's own energy up to its hand-off instant, so a Core going dark between rollups
  does not take back what a read already showed. As a backstop, `fleet_pv_wh` and
  `fleet_grid_import_wh` (`LIFETIME_HOLD_KEYS`) hold a dip between rollups of up to
  `LIFETIME_HOLD_DIP_WH` (5 kWh) instead of the 50 Wh of the micro-dip clamp: their rows
  only grow, so a lower total is pending energy the read path no longer sees (a Core
  whose slot leaves the panel mid-window, for one), never a reset. A replaced database
  is far larger and still passes through.
- **The Today card** (`/api/summary/today`, and the Solar tab's Today tile). Each rollup also
  writes one row per bridged Core to the `bridge_ledger` table (`bridgeLedgerRows`): the window
  `[since_ts, until_ts]`, its basis, what the rollup booked for that Core (PV, AC input, battery
  in and out), the slot's AC output (∫ max(0, −chW), which no lifetime counter keeps) and the
  slot meter's coverage of the window. A window the bridge metered but could not book (no slot
  reading in it, no capacity, a re-anchored inferred window) is written with zeros; a held
  rollup writes nothing; a window where the Core's own meters counted instead
  (`BridgeSlotWindow.own`) is not a bridged window and is not written. The rows are pruned with
  the samples retention. `computeTotals` with `bridged` adds, for each window that ended in the
  range, the booked energy to Solar produced, AC output and the battery flows, and leaves the
  Core's own samples out of the window (`integrateWhOutside`); outside the windows its own
  samples count as before. The windows are the bridge's hand-off instants, the cut the lifetime
  rollup makes, so the card's day is the change of `fleet_pv_wh` and of the two emitted battery
  totals over the same day, and no stretch is counted twice across a hand-over, including an
  hour in which a marked Core's own MQTT readings are recorded while the bridge still meters its
  slot. A window counts at its rollup instant, when the counters stepped by it: one that
  straddles midnight counts to the day it ended in, as Home Assistant's daily change does. While
  the bridge still meters a Core (its last window ends at the bridge's watermark), the Core's own
  samples since are left out as well, so a read between rollups never shows what the next one
  takes back. A connected home Core with no projection (dark since a restart) keeps its recorded
  series up to the windows, as `buildContributors` does. The slot meter's coverage of the
  windows counts toward `pvCoverage` and `homeCoverage` (the card's "% measured"). `fleet.bridged`
  carries the share (already in the figures, and in `batteryChargeWh` / `batteryDischargeWh`,
  which then hold this AC-basis share beside the pack-DC one), the windows by basis, and
  `pvInferredWh`, the solar booked on the inferred basis: a lower bound. The card notes "via
  panel" under each figure with a panel-metered part and "lower bound" under inferred solar
  (`web/src/cards/todayText.ts`); a bridged span that is all night leaves Solar unmarked (no
  solar is booked at night). No other caller asks for the bridged totals: the vendor-ledger
  comparison and the pack-DC round trip (energy history) and the reconnect report's PV coverage
  keep the Cores' own meters. The ledger has no backfill: windows booked before it existed are
  not in it, so on the day it first runs the card counts the bridged energy from then on.

**Hand-over.** For every held pack of a bridged Core the bridge writes a marker
`bridge_dark_<pack>`: the packs the Core's projection carries, or, with no projection (dark
since a restart), every held row except a pack another chassis carries now
(`heldPackKeysOf`). A row a pack left when it moved or was replaced, or a slot the store
hides, can never move, so its marker was never spent and the Core stayed marked for good:
bridged at once on any later dark moment, a 6 s `/status` blip included, with no dwell, its
whole rollup window booked at the slot beside what the BMS had counted. A Core that hands
back with its whole pack list (its pack count met) also spends the marker of any pack it no
longer reports, logged (`marker(s) spent for pack(s) the Core no longer reports`). A marked pack reports its held value, and any movement of its
registers off it is absorbed as `computeBmsBatteryDetail` sees it: the pack is re-baselined
(`base := register − held`), so that pass reports exactly the held value and counting
resumes from it. The marker is spent (the hand-over) only once the Core **hands back** (`handsBack`). It
must have **reported since its return** (`reportsSinceReturn`): it is online and its content
clock (`contentChangedAtMs`, the v1.181.0 `dpuContentWitness`) moved at or after its online
flip, or, online since before this process saw it, moved at all (the store's first body
after a restart only seeds the witness). It must also deliver a reading of its own now
(`coreReports`). That is the instant the bridge stops metering it. Movement before that is
energy from the dark span, which the bridge counts, so it is absorbed with the marker kept
and the energy kept in `bridge_absorbed_<pack>_chg` / `_dsg`:

- MQTT battery data (DPU `cmdId` 28, `accuChgCap` / `accuDsgCap`) that the store still
  translates while the cloud lists the Core offline. Without this the held value trailed
  the projection: an online flip on that projection re-baselined on a stale register,
  spent the marker, and the real jump arrived later through the normal path (the v0.45.0
  guard caps only one pack's capacity per pass). A 4-h night replay with 10 min of such data
  booked 26.7 kWh of battery out against 13.6 kWh true.
- A frozen projection at an online flip that lands before the first fresh reading, and a
  reconnect burst of queued data from early in the dark span that arrives just before the
  flip.

At the hand-over the marker and the absorbed rows are deleted, and one line per Core logs
what the BMS counted while dark (the absorbed rows plus this pass: absorbed) against what
the bridge counted (published: at the slot on the AC basis, or the Core's own pack meters
for a window its slot could not be read). The jump is absorbed whatever its size, below or above one
pack's capacity. A pack whose registers have not moved since the return keeps its marker
until they do; that pass's line then says `(N still marked)`, and the pack's own line
follows with its figures. A read-only (debug) pass reports held and writes nothing. A gap
the bridge did not count (no marker) still goes through the corrupt-read guard and the
persistence re-baseline of path (b).

The per-Core figures behind the two return lines (`bridge_core_<sn>_chg` / `_dsg`) are
cleared by the bridge's own rollup, once the Core has left the dark set and every marker
of it is handed over. The hand-over usually runs first, in a read (the publish runs
every 30 s, a rollup every 5 min), so the hand-over line and the bridge's `Core … is no
longer bridged … bridged X kWh in / Y kWh out while dark` line both print the figures,
in either order.

**Limits.** The bridged battery figures are on the AC basis at the panel: replayed on the
online days 10-03..10-14, the inferred split kept battery in within about 2 kWh/day of the
DC counters and read battery out 5-8 kWh/day low. Inferred PV is a lower bound: 0.83-0.90 of
the measured PV on 8 recorded days, short by a near-constant 4.7-6.1 kWh/day (most likely
the Cores' own draw), and up to one SoC step (~290 Wh) per Core per anchor either way. With
the measured basis, battery in would read about 5 kWh/day high instead. At the return, the
span from the bridge's last rollup to the Core's hand-back (at most one rollup window, 5 min)
is booked by neither: the hand-over absorbs it. That holds however long the Core stays listed
online without a reading of its own before handing back, since the bridge meters it until
then. At an outage start, the battery flow from the Core's last register reading to the
bridge's window start is absorbed at the hand-over without being bridged. That window is the
cloud's offline detection or the 5-min content window, plus a rollup that fell inside the
dwell. When no
run of the add-on saw the flip, there is no instant to persist: the Core went offline while
the add-on was down, or within one publish (30 s) before a crash. After a graceful stop
nothing is lost (the final rollup leaves nothing pending). After a crash while the Core
was reporting, the first publish drops the PV and AC input pending since the last rollup.
The bridge's first window books that span back (it starts at the watermark when slot rows
were recorded after it, however long the downtime), so Home Assistant sees a dip of up to
one rollup window's energy, then the rise. That span's battery energy is counted by the BMS
and again by the bridge (at most one rollup window). Nothing can be bridged while the
panel itself is dark, beyond a gap the gate explains of up to `HELD_ENERGY_BRIDGE_MAX_MS` (its
held reading restated, above); and there is no backfill: a bridge that starts mid-outage counts
from its first window (the energy before it is absorbed at the hand-over; the vendor's
`ecoflow_panel:vendor_*` statistics cover those days).

> **Anti-footgun — no rollback past the bridge once it has booked energy.** The bridged battery
> energy lives only in the `bridge_battery_*` rows, which a release without the bridge does not
> read. The rows only grow: a hand-over clears the markers and the per-Core rows, never these.
> So from the bridge's first booked window (`/api/debug/battery-lifetime` → `bridge.chargeWh` /
> `dischargeWh` non-zero) for good, rolling back below v1.188.1 drops every outage's bridged
> energy at once from the two emitted battery totals. What Home Assistant does with the step
> down depends on its size against the counter (`reset_detected`: a reading below 0.9 × the
> previous one):
>
> - **Under 10 % of the counter** (the sum of every outage bridged so far: at the 2026-10-16
>   totals, 3,589.7 kWh in and 3,566.5 kWh out, up to about 359 kWh, roughly 7 dark days at
>   about 50 kWh/day): the hour of the rollback books the bridged energy as a negative change,
>   with HA's "not strictly increasing" warning, and an upgrade back to v1.188.1 or later reads
>   the rows again and books the same amount back as a positive hour.
> - **10 % or more:** HA treats the drop as a meter reset and books the whole counter again
>   (the phantom-kWh failure).
>
> Either way the Energy dashboard is wrong for those hours, so once the bridge has booked
> battery energy, do not roll back below v1.188.1.

#### 2.3 The RTE clamp invariant — history and current state

> **Anti-footgun.** The BMS packs ship with `accuDsgMah > accuChgMah` (bench
> cycling), so on the raw absolute registers the home discharge total permanently
> exceeded charge. Two one-time, marker-gated resets fixed the *sign* of the
> problem:
> - **v0.9.74** (`.shp2-filter-v1.flag`): re-zero the four fleet counters when the
>   SHP2-membership filter shipped.
> - **v0.13.0** (`.bms-baseline-v1.flag`): capture per-pack BMS baselines and
>   re-zero the two battery counters, so subsequent deltas drive them.
>
> **The old `discharge ≤ charge` clamp was REMOVED in v0.45.0.** Rationale: the
> `accu*` registers are **coulomb counters** over an *open* window (baseline →
> now) that legitimately ends **below** baseline SoC, so cumulative discharge
> honestly exceeds cumulative charge. HA never requires in ≥ out — it ingests the
> two counters as **independent** `total_increasing` sensors. The clamp protected
> no RTE sensor (RTE = `computeRoundTripEfficiency`, windowed, with its own ≤100 %
> clamp). Both monotone floors are now emitted **unclamped**; the discharge floor
> stepped up to its true (~+45 kWh higher) value once, post-deploy — an intended
> honest correction.

The surviving artifact is **informational only**: `battery_baseline_deficit_kwh
= discharge − charge` (positive = discharge ahead of charge; shrinks toward zero
as the pool returns to baseline SoC). A one-line log fires **once per transition**
into the deficit state (`deficitWh > 1000`), latched by `bmsClampActive`.

> Marker-file fail-safety (`markerPresentProbe`, v0.79.0): the one-time markers
> are probed by **reading** (not `existsSync`) to close a TOCTOU race; only a
> confirmed-absent (`ENOENT`) marker counts as "not yet claimed". Any other read
> error (EIO from a corrupt inode after unclean power-off — this host's dominant
> reboot cause) is treated as **claimed**, so the destructive reset never re-runs
> per boot. Writes use `wx` (exclusive create); `EEXIST` = a racing starter, = success.

#### 2.4 The micro-dip clamp (`clampLifetimeDip`)

The live total (`persistedWh + pendingWh`) is re-estimated every call and can dip
a few Wh below the last emitted value (rollup-persist vs live-trapezoid
rounding). Because HA reads any decrease as a reset, `clampLifetimeDip`:

```
if prevEmitted == null:            return pendingWh
dip = prevEmitted − (persisted + pending)
if 0 < dip ≤ maxDipWh (50):        return prevEmitted − persisted   // hold flat
else:                              return pendingWh                 // let a real reset pass
```

`lifetimeEmitHighWater` (the per-key last-emitted map) is seeded from a persisted
sidecar so the clamp keeps its baseline across restarts, and persisted on the
5-min rollup (not the hot read path). v1.188.1: `fleet_pv_wh` and
`fleet_grid_import_wh` (`LIFETIME_HOLD_KEYS`) use `maxDipWh` = `LIFETIME_HOLD_DIP_WH`
(5 kWh), the backstop behind the energy bridge's hand-off cut (path (c)).

#### 2.5 Outputs — `GET /api/lifetime-energy` (cached 15 s)

`toKwh(x) = round(x/1000·1000)/1000`; `live(k) = toKwh(persistedWh + pendingWh)`.

```jsonc
{
  "generated_at": 0,
  "pv_lifetime_kwh": 0,
  "load_lifetime_kwh": 0,
  "grid_import_lifetime_kwh": 0,        // fleet_grid_import_wh (DPU ac_in)
  "grid_to_home_lifetime_kwh": 0,       // fleet_grid_home_wh (SHP2 main)
  "battery_charge_lifetime_kwh": 0,
  "battery_discharge_lifetime_kwh": 0,
  "battery_baseline_deficit_kwh": 0,    // DISPLAY-ONLY: discharge − charge
  "details": { "<key>": { "persistedWh", "pendingWh", "watermarkMs" } }
}
```

`GET /api/debug/battery-lifetime` (cached 15 s, strictly read-only) surfaces
`rawChargeFloorWh`/`rawDischargeFloorWh`, emitted totals (persisted+pending
split), `deficitWh` (what the removed clamp *would* have shaved), the per-pack
`PackLifetimeDetail[]` (filter membership + offline held-carry +
`backfilledFromHistory`), `offlineHeldMembers`, and `bridge`: the energy bridge's
totals (`chargeWh`, `dischargeWh`, `pvWh`, `gridImportWh`, `watermarkMs`), the pack
`markers` whose jump will be absorbed on return, the BMS energy of marked packs already
absorbed before their hand-over (`absorbed`), the `trustedSlots` (PV field passed its
check), the running field checks (`pvChecks`: `fieldWh`, `inferredWh`, `stepWh`, `verdict`
per dark slot in daylight), per-Core bridged energy since it went dark (`cores`), the persisted
hand-off instant of each home Core listed offline (`offlineSince`), each dark slot's power
basis now (`slots`; `leftOut` when its panel is cloud-offline), and the last rollup window
per slot with its basis and the reason a window was not booked (`lastRollup`). The emitted battery totals (and the battery
`details.persistedWh` of `/api/lifetime-energy`) include the bridge rows.

#### 2.6 HA Energy Dashboard wiring

All six counters publish `device_class: energy, state_class: total_increasing`
MQTT sensors so they slot directly into HA's Energy Dashboard:

| MQTT `unique_id` | HA name | Value key |
|---|---|---|
| `ecoflow_pv_lifetime_kwh` | EcoFlow PV Production | `pv_lifetime_kwh` |
| `ecoflow_load_lifetime_kwh` | EcoFlow Home Consumption | `load_lifetime_kwh` |
| `ecoflow_grid_import_lifetime_kwh` | EcoFlow Grid to Battery Charge (diagnostic) | `grid_import_lifetime_kwh` |
| `ecoflow_grid_to_home_lifetime_kwh` | EcoFlow Grid Import (Home) | `grid_to_home_lifetime_kwh` |
| `ecoflow_battery_charge_lifetime_kwh` | EcoFlow Battery Energy In | `battery_charge_lifetime_kwh` |
| `ecoflow_battery_discharge_lifetime_kwh` | EcoFlow Battery Energy Out | `battery_discharge_lifetime_kwh` |

Per-circuit `ecoflow_circuit_<ch>_lifetime_kwh` sensors are enumerated from
`shp2.projection.circuits` (also `total_increasing`). `listLifetimeKeys()` lets
the MQTT payload emit per-circuit keys at startup — before the first poll — to
match retained HA sensors from the prior run.

#### 2.7 Energy Dashboard **power** wiring (`stat_rate`) — required for the Now tab

The counters above drive the kWh views. The Energy dashboard's **"Now" tab**
(`hui-power-sources-graph-card`) is a separate, easily-missed data path: it plots
the per-source **power** statistic named by `stat_rate` on each energy source, and
derives its "Consumption" line as `max(0, Σ plotted series)`. Consumption is
therefore **not a measurement** — a source with no `stat_rate` is silently absent
from both the graph and the "Power usage" badge (`_computeTotalPower` gates every
term on `source.stat_rate`).

Consequence, and the reason this section exists: with only solar and grid rated,
`Consumption ≡ Solar + Grid` identically, the stacked grid band's upper edge *is*
the consumption line at every x, and the number is wrong by the whole battery flow
— overstating house load while the pack charges, understating it while it
discharges. `energy/validate` does **not** flag a missing `stat_rate`.

Complete mapping (all three sources must be rated):

| Energy source | `stat_energy_from` / `_to` | `stat_rate` (power) | Basis |
|---|---|---|---|
| Solar | `ecoflow_pv_lifetime_kwh` | `ecoflow_fleet_pv_watts` | DC, MPPT input; a dark Core's share from the panel (see below) |
| Grid | `ecoflow_grid_to_home_lifetime_kwh` | `ecoflow_grid_home_watts` (SHP2 `wattInfo.gridWatt`) | AC, service main |
| Battery | out `…discharge…` / in `…charge…` | `ecoflow_fleet_battery_net_watts` | DC, pack terminals; a dark Core's share AC, at its panel slot |

While a home Core is dark the two rated power sensors add its slot
(`energyBridge.bridgeFleetFlow`): Battery Net adds `−chW − pv`, Fleet PV adds `pv`, with
`pv` = 0 at night and, in daylight, the panel's PV field whenever it is present and today's
check has not found it below the inferred bound — trusted (`measured`) or not yet checked
(`unchecked`, `slotPowerBasis`). The two sum to the slot meter whatever the field reads, so
the consumption the Energy dashboard derives is the measured one and only the solar/battery
split carries the field's error, where an unknown loses all three (2026-10-18 13:30-17:45,
the hours the one-step rule had revoked the field); the sensors cannot carry a quality flag
(no attribute is published, and the dashboard reads the state), so a present field is either
published or withheld. The rollup books an unchecked window on the inferred basis. The
inferred basis has no power figure, so in daylight with no PV field for the slot, or one
found below today, or while an online panel's reading is not fresh, both sensors publish
null (unknown) rather than a partial sum: their readiness flag is `flowBridged` (`publishReadiness.ts`), which the Cores'
own in/out/AC-import sums (`flow`) do not share. A dark slot whose panel is itself
cloud-offline is left out of both sums instead (`leftOut` in the debug block), as an
offline Core always was: nothing of it can be read or bridged until that panel returns,
and on a two-panel plant a garage panel that drops off the cloud with its Core must not
blank the house's Fleet PV and Battery Net for the whole outage. Before the bridge both were withheld
whenever no home Core reported, and the Now view's Power usage read 0 W through the
2026-10-15/16 outage while the house drew ~3.4 kW from the Cores.

- **Battery sign convention is "Standard"** — positive = discharging, negative =
  charging, matching HA's own helper text. `fleet_battery_net_watts` already
  follows it; do not select "Inverted".
- **Grid must be rated to `grid_home_watts`, not `ac_import_watts`.** The latter is
  DPU `ac_in` — grid energy that AC-*charges the packs* — a diagnostic sub-metric
  that sits near zero on a solar-charged home (§ the `v0.44.0` naming-honesty note
  in `mqttDiscovery.ts`).
- **`power_config.stat_rate` vs top-level `stat_rate`:** the HA config dialog writes
  the former, the graph reads the latter, and the backend mirrors one to the other.
  After any programmatic `energy/save_prefs`, re-read `energy/get_prefs` and confirm
  the **top-level** key is present rather than assuming the mirror ran.
- **Irreducible residual — do not chase it.** Solar is metered at the MPPT DC input
  and battery at the DC pack terminals, while grid is the AC main, so PV→battery
  conversion loss lands in HA's node model as phantom load. Expect a roughly flat
  offset that scales with PV throughput, not with house load. Ground truth for house
  load is `panel_load` (Σ the SHP2 circuit CTs), never the derived consumption line.

Per-circuit counters are eligible for `device_consumption` (the per-device
breakdown), but **the residual they leave is not the conversion loss.** This
paragraph used to claim the circuit CTs sum to approximately whole-home load, so
that "untracked consumption" would read as the PV→battery conversion residual
above. Two things break that:

- The SHP2 meters the **backup-circuit subset**, not the service. Anything on a
  non-backup branch is invisible to the CT sum but present in the grid main, so
  the untracked figure carries real load as well as conversion loss.
- Channel 1 has never been reconciled. It reads 0.147 kWh lifetime against
  channel 3's 66.6 kWh on a pairing that should be comparable, and telemetry
  cannot settle whether that is a dead CT or a genuinely idle branch — it needs a
  physical check at the panel. Until it is settled, one channel of the sum is of
  unknown validity.

So treat "untracked consumption" as an upper bound on conversion loss, never as a
measurement of it, and do not tune anything against its absolute value.

---

### 3. Carbon Accounting (`computeCarbonReport`)

#### 3.1 What & why

Estimates CO₂ **avoided** by not pulling kWh from the grid, over a rolling window
and lifetime. Two "useful kWh" categories — PV-direct-to-load and
battery-discharge (mostly originally PV) — but they must not double-count PV that
cycled through the battery.

#### 3.2 Constants & formula

| Constant | Value |
|---|---|
| `DEFAULT_GRID_CO2_LB_PER_MWH` | `1100` (AZ avg; env `GRID_CO2_INTENSITY_LB_PER_MWH`) |
| `LB_PER_MWH_TO_KG_PER_KWH` | `0.4536 / 1000` |
| `KG_CO2_PER_MILE` | `0.404` (EPA avg passenger car) |
| `intensity` | `1100 · 0.0004536 ≈ 0.4990 kg/kWh` |

**Window carbon = grid you DIDN'T pull = `(load − whole-home grid)`** (v0.10.4 —
avoids the ~23 % overstatement of `pvToLoad + batteryDischarge`):

```
gridDisplacedKwh = sc.gridForKpiKwh != null ? max(0, sc.loadKwh − sc.gridForKpiKwh) : null
totalKg          = gridDisplacedKwh != null ? gridDisplacedKwh · intensity : null
pvToLoadKg       = min(sc.pvToLoadKwh · intensity, totalKg)      // capped so parts sum to total
batteryDischargeKg = max(0, totalKg − pvToLoadKg)
equivMilesNotDriven = round(totalKg / 0.404)
```

**Lifetime carbon** derives from the lifetime PV counter (unaffected by the grid
gate): `lifetimeKg = (fleet_pv_wh_live / 1000) · intensity` (lifetime PV ≈ grid
kWh avoided).

#### 3.3 Guards

- Reuses `computeSelfConsumption`'s **coverage-gated** `gridForKpiKwh`; window
  fields are **null** during the `grid_home_w` ramp (mirrors the solar-fraction
  gate) rather than overstating ~1.7×. Lifetime fields stay populated.
- Cache (`CARBON_TTL_MS = 15 min`) only latched when the fleet is **complete**
  (≥1 DPU *and* an SHP2), else the uncached zero is returned (v0.15.13).

#### 3.4 Outputs — `GET /api/carbon?days=<1..30>` (default 7, cached 60 s)

`CarbonReport`: `pvToLoadKgAvoided`, `batteryDischargeKgAvoided`,
`totalKgAvoided`, `equivMilesNotDriven` (all `null` on the ramp), plus
`lifetimePvKwh`, `lifetimeKgAvoided`, `lifetimeMilesNotDriven`,
`gridCo2IntensityKgPerKwh`. → `/api/ha-state`: `carbon_kg_avoided_7d`,
`carbon_lifetime_kg_avoided`. MQTT: `ecoflow_carbon_kg_avoided_7d`,
`ecoflow_carbon_lifetime_kg` / `_miles` (`total_increasing`).

---

### 4. TOU Tariff Cost (`computeTariffReport`, `onPeakAt`, `parseRange`)

#### 4.1 What & why

Estimates dollars actually spent on grid import **and** dollars saved (the price
you'd have paid for the load served from solar+battery), over 7 days and today,
at TOU rates.

#### 4.2 Tariff constants (all env-overridable)

| Constant | Env | Default |
|---|---|---|
| `TARIFF_FLAT_CENTS` | `TARIFF_FLAT_CENTS_PER_KWH` | `17` (flat-rate default) |
| `TARIFF_ON_PEAK_CENTS` | `TARIFF_ON_PEAK_CENTS` | = flat (17) |
| `TARIFF_OFF_PEAK_CENTS` | `TARIFF_OFF_PEAK_CENTS` | = flat (17) |
| `TARIFF_ON_PEAK_HOURS_ENV` | `TARIFF_ON_PEAK_HOURS` | `"15-20"` |
| `TARIFF_ON_PEAK_DAYS_ENV` | `TARIFF_ON_PEAK_DAYS` | `"1-5"` (Mon–Fri) |

> **v0.9.58:** defaults to a **flat** rate — the prior 25¢/8¢ split implied a TOU
> plan most APS customers lack and silently overstated both cost and solar value.
> Note: `TARIFF_ON_PEAK_CENTS` / `TARIFF_OFF_PEAK_CENTS` (and the other variables in this
> table) are environment variables, not add-on options; the add-on's run script does not
> export them. In the add-on, a TOU plan is configured with the `TARIFF_APS_*_CENTS` options
> and `TARIFF_APS_RATES_CONFIRMED` (§4.2b).
>
> The table above pins the **unconfigured-install** contract. On an install that
> has confirmed its utility's rate table, §4.2b supersedes it — do not read the
> `= flat (17)` rows as what a configured system prices at.

#### 4.2b Rate resolution — `resolveTariffCents(nowMs)` (v1.52.0)

Before v1.52.0 the cost engine and the dispatch planner each closed over their own
module constants, so a confirmed utility rate table configured for the night-charge
work priced correctly there and nowhere else. `resolveTariffCents` is the single
exported resolver both now call; it returns `{ onPeakCents, offPeakCents, basis }`
and picks the first tier that applies:

> **Superseded in part by v1.136.0.** `resolveTariffCents` returns TWO tiers, and
> both call sites used to price every hour as `onPeakAt(t) ? onPeak : offPeak`.
> APS R-EV has **four** priced periods, so every overnight kWh was billed at the
> off-peak rate — 16.91¢ instead of 12.59¢. The KPI tally and the dispatch planner
> now call `hourlyRateCents(tsMs, fallback)` and `isOnPeakHour(tsMs)`, which read
> the confirmed rate table's period for that hour and fall back to the two-tier
> answer only when no table is configured. `resolveTariffCents` remains correct
> for the two-tier fallback it describes; it is no longer the whole story for a
> configured install.

| # | Tier | `basis` | Condition |
|---|---|---|---|
| 1 | Explicit override | `'explicit-override'` | `TARIFF_ON_PEAK_CENTS` / `TARIFF_OFF_PEAK_CENTS` set |
| 2 | Confirmed seasonal utility table | `'aps_r_ev-summer'` / `'aps_r_ev-winter'` | `TARIFF_APS_RATES_CONFIRMED` true; season from `seasonAt` (tariff.ts §3) |
| 3 | Flat default | `'flat-default'` | neither of the above |

The resolved basis is published as `tariffBasis` on `/api/tariff` (§4.4) and is
shared by the dispatch planner (§5), so the two engines can no longer disagree
about what a kWh costs.

**Seasonality** is a usage-month test from the tariff model's own season
(`apsSeasonIsSummer` → `seasonAt(apsREvModelFromEnv(), nowMs)`, tariff.ts §3): the
summer table applies to usage in April through September, the winter table to
October through March — the APS billing-cycle seasons (v1.187.10; it was a separate
calendar May–October test). A plan generated in one season for a window that opens
in the next resolves at *generation* time.

★ **Edge worth knowing:** tier 1 is evaluated **per side**, as
`onOverride ?? <fallback>`. A half-set legacy override — one side configured,
the other not — is therefore honoured for the side that is set while `basis`
still reports `'flat-default'`, because the basis label is chosen by which tier
supplied the pair, not by which values ultimately won.

`onPeakAt(ts)`: `dow` mapped 1=Mon…7=Sun; both hour and day ranges support
wrap-around (`hStart > hEnd`). Returns `dayOk && hourOk`.

#### 4.3 Calculation

Prefetch each metric once for the full window at 60 s bucket, then walk **hourly**
calling `integrateWh` per hour (cuts ~960 SQL round-trips to ~5). Scope = SHP2
home DPUs only. Per hour:

```
rate  = hourlyRateCents(t, resolveTariffCents(now))/100   # v1.136.0 — the confirmed table's period for the hour; two-tier onPeakAt fallback when unconfirmed
gridWh = Σ integrateWh(ac_in_series[d], t, tEnd)            // home DPUs
loadWh = integrateWh(panel_load_series, t, tEnd)            // SHP2
if shp2 && gridHomeTrusted:  gridWh = max(gridWh, integrateWh(grid_home_w, t, tEnd))   // audit #5
gridCost  += (gridWh/1000)·rate
loadValue += (max(0, loadWh − gridWh)/1000)·rate           // v0.10.4 — value only the non-grid load
```

`gridHomeTrusted` uses the **same** coverage ≥ `GRID_HOME_MIN_COVERAGE` (0.9)
test as self-consumption. `tally()` runs for `since` (window) and `todayStart`.

> **v0.93.0 audit #5:** without the whole-home superset, an SHP2 home reported
> `gridImportCost=$0` (ac_in ~0) and credited ALL `panel_load` as solar value.

#### 4.4 Outputs — `GET /api/tariff?days=<1..30>` (default 7, cached 60 s)

`TariffReport`: `onPeakCents`, `offPeakCents`, `onPeakHours`, `onPeakDays`,
`overnightCents`, `superOffPeakCents`, `pricingBasis`, `tariffBasis`,
`gridImportCostDollars`, `solarLoadValueDollars`,
`netSavingsDollars = solarLoadValue − gridCost`, `todayGridImportCostDollars`,
`todaySolarLoadValueDollars`. → `/api/ha-state`:
`tariff_net_savings_7d_dollars`, `tariff_today_grid_cost_dollars`,
`tariff_today_solar_value_dollars`. MQTT: `ecoflow_tariff_today_cost`,
`ecoflow_tariff_today_saved`, `ecoflow_tariff_savings_7d` (unit USD).

Cache latched only when `dpus.length > 0 && shp2 != null` (v0.15.13 — `&&`, not
`||`; a boot-partial snapshot once produced net_savings −$4.36).

**The stated window and rates are the ones that price (v1.187.0, `tariffPricingView`).**
The window and cents fields come from the table the tally above is priced with, mirroring
`hourlyRateCents` / `isOnPeakHour`. With `TARIFF_APS_RATES_CONFIRMED=true` (`pricingBasis:
'rate-table'`) they are the confirmed APS R-EV model's: `onPeakHours` / `onPeakDays` from its
on-peak period (`onPeakWindowStrings`, tariff.ts: hours `start-end` local and end-exclusive,
days on the 1=Mon…7=Sun scale — `16-19`, `1-5`), and the current season's `onPeakCents`,
`offPeakCents`, `overnightCents` and (winter only) `superOffPeakCents`, each falling back to
the two-tier figure exactly where `hourlyRateCents` does (a period with no rate this season;
`overnightCents` null then). Otherwise (`pricingBasis: 'two-tier'`) the report carries the
two-tier pair and the legacy `TARIFF_ON_PEAK_HOURS` / `TARIFF_ON_PEAK_DAYS` window it is priced
with (defaults `15-20`, `1-5`), and `overnightCents` / `superOffPeakCents` are null. Before
v1.187.0 the report printed the legacy `15-20` default on a confirmed install — two hours of
"on-peak" nothing charged — and omitted the overnight rate. `tariffBasis` still names the
two-tier tier (`resolveTariffCents`, §4.2). Observed holidays (all-day off-peak in the model)
are not expressible in the window strings. The HA `tariff_on_peak_cents` /
`tariff_off_peak_cents` fields read the same values. Test: `tariffReportHonest.test.ts`.

---

### 5. Greedy Dispatch Plan (`computeDispatchPlan`) — advisory only

#### 5.1 What & why

A day-ahead, hour-by-hour **advisory** plan showing what to do with the battery
(charge from PV / discharge to load / grid-import / hold) to minimize TOU cost,
plus estimated savings vs an all-grid baseline. **Advisory only** — issues no
writes.

#### 5.2 Round-trip efficiency (v1.27.0)

Unlike the discharge-only runway sims (which use `RUNWAY_DISCHARGE_EFFICIENCY`
0.94), this planner both charges and discharges, so a **round-trip** loss
applies, split **symmetrically** across the two legs:

```
DISPATCH_ROUND_TRIP_EFFICIENCY = clamp[0.80, 1.0]( env DISPATCH_ROUND_TRIP_EFFICIENCY ?? 0.86 )
legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.927       // η_chg = η_dis; net round-trip = RTE
```

> The default is 0.86 since v1.32.0 (it was 0.945, a pack-terminal reading that
> excludes both conversion legs; the full PV/grid-in → pack → AC-out path composes
> ~0.97 × ~0.91 × 0.945 ≈ 0.83–0.86). Invariant (pinned by test): `legEff ≤
> RUNWAY_DISCHARGE_EFFICIENCY` — a round trip's per-leg efficiency never exceeds the
> measured single discharge leg.

#### 5.3 Inputs & state

From the SHP2 projection: `backupFullCapWh` → `fullKwh`, `backupRemainWh` →
`socKwh`, `backupReserveSoc` → `reservePct` (default 15). Returns `empty()` if
either capacity or remaining is null. `reserveKwh = fullKwh·reservePct/100`;
`targetPrePeakSocPct = 80` → `targetPrePeakKwh`. PV/load come from the day-ahead
`forecast.hours` (`forecastPvW`, `forecastLoadW`).

#### 5.4 Per-hour greedy branches

```
if pvKwh > loadKwh:                              // surplus PV → charge
    surplus = pvKwh − loadKwh;  room = fullKwh − socKwh
    stored  = min(surplus·legEff, room)          // pack GAINS legEff of PV surplus
    socKwh += stored;  flow = stored/legEff;  action = charge_from_pv
else:                                            // deficit
    deficit = loadKwh − pvKwh;  drawn = deficit/legEff   // pack DRAWS deficit/legEff
    if onPeak && socKwh − drawn ≥ reserveKwh:    action = discharge_to_load (saves most $)
    elif topOff[i] && socKwh < targetPrePeakKwh: // off-peak top-off before peak (v1.187.10)
        need = min(deficit + (targetPrePeakKwh − socKwh)·0.1, deficit + 1)
        hourlyCost = need·rate;  action = grid_import
        socKwh = min(fullKwh, socKwh + (need − deficit)·legEff)
    elif socKwh − drawn ≥ reserveKwh:            action = discharge_to_load
    else:                                        action = grid_import (forced; battery at reserve)
allGridCost += loadKwh·rate;  plannedCost += hourlyCost
```

The **reserve guard** always tests the *drawn* amount (`socKwh − drawn ≥
reserveKwh`) so a discharge can never dip the pack below reserve.

**The top-off hours** (v1.187.10, `dispatchTopOffHours`): an off-peak hour may top
off only when an on-peak hour lies later in the horizon, and only at the cheapest
rate of the off-peak run before that on-peak hour (from the previous on-peak hour or
the horizon start); a run with no on-peak after it inside the horizon never tops off.
Before v1.187.10 every off-peak deficit hour below the 80% target imported. On a
weekend — APS R-EV has no on-peak and no overnight tier — the 2026-10-03 plan
imported for 12 h at 16.91¢ with the pack at 76–79% ($6.55, "savings" $6.20) while
Sunday PV later filled it to 100% and the night-charge engine bought nothing; a
weekday evening imported 19:00–23:00 at 16.91¢ ahead of the 12.59¢ overnight tier.
On an unconfirmed table every off-peak hour carries the same fallback rate, so every
off-peak hour ahead of an on-peak hour qualifies. The 80% target and the
`min(deficit + 10% of the gap, deficit + 1 kWh)` top-off size are unchanged. Tests:
`dispatchTopOff.test.ts`.

#### 5.5 Outputs — `GET /api/dispatch-plan` (cached 60 s at the route; 30 min engine)

`DispatchPlan`: `horizon`, `hours[]` (`{ts, pvW, loadW, socStartPct, socEndPct,
onPeak, action, flowW, hourlyCostDollars}`),
`estimatedSavingsDollars = allGridCost − plannedCost`, `targetPrePeakSocPct`
(80). Route: `computeDispatchPlan(store.get().devices, forecast)`. Returns
`empty()` when no forecast or no SHP2 capacity.

---

### 6. MPC Dispatch Recommender (`server/src/dispatch/mpc.ts::recommendDispatch`)

#### 6.1 What & why

A **discrete dynamic-programming** optimizer (Track B, v0.9.27) that produces a
recommended 24-hour reserve-setpoint + battery-flow schedule minimizing a cost
function trading grid-import $, cycling-degradation $, and reserve-dip risk.
**Recommend-only** — issues no writes; scored against a do-nothing baseline.

#### 6.2 State, actions, cost

- **State:** `(hour, SoC bucket)` over `SOC_BUCKETS` = `0,5,…,100` (21 buckets),
  horizon `H = 24`. `nearestBucket(soc) = round(soc/5)·5`.
- **Actions** (6): `lower` (Δreserve −10), `maintain` (0), `raise` (+15),
  `dischargeMax` (flow −MAX_C_RATE), `chargeFromGrid` (flow +MAX_C_RATE),
  `idleHold` (0). The DP-allowable reserve is floored at the operator's real
  `reserveFloorPct` and capped at 50 (**v0.93.0 audit #12** — the legacy `lower`
  action could otherwise drive reserve to 0 and the planner would recommend
  emptying the battery with no penalty).
- **`simulateHour`** enforces the balance
  `PV + grid_import + batt_discharge = load + batt_charge + grid_export` with
  three flow modes (charge-from-grid / discharge-max / passive), C-rate cap
  (`maxFlowKwh = MAX_C_RATE·capacity`), reserve headroom, and physical SoC
  bounds. Cost per hour:
  ```
  gridKwh·tariff − exportKwh·exportTariff + cycleKwh·cyclingCost + dipPenalty
  cycleKwh = charge + discharge   // round-trips penalized twice (correct)
  dipPenalty = max(0, reserveEnergy − endEnergy)·reserveDipPenalty
  ```
- **Risk-averse branch:** inside an on-peak window (tariff > median+2¢) or one
  imminent within 3 h, the DP uses the **P10** PV forecast (pessimistic) when
  sizing; the public per-hour view re-simulates on **P50**.
- Forward pass fills `dp[h+1][endBucket]` with the min-cost parent; back-walk
  from the cheapest `dp[H]` endpoint reconstructs the schedule; a separate
  baseline (always `maintain` at current floor, no arbitrage flow) gives
  `savingsVsBaselineUsd = baselineCost − optimizedCost`.

#### 6.3 Constants (env-overridable)

| Constant | Env | Default |
|---|---|---|
| `TARIFF_FALLBACK_CENTS` | `TARIFF_FLAT_CENTS_PER_KWH` | 17 |
| `ROUND_TRIP_EFFICIENCY` | `MPC_ROUND_TRIP_EFFICIENCY` | 0.9 *(declared; surfaced in `notes` — the energy balance is modeled directly in `simulateHour`, not via this scalar)* |
| `MAX_C_RATE` | `MPC_MAX_C_RATE` | 0.25 (frac of pool/hour) |
| `EXPORT_TARIFF_CENTS` | `TARIFF_EXPORT_CENTS_PER_KWH` | 0 (no net-metering) |

#### 6.4 Degrade detection

`detectDegradeReason` returns `'no-tou-spread'` (tariff max−min < 1¢/kWh) or
`'flat-forecast'` (PV & load range < 5 % of mean) — the DP still runs (callers
want the shape) but `expectedSavingsUsd` is zeroed.

#### 6.5 Endpoint — `GET /api/dispatch/recommend` (cached 300 s)

Returns `503 {error:'SHP2 not online'}` if no SHP2, and (v1.187.18) `503 {error:'backup pool
unknown'}` when `mpcPoolBasis` (`dispatch/mpc.ts`) returns null: `backupFullCapWh` missing, not
finite or ≤ 0, or `backupBatPercent` missing, not finite or outside 0–100 (0 % is valid). Before
v1.187.18 the route substituted a 60 kWh pool at 50 % and served that plan with a 200. Inputs
assembled in `index.ts`: `currentSocPct` and `capacityKwh` from `mpcPoolBasis` (no substitute
values), `reserveFloorPct = backupReserveSoc??20`, per-hour
`pvP50`/`pvP10` (from forecast + probabilistic bands), `loadForecast`,
`tariffByHour` (`hourlyRateCents` for each hour of the local America/Phoenix day, falling back to the two-tier pair `TARIFF_ON_PEAK_CENTS_PER_KWH` / `TARIFF_OFF_PEAK_CENTS_PER_KWH`, default the flat rate, when the rate table is unconfirmed; v1.136.0), and **`gridAvailable = process.env.GRID_AVAILABLE
=== 'true'`** (default **false** — v0.15.2 off-grid honesty: a hardcoded `true`
let the optimizer "assume away" reserve dips via imports that don't physically
exist on an islanded site). `cyclingCostUsdPerKwh` is fed **live** from RTE:
`baseWear (CYCLING_BASE_WEAR_USD_PER_KWH, 0.015) + (1−effFrac)·(flatCents/100)`,
fallback 0.02. Response = `{ inputs, ...MpcResult }` where `MpcResult` carries
`steps[]`, `totalCostUsd`, `costBreakdown`, `savingsVsBaselineUsd`,
`expectedSavingsUsd`, `setpointSchedule[]`, `degradeReason`, `notes[]`.

---

### 7. Inverter Clipping (`computeClipping`)

#### 7.1 What & why

Detects PV **lost to the inverter hardware ceiling**: the array wanted to produce
more than the MPPT/inverter could pass, so the excess was clipped. (Contrast §8
curtailment, the opposite — batteries full.)

#### 7.2 Inputs, constants

| Item | Value / source |
|---|---|
| `pv_total` per home DPU (today) | recorder, 60 s bucket → per-hour buckets |
| GHI per hour | `getWeather()` (Open-Meteo, cached) |
| Solar model | `forecast.restoredSolarModel ?? forecast.solarModel` (`hourly[hod].coeff`, `observedMaxPvW`) |
| `arrayPeakW` | `max(observedMaxPvW over hours)` |
| `CLIPPING_PEAK_FRAC` | `0.95` ("at peak" ≥ 0.95·arrayPeak) |
| `DAYLIGHT_GHI` | `20` W/m² |
| `CLIPPING_TTL_MS` | `5 min` |

Scope = SHP2-connected home cores **plus** cloud-wedged connected SNs (v0.78.0
display-basis restore), read straight from each SN's own recorded `pv_total`
(anti-fabrication).

#### 7.3 Per-hour calculation

```
observedW = Σ mean(pv_total bucket[h]) over clippingSns    // skip empty buckets
modelW    = (wx.radiationWm2 > DAYLIGHT_GHI && coeff!=null) ? coeff·radiationWm2 : null
atPeak    = observedW ≥ CLIPPING_PEAK_FRAC·arrayPeakW
if atPeak && modelW!=null && modelW>observedW:
    clippedW    = modelW − observedW
    clippedKwh += (clippedW/1000)·elapsedHrs     // current partial hour weighted
```

`nowMs` is an injectable clock for the elapsed-hour/local-day determination only;
cache freshness stays on the real wall clock (v0.99.0). Returns `empty()` on no
forecast / no DPUs / `arrayPeakW ≤ 0` / no weather.

#### 7.4 Outputs — `GET /api/clipping` (cached 60 s)

`ClippingEstimate`: `todayKwh`, `perHour[] ({hour, observedW, modelW, clippedW})`,
`arrayPeakW`, `hoursAtPeak`. → `/api/ha-state`: `pv_clipped_kwh_today`
(=`todayKwh`). MQTT: `ecoflow_pv_clipped_kwh_today`
(`device_class: energy`, `state_class: total` with `last_reset` — v1.187.10, see the
curtailment figure below), `ecoflow_pv_array_peak_watts` (diagnostic).

---

### 8. SoC-Saturation Curtailment (`computeCurtailment`)

#### 8.1 What & why

Detects PV **rejected at the array because there's nowhere for it to go** —
batteries at/near their charge ceiling and home load low, so the DPUs throttle
their MPPTs to match `(load + standby)`. The curtailed watts are never directly
observed; they're inferred as `expectedPV − actualPV`.

#### 8.2 Signal chain & guards

`predictExpectedPv` uses the **Bayesian** solar model
(`computeBayesianSolarModel`) posterior `μ[hour]·GHI` (requires ≥
`CURTAIL_MIN_BAYES_SAMPLES = 3` samples). Curtailment is called active when, for
the current hour, **all** hold:

| Guard | Constant |
|---|---|
| SoC ≥ saturation threshold | `saturationThresholdPct(ceiling)` = `(ceiling or 100) − CURTAIL_TAPER_BAND_PCT(10)` (`chargeTaper.ts`, shared with the mid-day charge ceiling) |
| PV actually producing | `CURTAIL_MIN_PV_W = 200` |
| meaningful gap (expected − actual) | `CURTAIL_MIN_SURPLUS_W = 300` |
| daylight | `CURTAIL_MIN_GHI_WM2 = 100` |
| posterior support | `CURTAIL_MIN_BAYES_SAMPLES = 3` |
| PV matched to load (not bulk-charge) | PV ≤ load·`CURTAIL_PV_MATCH_LOAD_FACTOR(2.0)` |
| load measured (v1.188.1) | the hour has a `panel_load` sample |

**A missing load is unknown, not 0 W (v1.188.1).** `sampleCurtailmentHour` does not count an hour
with no `panel_load` sample. Since the freshness gate (architecture chapter, section 4.3) a panel the
EcoFlow cloud lists offline, or whose shadow is latched, writes no rows while the Cores keep
streaming. Read as 0 W, the missing load skipped the weather-verified PV-exceeds-load disqualifier,
so an hour of a full pool and a held panel was counted as curtailed and could be frozen into its day.

> **v0.9.78/79 taper insight:** the "battery full" threshold is **not** a fixed
> 96 %. DPUs charge to a *configured* `chgMaxSoc` (Storm Guard raises it to 100),
> and real PV rejection begins in the CV/absorption **taper ~10 % below** the
> ceiling, not at it — hence `ceiling − 10`. `homeChargeCeilingPct` = **mean**
> `chgMaxSoc` across home DPUs (mean, not min: the pool is saturated only when the
> average has reached the average ceiling).

`inactiveReason` enumerates why it's *not* firing: `soc-too-low` | `pv-too-low` |
`no-daylight` | `no-model` | `small-gap` | `pv-exceeds-load` | `no-shp2` |
`no-home-dpus`.

#### 8.3 History & outputs — `GET /api/curtailment` (cached 60 s route; `CURTAIL_TTL_MS = 5 min` engine)

`today` walks past hours with weather and is always live; `recent7d`
(`CURTAIL_HISTORY_DAYS = 7`) covers the 7 finished local days before today. An hour is
weather-verified when the analytics worker's own Open-Meteo cache (`past_days=7`, UTC days)
holds it with GHI ≥ `CURTAIL_MIN_GHI_WM2` and the posterior has support; any other hour takes
the heuristic path. **Frozen days (v1.186.1, `curtailmentFreeze.ts`).** A finished day is
walked only until it *settles*: the weather in hand was fetched at least
`CURTAIL_SETTLE_LAG_MS` (12 h) after the day ended, so none of its hours is a forecast value
and the provider's past-hour revisions are done (past hours are stitched from each model run's
first hours; the slowest listed model is ingested ~7.2 h after initialisation); every hour of
the day is in that cache with a value the provider sent (no `radiationMissing`); and a posterior
exists. The walk that first finds a day settled freezes its kWh and curtailed hours (hour of day,
surplus W); from then on `recent7dKwh`, `recent7dHoursCount` and `hourlyHistogram` read the
frozen record, whatever the posterior or the weather cache later says. A stale cache (every
fetch failing) keeps its old `fetchedAt`, so the days after it stay live. Frozen days persist in
`curtailment-days.json` next to the database (atomic; `CURTAILMENT_DAYS_PATH` overrides; memory
only outside the add-on) and are pruned once they leave the window, so the figure changes
between midnights only while an unsettled day is still being estimated, and by one step at local
midnight when the window slides. `CurtailmentReport` fields: `active`, `currentSurplusW`,
`current{socAvg, pvActualW, pvExpectedW, loadW, ghiWm2, bayesianSamples,
chargeCeilingPct, saturationThresholdPct}`, `inactiveReason`, `todayKwh`,
`todayHours[]`, `recent7dKwh`, `recent7dHoursCount`, `recent7dSettledDays` (days read
frozen), `hourlyHistogram[]` (hour-of-day siting for opportunistic loads), and `opportunisticLoads[]` (static
Phoenix-home suggestions — pool pump 1800 W, dehumidifier 700 W, AC pre-cool
3500 W, water heater 4500 W, EV full-rate 7200 W — each with `fitsInSurplus`).
`computeCurtailmentAlerts` wraps this for the alert monitor.

→ `/api/ha-state`: `pv_curtailment_active`, `pv_curtailment_kwh_today`
(=`todayKwh`). MQTT: `ecoflow_pv_curtailment_active` (binary — ON means "we are
curtailing", not power-present), `ecoflow_pv_curtailment_surplus_watts`,
`ecoflow_pv_curtailment_kwh_today` (`device_class: energy`, `state_class: total` with
`last_reset`), `ecoflow_pv_curtailment_kwh_7d`, `ecoflow_charge_ceiling` (diagnostic).
**v1.187.10:** today's curtailed and clipped kWh are re-estimated on every walk (each hour
of today re-walked on the current posterior and weather cache, the partial hour included),
so they go down as well as up; on 2026-10-02 PV Curtailed Today read 3.54 → 3.03 kWh after
curtailment had ended, then 3.79. As `total_increasing`, Home Assistant reads a drop of
10 % or more as a meter reset and counts the day again, and a smaller one as a negative
delta. Both are now `state_class: total` with `last_reset_value_template` on
`pv_curtailment_kwh_today_since` / `pv_clipped_kwh_today_since` (also on `/api/ha-state`):
the local midnight that starts the day the report covers, ISO 8601, taken from the report's
`generatedAt` (`dailyFigureResetIso`), never the publish clock, so a report from before
midnight republished after it keeps its own day. A revision is then a correction, and only
a new day is a reset. Neither carries `expire_after`. The table audit
(`auditDiscoveryTables`, rule `daily-figure-needs-total-with-reset`) refuses a `_today`
figure declared `total_increasing`, or `total` without a `last_reset_value_template`.
Upgrade effect: the existing statistics rows carry no `last_reset`, and the first state after
the update carries the day's midnight, which Home Assistant's statistics compiler treats as a
new cycle — so the long-term sum may count the update day's value up to the update a second
time, once (not verified against Home Assistant).

---

### 9. Cross-cutting: conservation, caching, honest-null

- **Energy conservation.** The self-consumption decomposition is internally
  consistent: `pvKwh = pvToLoadKwh + pvToBatteryKwh` and
  `gridForKpiKwh = gridToBatteryKwh + (load served by grid)`; carbon's
  `pvToLoadKg + batteryDischargeKg = totalKg` by the capping construction.
- **One grid gate, three consumers.** Self-consumption, carbon, and tariff all
  gate the whole-home grid term on `coverageMs(grid_home_w) /
  coverageMs(panel_load) ≥ GRID_HOME_MIN_COVERAGE (0.9)`. Below it they publish
  `null` (KPIs) or fall back to `ac_in` (tariff) rather than a wrong number.
- **Cache TTLs:** self-consumption 15 min, carbon 15 min (reuses warm
  self-consumption), tariff 15 min, dispatch-plan 30 min, clipping 5 min,
  curtailment 5 min; every route additionally wraps `cached(...)` with a
  hash-etag + short `Cache-Control` (60 s typical; lifetime-energy 15 s;
  dispatch/recommend 300 s).
- **No poison-cache of zeros.** All device-integrating engines require a
  *structurally complete* fleet (≥1 DPU **and** the SHP2) before latching, so a
  post-restart boot-partial snapshot is returned once but never cached.
  Since v1.178.0 the carbon, tariff and curtailment reports also carry
  `basisComplete`:
  - carbon: a DPU and the panel are projected;
  - tariff: DPUs, plus the panel unless none is listed;
  - curtailment: home Cores, the panel, weather and a solar posterior.
  While it is false the HA publishers send the governed fields as null
  (`publishReadiness`):
  - `carbon_kg_avoided_7d`;
  - the three `tariff_*_dollars` figures;
  - `pv_curtailment_active` / `_surplus_watts` / `_kwh_today` / `_kwh_7d`.
  A model-less boot 0 therefore never reaches a sensor.
- **Advisory ≠ control.** `computeDispatchPlan` and `recommendDispatch` are both
  recommend-only and touch no safety alarm or device write.

### 10. On-peak grid-to-battery detection (`server/src/peakGridDraw.ts`)

**v1.80.0 — the cause is read, not inferred.** `ch{n}ForceCharge` (PD303 quota)
is the per-channel force-charge switch = the app's "Charge Now". The verdict
carries `forceChargeOn` (labels with FORCE_CHARGE_ON, `[]` = all off, `null` =
not reported → the inference wording remains as fallback). Slot → Core naming
via `Shp2EnergySource.sn` against the device roster.

Detects the plant importing grid energy **into the battery** during the tariff's
on-peak window — energy the overnight charge window buys at a fraction of the price.

**Derivation.** The grid only has to cover what PV does not:

```
gridToBatteryW = max(0, gridImportW - max(0, panelLoadW - pvW))
```

Inputs come from `aggregateFleetFlow(devices)` (`acIn`, `panelLoad`, `fleetPv`) — the
same aggregation the dashboard renders — and SoC/reserve from `findShp2().projection`
(`backupBatPercent`, `strategy.backupReserveSoc`).

> **Basis caveat (documented, not incidental).** This subtracts an SHP2-measured house
> load from a DPU-measured grid import. Those are different meters, and this codebase
> has previously been bitten by treating `fleet_grid_import_wh` (DPU `ac_in`) and
> `fleet_grid_home_wh` (SHP2 `gridWatt`) as interchangeable. The residual therefore
> carries both meters' error, which is why `minChargeW` sits well above nuisance level.
> This is a "several kW of deliberate charging" detector, **not** an energy-balance
> instrument, and must not be repurposed as one.

**Tariff source.** `apsREvModelFromEnv()` in `tariff.ts` — the single model shared with
`index.ts`, so no second reader can drift on when on-peak begins. On-peak resolves via
`rateAt(model, ts).isOnPeak` (APS R-EV: 16:00–19:00 local, Mon–Fri, year-round).

**Suppression conditions** (`PeakDrawVerdict.suppressed`), each a deliberate silence:

| Value | Meaning |
|---|---|
| `outage` | `gridPresent` false — there is nothing to buy |
| `off-peak` | Charging then is the desired behaviour |
| `insufficient-data` | Any of import / load / PV is null — no verdict is fabricated |
| `below-reserve` | SoC ≤ reserve + `reserveHeadroomPct` — **see below** |

> **The below-reserve guard is a safety property, not a tuning choice.** At or near the
> reserve, buying on-peak is *correct*: the plant is restoring its own outage protection,
> which outranks the bill. An alert in that state would be advising the operator to trade
> away outage margin for money. Removing this guard makes the detector strictly more
> sensitive and is therefore invisible in review — it is covered by mutant `iii` of the
> committed harness for exactly that reason.

**Against the owner's floor while a night-charge restore has not taken (heldByChargeWrite).**
The guard protects the owner's floor. A night-charge restore that did not take leaves the
night's target (50%) as the panel's reserve, and a pool refilling to it at the on-peak rate
then reads "near the reserve". While a write of ours is past its restore with the restore not
read back (`chargeWriteHold`, published by the actuator) and the panel still reads exactly its
target, `moneyDetectorReservePct` hands this detector and the idle-pool detector below the
prior floor, and each alert names the reserve the panel reads and the one to restore
(`heldByChargeWriteText`). It applies only once the restore has had its readback grace
(`heldFromMs`: 5 minutes after the restore was accepted, or after it fell due while none has
been), so a restore that goes to plan, whose panel echoes the old value for a minute after
05:00, never engages it. The runway and below-reserve alarms keep the live value.

**Tuning** (env, all with defaults — no add-on config option):

| Env | Default | Purpose |
|---|---|---|
| `PEAK_DRAW_MIN_CHARGE_W` | `800` | Floor below which the residual is meter noise |
| `PEAK_DRAW_DWELL_MS` | `600000` | Hold time before alerting (a load step is not a buying pattern) |
| `PEAK_DRAW_RESERVE_HEADROOM_PCT` | `10` | Band above the reserve still treated as outage preparation |

**Entry point.** `evaluatePeakDraw(inputs, tariff, cfg)` is the only call sites should
use. Assessing needs an onset, but whether the condition holds is known only *from* an
assessment; `evaluatePeakDraw` resolves that internally (probe → `trackOnset` → assess).
A caller that instead passed `onsetMs: null` each tick would leave the dwell permanently
unmet and the alert permanently silent, with every unit test still green — mutant `xii`.

**Alert.** Id `peak-grid-draw`, severity `warning`, category `Grid`, priority `low`.
Deliberately below every physical-risk condition: this reports spend, not danger, and
placing money in the critical tier devalues the tier that must never be discounted. Cost
is emitted as `null` — never a guess — when `ratesConfirmed` is false. The cost is the
on-peak spend rate, `centsPerHour` = kW into the pack × the current period's rate, and the
detail states it as that ("about $X per hour"); until v1.187.22 it was worded as the premium
over buying the same energy overnight, which nothing subtracts.

**Causing setting: "Charge Now", which is PER-DPU.** Enabled on individual Delta Pro
Ultra units in the EcoFlow app, which is why the observed draw reached ~16 kW — several
Cores charging at once, not one panel-level decision.

> **Corrected in v1.71.0.** v1.70.0 attributed this to `smartBackupMode: 2` on the SHP2.
> That was wrong. When Charge Now was switched off, grid import fell 16.6 kW → 0 W while
> `smartBackupMode` stayed at `2` and every other field in the SHP2 strategy blob was
> byte-identical. The setting is not on the panel.

**Detection is a power residual; the cause is read when reported.** The detector fires on
the measured residual. Since v1.80.0, the panel quota's per-channel `ch{n}ForceCharge`
(Charge Now) is read into `forceChargeOn`:
- named channels: the alert names the units with Charge Now on;
- `[]`: it says Charge Now reads off on all channels and points to another setting;
- `null` (not reported this tick): it falls back to the inferred wording (`forceChargeText`).

**Per-Core attribution.** `attributeCores(draws)` names the units actually drawing,
largest first, from each DPU's `acInWatts` (the same field `aggregateFleetFlow` sums into
`acIn`, so parts reconcile with the total). Cores below `CORE_ATTRIBUTION_MIN_W` (500 W)
are standby and are not named; when none qualify the fact reads `no single Core dominant`.

**Proof.** `scripts/mutate-peak-grid-draw.mjs`, 15 anchor-asserted mutants, 15/15 killed.

#### 10.1 On-peak grid while the house pool sits idle (`peakGridDraw.ts`, v1.187.0)

The detector above watches grid flowing **into** the pack. It cannot see the opposite
waste: the grid carrying the house on-peak while the pool, well above its reserve, does
nothing. On Mon 2026-09-28 the house bought 4.27 kWh at 44.2¢ (16:00–19:00) with the pool
at 26% against a 16% reserve and every SHP2 channel at 0 W. The measured cause is the
panel's **re-entry band**: after the pool stops at its reserve, the SHP2 resumes discharging
only once the pool has climbed back roughly 20 points above it (36–38% against 16 on
2026-09-13, 09-14 and 09-27); a pool that refills only part of the way on solar holds in
between.

**Condition** (`classifyIdlePool`, one tick, pure): grid present; `rateAt(model, now).isOnPeak`;
the house panel's reading live (`deviceEvidencePositive`); SHP2 `gridWatt` ≥
`IDLE_MIN_IMPORT_W` (300 W); the pool idle — Σ|`sourceWatts`| (per-channel `chWatt`: negative
discharging, positive charging) ≤ `IDLE_MAX_POOL_FLOW_W` (150 W); and SoC above
`strategy.backupReserveSoc + IDLE_HEADROOM_PCT` (5). Suppressions: `outage`, `off-peak`,
`insufficient-data`, `near-reserve`, `pool-active`, `low-import`, `fired-today`.

> **The near-reserve band is a safety property.** At or within 5 points of the reserve a
> held pool is the panel defending the owner's floor; advising otherwise would be advising
> to spend outage margin — the same reason as the grid-to-battery detector's below-reserve
> band. Mutant `xxii` of `scripts/mutate-v1187-d.mjs`.

**Episode** (`stepIdlePool`, pure): active after `IDLE_DWELL_MS` (10 min) of continuous
holding; an active episode ends at once when on-peak ends or the grid goes, otherwise only
after the condition has been absent for `IDLE_CLEAR_MS` (10 min), so a load dip is not a
resolution; at most **one episode per on-peak day** (the local date it rose). The episode is
in memory, but the day it rose is not: the monitor restores it at start-up from
`idle-pool-state.json` beside the database (`IDLE_POOL_STATE_PATH` overrides;
`loadIdlePoolFiredDay` / `restoreIdlePoolFiredDay`) and writes it whenever it changes
(`persistIdlePoolFiredDay`), so a restart inside an on-peak afternoon re-earns the dwell but
cannot push the notice a second time that day. A missing or malformed file restores nothing. The
day is written on the tick the notice rises, so a restart inside the push debounce that follows
(about a minute) loses that day's notice. The wiring is pinned by running the real monitor twice
on the same state files (`peakIdlePoolRestart.test.ts`).
Because the episode is not carried, the boot orphan sweep (`orphanedNotifiedIds`) **drops** a
pushed `peak-idle-pool` record without a "Resolved:", as it does `msg-rate-floor-`: ten minutes
after an auto-update the id is absent while the house may still be buying on-peak, and there is
no evidence the condition ended. The card then stands until the next notice (same id, updated in
place) or a manual dismissal.

**Alert.** Id `peak-idle-pool`, severity `warning` (so it pushes), priority `low`, category
`Grid`; the detail names the pool, the reserve, the kWh held above it, the import and its
on-peak cost per hour, describes the re-entry band, and says the add-on changes no setting.
The kWh held above the reserve is (SoC − reserve)% of the pool's **measured** capacity, the
capacity the panel's percent is a share of (v1.187.19): the day forecast's `poolFullWh`
(`backupFullCapWh × poolCapacityScale`, §5.1.3a), which the monitor reads from its forecast
feed each pass and hands `idlePoolInputsFrom` together with the forecast's own
`poolCapacityBasis`. The forecast's figure counts as measured only when that basis is `measured`,
`held` or `min-known` (an allowlist, §5.1.3a); with basis `nameplate` — no Core capacity ratio
ever measured, as on a fresh install or with packs that never report `fullCapMah`/`designCapMah`
— the forecast's figure is the nameplate itself, and a forecast with no basis vouches for nothing.
The forecast can be up to its day TTL old, and the worker resets its report caches when a Core
joins the pool but not when one leaves, so a measured figure is also taken only while it lies
between `CAPACITY_SCALE_MIN` (0.8) and 1 × the panel's live nameplate: outside that band it
describes a different pool. Only when no measured capacity is available — no forecast delivered
yet after a start, one with no pool, one whose basis is not a measured one, or one outside the
live-pool band — is the panel's nameplate `backupFullCapWh`
used, and the alert then names it: "(about 9.2 kWh above it on the nameplate capacity)", and the
card's *Above reserve* fact "9.2 kWh (nameplate capacity)" (`poolCapacityBasis` on the inputs and
the verdict). Until v1.187.23 the figure was always on the nameplate, high by
the packs' whole measured fade (~6% at a 0.944 scale). Pinned through the real monitor in
`peakIdlePoolMeasuredCapacity.test.ts`.
**Never audible**: the alert carries `audible: false`, which is what keeps it off the speakers —
`speakableAlerts` (broadcast.ts) drops it from the array the condition count and the spoken
message are both built from, and `pickPrimaryAlert` refuses it, so it neither raises the chime
nor becomes the alert a yellow raised by another warning names aloud. (Until the v1.187.0 log
review only the id exclusion in `conditionFromAlerts` applied: it kept the notice out of the
count, but when the alarm host running hot raised a yellow on an on-peak afternoon this
unlocated Grid notice outranked that Connectivity warning and was the alert voiced.) The id
exclusion stays as a second guard. The card and the `[Low]` push remain (`risingEdgePushes`
reads `annunciate` only). A device-derived family (`DEVICE_ALERT_ID_PREFIXES`).
No device write. On a multi-panel plant it reads the house panel only: the inputs are
assembled by `idlePoolInputsFrom` (alertMonitor.ts) from `findShp2`, and `fresh` is
`deviceEvidencePositive` on that panel — a cloud-dark panel's kept projection is never read
as an idle pool.

**Counts like the grid-to-battery notice.** It carries no `source`, so while active it counts
in the HA `alert_warning_count` (**Warning Alerts**, `makeAlertCounter`) and — through its
explicit priority — `alert_low_count` (**Low Priority Alarms (P4)**), exactly as
`peak-grid-draw` (§7.10, also warning / low) does, and the warning-tier auto-tune rules apply
to it (it is not an `ENERGY_STATE_FAMILIES` member). An automation keyed to
`alert_warning_count` therefore sees an on-peak spend notice as one warning; the priority
counts place it in P4. Tests: `peakIdlePool.test.ts`.


---

