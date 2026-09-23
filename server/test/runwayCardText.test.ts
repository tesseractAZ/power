/**
 * v1.177.0 — the Runway card's wording, run against the pure module it renders from
 * (web/src/cards/runwayText.ts), plus the card's wiring and the Solar tab's labels.
 *
 * Live on 2026-09-22 the card said, all at once and all wrongly:
 *   "no dip in 24 h — forecast PV keeps up with load"  over a pool projected 78 → 26 kWh;
 *   "grid is carrying the load"                          with 0 W imported (solar carrying it);
 *   "last-hour load + next-24h forecast PV"              over a weekday load curve 2.2× that;
 *   "1-hour average"                                     over whatever fallback was in use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdsLabel, troughTight, recentLoadCaption, gridNote, TROUGH_TIGHT_FRAC } from '../../web/src/cards/runwayText.js';
import { resolveGridBackstop } from '../src/gridState.js';

const FULL = 92.16, RESERVE = 14.75;
const r = (troughKwh: number | null, backupRemainingKwh = 78.03, troughAtMs: number | null = Date.UTC(2026, 8, 23, 13, 0)) =>
  ({ troughKwh, troughAtMs, backupRemainingKwh, backupReserveKwh: RESERVE, backupFullKwh: FULL });

test('★★★ a real dip is named as one — lowest point, when, and its margin over the floor', () => {
  const label = holdsLabel(r(26.0));
  assert.match(label, /^lowest ≈ 26\.0 kWh around \w{3} /);
  assert.match(label, /11\.3 kWh above the reserve floor$/);
  assert.ok(!/keeps up/.test(label), 'a 52 kWh drain is not "PV keeps up with load"');
});

test('"forecast PV keeps up" only for a pool that never falls below where it is now', () => {
  assert.match(holdsLabel(r(78.03)), /keeps up with the load/);
  assert.match(holdsLabel(r(78.0)), /keeps up/, 'a 0.03 kWh rounding dip is not a dip');
  assert.ok(!/keeps up/.test(holdsLabel(r(77.5))));
});

test('an older payload without a trough says only what the server tested', () => {
  assert.equal(holdsLabel(r(null)), 'the reserve floor is not reached within the projection horizon');
});

test('★★ a trough within 15% of full above the floor is flagged tight (rendered neutral, not green)', () => {
  assert.equal(TROUGH_TIGHT_FRAC, 0.15);
  assert.equal(troughTight(r(26.0)), true, '11.3 kWh margin < 13.8 kWh (15% of 92.16)');
  assert.equal(troughTight(r(40.0)), false);
  assert.equal(troughTight(r(null)), false);
});

test('★ the recent-load caption names its basis', () => {
  assert.equal(recentLoadCaption('hour-mean'), '1-hour average');
  assert.equal(recentLoadCaption('live'), 'live reading');
  assert.equal(recentLoadCaption('single-sample'), 'one recent reading');
  assert.equal(recentLoadCaption('carried'), 'last known — panel quiet');
});

/* ── wiring ───────────────────────────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, f), 'utf8');

test('★★★ the grid note follows the resolver: backstopping → note; flowing → "carrying the load"', () => {
  assert.match(gridNote({ present: true, backstopping: true, importLive: true })!, /^grid is carrying the load — /);
  assert.match(gridNote({ present: true, backstopping: true, importLive: false })!, /^grid available as a backstop — /,
    'backstopping with 0 W imported is a backstop, not the grid carrying the house');
  assert.equal(gridNote({ present: false, backstopping: false, importLive: false }), null, 'islanded: the projection is the live countdown');
  assert.equal(gridNote(null), null);
});

test('★★★ at the reserve floor, a grid the resolver DISTRUSTS gets no "not a live countdown" note (real resolver)', () => {
  // A declared grid (GRID_AVAILABLE) with no measured flow, pool at the floor: the resolver
  // rules it NOT backstopping — the runway alarm is critical and HA's
  // runway_projection_islanded_only is OFF. The first cut of this release keyed the note on
  // `present`, and told the operator to discount the countdown in exactly this state.
  const g = resolveGridBackstop({ devices: {}, gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: true, atReserveFloor: true } as any);
  assert.equal(g.present, true, 'the grid is reported present…');
  assert.equal(g.backstopping, false, '…and the resolver has ruled it is not backstopping');
  assert.equal(gridNote(g), null);
  // Away from the floor the same declaration is a backstop, and the note is shown.
  const ok = resolveGridBackstop({ devices: {}, gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: true, atReserveFloor: false } as any);
  assert.equal(ok.backstopping, true);
  assert.match(gridNote(ok)!, /grid available as a backstop/);
});

test('the card renders the model it runs: header, headline, captions, one-decimal capacity', () => {
  const card = src('../../web/src/cards/RunwayCard.tsx');
  assert.ok(card.includes("{runway.loadModelDegraded ? 'last-hour load' : 'typical load'} + next-{runway.horizonHours}h forecast PV"));
  assert.ok(card.includes('reserve holds {runway.horizonHours} h') && !card.includes('no dip in'));
  assert.ok(card.includes(': holdsLabel(runway);'));
  assert.ok(card.includes("? (troughTight(runway) ? 'text-ink' : 'text-ok')"), 'tight is neutral — never more alarming than a real crossing');
  assert.ok(card.includes('const note = gridNote(runway.grid);') && card.includes('{note && '), 'the grid note comes from gridNote');
  assert.ok(card.includes('sub={recentLoadCaption(runway.recentLoadBasis)}'));
  assert.ok(card.includes('`of ${runway.backupFullKwh.toFixed(1)} full`'));
  assert.ok(card.includes('kWh load, no predicted EV`'), 'the runway load says it excludes the PREDICTED-EV layer (the curve itself averages past EV charging)');
});

test('the Solar tab says its forecast load includes predicted EV charging', () => {
  const fd = src('../../web/src/cards/ForecastDetail.tsx');
  assert.ok(fd.includes("sub={evWh > 0 ? `incl. ${kwh(evWh)} predicted EV` : 'no EV charging predicted'}"));
  assert.ok(fd.includes("${evBeforeLowWh > 0 ? ' · incl. predicted EV' : ''}"), 'the low-SoC note counts only EV load at or before the low');
});

test('★★ the display PV sum carries the same bias correction and ceiling as the alarm series', () => {
  const an = src('../src/analytics.ts');
  assert.ok(an.includes('restoredPvSum += restoredCeil != null ? Math.min(pv * pvBiasFactor, restoredCeil) : pv * pvBiasFactor;'),
    'without it the dashboard (52.9 kWh) and Home Assistant (51.4 kWh) disagree by exactly pvBiasFactor');
});
