import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verbalizeForTts, verbalizeForTtsEs, buildAlertMessage, buildAlertMessageEs } from '../src/ttsService.js';
import { assessPeakDraw, peakGridDrawAlerts, DEFAULT_PEAK_DRAW_CONFIG, type PeakDrawInputs } from '../src/peakGridDraw.js';
import { buildApsREvModel } from '../src/tariff.js';

/**
 * v1.187.23 — a RANGE is read "to" ("a" in Spanish), not as a pause. Both normalizers mapped every
 * em/en dash to ", ", so the tariff's own on-peak label "On-Peak (4–7pm Mon–Fri)" — the title of
 * every spoken peak-grid-draw and its cost sentence — was read "On-Peak 4, 7pm Mon, Fri". A dash
 * tight between two numbers or two weekday names is a range; a spaced dash stays a pause; a
 * hyphen-minus is a range only between two numbers the right one of which carries a unit
 * (never a negative number, a date or an id).
 */

const MIN = 60_000;
/** 2026-08-04 17:22 MST, on-peak (Phoenix is UTC-7). */
const PEAK_TS = Date.UTC(2026, 7, 5, 0, 22);
const TARIFF = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 34.0, winter: 24.0 },
  overnight: { summer: 8.0, winter: 7.0 },
});
/** The real peak-grid-draw alert, its period label from the real tariff model. */
function peakGridDraw() {
  const inputs: PeakDrawInputs = {
    nowMs: PEAK_TS, gridImportW: 11614, panelLoadW: 6505, pvW: 1345, socPct: 41, reserveSocPct: 10,
    gridPresent: true, coreDraws: [{ label: 'Core 1', acInWatts: 7200 }], onsetMs: PEAK_TS - 15 * MIN,
  };
  const [a] = peakGridDrawAlerts(assessPeakDraw(inputs, TARIFF, { ...DEFAULT_PEAK_DRAW_CONFIG, dwellMs: 10 * MIN }), PEAK_TS);
  assert.ok(a, 'the alert is raised');
  return a;
}
const label = (id: string) => TARIFF.periods.find((p) => p.id === id)!.label;

test('★★★ EN — the real peak-grid-draw title reads its on-peak hours and days as ranges', () => {
  const a = peakGridDraw();
  assert.equal(a.title, 'Charging the battery from the grid during On-Peak (4–7pm Mon–Fri)', 'the label as the tariff builds it');
  assert.equal(verbalizeForTts(a.title), 'Charging the battery from the grid during On-Peak 4 to 7pm Mon to Fri');
  assert.match(verbalizeForTts(a.detail), /At the current On-Peak 4 to 7pm Mon to Fri rate that is about \$2\.19 per hour\./);
  // The whole announcement, as the renderer speaks it (it normalizes the assembled message again).
  const spoken = verbalizeForTts(buildAlertMessage('yellow', [a]));
  assert.match(spoken, /On-Peak 4 to 7pm Mon to Fri\./);
  assert.doesNotMatch(spoken, /4, 7pm|Mon, Fri/, spoken);
});

test('★★ EN — the other tariff periods read as ranges too', () => {
  assert.equal(verbalizeForTts(label('super_off_peak')), 'Super Off-Peak 10am to 3pm Mon to Fri, winter');
  assert.equal(verbalizeForTts(label('overnight')), 'Overnight 11pm to 5am Mon to Fri');
  assert.equal(verbalizeForTts('Monday–Friday'), 'Monday to Friday');
  assert.equal(verbalizeForTts('16:00–19:00'), '16:00 to 19:00');
  assert.equal(verbalizeForTts('36–38%'), '36 to 38 percent');
  assert.equal(verbalizeForTts('4—7 h'), '4 to 7 hours', 'a tight em dash between numbers is a range too');
  assert.equal(verbalizeForTts('$1.89–$2.19'), '$1.89 to $2.19');
  assert.equal(verbalizeForTts('Mon-Fri'), 'Mon to Fri', 'a hyphen between weekday names');
  // The night-charge window (fmtPhoenixDayHm): an end a day or more out carries its weekday.
  assert.equal(verbalizeForTts('Charge to ~80% in the 23:00–05:00 window.'), 'Charge to about 80 percent in the 23:00 to 05:00 window.');
  assert.equal(verbalizeForTts('the Mon 23:00–Tue 05:00 window'), 'the Mon 23:00 to Tue 05:00 window');
});

