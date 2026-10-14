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
  setpointSocPct: number | null;
}

/**
 * v1.187.22 — the card's headline: the CHARGE the write arms. With an expected figure the big
 * number is that draw ("34.9 kWh — expected charge to ~80%"); without one the big number is the
 * level and no kWh is shown. The level is the plan's expectedWriteLevelPct (the reserve as written,
 * or the force-charge stop when force-charge rides the night), else — a plan issued before it —
 * the setpoint as written (rounded, at most the panel's maximum). Never the worst case: that is
 * sizingLine's. Mirrors the server's chargeLevelPct / statedBuyKwh (nightChargeAdvisor.ts).
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
  return { main: exp.toFixed(1), unit: 'kWh', label: `expected charge to ~${levelText}%` };
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
