import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttsRenderHealth, noteTtsRenderFailure, noteTtsRenderSuccess, _resetTtsHealthForTest } from '../src/audioRenderer.js';

/* v1.44.0 — the dead-voice self-alert contract: consecutive FRESH-render
 * failures accumulate (cached deliveries never touch the counter), a single
 * transient failure stays below the ≥2 alert line, and one fresh success
 * resets the counter (auto-resolving the alert). */

test('render health — two consecutive failures cross the alert line; success resets', () => {
  _resetTtsHealthForTest();
  assert.equal(ttsRenderHealth().consecutiveFailures, 0);
  noteTtsRenderFailure('wyoming render timeout after 15000ms', 1000);
  assert.equal(ttsRenderHealth().consecutiveFailures, 1, 'one transient failure stays below the line');
  noteTtsRenderFailure('wyoming socket: ', 2000);
  const h = ttsRenderHealth();
  assert.equal(h.consecutiveFailures, 2);
  assert.equal(h.lastFailureReason, 'wyoming socket: ');
  assert.equal(h.lastFailureMs, 2000);
  noteTtsRenderSuccess(3000);
  const ok = ttsRenderHealth();
  assert.equal(ok.consecutiveFailures, 0, 'a fresh successful render auto-resolves');
  assert.equal(ok.lastFailureReason, null);
  assert.equal(ok.lastSuccessMs, 3000);
  assert.equal(ok.lastFailureMs, 2000, 'failure history preserved for forensics');
});

test('render health — snapshot is a copy, not the live holder', () => {
  _resetTtsHealthForTest();
  const snap = ttsRenderHealth();
  noteTtsRenderFailure('x', 10);
  assert.equal(snap.consecutiveFailures, 0, 'earlier snapshot unchanged');
  assert.equal(ttsRenderHealth().consecutiveFailures, 1);
});
