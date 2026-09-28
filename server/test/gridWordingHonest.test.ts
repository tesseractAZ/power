/**
 * v1.186.3 — user-facing grid wording says what is MEASURED.
 *
 * GridBackstop.backstopping means "the grid would take over at the reserve floor", not "the grid
 * is supplying the house now". The lighting-posture reason read "grid backstopping — depletion
 * projection is islanded-only" all afternoon while grid import was 0 W and solar plus the
 * batteries carried the house; the runway card, the Energy-flow card, the reserve alerts and the
 * spoken SoC advisory said the same kind of thing. Every such string now says the grid is
 * AVAILABLE AS BACKUP unless measured grid import (importLive) is flowing. Wording only: the
 * flag, the downgrades and the audible gates are unchanged (their own tests are untouched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { computeAlerts, gridBackupClause, resetOnScreenSocBandForTesting } from '../src/alerts.js';
import { runwayAlarmMessage, runwayAlarmMessageEs } from '../src/runwayAlarm.js';
import { socAlarmAdvisory, socAlarmAdvisoryEs } from '../src/batterySocAlarm.js';
import { RUNTIME_GRID_NOTE, forecastDayAlerts } from '../src/analytics.js';
import { rawPosture } from '../src/lightingPosture.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const now = Date.now();
function shp2(backupBatPercent: number, backupReserveSoc = 10): Record<string, DeviceSnapshot> {
  const d = {
    sn: 'SHP2XXX00XXX0001', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: now,
    projection: { kind: 'shp2', backupBatPercent, backupReserveSoc, sources: [], pairedCircuits: [] } as any,
  } as DeviceSnapshot;
  return { [d.sn]: d };
}
const byId = (alerts: Array<{ id: string; detail?: string }>, id: string) => alerts.find((a) => a.id === id)?.detail ?? '';

test('★★★ the reserve alerts: "drawing from grid power" only with measured import, else "available as backup"', () => {
  const idle = { present: true, backstopping: true, importLive: false, reason: 'SHP2 gridSta=Grid OK' };
  const flowing = { present: true, backstopping: true, importLive: true, reason: 'live home-grid 900 W (SHP2 main)' };
  const floorIdle = byId(computeAlerts(shp2(9, 10), undefined, idle), 'shp2-below-reserve');
  assert.match(floorIdle, /the grid is available as backup, no action needed/);
  assert.doesNotMatch(floorIdle, /drawing from grid power|backstopping/, '★ 0 W imported is not "drawing from grid power"');
  assert.match(byId(computeAlerts(shp2(9, 10), undefined, flowing), 'shp2-below-reserve'), /drawing from grid power, no action needed/);
  const near = byId(computeAlerts(shp2(14, 10), undefined, idle), 'shp2-near-reserve');
  assert.match(near, /the grid is available as backup, no action needed/);
  assert.doesNotMatch(near, /backstopping/);
  assert.equal(gridBackupClause(undefined), 'the grid is available as backup');
});

test('★★ the SoC band alert (house pool and a second panel): grid power is claimed only while it flows', () => {
  const idle = { present: true, backstopping: true, importLive: false, reason: 'SHP2 gridSta=Grid OK' };
  const flowing = { present: true, backstopping: true, importLive: true, reason: 'live home-grid 900 W (SHP2 main)' };
  // Offline: the reserve pair does not cover the band, so the band itself carries the downgrade.
  const panel = (sn: string, name: string, soc: number, extra: object = {}) => ({
    sn, deviceName: name, productName: 'Smart Home Panel 2', online: false, lastUpdated: now, ...extra,
    projection: { kind: 'shp2', backupBatPercent: soc, backupReserveSoc: 10, sources: [], pairedCircuits: [] },
  });
  const house = { HPANELXX: panel('HPANELXX', 'Smart Home Panel 2', 9) } as any;
  const band = (devices: any, grid: any, sfx = '') => {
    resetOnScreenSocBandForTesting();
    const a = computeAlerts(devices, undefined, grid, sfx ? () => grid : undefined)
      .find((x) => x.id.startsWith('backup-soc-') && (sfx ? x.id.endsWith(sfx) : !/-[A-Z]/.test(x.id)));
    assert.ok(a, `a band alert${sfx}`);
    assert.equal(a.severity, 'info', 'the grid downgrade is unchanged');
    return a.detail ?? '';
  };
  assert.match(band(house, idle), /the grid is available as backup, no action needed/);
  assert.doesNotMatch(band(house, idle), /drawing from grid power/, '★ 0 W imported is not "drawing from grid power"');
  assert.match(band(house, flowing), /drawing from grid power, no action needed/);
  const two = {
    HPANELXX: { ...panel('HPANELXX', 'House Panel', 60), online: true, housePanel: true },
    GPANELXX: panel('GPANELXX', 'Garage Panel', 9),
  } as any;
  assert.match(band(two, idle, '-GPANELXX'), /^Garage Panel backup reserve at 9%.* the grid is available as backup, no action needed/);
  assert.doesNotMatch(band(two, idle, '-GPANELXX'), /drawing from grid power/, '★ the second panel too');
  assert.match(band(two, flowing, '-GPANELXX'), /drawing from grid power, no action needed/);
});

test('★★★ the spoken advisories: at the floor and at a SoC band, grid power is claimed only while it flows', () => {
  const p = { hoursToReserve: 0, hoursToEmpty: 3, backupRemainingKwh: 5, backupReserveKwh: 9 } as any;
  const idle = runwayAlarmMessage(p, 'critical', { present: true, backstopping: true, importLive: false });
  assert.match(idle, /The grid is available as backup; no action needed\./);
  assert.doesNotMatch(idle, /drawing from grid power/);
  assert.match(runwayAlarmMessage(p, 'critical', { present: true, backstopping: true, importLive: true }), /Now drawing from grid power/);
  assert.match(runwayAlarmMessageEs(p, 'critical', { present: true, backstopping: true }), /La red está disponible como respaldo/);
  assert.equal(socAlarmAdvisory(40), 'Advisory. Backup pool at 40 percent — the grid is available as backup, no action needed.');
  assert.equal(socAlarmAdvisory(40, 'Garage Panel', true), 'Advisory. Garage Panel backup pool at 40 percent — drawing from grid power, no action needed.');
  assert.match(socAlarmAdvisoryEs(40, 'Garage Panel'), /de Garage Panel al 40 por ciento\. La red está disponible como respaldo/);
});

test('★★ the forecast notes and the lighting-posture reason say "available as backup"', () => {
  assert.doesNotMatch(RUNTIME_GRID_NOTE, /backstopping/);
  assert.match(RUNTIME_GRID_NOTE, /available as backup/);
  const df = { minProjectedSoc: 8, minProjectedSocTs: now + 3_600_000, reserveSoc: 10, hours: [], forecastPvWhNext24: 0, solarModel: { hourly: [] } } as any;
  const dipIdle = forecastDayAlerts(df, { backstopping: true, importLive: false, reason: 'SHP2 gridSta=Grid OK' }).find((a) => a.id === 'forecast-soc-dip');
  assert.ok(dipIdle, 'a sub-reserve projection raises the dip alert');
  assert.equal(dipIdle.severity, 'info', 'the downgrade is unchanged');
  assert.match(dipIdle.detail ?? '', /the grid is available as backup/);
  assert.doesNotMatch(dipIdle.detail ?? '', /backstopping|supplying the house/);
  const dipFlow = forecastDayAlerts(df, { backstopping: true, importLive: true, reason: 'live home-grid 900 W' }).find((a) => a.id === 'forecast-soc-dip');
  assert.match(dipFlow?.detail ?? '', /the grid is supplying the house now/);
  assert.match(rawPosture({ belowReserveFloor: false, hoursToReserve: 1, dawnMinSocPct: null, reservePct: 10, curtailmentActive: false, gridBackstopping: true, nowMs: now }).reason,
    /^grid available as backup/);
});

test('★ BRIDGE: HA\'s posture reason is fed the measured import, and no user-facing literal says the grid is "backstopping"', () => {
  const md = readFileSync(resolve(import.meta.dirname, '../src/mqttDiscovery.ts'), 'utf8');
  assert.ok(md.includes('gridImportLive: liveGridBackstop(snap.devices).importLive,'), 'mqttDiscovery passes importLive to the posture');
  // Every quoted literal on a non-comment line of server/src and web/src; "not backstopping"
  // (a resolver reason saying the grid will NOT take over) is honest and allowed.
  const roots = [resolve(import.meta.dirname, '../src'), resolve(import.meta.dirname, '../../web/src')];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) files.push(p);
    }
  };
  for (const r of roots) walk(r);
  const offenders: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
      for (const m of line.matchAll(/(['"`])((?:(?!\1).)*?)\1/g)) {
        const lit = m[2].replace(/not backstopping/g, '');
        if (/backstopp|BACKSTOP'|GRID BACKSTOP|carrying the load/.test(lit)) offenders.push(`${f}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
