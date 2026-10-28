# Home Assistant entities

Power publishes its readings to Home Assistant through MQTT discovery. Turn it on with
`MQTT_DISCOVERY_ENABLED` and point `MQTT_DISCOVERY_HOST`, `MQTT_DISCOVERY_USER` and
`MQTT_DISCOVERY_PASS` at your broker (for example the Mosquitto add-on). Every entity appears
under one device, **Power**. This page has one row per entity; `scripts/check-docs.mjs`
and the test suite hold it to what the discovery code publishes.

**How entities are named.** Home Assistant mints an entity_id once, the first time it discovers
an entity, from the device name and the entity's name, and keeps it against the unique_id. The
first column shows the id a fresh install gets. An older install, or one where you renamed an
entity, may show a different entity_id: find the entity by its unique_id under
**Settings → Devices & services → Entities**. Renaming an entity in Power changes only its
friendly name.

**How values arrive.** One state message on `ecoflow_panel/state` refreshes every entity every
30 seconds. A reading Power does not have reads unknown, never a made-up 0. Live sensors turn
unavailable 120 seconds after their last update, so a stopped add-on shows as unavailable
rather than as frozen values. The lifetime energy counters never expire, and the night-charge
entities expire after 25 hours.

## Power flow

Live power, refreshed every 30 seconds. The fleet figures sum the Cores connected to the panel; bench spares off the panel are not counted.

