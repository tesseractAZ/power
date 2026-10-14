/**
 * v1.182.0 — pure text/visibility rules for the night-charge card (run by
 * server/test/dashboardAuditFour.test.ts; no browser imports).
 */

export interface BannerActuation {
  day: string | null;
  appliedAtMs: number | null;
  revertedAtMs: number | null;
  cancelled: boolean;
  windowEndMs: number | null;
  cancelDeadlineMs: number | null;
  /** The revert CONFIRMED by readback (revertedAtMs is the cloud's ACK only). */
  revertVerifiedAtMs?: number | null;
  revertRetries?: number;
  revertReadbackEscalated?: boolean;
}

/** A restore the cloud acknowledged but the panel has not confirmed, and the actuator is retrying
 *  or has escalated: still actionable, never "Completed", never hidden. */
export function revertUnconfirmed(a: BannerActuation | null): boolean {
  return !!a && a.revertedAtMs != null && a.revertVerifiedAtMs == null
    && (a.revertReadbackEscalated === true || (a.revertRetries ?? 0) > 0);
}

/** A completed night's banner stays up this long after the revert, then clears. */
export const COMPLETED_BANNER_MS = 6 * 3_600_000;

/**
 * Last night's actuation banner stayed on the card all day — "Completed — reserve restored"
 * at 4 PM reads as something happening now. A banner belongs to its night: shown while armed or
 * applied, for COMPLETED_BANNER_MS after a revert, until the window ends for a cancel with no
 * write, and not at all once a window that never applied has passed.
 */
export function actuationBannerVisible(a: BannerActuation | null, nowMs: number): boolean {
  if (!a || a.day == null) return false;
  if (revertUnconfirmed(a)) return true;
  if (a.revertedAtMs != null) return nowMs - (a.revertVerifiedAtMs ?? a.revertedAtMs) < COMPLETED_BANNER_MS;
  const windowOver = a.windowEndMs != null ? nowMs > a.windowEndMs + 3_600_000 : false;
  if (a.appliedAtMs == null && windowOver) return false;
  if (a.cancelled && a.appliedAtMs == null) {
    return a.windowEndMs != null ? nowMs <= a.windowEndMs
      : a.cancelDeadlineMs != null ? nowMs - a.cancelDeadlineMs < 8 * 3_600_000 : true;
  }
  return true;
}

/**
 * The reserve the plan will actually WRITE: the setpoint clamped to the panel's maximum (the
 * SHP2 caps backupReserveSoc at 50 — settled 2026-09-16). The card printed "reserve set to 94%"
 * from the unclamped requirement; the device would sit at 50.
 */
export function reserveWriteLabel(setpointPct: number | null, predictedPct: number | null, maxPct: number | null): string | null {
  if (setpointPct == null) return null;
  const cap = maxPct != null && maxPct > 0 ? maxPct : null;
  const rounded = Math.round(setpointPct); // the actuator writes Math.round, clamped (clampReserveTarget)
  if (cap != null && rounded > cap) return `reserve set to ${cap}% (the panel's maximum; ${rounded}% needed)`;
  if (predictedPct != null && setpointPct > predictedPct + 0.5) return `reserve set to ${rounded}%`;
  return null;
}

/** The plan fields the card's charge figures read (a subset of /api/night-charge/status → plan). */
export interface ChargeFigurePlan {
  /** The worst case the plan is SIZED on (raw). */
  buyKwh: number | null;
  /** The worst case × the realized-buy calibration (the figure the sizing line names). */
  buyKwhDebiased?: number | null;
  buyDebiasFactor?: number;
  /** v1.187.22 — what the armed write is expected to draw; absent on older plans. */
  expectedBuyKwh?: number | null;
  /** v1.187.22 — the level that write drives the pool to; absent on older plans. */
  expectedWriteLevelPct?: number | null;
  /** v1.187.22 — the window closes before that level is reached ("toward"). */
  expectedDeliverableBound?: boolean;
  setpointSocPct: number | null;
}

/**
 * v1.187.22 — the card's headline: the CHARGE the write arms. With an expected figure the big
 * number is that draw ("34.9 kWh — expected charge to ~80%"); without one the big number is the
 * level and no kWh is shown. The level is the plan's expectedWriteLevelPct (the reserve as written,
 * or the force-charge stop when force-charge rides the night), else — a plan issued before it —
 * the setpoint as written (rounded, at most the panel's maximum). Never the worst case: that is
 * sizingLine's. Mirrors the server's chargeLevelPct / statedBuyKwh (nightChargeAdvisor.ts), and says
 * "toward" the level when the window closes before it is reached (chargeIsWindowBound): Friday's
 * one-hour window from ~48% passes ~14 kWh, ~62%, not the 80% it charges toward.
 */
