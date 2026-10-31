/**
 * v1.194.0 — the CHARGE LEG of a pool walk. PURE; imports nothing.
 *
 * Every walk that steps a pack hour by hour (the runway, the day and multi-day SoC trajectories,
 * the probabilistic band, the night-charge planner's islanded and median walks, the mid-day
 * shadow's held-import walk) moves the pool by a net figure: PV in, the house load out through the
 * discharge leg. A NEGATIVE net is the pool's own drain and is taken as it is. A POSITIVE net is a
 * surplus the Cores push into the cells, and charging loses energy on the way: on 29 measured
 * PV-surplus spans the pool gained 2-7% less than `pv − load/0.94` predicts (docs/PERFORMANCE.md),
 * so crediting the surplus at unity read every projection across a sunny day long. Each walk now
 * stores `chargeEff` of a surplus. (The dispatch plan already stored a surplus at its leg; the MPC
 * optimiser's simulateHour still credits one at unity and is not among these walks.)
 *
 * A neutral module on purpose: the planner imports it without importing analytics.ts (whose
 * runway basis it must never read — runwayBasisContracts.test.ts pins that).
 *
 * The step can only lower the walk: the result is ≤ `net` for every input, a deficit is returned
 * unchanged, and the result is monotone in `net` (slope 1 below zero, `chargeEff` above), so a
 * trajectory stays monotone in PV and a bisection over it stays exact.
 */

/**
 * The pool's change for a net `net` (any energy unit): `net` itself for a deficit or zero (a NaN
 * passes through for the caller's own guard), `net × chargeEff` for a surplus. `chargeEff` is
 * clamped to [0, 1], so no configuration credits a surplus above unity; a non-finite one credits
 * nothing (fail-closed: the walk reads shorter, never longer).
 */
export function chargeLegStep(net: number, chargeEff: number): number {
  if (!(net > 0)) return net;
  const eta = Number.isFinite(chargeEff) ? Math.min(1, Math.max(0, chargeEff)) : 0;
  return net * eta;
}
