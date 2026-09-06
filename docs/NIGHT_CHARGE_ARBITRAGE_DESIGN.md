# Night-Charge TOU Arbitrage — Design & As-Built

_Originated 2026-07-17 as a design plan (12-agent design dive + 4-agent APS-EV/EcoFlow verification), implemented v1.36.0–v1.51.0, amended 2026-07-31. **Rewritten 2026-09-06 against the shipped system at v1.133.1.**_

**This document previously described a plan. It now describes what runs.** The 2026-08-01 revision had accumulated two "superseded" section headers over sections left otherwise intact, and eighty-two releases had landed on top of it — including the entire supervised write path, EV contention, readback verification on both the apply and revert legs, the cushion re-scope, and cost mode, none of which appeared anywhere in it. §6 in particular still described the write path as "dormant, toggle-ready, deferred" while it had been live and actuating nightly for five weeks. A reader trusting that section would have concluded the system never touches the hardware.

The design rationale is preserved wherever it is still load-bearing, because the *reasons* for the constraints outlived the plan. Where a decision was later reversed, the reversal is stated with its cause rather than the original quietly deleted — a design record that hides its own corrections cannot be audited.

**Citations are by function and file**, not line number. The previous revision cited ~40 line numbers; most had drifted, and a stale line number reads as precision while pointing at nothing.

---

## 0. Status at a glance

| | |
|---|---|
| Posture | `NIGHT_CHARGE_MODE = supervised` (live). `advisory` is the default and writes nothing; `auto` is structurally demoted until the gate graduates |
| Writes | **One** field, `backupReserveSoc`, once per charge night, auto-reverted |
| Write envelope | **`[10, 50]` percent** — `RESERVE_WRITE_MIN_PCT` / `RESERVE_WRITE_MAX_PCT` |
| Objective | `ARB_OBJECTIVE = cost` (live). **Cost mode is rate-blind** — see §3.1 |
| Actuated nights | 11 scored |
| Gate | `LEARNING`, `writeReady = false`, and **structurally unable to open** on current inputs — §7 |
| Tariff | APS R-EV, rates **CONFIRMED** (no longer placeholders) |

---

## 1. Posture — what writes, and what bounds it

**The feature is a subordinate of the safety spine, never a peer.** This is the one premise that has survived every revision unchanged. The two independent alarms — runway (`classifyRunway`, `runwayAlarm.ts`) and SHP2 floor/SoC (`shp2-below-reserve`, `batterySocAlarm.ts`) — plus outage fusion (`resolveGridBackstop`, `gridState.ts`) remain the safety authority. The advisor only *reads* the projections those alarms read; it never produces state they depend on.

### 1.1 The mode ladder

- **`advisory`** (default) — computes, announces, records. Writes nothing, ever.
- **`supervised`** (live, explicit owner opt-in) — one announced, cancellable, bounded, auto-reverting write per charge night.
- **`auto`** — honoured as unattended only once the gate graduates. `effectiveActuationMode` structurally demotes it to supervised semantics until then, so any future auto-only relaxation must branch on the *demoted* mode, never the raw config value.

### 1.2 The write envelope is the ceiling on everything

The only actuation is `setBackupReserveSoc`, and the device accepts a backup reserve **only in `[10, 50]` percent**. That bound is enforced twice: `clampReserveTarget` in `nightChargeActuator.ts`, and `setBackupReserveSoc`'s own range check in `ecoflow/commands.ts`, which refuses out-of-range *before any network call*.

Until v1.133.1 this was a bare `50` in both places. Nothing in the codebase said out loud that it caps everything the engine can achieve — which is how `ARB_COST_MAX_SOC_PCT` came to ship with schema `int(50,100)`, **a minimum equal to the write maximum**, so every legal value produced the same instruction. It is now named (`RESERVE_WRITE_MIN_PCT` / `RESERVE_WRITE_MAX_PCT`) and anything reporting a reserve figure reconciles against it.

Two consequences worth stating plainly:

