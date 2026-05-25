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
  solarModel: { hourly: [], peakCoeff: 0, pairCount: 0, historyDays: 30 },
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
      upcomingNext24h: [
        {
          ts: Date.now() + 3 * 3600 * 1000,
          durationHours: 2,
          watts: 7000,
          dayOfWeek: new Date().getDay(),
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
