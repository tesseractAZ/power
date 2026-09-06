# BLE probe runbook — optional cloud-independent DPU cross-check

> **Status: NOT PURSUED — retained as a reference procedure (reviewed 2026-09-06).**
>
> This runbook was written 2026-06-25 (v0.72.0) to evaluate reverse-engineered EcoFlow BLE as an
> *optional secondary* telemetry source. **The motivating problem was solved another way and the
> probe was never carried through**, so nothing below has been executed against this fleet — treat
> every step as untried.
>
> Two things settled it. First, the recurring "cloud-offline" pain that prompted it turned out to
> be an EcoFlow cloud **session** wedge rather than radio loss, and the fix that shipped is the
> cloud-wedge-vs-real-outage classification plus LAN reachability per DPU — see the closing
> section. Second, the decision gates below were never going to be passed by a source with BLE's
> range, decode fragility and per-firmware breakage: it can never be an alarm authority here, and
> the *only* role left for it was a nice-to-have cross-check nobody needed once the real cause was
> understood.
>
> It is kept because the research is sound and the constraint it documents is durable — the DPU
> and SHP2 expose **no LAN-IP protocol at all**, so if a cloud-independent path is ever wanted
> again, this is the only one that exists and these are the gates it would have to clear. Do
> **not** read it as an open invitation to run the probe.

## Why BLE (and why only as a cross-check)
Research (2026-06-25, see `memory/project_ecoflow_lan_feasibility.md`) established that the Delta Pro
Ultra (DPU, `EF-YJ`/`hs_yj751`) and SHP2 (`EF-HD3`/`pd303`) expose **no LAN-IP protocol** — no Modbus,
no local HTTP, no honor-a-local-MQTT-broker. The *only* genuinely cloud-free telemetry path is
reverse-engineered **BLE** via [`rabits/ha-ef-ble`](https://github.com/rabits/ha-ef-ble) +
[`rabits/ef-ble-reverse`](https://github.com/rabits/ef-ble-reverse). It decodes per-pack SoC/power/
temp and port power for the DPU. It is unsuitable as a *primary/alarm* source because it is:
single-BLE-connection (the EcoFlow phone app and the add-on cannot both connect), RF/range-bound,
firmware-fragile (a FW update can silently break decoding), and — critically for SHP2 — only exposes
per-circuit channels, **not** the `backupIncreInfo` aggregate the floor/SoC/runway alarms depend on
(re-summing channels reintroduces the exact over/under-count we engineered against).

## What this probe answers (the decision gates)
1. **Stability** — over a continuous 24–48 h read, what is the disconnect / `unavailable` rate?
2. **Contention** — when you open the EcoFlow phone app, does the BLE read starve (it shares the one
   allowed BLE connection)? How long until it recovers?
3. **Field coverage** — does the decoded field set actually cover what we'd cross-check (per-pack SoC,
   pack power, AC/MPPT port power, runtime)?
4. **Self-consistency** — do BLE values track the cloud values field-by-field (shadow comparison)?
5. **SHP2 only:** can per-circuit BLE channels faithfully reconstruct `backupIncreInfo`? (Expected: **no.**
   If it can't, SHP2 BLE stays diagnostic-only and never touches an alarm input.)

## Hardware
- **DPU (start here):** a BLE radio within range of one DPU. Options: the HA Pi's built-in BLE if a DPU
  is close enough, otherwise an **ESP32 BLE proxy** (ESPHome `bluetooth_proxy`) near the unit.
- **SHP2 (later, optional):** the SHP2 is a high-bandwidth BLE peer — plain ESPHome proxies drop
  packets; the `ha-ef-ble` maintainer recommends an **Ethernet-backed ESP32** (Waveshare
  ESP32-S3-ETH) proxy (`ha-ef-ble` issue #221). SHP2 BLE must also be manually enabled via the
  panel's physical IoT button.

## Procedure (read-only, shadow)
1. **One-time provisioning (the residual cloud dependency):** obtain your EcoFlow account `userId`
   (from the EcoFlow app's MMKV store or by logging into the EcoFlow site → `data.user.userId`). The
   local BLE key is derived as `md5(userId + deviceSN)`; after this the BLE session is fully local.
   *Note: "cloud-free" is true at runtime only — provisioning still needs a one-time cloud login.*
2. **Stand up `rabits/ha-ef-ble`** (HACS custom integration) OR a standalone `ef-ble-reverse` harness,
   pointed at **one DPU**, in read-only mode. Do not enable any control entities.
3. **Run continuously for 24–48 h.** Log: connect/disconnect events, `unavailable` windows, decoded
   fields + their values at ~1-min cadence.
4. **Contention test:** at a known time, open the EcoFlow phone app for ~5 min and note how the BLE
   read behaves (expect it to starve) and how fast it recovers after you close the app.
5. **Shadow comparison:** line up BLE per-pack SoC / pack power against the add-on's cloud-derived
   values for the same timestamps; quantify the divergence.
6. **Decision gate:** proceed to a shadow-mode adapter **only if** the DPU read is stable
   (low disconnect rate), self-consistent with cloud (small, explainable divergence), and survived the
   contention test acceptably. Otherwise stop — BLE is not viable here.

## Integration seam (only after the gate passes)
- Emit raw maps keyed in the exact REST dot-keys the projectors read
  (`hs_yj751_pd_appshow_addr.*`, `hs_yj751_bms_slave_addr.{1..5}.*`) and feed them via
  `SnapshotStore.mergeDeviceQuota(sn, partial, 'local_ble')` (`server/src/snapshot.ts:233`) into a
  **parallel/shadow channel only**.
- Widen the `lastSourceBySn` union (`snapshot.ts:58`) and the alert-enrichment provenance map
  (`alertMonitor.ts:739`) to carry `'local_ble'` so the source is explicit, never silently coerced
  into `'rest'`/`'mqtt'`.
- Run shadow mode for a sustained period; the alarm engine keeps consuming **cloud only**. Compare
  field-by-field; log divergences.

## Hard rules (non-negotiable for this alarm system)
- BLE is **diagnostic / secondary only** — it must **never** overwrite or satisfy an alarm input on
  its own, and a **RED alarm is never suppressed** by a local-only read.
- SHP2 aggregate fields (`backupIncreInfo.*`) stay **cloud-authoritative** unless the probe
  conclusively proves faithful BLE reconstruction (it almost certainly won't).
- A self-consistency / coherence guard must **fail CLOSED to cloud** — a broken/forked BLE decode
  (e.g. after a firmware update) degrades to "no local cross-check," never to a bad value the alarm
  trusts.
- The cloud source remains the validated alarm authority throughout.

## Relationship to the resilience track (shipped separately)
The *actual* fix for the recurring "cloud-offline" pain is **not** BLE — it's the cloud-wedge-vs-
real-outage classification (LAN reachability via HA ping sensors) shipped in the add-on, because the
documented root cause is an EcoFlow cloud *session* wedge, not radio loss. BLE here only adds an
optional, cloud-independent **cross-check** for the DPUs if you want one. See
`memory/project_wifi_loss_root_cause.md` and `project_ecoflow_lan_feasibility.md`.
