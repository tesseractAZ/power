/**
 * v1.187.20 — the analytics worker's self-warm cadence.
 *
 * analyticsWorker.ts runs a warm pass over WARM_REPORTS (reports.ts) on this interval. It lives in a
 * module of its own so a report can derive its refresh-ahead window from the interval the worker
 * actually runs (analytics.ts CHARGE_CURVE_REFRESH_AHEAD_MS), without importing the worker module
 * (which needs a parentPort) or reports.ts (which imports analytics.ts).
 */
export const WARM_INTERVAL_MS = 4 * 60 * 1000;
