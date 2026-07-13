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
const { coulombicEfficiencyFromCounters } = await import('../src/analytics.js');

test('F20 — boot compaction: an oversized history file is rewritten down to the retained LRU entries', () => {
  // First touch initializes the module (hydrate + compact).
  getSnapshot('hist-1999');
  const postBytes = statSync(SNAP_PATH).size;
  assert.ok(preBytes > 512 * 1024, `fixture must exceed the cap (${preBytes} bytes)`);
  assert.ok(postBytes < preBytes / 2, `file must shrink substantially: ${preBytes} → ${postBytes}`);
  const lines = readFileSync(SNAP_PATH, 'utf-8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 500, 'compacted file holds exactly the LRU-retained entries');
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
