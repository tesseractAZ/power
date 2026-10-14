#!/usr/bin/env node
/**
 * mutate-v1187-23.mjs — v1.187.23: what is spoken or pushed states only what the system measures.
 * The reconnect report carries no fixed prediction; the idle-pool push states the kWh above the
 * reserve on the pool's measured capacity (the nameplate only as a named fallback); a range is
 * read "to" ("a"), not as a pause.
 *
 *   R-i     the reconnect report ends with a fixed prediction again
 *   R-ii    the reconnect report drops the measured PV-coverage line
 *   C-i     idlePoolInputsFrom ignores the measured capacity (the nameplate always)
 *   C-ii    the monitor tick passes no measured capacity (the forecast feed's poolFullWh unread)
 *   C-iii   a zero, negative or non-finite measured capacity is taken as one
 *   C-iv    the nameplate fallback is labelled measured
 *   C-v     the push no longer names the nameplate basis
 *   C-vi    a verdict with no kWh figure still carries a basis
 *   C-vii   with no house panel the forecast's capacity is read anyway
 *   T-i     the English normalizer reads no range (every dash a pause again)
 *   T-ii    the Spanish normalizer reads no range
 *   T-iii   the Spanish normalizer reads ranges with " to "
 *   T-iv    the Spanish normalizer knows only English weekday names
 *   T-v     a SPACED dash between numbers is read as a range (prose read "to")
 *   T-vi    an em dash between numbers is not a range
 *   T-vii   a number carrying a unit or am/pm before the dash is not a range ("10am–3pm")
 *   T-viii  a weekday-prefixed time after the dash is not a range ("23:00–Tue 05:00")
 *   T-ix    weekday ranges are not read ("Mon–Fri" a pause)
 *   T-x     a weekday name inside a longer word is read as one ("Sun-Monitor")
 *   T-xi    the hyphen rule reads a number after a word char, '.', ':' or hyphen (versions, chains)
 *   T-xii   the hyphen rule needs no unit (a bare number pair, a date read "to")
 *   T-xiii  am/pm or % before the hyphen is not a range ("10am-3pm")
 *   T-xiv   the hyphen unit list loses a source token its expansion keeps (not idempotent)
 *
 *   node scripts/mutate-v1187-23.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RA = resolve(REPO, 'server/src/reconnectAudit.ts');
const AM = resolve(REPO, 'server/src/alertMonitor.ts');
const PG = resolve(REPO, 'server/src/peakGridDraw.ts');
const TTS = resolve(REPO, 'server/src/ttsService.ts');
const SUBSET = [
  'test/reconnectAudit.test.ts',
  'test/peakIdlePool.test.ts',
  'test/peakIdlePoolMeasuredCapacity.test.ts',
  'test/ttsRangeRead.test.ts',
  'test/ttsVerbalize.test.ts',
  'test/ttsServiceEs.test.ts',
];

const MUTANTS = [
  /* ── the reconnect report ── */
  {
    id: 'R-i. ★★★ the reconnect report ends with a fixed prediction again',
    file: RA,
    find: '      + `Offline alert resolved: ${res}. Packs: ${packs}. ${cov}.`,',
    to: '      + `Offline alert resolved: ${res}. Packs: ${packs}. ${cov}. Expect local solar to rise ~20 kWh/day.`, /* MUTANT */',
    why: 'A constant from one past outage on one installation is pushed as the outcome whichever device returns.',
  },
  {
    id: 'R-ii. ★★ the reconnect report drops the measured PV-coverage line',
    file: RA,
    find: '      + `Offline alert resolved: ${res}. Packs: ${packs}. ${cov}.`,',
    to: '      + `Offline alert resolved: ${res}. Packs: ${packs}.`, /* MUTANT */',
    why: 'The one measured outcome of the reconnect is no longer reported.',
  },

  /* ── the idle-pool kWh on the measured capacity ── */
  {
    id: 'C-i. ★★★ idlePoolInputsFrom ignores the measured capacity',
    file: AM,
    find: '    poolFullWh: p == null ? null : measured ? measuredPoolFullWh : nameplate,',
    to: '    poolFullWh: p == null ? null : nameplate, /* MUTANT */',
    why: 'The push states (soc − reserve)% of the 92.16 kWh nameplate while the SoC is a share of ~87.0 kWh.',
  },
  {
    id: 'C-ii. ★★★ the monitor tick passes no measured capacity',
    file: AM,
    find: 'idlePoolInputsFrom(snap.devices, grid.present, idleNowMs, forecastNow?.poolFullWh)',
    to: 'idlePoolInputsFrom(snap.devices, grid.present, idleNowMs) /* MUTANT */',
    why: 'The fix is inert in production: the forecast feed holds the measured capacity and the detector never sees it.',
  },
  {
    id: 'C-iii. ★★ a zero, negative or non-finite measured capacity is taken as one',
    file: AM,
    find: '  const measured = measuredPoolFullWh != null && Number.isFinite(measuredPoolFullWh) && measuredPoolFullWh > 0;',
    to: '  const measured = measuredPoolFullWh != null; /* MUTANT */',
    why: 'A forecast with a broken pool figure pushes "about 0.0 kWh above it" (or NaN) as a measurement.',
  },
  {
    id: 'C-iv. ★★ the nameplate fallback is labelled measured',
    file: AM,
    find: "    poolCapacityBasis: p == null ? null : measured ? 'measured' : nameplate != null ? 'nameplate' : null,",
    to: "    poolCapacityBasis: p == null ? null : 'measured', /* MUTANT */",
    why: 'The rated size is presented as what the pool holds, unlabelled.',
  },
  {
    id: 'C-v. ★★ the push no longer names the nameplate basis',
    file: PG,
    find: "  const onNameplate = v.poolCapacityBasis === 'nameplate';",
    to: '  const onNameplate = false; /* MUTANT */',
    why: 'A figure computed on the nameplate is pushed as if measured.',
  },
  {
    id: 'C-vi. ★ a verdict with no kWh figure still carries a basis',
    file: PG,
    find: '    poolCapacityBasis: above == null ? null : (i.poolCapacityBasis ?? null),',
    to: '    poolCapacityBasis: i.poolCapacityBasis ?? null, /* MUTANT */',
    why: 'The verdict names a capacity basis for a figure it does not have.',
  },
  {
    id: 'C-vii. ★ with no house panel the forecast\'s capacity is read anyway',
    file: AM,
    find: '    poolFullWh: p == null ? null : measured ? measuredPoolFullWh : nameplate,',
    to: '    poolFullWh: measured ? measuredPoolFullWh : nameplate, /* MUTANT */',
    why: 'Inputs claim a pool capacity for a panel that is not there.',
  },

  /* ── ranges read "to" / "a" ── */
  {
    id: 'T-i. ★★★ the English normalizer reads no range',
    file: TTS,
    find: "  return readRanges(s, ' to ')",
    to: '  return s /* MUTANT */',
    why: '"On-Peak (4–7pm Mon–Fri)" is spoken "On-Peak 4, 7pm Mon, Fri" on every peak-grid-draw again.',
  },
  {
    id: 'T-ii. ★★★ the Spanish normalizer reads no range',
    file: TTS,
    find: "  return readRanges(s, ' a ', ES_WEEKDAY_RANGE_RE)",
    to: '  return s /* MUTANT */',
    why: 'The Spanish pass reads a range as a pause.',
  },
  {
    id: 'T-iii. ★★ the Spanish normalizer reads ranges with " to "',
    file: TTS,
    find: "  return readRanges(s, ' a ', ES_WEEKDAY_RANGE_RE)",
    to: "  return readRanges(s, ' to ', ES_WEEKDAY_RANGE_RE) /* MUTANT */",
    why: 'An English word in a Spanish template\'s range.',
  },
  {
    id: 'T-iv. ★ the Spanish normalizer knows only English weekday names',
    file: TTS,
    find: "  return readRanges(s, ' a ', ES_WEEKDAY_RANGE_RE)",
    to: "  return readRanges(s, ' a ') /* MUTANT */",
    why: '"lunes-viernes" is read as a hyphenated word.',
  },
  {
    id: 'T-v. ★★★ a SPACED dash between numbers is read as a range',
    file: TTS,
    find: "min|s|mo)(?![A-Za-z]))?)[–—](?=\\$?\\d|",
    to: "min|s|mo)(?![A-Za-z]))?)\\s*[–—]\\s*(?=\\$?\\d|",
    why: 'Prose is read as a range: "Core 3 — 45%" becomes "Core 3 to 45 percent".',
  },
  {
    id: 'T-vi. ★ an em dash between numbers is not a range',
    file: TTS,
    find: "min|s|mo)(?![A-Za-z]))?)[–—](?=\\$?\\d|",
    to: "min|s|mo)(?![A-Za-z]))?)[–](?=\\$?\\d|",
    why: '"4—7 h" is read with a pause.',
  },
  {
    id: 'T-vii. ★★ a number carrying a unit or am/pm before the dash is not a range',
    file: TTS,
    find: "  String.raw`(\\d(?:\\s?(?:am|pm|%|°[FC]|kWh|kWp|Wh|kW|W|mAh|Ah|mA|A|mV|kV|V|h|hrs?|min|s|mo)(?![A-Za-z]))?)[–—]",
    to: "  String.raw`(\\d)[–—]",
    why: '"Super Off-Peak (10am–3pm …)" and "36%–38%" are read with a pause.',
  },
  {
    id: 'T-viii. ★ a weekday-prefixed time after the dash is not a range',
    file: TTS,
    find: '(?=\\$?\\d|(?:${EN_WEEKDAYS}|${ES_WEEKDAYS}) \\d)`,',
    to: '(?=\\$?\\d)`, /* MUTANT */',
    why: 'The night-charge window "23:00–Tue 05:00" is read with a pause.',
  },
  {
    id: 'T-ix. ★★★ weekday ranges are not read',
    file: TTS,
    find: '    .replace(weekdayRange, `$1${to}`)',
    to: '    /* MUTANT */',
    why: '"Mon–Fri" is spoken "Mon, Fri".',
  },
  {
    id: 'T-x. ★ a weekday name inside a longer word is read as one',
    file: TTS,
    find: '((?:${days})\\.?)[–—-](?=(?:${days})(?!\\p{L}))',
    to: '((?:${days})\\.?)[–—-](?=(?:${days}))',
    why: '"Sun-Monitor" is read "Sun to Monitor".',
  },
  {
    id: 'T-xi. ★★ the hyphen rule reads a number after a word char, a dot, a colon or a hyphen',
    file: TTS,
    find: '  String.raw`(?<![\\w.:\\-−])(\\d{1,4}',
    to: '  String.raw`(\\d{1,4}',
    why: 'A version or a hyphen chain ("1.187.22-3 h", "1-2-3 W") is read as a range.',
  },
  {
    id: 'T-xii. ★★★ the hyphen rule needs no unit',
    file: TTS,
    find: '-(?=\\d{1,4}(?:\\.\\d+)?\\s?(?:%|°[FC]|(?:${RANGE_UNITS_AFTER})\\b))`,',
    to: '-(?=\\d{1,4})`, /* MUTANT */',
    why: 'A score, a date or an id is read as a range ("score 3 to 2", "2026 to 10-12").',
  },
  {
    id: 'T-xiii. ★ am/pm or % before the hyphen is not a range',
    file: TTS,
    find: '(\\d{1,4}(?:\\.\\d+)?(?:\\s?(?:am|pm|%))?)-(?=',
    to: '(\\d{1,4}(?:\\.\\d+)?)-(?=',
    why: '"10am-3pm" is read "10am-3pm".',
  },
  {
    id: 'T-xiv. ★★ the hyphen unit list loses a source token its expansion keeps',
    file: TTS,
    find: "|min|minutes?|s|seconds?|mo|months?|days?|",
    to: "|min|minutes?|s|seconds?|months?|days?|",
    why: '"4-7 mo" is left on the first pass and read "4 to 7 months" on the second: the normalizer is no longer idempotent.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-23', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
