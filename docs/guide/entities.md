# Home Assistant entities

Power publishes its readings to Home Assistant through MQTT discovery. Turn it on with
`MQTT_DISCOVERY_ENABLED` and point `MQTT_DISCOVERY_HOST`, `MQTT_DISCOVERY_USER` and
`MQTT_DISCOVERY_PASS` at your broker (for example the Mosquitto add-on). Every entity appears
under one device, **EcoFlow Panel**. This page has one row per entity; `scripts/check-docs.mjs`
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

While a Core connected to the panel is cloud-offline, Fleet PV and Battery Net count it from the panel's own meter on its slot: Battery Net adds the power that slot delivers, minus the Core's solar, and Fleet PV adds that solar. At night the solar is 0. In daylight it is the panel's per-slot solar reading, once that reading has been checked against the solar the Core demonstrably took in (its output plus the rise in its charge level); until then, if the reading falls short of it, or while the panel's own reading is not fresh, both read unknown rather than a partial sum. A Core offline for less than three minutes is not counted this way: a brief offline flag is not an outage. The slot meter sees the power crossing between the Core and the panel, so it leaves out the Core's own standby and conversion draw.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_fleet_pv` | `ecoflow_fleet_pv_watts` | Solar power into the Cores (MPPT input, DC); a cloud-offline Core's share from the panel | W |
| `sensor.ecoflow_panel_panel_load` | `ecoflow_panel_load_watts` | Load on the panel's circuits, summed | W |
| `sensor.ecoflow_panel_ac_import` | `ecoflow_ac_import_watts` | AC power into the Cores' inputs (grid charging) | W |
| `sensor.ecoflow_panel_battery_net` | `ecoflow_fleet_battery_net_watts` | Net battery power across the packs; positive is discharging; a cloud-offline Core's share from its panel slot | W |
| `sensor.ecoflow_panel_grid_power_home` | `ecoflow_grid_home_watts` | Whole-home grid power at the panel's main | W |

## Battery pool and panel settings

