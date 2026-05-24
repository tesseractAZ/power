import type { DayForecast } from './analytics.js';
import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection } from './ecoflow/project.js';
import type { EvWindowPrediction } from './analytics.js';
import type { NwsAlert } from './nws.js';

/**
 * RFC5545 iCalendar (.ics) feed for HA's `generic_ics_calendar`,
 * `local_calendar`, or any iOS/Google calendar subscription.
 *
 * Surfaces panel events as a feed users can pull into their normal
 * calendar app: SHP2 TOU charge windows, predicted EV charging
 * sessions, forecast SoC dips below reserve, active NWS storm
 * windows. Read-only — purely informational.
 *
 * Cached briefly to avoid recomputing on every HA-poll. The events
 * themselves are short-horizon (next 72 h), so the cache TTL is
 * intentionally shorter than the data-source TTLs.
 */

const CAL_TTL_MS = 5 * 60 * 1000;
let calendarCache: { ts: number; ics: string } | null = null;

/** RFC5545 line-folding (DTSTART, DTEND, DESCRIPTION lines must wrap at 75 chars). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    parts.push(line.slice(i, i + 73));
    i += 73;
  }
  return parts.join('\r\n ');
}

/** Escape per RFC5545 §3.3.11. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function ical(dt: number): string {
  const d = new Date(dt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

interface CalEvent {
  uid: string;
  start: number;
  end: number;
  summary: string;
  description: string;
  category: string;
}

function emit(ev: CalEvent[]): string {
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EcoFlow Panel//v0.8.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:EcoFlow Panel',
    'X-WR-CALDESC:Forecasted EcoFlow events',
  ];
  const tail = ['END:VCALENDAR'];
  const lines: string[] = [...head];
  const now = ical(Date.now());
  for (const e of ev) {
    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${e.uid}@ecoflow-panel`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${ical(e.start)}`);
    lines.push(`DTEND:${ical(e.end)}`);
    lines.push(fold(`SUMMARY:${esc(e.summary)}`));
    lines.push(fold(`DESCRIPTION:${esc(e.description)}`));
    lines.push(`CATEGORIES:${esc(e.category)}`);
    lines.push('END:VEVENT');
  }
  return [...lines, ...tail].join('\r\n') + '\r\n';
}

export interface CalendarSources {
  devices: Record<string, DeviceSnapshot>;
  forecast: DayForecast | null;
  evWindow: EvWindowPrediction | null;
  nwsAlerts: NwsAlert[];
}

export function buildCalendarIcs(src: CalendarSources): string {
  if (calendarCache && Date.now() - calendarCache.ts < CAL_TTL_MS) return calendarCache.ics;
  const events: CalEvent[] = [];

  // SoC dip below reserve — single event at the projected dip time.
  if (src.forecast?.minProjectedSoc != null && src.forecast.minProjectedSocTs != null &&
      src.forecast.minProjectedSoc < src.forecast.reserveSoc) {
    const start = src.forecast.minProjectedSocTs;
    const end = start + 3600 * 1000;
    events.push({
      uid: `soc-dip-${start}`,
      start, end,
      summary: `⚠️ Battery dip ~${src.forecast.minProjectedSoc}% (reserve ${src.forecast.reserveSoc}%)`,
      description: `Day-ahead forecast projects the backup pool dipping below the reserve floor. Consider pre-charging or deferring high-draw loads.`,
      category: 'Battery',
    });
  }

  // SHP2 TOU charge windows.
  const shp2 = Object.values(src.devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  if (shp2 && shp2.projection.strategy?.timeTask?.windows) {
    const tt = shp2.projection.strategy.timeTask;
    for (const w of tt.windows) {
      // Project the recurring window onto the next 3 days for visibility.
      for (let day = 0; day < 3; day++) {
        const base = new Date();
        base.setHours(0, 0, 0, 0);
        base.setDate(base.getDate() + day);
        const start = base.getTime() + w.startMinute * 60_000;
        const end = base.getTime() + w.endMinute * 60_000;
        if (end <= Date.now()) continue;
        events.push({
          uid: `tou-${day}-${w.startMinute}`,
          start, end,
          summary: `🔋 SHP2 scheduled charge window`,
          description: `Configured TOU window: charge to ${tt.chargeCeilingSoc ?? '—'}% at up to ${tt.chargeWatts ?? '—'} W. Mode: ${tt.timeMode ?? '—'}.`,
          category: 'Schedule',
        });
      }
    }
  }

  // Predicted EV charging sessions.
  if (src.evWindow) {
    for (const u of src.evWindow.upcomingNext24h) {
      const end = u.ts + u.durationHours * 3_600_000;
      events.push({
        uid: `ev-${u.ts}`,
        start: u.ts, end,
        summary: `🚗 Predicted EV charging (~${u.watts} W)`,
        description: `Pattern detected from circuit history: typical ${u.durationHours} h session at ${u.watts} W on this day-of-week and hour. Energy: ~${Math.round((u.watts * u.durationHours) / 1000)} kWh.`,
        category: 'EV',
      });
    }
  }

  // Active NWS storm windows.
  for (const a of src.nwsAlerts) {
    if (!a.onset || !a.expires) continue;
    const start = Date.parse(a.onset);
    const end = Date.parse(a.expires);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Date.now()) continue;
    events.push({
      uid: `nws-${a.id || a.event}`.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 96),
      start, end,
      summary: `🌩️ ${a.event}`,
      description: `${a.headline ?? ''} ${a.areaDesc ? '— ' + a.areaDesc : ''} (severity ${a.severity}, urgency ${a.urgency}). Pre-charge backup pool to 100% before onset.`,
      category: 'Weather',
    });
  }

  const ics = emit(events);
  calendarCache = { ts: Date.now(), ics };
  return ics;
}