While a Core connected to the panel has no reading of its own, Fleet PV and Battery Net count it from the panel's own meter on its slot. That covers a Core that is cloud-offline, and one listed online whose readings have stopped changing (its cloud answers with an old reading, or not at all) or have not arrived yet after a reconnect: Battery Net adds the power that slot delivers, minus the Core's solar, and Fleet PV adds that solar. At night the solar is 0; night is judged at the site's coordinates (`FORECAST_LAT` / `FORECAST_LON`, or Home Assistant's home location with `SITE_LOCATION_FROM_HA`). In daylight it is the panel's per-slot solar reading, which is checked through the day against the solar the Core demonstrably took in (its output plus the rise in its charge level); both read unknown rather than a partial sum while the panel reports no solar reading for the slot, for the rest of the day once that reading has fallen short of the check for an hour (at once when it is 2 kWh short), or while the panel's own reading is not fresh. A Core on a panel that is itself offline is left out of both: nothing of it can be read, and on a two-panel install the other panel's Cores still count. A Core the cloud lists offline whose own data still arrives counts at its own reading. For its first three minutes without a reading of its own a Core is in neither figure, so both read unknown: a brief offline flag is not an outage. The slot meter sees the power crossing between the Core and the panel, so it leaves out the Core's own standby and conversion draw.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_fleet_pv` | `ecoflow_fleet_pv_watts` | Solar power into the Cores (MPPT input, DC); a Core with no reading of its own counts from the panel | W |
| `sensor.power_panel_load` | `ecoflow_panel_load_watts` | Load on the panel's circuits, summed | W |
| `sensor.power_ac_import` | `ecoflow_ac_import_watts` | AC power into the Cores' inputs (grid charging); a Core with no reading of its own counts from the AC its panel slot takes in, never its last reading | W |
| `sensor.power_battery_net` | `ecoflow_fleet_battery_net_watts` | Net battery power across the packs; positive is discharging; a Core with no reading of its own counts from its panel slot | W |
| `sensor.power_grid_power_home` | `ecoflow_grid_home_watts` | Whole-home grid power at the panel's main | W |

## Battery pool and panel settings

The pool is the backup pool the panel reports. The reserve is the panel's own backup-reserve setting, read live.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_backup_pool` | `ecoflow_backup_pool` | Backup pool charge | % |
| `sensor.power_backup_remaining` | `ecoflow_backup_remaining_kwh` | Energy left in the backup pool | kWh |
| `sensor.power_backup_capacity` | `ecoflow_backup_full_capacity_kwh` | Full capacity the panel reports for the pool (the packs' nameplate sum) | kWh |
| `sensor.power_backup_reserve_floor` | `ecoflow_backup_reserve_percent` | The panel's backup-reserve setting, read live; while a night-charge write holds the reserve up it shows the raised value (diagnostic) | % |
| `sensor.power_solar_backup_reserve` | `ecoflow_solar_backup_reserve_percent` | The panel's solar backup reserve setting (diagnostic) | % |
| `sensor.power_backup_reserve_enabled` | `ecoflow_backup_reserve_enabled` | Whether the panel's backup reserve is on; unknown while the panel's settings are unavailable (diagnostic) | on / off |
| `sensor.power_smart_backup_mode_code` | `ecoflow_smart_backup_mode_code` | The panel's smart-backup mode, as its raw code (diagnostic) | code |
| `sensor.power_backup_mode_code` | `ecoflow_backup_mode_code` | The panel's backup mode, as its raw code (diagnostic) | code |
| `sensor.power_overload_mode_code` | `ecoflow_overload_mode_code` | The panel's overload mode, as its raw code (diagnostic) | code |

## Grid

Grid presence comes from one resolver shared with the alarms: the panel's own grid flag, measured grid import, `GRID_PRESENCE_ENTITY` and `GRID_AVAILABLE`. When the signal is missing it reads not present.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.power_off_grid` | `ecoflow_off_grid` | On when the grid is not present | on / off |
| `binary_sensor.power_shp2_grid_connected` | `ecoflow_shp2_grid_connected` | The panel's own grid-line flag; unknown while the panel is offline | on / off |
| `sensor.power_shp2_grid_status` | `ecoflow_shp2_grid_sta` | The panel's grid-status code, in words (diagnostic) | text |

## Runway and forecast

The runway is an hour-by-hour projection of the pool with the house islanded. While the grid is carrying the house, the two "islanded-only" flags are on and a low reading is information, not an emergency.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_runway_to_reserve` | `ecoflow_runway_to_reserve_hours` | Hours until the pool reaches its reserve; 999 when no crossing is projected | h |
| `sensor.power_runway_to_empty` | `ecoflow_runway_to_empty_hours` | Hours until the pool is empty; 999 when no crossing is projected | h |
| `binary_sensor.power_runway_projection_islanded_only` | `ecoflow_runway_projection_islanded_only` | On while the grid is carrying the house, so the runway is an outage projection | on / off |
| `sensor.power_forecast_pv_next_24h` | `ecoflow_forecast_pv_next_24h_kwh` | Forecast solar energy for the next 24 hours | kWh |
| `sensor.power_projected_low_soc` | `ecoflow_projected_low_soc` | Lowest pool charge in the forecast | % |
| `binary_sensor.power_projected_low_soc_islanded_only` | `ecoflow_projected_low_soc_islanded_only` | On while the grid is carrying the house, so the projected low is an outage projection | on / off |
| `binary_sensor.power_forecast_basis_incomplete` | `ecoflow_forecast_basis_incomplete` | On when the forecast is missing part of its basis (diagnostic) | on / off |

## Solar, curtailment and efficiency

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_pv_clipped_today` | `ecoflow_pv_clipped_kwh_today` | Solar energy clipped today (a daily total that restarts each day) | kWh |
| `sensor.power_pv_array_peak` | `ecoflow_pv_array_peak_watts` | Highest hourly solar power observed: the ceiling clipping is judged against (diagnostic) | W |
| `binary_sensor.power_pv_curtailment_active` | `ecoflow_pv_curtailment_active` | On while solar is being curtailed because the batteries are full | on / off |
| `sensor.power_pv_curtailment_surplus` | `ecoflow_pv_curtailment_surplus_watts` | Solar power going unharvested now | W |
| `sensor.power_pv_curtailed_today` | `ecoflow_pv_curtailment_kwh_today` | Solar energy curtailed today (a daily total that restarts each day) | kWh |
| `sensor.power_pv_curtailed_7d` | `ecoflow_pv_curtailment_kwh_7d` | Solar energy curtailed over the last 7 days | kWh |
| `sensor.power_charge_ceiling` | `ecoflow_charge_ceiling` | The Cores' configured maximum charge level, averaged: curtailment is judged against it (diagnostic) | % |
| `sensor.power_solar_soiling` | `ecoflow_soiling_drop_percent` | Estimated output loss from panel soiling | % |
| `sensor.power_solar_fraction_of_load` | `ecoflow_solar_fraction_of_load` | Share of household load met by solar | % |
| `sensor.power_pv_direct_use_ratio` | `ecoflow_direct_use_ratio` | Share of solar used directly by the house | % |
| `binary_sensor.power_self_consumption_coverage_partial` | `ecoflow_self_consumption_coverage_partial` | On when the self-consumption figures cover only some of the Cores (diagnostic) | on / off |
| `sensor.power_round_trip_efficiency` | `ecoflow_round_trip_efficiency` | Measured battery round-trip efficiency | % |

## Energy counters

Lifetime counters (`total_increasing`) for the Energy Dashboard. They never expire, so a stopped add-on leaves a flat line rather than a gap. A counter reads unknown, never 0, until its total exists.

While a Core connected to the panel has no reading of its own (it is cloud-offline, or listed online with its readings stopped or not yet arrived), its battery and solar energy are counted from the panel's meter on its slot, so the battery and solar counters keep rising through a Core outage. Energy the slot delivers is battery out unless it was solar; energy into the slot is battery in, and so is the solar that charges the Core. The solar is 0 at night, the panel's per-slot solar reading once that reading has been checked against the inferred figure, and otherwise inferred from the slot's net output plus the rise in the Core's charge level, which reads somewhat low (the Core's own draw is invisible to the slot). The add-on log states each check with both figures. These figures are measured at the panel, after the Core's conversion, so battery out reads lower than the Cores' own counters would. The panel takes over from the Core's own figures at the moment its own readings stopped, so energy already counted is neither dropped nor counted twice. A Core the cloud lists offline whose own data still arrives keeps counting from its own figures. When a Core the panel took over reports again, the jump in its own counters is absorbed instead of landing in one hour: that energy was already counted. Battery data that arrives before it is listed online and reporting again is absorbed the same way, since the panel is counting that time. No counter steps down when a Core goes offline between updates, or when the add-on restarts during an outage, after a crash too. One case is an exception: the add-on crashes while a Core still reports, and the Core goes offline before the add-on is back. Then, right after the restart, solar and Grid to Battery Charge read up to 5 minutes' worth of energy lower until the first update, about 30 seconds later, counts it back, and up to 5 minutes of that Core's battery energy is counted twice. Nothing is counted while the panel itself is offline, beyond the pause below. While the panel's reading is not fresh (the cloud replaying it, or a poll failing), a Core taken over by the panel whose own data has come back counts its battery energy from its own pack meters. A pause in the panel's readings (the cloud replaying its last reading, a poll failing, or the panel briefly listed offline, while the add-on keeps reading the panel) of up to 30 minutes is filled in with the reading held through it, for Panel Load, Grid Import (Home), each circuit and the Cores the panel meters; a longer pause, such as an internet outage, is not, and neither is one across an add-on restart.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_pv_production` | `ecoflow_pv_lifetime_kwh` | Solar energy produced; while a Core has no reading of its own, its share counted at the panel | kWh |
| `sensor.power_home_consumption` | `ecoflow_load_lifetime_kwh` | Household energy consumed | kWh |
| `sensor.power_grid_import_home` | `ecoflow_grid_to_home_lifetime_kwh` | Grid energy imported by the home, at the panel's main | kWh |
| `sensor.power_grid_to_battery_charge` | `ecoflow_grid_import_lifetime_kwh` | Grid energy into the Cores' AC inputs, the battery-charging share; a Core with no reading of its own counts from its panel slot (diagnostic) | kWh |
| `sensor.power_battery_energy_in` | `ecoflow_battery_charge_lifetime_kwh` | Energy into the batteries; while a Core has no reading of its own, its share counted at the panel | kWh |
| `sensor.power_battery_energy_out` | `ecoflow_battery_discharge_lifetime_kwh` | Energy out of the batteries; while a Core has no reading of its own, its share counted at the panel | kWh |

## Cost and carbon

Money figures use the rates of the tariff `TARIFF_PLAN` names (the APS R-EV preset while it is unset) once `TARIFF_RATES_CONFIRMED` is on; while that key is unset, `TARIFF_APS_RATES_CONFIRMED` decides for every plan. Until the rates are confirmed they use the flat rate, `TARIFF_FLAT_CENTS_PER_KWH` (17 ¢/kWh when unset), or `TARIFF_ON_PEAK_CENTS` and `TARIFF_OFF_PEAK_CENTS` when both are set (a `two_tier` plan's own rates), and Grid Rate Now reads unknown. A tariff setting that cannot be read is treated the same way and raises a repair issue; the APS preset never stands in for it. The unit is `TARIFF_CURRENCY`: USD when unset, or EUR, GBP, CAD or AUD (any other code keeps USD and raises a repair issue); a cent is a hundredth of it. Changing the currency on a running install changes the unit of a long-term statistic, which Home Assistant then asks you to repair. CO2 avoided is the grid energy displaced times `GRID_CO2_INTENSITY_LB_PER_MWH` (when unset, 1100 lb/MWh, an Arizona grid average): enter your grid's figure. The miles figure is a fixed conversion of that mass.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_grid_cost_today` | `ecoflow_tariff_today_cost` | Cost of today's grid import | currency |
| `sensor.power_solar_value_today` | `ecoflow_tariff_today_saved` | Value of today's solar used by the house | currency |
| `sensor.power_net_savings_7d` | `ecoflow_tariff_savings_7d` | Net savings over the last 7 days | currency |
| `sensor.power_grid_rate_now` | `ecoflow_grid_price_now` | Grid rate in force now; unknown until the rates are confirmed | currency/kWh |
| `sensor.power_co2_avoided_7d` | `ecoflow_carbon_kg_avoided_7d` | CO2 avoided over the last 7 days | kg |
| `sensor.power_co2_avoided_lifetime` | `ecoflow_carbon_lifetime_kg` | CO2 avoided, lifetime | kg |
| `sensor.power_equivalent_miles_not_driven` | `ecoflow_carbon_lifetime_miles` | Car miles not driven, lifetime equivalent | mi |

## Pack health

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_soonest_pack_eol` | `ecoflow_degradation_soonest_eol_years` | Years until the first pack is projected to reach end of life | yr |
| `sensor.power_peer_outlier_packs` | `ecoflow_degradation_peer_outliers` | Packs whose fade stands out from their peers | count |

## Alarms and system health

Counts are of alerts active now.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_critical_alerts` | `ecoflow_alert_critical_count` | Active threshold alerts at critical severity | count |
| `sensor.power_warning_alerts` | `ecoflow_alert_warning_count` | Active threshold alerts at warning severity | count |
| `sensor.power_learned_warnings` | `ecoflow_learned_warning_count` | Active learned warnings (peer comparison, self-baseline and forecast) | count |
| `sensor.power_high_priority_alarms_p2` | `ecoflow_alert_high_count` | Active alarms at High priority (P2) | count |
| `sensor.power_medium_priority_alarms_p3` | `ecoflow_alert_medium_count` | Active alarms at Medium priority (P3) | count |
| `sensor.power_low_priority_alarms_p4` | `ecoflow_alert_low_count` | Active alarms at Low priority (P4) | count |
| `sensor.power_fleet_devices_online` | `ecoflow_fleet_devices_online` | EcoFlow devices online | count |
| `sensor.power_cloud_wedged_devices` | `ecoflow_cloud_wedge_count` | Devices the cloud reports offline but the LAN can reach; 0 unless `ECOFLOW_DEVICE_REACHABILITY` is set (diagnostic) | count |
| `sensor.power_poll_health` | `ecoflow_poll_health` | `ok`, or why the last poll could not observe the alarm path (diagnostic) | text |
| `sensor.power_shp2_payload_frozen` | `ecoflow_shp2_content_frozen_s` | Seconds the panel's reading has repeated unchanged; 0 when it is live (diagnostic) | s |
| `sensor.power_system_outage_24h` | `ecoflow_system_outage_24h` | On if any data gap or outage occurred in the last 24 hours (diagnostic) | on / off |
| `sensor.power_system_outages_24h` | `ecoflow_system_outage_count_24h` | Data gaps and outages in the last 24 hours, all causes (diagnostic) | count |
| `sensor.power_host_power_outages_24h` | `ecoflow_system_power_outage_count_24h` | Times the add-on or host was down, not by a deliberate restart, in the last 24 hours (diagnostic) | count |
| `sensor.power_telemetry_gaps_24h` | `ecoflow_system_telemetry_gap_count_24h` | Cloud or MQTT stalls while the add-on stayed up, last 24 hours (diagnostic) | count |
| `sensor.power_device_telemetry_gaps_24h` | `ecoflow_system_device_gap_count_24h` | Times one device went silent for 6 hours or more while the others kept reporting, last 24 hours, including a device offline in the EcoFlow cloud that long (diagnostic) | count |
| `sensor.power_system_outage_minutes_24h` | `ecoflow_system_outage_minutes_24h` | Total minutes of gaps and outages in the last 24 hours (diagnostic) | min |
| `sensor.power_audible_alarm_channel` | `ecoflow_audible_channel_status` | Health of the spoken-alarm channel: reachable, UNREACHABLE, disabled or unknown (diagnostic) | text |
| `sensor.power_audible_speakers_reachable` | `ecoflow_audible_speakers_reachable` | Speakers that answered the last probe (diagnostic) | count |

## Host

The machine Power runs on, read from the kernel; each reads unknown where it cannot be read.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_host_soc_temperature` | `ecoflow_host_soc_temp` | Hottest thermal zone of the host (diagnostic) | °C |
| `sensor.power_host_event_loop_lag` | `ecoflow_host_evloop_lag` | How long the add-on's event loop is delayed (diagnostic) | ms |
| `sensor.power_host_memory_available` | `ecoflow_host_mem_available` | Host memory available (diagnostic) | MB |
| `sensor.power_host_data_disk_free` | `ecoflow_host_disk_free` | Free space on the data disk (diagnostic) | MB |
| `sensor.power_host_load_1m` | `ecoflow_host_load_1m` | Host load average, 1 minute (diagnostic) | — |

## Night charge

Refreshed from the latest plan, recomputed every 30 minutes. These carry a 25-hour expiry: a stopped planner turns them unavailable instead of leaving a stale "charge tonight". A plan older than 12 hours, or one built on an incomplete basis, publishes no figures and "charge tonight" off.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.power_night_charge_recommended` | `ecoflow_night_charge_recommended` | Charge tonight: the flag your automation gates on | on / off |
| `sensor.power_night_charge_target_soc` | `ecoflow_night_charge_target_soc` | The reserve SETPOINT to write, clamped to the panel's 10–50 range; not a prediction of where the pool ends | % |
| `sensor.power_night_charge_arrival_soc_worst_case` | `ecoflow_night_charge_expected_soc` | Arrival SoC (Worst Case): the pool level at the window close projected on the islanded worst case the plan is sized on, not the charge the write is expected to make | % |
| `sensor.power_night_charge_buy_worst_case` | `ecoflow_night_charge_buy_kwh` | Buy (Worst Case): the grid energy the plan is sized on, assuming the islanded worst case | kWh |
| `sensor.power_night_charge_expected_buy` | `ecoflow_night_charge_expected_buy_kwh` | The grid energy the charge is expected to draw, from the expected pool level at the window open; unknown with no median basis | kWh |
| `sensor.power_night_charge_window_start` | `ecoflow_night_charge_window_start` | Charge window start, in site time (`23:00`, or `Mon 00:00` when more than a day away) | text |
| `sensor.power_night_charge_window_end` | `ecoflow_night_charge_window_end` | Charge window end, same format | text |
| `sensor.power_night_charge_readiness` | `ecoflow_night_charge_readiness` | `LEARNING`, `READY_TO_CONSIDER_WRITES` or `BLOCKED`: the write-readiness gate (diagnostic) | text |
| `binary_sensor.power_night_charge_write_ready` | `ecoflow_night_charge_write_ready` | On when the readiness gate has graduated; off when it has not or is unknown (diagnostic). Graduating takes at least 21 scored nights on which Power itself raised the reserve (`supervised` or `auto`), so it stays off in an install that only advises | on / off |
| `sensor.power_night_charge_role` | `ecoflow_night_charge_role` | What tonight's overnight window is for: `cost` (it carries the charge, as on every night while the mid-day charge runs in shadow) or `backup` (an outage backup ahead of a winter mid-day charge). The entities above always describe the overnight window; unknown with no current plan | text |

## Mid-day charge

On the APS R-EV preset, the lowest winter rate runs from 10 AM to 3 PM on weekdays (super off-peak; a `custom` plan gets the same treatment for a period named `super_off_peak`). With the cost objective (`ARB_OBJECTIVE` `cost` and `ARB_COST_MAX_SOC_PCT` above 50), on the evening before each winter weekday Power works out the charge it would make in that window: an outage backup overnight, then a daytime charge, and a morning re-check against the latest solar forecast. **For now this runs in shadow:** Power computes and records it, and writes, arms and announces nothing for it. The charge itself runs overnight only, and the card shows the mid-day plan in a read-only section. These entities carry the same 25-hour expiry as the night-charge ones. They are unknown when there is no daytime charge to plan: with the `resilience` objective (the default), on a weekend or in summer, or after the window closes. Every mid-day sensor below carries a `basis` attribute, `shadow` while the mid-day charge is computed only; check it before you build a dashboard or an automation on these figures.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.power_midday_charge_recommended` | `ecoflow_midday_charge_recommended` | On only when a daytime charge is actually armed. It stays off while the mid-day charge runs in shadow, so do not use it to start a charge yourself | on / off |
| `sensor.power_midday_charge_target_soc` | `ecoflow_midday_charge_target_soc` | The level the daytime charge would bring the pool to, after the morning re-check | % |
| `sensor.power_midday_charge_reserve_hold` | `ecoflow_midday_charge_reserve_hold` | The backup reserve it would hold through the window, within the panel's 10–50 range | % |
| `sensor.power_midday_charge_expected_buy` | `ecoflow_midday_charge_expected_buy_kwh` | The grid energy the daytime charge is expected to draw | kWh |
| `sensor.power_midday_charge_buy_worst_case` | `ecoflow_midday_charge_buy_kwh` | Buy (Worst Case): the grid energy the daytime plan is sized on, assuming the islanded worst case | kWh |
| `sensor.power_midday_charge_window_start` | `ecoflow_midday_charge_window_start_at` | When the daytime window opens. A timestamp sensor, shown as a time (the payload is ISO 8601 UTC: `2026-11-16T17:00:00.000Z` is 10:00 AM at UTC−7); unknown when no daytime charge is in view | timestamp |
| `sensor.power_midday_charge_window_end` | `ecoflow_midday_charge_window_end_at` | When it closes, the same way | timestamp |
| `sensor.power_midday_charge_refresh` | `ecoflow_midday_charge_refresh` | The morning re-check: `pending`, then `unchanged`, `lowered`, `capped` (the new forecast asked for a higher level or reserve than the evening plan, which stays the limit), `cancelled`, `stood` (no re-check finished in time, so the evening plan stands) or `not-comparable` (the night's own overnight charge already filled the pool, so the re-check was not made and the evening figures stand) | text |

## Load shedding and lighting

Advice only: Power never switches these loads. Your automations decide.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.power_load_shed_recommended` | `ecoflow_load_shed_recommended` | On when shedding is recommended | on / off |
| `sensor.power_load_shed_recommended_count` | `ecoflow_load_shed_recommended_count` | Loads recommended for shedding | count |
| `sensor.power_load_shed_recommended_watts` | `ecoflow_load_shed_recommended_watts` | Power those loads draw | W |
| `sensor.power_runway_to_reserve_if_shed` | `ecoflow_runway_to_reserve_if_shed_hours` | Runway to the reserve if they were shed | h |
| `sensor.power_lighting_posture` | `ecoflow_lighting_posture` | Lighting posture: `surplus`, `normal`, `conserve`, `amber`, `red` or `critical` | text |
| `sensor.power_lighting_posture_reason` | `ecoflow_lighting_posture_reason` | Why the posture is what it is (diagnostic) | text |

## Panel circuits

Two entities per circuit of the Smart Home Panel 2, named from the circuit (paired legs read
"Name L1" and "Name L2"). They are published once the first poll lists the circuits, and both
are removed when a circuit leaves the panel.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.power_<circuit>_energy` | `ecoflow_circuit_<ch>_lifetime_kwh` | Lifetime energy of circuit `<ch>` (`total_increasing`) | kWh |
| `sensor.power_<circuit>_power` | `ecoflow_circuit_<ch>_watts` | Live power of circuit `<ch>`; unknown, never 0, when the panel does not report it | W |

## Alarm-priority switches

One switch per alarm priority. Off silences that priority's announcements: its phone pushes,
its spoken alarm and its chime. The alarm itself stays on the dashboard and in the counts above.
The same toggles are on the dashboard (**Alerts → Alert Settings**); a change in either place
shows in both, and it is kept across restarts. The discovery message also asks for
`switch.ecoflow_alarms_critical_p1` and so on through `object_id`, a key current Home Assistant
ignores, so a fresh install gets the ids below. An install whose switches were first discovered
while that key was honoured keeps the shorter ids; look the switches up by unique_id.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `switch.power_alarms_critical_p1` | `ecoflow_alerts_critical` | Announce Critical (P1) alarms | on / off |
| `switch.power_alarms_high_p2` | `ecoflow_alerts_high` | Announce High (P2) alarms | on / off |
| `switch.power_alarms_medium_p3` | `ecoflow_alerts_medium` | Announce Medium (P3) alarms | on / off |
| `switch.power_alarms_low_p4` | `ecoflow_alerts_low` | Announce Low (P4) alarms | on / off |

## Energy Dashboard wiring

Add these under **Settings → Dashboards → Energy**. The energy entities drive the kWh views.
The power entities are the "power" (`stat_rate`) of each source, which the dashboard's **Now**
view needs: without one on every source, its consumption line is wrong by the battery's flow.

| Energy source | Energy entity (unique_id) | Power entity (unique_id) |
|---|---|---|
| Solar production | `ecoflow_pv_lifetime_kwh` | `ecoflow_fleet_pv_watts` |
| Grid consumption | `ecoflow_grid_to_home_lifetime_kwh` | `ecoflow_grid_home_watts` |
| Battery | in `ecoflow_battery_charge_lifetime_kwh`, out `ecoflow_battery_discharge_lifetime_kwh` | `ecoflow_fleet_battery_net_watts` (positive is discharging) |
| Individual devices | `ecoflow_circuit_<ch>_lifetime_kwh` per circuit | `ecoflow_circuit_<ch>_watts` |

**Gap-free daily history.** Once a day, in the morning (site time), Power fetches the
panel's own daily energy record from EcoFlow and imports it into Home Assistant's long-term
statistics as five external series: "Home load", "Solar production", "Grid import",
"Battery grid-charge" and "Battery discharge", each named "(EcoFlow ledger)", with ids
`ecoflow_panel:vendor_home_energy`, `ecoflow_panel:vendor_solar_energy`,
`ecoflow_panel:vendor_grid_energy`, `ecoflow_panel:vendor_battery_in_energy` and
`ecoflow_panel:vendor_battery_out_energy`. These have none of the gaps that restarts leave in
the live counters, at one value per day. They never change the statistics of the sensors above.
This import does not need MQTT discovery.

## Automation hooks

Power computes and advises; these are the entities an automation of yours can act on.

| To do this | Gate on | Notes |
|---|---|---|
| Charge overnight yourself (advisory mode) | `ecoflow_night_charge_recommended` on, inside `ecoflow_night_charge_window_start` to `ecoflow_night_charge_window_end` | Write `ecoflow_night_charge_target_soc` to the panel's backup reserve, and restore it after the window. Do not require `ecoflow_night_charge_write_ready`: it turns on only after 21 scored nights on which Power itself raised the reserve, so in an install that only advises it never does. Once Power has run `supervised`, it is an optional extra gate |
| Shed loads when the runway is short | `ecoflow_load_shed_recommended` | `ecoflow_runway_to_reserve_if_shed_hours` says what shedding buys |
| Dim or limit lighting | `ecoflow_lighting_posture` | Escalates at once; steps back down only after the calmer posture has held 15 minutes |
| React to a grid loss | `ecoflow_off_grid` | Reads not present when the signal is missing |
| React to any critical alarm | `ecoflow_alert_critical_count` above 0 | Counts active threshold criticals |
| Mute a priority on a schedule | the four alarm-priority switches, unique_ids `ecoflow_alerts_critical` to `ecoflow_alerts_low` (entity_ids `switch.power_alarms_*` on a fresh install) | Muting hides nothing from the dashboard |
