import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateSelfHeal, effectiveQuorum, freshSelfHealState, DEFAULT_SELF_HEAL_CONFIG, type SelfHealConfig,
} from '../src/sessionSelfHeal.js';

/**
 * v1.191.0 (Z5) — the self-heal quorum is min(SELF_HEAL_MIN_DEVICES, the devices on the account).
 * A one-device account could never gather two starved devices, so its session was never rebuilt.
 * On a plant with more devices than the setting nothing changes, in any degraded state.
 */
const MIN = 60_000;
const cfg: SelfHealConfig = { minStarvedDevices: 2, starvedForMs: 20 * MIN, cooldownMs: 60 * MIN, maxPerDay: 6 };
const T0 = Date.UTC(2026, 9, 20, 3, 0);

/** Tick once a minute; `heal` is whether any tick healed, `reason` the last tick's reason. */
function run(starved: number, accountDevices: number | null | undefined, minutes = 25): { heal: boolean; reason: string } {
  const state = freshSelfHealState();
  let healed = false;
  let reason = '';
  for (let m = 0; m <= minutes; m++) {
    const v = evaluateSelfHeal(T0 + m * MIN, starved, state, cfg, { accountDevices });
    healed ||= v.heal;
    reason = v.reason;
  }
  return { heal: healed, reason };
}

test('effectiveQuorum: the setting, bounded by the account; no count leaves the setting', () => {
  assert.equal(effectiveQuorum(2, 13), 2);
  assert.equal(effectiveQuorum(2, 2), 2);
  assert.equal(effectiveQuorum(2, 1), 1);
  assert.equal(effectiveQuorum(3, 2), 2);
  assert.equal(effectiveQuorum(2, 0), 2, 'an empty map (boot) never lowers the quorum to 0');
  assert.equal(effectiveQuorum(2, undefined), 2);
  assert.equal(effectiveQuorum(2, null), 2);
  assert.equal(effectiveQuorum(2, Number.NaN), 2);
  assert.ok(Number.isNaN(effectiveQuorum(Number.NaN, 13)), 'a non-finite setting stays non-finite (never met), as today');
});

test('★ a one-device account heals its one starved device after the dwell', () => {
  const v = run(1, 1);
  assert.equal(v.heal, true, v.reason);
});

test('★ a plant with more devices than the setting is unchanged: one starved device still never heals', () => {
  for (const n of [2, 5, 13, undefined]) {
    const v = run(1, n);
    assert.equal(v.heal, false, `accountDevices=${n}`);
    assert.equal(v.reason, 'only 1 device(s) starved (< 2)', 'the same log text as before');
  }
  assert.equal(run(2, 13).heal, true, 'two starved devices heal as before');
});

test('the default config still reads SELF_HEAL_MIN_DEVICES through the option table (2 when absent)', () => {
  assert.equal(DEFAULT_SELF_HEAL_CONFIG.minStarvedDevices, Number(process.env.SELF_HEAL_MIN_DEVICES ?? 2));
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/sessionSelfHeal.ts'), 'utf8');
  assert.match(src, /minStarvedDevices: option<number>\('SELF_HEAL_MIN_DEVICES'\)/);
});
