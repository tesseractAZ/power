/**
 * v0.9.40 — Alert surface.
 *
 * Quiet by default. When nothing is wrong, shows a single emerald
 * confirmation. When alerts exist, lists them in a clean stack with
 * severity color, category, title, detail, and the "ago" timestamp.
 *
 * No badge counts, no "23 alerts" notification fatigue — the design
 * intention is calm and informative, not panicky.
 */

import type { Alert } from '../../alerts';
import type { FleetSnapshot } from '../../types';

interface AlertSurfaceProps {
  snapshot: FleetSnapshot | null;
}

export function AlertSurface({ snapshot }: AlertSurfaceProps) {
  const alerts = (snapshot?.alerts ?? []) as Alert[];
  const crit = alerts.filter((a) => a.severity === 'critical');
  const warn = alerts.filter((a) => a.severity === 'warning');
  const info = alerts.filter((a) => a.severity === 'info');
  const total = alerts.length;

  return (
    <div className="opus-glass p-6">
      <div className="flex items-baseline justify-between mb-1">
        <div className="opus-eyebrow">SYSTEM STATE</div>
        <div className="opus-label">
          {total === 0 ? 'ALL CLEAR'
           : `${crit.length} CRIT · ${warn.length} WARN · ${info.length} INFO`}
        </div>
      </div>
      <div style={{ color: 'rgb(var(--color-ink))', fontSize: 16, fontWeight: 500, marginBottom: 20 }}>
        {total === 0
          ? 'No active alerts. System nominal.'
          : crit.length > 0
            ? `${crit.length} condition${crit.length === 1 ? '' : 's'} requiring attention.`
            : `${warn.length} watch item${warn.length === 1 ? '' : 's'}.`}
      </div>

      {total === 0 ? (
        <AllClearGraphic />
      ) : (
        <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-2 opus-scroll">
          {[...crit, ...warn, ...info].slice(0, 8).map((a) => (
            <AlertRow key={a.id} alert={a} />
          ))}
          {alerts.length > 8 && (
            <div className="text-center text-xs pt-2" style={{ color: 'rgb(var(--color-muted))' }}>
              + {alerts.length - 8} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const color = colorFor(alert.severity);
  const bg = bgFor(alert.severity);

  return (
    <div
      className="opus-glass-hover flex items-start gap-3"
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        background: bg,
        border: `1px solid ${color}33`,
      }}
    >
      <span
        className="mt-1.5"
        style={{
          width: 8, height: 8, borderRadius: '50%',
          background: color,
          boxShadow: `0 0 6px ${color}`,
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <div className="opus-label" style={{ fontSize: 9, color }}>
            {alert.category}
          </div>
          {alert.coreNum != null && (
            <div className="opus-label" style={{ fontSize: 9 }}>
              CORE {alert.coreNum}{alert.packNum != null ? ` · PACK ${alert.packNum}` : ''}
            </div>
          )}
        </div>
        <div className="text-sm font-medium mt-0.5" style={{ color: 'rgb(var(--color-ink))' }}>
          {alert.title}
        </div>
        <div className="text-xs mt-1 leading-relaxed" style={{ color: 'rgb(var(--color-muted))' }}>
          {alert.detail}
        </div>
      </div>
    </div>
  );
}

/** The "all clear" graphic — a subtle centered emerald checkmark with a halo. */
function AllClearGraphic() {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div
        className="opus-breathe relative"
        style={{ width: 72, height: 72 }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle, var(--opus-life-1)33 0%, transparent 70%)',
            filter: 'blur(8px)',
          }}
        />
        <svg viewBox="0 0 72 72" width="72" height="72" className="relative">
          <circle cx="36" cy="36" r="30" fill="none" stroke="var(--opus-life-1)" strokeWidth="1" opacity="0.4" />
          <path
            d="M 22 36 L 32 46 L 50 28"
            fill="none"
            stroke="var(--opus-life-1)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="opus-label mt-4" style={{ color: 'var(--opus-life-1)' }}>NOMINAL</div>
    </div>
  );
}

function colorFor(sev: Alert['severity']): string {
  switch (sev) {
    case 'critical': return 'var(--color-bad)';
    case 'warning':  return 'var(--opus-solar)';
    default:         return 'var(--opus-cosmic)';
  }
}
function bgFor(sev: Alert['severity']): string {
  switch (sev) {
    case 'critical': return 'rgba(248, 113, 113, 0.05)';
    case 'warning':  return 'rgba(251, 191, 36, 0.05)';
    default:         return 'rgba(6, 182, 212, 0.04)';
  }
}