- **Charge power binds before the clamp does.** A six-hour weeknight tops out near 60% SoC even with the clamp removed, so a 90% target is unreachable by two independent limits.
- **There is no force-charge path.** `setChannelForceCharge` exists and is symmetric, but its only caller passes `on: false`. Reaching above the reserve ceiling would need an unproven write pair against a live panel.

### 1.3 Why the reserve raise — the banned mechanism — became the shipped one

The original design **banned** `backupReserveSoc` as the charge lever (Invariant I1) and mandated the device-native `CHARGE_TIME_TASK` instead. Both halves of that reasoning failed in operation, and the reversal is instructive:

- `CHARGE_TIME_TASK` was **never probe-proven**. The design said "if it cannot be probe-proven, the feature is advisory-forever — there is no reserve-raise fallback." It could not be, and that clause would have killed the feature.
- The bounded reserve raise turned out to be the only documented, round-trip-verified write shape available (`PD303_APP_SET`/`backupReserveSoc`, exercised as a no-op by the cloud-presence refresh since v0.9.10).

**The original objections were real and are answered by mechanism, not by dismissal:**

| Original objection | How the shipped design answers it |
|---|---|
| Alarm coupling — `backupReserveSoc` is read live as the reserve floor at ~8 sites | The write is **bounded and auto-reverting**, not a persistent decoupling shim. No holder, no `effectiveReserveFloorPct()`, no surgery on the spine |
| Power-cycle coupling — a restart mid-boost strands the elevated reserve | **Write-ahead intent journalling** to a restart-surviving state file, plus lost-confirmation **adoption** from the live readback (§4.2) |
| An outage during the raise defends a high floor through the outage | The **grid-loss abort** (§4.5) restores the true floor immediately on `gridPresent === false` |
| The verify primitive re-sends the *current projected* value and would fight the boost | Verification is a **readback comparison**, not a re-send (§4.3) |

---

## 2. Tariff & rate model (`tariff.ts`)

**Rates are now CONFIRMED** (`TARIFF_APS_RATES_CONFIRMED = true`). The previous revision's "cent values are owner-to-confirm placeholders and every $ output emits null" no longer holds.

| Period | Rate |
|---|---|
| Overnight super-off-peak (23:00–05:00, weekdays) | **13.1 ¢/kWh** |
| Off-peak (default, **and every weekend hour**) | **17.0 ¢** |
| On-peak summer (Mon–Fri 16:00–19:00) | **41.6 ¢** |
| On-peak winter (Mon–Fri 16:00–19:00) | **39.5 ¢** |
| Super-off-peak winter (10:00–15:00, weekdays) | **8.2 ¢** |

Season: summer May–Oct, winter Nov–Apr. Plan = APS **R-EV**, **no demand charge** — the ~40% of conditional machinery §0.3 of the original hinged on collapsed when that was confirmed. Tariff source is **manual**; the EcoFlow API exposes no rates, and there is **no expiry check** — a rate change would be silently stale.

`rateAt(model, ts)` resolves month/dow/hour explicitly in America/Phoenix (no DST). At `DISPATCH_ROUND_TRIP_EFFICIENCY = 0.86` — charge leg `√0.86 = 0.9274`, discharge leg `0.94`, product **0.872** — **stored overnight energy delivers at 15.02 ¢/kWh.** Note this is *not* a flat 0.86: code that assumes it will be wrong by ~1.4%.

### 2.1 The weekday boundary, and the money in it

The overnight `weekdays` gate is evaluated **per instant**, which makes the window shape:

| | window |
|---|---|
| Mon–Thu | 6 h (23:00 → 05:00) |
| **Friday** | **1 h** (23:00 → 00:00; Sat 00:00–05:00 is weekend, hence off-peak) |
| **Saturday** | **none** |
| Sunday | 5 h |

