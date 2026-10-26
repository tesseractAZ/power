# Setting Power up for your home

Power runs out of the box with the built-in values of its reference plant: a grid-tied home in
Arizona on the APS R-EV time-of-use tariff, with one Smart Home Panel 2, its Delta Pro Ultra
Cores and a 16.8 kWp array. Every one of those values can be replaced by an option, and each is
listed below with what to measure and where to find it. A key you leave unset keeps
the built-in value, so set the ones that differ for your home. Every key, its range and what
unset means: [the option reference](options.md).

A key with no default is hidden on the **Configuration** tab until you choose **Show unused
optional configuration options**. Saving restarts the add-on.

While the reference plant's values evidently describe another home, a notice and a repair issue,
"The reference home's defaults are in effect", say why: the site's time zone is not
America/Phoenix while `TARIFF_PLAN` is unset, or the site is more than 50 km from the placeholder
coordinates while no `PV_*` key is set. At every start the add-on log names the time zone, where
the coordinates come from and the PV array in use; `GET /api/site` returns the same facts, with
the currency and each Core's strings.

## Time zone

Leave `SITE_TIMEZONE` empty. Power then runs on Home Assistant's time zone, which the Supervisor
passes to the add-on (America/Phoenix if the container has none), so set that zone under
**Settings → System → General**. The zone runs the nightly notice, the charge window, the tariff
periods, quiet hours, the morning digest, the daily totals and jobs, the console's clocks, and
the dashboard's charge-window, Today and forecast times. It is read once at start: after
changing Home Assistant's zone, restart the add-on.

Set `SITE_TIMEZONE` only when the schedule must run in a different zone from Home Assistant's, as
an IANA name such as `Europe/Berlin`. A zone that differs from Home Assistant's raises a warning
and a repair issue, so the difference is never a surprise. A name Power does not know raises a
repair issue and is ignored: the next source applies, never UTC. The add-on log names the zone at
every start, with where it came from.

Set the same zone on the panel in the EcoFlow app. The panel keeps its own clock for its
charge-schedule windows and its daily energy record, and the cloud does not report it, so Power
cannot tell when the two differ.

Zones whose offset from UTC is not a whole number of hours (Asia/Kolkata, for example) are not
supported: Power's hourly figures assume a local hour starts on a UTC hour.

## Location

Set `FORECAST_LAT` and `FORECAST_LON` to your site, in decimal degrees, north and east positive.
The defaults are a placeholder (a city centre in Arizona). Every solar forecast is fetched for
these coordinates, so the runway and the night-charge plan rest on them, and they decide where
day is told from night. Read them off a map at your roof; two decimal places are enough. A
notice and a repair issue appear when Home Assistant's home location is more than 50 km from
them. To use Home Assistant's home location instead, turn on `SITE_LOCATION_FROM_HA`: Power reads
it in the background after a start, saves it and uses it from the next start, so the coordinates
never change while it runs. A repair issue asks for that restart.

## Tariff

Power prices energy and plans the night charge on a tariff model, chosen by `TARIFF_PLAN`:

| Your tariff | Set |
|---|---|
| APS Rate Schedule R-EV | Nothing: it is the built-in preset (`TARIFF_PLAN` `aps_r_ev` names it explicitly, which also silences the tariff half of the notice above). Enter its rates in the `TARIFF_APS_*` keys, then turn on `TARIFF_APS_RATES_CONFIRMED`. |
| One price at every hour | `TARIFF_PLAN` `flat` and `TARIFF_FLAT_CENTS_PER_KWH`. A flat tariff has no cheap window, so the night-charge planner holds. |
| One on-peak block a day, one price otherwise | `TARIFF_PLAN` `two_tier`, `TARIFF_ON_PEAK_HOURS` (site hours, end-exclusive, such as `16-21`), `TARIFF_ON_PEAK_DAYS` (`1-5` is Monday to Friday, 1 being Monday), `TARIFF_ON_PEAK_CENTS` and `TARIFF_OFF_PEAK_CENTS`. Unset, the hours and days are `15-20` and `1-5`. A two-tier tariff has no cheap window either, so the night-charge planner holds; `NIGHT_CHARGE_CHEAP_PERIOD` `off_peak` makes the off-peak hours the window, one night at a time (from the end of on-peak to its start the next day, on weekend nights too). To charge at night only, write it as `custom` with a night period flagged `cheap`. |
| Anything else | `TARIFF_PLAN` `custom`, `TARIFF_PERIODS` and `TARIFF_RATES`. |

