import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyBracketPriority, priorityMeta, priorityOf } from '../src/alertPriority.js';

/**
 * v0.94.0 (re-audit #1) — the HA notify-title bracket must honour an alert's EXPLICIT
 * priority. The old title-builder passed only { severity, source } into priorityOf,
 * dropping alert.priority, so every explicit-priority='medium' WARNING (the message-
 * rate-floor collapse, the backup-SoC reserve bands, audible-unreachable, telemetry-gap)
 * rendered as "[High]". These pin the corrected derivation AND that the warning→info
 * auto-tune demotion still shows "[Low]".
 */

const label = (p: ReturnType<typeof notifyBracketPriority>) => priorityMeta(p).label;

test('explicit priority=medium warning, NOT demoted → Medium (the rate-floor / reserve-band bug)', () => {
  const a = { severity: 'warning' as const, source: 'threshold' as const, priority: 'medium' as const };
  assert.equal(notifyBracketPriority(a, 'warning'), 'medium');
  assert.equal(label(notifyBracketPriority(a, 'warning')), 'Medium');
  // And it must differ from the old buggy path that dropped priority → high.
  assert.equal(priorityOf({ severity: a.severity, source: a.source }), 'high');
});

test('threshold warning with NO explicit priority, not demoted → High (legacy behaviour preserved)', () => {
  const a = { severity: 'warning' as const, source: 'threshold' as const };
  assert.equal(notifyBracketPriority(a, 'warning'), 'high');
});

test('learned warning with no explicit priority → Medium (unchanged)', () => {
  const a = { severity: 'warning' as const, source: 'learned' as const };
  assert.equal(notifyBracketPriority(a, 'warning'), 'medium');
});

test('critical → Critical regardless', () => {
  const a = { severity: 'critical' as const, source: 'threshold' as const };
  assert.equal(notifyBracketPriority(a, 'critical'), 'critical');
});

test('auto-tune demotion (warning→info) still renders Low, even for an explicit-medium alert', () => {
  // A churny explicit-medium warning that auto-tune demoted to info for THIS send must
  // show the demoted level, not its standing Medium.
  const a = { severity: 'warning' as const, source: 'threshold' as const, priority: 'medium' as const };
  assert.equal(notifyBracketPriority(a, 'info'), 'low');
  assert.equal(label(notifyBracketPriority(a, 'info')), 'Low');
});

test('auto-tune demotion of a plain threshold warning → Low', () => {
  const a = { severity: 'warning' as const, source: 'threshold' as const };
  assert.equal(notifyBracketPriority(a, 'info'), 'low');
});
