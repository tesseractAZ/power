/**
 * v1.191.3 — the self-consumption, carbon and tariff figures are unchanged by the self-consumption cache
 * on a dark fleet and by the tariff's per-hour slices.
 *
 * test/fixtures/darkFleetEnergyCapture.ts builds the three reports from cold caches on two fleets (every
 * home Core cloud-dark with the house panel projected, and every Core projected) at two instants, in a
 * child process with TZ=America/Phoenix and a reduced environment (as the goldens are captured: the
 * result must not depend on the runner's zone). darkFleetEnergy.golden.json is that capture on v1.191.2
 * (ddd6fb09), before either change; the current tree must write the same figures to the byte.
 *
 * The fixture makes the tariff's slice boundaries observable: at the minute-aligned instant every hourly
 * window starts and ends ON a 60-s sample (a spike sits on each boundary), at the other every window
 * starts between two samples, so the sample before an hour carries its head; two gaps straddle a
 * boundary. Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const CAPTURE = resolve(HERE, 'fixtures', 'darkFleetEnergyCapture.ts');
const GOLDEN = resolve(HERE, 'fixtures', 'darkFleetEnergy.golden.json');

type Any = any;

function capture(): Promise<{ captures: Any[] }> {
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

/** The first path at which two JSON values differ (numbers within a relative 1e-12, as
 *  darkFleetForecastSingleRead.test.ts: V8 builds can differ in the last place of a Math routine). */
function firstValueDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b))) return null;
    return `${path}: golden ${a} ≠ live ${b}`;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? null : `${path}: golden ${JSON.stringify(a)} ≠ live ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a as object); const kb = Object.keys(b as object);
  if (ka.join(',') !== kb.join(',')) return `${path}: keys ${ka.join(',')} ≠ ${kb.join(',')}`;
  for (const k of ka) {
    const d = firstValueDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

const live = capture();

test('★★★ self-consumption, carbon and tariff are byte-identical to v1.191.2\'s, dark and projected, at both instants', async () => {
  const { captures } = await live;
  const golden = readFileSync(GOLDEN, 'utf8');
  const text = JSON.stringify(captures, null, 1) + '\n';
  if (text !== golden) {
    const d = firstValueDiff(JSON.parse(golden), JSON.parse(text));
    assert.equal(d, null, d ?? 'differs');
  }
});

test('★★ the control: the fixture exercises what the change touches', async () => {
  const { captures } = await live;
  assert.equal(captures.length, 4);
  const by = (at: number, fleet: string) => captures.find((c) => c.at === at && c.fleet === fleet);
  for (const at of [0, 17_345]) {
    const dark = by(at, 'dark');
    const projected = by(at, 'projected');
    assert.equal(dark.selfConsumption.homeDpusReporting, 0, 'every Core dark');
    assert.equal(dark.selfConsumption.homeDpusConnected, 3);
    assert.equal(dark.selfConsumption.pvKwh, projected.selfConsumption.pvKwh, 'the dark fleet restores each Core\'s own recorded PV');
    assert.ok(dark.selfConsumption.pvKwh > 0 && dark.selfConsumption.pvToLoadKwh > 0);
    assert.equal(dark.selfConsumption.gridHomeCoverageFrac, 1, 'grid_home_w covers the load window: the whole-home max() branch runs');
    assert.ok(projected.selfConsumption.gridImportKwh > 0, 'one Core charges from AC');
    assert.equal(dark.carbon.basisComplete, false, 'carbon\'s published basis: no Core projected');
    assert.equal(projected.carbon.basisComplete, true);
    assert.ok(dark.carbon.totalKgAvoided > 0);
    assert.equal(dark.tariff.basisComplete, false, 'tariff\'s published basis: no Core projected');
    assert.equal(projected.tariff.basisComplete, true);
    assert.notEqual(projected.tariff.gridImportCostDollars, dark.tariff.gridImportCostDollars, 'the projected fleet prices the Cores\' ac_in hour by hour');
    assert.ok(dark.tariff.gridImportCostDollars > 0 && dark.tariff.solarLoadValueDollars > 0);
  }
  assert.notEqual(by(17_345, 'dark').tariff.gridImportCostDollars, by(0, 'dark').tariff.gridImportCostDollars,
    'the two instants slice the samples differently');
});
