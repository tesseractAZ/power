import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.151.0 — the equipment-health 60-day series cache.
 *
 * MEASURED: `computeEquipmentHealth` pulled 40 metric-series of SIXTY DAYS each
 * and `MPPT_EFF_TTL_MS` is 10 minutes, so it re-derived two months of history
 * every ten minutes. Cold cost on the live Pi 9,007 ms against 14 ms warm; every
 * other analytics endpoint measured 10–25 ms. On a single-threaded worker that is
 * a head-of-line block — six concurrent requests were observed finishing together
 * at ~20.2 s.
 *
 * THE PROPERTY THAT MAKES THIS SAFE. The optimisation is only legitimate if an
 * incrementally-topped-up series is INDISTINGUISHABLE from a full re-query. These
 * tests are an equivalence oracle for exactly that, because the failure mode of a
 * caching bug is not a crash — it is a slightly wrong efficiency baseline that
 * nothing would ever contradict.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-eqhealth-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { eqQueryMulti, resetEquipmentHealthCaches, resetEquipmentHealthCachesResultOnly, computeEquipmentHealth } =
  await import('../src/analytics.js');

const BUCKET_MS = 300_000;                 // EQ_HEALTH_BUCKET_SEC
const NOW = 1_789_000_000_000 - (1_789_000_000_000 % BUCKET_MS);
const SIXTY_D = 60 * 86_400_000;

/** A recorder stub that buckets exactly the way the real SQL does
 *  (`CAST(ts / bucketMs) * bucketMs`, AVG per bucket) and counts what it is asked
 *  for, so we can assert BOTH equivalence and that the work actually shrank. */
