/**
 * v1.182.0 — four dashboard audit findings (2026-09-22): bench packs in the Battery page's fleet
 * figures, the Alerts badge blind to a learned CRITICAL, the Energy flow title losing its spare
 * qualifier when membership is unknown, and the night-charge card (an unclamped reserve and last
 * night's banner all day). Today's "% measured" is pinned in aggregator.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homePacks, benchNote } from '../../web/src/cards/batteryScope.js';
import { actuationBannerVisible, reserveWriteLabel, COMPLETED_BANNER_MS } from '../../web/src/cards/nightChargeText.js';
import { alertBadge } from '../../web/src/alertPriority.js';
import { energyFlowModel } from '../../web/src/cards/energyFlowModel.js';
import { tagHomePacks } from '../src/analytics.js';

type Any = any;
const H = 3_600_000;
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

/* ── Battery page: home packs ─────────────────────────────────────────────────────────── */

test('★★ tagHomePacks marks packs by panel membership; homePacks scopes to them and names what it excluded', () => {
  const devices: Any = {
    P: { sn: 'P', online: true, projection: { kind: 'shp2', sources: [{ slot: 1, sn: 'C1', isConnected: true }] } },
    C1: { sn: 'C1', online: true, projection: { kind: 'dpu' } },
    C4: { sn: 'C4', online: true, projection: { kind: 'dpu' } },
  };
  const tagged = tagHomePacks([{ sn: 'C1', packNum: 1 }, { sn: 'C4', packNum: 1 }, { sn: 'C4', packNum: 2 }], devices);
  assert.deepEqual(tagged.map((p) => p.home), [true, false, false]);
  const { home, benchCount } = homePacks(tagged);
  assert.equal(home.length, 1);
  assert.equal(benchNote(benchCount), '2 bench packs excluded');
  assert.equal(benchNote(0), null);
  assert.equal(homePacks([{}, {}]).home.length, 2, 'an older server sends no flag: every pack counts, as before');
});

