> [!NOTE]
> Historical, and frozen: notes about the reference plant's own Core roster and circuit wiring,
> moved out of chapter 2 of the engineering reference so that the reference describes any home;
> they are unedited except that a circuit name is replaced by an example. A later release may have superseded what they say. Current behaviour is in the
> [engineering reference](../reference/README.md). This file is not part of the printable manual.

### The reference plant's Core roster

From chapter 2, part 1 (SHP2 membership: home cores vs. spares):

The fleet has **5 DPU cores on the account but only 3 wired into the home SHP2**. The
other two are bench units that report telemetry but cannot deliver energy to the home bus.
Which Cores those are comes from the SHP2's own connected-source roster: since the
2026-08-20 reconfiguration the wired set is Cores 1, 2 and 5 and the bench units are
Cores 3 and 4 (§12l). Every fleet aggregation must exclude spares.

From the same section's description of the spare literal:

- **`SPARE_DPU_SNS`** = the static allowlist of bench-spare serials as written (Core 4,
  Core 5). It is a **floor, not the answer**: a DPU it does not name is never treated as a
  spare. Since the 2026-08-20 reconfiguration it names a wired home Core (Core 5) and omits
  the bench unit Core 3 (§12l).

Roster since the 2026-08-20 reconfiguration: Cores 1/2/5 wired into the SHP2; Cores 3/4 on
the bench. `SPARE_DPU_SNS` still names Cores 4 and 5, and the roster-aware predicates above
correct for it (§12l).

From chapter 2, part 2 (spares):

The literal has been inverted since 2026-08-20 (it names wired Core 5
  and not bench Core 3), so it is never consulted alone (§12l).

### The reference plant's circuit 1 and its energy preferences

From chapter 2, part 2 (circuit power sensors):

**Operator step, HA-side:** for each of the twelve `device_consumption` entries in the
energy prefs, add a `"stat_rate"` naming that channel's power entity. Take the entity_id
from HA's entity registry (unique_id `ecoflow_circuit_<ch>_watts`). HA mints it from the
device and circuit name, e.g. `sensor.ecoflow_panel_kitchen_l1_power`, never
`sensor.ecoflow_circuit_<ch>_power`.
`stat_consumption` is untouched and the Energy tab is unaffected. All three
`energy_sources` already carry `stat_rate`; the twelve devices carry none, and
that is the whole gap.

> Circuit 1 will publish a permanent **0 W** — the unresolved ch1 CT question
> (0.147 kWh lifetime against ch3's 66.6 kWh on a pairing that should be
> comparable), settleable only physically. Publishing pair sums would hide it.