function stubRecorder(raw: Map<string, Array<{ ts: number; value: number }>>) {
  const calls: Array<{ sinceMs: number; untilMs: number }> = [];
  const rec = {
    queryMulti(sn: string, metrics: string[], sinceMs: number, untilMs: number) {
      calls.push({ sinceMs, untilMs });
      const out = new Map<string, Array<{ ts: number; value: number }>>();
      for (const m of metrics) {
        const pts = (raw.get(`${sn}|${m}`) ?? []).filter((p) => p.ts >= sinceMs && p.ts <= untilMs);
        const byBucket = new Map<number, number[]>();
        for (const p of pts) {
          const b = Math.floor(p.ts / BUCKET_MS) * BUCKET_MS;
          (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(p.value);
        }
        out.set(m, [...byBucket.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([ts, vs]) => ({ ts, value: vs.reduce((x, y) => x + y, 0) / vs.length })));
      }
      return out;
    },
  } as any;
  return { rec, calls };
}

/** Deterministic raw samples every 60 s across the window. */
function seed(sn: string, metrics: string[], fromMs: number, toMs: number) {
  const raw = new Map<string, Array<{ ts: number; value: number }>>();
  for (const m of metrics) {
    const pts: Array<{ ts: number; value: number }> = [];
    for (let t = fromMs; t <= toMs; t += 60_000) pts.push({ ts: t, value: (t / 60_000) % 97 });
    raw.set(`${sn}|${m}`, pts);
  }
  return raw;
}

beforeEach(() => resetEquipmentHealthCaches());

const METRICS = ['pv_high', 'pv_high_v', 'pv_high_a'];

test('v1.151.0 — a topped-up series is BYTE-IDENTICAL to a full re-query', () => {
  const raw = seed('C1', METRICS, NOW - SIXTY_D - BUCKET_MS, NOW + 30 * 60_000);

  // 1st call: cold, full 60-day fetch.
  const a = stubRecorder(raw);
  eqQueryMulti(a.rec, 'C1', METRICS, NOW - SIXTY_D, NOW);

  // 2nd call 20 minutes later: served incrementally from the cache.
  const later = NOW + 20 * 60_000;
  const incremental = eqQueryMulti(a.rec, 'C1', METRICS, later - SIXTY_D, later);

  // Oracle: the same window computed cold, with no cache at all.
  resetEquipmentHealthCaches();
  const b = stubRecorder(raw);
  const full = eqQueryMulti(b.rec, 'C1', METRICS, later - SIXTY_D, later);

  for (const m of METRICS) {
    assert.deepEqual(incremental.get(m), full.get(m),
      `${m}: incremental series must equal the full re-query exactly`);
  }
});

test('v1.151.0 — the second call queries only the TAIL, not sixty days again', () => {
  const raw = seed('C1', METRICS, NOW - SIXTY_D - BUCKET_MS, NOW + 30 * 60_000);
  const a = stubRecorder(raw);
  eqQueryMulti(a.rec, 'C1', METRICS, NOW - SIXTY_D, NOW);
  const firstSpan = a.calls[0].untilMs - a.calls[0].sinceMs;

  const later = NOW + 20 * 60_000;
  eqQueryMulti(a.rec, 'C1', METRICS, later - SIXTY_D, later);
  const secondSpan = a.calls[1].untilMs - a.calls[1].sinceMs;

  assert.ok(firstSpan >= SIXTY_D, 'the cold call must really span 60 days');
  assert.ok(secondSpan < 60 * 60_000,
    `the warm call must fetch only the tail, got ${Math.round(secondSpan / 60_000)} min`);
  // This ratio IS the fix: ~8640x less span queried per recompute.
  assert.ok(firstSpan / secondSpan > 100,
    `expected a >100x reduction in queried span, got ${Math.round(firstSpan / secondSpan)}x`);
});

test('★ v1.151.0 — the trailing PARTIAL bucket is replaced, never double-counted', () => {
  // The one way an incremental splice can silently corrupt: the last bucket of
  // the first fetch is partial, and the second fetch must REPLACE it with its
  // completed value rather than append a second copy or keep the stale average.
  const sn = 'C1';
  const m = 'pv_high';
  const lastBucket = NOW - BUCKET_MS;            // the bucket still filling at NOW
  const raw = new Map<string, Array<{ ts: number; value: number }>>();
  const pts: Array<{ ts: number; value: number }> = [];
  for (let t = NOW - SIXTY_D; t < lastBucket; t += 60_000) pts.push({ ts: t, value: 10 });
  // Only ONE sample present in the trailing bucket at first-fetch time...
  pts.push({ ts: lastBucket, value: 100 });
  raw.set(`${sn}|${m}`, pts);

  const a = stubRecorder(raw);
  const first = eqQueryMulti(a.rec, sn, [m], NOW - SIXTY_D, lastBucket + 60_000);
  const firstTail = first.get(m)!.at(-1)!;
  assert.equal(firstTail.ts, lastBucket);
  assert.equal(firstTail.value, 100, 'precondition: the partial bucket averages its single sample');

  // ...then two more land in that SAME bucket, changing its average to 50.
  pts.push({ ts: lastBucket + 60_000, value: 25 });
  pts.push({ ts: lastBucket + 120_000, value: 25 });

  const second = eqQueryMulti(a.rec, sn, [m], NOW - SIXTY_D, lastBucket + 180_000);
  const tails = second.get(m)!.filter((p) => p.ts === lastBucket);
  assert.equal(tails.length, 1, 'the bucket must appear exactly ONCE, not twice');
  assert.equal(tails[0].value, 50, 'the bucket must carry its COMPLETED average, not the stale partial one');

  // And it must match a cold re-query of the same window.
  resetEquipmentHealthCaches();
  const b = stubRecorder(raw);
  const full = eqQueryMulti(b.rec, sn, [m], NOW - SIXTY_D, lastBucket + 180_000);
  assert.deepEqual(second.get(m), full.get(m));
});

test('v1.151.0 — a cache that no longer overlaps the window falls back to a FULL query', () => {
  const raw = seed('C1', METRICS, NOW - 2 * SIXTY_D, NOW + SIXTY_D);
  const a = stubRecorder(raw);
  eqQueryMulti(a.rec, 'C1', METRICS, NOW - SIXTY_D, NOW);

  // Jump far enough forward that the cached span is entirely behind the window.
  const muchLater = NOW + SIXTY_D;
  const out = eqQueryMulti(a.rec, 'C1', METRICS, muchLater - SIXTY_D, muchLater);
  const span = a.calls[1].untilMs - a.calls[1].sinceMs;
  assert.ok(span >= SIXTY_D, 'a non-overlapping cache must NOT be stitched across the hole');

  resetEquipmentHealthCaches();
  const b = stubRecorder(raw);
  const full = eqQueryMulti(b.rec, 'C1', METRICS, muchLater - SIXTY_D, muchLater);
  for (const m of METRICS) assert.deepEqual(out.get(m), full.get(m));
});

test('v1.151.0 — points that have aged out of the 60-day window are dropped', () => {
  const raw = seed('C1', ['pv_high'], NOW - SIXTY_D, NOW + 2 * 86_400_000);
  const a = stubRecorder(raw);
  eqQueryMulti(a.rec, 'C1', ['pv_high'], NOW - SIXTY_D, NOW);

  const later = NOW + 2 * 86_400_000;            // window rolls forward two days
  const out = eqQueryMulti(a.rec, 'C1', ['pv_high'], later - SIXTY_D, later);
  const oldest = out.get('pv_high')![0].ts;
  assert.ok(oldest >= later - SIXTY_D,
    'the cache must not retain points older than the requested window, or it grows without bound');
});

/* ── gaps the mutation harness found: three mutants survived the tests above ── */

test('★ v1.151.0 — the cache is REFRESHED on an incremental call, not just read', () => {
  // Mutant "the cache is never written on the incremental path" survived the
  // two-call tests: call 1 populates via the full-query branch, call 2 reads it.
  // Only a THIRD call exposes a cache that is read but never updated — it would
  // re-fetch from an ever-older `toMs`, quietly widening the tail query back
  // toward a full scan while still returning correct data.
  const raw = seed('C1', METRICS, NOW - SIXTY_D - BUCKET_MS, NOW + 90 * 60_000);
  const a = stubRecorder(raw);
  eqQueryMulti(a.rec, 'C1', METRICS, NOW - SIXTY_D, NOW);
  const t2 = NOW + 30 * 60_000;
  eqQueryMulti(a.rec, 'C1', METRICS, t2 - SIXTY_D, t2);
  const t3 = NOW + 60 * 60_000;
  const third = eqQueryMulti(a.rec, 'C1', METRICS, t3 - SIXTY_D, t3);

  const thirdSpan = a.calls[2].untilMs - a.calls[2].sinceMs;
  assert.ok(thirdSpan < 60 * 60_000,
    `the third call must still fetch only a tail, got ${Math.round(thirdSpan / 60_000)} min — the cache is not being refreshed`);

  resetEquipmentHealthCaches();
  const b = stubRecorder(raw);
  const full = eqQueryMulti(b.rec, 'C1', METRICS, t3 - SIXTY_D, t3);
  for (const m of METRICS) assert.deepEqual(third.get(m), full.get(m));
});

test('★ v1.151.0 — two different metric sets on ONE device do not share a cache entry', () => {
  // Mutant "the cache key drops the metric list" survived because every test
  // above used a single metric set. computeEquipmentHealth runs TWO loops over
  // the same SNs — the MPPT triple and the standby pair — so a key of `sn` alone
  // makes each loop serve the other's series: wrong metrics, no error.
  const all = ['pv_high', 'pv_high_v', 'pv_high_a', 'ac_out', 'pv_total'];
  const raw = seed('C1', all, NOW - SIXTY_D - BUCKET_MS, NOW + 60 * 60_000);
  const a = stubRecorder(raw);

  eqQueryMulti(a.rec, 'C1', METRICS, NOW - SIXTY_D, NOW);
  const standby = eqQueryMulti(a.rec, 'C1', ['ac_out', 'pv_total'], NOW - SIXTY_D, NOW);

  assert.deepEqual([...standby.keys()].sort(), ['ac_out', 'pv_total'],
    'the standby call must return ITS metrics, not the MPPT triple');
  assert.ok((standby.get('ac_out') ?? []).length > 0, 'ac_out must carry data');

  resetEquipmentHealthCaches();
  const b = stubRecorder(raw);
  const full = eqQueryMulti(b.rec, 'C1', ['ac_out', 'pv_total'], NOW - SIXTY_D, NOW);
  for (const m of ['ac_out', 'pv_total']) assert.deepEqual(standby.get(m), full.get(m));
});

test('★ BRIDGE v1.151.0 — computeEquipmentHealth itself goes through the cache', () => {
  // Mutant "the MPPT loop bypasses the cache" survived because every test above
  // called eqQueryMulti directly. A helper being correct proves nothing if the
  // production call site does not use it — the lesson this repo has paid for
  // more than once. Drive the real report and assert the SECOND computation
  // queries only tails.
  const sns = ['C1', 'C2'];
  const metrics = ['pv_high', 'pv_high_v', 'pv_high_a', 'pv_low', 'pv_low_v', 'pv_low_a', 'ac_out', 'pv_total'];
  const raw = new Map<string, Array<{ ts: number; value: number }>>();
  for (const sn of sns) for (const [k, v] of seed(sn, metrics, NOW - SIXTY_D - BUCKET_MS, NOW + 60 * 60_000)) raw.set(k, v);
  const a = stubRecorder(raw);

  const devices: Record<string, any> = {};
  for (const sn of sns) devices[sn] = { sn, deviceName: `Core ${sn.slice(1)}`, projection: { kind: 'dpu' } };

  resetEquipmentHealthCaches();
  computeEquipmentHealth(devices, a.rec);
  const coldCalls = a.calls.length;
  assert.ok(coldCalls > 0, 'the cold computation must hit the recorder');
  assert.ok(a.calls.every((c) => c.untilMs - c.sinceMs >= SIXTY_D),
    'every cold query must span the full 60-day baseline');

  // Force past the result-level TTL so the report recomputes, then assert the
  // recompute reads only tails.
  resetEquipmentHealthCachesResultOnly();
  computeEquipmentHealth(devices, a.rec);
  const warm = a.calls.slice(coldCalls);
  assert.ok(warm.length > 0, 'the recompute must still consult the recorder');
  assert.ok(warm.every((c) => c.untilMs - c.sinceMs < 60 * 60_000),
    `the recompute must fetch only tails; widest was ${Math.round(Math.max(...warm.map((c) => c.untilMs - c.sinceMs)) / 60_000)} min`);
});
