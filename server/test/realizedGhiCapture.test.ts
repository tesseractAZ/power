import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

/**
 * Stage 1 of correcting the irradiance basis: capture the provider's PAST-HOUR GHI,
 * feed nothing.
 *
 * `weather/ghi_wm2` is not realized irradiance. recordWeatherGhi keeps the FIRST value
 * ever written for an hour, and the first fetch containing an hour sees it ~3-4 days
 * ahead, so the later past_days value never replaces it. On 2026-09-11 the stored hours
 * 8-15 summed 3,180 W/m² against 5,296 in the provider's past-hour values.
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
const { openMeteoHours } = await import('../src/weather.js');

const H = 3_600_000;
const BASE = 1_789_000_000_000 - (1_789_000_000_000 % H);
type Row = { epochMs: number; radiationWm2: number | null; cloudCoverPct: number | null; radiationMissing?: boolean };
const hr = (k: number, ghi: number | null, cloud: number | null = 10): Row =>
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

test("the boundary is the hour's END — an hour still in progress at the fetch is not realized", () => {
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

test('a null or non-finite radiation value handed straight to the recorder is skipped', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, null), hr(1, Number.NaN), hr(2, 300)], { fetchedAtMs: BASE + 5 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[2, 300]]);
  });
});

/* ── a value the provider did not send ─────────────────────────────── */

test('★ a missing provider radiation value is FLAGGED at parse time; its stand-in 0 is kept for existing consumers', () => {
  const hours = openMeteoHours({
    utc_offset_seconds: 0,
    hourly: {
      time: ['2026-09-11T18:00', '2026-09-11T19:00', '2026-09-11T20:00'],
      shortwave_radiation: [850, null],
      cloud_cover: [10, 20, 30],
      temperature_2m: [30, 31, 32],
    },
  });
  assert.deepEqual(hours.map((h) => [h.radiationWm2, h.radiationMissing === true]), [[850, false], [0, true], [0, true]],
    'a null and a short array both flag the hour; radiationWm2 stays the historical stand-in 0');
  assert.equal(hours[0].radiationMissing, undefined, 'a real value carries no flag at all');
  assert.equal(hours[0].ts, Date.UTC(2026, 8, 11, 18), 'no timezone is requested, so the times are GMT');
});

test('a response with no radiation array at all flags every hour', () => {
  const hours = openMeteoHours({ utc_offset_seconds: 0, hourly: { time: ['2026-09-11T18:00', '2026-09-11T19:00'] } });
  assert.deepEqual(hours.map((h) => h.radiationMissing === true), [true, true]);
});

test('★ a missing provider value never captures, and never revises a captured hour down to its stand-in 0', () => {
  fresh((rec) => {
    rec.recordWeatherGhi([hr(0, 850), hr(1, 700)], { fetchedAtMs: BASE + 3 * H });
    rec.recordWeatherGhi([{ ...hr(0, 0), radiationMissing: true }, hr(1, 700), { ...hr(2, 0), radiationMissing: true }],
      { fetchedAtMs: BASE + 4 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 850], [1, 700]],
      'hour 0 keeps its reading and hour 2 is not captured as a 0');
    assert.deepEqual(series(rec, 'ghi_wm2'), [[0, 850], [1, 700], [2, 0]],
      'the first-write series still receives the stand-in 0, exactly as before');
  });
});

