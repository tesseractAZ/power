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
import { holdsLabel, troughTight, recentLoadCaption, TROUGH_TIGHT_FRAC } from '../../web/src/cards/runwayText.js';

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

test('★★ a trough within 15% of full above the floor is amber, not green', () => {
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

test('★★★ "grid is carrying the load" only when grid power is flowing (importLive), not on presence', () => {
  const card = src('../../web/src/cards/RunwayCard.tsx');
  assert.ok(card.includes("const gridFlowing = runway.grid?.importLive === true;"));
  assert.ok(card.includes("{gridFlowing ? 'grid is carrying the load' : 'grid available as a backstop'}"));
  assert.ok(!card.includes('gridBackstopping &&'), 'backstopping (presence) no longer drives the claim');
});

test('the card renders the model it runs: header, headline, captions, one-decimal capacity', () => {
  const card = src('../../web/src/cards/RunwayCard.tsx');
  assert.ok(card.includes("{runway.loadModelDegraded ? 'last-hour load' : 'typical load'} + next-{runway.horizonHours}h forecast PV"));
  assert.ok(card.includes('reserve holds {runway.horizonHours} h') && !card.includes('no dip in'));
  assert.ok(card.includes(': holdsLabel(runway);'));
  assert.ok(card.includes("? (troughTight(runway) ? 'text-warn' : 'text-ok')"));
  assert.ok(card.includes('sub={recentLoadCaption(runway.recentLoadBasis)}'));
  assert.ok(card.includes('`of ${runway.backupFullKwh.toFixed(1)} full`'));
  assert.ok(card.includes('kWh load, no EV`'), 'the runway load says it excludes predicted EV');
});

test('the Solar tab says its forecast load includes predicted EV charging', () => {
  const fd = src('../../web/src/cards/ForecastDetail.tsx');
  assert.ok(fd.includes("sub={evWh > 0 ? `incl. ${kwh(evWh)} predicted EV` : 'no EV charging predicted'}"));
});

test('★★ the display PV sum carries the same bias correction and ceiling as the alarm series', () => {
  const an = src('../src/analytics.ts');
  assert.ok(an.includes('restoredPvSum += restoredCeil != null ? Math.min(pv * pvBiasFactor, restoredCeil) : pv * pvBiasFactor;'),
    'without it the dashboard (52.9 kWh) and Home Assistant (51.4 kWh) disagree by exactly pvBiasFactor');
});
