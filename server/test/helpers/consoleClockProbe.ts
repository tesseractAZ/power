/**
 * consoleClockProbe.ts — every clock the Plant console prints, as the screens draw them: the
 * liveness clocks of the ALARM and BUS screens (v1.191.1), the alarm rows' onset stamps, and the
 * CONSOLE screen's alarm banner and status header (v1.191.0). Imported by
 * test/consoleSiteClock.test.ts, and run by it in a child process whose environment sets TZ and
 * SITE_TIMEZONE (the site zone is resolved once, when siteTime.ts loads); run that way it prints
 * one JSON object.
 *
 *   node --import tsx test/helpers/consoleClockProbe.ts
 *
 * Fake panel serial and alarm id only. The one listed alarm has no recorded onset, so its row
 * carries the snapshot's time; the alarm-onset sidecar is only read (the child runs point
 * ALERT_ONSET_PATH at a file that does not exist). The status header stamps Date.now(), which
 * is pinned to the probe instant while the CONSOLE screen renders.
 */
import { pathToFileURL } from 'node:url';
import { renderAlm } from '../../src/console/plant/alm.js';
import { renderBus } from '../../src/console/plant/bus.js';
import { renderConsole } from '../../src/console/plant/console.js';
import { fmtSiteHms, fmtSiteStamp, siteTimeZone } from '../../src/siteTime.js';
import type { PlantData, PlantView } from '../../src/console/plant/types.js';

/** 2026-10-22 18:30:15 UTC: 11:30:15 in Phoenix, 14:30:15 in New York, 07:30:15 the next day in Auckland. */
export const PROBE_AT_MS = Date.UTC(2026, 9, 22, 18, 30, 15);

/** The fake alarm the ALARM screen lists and the CONSOLE banner headlines. */
export const PROBE_ALARM_ID = 'probe-site-clock-0001';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

const VIEW: PlantView = { width: 120, height: 40, screen: 'alm', genSel: 0, genPack: 0, almScroll: 0, connectedAt: PROBE_AT_MS };

function plantData(atMs: number): PlantData {
  const panel = {
    sn: 'SHP2-TEST-0001', deviceName: 'Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: atMs,
    projection: {
      kind: 'shp2', area: 'Home', backupBatPercent: 80, backupReserveSoc: 10, chargeWattPower: 0, gridWatt: 0,
      circuits: [], pairedCircuits: [], sources: [], sourceWatts: [],
    },
  };
  const alarm = { id: PROBE_ALARM_ID, severity: 'critical', category: 'Grid', device: panel.sn, title: 'Probe alarm', detail: 'site clock probe' };
  return {
    snap: { generatedAt: atMs, devices: { [panel.sn]: panel }, alerts: [alarm] },
    totals: null,
    forecast: null,
    degradation: { generatedAt: 0, eolSoh: 80, packs: [] },
    serverStartedAt: atMs - 60_000,
    flow: { fleetPv: null, fleetBatteryNet: null },
  } as unknown as PlantData;
}

/** The HH:MM:SS a divider line carries after a "·" (null when the line or the clock is missing). */
function clockOf(lines: string[], head: string): string | null {
  const line = lines.map(stripAnsi).find((l) => l.includes(head));
  const all = line ? [...line.matchAll(/·\s+(\d{2}:\d{2}:\d{2})/g)] : [];
  return all.length > 0 ? all[all.length - 1][1] : null;
}

/** The first match of `re` (its first group) on the first line holding `head` (null when either is missing). */
function fieldOf(lines: string[], head: string, re: RegExp): string | null {
  const line = lines.map(stripAnsi).find((l) => l.includes(head));
  const m = line ? line.match(re) : null;
  return m ? m[1] : null;
}

export interface ConsoleClocks {
  zone: string;
  hostZone: string;
  /** The site clock at the instant: HH:MM:SS (fmtSiteHms), the dividers' and the banner's form. */
  siteHms: string;
  /** … YYYY-MM-DD HH:MM (fmtSiteStamp), the status header's form. */
  siteStamp: string;
  /** … YYYY-MM-DD HH:MM:SS (fmtSiteStamp with seconds), the alarm rows' form. */
  siteStampS: string;
  /** The ALARM LIST divider's clock. */
  alm: string | null;
  /** The MAIN BUS divider's clock. */
  bus: string | null;
  /** The ALARM screen's row for the probe alarm: its TIMESTAMP column. */
  almRow: string | null;
  /** The CONSOLE screen's alarm banner: the headline alarm's time. */
  banner: string | null;
  /** The CONSOLE screen's status header: its date and time. */
  header: string | null;
}

export function consoleClocks(atMs: number = PROBE_AT_MS): ConsoleClocks {
  const data = plantData(atMs);
  const alm = renderAlm({ ...VIEW, screen: 'alm' }, data);
  // The status header stamps the render time (Date.now()); pin it to the probe instant.
  const realNow = Date.now;
  let scada: string[];
  try {
    Date.now = () => atMs;
    scada = renderConsole({ ...VIEW, screen: 'console' }, data);
  } finally {
    Date.now = realNow;
  }
  return {
    zone: siteTimeZone(),
    hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    siteHms: fmtSiteHms(atMs),
    siteStamp: fmtSiteStamp(atMs),
    siteStampS: fmtSiteStamp(atMs, true),
    alm: clockOf(alm, 'ALARM LIST'),
    bus: clockOf(renderBus({ ...VIEW, screen: 'bus' }, data), 'MAIN BUS'),
    almRow: fieldOf(alm, PROBE_ALARM_ID, /^\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s/),
    banner: fieldOf(scada, 'Probe alarm', /▌▌\s+ALM\s+(\d{2}:\d{2}:\d{2})\s/),
    header: fieldOf(scada, 'MODE ', /│\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s/),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(consoleClocks()));
}
