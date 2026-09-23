/**
 * v1.183.0 — the last three findings of the 2026-09-22 dashboard audit: the Forecast Outlook
 * read green "Comfortable" with no projection at all; the Strategy tab struck an energized circuit
 * through as "turned off"; and three unit/format faults (the DPU countdown labelled "remain"
 * whether charging or discharging, an unlabelled forecast axis whose ticks rounded unevenly, and
 * trend-chart units wrapping onto a stray line).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outlookOf, remainSuffix, strategyExclusion, packCountdownLabel } from '../../web/src/cards/cardText.js';
import { compactTick, kwTick, trimDecimals } from '../../web/src/charts/axisFormat.js';

const web = (f: string) => readFileSync(new URL(`../../web/src/${f}`, import.meta.url), 'utf8');

test('★★ Outlook: no projection is "—" in a neutral tone, never a green "Comfortable"', () => {
  assert.deepEqual(outlookOf(null, 16), { label: '—', tone: 'muted' });
  assert.deepEqual(outlookOf(10, 16), { label: 'Tight', tone: 'bad' });
  assert.deepEqual(outlookOf(25, 16), { label: 'Watch', tone: 'warn' });
  assert.deepEqual(outlookOf(60, 16), { label: 'Comfortable', tone: 'ok' });
  const card = web('cards/ForecastCard.tsx');
  assert.match(card, /value=\{outlookOf\(fc!\.minProjectedSoc, fc!\.reserveSoc\)\.label\}/);
  assert.doesNotMatch(card, /: 'Comfortable'/, 'the inline fall-through is gone');
});

test('★★ Strategy: loadIsEnable=false is "not in the load strategy", never "turned off" — and says when it is drawing', () => {
  assert.equal(strategyExclusion(true, 500), null);
  assert.equal(strategyExclusion(null, 500), null);
  assert.deepEqual(strategyExclusion(false, 812.4), { badge: 'not in strategy', note: "not in the SHP2's load strategy — still powered, drawing 812 W" });
  assert.equal(strategyExclusion(false, 0)!.note, "not in the SHP2's load strategy");
  const panel = web('pages/StrategyPanel.tsx');
  assert.doesNotMatch(panel, /line-through/);
  assert.doesNotMatch(panel, /turned off in the SHP2/);
  // Not a shed candidate: not ranked among the participants, and no tier.
  assert.match(panel, /\.filter\(\(c\) => c\.loadPriority != null && c\.loadIsEnable !== false\)/);
  assert.match(panel, /\{exclusion \? '—' : tier\}/);
});

test('★ DPU countdown: "to full" while charging, "to empty" while discharging (batAmp sign)', () => {
  assert.equal(remainSuffix(12), 'to full');
  assert.equal(remainSuffix(-8), 'to empty');
  assert.equal(remainSuffix(0.2), 'remaining');
  assert.equal(remainSuffix(null), 'remaining');
  assert.match(web('cards/DpuCard.tsx'), /\$\{remainSuffix\(p\?\.batAmp\)\}/);
  // The same countdown elsewhere: the Thermal page's pack readout and the telnet tag.
  assert.equal(packCountdownLabel(900, 0), 'To full');
  assert.equal(packCountdownLabel(0, 700), 'To empty');
  assert.equal(packCountdownLabel(null, null), 'Remaining');
  assert.match(web('pages/ThermalPanel.tsx'), /label=\{packCountdownLabel\(pk\.inputWatts, pk\.outputWatts\)\}/);
  assert.match(readFileSync(new URL('../src/telnet/plant/gen.ts', import.meta.url), 'utf8'), /\$\{\(p\.batAmp \?\? 0\) > 0\.5 \? 'TTF' : 'RUN'\}\.MIN/);
});

test('★ axis ticks: compact, distinct, unit on the axis label not every tick', () => {
  assert.equal(trimDecimals(2), '2');
  assert.equal(kwTick(1500), '1.5');
  assert.equal(kwTick(2000), '2');
  assert.notEqual(kwTick(1500), kwTick(2000), 'neighbouring ticks no longer round to the same label');
  assert.equal(compactTick(950), '950');
  assert.equal(compactTick(1950), '1.95k', 'recharts steps in 50 W multiples: two decimals render them exactly');
  assert.equal(compactTick(12_500), '12.5k');
  assert.equal(kwTick(650), '0.65');
  assert.equal(kwTick(1950), '1.95');
  assert.equal(compactTick(-2000), '-2k');
  const trend = web('charts/TrendChart.tsx');
  assert.doesNotMatch(trend, /unit=\{unit \? ` \$\{unit\}` : ''\}/, 'no per-tick unit (it wrapped onto a stray line)');
  assert.match(trend, /tickFormatter=\{compactTick\} label=\{unit \?/);
  assert.match(web('cards/ForecastCard.tsx'), /tickFormatter=\{kwTick\} label=\{\{ value: 'kW'/);
});