`tariff.ts` flags this in-code as an owner-confirmable edge. It is not cosmetic: measured over seven days, on-peak import was 0 kWh on most days **but 22.89 kWh on Friday 2026-08-28** — the day whose window is truncated to one hour. That is roughly **$6/week, ~$312/yr** of avoidable on-peak, and one call to APS settles whether Fri 23:00 → Sat 05:00 is in fact a single overnight block. **It is the single highest-value open item in this design.**

By contrast the weekend gap itself is nearly worthless: because every weekend hour is off-peak, the only weekend arbitrage is carrying 13.1 ¢ energy into 17.0 ¢ hours — a **1.77 ¢/kWh** spread, ≈ $0.50–0.80 per weekend, **~$25–42/yr**, against a hard physical ceiling of $1.28/weekend. Any estimate near $73/yr assumes buying *inside* the missing hours, which price at 17.0 ¢ and would lose money.

**A Thursday pre-buy cannot close it**, and the reason is physics rather than horizon: the usable 16→90% band is 68.2 kWh against ~105 kWh/day of house draw, so Friday consumes it before Saturday begins.

---

## 3. The planner (`nightChargeAdvisor.ts`)

Pure `computeNightChargePlan(inputs)` → module holder → `nightChargeStateFields(plan, nowMs?)`. Stateless recompute, no ack/resolve machine. **Emits `null` rather than a fabricated number whenever any input basis is incomplete**; `charge_tonight` defaults `false`, never null-as-true.

### 3.1 Objective — and the honest state of cost mode

`ARB_OBJECTIVE` selects between two objectives:

- **`resilience`** — buy exactly enough that the post-window trough holds reserve + cushion. The buy is a *requirement*; anything beyond it is waste.
- **`cost`** (live) — the resilience answer becomes a **floor**, not a target. `costModeTargetKwh` raises the target toward `min(ARB_COST_MAX_SOC_PCT % of pool, pool − morning-PV-surplus P90)` and records which bound it in the ledger's `cost_ceiling_basis` (`'max-soc'` | `'pv-headroom'`). It is bounded below by the resilience target, so **the safety margin can never shrink when the objective changes**; the only direction cost mode moves a buy is up. Every physical cap downstream is re-applied unchanged.

★ **Cost mode is rate-blind.** `costModeTargetKwh` reads no tariff. "Cost" means *fill further*, on the premise that overnight energy is the cheapest the day offers — **not** that the planner optimises against the rate table. §2's tariff model informs the *window*, not the *target*. This is a known gap, not a subtlety: the owner asked on 2026-09-06 for cost mode to genuinely optimise against the rate table, and that work is not yet built.

★ **The cost question is only asked on nights that need a buy.** The no-shortfall hold returns before `objectiveMode` is read — the objective is consulted ~120 lines later — so on a night whose projected trough already clears floor + cushion, `ARB_OBJECTIVE` has no effect at all. Measured over the trailing seven ledger rows: **one** row held, and it held because a one-hour Friday window could not serve the requirement, not because the night was comfortable. Reordering the check was investigated on 2026-09-06 and **deliberately not shipped** — the addressable population is close to empty, on-peak import measured 0 on every scored night, and the per-night ceiling is 8.09 kWh (the gap between the 41.2% hold bar and the 50% write clamp).

### 3.2 Sizing math and caps

`fullKwh` ≈ 92.16; `legEff = √0.86 ≈ 0.9274`; `dischargeEff ≈ 0.94`.

1. Project window-start SoC by carrying `SoC_now` through overnight load.
2. Simulate forward under **P10 PV / P90 load**, no grid buy; find the trough.
3. `requiredExtraKwh` = the lift that brings the trough to `targetFloorKwh`, found by bisection (`packAtWindowEndWith` is monotone in lift and clamps to `[0, full]`, so the bisection is exact). When even maximum effort cannot hold the line, `meetable` is false and `requiredExtraKwh` reports the **whole-pool placeholder** — a sentinel, not a measurement.
4. `buyKwh = effLiftKwh / legEff` — the meter sees more than the pack stores.

