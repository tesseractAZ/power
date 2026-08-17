import type { Alert } from './alerts.js';
import { rateAt, type TariffModel } from './tariff.js';

/**
 * v1.70.0 — ON-PEAK GRID-TO-BATTERY detection.
 *
 * On 2026-08-04 at 17:22 MST — inside the APS R-EV summer on-peak window — the
 * plant was importing 11.6 kW against a 6.5 kW house load with 1.3 kW of PV. The
 * surplus ~6.4 kW was refilling the pack at the most expensive rate of the day,
 * energy the night-charge engine would otherwise buy overnight at a fraction of
 * the price. Nothing detected it; the operator noticed by looking at the numbers.
 *
 * ── What actually caused it (corrected in v1.71.0) ───────────────────────────
 * The trigger was **"Charge Now", a PER-DPU setting** in the EcoFlow app — enabled
 * on individual Delta Pro Ultra units, which is why the draw reached ~16 kW: several
 * Cores each pulling their own AC charge at once.
 *
 * v1.70.0 shipped attributing this to `smartBackupMode: 2` on the SHP2. That was
 * WRONG, and the evidence is unambiguous: when the operator turned Charge Now off,
 * grid import fell to 0 W while `smartBackupMode` stayed at 2 and every other field
 * in the SHP2 strategy blob was byte-identical. The setting is not on the panel at all.
 *
 * Two lessons encoded here deliberately:
 *  1. NOTHING in the SHP2 strategy — and no DPU field we project — exposes Charge Now
 *     directly. It is invisible in telemetry. That is precisely why this detector must
 *     infer from POWER FLOW rather than read a mode flag: the only observable is the
 *     energy actually moving.
 *  2. Because it is per-DPU, the alert names WHICH Cores are drawing (from each DPU's
 *     `acInWatts`), so the operator knows which units to go turn off rather than
 *     hunting a panel-level setting that was never involved.
 *
 * ── Why this is a WARNING and never critical ──────────────────────────────────
 * Every critical in this system means "something may hurt you or the plant". This
 * one means "you are spending more than you need to". Escalating money to critical
 * would put it in the same audible tier as a grid loss or a battery fault and
 * would teach the operator to discount the tier that must never be discounted.
 *
 * ── The guard that matters more than the detection ────────────────────────────
 * Charging from the grid on-peak is CORRECT when the pack is at or below its
 * reserve: that is the plant buying back its own outage protection, and cost is
 * irrelevant next to being caught empty in a summer outage in Phoenix. This
 * module must stay silent in exactly that case, or it would train the operator to
 * suppress an alert whose advice is sometimes actively dangerous.
 */

/** Watts of grid-to-battery flow that count as "meaningfully charging". Below
 *  this is measurement noise and inverter overhead, not a buying decision. */
export const DEFAULT_MIN_CHARGE_W = 800;

/** How long the condition must hold before alerting. A brief surplus during a
 *  load step (EV plugging in, HVAC compressor start) is not a buying pattern. */
export const DEFAULT_DWELL_MS = 10 * 60_000;

/** Headroom above the reserve before cost is even a consideration. Between the
 *  reserve and this, refilling on-peak is defensible outage preparation. */
export const DEFAULT_RESERVE_HEADROOM_PCT = 10;

export interface PeakDrawConfig {
  minChargeW: number;
  dwellMs: number;
  reserveHeadroomPct: number;
}

export const DEFAULT_PEAK_DRAW_CONFIG: PeakDrawConfig = {
  minChargeW: Number(process.env.PEAK_DRAW_MIN_CHARGE_W ?? DEFAULT_MIN_CHARGE_W),
  dwellMs: Number(process.env.PEAK_DRAW_DWELL_MS ?? DEFAULT_DWELL_MS),
  reserveHeadroomPct: Number(process.env.PEAK_DRAW_RESERVE_HEADROOM_PCT ?? DEFAULT_RESERVE_HEADROOM_PCT),
};

export interface PeakDrawInputs {
  nowMs: number;
  /** Grid import, watts. SAME BASIS as panelLoadW — see gridToBatteryW below. */
  gridImportW: number | null;
  /** House load measured at the panel, watts. */
  panelLoadW: number | null;
  /** Fleet PV production, watts. */
  pvW: number | null;
  /** Pack state of charge, percent. */
  socPct: number | null;
  /** The configured backup reserve, percent. */
  reserveSocPct: number | null;
  /** False when the grid is absent (outage) — nothing to buy. */
  gridPresent: boolean;
  /** Per-Core AC input, so the alert can name which units are drawing. Charge Now
   *  is a per-DPU setting, so "which Core" is the actionable part of the report. */
  coreDraws: CoreDraw[];
  /** v1.80.0 — per-slot force-charge ("Charge Now") state read from the SHP2
   *  quota (ch{n}ForceCharge). label = the slot's Core name (or "AC{n}").
   *  null/absent = the platform did not report it (older data). */
  forceCharge?: { label: string; on: boolean }[] | null;
  /** When this condition was first seen continuously, or null if not currently seen. */
  onsetMs: number | null;
}

