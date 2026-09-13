import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Stage 1 of correcting the irradiance basis: capture REALIZED GHI, feed nothing.
 *
 * `weather/ghi_wm2` is not realized irradiance. recordWeatherGhi keeps the FIRST value
 * ever written for an hour, and the first fetch containing an hour sees it ~3-4 days
 * ahead, so the later past_days value never replaces it. On 2026-09-11 the stored
 * hours 8-15 summed 3,180 W/m² against 5,296 realized — a −40% "forecast miss" that
 * was the weather forecast's.
 *
 * Correcting `ghi_wm2` in place would re-score the band calibration within the hour and
 * move the night-charge basis gate and the P10 band that sizes a supervised reserve
 * write. So this stage writes a SEPARATE series and nothing reads it. These tests pin
 * both halves: what is captured, and that nothing consumes it yet.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-ghi-realized-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const H = 3_600_000;
const BASE = 1_789_000_000_000 - (1_789_000_000_000 % H);
const hr = (k: number, ghi: number | null, cloud: number | null = 10) =>
  ({ epochMs: BASE + k * H, radiationWm2: ghi, cloudCoverPct: cloud });

type Rec = ReturnType<typeof createRecorder>;
const series = (rec: Rec, metric: string) =>
  rec.query('weather', metric, BASE - 48 * H, BASE + 48 * H).map((r) => [(r.ts - BASE) / H, r.value]);

function fresh(fn: (rec: Rec) => void) {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const db = new DatabaseSync(join(tmp, 'ecoflow.db'));
    try { db.exec("DELETE FROM samples WHERE sn IN ('weather', 'forecast')"); } finally { db.close(); }
    fn(rec);
  } finally {
    rec.close();
  }
}

test('★ only hours that had ENDED at fetch time are captured as realized', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, 100), hr(1, 200), hr(2, 300), hr(3, 400), hr(4, 500), hr(5, 600)],
      { fetchedAtMs: BASE + 3 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 100], [1, 200], [2, 300]],
      'hours 0-2 ended by the fetch; 3-5 were still forecast');
    assert.deepEqual(series(rec, 'ghi_wm2'), [[0, 100], [1, 200], [2, 300], [3, 400], [4, 500], [5, 600]],
      'the existing series is written exactly as before');
  });
});

test('the boundary is the hour\'s END — an hour still in progress at the fetch is not realized', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, 100), hr(1, 200), hr(2, 300)], { fetchedAtMs: BASE + 3 * H - 1 });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 100], [1, 200]],
      'hour 2 ends one millisecond after the fetch, so it is not realized yet');
  });
});

test('★ a later fetch REVISES a realized hour in place — and never touches the first-write series', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, 100), hr(1, 200), hr(2, 300)], { fetchedAtMs: BASE + 3 * H });
    rec.recordWeatherGhi([hr(0, 100), hr(1, 250), hr(2, 300), hr(3, 400)], { fetchedAtMs: BASE + 4 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 100], [1, 250], [2, 300], [3, 400]],
      'hour 1 is revised to the later value, hour 3 is newly captured, one row per hour');
    assert.deepEqual(series(rec, 'ghi_wm2'), [[0, 100], [1, 200], [2, 300], [3, 400]],
      'ghi_wm2 keeps its first write — every current consumer reads exactly what it read before');
  });
});

test('night zeros and flat runs are stored explicitly — a missing realized hour never means "same as before"', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, 0), hr(1, 0), hr(2, 0), hr(3, 0)], { fetchedAtMs: BASE + 5 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 0], [1, 0], [2, 0], [3, 0]]);
    assert.equal(series(rec, 'ghi_wm2').length, 1, 'contrast: the first-write series collapses a flat run');
  });
});

test('an identical re-fetch changes nothing', () => {
  fresh((rec) => {
    const batch = [hr(0, 100), hr(1, 200), hr(2, 300)];
    rec.recordWeatherGhi(batch, { fetchedAtMs: BASE + 3 * H });
    rec.recordWeatherGhi(batch, { fetchedAtMs: BASE + 3 * H });
    rec.recordWeatherGhi(batch, { fetchedAtMs: BASE + 3 * H + 30 * 60_000 });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 100], [1, 200], [2, 300]]);
  });
});

test('no fetch time, no realized capture — a caller that cannot say when the values were fetched', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, 100), hr(1, 200)]);
    rec.recordWeatherGhi([hr(0, 100), hr(1, 200)], { fetchedAtMs: Number.NaN });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), []);
    assert.equal(series(rec, 'ghi_wm2').length, 2, 'the existing series is still written');
  });
});

test('an unreadable radiation value is skipped, never stored as 0', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, null), hr(1, Number.NaN), hr(2, 300)], { fetchedAtMs: BASE + 5 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[2, 300]]);
  });
});

test('the forecast archive keeps its own insert-once semantics (it shares statements with the GHI writer)', () => {
  fresh((rec) => {
    rec.recordForecastArchive(40_000, BASE + 5 * 60_000);
    rec.recordForecastArchive(55_000, BASE + 40 * 60_000);
    const rows = rec.query('forecast', 'pv_next24_wh', BASE - H, BASE + 2 * H);
    assert.deepEqual(rows.map((r) => r.value), [40_000], 'the first archive value in an hour wins, as before');
  });
});

/* ── the stage-1 invariant ──────────────────────────────────────────── */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('★★ STAGE 1 INVARIANT: no code outside the recorder reads the realized series', () => {
  // A source scan, used deliberately and as a last resort: the property is an ABSENCE
  // across the whole server — no calibrator, trainer, planner or report may consume
  // realized GHI until the basis switch ships as its own reviewed change. A consumer
  // added quietly would re-score the band calibration and move the night-charge basis
  // gate with no review point. Comments are stripped so prose may still name it.
  const readers = tsFiles(SRC)
    .filter((p) => /ghi_wm2_realized|WEATHER_GHI_REALIZED_METRIC/.test(code(readFileSync(p, 'utf8'))))
    .map((p) => relative(SRC, p))
    .sort();
  assert.deepEqual(readers, ['recorder.ts'], `realized GHI must be written only, got references in: ${readers.join(', ')}`);
});

test('★ BRIDGE: both GHI writers pass the fetch time', () => {
  // Both call sites sit in index.ts closures with no injection seam. Without the fetch
  // time the recorder captures nothing, and every test above still passes.
  const idx = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.equal(idx.split('recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });').length - 1, 2,
    'the ensemble handler and the 45-min persistence tick must both pass w.fetchedAt');
  assert.equal(idx.split('recorder.recordWeatherGhi(weatherGhiRows(w));').length - 1, 0,
    'no call site may drop the fetch time');
});
