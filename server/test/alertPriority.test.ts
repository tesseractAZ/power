import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALARM_PRIORITY_ORDER,
  ALARM_PRIORITY_META,
  priorityOf,
  priorityRank,
  klaxonLevelForPriority,
  priorityAnnouncementPrefix,
  type AlarmPriority,
} from '../src/alertPriority.js';

// v0.11.0 — priorityOf is the ISA-18.2 presentation map from (severity, source)
// to the 4-tier alarm priority. It must NOT depend on any renamed internal
// literal — severity/source are unchanged, priority is derived.
test('priorityOf — derives priority from severity + source', () => {
  // critical severity → Critical (P1), regardless of source.
  assert.equal(priorityOf({ severity: 'critical' }), 'critical');
  // warning + threshold → High (P2): a protective limit was crossed.
  assert.equal(priorityOf({ severity: 'warning', source: 'threshold' }), 'high');
  // warning + undefined source → High (the conservative home for a bare warning).
  assert.equal(priorityOf({ severity: 'warning' }), 'high');
  // warning + learned → Medium (P3): a statistical anomaly, inherently less certain.
  assert.equal(priorityOf({ severity: 'warning', source: 'learned' }), 'medium');
  // info → Low (P4): advisory / situational awareness.
  assert.equal(priorityOf({ severity: 'info' }), 'low');
});

test('ALARM_PRIORITY_ORDER — canonical most-severe-first order', () => {
  assert.deepEqual([...ALARM_PRIORITY_ORDER], ['critical', 'high', 'medium', 'low']);
});

test('ranks — 0..3 ascending in canonical order', () => {
  ALARM_PRIORITY_ORDER.forEach((p, i) => {
    assert.equal(priorityRank(p), i, `${p} should rank ${i}`);
    assert.equal(ALARM_PRIORITY_META[p].rank, i);
  });
});

test('klaxonLevelForPriority — critical & high → red, medium & low → yellow (never green)', () => {
  assert.equal(klaxonLevelForPriority('critical'), 'red');
  assert.equal(klaxonLevelForPriority('high'), 'red');
  assert.equal(klaxonLevelForPriority('medium'), 'yellow');
  // v0.15.8 — 'low' is now yellow (caution), NOT green (all-clear). A low advisory
  // is still actionable, so it must not play the recovery/all-clear chime.
  assert.equal(klaxonLevelForPriority('low'), 'yellow');
});

test('priorityAnnouncementPrefix — critical prefix mentions Critical', () => {
  assert.ok(
    priorityAnnouncementPrefix('critical').includes('Critical'),
    'critical announcement prefix should contain "Critical"',
  );
  // Sanity: every priority has a non-empty spoken prefix.
  for (const p of ALARM_PRIORITY_ORDER) {
    const prefix = priorityAnnouncementPrefix(p as AlarmPriority);
    assert.ok(typeof prefix === 'string' && prefix.length > 0);
  }
});
