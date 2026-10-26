# EcoFlow Panel — Complete System & Engine Reference

This is the definitive technical reference for the **ecoflow-panel** Home Assistant add-on: a life-safety solar/battery monitor and depletion alarm for an EcoFlow Smart Home Panel 2 and its Delta Pro Ultra battery/inverter Cores. A figure labelled **reference plant** comes from the reference deployment (a grid-tied home in Phoenix, AZ with a 42-panel array and an EVSE) and is a built-in value that a home's own options replace; see [setting Power up for your home](../guide/your-home.md). It documents **every** feature and engine — what each does, its inputs, the exact algorithm and math it computes, how data traces through the pipeline to it and where its output goes, the endpoints and sensors it produces, the configuration knobs that tune it, and its edge-case guards.

The add-on is a Node/TypeScript server (`server/`) that ingests EcoFlow cloud MQTT, persists a SQLite time-series, runs ~40 analytics engines in a worker thread, and exposes the results over an HTTP API (`:8787`), Home Assistant MQTT-discovery sensors, a React web dashboard, and a control-room console served in the browser at `/console` and, when enabled, over SSH (`:2323`, off by default). It also drives an **audible** alarm (chimes + text-to-speech over Home Assistant media players and an optional announce-capable SIP phone) when the battery is projected to deplete.

> Every constant, formula, endpoint path, and config key below was written from the source; how far each chapter has been checked against the code since is stated under **How this reference is organised**. Where a value is a tunable default, that is noted. For install steps and a high-level tour, see `README.md`; for the full option list, see [the option reference](../guide/options.md); for the options→env bridge and the security posture, see chapter 12, **Configuration, Deployment, Security & Operations**.


## How this reference is organised

This is the engineering reference for Power, the `ecoflow_panel` add-on: what each engine computes, from
which inputs, with which guards, and where its output goes. Running the add-on day to day (setup, alarms,
options, entities, troubleshooting) is covered by the operator guide,
[`ecoflow_panel/DOCS.md`](../../ecoflow_panel/DOCS.md), which Home Assistant shows on the add-on's
Documentation tab.

These chapters were one file, `ecoflow_panel/DOCS.md`, until it outgrew what Home Assistant renders quickly
and what GitHub renders at all. They were moved here byte for byte. The only edits the move made are this
index in place of the old table of contents, pointers where content moved out (the engineering release log
and the operations audits to [`docs/history/`](../history/), the option table to
[`docs/guide/options.md`](../guide/options.md)), three control bytes written out as text, and placeholders
such as `<age>` put in code spans so that GitHub shows them; the move did not re-check the chapters against
the code. Later releases edit them in place where the code changed: figures measured on the reference
deployment are labelled **reference plant**, and the passages on the site clock, the tariff, the PV array,
the devices and the plant limits name the options that now set them. A passage no release has touched is as
it stood in the single-file manual.

Section numbers are chapter-local. A `§N` or `§N.M` inside a chapter means that chapter's own numbered
heading unless it names another chapter (`§15.8b` is section 8b of chapter 15). Chapters 2, 8 and 15 are
split into parts, and their section numbers run on across the parts.

## Chapters

<!-- chapters:start -->
- [1. System Architecture & Data Flow](01-architecture.md)
- [2. EcoFlow Cloud Integration & Home Assistant Wiring, part 1 — the IoT-Open protocol, request signing, MQTT telemetry, the snapshot store, projections, SHP2 membership, cloud-wedge classification](02-1-cloud-protocol-and-snapshot.md)
- [2. EcoFlow Cloud Integration & Home Assistant Wiring, part 2 — the Home Assistant service layer, MQTT discovery and the Energy Dashboard, the write-command framework, the HTTP API, sections 2.14–2.16](02-2-home-assistant-wiring.md)
- [3. Solar & PV Forecast Engine](03-solar-forecast.md)
- [4. Physics-Based & Bayesian Model Tier](04-physics-and-bayes.md)
- [5. Runway, Depletion & Battery-SoC Alarms (safety-critical)](05-runway-and-soc-alarms.md)
- [6. Battery & PV Health Engines (SoH, EOL, pack-risk, resistance, RTE, thermal, soiling)](06-health-engines.md)
- [7. Energy Accounting, Self-Consumption, Cost & Dispatch](07-energy-and-cost.md)
- [8. Alerts, Anomaly Detection, Incidents & Learning Loop, part 1 — sections 1–3: the alert taxonomy, threshold alerts, the learned-alert families](08-1-alerts.md)
- [8. Alerts, Anomaly Detection, Incidents & Learning Loop, part 2 — sections 4–14: the alert monitor, notification delivery, outcome capture, repair issues, resolve integrity](08-2-alert-monitor.md)
- [9. The Online Learning Loop (shadow models, online regression, model health)](09-learning-loop.md)
- [10. Audible Broadcast, Chimes & Text-to-Speech](10-audible-broadcast.md)
- [11. User Interfaces: Web Dashboard & SSH TUI](11-user-interfaces.md)
- [12. Configuration, Deployment, Security & Operations](12-configuration-deployment-security.md)
- [13. Safety & Operational Plumbing](13-safety-plumbing.md)
- [14. Intelligent Lighting & HVAC Posture (energy-aware automation)](14-lighting-and-hvac.md)
- [15. Night-Charge TOU Arbitrage Advisor, part 1 — sections 1–7: purpose, the tariff model, inputs, the sizing brain, the ledger, outcome scoring](15-1-night-charge-planning.md)
- [15. Night-Charge TOU Arbitrage Advisor, part 2 — sections 8–13: the write-readiness gate, supervised writes, delivery surfaces, configuration, failure modes, the de-bias factors](15-2-night-charge-writes.md)
- [Appendix A — Feature Inventory (evidence linkage)](A-feature-inventory.md)
<!-- chapters:end -->

