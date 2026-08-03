import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarIcs } from '../src/calendar.js';
import type { DayForecast } from '../src/analytics.js';

/** Undo RFC5545 line folding (CRLF + space) for substring assertions. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

const baseForecast: DayForecast = {
  generatedAt: Date.now(),
  hasWeather: true,
  historyDays: 30,
  reserveSoc: 15,
  hours: [],
  forecastPvWhNext24: 50_000,
  typicalPvWhPerDay: 50_000,
  minProjectedSoc: null,
  minProjectedSocTs: null,
  // v0.75.0/v0.78.0 additions. No SHP2 in this fixture, so the honest coverage
  // basis is 0 connected / 0 reporting and never "partial"; the *Display fields
  // and restoredSolarModel mirror the reporting-basis values, which is what
  // production emits when every connected Core reports (and what the `??`
  // fallbacks resolved to while these fields were absent).
  homeDpusConnected: 0,
  homeDpusReporting: 0,
  homeDpusCoveragePartial: false,
  forecastPvWhNext24Display: 50_000,
  typicalPvWhPerDayDisplay: 50_000,
  solarModel: { hourly: [], peakCoeff: 0, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 30 },
  restoredSolarModel: { hourly: [], peakCoeff: 0, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 30 },
  deviceModels: [],
  soiling: null,
};

test('buildCalendarIcs — empty input still produces valid VCALENDAR envelope', () => {
  const ics = buildCalendarIcs({ devices: {}, forecast: baseForecast, evWindow: null, nwsAlerts: [] });
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /END:VCALENDAR/);
  assert.match(ics, /\r\n/); // CRLF per RFC5545
});

test('buildCalendarIcs — emits VEVENT when forecast projects SoC dip below reserve', () => {
  const dipTs = Date.now() + 6 * 3600 * 1000;
  const ics = buildCalendarIcs({
    devices: {},
    forecast: { ...baseForecast, minProjectedSoc: 8, minProjectedSocTs: dipTs },
    evWindow: null,
    nwsAlerts: [],
  });
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /Battery dip/);
  assert.match(ics, /SUMMARY:/);
  assert.match(ics, /DTSTART:/);
  assert.match(ics, /CATEGORIES:Battery/);
});

test('buildCalendarIcs — escapes commas and semicolons per RFC5545', () => {
  // NWS alerts often have commas in areaDesc and headlines.
  const ics = buildCalendarIcs({
    devices: {},
    forecast: baseForecast,
    evWindow: null,
    nwsAlerts: [
      {
        id: 'urn:oid:test',
        event: 'Severe Thunderstorm Warning',
        severity: 'Severe',
        certainty: 'Likely',
        urgency: 'Expected',
        onset: new Date(Date.now() + 3600 * 1000).toISOString(),
        // NwsAlert declares all four CAP clocks; `effective`/`ends` are legitimately
        // nullable (NWS omits them on plenty of products) and null is exactly what
        // this fixture's absent fields already resolved to at runtime, so
        // calendar.ts still pairs onset→expires as before.
        effective: null,
        ends: null,
        expires: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        headline: 'A severe thunderstorm warning, gusts to 65 mph',
        description: null,
        instruction: null,
        areaDesc: 'Maricopa, AZ; Pinal, AZ',
      },
    ],
  });
  // Assert on the UNFOLDED form — RFC5545 line-folding can split a string
  // across `\r\n ` mid-pattern; unfold first so the regex sees logical content.
  // Escaped commas: \,  Escaped semicolons: \;
  assert.match(unfold(ics), /Maricopa\\, AZ\\; Pinal/);
});

test('buildCalendarIcs — predicted EV charging session becomes a calendar event', () => {
  const ics = buildCalendarIcs({
    devices: {},
    forecast: baseForecast,
    evWindow: {
      generatedAt: Date.now(),
      sessionsObserved: 8,
      patterns: [],
      // v1.15.0 session-distribution stats. Coherent with 8 observed sessions over
      // the 30-day window: ~14 kWh median at ~7 kW, a slightly fatter p90, ~1.9
      // sessions/week. buildCalendarIcs reads only upcomingNext24h.
      typicalSessionKwh: 14,
      p90SessionKwh: 18,
      typicalSessionWatts: 7000,
      sessionsPerWeek: 1.9,
      upcomingNext24h: [
        {
          ts: Date.now() + 3 * 3600 * 1000,
          durationHours: 2,
          watts: 7000,
          dayOfWeek: new Date().getDay(),
          // v1.x — mined predictions carry a confidence; 8 observed sessions on a
          // stable weekday pattern is a high-confidence one. calendar.ts does not
          // read it, so this only makes the fixture honest.
          probability: 0.9,
        },
      ],
    },
    nwsAlerts: [],
  });
  assert.match(ics, /Predicted EV charging/);
  assert.match(ics, /CATEGORIES:EV/);
});

test('buildCalendarIcs — long lines fold per RFC5545 75-char limit', () => {
  // Make sure folded lines start with " " continuation
  const ics = buildCalendarIcs({
    devices: {},
    forecast: {
      ...baseForecast,
      minProjectedSoc: 5,
      minProjectedSocTs: Date.now() + 3600 * 1000,
    },
    evWindow: null,
    nwsAlerts: [],
  });
  const lines = ics.split('\r\n');
  for (const line of lines) {
    assert.ok(line.length <= 75 || line.startsWith(' '), `line over 75 chars and not folded: ${line.slice(0, 40)}…`);
  }
});
