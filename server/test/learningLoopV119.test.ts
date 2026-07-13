import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

/* ===================================================================
 * v1.19.0 — engine-review F20 + F17: the learning loop's inputs.
 *
 * F20: featureSnapshot dedup'd by alertId FOREVER (boot hydration put
 *      every historical id in the cache; dropSnapshot fired only on the
 *      33 lifetime outcome submissions) — recurring alerts kept their
 *      first-ever-fire feature vectors, up to weeks stale; 216 rises in
 *      28 h wrote zero snapshots. Now: capture per RISE, with a 60 s
 *      same-rise guard and boot-time compaction past 512 KB.
 *
 * F17: coulombic efficiency published counter noise as "early cell
 *      aging" — all 15 packs show physically impossible >100% dsg/chg
 *      over 30 days, and the [90, 100.5] clamp kept the artifact's low
 *      tail as a measurement. Now: the estimator self-validates the
 *      counters (long-window physical sanity + 7d-vs-long consistency)
 *      and publishes null — honest unknown — when they fail.
 * =================================================================== */

/* ── F20: per-rise snapshot capture ───────────────────────────────── */

const tmpRoot = mkdtempSync(resolve(tmpdir(), 'feature-snapshot-v119-'));
const SNAP_PATH = join(tmpRoot, 'feature-snapshots.jsonl');
process.env.FEATURE_SNAPSHOTS_PATH = SNAP_PATH;
// DB_PATH must also point away from the repo before any src import.
process.env.DB_PATH = join(tmpRoot, 'ecoflow.db');

// Pre-write a LARGE history file BEFORE the module initializes, so this
// process's single ensureInit exercises both hydration and compaction:
// 2000 records ≈ 900 KB (> the 512 KB compaction cap), 1500 over the
// 500-entry LRU.
const bigHistory: string[] = [];
for (let i = 0; i < 2000; i++) {
  bigHistory.push(
    JSON.stringify({
      alertId: `hist-${i}`,
      ts: 1_780_000_000_000 + i * 60_000,
      features: { pack_soc: 50, pack_temp_c: 30, filler: i },
      category: 'Battery',
      severity: 'warning',
      title: `hist alert ${i} ${'x'.repeat(300)}`,
    }),
  );
}
writeFileSync(SNAP_PATH, bigHistory.join('\n') + '\n');
const preBytes = statSync(SNAP_PATH).size;

const { captureSnapshot, getSnapshot } = await import('../src/featureSnapshot.js');
const { coulombicEfficiencyFromCounters, mergeCounterEdges } = await import('../src/analytics.js');