Take the periods and the seasons from your utility's rate sheet, and the rates from a recent
bill: the effective price per kWh, with every per-kWh adjustor, rider and tax included, not the
base rate the sheet prints. Then:

- **Periods** (`custom`). Write each period with its hours in site time, its days and its
  season, and flag the on-peak period `onpeak` and the period the night charge should buy in
  `cheap`, whatever its name. For example `on_peak 16-21 mon-fri all onpeak; night 00-06 mon-fri all cheap`.
  Hours are end-exclusive, and a start above the end runs past midnight; days are `all`, a day,
  a range such as `mon-fri` or a comma list; the season is `all`, `summer` or `winter`; where two
  periods overlap, the one listed first applies. Every hour no period covers is `off_peak`. The
  nightly job then runs before the cheap period opens: set `NIGHT_CHARGE_NOTIFY_HOUR` early
  enough to leave time to cancel a charge. An hour at or after the open is moved to the hour
  before it (22 at the latest), and a repair issue says so.
- **Rates** (`custom`). The ¢/kWh of each period, summer then winter, or one figure for both;
  `-` where a season has no rate; `off_peak` needs a rate too:
  `on_peak=34/29; off_peak=15/14; night=9`.
- **Seasons and holidays.** `TARIFF_SUMMER_MONTHS` is the summer months of use, `4-9` when unset
  (`10-3` in the southern hemisphere). `TARIFF_HOLIDAYS` lists the days your utility prices
  off-peak all day, as comma-separated `YYYY-MM-DD` dates, or `none`. Unset, a plan has none,
  except the APS preset, which keeps the APS holiday rule.
- **Fixed charge.** `TARIFF_FIXED_DAILY_CENTS`, if the bill has a daily service charge.
- **Currency.** `TARIFF_CURRENCY`, the ISO 4217 code of your currency: USD (when unset), EUR,
  GBP, CAD or AUD. Any other code keeps USD and raises a repair issue. Set it before the cost
  entities first appear in Home Assistant: changing it later changes the unit of their long-term
  statistics, which Home Assistant then asks you to repair.
- **Confirm.** Turn on `TARIFF_RATES_CONFIRMED` once the rates are off a bill; while it is
  unset, `TARIFF_APS_RATES_CONFIRMED` decides. Until then the cost and savings figures use the
  flat rate, except on a `two_tier` plan: its two rates price its on-peak window and every other
  hour, in the cost figures and the dispatch planner alike.

A tariff setting that cannot be read (a plan that does not parse, a missing rate, or
`TARIFF_PERIODS` without `TARIFF_PLAN` `custom`) is never replaced by the APS preset: every
price reads unknown, the cost figures fall back to the flat rate, a repair issue names the
option, and the night-charge planner holds until it is fixed.

## Solar array

The physics model uses the reference plant's 16.8 kWp array, tilted 25° and facing south, until
you describe yours:

- `PV_ARRAY_KWP`: the panels' total nameplate, from the panel datasheet or your installer's
  paperwork (number of panels × watts each ÷ 1000). Set it whenever you set another `PV_*` key:
  without it the model keeps the reference 16.8 kWp, and the log says so.
- `PV_TILT_DEG`: the roof or rack pitch from horizontal.
- `PV_AZIMUTH_DEG`: the direction the panels face, clockwise from north (180 is south, 90 east).
- `PV_STRINGS`: the panels on each Core's high-voltage and low-voltage solar inputs, for the
  **Solar** page, for example `hv=10x400,lv=4x400` (`hv=0` is no string). When one Core's strings
  differ, add its layout after a semicolon, keyed by its panel slot or its Core name:
  `hv=10x400,lv=4x400; slot2=hv=8x450`. A layout that does not parse leaves the default
  (10 + 4 panels of 400 W on every Core) and raises a repair issue.

Once any `PV_*` key is set, the physics also takes the site's coordinates (above) and the
weather forecast's hourly temperature in place of a fixed 30 °C.

## EV charging

Power recognises an EV charging session as a long, steady draw on a panel circuit:

- `EV_MAX_LOAD_W`: your charger's largest draw in W, from its rating plate or app (amps × volts).
- `EV_CHARGER_COUNT`: how many chargers can run at the same time (1 when unset; up to 4).
  `0` when you have none, so no circuit is taken for a car.