test('the flag survives the whole path: provider JSON → parse → rows → recorder', () => {
  fresh((rec) => {
    const t = (k: number) => new Date(BASE + k * H).toISOString().slice(0, 16);
    const json = (rad: Array<number | null>) =>
      ({ utc_offset_seconds: 0, hourly: { time: [t(0), t(1)], shortwave_radiation: rad, cloud_cover: [0, 0], temperature_2m: [0, 0] } });
    // Mirrors index.ts weatherGhiRows, whose flag mapping the BRIDGE test pins by source.
    const rows = (hs: ReturnType<typeof openMeteoHours>) =>
      hs.map((h) => ({ epochMs: h.ts, radiationWm2: h.radiationWm2, cloudCoverPct: h.cloudCoverPct, radiationMissing: h.radiationMissing === true }));
    rec.recordWeatherGhi(rows(openMeteoHours(json([850, 700]))), { fetchedAtMs: BASE + 3 * H });
    rec.recordWeatherGhi(rows(openMeteoHours(json([null, 720]))), { fetchedAtMs: BASE + 3 * H });
    assert.deepEqual(series(rec, 'ghi_wm2_realized'), [[0, 850], [1, 720]]);
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

test('the extraction is exact for consumers: a null body still throws, and a non-finite number passes through flagged', () => {
  assert.throws(() => openMeteoHours(null), TypeError, "getWeather's catch must still treat a null body as a failed fetch and keep its stale cache");
  const [h] = openMeteoHours({ utc_offset_seconds: 0, hourly: { time: ['2026-09-11T18:00'], shortwave_radiation: [Number.POSITIVE_INFINITY] } });
  assert.equal(h.radiationWm2, Number.POSITIVE_INFINITY, 'consumers receive exactly what `sw[i] ?? 0` gave them before');
  assert.equal(h.radiationMissing, true, 'but the capture never records it');
});

/* ── the stage-1 invariant ──────────────────────────────────────────── */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const METRIC = 'ghi_wm2_realized';
const CONSTANT = 'WEATHER_GHI_REALIZED_METRIC';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** References found by the TypeScript PARSER, so comments, regex literals and strings are
 *  told apart correctly (a regex comment-stripper hid ~118 lines of index.ts behind a
 *  `/*` inside a `//` comment). */
function realizedRefs(fileName: string, text: string): ts.Node[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (literal && (n as ts.LiteralLikeNode).text.includes(METRIC)) hits.push(n);
    else if (ts.isIdentifier(n) && n.text === CONSTANT) hits.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

test('the reference finder sees code the old regex could not, and ignores comments', () => {
  const seen = (src: string) => realizedRefs('probe.ts', src).length;
  assert.equal(seen("// served at /audio/*. comment\nconst a = q('weather', 'ghi_wm2_realized');\n/* ok */"), 1,
    'code after a `/*` inside a line comment is still code');
  assert.equal(seen("const re = /\\/\\*[\\s\\S]*?\\*\\//g;\nconst b = `x ${re} ghi_wm2_realized`;"), 1,
    'a regex literal containing comment markers does not hide the next line');
  assert.equal(seen("// 'ghi_wm2_realized' named in prose\n/* WEATHER_GHI_REALIZED_METRIC */"), 0,
    'prose in comments may still name it');
});

test('★★ STAGE 1 INVARIANT: no code outside the recorder reads the realized series', () => {
  // A source scan, used deliberately and as a last resort: the property is an ABSENCE
  // across the whole server — no calibrator, trainer, planner or report may consume
  // realized GHI until the basis switch ships as its own reviewed change. A consumer
  // added quietly would re-score the band calibration and move the night-charge basis
  // gate with no review point.
  const readers = tsFiles(SRC)
    .filter((p) => realizedRefs(p, readFileSync(p, 'utf8')).length > 0)
    .map((p) => relative(SRC, p))
    .sort();
  assert.deepEqual(readers, ['recorder.ts'], `realized GHI must be written only, got references in: ${readers.join(', ')}`);
});

test('★ inside the recorder, the realized metric is used only by the capture itself', () => {
  // The allowlist above covers the whole recorder, so a new accessor there would expose
  // the series to any caller while the scan still passed.
  const file = join(SRC, 'recorder.ts');
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { span: [number, number] | null } = { span: null };
  const find = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'recordWeatherGhi') found.span = [n.getStart(sf), n.getEnd()];
    else ts.forEachChild(n, find);
  };
  find(sf);
  assert.ok(found.span, 'recordWeatherGhi must still be a declared function in the recorder');
  const [from, to] = found.span;
  const outside = realizedRefs(file, text).filter((n) => {
    const at = n.getStart(sf);
    if (at >= from && at < to) return false;
    const decl = n.parent;
    return !(decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.name.text === CONSTANT);
  });
  assert.deepEqual(outside.map((n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1), [],
    'only the constant declaration and recordWeatherGhi may reference the realized metric');
  assert.ok(realizedRefs(file, text).filter((n) => n.getStart(sf) >= from && n.getStart(sf) < to).length >= 2,
    'positive control: the capture itself does reference it');
});

test('★ BRIDGE: both GHI writers pass the fetch time, and the rows carry the missing-value flag', () => {
  // Both call sites sit in index.ts closures with no injection seam. Without the fetch
  // time the recorder captures nothing, and every test above still passes.
  const idx = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.equal(idx.split('recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });').length - 1, 2,
    'the ensemble handler and the 45-min persistence tick must both pass w.fetchedAt');
  assert.equal(idx.split('recorder.recordWeatherGhi(weatherGhiRows(w));').length - 1, 0,
    'no call site may drop the fetch time');
  assert.match(idx, /radiationMissing: h\.radiationMissing === true,/, 'weatherGhiRows must carry the provider-missing flag');
});