test('★★★ EN — a prose dash stays a pause, also between numbers when it is spaced', () => {
  assert.equal(verbalizeForTts('Backup pool low — 20%'), 'Backup pool low, 20 percent');
  assert.equal(verbalizeForTts('near freezing — derates'), 'near freezing, derates');
  assert.equal(verbalizeForTts('Core 3 — 45% and falling'), 'Core 3, 45 percent and falling');
  assert.equal(verbalizeForTts('Core 3 – 45%'), 'Core 3, 45 percent', 'a spaced en dash is a pause');
  assert.equal(verbalizeForTts('Mon – 5pm'), 'Mon, 5pm');
  assert.equal(verbalizeForTts('Sun-facing array'), 'Sun-facing array', 'a weekday name must stand alone');
  assert.equal(verbalizeForTts('Sun-Monitor'), 'Sun-Monitor', 'on both sides of the hyphen');
});

test('★★★ EN — a hyphen-minus is a range only when it clearly is one', () => {
  assert.equal(verbalizeForTts('4-7pm'), '4 to 7pm');
  assert.equal(verbalizeForTts('10am-3pm'), '10am to 3pm');
  assert.equal(verbalizeForTts('36-38%'), '36 to 38 percent');
  assert.equal(verbalizeForTts('5-10 min'), '5 to 10 minutes');
  assert.equal(verbalizeForTts('2-3 kWh'), '2 to 3 kilowatt hours');
  assert.equal(verbalizeForTts('1500-2000 W'), '1500 to 2000 watts');
  // Never a negative number, a date, a serial or alert id, a chain, or a bare number pair.
  assert.equal(verbalizeForTts('drift -3%'), 'drift -3 percent');
  assert.equal(verbalizeForTts('offset -0.4 V'), 'offset -0.4 volts');
  assert.equal(verbalizeForTts('since 2026-10-12'), 'since 2026-10-12');
  assert.equal(verbalizeForTts('last seen 2026-10-12 4 h ago'), 'last seen 2026-10-12 4 hours ago');
  assert.equal(verbalizeForTts('XXX0015-2 spread 12 mV'), 'XXX0015-2 spread 12 millivolts');
  assert.equal(verbalizeForTts('shp2-src-err-1'), 'shp2-src-err-1');
  assert.equal(verbalizeForTts('1-2-3 W'), '1-2-3 watts');
  assert.equal(verbalizeForTts('score 3-2'), 'score 3-2');
  assert.equal(verbalizeForTts('1.187.22-3 h'), '1.187.22-3 hours');
});

test('★★★ ES — the same ranges read "a"; a prose dash stays a pause', () => {
  const a = peakGridDraw();
  assert.equal(verbalizeForTtsEs(a.title), 'Charging the battery from the grid during On-Peak (4 a 7pm Mon a Fri)');
  // The Spanish pass reads the English title for this family (no Spanish title), through the English
  // normalizer, and the renderer normalizes the whole Spanish message again.
  const spoken = verbalizeForTtsEs(buildAlertMessageEs('yellow', [a]));
  assert.match(spoken, /On-Peak 4 to 7pm Mon to Fri\./);
  assert.doesNotMatch(spoken, /4, 7pm|Mon, Fri/, spoken);
  assert.equal(verbalizeForTtsEs('Horario punta (4–7pm lun–vie)'), 'Horario punta (4 a 7pm lun a vie)');
  assert.equal(verbalizeForTtsEs('de 20-30%'), 'de 20 a 30 por ciento');
  assert.equal(verbalizeForTtsEs('lunes-viernes'), 'lunes a viernes');
  // Prose dashes and the hyphen controls.
  assert.equal(verbalizeForTtsEs('Respaldo bajo — 20%'), 'Respaldo bajo, 20 por ciento');
  assert.equal(verbalizeForTtsEs('Núcleo 3 — 45%'), 'Núcleo 3, 45 por ciento');
  assert.equal(verbalizeForTtsEs('desde 2026-10-12'), 'desde 2026-10-12');
  assert.equal(verbalizeForTtsEs('deriva -3%'), 'deriva -3 por ciento');
});

test('★★ both normalizers stay idempotent over ranges and their controls', () => {
  const samples = [
    peakGridDraw().title, label('super_off_peak'), label('overnight'),
    '4-7pm', '10am-3pm', '36-38%', '5-10 min', '4-7 mo', '4-7s', '4-7 watts', '2-3 kWh',
    'Backup pool low — 20%', 'Core 3 – 45%', 'drift -3%', 'since 2026-10-12', 'Mon-Fri', 'lun–vie',
  ];
  for (const s of samples) {
    const en = verbalizeForTts(s);
    assert.equal(verbalizeForTts(en), en, `EN not idempotent for: ${s}`);
    const es = verbalizeForTtsEs(s);
    assert.equal(verbalizeForTtsEs(es), es, `ES not idempotent for: ${s}`);
  }
});
