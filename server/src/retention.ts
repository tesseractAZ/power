/**
 * v1.51.0 — samples retention from the RECORDER_RETENTION_DAYS option. PURE.
 * Default 30 (the historical value; a fresh install behaves identically).
 * Clamped to [7, 3650]: below a week the chart windows and the 7-day load
 * curves lose their inputs; the cap bounds worst-case table size on small
 * hosts. Malformed values fall back to the default — a config typo must never
 * silently turn into a 0-day (delete-everything) retention.
 *
 * v1.187.10 — moved here from recorder.ts (which re-exports it) so the analytics worker can read
 * the configured retention (analytics.ts degradationWindowDays) without importing the recorder.
 */
export function resolveRetentionDays(raw: string | undefined): number {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return 30;
  // v1.108.0 — cap raised 730 → 3650: the operator runs multi-year retention
  // (currently 5 y) for the long-horizon SoH/energy analytics; disk is NVMe.
  return Math.min(3650, Math.max(7, Math.round(n)));
}
