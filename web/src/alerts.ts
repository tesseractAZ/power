/**
 * Alerts are computed server-side (the single source of truth) and arrive in
 * snapshot.alerts. This module only re-exports the types and a small counts
 * helper for the UI.
 */
export type { Alert, Severity } from './types';
import type { Alert, Severity } from './types';

export function alertCounts(alerts: Alert[]): Record<Severity, number> {
  return {
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => a.severity === 'info').length,
  };
}
