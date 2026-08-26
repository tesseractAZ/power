/**
 * haStatistics.ts — v1.89.0. The vendor ledger, given back to Home Assistant
 * as gap-free long-term statistics (register item B1).
 *
 * WHY: the local sensors' HA statistics carry every hole the add-on's own
 * accumulators do — the 89.4 h July recorder blackout, every deploy, the host
 * reboots. The vendor ledger (energyHistory.ts) has none of those holes: it is
 * the SHP2's own daily record, now stored back to late June. This module
 * publishes that ledger as EXTERNAL statistics (`ecoflow_panel:*`) via the
 * documented `recorder/import_statistics` WebSocket API, so the operator can
 * select gap-free series in the HA Energy dashboard.
 *
 * DESIGN
 *  - EXTERNAL statistic ids only (`ecoflow_panel:vendor_*`). This NEVER
 *    touches the `sensor.*` statistics HA owns — healing is by SUBSTITUTION
 *    (pick the vendor series in the dashboard), not by mutating HA's data.
 *  - Idempotent by construction: `import_statistics` upserts rows keyed on
 *    (statistic_id, start), and every export re-sends the FULL series with
 *    cumulative sums recomputed from the stored ledger — a backfilled older
 *    day simply shifts the sums and the re-import corrects every later row.
 *  - Daily granularity, honestly: HA statistics are hourly; a vendor day is
 *    one number. Each day becomes ONE hourly row at 12:00 Phoenix carrying
 *    the whole day's energy. Daily/monthly dashboard totals are exact; the
 *    intra-day curve is deliberately not faked.
 *  - Pure payload builder, exported for tests; the WS call is a thin shell.
 */

import WebSocket from 'ws';
import type { VendorDayRecord } from './energyHistory.js';

export const HA_STATS_SOURCE = 'ecoflow_panel';

export interface VendorStatSeries {
  id: string;    // ecoflow_panel:vendor_home_energy
  name: string;
  field: (d: VendorDayRecord) => number | null;
}

export const VENDOR_STAT_SERIES: ReadonlyArray<VendorStatSeries> = [
  { id: `${HA_STATS_SOURCE}:vendor_home_energy`, name: 'Home load (EcoFlow ledger)', field: (d) => d.homeWh },
  { id: `${HA_STATS_SOURCE}:vendor_solar_energy`, name: 'Solar production (EcoFlow ledger)', field: (d) => d.solarWh },
  { id: `${HA_STATS_SOURCE}:vendor_grid_energy`, name: 'Grid import (EcoFlow ledger)', field: (d) => d.gridWh },
  { id: `${HA_STATS_SOURCE}:vendor_battery_in_energy`, name: 'Battery grid-charge (EcoFlow ledger)', field: (d) => d.batteryInWh },
  { id: `${HA_STATS_SOURCE}:vendor_battery_out_energy`, name: 'Battery discharge (EcoFlow ledger)', field: (d) => d.batteryOutWh },
];

/** Noon Phoenix (UTC-7, no DST) for a YYYY-MM-DD, as the ISO `start` HA wants. */
export function noonPhoenixIso(ymd: string): string {
  return `${ymd}T19:00:00+00:00`; // 12:00 MST == 19:00 UTC, year-round
}

export interface ImportStatisticsMessage {
  type: 'recorder/import_statistics';
  metadata: {
    has_mean: false;
    /** v1.109.0 — the ACTUAL HA 2026.11 deprecation (yesterday's unit_class fix
     *  addressed a different, truncated-in-the-log warning): mean_type replaces
     *  has_mean; 0 = StatisticMeanType.NONE (sum-only series). */
    mean_type: 0;
    has_sum: true;
    name: string;
    source: string;
    statistic_id: string;
    unit_of_measurement: 'Wh';
    /** v1.108.0 — HA 2026.x warns when import_statistics omits the unit class. */
    unit_class: 'energy';
  };
  stats: Array<{ start: string; state: number; sum: number }>;
}

/**
 * One series' full import message: rows in day order, `sum` cumulative, days
 * whose field is null SKIPPED (never zero-filled — an unfetched day must not
 * flatten the sum; the backfill retry will fill it and the next export shifts
 * the sums into place).
 */
export function buildImportMessage(
  series: VendorStatSeries,
  days: ReadonlyArray<VendorDayRecord>,
): ImportStatisticsMessage | null {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
  let sum = 0;
  const stats: ImportStatisticsMessage['stats'] = [];
  for (const d of sorted) {
    const wh = series.field(d);
    if (wh == null || !Number.isFinite(wh) || wh < 0) continue;
    sum += wh;
    stats.push({ start: noonPhoenixIso(d.day), state: wh, sum });
  }
  if (stats.length === 0) return null;
  return {
    type: 'recorder/import_statistics',
    metadata: {
      has_mean: false, mean_type: 0, has_sum: true,
      name: series.name, source: HA_STATS_SOURCE,
      statistic_id: series.id, unit_of_measurement: 'Wh', unit_class: 'energy',
    },
    stats,
  };
}

/**
 * Push every vendor series to HA over the supervisor's Core WebSocket proxy.
 * Returns per-series outcomes; any WS/auth failure fails ALL series (the
 * caller logs and retries on the next daily run — never alarm-path coupled).
 */
export async function exportVendorStatistics(
  days: ReadonlyArray<VendorDayRecord>,
  log: (m: string) => void,
): Promise<{ exported: string[]; failed: string[] }> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return { exported: [], failed: VENDOR_STAT_SERIES.map((s) => s.id) };
  const messages = VENDOR_STAT_SERIES
    .map((s) => ({ id: s.id, msg: buildImportMessage(s, days) }))
    .filter((x): x is { id: string; msg: ImportStatisticsMessage } => x.msg != null);
  if (messages.length === 0) return { exported: [], failed: [] };

  return await new Promise((resolvePromise) => {
    const exported: string[] = [];
    const failed: string[] = [];
    const ws = new WebSocket('ws://supervisor/core/websocket');
    let msgId = 0;
    let sent = 0;
    const finish = () => {
      try { ws.close(); } catch { /* already closed */ }
      resolvePromise({ exported, failed });
    };
    const timer = setTimeout(() => {
      log('ha-stats: export timed out after 30s — will retry on the next daily run');
      for (const m of messages.slice(sent)) failed.push(m.id);
      finish();
    }, 30_000);
    (timer as { unref?: () => void }).unref?.();
    ws.on('error', (e) => {
      log(`ha-stats: websocket error (${(e as Error).message}) — will retry on the next daily run`);
      clearTimeout(timer);
      for (const m of messages) if (!exported.includes(m.id)) failed.push(m.id);
      finish();
    });
    ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_ok') {
        for (const item of messages) {
          msgId += 1;
          ws.send(JSON.stringify({ id: msgId, ...item.msg }));
          sent += 1;
        }
      } else if (m.type === 'auth_invalid') {
        log('ha-stats: supervisor token rejected — will retry on the next daily run');
        clearTimeout(timer);
        for (const item of messages) failed.push(item.id);
        finish();
      } else if (m.type === 'result') {
        const item = messages[m.id - 1];
        if (!item) return;
        if (m.success) exported.push(item.id);
        else {
          failed.push(item.id);
          log(`ha-stats: import failed for ${item.id}: ${JSON.stringify(m.error ?? {}).slice(0, 160)}`);
        }
        if (exported.length + failed.length === messages.length) {
          clearTimeout(timer);
          finish();
        }
      }
    });
  });
}
