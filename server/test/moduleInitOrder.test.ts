import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * v1.119.2 — module-initialisation ORDER guard (a structural lint, not a
 * behavioural test — see the note at the bottom).
 *
 * INCIDENT 2026-09-01 19:47:18. v1.119.0 registered a `store.on('change')`
 * handler near the top of index.ts that read `nightActuationMem`, a `let`
 * declared ~2300 lines below it. The first store change to arrive during module
 * evaluation hit the temporal dead zone:
 *
 *   poll failed: Cannot access 'nightActuationMem' before initialization
 *
 * The whole poll failed — one lost snapshot on every boot of a life-safety
 * system, at exactly the moment it is coming up. TypeScript does not catch this
 * (the closure is legal; only the runtime ORDER is wrong) and no test could,
 * because it needs a store event mid-module-eval.
 *
 * So the invariant is asserted where it actually lives: in the source order.
 * Any `let`/`const` in index.ts that an earlier line already references is a
 * TDZ hazard the moment that earlier line runs inside a callback.
 */

const INDEX = resolve(import.meta.dirname, '../src/index.ts');

/** Module-scope `let`/`const` bindings that early callbacks have reached into.
 *  Add to this list only with a matching audit note. */
const GUARDED = ['nightActuationMem'];

test('★ no module-scope binding is referenced before it is declared', () => {
  const lines = readFileSync(INDEX, 'utf8').split('\n');
  for (const name of GUARDED) {
    const declIdx = lines.findIndex((l) => new RegExp(`^(let|const) ${name}\\b`).test(l));
    assert.notEqual(declIdx, -1, `${name} should have a module-scope declaration`);
    const early = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => i < declIdx && l.includes(name));
    assert.deepEqual(
      early.map(({ i }) => i + 1), [],
      `${name} is read at line(s) ${early.map(({ i }) => i + 1).join(', ')} but declared at line ${declIdx + 1}. `
      + 'If that reference runs inside a callback that can fire during module evaluation, it throws '
      + '"Cannot access before initialization" and fails the caller — the 2026-09-01 boot-poll failure. '
      + 'Register the handler AFTER the declaration instead.',
    );
  }
});

test('the guard would have caught the v1.119.0 regression', () => {
  // Proof the assertion above is load-bearing rather than vacuously true:
  // reproduce the shape it detects against a synthetic source.
  const broken = ['store.on("change", () => use(nightActuationMem));', 'let nightActuationMem = 1;'];
  const declIdx = broken.findIndex((l) => /^(let|const) nightActuationMem\b/.test(l));
  const early = broken.map((l, i) => ({ l, i })).filter(({ l, i }) => i < declIdx && l.includes('nightActuationMem'));
  assert.equal(early.length, 1, 'the check must flag a read above the declaration');
});