/** One Core's grid intake. `acInWatts` is the DPU's own AC input — the same field
 *  `aggregateFleetFlow` sums into `acIn`, so the parts always agree with the total. */
export interface CoreDraw {
  label: string;
  acInWatts: number;
}

/** Cores pulling at least this much are worth naming; below it is standby draw. */
export const CORE_ATTRIBUTION_MIN_W = 500;

/** The Cores actually drawing, biggest first, formatted for the operator. */
export function attributeCores(draws: CoreDraw[]): string | null {
  const active = draws
    .filter((c) => c.acInWatts >= CORE_ATTRIBUTION_MIN_W)
    .sort((a, b) => b.acInWatts - a.acInWatts);
  if (active.length === 0) return null;
  return active.map((c) => `${c.label} (${(c.acInWatts / 1000).toFixed(1)} kW)`).join(', ');
}

export interface PeakDrawVerdict {
  /** True when the plant is buying on-peak energy into the pack beyond need. */
  active: boolean;
  /** Estimated watts flowing from the grid into the battery. */
  gridToBatteryW: number;
  /** Whether we are inside the on-peak window right now. */
  onPeak: boolean;
  periodLabel: string;
  /** Cost of continuing at this rate for an hour, cents. Null when rates are
   *  unconfirmed — an invented number here would be worse than no number. */
  centsPerHour: number | null;
  /** How long the condition has held, ms. */
  heldForMs: number;
  /** Set when detection was deliberately suppressed, for the log. */
  suppressed: 'below-reserve' | 'off-peak' | 'outage' | 'insufficient-data' | null;
  /** Which Cores are drawing, or null when none are individually significant. */
  coreAttribution: string | null;
  /** v1.80.0 — Core/channel labels whose force-charge reads ON; [] = all read
   *  OFF; null = state unknown (not reported). The alert stops inferring. */
  forceChargeOn: string[] | null;
}

/**
 * Grid-to-battery flow.
 *
 * ★ BASIS WARNING. This subtracts a SHP2-measured house load from a DPU-measured
 * grid import. Those are different meters and this codebase has already been bitten
 * once by treating `fleet_grid_import_wh` (DPU ac_in) and `fleet_grid_home_wh`
 * (SHP2 gridWatt) as interchangeable. The subtraction is still the right shape —
 * the grid only has to cover what PV does not — but the residual carries both
 * meters' error, which is why `minChargeW` is set well above nuisance level rather
 * than at zero. This is a "several kW of deliberate charging" detector, and it is
 * deliberately NOT sensitive enough to be an energy-balance instrument.
 */
export function gridToBatteryW(gridImportW: number, panelLoadW: number, pvW: number): number {
  const loadNotCoveredByPv = Math.max(0, panelLoadW - pvW);
  return Math.max(0, gridImportW - loadNotCoveredByPv);
}

export function assessPeakDraw(
  i: PeakDrawInputs,
  tariff: TariffModel,
  cfg: PeakDrawConfig = DEFAULT_PEAK_DRAW_CONFIG,
): PeakDrawVerdict {
  const slice = rateAt(tariff, i.nowMs);
  const idle = (suppressed: PeakDrawVerdict['suppressed']): PeakDrawVerdict => ({
    active: false, gridToBatteryW: 0, onPeak: slice.isOnPeak, periodLabel: slice.periodLabel,
    centsPerHour: null, heldForMs: 0, suppressed, coreAttribution: null, forceChargeOn: null,
  });

  if (!i.gridPresent) return idle('outage');
  if (!slice.isOnPeak) return idle('off-peak');
  if (i.gridImportW == null || i.panelLoadW == null || i.pvW == null) return idle('insufficient-data');

  // ── The safety guard. At or near the reserve, buying on-peak is CORRECT: the
  // plant is restoring outage protection, and that outranks the bill. Staying
  // silent here is the whole reason this alert can be trusted when it does fire.
  if (i.socPct != null && i.reserveSocPct != null
      && i.socPct <= i.reserveSocPct + cfg.reserveHeadroomPct) {
    return idle('below-reserve');
  }

  const toBattery = gridToBatteryW(i.gridImportW, i.panelLoadW, i.pvW);
  if (toBattery < cfg.minChargeW) return idle(null);

  const heldForMs = i.onsetMs == null ? 0 : i.nowMs - i.onsetMs;
  const centsPerHour = slice.centsPerKwh == null ? null
    : (toBattery / 1000) * slice.centsPerKwh;

  return {
    active: heldForMs >= cfg.dwellMs,
    gridToBatteryW: toBattery,
    onPeak: true,
    periodLabel: slice.periodLabel,
    centsPerHour,
    heldForMs,
    suppressed: null,
    coreAttribution: attributeCores(i.coreDraws),
    forceChargeOn: i.forceCharge == null ? null
      : i.forceCharge.filter((f) => f.on).map((f) => f.label),
  };
}

