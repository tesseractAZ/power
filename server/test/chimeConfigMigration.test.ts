import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * v1.59.0 — the three-level → five-rung migration.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * `CHIME_CONFIG_PATH` is read once at module load, so a test that needs a
 * PRE-EXISTING config file on disk has to write it before the first import.
 * chimeConfig.test.ts starts from an empty dir by design; this one starts from
 * a populated one.
 *
 * WHAT IS ACTUALLY AT RISK
 * ------------------------
 * The operator has hand-picked tones persisted in /data/chime-config.json under
 * the OLD keys ('red'/'yellow'/'green'). The upgrade widens the key set. If the
 * migration is wrong the failure is silent and specifically nasty: the config
 * still parses, the console still renders, every rung falls back to a SHIPPED
 * DEFAULT, and the operator's chosen tones are quietly gone. Nothing errors and
 * nothing logs — they find out the next time an alarm sounds wrong.
 *
 * The fan-out direction is the inverse of the old `klaxonLevelForPriority`
 * collapse (critical|high → red, medium|low → yellow), so whatever used to play
 * for a given alarm still plays for it. That is the property that makes this
 * upgrade inaudible to the operator, which is the goal.
 */

const tmp = mkdtempSync(resolve(tmpdir(), 'chimemig-test-'));
const CFG = resolve(tmp, 'chime-config.json');
process.env.CHIMES_DIR = resolve(tmp, 'chimes');
process.env.CHIME_CONFIG_PATH = CFG;

// Seed a LEGACY file before the module reads the path at import time.
// This is the operator's real pre-upgrade state: all three levels hand-set to
// the airport pack's tones, which is what they reported running.
writeFileSync(CFG, JSON.stringify({
  assignments: {
    red: { kind: 'named', id: 'airport-red-alert' },
    yellow: { kind: 'named', id: 'airport-yellow-alert' },
    green: { kind: 'named', id: 'airport-all-clear' },
  },
  updatedAt: 1_700_000_000_000,
  source: 'web',
}));

const { getChimeConfig, _resetChimeConfigCacheForTest, CHIME_LEVELS } =
  await import('../src/chimeConfig.js');

/** Re-seed the on-disk config and force a fresh read (simulates a restart). */
function reload(raw: unknown): ReturnType<typeof getChimeConfig> {
  writeFileSync(CFG, JSON.stringify(raw));
  _resetChimeConfigCacheForTest();
  return getChimeConfig();
}

const named = (id: string) => ({ kind: 'named', id });

test('legacy 3-key config FANS OUT to five rungs, preserving what each alarm played', () => {
  const cfg = getChimeConfig(); // reads the file seeded above
  // red covered critical AND high; yellow covered medium AND low.
  assert.deepEqual(cfg.assignments.critical, named('airport-red-alert'));
  assert.deepEqual(cfg.assignments.high, named('airport-red-alert'));
  assert.deepEqual(cfg.assignments.medium, named('airport-yellow-alert'));
  assert.deepEqual(cfg.assignments.low, named('airport-yellow-alert'));
  assert.deepEqual(cfg.assignments.clear, named('airport-all-clear'));

  // Nothing silently reverted to a shipped default — that is the silent failure
  // this whole test exists to catch.
  for (const rung of CHIME_LEVELS) {
    assert.equal(cfg.assignments[rung].kind, 'named', `${rung} kept a named tone`);
    assert.match(
      (cfg.assignments[rung] as { id: string }).id,
      /^airport-/,
      `${rung} still carries the operator's airport choice, not a shipped default`,
    );
  }
  assert.equal(cfg.updatedAt, 1_700_000_000_000, 'the operator-visible timestamp survives');
});

test('migration is IDEMPOTENT — re-reading a migrated config changes nothing', () => {
  // It runs on the READ path with no one-shot rewrite, so it executes on every
  // process start. Non-idempotence would drift the config across restarts.
  const once = getChimeConfig();
  const twice = reload(once);
  assert.deepEqual(twice.assignments, once.assignments);
  const thrice = reload(twice);
  assert.deepEqual(thrice.assignments, once.assignments);
});

test("a rung's OWN key wins over its legacy level (half-migrated file)", () => {
  // Reachable for real: the operator changes one rung in the console on a new
  // build, and the write persists rung keys ALONGSIDE untouched legacy ones.
  const cfg = reload({
    assignments: {
      red: { kind: 'named', id: 'airport-red-alert' },   // legacy, covers critical+high
      high: { kind: 'named', id: 'gong' },                // explicit — must win
      yellow: { kind: 'named', id: 'airport-yellow-alert' },
    },
  });
  assert.deepEqual(cfg.assignments.critical, named('airport-red-alert'), 'no own key → legacy');
  assert.deepEqual(cfg.assignments.high, named('gong'), 'own key beats the legacy level');
  assert.deepEqual(cfg.assignments.medium, named('airport-yellow-alert'));
  assert.deepEqual(cfg.assignments.low, named('airport-yellow-alert'));
});

test('a legacy key with no counterpart leaves the rest on shipped defaults', () => {
  const cfg = reload({ assignments: { green: { kind: 'named', id: 'triad-up' } } });
  assert.deepEqual(cfg.assignments.clear, named('triad-up'));
  // The four unmentioned rungs take defaults rather than becoming undefined —
  // an undefined assignment would reach resolveChime() and render silence.
  for (const rung of ['critical', 'high', 'medium', 'low'] as const) {
    assert.ok(cfg.assignments[rung], `${rung} must not be undefined`);
    assert.ok(['named', 'builtin', 'custom'].includes(cfg.assignments[rung].kind));
  }
});

test('a corrupt or garbage config yields complete defaults, never a partial map', () => {
  // Corrupt JSON, a non-object, and an assignments block of the wrong shape all
  // have to land somewhere renderable. A missing rung here is a silent alarm.
  for (const raw of [{ assignments: 'not-an-object' }, { assignments: null }, {}, []]) {
    const cfg = reload(raw);
    for (const rung of CHIME_LEVELS) {
      assert.ok(cfg.assignments[rung], `${rung} present for ${JSON.stringify(raw)}`);
    }
  }
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
