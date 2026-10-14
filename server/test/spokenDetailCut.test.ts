/**
 * v1.187.22 — a spoken alert detail is cut at a sentence end, never at a decimal point.
 *
 * shortenDetail keeps the spoken detail to ~200 chars. It cut at the last '.' of the first 200,
 * and a decimal point is a '.', so the speakers stated a figure that was neither the observed value
 * nor a labelled basis: every spoken peak-grid-draw said "about $2." for $2.19 (the second
 * sentence's only '.' inside 200 chars is the cost's decimal), and a host-pressure alarm said
 * "load1 6." for a load of 6.37. buildAlertMessage and buildAlertMessageEs (whose detail tail is the
 * English original) both speak it, and it is the only detail the condition broadcast speaks.
 *
 * The same release states the peak-grid-draw cost as what it is: the on-peak spend rate. It was
 * worded "per hour more than buying the same energy overnight", but nothing subtracts the overnight
 * rate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertMessage, buildAlertMessageEs, shortenDetail, SPOKEN_DETAIL_MAX_CHARS } from '../src/ttsService.js';
import type { Alert } from '../src/alerts.js';
import { assessPeakDraw, peakGridDrawAlerts, resetPeakDrawOnset, DEFAULT_PEAK_DRAW_CONFIG, type PeakDrawInputs } from '../src/peakGridDraw.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';
import { assessVitals } from '../src/selfVitals.js';

const MIN = 60_000;
// 2026-08-04 17:22 MST, on-peak (the peakGridDraw.test.ts incident fixture).
const PEAK_TS = Date.UTC(2026, 7, 5, 0, 22);
const OVERNIGHT_TS = Date.UTC(2026, 7, 5, 6, 30); // 23:30 MST
const TARIFF = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 34.0, winter: 24.0 },
  overnight: { summer: 8.0, winter: 7.0 },
});

function peakInputs(o: Partial<PeakDrawInputs> = {}): PeakDrawInputs {
  return {
    nowMs: PEAK_TS,
    gridImportW: 11614, panelLoadW: 6505, pvW: 1345,
    socPct: 41, reserveSocPct: 10,
    gridPresent: true,
    coreDraws: [{ label: 'Core 1', acInWatts: 7200 }, { label: 'Core 3', acInWatts: 4414 }],
    onsetMs: PEAK_TS - 15 * MIN,
    ...o,
  };
}

function peakAlert(o: Partial<PeakDrawInputs> = {}): Alert {
  resetPeakDrawOnset();
  const v = assessPeakDraw(peakInputs(o), TARIFF, { ...DEFAULT_PEAK_DRAW_CONFIG, dwellMs: 10 * MIN });
  const [a] = peakGridDrawAlerts(v, PEAK_TS);
  assert.ok(a, 'the fixture raises peak-grid-draw');
  return a;
}

function alertWith(detail: string, severity: Alert['severity'] = 'warning'): Alert {
  return { id: 'probe-detail', severity, category: 'Connectivity', device: 'System', title: 'Probe', detail } as Alert;
}

/** Every decimal figure in `spoken` appears whole in `detail` (none is a prefix of a longer one). */
function figuresWhole(spoken: string, detail: string): void {
  for (const m of spoken.matchAll(/\d+(?:\.\d+)?(?![\d.]*\d)/g)) {
    const at = m.index ?? 0;
    const after = spoken.slice(at + m[0].length);
    // A figure followed by '.' and the end of the text is the sentence's own full stop only if the
    // detail has the same figure followed by a non-digit.
    const inDetail = new RegExp(`(?<![\\d.])${m[0].replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(detail);
    assert.ok(inDetail, `spoken figure "${m[0]}" (before "${after.slice(0, 12)}") is not a whole figure of the detail`);
  }
}

test('a detail within the limit is spoken whole', () => {
  const d = 'x'.repeat(SPOKEN_DETAIL_MAX_CHARS - 10) + ' 6.37.';
  assert.equal(shortenDetail(d), d);
});

test('★★★ a decimal point between char 100 and 200 is not a sentence end: the cut falls between words', () => {
  // One sentence of 260 chars whose only '.' inside 200 is the decimal of 6.37 (at char ~150).
  const d = `${'word '.repeat(29)}load1 6.37 crit at or above 6, host CPU is oversubscribed and alert delivery may be delayed while the pressure persists on this host for a while longer`;
  assert.ok(d.indexOf('6.37') > 100 && d.indexOf('6.37') < 200 && d.length > 200, 'fixture: the decimal sits in the cut window');
  const s = shortenDetail(d);
  assert.ok(!/\b6\.$/.test(s) && !/\b6\.(?!37)/.test(s), `never "6." (${s.slice(-40)})`);
  assert.match(s, /load1 6\.37 crit/, 'the figure is spoken whole');
  assert.ok(s.endsWith('...'), 'a cut between words is marked with an ellipsis');
  assert.ok(s.length <= SPOKEN_DETAIL_MAX_CHARS + 3, `at most the limit plus the ellipsis (${s.length})`);
  assert.ok(d.startsWith(s.slice(0, -3)), 'the spoken text is a prefix of the detail');
  assert.ok(/\S$/.test(s.slice(0, -3)) && !/[,;:]$/.test(s.slice(0, -3)), 'no dangling space or comma before the ellipsis');
});

test('★★★ the limit falls inside a figure: the figure is dropped whole, never split', () => {
  // No sentence end at all; "12.05" spans chars 197–201, so a cut at char 200 would speak "12.0".
  const lead = `${'word '.repeat(39)}load`;                 // 199 chars… then " 12.05" puts the figure across 200
  const d = `${lead.slice(0, 196)} 12.05 is the reading and more words follow after it`;
  const at = d.indexOf('12.05');
  assert.ok(at < SPOKEN_DETAIL_MAX_CHARS && at + 5 > SPOKEN_DETAIL_MAX_CHARS, `fixture: the figure straddles the limit (${at})`);
  const s = shortenDetail(d);
  const body = s.slice(0, -3);
  assert.ok(s.endsWith('...'));
  assert.ok(!/\d/.test(body.slice(-6)), `no partial figure before the ellipsis: "${body.slice(-12)}"`);
  assert.match(d.slice(body.length), /^\s/, 'the cut is between words');
});

test('★★ the cut is at the LAST sentence end past char 100 — a "." followed by a space', () => {
  const first = `${'a'.repeat(60)} ends here.`;            // a sentence end at ~71: too early
  const second = ` ${'b'.repeat(70)} ends at 6.37 kW.`;     // a sentence end at ~160
  const d = first + second + ` ${'c'.repeat(80)} trailing words after the limit.`;
  const s = shortenDetail(d);
  assert.equal(s, first + second, 'the second sentence, ending in its full stop, is the cut');
});

test('★★ a sentence end at or before char 100 is too early: the cut falls between words near the limit', () => {
  const d = `${'a'.repeat(40)} short first sentence. ${'word '.repeat(60)}`;
  const s = shortenDetail(d);
  assert.ok(s.length > 150, `the cut is near the limit, not at char ~60 (${s.length})`);
  assert.ok(s.endsWith('...'));
});

test('★★ a sentence end that only ends past the limit is not taken (the spoken detail stays within it)', () => {
  // The last '.'-then-space ends at char 205: the earlier one (char ~150) is the cut.
  const d = `${'a'.repeat(140)} first ends here. ${'b'.repeat(40)} second ends.  ${'c'.repeat(50)}`;
  assert.ok(d.indexOf('second ends.') + 'second ends.'.length > SPOKEN_DETAIL_MAX_CHARS);
  const s = shortenDetail(d);
  assert.ok(s.endsWith('first ends here.'), s.slice(-30));
});

test('★★★ peak-grid-draw: the speakers say the cost the detail states, "$2.19", never "$2."', () => {
  const a = peakAlert();
  assert.match(a.detail, /about \$2\.19 per hour\./);
  for (const msg of [buildAlertMessage('yellow', [a]), buildAlertMessageEs('yellow', [a])]) {
    assert.ok(!/\$2\.(?!19)/.test(msg), `no truncated dollar figure: ${msg}`);
    assert.match(msg, /\$2\.19 per hour\./, 'the cost sentence is spoken whole');
    figuresWhole(msg, a.detail);
  }
  // Larger and smaller spends too ("$12." / "$0." before).
  for (const gridImportW of [5160 + 35850, 5160 + 1320]) {
    const b = peakAlert({ gridImportW });
    const cost = /about (\$\d+\.\d{2}) per hour\./.exec(b.detail)?.[1];
    assert.ok(cost, b.detail);
    const msg = buildAlertMessage('yellow', [b]);
    assert.ok(msg.includes(`${cost} per hour.`), `spoken whole: ${cost} in ${msg}`);
  }
});

test('★★★ peak-grid-draw states the on-peak spend rate, not a premium over overnight', () => {
  const a = peakAlert();
  const on = rateAt(TARIFF, PEAK_TS).centsPerKwh!;
  const off = rateAt(TARIFF, OVERNIGHT_TS).centsPerKwh!;
  assert.ok(on > off, 'fixture: the overnight rate is cheaper');
  // 6.454 kW × 34 c = $2.19/h is the on-peak spend; the premium over 8 c overnight would be $1.68/h.
  assert.match(a.detail, /\$2\.19 per hour\./);
  assert.ok(!/more than buying/i.test(a.detail), 'the spend is not called a premium over overnight');
  assert.ok(!/\$2\.19 per hour more/.test(a.detail));
  assert.ok(a.facts?.some((f) => f.label === 'Cost rate' && f.value === '$2.19/h'), 'the fact is the same spend rate');
});

test('★★★ host-pressure: the spoken load reading is the measured one, "6.37", never "6."', () => {
  const v = assessVitals({
    evLoopLagMs: 1500, evLoopLagMaxMs: 2200, load1: 6.37, load5: 5.1,
    memAvailableMb: null, dataDiskFreeMb: null, ts: 0,
  }, null);
  assert.equal(v.level, 'crit');
  // The detail template computeAlerts builds for host-pressure-crit (alerts.ts).
  const detail = `The host running this monitor shows resource pressure — ${v.reasons.join('; ')}. Another add-on is likely consuming the host; check the Home Assistant add-on pages for the top CPU/memory consumer. Alert delivery may be delayed while pressure persists (discretionary analytics are paused to protect the alarm path).`;
  assert.ok(detail.indexOf('6.37') > 100 && detail.indexOf('6.37') < 200, 'fixture: the reading sits in the cut window');
  const a = alertWith(detail, 'critical');
  for (const msg of [buildAlertMessage('red', [a]), buildAlertMessageEs('red', [a])]) {
    assert.ok(!/load1 6\.(?!37)/.test(msg), `no truncated load reading: ${msg}`);
    assert.match(msg, /load1 6\.37/);
    figuresWhole(msg, detail);
  }
});
