import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nwsEventWindow } from '../src/nws.js';

/**
 * v0.85.0 — NWS event-window resolution. The storm-prep alert + the NWS card used
 * to pair `onset` (event start) with `expires` (the ~30-min message-refresh
 * deadline), so a storm starting tomorrow showed an "expires" time BEFORE its
 * onset — reading start-after-end. The window now resolves onset→ends, with
 * effective/expires only as fallbacks. These pin that semantics.
 */

const NOW = 1_700_000_000_000; // fixed reference "now"
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test('future storm: onset→ends is the span; a short `expires` does NOT invert it', () => {
  // The exact bug: event starts in 20h and ends in 26h, but the MESSAGE expires
  // in 30 min. Old code paired onset(+20h) with expires(+0.5h) → start after end.
  const w = nwsEventWindow(
    { onset: iso(NOW + 20 * H), ends: iso(NOW + 26 * H), effective: iso(NOW), expires: iso(NOW + 0.5 * H) },
    NOW,
  );
  assert.equal(w.beginsMs, NOW + 20 * H); // onset, not effective
  assert.equal(w.endsMs, NOW + 26 * H); // ends, not the 30-min expires
  assert.equal(w.inEffectNow, false); // begins in the future
  assert.ok(w.endsMs! > w.beginsMs!); // never start-after-end
});

test('in-effect storm: onset in the past → inEffectNow, ends drives "until"', () => {
  const w = nwsEventWindow(
    { onset: iso(NOW - 2 * H), ends: iso(NOW + 4 * H), effective: iso(NOW - 2 * H), expires: iso(NOW + 0.5 * H) },
    NOW,
  );
  assert.equal(w.inEffectNow, true);
  assert.equal(w.endsMs, NOW + 4 * H);
});

test('null onset → falls back to effective for begins', () => {
  const w = nwsEventWindow({ onset: null, effective: iso(NOW + 3 * H), ends: iso(NOW + 5 * H), expires: null }, NOW);
  assert.equal(w.beginsMs, NOW + 3 * H);
  assert.equal(w.inEffectNow, false);
});

test('null ends → falls back to expires only as last resort', () => {
  const w = nwsEventWindow({ onset: iso(NOW - H), effective: null, ends: null, expires: iso(NOW + H) }, NOW);
  assert.equal(w.endsMs, NOW + H); // expires is the only end signal available
  assert.equal(w.inEffectNow, true);
});

test('no times at all → inEffectNow (begin unknown = treat as active), null bounds', () => {
  const w = nwsEventWindow({ onset: null, effective: null, ends: null, expires: null }, NOW);
  assert.equal(w.beginsMs, null);
  assert.equal(w.endsMs, null);
  assert.equal(w.inEffectNow, true); // unknown begin ⇒ assume in effect (never hide an active warning)
});

test('garbage timestamps are treated as absent (no NaN leaks)', () => {
  const w = nwsEventWindow({ onset: 'not-a-date', effective: null, ends: 'nope', expires: null }, NOW);
  assert.equal(w.beginsMs, null);
  assert.equal(w.endsMs, null);
  assert.equal(w.inEffectNow, true);
});
