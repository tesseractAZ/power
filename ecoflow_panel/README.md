# Power

Monitoring, forecasting and battery alarms for an EcoFlow off-grid system: a Smart Home Panel 2
and its Delta Pro Ultra battery Cores.

- A live dashboard in the Home Assistant sidebar, and a control-room console.
- Battery, grid and host alarms, spoken on your speakers and pushed to your phone, with a
  critical alert that sounds through Do Not Disturb.
- A day-ahead solar and battery forecast, and the runway to your reserve.
- Pack health: state of health, cell spread, end-of-life projection and a warranty export.
- Home Assistant entities through MQTT discovery, including Energy Dashboard counters.
- A night-charge planner for the APS R-EV time-of-use rate. It only advises unless you set
  `NIGHT_CHARGE_MODE` to let it raise the panel's backup reserve overnight and, with
  `ARB_OBJECTIVE` set to `cost`, run a force charge. The Documentation tab lists every write
  Power can make.

> [!WARNING]
> Power can warn you only while its host, your network, the EcoFlow cloud and your speakers all
> work. Set `HEARTBEAT_URL` to an outside monitoring service, which alerts you when Power stops
> checking in, and keep the host on an always-on circuit.

**Requirements.** EcoFlow IoT-Open developer keys: Power is cloud-only, with no local API. The
tariff model is APS R-EV only, and scheduling runs on America/Phoenix time. Spoken alarms need
Music Assistant speakers and Piper; entities need an MQTT broker.

**Start here.** Open the **Documentation** tab for setup, what each alarm means, what Power
writes to your system and troubleshooting. Enter your keys on the **Configuration** tab.

- [Option reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/options.md)
- [Entity reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/entities.md)
- [Engineering reference](https://github.com/tesseractAZ/power/blob/main/docs/reference/README.md)
- [Security policy](https://github.com/tesseractAZ/power/blob/main/SECURITY.md)
- [Releases](https://github.com/tesseractAZ/power/releases) and
  [issues](https://github.com/tesseractAZ/power/issues)