**Caps.** `bindingCap` reports which bound produced the answer: `requirement` · `chargePower` · `evContention` · `poolHeadroom` · `overBuy`.

★ **EV contention is the routine limiter.** With `ARB_GRID_INPUT_CAP_KW = 17` and the EVSE drawing ~11.5 kW, the packs are left ~5.5 kW against a 7.2 kW `ARB_CHARGE_CAP_KW`. Measured: `binding_cap = 'evContention'` on **five consecutive nights**. `evContention` is a *more specific* `chargePower`, not a parallel vocabulary, and it is claimed **only** when an EVSE prediction actually covers the window — a missing prediction can never masquerade as a modelled one.

**Under-buy remains classified as a safety miss**, not a cost miss (the original life-safety reclassification, still binding): P10 PV, P90 load, `p90SessionKwh` for a committed EV charge rather than the probability-weighted expected value, EV double-count guarded, and any thin/climatology-only basis resolving to null rather than a best-effort small buy the owner might trust as cushion.

### 3.3 The cushion — three bases, and why the distinction matters

`outageCushionKwh` returns a `CushionBasis`, and the three are genuinely different states that one number cannot distinguish:

| basis | meaning | trough test |
|---|---|---|
| `islanded-outage` | sized from a measured islanded load over a bounded outage — the intended path | pack **at window close** (outage onset) |
| `legacy-pct` | no usable islanded-load measurement; the flat percentage-of-pool band stands in | whole-house **forward trough** (harsher) |
| `disabled` | the owner set the cushion to zero — the plan stops sizing for an outage entirely | pack **at window close** |

**v1.125.0 re-scoped the cushion** from a whole-house band to `outageHours × islandedLoadKw × safetyFactor / dischargeEff`. The motivating error: the original sim ran the *whole house* off battery, but the SHP2 carries only the backup circuits — `panel_load` against `runway_recent_load` differ by roughly 3×. Live: 4 h × 4.37 kW × 1.25 / 0.94 ≈ **23.2 kWh**.

**v1.133.0 made a deliberate zero mean zero.** The guard had folded `outageHours <= 0` into the same branch as *"no measurement available"*, so setting the option to 0 silently returned the legacy flat band — and, because the legacy basis also switches to the harsher whole-house trough, **asking for no cushion made the requirement larger**. An exact `0` is now honoured on the `disabled` basis and checked *first*, so a missing load reading cannot resurrect the legacy band underneath a deliberate zero. Negative, `NaN` and `Infinity` still fall back: a malformed value is not a decision, and the fallback direction is more cushion, never less.

**A disabled cushion announces itself** in the rationale — *"the N% reserve floor alone — the outage cushion is DISABLED, so nothing is held back for an outage."* Without that, a night with no outage margin reads as one whose floor-plus-cushion was comfortably covered: a standard that was *lowered*, reported as one that was *met*.

Under `disabled`, `cushionShortfall` **changes meaning**: it fires only when the pack cannot hold the reserve floor *itself* — a stronger, rarer signal. Anything treating that flag as a proxy for outage readiness needs to know the standard moved.

### 3.4 The write setpoint is not the deliverable

`setpointSocPct` is the pack level at window close whose post-window trough holds floor + cushion, derived from the **requirement** and deliberately **not** from the deliverable lift. Deriving it from the lift would hand the device a contention-derated arrival as an instruction and cap the charge there even on a night the car never plugs in — the model-induced under-buy this field exists to prevent.

It is stated on the trough itself rather than through a window walk, because it is a property of the post-window trajectory alone and must not inherit the charge model's caps.

★ **What is announced is what is written.** Until v1.133.1 the rationale printed `setpointSocPct` un-clamped, so a live plan announced *"the reserve is set to 100%"* — in the 21:30 notification **and the spoken broadcast** — while the panel was being told 50. The sentence now names three quantities for what each is: what the device is **told**, what the requirement **asked for** when the envelope truncated it, and what the window is expected to **reach**.

