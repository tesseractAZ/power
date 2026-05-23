import type { Alert, Severity } from '../types';

/** Shared severity styling for the Alerts and Predictive Insights pages. */
export const SEV_META: Record<Severity, { label: string; dot: string; ring: string; badge: string }> = {
  critical: { label: 'Critical', dot: 'bg-bad', ring: 'border-bad/40', badge: 'badge-bad' },
  warning: { label: 'Warning', dot: 'bg-warn', ring: 'border-warn/40', badge: 'badge-warn' },
  info: { label: 'Info', dot: 'bg-muted', ring: 'border-line', badge: 'badge-muted' },
};

export function sevRank(s: Severity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

/** Severity-tinted backplate — colour carried by the plate, dark ink on top. */
function boxTint(sev: Severity): string {
  if (sev === 'critical') return 'bg-bad/15 border-bad/55';
  if (sev === 'warning') return 'bg-warn/20 border-warn/55';
  return 'bg-panel2 border-line';
}

/** A big square readout box — small uppercase label over a large value. */
function NumBox({ label, value, sev }: { label: string; value: number | null; sev: Severity }) {
  return (
    <div className={`w-16 h-16 rounded-md border flex flex-col items-center justify-center ${boxTint(sev)}`}>
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-3xl font-bold tabular-nums leading-none text-ink mt-1">
        {value != null ? value : <span className="text-muted">—</span>}
      </div>
    </div>
  );
}

/** Wide single box for alerts that aren't scoped to a Core/Pack. */
function TagBox({ text, sev }: { text: string; sev: Severity }) {
  return (
    <div className={`w-[134px] h-16 rounded-md border flex items-center justify-center ${boxTint(sev)}`}>
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
  if (alert.coreNum != null) {
    return (
      <div className="flex gap-1.5 shrink-0">
        <NumBox label="Core" value={alert.coreNum} sev={alert.severity} />
        <NumBox label="Pack" value={alert.packNum ?? null} sev={alert.severity} />
      </div>
    );
  }
  return (
    <div className="shrink-0">
      <TagBox text={subjectTag(alert)} sev={alert.severity} />
    </div>
  );
}
