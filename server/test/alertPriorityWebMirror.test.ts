import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * web/src/alertPriority.ts — the WEB mirror of the ISA priority taxonomy.
 * The web package has no test runner of its own, so the server's runner (tsx
 * resolves the .ts source) covers the mirror's injection hardening: an alert's
 * explicit `priority` field arrives in server JSON unvalidated and is used as
 * a property key by priorityCounts/PRIORITY_META lookups, so priorityOf must
 * ALLOWLIST it (CodeQL js/remote-property-injection) — a malformed value falls
 * through to the severity-derived mapping instead of propagating.
 */
import {
  priorityOf, priorityCounts, priorityMeta, PRIORITY_META, ALARM_PRIORITY_ORDER,
} from '../../web/src/alertPriority.js';

type LooseAlert = Parameters<typeof priorityOf>[0];
const loose = (a: Record<string, unknown>): LooseAlert => a as unknown as LooseAlert;

test('web priorityOf — explicit valid priority wins over the severity heuristic', () => {
  assert.equal(priorityOf(loose({ severity: 'info', priority: 'medium' })), 'medium');
  assert.equal(priorityOf(loose({ severity: 'critical', priority: 'low' })), 'low');
  for (const p of ALARM_PRIORITY_ORDER) {
    assert.equal(priorityOf(loose({ severity: 'info', priority: p })), p);
  }
});

test('web priorityOf — severity+source heuristic unchanged when priority is absent', () => {
  assert.equal(priorityOf(loose({ severity: 'critical' })), 'critical');
  assert.equal(priorityOf(loose({ severity: 'warning', source: 'threshold' })), 'high');
  assert.equal(priorityOf(loose({ severity: 'warning' })), 'high');
  assert.equal(priorityOf(loose({ severity: 'warning', source: 'learned' })), 'medium');
  assert.equal(priorityOf(loose({ severity: 'info' })), 'low');
});

test('web priorityOf — malformed/hostile priority falls back to the severity mapping', () => {
  // Values a buggy or hostile server payload could carry. '__proto__' and
  // 'constructor' would previously index PRIORITY_META's prototype chain;
  // 'urgent' would previously leak an unknown key into priorityCounts.
  for (const bad of ['urgent', 'CRITICAL', '__proto__', 'constructor', 'hasOwnProperty', 'toString', ' low', 42, {}]) {
    assert.equal(
      priorityOf(loose({ severity: 'critical', priority: bad })), 'critical',
      `priority=${JSON.stringify(bad)} must fall back`,
    );
    assert.equal(priorityOf(loose({ severity: 'warning', source: 'learned', priority: bad })), 'medium');
    assert.equal(priorityOf(loose({ severity: 'info', priority: bad })), 'low');
  }
  // Falsy values keep the legacy fall-through.
  for (const empty of ['', null, undefined]) {
    assert.equal(priorityOf(loose({ severity: 'info', priority: empty })), 'low');
  }
});

test('web priorityCounts — hostile priorities are counted under their derived tier, keys stay fixed', () => {
  const alerts = [
    loose({ severity: 'critical', priority: '__proto__' }),
    loose({ severity: 'warning', source: 'learned', priority: 'urgent' }),
    loose({ severity: 'info' }),
    loose({ severity: 'warning', priority: 'high' }),
  ];
  const counts = priorityCounts(alerts as Parameters<typeof priorityCounts>[0]);
  assert.deepEqual(counts, { critical: 1, high: 1, medium: 1, low: 1 });
  assert.deepEqual(Object.keys(counts).sort(), ['critical', 'high', 'low', 'medium']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('web priorityMeta — meta lookup only ever sees the four allowlisted tiers via priorityOf', () => {
  for (const p of ALARM_PRIORITY_ORDER) {
    assert.equal(priorityMeta(p).id, p);
    assert.ok(Object.hasOwn(PRIORITY_META, p));
  }
});