### 3.5 The three holds

A night that does not buy holds for one of three reasons, and they mean different things:

1. **No shortfall** — the projected trough already clears floor + cushion. Returns early, before the objective is read (§3.1).
2. **A genuinely small need** — the deliverable covers the requirement but falls under `ARB_MIN_BUY_KWH`.
3. **A window that cannot serve** — the deliverable falls *short* of the requirement.

`holdIsStarved` discriminates (2) from (3) by comparing requirement against deliverable, both converted to the meter side, with `!meetable` short-circuiting to starved because that case carries a placeholder requirement that would otherwise compare as comfortably covered.

The discriminator is deliberately **not** `bindingCap`: `poolHeadroom` labels both a starved window *and* a nearly-full pack, which are opposite situations. A first implementation keyed the wording off it and the mutation harness caught the error.

Before v1.132.0 all three printed one string, which reported `buyKwh` — the *deliverable* — labelled "the projected shortfall." On 2026-09-04 a one-hour Friday window produced a ~0 kWh deliverable against a whole-pool requirement and the ledger filed it as *"no meaningful charge"*: the exact opposite of what happened, and it read as routine for a day.

---

## 4. The actuator (`nightChargeActuator.ts`) — as built

`decideActuation(state, nowMs, opts)` is a pure decision core with every clock injected; the integrator executes decisions through the audited write helper and persists every transition to a restart-surviving state file (atomic write, in-memory mirror).

### 4.1 Arm

The evening job announces the plan (notification + audible broadcast) with the intended buy, the reserve target and a cancel deadline. The armed state persists only after an announcement channel confirms delivery. Deadline phrasing is **day-qualified beyond 24 h** ("on Sunday at 11:55 PM"), because weekend tariff semantics routinely resolve a Saturday-evening plan's window to Monday 00:00 — a bare clock time would read as tonight.

**Sat + Sun share one window** (both resolve to Mon 00:00–05:00), so an earlier evening's never-applied arm being replaced is normal. **Friday does not share** — it has its own one-hour window. A comment claiming otherwise was corrected in v1.132.0.

### 4.2 Apply, and lost-confirmation adoption

The attempt is a **write-ahead intent**: the state file records the attempt and its pre-write baseline *before* the device call. One write raises `backupReserveSoc` to `clampReserveTarget(setpointSocPct)`, audit-logged with a retry cooldown. Every apply guard fails closed — advisory mode, a cancelled night, a red alert condition, an incoherent SoC read, an unknown or out-of-range current reserve, a missed window, or a target at or below the current reserve all produce no write.

**Adoption:** when an attempted write reports failure but the live reserve later reads back *exactly* the attempted target (and differs from the attempt-time baseline), the write is proven applied — the confirmation was lost, not the write. Strict equality: any other reading means either the write truly failed or something else moved the floor, and the actuator never guesses a revert target from it.

### 4.3 Readback verification — on both legs

★ **A cloud ACK is not an actuation.** On 2026-08-16 an ACK'd write never reached the SHP2, nothing compared the device's reserve to the target, and the night ran its drawdown on a floor the ledger said was raised. v1.79.0 added readback verification to the apply leg: strict equality against the device-side reading, measured from the latest attempt so each retry earns a fresh window, paused while the reading is null.

**v1.131.0 added the same to the revert leg**, which had kept the original bug. Because the revert branch is gated on `revertedAtMs == null`, stamping it on the cloud ACK also stopped the actuator looking at the panel at all. A restore the SHP2 accepted-then-ignored would leave the reserve pinned at the raised target with the ledger recording a clean, completed night — and that is the *expensive* end state, because the panel holds the raised value as its floor and buys grid at on-peak instead of discharging the pack the plan had just paid overnight rates to fill.

Both legs now: verify → retry (capped) → escalate once. On the revert leg, a reading that is **neither** the restore target nor the raised target is treated as the owner moving their own floor, and the actuator falls through rather than overwriting it.