## Moved sections

A link into the old single-file manual (`ecoflow_panel/DOCS.md#…`) now opens the top of the operator guide.
Every heading id that was linked (from this repository or from the old table of contents), and every section
that moved out of the chapters, is listed here with the file it is in now. Headings moved unchanged, so the
id is the same in its new file.

| Old anchor | Now |
|---|---|
| `#table-of-contents` | [Chapters](#chapters) |
| `#1-system-architecture--data-flow` | [01-architecture.md](01-architecture.md#1-system-architecture--data-flow) |
| `#2-ecoflow-cloud-integration--home-assistant-wiring` | [02-1-cloud-protocol-and-snapshot.md](02-1-cloud-protocol-and-snapshot.md#2-ecoflow-cloud-integration--home-assistant-wiring) |
| `#the-ecoflow-iot-open-cloud-protocol-no-lan` | [02-1-cloud-protocol-and-snapshot.md](02-1-cloud-protocol-and-snapshot.md#the-ecoflow-iot-open-cloud-protocol-no-lan) |
| `#cloud-wedge-vs-real-outage-classification-devicelinkts` | [02-1-cloud-protocol-and-snapshot.md](02-1-cloud-protocol-and-snapshot.md#cloud-wedge-vs-real-outage-classification-devicelinkts) |
| `#3-solar--pv-forecast-engine` | [03-solar-forecast.md](03-solar-forecast.md#3-solar--pv-forecast-engine) |
| `#4-physics-based--bayesian-model-tier` | [04-physics-and-bayes.md](04-physics-and-bayes.md#4-physics-based--bayesian-model-tier) |
| `#5-runway-depletion--battery-soc-alarms-safety-critical` | [05-runway-and-soc-alarms.md](05-runway-and-soc-alarms.md#5-runway-depletion--battery-soc-alarms-safety-critical) |
| `#6-battery--pv-health-engines-soh-eol-pack-risk-resistance-rte-thermal-soiling` | [06-health-engines.md](06-health-engines.md#6-battery--pv-health-engines-soh-eol-pack-risk-resistance-rte-thermal-soiling) |
| `#7-energy-accounting-self-consumption-cost--dispatch` | [07-energy-and-cost.md](07-energy-and-cost.md#7-energy-accounting-self-consumption-cost--dispatch) |
| `#8-alerts-anomaly-detection-incidents--learning-loop` | [08-1-alerts.md](08-1-alerts.md#8-alerts-anomaly-detection-incidents--learning-loop) |
| `#9-the-online-learning-loop-shadow-models-online-regression-model-health` | [09-learning-loop.md](09-learning-loop.md#9-the-online-learning-loop-shadow-models-online-regression-model-health) |
| `#10-audible-broadcast-chimes--text-to-speech` | [10-audible-broadcast.md](10-audible-broadcast.md#10-audible-broadcast-chimes--text-to-speech) |
| `#26-release-log-all-subsystems` | [history/engineering-release-log-1.md](../history/engineering-release-log-1.md#26-release-log-all-subsystems) |
| `#11-user-interfaces-web-dashboard--ssh-tui` | [11-user-interfaces.md](11-user-interfaces.md#11-user-interfaces-web-dashboard--ssh-tui) |
| `#3-hacs-lovelace-cards--removed-v1470` | [history/operations-audits.md](../history/operations-audits.md#3-hacs-lovelace-cards--removed-v1470) |
| `#12-configuration-deployment-security--operations` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12-configuration-deployment-security--operations) |
| `#full-configyaml-option-reference` | [guide/options.md](../guide/options.md) |
| `#apparmor-profile-ecoflow_panelapparmortxt` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#apparmor-profile-ecoflow_panelapparmortxt) |
| `#vendor-api-notes-documented-not-all-used` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#vendor-api-notes-documented-not-all-used) |
| `#12a-vendor-energy-ledger-energyhistoryts-v1820` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12a-vendor-energy-ledger-energyhistoryts-v1820) |
| `#12b-settings-drift-watchdog-settingsdriftts-v1830` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12b-settings-drift-watchdog-settingsdriftts-v1830) |
| `#12c-charge-now-responder-chargenowresponderts-v1840` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12c-charge-now-responder-chargenowresponderts-v1840) |
| `#12d-ha-statistics-export-hastatisticsts-v1890` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12d-ha-statistics-export-hastatisticsts-v1890) |
| `#12e-long-offline-reconnect-auto-audit-reconnectauditts-v1900` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12e-long-offline-reconnect-auto-audit-reconnectauditts-v1900) |
| `#12f-warranty-evidence-export-warrantyexportts-v1900` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12f-warranty-evidence-export-warrantyexportts-v1900) |
| `#12g-sqlite-snapshot-for-external-viewers-dbexportts-v11070` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12g-sqlite-snapshot-for-external-viewers-dbexportts-v11070) |
| `#12h-the-owner-reserve-floor-and-who-is-allowed-to-define-it-v11130v11160-v11190` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12h-the-owner-reserve-floor-and-who-is-allowed-to-define-it-v11130v11160-v11190) |
| `#12i-announcement-delivery-what-a-timeout-means-v11180v11190` | [history/operations-audits.md](../history/operations-audits.md#12i-announcement-delivery-what-a-timeout-means-v11180v11190) |
| `#12j-roster-durability-and-the-audible-cost-of-guessing-v11170` | [history/operations-audits.md](../history/operations-audits.md#12j-roster-durability-and-the-audible-cost-of-guessing-v11170) |
| `#12k-detectors-that-could-not-fire-v11200` | [history/operations-audits.md](../history/operations-audits.md#12k-detectors-that-could-not-fire-v11200) |
| `#12l-the-spare-dpu-list-has-been-inverted-since-2026-08-20-v11210` | [history/operations-audits.md](../history/operations-audits.md#12l-the-spare-dpu-list-has-been-inverted-since-2026-08-20-v11210) |
| `#12m-the-shp2-alone-could-not-trigger-self-heal-v11210` | [history/operations-audits.md](../history/operations-audits.md#12m-the-shp2-alone-could-not-trigger-self-heal-v11210) |
| `#12n-the-announce-path-v11220` | [history/operations-audits.md](../history/operations-audits.md#12n-the-announce-path-v11220) |
| `#12o-reports-that-claimed-more-than-they-knew-v11230` | [history/operations-audits.md](../history/operations-audits.md#12o-reports-that-claimed-more-than-they-knew-v11230) |
| `#12p-notifications-are-home-assistant-native-v11240` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12p-notifications-are-home-assistant-native-v11240) |
| `#12q-the-outage-cushion-re-scoped-v11250` | [12-configuration-deployment-security.md](12-configuration-deployment-security.md#12q-the-outage-cushion-re-scoped-v11250) |
| `#13-safety--operational-plumbing` | [13-safety-plumbing.md](13-safety-plumbing.md#13-safety--operational-plumbing) |
| `#14-intelligent-lighting--hvac-posture-energy-aware-automation` | [14-lighting-and-hvac.md](14-lighting-and-hvac.md#14-intelligent-lighting--hvac-posture-energy-aware-automation) |
| `#15-night-charge-tou-arbitrage-advisor` | [15-1-night-charge-planning.md](15-1-night-charge-planning.md#15-night-charge-tou-arbitrage-advisor) |
| `#appendix-a--feature-inventory-evidence-linkage` | [A-feature-inventory.md](A-feature-inventory.md#appendix-a--feature-inventory-evidence-linkage) |

## History

Frozen, unedited and not part of the printable manual:

- [engineering-release-log-1.md](../history/engineering-release-log-1.md) and
  [engineering-release-log-2.md](../history/engineering-release-log-2.md): the per-release engineering notes
  that were section 2.6 of chapter 10.
- [operations-audits.md](../history/operations-audits.md): sections 12i–12o of chapter 12 and the note on the
  removed HACS cards from chapter 11.
- [reference-plant-notes.md](../history/reference-plant-notes.md): the reference plant's own Core roster and
  its circuit 1 wiring note, from chapter 2 (a circuit name replaced by an example).

What changed in each release is in the [CHANGELOG](../../ecoflow_panel/CHANGELOG.md) and on the
[Releases](https://github.com/tesseractAZ/power/releases) page.