test('all three pack reports are tagged, and the Battery page scopes its fleet figures and lists', () => {
  const an = src('analytics.ts');
  for (const r of ['FleetDegradation = { generatedAt: now, eolSoh: EOL_SOH, packs: tagHomePacks(', 'ChargeCurveReport = { generatedAt: now, packs: tagHomePacks(', 'FleetThermalEvents = { generatedAt: now, packs: tagHomePacks(']) {
    assert.ok(an.includes(r), r);
  }
  const deg = readFileSync(new URL('../../web/src/cards/DegradationCard.tsx', import.meta.url), 'utf8');
  assert.match(deg, /const capPairs = homeDegPacks\.filter\(/);
  assert.match(deg, /const sohValues = homeDegPacks\.map\(/);
  const adv = readFileSync(new URL('../../web/src/cards/AdvancedInsightsCard.tsx', import.meta.url), 'utf8');
  assert.match(adv, /homePacks\(thermal\.packs\)\.home/);
  assert.match(adv, /homePacks\(charge\.packs\)\.home/);
});

/* ── Alerts badge ─────────────────────────────────────────────────────────────────────── */

test('★★ the Alerts badge counts and colours a learned CRITICAL; a learned warning still does not count', () => {
  const learnedCrit: Any = { id: 'a', severity: 'critical', source: 'learned' };
  const learnedWarn: Any = { id: 'b', severity: 'warning', source: 'learned' };
  const thresholdHigh: Any = { id: 'c', severity: 'warning', source: 'threshold' };
  assert.deepEqual(alertBadge([learnedCrit]), { count: 1, tone: 'critical' });
  assert.deepEqual(alertBadge([learnedWarn]), { count: 0, tone: null });
  assert.deepEqual(alertBadge([thresholdHigh, learnedWarn]), { count: 1, tone: 'high' });
  assert.deepEqual(alertBadge([thresholdHigh, learnedCrit]), { count: 2, tone: 'critical' });
});

/* ── Energy flow: spare qualifier when membership is unknown ─────────────────────────── */

test('★ the Batteries title says spares are not yet identified while the panel\'s source list is unknown', () => {
  const core = (sn: string): Any => ({ sn, online: true, productName: 'Delta Pro Ultra', projection: { kind: 'dpu', pvTotalWatts: 0, acInWatts: 0, acOutWatts: 0, packs: [] } });
  const listedPanel: Any = { sn: 'P', online: true, productName: 'Smart Home Panel 2' }; // not yet projected
  assert.equal(energyFlowModel({ C1: core('C1'), C4: core('C4'), P: listedPanel }).membershipUnknown, true);
  assert.equal(energyFlowModel({ C1: core('C1') }).membershipUnknown, false, 'a DPU-only install: every Core IS home');
  const known: Any = { ...listedPanel, projection: { kind: 'shp2', circuits: [], sources: [{ slot: 1, sn: 'C1', isConnected: true }] } };
  const m = energyFlowModel({ C1: core('C1'), C4: core('C4'), P: known });
  assert.equal(m.membershipUnknown, false);
  assert.equal(m.spareCount, 1);
});

/* ── Night-charge card ───────────────────────────────────────────────────────────────── */

test('★★ the reserve shown is what will be WRITTEN: clamped to the panel\'s maximum', () => {
  assert.equal(reserveWriteLabel(94, 60, 50), "reserve set to 50% (the panel's maximum; 94% needed)");
  assert.equal(reserveWriteLabel(45, 40, 50), 'reserve set to 45%');
  assert.equal(reserveWriteLabel(40, 40, 50), null, 'no divergence, nothing to say');
  assert.equal(reserveWriteLabel(null, 40, 50), null);
  assert.equal(reserveWriteLabel(50.5, 45, 50), "reserve set to 50% (the panel's maximum; 51% needed)", 'the write is Math.round, clamped');
  assert.equal(reserveWriteLabel(49.6, 45, 50), 'reserve set to 50%');
  assert.match(src('index.ts'), /reserveWriteMaxPct: RESERVE_WRITE_MAX_PCT,/);
});

test('★★ the actuation banner belongs to its night: gone 6 h after the revert, not shown all day', () => {
  const now = Date.parse('2026-09-23T16:00:00-07:00');
  const base = { day: '2026-09-22', appliedAtMs: now - 17 * H, cancelled: false, windowEndMs: now - 11 * H, cancelDeadlineMs: now - 18 * H };
  assert.equal(actuationBannerVisible({ ...base, revertedAtMs: now - 11 * H }, now), false, 'reverted at 05:05, 4 PM now');
  assert.equal(actuationBannerVisible({ ...base, revertedAtMs: now - (COMPLETED_BANNER_MS - H) }, now), true, 'within 6 h of the revert');
  assert.equal(actuationBannerVisible({ ...base, revertedAtMs: null }, now), true, 'applied and not yet reverted: still live');
  assert.equal(actuationBannerVisible({ ...base, appliedAtMs: null, revertedAtMs: null }, now), false, 'armed but the window passed without a write');
  assert.equal(actuationBannerVisible({ ...base, appliedAtMs: null, revertedAtMs: null, windowEndMs: now + H }, now), true, 'armed for tonight');
  assert.equal(actuationBannerVisible({ ...base, appliedAtMs: null, revertedAtMs: null, cancelled: true, windowEndMs: now + H }, now), true, 'cancelled tonight');
  assert.equal(actuationBannerVisible(null, now), false);
  // A restore the cloud ACKed but the panel never confirmed (retrying / escalated) stays up.
  assert.equal(actuationBannerVisible({ ...base, revertedAtMs: now - 11 * H, revertVerifiedAtMs: null, revertReadbackEscalated: true }, now), true);
  assert.equal(actuationBannerVisible({ ...base, revertedAtMs: now - 11 * H, revertVerifiedAtMs: null, revertRetries: 1 }, now), true);
  // The 6 h clock runs from the CONFIRMED restore when there is one.
  assert.equal(actuationBannerVisible({ ...base, revertedAtMs: now - 11 * H, revertVerifiedAtMs: now - 2 * H }, now), true);
});

test('the Today card reads the HOME coverage and marks a silent panel "not measured"', () => {
  const today = readFileSync(new URL('../../web/src/cards/TodaySummary.tsx', import.meta.url), 'utf8');
  assert.match(today, /const coverage = data\?\.fleet\.homeCoverage \?\? data\?\.fleet\.coverage \?\? 0;/);
  assert.match(today, /value=\{panelUnmeasured \? '—' : fmtWh\(data\?\.fleet\.panelLoadWh\)\}/);
});