### 4.4 Revert

The prior value restores at window close + 5 min, or immediately on a post-apply cancel. Mode-independent — it runs even if the owner flips back to advisory mid-night — and it refuses an invalid restore value. After `REVERT_ESCALATE_AFTER = 3` consecutive **cloud-rejected** writes it annunciates a critical once and keeps retrying; the readback-failure path (§4.3) escalates separately. The floor/runway/SoC alarm spine is fully independent throughout.

**Revert settling.** The projection keeps reporting the raised reserve for ~20–60 s after the ACK. `isRevertSettling` holds the arbitrage posture true through a 5-minute grace window, because otherwise the alert engine sees `arbitrageRaised = false` against a still-raised reserve and classifies a normal pool as a floor breach — observed live as a false "[Medium] Backup at reserve" push followed by its own resolve ~40 s later. The readback verdict deliberately cannot be reached inside that same window.

### 4.5 Grid-loss abort

With the grid gone the buy cannot happen, and a raised reserve only manufactures a false AT-RESERVE-FLOOR posture on top of a real outage. `gridPresent === false` restores the true floor immediately. `gridPresent === null` (unknown) never aborts — it falls back to the normal schedule, because absence of a signal must not itself trigger an actuation.

---

## 5. The ledger (`night_charge_ledger`, `recorder.ts`)

Two dedicated, **never-pruned** tables created alongside `lifetime_totals` and never referenced by the 30-day `samples` prune. The original analysis behind that decision stands: a gate reading a 30-day-truncated ledger as "N consecutive clean nights" could green-light writes on a record that only *looks* complete.

One row per `plan_date` (America/Phoenix), in four column groups:

- **PLAN** (frozen the evening before): `algo_version`, `objective`, `rationale`, `confidence_tier`, `target_soc_pct`, `buy_kwh`, `required_extra_kwh`, `reserve_floor_pct`, `cushion_pct/_kwh`, `binding_cap`, the P10/P50/P90 bands, `min_proj_soc_pct`, `tariff_snapshot`, window bounds, `cushion_shortfall`.
- **OUTCOME** (null until the night completes): `actual_pv/load/window_import/onpeak_import_kwh`, `actual_min_soc_pct`, `plan_traj_floor_breached`, `cushion_breached`, `actuated`, `actuation_applied_at_ms`, `delivered_kwh`, `grid_home_coverage_frac`, `scored`, `score_notes`.
- **SCORE**: `pv_err_frac`, `load_err_frac`, `buy_err_kwh` (signed, + = over-bought), `soc_min_err_pct`, and the cost/savings columns.
- **DISPOSITION** (v1.132.0, null on earlier rows):
  - **`arm_disposition`** — why an armed night never became an actuation. `actuated` alone is over-loaded: `NULL` covers at least five dispositions (superseded by a later plan, held below the minimum buy, no window resolved, advisory mode, apply guards refused). The 2026-08-29 row sat at `actuated = NULL` with `buy_kwh = 36` and read like a failed 36 kWh buy; it was a routine Sat/Sun shared-window supersede, recorded in a log line and nowhere in the ledger.
  - **`cost_ceiling_basis`** — the field that makes cost mode auditable. `objective` records the *configured* mode plus buy/no-buy, and `costModeTargetKwh` floors at the resilience answer, so a row labelled `cost_arbitrage` can carry **zero** cost-mode contribution. This value was computed and thrown away.

**Scoring is completion-gated** (v1.39.0): a night is outcome-captured only after its full scored span elapses, paired to the plan's own frozen charge window. The pre-v1.39.0 scorer fired mid-window and froze truncated actuals, permanently starving the gate. A row with no stored window is unscoreable, and v1.132.0 distinguishes the two reasons — a *pre-v1.39.0* row (a data-vintage problem) from a current-version row that simply **had no cheap window to resolve that night**, which is normal on a tariff day that offers none.

