import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  zonedParts, zonedDayStartMs, zonedTodayStartMs, zonedMinuteOfDay, fmtHHMMIn, calendarDaysBetween, fmtLocaleIn,
} from '../../web/src/siteTime.js';
import { sinceLabel } from '../../web/src/cards/todayText.js';
import { fmtHour, tsHourIn } from '../../web/src/cards/forecastText.js';
import { dayLabel, siteTodayYmd, todayWhFrom } from '../../web/src/components/circuitDays.js';
import { zonedDayStartMs as serverDayStartMs, zonedWallTimeMs as serverWallTimeMs } from '../src/siteTime.js';
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
  const zones = ['America/Phoenix', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata', 'UTC'];
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
  // … and the header shows it (the definition alone passes with the text dropped).
  assert.ok(card.includes("measured${since ? ` · ${since}` : ''}"), 'the header line prints the "since" time');
  assert.ok(!/toLocale(?:Time|Date)?String\(/.test(card), 'the card formats no time in the browser zone');
});

test('★★ v1.191.1: the Solar page labels a forecast instant with the site hour the learned table uses, whatever the browser\'s zone', () => {
  // The table's rows are site hours (the server's siteHour); each instant is labelled with the same hour.
  for (const zone of ['America/Phoenix', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata', 'UTC']) {
    for (let h = 0; h < 24; h++) {
      assert.equal(tsHourIn(serverWallTimeMs('2026-10-22', h, 0, zone), zone), fmtHour(h), `${zone} ${h}:00`);
    }
  }
  const t = Date.UTC(2026, 9, 22, 18); // 11 AM in Phoenix, 2 PM in New York, 3 AM the next day in Tokyo
  assert.deepEqual(['America/Phoenix', 'America/New_York', 'Asia/Tokyo'].map((z) => tsHourIn(t, z)), ['11 AM', '2 PM', '3 AM']);
  assert.equal(tsHourIn(t, undefined), '—', 'no zone (an older server): no hour, never the browser\'s');
  assert.equal(tsHourIn(Number.NaN, 'America/Phoenix'), '—');
  assert.deepEqual([fmtHour(0), fmtHour(12), fmtHour(23), fmtHour(24), fmtHour(-1)], ['12 AM', '12 PM', '11 PM', '12 AM', '11 PM']);
});

test('★ v1.191.1: the dashboard forecast card writes its times on the site clock, in the browser\'s own text', () => {
  const t = Date.UTC(2026, 9, 22, 18);
  const hour = { hour: 'numeric' } as const;
  const dayHour = { weekday: 'short', hour: 'numeric' } as const;
  // New York is three hours ahead of Phoenix in October: the same instant, two different clocks.
  assert.equal(fmtLocaleIn(t, 'America/New_York', hour), fmtLocaleIn(t + 3 * 3_600_000, 'America/Phoenix', hour));
  assert.notEqual(fmtLocaleIn(t, 'America/New_York', hour), fmtLocaleIn(t, 'America/Phoenix', hour), 'the zone decides the clock');
  assert.notEqual(fmtLocaleIn(t, 'Asia/Tokyo', dayHour), fmtLocaleIn(t, 'America/Phoenix', dayHour), 'and the day: Friday in Tokyo, Thursday in Phoenix');
  assert.equal(fmtLocaleIn(t, undefined, hour), null);
  assert.equal(fmtLocaleIn(t, 'Not/AZone', hour), null);
  // Where the browser is in the site zone (the reference install) the text is the one the card printed.
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(fmtLocaleIn(t, host, hour), new Date(t).toLocaleTimeString([], hour));
  assert.equal(fmtLocaleIn(t, host, dayHour), new Date(t).toLocaleString([], dayHour));
});

test('v1.191.1: /api/forecast stamps the site zone, and both forecast cards label hours in it', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const route = idx.slice(idx.indexOf("app.get('/api/forecast', async (req, reply) =>"), idx.indexOf("app.get('/api/degradation'"));
  assert.ok(route.includes('{ ...fc, siteTimeZone: siteTimeZone() }'), 'the payload carries its zone');
  const detail = readFileSync(new URL('../../web/src/cards/ForecastDetail.tsx', import.meta.url), 'utf8');
  assert.match(detail, /const zone = fc\.siteTimeZone;/);
  assert.equal((detail.match(/tsHourIn\([^,)]+, zone\)/g) ?? []).length, 4, 'the runtime note (twice), the low tile and each hour row');
  // The hour rows get the zone as a prop: the call inside HourRow is counted above whatever it is passed.
  // v1.195.0 — the rows also carry the alarm-basis SoC while the forecast is on the restored basis.
  assert.match(detail, /<HourRow key=\{h\.ts\} h=\{h\} zone=\{zone\} alarmSocPct=\{[^}]*\} \/>/, 'each hour row is handed the payload zone');
  assert.match(detail, /function HourRow\(\{ h, zone, alarmSocPct \}: \{ h: ForecastHour; zone: string \| undefined; alarmSocPct\?: number \| null \}\)/);
  assert.ok(!/getHours\(\)|toLocale(?:Time|Date)?String\(/.test(detail), 'ForecastDetail reads no browser clock');
  const card = readFileSync(new URL('../../web/src/cards/ForecastCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /const zone = fc\?\.siteTimeZone;/);
  assert.equal((card.match(/fmtLocaleIn\([^)]*, zone, /g) ?? []).length, 3, 'the low tile, the axis and the tooltip');
  // … and the low tile shows the time it computed (the definition alone passes with the sub-line dropped).
  assert.ok(card.includes("sub={lowAt ? `at ${lowAt}` : ''}"), 'the projected-low tile prints its time');
  assert.ok(!/getHours\(\)|toLocale(?:Time|Date)?String\(/.test(card), 'ForecastCard reads no browser clock');
});

