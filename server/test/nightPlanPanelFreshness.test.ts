import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nightPlanPanelVerdict, SHP2_READBACK_STALE_MS } from '../src/shp2Membership.js';
import { NIGHT_PLAN_STALE_DEFER_UNTIL_MIN } from '../src/nightChargeAdvisor.js';

/**
 * v1.174.0 — THE PLANNER READS A STALE PANEL (log audit 2026-09-15, open 4). The 09-14 plan
 * was sized and armed at 21:30 on a payload latched stale 21:22-21:44. A stale panel now
 * DEFERS the evening plan (no latch) and, at the deadline, is used with disclosure —
 * never fail-closed on staleness alone.
 */
const NOW = 1_790_000_000_000;

test('★★★ a fresh reading is used as-is', () => {
  const v = nightPlanPanelVerdict({ online: true, lastQuotaAtMs: NOW - 20_000, contentStaleSinceMs: null }, NOW, false);
  assert.deepEqual(v, { use: true, fresh: true, ageMs: 20_000, why: 'fresh' });
});

test('★★★ a cloud REPLAY defers while the caller can wait — and is used, disclosed, once it cannot', () => {
  const d = { online: true, lastQuotaAtMs: NOW - 5_000, contentStaleSinceMs: NOW - 240_000 };
  const wait = nightPlanPanelVerdict(d, NOW, false);
  assert.equal(wait.use, false);
  assert.equal(wait.why, 'replay');
  assert.equal(wait.ageMs, 240_000, 'the CONTENT is 4 min old, though a quota arrived 5 s ago');
  const last = nightPlanPanelVerdict(d, NOW, true);
  assert.equal(last.use, true);
  assert.equal(last.fresh, false, 'the plan must carry the staleness');
});

test('★★ offline and quota-starved panels are stale too, and named apart', () => {
  assert.equal(nightPlanPanelVerdict({ online: false, lastQuotaAtMs: NOW - 1_000 }, NOW, false).why, 'offline');
  const old = nightPlanPanelVerdict({ online: true, lastQuotaAtMs: NOW - SHP2_READBACK_STALE_MS - 1 }, NOW, false);
  assert.equal(old.why, 'no-quota');
  assert.equal(old.use, false);
  assert.equal(old.ageMs, SHP2_READBACK_STALE_MS + 1);
  assert.equal(nightPlanPanelVerdict({ online: true }, NOW, true).ageMs, null, 'unknown age is null, never 0');
});

test('★★ the deferral deadline: after the 21:30 fire, and early enough to leave a cancel window before a 22:55 write', () => {
  assert.ok(NIGHT_PLAN_STALE_DEFER_UNTIL_MIN > 21 * 60 + 30);
  assert.ok(NIGHT_PLAN_STALE_DEFER_UNTIL_MIN <= 22 * 60 + 55 - 25);
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('★★★ recomputeNightChargePlan gates on the verdict BEFORE it reads the projection', () => {
  const b = fnBody('async function recomputeNightChargePlan(');
  const gate = b.indexOf('const panel = nightPlanPanelVerdict(shp2, nowMs, opts.allowStalePanel === true);');
  assert.ok(gate > 0);
  assert.ok(b.indexOf("if (!panel.use) return 'panelStale';") > gate);
  assert.ok(gate < b.indexOf('const sp: any = shp2.projection;'));
  assert.ok(b.indexOf('if (!panel.fresh) {') < b.indexOf('setLatestNightChargePlan(plan);'), 'a stale-sized plan says so before anyone reads it');
  assert.ok(b.includes('panelSampleAgeS: panel.ageMs != null ? Math.round(panel.ageMs / 1000) : null,'));
});

test('★★★ the evening job DEFERS a stale panel: no latch, no notify, no cancel, no row', () => {
  const b = fnBody('async function runNightChargeEveningJobInner(');
  assert.ok(b.includes('await recomputeNightChargePlan({ allowStalePanel: nowMin >= NIGHT_PLAN_STALE_DEFER_UNTIL_MIN })'));
  const i = b.indexOf("if (result === 'panelStale') {");
  assert.ok(i > 0);
  const block = b.slice(i, b.indexOf('return;', i));
  for (const forbidden of ['writeNightChargeLatch(', 'cancelStalePriorArm(', 'sendNotification(', 'recordNightPlanRow(']) {
    assert.ok(!block.includes(forbidden), `the deferral must not call ${forbidden}`);
  }
  assert.ok(i < b.indexOf('recordNightPlanRow(today, fresh.plan'), 'and it precedes the row + notify');
});

test('★★ the 30-min tick and the warm-up stay STRICT (they keep the previous plan)', () => {
  assert.ok(INDEX.includes('try { await recomputeNightChargePlan(); }'));
  assert.ok(INDEX.includes('void recomputeNightChargePlan().catch('));
  assert.equal((INDEX.match(/recomputeNightChargePlan\(\{ allowStalePanel/g) ?? []).length, 1, 'only the evening job may use a stale panel');
});
