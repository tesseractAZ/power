/**
 * v1.191.2 — a day-forecast build reads each connected-but-unprojected Core's 30-day pv_total once,
 * and the forecast it builds is unchanged.
 *
 * The restored display curve (hourCurve) and the restored fleet model (pvHourlyByEpoch) each issued the
 * identical (SN, pv_total, 30 days, 300 s) query for every connected Core with no projection: with
 * every home Core cloud-dark, three of a build's six 30-day pv_total scans, about 40 % of a warm
 * rebuild on the snapshot database. The build now reads the series once and hands the points to both.
 *
 * test/fixtures/darkFleetForecastCapture.ts builds the forecast on a fixed dark-fleet fixture with the
 * clock frozen, in a child process with TZ=America/Phoenix and a reduced environment (as the goldens
 * are captured: the result must not depend on the runner's zone). darkFleetForecast.golden.json is that
 * capture on v1.191.1 (dabedbf8), which read each series twice; the current tree must write the same
 * forecast to the byte. Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const CAPTURE = resolve(HERE, 'fixtures', 'darkFleetForecastCapture.ts');
const GOLDEN = resolve(HERE, 'fixtures', 'darkFleetForecast.golden.json');

function capture(): Promise<{ forecast: unknown; queries: Record<string, number> }> {
  return new Promise((res, rej) => {
    execFile(process.execPath, ['--import', 'tsx', CAPTURE], {
      cwd: SERVER,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'America/Phoenix', TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`capture failed: ${err.message}\n${stderr}`));
      try { res(JSON.parse(stdout)); } catch (e) { rej(new Error(`capture wrote non-JSON: ${(e as Error).message}\n${stdout.slice(0, 400)}`)); }
    });
  });
}

/** The first line at which two texts differ, with both sides. */
function firstLineDiff(a: string, b: string): string | null {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}: golden ${JSON.stringify(al[i])} ≠ live ${JSON.stringify(bl[i])}`;
  }
  return null;
}

const live = capture();

test('★★★ a dark-fleet build reads each connected Core\'s 30-day pv_total once', async () => {
  const { queries } = await live;
  const pv = Object.entries(queries).filter(([k]) => k.split('|')[1] === 'pv_total');
  assert.equal(pv.length, 3, `one series per connected Core: ${JSON.stringify(pv)}`);
  for (const [key, n] of pv) assert.equal(n, 1, `${key} read ${n} times`);
  for (const [key, n] of Object.entries(queries)) assert.equal(n, 1, `every recorder query of the build is distinct (${key} read ${n} times)`);
});

test('★★★ … and the forecast is byte-identical to v1.191.1\'s on the same fixture', async () => {
  const { forecast } = await live;
  const golden = readFileSync(GOLDEN, 'utf8');
  const text = JSON.stringify(forecast, null, 1) + '\n';
  assert.ok(text === golden, firstLineDiff(golden, text) ?? 'differs');
  // The control: the fixture exercises what the single read feeds.
  const f = forecast as { structurallyIncomplete: boolean; homeDpusConnected: number; homeDpusReporting: number; restoredSolarModel: { pairCount: number }; forecastPvWhNext24Display: number };
  assert.equal(f.structurallyIncomplete, false);
  assert.equal(f.homeDpusConnected, 3);
  assert.equal(f.homeDpusReporting, 0, 'every Core dark');
  assert.ok(f.restoredSolarModel.pairCount > 0, 'the restored fleet model is fitted on the series read once');
  assert.ok(f.forecastPvWhNext24Display > 0, 'and the restored curve sums it');
});