- `EV_PLATEAU_MIN_W`: the draw that counts as charging. Set it a little below your car's usual
  charging power, read from the circuit's power sensor during a session.
- `EV_CIRCUITS`: the panel circuit numbers your chargers are on (1–12, comma-separated), so other
  large loads are not taken for a car. Unset, every circuit is scanned.

## Devices

**Bench spares.** A Core kept off the panel, on a shelf or for service, would otherwise raise
offline alarms. List its serial in `BENCH_SPARE_SNS` (comma-separated), or write `none` when you
have no spare. The list replaces the built-in one; it does not add to it. A serial that matches
no device on the account raises a repair issue. Power never decides a Core is a spare because it
is missing: a Core that drops off the panel through a fault still alarms.

**Names.** Power names a Core after its EcoFlow device name. Rename each Core "Core 1",
"Core 2" and so on in the EcoFlow app: its number comes from that name, and a device whose name
starts with "core " is taken for a Delta Pro Ultra when the cloud does not report its product
name. A Core left under its product name is numbered by its panel slot. To name a device in Power
only, set `DEVICE_ALIASES` to a JSON object of names by serial, for example
`{"<serial>":"Core 4"}`.

**Panels.** Power supports one Smart Home Panel 2 fully. With a second panel, the house panel is
the one that stood alone on the account when Power first saw it; with two panels and none
pinned, the dashboard asks you to pin one, and the night-charge writes wait until you do. The
second panel gets its own charge-level ladder and runway, and nothing else.

## Grid connection and the night charge

- `ARB_GRID_INPUT_CAP_KW`: your grid-input breaker capacity, in kW (amps × volts ÷ 1000). The
  default is the reference plant's measured figure. The night-charge plan shares this between
  the house and the batteries; `0` turns that sharing off, so enter the real figure.
- `FORCE_CHARGE_KW_PER_CORE`: the grid charge rate one Core takes under force charge, in kW
  (5.5 when unset). Read it from the Core's input power during a force charge with the house
  drawing little.
- `ARB_OUTAGE_CUSHION_HOURS`: how long the panel's circuits must run on the batteries in an
  outage that starts as the charge window closes, before you can act.

## Runway

The runway charges the pool for the standby power the Cores and the panel draw: the larger of a
floor, `RUNWAY_POOL_OVERHEAD_FLOOR_W` (270 W, fitted on three Cores), and `RUNWAY_CORE_OVERHEAD_W`
(90 W) for each connected Core. With one or two Cores, lower the floor to about 90 W per
connected Core; with more than three, the per-Core figure already sets it. To measure yours,
compare the pool's discharge power with the panel's load on a quiet night with the house on the
batteries: the difference is the overhead.

## Carbon and wear

- `GRID_CO2_INTENSITY_LB_PER_MWH`: your grid's average carbon intensity, in lb of CO2 per MWh.
  Utilities and grid operators publish it, often as an annual emissions factor. The built-in
  1100 is an Arizona average.
- `CYCLING_BASE_WEAR_USD_PER_KWH`: what one kWh of battery cycling costs you in wear, in your
  currency.

## Also check

- **Spoken language.** Alarms are spoken in English, and also in Spanish once
  `BROADCAST_BILINGUAL` is on and a Spanish voice is set (`BROADCAST_WYOMING_VOICE_ES`). No other
  second language is available.
- **Sheddable loads and the surplus advisor.** `LOAD_SHEDDING_SHED_ENTITIES` names your
  sheddable loads, and `OPPORTUNISTIC_LOADS` replaces the built-in list of loads to run on surplus
  solar (a pool pump, a dehumidifier, air-conditioning pre-cooling, a water heater and an EV),
  as `id:watts:category[:label]` entries (category `pool`, `ev`, `water`, `hvac` or `other`), or
  `none`.
- **The charge-level alarm.** `BATTERY_SOC_LADDER` replaces the charge levels the SoC alarm
  speaks at, as `pct:tier` entries (tier `low`, `medium`, `high` or `critical`); unset, the levels
  are 50, 40, 30, 20, 15, 10, 8, 4 and 2 %.
- **Host power.** `HOST_POWER_ENTITY` names the Home Assistant `binary_sensor` that reports the
  host's under-voltage (on a Raspberry Pi, the Power Supply Checker's), so Power warns of a
  browning-out host before it goes dark.