export function chargeFigureParts(
  plan: ChargeFigurePlan,
  maxPct: number | null,
): { main: string; unit: string; label: string } {
  const lvl = plan.expectedWriteLevelPct;
  const set = plan.setpointSocPct;
  const level = lvl != null && Number.isFinite(lvl) ? lvl
    : set != null && Number.isFinite(set) ? Math.min(Math.round(set), maxPct != null && maxPct > 0 ? maxPct : Infinity)
      : null;
  const levelText = level == null ? '—' : `${Math.round(level * 10) / 10}`;
  const exp = plan.expectedBuyKwh;
  if (exp == null || !Number.isFinite(exp)) return { main: levelText, unit: '%', label: 'charge target' };
  const to = plan.expectedDeliverableBound === true ? 'toward' : 'to';
  return { main: exp.toFixed(1), unit: 'kWh', label: `expected charge ${to} ~${levelText}%` };
}

/**
 * v1.187.22 — the ONE line on the card that names the worst case, labelled as the basis the plan
 * is sized on, with the realized-buy calibration beside the figure it multiplies — the server's
 * sizingBasisText wording (nightChargeAdvisor.ts). null with no figure.
 */
export function sizingLine(plan: ChargeFigurePlan): string | null {
  const factor = plan.buyDebiasFactor ?? 1;
  const deb = plan.buyKwhDebiased;
  const worst = deb != null && Number.isFinite(deb) ? deb : plan.buyKwh;
  if (worst == null || !Number.isFinite(worst)) return null;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const cal = factor > 1.005 && plan.buyKwh != null && Number.isFinite(plan.buyKwh)
    ? ` (raw estimate ${r1(plan.buyKwh)} kWh × ${factor.toFixed(2)} realized-buy calibration)` : '';
  return `Sized on an islanded worst case (P10 PV, P90 load including any committed EV session, no grid) of ~${r1(worst)} kWh${cal}.`;
}

/** The plan fields the card's HOLD summary reads (a subset of /api/night-charge/status → plan). */
export interface HoldSummaryPlan {
  /** 0 when the cushion holds with no charge; > 0 when a need was sized; null with no sizing. */
  requiredExtraKwh: number | null;
  cushionShortfall: boolean;
  /** v1.186.0 — the trough the cushion test judged and its line (absent on older plans). */
  cushionTroughSocPct?: number | null;
  cushionLineSocPct?: number | null;
  cushionBasis?: string | null;
  minProjSocPct: number | null;
  baselineMinSocPct: number | null;
  reserveFloorPct: number;
  cushionPct: number;
}

/**
 * v1.187.22 — WHICH hold tonight is, on the figure it was decided on — the evening push's hold
 * shape (buildNightChargeMessage, server/src/notify.ts) in the card's words. The card said
 * "Projected overnight trough 0% stays at/above the 31% floor+cushion" on every hold: the
 * whole-house island trough, unlabelled, not the trough the cushion test judged, and on a night
 * whose window cannot cover the cushion it still said "No overnight charge needed."
 *  - the cushion holds: the trough it was judged on (the pack at window close; the whole-house
 *    low on the legacy-pct basis), labelled as the islanded case it is;
 *  - a need under the minimum buy;
 *  - the window cannot cover the cushion: said, with the residual risk (tone 'warn');
 *  - no sizing (no window resolved).
 */
export function holdSummary(plan: HoldSummaryPlan): { headline: string; detail: string; tone: 'ok' | 'warn' | 'muted' } {
  const pct = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`);
  if (plan.requiredExtraKwh == null) {
    return { headline: 'No overnight charge tonight.', detail: 'No cheap charge window was resolved — nothing will be charged.', tone: 'muted' };
  }
  if (plan.cushionShortfall) {
    return {
      headline: 'No overnight charge tonight — the window cannot cover the cushion.',
      detail: 'The outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, '
        + 'so nothing will be charged. Charge/pool limits prevent meeting the cushion — residual risk remains.',
      tone: 'warn',
    };
  }
  if (plan.requiredExtraKwh > 0) {
    return {
      headline: 'No overnight charge tonight.',
      detail: 'The islanded worst case the plan is sized on needs only a small top-up, under the minimum buy, so nothing will be charged.',
      tone: 'ok',
    };
  }
  const trough = plan.cushionTroughSocPct ?? plan.minProjSocPct ?? plan.baselineMinSocPct;
  const line = plan.cushionLineSocPct ?? plan.reserveFloorPct + plan.cushionPct;
  const wholeHouse = plan.cushionBasis === 'legacy-pct' || plan.cushionTroughSocPct == null;
  return {
    headline: 'No overnight charge needed.',
    detail: `Even if the grid were lost overnight, ${wholeHouse
      ? `the whole-house low would stay at ~${pct(trough)}`
      : `the pack would close the charge window at ~${pct(trough)}`}, at or above the ${pct(line)} floor+cushion line — nothing will be charged.`,
    tone: 'ok',
  };
}
