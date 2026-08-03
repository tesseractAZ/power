import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHIME_LEVELS } from '../src/chimeConfig.js';
import { KLAXON_FOR_LEVEL } from '../src/audioRenderer.js';

/**
 * v1.58.1 — pin the web console's level vocabulary to the server's.
 *
 * `web` and `server` share no types: the console casts `r.json()` to local
 * interfaces, so nothing structurally couples `web/src/alarmLevels.ts` to
 * `CHIME_LEVELS`. Widen one without the other and BOTH packages typecheck, CI
 * passes, and the operator gets a console that silently cannot address the new
 * level — which is precisely the "four listed, three selectable" complaint this
 * groundwork exists to fix, reproduced with no signal.
 *
 * The web module is a plain `.ts` (it used to be module-private consts inside
 * the `.tsx`, which this runner cannot import at all). Rather than importing
 * across package boundaries — different tsconfig, different module resolution —
 * this reads the source and extracts the literals. Blunt, but it fails loudly on
 * the divergence that matters, which is more than existed before.
 */

const WEB_SRC = resolve(import.meta.dirname, '../../web/src/alarmLevels.ts');

function literalsOf(src: string, decl: string): string[] {
  // Grab the body following `decl` and pull its single-quoted string literals.
  // NB these are VALUES, not keys — fine for LEVELS (whose values are the level
  // names) and wrong for a Record. `tsc` already forces a Record<Level,…> key set
  // to equal Level within the web package, so the only thing worth asserting
  // across the package boundary is Level itself, plus the klaxon basenames.
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `web/src/alarmLevels.ts no longer declares ${decl} — update this test with the rename`);
  const body = src.slice(i, src.indexOf(';', i));
  return [...body.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

test('web console level vocabulary matches the server', () => {
  const src = readFileSync(WEB_SRC, 'utf8');

  const webLevels = literalsOf(src, 'export const LEVELS');
  assert.deepEqual(
    [...webLevels].sort(),
    [...CHIME_LEVELS].sort(),
    'web LEVELS must match server CHIME_LEVELS — a level the console cannot address is unassignable',
  );

});

test('web klaxon preview basenames match the server klaxon filenames', () => {
  // A mismatch here makes the console's preview button play a different sound
  // than the alarm actually will — the worst kind of wrong, because it teaches
  // the operator the wrong association at the moment they are choosing tones.
  const src = readFileSync(WEB_SRC, 'utf8');
  const i = src.indexOf('export const KLAXON_FILE');
  const body = src.slice(i, src.indexOf('};', i));
  for (const level of CHIME_LEVELS) {
    const m = new RegExp(`${level}:\\s*'([a-z-]+)'`).exec(body);
    assert.ok(m, `KLAXON_FILE has no entry for '${level}'`);
    assert.equal(
      `${m[1]}.wav`,
      KLAXON_FOR_LEVEL[level],
      `preview for '${level}' points at ${m[1]}.wav but the alarm plays ${KLAXON_FOR_LEVEL[level]}`,
    );
  }
});