The pool is the backup pool the panel reports. The reserve is the panel's own backup-reserve setting, read live.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_backup_pool` | `ecoflow_backup_pool` | Backup pool charge | % |
| `sensor.ecoflow_panel_backup_remaining` | `ecoflow_backup_remaining_kwh` | Energy left in the backup pool | kWh |
| `sensor.ecoflow_panel_backup_capacity` | `ecoflow_backup_full_capacity_kwh` | Full capacity the panel reports for the pool (the packs' nameplate sum) | kWh |
| `sensor.ecoflow_panel_backup_reserve_floor` | `ecoflow_backup_reserve_percent` | The panel's backup-reserve setting, read live; while a night-charge write holds the reserve up it shows the raised value (diagnostic) | % |
| `sensor.ecoflow_panel_solar_backup_reserve` | `ecoflow_solar_backup_reserve_percent` | The panel's solar backup reserve setting (diagnostic) | % |
| `sensor.ecoflow_panel_backup_reserve_enabled` | `ecoflow_backup_reserve_enabled` | Whether the panel's backup reserve is on; unknown while the panel's settings are unavailable (diagnostic) | on / off |
| `sensor.ecoflow_panel_smart_backup_mode_code` | `ecoflow_smart_backup_mode_code` | The panel's smart-backup mode, as its raw code (diagnostic) | code |
| `sensor.ecoflow_panel_backup_mode_code` | `ecoflow_backup_mode_code` | The panel's backup mode, as its raw code (diagnostic) | code |
| `sensor.ecoflow_panel_overload_mode_code` | `ecoflow_overload_mode_code` | The panel's overload mode, as its raw code (diagnostic) | code |

## Grid

Grid presence comes from one resolver shared with the alarms: the panel's own grid flag, measured grid import, `GRID_PRESENCE_ENTITY` and `GRID_AVAILABLE`. When the signal is missing it reads not present.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.ecoflow_panel_off_grid` | `ecoflow_off_grid` | On when the grid is not present | on / off |
| `binary_sensor.ecoflow_panel_shp2_grid_connected` | `ecoflow_shp2_grid_connected` | The panel's own grid-line flag; unknown while the panel is offline | on / off |
| `sensor.ecoflow_panel_shp2_grid_status` | `ecoflow_shp2_grid_sta` | The panel's grid-status code, in words (diagnostic) | text |

## Runway and forecast

The runway is an hour-by-hour projection of the pool with the house islanded. While the grid is carrying the house, the two "islanded-only" flags are on and a low reading is information, not an emergency.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_runway_to_reserve` | `ecoflow_runway_to_reserve_hours` | Hours until the pool reaches its reserve; 999 when no crossing is projected | h |
| `sensor.ecoflow_panel_runway_to_empty` | `ecoflow_runway_to_empty_hours` | Hours until the pool is empty; 999 when no crossing is projected | h |
| `binary_sensor.ecoflow_panel_runway_projection_islanded_only` | `ecoflow_runway_projection_islanded_only` | On while the grid is carrying the house, so the runway is an outage projection | on / off |
| `sensor.ecoflow_panel_forecast_pv_next_24h` | `ecoflow_forecast_pv_next_24h_kwh` | Forecast solar energy for the next 24 hours | kWh |
| `sensor.ecoflow_panel_projected_low_soc` | `ecoflow_projected_low_soc` | Lowest pool charge in the forecast | % |
| `binary_sensor.ecoflow_panel_projected_low_soc_islanded_only` | `ecoflow_projected_low_soc_islanded_only` | On while the grid is carrying the house, so the projected low is an outage projection | on / off |
| `binary_sensor.ecoflow_panel_forecast_basis_incomplete` | `ecoflow_forecast_basis_incomplete` | On when the forecast is missing part of its basis (diagnostic) | on / off |

## Solar, curtailment and efficiency

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_pv_clipped_today` | `ecoflow_pv_clipped_kwh_today` | Solar energy clipped today (a daily total that restarts each day) | kWh |
| `sensor.ecoflow_panel_pv_array_peak` | `ecoflow_pv_array_peak_watts` | Highest hourly solar power observed: the ceiling clipping is judged against (diagnostic) | W |
| `binary_sensor.ecoflow_panel_pv_curtailment_active` | `ecoflow_pv_curtailment_active` | On while solar is being curtailed because the batteries are full | on / off |
| `sensor.ecoflow_panel_pv_curtailment_surplus` | `ecoflow_pv_curtailment_surplus_watts` | Solar power going unharvested now | W |
| `sensor.ecoflow_panel_pv_curtailed_today` | `ecoflow_pv_curtailment_kwh_today` | Solar energy curtailed today (a daily total that restarts each day) | kWh |
| `sensor.ecoflow_panel_pv_curtailed_7d` | `ecoflow_pv_curtailment_kwh_7d` | Solar energy curtailed over the last 7 days | kWh |
| `sensor.ecoflow_panel_charge_ceiling` | `ecoflow_charge_ceiling` | The Cores' configured maximum charge level, averaged: curtailment is judged against it (diagnostic) | % |
| `sensor.ecoflow_panel_solar_soiling` | `ecoflow_soiling_drop_percent` | Estimated output loss from panel soiling | % |
| `sensor.ecoflow_panel_solar_fraction_of_load` | `ecoflow_solar_fraction_of_load` | Share of household load met by solar | % |
| `sensor.ecoflow_panel_pv_direct_use_ratio` | `ecoflow_direct_use_ratio` | Share of solar used directly by the house | % |
| `binary_sensor.ecoflow_panel_self_consumption_coverage_partial` | `ecoflow_self_consumption_coverage_partial` | On when the self-consumption figures cover only some of the Cores (diagnostic) | on / off |
| `sensor.ecoflow_panel_round_trip_efficiency` | `ecoflow_round_trip_efficiency` | Measured battery round-trip efficiency | % |

## Energy counters

Lifetime counters (`total_increasing`) for the Energy Dashboard. They never expire, so a stopped add-on leaves a flat line rather than a gap. A counter reads unknown, never 0, until its total exists.

While a Core connected to the panel is cloud-offline, its battery and solar energy are counted from the panel's meter on its slot, so the battery and solar counters keep rising through a Core outage. Energy the slot delivers is battery out unless it was solar; energy into the slot is battery in, and so is the solar that charges the Core. The solar is 0 at night, the panel's per-slot solar reading once that reading has been checked against the inferred figure, and otherwise inferred from the slot's net output plus the rise in the Core's charge level, which reads somewhat low (the Core's own draw is invisible to the slot). The add-on log states each check with both figures. These figures are measured at the panel, after the Core's conversion, so battery out reads lower than the Cores' own counters would. The panel takes over from the Core's own figures at the moment the Core went offline, so energy already counted is neither dropped nor counted twice. When the Core reports again, the jump in its own counters is absorbed instead of landing in one hour: that energy was already counted. No counter steps down, including when a Core goes offline between updates. Nothing is counted while the panel itself is offline.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_pv_production` | `ecoflow_pv_lifetime_kwh` | Solar energy produced; while a Core is cloud-offline, its share counted at the panel | kWh |
| `sensor.ecoflow_panel_home_consumption` | `ecoflow_load_lifetime_kwh` | Household energy consumed | kWh |
| `sensor.ecoflow_panel_grid_import_home` | `ecoflow_grid_to_home_lifetime_kwh` | Grid energy imported by the home, at the panel's main | kWh |
| `sensor.ecoflow_panel_grid_to_battery_charge` | `ecoflow_grid_import_lifetime_kwh` | Grid energy into the Cores' AC inputs, the battery-charging share; a cloud-offline Core's from its panel slot (diagnostic) | kWh |
| `sensor.ecoflow_panel_battery_energy_in` | `ecoflow_battery_charge_lifetime_kwh` | Energy into the batteries; while a Core is cloud-offline, its share counted at the panel | kWh |
| `sensor.ecoflow_panel_battery_energy_out` | `ecoflow_battery_discharge_lifetime_kwh` | Energy out of the batteries; while a Core is cloud-offline, its share counted at the panel | kWh |

## Cost and carbon

Dollar figures use the confirmed APS R-EV rates; while `TARIFF_APS_RATES_CONFIRMED` is off they use a flat 17 ¢/kWh default, and Grid Rate Now reads unknown.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_grid_cost_today` | `ecoflow_tariff_today_cost` | Cost of today's grid import | USD |
| `sensor.ecoflow_panel_solar_value_today` | `ecoflow_tariff_today_saved` | Value of today's solar used by the house | USD |
| `sensor.ecoflow_panel_net_savings_7d` | `ecoflow_tariff_savings_7d` | Net savings over the last 7 days | USD |
| `sensor.ecoflow_panel_grid_rate_now` | `ecoflow_grid_price_now` | Grid rate in force now; unknown until the rates are confirmed | USD/kWh |
| `sensor.ecoflow_panel_co2_avoided_7d` | `ecoflow_carbon_kg_avoided_7d` | CO2 avoided over the last 7 days | kg |
| `sensor.ecoflow_panel_co2_avoided_lifetime` | `ecoflow_carbon_lifetime_kg` | CO2 avoided, lifetime | kg |
| `sensor.ecoflow_panel_equivalent_miles_not_driven` | `ecoflow_carbon_lifetime_miles` | Car miles not driven, lifetime equivalent | mi |

## Pack health

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_soonest_pack_eol` | `ecoflow_degradation_soonest_eol_years` | Years until the first pack is projected to reach end of life | yr |
| `sensor.ecoflow_panel_peer_outlier_packs` | `ecoflow_degradation_peer_outliers` | Packs whose fade stands out from their peers | count |

## Alarms and system health

Counts are of alerts active now.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_critical_alerts` | `ecoflow_alert_critical_count` | Active threshold alerts at critical severity | count |
| `sensor.ecoflow_panel_warning_alerts` | `ecoflow_alert_warning_count` | Active threshold alerts at warning severity | count |
| `sensor.ecoflow_panel_learned_warnings` | `ecoflow_learned_warning_count` | Active learned warnings (peer comparison, self-baseline and forecast) | count |
| `sensor.ecoflow_panel_high_priority_alarms_p2` | `ecoflow_alert_high_count` | Active alarms at High priority (P2) | count |
| `sensor.ecoflow_panel_medium_priority_alarms_p3` | `ecoflow_alert_medium_count` | Active alarms at Medium priority (P3) | count |
| `sensor.ecoflow_panel_low_priority_alarms_p4` | `ecoflow_alert_low_count` | Active alarms at Low priority (P4) | count |
| `sensor.ecoflow_panel_fleet_devices_online` | `ecoflow_fleet_devices_online` | EcoFlow devices online | count |
| `sensor.ecoflow_panel_cloud_wedged_devices` | `ecoflow_cloud_wedge_count` | Devices the cloud reports offline but the LAN can reach; 0 unless `ECOFLOW_DEVICE_REACHABILITY` is set (diagnostic) | count |
| `sensor.ecoflow_panel_poll_health` | `ecoflow_poll_health` | `ok`, or why the last poll could not observe the alarm path (diagnostic) | text |
| `sensor.ecoflow_panel_shp2_payload_frozen` | `ecoflow_shp2_content_frozen_s` | Seconds the panel's reading has repeated unchanged; 0 when it is live (diagnostic) | s |
| `sensor.ecoflow_panel_system_outage_24h` | `ecoflow_system_outage_24h` | On if any data gap or outage occurred in the last 24 hours (diagnostic) | on / off |
| `sensor.ecoflow_panel_system_outages_24h` | `ecoflow_system_outage_count_24h` | Data gaps and outages in the last 24 hours, all causes (diagnostic) | count |
| `sensor.ecoflow_panel_power_outages_24h` | `ecoflow_system_power_outage_count_24h` | Times the add-on or host was down, not by a deliberate restart, in the last 24 hours (diagnostic) | count |
| `sensor.ecoflow_panel_telemetry_gaps_24h` | `ecoflow_system_telemetry_gap_count_24h` | Cloud or MQTT stalls while the add-on stayed up, last 24 hours (diagnostic) | count |
| `sensor.ecoflow_panel_device_telemetry_gaps_24h` | `ecoflow_system_device_gap_count_24h` | Times one device went silent while the others kept reporting, last 24 hours (diagnostic) | count |
| `sensor.ecoflow_panel_system_outage_minutes_24h` | `ecoflow_system_outage_minutes_24h` | Total minutes of gaps and outages in the last 24 hours (diagnostic) | min |
| `sensor.ecoflow_panel_audible_alarm_channel` | `ecoflow_audible_channel_status` | Health of the spoken-alarm channel: reachable, UNREACHABLE, disabled or unknown (diagnostic) | text |
| `sensor.ecoflow_panel_audible_speakers_reachable` | `ecoflow_audible_speakers_reachable` | Speakers that answered the last probe (diagnostic) | count |

## Host

The machine Power runs on, read from the kernel; each reads unknown where it cannot be read.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_host_soc_temperature` | `ecoflow_host_soc_temp` | Hottest thermal zone of the host (diagnostic) | °C |
| `sensor.ecoflow_panel_host_event_loop_lag` | `ecoflow_host_evloop_lag` | How long the add-on's event loop is delayed (diagnostic) | ms |
| `sensor.ecoflow_panel_host_memory_available` | `ecoflow_host_mem_available` | Host memory available (diagnostic) | MB |
| `sensor.ecoflow_panel_host_data_disk_free` | `ecoflow_host_disk_free` | Free space on the data disk (diagnostic) | MB |
| `sensor.ecoflow_panel_host_load_1m` | `ecoflow_host_load_1m` | Host load average, 1 minute (diagnostic) | — |

## Night charge

Refreshed from the latest plan, recomputed every 30 minutes. These carry a 25-hour expiry: a stopped planner turns them unavailable instead of leaving a stale "charge tonight". A plan older than 12 hours, or one built on an incomplete basis, publishes no figures and "charge tonight" off.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.ecoflow_panel_night_charge_recommended` | `ecoflow_night_charge_recommended` | Charge tonight: the flag your automation gates on | on / off |
| `sensor.ecoflow_panel_night_charge_target_soc` | `ecoflow_night_charge_target_soc` | The reserve SETPOINT to write, clamped to the panel's 10–50 range; not a prediction of where the pool ends | % |
| `sensor.ecoflow_panel_night_charge_arrival_soc_worst_case` | `ecoflow_night_charge_expected_soc` | Arrival SoC (Worst Case): the pool level at the window close projected on the islanded worst case the plan is sized on, not the charge the write is expected to make | % |
| `sensor.ecoflow_panel_night_charge_buy_worst_case` | `ecoflow_night_charge_buy_kwh` | Buy (Worst Case): the grid energy the plan is sized on, assuming the islanded worst case | kWh |
| `sensor.ecoflow_panel_night_charge_expected_buy` | `ecoflow_night_charge_expected_buy_kwh` | The grid energy the charge is expected to draw, from the expected pool level at the window open; unknown with no median basis | kWh |
| `sensor.ecoflow_panel_night_charge_window_start` | `ecoflow_night_charge_window_start` | Charge window start, America/Phoenix (`23:00`, or `Mon 00:00` when more than a day away) | text |
| `sensor.ecoflow_panel_night_charge_window_end` | `ecoflow_night_charge_window_end` | Charge window end, same format | text |
| `sensor.ecoflow_panel_night_charge_readiness` | `ecoflow_night_charge_readiness` | `LEARNING`, `READY_TO_CONSIDER_WRITES` or `BLOCKED`: the write-readiness gate (diagnostic) | text |
| `binary_sensor.ecoflow_panel_night_charge_write_ready` | `ecoflow_night_charge_write_ready` | On when the readiness gate has graduated; off when it has not or is unknown (diagnostic). Graduating takes at least 21 scored nights on which Power itself raised the reserve (`supervised` or `auto`), so it stays off in an install that only advises | on / off |

## Load shedding and lighting

Advice only: Power never switches these loads. Your automations decide.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `binary_sensor.ecoflow_panel_load_shed_recommended` | `ecoflow_load_shed_recommended` | On when shedding is recommended | on / off |
| `sensor.ecoflow_panel_load_shed_recommended_count` | `ecoflow_load_shed_recommended_count` | Loads recommended for shedding | count |
| `sensor.ecoflow_panel_load_shed_recommended_watts` | `ecoflow_load_shed_recommended_watts` | Power those loads draw | W |
| `sensor.ecoflow_panel_runway_to_reserve_if_shed` | `ecoflow_runway_to_reserve_if_shed_hours` | Runway to the reserve if they were shed | h |
| `sensor.ecoflow_panel_lighting_posture` | `ecoflow_lighting_posture` | Lighting posture: `surplus`, `normal`, `conserve`, `amber`, `red` or `critical` | text |
| `sensor.ecoflow_panel_lighting_posture_reason` | `ecoflow_lighting_posture_reason` | Why the posture is what it is (diagnostic) | text |

## Panel circuits

Two entities per circuit of the Smart Home Panel 2, named from the circuit (paired legs read
"Name L1" and "Name L2"). They are published once the first poll lists the circuits, and both
are removed when a circuit leaves the panel.

| entity_id (fresh install) | unique_id | Meaning | Unit |
|---|---|---|---|
| `sensor.ecoflow_panel_<circuit>_energy` | `ecoflow_circuit_<ch>_lifetime_kwh` | Lifetime energy of circuit `<ch>` (`total_increasing`) | kWh |
| `sensor.ecoflow_panel_<circuit>_power` | `ecoflow_circuit_<ch>_watts` | Live power of circuit `<ch>`; unknown, never 0, when the panel does not report it | W |

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
| `switch.ecoflow_panel_alarms_critical_p1` | `ecoflow_alerts_critical` | Announce Critical (P1) alarms | on / off |
| `switch.ecoflow_panel_alarms_high_p2` | `ecoflow_alerts_high` | Announce High (P2) alarms | on / off |
| `switch.ecoflow_panel_alarms_medium_p3` | `ecoflow_alerts_medium` | Announce Medium (P3) alarms | on / off |
| `switch.ecoflow_panel_alarms_low_p4` | `ecoflow_alerts_low` | Announce Low (P4) alarms | on / off |

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

**Gap-free daily history.** Once a day, in the morning (America/Phoenix), Power fetches the
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
| Mute a priority on a schedule | the four alarm-priority switches, unique_ids `ecoflow_alerts_critical` to `ecoflow_alerts_low` (entity_ids `switch.ecoflow_panel_alarms_*` on a fresh install) | Muting hides nothing from the dashboard |
