#!/usr/bin/env node
/**
 * mutate-realized-ghi.mjs — committed mutation harness for stage 1 of correcting the
 * irradiance basis.
 *
 * WHY COMMITTED: `weather/ghi_wm2` has never been realized irradiance. recordWeatherGhi
 * keeps the FIRST value written for each hour, which is a ~3-4-day-lead forecast, so the
 * forecast-skill hindcast — and through it the PV band calibration and the night-charge
 * basis gate — has been scored against forecast irradiance (09-11: 3,180 stored vs 5,296
 * W/m² in the provider's past-hour values).
 *
 * The obvious fix (let the later value win in `ghi_wm2`) re-scores the 30-day calibration
 * within the hour and moves the gate and the P10 band that size a SUPERVISED reserve
 * write, with no review point. Stage 1 therefore captures the past-hour values as a
 * separate series that nothing reads. Both halves are easy to undo by accident: a
 * refactor that stops capturing (or captures a provider gap as 0) spoils data past_days
 * can never return, and one that starts reading it moves a real write. Each mutant below
 * restores one of those.
 *
 *   node scripts/mutate-realized-ghi.mjs
 *
 * ★ Every anchor is pre-flighted before any test runs; a red subset baseline aborts, and
 *   the full-suite fallback is baselined (once, lazily) before it may count a kill.
 * ★ A test run that could not START (spawn or buffer failure) aborts — it is never
 *   counted as a kill.
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
const WEATHER = resolve(SERVER, 'src/weather.ts');

const SUBSET = [
  'test/realizedGhiCapture.test.ts',
  'test/recorderWeatherGhi.test.ts',
  'test/forecastSkillGuard.test.ts',
];

const MUTANTS = [
  // ── capture ────────────────────────────────────────────────────────────────
  {
    id: 'i. ★★ past-hour GHI is never captured',
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
    why: 'The current hour — partly forecast — is stored as realized, and its later value arrives as a revision the series cannot tell apart.',
  },
  {
    id: 'iii. ★ revisions are discarded (first-write-wins again)',
    file: RECORDER,
    find: '              weatherRealizedUpdateStmt.run(realizedGhi, row.id);',
    to: '              void 0; /* MUTANT: revision dropped */',
    why: 'The series freezes on the first past-hour value it saw — the same class of defect it exists to escape.',
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
    find: '          if (realizedGhi != null && Number.isFinite(realizedGhi) && h.radiationMissing !== true) {',
    to: '          const prevR = weatherPrevStmt.get(WEATHER_SN, WEATHER_GHI_REALIZED_METRIC, ts) as { value: number } | undefined; if (realizedGhi != null && Number.isFinite(realizedGhi) && h.radiationMissing !== true && !(prevR && Math.abs(realizedGhi - prevR.value) < VALUE_EPSILON)) { /* MUTANT: collapse */',
    why: 'Night and overcast hours go missing, and a reader cannot distinguish "same as before" from "never captured".',
  },
  {
    id: 'vi. ★★★ past-hour values are written INTO the consumed series (the tempting fix)',
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
  // ── a value the provider did not send ─────────────────────────────────────
  {
    id: 'viii. ★★ a missing provider value is captured as a realized 0',
    file: RECORDER,
    find: '          if (realizedGhi != null && Number.isFinite(realizedGhi) && h.radiationMissing !== true) {',
    to: '          if (realizedGhi != null && Number.isFinite(realizedGhi)) { /* MUTANT: missing flag ignored */',
    why: 'One gappy response zeroes a week of captured hours; any hour whose last fetch had the gap stays a false dark hour permanently.',
  },
  {
    id: 'ix. ★ the parser stops flagging a missing radiation value',
    file: WEATHER,
    find: '      ...(missing ? { radiationMissing: true } : {}),',
    to: '      /* MUTANT: flag dropped */',
    why: 'The stand-in 0 is indistinguishable from a real zero by the time it reaches the recorder — the recorder\'s own guard can never fire in production.',
  },
  // ── bridges ────────────────────────────────────────────────────────────────
  {
    id: 'x. ★ the rows handed to the recorder drop the missing-value flag',
    file: INDEX,
    find: '    radiationMissing: h.radiationMissing === true,',
    to: '    radiationMissing: false, /* MUTANT */',
    why: 'The parser flags the gap correctly and production still captures the stand-in 0.',
  },
  {
    id: 'xi. ★ the 45-min persistence tick stops passing the fetch time',
    file: INDEX,
    find: '      if (recorder && w && w.hours.length > 0) {\n        recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });',
    to: '      if (recorder && w && w.hours.length > 0) {\n        recorder.recordWeatherGhi(weatherGhiRows(w)); /* MUTANT */',
    why: 'Headless, the tick is the only writer — without the fetch time nothing is ever captured, while every recorder test stays green.',
  },
  {
    id: 'xii. the ensemble handler stops passing the fetch time',
    file: INDEX,
    find: '    try {\n      recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });',
    to: '    try {\n      recorder.recordWeatherGhi(weatherGhiRows(w)); /* MUTANT */',
    why: 'One of the two production writers silently captures nothing.',
  },
  // ── the stage-1 invariant ──────────────────────────────────────────────────
  {
    id: 'xiii. ★★★ the calibrator starts reading past-hour GHI (the basis switch, unreviewed)',
    file: ANALYTICS,
    find: "  const ghiRows = recorder.query('weather', 'ghi_wm2', windowStart, now, 3600);",
    to: "  const ghiRows = recorder.query('weather', 'ghi_wm2_realized', windowStart, now, 3600); /* MUTANT */",
    why: 'The forecast-skill hindcast re-scores on past-hour irradiance, which moves bandRealizedCoveragePct, the basis gate and the P10 band that sizes a supervised write.',
  },
  {
    id: 'xiv. ★★ a recorder accessor exposes the series to any caller',
    file: RECORDER,
    find: '    recordWeatherGhi,\n    recordForecastArchive,',
    to: '    recordWeatherGhi,\n    realizedGhiRows: (s: number, u: number) => [WEATHER_SN, WEATHER_GHI_REALIZED_METRIC, s, u], /* MUTANT */\n    recordForecastArchive,',
    why: 'The source scan allowlists the whole recorder, so an accessor there hands the series to the calibrator without any file outside the recorder naming it.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number') return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    process.exit(2);
  }
}

if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-realized-ghi: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot be used to count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
