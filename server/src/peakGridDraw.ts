import type { Alert } from './alerts.js';
import { rateAt, localParts, type TariffModel } from './tariff.js';

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

/* ─── the last observation (for the v1.84.0 Charge Now responder) ─────────── */

export interface PeakDrawObservation {
  verdict: PeakDrawVerdict;
  /** Slot-numbered force-charge states (the responder needs channel numbers
   *  to write; the verdict itself carries only labels). null = not reported. */
  forceChargeSlots: { slot: number; label: string; on: boolean }[] | null;
  atMs: number;
}

let lastObservation: PeakDrawObservation | null = null;
/** Set by the alert monitor tick right after evaluation. */
export function setLastPeakDrawObservation(o: PeakDrawObservation): void { lastObservation = o; }
export function getLastPeakDrawObservation(): PeakDrawObservation | null { return lastObservation; }

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

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.0 — ON-PEAK GRID WHILE THE POOL SITS IDLE ABOVE ITS RESERVE.
 *
 * Mon 2026-09-28: the house bought 4.27 kWh at the on-peak rate (16:00-19:00, 44.2¢,
 * about $1.89) while the house pool sat at 26% against a 16% reserve — ~9 kWh above it —
 * and every SHP2 channel read 0 W from 09-27 22:15 until the night-charge write at
 * 22:55. Nothing reported it: the detector above watches grid flowing INTO the pack, and
 * here the grid fed the house directly while the pack did nothing.
 *
 * Why the pool was idle (measured, 2026-09-13/14/27/28): after the pool stops at its
 * reserve, the panel resumes discharging only once it has climbed back roughly 20 points
 * above the reserve (36-38% against 16). Between the two it holds, and the grid carries
 * the house. 09-28 was a rainy day (9.5 kWh of solar against 37.8 the day before): the
 * pool refilled to 26-28% and never crossed back. An app/cloud mode change the night
 * before (smartBackupMode 2→0→2, 22:12-22:15) and the lost weekend arm (fixed in
 * v1.186.5) put it there. Not recurring on its own — one weekday in 16 — but when it
 * lands on an on-peak afternoon it costs money every hour, silently.
 *
 * What this is NOT:
 *  - Not an alarm. It reports spend, never danger: severity warning (so it can push) at
 *    priority LOW, and EXCLUDED from the audible condition (broadcast.ts
 *    conditionFromAlerts) — money must never chime in the tier a grid loss uses.
 *  - Not a device write. The add-on changes no setting; the notice says what is
 *    happening and where the setting lives.
 *  - Not a second opinion near the reserve. At or within IDLE_HEADROOM_PCT of the
 *    reserve the panel holding the pool IS the panel defending the owner's floor, and
 *    advising otherwise would be advising to spend outage margin (the same guard, for
 *    the same reason, as the grid-to-battery detector's below-reserve band).
 *  - Not a stream. It rises after a 10-min dwell, rides out a brief clear (10 min) so a
 *    load dip does not flap it, and fires at most ONCE per on-peak day.
 * ═════════════════════════════════════════════════════════════════════════ */

export const PEAK_IDLE_POOL_ALERT_ID = 'peak-idle-pool';

/** Grid import (W) at the panel main that counts as "the house is buying". */
export const IDLE_MIN_IMPORT_W = 300;
/** Total |channel watts| at or under which the pool counts as idle: measured 0 W on every
 *  channel through the 09-28 hold; a discharging pool reads kilowatts. */
export const IDLE_MAX_POOL_FLOW_W = 150;
/** Points above the reserve before an idle pool is a cost question at all. */
export const IDLE_HEADROOM_PCT = 5;
export const IDLE_DWELL_MS = 10 * 60_000;
export const IDLE_CLEAR_MS = 10 * 60_000;

export interface IdlePoolConfig {
  minImportW: number;
  maxPoolFlowW: number;
  headroomPct: number;
  dwellMs: number;
  clearMs: number;
}
export const DEFAULT_IDLE_POOL_CONFIG: IdlePoolConfig = {
  minImportW: IDLE_MIN_IMPORT_W,
  maxPoolFlowW: IDLE_MAX_POOL_FLOW_W,
  headroomPct: IDLE_HEADROOM_PCT,
  dwellMs: IDLE_DWELL_MS,
  clearMs: IDLE_CLEAR_MS,
};

export interface IdlePoolInputs {
  nowMs: number;
  /** False during an outage — nothing to buy. */
  gridPresent: boolean;
  /** Grid import at the panel main (SHP2 gridWatt), W. */
  gridImportW: number | null;
  /** House pool SoC and the reserve it is held to, %. */
  socPct: number | null;
  reserveSocPct: number | null;
  /** Per-channel watts between the panel and each Core (backupInfo.chWatt): negative =
   *  the Core discharging into the house, positive = charging from the panel. */
  sourceWatts: readonly number[] | null;
  /** The panel's reading is live (fresh device evidence). A frozen projection is not. */
  fresh: boolean;
  /** Pool capacity (Wh), for the kWh the pool is holding above its reserve. */
  poolFullWh?: number | null;
  /** The panel's smartBackupMode code, reported as found (2 = self-powered on this plant). */
  smartBackupMode?: number | null;
}

export type IdlePoolSuppression =
  | 'outage' | 'off-peak' | 'insufficient-data' | 'near-reserve' | 'pool-active' | 'low-import' | 'fired-today';

export interface IdlePoolVerdict {
  active: boolean;
  onPeak: boolean;
  periodLabel: string;
  gridImportW: number;
  poolFlowW: number;
  socPct: number | null;
  reserveSocPct: number | null;
  /** kWh the pool holds above its reserve; null when the capacity is unknown. */
  aboveReserveKwh: number | null;
  /** The on-peak import's cost for an hour, cents; null on unconfirmed rates. */
  centsPerHour: number | null;
  heldForMs: number;
  /** Why the condition does not hold this tick (null = it holds). */
  suppressed: IdlePoolSuppression | null;
  smartBackupMode: number | null;
}

/** The condition, one tick, no memory. PURE. */
export function classifyIdlePool(
  i: IdlePoolInputs,
  tariff: TariffModel,
  cfg: IdlePoolConfig = DEFAULT_IDLE_POOL_CONFIG,
): { suppressed: IdlePoolSuppression | null; onPeak: boolean; periodLabel: string; centsPerKwh: number | null; poolFlowW: number } {
  const slice = rateAt(tariff, i.nowMs);
  const flows = (i.sourceWatts ?? []).filter((w) => typeof w === 'number' && Number.isFinite(w));
  const poolFlowW = flows.reduce((s, w) => s + Math.abs(w), 0);
  const base = { onPeak: slice.isOnPeak, periodLabel: slice.periodLabel, centsPerKwh: slice.centsPerKwh, poolFlowW };
  if (!i.gridPresent) return { ...base, suppressed: 'outage' };
  if (!slice.isOnPeak) return { ...base, suppressed: 'off-peak' };
  if (!i.fresh || i.gridImportW == null || i.socPct == null || i.reserveSocPct == null || flows.length === 0) {
    return { ...base, suppressed: 'insufficient-data' };
  }
  // ★ The safety guard: near the reserve, a held pool is the panel defending the floor.
  if (i.socPct <= i.reserveSocPct + cfg.headroomPct) return { ...base, suppressed: 'near-reserve' };
  if (poolFlowW > cfg.maxPoolFlowW) return { ...base, suppressed: 'pool-active' };
  if (i.gridImportW < cfg.minImportW) return { ...base, suppressed: 'low-import' };
  return { ...base, suppressed: null };
}

export interface IdlePoolState {
  /** When the condition was first seen holding continuously (pre-dwell). */
  onsetMs: number | null;
  /** When the current episode became active, or null. */
  activeSinceMs: number | null;
  /** When the condition stopped holding during an active episode (the clear dwell). */
  clearSinceMs: number | null;
  /** The local date an episode last rose — at most one per on-peak day. */
  firedDay: string | null;
}
export const emptyIdlePoolState = (): IdlePoolState => ({ onsetMs: null, activeSinceMs: null, clearSinceMs: null, firedDay: null });

/**
 * One tick of the episode machine. PURE: returns the next state and whether the episode
 * is active. An active episode ends at once when on-peak ends or the grid goes, and
 * otherwise only after the condition has stayed away for `clearMs` (a load dip is not a
 * resolution). A new episode needs `dwellMs` of continuous holding and a day with none yet.
 */
export function stepIdlePool(
  st: IdlePoolState,
  holds: boolean,
  ctx: { nowMs: number; onPeak: boolean; gridPresent: boolean; day: string },
  cfg: IdlePoolConfig = DEFAULT_IDLE_POOL_CONFIG,
): { state: IdlePoolState; active: boolean } {
  if (st.activeSinceMs != null) {
    if (!ctx.onPeak || !ctx.gridPresent) {
      return { state: { ...st, onsetMs: null, activeSinceMs: null, clearSinceMs: null }, active: false };
    }
    if (holds) return { state: { ...st, clearSinceMs: null }, active: true };
    const clearSince = st.clearSinceMs ?? ctx.nowMs;
    if (ctx.nowMs - clearSince >= cfg.clearMs) {
      return { state: { ...st, onsetMs: null, activeSinceMs: null, clearSinceMs: null }, active: false };
    }
    return { state: { ...st, clearSinceMs: clearSince }, active: true };
  }
  if (!holds) return { state: { ...st, onsetMs: null, clearSinceMs: null }, active: false };
  const onset = st.onsetMs ?? ctx.nowMs;
  // Once per on-peak day: a second rise the same day stays on the card's history, not the phone.
  if (st.firedDay === ctx.day) return { state: { ...st, onsetMs: onset }, active: false };
  if (ctx.nowMs - onset >= cfg.dwellMs) {
    return { state: { onsetMs: onset, activeSinceMs: ctx.nowMs, clearSinceMs: null, firedDay: ctx.day }, active: true };
  }
  return { state: { ...st, onsetMs: onset }, active: false };
}

let idlePoolState: IdlePoolState = emptyIdlePoolState();
/** Test seam. */
export function resetIdlePoolState(): void { idlePoolState = emptyIdlePoolState(); }

/** The whole evaluation for one tick — the ONLY entry point callers should use. */
export function evaluateIdlePool(
  i: IdlePoolInputs,
  tariff: TariffModel,
  cfg: IdlePoolConfig = DEFAULT_IDLE_POOL_CONFIG,
): IdlePoolVerdict {
  const c = classifyIdlePool(i, tariff, cfg);
  const day = localParts(i.nowMs, tariff.timezone).ymd;
  const step = stepIdlePool(idlePoolState, c.suppressed === null, {
    nowMs: i.nowMs, onPeak: c.onPeak, gridPresent: i.gridPresent, day,
  }, cfg);
  idlePoolState = step.state;
  const importW = i.gridImportW ?? 0;
  const above = i.socPct != null && i.reserveSocPct != null && i.poolFullWh != null && i.poolFullWh > 0
    ? Math.max(0, ((i.socPct - i.reserveSocPct) / 100) * (i.poolFullWh / 1000)) : null;
  const firedToday = c.suppressed === null && !step.active && step.state.firedDay === day;
  return {
    active: step.active,
    onPeak: c.onPeak,
    periodLabel: c.periodLabel,
    gridImportW: importW,
    poolFlowW: c.poolFlowW,
    socPct: i.socPct,
    reserveSocPct: i.reserveSocPct,
    aboveReserveKwh: above,
    centsPerHour: c.centsPerKwh == null ? null : (importW / 1000) * c.centsPerKwh,
    heldForMs: step.state.onsetMs == null ? 0 : i.nowMs - step.state.onsetMs,
    suppressed: firedToday ? 'fired-today' : c.suppressed,
    smartBackupMode: i.smartBackupMode ?? null,
  };
}

export function peakIdlePoolAlerts(v: IdlePoolVerdict, nowMs: number): Alert[] {
  if (!v.active) return [];
  const kw = (v.gridImportW / 1000).toFixed(1);
  const mins = Math.max(1, Math.round(v.heldForMs / 60_000));
  const aboveText = v.aboveReserveKwh == null ? '' : ` (about ${v.aboveReserveKwh.toFixed(1)} kWh above it)`;
  const costText = v.centsPerHour == null
    ? ' The tariff rates are not confirmed in config, so the cost is not estimated here.'
    : ` At the ${v.periodLabel} rate that is about $${(v.centsPerHour / 100).toFixed(2)} per hour.`;
  return [{
    id: PEAK_IDLE_POOL_ALERT_ID,
    severity: 'warning' as const,
    category: 'Grid' as const,
    device: 'Smart Home Panel 2',
    // Money, not danger: the floor of the priority union, and never audible
    // (broadcast.ts conditionFromAlerts drops this id).
    priority: 'low' as const,
    title: 'Buying grid power on-peak while the battery pool sits idle',
    detail:
      `The house has drawn about ${kw} kW from the grid for ${mins} minutes during ${v.periodLabel} while the `
      + `battery pool, at ${v.socPct}% against a ${v.reserveSocPct}% reserve${aboveText}, has not discharged.${costText} `
      + 'After the pool stops at its reserve, the Smart Home Panel 2 has been seen to resume discharging only once '
      + 'the pool climbs back roughly 20 points above the reserve; a pool that refilled only part of the way sits '
      + 'idle in that band while the house buys at the on-peak rate. A backup mode that holds the pool does the same. '
      + 'The add-on changes no setting — if the pool should be carrying the house, check the panel\'s backup '
      + 'settings in the EcoFlow app. Sent at most once per on-peak day.',
    facts: [
      { label: 'Grid import', value: `${kw} kW` },
      { label: 'Pool', value: `${v.socPct}%` },
      { label: 'Reserve', value: `${v.reserveSocPct}%` },
      { label: 'Above reserve', value: v.aboveReserveKwh == null ? 'capacity unknown' : `${v.aboveReserveKwh.toFixed(1)} kWh` },
      { label: 'Pool flow', value: `${Math.round(v.poolFlowW)} W` },
      { label: 'Smart backup mode', value: v.smartBackupMode == null ? 'not reported' : String(v.smartBackupMode) },
      { label: 'Period', value: v.periodLabel },
      { label: 'Cost rate', value: v.centsPerHour == null ? 'rates unconfirmed' : `$${(v.centsPerHour / 100).toFixed(2)}/h` },
      { label: 'Ongoing for', value: `${mins} min` },
      { label: 'Since', value: new Date(nowMs - v.heldForMs).toISOString() },
    ],
  }];
}
