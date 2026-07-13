/**
 * v1.15.0 — engine-review F6: the EV window predictor had NEVER detected the
 * real EV. Its 2 kW session floor pattern-matched the two air conditioners
 * (26/26 live "patterns" were circuits 6/9 cycling at 2.2-4.1 kW), adding a
 * phantom ~748 W lift to 63% of forecast hours (double-counting AC already in
 * the load curve), while the REAL EVSE sessions (10.2-11.1 kW plateau, 12 in
 * 30 days, 3.8-31.1 kWh, scattered start hours) matched no recurrence bucket
 * and went entirely unforecast — the single biggest load surprise an islanded
 * runway can face.
 *
 * The rebuild: (1) EV_PLATEAU_MIN_W discriminator (the signal is bimodal —
 * <4 kW AC vs >10 kW EV); (2) honest session-distribution stats when the
 * driver is non-recurrent; (3) LIVE-session awareness with remaining-energy
 * projection, overlaid FRESH on every call so the 1 h mining cache can never
 * hide an active ~10.5 kW draw from the projected-SoC trajectory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEvWindowPrediction,
  detectLiveEvSession,
  evLoadByHour,
  resetEvWindowCache,
} from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const MIN = 60_000;
const H = 3_600_000;

function shp2With(circuits: number[]): Record<string, DeviceSnapshot> {
  return {
    SHP: {
      sn: 'SHP',
      deviceName: 'Smart Panel',
      productName: 'Smart Home Panel 2',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'shp2',
        pairedCircuits: circuits.map((primaryCh) => ({ primaryCh })),
        sources: [],
      } as any,
    } as any,
  };
}

function recorderFor(series: Record<string, Array<{ ts: number; value: number }>>): Recorder {
  return {
    query: (_sn: string, metric: string) => series[metric] ?? [],
  } as unknown as Recorder;
}

/** An AC-style duty cycle: `watts` for ~50 min starting at each given hour-of-day, daily. */
function acSeries(startDay: number, days: number, hourOfDay: number, watts: number): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  for (let d = 0; d < days; d++) {
    const start = startDay + d * 24 * H + hourOfDay * H;
    for (let m = 0; m < 50; m += 5) out.push({ ts: start + m * MIN, value: watts });
    out.push({ ts: start + 55 * MIN, value: 0 }); // flush
  }
  return out;
}

/** An EV session: ~10.5 kW plateau for `durMin` minutes at the given start. */
function evSession(startMs: number, durMin: number, watts = 10_500): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  for (let m = 0; m <= durMin; m += 5) out.push({ ts: startMs + m * MIN, value: watts });
  out.push({ ts: startMs + (durMin + 5) * MIN, value: 0 }); // flush
  return out;
}

/* ══ (1) Plateau discrimination — both directions ═════════════════════════ */

test('F6 — recurring AC duty cycles (the 26/26 phantom source) produce ZERO patterns and ZERO observed sessions', () => {
  resetEvWindowCache();
  const dayStart = Date.now() - 20 * 24 * H;
  // Two "air conditioners" cycling daily at 3.5 kW and 4.1 kW — the exact live
  // signature that used to dominate the pattern list.
  const rec = recorderFor({
    pair6_w: acSeries(dayStart, 18, 14, 3500),
    pair9_w: acSeries(dayStart, 18, 15, 4100),
  });
  const r = computeEvWindowPrediction(shp2With([6, 9]), rec);
  assert.equal(r.sessionsObserved, 0, 'AC duty cycles are not EV sessions');
  assert.equal(r.patterns.length, 0, 'no phantom patterns');
  assert.equal(r.upcomingNext24h.length, 0, 'no phantom load lift — the ~748 W double-count is gone');
  assert.equal(r.typicalSessionKwh, null);
});

test('F6 — a genuinely habitual REAL charger (≥ plateau) still produces patterns (recurrence machinery preserved)', () => {
  resetEvWindowCache();
  const now = Date.now();
  // 10.5 kW for ~50 min at ~18:00 on four consecutive same-weekday occurrences.
  const series: Array<{ ts: number; value: number }> = [];
  for (let w = 4; w >= 1; w--) {
    const d = new Date(now - w * 7 * 24 * H);
    d.setHours(18, 0, 0, 0);
    series.push(...evSession(d.getTime(), 50));
  }
  const r = computeEvWindowPrediction(shp2With([5]), recorderFor({ pair5_w: series }));
  assert.ok(r.sessionsObserved >= 4, `real sessions observed (got ${r.sessionsObserved})`);
  assert.ok(r.patterns.length >= 1, 'a habitual ≥plateau charger still yields a pattern');
  assert.ok(r.patterns[0].typicalWatts > 9000, 'pattern watts reflect the EV plateau');
});

