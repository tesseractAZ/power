/**
 * consoleClockProbe.ts — the liveness clocks of the Plant console's ALARM and BUS screens, as the
 * screens draw them (v1.191.1). Imported by test/consoleSiteClock.test.ts, and run by it in a child
 * process whose environment sets TZ and SITE_TIMEZONE (the site zone is resolved once, when
 * siteTime.ts loads); run that way it prints one JSON object.
 *
 *   node --import tsx test/helpers/consoleClockProbe.ts
 *
 * Fake panel serial only; no alarm is listed, so the alarm-onset sidecar is never read.
 */
import { pathToFileURL } from 'node:url';
import { renderAlm } from '../../src/telnet/plant/alm.js';
import { renderBus } from '../../src/telnet/plant/bus.js';
import { fmtSiteHms, siteTimeZone } from '../../src/siteTime.js';
import type { PlantData, PlantView } from '../../src/telnet/plant/types.js';

/** 2026-10-22 18:30:15 UTC: 11:30:15 in Phoenix, 14:30:15 in New York, 07:30:15 the next day in Auckland. */
export const PROBE_AT_MS = Date.UTC(2026, 9, 22, 18, 30, 15);

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
  return {
    snap: { generatedAt: atMs, devices: { [panel.sn]: panel }, alerts: [] },
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

export interface ConsoleClocks {
  zone: string;
  hostZone: string;
  /** The site clock at the instant (fmtSiteHms), the console's other stamps' clock. */
  siteHms: string;
  /** The ALARM LIST divider's clock. */
  alm: string | null;
  /** The MAIN BUS divider's clock. */
  bus: string | null;
}

export function consoleClocks(atMs: number = PROBE_AT_MS): ConsoleClocks {
  const data = plantData(atMs);
  return {
    zone: siteTimeZone(),
    hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    siteHms: fmtSiteHms(atMs),
    alm: clockOf(renderAlm({ ...VIEW, screen: 'alm' }, data), 'ALARM LIST'),
    bus: clockOf(renderBus({ ...VIEW, screen: 'bus' }, data), 'MAIN BUS'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(consoleClocks()));
}
