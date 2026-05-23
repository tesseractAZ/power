import type { Alert } from '../types';
import { alertCounts } from '../alerts';

/**
 * Condensed fleet-status strip for the dashboard. Renders the server-computed
 * alerts (snapshot.alerts) — same source as the Alerts tab.
 */
export function StatusBanner({ alerts }: { alerts: Alert[] }) {
  const counts = alertCounts(alerts);
  const actionable = alerts.filter((a) => a.severity !== 'info');

  // Show: all critical, then warnings, capped so the strip stays one or two lines.
  const shown = actionable.slice(0, 4);
  const moreCount = actionable.length - shown.length;

  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      {actionable.length === 0 ? (
        <span className="badge badge-ok text-xs px-3 py-1">✓ All systems normal</span>
      ) : (
        <>
          {counts.critical > 0 && (
            <span className="badge badge-bad text-xs px-3 py-1">
              {counts.critical} critical
            </span>
          )}
          {counts.warning > 0 && (
            <span className="badge badge-warn text-xs px-3 py-1">
              {counts.warning} warning{counts.warning === 1 ? '' : 's'}
            </span>
          )}
          {shown.map((a) => (
            <span
              key={a.id}
              className={`badge text-xs px-3 py-1 ${a.severity === 'critical' ? 'badge-bad' : 'badge-warn'}`}
              title={a.detail}
            >
              {a.title} · {a.device}
            </span>
          ))}
          {moreCount > 0 && (
            <span className="badge badge-muted text-xs px-3 py-1">+{moreCount} more — see Alerts</span>
          )}
        </>
      )}
      {/* Informational items (e.g. off-grid) shown muted */}
      {alerts
        .filter((a) => a.severity === 'info')
        .map((a) => (
          <span key={a.id} className="badge badge-muted text-xs px-3 py-1" title={a.detail}>
            {a.title}
          </span>
        ))}
    </div>
  );
}
