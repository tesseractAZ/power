import type { Alert, Severity } from '../types';
// v0.11.0 — per-ALERT rendering colours/labels by ISA priority (Critical/High/Medium/Low).
import { priorityOf, priorityCounts, PRIORITY_META, comparePriority, type AlarmPriority } from '../alertPriority';

// v0.11.0 — re-export the priority helpers so pages importing from AlertParts
// can count/sort/colour by the 4-tier ISA taxonomy in one place.
export { priorityOf, priorityCounts, PRIORITY_META, comparePriority };

/**
 * Shared severity styling. Kept exported + keyed by `severity` for back-compat
 * (App.tsx / other callers may reference it), but per-ALERT rendering below
 * derives the 4-tier ISA priority via priorityOf() and pulls colour/label from
 * PRIORITY_META instead.
 */
export const SEV_META: Record<Severity, { label: string; dot: string; ring: string; badge: string }> = {
  critical: { label: 'Critical', dot: 'bg-bad', ring: 'border-bad/40', badge: 'badge-bad' },
  warning: { label: 'Warning', dot: 'bg-warn', ring: 'border-warn/40', badge: 'badge-warn' },
  info: { label: 'Info', dot: 'bg-muted', ring: 'border-line', badge: 'badge-muted' },
};

export function sevRank(s: Severity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

/** Sort comparator for alerts — most-severe ISA priority first. */
export function alertRank(alert: Pick<Alert, 'severity' | 'source'>): number {
  return PRIORITY_META[priorityOf(alert)].rank;
}

/** Priority-tinted backplate — colour carried by the plate, dark ink on top. */
function boxTint(p: AlarmPriority): string {
  switch (p) {
    case 'critical': return 'bg-bad/15 border-bad/55';
    case 'high':     return 'bg-high/15 border-high/55';
    case 'medium':   return 'bg-warn/20 border-warn/55';
    case 'low':      return 'bg-info/15 border-info/50';
  }
}

/** A big square readout box — small uppercase label over a large value. */
function NumBox({ label, value, priority }: { label: string; value: number | null; priority: AlarmPriority }) {
  return (
    <div className={`w-16 h-16 rounded-md border flex flex-col items-center justify-center ${boxTint(priority)}`}>
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-3xl font-bold tabular-nums leading-none text-ink mt-1">
        {value != null ? value : <span className="text-muted">—</span>}
      </div>
    </div>
  );
}

/** Wide single box for alerts that aren't scoped to a Core/Pack. */
function TagBox({ text, priority }: { text: string; priority: AlarmPriority }) {
  return (
    <div className={`w-[134px] h-16 rounded-md border flex items-center justify-center ${boxTint(priority)}`}>
      <span className="text-base font-bold uppercase tracking-widest text-ink">{text}</span>
    </div>
  );
}

function subjectTag(alert: Alert): string {
  if (alert.device === 'System') return 'SYSTEM';
  if (alert.category === 'SHP2') return 'SHP2';
  if (alert.category === 'Grid') return 'GRID';
  if (alert.category === 'Connectivity') return 'LINK';
  return alert.category.toUpperCase();
}

/**
 * The subject of an alert as two big number boxes — Core first, then Pack —
 * to the left of the alert. Alerts not scoped to a Core fall back to a single
 * wide tag box so every row still lines up.
 */
export function SubjectBoxes({ alert }: { alert: Alert }) {
  const priority = priorityOf(alert);
  if (alert.coreNum != null) {
    return (
      <div className="flex gap-1.5 shrink-0">
        <NumBox label="Core" value={alert.coreNum} priority={priority} />
        {/* v0.43.0 — render the Pack box only for pack-scoped alerts. Core-scoped
            alerts (offline-*, DPU-level) were showing a phantom "Pack —" implying a
            pack scope that doesn't exist (live on every offline core). */}
        {alert.packNum != null && <NumBox label="Pack" value={alert.packNum} priority={priority} />}
      </div>
    );
  }
  return (
    <div className="shrink-0">
      <TagBox text={subjectTag(alert)} priority={priority} />
    </div>
  );
}
