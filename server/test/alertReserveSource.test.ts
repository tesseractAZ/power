import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import { priorityOf } from '../src/alertPriority.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v0.44.0 — Source-overload refactor + reserve dedup.
 *
 * (1) The measured backup-pool reserve-band alerts (`backup-soc-NN`) are REAL
 *     threshold crossings: they must tag source='threshold' (so they show on the
 *     operational Alerts page, not the Predictive/learned page, and read
 *     correctly in cleared history) while STILL reaching ISA Medium — now via an
 *     explicit `priority` field rather than faking source='learned'.
 * (2) Dedup: the grid-aware shp2-near-reserve / shp2-below-reserve pair owns the
 *     soc < reserve+10 window, so the backup-soc band push is suppressed inside
 *     it (shp2-near-reserve covers the case) — one on-screen producer for the
 *     reserve story, with no condition silently dropped.
 */

const now = Date.now();

function shp2(backupBatPercent: number | null, backupReserveSoc = 10): DeviceSnapshot {
  return {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: now,
    projection: { kind: 'shp2', backupBatPercent, backupReserveSoc, sources: [], pairedCircuits: [] } as any,
  } as DeviceSnapshot;
}
// Same SHP2 but cloud-OFFLINE: the snapshot store still preserves `projection`
// (hence backupBatPercent), but the shp2-near/below pair is gated on `online`.
function shp2Offline(backupBatPercent: number | null, backupReserveSoc = 10): DeviceSnapshot {
  return { ...shp2(backupBatPercent, backupReserveSoc), online: false } as DeviceSnapshot;
}
const devices = (...arr: DeviceSnapshot[]): Record<string, DeviceSnapshot> =>
  Object.fromEntries(arr.map((d) => [d.sn, d]));

const backupSoc = (a: Alert[]) => a.find((x) => x.id.startsWith('backup-soc-'));
const nearReserve = (a: Alert[]) => a.find((x) => x.id === 'shp2-near-reserve');
const belowReserve = (a: Alert[]) => a.find((x) => x.id === 'shp2-below-reserve');

/* ─── (1) reserve-band crossing is source='threshold' + priority='medium' ─── */

test("backup-soc band is source='threshold' (NOT 'learned') with explicit priority='medium'", () => {
  // reserve=5 ⇒ suppression window is soc<15. soc=20 sits in the 15..20 band
  // (ISA Medium) and ABOVE the window, so the band push survives. Grid omitted
  // ⇒ no emergency downgrade, so the band's own priority (medium) is preserved.
  const alerts = computeAlerts(devices(shp2(20, 5)));
  const a = backupSoc(alerts);
  assert.ok(a, 'backup-soc band present at 20% (reserve 5%)');
  assert.equal(a!.id, 'backup-soc-20', 'lands in the 20% (medium) band');
  assert.equal(a!.source, 'threshold', "REAL measured crossing ⇒ source='threshold', never 'learned'");
  assert.equal(a!.priority, 'medium', 'explicit ISA tier carried on the alert');
  // The explicit field drives the displayed ISA priority → Medium (P3)…
  assert.equal(priorityOf(a!), 'medium');
  // …and it does NOT route onto the Predictive page (that page is source==='learned').
  assert.notEqual(a!.source, 'learned');
});

/* ─── (2) dedup: band suppressed inside the shp2-near/below window ─── */

test('backup-soc band SUPPRESSED when soc<reserve+10, shp2-near-reserve covers it', () => {
  // soc=14, reserve=10 ⇒ inside the reserve+10 (=20) window. The band push must
  // be suppressed; shp2-near-reserve is the sole on-screen producer here.
  const alerts = computeAlerts(devices(shp2(14, 10)));
  assert.equal(backupSoc(alerts), undefined, 'backup-soc band suppressed inside the reserve window');
  assert.ok(nearReserve(alerts), 'shp2-near-reserve covers the suppressed window');
});

test('backup-soc band SUPPRESSED below reserve, shp2-below-reserve covers it', () => {
  // soc=8, reserve=10 ⇒ below reserve. Band suppressed; shp2-below-reserve owns it.
  const alerts = computeAlerts(devices(shp2(8, 10)));
  assert.equal(backupSoc(alerts), undefined, 'backup-soc band suppressed below reserve');
  assert.ok(belowReserve(alerts), 'shp2-below-reserve covers the below-reserve window');
});

test('backup-soc band EMITTED just above the reserve window (no condition dropped)', () => {
  // reserve=10 ⇒ window soc<20. soc=20 is the first value ABOVE the window, in
  // the 20% medium band → band push survives and the shp2 pair does not fire.
  const alerts = computeAlerts(devices(shp2(20, 10)));
  const a = backupSoc(alerts);
  assert.ok(a, 'band present at the top of the window boundary (soc=20, reserve=10)');
  assert.equal(a!.id, 'backup-soc-20');
  assert.equal(priorityOf(a!), 'medium');
  assert.equal(nearReserve(alerts), undefined, 'shp2-near-reserve not firing at soc=20 (>= reserve+10)');
});

/* ─── (3) offline SHP2: band is the FALLBACK (regression — Copilot #88) ─── */

test('backup-soc band EMITTED when SHP2 is OFFLINE inside the reserve window (pair cannot fire)', () => {
  // soc=14, reserve=10 ⇒ inside the reserve+10 window, but the SHP2 is cloud-
  // offline so shp2-near/below-reserve (gated on `online`) do NOT emit. If the
  // band were still suppressed here, a low-SoC condition would have NO on-screen
  // alert at all. The dedup must release when the pair is ineligible.
  const alerts = computeAlerts(devices(shp2Offline(14, 10)));
  assert.equal(nearReserve(alerts), undefined, 'offline SHP2 ⇒ shp2-near-reserve cannot fire');
  assert.equal(belowReserve(alerts), undefined, 'offline SHP2 ⇒ shp2-below-reserve cannot fire');
  const a = backupSoc(alerts);
  assert.ok(a, 'band must remain as the fallback low-SoC alert when SHP2 is offline');
  assert.equal(a!.source, 'threshold');
});

test('backup-soc band EMITTED when SHP2 is OFFLINE below reserve (pair cannot fire)', () => {
  const alerts = computeAlerts(devices(shp2Offline(8, 10)));
  assert.equal(belowReserve(alerts), undefined, 'offline SHP2 ⇒ no shp2-below-reserve');
  assert.ok(backupSoc(alerts), 'band is the sole low-SoC producer when SHP2 offline');
});
