/**
 * v0.11.0 — Alarm priority taxonomy (ISA-18.2 / IEC 62682).
 *
 * The alert engine internally classifies every alert with a `severity`
 * ('critical' | 'warning' | 'info') and a `source` ('threshold' | 'learned').
 * Those internal literals are load-bearing in ~200 places (object keys, MQTT
 * entity ids like `alert_critical_count`, ntfy/Pushover priority maps, tests)
 * — renaming them would break Home Assistant history and external tooling.
 *
 * Instead this module is a PRESENTATION layer: it derives a 4-tier industrial
 * alarm PRIORITY from (severity, source), following the ISA-18.2 / IEC 62682
 * alarm-management standard used in process & power plants. The mapping
 * populates all four ISA priorities without re-tagging a single alert:
 *
 *   severity=critical              → Critical (P1)  immediate action
 *   severity=warning, threshold    → High     (P2)  a hardware/protective limit was crossed
 *   severity=warning, learned      → Medium   (P3)  a statistical anomaly (inherently less certain)
 *   severity=info                  → Low      (P4)  advisory / situational awareness
 *
 * The High-vs-Medium split on `source` is itself ISA-18.2 logic: a deterministic
 * threshold breach is more certain and more actionable than a learned/statistical
 * deviation, so it earns a higher priority.
 *
 * This is the SINGLE source of truth for priority ids, labels, ranks, colour
 * tokens and operator descriptions. The server, the web app, the HACS cards and
 * the TUI all derive their labels/colours from the same mapping (the web mirrors
 * this file at web/src/alertPriority.ts — keep them in lockstep).
 */

import type { Alert } from './alerts.js';

/** ISA-18.2 priority ids, most-severe first. Stable machine identifiers. */
export type AlarmPriority = 'critical' | 'high' | 'medium' | 'low';

/** Canonical order, most-severe → least. */
export const ALARM_PRIORITY_ORDER: readonly AlarmPriority[] = ['critical', 'high', 'medium', 'low'] as const;

export interface AlarmPriorityMeta {
  /** Stable id (also the colour-token suffix and the HA switch object-id). */
  id: AlarmPriority;
  /** Operator-facing label, e.g. "Critical". */
  label: string;
  /** ISA-18.2 / IEC 62682 priority designation, e.g. "P1". */
  isa: string;
  /** 0 = most severe … 3 = least. Use for sorting (lower sorts first). */
  rank: number;
  /** Short tag for dense UIs / TUI columns, e.g. "CRIT". */
  tag: string;
  /** Web colour-token suffix → Tailwind classes `text-{token}`, `bg-{token}`, `badge-{token}`. */
  colorToken: 'bad' | 'high' | 'warn' | 'info';
  /** Operator description (ISA-style: consequence + required response). */
  description: string;
  /** One-word annunciation response guidance shown next to the label. */
  response: string;
}

/**
 * The taxonomy. Colours follow a conventional 4-tier ramp:
 *   Critical = red, High = orange, Medium = amber, Low = blue.
 */
export const ALARM_PRIORITY_META: Record<AlarmPriority, AlarmPriorityMeta> = {
  critical: {
    id: 'critical', label: 'Critical', isa: 'P1', rank: 0, tag: 'CRIT', colorToken: 'bad',
    response: 'Immediate',
    description: 'Immediate action required to protect people, the battery, or the plant from imminent harm or loss.',
  },
  high: {
    id: 'high', label: 'High', isa: 'P2', rank: 1, tag: 'HIGH', colorToken: 'high',
    response: 'Prompt',
    description: 'A protective hardware limit has been crossed. Prompt operator action is needed to avoid escalation.',
  },
  medium: {
    id: 'medium', label: 'Medium', isa: 'P3', rank: 2, tag: 'MED', colorToken: 'warn',
    response: 'Investigate',
    description: 'A learned/statistical anomaly deviating from the normal baseline. Investigate before it escalates.',
  },
  low: {
    id: 'low', label: 'Low', isa: 'P4', rank: 3, tag: 'LOW', colorToken: 'info',
    response: 'Awareness',
    description: 'Advisory for situational awareness. No immediate action expected.',
  },
};

/** Derive the ISA priority for an alert from its severity + source. */
export function priorityOf(alert: Pick<Alert, 'severity' | 'source'>): AlarmPriority {
  if (alert.severity === 'critical') return 'critical';
  if (alert.severity === 'warning') return alert.source === 'learned' ? 'medium' : 'high';
  return 'low';
}

export function priorityMeta(p: AlarmPriority): AlarmPriorityMeta {
  return ALARM_PRIORITY_META[p];
}

export function priorityRank(p: AlarmPriority): number {
  return ALARM_PRIORITY_META[p].rank;
}

/** Sort comparator: most-severe first. */
export function comparePriority(a: AlarmPriority, b: AlarmPriority): number {
  return priorityRank(a) - priorityRank(b);
}

/**
 * Klaxon/condition level for the audible broadcast.
 * Critical + High both warrant the urgent ("red") klaxon; Medium + Low get the
 * cautionary ("yellow") chime. Returns the same string literals as broadcast.ts
 * ConditionLevel (kept un-imported to avoid an import cycle).
 *
 * v0.15.8 — 'low' was previously mapped to 'green'. But green is the all-clear /
 * condition-recovery chime, so a 'low' advisory (e.g. "reduce consumption —
 * projected to reach reserve in ~8 h") played the all-clear tone, which reads as
 * "everything's fine" rather than "take action." Every actionable alarm priority
 * now gets at least the caution chime; green is reserved for genuine recovery
 * (which comes from the conditionFromAlerts path, not from a priority). The spoken
 * message still differentiates ("Advisory…" vs "High priority alarm…").
 */
export function klaxonLevelForPriority(p: AlarmPriority): 'red' | 'yellow' | 'green' {
  if (p === 'critical' || p === 'high') return 'red';
  return 'yellow'; // medium + low → caution
}

/**
 * Spoken-announcement prefix for a priority. Replaces the old colour-named
 * "Red alert / Yellow alert" prefixes with the industrial priority vocabulary.
 * Critical is repeated for emphasis (matching prior critical behaviour).
 */
export function priorityAnnouncementPrefix(p: AlarmPriority): string {
  switch (p) {
    case 'critical': return 'Critical alarm. Critical alarm.';
    case 'high': return 'High priority alarm.';
    case 'medium': return 'Medium priority alarm.';
    case 'low': return 'Low priority advisory.';
  }
}

/**
 * A representative spoken message used by the "preview announcement" feature
 * on the alert-settings page — lets the operator hear exactly what each
 * priority sounds like (chime + voice) without waiting for a real alarm.
 */
export function previewMessageFor(p: AlarmPriority): string {
  const prefix = priorityAnnouncementPrefix(p);
  switch (p) {
    case 'critical':
      return `${prefix} Battery system. Core 2 pack 3 over temperature. Acknowledge at console.`;
    case 'high':
      return `${prefix} Solar system. String voltage out of range on Core 1. Prompt action required.`;
    case 'medium':
      return `${prefix} Battery system. Core 3 pack 2 internal resistance trending high. Investigate.`;
    case 'low':
      return `${prefix} Grid. The plant is off grid and running on stored energy. Noted for awareness.`;
  }
}