/* ─── onset tracking ──────────────────────────────────────────────────────── */

let onsetMs: number | null = null;

/** Feed the raw (pre-dwell) condition each tick; returns the onset to pass back in. */
export function trackOnset(conditionHolds: boolean, nowMs: number): number | null {
  if (!conditionHolds) { onsetMs = null; return null; }
  if (onsetMs == null) onsetMs = nowMs;
  return onsetMs;
}
/** Test seam. */
export function resetPeakDrawOnset(): void { onsetMs = null; }

/**
 * The whole evaluation for one tick — the ONLY entry point callers should use.
 *
 * Assessing needs an onset, but whether the condition holds is only known FROM an
 * assessment. Rather than export that chicken-and-egg to every call site (where a
 * caller passing `onsetMs: null` every tick would silently mean the dwell never
 * elapses and the alert never fires), it is resolved here: assess once to learn
 * whether the condition holds, advance the onset, then assess again with it.
 *
 * Both passes are pure, so the double call costs nothing and cannot drift.
 */
export function evaluatePeakDraw(
  i: Omit<PeakDrawInputs, 'onsetMs'>,
  tariff: TariffModel,
  cfg: PeakDrawConfig = DEFAULT_PEAK_DRAW_CONFIG,
): PeakDrawVerdict {
  const probe = assessPeakDraw({ ...i, onsetMs: null }, tariff, cfg);
  const holds = probe.suppressed === null && probe.gridToBatteryW > 0;
  const onset = trackOnset(holds, i.nowMs);
  return assessPeakDraw({ ...i, onsetMs: onset }, tariff, cfg);
}

/* ─── the alert ───────────────────────────────────────────────────────────── */

export const PEAK_GRID_DRAW_ALERT_ID = 'peak-grid-draw';

/** v1.80.0 — the cause, READ from the platform instead of inferred. The PD303
 *  doc names `ch{n}ForceCharge` as the per-channel "charge strength" switch —
 *  which is the EcoFlow app's "Charge Now", the July incident's actual cause. */
export function forceChargeText(on: string[] | null): string {
  if (on == null) {
    return ' The usual cause is "Charge Now" (force charge) left enabled on one or more Delta Pro Ultra'
      + ' units — a PER-UNIT setting in the EcoFlow app. The platform did not report its state on this'
      + ' tick, so this is inferred from power flow.';
  }
  if (on.length > 0) {
    return ` The EcoFlow platform reports Charge Now (force charge) is ON for: ${on.join(', ')} — `
      + 'turn it off in the EcoFlow app on that unit to stop the on-peak buying.';
  }
  return ' Charge Now (force charge) reads OFF on all three channels, so this draw comes from another'
    + ' setting — check each unit\'s task mode and AC charging power in the EcoFlow app.';
}

export function peakGridDrawAlerts(v: PeakDrawVerdict, nowMs: number): Alert[] {
  if (!v.active) return [];
  const kw = (v.gridToBatteryW / 1000).toFixed(1);
  const mins = Math.max(1, Math.round(v.heldForMs / 60_000));
  const costText = v.centsPerHour == null
    ? ' The tariff rates are not confirmed in config, so the cost is not estimated here.'
    : ` At the current ${v.periodLabel} rate that is about $${(v.centsPerHour / 100).toFixed(2)} per hour`
      + ` more than buying the same energy overnight.`;
  const whoText = v.coreAttribution == null ? '' : ` Drawing now: ${v.coreAttribution}.`;
  return [{
    id: PEAK_GRID_DRAW_ALERT_ID,
    severity: 'warning' as const,
    category: 'Grid' as const,
    device: 'Smart Home Panel 2',
    // 'low' is the floor of the priority union — this must sit below every
    // condition that describes a physical risk, not merely a financial one.
    priority: 'low' as const,
    title: `Charging the battery from the grid during ${v.periodLabel}`,
    detail:
      `About ${kw} kW of grid import has been going into the pack rather than the house for ${mins} minutes, `
      + `while on-peak.${costText} The pack is comfortably above its reserve, so this is not outage protection — `
      + `it is buying at the day's highest rate energy the overnight charge window would buy cheaply.`
      + `${whoText}${forceChargeText(v.forceChargeOn)}`,
    facts: [
      { label: 'Grid → battery', value: `${kw} kW` },
      { label: 'Drawing', value: v.coreAttribution ?? 'no single Core dominant' },
      { label: 'Charge Now (force charge)', value: v.forceChargeOn == null ? 'not reported' : (v.forceChargeOn.length ? `ON: ${v.forceChargeOn.join(', ')}` : 'off on all channels') },
      { label: 'Period', value: v.periodLabel },
      { label: 'Cost rate', value: v.centsPerHour == null ? 'rates unconfirmed' : `$${(v.centsPerHour / 100).toFixed(2)}/h` },
      { label: 'Ongoing for', value: `${mins} min` },
      { label: 'Since', value: new Date(nowMs - v.heldForMs).toISOString() },
    ],
  }];
}
