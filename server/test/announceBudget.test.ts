import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  announceTimeoutMs, WAV_BYTES_PER_SEC, ANNOUNCE_TIMEOUT_FLOOR_MS,
  ANNOUNCE_TIMEOUT_CEILING_MS, ANNOUNCE_SETUP_MARGIN_MS,
} from '../src/broadcast.js';

/**
 * v1.119.0 — the announce HTTP budget, derived from the clip.
 *
 * ROOT CAUSE OF THE 2026-08-30 STORM. music_assistant.play_announcement does not
 * return until playback FINISHES. The budget was a constant (75 s) sized when
 * clips were ~24 s. By 08-30 the red clip was 3,020,422 bytes = 68.5 s, so a red
 * needed 68.5 s + MA queueing + AirPlay setup against 75 s. EVERY red timed out;
 * the one observed "success" returned at 75.4 s, AT the limit. Each timeout was
 * retried and played again — 15 announcements of one storm warning.
 *
 * The constant has now rotted three times (5 s -> 30 s -> 75 s), always because
 * clips grew. Deriving it from the clip is what stops a fourth.
 */

const RED = 3_020_422;      // measured, the 08-30 storm clip
const YELLOW = 2_753_998;
const LADDER_30 = 804_946;

test('the measured clips decode to their real durations', () => {
  assert.equal(Math.round(RED / WAV_BYTES_PER_SEC * 10) / 10, 68.5);
  assert.equal(Math.round(YELLOW / WAV_BYTES_PER_SEC * 10) / 10, 62.4);
  assert.equal(Math.round(LADDER_30 / WAV_BYTES_PER_SEC * 10) / 10, 18.3);
});

test('★ the 08-30 red clip now gets a budget that comfortably exceeds its playback', () => {
  const ms = announceTimeoutMs(RED);
  // Derive the expectation, don't hand-round it (68.5s is 68490ms, not 68500).
  const playMs = (RED / WAV_BYTES_PER_SEC) * 1000;
  assert.ok(ms > playMs, `budget ${ms}ms must exceed the ${Math.round(playMs)}ms clip`);
  assert.equal(ms, Math.round(playMs + ANNOUNCE_SETUP_MARGIN_MS), 'playback + setup margin');
  // The retired constant is what made every red time out.
  assert.ok(ms > 75_000, `must exceed the retired 75s constant (got ${ms})`);
});

test('the floor protects short clips — never tighter than the old behaviour', () => {
  assert.equal(announceTimeoutMs(LADDER_30), ANNOUNCE_TIMEOUT_FLOOR_MS,
    'an 18s clip still gets the full floor, so nothing regressed');
  assert.equal(announceTimeoutMs(1), ANNOUNCE_TIMEOUT_FLOOR_MS);
});

test('unknown size falls back to the floor rather than guessing', () => {
  for (const v of [null, undefined, 0, -5, NaN, Infinity]) {
    assert.equal(announceTimeoutMs(v as any), ANNOUNCE_TIMEOUT_FLOOR_MS, String(v));
  }
});

test('a pathological clip is capped — a wedged call must still become visible', () => {
  assert.equal(announceTimeoutMs(WAV_BYTES_PER_SEC * 3600), ANNOUNCE_TIMEOUT_CEILING_MS,
    'an hour-long clip cannot buy an unbounded hang');
});

test('the budget is monotonic in clip length', () => {
  const a = announceTimeoutMs(WAV_BYTES_PER_SEC * 100);
  const b = announceTimeoutMs(WAV_BYTES_PER_SEC * 200);
  assert.ok(b > a, 'a longer clip must never get a smaller budget');
});

test('★ REGRESSION GUARD: clips may grow — the budget must follow them', () => {
  // The constant rotted three times because clips outgrew it silently. Any
  // future clip length must still get playback + margin, with no new constant.
  for (const secs of [30, 60, 68.5, 90, 120, 180]) {
    const ms = announceTimeoutMs(WAV_BYTES_PER_SEC * secs);
    assert.ok(ms > secs * 1000, `${secs}s clip got only ${ms}ms — it would time out and be replayed`);
  }
});
