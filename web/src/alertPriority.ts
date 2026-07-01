/**
 * v0.11.0 — Alarm priority taxonomy (ISA-18.2 / IEC 62682), web mirror.
 *
 * Keep in lockstep with server/src/alertPriority.ts. The internal Alert
 * `severity` ('critical'|'warning'|'info') + `source` ('threshold'|'learned')
 * are derived into a 4-tier industrial alarm PRIORITY for display:
 *
 *   critical                 → Critical (P1, red)
 *   warning + threshold      → High     (P2, orange)
 *   warning + learned        → Medium   (P3, amber)
 *   info                     → Low      (P4, blue)
 *
 * All alert rendering (badges, dots, sort order, the alert-settings page)
 * pulls its label + colour classes from PRIORITY_META here, so the taxonomy
 * lives in exactly one place per package.
 */

import type { Alert } from './types';

export type AlarmPriority = 'critical' | 'high' | 'medium' | 'low';

export const ALARM_PRIORITY_ORDER: AlarmPriority[] = ['critical', 'high', 'medium', 'low'];

export interface PriorityMeta {
  id: AlarmPriority;
  label: string;
  isa: string;
  rank: number;
  tag: string;
  description: string;
  response: string;
  /** Tailwind classes (resolve to the theme's CSS variables at use-site). */
  dot: string;
  ring: string;
  badge: string;
  text: string;
}

export const PRIORITY_META: Record<AlarmPriority, PriorityMeta> = {
  critical: {
    id: 'critical', label: 'Critical', isa: 'P1', rank: 0, tag: 'CRIT', response: 'Immediate',
    description: 'Immediate action required to protect people, the battery, or the plant from imminent harm.',
    dot: 'bg-bad', ring: 'border-bad/45', badge: 'badge-bad', text: 'text-bad',
  },
  high: {
    id: 'high', label: 'High', isa: 'P2', rank: 1, tag: 'HIGH', response: 'Prompt',
    description: 'A protective hardware limit has been crossed. Prompt operator action is needed.',
    dot: 'bg-high', ring: 'border-high/45', badge: 'badge-high', text: 'text-high',
  },
  medium: {
    id: 'medium', label: 'Medium', isa: 'P3', rank: 2, tag: 'MED', response: 'Investigate',
    description: 'A learned/statistical anomaly deviating from the normal baseline. Investigate before it escalates.',
    dot: 'bg-warn', ring: 'border-warn/45', badge: 'badge-warn', text: 'text-warn',
  },
  low: {
    id: 'low', label: 'Low', isa: 'P4', rank: 3, tag: 'LOW', response: 'Awareness',
    description: 'Advisory for situational awareness. No immediate action expected.',
    dot: 'bg-info', ring: 'border-info/40', badge: 'badge-info', text: 'text-info',
  },
};

/**
 * Derive the ISA priority for an alert.
 *
 * v0.44.0 — an explicit `priority` field wins when present (set by producers
 * like the backup-pool reserve bands that need ISA Medium for a REAL measured
 * threshold crossing, without faking source='learned'). Otherwise fall back to
 * the legacy severity+source heuristic. Mirrors server/src/alertPriority.ts.
 */
export function priorityOf(alert: Pick<Alert, 'severity' | 'source' | 'priority'>): AlarmPriority {
  // Allowlist the explicit field: `priority` arrives in server JSON and is not
  // otherwise validated at runtime, and callers use the returned value as a
  // property key (priorityCounts, PRIORITY_META lookups) — so only the four
  // known tiers may pass through (CodeQL js/remote-property-injection).
  // Anything malformed falls through to the severity-derived mapping below.
  if (alert.priority && Object.hasOwn(PRIORITY_META, alert.priority)) return alert.priority;
  if (alert.severity === 'critical') return 'critical';
  if (alert.severity === 'warning') return alert.source === 'learned' ? 'medium' : 'high';
  return 'low';
}

export function priorityMeta(p: AlarmPriority): PriorityMeta {
  return PRIORITY_META[p];
}

/** Count alerts per ISA priority. */
export function priorityCounts(alerts: Alert[]): Record<AlarmPriority, number> {
  const out: Record<AlarmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of alerts) out[priorityOf(a)]++;
  return out;
}

/** Sort comparator: most-severe first. */
export function comparePriority(a: AlarmPriority, b: AlarmPriority): number {
  return PRIORITY_META[a].rank - PRIORITY_META[b].rank;
}
