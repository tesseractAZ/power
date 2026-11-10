### 9. Delivery surfaces

**State payloads.** `nightChargeStateFields(plan, now)` + `nightChargeGateFields(readiness)` (and, v1.189.0, `nightChargeRoleFields` + `middayChargeStateFields`) are spread into **both** the MQTT state payload (`mqttDiscovery.ts:1604`) and `/api/ha-state` (`index.ts:1898`) — deliberate MQTT/REST parity. A plan is *fresh* only when `basisComplete && age < PLAN_STALENESS_MS` (12 h = 43 200 000 ms, design I12): numeric fields are null and `charge_tonight` strictly `false` otherwise, so a dead or wedged advisor (the host power-cycles daily) can never leave a stale ON. The window strings are informational (published whenever the plan carries a window) and **day-qualified beyond 24 h** via `fmtSiteDayHm` (formerly `fmtPhoenixDayHm`, kept as an alias) — `"23:00"` within a day, `"Mon 00:00"` beyond — so a Saturday plan resolving Monday's window is never presented as tonight's (v1.39.0).

**HA MQTT-discovery entities** (all carry `expire_after = 90 000 s` (~25 h) so the once-nightly cadence doesn't trip expiry but a dead add-on flips them to `unavailable` — a retained `charge_tonight=ON` from a dead advisor would be worse):

| Entity | Type | Content |
|---|---|---|
| `ecoflow_night_charge_recommended` | binary_sensor | `charge_tonight` — the single flag an owner automation gates on |
| `ecoflow_night_charge_target_soc` | sensor (%) | The reserve SETPOINT for the advisory automation to write — `plan.setpointSocPct` clamped to the actuator's `[10, 50]` envelope (`clampReserveTarget`); not a predicted SoC (v1.62.0 ask/forecast split) |
| `ecoflow_night_charge_expected_soc` | sensor (%) | The pool SoC at window close projected on the islanded worst case the plan is sized on (`plan.targetSocPct`, contention-derated; the rationale's "projecting ~X% by the window close"), not the charge the write is expected to make (that is `ecoflow_night_charge_expected_buy_kwh` and the push's level). Its value is unchanged by v1.187.22, and its friendly name is "Night-Charge Arrival SoC (Worst Case)" (was "Night-Charge Expected SoC"); the unique_id, the config topic, the value key and the value are the same and no `object_id` is published, so Home Assistant keeps the entity_id it minted at first discovery |
| `ecoflow_night_charge_buy_kwh` | sensor (kWh) | The meter-side buy the plan is sized on — the islanded worst case (`plan.buyKwh`); its value is unchanged by v1.187.22, and its friendly name is "Night-Charge Buy (Worst Case)" (was "Night-Charge Buy"). The unique_id, the config topic and the value are the same and no `object_id` is published, so Home Assistant keeps the entity_id it minted at first discovery: history and automations carry over (a fresh install mints one from the new name) |
| `ecoflow_night_charge_expected_buy_kwh` | sensor (kWh) | v1.187.22 — what the armed write is expected to draw from the expected window-open SoC (`plan.expectedBuyKwh`, §5 "Expected buy"); `unknown` with no P50 basis |
| `ecoflow_night_charge_window_start` / `_end` | sensor (string) | Day-qualified `HH:MM` window bounds in site time |
| `ecoflow_night_charge_readiness` | sensor (diagnostic) | `LEARNING` / `READY_TO_CONSIDER_WRITES` / `BLOCKED` |
| `ecoflow_night_charge_write_ready` | binary_sensor (diagnostic) | Fail-closed gate boolean |
| `ecoflow_night_charge_role` | sensor (string) | What tonight's overnight window is for in the cycle the add-on runs (`nightChargeRoleFields`): `cost` (it carries the cost buy — every cycle until the mid-day switch) or `backup` (the outage backup ahead of a mid-day charge); null under the entities' freshness rule, which the template renders `unknown`. The entities above stay bound to the overnight leg |
| `ecoflow_midday_charge_recommended` | binary_sensor | ON only when a LIVE mid-day leg is armed to charge (`middayChargeStateFields`). Nothing arms one before the switch, so it is strictly OFF while the mid-day cycle runs in shadow: a shadow is never a recommendation an automation may act on |
| `ecoflow_midday_charge_target_soc` / `_reserve_hold` | sensor (%) | The mid-day cost leg's level (`chargeLevelPct`) and its reserve, T_mid — the refreshed figures once the morning refresh ran, null after a cancel |
| `ecoflow_midday_charge_expected_buy_kwh` / `_buy_kwh` | sensor (kWh) | Its expected draw, and the worst case it is sized on |
| `ecoflow_midday_charge_window_start_at` / `_end_at` | sensor (timestamp) | The mid-day window: `device_class: timestamp` instants (ISO 8601, UTC), shown as times. The payload is null whenever no shadow record is served (weekends, weekdays after 15:00, all summer) and renders as `None`, which HA's MQTT sensor maps to unknown for every sensor type, ahead of any parsing and without a warning (core `mqtt/sensor.py`, `PAYLOAD_NONE`). v1.189.0 published them as text on the premise that a timestamp sensor logs a warning for that payload; it does not (restored in v1.190.1) |
| `ecoflow_midday_charge_refresh` | sensor (string) | `pending`, then the refresh's disposition: `unchanged`, `lowered`, `capped`, `cancelled`, `stood` or `not-comparable` |

The text entities of v1.189.0 (`night_charge_role`, the refresh) render a null as `unknown` (`{{ "unknown" if value_json.x is none else value_json.x }}`, the null pattern `ecoflow_backup_reserve_enabled` set). The window bounds render it as `None` (the row above): a timestamp sensor would log a warning for `unknown`, which is no datetime.

The mid-day entities read the shadow record while it is current — computed within 25 hours and its window not yet closed (`shadowServed`) — and null otherwise, with the same `expire_after`. Each mid-day figure (every entity above but the recommendation) carries a `basis` attribute from the state topic (`json_attributes_template`; the payload's `midday_charge_basis`): `shadow` while the mid-day charge is computed only. The unique_ids, and so the entity ids, are the ones the switch will publish live figures on; the attribute is what tells a preview from a charge that runs, in a dashboard, an automation or the recorder's history.

Buy, expected SoC and the window come from the latest plan, recomputed every 30 min: before the window they can differ from the announced and armed figures (`GET /api/night-charge/status` → `actuation`), and inside it the buy is what is still needed and reaches 0 once the target is met. The armed buy is not an actuation input — force-charge stops on the frozen SoC target.

The remaining gate diagnostics (`night_charge_under_buy_rate`, `night_charge_band_coverage_pct`, `night_charge_plan_nights_scored`, `night_charge_effective_n`, `night_charge_forecast_basis_pct`, `night_charge_exclusion_fraction`) ride the same payloads without dedicated discovery entities.

**`GET /api/night-charge/status`**: `{ enabled, mode, siteTimeZone, reserveWriteMaxPct, window, reserveFloorPercent, confidence, notify:{hour,minute,lastNotifyDay}, plan, armRefusal, readiness, actuation, legs, middayShadow, middayShadowPreview, recentOutcomes }`. `siteTimeZone` (v1.191.0) is the zone every time in it was computed in, and the card writes its clock times in it; `notify` is when the evening job fires, after the schedule's clamp (`nightSchedule.ts`). `armRefusal` (v1.187.22) is why a supervised or auto mode refused to arm this plan (`armRefusalReason`) — or "the announcement could not be delivered" when the arm reached no announcement channel (`eveningNotArmedReason`, §8b) — recorded by the evening job with the notify latch, keyed by the refused plan's window, and served (`servedArmRefusal`) while the served plan is a charge plan for that window, in a write mode, until the window closes; null otherwise. An evening that misses its notify window latches the day and keeps a standing record: Saturday's refusal for the Monday window Saturday and Sunday share still leads the card on Sunday night. `mode` is the resolved `NIGHT_CHARGE_MODE`. `reserveWriteMaxPct` (v1.182.0) is the panel's reserve maximum, so the card shows what will actually be written. `actuation` is tonight's supervised-write record: armed/applied/cancelled/reverted, the force-charge fields, `cancelDeadlineMs`, and `forceChargeOnVerify` (v1.186.0, whether the force-charge ON was read back) (§8b). `legs` lists the charge cycle's legs in order — a trailing leg, the active one (the `actuation` record), the pending ones — each with its role, window kind, position, state (`armed`, `applied`, `restoring`, `completed`, `cancelled`, `missed`, `foreign`, `forceChargeOff`), window, cancel deadline and write stamps (`cycleLegsStatus`); one entry with one leg. `middayShadow` is the mid-day cycle computed in shadow while it is current (the record above, `shadowServed`), else null, and `middayShadowPreview` the 21:30 push and spoken notice the mid-day switch would send for it (`middayShadowPreview`: never sent), else null. `reserveFloorPercent` is read live from `projection.backupReserveSoc` — the same field the floor alarm defends. `recentOutcomes` is an in-memory mirror of the last 7 ledger days refreshed by the timers, so the request handler never touches the DB inline (CWE-770). No auth: read-only, exposes no secrets, actuates nothing.

**Notification** (`buildNightChargeMessage`, `notify.ts:389`): three shapes — `charge` (since v1.187.22 the charge the write arms, never the worst case it is sized on (§5 "What is stated"): the title "Night-charge: charging to ~80% tonight (~34.9 kWh)" — "charge to ~50% recommended tonight" in advisory mode — and the body "Charging the backup pool to ~80% overnight, ~34.9 kWh of grid energy expected.", no kWh with no expected figure; the whole-house island troughs without vs with the charge, labelled "Whole-house island projection (if the grid were lost)" because with the grid present the SHP2 holds the reserve; the floor+cushion line the plan is sized on (`floorCushionLinePct`, §5), confidence, honest shortfall/over-buy notes, and the advisory automation contract or the supervised write, whose force-charge clause names where it stops (`forceChargeStopPct`) and when it is expected to start (§5); on a night expected to charge nothing, "Night-charge: reserve held at 50% tonight — no charge expected" (§5); "toward" the level when the window cannot reach it (§5); when a supervised or auto mode REFUSED to arm the plan (`armRefusalReason`, armFromPlan's checks in its order — an unresolved prior write, a force-charge OFF not verified, a window already more than 30 minutes under way), "Night-charge: planned charge NOT armed tonight" with the reason and no level or kWh, never the advisory recommendation of a write nothing will make — on a night expected to charge nothing, "Night-charge: planned reserve hold NOT armed tonight" ("Tonight's plan holds the backup reserve at 50% overnight as a floor, with no charge expected, but the supervised write was not armed — `<reason>`. The add-on will not raise the reserve tonight."), and "the write" rather than "the supervised write" in auto mode), `hold` (nothing is charged; since v1.187.22 it says which hold, on the figure the hold was decided on: "No overnight charge needed — even if the grid were lost overnight, the pack would close the charge window at ~37.5%, at or above the 31.1% floor+cushion line" — the trough the cushion test judged, `cushionTroughSocPct` against `cushionLineSocPct`, labelled as the islanded case it is (the whole-house low on the `legacy-pct` basis), never the unlabelled whole-house island trough it used to state as "the projected overnight low SoC (0%)"; "the need is under the minimum buy"; "no charge tonight (the window cannot cover the cushion)" with the shortfall disclosed, where it used to say "No overnight charge needed"; or no window resolved; since v1.198.0 a plan sized on the provisional solar band, a charge or any hold but the one with no window, also states the band's "PROVISIONAL SOLAR BAND" sentence — chapter 15 part 1, "The provisional band"), and `insufficient_basis` (sent so the *absence* of a plan is explicit — the owner never wonders if the job died; a null plan can only ever render this shape regardless of the requested one). Since v1.196.0 its body names what refused the plan: "No overnight charge plan tonight — the forecast/telemetry basis is incomplete: PV band coverage 72% < 78% (forecast present, tier=forecast, calDays 14/14), so nothing will be charged." (`plan.basisBlockedBy`, chapter 15 part 1, "basisBlockedBy"), and a null plan — no panel, or no pool capacity, SoC or reserve reading — "No overnight charge plan tonight — the panel's pool readings (capacity, state of charge, reserve) are unavailable, so nothing will be charged."; a refused plan issued before v1.196.0 reads as before. All severity `info` with a single `dedupId: 'night_charge_plan'` so the nightly message lands in **one updating card**, and dispatched via a *direct* `sendNotification` that bypasses quiet-hours and min-severity (design I10) — a plan queued past the charge-window open is worse than none. `NIGHT_CHARGE_NOTIFY_ON_HOLD=false` suppresses hold-night sends (still latching the day). On a supervised arm the spoken advisory (`nightChargeSpokenNotice`, bilingual) states, since v1.187.22, the level and the expected draw — "Night charge notice. Charging the backup pool to about 80 percent, about 35 kilowatt hours, in the charge window that opens at 00:00. Cancel on the Power panel before then." — with no energy figure when there is no expected one, and "less than 1 kilowatt hour" rather than "about 0"; a night expected to charge nothing is spoken as the reserve held, "… ; no charge is expected." (§5). The time is the window's, not "starting at": a pool that opens above the reserve is not charged at the open (the house draws it until the just-in-time force-charge).

**Web**: `NightChargeCard` on the Strategy panel, titled "Night-charge plan" (v1.191.0) — zero-prop, self-fetching `/api/night-charge/status` on a 60 s poll, its clock times in the status's `siteTimeZone` (none without it, never the browser's zone), with its own matching 12 h client-side staleness guard; a null/incomplete/stale plan renders the grey "unavailable" shape, never a fabricated number. Since v1.187.22 its headline is the charge the write arms — the expected draw and the level ("34.9 kWh — expected charge to ~80%"), or the level alone with no expected figure (`chargeFigureParts`, nightChargeText.ts) — and the worst case appears once, in the sizing line beneath it (`sizingLine`, the server's `sizingBasisText` wording, the calibration beside the figure it multiplies). The stats label the sizing figures as such — "Worst-case arrival" (`targetSocPct`, sub "sizing basis", was "Expected SoC") and "Island low, no charge" / "Island low, with charge" (sub "if the grid were lost") — and a hold night shows the push's hold shape (`holdSummary`). A night expected to charge nothing leads with the reserve the write holds ("50% — reserve held as a floor — no charge expected"); a night a write mode refused to arm (the status's `armRefusal`) leads with "Planned charge not armed tonight — `<reason>`." and no level or kWh (`refusedArmLead`), as the push does — "Planned reserve hold not armed tonight — `<reason>`." on a night expected to charge nothing, and "the write" in auto mode; on a force-charge night with no start expected the headline states the reserve the night reaches ("expected charge to ~50%", §5); a night expected to charge nothing shows no EV-contention line; the "Island low, with charge" stat states the line the plan is sized on (`floorCushionLinePct`). Beneath every shape whose status is known, a read-only section shows the mid-day cycle computed in shadow (`middayShadowView`): the outage backup, the 10:00–15:00 charge and its morning refresh, each with whether it would arm, the title of the evening notice it would have sent ("not sent"), and a closing note that nothing of it is armed, written or announced. It has no control, and shows nothing with no mid-day leg.

---

### 10. Configuration

Add-on options (`config.yaml` → env):

| Option | Default | Range | Meaning |
|---|---|---|---|
| `NIGHT_CHARGE_ADVISOR_ENABLED` | `true` | bool | Master switch for the timers + surfaces (env compare is `!== 'false'`) |
| `NIGHT_CHARGE_MODE` | `advisory` | list(advisory\|supervised\|auto) | Write posture (v1.50.0). `advisory` never writes; `supervised` runs the announced, cancellable, bounded, auto-reverting reserve write per charge night. In `cost` mode with `ARB_COST_MAX_SOC_PCT` above 50 it adds a force-charge that rides the verified write, or a line night's stood reserve, to the night's ceiling (v1.165.0) (§8b); `auto` is honored only after gate graduation and operates as supervised until then. Unknown values fail closed to `advisory`. |
| `ARB_OUTAGE_CUSHION_PCT` | `15` | int 0–40 | Legacy fallback only: the cushion as % of pool, tested against the whole-house forward trough. It is used only when no islanded-load measurement exists. The primary cushion is `ARB_OUTAGE_CUSHION_HOURS` × (7-day mean islanded load × `ARB_ISLANDED_LOAD_SAFETY` ÷ discharge efficiency (v1.125.0) + the Cores' standby, the runway's figure (v1.201.0)). Never changes the independent floor alarm |
| `ARB_MIN_BUY_KWH` | `1` | float 0–50 | Below this recommended buy, the night is a "hold" |
| `ARB_CHARGE_CAP_KW` | `0` | float 0–50 | Grid-side charge-power ceiling for the feasibility cap. `0` = AUTO (v1.173.0): connected Cores × the per-Core rate (`FORCE_CHARGE_KW_PER_CORE`, 5.5 kW measured on the reference plant when unset) ÷ √RTE (~5.9 kW per Core there); > 0 is a fixed override. Home load comes off separately via `ARB_GRID_INPUT_CAP_KW`. Sizing only, no device is ever set |
| `ARB_LOAD_P90_FACTOR` | `1.15` | float 1–2 | Floor of the calibrated load-band multiplier (`calibratedLoadBandFactor`, v1.106.0): the band can only widen above it, and it is the factor itself below 10 ledger samples |
| `NIGHT_CHARGE_NOTIFY_HOUR` / `_MINUTE` | `21` / `30` | clamped int 0–**22** / 0–59 | Evening-job fire time, site time. The catch-up window is `[fire, window start)`, so the hour is clamped below the start: to 22 with the preset (23 made the window empty, v1.39.0), and with another plan to the hour before its window opens, with a repair issue (`nightSchedule.ts`) |
| `NIGHT_CHARGE_NOTIFY_ON_HOLD` | `true` | bool | Send the nightly advisory even on hold nights (consistent "the job ran" confirmation) |
| `TARIFF_APS_*_CENTS` ×6 | `""` | str | The APS R-EV preset's per-period effective ¢/kWh from a bill (§3 table), used while `TARIFF_PLAN` is unset or `aps_r_ev`; empty = unconfirmed |
| `TARIFF_APS_RATES_CONFIRMED` | `false` | bool | While false, **every** `$` output is null regardless of entered rates; `TARIFF_RATES_CONFIRMED`, when set, decides instead, for any plan |
| `TARIFF_PLAN` | unset (`aps_r_ev`) | list(aps_r_ev\|flat\|two_tier\|custom) (optional) | The tariff the window is planned in (part 1, section 3). No window is planned on a plan with no cheap period (`flat`, or `two_tier` with `NIGHT_CHARGE_CHEAP_PERIOD` unset) or an unusable spec |
| `SITE_TIMEZONE` | unset | str (optional) | The zone of every local time here; unset: the container's `TZ` (Home Assistant's), else `America/Phoenix` |
| `ARB_OUTAGE_CUSHION_HOURS` | `4` | float 0–72 | Outage length the cushion carries the measured islanded load, and the Cores' standby (v1.201.0), through (v1.125.0); `0` disables the cushion (basis `disabled`, v1.133.0) |
| `ARB_ISLANDED_LOAD_SAFETY` | `1.25` | float 1–5 | Multiplier on the 7-day mean islanded (panel) load in the cushion, not on the Cores' standby; raising it buys more |
| `ARB_OBJECTIVE` | `resilience` | list(resilience\|cost) | Sizing objective (§8b) |
| `ARB_COST_MAX_SOC_PCT` | `90` | int 50–100 | Cost-mode fill ceiling; above 50 it is reached by force-charge (v1.165.0); `50` disables the **cost** force-charge, not the line force-charge (v1.200.0) |
| `ARB_GRID_INPUT_CAP_KW` | `17` | float 0–100 | The panel's total grid-input envelope shared by house load and charging; sets the live force-charge rate and the planner's contention cap (≤ 0 disables contention modelling). The default is the reference plant's measured figure; a home enters its grid-input breaker capacity |
| `NIGHT_CHARGE_CHEAP_PERIOD` | unset | str (optional) | The tariff period the planner charges in, by id; unset takes the plan's cheap period (`overnight` with the preset) |
| `FORCE_CHARGE_KW_PER_CORE` | unset (5.5) | float (optional) | The rate one Core takes into its pack under force charge (pack side); with the slots known, the slots × this value bound the force-charge rate that times the run, and the planner's AUTO cap is connected Cores × this ÷ √RTE |
| `EV_MAX_LOAD_W` / `EV_CHARGER_COUNT` | unset (`11520` / 1) | int (optional) | The per-hour EV block cap, shared with the EV detection engine, and the chargers that can run at once (2 or more add overlapping sessions) |

Env-only knobs (not in the options form): `NIGHT_CHARGE_LATCH_PATH`, `NIGHT_CHARGE_PLANSNAP_PATH`, `NIGHT_CHARGE_ACTUATION_PATH` (latch, persisted pre-window plan and actuation-state files; all default beside the DB), `ARB_LOAD_P90_CAP` (default `2.0`, `index.ts:3639` — the upper bound of the load-band widening; **if this is ever added to the options schema it MUST ship an `options:` default**, because `Number('')` is `0` and an unset option would pin the load band to zero), and the shared efficiency seams `DISPATCH_ROUND_TRIP_EFFICIENCY` (default `0.86`, clamped [0.8, 1]; the advisor's charge leg is its square root ≈ 0.927, and since v1.194.0 the runway's and the SoC projections' charge leg too) and `RUNWAY_DISCHARGE_EFFICIENCY` (default `0.94`, clamped [0.8, 1]) — both injected from `analytics.ts`, never re-declared.

---

### 11. Failure modes & known limitations

- **Basis-completeness gate.** No plan is sized unless the probabilistic band exists, the confidence tier is not climatology, `calScoredDays ≥ 4`, *and* realized band coverage ≥ 0.78 (`BASIS_MIN_BAND_COVERAGE`). From 4 to 13 scored days the plan is sized on a widened solar band (the provisional band, [part 1](15-1-night-charge-planning.md)); from 14 on the band as published. On a young install (or after a forecast-model reset, or Cores dark for weeks) the advisor publishes the explicit `insufficient_basis` shape nightly until 4 days have scored — this is by design, not a fault. A provisional plan arms and writes like any other: the readiness verdict only demotes `auto` to `supervised`, the same announced, cancellable write, and provisional nights are ordinary ledger nights for it.
- **SHP2 offline / missing battery fields** ⇒ `recomputeNightChargePlan` returns null and the holder keeps the prior plan until the 12 h staleness guard nulls the surfaces and the ~25 h `expire_after` flips the HA entities to `unavailable`. The scorer likewise cannot source actuals while the SHP2 projection is absent; affected nights land as MNAR exclusions, which the gate's expected-nights denominator counts against readiness.
- **Weekend tariff boundary (open question).** The model's per-instant weekday gating makes Friday's window Fri 23:00–24:00 only (Sat 00:00–05:00 is weekend off-peak) with the next window opening Mon 00:00 — a ~48 h carry sized against a 1-hour charge window (charge-power capped, `cushionShortfall` honestly flagged) on a mostly `mixed`-tier basis that never enters gate eligibility. This describes the APS R-EV preset. Whether real APS billing extends Friday's overnight into Saturday morning can only be settled from a bill; if it does, the correction belongs in `tariff.ts` weekday gating. Rates are null until confirmed, so no `$` output depends on the answer.
- **Hardware charge envelope.** The panel's `chargeWattPower` (`chChargeWatt`) is the AC charge-rate limit for EACH connected battery, 7.2 kW, equal to every source slot's `ratePower` and the charge time-task's `chargeWatts`; the pool's envelope is that times the connected Cores (21.6 kW with three). Measured on the reference plant 2026-09-16/18: grid import pins at ~19.1 kW and the pack takes (19.1 − house) × ~0.93, up to ~17 kW across three Cores. Measured again 2026-10-13/14 (the recorder's one-minute `ac_in` and `grid_home_w` rows): each Core's own AC input peaked at 7,223 / 6,033 / 7,218 W, the three together at 18.1 kW, the main at 19,253 W. Since v1.173.0 `ARB_CHARGE_CAP_KW` = 0 derives the cap from the connected Cores; the old 7.2 kW under-stated every plan by reading the per-battery limit as the pool's. The dashboard's Smart Home Panel card labels the field "Charge limit (per battery)" with that envelope (v1.190.1).
- **Write posture is mode-gated and fail-closed.** In `advisory` (the default) the add-on performs no night-charge writes; `supervised` performs one announced, cancellable, bounded, auto-reverting reserve write per charge night, plus in `cost` mode above 50% a force-charge that rides the verified write, or a line night's stood reserve, and is switched OFF at the target, the window close, a revert, a cancel or a grid loss (§8b), and `auto` is demoted to supervised until the gate graduates (§8). On non-actuated nights the realized-need counterfactual is defensible only on clean (near-zero-import) nights, so grid-propped nights are excluded from scoring rather than fabricated; actuated nights score from the measured delivered charge instead.
- **A ledger row with no stored window** is unscoreable, and **v1.132.0 distinguishes the two reasons**: a *pre-v1.39.0* row predates the window columns (a data-vintage problem), while a current-`algo_version` row with no window simply had **no cheap window to resolve that night** — normal on a tariff day that offers none, e.g. Saturday on the APS R-EV preset. Both capture as `scored=0`, now with different `score_notes`; calling the second a "pre-v1.39.0 row" sent readers hunting a migration bug that was not there. Nights whose raw telemetry has aged past the configured samples retention (default 30 days) capture honestly unscored rather than staying open forever.
- **The calibration table is not yet live.** The `night_charge_calibration` table (seasonal cushion, buy de-bias, EV-tail inflation) exists as schema and API only and nothing reads or writes it. Three ledger-driven calibrations do run, computed directly from `night_charge_ledger` rows:
  - the announced-buy de-bias (§15.12);
  - the load-band factor (§8);
  - the cost-ceiling load and PV de-bias (§15.13).

  Since v1.125.0 the cushion is sized from the measured islanded load (`ARB_OUTAGE_CUSHION_HOURS` / `ARB_ISLANDED_LOAD_SAFETY`). `ARB_OUTAGE_CUSHION_PCT` is only its legacy fallback.

---

### 12. Announced-buy de-bias (`calibratedBuyDebiasFactor`, v1.112.0)

The 08-26/27 night announced "buy ~21.6 kWh" and delivered ~35.8 — a 1.66×
under-prediction. Actuation is bounded by the reserve setpoint so nothing
unsafe happened, but the announcement is the advisory's product. The factor is
the MEDIAN of `delivered_kwh / buy_kwh` over eligible ledger nights (actuated,
scored, no disclosed cushion shortfall, plan ≥ 3 kWh), FLOOR 1.0 (only ever
raises the announcement — the raw physics estimate is the lower bound), CAP
1.75, minSamples 7. It multiplies the ANNOUNCED figure only: `plan.buyKwh`
stays raw and is what the ledger records (★ the self-reference guard — feeding
the debiased figure back would collapse each night's ratio to ~1 and the
learner would eat its own output), and `chargeTonight` thresholds on the raw
figure so learned data can never flip the decision, only the disclosure.
v1.187.22: the factor multiplies the worst-case figure only, which no spoken or
pushed line states; the rationale's sizing sentence and the card's sizing line name
the de-biased figure with the calibration beside it, and the expected buy (§5) is
never de-biased. New plan fields `buyKwhDebiased` / `buyDebiasFactor`; the rationale
and the card disclose the calibration when active. This is the first live
producer/consumer for the design §3.4 "buy de-bias" lane.

**One delivered basis (v1.187.3).** A night is a sample only when its
`delivered_basis` is `DELIVERED_BASIS` (`source-charge`, §6 "DELIVERED ENERGY").
Rows captured before v1.187.3 hold the import-minus-house-load estimate, which
under-counts any night the SHP2 carried the house from the pack inside the hold
(2026-09-30: a 0.26 delivered/planned ratio for a true ~1.1); they are kept as
recorded, never samples, and counted in the result's `setAside`. Until seven
nights on the current basis exist the factor is 1.0 with basis `default`, and the
`announced-buy calibration UNMEASURED (N eligible night(s), M set aside …)` line
says so on change. `plan.buyDebiasBasis` / `plan.buyDebiasSamples` report the
learner's own basis and sample count; before v1.187.3 `buildNightChargeInputs`
copied only the factor, so every plan reported `default` / 0 whatever the learner
said (the 09-30 log counted 6 eligible nights while the plan said 0).

**One stratum per window kind.** A mid-day leg charges beside the sun and an overnight one in
the dark, so their delivered/planned ratios are not one population: the factor reads only the
rows of the leg's window kind (`ledgerRowWindowKind`: a row written before the charge cycle record
is overnight), and the planned figure is the morning refresh's worst case (`refreshed_buy_kwh`)
when the row has one. Every row is overnight until the mid-day switch, so the overnight factor is
the one it always was. The load band and the cost-ceiling load factor stay pooled: they learn the
forecast load over the 24 hours from issue, which does not depend on the window, and a thin mid-day
stratum would sit on their floors.

### 13. Cost-ceiling load and PV de-bias (`costSurplusLoadFactor`, v1.187.1; `costSurplusPvFactor`, v1.196.0)

The cost ceiling leaves room for the morning surplus, Σ max(0, P50 PV − load) over window
close → +14 h. The load forecast is the panel's hour-of-day history curve, and on every ledger
night `/api/night-charge/status` shows on 2026-09-30 (09-23..29) it ran above the measured load
(`load_err_frac` −0.29 to −0.43, the actual under the load P10 on all seven). Every kW of
over-forecast load is a kW of sun the ceiling leaves no room for: the 09-29 ceiling of 77.7%
bought ~18.9 kWh, the pool was full by 13:00 on 09-30 and ~9-12 kWh of PV was curtailed until
~16:00.

The other term is censored the other way. The P50 PV is the analytics forecast, whose solar fit
and `pvBiasFactor` (`analytics.ts`) learn from hours when the pool was full and the Cores shed
their PV, so on exactly the sunny mornings the ceiling matters the P50 under-states the sun, the
surplus comes out small and the ceiling high. Since v1.196.0 that term is de-biased
too, from the same ledger rows.

The surplus the cost ceiling uses is computed on a de-biased load and a de-biased P50 PV by
`buildCostSurplusLoad` (`nightChargeAdvisor.ts`; `index.ts` supplies the ledger read, the hourly
panel-load query and the tariff timezone's clock hour as callbacks):

- **Builder** (`buildCostSurplusLoad`): the hours are those of the raw morning surplus (window
  close → +14 h, an hour with no day-ahead load skipped). It returns null — the planner keeps
  the raw surplus — in resilience mode, with no morning hour, or when neither factor applies
  (a load factor of 1 — under 5 ledger nights, or a load at or above its forecast — and a PV
  factor of 1). A ledger read that throws counts as no nights. The panel-load query runs only
  when the load de-bias can apply; a query that fails or returns nothing leaves every hour on its
  forecast. A change of either factor, its sample count or the floor coverage is logged once
  (`night-charge: cost-ceiling surplus counts the house load at ×… and the median sun at ×…`).
- **Factor** (`costSurplusLoadFactor`): the median of `1 + load_err_frac` over the ledger rows
  of the last `COST_SURPLUS_LOAD_LOOKBACK_DAYS` (14) days (rows with no finite error, or an
  actual of 0 or less, are not samples). Capped at **1** — the load is only ever lowered, so
  the ceiling can only fall. Under `COST_SURPLUS_LOAD_MIN_SAMPLES` (5) nights it is 1; from
  there the correction ramps in linearly (`n / COST_SURPLUS_LOAD_FULL_SAMPLES`, whole at 10).
  Bounded below at `COST_SURPLUS_LOAD_FACTOR_MIN` (0.6): `actual_load_kwh` skips telemetry
  gaps, so a broken night under-counts the actual.
- **Physical floor** (`measuredHourlyLoadFloorW`): per local clock hour, the least hourly-mean
  panel load over the trailing `COST_SURPLUS_FLOOR_DAYS` (7) days, read in hourly buckets; an
  hour seen on fewer than `COST_SURPLUS_FLOOR_MIN_DAYS` (4) days has no floor.
- **Per hour** (`costSurplusLoadW`): the expected-value EV block (`predictedEvLoadW`) is kept
  whole; the rest is `max(rest × factor, min(floor, rest))` — never below the floor, never above
  the forecast. An hour with no floor keeps its forecast.
- **PV factor** (`costSurplusPvFactor`, v1.196.0): the median of `1 + pv_err_frac` — the ledger's
  realized/forecast ratio of the same 24 h P50 PV sum the morning hours are part of — over the
  same rows, counting only a row that measured the sun: forecast tier, its PV verdict standing
  (`pv_verdict_set_aside` NULL, the readiness gate's own PV pool), a forecast of at least
  `COST_SURPLUS_PV_MIN_FORECAST_KWH` (5 kWh: a near-dark day's ratio is noise), an error over
  −1, and **not saturated** (`pv_saturated`, below). A row captured before the column (NULL)
  counts: censoring only pulls its ratio down, toward the forecast as is. **Expand-only** — at
  least 1, so the sun is only ever raised and the ceiling can only fall; at most
  `COST_SURPLUS_PV_FACTOR_MAX` (**1.3**); under 5 nights it is 1, and it ramps in as the load
  factor does, whole at 10. Per hour (`costSurplusPvW`) the P50 is scaled by it but never past
  that hour's own P90 (the band's best case), and the P90 stand-in itself is not scaled. While
  the Cores are dark the actual PV is withheld, `pv_err_frac` is NULL and the factor stays 1; in
  the sunniest weeks, when most days saturate, it may stay 1 too — the honest result of leaving
  out days that measured the curtailment.
- **Saturation** (`pvSaturationColumns`, `nightLedgerScoring.ts`): the outcome capture records
  the highest pool SoC over the forecast span the PV actual is summed over (`backup_pct`, after
  the 3-sample median filter the trough uses) as `actual_max_soc_pct`, and `pv_saturated` = 1
  when it reached the charge taper — `saturationThresholdPct` of the home Cores' mean `chgMaxSoc`
  (90 with a 100% ceiling or none reported), where the Cores start shedding PV. NULL with no
  reading. The held-telemetry and forecast-span resets clear both with the PV actual.
- **Use** (`debiasedCostSurplusKwh`): the de-biased P50 (or P90 stand-in) replaces the raw one
  only where it is **larger**, and never so large that the ceiling falls below the pack the
  resilience lift arrives at (`targetPackKwh`; the force-charge stops at the ceiling) — unless
  the raw ceiling already sat below it. Raw unknown ⇒ raw. **A `cushionShortfall` night keeps
  the raw surplus**: there the arrival is derated (charge rate, a predicted EV sharing the grid
  input, a clamp) below the requirement, and a stop bounded by it could fall under the cushion
  line the raw stop cleared — a 10 kW islanded load (line 73.71%), a 12 kW grid input and a
  40 kWh session predicted at window open give an arrival of 21.5%, a raw stop of 77.7% and a
  de-biased one of 72.8%, and a car that never plugs in lets the force-charge run at full rate
  to that stop. On any other night the arrival holds the line: on the islanded cushion it is
  the trough itself, and on the legacy band its whole-house trough clears the line.

Scope: cost mode only, and only the `p50` / `p90` bases — a long-gap night keeps its
pessimistic P10 pre-peak surplus. The P90 over-buy flag, the resilience sizing, the setpoint
requirement, the islanded cushion, the solar model, the runway and every alarm read the
forecast load and PV as before. The PV term is de-biased for the cost ceiling only: the solar
fit and `pvBiasFactor` that feed the alarm-facing forecast still include hours when the pool was
full (curtailed output), and are unchanged. Plan fields `costCeilingSurplusRawKwh`,
`costSurplusLoadFactor`, `costSurplusLoadSamples`, and since v1.196.0 `costSurplusPvFactor`,
`costSurplusPvSamples` (cost mode; null with no de-biased surplus and on a long-gap night; 1 and
0 on a surplus from before the PV factor; a term the ledger did not de-bias reads 1 — the load
pair is 1 with its nights when only the sun was de-biased, and the PV pair 1 when only the load
was); when the de-bias widened the headroom the rationale
gives both figures and names each term that moved it ("counting the house load at ×0.793 of its
forecast from 6 realized nights and the median sun at ×1.095 of its forecast from 10 realized
nights"). Ledger columns (`costSurplusLedgerColumns`, written with each plan row):
`cost_surplus_kwh` (the headroom used), `cost_surplus_raw_kwh` (on the forecast as is),
`cost_surplus_load_factor`, `cost_surplus_load_samples`, `cost_surplus_pv_factor`,
`cost_surplus_pv_samples`; NULL in resilience mode, with no de-biased surplus and on rows before
v1.187.1 (the PV pair: v1.196.0), a factor of 1 for a term not de-biased, used = raw where the de-bias did not widen the headroom. Outcome columns
`actual_max_soc_pct` and `pv_saturated` (v1.196.0, above).

Reconstructed on the 2026-09-29 night (the hourly shape of the 09-30 band, P50 PV scaled to
the recorded 20.55 kWh surplus) with the six rows scored before it that the status still shows
(09-23..28, ×0.793): ceiling 77.7% → 72.8%. The deployed planner reads up to 14 days of the
ledger, the correction whole at ten nights, including rows the status no longer shows, so the
factor it applies differs and the log line above states it; the same morning at ×0.70 gives
70.7%. Harness: `scripts/mutate-v1187-1f.mjs` (53).

On the 2026-10-12 evening fixture (cost, a 90% maximum, force-charge riding, a 40 kWh P50
morning surplus), ten unsaturated nights whose sun ran 5–13% over the P50 (×1.095) widen the
headroom to 45.7 kWh: the ceiling and the force-charge stop fall 56.6% → 50.4%, the worst-case
buy 44.88 → 39.93 kWh and the expected one 11.6 → 5.1 kWh. Harness: `scripts/mutate-v1196-night.mjs`
(P-i..xx).