**`delivered_kwh` measures storage, not value.** On 2026-08-31 the write applied, 16.54 kWh was imported over the window at full measurement coverage, and `delivered_kwh` was **0** — the import served the house rather than charging the pack (pack minimum 48%). Not a failed actuation and not a measurement gap; the energy was bought at 13.1 ¢ and consumed, it simply was not *stored*. `actual_grid_to_battery_kwh` is a declared column that is never written, so the exact split cannot be recovered.

---

## 6. Surfaces

All surfaces read one holder. One HA namespace `night_charge_*`, one status endpoint.

- **HA entities** via `nightChargeStateFields` with a 12 h staleness guard: `charge_tonight` strictly `false` on null/incomplete/stale, numeric fields null unless fresh. Wired into **both** `mqttDiscovery.buildState()` and `/api/ha-state`.
- **MQTT availability/LWT + `expire_after`** (Invariant I12): `charge_tonight` publishes to a *retained* topic, so without an availability topic a dead advisor's retained `ON` would be served by the broker forever.
- **The ~21:30 notification** — direct `sendNotification`, severity `info`, one updating card. Three shapes: charge, hold, insufficient-basis. Sending the third makes the *absence* explicit so the operator never wonders whether the job died.
- **Owner automation contract:** trigger on `charge_tonight ON` **AND** readiness **AND** availability online **AND** honour the window sensors. **Never gate on `charge_tonight` alone** — publishing the window is what stops an automation reading it as "charge NOW."
- **Web + TUI:** `NightChargeCard`, and a `TONIGHT'S PLAN` block in the TUI strategy screen kept distinct from `CHARGE SCHEDULE` (which shows the SHP2's own native `timeTask` config — the two must not be confused).
- **`GET /api/night-charge/status`** — read-only, no auth, exposing the plan, the actuation record, readiness and the last 7 ledger days. `reserveFloorPercent` is sourced from the same field the floor alarm defends, never a divergent copy.

---

## 7. Write-readiness gate (v2)

Evidence is scored **actuated** nights. Graduation to `auto` requires: ≥ 21 scored actuated nights, under-buy ≤ 10%, delivery bias in [0, 5] kWh, band coverage in [78, 92]% over ≥ 14 verdict nights, zero engine-fault strikes. A strike requires the plan to have *claimed hold* (`cushionShortfall` falsy — a disclosed shortfall is physics, not fault) **and** a trajectory or realized breach; strikes live in a rolling 45-day window and clear after 14 consecutive strike-free nights.

★★ **The gate cannot open on current inputs, and says so itself:**

> *"under-buy rate UNREACHABLE, not merely thin — all 11 of 11 actuated night(s) disclosed a cushion shortfall and are therefore exempt from the sizing judgement. The cushion requirement is not satisfiable on this plant (the worst-case day drains more than the pool holds), so the flag is a constant and more nights will not change this."*

**Accruing more nights will not graduate `auto`.** `cushion_shortfall` reads 1 on every ledger row in the sample. This is an owner decision — re-scope the cushion — not a data-accrual wait.

Note also that `activeStrikes: 0` sits alongside `strikesMeasurable: 0`. The strike detector is not reporting an absence of faults; it is reporting an **inability to count**. Any zero in `readiness.metrics` whose companion `*Measurable` field is also zero carries no information.

The v1 gate this replaced failed for a structural reason worth preserving: its evidence base — clean-islanded-baseline nights — is **unreachable on a grid-tied home**, because the SHP2 carries the house on grid at the reserve floor and imports every night, freezing `scoredDays` at 0. A gate whose criterion cannot be met is indistinguishable from one that is merely strict, and both read as "not ready yet."

---

## 8. Safety invariants — as-built status

| | Invariant | Status |
|---|---|---|
| **I1** | ~~Never write `backupReserveSoc`; only `CHARGE_TIME_TASK`~~ | **SUPERSEDED** 2026-07-31. See §1.3 — the objections are answered by mechanism |
| **I2** | Size from worst case (P10 PV / P90 load / `p90SessionKwh`); under-buy is a **safety** miss | Binding |
| **I3** | `targetSoc` ≤ ceiling AND ≤ `fullKwh − P90 morning PV headroom`; buy capped by feasibility and headroom | Binding, plus the `[10,50]` write envelope (§1.2) |
| **I4** | Write precondition requires grid present; any outage signal → hard NO-WRITE | Binding — and the grid-loss **abort** (§4.5) extends it mid-window |
| **I5** | SHP2 offline / stale telemetry → advisory null, NO-WRITE | Binding |
| **I6** | Forecast collapse / climatology-only / low coverage → null + NO-WRITE | Binding. Basis gate is `bandCoverageFrac ≥ 0.78` |
| **I7** | EV clamped at `EV_MAX_LOAD_W`; sized from de-duplicated load | Binding |
| **I8** | 16:00–19:00 M-F is an absolute blackout for any import-inducing action | Binding |
| **I9** | Idempotency: one plan row per local date; restart-persistent latch | Binding |
| **I10** | Time-sensitive delivery at ~21:30, never the 06:00 digest queue | Binding |
| **I11** | SoC coherence guard before sizing; else null | Binding |
| **I12** | MQTT availability/LWT + `expire_after` so a dead advisor's retained `ON` is not trusted | Binding |
| **I13** | Readiness fails closed to LEARNING; prior-`algo_version` rows excluded | Binding |

---

## 9. Known-inert and unreachable — the honest register

Listed so a quiet reading is not mistaken for a healthy one. Every entry here was found by measuring the live system, not by reading the code.

- **`ARB_COST_MAX_SOC_PCT` is not deliverable above 50.** Schema `int(50,100)`; write envelope caps at 50. Every legal value produces the identical instruction. Charge power binds first regardless (~60% SoC on a six-hour weeknight).
- **Cost mode is rate-blind** (§3.1). It fills further; it does not optimise against the rate table.
- **The cost question is never asked on a comfortable night** (§3.1) — the no-shortfall hold returns first.
- **The readiness gate cannot open** (§7) — under-buy is structurally unmeasurable while `cushion_shortfall` is pinned.
- **`activeStrikes: 0` means "cannot count"**, not "no faults."
- **`actual_grid_to_battery_kwh`** is declared and never written, so a `delivered_kwh` of 0 cannot be decomposed.
- **No force-charge path** — `setChannelForceCharge` is only ever called with `on: false`.
- **The tariff has no expiry check** — a rate change would be silently stale.

---

## 10. Open decisions

**The owner's:**

1. **Call APS about the Friday 23:00 → Saturday 05:00 boundary** (§2.1). ~$312/yr, one phone call, and the difference between a one-hour and a six-hour Friday. The highest-value item in this document.
2. **Re-scope the cushion**, which is the only thing that can open the readiness gate (§7). *Decided 2026-09-06: the protected floor becomes **10% total**, with the outage cushion **disabled** — accepting roughly 5 hours of planned outage margin to free ~23 kWh of arbitrage band. The engine can now express this (§3.3); the settings are not yet applied, deliberately, pending the rate-aware objective below.*
3. **Whether to probe `backupReserveSoc` above 50** to learn if the `[10,50]` bound is the device's or only the client's. No probe exists in the repo and it cannot be answered from code. *Authorised 2026-09-06, not yet performed — it requires the pack to sit above the value written, or the panel grid-charges to reach it and the reserve alarm annunciates.*

**Not yet built:**

4. **Make cost mode genuinely rate-optimising** (§3.1) — requested 2026-09-06. The marginal test is whether a bought kWh displaces something dearer than the 15.02 ¢ it delivers at: on-peak (+26.6 ¢), off-peak (+1.98 ¢), or morning PV, which is free and therefore a **negative** margin. Measured on-peak import is currently 0 kWh on every scored night, so the honest expectation is that a rate-aware objective buys little more than resilience on this plant until the Friday-window question (§2.1) is settled.