test('F20 — boot compaction: an oversized history file is rewritten down to the retained LRU entries', () => {
  // First touch initializes the module (hydrate + compact).
  getSnapshot('hist-1999');
  const postBytes = statSync(SNAP_PATH).size;
  assert.ok(preBytes > 512 * 1024, `fixture must exceed the cap (${preBytes} bytes)`);
  assert.ok(postBytes < preBytes / 2, `file must shrink substantially: ${preBytes} → ${postBytes}`);
  const lines = readFileSync(SNAP_PATH, 'utf-8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 500, 'compacted file holds exactly the LRU-retained entries');
  // Compacted lines must be REAL records, not stringified keys — a corrupt
  // rewrite would still JSON.parse at next boot and silently vaporize the
  // whole history into one undefined-keyed entry.
  const sample = JSON.parse(lines[0]);
  assert.equal(typeof sample, 'object');
  assert.ok(sample.alertId && sample.features, 'compacted records carry alertId + features');
  // The newest survive the trim; the oldest are gone.
  assert.ok(getSnapshot('hist-1999'), 'newest history entry retained');
  assert.equal(getSnapshot('hist-0'), undefined, 'oldest history entry evicted');
});

test('F20 — a re-fire AFTER the same-rise guard re-captures fresh features (the forever-dedup is dead)', () => {
  const t0 = 1_790_000_000_000;
  captureSnapshot({ alertId: 'peer-temp-SN-1', ts: t0, features: { pack_temp_c: 30 } });
  assert.equal(getSnapshot('peer-temp-SN-1')?.features.pack_temp_c, 30);
  // Same rise (within 60 s) — first-fire features hold.
  captureSnapshot({ alertId: 'peer-temp-SN-1', ts: t0 + 30_000, features: { pack_temp_c: 99 } });
  assert.equal(getSnapshot('peer-temp-SN-1')?.features.pack_temp_c, 30, 'same-rise re-invocation must not overwrite');
  assert.equal(getSnapshot('peer-temp-SN-1')?.ts, t0);
  // A genuine re-fire two hours later — the pre-fix code would have kept the
  // t0 vector forever; the outcome pipeline must see THIS fire's features.
  captureSnapshot({ alertId: 'peer-temp-SN-1', ts: t0 + 2 * 3_600_000, features: { pack_temp_c: 41 } });
  assert.equal(getSnapshot('peer-temp-SN-1')?.features.pack_temp_c, 41, 're-fire must re-capture');
  assert.equal(getSnapshot('peer-temp-SN-1')?.ts, t0 + 2 * 3_600_000);
});

test('F20 — re-captures are persisted (the on-disk record is no longer frozen at first fire)', () => {
  const t0 = 1_791_000_000_000;
  captureSnapshot({ alertId: 'soc-low-SN-2', ts: t0, features: { pack_soc: 9 } });
  captureSnapshot({ alertId: 'soc-low-SN-2', ts: t0 + 3 * 3_600_000, features: { pack_soc: 7 } });
  const lines = readFileSync(SNAP_PATH, 'utf-8').split('\n').filter((l) => l.trim());
  const mine = lines.map((l) => JSON.parse(l)).filter((r) => r.alertId === 'soc-low-SN-2');
  assert.equal(mine.length, 2, 'both fires appended to disk');
  assert.equal(mine[1].features.pack_soc, 7);
});

/* ── F17: self-validating coulombic efficiency ────────────────────── */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Build monotone counter series over `days`, split into a long head and a
 *  7-day tail with independently controlled dsg/chg ratios. Values in mAh. */
function counterSeries(opts: {
  nowMs: number;
  days: number;
  headRatio: number;   // dsg/chg over the pre-tail portion
  tailRatio: number;   // dsg/chg over the last 7 days
  chgPerDayMah?: number;
}) {
  const chgPerDay = opts.chgPerDayMah ?? 20_000;
  const start = opts.nowMs - opts.days * DAY;
  const chg: Array<{ ts: number; value: number }> = [];
  const dsg: Array<{ ts: number; value: number }> = [];
  let c = 1_000_000;
  let d = 1_000_000;
  for (let day = 0; day <= opts.days; day++) {
    const ts = start + day * DAY;
    const inTail = ts >= opts.nowMs - 7 * DAY;
    const ratio = inTail ? opts.tailRatio : opts.headRatio;
    if (day > 0) {
      c += chgPerDay;
      d += chgPerDay * ratio;
    }
    chg.push({ ts, value: c });
    dsg.push({ ts, value: d });
  }
  return { chg, dsg };
}

test('F17 — the live fleet state: unphysical long-window counters (>100%) null the CE even when the 7-day tail looks plausible', () => {
  const now = 1_790_000_000_000;
  // Head at 106% (impossible), tail at 94% — EXACTLY the artifact straddle
  // the review documented: the >100.5% tail was dropped while the identical
  // artifact's low tail published as "early cell aging" at max risk.
  const s = counterSeries({ nowMs: now, days: 30, headRatio: 1.06, tailRatio: 0.94 });
  assert.equal(
    coulombicEfficiencyFromCounters(s.chg, s.dsg, now),
    null,
    'counters proven artifact-ridden over the long window must not publish ANY sub-window as a measurement',
  );
});

test('F17 — healthy, self-consistent counters still publish', () => {
  const now = 1_790_000_000_000;
  const s = counterSeries({ nowMs: now, days: 30, headRatio: 0.995, tailRatio: 0.993 });
  const ce = coulombicEfficiencyFromCounters(s.chg, s.dsg, now);
  assert.ok(ce != null, 'plausible + consistent counters must publish');
  assert.ok(ce! >= 99.2 && ce! <= 99.4, `7-day CE ≈ 99.3; got ${ce}`);
});

test('F17 — a 7-day reading that diverges >2pp from its own long-run ratio is window noise, not chemistry', () => {
  const now = 1_790_000_000_000;
  // Long window plausible (99.5%) but the tail swings to 94% — the weekly
  // 96.5-122% swings the review measured. Real CE moves slowly; a 5.5 pp
  // jump inside the 2 pp discriminating span carries no signal.
  const s = counterSeries({ nowMs: now, days: 30, headRatio: 0.995, tailRatio: 0.94 });
  assert.equal(coulombicEfficiencyFromCounters(s.chg, s.dsg, now), null);
});

test('F17 — throughput floors: tiny windows never publish', () => {
  const now = 1_790_000_000_000;
  // ~1.5k mAh/day → 7d chg ≈ 10.5k (over the 10k 7d floor) but 30d ≈ 45k...
  // use 800/day: 7d ≈ 5.6k < 10k floor → null.
  const s = counterSeries({ nowMs: now, days: 30, headRatio: 0.995, tailRatio: 0.995, chgPerDayMah: 800 });
  assert.equal(coulombicEfficiencyFromCounters(s.chg, s.dsg, now), null);
});

test('F17 — physical ceiling still applies to the published value (never reads >100%)', () => {
  const now = 1_790_000_000_000;
  const s = counterSeries({ nowMs: now, days: 30, headRatio: 1.002, tailRatio: 1.003 });
  const ce = coulombicEfficiencyFromCounters(s.chg, s.dsg, now);
  assert.ok(ce != null, '100.2/100.3% is inside the rounding-tolerance band');
  assert.ok(ce! <= 100, `display clamps at the physical ceiling; got ${ce}`);
});

test('F17 — insufficient points return null (no fabrication from one sample)', () => {
  const now = 1_790_000_000_000;
  assert.equal(coulombicEfficiencyFromCounters([], [], now), null);
  assert.equal(
    coulombicEfficiencyFromCounters(
      [{ ts: now - DAY, value: 100 }],
      [{ ts: now - DAY, value: 100 }],
      now,
    ),
    null,
  );
});

/* ── F17 perf: boundary-point fetch equivalence ───────────────────── */

/** Mimic recorder.queryFirstLast over an in-memory sorted series. */
function firstLast(
  pts: Array<{ ts: number; value: number }>,
  since: number,
  until: number,
): Array<{ ts: number; value: number }> {
  const inWin = pts.filter((p) => p.ts >= since && p.ts <= until);
  if (inWin.length === 0) return [];
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  return last.ts !== first.ts ? [first, last] : [first];
}

test('F17 perf — randomized property: edge-merged input is CE-equivalent to the raw window (500 trials)', () => {
  // The analysePack call site replaced the raw 30-day counter query (~28k
  // rows/pack, ~150 ms Pi event-loop stall) with 4 LIMIT-1 edge seeks per
  // metric. This property pins the substitution: for ANY series shape —
  // sparse, dense, tail-empty, single-point windows, counter resets,
  // artifact ratios, boundary-exact timestamps — the pure function must
  // produce the IDENTICAL published CE from the merged edges.
  let seed = 0xC0FFEE;
  const rnd = () => {
    // xorshift32 — deterministic, no Math.random (repo test convention).
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  const now = 1_790_000_000_000;
  const since = now - 30 * DAY;
  for (let trial = 0; trial < 500; trial++) {
    const n = Math.floor(rnd() * 40); // 0..39 points, incl. degenerate counts
    const mkSeries = () => {
      const pts: Array<{ ts: number; value: number }> = [];
      let v = 1_000_000;
      let ts = since + Math.floor(rnd() * 3 * DAY);
      for (let i = 0; i < n; i++) {
        // Occasionally land EXACTLY on the 7-day tail cutoff (boundary case)
        // or reset the counter (BMS swap).
        ts = rnd() < 0.05 ? now - 7 * DAY : ts + Math.floor(rnd() * 2 * DAY) + HOUR;
        if (ts > now) break;
        v = rnd() < 0.03 ? 1_000 : v + Math.floor(rnd() * 30_000);
        pts.push({ ts, value: v });
      }
      return pts.sort((a, b) => a.ts - b.ts);
    };
    const chg = mkSeries();
    const dsg = mkSeries();
    const raw = coulombicEfficiencyFromCounters(chg, dsg, now);
    const edges = coulombicEfficiencyFromCounters(
      mergeCounterEdges(firstLast(chg, since, now), firstLast(chg, now - 7 * DAY, now)),
      mergeCounterEdges(firstLast(dsg, since, now), firstLast(dsg, now - 7 * DAY, now)),
      now,
    );
    assert.equal(edges, raw, `trial ${trial}: edges=${edges} raw=${raw} (n=${n})`);
  }
});

test('F17 perf — real readRecorder queryFirstLast returns exactly the window edges', async () => {
  // Seed a samples table directly (recorder schema), then open it with
  // createReadRecorder — the READ-ONLY worker recorder analysePack actually
  // runs on — and compare queryFirstLast against query()'s own first/last.
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = join(tmpRoot, 'edge-test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE samples (ts INTEGER NOT NULL, sn TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL);
           CREATE INDEX idx_samples_sn_metric_ts ON samples (sn, metric, ts);`);
  const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
  const base = 1_790_000_000_000;
  for (let i = 0; i < 48; i++) ins.run(base + i * HOUR, 'SN-EDGE', 'pack1_lifetime_chg_mah', 1_000_000 + i * 20_000);
  db.close();

  const { createReadRecorder } = await import('../src/readRecorder.js');
  const rr = createReadRecorder(dbPath);
  try {
    assert.equal(typeof rr.queryFirstLast, 'function', 'the worker recorder must implement the fast path');
    const since = base + 5 * HOUR;
    const until = base + 40 * HOUR;
    const full = rr.query('SN-EDGE', 'pack1_lifetime_chg_mah', since, until);
    assert.ok(full.length > 2, `fixture must have interior rows (${full.length})`);
    const edges = rr.queryFirstLast!('SN-EDGE', 'pack1_lifetime_chg_mah', since, until);
    assert.deepEqual(edges, [full[0], full[full.length - 1]], 'edges must be the exact first/last rows');
    // Empty window → empty result; single-row window → one point, not a pair.
    assert.deepEqual(rr.queryFirstLast!('SN-EDGE', 'pack1_lifetime_chg_mah', until + DAY, until + 2 * DAY), []);
    const one = rr.queryFirstLast!('SN-EDGE', 'pack1_lifetime_chg_mah', base, base);
    assert.equal(one.length, 1, 'a single-sample window returns one point, not a duplicated pair');
  } finally {
    rr.close();
  }
});

/* ── review-driven killing tests (v1.19.0 pre-merge review) ───────── */

test('F17 review — a short counter history (≤2 tail windows) cannot self-validate and must read null', () => {
  const now = 1_790_000_000_000;
  // 5 days of history at 96.5% — the artifact's in-band low tail on a FRESH
  // series (recorder reset, packSn re-key, new pack). With ≤7 d of points the
  // tail === the full window, ratio === fullRatio, and both new gates
  // degenerate into the plain clamp — the pre-guard code republished this as
  // "early cell aging" at max risk for the series' first week.
  const s = counterSeries({ nowMs: now, days: 5, headRatio: 0.965, tailRatio: 0.965 });
  assert.equal(coulombicEfficiencyFromCounters(s.chg, s.dsg, now), null, 'short history must not publish');
  // 13 days still fails the 14-day (2× tail window) span floor…
  const s13 = counterSeries({ nowMs: now, days: 13, headRatio: 0.995, tailRatio: 0.995 });
  assert.equal(coulombicEfficiencyFromCounters(s13.chg, s13.dsg, now), null, '13-day span is below the 2×-tail floor');
  // …and 14 days exactly passes (inclusive boundary; healthy data publishes).
  const s14 = counterSeries({ nowMs: now, days: 14, headRatio: 0.995, tailRatio: 0.995 });
  assert.ok(coulombicEfficiencyFromCounters(s14.chg, s14.dsg, now) != null, '14-day span earns trust');
});

test('F17 review — the long-window sanity gate is load-bearing ALONE (consistency cannot mask its removal)', () => {
  const now = 1_790_000_000_000;
  // head 102% / tail 99.5% over 30 d: fullRatio ≈ 101.4% (>100.5 — counters
  // proven artifact-ridden) while |tail − full| = 1.9 pp ≤ 2 (consistency
  // PASSES). Only the sanity gate stands between this fixture and a published
  // 99.5 — the mutation review proved the headline artifact test was killed
  // by the consistency gate instead, leaving sanity-gate removal invisible.
  const s = counterSeries({ nowMs: now, days: 30, headRatio: 1.02, tailRatio: 0.995 });
  assert.equal(
    coulombicEfficiencyFromCounters(s.chg, s.dsg, now),
    null,
    'an unphysical long-window ratio must null the CE even when consistency passes',
  );
});

test('F17 review — the 7-day tail cutoff is INCLUSIVE (a sample exactly at now−7d anchors the tail)', () => {
  const now = 1_790_000_000_000;
  // Three points: 14 d ago, EXACTLY 7 d ago, 1 d ago. With >= the tail is
  // [now−7d, now−1d] → 2 points → publishes 99.5. With > (mutant) the tail is
  // a single point → null. Span 13 d... must be ≥14 d — use 15 d ago instead.
  const chg = [
    { ts: now - 15 * DAY, value: 1_000_000 },
    { ts: now - 7 * DAY, value: 1_200_000 },
    { ts: now - 1 * DAY, value: 1_400_000 },
  ];
  const dsg = [
    { ts: now - 15 * DAY, value: 1_000_000 },
    { ts: now - 7 * DAY, value: 1_199_000 },
    { ts: now - 1 * DAY, value: 1_398_000 },
  ];
  const ce = coulombicEfficiencyFromCounters(chg, dsg, now);
  assert.ok(ce != null, 'the boundary sample must anchor the tail (inclusive >=)');
  assert.ok(ce! >= 99 && ce! <= 100, `tail CE ≈ 99.5; got ${ce}`);
});

test('F17 review — the full-window throughput floor is load-bearing (thin history cannot publish on a busy tail)', () => {
  const now = 1_790_000_000_000;
  // Head nearly idle (5k mAh over 23 d), tail busy (15k over 7 d): the 7-day
  // floor (10k) passes but the full window (20k < 30k) must not — a window
  // this thin cannot power the sanity check it feeds.
  const chg = [
    { ts: now - 30 * DAY, value: 1_000_000 },
    { ts: now - 7 * DAY, value: 1_005_000 },
    { ts: now - 1 * DAY, value: 1_020_000 },
  ];
  const dsg = [
    { ts: now - 30 * DAY, value: 1_000_000 },
    { ts: now - 7 * DAY, value: 1_004_975 },
    { ts: now - 1 * DAY, value: 1_019_900 },
  ];
  assert.equal(coulombicEfficiencyFromCounters(chg, dsg, now), null, 'full-window floor must gate a thin history');
});

test('F20 review — re-capture refreshes LRU recency: a hot recurring alert survives cap eviction', () => {
  const t0 = 1_795_000_000_000;
  captureSnapshot({ alertId: 'hot-recurring', ts: t0, features: { pack_soc: 20 } });
  // Push the hot alert to the oldest edge of the 500-entry cache…
  for (let i = 0; i < 499; i++) {
    captureSnapshot({ alertId: `cold-a-${i}`, ts: t0 + i, features: { n: i } });
  }
  // …then it re-fires (a genuine new rise, past the 60 s guard). Without
  // delete-before-set, Map.set keeps the ORIGINAL insertion position: the
  // hottest alert stays "oldest" and is the first evicted while stale
  // one-shots survive — getSnapshot at outcome time then misses a LIVE alert.
  captureSnapshot({ alertId: 'hot-recurring', ts: t0 + 2 * HOUR, features: { pack_soc: 12 } });
  // 499 more captures evict everything older than the refreshed entry.
  for (let i = 0; i < 499; i++) {
    captureSnapshot({ alertId: `cold-b-${i}`, ts: t0 + 3 * HOUR + i, features: { n: i } });
  }
  assert.ok(getSnapshot('hot-recurring'), 're-captured alert must rank by its LATEST fire, not its first');
  assert.equal(getSnapshot('hot-recurring')?.features.pack_soc, 12);
  assert.equal(getSnapshot('cold-a-0'), undefined, 'stale one-shots are the ones evicted');
});
