#!/usr/bin/env node
/**
 * mutate-realized-ghi.mjs — committed mutation harness for stage 1 of correcting the
 * irradiance basis.
 *
 * WHY COMMITTED: `weather/ghi_wm2` has never been realized irradiance. recordWeatherGhi
 * keeps the FIRST value written for each hour, which is a ~3-4-day-lead forecast, so the
 * forecast-skill hindcast — and through it the PV band calibration and the night-charge
 * basis gate — has been scored against forecast irradiance. On 2026-09-11 that turned
 * 5,296 W/m² of realized sun into 3,180 and a −40% "miss".
 *
 * The obvious fix (let the later value win in `ghi_wm2`) re-scores the 30-day calibration
 * within the hour and moves the gate and the P10 band that size a SUPERVISED reserve
 * write, with no review point. Stage 1 therefore captures realized GHI as a separate
 * series that nothing reads. Both halves are easy to undo by accident: a refactor that
 * stops capturing loses data that past_days can never return, and a refactor that starts
 * reading it moves a real write. Each mutant below restores one of those.
 *
 *   node scripts/mutate-realized-ghi.mjs
 *
 * ★ Every anchor is pre-flighted before any test runs; a red baseline aborts.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const RECORDER = resolve(SERVER, 'src/recorder.ts');
const INDEX = resolve(SERVER, 'src/index.ts');
const ANALYTICS = resolve(SERVER, 'src/analytics.ts');

const SUBSET = [
  'test/realizedGhiCapture.test.ts',
  'test/recorderWeatherGhi.test.ts',
  'test/forecastSkillGuard.test.ts',
];

const MUTANTS = [
  // ── capture ────────────────────────────────────────────────────────────────
  {
    id: 'i. ★★ realized GHI is never captured',
    file: RECORDER,
    find: '        if (fetchedAtMs != null && ts + 3_600_000 <= fetchedAtMs) {',
    to: '        if (false /* MUTANT */ && fetchedAtMs != null && ts + 3_600_000 <= fetchedAtMs) {',
    why: 'Every past_days value keeps being thrown away; after ~7 days it cannot be fetched again, so the evidence stage 2 needs is gone for good.',
  },
  {
    id: 'ii. ★ an hour still in progress at fetch time is captured as realized',
    file: RECORDER,
    find: '        if (fetchedAtMs != null && ts + 3_600_000 <= fetchedAtMs) {',
    to: '        if (fetchedAtMs != null && ts <= fetchedAtMs) { /* MUTANT */',
    why: 'The current hour — partly forecast — is stored as realized, and its later true value arrives as a revision the series cannot tell apart.',
  },
  {
    id: 'iii. ★ revisions are discarded (first-write-wins again)',
    file: RECORDER,
    find: '              weatherRealizedUpdateStmt.run(realizedGhi, row.id);',
    to: '              void 0; /* MUTANT: revision dropped */',
    why: 'The realized series freezes on the first past_days value it saw — the same class of defect it exists to escape.',
  },
  {
    id: 'iv. every capture inserts a new row',
    file: RECORDER,
    find: '            if (row == null) {',
    to: '            if (true /* MUTANT: always insert */) {',
    why: 'Each 45-minute tick duplicates up to seven days of hours; bucketed readers average the copies and unbucketed readers double-count them.',
  },
  {
    id: 'v. flat runs collapse like the first-write series',
    file: RECORDER,
    find: '          if (realizedGhi != null && Number.isFinite(realizedGhi)) {',
    to: '          const prevR = weatherPrevStmt.get(WEATHER_SN, WEATHER_GHI_REALIZED_METRIC, ts) as { value: number } | undefined; if (realizedGhi != null && Number.isFinite(realizedGhi) && !(prevR && Math.abs(realizedGhi - prevR.value) < VALUE_EPSILON)) { /* MUTANT: collapse */',
    why: 'Night and overcast hours go missing, and a reader cannot distinguish "same as before" from "never captured".',
  },
  {
    id: 'vi. ★★★ realized values are written INTO the consumed series (the tempting fix)',
    file: RECORDER,
    find: "const WEATHER_GHI_REALIZED_METRIC = 'ghi_wm2_realized';",
    to: "const WEATHER_GHI_REALIZED_METRIC = 'ghi_wm2'; /* MUTANT */",
    why: 'Revisions overwrite ghi_wm2 in place: the band calibration re-scores within the hour and can open the basis gate for a supervised reserve write with no review.',
  },
  {
    id: 'vii. the first-write series starts accepting later values as new rows',
    file: RECORDER,
    find: '          if (weatherExistsStmt.get(WEATHER_SN, metric, ts)) continue;',
    to: '          /* MUTANT: first-write-wins removed */',
    why: 'Stage 1 is supposed to leave every current consumer reading exactly what it read before; this changes ghi_wm2 underneath all of them.',
  },
  // ── bridges ────────────────────────────────────────────────────────────────
  {
    id: 'viii. ★ the 45-min persistence tick stops passing the fetch time',
    file: INDEX,
    find: '      if (recorder && w && w.hours.length > 0) {\n        recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });',
    to: '      if (recorder && w && w.hours.length > 0) {\n        recorder.recordWeatherGhi(weatherGhiRows(w)); /* MUTANT */',
    why: 'Headless, the tick is the only writer — without the fetch time nothing is ever captured, while every recorder test stays green.',
  },
  {
    id: 'ix. the ensemble handler stops passing the fetch time',
    file: INDEX,
    find: '    try {\n      recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });',
    to: '    try {\n      recorder.recordWeatherGhi(weatherGhiRows(w)); /* MUTANT */',
    why: 'One of the two production writers silently captures nothing.',
  },
  // ── the stage-1 invariant ──────────────────────────────────────────────────
  {
    id: 'x. ★★★ the calibrator starts reading realized GHI (the basis switch, unreviewed)',
    file: ANALYTICS,
    find: "  const ghiRows = recorder.query('weather', 'ghi_wm2', windowStart, now, 3600);",
    to: "  const ghiRows = recorder.query('weather', 'ghi_wm2_realized', windowStart, now, 3600); /* MUTANT */",
    why: 'The forecast-skill hindcast re-scores on realized irradiance, which moves bandRealizedCoveragePct, the basis gate and the P10 band that sizes a supervised write.',
  },
];

function runSubset() {
  execFileSync('node', ['--import', 'tsx', '--test', ...SUBSET], { cwd: SERVER, stdio: 'pipe' });
}
function runAll() {
  execFileSync('npm', ['test', '--silent'], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    process.exit(2);
  }
}

try { runSubset(); } catch {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let killed = 0;
const survivors = [];
console.log(`mutate-realized-ghi: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { runSubset(); } catch { died = true; }
    if (!died) { try { runAll(); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
