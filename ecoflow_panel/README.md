# Power

Time-of-use arbitrage planning, forecasting, battery analytics and life-safety alarms for an
EcoFlow off-grid system: a Smart Home Panel 2 and its Delta Pro Ultra Cores. Power runs
more than 40 engines over live and recorded telemetry; its
[engine index](https://github.com/tesseractAZ/power/blob/main/docs/reference/A-feature-inventory.md#a13-engine-index)
states whether each one reports, advises or can act.

*An independent open-source project, not affiliated with or endorsed by EcoFlow.*

- **Time-of-use night-charge planning.** Every 30 minutes Power simulates your battery hour by
  hour through the coming cheap window to the start of the next, up to four days ahead, on
  worst-case inputs (P10 solar, P90 load and any predicted EV charge) and sizes the grid charge
  that keeps your reserve plus an outage cushion: by default, 4 hours of your backup circuits'
  measured load × 1.25. APS R-EV is built in; `TARIFF_PLAN` describes others.
- **Writes only when you allow them.** By default Power only advises. With `NIGHT_CHARGE_MODE`
  set to supervised it makes at most one announced, cancellable backup-reserve raise per charge
  night, within 10–50%, read back and restored before on-peak; with `ARB_OBJECTIVE` set to cost
  it can also run the panel's force charge, just in time.
- **Every night scored.** Each night's plan is recorded and scored against your meters; the
  record tunes the next night's load margin within bounds, and a readiness check grades it.
- **Forecasts.** Solar learned from your own array, home load with predicted EV sessions, a
  P10–P90 band narrowed to its own past errors, and the runway: how long your battery lasts if
  the grid fails now.
- **Battery and PV health.** State-of-health fade and end-of-life projection per pack, internal
  resistance, coulombic and round-trip efficiency, charge-curve drift, cell spread,
  defective-pack detection, soiling, shade and clipping, and a warranty export.
- **Anomaly detection.** Pack, board and MPPT temperatures and each circuit's load against their
  own typical for the hour, each pack against its siblings, each Core's solar against its peers.
- **Alarms.** Battery, cell, grid, host and telemetry alarms on screen and, once enabled, spoken
  on your speakers and pushed to your phone; a critical alert sounds through Do Not Disturb.
- **Checked telemetry.** A replayed panel payload is caught and kept out of history; a collapsed
  message rate or a silent device raises an alert; a removed pack's stale slot is hidden.
- **Home Assistant.** A sidebar dashboard, a control-room console in the browser and over SSH and, with MQTT discovery on, about 100 entities plus per-circuit power and energy
  sensors for the Energy Dashboard.

> [!WARNING]
> Power can warn you only while its host, your network, the EcoFlow cloud and your speakers all
> work. Set `HEARTBEAT_URL` to an outside monitoring service, which alerts you when Power stops
> checking in, and keep the host on an always-on circuit.

**Requirements.** EcoFlow IoT-Open developer keys: Power is cloud-only, with no local API.
Spoken alarms need
Music Assistant speakers and Piper; entities need an MQTT broker.

**Start here.** Open the **Documentation** tab for setup, what each alarm means, every write
Power can make and troubleshooting. Enter your keys on the **Configuration** tab, then set what
differs from the reference home: location, tariff, solar array and any bench spares.

- [Setting Power up for your home](https://github.com/tesseractAZ/power/blob/main/docs/guide/your-home.md)
- [Option reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/options.md)
- [Entity reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/entities.md)
- [Engineering reference](https://github.com/tesseractAZ/power/blob/main/docs/reference/README.md)
- [Security policy](https://github.com/tesseractAZ/power/blob/main/SECURITY.md)
- [Releases](https://github.com/tesseractAZ/power/releases) and
  [issues](https://github.com/tesseractAZ/power/issues)
