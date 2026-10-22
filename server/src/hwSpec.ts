/**
 * hwSpec.ts — hardware and protocol facts of the SHP2 and the DELTA Pro Ultra. Constants, not options
 * (plan section 8): they hold for every panel and every Core, so there is nothing to configure.
 *
 * v1.191.0 (S2, CA27) — landed as the shared source of these figures so lane D (devices), lane E
 * (limits) and lane B (tariff) read one definition; each lane moves its own consumers onto these
 * exports. The values are today's, unchanged. Lane D's consumers: ecoflow/project.ts (packs, circuits,
 * source slots), ecoflow/mqttTranslate.ts (packs), ecoflow/commands.ts (slot and force-charge ceiling
 * ranges), alerts.ts (SoH bands, mains) and the LAN console's plant screens (mains).
 */

/** SHP2 energy-source slots (`pd303_mc` sources 1..3). */
export const SHP2_SOURCE_SLOTS = 3;
/** SHP2 load circuits (channels 1..12). */
export const SHP2_CIRCUIT_COUNT = 12;
/** A DELTA Pro Ultra takes at most five battery packs (one in the inverter, four extra). */
export const DPU_MAX_PACKS = 5;
/** One pack's nominal string voltage: 32 LFP cells × 3.2 V. */
export const DPU_PACK_NOMINAL_V = 102.4;
/** One pack's nameplate energy (6.144 kWh), the fleet-capacity fallback figure. */
export const DPU_PACK_NAMEPLATE_WH = 6144;
/** The corrupt-read guard: a pack reporting more than this is a bad reading (OWNER DECISION 11 keeps both figures). */
export const DPU_PACK_GUARD_WH = 6200;
/** The panel's backup-reserve write range: the 10 % floor is a safety rule, the 50 % ceiling is firmware. */
export const RESERVE_WRITE_MIN_PCT = 10;
export const RESERVE_WRITE_MAX_PCT = 50;
/** The panel's documented force-charge ceiling range (`foceChargeHight`). */
export const FORCE_CHARGE_CEILING_MIN_PCT = 80;
export const FORCE_CHARGE_CEILING_MAX_PCT = 100;
/** North American split-phase mains. */
export const MAINS_V = { line: 120, split: 240 } as const;
/** A pack's state of health (SoH, %) below which the alert engine warns, and below which it is critical
 *  (alerts.ts). v1.191.0 (lane D) — moved here from alerts.ts, values unchanged. */
export const SOH_WARN_PCT = 85;
export const SOH_CRIT_PCT = 75;