/* ══ (2) The real driver: non-recurrent sessions → honest stats, no fake windows ══ */

test('F6 — scattered real-world sessions yield ZERO patterns but HONEST distribution stats', () => {
  resetEvWindowCache();
  const now = Date.now();
  // A compact copy of the live ground truth: sessions on scattered days at
  // scattered hours with varied energies (30-175 min at 10.5 kW ≈ 5-30 kWh).
  // No start hour repeats on ≥3 distinct days, so neither recurrence gate fires
  // (the collision case is pinned separately below).
  const days = [28, 26, 23, 20, 19, 18, 13, 12, 11, 8, 6, 2];
  const hours = [19, 15, 20, 14, 14, 20, 13, 12, 11, 10, 16, 17];
  const durs = [55, 105, 155, 45, 50, 45, 90, 35, 30, 145, 70, 175];
  const series: Array<{ ts: number; value: number }> = [];
  for (let i = 0; i < days.length; i++) {
    const d = new Date(now - days[i] * 24 * H);
    d.setHours(hours[i], 0, 0, 0);
    series.push(...evSession(d.getTime(), durs[i]));
  }
  series.sort((a, b) => a.ts - b.ts);
  const r = computeEvWindowPrediction(shp2With([5]), recorderFor({ pair5_w: series }));
  assert.equal(r.sessionsObserved, 12, 'all 12 real sessions observed');
  assert.equal(r.patterns.length, 0, 'scattered starts legitimately produce no recurrence patterns');
  assert.equal(r.upcomingNext24h.length, 0, 'no speculative windows fabricated');
  assert.ok(r.typicalSessionKwh != null && r.typicalSessionKwh > 5 && r.typicalSessionKwh < 20,
    `median session energy in the observed range (got ${r.typicalSessionKwh})`);
  assert.ok(r.p90SessionKwh != null && r.p90SessionKwh >= r.typicalSessionKwh!, 'p90 ≥ median');
  assert.ok(r.typicalSessionWatts != null && r.typicalSessionWatts > 9000, 'typical watts ≈ the plateau');
  assert.ok(r.sessionsPerWeek != null && r.sessionsPerWeek > 2 && r.sessionsPerWeek < 4,
    `~2.8 sessions/week (got ${r.sessionsPerWeek})`);
});

test('F6 — a weak same-hour tendency (3 scattered days at one hour) yields a probability-DISCOUNTED daily pattern, never a full-watts lift', () => {
  // The real fleet data has exactly this shape: 3 of 12 sessions round to hour 13.
  // The daily detector legitimately fires, but v0.56.0's probability weighting
  // (3 of 12 observed charging days = 0.25) keeps the expected-value lift at a
  // fraction of the plateau — this is a real (weak) tendency of the actual EV,
  // not AC contamination, and it errs mildly conservative for SoC projection.
  resetEvWindowCache();
  const now = Date.now();
  const days = [28, 26, 23, 20, 19, 18, 13, 12, 11, 8, 6, 2];
  const hours = [19, 15, 20, 14, 14, 20, 13, 13, 11, 10, 16, 13]; // hour 13 on 3 distinct days
  const series: Array<{ ts: number; value: number }> = [];
  for (let i = 0; i < days.length; i++) {
    const d = new Date(now - days[i] * 24 * H);
    d.setHours(hours[i], 0, 0, 0);
    series.push(...evSession(d.getTime(), 60));
  }
  series.sort((a, b) => a.ts - b.ts);
  const r = computeEvWindowPrediction(shp2With([5]), recorderFor({ pair5_w: series }));
  const p13 = r.patterns.find((p) => p.startHour === 13);
  assert.ok(p13, 'the 3-day hour-13 tendency surfaces as a daily pattern');
  assert.ok(Math.abs(p13!.probability - 0.25) < 0.01, `probability = 3/12 observed days (got ${p13!.probability})`);
  const map = evLoadByHour(r.upcomingNext24h);
  const lifted = [...map.values()].filter((w) => w > 0);
  assert.ok(lifted.every((w) => w < 3500), `expected-value lift stays a fraction of the 10.5 kW plateau (max ${Math.max(...lifted, 0)})`);
});

/* ══ (3) Live-session awareness ═══════════════════════════════════════════ */

