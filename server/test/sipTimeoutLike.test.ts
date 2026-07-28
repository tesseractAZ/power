import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sipTimeoutLike } from '../src/broadcast.js';

/* v1.48.3 — SIP dispatch failures that are timeout-classed mean the HTTP
 * response was lost, not that the call didn't happen. Live incident: a
 * "Headers Timeout Error" dispatch had actually placed the announce call; the
 * deferred retry re-fired SIP and the duplicate RANG the cordless mid-announce.
 * Timeout-classed failures must route to the verify-then-decide path. */
test('v1.48.3 — timeout-classed SIP failures are recognized (verify path, not blind re-fire)', () => {
  assert.equal(sipTimeoutLike(['media_player.cordless_speaker: Headers Timeout Error']), true);
  assert.equal(sipTimeoutLike(['media_player.cordless_speaker: Body Timeout Error']), true);
  assert.equal(sipTimeoutLike(['media_player.cordless_speaker: This operation was aborted']), true);
  // Definite refusals stay definite — the retry SHOULD re-fire for these.
  assert.equal(sipTimeoutLike(['media_player.cordless_speaker: 500']), false);
  assert.equal(sipTimeoutLike(['media_player.cordless_speaker: entity not found']), false);
  // Mixed = at least one definite miss → treat the dispatch as failed.
  assert.equal(sipTimeoutLike(['a: Headers Timeout Error', 'b: 404']), false);
  // No errors at all is not a timeout situation.
  assert.equal(sipTimeoutLike([]), false);
});
