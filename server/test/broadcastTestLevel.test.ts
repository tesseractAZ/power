/**
 * v1.185.1 — POST /api/broadcast/test refused every documented call from v1.59.0 on: it validated
 * the level against CHIME_LEVELS, which became the five alarm RUNGS, so `red` / `yellow` / `green`
 * and the empty-body default all got 400, and a rung name got through only to be spoken as
 * "All clear". It validates against the CONDITION levels now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBroadcastTestLevel, BROADCAST_TEST_LEVELS } from '../src/broadcast.js';
import { CHIME_LEVELS } from '../src/chimeConfig.js';

test('★★ the documented levels are accepted; an empty body is the red test', () => {
  assert.equal(parseBroadcastTestLevel('red'), 'red');
  assert.equal(parseBroadcastTestLevel('yellow'), 'yellow');
  assert.equal(parseBroadcastTestLevel('green'), 'green');
  assert.equal(parseBroadcastTestLevel(undefined), 'red');
});

test('★★ a chime RUNG is not a test level (it would have been spoken as "All clear")', () => {
  for (const rung of CHIME_LEVELS) assert.equal(parseBroadcastTestLevel(rung), null, rung);
  assert.equal(parseBroadcastTestLevel(42), null);
  assert.deepEqual([...BROADCAST_TEST_LEVELS], ['red', 'yellow', 'green']);
});

test('the route validates with parseBroadcastTestLevel, not CHIME_LEVELS', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  const route = src.slice(src.indexOf("'/api/broadcast/test',"), src.indexOf("'/api/broadcast/test',") + 900);
  assert.match(route, /parseBroadcastTestLevel\(req\.body\?\.level\)/);
  assert.doesNotMatch(route, /CHIME_LEVELS/);
});