function liveSeries(nowMs: number, elapsedMin: number, watts = 10_500): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  const start = nowMs - elapsedMin * MIN;
  for (let m = 0; m <= elapsedMin; m += 5) out.push({ ts: start + m * MIN, value: watts });
  return out; // NO flush — the session is live
}

test('F6 — an active ~10.5 kW session is detected with consumed energy and a sane remaining projection', () => {
  const now = Date.now();
  const live = detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: liveSeries(now, 30) }), now, 11.3);
  assert.ok(live, 'live session detected');
  assert.equal(live!.circuit, 5);
  assert.ok(live!.watts > 10_000 && live!.watts <= 11_520, `live watts capped at the EVSE max (got ${live!.watts})`);
  assert.ok(Math.abs(live!.consumedKwh - 5.25) < 0.5, `~5.25 kWh consumed in 30 min (got ${live!.consumedKwh})`);
  // remaining ≈ (11.3 − 5.25) kWh / 10.5 kW ≈ 0.58 h
  assert.ok(live!.projectedRemainingHours > 0.3 && live!.projectedRemainingHours < 1.0,
    `remaining ≈ 0.6 h (got ${live!.projectedRemainingHours})`);
});

test('F6 — a session past BOTH the median and P90 floors at 1 kWh remaining, never negative (review: floor was a mutation survivor)', () => {
  const now = Date.now();
  // 3 h elapsed ≈ 31.5 kWh consumed, past median AND p90 → 1 kWh floor.
  const live = detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: liveSeries(now, 180) }), now, 11.3, 26);
  assert.ok(live);
  assert.ok(live!.projectedRemainingHours <= 0.2, `floored remaining is small (got ${live!.projectedRemainingHours})`);
  // Lower bound: 1 kWh at ~10.5 kW ≈ 0.095 h. Reverting the floor makes this
  // NEGATIVE (11.3 − 31.5 kWh) — the old test only bounded from above.
  assert.ok(live!.projectedRemainingHours > 0.05, `floor holds from below (got ${live!.projectedRemainingHours})`);
});

test('F6 — a session that OUTLIVES the median re-targets to the P90 (review: the long-session tail was invisible)', () => {
  const now = Date.now();
  // 90 min at 10.5 kW ≈ 15.75 kWh consumed ≥ median 11.3 → conditional target
  // becomes the P90 (24 kWh) → remaining ≈ 8.25 kWh ≈ 0.79 h at the plateau.
  const live = detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: liveSeries(now, 90) }), now, 11.3, 24);
  assert.ok(live);
  assert.ok(live!.projectedRemainingHours > 0.6 && live!.projectedRemainingHours < 1.0,
    `P90-retargeted remaining ≈ 0.79 h, not the 0.1 h floor collapse (got ${live!.projectedRemainingHours})`);
});

test('F6 — the 4 h physical-sanity cap binds for a slow charger with a large conditional target', () => {
  const now = Date.now();
  // 6.5 kW plateau (≥ the 6 kW gate), typical 30 kWh, nothing consumed yet
  // beyond 30 min → remaining ≈ 26.75 kWh / 6.5 kW ≈ 4.1 h → capped at 4.
  const live = detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: liveSeries(now, 30, 6500) }), now, 30, null);
  assert.ok(live);
  assert.equal(live!.projectedRemainingHours, 4, `cap binds (got ${live!.projectedRemainingHours})`);
});

test('F6 — robustness: a single glitch sample, a NaN sample, and a future-stamped sample never fabricate garbage', () => {
  const now = Date.now();
  // One isolated fresh 10.5 kW sample (no sustained stretch) → not a session.
  assert.equal(detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: [{ ts: now - MIN, value: 10_500 }] }), now, 11, null), null,
    'a single glitched sample must not fabricate a ~13 kWh projection');
  // A stretch that has persisted < 5 min → not yet a session (detection is delayed, never lost).
  assert.equal(detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: [
    { ts: now - 2 * MIN, value: 10_500 }, { ts: now - MIN, value: 10_500 },
  ] }), now, 11, null), null, 'sub-sustain stretch held back');
  // NaN latest passes < comparisons — must be rejected explicitly.
  assert.equal(detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: [...liveSeries(now, 30), { ts: now, value: NaN }] }), now, 11, null), null,
    'NaN latest sample rejected');
  // Future-stamped latest: consumed energy must not go negative.
  const fut = detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: [...liveSeries(now - MIN, 30), { ts: now + 5 * MIN, value: 10_500 }] }), now, 11, null);
  if (fut) assert.ok(fut.consumedKwh >= 0, `future-stamped sample must not integrate negative energy (got ${fut.consumedKwh})`);
});

