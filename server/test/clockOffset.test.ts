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

/* ═══ v1.81.0 — the RTT gate: latency is not clock skew ═════════════════════ */

test('a latency-inflated sample is rejected once a median exists (the 08-05 sawtooth)', () => {
  resetClockOffset();
  // Build a healthy median: five ~500ms polls, clock offset genuinely ~0.
  for (let i = 0; i < 5; i++) {
    noteServerDate(new Date(1_000_000 + i).toUTCString(), 1_000_000 + i, 500);
  }
  // A 4.7s poll (the audit's exact figure) carries a header that trails by
  // seconds of LATENCY, not skew — the old code adopted a spurious offset here.
  const upd = noteServerDate(new Date(1_000_000 - 4_000).toUTCString(), 1_000_000, 4_700);
  assert.equal(upd.adopted, false);
  assert.equal(upd.rejected, 'rtt-inflated');
  assert.equal(currentOffsetMs(), 0, 'the sawtooth adoption is gone');
  resetClockOffset();
});

test('cold start: only the absolute ceiling gates — 8521 recovery is never blocked', () => {
  resetClockOffset();
  // First-ever sample, normal RTT, genuinely skewed clock (the 2026-08-04 case):
  // adoption must work immediately, no median required.
  const skewMs = 170_000;
  const upd = noteServerDate(new Date(2_000_000 + skewMs).toUTCString(), 2_000_000, 600);
  assert.equal(upd.adopted, true, 'the whole point of v1.69.0 survives the gate');
  assert.ok(Math.abs(currentOffsetMs() - (skewMs + 300)) < 1_500, 'offset ≈ skew + rtt/2 compensation');
  resetClockOffset();
});

test('cold start: an absurd-RTT sample is still rejected', () => {
  resetClockOffset();
  const upd = noteServerDate(new Date(3_000_000 - 8_000).toUTCString(), 3_000_000, 15_581);
  assert.equal(upd.rejected, 'rtt-inflated', 'the 08-15 15.6s poll cannot teach the clock anything');
  resetClockOffset();
});

test('return-leg compensation: measured is corrected by +rtt/2 when RTT is known', () => {
  resetClockOffset();
  // Server header 3s behind receive-time, but 4s RTT (accepted cold, under 8s):
  // half the RTT is return-leg, so true skew ≈ -3s + 2s = -1s — inside the
  // deadband, NO adoption. The uncompensated code would have adopted -3s.
  const upd = noteServerDate(new Date(4_000_000 - 3_000).toUTCString(), 4_000_000, 4_000);
  assert.equal(upd.adopted, false);
  assert.equal(upd.rejected, 'within-deadband');
  resetClockOffset();
});

// ── v1.109.0: the 2026-08-25 02:46 incident — rejection bypasses the deadband ──
import { noteTimestampRejection } from '../src/ecoflow/clockOffset.js';

test('INCIDENT REPLAY: a bad marginal adoption + tight vendor tolerance recovers in ONE rejection, not six minutes', () => {
  resetClockOffset();
  // Second-aligned constants: HTTP Date has 1 s granularity, and the live
  // incident sat almost exactly ON the deadband boundary — the test must sit
  // clearly inside it. Bad stale header at RTT 1 s: measured −3.0 + 0.5 (return
  // leg) = −2.5 s, over the deadband ⇒ adopted. The honest headers then measure
  // −1.0 s — a 1.5 s correction, INSIDE the deadband, so the regular path stays
  // stuck (what held signing broken for six minutes live on 2026-08-25).
  const t0 = 1_787_000_000_000;
  const bad = noteServerDate(new Date(t0 - 3_000).toUTCString(), t0, 1_000);
  assert.equal(bad.adopted, true);
  assert.equal(bad.offsetMs, -2_500);
  const t1 = t0 + 60_000;
  const stuck = noteServerDate(new Date(t1 - 1_000).toUTCString(), t1, 0);
  assert.equal(stuck.adopted, false);
  assert.equal(stuck.rejected, 'within-deadband');
  // The 8524 rejection carries the same honest header; the rejection feed must adopt it.
  const fixed = noteTimestampRejection(new Date(t1 - 1_000).toUTCString(), t1, 0);
  assert.equal(fixed.adopted, true);
  assert.equal(fixed.offsetMs, -1_000, 'offset restored to the honest measurement in ONE poll');
});

test('rejection feed still refuses garbage: no header, unparseable, implausible', () => {
  resetClockOffset();
  assert.equal(noteTimestampRejection(null, 1_000).rejected, 'no-header');
  assert.equal(noteTimestampRejection('not a date', 1_000).rejected, 'unparseable');
  const t0 = 1_787_000_000_000;
  const r = noteTimestampRejection(new Date(t0 + 48 * 3_600_000).toUTCString(), t0, 200);
  assert.equal(r.rejected, 'implausible');
  assert.equal(r.adopted, false);
});

test('rejection feed keeps only the absolute RTT ceiling — a slow degraded-window rejection still teaches, a pathological one does not', () => {
  resetClockOffset();
  const t0 = 1_787_000_000_000;
  // 6 s RTT: over the regular 2×-median gate territory, UNDER the 8 s cold ceiling ⇒ accepted.
  const slow = noteTimestampRejection(new Date(t0 - 4_000).toUTCString(), t0, 6_000);
  assert.equal(slow.adopted, true, 'recovery must work from the degraded window itself');
  // 9 s RTT: over the cold ceiling ⇒ rejected.
  const patho = noteTimestampRejection(new Date(t0 - 4_000).toUTCString(), t0, 9_000);
  assert.equal(patho.rejected, 'rtt-inflated');
});

test('a rejection whose measurement matches the current offset adopts nothing (no churn)', () => {
  resetClockOffset();
  const t0 = 1_787_000_000_000;
  const r1 = noteTimestampRejection(new Date(t0).toUTCString(), t0);
  // measured 0 === offset 0 ⇒ no adoption, no rejection reason
  assert.equal(r1.adopted, false);
  assert.equal(r1.rejected, null);
});
