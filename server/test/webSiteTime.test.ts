import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  zonedParts, zonedDayStartMs, zonedTodayStartMs, zonedMinuteOfDay, fmtHHMMIn, calendarDaysBetween, fmtLocaleIn,
} from '../../web/src/siteTime.js';
import { sinceLabel } from '../../web/src/cards/todayText.js';
import { dayLabel, siteTodayYmd, todayWhFrom } from '../../web/src/components/circuitDays.js';
import { zonedDayStartMs as serverDayStartMs } from '../src/siteTime.js';
import type { CircuitHistory } from '../../web/src/types.js';

/**
 * v1.191.0 (lane A, T16 / CA25) — the web reads the site zone from the server and computes every
 * "start of today" it sends, and every clock time it shows against the server's plan, in that zone —
 * never in the browser's own (DECISION 12 and CA25: a viewer outside the site's zone sent a different
 * "today" and read the night-charge window hours off).
 */
const HOUR = 3_600_000;

test('★ the web day start equals the server\'s in every zone, DST days included', () => {
  for (const zone of ['America/Phoenix', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney', 'Asia/Kolkata', 'America/Santiago']) {
    for (const ymd of ['2026-01-15', '2026-03-29', '2026-04-05', '2026-07-01', '2026-09-06', '2026-10-04', '2026-10-25']) {
      assert.equal(zonedDayStartMs(ymd, zone), serverDayStartMs(ymd, zone), `${zone} ${ymd}`);
    }
  }
  assert.equal(zonedDayStartMs('2026-07-01', 'America/Phoenix'), Date.UTC(2026, 6, 1, 7));
  assert.ok(Number.isNaN(zonedDayStartMs('nope', 'America/Phoenix')));
});

test('★ "today" is the site\'s, whatever the browser zone: 05:00Z on 07-02 is still 07-01 in Phoenix', () => {
  const t = Date.UTC(2026, 6, 2, 5);
  assert.equal(zonedParts(t, 'America/Phoenix').ymd, '2026-07-01');
  assert.equal(zonedTodayStartMs(t, 'America/Phoenix'), Date.UTC(2026, 6, 1, 7));
  assert.equal(zonedTodayStartMs(t, 'Asia/Tokyo'), Date.UTC(2026, 6, 1, 15));
  assert.equal(zonedMinuteOfDay(t, 'America/Phoenix'), 22 * 60);
});

test('★ T16: the night-charge window is written in the payload zone, never the browser\'s; no zone → no time', () => {
  const start = Date.UTC(2026, 6, 2, 6); // 23:00 in Phoenix
  assert.equal(fmtHHMMIn(start, 'America/Phoenix'), '23:00');
  assert.equal(fmtHHMMIn(start, 'Europe/Berlin'), '08:00');
  assert.equal(fmtHHMMIn(Date.UTC(2026, 6, 6, 7), 'America/Phoenix'), '00:00', 'midnight is 00:00 (h23), not 24:00');
  assert.equal(fmtHHMMIn(start, undefined), null);
  assert.equal(fmtHHMMIn(null, 'America/Phoenix'), null);
  assert.equal(fmtHHMMIn(start, 'Not/AZone'), null);
});

test('CA25: the circuit card counts today from the server\'s site day, and labels days from the site\'s today', () => {
  const history = {
    sn: 'HD31XXX00XXX0001', ch: 3,
    days: [
      { date: '2026-06-30', dayStartMs: Date.UTC(2026, 5, 30, 7), dayEndMs: Date.UTC(2026, 6, 1, 7), isToday: false, kwh: 1, peakW: 1, peakAtMs: null, coverageMs: 1 },
      { date: '2026-07-01', dayStartMs: Date.UTC(2026, 6, 1, 7), dayEndMs: Date.UTC(2026, 6, 2, 5), isToday: true, kwh: 1, peakW: 1, peakAtMs: null, coverageMs: 1 },
    ],
    summary: { daysWithData: 2, totalKwh: 2, avgKwh: 1, peakDay: null, minDay: null },
  } as unknown as CircuitHistory;
  assert.equal(siteTodayYmd(history), '2026-07-01');
  // 1 kW for the first two hours after the site midnight (07:00Z); samples before it are yesterday's.
  const pts = [
    { ts: Date.UTC(2026, 6, 1, 5), value: 5000 },
    { ts: Date.UTC(2026, 6, 1, 7), value: 1000 },
    { ts: Date.UTC(2026, 6, 1, 7, 5), value: 1000 },
    { ts: Date.UTC(2026, 6, 1, 7, 10), value: 1000 },
  ];
  assert.equal(Math.round(todayWhFrom(pts, history)!), Math.round(1000 * (10 / 60)));
  assert.equal(todayWhFrom(pts, null), null, 'no history yet: no figure, never the browser midnight');
  assert.equal(dayLabel('2026-07-01', '2026-07-01'), 'Today');
  assert.equal(dayLabel('2026-06-30', '2026-07-01'), 'Yest');
  assert.equal(dayLabel('2026-06-27', '2026-07-01'), 'Sat');
  assert.equal(dayLabel('2026-06-20', '2026-07-01'), '6/20');
  assert.equal(dayLabel('2026-07-01', null), '7/1');
  assert.equal(calendarDaysBetween('2026-02-28', '2026-03-01'), 1);
  assert.ok(Math.abs(HOUR) > 0);
});

test('the cards that show or send site times read the server\'s zone (no literal zone, no browser midnight)', () => {
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.ok(!card.includes('America/Phoenix'), 'NightChargeCard names no zone of its own');
  assert.match(card, /const hhmm = siteHHMM\(status\.siteTimeZone\);/);
  const strategy = readFileSync(new URL('../../web/src/pages/StrategyPanel.tsx', import.meta.url), 'utf8');
  const marker = strategy.slice(strategy.indexOf('function NowMarker('), strategy.indexOf('function fmtClock('));
  assert.match(marker, /const zone = useSiteTimeZone\(\);/);
  assert.ok(!/getHours\(\)|getMinutes\(\)/.test(marker), 'the now marker does not read the browser clock');
  const modal = readFileSync(new URL('../../web/src/components/CircuitModal.tsx', import.meta.url), 'utf8');
  assert.ok(!/setHours\(0, 0, 0, 0\)/.test(modal), 'the circuit card sends and sums no browser midnight');
});

test('★★ v1.191.1: the Today card\'s "since" is the site\'s midnight in the payload zone, whatever the browser\'s', () => {
  // The site midnight the server sends as sinceMs (its own zonedDayStartMs), with the zone it stamps.
  const zones = ['America/Phoenix', 'America/New_York', 'Asia/Tokyo', 'UTC'];
  const midnight = new Date(Date.UTC(2026, 9, 22)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  for (const zone of zones) {
    assert.equal(sinceLabel(serverDayStartMs('2026-10-22', zone), zone), `since ${midnight}`, `a ${zone} site reads its own midnight`);
  }
  // Phoenix and New York midnights are three hours apart; written in one browser zone they cannot both read midnight.
  assert.notEqual(
    fmtLocaleIn(serverDayStartMs('2026-10-22', 'America/Phoenix'), 'America/New_York', { hour: '2-digit', minute: '2-digit' }),
    fmtLocaleIn(serverDayStartMs('2026-10-22', 'America/Phoenix'), 'America/Phoenix', { hour: '2-digit', minute: '2-digit' }),
    'the zone decides the clock',
  );
  assert.equal(sinceLabel(serverDayStartMs('2026-10-22', 'America/Phoenix'), undefined), null, 'no zone (an older server): no time, never the browser\'s');
  assert.equal(sinceLabel(null, 'America/Phoenix'), null);
  assert.equal(sinceLabel(Date.UTC(2026, 9, 22, 7), 'Not/AZone'), null);
  // Where the browser is in the site zone (the reference install) the text is the one the card printed.
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hostMidnight = serverDayStartMs('2026-10-22', host);
  assert.equal(sinceLabel(hostMidnight, host), `since ${new Date(hostMidnight).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
});

test('v1.191.1: /api/summary/today stamps the site zone, and the Today card writes "since" in it', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const handler = idx.slice(idx.indexOf("app.get<{ Querystring: { since?: string; until?: string } }>('/api/summary/today'"));
  assert.ok(handler.slice(0, 1600).includes('{ ...(totals as object), dayEndMs, siteTimeZone: siteTimeZone() }'), 'the payload carries its zone');
  const card = readFileSync(new URL('../../web/src/cards/TodaySummary.tsx', import.meta.url), 'utf8');
  assert.match(card, /const since = data \? sinceLabel\(data\.sinceMs, data\.siteTimeZone\) : null;/);
  assert.ok(!/toLocale(?:Time|Date)?String\(/.test(card), 'the card formats no time in the browser zone');
});

