import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteServerDate, signingNowMs, currentOffsetMs, resetClockOffset,
  OFFSET_DEADBAND_MS, OFFSET_SANITY_LIMIT_MS,
} from '../src/ecoflow/clockOffset.js';

/**
 * v1.69.0 — reproduces the 2026-08-04 incident: the Pi booted 170 s behind after a
 * power cut, every EcoFlow request was rejected with 8521, and the alarm system held
 * ZERO telemetry for 22 minutes while reporting healthy. Signing now corrects against
 * the server's Date header, which is present on the REJECTION itself.
 */

const LOCAL = Date.UTC(2026, 7, 4, 23, 21, 49); // Pi's (wrong) clock
const httpDate = (ms: number) => new Date(ms).toUTCString();

beforeEach(() => resetClockOffset());

test('THE INCIDENT: a 170s-behind clock is corrected from the rejection response', () => {
  // The Pi is 170 s BEHIND, so the server's Date is 170 s AHEAD of local.
  const serverMs = LOCAL + 170_000;
  const upd = noteServerDate(httpDate(serverMs), LOCAL);
  assert.equal(upd.adopted, true, 'the offset is adopted from the first response');
  assert.ok(Math.abs(upd.offsetMs - 170_000) < 1000, `offset ~+170s (${upd.offsetMs})`);
  // The NEXT request signs with corrected time — within a second of real server time.
  assert.ok(Math.abs(signingNowMs(LOCAL) - serverMs) < 1000, 'signs against server time');
});

test('the correction is used ONLY for signing — it never rewrites the local clock', () => {
  noteServerDate(httpDate(LOCAL + 170_000), LOCAL);
  assert.ok(currentOffsetMs() > 0);
  // signingNowMs is a pure function of its argument; nothing mutates Date.now().
  const a = signingNowMs(LOCAL);
  const b = signingNowMs(LOCAL);
  assert.equal(a, b, 'deterministic for a given local time');
  assert.equal(a - LOCAL, currentOffsetMs(), 'exactly local + offset, nothing else');
});

test('sub-deadband jitter is IGNORED (that is latency, not skew)', () => {
  const upd = noteServerDate(httpDate(LOCAL + (OFFSET_DEADBAND_MS - 1)), LOCAL);
  assert.equal(upd.adopted, false);
  assert.equal(upd.rejected, 'within-deadband');
  assert.equal(currentOffsetMs(), 0, 'offset untouched by normal round-trip latency');
});

test('an implausible header is REFUSED rather than adopted', () => {
  // A broken or proxied header must not be allowed to break signing that works.
  const upd = noteServerDate(httpDate(LOCAL + OFFSET_SANITY_LIMIT_MS + 60_000), LOCAL);
  assert.equal(upd.adopted, false);
  assert.equal(upd.rejected, 'implausible');
  assert.equal(currentOffsetMs(), 0, 'signing is unchanged');
});

test('a missing or unparseable Date header leaves signing exactly as it was', () => {
  assert.equal(noteServerDate(undefined, LOCAL).rejected, 'no-header');
  assert.equal(noteServerDate('not a date', LOCAL).rejected, 'unparseable');
  assert.equal(currentOffsetMs(), 0);
  assert.equal(signingNowMs(LOCAL), LOCAL, 'falls back to the local clock');
});

test('once the host clock is fixed, the offset collapses back toward zero', () => {
  noteServerDate(httpDate(LOCAL + 170_000), LOCAL); // skewed
  assert.ok(currentOffsetMs() > 100_000);
  // NTP catches up: local now agrees with the server.
  const fixedLocal = LOCAL + 170_000;
  const upd = noteServerDate(httpDate(fixedLocal), fixedLocal);
  assert.equal(upd.adopted, true, 'the correction is withdrawn, not sticky');
  assert.ok(Math.abs(currentOffsetMs()) < OFFSET_DEADBAND_MS, `offset ~0 (${currentOffsetMs()})`);
});

test('a clock AHEAD of the server is corrected too (negative offset)', () => {
  const serverMs = LOCAL - 200_000; // Pi is 200 s ahead
  noteServerDate(httpDate(serverMs), LOCAL);
  assert.ok(currentOffsetMs() < 0, 'negative offset');
  assert.ok(Math.abs(signingNowMs(LOCAL) - serverMs) < 1000);
});
