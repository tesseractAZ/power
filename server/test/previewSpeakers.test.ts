/**
 * v1.186.4 — the speaker preview reaches every configured speaker (Music
 * Assistant targets AND the SIP cordless) and the all-clear can be previewed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewSpeakerOutcome } from '../src/broadcast.js';
import { ALL_CLEAR_MESSAGE, ALL_CLEAR_PREVIEW_MESSAGE } from '../src/alertPriority.js';
import { buildAlertMessage } from '../src/ttsService.js';

const noSip = { attempted: 0, ok: 0, errors: [] as string[] };

test('previewSpeakerOutcome: MA and cordless both delivered counts both', () => {
  const r = previewSpeakerOutcome({ targets: 1, call: { ok: true } }, { attempted: 1, ok: 1, errors: [] });
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 2);
  assert.match(r.note ?? '', /skips the same announcement/);
});

test('previewSpeakerOutcome: a refused cordless fails the preview even when MA played', () => {
  const r = previewSpeakerOutcome(
    { targets: 1, call: { ok: true } },
    { attempted: 1, ok: 0, errors: ['media_player.cordless_speaker: 500'] },
  );
  assert.equal(r.ok, false);
  assert.equal(r.delivered, 1);
  assert.match(r.error ?? '', /^SIP play_media: media_player\.cordless_speaker: 500$/);
});

test('previewSpeakerOutcome: a timed-out cordless is unconfirmed, not failed', () => {
  const r = previewSpeakerOutcome(
    { targets: 1, call: { ok: true } },
    { attempted: 1, ok: 0, errors: ['media_player.cordless_speaker: timeout after 10000ms'] },
  );
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 1);
  assert.match(r.note ?? '', /did not confirm in time/);
});

test('previewSpeakerOutcome: an MA failure fails the preview; no SIP means no cordless note', () => {
  const r = previewSpeakerOutcome({ targets: 1, call: { ok: false, error: 'HTTP 500' } }, noSip);
  assert.equal(r.ok, false);
  assert.equal(r.delivered, 0);
  assert.equal(r.error, 'music_assistant.play_announcement: HTTP 500');
  assert.equal(r.note, undefined);
});

test('previewSpeakerOutcome: MA accepted but unconfirmed says so', () => {
  const r = previewSpeakerOutcome({ targets: 1, call: { ok: true, verified: false } }, noSip);
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 1);
  assert.match(r.note ?? '', /did not confirm playback/);
});

test('the all-clear preview says the recovery words, marked so it is never the real recovery audio', () => {
  assert.equal(buildAlertMessage('green', []), ALL_CLEAR_MESSAGE);
  assert.equal(ALL_CLEAR_MESSAGE, 'All clear. All stations report normal.');
  assert.ok(ALL_CLEAR_PREVIEW_MESSAGE.startsWith(ALL_CLEAR_MESSAGE));
  assert.notEqual(ALL_CLEAR_PREVIEW_MESSAGE, ALL_CLEAR_MESSAGE);
});
