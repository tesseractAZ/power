/**
 * v1.187.22 — the reserve-alarm-blind push names the fallback SoC the ladder actually runs on.
 *
 * The SoC ladder reads housePoolFallbackSoc(devices, lastKnownRoster) (socLadders.ts); the alert
 * read housePoolFallbackSoc(devices) with no roster. isHomePoolDpu uses a remembered roster only
 * when one is passed, so while the panel's sources[] had lost isConnected (a zeroed or partial
 * backupIncreInfo during a cloud wedge) the alert fell back to the stale SPARE_DPU_SNS literal —
 * which names the wired Core 5 as a spare and does not name the bench Core 3 — while the ladder
 * used the remembered roster. With Cores 1/2/5 at 30/32/28 % and the bench Core 3 at 95 %, the
 * off-grid critical push said "mean 52%" while the ladder ran on 30 %.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import {
  SPARE_DPU_SNS, housePoolFallbackSoc, lastKnownHomeRoster, setLastKnownHomeRoster, resetLastKnownHomeRoster,
} from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const now = Date.now();
const MIN = 60_000;

const CORE1 = 'Y711XXX00XXX0015';
const CORE2 = 'Y711XXX00XXX0002';
const CORE3 = 'Y711XXX00X000014'; // the bench unit, not in the literal
const [, CORE5] = [...SPARE_DPU_SNS] as [string, string]; // wired into slot 3; the literal calls it a spare
const ROSTER = new Set([CORE1, CORE2, CORE5]);

function dpu(sn: string, soc: number, online = true): DeviceSnapshot {
  return {
    sn, deviceName: `Core ${sn.slice(-2)}`, productName: 'Delta Pro Ultra', online, lastUpdated: now,
    projection: { kind: 'dpu', soc, packs: [] } as any,
  } as DeviceSnapshot;
}

/** A panel projection whose pool reads null and whose three sources all lost isConnected. */
function blindPanel(): DeviceSnapshot {
  return {
    sn: 'HD31XXXXXX000019', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
    online: true, lastUpdated: now,
    projection: {
      kind: 'shp2', backupBatPercent: null, backupReserveSoc: 15, pairedCircuits: [],
      sources: [1, 2, 3].map((slot) => ({ slot, isConnected: false })),
    } as any,
  } as DeviceSnapshot;
}

const devices = (...arr: DeviceSnapshot[]): Record<string, DeviceSnapshot> => Object.fromEntries(arr.map((d) => [d.sn, d]));
const conn = (since: number) => ({ lastDeviceListAttemptAt: now, lastDeviceListSuccessAt: now, perDevice: new Map(), backupPoolUnknownSinceMs: since });
const blind = (a: Alert[]) => a.find((x) => x.id === 'reserve-alarm-blind');

beforeEach(() => resetLastKnownHomeRoster());
afterEach(() => resetLastKnownHomeRoster());

test('precondition: the literal names Core 5 (wired) and not Core 3 (bench)', () => {
  assert.ok(SPARE_DPU_SNS.has(CORE5));
  assert.ok(!SPARE_DPU_SNS.has(CORE3));
});

test('lastKnownHomeRoster() returns the published roster, null until one is known', () => {
  assert.equal(lastKnownHomeRoster(), null);
  setLastKnownHomeRoster(ROSTER);
  assert.deepEqual([...(lastKnownHomeRoster() ?? [])].sort(), [...ROSTER].sort());
  setLastKnownHomeRoster(new Set());
  assert.equal(lastKnownHomeRoster(), null, 'an empty roster is not a known one');
});

test('★★★ connected sources empty, bench Core online: the pushed figure is the ladder\'s, not the literal\'s', () => {
  setLastKnownHomeRoster(ROSTER); // index.ts publishes the roster it hands the ladder
  const d = devices(blindPanel(), dpu(CORE1, 30), dpu(CORE2, 32), dpu(CORE5, 28), dpu(CORE3, 95));
  const ladder = housePoolFallbackSoc(d, ROSTER); // what socLadders.ts feeds the house ladder
  assert.equal(ladder, 30);
  const a = blind(computeAlerts(d, conn(now - 61 * MIN), { backstopping: false } as any));
  assert.ok(a, 'reserve-alarm-blind fires');
  assert.equal(a!.severity, 'critical', 'off-grid and blind past an hour');
  assert.match(a!.detail, /Core-fleet fallback \(mean 30% across reporting Cores\)/, a!.detail);
  assert.ok(!/mean 52%/.test(a!.detail), 'not the literal\'s mean (bench Core 3 in, wired Core 5 out)');
  assert.equal(a!.facts?.find((f) => f.label === 'Fallback ladder')?.value, '30% (Core-fleet mean)');
});

test('★★ only the wired Core the literal calls a spare is reporting: the push names its SoC, not "fully dark"', () => {
  setLastKnownHomeRoster(ROSTER);
  const d = devices(blindPanel(), dpu(CORE1, 30, false), dpu(CORE2, 32, false), dpu(CORE5, 28), dpu(CORE3, 95, false));
  assert.equal(housePoolFallbackSoc(d, ROSTER), 28, 'the ladder runs on Core 5');
  const a = blind(computeAlerts(d, conn(now - 20 * MIN)));
  assert.ok(a);
  assert.match(a!.detail, /mean 28% across reporting Cores/, a!.detail);
  assert.ok(!/fully dark/.test(a!.detail));
});

test('no roster known yet: the alert and the ladder both fall back to the literal (unchanged)', () => {
  const d = devices(blindPanel(), dpu(CORE1, 30), dpu(CORE2, 32), dpu(CORE5, 28), dpu(CORE3, 95));
  const ladder = housePoolFallbackSoc(d, new Set()); // index.ts's roster before any is learned
  const a = blind(computeAlerts(d, conn(now - 20 * MIN)));
  assert.ok(a);
  assert.match(a!.detail, new RegExp(`mean ${ladder!.toFixed(0)}% across`));
});
