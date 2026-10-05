/**
 * v1.187.10 (log review) — the rate-floor card and log line say what is true.
 *
 * (1) The 60 s tick republished the LIVE rate on every tick while a collapse was surfaced, the
 *     5-minute recovery dwell included, into text that always read "has collapsed to X msg/min, far
 *     below its learned ~B". The closing body frozen into the cleared ledger then read "collapsed to
 *     27.0 msg/min, far below its learned ~25" (Core 3, 2026-10-02 11:09) — every one of the 78
 *     closing bodies in the ledger at or above the floor. The onset is now frozen
 *     (surfacedCollapseEntry) and a card whose live rate is back above the floor says "recovering".
 * (2) The collapse WARN fired for Core 3, an off-panel Core whose card the roster mutes (on screen
 *     only, never pushed or spoken), telling the operator to check the cloud session and power. A
 *     roster-muted device's line is INFO and names the mute (rateFloorCollapseLine).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rateFloorAlerts, surfacedCollapseEntry, rateFloorCollapseLine, type RateFloorOnsets,
} from '../src/messageRateFloorAlert.js';
import { MUTE_REASON_OFF_PANEL } from '../src/alerts.js';

const SN = 'COREXXX00XXX0003';

test('★★★ the onset is frozen at the first surfacing; later ticks carry the live rate beside it', () => {
  const onsets: RateFloorOnsets = new Map();
  const t1 = surfacedCollapseEntry(onsets, SN, 'Core 3', 4, 20, true);
  assert.deepEqual(t1.onset, { rate: 4, baseline: 20 });
  assert.equal(t1.recovering, false, 'starved now: collapsed, not recovering');
  const t2 = surfacedCollapseEntry(onsets, SN, 'Core 3', 27, 25, false);
  assert.deepEqual(t2.onset, { rate: 4, baseline: 20 }, 'the onset does not follow the live rate');
  assert.equal(t2.rate, 27);
  assert.equal(t2.baseline, 25);
  assert.equal(t2.recovering, true, 'the live rate is back above the floor');
  onsets.delete(SN); // the episode ends (the tick drops it)
  assert.deepEqual(surfacedCollapseEntry(onsets, SN, 'Core 3', 3, 22, true).onset, { rate: 3, baseline: 22 }, 'a new episode, a new onset');
});

test('★★★ a recovering card never claims "collapsed to <a rate above the floor>, far below <its baseline>"', () => {
  const [a] = rateFloorAlerts([{ sn: SN, deviceName: 'Core 3', rate: 27, baseline: 25, onset: { rate: 4, baseline: 20 }, recovering: true }]);
  assert.doesNotMatch(a.detail, /far below/);
  assert.doesNotMatch(a.detail, /has collapsed to 27/);
  assert.match(a.detail, /fell to 4\.0 msg\/min against its learned ~20 msg\/min baseline/);
  assert.match(a.detail, /It is now 27\.0 msg\/min, back above the collapse floor \(~5\.0 msg\/min\) — recovering/);
  assert.match(a.detail, /stayed at or above ~10\.0 msg\/min for 5 min\./, 'the recovery bar: max(floor, 10 msg/min), for the 5-min dwell');
  assert.deepEqual(a.facts?.map((f) => f.label), ['Live rate', 'Baseline rate', 'Rate at onset']);
  assert.equal(a.facts?.[2].value, '4.0 msg/min (baseline ~20)');
  // Same id, severity and priority as the collapsed card: one episode.
  assert.equal(a.id, `msg-rate-floor-${SN}`);
  assert.equal(a.severity, 'warning');
  assert.equal(a.priority, 'medium');
});

test('★★ a card still under the floor keeps the collapse wording (with the live rate)', () => {
  const [a] = rateFloorAlerts([{ sn: SN, deviceName: 'Core 3', rate: 2, baseline: 25, onset: { rate: 4, baseline: 20 }, recovering: false }]);
  assert.match(a.detail, /has collapsed to 2\.0 msg\/min, far below its learned ~25 msg\/min baseline/);
  assert.doesNotMatch(a.detail, /recovering/);
});

test('★★★ the collapse line: WARN for a monitored device, INFO naming the mute for a roster-muted one', () => {
  const c = { name: 'Core 3', sn: SN, rate: 4, baseline: 20, usedHourBucket: true, eligibilityPeak: 31 };
  const loud = rateFloorCollapseLine(c, null);
  assert.equal(loud.level, 'warn');
  assert.equal(loud.text, `msg-rate-floor: Core 3 message rate collapsed to 4.00 msg/min (baseline ~20 for this hour) — device is barely reporting while still appearing "fresh"; check the EcoFlow cloud session / power for ${SN} [eligibility mark ~31]`);
  const muted = rateFloorCollapseLine(c, MUTE_REASON_OFF_PANEL);
  assert.equal(muted.level, 'info');
  assert.equal(muted.text, `${loud.text} — on screen only, not pushed or spoken (off-panel Core — not on the panel roster)`);
  assert.match(rateFloorCollapseLine({ ...c, rate: null, usedHourBucket: false }, null).text, /collapsed to \? msg\/min \(baseline ~20, global\)/);
});

test('★ (labelled source pin, last resort: index.ts cannot be imported by a test) the rate-floor tick wires the onset map and the roster mute', () => {
  const idx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  assert.ok(idx.includes('collapses.push(surfacedCollapseEntry(collapseOnsets, sn, name, r.rate, r.baseline, starvedNow));'));
  assert.ok(idx.includes('if (!online) { surfacedCollapses.delete(sn); collapseOnsets.delete(sn); continue; }'));
  assert.ok(idx.includes('        surfacedCollapses.delete(sn);\n        collapseOnsets.delete(sn);\n'));
  assert.ok(idx.includes('usedHourBucket: r.usedHourBucket, eligibilityPeak: r.eligibilityPeak }, rosterMuteReasonForSn(sn));'));
  assert.ok(idx.includes("if (line.level === 'warn') app.log.warn(line.text); else app.log.info(line.text);"));
});