test('F6 — a stale last sample or an AC-level draw is NOT a live session', () => {
  const now = Date.now();
  // Stale: session data ends 30 min ago.
  assert.equal(detectLiveEvSession(shp2With([5]), recorderFor({ pair5_w: liveSeries(now - 30 * MIN, 60) }), now, 11), null);
  // AC-level: 4.1 kW fresh draw is below the plateau.
  assert.equal(detectLiveEvSession(shp2With([9]), recorderFor({ pair9_w: liveSeries(now, 60, 4100) }), now, 11), null);
});

test('F6 — the live overlay BYPASSES the 1 h mining cache (a fresh session is never hidden)', () => {
  resetEvWindowCache();
  const now = Date.now();
  // Prime the cache with historical (closed) sessions so the mined result caches.
  const hist: Array<{ ts: number; value: number }> = [];
  for (const daysAgo of [20, 13, 6]) {
    const d = new Date(now - daysAgo * 24 * H);
    d.setHours(15, 0, 0, 0);
    hist.push(...evSession(d.getTime(), 60));
  }
  const cold = computeEvWindowPrediction(shp2With([5]), recorderFor({ pair5_w: hist }));
  assert.equal(cold.liveSession, undefined, 'no live session before it starts');
  // A session starts NOW; the mined cache is still warm, but the overlay is fresh.
  const withLive = computeEvWindowPrediction(
    shp2With([5]),
    recorderFor({ pair5_w: [...hist, ...liveSeries(now, 25)] }),
    );
  assert.ok(withLive.liveSession, 'live session visible despite the warm mining cache');
  assert.ok(withLive.upcomingNext24h.length >= 1 && withLive.upcomingNext24h[0].probability === 1,
    'live entry prepended at probability 1');
  assert.ok(withLive.upcomingNext24h[0].watts > 10_000, 'live entry carries the real draw');
});

test('F6 — the live entry covers EVERY clock hour the remaining tail touches (review: mid-hour entries lifted zero simulated hours)', () => {
  // Drive the REAL wrapper: the entry must be hour-span aligned so that
  // evLoadByHour covers floor(now/H) through floor((now + remaining)/H) —
  // getDayForecast simulates from the NEXT hour boundary, and the old
  // ts=now/duration=remaining shape covered only the never-simulated current
  // partial hour whenever remaining ≤ 1 h (~85% of real detections).
  resetEvWindowCache();
  const now = Date.now();
  const hist: Array<{ ts: number; value: number }> = [];
  for (const daysAgo of [20, 13, 6]) {
    const d = new Date(now - daysAgo * 24 * H);
    d.setHours(15, 0, 0, 0);
    hist.push(...evSession(d.getTime(), 60)); // ~10.5 kWh typical sessions
  }
  const r = computeEvWindowPrediction(shp2With([5]), recorderFor({ pair5_w: [...hist, ...liveSeries(now, 30)] }));
  assert.ok(r.liveSession, 'live session present');
  const entry = r.upcomingNext24h[0];
  assert.equal(entry.ts % H, 0, 'live entry anchored at the hour start');
  assert.ok(entry.live === true, 'entry flagged live (calendar skips it)');
  const map = evLoadByHour(r.upcomingNext24h);
  const firstKey = Math.floor(r.generatedAt / H);
  const lastKey = Math.floor((r.generatedAt + r.liveSession!.projectedRemainingHours * H) / H);
  for (let k = firstKey; k <= lastKey; k++) {
    assert.ok((map.get(k) ?? 0) > 10_000,
      `hour ${k - firstKey} of the remaining tail carries the live draw (got ${map.get(k) ?? 0})`);
  }
});

test('F6 — an EV-free (AC-only) site caches its empty result briefly instead of re-mining 30 days on every call', () => {
  resetEvWindowCache();
  const dayStart = Date.now() - 20 * 24 * H;
  const acData = acSeries(dayStart, 18, 14, 3500);
  let wideQueries = 0;
  const countingRecorder = {
    query: (_sn: string, _metric: string, since: number, until: number) => {
      if (until - since > 24 * H) wideQueries++; // the 30-day mining fetch
      return acData;
    },
  } as unknown as Recorder;
  computeEvWindowPrediction(shp2With([6]), countingRecorder);
  const after1 = wideQueries;
  computeEvWindowPrediction(shp2With([6]), countingRecorder);
  assert.equal(wideQueries, after1, 'second call within the short empty-TTL serves from cache — no 30-day re-mine');
  assert.ok(after1 >= 1, 'first call actually mined');
});
